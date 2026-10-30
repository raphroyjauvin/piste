# The app prototype

Started as three prototypes on 2026-10-25. On 2026-10-28 Raph chose **A (Positron, MapLibre)** and dropped B (Métro Noir) and C (Here & There). The only idea kept from C is the feeling of a hill coming up while riding in 3D. B and C stay in the git history (first commit).

The app lives in `prototypes/a-positron/`. It uses the shared code and data in `prototypes/shared/`:
- `router.js`, `common.js`: the router, common UI code and the ride simulator
- `i18n.js`: English and Québec French strings
- `weather.js`: forecast, radar, wind streaks and the wind's effect on a route
- `bixi.js`: live BIXI station status
- `suggest.js`: Suggest a ride
- `data/`: built data, including `graph_island.js` (the routing graph) and `classics.js` (the classic rides)
- `photos/`: classic-ride photos and `credits.json`

Updated 2026-10-29: winter mode, wind and rain, live BIXI, classic rides, island-wide routing and island-wide map layers (PMTiles), French, a swipeable phone panel, calmer elevation, "bike path" wording, a "Let's ride!" button, search at the bottom of the screen on phones, headwind avoidance on planned routes, and steady ride icons.

## URL options
The app is at https://www.raphroyjauvin.ca/piste/a-positron/ (on this PC, http://localhost:8765/a-positron/). Add options after it, for example `…/a-positron/?winter=1&lang=fr`. The short address `…/piste/` forwards to the app without them.
- `?trip=rachel|montroyal|biodome|davidson|none`: open on a test trip. The test-trip buttons are gone from the screen, but these links still work. With no `trip` (or `none`) the app opens with no start or destination.
- `?from=lon,lat&to=lon,lat`: open on any trip.
- `?view=3d`: start in bird's-eye 3D.
- `?ride=bird|top`: start the simulated ride; add `&at=<metres>` to jump along it and `&paused` to hold still (used for screenshots and tests).
- `?classic=<id>`: open "Suggest a ride" → "Classic rides" on one ride: `oldport`, `plateau`, `montroyal`, `jeantalon`, `olympic`, `jeandrapeau`, `visitation`, `verdun`, `lachine` or `pointeclaire`.
- `?suggest=loop|oneway&km=10&stop=cafe`: open "Suggest a ride" → "Make your own". `km` is 1–100. Stops: `cafe`, `food`, `bakery`, `icecream`, `bar`, `toilets`, `park`, `culture`, `bikeshop`.
- `?winter=1`: start in winter mode.
- `?wx=1`: start with the wind and rain layer on.
- `?lang=fr` (or `en`): force the language. Without it, the app uses your saved choice, or the phone's language the first time.
- `?safe=top,bottom`: simulated phone safe areas in px (the phone preview sets this, since desktop browsers report 0).

