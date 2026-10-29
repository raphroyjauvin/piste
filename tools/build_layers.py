"""Build the display layers the prototypes load (prototypes/shared/data/*.js, one window.<NAME> each).

    network.js    bike infrastructure by tier (from the routing graph, so map and router always agree)
    planned.js    planned / in-development bike routes, temporary closures, works blocking bike lanes
    pois.js       cyclist POIs: BIXI, metro, cafes, food, bakeries, water, repair, parking, parks, culture
    buildings.js  OSM footprints with heights from the 2023 LiDAR (DSM - DTM, 70th percentile)
    contours.js   5 m contours from the 1 m LiDAR terrain model
    landcover.js  parks, water, woods, cemeteries, rail
    metro.js      STM metro lines and stations (GTFS)
    trips.js      the four test trips

Usage: C:\\bikeapp\\.venv\\Scripts\\python.exe -I C:\\bikeapp\\tools\\build_layers.py [layer ...]
"""
import collections
import csv
import io
import json
import math
import os
import subprocess
import sys
import time
import zipfile
from pathlib import Path

import numpy as np
import rasterio
from rasterio.features import rasterize
from pyproj import Transformer
from shapely.geometry import LineString, MultiPolygon, Polygon, mapping, shape
from shapely.ops import polygonize, transform as shp_transform, unary_union

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
BUILD = ROOT / "data" / "build"
OUT = ROOT / "prototypes" / "shared" / "data"
QGIS_BIN = Path(r"C:\Program Files\QGIS 4.0.1\bin")
BBOX = (-73.615, 45.500, -73.525, 45.582)

TO_M = Transformer.from_crs("EPSG:4326", "EPSG:32188", always_xy=True)
TO_LL = Transformer.from_crs("EPSG:32188", "EPSG:4326", always_xy=True)


def in_bbox(lon, lat, pad=0.0):
    w, s, e, n = BBOX
    return w - pad <= lon <= e + pad and s - pad <= lat <= n + pad


def r6(c):
    return [round(c[0], 6), round(c[1], 6)]


def write_js(name, var, obj):
    txt = json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
    (OUT / name).write_text(f"window.{var}={txt};\n", encoding="utf-8")
    print(f"  wrote {name}: {len(txt) / 1e6:.2f} MB")


def fc(features):
    return {"type": "FeatureCollection", "features": features}


def to_ll_geom(g):
    return shp_transform(lambda x, y, z=None: TO_LL.transform(x, y), g)


def round_geom(geo, nd=6):
    def rec(c):
        if isinstance(c[0], (int, float)):
            return r6(c) if nd == 6 else [round(c[0], nd), round(c[1], nd)]
        return [rec(x) for x in c]
    return {"type": geo["type"], "coordinates": rec(geo["coordinates"])}


# ---------------------------------------------------------------- network
def layer_network():
    g = json.loads((BUILD / "graph_study.json").read_text(encoding="utf-8"))
    N, names, F = g["nodes"], g["names"], g["meta"]["flags"]
    feats = []
    for e in range(len(g["a"])):
        t = g["tier"][e]
        if t > 2:
            continue
        a, b = g["a"][e], g["b"][e]
        pts = [[N[2 * a] / 1e6, N[2 * a + 1] / 1e6]]
        x, y = N[2 * a], N[2 * a + 1]
        gm = g["geom"][e]
        for i in range(0, len(gm), 2):
            x += gm[i]; y += gm[i + 1]; pts.append([x / 1e6, y / 1e6])
        pts.append([N[2 * b] / 1e6, N[2 * b + 1] / 1e6])
        fl = g["flags"][e]
        feats.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": [r6(p) for p in pts]},
                      "properties": {"t": t, "rev": int(bool(fl & F["REV"])), "s4": int(bool(fl & F["4S"])),
                                     "osm": int(bool(fl & F["OSM"])), "off": int(bool(fl & F["OFFSTREET"])),
                                     "n": names[g["name"][e]]}})
    write_js("network.js", "BIKE_NETWORK", fc(feats))


