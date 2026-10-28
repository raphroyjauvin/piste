/* Shared front-end helpers for the bike app prototypes (classic script, exposes window.BikeCommon). */
(function () {
  "use strict";
  const { buildCursor, distM } = window.BikeRouter;

  // ---------------------------------------------------------------- palette
  // Official STM metro colours (from STM GTFS routes.txt).
  const STM = { green: "#00B300", orange: "#D95700", yellow: "#FFD900", blue: "#0095E6" };
  const TIER_LABEL = ["Protected", "Painted lane", "Shared lane", "No bike lane", "No bike lane (busy)", "Closed to bikes"];
  const TIER_SHORT = ["Protected", "Painted", "Shared", "Quiet street", "Busy street", "Closed"];

  // ---------------------------------------------------------------- POI catalogue
  // glyphs are drawn white on a coloured disc, 24x24 viewBox, stroke-based (abstract, not brand logos)
  const G = {
    bike: '<circle cx="6.6" cy="15.6" r="3.4"/><circle cx="17.4" cy="15.6" r="3.4"/><path d="M6.6 15.6 9.4 9.4h5.6l2.4 6.2M9.4 9.4l3 6.2H6.6M13.8 7h2.6"/>',
    metro: '<path d="M6.5 17.5V7l5.5 6.5L17.5 7v10.5"/>',
    cup: '<path d="M5.5 10h11v3.5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5zM16.5 11.2h1.2a2.4 2.4 0 0 1 0 4.8h-1.4M8.6 4.4c-.8 1 .8 1.8 0 3M12.2 4.4c-.8 1 .8 1.8 0 3"/>',
    fork: '<path d="M8 3.5v6.5a2 2 0 0 1-2 2M8 3.5v17M5.5 3.5v5M10.5 3.5v5M16.5 20.5v-17c-2 1.4-3 4.2-3 7.4h3"/>',
    bread: '<path d="M4.5 13.5a7.5 5 0 0 1 15 0v4.5h-15zM8.5 10.5l1 2.6M12 9.6v3.2M15.5 10.5l-1 2.6"/>',
    cone: '<path d="M7.5 10a4.5 4.5 0 0 1 9 0zM7.5 10 12 20.5 16.5 10"/>',
    glass: '<path d="M6 4.5h12l-6 7.5zM12 12v7M8.5 20h7"/>',
    drop: '<path d="M12 3.6s5.8 6.6 5.8 10.6a5.8 5.8 0 0 1-11.6 0C6.2 10.2 12 3.6 12 3.6z"/>',
    wrench: '<path d="M14.6 5.2a4.2 4.2 0 0 0-5.2 5.4L4.2 15.8l4 4 5.2-5.2a4.2 4.2 0 0 0 5.4-5.2l-2.7 2.7-2.5-.6-.6-2.5z"/>',
    rack: '<path d="M7.5 20V10.5a4.5 4.5 0 0 1 9 0V20M4.5 20h15"/>',
    wc: '<path d="M4 7.5l1.6 9 2-6 2 6 1.6-9M19.8 8.6a3.6 3.6 0 1 0 0 6.8"/>',
    tree: '<path d="M12 3.5l5.6 8.2h-2.9l3.8 5.6H5.5l3.8-5.6H6.4zM12 17.3v3.4"/>',
    peak: '<path d="M3.5 19 9.3 9.8l3.9 5.4 2.6-3.2 4.7 7z"/>',
    columns: '<path d="M4.5 9.2h15L12 4.5zM6.8 10.6v7M10.3 10.6v7M13.7 10.6v7M17.2 10.6v7M4.5 19.5h15"/>',
    basket: '<path d="M5 10.5h14l-2 8.5H7zM9 10.5l3-5 3 5"/>',
    works: '<path d="M10 4.5h4l4 13.5H6zM8.2 11.2h7.6M5 19.8h14"/>',
  };
  const POI_KINDS = {
    bixi: { label: "BIXI station", color: "#23272E", glyph: "bike", minzoom: 15.6, group: "bike" },
    metro: { label: "Metro", color: "#FFFFFF", glyph: "metro", minzoom: 12, group: "transit" },
    cafe: { label: "Café", color: "#9A4A16", glyph: "cup", minzoom: 15.8, group: "food" },
    food: { label: "Restaurant", color: STM.orange, glyph: "fork", minzoom: 16.8, group: "food" },
    bakery: { label: "Bakery", color: "#C0762A", glyph: "bread", minzoom: 16.2, group: "food" },
    icecream: { label: "Ice cream", color: "#D9677B", glyph: "cone", minzoom: 16.2, group: "food" },
    bar: { label: "Bar", color: "#7A3420", glyph: "glass", minzoom: 17, group: "food" },
    market: { label: "Market", color: "#B5651D", glyph: "basket", minzoom: 15.5, group: "food" },
    water: { label: "Drinking water", color: "#0094B8", glyph: "drop", minzoom: 16.2, group: "bike" },
    repair: { label: "Bike repair stand", color: "#006FB0", glyph: "wrench", minzoom: 15, group: "bike" },
    bikeshop: { label: "Bike shop", color: STM.blue, glyph: "bike", minzoom: 15, group: "bike" },
    parking: { label: "Bike parking", color: "#5C8FB8", glyph: "rack", minzoom: 17.8, group: "bike" },
    toilets: { label: "Toilets", color: "#6B7078", glyph: "wc", minzoom: 16.8, group: "services" },
    park: { label: "Park", color: "#3E8E57", glyph: "tree", minzoom: 14.6, group: "outdoors" },
    viewpoint: { label: "Viewpoint", color: "#3E8E57", glyph: "peak", minzoom: 14.6, group: "outdoors" },
    culture: { label: "Museum / culture", color: "#6E5AA0", glyph: "columns", minzoom: 15.8, group: "outdoors" },
    works: { label: "Works blocking a bike lane", color: STM.yellow, glyph: "works", minzoom: 13, group: "alerts", dark: true },
  };

  function metroRing(lines) {
    const cols = { "1": STM.green, "2": STM.orange, "4": STM.yellow, "5": STM.blue };
    return (lines && lines.length ? lines : ["2"]).map((l) => cols[l] || "#888");
  }

  function iconSVG(kind, opts = {}) {
    const k = POI_KINDS[kind] || POI_KINDS.park;
    const size = opts.size || 56;
    const ring = opts.ring || "#FFFFFF";
    let disc = `<circle cx="12" cy="12" r="11" fill="${k.color}" stroke="${ring}" stroke-width="1.6"/>`;
    let stroke = k.dark ? "#1E1E1E" : "#FFFFFF";
    if (kind === "metro") {
      const cols = metroRing(opts.lines);
      disc = `<circle cx="12" cy="12" r="11" fill="#FFFFFF"/>`;
      const n = cols.length;
      cols.forEach((c, i) => {
        const a0 = (i / n) * 2 * Math.PI - Math.PI / 2, a1 = ((i + 1) / n) * 2 * Math.PI - Math.PI / 2;
        if (n === 1) disc += `<circle cx="12" cy="12" r="9.6" fill="none" stroke="${c}" stroke-width="2.8"/>`;
        else disc += `<path d="M${12 + 9.6 * Math.cos(a0)} ${12 + 9.6 * Math.sin(a0)}A9.6 9.6 0 0 1 ${12 + 9.6 * Math.cos(a1)} ${12 + 9.6 * Math.sin(a1)}" fill="none" stroke="${c}" stroke-width="2.8"/>`;
      });
      stroke = "#111111";
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">${disc}` +
      `<g transform="translate(12 12) scale(0.62) translate(-12 -12)" fill="none" stroke="${stroke}" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">${G[k.glyph]}</g></svg>`;
  }

  function svgToImage(svg) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    });
  }

  // Register POI icons on a MapLibre map: poi-<kind>, plus poi-metro-<lines> variants
  async function addMapIcons(map, opts = {}) {
    const tasks = Object.keys(POI_KINDS).filter((k) => k !== "metro").map(async (k) => {
      const img = await svgToImage(iconSVG(k, { size: 56, ring: opts.ring }));
      if (!map.hasImage("poi-" + k)) map.addImage("poi-" + k, img, { pixelRatio: 2 });
    });
    const metroVariants = new Set((window.POIS || []).filter((p) => p[0] === "metro").map((p) => (p[4] || []).join("")));
    for (const v of metroVariants) {
      tasks.push(svgToImage(iconSVG("metro", { size: 64, lines: v.split("") })).then((img) => {
        if (!map.hasImage("poi-metro-" + v)) map.addImage("poi-metro-" + v, img, { pixelRatio: 2 });
      }));
    }
    await Promise.all(tasks);
  }

  function poisGeoJSON(pois) {
    return {
      type: "FeatureCollection",
      features: pois.map((p, i) => ({
        type: "Feature", id: i, geometry: { type: "Point", coordinates: [p[2], p[3]] },
        properties: { k: p[0], name: p[1], icon: p[0] === "metro" ? "poi-metro-" + (p[4] || []).join("") : "poi-" + p[0],
          minz: (POI_KINDS[p[0]] || {}).minzoom || 15, group: (POI_KINDS[p[0]] || {}).group || "other" },
      })),
    };
  }

  // ---------------------------------------------------------------- buildings
  function unpackBuildings(P) {
    const feats = []; let x = 0, y = 0, k = 0;
    for (let i = 0; i < P.c.length; i++) {
      const ring = [];
      for (let j = 0; j < P.c[i]; j++) { x += P.d[k++]; y += P.d[k++]; ring.push([x / 1e6, y / 1e6]); }
      ring.push(ring[0]);
      feats.push({ type: "Feature", id: i, properties: { h: P.h[i] / 10 }, geometry: { type: "Polygon", coordinates: [ring] } });
    }
    return { type: "FeatureCollection", features: feats };
  }

  // ---------------------------------------------------------------- route -> GeoJSON
  function routePiecesGeoJSON(route) {
    return {
      type: "FeatureCollection",
      features: route.pieces.map((p, i) => ({
        type: "Feature", id: i, geometry: { type: "LineString", coordinates: p.coords },
        properties: { tier: p.tier, gap: p.tier >= 3 && p.tier <= 4 ? 1 : 0, name: p.names.join(" / "), len: Math.round(p.length) },
      })),
    };
  }
  function routeLineGeoJSON(route, props = {}) {
    return { type: "Feature", geometry: { type: "LineString", coordinates: route.coords }, properties: props };
  }
  function gapStartsGeoJSON(route) {
    const cur = buildCursor(route);
    return {
      type: "FeatureCollection",
      features: route.gaps.map((g, i) => {
        const p = cur.at(g.start + 1);
        return { type: "Feature", id: i, geometry: { type: "Point", coordinates: [p.lon, p.lat] },
          properties: { len: Math.round(g.length), busy: g.busy ? 1 : 0, name: g.names[0] || "" } };
      }),
    };
  }

  // ---------------------------------------------------------------- formatting
  const SPEED_KMH = 16;
  function rideMinutes(route) { return route.length / 1000 / SPEED_KMH * 60 + route.climb / 10; }
  const fmtKm = (m) => (m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 1) + " km" : Math.round(m / 10) * 10 + " m");
  const fmtMin = (min) => (min < 1 ? "<1 min" : Math.round(min) + " min");
  const fmtPct = (x) => Math.round(x * 100) + "%";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------------------------------------------------------------- route POIs & ride look-ahead
  function routePOIs(route, pois, corridor = 70) {
    const cur = buildCursor(route);
    const xs = route.coords.map((c) => c[0]), ys = route.coords.map((c) => c[1]);
    const pad = 0.001;
    const w = Math.min(...xs) - pad, e = Math.max(...xs) + pad, s = Math.min(...ys) - pad, n = Math.max(...ys) + pad;
    const out = [];
    pois.forEach((p, i) => {
      if (p[0] === "parking" || p[2] < w || p[2] > e || p[3] < s || p[3] > n) return;
      const loc = cur.locate(p[2], p[3]);
      if (loc.d <= corridor) out.push({ i, kind: p[0], name: p[1], lon: p[2], lat: p[3], along: loc.along, side: loc.side, off: loc.d, extra: p[4] });
    });
    return out.sort((a, b) => a.along - b.along);
  }

  // climbs: sustained stretches of >= 3 % over >= 80 m, from the route's elevation profile
  function climbs(route) {
    const pr = route.profile; if (!pr || pr.length < 2) return [];
    const out = []; let start = null;
    for (let i = 1; i < pr.length; i++) {
      const dd = pr[i][0] - pr[i - 1][0], dz = pr[i][1] - pr[i - 1][1];
      const grade = dd > 0 ? dz / dd : 0;
      if (grade >= 0.025) { if (start === null) start = i - 1; }
      else if (start !== null) { push(start, i - 1); start = null; }
    }
    if (start !== null) push(start, pr.length - 1);
    function push(a, b) {
      const len = pr[b][0] - pr[a][0], rise = pr[b][1] - pr[a][1];
      if (len >= 80 && rise >= 3) out.push({ start: pr[a][0], length: len, rise, grade: rise / len });
    }
    return out;
  }

  function lookahead(route, d, extras) {
    const next = route.maneuvers.find((m) => m.at > d + 3);
    const inGap = route.gaps.find((g) => d >= g.start && d < g.start + g.length);
    const nextGap = route.gaps.find((g) => g.start > d);
    const hills = extras.climbs || [];
    const hill = hills.find((h) => h.start + h.length > d && h.start - d < 600);
    const pois = (extras.pois || []).filter((p) => p.along > d - 20 && p.along < d + 320);
    return { next, nextDist: next ? next.at - d : null, inGap, nextGap, nextGapDist: nextGap ? nextGap.start - d : null, hill, pois };
  }

  // ---------------------------------------------------------------- elevation profile (SVG string)
  function profileSVG(route, opts = {}) {
    const W = opts.width || 320, H = opts.height || 84, padB = 14, padT = 8;
    const pr = route.profile; if (!pr || pr.length < 2) return "";
    const zs = pr.map((p) => p[1]); let zmin = Math.min(...zs), zmax = Math.max(...zs);
    if (zmax - zmin < 12) { const m = (zmax + zmin) / 2; zmin = m - 6; zmax = m + 6; }
    const L = route.length || 1;
    const X = (d) => (d / L) * W, Y = (z) => padT + (1 - (z - zmin) / (zmax - zmin)) * (H - padT - padB);
    let path = `M0 ${H - padB}`;
    pr.forEach(([d, z]) => { path += `L${X(d).toFixed(1)} ${Y(z).toFixed(1)}`; });
    path += `L${W} ${H - padB}Z`;
    const band = route.pieces.map((p) => `<rect x="${X(p.start).toFixed(1)}" y="${H - padB + 3}" width="${Math.max(0.6, X(p.length)).toFixed(1)}" height="6" fill="${opts.tierColors[p.tier]}"/>`).join("");
    const gapShade = route.gaps.map((g) => `<rect x="${X(g.start).toFixed(1)}" y="${padT}" width="${Math.max(1, X(g.length)).toFixed(1)}" height="${H - padT - padB}" fill="${opts.gapShade}"/>`).join("");
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" role="img" aria-label="Elevation profile">` +
      `${gapShade}<path d="${path}" fill="${opts.fill}" stroke="${opts.stroke}" stroke-width="1.2" vector-effect="non-scaling-stroke"/>${band}` +
      `<text x="2" y="${padT + 9}" font-size="10" fill="${opts.text}">${Math.round(zmax)} m</text>` +
      `<text x="2" y="${H - padB - 3}" font-size="10" fill="${opts.text}">${Math.round(zmin)} m</text></svg>`;
  }

  // ---------------------------------------------------------------- geocoding (local + City of Montréal address API)
  function makeGeocoder(router) {
    const local = [];
    (window.POIS || []).forEach((p) => {
      if (!p[1] || p[0] === "parking") return;
      local.push({ label: p[1], sub: (POI_KINDS[p[0]] || {}).label || "", lon: p[2], lat: p[3], kind: p[0], rank: p[0] === "metro" ? 3 : p[0] === "park" ? 2 : 1 });
    });
    (window.TRIPS || []).forEach((t) => { local.push({ label: t.from.label, sub: "Test trip start", lon: t.from.lonlat[0], lat: t.from.lonlat[1], rank: 2 }); local.push({ label: t.to.label, sub: "Test trip end", lon: t.to.lonlat[0], lat: t.to.lonlat[1], rank: 2 }); });
    const norm = (s) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
    // intersections "Rachel & Papineau"
    const nodeNames = new Map();
    for (let e = 0; e < router.m; e++) {
      const nm = router.names[router.ename[e]]; if (!nm) continue;
      for (const v of [router.ea[e], router.eb[e]]) { let s = nodeNames.get(v); if (!s) nodeNames.set(v, (s = new Set())); s.add(nm); }
    }
    function intersections(q) {
      const parts = q.split(/\s*(?:&|\/| and | et |@)\s*/i).map((s) => norm(s.trim())).filter(Boolean);
      if (parts.length !== 2) return [];
      const out = [];
      for (const [v, set] of nodeNames) {
        const arr = [...set]; const na = arr.map(norm);
        const i = na.findIndex((n) => n.includes(parts[0])), j = na.findIndex((n) => n.includes(parts[1]));
        if (i >= 0 && j >= 0 && i !== j) out.push({ label: `${arr[i]} & ${arr[j]}`, sub: "Intersection", lon: router.lon[v], lat: router.lat[v], rank: 4 });
        if (out.length > 3) break;
      }
      return out;
    }
    let ctrl = null;
    async function search(q) {
      const nq = norm(q.trim());
      if (nq.length < 2) return [];
      const m = nq.match(/^(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)$/);
      if (m) { const a = +m[1], b = +m[2]; return [{ label: q, sub: "Coordinates", lon: a < -60 ? a : b, lat: a < -60 ? b : a }]; }
      const res = [...intersections(q)];
      local.filter((p) => norm(p.label).includes(nq)).sort((a, b) => b.rank - a.rank).slice(0, 6).forEach((p) => res.push(p));
      if (ctrl) ctrl.abort();
      ctrl = new AbortController();
      try {
        const r = await fetch("https://api.montreal.ca/api/geographic/location/v1/addresses?limit=6&q=" + encodeURIComponent(q), { signal: ctrl.signal });
        if (r.ok) {
          const j = await r.json();
          (j.items || []).forEach((it) => {
            if (!it.coordinates) return;
            res.push({ label: it.humanReadableCode?.valueEn || it.humanReadableCode?.valueFr || q, sub: "Address (Ville de Montréal)", lon: it.coordinates.lon, lat: it.coordinates.lat });
          });
        }
      } catch (e) { /* offline or aborted: local results only */ }
      return res.slice(0, 10);
    }
    return { search };
  }

  // ---------------------------------------------------------------- ride simulator
  class RideSim {
    constructor(route, opts = {}) {
      this.route = route; this.cursor = buildCursor(route);
      this.d = 0; this.speed = (opts.kmh || SPEED_KMH) / 3.6; this.mult = opts.mult || 4;
      this.onFrame = opts.onFrame || (() => {}); this.onEvent = opts.onEvent || (() => {});
      this.running = false; this._last = null; this._fired = new Set();
      this.extras = { climbs: climbs(route), pois: opts.pois || [] };
    }
    start() { if (this.running) return; this.running = true; this._last = performance.now(); requestAnimationFrame((t) => this._tick(t)); }
    pause() { this.running = false; }
    seek(d) { this.d = Math.max(0, Math.min(this.cursor.total, d)); this._emit(); }
    _tick(t) {
      if (!this.running) return;
      const dt = Math.min(0.1, (t - this._last) / 1000); this._last = t;
      this.d += this.speed * this.mult * dt;
      if (this.d >= this.cursor.total) { this.d = this.cursor.total; this.running = false; this._emit(); this.onEvent({ type: "arrived" }); return; }
      this._emit();
      requestAnimationFrame((tt) => this._tick(tt));
    }
    _emit() {
      const pos = this.cursor.at(this.d);
      const look = lookahead(this.route, this.d, this.extras);
      // events: gap alert 200 m before; turn prompt 80 m before; climb notice 250 m before
      const g = look.nextGap;
      if (g && look.nextGapDist <= 200) this._once("gap" + g.start, { type: "gap", gap: g, dist: look.nextGapDist });
      if (look.next && look.nextDist <= 80) this._once("turn" + look.next.at, { type: "turn", m: look.next, dist: look.nextDist });
      if (look.hill && look.hill.start - this.d <= 250 && look.hill.start > this.d) this._once("hill" + look.hill.start, { type: "hill", hill: look.hill, dist: look.hill.start - this.d });
      this.onFrame({ d: this.d, total: this.cursor.total, pos, look });
    }
    _once(key, ev) { if (this._fired.has(key)) return; this._fired.add(key); this.onEvent(ev); }
  }

  // ---------------------------------------------------------------- voice (prompts via speaker; commands where supported)
  const voice = {
    enabled: false,
    say(text) {
      if (!this.enabled || !window.speechSynthesis) return;
      const u = new SpeechSynthesisUtterance(text);
      const v = speechSynthesis.getVoices().find((x) => /en-CA/i.test(x.lang)) || speechSynthesis.getVoices().find((x) => /^en/i.test(x.lang));
      if (v) u.voice = v;
      u.rate = 1.02; speechSynthesis.cancel(); speechSynthesis.speak(u);
    },
    commandsSupported: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
    listen(handlers) {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition; if (!SR) return null;
      const rec = new SR(); rec.lang = "en-CA"; rec.continuous = true; rec.interimResults = false;
      rec.onresult = (e) => {
        const t = e.results[e.results.length - 1][0].transcript.toLowerCase();
        for (const [k, fn] of Object.entries(handlers)) if (t.includes(k)) { fn(t); break; }
      };
      rec.onend = () => { if (rec._keep) rec.start(); };
      rec._keep = true; rec.start(); return rec;
    },
  };

  function gapSentence(g, dist) {
    const where = g.names[0] ? ` on ${g.names[0]}` : "";
    return `In ${Math.round(dist / 10) * 10} metres, ${Math.round(g.length / 10) * 10} metres without a bike lane${where}${g.busy ? ", with traffic" : ""}.`;
  }

  window.BikeCommon = { STM, TIER_LABEL, TIER_SHORT, POI_KINDS, iconSVG, svgToImage, addMapIcons, poisGeoJSON, unpackBuildings,
    routePiecesGeoJSON, routeLineGeoJSON, gapStartsGeoJSON, rideMinutes, fmtKm, fmtMin, fmtPct, esc, routePOIs, climbs, lookahead,
    profileSVG, makeGeocoder, RideSim, voice, gapSentence, buildCursor, distM };
})();
