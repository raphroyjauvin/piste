# Routing: how it works and how it compares (2026-10-25)

## Update 2026-11-01: a reroute knows which way you are riding
- **Why:** on a ride in the Olympic Park he left the route on purpose and kept riding on a park path; each GPS reroute started at him and went back the way he came (an instant U-turn), and the distance to the next turn grew as he rode away.
- **Heading** (`headingFromFixes` in `shared/common.js`): the bearing over the last 20-40 m of good fixes, only when he is moving faster than 2 m/s (the phone's speed, else worked out from the fixes); otherwise none. `RideGPS` hands it to `onOffRoute`, and `newRouteFrom` in `app.js` passes it as `heading` (`planRoute` takes it in `settings.heading`).
- **Router** (`opts.heading`, degrees, in `Router.route`): for a start that is a point, each way out of a start candidate (toward a, toward b) more than 100 degrees from the heading is a U-turn and costs `U_TURN.metres` (200 m x the cheapest tier weight) extra. A rider more than 15 m off the street also pays it, on both ways out, when the street point is behind him (more than 100 degrees from his heading). So the route carries on ahead and turns back at a later turn unless turning round is clearly shorter. No heading, or a start that is already a snapped edge: identical to before. The detour cap is kept: the limit is worked out from the shortest route that does not turn back (`detourLimit(from, to, heading)`), and the heading is kept through the relaxing steps.
- **Loop:** no new cooldown needed. `RideGPS` already allows one reroute per 10 s (`GPS.REROUTE_MS`) after 5 s off route, and the new route starts where he is, so he is on it at once. The new test checks the gap.
- **Tests:** `node tools/check_routes.js` (section "heading-aware start": facing b the route starts toward b when that costs under 200 m more, still toward a when turning round saves more, facing a or no heading unchanged; fails if the heading is ignored). Browser: `heading comes from` (the heading function) and `riding straight on after leaving the route` (replay option `&straight`: at `detour=<m>` the rider turns off the route at a right angle and keeps going, ignoring new routes). The distance to the next turn is only listed there, not judged: it depends on the streets under the straight line.

## Update 2026-10-31: detour cap, and a graph bug that cut off Sainte-Anne-de-Bellevue (and about 190 other junctions)

### Detour cap (Raph, 2026-10-31; internal, nothing is shown in the app)
- **Rule:** "Your route" (with or without avoid hills or headwinds) and "Most bike paths" may be at most max(1.5 × the shortest legal route, shortest + 300 m) long. The shortest legal route is the same trip routed with every bike-legal segment costing just its length (`SHORTEST` in `router.js`). The 300 m floor stops a very short trip being pushed onto a busy street to save a few metres. Not capped: "Most direct" (keeps its own 1.15 listed limit), classic rides and Suggest a ride (those aim at a length).
- **How a route over the cap is fixed:** plan again with the strictness lowered by 0.15 a step (hill and wind settings kept), keep the first route that fits (so the most bike-path-heavy one that fits), and if none fits use the "Most direct" settings.
- **The API (all in `prototypes/shared/router.js`, used by the app and by `check_routes.js`, so they cannot drift apart):**
  - `routeSettings(kind, settings)`: the router options for "yourRoute", "mostLanes" or "mostDirect". `settings` = `{ strictness, avoidHills, wind }`.
  - `relaxSteps(kind, settings)`: the steps (a function of the step number; null after the last).
  - `router.detourLimit(from, to)`: the limit in metres.
  - `router.routeCapped(from, to, opts, relaxFn, limit)`: the generic method; the result has `limit` and `steps` (how many relaxations it took).
  - `router.planRoute(from, to, kind, settings, limit)`: what the app calls. `limit` is optional; pass `detourLimit()` when planning several kinds between the same two points, as `computeRoutes` does.
  - In `app.js`: `computeRoutes` and the GPS reroute (`newRouteFrom`, to the destination only; a reroute that rejoins a suggested or classic ride is not capped). `planSettings()` reads the slider, hills and wind.
- **Effect** (measured on the graph before the repair below): 154 of the 1,080 capped routes in `check_routes` were altered (10 of the 96 commute routes; 150 after the repair). The altered ones went from 17.9 km to 12.9 km on average and from 86.5% to 61.6% on bike paths. Example: Côte-des-Neiges to Peel metro, "Your route", summer, was 9.8 km at 99% on bike paths (2.2 × the shortest 4.4 km); it is now 4.6 km at 47% (5 relaxing steps). Average bike-path share over the 200 random trips: "Your route" 87.7% → 84.2%, "Most bike paths" 88.4% → 84.6%, winter 71.9% → 69.3% (the graph fix below then moved these to 84.0%, 84.3%, 68.8%).
- **`check_routes.js`:** plans these types with `router.planRoute`, like the app. A route over the cap is a failure. Added checks: the relaxing steps, the limit (floor and factor), a route that fits is returned unchanged, same input gives the same route, "Most direct" is not capped. It also measures planning speed.
- **Speed (measured):** one trip = three routes (2026-11-05: the app now plans only "Your route"; `check_routes.js` still plans all three). Without the cap: median 2.4 ms, 95th percentile 8.4 ms, 3.0 searches. With the cap: 3.8 ms, 25 ms, 5.0 searches (Node, desktop). In the app in Edge, `computeRoutes` took 0.9 to 6.3 ms on five trips, the hardest being 5 relaxing steps. The check fails if one trip takes over 1 s.
- **Supersedes** the "Long detours" limits above (1.8×, 2.0×) for the capped types: those are now the cap. They apply only to "Most direct" (1.15).

### Sainte-Anne-de-Bellevue village core: fixed (2026-10-31)
- **What the data says.** Rue Sainte-Anne is two-way in the City's data: Géobase `SENS_CIR` 0 (ID_TRC 1619225, 1619212, 4015520 to 4015524), and the bike network (`reseau_cyclable.geojson`) has bike facilities on it with `NBR_VOIE` 2 (ID_CYCL 24971, 26431, 23578) and no one-way attribute. Rue du Collège north of Rue Sainte-Anne is a real one-way: Géobase ID_TRC 1619224, `SENS_CIR` 1 (northbound), and no bike facility in the bike network. So the data supports neither "contraflow" nor "opening" it, and it stays one-way (`check_routes.js` checks that).
- **What was wrong (the 2026-10-30 note above was wrong too: it was not the one-ways).** In the graph, Rue Sainte-Anne was cut in two at -73.95305, 45.40404: the two halves ended 8 cm apart (nodes 22536 and 22537). `build_graph.py` splits a street where a path joins it. A short OpenStreetMap park-path spur at right angles to the street had both its ends snapped onto the street 17 cm apart, so the street became three pieces; the middle piece and the spur itself (both under 0.3 m) were thrown away by the `L < 0.3` rule while the two nodes stayed separate. That left the village core (35 intersections: Rue Sainte-Anne west of Rue du Collège, the park and bike paths, Route Verte, Pont Galipeault) connected to the rest only by Rue du Collège, which is one-way out. The car one-ways were innocent: they just made the break visible.
- **Fix (`tools/build_graph.py`, the nodes step).** A dropped sliver under 0.3 m now joins its two nodes into one. A closed (tier 5) sliver is left alone. No street direction changes. 488 slivers closed, 265 nodes merged.
- **Effect.** Pairs of intersections under 0.3 m apart with no segment between them: 193 → 0 (`check_routes.js` now fails on any). One-way dead-end intersections: 337 → 72 (largest area 35 → 7). The Sainte-Anne warning is gone. Pont Galipeault area to the east end of Rue Sainte-Anne: 894 m (35% on bike paths) and 1,355 m (25%) the other way, now 403 m (100%) both ways.
- **Side effects of the repair.** Counting the cap and the repair together, 37 of the 96 commute routes and 9 of the 20 classic-ride routes differ from the old baseline (the cap alone leaves the classics unchanged, so all 9 are from the repair). Classic rides: Old Port winter 12.8 km at 91% → 11.3 km at 87% (this one failed the 3-point baseline check; a shortcut that was cut off before), Point-Claire summer 56.7 km at 79% → 55.6 km at 81%, winter 65.4 km at 55% → 66.1 km at 59%, Lachine winter 85% → 88%; the others moved by under 0.5 km. Baseline re-recorded.

## Update 2026-10-30: route safety checks, two fixes, a known gap
`node tools/check_routes.js [--update] [--verbose]` plans routes on the island graph and fails on unsafe or broken ones. It runs in plain Node (no browser) in about 5 s. Run it after rebuilding the graph or changing the router. GitHub runs it before every publish (`06_prototypes.md`, "The published site").
- **What it routes: 1,380 routes in all.** 16 fixed commutes (Parc La Fontaine to McGill metro, Verdun metro to Square-Victoria, Lachine to Peel Basin, Côte-des-Neiges to Peel metro and others), 200 random trips of 1–15 km between points on bike-legal streets (the seed is fixed, so every run plans the same trips) and the 10 classic rides. Each is planned in every route type ("Your route", "Your route" with avoid hills, "Most bike paths", "Most direct", with the app's weights), summer and winter.
- **It fails on any of these:**
  - a closed or wrong-way segment (closed to bikes, or a one-way street ridden the wrong way)
  - a break in a route (two segments that don't meet)
  - the same street ridden twice
  - a cut-off part of the network (more than 300 m of bike-legal streets not joined to the main network; smaller pieces are warnings)
  - an expressway open to bikes (a road named Autoroute or Bretelle with no bike path on it)
  - one-way dead ends over 50 intersections (a group of intersections you can ride into but not out of, or the reverse; 10 to 50 is a warning)
  - no route found
  - for the fixed commutes, a start or end more than 150 m from the nearest bike-legal street
- **Baseline:** `tools/route_baseline.json` is a saved copy of the last good results. For commutes and classic rides, the check fails if the bike-path share drops by more than 3 points, the ride gets more than 15% longer, or the longest stretch on a busy street without a bike path grows by more than 300 m. For the random trips, the average bike-path share may not drop by more than 1.5 points. More one-way dead-end intersections than the baseline also fail. Improvements are listed but don't fail. After a change you meant to make, `--update` records the new results as the baseline. The exit code is 1 on failure. `--verbose` lists every warning, not just the first few.
- **Long detours** are listed and counted against the baseline (for the random trips, the count may not grow by more than 2 for a route type and season). A route is a long detour when it is longer than the limit times the shortest legal route (every bike-legal segment costs just its length) and more than 300 m longer. Limits: 1.8× for "Your route", 2.0× for "Most bike paths" and "Avoid hills", 1.15× for "Most direct". 41 are listed today (`--verbose`). Some are the price of staying on bike paths: Côte-des-Neiges → Peel comes out at 9.8 km on 99% bike paths, against 4.4 km for the shortest legal route. **Open question for Raph:** should detours be capped? (README, Open questions.)
- **Fix 1: the Samuel-De Champlain bridge bike path was one-way.** The graph copied the car direction of the expressway segment onto the bike path that runs beside it. That cut off the Brossard side of the bridge (334 intersections). Now a bike path on an expressway or ramp segment (Géobase `CLASSE` 2 or 8) is two-way (`tools/build_graph.py`). The graph was rebuilt.
- **Fix 2: no route from a one-way dead end.** A start or end on a dead-end one-way service road found no route (random trip 193). Now `route()` in `prototypes/shared/router.js` tries once more with more nearby segments (up to 16 candidates within 250 m of the nearest, instead of 8 within 40 m) before it gives up.
- **Known gap (fixed 2026-10-31, see the update above; this note was wrong about the cause): the Sainte-Anne-de-Bellevue village core.** 35 intersections around -73.9535, 45.4043 can't be ridden into, because their exits are one-way in the City's Géobase data (Rue Saint-Pierre, Rue du Collège, Route Transcanadienne). It is a gap in the data (the City's streets aren't connected in both directions), not a bug in the build. The check reports it as a warning (10 to 50 intersections). Same choice as for Habitat 67 below: ask the City, or override the segments in `tools/build_graph.py`.

## Update 2026-10-30: rerouting during a GPS ride
The router itself didn't change. A GPS ride (see `06_prototypes.md`, Ride) calls it again from where you are when you leave the route. Routes take 1–8 ms island-wide, so a reroute doesn't stall the ride.
- **When:** more than 30 m from the route (or the fix's accuracy + 10 m, whichever is larger; 60 m before you first reach it) for 5 s, at most once every 10 s. The numbers are in the tuning table in `06_prototypes.md`.
- **Same settings as the route you started** (`routeWeights()` and `selWeights()` in `a-positron/app.js`):
  - "Your route" and suggested rides: the Route style slider, "Avoid hills" and "Avoid headwinds" as they are now
  - "Most bike paths": the bike-path weights, hill weight 12 with "Avoid hills" ticked, else 4, plus the wind
  - "Most direct": the direct weights, hill weight 12 with "Avoid hills", else 0, no wind
  - a classic ride: the "Most bike paths" weights with hill weight 4, as when it was first routed
  - winter mode carries over, because the router keeps its winter tiers on
- **Where to:**
  - "Go somewhere": the destination.
  - Classic and suggested rides (they may loop or have a stop): the planned ride 250 m ahead of where you left it, so a loop doesn't send you straight home. Two helpers in `shared/common.js` do the joining: `tailRoute(route, D)` is the rest of a route from distance D on, as a route of its own (distances start at 0), and `joinRoutes(a, b)` rides route `b` after route `a` as one route, with a turn instruction where they meet. In GIS terms, it is a clip and a merge of lines. The sights and the stop still ahead are kept. If fewer than about 350 m of the ride are left, the new route goes straight to the end.
- **If the router finds no route** (for example you are far from any street it can snap to), the planned route stays, and a calm message says so once a minute at most.
- **Check:** the replay tests in `tools/shots/test.mjs` (a detour on a planned route, and on the Old Port classic ride).

## Update 2026-10-29: island-wide graph, winter tiers, multi-stop rides, avoiding headwinds

### Island-wide graph
- **Build:** `tools/fetch_data.py island` (OSM paths and the CMM 2023 terrain model for the island), then `tools/island_tiles.py dem` (the CMM 2024 terrain model, merged with 2023), then `tools/build_graph.py --extent island`. The app loads the result, `prototypes/shared/data/graph_island.js`. The study-area graph (`--extent study`) is still built; the benchmarks and `build_layers.py` read it.
- **Size:** 37,770 nodes, 56,315 edges, 4.7 MB. (Study area: 6,645 nodes, 10,526 edges, 0.7 MB.)
- **Inputs:**
  - the City Géobase and bike network (island-wide)
  - OSM bike-legal paths for the island (`osm_overpass/bike_allowed_paths_island.json`, 19,620 ways)
  - the merged 5 m terrain model for the island, `data/build/dtm_island_5m_merged.tif`: CMM 2023 (`nrcan_hrdem_cmm2023/dtm_island_32188_5m.tif`, 85 MB) where it has data, else CMM 2024 (`nrcan_hrdem_cmm2024/dtm_island_32188_5m.tif`, 55 MB); see "Elevations in the island graph" below
  - the island box is −73.985, 45.395, −73.465, 45.715 (the island, with the Jean-Drapeau islands and Île des Sœurs)
- **Speed:** 1–8 ms per route. Atwater Market → Pointe-Claire: 24.5 km, 82% on bike infrastructure, in 8 ms. (Study area: 0.02–0.4 ms.)
- **The map's bike network layer** is now drawn from the graph (tiers A–C, with the REV and 4-season flags), so `network.js` is no longer loaded. The other map layers (buildings, elevation, places, planned/works) became island-wide later the same day (PMTiles; see `06_prototypes.md`).
- **Disconnected pieces:** about 26% of the nodes fell in pieces that aren't connected to the main network, and were dropped. The build keeps the largest connected piece, as before. Most of the dropped nodes are Laval and Île-Bizard fragments and unconnected paths.
- **Speed limits and the arterial network** only exist for the City of Montréal, not the other island municipalities. There, the build has no speed limit (it assumes 30 km/h) and no arterial flag, so a street without a bike path counts as busy (E) only if its Géobase class is 6–7 or it is a private road. More streets read as quiet (D) there.

### Elevations in the island graph (2026-10-29)
- **Merged terrain model:** the NRCan CMM 2023 LiDAR block covers only about 61% of the island box. The CMM 2024 block of the same programme covers the rest, and the two agree to 0.02 m where they overlap. `tools/island_tiles.py dem` cuts the 2024 block like the 2023 one (5 m, same grid) and merges them into `data/build/dtm_island_5m_merged.tif` (2023 wins where both exist). `build_graph.py --extent island` reads that file and stops with a clear message if it is missing (run `island_tiles.py dem` first).
- **What was wrong before:** the island graph read only the 2023 block, so 15% of its nodes (5,569 of 37,770) got a filler median height: flat, with fake steps where the real data began.
- **Small wobbles ignored:** when an edge's climb and descent are added up (`climb_and_descent` in `build_graph.py`), rises and drops under 1 m (`CLIMB_MIN_STEP = 1.0`) are skipped. The 5 m model's small wobbles were adding up to metres of fake climbing on flat paths (6–9 m on a flat 1.3 km riverside path in LaSalle), enough to send routes onto Boulevard LaSalle. Climb minus descent still equals the net change. Classic-ride climbs went down to realistic numbers (Pointe-Claire 224 → 139 m, Verdun 115 → 88 m, Olympic 92 → 83 m). The study-area graph uses the same function; its current file was built before the change.
- **Credit in the graph file:** "NRCan HRDEM CMM 2023 + 2024 LiDAR DTM, 5 m (OGL-Canada)".
- **Check:** `node tools/check_routes.js` (safety checks, see the update at the top) and `node tools/check_classics.js` after rebuilding. The classic rides' lengths and shares still match `06_prototypes.md`. One waypoint needed moving (the Lachine ride; see `06_prototypes.md`).

### Winter tiers (`Router.setWinter`)
Winter mode changes the tier of the City's bike facilities. The graph keeps its summer tiers; the router works out the winter ones once, the first time winter is switched on, and swaps between the two sets. The inputs are two per-edge flags from the City's bike network: `SAISONS4` (in the 4-season network, cleared in winter) and `PROTEGE_4S` (a protected bike path that keeps its separators in winter).
- **Not in the 4-season network:** a bike path (tier A, B or C) that isn't cleared becomes tier D, "no bike path". The router treats it like a street without a facility, and the warnings say "without a winter-cleared bike path". It becomes D (quiet street) even if the street itself is busy.
- **Unplowed off-street paths** (parks, canal paths) also cost 2.5× on top, because of the snow. In the "Most bike paths" setting that is 3.2 × 2.5 = 8, a little more than a busy street (7).
- **Protected bike paths that lose their separators:** a tier A bike path that is in the 4-season network but isn't `PROTEGE_4S` counts as tier B, a painted bike path.
- **Everything else keeps its summer tier:** streets without a facility (D, E) and closed edges (X) don't change.

### Per-edge penalty and `join()` (rides with stops or waypoints)
- **Per-edge penalty:** `route(from, to, { penalty })` accepts a list with one multiplier (1 or more) per edge. The cost of an edge is length × tier weight × penalty × winter penalty × wind multiplier (only when avoiding headwinds), plus climb × hill weight. Think of a cost field on a network analysis layer: a high value pushes the least-cost path elsewhere without closing the street.
  - Suggest a ride and the classic rides use it so the way back differs: after each leg, the edges already ridden get 4× for the legs that follow. (Two classic rides, the Parc Jean-Drapeau islands and the out-and-back Pointe-Claire ride, switch this off with `avoidBack`.)
  - The winter 2.5× for unplowed off-street paths works the same way. It is stored separately and applied automatically in winter mode.
- **`join(parts, stopLabels)`:** chains several routes end to end into one route, for a ride through stops or waypoints. In GIS terms, it merges line features end to end into one feature. It adds up length, climb and cost, merges the pieces and gaps that meet at a join, stitches the elevation profile together and rebuilds the turn instructions across the joins. `stopLabels[i]` names the stop between parts *i* and *i* + 1 and becomes a "Stop: …" step; a sight becomes "Sight: …"; a plain waypoint gets no step.
- **Classic rides** (`prototypes/shared/data/classics.js`) are routed live, leg by leg through their waypoints, with the "Most bike paths" weights and a hill weight of 4, then joined. In winter mode the legs are routed again on the winter tiers.

### Avoid headwinds (`Router.windCost`)
- **What it does:** with "Avoid headwinds" ticked, today's wind changes the cost of every street, one direction at a time. Riding into the wind costs more, so routes prefer streets where the wind is behind you or across you. It applies to "Your route", "Most bike paths" and the suggested rides; "Most direct" doesn't use it.
- **`router.windCost(toDeg, W, speedFn)`** returns `{ windFwd, windBack }`: one multiplier per edge for riding it from its first node to its second (`windFwd`) and the other way (`windBack`).
  - `toDeg` is the direction the wind blows to. `W` is the wind at rider height in m/s (60% of the 10 m forecast). `speedFn` is the riding-speed function in `shared/weather.js` (`speedWith`): the speed that holds the effort of a 16 km/h ride in still air, given a head wind component.
  - For each edge and direction, the wind component along it is `W × cos(edge bearing − toDeg)`. The multiplier is 16 km/h ÷ the speed with that component, and never below 1.
  - Only headwinds cost extra. A tailwind gives 1, not less, so the A* distance estimate stays a lower bound. A crosswind counts only through its component along the edge.
- **In the cost:** `route(from, to, { windFwd, windBack })` multiplies an edge's cost by the multiplier for the direction it is ridden: length × tier weight × penalty × winter penalty × wind, plus climb × hill weight. Like the climb cost, it depends on the direction.
- **In the app** (`a-positron/app.js`, `windWeights()`): used only when the box is ticked, the forecast is loaded and the wind is at least 6 km/h. It is built once per wind reading (direction and speed) and cached until the wind changes.
- **Speed and size:** building the multipliers for the whole island takes about 28 ms. The largest multiplier seen was 1.74×.

### Data issue: Habitat 67
- A segment near Habitat 67 is one-way in the City's data. Riding from the city toward Habitat 67 can't use it, so the router detours. The other direction is fine.
- The classic rides were designed around it. It isn't fixed in our graph.
- To decide: ask the City about the segment, or override it in `tools/build_graph.py`.

### Data issue: Sainte-Anne-de-Bellevue village core (found 2026-10-30, fixed 2026-10-31: a build bug, not the data; see the update at the top)
- 35 intersections around -73.9535, 45.4043 can't be ridden into, because their exits are one-way in the City's Géobase data (Rue Saint-Pierre, Rue du Collège, Route Transcanadienne). Not fixed.
- `check_routes.js` reports it as a warning (a group of 10 to 50 intersections). It would fail the check at more than 50.
- To decide: the same as for Habitat 67 (ask the City, or override the segments in `tools/build_graph.py`).

## Decision
The router runs **in the browser**, on a compact graph we build ourselves. It needs no server, works offline, keeps your location on the device, and re-routes instantly when you drag a pin or move the slider. On the study area it routes in **0.02–0.4 ms**. Public routing servers take 330–700 ms per request over the network, and none of them lets you choose "bike paths only" the way we do.

## The graph (`tools/build_graph.py`)
1. **Streets:** City Géobase segments (`ID_TRC`, `SENS_CIR` direction, `CLASSE`, `POSITION`).
   - `CLASSE` 8 (autoroutes, ramps) and 2 (underground) are closed to bikes unless a bike facility sits on them. Since 2026-10-30, a bike path on such a segment is two-way: it runs beside the expressway, so the cars' one-way doesn't apply (see the update at the top).
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
7. **Elevation:** study area: NRCan HRDEM CMM 2023 1 m terrain. Island: the merged CMM 2023 + 2024 5 m terrain model (see "Elevations in the island graph" above).
   - Node heights, plus climbs sampled every 8 m along each edge (smoothed over 5 samples; rises and drops under 1 m ignored).
   - Bridges and tunnels are interpolated end to end, so the bare-earth surface doesn't invent dips under overpasses.

Result for the study area: 6,645 nodes, 10,526 edges, 0.7 MB.
- A: 158 km
- B: 100 km
- C: 46 km
- D: 433 km
- E: 353 km

## The router (`prototypes/shared/router.js`)
- **Search:** A* with a binary heap; cost = length × tier weight + climb × hill weight.
- **Planning a trip (2026-10-31):** `planRoute(from, to, kind, settings, limit)` plans "Your route", "Most bike paths" or "Most direct" and applies the detour cap to the first two (see the update at the top). It is deterministic: the same trip and settings give the same legs.
- **Weights:** "Most bike paths" uses A 1.0, B 1.05, C 1.12, D 3.2, E 7. "Most direct" is all 1.0 (E 1.15). The slider blends the two.
- **Snapping:** each end of the trip tries up to 8 nearby edges, within 40 m of the closest, so the route can start on the far carriageway of a divided boulevard or on a quiet side street. That fixed a needless 190 m busy loop at Assomption metro. A point more than 400 m from the nearest edge can't be snapped and has no route; that is why a suggested stop that far from the bike network is skipped. If no route comes out (for example the start sits on a dead-end one-way service road), `route()` tries once more with more candidates: up to 16, within 250 m of the nearest instead of 8 within 40 m (2026-10-30).
- **Output:**
  - pieces by tier
  - gaps (runs of D/E) with street names
  - elevation profile and climb
  - turn-by-turn maneuvers
  - an along-route cursor for the ride simulation

### Avoid construction (2026-11-02)
- **What it does.** An edge within 25 m of an active work site costs 6 times as much (`WORKS` in `router.js`): a penalty, not a closure, so a route still exists when there is no other way. `Router.worksPenalty(points)` builds the per-edge multipliers once (spatial grid, `Float32Array`); `opts.worksPen` carries them into `route()`, and `routeSettings` / `relaxSteps` keep them, so the detour cap (`planRoute`), the relaxing steps, suggested rides and GPS reroutes all respect the option.
- **Which works.** The same points the map shows (`PLANNED`, status `works`, the City's Info-travaux permits that block a bike path), minus any whose `until` date has passed (`activeWorks`). The snapshot in `planned.js` was taken 2026-10-29, so the map still shows a few expired cones; routing ignores them.
- **In the app.** Checkbox "Avoid construction" ("Éviter les chantiers"), off by default, localStorage `piste-avoid-works`.
- **Tests.** `tools/check_routes.js` (section "Avoid construction"): a fake work site on a mid-route edge moves the route off it in most trips and never changes it when the option is off; the detour cap holds; the penalty survives the relaxing steps. `test.mjs`: "avoid construction: …" (the checkbox moves the real route off a fake work site).

## Benchmarks (`tools/bench_routing.js`, `tools/compare_engines.py`)
Share of each route on City bike infrastructure, scored the same way for every engine: 10 m samples matched to our graph within 14 m and 35°.

| Trip | Ours, most bike paths | Ours, balanced | Ours, direct | Valhalla `use_roads` 0 | BRouter safety | OSRM bike |
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
- **The Samuel-De Champlain bridge bike path was one-way** (found by `check_routes.js`, 2026-10-30). It copied the expressway segment's car direction and cut off the Brossard side (334 intersections). Fixed in `tools/build_graph.py`: bike paths on expressway or ramp segments (classes 2 and 8) are two-way. Graph rebuilt (still 37,770 nodes and 56,315 edges).
- **Streets cut by a dropped 8 cm sliver** (found 2026-10-31 while looking into Sainte-Anne-de-Bellevue): see the update at the top. 193 gaps, fixed in `build_graph.py` and guarded by `check_routes.js`.
- **No route from a dead-end one-way service road** (random trip 193, 2026-10-30). Fixed by a second try with more nearby segments (see Snapping).

## Next improvements
- **Detour cap:** decide whether to limit how much longer than the shortest legal route a route may be (open question for Raph; see the update at the top).
- **Sainte-Anne-de-Bellevue:** the village core's one-way exits (see "Data issue" above).
- **Intersections:** penalise turning onto or crossing an arterial without signals (City traffic-signal layer).
- **Time rules:** handle rush-hour-only bike paths (`TYPE_VOIE2` 34, 35, 39, 94) and the summer pedestrian streets.
- **Island-wide graph:** done 2026-10-29 (37,770 nodes, 56,315 edges; 1–8 ms per route). See the update at the top.
- **Path names:** name off-street paths after the park they cross ("Parc La Fontaine path").
- **Live roadworks:** done 2026-11-02 as the "Avoid construction" option (see above); not on by default. Still open: a cone-to-edge match that uses the impacted street rather than the permit point.
- **Winter mode:** done 2026-10-29 (4-season network only; see the update at the top). Still open: real-time clearing status, which isn't public. The City's Planif-Neige API needs an access token and covers streets, not bike paths or sidewalks. The City will send a token when the 2026-2027 version restarts, so it is shelved until winter (2026-10-30). It may help later for streets without a bike path.