# ---------------------------------------------------------------- planned / closures / works
def layer_planned():
    feats = []
    proj = json.loads((RAW / "mtl_live_tiles" / "pistes-cyclables-projete.geojson").read_text(encoding="utf-8"))["features"]
    status = {"D": "construction", "P": "planned", "GP": "planned"}
    for f in proj:
        p = f["properties"]
        st = status.get(p.get("avancementCode"))
        if not st:
            continue
        feats.append({"type": "Feature", "geometry": round_geom(f["geometry"]),
                      "properties": {"status": st, "name": p.get("projetNom") or "", "rev": int(p.get("revAxes") == "Oui"),
                                     "year": p.get("projetProgramAnnee") or 0, "src": "Ville de Montréal"}})
    live = json.loads((RAW / "mtl_live_tiles" / "pistes-cyclables.geojson").read_text(encoding="utf-8"))["features"]
    for f in live:
        if f["properties"].get("avancementCode") == "FT":
            feats.append({"type": "Feature", "geometry": round_geom(f["geometry"]),
                          "properties": {"status": "closed", "name": f["properties"].get("projetNom") or "",
                                         "src": "Ville de Montréal"}})
    bw = json.loads((RAW / "osm_overpass" / "bikeways.json").read_text(encoding="utf-8"))["elements"]
    for el in bw:
        t = el.get("tags", {})
        if t.get("highway") == "construction" and t.get("construction") == "cycleway":
            feats.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": [r6([p["lon"], p["lat"]]) for p in el["geometry"]]},
                          "properties": {"status": "construction", "name": t.get("name", ""), "src": "OpenStreetMap"}})
    # works blocking a bike lane today (permit point + impacted street)
    permits = {}
    with open(RAW / "mtl_info_travaux_snapshot" / "entraves-travaux-en-cours.csv", encoding="utf-8-sig") as fh:
        for r in csv.DictReader(fh):
            try:
                permits[r["id"]] = (float(r["longitude"]), float(r["latitude"]), r["duration_end_date"][:10], r["reason_category"])
            except ValueError:
                pass
    seen = set()
    with open(RAW / "mtl_info_travaux_snapshot" / "impacts-entraves-travaux-en-cours.csv", encoding="utf-8-sig") as fh:
        for r in csv.DictReader(fh):
            bt = (r.get("bikepath_blockedtype") or "").strip()
            if not bt or bt.startswith("Aucun"):
                continue
            p = permits.get(r["id_request"])
            if not p or not in_bbox(p[0], p[1]) or (r["id_request"], r["streetid"]) in seen:
                continue
            seen.add((r["id_request"], r["streetid"]))
            feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": r6(p[:2])},
                          "properties": {"status": "works", "name": r["streetid"].strip(), "from": r["fromname"].strip(),
                                         "to": r["toname"].strip(), "until": p[2], "impact": bt, "src": "Ville de Montréal (Info-travaux)"}})
    c = collections.Counter(f["properties"]["status"] for f in feats)
    print("  planned layer:", dict(c))
    write_js("planned.js", "PLANNED", fc(feats))


# ---------------------------------------------------------------- POIs
def layer_pois():
    els = json.loads((RAW / "osm_overpass" / "pois.json").read_text(encoding="utf-8"))["elements"]
    out = []

    def kind(t):
        a, s, l, tr = t.get("amenity"), t.get("shop"), t.get("leisure"), t.get("tourism")
        if a == "cafe" or s == "coffee": return "cafe"
        if a in ("restaurant", "fast_food"): return "food"
        if s in ("bakery", "pastry", "chocolate", "confectionery", "deli"): return "bakery"
        if a == "ice_cream": return "icecream"
        if a in ("bar", "pub", "biergarten"): return "bar"
        if a in ("bicycle_repair_station", "compressed_air"): return "repair"
        if s == "bicycle": return "bikeshop"
        if a == "bicycle_parking": return "parking"
        if a == "drinking_water": return "water"
        if a == "toilets": return "toilets"
        if l in ("park", "garden"): return "park"
        if tr == "viewpoint": return "viewpoint"
        if tr in ("museum", "attraction") or a == "library": return "culture"
        if a == "marketplace" or s == "greengrocer": return "market"
        return None

    for el in els:
        t = el.get("tags", {})
        k = kind(t)
        if not k:
            continue
        c = el.get("center") or {"lon": el.get("lon"), "lat": el.get("lat")}
        if c["lon"] is None or not in_bbox(c["lon"], c["lat"]):
            continue
        if k == "park" and not t.get("name"):
            continue
        out.append([k, t.get("name", ""), round(c["lon"], 6), round(c["lat"], 6)])
    # named shops (separate download, 2026-10-28)
    shops = RAW / "osm_overpass" / "shops.json"
    if shops.exists():
        for el in json.loads(shops.read_text(encoding="utf-8"))["elements"]:
            t = el.get("tags", {})
            c = el.get("center") or {"lon": el.get("lon"), "lat": el.get("lat")}
            if c["lon"] is None or not t.get("name") or not in_bbox(c["lon"], c["lat"]):
                continue
            out.append(["shop", t["name"], round(c["lon"], 6), round(c["lat"], 6)])
    # City fountains (dedupe with OSM water within ~12 m)
    water = [(p[2], p[3]) for p in out if p[0] == "water"]
    with open(RAW / "mtl_fontaines_a_boire" / "fontaine_eau_potable_v2018.csv", encoding="utf-8-sig") as fh:
        for r in csv.DictReader(fh):
            try:
                lon, lat = float(r["Longitude"]), float(r["Latitude"])
            except ValueError:
                continue
            if not in_bbox(lon, lat):
                continue
            if any(abs(lon - x) < 0.00016 and abs(lat - y) < 0.00011 for x, y in water):
                continue
            out.append(["water", ("Fountain, " + r["Nom_parc_lieu"]).strip(", "), round(lon, 6), round(lat, 6)])
    # BIXI stations (GBFS)
    st = json.loads((RAW / "bixi_gbfs" / "station_information.json").read_text(encoding="utf-8"))["data"]["stations"]
    for s in st:
        if in_bbox(s["lon"], s["lat"]):
            out.append(["bixi", s["name"], round(s["lon"], 6), round(s["lat"], 6), s.get("capacity", 0)])
    # metro stations (GTFS)
    for name, lon, lat, lines in metro_stations():
        if in_bbox(lon, lat, 0.01):
            out.append(["metro", name, lon, lat, lines])
    c = collections.Counter(p[0] for p in out)
    print("  POIs:", dict(c.most_common()))
    write_js("pois.js", "POIS", out)


