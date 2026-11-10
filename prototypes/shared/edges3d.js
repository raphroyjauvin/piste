/* 3D building edges drawn with WebGL (2026-11-07): a MapLibre custom layer that draws thin "clear-line" ink edges on the 3D buildings of
   a fill-extrusion layer (the roof outline, the base outline and a vertical line at each corner where the outline turns by more than
   about 34 degrees), like a pen drawing. One device pixel wide, depth-tested against the buildings and the terrain so a wall in front
   hides the lines behind it; each line end is nudged 0.3 m toward the camera (a fixed distance, not a depth bias) so
   the lines do not flicker against the wall they sit on.
   Building outlines: the map's own vector tiles of the layer's source (read with querySourceFeatures when a tile loads and when the map
   is idle). Edges cut by a tile border (they run exactly along a tile's edge) are left out, so only real walls are drawn.
   Terrain: MapLibre lifts every fill-extrusion by the terrain's height at its polygon's centroid (the mean of its vertices): roof at
   height + ground, base at ground - 10 m. Each building's lines are lifted the same way, by the same ground height, so they sit on the
   building on a hill. The ground is read like shared/trees3d.js does (the terrain's exaggerated height).
   At most MAX_LINES lines are drawn; when more are loaded the tiles nearest the map's centre win (stats.capped says so).
   If anything fails while drawing (an old browser, a shader error, a context found lost) the layer draws nothing, warns once in the
   console and calls onFail(reason); it never throws into the map. A lost context also removes every custom layer from the map.
   2026-11-09 hand-inked feel (OVERSHOOT, CORNER_UP, PRESSURE below): lines run a little past their ends, and their opacity varies gently with
   position, like pen pressure. The overshoot is built into the packed lines; the pressure is a hash in the vertex shader. No cost per frame.
   Classic script: window.BikeEdges3D. */
