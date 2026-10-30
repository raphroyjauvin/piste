# Cartography principles (2026-10-25)

## Update 2026-10-29, island-wide layers
The look is unchanged; the same layers now cover the whole island (files, sizes and counts in `06_prototypes.md`). Rules that decide what shows at each zoom:
- **Hill shading:** the same recipe (relief factor ×2.3, 10 m smoothing, opacity about 0.85 → 0.72), computed from the merged 5 m LiDAR terrain model at about 4.8 m per pixel. The tiles stop at z14 and closer zooms stretch z14. That is invisible, because the shading is smoothed over about 50 m.
- **Elevation tint:** the same sand ramp, computed on a 10 m grid smoothed over 20 m; tiles z9–13.
- **Contours get lighter as you zoom out**, so the map stays quiet: z11–12 show the bold 25 m lines only, z13 adds the 5 m lines, z14–15 add the 1 m detail lines on moderate slopes (2.5–15%). Lines shorter than 4 px at their zoom are dropped, and 5 m lines under 60 m or detail lines under 120 m long are never drawn. The map shows the 25 m lines from zoom 11.5, the 5 m lines from 13 and the detail lines from 14.
- **Buildings, big ones first:** z13 keeps footprints of 250 m² and up, z14 40 m² and up, z15 all, so a zoomed-out map doesn't turn to noise. The flat buildings fade in between z13 and z14 (opacity 0 → 0.92). The 3D massing, extruded by LiDAR height, starts at z14.

## Update 2026-10-29, later: no gap boxes, smaller sight circles, phone map controls, wording
- **No gap boxes on the map.** The orange label boxes on stretches without a bike path ("N m no bike path"; "N m not cleared" in winter mode; layer `gap-labels`) are removed. A stretch still shows as the orange dashed route line, and the panel lists the stretches. The calm gap cards while riding are unchanged.
- **Sight circles half the size.** The white circles with a blue outline that mark a classic ride's key sights are now radius 7.5 px with a 2.5 px outline. The same layer draws the stop of a suggested ride.
- **Phone map controls.** The zoom buttons and the scale bar are hidden on phones (the swipeable card covered them; pinch to zoom). The map credits button (ⓘ) moved to the top left, so the OpenStreetMap and data credits stay reachable.
- **Wording.** "Bike path(s)" in English and "piste(s) cyclable(s)" in French on every label, legend entry and card; the rule is in principle 10 below.

## Update 2026-10-29: winter, weather, live BIXI, calmer elevation
- **Winter palette** (the snowflake button): the same soft map, shifted to an icy light blue. "Soft map, loud route" still holds.
  - land `#eef4f8`, parks `#e1ecf1`, water `#b9d2e2`
  - also tinted: residential land `#e6eef4`, woods `#dbe6ed`, rivers `#a9c6d9`, buildings `#e2e9ef` (3D buildings `#f3f6f9` to `#d6e0e8`), major road casings `#c6d6e2`
  - the elevation colours are hue-rotated toward blue (and desaturated), so hills don't look warm on a cold map
  - contours `#7895aa`, their labels `#5c7689`
  - the 4-season bike paths stay green, as in summer, so "green = a bike path that is cleared" still holds
  - bike paths that aren't cleared turn grey and dotted (`#aebbc6`). They look faded, not alarming. The warnings ("without a winter-cleared bike path") use the same soft orange as any other gap: the dashed orange line and the panel list.
- **Weather card and wind streaks:**
  - Wind streaks are thin slate-blue lines (`rgba(52, 92, 124, 0.5)`, 1.6 px). They drift across the map the way the wind blows and turn with the map. They fade slowly, which leaves short trails, and they stay quiet so the route and labels remain readable.
  - The radar is a half-transparent overlay (50%) under the bike network and the route.
  - The weather card is a small white card at the top of the map, in the same style as the other cards: an arrow pointing the way the wind blows, the wind, the rain outlook and, last, the line about the selected route (headwind or tailwind, and minutes). In winter mode it adds the snow and ice lines.
- **BIXI badge colours:** green `#1d6a2c` (3 or more bikes), orange `#c26b12` (1–2), grey `#8a929a` (empty), dark grey `#5a6168` (not renting). The number is written in the badge, so colour is never the only signal (principle 4 below). The badge sits at the top right of the station icon and never hides it.
- **Location pins:** the search fields and the map use the same two pins, so the ends are easy to tell apart. The start is mostly blue (blue pin, white dot); the destination is mostly white (white pin with a blue outline and dot).
- **Elevation toned down**, halfway between the first prototype and the strong version of 2026-10-28:
  - hill shading: relief factor ×2.3 (first prototype ×1.8, strong version ×2.8), smoothing 10 m, opacity about 0.85 → 0.72 from small to large zoom
  - 3D hill-ahead boost halved: terrain ×1.6 at rest, up to about ×2.5 (was ×3.4)
  - the profile and hill-card graphs use a larger minimum height range, so a small climb doesn't look like a cliff