def gtfs():
    return zipfile.ZipFile(RAW / "stm_gtfs" / "gtfs_stm.zip")


METRO_SHAPES = {"1": "1_1071", "2": "2_236", "4": "4_24", "5": "5_1763"}


def metro_lines():
    z = gtfs()
    routes = {r["route_id"]: r for r in csv.DictReader(io.TextIOWrapper(z.open("routes.txt"), encoding="utf-8-sig"))}
    pts = collections.defaultdict(list)
    want = set(METRO_SHAPES.values())
    for r in csv.DictReader(io.TextIOWrapper(z.open("shapes.txt"), encoding="utf-8-sig")):
        if r["shape_id"] in want:
            pts[r["shape_id"]].append((int(r["shape_pt_sequence"]), float(r["shape_pt_lon"]), float(r["shape_pt_lat"])))
    lines = []
    for rid, sid in METRO_SHAPES.items():
        coords = [r6([x, y]) for _, x, y in sorted(pts[sid])]
        r = routes[rid]
        lines.append({"id": rid, "name": r["route_long_name"], "color": "#" + r["route_color"], "coords": coords})
    return lines


def metro_stations():
    z = gtfs()
    lines = metro_lines()
    lm = []
    for ln in lines:
        xy = list(zip(*TO_M.transform([c[0] for c in ln["coords"]], [c[1] for c in ln["coords"]])))
        lm.append((ln["id"], LineString(xy)))
    out = []
    for r in csv.DictReader(io.TextIOWrapper(z.open("stops.txt"), encoding="utf-8-sig")):
        if r["location_type"] != "1" or not r["stop_id"].startswith("STATION_M"):
            continue
        lon, lat = float(r["stop_lon"]), float(r["stop_lat"])
        x, y = TO_M.transform(lon, lat)
        from shapely.geometry import Point
        on = [lid for lid, L in lm if L.distance(Point(x, y)) < 120]
        name = r["stop_name"].replace("STATION ", "").title().replace("–", "-")
        name = name.replace("Uqam", "UQAM").replace("Oaci", "OACI").replace("Du ", "du ").replace("De ", "de ").replace("D'", "d'")
        out.append((name, round(lon, 6), round(lat, 6), on))
    return out


def layer_metro():
    write_js("metro.js", "METRO", {"lines": metro_lines(),
                                   "stations": [{"name": n, "lon": lo, "lat": la, "lines": l} for n, lo, la, l in metro_stations()]})


# ---------------------------------------------------------------- buildings with LiDAR heights
def osm_polygons(elements, keep=lambda t: True):
    """Yield (tags, shapely polygon in lon/lat) for closed ways and multipolygon relations."""
    for el in elements:
        t = el.get("tags", {})
        if not keep(t):
            continue
        try:
            if el["type"] == "way":
                c = [(p["lon"], p["lat"]) for p in el.get("geometry", [])]
                if len(c) >= 4 and c[0] == c[-1]:
                    yield t, Polygon(c)
            elif el["type"] == "relation":
                outers, inners = [], []
                for m in el.get("members", []):
                    if m.get("type") != "way" or "geometry" not in m:
                        continue
                    ls = LineString([(p["lon"], p["lat"]) for p in m["geometry"]])
                    (inners if m.get("role") == "inner" else outers).append(ls)
                op = list(polygonize(unary_union(outers))) if outers else []
                ip = list(polygonize(unary_union(inners))) if inners else []
                if op:
                    g = unary_union(op)
                    if ip:
                        g = g.difference(unary_union(ip))
                    yield t, g
        except Exception:  # noqa: BLE001 - skip broken geometries
            continue


