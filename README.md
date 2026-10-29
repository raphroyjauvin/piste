# Piste: a Montreal bike commuter app

Working name. Started 2026-10-25 by Raph Roy-Jauvin, with Claude. **Stage: one web prototype (A), routing on real data across the whole island, published on GitHub Pages.**

## The idea
- You enter a destination. The app routes you along bike infrastructure as much as possible, even when that is not the shortest path.
- While riding, it warns you calmly before any stretch with no bike infrastructure.
- It shows the hills: clearly on the 2D map, and in 3D you feel a climb coming before you reach it.
- Montreal first, built on the City's open data. Routing covers the whole island.
- Soft cartography with a 2D view and a 3D bird's-eye view (LiDAR building heights and terrain).
- It shows places cyclists care about: BIXI (with live bikes available), metro, cafés, food, water, repair, parks.
- It suggests rides: ten classic Montréal rides, or your own loop or one-way ride with a stop.
- It has a winter mode (only the 4-season network counts), a wind and rain layer, and an English / Québec French switch.

## Try it
- **On your phone:** https://www.raphroyjauvin.ca/piste/ (in Safari, Share → Add to Home Screen opens it full screen). GitHub Pages serves it on Raph's own domain; raphroyjauvin.github.io/piste forwards there.
- **On this PC:** double-click `prototypes\start-prototypes.bat`, then open http://localhost:8765/.
- **Phone screens on the monitor:** http://localhost:8765/phone.html shows the app inside iPhone-sized screens, side by side.
- **Links that open a given view:** add options to the app's address, for example https://www.raphroyjauvin.ca/piste/a-positron/?winter=1 (the short address forwards without them). Newer options:
  - `?classic=<id>`: open a classic ride (the ids are listed in `docs/06_prototypes.md`)
  - `?winter=1`: winter mode on
  - `?wx=1`: wind and rain layer on
  - `?lang=fr`: French (`?lang=en` for English)
  - `?suggest=loop|oneway&km=&stop=`: open "Suggest a ride", with a distance in km and a stop: `cafe`, `food`, `bakery`, `icecream`, `bar`, `toilets`, `park`, `culture` or `bikeshop`
- `docs/06_prototypes.md` lists what's in the app and all its URL options.

