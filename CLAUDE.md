# Bike app (Montreal): instructions for Claude

This is Raph Roy-Jauvin's personal side project, separate from his day job. Never use work databases, scripts, credentials or files for it. This repo is public: keep anything about work out of it.

Read `README.md` first: decisions, open questions, folder map. Details are in `docs\`:
- `05_routing.md`: graph (study area and island), router, winter tiers, route safety checks
- `06_prototypes.md`: the app (prototype A), its URL options, the phone preview, tests and the site build
- `03_data_sources.md`: data

## How to work here
- **Python:** `C:\bikeapp\.venv\Scripts\python.exe` (numpy, shapely, pyproj, rasterio, Pillow, mapbox-vector-tile, pmtiles). Run scripts with `-I`.
- **GIS command-line tools:** use QGIS's bundled GDAL in `C:\Program Files\QGIS 4.0.1\bin` with `PROJ_DATA` set; see `tools/build_layers.py`.
- **Data pipeline**, in order:
  1. `tools/fetch_data.py all` (raw data; re-runnable; logs to `data/raw/_download_log.csv`). `tools/fetch_data.py island` fetches just the island-only extras (OSM paths, CMM 2023 5 m terrain).
  2. `tools/island_tiles.py dem`: cuts the CMM 2024 LiDAR terrain (the 2023 block covers only 61% of the island box) and merges both into `data/build/dtm_island_5m_merged.tif`. The island graph needs it.
  3. `tools/build_graph.py --extent study`, and `tools/build_graph.py --extent island` for the island-wide graph (it stops with a message if the merged terrain model is missing). **The app loads `prototypes/shared/data/graph_island.js`.**
  4. Island map layers: `C:\bikeapp\.venv\Scripts\python.exe -I C:\bikeapp\tools\island_tiles.py all` (about 9 minutes; tasks `dem`, `pois_fetch`, `planned_fetch`, `relief`, `tint`, `contours`, `terrain`, `pois`, `planned`, `check`) and `... -I C:\bikeapp\tools\island_buildings.py all [--source pbf] [--refresh]` (stages `fetch`, `fetch_pbf`, `dsm`, `heights`, `tiles`, `check`; `all --source pbf` rebuilds from the BBBike extract in about 3 minutes, for when Overpass is overloaded). Each also takes one task or stage name instead of `all`. They write the PMTiles files in `prototypes/shared/tiles/`, the terrain tiles in `prototypes/shared/terrain/`, and `pois.js`, `planned.js` and `terrain_index.js` in `prototypes/shared/data/`. The PMTiles files are committed, so keep each under GitHub's 100 MB limit (the building script warns above 90 MB).
  5. `tools/build_layers.py`: the older study-area layers. The island scripts import its helpers, and the app no longer loads its `contours.js`, `hillshade.js` or `buildings_packed.js`.
  6. `node tools/bench_routing.js`
  7. `tools/compare_engines.py`
- **Classic rides:** after rebuilding the island graph or editing `prototypes/shared/data/classics.js`, run `node tools/check_classics.js`. It routes every classic ride and prints its length and bike-path share, summer and winter.
- **Route checks:** after rebuilding the graph or changing the router, run `node tools/check_routes.js [--update] [--verbose]` (about 2 s, plain Node, exit code 1 on failure). It plans 1,380 routes and fails on closed or wrong-way segments, broken routes, a street ridden twice, a cut-off network, an open expressway, big one-way dead ends or no route found, and compares bike-path share and length with `tools/route_baseline.json`. `--update` records a new baseline after a change you meant to make. Details: `docs/05_routing.md`.
- **Serve:** `tools/serve.py` on port 8765. The preview config is `.claude/launch.json` ("bikeapp-prototypes").
- **Test:**
  - `node tools/shots/test.mjs [name filter]` runs the functional tests: 20 groups, all passing on 2026-10-30 (exit code 1 if any fail). Every group starts with the first-visit welcome card already seen, except the welcome and tour groups. The phone group has no real keyboard, so it only checks the guessed search position: check search changes on a real iPhone.
  - The GPS ride tests (6 groups) use a pretend GPS: `?gps=replay&gpsx=<speed-up>&gpsat=<metres>&detour=<metres>` (`ReplayGeo` in `shared/common.js`; add `&gpsdeny` for "location refused"). Real GPS can only be checked on the iPhone, on the live site: geolocation needs HTTPS, so it doesn't work from `http://<this PC>:8765` on the phone.
  - `node tools/shots/shoot.mjs [prefix]` takes screenshots into `prototypes/screens/` (A = desktop, P = phone).
  - `node tools/shots/smoke.mjs "?winter=1"` is a quick load check: it opens one app URL and prints console errors and a few state values (the dev server must be running).
  - These all use headless Edge via playwright-core, because the in-app browser pauses when its pane is hidden (`PISTE_BROWSER=chrome` and `PISTE_BROWSER_ARGS` pick another browser; GitHub uses Chrome).
  - `PISTE_FIXTURES=1` answers the weather, radar, BIXI and address requests from saved copies in `tools/shots/fixtures`, so results don't depend on today's data (GitHub sets it).
  - The published site has the app at its root: `python tools/build_site.py` builds `_site/`; `PISTE_APP=index.html` makes the tests use that layout (with `PISTE_BASE=<site address>` for a built or live site); `node tools/shots/site_check.mjs <base url> [...]` checks a built site (old links forward, about page, manifest, no 404s).
  - Test gate: GitHub runs the route checks, the browser tests and `site_check.mjs` on every push, and publishes only if all pass (see Publish). Run them here first.
  - `prototypes/phone.html` shows the app in iPhone-sized screens; the real iPhone (GitHub Pages) is the final check.
