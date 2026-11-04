"""Parks for the app's map: the island's public green spaces from OpenStreetMap as one polygon layer, drawn in a quiet muted green.
Written to prototypes/shared/tiles/parks.pmtiles (z11 to z14; the map stretches z14 beyond, the same as the other island tiles).

  source     = OpenStreetMap: leisure=park, nature_reserve, common, public gardens, landuse=village_green
  left out   = access private / no / customers / permit; private, residential and street gardens (garden:type), flowerbeds and tree pits;
               golf courses, cemeteries, pitches, playgrounds, dog parks (almost always inside a park already); anything under 150 m2
  dissolved  = every polygon merged into one, so a garden inside a park (or a park mapped twice) is not drawn twice with a see-through fill

Source file: BBBike's Montreal extract (data/raw/osm_bbbike/Montreal.osm.pbf, a cut of the planet file; the buildings builder reads the same one),
read with GDAL's OSM driver, which assembles multipolygon relations itself. Overpass was tried first and answered 502/504 even for a 5 km box
(2026-11-03), the same overload island_buildings.py works around.

Why OpenStreetMap and not the City of Montréal's "Grands parcs, parcs d'arrondissements et espaces publics" (CC BY 4.0, about 1,500 parks):
the City's own description says it is not representative of the linked cities (Westmount, Pointe-Claire, Dollard-des-Ormeaux...), which
OpenStreetMap maps like the rest of the island. OpenStreetMap is already credited, so no new credit line either.

  C:\\bikeapp\\.venv\\Scripts\\python.exe -I C:\\bikeapp\\tools\\island_parks.py all      (stages: extract, build, tiles; each re-runs with --refresh)

Tiles: one polygon layer "parks" with no properties. Per zoom the outline is simplified and the small parks dropped (ZOOMS). Credit: OpenStreetMap
contributors (ODbL 1.0).
"""
import argparse
import collections
import gzip
import json
import os
import pickle
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))   # python -I does not add the script folder

import numpy as np
import shapely
from pyproj import Transformer
from shapely.ops import unary_union

import fetch_data as FD
import island_buildings as IB

ROOT = FD.ROOT
BUILD = ROOT / "data" / "build" / "island_parks"
EXTRACT = BUILD / "bbbike_parks.geojsonl"
DISSOLVED = BUILD / "parks_32188.pkl"
TILES_OUT = ROOT / "prototypes" / "shared" / "tiles" / "parks.pmtiles"

WHERE = "leisure IN ('park', 'garden', 'nature_reserve', 'common') OR landuse = 'village_green'"
HSTORE = IB.HSTORE                                    # the OSM driver keeps the tags it has no column for as hstore text: "access"=>"private","garden:type"=>"public"
NOT_PUBLIC = {"private", "no", "customers", "permit"}                                                      # access=
NOT_A_PARK_GARDEN = {"private", "residential", "landscaping", "flowerbed", "street_side", "tree_pit"}      # garden:type=
MIN_AREA_M2 = 150.0
CLOSE_M = 0.6                                         # parks that nearly touch (a gap under 1.2 m) are merged: no hairline between two parts of one park
# zoom: (outline simplified to this many metres, parks smaller than this many m2 dropped)
ZOOMS = {11: (20.0, 40000.0), 12: (10.0, 10000.0), 13: (4.0, 2500.0), 14: (0.6, MIN_AREA_M2)}
EXTENT, BUFFER = 4096, 64
HALF = 20037508.342789244                             # half the Web Mercator world, m
TO_M = IB.TO_M                                        # EPSG:4326 -> EPSG:32188 (metres: every area and distance here is measured there)
M_TO_MERC = Transformer.from_crs("EPSG:32188", "EPSG:3857", always_xy=True)
TO_LL = Transformer.from_crs("EPSG:32188", "EPSG:4326", always_xy=True)


def say(*a):
    print(*a, flush=True)