- **Contours replace the chevrons.** The uphill chevrons are gone. Extra 1 m contour lines are drawn only where the ground rises 2.5–15% (slope over about 25 m, small patches removed). A climb now reads the way it does on a topographic map: closer lines mean steeper ground. These lines are thin and light (visible from zoom 14) and use the same brown as the other contours (`#9a7c52`). The 5 m and bold 25 m contours are unchanged.

## Update 2026-10-28: elevation, and one prototype (A)
- **Raph's direction:** keep A only. In 2D, elevation must be very clear; in 3D, you should feel a hill coming up while riding (the one idea kept from C).
- **2D elevation, three layers working together:**
  - *Colour:* a soft hypsometric tint, sand to tan, from 10 m (transparent) to 200 m. It covers land and parks but not water, so Mont Royal reads as one hill whether park or cemetery. It fades from full at zoom 13 to 45% at zoom 17, where the street map must stay clean. A first, browner ramp was too heavy and stopped at park edges; the ramp was softened the same day.
  - *Shading:* multidirectional LiDAR hillshade (5 m, ×2.8), dark shadows and light highlights, under the streets.
  - *Contours:* every 5 m, bold every 25 m with labels; a warm brown (`#9a7c52`) that doesn't fight the green bike network.
- **Climbs on the route:** Michelin-style uphill chevrons, pointing uphill, 1–3 by steepness, dark brown with a white edge so they read on blue, light blue and orange. The profile shades climbs in the same tan.
  - *Changed 2026-10-29: the chevrons were later replaced by extra 1 m contour lines on climbs, and the shading (×2.8) and the 3D boost (×3.4) were toned down. See above.*
- **3D:** LiDAR terrain (×1.6). While riding, the terrain swells (up to about ×3.4) as a climb approaches; the camera sits low and behind the rider (pitch 70°).
- **Icons that echo real signs, drawn from scratch:** metro = white down-arrow on a blue disc (the métro entrance sign idea, STM 1963), ringed by line colours; BIXI = BIXI red (`#EE3124`) tag with a plain bike. No logo artwork is copied; check STM and BIXI terms before a public launch.

## Update 2026-10-25, afternoon: Raph's direction, as built in the prototypes
- **Theme colours:** the official STM metro colours from GTFS: green `#00B300`, orange `#D95700`, yellow `#FFD900`, blue `#0095E6`.
  - A and C: the route is blue, the bike network green, and gaps a **soft** orange (`#ef8f45`, dashed on quiet streets).
  - B: the route takes metro colours by tier (green protected, blue painted, yellow shared, orange no bike path).
- **Red** (`#d7263d`) is used only for something closed to cyclists. It never marks an ordinary gap.
- **Calm alerts:** soft orange cards with plain words ("In 180 m: 146 m without a bike path on Rue Rivard · busy street"), then a green "Back on a bike path".
- **Basemaps:** Positron light (A) and a charcoal dark inspired by Esri Dark Gray (B). Both are minimal, and relief comes from our 2023 LiDAR shading.
- **3D:** a white architectural massing model, with the "Here & There" bend made subtle (C), and a narrow-lens bird's-eye view in MapLibre (A, B).
- **Reference maps** are kept in `docs/mapideas/`: the pictorial navy and coral map, "Here & There", the wildfire infographic and the STM black metro map. The pictorial two-tone style is not built yet; it's a candidate for a playful "explore" skin.

## Core rule: soft map, loud route
The base map steps back, and the route and its gaps stand out. This is figure-ground: low contrast in the base, high contrast in the route.

## Principles, and how we apply them
1. **Visual hierarchy follows importance** (Axis Maps). Order in Ride mode, from loudest to quietest:
   1. you (position and heading)
   2. next turn
   3. route, by tier
   4. next gap
   5. bike network for context
   6. POIs near the route
   7. streets and labels
   8. land, parks, water, buildings
