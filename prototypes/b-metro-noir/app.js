/* Prototype B: Métro Noir. The route as a metro line on a dark canvas; strip map; side rails; metro view. */
(async function () {
  "use strict";
  const C = window.BikeCommon;
  const { Router, weightsFor, PROFILES, buildCursor, distM } = window.BikeRouter;
  const $ = (s) => document.querySelector(s);
  const STM = C.STM;
  const TIER_COL = [STM.green, STM.blue, STM.yellow, "#e8823d", STM.orange, "#e0384f"];
  const TIER_NAME = ["green line: protected", "blue line: painted", "yellow line: shared", "orange: no bike lane", "orange: no bike lane", "closed"];

  const router = new Router(window.GRAPH_STUDY);
  const geocoder = C.makeGeocoder(router);
  const state = { from: null, to: null, fromLabel: "", toLabel: "", routes: [], sel: 0, mode: "explore", is3d: false, planned: false, trip: null, ride: null, rideView: "birdseye" };

  // ------------------------------------------------------------------ dark basemap (OpenFreeMap "dark", recoloured toward a neutral charcoal)
  let style;
  try {
    style = await (await fetch("https://tiles.openfreemap.org/styles/dark")).json();
    style.layers = style.layers.filter((l) => !/^building|^boundary|road_oneway/.test(l.id));
    for (const l of style.layers) {
      const p = (l.paint = l.paint || {});
      if (l.type === "background") p["background-color"] = "#15171a";
      else if (l.id === "water") p["fill-color"] = "#0c1822";
      else if (/park|wood|landcover/.test(l.id) && l.type === "fill") { p["fill-color"] = "#18231c"; p["fill-opacity"] = 0.9; }
      else if (/residential/.test(l.id)) { p["fill-color"] = "#17191c"; }
      else if (l.type === "line" && /motorway/.test(l.id)) p["line-color"] = "#3b4047";
      else if (l.type === "line" && /major/.test(l.id)) p["line-color"] = "#30353b";
      else if (l.type === "line" && /minor|path|pier/.test(l.id)) p["line-color"] = "#25292e";
      else if (l.type === "line" && /rail/.test(l.id)) p["line-color"] = "#2c3035";
      else if (l.type === "line" && /waterway/.test(l.id)) p["line-color"] = "#0c1822";
      else if (l.type === "symbol") { p["text-color"] = "#7f878f"; p["text-halo-color"] = "#15171a"; p["text-halo-width"] = 1.2; }
    }
  } catch (e) {
    style = { version: 8, glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf", sources: {}, layers: [{ id: "background", type: "background", paint: { "background-color": "#15171a" } }] };
  }
  const map = new maplibregl.Map({ container: "map", style, center: [-73.567, 45.536], zoom: 13.2, maxPitch: 80,
    attributionControl: { compact: true, customAttribution: "Ville de Montréal (CC BY 4.0) · NRCan HRDEM 2023 · STM GTFS · BIXI" } });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
  await new Promise((r) => map.on("load", r));
  const firstSymbol = (map.getStyle().layers.find((l) => l.type === "symbol") || {}).id;
  const firstRoad = (map.getStyle().layers.find((l) => /^(tunnel|highway|road)/.test(l.id)) || {}).id || firstSymbol;
  const add = (layer, before = firstSymbol) => map.addLayer(layer, map.getLayer(before) ? before : undefined);
  const empty = { type: "FeatureCollection", features: [] };

  map.addSource("relief", { type: "image", url: "../shared/data/" + window.HILLSHADE.url, coordinates: window.HILLSHADE.coordinates });
  map.addSource("contours", { type: "geojson", data: window.CONTOURS });
  map.addSource("bld", { type: "geojson", data: C.unpackBuildings(window.BUILDINGS_PACKED) });
  map.addSource("network", { type: "geojson", data: window.BIKE_NETWORK });
  map.addSource("planned", { type: "geojson", data: window.PLANNED });
  map.addSource("pois", { type: "geojson", data: C.poisGeoJSON(window.POIS) });
  map.addSource("stm", { type: "geojson", data: { type: "FeatureCollection", features: window.METRO.lines.map((l) => ({ type: "Feature", properties: { color: l.color }, geometry: { type: "LineString", coordinates: l.coords } })) } });
  for (const id of ["route", "alts", "stations", "rider"]) map.addSource(id, { type: "geojson", data: empty });

  add({ id: "relief", type: "raster", source: "relief", paint: { "raster-opacity": 0.45 } }, firstRoad);
  add({ id: "contours", type: "line", source: "contours", minzoom: 13, paint: { "line-color": "#3a4047", "line-width": ["case", ["==", ["get", "i"], 1], 0.8, 0.45] } }, firstRoad);
  add({ id: "bld-flat", type: "fill", source: "bld", minzoom: 14, paint: { "fill-color": "#1d2024", "fill-outline-color": "#272b30" } });
  add({ id: "bld-3d", type: "fill-extrusion", source: "bld", minzoom: 14, layout: { visibility: "none" },
    paint: { "fill-extrusion-color": ["interpolate", ["linear"], ["get", "h"], 0, "#22262b", 40, "#2b3036", 120, "#363c43"], "fill-extrusion-height": ["get", "h"], "fill-extrusion-opacity": 0.92, "fill-extrusion-vertical-gradient": true } });
  add({ id: "stm", type: "line", source: "stm", paint: { "line-color": ["get", "color"], "line-width": ["interpolate", ["linear"], ["zoom"], 11, 1.2, 16, 3], "line-opacity": 0.28, "line-dasharray": [1, 1.6] } });
  add({ id: "net", type: "line", source: "network", layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": STM.green, "line-opacity": ["case", ["==", ["get", "rev"], 1], 0.55, 0.3], "line-width": ["interpolate", ["linear"], ["zoom"], 12, ["case", ["==", ["get", "rev"], 1], 1.8, 0.8], 16, ["case", ["==", ["get", "rev"], 1], 4, 2]] } });
  add({ id: "planned", type: "line", source: "planned", filter: ["==", ["get", "status"], "planned"], layout: { visibility: "none" },
    paint: { "line-color": STM.yellow, "line-opacity": 0.75, "line-width": ["interpolate", ["linear"], ["zoom"], 12, 1.2, 16, 3], "line-dasharray": [2, 1.6] } });
  add({ id: "construction", type: "line", source: "planned", filter: ["==", ["get", "status"], "construction"], layout: { visibility: "none" },
    paint: { "line-color": STM.yellow, "line-width": ["interpolate", ["linear"], ["zoom"], 12, 2, 16, 5] } });
  add({ id: "construction-tape", type: "line", source: "planned", filter: ["==", ["get", "status"], "construction"], layout: { visibility: "none" },
    paint: { "line-color": "#111", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 2, 16, 5], "line-dasharray": [0.5, 1.1] } });
  add({ id: "alts", type: "line", source: "alts", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#5b6168", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 4, 17, 9], "line-opacity": 0.8 } });
  add({ id: "route-casing", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#08090a", "line-width": ["interpolate", ["linear"], ["zoom"], 11, 9, 14, 13, 17, 21] } });
  add({ id: "route", type: "line", source: "route", layout: { "line-cap": "butt", "line-join": "round" },
    paint: { "line-color": ["match", ["get", "tier"], 0, TIER_COL[0], 1, TIER_COL[1], 2, TIER_COL[2], 3, TIER_COL[3], 4, TIER_COL[4], TIER_COL[5]], "line-width": ["interpolate", ["linear"], ["zoom"], 11, 5.5, 14, 8, 17, 13] } });

  await C.addMapIcons(map, { ring: "#111" });
  const POI_LAYERS = [];
  for (const [kind, k] of Object.entries(C.POI_KINDS)) {
    if (kind === "works") continue;
    POI_LAYERS.push("poi-" + kind);
    map.addLayer({ id: "poi-" + kind, type: "symbol", source: "pois", minzoom: k.minzoom, filter: ["==", ["get", "k"], kind],
      layout: { "icon-image": ["get", "icon"], "icon-size": ["interpolate", ["linear"], ["zoom"], 13, 0.7, 17, 0.95] } });
  }
  map.addLayer({ id: "works", type: "symbol", source: "planned", minzoom: 13, filter: ["==", ["get", "status"], "works"], layout: { "icon-image": "poi-works", "icon-size": 0.8, "icon-allow-overlap": true } });
  map.addLayer({ id: "stations", type: "circle", source: "stations",
    paint: { "circle-radius": ["case", ["==", ["get", "kind"], "term"], 9, 6], "circle-color": "#ffffff", "circle-stroke-color": "#0b0c0e", "circle-stroke-width": ["case", ["==", ["get", "kind"], "term"], 4, 3] } });
  map.addLayer({ id: "station-labels", type: "symbol", source: "stations", minzoom: 14,
    layout: { "text-field": ["get", "label"], "text-font": ["Noto Sans Bold"], "text-size": ["case", ["==", ["get", "kind"], "term"], 14, 12], "text-anchor": "left", "text-offset": [1.1, 0], "text-max-width": 14, "text-optional": true },
    paint: { "text-color": "#ffffff", "text-halo-color": "#0b0c0e", "text-halo-width": 2 } });

  // ------------------------------------------------------------------ planner UI
  for (const t of window.TRIPS) {
    const b = document.createElement("button"); b.className = "trip"; b.dataset.trip = t.id;
    b.textContent = { rachel: "Rachel", montroyal: "Mont-Royal → Papineau", biodome: "Assomption → Biodôme", davidson: "Assomption → Davidson" }[t.id] || t.name;
    b.onclick = () => useTrip(t); $("#trips").appendChild(b);
  }
  function useTrip(t) {
    state.trip = t; state.from = t.from.lonlat; state.to = t.to.lonlat; state.fromLabel = t.from.label; state.toLabel = t.to.label;
    $("#from").value = t.from.label; $("#to").value = t.to.label;
    document.querySelectorAll(".trip").forEach((b) => b.classList.toggle("on", b.dataset.trip === t.id));
    route(true);
  }
  $("#strict").addEventListener("input", () => route(false));
  let sugT = null, sugFor = null, items = [];
  for (const el of [$("#from"), $("#to")]) {
    el.addEventListener("input", () => { sugFor = el.id; clearTimeout(sugT); sugT = setTimeout(async () => { items = await geocoder.search(el.value); renderSug(); }, 160); });
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" && items.length) { pick(items[0]); e.preventDefault(); } });
    el.addEventListener("blur", () => setTimeout(() => ($("#suggest").hidden = true), 160));
  }
  function renderSug() {
    const s = $("#suggest"); if (!items.length) { s.hidden = true; return; }
    s.style.top = sugFor === "from" ? "106px" : "150px";
    s.innerHTML = items.map((it, i) => `<li data-i="${i}">${C.esc(it.label)}<small>${C.esc(it.sub || "")}</small></li>`).join(""); s.hidden = false;
    s.querySelectorAll("li").forEach((li) => li.addEventListener("mousedown", (e) => { e.preventDefault(); pick(items[+li.dataset.i]); }));
  }
  function pick(it) { $("#suggest").hidden = true; state[sugFor] = [it.lon, it.lat]; state[sugFor + "Label"] = it.label; $("#" + sugFor).value = it.label; state.trip = null; document.querySelectorAll(".trip").forEach((b) => b.classList.remove("on")); route(true); }
  map.on("click", (e) => {
    if (state.mode === "ride") return;
    const alt = map.queryRenderedFeatures(e.point, { layers: ["alts"] });
    if (alt.length) { state.sel = alt[0].properties.i; render(); return; }
    const ll = [e.lngLat.lng, e.lngLat.lat]; const k = !state.from || state.to ? "from" : "to";
    if (k === "from") { state.to = null; $("#to").value = ""; }
    state[k] = ll; state[k + "Label"] = "Pin on map"; $("#" + k).value = "Pin on map"; state.trip = null; route(k === "to");
  });

  // ------------------------------------------------------------------ routing + rendering
  function route(fit) {
    if (!state.from || !state.to) { state.routes = []; render(); return; }
    const w = weightsFor(+$("#strict").value / 100, false);
    const c = [
      { name: "Your line", r: router.route(state.from, state.to, w) },
      { name: "Bike-lane line", r: router.route(state.from, state.to, { w: PROFILES.bikemax.w, hill: 4 }) },
      { name: "Direct line", r: router.route(state.from, state.to, { w: PROFILES.direct.w, hill: 0 }) },
    ].filter((x) => x.r);
    c.forEach((x) => (x.sig = new Set(x.r.legs.map((l) => l.e))));
    const keep = []; for (const x of c) if (!keep.some((k) => [...k.sig].filter((e) => x.sig.has(e)).length / Math.max(k.sig.size, x.sig.size) > 0.9)) keep.push(x);
    state.routes = keep; state.sel = 0; render();
    if (fit && keep.length) {
      const xs = keep[0].r.coords.map((p) => p[0]), ys = keep[0].r.coords.map((p) => p[1]);
      map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: { top: 90, bottom: 240, left: 380, right: 340 }, maxZoom: 16, duration: 700 });
    }
  }
  function stationsOf(r) {
    const cur = buildCursor(r), st = [];
    st.push({ d: 0, kind: "term", label: state.fromLabel || "Start" });
    for (const m of r.maneuvers.slice(1)) st.push({ d: m.at, kind: "turn", label: m.text.replace(/^(Turn|Slight|Sharp) (left|right) onto |^Continue on /, "") });
    for (const g of r.gaps) { st.push({ d: g.start, kind: "gap", label: `${Math.round(g.length)} m no bike lane` }); }
    st.push({ d: r.length, kind: "term", label: state.toLabel || "Destination" });
    st.sort((a, b) => a.d - b.d);
    const out = []; for (const s of st) { if (out.length && Math.abs(out[out.length - 1].d - s.d) < 25 && s.kind !== "term" && s.kind !== "gap") continue; out.push(s); }
    out.forEach((s) => { const p = cur.at(s.d); s.lon = p.lon; s.lat = p.lat; });
    return out;
  }
  function render() {
    const sel = state.routes[state.sel];
    state.mode = state.ride ? "ride" : sel ? "route" : "explore";
    map.getSource("route").setData(sel ? C.routePiecesGeoJSON(sel.r) : empty);
    map.getSource("alts").setData({ type: "FeatureCollection", features: state.routes.map((x, i) => (i === state.sel ? null : C.routeLineGeoJSON(x.r, { i }))).filter(Boolean) });
    const st = sel ? stationsOf(sel.r) : [];
    map.getSource("stations").setData({ type: "FeatureCollection", features: st.map((s) => ({ type: "Feature", geometry: { type: "Point", coordinates: [s.lon, s.lat] }, properties: { kind: s.kind, label: s.label } })) });
    // planned only while browsing
    ["planned", "construction", "construction-tape"].forEach((id) => map.setLayoutProperty(id, "visibility", state.planned && state.mode === "explore" ? "visible" : "none"));
    $("#planned-btn").classList.toggle("on", state.planned);
    // POIs: corridor only once a line is chosen
    const ids = sel ? C.routePOIs(sel.r, window.POIS, 90).map((p) => p.i) : null;
    POI_LAYERS.forEach((id) => { const kind = id.slice(4); map.setFilter(id, ids && kind !== "metro" ? ["all", ["==", ["get", "k"], kind], ["in", ["id"], ["literal", ids]]] : ["==", ["get", "k"], kind]); });
    map.setPaintProperty("net", "line-opacity", sel ? ["case", ["==", ["get", "rev"], 1], 0.3, 0.16] : ["case", ["==", ["get", "rev"], 1], 0.55, 0.3]);
    // works blocking bike lanes: all of them while browsing, only those near the line once one is chosen
    if (sel) {
      const cur = buildCursor(sel.r);
      const near = window.PLANNED.features.map((f, i) => [f, i]).filter(([f]) => f.properties.status === "works" && cur.locate(f.geometry.coordinates[0], f.geometry.coordinates[1]).d < 150).map(([f]) => f.properties.name + "|" + f.properties.from + "|" + f.properties.to);
      map.setFilter("works", ["all", ["==", ["get", "status"], "works"], ["in", ["concat", ["get", "name"], "|", ["get", "from"], "|", ["get", "to"]], ["literal", near]]]);
    } else map.setFilter("works", ["==", ["get", "status"], "works"]);
    // line cards
    const lines = $("#lines");
    lines.innerHTML = state.routes.map((x, i) => {
      const r = x.r, dom = r.byTier.indexOf(Math.max(...r.byTier));
      return `<button class="line-card ${i === state.sel ? "sel" : ""}" data-i="${i}"><span class="num" style="background:${TIER_COL[dom]};color:${dom === 2 ? "#111" : "#fff"}">${i + 1}</span>
        <span><b>${x.name}</b><small>${C.fmtKm(r.length)} · ${C.fmtPct(r.infraShare)} bike infra · ${r.gaps.length} gap${r.gaps.length === 1 ? "" : "s"}</small></span><span class="min">${Math.round(C.rideMinutes(r))}<small style="font-size:12px"> min</small></span>
        <span class="mini">${r.byTier.map((m, t) => (m > 0 ? `<i style="width:${(m / r.length) * 100}%;background:${TIER_COL[t]}"></i>` : "")).join("")}</span></button>`;
    }).join("");
    lines.querySelectorAll(".line-card").forEach((b) => (b.onclick = () => { state.sel = +b.dataset.i; render(); }));
    $("#strip").hidden = !sel;
    if (sel) drawStrip(sel.r, state.ride ? state.ride.d : 0);
  }

  // ------------------------------------------------------------------ strip map (the whole trip as one metro line)
  function drawStrip(r, d) {
    const box = $("#strip-svg"); const W = Math.max(600, box.clientWidth || 1000), H = 150, x0 = 20, x1 = W - 20, yL = 78;
    const X = (dd) => x0 + (dd / r.length) * (x1 - x0);
    $("#strip-title").textContent = state.ride ? "On your line" : state.routes[state.sel].name;
    $("#strip-meta").textContent = `${C.fmtKm(r.length)} · ${C.fmtMin(C.rideMinutes(r))} · ${C.fmtPct(r.infraShare)} on bike infrastructure · climb ${Math.round(r.climb)} m`;
    let s = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Strip map of the route">`;
    // elevation, faint, behind the line
    if (r.profile && r.profile.length > 1) {
      const zs = r.profile.map((p) => p[1]); let zmin = Math.min(...zs), zmax = Math.max(...zs); if (zmax - zmin < 10) zmax = zmin + 10;
      const Y = (z) => yL - 8 - ((z - zmin) / (zmax - zmin)) * 34;
      s += `<path d="M${X(0)} ${yL - 8}${r.profile.map((p) => `L${X(p[0]).toFixed(1)} ${Y(p[1]).toFixed(1)}`).join("")}L${X(r.length)} ${yL - 8}Z" fill="rgba(255,255,255,.06)" stroke="rgba(255,255,255,.18)"/>`;
    }
    for (const p of r.pieces) s += `<rect x="${X(p.start).toFixed(1)}" y="${yL - 5}" width="${Math.max(1, X(p.start + p.length) - X(p.start)).toFixed(1)}" height="10" fill="${TIER_COL[p.tier]}"/>`;
    for (const g of r.gaps) s += `<text x="${X(g.start + g.length / 2).toFixed(1)}" y="${yL + 22}" text-anchor="middle" font-size="13" font-weight="700" fill="#f3a46b">${Math.round(g.length)} m no bike lane</text>`;
    // stations with alternating labels
    const st = stationsOf(r).filter((x) => x.kind !== "gap"); let lastX = -99, up = true;
    for (const x of st) {
      const xx = X(x.d), term = x.kind === "term";
      s += `<circle cx="${xx.toFixed(1)}" cy="${yL}" r="${term ? 8 : 5.5}" fill="#fff" stroke="#0b0c0e" stroke-width="${term ? 3.5 : 2.5}"/>`;
      if (term || xx - lastX > 70) {
        const y = up ? yL - 52 : yL + 44; up = !up; lastX = xx;
        const anchor = xx < x0 + 40 ? "start" : xx > x1 - 40 ? "end" : "middle";
        s += `<text x="${xx.toFixed(1)}" y="${y}" text-anchor="${anchor}" font-size="${term ? 15 : 13}" font-weight="${term ? 700 : 600}" fill="${term ? "#fff" : "#c9ced4"}">${C.esc(x.label.toUpperCase()).slice(0, 34)}</text>`;
      }
    }
    // POIs: left side above the line, right side below
    let lastPx = { "-1": -99, "1": -99 };
    for (const p of C.routePOIs(r, window.POIS, 60)) {
      const xx = X(p.along); if (xx - lastPx[p.side] < 22) continue; lastPx[p.side] = xx;
      const y = p.side < 0 ? yL - 32 : yL + 26;
      s += `<image href="data:image/svg+xml;charset=utf-8,${encodeURIComponent(C.iconSVG(p.kind, { size: 40, lines: p.extra, ring: "#111" }))}" x="${(xx - 9).toFixed(1)}" y="${y - 9}" width="18" height="18"/>`;
    }
    // you
    const xr = X(d);
    s += `<circle cx="${xr.toFixed(1)}" cy="${yL}" r="11" fill="#fff" opacity=".25"/><circle cx="${xr.toFixed(1)}" cy="${yL}" r="6" fill="#fff" stroke="#0b0c0e" stroke-width="3"/>`;
    s += `<text x="${x0}" y="${H - 6}" font-size="11" fill="#868d95">LEFT SIDE ABOVE THE LINE · RIGHT SIDE BELOW</text></svg>`;
    box.innerHTML = s;
  }
  window.addEventListener("resize", () => { const sel = state.routes[state.sel]; if (sel) drawStrip(sel.r, state.ride ? state.ride.d : 0); });

  // ------------------------------------------------------------------ tools
  function set3d(on) {
    state.is3d = on; ["#view-btn", "#ride-view"].forEach((s) => $(s).classList.toggle("is3d", on)); $("#view-label").textContent = on ? "3D" : "2D";
    map.setLayoutProperty("bld-3d", "visibility", on ? "visible" : "none"); map.setLayoutProperty("bld-flat", "visibility", on ? "none" : "visible");
    map.setVerticalFieldOfView(on ? 20 : 36.87);
    if (!state.ride) map.easeTo({ pitch: on ? 58 : 0, bearing: on ? -34 : 0, duration: 900 });
  }
  $("#view-btn").onclick = () => set3d(!state.is3d);
  $("#planned-btn").onclick = () => { state.planned = !state.planned; if (state.planned && state.mode !== "explore") toast("Planned routes show while browsing. Clear the route to see them."); render(); };
  $("#metro-btn").onclick = () => openMetro();
  $("#metro-close").onclick = () => ($("#metro").hidden = true);

  // ------------------------------------------------------------------ metro view: octilinear schematic of the route
  function openMetro() {
    const sel = state.routes[state.sel]; if (!sel) { toast("Pick a trip first"); return; }
    const r = sel.r, st = stationsOf(r).filter((x) => x.kind !== "gap");
    const lat0 = st[0].lat, kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
    // rotate so Montreal's street grid is axis-aligned (+34°), then snap each hop to 45°
    const rot = 34 * Math.PI / 180;
    const P = st.map((s) => { const x = (s.lon - st[0].lon) * kx, y = (s.lat - lat0) * ky; return [x * Math.cos(rot) - y * Math.sin(rot), x * Math.sin(rot) + y * Math.cos(rot)]; });
    const pts = [[0, 0]];
    for (let i = 1; i < P.length; i++) {
      const dx = P[i][0] - P[i - 1][0], dy = P[i][1] - P[i - 1][1];
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const L = Math.max(110, Math.pow(Math.hypot(dx, dy), 0.75) * 3);
      pts.push([pts[i - 1][0] + Math.cos(ang) * L, pts[i - 1][1] + Math.sin(ang) * L]);
    }
    const box = $("#metro-svg"); const W = box.clientWidth || 1200, H = box.clientHeight || 700, m = 150;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const sc = Math.min((W - 2 * m) / Math.max(1, Math.max(...xs) - Math.min(...xs)), (H - 2 * m) / Math.max(1, Math.max(...ys) - Math.min(...ys)));
    const T = ([x, y]) => [m + (x - Math.min(...xs)) * sc + ((W - 2 * m) - (Math.max(...xs) - Math.min(...xs)) * sc) / 2, H - m - (y - Math.min(...ys)) * sc - ((H - 2 * m) - (Math.max(...ys) - Math.min(...ys)) * sc) / 2];
    const S = pts.map(T);
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Route drawn as a metro line">`;
    // label placement with collision checks
    const boxes = [];
    const fits = (b) => b.x0 > 8 && b.x1 < W - 8 && b.y0 > 8 && b.y1 < H - 60 && !boxes.some((o) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0);
    function place(text, ax, ay, size, weight, color, prefer, force) {
      const w = text.length * size * 0.5 + 6, h = size * 1.15;
      const cands = prefer.map(([dx, dy, anchor]) => {
        const x = ax + dx, y = ay + dy, x0 = anchor === "start" ? x : anchor === "end" ? x - w : x - w / 2;
        return { x, y, anchor, b: { x0, x1: x0 + w, y0: y - h * 0.8, y1: y + h * 0.25 } };
      });
      const c = cands.find((c) => fits(c.b)) || (force ? cands[0] : null);
      if (!c) return "";
      boxes.push(c.b);
      return `<text x="${c.x.toFixed(1)}" y="${c.y.toFixed(1)}" text-anchor="${c.anchor}" font-size="${size}" font-weight="${weight}" fill="${color}">${C.esc(text)}</text>`;
    }
    const around = (r0) => [[r0, 6, "start"], [-r0, 6, "end"], [0, -r0, "middle"], [0, r0 + 14, "middle"], [r0, -r0, "start"], [-r0, -r0, "end"], [r0, r0 + 8, "start"], [-r0, r0 + 8, "end"]];
    // hops drawn as proportional sub-segments, one colour per tier, so stretches without a bike lane stay visible
    let labelsSvg = "";
    for (let i = 1; i < S.length; i++) {
      const d0 = st[i - 1].d, d1 = st[i].d, span = Math.max(1, d1 - d0);
      for (const p of r.pieces) {
        const a = Math.max(d0, p.start), b = Math.min(d1, p.start + p.length); if (b <= a) continue;
        const t0 = (a - d0) / span, t1 = (b - d0) / span;
        const x0 = S[i - 1][0] + (S[i][0] - S[i - 1][0]) * t0, y0 = S[i - 1][1] + (S[i][1] - S[i - 1][1]) * t0;
        const x1 = S[i - 1][0] + (S[i][0] - S[i - 1][0]) * t1, y1 = S[i - 1][1] + (S[i][1] - S[i - 1][1]) * t1;
        s += `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" stroke="${TIER_COL[p.tier]}" stroke-width="16" stroke-linecap="butt"/>`;
      }
    }
    // caps at both ends of the line
    s += `<circle cx="${S[0][0]}" cy="${S[0][1]}" r="8" fill="${TIER_COL[r.pieces[0].tier]}"/><circle cx="${S[S.length - 1][0]}" cy="${S[S.length - 1][1]}" r="8" fill="${TIER_COL[r.pieces[r.pieces.length - 1].tier]}"/>`;
    // stations (turns and the two ends); reserve their discs first
    st.forEach((x, i) => { const [sx, sy] = S[i]; const R = x.kind === "term" ? 16 : 12; boxes.push({ x0: sx - R, x1: sx + R, y0: sy - R, y1: sy + R }); });
    st.forEach((x, i) => {
      const [sx, sy] = S[i], term = x.kind === "term";
      s += term ? `<rect x="${sx - 14}" y="${sy - 14}" width="28" height="28" rx="14" fill="#fff" stroke="#000" stroke-width="5"/>` : `<circle cx="${sx}" cy="${sy}" r="10" fill="#fff" stroke="#000" stroke-width="4"/>`;
      labelsSvg += place(term ? x.label.toUpperCase() : x.label, sx, sy, term ? 24 : 18, term ? 700 : 600, "#fff", around(term ? 30 : 22), term);
    });
    // stretches without a bike lane: label at the middle of the orange part
    const cur = buildCursor(r);
    for (const g of r.gaps) {
      const mid = g.start + g.length / 2; let i = st.findIndex((x) => x.d >= mid); if (i < 1) i = 1;
      const t = (mid - st[i - 1].d) / Math.max(1, st[i].d - st[i - 1].d);
      const gx = S[i - 1][0] + (S[i][0] - S[i - 1][0]) * t, gy = S[i - 1][1] + (S[i][1] - S[i - 1][1]) * t;
      labelsSvg += place(`${Math.round(g.length)} m no bike lane`, gx, gy, 16, 700, "#f3a46b", around(20), false);
    }
    // nearby real metro stations as transfers
    const LINE_COL = { "1": STM.green, "2": STM.orange, "4": STM.yellow, "5": STM.blue };
    const transfers = window.METRO.stations.map((ms) => ({ ms, loc: cur.locate(ms.lon, ms.lat) })).filter((t) => t.loc.d < 220);
    for (const t of transfers) {
      let best = 0, bd = Infinity; st.forEach((x, i) => { const dd = Math.abs(x.d - t.loc.along); if (dd < bd) { bd = dd; best = i; } });
      const [sx, sy] = S[best]; const cols = (t.ms.lines.length ? t.ms.lines : ["2"]).map((l) => LINE_COL[l]);
      const spots = [[46, -46], [-46, -46], [46, 46], [-46, 46], [0, -70], [0, 70]];
      const spot = spots.find(([dx, dy]) => fits({ x0: sx + dx - 18, x1: sx + dx + 18, y0: sy + dy - 18, y1: sy + dy + 18 })) || spots[0];
      const cx = sx + spot[0], cy = sy + spot[1]; boxes.push({ x0: cx - 18, x1: cx + 18, y0: cy - 18, y1: cy + 18 });
      s += `<line x1="${sx}" y1="${sy}" x2="${cx}" y2="${cy}" stroke="#666" stroke-width="2" stroke-dasharray="3 4"/>` + cols.map((c, k) => `<circle cx="${cx}" cy="${cy}" r="${16 - k * 5}" fill="#000" stroke="${c}" stroke-width="4"/>`).join("");
      labelsSvg += place(`Metro ${t.ms.name}`, cx, cy, 15, 600, "#cfcfcf", around(24), false);
    }
    s += labelsSvg;
    s += `<g transform="translate(24,${H - 46})" font-size="15" fill="#bbb"><rect width="22" height="8" y="-7" fill="${STM.green}"/><text x="30">Protected</text><rect x="120" width="22" height="8" y="-7" fill="${STM.blue}"/><text x="150">Painted</text><rect x="230" width="22" height="8" y="-7" fill="${STM.yellow}"/><text x="260">Shared</text><rect x="335" width="22" height="8" y="-7" fill="#e8823d"/><text x="365">No bike lane</text>
      <text x="${W - 60}" text-anchor="end" fill="#fff" font-size="18" font-weight="700">${C.fmtKm(r.length)} · ${C.fmtMin(C.rideMinutes(r))} · ${C.fmtPct(r.infraShare)} on bike infrastructure</text></g></svg>`;
    box.innerHTML = s; $("#metro").hidden = false;
  }

  // ------------------------------------------------------------------ ride
  const riderEl = document.createElement("div"); riderEl.className = "rider-dot";
  const rider = new maplibregl.Marker({ element: riderEl });
  let smooth = 0, after = 0, voiceOn = false;
  $("#ride-btn").onclick = startRide;
  function startRide() {
    const sel = state.routes[state.sel]; if (!sel) return;
    state.ride = new C.RideSim(sel.r, { mult: 4, pois: C.routePOIs(sel.r, window.POIS, 70), onFrame: frame, onEvent: event });
    $("#planner").hidden = true; $("#lines").hidden = true; document.querySelector(".tools").hidden = true; $("#ride").hidden = false;
    state.rideView = "birdseye"; set3d(true); map.setPadding({ top: 150, bottom: Math.round(innerHeight * 0.42), left: 0, right: 0 });
    rider.setLngLat(sel.r.coords[0]).addTo(map); smooth = map.getBearing(); render(); state.ride.start();
  }
  function lerpA(a, b, t) { return a + ((((b - a + 540) % 360) - 180) * t); }
  function frame(f) {
    smooth = lerpA(smooth, f.pos.heading, 0.12);
    const bird = state.rideView === "birdseye";
    map.jumpTo({ center: [f.pos.lon, f.pos.lat], bearing: smooth, pitch: bird ? 60 : 0, zoom: bird ? 17.2 : 16.6 });
    rider.setLngLat([f.pos.lon, f.pos.lat]);
    const L = f.look;
    $("#next-dist").textContent = L.next ? C.fmtKm(L.nextDist) : C.fmtKm(f.total - f.d);
    $("#next-text").textContent = L.next ? L.next.text : "Arrive: " + (state.toLabel || "destination");
    const a = $("#alert");
    if (L.inGap) { a.className = "alert"; a.hidden = false; a.innerHTML = `<span class="dot"></span>No bike lane for ${C.fmtKm(L.inGap.start + L.inGap.length - f.d)}${L.inGap.names[0] ? " · " + C.esc(L.inGap.names[0]) : ""}${L.inGap.busy ? " · traffic" : ""}`; after = performance.now() + 4000; }
    else if (L.nextGap && L.nextGapDist < 400) { a.className = "alert"; a.hidden = false; a.innerHTML = `<span class="dot"></span>In ${C.fmtKm(L.nextGapDist)}: ${Math.round(L.nextGap.length)} m without a bike lane${L.nextGap.names[0] ? " · " + C.esc(L.nextGap.names[0]) : ""}`; }
    else if (performance.now() < after) { a.className = "alert ok"; a.hidden = false; a.innerHTML = `<span class="dot"></span>Back on the green line`; }
    else a.hidden = true;
    // side rails
    const ahead = L.pois.filter((p) => p.along >= f.d - 5).slice(0, 10);
    for (const side of [-1, 1]) {
      const list = ahead.filter((p) => p.side === side).slice(0, 4);
      $(side < 0 ? "#rail-left" : "#rail-right").innerHTML = list.map((p) => `<div class="item ${p.along - f.d < 60 ? "near" : ""}"><img alt="" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(C.iconSVG(p.kind, { size: 64, lines: p.extra }))}"><span><b>${C.esc(p.name || C.POI_KINDS[p.kind].label)}</b><small>${Math.max(0, Math.round((p.along - f.d) / 10) * 10)} m</small></span></div>`).join("");
    }
    drawStrip(f.total ? state.ride.route : null, f.d);
  }
  function event(ev) {
    if (!voiceOn) return;
    if (ev.type === "gap") C.voice.say(C.gapSentence(ev.gap, ev.dist));
    if (ev.type === "turn") C.voice.say(ev.m.text);
    if (ev.type === "arrived") C.voice.say("You have arrived.");
  }
  $("#ride-voice").onclick = () => { voiceOn = !voiceOn; C.voice.enabled = voiceOn; $("#ride-voice").setAttribute("aria-pressed", String(voiceOn)); $("#ride-voice").textContent = voiceOn ? "Voice on" : "Voice off"; };
  $("#ride-speed").onclick = () => { const m = { 1: 4, 4: 10, 10: 1 }[state.ride.mult]; state.ride.mult = m; $("#ride-speed").textContent = m + "×"; };
  $("#ride-pause").onclick = () => { if (state.ride.running) { state.ride.pause(); $("#ride-pause").textContent = "Resume"; } else { state.ride.start(); $("#ride-pause").textContent = "Pause"; } };
  $("#ride-view").onclick = () => { state.rideView = state.rideView === "birdseye" ? "topdown" : "birdseye"; set3d(state.rideView === "birdseye"); };
  $("#ride-exit").onclick = () => {
    state.ride.pause(); state.ride = null; rider.remove(); $("#ride").hidden = true; $("#planner").hidden = false; $("#lines").hidden = false; document.querySelector(".tools").hidden = false;
    map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 }); set3d(false); render();
  };

  let tt = null; function toast(m) { const t = $("#toast"); t.textContent = m; t.hidden = false; clearTimeout(tt); tt = setTimeout(() => (t.hidden = true), 3000); }
  const q = new URLSearchParams(location.search);
  useTrip(window.TRIPS.find((t) => t.id === (q.get("trip") || "davidson")) || window.TRIPS[0]);
  if (q.get("metro")) setTimeout(openMetro, 800);
  window.__app = { map, state, openMetro, startRide, set3d };
})();