## Decisions log
- 2026-10-25 (Raph): work in `C:\bikeapp`; Montreal and its open data; desktop browser first, phone later.
- 2026-10-25 (Raph): personal first, but built to become a public app. iPhone first; browser-only until permissions matter.
- 2026-10-25 (Raph): **summer-only** for now. Winter (4-season network) is noted for later. (Winter mode was built on 2026-10-29, see below.)
- 2026-10-25 (Raph): **any dedicated bike facility counts as bike infrastructure**, including painted lanes, sharrows and shared streets. Warnings only for streets with **no** bike infrastructure at all.
- 2026-10-25 (Raph): warnings must be clear but calm (soft orange). Strong red only for roads closed to cyclists.
- 2026-10-25 (Raph): planned and under-construction bike routes show as a layer **while browsing only**, never when routing or riding.
- 2026-10-25 (Raph): 3D = building massing from open data; also show elevation (contours or relief). The 3D view is a one-button toggle (top-down ↔ bird's-eye), with exaggerated upcoming elevation, more subtle than "Here & There".
- 2026-10-25 (Raph): touch controls stay, plus options for voice and watch taps, chosen before navigation starts. (The "Before you ride" sheet that held them was removed on 2026-10-29; sound is now a button in the ride bar, see below.)
- 2026-10-25 (Raph): STM metro colours as the theme. Likes: Positron light, Esri dark, minimal maps.
- 2026-10-25 (Raph): English only for now; translate later. Code goes to GitHub (account `raphroyjauvin`). Downloads up to 10 GB at a time are OK. (French was built on 2026-10-29, see below.)
- 2026-10-25 (Claude, from tests): **route in the browser**, on a graph built from the City's Géobase, the bike network and OSM paths. It matched or beat Valhalla, BRouter and OSRM on all 4 test trips, in about 0.1 ms instead of 330–700 ms. See `docs/05_routing.md`.
- 2026-10-25 (Claude): no server database needed to run the app: static files (data + router) on a free host or CDN. PostGIS/DuckDB stay optional analysis tools.
- 2026-10-28 (Raph): **keep prototype A (Positron)**. Drop B (Métro Noir) entirely. Drop C (Here & There), keeping only its "hill ahead" feeling in the 3D ride. B and C remain in the first git commit.
- 2026-10-28 (Raph): elevation must be very clear in 2D. Built: soft elevation colours, stronger LiDAR shading, 5 m contours (labelled every 25 m), uphill chevrons on climbs. (Toned down, and the chevrons replaced by 1 m contours, on 2026-10-29: see below.)
- 2026-10-28 (Raph): the 3D ride camera sits lower, more behind the rider (not fully behind). Built: pitch 70°, rider at 70% of the screen height.
- 2026-10-28 (Raph): metro and BIXI icons should look like their real signs, without copyright problems. Built from scratch: white down-arrow on a blue disc for the metro; a BIXI-red tag with a plain bike.
- 2026-10-28 (Raph): public GitHub repo `raphroyjauvin/piste`, published with GitHub Pages. Pages switched on the same day; the site is https://www.raphroyjauvin.ca/piste/ and the tests pass against it.
- 2026-10-28 (Raph): **suggest a ride**: a start point, loop or one-way, an optional stop by category (coffee, food, shopping, any map category) and a distance; the app suggests three routes. Built the same day as a second tab; see `docs/06_prototypes.md`. (Stops and distance range changed on 2026-10-29: see below.)
- 2026-10-28 (Raph), to discuss: an AI agent that understands ride requests in plain language; simple graphics on the 3D massing by business type (cafés, shops…).
- 2026-10-28 (Claude): phone preview page (`prototypes/phone.html`) for designing the phone layout on the monitor; the real iPhone (via Pages) stays the final check.
- 2026-10-29 (Raph): **winter mode**, replacing "summer-only". Built: a snowflake button.
  - The map turns icy light blue. Routing counts only the City's 4-season network (`SAISONS4`) as bike infrastructure.
  - Lanes not cleared in winter show grey and dotted, and route warnings say "not cleared".
  - Protected lanes that lose their separators in winter (City field `PROTEGE_4S`) count as painted lanes.
  - Snow status comes from the weather forecast: snowfall in the last 24 h, temperature, and a freeze–thaw icy warning.
  - Real-time snow-clearing status is **not public**. The City's Planif-Neige API needs a token (requested by email to donneesouvertes@montreal.ca), covers street snow removal rather than bike lanes, and would need a small server. Kept as an open item below.
- 2026-10-29 (Raph): **wind and rain**. Built: one button (raindrop and wind icon) toggles a layer.
  - Environment Canada radar (GeoMet: rain in summer, snow in winter mode) and drifting wind streaks over the map.
  - A card with the wind direction, speed and gusts, a rain outlook (raining now, "rain likely from 16:00", or "dry for the next N hours") and the wind's effect on the selected route ("Headwind for 60% of the ride · about +4 min").
  - Forecast from Open-Meteo (no key), refreshed every 10 minutes.
  - The time effect is a riding-physics estimate: the same effort as 16 km/h in still air, an upright commuter (drag area 0.6 m², 90 kg with the bike), wind at rider height in streets taken as 60% of the 10 m forecast, tailwind gains capped at 25 km/h.
  - "Avoid headwinds" added to Suggest a ride: it penalises time lost to wind, and loops prefer heading into the wind first.
- 2026-10-29 (Raph): **live BIXI**. Built: station icons get a badge with the bikes available (green; orange when 1–2; grey when empty). Tapping a station shows bikes, e-bikes and free docks. It comes from BIXI's public GBFS feed, refreshed every minute, about 1,100 stations island-wide.
- 2026-10-29 (Raph): **classic Montréal rides**. Built: 10 curated rides under "Suggest a ride" → "Classic rides", as swipeable cards with a photo banner that fades to white. The selected ride is drawn on the map with its sights.
  - From 9 km (Old Port & Old Montréal) to 57 km (Canal to Pointe-Claire Village, out and back). The full list, with lengths and bike-lane shares, is in `docs/06_prototypes.md`.
  - Defined as waypoints and sights in `prototypes/shared/data/classics.js` and routed live, so winter mode re-routes them.
  - Chosen from Tourisme Montréal (mtl.org), Time Out Montréal, Parks Canada (Lachine Canal), Komoot and Altitude Sports guides.
  - Photos from Wikimedia Commons, free licences only, credited on each card and listed in `prototypes/shared/photos/credits.json`.
  - Data issue found: a segment near Habitat 67 is one-way in the City's data, so the city → Habitat 67 direction detours. The rides were designed around it (see `docs/05_routing.md`).
- 2026-10-29 (Raph): **island-wide routing**. Built: the routing graph now covers the whole island (37,770 nodes, 56,315 edges, 4.7 MB, `graph_island.js`). Routes take 1–8 ms (Atwater Market → Pointe-Claire: 24.5 km, 82% on bike infrastructure, 8 ms).
  - The bike network layer on the map is now drawn from the graph.
  - Still study area only: buildings, elevation colours, shading and contours, LiDAR terrain tiles (AWS terrain elsewhere), POIs and the planned/works layer.
  - Speed limits and the arterial network only exist for the City of Montréal, not the other island municipalities.
  - Details in `docs/05_routing.md`.
- 2026-10-29 (Raph): **French**, replacing "English only for now". Built: a language button (FR/EN) switches the whole interface, turn instructions, map labels and voice to Québec French (5 %, « Arrêt : », 1,8 km). The default follows the phone's language, and the choice is remembered. Strings are in `prototypes/shared/i18n.js`.
- 2026-10-29 (Raph): **swipeable bottom panel on phones**. Built: drag the handle (or the Piste header) up for full screen, or down to a small strip to focus on the map. A tap steps through the sizes; a quick flick moves one step.
- 2026-10-29 (Raph): **smaller changes**, all built:
  - The test-trip buttons and the "Explore" note are gone. Deep links like `?trip=rachel` still work.
  - Search fields show location pins (start mostly blue, destination mostly white with blue), and the map pins match.
  - The "Before you ride" sheet is gone: the ride starts at once in bird's-eye 3D, and a sound button in the ride bar cycles chime → voice → off.
  - Layers panel: "Works blocking bike lanes" is now "Construction" ("Travaux" in French); Metro is its own layer; parks and viewpoints are always on; "Museums & culture" is its own toggle; Buildings moved into the Map section; the hill-shading label no longer says "LiDAR 2023". Tapping outside the panel closes it.
  - The 2D/3D button shows the view you switch to (a cube and "3D" while the map is flat; a flat square and "2D" while in 3D).
  - "Avoid hills when it costs little" is now "Avoid hills".
  - Suggest a ride: a "Starting location" label; a distance slider from 1 to 100 km plus a typed box (clamped to 100); stops are now coffee, restaurant, bakery, ice cream, bar, public restroom (new), park or viewpoint (merged), museum and bike shop (market and shopping removed).
  - Stretches without a bike lane shorter than 50 m are no longer listed, labelled or announced. They are still coloured on the line.
- 2026-10-29 (Raph): **elevation toned down**, halfway between the first prototype and the strong version. Built:
  - Hill shading: relief factor 2.3 (was 2.8; first prototype 1.8), smoothing 10 m, opacity about 0.85 → 0.72 by zoom.
  - 3D hill-ahead boost halved: terrain ×1.6 at rest, up to about ×2.5 instead of ×3.4.
  - The profile and hill-card graphs use a larger minimum height range, so small climbs don't look like cliffs.
  - The uphill chevrons are gone. Extra 1 m contour lines are drawn where the ground rises 2.5–15% (slope over about 25 m, small patches removed), so climbs show as denser lines. The 5 m and bold 25 m contours are unchanged.

## Open questions for Raph
1. Phone layout polish: the panel is now a swipeable sheet; more design work is possible.
2. AI agent: which approach (see the discussion notes when we get there).
3. 3D storefront graphics: which style.
4. Planif-Neige token for live snow clearing: ask the City for one (email to donneesouvertes@montreal.ca)? It covers street snow removal, not bike lanes, and a token can't ship in the page, so it would need a small server. Until then, winter mode uses the 4-season network and the forecast.
5. Working name: keep "Piste"?

## Folder map
- `CLAUDE.md`: working rules for Claude sessions.
- `docs/`:
  - `01_existing_apps.md`: competitor scan
  - `02_cartography.md`: cartography principles and palette
  - `03_data_sources.md`: data and freshness
  - `04_tech_options.md`: stack choices
  - `05_routing.md`: graph, weights, benchmarks, winter tiers
  - `06_prototypes.md`: what's in the app, URL options, phone preview
  - `mapideas/`: Raph's reference maps (local only, not in git)
- `tools/`:
  - `fetch_data.py`: data refresh (`island` fetches the island-only extras: OSM paths and a 5 m terrain model)
  - `build_graph.py`: routing graph (`--extent study` or `--extent island`)
  - `build_layers.py`: map layers (elevation colours, hillshade, contours, terrain tiles, buildings, POIs…)
  - `compare_engines.py`, `bench_routing.js`: benchmarks
  - `check_classics.js`: prints every classic ride's length and bike-lane share, summer and winter
  - `serve.py`: dev server
  - `shots/`: tests (`test.mjs`), a quick load check (`smoke.mjs`), screenshots (`shoot.mjs`), app icons (`make_icons.mjs`)
- `prototypes/` (this folder is the published website):
  - `a-positron/`: the app
  - `phone.html`: the app on iPhone-sized screens
  - `about.html`: overview with screenshots
  - `shared/`:
    - `router.js`, `common.js`: the router, common UI code and the ride simulator
    - `i18n.js`: English and Québec French strings
    - `weather.js`: Open-Meteo forecast, Environment Canada radar, wind streaks, wind effect on a route
    - `bixi.js`: live BIXI station status
    - `suggest.js`: Suggest a ride (loops, stops, one-way rides)
    - `data/`: built data. `graph_island.js` is the routing graph the app loads (`graph_study.js` is the study-area cut). `classics.js` holds the classic rides (waypoints and sights).
    - `photos/`: classic-ride photos and `credits.json`
    - `terrain/`: LiDAR terrain tiles
  - `vendor/`: MapLibre GL JS 5.24
  - `icons/`, `manifest.webmanifest`: home-screen app icon
  - `screens/`: screenshots
- `.github/workflows/pages.yml`: publishes `prototypes/` to GitHub Pages on every push to `main`.
- `data/raw/`: downloads exactly as published, with `_download_log.csv`. Not in git; rebuild with `tools/fetch_data.py all`.
