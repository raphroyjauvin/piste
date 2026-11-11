"""Named places for the search bars (2026-11-10): universities, parks, stations, cafés, shops ... from OpenStreetMap.

    prototypes/shared/data/places.js   window.PLACES = columnar, delta-encoded, about 1 MB; loaded on the first use of a search bar (never at start-up)

Source: BBBike's Montreal extract (data/raw/osm_bbbike/Montreal.osm.pbf, OpenStreetMap contributors, ODbL), already logged in
data/raw/_download_log.csv by tools/island_buildings.py fetch_pbf. Nothing is downloaded here, so nothing new is logged.
The area is the routing graph's own box (read from graph_island.js). GDAL's OSM driver (QGIS's bundled one) cuts the points and areas
into data/build/places/ (kept between runs; delete the two .geojsonl files to cut them again).

Usage: C:\\bikeapp\\.venv\\Scripts\\python.exe -I C:\\bikeapp\\tools\\build_places.py

File layout (every array has one slot per place, sorted west to east):
    kinds   [name]             kind names; a place's kind is  k[i] >> 2  (index into kinds)
    k       [kind * 4 + rank]  rank 0..3: 3 = universities, hospitals, stations, museums, big parks, attractions ... 0 = an ordinary shop
    n       [name]             the name as OSM has it
    dx, dy  [int]              lon, lat in 1e-5 degrees: dx is the step from the previous place (the first from x0), dy is from y0 (the box's south edge)
    s       [street index]     into streets[] (0 = none): addr:street, else the nearest named street of the routing graph (not for big areas)
    alt     {i: [fr, en, short?]}  name:fr / name:en when they differ from the name, and the short name (an extra way to find it)
"""
import collections
import gzip
import json
import math
import os
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))      # python -I does not put the script folder on sys.path

import numpy as np
from pyproj import Transformer
from shapely.geometry import Polygon, shape

import build_layers as bl
import fetch_data as fd

RAW, BUILD, OUT = bl.RAW, bl.BUILD / "places", bl.OUT
PBF = RAW / "osm_bbbike" / "Montreal.osm.pbf"
GRAPH = OUT / "graph_island.js"
ISLAND = fd.ISLAND_BBOX
TO_M = Transformer.from_crs("EPSG:4326", "EPSG:32188", always_xy=True)
HSTORE = re.compile(r'"((?:[^"\\]|\\.)*)"=>"((?:[^"\\]|\\.)*)"')

KINDS = ["uni", "school", "hospital", "library", "museum", "theatre", "cinema", "stadium", "market", "park", "station",
         "cafe", "restaurant", "fastfood", "bar", "shop", "pharmacy", "bank", "hotel", "worship", "centre", "attraction"]
BASE_RANK = {"uni": 3, "hospital": 3, "station": 3, "museum": 3, "attraction": 3, "stadium": 3, "park": 2, "library": 2, "theatre": 2,
             "market": 2, "cinema": 1, "school": 1, "cafe": 1, "restaurant": 1, "bar": 1, "hotel": 1, "centre": 1,
             "fastfood": 0, "shop": 0, "pharmacy": 0, "bank": 0, "worship": 0}


def fold(s):
    return unicodedata.normalize("NFD", s).encode("ascii", "ignore").decode().lower()


def kind_of(t):
    """The kind for a feature's tags, or None when it is not something we search for."""
    a, sh, le, to, rw, pt = (t.get(k, "") for k in ("amenity", "shop", "leisure", "tourism", "railway", "public_transport"))
    if a in ("university", "college"): return "uni"
    if a == "school": return "school"
    if a == "hospital": return "hospital"
    if a == "library": return "library"
    if to in ("museum", "gallery") or a == "arts_centre": return "museum"
    if a in ("theatre", "concert_hall"): return "theatre"
    if a == "cinema": return "cinema"
    if le == "stadium": return "stadium"
    if a == "marketplace": return "market"
    if le in ("park", "garden", "nature_reserve", "dog_park"): return "park"
    if rw == "station" or (pt == "station" and (t.get("train") == "yes" or t.get("subway") == "yes" or t.get("light_rail") == "yes")): return "station"
    if a == "cafe": return "cafe"
    if a in ("restaurant", "food_court", "ice_cream"): return "restaurant"
    if a == "fast_food": return "fastfood"
    if a in ("bar", "pub", "nightclub", "biergarten"): return "bar"
    if sh == "chemist" or a == "pharmacy": return "pharmacy"
    if sh and sh not in ("vacant", "yes", "no"): return "shop"
    if a == "bank": return "bank"
    if to in ("hotel", "hostel", "motel", "guest_house"): return "hotel"
    if a == "place_of_worship": return "worship"
    if a in ("community_centre", "social_centre") or le in ("sports_centre", "fitness_centre", "ice_rink"): return "centre"
    if to in ("attraction", "zoo", "theme_park", "aquarium", "viewpoint") or t.get("historic") in ("monument", "castle", "fort"): return "attraction"
    return None


