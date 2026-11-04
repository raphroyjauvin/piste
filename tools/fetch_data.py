"""Fetch raw data for the bike app into data/raw/<dataset>/ and log every download.

Re-runnable: this is the script a scheduled job (e.g. GitHub Actions) would call to refresh data.

Usage (from any folder):
    C:\\bikeapp\\.venv\\Scripts\\python.exe C:\\bikeapp\\tools\\fetch_data.py <task> [--refresh]
Tasks: opendata, gtfs, osm, mtl_tiles, dem, all
"""
import argparse
import csv
import datetime as dt
import json
import math
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
LOG = RAW / "_download_log.csv"

# Prototype study area (lon/lat): Plateau, Mile End, Rosemont, Hochelaga, Centre-Sud, Olympic Park.
BBOX = (-73.615, 45.500, -73.525, 45.582)  # west, south, east, north

UA = {"User-Agent": "bikeapp-prototype/0.1 (personal research; contact via GitHub raphroyjauvin)"}

OPENDATA = {
    "mtl_geobase/geobase.json": "https://donnees.montreal.ca/dataset/984f7a68-ab34-4092-9204-4bdfcca767c5/resource/9d3d60d8-4e7f-493e-8d6a-dcd040319d8d/download/geobase.json",
    "mtl_reseau_cyclable/reseau_cyclable.geojson": "https://donnees.montreal.ca/dataset/5ea29f40-1b5b-4f34-85b3-7c67088ff536/resource/0dc6612a-be66-406b-b2d9-59c9e1c65ebf/download/reseau_cyclable.geojson",
    "mtl_pum2050_corridors/corr_mobdurable.geojson": "https://donnees.montreal.ca/fr/dataset/289f9128-df6a-4230-a600-fcae6e1239c2/resource/7ef2c7c4-7485-4cac-a304-0454dc777bd5/download/corr_mobdurable.geojson",
    "mtl_info_travaux_snapshot/impacts-entraves-travaux-en-cours.csv": "https://donnees.montreal.ca/dataset/667342f7-f667-4c3c-9837-65e81312cd8d/resource/a2bc8014-488c-495d-941b-e7ae1999d1bd/download/impacts-entraves-travaux-en-cours.csv",
    "mtl_fontaines_a_boire/fontaine_eau_potable_v2018.csv": "https://donnees.montreal.ca/fr/dataset/3ff400f3-63cd-446d-8405-842383377fb8/resource/26659739-540d-4fe2-8107-5f35ab7e807c/download/fontaine_eau_potable_v2018.csv",
}
GTFS = {"stm_gtfs/gtfs_stm.zip": "https://www.stm.info/sites/default/files/gtfs/gtfs_stm.zip"}

MTL_TILES = "https://api.montreal.ca/api/it-platforms/geomatic/vector-tiles/maps/v1/pistes-cyclables/{z}/{x}/{y}.pbf"
DEM = {
    "dtm": "https://canelevation-dem.s3.ca-central-1.amazonaws.com/hrdem-lidar/QC-600023_52_CMM_2023-1m-dtm.tif",
    "dsm": "https://canelevation-dem.s3.ca-central-1.amazonaws.com/hrdem-lidar/QC-600023_52_CMM_2023-1m-dsm.tif",
}
QGIS_BIN = Path(r"C:\Program Files\QGIS 4.0.1\bin")


