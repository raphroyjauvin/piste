"""Island-wide 3D building tiles for the Piste app: OSM footprints + LiDAR heights -> vector tiles.

Output: prototypes/shared/tiles/buildings.pmtiles (MVT, extent 4096, XYZ Web Mercator, z13-15, one layer "buildings",
Polygon/MultiPolygon features with one property h = height in metres). The app overzooms beyond z15.

Stages (run in this order; each can be re-run, and skips work already done unless --refresh):
    fetch    OSM buildings for the whole island from Overpass, in a 4 x 4 grid of boxes (each box is fetched as four
             sub-queries and merged, so the busy public servers can answer in time)
             -> data/raw/osm_overpass/buildings_island/part_<row>_<col>.json
    fetch_pbf  the same OSM buildings from BBBike's Montreal extract, for when Overpass is overloaded (use --source pbf)
             -> data/raw/osm_bbbike/Montreal.osm.pbf, data/build/island_buildings/bbbike_buildings.geojsonl
    dsm      NRCan HRDEM DSM cut to the island at 5 m (like fetch_data.task_island does for the DTM), for both LiDAR
             campaigns that cover the island: CMM 2023 (east and centre) and CMM 2024 (West Island, north-west, South Shore)
             -> data/raw/nrcan_hrdem_cmm2023/dsm_island_32188_5m.tif, data/raw/nrcan_hrdem_cmm2024/dsm_island_32188_5m.tif
    heights  parse + de-duplicate footprints, LiDAR height for each: 1 m rasters (2023) for buildings whose centroid is in the
             old study area, else 5 m (2023, or 2024 where 2023 has no data), else the OSM height/levels tag, else 6 m
             -> data/build/island_buildings/buildings.pkl
    tiles    cut the footprints into vector tiles and write the PMTiles archive
    check    read the archive back, print counts/heights for three places, render a PNG of a downtown tile
    all      all of the above

Usage: C:\\bikeapp\\.venv\\Scripts\\python.exe -I C:\\bikeapp\\tools\\island_buildings.py <stage|all> [--refresh]
"""
import argparse
import collections
import gzip
import json
import math
import os
import pickle
import re
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))   # python -I does not add the script folder

import numpy as np
import shapely
from pyproj import Transformer
from shapely.geometry import LineString, MultiPolygon, Polygon, shape
from shapely.ops import polygonize, unary_union

import build_layers as BL      # study-area BBOX, raster names (not edited)
import fetch_data as FD        # overpass(), log(), DEM urls, ISLAND_BBOX (not edited)

ROOT = FD.ROOT
RAW = FD.RAW
BUILD = ROOT / "data" / "build" / "island_buildings"
HRDEM = RAW / "nrcan_hrdem_cmm2023"
PARTS_DIR = RAW / "osm_overpass" / "buildings_island"
TILES_OUT = ROOT / "prototypes" / "shared" / "tiles" / "buildings.pmtiles"
SCRATCH = BUILD                                   # check renders go to data/build/island_buildings/buildings_check/ (git-ignored)

ISLAND_BBOX = FD.ISLAND_BBOX           # (-73.985, 45.395, -73.465, 45.715)  west, south, east, north
STUDY_BBOX = BL.BBOX                   # (-73.615, 45.500, -73.525, 45.582)  the 1 m LiDAR cut
GRID = (4, 4)                          # Overpass boxes: rows (north to south) x cols (west to east)

TO_M = Transformer.from_crs("EPSG:4326", "EPSG:32188", always_xy=True)

MIN_AREA_M2 = 12.0                     # same footprint filter as build_layers.layer_buildings
H_MIN, H_MAX, H_DEFAULT = 2.5, 250.0, 6.0
LIDAR_MIN_H = 2.0                      # below this, DSM-DTM is not a building (layer_buildings rule)
LIDAR_MIN_PIXELS_1M = 6                # layer_buildings rule for the 1 m rasters


def say(*a):
    print(*a)
    sys.stdout.flush()


def gdal_env():
    return dict(os.environ, PROJ_DATA=str(FD.QGIS_BIN.parent / "share" / "proj"),
                PATH=str(FD.QGIS_BIN) + os.pathsep + os.environ["PATH"],
                GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_HTTP_MULTIRANGE="YES",
                GDAL_HTTP_MERGE_CONSECUTIVE_RANGES="YES", VSI_CACHE="TRUE")


# ------------------------------------------------------------------------------------------------ 1. OSM footprints
def grid_boxes():
    w, s, e, n = ISLAND_BBOX
    rows, cols = GRID
    dx, dy = (e - w) / cols, (n - s) / rows
    for r in range(rows):
        for c in range(cols):
            yield r, c, (w + c * dx, n - (r + 1) * dy, w + (c + 1) * dx, n - r * dy)


def buildings_query(box):
    """Same selection as the "buildings.json" query in fetch_data.task_osm, for one box.

    Two output statements on purpose: "out geom tags" leaves the MEMBERS out of relations, so task_osm's buildings.json
    holds 114 multipolygon buildings that have no geometry (build_layers silently drops them). Relations are therefore
    printed with plain "out geom" (members + their geometry); ways keep the lighter "out geom tags"."""
    w, s, e, n = box
    bb = f"({s:.6f},{w:.6f},{n:.6f},{e:.6f})"
    return f"""[out:json][timeout:270][maxsize:1073741824];
(
  way["building"]{bb};
);
out geom tags qt;
(
  relation["building"]["type"="multipolygon"]{bb};
);
out geom qt;"""


# Overpass servers, tried in this order for each box: the main one, then kumi.systems. (private.coffee hangs under load.)
SERVERS = [FD.OVERPASS, FD.OVERPASS_MIRRORS[2]]
READ_TIMEOUT = 300      # seconds to wait for one answer; the query's own [timeout] is set a little lower


def overpass_box(box, used):
    """One box from the first server that answers. The public servers answer 502/504 or hang when busy (one hung attempt
    in fetch_data.overpass lasts 15 minutes), so each attempt is short and the next one uses another server."""
    import urllib.parse
    body = urllib.parse.urlencode({"data": buildings_query(box)}).encode()
    last = None
    for attempt, url in enumerate(SERVERS):
        try:
            data = json.loads(FD.get(url, data=body, timeout=READ_TIMEOUT))
            remark = data.get("remark", "")
            if remark and any(w in remark.lower() for w in ("error", "timed out", "out of memory")):
                raise RuntimeError(f"Overpass remark: {remark[:120]}")   # a partial answer comes back as HTTP 200
            used.add(url)
            return data
        except Exception as ex:  # noqa: BLE001 - 429/502/504 and timeouts are normal on public Overpass servers
            last = ex
            say(f"   {url} failed for box {tuple(round(v, 3) for v in box)} ({str(ex)[:90]}); attempt {attempt + 1}/{len(SERVERS)}")
            time.sleep(15)
    raise last


