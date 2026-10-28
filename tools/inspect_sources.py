"""Quick profile of raw sources used by the graph and layer builders (prints to stdout)."""
import collections
import csv
import io
import json
import zipfile
from pathlib import Path

RAW = Path(__file__).resolve().parents[1] / "data" / "raw"


def top(counter, n=25):
    return ", ".join(f"{k!r}:{v}" for k, v in counter.most_common(n))


# --- Géobase ---
gb = json.loads((RAW / "mtl_geobase" / "geobase.json").read_text(encoding="utf-8"))
feats = gb["features"]
print("GEOBASE features:", len(feats), "| geometry:", collections.Counter(f["geometry"]["type"] for f in feats if f["geometry"]))
print("fields:", list(feats[0]["properties"].keys()))
print("sample:", feats[0]["properties"])
for k in feats[0]["properties"]:
    c = collections.Counter(f["properties"].get(k) for f in feats)
    if len(c) <= 30:
        print(f"  [{k}] {top(c)}")
ids_gb = {str(f["properties"].get("ID_TRC")).split(".")[0] for f in feats}

# --- bike network join coverage ---
rc = json.loads((RAW / "mtl_reseau_cyclable" / "reseau_cyclable.geojson").read_text(encoding="utf-8"))["features"]
match = collections.Counter()
cls_by_type = collections.defaultdict(collections.Counter)
gb_by_id = {str(f["properties"].get("ID_TRC")).split(".")[0]: f["properties"] for f in feats}
for f in rc:
    p = f["properties"]
    tid = str(p["ID_TRC"]).split(".")[0]
    ok = tid in ids_gb
    match[(p["TYPE_VOIE_DESC"], ok)] += 1
    if ok:
        cls_by_type[p["TYPE_VOIE_DESC"]][gb_by_id[tid].get("CLASSE")] += 1
print("\nBIKE->GEOBASE join (type, found):")
for k, v in sorted(match.items()):
    print("  ", k, v)
print("Geobase CLASSE of matched bike segments, by bike type:")
for t, c in cls_by_type.items():
    print("  ", t, dict(c))

# --- STM GTFS metro routes ---
z = zipfile.ZipFile(RAW / "stm_gtfs" / "gtfs_stm.zip")
print("\nGTFS files:", z.namelist())
routes = list(csv.DictReader(io.TextIOWrapper(z.open("routes.txt"), encoding="utf-8-sig")))
print("routes fields:", list(routes[0].keys()))
for r in routes:
    if r.get("route_type") == "1":
        print("  METRO", r)

# --- City live tiles ---
for lname in ("pistes-cyclables", "pistes-cyclables-projete"):
    fs = json.loads((RAW / "mtl_live_tiles" / f"{lname}.geojson").read_text(encoding="utf-8"))["features"]
    print(f"\nLIVE {lname}: {len(fs)} pieces")
    for k in fs[0]["properties"]:
        c = collections.Counter(str(f["properties"].get(k)) for f in fs)
        if len(c) <= 20:
            print(f"  [{k}] {top(c, 20)}")
        else:
            print(f"  [{k}] {len(c)} unique e.g. {[v for v, _ in c.most_common(3)]}")
