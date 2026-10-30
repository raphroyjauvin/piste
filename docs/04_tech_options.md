# Technical options and what's needed (draft 2026-10-25)

## Update 2026-10-25, afternoon: what we chose and why
- **Routing:** our own router in the browser. It was tested against OSRM, Valhalla and BRouter, and wins on bike-path share and speed (see `05_routing.md`). QGIS is no longer the routing tool. It stays useful for checking data.
- **Maps:** MapLibre GL JS **5.24** (the last version with a plain-script build; v6 is module-only), plus **three.js r186** for the axonometric model. Both are vendored in `prototypes/vendor/`.
- **three.js** works well here. Prototype C builds 71k buildings, terrain and route ribbons in about 3–5 s. It uses an orthographic camera, and its shaders bend the world and exaggerate hills ahead live, so the sliders respond instantly. On phones it will need tiling or a smaller radius around the route.
- **Basemap for the prototypes:** OpenFreeMap (free, no key). For a public app: host our own Protomaps PMTiles file for Montreal on a CDN, so nothing depends on someone else's free service. (2026-10-29: our own layers already work this way. Hill shading, tint, contours and buildings are four PMTiles files on GitHub Pages, read with HTTP range requests. Only the basemap itself, with streets, water, parks and labels, is still OpenFreeMap.)
- **Database or TablePlus question:** a local PostgreSQL/PostGIS server is free; the data lives on your own disk. But the app doesn't need a database at runtime. It runs on static files (graph, layers, tiles) served from a free host or CDN. Use PostGIS or DuckDB only as an analysis workbench when that helps, and keep it separate from any work server.
- **Phone testing:** browser GPS on iPhone needs HTTPS, so the next step is a free static host: GitHub Pages, or Cloudflare Pages if the repo stays private. Native iPhone permissions (background GPS, watch taps) come later, with Capacitor. (2026-10-28: the site went up on GitHub Pages. 2026-10-30: the browser GPS ride is built and works there over HTTPS, but it is not yet checked on a real iPhone; see `06_prototypes.md`.)
- **GitHub:** the GitHub connector is installed but not authorised in this session (authorise it with `/mcp` or in the app's connector settings), and Git isn't installed on this PC. Once both are done: create a repo (`raphroyjauvin/piste`?), commit, and optionally turn on Pages.

## 1. Why not Google's bike routes
- **No way to stay on bike lanes.** Google's Routes API has a bicycle mode, but its route options only avoid tolls, highways, ferries and indoor paths. Bicycle routes are in beta and must show a warning.
- **Terms of use.** Google's terms say Directions content must not be used with a non-Google map. So we couldn't draw Google's route on our own soft map or 3D view.
- **Cost.** Google charges per request.
- **Better data.** Montreal's own data is richer for this job: facility type, protection, 4-season status, REV, pavement condition and closures.

→ Use Google Maps (and Transit) only as a benchmark: ride the same test trips in each and compare.

## 2. Routing: our own network and our own weights
The bike network joins the City's Géobase by `ID_TRC` (99.9% of km), so:
- **Graph:** Géobase street segments and nodes. Each segment is tagged with:
  - its bike tier (A–C) or gap class (D quiet or E busy, from speed limits and the arterial flag)
  - direction rules
  - 4-season flag
  - pavement condition
- **Cost:** length × tier penalty × pavement, construction and season factors (hills later), plus a detour cap and a strictness slider.

Options, from least to most effort:

| Option | What it is | Good for | Watch out for |
|---|---|---|---|
| QGIS "Shortest path" with a cost field | No code; test weights by hand | Phase 1 sanity check | Slow and manual |
| Python graph (networkx or igraph) in Positron | A notebook that runs 10–100 test commutes and compares them | Phase 1 tuning | Not an app |
| Router inside the web page (A* search in a background thread, on a compact graph) | The island graph is small, about 48k segments, so a few MB | Phases 2–3: no server, works offline, private, re-routes instantly when the slider moves | We write the turn-by-turn text ourselves |
| GraphHopper, Valhalla, BRouter or OSRM | Open-source routing servers | Growing to the whole region, or needing speed | Built around OSM tags, so we'd translate our tiers into tags; needs Java or Docker |
| pgRouting (PostGIS) | Routing in SQL | Familiar to you | Needs a server. Don't use a work database |

**Lean:** QGIS and Python first, then the in-page router. Use OSM only where the Géobase stops (bridges and paths off the island).

## 3. Map rendering and the 3D view
| Option | 3D massing | Axonometric | Cost and licence | Fit |
|---|---|---|---|---|
| **MapLibre GL JS v6** (6.16.0) | Yes (extruded buildings) | Close: `setVerticalFieldOfView()` takes 0–180°; a narrow angle gives a near-axonometric look (to test) | Free, open source (BSD) | **Recommended** |
| Mapbox GL JS v3 (3.33.0) | Yes, with lights and shadows | True orthographic camera (`camera-projection: "orthographic"`) | Proprietary; free tier, then paid; needs an account | Plan B for the 3D look |
| Google Maps JavaScript API | Yes, including photorealistic 3D | No | Paid per map load; Google's look only | No: it locks in the look |
| three.js custom view | Full control | True orthographic | Free, but the most work | Stretch goal: a white-model corridor view around the route |

- **Seeing yourself:** a 3D cyclist model through a three.js custom layer in MapLibre (MapLibre has an official example), or a simple heading puck. The camera follows behind and above you, pitched about 55–65°.
- **Base tiles:** recommended is the Protomaps basemap, one PMTiles file we host ourselves (no key, no meter, OSM credit). OpenFreeMap (free public tiles, no key, but it may change) is fine for quick tests. MapTiler or Stadia (free tiers with a key) are the fallback. Tested 2026-10-29 on our own layers: a PMTiles file on GitHub Pages works with no tile server. GitHub refuses files over 100 MB (the building script warns above 90 MB), so check a basemap file against that limit before choosing this host.
- **Our Montreal layers:** built 2026-10-29 as PMTiles with our own Python scripts (`tools/island_tiles.py`, `tools/island_buildings.py`: rasterio, shapely, mapbox-vector-tile and the `pmtiles` writer, with GDAL from QGIS for the contours and the warps). No tippecanoe or planetiler was needed. Details in `06_prototypes.md`.

## 4. Search and POIs
- **Address search:** build a small search index from Montreal's official address points. For prototypes, Photon (Komoot's free OSM geocoder, fair use) works. Nominatim's public server forbids search-as-you-type.
- **POIs:**
  - OSM: cafés, restaurants, bike shops, repair stations, air pumps, water, racks
  - Overture places: more businesses
  - City fountains
  - BIXI GBFS: live dock availability

