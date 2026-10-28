"""Query free public routing engines for the test trips and score every route on the same yardstick:
share of distance on the City's bike infrastructure (matched to our graph tiers).

Writes data/build/bench_engines.json and prototypes/shared/data/engine_routes.js
"""
import json
import math
import time
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
from pyproj import Transformer
from shapely.geometry import LineString, Point
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "data" / "build"
TO_M = Transformer.from_crs("EPSG:4326", "EPSG:32188", always_xy=True)
UA = {"User-Agent": "bikeapp-prototype/0.1 (personal research, low volume)"}


def get_json(url, timeout=60, tries=3):
    last = None
    for attempt in range(tries):
        try:
            t = time.time()
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
                data = json.loads(r.read())
            return data, (time.time() - t) * 1000
        except Exception as ex:  # noqa: BLE001 - network hiccups: wait and retry
            last = ex
            time.sleep(5 * (attempt + 1))
    raise last


def decode_polyline(s, precision=6):
    coords, idx, lat, lon, f = [], 0, 0, 0, 10 ** precision
    while idx < len(s):
        for which in (0, 1):
            shift = result = 0
            while True:
                b = ord(s[idx]) - 63; idx += 1
                result |= (b & 0x1F) << shift; shift += 5
                if b < 0x20:
                    break
            d = ~(result >> 1) if result & 1 else result >> 1
            if which == 0:
                lat += d
            else:
                lon += d
        coords.append([lon / f, lat / f])
    return coords


def osrm(a, b):
    u = (f"https://routing.openstreetmap.de/routed-bike/route/v1/driving/{a[0]},{a[1]};{b[0]},{b[1]}"
         "?overview=full&geometries=geojson")
    d, ms = get_json(u)
    return d["routes"][0]["geometry"]["coordinates"], d["routes"][0]["distance"], ms


def valhalla(a, b, use_roads):
    q = {"locations": [{"lon": a[0], "lat": a[1]}, {"lon": b[0], "lat": b[1]}], "costing": "bicycle",
         "costing_options": {"bicycle": {"bicycle_type": "Hybrid", "use_roads": use_roads, "use_hills": 0.5}},
         "directions_options": {"units": "kilometers"}}
    u = "https://valhalla1.openstreetmap.de/route?json=" + urllib.parse.quote(json.dumps(q))
    d, ms = get_json(u)
    leg = d["trip"]["legs"][0]
    return decode_polyline(leg["shape"]), d["trip"]["summary"]["length"] * 1000, ms


def brouter(a, b, profile):
    u = f"https://brouter.de/brouter?lonlats={a[0]},{a[1]}|{b[0]},{b[1]}&profile={profile}&alternativeidx=0&format=geojson"
    d, ms = get_json(u)
    f = d["features"][0]
    return [c[:2] for c in f["geometry"]["coordinates"]], float(f["properties"]["track-length"]), ms


ENGINES = {
    "OSRM bike (OSM)": lambda a, b: osrm(a, b),
    "Valhalla bicycle, use_roads 0.5": lambda a, b: valhalla(a, b, 0.5),
    "Valhalla bicycle, use_roads 0.0": lambda a, b: valhalla(a, b, 0.0),
    "BRouter trekking": lambda a, b: brouter(a, b, "trekking"),
    "BRouter safety": lambda a, b: brouter(a, b, "safety"),
}


