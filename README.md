# Piste: a Montreal bike commuter app

Working name. Started 2026-10-25 by Raph Roy-Jauvin, with Claude. **Stage: one web prototype (A), routing on real data, published on GitHub Pages.**

## The idea
- You enter a destination. The app routes you along bike infrastructure as much as possible, even when that is not the shortest path.
- While riding, it warns you calmly before any stretch with no bike infrastructure.
- It shows the hills: clearly on the 2D map, and in 3D you feel a climb coming before you reach it.
- Montreal first, built on the City's open data.
- Soft cartography with a 2D view and a 3D bird's-eye view (LiDAR building heights and terrain).
- It shows places cyclists care about: BIXI, metro, cafés, food, water, repair, parks.

## Try it
- **On your phone:** https://raphroyjauvin.github.io/piste/ (in Safari, Share → Add to Home Screen opens it full screen).
- **On this PC:** double-click `prototypes\start-prototypes.bat`, then open http://localhost:8765/.
- **Phone screens on the monitor:** http://localhost:8765/phone.html shows the app inside iPhone-sized screens, side by side.
- `docs/06_prototypes.md` lists what's in the app and its URL options.

## Decisions log
- 2026-10-25 (Raph): work in `C:\bikeapp`; Montreal and its open data; desktop browser first, phone later.
- 2026-10-25 (Raph): personal first, but built to become a public app. iPhone first; browser-only until permissions matter.
- 2026-10-25 (Raph): **summer-only** for now. Winter (4-season network) is noted for later.
- 2026-10-25 (Raph): **any dedicated bike facility counts as bike infrastructure**, including painted lanes, sharrows and shared streets. Warnings only for streets with **no** bike infrastructure at all.
- 2026-10-25 (Raph): warnings must be clear but calm (soft orange). Strong red only for roads closed to cyclists.
- 2026-10-25 (Raph): planned and under-construction bike routes show as a layer **while browsing only**, never when routing or riding.
- 2026-10-25 (Raph): 3D = building massing from open data; also show elevation (contours or relief). The 3D view is a one-button toggle (top-down ↔ bird's-eye), with exaggerated upcoming elevation, more subtle than "Here & There".
- 2026-10-25 (Raph): touch controls stay, plus options for voice and watch taps, chosen before navigation starts.
- 2026-10-25 (Raph): STM metro colours as the theme. Likes: Positron light, Esri dark, minimal maps.
- 2026-10-25 (Raph): English only for now; translate later. Code goes to GitHub (account `raphroyjauvin`). Downloads up to 10 GB at a time are OK.
- 2026-10-25 (Claude, from tests): **route in the browser**, on a graph built from the City's Géobase, the bike network and OSM paths. It matched or beat Valhalla, BRouter and OSRM on all 4 test trips, in about 0.1 ms instead of 330–700 ms. See `docs/05_routing.md`.
- 2026-10-25 (Claude): no server database needed to run the app: static files (data + router) on a free host or CDN. PostGIS/DuckDB stay optional analysis tools.
- 2026-10-28 (Raph): **keep prototype A (Positron)**. Drop B (Métro Noir) entirely. Drop C (Here & There), keeping only its "hill ahead" feeling in the 3D ride. B and C remain in the first git commit.
- 2026-10-28 (Raph): elevation must be very clear in 2D. Built: soft elevation colours, stronger LiDAR shading, 5 m contours (labelled every 25 m), uphill chevrons on climbs.
- 2026-10-28 (Raph): the 3D ride camera sits lower, more behind the rider (not fully behind). Built: pitch 70°, rider at 70% of the screen height.
- 2026-10-28 (Raph): metro and BIXI icons should look like their real signs, without copyright problems. Built from scratch: white down-arrow on a blue disc for the metro; a BIXI-red tag with a plain bike.
- 2026-10-28 (Raph): public GitHub repo `raphroyjauvin/piste`, published with GitHub Pages.
- 2026-10-28 (Raph), to do: **suggest a ride**: a start point, loop or one-way, an optional stop by category (coffee, food, shopping, any map category) and a distance; the app suggests three routes.
- 2026-10-28 (Raph), to discuss: an AI agent that understands ride requests in plain language; simple graphics on the 3D massing by business type (cafés, shops…).
- 2026-10-28 (Claude): phone preview page (`prototypes/phone.html`) for designing the phone layout on the monitor; the real iPhone (via Pages) stays the final check.

## Open questions for Raph
1. Phone layout: the next design step (the desktop panel is only squeezed into a bottom sheet so far).
2. AI agent: which approach (see the discussion notes when we get there).
3. 3D storefront graphics: which style.
4. Working name: keep "Piste"?

## Folder map
- `CLAUDE.md`: working rules for Claude sessions.
- `docs/`:
  - `01_existing_apps.md`: competitor scan
  - `02_cartography.md`: cartography principles and palette
  - `03_data_sources.md`: data and freshness
  - `04_tech_options.md`: stack choices
  - `05_routing.md`: graph, weights, benchmarks
  - `06_prototypes.md`: what's in the app, URL options, phone preview
  - `mapideas/`: Raph's reference maps (local only, not in git)
- `tools/`:
  - `fetch_data.py`: data refresh
  - `build_graph.py`: routing graph
  - `build_layers.py`: map layers (elevation colours, hillshade, contours, terrain tiles, buildings, POIs…)
  - `compare_engines.py`, `bench_routing.js`: benchmarks
  - `serve.py`: dev server
  - `shots/`: tests (`test.mjs`), screenshots (`shoot.mjs`), app icons (`make_icons.mjs`)
- `prototypes/` (this folder is the published website):
  - `a-positron/`: the app
  - `phone.html`: the app on iPhone-sized screens
  - `about.html`: overview with screenshots
  - `shared/`: router, common UI code, built data, LiDAR terrain tiles
  - `vendor/`: MapLibre GL JS 5.24
  - `icons/`, `manifest.webmanifest`: home-screen app icon
  - `screens/`: screenshots
- `.github/workflows/pages.yml`: publishes `prototypes/` to GitHub Pages on every push to `main`.
- `data/raw/`: downloads exactly as published, with `_download_log.csv`. Not in git; rebuild with `tools/fetch_data.py all`.
