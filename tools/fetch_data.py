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


TASKS = {"opendata": task_opendata, "gtfs": task_gtfs, "osm": task_osm, "mtl_tiles": task_mtl_tiles,
         "dem": task_dem}

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("task", choices=[*TASKS, "all"])
    ap.add_argument("--refresh", action="store_true")
    a = ap.parse_args()
    for name in (TASKS if a.task == "all" else [a.task]):
        print(f"== {name}")
        sys.stdout.flush()
        TASKS[name](a.refresh)
