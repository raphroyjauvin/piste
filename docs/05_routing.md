# Routing: how it works and how it compares (2026-10-25)

## Decision
The router runs **in the browser**, on a compact graph we build ourselves. It needs no server, works offline, keeps your location on the device, and re-routes instantly when you drag a pin or move the slider. On the study area it routes in **0.02–0.4 ms**. Public routing servers take 330–700 ms per request over the network, and none of them lets you choose "bike lanes only" the way we do.

## The graph (`tools/build_graph.py`)
1. **Streets:** City Géobase segments (`ID_TRC`, `SENS_CIR` direction, `CLASSE`, `POSITION`).
   - `CLASSE` 8 (autoroutes, ramps) and 2 (underground) are closed to bikes unless a bike facility sits on them.
   - "Voie Privée" is treated as busy, to keep routes off private roads.
2. **Bike tier:** the City bike network, joined by `ID_TRC`.
   - Types 4, 5, 6, 7 = **A protected**; 3, 8 = **B painted/calm**; 1, 9 = **C shared**.
   - Two-way if `NBR_VOIE` = 2 or a contraflow code (`TYPE_VOIE2` 11, 30, 31, 33, 41, 43, 83, 84); otherwise it follows the street's direction.
   - The City's **live tiles** add REV axes, surface, bridges, and temporary closures (`avancementCode` FT). A closed facility falls back to the street's own class.
3. **Streets without a facility:**
   - **E busy** if arterial (RAAV `ARTERE` = 1), speed limit 50 km/h or more, or `CLASSE` 6–7.
   - **D quiet** otherwise.
4. **Off-street City paths** missing from the Géobase (about 140 in the study area):
   1. Their endpoints merge (2 m).
   2. They snap to a street node (≤ 12 m) or split a street (≤ 12 m).
   3. Failing that, they get a short **crossing link** (≤ 30 m) to the nearest street node. That fixed the Rachel path, which stops 27 m short of the Esplanade corner.
5. **OSM paths where bikes are legal** (`highway=cycleway`, or `bicycle=yes|designated|permissive` on paths and footways): 1,724 pieces.
   - **648 added**; 1,000 skipped as already covered (≥ 60% within 9 m and 30° of an existing edge).
   - They snap at 6 m, with links up to 15 m.
6. **Largest connected piece only.** Île Sainte-Hélène drops out of this cut because its bridges are closed to bikes in the data.
7. **Elevation:** NRCan HRDEM CMM 2023 1 m terrain.
   - Node heights, plus climbs sampled every 8 m along each edge (smoothed).
   - Bridges and tunnels are interpolated end to end, so the bare-earth surface doesn't invent dips under overpasses.

Result for the study area: 6,645 nodes, 10,526 edges, 0.7 MB.
- A: 158 km
- B: 100 km
- C: 46 km
- D: 433 km
- E: 353 km

## The router (`prototypes/shared/router.js`)
- **Search:** A* with a binary heap; cost = length × tier weight + climb × hill weight.
- **Weights:** "Most bike lanes" uses A 1.0, B 1.05, C 1.12, D 3.2, E 7. "Most direct" is all 1.0 (E 1.15). The slider blends the two.
- **Snapping:** each end of the trip tries up to 8 nearby edges, within 40 m of the closest, so the route can start on the far carriageway of a divided boulevard or on a quiet side street. That fixed a needless 190 m busy loop at Assomption metro.
- **Output:**
  - pieces by tier
  - gaps (runs of D/E) with street names
  - elevation profile and climb
  - turn-by-turn maneuvers
  - an along-route cursor for the ride simulation

## Benchmarks (`tools/bench_routing.js`, `tools/compare_engines.py`)
Share of each route on City bike infrastructure, scored the same way for every engine: 10 m samples matched to our graph within 14 m and 35°.

| Trip | Ours, most bike lanes | Ours, balanced | Ours, direct | Valhalla `use_roads` 0 | BRouter safety | OSRM bike |
|---|---|---|---|---|---|---|
| Parc La Fontaine → Parc via Rachel | 100% · 1.83 km | 100% · 1.83 km | 100% · 1.83 km | 100% · 1.83 km | 99% · 1.84 km | 99% · 1.84 km |
| Mont-Royal metro → Papineau | 87% · 1.94 km | 87% · 1.94 km | 0% · 1.06 km | 62% · 1.52 km | 46% · 1.57 km | 3% · 1.21 km |
| Assomption → Biodôme | 93% · 1.47 km | 93% · 1.47 km | 93% · 1.47 km | 76% · 1.89 km | 89% · 1.65 km | 86% · 1.64 km |
| Assomption → Ontario/Davidson | 91% · 4.23 km | 86% · 3.90 km | 79% · 3.83 km | 82% · 4.25 km | 88% · 4.03 km | 74% · 3.97 km |

Speed:
- **Ours:** 0.02–0.4 ms per route, graph load 15–30 ms.
- **Public servers:** OSRM ~350 ms, Valhalla ~400–700 ms, BRouter ~500–1,100 ms.

GraphHopper needs an API key, so it wasn't tested.

## Bugs found by testing (fixed)
- **Rachel was 400 m too long.** The park path didn't connect to Rachel/Esplanade, so the route detoured via Saint-Urbain and Duluth. Fixed with crossing links.
- **Olympic Park paths were missing.** Fixed by merging OSM bike-legal paths (Biodôme trip: 81% → 93% bike infrastructure, and 0.2 km shorter).
- **Divided boulevards forced a busy loop at the start.** Fixed with multi-candidate snapping.

## Next improvements
- **Intersections:** penalise turning onto or crossing an arterial without signals (City traffic-signal layer).
- **Time rules:** handle rush-hour-only lanes (`TYPE_VOIE2` 34, 35, 39, 94) and the summer pedestrian streets.
- **Island-wide graph:** about 50k segments. Expect roughly 1–5 ms per route.
- **Path names:** name off-street paths after the park they cross ("Parc La Fontaine path").
- **Live roadworks:** route around bike lanes blocked by works (`bikepath_blockedtype`).
- **Winter mode:** 4-season network only, for later.
