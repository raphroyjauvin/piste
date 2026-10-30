# Piste: a Montreal bike commuter app

Working name. Started 2026-10-25 by Raph Roy-Jauvin, with Claude. **Stage: one web prototype (A), routing and map layers on real data across the whole island, published on GitHub Pages.**

## The idea
- You enter a destination. The app routes you along bike infrastructure as much as possible, even when that is not the shortest path.
- While riding, it warns you calmly before any stretch with no bike infrastructure. On a phone, "Let's ride!" follows your real position (GPS) and plans a new route if you leave the route; a "Preview the ride" link simulates the ride, and on a desktop "Let's ride!" is that preview.
- It shows the hills: clearly on the 2D map, and in 3D you feel a climb coming before you reach it.
- Montreal first, built on the City's open data. Routing and the map layers (relief, contours, buildings) cover the whole island.
- Soft cartography with a 2D view and a 3D bird's-eye view (LiDAR building heights and terrain).
- It shows places cyclists care about: BIXI (with live bikes available), metro, cafés, food, water, repair, parks.
- It suggests rides: ten classic Montréal rides, or your own loop or one-way ride with a stop.
- It has "Avoid hills" and "Avoid headwinds" options, a winter mode (only the 4-season network counts), a wind and rain layer, and an English / Québec French switch.

## Try it
- **On your phone:** https://www.raphroyjauvin.ca/piste/ (in Safari, Share → Add to Home Screen opens it full screen). Allow location when asked, so "Let's ride!" can follow you (GPS needs https: it works on the address above, but not on the PC's `http://…:8765` address opened from the phone). GitHub Pages serves it on Raph's own domain; raphroyjauvin.github.io/piste forwards there.
- **On this PC:** double-click `prototypes\start-prototypes.bat`, then open http://localhost:8765/.
- **Phone screens on the monitor:** http://localhost:8765/phone.html shows the app inside iPhone-sized screens, side by side.
- **Links that open a given view:** add options to the app's address, for example https://www.raphroyjauvin.ca/piste/a-positron/?winter=1 (the short address forwards without them). Newer options:
  - `?classic=<id>`: open a classic ride (the ids are listed in `docs/06_prototypes.md`)
  - `?winter=1`: winter mode on
  - `?wx=1`: wind and rain layer on
  - `?lang=fr`: French (`?lang=en` for English)
  - `?gps=1` / `?gps=0`: make "Let's ride!" a GPS ride / the preview, whatever the device (a phone or tablet gets GPS and a desktop the preview without it)
  - `?suggest=loop|oneway&km=&stop=`: open "Suggest a ride", with a distance in km and a stop: `cafe`, `food`, `bakery`, `icecream`, `bar`, `toilets`, `park`, `culture` or `bikeshop`
- `docs/06_prototypes.md` lists what's in the app and all its URL options.

## Decisions log
- 2026-10-25 (Raph): work in `C:\bikeapp`; Montreal and its open data; desktop browser first, phone later.
- 2026-10-25 (Raph): personal first, but built to become a public app. iPhone first; browser-only until permissions matter.
- 2026-10-25 (Raph): **summer-only** for now. Winter (4-season network) is noted for later. (Winter mode was built on 2026-10-29, see below.)
- 2026-10-25 (Raph): **any dedicated bike facility counts as bike infrastructure**, including painted bike paths, sharrows and shared streets. Warnings only for streets with **no** bike infrastructure at all.
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
  - Bike paths not cleared in winter show grey and dotted, and the warnings say "without a winter-cleared bike path".
  - Protected bike paths that lose their separators in winter (City field `PROTEGE_4S`) count as painted bike paths.
  - Snow status comes from the weather forecast: snowfall in the last 24 h, temperature, and a freeze–thaw icy warning.
  - Real-time snow-clearing status for bike paths is **not public**. The City's Planif-Neige API needs an access token and covers street snow removal only, not bike paths. Shelved until winter on 2026-10-30 (see below).
- 2026-10-29 (Raph): **wind and rain**. Built: one button (raindrop and wind icon) toggles a layer.
  - Environment Canada radar (GeoMet: rain in summer, snow in winter mode) and drifting wind streaks over the map.
  - A card with the wind direction, speed and gusts, a rain outlook (raining now, "rain likely from 16:00", or "dry for the next N hours") and the wind's effect on the selected route ("Headwind for 60% of the ride · about +4 min").
  - Forecast from Open-Meteo (no key), refreshed every 10 minutes.
  - The time effect is a riding-physics estimate: the same effort as 16 km/h in still air, an upright commuter (drag area 0.6 m², 90 kg with the bike), wind at rider height in streets taken as 60% of the 10 m forecast, tailwind gains capped at 25 km/h.
  - "Avoid headwinds" added to Suggest a ride: it penalises time lost to wind, and loops prefer heading into the wind first. (Extended to planned routes later on 2026-10-29: see below.)
