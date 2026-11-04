"""Permanently closed businesses, kept off the map (2026-11-04). Plain standard library, so a CI runner can run tools/check_pois_closed.py.

Two checks, both used by the POI builders (tools/build_layers.py layer_pois and tools/island_tiles.py task_pois):

1. OSM's own closure signs (osm_closed): disused=yes, abandoned=yes, closed=yes, opening_hours "closed" / "off", an end_date in the past,
   shop / amenity = vacant, or a name that says it is closed.
   Not signs: disused:amenity, was:name, old_name and the like. They record what a place used to be, and the place itself is often open
   (a new business in the old shop), so alone they never remove a place. opening_hours:covid19=off is a pause, not a closure.
2. The City of Montréal food-establishment registry (Registry): an OSM food place is dropped only when it has a registry entry of about the
   same name within 60 m, and every such entry is closed (statut "Fermé"), none open. A name alone or a distance alone never drops a place.
   "Fermé changement d'exploitant" (closed, a new operator took over) does not count as closed: the business may well go on.
"""
import csv
import datetime as dt
import difflib
import math
import re
import unicodedata
from pathlib import Path

REGISTRY_KINDS = {"cafe", "food", "bakery", "icecream", "bar", "market"}   # the POI kinds that are food businesses
MATCH_M = 60            # a registry entry this close (metres) can be the same place
NAME_RATIO = 0.88       # how alike two normalised names must be (1 = identical)
YES = {"yes", "true", "1"}
CLOSED_HOURS = {"closed", "off"}
# a name that says so: "(Fermé)", "Permanently closed", "Closed", "Fermé définitivement". Accent kept on purpose: "Ferme" is a farm.
CLOSED_NAME = re.compile(r"\b(permanently closed|definitively closed|closed down|ferm[éÉ]e?s?|fermeture d[ée]finitive|closed)\b", re.I)
NAME_WORDS = {"cafe", "restaurant", "resto", "le", "la", "les", "l", "un", "une", "du", "de", "des", "d", "au", "aux", "et", "and", "the", "chez"}
SAINT = {"st": "saint", "ste": "sainte"}


def _date_end(text):
    """Last day of a year / month / day written 2024, 2024-05 or 2024-05-12; None if it is not one of those."""
    m = re.fullmatch(r"(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?", text.strip())
    if not m:
        return None
    y, mo, d = int(m.group(1)), m.group(2), m.group(3)
    try:
        if d:
            return dt.date(y, int(mo), int(d))
        if mo:
            return (dt.date(y + (int(mo) == 12), int(mo) % 12 + 1, 1) - dt.timedelta(days=1))
        return dt.date(y, 12, 31)
    except ValueError:
        return None


def osm_closed(tags, today=None):
    """Why this OSM place counts as closed (a short text), or None."""
    today = today or dt.date.today()
    for key in ("disused", "abandoned", "closed"):
        if str(tags.get(key, "")).strip().lower() in YES:
            return key + "=yes"
    if str(tags.get("opening_hours", "")).strip().lower() in CLOSED_HOURS:
        return "opening_hours=" + tags["opening_hours"].strip().lower()
    if "vacant" in (tags.get("shop"), tags.get("amenity")):
        return "vacant"
    end = _date_end(tags.get("end_date", ""))
    if end and end < today:
        return "end_date " + tags["end_date"]
    if CLOSED_NAME.search(tags.get("name", "")):
        return "name says closed"
    return None


def split_open(elements, today=None):
    """(the elements not closed by their own tags, {reason: count})."""
    kept, why = [], {}
    for el in elements:
        r = osm_closed(el.get("tags", {}), today)
        if r:
            why[r.split(" ")[0]] = why.get(r.split(" ")[0], 0) + 1
        else:
            kept.append(el)
    return kept, why


def name_key(name):
    """A name for comparing: no accents, case, punctuation, curly quotes or little words (café, restaurant, le, la, chez ...); St = Saint."""
    n = unicodedata.normalize("NFKD", (name or "").replace("’", "'").replace("&", " and "))
    n = "".join(c for c in n if not unicodedata.combining(c)).casefold()
    words = [SAINT.get(w, w) for w in re.findall(r"[a-z0-9]+", n)]
    return " ".join(w for w in words if w not in NAME_WORDS) or " ".join(words)


def same_name(a, b):
    """Two normalised names of one place: equal, the same words in another order, or a near miss (a typo)."""
    if not a or not b:
        return False
    if a == b or sorted(a.split()) == sorted(b.split()):
        return True
    return min(len(a), len(b)) >= 5 and difflib.SequenceMatcher(None, a, b).ratio() >= NAME_RATIO


