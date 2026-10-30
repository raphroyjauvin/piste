"""Island-wide map data for Piste (2026-10-29): hill shading + elevation tint as raster tiles, contours as vector tiles,
3D terrain tiles, POIs and the planned / works layer, all over the Island of Montreal bbox (fetch_data.ISLAND_BBOX).

    prototypes/shared/tiles/relief.pmtiles    hill shading, z10-14 (computed at z15 detail), WebP RGBA  (maths of build_layers.layer_hillshade)
    prototypes/shared/tiles/tint.pmtiles      elevation tint, z9-13, WebP RGBA (maths of build_layers.layer_tint)
    prototypes/shared/tiles/contours.pmtiles  contours, z11-15, MVT, source-layer "contours" (rules of layer_contours)
    prototypes/shared/terrain/{z}/{x}/{y}.png + data/terrain_index.js  Terrarium tiles z10-14 (layer_terrain)
    prototypes/shared/data/pois.js, planned.js  island-wide, same format as layer_pois / layer_planned

The study-area scripts (build_layers.py, fetch_data.py) are imported, not edited: the island versions reuse their
gaussian_smooth, edge_feather, TINT_RAMP, kind() rules, round_geom, write_js, download helpers and logging.

Usage: C:\\bikeapp\\.venv\\Scripts\\python.exe -I C:\\bikeapp\\tools\\island_tiles.py <task> [task ...]     ("all" runs every task in order)
Tasks (in the order they are normally run):
    dem            cut the CMM 2024 LiDAR terrain (the 2023 block misses ~39% of the island bbox) and merge both
    pois_fetch     island Overpass downloads for the POIs (+ OSM bike lanes under construction)
    planned_fetch  City live bike-network vector tiles for the island
    relief tint contours terrain pois planned    build one product each
    check          read tiles back from the .pmtiles files and save sample PNGs
"""
import collections
import csv
import gzip
import io
import json
import math
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))      # python -I does not put the script folder on sys.path

import numpy as np
import rasterio
from pyproj import Transformer
from PIL import Image

import build_layers as bl
import fetch_data as fd

ROOT = bl.ROOT
RAW = bl.RAW
BUILD = bl.BUILD
DATA_OUT = bl.OUT                                  # prototypes/shared/data
SHARED = DATA_OUT.parent                           # prototypes/shared
TILES_OUT = SHARED / "tiles"
TERRAIN_OUT = SHARED / "terrain"
QGIS_BIN = bl.QGIS_BIN
ISLAND = fd.ISLAND_BBOX                            # (west, south, east, north), lon/lat
STUDY = bl.BBOX
SCRATCH = Path(os.environ.get("ISLAND_CHECK_DIR", BUILD / "tiles_check_parent"))   # `check` saves its sample PNGs in <this>/tiles_check

DTM_2023 = RAW / "nrcan_hrdem_cmm2023" / "dtm_island_32188_5m.tif"
DTM_2024 = RAW / "nrcan_hrdem_cmm2024" / "dtm_island_32188_5m.tif"
DTM_MERGED = BUILD / "dtm_island_5m_merged.tif"
ATTRIB_DEM = "NRCan HRDEM CMM 2023 + 2024 LiDAR (OGL-Canada)"

TO_MTM = Transformer.from_crs("EPSG:4326", "EPSG:32188", always_xy=True)
MERC_R = 6378137.0
MERC_HALF = math.pi * MERC_R                       # 20037508.342789244
MERC_PX0 = 2 * MERC_HALF / 256                     # Mercator metres per pixel at z0


def t0_log(msg, t0=[time.time()]):
    print(f"[{time.time() - t0[0]:7.1f}s] {msg}", flush=True)


# ---------------------------------------------------------------- tile maths (XYZ, Web Mercator)
def lon_to_px(lon, z):
    return (np.asarray(lon, dtype="float64") + 180.0) / 360.0 * 256 * 2 ** z


def lat_to_py(lat, z):
    lat = np.radians(np.asarray(lat, dtype="float64"))
    return (1 - np.arcsinh(np.tan(lat)) / math.pi) / 2 * 256 * 2 ** z


def tile_range(bbox, z, margin=0.0):
    """Inclusive (x0, x1, y0, y1) tile indices covering bbox (+ margin degrees)."""
    w, s, e, n = bbox
    n_t = 2 ** z
    x0 = int(math.floor(lon_to_px(w - margin, z) / 256)); x1 = int(math.floor(lon_to_px(e + margin, z) / 256))
    y0 = int(math.floor(lat_to_py(n + margin, z) / 256)); y1 = int(math.floor(lat_to_py(s - margin, z) / 256))
    return max(x0, 0), min(x1, n_t - 1), max(y0, 0), min(y1, n_t - 1)


def tile_bounds_m(z, x, y):
    """Web Mercator metre bounds (xmin, ymin, xmax, ymax) of a tile."""
    size = 2 * MERC_HALF / 2 ** z
    return (-MERC_HALF + x * size, MERC_HALF - (y + 1) * size, -MERC_HALF + (x + 1) * size, MERC_HALF - y * size)


def gdal_env(**extra):
    return dict(os.environ, PROJ_DATA=str(QGIS_BIN.parent / "share" / "proj"),
                PATH=str(QGIS_BIN) + os.pathsep + os.environ["PATH"], **extra)


class _FolderSize:
    """Lets fetch_data.log() record the total size of a folder of downloads (it only calls .stat().st_size)."""
    def __init__(self, n):
        self.n = n

    def stat(self):
        return self

    @property
    def st_size(self):
        return self.n


# ================================================================ downloads
def island_te():
    """Same -te as fetch_data.task_island, so every island DTM shares one 5 m grid."""
    w, s, e, n = ISLAND
    xs, ys = zip(*[TO_MTM.transform(lon, lat) for lon, lat in [(w, s), (w, n), (e, s), (e, n)]])
    return [str(round(v)) for v in (min(xs), min(ys), max(xs), max(ys))]


def task_dem(refresh=False):
    """The CMM 2023 LiDAR block only covers ~61% of the island bbox (a diagonal band plus the north); the 2024 block of
    the same programme covers the rest. Cut it exactly as fetch_data.task_island cut the 2023 one, then merge."""
    te = island_te()
    with rasterio.open(DTM_2023) as ds:
        # gdalwarp rounds the -te size to whole 5 m pixels, so compare the origin, not the far corner
        assert (ds.bounds.left, ds.bounds.top) == (float(te[0]), float(te[3])) and ds.res == (5.0, 5.0), "island DTM grid changed"
    if DTM_2024.exists() and not refresh:
        print(f"skip (exists) {DTM_2024.name}")
    else:
        DTM_2024.parent.mkdir(parents=True, exist_ok=True)
        env = gdal_env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_HTTP_MULTIRANGE="YES",
                       GDAL_HTTP_MERGE_CONSECUTIVE_RANGES="YES", VSI_CACHE="TRUE")
        url = "https://canelevation-dem.s3.ca-central-1.amazonaws.com/hrdem-lidar/QC-600023_52_CMM_2024-1m-dtm.tif"
        tmp = DTM_2024.with_suffix(".part.tif")
        t = time.time()
        subprocess.run([str(QGIS_BIN / "gdalwarp.exe"), "-overwrite", "-t_srs", "EPSG:32188", "-te", *te, "-tr", "5", "5",
                        "-r", "average", "-multi", "-wo", "NUM_THREADS=ALL_CPUS", "-co", "COMPRESS=DEFLATE", "-co", "PREDICTOR=3",
                        "-co", "TILED=YES", "-co", "BIGTIFF=IF_SAFER", "/vsicurl/" + url, str(tmp)], check=True, env=env)
        tmp.replace(DTM_2024)
        fd.log("nrcan_hrdem_cmm2024\\" + DTM_2024.name, url + " (island bbox, averaged to 5 m)", "NRCan HRDEM (CMM 2024 LiDAR)",
               "Open Government Licence - Canada", DTM_2024)
        print(f"ok {DTM_2024.name}: {DTM_2024.stat().st_size / 1e6:.1f} MB in {time.time() - t:.0f}s")
    merge_dtm()


