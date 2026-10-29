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

Updated 2026-10-29: winter mode, wind and rain, live BIXI, classic rides, island-wide routing, French, a swipeable phone panel, and calmer elevation.

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
- **Basemap:** OpenFreeMap "Positron", softened, with our own LiDAR buildings (study area only).
- **Language (2026-10-29):** the FR/EN button switches the whole interface, turn instructions, map labels and voice to Québec French (5 %, « Arrêt : », 1,8 km). The first time, the app follows the phone's language; after that it remembers your choice. The strings are in `shared/i18n.js`.
- **Elevation (2026-10-28, toned down 2026-10-29):** study area only.
  - soft sand-to-tan elevation colours (10 → 200 m) over land and parks, not water; they fade at street zoom
  - LiDAR hill shading, halfway between the first prototype and the strong version: relief factor ×2.3 (first prototype ×1.8, strong version ×2.8), smoothing 10 m, opacity about 0.85 (zoomed out) to 0.72 (zoomed in)
  - contours every 5 m, bold and labelled every 25 m
  - extra thin 1 m contours where the ground rises 2.5–15% (slope over about 25 m, small patches removed), so a climb shows as denser lines. They replace the uphill chevrons.
  - in 3D, LiDAR terrain tiles inside the study area, AWS terrain tiles outside it
  - legend with the colour ramp
- **Route:** STM blue by tier (solid protected, light painted, dashed shared). Soft orange where there's no bike lane, with an "N m no bike lane" pill ("N m not cleared" in winter mode). The bike network is green and is drawn from the routing graph, so it covers the whole island.
  - Stretches without a bike lane shorter than 50 m are no longer listed, labelled or announced. They are still coloured on the line.
- **Climbs:** stretches rising ≥ 2.5 % for ≥ 80 m and ≥ 3 m; runs split by a short flat breather count as one hill. Shaded on the profile with "+N m", and summarised under it ("Steepest: 5% on Rue Rachel Est"). The profile and hill-card graphs use a larger minimum height range, so a small climb doesn't look like a cliff. The Michelin-style uphill chevrons of 2026-10-28 were removed on 2026-10-29; the extra contours show climbs instead.
- **Planning:** three options (your route / most bike lanes / most direct) with time, distance, climb and a composition bar. The direct ↔ bike-lanes slider re-routes live, and so does dragging the pins. "Avoid hills" is a checkbox under the slider. Gap list (click to zoom) and turn-by-turn. The search fields show location pins: the start mostly blue, the destination mostly white with blue. The map pins match.
- **Winter mode (2026-10-29):** the snowflake button. It replaces "summer-only".
  - The map turns icy light blue. The legend swaps its network entries for "Cleared in winter (4-season)" and "Not cleared in winter".
  - Routing counts only the City's 4-season network (`SAISONS4`) as bike infrastructure. Lanes that aren't cleared show grey and dotted, and warnings say "not cleared" ("N m not cleared", "Without a winter-cleared bike lane").
  - Protected lanes that lose their separators in winter (`PROTEGE_4S`) count as painted lanes. Uncleared off-street paths also cost 2.5× more to route through. See `05_routing.md`.
  - A card shows the snow status from the weather forecast: snowfall in the last 24 h, the temperature, and "Icy patches likely (freeze–thaw)" (above and below 0 °C in the last day, or freezing rain or drizzle now). It also says "Live snow-clearing status isn't public yet".
  - The classic rides re-route on the 4-season network. The radar layer switches to snow.
- **Wind & rain (2026-10-29):** one button (raindrop and wind icon) toggles the layer.
  - **Radar:** Environment Canada 1 km radar (GeoMet WMS): rain (`RADAR_1KM_RRAI`) in summer, snow (`RADAR_1KM_RSNO`) in winter mode.
  - **Wind streaks:** thin streaks drift across the map the way the wind blows, turning with the map.
  - **Card:** wind direction, speed and gusts; a rain outlook ("Raining now", "Rain likely from 16:00" or "Dry for the next 6 hours"); and the wind's effect on the selected route ("Headwind for 60% of the ride · about +4 min", or the tailwind version).
  - **Forecast:** Open-Meteo (no key), one point for the island, refreshed every 10 minutes.
  - **Time effect:** a riding-physics estimate. It holds the effort of a 16 km/h ride in still air (upright commuter, drag area 0.6 m², 90 kg with the bike). Wind at rider height in streets is taken as 60% of the 10 m forecast. Tailwind gains are capped at 25 km/h.
  - **Avoid headwinds** in Suggest a ride penalises time lost to wind, and loops prefer heading into the wind first.
- **Live BIXI (2026-10-29):** BIXI's public GBFS feed (open to any website), refreshed every minute, about 1,100 stations island-wide.
  - Each BIXI station icon gets a badge with the bikes available: green, orange when 1–2, grey when empty.
  - Tapping a station shows bikes, e-bikes and free docks.
- **Suggest a ride (2026-10-28, updated 2026-10-29; `shared/suggest.js`):** a second tab next to "Go somewhere", with two modes: "Classic rides" (below) and "Make your own".
  - **Make your own:** you set a "Starting location", loop or one-way, a distance (1–100 km: a slider plus a typed box, clamped to 100) and an optional stop; you get three rides.
  - **Stops:** coffee, restaurant, bakery, ice cream, bar, public restroom, park or viewpoint, museum, bike shop.
  - Loops with no stop: a circle through the start, tried in 8 directions and resized until its length fits (about 35 ms for all of them).
  - With a stop: places of that kind at about the right distance, spread around the compass; a loop goes out to the stop and comes back another way (streets already ridden cost 4× on the way back).
  - One-way with no stop: ends at a metro station (easy way home), a park or a viewpoint.
  - Ranked by share on bike infrastructure, closeness to the asked distance and how little it retraces; the three kept share less than 45% of their streets. They use the same route-style slider and hill setting as normal routes.
  - **Avoid headwinds** (checkbox): see Wind & rain above.
  - The stop is a ring on the map with "Stop · name", an instruction while riding ("Stop: Café …"), and "stop after 4.5 km" on the card.
  - Shops (999 named shops from OSM: clothes, books, gifts, sports…) are no longer a stop (market and shopping were removed on 2026-10-29). They still show on the map from zoom 17, under the "Shops" layer.
