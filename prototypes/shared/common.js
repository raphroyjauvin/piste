/* Shared front-end helpers for the bike app prototypes (classic script, exposes window.BikeCommon). */
(function () {
  "use strict";
  const { buildCursor, distM } = window.BikeRouter;

  // ---------------------------------------------------------------- palette
  // Official STM metro colours (from STM GTFS routes.txt).
  const STM = { green: "#00B300", orange: "#D95700", yellow: "#FFD900", blue: "#0095E6" };
  const TIER_LABEL = ["Protected bike path", "Painted bike path", "Shared bike path", "No bike path", "No bike path (busy)", "Closed to bikes"];
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
    bag: '<path d="M5.5 8.5h13l-1.2 11.5H6.7zM9 10.5V7.3a3 3 0 0 1 6 0v3.2"/>',
  };
  const POI_KINDS = {
    bixi: { label: "BIXI station", fr: "Station BIXI", color: "#EE3124", glyph: "bike", minzoom: 15.6, group: "bike" },
    metro: { label: "Metro", fr: "Métro", color: "#FFFFFF", glyph: "metro", minzoom: 12, group: "transit" },
    cafe: { label: "Café", fr: "Café", color: "#9A4A16", glyph: "cup", minzoom: 15.8, group: "food" },
    food: { label: "Restaurant", fr: "Restaurant", color: STM.orange, glyph: "fork", minzoom: 16.8, group: "food" },
    bakery: { label: "Bakery", fr: "Boulangerie", color: "#C0762A", glyph: "bread", minzoom: 16.2, group: "food" },
    icecream: { label: "Ice cream", fr: "Crème glacée", color: "#D9677B", glyph: "cone", minzoom: 16.2, group: "food" },
    bar: { label: "Bar", fr: "Bar", color: "#7A3420", glyph: "glass", minzoom: 17, group: "food" },
    market: { label: "Market", fr: "Marché", color: "#B5651D", glyph: "basket", minzoom: 15.5, group: "food" },
    shop: { label: "Shop", fr: "Boutique", color: "#9C4F86", glyph: "bag", minzoom: 17, group: "shopping" },
    water: { label: "Drinking water", fr: "Eau potable", color: "#0094B8", glyph: "drop", minzoom: 16.2, group: "bike" },
    repair: { label: "Bike repair stand", fr: "Station de réparation", color: "#006FB0", glyph: "wrench", minzoom: 15, group: "bike" },
    bikeshop: { label: "Bike shop", fr: "Boutique de vélo", color: STM.blue, glyph: "bike", minzoom: 15, group: "bike" },
    parking: { label: "Bike parking", fr: "Stationnement vélo", color: "#5C8FB8", glyph: "rack", minzoom: 17.8, group: "bike" },
    toilets: { label: "Toilets", fr: "Toilettes", color: "#6B7078", glyph: "wc", minzoom: 16.8, group: "services" },
    park: { label: "Park", fr: "Parc", color: "#3E8E57", glyph: "tree", minzoom: 14.6, group: "outdoors" },
    viewpoint: { label: "Viewpoint", fr: "Belvédère", color: "#3E8E57", glyph: "peak", minzoom: 14.6, group: "outdoors" },
    culture: { label: "Museum / culture", fr: "Musée / culture", color: "#6E5AA0", glyph: "columns", minzoom: 15.8, group: "outdoors" },
    works: { label: "Works blocking a bike path", fr: "Travaux sur une piste cyclable", color: STM.yellow, glyph: "works", minzoom: 13, group: "alerts", dark: true },
  };

  const lang = () => (window.BikeI18n || {}).lang || "en";
  // POI kind label in the current language
  function poiLabel(kind) { const k = POI_KINDS[kind] || {}; return (lang() === "fr" && k.fr) || k.label || ""; }

  function metroRing(lines) {
    const cols = { "1": STM.green, "2": STM.orange, "4": STM.yellow, "5": STM.blue };
    return (lines && lines.length ? lines : ["2"]).map((l) => cols[l] || "#888");
  }

  // Metro and BIXI echo the real signs without copying them: our own drawings, using only the familiar colour and idea.
  const METRO_SIGN_BLUE = "#0072B2";
  function iconSVG(kind, opts = {}) {
    const k = POI_KINDS[kind] || POI_KINDS.park;
    const size = opts.size || 56;
    const ring = opts.ring || "#FFFFFF";
    const wrap = (body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">${body}</svg>`;
    const glyph = (stroke) => `<g transform="translate(12 12) scale(0.62) translate(-12 -12)" fill="none" stroke="${stroke}" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">${G[k.glyph]}</g>`;
    if (kind === "metro") {
      // like the métro entrance sign (white down-arrow on a blue disc); the outer ring shows the lines serving the station
      const cols = metroRing(opts.lines), n = cols.length;
      let s = `<circle cx="12" cy="12" r="11.9" fill="#FFFFFF"/>`;
      cols.forEach((c, i) => {
        if (n === 1) { s += `<circle cx="12" cy="12" r="10.1" fill="none" stroke="${c}" stroke-width="2.6"/>`; return; }
        const a0 = (i / n) * 2 * Math.PI - Math.PI / 2, a1 = ((i + 1) / n) * 2 * Math.PI - Math.PI / 2;
        const pt = (a) => `${(12 + 10.1 * Math.cos(a)).toFixed(2)} ${(12 + 10.1 * Math.sin(a)).toFixed(2)}`;
        s += `<path d="M${pt(a0)}A10.1 10.1 0 0 1 ${pt(a1)}" fill="none" stroke="${c}" stroke-width="2.6"/>`;
      });
      s += `<circle cx="12" cy="12" r="8.3" fill="${METRO_SIGN_BLUE}"/>` +
        `<path d="M10.25 6.2h3.5v5.3h3.1L12 17.7l-4.85-6.2h3.1z" fill="#FFFFFF" stroke="#FFFFFF" stroke-width=".7" stroke-linejoin="round"/>`;
      return wrap(s);
    }
    if (kind === "bixi") {
      // BIXI red on a rounded-square tag, with a plain bike (not their wordmark)
      return wrap(`<rect x="1.2" y="1.2" width="21.6" height="21.6" rx="5.8" fill="${k.color}" stroke="${ring}" stroke-width="1.6"/>` + glyph("#FFFFFF"));
    }
    return wrap(`<circle cx="12" cy="12" r="11" fill="${k.color}" stroke="${ring}" stroke-width="1.6"/>` + glyph(k.dark ? "#1E1E1E" : "#FFFFFF"));
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
      features: route.gaps.filter((g) => g.length >= GAP_MIN).map((g, i) => {
        const p = cur.at(g.start + 1);
        return { type: "Feature", id: i, geometry: { type: "Point", coordinates: [p.lon, p.lat] },
          properties: { len: Math.round(g.length), busy: g.busy ? 1 : 0, name: g.names[0] || "" } };
      }),
    };
  }

  // ---------------------------------------------------------------- formatting
  const SPEED_KMH = 16;
  function rideMinutes(route) { return route.length / 1000 / SPEED_KMH * 60 + route.climb / 10; }
  const fmtKm = (m) => {
    if (m < 1000) return Math.round(m / 10) * 10 + " m";
    const v = (m / 1000).toFixed(m >= 10000 ? 0 : 1);
    return (lang() === "fr" ? v.replace(".", ",") : v) + " km";
  };
  const fmtMin = (min) => (window.BikeI18n ? window.BikeI18n.duration(min) : min < 1 ? "<1 min" : Math.round(min) + " min");
  const fmtPct = (x) => (window.BikeI18n ? window.BikeI18n.pct(x) : Math.round(x * 100) + "%");
  // stretches without a bike path worth telling the rider about (shorter ones are street crossings and joins)
  const GAP_MIN = 50;
  const mainGaps = (route, min = GAP_MIN) => route.gaps.filter((g) => g.length >= min);
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

  // climbs: stretches rising at >= 2.5 % for >= 80 m and >= 3 m, from the route's elevation profile.
  // Runs split by a short, nearly flat breather (< 120 m, dropping < 2 m) count as one hill, the way a rider feels it.
  function climbs(route) {
    const pr = route.profile; if (!pr || pr.length < 2) return [];
    const runs = []; let start = null;
    for (let i = 1; i < pr.length; i++) {
      const dd = pr[i][0] - pr[i - 1][0], dz = pr[i][1] - pr[i - 1][1];
      const grade = dd > 0 ? dz / dd : 0;
      if (grade >= 0.025) { if (start === null) start = i - 1; }
      else if (start !== null) { runs.push([start, i - 1]); start = null; }
    }
    if (start !== null) runs.push([start, pr.length - 1]);
    const merged = [];
    for (const run of runs) {
      const last = merged[merged.length - 1];
      if (last) {
        const gap = pr[run[0]][0] - pr[last[1]][0];
        let low = pr[last[1]][1];
        for (let i = last[1]; i <= run[0]; i++) low = Math.min(low, pr[i][1]);
        if (gap < 120 && pr[last[1]][1] - low < 2) { last[1] = run[1]; continue; }
      }
      merged.push([run[0], run[1]]);
    }
    const out = [];
    for (const [a, b] of merged) {
      const len = pr[b][0] - pr[a][0], rise = pr[b][1] - pr[a][1];
      if (len >= 80 && rise >= 3) out.push({ start: pr[a][0], length: len, rise, grade: rise / len });
    }
    return out;
  }

  function lookahead(route, d, extras) {
    const next = route.maneuvers.find((m) => m.at > d + 3);
    const gaps = extras.gaps || route.gaps;
    const inGap = gaps.find((g) => d >= g.start && d < g.start + g.length);
    const nextGap = gaps.find((g) => g.start > d);
    const hills = extras.climbs || [];
    const hill = hills.find((h) => h.start + h.length > d && h.start - d < 600);
    const pois = (extras.pois || []).filter((p) => p.along > d - 20 && p.along < d + 320);
    return { next, nextDist: next ? next.at - d : null, inGap, nextGap, nextGapDist: nextGap ? nextGap.start - d : null, hill, pois };
  }

  // ---------------------------------------------------------------- elevation along a route (profile = [[dist m, elev m], ...])
  function elevAt(route, d) {
    const pr = route.profile; if (!pr || !pr.length) return 0;
    if (d <= pr[0][0]) return pr[0][1];
    for (let i = 1; i < pr.length; i++) {
      if (pr[i][0] >= d) { const u = (d - pr[i - 1][0]) / ((pr[i][0] - pr[i - 1][0]) || 1); return pr[i - 1][1] + (pr[i][1] - pr[i - 1][1]) * u; }
    }
    return pr[pr.length - 1][1];
  }
  function profileWindow(route, d0, d1, step = 10) {
    const out = [];
    for (let d = d0; d <= d1 + 0.01; d += step) out.push([d, elevAt(route, Math.max(0, Math.min(route.length, d)))]);
    return out;
  }
  // steepest grade inside a climb, measured over 30 m windows so one short kink doesn't count
  function climbMaxGrade(route, c, win = 30) {
    let mx = c.grade;
    for (let d = c.start; d + win <= c.start + c.length + 0.01; d += 10) mx = Math.max(mx, (elevAt(route, d + win) - elevAt(route, d)) / win);
    return mx;
  }
  function climbName(route, c) {
    const mid = c.start + c.length / 2;
    const p = route.pieces.find((q) => q.start <= mid && q.start + q.length >= mid);
    return (p && p.names[0]) || "";
  }
  // route coordinates between two distances along it
  function sliceCoords(route, d0, d1) {
    const c = route.coords, cum = [0];
    for (let i = 1; i < c.length; i++) cum.push(cum[i - 1] + distM(c[i - 1][0], c[i - 1][1], c[i][0], c[i][1]));
    const scale = cum[cum.length - 1] ? route.length / cum[cum.length - 1] : 1;
    const g0 = d0 / scale, g1 = d1 / scale, out = [];
    const lerp = (i, g) => { const u = (g - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1); return [c[i - 1][0] + (c[i][0] - c[i - 1][0]) * u, c[i - 1][1] + (c[i][1] - c[i - 1][1]) * u]; };
    for (let i = 1; i < c.length; i++) {
      if (cum[i] < g0) continue;
      if (!out.length) out.push(lerp(i, Math.max(g0, cum[i - 1])));
      if (cum[i] >= g1) { out.push(lerp(i, g1)); break; }
      out.push(c[i]);
    }
    return out;
  }
  // climbs as lines for uphill chevrons (Michelin-style: more chevrons = steeper), drawn in the direction of travel
  function climbsGeoJSON(route, list) {
    return {
      type: "FeatureCollection",
      features: (list || climbs(route)).map((c, i) => {
        const max = climbMaxGrade(route, c);
        const n = c.grade >= 0.08 || max >= 0.1 ? 3 : c.grade >= 0.05 || max >= 0.07 ? 2 : 1;
        return { type: "Feature", id: i, geometry: { type: "LineString", coordinates: sliceCoords(route, c.start, c.start + c.length) },
          properties: { n, rise: Math.round(c.rise), grade: Math.round(c.grade * 100) } };
      }),
    };
  }

  // ---------------------------------------------------------------- elevation profile (SVG string)
  function profileSVG(route, opts = {}) {
    const W = opts.width || 320, H = opts.height || 84, padB = 14, padT = 10;
    const pr = route.profile; if (!pr || pr.length < 2) return "";
    const zs = pr.map((p) => p[1]); let zmin = Math.min(...zs), zmax = Math.max(...zs);
    const minRange = opts.minRange || 12;
    if (zmax - zmin < minRange) { const m = (zmax + zmin) / 2; zmin = m - minRange / 2; zmax = m + minRange / 2; }
    zmax += (zmax - zmin) * (opts.headroom || 0);
    const L = route.length || 1;
    const X = (d) => (d / L) * W, Y = (z) => padT + (1 - (z - zmin) / (zmax - zmin)) * (H - padT - padB);
    let line = "";
    pr.forEach(([d, z], i) => { line += `${i ? "L" : "M"}${X(d).toFixed(1)} ${Y(z).toFixed(1)}`; });
    const area = `M0 ${H - padB}L${line.slice(1)}L${W} ${H - padB}Z`;
    const band = route.pieces.map((p) => `<rect x="${X(p.start).toFixed(1)}" y="${H - padB + 3}" width="${Math.max(0.6, X(p.length)).toFixed(1)}" height="6" fill="${opts.tierColors[p.tier]}"/>`).join("");
    const gapShade = (opts.gaps || route.gaps).map((g) => `<rect x="${X(g.start).toFixed(1)}" y="${padT}" width="${Math.max(1, X(g.length)).toFixed(1)}" height="${H - padT - padB}" fill="${opts.gapShade}"/>`).join("");
    // climbs: a warmer fill under the line, and "+N m" above the bigger ones
    const cl = opts.climbs || [];
    const clipId = "pc" + Math.random().toString(36).slice(2, 8);
    const climbFill = cl.length ? `<clipPath id="${clipId}">${cl.map((c) => `<rect x="${X(c.start).toFixed(1)}" y="0" width="${Math.max(1, X(c.length)).toFixed(1)}" height="${H}"/>`).join("")}</clipPath>` +
      `<path d="${area}" fill="${opts.climbFill || "#dcc3a3"}" clip-path="url(#${clipId})"/>` : "";
    const climbText = cl.filter((c) => c.rise >= 6).map((c) => {
      const x = Math.min(W - 16, Math.max(16, X(c.start + c.length / 2))), y = Math.max(9, Y(elevAt(route, c.start + c.length)) - 4);
      return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="9.5" font-weight="700" text-anchor="middle" fill="${opts.climbText || "#7a5a3a"}">+${Math.round(c.rise)} m</text>`;
    }).join("");
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" role="img" aria-label="Elevation profile">` +
      `${gapShade}<path d="${area}" fill="${opts.fill}"/>${climbFill}` +
      `<path d="${line}" fill="none" stroke="${opts.stroke}" stroke-width="1.3" vector-effect="non-scaling-stroke"/>${band}${climbText}` +
      `<text x="2" y="${padT + 1}" font-size="10" fill="${opts.text}">${Math.round(zmax)} m</text>` +
      `<text x="2" y="${H - padB - 3}" font-size="10" fill="${opts.text}">${Math.round(zmin)} m</text></svg>`;
  }

  // ---------------------------------------------------------------- geocoding (local + City of Montréal address API)
  function makeGeocoder(router) {
    const local = [];
    (window.POIS || []).forEach((p) => {
      if (!p[1] || p[0] === "parking") return;
      local.push({ label: p[1], kind: p[0], lon: p[2], lat: p[3], rank: p[0] === "metro" ? 3 : p[0] === "park" ? 2 : 1 });
    });
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
      if (m) { const a = +m[1], b = +m[2]; return [{ label: q, sub: lang() === "fr" ? "Coordonnées" : "Coordinates", lon: a < -60 ? a : b, lat: a < -60 ? b : a }]; }
      const res = [...intersections(q)];
      local.filter((p) => norm(p.label).includes(nq)).sort((a, b) => b.rank - a.rank).slice(0, 6).forEach((p) => res.push(Object.assign({ sub: poiLabel(p.kind) }, p)));
      if (ctrl) ctrl.abort();
      ctrl = new AbortController();
      try {
        const r = await fetch("https://api.montreal.ca/api/geographic/location/v1/addresses?limit=6&q=" + encodeURIComponent(q), { signal: ctrl.signal });
        if (r.ok) {
          const j = await r.json();
          (j.items || []).forEach((it) => {
            if (!it.coordinates) return;
            const fr = lang() === "fr";
            res.push({ label: (fr ? it.humanReadableCode?.valueFr : it.humanReadableCode?.valueEn) || it.humanReadableCode?.valueEn || it.humanReadableCode?.valueFr || q,
              sub: fr ? "Adresse (Ville de Montréal)" : "Address (Ville de Montréal)", lon: it.coordinates.lon, lat: it.coordinates.lat });
          });
        }
      } catch (e) { /* offline or aborted: local results only */ }
      return res.slice(0, 10);
    }
    return { search };
  }

  // ---------------------------------------------------------------- ride: one emitter, two sources of progress
  // RideCore turns "how far along the route" into frames ({ d, total, pos, look }) and one-off events
  // (gap alert 200 m before, turn prompt 80 m before, climb notice 250 m before, arrived).
  // RideSim moves along at a set speed (the preview); RideGPS follows the phone's location. The app draws both the same way.
  class RideCore {
    constructor(route, opts = {}) {
      this.onFrame = opts.onFrame || (() => {}); this.onEvent = opts.onEvent || (() => {});
      this.d = 0; this.running = false;
      this.setRoute(route, opts.pois);
    }
    // a new route to follow (a reroute): its own cursor, climbs, gaps and roadside places, and fresh events
    setRoute(route, pois = []) {
      this.route = route; this.cursor = buildCursor(route); this._fired = new Set();
      this.extras = { climbs: climbs(route), pois, gaps: mainGaps(route) };
    }
    _emit(extra) {
      const pos = (extra && extra.pos) || this.cursor.at(this.d);
      const look = lookahead(this.route, this.d, this.extras);
      // events: gap alert 200 m before; turn prompt 80 m before; climb notice 250 m before
      const g = look.nextGap;
      if (g && look.nextGapDist <= 200) this._once("gap" + g.start, { type: "gap", gap: g, dist: look.nextGapDist });
      if (look.next && look.nextDist <= 80) this._once("turn" + look.next.at, { type: "turn", m: look.next, dist: look.nextDist });
      if (look.hill && look.hill.start - this.d <= 250 && look.hill.start > this.d) this._once("hill" + look.hill.start, { type: "hill", hill: look.hill, dist: look.hill.start - this.d });
      this.onFrame(Object.assign({ d: this.d, total: this.cursor.total, pos, look }, extra));
    }
    _once(key, ev) { if (this._fired.has(key)) return; this._fired.add(key); this.onEvent(ev); }
  }

  // ---------------------------------------------------------------- ride simulator (the preview)
  class RideSim extends RideCore {
    constructor(route, opts = {}) {
      super(route, opts);
      this.speed = (opts.kmh || SPEED_KMH) / 3.6; this.mult = opts.mult || 4; this._last = null;
    }
    start() { if (this.running) return; this.running = true; this._last = performance.now(); cancelAnimationFrame(this._raf); this._raf = requestAnimationFrame((t) => this._tick(t)); }
    pause() { this.running = false; cancelAnimationFrame(this._raf); }
    seek(d) { this.d = Math.max(0, Math.min(this.cursor.total, d)); this._emit(); }
    _tick(t) {
      if (!this.running) return;
      // Ask for the next frame first: then each frame moves the camera before the map redraws,
      // and the map and its icons are drawn in step (asking last made the icons run a frame ahead and shake).
      this._raf = requestAnimationFrame((tt) => this._tick(tt));
      const dt = Math.max(0, Math.min(0.1, (t - this._last) / 1000)); this._last = t;
      this.d += this.speed * this.mult * dt;
      if (this.d >= this.cursor.total) { this.d = this.cursor.total; this.running = false; cancelAnimationFrame(this._raf); this._emit(); this.onEvent({ type: "arrived" }); return; }
      this._emit();
    }
  }

  // ---------------------------------------------------------------- the route in metres, for matching GPS fixes to it
  const D2R = Math.PI / 180, R_EARTH = 6371008.8;
  function makeTrack(route) {
    const c = route.coords, n = c.length, cum = new Float64Array(n);
    for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + distM(c[i - 1][0], c[i - 1][1], c[i][0], c[i][1]);
    const scale = cum[n - 1] ? route.length / cum[n - 1] : 1;   // same distances as buildCursor (route metres)
    return {
      // The nearest point on the route between d0 and d1 (metres along it): { off: metres from the route, along }.
      // With `near`, the earliest stretch that comes within `near` metres wins, so a loop or an out-and-back
      // matches the part you reach first, not the one that happens to be a metre closer.
      locate(lon, lat, d0 = -Infinity, d1 = Infinity, near = 0) {
        const kx = Math.cos(lat * D2R) * R_EARTH * D2R, ky = R_EARTH * D2R, px = lon * kx, py = lat * ky;
        let best = null, run = false;
        for (let i = 1; i < n; i++) {
          if (cum[i] * scale < d0 || cum[i - 1] * scale > d1) continue;
          const ax = c[i - 1][0] * kx, ay = c[i - 1][1] * ky, vx = c[i][0] * kx - ax, vy = c[i][1] * ky - ay, L2 = vx * vx + vy * vy;
          let u = L2 ? ((px - ax) * vx + (py - ay) * vy) / L2 : 0; u = Math.max(0, Math.min(1, u));
          const off = Math.hypot(px - ax - vx * u, py - ay - vy * u);
          if (near > 0) {
            if (off <= near) { run = true; if (!best || off < best.off) best = { off, along: (cum[i - 1] + (cum[i] - cum[i - 1]) * u) * scale }; }
            else if (run) break;   // the first close stretch is over
          } else if (!best || off < best.off) best = { off, along: (cum[i - 1] + (cum[i] - cum[i - 1]) * u) * scale };
        }
        if (!best && near > 0) return this.locate(lon, lat, d0, d1, 0);
        return best || { off: Infinity, along: 0 };
      },
    };
  }

  // ---------------------------------------------------------------- rejoining a ride after a detour: route pieces end to end
  // The part of a route from distance D on, as a route of its own (distances start at 0).
  function tailRoute(r, D) {
    D = Math.max(0, Math.min(r.length, D));
    const L = r.length - D;
    const pieces = r.pieces.filter((p) => p.start + p.length > D + 0.01).map((p) => {
      const s = Math.max(p.start, D);
      return Object.assign({}, p, { start: s - D, length: p.start + p.length - s, names: p.names.slice(),
        coords: s > p.start ? sliceCoords(r, s, p.start + p.length) : p.coords.slice() });
    });
    const gaps = r.gaps.filter((g) => g.start + g.length > D + 0.01).map((g) => {
      const s = Math.max(g.start, D);
      return Object.assign({}, g, { start: s - D, length: g.start + g.length - s, names: g.names.slice() });
    });
    const profile = [[0, elevAt(r, D)]].concat((r.profile || []).filter((p) => p[0] > D).map(([d, z]) => [d - D, z]));
    let climb = 0, descent = 0;
    for (let i = 1; i < profile.length; i++) { const dz = profile[i][1] - profile[i - 1][1]; if (dz > 0) climb += dz; else descent -= dz; }
    const byTier = [0, 0, 0, 0, 0, 0]; pieces.forEach((p) => (byTier[p.tier] += p.length));
    return {
      legs: r.legs.filter((l) => (l.dist0 || 0) + (l.len || 0) > D).map((l) => Object.assign({}, l, { dist0: (l.dist0 || 0) - D })),
      coords: sliceCoords(r, D, r.length), pieces, gaps, profile, byTier, length: L,
      infraShare: L ? (byTier[0] + byTier[1] + byTier[2]) / L : 0, climb, descent,
      maneuvers: r.maneuvers.filter((m) => m.at >= D).map((m) => Object.assign({}, m, { at: m.at - D })),
      stops: (r.stops || []).filter((s) => s.at >= D).map((s) => Object.assign({}, s, { at: s.at - D })),
      from: null, to: r.to,
    };
  }
  function turnKind(bIn, bOut) {   // same thresholds as the router's turn instructions
    const d = ((bOut - bIn + 540) % 360) - 180;
    return Math.abs(d) < 25 ? "continue" : d > 0 ? (d > 120 ? "sharpR" : d > 50 ? "right" : "slightR") : (d < -120 ? "sharpL" : d < -50 ? "left" : "slightL");
  }
  // Route b ridden after route a, as one route, with a turn instruction where they meet.
  function joinRoutes(a, b) {
    const off = a.length, shift = (o) => Object.assign({}, o, { start: o.start + off });
    const coords = a.coords.slice();
    for (const c of b.coords) { const l = coords[coords.length - 1]; if (!l || distM(l[0], l[1], c[0], c[1]) > 0.05) coords.push(c); }
    const pieces = a.pieces.map((p) => Object.assign({}, p, { coords: p.coords.slice(), names: p.names.slice() }));
    for (const p of b.pieces) {
      const prev = pieces[pieces.length - 1];
      if (prev && prev.tier === p.tier && Math.abs(prev.start + prev.length - (p.start + off)) < 1) {
        prev.length += p.length; prev.coords = prev.coords.concat(p.coords.slice(1)); p.names.forEach((nm) => prev.names.includes(nm) || prev.names.push(nm));
      } else pieces.push(Object.assign(shift(p), { coords: p.coords.slice(), names: p.names.slice() }));
    }
    const gaps = a.gaps.map((g) => Object.assign({}, g, { names: g.names.slice() }));
    for (const g of b.gaps) {
      const prev = gaps[gaps.length - 1];
      if (prev && Math.abs(prev.start + prev.length - (g.start + off)) < 1) { prev.length += g.length; prev.busy = prev.busy || g.busy; g.names.forEach((nm) => prev.names.includes(nm) || prev.names.push(nm)); }
      else gaps.push(Object.assign(shift(g), { names: g.names.slice() }));
    }
    // the turn from the detour back onto the ride (unless it simply carries on along the same street)
    const ca = buildCursor(a), cb = buildCursor(b);
    const nameB = (b.legs[0] && b.legs[0].name) || (b.pieces[0] && b.pieces[0].names[0]) || "path";
    const lastA = a.legs.length ? a.legs[a.legs.length - 1].name || "path" : null;
    const pIn = ca.at(Math.max(0, a.length - 15)), pEnd = ca.at(a.length), pOut = cb.at(Math.min(b.length, 15));
    const kind = b.length > 1 && a.length > 1 ? turnKind(window.BikeRouter.bearing(pIn.lon, pIn.lat, pEnd.lon, pEnd.lat), window.BikeRouter.bearing(pEnd.lon, pEnd.lat, pOut.lon, pOut.lat)) : "continue";
    const joint = nameB !== lastA || kind !== "continue"
      ? [{ at: off, kind, name: nameB, text: nameB, tier: (b.pieces[0] || {}).tier || 0, lon: pEnd.lon, lat: pEnd.lat }] : [];
    const later = b.maneuvers.filter((m) => m.stop || m.at > (joint.length ? 15 : 1)).map((m) => Object.assign({}, m, { at: m.at + off }));
    const byTier = a.byTier.map((m, k) => m + b.byTier[k]), length = a.length + b.length;
    return {
      legs: a.legs.concat(b.legs.map((l) => Object.assign({}, l, { dist0: (l.dist0 || 0) + off }))),
      coords, pieces, gaps, byTier, length, infraShare: length ? (byTier[0] + byTier[1] + byTier[2]) / length : 0,
      profile: (a.profile || []).concat((b.profile || []).map(([d, z]) => [d + off, z])),
      climb: a.climb + b.climb, descent: a.descent + b.descent,
      maneuvers: a.maneuvers.concat(joint, later),
      stops: (b.stops || []).map((s) => Object.assign({}, s, { at: s.at + off })),
      from: a.from, to: b.to,
    };
  }

  // ---------------------------------------------------------------- ride with the phone's GPS
  // Tuning (2026-10-30): first guesses, to check on real rides.
  const GPS = {
    ACC_MAX: 50,        // m: fixes less accurate than this are ignored
    OFF_M: 30,          // m: farther than this from the route (and clearly beyond the fix's accuracy) is off route…
    START_M: 60,        // …(or this far, until you first reach the route: a start pin is often 30-50 m from the street the route starts on)
    OFF_MS: 5000,       // …for this long before rerouting
    REROUTE_MS: 10000,  // at most one reroute this often
    ARRIVE_M: 25,       // m from the end: arrived
    LEAD_S: 1.2,        // s: carry on at the current speed at most this long after a fix (never far ahead of the next one)
    TAU_S: 0.25,        // s: the rider glides toward where you are with this time constant
    BACK_M: 30,         // m: this far behind, three fixes in a row, is a real U-turn (less is jitter and is ignored)
    STALE_MS: 8000,     // ms with no good fix: "Waiting for GPS…" again
  };
  const fin = (v) => (v != null && Number.isFinite(v) && v >= 0 ? v : null);
  // opts: route, pois, geo (navigator.geolocation or a ReplayGeo), onFrame, onEvent, onStatus({state: wait|ok|off, acc, kmh}),
  //       onOffRoute({lon, lat, acc}) -> true when the app rerouted (it calls setRoute), onError({code})
  class RideGPS extends RideCore {
    constructor(route, opts = {}) {
      super(route, opts);
      this.gps = true; this.mult = 1;
      this.geo = opts.geo !== undefined ? opts.geo : (navigator.geolocation || null);
      this.onStatus = opts.onStatus || (() => {}); this.onOffRoute = opts.onOffRoute || (() => false); this.onError = opts.onError || (() => {});
      this.fix = null; this.est = null; this.v = 0; this.back = 0;
      this.offSince = null; this.offCount = 0; this.blend = 0; this.raw = null; this.rawHeading = 0;
      this.lastReroute = -Infinity; this.jump = false; this.resync = false; this.busyUntil = 0; this.arrived = false;
      this.status = null; this.stats = { fixes: 0, ignored: 0, reroutes: 0 };
      this._watch = null; this._raf = 0; this._last = 0;
    }
    setRoute(route, pois = []) {
      super.setRoute(route, pois);
      this.track = makeTrack(route);
      this.d = 0; this.est = null; this.v = this.v || 0; this.back = 0; this.offSince = null; this.offCount = 0;
      this.joined = false;   // not on the route itself yet (the looser START_M applies)
      if (this.fix) {   // a reroute: we are where the new route starts
        const s = this.track.locate(this.fix.lon, this.fix.lat, -Infinity, 400, Math.max(25, this.fix.acc));
        this.d = this.est = this.fix.along = s.along;
      }
      this.jump = true; this.kick();
    }
    start() {
      if (this.running) return;
      this.running = true;
      this._emit({ fix: false, snap: true, gps: true });   // the route's start, until the first good fix
      this._status("wait");
      this._listen();
      this._last = performance.now(); cancelAnimationFrame(this._raf); this._raf = requestAnimationFrame((t) => this._tick(t));
    }
    pause() { this.running = false; cancelAnimationFrame(this._raf); clearTimeout(this._wakeT); this._unlisten(); }   // = stop
    seek(d) { this.d = Math.max(0, Math.min(this.cursor.total, d)); this.kick(); }
    kick(ms = 1500) { this.busyUntil = performance.now() + ms; }   // keep drawing for a moment even if nothing moves
    // the page is back after being hidden (iPhone screen lock pauses web pages): take the next fix as it comes,
    // and start the watch again if no fix arrives within 4 s
    wake() {
      if (!this.running) return;
      this.resync = true; this.kick();
      const t0 = performance.now(); clearTimeout(this._wakeT);
      this._wakeT = setTimeout(() => { if (this.running && (!this.fix || this.fix.wall < t0)) { this._unlisten(); this._listen(); } }, 4000);
    }
    _listen() {
      if (!this.geo || !this.geo.watchPosition) { this.pause(); this.onError({ code: 2, unsupported: true }); return; }
      try {
        this._watch = this.geo.watchPosition((p) => this._onPos(p), (e) => this._onErr(e), { enableHighAccuracy: true, maximumAge: 0 });
      } catch (e) { this.pause(); this.onError({ code: 2 }); }
    }
    _unlisten() { if (this._watch != null && this.geo) { try { this.geo.clearWatch(this._watch); } catch (e) { /* gone */ } } this._watch = null; }
    _onErr(e) {
      if (e && e.code === 1) { this.pause(); this.onError(e); return; }   // permission refused
      if (!this.fix) this._status("wait");                                // unavailable or slow: keep waiting
    }
    _status(state, info = {}) { this.status = state; this.onStatus(Object.assign({ state }, info)); }
    _onPos(p) {
      if (!this.running || this.arrived) return;
      const c = p.coords || {}, wall = performance.now(), t = p.timestamp || Date.now();
      this.stats.fixes++;
      if (!(c.accuracy <= GPS.ACC_MAX)) {   // too vague to place you on a street
        this.stats.ignored++;
        if (!this.fix || wall - this.fix.wall > GPS.STALE_MS) this._status("wait");
        return;
      }
      const lon = c.longitude, lat = c.latitude, acc = c.accuracy, L = this.cursor.total;
      const gap = this.fix ? Math.max(0.05, (t - this.fix.t) / 1000) : Infinity;
      const fresh = this.est == null || this.resync || gap > 6;   // first fix, or back after a pause
      this.resync = false;
      // where on the route: near where we were first (so a loop or an out-and-back doesn't jump across),
      // then further ahead (a skipped stretch, or starting part-way), then anywhere (you went back)
      const near = Math.max(25, acc), ref = this.est == null ? 0 : this.est;
      let s = this.track.locate(lon, lat, ref - 60, ref + Math.max(250, this.v * 10), near), offAll = s.off;
      if (s.off > near) {
        const fwd = this.track.locate(lon, lat, ref - 60, Infinity, near);
        const any = fwd.off <= near ? fwd : this.track.locate(lon, lat, -Infinity, Infinity, near);
        offAll = Math.min(s.off, any.off);
        if (any.off <= near && any.off + 10 < s.off) s = any;
      }
      // speed: the phone's own (Doppler) speed when it gives one, else from the fixes along the route
      const gpsV = fin(c.speed);
      const prev = this.raw ? this.raw.cur : null;
      this.raw = { prev: prev || [lon, lat], cur: [lon, lat] };
      if (prev && distM(prev[0], prev[1], lon, lat) >= 3) this.rawHeading = window.BikeRouter.bearing(prev[0], prev[1], lon, lat);
      this.fix = { lon, lat, acc, t, wall, along: s.along, off: offAll, kmh: (gpsV ?? this.v) * 3.6 };
      const strictM = Math.max(GPS.OFF_M, acc + 10);
      const onRoute = offAll <= (this.joined ? strictM : Math.max(GPS.START_M, acc + 25));
      if (offAll <= strictM) this.joined = true;
      if (onRoute) {
        this.offSince = null; this.offCount = 0;
        const pred = this.est == null ? s.along : this.est + this.v * Math.min(3, gap);
        if (fresh || Math.abs(s.along - pred) > 60) {   // start over from this fix
          if (this.est == null || Math.abs(s.along - this.d) > 3) this.jump = true;
          this.est = s.along; this.v = gpsV ?? 0; this.back = 0;
        } else {   // alpha-beta filter: smooth out a few metres of noise, keep the speed
          const r = s.along - pred, dt = Math.min(3, gap);
          this.est = pred + 0.5 * r;
          const vf = this.v + (0.2 * r) / dt;
          this.v = Math.max(0, Math.min(16, gpsV != null ? 0.7 * gpsV + 0.3 * vf : vf));
          // never backwards because of jitter; a real U-turn shows as fixes well behind, several in a row
          if (this.est < this.d - GPS.BACK_M) { if (++this.back >= 3) { this.d = this.est; this.jump = true; this.back = 0; } }
          else this.back = 0;
        }
        this.fix.along = this.est;
        this.fix.kmh = (gpsV ?? this.v) * 3.6;
      } else {
        this.offCount++;
        if (this.offSince == null) this.offSince = t;
        if (t - this.offSince >= GPS.OFF_MS && wall - this.lastReroute >= GPS.REROUTE_MS) {
          this.lastReroute = wall; this.stats.reroutes++;
          if (this.onOffRoute({ lon, lat, acc })) {   // the app found a new route and called setRoute(): carry on along it
            this.raw = { prev: [lon, lat], cur: [lon, lat] }; this.blend = 0;
            this._status("ok", { acc, kmh: this.fix.kmh }); this.kick();
            return;
          }
        }
      }
      // arrived: within 25 m of the end
      const end = this.route.coords[this.route.coords.length - 1], here = Math.max(this.est ?? 0, this.d);
      if ((onRoute && L - here <= GPS.ARRIVE_M) || (distM(lon, lat, end[0], end[1]) <= GPS.ARRIVE_M && here >= L - 150)) {
        this.arrived = true; this.d = this.est = L; this.blend = 0;
        this._status("ok", { acc, kmh: this.fix.kmh });
        this._emit({ fix: true, gps: true });
        this.pause(); this.onEvent({ type: "arrived" });
        return;
      }
      this._status(this.offCount >= 2 ? "off" : "ok", { acc, kmh: this.fix.kmh });
      this.kick();
    }
    _tick(now) {
      if (!this.running) return;
      this._raf = requestAnimationFrame((tt) => this._tick(tt));   // first, as in RideSim: camera, icons and map in the same frame
      const dt = Math.max(0, Math.min(0.1, (now - this._last) / 1000)); this._last = now;
      const f = this.fix; if (!f) return;
      if (performance.now() - f.wall > GPS.STALE_MS && this.status !== "wait") this._status("wait");
      // where you are: the filtered fix, carried on at your speed for a moment (dead reckoning between fixes)
      const lead = Math.min(GPS.LEAD_S, Math.max(0, (performance.now() - f.wall) / 1000));
      const target = Math.min(this.cursor.total, (this.est ?? 0) + (this.offCount ? 0 : this.v * lead));
      const d0 = this.d; let snap = false;
      if (this.jump) { this.d = target; this.jump = false; snap = true; }
      else if (target > this.d) this.d += (target - this.d) * (1 - Math.exp(-dt / GPS.TAU_S));   // glide, never backwards
      // off route (two fixes in a row): draw the rider where the phone is, eased in and out
      const b0 = this.blend, bt = this.offCount >= 2 ? 1 : 0;
      this.blend = Math.abs(bt - b0) < 0.002 ? bt : b0 + (bt - b0) * (1 - Math.exp(-dt / 0.35));
      if (!snap && Math.abs(this.d - d0) < 1e-3 && this.blend === b0 && !(this.blend > 0) && now > this.busyUntil) return;   // standing still: nothing to draw
      let pos = this.cursor.at(this.d);
      if (this.blend > 0 && this.raw) {
        const u = Math.max(0, Math.min(1, (performance.now() - f.wall) / 1000)), [p0, p1] = [this.raw.prev, this.raw.cur];
        const rl = p0[0] + (p1[0] - p0[0]) * u, ra = p0[1] + (p1[1] - p0[1]) * u, k = this.blend;
        pos = { lon: pos.lon + (rl - pos.lon) * k, lat: pos.lat + (ra - pos.lat) * k, heading: k > 0.5 ? this.rawHeading : pos.heading };
      }
      this._emit({ pos, fix: true, snap, gps: true, off: this.blend > 0.5 });
    }
  }

  // ---------------------------------------------------------------- a pretend GPS for tests and screenshots (?gps=replay)
  // Works like navigator.geolocation (watchPosition / clearWatch), so the ride runs through exactly the same code as real GPS.
  // A synthetic ride along the ride's current route: one fix a second (faster with `speedup`), a few metres of noise,
  // a poor fix now and then (to be ignored), and optionally a detour: 60 m off to one side, 150 m alongside the route, then back.
  // After the app reroutes, it carries on along the new route.
  class ReplayGeo {
    constructor(opts = {}) {
      this.getRoute = opts.getRoute || (() => null);
      this.v = (opts.kmh || 18) / 3.6; this.k = Math.max(0.25, opts.speedup || 1);
      this.noise = opts.noise ?? 2.5; this.startAt = opts.startAt || 0;
      this.detourAt = opts.detourAt ?? null; this.detour = { out: 60, along: 150 };
      this.deny = !!opts.deny; this.warmup = opts.warmup ?? 2;
      let seed = opts.seed || 7;   // repeatable noise
      this.rand = () => { seed = (seed + 0x6D2B79F5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
      this.timers = new Map(); this.seq = 0; this.n = 0; this.route = null; this.phase = "route"; this.log = [];
    }
    watchPosition(ok, err) {
      const id = ++this.seq;
      if (this.deny) { setTimeout(() => err && err({ code: 1, message: "User denied Geolocation" }), 200); return id; }
      this.timers.set(id, setInterval(() => this._step(ok), 1000 / this.k));
      setTimeout(() => this._step(ok), 120);
      return id;
    }
    clearWatch(id) { clearInterval(this.timers.get(id)); this.timers.delete(id); }
    getCurrentPosition(ok, err) { const id = this.watchPosition((p) => { this.clearWatch(id); ok(p); }, err); }
    _gauss() { return Math.sqrt(-2 * Math.log(1 - this.rand())) * Math.cos(2 * Math.PI * this.rand()); }
    // s metres into the detour: out at a right angle (side 1 = right, -1 = left), alongside the route, then back
    _detourAt(s, side) {
      const { out, along } = this.detour, D = this.det;
      const x = (s < out ? s : s < out + along ? out : 2 * out + along - s) * side, y = s < out ? 0 : s < out + along ? s - out : along;
      const h = D.h * D2R, east = x * Math.cos(h) + y * Math.sin(h), north = -x * Math.sin(h) + y * Math.cos(h);
      return [D.lon + east / (111320 * Math.cos(D.lat * D2R)), D.lat + north / 110540];
    }
    _step(ok) {
      const r = this.getRoute(); if (!r) return;
      const now = performance.now(), dt = this._t ? Math.min(3, (now - this._t) / 1000) : 0; this._t = now;
      const ds = this.v * this.k * dt;
      if (r !== this.route) {
        if (this.route && this.pos) { this.d = makeTrack(r).locate(this.pos[0], this.pos[1]).along; this.phase = "route"; this.detourAt = null; }   // rerouted
        else this.d = this.startAt;
        this.route = r; this.cur = buildCursor(r);
      } else if (this.phase === "detour") this.s += ds;
      else this.d = Math.min(this.cur.total, this.d + ds);
      if (this.phase === "route" && this.detourAt != null && this.d >= this.detourAt) {
        const p = this.cur.at(this.detourAt), tr = makeTrack(r);
        this.det = { lon: p.lon, lat: p.lat, h: p.heading, d: this.detourAt, side: 1 };
        // go off on the side where the detour stays clear of the route (it may turn that way just after)
        const clear = (side) => { let m = Infinity; for (let s = this.detour.out; s <= this.detour.out + this.detour.along; s += 10) { const q = this._detourAt(s, side); m = Math.min(m, tr.locate(q[0], q[1]).off); } return m; };
        this.det.side = clear(1) >= clear(-1) ? 1 : -1;
        this.phase = "detour"; this.s = this.d - this.detourAt; this.detourAt = null;
      }
      let lon, lat, heading, speed = this.v * this.k;
      if (this.phase === "detour") {
        const { out, along } = this.detour, s = this.s, D = this.det;
        if (s >= 2 * out + along) { this.phase = "route"; this.d = D.d + along + (s - 2 * out - along); }
        else {
          [lon, lat] = this._detourAt(s, D.side);
          heading = (D.h + (s < out ? 90 * D.side : s < out + along ? 0 : -90 * D.side) + 360) % 360;
        }
      }
      if (this.phase === "route") {
        const p = this.cur.at(this.d); lon = p.lon; lat = p.lat; heading = p.heading;
        if (this.d >= this.cur.total) speed = 0;
      }
      this.pos = [lon, lat]; this.n++;
      // noise; the first fixes and every 13th are poor (the ride should ignore them)
      const bad = this.n <= this.warmup || this.n % 13 === 7;
      const e = bad ? 30 : this.noise, gx = this._gauss() * e, gy = this._gauss() * e;
      const fix = { latitude: lat + gy / 110540, longitude: lon + gx / (111320 * Math.cos(lat * D2R)),
        accuracy: bad ? 60 + this.rand() * 40 : 5 + this.rand() * 6, speed: Math.max(0, speed + this._gauss() * 0.3),
        heading: speed > 0.5 ? (heading + this._gauss() * 8 + 360) % 360 : NaN, altitude: null, altitudeAccuracy: null };
      this.log.push({ t: now, lon, lat, d: this.d, phase: this.phase, bad, fix: [fix.longitude, fix.latitude] });
      if (this.log.length > 2000) this.log.shift();
      ok({ coords: fix, timestamp: Date.now() });
    }
  }

  // ---------------------------------------------------------------- voice (prompts via speaker; commands where supported)
  const voice = {
    enabled: false,
    say(text) {
      if (!this.enabled || !window.speechSynthesis) return;
      const u = new SpeechSynthesisUtterance(text);
      const L = lang(), vs = speechSynthesis.getVoices();
      const v = vs.find((x) => new RegExp(`^${L}-CA`, "i").test(x.lang)) || vs.find((x) => new RegExp(`^${L}`, "i").test(x.lang));
      u.lang = L === "fr" ? "fr-CA" : "en-CA";
      if (v) u.voice = v;
      u.rate = 1.02; speechSynthesis.cancel(); speechSynthesis.speak(u);
    },
    // iPhone Safari only speaks once speech has started from a tap: a silent line, said inside the tap, unlocks it
    prime() {
      if (!window.speechSynthesis) return;
      try { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; u.lang = lang() === "fr" ? "fr-CA" : "en-CA"; speechSynthesis.speak(u); } catch (e) { /* no speech */ }
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
    const I = window.BikeI18n;
    const d = Math.round(dist / 10) * 10, m = Math.round(g.length / 10) * 10;
    if (!I) return `In ${d} metres, ${m} metres without a bike path${g.names[0] ? ` on ${g.names[0]}` : ""}${g.busy ? ", with traffic" : ""}.`;
    const on = g.names[0] ? (I.lang === "fr" ? ` sur ${I.place(g.names[0])}` : ` on ${I.place(g.names[0])}`) : "";
    return I.t("gapVoice", { d, m, on, busy: g.busy ? I.t("gapVoiceBusy") : "" });
  }

  window.BikeCommon = { STM, TIER_LABEL, TIER_SHORT, POI_KINDS, iconSVG, svgToImage, addMapIcons, poisGeoJSON, unpackBuildings,
    routePiecesGeoJSON, routeLineGeoJSON, gapStartsGeoJSON, rideMinutes, fmtKm, fmtMin, fmtPct, esc, routePOIs, climbs, lookahead,
    elevAt, profileWindow, climbMaxGrade, climbName, sliceCoords, climbsGeoJSON, mainGaps, poiLabel, GAP_MIN,
    profileSVG, makeGeocoder, RideSim, RideGPS, ReplayGeo, GPS, makeTrack, tailRoute, joinRoutes, voice, gapSentence, buildCursor, distM };
})();