(function () {
  "use strict";
  const MAX_LINES = 200000;      // lines drawn at most: 24 bytes each, about 5 MB, light for a phone's GPU
  const MIN_HEIGHT = 2;          // m: lower buildings (sheds, garages) get no lines
  const TURN = 0.6;              // rad (about 34 degrees): a corner line where the outline turns by more than this
  const NUDGE = 0.3;             // m: every line end moves this far toward the camera, so a line is not hidden by the wall it lies on
  // 2026-11-09 "hand-inked" feel, at no cost per frame (0 switches a part off). Overshoot is done once, when the lines are packed; pressure is
  // a smooth hash of the vertex position in the vertex shader (no attribute, no memory), the same picture every frame and after every rebuild.
  const OVERSHOOT = 0.35;        // m: roof and base lines run this far past both ends, along their own direction (stay in the wall / roof plane)
  const CORNER_UP = 0.3;         // m: corner lines run this far above the roof (never below the ground)
  const PRESSURE = 0.3;          // share of the opacity the pen pressure can take away: lines are 0.7 to 1.0 of the layer's alpha
  const PRESSURE_CELL = 8;       // m: how far apart the pressure changes (smaller = busier; must divide 4096 so the wrap is seamless)
  const BASE_LIFT = 0.05;        // m: the base line sits just above the ground it stands on
  const BUFFER = 0.1;            // an axis-aligned edge within this share of a tile from its border is a tile cut
  const STRIDE = 4;              // per line end: x, y (m from the origin, east and south), the ground's raw height (m), height above the ground (m)
  const EARTH_C = 2 * Math.PI * 6371008.8;   // MapLibre's earth circumference, m
  const mercX = (lng) => (180 + lng) / 360;
  const mercY = (lat) => (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;
  const mercPerMetre = (lat) => 1 / (EARTH_C * Math.cos((lat * Math.PI) / 180));

  const VERT = `
uniform mat4 u_matrix;     // local metres (x east, y south, z up) to clip space
uniform vec3 u_cam;        // the camera, in the same local metres
uniform float u_exag;      // the terrain's exaggeration now (the ride camera changes it without any event): ground heights are stored raw
uniform vec3 u_ink;        // pen pressure: the pack origin's place in the world (m, wrapped at 4096) and the metres-per-unit ratio, so it survives a rebuild
attribute vec4 a_pos;      // x, y, ground height, height above the ground
varying float v_ink;
// a random value 0..1 on a grid of ${PRESSURE_CELL} m, wrapping every 4096 m (so the world position can be small and exact in float32)
float cellHash(vec2 c) { return fract(sin(dot(mod(c, ${(4096 / PRESSURE_CELL).toFixed(1)}), vec2(12.9898, 78.233))) * 43758.5453); }
float pressure(vec3 q) {
  vec2 g = (u_ink.xy + q.xy * u_ink.z + q.z * vec2(0.7, 1.3)) / ${PRESSURE_CELL.toFixed(2)}, i = floor(g), f = fract(g);
  f = f * f * (3.0 - 2.0 * f);   // smooth between the grid points, so no steps along a line
  return mix(mix(cellHash(i), cellHash(i + vec2(1.0, 0.0)), f.x), mix(cellHash(i + vec2(0.0, 1.0)), cellHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  vec3 p = vec3(a_pos.xy, a_pos.z * u_exag + a_pos.w);
  v_ink = 1.0 - ${PRESSURE.toFixed(2)} * (1.0 - pressure(vec3(a_pos.xy, a_pos.w)));   // from the stored position, not the lifted one: terrain changes do not shimmer it
  // a fixed distance toward the camera (not a clip-space depth offset: that is worth metres far away and lets lines behind a wall show through)
  gl_Position = u_matrix * vec4(p + normalize(u_cam - p) * ${NUDGE.toFixed(2)}, 1.0);
}`;
  const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec4 u_edgecolor;  // premultiplied alpha
varying float v_ink;
void main() { gl_FragColor = u_edgecolor * v_ink; }`;

  // WebGL 2 has vertex arrays built in; WebGL 1 needs an extension (every iPhone and current browser has it)
  function vaoApi(gl) {
    if (typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext) {
      return { version: 2, create: () => gl.createVertexArray(), bind: (v) => gl.bindVertexArray(v), drop: (v) => gl.deleteVertexArray(v) };
    }
    const va = gl.getExtension("OES_vertex_array_object");
    if (!va) throw new Error("WebGL 1 without vertex arrays");
    return { version: 1, create: () => va.createVertexArrayOES(), bind: (v) => va.bindVertexArrayOES(v), drop: (v) => va.deleteVertexArrayOES(v) };
  }
  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("edge shader: " + (gl.getShaderInfoLog(s) || "did not compile"));
    return s;
  }
  function program(gl) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT)); gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.bindAttribLocation(p, 0, "a_pos");
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("edge shaders: " + (gl.getProgramInfoLog(p) || "did not link"));
    return { p, matrix: gl.getUniformLocation(p, "u_matrix"), color: gl.getUniformLocation(p, "u_edgecolor"), exag: gl.getUniformLocation(p, "u_exag"), cam: gl.getUniformLocation(p, "u_cam"), ink: gl.getUniformLocation(p, "u_ink") };
  }

  // The camera in the matrix's own space: the one point whose clip x, y and w are all 0 (three equations, Cramer's rule). Column-major matrix.
  function cameraAt(M, out) {
    const a = (r, c) => M[4 * c + r], rows = [0, 1, 3];
    const det = (m) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
    const A = rows.flatMap((r) => [a(r, 0), a(r, 1), a(r, 2)]), d = det(A);
    for (let c = 0; c < 3; c++) { const B = A.slice(); rows.forEach((r, i) => { B[3 * i + c] = -a(r, 3); }); out[c] = d ? det(B) / d : 0; }
    return out;
  }

  // Where the pack origin lies in the world, for the pen pressure's hash. Done in 64-bit here so the shader's 32-bit numbers stay small. A fixed
  // metres-per-unit (Montreal's) keeps the place the same from one rebuild to the next, whatever latitude the map centre is at.
  const INK_K = mercPerMetre(45.5);
  const inkOrigin = (ox, oy, k) => [(ox / INK_K) % 4096, (oy / INK_K) % 4096, k / INK_K];

  const polygons = (g) => (!g ? [] : g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []);
  // The tile's clipped geometry has straight cuts along the tile border (and its buffer): exactly vertical or horizontal in the tile, so
  // also in longitude / latitude. An edge like that near a tile border is a cut, not a wall.
  function cutter(z) {
    const near = (v) => { const f = (v * 2 ** z) % 1; return Math.min(f, 1 - f) < BUFFER; };
    return (ax, ay, bx, by) => (ax === bx && near(ax)) || (ay === by && near(ay));
  }
  // One vector tile's buildings -> records in mercator units: an edge record (roof and base lines) or a corner record (one vertical line),
  // each pointing at its building (height, and the ground height that terrain gives it)
  function readTile(key, feats) {
    let verts = 0, nb = 0;
    for (const f of feats) for (const poly of polygons(f.geometry)) { nb++; for (const ring of poly) verts += ring.length; }
    const [z, x, y] = key.split("/").map(Number), cut = cutter(z);
    const seg = new Float64Array(verts * 8), kind = new Uint8Array(verts * 2), bld = new Uint32Array(verts * 2);   // up to an edge and a corner per vertex
    const h = new Float32Array(nb), lng = new Float64Array(nb), lat = new Float64Array(nb);
    let n = 0, b = 0, lines = 0;
    for (const f of feats) {
      const height = +f.properties.h || 0;
      if (height < MIN_HEIGHT) continue;
      for (const poly of polygons(f.geometry)) {
        let sx = 0, sy = 0, sn = 0;const first = n;
        for (const ring of poly) {
          const m = ring.length - 1;   // the ring repeats its first point at the end
          if (m < 3) continue;
          const P = new Float64Array(m * 2);
          for (let i = 0; i < m; i++) { P[2 * i] = mercX(ring[i][0]); P[2 * i + 1] = mercY(ring[i][1]); sx += ring[i][0]; sy += ring[i][1]; sn++; }
          const isCut = new Uint8Array(m);
          for (let i = 0; i < m; i++) { const j = (i + 1) % m; isCut[i] = cut(P[2 * i], P[2 * i + 1], P[2 * j], P[2 * j + 1]) ? 1 : 0; }
          for (let i = 0; i < m; i++) {
            const p = (i + m - 1) % m, j = (i + 1) % m;
            if (isCut[i]) continue;
            seg.set([P[2 * i], P[2 * i + 1], P[2 * j], P[2 * j + 1]], n * 4); kind[n] = 0; bld[n++] = b; lines += 2;
            if (isCut[p]) continue;
            let d = Math.abs(Math.atan2(P[2 * j + 1] - P[2 * i + 1], P[2 * j] - P[2 * i]) - Math.atan2(P[2 * i + 1] - P[2 * p + 1], P[2 * i] - P[2 * p]));
            if (d > Math.PI) d = 2 * Math.PI - d;
            if (d > TURN) { seg.set([P[2 * i], P[2 * i + 1], 0, 0], n * 4); kind[n] = 1; bld[n++] = b; lines++; }
          }
        }
        if (n === first || !sn) continue;   // nothing of this polygon was kept
        h[b] = height; lng[b] = sx / sn; lat[b] = sy / sn; b++;
      }
    }
    return { key, z, x, y, raw: feats.length, n, nb: b, lines, seg: seg.slice(0, n * 4), kind: kind.slice(0, n), bld: bld.slice(0, n),
      h: h.slice(0, b), lng: lng.slice(0, b), lat: lat.slice(0, b), elev: new Float32Array(b), elevFor: null };
  }

  class EdgeLayer {
    // opts: id, layerId (the fill-extrusion layer whose buildings get lines), minzoom (drawn from), demZoom (the terrain tiles' max zoom),
    // overshoot, cornerUp (m: how far lines run past their ends, see OVERSHOOT and CORNER_UP; 0 = none),
    // color ([r, g, b, a]: 0-255 and 0-1), onFail(reason)
    constructor(map, opts) {
      this.id = opts.id; this.type = "custom"; this.renderingMode = "3d";
      this.map = map;
      this.opt = { layerId: "bld-3d", minzoom: 15, demZoom: 14, overshoot: OVERSHOOT, cornerUp: CORNER_UP, color: [30, 33, 96, 0.92], ...opts };
      this.color = new Float32Array(4); this.setColor(this.opt.color);
      this.tiles = new Map(); this.count = 0; this.pending = null; this.origin = [0, 0, 1]; this.ink = [0, 0, 1];
      this.error = null; this.gl = null; this.timer = 0; this.warned = false;
      this.stats = { drawn: 0, frames: 0, rebuilds: 0, rebuildMs: 0, capped: false, elevMin: 0, elevMax: 0, webgl: 0 };   // drawn: edges (lines) in the last frame
      this.matrix = new Float32Array(16); this.cam = new Float32Array(3);
      this.onData = (e) => {
        const L = map.getLayer(this.opt.layerId), terrain = map.getTerrain && map.getTerrain();
        if (L && e.sourceId === L.source && e.tile) this.schedule(150);
        if (terrain && e.sourceId === terrain.source && e.tile) { this.staleElevation(e.tile.tileID.canonical); this.schedule(150); }
      };
      this.onIdle = () => this.schedule(0);
      this.onTerrain = () => { for (const t of this.tiles.values()) t.elevFor = null; this.schedule(0); };
      this.onLost = () => this.fail("WebGL context lost");
    }
    // [r, g, b, a], r g b 0-255, a 0-1
    setColor(c) {
      const a = c[3];
      this.color.set([(c[0] / 255) * a, (c[1] / 255) * a, (c[2] / 255) * a, a]);
      this.map.triggerRepaint();
    }
    info() { return { error: this.error, lines: this.count, tiles: this.tiles.size, ...this.stats }; }

    onAdd(map) {
      map.on("sourcedata", this.onData); map.on("idle", this.onIdle); map.on("terrain", this.onTerrain); map.on("webglcontextlost", this.onLost);
      this.schedule(0);
    }
    onRemove(map, gl) {
      map.off("sourcedata", this.onData); map.off("idle", this.onIdle); map.off("terrain", this.onTerrain); map.off("webglcontextlost", this.onLost);
      clearTimeout(this.timer); this.timer = 0;
      if (this.gl && gl && !gl.isContextLost()) {
        const g = this.gl;
        gl.deleteProgram(g.prog.p); gl.deleteBuffer(g.buffer); g.api.drop(g.vao);
      }
      this.gl = null;
    }
    fail(reason) {
      if (this.error) return;
      this.error = reason; this.count = 0; this.pending = null; this.stats.drawn = 0;
      if (!this.warned) { this.warned = true; console.warn(`3D edges: WebGL drawing stopped (${reason})`); }
      setTimeout(() => this.opt.onFail && this.opt.onFail(reason), 0);   // not from inside the map's drawing
    }
    schedule(ms) {
      if (this.timer || this.error) return;
      this.timer = setTimeout(() => { this.timer = 0; try { this.rebuild(); } catch (e) { this.fail("edge data: " + e.message); } }, ms);
    }

    // ---- data: the source's loaded tiles -> one array of lines, measured from the map's centre
    rebuild() {
      const map = this.map, o = this.opt, L = map.getLayer(o.layerId), t0 = performance.now();
      if (!L || !map.getSource(L.source) || map.getLayoutProperty(this.id, "visibility") === "none" || map.getZoom() < o.minzoom) return;
      const groups = new Map();
      for (const f of map.querySourceFeatures(L.source, { sourceLayer: L.sourceLayer })) {
        if (!f.tile) continue;
        const k = `${f.tile.z}/${f.tile.x}/${f.tile.y}`;
        let g = groups.get(k); if (!g) groups.set(k, (g = [])); g.push(f);
      }
      let changed = false;
      for (const k of [...this.tiles.keys()]) if (!groups.has(k)) { this.tiles.delete(k); changed = true; }
      for (const [k, feats] of groups) {
        const t = this.tiles.get(k);
        if (!t || t.raw !== feats.length) { this.tiles.set(k, readTile(k, feats)); changed = true; }
      }
      if (this.sampleElevation()) changed = true;
      if (!changed) return;   // nothing new: leave the map idle (no redraw)
      this.pending = this.pack();
      this.stats.rebuilds++; this.stats.rebuildMs = +(performance.now() - t0).toFixed(1);
      map.triggerRepaint();
    }
    // the ground under each building (at its polygon's centroid, as MapLibre lifts it): the terrain's true height (the exaggeration is divided
    // out and applied again every frame, as in trees3d.js) when the terrain is on, else 0; true if any changed
    sampleElevation() {
      const map = this.map, on = !!(map.getTerrain && map.getTerrain()), T = map.terrain;
      const at = T && typeof T.getElevationForLngLatZoom === "function" ? (ll) => T.getElevationForLngLatZoom(ll, this.opt.demZoom)
        : (ll) => map.queryTerrainElevation(ll) || 0;
      const ll = new maplibregl.LngLat(0, 0), state = on ? "terrain" : "flat", ex = (T && T.exaggeration) || 1;
      let changed = false;
      for (const t of this.tiles.values()) {
        if (t.elevFor === state) continue;
        if (on) for (let i = 0; i < t.nb; i++) { ll.lng = t.lng[i]; ll.lat = t.lat[i]; t.elev[i] = at(ll) / ex; }
        else t.elev.fill(0);
        t.elevFor = state; changed = true;
      }
      if (changed) {
        let lo = Infinity, hi = -Infinity;
        for (const t of this.tiles.values()) for (let i = 0; i < t.nb; i++) { if (t.elev[i] < lo) lo = t.elev[i]; if (t.elev[i] > hi) hi = t.elev[i]; }
        this.stats.elevMin = isFinite(lo) ? +(lo * ex).toFixed(1) : 0; this.stats.elevMax = isFinite(hi) ? +(hi * ex).toFixed(1) : 0;
      }
      return changed;
    }
    // a terrain tile arrived: the buildings on it get their heights again
    staleElevation(c) {
      for (const t of this.tiles.values()) {
        const inside = t.z >= c.z ? (t.x >> (t.z - c.z)) === c.x && (t.y >> (t.z - c.z)) === c.y : (c.x >> (c.z - t.z)) === t.x && (c.y >> (c.z - t.z)) === t.y;
        if (inside) t.elevFor = null;
      }
    }
    // While finer tiles load, a tile and its children can both be on hand: a child's buildings win where it has loaded. The tiles nearest
    // the centre are taken first, up to MAX_LINES.
    pack() {
      const c = this.map.getCenter(), ox = mercX(c.lng), oy = mercY(c.lat), k = mercPerMetre(c.lat);
      const near = (t) => { const s = 2 ** t.z; return Math.hypot((t.x + 0.5) / s - ox, (t.y + 0.5) / s - oy); };
      const used = []; let lines = 0, capped = false;
      for (const t of [...this.tiles.values()].sort((a, b) => near(a) - near(b))) {
        if (lines + t.lines > MAX_LINES) { capped = true; continue; }
        used.push(t); lines += t.lines;
      }
      this.stats.capped = capped;
      const out = new Float32Array(lines * 2 * STRIDE), keys = new Set(used.map((t) => t.key));
      let j = 0;
      const put = (x, y, g, z) => { out[j++] = (x - ox) / k; out[j++] = (y - oy) / k; out[j++] = g; out[j++] = z; };
      // the end A of a line A-B pushed `overshoot` metres away from B, along the line (so it stays in its wall or roof plane)
      const o = this.opt, past = (ax, ay, bx, by) => {
        const len = Math.hypot(bx - ax, by - ay), e = len ? (o.overshoot * k) / len : 0;
        return [ax + (ax - bx) * e, ay + (ay - by) * e];
      };
      for (const t of used) {
        const zc = t.z + 1, child = (mx, my) => keys.has(`${zc}/${Math.floor(mx * 2 ** zc)}/${Math.floor(my * 2 ** zc)}`);
        const covered = [0, 1].some((dx) => [0, 1].some((dy) => keys.has(`${zc}/${2 * t.x + dx}/${2 * t.y + dy}`)));
        for (let i = 0; i < t.n; i++) {
          const b = t.bld[i], q = i * 4;
          if (covered && child(mercX(t.lng[b]), mercY(t.lat[b]))) continue;
          const g = t.elev[b], roof = t.h[b], base = BASE_LIFT;
          if (t.kind[i] === 0) {
            const [ax, ay] = past(t.seg[q], t.seg[q + 1], t.seg[q + 2], t.seg[q + 3]), [bx, by] = past(t.seg[q + 2], t.seg[q + 3], t.seg[q], t.seg[q + 1]);
            put(ax, ay, g, roof); put(bx, by, g, roof);
            put(ax, ay, g, base); put(bx, by, g, base);
          } else { put(t.seg[q], t.seg[q + 1], g, base); put(t.seg[q], t.seg[q + 1], g, roof + o.cornerUp); }
        }
      }
      return { data: out.subarray(0, j), count: j / (2 * STRIDE), origin: [ox, oy, k], ink: inkOrigin(ox, oy, k) };
    }

    // ---- drawing (inside MapLibre's frame, which resets its own GL state afterwards)
    init(gl) {
      const api = vaoApi(gl), prog = program(gl), vao = api.create(), buffer = gl.createBuffer();
      api.bind(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
      api.bind(null);
      this.gl = { api, prog, vao, buffer };
      this.stats.webgl = api.version;
    }
    render(gl, args) {
      if (this.error) return;
      try { this.draw(gl, args); } catch (e) { this.fail(e.message || String(e)); }
    }
    draw(gl, args) {
      if (gl.isContextLost()) { this.fail("WebGL context lost"); return; }
      if (!this.gl) this.init(gl);
      const g = this.gl, o = this.opt, map = this.map;
      if (this.pending) {
        gl.bindBuffer(gl.ARRAY_BUFFER, g.buffer); gl.bufferData(gl.ARRAY_BUFFER, this.pending.data, gl.DYNAMIC_DRAW);
        this.count = this.pending.count; this.origin = this.pending.origin; this.ink = this.pending.ink; this.pending = null;
      }
      this.stats.drawn = map.getZoom() < o.minzoom ? 0 : this.count;
      if (!this.stats.drawn) return;
      // MapLibre 5 gives custom layers a matrix from mercator units (x, y and z) to clip space; ours starts at the origin, in metres
      const A = args && args.defaultProjectionData ? args.defaultProjectionData.mainMatrix : args, M = this.matrix;
      const [ox, oy, k] = this.origin, kz = mercPerMetre(map.getCenter().lat);   // MapLibre scales heights at the map's centre
      for (let i = 0; i < 4; i++) { M[i] = A[i] * k; M[4 + i] = A[4 + i] * k; M[8 + i] = A[8 + i] * kz; M[12 + i] = A[i] * ox + A[4 + i] * oy + A[12 + i]; }
      gl.useProgram(g.prog.p);
      gl.uniform3fv(g.prog.cam, cameraAt(M, this.cam));
      gl.uniformMatrix4fv(g.prog.matrix, false, M);
      gl.uniform4fv(g.prog.color, this.color);
      gl.uniform3fv(g.prog.ink, this.ink);
      gl.uniform1f(g.prog.exag, map.terrain ? map.terrain.exaggeration : 1);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(false);
      g.api.bind(g.vao);
      gl.drawArrays(gl.LINES, 0, this.count * 2);
      g.api.bind(null);
      gl.depthMask(true);
      this.stats.frames++;
    }
  }

  window.BikeEdges3D = { create: (map, opts) => new EdgeLayer(map, opts), MAX_LINES };
})();