def layer_buildings():
    t0 = time.time()
    els = json.loads((RAW / "osm_overpass" / "buildings.json").read_text(encoding="utf-8"))["elements"]
    polys, tags = [], []
    for t, g in osm_polygons(els):
        gm = shp_transform(lambda x, y, z=None: TO_M.transform(x, y), g)
        if not gm.is_valid:
            gm = gm.buffer(0)
        if gm.is_empty or gm.area < 12:
            continue
        polys.append(gm); tags.append(t)
    print(f"  building footprints: {len(polys)}")
    dsm = rasterio.open(RAW / "nrcan_hrdem_cmm2023" / "dsm_study_area_32188_1m.tif")
    dtm = rasterio.open(RAW / "nrcan_hrdem_cmm2023" / "dtm_study_area_32188_1m.tif")
    nd = dsm.read(1, masked=True).filled(np.nan).astype("float32")
    nd -= dtm.read(1, masked=True).filled(np.nan).astype("float32")
    ids = rasterize(((p, i + 1) for i, p in enumerate(polys)), out_shape=nd.shape, transform=dsm.transform,
                    fill=0, dtype="int32")
    m = (ids > 0) & np.isfinite(nd)
    idv, v = ids[m], nd[m]
    del ids, nd
    order = np.lexsort((v, idv))
    idv, v = idv[order], v[order]
    uniq, start, counts = np.unique(idv, return_index=True, return_counts=True)
    p70 = v[start + np.minimum((counts * 0.7).astype(int), counts - 1)]
    lidar = dict(zip(uniq.tolist(), zip(p70.tolist(), counts.tolist())))
    # Packed encoding (outer rings only; multipolygon parts become separate entries):
    #   h: height in decimetres, c: vertex count per ring (ring not repeated-closed),
    #   d: flat [dLonE6, dLatE6, ...] deltas, continuous across all rings (first value absolute).
    packed = {"h": [], "c": [], "d": [], "meta": {"source": "OSM footprints; heights from NRCan HRDEM CMM 2023 LiDAR (DSM-DTM, p70)"}}
    src_count = collections.Counter()
    px = py = 0
    for i, (p, t) in enumerate(zip(polys, tags)):
        h, n = lidar.get(i + 1, (None, 0))
        osm_h = None
        try:
            if t.get("height"):
                osm_h = float(str(t["height"]).split()[0])
            elif t.get("building:levels"):
                osm_h = float(t["building:levels"]) * 3.2 + 1.0
        except ValueError:
            pass
        if h is not None and n >= 6 and h >= 2.0:
            height, src = h, "lidar"
        elif osm_h:
            height, src = osm_h, "osm"
        else:
            height, src = 6.0, "default"
        src_count[src] += 1
        height = float(min(max(height, 2.5), 260))
        ll = to_ll_geom(p.simplify(0.4, preserve_topology=True))
        parts = list(ll.geoms) if isinstance(ll, MultiPolygon) else [ll]
        for part in parts:
            if part.is_empty or not hasattr(part, "exterior"):
                continue
            ring = list(part.exterior.coords)[:-1]
            if len(ring) < 3:
                continue
            packed["h"].append(int(round(height * 10)))
            packed["c"].append(len(ring))
            for lon, lat in ring:
                qx, qy = round(lon * 1e6), round(lat * 1e6)
                packed["d"] += [qx - px, qy - py]
                px, py = qx, qy
    print(f"  heights by source: {dict(src_count)}; rings {len(packed['c'])}; {time.time() - t0:.0f}s")
    old = OUT / "buildings.js"
    if old.exists():
        old.unlink()
    write_js("buildings_packed.js", "BUILDINGS_PACKED", packed)