def log(file_rel, url, publisher, licence, path):
    new = not LOG.exists()
    with open(LOG, "a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        if new:
            w.writerow(["file", "source_url", "publisher", "licence", "size_mb", "downloaded"])
        w.writerow([file_rel, url, publisher, licence, round(path.stat().st_size / 1e6, 2),
                    dt.datetime.now().strftime("%Y-%m-%d %H:%M")])


def get(url, data=None, timeout=600):
    req = urllib.request.Request(url, data=data, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def download(rel, url, publisher, licence, refresh):
    out = RAW / rel
    if out.exists() and not refresh:
        print(f"skip (exists) {rel}")
        return out
    out.parent.mkdir(parents=True, exist_ok=True)
    t = time.time()
    tmp = out.with_suffix(out.suffix + ".part")
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=900) as r, open(tmp, "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    tmp.replace(out)
    log(rel.replace("/", "\\"), url, publisher, licence, out)
    print(f"ok {rel}: {out.stat().st_size / 1e6:.1f} MB in {time.time() - t:.0f}s")
    return out


def task_opendata(refresh):
    for rel, url in OPENDATA.items():
        download(rel, url, "Ville de Montreal (donnees.montreal.ca)", "CC BY 4.0", refresh)


def task_gtfs(refresh):
    for rel, url in GTFS.items():
        download(rel, url, "STM (GTFS)", "STM open data licence (see stm.info)", refresh)


OVERPASS = "https://overpass-api.de/api/interpreter"
OVERPASS_MIRRORS = [OVERPASS, "https://overpass.private.coffee/api/interpreter",
                    "https://overpass.kumi.systems/api/interpreter"]


def overpass(query):
    """POST an Overpass query, retrying on busy servers and falling back to public mirrors."""
    last = None
    for attempt in range(6):
        url = OVERPASS_MIRRORS[attempt % len(OVERPASS_MIRRORS)]
        try:
            return json.loads(get(url, data=urllib.parse.urlencode({"data": query}).encode(), timeout=900))
        except Exception as ex:  # noqa: BLE001 - 429/502/504 are common on public Overpass servers
            last = ex
            print(f"   overpass {url} failed ({ex}); retrying")
            time.sleep(10 * (attempt + 1))
    raise last


def task_osm(refresh):
    w, s, e, n = BBOX
    bb = f"({s},{w},{n},{e})"
    queries = {
        "osm_overpass/pois.json": f"""[out:json][timeout:300];
(
  nwr["amenity"~"^(cafe|restaurant|fast_food|ice_cream|bar|pub|biergarten|bicycle_repair_station|bicycle_parking|drinking_water|toilets|bicycle_rental|compressed_air|library|marketplace)$"]{bb};
  nwr["shop"~"^(bicycle|bakery|coffee|deli|pastry|greengrocer|chocolate|confectionery)$"]{bb};
  nwr["leisure"~"^(park|garden)$"]["name"]{bb};
  nwr["tourism"~"^(viewpoint|museum|attraction)$"]{bb};
  nwr["railway"="station"]["station"="subway"]{bb};
  node["railway"="subway_entrance"]{bb};
);
out center tags;""",
        # added 2026-10-28 for "suggest a ride" stops: named shops people ride to (not groceries or services)
        "osm_overpass/shops.json": f"""[out:json][timeout:300];
(
  nwr["shop"~"^(clothes|shoes|books|gift|boutique|second_hand|charity|music|musical_instrument|art|craft|frame|jewelry|department_store|mall|variety_store|florist|outdoor|sports|toys|games|stationery|antiques|interior_decoration|houseware|kitchen|furniture|garden_centre|cosmetics|perfumery|bag|fabric|sewing|hobby|photo|electronics|video_games|anime|comics|records|tea|wine|cheese|herbalist)$"]["name"]{bb};
);
out center tags;""",
        "osm_overpass/bikeways.json": f"""[out:json][timeout:300];
(
  way["highway"="cycleway"]{bb};
  way["cycleway"]{bb}; way["cycleway:left"]{bb}; way["cycleway:right"]{bb}; way["cycleway:both"]{bb};
  way["bicycle"="designated"]{bb};
  way["highway"="construction"]{bb};
  way["highway"="proposed"]{bb};
);
out geom tags;""",
        "osm_overpass/bike_allowed_paths.json": f"""[out:json][timeout:300];
(
  way["highway"~"^(path|footway|pedestrian|track|bridleway|living_street|service)$"]["bicycle"~"^(yes|designated|permissive)$"]{bb};
  way["highway"="cycleway"]{bb};
);
out geom tags;""",
        "osm_overpass/landcover.json": f"""[out:json][timeout:300];
(
  way["leisure"~"^(park|garden|pitch|playground|golf_course|nature_reserve)$"]{bb};
  relation["leisure"~"^(park|garden|nature_reserve)$"]{bb};
  way["landuse"~"^(grass|recreation_ground|cemetery|forest|meadow|village_green)$"]{bb};
  relation["landuse"~"^(cemetery|forest|recreation_ground)$"]{bb};
  way["natural"~"^(water|wood|scrub)$"]{bb};
  relation["natural"~"^(water|wood)$"]{bb};
  way["railway"="rail"]{bb};
);
out geom tags;""",
        "osm_overpass/buildings.json": f"""[out:json][timeout:600][maxsize:1073741824];
(
  way["building"]{bb};
  relation["building"]["type"="multipolygon"]{bb};
);
out geom tags qt;""",
    }
    for rel, q in queries.items():
        out = RAW / rel
        if out.exists() and not refresh:
            print(f"skip (exists) {rel}")
            continue
        out.parent.mkdir(parents=True, exist_ok=True)
        t = time.time()
        data = overpass(q)
        out.write_text(json.dumps(data), encoding="utf-8")
        log(rel.replace("/", "\\"), OVERPASS + " (query in tools/fetch_data.py)", "OpenStreetMap contributors",
            "ODbL 1.0", out)
        print(f"ok {rel}: {len(data.get('elements', []))} elements, {out.stat().st_size / 1e6:.1f} MB "
              f"in {time.time() - t:.0f}s")
        time.sleep(5)


def lonlat_to_tile(lon, lat, z):
    n = 2 ** z
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    return x, y


def tile_px_to_lonlat(tx, ty, z, px, py, extent):
    n = 2 ** z
    lon = (tx + px / extent) / n * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (ty + py / extent) / n))))
    return [round(lon, 7), round(lat, 7)]