def extract():
    """Points and areas with a name, cut out of the PBF by ogr2ogr (a few seconds)."""
    BUILD.mkdir(parents=True, exist_ok=True)
    qb = fd.QGIS_BIN
    env = dict(os.environ, PROJ_DATA=str(qb.parent / "share" / "proj"), PATH=str(qb) + os.pathsep + os.environ["PATH"],
               GDAL_DATA=str(qb.parent / "apps" / "gdal" / "share" / "gdal"))
    w, s, e, n = ISLAND
    for layer, out in (("points", "pts.geojsonl"), ("multipolygons", "areas.geojsonl")):
        p = BUILD / out
        if p.exists():
            continue
        part = p.with_name(p.name + ".part")
        subprocess.run([str(qb / "ogr2ogr.exe"), "-f", "GeoJSONSeq", str(part), str(PBF), layer, "-where", "name IS NOT NULL",
                        "-spat", str(w), str(s), str(e), str(n), "-lco", "COORDINATE_PRECISION=6"], check=True, env=env)
        part.replace(p)


def features():
    for fn, is_area in (("pts.geojsonl", False), ("areas.geojsonl", True)):
        with open(BUILD / fn, encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                ft = json.loads(line)
                p = ft["properties"]
                t = dict(HSTORE.findall(p.get("other_tags") or ""))
                t.update({k: v for k, v in p.items() if v is not None and k != "other_tags"})
                yield t, ft["geometry"], is_area


class Streets:
    """Nearest named street of the routing graph, by a 100 m grid over edge mid-points (edges are short, so mid-points are enough)."""
    def __init__(self):
        g = json.loads(GRAPH.read_text(encoding="utf-8").split("=", 1)[1].rsplit(";", 1)[0])
        nodes = np.array(g["nodes"], dtype=np.int64).reshape(-1, 2) / 1e6
        self.bbox = (nodes[:, 0].min(), nodes[:, 1].min(), nodes[:, 0].max(), nodes[:, 1].max())
        a, b, nm = np.array(g["a"]), np.array(g["b"]), np.array(g["name"])
        self.names = g["names"]
        not_street = re.compile(r"\b(path|piste|sentier|trail|lane|multi-use)\b", re.I)     # a bike or park path is not where a place "is"
        ok = np.array([bool(self.names[i]) and not not_street.search(self.names[i]) for i in nm])
        mid = (nodes[a] + nodes[b]) / 2
        x, y = TO_M.transform(mid[:, 0], mid[:, 1])
        self.x, self.y, self.nm = np.asarray(x)[ok], np.asarray(y)[ok], nm[ok]
        self.grid = collections.defaultdict(list)
        for i, (xx, yy) in enumerate(zip(self.x, self.y)):
            self.grid[(int(xx // 100), int(yy // 100))].append(i)

    def nearest(self, lon, lat, maxd=120.0):
        x, y = TO_M.transform(lon, lat)
        cx, cy = int(x // 100), int(y // 100)
        idx = [i for dx in (-1, 0, 1) for dy in (-1, 0, 1) for i in self.grid.get((cx + dx, cy + dy), ())]
        if not idx:
            return None
        idx = np.array(idx)
        d = np.hypot(self.x[idx] - x, self.y[idx] - y)
        j = int(d.argmin())
        return self.names[self.nm[idx[j]]] if d[j] <= maxd else None


def area_m2(g):
    polys = g.geoms if g.geom_type == "MultiPolygon" else [g]
    return sum(Polygon(list(zip(*TO_M.transform(*zip(*p.exterior.coords))))).area for p in polys)


def main():
    extract()
    st = Streets()
    w, s, e, n = st.bbox
    print(f"routing graph box: {w:.3f},{s:.3f} to {e:.3f},{n:.3f}")
    stats = collections.Counter()
    rows = []
    for t, geom, is_area in features():
        name = t["name"].strip()
        k = kind_of(t)
        if not k or len(name) < 2 or name.isdigit():
            stats["skipped"] += 1
            continue
        if t.get("disused") == "yes" or t.get("abandoned") == "yes" or any(x.startswith("disused:") for x in t):
            stats["disused"] += 1
            continue
        area = 0.0
        if is_area:
            g = shape(geom)
            if g.is_empty:
                continue
            pt = g.representative_point()      # a point inside the polygon, not its centre (a crescent park's centre can be outside it)
            lon, lat = pt.x, pt.y
            area = area_m2(g)
        else:
            lon, lat = geom["coordinates"]
        if not (w <= lon <= e and s <= lat <= n):
            stats["outside_graph_box"] += 1
            continue
        rank = BASE_RANK[k]
        if k == "park":
            rank = 3 if area > 150_000 else 2 if area > 20_000 else 1
        elif k == "uni" and t.get("amenity") == "college":
            rank = 2
        if t.get("wikidata") or t.get("wikipedia"):
            rank = min(3, rank + 1)
        if (" - " in name or "(" in name) and rank > 0:        # "Université de Montréal - Pavillon de géographie": a part of a bigger place
            rank -= 1
        fr, en, short = t.get("name:fr", "").strip(), t.get("name:en", "").strip(), t.get("short_name", "").strip()
        alt = [fr if fold(fr) != fold(name) else "", en if fold(en) != fold(name) else ""]
        if short and rank >= 2 and fold(short) not in (fold(name), fold(fr), fold(en)):
            alt.append(short)
        street = t.get("addr:street", "").strip()
        if not street and area < 50_000:                # a big park or campus has no one street
            street = st.nearest(lon, lat) or ""
        rows.append(dict(k=k, rank=rank, name=name, alt=alt if any(alt) else None, lon=lon, lat=lat, street=street))
        stats["kept_" + k] += 1

    # the same folded name within ~50 m is one place: keep the better ranked one
    rows.sort(key=lambda r: -r["rank"])
    cell = collections.defaultdict(list)
    kept = []
    for r in rows:
        fn = fold(r["name"])
        cx, cy = int(r["lon"] * 1000), int(r["lat"] * 1000)       # cells of ~80 x 110 m; the 9 around cover 50 m
        if any(math.hypot((o["lon"] - r["lon"]) * 78_000, (o["lat"] - r["lat"]) * 111_200) < 50
               for dx in (-1, 0, 1) for dy in (-1, 0, 1) for o in cell.get((cx + dx, cy + dy, fn), ())):
            stats["duplicates"] += 1
            continue
        cell[(cx, cy, fn)].append(r)
        kept.append(r)
    kept.sort(key=lambda r: (round(r["lon"], 5), round(r["lat"], 5)))

    streets, sidx = [""], {"": 0}
    x0 = y0 = None
    x0, y0 = round(w * 1e5), round(s * 1e5)
    cols = dict(kinds=KINDS, x0=x0, y0=y0, streets=streets, k=[], n=[], dx=[], dy=[], s=[], alt={})
    px = x0
    for i, r in enumerate(kept):
        if r["street"] not in sidx:
            sidx[r["street"]] = len(streets)
            streets.append(r["street"])
        x = round(r["lon"] * 1e5)
        cols["k"].append(KINDS.index(r["k"]) * 4 + r["rank"])
        cols["n"].append(r["name"])
        cols["dx"].append(x - px)
        px = x
        cols["dy"].append(round(r["lat"] * 1e5) - y0)
        cols["s"].append(sidx[r["street"]])
        if r["alt"]:
            cols["alt"][i] = r["alt"]
    txt = json.dumps(cols, separators=(",", ":"), ensure_ascii=False)
    (OUT / "places.js").write_text(f"window.PLACES={txt};\n", encoding="utf-8")
    print(f"{len(kept)} places; places.js {len(txt.encode()) / 1e6:.2f} MB raw, {len(gzip.compress(txt.encode(), 9)) / 1e3:.0f} KB gzipped; {len(streets)} streets")
    for k, v in sorted(stats.items()):
        print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
