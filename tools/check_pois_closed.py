"""Checks for the closed-business filter (tools/poi_closed.py): standard library only, about 1 s, exit code 1 on failure.
  python tools/check_pois_closed.py
1. Known OSM closure tags are dropped by the builder's check, and look-alike tags (a former name, a farm, a covid pause) are not.
2. The City-registry rule: dropped only when a same-name entry within 60 m exists and all such entries are closed.
3. prototypes/shared/data/pois.js holds no place the builder would mark closed (by its name or hours; and by the registry when the
   raw registry file is here, which it is on the maker's PC but not on CI).
Run in CI by tools/shots/test.mjs (group "closed businesses")."""
import datetime as dt
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))   # python -I does not put the script folder on sys.path
import poi_closed as pc  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
TODAY = dt.date(2026, 11, 4)
failures = []


def check(name, ok, detail=""):
    if not ok:
        failures.append(f"{name} {detail}".strip())


# ---- 1. OSM tags
CLOSED = {
    "disused=yes": {"amenity": "cafe", "name": "A", "disused": "yes"},
    "abandoned=yes": {"amenity": "restaurant", "name": "A", "abandoned": "yes"},
    "closed=yes": {"amenity": "bar", "name": "A", "closed": "yes"},
    "opening_hours closed": {"amenity": "cafe", "name": "A", "opening_hours": "closed"},
    "opening_hours Off": {"amenity": "cafe", "name": "A", "opening_hours": " Off "},
    "end_date day": {"amenity": "cafe", "name": "A", "end_date": "2025-03-01"},
    "end_date month": {"amenity": "cafe", "name": "A", "end_date": "2026-10"},
    "end_date year": {"amenity": "cafe", "name": "A", "end_date": "2020"},
    "shop vacant": {"shop": "vacant", "name": "A"},
    "amenity vacant": {"amenity": "vacant", "name": "A"},
    "name Fermé": {"amenity": "cafe", "name": "Café Délice (Fermé)"},
    "name fermée": {"amenity": "cafe", "name": "Boulangerie Fermée"},
    "name closed": {"amenity": "cafe", "name": "Closed - Pizza Roma"},
    "name permanently closed": {"amenity": "cafe", "name": "Joe's Permanently Closed"},
}
for label, tags in CLOSED.items():
    check("dropped: " + label, pc.osm_closed(tags, TODAY) is not None)
OPEN = {
    "former name only": {"amenity": "cafe", "name": "Nouveau", "disused:name": "Ancien", "was:name": "Avant", "old_name": "Vieux"},
    "disused amenity beside a live one": {"amenity": "restaurant", "name": "New", "disused:amenity": "cafe"},
    "farm": {"amenity": "restaurant", "name": "La Ferme Québécoise"},
    "farm 2": {"amenity": "cafe", "name": "Halte-Vélo Ferme Bord-du-Lac"},
    "covid pause": {"amenity": "cafe", "name": "Stash", "opening_hours:covid19": "off"},
    "hours": {"amenity": "cafe", "name": "A", "opening_hours": "Mo-Fr 09:00-17:00"},
    "end_date ahead": {"amenity": "cafe", "name": "A", "end_date": "2999-01-01"},
    "end_date this month": {"amenity": "cafe", "name": "A", "end_date": "2026-11"},
    "end_date junk": {"amenity": "cafe", "name": "A", "end_date": "soon"},
    "disused=no": {"amenity": "cafe", "name": "A", "disused": "no"},
}
for label, tags in OPEN.items():
    check("kept: " + label, pc.osm_closed(tags, TODAY) is None, str(pc.osm_closed(tags, TODAY)))
kept, why = pc.split_open([{"tags": CLOSED["closed=yes"]}, {"tags": OPEN["hours"]}], TODAY)
check("split_open", len(kept) == 1 and why == {"closed=yes": 1}, str(why))