def task_mtl_tiles(refresh, z=14):
    """Download the City's live bike-network vector tiles for the study area and decode to GeoJSON."""
    import mapbox_vector_tile

    out_dir = RAW / "mtl_live_tiles"
    out_dir.mkdir(parents=True, exist_ok=True)
    w, s, e, n = BBOX
    x0, y1 = lonlat_to_tile(w, s, z)
    x1, y0 = lonlat_to_tile(e, n, z)
    layers = {}
    count = 0
    for tx in range(x0, x1 + 1):
        for ty in range(y0, y1 + 1):
            data = get(MTL_TILES.format(z=z, x=tx, y=ty))
            count += 1
            dec = mapbox_vector_tile.decode(data, default_options={"y_coord_down": True})
            for lname, layer in dec.items():
                ext = layer.get("extent", 4096)
                feats = layers.setdefault(lname, [])
                for f in layer["features"]:
                    g = f["geometry"]

                    def conv(c, depth):
                        if depth == 0:
                            return tile_px_to_lonlat(tx, ty, z, c[0], c[1], ext)
                        return [conv(cc, depth - 1) for cc in c]

                    depth = {"Point": 0, "LineString": 1, "MultiLineString": 2, "Polygon": 2,
                             "MultiPolygon": 3, "MultiPoint": 1}[g["type"]]
                    feats.append({"type": "Feature", "properties": f["properties"],
                                  "geometry": {"type": g["type"], "coordinates": conv(g["coordinates"], depth)}})
            time.sleep(0.2)
    for lname, feats in layers.items():
        out = out_dir / f"{lname}.geojson"
        out.write_text(json.dumps({"type": "FeatureCollection", "features": feats}), encoding="utf-8")
        log(f"mtl_live_tiles\\{lname}.geojson", MTL_TILES + f" (z{z}, study area)",
            "Ville de Montreal (api.montreal.ca vector tiles)", "Ville de Montreal open data (CC BY 4.0)", out)
        print(f"ok {lname}: {len(feats)} tile-pieces")
    print(f"tiles fetched: {count}")


def task_dem(refresh, res=1):
    """Cut the NRCan HRDEM CMM 2023 (1 m) terrain and surface models to the study area, in EPSG:32188."""
    from pyproj import Transformer

    tr = Transformer.from_crs("EPSG:4326", "EPSG:32188", always_xy=True)
    w, s, e, n = BBOX
    xs, ys = zip(*[tr.transform(lon, lat) for lon, lat in [(w, s), (w, n), (e, s), (e, n)]])
    te = [str(round(v)) for v in (min(xs), min(ys), max(xs), max(ys))]
    env = dict(os.environ, PROJ_DATA=str(QGIS_BIN.parent / "share" / "proj"),
               PATH=str(QGIS_BIN) + os.pathsep + os.environ["PATH"],
               GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_HTTP_MULTIRANGE="YES",
               GDAL_HTTP_MERGE_CONSECUTIVE_RANGES="YES", VSI_CACHE="TRUE")
    out_dir = RAW / "nrcan_hrdem_cmm2023"
    out_dir.mkdir(parents=True, exist_ok=True)
    for kind, url in DEM.items():
        out = out_dir / f"{kind}_study_area_32188_{res}m.tif"
        if out.exists() and not refresh:
            print(f"skip (exists) {out.name}")
            continue
        t = time.time()
        cmd = [str(QGIS_BIN / "gdalwarp.exe"), "-overwrite", "-t_srs", "EPSG:32188", "-te", *te,
               "-tr", str(res), str(res), "-r", "bilinear", "-multi", "-wo", "NUM_THREADS=ALL_CPUS",
               "-co", "COMPRESS=DEFLATE", "-co", "PREDICTOR=3", "-co", "TILED=YES", "-co", "BIGTIFF=IF_SAFER",
               "/vsicurl/" + url, str(out)]
        subprocess.run(cmd, check=True, env=env)
        log(f"nrcan_hrdem_cmm2023\\{out.name}", url + " (cut to study area)", "NRCan HRDEM (CMM 2023 LiDAR)",
            "Open Government Licence - Canada", out)
        print(f"ok {out.name}: {out.stat().st_size / 1e6:.1f} MB in {time.time() - t:.0f}s")


