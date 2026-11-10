/* Bridges in 3D rides (2026-11-09): a MapLibre custom layer that lifts the route onto the deck of a significant bridge.
   Why: the terrain is bare earth (LiDAR with the bridges taken out), and the route line is draped on it, so in a 3D ride the line followed the
   river bank down to the water and back up. The route's own elevation profile is right (build_graph.py interpolates it across the bridge).
   What it does, for the route being ridden only (setRoute, called from the ride's frame loop):
    1. Finds the significant bridges: stretches of the route that the graph marks as a structure, where the route's elevation is at least
       EDGE_GAP above the ground model (our LiDAR terrain tile, read here at zoom 14, true metres) and which are at least MIN_LEN long and rise
       at least MIN_RISE above the ground somewhere. (An underpass or tunnel has its deck below the ground, so it never qualifies.)
    2. Builds, once per route, one small mesh per bridge: the route drawn at deck height (outline, white edge, tier colour, as the draped
       line), a thin fascia under each edge, a faint shadow on the ground and a post under each edge every 30 m. Heights are stored raw
       and the terrain's exaggeration is applied every frame (the ride camera changes it without any event), as in edges3d.js.
    3. Hides the draped line under the deck (the route pieces are cut at the deck's ends, see common.js routePiecesGeoJSON, and the six route
       layers get a filter that leaves the cut part out while the deck is drawn) and lifts the rider's markers onto the deck (a pixel offset).
   Nothing runs outside a 3D ride with terrain: no terrain, no analysis, no drawing, the filters untouched. Per frame: one matrix and two
   uniforms per bridge, plus a few multiplications for the rider.
   If anything fails (no WebGL 1 vertex arrays, a shader error, a lost context) the layer draws nothing, warns once in the console, puts the
   draped line back and calls onFail(reason); it never throws into the map. Classic script: window.BikeBridge3D. */
