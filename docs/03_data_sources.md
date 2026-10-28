# Data sources and quirks (checked 2026-10-25)

## Update 2026-10-25, afternoon: fresher sources found and used
| Source | What it gives | Freshness | Use |
|---|---|---|---|
| **City live bike tiles**: `api.montreal.ca/api/it-platforms/geomatic/vector-tiles/maps/v1/pistes-cyclables/{z}/{x}/{y}.pbf` (behind the City's interactive bike map; open to any website) | Layer `pistes-cyclables`: the current network with **REV axes** (`revAxes`, `revAxeNum*`), surface, width, bridge/tunnel, year built, and **temporary closures** (`avancementCode` FT). Layer `pistes-cyclables-projete`: **planned** (P, GP) and **in development this year** (D) bike routes, with project names and program years | Live (what the City's own map shows) | Tiers, REV, closures for routing. Planned/in-construction layer for browsing only |
| **City address search API**: `api.montreal.ca/api/geographic/location/v1/addresses?q=` (open to any website) | 702,686 official addresses with coordinates and English/French labels | Live | Destination search |
| **NRCan HRDEM**, `QC-600023_52_CMM_2023-1m` (Cloud-Optimized GeoTIFF on AWS), DTM and DSM | 1 m terrain and surface from the **2023** CMM LiDAR. Cut to the study area with GDAL over HTTP: only the needed bytes download, about 300 MB for both | 2023 | Elevation, climbs, contours, relief shading; building heights = 70th percentile of (DSM − DTM) inside each footprint |
| OpenStreetMap via Overpass | POIs (9,601), bike-legal paths (1,445), buildings (71,763 footprints), parks, water, rail | Continuous | Footprints (newer than the City's 2016 file), POIs, missing paths |
| STM GTFS (`gtfs_stm.zip`) | Official metro colours (green `#00B300`, orange `#D95700`, yellow `#FFD900`, blue `#0095E6`), 68 stations, line shapes | Weekly | Theme colours, metro POIs, metro view |
| BIXI GBFS | 1,121 stations | Live | POIs (live dock counts later) |
| City roadworks (`info-travaux`) + impacts CSV | 94 works **blocking a bike lane** in the study area today (`bikepath_blockedtype`) | Daily | Yellow cone markers; later, re-route around them |

- **Point clouds:** the City's 2015 LiDAR is 111 GB of LAZ. It isn't needed: NRCan already serves the derived 2023 surface and terrain as cloud rasters, and we only pull the window we need. A home NAS shouldn't serve a public app anyway. The app ships small derived files instead (relief PNG, 20 m elevation grid, building heights).
- **Refreshing data:** `tools/fetch_data.py all --refresh`, then the two build scripts. Later this can run on a schedule (GitHub Actions: nightly for roadworks and live tiles, monthly for the rest), with the built files published next to the app.

All Montreal datasets below are CC BY 4.0 (credit "Ville de Montréal"), from donnees.montreal.ca. Each has a CKAN API page at `https://donnees.montreal.ca/api/3/action/package_show?id=<id>`.

## Downloaded (in `data\raw\`; provenance in `_download_log.csv`)
| Folder | Dataset (CKAN id) | Updated | Size | What it gives us |
|---|---|---|---|---|
| `mtl_reseau_cyclable` | Réseau cyclable (`pistes-cyclables`), plus the 2020 data dictionary | 2026-10-01 | 11 MB GeoJSON | The bike network: 9,485 segments, 1,101 km, with type, 4-season flag, REV, Route verte and Géobase ID |
| `mtl_reseau_express_velo` | REV (`reseau-express-velo`) | 2023-06 | 0.05 MB | Only 21 km (4 early axes), so stale |
| `mtl_condition_chaussees_cyclable` | Bike-network pavement condition (`condition-chaussees-reseau-cyclable`), 2024 survey | 2026-04 | 4 MB GPKG | 11,545 sections rated Excellent to Très mauvais (21% of sections Mauvais or Très mauvais); joins on `id_cycl` |
| `mtl_limites_vitesse` | Speed limits (`limites-vitesse`) | 2026-07-03 | 4 MB zipped SHP | 44,667 street segments with a speed; `ID_Troncon` = Géobase ID; EPSG:32188 |
| `mtl_reseau_arteriel` | Administrative arterial network (`reseau-arteriel-administratif`), 2023 | 2023-12 | 13 MB GPKG | 47,826 Géobase segments with `ARTERE` (0/1) and `CLASSE` (0–9, codes to decode); EPSG:32188 |
| `mtl_arceaux_velos` | Bike racks (`arceaux-velos`) | 2023-06 | 0.15 MB CSV (cp1252) | Only 746 racks, mostly in large parks, so use OSM for the rest |
| `mtl_fontaines_a_boire` | Outdoor drinking fountains (`fontaines-a-boire-eau-exterieures`), 2018 inventory | 2023-06 | 0.13 MB CSV | 848 fountains with lat/lon |
| `mtl_rues_pietonnes` | Pedestrian and shared streets (`rues-pietonnes`), 2017 | 2023-06 | 0.06 MB | 53 points; old |
| `mtl_info_travaux_snapshot` | Roadworks in progress (`info-travaux`), today's snapshot | daily | 0.8 MB CSV | 1,878 active permits (points and daily schedules) |
| `bixi_gbfs` | BIXI GBFS `station_information` and `system_information` | live | 0.4 MB | 1,121 stations and 25,672 docks; live availability is in `station_status` |

## Bike network summary (file of 2026-10-01, geodesic lengths)
| Type (code) | km | 4-season km | Proposed tier |
|---|---|---|---|
| Bande cyclable (3) | 283.2 | 241.4 | B |
| Chaussée désignée (1) | 260.5 | 211.0 | C |
| Piste cyclable sur rue (4) | 222.6 | 186.6 | A |
| Piste cyclable en site propre (5) | 200.2 | 84.2 | A |
| Sentier polyvalent (7) | 100.8 | 3.9 | A |
| Piste cyclable au niveau du trottoir (6) | 15.4 | 7.8 | A |
| Voie partagée bus-vélo (9) | 11.2 | 11.1 | C |
| Vélorue (8) | 7.0 | 7.0 | B |
| **Total** | **1,100.8** | **753.0** | |

- The seasonal network is open from April 1 to November 15 (city website). Most off-street paths are seasonal: only 88 of their 301 km stay open in winter.
- The City's site cites 1,083 km in total, 251 km of it physically protected, and a REV of 191 km.

## Known quirks
- **Out-of-date data dictionary.** The PDF is from May 2020.
  - Fields were renamed: `ID2020` → `ID_CYCL` and `ID_TRC_GEOBASE` → `ID_TRC`.
  - New codes exist: `TYPE_VOIE2` 41, 43, 83, 84, and separator `ST` (parking-protected) and `NA`.
- **Float IDs.** `ID_TRC` is stored as float text (`1619033.0`); normalise it to integer text before joining. It is set on 1,099.8 of 1,100.7 km, including off-street paths. So the bike network can join the Géobase by ID, with no spatial matching. To check: how many of those IDs still exist in today's Géobase (there is also a "destroyed segments" dataset).
- **`SEPARATEUR` is mostly empty** (70% of km), so tiers must use `TYPE_VOIE`, not the separator.
- **The REV is under-flagged.** The REV layer has 21 km (2023), `REV_AVANCEMENT_CODE` tags about 44 km, and the City says 191 km. We'll need our own list of REV axes, or ask the City.
- **Odd `NBR_VOIE` values** (0 and 8) on about 6 km.
- **151 km lie outside the City of Montreal**, in other island municipalities (`VILLE_MTL = Non`).
- **Direction of travel isn't explicit.** One-way lanes follow traffic unless `TYPE_VOIE2` says "à contresens" (contraflow). We'll need the Géobase traffic-direction field.
- **Roadworks impacts use names, not IDs.** The companion "impacts" CSV has `bikepath_blockedtype` (for example "Obstruée"), but it is keyed by street name and from/to cross streets, so matching it to segments needs care.
- **The live closures feed** (`entraves-circulation`, CIFS JSON) returned 404 on 2026-10-25.
- **Encodings differ.** Most files are UTF-8, but the racks CSV is cp1252.

## Not downloaded yet (big ones need Raph's OK)
| Dataset (CKAN id) | Size | Use |
|---|---|---|
| Géobase street network (`geobase`) | 41 MB GeoJSON | Routing graph: streets, IDs, direction |
| Géobase nodes (`geobase-noeud`) | ? | Intersections |
| Address points (`adresses-ponctuelles`) | 134 MB GeoJSON | Address search |
| Buildings 2D 2016 (`batiment-2d`) | 147 MB | Footprints for 3D massing |
| Surface model MNS 2015, 1 m (`modele-numerique-de-surface-mns`) | one file per borough | Building heights (MNS minus MNT) |
| Terrain model MNT 2015 (`modele-numerique-de-terrain-mnt`) | one file per borough (also TIN in CityGML) | Slopes and hills |
| 3D LOD2 buildings 2020 (`batiments-3d-2020-maquette-lod2-avec-textures`) | tiles | Only Ville-Marie, CDN–NDG and Outremont, in Rhino `.3dm` |
| Collisions (`collisions-routieres`) | 363 MB | Safety weighting, later |
| Traffic signals (`feux-tous`) | small | Safer crossings |
| Bike counters (`cyclistes`) | small | Busy corridors |
| Mon RésoVélo trips (`trajets-individuels-velo-enregistre-mon-resovelo`) | 41 MB | Real GPS traces to check our routes against |
| Snow clearing (`deneigement`, Planif-Neige API) | API | Winter mode |
| Parks (`grands-parcs-parcs-d-arrondissements-et-espaces-publics`) | ? | Base map and POIs |
| Public events (`evenements-publics`), car-free events (`cyclovias`) | small | Extras |

## Outside sources
| Source | Licence | Use |
|---|---|---|
| OpenStreetMap (extract or Overpass) | ODbL: attribution, and share-alike on derived databases | Base map, paths off the island, POIs (cafés, bike shops, repair stations, racks, water) |
| Overture Maps places and buildings | places CDLA-Permissive-2.0; buildings ODbL (verify) | Better business coverage; some building heights |
| Protomaps basemap (PMTiles) | ODbL produced work | Self-hosted base tiles |
| NRCan Automatically Extracted Buildings | Open Government Licence – Canada | Building heights (min/max) from LiDAR |
| Can-BICS (2018 and 2023) | verify | Comfort classes, for comparison |
| Environment Canada (MSC Datamart / GeoMet) | Open Government Licence – Canada | Weather and wind, later |