2. **Low-contrast base** (Esri: legibility, contrast, figure-ground, hierarchy, balance). Use warm off-white land, pale parks and water, white streets with a faint casing, and light buildings. Saturated colour appears only in the route, alerts and POI pins.
3. **Few colours.** Google cut its map palette from 700+ colours to 25 tones. Target about 15 base tones, 5 route styles and 6 POI categories.
4. **Never use colour alone.** Tiers differ by colour, line style (solid, dashed, patterned) *and* width, so the map works for colour-blind riders. Blue and orange are the safest pair; avoid red vs green for "good vs bad". Check every style in a colour-blindness simulator.
5. **Ride mode puts daylight readability before prettiness.** Sunlight washes out pastels on a phone. The ride style gets a darker route, bigger type (18 px or more) and high contrast for text and route (aim for 7:1, the WCAG AAA level). A night style switches on automatically at dusk.
6. **Orientation.** Use north-up for planning and heading-up while riding; research on in-car maps finds heading-up suits "what's ahead of me" tasks. Keep the rider in the lower third of the screen so more road ahead shows, and zoom out with speed.
7. **Glanceable.** Each glance should answer two questions: where do I turn next, and is a gap coming? Use sound and a watch tap so eyes stay on the road. Research on cyclists is thin, but a motorcycle study found head-up displays cut overly long glances by 45% compared with phone tasks.
8. **Route line in layers:**
   1. casing (widest)
   2. tier line
   3. gap pattern and chevrons
   4. direction arrows

   The Mapbox navigation SDK does the same: casing, then route, then traffic.
9. **3D massing** looks like an architect's white model: light warm-grey volumes with a subtle vertical gradient, lit from the north-west (the usual cartographic convention). Fade or lower buildings near the route so they never hide it.
10. **Labels:** one open sans-serif family with clear weights (for example Inter, or Atkinson Hyperlegible for legibility) and white halos. Use the official French street names, with a bilingual interface. Show fewer labels while riding. **Wording (2026-10-29):** "bike path(s)" in English and "piste(s) cyclable(s)" in French, never "bike lane(s)", "cycle track", "voie cyclable" or "bande cyclable". The tiers read "Protected bike path", "Painted bike path", "Shared bike path" and "No bike path" ("Piste cyclable protégée", "Piste cyclable peinte", "Piste cyclable partagée" and "Sans piste cyclable" in French).
11. **POIs, Google-style:** a coloured circle with a white symbol, colour-coded by category. In Ride mode, show only POIs within about 150 m of the route; in Plan mode, show everything at closer zooms.
12. **Lessons from bike maps:**
    - CyclOSM was criticised because its tier colours were too subtle, so make our tiers clearly distinct.
    - Transit's neon outline makes protected bike paths pop.
    - BIXI's dashed line for one-way bike paths is a useful convention.

## Starting palette (something to react to, not final)
| Element | Day | Night |
|---|---|---|
| Land | `#F5F3EE` | `#1E2126` |
| Parks | `#DDEBD5` | `#23302A` |
| Water | `#C6DDF0` | `#16273A` |
| Streets | `#FFFFFF`, casing `#E2DED6` | `#2E333A` |
| Buildings (3D) | top `#EFEBE4`, sides `#D9D3C9` | `#2A2E35` |
| Bike network (context, thin) | `#6BAF92` | `#4E8C74` |
| Route, tier A protected | `#1A56DB`, thick solid, white casing | `#5B8CFF` |
| Route, tier B painted | `#5B8DEF`, medium solid | `#7FA6FF` |
| Route, tier C shared | `#1A56DB`, dashed | `#5B8CFF`, dashed |
| Gap, tier D quiet | `#F08C00`, dashed | `#FFA94D`, dashed |
| Gap, tier E busy | `#D9480F` with chevrons, dark casing | `#FF6B3D` |

The logic: green means bike infrastructure on the map, blue means *your* route, and orange means caution.

POI categories:
- food (orange)
- café (amber)
- bike services: shops, repair stations, air (blue)
- water and toilets (teal)
- parks and viewpoints (green)
- BIXI (dark grey, with a bike symbol)

## Sources
- [Axis Maps: visual hierarchy](https://axismaps.com/guide/visual-hierarchy)
- [Esri: five primary design principles](https://www.esri.com/about/newsroom/arcuser/make-maps-people-want-to-look-at-five-primary-design-principles-for-cartography)
- [Google Design: Exploring Color on Google Maps](https://goo.gle/3oU70hH)
- [Map Room: a former Google Maps designer on the 2023 palette](https://www.maproomblog.com/2023/11/thoughts-on-google-maps-new-design-from-a-former-google-maps-designer/)
- [Mapbox Navigation SDK: route line layers](https://docs.mapbox.com/android/legacy/navigation/guides/styles/)
- [ISPRS paper: heading-up vs north-up](https://www.isprs.org/proceedings/XXXIV/part2/paper/032_151.pdf)
- [Google Maps Platform design resources: night mode, contrast](https://developers.google.cn/maps/documentation/ios-sdk/cloud-customization/design-resources-leg?hl=en)
- [JYU study: motorcycle HUD vs smartphone glances](https://jyx.jyu.fi/handle/123456789/60811)
- [CyclOSM](https://cyclosm.org/) · [Talk-GB feedback on the CyclOSM legend](https://lists.openstreetmap.org/pipermail/talk-gb/2021-January/026060.html)