def merge_dtm():
    """2023 where it has data, else 2024. Both are on the same 5 m grid. Written to data/build (derived, not raw)."""
    with rasterio.open(DTM_2023) as a, rasterio.open(DTM_2024) as b:
        assert a.transform == b.transform and a.shape == b.shape, "2023 and 2024 island DTM grids differ"
        prof = a.profile
        za = a.read(1, masked=True).filled(np.nan)
        zb = b.read(1, masked=True).filled(np.nan)
    both = np.isfinite(za) & np.isfinite(zb)
    print(f"  2023 valid {np.isfinite(za).mean():.3f}, 2024 valid {np.isfinite(zb).mean():.3f}, overlap {both.mean():.5f}")
    if both.any():
        d = (zb - za)[both]
        print(f"  overlap difference 2024-2023: mean {d.mean():.3f} m, median {np.median(d):.3f}, p5/p95 {np.percentile(d, 5):.2f}/{np.percentile(d, 95):.2f}")
    z = np.where(np.isfinite(za), za, zb)
    print(f"  merged valid fraction {np.isfinite(z).mean():.4f}")
    prof.update(nodata=-32767.0, compress="deflate", predictor=3, tiled=True, blockxsize=256, blockysize=256, BIGTIFF="IF_SAFER")
    BUILD.mkdir(parents=True, exist_ok=True)
    with rasterio.open(DTM_MERGED, "w", **prof) as out:
        out.write(np.where(np.isfinite(z), z, -32767.0).astype("float32"), 1)
    print(f"  wrote {DTM_MERGED.name}: {DTM_MERGED.stat().st_size / 1e6:.1f} MB")


# ---------------------------------------------------------------- OSM (Overpass) downloads for the POIs
def _overpass_island(query_for_bbox, bbox):
    """fetch_data.overpass() on the whole bbox; if the server answers with a runtime-error remark (a partial result),
    split the bbox in four and merge by (type, id)."""
    w, s, e, n = bbox
    data = fd.overpass(query_for_bbox(f"({s},{w},{n},{e})"))
    remark = data.get("remark", "")
    if not remark or "runtime error" not in remark.lower():
        return data
    print(f"   overpass remark: {remark}; splitting the bbox in four")
    mw, ms = (w + e) / 2, (s + n) / 2
    seen, elements = set(), []
    for bb in [(w, s, mw, ms), (mw, s, e, ms), (w, ms, mw, n), (mw, ms, e, n)]:
        part = fd.overpass(query_for_bbox(f"({bb[1]},{bb[0]},{bb[3]},{bb[2]})"))
        if "runtime error" in part.get("remark", "").lower():
            raise RuntimeError(part["remark"])
        for el in part["elements"]:
            if (el["type"], el["id"]) not in seen:
                seen.add((el["type"], el["id"]))
                elements.append(el)
        time.sleep(5)
    data["elements"] = elements
    data.pop("remark", None)
    return data


def _q_pois(bb):
    # same query as fetch_data.task_osm "osm_overpass/pois.json" (only the header's timeout / maxsize are raised for the island)
    return f"""[out:json][timeout:900][maxsize:1073741824];
(
  nwr["amenity"~"^(cafe|restaurant|fast_food|ice_cream|bar|pub|biergarten|bicycle_repair_station|bicycle_parking|drinking_water|toilets|bicycle_rental|compressed_air|library|marketplace)$"]{bb};
  nwr["shop"~"^(bicycle|bakery|coffee|deli|pastry|greengrocer|chocolate|confectionery)$"]{bb};
  nwr["leisure"~"^(park|garden)$"]["name"]{bb};
  nwr["tourism"~"^(viewpoint|museum|attraction)$"]{bb};
  nwr["railway"="station"]["station"="subway"]{bb};
  node["railway"="subway_entrance"]{bb};
);
out center tags;"""


def _q_shops(bb):
    # same query as fetch_data.task_osm "osm_overpass/shops.json"
    return f"""[out:json][timeout:900][maxsize:1073741824];
(
  nwr["shop"~"^(clothes|shoes|books|gift|boutique|second_hand|charity|music|musical_instrument|art|craft|frame|jewelry|department_store|mall|variety_store|florist|outdoor|sports|toys|games|stationery|antiques|interior_decoration|houseware|kitchen|furniture|garden_centre|cosmetics|perfumery|bag|fabric|sewing|hobby|photo|electronics|video_games|anime|comics|records|tea|wine|cheese|herbalist)$"]["name"]{bb};
);
out center tags;"""


def _q_construction(bb):
    # only what layer_planned reads out of bikeways.json (highway=construction + construction=cycleway), on the island
    return f"""[out:json][timeout:300];
(
  way["highway"="construction"]["construction"="cycleway"]{bb};
);
out geom tags;"""


def task_pois_fetch(refresh=False):
    jobs = {"pois_island.json": _q_pois, "shops_island.json": _q_shops, "bikeways_construction_island.json": _q_construction}
    for name, q in jobs.items():
        out = RAW / "osm_overpass" / name
        if out.exists() and not refresh:
            print(f"skip (exists) {name}")
            continue
        t = time.time()
        data = _overpass_island(q, ISLAND)
        out.write_text(json.dumps(data), encoding="utf-8")
        fd.log("osm_overpass\\" + name, fd.OVERPASS + " (query in tools/island_tiles.py, island bbox)", "OpenStreetMap contributors",
               "ODbL 1.0", out)
        print(f"ok {name}: {len(data.get('elements', []))} elements, {out.stat().st_size / 1e6:.1f} MB in {time.time() - t:.0f}s")
        time.sleep(5)