# ------------------------------------------------------------------------------------------------ 1. the park polygons of the extract
def stage_extract(refresh):
    FD.download("osm_bbbike/Montreal.osm.pbf", IB.PBF_URL, "BBBike extract service (data: OpenStreetMap contributors)", "ODbL 1.0", False)
    if EXTRACT.exists() and not refresh:
        say(f"skip (exists) {EXTRACT.name}")
        return
    BUILD.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    tmp = EXTRACT.with_name(EXTRACT.name + ".part")
    w, s, e, n = FD.ISLAND_BBOX
    env = dict(IB.gdal_env(), GDAL_DATA=str(FD.QGIS_BIN.parent / "apps" / "gdal" / "share" / "gdal"))
    subprocess.run([str(FD.QGIS_BIN / "ogr2ogr.exe"), "-f", "GeoJSONSeq", str(tmp), str(IB.PBF), "multipolygons", "-where", WHERE,
                    "-spat", str(w), str(s), str(e), str(n), "-lco", "COORDINATE_PRECISION=7"], check=True, env=env)
    tmp.replace(EXTRACT)
    say(f"ok {EXTRACT.name}: {EXTRACT.stat().st_size / 1e6:.1f} MB in {time.time() - t0:.0f}s")


# ------------------------------------------------------------------------------------------------ 2. which polygons to keep, merged
def skip_reason(tags):
    """Why a polygon is not a public green space (None: keep it). Only called for what the extract query returned."""
    if tags.get("access") in NOT_PUBLIC:
        return "not public"
    if tags.get("leisure") == "garden" and tags.get("garden:type") in NOT_A_PARK_GARDEN:
        return "private or street garden"
    return None


def to_metres(g):
    return shapely.transform(g, lambda c: np.column_stack(TO_M.transform(c[:, 0], c[:, 1])))