## What's in it
- **Basemap:** OpenFreeMap "Positron", softened (streets, water, parks and labels come from OpenFreeMap online), with our own buildings instead of its own (island-wide, see below).
- **Island-wide map layers (2026-10-29):** hill shading, elevation tint, contours and buildings cover the whole island. Each is one PMTiles file in `prototypes/shared/tiles/` (53.8 MB in all), read by MapLibre through the `pmtiles://` protocol (vendored pmtiles 4.5.0, BSD-3, in `prototypes/vendor/pmtiles/`). The browser asks GitHub Pages for byte ranges (HTTP range requests), so it only downloads the tiles in view.
  - `relief.pmtiles` (hill shading): 25.2 MB, WebP, z10–14. The shading is computed at z15 detail (4.8 m per pixel) and averaged down. z15 itself was dropped: it was 36 of 61 MB and differs from z14 stretched by 0.5/255 on average (99th percentile under 4/255), because the shading is smoothed over about 50 m. The map stretches z14 at closer zooms.
  - `tint.pmtiles` (elevation tint): 1.6 MB, WebP, z9–13.
  - `contours.pmtiles`: 6.3 MB, vector (MVT, gzip), z11–15, layer `contours`, fields `e` (elevation, m) and `i` (1 = 25 m index line, 0 = 5 m line, 2 = 1 m detail line where the ground rises 2.5–15%). z11–12 have the index lines only, z13 adds the 5 m lines, z14–15 add the detail lines. Lines shorter than 4 px are dropped.
  - `buildings.pmtiles`: 20.7 MB, vector, z13–15, layer `buildings`, field `h` (height, m). 562,743 footprints of 12 m² or more from OpenStreetMap: BBBike's Montréal extract of 2026-10-24 (ODbL), because Overpass kept failing (the Overpass path is still in the script). That includes 561 multipolygon buildings (courtyard and university buildings) that the old Overpass query ("out geom tags") silently missed.
    - Heights, as the 70th percentile of surface minus terrain inside each footprint: 1 m LiDAR in the old study area (70,972 buildings), 5 m LiDAR CMM 2023 (310,739) and CMM 2024 (180,675) elsewhere, else the OSM height or levels tag (345), else 6 m (12). The 5 m heights agree with the 1 m ones to a median 0.28 m.
    - z13 shows buildings of 250 m² and up, z14 40 m² and up, z15 all. The map fades the flat buildings in between z13 and z14, and extrudes them in 3D from z14.
  - **3D terrain:** 851 terrarium PNG tiles, z10–14, in `prototypes/shared/terrain/` (24.6 MB), listed in `shared/data/terrain_index.js`. The AWS terrain tiles are only the fallback beyond them. 266 of our tiles needed AWS values at their edges, where the LiDAR has no data; those were filled and cached (`data/raw/aws_terrarium/`) when the tiles were built.
  - **Places and works:** `pois.js` has 22,055 places (0.98 MB) and `planned.js` 7,809 features (2.11 MB: 7,372 planned, 198 under construction, 8 closed, 231 works). Bike racks stay study-area only. The island box also takes in Laval and the South Shore.
  - The app no longer loads `contours.js`, `hillshade.js`/`.png` or `buildings_packed.js` (study area only, superseded; the files are still in `shared/data/`). `elevation_tint.js` stays for the legend colours.
  - Built by `tools/island_tiles.py` and `tools/island_buildings.py` (commands in `CLAUDE.md`). The terrain behind all of it is the merged CMM 2023 + 2024 LiDAR model (see `05_routing.md`).
- **Language (2026-10-29):** the FR/EN button switches the whole interface, turn instructions, map labels and voice to Québec French (5 %, « Arrêt : », 1,8 km). The first time, the app follows the phone's language; after that it remembers your choice. The strings are in `shared/i18n.js`.
  - **Wording:** "bike path(s)" in English and "piste(s) cyclable(s)" in French, in everything the user reads (tier names, legend, cards, voice, labels such as "Works blocking a bike path"). Never "bike lane(s)", "cycle track", "voie cyclable" or "bande cyclable". Code names such as `mostLanes` keep their names.
- **Elevation (2026-10-28, toned down and made island-wide 2026-10-29):** the whole island (files in "Island-wide map layers" above).
  - soft sand-to-tan elevation colours (10 → 200 m) over land and parks, not water; they fade at street zoom
  - LiDAR hill shading, halfway between the first prototype and the strong version: relief factor ×2.3 (first prototype ×1.8, strong version ×2.8), smoothing 10 m, opacity about 0.85 (zoomed out) to 0.72 (zoomed in)
  - contours every 5 m, bold and labelled every 25 m (the 25 m lines show from zoom 11.5, the 5 m lines from 13)
  - extra thin 1 m contours where the ground rises 2.5–15% (slope over about 25 m, small patches removed), so a climb shows as denser lines. They replace the uphill chevrons.
  - in 3D, our own terrain tiles for the whole island, with AWS terrain tiles only as the fallback beyond them
  - legend with the colour ramp
- **Route:** STM blue by tier (solid protected, light painted, dashed shared). Soft orange and dashed where there's no bike path; the panel lists those stretches (click one to zoom). The orange "N m no bike path" label boxes that sat on the map ("N m not cleared" in winter mode; layer `gap-labels`) were removed on 2026-10-29. The bike network is green and is drawn from the routing graph, so it covers the whole island.
  - Stretches without a bike path shorter than 50 m are not listed or announced. They are still coloured on the line.