# ---------------------------------------------------------------- City live bike-network vector tiles
def task_planned_fetch(refresh=False, z=14):
    """fetch_data.task_mtl_tiles for the island bbox, into its own folder (same decoding)."""
    import mapbox_vector_tile

    out_dir = RAW / "mtl_live_tiles_island"
    if (out_dir / "pistes-cyclables.geojson").exists() and not refresh:
        print("skip (exists) mtl_live_tiles_island")
        return
    out_dir.mkdir(parents=True, exist_ok=True)
    w, s, e, n = ISLAND
    x0, y1 = fd.lonlat_to_tile(w, s, z)
    x1, y0 = fd.lonlat_to_tile(e, n, z)
    layers, count, empty, failed = {}, 0, 0, []
    t = time.time()
    for tx in range(x0, x1 + 1):
        for ty in range(y0, y1 + 1):
            data = None
            for attempt in range(4):
                try:
                    data = fd.get(fd.MTL_TILES.format(z=z, x=tx, y=ty), timeout=120)
                    break
                except urllib.error.HTTPError as ex:
                    if ex.code in (204, 404):
                        data = b""
                        break
                    time.sleep(3 * (attempt + 1))
                except Exception:  # noqa: BLE001 - transient network errors
                    time.sleep(3 * (attempt + 1))
            count += 1
            if data is None:
                failed.append((tx, ty))
                continue
            if not data:
                empty += 1
                continue
            dec = mapbox_vector_tile.decode(data, default_options={"y_coord_down": True})
            for lname, layer in dec.items():
                ext = layer.get("extent", 4096)
                feats = layers.setdefault(lname, [])
                for f in layer["features"]:
                    g = f["geometry"]

                    def conv(c, depth, tx=tx, ty=ty, ext=ext):
                        if depth == 0:
                            return fd.tile_px_to_lonlat(tx, ty, z, c[0], c[1], ext)
                        return [conv(cc, depth - 1) for cc in c]

                    depth = {"Point": 0, "LineString": 1, "MultiLineString": 2, "Polygon": 2,
                             "MultiPolygon": 3, "MultiPoint": 1}[g["type"]]
                    feats.append({"type": "Feature", "properties": f["properties"],
                                  "geometry": {"type": g["type"], "coordinates": conv(g["coordinates"], depth)}})
            time.sleep(0.2)
        print(f"  column {tx - x0 + 1}/{x1 - x0 + 1} done, {count} tiles, {time.time() - t:.0f}s", flush=True)
    if failed:
        raise RuntimeError(f"{len(failed)} tiles failed, e.g. {failed[:5]}; nothing written")
    for lname, feats in layers.items():
        out = out_dir / f"{lname}.geojson"
        out.write_text(json.dumps({"type": "FeatureCollection", "features": feats}), encoding="utf-8")
        fd.log(f"mtl_live_tiles_island\\{lname}.geojson", fd.MTL_TILES + f" (z{z}, island bbox)",
               "Ville de Montreal (api.montreal.ca vector tiles)", "Ville de Montreal open data (CC BY 4.0)", out)
        print(f"ok {lname}: {len(feats)} tile-pieces")
    print(f"tiles fetched: {count} ({empty} empty)")


# ================================================================ shared raster-tile machinery
def dtm_path():
    """The merged island DTM (2023 + 2024 LiDAR blocks) once it exists, else the 2023 block alone."""
    return DTM_MERGED if DTM_MERGED.exists() else DTM_2023