# ---- 2. names and the registry
check("name key: accents, case, little words", pc.name_key("Café Olimpico") == pc.name_key("OLIMPICO") == "olimpico")
check("name key: St = Saint", pc.name_key("St-Viateur Bagel") == pc.name_key("SAINT VIATEUR BAGEL"))
check("same words, other order", pc.same_name(pc.name_key("Pizza Bella"), pc.name_key("Bella Pizza")))
check("different names", not pc.same_name(pc.name_key("Café Olimpico"), pc.name_key("Café Myriade")))


def entry(name, status, dlon=0.0, dlat=0.0, date="20240101"):
    return {"key": pc.name_key(name), "name": name, "lon": -73.57 + dlon, "lat": 45.52 + dlat, "status": status, "date": date}


def verdict(place, entries):
    rows, rep = pc.drop_registry_closed([place], pc.Registry(entries))
    return rep["dropped"] == 1


cafe = ["cafe", "Café Olimpico", -73.57, 45.52]
check("closed match is dropped", verdict(cafe, [entry("OLIMPICO", "Fermé")]))
check("kept: closed match too far (90 m)", not verdict(cafe, [entry("OLIMPICO", "Fermé", dlat=90 / 111320)]))
check("dropped: closed match close enough (40 m)", verdict(cafe, [entry("OLIMPICO", "Fermé", dlat=40 / 111320)]))
check("kept: another name nearby", not verdict(cafe, [entry("MYRIADE", "Fermé")]))
check("kept: closed and open entries", not verdict(cafe, [entry("OLIMPICO", "Fermé"), entry("CAFE OLIMPICO", "Ouvert", dlat=10 / 111320)]))
check("kept: operator change", not verdict(cafe, [entry("OLIMPICO", "Fermé changement d'exploitant")]))
check("kept: in processing", not verdict(cafe, [entry("OLIMPICO", "En traitement")]))
check("kept: no entry at all", not verdict(cafe, []))
check("kept: not a food kind", not verdict(["shop", "Café Olimpico", -73.57, 45.52], [entry("OLIMPICO", "Fermé")]))
check("kept: no name", not verdict(["cafe", "", -73.57, 45.52], [entry("", "Fermé")]))
with tempfile.TemporaryDirectory() as d:
    for n in ("pois_island.json", "pois_island_2026-11-04.json", "pois_island_2026-12-01.json", "shops_island.json"):
        (Path(d) / n).write_text("{}")
    check("latest_raw: newest dated file", pc.latest_raw(d, "pois_island").name == "pois_island_2026-12-01.json")
    check("latest_raw: undated when no dated", pc.latest_raw(d, "shops_island").name == "shops_island.json")

# ---- 3. what is published
text = (ROOT / "prototypes" / "shared" / "data" / "pois.js").read_text(encoding="utf-8")
rows = json.loads(text[text.index("=") + 1:text.rindex(";")])
check("pois.js has places", len(rows) > 1000)
for r in rows:
    if r[0] in ("bixi", "metro"):
        continue
    if pc.CLOSED_NAME.search(r[1] or ""):
        failures.append(f"pois.js: closed by its name: {r[1]}")
    if len(r) > 5 and isinstance(r[5], str) and r[5].strip().lower() in pc.CLOSED_HOURS:
        failures.append(f"pois.js: closed by its hours: {r[1]}")
registry, registry_file = pc.Registry.load(ROOT / "data" / "raw" / "mtl_etablissements_alimentaires")
if registry_file:
    _, report = pc.drop_registry_closed(rows, registry)
    check("pois.js: registry would drop none", report["dropped"] == 0, f"{report['dropped']} places, e.g. {[x[0][1] for x in report['sample'][:3]]}")
print(f"{len(CLOSED)} closed + {len(OPEN)} open tag cases, registry rules, {len(rows)} published places"
      + (f", registry {registry_file.name}" if registry_file else ", registry file not here (skipped)"))
for f in failures:
    print("FAIL", f)
sys.exit(1 if failures else 0)