- **Classic rides (2026-10-29; `shared/data/classics.js`):** the first mode of "Suggest a ride".
  - Swipeable cards, each with a photo banner that fades to white, the distance and time, loop or out and back, the share on bike infrastructure and a short blurb. The centred card is the ride drawn on the map, with its sights; the sights also appear as "Sight: …" steps in the turn-by-turn list.
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
  - `node tools/check_classics.js` prints every ride's length and bike-lane share, summer and winter.
  - Known data issue: a segment near Habitat 67 is one-way in the City's data, so the city → Habitat 67 direction detours. The rides were designed around it (details in `05_routing.md`).
- **Layers panel (2026-10-29):**
  - Map: Bike network, Planned & in construction (browse only), Construction (works blocking bike lanes; "Travaux" in French), Cafés & food, Shops, BIXI/water/repair/parking, Metro, Museums & culture, Buildings.
  - Elevation: Elevation colours, Hill shading, Contours, Terrain relief (in 3D).
  - Parks and viewpoints are always on. Tapping outside the panel closes it.
- **3D:** one-button toggle that shows the view you switch to: a cube and "3D" while the map is flat, a flat square and "2D" while in 3D. Bird's-eye uses a narrow 22° lens, which looks almost axonometric.
- **Ride (simulated):**
  - It starts at once in bird's-eye 3D. The old "Before you ride" sheet (alert options, voice commands, a watch-tap note and a reminder of the Québec rules) is gone. A sound button in the ride bar cycles chime → voice → off, and the app remembers the choice.
  - Camera low and behind the rider (pitch 70°, rider at 70% of the screen height), heading-up.
  - **Hill ahead:** from about 520 m before a climb, the terrain exaggeration rises from ×1.6 to up to about ×2.5 (steeper climbs get more; it was ×3.4 before 2026-10-29), the camera tilts up 2° (was 3°) and pulls back a little; it eases back after the top.
  - Hill card above the ride bar: "Climb in 260 m · +30 m over 860 m · 4% avg, 5% max", then "Climbing · 5% · 270 m to the top", then "Top of the climb", with a sparkline of the next 800 m.
  - Turn card, calm gap card ("In 180 m: 146 m without a bike lane…" → "Back on a bike lane"; in winter mode, "without a winter-cleared lane").
  - Places pop up on their real side of the street (at most 8, names on the 3 nearest). The map's own POI icons hide while riding, except metro.
- **Icons:** metro = white down-arrow on a blue disc, ringed with the colours of the lines serving the station; BIXI = BIXI red tag with a plain bike, plus the live badge. Both are our own drawings that only echo the real signs (no logos copied).
- **Phone panel (2026-10-29):** on phones the panel is a swipeable bottom sheet. Drag the handle (or the Piste header) up for full screen, or down to a small strip to focus on the map. A tap steps through the sizes; a quick flick moves one step.
- **Installable:** web manifest and home-screen icon, so Safari → Share → Add to Home Screen opens it full screen.

## Phone preview
`prototypes/phone.html` shows the app inside 1–3 iPhone-sized screens side by side (SE, 13/14, 15/16, 17/16 Pro/17 Pro, Pro Max), as a home-screen app or a Safari tab. Each phone has its own screen picker: routes (Rachel with a climb, Mont-Royal → Papineau), the 3D ride with a hill, the top-down ride, classic rides (Old Port, Lachine Canal), Suggest a ride (a 10 km loop, a loop with a coffee stop), winter mode in French, wind & rain, the 3D view and the plain map. It's for layout and flow; the real check is the iPhone itself.

## Known limits (prototype stage)
- **Routing is island-wide; most map layers are not.** The routing graph covers the whole island. Still study area only (Plateau, Rosemont, Hochelaga, Centre-Sud, Olympic Park): buildings, elevation colours, hill shading and contours, LiDAR terrain tiles (AWS terrain tiles elsewhere), POIs and the planned/works layer.
- **Island graph gaps:** speed limits and the arterial network only exist for the City of Montréal, not the other island municipalities. About 26% of the graph's nodes fell in disconnected pieces and were dropped (mostly Laval and Île-Bizard fragments, and unconnected paths). See `05_routing.md`.
- **Ride is simulated** (no GPS yet).
- **Snow-clearing status isn't public.** Winter mode uses the City's 4-season network and the weather forecast, not real clearing. The City's Planif-Neige API needs a token (requested by email) and covers street snow removal, not bike lanes; it would also need a small server.
- **Online sources:** basemap tiles (OpenFreeMap), terrain tiles outside the study area (AWS), address search (Ville de Montréal API), the forecast (Open-Meteo), radar (Environment Canada) and live BIXI. The classic-ride photos and all other data ship with the site.
- **Voice:** voice prompts use the browser's speech synthesis. Voice commands (speech recognition) were on the old "Before you ride" sheet and aren't offered now; the code is still in `shared/common.js`.
- **Phone layout:** the panel is now a swipeable sheet. More design work is possible.