- 2026-10-29 (Raph): **live BIXI**. Built: station icons get a badge with the bikes available (green; orange when 1–2; grey when empty). Tapping a station shows bikes, e-bikes and free docks. It comes from BIXI's public GBFS feed, refreshed every minute, about 1,100 stations island-wide.
- 2026-10-29 (Raph): **classic Montréal rides**. Built: 10 curated rides under "Suggest a ride" → "Classic rides", as swipeable cards with a photo banner that fades to white. The selected ride is drawn on the map with its sights.
  - From 9 km (Old Port & Old Montréal) to 57 km (Canal to Pointe-Claire Village, out and back). The full list, with lengths and bike-path shares, is in `docs/06_prototypes.md`.
  - Defined as waypoints and sights in `prototypes/shared/data/classics.js` and routed live, so winter mode re-routes them.
  - Chosen from Tourisme Montréal (mtl.org), Time Out Montréal, Parks Canada (Lachine Canal), Komoot and Altitude Sports guides.
  - Photos from Wikimedia Commons, free licences only, credited on each card and listed in `prototypes/shared/photos/credits.json`.
  - Data issue found: a segment near Habitat 67 is one-way in the City's data, so the city → Habitat 67 direction detours. The rides were designed around it (see `docs/05_routing.md`).
- 2026-10-29 (Raph): **island-wide routing**. Built: the routing graph now covers the whole island (37,770 nodes, 56,315 edges, 4.7 MB, `graph_island.js`). Routes take 1–8 ms (Atwater Market → Pointe-Claire: 24.5 km, 82% on bike infrastructure, 8 ms).
  - The bike network layer on the map is now drawn from the graph.
  - The other map layers (buildings, elevation colours, shading, contours, terrain tiles, places, planned/works) were still study area only at that point; they became island-wide later the same day (see below).
  - Speed limits and the arterial network only exist for the City of Montréal, not the other island municipalities.
  - Details in `docs/05_routing.md`.
- 2026-10-29 (Raph): **French**, replacing "English only for now". Built: a language button (FR/EN) switches the whole interface, turn instructions, map labels and voice to Québec French (5 %, « Arrêt : », 1,8 km). The default follows the phone's language, and the choice is remembered. Strings are in `prototypes/shared/i18n.js`.
- 2026-10-29 (Raph): **swipeable bottom panel on phones**. Built: drag the handle (or the Piste header) up for full screen, or down to a small strip to focus on the map. A tap steps through the sizes; a quick flick moves one step.
- 2026-10-29 (Raph): **smaller changes**, all built:
  - The test-trip buttons and the "Explore" note are gone. Deep links like `?trip=rachel` still work.
  - Search fields show location pins (start mostly blue, destination mostly white with blue), and the map pins match.
  - The "Before you ride" sheet is gone: the ride starts at once in bird's-eye 3D, and a sound button in the ride bar cycles chime → voice → off.
  - Layers panel: "Works blocking bike paths" is now "Construction" ("Travaux" in French); Metro is its own layer; parks and viewpoints are always on; "Museums & culture" is its own toggle; Buildings moved into the Map section; the hill-shading label no longer says "LiDAR 2023". Tapping outside the panel closes it.
  - The 2D/3D button shows the view you switch to (a cube and "3D" while the map is flat; a flat square and "2D" while in 3D).
  - "Avoid hills when it costs little" is now "Avoid hills".
  - Suggest a ride: a "Starting location" label; a distance slider from 1 to 100 km plus a typed box (clamped to 100); stops are now coffee, restaurant, bakery, ice cream, bar, public restroom (new), park or viewpoint (merged), museum and bike shop (market and shopping removed).
  - Stretches without a bike path shorter than 50 m are no longer listed or announced. They are still coloured on the line.
- 2026-10-29 (Raph): **elevation toned down**, halfway between the first prototype and the strong version. Built:
  - Hill shading: relief factor 2.3 (was 2.8; first prototype 1.8), smoothing 10 m, opacity about 0.85 → 0.72 by zoom.
  - 3D hill-ahead boost halved: terrain ×1.6 at rest, up to about ×2.5 instead of ×3.4.
  - The profile and hill-card graphs use a larger minimum height range, so small climbs don't look like cliffs.
  - The uphill chevrons are gone. Extra 1 m contour lines are drawn where the ground rises 2.5–15% (slope over about 25 m, small patches removed), so climbs show as denser lines. The 5 m and bold 25 m contours are unchanged.