- **Climbs:** stretches rising ≥ 2.5 % for ≥ 80 m and ≥ 3 m; runs split by a short flat breather count as one hill. Shaded on the profile with "+N m", and summarised under it ("Steepest: 5% on Rue Rachel Est"). The profile and hill-card graphs use a larger minimum height range, so a small climb doesn't look like a cliff. The Michelin-style uphill chevrons of 2026-10-28 were removed on 2026-10-29; the extra contours show climbs instead.
- **Planning:** three options ("Your route", "Most bike paths", "Most direct") with time, distance, climb and a composition bar. The "Route style" slider (direct ↔ bike paths) re-routes live, and so does dragging the pins. Under it, "Avoid hills" and "Avoid headwinds" are two checkboxes side by side (2026-10-29: the headwinds box moved here from the Suggest form). Avoid headwinds applies to "Your route", "Most bike paths" and suggested rides; see Wind & rain. Gap list (click to zoom) and turn-by-turn. The search fields show location pins: the start mostly blue, the destination mostly white with blue. The map pins match.
- **"Let's ride!" (2026-10-29):** the button that starts the ride (it was "Ride this route") now says "Let's ride!" ("Allons-y!" in French). It sits at the end of the route panel. While a route is planned and that button is off screen, a floating copy shows: on phones just above the swipeable card (at the bottom of the screen when the card is full), on desktop at the foot of the panel. Scroll to the end of the card and the floating copy hides; the button sits in its normal place. The floating copy also hides while the phone's bottom search bar is open.
- **Winter mode (2026-10-29):** the snowflake button. It replaces "summer-only".
  - The map turns icy light blue. The legend swaps its network entries for "Bike paths cleared in winter (4-season)" and "Bike paths not cleared in winter".
  - Routing counts only the City's 4-season network (`SAISONS4`) as bike infrastructure. Bike paths that aren't cleared show grey and dotted, and the warnings say "without a winter-cleared bike path" (the stretch list in the panel, the gap card while riding).
  - Protected bike paths that lose their separators in winter (`PROTEGE_4S`) count as painted bike paths. Uncleared off-street paths also cost 2.5× more to route through. See `05_routing.md`.
  - A card shows the snow status from the weather forecast: snowfall in the last 24 h, the temperature, and "Icy patches likely (freeze–thaw)" (above and below 0 °C in the last day, or freezing rain or drizzle now). It also says "Live snow-clearing status isn't public yet".
  - The classic rides re-route on the 4-season network. The radar layer switches to snow.
- **Wind & rain (2026-10-29):** one button (raindrop and wind icon) toggles the layer.
  - **Radar:** Environment Canada 1 km radar (GeoMet WMS): rain (`RADAR_1KM_RRAI`) in summer, snow (`RADAR_1KM_RSNO`) in winter mode.
  - **Wind streaks:** thin streaks drift across the map the way the wind blows, turning with the map.
  - **Card:** wind direction, speed and gusts; a rain outlook ("Raining now", "Rain likely from 16:00" or "Dry for the next 6 hours"); and the wind's effect on the selected route ("Headwind for 60% of the ride · about +4 min", or the tailwind version).
  - **Forecast:** Open-Meteo (no key), one point for the island, refreshed every 10 minutes.
  - **Time effect:** a riding-physics estimate. It holds the effort of a 16 km/h ride in still air (upright commuter, drag area 0.6 m², 90 kg with the bike). Wind at rider height in streets is taken as 60% of the 10 m forecast. Tailwind gains are capped at 25 km/h.
  - **Avoid headwinds** (checkbox next to "Avoid hills", under Route style; since 2026-10-29 it works on planned routes too, not only in Suggest a ride). It steers "Your route", "Most bike paths" and suggested rides away from streets where you'd ride into the wind. "Most direct" doesn't use it.
    - The router prices it per street and per direction: `router.windCost(toDeg, W, speedFn)` (in `shared/router.js`) gives every edge a slow-down of 1 or more for each way of riding it, from the wind and the riding physics in `shared/weather.js` (`speedWith`). The route cost uses `opts.windFwd` and `opts.windBack`. Details in `05_routing.md`.
    - It only applies when the wind is at least 6 km/h. Building the multipliers for the whole island takes about 28 ms (once per wind reading); the largest multiplier seen was 1.74×.
    - In Suggest a ride, the minutes lost to wind also count against a ride in the ranking, and loops prefer heading into the wind first.
- **Live BIXI (2026-10-29):** BIXI's public GBFS feed (open to any website), refreshed every minute, about 1,100 stations island-wide.
  - Each BIXI station icon gets a badge with the bikes available: green, orange when 1–2, grey when empty.
  - Tapping a station shows bikes, e-bikes and free docks.