# ---------------------------------------------------------------- contours
def layer_contours(step=5):
    env = dict(os.environ, PROJ_DATA=str(QGIS_BIN.parent / "share" / "proj"),
               PATH=str(QGIS_BIN) + os.pathsep + os.environ["PATH"])
    dtm = RAW / "nrcan_hrdem_cmm2023" / "dtm_study_area_32188_1m.tif"
    dtm5 = BUILD / "dtm_5m.tif"
    cont = BUILD / "contours_5m.geojson"
    subprocess.run([str(QGIS_BIN / "gdalwarp.exe"), "-overwrite", "-tr", "5", "5", "-r", "average", str(dtm), str(dtm5)],
                   check=True, env=env, stdout=subprocess.DEVNULL)
    if cont.exists():
        cont.unlink()
    subprocess.run([str(QGIS_BIN / "gdal_contour.exe"), "-a", "e", "-i", str(step), "-f", "GeoJSON", str(dtm5), str(cont)],
                   check=True, env=env, stdout=subprocess.DEVNULL)
    src = json.loads(cont.read_text(encoding="utf-8"))
    feats = []
    for f in src["features"]:
        g = shape(f["geometry"])
        if g.length < 60:
            continue
        g = g.simplify(2.0)
        e = round(f["properties"]["e"])
        feats.append({"type": "Feature", "geometry": round_geom(mapping(to_ll_geom(g))),
                      "properties": {"e": e, "i": int(e % 25 == 0)}})
    # 2026-10-29: extra 1 m lines where the ground rises 2.5-15 %, so the climbs riders feel show as denser lines
    # (steeper ground already has dense 5 m lines). i: 1 = every 25 m, 0 = every 5 m, 2 = 1 m detail.
    smooth = BUILD / "dtm_5m_moderate.tif"
    detail = BUILD / "contours_1m_detail.geojson"
    with rasterio.open(dtm5) as ds:
        z = ds.read(1, masked=True).filled(np.nan).astype("float64")
        prof = ds.profile
    valid = np.isfinite(z)
    zfill = np.where(valid, z, np.nanmedian(z))
    zs = gaussian_smooth(zfill, 2.0)                                        # ~10 m smoothing for the lines themselves
    gy, gx = np.gradient(gaussian_smooth(zfill, 5.0), 5.0)                  # slope over ~25 m, so the mask follows real climbs
    slope = np.hypot(gx, gy)
    keep = (slope >= 0.025) & (slope <= 0.15)
    keep = valid & (gaussian_smooth(keep.astype("float64"), 3.0) > 0.55)    # drop small patches and fill small holes
    prof.update(dtype="float32", nodata=-9999.0, compress="deflate")
    with rasterio.open(smooth, "w", **prof) as out:
        out.write(np.where(keep, zs, -9999.0).astype("float32"), 1)
    if detail.exists():
        detail.unlink()
    subprocess.run([str(QGIS_BIN / "gdal_contour.exe"), "-a", "e", "-i", "1", "-f", "GeoJSON", str(smooth), str(detail)],
                   check=True, env=env, stdout=subprocess.DEVNULL)
    n_detail = 0
    for f in json.loads(detail.read_text(encoding="utf-8"))["features"]:
        e = round(f["properties"]["e"])
        if e % 5 == 0:
            continue
        g = shape(f["geometry"])
        if g.length < 120:
            continue
        feats.append({"type": "Feature", "geometry": round_geom(mapping(to_ll_geom(g.simplify(3.0))), 5), "properties": {"e": e, "i": 2}})
        n_detail += 1
    print(f"  contours: {len(feats)} lines ({n_detail} 1 m detail lines on moderate slopes)")
    write_js("contours.js", "CONTOURS", fc(feats))


# ---------------------------------------------------------------- landcover
def layer_landcover():
    els = json.loads((RAW / "osm_overpass" / "landcover.json").read_text(encoding="utf-8"))["elements"]

    def cls(t):
        if t.get("natural") == "water": return "water"
        if t.get("natural") in ("wood", "scrub") or t.get("landuse") == "forest": return "wood"
        if t.get("landuse") == "cemetery": return "cemetery"
        if t.get("leisure") in ("pitch", "playground"): return "sport"
        if t.get("leisure") == "golf_course": return "park"
        if t.get("leisure") or t.get("landuse"): return "park"
        return None

    feats = []
    for t, g in osm_polygons(els, keep=lambda t: cls(t) is not None):
        c = cls(t)
        gm = shp_transform(lambda x, y, z=None: TO_M.transform(x, y), g)
        if not gm.is_valid:
            gm = gm.buffer(0)
        if gm.is_empty or gm.area < 150:
            continue
        ll = to_ll_geom(gm.simplify(1.0, preserve_topology=True))
        feats.append({"type": "Feature", "geometry": round_geom(mapping(ll)), "properties": {"c": c, "n": t.get("name", "")}})
    for el in els:
        t = el.get("tags", {})
        if el["type"] == "way" and t.get("railway") == "rail":
            feats.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": [r6([p["lon"], p["lat"]]) for p in el["geometry"]]},
                          "properties": {"c": "rail"}})
    print("  landcover:", dict(collections.Counter(f["properties"]["c"] for f in feats)))
    write_js("landcover.js", "LANDCOVER", fc(feats))


