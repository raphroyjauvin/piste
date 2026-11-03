"""Tree positions for the app's 3D view, from the LiDAR canopy: tree tops found in the NRCan HRDEM canopy height, one point per
top, written to prototypes/shared/tiles/trees.pmtiles (z15 and z16). The app draws each point as an upright illustrated tree.

  canopy height  = LiDAR surface (DSM) - ground (DTM), NRCan HRDEM CMM 2023, 1 m (data/raw/nrcan_hrdem_cmm2023/*_study_area_32188_1m.tif)
  tree mask      = the City's Canopée 2019 polygons (CC BY 4.0), minus the building footprints (data/build/island_buildings/buildings.pkl)
  tree top       = a local maximum of the canopy height (3 x 3 smoothed) in a 5 m window, at least 3 m tall, inside the mask

Area: the 1 m LiDAR cut of the study area (Plateau, Mont-Royal, Outremont, Rosemont, Villeray, downtown: build_layers.BBOX). The island has
only the 5 m models, too coarse for single trees; to extend the trees, cut 1 m DSM/DTM windows (see fetch_data.task_dem) and add them to AREAS.

  C:\\bikeapp\\.venv\\Scripts\\python.exe -I C:\\bikeapp\\tools\\island_trees.py all      (stages: fetch, trees, tiles; each re-runs with --refresh)

Tiles: one point layer "trees" (h = tree height in m, s = 0-255 seed that picks the picture, stable per place). A tile keeps its 4,000 (z15)
or 6,000 (z16) tallest trees. Credit: NRCan HRDEM (OGL-Canada), Ville de Montréal Canopée (CC BY 4.0).
"""
import argparse
import gzip
import json
import math
import os
import pickle
import subprocess
import sys
import time
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))   # python -I does not add the script folder

import numpy as np
import rasterio
import shapely
from pyproj import Transformer
from rasterio import features
from rasterio.windows import Window

import fetch_data as FD
import island_buildings as IB

RAW, ROOT = FD.RAW, FD.ROOT
HRDEM = RAW / "nrcan_hrdem_cmm2023"
CANOPEE = RAW / "mtl_canopee" / "canope-2019.zip"
CANOPEE_URL = "https://donnees.montreal.ca/dataset/36f48854-474b-43d2-a16d-a433da8a1447/resource/83fa1279-5947-4e37-9d3e-aac775c485d0/download/canope-2019.zip"
BUILD = ROOT / "data" / "build" / "trees"
TILES_OUT = ROOT / "prototypes" / "shared" / "tiles" / "trees.pmtiles"
DSM, DTM = HRDEM / "dsm_study_area_32188_1m.tif", HRDEM / "dtm_study_area_32188_1m.tif"

MIN_H, WINDOW_R = 3.0, 2            # a tree is at least 3 m tall; a top is the highest point within 2 px (a 5 m window at 1 m)
BLOCK, MARGIN = 2000, 8             # pixels processed at a time, and the overlap that keeps tops at block edges right
TILE_CAP = {15: 4000, 16: 6000}     # trees kept per tile (the tallest)
HALF = 20037508.342789244           # half the Web Mercator world, m
TO_LL = Transformer.from_crs("EPSG:32188", "EPSG:4326", always_xy=True)


def say(*a):
    print(*a, flush=True)


# ------------------------------------------------------------------------------------------------ 1. the canopy polygons
def stage_fetch(refresh):
    if CANOPEE.exists() and not refresh:
        say(f"skip (exists) {CANOPEE.name}")
        return
    FD.download("mtl_canopee/canope-2019.zip", CANOPEE_URL, "Ville de Montreal (donnees.montreal.ca), Canopee 2019", "CC BY 4.0", True)


def canopy_polygons(bounds):
    """The Canopée polygons inside `bounds` (EPSG:32188), as a list of shapely geometries, via ogr2ogr."""
    shp = next(n for n in zipfile.ZipFile(CANOPEE).namelist() if n.lower().endswith(".shp"))
    out = BUILD / "canopee_area.geojson"
    BUILD.mkdir(parents=True, exist_ok=True)
    out.unlink(missing_ok=True)   # a build file of ours; ogr2ogr will not write over an existing GeoJSON
    cmd = [str(FD.QGIS_BIN / "ogr2ogr.exe"), "-f", "GeoJSON", str(out), f"/vsizip/{CANOPEE}/{shp}", "-t_srs", "EPSG:32188",
           "-spat_srs", "EPSG:32188", "-spat", *map(str, bounds), "-nlt", "PROMOTE_TO_MULTI"]
    subprocess.run(cmd, check=True, env=IB.gdal_env())
    feats = json.loads(out.read_text(encoding="utf-8"))["features"]
    return [shapely.geometry.shape(f["geometry"]) for f in feats if f["geometry"]]


