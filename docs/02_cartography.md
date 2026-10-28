# Cartography principles (2026-10-25)

## Update 2026-10-25, afternoon: Raph's direction, as built in the prototypes
- **Theme colours:** the official STM metro colours from GTFS: green `#00B300`, orange `#D95700`, yellow `#FFD900`, blue `#0095E6`.
  - A and C: the route is blue, the bike network green, and gaps a **soft** orange (`#ef8f45`, dashed on quiet streets).
  - B: the route takes metro colours by tier (green protected, blue painted, yellow shared, orange no lane).
- **Red** (`#d7263d`) is used only for something closed to cyclists. It never marks an ordinary gap.
- **Calm alerts:** soft orange cards with plain words ("In 180 m: 146 m without a bike lane on Rue Rivard · busy street"), then a green "Back on a bike lane".
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
10. **Labels:** one open sans-serif family with clear weights (for example Inter, or Atkinson Hyperlegible for legibility) and white halos. Use the official French street names, with a bilingual interface. Show fewer labels while riding.
11. **POIs, Google-style:** a coloured circle with a white symbol, colour-coded by category. In Ride mode, show only POIs within about 150 m of the route; in Plan mode, show everything at closer zooms.
12. **Lessons from bike maps:**
    - CyclOSM was criticised because its tier colours were too subtle, so make our tiers clearly distinct.
    - Transit's neon outline makes protected lanes pop.
    - BIXI's dashed line for one-way lanes is a useful convention.

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