def layer_demgrid(step_m=20):
    """Regular lon/lat elevation grid (decimetres) for the three.js terrain; sampled from the 5 m DTM."""
    dtm5 = BUILD / "dtm_5m.tif"
    ds = rasterio.open(dtm5)
    arr = ds.read(1, masked=True).filled(np.nan)
    inv = ~ds.transform
    w, s, e, n = BBOX
    lat0 = (s + n) / 2
    nx = int((e - w) * 111320 * math.cos(math.radians(lat0)) / step_m) + 1
    ny = int((n - s) * 110540 / step_m) + 1
    lons = np.linspace(w, e, nx); lats = np.linspace(n, s, ny)  # row 0 = north
    LON, LAT = np.meshgrid(lons, lats)
    X, Y = TO_M.transform(LON.ravel(), LAT.ravel())
    cols, rows = inv * (np.asarray(X), np.asarray(Y))
    c = np.clip(np.round(cols).astype(int), 0, arr.shape[1] - 1)
    r = np.clip(np.round(rows).astype(int), 0, arr.shape[0] - 1)
    z = arr[r, c]
    z = np.where(np.isfinite(z), z, np.nanmedian(z))
    write_js("dem_grid.js", "DEM_GRID", {"w": w, "s": s, "e": e, "n": n, "nx": nx, "ny": ny,
                                         "z": [int(round(v * 10)) for v in z.tolist()],
                                         "meta": "NRCan HRDEM CMM 2023 DTM, 20 m grid, decimetres, row 0 = north"})


def gaussian_smooth(z, sigma_cells):
    """Separable Gaussian blur (numpy only)."""
    r = int(3 * sigma_cells)
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma_cells) ** 2)
    k /= k.sum()
    zp = np.pad(z, r, mode="edge")
    zp = np.apply_along_axis(lambda m: np.convolve(m, k, mode="same"), 0, zp)
    zp = np.apply_along_axis(lambda m: np.convolve(m, k, mode="same"), 1, zp)
    return zp[r:-r, r:-r]


def edge_feather(shape, px):
    """0 at the raster's edge, rising to 1 at px pixels in, so the elevation layers fade out instead of stopping in a line."""
    h, w = shape
    y = np.minimum(np.arange(h), np.arange(h)[::-1])[:, None]
    x = np.minimum(np.arange(w), np.arange(w)[::-1])[None, :]
    return np.clip(np.minimum(x, y) / px, 0, 1)


