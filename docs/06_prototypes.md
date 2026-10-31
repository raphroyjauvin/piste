# The app prototype

Started as three prototypes on 2026-10-25. On 2026-10-28 Raph chose **A (Positron, MapLibre)** and dropped B (Métro Noir) and C (Here & There). The only idea kept from C is the feeling of a hill coming up while riding in 3D. B and C stay in the git history (first commit).

The app lives in `prototypes/a-positron/`. It uses the shared code and data in `prototypes/shared/`:
- `router.js`, `common.js`: the router, common UI code and the ride code (the preview simulator, the GPS ride and a pretend GPS for tests)
- `i18n.js`: English and Québec French strings
- `weather.js`: forecast, radar, wind streaks and the wind's effect on a route
- `bixi.js`: live BIXI station status
- `suggest.js`: Suggest a ride
- `data/`: built data, including `graph_island.js` (the routing graph) and `classics.js` (the classic rides)
- `photos/`: classic-ride photos and `credits.json`

Updated 2026-10-29: winter mode, wind and rain, live BIXI, classic rides, island-wide routing and island-wide map layers (PMTiles), French, a swipeable phone panel, calmer elevation, "bike path" wording, a "Let's ride!" button, headwind avoidance on planned routes, and steady ride icons.

Updated 2026-10-30: simpler phone search (the card slides up above the keyboard) and the floating "Let's ride!" copy removed, both after Raph tried them on his iPhone; and **GPS ride mode**: on a phone, "Let's ride!" follows your real position (the simulation is now the "Preview the ride" link). Then a first-visit **welcome card, a feedback link and a guided tour** (see "What's in it").

