# Data sources and quirks (checked 2026-10-25, updated 2026-10-29)

## Update 2026-10-29: weather, live BIXI, winter fields, island data and map layers, photos
| Source | What it gives | Freshness | Use |
|---|---|---|---|
| **Open-Meteo forecast**: `api.open-meteo.com/v1/forecast` (no key; open to any website) | One point for central Montréal (45.52, −73.58). Now: temperature, rain, snowfall, wind speed, direction and gusts at 10 m, weather code. Hourly: precipitation and its probability, snowfall, snow depth, temperature, for the last day and the next two | Live; the app refreshes every 10 min | Wind and rain card, wind effect on routes, "Avoid headwinds", winter snow status (snowfall in the last 24 h, freeze–thaw warning). Free for non-commercial use; data CC BY 4.0 (verify before a public launch) |
| **Environment Canada GeoMet radar**: `geo.weather.gc.ca/geomet` (WMS 1.3.0, 256 px tiles) | 1 km radar images: `RADAR_1KM_RRAI` (rain) and `RADAR_1KM_RSNO` (snow) | Live | Radar layer: rain in summer, snow in winter mode. Open Government Licence – Canada; the map credits "Environment and Climate Change Canada" |
| **BIXI GBFS, live status**: `https://gbfs.velobixi.com/gbfs/2-2/en/` (`station_information.json` and `station_status.json`; open to any website) | About 1,100 stations, island-wide: bikes, e-bikes and free docks available, and whether the station is renting | Live; the app refreshes every minute | Badge with the bikes available on each station icon. Listed as CC BY 4.0 on donnees.montreal.ca; check BIXI's own terms before a public launch |
| **City bike network, fields `SAISONS4` and `PROTEGE_4S`** (`mtl_reseau_cyclable`, the file we already have) | `SAISONS4` = "Oui" when a segment is in the 4-season network, cleared in winter (753 of the 1,101 km; see the summary below). `PROTEGE_4S` = "Oui" when a protected bike path keeps its separators in winter | File of 2026-10-01 | Winter tiers in the router; grey dotted "not cleared" bike paths on the map |
| **Planif-Neige** (`deneigement`) | Street snow-removal status. It needs an access token: requested by email to donneesouvertes@montreal.ca on 2026-10-29, no answer yet. Streets only, not bike paths | Live | Not used yet. A token can't ship in a web page, so it would need a small server |
| **OSM bike-legal paths, whole island**: `osm_overpass/bike_allowed_paths_island.json` (11.5 MB; `tools/fetch_data.py island`) | 19,620 ways: cycleways, plus paths, footways, tracks and similar ways where bicycle is yes, designated or permissive, in the island box (−73.985, 45.395, −73.465, 45.715) | Downloaded 2026-10-29 | Island routing graph |
| **NRCan HRDEM CMM 2023, whole island at 5 m**: `nrcan_hrdem_cmm2023/dtm_island_32188_5m.tif` (85 MB, terrain) and `dsm_island_32188_5m.tif` (98 MB, surface; downloaded later the same day) | The 1 m models cut to the island box and averaged to 5 m, EPSG:32188. **The 2023 flight covers only about 61% of the island box** (the east and centre) | 2023 | Merged with the 2024 terrain model below. The study area's 1 m cut is still used for building heights there |
| **NRCan HRDEM CMM 2024, whole island at 5 m**: `nrcan_hrdem_cmm2024/dtm_island_32188_5m.tif` (55 MB) and `dsm_island_32188_5m.tif` (64 MB) | The same product from the 2024 flight of the same programme, cut and averaged exactly like the 2023 one, on the same grid. It covers what 2023 misses (the West Island, the north-west and the South Shore corner). The two agree to 0.02 m where they overlap | 2024; downloaded 2026-10-29 | `tools/island_tiles.py dem` merges both terrain models into `data/build/dtm_island_5m_merged.tif` (2023 wins where both exist). The routing graph, hill shading, tint, contours and terrain tiles all read that file. The surface models give building heights |
| **OpenStreetMap, BBBike Montréal extract**: `osm_bbbike/Montreal.osm.pbf` (85 MB; `tools/island_buildings.py fetch_pbf`) | A cut of the whole OSM file for Montréal, extract of 2026-10-24 | 2026-10-24 | Island building footprints: 562,743 of 12 m² or more, read with GDAL's OSM driver, which also assembles the multipolygon buildings (561 courtyard and university buildings that the old Overpass query silently missed). Used because Overpass kept failing; the Overpass path is still in the script. ODbL |
| **AWS Terrain Tiles (Terrarium)**: `aws_terrarium/` (266 tiles, 9 MB), from `s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` | Worldwide 256 px elevation tiles, the elevation encoded in the colour | Public dataset | Fill the pixels the LiDAR doesn't cover at the edges of our own terrain tiles (266 of our 851 tiles needed it). The app also loads them live as the fallback beyond our tiles. Check the terms (registry.opendata.aws/terrain-tiles) before a public launch |
| **Island places and works**: `osm_overpass/pois_island.json` (5.4 MB), `shops_island.json` (0.8 MB), `bikeways_construction_island.json` (7 KB), and the City's live bike tiles for the island, `mtl_live_tiles_island/` (z14; 15 MB and 3.9 MB) | The same queries and decoding as the study-area downloads, over the island box (`tools/island_tiles.py pois_fetch`, `planned_fetch`) | Downloaded 2026-10-29 | `pois.js` (22,055 places; bike racks study-area only) and `planned.js` (7,809 features: 7,372 planned, 198 under construction, 8 closed, 231 works) |
| **Wikimedia Commons photos** | 10 photos for the classic rides, free licences only: CC BY 2.0, 3.0, 4.0 and CC BY-SA 2.0, 3.0, 4.0. Author, licence and source link per photo in `prototypes/shared/photos/credits.json` | Added 2026-10-29 | Photo banners on the classic ride cards. Each card credits the author and licence |