def warp_mercator(src, dst, z, tiles, resampling):
    """gdalwarp the DTM onto a Web Mercator grid whose pixels are exactly the XYZ tile pixels of zoom z
    (build_layers does the same on its own grid: -t_srs EPSG:3857, bilinear / average)."""
    tx0, tx1, ty0, ty1 = tiles
    res = MERC_PX0 / 2 ** z
    xmin, xmax = -MERC_HALF + tx0 * 256 * res, -MERC_HALF + (tx1 + 1) * 256 * res
    ymax, ymin = MERC_HALF - ty0 * 256 * res, MERC_HALF - (ty1 + 1) * 256 * res
    subprocess.run([str(QGIS_BIN / "gdalwarp.exe"), "-overwrite", "-t_srs", "EPSG:3857", "-te", repr(xmin), repr(ymin), repr(xmax), repr(ymax),
                    "-tr", repr(res), repr(res), "-r", resampling, "-multi", "-wo", "NUM_THREADS=ALL_CPUS", "-co", "COMPRESS=DEFLATE",
                    "-co", "PREDICTOR=3", "-co", "TILED=YES", "-co", "BIGTIFF=IF_SAFER", str(src), str(dst)],
                   check=True, env=gdal_env(), stdout=subprocess.DEVNULL)
    with rasterio.open(dst) as ds:
        a = ds.read(1)
        nd = ds.nodata
    if nd is not None:
        a[a == nd] = np.nan
    assert a.shape == ((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256), a.shape
    return a


def pad_block(a, r0, r1, c0, c1):
    """a[r0:r1, c0:c1] where the window may reach past the array: the outside is NaN (nothing there)."""
    out = np.full((r1 - r0, c1 - c0), np.nan, dtype="float32")
    ra, rb = max(r0, 0), min(r1, a.shape[0])
    ca, cb = max(c0, 0), min(c1, a.shape[1])
    if ra < rb and ca < cb:
        out[ra - r0:rb - r0, ca - c0:cb - c0] = a[ra:rb, ca:cb]
    return out


def bbox_rect_px(bbox, z):
    """The bbox as a pixel rectangle (col0, col1, row0, row1; end-exclusive) in global pixels of zoom z."""
    w, s, e, n = bbox
    return (int(math.floor(lon_to_px(w, z))), int(math.ceil(lon_to_px(e, z))),
            int(math.floor(lat_to_py(n, z))), int(math.ceil(lat_to_py(s, z))))


def feather_window(rows, cols, rect, px):
    """build_layers.edge_feather() for a raster that is exactly the bbox rectangle, evaluated on any window:
    0 at the bbox edge rising to 1 at px pixels in, 0 outside it. rows / cols are global pixel indices."""
    c0, c1, r0, r1 = rect
    dx = np.minimum(cols - c0, c1 - 1 - cols)
    dy = np.minimum(rows - r0, r1 - 1 - rows)
    return np.clip(np.minimum(dx[None, :], dy[:, None]) / px, 0, 1)


def hillshade_kernel(z, valid, cell, feather, zf=2.3, sigma_m=10.0):
    """Line for line build_layers.layer_hillshade, on an array already filled where invalid. Returns (lum, alpha) uint8."""
    z = bl.gaussian_smooth(z, sigma_m / cell)  # keep real relief, drop building-scale noise
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
    alpha = (np.where(valid, np.clip(alpha, 0, 255), 0) * feather).astype(np.uint8)
    return lum, alpha


def tint_kernel(z, valid, cell, feather, sigma_m=20.0):
    """Line for line build_layers.layer_tint (ramp + fade), on an array already filled where invalid. Returns RGBA uint8."""
    z = bl.gaussian_smooth(z, sigma_m / cell)
    zs = [s[0] for s in bl.TINT_RAMP]
    rgba = np.zeros(z.shape + (4,), dtype=np.uint8)
    for ch in range(4):
        rgba[..., ch] = np.interp(z, zs, [s[1][ch] for s in bl.TINT_RAMP]).astype(np.uint8)
    rgba[..., 3] = (np.where(valid, rgba[..., 3], 0) * feather).astype(np.uint8)
    return rgba


def process_blocks(a, z, tiles, rect, fade_px, cell, median, kernel, channels, block_tiles=8, overlap=32):
    """Run a per-pixel-neighbourhood kernel over the tile-aligned raster in blocks of block_tiles x block_tiles tiles with an
    overlap margin (>= 4 sigma, so the blocks join without seams). Returns {(x, y): uint8 array (256, 256, channels)} for the
    tiles that are not fully transparent."""
    tx0, tx1, ty0, ty1 = tiles
    nx, ny = tx1 - tx0 + 1, ty1 - ty0 + 1
    out = {}
    for by in range(0, ny, block_tiles):
        for bx in range(0, nx, block_tiles):
            r0, c0 = by * 256, bx * 256
            r1, c1 = min(r0 + block_tiles * 256, ny * 256), min(c0 + block_tiles * 256, nx * 256)
            blk = pad_block(a, r0 - overlap, r1 + overlap, c0 - overlap, c1 + overlap)
            core = blk[overlap:-overlap, overlap:-overlap]
            if not np.isfinite(core).any():
                continue
            valid = np.isfinite(blk)
            zf = np.where(valid, blk, median).astype("float64")
            g_rows = np.arange(r0 - overlap, r1 + overlap) + ty0 * 256
            g_cols = np.arange(c0 - overlap, c1 + overlap) + tx0 * 256
            res = kernel(zf, valid, cell, feather_window(g_rows, g_cols, rect, fade_px))
            res = [res] if not isinstance(res, tuple) else list(res)
            img = np.dstack([m[overlap:-overlap, overlap:-overlap] for m in res]) if len(res) > 1 else res[0][overlap:-overlap, overlap:-overlap, ...]
            if img.ndim == 2:
                img = img[..., None]
            for j in range(0, (r1 - r0) // 256):
                for i in range(0, (c1 - c0) // 256):
                    t = img[j * 256:(j + 1) * 256, i * 256:(i + 1) * 256]
                    if t[..., -1].any():
                        out[(tx0 + bx + i, ty0 + by + j)] = np.ascontiguousarray(t)
        t0_log(f"  block row {by // block_tiles + 1}/{-(-ny // block_tiles)} done, {len(out)} tiles so far")
    return out


def downsample_tile(children):
    """Four child tiles (dict {(dx, dy): array or None}) -> the parent tile: 2 x 2 average with premultiplied alpha
    (the last channel is alpha), so transparent pixels do not darken or lighten their neighbours."""
    ch = next(c.shape[2] for c in children.values() if c is not None)
    canvas = np.zeros((512, 512, ch), dtype="float32")
    for (dx, dy), c in children.items():
        if c is not None:
            canvas[dy * 256:(dy + 1) * 256, dx * 256:(dx + 1) * 256] = c
    alpha = canvas[..., -1]
    pre = canvas[..., :-1] * alpha[..., None]
    A = alpha.reshape(256, 2, 256, 2).sum(axis=(1, 3))
    P = pre.reshape(256, 2, 256, 2, ch - 1).sum(axis=(1, 3))
    colour = np.where(A[..., None] > 0, P / np.maximum(A[..., None], 1e-6), 0)
    return np.dstack([np.rint(colour), np.rint(A / 4)]).clip(0, 255).astype(np.uint8)


def build_pyramid(top, z_top, z_min):
    """{z: {(x, y): array}} from the top zoom down to z_min by repeated 2 x 2 downsampling."""
    levels = {z_top: top}
    for z in range(z_top - 1, z_min - 1, -1):
        child = levels[z + 1]
        parents = {(x // 2, y // 2) for x, y in child}
        cur = {}
        for px_, py_ in parents:
            kids = {(dx, dy): child.get((2 * px_ + dx, 2 * py_ + dy)) for dx in (0, 1) for dy in (0, 1)}
            t = downsample_tile(kids)
            if t[..., -1].any():
                cur[(px_, py_)] = t
        levels[z] = cur
        t0_log(f"  z{z}: {len(cur)} tiles")
    return levels


def to_rgba(t):
    """Tile array -> RGBA: a (lum, alpha) pair becomes (lum, lum, lum, alpha)."""
    if t.shape[2] == 2:
        return np.dstack([t[..., 0], t[..., 0], t[..., 0], t[..., 1]])
    return t


def encode_webp(t, quality=80, alpha_quality=100):
    # lossy colour (quality 80), lossless alpha: on the hill-shading tiles that is the same size as lossy alpha and
    # error-free where it matters (measured 18 KB per z15 tile, mean composite error 0.06 / 255; method 6 is 50x slower for 7%)
    buf = io.BytesIO()
    Image.fromarray(to_rgba(t), "RGBA").save(buf, "WEBP", quality=quality, alpha_quality=alpha_quality, method=4)
    return buf.getvalue()


def write_pmtiles(path, tiles, tile_type, compression, metadata, bbox, center_zoom):
    """tiles: {(z, x, y): bytes}. Writes a clustered PMTiles v3 archive (tile data in Hilbert order)."""
    from pmtiles.tile import Compression, TileType, zxy_to_tileid
    from pmtiles.writer import write
    zs = [k[0] for k in tiles]
    w, s, e, n = bbox
    meta = dict(metadata, minzoom=min(zs), maxzoom=max(zs), bounds=[w, s, e, n], center=[round((w + e) / 2, 6), round((s + n) / 2, 6), center_zoom])
    header = {"tile_type": TileType[tile_type], "tile_compression": Compression[compression],
              "min_lon_e7": round(w * 1e7), "min_lat_e7": round(s * 1e7), "max_lon_e7": round(e * 1e7), "max_lat_e7": round(n * 1e7),
              "center_zoom": center_zoom, "center_lon_e7": round((w + e) / 2 * 1e7), "center_lat_e7": round((s + n) / 2 * 1e7)}
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".pmtiles.part")
    order = sorted(tiles, key=lambda k: zxy_to_tileid(*k))
    with write(tmp) as w_:
        for k in order:
            w_.write_tile(zxy_to_tileid(*k), tiles[k])
        w_.finalize(header, meta)
    tmp.replace(path)
    by_z = collections.Counter(k[0] for k in tiles)
    print(f"  wrote {path.name}: {path.stat().st_size / 1e6:.1f} MB, {len(tiles)} tiles {dict(sorted(by_z.items()))}", flush=True)


def encode_levels(levels, quality=80, alpha_quality=100):
    out, size_z = {}, collections.Counter()
    for z, tiles in levels.items():
        for (x, y), t in tiles.items():
            b = encode_webp(t, quality, alpha_quality)
            out[(z, x, y)] = b
            size_z[z] += len(b)
    print("  webp bytes per zoom:", {z: f"{v / 1e6:.1f} MB" for z, v in sorted(size_z.items())}, flush=True)
    return out


# ---------------------------------------------------------------- hill shading
def build_relief(bbox=ISLAND, out_path=TILES_OUT / "relief.pmtiles", zmin=10, zmax=14, quality=80, alpha_quality=100, keep=None):
    # zmax 14 (2026-10-29): z15 tiles were 36 of 61 MB and differ from z14 stretched by 0.5/255 on average (99th pct < 4/255),
    # because the shading is smoothed over ~50 m. The map stretches z14 at closer zooms.
    z_top = 15                                                  # the shading is computed at about z15 resolution (4.78 m / px)
    tiles = tile_range(bbox, z_top)
    BUILD.mkdir(parents=True, exist_ok=True)
    merc = BUILD / "dtm_island_3857_z15.tif"
    t0_log(f"relief: warping to Web Mercator z{z_top} grid, tiles x {tiles[0]}-{tiles[1]}, y {tiles[2]}-{tiles[3]}")
    a = warp_mercator(dtm_path(), merc, z_top, tiles, "bilinear")
    median = float(np.nanmedian(a[::4, ::4]))
    res = MERC_PX0 / 2 ** z_top
    cell = res * math.cos(math.radians((bbox[1] + bbox[3]) / 2))     # Web Mercator metres are stretched by 1/cos(lat), as in layer_hillshade
    rect = bbox_rect_px(bbox, z_top)
    fade_px = int(round(400 / res))                              # layer_hillshade: 80 px of 5 m = 400 m
    t0_log(f"relief: raster {a.shape[1]}x{a.shape[0]}, valid {np.isfinite(a).mean():.3f}, median {median:.2f} m, cell {cell:.3f} m, fade {fade_px} px")
    top = process_blocks(a, z_top, tiles, rect, fade_px, cell, median, hillshade_kernel, 2)
    del a
    t0_log(f"relief: {len(top)} z{z_top} tiles with shading; building the lower zooms")
    levels = build_pyramid(top, z_top, zmin)
    levels = {z: t for z, t in levels.items() if z <= zmax}
    if keep is not None:
        keep.update(levels)
    enc = encode_levels(levels, quality, alpha_quality)
    meta = {"name": "Piste hill shading", "description": "Multidirectional hillshade of the NRCan HRDEM CMM 2023/2024 LiDAR terrain model (5 m), Island of Montreal. "
            "RGBA: shadows (grey 39) and highlights (white) with the alpha of build_layers.layer_hillshade (relief factor 2.3, 10 m smoothing). "
            "Computed at zoom 15 resolution; lower zooms are averaged.",
            "attribution": ATTRIB_DEM, "version": "1", "type": "overlay", "format": "webp"}
    write_pmtiles(out_path, enc, "WEBP", "NONE", meta, bbox, 12)


def task_relief():
    build_relief()


# ---------------------------------------------------------------- elevation tint
def build_tint(bbox=ISLAND, out_path=TILES_OUT / "tint.pmtiles", zmin=9, zmax=13, quality=80, alpha_quality=100, keep=None):
    z_top = 14                                                  # computed at about 10 m (z14: 9.55 m / px), z13 and up are averaged
    tiles = tile_range(bbox, z_top)
    merc = BUILD / "dtm_island_3857_z14.tif"
    t0_log(f"tint: warping to Web Mercator z{z_top} grid, tiles x {tiles[0]}-{tiles[1]}, y {tiles[2]}-{tiles[3]}")
    a = warp_mercator(dtm_path(), merc, z_top, tiles, "average")
    median = float(np.nanmedian(a))
    res = MERC_PX0 / 2 ** z_top
    cell = res * math.cos(math.radians((bbox[1] + bbox[3]) / 2))
    rect = bbox_rect_px(bbox, z_top)
    fade_px = int(round(400 / res))                              # layer_tint: 40 px of 10 m = 400 m
    t0_log(f"tint: raster {a.shape[1]}x{a.shape[0]}, valid {np.isfinite(a).mean():.3f}, median {median:.2f} m, fade {fade_px} px")
    top = process_blocks(a, z_top, tiles, rect, fade_px, cell, median, tint_kernel, 4)
    del a
    levels = build_pyramid(top, z_top, zmin)
    levels = {z: t for z, t in levels.items() if z <= zmax}
    if keep is not None:
        keep.update(levels)
    enc = encode_levels(levels, quality, alpha_quality)
    meta = {"name": "Piste elevation tint", "description": "Hypsometric tint (soft sand ramp, transparent below 10 m) of the NRCan HRDEM CMM 2023/2024 LiDAR terrain "
            "model, Island of Montreal. Colours of build_layers.TINT_RAMP, 10 m grid smoothed over 20 m. Computed at zoom 14 resolution; lower zooms are averaged.",
            "attribution": ATTRIB_DEM, "version": "1", "type": "overlay", "format": "webp",
            "ramp": [[s[0], list(s[1])] for s in bl.TINT_RAMP]}
    write_pmtiles(out_path, enc, "WEBP", "NONE", meta, bbox, 11)


def task_tint():
    build_tint()


# ================================================================ contours (vector tiles)
def smooth_strips(z, sigma, strip=1024):
    """build_layers.gaussian_smooth() on horizontal strips with an overlap of the kernel radius, so a 58 M cell raster
    never needs several full-size float64 copies. Identical to smoothing the whole array."""
    r = int(3 * sigma) + 2
    out = np.empty(z.shape, dtype="float32")
    for r0 in range(0, z.shape[0], strip):
        r1 = min(r0 + strip, z.shape[0])
        a0, a1 = max(r0 - r, 0), min(r1 + r, z.shape[0])
        out[r0:r1] = bl.gaussian_smooth(z[a0:a1].astype("float64"), sigma)[r0 - a0:r1 - a0]
    return out


def write_detail_surface(dtm, dst, strip=1024, overlap=64):
    """The 1 m detail-contour surface of build_layers.layer_contours, over the whole island, in row strips: the ~10 m smoothed
    terrain where the slope (over ~25 m) is 2.5-15 % and that mask (smoothed 3 cells, > 0.55) says so, else nodata."""
    with rasterio.open(dtm) as ds:
        z = ds.read(1, masked=True).filled(np.nan).astype("float32")
        prof = ds.profile
    valid = np.isfinite(z)
    med = float(np.nanmedian(z))
    zfill = np.where(valid, z, med).astype("float32")
    out = np.full(z.shape, -9999.0, dtype="float32")
    H = z.shape[0]
    for r0 in range(0, H, strip):
        r1 = min(r0 + strip, H)
        a0, a1 = max(r0 - overlap, 0), min(r1 + overlap, H)
        zf = zfill[a0:a1].astype("float64")
        zs = bl.gaussian_smooth(zf, 2.0)                                        # ~10 m smoothing for the lines themselves
        gy, gx = np.gradient(bl.gaussian_smooth(zf, 5.0), 5.0)                  # slope over ~25 m, so the mask follows real climbs
        slope = np.hypot(gx, gy)
        keep = (slope >= 0.025) & (slope <= 0.15)
        keep = valid[a0:a1] & (bl.gaussian_smooth(keep.astype("float64"), 3.0) > 0.55)    # drop small patches and fill small holes
        out[r0:r1] = np.where(keep, zs, -9999.0).astype("float32")[r0 - a0:r1 - a0]
    prof.update(dtype="float32", nodata=-9999.0, compress="deflate", predictor=3, tiled=True, blockxsize=256, blockysize=256, BIGTIFF="IF_SAFER")
    with rasterio.open(dst, "w", **prof) as o:
        o.write(out, 1)
    print(f"  detail surface: {np.mean(out > -9999):.3f} of cells kept")


def run_contour(src, dst, interval):
    if Path(dst).exists():
        Path(dst).unlink()
    # GDAL's GeoJSONSeq driver always writes WGS84 lon/lat (7 decimals = ~1 cm); the metre lengths are measured after reading
    subprocess.run([str(QGIS_BIN / "gdal_contour.exe"), "-a", "e", "-i", str(interval), "-of", "GeoJSONSeq", str(src), str(dst)],
                   check=True, env=gdal_env(), stdout=subprocess.DEVNULL)


def read_contour_lines(path, e_ok=lambda e: True):
    """GDAL GeoJSONSeq contours -> (lon/lat array (N, 2), line start offsets, level per line) for the lines whose level passes e_ok."""
    coords, starts, es, n = [], [], [], 0
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip().lstrip("\x1e")
            if not line:
                continue
            f = json.loads(line)
            e = int(round(f["properties"]["e"]))
            if not e_ok(e):
                continue
            g = f["geometry"]
            parts = [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]
            for p in parts:
                if len(p) < 2:
                    continue
                coords.append(np.asarray(p, dtype="float64")[:, :2]); starts.append(n); es.append(e); n += len(p)
    return ((np.concatenate(coords) if coords else np.zeros((0, 2))), np.array(starts, dtype="int64"), np.array(es, dtype="int32"))


def keep_long_lines(coords, starts, es, min_len):
    """layer_contours drops lines shorter than min_len metres, measured on the raw line in EPSG:32188 before any
    simplification. Same here (lengths from the lon/lat coordinates GDAL wrote, re-projected to EPSG:32188)."""
    if not len(starts):
        return coords, starts, es
    x, y = TO_MTM.transform(coords[:, 0], coords[:, 1])
    seg = np.append(np.hypot(np.diff(x), np.diff(y)), 0.0)
    ends = np.append(starts[1:], len(coords)) - 1
    seg[ends] = 0.0                                                       # the step to the next line is not part of any line
    length = np.add.reduceat(seg, starts)
    keep = length >= min_len
    n_pts = np.diff(np.append(starts, len(coords)))
    pt_keep = np.repeat(keep, n_pts)
    new_starts = np.append(0, np.cumsum(n_pts[keep])[:-1]).astype("int64") if keep.any() else np.zeros(0, dtype="int64")
    return coords[pt_keep], new_starts, es[keep]


def lines_to_mercator(coords, starts):
    """lon/lat coordinates + line offsets -> array of shapely LineStrings in Web Mercator metres."""
    import shapely
    x = MERC_R * np.radians(coords[:, 0])
    y = MERC_R * np.arcsinh(np.tan(np.radians(coords[:, 1])))
    n_pts = np.diff(np.append(starts, len(coords)))
    idx = np.repeat(np.arange(len(starts)), n_pts)
    return shapely.linestrings(np.column_stack([x, y]), indices=idx)


# contour classes (build_layers.layer_contours): i = 1 every 25 m, 0 every 5 m (not a multiple of 25), 2 = 1 m detail lines
CONTOUR_I_FROM_ZOOM = {1: 11, 0: 13, 2: 14}


def mvt_tile(features, z, x, y, buffer_units=128):
    """features: list of (shapely geometry in Web Mercator metres already clipped to the buffered tile, e, i) -> gzip MVT bytes."""
    import mapbox_vector_tile
    import shapely
    xmin, ymin, xmax, ymax = tile_bounds_m(z, x, y)
    k = 4096 / (xmax - xmin)
    out = []
    for g, e, i in features:
        g = shapely.transform(g, lambda c: np.column_stack([np.rint((c[:, 0] - xmin) * k), np.rint((ymax - c[:, 1]) * k)]))
        if g.is_empty or g.geom_type not in ("LineString", "MultiLineString"):
            continue
        out.append({"geometry": g, "properties": {"e": int(e), "i": int(i)}})
    if not out:
        return None
    raw = mapbox_vector_tile.encode([{"name": "contours", "features": out}],
                                    default_options={"y_coord_down": True, "extents": 4096, "check_winding_order": False})
    return gzip.compress(raw, compresslevel=9, mtime=0)


def build_contours(dtm=None, bbox=ISLAND, out_path=TILES_OUT / "contours.pmtiles", zmin=11, zmax=15, work=BUILD, min_px=4):
    import shapely
    dtm = dtm or dtm_path()
    work = Path(work)
    work.mkdir(parents=True, exist_ok=True)
    # 1. 5 m contours of the 5 m terrain model: lines of at least 60 m
    c5 = work / "contours_island_5m.geojsons"
    t0_log("contours: gdal_contour every 5 m")
    run_contour(dtm, c5, 5)
    coords, starts, e5 = read_contour_lines(c5)
    n_raw = len(e5)
    coords, starts, e5 = keep_long_lines(coords, starts, e5, 60.0)
    t0_log(f"contours: {n_raw} raw lines, {len(e5)} of 60 m or more, {len(coords)} vertices")
    g5 = lines_to_mercator(coords, starts)
    i5 = (e5 % 25 == 0).astype("int8")
    del coords, starts
    # 2. 1 m detail lines on moderate slopes: lines of at least 120 m, levels that are multiples of 5 m dropped
    t0_log("contours: 1 m detail surface")
    smooth = work / "dtm_island_5m_moderate.tif"
    write_detail_surface(dtm, smooth)
    cd = work / "contours_island_1m_detail.geojsons"
    run_contour(smooth, cd, 1)
    coords, starts, ed = read_contour_lines(cd, e_ok=lambda e: e % 5 != 0)
    n_raw = len(ed)
    coords, starts, ed = keep_long_lines(coords, starts, ed, 120.0)
    t0_log(f"contours: {n_raw} raw detail lines (not multiples of 5 m), {len(ed)} of 120 m or more, {len(coords)} vertices")
    gd = lines_to_mercator(coords, starts)
    del coords, starts
    geoms_all = np.concatenate([g5, gd])
    e_all = np.concatenate([e5, ed])
    i_all = np.concatenate([i5, np.full(len(ed), 2, dtype="int8")])
    print(f"  classes: i=1 {int((i_all == 1).sum())}, i=0 {int((i_all == 0).sum())}, i=2 {int((i_all == 2).sum())}", flush=True)
    # 3. per zoom: simplify (half a pixel), drop what is smaller than min_px pixels, cut into tiles with a buffer, encode
    tiles_out, stats = {}, {}
    for z in range(zmin, zmax + 1):
        px_m = MERC_PX0 / 2 ** z
        sel = np.array([CONTOUR_I_FROM_ZOOM[0], CONTOUR_I_FROM_ZOOM[1], CONTOUR_I_FROM_ZOOM[2]])[i_all] <= z
        gz = shapely.simplify(geoms_all[sel], 0.5 * px_m, preserve_topology=True)
        ez, iz = e_all[sel], i_all[sel]
        ok = (shapely.length(gz) >= min_px * px_m) & (shapely.get_num_points(gz) >= 2)
        gz, ez, iz = gz[ok], ez[ok], iz[ok]
        bnds = shapely.bounds(gz)
        tx0, tx1, ty0, ty1 = tile_range(bbox, z)
        pad = (2 * MERC_HALF / 2 ** z) * 128 / 4096
        n_tiles, n_feat = 0, 0
        for y in range(ty0, ty1 + 1):
            for x in range(tx0, tx1 + 1):
                xmin, ymin, xmax, ymax = tile_bounds_m(z, x, y)
                hit = np.nonzero((bnds[:, 0] <= xmax + pad) & (bnds[:, 2] >= xmin - pad) & (bnds[:, 1] <= ymax + pad) & (bnds[:, 3] >= ymin - pad))[0]
                if not len(hit):
                    continue
                clipped = shapely.clip_by_rect(gz[hit], xmin - pad, ymin - pad, xmax + pad, ymax + pad)
                feats = []
                for g, e, i in zip(clipped, ez[hit], iz[hit]):
                    if g.is_empty:
                        continue
                    if g.geom_type == "GeometryCollection":
                        parts = [p for p in g.geoms if p.geom_type in ("LineString", "MultiLineString")]
                        if not parts:
                            continue
                        g = shapely.multilinestrings([q for p in parts for q in shapely.get_parts(p)])
                    feats.append((g, e, i))
                b = mvt_tile(feats, z, x, y)
                if b:
                    tiles_out[(z, x, y)] = b
                    n_tiles += 1
                    n_feat += len(feats)
        stats[z] = (len(gz), n_tiles, n_feat)
        t0_log(f"  z{z}: {len(gz)} lines after simplify/drop, {n_tiles} tiles, {n_feat} tile features, {sum(len(b) for (zz, _, _), b in tiles_out.items() if zz == z) / 1e6:.2f} MB")
    meta = {"name": "Piste contours", "description": "Contour lines from the NRCan HRDEM CMM 2023/2024 LiDAR terrain model (5 m), Island of Montreal. Source-layer "
            "'contours', LineString, e = elevation in metres, i = 1 every 25 m, 0 every 5 m, 2 = 1 m detail lines on moderate slopes (2.5-15 %).",
            "attribution": ATTRIB_DEM, "version": "1", "type": "overlay", "format": "pbf",
            "vector_layers": [{"id": "contours", "description": "Contour lines", "minzoom": zmin, "maxzoom": zmax, "fields": {"e": "Number", "i": "Number"}}]}
    write_pmtiles(out_path, tiles_out, "MVT", "GZIP", meta, bbox, 13)
    return stats


def task_contours():
    build_contours()


# ================================================================ 3D terrain tiles (Terrarium PNG)
def aws_terrarium(z, x, y, cache=RAW / "aws_terrarium"):
    """The public AWS Terrarium tile, cached under data/raw (logged as one download at the end of the run). Elevation in metres."""
    p = cache / str(z) / str(x) / f"{y}.png"
    if not p.exists():
        url = f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
        last = None
        for attempt in range(4):
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers=fd.UA), timeout=60) as r:
                    data = r.read()
                break
            except Exception as ex:  # noqa: BLE001
                last = ex
                time.sleep(3 * (attempt + 1))
        else:
            raise last
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        time.sleep(0.05)
    im = np.asarray(Image.open(p).convert("RGB")).astype("float64")
    return im[..., 0] * 256 + im[..., 1] + im[..., 2] / 256 - 32768


def task_terrain(zmin=10, zmax=14, margin=0.012, bbox=ISLAND, outdir=TERRAIN_OUT, index=True):
    """layer_terrain over the island: Terrarium tiles from the LiDAR DTM (smoothed 1.2 cells, bilinear), the public AWS tiles
    wherever the LiDAR has no value, so there is no cliff at the edge."""
    ds = rasterio.open(dtm_path())
    raw = ds.read(1, masked=True).filled(np.nan).astype("float32")
    nanmask = ~np.isfinite(raw)
    med = float(np.nanmedian(raw))
    arr = smooth_strips(np.where(nanmask, med, raw).astype("float32"), 1.2)
    arr[nanmask] = np.nan
    del raw
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

    tiles, n_aws, total = [], 0, 0
    t0_log(f"terrain: LiDAR smoothed, {np.isfinite(arr).mean():.3f} valid")
    for z in range(zmin, zmax + 1):
        N = 2 ** z
        tx0, tx1, ty0, ty1 = tile_range(bbox, z, margin)
        for x in range(tx0, tx1 + 1):
            for y in range(ty0, ty1 + 1):
                px = (np.arange(256) + 0.5) / 256
                lon = (x + px) / N * 360 - 180
                lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * (y + px) / N))))
                LON, LAT = np.meshgrid(lon, lat)
                X, Y = bl.TO_M.transform(LON.ravel(), LAT.ravel())
                elev = sample(np.asarray(X), np.asarray(Y)).reshape(256, 256)
                if np.isnan(elev).any():
                    elev = np.where(np.isnan(elev), aws_terrarium(z, x, y), elev)
                    n_aws += 1
                elev = np.round(elev, 1)
                v = elev + 32768
                rgb = np.dstack([np.floor(v / 256), np.floor(v) % 256, np.floor((v - np.floor(v)) * 256)]).astype(np.uint8)
                p = Path(outdir) / str(z) / str(x)
                p.mkdir(parents=True, exist_ok=True)
                Image.fromarray(rgb, "RGB").save(p / f"{y}.png", optimize=True)
                total += (p / f"{y}.png").stat().st_size
                tiles.append(f"{z}/{x}/{y}")
        t0_log(f"  z{z}: {sum(1 for t in tiles if t.startswith(f'{z}/'))} tiles so far, {n_aws} filled from AWS, {total / 1e6:.1f} MB")
    if index:
        bl.write_js("terrain_index.js", "TERRAIN_TILES", {"minzoom": zmin, "maxzoom": zmax, "tiles": tiles,
                    "meta": "Terrarium-encoded NRCan HRDEM CMM 2023 + 2024 DTM (5 m, smoothed 1.2 cells); AWS terrain tiles outside the LiDAR cut"})
    cache = RAW / "aws_terrarium"
    if cache.exists() and index:
        files = list(cache.rglob("*.png"))
        fd.log("aws_terrarium\\{z}\\{x}\\{y}.png (" + str(len(files)) + " tiles)", "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png "
               "(island tiles z10-14, where the LiDAR has no value)", "Mapzen / AWS Terrain Tiles (public dataset)", "see registry.opendata.aws/terrain-tiles",
               _FolderSize(sum(f.stat().st_size for f in files)))
    print(f"  terrain tiles: {len(tiles)}, {total / 1e6:.1f} MB, {n_aws} tiles needed the AWS fill", flush=True)
    return tiles