def split_fetch(box, used, depth):
    """The four quarters of a box, fetched one after the other and merged (an object that reaches into two quarters is
    returned by both: keep it once)."""
    w, s, e, n = box
    mx, my = (w + e) / 2, (s + n) / 2
    merged, seen, first = [], set(), None
    for sub in ((w, my, mx, n), (mx, my, e, n), (w, s, mx, my), (mx, s, e, my)):
        d = fetch_box(sub, used, depth)
        first = first or d
        for el in d["elements"]:
            k = (el["type"], el["id"])
            if k not in seen:
                seen.add(k)
                merged.append(el)
        time.sleep(3)
    return {**{k: v for k, v in first.items() if k != "elements"}, "elements": merged}


def fetch_box(box, used, depth=1):
    """A box from Overpass; if the servers fail on it, it is too heavy for them right now: split it in four. (The main
    server's gateway gives up after about 36 s, so a dense box has to be small enough to be answered in that time.)"""
    try:
        return overpass_box(box, used)
    except Exception as ex:  # noqa: BLE001
        if depth >= 3:
            raise
        say(f"   splitting box {tuple(round(v, 4) for v in box)} in four (depth {depth + 1}): {str(ex)[:90]}")
        return split_fetch(box, used, depth + 1)


def stage_fetch(refresh):
    PARTS_DIR.mkdir(parents=True, exist_ok=True)
    for r, c, box in grid_boxes():
        out = PARTS_DIR / f"part_{r}_{c}.json"
        if out.exists() and not refresh:
            say(f"skip (exists) {out.name}")
            continue
        t = time.time()
        used = set()
        data = split_fetch(box, used, 1)          # each part = four sub-queries (an 8 x 8 grid of queries in all)
        if not data.get("elements"):
            say(f"   WARNING {out.name}: no elements (water only?)")
        tmp = out.with_suffix(".json.part")
        tmp.write_text(json.dumps(data), encoding="utf-8")
        tmp.replace(out)
        FD.log("osm_overpass\\buildings_island\\" + out.name,
               f"{' + '.join(sorted(used))} (buildings query in tools/island_buildings.py, box w={box[0]:.4f} s={box[1]:.4f} e={box[2]:.4f} n={box[3]:.4f})",
               "OpenStreetMap contributors", "ODbL 1.0", out)
        say(f"ok {out.name}: {len(data.get('elements', []))} elements, {out.stat().st_size / 1e6:.1f} MB in {time.time() - t:.0f}s")
        time.sleep(5)


# The public Overpass servers were overloaded (HTTP 502/504 even for 1 km boxes, for the better part of an hour) when this
# was built, so the footprints can also come from a regional OSM extract: BBBike's Montreal extract (a weekly cut of the planet
# file, so the same OSM data Overpass serves), read with GDAL's OSM driver, which assembles multipolygon relations itself.
# Use it with --source pbf.
PBF = RAW / "osm_bbbike" / "Montreal.osm.pbf"
PBF_URL = "https://download.bbbike.org/osm/bbbike/Montreal/Montreal.osm.pbf"
PBF_BUILDINGS = BUILD / "bbbike_buildings.geojsonl"


def stage_fetch_pbf(refresh):
    FD.download("osm_bbbike/Montreal.osm.pbf", PBF_URL, "BBBike extract service (data: OpenStreetMap contributors)",
                "ODbL 1.0", refresh)
    if PBF_BUILDINGS.exists() and not refresh:
        say(f"skip (exists) {PBF_BUILDINGS.name}")
        return
    BUILD.mkdir(parents=True, exist_ok=True)
    t = time.time()
    tmp = PBF_BUILDINGS.with_name(PBF_BUILDINGS.name + ".part")
    w, s, e, n = ISLAND_BBOX
    env = dict(gdal_env(), GDAL_DATA=str(FD.QGIS_BIN.parent / "apps" / "gdal" / "share" / "gdal"))
    cmd = [str(FD.QGIS_BIN / "ogr2ogr.exe"), "-f", "GeoJSONSeq", str(tmp), str(PBF), "multipolygons",
           "-where", "building IS NOT NULL", "-spat", str(w), str(s), str(e), str(n), "-lco", "COORDINATE_PRECISION=7"]
    subprocess.run(cmd, check=True, env=env)
    tmp.replace(PBF_BUILDINGS)
    say(f"ok {PBF_BUILDINGS.name}: {PBF_BUILDINGS.stat().st_size / 1e6:.0f} MB in {time.time() - t:.0f}s")


# ------------------------------------------------------------------------------------------------ 2. island DSM at 5 m
def island_te():
    """The -te extent fetch_data.task_island uses (bounding box of the island bbox corners, in EPSG:32188, rounded)."""
    w, s, e, n = ISLAND_BBOX
    xs, ys = zip(*[TO_M.transform(lon, lat) for lon, lat in [(w, s), (w, n), (e, s), (e, n)]])
    return [str(round(v)) for v in (min(xs), min(ys), max(xs), max(ys))]


# The island bbox is covered by two LiDAR campaigns of the same NRCan product: CMM 2023 (about 61 % of the bbox: the east and
# centre, with the old study area) and CMM 2024 (about 39 %: the West Island, the north-west and the South Shore), with almost
# no overlap. Heights need both. (The 2024 DTM was cut by the elevation-tiles job into data/raw/nrcan_hrdem_cmm2024.)
HRDEM_2024 = RAW / "nrcan_hrdem_cmm2024"
DSM_URL = {2023: FD.DEM["dsm"], 2024: FD.DEM["dsm"].replace("CMM_2023", "CMM_2024")}
CAMPAIGN_DIR = {2023: HRDEM, 2024: HRDEM_2024}


def stage_dsm(refresh):
    for year in (2023, 2024):
        dsm = CAMPAIGN_DIR[year] / "dsm_island_32188_5m.tif"
        if dsm.exists() and not refresh:
            say(f"skip (exists) {dsm.parent.name}/{dsm.name}")
            continue
        dsm.parent.mkdir(parents=True, exist_ok=True)
        t = time.time()
        tmp = dsm.with_name("dsm_island_32188_5m.part.tif")
        cmd = [str(FD.QGIS_BIN / "gdalwarp.exe"), "-overwrite", "-t_srs", "EPSG:32188", "-te", *island_te(), "-tr", "5", "5",
               "-r", "average", "-multi", "-wo", "NUM_THREADS=ALL_CPUS", "-co", "COMPRESS=DEFLATE", "-co", "PREDICTOR=3",
               "-co", "TILED=YES", "-co", "BIGTIFF=IF_SAFER", "/vsicurl/" + DSM_URL[year], str(tmp)]
        subprocess.run(cmd, check=True, env=gdal_env())
        tmp.replace(dsm)
        FD.log(dsm.parent.name + "\\" + dsm.name, DSM_URL[year] + " (island bbox, averaged to 5 m)",
               f"NRCan HRDEM (CMM {year} LiDAR)", "Open Government Licence - Canada", dsm)
        say(f"ok {dsm.parent.name}/{dsm.name}: {dsm.stat().st_size / 1e6:.1f} MB in {time.time() - t:.0f}s")