- **Suggest a ride (2026-10-28, updated 2026-10-29; `shared/suggest.js`):** a second tab next to "Go somewhere", with two modes: "Classic rides" (below) and "Make your own".
  - **Make your own:** you set a "Starting location", loop or one-way, a distance (1–100 km: a slider plus a typed box, clamped to 100) and an optional stop; you get three rides.
  - **Stops:** coffee, restaurant, bakery, ice cream, bar, public restroom, park or viewpoint, museum, bike shop. They come from the island-wide places file (`pois.js`). A place more than 400 m from the bike network can't be snapped to it (the router's snapping limit), so it is skipped.
  - Loops with no stop: a circle through the start, tried in 8 directions and resized until its length fits (about 35 ms for all of them).
  - With a stop: places of that kind at about the right distance, spread around the compass; a loop goes out to the stop and comes back another way (streets already ridden cost 4× on the way back).
  - One-way with no stop: ends at a metro station (easy way home), a park or a viewpoint.
  - Ranked by share on bike infrastructure, closeness to the asked distance and how little it retraces; the three kept share less than 45% of their streets. They use the same Route style slider and the same "Avoid hills" and "Avoid headwinds" settings as normal routes.
  - **Avoid headwinds:** see Wind & rain above (the checkbox is shared with normal routes).
  - The stop is a ring on the map with "Stop · name", an instruction while riding ("Stop: Café …"), and "stop after 4.5 km" on the card.
  - Shops (3,232 named shops from OSM across the island: clothes, books, gifts, sports…) are no longer a stop (market and shopping were removed on 2026-10-29). They still show on the map from zoom 17, under the "Shops" layer.
- **Classic rides (2026-10-29; `shared/data/classics.js`):** the first mode of "Suggest a ride".
  - Swipeable cards, each with a photo banner that fades to white, the distance and time, loop or out and back, the share on bike infrastructure and a short blurb. The centred card is the ride drawn on the map, with its sights; the sights also appear as "Sight: …" steps in the turn-by-turn list. The sights are white circles with a blue outline, half the size they were before 2026-10-29 (circle radius 7.5, outline 2.5; layer `stops`, which also draws the stop of a suggested ride).
  - Each ride is defined as waypoints and sights and routed live on the island graph, so winter mode re-routes it on the 4-season network. On eight of the ten rides the way back avoids streets already ridden (4×); that is off for the Parc Jean-Drapeau islands and the out-and-back Pointe-Claire ride (`avoidBack` in `classics.js`).
  - Rides, with the summer length and the share on bike infrastructure:

    | Ride | `?classic=` | Length | On bike infrastructure |
    |---|---|---|---|
    | Old Port & Old Montréal | `oldport` | 9.1 km | 92% |
    | Plateau & Mile End | `plateau` | 10.4 km | 96% |
    | Mont Royal summit | `montroyal` | 10.5 km | 77% |
    | Little Italy & Jean-Talon Market | `jeantalon` | 9.5 km | 88% |
    | Olympic Park & Botanical Garden | `olympic` | 15.5 km | 99% |
    | Parc Jean-Drapeau islands | `jeandrapeau` | 15.3 km | 94% |
    | Rivière-des-Prairies & Île-de-la-Visitation | `visitation` | 9.5 km | 91% |
    | Verdun riverside & Île des Sœurs | `verdun` | 26.0 km | 97% |
    | Lachine Canal & the St. Lawrence | `lachine` | 26.8 km | 98% |
    | Canal to Pointe-Claire Village (out and back) | `pointeclaire` | 56.7 km | 79% |

  - The choice of rides is based on Tourisme Montréal (mtl.org), Time Out Montréal, Parks Canada (Lachine Canal), Komoot and Altitude Sports guides. Waypoint coordinates come from OpenStreetMap (Nominatim).
  - Photos are from Wikimedia Commons, free licences only (CC BY and CC BY-SA). Each card credits the author and licence, and `shared/photos/credits.json` lists them all.
  - `node tools/check_classics.js` prints every ride's length and bike-path share, summer and winter.
  - Known data issue: a segment near Habitat 67 is one-way in the City's data, so the city → Habitat 67 direction detours. The rides were designed around it (details in `05_routing.md`).
  - Lachine waypoint (2026-10-29): with real elevations (see `05_routing.md`), the ride's second waypoint, in Parc des Rapides, sent the way back onto 500 m of Boulevard LaSalle (96% on bike paths). It moved to the shore path just north-east of the park, and that sight is now "Lachine Rapids" ("Rapides de Lachine"). The ride is back to 98% on bike paths, with its original 3 stretches without one.
  - The table above was re-checked with `check_classics.js` after the graph's elevation fix: lengths and shares still match. The climbs went down to realistic numbers (for example Pointe-Claire 224 → 139 m).