## 5. Platform path
1. **Desktop web prototype** (Phase 2): the fastest to iterate and the easiest to show.
2. **Phone web app, or PWA** (Phase 3):
   - It installs from the browser and uses GPS while the screen is on.
   - Screen Wake Lock keeps the screen on, and speech handles audio cues. (Both are in the GPS ride since 2026-10-30.)
   - Limits: iPhone web apps can't vibrate, and there's no GPS with the screen off.
   - It needs HTTPS, from a free static host (Cloudflare Pages, Netlify or GitHub Pages).
3. **Native app** (Phase 4): wrap the web app with Capacitor to reuse the code, or rebuild in React Native with MapLibre Native. That unlocks background GPS, lock-screen updates, watch taps and the app stores (Apple $99 a year, Google Play $25 once).

## 6. Québec rules that shape the design
- **Earphones and phones.** Cyclists may not wear earphones or use a hand-held device while riding (fines of about $80–100). A mounted phone is fine if it needs no handling. Sources: Vélo Québec, Sûreté du Québec, Narcity; the exact articles still need checking on LégisQuébec.
  - So Ride mode must need zero touches.
  - Audio comes through the phone speaker or a watch tap; never tell riders to use earbuds.
- **French language Charter.** A public Québec app should be in French, with English too.

## 7. What's needed from Raph
- **Answers** to the open questions in `README.md`.
- **5–10 real trips** you ride. Start and end can be rough: use intersections, not your home address.
- **3–5 screenshots of maps you love**, for the style.
- **Your phone model.**
- **OK for bigger downloads:**
  - Géobase (41 MB)
  - an OSM extract for the island (roughly 50–100 MB)
  - building footprints and the surface model for 3D (150 MB and up)
- **Later:**
  - a GitHub account (the GitHub connector needs authorising with `/mcp`)
  - a free static host for HTTPS testing on your phone
  - maybe a MapTiler or Mapbox key, if we choose them
- **Tools to install when building starts:**
  - Git for Windows
  - DuckDB (optional, for Overture)
  - Java 21, only if we pick GraphHopper, BRouter or planetiler

  You already have Node 24, Python 3.14 with uv, QGIS 4.0.1 (with GDAL), VS Code and Positron.

## Sources
- [Google Routes API: bicycling, with the beta warning](https://developers.google.com/maps/documentation/javascript/routes/route-bicycling?hl=en)
- [Google Maps Platform Service Specific Terms (non-Google map clause)](https://cloud.google.com/maps-platform/terms/maps-service-terms/index-20240522)
- [MapLibre GL JS camera options](https://maplibre.org/maplibre-gl-js/docs/API/type-aliases/CameraOptions); `setVerticalFieldOfView` checked in the v6.16.0 type definitions
- [Mapbox: field of view example](https://docs.mapbox.com/mapbox-gl-js/example/field-of-view/); orthographic camera checked in the v3.33.0 type definitions
- [Protomaps docs](https://docs.protomaps.com/) · [OpenFreeMap (Simon Willison)](https://simonwillison.net/2024/Sep/28/openfreemap)
- [Vélo Québec: cycling rules](https://www.velo.qc.ca/en/?p=5199) · [Narcity: cycling fines](https://www.narcity.com/fr/amendes-velo-code-securite-routiere-quebec) · [Sûreté du Québec bulletin](https://www.saintfelixdekingsey.ca/medias/doc/articles-evenements/sq_a_velo.pdf)