- 2026-10-29 (Raph): **wording: "bike path(s)" in English, "piste(s) cyclable(s)" in French.** Never "bike lane(s)", "cycle track", "voie cyclable" or "bande cyclable". Built: every label, legend entry, card and message in `prototypes/shared/i18n.js` and `common.js` (tiers: "Protected / Painted / Shared bike path", "No bike path"; the route option is "Most bike paths"). Code names such as `mostLanes` keep their names.
- 2026-10-29 (Raph): **no orange "no bike path" boxes on the map.** The map labels on stretches without a bike path are removed. The orange dashed route segments and the list of stretches in the panel stay.
- 2026-10-29 (Raph): **smaller sight circles.** On classic rides the white circles for key sights are half the size (radius 7.5, outline 2.5).
- 2026-10-29 (Raph): **"Let's ride!"** ("Allons-y!" in French) replaces "Ride this route". It sits at the end of the route card. (A floating copy of it was tried the same day and removed on 2026-10-30: see below.)
- 2026-10-29 (Raph): **phone map controls and card.** (A search bar that moved to the bottom of the screen with ✓ / ✕ buttons was tried the same day and replaced on 2026-10-30: see below.)
  - On phones: the zoom buttons and scale bar are hidden (the card covered them; pinch to zoom), the map credits button (ⓘ) moved to the top left, and the grab bar of the swipeable card is taller (34 px) and keeps its height when the card is full.