# ------------------------------------------------------------------------------------------------ 3. footprints + heights
def way_polygon(el):
    c = [(p["lon"], p["lat"]) for p in el.get("geometry", [])]
    if len(c) >= 4 and c[0] == c[-1]:
        return Polygon(c)
    return None


def relation_polygon(el):
    """Outer rings minus inner rings of a multipolygon relation (same rules as build_layers.osm_polygons)."""
    outers, inners, outer_refs = [], [], []
    for m in el.get("members", []):
        if m.get("type") != "way" or "geometry" not in m or len(m["geometry"]) < 2:
            continue
        ls = LineString([(p["lon"], p["lat"]) for p in m["geometry"]])
        if m.get("role") == "inner":
            inners.append(ls)
        else:
            outers.append(ls)
            outer_refs.append(m["ref"])
    op = list(polygonize(unary_union(outers))) if outers else []
    if not op:
        return None, outer_refs
    g = unary_union(op)
    ip = list(polygonize(unary_union(inners))) if inners else []
    if ip:
        g = g.difference(unary_union(ip))
    return g, outer_refs


def polygons_only(g):
    """Polygon or MultiPolygon with just the polygonal parts of g (make_valid can add lines/points); None if nothing is left."""
    if g is None or g.is_empty:
        return None
    if g.geom_type == "Polygon":
        return g
    parts = [p for p in shapely.get_parts(g) if p.geom_type == "Polygon" and not p.is_empty]
    if not parts:
        return None
    return parts[0] if len(parts) == 1 else MultiPolygon(parts)


NUM = re.compile(r"\s*(\d+(?:[.,]\d+)?)")


def height_from_tags(t):
    """Explicit OSM height (m; "8m", "146 m", feet too) or building:levels (the layer_buildings rule: 3.2 m per level
    + 1 m; "2-4-6" and "8;11" read as the first number), else None."""
    h = NUM.match(str(t.get("height", "")))
    if h:
        v = float(h.group(1).replace(",", "."))
        if "ft" in str(t["height"]) or "'" in str(t["height"]):
            v *= 0.3048
        if v > 0:
            return v
    lv = NUM.match(str(t.get("building:levels", "")))
    if lv and float(lv.group(1).replace(",", ".")) > 0:
        return float(lv.group(1).replace(",", ".")) * 3.2 + 1.0
    return None


def load_footprints():
    """Read the Overpass parts, drop duplicates of the same OSM object (every box it touches returns it), build lon/lat
    polygons. Returns a list of (osm_type, osm_id, tags, geometry) + a stats dict."""
    st = collections.Counter()
    seen = set()
    recs = []
    outer_of_relation = set()      # way ids used as the outline of a building relation
    for p in sorted(PARTS_DIR.glob("part_*_*.json")):
        d = json.loads(p.read_text(encoding="utf-8"))
        st["elements_in_parts"] += len(d["elements"])
        for el in d["elements"]:
            key = (el["type"], el["id"])
            if key in seen:
                st["duplicate_in_second_box"] += 1
                continue
            seen.add(key)
            try:
                if el["type"] == "way":
                    g = way_polygon(el)
                else:
                    g, refs = relation_polygon(el)
                    if g is not None:
                        outer_of_relation.update(refs)
            except Exception:  # noqa: BLE001 - broken geometry, skip like build_layers does
                g = None
            if g is None:
                st["no_polygon_" + el["type"]] += 1
                continue
            st["polygon_from_" + el["type"]] += 1
            recs.append((el["type"], el["id"], el.get("tags", {}), g))
        del d
        say(f"   {p.name}: running total {len(recs)} outlines")
    st["unique_elements"] = len(seen)
    # a way that is also the outline of a building relation would be drawn twice (once without the relation's courtyards)
    keep = [r for r in recs if not (r[0] == "way" and r[1] in outer_of_relation)]
    st["way_is_outline_of_relation"] = len(recs) - len(keep)
    return keep, st


HSTORE = re.compile(r'"((?:[^"\\]|\\.)*)"=>"((?:[^"\\]|\\.)*)"')