def stage_build(refresh):
    if DISSOLVED.exists() and not refresh:
        say(f"skip (exists) {DISSOLVED.name}")
        return
    t0 = time.time()
    kept, dropped, n = [], collections.Counter(), 0
    with open(EXTRACT, encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            ft = json.loads(line)
            n += 1
            tags = dict(HSTORE.findall(ft["properties"].get("other_tags") or ""))
            tags["leisure"] = ft["properties"].get("leisure")
            why = skip_reason(tags)
            g = None if why else IB.polygons_only(shapely.make_valid(shapely.geometry.shape(ft["geometry"])))
            if why or g is None:
                dropped[why or "no usable outline"] += 1
                continue
            g = to_metres(g)
            if g.area < MIN_AREA_M2:
                dropped[f"under {MIN_AREA_M2:.0f} m2"] += 1
                continue
            kept.append(g)
    merged = unary_union(kept)
    merged = merged.buffer(CLOSE_M, quad_segs=2).buffer(-CLOSE_M, quad_segs=2)       # close gaps under 1.2 m between neighbours
    merged = IB.polygons_only(shapely.make_valid(merged))
    parts = shapely.get_parts(merged)
    BUILD.mkdir(parents=True, exist_ok=True)
    with open(DISSOLVED, "wb") as f:
        pickle.dump(shapely.to_wkb(merged), f)
    say(f"ok {DISSOLVED.name}: {n} polygons in the extract -> {len(kept)} kept -> {len(parts)} merged parks, {merged.area / 1e4:,.0f} ha, in {time.time() - t0:.0f}s")
    say(f"   left out: {dict(dropped)}")


# ------------------------------------------------------------------------------------------------ 3. tiles
def to_mercator(g):
    return shapely.transform(g, lambda c: np.column_stack(M_TO_MERC.transform(c[:, 0], c[:, 1])))


def tile_geoms(parts, z, mercator_box):
    """The polygons of one zoom, clipped tile by tile: {(x, y): MultiPolygon in Web Mercator metres}, each with BUFFER units of overlap."""
    size = 2 * HALF / 2 ** z
    pad = BUFFER * size / EXTENT
    tree = shapely.STRtree(parts)
    x0, y0 = int((mercator_box[0] + HALF) // size), int((HALF - mercator_box[3]) // size)
    x1, y1 = int((mercator_box[2] + HALF) // size), int((HALF - mercator_box[1]) // size)
    out = {}
    for ty in range(y0, y1 + 1):
        for tx in range(x0, x1 + 1):
            west, north = -HALF + tx * size, HALF - ty * size
            box = shapely.box(west - pad, north - size - pad, west + size + pad, north + pad)
            hit = tree.query(box)
            if not len(hit):
                continue
            polys = [p for p in shapely.get_parts(shapely.intersection(parts[hit], box)) if p.geom_type == "Polygon" and not p.is_empty]
            if polys:
                out[(tx, ty)] = (shapely.MultiPolygon(polys), (west, north - size, west + size, north))
    return out


def stage_tiles(refresh):
    import mapbox_vector_tile
    from mapbox_vector_tile.encoder import on_invalid_geometry_make_valid
    from pmtiles.tile import Compression, TileType, zxy_to_tileid
    from pmtiles.writer import Writer
    t0 = time.time()
    with open(DISSOLVED, "rb") as f:
        merged = shapely.from_wkb(pickle.load(f))
    tiles, per_zoom = {}, {}
    for z, (tol, min_area) in sorted(ZOOMS.items()):
        simple = shapely.simplify(merged, tol, preserve_topology=True) if tol else merged
        parts = np.array([p for p in shapely.get_parts(simple) if p.area >= min_area], dtype=object)
        parts = np.array([to_mercator(p) for p in parts], dtype=object)
        box = shapely.total_bounds(parts)
        grid = tile_geoms(parts, z, box)
        for (tx, ty), (geom, bounds) in grid.items():
            layer = {"name": "parks", "features": [{"geometry": geom, "properties": {}}]}
            raw = mapbox_vector_tile.encode([layer], default_options={"quantize_bounds": bounds, "y_coord_down": False, "extents": EXTENT,
                                                                       "on_invalid_geometry": on_invalid_geometry_make_valid})
            tiles[zxy_to_tileid(z, tx, ty)] = gzip.compress(raw, compresslevel=9, mtime=0)
        per_zoom[z] = (len(parts), len(grid))
        say(f"   z{z}: {len(parts)} parks over {len(grid)} tiles, {sum(map(len, tiles.values())) / 1e6:.2f} MB so far, {time.time() - t0:.0f}s")
    minx, miny, maxx, maxy = merged.bounds
    lon0, lat0 = TO_LL.transform(minx, miny)
    lon1, lat1 = TO_LL.transform(maxx, maxy)
    bounds = [round(lon0, 4), round(lat0, 4), round(lon1, 4), round(lat1, 4)]
    meta = {"name": "Piste parks", "description": "Public green spaces on the island of Montréal: OpenStreetMap leisure=park, nature_reserve, common, public gardens, merged into one layer",
            "attribution": "© OpenStreetMap contributors (ODbL)", "version": "1", "type": "overlay", "format": "pbf",
            "minzoom": min(ZOOMS), "maxzoom": max(ZOOMS), "bounds": bounds, "center": [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2, 13],
            "vector_layers": [{"id": "parks", "fields": {}, "minzoom": min(ZOOMS), "maxzoom": max(ZOOMS)}],
            "generator": "tools/island_parks.py"}
    header = {"tile_type": TileType.MVT, "tile_compression": Compression.GZIP, "center_zoom": 13,
              "min_lon_e7": round(bounds[0] * 1e7), "min_lat_e7": round(bounds[1] * 1e7), "max_lon_e7": round(bounds[2] * 1e7), "max_lat_e7": round(bounds[3] * 1e7),
              "center_lon_e7": round(meta["center"][0] * 1e7), "center_lat_e7": round(meta["center"][1] * 1e7)}
    tmp = TILES_OUT.with_suffix(".pmtiles.tmp")
    with open(tmp, "wb") as f:
        wr = Writer(f)
        for tid in sorted(tiles):
            wr.write_tile(tid, tiles[tid])
        wr.finalize(header, meta)
    os.replace(tmp, TILES_OUT)
    say(f"ok {TILES_OUT.name}: {TILES_OUT.stat().st_size / 1e6:.2f} MB, {len(tiles)} tiles, {time.time() - t0:.0f}s")


STAGES = {"extract": stage_extract, "build": stage_build, "tiles": stage_tiles}

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("stage", choices=[*STAGES, "all"])
    ap.add_argument("--refresh", action="store_true")
    a = ap.parse_args()
    for name in (STAGES if a.stage == "all" else [a.stage]):
        say(f"== {name}")
        STAGES[name](a.refresh)
