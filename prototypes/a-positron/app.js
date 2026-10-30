/* Piste (prototype A, Positron light): MapLibre GL JS + our in-browser router on the island-wide graph.
   Go somewhere · Suggest a ride (classic rides and custom loops) · GPS ride (and a simulated preview) with hill-ahead 3D ·
   winter mode (4-season network) · wind & rain · live BIXI · English / French. */
(async function () {
  "use strict";
  const C = window.BikeCommon, I = window.BikeI18n, WX = window.BikeWeather, BX = window.BikeBixi;
  const { Router, weightsFor, PROFILES } = window.BikeRouter;
  const $ = (s) => document.querySelector(s);
  const t = (k, v) => I.t(k, v);
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

  // ------------------------------------------------------------------ palette (STM metro colours, softened gap orange)
  const COL = {
    a: "#0095E6", b: "#6cc3f2", c: "#0095E6", gap: "#ef8f45", gapQuiet: "#f2a865", closed: "#d7263d",
    rev: "#00a62a", netA: "#2fb350", netB: "#5cc471", netC: "#8fd49d", planned: "#d9b400", alt: "#9aa5ae", notCleared: "#aebbc6",
  };
  const TIER_BAR = ["#0095E6", "#6cc3f2", "#a6d9f6", "#f6bf8f", "#ef8f45", "#d7263d"];
  const CLIMB = { fill: "#dcc3a3", ink: "#5b3d22", spark: "#c99b6d" };

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

  const store = { get(k, d) { try { return localStorage.getItem("piste-" + k) ?? d; } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem("piste-" + k, v); } catch (e) { /* private */ } } };
  const state = { from: null, to: null, fromLabel: "", toLabel: "", routes: [], sel: 0, mode: "explore", is3d: false,
    pick: null, ride: null, rideView: "birdseye", lastMs: 0, terrainOn: false, hillK: 0, snap: false,
    tab: "go", smode: "classics", classic: 0, sugg: { loop: true, km: 10, stop: "" }, avoidWind: false,
    winter: false, wx: false, wxData: null, bixi: null, sound: store.get("sound", "chime"), rideEnd: "",
    follow: true, holding: false, reroutes: 0, rerouteLog: [], rideOpts: null, gpsState: null, wake: "off" };

  // ------------------------------------------------------------------ basemap style (OpenFreeMap Positron, our buildings instead of theirs)
  let style;
  try {
    style = await (await fetch("https://tiles.openfreemap.org/styles/positron")).json();
    style.layers = style.layers.filter((l) => l.id !== "building");
    for (const l of style.layers) {
      if (l.id === "water") l.paint["fill-color"] = "#c9dde9";
      if (l.id === "park") { l.paint["fill-color"] = "#d3e8cc"; l.paint["fill-opacity"] = 0.9; }
    }
  } catch (e) {
    style = { version: 8, glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf", sources: {},
      layers: [{ id: "background", type: "background", paint: { "background-color": "#f2f3f0" } }] };
    toast(t("offline"));
  }
  const map = new maplibregl.Map({
    container: "map", style, center: [-73.585, 45.522], zoom: 12.8, maxPitch: 80,
    attributionControl: { compact: true, customAttribution: "Ville de Montréal (CC BY 4.0) · NRCan HRDEM 2023 + 2024 · STM · BIXI · Open-Meteo · ECCC" },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");
  await new Promise((r) => map.on("load", r));

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
  map.addSource("network", { type: "geojson", data: networkGeoJSON() });
  map.addSource("planned", { type: "geojson", data: window.PLANNED });
  map.addSource("pois", { type: "geojson", data: C.poisGeoJSON(window.POIS) });
  map.addSource("terrain", { type: "raster-dem", tiles: ["piste-dem://{z}/{x}/{y}"], encoding: "terrarium", tileSize: 256, maxzoom: 14 });
  map.addSource("radar", { type: "raster", tiles: [WX.radarTiles(false)], tileSize: 256, maxzoom: 10,
    attribution: "Radar © Environment and Climate Change Canada" });
  for (const id of ["route", "route-alts", "gaps", "ends", "works-near", "stops", "bixi-live"]) map.addSource(id, { type: "geojson", data: empty });

  // ------------------------------------------------------------------ layers (bottom to top)
  // elevation: a soft colour tint over land and parks (not water), then LiDAR hill shading and contours under the streets
  const tintBefore = map.getLayer("waterway") ? "waterway" : firstRoad;
  add({ id: "tint", type: "raster", source: "tint",
    paint: { "raster-opacity": ["interpolate", ["linear"], ["zoom"], 13, 1, 15, 0.7, 17, 0.45], "raster-fade-duration": 0 } }, tintBefore);
  if (map.getLayer("water") && map.getLayer(tintBefore)) map.moveLayer("water", tintBefore);
  // 2026-10-29: shading halfway between the first prototype (0.75) and the strong version (0.95 → 0.72)
  add({ id: "relief", type: "raster", source: "relief",
    paint: { "raster-opacity": ["interpolate", ["linear"], ["zoom"], 11, 0.85, 15, 0.8, 18, 0.72], "raster-fade-duration": 0 } }, firstRoad);
  const CONTOUR = "#9a7c52";
  // contours: 1 m detail lines only where the ground rises 2.5-15 %, so climbs show as denser lines (replaces the chevrons)
  add({ id: "contours-detail", type: "line", source: "contours", "source-layer": "contours", minzoom: 14, filter: ["==", ["get", "i"], 2],
    paint: { "line-color": CONTOUR, "line-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0.16, 16, 0.32], "line-width": ["interpolate", ["linear"], ["zoom"], 14, 0.4, 17, 0.7] } }, firstRoad);
  add({ id: "contours-minor", type: "line", source: "contours", "source-layer": "contours", minzoom: 13, filter: ["==", ["get", "i"], 0],
    paint: { "line-color": CONTOUR, "line-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0.2, 15, 0.42], "line-width": ["interpolate", ["linear"], ["zoom"], 13, 0.5, 17, 0.9] } }, firstRoad);
  add({ id: "contours-index", type: "line", source: "contours", "source-layer": "contours", minzoom: 11.5, filter: ["==", ["get", "i"], 1],
    paint: { "line-color": CONTOUR, "line-opacity": ["interpolate", ["linear"], ["zoom"], 11.5, 0.45, 14, 0.75], "line-width": ["interpolate", ["linear"], ["zoom"], 11.5, 0.6, 16, 1.4] } }, firstRoad);
  add({ id: "bld-flat", type: "fill", source: "bld", "source-layer": "buildings", minzoom: 13,
    paint: { "fill-color": "#e7e4de", "fill-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0, 14, 0.92], "fill-outline-color": "#d9d5cd" } });
  add({ id: "bld-3d", type: "fill-extrusion", source: "bld", "source-layer": "buildings", minzoom: 14, layout: { visibility: "none" },
    paint: { "fill-extrusion-color": ["interpolate", ["linear"], ["get", "h"], 0, "#f1eee8", 25, "#e6e2db", 90, "#d9d3ca"],
      "fill-extrusion-height": ["get", "h"], "fill-extrusion-base": 0, "fill-extrusion-opacity": 0.82, "fill-extrusion-vertical-gradient": true } });
  add({ id: "radar", type: "raster", source: "radar", layout: { visibility: "none" }, paint: { "raster-opacity": 0.5, "raster-fade-duration": 300 } });
  // bike network (winter: 4-season lanes stay green, the rest turns grey and dashed)
  add({ id: "net-casing", type: "line", source: "network", layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 1.6, 16, 6] } });
  add({ id: "net-ab", type: "line", source: "network", filter: ["<=", ["get", "t"], 1], layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ["case", ["==", ["get", "rev"], 1], COL.rev, ["==", ["get", "t"], 0], COL.netA, COL.netB],
      "line-width": ["interpolate", ["linear"], ["zoom"], 12, ["case", ["==", ["get", "rev"], 1], 2, 1], 16, ["case", ["==", ["get", "rev"], 1], 4.4, ["==", ["get", "t"], 0], 3.2, 2.3]],
      "line-opacity": 0.9 } });
  add({ id: "net-c", type: "line", source: "network", filter: ["==", ["get", "t"], 2],
    paint: { "line-color": COL.netC, "line-width": ["interpolate", ["linear"], ["zoom"], 12, 0.8, 16, 2], "line-dasharray": [2, 1.5] } });
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
  add({ id: "route-casing", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 7, 17, 16] } });
  add({ id: "route-solid", type: "line", source: "route", filter: ["in", ["get", "tier"], ["literal", [0, 1, 4]]], layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ["match", ["get", "tier"], 0, COL.a, 1, COL.b, COL.gap], "line-width": ["interpolate", ["linear"], ["zoom"], 12, 4, 17, 10] } });
  add({ id: "route-shared", type: "line", source: "route", filter: ["==", ["get", "tier"], 2],
    paint: { "line-color": COL.c, "line-width": ["interpolate", ["linear"], ["zoom"], 12, 3.5, 17, 9], "line-dasharray": [1.1, 0.8] } });
  add({ id: "route-quiet", type: "line", source: "route", filter: ["==", ["get", "tier"], 3],
    paint: { "line-color": COL.gapQuiet, "line-width": ["interpolate", ["linear"], ["zoom"], 12, 3.5, 17, 9], "line-dasharray": [1, 0.6] } });
  // a ring under the stop's or sight's POI icon
  add({ id: "stops", type: "circle", source: "stops",
    paint: { "circle-radius": 7.5, "circle-color": "#ffffff", "circle-opacity": 0.95, "circle-stroke-color": COL.a, "circle-stroke-width": 2.5, "circle-pitch-alignment": "map" } });
  add({ id: "contour-labels", type: "symbol", source: "contours", "source-layer": "contours", minzoom: 13.5, filter: ["==", ["get", "i"], 1],
    layout: { "symbol-placement": "line", "text-field": ["concat", ["to-string", ["get", "e"]], " m"], "text-font": ["Noto Sans Regular"],
      "text-size": ["interpolate", ["linear"], ["zoom"], 13.5, 10, 17, 12], "symbol-spacing": 360, "text-max-angle": 30, "text-padding": 2 },
    paint: { "text-color": "#7d6542", "text-halo-color": "rgba(251,248,241,0.95)", "text-halo-width": 1.6 } });

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
        "text-offset": [0, 1.35], "text-anchor": "top", "text-optional": true, "symbol-sort-key": kind === "metro" ? 0 : kind === "bixi" ? 1 : 5 },
      paint: { "text-color": "#4a525a", "text-halo-color": "#ffffff", "text-halo-width": 1.3 } });
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
    paint: { "text-color": "#0072B2", "text-halo-color": "#ffffff", "text-halo-width": 1.8 } });
  map.addLayer({ id: "ends", type: "circle", source: "ends",
    paint: { "circle-radius": 8, "circle-color": ["match", ["get", "k"], "from", "#0095E6", "#ffffff"],
      "circle-stroke-color": ["match", ["get", "k"], "from", "#ffffff", "#0095E6"], "circle-stroke-width": 3.5 } });
  function setMapTexts() {   // map labels that carry words: redone when the language or winter mode changes
    map.setLayoutProperty("stop-labels", "text-field", ["case", ["==", ["get", "sight"], 1], ["get", "label"], ["concat", t("stopPrefix"), ["get", "label"]]]);
  }
  setMapTexts();
  buildElevationLegend();

  // ------------------------------------------------------------------ winter mode: icy colours, 4-season network, snow status
  const WINTER_PAINT = [
    ["background", "background-color", "#eef4f8"], ["park", "fill-color", "#e1ecf1"], ["water", "fill-color", "#b9d2e2"],
    ["landuse_residential", "fill-color", "#e6eef4"], ["landcover_wood", "fill-color", "#dbe6ed"], ["waterway", "line-color", "#a9c6d9"],
    ["highway_major_casing", "line-color", "#c6d6e2"], ["highway_motorway_casing", "line-color", "#c6d6e2"],
    ["tint", "raster-hue-rotate", 170], ["tint", "raster-saturation", -0.35],
    ["contours-detail", "line-color", "#7895aa"], ["contours-minor", "line-color", "#7895aa"], ["contours-index", "line-color", "#7895aa"],
    ["contour-labels", "text-color", "#5c7689"], ["bld-flat", "fill-color", "#e2e9ef"], ["bld-flat", "fill-outline-color", "#cfd9e1"],
    ["bld-3d", "fill-extrusion-color", ["interpolate", ["linear"], ["get", "h"], 0, "#f3f6f9", 25, "#e5ecf2", 90, "#d6e0e8"]],
  ];
  const summerPaint = {};
  function setWinter(on) {
    state.winter = on;
    router.setWinter(on);
    document.body.classList.toggle("winter", on);
    $("#winter-btn").setAttribute("aria-pressed", String(on));
    for (const [id, prop, val] of WINTER_PAINT) {
      if (!map.getLayer(id)) continue;
      const key = id + "|" + prop;
      if (!(key in summerPaint)) summerPaint[key] = map.getPaintProperty(id, prop);
      map.setPaintProperty(id, prop, on ? val : summerPaint[key] ?? null);
    }
    const s4 = ["==", ["get", "s4"], 1];
    map.setFilter("net-ab", on ? ["all", ["<=", ["get", "t"], 1], s4] : ["<=", ["get", "t"], 1]);
    map.setFilter("net-c", on ? ["all", ["==", ["get", "t"], 2], s4] : ["==", ["get", "t"], 2]);
    map.getSource("radar").setTiles([WX.radarTiles(on)]);
    setMapTexts(); applyLayers();
    if (on) loadWeather();   // snow and ice status
    renderWxCard();
    classicsRouted = false;   // the classics re-route on the 4-season network
    recompute(true);
  }

  // ------------------------------------------------------------------ wind & rain
  const wind = new WX.WindLayer(map, $("#wind"));
  let wxTimer = null;
  async function loadWeather(force) {
    try {
      state.wxData = await WX.load(force);
      wind.set(state.wxData);
    } catch (e) { state.wxData = null; console.warn(e); }
    renderWxCard(); if (state.routes.length) renderRoutes();
    return state.wxData;
  }
  function setWeather(on) {
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
  // "avoid headwinds": per-edge slow-down riding into today's wind, cached until the wind changes
  let windArr = {}, windKey = "";
  function windWeights() {
    const wx = state.wxData; if (!state.avoidWind || !wx || wx.now.wind < 6) return {};
    const key = `${wx.now.dir}|${wx.now.wind}`;
    if (key !== windKey) { windArr = router.windCost((wx.now.dir + 180) % 360, (wx.now.wind / 3.6) * 0.6, WX.speedWith); windKey = key; }
    return windArr;
  }
  function renderWxCard() {
    const card = $("#wx-card");
    if ((!state.wx && !state.winter) || state.mode === "ride") { card.hidden = true; return; }
    const wx = state.wxData, rows = [];
    if (!wx) rows.push(`<div class="wx-row">${t(state.wx ? "wxLoading" : "winterOn")}</div>`);
    if (state.wx && wx) {
      const dirKey = I.compassKey(wx.now.dir), to = (wx.now.dir + 180) % 360;
      const windTxt = wx.now.wind < 3 ? t("calm") : t("windFrom", { dir: t("from_" + dirKey), v: Math.round(wx.now.wind) }) + (wx.now.gust > wx.now.wind + 8 ? ` · ${t("gusts", { v: Math.round(wx.now.gust) })}` : "");
      rows.push(`<div class="wx-row"><svg class="wx-arrow" viewBox="0 0 24 24" style="transform:rotate(${to - map.getBearing()}deg)" aria-hidden="true"><path d="M12 21V5M6 11l6-6 6 6"/></svg><span>${windTxt}</span></div>`);
      const rain = WX.rainOutlook(wx);
      const rainTxt = rain.now ? t("rainNow", { mm: I.num(rain.mm) }) : rain.at ? t("rainAt", { h: rain.at, p: rain.prob != null ? I.pct(rain.prob / 100) : "" }) : t("dryFor", { n: rain.dryHours });
      rows.push(`<div class="wx-row"><svg class="wx-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3c3.5 5 6 8.2 6 11a6 6 0 0 1-12 0c0-2.8 2.5-6 6-11z"/></svg><span>${rainTxt}</span></div>`);
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
    if (state.wx) rows.push(`<div class="wx-row wx-note">${t("radarCredit")}</div>`);
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
  const strict = $("#strict"), strictOut = $("#strict-out"), hills = $("#hills");
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
  // avoid hills and avoid headwinds sit together under the route style and apply to every kind of route
  $("#avoid-wind").addEventListener("change", async (e) => {
    state.avoidWind = e.target.checked;
    if (state.avoidWind && !state.wxData) await loadWeather();
    recompute(true);
  });

  // ------------------------------------------------------------------ UI: search
  const fromEl = $("#from"), toEl = $("#to"), sug = $("#suggest"), sugHome = sug.parentElement;
  let sugItems = [], sugActive = -1, sugTarget = null, sugTimer = null;
  for (const el of [fromEl, toEl]) {
    el.addEventListener("input", () => {
      sugTarget = el.id; clearTimeout(sugTimer);
      sugTimer = setTimeout(async () => { sugItems = await geocoder.search(el.value); sugActive = -1; renderSuggest(); }, 160);
    });
    el.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" && !sug.hidden) { sugActive = Math.min(sugItems.length - 1, sugActive + 1); renderSuggest(); e.preventDefault(); }
      if (e.key === "ArrowUp" && !sug.hidden) { sugActive = Math.max(0, sugActive - 1); renderSuggest(); e.preventDefault(); }
      if (e.key === "Enter") {   // the keyboard's return key: the highlighted (or top) suggestion, or the place as it is
        e.preventDefault(); sugTarget = el.id;
        if (sugItems.length && !sug.hidden) choose(sugItems[Math.max(0, sugActive)]);
        else if (el.value === (state[el.id + "Label"] || "")) placeDone(el.id);
      }
      if (e.key === "Escape") { if (search.which) cancelSearch(); else sug.hidden = true; }
    });
    el.addEventListener("blur", () => setTimeout(() => blurred(el), 180));
  }
  function renderSuggest() {
    if (!sugItems.length) { sug.hidden = true; return; }
    if (search.which) placeSuggest();
    else { const field = (sugTarget === "from" ? fromEl : toEl).closest(".field"); sug.style.top = field.offsetTop + field.offsetHeight + 4 + "px"; }
    sug.innerHTML = sugItems.map((it, i) => `<li data-i="${i}" class="${i === sugActive ? "active" : ""}"><span>${C.esc(it.label)}</span><small>${C.esc(it.sub || "")}</small></li>`).join("");
    sug.hidden = false;
    sug.querySelectorAll("li").forEach((li) => {
      const pick = (e) => { e.preventDefault(); choose(sugItems[+li.dataset.i]); };
      li.addEventListener("pointerdown", (e) => { if (e.pointerType !== "mouse") pick(e); });   // a finger: pick at once, the keyboard stays up
      li.addEventListener("mousedown", pick);
    });
  }
  function choose(it) {
    const which = sugTarget;
    sug.hidden = true; sugItems = [];
    setPoint(which, [it.lon, it.lat], it.label);
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

  document.querySelectorAll(".pick").forEach((b) => b.addEventListener("click", () => {
    state.pick = state.pick === b.dataset.target ? null : b.dataset.target;
    document.querySelectorAll(".pick").forEach((x) => x.classList.toggle("on", x.dataset.target === state.pick));
    map.getCanvas().style.cursor = state.pick ? "crosshair" : "";
    if (state.pick && isPhone()) setSheet("peek");
  }));

  // draggable endpoints: location pins (start mostly blue, destination mostly white with blue)
  const markers = {};
  const PIN = {
    from: '<svg viewBox="0 0 64 78"><path d="M32 76c-3-6-22-22-22-42a22 22 0 0 1 44 0c0 20-19 36-22 42z" fill="#0095E6" stroke="#fff" stroke-width="4"/><circle cx="32" cy="33" r="9" fill="#fff"/></svg>',
    to: '<svg viewBox="0 0 64 78"><path d="M32 76c-3-6-22-22-22-42a22 22 0 0 1 44 0c0 20-19 36-22 42z" fill="#fff" stroke="#0095E6" stroke-width="5"/><circle cx="32" cy="33" r="9" fill="#0095E6"/></svg>',
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
  const kbOpen = () => !!window.visualViewport && innerHeight - visualViewport.height > 120;
  function keyboardTop() {   // page coordinates; until the keyboard is up, a guess (iPhone keyboards take 40-46% of the screen)
    return kbOpen() ? visualViewport.offsetTop + visualViewport.height : innerHeight - Math.round(Math.max(260, innerHeight * 0.47));
  }
  function dock(animate) {   // card height that leaves the search bars just above the keyboard
    if (!search.which) return;
    const last = (state.tab === "go" ? toEl : fromEl).closest(".field");
    const block = last.getBoundingClientRect().bottom - panel.getBoundingClientRect().top + 12;
    const h = Math.round(innerHeight - keyboardTop() + block);
    panel.classList.toggle("dragging", !animate);
    panel.style.height = h + "px";
    placeSuggest(h);
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
    document.body.classList.remove("searching");
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
  for (const el of [fromEl, toEl]) {
    el.addEventListener("pointerdown", (e) => {
      if (!isPhone() || state.mode === "ride" || search.which) return;   // already searching: the bars sit above the keyboard
      e.preventDefault();                 // move the card first, then focus, so iPhone Safari has no reason to scroll the page
      enterSearch(el.id);
      el.focus({ preventScroll: true });
    });
    el.addEventListener("focus", () => { if (isPhone() && state.mode !== "ride") enterSearch(el.id); });
  }
  document.querySelectorAll(".clear").forEach((b) => {
    const go = (e) => { e.preventDefault(); cancelSearch(); };
    b.addEventListener("pointerdown", (e) => { if (e.pointerType !== "mouse") go(e); });
    b.addEventListener("mousedown", go);
  });
  if (window.visualViewport) for (const ev of ["resize", "scroll"]) visualViewport.addEventListener(ev, () => { if (search.which && kbOpen()) dock(true); });

  // ------------------------------------------------------------------ map clicks
  let layersJustClosed = false;
  map.on("click", (e) => {
    if (layersJustClosed) { layersJustClosed = false; return; }   // a tap that only closed the layers panel
    if (state.mode === "ride") return;
    if (search.which) return;   // typing a place (phones): a tap on the map only closes the keyboard
    const live = map.getLayer("bixi-live") && map.getLayoutProperty("bixi-live", "visibility") !== "none" ? ["bixi-live", "bixi-count"] : [];
    const hit = map.queryRenderedFeatures(e.point, { layers: [...live, ...POI_LAYERS.map((p) => p.id)].filter((id) => map.getLayer(id)) });
    if (hit.length && !state.pick) { poiPopup(hit[0]); return; }
    const alt = map.queryRenderedFeatures(e.point, { layers: ["route-alts"] });
    if (alt.length && !state.pick) { selectRoute(alt[0].properties.i); return; }
    if (state.tab === "suggest" && state.smode === "classics") return;
    const lonlat = [e.lngLat.lng, e.lngLat.lat];
    const which = state.tab === "suggest" ? "from" : state.pick || (!state.from ? "from" : "to");
    setPoint(which, lonlat, placeLabel(lonlat[0], lonlat[1]));
    state.pick = null; document.querySelectorAll(".pick").forEach((x) => x.classList.remove("on")); map.getCanvas().style.cursor = "";
    recompute(!state.routes.length);
  });
  function poiPopup(f) {
    const isBixi = f.layer.id === "bixi-live" || f.layer.id === "bixi-count";
    const kind = isBixi ? "bixi" : f.properties.k;
    const name = f.properties.name || C.poiLabel(kind);
    const extra = isBixi ? `<div class="pop-bixi"><b>${bixiText(f.properties)}</b> · ${t("bixiLive")}</div>` : "";
    const html = `<div class="pop"><b>${C.esc(name)}</b><div class="pop-kind">${C.esc(C.poiLabel(kind))}</div>${extra}
      <button type="button" class="primary pop-go">${t("rideHere")}</button></div>`;
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
  function overlap(a, b) { let c = 0; for (const e of a.sig) if (b.sig.has(e)) c++; return c / Math.max(a.sig.size, b.sig.size); }
  // the router settings behind each kind of route (a GPS reroute uses the same ones as the route you started)
  function routeWeights(key) {
    const wind = windWeights();
    if (key === "mostLanes") return Object.assign({ w: PROFILES.bikemax.w, hill: hills.checked ? 12 : 4 }, wind);
    if (key === "mostDirect") return { w: PROFILES.direct.w, hill: hills.checked ? 12 : 0 };
    return Object.assign({}, weightsFor(+strict.value / 100, hills.checked), wind);   // "Your route" and suggested rides
  }
  function selWeights(sel) {
    if (sel.classic) return { w: PROFILES.bikemax.w, hill: 4 };   // as classicRoute()
    return routeWeights(sel.key || "yourRoute");
  }
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
    const cands = ["yourRoute", "mostLanes", "mostDirect"].map((key) => ({ key, r: router.route(state.from, state.to, routeWeights(key)) })).filter((c) => c.r);
    state.lastMs = performance.now() - t1;
    cands.forEach((c) => (c.sig = new Set(c.r.legs.map((l) => l.e))));
    const keep = [];
    for (const c of cands) if (!keep.some((k) => overlap(k, c) > 0.9)) keep.push(c);
    keep.forEach((c) => (c.climbs = C.climbs(c.r)));
    state.routes = keep; state.sel = 0;
    renderRoutes(); drawRoutes();
    if (fit && keep.length) fitRoute(keep[0].r);
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
      weights: Object.assign({}, weightsFor(+strict.value / 100, hills.checked), windWeights()), windCost: wx ? (route) => WX.windOnRoute(route, wx) : null });
    if (token !== suggToken) return;   // a newer request started meanwhile
    state.lastMs = performance.now() - t1;
    state.routes = picks.map((c) => ({ title: c.title, via: c.via, r: c.route, sig: c.route.sig, climbs: C.climbs(c.route), end: c.end, loop: c.loop }));
    state.sel = 0;
    if (!picks.length) toast(t("nothingFits"));
    renderRoutes(); drawRoutes();
    if (fit && state.routes.length) fitRoute(state.routes[0].r);
  }
  function selectRoute(i) { state.sel = +i; renderRoutes(); drawRoutes(); }
  function stopsData(r) {   // the stop's or sights' rings and labels
    const stops = (r && r.stops) || [];
    return { type: "FeatureCollection", features: stops.map((s, i) => ({ type: "Feature", id: i, geometry: { type: "Point", coordinates: [s.lon, s.lat] }, properties: { label: s.label, sight: s.sight ? 1 : 0 } })) };
  }
  function fitRoute(r) {
    const xs = r.coords.map((c) => c[0]), ys = r.coords.map((c) => c[1]);
    let padding;
    if (isPhone()) {
      if (sheet.state === "full") setSheet("half");
      const top = 60 + (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--safe-top")) || 0);
      padding = { top, bottom: sheetHeight(sheet.state) + 24, left: 24, right: 70 };
    } else padding = { top: 80, bottom: 80, left: 420, right: 90 };
    map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding, maxZoom: 16, duration: 700 });
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
    for (let k = 1; k < c.pts.length; k++) {
      const p = router.route(c.pts[k - 1], c.pts[k], Object.assign({}, w, { penalty: pen }));
      if (!p) { classicCache.set(key, null); return null; }
      if (c.avoidBack) for (const l of p.legs) pen[l.e] = 4;
      parts.push(p);
    }
    const labels = c.pts.slice(1, -1).map((_, k) => (c.sights && c.sights[k + 1] ? { label: c.sights[k + 1][I.lang] || c.sights[k + 1].en, sight: true } : null));
    const r = parts.length === 1 ? parts[0] : router.join(parts, labels);
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
    state.routes = r ? [{ title: { raw: c.name[I.lang] }, r, climbs: C.climbs(r), end: { raw: c.start[I.lang] }, loop: c.kind === "loop", kind: c.kind, classic: true }] : [];
    state.sel = 0;
    renderRoutes(); drawRoutes();
    if (fit && r) fitRoute(r);
  }
  let scrollT = null;
  track.addEventListener("scroll", () => {
    clearTimeout(scrollT);
    scrollT = setTimeout(() => {
      const mid = track.scrollLeft + track.clientWidth / 2;
      let best = 0, bd = Infinity;
      track.querySelectorAll(".classic-card").forEach((el, i) => { const d = Math.abs(el.offsetLeft + el.offsetWidth / 2 - mid); if (d < bd) { bd = d; best = i; } });
      if (best !== state.classic) showClassic(best, true);
    }, 140);
  });

  // ------------------------------------------------------------------ route cards and details
  function compBar(r) {
    return `<div class="bar" aria-hidden="true">${r.byTier.map((m, i) => m > 0 ? `<i style="width:${(m / r.length) * 100}%;background:${TIER_BAR[i]}"></i>` : "").join("")}</div>`;
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
  function climbSummary(r, list) {
    if (!list.length) return t("flat", { m: Math.round(r.climb) });
    const steep = list.map((c) => ({ c, max: C.climbMaxGrade(r, c) })).sort((a, b) => b.max - a.max)[0];
    const name = C.climbName(r, steep.c);
    return t(list.length > 1 ? "climbsN" : "climbs1", { n: list.length, m: Math.round(r.climb), g: I.pct(steep.max),
      on: name ? t("onStreet", { name: C.esc(I.place(name)) }) : "", rise: Math.round(steep.c.rise), d: C.fmtKm(steep.c.length) }).replace(/\s+\(/, " (");
  }
  function renderRoutes() {
    const box = $("#routes"), det = $("#detail");
    if (!state.routes.length) { box.innerHTML = ""; det.innerHTML = ""; return; }
    const classic = state.routes[0] && state.routes[0].classic;
    box.innerHTML = classic ? "" : state.routes.map((c, i) => {
      const r = c.r, gaps = C.mainGaps(r), note = routeNote(c);
      return `<button type="button" class="route-card ${i === state.sel ? "sel" : ""}" data-i="${i}">
        <div class="rc-top"><b>${C.esc(routeTitle(c))}</b><span class="time">${C.fmtMin(C.rideMinutes(r))}</span></div>
        ${note ? `<div class="rc-note">${C.esc(note)}</div>` : ""}
        <div class="rc-sub">${C.fmtKm(r.length)} · ${t("climbM", { m: Math.round(r.climb) })} · ${gaps.length ? (gaps.length > 1 ? t("gapsN", { n: gaps.length }) : t("gaps1")) : t("lanesAllWay")}</div>
        ${compBar(r)}
        <div class="rc-pct"><b>${C.fmtPct(r.infraShare)}</b> ${t(state.winter ? "on4s" : "onInfra")}</div></button>`;
    }).join("") + `<div class="routed-in">${t("routedIn", { ms: state.lastMs.toFixed(1) })}</div>`;
    box.querySelectorAll(".route-card").forEach((b) => b.addEventListener("click", () => selectRoute(b.dataset.i)));
    const sel = state.routes[state.sel], r = sel.r, gaps = C.mainGaps(r);
    const gapHtml = gaps.length
      ? `<div class="gaps">${gaps.map((g, i) => `<button type="button" class="gap-item" data-g="${i}"><span class="gi-icon">${i + 1}</span><span>${C.esc(t("gapOn", { m: Math.round(g.length), name: g.names.slice(0, 2).map(I.place).join(", ") || t("aStreet") }))}<br><small>${t(g.busy ? "busyStreet" : "quietStreet")} · ${t("after", { d: C.fmtKm(g.start) })}</small></span><span aria-hidden="true">›</span></button>`).join("")}</div>`
      : `<div class="no-gaps">${t("lanesWhole")}</div>`;
    const turns = r.maneuvers.map((m) => `<li>${C.esc(I.maneuver(m))} <span class="turn-at">· ${C.fmtKm(m.at)}</span></li>`).join("");
    const classicHead = classic ? `<div class="classic-summary"><b>${C.esc(routeTitle(sel))}</b><span>${C.fmtKm(r.length)} · ${C.fmtMin(C.rideMinutes(r))} · ${t("climbM", { m: Math.round(r.climb) })}</span>${compBar(r)}<div class="rc-pct"><b>${C.fmtPct(r.infraShare)}</b> ${t(state.winter ? "on4s" : "onInfra")}</div></div>` : "";
    const wl = state.wx && state.wxData ? `<p class="wind-note"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9h11a3 3 0 1 0-3-3M3 15h15a3 3 0 1 1-3 3"/></svg>${C.esc(windLine(r))}</p>` : "";
    det.innerHTML = `${classicHead}<h2>${t("elevation")}</h2><div class="profile">${C.profileSVG(r, { width: 336, height: 92, tierColors: TIER_BAR, gapShade: "rgba(239,143,69,.14)",
        fill: "#e6edf2", stroke: "#6f8799", text: "#7b858f", climbs: sel.climbs, climbFill: CLIMB.fill, climbText: "#7a5a3a", minRange: 30, headroom: 0.25, gaps })}</div>
      <p class="climb-note">${climbSummary(r, sel.climbs)}</p>${wl}
      <h2>${t(state.winter ? "withoutLaneWinter" : "withoutLane")}</h2>${gapHtml}
      <details class="turns"><summary>${t("turnByTurn", { n: r.maneuvers.length })}</summary><ol>${turns}</ol></details>
      <button type="button" id="ride-go" class="ride-go">${t("letsRide")}</button>
      ${gpsDefault() ? `<button type="button" id="ride-preview" class="ride-preview">${t("previewRide")}</button>` : ""}`;
    det.querySelectorAll(".gap-item").forEach((b) => b.addEventListener("click", () => {
      const g = gaps[+b.dataset.g]; const cur = C.buildCursor(r); const p = cur.at(g.start + g.length / 2);
      map.easeTo({ center: [p.lon, p.lat], zoom: 17, duration: 600 });
    }));
    $("#ride-go").onclick = () => rideTap(gpsDefault());
    if ($("#ride-preview")) $("#ride-preview").onclick = () => rideTap(false);
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
  document.querySelectorAll("#layers input[data-layer]").forEach((cb) => { toggles[cb.dataset.layer] = cb.checked; cb.addEventListener("change", () => { toggles[cb.dataset.layer] = cb.checked; applyLayers(); }); });
  function vis(id, on) { if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none"); }
  function setTerrain(on) {
    if (on === state.terrainOn) return;   // re-creating terrain is costly: only on a real change
    state.terrainOn = on;
    map.setTerrain(on ? { source: "terrain", exaggeration: CAM.terrain } : null);
  }
  function poiOn(p) {   // parks and viewpoints are always on
    if (p.group === "outdoors" && p.kind !== "culture") return true;
    if (p.kind === "metro") return toggles.metro;
    if (p.kind === "culture") return toggles.culture;
    if (p.group === "food") return toggles["pois-food"];
    if (p.group === "shopping") return toggles["pois-shop"];
    return toggles["pois-bike"];   // BIXI, water, repair, parking, toilets
  }
  function applyLayers() {
    const browse = state.mode === "explore", riding = state.mode === "ride";
    ["net-casing", "net-ab", "net-c"].forEach((id) => vis(id, toggles.network));
    vis("net-not-cleared", toggles.network && state.winter);
    if (map.getLayer("net-ab")) map.setPaintProperty("net-ab", "line-opacity", browse ? 0.9 : 0.45);
    ["planned", "construction", "construction-tape"].forEach((id) => vis(id, toggles.planned && browse && !state.winter));
    vis("closed", toggles.works);
    // while riding, roadside pop-ups replace the map's POI icons (only metro stations stay)
    const liveBixi = !!state.bixi;
    POI_LAYERS.forEach((p) => vis(p.id, riding ? p.kind === "metro" && toggles.metro : poiOn(p) && !(p.kind === "bixi" && liveBixi)));
    vis("bixi-live", liveBixi && toggles["pois-bike"] && !riding); vis("bixi-count", liveBixi && toggles["pois-bike"] && !riding);
    document.body.classList.toggle("riding", riding);
    vis("tint", toggles.tint); vis("relief", toggles.relief);
    ["contours-detail", "contours-minor", "contours-index", "contour-labels"].forEach((id) => vis(id, toggles.contours));
    vis("bld-flat", toggles.buildings && !state.is3d); vis("bld-3d", toggles.buildings && state.is3d);
    vis("radar", state.wx);
    setTerrain(toggles.terrain && state.is3d);
    // with a route on screen, keep only the POIs and works along it (plus metro stations) to cut clutter
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
      map.setFilter(p.id, ids && p.kind !== "metro" ? ["all", base, ["in", ["id"], ["literal", ids]]] : base);
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
    I.lang = l; I.save(); I.apply();
    $("#lang-btn").textContent = l === "fr" ? "EN" : "FR";
    viewBtn.title = t(viewBtn.dataset.i18nTitle || "to3d");
    strictOut.textContent = strictLabel(+strict.value); kmLabel(); renderStopChips();
    classicCache.clear(); classicsRouted = false;   // sight names are part of the route
    if (state.tab === "suggest" && state.smode === "classics") showClassic(state.classic, false); else renderClassicCards();
    if (state.from) fromEl.value = state.fromLabel; if (state.to) toEl.value = state.toLabel;
    setMapTexts(); renderRoutes(); renderWxCard(); renderSound(); buildElevationLegend();
    if (!state.ride) $("#ride-pause").textContent = t("pause");
    if (state.gpsState) gpsStatus(state.gpsState);
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
    if (!isPhone()) { panel.style.height = ""; return; }
    panel.classList.toggle("dragging", !animate);
    panel.style.height = sheetHeight(s) + "px";
  }
  (function dragSheet() {
    let y0 = 0, h0 = 0, lastY = 0, lastT = 0, vy = 0, moved = false, active = false;
    const zone = [$("#grabber"), $("#brand")];
    const down = (e) => {
      if (!isPhone() || search.which) return;
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

  // ------------------------------------------------------------------ ride (simulation)
  let audio = null;
  // iPhone Safari keeps sound and speech silent unless they start from a tap: unlock both inside "Let's ride!" (and the sound button)
  function unlockAudio() {
    try {
      audio = audio || new AudioContext();
      if (audio.state === "suspended") audio.resume();
      const s = audio.createBufferSource(); s.buffer = audio.createBuffer(1, 1, 22050); s.connect(audio.destination); s.start(0);
    } catch (e) { /* no audio */ }
  }
  function chime() {
    if (state.sound === "off") return;
    try {
      audio = audio || new AudioContext();
      [660, 880].forEach((f, i) => {
        const o = audio.createOscillator(), g = audio.createGain(); o.type = "sine"; o.frequency.value = f;
        const t2 = audio.currentTime + i * 0.16; g.gain.setValueAtTime(0, t2); g.gain.linearRampToValueAtTime(0.09, t2 + 0.02); g.gain.exponentialRampToValueAtTime(0.001, t2 + 0.3);
        o.connect(g).connect(audio.destination); o.start(t2); o.stop(t2 + 0.32);
      });
    } catch (e) { /* no audio */ }
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

  // you: a heading cone lying on the street + an upright cyclist badge facing the camera
  const coneEl = document.createElement("div"); coneEl.className = "rider-cone";
  coneEl.innerHTML = '<svg viewBox="0 0 120 120"><defs><radialGradient id="cg" cx="50%" cy="100%" r="90%"><stop offset="0" stop-color="#0095E6" stop-opacity=".55"/><stop offset="1" stop-color="#0095E6" stop-opacity="0"/></radialGradient></defs><path d="M60 64 28 6h64z" fill="url(#cg)"/><circle cx="60" cy="64" r="13" fill="#0095E6" stroke="#fff" stroke-width="5"/></svg>';
  const riderMarker = new maplibregl.Marker({ element: coneEl, rotationAlignment: "map", pitchAlignment: "map", ...MARKER_SHOW });
  const badgeEl = document.createElement("div"); badgeEl.className = "rider-badge";
  badgeEl.innerHTML = '<svg viewBox="0 0 64 78"><path d="M32 76c-3-6-22-22-22-42a22 22 0 0 1 44 0c0 20-19 36-22 42z" fill="#0095E6" stroke="#fff" stroke-width="3.5"/><g fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="21.5" cy="38" r="6.5"/><circle cx="42.5" cy="38" r="6.5"/><path d="M21.5 38l6-12h9.5l5.5 12M27.5 26l5 12h-11M34.5 21.5h5"/></g></svg>';
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
  }
  // the ride starts straight away (bird's-eye 3D); sound is a button in the ride bar. Shared by the GPS ride and the preview.
  function prepareRide(view, gps) {
    const sel = state.routes[state.sel]; if (!sel) return null;
    const r = sel.r;
    hideNotice();
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
    state.reroutes = 0; state.rerouteLog = []; state.rerouteFailAt = -1e9;
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
  // opts.replay: a pretend GPS ride ({ speedup, startAt, detourAt }) for tests; ?gps=replay&gpsx=&gpsat=&detour= does the same.
  function startGpsRide(opts = {}) {
    let geo = navigator.geolocation || null;
    const rp = opts.replay || (gpsParam === "replay" ? { speedup: +params.get("gpsx") || 1, startAt: +params.get("gpsat") || 0,
      detourAt: params.has("detour") ? +params.get("detour") : null, deny: params.has("gpsdeny") } : null);
    if (rp) geo = new C.ReplayGeo(Object.assign({ getRoute: () => state.ride && state.ride.route }, rp));
    if (!geo) { showNotice("gpsUnavailable"); return; }
    const sel = prepareRide("birdseye", true); if (!sel) return;
    const r = sel.r;
    // a reroute uses the same settings as this route: to the destination (Go somewhere),
    // or back onto the planned ride a little ahead (suggested and classic rides, which may loop or have stops)
    state.rideOpts = { w: selWeights(sel), dest: state.tab === "go" && state.to ? state.to : null, rejoin: state.tab !== "go" };
    gpsStatus({ state: "wait" });
    state.ride = new C.RideGPS(r, { geo, pois: C.routePOIs(r, window.POIS, 70), onFrame: rideFrame, onEvent: rideEvent,
      onStatus: gpsStatus, onOffRoute: rerouteFrom, onError: gpsError });
    keepAwake(true);
    state.ride.start();
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
  function newRouteFrom(from, ride, ro) {
    const cur = ride.route;
    if (ro.rejoin) {
      const D = ride.d + 250;
      if (D < cur.length - 100) {
        const p = ride.cursor.at(D), a = router.route(from, [p.lon, p.lat], ro.w);
        if (a) return C.joinRoutes(a, C.tailRoute(cur, D));
      }
      return router.route(from, cur.coords[cur.coords.length - 1], ro.w);
    }
    return router.route(from, ro.dest || cur.coords[cur.coords.length - 1], ro.w);
  }
  function rerouteFrom(p) {
    const ride = state.ride, ro = state.rideOpts; if (!ride || !ro) return false;
    const t1 = performance.now();
    let nr = null;
    try { nr = newRouteFrom([p.lon, p.lat], ride, ro); } catch (e) { console.warn("reroute failed", e); }
    state.rerouteLog.push({ at: [p.lon, p.lat], d: ride.d, ok: !!nr, ms: +(performance.now() - t1).toFixed(1), start: nr && nr.coords[0], length: nr && Math.round(nr.length) });
    if (!nr || nr.length < 1) {   // keep the old route, and say so (once a minute at most)
      if (performance.now() - state.rerouteFailAt > 60000) { toast(t("rerouteFailed")); chime(); C.voice.say(t("rerouteFailedVoice")); }
      state.rerouteFailAt = performance.now();
      return false;
    }
    state.reroutes++;
    for (const mk of poiMarkers.values()) mk.remove();
    poiMarkers.clear(); afterGapUntil = 0; lastGapId = null; sparkAt = -1e9;
    ride.setRoute(nr, C.routePOIs(nr, window.POIS, 70));
    map.getSource("route").setData(C.routePiecesGeoJSON(nr));
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
    riderMarker.setLngLat([f.pos.lon, f.pos.lat]).setRotation(f.pos.heading);
    badgeMarker.setLngLat([f.pos.lon, f.pos.lat]);
    // turn card
    const L = f.look;
    if (L.next) { $("#turn-dist").textContent = C.fmtKm(L.nextDist); $("#turn-text").textContent = I.maneuver(L.next); $("#turn-icon").innerHTML = `<svg viewBox="0 0 46 46">${TURN_SVG[turnIcon(L.next)]}</svg>`; }
    else { $("#turn-dist").textContent = C.fmtKm(f.total - f.d); $("#turn-text").textContent = t("arrive", { name: state.rideEnd }); $("#turn-icon").innerHTML = `<svg viewBox="0 0 46 46">${TURN_SVG.arrive}</svg>`; }
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
      `<path d="${area}" fill="#e9e4dc"/><path d="${area}" fill="${CLIMB.spark}" clip-path="url(#hc-clip)"/>` +
      `<path d="${line}" fill="none" stroke="${CLIMB.ink}" stroke-width="1.4" stroke-linejoin="round"/>` +
      `<circle cx="${X(d).toFixed(1)}" cy="${Y(C.elevAt(r, d)).toFixed(1)}" r="3.8" fill="#0095E6" stroke="#fff" stroke-width="1.6"/></svg>`;
  }
  function rideEvent(ev) {
    if (ev.type === "gap") { chime(); C.voice.say(C.gapSentence(ev.gap, ev.dist)); }
    if (ev.type === "turn") C.voice.say(I.maneuver(ev.m));
    if (ev.type === "hill") C.voice.say(t("climbVoice", { m: Math.round(ev.hill.rise) }));
    if (ev.type === "arrived") { C.voice.say(t("arrivedVoice")); toast(t("arrived")); setTimeout(endRide, 2500); }
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
  $("#ride-exit").onclick = endRide;
  function endRide() {
    const wasGps = !!(state.ride && state.ride.gps), rerouted = state.reroutes > 0;
    if (state.ride) state.ride.pause(); state.ride = null;
    if (wasGps) keepAwake(false);
    if (map.terrain) map.terrain.exaggeration = CAM.terrain;
    state.hillK = 0; state.follow = true; glide = null; showRider(true);
    riderMarker.remove(); badgeMarker.remove(); for (const mk of poiMarkers.values()) mk.remove(); poiMarkers.clear();
    $("#ride-hud").hidden = true; $("#hill-card").hidden = true; $("#ride-recenter").hidden = true; $("#panel").hidden = false; $("#legend").hidden = false; document.querySelector(".map-controls").hidden = false;
    map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
    setMode(state.routes.length ? "route" : "explore"); afterGapUntil = 0; lastGapId = null;
    if (rerouted) drawRoutes();   // the planned routes again, not the reroute
    refreshSections(); wind.show(state.wx); renderWxCard();
    if (state.routes.length) fitRoute(state.routes[state.sel].r);
  }

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
    const BG = [242, 243, 240];
    const stops = ramp.map(([m, rgba], i) => {
      const [r, g, b, a] = rgba.match(/[\d.]+/g).map(Number);
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
  if (params.get("wx") === "1") setWeather(true);
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
  if (params.get("ride") === "gps" && state.routes.length) startGpsRide();
  else if (params.get("ride") && state.routes.length) {
    startRide(params.get("ride") === "top" ? "topdown" : "birdseye");
    if (params.has("at")) { state.snap = true; state.ride.seek(+params.get("at")); }
    if (params.has("paused")) pauseRide(true);
  }
  window.__app = { map, router, state, set3d, startRide, recompute, computeRoutes, computeSuggestions, showClassic, setTab, setSuggMode,
    setWinter, setWeather, setLang, setSheet, suggester, pauseRide, CAM, classicRoute, enterSearch, cancelSearch, poiMarkers,
    startGpsRide, endRide, gpsDefault, setFollow, riderMarker };
})();