def layer_hillshade(res=5.0, zf=2.3, sigma_m=10.0):
    # 2026-10-29 (Raph): halfway between the first prototype (zf 1.8, sigma 12) and the strong version of 10-28 (zf 2.8, sigma 8)
    """Soft relief overlay from the LiDAR terrain: transparent PNG (shadows + light highlights) in Web Mercator."""
    from PIL import Image
    env = dict(os.environ, PROJ_DATA=str(QGIS_BIN.parent / "share" / "proj"),
               PATH=str(QGIS_BIN) + os.pathsep + os.environ["PATH"])
    dtm5 = BUILD / "dtm_5m.tif"
    merc = BUILD / "dtm_3857.tif"
    subprocess.run([str(QGIS_BIN / "gdalwarp.exe"), "-overwrite", "-t_srs", "EPSG:3857", "-tr", str(res), str(res),
                    "-r", "bilinear", str(dtm5), str(merc)], check=True, env=env, stdout=subprocess.DEVNULL)
    ds = rasterio.open(merc)
    z = ds.read(1, masked=True).filled(np.nan).astype("float64")
    valid = np.isfinite(z)
    z = np.where(valid, z, np.nanmedian(z))
    # Web Mercator metres are stretched by 1/cos(lat): convert cell size to ground metres
    lat0 = math.radians((BBOX[1] + BBOX[3]) / 2)
    cell = res * math.cos(lat0)
    z = gaussian_smooth(z, sigma_m / cell)  # keep real relief, drop building-scale noise
    gy, gx = np.gradient(z * zf, cell)
    slope = np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(-gx, gy)
    zen = math.radians(48)
    hs = np.zeros_like(z)
    for az, wgt in ((315, 0.45), (270, 0.2), (360, 0.2), (225, 0.15)):
        a = math.radians(az)
        hs += wgt * (math.cos(zen) * np.cos(slope) + math.sin(zen) * np.sin(slope) * np.cos(a - aspect))
    flat = math.cos(zen)
    shadow = np.clip((flat - hs) / flat - 0.009, 0, 1) ** 0.75
    light = np.clip((hs - flat) / (1 - flat) - 0.009, 0, 1) ** 0.92
    lum = np.where(shadow > 0, 39, 255).astype(np.uint8)
    alpha = np.where(shadow > 0, np.minimum(1, shadow * 1.12) * 238, light * 158)
    alpha = (np.where(valid, np.clip(alpha, 0, 255), 0) * edge_feather(alpha.shape, 80)).astype(np.uint8)   # 80 px = 400 m fade
    img = Image.fromarray(np.dstack([lum, alpha]), "LA")
    img.save(OUT / "hillshade.png", optimize=True)
    # preview composited on a Positron-like background
    bg = Image.new("RGBA", img.size, (242, 243, 240, 255))
    bg.alpha_composite(img.convert("RGBA"))
    bg.convert("RGB").resize((img.size[0] // 3, img.size[1] // 3)).save(BUILD / "hillshade_preview.jpg", quality=85)
    b = ds.bounds
    to_ll = Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)
    (w, n_), (e, s_) = to_ll.transform(b.left, b.top), to_ll.transform(b.right, b.bottom)
    coords = [[w, n_], [e, n_], [e, s_], [w, s_]]
    write_js("hillshade.js", "HILLSHADE", {"url": "hillshade.png", "coordinates": [[round(x, 7), round(y, 7)] for x, y in coords],
                                           "meta": "Multidirectional hillshade of NRCan HRDEM CMM 2023 DTM (5 m), shadows and highlights"})
    print(f"  hillshade.png {(OUT / 'hillshade.png').stat().st_size / 1e6:.2f} MB, {z.shape[1]}x{z.shape[0]} px")


# Hypsometric tint: elevation (m) -> (r, g, b, alpha 0-255). Low ground clear, hills warm.
# soft sand-to-tan ramp (2026-10-28: softened after the first look; it now sits above parks, so it must stay light)
TINT_RAMP = [(10, (240, 240, 232, 0)), (20, (240, 236, 222, 46)), (35, (238, 229, 206, 76)), (50, (235, 221, 192, 97)),
             (65, (231, 212, 180, 115)), (85, (226, 202, 167, 132)), (110, (219, 190, 153, 148)),
             (150, (209, 176, 139, 161)), (200, (196, 160, 124, 174))]


def layer_tint(res=10.0, sigma_m=20.0):
    """Elevation colour tint (transparent PNG, Web Mercator) + the ramp for the legend."""
    from PIL import Image
    env = dict(os.environ, PROJ_DATA=str(QGIS_BIN.parent / "share" / "proj"),
               PATH=str(QGIS_BIN) + os.pathsep + os.environ["PATH"])
    merc = BUILD / "dtm_3857_10m.tif"
    subprocess.run([str(QGIS_BIN / "gdalwarp.exe"), "-overwrite", "-t_srs", "EPSG:3857", "-tr", str(res), str(res),
                    "-r", "average", str(BUILD / "dtm_5m.tif"), str(merc)], check=True, env=env, stdout=subprocess.DEVNULL)
    ds = rasterio.open(merc)
    z = ds.read(1, masked=True).filled(np.nan).astype("float64")
    valid = np.isfinite(z)
    z = gaussian_smooth(np.where(valid, z, np.nanmedian(z)), sigma_m / (res * math.cos(math.radians((BBOX[1] + BBOX[3]) / 2))))
    zs = [s[0] for s in TINT_RAMP]
    rgba = np.zeros(z.shape + (4,), dtype=np.uint8)
    for ch in range(4):
        rgba[..., ch] = np.interp(z, zs, [s[1][ch] for s in TINT_RAMP]).astype(np.uint8)
    rgba[..., 3] = (np.where(valid, rgba[..., 3], 0) * edge_feather(z.shape, 40)).astype(np.uint8)   # 40 px = 400 m fade
    Image.fromarray(rgba, "RGBA").save(OUT / "elevation_tint.png", optimize=True)
    b = ds.bounds
    to_ll = Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)
    (w, n_), (e, s_) = to_ll.transform(b.left, b.top), to_ll.transform(b.right, b.bottom)
    write_js("elevation_tint.js", "ELEVATION_TINT", {
        "url": "elevation_tint.png", "coordinates": [[round(w, 7), round(n_, 7)], [round(e, 7), round(n_, 7)], [round(e, 7), round(s_, 7)], [round(w, 7), round(s_, 7)]],
        "ramp": [[s[0], "rgba(%d,%d,%d,%.2f)" % (s[1][0], s[1][1], s[1][2], s[1][3] / 255)] for s in TINT_RAMP],
        "meta": "Hypsometric tint from NRCan HRDEM CMM 2023 DTM, 10 m, smoothed 20 m"})
    print(f"  elevation_tint.png {(OUT / 'elevation_tint.png').stat().st_size / 1e6:.2f} MB")


