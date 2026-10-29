# Bike app (Montreal): instructions for Claude

This is Raph Roy-Jauvin's personal side project, separate from his day job. Never use work databases, scripts, credentials or files for it. This repo is public: keep anything about work out of it.

Read `README.md` first: decisions, open questions, folder map. Details are in `docs\`:
- `05_routing.md`: graph (study area and island), router, winter tiers
- `06_prototypes.md`: the app (prototype A), its URL options and the phone preview
- `03_data_sources.md`: data

## How to work here
- **Python:** `C:\bikeapp\.venv\Scripts\python.exe` (numpy, shapely, pyproj, rasterio, Pillow, mapbox-vector-tile). Run scripts with `-I`.
- **GIS command-line tools:** use QGIS's bundled GDAL in `C:\Program Files\QGIS 4.0.1\bin` with `PROJ_DATA` set; see `tools/build_layers.py`.
- **Data pipeline**, in order:
  1. `tools/fetch_data.py all` (raw data; re-runnable; logs to `data/raw/_download_log.csv`). `tools/fetch_data.py island` fetches just the island-only extras (OSM paths, 5 m terrain).
  2. `tools/build_graph.py --extent study`, and `tools/build_graph.py --extent island` for the island-wide graph. **The app loads `prototypes/shared/data/graph_island.js`.**
  3. `tools/build_layers.py` (study-area layers only)
  4. `node tools/bench_routing.js`
  5. `tools/compare_engines.py`
- **Classic rides:** after rebuilding the island graph or editing `prototypes/shared/data/classics.js`, run `node tools/check_classics.js`. It routes every classic ride and prints its length and bike-lane share, summer and winter.
- **Serve:** `tools/serve.py` on port 8765. The preview config is `.claude/launch.json` ("bikeapp-prototypes").
- **Test:**
  - `node tools/shots/test.mjs` runs functional smoke tests (exit code 1 if any fail).
  - `node tools/shots/shoot.mjs [prefix]` takes screenshots into `prototypes/screens/` (A = desktop, P = phone).
  - `node tools/shots/smoke.mjs "?winter=1"` is a quick load check: it opens one app URL and prints console errors and a few state values (the dev server must be running).
  - These all use headless Edge via playwright-core, because the in-app browser pauses when its pane is hidden.
  - `prototypes/phone.html` shows the app in iPhone-sized screens; the real iPhone (GitHub Pages) is the final check.
- **Publish:** `git push` to `main`; `.github/workflows/pages.yml` deploys `prototypes/` to https://www.raphroyjauvin.ca/piste/ (raphroyjauvin.github.io/piste forwards there). `PISTE_BASE=https://www.raphroyjauvin.ca/piste/` runs the tests against the live site. Git lives in `C:\Program Files\Git\cmd` (prefix PATH in each shell). The repo is public: never commit `docs/mapideas/`, raw data, credentials, or anything about Raph's work.

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
  - NRCan HRDEM (OGL-Canada)
  - STM GTFS
  - BIXI GBFS (station locations and live status)
  - Open-Meteo forecast (CC BY 4.0; free for non-commercial use: check the terms before a public launch)
  - Environment and Climate Change Canada radar (GeoMet)
  - Wikimedia Commons photo authors (credited on each card; see `prototypes/shared/photos/credits.json`)
- **Product rules from Raph:**
  - Summer is the default; winter mode (2026-10-29) routes on the 4-season network.
  - Any bike facility counts as infrastructure; warn only where there is none.
  - Warnings are calm (soft orange). Red is only for closed to cyclists.
  - Planned and under-construction routes appear only while browsing, never when routing or riding.
  - English and French (2026-10-29); every new string goes in `prototypes/shared/i18n.js` in both languages.
- When Raph decides something or a fact gets verified, add a dated line to the README decisions log or the matching doc, and tell him.

## Working with Raph
Raph knows GIS well (QGIS, PyQGIS, PostGIS). Explain web and app-development ideas in plain language, with GIS analogies where they help. He likes to see things: send screenshots (SendUserFile) when he's away from the desk.