def building_polygons(bounds):
    """Building footprints in EPSG:32188 inside `bounds`, grown by 1 m (a roof edge is not a crown)."""
    with open(IB.BUILD / "buildings.pkl", "rb") as f:
        geoms = shapely.from_wkb(np.array(pickle.load(f)["wkb"], dtype=object))
    g = shapely.transform(geoms, lambda c: np.column_stack(IB.TO_M.transform(c[:, 0], c[:, 1])))
    g = g[shapely.intersects(g, shapely.box(*bounds))]
    return list(shapely.buffer(g, 1.0))


# ------------------------------------------------------------------------------------------------ 2. tree tops
def box3(a):
    p = np.pad(a, 1, mode="edge")
    return sum(p[i:i + a.shape[0], j:j + a.shape[1]] for i in range(3) for j in range(3)) / 9.0


def local_max(a, r):
    """The highest value within r pixels (a square window), as two 1-D passes."""
    for axis in (0, 1):
        p = np.pad(a, [(r, r) if k == axis else (0, 0) for k in range(2)], constant_values=-1)
        n = a.shape[axis]
        a = np.maximum.reduce([np.take(p, range(d, d + n), axis=axis) for d in range(2 * r + 1)])
    return a


def rasterize(polys, window_transform, shape):
    if not polys:
        return np.zeros(shape, dtype=bool)
    return features.rasterize([(g, 1) for g in polys], out_shape=shape, transform=window_transform, fill=0, dtype="uint8").astype(bool)


def stage_trees(refresh):
    out = BUILD / "trees.npz"
    if out.exists() and not refresh:
        say(f"skip (exists) {out.name}")
        return
    t0 = time.time()
    dsm, dtm = rasterio.open(DSM), rasterio.open(DTM)
    assert dsm.shape == dtm.shape and dsm.transform == dtm.transform, "DSM and DTM are not on the same grid"
    H, W = dsm.shape
    b = dsm.bounds
    canopy_geoms = canopy_polygons((b.left, b.bottom, b.right, b.top))
    bld_geoms = building_polygons((b.left, b.bottom, b.right, b.top))
    canopy, bld = shapely.STRtree(canopy_geoms), shapely.STRtree(bld_geoms)
    say(f"   {len(canopy_geoms)} canopy polygons, {len(bld_geoms)} buildings in the area")
    X, Y, Hs, S = [], [], [], []
    for r0 in range(0, H, BLOCK):
        for c0 in range(0, W, BLOCK):
            ra, ca = max(0, r0 - MARGIN), max(0, c0 - MARGIN)
            rb, cb = min(H, r0 + BLOCK + MARGIN), min(W, c0 + BLOCK + MARGIN)
            win = Window(ca, ra, cb - ca, rb - ra)
            s, g = dsm.read(1, window=win, masked=True), dtm.read(1, window=win, masked=True)
            chm = np.clip((s - g).filled(0), 0, 60).astype(np.float32)
            tf = dsm.window_transform(win)
            box = shapely.box(*rasterio.windows.bounds(win, dsm.transform))
            mask = rasterize([canopy_geoms[i] for i in canopy.query(box)], tf, chm.shape) & ~rasterize([bld_geoms[i] for i in bld.query(box)], tf, chm.shape)
            rr, cc = np.mgrid[ra:rb, ca:cb]
            jitter = (((rr * 73856093) ^ (cc * 19349663)) % 1000) * 1e-5            # breaks ties between equal heights the same way every run
            sm = box3(chm) + jitter
            top = (sm >= local_max(sm, WINDOW_R)) & (sm >= MIN_H) & mask
            top[: r0 - ra] = False; top[r0 - ra + BLOCK:] = False                    # only this block's own area (the margin is for the window)
            top[:, : c0 - ca] = False; top[:, c0 - ca + BLOCK:] = False
            ri, ci = np.nonzero(top)
            if not len(ri):
                continue
            height = local_max(chm, 1)[ri, ci]
            gr, gc = ri + ra, ci + ca
            X.append(dsm.transform.c + (gc + 0.5) * dsm.transform.a); Y.append(dsm.transform.f + (gr + 0.5) * dsm.transform.e)
            Hs.append(height); S.append(((gr * 73856093) ^ (gc * 19349663)) & 255)
        say(f"   rows {r0}-{min(H, r0 + BLOCK)}: {sum(len(x) for x in X)} trees so far")
    x, y, h, s = (np.concatenate(v) for v in (X, Y, Hs, S))
    keep = h >= MIN_H
    BUILD.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(out, x=x[keep], y=y[keep], h=h[keep].astype(np.float32), s=s[keep].astype(np.uint8))
    say(f"ok {out.name}: {int(keep.sum())} trees in {time.time() - t0:.0f}s, median height {np.median(h[keep]):.1f} m, 95th {np.percentile(h[keep], 95):.1f} m")