- 2026-10-29 (Raph): **"Avoid headwinds" works on planned routes too.** Built: "Avoid hills" and "Avoid headwinds" are two checkboxes side by side under Route style (the headwinds box moved out of the Suggest form). Avoiding headwinds now shapes "Your route", "Most bike paths" and suggested rides ("Most direct" doesn't use it). The router works out a slow-down for each direction of every street from the wind and the riding physics (`windCost`, see `docs/05_routing.md`), only when the wind is at least 6 km/h.
- 2026-10-29 (Raph): **island-wide map layers**, replacing "study area only". Built: hill shading, elevation tint, contours and buildings now cover the whole island, as four PMTiles files in `prototypes/shared/tiles/` (`relief` 25.2 MB, `tint` 1.6 MB, `contours` 6.3 MB, `buildings` 20.7 MB). MapLibre reads them with HTTP range requests (vendored pmtiles 4.5.0), so the browser only fetches the tiles in view. GitHub Pages serves the files as they are.
  - Hill shading is computed at zoom-15 detail (4.8 m per pixel) and averaged down; the file stops at z14, because z15 was 36 of 61 MB and differs from z14 stretched by 0.5/255 on average (the shading is smoothed over about 50 m).
  - Buildings: 562,743 footprints of 12 m² or more from OpenStreetMap (BBBike's Montréal extract of 2026-10-24, because Overpass kept failing). That includes 561 multipolygon buildings (courtyard and university buildings) that the old query silently missed. Heights come from LiDAR (1 m in the old study area, 5 m elsewhere), then OSM height tags, then 6 m.
  - 3D terrain: 851 terrain tiles (z10–14, 24.6 MB) in `prototypes/shared/terrain/`. AWS terrain tiles are only the fallback beyond them.
  - Places and works are island-wide too: 22,055 places (bike racks stay study-area only) and 7,809 planned, closed and works features.
  - The app no longer loads `contours.js`, `hillshade.js`/`.png` or `buildings_packed.js` (study area only, superseded). Built by `tools/island_tiles.py` and `tools/island_buildings.py`; details in `docs/06_prototypes.md` and `docs/03_data_sources.md`.
- 2026-10-29 (Claude, from checks): **LiDAR gap found; routing-graph elevations fixed.** NRCan's CMM 2023 LiDAR block covers only 61% of the island box. The CMM 2024 block of the same programme covers the rest, and the two agree to 0.02 m where they overlap. Built: one merged 5 m terrain model (`data/build/dtm_island_5m_merged.tif`, 2023 wins where both exist; made by `tools/island_tiles.py dem`).
  - The island graph now reads it. Before, it read only the 2023 block, so 15% of its nodes (5,569 of 37,770) got a filler height: flat, with fake steps where real data began. `build_graph.py --extent island` now stops with a message if the merged file is missing.
  - The graph also ignores rises and drops under 1 m when it adds up an edge's climb (`CLIMB_MIN_STEP`). The 5 m model's small wobbles were adding up to metres of fake climbing on flat paths. Classic-ride climbs are now realistic (Pointe-Claire 224 → 139 m, Verdun 115 → 88 m, Olympic 92 → 83 m).
  - With real elevations, the Lachine classic's second waypoint (in Parc des Rapides) sent the way back onto 500 m of Boulevard LaSalle (96% on bike paths). The waypoint moved to the shore path just north-east of the park, and that sight is now "Lachine Rapids" ("Rapides de Lachine"). Back to 98% on bike paths, with the original 3 stretches without one.
- 2026-10-30 (Raph): **"Let's ride!" back in the card only.** After trying it on his iPhone, Raph found the floating button looked bad. The floating copy is gone (above the phone card, and at the foot of the desktop panel). "Let's ride!" / "Allons-y!" sits only in its place in the card, as before.
- 2026-10-30 (Raph): **simpler phone search**, replacing the 2026-10-29 bottom bar with ✓ / ✕ buttons (on the iPhone the bar sat with a gap above the keyboard until the keyboard closed). Built:
  - Tapping a search bar (start or destination) slides the card so both bars sit just above the keyboard, with the map above. The brand header, tabs and the rest of the card hide while typing, and so do the map buttons, weather card and legend. Suggestions float over the map, just above the card.
  - Picking a suggestion (or the keyboard's return key) on the start moves straight on to the destination bar when the destination is empty. If a destination is already set, the search ends and the route updates. Picking the destination ends the search and shows the route (card back to half height).
  - If the keyboard closes another way (its done key, or a tap on the map): a newly typed place takes the top suggestion; otherwise the place stays as it was. iPhone may not reopen the keyboard for the destination then, so the destination bar flashes blue instead.
  - A small grey ✕ inside the bar you're typing in backs out: it puts that bar's place back as it was and closes the keyboard. It replaces the bar's pick-on-map icon while you type. Tapping the map while typing only closes the keyboard; it no longer sets the place.
  - Technical: the card moves before the bar takes focus (so iPhone Safari doesn't scroll the page), using a guess of the keyboard height (47% of the screen), then slides to the exact spot once the keyboard is up (`visualViewport`). On phones the search bars use 16 px text so Safari doesn't zoom.
  - Tests and screenshots: see `docs/06_prototypes.md`.
- 2026-10-30 (Raph): **Planif-Neige shelved until winter.** The City's open-data team answered: no access tokens before the winter season, and they will send one when the 2026-2027 version restarts. The API tracks streets only, not bike paths or sidewalks. Decision: shelved until winter. It may still help later for streets without a bike path (the 4-season network is cleared as a priority anyway). Until then, winter mode uses the 4-season network and the forecast.
- 2026-10-30 (Raph): **GPS ride mode**, replacing "Ride is simulated (no GPS yet)". Built: on a phone or tablet (location available and a touch screen), "Let's ride!" starts a ride that follows your real position. A small underlined "Preview the ride" link under it starts the simulation; on a desktop "Let's ride!" is the preview, with no extra link.
  - Each fix is matched to the route near the last known position first (then further ahead, then anywhere), so loops and out-and-backs don't jump across. Fixes worse than 50 m accuracy are ignored ("Waiting for GPS…", and again after 8 s with no good fix). The rider glides between fixes, never goes backwards on jitter (only a real U-turn does), takes its heading from the route, and the ride ends within 25 m of the end.
  - Off route: more than 30 m away (or the fix's accuracy + 10 m, whichever is larger) for 5 s means a new route from where you are, with the same settings as the planned route (route style, hills, headwinds, winter), at most once every 10 s, with "Rerouting" / "New route from here". Before you first reach the route the limit is 60 m, because a trip start is often 36–49 m from the route (a metro entrance, for example). "Go somewhere" reroutes to the destination. Classic and suggested rides rejoin the ride 250 m ahead, keeping the sights still to come, so a loop doesn't send you straight home.
  - The ride bar shows sound, 2D/3D, the GPS status (speed in km/h and ± accuracy, "Waiting for GPS…" or "Off route") and End. There is no 4× or pause. Panning or zooming by hand stops following and shows a "Re-center" pill. The screen stays on (Screen Wake Lock). If location is refused or missing, a calm card offers [Preview the ride] and [OK]. The tap on "Let's ride!" unlocks sound and speech on iPhone.
  - A pretend GPS (`?gps=replay`) feeds a test track through the same code as real GPS, so the tests and screenshot P7 run without a phone. Other options: `?ride=gps`, `?gps=1`, `?gps=0`. Details, numbers and tests in `docs/06_prototypes.md`; rerouting in `docs/05_routing.md`.
  - Not checked yet on a real iPhone (see Open questions).
  - Small change: the preview's "4×" label resets when a new preview starts.

## Open questions for Raph
1. GPS ride, to check on a real iPhone ride (it only works over https, so on the live site):
   - The tuning numbers (50 m accuracy, 30 m / 5 s off route, 10 s between reroutes; table in `docs/06_prototypes.md`). Real GPS noise downtown between towers may reroute too eagerly.
   - Reroute target for classic and suggested rides: rejoin the ride 250 m ahead. Is that right?
   - GPS rides start in bird's-eye 3D, like the preview. 2D might be calmer and lighter on the battery.
   - The remaining time still assumes 16 km/h, not your real speed.
   - Other things only a real ride can show: whether Safari reports speed, the Wake Lock in a home-screen app (about iOS 18.4 and later), the voice and chime unlock, resuming after the screen locks, pinch and pan with "Re-center", and battery and heat from redrawing every frame.
2. Phone layout polish: the panel is a swipeable sheet, and while you type the card slides up above the keyboard; more design work is possible.
3. AI agent: which approach (see the discussion notes when we get there).
4. 3D storefront graphics: which style.
5. Planif-Neige (live snow clearing): shelved until winter (2026-10-30). The City will send a token when the 2026-2027 version restarts. It covers streets only, not bike paths or sidewalks, and a token can't ship in the page, so it would need a small server. When it arrives, decide whether it's worth it for streets without a bike path. Until then, winter mode uses the 4-season network and the forecast.
6. Working name: keep "Piste"?

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
  - `fetch_data.py`: data refresh (`island` fetches the island-only extras: OSM paths and the CMM 2023 5 m terrain model)
  - `build_graph.py`: routing graph (`--extent study` or `--extent island`; the island graph needs the merged terrain model, so run `island_tiles.py dem` first)
  - `island_tiles.py`: island-wide map data: the merged terrain model (`dem`), hill shading, tint and contours as PMTiles, terrain tiles, places, planned/works layer
  - `island_buildings.py`: island-wide buildings (OSM footprints with LiDAR heights) as a PMTiles file
  - `build_layers.py`: the older study-area map layers. The island scripts import its helpers; the app no longer loads most of what it builds
  - `compare_engines.py`, `bench_routing.js`: benchmarks
  - `check_classics.js`: prints every classic ride's length and bike-path share, summer and winter
  - `serve.py`: dev server
  - `shots/`: tests (`test.mjs`), a quick load check (`smoke.mjs`), screenshots (`shoot.mjs`), app icons (`make_icons.mjs`)
- `prototypes/` (this folder is the published website):
  - `a-positron/`: the app
  - `phone.html`: the app on iPhone-sized screens
  - `about.html`: overview with screenshots
  - `shared/`:
    - `router.js`, `common.js`: the router, common UI code and the ride code (the preview simulator, the GPS ride and a pretend GPS for tests)
    - `i18n.js`: English and Québec French strings
    - `weather.js`: Open-Meteo forecast, Environment Canada radar, wind streaks, wind effect on a route
    - `bixi.js`: live BIXI station status
    - `suggest.js`: Suggest a ride (loops, stops, one-way rides)
    - `data/`: built data. `graph_island.js` is the routing graph the app loads (`graph_study.js` is the study-area cut). `classics.js` holds the classic rides (waypoints and sights). `pois.js` and `planned.js` are the island-wide places and planned/works layers, `terrain_index.js` lists the terrain tiles, and `elevation_tint.js` gives the legend colours. The old study-area files (`contours.js`, `hillshade.js`/`.png`, `buildings_packed.js`) are no longer loaded.
    - `tiles/`: the island-wide PMTiles files: `relief` (hill shading), `tint`, `contours`, `buildings`
    - `photos/`: classic-ride photos and `credits.json`
    - `terrain/`: 851 terrain tiles for the 3D view (z10–14)
  - `vendor/`: MapLibre GL JS 5.24 and pmtiles 4.5.0
  - `icons/`, `manifest.webmanifest`: home-screen app icon
  - `screens/`: screenshots
- `.github/workflows/pages.yml`: publishes `prototypes/` to GitHub Pages on every push to `main`.
- `data/raw/`: downloads exactly as published, with `_download_log.csv`. Not in git; rebuild with `tools/fetch_data.py all` (and `tools/island_tiles.py` / `tools/island_buildings.py` for the island-wide extras).
- `data/build/`: derived files (the merged terrain model, graph JSON, tile build scratch). Not in git.