# ================================================================ POIs (build_layers.layer_pois on the island)
def in_box(lon, lat, box, pad=0.0):
    w, s, e, n = box
    return w - pad <= lon <= e + pad and s - pad <= lat <= n + pad


def poi_kind(t):
    """Copied from build_layers.layer_pois (it is a nested function there, so it cannot be imported)."""
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


def task_pois():
    els = json.loads((RAW / "osm_overpass" / "pois_island.json").read_text(encoding="utf-8"))["elements"]
    out, n_parking_dropped = [], 0
    for el in els:
        t = el.get("tags", {})
        k = poi_kind(t)
        if not k:
            continue
        c = el.get("center") or {"lon": el.get("lon"), "lat": el.get("lat")}
        if c["lon"] is None or not in_box(c["lon"], c["lat"], ISLAND):
            continue
        if k == "park" and not t.get("name"):
            continue
        if k == "parking" and not in_box(c["lon"], c["lat"], STUDY):      # bike racks only inside the old study area (file size)
            n_parking_dropped += 1
            continue
        out.append([k, t.get("name", ""), round(c["lon"], 6), round(c["lat"], 6)])
    # named shops (separate download)
    for el in json.loads((RAW / "osm_overpass" / "shops_island.json").read_text(encoding="utf-8"))["elements"]:
        t = el.get("tags", {})
        c = el.get("center") or {"lon": el.get("lon"), "lat": el.get("lat")}
        if c["lon"] is None or not t.get("name") or not in_box(c["lon"], c["lat"], ISLAND):
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
            if not in_box(lon, lat, ISLAND):
                continue
            if any(abs(lon - x) < 0.00016 and abs(lat - y) < 0.00011 for x, y in water):
                continue
            out.append(["water", ("Fountain, " + r["Nom_parc_lieu"]).strip(", "), round(lon, 6), round(lat, 6)])
    # BIXI stations (GBFS)
    st = json.loads((RAW / "bixi_gbfs" / "station_information.json").read_text(encoding="utf-8"))["data"]["stations"]
    for s in st:
        if in_box(s["lon"], s["lat"], ISLAND):
            out.append(["bixi", s["name"], round(s["lon"], 6), round(s["lat"], 6), s.get("capacity", 0)])
    # metro stations (GTFS)
    for name, lon, lat, lines in bl.metro_stations():
        if in_box(lon, lat, ISLAND, 0.01):
            out.append(["metro", name, lon, lat, lines])
    c = collections.Counter(p[0] for p in out)
    print("  POIs:", dict(c.most_common()), f"(bike racks outside the study area left out: {n_parking_dropped})")
    bl.write_js("pois.js", "POIS", out)
    return c


