"""Build the routing graph: Géobase streets + City bike network (+ live attributes) + OSM bike-legal paths + elevation.

Output: data/build/graph_<extent>.json  and  prototypes/shared/data/graph_<extent>.js (window.GRAPH_<EXTENT>)

Usage:
    C:\\bikeapp\\.venv\\Scripts\\python.exe -I C:\\bikeapp\\tools\\build_graph.py [--extent study|island]
"""
import argparse
import collections
import csv
import json
import math
import os
import sqlite3
import subprocess
import time
from pathlib import Path

import numpy as np
import rasterio
from pyproj import Transformer
from shapely.geometry import LineString, Point
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
BUILD = ROOT / "data" / "build"
PROTO_DATA = ROOT / "prototypes" / "shared" / "data"
QGIS_BIN = Path(r"C:\Program Files\QGIS 4.0.1\bin")

STUDY_BBOX = (-73.615, 45.500, -73.525, 45.582)
MARGIN = 0.004  # degrees around the study area so routes near the edge still work

TO_M = Transformer.from_crs("EPSG:4326", "EPSG:32188", always_xy=True)
TO_LL = Transformer.from_crs("EPSG:32188", "EPSG:4326", always_xy=True)

# Tiers: 0 A protected, 1 B painted/calm, 2 C shared, 3 D gap quiet, 4 E gap busy, 5 X closed to bikes
TIER_BY_TYPE = {4: 0, 5: 0, 6: 0, 7: 0, 3: 1, 8: 1, 1: 2, 9: 2}
CONTRAFLOW_TV2 = {11, 30, 31, 33, 41, 43, 83, 84}

F_REV, F_4S, F_STRUCT, F_CLOSED_TMP, F_ROUTE_VERTE, F_OFFSTREET, F_UNPAVED, F_OSM, F_CONNECTOR = (
    1, 2, 4, 8, 16, 32, 64, 128, 256)
F_PROT4S = 512  # keeps its protection (separators) in winter: City PROTEGE_4S


def norm_id(v):
    if v is None:
        return None
    s = str(v).split(".")[0].strip()
    return s if s and s not in ("0", "9999", "None") else None


def in_box(coords, box):
    w, s, e, n = box
    return any(w <= x <= e and s <= y <= n for x, y in coords)


def to_metric(coords):
    xs, ys = TO_M.transform([c[0] for c in coords], [c[1] for c in coords])
    return list(zip(xs, ys))


def load_speed_limits():
    out = BUILD / "speed_limits.csv"
    if not out.exists():
        env = dict(os.environ, PROJ_DATA=str(QGIS_BIN.parent / "share" / "proj"),
                   PATH=str(QGIS_BIN) + os.pathsep + os.environ["PATH"])
        src = "/vsizip/" + str(RAW / "mtl_limites_vitesse" / "limites_de_vitesses_20260226.zip").replace("\\", "/") \
              + "/limites_de_vitesses_20260226/limites_vitesse.shp"
        subprocess.run([str(QGIS_BIN / "ogr2ogr.exe"), "-f", "CSV", str(out), src, "-select", "ID_Troncon,Vitesse"],
                       check=True, env=env)
    speeds = {}
    with open(out, encoding="utf-8") as f:
        for r in csv.DictReader(f):
            k = norm_id(r["ID_Troncon"])
            try:
                v = int(float(r["Vitesse"]))
            except ValueError:
                continue
            if k:
                speeds[k] = max(speeds.get(k, 0), v)
    return speeds


def load_arterial():
    con = sqlite3.connect(f"file:{RAW / 'mtl_reseau_arteriel' / 'reseau-arteriel-administratif-2023.gpkg'}?mode=ro", uri=True)
    return {norm_id(i): int(a or 0) for i, a in con.execute("select ID_TRC, ARTERE from raav_geobase_2023")}


def load_live_attrs():
    """Attributes from the City's live vector tiles, keyed by bike segment id (ID_CYCL)."""
    p = RAW / "mtl_live_tiles" / "pistes-cyclables.geojson"
    attrs = {}
    if p.exists():
        for f in json.loads(p.read_text(encoding="utf-8"))["features"]:
            pr = f["properties"]
            attrs.setdefault(str(pr.get("id")), pr)
    return attrs


