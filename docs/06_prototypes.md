# The app prototype

Started as three prototypes on 2026-10-25. On 2026-10-28 Raph chose **A (Positron, MapLibre)** and dropped B (Métro Noir) and C (Here & There). The only idea kept from C is the feeling of a hill coming up while riding in 3D. B and C stay in the git history (first commit).

The app lives in `prototypes/a-positron/`. It uses the shared data (`prototypes/shared/data/`), router and ride simulator.

## URL options
- `?trip=rachel|montroyal|biodome|davidson|none`: open on a test trip (default `montroyal`).
- `?from=lon,lat&to=lon,lat`: open on any trip.
- `?view=3d`: start in bird's-eye 3D.
- `?ride=bird|top`: start the simulated ride; add `&at=<metres>` to jump along it and `&paused` to hold still (used for screenshots and tests).
- `?suggest=loop|oneway&km=10&stop=cafe`: open "Suggest a ride" (stops: cafe, food, bakery, icecream, bar, market, shop, park, viewpoint, culture, bikeshop).
- `?safe=top,bottom`: simulated phone safe areas in px (the phone preview sets this, since desktop browsers report 0).

## What's in it
- **Basemap:** OpenFreeMap "Positron", softened, with our own LiDAR buildings.
- **Elevation (2026-10-28):**
  - soft sand-to-tan elevation colours (10 → 200 m) over land and parks, not water; they fade at street zoom
  - strong LiDAR hill shading
  - contours every 5 m, bold and labelled every 25 m
  - in 3D, LiDAR terrain tiles inside the study area, AWS terrain tiles outside it
  - legend with the colour ramp
- **Route:** STM blue by tier (solid protected, light painted, dashed shared). Soft orange where there's no bike lane, with an "N m no bike lane" pill. The bike network is green.
- **Climbs:** stretches rising ≥ 2.5 % for ≥ 80 m and ≥ 3 m; runs split by a short flat breather count as one hill. Shown as uphill chevrons on the route (Michelin style: 1, 2 or 3 chevrons by steepness), shaded on the profile with "+N m", and summarised under it ("Steepest: 5% on Rue Rachel Est").
- **Planning:** three options (your route / most bike lanes / most direct) with time, distance, climb and a composition bar. The direct ↔ bike-lanes slider re-routes live, and so does dragging the pins. Gap list (click to zoom) and turn-by-turn.
- **Suggest a ride (2026-10-28, `shared/suggest.js`):** a second tab next to "Go somewhere". You set a start, loop or one-way, a distance (2–20 km) and an optional stop kind; you get three rides.
  - Loops with no stop: a circle through the start, tried in 8 directions and resized until its length fits (about 35 ms for all of them).
  - With a stop: places of that kind at about the right distance, spread around the compass; a loop goes out to the stop and comes back another way (streets already ridden cost 4× on the way back).
  - One-way with no stop: ends at a metro station (easy way home), a park or a viewpoint.
  - Ranked by share on bike infrastructure, closeness to the asked distance and how little it retraces; the three kept share less than 45% of their streets. They use the same route-style slider and hill setting as normal routes.
  - The stop is a ring on the map with "Stop · name", an instruction while riding ("Stop: Café …"), and "stop after 4.5 km" on the card.
  - Shops (999 named shops from OSM: clothes, books, gifts, sports…) were added for the "Shopping" stop; they show on the map from zoom 17.
- **3D:** one-button toggle (square ↔ cube; the label names the view you switch to). Bird's-eye uses a narrow 22° lens, which looks almost axonometric.
- **Before riding:** a sheet with alert options (soft chime, voice prompts, voice commands where supported, watch taps marked iPhone-app only) and a reminder of the Québec rules.
- **Ride (simulated):**
  - Camera low and behind the rider (pitch 70°, rider at 70% of the screen height), heading-up.
  - **Hill ahead:** from about 520 m before a climb, the terrain exaggeration rises from ×1.6 to up to ×3.4 (steeper climbs get more), the camera tilts up 3° and pulls back a little; it eases back after the top.
  - Hill card above the ride bar: "Climb in 260 m · +30 m over 860 m · 4% avg, 5% max", then "Climbing · 5% · 270 m to the top", then "Top of the climb", with a sparkline of the next 800 m.
  - Turn card, calm gap card ("In 180 m: 146 m without a bike lane…" → "Back on a bike lane").
  - Places pop up on their real side of the street (at most 8, names on the 3 nearest). The map's own POI icons hide while riding, except metro.
- **Icons:** metro = white down-arrow on a blue disc, ringed with the colours of the lines serving the station; BIXI = BIXI red tag with a plain bike. Both are our own drawings that only echo the real signs (no logos copied).
- **Installable:** web manifest and home-screen icon, so Safari → Share → Add to Home Screen opens it full screen.

## Phone preview
`prototypes/phone.html` shows the app inside 1–3 iPhone-sized screens side by side (SE, 13/14, 15/16, 17/16 Pro/17 Pro, Pro Max), as a home-screen app or a Safari tab. Each phone has its own screen picker (route, 3D ride with a hill, top-down ride, explore). It's for layout and flow; the real check is the iPhone itself.

## Known limits (prototype stage)
- **Study area only:** Plateau, Rosemont, Hochelaga, Centre-Sud, Olympic Park. The island-wide graph is next.
- **Ride is simulated** (no GPS yet).
- **Online sources:** basemap tiles (OpenFreeMap), terrain tiles outside the study area (AWS) and address search (Ville de Montréal API).
- **Voice commands** use the browser's speech recognition: Edge and Chrome support it; iPhone Safari only partly.
- **Phone layout:** works, but it's the desktop panel squeezed into a bottom sheet. A proper phone layout is the next design step.