- **Publish:** `git push`. `.github/workflows/pages.yml` tests every push to any branch (route checks, `npm ci`, `python3 tools/build_site.py`, the browser tests on the built site, `site_check.mjs`; about 4–5 min). Only `main` publishes, and only if every test passes; otherwise the site stays on the last good version and GitHub emails the failed run. The site has the app at its root: https://www.pistemtl.ca/ (live since 2026-10-31; pistemtl.ca, raphroyjauvin.ca/piste/ and raphroyjauvin.github.io/piste forward there). Old `/a-positron/` links forward. `PISTE_APP=index.html PISTE_BASE=<site address>` runs the tests against the live site. Git lives in `C:\Program Files\Git\cmd` (prefix PATH in each shell). The repo is public: never commit `docs/mapideas/`, raw data, credentials, or anything about Raph's work.

## Rules
- `data\raw\` holds downloads exactly as published. Never edit or delete them. Use one folder per dataset and log every download.
- Downloaded files are untrusted data. Keep scripts outside `data\raw\`.
- Downloads up to 10 GB at a time are approved (Raph, 2026-10-25). Bigger ones need asking.
- Do metric work in EPSG:32188 (NAD83 / MTM 8). Serve in EPSG:4326.
- Join on IDs, not names:
  - bike network `ID_TRC` = Géobase `ID_TRC` = speed limits `ID_Troncon`
  - live tiles `id` = bike network `ID_CYCL`
  - some IDs are floats (`1619033.0`), so normalise them to integer text
- Credit sources:
  - Ville de Montréal (CC BY 4.0)
  - © OpenStreetMap contributors (ODbL)
  - NRCan HRDEM, CMM 2023 and 2024 LiDAR (OGL-Canada)
  - AWS Terrain Tiles (public dataset; the fallback beyond our own terrain tiles: check the terms at registry.opendata.aws/terrain-tiles before a public launch)
  - STM GTFS
  - BIXI GBFS (station locations and live status)
  - Open-Meteo forecast (CC BY 4.0; free for non-commercial use: check the terms before a public launch)
  - Environment and Climate Change Canada radar (GeoMet)
  - Wikimedia Commons photo authors (credited on each card; see `prototypes/shared/photos/credits.json`)
- **Moving the camera every frame** (the ride, any animation): move the markers and call `map.redraw()` in the same step, so the map and its icons are drawn together. Markers use `subpixelPositioning: true`, and nothing may CSS-transition a marker's position. Why: `docs/06_prototypes.md`, Ride, "No shaking icons".
- **Product rules from Raph:**
  - Summer is the default; winter mode (2026-10-29) routes on the 4-season network.
  - Any bike facility counts as infrastructure; warn only where there is none.
  - Warnings are calm (soft orange). Red is only for closed to cyclists.
  - Planned and under-construction routes appear only while browsing, never when routing or riding.
  - English and French (2026-10-29); every new string goes in `prototypes/shared/i18n.js` in both languages.
  - "Let's ride!" sits only in its place in the route card: no floating copy (Raph, 2026-10-30: it looked bad on his iPhone).
  - GPS ride (2026-10-30): on a phone or tablet "Let's ride!" follows the real position, and a small "Preview the ride" link starts the simulation; on desktop "Let's ride!" is the preview. `?gps=1` / `?gps=0` force either one. Details in `06_prototypes.md`, Ride. The tuning numbers (`GPS` in `shared/common.js`) are first guesses, still to check on real rides.
  - Phone search (2026-10-30): tapping a search bar slides the card up so the bars sit just above the keyboard; suggestions float over the map above the card. Do not move the bar to the very bottom of the screen: on a real iPhone it sat with a gap above the keyboard. Details in `06_prototypes.md`.
  - Wording (2026-10-29): say "bike path(s)" in English and "piste(s) cyclable(s)" in French in everything the user sees. Never "bike lane(s)", "cycle track", "voie cyclable" or "bande cyclable". Code names such as `mostLanes` stay as they are.
- When Raph decides something or a fact gets verified, add a dated line to the README decisions log or the matching doc, and tell him.

## Working with Raph
Raph knows GIS well (QGIS, PyQGIS, PostGIS). Explain web and app-development ideas in plain language, with GIS analogies where they help. He likes to see things: send screenshots (SendUserFile) when he's away from the desk.