class GridIndex:
    """Grid index for radius / nearest queries on points in metric coordinates."""

    def __init__(self, xy, cell=10.0):
        self.xy = np.asarray(xy, dtype=float).reshape(-1, 2)
        self.cell = cell
        self.cells = collections.defaultdict(list)
        for i, (x, y) in enumerate(self.xy):
            self.cells[(math.floor(x / cell), math.floor(y / cell))].append(i)

    def within(self, x, y, r):
        c, out = self.cell, []
        for gx in range(math.floor((x - r) / c), math.floor((x + r) / c) + 1):
            for gy in range(math.floor((y - r) / c), math.floor((y + r) / c) + 1):
                for i in self.cells.get((gx, gy), ()):
                    if math.dist((x, y), self.xy[i]) <= r:
                        out.append(i)
        return out

    def nearest(self, x, y, r):
        best, bd = None, r
        for i in self.within(x, y, r):
            d = math.dist((x, y), self.xy[i])
            if d <= bd:
                best, bd = i, d
        return best


CLIMB_MIN_STEP = 1.0   # metres: rises and drops smaller than this are terrain-model noise, not climbs (2026-10-29)


def climb_and_descent(z, h=CLIMB_MIN_STEP):
    """Total climb and descent along an elevation profile, ignoring wiggles smaller than h metres.
    Summing every small rise of the 5 m terrain model counted 6-9 m of climbing on a flat 1.3 km riverside path
    (LaSalle), enough to send routes onto Boulevard LaSalle. Climb minus descent still equals the net change."""
    up = down = 0.0
    anchor = float(z[0])
    for v in z[1:]:
        v = float(v)
        if v - anchor >= h:
            up += v - anchor; anchor = v
        elif anchor - v >= h:
            down += anchor - v; anchor = v
    last = float(z[-1])
    if last > anchor:
        up += last - anchor
    else:
        down += anchor - last
    return up, down


class DEM:
    def __init__(self, path):
        self.ds = rasterio.open(path)
        self.arr = self.ds.read(1, masked=True).filled(np.nan).astype("float32")
        self.inv = ~self.ds.transform
        self.h, self.w = self.arr.shape

    def sample(self, xs, ys):
        cols, rows = self.inv * (np.asarray(xs), np.asarray(ys))
        c = np.clip(np.round(cols).astype(int), 0, self.w - 1)
        r = np.clip(np.round(rows).astype(int), 0, self.h - 1)
        return self.arr[r, c]


def split_edge(e, cuts):
    """Split edge dict e (metric xy) at sorted list of (dist_along, (x, y)). Returns list of edge dicts."""
    pts = e["xy"]
    cum = [0.0]
    for a, b in zip(pts, pts[1:]):
        cum.append(cum[-1] + math.dist(a, b))
    out, cur, vi = [], [pts[0]], 1
    for d, q in sorted(cuts):
        while vi < len(pts) and cum[vi] < d:
            cur.append(pts[vi]); vi += 1
        cur.append(q)
        out.append(dict(e, xy=cur))
        cur = [q]
    cur += pts[vi:]
    out.append(dict(e, xy=cur))
    return [o for o in out if len(o["xy"]) >= 2]