(function () {
  "use strict";
  const MIN_LEN = 40;        // m: shorter structures (culverts, small footbridges) are not drawn
  const MIN_RISE = 4;        // m: the deck must rise this far above the ground model somewhere along it
  const EDGE_GAP = 0.5;      // m: the deck counts as "on the bridge" from this height above the ground (the ends meet the ground)
  const STEP = 10;           // m between cross-sections along the deck
  const POST_EVERY = 3;      // a post every 3 cross-sections (30 m) where the deck is at least POST_MIN above the ground
  const POST_MIN = 2;        // m
  const THICK = 1.0;         // m: the deck's fascia, under each edge
  const SHADOW = 1.7;        // the shadow is this many times as wide (half-width) as the deck
  const LIFT = 0.4;          // m: the shadow lies this far above the ground, so the terrain does not cut it
  const CAST = 0.8;          // the shadow lies this share of the deck's height to the side of it (to the north or east), so it shows beside the deck, not under it
  const CORE = 0.54, CASING = 0.86;   // the deck's bands, as shares of the outline's half-width: tier colour, white edge, then the outline (the route lines' 10, 16 and 18.6 px)
  const DEM_Z = 14;          // the terrain tiles' own zoom (the local ones are 14 at most)
  const MAX_BRIDGES = 40;    // a safety cap on the meshes (a 100 km ride has a handful)
  const EARTH_C = 2 * Math.PI * 6371008.8;   // MapLibre's earth circumference, m
  const mercX = (lng) => (180 + lng) / 360;
  const mercY = (lat) => (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;
  const mercPerMetre = (lat) => 1 / (EARTH_C * Math.cos((lat * Math.PI) / 180));
  // the route lines' width in px by zoom (app.js: "route-ink", 8.6 at zoom 12 to 18.6 at 17), and what a px is worth in metres at this latitude
  const inkPx = (z) => 8.6 + (18.6 - 8.6) * Math.max(0, Math.min(1, (z - 12) / 5));
  const metresPerPx = (z, lat) => (EARTH_C * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** z);
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

  const VERT = `
uniform mat4 u_matrix;     // local metres (x east, y south, z up) to clip space
uniform float u_exag;      // the terrain's exaggeration now: heights are stored raw
uniform float u_halfw;     // the outline's half-width now, in metres (the route lines' width in px, in metres at this zoom)
uniform vec3 u_core[6];    // the tier colours
attribute vec4 a_p;        // x, y, the unit normal
attribute vec4 a_h;        // across (-1..1 the outline's width), raw height (deck or ground), lift in metres, tier
varying float v_s;
varying vec3 v_core;
void main() {
  v_s = a_h.x;
  v_core = u_core[int(a_h.w + 0.5)];
  gl_Position = u_matrix * vec4(a_p.xy + a_p.zw * (a_h.x * u_halfw), a_h.y * u_exag + a_h.z, 1.0);
}`;
  const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform float u_mode;      // 0 the deck, 1 the fascia, 2 the shadow, 3 the posts
uniform vec3 u_ink;        // the outline
uniform vec3 u_post;       // fascia and posts
varying float v_s;
varying vec3 v_core;
void main() {
  float a = abs(v_s);
  if (u_mode < 0.5) gl_FragColor = vec4(a < ${CORE} ? v_core : (a < ${CASING} ? vec3(1.0) : u_ink), 1.0);
  else if (u_mode < 1.5) gl_FragColor = vec4(u_post, 1.0);
  else if (u_mode < 2.5) { float k = 0.22 * (1.0 - smoothstep(0.5, ${SHADOW.toFixed(1)}, a)); gl_FragColor = vec4(0.0, 0.0, 0.0, k); }
  else gl_FragColor = vec4(u_post * 0.75, 0.75);
}`;

  function vaoApi(gl) {
    if (typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext) {
      return { create: () => gl.createVertexArray(), bind: (v) => gl.bindVertexArray(v), drop: (v) => gl.deleteVertexArray(v) };
    }
    const va = gl.getExtension("OES_vertex_array_object");
    if (!va) throw new Error("WebGL 1 without vertex arrays");
    return { create: () => va.createVertexArrayOES(), bind: (v) => va.bindVertexArrayOES(v), drop: (v) => va.deleteVertexArrayOES(v) };
  }
  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("bridge shader: " + (gl.getShaderInfoLog(s) || "did not compile"));
    return s;
  }
  function program(gl) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT)); gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.bindAttribLocation(p, 0, "a_p"); gl.bindAttribLocation(p, 1, "a_h");
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("bridge shaders: " + (gl.getProgramInfoLog(p) || "did not link"));
    const u = (n) => gl.getUniformLocation(p, n);
    return { p, matrix: u("u_matrix"), exag: u("u_exag"), halfw: u("u_halfw"), core: u("u_core[0]"), mode: u("u_mode"), ink: u("u_ink"), post: u("u_post") };
  }

  // ---- the ground: our terrain tiles (Terrarium PNG: height = R * 256 + G + B / 256 - 32768), read once and kept
  const tiles = new Map();   // "14/x/y" -> Promise<Uint8ClampedArray | null>
  function loadTile(key, url) {
    if (!tiles.has(key)) {
      const p = (async () => {
        const res = await fetch(url);
        if (!res.ok) return null;
        const blob = await res.blob();
        let bmp;
        try { bmp = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" }); } catch (e) { bmp = await createImageBitmap(blob); }
        const c = document.createElement("canvas"); c.width = c.height = 256;
        const g = c.getContext("2d", { willReadFrequently: true });
        g.drawImage(bmp, 0, 0); if (bmp.close) bmp.close();
        return g.getImageData(0, 0, 256, 256).data;
      })().catch(() => { tiles.delete(key); return null; });   // not kept when it failed: the next route tries again
      tiles.set(key, p);
    }
    return tiles.get(key);
  }
  const tileAt = (lon, lat) => { const n = 2 ** DEM_Z, fx = mercX(lon) * n, fy = mercY(lat) * n; return { key: `${DEM_Z}/${Math.floor(fx)}/${Math.floor(fy)}`, px: Math.min(255, Math.floor((fx % 1) * 256)), py: Math.min(255, Math.floor((fy % 1) * 256)) }; };

  // ---- the route between two distances, as points at most STEP apart: lon, lat and the distance along the route of each
  function trace(route, d0, d1) {
    const C = window.BikeCommon, c = C.sliceCoords(route, d0, d1);
    if (c.length < 2) return null;
    const cum = [0];
    for (let i = 1; i < c.length; i++) cum.push(cum[i - 1] + window.BikeRouter.distM(c[i - 1][0], c[i - 1][1], c[i][0], c[i][1]));
    const total = cum[cum.length - 1];
    if (total < 1) return null;
    const k = (d1 - d0) / total, lon = [c[0][0]], lat = [c[0][1]], d = [d0];
    for (let i = 1; i < c.length; i++) {
      const seg = cum[i] - cum[i - 1], n = Math.max(1, Math.ceil(seg / STEP));
      for (let j = 1; j <= n; j++) {
        const u = j / n;
        lon.push(c[i - 1][0] + (c[i][0] - c[i - 1][0]) * u); lat.push(c[i - 1][1] + (c[i][1] - c[i - 1][1]) * u); d.push(d0 + (cum[i - 1] + seg * u) * k);
      }
    }
    return { lon, lat, d };
  }

  // The significant bridges of a route: [{ d0, d1, rise, ...samples }]. o.isStructure(leg), o.demUrl(key) -> url | null. Async: reads terrain tiles.
  async function find(route, o) {
    const C = window.BikeCommon, runs = [];
    for (const l of route.legs || []) {   // consecutive legs on structures make one run
      if (!(l.len > 0) || !o.isStructure(l)) continue;
      const a = l.dist0, b = a + l.len, last = runs[runs.length - 1];
      if (last && a - last[1] < 1) last[1] = b; else runs.push([a, b]);
    }
    const cand = runs.filter(([a, b]) => b - a >= MIN_LEN).slice(0, MAX_BRIDGES).map(([a, b]) => trace(route, a, b)).filter(Boolean);
    if (!cand.length) return [];
    const need = new Map();
    for (const t of cand) for (let i = 0; i < t.d.length; i++) { const k = tileAt(t.lon[i], t.lat[i]).key; if (!need.has(k)) need.set(k, o.demUrl(k)); }
    const data = new Map(await Promise.all([...need].map(async ([k, url]) => [k, url ? await loadTile(k, url) : null])));
    const out = [];
    for (const t of cand) {
      const n = t.d.length, deck = new Float32Array(n), ground = new Float32Array(n);
      let ok = true;
      for (let i = 0; i < n && ok; i++) {
        const a = tileAt(t.lon[i], t.lat[i]), px = data.get(a.key);
        if (!px) { ok = false; break; }   // no ground model here (a tile beyond our LiDAR, or one that did not load): no judgement, the draped line stays
        const q = (a.py * 256 + a.px) * 4;
        ground[i] = px[q] * 256 + px[q + 1] + px[q + 2] / 256 - 32768;
        deck[i] = C.elevAt(route, t.d[i]);
      }
      if (!ok) continue;
      for (let i = 0; i < n; i++) {   // the stretches where the deck is clear of the ground
        if (deck[i] - ground[i] < EDGE_GAP) continue;
        let j = i, rise = 0;
        while (j < n && deck[j] - ground[j] >= EDGE_GAP) { rise = Math.max(rise, deck[j] - ground[j]); j++; }
        const lo = Math.max(0, i - 1), hi = Math.min(n - 1, j);   // one cross-section more at each end, where the deck meets the ground
        if (t.d[j - 1] - t.d[i] >= MIN_LEN && rise >= MIN_RISE) {
          out.push({ d0: t.d[lo], d1: t.d[hi], rise: +rise.toFixed(1), lon: t.lon.slice(lo, hi + 1), lat: t.lat.slice(lo, hi + 1), d: Float32Array.from(t.d.slice(lo, hi + 1)),
            deck: deck.slice(lo, hi + 1), ground: ground.slice(lo, hi + 1) });
        }
        i = j;
      }
    }
    return out;
  }

  // One bridge's mesh (floats: x, y, normal x, normal y, across, raw height, lift, tier; 6 per quad corner pair). Sets st.x, st.y (metres from
  // the bridge's own origin, east and south) and st.origin, and returns the data with the draw ranges: shadow, fascia, deck, then posts as lines.
  function build(st, route) {
    const n = st.d.length, mid = n >> 1, ox = mercX(st.lon[mid]), oy = mercY(st.lat[mid]), k = mercPerMetre(st.lat[mid]);
    st.origin = [ox, oy, k]; st.x = new Float32Array(n); st.y = new Float32Array(n);
    for (let i = 0; i < n; i++) { st.x[i] = (mercX(st.lon[i]) - ox) / k; st.y[i] = (mercY(st.lat[i]) - oy) / k; }
    const nx = new Float32Array(n), ny = new Float32Array(n), tier = new Uint8Array(n);
    for (let i = 0, p = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1), tx = st.x[b] - st.x[a], ty = st.y[b] - st.y[a], L = Math.hypot(tx, ty) || 1;
      nx[i] = -ty / L; ny[i] = tx / L;
      while (p < route.pieces.length - 1 && route.pieces[p].start + route.pieces[p].length < st.d[i]) p++;
      tier[i] = Math.min(5, route.pieces[p] ? route.pieces[p].tier : 0);
    }
    const posts = []; for (let i = 0; i < n; i += POST_EVERY) if (st.deck[i] - st.ground[i] >= POST_MIN) posts.push(i);
    const quads = n - 1, verts = quads * 6 * 4 + posts.length * 4, out = new Float32Array(verts * 8);
    let j = 0;
    const put = (i, s, raw, lift, mx = 0, my = 0) => { out[j++] = st.x[i] + mx; out[j++] = st.y[i] + my; out[j++] = nx[i]; out[j++] = ny[i]; out[j++] = s; out[j++] = raw; out[j++] = lift; out[j++] = tier[i]; };
    // a strip along the bridge between two lines of (across, raw height, lift), both given by a function of the cross-section
    const strip = (top, bottom) => { for (let i = 0; i < quads; i++) { const [a, b] = [top(i), bottom(i)], [c, d] = [top(i + 1), bottom(i + 1)];
      put(i, ...a); put(i, ...b); put(i + 1, ...c); put(i, ...b); put(i + 1, ...d); put(i + 1, ...c); } };
    // the draw order's ranges: shadow, then the fascia (both sides), then the deck
    const mark = []; const at = () => mark.push(j / 8);
    const cast = (i) => { const h = (st.deck[i] - st.ground[i]) * CAST, q = nx[i] - ny[i] >= 0 ? 1 : -1; return [nx[i] * q * h, ny[i] * q * h]; };   // towards the north-east side
    strip((i) => [-SHADOW, st.ground[i], LIFT, ...cast(i)], (i) => [SHADOW, st.ground[i], LIFT, ...cast(i)]); at();
    for (const s of [-1, 1]) strip((i) => [s, st.deck[i], 0], (i) => [s, st.deck[i], -THICK]); at();
    strip((i) => [-1, st.deck[i], 0], (i) => [1, st.deck[i], 0]); at();
    for (const i of posts) for (const s of [-1, 1]) { put(i, s, st.deck[i], -THICK); put(i, s, st.ground[i], LIFT); } at();
    st.ranges = mark;   // end of the shadow, fascia, deck and posts, in vertices
    return out.subarray(0, j);
  }

  class BridgeLayer {
    // opts: id, before (the layer it goes under), layers (the route's line layers, whose draped line is left out under a deck), isStructure(leg),
    // demUrl(key), colors() -> { core: [6 hex, by tier], ink, post }, onChange() (bridges found: redraw the route), onFail(reason)
    constructor(map, opts) {
      this.id = opts.id; this.type = "custom"; this.renderingMode = "3d";
      this.map = map; this.opt = opts;
      this.route = null; this.stretches = []; this.token = 0; this.error = null; this.warned = false; this.gl = null; this.cutOn = false;
      this.filters = new Map(); this.base = new Map(); this.trash = []; this.colorsRef = null; this.col = null;
      this.stats = { done: 0, found: 0, vertices: 0, bytes: 0, findMs: 0, buildMs: 0, drawn: 0, frames: 0, webgl: 0 };   // done: routes looked at so far
      this.matrix = new Float32Array(16);
      this.onTerrain = () => this.syncCut();
      this.onLost = () => this.fail("WebGL context lost");
    }
    info() { return { error: this.error, on: this.on(), cut: this.cutOn, stretches: this.stretches.map((s) => ({ d0: +s.d0.toFixed(1), d1: +s.d1.toFixed(1), len: Math.round(s.d1 - s.d0), rise: s.rise })), ...this.stats }; }
    // a bridge is drawn (and the draped line left out under it) only while the map has terrain: in a flat view the line is not dipping
    on() { return !this.error && this.stretches.length > 0 && !!this.map.terrain; }

    // The route now being ridden (null: none). Finds its bridges in the background, then asks the app to draw the route again with them cut out.
    setRoute(route) {
      if (route === this.route) return;
      this.route = route; this.release(); this.syncCut();
      const token = ++this.token;
      if (!route || this.error) return;
      const t0 = performance.now();
      find(route, this.opt).then((list) => {
        if (token !== this.token || this.error) return;   // another route since
        this.stats.findMs = +(performance.now() - t0).toFixed(1); this.stats.done++;
        if (!list.length) return;
        let bytes = 0, vertices = 0;
        for (const st of list) { st.data = build(st, route); bytes += st.data.byteLength; vertices += st.data.length / 8; }
        this.stretches = list; this.stats.found = list.length; this.stats.bytes = bytes; this.stats.vertices = vertices;
        this.stats.buildMs = +(performance.now() - t0).toFixed(1);
        if (!this.map.getLayer(this.id)) this.map.addLayer(this, this.opt.before && this.map.getLayer(this.opt.before) ? this.opt.before : undefined);
        this.syncCut(); this.opt.onChange && this.opt.onChange(); this.map.triggerRepaint();
      }).catch((e) => this.fail("bridge data: " + (e && e.message ? e.message : e)));
    }
    release() {   // the old route's meshes go (the graphics objects at the next frame), and the markers drop back to the street
      for (const st of this.stretches) if (st.buf) this.trash.push(st);
      this.stretches = []; this.stats.found = this.stats.vertices = this.stats.bytes = this.stats.drawn = 0;
      for (const [m, b] of this.base) if (b.dx || b.dy) { m.setOffset([b.x, b.y]); b.dx = b.dy = 0; }
    }
    // [from, to] pairs, in metres along `route` (or a part of it starting `off` metres in, `len` long), where the draped line is left out
    cuts(route, off = 0, len = Infinity) {
      if (route !== this.route || !this.stretches.length) return [];
      return this.stretches.map((s) => [Math.max(0, s.d0 - off), Math.min(len, s.d1 - off)]).filter(([a, b]) => b - a > 0.5);
    }
    // The six route layers leave out the pieces marked br = 1 while a deck is drawn; they are put back as they were when it is not
    syncCut() {
      const map = this.map, want = this.on();
      if (want === this.cutOn) return;
      this.cutOn = want;
      for (const id of this.opt.layers) {
        if (!map.getLayer(id)) continue;
        if (want && !this.filters.has(id)) this.filters.set(id, map.getFilter(id) || null);
        const base = this.filters.get(id), hide = ["!=", ["get", "br"], 1];
        map.setFilter(id, want ? (base ? ["all", base, hide] : hide) : base);
      }
      if (!want) this.filters.clear();
    }

    // The rider on the deck: the markers are lifted by what the deck's height is worth on the screen (from the matrix of the last frame)
    follow(route, d, markers) {
      if (route !== this.route && this.map.terrain) this.setRoute(route);
      let dx = 0, dy = 0;
      if (this.on()) {
        const s = this.stretches.find((q) => d >= q.d0 && d <= q.d1);
        if (s && s.M) [dx, dy] = this.riderShift(s, d);
      }
      for (const m of markers) {
        let b = this.base.get(m);
        if (!b) { const o = m.getOffset(); this.base.set(m, (b = { x: o.x, y: o.y, dx: 0, dy: 0 })); }
        if (Math.abs(dx - b.dx) + Math.abs(dy - b.dy) < 0.3) continue;   // not for a fraction of a pixel
        b.dx = dx; b.dy = dy; m.setOffset([b.x + dx, b.y + dy]);
      }
    }
    riderShift(s, d) {
      let i = 1; while (i < s.d.length - 1 && s.d[i] < d) i++;
      const u = Math.max(0, Math.min(1, (d - s.d[i - 1]) / ((s.d[i] - s.d[i - 1]) || 1)));
      const mix = (a) => a[i - 1] + (a[i] - a[i - 1]) * u, ex = this.map.terrain.exaggeration;
      const x = mix(s.x), y = mix(s.y), g = mix(s.ground) * ex, up = Math.max(0, mix(s.deck) - mix(s.ground)) * ex, M = s.M;
      const sy = (z) => { const w = M[3] * x + M[7] * y + M[11] * z + M[15]; return [(M[0] * x + M[4] * y + M[8] * z + M[12]) / w, (M[1] * x + M[5] * y + M[9] * z + M[13]) / w]; };
      const a = sy(g), b = sy(g + up), c = this.map.getCanvas();
      return [((b[0] - a[0]) * c.clientWidth) / 2, (-(b[1] - a[1]) * c.clientHeight) / 2];
    }

    fail(reason) {
      if (this.error) return;
      this.error = reason; this.stats.drawn = 0;
      if (!this.warned) { this.warned = true; console.warn(`3D bridges: WebGL drawing stopped (${reason}); the route line stays on the ground`); }
      try { this.release(); this.syncCut(); } catch (e) { /* the style may be gone with a lost context */ }
      setTimeout(() => this.opt.onFail && this.opt.onFail(reason), 0);   // not from inside the map's drawing
      if (this.opt.onChange) setTimeout(this.opt.onChange, 0);
    }

    onAdd(map) { map.on("terrain", this.onTerrain); map.on("webglcontextlost", this.onLost); }
    onRemove(map, gl) {
      map.off("terrain", this.onTerrain); map.off("webglcontextlost", this.onLost);
      if (this.gl && gl && !gl.isContextLost()) { gl.deleteProgram(this.gl.prog.p); for (const st of this.stretches.concat(this.trash)) this.drop(st); }
      this.gl = null; this.trash = [];
    }

    // ---- drawing (inside MapLibre's frame, which resets its own GL state afterwards)
    init(gl) {
      const api = vaoApi(gl); this.gl = { api, prog: program(gl) };
      this.stats.webgl = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext ? 2 : 1;
      this.syncCut();
    }
    drop(st) { if (!st.buf) return; this.gl.api.drop(st.vao); this.gl.ctx.deleteBuffer(st.buf); st.buf = st.vao = null; }
    upload(gl, st) {
      const api = this.gl.api;
      st.vao = api.create(); st.buf = gl.createBuffer();
      api.bind(st.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, st.buf); gl.bufferData(gl.ARRAY_BUFFER, st.data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 32, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 16);
      api.bind(null);
      st.M = new Float32Array(16);
    }
    render(gl, args) {
      if (this.error) return;
      try { this.draw(gl, args); } catch (e) { this.fail(e.message || String(e)); }
    }
    draw(gl, args) {
      if (gl.isContextLost()) { this.fail("WebGL context lost"); return; }
      if (!this.gl) { this.init(gl); this.gl.ctx = gl; }
      const g = this.gl, map = this.map;
      for (const st of this.trash.splice(0)) this.drop(st);
      if (!this.on()) { this.stats.drawn = 0; return; }
      const colors = this.opt.colors();
      if (colors !== this.colorsRef) {   // the colours changed (day, night): parsed again, once
        this.colorsRef = colors;
        this.col = { core: new Float32Array(colors.core.flatMap(rgb)), ink: new Float32Array(rgb(colors.ink)), post: new Float32Array(rgb(colors.post)) };
      }
      const A = args && args.defaultProjectionData ? args.defaultProjectionData.mainMatrix : args;
      const z = map.getZoom(), c = map.getCenter(), kz = mercPerMetre(c.lat);   // MapLibre scales heights at the map's centre
      gl.useProgram(g.prog.p);
      gl.uniform1f(g.prog.exag, map.terrain.exaggeration);
      gl.uniform1f(g.prog.halfw, (inkPx(z) * metresPerPx(z, c.lat)) / 2);
      gl.uniform3fv(g.prog.core, this.col.core); gl.uniform3fv(g.prog.ink, this.col.ink); gl.uniform3fv(g.prog.post, this.col.post);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
      for (const st of this.stretches) {
        if (!st.buf) this.upload(gl, st);
        const [ox, oy, k] = st.origin, M = st.M;
        for (let i = 0; i < 4; i++) { M[i] = A[i] * k; M[4 + i] = A[4 + i] * k; M[8 + i] = A[8 + i] * kz; M[12 + i] = A[i] * ox + A[4 + i] * oy + A[12 + i]; }
        gl.uniformMatrix4fv(g.prog.matrix, false, M);
        g.api.bind(st.vao);
        const [shadow, fascia, deck, posts] = st.ranges;
        gl.depthMask(false); gl.uniform1f(g.prog.mode, 2); gl.drawArrays(gl.TRIANGLES, 0, shadow);                  // the shadow does not hide anything
        gl.uniform1f(g.prog.mode, 3); gl.drawArrays(gl.LINES, deck, posts - deck);                                     // the posts
        gl.depthMask(true); gl.uniform1f(g.prog.mode, 1); gl.drawArrays(gl.TRIANGLES, shadow, fascia - shadow);       // the fascia
        gl.uniform1f(g.prog.mode, 0); gl.drawArrays(gl.TRIANGLES, fascia, deck - fascia);                              // the deck
        g.api.bind(null);
      }
      this.stats.drawn = this.stretches.length; this.stats.frames++;
    }
  }

  window.BikeBridge3D = { create: (map, opts) => new BridgeLayer(map, opts), find, MIN_LEN, MIN_RISE, EDGE_GAP };
})();
