# Piste: a Montreal bike commuter app

Working name. Started 2026-10-25 by Raph Roy-Jauvin, with Claude. **Stage: desktop web prototypes (3), routing working on real data.**

## The idea
- You enter a destination. The app routes you along bike infrastructure as much as possible, even when that is not the shortest path.
- While riding, it warns you calmly before any stretch with no bike infrastructure.
- Montreal first, built on the City's open data.
- Soft cartography with a 2D view and a 3D axonometric view (building massing, you seen from above).
- It shows places cyclists care about: BIXI, metro, cafés, food, water, repair, parks.

## Run the prototypes
Double-click `prototypes\start-prototypes.bat`, then open http://localhost:8765/. The gallery page links all three, with screenshots.

**On your iPhone now:** prototype C is published as a private Claude page: https://claude.ai/artifact/3E3fDAW11yQxLsDr1Y73WG. It's built from `prototypes/c-here-there`, with three.js r170 from jsDelivr and the data bundled. A and B need outside map tiles, which Claude pages block, so they'll come to the phone once we host the prototypes ourselves (GitHub Pages or Cloudflare Pages).

| Prototype | What's different |
|---|---|
| A · Positron (light, MapLibre) | Closest to a real app: route options with a direct ↔ bike-lanes slider, gap list, elevation profile, 2D/3D, simulated ride with roadside POIs and voice prompts |
| B · Métro Noir (dark, MapLibre) | Route drawn as a metro line in STM colours; strip map of the trip; POI side rails while riding; "metro view" schematic |
| C · Here & There (three.js) | True axonometric white model; the world ahead bends gently up and hills ahead are exaggerated; 3D cyclist |

## Decisions log
- 2026-10-25 (Raph): work in `C:\bikeapp`; Montreal and its open data; desktop browser first, phone later.
- 2026-10-25 (Raph): personal first, but built to become a public app. iPhone first; browser-only until permissions matter.
- 2026-10-25 (Raph): **summer-only** for now. Winter (4-season network) is noted for later.
- 2026-10-25 (Raph): **any dedicated bike facility counts as bike infrastructure**, including painted lanes, sharrows and shared streets. Warnings only for streets with **no** bike infrastructure at all.
- 2026-10-25 (Raph): warnings must be clear but calm (soft orange). Strong red only for roads closed to cyclists.
- 2026-10-25 (Raph): planned and under-construction bike routes show as a layer **while browsing only**, never when routing or riding.
- 2026-10-25 (Raph): 3D = building massing from open data; also show elevation (contours or relief). The 3D view is a one-button toggle (top-down ↔ bird's-eye), with exaggerated upcoming elevation, more subtle than "Here & There".
- 2026-10-25 (Raph): touch controls stay, plus options for voice and watch taps, chosen before navigation starts.
- 2026-10-25 (Raph): STM metro colours as the theme; a fun "view as metro" mode. Likes: Positron light, Esri dark, minimal maps.
- 2026-10-25 (Raph): English only for now; translate later. Code goes to GitHub (account `raphroyjauvin`). Downloads up to 10 GB at a time are OK.
- 2026-10-25 (Claude, from tests): **route in the browser**, on a graph built from the City's Géobase, the bike network and OSM paths. It matched or beat Valhalla, BRouter and OSRM on all 4 test trips, in about 0.1 ms instead of 330–700 ms. See `docs/05_routing.md`.
- 2026-10-25 (Claude): no server database needed to run the app: static files (data + router) on a free host or CDN. PostGIS/DuckDB stay optional analysis tools.

## Open questions for Raph
1. Which prototype's direction (or which mix) should we develop? See `docs/06_prototypes.md` for what to look at.
2. Phone testing: OK to publish the prototypes on a free HTTPS host (GitHub Pages or Cloudflare Pages) so you can try them on your iPhone?
3. GitHub: the connector shows as installed but not authorised in this session, and Git isn't installed on this PC. OK to install Git for Windows?
4. Working name: keep "Piste"?

## Folder map
- `CLAUDE.md`: working rules for Claude sessions.
- `docs/`:
  - `01_existing_apps.md`: competitor scan
  - `02_cartography.md`: cartography principles and palette
  - `03_data_sources.md`: data and freshness
  - `04_tech_options.md`: stack choices
  - `05_routing.md`: graph, weights, benchmarks
  - `06_prototypes.md`: guide to the three prototypes
  - `mapideas/`: Raph's reference maps
- `tools/`:
  - `fetch_data.py`: data refresh
  - `build_graph.py`: routing graph
  - `build_layers.py`: map layers
  - `compare_engines.py`, `bench_routing.js`: benchmarks
  - `serve.py`: dev server
  - `shots/`: screenshot and test scripts
- `prototypes/`:
  - `a-positron/`, `b-metro-noir/`, `c-here-there/`
  - `shared/`: router, common UI code, built data
  - `vendor/`: MapLibre 5.24, three.js r186
  - `screens/`
- `data/raw/`: downloads exactly as published, with `_download_log.csv`. Not in git; rebuild with `tools/fetch_data.py all`.