def merge_endpoints(movers, tol=2.0):
    """Give endpoints of mover edges that lie within tol metres of each other the same coordinates."""
    pts = [m["xy"][0] for m in movers] + [m["xy"][-1] for m in movers]
    if not pts:
        return
    idx = GridIndex(pts, cell=max(tol * 2, 1.0))
    parent = list(range(len(pts)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i, (x, y) in enumerate(pts):
        for j in idx.within(x, y, tol):
            if j != i:
                parent[find(j)] = find(i)
    groups = collections.defaultdict(list)
    for i in range(len(pts)):
        groups[find(i)].append(i)
    n = len(movers)
    for members in groups.values():
        mx = sum(pts[m][0] for m in members) / len(members)
        my = sum(pts[m][1] for m in members) / len(members)
        for m in members:
            if m < n:
                movers[m]["xy"][0] = (mx, my)
            else:
                movers[m - n]["xy"][-1] = (mx, my)


def snap_into(movers, targets, tol_node, tol_edge, tol_conn, conn_tier_from_mover=True):
    """Connect mover edges' endpoints to target edges: snap to a target node, else split a target edge,
    else add a short connector edge to the nearest target node (a street crossing the data doesn't draw)."""
    tnodes = {}
    for t in targets:
        for p in (t["xy"][0], t["xy"][-1]):
            tnodes.setdefault((round(p[0] * 10), round(p[1] * 10)), p)
    tn_xy = list(tnodes.values())
    nidx = GridIndex(tn_xy, cell=15.0)
    tlines = [LineString(t["xy"]) for t in targets]
    tree = STRtree(tlines)
    splits = collections.defaultdict(list)
    connectors = []
    stats = collections.Counter()
    # endpoints grouped by coordinate (merged groups share coordinates)
    ends = collections.defaultdict(list)
    for mi, m in enumerate(movers):
        ends[(round(m["xy"][0][0] * 10), round(m["xy"][0][1] * 10))].append((mi, 0))
        ends[(round(m["xy"][-1][0] * 10), round(m["xy"][-1][1] * 10))].append((mi, -1))
    for key, members in ends.items():
        mi0, end0 = members[0]
        x, y = movers[mi0]["xy"][end0]
        new_pt = None
        k = nidx.nearest(x, y, tol_node)
        if k is not None:
            new_pt = tuple(tn_xy[k]); stats["node"] += 1
        else:
            pt = Point(x, y)
            best = None
            for ci in tree.query(pt.buffer(tol_edge)):
                d = tlines[ci].distance(pt)
                if d <= tol_edge and (best is None or d < best[0]):
                    best = (d, ci)
            if best:
                ci = best[1]
                along = tlines[ci].project(pt)
                if 1.0 < along < tlines[ci].length - 1.0:
                    q = tlines[ci].interpolate(along)
                    new_pt = (q.x, q.y)
                    splits[ci].append((along, new_pt)); stats["split"] += 1
                else:
                    end_pt = targets[ci]["xy"][0] if along <= 1.0 else targets[ci]["xy"][-1]
                    new_pt = tuple(end_pt); stats["node"] += 1
        if new_pt is not None:
            for mi, end in members:
                movers[mi]["xy"][end] = new_pt
            continue
        k = nidx.nearest(x, y, tol_conn)
        if k is not None:
            src = movers[mi0]
            connectors.append({"xy": [(x, y), tuple(tn_xy[k])], "tier": src["tier"] if conn_tier_from_mover else 3,
                               "dir": 0, "name": src["name"], "flags": (src["flags"] | F_CONNECTOR) & ~F_STRUCT,
                               "src": "conn"})
            stats["connector"] += 1
        else:
            stats["unconnected"] += 1
    new_targets = []
    for i, t in enumerate(targets):
        new_targets += split_edge(t, splits[i]) if i in splits else [t]
    return new_targets, movers + connectors, stats


def osm_paths(box, existing):
    """OSM ways where riding is legal and that the City data doesn't already cover."""
    p = RAW / "osm_overpass" / ("bike_allowed_paths.json" if box else "bike_allowed_paths_island.json")
    if not p.exists():
        return []
    ways = []
    for el in json.loads(p.read_text(encoding="utf-8"))["elements"]:
        t = el.get("tags", {})
        if t.get("access") in ("private", "no") or t.get("bicycle") in ("no", "dismount"):
            continue
        coords = [[g["lon"], g["lat"]] for g in el.get("geometry", [])]
        if len(coords) < 2 or (box and not in_box(coords, box)):
            continue
        hw = t.get("highway")
        if hw == "cycleway" or t.get("bicycle") == "designated":
            tier = 0
        elif hw == "service":
            tier = 3
        else:
            tier = 1
        name = t.get("name") or ("Bike path" if tier == 0 else "Park path" if hw in ("footway", "path", "pedestrian") else "Lane")
        ways.append((coords, tier, name, t.get("bridge") == "yes" or t.get("tunnel") == "yes", t.get("surface")))
    # split at vertices shared by two or more ways
    use = collections.Counter()
    for coords, *_ in ways:
        for c in coords:
            use[(round(c[0], 7), round(c[1], 7))] += 1
    pieces = []
    for coords, tier, name, struct, surface in ways:
        cur = [coords[0]]
        for c in coords[1:]:
            cur.append(c)
            if use[(round(c[0], 7), round(c[1], 7))] > 1 and c is not coords[-1]:
                pieces.append((cur, tier, name, struct, surface)); cur = [c]
        if len(cur) >= 2:
            pieces.append((cur, tier, name, struct, surface))
    # conflation: skip pieces that mostly run along an existing edge (already represented)
    elines = [LineString(e["xy"]) for e in existing]
    tree = STRtree(elines)
    out, skipped = [], 0
    for coords, tier, name, struct, surface in pieces:
        xy = to_metric(coords)
        line = LineString(xy)
        if line.length < 3:
            continue
        n = max(2, int(line.length // 8))
        covered = 0
        for i in range(n):
            pt = line.interpolate((i + 0.5) / n, normalized=True)
            q = line.interpolate(min(1.0, (i + 0.5) / n + 2 / max(line.length, 1)), normalized=True)
            hd = math.atan2(q.y - pt.y, q.x - pt.x)
            for ci in tree.query(pt.buffer(9)):
                if elines[ci].distance(pt) > 9:
                    continue
                s = elines[ci].project(pt)
                a1 = elines[ci].interpolate(max(0, s - 2)); a2 = elines[ci].interpolate(min(elines[ci].length, s + 2))
                he = math.atan2(a2.y - a1.y, a2.x - a1.x)
                diff = abs((hd - he + math.pi) % (2 * math.pi) - math.pi)
                if min(diff, math.pi - diff) < math.radians(30):
                    covered += 1
                    break
        if covered / n > 0.6:
            skipped += 1
            continue
        fl = F_OFFSTREET | F_OSM | (F_STRUCT if struct else 0) | (F_UNPAVED if surface in ("dirt", "gravel", "fine_gravel", "ground", "grass") else 0)
        out.append({"xy": xy, "tier": tier, "dir": 0, "name": name, "flags": fl, "src": "osm"})
    print(f"OSM bike-legal path pieces: {len(pieces)}, added {len(out)}, skipped as already covered {skipped}")
    return out


def main(extent):
    t0 = time.time()
    BUILD.mkdir(parents=True, exist_ok=True)
    PROTO_DATA.mkdir(parents=True, exist_ok=True)
    box = None
    if extent == "study":
        w, s, e, n = STUDY_BBOX
        box = (w - MARGIN, s - MARGIN, e + MARGIN, n + MARGIN)

    speeds = load_speed_limits()
    arterial = load_arterial()
    live = load_live_attrs()
    print(f"speeds {len(speeds)}, arterial {len(arterial)}, live attrs {len(live)}")

    # ---- City bike network, grouped by Géobase id ----
    bike_feats = json.loads((RAW / "mtl_reseau_cyclable" / "reseau_cyclable.geojson").read_text(encoding="utf-8"))["features"]
    gb_feats = json.loads((RAW / "mtl_geobase" / "geobase.json").read_text(encoding="utf-8"))["features"]
    gb_ids = {norm_id(f["properties"]["ID_TRC"]) for f in gb_feats}
    bike_by_trc = collections.defaultdict(list)
    offstreet = []
    for f in bike_feats:
        p = f["properties"]
        g = f["geometry"]
        lines = [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]
        if box and not any(in_box(l, box) for l in lines):
            continue
        lv = live.get(str(p["ID_CYCL"]), {})
        info = {
            "tier": TIER_BY_TYPE.get(int(p["TYPE_VOIE_CODE"]), 2),
            "type": int(p["TYPE_VOIE_CODE"]),
            "bidir": str(p.get("NBR_VOIE")) == "2" or int(p.get("TYPE_VOIE2_CODE") or 0) in CONTRAFLOW_TV2,
            "rev": (lv.get("revAxes") == "Oui") or (p.get("REV_AVANCEMENT_CODE") not in (None, "SO")),
            "4s": p.get("SAISONS4") == "Oui",
            "prot4s": p.get("PROTEGE_4S") == "Oui",
            "rv": p.get("ROUTE_VERTE") == "Oui",
            "closed_tmp": lv.get("avancementCode") == "FT",
            "struct": lv.get("structureCode") in ("2", "3", "4", "5"),
            "unpaved": lv.get("revetementCode") == "P",
        }
        tid = norm_id(p["ID_TRC"])
        if tid and tid in gb_ids:
            bike_by_trc[tid].append(info)
        else:
            for l in lines:
                offstreet.append((l, info))
    print(f"bike: on-street ids {len(bike_by_trc)}, off-street lines {len(offstreet)}")

    # ---- street edges from Géobase (metric coords) ----
    base = []
    for f in gb_feats:
        p = f["properties"]
        coords = f["geometry"]["coordinates"]
        if box and not in_box(coords, box):
            continue
        tid = norm_id(p["ID_TRC"])
        bikes = bike_by_trc.get(tid, [])
        cls, sens = int(p["CLASSE"]), int(p["SENS_CIR"])
        name = (p.get("ODONYME") or "").strip()
        tier, bidir = 3, False
        if bikes and all(b["closed_tmp"] for b in bikes):
            bikes = []  # bike facility temporarily closed: treat as the street it is on
        if bikes:
            tier = min(b["tier"] for b in bikes)
            bidir = any(b["bidir"] for b in bikes)
        elif cls in (2, 8):
            tier = 5
        elif arterial.get(tid) == 1 or speeds.get(tid, 30) >= 50 or cls in (6, 7) or name.startswith("Voie Privée"):
            tier = 4
        d = 3 if tier == 5 else 0 if (bidir or sens == 0) else (1 if sens == 1 else 2)
        flags = 0
        if bikes:
            if any(b["rev"] for b in bikes): flags |= F_REV
            if any(b["4s"] for b in bikes): flags |= F_4S
            if any(b["prot4s"] for b in bikes): flags |= F_PROT4S
            if any(b["rv"] for b in bikes): flags |= F_ROUTE_VERTE
            if any(b["unpaved"] for b in bikes): flags |= F_UNPAVED
        if int(p["POSITION"]) != 5 or any(b.get("struct") for b in bikes):
            flags |= F_STRUCT
        if name.startswith("Voie Non-nommée"):
            name = ""
        base.append({"xy": to_metric(coords), "tier": tier, "dir": d, "name": name, "flags": flags, "src": "g" + (tid or "")})
    print(f"street edges: {len(base)}")

    # ---- City off-street paths ----
    city_off = []
    for coords, info in offstreet:
        if len(coords) < 2:
            continue
        fl = F_OFFSTREET | (F_REV if info["rev"] else 0) | (F_4S if info["4s"] else 0) | (F_PROT4S if info["prot4s"] else 0) | \
            (F_ROUTE_VERTE if info["rv"] else 0) | (F_STRUCT if info["struct"] else 0) | (F_UNPAVED if info["unpaved"] else 0)
        city_off.append({"xy": to_metric(coords), "tier": 5 if info["closed_tmp"] else info["tier"],
                         "dir": 3 if info["closed_tmp"] else 0,
                         "name": "Multi-use path" if info["type"] == 7 else "Bike path", "flags": fl, "src": "b"})
    merge_endpoints(city_off, tol=2.0)
    base, city_off, st1 = snap_into(city_off, base, tol_node=12, tol_edge=12, tol_conn=30)
    print("city off-street snapping:", dict(st1))

    # ---- OSM bike-legal paths not covered by City data ----
    osm = osm_paths(box, base + city_off)
    merge_endpoints(osm, tol=1.0)
    targets = base + city_off
    targets, osm, st2 = snap_into(osm, targets, tol_node=6, tol_edge=6, tol_conn=15)
    print("OSM path snapping:", dict(st2))
    final = targets + osm

    # ---- nodes ----
    def key(x, y):
        return (round(x * 10), round(y * 10))

    nodes, edges = {}, []

    def node_of(x, y):
        k = key(x, y)
        if k not in nodes:
            nodes[k] = len(nodes)
        return nodes[k]

    for e in final:
        if len(e["xy"]) < 2:
            continue
        a = node_of(*e["xy"][0]); b = node_of(*e["xy"][-1])
        L = sum(math.dist(p, q) for p, q in zip(e["xy"], e["xy"][1:]))
        if L < 0.3 or (a == b and len(e["xy"]) < 3):
            continue
        edges.append(dict(e, a=a, b=b, len=L))
    node_xy = [None] * len(nodes)
    for (kx, ky), i in nodes.items():
        node_xy[i] = (kx / 10, ky / 10)

    # ---- keep the largest connected component ----
    adj = collections.defaultdict(list)
    for e in edges:
        if e["dir"] != 3:
            adj[e["a"]].append(e["b"]); adj[e["b"]].append(e["a"])
    comp, sizes = [-1] * len(node_xy), []
    for s in range(len(node_xy)):
        if comp[s] != -1 or s not in adj:
            continue
        cid = len(sizes); stack = [s]; comp[s] = cid; size = 0
        while stack:
            u = stack.pop(); size += 1
            for v in adj[u]:
                if comp[v] == -1:
                    comp[v] = cid; stack.append(v)
        sizes.append(size)
    main_c = int(np.argmax(sizes))
    print(f"components: {len(sizes)}; largest {sizes[main_c]} of {len(node_xy)} nodes; next {sorted(sizes, reverse=True)[1:6]}")
    for cid, size in sorted(enumerate(sizes), key=lambda kv: -kv[1])[1:3]:
        members = [i for i in range(len(node_xy)) if comp[i] == cid]
        clon, clat = TO_LL.transform(sum(node_xy[i][0] for i in members) / size, sum(node_xy[i][1] for i in members) / size)
        cn = collections.Counter(e["name"] for e in edges if comp[e["a"]] == cid)
        print(f"   dropped component: {size} nodes near ({clon:.5f}, {clat:.5f}); names {cn.most_common(4)}")
    keep = [i for i in range(len(node_xy)) if comp[i] == main_c]
    remap = {old: new for new, old in enumerate(keep)}
    edges = [e for e in edges if e["a"] in remap and e["b"] in remap]
    node_xy = [node_xy[i] for i in keep]
    for e in edges:
        e["a"] = remap[e["a"]]; e["b"] = remap[e["b"]]

    # ---- elevation (bare-earth DTM; bridges/tunnels interpolated between ends) ----
    if extent == "study":
        dem_path = RAW / "nrcan_hrdem_cmm2023" / "dtm_study_area_32188_1m.tif"
    else:
        # The 2023 LiDAR block covers only 61% of the island; `island_tiles.py dem` merges it with the 2024 block.
        # Without the merged file, 15% of the island's nodes got the median height (flat, with fake steps at the edge).
        dem_path = BUILD / "dtm_island_5m_merged.tif"
        if not dem_path.exists():
            raise SystemExit("Run `python tools/island_tiles.py dem` first: it builds data/build/dtm_island_5m_merged.tif")
    elev = None
    if dem_path.exists():
        dem = DEM(dem_path)
        elev = dem.sample([p[0] for p in node_xy], [p[1] for p in node_xy])
        elev = np.where(np.isnan(elev), np.nanmedian(elev), elev)
        for e in edges:
            ea, eb = float(elev[e["a"]]), float(elev[e["b"]])
            if e["flags"] & F_STRUCT:
                e["cf"], e["cb"] = max(0.0, eb - ea), max(0.0, ea - eb)
                continue
            line = LineString(e["xy"])
            n = max(2, int(line.length // 8) + 1)
            pts = [line.interpolate(i / (n - 1), normalized=True) for i in range(n)]
            z = dem.sample([p.x for p in pts], [p.y for p in pts])
            z = np.where(np.isnan(z), np.linspace(ea, eb, n), z)
            if n >= 5:
                z = np.convolve(np.pad(z, 2, mode="edge"), np.ones(5) / 5, mode="valid")
            z[0], z[-1] = ea, eb
            e["cf"], e["cb"] = climb_and_descent(z)

    # ---- encode ----
    names, name_idx = [""], {"": 0}
    out = {"meta": {"extent": extent, "built": time.strftime("%Y-%m-%d %H:%M"),
                    "bbox": STUDY_BBOX if extent == "study" else None,
                    "sources": ["Ville de Montreal: Geobase, reseau cyclable, live bike tiles, speed limits, arterial network (CC BY 4.0)",
                                "OpenStreetMap contributors: bike-legal paths not in City data (ODbL)",
                                ("NRCan HRDEM CMM 2023 1 m DTM (OGL-Canada)" if extent == "study" else "NRCan HRDEM CMM 2023 + 2024 LiDAR DTM, 5 m (OGL-Canada)")],
                    "tiers": ["A protected", "B painted/calm", "C shared", "D no bike lane (quiet)", "E no bike lane (busy)", "X closed"],
                    "flags": {"REV": F_REV, "4S": F_4S, "STRUCT": F_STRUCT, "CLOSED_TMP": F_CLOSED_TMP, "ROUTE_VERTE": F_ROUTE_VERTE,
                              "OFFSTREET": F_OFFSTREET, "UNPAVED": F_UNPAVED, "OSM": F_OSM, "CONNECTOR": F_CONNECTOR,
                              "PROT4S": F_PROT4S}},
           "nodes": [], "elev": [], "a": [], "b": [], "len": [], "tier": [], "dir": [], "name": [], "cf": [], "cb": [],
           "flags": [], "geom": [], "names": names}
    lons, lats = TO_LL.transform([p[0] for p in node_xy], [p[1] for p in node_xy])
    for lo, la in zip(lons, lats):
        out["nodes"] += [round(lo * 1e6), round(la * 1e6)]
    if elev is not None:
        out["elev"] = [int(round(float(v) * 10)) for v in elev]
    for e in edges:
        nm = e["name"]
        if nm not in name_idx:
            name_idx[nm] = len(names); names.append(nm)
        out["a"].append(e["a"]); out["b"].append(e["b"])
        out["len"].append(int(round(e["len"] * 10))); out["tier"].append(e["tier"]); out["dir"].append(e["dir"])
        out["name"].append(name_idx[nm]); out["flags"].append(e["flags"])
        out["cf"].append(int(round(e.get("cf", 0) * 10))); out["cb"].append(int(round(e.get("cb", 0) * 10)))
        inner = e["xy"][1:-1]
        enc = []
        if inner:
            ilon, ilat = TO_LL.transform([p[0] for p in inner], [p[1] for p in inner])
            px, py = out["nodes"][2 * e["a"]], out["nodes"][2 * e["a"] + 1]
            for lo, la in zip(ilon, ilat):
                qx, qy = round(lo * 1e6), round(la * 1e6)
                enc += [qx - px, qy - py]; px, py = qx, qy
        out["geom"].append(enc)

    tier_m = collections.Counter()
    for e in edges:
        tier_m[e["tier"]] += e["len"]
    print("km by tier:", {k: round(v / 1000, 1) for k, v in sorted(tier_m.items())})
    print(f"nodes {len(node_xy)}, edges {len(edges)}, names {len(names)}")
    js = json.dumps(out, separators=(",", ":"))
    (BUILD / f"graph_{extent}.json").write_text(js, encoding="utf-8")
    (PROTO_DATA / f"graph_{extent}.js").write_text(f"window.GRAPH_{extent.upper()}={js};\n", encoding="utf-8")
    print(f"wrote graph_{extent}.json ({len(js) / 1e6:.1f} MB) in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--extent", choices=["study", "island"], default="study")
    main(ap.parse_args().extent)
