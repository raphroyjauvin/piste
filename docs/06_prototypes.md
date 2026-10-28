# The three prototypes (2026-10-25)

All three share the data (`prototypes/shared/data/`), the router and the ride simulator. Each one tests a different cartography and a different way of warning about stretches without a bike lane. Open them from the gallery (`prototypes/index.html`, served by `start-prototypes.bat`).

Every prototype opens on a test trip. Add `?trip=rachel|montroyal|biodome|davidson` to the URL to pick one.

## A · Positron (MapLibre GL JS 5.24, light)
- **Basemap:** OpenFreeMap "Positron", softened, with our own LiDAR buildings and relief.
- **Route:** STM blue by tier (solid protected, light painted, dashed shared). Soft orange where there's no bike lane, with an "N m no bike lane" pill. The bike network is green.
- **Planning:** three options (your route / most bike lanes / most direct) with time, distance, climb and a composition bar.
  - The direct ↔ bike-lanes slider re-routes live, and so does dragging the pins.
  - You also get an elevation profile with gaps shaded, a gap list (click to zoom) and turn-by-turn.
- **3D:** a one-button toggle, with a square ↔ cube icon. Bird's-eye uses a narrow 22° lens, which looks almost axonometric, and is turned to "Montreal north".
- **Before riding:** a sheet with alert options:
  - soft chime
  - voice prompts through the speaker
  - voice commands where the browser supports them
  - watch taps (marked iPhone-app only)
  - a reminder of the Québec rules
- **Ride (simulated):**
  - Heading-up camera, with an upright "you" pin and a heading cone.
  - A turn card, plus a calm gap card: "In 180 m: 146 m without a bike lane on Rue Rivard · busy street", then "No bike lane for 20 m… Ride with traffic", then "Back on a bike lane".
  - A climb chip, and POIs popping up on their real side of the street as you approach.
- **Browsing:** the Layers panel adds "Planned & in construction" (City live data). It hides itself as soon as a route is shown.
- **Compare other engines:** for a test trip, shows OSRM, Valhalla and BRouter lines next to ours.

## B · Métro Noir (MapLibre, dark)
- **Basemap:** OpenFreeMap "dark", recoloured toward a neutral charcoal (Esri Dark Gray mood). The real STM lines show faintly.
- **Route as a metro line:** green protected, blue painted, yellow shared, orange no bike lane, with white station dots at every turn.
- **Strip map** along the bottom: the whole trip as one line. Turns are stations, orange stretches are labelled, POIs sit above (left side) or below (right side), and the elevation silhouette runs behind. A white dot shows where you are.
- **Ride:** white signage-style turn card, an orange-outlined alert, and **side rails** listing what's coming up on your left and right with distances.
- **Metro view:** the route as an octilinear diagram, stations at turns. Nearby real metro stations appear as transfers (Assomption, Viau, Pie-IX…).

## C · Here & There (three.js r186)
- **The model:** a true orthographic (axonometric) white model, with no basemap tiles.
  - Terrain from the LiDAR 20 m grid.
  - Parks, water and 25 m contours painted on the ground.
  - 71,000 buildings with LiDAR heights and soft shadows.
  - Streets as white ribbons and the bike network as green ribbons.
- **Bend ahead:** beyond 90 m ahead, the ground curves up toward you, so far stretches and hills fit on screen. It's a subtle version of the "Here & There" horizonless map. Slider 0–1.
- **Hills ×:** terrain exaggeration, rising further for what lies ahead. Slider 1–4.
- **Views:** axonometric ↔ top-down with one button; a small 3D cyclist in a blue ring.
- **Controls:** drag to pan, scroll to zoom, right-drag to turn. Click the model to set the destination, Shift-click for the start.

## What to look at when you're back
1. Which look you'd want to ride with every day: A light, B dark, or C model.
2. Whether the gap warnings feel clear but calm, and whether the soft orange is right.
3. B's strip map and side rails vs A's POIs on the map: which reads faster at a glance?
4. C's bend: too much, too little, or worth combining with A's map in the long run? (MapLibre can't bend the world; three.js can.)
5. POI density, and which POI types matter most to you.

## Known limits (prototype stage)
- **Study area only:** Plateau, Rosemont, Hochelaga, Centre-Sud, Olympic Park. The island-wide graph is next.
- **Ride is simulated** (no GPS yet). On iPhone, browser GPS needs HTTPS hosting.
- **Online sources:** basemap tiles (OpenFreeMap), terrain tiles (AWS, used in A's 3D terrain option) and address search (Ville de Montréal API) need internet.
- **C** builds its 3D model in the browser, in about 3–5 s on this PC. It isn't tuned for phones yet.
- **Voice commands** use the browser's speech recognition. Edge and Chrome support it; iPhone Safari only partly.