# ------------------------------------------------------------------------------------------------ 3. tiles
def to_mercator(x, y):
    lon, lat = TO_LL.transform(x, y)
    return np.radians(lon) * 6378137.0, np.log(np.tan(math.pi / 4 + np.radians(lat) / 2)) * 6378137.0, 1.0 / np.cos(np.radians(lat))


def stage_tiles(refresh):
    import mapbox_vector_tile
    from pmtiles.tile import Compression, TileType, zxy_to_tileid
    from pmtiles.writer import Writer
    t0 = time.time()
    d = np.load(BUILD / "trees.npz")
    mx, my, _ = to_mercator(d["x"], d["y"])
    h, s = d["h"].astype(np.float64), d["s"]
    pts = shapely.points(mx, my)
    tiles = {}
    for z in sorted(TILE_CAP):
        size = 2 * HALF / 2 ** z
        tx, ty = np.floor((mx + HALF) / size).astype(np.int64), np.floor((HALF - my) / size).astype(np.int64)   # a tree sits in one tile; icons are not clipped
        order = np.lexsort((-h, ty, tx))                                                                          # by tile, tallest first
        key = tx[order] * 1_000_000 + ty[order]
        groups = np.split(order, np.flatnonzero(np.diff(key)) + 1)
        n_trees = 0
        for grp in groups:
            idx = grp[: TILE_CAP[z]]
            x0, y0 = int(tx[idx[0]]), int(ty[idx[0]])
            bounds = (-HALF + x0 * size, HALF - (y0 + 1) * size, -HALF + (x0 + 1) * size, HALF - y0 * size)
            layer = {"name": "trees", "features": [{"geometry": pts[i], "properties": {"h": round(float(h[i]), 1), "s": int(s[i])}} for i in idx]}
            raw = mapbox_vector_tile.encode([layer], default_options={"quantize_bounds": bounds, "y_coord_down": False, "extents": 4096})
            tiles[zxy_to_tileid(z, x0, y0)] = gzip.compress(raw, compresslevel=9, mtime=0)
            n_trees += len(idx)
        say(f"   z{z}: {len(groups)} tiles, {n_trees} trees, {sum(map(len, tiles.values())) / 1e6:.1f} MB so far, {time.time() - t0:.0f}s")
    lon0, lat0 = TO_LL.transform(d["x"].min(), d["y"].min())
    lon1, lat1 = TO_LL.transform(d["x"].max(), d["y"].max())
    bounds = [round(lon0, 4), round(lat0, 4), round(lon1, 4), round(lat1, 4)]
    meta = {"name": "Piste trees", "description": "Tree tops from the NRCan HRDEM canopy height inside the City's Canopee 2019 (h = height in m, s = picture seed)",
            "attribution": "NRCan HRDEM CMM 2023 (OGL-Canada); Canopée 2019, Ville de Montréal (CC BY 4.0)", "version": "1", "type": "overlay", "format": "pbf",
            "minzoom": min(TILE_CAP), "maxzoom": max(TILE_CAP), "bounds": bounds, "center": [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2, 15],
            "vector_layers": [{"id": "trees", "fields": {"h": "Number", "s": "Number"}, "minzoom": 15, "maxzoom": 16}],
            "generator": "tools/island_trees.py"}
    header = {"tile_type": TileType.MVT, "tile_compression": Compression.GZIP, "center_zoom": 15,
              "min_lon_e7": round(bounds[0] * 1e7), "min_lat_e7": round(bounds[1] * 1e7), "max_lon_e7": round(bounds[2] * 1e7), "max_lat_e7": round(bounds[3] * 1e7),
              "center_lon_e7": round(meta["center"][0] * 1e7), "center_lat_e7": round(meta["center"][1] * 1e7)}
    tmp = TILES_OUT.with_suffix(".pmtiles.tmp")
    with open(tmp, "wb") as f:
        wr = Writer(f)
        for tid in sorted(tiles):
            wr.write_tile(tid, tiles[tid])
        wr.finalize(header, meta)
    os.replace(tmp, TILES_OUT)
    say(f"ok {TILES_OUT.name}: {TILES_OUT.stat().st_size / 1e6:.1f} MB, {len(tiles)} tiles, {time.time() - t0:.0f}s")


STAGES = {"fetch": stage_fetch, "trees": stage_trees, "tiles": stage_tiles}

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("stage", choices=[*STAGES, "all"])
    ap.add_argument("--refresh", action="store_true")
    a = ap.parse_args()
    for name in (STAGES if a.stage == "all" else [a.stage]):
        say(f"== {name}")
        STAGES[name](a.refresh)