Also 2026-10-30: the **site now opens the app at its root** (www.pistemtl.ca, Raph's new domain), and **tests run before every publish** (route safety checks, the browser tests on the built site, a check of the built site). See "The published site" below.

## URL options
The app is at https://www.pistemtl.ca/ once Raph sets up the DNS and the custom domain (pending, 2026-10-30). Until then it is at https://www.raphroyjauvin.ca/piste/, which now opens the app directly. On this PC it is still at http://localhost:8765/a-positron/. Add options straight after the address, for example `https://www.pistemtl.ca/?winter=1&lang=fr` (locally, `http://localhost:8765/a-positron/?winter=1&lang=fr`). Old `/a-positron/` links on the site keep working: they forward to the root and keep their options.
- `?trip=rachel|montroyal|biodome|davidson|none`: open on a test trip. The test-trip buttons are gone from the screen, but these links still work. With no `trip` (or `none`) the app opens with no start or destination.
- `?from=lon,lat&to=lon,lat`: open on any trip.
- `?view=3d`: start in bird's-eye 3D.
- `?ride=bird|top`: start the simulated preview ride; add `&at=<metres>` to jump along it and `&paused` to hold still (used for screenshots and tests).
- `?ride=gps`: start a GPS ride (it needs a trip or classic ride in the link, and location allowed, or `?gps=replay`).
- `?gps=1` makes "Let's ride!" a GPS ride, even on a desktop; `?gps=0` makes it the preview, even on a phone. Without it, a phone or tablet gets GPS and a desktop gets the preview.
- `?gps=replay&gpsx=<speed-up>&gpsat=<metres>&detour=<metres>`: a pretend GPS for tests and screenshots (see Ride below). `gpsx` speeds it up (default 1), `gpsat` starts that far along the route, `detour` makes it leave the route at that distance. Add `&gpsdeny` for a pretend "location refused".
- `?classic=<id>`: open "Suggest a ride" → "Classic rides" on one ride: `oldport`, `plateau`, `montroyal`, `jeantalon`, `olympic`, `jeandrapeau`, `visitation`, `verdun`, `lachine` or `pointeclaire`.
- `?suggest=loop|oneway&km=10&stop=cafe`: open "Suggest a ride" → "Make your own". `km` is 1–100. Stops: `cafe`, `food`, `bakery`, `icecream`, `bar`, `toilets`, `park`, `culture`, `bikeshop`.
- `?winter=1`: start in winter mode.
- `?wx=1`: start with the wind and rain layer on.
- `?lang=fr` (or `en`): force the language. Without it, the app uses your saved choice, or the phone's language the first time.
- `?safe=top,bottom`: simulated phone safe areas in px (the phone preview sets this, since desktop browsers report 0).
- `?welcome=1`: show the first-visit welcome card again (to see it on the iPhone after dismissing it); `?welcome=0` never shows it. The frames in `phone.html` add `&welcome=0`, so the welcome card doesn't cover the phone screens.

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
- **"Let's ride!" (2026-10-29):** the button that starts the ride (it was "Ride this route") now says "Let's ride!" ("Allons-y!" in French). It sits only in its place at the end of the route card, on phones and desktop. A floating copy (above the phone card, at the foot of the desktop panel) was tried on 2026-10-29 and removed on 2026-10-30: Raph found it looked bad on his iPhone. Since 2026-10-30, on a phone or tablet the button starts a GPS ride, and a small underlined "Preview the ride" ("Aperçu du trajet") link under it starts the simulation; on a desktop the button is the preview and there is no link (see Ride below).
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
- **Ride (GPS or preview; GPS added 2026-10-30):** "Let's ride!" has two modes, and both show the same map, cards and voice.
  - **GPS ride:** follows your real position. It is the default on a phone or tablet, meaning the browser has geolocation and a touch screen (`pointer: coarse`; `gpsDefault()` in `a-positron/app.js`). Details just below.
  - **Preview:** the simulated ride at 4× speed (all there was before 2026-10-30). On a desktop "Let's ride!" is the preview and there is no extra link. On a phone or tablet it starts from a small underlined "Preview the ride" link under the button. The "4×" label resets to 4× whenever a new preview starts.
  - Both start at once in bird's-eye 3D (2D, top-down, is one button away). The old "Before you ride" sheet (alert options, voice commands, a watch-tap note and a reminder of the Québec rules) is gone. A sound button in the ride bar cycles chime → voice → off, and the app remembers the choice.
  - Camera low and behind the rider (pitch 70°, rider at 70% of the screen height), heading-up.
  - **Hill ahead:** from about 520 m before a climb, the terrain exaggeration rises from ×1.6 to up to about ×2.5 (steeper climbs get more; it was ×3.4 before 2026-10-29), the camera tilts up 2° (was 3°) and pulls back a little; it eases back after the top.
  - Hill card above the ride bar: "Climb in 260 m · +30 m over 860 m · 4% avg, 5% max", then "Climbing · 5% · 270 m to the top", then "Top of the climb", with a sparkline of the next 800 m.
  - Turn card, calm gap card ("In 180 m: 146 m without a bike path…" → "Back on a bike path"; in winter mode, "without a winter-cleared bike path").
  - Places pop up on their real side of the street (at most 8, names on the 3 nearest). The map's own POI icons hide while riding, except metro.
  - **GPS ride (2026-10-30; `RideGPS` in `shared/common.js`, started by `startGpsRide()` in `a-positron/app.js`):**
    - **Matching a fix to the route:** each fix is matched to the route near the last known position first, then further ahead, then anywhere, so a loop or an out-and-back doesn't jump across to the wrong part (`makeTrack(route).locate`). Fixes worse than 50 m accuracy are ignored: the ride bar says "Waiting for GPS…" until a good one arrives, and again after 8 s with no good fix.
    - **Smooth movement:** the rider glides between fixes. It keeps moving at your speed for at most 1.2 s after a fix, smoothed over 0.25 s. It never goes backwards on jitter; only a real U-turn does (30 m behind, three fixes in a row). The heading comes from the route. The ride ends when you are within 25 m of the end ("Arrived"). Speed is the phone's own when it reports one, else worked out from the fixes. While you are off the route, the rider is drawn eased toward your real position.
    - **Off route, then reroute:** more than 30 m from the route (or the fix's accuracy + 10 m, whichever is larger) for 5 s means a new route from where you are, with the same settings as the planned one (route style, hills, headwinds, winter), at most once every 10 s. The voice and a toast say "Rerouting" and "New route from here". Before you first reach the route, the limit is looser (60 m, or accuracy + 25 m), because a trip start is often 36–49 m from the route (a metro entrance, for example).
      - "Go somewhere" reroutes to the destination. Classic and suggested rides rejoin the planned ride 250 m ahead of you and keep the sights and stop that are left, so a loop doesn't send you straight home (`rerouteFrom()` and `newRouteFrom()` in `app.js`, built with `tailRoute` and `joinRoutes` in `common.js`). If fewer than about 350 m of the ride are left, the new route goes straight to the end.
      - If no new route is found, the planned route stays and a calm message says so (at most once a minute). When the ride ends, the planned routes are drawn again.
    - **Ride bar:** sound, 2D/3D, the GPS status and End. There is no 4× button and no pause. The status shows your speed in km/h and "± accuracy" in metres, a pulsing "Waiting for GPS…", or "Off route".
    - **Moving the map by hand:** panning or zooming stops the camera following you and shows a "Re-center" ("Recentrer") pill; a tap glides back in 0.5 s. A plain tap on the map doesn't stop following.
    - **Screen on:** the Screen Wake Lock API keeps the screen on during a GPS ride (`keepAwake()`), and asks again when the page comes back. It works in Safari from iOS 16.4 and in home-screen web apps from about iOS 18.4. If the screen locks anyway, the ride picks up from the next fix, and starts the location watch again after 4 s with no fix.
    - **Location refused or not available:** the ride doesn't start. A calm card says so, with [Preview the ride] and [OK] (`gpsError()` and `showNotice()`).
    - **Sound on iPhone:** the tap on "Let's ride!" (or on "Preview the ride") unlocks the chime and the voice, with a silent sound and a silent spoken line (`rideTap()`, `unlockAudio()`, `voice.prime()`). iPhone Safari stays silent otherwise.
    - **Code:** `RideCore` (shared) turns "distance along the route" into frames and the gap, turn, hill and arrived events, and takes a new route with `setRoute()` after a reroute. `RideSim` (the preview, behaviour unchanged) and `RideGPS` both extend it, and the app draws them the same way. The reroute settings come from `routeWeights()` and `selWeights()` in `app.js`.
    - **`ReplayGeo`** is a pretend GPS for tests and screenshots (`?gps=replay`). It looks like `navigator.geolocation`, so the ride runs the same code as with a real phone. It gives one fix a second (sped up by `gpsx`), about 2.5 m of noise, a poor fix at the start and every 13th, and optionally a detour (60 m out, 150 m alongside the route, then back). After a reroute it carries on along the new route.
    - **Tuning (`GPS` in `common.js`):** first guesses, to check on real rides.

      | Setting | Value | Meaning |
      |---|---|---|
      | `ACC_MAX` | 50 m | fixes less accurate than this are ignored |
      | `OFF_M` | 30 m | farther than this from the route (and beyond accuracy + 10 m) is off route |
      | `START_M` | 60 m | the same, until you first reach the route (or accuracy + 25 m) |
      | `OFF_MS` | 5 s | off route this long before rerouting |
      | `REROUTE_MS` | 10 s | at most one reroute this often |
      | `ARRIVE_M` | 25 m | from the end: arrived |
      | `LEAD_S` | 1.2 s | carry on at the current speed at most this long after a fix |
      | `TAU_S` | 0.25 s | the rider glides toward where you are with this time constant |
      | `BACK_M` | 30 m | this far behind, three fixes in a row, counts as a U-turn |
      | `STALE_MS` | 8 s | with no good fix: "Waiting for GPS…" again |

    - **Not checked without a real iPhone:** see Known limits.
  - **No shaking icons (2026-10-29):** the roadside place icons (`.poi-pop` markers) used to shake against the map, worst in the 2D (top-down) ride: up to 27 px off the map, 1.1 px on average. Now 0 px. Three causes, all fixed:
    1. The icons had a CSS `transition: transform .25s`, so every per-frame move by MapLibre was animated and lagged. It's gone; the labels keep an opacity fade only.
    2. MapLibre rounds marker positions to whole pixels on every `jumpTo` (it fires `moveend` each frame). The markers now use `subpixelPositioning: true`.
    3. The icons moved one frame before the map redrew. `RideSim` (`shared/common.js`) now asks for its next animation frame at the start of each tick, and `rideFrame()` in `a-positron/app.js` ends with `map.redraw()`, so the camera, the icons and the map are drawn in the same frame. The redraw replaces MapLibre's scheduled draw, so it is still one draw per frame.
  - **Rule:** any code that moves the camera every frame must move markers and call `map.redraw()` in the same step. A test measures it (see Tests and screenshots).
- **Icons:** metro = white down-arrow on a blue disc, ringed with the colours of the lines serving the station; BIXI = BIXI red tag with a plain bike, plus the live badge. Both are our own drawings that only echo the real signs (no logos copied).
- **Phone panel (2026-10-29):** on phones the panel is a swipeable bottom sheet. Drag the handle (or the Piste header) up for full screen, or down to a small strip to focus on the map. A tap steps through the sizes; a quick flick moves one step.
  - The grab bar at the top is taller (34 px, a bigger thumb target). It no longer shrinks to 5 px when the card is fully open: it is a flex item, now `flex: none`.
  - **Search (2026-10-30, replacing the 2026-10-29 bottom bar with ✓ / ✕ buttons):** the bar sat with a gap above the iPhone keyboard until the keyboard closed, so the card now slides up to the keyboard instead.
    - Tapping a search bar (start or destination) slides the card so both search bars sit just above the keyboard, with the map above. The brand header, tabs and the rest of the card hide while typing, and so do the map buttons, weather card and legend. Suggestions float over the map, just above the card.
    - Picking a suggestion (or the keyboard's return key) on the start moves straight on to the destination bar when the destination is empty. If a destination is already set, the search ends and the route updates. Picking the destination ends the search and shows the route (card back to half height).
    - If the keyboard closes another way (its done key, or a tap on the map): a newly typed place takes the top suggestion; otherwise the place stays as it was. iPhone may not reopen the keyboard for the destination then, so the destination bar flashes blue instead.
    - A small grey ✕ inside the bar you're typing in backs out: it puts that bar's place back as it was and closes the keyboard. It replaces the bar's pick-on-map icon while you type. Tapping the map while typing only closes the keyboard; it no longer sets the place.
    - **Why it works on iPhone:** the card is moved before the bar takes focus, so Safari doesn't scroll the page. That first move uses a guess of the keyboard height (47% of the screen); once the keyboard is up, the card slides to the exact spot (`visualViewport`). The search bars use 16 px text on phones so Safari doesn't zoom in. The tests have no real keyboard and only check the guessed position, so check search changes on a real iPhone.
  - **Map controls:** the zoom buttons and the scale bar are hidden on phones (the card covered them; pinch to zoom). The map credits button (ⓘ) moved to the top left, so the OpenStreetMap and data credits stay reachable.
  - **"Let's ride!"** stays in the card, with no floating copy (see Planning above).
- **Installable:** web manifest and home-screen icon, so Safari → Share → Add to Home Screen opens it full screen. On the built site the manifest's `start_url` is `./`, so the home-screen app opens the site root.
- **Welcome card, feedback and guided tour (2026-10-30; `a-positron/tour.js`, loaded after `app.js`):**
  - **Welcome card:** shown once the map is ready, on the first visit only (`piste-welcomed` in localStorage; if storage is blocked it shows once per page load). The brand mark, "Welcome to Piste", one line on what Piste does, a "Beta" pill with a calm note, [Take the tour · 40 s], [Explore on my own] and a small "Send feedback" link. Either button, or Esc, marks it as seen. Centred on desktop; on phones it sits low over the card, inside the safe areas.
  - **Feedback:** `mailto:support@pistemtl.ca`, subject "Piste feedback" ("Commentaires Piste"), with a blank template ("What happened" / "Where"). It never holds the person's location, route or anything personal. The last row of the panel, under the credits, has the speech-bubble "Feedback" link and a small, faint "Take the tour" button (hidden during a ride).
  - **Tour steps:** (1) search, (2) route style, (3) route colours, (4) "Let's ride", (5) Suggest a ride, (6) winter mode, (7) weather and map tools, (8) feedback. Each has a title of 4 words or fewer and one short sentence (strings `tour1T`…`tour8` in `i18n.js`).
    - Step 3 uses the route on screen if there is one. Otherwise it plans a demo route, Parc La Fontaine → Old Port (4.0 km: protected bike paths, a shared stretch and one 101 m stretch without a bike path on Saint-Laurent, so all the colours show), and fits it next to the callout. The callout carries the four route colours as a small legend; on desktop the map legend opens too.
    - Step 5 switches to Suggest a ride (classic rides); step 6 turns winter mode on to show the icy map and the 4-season network, and off again when you move on.
  - **Look:** a dimmed screen (one SVG mask, so a step can light up several things: the route, its card and the legend) with a white ring and a soft blue glow. The cut-outs glide between targets in about 0.3 s (ease-out) and follow the map and the phone card as they move; the callout appears beside the main target once things stop moving, flipping side as needed so it stays on screen and off every target. Map moves take 0.65 s. With reduced motion, everything jumps and the callout only fades.
  - **Phone:** each step sets the card size (half, peek or full; bigger if its targets don't fit, e.g. step 5 on a 360 × 640 phone) and scrolls the card so the target sits under the grab bar. The callout is full width and stays inside the safe areas; buttons are 44 px or more. No text field is ever focused, so the keyboard never opens.
  - **Input:** → or Enter for Next, ← for Back, Esc to skip; the callout is a modal dialog that keeps the focus, and the focus goes back where it was afterwards. Taps on the dimmed area don't reach the app.
  - **Ending or skipping** puts back what the tour changed: the demo route and the search bars, the tab, winter mode, the legend and layers panel, the card's size and scroll, and the map view (a 0.6 s move back).
  - **Code:** `app.js` hands the tour a small hook object, `window.piste` (map, state, store, setSheet, setTab, setWinter, setPoint, computeRoutes…), and fires `piste:ready` and `piste:lang`. `window.pisteTour` (start, next, back, end, info) is for tests and screenshots.

## Phone preview
`prototypes/phone.html` shows the app inside 1–3 iPhone-sized screens side by side (SE, 13/14, 15/16, 17/16 Pro/17 Pro, Pro Max), as a home-screen app or a Safari tab. Each phone has its own screen picker: routes (Rachel with a climb, Mont-Royal → Papineau), the 3D ride with a hill, the top-down ride, classic rides (Old Port, Lachine Canal), Suggest a ride (a 10 km loop, a loop with a coffee stop), winter mode in French, wind & rain, the 3D view and the plain map. It's for layout and flow; the real check is the iPhone itself. Its frames add `&welcome=0` (2026-10-30), so the first-visit welcome card doesn't cover them.

## The published site (2026-10-30)
Raph bought pistemtl.ca at Porkbun on 2026-10-30, with email forwarding for support@pistemtl.ca, and agreed the domain should open the app directly, with no landing page. So the site has the app at its root. Locally nothing changes: the app runs from `prototypes/a-positron/` through `tools/serve.py`. Only the published copy is reshaped.
- **Build:** `python tools/build_site.py [out_dir]` builds `_site/` (not in git; the default is next to `tools/`):
  - the app's files at the root, with their `../shared/…` style paths rewritten to `shared/…`, so the same build works at a domain root and under a folder such as `/piste/`. The script stops with a message if a `../` path is left that it can't rewrite
  - the shared data, `vendor/`, `icons/`, `screens/` and `phone.html` copied beside it (`phone.html` frames the app at `index.html`)
  - the about page at `/about/`, its links pointed one folder up, and its "Open the app" link going to the root
  - old links forwarding to the new places, keeping the `?query` and `#hash`: `/a-positron/` goes to the root, `about.html` to `about/` (the small forwarding pages also catch old home-screen icons)
  - the manifest's `start_url` set to `./`
- **Live address:** https://www.pistemtl.ca/ once Raph sets up the DNS (the domain's address records) and the custom domain in GitHub Pages (pending). Until then: https://www.raphroyjauvin.ca/piste/, which now opens the app directly.
- **Check a built site:** `node tools/shots/site_check.mjs <base url> [<base url> …]`, for example `http://127.0.0.1:8765/` and `http://127.0.0.1:8766/piste/`. For each address it checks that the app starts at the root and stays there; that `/a-positron/?lang=fr#here` and `/a-positron/index.html?x=1` forward with the query and hash kept; that `about.html` forwards to `about/`, all its images load and "Open the app" goes to the root; that the manifest has `start_url` and `scope` `./` and `phone.html` frames the app at the root; and that no same-origin file gives a 404 and the page throws no errors. It uses the same `PISTE_BROWSER` and `PISTE_BROWSER_ARGS` as `test.mjs`.
- **Tests before every publish (GitHub Actions, `.github/workflows/pages.yml`).** Every push to any branch runs:
  1. the route checks (`node tools/check_routes.js`, see `05_routing.md`);
  2. `npm ci` in `tools/shots` (installs the test tools);
  3. `python3 tools/build_site.py`;
  4. the browser tests (`test.mjs`) on the built site, in the runner's Google Chrome (`PISTE_BROWSER=chrome`) with software WebGL (`--use-angle=swiftshader --use-gl=angle`: the machine has no graphics card, so the map is drawn by software), `PISTE_FIXTURES=1` and `PISTE_APP=index.html`;
  5. `site_check.mjs`, at a domain root (port 8765) and under a `/piste/` folder (port 8766).
- **The gate:** only `main` publishes, and only if every test passes. Otherwise the site stays on the last good version and GitHub emails the failed run. A run takes about 4–5 minutes. First green run: 2026-10-30. Under software WebGL the 3D view draws only 1 or 2 frames a second, so the long GPS replay groups ride with the flat top-down camera there (`PISTE_FLAT_RIDE`, see Tests below).

## Tests and screenshots
- `node tools/shots/test.mjs [name filter]`: 20 groups, all passing on 2026-10-30 (headless Edge on this PC, Chrome on GitHub; the dev server must be running, or set `PISTE_BASE` to test a built or live site, with `PISTE_APP=index.html` since the published site has the app at its root). Options, all optional (the full list is at the top of `test.mjs`):
  - `PISTE_APP=index.html`: the app's path under `PISTE_BASE`. The default, `a-positron/index.html`, is the dev layout. Example, against the live site: `PISTE_APP=index.html PISTE_BASE=https://www.pistemtl.ca/`.
  - `PISTE_FIXTURES=1`: answers the weather, radar, BIXI and address-search requests from saved copies in `tools/shots/fixtures` instead of the live services, so results don't depend on today's weather or on those servers being up. GitHub sets it. The copies are snapshots on purpose: refresh them only if a service changes its format (see the README in that folder).
  - `PISTE_BROWSER=msedge|chrome|chromium` and `PISTE_BROWSER_ARGS`: which browser, and extra switches.
  - `PISTE_FLAT_RIDE=1|0`: the long GPS replay groups use the flat top-down camera instead of the 3D bird's-eye one. By default yes under software WebGL, no on a PC with a graphics card.
  - Also `PISTE_OFFLINE=1` (cut off the basemap), `PISTE_CPU_SLOWDOWN=4` (slow the CPU) and `PISTE_NET_REPORT=1` (list the outside hosts each group calls).
- Groups: every group starts with the welcome card already seen (an init script sets `piste-welcomed`), except the three below, which start as a first visit. The welcome and tour groups of 2026-10-30 come first, then the six GPS groups of the same day, then the groups new or widened on 2026-10-29 (the phone group again on 2026-10-30):
  - **welcome: first visit** (new): the card shows on a first visit with the Beta note and the exact mailto link, "Explore on my own" closes it and sets the flag, it doesn't show after a reload, the French card renders, Esc closes it, it fits on 390 × 844 and 360 × 640 screens inside the safe areas, and with storage blocked it still shows and closes without errors.
  - **tour: every step** (new, 1440 × 900): from the welcome card's "Take the tour", by keyboard (→, Enter, ←) and Esc halfway (with the demo route showing); then the replay from the footer through all 8 steps with Back and Next on each, ending with "Let's go". At every step it measures, in the page, that each target is on screen (inside the panel's visible part, or the route clear of the panel), that a cut-out covers it, and that the callout is on screen, off the targets and off the cut-out's centre, with 44 px buttons. After Esc and after "Let's go" the sheet, tab, winter mode, search bars, routes, pins and map view are as before, with no demo route left, and the focus is back on the footer button. A tour over a route already on screen uses it (no demo), and there is no "Take the tour" during a ride.
  - **phone: tour** (new): the same per-step checks at 390 × 844 (touch, safe areas 47 / 34) from the welcome card, including the card size of each step, then at 360 × 640 from the footer, after opening the card fully and scrolling to the bottom.
  - **GPS ride (replayed track): follows the route, ignores poor fixes, re-center, arrives** (new): runs `?gps=replay` and checks that the ride bar shows "Waiting for GPS…" then km/h, that the rider never goes backwards, stays exactly on the route line (0 m off) and follows the true position (1.6 m on average), that poor fixes are ignored, that dragging the map shows "Re-center" and a tap on it follows again, and that the ride arrives and ends.
  - **GPS ride (replayed track): a detour triggers exactly one reroute** (new): the replay leaves the route; the test checks one reroute (the voice says "Rerouting", the toast "New route from here"), a new route that starts near the fix, the rider drawn off the route meanwhile, and the planned route drawn again when the ride ends.
  - **GPS ride (replayed track): on a classic ride, a reroute rejoins the ride ahead** (new): after a detour on the Old Port ride, the new route is about as long as what was left, keeps the remaining sights and has no pieces missing.
  - **GPS: location refused shows a calm message, and the preview still works** (new): the card says so in English and French, the ride bar and HUD are closed, and its [Preview the ride] button starts the simulation.
  - **GPS: the browser's own location moves the ride** (new): feeds positions through the browser's real geolocation (not the replay) and checks that the ride moves and shows "±8 m".
  - **Phone: GPS ride bar, preview link** (new): on a touch phone screen, the "Preview the ride" link sits under the button, the ride bar shows sound, 2D/3D, GPS and End and fits, and the link starts the preview.
  - **2D ride: place icons stay pinned to the map (no shaking)** (new): starts the top-down ride and, at every map draw, compares where each place icon is with where it belongs. It passes under 0.5 px (before the fix the icons were up to 27 px off the map, 1.1 px on average; now 0 px) and fails if the icons have a `transform` transition.
  - **UI clean-up:** now also checks that there are no gap label boxes on the map, the sight circles have radius 7.5, the ride icons have no transform transition, the button says "Let's ride!", "Avoid hills" and "Avoid headwinds" sit side by side, and there is no floating copy of the button (it was removed on 2026-10-30).
  - **Elevation:** now also reads one tile from each PMTiles file (relief z14, tint z12, contours z14, buildings z14) in the West Island, downtown and the east end, and checks that every one exists. It also checks that the detail contour lines come out of the tiles and that the 3D terrain tiles load from the site.
  - **Phone: swipeable panel, safe areas:** on 2026-10-30 the search checks replaced the old bottom-bar ones. It now checks that tapping the destination bar docks the bars just above the (guessed) keyboard with the brand header hidden and the ✕ showing, that the suggestions sit above the card, that the ✕ leaves the destination unchanged, that the return key on a typed start moves on to the destination bar, and that picking a destination ends the search and shows the route with the card back at half height.
- `node tools/shots/shoot.mjs [prefix]`: screenshots into `prototypes/screens/` (A = desktop, P = phone). `P6-phone-search` (typing a destination: the search bars above the keyboard, suggestions over the map and the grey ✕) replaced `P6-phone-search-bottom` on 2026-10-30, and `P7-phone-lets-ride` (the floating button) was removed. `P7-phone-gps-ride` (2026-10-30; a GPS ride on a phone screen, from a replayed track: the ride bar with speed and accuracy) took the free name P7; it replaces nothing.
  - 2026-10-30: `W1-welcome` and `W2-phone-welcome` (the first-visit card, on a fresh profile), and `T1`…`T8` (desktop) and `TP1`…`TP8` (phone, 390 × 844) for the tour steps. Every other shot starts with the welcome card already seen.
- `node tools/shots/smoke.mjs "?winter=1"`: a quick load check of one app URL (console errors and a few state values).

## Known limits (prototype stage)
- **Routing and the map layers are island-wide** (since 2026-10-29). Still study area only: bike racks. The 1 m LiDAR is only used for building heights in the old study area (Plateau, Rosemont, Hochelaga, Centre-Sud, Olympic Park); everywhere else the LiDAR models are 5 m, from two flights (CMM 2023 and 2024) that cover the island box between them.
- **Island graph gaps:** speed limits and the arterial network only exist for the City of Montréal, not the other island municipalities. About 26% of the graph's nodes fell in disconnected pieces and were dropped (mostly Laval and Île-Bizard fragments, and unconnected paths). See `05_routing.md`.
- **Sainte-Anne-de-Bellevue village core (found 2026-10-30, not fixed):** 35 intersections around -73.9535, 45.4043 can't be ridden into, because the exits are one-way in the City's Géobase data (Rue Saint-Pierre, Rue du Collège, Route Transcanadienne). It is a gap in the City's data, not in our graph build. The route check reports it as a warning. See `05_routing.md`.
- **Long detours:** the router can take a long way round to stay on bike paths (Côte-des-Neiges → Peel: 9.8 km against 4.4 km for the shortest legal route). They are not capped yet: an open question for Raph (README, Open questions).
- **GPS ride is untested on a real iPhone.** It was built and tested with a pretend GPS (`?gps=replay`) and the browser's test location (2026-10-30), so these still need a real ride:
  - real GPS noise downtown between towers (the 30 m / 5 s off-route rule may reroute too eagerly)
  - whether Safari reports speed (if not, the speed comes from the fixes)
  - the Wake Lock in a home-screen web app (about iOS 18.4 and later)
  - the voice and chime unlock on iPhone
  - resuming after the screen locks (the fallback restarts the location watch after 4 s with no fix)
  - pinch and pan plus "Re-center" on a real touch screen
  - battery and heat from redrawing the map every frame
  - geolocation needs HTTPS: it works on the live site, not on `http://<this PC>:8765` opened from the phone
  - Remaining time on the ride bar still assumes 16 km/h, not your real speed.
- **Snow-clearing status isn't public.** Winter mode uses the City's 4-season network and the weather forecast, not real clearing. The City's Planif-Neige API needs an access token and covers streets only, not bike paths or sidewalks; it would also need a small server. The City won't give out tokens before the winter season and will send one when the 2026-2027 version restarts (answer of 2026-10-30), so it is shelved until winter.
- **Online sources:** basemap tiles (OpenFreeMap), terrain tiles beyond our own (AWS, a fallback), address search (Ville de Montréal API), the forecast (Open-Meteo), radar (Environment Canada) and live BIXI. The PMTiles layers, the terrain tiles, the classic-ride photos and all other data ship with the site.
- **Voice:** voice prompts use the browser's speech synthesis. Voice commands (speech recognition) were on the old "Before you ride" sheet and aren't offered now; the code is still in `shared/common.js`.
- **Phone layout:** the panel is a swipeable sheet, and while you type in a search bar the card slides up above the keyboard. More design work is possible.