- **Layers panel (2026-10-29):**
  - Map: Bike paths (the bike network), Planned & in construction (browse only), Construction (works blocking bike paths; "Travaux" in French), Cafés & food, Shops, BIXI/water/repair/parking, Metro, Museums & culture, Buildings.
  - Elevation: Elevation colours, Hill shading, Contours, Terrain relief (in 3D).
  - Parks and viewpoints are always on. Tapping outside the panel closes it.
  - Every layer covers the whole island since 2026-10-29, except bike racks (part of "BIXI/water/repair/parking"), which are still study area only.
- **3D:** one-button toggle that shows the view you switch to: a cube and "3D" while the map is flat, a flat square and "2D" while in 3D. Bird's-eye uses a narrow 22° lens, which looks almost axonometric.
- **Ride (simulated):**
  - It starts at once in bird's-eye 3D. The old "Before you ride" sheet (alert options, voice commands, a watch-tap note and a reminder of the Québec rules) is gone. A sound button in the ride bar cycles chime → voice → off, and the app remembers the choice.
  - Camera low and behind the rider (pitch 70°, rider at 70% of the screen height), heading-up.
  - **Hill ahead:** from about 520 m before a climb, the terrain exaggeration rises from ×1.6 to up to about ×2.5 (steeper climbs get more; it was ×3.4 before 2026-10-29), the camera tilts up 2° (was 3°) and pulls back a little; it eases back after the top.
  - Hill card above the ride bar: "Climb in 260 m · +30 m over 860 m · 4% avg, 5% max", then "Climbing · 5% · 270 m to the top", then "Top of the climb", with a sparkline of the next 800 m.
  - Turn card, calm gap card ("In 180 m: 146 m without a bike path…" → "Back on a bike path"; in winter mode, "without a winter-cleared bike path").
  - Places pop up on their real side of the street (at most 8, names on the 3 nearest). The map's own POI icons hide while riding, except metro.
  - **No shaking icons (2026-10-29):** the roadside place icons (`.poi-pop` markers) used to shake against the map, worst in the 2D (top-down) ride: up to 27 px off the map, 1.1 px on average. Now 0 px. Three causes, all fixed:
    1. The icons had a CSS `transition: transform .25s`, so every per-frame move by MapLibre was animated and lagged. It's gone; the labels keep an opacity fade only.
    2. MapLibre rounds marker positions to whole pixels on every `jumpTo` (it fires `moveend` each frame). The markers now use `subpixelPositioning: true`.
    3. The icons moved one frame before the map redrew. `RideSim` (`shared/common.js`) now asks for its next animation frame at the start of each tick, and `rideFrame()` in `a-positron/app.js` ends with `map.redraw()`, so the camera, the icons and the map are drawn in the same frame. The redraw replaces MapLibre's scheduled draw, so it is still one draw per frame.
  - **Rule:** any code that moves the camera every frame must move markers and call `map.redraw()` in the same step. A test measures it (see Tests and screenshots).
- **Icons:** metro = white down-arrow on a blue disc, ringed with the colours of the lines serving the station; BIXI = BIXI red tag with a plain bike, plus the live badge. Both are our own drawings that only echo the real signs (no logos copied).
- **Phone panel (2026-10-29):** on phones the panel is a swipeable bottom sheet. Drag the handle (or the Piste header) up for full screen, or down to a small strip to focus on the map. A tap steps through the sizes; a quick flick moves one step.
  - The grab bar at the top is taller (34 px, a bigger thumb target). It no longer shrinks to 5 px when the card is fully open: it is a flex item, now `flex: none`.
  - **Search at the bottom:** tapping a search field (start or destination) moves it to the bottom of the screen, above the keyboard, with the map above it. A small ✓ accepts and ✕ cancels (it restores what was there). In "Go somewhere", ✓ on the start moves straight on to the destination field, which has the same design. Type an address (the suggestions list above the bar) or tap the map to set the place. Enter accepts and Escape cancels. If you typed an address but didn't pick one, ✓ takes the top suggestion.
  - **Map controls:** the zoom buttons and the scale bar are hidden on phones (the card covered them; pinch to zoom). The map credits button (ⓘ) moved to the top left, so the OpenStreetMap and data credits stay reachable.
  - **"Let's ride!"** floats just above the card while a route is planned (see Planning above).