# ================================================================ planned / closures / works (build_layers.layer_planned on the island)
def task_planned():
    feats = []
    tiles = RAW / "mtl_live_tiles_island"
    proj = json.loads((tiles / "pistes-cyclables-projete.geojson").read_text(encoding="utf-8"))["features"]
    status = {"D": "construction", "P": "planned", "GP": "planned"}
    for f in proj:
        p = f["properties"]
        st = status.get(p.get("avancementCode"))
        if not st:
            continue
        feats.append({"type": "Feature", "geometry": bl.round_geom(f["geometry"]),
                      "properties": {"status": st, "name": p.get("projetNom") or "", "rev": int(p.get("revAxes") == "Oui"),
                                     "year": p.get("projetProgramAnnee") or 0, "src": "Ville de Montréal"}})
    live = json.loads((tiles / "pistes-cyclables.geojson").read_text(encoding="utf-8"))["features"]
    for f in live:
        if f["properties"].get("avancementCode") == "FT":
            feats.append({"type": "Feature", "geometry": bl.round_geom(f["geometry"]),
                          "properties": {"status": "closed", "name": f["properties"].get("projetNom") or "",
                                         "src": "Ville de Montréal"}})
    # OSM bike lanes under construction (layer_planned reads these from bikeways.json; for the island a narrow query holds just them)
    bw = json.loads((RAW / "osm_overpass" / "bikeways_construction_island.json").read_text(encoding="utf-8"))["elements"]
    for el in bw:
        t = el.get("tags", {})
        if t.get("highway") == "construction" and t.get("construction") == "cycleway":
            feats.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": [bl.r6([p["lon"], p["lat"]]) for p in el["geometry"]]},
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
            if not p or not in_box(p[0], p[1], ISLAND) or (r["id_request"], r["streetid"]) in seen:
                continue
            seen.add((r["id_request"], r["streetid"]))
            feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": bl.r6(p[:2])},
                          "properties": {"status": "works", "name": r["streetid"].strip(), "from": r["fromname"].strip(),
                                         "to": r["toname"].strip(), "until": p[2], "impact": bt, "src": "Ville de Montréal (Info-travaux)"}})
    c = collections.Counter(f["properties"]["status"] for f in feats)
    print("  planned layer:", dict(c))
    bl.write_js("planned.js", "PLANNED", bl.fc(feats))
    return c


