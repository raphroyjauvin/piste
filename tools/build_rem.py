"""Builds prototypes/shared/data/rem.js (window.REM) from the OpenStreetMap download in data/raw/osm_rem/rem.json
(tools/fetch_data.py rem): the REM light-rail tracks, joined and simplified to about 2 m, and the stations.

  window.REM = { color, note, lines: [[[lon, lat], ...], ...], stations: [[name, lon, lat], ...] }

Only what OSM maps as a REM route is drawn. Run with the project's Python: .venv/Scripts/python.exe -I tools/build_rem.py
"""
import json
from pathlib import Path

from shapely.geometry import LineString
from shapely.ops import linemerge

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "raw" / "osm_rem" / "rem.json"
OUT = ROOT / "prototypes" / "shared" / "data" / "rem.js"
GREEN = "#84BD00"   # the colour OSM gives the REM routes
NOTE = ("In service per OpenStreetMap (2026-11-02): the Deux-Montagnes and Anse-a-l'Orme branches and the South Shore line, "
        "all REM routes OSM carries without a construction or proposed tag. Planned and not drawn: the Aeroport-Trudeau branch.")


def main():
    els = json.loads(SRC.read_text(encoding="utf-8"))["elements"]
    ways = {}
    for rel in (e for e in els if e["type"] == "relation"):
        for m in rel["members"]:
            if m["type"] == "way" and m.get("geometry"):
                ways[m["ref"]] = [(p["lon"], p["lat"]) for p in m["geometry"]]
    merged = linemerge([LineString(g) for g in ways.values()])
    parts = list(merged.geoms) if merged.geom_type == "MultiLineString" else [merged]
    lines = [[[round(x, 5), round(y, 5)] for x, y in p.simplify(0.00002).coords] for p in parts]
    stations = {}
    for e in els:
        t = e.get("tags", {})
        if e["type"] == "node" and t.get("public_transport") == "station" and "REM" in t.get("network", ""):
            stations[e["id"]] = [t["name"], round(e["lon"], 5), round(e["lat"], 5)]
    data = {"color": GREEN, "note": NOTE, "lines": lines, "stations": sorted(stations.values())}
    OUT.write_text("window.REM=" + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")
    print(f"rem.js: {len(ways)} ways -> {len(lines)} lines ({sum(len(l) for l in lines)} points), {len(stations)} stations, {OUT.stat().st_size / 1e3:.0f} KB")


if __name__ == "__main__":
    main()