def layer_terrain(zmin=10, zmax=14, margin=0.012):
    """Terrain tiles (Terrarium PNG encoding) from the LiDAR DTM; pixels outside the LiDAR cut come from the
    public AWS terrain tiles so there is no cliff at the edge. Writes shared/terrain/{z}/{x}/{y}.png + an index."""
    from PIL import Image
    import io
    import urllib.request
    ds = rasterio.open(BUILD / "dtm_5m.tif")
    arr = ds.read(1, masked=True).filled(np.nan).astype("float64")
    arr = gaussian_smooth(np.where(np.isfinite(arr), arr, np.nan_to_num(arr, nan=float(np.nanmedian(arr)))), 1.2)
    arr[~np.isfinite(ds.read(1, masked=True).filled(np.nan))] = np.nan
    inv = ~ds.transform
    H, W = arr.shape

    def sample(xs, ys):
        cols, rows = inv * (xs, ys)
        c0 = np.floor(cols - 0.5).astype(int); r0 = np.floor(rows - 0.5).astype(int)
        fc = cols - 0.5 - c0; fr = rows - 0.5 - r0
        ok = (c0 >= 0) & (r0 >= 0) & (c0 + 1 < W) & (r0 + 1 < H)
        c0c = np.clip(c0, 0, W - 2); r0c = np.clip(r0, 0, H - 2)
        v = (arr[r0c, c0c] * (1 - fc) * (1 - fr) + arr[r0c, c0c + 1] * fc * (1 - fr) +
             arr[r0c + 1, c0c] * (1 - fc) * fr + arr[r0c + 1, c0c + 1] * fc * fr)
        return np.where(ok, v, np.nan)

    def aws(z, x, y):
        url = f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "bikeapp-prototype/0.1"}), timeout=60) as r:
            im = np.asarray(Image.open(io.BytesIO(r.read())).convert("RGB")).astype("float64")
        return im[..., 0] * 256 + im[..., 1] + im[..., 2] / 256 - 32768

    w, s, e, n = BBOX
    outdir = OUT.parent / "terrain"
    tiles = []
    for z in range(zmin, zmax + 1):
        N = 2 ** z
        def tx(lon): return int((lon + 180) / 360 * N)
        def ty(lat): return int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * N)
        for x in range(tx(w - margin), tx(e + margin) + 1):
            for y in range(ty(n + margin), ty(s - margin) + 1):
                px = (np.arange(256) + 0.5) / 256
                lon = (x + px) / N * 360 - 180
                lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * (y + px) / N))))
                LON, LAT = np.meshgrid(lon, lat)
                X, Y = TO_M.transform(LON.ravel(), LAT.ravel())
                elev = sample(np.asarray(X), np.asarray(Y)).reshape(256, 256)
                if np.isnan(elev).any():
                    elev = np.where(np.isnan(elev), aws(z, x, y), elev)
                elev = np.round(elev, 1)
                v = elev + 32768
                rgb = np.dstack([np.floor(v / 256), np.floor(v) % 256, np.floor((v - np.floor(v)) * 256)]).astype(np.uint8)
                p = outdir / str(z) / str(x); p.mkdir(parents=True, exist_ok=True)
                Image.fromarray(rgb, "RGB").save(p / f"{y}.png", optimize=True)
                tiles.append(f"{z}/{x}/{y}")
    total = sum(f.stat().st_size for f in outdir.rglob("*.png"))
    write_js("terrain_index.js", "TERRAIN_TILES", {"minzoom": zmin, "maxzoom": zmax, "tiles": tiles,
                                                  "meta": "Terrarium-encoded NRCan HRDEM CMM 2023 DTM; AWS terrain tiles outside the LiDAR cut"})
    print(f"  terrain tiles: {len(tiles)}, {total / 1e6:.1f} MB")


def layer_trips():
    write_js("trips.js", "TRIPS", json.loads((ROOT / "prototypes" / "shared" / "trips.json").read_text(encoding="utf-8")))


LAYERS = {"network": layer_network, "planned": layer_planned, "pois": layer_pois, "metro": layer_metro,
          "buildings": layer_buildings, "contours": layer_contours, "landcover": layer_landcover, "trips": layer_trips,
          "demgrid": layer_demgrid, "hillshade": layer_hillshade, "tint": layer_tint, "terrain": layer_terrain}

if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    # landcover and demgrid fed the retired three.js prototype (C); build them only when named
    OPTIONAL = {"landcover", "demgrid"}
    for name in (sys.argv[1:] or [k for k in LAYERS if k not in OPTIONAL]):
        print(f"== {name}")
        sys.stdout.flush()
        LAYERS[name]()