# ================================================================ read-back checks
def read_tile(path, z, x, y):
    from pmtiles.reader import MmapSource, Reader
    with open(path, "rb") as f:
        return Reader(MmapSource(f)).get(z, x, y)


def task_check():
    from pmtiles.reader import MmapSource, Reader
    outdir = SCRATCH / "tiles_check"
    outdir.mkdir(parents=True, exist_ok=True)
    spots = {"montroyal": (-73.59, 45.505), "lachine": (-73.67, 45.43), "north": (-73.65, 45.58)}
    bg = (242, 243, 240)
    for name, (lon, lat) in spots.items():
        for fname, zs in (("relief", (14, 15)), ("tint", (12, 13))):
            for z in zs:
                x, y = int(lon_to_px(lon, z) // 256), int(lat_to_py(lat, z) // 256)
                b = read_tile(TILES_OUT / f"{fname}.pmtiles", z, x, y)
                if b is None:
                    print(f"  {fname} z{z} {name}: no tile {z}/{x}/{y}")
                    continue
                im = Image.open(io.BytesIO(b)).convert("RGBA")
                a = np.asarray(im)
                comp = Image.new("RGBA", im.size, bg + (255,))
                comp.alpha_composite(im)
                comp.convert("RGB").resize((512, 512), Image.NEAREST).save(outdir / f"{fname}_{name}_z{z}.png")
                print(f"  {fname} z{z} {name} {z}/{x}/{y}: {len(b)} bytes, {im.size}, alpha min/mean/max {a[..., 3].min()}/{a[..., 3].mean():.1f}/{a[..., 3].max()}")
    import mapbox_vector_tile
    for name, z in (("montroyal", 14), ("north", 13), ("lachine", 15)):
        lon, lat = spots[name]
        x, y = int(lon_to_px(lon, z) // 256), int(lat_to_py(lat, z) // 256)
        b = read_tile(TILES_OUT / "contours.pmtiles", z, x, y)
        if b is None:
            print(f"  contours z{z} {name}: no tile")
            continue
        lay = mapbox_vector_tile.decode(gzip.decompress(b), default_options={"y_coord_down": True})["contours"]
        cnt = collections.Counter(f["properties"]["i"] for f in lay["features"])
        print(f"  contours z{z} {name} {z}/{x}/{y}: {len(b)} bytes gz, extent {lay['extent']}, {len(lay['features'])} features, by i {dict(sorted(cnt.items()))}")
    for fname in ("relief", "tint", "contours"):
        with open(TILES_OUT / f"{fname}.pmtiles", "rb") as f:
            r = Reader(MmapSource(f))
            h = r.header()
            print(f"  {fname}.pmtiles: {(TILES_OUT / (fname + '.pmtiles')).stat().st_size / 1e6:.1f} MB, zoom {h['min_zoom']}-{h['max_zoom']}, "
                  f"type {h['tile_type'].name}, compression {h['tile_compression'].name}, tiles {h['addressed_tiles_count']}, clustered {h['clustered']}")
            print("   metadata:", {k: v for k, v in r.metadata().items() if k not in ("description", "vector_layers", "ramp")})


TASKS = {"dem": task_dem, "pois_fetch": task_pois_fetch, "planned_fetch": task_planned_fetch,
         "relief": task_relief, "tint": task_tint, "contours": task_contours, "terrain": task_terrain,
         "pois": task_pois, "planned": task_planned, "check": task_check}

ALL_ORDER = ["dem", "pois_fetch", "planned_fetch", "relief", "tint", "contours", "terrain", "pois", "planned", "check"]

if __name__ == "__main__":
    names = sys.argv[1:]
    if not names:
        sys.exit(__doc__)
    if names == ["all"]:
        names = ALL_ORDER
    for name in names:
        print(f"== {name}", flush=True)
        t_task = time.time()
        TASKS[name]()
        print(f"== {name} done in {time.time() - t_task:.0f}s", flush=True)