def load_footprints_pbf():
    """Building polygons from the BBBike extract: the GDAL OSM driver's "multipolygons" layer (closed ways with a building
    tag, and multipolygon relations with their courtyards already cut out). Same return value as load_footprints()."""
    st = collections.Counter()
    recs = []
    with open(PBF_BUILDINGS, encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            ft = json.loads(line)
            p = ft["properties"]
            tags = dict(HSTORE.findall(p.get("other_tags") or ""))     # hstore text: "height"=>"12","building:levels"=>"3"
            tags["building"] = p.get("building")
            g = shape(ft["geometry"])
            if g.geom_type == "MultiPolygon" and len(g.geoms) == 1:
                g = g.geoms[0]
            kind = "relation" if p.get("osm_id") else "way"
            st["polygon_from_" + kind] += 1
            recs.append((kind, int(p.get("osm_id") or p["osm_way_id"]), tags, g))
    st["features_in_extract"] = len(recs)
    # a way that is also the outline of a building relation would be drawn twice; identical duplicate ways likewise
    kinds = np.array([r[0] for r in recs])
    geoms = np.array([r[3] for r in recs], dtype=object)

    def ring_keys(gs):
        return shapely.to_wkb(shapely.normalize(shapely.get_exterior_ring(gs)))

    is_way = kinds == "way"
    rel_keys = set(ring_keys(shapely.get_parts(geoms[~is_way])))
    way_idx = np.where(is_way)[0]
    drop = np.zeros(len(recs), dtype=bool)
    seen = set()
    for i, k in zip(way_idx, ring_keys(geoms[way_idx])):
        if k in rel_keys:
            drop[i] = True
            st["way_is_outline_of_relation"] += 1
        elif k in seen:
            drop[i] = True
            st["duplicate_way_geometry"] += 1
        else:
            seen.add(k)
    return [r for r, d in zip(recs, drop) if not d], st


def to_metres(geoms):
    return shapely.transform(geoms, lambda c: np.column_stack(TO_M.transform(c[:, 0], c[:, 1])))


def p70_by_id(ids, nd, n):
    """70th percentile and valid-pixel count of nd for building ids 1..n; the sort-based percentile of layer_buildings."""
    m = (ids > 0) & np.isfinite(nd)
    idv, v = ids[m], nd[m]
    order = np.lexsort((v, idv))
    idv, v = idv[order], v[order]
    uniq, start, counts = np.unique(idv, return_index=True, return_counts=True)
    p70 = np.full(n + 1, np.nan)
    cnt = np.zeros(n + 1, dtype=np.int64)
    p70[uniq] = v[start + np.minimum((counts * 0.7).astype(int), counts - 1)]
    cnt[uniq] = counts
    return p70[1:], cnt[1:]


def sample_at(arr, T, xs, ys):
    """Raster value under each point (NaN outside the raster)."""
    cols = np.floor((xs - T.c) / T.a).astype(np.int64)
    rows = np.floor((ys - T.f) / T.e).astype(np.int64)
    ok = (rows >= 0) & (rows < arr.shape[0]) & (cols >= 0) & (cols < arr.shape[1])
    out = np.full(len(xs), np.nan)
    out[ok] = arr[rows[ok], cols[ok]]
    return out


def read_nd(dsm_path, dtm_path):
    """DSM - DTM as float32 (NaN where either has no data) and the grid transform."""
    import rasterio
    with rasterio.open(dsm_path) as dsm, rasterio.open(dtm_path) as dtm:
        assert dsm.shape == dtm.shape and dsm.transform == dtm.transform, "DSM and DTM are not on the same grid"
        nd = dsm.read(1, masked=True).filled(np.nan).astype("float32")
        nd -= dtm.read(1, masked=True).filled(np.nan).astype("float32")
        return nd, dsm.transform


def lidar_heights(polys_m, layers, centroid_fallback):
    """DSM - DTM, 70th percentile over the pixels whose centre is inside each footprint (rasterize of building ids, as in
    layer_buildings). layers: [(name, dsm_path, dtm_path)] on one grid, in priority order: for each pixel the first layer
    that has a value is used. With centroid_fallback, a footprint with no valid pixel gets the value under its centroid.
    Returns (height, pixel count, index of the layer most of its pixels came from; -1 if none)."""
    from rasterio.features import rasterize
    nds, T = [], None
    for name, dsm_path, dtm_path in layers:
        nd, T2 = read_nd(dsm_path, dtm_path)
        assert T is None or T == T2, "layers are not on the same grid"
        T = T2
        nds.append(nd)
    merged = nds[0].copy()
    for nd in nds[1:]:
        np.copyto(merged, nd, where=~np.isfinite(merged))
    n_poly = len(polys_m)
    t = time.time()
    ids = rasterize(((p, i + 1) for i, p in enumerate(polys_m)), out_shape=merged.shape, transform=T, fill=0, dtype="int32")
    h, n = p70_by_id(ids, merged, n_poly)
    inside = ids > 0
    ids_in = ids[inside]
    per_layer = np.stack([np.bincount(ids_in[np.isfinite(nd[inside])], minlength=n_poly + 1)[1:] for nd in nds])
    del ids, inside, ids_in
    camp = np.where(per_layer.sum(axis=0) > 0, per_layer.argmax(axis=0), -1)
    n_centroid = 0
    if centroid_fallback:
        miss = np.where(n == 0)[0]
        if len(miss):
            c = shapely.get_coordinates(shapely.centroid(np.asarray(polys_m, dtype=object)[miss]))
            vals = np.stack([sample_at(nd, T, c[:, 0], c[:, 1]) for nd in nds])
            fin = np.isfinite(vals)
            first = np.where(fin.any(axis=0), fin.argmax(axis=0), -1)
            ok = first >= 0
            h[miss[ok]] = vals[first[ok], np.where(ok)[0]]
            n[miss[ok]] = 1
            camp[miss[ok]] = first[ok]
            n_centroid = int(ok.sum())
    del nds, merged
    say(f"   {len(layers)} layer(s): {n_poly} footprints in {time.time() - t:.0f}s; {int((n > 0).sum())} with a value "
        f"({n_centroid} from the centroid pixel); by layer {[int((camp == k).sum()) for k in range(len(layers))]}")
    return h, n, camp


SRC_NAMES = ["lidar_1m", "lidar_5m_2023", "lidar_5m_2024", "osm_tag", "default"]


def stage_heights(refresh):
    out = BUILD / "buildings.pkl"
    if out.exists() and not refresh:
        say(f"skip (exists) {out}")
        return
    BUILD.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    island_layers = [("cmm2023", HRDEM / "dsm_island_32188_5m.tif", HRDEM / "dtm_island_32188_5m.tif"),
                     ("cmm2024", HRDEM_2024 / "dsm_island_32188_5m.tif", HRDEM_2024 / "dtm_island_32188_5m.tif")]
    study_layers = [("cmm2023_1m", HRDEM / "dsm_study_area_32188_1m.tif", HRDEM / "dtm_study_area_32188_1m.tif")]
    for _, a, b in island_layers + study_layers:
        if not (a.exists() and b.exists()):
            raise SystemExit(f"missing raster: {a if not a.exists() else b} (run the dsm stage / the elevation-tiles job first)")
    if SOURCE == "pbf":
        if not PBF_BUILDINGS.exists():
            raise SystemExit(f"{PBF_BUILDINGS} is missing: run the fetch_pbf stage first")
        recs, stats = load_footprints_pbf()
    else:
        recs, stats = load_footprints()
    say(f"   {len(recs)} outlines after de-duplication ({dict(stats)})")
    ll = np.array([r[3] for r in recs], dtype=object)
    bad = ~shapely.is_valid(ll)
    stats["invalid_fixed"] = int(bad.sum())
    if bad.any():
        ll[bad] = shapely.make_valid(ll[bad])
        ll = np.array([polygons_only(g) for g in ll], dtype=object)
    keep = np.array([g is not None for g in ll])
    stats["empty_after_fix"] = int((~keep).sum())
    recs = [r for r, k in zip(recs, keep) if k]
    ll = ll[keep]
    m = to_metres(ll)
    area = shapely.area(m)
    big = area >= MIN_AREA_M2
    stats["under_%dm2" % MIN_AREA_M2] = int((~big).sum())
    recs = [r for r, k in zip(recs, big) if k]
    ll, m, area = ll[big], m[big], area[big]
    n = len(recs)
    say(f"   {n} building footprints of at least {MIN_AREA_M2:.0f} m2; parsing took {time.time() - t0:.0f}s")

    # ---- 5 m LiDAR for every footprint (CMM 2023, and CMM 2024 where 2023 has no data)
    h5, n5, camp5 = lidar_heights(m, island_layers, centroid_fallback=True)

    # ---- 1 m LiDAR (CMM 2023) for footprints whose centroid is inside the old study area
    cen = shapely.get_coordinates(shapely.centroid(ll))
    w, s, e, nn = STUDY_BBOX
    in_study = (cen[:, 0] >= w) & (cen[:, 0] <= e) & (cen[:, 1] >= s) & (cen[:, 1] <= nn)
    idx = np.where(in_study)[0]
    h1 = np.full(n, np.nan)
    n1 = np.zeros(n, dtype=np.int64)
    h1[idx], n1[idx], _ = lidar_heights(m[idx], study_layers, centroid_fallback=False)
    valid1 = in_study & (n1 >= LIDAR_MIN_PIXELS_1M) & (h1 >= LIDAR_MIN_H)
    valid5 = np.isfinite(h5) & (n5 > 0)
    tag_h = np.array([height_from_tags(r[2]) or np.nan for r in recs])
    has_tag = np.isfinite(tag_h)

    # Source order of preference:
    #   1. 1 m LiDAR (inside the old study area), 2. 5 m LiDAR of at least 2 m (CMM 2023, else CMM 2024),
    #   3. the OSM height / building:levels tag, 4. a low 5 m LiDAR value (under 2 m), which is clipped up to 2.5 m,
    #   5. 6 m.  The tag outranks a LiDAR value under 2 m because that reading is either a shed or garage whose roof the 5 m
    #   pixels dilute (checked against the 1 m data: their real height is 2-3 m, so the 2.5 m floor is right) or bare ground
    #   where the building did not exist yet when the LiDAR was flown; a tag knows about the second case.
    good5 = valid5 & (h5 >= LIDAR_MIN_H)
    sel1 = valid1
    sel5 = ~sel1 & good5
    sel_tag = ~sel1 & ~sel5 & has_tag
    sel_low = ~sel1 & ~sel5 & ~sel_tag & valid5
    height = np.full(n, H_DEFAULT)
    src = np.full(n, 4, dtype=np.uint8)
    height[sel_tag], src[sel_tag] = tag_h[sel_tag], 3
    height[sel_low], src[sel_low] = h5[sel_low], 1 + camp5[sel_low]
    height[sel5], src[sel5] = h5[sel5], 1 + camp5[sel5]
    height[sel1], src[sel1] = h1[sel1], 0
    height = np.round(np.clip(height, H_MIN, H_MAX), 1).astype("float32")
    stats["lidar_under_2m_used_as_floor"] = int(sel_low.sum())

    # ---- numbers for the report and for choosing thresholds
    stats["footprints"] = n
    stats["in_study_area"] = int(in_study.sum())
    stats["source_counts"] = {SRC_NAMES[k]: int((src == k).sum()) for k in range(len(SRC_NAMES))}
    both = valid1 & valid5
    if both.any():
        r = h5[both] / h1[both]
        stats["study_5m_vs_1m"] = {"n": int(both.sum()), "median_ratio_5m_over_1m": float(np.median(r)),
                                   "median_abs_diff_m": float(np.median(np.abs(h5[both] - h1[both]))),
                                   "median_diff_m": float(np.median(h5[both] - h1[both]))}
        for lo, hi in ((12, 40), (40, 100), (100, 250), (250, 1e9)):
            sel = both & (area >= lo) & (area < hi)
            if sel.any():
                stats["study_5m_vs_1m"][f"area_{lo}_{hi}"] = {"n": int(sel.sum()),
                                                              "median_ratio": float(np.median(h5[sel] / h1[sel])),
                                                              "median_diff_m": float(np.median(h5[sel] - h1[sel]))}
    stats["lidar5_below_2m"] = int((valid5 & (h5 < 2.0)).sum())
    stats["lidar5_below_1m"] = int((valid5 & (h5 < 1.0)).sum())
    stats["study_1m_invalid_rule"] = int((in_study & ~valid1).sum())
    stats["height_percentiles"] = {str(q): float(np.percentile(height, q)) for q in (1, 5, 25, 50, 75, 95, 99, 99.9)}
    # where do the defaults fall? (island = inside the 4 x 4 grid's land; here just by 0.05 degree cell for a quick look)
    dflt = src == 4
    if dflt.any():
        cells = collections.Counter((round(float(x) * 20) / 20, round(float(y) * 20) / 20) for x, y in cen[dflt])
        stats["default_height_top_cells_lon_lat"] = [[k[0], k[1], v] for k, v in cells.most_common(12)]
    say("   " + json.dumps(stats, indent=1))

    stats["footprint_source"] = ("BBBike Montreal.osm.pbf (OSM extract of 2026-10-24) read with GDAL's OSM driver"
                                 if SOURCE == "pbf" else "Overpass parts in data/raw/osm_overpass/buildings_island")
    data = {"osm_type": np.array([r[0] for r in recs]), "osm_id": np.array([r[1] for r in recs], dtype=np.int64),
            "wkb": [g.wkb for g in ll], "area_m2": area.astype("float32"), "h": height, "src": src,
            "src_names": SRC_NAMES, "stats": stats}
    with open(out, "wb") as f:
        pickle.dump(data, f, protocol=4)
    (BUILD / "heights_stats.json").write_text(json.dumps(stats, indent=1), encoding="utf-8")
    say(f"ok {out}: {n} buildings in {time.time() - t0:.0f}s")


# ------------------------------------------------------------------------------------------------ 4. vector tiles
EXTENT = 4096
BUFFER = 64            # tile units kept outside each tile edge, so extruded walls never show a seam
# zoom -> (smallest footprint kept in m2, simplification tolerance in tile units). A MapLibre tile is 512 px, so
# 8 units = 1 px and 4 units = half a pixel. z15 is the last zoom and gets over-zoomed to z18+, so it keeps a finer 2 units.
ZOOM_RULES = {13: (250.0, 4.0), 14: (40.0, 4.0), 15: (0.0, 2.0)}
MIN_PIECE_UNITS2 = 4.0  # a footprint, or a piece cut off by a tile edge, smaller than this (tile units squared) is a sliver
GZIP_LEVEL = 9


def world_xy(geoms_ll):
    """lon/lat -> Web Mercator, scaled to the 0..1 world square (x east, y SOUTH, like tile numbers)."""
    def f(c):
        x = (c[:, 0] + 180.0) / 360.0
        y = (1.0 - np.arcsinh(np.tan(np.radians(c[:, 1]))) / math.pi) / 2.0
        return np.column_stack([x, y])
    return shapely.transform(geoms_ll, f)


def varint_bytes(a):
    """Protobuf varints for a uint array: returns (bytes, bytes per value)."""
    a = np.asarray(a, dtype=np.uint64)
    nb = np.ones(len(a), dtype=np.int64)
    for k in range(1, 5):
        nb += (a >= (np.uint64(1) << np.uint64(7 * k)))
    ends = np.cumsum(nb)
    starts = ends - nb
    out = np.empty(int(ends[-1]) if len(a) else 0, dtype=np.uint8)
    for k in range(5):
        m = nb > k
        if not m.any():
            break
        byte = ((a[m] >> np.uint64(7 * k)) & np.uint64(0x7F)).astype(np.uint8)
        more = (nb[m] > k + 1).astype(np.uint8) << 7
        out[starts[m] + k] = byte | more
    return out.tobytes(), nb


def pb_varint(v):
    out = bytearray()
    while True:
        b = v & 0x7F
        v >>= 7
        if v:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def zigzag(v):
    v = v.astype(np.int64)
    return ((v << 1) ^ (v >> 63)).astype(np.uint64)


def encode_tile(parts, part_feat, feat_h, X0, Y0):
    """MVT bytes (not gzipped) for polygon parts given in global tile-unit coordinates.
    parts: Polygon array; part_feat: feature number (0..F-1, non-decreasing) of each part; feat_h: height of each feature."""
    import struct
    rings, ring_part = shapely.get_rings(parts, return_index=True)
    coords, ring_idx = shapely.get_coordinates(rings, return_index=True)
    ring_n = np.bincount(ring_idx, minlength=len(rings)) - 1                     # vertices without the closing one
    ring_end = np.cumsum(ring_n + 1)
    close = np.zeros(len(coords), dtype=bool)
    close[ring_end - 1] = True
    X = np.rint(coords[~close, 0] - X0).astype(np.int64)
    Y = np.rint(coords[~close, 1] - Y0).astype(np.int64)
    rid = np.repeat(np.arange(len(rings)), ring_n)
    r_start = np.cumsum(ring_n) - ring_n
    r_stop = r_start + ring_n
    is_ext = np.ones(len(rings), dtype=bool)
    is_ext[1:] = ring_part[1:] != ring_part[:-1]
    # orientation: MVT wants exterior rings with positive shoelace area in tile (y down) coordinates, holes negative
    xn, yn = np.roll(X, -1), np.roll(Y, -1)
    xn[r_stop - 1], yn[r_stop - 1] = X[r_start], Y[r_start]
    area2 = np.add.reduceat(X * yn - xn * Y, r_start)
    flip = np.where(is_ext, area2 < 0, area2 > 0)
    if flip.any():
        k = np.arange(len(X))
        perm = np.where(flip[rid], r_start[rid] + r_stop[rid] - 1 - k, k)
        X, Y = X[perm], Y[perm]
    # one delta stream per feature (cursor starts at 0,0 for each feature, carries over from ring to ring)
    feat_of_ring = part_feat[ring_part]
    feat_of_vtx = feat_of_ring[rid]
    first = np.ones(len(X), dtype=bool)
    first[1:] = feat_of_vtx[1:] != feat_of_vtx[:-1]
    px, py = np.roll(X, 1), np.roll(Y, 1)
    px[first], py[first] = 0, 0
    zx, zy = zigzag(X - px), zigzag(Y - py)
    # command stream: MoveTo(1) x y | LineTo(n-1) x y ... | ClosePath(1), per ring
    seg = 2 * ring_n + 3
    off = np.cumsum(seg) - seg
    G = np.zeros(int(seg.sum()), dtype=np.uint64)
    G[off] = 9
    G[off + 3] = 2 | ((ring_n - 1).astype(np.uint64) << np.uint64(3))
    G[off + 2 * ring_n + 2] = 15
    kloc = np.arange(len(X)) - r_start[rid]
    pos = off[rid] + np.where(kloc == 0, 1, 2 * kloc + 2)
    G[pos], G[pos + 1] = zx, zy
    enc, nb = varint_bytes(G)
    cum = np.concatenate([[0], np.cumsum(nb)])
    # byte range of each feature's geometry
    n_feat = int(part_feat.max()) + 1
    first_ring = np.searchsorted(feat_of_ring, np.arange(n_feat), side="left")
    last_ring = np.searchsorted(feat_of_ring, np.arange(n_feat), side="right")
    gs = cum[off[first_ring]]
    ge = cum[off[last_ring - 1] + seg[last_ring - 1]]
    # properties: one key ("h"), values de-duplicated per tile
    hv, hidx = np.unique(feat_h, return_inverse=True)
    layer = bytearray(b"\x0a\x09buildings")
    for f in range(n_feat):
        geom = enc[gs[f]:ge[f]]
        tags = b"\x00" + pb_varint(int(hidx[f]))
        fb = b"\x12" + pb_varint(len(tags)) + tags + b"\x18\x03\x22" + pb_varint(len(geom)) + geom
        layer += b"\x12" + pb_varint(len(fb)) + fb
    layer += b"\x1a\x01h"
    for v in hv:
        layer += b"\x22\x09\x19" + struct.pack("<d", float(v))
    layer += b"\x28" + pb_varint(EXTENT) + b"\x78\x02"
    return b"\x1a" + pb_varint(len(layer)) + bytes(layer)


def build_zoom(z, wgeo, area, h, stats):
    """All tiles of one zoom: {(x, y): gzipped MVT}."""
    min_area, tol = ZOOM_RULES[z]
    t = time.time()
    scale = (2 ** z) * EXTENT
    sel = np.where(area >= min_area)[0]
    g = shapely.transform(wgeo[sel], lambda c: c * scale)
    g = shapely.simplify(g, tol)
    # no set_precision here: it would stamp a 1-unit precision model on g, and GEOS then treats the set_precision after
    # the clip as "already at that precision" and returns the dirty clip output unchanged (self-touching rings)
    ok = (~shapely.is_empty(g)) & (shapely.area(g) >= MIN_PIECE_UNITS2)
    sel, g = sel[ok], g[ok]
    hz = np.round(h[sel].astype(np.float64), 1)
    say(f"   z{z}: {len(sel)} footprints (>= {min_area:g} m2), simplified at {tol:g} units in {time.time() - t:.0f}s")
    tree = shapely.STRtree(g)
    bx = shapely.bounds(g)
    n_tiles = 2 ** z
    tx0, tx1 = int(bx[:, 0].min() // EXTENT), int(bx[:, 2].max() // EXTENT)
    ty0, ty1 = int(bx[:, 1].min() // EXTENT), int(bx[:, 3].max() // EXTENT)
    tiles, nfeat, nbytes_raw = {}, 0, 0
    for x in range(tx0, tx1 + 1):
        for y in range(ty0, ty1 + 1):
            X0, Y0 = x * EXTENT, y * EXTENT
            xa, ya, xb, yb = X0 - BUFFER, Y0 - BUFFER, X0 + EXTENT + BUFFER, Y0 + EXTENT + BUFFER
            idx = tree.query(shapely.box(xa, ya, xb, yb))
            if len(idx) == 0:
                continue
            idx = np.sort(idx)
            c = shapely.clip_by_rect(g[idx], xa, ya, xb, yb)
            c = shapely.set_precision(c, 1.0)
            parts, owner = shapely.get_parts(c, return_index=True)
            keep = (shapely.get_type_id(parts) == 3) & (shapely.area(parts) >= MIN_PIECE_UNITS2)
            keep[keep] = shapely.get_num_points(shapely.get_exterior_ring(parts[keep])) >= 4     # a ring needs 3 vertices
            if not keep.any():
                continue
            parts, owner = parts[keep], owner[keep]
            used, feat_no = np.unique(owner, return_inverse=True)
            raw = encode_tile(parts, feat_no, hz[idx[used]], X0, Y0)
            tiles[(x, y)] = gzip.compress(raw, compresslevel=GZIP_LEVEL, mtime=0)
            nfeat += len(used)
            nbytes_raw += len(raw)
    stats[z] = {"tiles": len(tiles), "features": nfeat, "buildings": len(sel), "mb_gzip": sum(map(len, tiles.values())) / 1e6,
                "mb_raw": nbytes_raw / 1e6}
    say(f"   z{z}: {len(tiles)} tiles, {nfeat} tile-features, {stats[z]['mb_gzip']:.1f} MB gzipped ({stats[z]['mb_raw']:.1f} MB raw), "
        f"{time.time() - t:.0f}s")
    return tiles


def stage_tiles(refresh):
    from pmtiles.tile import Compression, TileType, zxy_to_tileid
    from pmtiles.writer import Writer
    src = BUILD / "buildings.pkl"
    t0 = time.time()
    with open(src, "rb") as f:
        d = pickle.load(f)
    geoms = shapely.from_wkb(np.array(d["wkb"], dtype=object))
    n = len(geoms)
    say(f"   {n} buildings loaded")
    wgeo = world_xy(geoms)
    lonlat_bounds = shapely.bounds(geoms)
    all_tiles, stats = {}, {}
    for z in sorted(ZOOM_RULES):
        for (x, y), data in build_zoom(z, wgeo, d["area_m2"], d["h"], stats).items():
            all_tiles[zxy_to_tileid(z, x, y)] = data
    w, s = float(lonlat_bounds[:, 0].min()), float(lonlat_bounds[:, 1].min())
    e, nn = float(lonlat_bounds[:, 2].max()), float(lonlat_bounds[:, 3].max())
    bounds = [math.floor(w * 1e4) / 1e4, math.floor(s * 1e4) / 1e4, math.ceil(e * 1e4) / 1e4, math.ceil(nn * 1e4) / 1e4]
    center = [round((bounds[0] + bounds[2]) / 2, 4), round((bounds[1] + bounds[3]) / 2, 4), 13]
    meta = {"name": "Piste buildings",
            "description": "Island of Montreal building footprints with heights (metres, property h).",
            # the brief said "CMM 2023"; the West Island, north-west and South Shore heights come from the CMM 2024 campaign
            "attribution": "© OpenStreetMap contributors (ODbL); heights NRCan HRDEM CMM 2023 and CMM 2024 (OGL-Canada)",
            "version": "1", "type": "overlay", "format": "pbf", "minzoom": min(ZOOM_RULES), "maxzoom": max(ZOOM_RULES),
            "bounds": bounds, "center": center,
            "vector_layers": [{"id": "buildings", "description": "OSM building footprints; h = height in metres",
                               "minzoom": min(ZOOM_RULES), "maxzoom": max(ZOOM_RULES), "fields": {"h": "Number"}}],
            "generator": "tools/island_buildings.py"}
    header = {"tile_type": TileType.MVT, "tile_compression": Compression.GZIP,
              "min_lon_e7": round(bounds[0] * 1e7), "min_lat_e7": round(bounds[1] * 1e7),
              "max_lon_e7": round(bounds[2] * 1e7), "max_lat_e7": round(bounds[3] * 1e7),
              "center_zoom": center[2], "center_lon_e7": round(center[0] * 1e7), "center_lat_e7": round(center[1] * 1e7)}
    tmp = BUILD / "buildings.pmtiles.tmp"
    with open(tmp, "wb") as f:
        wr = Writer(f)
        for tid in sorted(all_tiles):
            wr.write_tile(tid, all_tiles[tid])
        wr.finalize(header, meta)
    TILES_OUT.parent.mkdir(parents=True, exist_ok=True)
    os.replace(tmp, TILES_OUT)
    size = TILES_OUT.stat().st_size
    stats["file_mb"] = size / 1e6
    stats["buildings"] = n
    (BUILD / "tiles_stats.json").write_text(json.dumps(stats, indent=1, default=str), encoding="utf-8")
    say(f"ok {TILES_OUT}: {size / 1e6:.1f} MB, {len(all_tiles)} tiles, {time.time() - t0:.0f}s")
    if size > 90e6:
        say("   WARNING: over 90 MB; raise the z13/z14 area thresholds or simplify more")


# ------------------------------------------------------------------------------------------------ 5. read-back checks
def pb_fields(b):
    i = 0
    while i < len(b):
        k = 0
        s = 0
        while True:
            c = b[i]
            i += 1
            k |= (c & 0x7F) << s
            s += 7
            if not c & 0x80:
                break
        f, wt = k >> 3, k & 7
        if wt == 0:
            v, s = 0, 0
            while True:
                c = b[i]
                i += 1
                v |= (c & 0x7F) << s
                s += 7
                if not c & 0x80:
                    break
        elif wt == 1:
            v = b[i:i + 8]
            i += 8
        elif wt == 2:
            n, s = 0, 0
            while True:
                c = b[i]
                i += 1
                n |= (c & 0x7F) << s
                s += 7
                if not c & 0x80:
                    break
            v = b[i:i + n]
            i += n
        elif wt == 5:
            v = b[i:i + 4]
            i += 4
        else:
            raise ValueError(f"wire type {wt}")
        yield f, wt, v


def pb_packed(b):
    out, i = [], 0
    while i < len(b):
        v, s = 0, 0
        while True:
            c = b[i]
            i += 1
            v |= (c & 0x7F) << s
            s += 7
            if not c & 0x80:
                break
        out.append(v)
    return out


def decode_tile_strict(raw):
    """A small decoder written from the MVT spec (independent of the encoder and of mapbox_vector_tile): returns
    (layer name, extent, version, [(h, MultiPolygon)]). Exterior rings must have positive shoelace area (tile y down),
    holes negative, as the spec says."""
    import struct
    layer = [v for f, _, v in pb_fields(raw) if f == 3][0]
    keys, vals, feats, name, extent, version = [], [], [], None, None, None
    for f, wt, v in pb_fields(layer):
        if f == 1:
            name = v.decode()
        elif f == 2:
            feats.append(v)
        elif f == 3:
            keys.append(v.decode())
        elif f == 4:
            vals.append([struct.unpack("<d", vv)[0] for ff, _, vv in pb_fields(v) if ff == 3][0])
        elif f == 5:
            extent = v
        elif f == 15:
            version = v
    out = []
    for fb in feats:
        tags, gtype, geom = [], None, []
        for f, wt, v in pb_fields(fb):
            if f == 2:
                tags = pb_packed(v)
            elif f == 3:
                gtype = v
            elif f == 4:
                geom = pb_packed(v)
        assert gtype == 3, f"geometry type {gtype}"
        props = {keys[tags[i]]: vals[tags[i + 1]] for i in range(0, len(tags), 2)}
        rings, ring, x, y, i = [], None, 0, 0, 0
        while i < len(geom):
            cmd, cnt = geom[i] & 7, geom[i] >> 3
            i += 1
            if cmd in (1, 2):
                for _ in range(cnt):
                    dx, dy = geom[i], geom[i + 1]
                    i += 2
                    x += (dx >> 1) ^ -(dx & 1)
                    y += (dy >> 1) ^ -(dy & 1)
                    if cmd == 1:
                        ring = []
                        rings.append(ring)
                    ring.append((x, y))
            elif cmd != 7:
                raise ValueError(f"command {cmd}")
        polys = []
        for r in rings:
            assert len(r) >= 3
            a = sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(r, r[1:] + r[:1]))
            if a > 0:
                polys.append([r, []])
            elif a < 0:
                polys[-1][1].append(r)
            else:
                raise ValueError("zero-area ring")
        out.append((props["h"], MultiPolygon([Polygon(e, h) for e, h in polys])))
    return name, extent, version, out


def lonlat_tile(lon, lat, z):
    n = 2 ** z
    return int((lon + 180) / 360 * n), int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)


HEIGHT_RAMP = [(2.5, (255, 247, 188)), (6, (254, 217, 118)), (10, (254, 178, 76)), (20, (253, 141, 60)),
               (40, (240, 59, 32)), (80, (189, 0, 38)), (150, (100, 0, 70)), (250, (40, 0, 60))]


def height_colour(h):
    hs = [r[0] for r in HEIGHT_RAMP]
    return tuple(int(np.interp(h, hs, [r[1][c] for r in HEIGHT_RAMP])) for c in range(3))


def render_tile_png(feats, z, x, y, out_png, px=1600):
    """Footprints of one tile coloured by height (and a legend), written as a PNG."""
    from PIL import Image, ImageDraw
    k = px / EXTENT
    im = Image.new("RGB", (px, px), (238, 240, 243))
    d = ImageDraw.Draw(im)
    for ft in sorted(feats, key=lambda f: f["properties"]["h"]):        # tall ones on top
        col = height_colour(ft["properties"]["h"])
        g = ft["geometry"]
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        for rings in polys:
            d.polygon([(a * k, b * k) for a, b in rings[0]], fill=col, outline=(70, 70, 80))
            for hole in rings[1:]:
                d.polygon([(a * k, b * k) for a, b in hole], fill=(238, 240, 243), outline=(70, 70, 80))
    d.rectangle([8, 8, 330, 40 + 22 * len(HEIGHT_RAMP)], fill=(255, 255, 255), outline=(120, 120, 120))
    d.text((16, 14), f"tile z{z}/{x}/{y}: {len(feats)} buildings, colour = h (m)", fill=(0, 0, 0))
    for i, (hv, col) in enumerate(HEIGHT_RAMP):
        d.rectangle([16, 36 + 22 * i, 44, 52 + 22 * i], fill=col, outline=(70, 70, 80))
        d.text((54, 38 + 22 * i), f"{hv:g} m", fill=(0, 0, 0))
    out_png.parent.mkdir(parents=True, exist_ok=True)
    im.save(out_png)


def stage_check(refresh):
    import mapbox_vector_tile
    from pmtiles.reader import MmapSource, Reader, all_tiles
    from shapely.geometry import shape
    t0 = time.time()
    with open(TILES_OUT, "rb") as f:
        src = MmapSource(f)
        rd = Reader(src)
        hd = rd.header()
        say(f"header: {({k: (v.name if hasattr(v, 'name') else v) for k, v in hd.items() if not k.endswith('_offset') and not k.endswith('_length')})}")
        say(f"metadata: {json.dumps(rd.metadata(), ensure_ascii=True)}")
        say(f"file size {TILES_OUT.stat().st_size / 1e6:.1f} MB")

        # -- three places at z15
        places = {"downtown (-73.567, 45.501)": (-73.567, 45.501), "Plateau (-73.58, 45.52)": (-73.58, 45.52),
                  "Lachine (-73.67, 45.43)": (-73.67, 45.43)}
        for label, (lon, lat) in places.items():
            x, y = lonlat_tile(lon, lat, 15)
            raw = rd.get(15, x, y)
            if raw is None:
                say(f"-- z15/{x}/{y} {label}: NO TILE in the archive")
                continue
            dec = mapbox_vector_tile.decode(gzip.decompress(raw), default_options={"y_coord_down": True})["buildings"]
            feats = dec["features"]
            hs = np.array([ft["properties"]["h"] for ft in feats])
            types = collections.Counter(ft["geometry"]["type"] for ft in feats)
            say(f"-- z15/{x}/{y} {label}: {len(feats)} features {dict(types)}, extent {dec['extent']}, {len(raw)} bytes gzipped")
            say(f"   h percentiles 5/25/50/75/95/100: {np.percentile(hs, [5, 25, 50, 75, 95, 100]).round(1).tolist()}; "
                f"first heights {hs[:12].tolist()}")
            tall = sorted(feats, key=lambda f: -f["properties"]["h"])[:5]
            for ft in tall:
                c = shape(ft["geometry"]).centroid
                n = 2 ** 15
                lo = (x + c.x / EXTENT) / n * 360 - 180
                la = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + c.y / EXTENT) / n))))
                say(f"   tall: h={ft['properties']['h']} at lon {lo:.5f} lat {la:.5f}, area {shape(ft['geometry']).area * ((40075016.686 * math.cos(math.radians(la)) / (n * EXTENT)) ** 2):.0f} m2")
            if label.startswith("downtown"):
                render_tile_png(feats, 15, x, y, SCRATCH / "buildings_check" / f"z15_{x}_{y}_downtown.png")
                say(f"   rendered {SCRATCH / 'buildings_check' / f'z15_{x}_{y}_downtown.png'}")
            if label.startswith("Plateau"):
                render_tile_png(feats, 15, x, y, SCRATCH / "buildings_check" / f"z15_{x}_{y}_plateau.png")

        # -- every tile, every feature: decode with the spec-following decoder and check validity
        counts, bad, n_feat = collections.Counter(), collections.Counter(), collections.Counter()
        hmin, hmax = 1e9, -1e9
        for (z, x, y), data in all_tiles(src):
            counts[z] += 1
            name, extent, version, feats = decode_tile_strict(gzip.decompress(data))
            assert name == "buildings" and extent == EXTENT and version == 2
            for h, mp in feats:
                n_feat[z] += 1
                hmin, hmax = min(hmin, h), max(hmax, h)
                if not mp.is_valid or mp.is_empty:
                    bad[z] += 1
        say(f"tiles per zoom {dict(sorted(counts.items()))}, tile-features per zoom {dict(sorted(n_feat.items()))}, "
            f"invalid {dict(bad) or 0}, h range {hmin}..{hmax}")
    say(f"check done in {time.time() - t0:.0f}s")


STAGES = {"fetch": stage_fetch, "fetch_pbf": stage_fetch_pbf, "dsm": stage_dsm, "heights": stage_heights,
          "tiles": stage_tiles, "check": stage_check}
SOURCE = "overpass"        # footprint source for the heights stage: "overpass" (parts) or "pbf" (BBBike extract)

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("stage", choices=[*STAGES, "all"])
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--source", choices=["overpass", "pbf"], default="overpass",
                    help="where the footprints come from: the Overpass parts, or the BBBike extract (fetch_pbf stage)")
    a = ap.parse_args()
    SOURCE = a.source
    skip = "fetch" if SOURCE == "pbf" else "fetch_pbf"
    for name in ([n for n in STAGES if n != skip] if a.stage == "all" else [a.stage]):
        say(f"== {name}")
        STAGES[name](a.refresh)