# Island of Montréal (with the Jean-Drapeau islands and Île des Sœurs), for island-wide routing (2026-10-29)
ISLAND_BBOX = (-73.985, 45.395, -73.465, 45.715)


def task_island(refresh):
    """What the island-wide routing graph needs beyond the study area: OSM bike-legal paths and a 5 m terrain model.
    Written to their own files, so the study-area downloads stay as they are."""
    w, s, e, n = ISLAND_BBOX
    bb = f"({s},{w},{n},{e})"
    out = RAW / "osm_overpass" / "bike_allowed_paths_island.json"
    if out.exists() and not refresh:
        print(f"skip (exists) {out.name}")
    else:
        t = time.time()
        data = overpass(f"""[out:json][timeout:900][maxsize:1073741824];
(
  way["highway"~"^(path|footway|pedestrian|track|bridleway|living_street|service)$"]["bicycle"~"^(yes|designated|permissive)$"]{bb};
  way["highway"="cycleway"]{bb};
);
out geom tags;""")
        out.write_text(json.dumps(data), encoding="utf-8")
        log("osm_overpass\\bike_allowed_paths_island.json", OVERPASS + " (query in tools/fetch_data.py, island bbox)",
            "OpenStreetMap contributors", "ODbL 1.0", out)
        print(f"ok {out.name}: {len(data.get('elements', []))} elements, {out.stat().st_size / 1e6:.1f} MB in {time.time() - t:.0f}s")
    from pyproj import Transformer
    tr = Transformer.from_crs("EPSG:4326", "EPSG:32188", always_xy=True)
    xs, ys = zip(*[tr.transform(lon, lat) for lon, lat in [(w, s), (w, n), (e, s), (e, n)]])
    te = [str(round(v)) for v in (min(xs), min(ys), max(xs), max(ys))]
    env = dict(os.environ, PROJ_DATA=str(QGIS_BIN.parent / "share" / "proj"),
               PATH=str(QGIS_BIN) + os.pathsep + os.environ["PATH"],
               GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_HTTP_MULTIRANGE="YES",
               GDAL_HTTP_MERGE_CONSECUTIVE_RANGES="YES", VSI_CACHE="TRUE")
    dem = RAW / "nrcan_hrdem_cmm2023" / "dtm_island_32188_5m.tif"
    if dem.exists() and not refresh:
        print(f"skip (exists) {dem.name}")
        return
    t = time.time()
    subprocess.run([str(QGIS_BIN / "gdalwarp.exe"), "-overwrite", "-t_srs", "EPSG:32188", "-te", *te, "-tr", "5", "5",
                    "-r", "average", "-multi", "-wo", "NUM_THREADS=ALL_CPUS", "-co", "COMPRESS=DEFLATE", "-co", "PREDICTOR=3",
                    "-co", "TILED=YES", "-co", "BIGTIFF=IF_SAFER", "/vsicurl/" + DEM["dtm"], str(dem)], check=True, env=env)
    log(f"nrcan_hrdem_cmm2023\\{dem.name}", DEM["dtm"] + " (island bbox, averaged to 5 m)", "NRCan HRDEM (CMM 2023 LiDAR)",
        "Open Government Licence - Canada", dem)
    print(f"ok {dem.name}: {dem.stat().st_size / 1e6:.1f} MB in {time.time() - t:.0f}s")