- **Island graph inputs:** the City Géobase and bike network (island-wide), plus the island OSM paths and the merged 2023 + 2024 terrain model. `tools/fetch_data.py island` fetches the OSM paths and the 2023 terrain model (`all` includes it); `tools/island_tiles.py dem` cuts the 2024 block and merges both; `tools/build_graph.py --extent island` builds the graph. See `05_routing.md`.
- **Island map layers** (relief, tint, contours, buildings, terrain tiles, places, planned/works) are built from the files above by `tools/island_tiles.py` and `tools/island_buildings.py`. See `06_prototypes.md` for what they hold.
- **All new downloads of 2026-10-29** are logged in `data/raw/_download_log.csv` and are not in git (`data/raw/` is ignored).
- **Speed limits and the arterial network** only exist for the City of Montréal, not the other island municipalities.
- **Winter data gap:** there is no public real-time snow-clearing status for bike paths. Winter mode uses `SAISONS4` and the forecast instead. The Planif-Neige token was requested on 2026-10-29 (see the table above); it would only cover streets.
- **Ride choice:** the classic rides are based on public guides (Tourisme Montréal, Time Out Montréal, Parks Canada, Komoot, Altitude Sports), not on a dataset. See `06_prototypes.md`.

## Update 2026-10-25, afternoon: fresher sources found and used
| Source | What it gives | Freshness | Use |
|---|---|---|---|
| **City live bike tiles**: `api.montreal.ca/api/it-platforms/geomatic/vector-tiles/maps/v1/pistes-cyclables/{z}/{x}/{y}.pbf` (behind the City's interactive bike map; open to any website) | Layer `pistes-cyclables`: the current network with **REV axes** (`revAxes`, `revAxeNum*`), surface, width, bridge/tunnel, year built, and **temporary closures** (`avancementCode` FT). Layer `pistes-cyclables-projete`: **planned** (P, GP) and **in development this year** (D) bike routes, with project names and program years | Live (what the City's own map shows) | Tiers, REV, closures for routing. Planned/in-construction layer for browsing only |
| **City address search API**: `api.montreal.ca/api/geographic/location/v1/addresses?q=` (open to any website) | 702,686 official addresses with coordinates and English/French labels | Live | Destination search |
| **NRCan HRDEM**, `QC-600023_52_CMM_2023-1m` (Cloud-Optimized GeoTIFF on AWS), DTM and DSM | 1 m terrain and surface from the **2023** CMM LiDAR. Cut to the study area with GDAL over HTTP: only the needed bytes download, about 300 MB for both | 2023 | Study-area graph elevations; building heights = 70th percentile of (DSM − DTM) inside each footprint (still used inside the old study area; the island-wide layers use the 5 m models above) |
| OpenStreetMap via Overpass | Study area: POIs (9,601), bike-legal paths (1,445), buildings (71,763 footprints), parks, water, rail. Island-wide counts are in the 2026-10-29 update above | Continuous | Footprints (newer than the City's 2016 file), POIs, missing paths |
| STM GTFS (`gtfs_stm.zip`) | Official metro colours (green `#00B300`, orange `#D95700`, yellow `#FFD900`, blue `#0095E6`), 68 stations, line shapes | Weekly | Theme colours, metro POIs, metro view |
| BIXI GBFS | 1,121 stations | Live | POIs; live dock counts built 2026-10-29 (see above) |
| City roadworks (`info-travaux`) + impacts CSV | 94 works **blocking a bike path** in the study area on 2026-10-25 (`bikepath_blockedtype`); 231 island-wide in the 2026-10-29 build | Daily | Yellow cone markers; later, re-route around them |

- **Point clouds:** the City's 2015 LiDAR is 111 GB of LAZ. It isn't needed: NRCan already serves the derived 2023 and 2024 surface and terrain as cloud rasters, and we only pull the window we need. A home NAS shouldn't serve a public app anyway. The app ships small derived files instead: four PMTiles files (hill shading, tint, contours and buildings, 53.8 MB in all, read by range requests), 851 terrain tiles (24.6 MB) and the routing graph.
- **Refreshing data:** `tools/fetch_data.py all --refresh`, then `tools/island_tiles.py dem` (the merged terrain model), `build_graph.py` for each extent, and `tools/island_tiles.py all` and `tools/island_buildings.py all` for the map layers (commands in `CLAUDE.md`). Later this can run on a schedule (GitHub Actions: nightly for roadworks and live tiles, monthly for the rest), with the built files published next to the app.

All Montreal datasets below are CC BY 4.0 (credit "Ville de Montréal"), from donnees.montreal.ca. Each has a CKAN API page at `https://donnees.montreal.ca/api/3/action/package_show?id=<id>`.

## Downloaded (in `data\raw\`; provenance in `_download_log.csv`)
| Folder | Dataset (CKAN id) | Updated | Size | What it gives us |
|---|---|---|---|---|
| `mtl_reseau_cyclable` | Réseau cyclable (`pistes-cyclables`), plus the 2020 data dictionary | 2026-10-01 | 11 MB GeoJSON | The bike network: 9,485 segments, 1,101 km, with type, 4-season flag (`SAISONS4`), winter protection flag (`PROTEGE_4S`), REV, Route verte and Géobase ID |
| `mtl_geobase` | Géobase street network (`geobase`) | see log | 41 MB GeoJSON | The routing graph's streets: IDs, direction, class and names (downloaded 2026-10-25) |
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
- **Direction of travel isn't explicit.** One-way bike paths follow traffic unless `TYPE_VOIE2` says "à contresens" (contraflow). We'll need the Géobase traffic-direction field.
- **Roadworks impacts use names, not IDs.** The companion "impacts" CSV has `bikepath_blockedtype` (for example "Obstruée"), but it is keyed by street name and from/to cross streets, so matching it to segments needs care.
- **The live closures feed** (`entraves-circulation`, CIFS JSON) returned 404 on 2026-10-25.
- **Encodings differ.** Most files are UTF-8, but the racks CSV is cp1252.

## Not downloaded yet (big ones need Raph's OK)
| Dataset (CKAN id) | Size | Use |
|---|---|---|
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
| Snow clearing (`deneigement`, Planif-Neige API) | API | Real-time clearing status. Not used: it needs a token (requested 2026-10-29, no answer yet) and covers streets only (see the 2026-10-29 update) |
| Parks (`grands-parcs-parcs-d-arrondissements-et-espaces-publics`) | ? | Base map and POIs |
| Public events (`evenements-publics`), car-free events (`cyclovias`) | small | Extras |

## Outside sources
| Source | Licence | Use |
|---|---|---|
| OpenStreetMap (extract or Overpass) | ODbL: attribution, and share-alike on derived databases | Base map, paths off the island, POIs (cafés, bike shops, repair stations, racks, water), and since 2026-10-29 the island's building footprints (BBBike extract) |
| Overture Maps places and buildings | places CDLA-Permissive-2.0; buildings ODbL (verify) | Better business coverage; some building heights |
| Protomaps basemap (PMTiles) | ODbL produced work | Self-hosted base tiles. Not used for the basemap yet (it is still OpenFreeMap). Since 2026-10-29 the PMTiles format carries our own layers (relief, tint, contours, buildings), read in the page by the pmtiles library (Protomaps, BSD-3, vendored 4.5.0 in `prototypes/vendor/pmtiles/`) |
| NRCan Automatically Extracted Buildings | Open Government Licence – Canada | Building heights (min/max) from LiDAR |
| Can-BICS (2018 and 2023) | verify | Comfort classes, for comparison |
| Environment Canada (MSC Datamart / GeoMet) | Open Government Licence – Canada | Radar layers (GeoMet) since 2026-10-29. The wind and rain forecast comes from Open-Meteo instead (see above) |