def latest_raw(folder, stem):
    """The newest of <stem>.json and <stem>_YYYY-MM-DD.json in a raw folder (fresh downloads are new dated files; the older ones stay)."""
    folder = Path(folder)
    dated = sorted(folder.glob(f"{stem}_????-??-??.json"))
    return dated[-1] if dated else folder / f"{stem}.json"


class Registry:
    """Food establishments of the City registry, on a grid for 'what is within 60 m'."""
    CELL = 0.001   # degrees, about 80-110 m

    def __init__(self, rows):
        self.rows, self.grid = [], {}
        for r in rows:
            self.rows.append(r)
            self.grid.setdefault((int(r["lon"] // self.CELL), int(r["lat"] // self.CELL)), []).append(r)

    @classmethod
    def load(cls, folder):
        """The newest businesses_YYYY-MM-DD.csv in a raw folder; an empty registry (nothing dropped) when there is none."""
        files = sorted(Path(folder).glob("businesses_????-??-??.csv"))
        if not files:
            return cls([]), None
        rows = []
        with open(files[-1], encoding="utf-8-sig", newline="") as fh:
            for r in csv.DictReader(fh):
                try:
                    lon, lat = float(r["longitude"]), float(r["latitude"])
                except (ValueError, KeyError):
                    continue
                rows.append({"key": name_key(r["name"]), "name": r["name"], "lon": lon, "lat": lat, "status": r["statut"], "date": r["date_statut"]})
        return cls(rows), files[-1]

    def near(self, lon, lat, metres=MATCH_M):
        dy = metres / 111_320
        dx = dy / max(0.2, math.cos(math.radians(lat)))
        out = []
        for cx in range(int((lon - dx) // self.CELL), int((lon + dx) // self.CELL) + 1):
            for cy in range(int((lat - dy) // self.CELL), int((lat + dy) // self.CELL) + 1):
                for r in self.grid.get((cx, cy), ()):
                    if math.hypot((r["lon"] - lon) * 111_320 * math.cos(math.radians(lat)), (r["lat"] - lat) * 111_320) <= metres:
                        out.append(r)
        return out

    def matches(self, name, lon, lat):
        """Registry entries of the same name within 60 m of this place."""
        key = name_key(name)
        return [r for r in self.near(lon, lat) if same_name(key, r["key"])] if key else []

    @staticmethod
    def is_closed(status):
        return status.strip().lower() == "fermé"


def drop_registry_closed(rows, registry):
    """POI rows [kind, name, lon, lat, ...] without the food places the registry shows as closed.
    Returns (kept rows, report): the report holds the counts and the dropped places with the registry entry that closed them."""
    kept, dropped, matched, operator_change = [], [], 0, 0
    for row in rows:
        kind, name, lon, lat = row[:4]
        if kind not in REGISTRY_KINDS or not name:
            kept.append(row)
            continue
        found = registry.matches(name, lon, lat)
        if found:
            matched += 1
        if found and all(registry.is_closed(m["status"]) for m in found):
            dropped.append((row, max(found, key=lambda m: m["date"])))
        else:
            if found and all(m["status"].strip().lower().startswith("fermé") for m in found):
                operator_change += 1   # every entry says closed, but one says a new operator took over: kept
            kept.append(row)
    return kept, {"checked": sum(1 for r in rows if r[0] in REGISTRY_KINDS and r[1]), "matched": matched, "dropped": len(dropped),
                  "kept_operator_change": operator_change, "sample": dropped}


def print_report(report, osm_reasons, registry_file):
    print("  closed places left out: by OSM tags", dict(osm_reasons) or "none",
          "| City food registry", registry_file.name if registry_file else "not downloaded (run tools/fetch_data.py food_registry)")
    if report and registry_file:
        print(f"  registry: {report['checked']} OSM food places checked, {report['matched']} matched an entry (name + 60 m), {report['dropped']} dropped "
              f"(all matches closed), {report['kept_operator_change']} kept because the entry only says closed with a new operator")
        sample = report["sample"][::max(1, len(report["sample"]) // 10)][:10]   # spread over the list, not the first ten
        for row, m in sample:
            print(f"    dropped: {row[1]} ({row[0]}, {row[2]:.5f} {row[3]:.5f}) <- registry '{m['name']}', {m['status']} since {m['date']}")