def task_rem(refresh):
    """The REM light-rail lines and stations from OpenStreetMap (the ARTM publishes no map data for the REM): the route relations
    with network REM, geometry and stops included, plus the station features. Saved as published to osm_rem/rem.json."""
    out = RAW / "osm_rem" / "rem.json"
    if out.exists() and not refresh:
        print(f"skip (exists) {out.name}")
        return
    out.parent.mkdir(parents=True, exist_ok=True)
    t = time.time()
    bb = "(45.30,-74.20,45.75,-73.30)"
    data = overpass(f"""[out:json][timeout:300];
relation["route"~"^(light_rail|subway|train)$"]["network"~"REM"]{bb}->.lines;
.lines out geom;
nwr["network"~"REM"]["public_transport"~"^(station|stop_position)$"]{bb};
out center tags;
nwr["network"~"REM"]["railway"~"^(station|halt|stop)$"]{bb};
out center tags;""")
    out.write_text(json.dumps(data), encoding="utf-8")
    log("osm_rem\rem.json", OVERPASS + " (query in tools/fetch_data.py task_rem)", "OpenStreetMap contributors", "ODbL 1.0", out)
    print(f"ok {out.name}: {len(data.get('elements', []))} elements, {out.stat().st_size / 1e6:.1f} MB in {time.time() - t:.0f}s")


# ---- Closed businesses (2026-11-04): fresher OSM places, and the City's food-establishment registry ----
# Both go to NEW dated files, never over an older raw file; the POI builders read the newest (tools/poi_closed.py, latest_raw).
FOOD_REGISTRY = "https://donnees.montreal.ca/dataset/c1d65779-d3cb-44e8-af0a-b9f2c5f7766d/resource/28a4957d-732e-48f9-8adb-0624867d9bb0/download/businesses.csv"


def task_food_registry(refresh):
    """Ville de Montréal, "Établissements alimentaires" (food inspections; CC BY 4.0): every establishment with its status (Ouvert / Fermé) and coordinates."""
    rel = f"mtl_etablissements_alimentaires/businesses_{dt.date.today().isoformat()}.csv"
    download(rel, FOOD_REGISTRY, "Ville de Montreal (donnees.montreal.ca), Etablissements alimentaires", "CC BY 4.0", False)


def task_osm_fresh(refresh):
    """The island POI and shop queries again, into pois_island_<date>.json / shops_island_<date>.json. Public Overpass servers are often
    overloaded: overpass() tries three of them with growing pauses. If none answers, the task stops and the older files stay in use."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))   # python -I does not put the script folder on sys.path
    import island_tiles as it   # imported here only: it needs numpy and rasterio, which the other tasks here do not
    import poi_closed
    pc_latest = lambda stem: poi_closed.latest_raw(RAW / "osm_overpass", stem)   # noqa: E731 - what the builders will read
    day = dt.date.today().isoformat()
    for stem, q in (("pois_island", it._q_pois), ("shops_island", it._q_shops)):
        out = RAW / "osm_overpass" / f"{stem}_{day}.json"
        if out.exists():
            print(f"skip (exists) {out.name}")
            continue
        before = [len(json.loads(f.read_text(encoding="utf-8")).get("elements", [])) for f in sorted((RAW / "osm_overpass").glob(f"{stem}*.json"))[-1:]]
        t = time.time()
        try:
            data = it._overpass_island(q, it.ISLAND)
        except Exception as ex:  # noqa: BLE001 - the public servers answer 502/504 for hours at a time
            print(f"No Overpass server answered for {stem} ({ex}). Nothing saved: the POI builders keep using {pc_latest(stem).name}.")
            return
        n = len(data.get("elements", []))
        if before and n < 0.5 * before[0]:   # a half-empty answer is a server fault, not a city that lost half its places
            raise RuntimeError(f"{stem}: only {n} elements against {before[0]} before; not saved")
        out.write_text(json.dumps(data), encoding="utf-8")
        log("osm_overpass\\" + out.name, OVERPASS + " (query in tools/island_tiles.py, island bbox)", "OpenStreetMap contributors", "ODbL 1.0", out)
        print(f"ok {out.name}: {n} elements, {out.stat().st_size / 1e6:.1f} MB in {time.time() - t:.0f}s")
        time.sleep(5)


TASKS = {"opendata": task_opendata, "gtfs": task_gtfs, "osm": task_osm, "mtl_tiles": task_mtl_tiles,
         "dem": task_dem, "island": task_island, "rem": task_rem, "food_registry": task_food_registry, "osm_fresh": task_osm_fresh}
ON_DEMAND = {"osm_fresh"}   # not part of "all": each run on a new day makes another dated file

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("task", choices=[*TASKS, "all"])
    ap.add_argument("--refresh", action="store_true")
    a = ap.parse_args()
    for name in ([k for k in TASKS if k not in ON_DEMAND] if a.task == "all" else [a.task]):
        print(f"== {name}")
        sys.stdout.flush()
        TASKS[name](a.refresh)
