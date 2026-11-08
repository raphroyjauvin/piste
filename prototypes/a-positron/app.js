/* Piste (prototype A, Positron light): MapLibre GL JS + our in-browser router on the island-wide graph.
   Go somewhere · Suggest a ride (classic rides and custom loops) · GPS ride (and a simulated preview) with hill-ahead 3D ·
   winter mode (4-season network) · wind & rain · live BIXI · English / French. */
(async function () {
  "use strict";
  const C = window.BikeCommon, I = window.BikeI18n, WX = window.BikeWeather, BX = window.BikeBixi;
  const { Router, weightsFor, routeSettings, activeWorks, PROFILES } = window.BikeRouter;
  const $ = (s) => document.querySelector(s);
  const t = (k, v) => I.t(k, v);
  // the REM's stations join the places on the map (same layers, search and ride pop-ups as the metro's); its tracks have their own layers
  if (window.REM) window.POIS = window.POIS.concat(window.REM.stations.map(([name, lon, lat]) => ["rem", name, lon, lat]));
  const params = new URLSearchParams(location.search);
  const tick = () => new Promise((r) => setTimeout(r, 0));

  I.lang = ["en", "fr"].includes(params.get("lang")) ? params.get("lang") : I.initial();
  I.apply();

  // The phone preview passes simulated safe areas (?safe=top,bottom in px), because desktop browsers report 0.
  if (params.get("safe")) {
    const [top, bottom] = params.get("safe").split(",").map((v) => Math.max(0, Number(v) || 0));
    document.documentElement.style.setProperty("--safe-top", `${top}px`);
    document.documentElement.style.setProperty("--safe-bottom", `${bottom || 0}px`);
  }
  let toastT = null;
  function toast(msg) { const el = $("#toast"); el.textContent = msg; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (el.hidden = true), 3600); }

  // ------------------------------------------------------------------ palette (2026-11-07: navy for bike paths, orange where there are none)
  const NAVY = "#1e2160";
  const COL = {
    a: NAVY, b: "#3d43a8", c: "#3d43a8", gap: "#ff6a1f", gapQuiet: "#ffa25e", closed: "#d7263d",
    rev: NAVY, ridden: "#2a9d8f", netA: NAVY, netB: "#3d43a8", netC: "#9296d6", planned: "#d9b400", alt: "#9aa5ae", notCleared: "#aebbc6",
  };
  // the same at night, light enough to read on the ink-navy map
  const COL_NIGHT = { a: "#aab0ff", b: "#8a90e6", c: "#8a90e6", net: "#aab0ff", netB: "#8a90e6", netC: "#6f75c0" };
  const CLIMB = { ink: NAVY, spark: "#a7aad6" };

  // ------------------------------------------------------------------ camera
  const CAM = {
    browse3d: { pitch: 60, bearing: -34, fov: 22 },          // narrow lens = near-axonometric
    bird: { pitch: 70, zoom: 17.35, riderAt: 0.7 },          // ride: low and behind the rider; riderAt = rider height on screen
    top: { pitch: 0, zoom: 16.7, riderAt: 0.62 },
    terrain: 1.6,                                            // terrain exaggeration in 3D
    hill: { boost: 0.9, pitch: 2, zoom: -0.2 },              // added as a climb comes up; 2026-10-29: halved (was 1.8, 3°, -0.3)
  };
  const isPhone = () => matchMedia("(max-width: 760px)").matches;
  // "Let's ride!" rides with GPS on touch devices that have location (phones, tablets); desktops get the preview.
  // ?gps=1 forces GPS, ?gps=replay a pretend GPS ride for tests and screenshots, ?gps=0 the preview.
  const gpsParam = params.get("gps");
  function gpsDefault() {
    if (gpsParam === "0") return false;
    if (gpsParam === "1" || gpsParam === "replay") return true;
    return "geolocation" in navigator && matchMedia("(pointer: coarse)").matches;
  }

  // ------------------------------------------------------------------ router (island-wide graph) + data
  const t0 = performance.now();
  const G = window.GRAPH_ISLAND || window.GRAPH_STUDY;
  const router = new Router(G);
  const geocoder = C.makeGeocoder(router);
  const suggester = new window.BikeSuggest.Suggester(router, window.POIS);
  const SK = window.BikeSuggest.STOP_KINDS;
  const CLASSICS = window.CLASSICS || [];
  console.log(`router ready in ${(performance.now() - t0).toFixed(0)} ms: ${router.n} nodes, ${router.m} edges`);

  const nodeNames = new Map();
  for (let e = 0; e < router.m; e++) {
    const nm = router.names[router.ename[e]]; if (!nm) continue;
    for (const v of [router.ea[e], router.eb[e]]) { let s = nodeNames.get(v); if (!s) nodeNames.set(v, (s = new Set())); s.add(nm); }
  }
  function placeLabel(lon, lat) {
    const s = router.snap(lon, lat); if (!s) return t("droppedPin");
    const v = s.t < 0.5 ? router.ea[s.e] : router.eb[s.e];
    const main = router.names[router.ename[s.e]];
    const cross = [...(nodeNames.get(v) || [])].find((n) => n !== main);
    if (main && cross) return t("nearBy", { a: I.place(main), b: I.place(cross) });
    return main || cross ? I.place(main || cross) : t("droppedPin");
  }

  // Usage counts with Umami Cloud (cookieless), only on the published site (pistemtl.ca). Events carry names and small numbers,
  // never places, addresses or coordinates; page views drop the ?query and #hash (shared links can hold coordinates).
  // ?notrack=1 stops counting this browser (e.g. Raph's own phone), ?notrack=0 counts it again. Tests set umami.disabled too.
  const UMAMI_ID = "6ed89953-c8a1-440d-9214-82a3a2dfa38d";   // shared with raphroyjauvin.ca (the free plan has one website): filter by hostname
  {
    const nt = new URLSearchParams(location.search).get("notrack");
    try { if (nt === "1") localStorage.setItem("umami.disabled", "1"); else if (nt === "0") localStorage.removeItem("umami.disabled"); } catch (e) { /* private */ }
    if (UMAMI_ID && /(^|\.)pistemtl\.ca$/.test(location.hostname)) {
      const s = document.createElement("script");
      s.defer = true; s.src = "https://cloud.umami.is/script.js";
      Object.assign(s.dataset, { websiteId: UMAMI_ID, excludeSearch: "true", excludeHash: "true", doNotTrack: "true" });
      document.head.appendChild(s);
    }
  }
  const touring = () => { try { return !!(window.pisteTour && window.pisteTour.info().open); } catch (e) { return false; } };
  const count = (name, data) => { if (touring() && !/^tour/.test(name)) return; try { if (window.umami) window.umami.track(name, data); } catch (e) { /* blocked or offline */ } };
  let lastTracked = "";   // the last planned route or classic counted, so slider tweaks don't count again (kept in memory only)
  const store = { get(k, d) { try { return localStorage.getItem("piste-" + k) ?? d; } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem("piste-" + k, v); } catch (e) { /* private */ } } };
  const state = { from: null, to: null, fromLabel: "", toLabel: "", routes: [], sel: 0, mode: "explore", is3d: false,
    pick: null, ride: null, rideView: "birdseye", lastMs: 0, terrainOn: false, hillK: 0, snap: false,
    tab: "go", smode: "classics", classic: 0, sugg: { loop: true, km: 10, stop: "" }, avoidWind: false,
    winter: false, wx: false, wxData: null, bixi: null, sound: store.get("sound", "chime"), rideEnd: "",
    follow: true, holding: false, reroutes: 0, rerouteLog: [], rideOpts: null, gpsState: null, wake: "off", summary: null, join: null };

  // ------------------------------------------------------------------ basemap style (OpenFreeMap Positron, our buildings instead of theirs)
  // 2026-11-07: the basemap in the clear-line theme: warm paper ground, white streets with warm edges, cool water, soft labels
  const PAPER = "#f4efe3", HALO = "rgba(255,253,248,0.95)";
  const DAY_PAINT = {
    background: { "background-color": PAPER }, landuse_residential: { "fill-color": "#efe8d8" }, landcover_wood: { "fill-color": "#dbe8df" },
    water: { "fill-color": "#c4d2ea" }, waterway: { "line-color": "#b3c4e2" },
    highway_path: { "line-color": "#ffffff" }, highway_minor: { "line-color": "#ffffff" }, highway_major_inner: { "line-color": "#ffffff" }, highway_major_subtle: { "line-color": "#ffffff" },
    highway_motorway_inner: { "line-color": "#ffffff" }, highway_motorway_subtle: { "line-color": "#ffffff" }, highway_motorway_bridge_inner: { "line-color": "#ffffff" },
    highway_major_casing: { "line-color": "#ddd3bd" }, highway_motorway_casing: { "line-color": "#ddd3bd" }, highway_motorway_bridge_casing: { "line-color": "#ddd3bd" },
    railway: { "line-color": "#bdb39f" }, railway_service: { "line-color": "#bdb39f" }, railway_transit: { "line-color": "#bdb39f" },
    ...Object.fromEntries(["label_other", "label_village", "label_town", "label_state", "label_city", "label_city_capital", "highway-name-path", "highway-name-minor",
      "highway-name-major", "waterway_line_label", "water_name_point_label", "water_name_line_label", "airport"].map((id) => [id, { "text-color": "#5a5d7c", "text-halo-color": HALO }])),
  };
  let style;
  try {
    style = await (await fetch("https://tiles.openfreemap.org/styles/positron")).json();
    // our buildings and our parks (parks.pmtiles) instead of theirs: their "park" layer holds only nature reserves and protected areas, and sat under the tint
    style.layers = style.layers.filter((l) => l.id !== "building" && l.id !== "park");
    // a bike app has no use for provincial route numbers (the "125", "138" shields repeated along every highway): hide them; street names stay
    const isRoadRef = (l) => l.type === "symbol" && (/shield/.test(l.id) || JSON.stringify((l.layout || {})["text-field"] || "").includes('"ref"'));
    for (const l of style.layers) {
      if (isRoadRef(l)) l.layout = { ...l.layout, visibility: "none" };
      const day = DAY_PAINT[l.id]; if (day) l.paint = { ...l.paint, ...day };
    }
  } catch (e) {
    style = { version: 8, glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf", sources: {},
      layers: [{ id: "background", type: "background", paint: { "background-color": PAPER } }] };
    toast(t("offline"));
  }
  // The "i" lists every data source (with About & terms). The basemap adds "OpenFreeMap © OpenMapTiles Data from OpenStreetMap" itself;
  // without it (offline), our own OpenStreetMap layers (places, buildings, paths) still need their credit.
  const basemapCredit = !!style.sources.openmaptiles;
  const map = new maplibregl.Map({
    container: "map", style, center: [-73.585, 45.522], zoom: 12.8, maxPitch: 80,
    attributionControl: { compact: true, customAttribution: "© 2026 Piste Montréal · Ville de Montréal (CC BY 4.0) · NRCan HRDEM 2023 + 2024 · Canopée 2019 · STM · REM (OpenStreetMap) · BIXI · Open-Meteo"
      + (basemapCredit ? "" : " · © OpenStreetMap contributors") },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");
  await new Promise((r) => map.on("load", r));
  // Offline (2026-11-02): sw.js keeps the app and the map you have seen working without a signal. Only on the published site
  // (or with ?sw=1), so the dev server and the tests are never served old files. Registered after the map, to leave the first load alone.
  if ("serviceWorker" in navigator && (/(^|\.)pistemtl\.ca$/.test(location.hostname) || params.get("sw") === "1")) {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("offline mode unavailable", e));
  }

  const styleLayers = map.getStyle().layers;
  const firstSymbol = (styleLayers.find((l) => l.type === "symbol") || {}).id;
  const firstRoad = (styleLayers.find((l) => /^(tunnel|highway|road)/.test(l.id)) || {}).id || firstSymbol;
  const add = (layer, before = firstSymbol) => map.addLayer(layer, before && map.getLayer(before) ? before : undefined);
  // never fade our markers as "behind the terrain"; sub-pixel positions so they glide instead of snapping pixel to pixel
  const MARKER_SHOW = { opacity: "1", opacityWhenCovered: "1", subpixelPositioning: true };
  const attrib = document.querySelector(".maplibregl-ctrl-attrib");
  if (attrib) { attrib.classList.remove("maplibregl-compact-show"); attrib.removeAttribute("open"); }

  // ------------------------------------------------------------------ 3D terrain: our LiDAR tiles over the island, AWS terrain tiles beyond it
  const AWS_DEM = (key) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${key}.png`;
  const LOCAL_DEM = new Set((window.TERRAIN_TILES || {}).tiles || []);
  const DEM_BASE = new URL("../shared/terrain/", location.href).href;
  maplibregl.addProtocol("piste-dem", async (req, ctl) => {
    const key = req.url.slice("piste-dem://".length);
    for (const url of LOCAL_DEM.has(key) ? [DEM_BASE + key + ".png", AWS_DEM(key)] : [AWS_DEM(key)]) {
      try {
        const res = await fetch(url, { signal: ctl.signal });
        if (res.ok) return { data: await res.arrayBuffer() };
      } catch (err) { if (ctl.signal.aborted) throw err; }
    }
    throw new Error(`Terrain tile ${key} unavailable`);
  });
  // island-wide relief, tint, contours and buildings: one PMTiles file each, read tile by tile with HTTP range requests
  const pmt = new pmtiles.Protocol();
  maplibregl.addProtocol("pmtiles", pmt.tile);
  const TILES = (name) => "pmtiles://" + new URL(`../shared/tiles/${name}.pmtiles`, location.href).href;

  // the bike network straight from the routing graph (no separate download): tiers 0-2, with REV and 4-season flags
  function networkGeoJSON() {
    const REV = (G.meta && G.meta.flags && G.meta.flags.REV) || 1, S4 = router.F.S4, feats = [];
    for (let e = 0; e < router.m; e++) {
      const tier = router.etierBase[e]; if (tier > 2) continue;
      const f = router.eflags[e];
      feats.push({ type: "Feature", geometry: { type: "LineString", coordinates: router.edgeCoords(e, true) },
        properties: { t: tier, rev: f & REV ? 1 : 0, s4: f & S4 ? 1 : 0 } });
    }
    return { type: "FeatureCollection", features: feats };
  }

  // ------------------------------------------------------------------ sources
  const empty = { type: "FeatureCollection", features: [] };
  map.addSource("tint", { type: "raster", url: TILES("tint"), tileSize: 256 });
  map.addSource("relief", { type: "raster", url: TILES("relief"), tileSize: 256 });
  map.addSource("contours", { type: "vector", url: TILES("contours") });
  map.addSource("bld", { type: "vector", url: TILES("buildings") });
  map.addSource("trees", { type: "vector", url: TILES("trees") });
  map.addSource("parks", { type: "vector", url: TILES("parks") });
  map.addSource("network", { type: "geojson", data: networkGeoJSON() });
  map.addSource("planned", { type: "geojson", data: window.PLANNED });
  if (window.REM) map.addSource("rem", { type: "geojson", data: { type: "Feature", geometry: { type: "MultiLineString", coordinates: window.REM.lines } } });
  map.addSource("pois", { type: "geojson", data: C.poisGeoJSON(window.POIS) });
  map.addSource("terrain", { type: "raster-dem", tiles: ["piste-dem://{z}/{x}/{y}"], encoding: "terrarium", tileSize: 256, maxzoom: 14 });
  for (const id of ["route", "route-alts", "gaps", "ends", "works-near", "stops", "bixi-live", "ridden"]) map.addSource(id, { type: "geojson", data: empty });

  // ------------------------------------------------------------------ layers (bottom to top)
  // elevation: a soft colour tint over land and parks (not water), then LiDAR hill shading and contours under the streets
  const tintBefore = map.getLayer("waterway") ? "waterway" : firstRoad;
  add({ id: "tint", type: "raster", source: "tint",
    paint: { "raster-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0.75, 15, 0.5, 17, 0.32], "raster-saturation": -0.55, "raster-fade-duration": 0 } }, tintBefore);   // 2026-11-07: quieter, to sit on the paper
  if (map.getLayer("water") && map.getLayer(tintBefore)) map.moveLayer("water", tintBefore);
  // 2026-11-03: parks (tools/island_parks.py: OpenStreetMap parks, nature reserves and public gardens over the whole island, merged into one layer) as a quiet,
  // see-through green over the tint; water, hill shading, contours, buildings, paths and labels all draw over it. Parks keep their icons.
  add({ id: "parks", type: "fill", source: "parks", "source-layer": "parks", minzoom: 11,
    paint: { "fill-color": "#8fcfbd", "fill-opacity": ["interpolate", ["linear"], ["zoom"], 11, 0.35, 14, 0.6] } }, "water");   // 2026-11-07: park teal
  // 2026-10-29: shading halfway between the first prototype (0.75) and the strong version (0.95 → 0.72)
  add({ id: "relief", type: "raster", source: "relief",
    paint: { "raster-opacity": ["interpolate", ["linear"], ["zoom"], 11, 0.5, 15, 0.45, 18, 0.4], "raster-fade-duration": 0 } }, firstRoad);   // 2026-11-07: lighter on the paper
  const CONTOUR = NAVY;   // 2026-11-07: navy ink, faint
  // contours: 1 m detail lines only where the ground rises 2.5-15 %, so climbs show as denser lines (replaces the chevrons)
  add({ id: "contours-detail", type: "line", source: "contours", "source-layer": "contours", minzoom: 14, filter: ["==", ["get", "i"], 2],
    paint: { "line-color": CONTOUR, "line-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0.08, 16, 0.16], "line-width": ["interpolate", ["linear"], ["zoom"], 14, 0.4, 17, 0.7] } }, firstRoad);
  add({ id: "contours-minor", type: "line", source: "contours", "source-layer": "contours", minzoom: 13, filter: ["==", ["get", "i"], 0],
    paint: { "line-color": CONTOUR, "line-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0.1, 15, 0.2], "line-width": ["interpolate", ["linear"], ["zoom"], 13, 0.5, 17, 0.9] } }, firstRoad);
  add({ id: "contours-index", type: "line", source: "contours", "source-layer": "contours", minzoom: 11.5, filter: ["==", ["get", "i"], 1],
    paint: { "line-color": CONTOUR, "line-opacity": ["interpolate", ["linear"], ["zoom"], 11.5, 0.22, 14, 0.34], "line-width": ["interpolate", ["linear"], ["zoom"], 11.5, 0.6, 16, 1.4] } }, firstRoad);
  // 2026-11-07, clear-line buildings: white, a flat shadow offset down and right, and a thin navy outline (2D); white "clay" blocks in 3D
  add({ id: "bld-shadow", type: "fill", source: "bld", "source-layer": "buildings", minzoom: 14,
    paint: { "fill-color": "#e2d6bb", "fill-translate": ["interpolate", ["linear"], ["zoom"], 14, ["literal", [1, 1]], 18, ["literal", [5, 5]]],
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0, 14.6, 1] } });
  add({ id: "bld-flat", type: "fill", source: "bld", "source-layer": "buildings", minzoom: 13,
    paint: { "fill-color": "#ffffff", "fill-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0, 14, 1], "fill-outline-color": "#ffffff" } });
  add({ id: "bld-line", type: "line", source: "bld", "source-layer": "buildings", minzoom: 14,
    paint: { "line-color": NAVY, "line-width": ["interpolate", ["linear"], ["zoom"], 14, 0.15, 16, 0.35, 18, 0.6], "line-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0, 14.8, 0.7] } });
  add({ id: "bld-3d", type: "fill-extrusion", source: "bld", "source-layer": "buildings", minzoom: 14, layout: { visibility: "none" },
    paint: { "fill-extrusion-color": ["interpolate", ["linear"], ["get", "h"], 0, "#fbf9f4", 80, "#f3efe7"],
      "fill-extrusion-height": ["get", "h"], "fill-extrusion-base": 0, "fill-extrusion-opacity": 1, "fill-extrusion-vertical-gradient": true } });
  map.setLight({ anchor: "viewport", color: "#ffffff", intensity: 0.62, position: [1.4, 215, 42] });   // shaded sides on the white blocks
  // 3D trees (tools/island_trees.py: one point per LiDAR tree top, h = height in m, s = seed): flat illustrated trees (see "tree pictures" below),
  // upright to the screen, drawn only in the 3D view from zoom 15.5. Picture: paintTrees(). Size: the picture's tree is 90 px tall at icon-size 1, a metre
  // is 1 / 0.4186 px at zoom 17 (Montréal) and the size doubles every zoom, so 0.0265 x h at zoom 17; the seed adds up to 16% either way.
  const TREE_PX = ["*", ["+", 0.92, ["*", 0.04, ["%", ["get", "s"], 5]]], ["min", 30, ["get", "h"]]];
  add({ id: "trees", type: "symbol", source: "trees", "source-layer": "trees", minzoom: 15.5,
    layout: { visibility: "none", "icon-image": "tree-summer-0", "icon-anchor": "bottom", "icon-pitch-alignment": "viewport", "icon-rotation-alignment": "viewport",
      "icon-allow-overlap": true, "icon-ignore-placement": true, "symbol-z-order": "viewport-y",
      "icon-size": ["interpolate", ["exponential", 2], ["zoom"], 15.5, ["*", 0.0094, TREE_PX], 19, ["*", 0.106, TREE_PX]] },
    paint: { "icon-opacity": ["interpolate", ["linear"], ["zoom"], 15.5, 0, 16.3, 0.85] } });   // 0.85: buildings read through a little
  // 2026-11-03: the trees are drawn with WebGL instead ("tree pictures" below), so buildings hide the ones behind them; the symbol layer above
  // stays as the fallback. The map fetches a source's tiles only for a visible layer: this one loads the tree tiles for WebGL and draws nothing.
  add({ id: "trees-src", type: "circle", source: "trees", "source-layer": "trees", minzoom: 15.5, filter: false, layout: { visibility: "none" } });
  // bike network (winter: 4-season lanes stay green, the rest turns grey and dashed)
  add({ id: "net-casing", type: "line", source: "network", layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 1.6, 16, 6] } });
  add({ id: "net-ab", type: "line", source: "network", filter: ["<=", ["get", "t"], 1], layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ["case", ["==", ["get", "rev"], 1], COL.rev, ["==", ["get", "t"], 0], COL.netA, COL.netB],
      "line-width": ["interpolate", ["linear"], ["zoom"], 12, ["case", ["==", ["get", "rev"], 1], 2, 1], 16, ["case", ["==", ["get", "rev"], 1], 4.4, ["==", ["get", "t"], 0], 3.2, 2.3]],
      "line-opacity": 0.6 } });
  add({ id: "net-c", type: "line", source: "network", filter: ["==", ["get", "t"], 2],
    paint: { "line-color": COL.netC, "line-width": ["interpolate", ["linear"], ["zoom"], 12, 0.8, 16, 2], "line-dasharray": [2, 1.5] } });
  // the REM tracks (rem.js), under the bike network: the REM's green with a darker edge, so it shows on the light map
  if (map.getSource("rem")) {
    const remWidth = (scale) => ["interpolate", ["linear"], ["zoom"], 9, 0.8 * scale, 13, 2.4 * scale, 17, 4.4 * scale];
    add({ id: "rem-casing", type: "line", source: "rem", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#4a6d00", "line-width": remWidth(1.6) } }, "net-casing");
    add({ id: "rem-line", type: "line", source: "rem", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": window.REM.color, "line-width": remWidth(1) } }, "net-casing");
  }
  add({ id: "net-not-cleared", type: "line", source: "network", filter: ["==", ["get", "s4"], 0], layout: { visibility: "none" },
    paint: { "line-color": COL.notCleared, "line-width": ["interpolate", ["linear"], ["zoom"], 12, 0.8, 16, 2.2], "line-dasharray": [1.2, 1.4] } });
  // planned & construction (browse only), closures and works (always, toggle)
  add({ id: "planned", type: "line", source: "planned", filter: ["==", ["get", "status"], "planned"], layout: { visibility: "none" },
    paint: { "line-color": COL.planned, "line-width": ["interpolate", ["linear"], ["zoom"], 12, 1.2, 16, 3], "line-dasharray": [2, 1.6], "line-opacity": 0.9 } });
  add({ id: "construction", type: "line", source: "planned", filter: ["==", ["get", "status"], "construction"], layout: { visibility: "none" },
    paint: { "line-color": "#ffd900", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 2, 16, 5] } });
  add({ id: "construction-tape", type: "line", source: "planned", filter: ["==", ["get", "status"], "construction"], layout: { visibility: "none" },
    paint: { "line-color": "#2a2a2a", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 2, 16, 5], "line-dasharray": [0.5, 1.1] } });
  add({ id: "closed", type: "line", source: "planned", filter: ["==", ["get", "status"], "closed"],
    paint: { "line-color": COL.closed, "line-width": 3, "line-dasharray": [1, 1] } });
  // routes
  add({ id: "route-alts", type: "line", source: "route-alts", layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": COL.alt, "line-width": ["interpolate", ["linear"], ["zoom"], 12, 4, 17, 9], "line-opacity": 0.55 } });
  add({ id: "route-ink", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" },   // a thin navy edge around the white casing
    paint: { "line-color": NAVY, "line-width": ["interpolate", ["linear"], ["zoom"], 12, 8.6, 17, 18.6] } });
  add({ id: "route-casing", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 7, 17, 16] } });
  // a classic ride's lead-in (pieces with lead = 1, see rideRouteData): the same colours, in dots, so the loop itself stands out
  const notLead = ["!=", ["get", "lead"], 1];
  add({ id: "route-solid", type: "line", source: "route", filter: ["all", ["in", ["get", "tier"], ["literal", [0, 1, 4]]], notLead], layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ["match", ["get", "tier"], 0, COL.a, 1, COL.b, COL.gap], "line-width": ["interpolate", ["linear"], ["zoom"], 12, 4, 17, 10] } });
  add({ id: "route-shared", type: "line", source: "route", filter: ["all", ["==", ["get", "tier"], 2], notLead],
    paint: { "line-color": COL.c, "line-width": ["interpolate", ["linear"], ["zoom"], 12, 3.5, 17, 9], "line-dasharray": [1.1, 0.8] } });
  add({ id: "route-quiet", type: "line", source: "route", filter: ["all", ["==", ["get", "tier"], 3], notLead],
    paint: { "line-color": COL.gapQuiet, "line-width": ["interpolate", ["linear"], ["zoom"], 12, 3.5, 17, 9], "line-dasharray": [1, 0.6] } });
  add({ id: "route-lead", type: "line", source: "route", filter: ["==", ["get", "lead"], 1], layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ["match", ["get", "tier"], 0, COL.a, 1, COL.b, 2, COL.c, 3, COL.gapQuiet, COL.gap], "line-width": ["interpolate", ["linear"], ["zoom"], 12, 3.5, 17, 8],
      "line-dasharray": [0, 1.7] } });
  // the path actually ridden (end-of-ride summary): a calm indigo line over the planned route
  add({ id: "ridden-casing", type: "line", source: "ridden", layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 5, 17, 11] } });
  add({ id: "ridden-line", type: "line", source: "ridden", layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": COL.ridden, "line-width": ["interpolate", ["linear"], ["zoom"], 12, 2.5, 17, 6] } });
  // a ring under the stop's or sight's POI icon
  add({ id: "stops", type: "circle", source: "stops",
    paint: { "circle-radius": 7.5, "circle-color": "#ffffff", "circle-opacity": 0.95, "circle-stroke-color": COL.a, "circle-stroke-width": 2.5, "circle-pitch-alignment": "map" } });
  add({ id: "contour-labels", type: "symbol", source: "contours", "source-layer": "contours", minzoom: 13.5, filter: ["==", ["get", "i"], 1],
    layout: { "symbol-placement": "line", "text-field": ["concat", ["to-string", ["get", "e"]], " m"], "text-font": ["Noto Sans Regular"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 13.5, 10, 17, 12], "symbol-spacing": 360, "text-max-angle": 30, "text-padding": 2 },
    paint: { "text-color": "#5a5d7c", "text-halo-color": HALO, "text-halo-width": 1.6 } });

  await C.addMapIcons(map);
  map.addImage("pill", pillImage("#fdf1e6", "#f3c29a"), { pixelRatio: 2, stretchX: [[20, 44]], stretchY: [[16, 24]], content: [14, 6, 50, 34] });
  for (const [lvl, fill] of [["ok", "#1d6a2c"], ["low", "#c26b12"], ["empty", "#8a929a"], ["off", "#5a6168"]]) {
    map.addImage("badge-" + lvl, pillImage(fill, "#ffffff"), { pixelRatio: 2, stretchX: [[20, 44]], stretchY: [[16, 24]], content: [14, 6, 50, 34] });
  }
  const POI_LAYERS = [];
  for (const [kind, k] of Object.entries(C.POI_KINDS)) {
    if (kind === "works") continue;
    const id = "poi-" + kind; POI_LAYERS.push({ id, kind, group: k.group });
    map.addLayer({ id, type: "symbol", source: "pois", minzoom: k.minzoom, filter: ["==", ["get", "k"], kind],
      layout: { "icon-image": ["get", "icon"], "icon-size": ["interpolate", ["linear"], ["zoom"], 13, 0.72, 17, 1], "icon-padding": 1,
        "text-field": ["step", ["zoom"], "", 16.5, ["get", "name"]], "text-font": ["Noto Sans Regular"], "text-size": 11,
        "text-offset": [0, 1.35], "text-anchor": "top", "text-optional": true, "symbol-sort-key": k.group === "transit" ? 0 : kind === "bixi" ? 1 : 5 },
      paint: { "text-color": "#44476a", "text-halo-color": HALO, "text-halo-width": 1.3 } });
  }
  // live BIXI: the station icon, plus a badge with the bikes available (green, orange when 1-2, grey when empty)
  map.addLayer({ id: "bixi-live", type: "symbol", source: "bixi-live", minzoom: 14.6,
    layout: { "icon-image": "poi-bixi", "icon-size": ["interpolate", ["linear"], ["zoom"], 14.6, 0.72, 17, 1], "icon-padding": 1, "symbol-sort-key": 1 } });
  map.addLayer({ id: "bixi-count", type: "symbol", source: "bixi-live", minzoom: 15.4,
    layout: { "icon-image": ["concat", "badge-", ["get", "level"]], "icon-text-fit": "both", "icon-text-fit-padding": [1, 4, 1, 4],
      "text-field": ["to-string", ["get", "bikes"]], "text-font": ["Noto Sans Bold"], "text-size": 10.5, "text-offset": [1.05, -1.1],
      "icon-allow-overlap": true, "text-allow-overlap": true, "icon-ignore-placement": true, "text-ignore-placement": true },   // never hides the station icon
    paint: { "text-color": "#ffffff" } });
  map.addLayer({ id: "works", type: "symbol", source: "planned", filter: ["==", ["get", "status"], "works"], minzoom: 13,
    layout: { "icon-image": "poi-works", "icon-size": ["interpolate", ["linear"], ["zoom"], 13, 0.6, 17, 0.95], "icon-allow-overlap": true } });
  map.addLayer({ id: "works-near", type: "symbol", source: "works-near",
    layout: { "icon-image": "poi-works", "icon-size": ["interpolate", ["linear"], ["zoom"], 13, 0.7, 17, 1], "icon-allow-overlap": true } });
  map.addLayer({ id: "stop-labels", type: "symbol", source: "stops",
    layout: { "text-field": "", "text-font": ["Noto Sans Bold"], "text-size": 12, "text-anchor": "top", "text-offset": [0, 0.9], "text-allow-overlap": true, "text-max-width": 14 },
    paint: { "text-color": NAVY, "text-halo-color": HALO, "text-halo-width": 1.8 } });
  map.addLayer({ id: "ends", type: "circle", source: "ends",
    paint: { "circle-radius": 8, "circle-color": ["match", ["get", "k"], "from", NAVY, "#ffffff"],
      "circle-stroke-color": ["match", ["get", "k"], "from", "#ffffff", NAVY], "circle-stroke-width": 3.5 } });
  function setMapTexts() {   // map labels that carry words: redone when the language or winter mode changes
    map.setLayoutProperty("stop-labels", "text-field", ["case", ["==", ["get", "sight"], 1], ["get", "label"], ["concat", t("stopPrefix"), ["get", "label"]]]);
  }
  setMapTexts();
  buildElevationLegend();

  // ------------------------------------------------------------------ winter mode: icy colours, 4-season network, snow status
  const WINTER_PAINT = [
    ["background", "background-color", "#f3f5f8"], ["parks", "fill-color", "#cfe0e2"], ["water", "fill-color", "#c3d1e6"],
    ["landuse_residential", "fill-color", "#eceff4"], ["landcover_wood", "fill-color", "#e3eaee"], ["waterway", "line-color", "#b3c3dd"],
    ["highway_major_casing", "line-color", "#d3dbe6"], ["highway_motorway_casing", "line-color", "#d3dbe6"],
    ["tint", "raster-hue-rotate", 170], ["tint", "raster-saturation", -0.7],
    ["contour-labels", "text-color", "#5c6a89"], ["bld-shadow", "fill-color", "#dce3ec"],
    ["bld-3d", "fill-extrusion-color", ["interpolate", ["linear"], ["get", "h"], 0, "#fbfcfd", 80, "#eef2f6"]],
  ];
  const summerPaint = {};
  function setWinter(on) {
    if (on && !state.winter) count("winter");
    state.winter = on;
    router.setWinter(on);
    document.body.classList.toggle("winter", on);
    $("#winter-btn").setAttribute("aria-pressed", String(on));
    const wb = $("#wx-btn");   // "wind & snow" in winter mode (the icon swaps in CSS)
    wb.dataset.i18nTitle = on ? "weatherBtnSnow" : "weatherBtn"; wb.title = t(wb.dataset.i18nTitle); wb.setAttribute("aria-label", wb.title);
    paintMap();
    const s4 = ["==", ["get", "s4"], 1];
    map.setFilter("net-ab", on ? ["all", ["<=", ["get", "t"], 1], s4] : ["<=", ["get", "t"], 1]);
    map.setFilter("net-c", on ? ["all", ["==", ["get", "t"], 2], s4] : ["==", ["get", "t"], 2]);
    setMapTexts(); applyLayers();
    wind.set(state.wxData, on);   // what an untyped precipitation is: snow in winter mode
    if (on) loadWeather();   // snow and ice status
    renderWxCard();
    classicsRouted = false;   // the classics re-route on the 4-season network
    recompute(true);
  }

  // ------------------------------------------------------------------ tree pictures (2026-11-02; clear-line, 2026-11-07)
  // Each tree is a small flat picture drawn here as SVG (no image files), in the style of a clear-line drawing: a crown of round lobes in one
  // muted colour with a darker shade on the lower right and a navy outline, on an outlined trunk; winter trees are leafless, their branches
  // drawn as navy lines with snow along the top (Montréal's street trees are maples, elms and ashes: no evergreens). Rasterised once at 2x.
  // The picture is 72 x 96 with the tree's foot at (36, 90): the layer anchors the picture's bottom at the tree, upright to the screen.
  const TREE_SET = {   // muted on purpose (about halfway to grey) so the trees sit back under the route colours
    summer: [{ base: "#77aa9f", dark: "#4f8379", light: "#adcfc5" }, { base: "#699b8f", dark: "#447168", light: "#a0c3b9" }, { base: "#85b5a2", dark: "#568977", light: "#b7d6c7" }],
    fall: [{ base: "#ddb251", dark: "#b78b46", light: "#ecd49c" }, { base: "#cc7a51", dark: "#9e583a", light: "#e0ae8f" }, { base: "#a8354b", dark: "#7d2738", light: "#d38492" },
      { base: "#cbab6f", dark: "#94784a", light: "#e5d0a8" }],
    winter: [{ spread: [[-0.62, 0.04, 0.66], [-0.52, 0.56]], len: 22 }, { spread: [[-0.38, 0.02, 0.4], [-0.34, 0.36]], len: 26 }],   // a wide maple, an upright elm
  };
  function treeSeason(date = new Date()) {
    const md = (date.getMonth() + 1) * 100 + date.getDate();
    return state.winter ? "winter" : md >= 920 && md <= 1115 ? "fall" : "summer";
  }
  function treeSVG(kind, i, night) {
    const p = TREE_SET[kind][i], ink = night ? "#070a14" : NAVY, branch = night ? "#8c93c9" : NAVY, snow = night ? "#d5d9ea" : "#ffffff";
    const dim = (c, k = 0.55) => (night ? "#" + [1, 3, 5].map((j) => Math.round(parseInt(c.slice(j, j + 2), 16) * (1 - k) + [14, 22, 40][(j - 1) / 2] * k).toString(16).padStart(2, "0")).join("") : c);
    let seed = 40 * Object.keys(TREE_SET).indexOf(kind) + 7 * i + 11;
    const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const f = (n) => n.toFixed(1);
    const line = (d, w, c = ink) => `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
    const out = [`<ellipse cx="36" cy="89.6" rx="19" ry="3.2" fill="${ink}" opacity="${night ? 0.4 : 0.12}"/>`];   // a flat shadow on the ground
    if (p.spread) {   // leafless: forks that fork again, thinner and shorter each time; snow on the top of the slanted ones
      const snowy = [];
      const grow = (x, y, a, len, w, depth) => {
        const x2 = x + Math.sin(a) * len, y2 = y - Math.cos(a) * len, d = `M${f(x)} ${f(y)}Q${f((x + x2) / 2 + (rnd() - 0.5) * len * 0.3)} ${f((y + y2) / 2)} ${f(x2)} ${f(y2)}`;
        out.push(line(d, w, branch));
        if (depth >= 2 && Math.abs(Math.sin(a)) > 0.25) snowy.push(`<path d="${d}" transform="translate(0 ${f(-w * 0.55)})" fill="none" stroke="${snow}" stroke-width="${f(w * 0.6)}" stroke-linecap="round"/>`);
        if (depth) for (const da of depth > 2 ? p.spread[0] : p.spread[1]) grow(x2, y2, a + da + (rnd() - 0.5) * 0.3, len * (0.68 + rnd() * 0.1), Math.max(w * 0.62, 0.9), depth - 1);
      };
      grow(36, 90, 0, p.len, 3.6, 4);
      out.push(...snowy);
    } else {          // one crown of round lobes: every lobe stroked in navy, then filled over, so only the outer edge shows
      const [rx, ry, cx, cy] = [[26, 24, 36, 37], [19, 30, 36, 35], [29, 21, 36, 40], [24, 26, 36, 37]][i % 4];
      const wood = dim("#7a7c99"), forks = [["M36 90L36 61", 4], ["M36 71L27 53", 2.4], ["M36 68L46 51", 2.4], ["M36 63L37 47", 2]];
      out.push(...forks.map(([d, w]) => line(d, w + 2.2)), ...forks.map(([d, w]) => line(d, w, wood)));
      const lobes = [[cx, cy, Math.min(rx, ry) * 0.75]], n = 7 + (i % 3);
      for (let k = 0; k < n; k++) { const a = (k + rnd() * 0.5) * 2 * Math.PI / n; lobes.push([cx + Math.cos(a) * rx * 0.62, cy + Math.sin(a) * ry * 0.62, Math.min(rx, ry) * (0.36 + rnd() * 0.1)]); }
      const circles = (dx, dy, fill, extra = "") => lobes.map(([x, y, r]) => `<circle cx="${f(x + dx)}" cy="${f(y + dy)}" r="${f(r)}" fill="${fill}"${extra}/>`).join("");
      out.push(`<defs><clipPath id="c">${circles(0, 0, "#000")}</clipPath></defs>`, circles(0, 0, ink, ` stroke="${ink}" stroke-width="2.6"`), circles(0, 0, dim(p.dark)),
        `<g clip-path="url(#c)">${circles(-2.4, -2.8, dim(p.base))}<circle cx="${f(cx - rx * 0.4)}" cy="${f(cy - ry * 0.45)}" r="${f(Math.min(rx, ry) * 0.32)}" fill="${dim(p.light)}"/></g>`,
        line(`M${f(cx + rx * 0.62)} ${f(cy - ry * 0.05)}Q${f(cx + rx * 0.5)} ${f(cy + ry * 0.55)} ${f(cx + rx * 0.05)} ${f(cy + ry * 0.66)}`, 1.1));   // one shading stroke
      if (kind === "fall") for (let k = 0; k < 2; k++) { const x = 18 + rnd() * 36, y = 72 + rnd() * 14; out.push(`<ellipse cx="${f(x)}" cy="${f(y)}" rx="2.6" ry="1.4" transform="rotate(${f(rnd() * 80 - 40)} ${f(x)} ${f(y)})" fill="${dim(p.base)}" stroke="${ink}" stroke-width="0.7"/>`); }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="192" viewBox="0 0 72 96">${out.join("")}</svg>`;
  }
  // Picture by season and night: summer (3), fall (20 Sep to 15 Nov, by date; 4) or winter mode (bare, 2); the tree's seed picks one of them.
  const treePics = {};
  await Promise.all(Object.entries(TREE_SET).flatMap(([kind, set]) => set.flatMap((_, i) => [false, true].map(async (night) => {
    const name = `tree-${kind}-${i}${night ? "-n" : ""}`;
    treePics[name] = await C.svgToImage(treeSVG(kind, i, night));
    map.addImage(name, treePics[name], { pixelRatio: 2 });
  }))));
  // The same pictures drawn with WebGL (shared/trees3d.js, 2026-11-03): upright in 3D, sized in metres, hidden by the buildings and hills in
  // front of them, at 0.85 opacity. One texture holds them all: a column per picture (summer, fall, winter), a day row and a night row.
  // If WebGL can't draw them (no instancing, a shader error, the graphics context lost), the symbol layer "trees" takes over.
  const TREE_COLS = {};
  Object.entries(TREE_SET).reduce((col, [kind, set]) => { TREE_COLS[kind] = [col, set.length]; return col + set.length; }, 0);
  const treeImages = ["", "-n"].map((n) => Object.entries(TREE_SET).flatMap(([kind, set]) => set.map((_, i) => treePics[`tree-${kind}-${i}${n}`])));
  state.treesGL = !!window.BikeTrees3D;
  const treeLayer = state.treesGL ? BikeTrees3D.create(map, { id: "trees-gl", source: "trees", sourceLayer: "trees", images: treeImages, demZoom: 14, opacity: 0.85, onFail: treesFallback }) : null;
  // 3D building edges (shared/edges3d.js, 2026-11-07): thin ink lines on the roofs, bases and corners of the 3D buildings; navy by day, light periwinkle at night.
  // If WebGL can't draw them the layer stops quietly (one console warning) and the buildings simply have no lines.
  const EDGE_COLORS = { day: [30, 33, 96, 0.92], night: [170, 176, 230, 0.55] };
  const edgeLayer = window.BikeEdges3D ? BikeEdges3D.create(map, { id: "edges-gl", layerId: "bld-3d", minzoom: 15, color: EDGE_COLORS.day }) : null;
  function treesFallback(reason) {
    if (!state.treesGL) return;
    console.warn(`3D trees: WebGL drawing stopped (${reason}); showing the flat tree pictures instead`);
    state.treesGL = false;
    if (!map.style) return;   // the graphics context is lost: the map is rebuilt when it comes back (below)
    if (map.getLayer("trees-gl")) map.removeLayer("trees-gl");
    applyLayers();
  }
  // A lost graphics context (a phone taking its graphics memory back) drops the map's WebGL layers, ours included. When the context comes
  // back the map reloads its style as it was at that moment, so the layers are set again once it has: the flat tree pictures from then on.
  // (Not on "webglcontextrestored": MapLibre 5.24 can throw before firing it.)
  map.on("webglcontextlost", () => { treesFallback("WebGL context lost"); map.once("style.load", applyLayers); });
  function paintTrees(date) {
    const kind = treeSeason(date);
    map.setLayoutProperty("trees", "icon-image", ["concat", `tree-${kind}-`, ["%", ["get", "s"], TREE_SET[kind].length], state.night ? "-n" : ""]);
    if (treeLayer) treeLayer.setPictures(TREE_COLS[kind], state.night);
  }

  // ------------------------------------------------------------------ night map (2026-11-02)
  // Ink-navy land, dark teal water, warm taupe streets, soft amber labels: deliberately not the usual grey-blue dark map.
  // Only the basemap, our buildings, the terrain shading and the map's own text change; the bike paths, routes, warnings, works
  // and place icons keep their colours (AA or better on this ground). Night wins over winter's colours where both have one.
  const NIGHT = { land: "#0f1626", water: "#0a3a41", halo: "rgba(15,22,38,0.92)", text: "#d6ab6b", street: "#c29b5e", road: "#5d4e3a", motorway: "#74603f", casing: "#17130f" };
  const NIGHT_PAINT = [
    ["background", "background-color", NIGHT.land], ["landuse_residential", "fill-color", "#131b2d"], ["parks", "fill-color", "#2f7a55"],
    ["landcover_wood", "fill-color", "#10221e"], ["water", "fill-color", NIGHT.water], ["waterway", "line-color", "#11505a"],
    ["aeroway-area", "fill-color", "#1a2238"], ["aeroway-runway", "line-color", "#2a3350"], ["aeroway-taxiway", "line-color", "#2a3350"],
    ["road_area_pier", "fill-color", NIGHT.land], ["road_pier", "line-color", NIGHT.land],
    ["highway_path", "line-color", "#2f2c29"], ["highway_minor", "line-color", "#3a352e"],
    ["highway_major_casing", "line-color", NIGHT.casing], ["highway_major_inner", "line-color", NIGHT.road], ["highway_major_subtle", "line-color", "rgba(93,78,58,0.6)"],
    ["highway_motorway_casing", "line-color", NIGHT.casing], ["highway_motorway_inner", "line-color", NIGHT.motorway], ["highway_motorway_subtle", "line-color", "rgba(125,102,72,0.55)"],
    ["highway_motorway_bridge_casing", "line-color", NIGHT.casing], ["highway_motorway_bridge_inner", "line-color", NIGHT.motorway],
    ["tunnel_motorway_casing", "line-color", "#1d1a18"], ["tunnel_motorway_inner", "line-color", "#2a2724"],
    ["railway", "line-color", "#2c3243"], ["railway_service", "line-color", "#2c3243"], ["railway_transit", "line-color", "#2c3243"],
    ["railway_dashline", "line-color", NIGHT.land], ["railway_service_dashline", "line-color", NIGHT.land], ["railway_transit_dashline", "line-color", NIGHT.land],
    ["boundary_2", "line-color", "#33405f"], ["boundary_3", "line-color", "#33405f"],
    ...["waterway_line_label", "water_name_point_label", "water_name_line_label"].flatMap((id) => [[id, "text-color", "#78b4b0"], [id, "text-halo-color", NIGHT.halo]]),
    ...["highway-name-path", "highway-name-minor", "highway-name-major", "airport"].flatMap((id) => [[id, "text-color", NIGHT.street], [id, "text-halo-color", NIGHT.halo]]),
    ...["label_other", "label_village", "label_town", "label_state", "label_city", "label_city_capital"].flatMap((id) => [[id, "text-color", NIGHT.text], [id, "text-halo-color", NIGHT.halo]]),
    ["bld-flat", "fill-color", "#1b2540"], ["bld-flat", "fill-outline-color", "#1b2540"], ["bld-line", "line-color", "#3a4670"], ["bld-shadow", "fill-color", "#0a0f1c"],
    ["bld-3d", "fill-extrusion-color", ["interpolate", ["linear"], ["get", "h"], 0, "#222c4a", 25, "#2b3659", 90, "#374470"]], ["bld-3d", "fill-extrusion-opacity", 0.9],
    ["tint", "raster-brightness-max", 0.32], ["tint", "raster-saturation", -0.6], ["relief", "raster-brightness-max", 0.38],
    ["contours-detail", "line-color", "#6f5c3f"], ["contours-minor", "line-color", "#6f5c3f"], ["contours-index", "line-color", "#8a7350"],
    ["contour-labels", "text-color", "#a88a5a"], ["contour-labels", "text-halo-color", NIGHT.halo],
    ["net-casing", "line-color", NIGHT.land],   // the white edge that lifts the paths off a light map would glare here
    // 2026-11-07: navy paths and routes would vanish on the ink-navy ground: periwinkle at night (orange stays orange)
    ["net-ab", "line-color", ["case", ["==", ["get", "t"], 0], COL_NIGHT.net, ["==", ["get", "rev"], 1], COL_NIGHT.net, COL_NIGHT.netB]], ["net-c", "line-color", COL_NIGHT.netC],
    ["route-ink", "line-color", NIGHT.land], ["route-solid", "line-color", ["match", ["get", "tier"], 0, COL_NIGHT.a, 1, COL_NIGHT.b, COL.gap]],
    ["route-shared", "line-color", COL_NIGHT.c], ["route-lead", "line-color", ["match", ["get", "tier"], 0, COL_NIGHT.a, 1, COL_NIGHT.b, 2, COL_NIGHT.c, 3, COL.gapQuiet, COL.gap]],
    ["ends", "circle-color", ["match", ["get", "k"], "from", COL_NIGHT.a, "#ffffff"]], ["ends", "circle-stroke-color", ["match", ["get", "k"], "from", "#ffffff", COL_NIGHT.a]],
    ["stops", "circle-stroke-color", COL_NIGHT.a], ["stop-labels", "text-color", "#d6d9ff"], ["stop-labels", "text-halo-color", NIGHT.halo],
    ...POI_LAYERS.flatMap((p) => [[p.id, "text-color", "#c9b28a"], [p.id, "text-halo-color", NIGHT.halo]]),
  ];
  // Summer, winter and night colours in one place: night wins, then winter, then the style's own colour (kept the first time we change it).
  function paintMap() {
    const want = new Map();
    for (const [id, prop, val] of state.winter ? WINTER_PAINT : []) want.set(id + "|" + prop, val);
    for (const [id, prop, val] of state.night ? NIGHT_PAINT : []) want.set(id + "|" + prop, val);
    for (const [id, prop] of [...WINTER_PAINT, ...NIGHT_PAINT]) {
      if (!map.getLayer(id)) continue;
      const key = id + "|" + prop;
      if (!(key in summerPaint)) summerPaint[key] = map.getPaintProperty(id, prop);
      map.setPaintProperty(id, prop, want.has(key) ? want.get(key) : summerPaint[key] ?? null);
    }
    // the haze the 3D city fades into at the horizon: paper by day, cool white in winter, ink at night
    const sky = state.night ? "#0f1626" : state.winter ? "#f3f5f8" : "#f4efe3";
    map.setSky({ "sky-color": sky, "horizon-color": sky, "fog-color": sky, "sky-horizon-blend": 0.7, "horizon-fog-blend": 0.9, "fog-ground-blend": 0.35, "atmosphere-blend": 0 });
    paintTrees();
    if (edgeLayer) edgeLayer.setColor(EDGE_COLORS[state.night ? "night" : "day"]);
  }
  // "Night map" in the Layers panel: Auto (between sunset and sunrise in Montréal, worked out here), On or Off; kept in localStorage "piste-night"
  const nightPref = () => (["auto", "on", "off"].includes(store.get("night", "auto")) ? store.get("night", "auto") : "auto");
  function applyNight() {
    const pref = nightPref(), on = pref === "on" || (pref === "auto" && C.isNight(new Date()));
    if (on === !!state.night) return;
    state.night = on;
    document.body.classList.toggle("night", on);
    paintMap();
  }
  document.querySelectorAll("input[name=night]").forEach((r) => {
    r.checked = r.value === nightPref();
    r.addEventListener("change", () => { store.set("night", r.value); applyNight(); });
  });
  paintTrees(); applyNight();
  setInterval(applyNight, 60000);   // Auto: the sun sets while the app is open

  // ------------------------------------------------------------------ wind & rain
  const wind = new WX.WindLayer(map, $("#wind"));
  const precip = new WX.PrecipLayer(map, $("#precip"));   // rain lines or snow flakes (2026-11-03): they replace the wind streaks while it falls now
  wind.follow(precip);
  let wxTimer = null;
  const WX_DEMO = WX.demo(params);   // ?wx=rain|snow: pretend weather, to check the rain and snow on a phone (see weather.js demo)
  async function loadWeather(force) {
    try {
      state.wxData = WX_DEMO || await WX.load(force);
      wind.set(state.wxData, state.winter);
    } catch (e) { state.wxData = null; wind.set(null); console.warn(e); }
    renderWxCard(); if (state.routes.length) renderRoutes();
    if (state.mode === "ride") updateWindBadge(true);   // new weather mid-ride
    return state.wxData;
  }
  function setWeather(on) {
    if (on && !state.wx) count("weather");
    state.wx = on;
    $("#wx-btn").setAttribute("aria-pressed", String(on));
    applyLayers();
    wind.show(on && state.mode !== "ride");
    clearInterval(wxTimer);
    if (on) { loadWeather(); wxTimer = setInterval(() => loadWeather(true), 10 * 60e3); }
    renderWxCard(); if (state.routes.length) renderRoutes();
  }
  function windLine(r) {
    const wx = state.wxData; if (!wx) return "";
    if (wx.now.wind < 6) return t("windNone");
    const w = WX.windOnRoute(r, wx);
    if (w.minutes > 0.5 && w.headShare >= 0.3) return t("windHead", { p: I.pct(w.headShare), min: Math.max(1, Math.round(w.minutes)) });
    if (w.minutes < -0.5 && w.tailShare >= 0.3) return t("windTail", { p: I.pct(w.tailShare), min: Math.max(1, Math.round(-w.minutes)) });
    return t("windCross");
  }
  // "avoid headwinds" (Suggest a ride only): per-edge slow-down riding into today's wind, cached until the wind changes
  let windArr = {}, windKey = "";
  function windWeights() {
    const wx = state.wxData; if (state.tab !== "suggest" || !state.avoidWind || !wx || wx.now.wind < 6) return {};
    const key = `${wx.now.dir}|${wx.now.wind}`;
    if (key !== windKey) { windArr = router.windCost((wx.now.dir + 180) % 360, (wx.now.wind / 3.6) * 0.6, WX.speedWith); windKey = key; }
    return windArr;
  }
  // The card's rain row, or the snow row: what is falling now decides, and with nothing falling winter mode asks for the snow outlook
  function precipRow(wx) {
    const wet = WX.precipNow(wx, state.winter);
    if (wet ? wet.kind === "snow" : state.winter) {
      const s = WX.snowOutlook(wx, state.winter);
      const txt = s.now ? t("snowNow", { cm: I.num(s.cm) }) : s.at ? t("snowAt", { h: s.at, p: s.prob != null ? I.pct(s.prob / 100) : "" }).replace(" ()", "") : t("noSnowFor", { n: s.dryHours });
      return `<div class="wx-row"><svg class="wx-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"/></svg><span>${txt}</span></div>`;
    }
    const rain = WX.rainOutlook(wx);
    const txt = rain.now ? t("rainNow", { mm: I.num(rain.mm) }) : rain.at ? t("rainAt", { h: rain.at, p: rain.prob != null ? I.pct(rain.prob / 100) : "" }) : t("dryFor", { n: rain.dryHours });
    return `<div class="wx-row"><svg class="wx-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3c3.5 5 6 8.2 6 11a6 6 0 0 1-12 0c0-2.8 2.5-6 6-11z"/></svg><span>${txt}</span></div>`;
  }
  function renderWxCard() {
    const card = $("#wx-card");
    if ((!state.wx && !state.winter) || state.mode === "ride" || state.summary) { card.hidden = true; return; }
    const wx = state.wxData, rows = [];
    if (wx && wx.demo) rows.push(`<div class="wx-row wx-note">${t("wxDemo")}</div>`);
    if (!wx) rows.push(`<div class="wx-row">${t(state.wx ? "wxLoading" : "winterOn")}</div>`);
    if (state.wx && wx) {
      const dirKey = I.compassKey(wx.now.dir), to = (wx.now.dir + 180) % 360;
      const windTxt = wx.now.wind < 3 ? t("calm") : t("windFrom", { dir: t("from_" + dirKey), v: Math.round(wx.now.wind) }) + (wx.now.gust > wx.now.wind + 8 ? ` · ${t("gusts", { v: Math.round(wx.now.gust) })}` : "");
      rows.push(`<div class="wx-row"><svg class="wx-arrow" viewBox="0 0 24 24" style="transform:rotate(${to - map.getBearing()}deg)" aria-hidden="true"><path d="M12 21V5M6 11l6-6 6 6"/></svg><span>${windTxt}</span></div>`);
      rows.push(precipRow(wx));
      const sel = state.routes[state.sel];
      if (sel) rows.push(`<div class="wx-row wx-route"><span>${windLine(sel.r)}</span></div>`);
    }
    if (state.winter) {
      rows.push(`<div class="wx-row wx-winter"><svg class="wx-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"/></svg><span>${t("winterOn")}</span></div>`);
      if (wx) {
        rows.push(`<div class="wx-row wx-winter"><span>${wx.snow24 >= 0.5 ? t("snow24", { cm: I.num(wx.snow24, 0), t: I.num(wx.now.temp, 0) }) : t("noSnow", { t: I.num(wx.now.temp, 0) })}</span></div>`);
        if (wx.icy) rows.push(`<div class="wx-row wx-winter"><span>${t("icy")}</span></div>`);
      }
      rows.push(`<div class="wx-row wx-note">${t("noClearing")}</div>`);
    }
    card.innerHTML = rows.join(""); card.hidden = false;
  }
  map.on("rotate", () => { const a = $("#wx-card .wx-arrow"); if (a && state.wxData) a.style.transform = `rotate(${(state.wxData.now.dir + 180) % 360 - map.getBearing()}deg)`; });

  // ------------------------------------------------------------------ live BIXI
  async function loadBixi() {
    if (document.hidden) return;
    try {
      state.bixi = await BX.load();
      map.getSource("bixi-live").setData(state.bixi);
      applyLayers();
    } catch (e) { console.warn("BIXI live unavailable", e); }
  }
  loadBixi(); setInterval(loadBixi, 60e3);
  function bixiByName(name) { return state.bixi && state.bixi.features.find((f) => f.properties.name === name); }
  function bixiText(p) {
    if (!p.renting) return t("bixiClosed");
    const parts = [t("bixiBikes", { n: p.bikes })];
    if (p.ebikes) parts[0] += ` (${t("bixiEbikes", { n: p.ebikes })})`;
    parts.push(t("bixiDocks", { n: p.docks }));
    return parts.join(" · ");
  }

  // ------------------------------------------------------------------ UI: prefs
  const strict = $("#strict"), strictOut = $("#strict-out"), hills = $("#hills"), avoidWorks = $("#avoid-works");
  avoidWorks.checked = store.get("avoid-works", "0") === "1";   // off unless the rider turned it on
  avoidWorks.addEventListener("change", () => { store.set("avoid-works", avoidWorks.checked ? "1" : "0"); recompute(false); });
  // "Avoid construction": ×6 on the edges within 25 m of today's work sites (router.worksPenalty), built once on first use
  let worksPen = null;
  function worksWeights() {
    if (!avoidWorks.checked) return {};
    worksPen ??= router.worksPenalty(activeWorks(window.PLANNED.features, new Date().toLocaleDateString("en-CA")));
    return { worksPen };
  }
  // Go somewhere follows the route-style slider; made-to-order rides (Suggest a ride) always take the most bike paths (2026-11-03)
  const strictness = () => (state.tab === "suggest" ? 1 : +strict.value / 100);
  function strictLabel(v) { return t(v < 20 ? "mostDirect" : v < 45 ? "mostlyDirect" : v < 70 ? "balanced" : v < 92 ? "lanesFirst" : "lanesAlways"); }
  strict.addEventListener("input", () => { strictOut.textContent = strictLabel(+strict.value); recompute(false); });
  hills.addEventListener("change", () => recompute(false));
  strictOut.textContent = strictLabel(+strict.value);

  // ------------------------------------------------------------------ UI: tabs, suggest modes, form
  function refreshSections() {
    const go = state.tab === "go", custom = state.tab === "suggest" && state.smode === "custom", classics = state.tab === "suggest" && state.smode === "classics";
    for (const [id, tb] of [["#tab-go", "go"], ["#tab-suggest", "suggest"]]) { $(id).classList.toggle("on", state.tab === tb); $(id).setAttribute("aria-selected", String(state.tab === tb)); }
    document.querySelectorAll(".go-only").forEach((el) => (el.hidden = !go));
    document.querySelectorAll(".suggest-only").forEach((el) => (el.hidden = go));
    document.querySelectorAll(".custom-only").forEach((el) => (el.hidden = !custom));
    document.querySelectorAll(".classics-only").forEach((el) => (el.hidden = !classics));
    document.querySelectorAll(".go-or-custom").forEach((el) => (el.hidden = classics));
    if (markers.to) markers.to.getElement().style.display = go ? "" : "none";
    if (markers.from) markers.from.getElement().style.display = classics ? "none" : "";
  }
  function setTab(tab) { state.tab = tab; refreshSections(); recompute(true); }
  function setSuggMode(m) { state.smode = m; document.querySelector(`input[name="smode"][value="${m}"]`).checked = true; refreshSections(); recompute(true); }
  $("#tab-go").onclick = () => setTab("go");
  $("#tab-suggest").onclick = () => setTab("suggest");
  document.querySelectorAll('input[name="smode"]').forEach((r) => r.addEventListener("change", () => setSuggMode(document.querySelector('input[name="smode"]:checked').value)));

  const chipsBox = $("#stop-chips");
  function renderStopChips() {
    chipsBox.innerHTML = [["", t("none")], ...Object.keys(SK).map((k) => [k, t("stop_" + k)])].map(([k, label]) => {
      const icon = k ? `<img alt="" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(C.iconSVG(SK[k].kinds[0], { size: 36 }))}">` : "";
      const on = k === state.sugg.stop;
      return `<button type="button" role="radio" class="stop-chip${on ? " on" : ""}" aria-checked="${on}" data-stop="${k}">${icon}${C.esc(label)}</button>`;
    }).join("");
    chipsBox.querySelectorAll(".stop-chip").forEach((b) => b.addEventListener("click", () => { state.sugg.stop = b.dataset.stop; renderStopChips(); recompute(true); }));
  }
  renderStopChips();
  document.querySelectorAll('input[name="shape"]').forEach((r) => r.addEventListener("change", () => {
    state.sugg.loop = document.querySelector('input[name="shape"]:checked').value === "loop"; recompute(true);
  }));
  const km = $("#km"), kmNum = $("#km-num"), kmTime = $("#km-time");
  const kmLabel = () => { kmTime.textContent = t("aboutMin", { t: I.duration((state.sugg.km / 16) * 60) }); };
  function setKm(v, run) {
    const n = Math.max(1, Math.min(100, Math.round(+v || 1)));
    state.sugg.km = n; km.value = n; if (document.activeElement !== kmNum || run) kmNum.value = n; kmLabel();
    if (run) recompute(true);
  }
  km.addEventListener("input", () => setKm(km.value, false));
  km.addEventListener("change", () => setKm(km.value, true));
  kmNum.addEventListener("change", () => setKm(kmNum.value, true));
  kmNum.addEventListener("keydown", (e) => { if (e.key === "Enter") { setKm(kmNum.value, true); kmNum.blur(); } });
  kmLabel();
  // "avoid headwinds" lives in the Suggest a ride form
  $("#avoid-wind").addEventListener("change", async (e) => {
    state.avoidWind = e.target.checked;
    if (state.avoidWind && !state.wxData) await loadWeather();
    recompute(true);
  });

  // ------------------------------------------------------------------ UI: search
  const fromEl = $("#from"), toEl = $("#to"), sug = $("#suggest"), sugHome = sug.parentElement;
  let sugItems = [], sugGeo = [], sugText = "", sugOffline = false, sugActive = -1, sugTarget = null, sugTimer = null;   // sugItems: what the pop-up lists; sugGeo: the address results in it
  const syncFieldLabels = () => { for (const el of [fromEl, toEl]) el.setAttribute("aria-label", el.placeholder); };   // the placeholder is the only visible name
  syncFieldLabels();
  for (const el of [fromEl, toEl]) {
    el.addEventListener("input", () => {
      if (!el.value.trim() && state[el.id]) { clearPoint(el.id); recompute(true); }   // all the text deleted: that place, and the route, go
      sugTarget = el.id; clearTimeout(sugTimer); closeList(false);
      sugTimer = setTimeout(async () => {
        const text = el.value;
        if (recentMatches(text).length || savedMatches(text).length) showSuggest(text, []);   // saved and recent places first, without waiting for the address service
        showSuggest(text, text.trim() ? await geocoder.search(text) : []);
      }, 160);
    });
    el.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" && !sug.hidden) { sugActive = Math.min(sugItems.length - 1, sugActive + 1); renderSuggest(); e.preventDefault(); }
      if (e.key === "ArrowUp" && !sug.hidden) { sugActive = Math.max(0, sugActive - 1); renderSuggest(); e.preventDefault(); }
      if (e.key === "Enter") {   // the keyboard's return key: the highlighted (or top) suggestion, or the place as it is
        e.preventDefault(); sugTarget = el.id;
        if (sugItems.length && !sug.hidden && (sugActive >= 0 || el.value.trim())) choose(sugItems[Math.max(0, sugActive)]);
        else if (el.value === (state[el.id + "Label"] || "")) placeDone(el.id);
      }
      if (e.key === "Escape") { if (search.which) cancelSearch(); else sug.hidden = true; }
    });
    el.addEventListener("blur", () => setTimeout(() => blurred(el), 180));
  }
  // Recent destinations live here only (2026-11-03): those whose name holds the typed text (any case, any accent) come first, tagged "Recent",
  // at most 3, then "Clear recent places", then the address results (leaving out any that are the same place as a recent one).
  const fold = (s) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  const recentMatches = (text) => { const q = fold(text.trim()); return q ? recents.filter((r) => fold(r.name).includes(q)).slice(0, 3) : []; };
  // Saved places in the pop-up (2026-11-04), first of all: Home / Work when the typed text starts one of their words (2 letters or more,
  // English or French, whatever the language shown), then the saved places whose name holds the text. Unset Home / Work don't show.
  const HOME_WORK_WORDS = { home: ["home", "maison", "domicile"], work: ["work", "travail", "bureau"] };
  function savedMatches(text) {
    const q = fold(text.trim()); if (!q) return [];
    const fixed = q.length < 2 ? [] : ["home", "work"].filter((k) => kindIndex(k) >= 0 && HOME_WORK_WORDS[k].some((w) => w.startsWith(q))).map((k) => places[kindIndex(k)]);
    return [...fixed, ...custom().map((x) => x.p).filter((p) => fold(p.name).includes(q))];
  }
  function showSuggest(text, geo) {
    sugText = text; sugGeo = geo; sugOffline = !!geo.offline; sugActive = -1;
    const saved = savedMatches(text).map((p) => ({ label: placeName(p), sub: p.kind ? p.name : "", icon: p.kind || "star", place: p, lon: p.ll[0], lat: p.ll[1] }));
    const recent = recentMatches(text).map((r) => ({ label: r.name, sub: t("recentTag"), lon: r.ll[0], lat: r.ll[1] }));
    const dup = (g) => [...saved, ...recent].some((r) => r.label === g.label || (Math.abs(r.lon - g.lon) < 1e-4 && Math.abs(r.lat - g.lat) < 1e-4));
    sugItems = [...saved, ...recent, ...(recent.length ? [{ label: t("clearRecents"), clear: true }] : []), ...geo.filter((g) => !dup(g))];
    renderSuggest();
  }
  function clearRecents() { recents = []; writeList("recents", recents); showSuggest(sugText, sugGeo); }
  function renderSuggest() {
    if (!sugItems.length && !sugOffline) { sug.hidden = true; return; }
    if (search.which) placeSuggest();
    else { const field = (sugTarget === "from" ? fromEl : toEl).closest(".field"); sug.style.top = field.offsetTop + field.offsetHeight + 4 + "px"; }
    const text = (it) => `<span>${C.esc(it.label)}</span><small>${C.esc(it.sub || "")}</small>`;
    sug.innerHTML = sugItems.map((it, i) => `<li data-i="${i}" class="${i === sugActive ? "active" : ""}${it.clear ? " clear" : ""}${it.icon ? " saved" : ""}">${it.icon ? `${PLACE_ICON[it.icon]}<span class="sg-text">${text(it)}</span>` : text(it)}</li>`).join("")
      + (sugOffline ? `<li class="note">${t("searchOffline")}</li>` : "");   // no signal: the address service is out of reach
    sug.hidden = false;
    sug.querySelectorAll("li[data-i]").forEach((li) => {
      const pick = (e) => { e.preventDefault(); choose(sugItems[+li.dataset.i]); };
      li.addEventListener("pointerdown", (e) => { if (e.pointerType !== "mouse") pick(e); });   // a finger: pick at once, the keyboard stays up
      li.addEventListener("mousedown", pick);
    });
  }
  function choose(it) {
    if (it.clear) { clearRecents(); return; }   // the pop-up stays, minus the recent places
    if (it.place) { usePlace(it.place); return; }   // a saved place: used exactly as in the ★ menu
    sug.hidden = true; sugItems = [];
    const which = sugTarget;
    setPoint(which, [it.lon, it.lat], it.label);
    if (which === "to") remember(it.label, [it.lon, it.lat]);
    placeDone(which);
  }
  // a place was chosen (or kept as it was): the start moves straight on to an empty destination; otherwise the search is over
  function placeDone(which) {
    if (which === "from" && state.tab === "go" && !state.to) {
      sugTarget = "to";
      if (search.which) {
        activate("to");
        if (state.from) map.easeTo({ center: state.from, zoom: Math.max(map.getZoom(), 14.5), duration: 500,
          padding: { top: 40, left: 20, right: 20, bottom: Math.round(panel.getBoundingClientRect().height) + 20 } });
      }
      toEl.focus();
      return;
    }
    if (search.which) leaveSearch("half");
    recompute(true);
  }

  // The small buttons inside the search bars. A press must not take the focus off the bar being typed in (the keyboard would drop and the
  // typed text be taken as a choice), so a mouse or a finger acts on press; a keyboard (or script) click, which has detail 0, acts on click.
  function onPress(btn, fn) {
    const act = (e) => { e.preventDefault(); fn(e); };
    btn.addEventListener("pointerdown", (e) => { if (e.pointerType !== "mouse") act(e); });
    btn.addEventListener("mousedown", act);
    btn.addEventListener("click", (e) => { if (e.detail === 0) fn(e); });
  }
  const pickBtns = [...document.querySelectorAll(".pick")];
  function togglePick(target) {   // destination bar, left button: tap the map to choose the place
    state.pick = state.pick === target ? null : target;
    pickBtns.forEach((x) => { x.classList.toggle("on", x.dataset.target === state.pick); x.setAttribute("aria-pressed", String(x.dataset.target === state.pick)); });
    map.getCanvas().style.cursor = state.pick ? "crosshair" : "";
    if (state.pick && search.which) abandonSearch("peek");
    else if (state.pick && isPhone()) setSheet("peek");
  }
  pickBtns.forEach((b) => onPress(b, () => togglePick(b.dataset.target)));

  // draggable endpoints: location pins (start mostly blue, destination mostly white with blue)
  const markers = {};
  const PIN = {
    from: '<svg viewBox="0 0 64 78"><path d="M32 76c-3-6-22-22-22-42a22 22 0 0 1 44 0c0 20-19 36-22 42z" fill="#1e2160" stroke="#fff" stroke-width="4"/><circle cx="32" cy="33" r="9" fill="#fff"/></svg>',
    to: '<svg viewBox="0 0 64 78"><path d="M32 76c-3-6-22-22-22-42a22 22 0 0 1 44 0c0 20-19 36-22 42z" fill="#fff" stroke="#1e2160" stroke-width="5"/><circle cx="32" cy="33" r="9" fill="#1e2160"/></svg>',
  };
  function endEl(kind) { const d = document.createElement("div"); d.className = "end-pin"; d.innerHTML = PIN[kind]; return d; }
  function setPoint(which, lonlat, label) {
    state[which] = lonlat; state[which + "Label"] = label;
    (which === "from" ? fromEl : toEl).value = label;
    if (!markers[which]) {
      markers[which] = new maplibregl.Marker({ element: endEl(which), anchor: "bottom", draggable: true, ...MARKER_SHOW }).setLngLat(lonlat).addTo(map);
      let raf = null;
      markers[which].on("drag", () => {
        if (raf) return;
        raf = requestAnimationFrame(() => { raf = null; const p = markers[which].getLngLat(); state[which] = [p.lng, p.lat]; recompute(false); });
      });
      markers[which].on("dragend", () => {
        const p = markers[which].getLngLat(); const lab = placeLabel(p.lng, p.lat);
        state[which] = [p.lng, p.lat]; state[which + "Label"] = lab; (which === "from" ? fromEl : toEl).value = lab;
        recompute(false);
      });
    } else markers[which].setLngLat(lonlat);
    refreshSections();
  }

  // ------------------------------------------------------------------ phones: typing a place. The card slides so its search bars
  // sit right on top of the keyboard, with the map above and the suggestions over the map. A suggestion (or the keyboard's
  // return key) on the start moves on to the destination. A small grey ✕ inside the bar leaves without changing anything.
  const search = { which: null, prev: {}, before: "half" };   // the bar being edited, what each bar held, the card size before
  function clearPoint(which) {
    state[which] = null; state[which + "Label"] = ""; (which === "from" ? fromEl : toEl).value = "";
    if (markers[which]) { markers[which].remove(); delete markers[which]; }
  }
  function clearField(which) {   // the x: that place goes (field, marker, route and route cards); the other place stays
    const had = !!state[which];
    clearPoint(which);
    if (search.which === which) { clearTimeout(sugTimer); closeList(false); sug.hidden = true; sugItems = []; }   // typing: stay in the bar, as if the text were deleted by hand
    if (had) recompute(true);   // the x never moves the focus: an unfocused bar stays unfocused (no keyboard), a bar being typed in keeps it
  }
  function abandonSearch(sheetAfter) {   // leave the typing state with the places as they were
    const which = search.which; if (!which) return;
    (which === "from" ? fromEl : toEl).value = state[which + "Label"] || "";
    leaveSearch(sheetAfter);
  }
  const kbOpen = () => !!window.visualViewport && innerHeight - visualViewport.height > 120;
  function keyboardTop() {   // page coordinates; until the keyboard is up, a guess (iPhone keyboards take 40-46% of the screen)
    return kbOpen() ? visualViewport.offsetTop + visualViewport.height : innerHeight - Math.round(Math.max(260, innerHeight * 0.47));
  }
  function dock(animate) {   // card height that leaves the search bars, and the place chips under them, just above the keyboard
    if (!search.which) return;
    const field = (state.tab === "go" ? toEl : fromEl).closest(".field"), chips = placeBox.getClientRects().length > 0;
    const block = (chips ? placeBox : field).getBoundingClientRect().bottom - panel.getBoundingClientRect().top + (chips ? 4 : 12);   // the chips' 44 px rows end 7 px under their circles
    const h = Math.round(innerHeight - keyboardTop() + block);
    panel.classList.toggle("dragging", !animate);
    panel.style.height = h + "px";
    placeSuggest(h); placeList();
  }
  function placeSuggest(h = panel.getBoundingClientRect().height) {   // the list floats over the map, just above the card
    if (sug.parentElement !== document.body) document.body.appendChild(sug);
    const safeTop = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--safe-top")) || 0;
    const vvTop = window.visualViewport ? visualViewport.offsetTop : 0;
    sug.style.top = "auto"; sug.style.bottom = Math.round(h + 8) + "px";
    sug.style.maxHeight = Math.max(120, Math.round(innerHeight - h - 16 - vvTop - safeTop)) + "px";
  }
  const snapshot = (which) => (state[which] ? { lonlat: state[which], label: state[which + "Label"] } : null);
  function activate(which) {   // this bar is now the one being edited
    if (!(which in search.prev)) search.prev[which] = snapshot(which);
    search.which = which; sugTarget = which;
  }
  function enterSearch(which) {
    if (search.which) { activate(which); return; }
    search.before = sheet.state; search.prev = {};
    fromEl.enterKeyHint = state.tab === "go" ? "next" : "done"; toEl.enterKeyHint = "go";
    document.body.classList.add("searching"); panel.scrollTop = 0;
    activate(which); dock(false);
  }
  function leaveSearch(sheetAfter) {
    search.which = null; search.prev = {};
    document.body.classList.remove("searching"); closeList(false);
    sug.hidden = true; sugItems = [];
    if (sug.parentElement !== sugHome) { sugHome.appendChild(sug); sug.style.bottom = ""; sug.style.maxHeight = ""; }
    const a = document.activeElement; if (a === fromEl || a === toEl) a.blur();
    setSheet(sheetAfter || "half");
  }
  function cancelSearch() {   // the ✕: put this bar's place back as it was and close the keyboard
    const which = search.which; if (!which) return;
    const prev = search.prev[which];
    if (prev) setPoint(which, prev.lonlat, prev.label); else clearPoint(which);
    leaveSearch(search.before);
    recompute(true);
  }
  function flash(el) { const f = el.closest(".field"); f.classList.add("next"); setTimeout(() => f.classList.remove("next"), 1600); }
  function blurred(el) {   // the keyboard closed: its ✓ / done key, or a tap on the map
    const a = document.activeElement;
    if (!search.which) { if (a !== fromEl && a !== toEl) sug.hidden = true; return; }
    if (a === fromEl || a === toEl || search.which !== el.id) return;   // moved on to the other bar
    const which = el.id;
    if (el.value !== (state[which + "Label"] || "") && sugItems.length) {   // typed a new place: take the top suggestion
      const it = sugItems[0]; setPoint(which, [it.lon, it.lat], it.label);
      if (which === "from" && state.tab === "go" && !state.to) {
        activate("to"); toEl.focus();   // without a tap, iPhone may not reopen the keyboard: then just point at the destination bar
        setTimeout(() => { if (search.which === "to" && (document.activeElement !== toEl || !kbOpen())) { leaveSearch(search.before); flash(toEl); } }, 450);
        return;
      }
      leaveSearch("half"); recompute(true); return;
    }
    el.value = state[which + "Label"] || "";   // nothing new: keep the place as it was
    leaveSearch(search.before);
  }
  // A tap that opens search moves the card up before the finger lifts. iPhone Safari then sends that tap's mouse events to whatever
  // is under the finger by then (the card's background), takes it as a tap outside and closes the keyboard, which closes search.
  // So the rest of that tap is cancelled: its touchend, and any mouse events it still produces in the next moment.
  let tapOpenedSearch = false, swallowUntil = 0, clearSwallowUntil = 0;   // clearSwallowUntil: after a finger's ✕, see below
  for (const t of ["mousedown", "mouseup", "click"]) document.addEventListener(t, (e) => {
    const now = performance.now();
    if ((now < swallowUntil && e.target !== fromEl && e.target !== toEl) || now < clearSwallowUntil) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  for (const el of [fromEl, toEl]) {
    el.addEventListener("pointerdown", (e) => {
      if (!isPhone() || state.mode === "ride" || search.which) return;   // already searching: the bars sit above the keyboard
      e.preventDefault();                 // move the card first, then focus, so iPhone Safari has no reason to scroll the page
      if (e.pointerType !== "mouse") { tapOpenedSearch = true; swallowUntil = performance.now() + 800; }
      enterSearch(el.id);
      el.focus({ preventScroll: true });
    });
    el.addEventListener("touchend", (e) => { if (tapOpenedSearch) { tapOpenedSearch = false; e.preventDefault(); } }, { passive: false });
    el.addEventListener("touchcancel", () => { tapOpenedSearch = false; });
    el.addEventListener("focus", () => {   // an empty bar shows no list (2026-11-03): the place chips sit right under it
      if (isPhone() && state.mode !== "ride") enterSearch(el.id);
      sugTarget = el.id;
    });
  }
  // The ✕ hides itself as it clears, so the mouse events a finger's tap still sends land on the bar now under it and would focus it
  // (the keyboard opens). A finger's ✕ therefore cancels its touchend and swallows any mouse events that follow.
  document.querySelectorAll(".clear").forEach((b) => {
    onPress(b, () => clearField(b.dataset.target));
    b.addEventListener("pointerdown", (e) => { if (e.pointerType !== "mouse") clearSwallowUntil = performance.now() + 400; });
    b.addEventListener("touchend", (e) => e.preventDefault(), { passive: false });
  });

  // start bar, left button: "Use my location" (the browser asks once; a refusal or failure gets a calm message)
  const locateBtn = $("#locate");
  let islandBox = null;   // the mapped area, from the routing graph (a start outside it can't be routed)
  const insideMap = (lon, lat) => {
    if (!islandBox) { const xs = router.lon, ys = router.lat; islandBox = [Infinity, Infinity, -Infinity, -Infinity];
      for (let i = 0; i < xs.length; i++) { islandBox[0] = Math.min(islandBox[0], xs[i]); islandBox[1] = Math.min(islandBox[1], ys[i]); islandBox[2] = Math.max(islandBox[2], xs[i]); islandBox[3] = Math.max(islandBox[3], ys[i]); } }
    const m = 0.01;   // about 1 km of slack
    return lon > islandBox[0] - m && lon < islandBox[2] + m && lat > islandBox[1] - m && lat < islandBox[3] + m;
  };
  // where you are, as a blue dot on the map (from "Use my location" or on opening the app; kept in memory only)
  let meDot = null;
  function showMe(ll) {
    if (!meDot) {
      const el = document.createElement("div"); el.className = "me-dot"; el.setAttribute("aria-hidden", "true");   // the start bar says it in words
      meDot = new maplibregl.Marker({ element: el, ...MARKER_SHOW }).setLngLat(ll).addTo(map);
    } else meDot.setLngLat(ll);
  }
  // the map moves to a place: on phones, centred in the part above the card (a desktop's centre is clear of the panel already)
  function showPlace(ll) {
    const offset = isPhone() ? [0, -Math.round($("#panel").getBoundingClientRect().height / 2)] : [0, 0];
    map.easeTo({ center: ll, zoom: Math.max(map.getZoom(), 14.5), offset, duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 600 });
  }
  // One position from the browser; onFix gets it only when it is on or near the island. quiet (on opening the app): no busy
  // state and no messages, so a refusal or a failure just leaves the map as it was (noted in the console).
  function locate(onFix, quiet = false) {
    if (!navigator.geolocation) { if (quiet) console.info("location: not available here"); else toast(t("locUnavailable")); return; }
    if (!quiet) locateBtn.setAttribute("aria-busy", "true");
    const slow = quiet ? 0 : setTimeout(() => toast(t("locating")), 1200);
    const done = () => { clearTimeout(slow); if (!quiet) locateBtn.removeAttribute("aria-busy"); };
    navigator.geolocation.getCurrentPosition((pos) => {
      done();
      const ll = [pos.coords.longitude, pos.coords.latitude];
      if (!insideMap(ll[0], ll[1])) { if (quiet) console.info("location: off the island, map left as it was"); else toast(t("locOutside")); return; }
      showMe(ll); onFix(ll);
    }, (err) => {
      done();
      if (quiet) console.info("location on open:", err && err.message);
      else toast(t(err && err.code === 1 ? "locDenied" : "locUnavailable"));
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
  }
  function useMyLocation() {
    if (state.mode === "ride" || locateBtn.getAttribute("aria-busy") === "true") return;
    if (search.which) abandonSearch(search.before);   // typing: keep the places as they were, drop the keyboard
    locate((ll) => {
      setPoint("from", ll, t("myLocation"));
      if (state.tab !== "go" || state.to) recompute(true);   // a destination is set: route now
      else showPlace(ll);
    });
  }
  onPress(locateBtn, useMyLocation);

  // Locate on open (2026-11-03). Location already allowed: the map centres on you and the start bar says "My location" (on or near
  // the island only). First visit: ask once, right after the welcome card closes (after the tour, if that was the choice), and remember
  // that we asked (localStorage "piste-locate-asked"), so a refusal never brings it back. Refused, or a shared link: nothing.
  async function geoPermission() {   // "granted", "prompt" or "denied"; null where the browser can't say
    try { return navigator.permissions && navigator.permissions.query ? (await navigator.permissions.query({ name: "geolocation" })).state : null; }
    catch (e) { return null; }
  }
  const untouched = () => state.mode === "explore" && state.tab === "go" && !state.from && !state.to && !search.which && !state.pick && !touring();
  function locateOnOpen() {
    locate((ll) => {
      if (!untouched()) return;   // the rider started planning meanwhile: just the dot
      setPoint("from", ll, t("myLocation"));
      showPlace(ll);
    }, true);
  }
  async function startLocate() {
    const perm = await geoPermission();
    if (perm === "granted") { locateOnOpen(); return; }
    if (perm === "denied" || store.get("locate-asked", "") === "1") return;
    document.addEventListener("piste:welcome-closed", (e) => {   // tour.js: only on a first visit
      const ask = () => { store.set("locate-asked", "1"); locateOnOpen(); };
      if (e.detail && e.detail.tour) document.addEventListener("piste:tour-ended", ask, { once: true }); else ask();
    }, { once: true });
  }
  if (window.visualViewport) for (const ev of ["resize", "scroll"]) visualViewport.addEventListener(ev, () => { if (search.which && kbOpen()) dock(true); });

  // ------------------------------------------------------------------ saved places (2026-11-02): Home, Work and others, and the last 5 destinations
  // Kept on this device only (localStorage "piste-places" and "piste-recents"); nothing here is ever sent anywhere.
  const readList = (key) => {
    try { const v = JSON.parse(store.get(key, "[]")); return Array.isArray(v) ? v.filter((p) => p && Array.isArray(p.ll) && p.ll.length === 2 && p.ll.every(Number.isFinite)) : []; }
    catch (e) { return []; }
  };
  const writeList = (key, list) => store.set(key, JSON.stringify(list));
  // places: { kind: "home" | "work" | "", name, ll } (a saved place's own name; for Home and Work, the address they were set from); recents: { name, ll }
  let places = readList("places"), recents = readList("recents").slice(0, 5);
  const placeBox = $("#places"), listEl = $("#place-list"), star = placeBox.querySelector(".star"), pl = { layer: $("#place-dialog"), name: $("#pl-name"), status: $("#pl-status"), i: -1 };
  const placeName = (p) => (p.kind ? t(p.kind === "home" ? "placeHome" : "placeWork") : p.name);
  const placeIcon = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const PLACE_ICON = { home: placeIcon('<path d="M4 11 12 4l8 7M6 9.5V20h12V9.5M10 20v-5.5h4V20"/>'),
    work: placeIcon('<rect x="3.5" y="7.5" width="17" height="12" rx="2"/><path d="M9 7.5V6a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 6v1.5M3.5 13h17"/>'), add: placeIcon('<path d="M12 5v14M5 12h14"/>'),
    star: placeIcon('<path d="m12 4.6 2.2 4.5 4.9.7-3.6 3.5.9 4.9-4.4-2.3-4.4 2.3.9-4.9-3.6-3.5 4.9-.7z"/>'),
    edit: placeIcon('<path d="M14.5 5.5l4 4M4.5 19.5l1-4.5 10-10 3.5 3.5-10 10z"/>') };
  // One chip, ★ (2026-11-03), always under the search bars. It opens the menu below: Home, Work, the saved places, "Add to saved locations".
  // Recent destinations are not in it: they come up in the pop-up while typing an address (renderSuggest).
  const kindIndex = (kind) => places.findIndex((p) => p.kind === kind);
  const custom = () => places.map((p, i) => ({ p, i })).filter((x) => !x.p.kind);
  const refreshList = () => { if (!listEl.hidden) { renderPlaceList(); placeList(); } };   // an open menu follows a change (or the language)
  const commitPlaces = () => { writeList("places", places); refreshList(); };
  // the place on the bars: the destination, or the start when there is no destination
  const currentPlace = () => { const w = state.to ? "to" : state.from ? "from" : null; return w && { name: state[w + "Label"] || t("droppedPin"), ll: state[w].map((v) => +v.toFixed(6)) }; };
  const addressOf = (cur) => (cur.name === t("myLocation") ? "" : cur.name);   // "My location" would not say where Home is later on
  function placeTarget() {   // the bar a saved place fills: the one being typed in, else the destination (the start, when only the destination is set)
    if (state.tab === "suggest") return "from";
    const a = document.activeElement;
    if (a === fromEl || a === toEl) return a.id;
    return state.to && !state.from ? "from" : "to";
  }
  function usePlace(p) {
    const which = placeTarget();
    sug.hidden = true; sugItems = [];
    setPoint(which, p.ll, placeName(p));
    if (search.which) { placeDone(which); return; }   // phones, typing: as if picked from the suggestions (on to the destination, or done)
    if (state.tab !== "go" || (state.from && state.to)) recompute(true);
    else showPlace(p.ll);   // one end only: show where it is
  }
  function setHomeOrWork(kind) {   // true when the place on the bars was saved
    const cur = currentPlace();
    if (!cur) { toast(t("pickPlaceFirst")); return false; }
    places = places.filter((p) => p.kind !== kind).concat({ kind, name: addressOf(cur), ll: cur.ll });
    commitPlaces();
    return true;
  }
  function remember(name, ll) {   // a chosen destination goes on top of the last five
    const same = (r) => r.ll.every((v, k) => Math.abs(v - ll[k]) < 1e-4);
    recents = [{ name, ll }, ...recents.filter((r) => !same(r))].slice(0, 5);
    writeList("recents", recents);
  }

  // ---- the ★ menu (2026-11-03): Home, Work, the saved places (each with its pencil), then "Add to saved locations". A row uses its place
  // as before; the pencil opens the place form. A popover: aria-expanded on ★, Esc or a tap outside closes it, and focus goes back to ★ when
  // it was inside. It floats (position: fixed) just below ★, or above it when there is no room below; while typing on a phone, over the map above the card.
  function renderPlaceList() {
    const row = ({ attr, icon, name, sub = "", edit = -1, cls = "" }) => `<li><button type="button" class="pl-row ${cls}" ${attr}>${PLACE_ICON[icon]}<span class="pl-text"><span>${C.esc(name)}</span>${sub ? `<small>${C.esc(sub)}</small>` : ""}</span></button>`
      + (edit < 0 ? "" : `<button type="button" class="pl-edit" data-edit="${edit}" aria-label="${C.esc(t("placeEditOne", { name }))}" title="${C.esc(t("placeEditT"))}">${PLACE_ICON.edit}</button>`) + "</li>";
    const fixed = ["home", "work"].map((k) => {   // set: the place's name or address under "Home"; unset: "Set home" saves the place on the bars
      const i = kindIndex(k);
      return i < 0 ? row({ attr: `data-k="${k}" data-set="${k}"`, icon: k, name: t(k === "home" ? "setHome" : "setWork"), cls: "unset" })
        : row({ attr: `data-k="${k}" data-p="${i}"`, icon: k, name: placeName(places[i]), sub: places[i].name, edit: i });
    });
    const saved = custom().map(({ p, i }) => row({ attr: `data-p="${i}"`, icon: "star", name: p.name, edit: i }));
    listEl.setAttribute("aria-label", t("placeList"));
    listEl.innerHTML = `<ul>${fixed.join("")}${saved.join("")}${row({ attr: "data-add", icon: "add", name: t("placeAddTo") })}</ul>`;
  }
  function placeList() {   // put the open menu next to ★, inside what the screen shows (above a phone keyboard)
    if (listEl.hidden) return;
    const r = star.getBoundingClientRect(), inset = 7;   // the chip's drawn circle sits 7 px inside its 44 px button
    const safeTop = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--safe-top")) || 0;
    const typing = !!search.which || kbOpen();   // phones, typing: the keyboard is (or is about to be) right under the chip
    const top = (window.visualViewport ? visualViewport.offsetTop : 0) + safeTop + 8, bottom = (typing ? keyboardTop() : innerHeight) - 8;
    // typing: over the map just above the card, like the suggestions, so the bars stay in view
    const upTo = typing ? $("#panel").getBoundingClientRect().top - 2 : r.top + inset;
    const below = bottom - (r.bottom - inset) - 6, above = upTo - top - 6;
    listEl.style.maxHeight = ""; const want = listEl.scrollHeight;
    const down = !typing && (below >= want || below >= above);
    const room = Math.max(96, down ? below : above), h = Math.min(want, room);
    const w = listEl.offsetWidth, left = Math.max(10, Math.min(innerWidth - w - 10, r.left + inset - 4));
    Object.assign(listEl.style, { maxHeight: room + "px", left: left + "px", top: (down ? r.bottom - inset + 6 : upTo - 6 - h) + "px" });
  }
  function openList(focusFirst) {
    renderPlaceList();
    sug.hidden = true;   // not both lists at once
    listEl.hidden = false;
    star.setAttribute("aria-expanded", "true");
    placeList();
    if (focusFirst) { const first = listEl.querySelector("button"); if (first) first.focus({ preventScroll: true }); }
  }
  function closeList(refocus) {
    if (listEl.hidden) return;
    const inside = listEl.contains(document.activeElement);
    listEl.hidden = true;
    star.setAttribute("aria-expanded", "false");
    if (refocus || inside) star.focus({ preventScroll: true });
  }
  function listChoice(btn) {
    if (btn.dataset.edit) { closeList(false); openPlace(+btn.dataset.edit, star); return; }
    if (btn.hasAttribute("data-add")) { closeList(false); openPlace(-1, star); return; }   // names the place on the bars (or says to pick one first)
    if (btn.dataset.set) {
      const kind = btn.dataset.set;
      if (!setHomeOrWork(kind)) { closeList(false); return; }   // nothing to save: the message shows and the menu goes
      const saved = listEl.querySelector(`[data-k="${kind}"]`);   // the menu stays open and shows the saved place; the keyboard stays on its row
      if (saved) saved.focus({ preventScroll: true });
      return;
    }
    const p = places[+btn.dataset.p];
    closeList(false);
    if (p) usePlace(p);
  }
  listEl.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) listChoice(b); });
  listEl.addEventListener("keydown", (e) => {   // arrows move between the rows (Tab works too)
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const all = [...listEl.querySelectorAll("button")], i = all.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault(); all[(i + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length].focus();
  });
  listEl.addEventListener("focusout", (e) => { if (!listEl.hidden && e.relatedTarget && !listEl.contains(e.relatedTarget) && e.relatedTarget !== star) closeList(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !listEl.hidden) { e.preventDefault(); e.stopPropagation(); closeList(listEl.contains(document.activeElement) || document.activeElement === star); } }, true);
  document.addEventListener("pointerdown", (e) => { if (!listEl.hidden && !listEl.contains(e.target) && !star.contains(e.target)) closeList(false); }, true);
  addEventListener("resize", placeList);
  if (window.visualViewport) for (const ev of ["resize", "scroll"]) visualViewport.addEventListener(ev, placeList);
  // The small form: name the current place (new), or rename, move to the current place, or delete a saved one (Home and Work: move or delete)
  function openPlace(i, opener) {
    const p = places[i], cur = currentPlace();
    if (!p && !cur) { toast(t("pickPlaceFirst")); return; }
    pl.i = i; pl.status.textContent = ""; pl.name.removeAttribute("aria-invalid");
    $("#pl-title").textContent = t(p ? "placeEditT" : "placeNewT");
    pl.name.value = p ? placeName(p) : cur.name;
    $("#pl-name-field").hidden = !!(p && p.kind);   // Home and Work keep their names
    $("#pl-delete").hidden = !p; $("#pl-use").hidden = !(p && cur);
    const first = !isPhone() && !(p && p.kind) ? pl.name : null;   // phones: no keyboard until the field is tapped
    const back = () => star.focus({ preventScroll: true });   // when the opener has gone
    if (window.pisteDialog.open(pl.layer, opener, first, back) && first) pl.name.select();
  }
  const closePlace = () => window.pisteDialog.close();
  $("#place-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = pl.name.value.trim(), p = places[pl.i];
    if (!name && !(p && p.kind)) { pl.name.setAttribute("aria-invalid", "true"); pl.status.dataset.kind = "error"; pl.status.textContent = t("placeNeedName"); pl.name.focus(); return; }
    if (p) { if (!p.kind) p.name = name; } else places.push({ kind: "", name, ll: currentPlace().ll });
    commitPlaces(); closePlace();
  });
  $("#pl-delete").addEventListener("click", () => { places.splice(pl.i, 1); pl.i = -1; commitPlaces(); closePlace(); });
  $("#pl-use").addEventListener("click", () => {
    const p = places[pl.i], cur = currentPlace();
    p.ll = cur.ll; if (p.kind) p.name = addressOf(cur);
    commitPlaces(); closePlace();
  });
  $("#pl-cancel").addEventListener("click", closePlace);
  pl.layer.addEventListener("click", (e) => { if (e.target === pl.layer) closePlace(); });
  placeBox.addEventListener("mousedown", (e) => e.preventDefault());   // a click keeps the focus on the search bar it fills
  star.addEventListener("click", (e) => { if (listEl.hidden) openList(e.detail === 0); else closeList(e.detail === 0); });   // keyboard: focus moves into the menu
  for (const ev of ["scroll", "transitionend"]) $("#panel").addEventListener(ev, placeList, { passive: true });   // ★ moves with the card

  // ------------------------------------------------------------------ map clicks
  let layersJustClosed = false;
  map.on("click", (e) => {
    if (layersJustClosed) { layersJustClosed = false; return; }   // a tap that only closed the layers panel
    if (state.mode === "ride") return;
    const live = map.getLayer("bixi-live") && map.getLayoutProperty("bixi-live", "visibility") !== "none" ? ["bixi-live", "bixi-count"] : [];
    const hit = map.queryRenderedFeatures(e.point, { layers: [...live, ...POI_LAYERS.map((p) => p.id)].filter((id) => map.getLayer(id)) });
    // 2026-11-05: with a search bar active (typed in, or just tapped), the tap fills that bar: the place tapped, or the spot.
    // Start or destination, in either order; the keyboard closes.
    const typing = search.which || barAtPress;
    barAtPress = null;
    if (typing && !(state.tab === "suggest" && state.smode === "classics")) { tapFills(typing, e, hit); return; }
    const cones = map.queryRenderedFeatures(e.point, { layers: ["works", "works-near"].filter((id) => map.getLayer(id)) });
    if (cones.length && !state.pick) { worksPopup(cones[0]); return; }
    if (hit.length && !state.pick) { poiPopup(hit[0]); return; }
    const alt = map.queryRenderedFeatures(e.point, { layers: ["route-alts"] });
    if (alt.length && !state.pick) { selectRoute(alt[0].properties.i); return; }
    if (state.tab === "suggest" && state.smode === "classics") return;
    const lonlat = [e.lngLat.lng, e.lngLat.lat];
    const which = state.tab === "suggest" ? "from" : state.pick || (!state.from ? "from" : "to");
    const label = placeLabel(lonlat[0], lonlat[1]);
    setPoint(which, lonlat, label);
    if (which === "to") remember(label, lonlat);
    state.pick = null; document.querySelectorAll(".pick").forEach((x) => x.classList.remove("on")); map.getCanvas().style.cursor = "";
    recompute(!state.routes.length);
  });
  // the bar that had the focus when the map was pressed (desktop: the click itself moves the focus off it)
  let barAtPress = null;
  map.getCanvas().addEventListener("pointerdown", () => { const a = document.activeElement; barAtPress = a === fromEl ? "from" : a === toEl ? "to" : null; }, true);
  function tapFills(which, e, hit) {
    const f = hit.find((h) => h.properties.name), lonlat = f ? f.geometry.coordinates.slice(0, 2) : [e.lngLat.lng, e.lngLat.lat];
    const label = f ? f.properties.name : placeLabel(lonlat[0], lonlat[1]);
    if (search.which) leaveSearch(search.before);
    else { const a = document.activeElement; if (a === fromEl || a === toEl) a.blur(); }
    setPoint(which, lonlat, label);
    if (which === "to") remember(label, lonlat);
    state.pick = null; document.querySelectorAll(".pick").forEach((x) => x.classList.remove("on")); map.getCanvas().style.cursor = "";
    recompute(!state.routes.length);
  }
  // a construction cone: which street, between where, closed or partly blocked, until when, and whose data (2026-11-05)
  function worksPopup(f) {
    const p = f.properties, lang = I.lang === "fr" ? "fr-CA" : "en-CA";
    const day = (iso) => new Date(iso + "T12:00:00").toLocaleDateString(lang, { day: "numeric", month: "long", year: "numeric" });
    const today = new Date().toLocaleDateString("en-CA"), ended = p.until && p.until < today;
    const rows = [
      p.impact ? `<b>${t(p.impact === "Barrée" ? "worksClosed" : "worksBlocked")}</b>` : "",
      p.from && p.to ? C.esc(t("worksBetween", { a: I.place(p.from), b: I.place(p.to) })) : "",
      p.until ? C.esc(t(ended ? "worksEnded" : "worksUntil", { date: day(p.until) })) : "",
    ].filter(Boolean).map((r) => `<div class="pop-works">${r}</div>`).join("");
    const html = `<div class="pop"><b>${C.esc(p.name ? I.place(p.name) : C.poiLabel("works"))}</b><div class="pop-kind">${C.esc(C.poiLabel("works"))}</div>${rows}`
      + `${p.src ? `<div class="pop-src">${C.esc(p.src)}</div>` : ""}</div>`;
    new maplibregl.Popup({ offset: 14 }).setLngLat(f.geometry.coordinates).setHTML(html).addTo(map);
  }
  for (const id of ["works", "works-near"]) {
    map.on("mouseenter", id, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", id, () => (map.getCanvas().style.cursor = ""));
  }
  function poiPopup(f) {
    const isBixi = f.layer.id === "bixi-live" || f.layer.id === "bixi-count";
    const kind = isBixi ? "bixi" : f.properties.k;
    const name = f.properties.name || C.poiLabel(kind);
    const extra = isBixi ? `<div class="pop-bixi"><b>${bixiText(f.properties)}</b> · ${t("bixiLive")}</div>` : "";
    // "More info": a web search for a named place (not for BIXI stations or the water, repair and parking spots, whose names only say where they are)
    const more = f.properties.name && !["bixi", "water", "repair", "parking", "toilets"].includes(kind)
      ? `<a class="pop-more" href="https://www.google.com/search?q=${encodeURIComponent(`${f.properties.name} Montréal`)}" target="_blank" rel="noopener">${t("moreInfo")}<span class="sr-only"> (${t("newTab")})</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M19 5l-8 8M17 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 4 18.5v-10A1.5 1.5 0 0 1 5.5 7H10"/></svg></a>` : "";
    const html = `<div class="pop"><b>${C.esc(name)}</b><div class="pop-kind">${C.esc(C.poiLabel(kind))}</div>${extra}
      <div class="pop-actions"><button type="button" class="primary pop-go">${t("rideHere")}</button>${more}</div></div>`;
    const pop = new maplibregl.Popup({ offset: 14 }).setLngLat(f.geometry.coordinates).setHTML(html).addTo(map);
    pop.getElement().querySelector(".pop-go").onclick = () => {
      pop.remove();
      if (state.tab !== "go") { state.tab = "go"; refreshSections(); }
      setPoint("to", f.geometry.coordinates, name);
      if (!state.from) toast(t("pickStartToast"));
      recompute(true);
    };
  }
  map.on("mouseenter", "route-alts", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "route-alts", () => (map.getCanvas().style.cursor = state.pick ? "crosshair" : ""));

  // ------------------------------------------------------------------ routing
  // the router settings behind each kind of route (a GPS reroute uses the same ones as the route you started)
  // What the panel says now (slider, hills, wind), in the form the router takes (see routeSettings in shared/router.js).
  function planSettings() { return { strictness: strictness(), avoidHills: hills.checked, wind: windWeights(), works: worksWeights() }; }
  function routeWeights(key) { return routeSettings(key, planSettings()); }   // "Your route" and suggested rides use "yourRoute"
  function selWeights(sel) {
    if (sel.classic) return { w: PROFILES.bikemax.w, hill: 4 };   // as classicRoute()
    return routeWeights(sel.key || "yourRoute");
  }
  // Detour cap (2026-10-31, internal): router.planRoute keeps "Your route" and "Most bike paths" to at most
  // max(1.5 x the shortest legal route, shortest + 300 m), relaxing the settings when needed; "Most direct" has no cap.
  let suggTimer = null;
  function recompute(fit) {
    if (state.mode === "ride") return;
    if (state.tab === "suggest" && state.smode === "classics") return showClassic(state.classic, fit);
    if (state.tab === "suggest") {   // suggestions take a while on long rides: run when asked, debounce while dragging
      clearTimeout(suggTimer);
      if (fit) computeSuggestions(true); else suggTimer = setTimeout(() => computeSuggestions(false), 160);
      return;
    }
    computeRoutes(fit);
  }
  function computeRoutes(fit) {
    if (!state.from || !state.to) { state.routes = []; renderRoutes(); drawRoutes(); return; }
    const t1 = performance.now();
    // one route, one card (2026-11-05): it follows the Route style slider and the Avoid chips ("Most direct" is the slider's left end)
    const r = router.planRoute(state.from, state.to, "yourRoute", planSettings(), router.detourLimit(state.from, state.to));
    state.lastMs = performance.now() - t1;
    const keep = r ? [{ key: "yourRoute", r }] : [];
    state.routes = keep; state.sel = 0;
    renderRoutes(); drawRoutes();
    if (fit && keep.length) fitRoute(keep[0].r);
    const key = `route|${state.from}|${state.to}`;
    if (keep.length && key !== lastTracked && !touring()) { lastTracked = key; count("route", { km: Math.round(keep[0].r.length / 1000), winter: state.winter }); }
  }
  // "Suggest a ride": three rides from the start, loop or one-way, of about the asked length, optionally via a stop
  let suggToken = 0;
  async function computeSuggestions(fit) {
    const token = ++suggToken;
    if (!state.from) { state.routes = []; renderRoutes(); drawRoutes(); return; }
    $("#routes").innerHTML = `<div class="finding">${t("finding")}</div>`; $("#detail").innerHTML = "";
    await tick();
    const t1 = performance.now();
    const wx = state.avoidWind ? state.wxData || (await loadWeather()) : null;
    const picks = await suggester.suggest({ start: state.from, km: state.sugg.km, loop: state.sugg.loop, stop: state.sugg.stop,
      weights: Object.assign({}, weightsFor(strictness(), hills.checked), windWeights(), worksWeights()), windCost: wx ? (route) => WX.windOnRoute(route, wx) : null });
    if (token !== suggToken) return;   // a newer request started meanwhile
    state.lastMs = performance.now() - t1;
    state.routes = picks.map((c) => ({ title: c.title, via: c.via, r: c.route, sig: c.route.sig, end: c.end, loop: c.loop }));
    state.sel = 0;
    if (!picks.length) toast(t("nothingFits"));
    else count("suggest", { shape: state.sugg.loop ? "loop" : "one-way", km: state.sugg.km, stop: state.sugg.stop ? "yes" : "no" });
    renderRoutes(); drawRoutes();
    if (fit && state.routes.length) fitRoute(state.routes[0].r);
  }
  function selectRoute(i) { state.sel = +i; renderRoutes(); drawRoutes(); }
  function stopsData(r) {   // the stop's or sights' rings and labels
    const stops = (r && r.stops) || [];
    return { type: "FeatureCollection", features: stops.map((s, i) => ({ type: "Feature", id: i, geometry: { type: "Point", coordinates: [s.lon, s.lat] }, properties: { label: s.label, sight: s.sight ? 1 : 0 } })) };
  }
  function fitRoute(r, camera = {}) {
    const xs = r.coords.map((c) => c[0]), ys = r.coords.map((c) => c[1]);
    let padding;
    if (isPhone()) {
      if (sheet.state === "full") setSheet("half");
      const top = 60 + (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--safe-top")) || 0);
      padding = { top, bottom: sheetHeight(sheet.state) + 24, left: 24, right: 70 };
    } else padding = { top: 80, bottom: 80, left: 420, right: 90 };
    map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding, maxZoom: 16, duration: 700, ...camera });
  }
  function drawRoutes() {
    const sel = state.routes[state.sel];
    map.getSource("route").setData(sel ? C.routePiecesGeoJSON(sel.r) : empty);
    map.getSource("route-alts").setData({ type: "FeatureCollection", features: state.routes.map((c, i) => i === state.sel ? null : C.routeLineGeoJSON(c.r, { i })).filter(Boolean) });
    map.getSource("stops").setData(stopsData(sel && sel.r));
    // suggested and classic rides start/end at places, not at dragged pins: mark them with dots
    const ends = [];
    if (sel && state.tab === "suggest") {
      if (state.smode === "classics") ends.push({ type: "Feature", geometry: { type: "Point", coordinates: sel.r.coords[0] }, properties: { k: "from" } });
      if (!sel.loop && sel.kind !== "outback") ends.push({ type: "Feature", geometry: { type: "Point", coordinates: sel.r.coords[sel.r.coords.length - 1] }, properties: { k: "to" } });
    }
    map.getSource("ends").setData({ type: "FeatureCollection", features: ends });
    setMode(sel ? "route" : "explore");
    renderWxCard();
  }

  // ------------------------------------------------------------------ classic rides: swipe through, the centred card shows on the map
  const classicCache = new Map();
  function classicRoute(i) {
    const c = CLASSICS[i], key = `${c.id}|${state.winter}`;
    if (classicCache.has(key)) return classicCache.get(key);
    const pen = new Float32Array(router.m).fill(1), parts = [], w = { w: PROFILES.bikemax.w, hill: 4 };
    const closes = c.pts.length > 2 && c.pts[0][0] === c.pts[c.pts.length - 1][0] && c.pts[0][1] === c.pts[c.pts.length - 1][1];
    for (let k = 1; k < c.pts.length; k++) {
      // each leg starts exactly where the last one ended, and a loop ends exactly where it began: no straight jump at a waypoint
      // off the street (Olympic had one of 444 m). If the router can't join those exact spots, the waypoints are used as before.
      const from = k > 1 ? parts[k - 2].to : c.pts[0], to = closes && k === c.pts.length - 1 ? parts[0].from : c.pts[k];
      const o = Object.assign({}, w, { penalty: pen });
      const p = router.route(from, to, o) || router.route(c.pts[k - 1], c.pts[k], o);
      if (!p) { classicCache.set(key, null); return null; }
      if (c.avoidBack) for (const l of p.legs) pen[l.e] = 4;
      parts.push(p);
    }
    const labels = c.pts.slice(1, -1).map((_, k) => (c.sights && c.sights[k + 1] ? { label: c.sights[k + 1][I.lang] || c.sights[k + 1].en, sight: true } : null));
    const r = parts.length === 1 ? parts[0] : router.join(parts, labels);
    let at = 0; r.wayAt = [0, ...parts.map((p) => (at += p.length))];   // where each point of c.pts is along the ride (an out-and-back turns at the middle one)
    classicCache.set(key, r);
    return r;
  }
  const PHOTO_CREDITS = {};
  fetch("../shared/photos/credits.json").then((r) => (r.ok ? r.json() : {})).then((j) => { Object.assign(PHOTO_CREDITS, j); renderClassicCards(); }).catch(() => {});
  const track = $("#classic-track"), dots = $("#classic-dots");
  function renderClassicCards() {
    const L = I.lang;
    track.innerHTML = CLASSICS.map((c, i) => {
      const r = classicCache.get(`${c.id}|${state.winter}`);
      const meta = r ? `${C.fmtKm(r.length)} · ${C.fmtMin(C.rideMinutes(r))} · ${t(c.kind === "outback" ? "kindOutBack" : "kindLoop")} · ${C.fmtPct(r.infraShare)} ${t(state.winter ? "on4s" : "onInfra")}` : "…";
      const cr = PHOTO_CREDITS[c.id];
      return `<article class="classic-card${i === state.classic ? " sel" : ""}" data-i="${i}" tabindex="0" aria-label="${C.esc(c.name[L])}">
        <div class="cc-photo" style="background-image:url('../shared/photos/${c.id}.jpg')">${cr ? `<a class="cc-credit" href="${C.esc(cr.source)}" target="_blank" rel="noopener">${C.esc(t("photoBy", { credit: `${cr.author}, ${cr.license}` }))}</a>` : ""}</div>
        <div class="cc-body"><b class="cc-title">${C.esc(c.name[L])}</b><div class="cc-meta">${meta}</div>
          <p class="cc-blurb">${C.esc(c.blurb[L])}</p><div class="cc-start">${C.esc(t("startAt", { name: c.start[L] }))}</div></div></article>`;
    }).join("");
    dots.innerHTML = CLASSICS.map((_, i) => `<i class="${i === state.classic ? "on" : ""}"></i>`).join("");
    track.querySelectorAll(".classic-card").forEach((el) => el.addEventListener("click", () => {
      const i = +el.dataset.i;
      el.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
      if (i !== state.classic) showClassic(i, true);
    }));
  }
  let classicsRouted = false;
  async function routeAllClassics() {   // fills in the distances on the cards without blocking the page
    for (let i = 0; i < CLASSICS.length; i++) { classicRoute(i); if (i % 3 === 2) await tick(); }
    classicsRouted = true; renderClassicCards();
  }
  function showClassic(i, fit) {
    state.classic = Math.max(0, Math.min(CLASSICS.length - 1, i));
    const c = CLASSICS[state.classic], r = classicRoute(state.classic);
    if (!classicsRouted) routeAllClassics(); else renderClassicCards();
    state.routes = r ? [{ title: { raw: c.name[I.lang] }, r, end: { raw: c.start[I.lang] }, loop: c.kind === "loop", kind: c.kind, classic: true }] : [];
    state.sel = 0;
    renderRoutes(); drawRoutes();
    if (fit && r) fitRoute(r);
    if (r && `classic|${c.id}` !== lastTracked && !touring()) { lastTracked = `classic|${c.id}`; count("classic", { ride: c.id }); }
  }
  let scrollT = null;
  track.addEventListener("scroll", () => {
    clearTimeout(scrollT);
    scrollT = setTimeout(() => {
      if (state.mode === "ride" || !track.clientWidth) return;   // the panel hid (a ride started) before the scroll settled: keep the chosen ride
      const mid = track.scrollLeft + track.clientWidth / 2;
      let best = 0, bd = Infinity;
      track.querySelectorAll(".classic-card").forEach((el, i) => { const d = Math.abs(el.offsetLeft + el.offsetWidth / 2 - mid); if (d < bd) { bd = d; best = i; } });
      if (best !== state.classic) showClassic(best, true);
    }, 140);
  });

  // ------------------------------------------------------------------ route cards and details
  // ------------------------------------------------------------------ the route card's bike-path strip (2026-11-07)
  // The route as stretches you can tap: the stretches without a bike path are the old list's (50 m or more, numbered the same way), the
  // bike-path stretches are what lies between them. A tap opens that stretch's details in the card and shows it on the map.
  function stretches(r) {
    const out = []; let at = 0;
    C.mainGaps(r).forEach((g, k) => {
      if (g.start - at > 1) out.push({ on: true, start: at, length: g.start - at });
      out.push({ on: false, start: g.start, length: g.length, gap: g, num: k + 1 });
      at = g.start + g.length;
    });
    if (r.length - at > 1) out.push({ on: true, start: at, length: r.length - at });
    for (const s of out) s.pieces = r.pieces.filter((p) => p.start < s.start + s.length - 0.5 && p.start + p.length > s.start + 0.5);
    return out;
  }
  const fmtLen = (m) => (m < 1000 ? `${Math.round(m)} m` : C.fmtKm(m));
  function stretchTitle(s) {   // "1419 m on Avenue Willowdale, Avenue Louis-Colin", as the old list said it
    const names = s.gap ? s.gap.names.slice(0, 2) : [];
    if (!s.gap) for (const p of [...s.pieces].filter((q) => q.tier <= 2).sort((a, b) => b.length - a.length)) for (const n of p.names || []) if (n && !names.includes(n) && names.length < 2) names.push(n);
    return t("gapOn", { m: Math.round(s.length), name: names.map(I.place).join(", ") || t("aStreet") });
  }
  function stretchKinds(s) {   // what it is: the kinds of bike path, or busy and quiet streets (busy first), each with its length when there are several
    const LABEL = { 0: "lgProtected", 1: "lgPainted", 2: "lgShared", 3: "quietStreet", 4: "busyStreet" }, by = {};
    for (const p of s.pieces) if ((p.tier <= 2) === s.on && LABEL[p.tier]) by[p.tier] = (by[p.tier] || 0) + Math.min(p.start + p.length, s.start + s.length) - Math.max(p.start, s.start);
    const kinds = Object.entries(by).sort((a, b) => (s.on ? 0 : (b[0] === "4") - (a[0] === "4")) || b[1] - a[1]);
    return kinds.map(([tier, m]) => `${t(LABEL[tier])}${kinds.length > 1 ? ` <span class="num">${fmtLen(m)}</span>` : ""}`).join(" · ");
  }
  function strip(r, list, live, open) {   // live: the chips are buttons (the card in use); otherwise a picture of the route
    const segs = list.map((s, k) => {
      let bg = s.on ? COL.a : COL.gap;
      if (s.pieces.some((p) => (p.tier <= 2) !== s.on)) {   // short crossings inside a stretch show as thin bands of their own colour
        const bands = [];   // neighbours of one colour join, and each band starts where the last ended, so no seam shows between them
        for (const p of s.pieces) {
          const col = p.tier <= 2 ? COL.a : COL.gap, end = Math.min(1, (p.start + p.length - s.start) / s.length) * 100, last = bands[bands.length - 1];
          if (last && last.col === col) last.b = end; else bands.push({ col, a: last ? last.b : 0, b: end });
        }
        bands[bands.length - 1].b = 100;
        bg = `linear-gradient(90deg, ${bands.map((x) => `${x.col} ${x.a.toFixed(2)}% ${x.b.toFixed(2)}%`).join(", ")})`;
      }
      const num = s.num && s.length / r.length > 0.05 ? s.num : "", style = `flex-grow:${Math.round(s.length)};background:${bg}`;
      const cls = `seg${s.on ? "" : " gap"}${open === k ? " on" : open !== null ? " dim" : ""}`;
      return live ? `<button type="button" class="${cls}" data-s="${k}" aria-expanded="${open === k}" aria-label="${C.esc(stretchTitle(s))}" style="${style}">${num}</button>`
        : `<i class="${cls}" style="${style}">${num}</i>`;
    }).join("");
    return `<div class="bar"${live ? ` role="group" aria-label="${t("lgLanes")}"` : ` aria-hidden="true"`}>${segs}</div>`;
  }
  function stretchDetails(s, k, n) {
    const arrow = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
    return `<div class="rc-det-head"><i class="rc-key${s.on ? "" : " off"}"></i><b>${C.esc(stretchTitle(s))}</b>
        <span class="rc-step"><button type="button" class="rc-prev" aria-label="${t("tourBack")}"${k ? "" : " disabled"}>${arrow("M15 5l-7 7 7 7")}</button>${k + 1}/${n}<button type="button" class="rc-next" aria-label="${t("tourNext")}"${k < n - 1 ? "" : " disabled"}>${arrow("M9 5l7 7-7 7")}</button></span></div>
      <div class="rc-det-type${s.on ? "" : " off"}">${s.on ? "" : `${t(state.winter ? "withoutLaneWinter" : "withoutLane")} · `}${stretchKinds(s)}</div>
      <div class="rc-det-at">${t("after", { d: C.fmtKm(s.start) })}</div>`;
  }
  function showStretch(r, s) {   // the stretch on the map (as the old list did on a tap), without moving the sheet
    const pts = C.sliceCoords(r, s.start, s.start + s.length); if (pts.length < 2) return;
    const xs = pts.map((c) => c[0]), ys = pts.map((c) => c[1]);
    const top = 60 + (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--safe-top")) || 0);
    const padding = isPhone() ? { top, bottom: sheetHeight(sheet.state) + 24, left: 24, right: 70 } : { top: 80, bottom: 80, left: 420, right: 90 };
    map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding, maxZoom: 17, duration: 600 });
  }
  // the open stretch, kept while the same route is on screen (a language switch redraws the card with it still open)
  let openStretch = { r: null, k: null };
  function wireStretches(card, r) {
    const list = stretches(r), more = card.querySelector(".rc-more"), det = card.querySelector(".rc-det"), prof = card.querySelector(".rc-profile");
    const show = (k, zoom) => {
      openStretch = { r, k };
      card.querySelectorAll(".bar .seg").forEach((b, j) => { b.classList.toggle("on", j === k); b.classList.toggle("dim", k !== null && j !== k); b.setAttribute("aria-expanded", String(j === k)); });
      const sel = k === null ? null : list[k];
      prof.innerHTML = C.gradeProfileSVG(r, { height: 68, label: t("elevation"), sel });
      if (sel) {
        det.innerHTML = stretchDetails(sel, k, list.length);
        det.style.setProperty("--notch", `${(((sel.start + sel.length / 2) / r.length) * 100).toFixed(1)}%`);
        det.querySelector(".rc-prev").onclick = () => show(k - 1, true);
        det.querySelector(".rc-next").onclick = () => show(k + 1, true);
        if (zoom) showStretch(r, sel);
      }
      more.classList.toggle("open", !!sel);
    };
    card.querySelectorAll(".bar .seg").forEach((b) => b.addEventListener("click", () => { const k = +b.dataset.s; show(openStretch.k === k ? null : k, true); }));
    if (openStretch.r === r && openStretch.k !== null && list[openStretch.k]) show(openStretch.k, false); else openStretch = { r, k: null };
  }
  function placeText(p) { return !p ? "" : p.raw ? I.place(p.raw) : p.poiKind ? C.poiLabel(p.poiKind) : p.key ? t(p.key, p.vars || {}) : ""; }
  function routeTitle(c) {
    if (c.key) return t(c.key);
    const ti = c.title; if (!ti) return "";
    if (ti.raw) return ti.raw;
    if (ti.key === "loopDir") return t("loopDir", { dir: t("dir_" + ti.vars.dirKey) });
    return t(ti.key, { place: placeText(ti.vars.place) });
  }
  function routeNote(c) {
    if (!c.via) return "";
    const stopAt = c.r.stops && c.r.stops[0] && !c.r.stops[0].sight ? t("stopAfter", { d: C.fmtKm(c.r.stops[0].at) }) : "";
    return [stopAt, c.via.length ? t("via", { streets: c.via.map(I.place).join(", ") }) : ""].filter(Boolean).join(" · ");
  }
  // "3 climbs, 95 m total. Steepest climb is 12% over 42 m on Avenue Villeneuve." (climbs: over 7 % and over 10 m, see C.hills)
  function climbLine(r) {
    const h = C.hills(r), m = Math.round(h.total);
    if (!h.list.length) return t("noSteep", { m });
    const s = h.steepest, name = C.climbName(r, s), d = s.length < 1000 ? `${Math.round(s.length)} m` : C.fmtKm(s.length);
    return `${t(h.list.length > 1 ? "climbsN" : "climbs1", { n: h.list.length, m })} ${t(name ? "steepestOn" : "steepest", { g: I.pct(s.grade), d, name: C.esc(I.place(name)) })}`;
  }
  // the route card (2026-11-05, Raph's mix of the two mock-ups; 2026-11-07 with the old "Without a bike path" list inside): title and time;
  // the climbs in one sentence; the elevation coloured by grade; the bike-path strip of tappable stretches; the share on bike paths; a
  // tapped stretch's details. Elevation is told only here. In Suggest a ride the rides not picked are buttons that pick them.
  function routeCard(c, i, pick) {
    const r = c.r, note = routeNote(c), live = !pick || i === state.sel, tag = live ? "div" : "button", list = stretches(r);
    return `<${tag} ${tag === "button" ? `type="button" ` : ""}data-i="${i}" class="route-card${pick && i === state.sel ? " sel" : ""}">
        <div class="rc-top"><b>${C.esc(routeTitle(c))}</b><span class="time">${C.fmtMin(C.rideMinutes(r))}</span></div>
        <div class="rc-sub"><span class="rc-note">${C.esc(note)}</span><span class="rc-km">${C.fmtKm(r.length)}</span></div>
        <div class="rc-climb">${climbLine(r)}</div>
        <div class="rc-profile">${C.gradeProfileSVG(r, { height: live ? 68 : 56, label: t("elevation") })}</div>
        ${strip(r, list, live, null)}
        <div class="rc-under"><div class="rc-pct"><b>${C.fmtPct(r.infraShare)}</b> ${t(state.winter ? "on4s" : "onInfra")}</div>${list.some((s) => !s.on) ? "" : `<div class="rc-whole">${t("lanesWhole")}</div>`}</div>
        ${live ? `<div class="rc-more"><div><div class="rc-det"></div></div></div>` : ""}</${tag}>`;
  }
  function renderRoutes() {
    const box = $("#routes"), det = $("#detail");
    if (!state.routes.length) { box.innerHTML = ""; det.innerHTML = ""; return; }
    const pick = state.routes.length > 1;   // Suggest a ride's three; one card for a route or a classic ride
    box.innerHTML = state.routes.map((c, i) => routeCard(c, i, pick)).join("");
    box.querySelectorAll("button.route-card").forEach((b) => b.addEventListener("click", () => selectRoute(b.dataset.i)));
    const sel = state.routes[state.sel], r = sel.r;
    const live = box.querySelector(`div.route-card[data-i="${state.sel}"]`); if (live) wireStretches(live, r);
    const turns = r.maneuvers.map((m) => `<li>${C.esc(I.maneuver(m))} <span class="turn-at">· ${C.fmtKm(m.at)}</span></li>`).join("");
    const share = canShare() ? `<button type="button" class="share-btn" aria-label="${t("share")}" title="${t("share")}">${SHARE_ICON}</button>` : "";
    const wl = state.wx && state.wxData ? `<p class="wind-note"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9h11a3 3 0 1 0-3-3M3 15h15a3 3 0 1 1-3 3"/></svg>${C.esc(windLine(r))}</p>` : "";
    // share sits next to "Let's ride!" (2026-11-04): beside a heading it read as "share the elevation"
    det.innerHTML = `${wl}
      <details class="turns"><summary>${t("turnByTurn", { n: r.maneuvers.length })}</summary><ol>${turns}</ol></details>
      <div class="ride-row"><button type="button" id="ride-go" class="ride-go">${t("letsRide")}</button>${share}</div>
      ${gpsDefault() ? `<button type="button" id="ride-preview" class="ride-preview">${t("previewRide")}</button>` : ""}`;
    $("#ride-go").onclick = () => rideTap(gpsDefault());
    const shareBtn = det.querySelector(".share-btn"); if (shareBtn) shareBtn.onclick = shareRoute;
    if ($("#ride-preview")) $("#ride-preview").onclick = () => rideTap(false);
  }

  // ------------------------------------------------------------------ comic-print button shadows (2026-11-07)
  // Navy dots behind each main button, shifted down and right, growing toward the bottom-right corner like a printed fade (style.css .ht).
  // Only the band the button leaves uncovered gets dots; redrawn when a button changes size; new buttons are found as they appear.
  const HT_SEL = ".primary, .ride-go, .share-btn, .map-controls .view-btn, .map-controls .round-btn, .map-controls > .ctl-btn, .bar button.seg";
  const htSize = new WeakMap(), htSeen = new WeakSet();
  const htResize = "ResizeObserver" in window ? new ResizeObserver((es) => es.forEach((e) => paintDots(e.target))) : null;
  function paintDots(el) {
    const W = Math.round(el.offsetWidth), H = Math.round(el.offsetHeight), key = W + "x" + H;
    if (!W || !H || htSize.get(el) === key) return;
    htSize.set(el, key);
    const off = parseFloat(getComputedStyle(el).getPropertyValue("--ht-off")) || 5, dots = [];
    for (let y = 1.3, row = 0; y < H; y += 2.6, row++) for (let x = 1.3 + (row % 2) * 1.6; x < W; x += 3.2) {
      if (x < W - off - 3 && y < H - off - 3) continue;   // under the button: never seen
      const k = Math.min(1, Math.max(0, 0.15 + 0.85 * ((x / W) * 0.45 + (y / H) * 0.55)));
      dots.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(0.35 + 1.15 * k * k).toFixed(2)}"/>`);
    }
    el.style.setProperty("--ht", `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" fill="${NAVY}">${dots.join("")}</svg>`)}")`);
  }
  function halftone() {
    document.querySelectorAll(HT_SEL).forEach((el) => {
      if (htSeen.has(el)) return;
      htSeen.add(el); el.classList.add("ht"); el.parentElement.classList.add("ht-host");
      paintDots(el); if (htResize) htResize.observe(el);
    });
  }
  let htQueued = false;
  new MutationObserver(() => { if (!htQueued) { htQueued = true; requestAnimationFrame(() => { htQueued = false; halftone(); }); } }).observe(document.body, { childList: true, subtree: true });
  halftone();

  // ------------------------------------------------------------------ share a route: the system share sheet, or the link on the clipboard
  const SHARE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3.5M8 7l4-4 4 4M8 10.5H6.5A1.5 1.5 0 0 0 5 12v7a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-7a1.5 1.5 0 0 0-1.5-1.5H16"/></svg>';
  const canShare = () => (state.tab === "go" ? !!(state.from && state.to) : state.smode === "classics" && !!state.routes.length);   // not the made-to-order loops
  function shareUrl() {   // this page's own address, without the welcome or notrack options, plus what reopens the route
    const ll = (p) => p.map((v) => +v.toFixed(5)).join(",");
    const route = state.tab === "go" ? `from=${ll(state.from)}&to=${ll(state.to)}` : `classic=${CLASSICS[state.classic].id}`;
    return `${location.origin}${location.pathname}?${route}${state.winter ? "&winter=1" : ""}`;
  }
  async function shareRoute() {
    const url = shareUrl();
    try { await navigator.share({ title: "Piste", url }); return; }
    catch (e) { if (e.name === "AbortError") return; }   // the person closed the sheet; anything else (no Web Share): copy the link instead
    try { await navigator.clipboard.writeText(url); toast(t("linkCopied")); }
    catch (e) { console.warn("link not copied", e); toast(t("linkCopyFail")); }
  }

  // ------------------------------------------------------------------ layers panel & modes
  const layerBtn = $("#layers-btn"), layersBox = $("#layers");
  function openLayers(open) { layersBox.hidden = !open; layerBtn.setAttribute("aria-expanded", String(open)); }
  layerBtn.onclick = () => openLayers(layersBox.hidden);
  // a tap anywhere outside the panel closes it (and doesn't also drop a pin on the map)
  document.addEventListener("pointerdown", (e) => {
    if (layersBox.hidden || layersBox.contains(e.target) || layerBtn.contains(e.target)) return;
    openLayers(false);
    if (map.getCanvas().contains(e.target)) { layersJustClosed = true; setTimeout(() => (layersJustClosed = false), 500); }
  }, true);
  const toggles = {};
  // "Trees in 3D" (2026-11-03): on unless the rider turned it off, kept in localStorage "piste-trees"
  const treesBox = document.querySelector('#layers input[data-layer="trees"]');
  treesBox.checked = store.get("trees", "1") !== "0";
  treesBox.addEventListener("change", () => store.set("trees", treesBox.checked ? "1" : "0"));
  document.querySelectorAll("#layers input[data-layer]").forEach((cb) => { toggles[cb.dataset.layer] = cb.checked; cb.addEventListener("change", () => { toggles[cb.dataset.layer] = cb.checked; applyLayers(); }); });
  function vis(id, on) { if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none"); }
  function setTerrain(on) {
    if (on === state.terrainOn) return;   // re-creating terrain is costly: only on a real change
    state.terrainOn = on;
    map.setTerrain(on ? { source: "terrain", exaggeration: CAM.terrain } : null);
  }
  // 3D trees: the WebGL layer (added the first time it is needed, under the bike paths), or the flat pictures as the fallback
  function showTrees(on) {
    if (on && state.treesGL && !map.getLayer("trees-gl")) {
      try { map.addLayer(treeLayer, "net-casing"); } catch (e) { treesFallback(e.message); }
    }
    vis("trees-gl", on && state.treesGL); vis("trees-src", on && state.treesGL); vis("trees", on && !state.treesGL);
  }
  function showEdges(on) {   // above the 3D buildings, added the first time they are needed
    if (!edgeLayer || edgeLayer.error) return;
    if (on && !map.getLayer("edges-gl")) map.addLayer(edgeLayer, "net-casing");
    vis("edges-gl", on);
  }
  function poiOn(p) {   // parks and viewpoints are always on
    if (p.group === "outdoors" && p.kind !== "culture") return true;
    if (p.group === "transit") return toggles[p.kind];   // metro, REM
    if (p.kind === "culture") return toggles.culture;
    if (p.group === "food") return toggles["pois-food"];
    if (p.group === "shopping") return toggles["pois-shop"];
    return toggles["pois-bike"];   // BIXI, water, repair, parking, toilets
  }
  function applyLayers() {
    const browse = state.mode === "explore", riding = state.mode === "ride";
    ["net-casing", "net-ab", "net-c"].forEach((id) => vis(id, toggles.network));
    ["rem-casing", "rem-line"].forEach((id) => vis(id, toggles.rem));
    vis("net-not-cleared", toggles.network && state.winter);
    if (map.getLayer("net-ab")) map.setPaintProperty("net-ab", "line-opacity", browse ? 0.6 : 0.35);
    ["planned", "construction", "construction-tape"].forEach((id) => vis(id, toggles.planned && browse && !state.winter));
    vis("closed", toggles.works);
    // while riding, roadside pop-ups replace the map's POI icons (only metro stations stay)
    const liveBixi = !!state.bixi;
    POI_LAYERS.forEach((p) => vis(p.id, riding ? p.group === "transit" && toggles[p.kind] : poiOn(p) && !(p.kind === "bixi" && liveBixi)));
    // 2026-11-01: no place names on the map while riding (they showed up behind the turn card); the icons stay, a tap on one still names it
    POI_LAYERS.forEach((p) => { if (map.getLayer(p.id)) map.setPaintProperty(p.id, "text-opacity", riding ? 0 : 1); });
    vis("bixi-live", liveBixi && toggles["pois-bike"] && !riding); vis("bixi-count", liveBixi && toggles["pois-bike"] && !riding);
    document.body.classList.toggle("riding", riding);
    vis("tint", toggles.tint); vis("relief", toggles.relief);
    ["contours-detail", "contours-minor", "contours-index", "contour-labels"].forEach((id) => vis(id, toggles.contours));
    ["bld-shadow", "bld-flat", "bld-line"].forEach((id) => vis(id, toggles.buildings && !state.is3d)); vis("bld-3d", toggles.buildings && state.is3d);
    showTrees(toggles.trees && state.is3d);
    showEdges(toggles.buildings && state.is3d);
    setTerrain(toggles.terrain && state.is3d);
    // with a route on screen, keep only the POIs and works along it (plus metro and REM stations) to cut clutter
    const sel = state.routes[state.sel];
    if (sel && !browse) {
      const cur = C.buildCursor(sel.r);
      const near = window.PLANNED.features.filter((f) => f.properties.status === "works" && cur.locate(f.geometry.coordinates[0], f.geometry.coordinates[1]).d < 150);
      map.getSource("works-near").setData({ type: "FeatureCollection", features: near });
    }
    vis("works", toggles.works && browse); vis("works-near", toggles.works && !browse);
    const ids = sel && !browse ? C.routePOIs(sel.r, window.POIS, 90).map((p) => p.i) : null;
    POI_LAYERS.forEach((p) => {
      const base = ["==", ["get", "k"], p.kind];
      map.setFilter(p.id, ids && p.group !== "transit" ? ["all", base, ["in", ["id"], ["literal", ids]]] : base);
    });
    if (liveBixi) {
      let f = null;
      if (sel && !browse) {
        const cur = C.buildCursor(sel.r), xs = sel.r.coords.map((c) => c[0]), ys = sel.r.coords.map((c) => c[1]);
        const w = Math.min(...xs) - 0.002, e = Math.max(...xs) + 0.002, s = Math.min(...ys) - 0.0015, n = Math.max(...ys) + 0.0015;
        const near = state.bixi.features.filter((ft) => { const [x, y] = ft.geometry.coordinates; return x > w && x < e && y > s && y < n && cur.locate(x, y).d < 120; }).map((ft) => ft.id);
        f = ["in", ["id"], ["literal", near]];
      }
      map.setFilter("bixi-live", f); map.setFilter("bixi-count", f);
    }
  }
  function setMode(m) { state.mode = m; applyLayers(); }

  // 2D / 3D: the button shows the view you switch to (cube + "3D" while flat, square + "2D" while in 3D)
  const viewBtn = $("#view-btn");
  function set3d(on, animate = true) {
    state.is3d = on;
    viewBtn.classList.toggle("is3d", on); $("#ride-view").classList.toggle("is3d", on);
    $("#view-label").textContent = on ? "2D" : "3D";
    viewBtn.dataset.i18nTitle = on ? "to2d" : "to3d"; viewBtn.title = t(viewBtn.dataset.i18nTitle); viewBtn.setAttribute("aria-label", viewBtn.title);
    map.setVerticalFieldOfView(on ? CAM.browse3d.fov : 36.87);
    applyLayers();
    if (state.mode !== "ride" && animate) map.easeTo({ pitch: on ? CAM.browse3d.pitch : 0, bearing: on ? CAM.browse3d.bearing : 0, zoom: Math.max(map.getZoom(), on ? 15.2 : map.getZoom()), duration: 900 });
  }
  viewBtn.onclick = () => set3d(!state.is3d);
  $("#wx-btn").onclick = () => setWeather(!state.wx);
  $("#winter-btn").onclick = () => setWinter(!state.winter);

  // ------------------------------------------------------------------ language
  function setLang(l) {
    if (l !== I.lang) count("language", { lang: l });
    I.lang = l; I.save(); I.apply(); syncFieldLabels();
    $("#lang-btn").textContent = l === "fr" ? "EN" : "FR";
    viewBtn.title = t(viewBtn.dataset.i18nTitle || "to3d");
    strictOut.textContent = strictLabel(+strict.value); kmLabel(); renderStopChips();
    classicCache.clear(); classicsRouted = false;   // sight names are part of the route
    if (state.tab === "suggest" && state.smode === "classics") showClassic(state.classic, false); else renderClassicCards();
    if (state.from) fromEl.value = state.fromLabel; if (state.to) toEl.value = state.toLabel;
    setMapTexts(); renderRoutes(); refreshList(); renderWxCard(); renderSound(); buildElevationLegend(); renderSummary(); if (state.mode === "ride") updateWindBadge(true);
    if (!state.ride) $("#ride-pause").textContent = t("pause");
    if (state.gpsState) gpsStatus(state.gpsState);
    document.dispatchEvent(new Event("piste:lang"));   // tour.js redraws its text
  }
  $("#lang-btn").onclick = () => setLang(I.lang === "fr" ? "en" : "fr");
  $("#lang-btn").textContent = I.lang === "fr" ? "EN" : "FR";

  // ------------------------------------------------------------------ bottom panel on phones: drag it up (full) or down (map)
  const panel = $("#panel"), sheet = { state: "half" };
  function sheetHeight(s) {
    const H = innerHeight, top = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--safe-top")) || 0;
    return { peek: 150, half: Math.round(H * 0.5), full: H - top - 8 }[s];
  }
  function setSheet(s, animate = true) {
    sheet.state = s; panel.dataset.sheet = s;
    if (!isPhone()) { panel.style.height = ""; syncSheetTall(); return; }
    panel.classList.toggle("dragging", !animate);
    panel.style.height = sheetHeight(s) + "px";
    syncSheetTall();
  }
  // The sheet up over the whole map (judged from the height it is set to, so at once and not frame by frame as it animates):
  // the map buttons and the map credits step aside, so nothing floats over the card's header.
  function syncSheetTall() { document.body.classList.toggle("sheet-tall", isPhone() && (parseFloat(panel.style.height) || 0) > innerHeight - 150); }
  (function dragSheet() {
    let y0 = 0, h0 = 0, lastY = 0, lastT = 0, vy = 0, moved = false, active = false;
    const zone = [$("#grabber"), $("#brand")];
    const down = (e) => {
      if (!isPhone() || search.which || e.target.closest("button")) return;
      active = true; moved = false; y0 = lastY = e.clientY; lastT = performance.now(); h0 = panel.getBoundingClientRect().height; vy = 0;
      panel.classList.add("dragging"); e.currentTarget.setPointerCapture(e.pointerId);
    };
    const move = (e) => {
      if (!active) return;
      const now = performance.now(); vy = (e.clientY - lastY) / Math.max(1, now - lastT); lastY = e.clientY; lastT = now;
      if (Math.abs(e.clientY - y0) > 4) moved = true;
      panel.style.height = Math.max(sheetHeight("peek") - 40, Math.min(sheetHeight("full"), h0 + (y0 - e.clientY))) + "px";
    };
    const up = () => {
      if (!active) return; active = false; panel.classList.remove("dragging");
      const order = ["peek", "half", "full"];
      if (!moved) { setSheet(order[(order.indexOf(sheet.state) + 1) % 3]); return; }   // a tap steps through the sizes
      const h = panel.getBoundingClientRect().height;
      let i = order.reduce((b, s, k) => (Math.abs(sheetHeight(s) - h) < Math.abs(sheetHeight(order[b]) - h) ? k : b), 0);
      if (vy < -0.5) i = Math.min(2, Math.max(i, order.indexOf(sheet.state) + 1));   // a quick flick moves one step
      if (vy > 0.5) i = Math.max(0, Math.min(i, order.indexOf(sheet.state) - 1));
      setSheet(order[i]);
    };
    for (const z of zone) { z.addEventListener("pointerdown", down); z.addEventListener("pointermove", move); z.addEventListener("pointerup", up); z.addEventListener("pointercancel", up); }
    $("#grabber").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSheet({ peek: "half", half: "full", full: "peek" }[sheet.state]); } });
    addEventListener("resize", () => { if (search.which) dock(false); else setSheet(sheet.state, false); });
  })();
  setSheet("half", false);
  if ("ResizeObserver" in window) {   // the credits ("i") ride just above the sheet on phones
    new ResizeObserver(() => {
      document.documentElement.style.setProperty("--sheet-h", panel.offsetHeight + "px");
      syncSheetTall();
    }).observe(panel);
  }

  // ------------------------------------------------------------------ ride (simulation)
  // Audio and the rider's music (2026-11-01): the chime and the voice are short sounds, so each runs inside an audio session marked
  // "transient" (C.audioSession) and the Web Audio context is suspended as soon as the chime is over. Nothing loops or stays open
  // for the whole ride; the screen wake lock (keepAwake) is separate and has no sound. If chimes ever stop on the iPhone after the
  // first one, set SUSPEND_IDLE_AUDIO to false (the context then stays open between sounds).
  const SUSPEND_IDLE_AUDIO = true;
  let audio = null, audioSid = 0, audioIdleT = 0;
  function releaseAudio() {   // the sound is over: give the audio session back, and stop the context so it holds nothing
    clearTimeout(audioIdleT); C.audioSession.end(audioSid);
    if (SUSPEND_IDLE_AUDIO && audio && audio.state === "running") audio.suspend().catch((e) => console.warn("audio suspend", e));
  }
  // iPhone Safari keeps sound and speech silent unless they start from a tap: unlock both inside "Let's ride!" (and the sound button)
  function unlockAudio() {
    try {
      audio = audio || new AudioContext();
      audioSid = C.audioSession.begin(1500);
      if (audio.state === "suspended") audio.resume().catch((e) => console.warn("audio resume", e));
      const s = audio.createBufferSource(); s.buffer = audio.createBuffer(1, 1, 22050); s.connect(audio.destination); s.start(0);
      clearTimeout(audioIdleT); audioIdleT = setTimeout(releaseAudio, 250);
    } catch (e) { console.warn("audio unlock", e); }
  }
  function chime() {
    if (state.sound === "off") return;
    try {
      audio = audio || new AudioContext();
      const sid = audioSid = C.audioSession.begin(2500);
      const play = () => {
        [660, 880].forEach((f, i) => {
          const o = audio.createOscillator(), g = audio.createGain(); o.type = "sine"; o.frequency.value = f;
          const t2 = audio.currentTime + i * 0.16; g.gain.setValueAtTime(0, t2); g.gain.linearRampToValueAtTime(0.4, t2 + 0.02);   // 0.4: audible over music in headphones (0.09 was lost, 2026-11-01 ride) g.gain.exponentialRampToValueAtTime(0.001, t2 + 0.3);
          o.connect(g).connect(audio.destination); o.start(t2); o.stop(t2 + 0.32);
        });
        clearTimeout(audioIdleT); audioIdleT = setTimeout(releaseAudio, 800);   // the two tones last half a second
      };
      if (audio.state === "running") play();
      else audio.resume().then(play, (e) => { console.warn("chime: audio could not start", e); C.audioSession.end(sid); });
    } catch (e) { console.warn("chime", e); }
  }
  const SOUND_ICON = {
    chime: '<svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0"/></svg>',
    voice: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/></svg>',
    off: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9zM16.5 9.5l5 5M21.5 9.5l-5 5"/></svg>',
  };
  function renderSound() {
    const b = $("#ride-sound"); b.innerHTML = SOUND_ICON[state.sound];
    b.title = t({ chime: "soundChime", voice: "soundVoice", off: "soundOff" }[state.sound]); b.setAttribute("aria-label", b.title);
    C.voice.enabled = state.sound === "voice";
  }
  $("#ride-sound").onclick = () => {
    state.sound = { chime: "voice", voice: "off", off: "chime" }[state.sound]; store.set("sound", state.sound); renderSound();
    if (state.sound === "voice") C.voice.prime(); else if (state.sound === "chime") unlockAudio();   // a tap: iPhone allows sound from here on
  };
  renderSound();

  const TURN_SVG = {
    straight: '<path d="M23 38V10M14 19l9-9 9 9"/>', left: '<path d="M30 38V22a6 6 0 0 0-6-6H12M19 9l-7 7 7 7"/>',
    right: '<path d="M16 38V22a6 6 0 0 1 6-6h12M27 9l7 7-7 7"/>', slightL: '<path d="M28 38V24L16 12M16 21v-9h9"/>',
    slightR: '<path d="M18 38V24l12-12M30 21v-9h-9"/>', arrive: '<path d="M14 38V8M14 9h17l-4 6 4 6H14"/>',
  };
  const turnIcon = (m) => ({ stop: "arrive", sight: "arrive", left: "left", sharpL: "left", right: "right", sharpR: "right", slightL: "slightL", slightR: "slightR" }[m.kind] || "straight");

  // you: a heading cone lying on the street + an upright pin facing the camera
  const coneEl = document.createElement("div"); coneEl.className = "rider-cone";
  coneEl.innerHTML = '<svg viewBox="0 0 120 120"><defs><radialGradient id="cg" cx="50%" cy="100%" r="90%"><stop offset="0" stop-color="#1e2160" stop-opacity=".5"/><stop offset="1" stop-color="#1e2160" stop-opacity="0"/></radialGradient></defs><path d="M60 64 28 6h64z" fill="url(#cg)"/><circle cx="60" cy="64" r="13" fill="#1e2160" stroke="#fff" stroke-width="5"/></svg>';
  const riderMarker = new maplibregl.Marker({ element: coneEl, rotationAlignment: "map", pitchAlignment: "map", ...MARKER_SHOW });
  const badgeEl = document.createElement("div"); badgeEl.className = "rider-badge";
  badgeEl.innerHTML = PIN.from;   // the same plain blue pin as the start (2026-11-03: it had a bike in it)
  const badgeMarker = new maplibregl.Marker({ element: badgeEl, anchor: "bottom", pitchAlignment: "viewport", rotationAlignment: "viewport", ...MARKER_SHOW });
  const poiMarkers = new Map();
  let smoothBearing = 0, afterGapUntil = 0, lastGapId = null, sparkAt = -1e9;

  // keep the rider low on the screen so you see more of what's ahead
  function setRidePadding() {
    const H = map.getContainer().clientHeight;
    const at = state.rideView === "birdseye" ? CAM.bird.riderAt : CAM.top.riderAt;
    map.setPadding({ top: Math.round(Math.max(0, (2 * at - 1) * H)), bottom: 0, left: 0, right: 0 });
  }
  addEventListener("resize", () => { if (state.mode === "ride") setRidePadding(); });

  // "Let's ride!" and "Preview the ride": this runs inside the tap, so iPhone lets the chime and the voice play later
  function rideTap(gps) {
    unlockAudio();
    if (state.sound === "voice") C.voice.prime();
    if (gps) startGpsRide(); else startRide();
    const r = state.routes[state.sel];
    count("ride", { kind: gps ? "gps" : "preview", km: r ? Math.round(r.r.length / 1000) : 0, winter: state.winter });
  }
  // the ride starts straight away (bird's-eye 3D); sound is a button in the ride bar. Shared by the GPS ride and the preview.
  function prepareRide(view, gps) {
    const sel = state.routes[state.sel]; if (!sel) return null;
    const r = sel.r;
    hideNotice(); hideSummary(); windBadge.at = -1e9; $("#wind-badge").hidden = true; rideWeather(true);
    state.rideEnd = placeText(sel.end) || state.toLabel || t("destination");
    state.rideView = view;
    $("#panel").hidden = true; $("#legend").hidden = true; document.querySelector(".map-controls").hidden = true;
    $("#ride-hud").hidden = false; setMode("ride"); renderWxCard(); wind.show(false);
    set3d(state.rideView === "birdseye", false);
    setRidePadding();
    riderMarker.setLngLat(r.coords[0]).addTo(map); badgeMarker.setLngLat(r.coords[0]).addTo(map);
    Object.values(markers).forEach((m) => (m.getElement().style.display = "none"));
    smoothBearing = map.getBearing(); state.hillK = 0; sparkAt = -1e9;
    // the preview has a speed and a pause button; a GPS ride shows your speed and the GPS instead
    $("#ride-speed").hidden = gps; $("#ride-pause").hidden = gps; $("#ride-gps").hidden = !gps;
    state.follow = true; state.holding = false; glide = null; $("#ride-recenter").hidden = true; showRider(true);
    state.reroutes = 0; state.rerouteLog = []; state.rerouteFailAt = -1e9; state.join = null;
    return sel;
  }
  function startRide(view = "birdseye") {   // the preview: a simulated ride at 4× speed
    const sel = prepareRide(view, false); if (!sel) return;
    const r = sel.r;
    $("#ride-pause").textContent = t("pause"); $("#ride-speed").textContent = "4×";
    const pois = C.routePOIs(r, window.POIS, 70);
    state.ride = new C.RideSim(r, { mult: 4, pois, onFrame: rideFrame, onEvent: rideEvent });
    state.ride.start();
  }

  // ------------------------------------------------------------------ GPS ride
  // The phone's location moves you along the route (common.js RideGPS); the cards, voice and roadside places work as in the preview.
  // opts.replay: a pretend GPS ride ({ speedup, startAt, detourAt, straight, from }) for tests; ?gps=replay&gpsx=&gpsat=&detour=[&straight]
  // [&gpsfrom=lon,lat] does the same (straight: at `detour` the rider leaves the route and keeps riding straight on, whatever the app does;
  // gpsfrom: the rider starts there, away from the route, as for a classic ride's lead-in).
  function startGpsRide(opts = {}) {
    let geo = navigator.geolocation || null;
    const rp = opts.replay || (gpsParam === "replay" ? { speedup: +params.get("gpsx") || 1, startAt: +params.get("gpsat") || 0,
      detourAt: params.has("detour") ? +params.get("detour") : null, straight: params.has("straight"), deny: params.has("gpsdeny"), from: lonlat(params.get("gpsfrom")) } : null);
    if (rp) geo = new C.ReplayGeo(Object.assign({ getRoute: () => state.ride && state.ride.route }, rp));
    if (!geo) { showNotice("gpsUnavailable"); return; }
    const sel = prepareRide("birdseye", true); if (!sel) return;
    const r = sel.r;
    // a reroute uses the same settings as this route: to the destination (Go somewhere),
    // or back onto the planned ride a little ahead (suggested and classic rides, which may loop or have stops)
    // `plan`: a reroute to the destination is planned like the route itself, detour cap included (settings kept as they were now)
    const plan = state.tab === "go" && state.to && !sel.classic ? { kind: sel.key || "yourRoute", settings: planSettings() } : null;
    state.rideOpts = { w: selWeights(sel), dest: state.tab === "go" && state.to ? state.to : null, rejoin: state.tab !== "go", plan };
    gpsStatus({ state: "wait" });
    state.ride = new C.RideGPS(r, { geo, pois: C.routePOIs(r, window.POIS, 70), onFrame: rideFrame, onEvent: rideEvent,
      onStatus: gpsStatus, onOffRoute: rerouteFrom, onError: gpsError, onFirstFix: sel.classic ? (fix) => joinClassic(sel, fix) : null });
    keepAwake(true);
    state.ride.start();
  }

  // A classic ride starts where you are (2026-11-03; C.planJoin has the rules and the numbers): at the first good fix, on the loop it
  // starts from the nearest point of it; elsewhere a lead-in on the most bike paths (the classic's own router settings) leads to the
  // best join point, then the whole loop. The preview, a refused location and a ride still waiting for GPS start at the usual start.
  // state.join keeps what was decided (and the notices given), for the reroutes during the lead-in and for the tests.
  const outbackTurn = (r) => r.wayAt[Math.floor((r.wayAt.length - 1) / 2)];
  function joinClassic(sel, fix) {
    let j;
    try { j = C.planJoin(router, sel.r, [fix.lon, fix.lat], { w: selWeights(sel), ends: sel.kind === "outback" ? [0, outbackTurn(sel.r)] : null }); }
    catch (e) { console.warn("classic ride: could not plan a start from here, riding from the usual start", e); return; }
    state.join = { kind: j.kind, ms: j.ms, routed: j.routed, cands: j.cands, join: j.join, joinAt: j.joinAt, lead: null, at: 0, reachAt: 0,
      loop: j.loop || null, target: j.target || null, outback: sel.kind === "outback", reached: j.kind !== "lead", notices: [] };
    if (!j.route) return;   // "start" (you are at the usual start) or "none" (no lead-in from here): the ride as planned
    if (j.lead) setLeadIn(j.lead, j.route);
    state.ride.setRoute(j.route, C.routePOIs(j.route, window.POIS, 70));
    if (j.joinAt > 0) state.rideEnd = placeLabel(j.join[0], j.join[1]);   // the ride ends where it joined the loop
    map.getSource("route").setData(rideRouteData(j.route));
    map.getSource("stops").setData(stopsData(j.route));
    map.getSource("ends").setData({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: j.join }, properties: { k: "from" } }] });
    if (j.lead) rideNotice(state.join.outback ? "leadInRide" : "leadInLoop", { d: C.fmtKm(j.at) });
  }
  // the lead-in now ridden (at the start, or after a reroute on it), and where along the whole ride it reaches the loop: found on
  // the ride's own track, which RideGPS measures you on (the route's distances and its shape can differ by a few metres per km)
  function setLeadIn(lead, route) {
    const J = state.join;
    J.lead = lead; J.at = lead.length;
    J.reachAt = C.makeTrack(route).locate(J.join[0], J.join[1], -Infinity, lead.length + 1000).along;
  }
  // a classic's lead-in reached: the chime and "You're on the loop", once (from rideFrame)
  function checkJoined(d) {
    const J = state.join;
    if (!J || J.reached || d < J.reachAt - 10) return;   // 10 m: about the GPS noise around the join point
    J.reached = true;
    rideNotice(J.outback ? "onRide" : "onLoop", { d: C.fmtKm(J.loop.length) }, true);
  }
  // still on a classic's lead-in and off it: a new lead-in to the same join point (heading-aware, like any reroute)
  function leadInFrom(from, ro, heading) { return router.route(from, state.join.target, withHeading(ro.w, heading)); }
  // one spoken and shown notice during a ride (with the chime for the ones that need your attention)
  function rideNotice(key, vars, withChime = false) {
    const text = t(key, vars);
    if (withChime) chime();
    C.voice.say(text); toast(text);
    if (state.join) state.join.notices.push({ key, text, chime: withChime, d: state.ride ? Math.round(state.ride.d) : 0 });
  }
  // the route being ridden, for the map; a classic's lead-in still to ride is drawn in dots (layer route-lead), the loop as usual
  function rideRouteData(route) {
    const J = state.join;
    if (!J || J.reached || !J.lead) return C.routePiecesGeoJSON(route);
    const part = (r, isLead) => C.routePiecesGeoJSON(r).features.map((f) => Object.assign(f, { properties: Object.assign(f.properties, { lead: isLead }) }));
    const features = part(J.lead, 1).concat(part(J.loop, 0));
    features.forEach((f, i) => (f.id = i));
    return { type: "FeatureCollection", features };
  }
  function gpsStatus(s) {
    const el = $("#ride-gps"); state.gpsState = s;
    el.classList.toggle("waiting", s.state === "wait"); el.classList.toggle("off", s.state === "off");
    if (s.state === "wait") { $("#gps-main").textContent = t("gpsWaiting"); $("#gps-sub").textContent = ""; return; }
    $("#gps-main").textContent = t("kmh", { v: Math.round(s.kmh || 0) });
    $("#gps-sub").textContent = s.state === "off" ? t("offRoute") : t("gpsAcc", { m: Math.round(s.acc) });
  }
  function gpsError(e) {   // location refused (or no location at all): back to the route, with the preview on offer
    endRide();
    showNotice(e && e.code === 1 ? "gpsDenied" : "gpsUnavailable");
  }
  function showNotice(key, preview = true) {
    const p = $("#notice-text"); p.dataset.i18n = key; p.textContent = t(key);
    $("#notice-preview").hidden = !preview; $("#notice").hidden = false;
  }
  function hideNotice() { $("#notice").hidden = true; }
  $("#notice-ok").onclick = hideNotice;
  $("#notice-preview").onclick = () => { hideNotice(); rideTap(false); };

  // off route for a while: a new route from where you are, with the same settings, then carry on along it
  // `heading`: the direction you are riding in degrees (null when unclear). The new route does not start by turning you round
  // unless that is clearly shorter (router.js, opts.heading). A reroute is never planned twice in a row: RideGPS waits
  // GPS.REROUTE_MS between two, and the new route starts where you are, so you are on it at once.
  const withHeading = (opts, heading) => (Number.isFinite(heading) ? Object.assign({}, opts, { heading }) : opts);
  function newRouteFrom(from, ride, ro, heading) {
    const cur = ride.route;
    if (ro.rejoin) {
      const w = withHeading(ro.w, heading), D = ride.d + 250;
      if (D < cur.length - 100) {
        const p = ride.cursor.at(D), a = router.route(from, [p.lon, p.lat], w);
        if (a) return C.joinRoutes(a, C.tailRoute(cur, D));
      }
      return router.route(from, cur.coords[cur.coords.length - 1], w);
    }
    const to = ro.dest || cur.coords[cur.coords.length - 1];
    return ro.plan ? router.planRoute(from, to, ro.plan.kind, withHeading(ro.plan.settings, heading)) : router.route(from, to, withHeading(ro.w, heading));
  }
  function rerouteFrom(p) {
    const ride = state.ride, ro = state.rideOpts; if (!ride || !ro) return false;
    const t1 = performance.now();
    let nr = null, lead = null;
    const J = state.join, leadIn = !!J && !J.reached;   // on a classic's lead-in: to the join point, then the whole loop
    try {
      if (leadIn) { lead = leadInFrom([p.lon, p.lat], ro, p.heading); nr = lead && C.joinRoutes(lead, J.loop); }
      else nr = newRouteFrom([p.lon, p.lat], ride, ro, p.heading);
    } catch (e) { console.warn("reroute failed", e); }
    const turn = nr && nr.maneuvers.find((m) => m.at > 3);   // what the card will show first: the next instruction, in metres
    state.rerouteLog.push({ at: [p.lon, p.lat], d: ride.d, ok: !!nr, ms: +(performance.now() - t1).toFixed(1), wall: Math.round(t1), heading: Number.isFinite(p.heading) ? Math.round(p.heading) : null,
      start: nr && nr.coords[0], length: nr && Math.round(nr.length), nextTurnM: turn ? Math.round(turn.at) : null, turnAt: turn ? [turn.lon, turn.lat] : null, coords: nr ? nr.coords.slice(0, 60) : null, leadIn });
    if (!nr || nr.length < 1) {   // keep the old route, and say so (once a minute at most)
      if (performance.now() - state.rerouteFailAt > 60000) { toast(t("rerouteFailed")); chime(); C.voice.say(t("rerouteFailedVoice")); }
      state.rerouteFailAt = performance.now();
      return false;
    }
    state.reroutes++;
    if (leadIn) setLeadIn(lead, nr);
    for (const mk of poiMarkers.values()) mk.remove();
    poiMarkers.clear(); afterGapUntil = 0; lastGapId = null; sparkAt = -1e9;
    ride.setRoute(nr, C.routePOIs(nr, window.POIS, 70));
    map.getSource("route").setData(rideRouteData(nr));
    map.getSource("route-alts").setData(empty);
    map.getSource("stops").setData(stopsData(nr));
    chime(); C.voice.say(t("rerouting")); toast(t("rerouted"));
    return true;
  }

  // keep the screen on during a GPS ride (Screen Wake Lock); it is released when the page hides, so ask again when it's back
  let wakeLock = null;
  async function keepAwake(on) {
    if (!on) { const w = wakeLock; wakeLock = null; state.wake = "off"; if (w) { try { await w.release(); } catch (e) { /* gone */ } } return; }
    if (!("wakeLock" in navigator)) { state.wake = "unsupported"; return; }
    if (wakeLock || document.visibilityState !== "visible") return;
    try {
      const w = await navigator.wakeLock.request("screen");
      if (!state.ride || !state.ride.gps) { w.release(); return; }   // the ride ended meanwhile
      wakeLock = w; state.wake = "on";
      w.addEventListener("release", () => { if (wakeLock === w) { wakeLock = null; state.wake = "released"; } });
    } catch (e) { state.wake = "refused"; }   // unsupported or refused: carry on
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !state.ride || !state.ride.gps) return;
    keepAwake(true); state.ride.wake();   // pick up again from the next fix
  });

  // move the map by hand during a GPS ride: it stops following you until you tap "Re-center"
  let glide = null;
  function setFollow(on) {
    state.follow = on; $("#ride-recenter").hidden = on;
    if (on) {
      glide = { t0: performance.now(), c: map.getCenter(), z: map.getZoom(), p: map.getPitch(), b: map.getBearing() };   // ease back to the rider
      if (state.ride && state.ride.kick) state.ride.kick();
    }
  }
  // jumpTo() every frame would cancel a gesture as it starts, so the camera holds still while a finger (or the mouse) is down on the map;
  // a real move (or a second finger, or the mouse wheel) stops following, a plain tap doesn't
  const gpsRiding = () => state.mode === "ride" && !!state.ride && !!state.ride.gps;
  let press = null;
  map.getCanvasContainer().addEventListener("pointerdown", (e) => {
    if (!gpsRiding()) return;
    press = { x: e.clientX, y: e.clientY, n: (press ? press.n : 0) + 1 }; state.holding = true;
  }, true);
  addEventListener("pointermove", (e) => {
    if (press && state.follow && (press.n > 1 || Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6)) setFollow(false);
  }, true);
  for (const ev of ["pointerup", "pointercancel"]) addEventListener(ev, () => { press = null; state.holding = false; }, true);
  map.getCanvasContainer().addEventListener("wheel", () => { if (gpsRiding() && state.follow) setFollow(false); }, { capture: true, passive: true });
  for (const ev of ["dragstart", "zoomstart", "rotatestart", "pitchstart"]) {
    map.on(ev, (e) => { if (e.originalEvent && gpsRiding() && state.follow) setFollow(false); });
  }
  $("#ride-recenter").onclick = () => setFollow(true);
  let riderShown = true;
  function showRider(on) {   // hidden until the first good GPS fix
    if (on === riderShown) return;
    riderShown = on; coneEl.style.visibility = badgeEl.style.visibility = on ? "" : "hidden";
  }
  function lerpAngle(a, b, k) { const d = ((b - a + 540) % 360) - 180; return a + d * k; }
  const smoothstep = (x) => { const v = Math.max(0, Math.min(1, x)); return v * v * (3 - 2 * v); };

  // 0..1: how much "hill ahead" to show. Builds from 520 m before a climb, full on it, fades just after the top.
  function hillFactor(d, list) {
    let k = 0;
    for (const c of list) {
      const end = c.start + c.length, ahead = c.start - d;
      let v = 0;
      if (ahead > 0 && ahead < 520) v = smoothstep((520 - ahead) / 360);
      else if (ahead <= 0 && d < end) v = 1;
      else if (d >= end && d - end < 90) v = 1 - (d - end) / 90;
      k = Math.max(k, v * Math.min(1, Math.max(0.45, (c.grade - 0.015) / 0.045)));
    }
    return k;
  }
  function rideFrame(f) {
    const r = state.ride.route, climbList = state.ride.extras.climbs;
    const bird = state.rideView === "birdseye";
    const target = hillFactor(f.d, climbList);
    if (state.snap || f.snap) { state.hillK = target; smoothBearing = f.pos.heading; state.snap = false; }
    else { state.hillK += (target - state.hillK) * 0.05; smoothBearing = lerpAngle(smoothBearing, f.pos.heading, 0.12); }
    const k = bird ? state.hillK : 0;
    if (map.terrain) {
      const ex = CAM.terrain + k * CAM.hill.boost;
      if (Math.abs(map.terrain.exaggeration - ex) > 0.004) map.terrain.exaggeration = ex;
    }
    const cam = bird ? CAM.bird : CAM.top;
    const view = { center: [f.pos.lon, f.pos.lat], bearing: smoothBearing, pitch: cam.pitch + k * CAM.hill.pitch, zoom: cam.zoom + k * CAM.hill.zoom };
    if (glide) {   // "Re-center": ease from where you left the map to the rider
      const u = (performance.now() - glide.t0) / 500;
      if (u >= 1) glide = null;
      else {
        const e = smoothstep(u);
        view.center = [glide.c.lng + (view.center[0] - glide.c.lng) * e, glide.c.lat + (view.center[1] - glide.c.lat) * e];
        view.zoom = glide.z + (view.zoom - glide.z) * e; view.pitch = glide.p + (view.pitch - glide.p) * e; view.bearing = lerpAngle(glide.b, view.bearing, e);
      }
    }
    if (state.follow && !state.holding) map.jumpTo(view);   // a GPS ride stops following while you move the map by hand
    showRider(f.fix !== false);           // a GPS ride shows you once it has a good fix
    if (f.fix !== false) checkJoined(f.d);
    riderMarker.setLngLat([f.pos.lon, f.pos.lat]).setRotation(f.pos.heading);
    badgeMarker.setLngLat([f.pos.lon, f.pos.lat]);
    // turn card
    const L = f.look;
    if (L.next) { $("#turn-dist").textContent = C.fmtKm(L.nextDist); $("#turn-text").textContent = I.maneuver(L.next); $("#turn-icon").innerHTML = `<svg viewBox="0 0 46 46">${TURN_SVG[turnIcon(L.next)]}</svg>`; }
    else { $("#turn-dist").textContent = C.fmtKm(f.total - f.d); $("#turn-text").textContent = t("arrive", { name: state.rideEnd }); $("#turn-icon").innerHTML = `<svg viewBox="0 0 46 46">${TURN_SVG.arrive}</svg>`; }
    rideHeading = f.pos.heading; updateWindBadge();
    // gap card: calm, specific (only stretches of 50 m or more)
    const card = $("#gap-card");
    const on = (g) => (g.names[0] ? (I.lang === "fr" ? " sur " : " on ") + C.esc(I.place(g.names[0])) : "");
    if (L.inGap) {
      const left = L.inGap.start + L.inGap.length - f.d; lastGapId = L.inGap.start;
      card.className = "gap-card inside"; card.hidden = false;
      card.innerHTML = `<span class="gc-icon">!</span><span>${state.winter ? t("gapInsideWinter", { d: `<b>${C.fmtKm(left)}</b>`, on: on(L.inGap) })
        : t("gapInside", { d: `<b>${C.fmtKm(left)}</b>`, on: on(L.inGap), tip: t(L.inGap.busy ? "rideTraffic" : "quietTip") })}</span>`;
    } else if (L.nextGap && L.nextGapDist <= 400) {
      card.className = "gap-card"; card.hidden = false;
      card.innerHTML = `<span class="gc-icon">!</span><span>${t(state.winter ? "gapAheadWinter" : "gapAhead", { d: `<b>${C.fmtKm(L.nextGapDist)}</b>`, m: Math.round(L.nextGap.length), on: on(L.nextGap), busy: L.nextGap.busy ? t("busyTag") : "" })}</span>`;
    } else if (lastGapId !== null && performance.now() < afterGapUntil) {
      card.className = "gap-card ok"; card.hidden = false; card.innerHTML = `<span class="gc-icon">✓</span><span>${t("backOnLane")}</span>`;
    } else card.hidden = true;
    if (lastGapId !== null && !L.inGap && afterGapUntil === 0) afterGapUntil = performance.now() + 5000;
    if (L.inGap) afterGapUntil = 0;
    updateHillCard(f, r, climbList);
    // progress
    $("#progress").style.width = `${(f.d / f.total) * 100}%`;
    $("#ride-remaining").textContent = `${C.fmtKm(f.total - f.d)} · ${C.fmtMin(((f.total - f.d) / 1000 / 16) * 60)}`;
    // roadside POIs: pop up as you approach, on their real side of the street. At most 8 at once, names on the 3 nearest.
    const near = L.pois.map((p) => ({ p, ahead: p.along - f.d })).filter((o) => o.ahead > -15).sort((a, b) => a.ahead - b.ahead).slice(0, 8);
    const named = new Set(near.filter((o) => o.ahead < 140).slice(0, 3).map((o) => o.p.i));
    const live = new Set();
    for (const { p, ahead } of near) {
      live.add(p.i);
      let mk = poiMarkers.get(p.i);
      if (!mk) {
        const el = document.createElement("div"); el.className = "poi-pop";
        const b = p.kind === "bixi" ? bixiByName(p.name) : null;
        const label = (p.name || C.poiLabel(p.kind)) + (b ? ` · ${t("bixiBikes", { n: b.properties.bikes })}` : "");
        el.innerHTML = `<img alt="" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(C.iconSVG(p.kind, { size: 60, lines: p.extra }))}"><span>${C.esc(label)}</span>`;
        mk = new maplibregl.Marker({ element: el, anchor: p.side < 0 ? "right" : "left", offset: [p.side < 0 ? -6 : 6, 0], ...MARKER_SHOW }).setLngLat([p.lon, p.lat]).addTo(map);
        poiMarkers.set(p.i, mk);
      }
      const el = mk.getElement();
      el.firstChild.style.transform = `scale(${Math.max(0.7, Math.min(1.25, 1.35 - ahead / 320))})`;
      el.querySelector("span").style.opacity = named.has(p.i) ? 1 : 0;
      el.style.zIndex = String(1000 - Math.round(ahead));
    }
    for (const [i, mk] of poiMarkers) if (!live.has(i)) { mk.remove(); poiMarkers.delete(i); }
    // Draw the map now, in the same step as the icons moved above. Left to itself, MapLibre would draw
    // on its own frame, sometimes one frame later, and the icons would shake against the map.
    // This replaces that scheduled draw, so it still costs one draw per frame.
    map.redraw();
  }

  // Wind during a ride (2026-11-01). The rain radar layer stays on if "wind & rain" was on, but the moving streaks (the #wind canvas, redrawn
  // every frame) are off for the whole ride: they cost battery and make the 3D camera choppy. A still badge in the ride bar says what the
  // wind does instead: an arrow for where it blows relative to the way you ride (up = the way you go), its speed, and head / tail / cross.
  // It is redrawn every 10 s, within 2 s of a corner, and when new weather arrives (never every frame).
  // It shows on every ride (2026-11-03), whether or not the wind & rain button is on: rideWeather loads the forecast at the start. Offline or
  // a failed load: no badge and no message (loadWeather only notes it in the console).
  const windBadge = { at: -1e9, h: 0 };
  let rideHeading = 0, rideWxTimer = null;
  function rideWeather(on) {
    clearInterval(rideWxTimer); rideWxTimer = null;
    if (!on) return;
    loadWeather();   // the saved copy if it is under 10 minutes old
    if (!state.wx) rideWxTimer = setInterval(() => loadWeather(true), 10 * 60e3);   // with the button on, its own timer keeps it fresh
  }
  function windRelative(heading, from) {   // from: the direction the wind comes from (deg)
    const ang = Math.abs(((from - heading + 540) % 360) - 180);   // 0 = wind from dead ahead, 180 = from behind (the same cut-offs as WX.windOnRoute)
    return { rot: (from + 180 - heading + 720) % 360, kind: ang < 60 ? "head" : ang > 120 ? "tail" : "cross" };
  }
  function updateWindBadge(force = false) {
    const el = $("#wind-badge"), wx = state.wxData;
    if (!wx) { el.hidden = true; windBadge.at = -1e9; return; }
    const now = performance.now(), turned = Math.abs(((rideHeading - windBadge.h + 540) % 360) - 180) > 35;
    if (!force && now - windBadge.at < (turned ? 2000 : 10000)) return;
    windBadge.at = now; windBadge.h = rideHeading;
    const calm = wx.now.wind < 3, w = windRelative(rideHeading, wx.now.dir);
    $("#wind-arrow").style.transform = `rotate(${Math.round(w.rot)}deg)`; $("#wind-arrow").style.display = calm ? "none" : "";
    $("#wind-speed").textContent = calm ? t("calm") : t("kmh", { v: Math.round(wx.now.wind) });
    $("#wind-kind").textContent = calm ? "" : t("windKind_" + w.kind);
    el.hidden = false;
  }

  // hill card: the next ~800 m of elevation, with the climb shaded and you as the blue dot
  function updateHillCard(f, r, list) {
    const card = $("#hill-card");
    let cur = null, next = null, topped = null;
    for (const c of list) {
      const end = c.start + c.length;
      if (f.d >= c.start && f.d < end) cur = c;
      else if (f.d >= end && f.d - end < 60) topped = c;
      else if (c.start > f.d && !next) next = c;
    }
    const c = cur || topped || (next && next.start - f.d < 600 ? next : null);
    $("#ride-hud").classList.toggle("hill-on", !!c);   // lifts the "Re-center" button above the card
    if (!c) { card.hidden = true; return; }
    card.hidden = false; card.classList.toggle("on-climb", !!cur);
    let title, sub;
    if (cur) {
      const end = c.start + c.length, span = Math.max(5, Math.min(30, end - f.d));
      const now = (C.elevAt(r, f.d + span) - C.elevAt(r, f.d)) / span;
      title = t("climbing", { g: I.pct(Math.max(0, now)) });
      sub = t("toTop", { d: C.fmtKm(end - f.d), m: Math.max(0, Math.round(C.elevAt(r, end) - C.elevAt(r, f.d))) });
    } else if (topped) {
      title = t("topOfClimb"); sub = t("riseDone", { m: Math.round(c.rise) });
    } else {
      const max = c.maxGrade ?? (c.maxGrade = C.climbMaxGrade(r, c));
      title = t("climbIn", { d: C.fmtKm(c.start - f.d) });
      sub = t("climbStats", { rise: Math.round(c.rise), d: C.fmtKm(c.length), avg: I.pct(c.grade), max: max > c.grade + 0.01 ? t("maxPart", { g: I.pct(max) }) : "" });
    }
    $("#hill-title").textContent = title; $("#hill-sub").textContent = sub;
    if (Math.abs(f.d - sparkAt) > 4) { $("#hill-spark").innerHTML = sparkSVG(r, f.d, list); sparkAt = f.d; }
  }
  function sparkSVG(r, d, list) {
    const W = 132, H = 44, d0 = d - 60, d1 = d + 740;
    const pts = C.profileWindow(r, d0, d1, 10);
    let zmin = Math.min(...pts.map((p) => p[1])), zmax = Math.max(...pts.map((p) => p[1]));
    if (zmax - zmin < 24) { const m = (zmax + zmin) / 2; zmin = m - 12; zmax = m + 12; }   // 2026-10-29: gentler (was 12 m)
    const X = (v) => ((v - d0) / (d1 - d0)) * W, Y = (z) => 5 + (1 - (z - zmin) / (zmax - zmin)) * (H - 11);
    const line = pts.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)} ${Y(p[1]).toFixed(1)}`).join("");
    const area = `${line}L${W} ${H}L0 ${H}Z`;
    const clip = list.filter((c) => c.start < d1 && c.start + c.length > d0)
      .map((c) => `<rect x="${X(c.start).toFixed(1)}" y="0" width="${(X(c.start + c.length) - X(c.start)).toFixed(1)}" height="${H}"/>`).join("");
    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><defs><clipPath id="hc-clip">${clip}</clipPath></defs>` +
      `<path d="${area}" fill="#e8e9f6"/><path d="${area}" fill="${CLIMB.spark}" clip-path="url(#hc-clip)"/>` +
      `<path d="${line}" fill="none" stroke="${CLIMB.ink}" stroke-width="1.4" stroke-linejoin="round"/>` +
      `<circle cx="${X(d).toFixed(1)}" cy="${Y(C.elevAt(r, d)).toFixed(1)}" r="3.8" fill="${NAVY}" stroke="#fff" stroke-width="1.6"/></svg>`;
  }
  function rideEvent(ev) {
    if (ev.type === "gap") { chime(); C.voice.say(C.gapSentence(ev.gap, ev.dist)); }
    if (ev.type === "turn") C.voice.say(I.maneuver(ev.m));
    if (ev.type === "hill") C.voice.say(t("climbVoice", { m: Math.round(ev.hill.rise) }));
    if (ev.type === "arrived") {
      C.voice.say(t("arrivedVoice")); toast(t("arrived"));
      const ride = state.ride;   // 2.5 s later the ride ends (with its summary), unless the rider already ended it or started another
      setTimeout(() => { if (state.ride === ride) endRide({ summary: true }); }, 2500);
    }
  }
  function pauseRide(p) { if (!state.ride) return; if (p) { state.ride.pause(); $("#ride-pause").textContent = t("resume"); } else { state.ride.start(); $("#ride-pause").textContent = t("pause"); } }
  $("#ride-pause").onclick = () => pauseRide(state.ride && state.ride.running);
  $("#ride-speed").onclick = () => { if (!state.ride) return; const m = { 1: 4, 4: 10, 10: 1 }[state.ride.mult] || 4; state.ride.mult = m; $("#ride-speed").textContent = m + "×"; };
  $("#ride-view").onclick = () => {
    state.rideView = state.rideView === "birdseye" ? "topdown" : "birdseye";
    set3d(state.rideView === "birdseye", false); setRidePadding();
    if (state.ride && state.ride.gps) state.ride.kick();   // draw the new view even while standing still
    else if (state.ride && !state.ride.running) { state.snap = true; state.ride.seek(state.ride.d); }
  };
  $("#ride-exit").onclick = () => endRide({ summary: true });
  // opts.summary: a GPS ride that ends by arriving or by "End" shows what was ridden (the preview and errors don't)
  function endRide({ summary = false } = {}) {
    const wasGps = !!(state.ride && state.ride.gps), newRoute = state.reroutes > 0 || !!(state.join && (state.join.kind === "on" || state.join.kind === "lead"));
    const sum = summary && wasGps ? C.rideSummary(state.ride.trail) : null;
    const showSum = !!sum && sum.distanceM >= C.SUMMARY.MIN_SHOW_M;   // a few metres is not a ride
    if (state.ride) state.ride.pause(); state.ride = null;
    if (wasGps) keepAwake(false);
    if (map.terrain) map.terrain.exaggeration = CAM.terrain;
    state.hillK = 0; state.follow = true; glide = null; showRider(true);
    riderMarker.remove(); badgeMarker.remove(); for (const mk of poiMarkers.values()) mk.remove(); poiMarkers.clear();
    $("#ride-hud").hidden = true; $("#wind-badge").hidden = true; $("#hill-card").hidden = true; $("#ride-recenter").hidden = true; rideWeather(false);
    $("#panel").hidden = $("#legend").hidden = document.querySelector(".map-controls").hidden = showSum;   // the summary card takes their place until "Done"
    map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
    hideSummary();
    setMode(state.routes.length ? "route" : "explore"); afterGapUntil = 0; lastGapId = null;
    if (newRoute) drawRoutes();   // the planned routes again, not the reroute or the classic ride from where you were
    if (showSum) state.summary = sum;
    refreshSections(); wind.show(state.wx); renderWxCard();
    if (showSum) showSummary();
    else if (state.routes.length) fitRoute(state.routes[state.sel].r);
  }

  // ------------------------------------------------------------------ end-of-ride summary (GPS rides)
  // The path you rode (the fixes C.RideGPS kept, tidied by C.rideSummary) is drawn over the planned route, with a small card.
  // It lives in memory only: it is never sent anywhere or stored, and "Done" drops it.
  const SITE_URL = "https://www.pistemtl.ca/";
  const calmMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  function renderSummary() {
    const s = state.summary; if (!s) return;
    $("#rs-distance").textContent = C.fmtKm(s.distanceM);
    $("#rs-time").textContent = I.duration(s.elapsedS / 60);
    $("#rs-speed").textContent = t("kmh", { v: I.num(s.avgKmh, 1) });
    $("#rs-paths-row").hidden = s.pathShare == null; if (s.pathShare != null) $("#rs-paths").textContent = I.pct(s.pathShare);
    $("#rs-climb-row").hidden = $("#rs-descent-row").hidden = !s.hasElev;
    const metres = (v, sign) => (Math.round(v) === 0 ? "0 m" : `${sign}${Math.round(v)} m`);   // never "+0 m" or "−0 m"
    $("#rs-climb").textContent = metres(s.gainM, "+"); $("#rs-descent").textContent = metres(s.lossM, "−");
    $("#rs-share").hidden = !navigator.share;
  }
  function showSummary() {
    const s = state.summary, card = $("#ride-summary");
    set3d(false, false);   // flat, so the whole path can be seen
    map.getSource("ridden").setData({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: s.line } });
    renderSummary(); card.hidden = false; card.focus({ preventScroll: true });
    const xs = s.line.map((c) => c[0]), ys = s.line.map((c) => c[1]);
    const safe = (k) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(k)) || 0;
    const padding = isPhone() ? { top: 40 + safe("--safe-top"), bottom: card.offsetHeight + 36 + safe("--safe-bottom"), left: 24, right: 24 }
      : { top: 80, bottom: 80, left: 440, right: 80 };
    map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding, maxZoom: 17, pitch: 0, bearing: 0, duration: calmMotion() ? 0 : 700 });
  }
  function hideSummary() {
    state.summary = null; $("#ride-summary").hidden = true;
    const src = map.getSource("ridden"); if (src) src.setData(empty);
  }
  function closeSummary() {   // "Done": the path is gone, and the normal view is back
    hideSummary();
    $("#panel").hidden = $("#legend").hidden = document.querySelector(".map-controls").hidden = false;
    renderWxCard();
    if (state.routes.length) fitRoute(state.routes[state.sel].r, { pitch: 0, bearing: 0, duration: calmMotion() ? 0 : 700 });
  }
  $("#rs-done").onclick = closeSummary;
  $("#ride-summary").addEventListener("keydown", (e) => { if (e.key === "Escape") closeSummary(); });
  $("#rs-share").onclick = async () => {
    const s = state.summary; if (!s || !navigator.share) return;
    try { await navigator.share({ text: t("rsShareText", { d: C.fmtKm(s.distanceM), t: I.duration(s.elapsedS / 60) }), url: SITE_URL }); }
    catch (e) { if (e.name !== "AbortError") console.warn("share failed", e); }   // AbortError: the rider closed the share sheet
  };

  // ------------------------------------------------------------------ helpers
  function pillImage(fill, stroke) {
    const c = document.createElement("canvas"); c.width = 64; c.height = 40; const x = c.getContext("2d");
    x.fillStyle = fill; x.strokeStyle = stroke; x.lineWidth = 2;
    x.beginPath(); x.roundRect(2, 2, 60, 36, 14); x.fill(); x.stroke();
    return x.getImageData(0, 0, 64, 40);
  }
  // legend: the elevation colours as they look on the map (tint over the Positron background)
  function buildElevationLegend() {
    const ramp = (window.ELEVATION_TINT || {}).ramp; if (!ramp) return;
    const BG = [244, 239, 227];   // the paper, and the layer's -0.55 saturation and about 0.6 opacity (2026-11-07)
    const stops = ramp.map(([m, rgba], i) => {
      const [r0, g0, b0, a0] = rgba.match(/[\d.]+/g).map(Number), avg = (r0 + g0 + b0) / 3, a = a0 * 0.6;
      const [r, g, b] = [r0, g0, b0].map((v) => v + (avg - v) * 0.55);
      const mix = (v, j) => Math.round(v * a + BG[j] * (1 - a));
      return `rgb(${mix(r, 0)},${mix(g, 1)},${mix(b, 2)}) ${((i / (ramp.length - 1)) * 100).toFixed(1)}%`;
    });
    $("#elev-ramp").style.background = `linear-gradient(90deg, ${stops.join(", ")})`;
    $("#elev-ticks").innerHTML = [10, 50, 110, 200].map((m) => {
      const i = ramp.findIndex((s) => s[0] === m);
      return i < 0 ? "" : `<small style="left:${((i / (ramp.length - 1)) * 100).toFixed(1)}%">${m}${m === 200 ? " m" : ""}</small>`;
    }).join("");
  }

  // ------------------------------------------------------------------ start: deep links for tests, screenshots and sharing
  // ?trip=rachel|montroyal|biodome|davidson · ?from=lon,lat&to=lon,lat · ?suggest=loop|oneway&km=&stop= · ?classic=<id>
  // ?view=3d · ?winter=1 · ?wx=1 · ?lang=fr · ?ride=bird|top&at=<m>&paused (the simulated preview)
  // ?ride=gps: a GPS ride (with ?gps=replay&gpsx=<speed-up>&gpsat=<m>&detour=<m>: a pretend one, for tests and screenshots;
  // add &gpsdeny for a pretend "location refused")
  refreshSections(); applyLayers();
  const lonlat = (s) => { const v = (s || "").split(",").map(Number); return v.length === 2 && v.every(Number.isFinite) ? v : null; };
  const pFrom = lonlat(params.get("from")), pTo = lonlat(params.get("to"));
  const trip = (window.TRIPS || []).find((x) => x.id === params.get("trip"));
  if (pFrom) setPoint("from", pFrom, placeLabel(pFrom[0], pFrom[1]));
  if (pTo) setPoint("to", pTo, placeLabel(pTo[0], pTo[1]));
  if (trip) { setPoint("from", trip.from.lonlat, trip.from.label); setPoint("to", trip.to.lonlat, trip.to.label); }
  if (params.get("winter") === "1") setWinter(true);
  if (params.get("wx") === "1" || WX_DEMO) setWeather(true);
  if (params.get("suggest") || params.get("classic")) {
    state.tab = "suggest";
    if (params.get("classic")) { state.smode = "classics"; state.classic = Math.max(0, CLASSICS.findIndex((c) => c.id === params.get("classic"))); }
    else {
      state.smode = "custom";
      state.sugg.loop = params.get("suggest") !== "oneway";
      document.querySelector(`input[name="shape"][value="${state.sugg.loop ? "loop" : "oneway"}"]`).checked = true;
      if (params.get("km")) setKm(params.get("km"), false);
      if (SK[params.get("stop")]) { state.sugg.stop = params.get("stop"); renderStopChips(); }
    }
    document.querySelector(`input[name="smode"][value="${state.smode}"]`).checked = true;
    refreshSections();
  }
  if (state.tab === "suggest" && state.smode === "custom") await computeSuggestions(true); else recompute(true);
  if (state.tab === "suggest" && state.smode === "classics") requestAnimationFrame(() => { const el = track.children[state.classic]; if (el) track.scrollLeft = el.offsetLeft - (track.clientWidth - el.offsetWidth) / 2; });
  renderClassicCards();
  if (params.get("view") === "3d") set3d(true);
  if (!["from", "to", "trip", "suggest", "classic", "ride"].some((k) => params.has(k))) startLocate();   // a link that shows something wins
  if (params.get("ride") === "gps" && state.routes.length) startGpsRide();
  else if (params.get("ride") && state.routes.length) {
    startRide(params.get("ride") === "top" ? "topdown" : "birdseye");
    if (params.has("at")) { state.snap = true; state.ride.seek(+params.get("at")); }
    if (params.has("paused")) pauseRide(true);
  }
  window.__app = { map, router, state, set3d, startRide, recompute, computeRoutes, computeSuggestions, showClassic, setTab, setSuggMode,
    setWinter, setWeather, setLang, setSheet, suggester, pauseRide, CAM, classicRoute, enterSearch, cancelSearch, poiMarkers,
    startGpsRide, endRide, gpsDefault, setFollow, riderMarker, paintTrees, poiPopup, trees: treeLayer, edges: edgeLayer, treesFallback, wind, precip };
  // hooks for the welcome card and the guided tour (tour.js), which only steer the app through these
  window.piste = { map, state, store, isPhone, sheet, setSheet, sheetHeight, setTab, setWinter, openLayers, setPoint, clearPoint,
    computeRoutes, selectRoute, recompute, gpsDefault, classics: CLASSICS.length, track: count };
  document.dispatchEvent(new Event("piste:ready"));
})();