- **Installable:** web manifest and home-screen icon, so Safari → Share → Add to Home Screen opens it full screen.

## Phone preview
`prototypes/phone.html` shows the app inside 1–3 iPhone-sized screens side by side (SE, 13/14, 15/16, 17/16 Pro/17 Pro, Pro Max), as a home-screen app or a Safari tab. Each phone has its own screen picker: routes (Rachel with a climb, Mont-Royal → Papineau), the 3D ride with a hill, the top-down ride, classic rides (Old Port, Lachine Canal), Suggest a ride (a 10 km loop, a loop with a coffee stop), winter mode in French, wind & rain, the 3D view and the plain map. It's for layout and flow; the real check is the iPhone itself.

## Tests and screenshots
- `node tools/shots/test.mjs [name filter]`: 11 groups, all passing on 2026-10-29 (headless Edge; the dev server must be running, or set `PISTE_BASE` to test the live site). New or widened on 2026-10-29:
  - **2D ride: place icons stay pinned to the map (no shaking)** (new): starts the top-down ride and, at every map draw, compares where each place icon is with where it belongs. It passes under 0.5 px (before the fix the icons were up to 27 px off the map, 1.1 px on average; now 0 px) and fails if the icons have a `transform` transition.
  - **UI clean-up:** now also checks that there are no gap label boxes on the map, the sight circles have radius 7.5, the ride icons have no transform transition, the button says "Let's ride!", "Avoid hills" and "Avoid headwinds" sit side by side, and the floating button shows when the panel's own button is off screen and hides at the end of the panel.
  - **Elevation:** now also reads one tile from each PMTiles file (relief z14, tint z12, contours z14, buildings z14) in the West Island, downtown and the east end, and checks that every one exists. It also checks that the detail contour lines come out of the tiles and that the 3D terrain tiles load from the site.
  - **Phone: swipeable panel, safe areas:** now also checks that the floating button sits above the card and walks the bottom search flow (tap the destination field, tap the map, then ✓).
- `node tools/shots/shoot.mjs [prefix]`: screenshots into `prototypes/screens/` (A = desktop, P = phone). New on 2026-10-29: `P6-phone-search-bottom` (the bottom search bar with address suggestions) and `P7-phone-lets-ride` (the floating "Let's ride!" button above the small card).
- `node tools/shots/smoke.mjs "?winter=1"`: a quick load check of one app URL (console errors and a few state values).

## Known limits (prototype stage)
- **Routing and the map layers are island-wide** (since 2026-10-29). Still study area only: bike racks. The 1 m LiDAR is only used for building heights in the old study area (Plateau, Rosemont, Hochelaga, Centre-Sud, Olympic Park); everywhere else the LiDAR models are 5 m, from two flights (CMM 2023 and 2024) that cover the island box between them.
- **Island graph gaps:** speed limits and the arterial network only exist for the City of Montréal, not the other island municipalities. About 26% of the graph's nodes fell in disconnected pieces and were dropped (mostly Laval and Île-Bizard fragments, and unconnected paths). See `05_routing.md`.
- **Ride is simulated** (no GPS yet).
- **Snow-clearing status isn't public.** Winter mode uses the City's 4-season network and the weather forecast, not real clearing. The City's Planif-Neige API needs an access token (requested by email on 2026-10-29, no answer yet) and covers street snow removal, not bike paths; it would also need a small server.
- **Online sources:** basemap tiles (OpenFreeMap), terrain tiles beyond our own (AWS, a fallback), address search (Ville de Montréal API), the forecast (Open-Meteo), radar (Environment Canada) and live BIXI. The PMTiles layers, the terrain tiles, the classic-ride photos and all other data ship with the site.
- **Voice:** voice prompts use the browser's speech synthesis. Voice commands (speech recognition) were on the old "Before you ride" sheet and aren't offered now; the code is still in `shared/common.js`.
- **Phone layout:** the panel is a swipeable sheet and search moves to the bottom of the screen. More design work is possible.