def main():
    g = json.loads((BUILD / "graph_study.json").read_text(encoding="utf-8"))
    nodes = g["nodes"]
    lines, tiers = [], []
    for e in range(len(g["a"])):
        a, b = g["a"][e], g["b"][e]
        pts = [(nodes[2 * a] / 1e6, nodes[2 * a + 1] / 1e6)]
        x, y = nodes[2 * a], nodes[2 * a + 1]
        gm = g["geom"][e]
        for i in range(0, len(gm), 2):
            x += gm[i]; y += gm[i + 1]; pts.append((x / 1e6, y / 1e6))
        pts.append((nodes[2 * b] / 1e6, nodes[2 * b + 1] / 1e6))
        xs, ys = TO_M.transform([p[0] for p in pts], [p[1] for p in pts])
        lines.append(LineString(list(zip(xs, ys)))); tiers.append(g["tier"][e])
    tree = STRtree(lines)

    def score(coords):
        xs, ys = TO_M.transform([c[0] for c in coords], [c[1] for c in coords])
        line = LineString(list(zip(xs, ys)))
        L = line.length
        n = max(2, int(L // 10))
        by = [0.0] * 7  # tiers 0..5 + 6 unmatched
        step = L / n
        for i in range(n):
            p = line.interpolate((i + 0.5) * step)
            q = line.interpolate(min(L, (i + 0.5) * step + 3))
            hd = math.atan2(q.y - p.y, q.x - p.x)
            best = None
            for ci in tree.query(p.buffer(14)):
                d = lines[ci].distance(p)
                if d > 14:
                    continue
                s = lines[ci].project(p)
                a1 = lines[ci].interpolate(max(0, s - 3)); a2 = lines[ci].interpolate(min(lines[ci].length, s + 3))
                he = math.atan2(a2.y - a1.y, a2.x - a1.x)
                diff = abs((hd - he + math.pi) % (2 * math.pi) - math.pi)
                diff = min(diff, math.pi - diff)
                if diff > math.radians(35):
                    continue
                # prefer the closest, and the better tier when two are within 4 m (parallel path vs street)
                key = (round(d / 4), tiers[ci])
                if best is None or key < best[0]:
                    best = (key, ci)
            by[tiers[best[1]] if best else 6] += step
        return L, by

    trips = json.loads((ROOT / "prototypes" / "shared" / "trips.json").read_text(encoding="utf-8"))
    ours = json.loads((BUILD / "bench_ours.json").read_text(encoding="utf-8"))
    out, routes_js = [], {}
    for trip in trips:
        a, b = trip["from"]["lonlat"], trip["to"]["lonlat"]
        print(f"\n=== {trip['name']}")
        rows = []
        for r in ours:
            if r["trip"] == trip["id"]:
                L, by = score(r["coords"])
                rows.append(("Ours: " + r["profile"], r["length_m"], by, r["ms"], r["coords"]))
        for name, fn in ENGINES.items():
            try:
                coords, dist, ms = fn(a, b)
                L, by = score(coords)
                rows.append((name, dist, by, ms, coords))
            except Exception as ex:  # noqa: BLE001
                print(f"  {name}: failed ({ex})")
            time.sleep(1.2)
        for name, dist, by, ms, coords in rows:
            tot = sum(by) or 1
            infra = (by[0] + by[1] + by[2]) / tot
            gap = (by[3] + by[4]) / tot
            print(f"  {name:<34} {dist / 1000:5.2f} km | bike infra {infra:4.0%} | no-infra {gap:4.0%} "
                  f"(busy {by[4] / tot:4.0%}) | unmatched {by[6] / tot:4.0%} | {ms:7.1f} ms")
            out.append({"trip": trip["id"], "engine": name, "km": round(dist / 1000, 3), "infra": round(infra, 3),
                        "gap": round(gap, 3), "busy": round(by[4] / tot, 3), "unmatched": round(by[6] / tot, 3),
                        "ms": round(ms, 2)})
            routes_js.setdefault(trip["id"], {})[name] = [[round(x, 6), round(y, 6)] for x, y in coords]
    (BUILD / "bench_engines.json").write_text(json.dumps(out, indent=1), encoding="utf-8")
    (ROOT / "prototypes" / "shared" / "data" / "engine_routes.js").write_text(
        "window.ENGINE_ROUTES=" + json.dumps(routes_js, separators=(",", ":")) + ";\n", encoding="utf-8")
    print("\nwrote bench_engines.json and engine_routes.js")


if __name__ == "__main__":
    main()
