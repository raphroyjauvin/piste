"""Diagnostics for the built graph + geocode the test trips (writes data/build/trips.json)."""
import collections
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
BUILD = ROOT / "data" / "build"

g = json.loads((BUILD / "graph_study.json").read_text(encoding="utf-8"))
names = g["names"]
lon = [g["nodes"][2 * i] / 1e6 for i in range(len(g["nodes"]) // 2)]
lat = [g["nodes"][2 * i + 1] / 1e6 for i in range(len(g["nodes"]) // 2)]


def bearing(i, j):
    y = math.sin(math.radians(lon[j] - lon[i])) * math.cos(math.radians(lat[j]))
    x = math.cos(math.radians(lat[i])) * math.sin(math.radians(lat[j])) - math.sin(math.radians(lat[i])) * math.cos(
        math.radians(lat[j])) * math.cos(math.radians(lon[j] - lon[i]))
    return (math.degrees(math.atan2(y, x)) + 360) % 360


# --- one-way check on known streets ---
print("ONE-WAY CHECK (allowed travel bearing for bikes):")
for target in ("Boulevard Saint-Laurent", "Rue Saint-Urbain", "Avenue Christophe-Colomb", "Rue Saint-Denis",
               "Rue Rachel Est", "Avenue Papineau", "Rue Clark", "Avenue de l'Hôtel-de-Ville"):
    c = collections.Counter()
    for e in range(len(g["a"])):
        if names[g["name"][e]] != target:
            continue
        d = g["dir"][e]
        b = bearing(g["a"][e], g["b"][e])
        if d == 1:
            c[("a->b", round(b / 45) * 45 % 360, g["tier"][e])] += 1
        elif d == 2:
            c[("b->a", round(((b + 180) % 360) / 45) * 45 % 360, g["tier"][e])] += 1
        elif d == 0:
            c[("both", None, g["tier"][e])] += 1
    print(f"  {target}: {dict(c.most_common(6))}")

# --- names -> nodes, to find intersections ---
node_names = collections.defaultdict(set)
for e in range(len(g["a"])):
    n = names[g["name"][e]]
    node_names[g["a"][e]].add(n); node_names[g["b"][e]].add(n)


def intersection(n1, n2):
    hits = [i for i, s in node_names.items() if any(n1 in x for x in s) and any(n2 in x for x in s)]
    return hits


pois = json.loads((RAW / "osm_overpass" / "pois.json").read_text(encoding="utf-8"))["elements"]


def poi(name_part, **tags):
    out = []
    for el in pois:
        t = el.get("tags", {})
        if name_part.lower() in t.get("name", "").lower() and all(t.get(k) == v for k, v in tags.items()):
            c = el.get("center") or {"lat": el.get("lat"), "lon": el.get("lon")}
            out.append((t.get("name"), c["lon"], c["lat"], {k: t[k] for k in ("railway", "station", "tourism", "amenity", "leisure") if k in t}))
    return out


print("\nCANDIDATES")
for q in [("Rachel", "Parc-La Fontaine"), ("Rachel", "Avenue du Parc"), ("Mont-Royal", "Papineau"),
          ("Ontario", "Davidson"), ("Rachel", "Papineau"), ("Rachel", "Calixa-Lavallée")]:
    hits = intersection(*q)
    print(" ", q, [(i, round(lon[i], 5), round(lat[i], 5), sorted(node_names[i])) for i in hits[:4]])
for q in ["Mont-Royal", "Assomption", "Biodôme", "Biodome"]:
    print(" ", q, poi(q)[:6])

# --- disconnected component (rebuild quickly from raw edges is not available; report dangling dead-ends) ---
deg = collections.Counter()
for e in range(len(g["a"])):
    deg[g["a"][e]] += 1; deg[g["b"][e]] += 1
print("\ndead-end nodes:", sum(1 for v in deg.values() if v == 1), "of", len(lon))
