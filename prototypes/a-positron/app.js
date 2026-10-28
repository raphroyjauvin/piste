/* Prototype A: Positron light. MapLibre GL JS + our in-browser router. */
(async function () {
  "use strict";
  const C = window.BikeCommon;
  const { Router, weightsFor, PROFILES } = window.BikeRouter;
  const $ = (s) => document.querySelector(s);

  // ------------------------------------------------------------------ palette (STM metro colours, softened gap orange)
  const COL = {
    a: "#0095E6", b: "#6cc3f2", c: "#0095E6", gap: "#ef8f45", gapQuiet: "#f2a865", closed: "#d7263d",
    rev: "#00a62a", netA: "#2fb350", netB: "#5cc471", netC: "#8fd49d", planned: "#d9b400", alt: "#9aa5ae",
  };
  const TIER_BAR = ["#0095E6", "#6cc3f2", "#a6d9f6", "#f6bf8f", "#ef8f45", "#d7263d"];

  // ------------------------------------------------------------------ router + data
  const t0 = performance.now();
  const router = new Router(window.GRAPH_STUDY);
  const geocoder = C.makeGeocoder(router);
  const buildings = C.unpackBuildings(window.BUILDINGS_PACKED);
  console.log(`router ready in ${(performance.now() - t0).toFixed(0)} ms: ${router.n} nodes, ${router.m} edges`);

  const nodeNames = new Map();
  for (let e = 0; e < router.m; e++) {
    const nm = router.names[router.ename[e]]; if (!nm) continue;
    for (const v of [router.ea[e], router.eb[e]]) { let s = nodeNames.get(v); if (!s) nodeNames.set(v, (s = new Set())); s.add(nm); }
  }
  function placeLabel(lon, lat) {
    const s = router.snap(lon, lat); if (!s) return "Dropped pin";
    const v = s.t < 0.5 ? router.ea[s.e] : router.eb[s.e];
    const main = router.names[router.ename[s.e]];
    const cross = [...(nodeNames.get(v) || [])].find((n) => n !== main);
    if (main && cross) return `${main} near ${cross}`;
    return main || cross || "Dropped pin";
  }

  const state = { from: null, to: null, fromLabel: "", toLabel: "", routes: [], sel: 0, mode: "explore", is3d: false,
    trip: null, pick: null, ride: null, rideView: "birdseye", lastMs: 0 };

  // ------------------------------------------------------------------ basemap style (OpenFreeMap Positron, our buildings instead of theirs)
  let style;
  try {
    style = await (await fetch("https://tiles.openfreemap.org/styles/positron")).json();
    style.layers = style.layers.filter((l) => l.id !== "building");
    for (const l of style.layers) {
      if (l.id === "water") l.paint["fill-color"] = "#c9dde9";
      if (l.id === "park") { l.paint["fill-color"] = "#dcebd8"; l.paint["fill-opacity"] = 0.9; }
    }
  } catch (e) {
    style = { version: 8, glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf", sources: {},
      layers: [{ id: "background", type: "background", paint: { "background-color": "#f2f3f0" } }] };
    toast("Basemap offline: showing our data only");
  }
  const map = new maplibregl.Map({
    container: "map", style, center: [-73.567, 45.536], zoom: 13.2, maxPitch: 80,
    attributionControl: { compact: true, customAttribution: "Ville de Montréal (CC BY 4.0) · NRCan HRDEM 2023 · STM · BIXI" },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");
  await new Promise((r) => map.on("load", r));

  const firstSymbol = (map.getStyle().layers.find((l) => l.type === "symbol") || {}).id;
  const firstRoad = (map.getStyle().layers.find((l) => /^(tunnel|highway|road)/.test(l.id)) || {}).id || firstSymbol;
  const add = (layer, before = firstSymbol) => map.addLayer(layer, map.getLayer(before) ? before : undefined);

  // ------------------------------------------------------------------ sources
  map.addSource("relief", { type: "image", url: "../shared/data/" + window.HILLSHADE.url, coordinates: window.HILLSHADE.coordinates });
  map.addSource("contours", { type: "geojson", data: window.CONTOURS });
  map.addSource("bld", { type: "geojson", data: buildings });
  map.addSource("network", { type: "geojson", data: window.BIKE_NETWORK });
  map.addSource("planned", { type: "geojson", data: window.PLANNED });
  map.addSource("pois", { type: "geojson", data: C.poisGeoJSON(window.POIS) });
  map.addSource("terrain", { type: "raster-dem", tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"], encoding: "terrarium", tileSize: 256, maxzoom: 14 });
  const empty = { type: "FeatureCollection", features: [] };
  for (const id of ["route", "route-alts", "gaps", "ends", "engines"]) map.addSource(id, { type: "geojson", data: empty });

  // ------------------------------------------------------------------ layers (bottom to top)
  add({ id: "relief", type: "raster", source: "relief", paint: { "raster-opacity": 0.75, "raster-fade-duration": 0 } }, firstRoad);
  add({ id: "contours", type: "line", source: "contours", minzoom: 12.5,
    paint: { "line-color": "#b9a37f", "line-opacity": ["case", ["==", ["get", "i"], 1], 0.55, 0.32], "line-width": ["case", ["==", ["get", "i"], 1], 0.9, 0.5] } }, firstRoad);
  add({ id: "bld-flat", type: "fill", source: "bld", minzoom: 14, paint: { "fill-color": "#e7e4de", "fill-outline-color": "#d9d5cd" } });
  add({ id: "bld-3d", type: "fill-extrusion", source: "bld", minzoom: 14, layout: { visibility: "none" },
    paint: { "fill-extrusion-color": ["interpolate", ["linear"], ["get", "h"], 0, "#f1eee8", 25, "#e6e2db", 90, "#d9d3ca"],
      "fill-extrusion-height": ["get", "h"], "fill-extrusion-base": 0, "fill-extrusion-opacity": 0.82, "fill-extrusion-vertical-gradient": true } });
  // bike network
  add({ id: "net-casing", type: "line", source: "network", layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 1.6, 16, 6] } });
  add({ id: "net-ab", type: "line", source: "network", filter: ["<=", ["get", "t"], 1], layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ["case", ["==", ["get", "rev"], 1], COL.rev, ["==", ["get", "t"], 0], COL.netA, COL.netB],
      "line-width": ["interpolate", ["linear"], ["zoom"], 12, ["case", ["==", ["get", "rev"], 1], 2, 1], 16, ["case", ["==", ["get", "rev"], 1], 4.4, ["==", ["get", "t"], 0], 3.2, 2.3]],
      "line-opacity": 0.9 } });
  add({ id: "net-c", type: "line", source: "network", filter: ["==", ["get", "t"], 2],
    paint: { "line-color": COL.netC, "line-width": ["interpolate", ["linear"], ["zoom"], 12, 0.8, 16, 2], "line-dasharray": [2, 1.5] } });
  // planned & construction (browse only), closures and works (always, toggle)
  add({ id: "planned", type: "line", source: "planned", filter: ["==", ["get", "status"], "planned"], layout: { visibility: "none" },
    paint: { "line-color": COL.planned, "line-width": ["interpolate", ["linear"], ["zoom"], 12, 1.2, 16, 3], "line-dasharray": [2, 1.6], "line-opacity": 0.9 } });
  add({ id: "construction", type: "line", source: "planned", filter: ["==", ["get", "status"], "construction"], layout: { visibility: "none" },
    paint: { "line-color": "#ffd900", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 2, 16, 5] } });
  add({ id: "construction-tape", type: "line", source: "planned", filter: ["==", ["get", "status"], "construction"], layout: { visibility: "none" },
    paint: { "line-color": "#2a2a2a", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 2, 16, 5], "line-dasharray": [0.5, 1.1] } });
  add({ id: "closed", type: "line", source: "planned", filter: ["==", ["get", "status"], "closed"],
    paint: { "line-color": COL.closed, "line-width": 3, "line-dasharray": [1, 1] } });
  // engine comparison
  add({ id: "engines", type: "line", source: "engines", layout: { visibility: "none", "line-cap": "round" },
    paint: { "line-color": ["get", "color"], "line-width": 2.5, "line-opacity": 0.85, "line-offset": ["get", "off"] } });
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
  // labels and points on top
  add({ id: "contour-labels", type: "symbol", source: "contours", minzoom: 14, filter: ["==", ["get", "i"], 1],
    layout: { "symbol-placement": "line", "text-field": ["concat", ["to-string", ["get", "e"]], " m"], "text-font": ["Noto Sans Regular"], "text-size": 10, "symbol-spacing": 420 },
    paint: { "text-color": "#9b8968", "text-halo-color": "#fbfaf7", "text-halo-width": 1.4 } }, undefined);

  await C.addMapIcons(map);
  map.addImage("pill", pillImage("#fdf1e6", "#f3c29a"), { pixelRatio: 2, stretchX: [[20, 44]], stretchY: [[16, 24]], content: [14, 6, 50, 34] });
  const POI_LAYERS = [];
  for (const [kind, k] of Object.entries(C.POI_KINDS)) {
    if (kind === "works") continue;
    const id = "poi-" + kind; POI_LAYERS.push({ id, group: k.group });
    map.addLayer({ id, type: "symbol", source: "pois", minzoom: k.minzoom, filter: ["==", ["get", "k"], kind],
      layout: { "icon-image": ["get", "icon"], "icon-size": ["interpolate", ["linear"], ["zoom"], 13, 0.72, 17, 1], "icon-padding": 1,
        "text-field": ["step", ["zoom"], "", 16.5, ["get", "name"]], "text-font": ["Noto Sans Regular"], "text-size": 11,
        "text-offset": [0, 1.35], "text-anchor": "top", "text-optional": true, "symbol-sort-key": kind === "metro" ? 0 : kind === "bixi" ? 1 : 5 },
      paint: { "text-color": "#4a525a", "text-halo-color": "#ffffff", "text-halo-width": 1.3 } });
  }
  map.addLayer({ id: "works", type: "symbol", source: "planned", filter: ["==", ["get", "status"], "works"], minzoom: 13,
    layout: { "icon-image": "poi-works", "icon-size": ["interpolate", ["linear"], ["zoom"], 13, 0.6, 17, 0.95], "icon-allow-overlap": true } });
  map.addSource("works-near", { type: "geojson", data: empty });
  map.addLayer({ id: "works-near", type: "symbol", source: "works-near",
    layout: { "icon-image": "poi-works", "icon-size": ["interpolate", ["linear"], ["zoom"], 13, 0.7, 17, 1], "icon-allow-overlap": true } });
  map.addLayer({ id: "gap-labels", type: "symbol", source: "gaps",
    layout: { "icon-image": "pill", "icon-text-fit": "both", "icon-text-fit-padding": [3, 7, 3, 7], "text-field": ["concat", ["to-string", ["get", "len"]], " m no bike lane"],
      "text-font": ["Noto Sans Bold"], "text-size": 12, "text-anchor": "bottom", "text-offset": [0, -1.2], "icon-allow-overlap": true, "text-allow-overlap": true },
    paint: { "text-color": "#8a3f0a" } });
  map.addLayer({ id: "ends", type: "circle", source: "ends",
    paint: { "circle-radius": 8, "circle-color": ["match", ["get", "k"], "from", "#ffffff", "#0095E6"],
      "circle-stroke-color": ["match", ["get", "k"], "from", "#0095E6", "#ffffff"], "circle-stroke-width": 3.5 } });

  // ------------------------------------------------------------------ UI: trips, search, prefs
  const chips = $("#trip-chips");
  for (const t of window.TRIPS) {
    const b = document.createElement("button");
    b.className = "chip"; b.textContent = t.name.replace("Parc La Fontaine to Avenue du Parc, along Rachel", "Rachel (easy)")
      .replace("Mont-Royal metro to Avenue Papineau", "Mont-Royal → Papineau").replace("Assomption metro to the Biodôme", "Assomption → Biodôme")
      .replace("Assomption metro to Ontario / Davidson", "Assomption → Ontario/Davidson");
    b.title = t.name; b.dataset.trip = t.id;
    b.onclick = () => useTrip(t);
    chips.appendChild(b);
  }
  function useTrip(t) {
    state.trip = t;
    setPoint("from", t.from.lonlat, t.from.label, false);
    setPoint("to", t.to.lonlat, t.to.label, false);
    document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c.dataset.trip === t.id));
    $("#engines-row").hidden = false;
    computeRoutes(true);
  }

  const strict = $("#strict"), strictOut = $("#strict-out"), hills = $("#hills");
  function strictLabel(v) { return v < 20 ? "Most direct" : v < 45 ? "Mostly direct" : v < 70 ? "Balanced" : v < 92 ? "Bike lanes first" : "Bike lanes, whatever it takes"; }
  strict.addEventListener("input", () => { strictOut.textContent = strictLabel(+strict.value); computeRoutes(false); });
  hills.addEventListener("change", () => computeRoutes(false));
  strictOut.textContent = strictLabel(+strict.value);

  const fromEl = $("#from"), toEl = $("#to"), sug = $("#suggest");
  let sugItems = [], sugActive = -1, sugTarget = null, sugTimer = null;
  for (const el of [fromEl, toEl]) {
    el.addEventListener("input", () => {
      sugTarget = el.id; clearTimeout(sugTimer);
      sugTimer = setTimeout(async () => { sugItems = await geocoder.search(el.value); sugActive = -1; renderSuggest(); }, 160);
    });
    el.addEventListener("keydown", (e) => {
      if (sug.hidden) return;
      if (e.key === "ArrowDown") { sugActive = Math.min(sugItems.length - 1, sugActive + 1); renderSuggest(); e.preventDefault(); }
      if (e.key === "ArrowUp") { sugActive = Math.max(0, sugActive - 1); renderSuggest(); e.preventDefault(); }
      if (e.key === "Enter" && sugItems.length) { choose(sugItems[Math.max(0, sugActive)]); e.preventDefault(); }
      if (e.key === "Escape") sug.hidden = true;
    });
    el.addEventListener("blur", () => setTimeout(() => (sug.hidden = true), 180));
  }
  function renderSuggest() {
    if (!sugItems.length) { sug.hidden = true; return; }
    sug.style.top = sugTarget === "from" ? "48px" : "96px";
    sug.innerHTML = sugItems.map((it, i) => `<li data-i="${i}" class="${i === sugActive ? "active" : ""}"><span>${C.esc(it.label)}</span><small>${C.esc(it.sub || "")}</small></li>`).join("");
    sug.hidden = false;
    sug.querySelectorAll("li").forEach((li) => li.addEventListener("mousedown", (e) => { e.preventDefault(); choose(sugItems[+li.dataset.i]); }));
  }
  function choose(it) { sug.hidden = true; setPoint(sugTarget, [it.lon, it.lat], it.label, true); state.trip = null; markTripChips(); computeRoutes(true); }
  function markTripChips() { document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", state.trip && c.dataset.trip === state.trip.id)); $("#engines-row").hidden = !state.trip; if (!state.trip) setLayer("engines", false); }

  document.querySelectorAll(".pick").forEach((b) => b.addEventListener("click", () => {
    state.pick = state.pick === b.dataset.target ? null : b.dataset.target;
    document.querySelectorAll(".pick").forEach((x) => x.classList.toggle("on", x.dataset.target === state.pick));
    map.getCanvas().style.cursor = state.pick ? "crosshair" : "";
  }));

  // draggable endpoints
  const markers = {};
  function endEl(kind) { const d = document.createElement("div"); d.style.cssText = `width:22px;height:22px;border-radius:50%;cursor:grab;box-shadow:0 2px 6px rgba(0,0,0,.25);${kind === "from" ? "background:#fff;border:5px solid #0095E6" : "background:#0095E6;border:5px solid #fff;outline:2px solid #0095E6"}`; return d; }
  function setPoint(which, lonlat, label, fromUser) {
    state[which] = lonlat; state[which + "Label"] = label;
    (which === "from" ? fromEl : toEl).value = label;
    if (!markers[which]) {
      markers[which] = new maplibregl.Marker({ element: endEl(which), draggable: true }).setLngLat(lonlat).addTo(map);
      let raf = null;
      markers[which].on("drag", () => {
        if (raf) return;
        raf = requestAnimationFrame(() => { raf = null; const p = markers[which].getLngLat(); state[which] = [p.lng, p.lat]; computeRoutes(false); });
      });
      markers[which].on("dragend", () => {
        const p = markers[which].getLngLat(); const lab = placeLabel(p.lng, p.lat);
        state[which] = [p.lng, p.lat]; state[which + "Label"] = lab; (which === "from" ? fromEl : toEl).value = lab;
        state.trip = null; markTripChips(); computeRoutes(false);
      });
    } else markers[which].setLngLat(lonlat);
    if (fromUser) { state.trip = null; markTripChips(); }
  }

  map.on("click", (e) => {
    if (state.mode === "ride") return;
    const hit = map.queryRenderedFeatures(e.point, { layers: POI_LAYERS.map((p) => p.id).filter((id) => map.getLayer(id)) });
    if (hit.length && !state.pick) { poiPopup(hit[0], e.lngLat); return; }
    const alt = map.queryRenderedFeatures(e.point, { layers: ["route-alts"] });
    if (alt.length && !state.pick) { selectRoute(alt[0].properties.i); return; }
    const lonlat = [e.lngLat.lng, e.lngLat.lat];
    const which = state.pick || (!state.from ? "from" : "to");
    setPoint(which, lonlat, placeLabel(lonlat[0], lonlat[1]), true);
    state.pick = null; document.querySelectorAll(".pick").forEach((x) => x.classList.remove("on")); map.getCanvas().style.cursor = "";
    computeRoutes(!state.routes.length);
  });
  function poiPopup(f, lngLat) {
    const k = C.POI_KINDS[f.properties.k] || {};
    const html = `<div style="font:14px/1.35 var(--font-ui);min-width:160px"><b>${C.esc(f.properties.name || k.label)}</b><div style="color:#7b858f;font-size:12px">${C.esc(k.label || "")}</div>
      <button id="poi-go" class="primary" style="margin-top:8px;padding:7px 10px;font-size:13px">Ride here</button></div>`;
    const pop = new maplibregl.Popup({ offset: 14 }).setLngLat(f.geometry.coordinates).setHTML(html).addTo(map);
    pop.getElement().querySelector("#poi-go").onclick = () => {
      pop.remove(); setPoint("to", f.geometry.coordinates, f.properties.name || k.label, true);
      if (!state.from) toast("Now pick a start: click the map or type it"); computeRoutes(true);
    };
  }
  map.on("mouseenter", "route-alts", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "route-alts", () => (map.getCanvas().style.cursor = state.pick ? "crosshair" : ""));

  // ------------------------------------------------------------------ routing
  function overlap(a, b) { let c = 0; for (const e of a.sig) if (b.sig.has(e)) c++; return c / Math.max(a.sig.size, b.sig.size); }
  function computeRoutes(fit) {
    if (!state.from || !state.to) { renderRoutes(); return; }
    const t = performance.now();
    const w = weightsFor(+strict.value / 100, hills.checked);
    const cands = [
      { label: "Your route", r: router.route(state.from, state.to, w) },
      { label: "Most bike lanes", r: router.route(state.from, state.to, { w: PROFILES.bikemax.w, hill: hills.checked ? 12 : 4 }) },
      { label: "Most direct", r: router.route(state.from, state.to, { w: PROFILES.direct.w, hill: hills.checked ? 12 : 0 }) },
    ].filter((c) => c.r);
    state.lastMs = performance.now() - t;
    cands.forEach((c) => (c.sig = new Set(c.r.legs.map((l) => l.e))));
    const keep = [];
    for (const c of cands) if (!keep.some((k) => overlap(k, c) > 0.9)) keep.push(c);
    state.routes = keep; state.sel = 0;
    renderRoutes(); drawRoutes();
    if (fit && keep.length) fitRoute(keep[0].r);
  }
  function selectRoute(i) { state.sel = +i; renderRoutes(); drawRoutes(); }
  function fitRoute(r) {
    const xs = r.coords.map((c) => c[0]), ys = r.coords.map((c) => c[1]);
    const narrow = innerWidth < 760;
    map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]],
      { padding: narrow ? { top: 70, bottom: innerHeight * 0.55, left: 30, right: 30 } : { top: 80, bottom: 80, left: 420, right: 90 }, maxZoom: 16, duration: 700 });
  }
  function drawRoutes() {
    const sel = state.routes[state.sel];
    map.getSource("route").setData(sel ? C.routePiecesGeoJSON(sel.r) : empty);
    map.getSource("gaps").setData(sel ? C.gapStartsGeoJSON(sel.r) : empty);
    map.getSource("route-alts").setData({ type: "FeatureCollection", features: state.routes.map((c, i) => i === state.sel ? null : C.routeLineGeoJSON(c.r, { i })).filter(Boolean) });
    const ends = [];
    if (state.from) ends.push({ type: "Feature", geometry: { type: "Point", coordinates: state.from }, properties: { k: "from" } });
    if (state.to) ends.push({ type: "Feature", geometry: { type: "Point", coordinates: state.to }, properties: { k: "to" } });
    map.getSource("ends").setData({ type: "FeatureCollection", features: [] });
    updateEngines();
    setMode(sel ? "route" : "explore");
  }

  function compBar(r) {
    return `<div class="bar" aria-hidden="true">${r.byTier.map((m, i) => m > 0 ? `<i style="width:${(m / r.length) * 100}%;background:${TIER_BAR[i]}"></i>` : "").join("")}</div>`;
  }
  function renderRoutes() {
    const box = $("#routes"), det = $("#detail");
    $("#explore-note").hidden = state.routes.length > 0;
    if (!state.routes.length) { box.innerHTML = ""; det.innerHTML = ""; return; }
    box.innerHTML = state.routes.map((c, i) => {
      const r = c.r;
      return `<button class="route-card ${i === state.sel ? "sel" : ""}" data-i="${i}">
        <div class="rc-top"><b>${c.label}</b><span class="time">${C.fmtMin(C.rideMinutes(r))}</span></div>
        <div class="rc-sub">${C.fmtKm(r.length)} · climb ${Math.round(r.climb)} m · ${r.gaps.length ? r.gaps.length + (r.gaps.length > 1 ? " stretches" : " stretch") + " without a bike lane" : "bike lanes all the way"}</div>
        ${compBar(r)}
        <div class="rc-pct"><b>${C.fmtPct(r.infraShare)}</b> on bike infrastructure</div></button>`;
    }).join("") + `<div style="font-size:11px;color:var(--ink-3)">Routed on this device in ${state.lastMs.toFixed(1)} ms</div>`;
    box.querySelectorAll(".route-card").forEach((b) => b.addEventListener("click", () => selectRoute(b.dataset.i)));
    const r = state.routes[state.sel].r;
    const gaps = r.gaps.length
      ? `<div class="gaps">${r.gaps.map((g, i) => `<button class="gap-item" data-g="${i}"><span class="gi-icon">${i + 1}</span><span>${Math.round(g.length)} m on ${C.esc(g.names.slice(0, 2).join(", ") || "a street")}<br><small>${g.busy ? "Busy street, ride with traffic" : "Quiet street"} · after ${C.fmtKm(g.start)}</small></span><span aria-hidden="true">›</span></button>`).join("")}</div>`
      : `<div class="no-gaps">Bike infrastructure the whole way.</div>`;
    const turns = r.maneuvers.map((m) => `<li>${C.esc(m.text)} <span style="color:var(--ink-3)">· ${C.fmtKm(m.at)}</span></li>`).join("");
    det.innerHTML = `<h2>Elevation</h2><div class="profile">${C.profileSVG(r, { width: 336, height: 86, tierColors: TIER_BAR, gapShade: "rgba(239,143,69,.16)", fill: "#e3ecf2", stroke: "#7d98ab", text: "#7b858f" })}</div>
      <h2>Without a bike lane</h2>${gaps}
      <details class="turns"><summary>Turn by turn (${r.maneuvers.length})</summary><ol>${turns}</ol></details>
      <button id="ride-go" class="ride-go">Ride this route</button>`;
    det.querySelectorAll(".gap-item").forEach((b) => b.addEventListener("click", () => {
      const g = r.gaps[+b.dataset.g]; const cur = C.buildCursor(r); const p = cur.at(g.start + g.length / 2);
      map.easeTo({ center: [p.lon, p.lat], zoom: 17, duration: 600 });
    }));
    $("#ride-go").onclick = openSheet;
  }

  // ------------------------------------------------------------------ engines comparison
  const ENGINE_COLORS = { "OSRM bike (OSM)": "#7a7f87", "Valhalla bicycle, use_roads 0.0": "#8e5bd0", "BRouter safety": "#0f9d8f" };
  function updateEngines() {
    const t = state.trip; const feats = [];
    if (t && window.ENGINE_ROUTES && window.ENGINE_ROUTES[t.id]) {
      let off = -4;
      for (const [name, color] of Object.entries(ENGINE_COLORS)) {
        const c = window.ENGINE_ROUTES[t.id][name]; if (!c) continue;
        feats.push({ type: "Feature", geometry: { type: "LineString", coordinates: c }, properties: { name, color, off } }); off += 4;
      }
    }
    map.getSource("engines").setData({ type: "FeatureCollection", features: feats });
  }

  // ------------------------------------------------------------------ layers panel & modes
  const layerBtn = $("#layers-btn"), layersBox = $("#layers");
  layerBtn.onclick = () => { layersBox.hidden = !layersBox.hidden; layerBtn.setAttribute("aria-expanded", String(!layersBox.hidden)); };
  const toggles = {};
  document.querySelectorAll("#layers input[data-layer]").forEach((cb) => { toggles[cb.dataset.layer] = cb.checked; cb.addEventListener("change", () => setLayer(cb.dataset.layer, cb.checked)); });
  function vis(id, on) { if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none"); }
  function setLayer(name, on) {
    toggles[name] = on;
    const cb = document.querySelector(`#layers input[data-layer="${name}"]`); if (cb) cb.checked = on;
    applyLayers();
  }
  function applyLayers() {
    const browse = state.mode === "explore";
    ["net-casing", "net-ab", "net-c"].forEach((id) => vis(id, toggles.network));
    ["net-ab"].forEach((id) => map.getLayer(id) && map.setPaintProperty(id, "line-opacity", state.mode === "explore" ? 0.9 : 0.45));
    ["planned", "construction", "construction-tape"].forEach((id) => vis(id, toggles.planned && browse));
    vis("closed", toggles.works);
    POI_LAYERS.forEach((p) => vis(p.id, (p.group === "food" && toggles["pois-food"]) || ((p.group === "bike" || p.group === "services") && toggles["pois-bike"]) || ((p.group === "outdoors" || p.group === "transit") && toggles["pois-out"])));
    vis("relief", toggles.relief); vis("contours", toggles.contours); vis("contour-labels", toggles.contours);
    vis("bld-flat", toggles.buildings && !state.is3d); vis("bld-3d", toggles.buildings && state.is3d);
    vis("engines", toggles.engines && !!state.trip && state.mode !== "ride");
    map.setTerrain(toggles.terrain && state.is3d ? { source: "terrain", exaggeration: 1.6 } : null);
    // with a route on screen, keep only the POIs and works along it (plus metro stations) to cut clutter
    const sel = state.routes[state.sel];
    if (sel && state.mode !== "explore") {
      const cur = C.buildCursor(sel.r);
      const near = window.PLANNED.features.filter((f) => f.properties.status === "works" && cur.locate(f.geometry.coordinates[0], f.geometry.coordinates[1]).d < 150);
      map.getSource("works-near").setData({ type: "FeatureCollection", features: near });
    }
    vis("works", toggles.works && state.mode === "explore"); vis("works-near", toggles.works && state.mode !== "explore");
    const ids = sel && state.mode !== "explore" ? C.routePOIs(sel.r, window.POIS, 90).map((p) => p.i) : null;
    POI_LAYERS.forEach((p) => {
      const kind = p.id.slice(4);
      const base = ["==", ["get", "k"], kind];
      map.setFilter(p.id, ids && kind !== "metro" ? ["all", base, ["in", ["id"], ["literal", ids]]] : base);
    });
  }
  function setMode(m) { state.mode = m; applyLayers(); }

  // 2D / 3D (bird's-eye with a narrow lens = near-axonometric)
  const viewBtn = $("#view-btn");
  function set3d(on, animate = true) {
    state.is3d = on;
    viewBtn.classList.toggle("is3d", on); $("#ride-view").classList.toggle("is3d", on);
    $("#view-label").textContent = on ? "3D" : "2D";
    map.setVerticalFieldOfView(on ? 22 : 36.87);
    applyLayers();
    if (state.mode !== "ride" && animate) map.easeTo({ pitch: on ? 58 : 0, bearing: on ? -34 : 0, zoom: Math.max(map.getZoom(), on ? 15.2 : map.getZoom()), duration: 900 });
  }
  viewBtn.onclick = () => set3d(!state.is3d);
  applyLayers();

  // ------------------------------------------------------------------ ride (simulation)
  const sheet = $("#sheet");
  function openSheet() {
    $("#opt-cmd").disabled = !C.voice.commandsSupported;
    if (!C.voice.commandsSupported) $("#opt-cmd").parentElement.classList.add("off");
    sheet.hidden = false; $("#sheet-start").focus();
  }
  $("#sheet-cancel").onclick = () => (sheet.hidden = true);
  $("#sheet-start").onclick = () => { sheet.hidden = true; startRide(); };

  let audio = null;
  function chime() {
    if (!$("#opt-chime").checked) return;
    try {
      audio = audio || new AudioContext();
      [660, 880].forEach((f, i) => {
        const o = audio.createOscillator(), g = audio.createGain(); o.type = "sine"; o.frequency.value = f;
        const t = audio.currentTime + i * 0.16; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.09, t + 0.02); g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
        o.connect(g).connect(audio.destination); o.start(t); o.stop(t + 0.32);
      });
    } catch (e) { /* no audio */ }
  }

  const TURN_SVG = {
    straight: '<path d="M23 38V10M14 19l9-9 9 9"/>', left: '<path d="M30 38V22a6 6 0 0 0-6-6H12M19 9l-7 7 7 7"/>',
    right: '<path d="M16 38V22a6 6 0 0 1 6-6h12M27 9l7 7-7 7"/>', slightL: '<path d="M28 38V24L16 12M16 21v-9h9"/>',
    slightR: '<path d="M18 38V24l12-12M30 21v-9h-9"/>', arrive: '<path d="M14 38V8M14 9h17l-4 6 4 6H14"/>',
  };
  function turnKind(text) { return /Sharp left|Turn left/.test(text) ? "left" : /Sharp right|Turn right/.test(text) ? "right" : /Slight left/.test(text) ? "slightL" : /Slight right/.test(text) ? "slightR" : "straight"; }

  // you: a heading cone lying on the street + an upright cyclist badge facing the camera
  const coneEl = document.createElement("div"); coneEl.className = "rider-cone";
  coneEl.innerHTML = '<svg viewBox="0 0 120 120"><defs><radialGradient id="cg" cx="50%" cy="100%" r="90%"><stop offset="0" stop-color="#0095E6" stop-opacity=".55"/><stop offset="1" stop-color="#0095E6" stop-opacity="0"/></radialGradient></defs><path d="M60 64 28 6h64z" fill="url(#cg)"/><circle cx="60" cy="64" r="13" fill="#0095E6" stroke="#fff" stroke-width="5"/></svg>';
  const riderMarker = new maplibregl.Marker({ element: coneEl, rotationAlignment: "map", pitchAlignment: "map" });
  const badgeEl = document.createElement("div"); badgeEl.className = "rider-badge";
  badgeEl.innerHTML = '<svg viewBox="0 0 64 78"><path d="M32 76c-3-6-22-22-22-42a22 22 0 0 1 44 0c0 20-19 36-22 42z" fill="#0095E6" stroke="#fff" stroke-width="3.5"/><g fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="21.5" cy="38" r="6.5"/><circle cx="42.5" cy="38" r="6.5"/><path d="M21.5 38l6-12h9.5l5.5 12M27.5 26l5 12h-11M34.5 21.5h5"/></g></svg>';
  const badgeMarker = new maplibregl.Marker({ element: badgeEl, anchor: "bottom", pitchAlignment: "viewport", rotationAlignment: "viewport" });
  const poiMarkers = new Map();
  let rec = null, smoothBearing = 0, afterGapUntil = 0, lastGapId = null;

  function startRide() {
    const sel = state.routes[state.sel]; if (!sel) return;
    const r = sel.r;
    C.voice.enabled = $("#opt-voice").checked;
    state.rideView = document.querySelector('input[name="opt-view"]:checked').value;
    $("#panel").hidden = true; $("#legend").hidden = true; document.querySelector(".map-controls").hidden = true;
    $("#ride-hud").hidden = false; setMode("ride");
    set3d(state.rideView === "birdseye", false);
    map.setPadding({ top: 170, bottom: Math.round(innerHeight * 0.36), left: 0, right: 0 });
    riderMarker.setLngLat(r.coords[0]).addTo(map); badgeMarker.setLngLat(r.coords[0]).addTo(map);
    Object.values(markers).forEach((m) => (m.getElement().style.display = "none"));
    smoothBearing = map.getBearing();
    const pois = C.routePOIs(r, window.POIS, 70);
    state.ride = new C.RideSim(r, { mult: 4, pois, onFrame: rideFrame, onEvent: rideEvent });
    if ($("#opt-cmd").checked && C.voice.commandsSupported) {
      rec = C.voice.listen({ pause: () => pauseRide(true), resume: () => pauseRide(false), "next": () => { const l = state.ride.lookahead || null; C.voice.say($("#turn-text").textContent); } });
      toast('Voice commands on: say "pause", "resume" or "next turn"');
    }
    state.ride.start();
  }
  function lerpAngle(a, b, t) { const d = ((b - a + 540) % 360) - 180; return a + d * t; }
  function rideFrame(f) {
    const r = state.ride.route;
    smoothBearing = lerpAngle(smoothBearing, f.pos.heading, 0.12);
    const bird = state.rideView === "birdseye";
    map.jumpTo({ center: [f.pos.lon, f.pos.lat], bearing: smoothBearing, pitch: bird ? 62 : 0, zoom: bird ? 17.3 : 16.7 });
    riderMarker.setLngLat([f.pos.lon, f.pos.lat]).setRotation(f.pos.heading);
    badgeMarker.setLngLat([f.pos.lon, f.pos.lat]);
    // turn card
    const L = f.look;
    if (L.next) { $("#turn-dist").textContent = C.fmtKm(L.nextDist); $("#turn-text").textContent = L.next.text; $("#turn-icon").innerHTML = `<svg viewBox="0 0 46 46">${TURN_SVG[turnKind(L.next.text)]}</svg>`; }
    else { $("#turn-dist").textContent = C.fmtKm(f.total - f.d); $("#turn-text").textContent = "Arrive at " + (state.toLabel || "destination"); $("#turn-icon").innerHTML = `<svg viewBox="0 0 46 46">${TURN_SVG.arrive}</svg>`; }
    // gap card: calm, specific
    const card = $("#gap-card");
    if (L.inGap) {
      const left = L.inGap.start + L.inGap.length - f.d; lastGapId = L.inGap.start;
      card.className = "gap-card inside"; card.hidden = false;
      card.innerHTML = `<span class="gc-icon">!</span><span>No bike lane for <b>${C.fmtKm(left)}</b>${L.inGap.names[0] ? " on " + C.esc(L.inGap.names[0]) : ""}. ${L.inGap.busy ? "Ride with traffic." : "Quiet street."}</span>`;
    } else if (L.nextGap && L.nextGapDist <= 400) {
      card.className = "gap-card"; card.hidden = false;
      card.innerHTML = `<span class="gc-icon">!</span><span>In <b>${C.fmtKm(L.nextGapDist)}</b>: ${Math.round(L.nextGap.length)} m without a bike lane${L.nextGap.names[0] ? " on " + C.esc(L.nextGap.names[0]) : ""}${L.nextGap.busy ? " · busy street" : ""}</span>`;
    } else if (lastGapId !== null && performance.now() < afterGapUntil) {
      card.className = "gap-card ok"; card.hidden = false; card.innerHTML = `<span class="gc-icon">✓</span><span>Back on a bike lane</span>`;
    } else card.hidden = true;
    if (lastGapId !== null && !L.inGap && afterGapUntil === 0) afterGapUntil = performance.now() + 5000;
    if (L.inGap) afterGapUntil = 0;
    // hill chip
    const hc = $("#hill-chip");
    if (L.hill && L.hill.start + L.hill.length > f.d) {
      const ahead = L.hill.start - f.d;
      hc.hidden = false; hc.textContent = ahead > 0 ? `Climb in ${C.fmtKm(ahead)}: +${Math.round(L.hill.rise)} m over ${C.fmtKm(L.hill.length)} (${Math.round(L.hill.grade * 100)}%)` : `Climbing: ${Math.round(L.hill.grade * 100)}% for ${C.fmtKm(L.hill.start + L.hill.length - f.d)}`;
    } else hc.hidden = true;
    // progress
    $("#progress").style.width = `${(f.d / f.total) * 100}%`;
    $("#ride-remaining").textContent = `${C.fmtKm(f.total - f.d)} · ${C.fmtMin(((f.total - f.d) / 1000 / 16) * 60)}`;
    // roadside POIs: pop up as you approach, on their real side of the street
    const live = new Set();
    for (const p of L.pois) {
      const ahead = p.along - f.d; live.add(p.i);
      let mk = poiMarkers.get(p.i);
      if (!mk) {
        const el = document.createElement("div"); el.className = "poi-pop";
        el.innerHTML = `<img alt="" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(C.iconSVG(p.kind, { size: 60, lines: p.extra }))}"><span>${C.esc(p.name || C.POI_KINDS[p.kind].label)}</span>`;
        mk = new maplibregl.Marker({ element: el, anchor: p.side < 0 ? "right" : "left", offset: [p.side < 0 ? -6 : 6, 0] }).setLngLat([p.lon, p.lat]).addTo(map);
        poiMarkers.set(p.i, mk);
      }
      const s = Math.max(0.7, Math.min(1.25, 1.35 - ahead / 320));
      mk.getElement().style.transform += ""; mk.getElement().firstChild.style.transform = `scale(${s})`;
      mk.getElement().querySelector("span").style.opacity = ahead < 140 && ahead > -10 ? 1 : 0;
      mk.getElement().style.opacity = ahead < -15 ? 0 : 1;
    }
    for (const [i, mk] of poiMarkers) if (!live.has(i)) { mk.remove(); poiMarkers.delete(i); }
  }
  function rideEvent(ev) {
    if (ev.type === "gap") { chime(); C.voice.say(C.gapSentence(ev.gap, ev.dist)); }
    if (ev.type === "turn") C.voice.say(ev.m.text);
    if (ev.type === "hill") C.voice.say(`Climb ahead, plus ${Math.round(ev.hill.rise)} metres.`);
    if (ev.type === "arrived") { C.voice.say("You have arrived."); toast("Arrived. Nice ride."); setTimeout(endRide, 2500); }
  }
  function pauseRide(p) { if (!state.ride) return; if (p) { state.ride.pause(); $("#ride-pause").textContent = "Resume"; } else { state.ride.start(); $("#ride-pause").textContent = "Pause"; } }
  $("#ride-pause").onclick = () => pauseRide(state.ride && state.ride.running);
  $("#ride-speed").onclick = () => { if (!state.ride) return; const m = { 1: 4, 4: 10, 10: 1 }[state.ride.mult] || 4; state.ride.mult = m; $("#ride-speed").textContent = m + "×"; };
  $("#ride-view").onclick = () => { state.rideView = state.rideView === "birdseye" ? "topdown" : "birdseye"; set3d(state.rideView === "birdseye", false); };
  $("#ride-exit").onclick = endRide;
  function endRide() {
    if (state.ride) state.ride.pause(); state.ride = null;
    if (rec) { rec._keep = false; rec.stop(); rec = null; }
    riderMarker.remove(); badgeMarker.remove(); for (const mk of poiMarkers.values()) mk.remove(); poiMarkers.clear();
    Object.values(markers).forEach((m) => (m.getElement().style.display = ""));
    $("#ride-hud").hidden = true; $("#panel").hidden = false; $("#legend").hidden = false; document.querySelector(".map-controls").hidden = false;
    map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
    setMode(state.routes.length ? "route" : "explore"); afterGapUntil = 0; lastGapId = null;
    if (state.routes.length) fitRoute(state.routes[state.sel].r);
  }

  // ------------------------------------------------------------------ helpers
  function pillImage(fill, stroke) {
    const c = document.createElement("canvas"); c.width = 64; c.height = 40; const x = c.getContext("2d");
    x.fillStyle = fill; x.strokeStyle = stroke; x.lineWidth = 2;
    x.beginPath(); x.roundRect(2, 2, 60, 36, 14); x.fill(); x.stroke();
    return x.getImageData(0, 0, 64, 40);
  }
  let toastT = null;
  function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 3200); }

  // open with a trip so the first view shows what the tool does
  const params = new URLSearchParams(location.search);
  const startTrip = window.TRIPS.find((t) => t.id === (params.get("trip") || "montroyal"));
  if (startTrip) useTrip(startTrip);
  if (params.get("view") === "3d") set3d(true);
  window.__app = { map, router, state, useTrip, set3d, startRide, computeRoutes };
})();
