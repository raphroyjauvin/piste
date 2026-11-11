/* 3D building edges drawn with WebGL (2026-11-07): a MapLibre custom layer that draws "clear-line" ink edges on the 3D buildings of a
   fill-extrusion layer, like a pen drawing: each building's roof outline and a vertical line at each corner where the outline turns by more
   than about 34 degrees. Depth-tested against the buildings and the terrain so a wall in front hides the lines behind it; each stroke end is
   nudged 0.3 m toward the camera (a fixed distance, not a depth bias) so the lines do not flicker against the wall they sit on.
   2026-11-10 inked strokes (replacing the one-device-pixel gl.LINES hairlines, which on a 3x phone were a third of a CSS pixel wide and the
   "+" marks of the 2026-11-09 overshoot at every corner):
   - Real strokes: one instance per stroke segment, a 4-vertex quad widened in screen space in the vertex shader, with a smooth (anti-aliased)
     edge in the fragment shader. Widths are in CSS pixels times the canvas's real pixel ratio, so a laptop and a 3x phone look the same.
     Solid ink; the pen pressure (a smooth hash of the position) varies the WIDTH by about 15 %, not the opacity.
   - Strokes, not segments: edges of a ring that turn by less than TURN make one stroke, joined without gaps (each joint end runs half a width
     on). A stroke's ends narrow over their last ~15 % (at most TAPER_PX): to a point at a free end (a pen lift: a corner line's foot), to
     about 60 % at a corner, where another stroke meets it and closes it. No overshoot, so no crosses at the corners.
   - Fewer lines: no base (ground) outline (option `base` brings it back as a lighter stroke); no lines on party walls (an edge shared by two
     buildings in a tile), except the roof step where one is more than STEP taller (drawn once, by the taller one, with its corner line
     from the lower roof up); no corner line where either wall is shorter than MIN_JOG (tiny jogs).
   - Calm far field: the stroke width eases from its near to its far value, then fades out, with the metres one CSS pixel covers at that point
     (MPP: a lens-independent "how small are the buildings here"), and with the distance beyond the point the camera looks at (FADE_M; the
     3D view's narrow lens puts the camera kilometres away, so the distance from the camera itself means little).
   - Near plane: on a low camera a segment can cross the near plane; its end behind the camera is moved along the segment to the plane in the
     vertex shader before the screen direction is taken.
   Building outlines: the map's own vector tiles of the layer's source (read with querySourceFeatures when a tile loads and when the map
   is idle). Edges cut by a tile border (they run exactly along a tile's edge) are left out, so only real walls are drawn.
   Terrain: MapLibre lifts every fill-extrusion by the terrain's height at its polygon's centroid (the mean of its vertices): roof at
   height + ground. Each building's lines are lifted the same way, by the same ground height, so they sit on the building on a hill. The
   ground is read like shared/trees3d.js does (the terrain's exaggerated height).
   At most MAX_LINES stroke segments are drawn; when more are loaded the tiles nearest the map's centre win (stats.capped says so).
   If anything fails while drawing (an old browser without instancing, a shader error, a context found lost) the layer draws nothing, warns
   once in the console and calls onFail(reason); it never throws into the map. A lost context also removes every custom layer from the map.
   Classic script: window.BikeEdges3D. */
(function () {
  "use strict";
  const MAX_LINES = 200000;      // stroke segments drawn at most: 32 bytes each, 6.4 MB, light for a phone's GPU
  const MIN_HEIGHT = 2;          // m: lower buildings (sheds, garages) get no lines
  const TURN = 0.6;              // rad (about 34 degrees): a corner where the outline turns by more than this; less is one stroke
  const STEP = 1.5;              // m: a party wall's roof step is drawn when one roof is more than this above the other
  const MIN_JOG = 1.5;           // m: no corner line where either wall is shorter than this
  const NUDGE = 0.3;             // m: every stroke end moves this far toward the camera, so a line is not hidden by the wall it lies on
  // stroke classes: [near width, far width] (CSS px), share of the ink's alpha
  const ROOF = [1.5, 0.9, 1], CORNER = [1.1, 0.7, 1], BASE = [0.9, 0.6, 0.45];
  // how the ink thins with scale: metres per CSS px at that point (MPP: the near width up to [0], the far width from [1], thinner still to
  // 60 % by [2], gone by [3]) and with distance (m beyond the point the camera looks at: thinning to 60 % and gone between FADE_M)
  const MPP = [0.15, 0.4, 0.9, 1.6];
  const FADE_M = [450, 850];
  const PRESSURE = 0.15;         // the pen pressure varies the width by this share either way
  const PRESSURE_CELL = 8;       // m: how far apart the pressure changes (must divide 4096 so the wrap is seamless)
  const TAPER = 0.15, TAPER_PX = 9;        // a tapered end narrows over this share of its segment, at most this many CSS px
  const TAPER_CORNER = 0.6;      // a corner end narrows to this share of its width (a free end to a point)
  const BASE_LIFT = 0.05;        // m: the base line (option) sits just above the ground it stands on
  const BUFFER = 0.1;            // an axis-aligned edge within this share of a tile from its border is a tile cut
  // stroke end kinds (per instance): a joint inside a stroke (no taper, runs half a width on), a corner (narrows to TAPER_CORNER), a free
  // end (narrows to a point), and "at the ground" (a corner line's foot: free without the base line, a corner with it; settled in pack())
  const JOINT = 0, CORNER_END = 1, FREE = 2, GROUND = 3;
  const FLOATS = 8;              // per instance: ax, ay, bx, by (m from the origin, east and south), ground (raw m), za, zb (m above it), 4 bytes
  const EARTH_C = 2 * Math.PI * 6371008.8;   // MapLibre's earth circumference, m
  const mercX = (lng) => (180 + lng) / 360;
  const mercY = (lat) => (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;
  const mercPerMetre = (lat) => 1 / (EARTH_C * Math.cos((lat * Math.PI) / 180));
  const f = (v) => v.toFixed(3);

  const VERT = `
uniform mat4 u_matrix;     // local metres (x east, y south, z up) to clip space
uniform vec3 u_cam;        // the camera, in the same local metres
uniform float u_exag;      // the terrain's exaggeration now (the ride camera changes it without any event): ground heights are stored raw
uniform vec3 u_ink;        // pen pressure: the pack origin's place in the world (m, wrapped at 4096) and the metres-per-unit ratio, so it survives a rebuild
uniform vec2 u_view;       // the drawing buffer, device px
uniform float u_pr;        // device px per CSS px
uniform float u_mpp;       // metres per CSS px at a point = its clip w times this
uniform vec2 u_depth;      // clip w at the map's centre, metres per unit of w (depth along the view)
uniform vec3 u_cls[3];     // per class: near width, far width (CSS px), share of the alpha
attribute vec2 a_quad;     // the quad's corner: which end (0 = a, 1 = b), which side (-1, 1)
attribute vec4 a_ab;       // the segment's ends: ax, ay, bx, by
attribute vec3 a_z;        // the ground's raw height, the heights of a and b above it
attribute vec4 a_f;        // class, end kind at a, end kind at b
varying vec3 v_q;          // along (px from a), across (px from the centre line), times w: interpolated straight on the screen
varying float v_w;
varying vec4 v_len;        // segment length (px), taper length at a and at b (px; 0 = none), unused
varying vec4 v_half;       // half width at a and at b (px), narrowest share at a and at b
varying vec2 v_alpha;      // alpha at a and at b
varying vec2 v_ext;        // how far the stroke runs on past a and past b (px)
float cellHash(vec2 c) { return fract(sin(dot(mod(c, ${(4096 / PRESSURE_CELL).toFixed(1)}), vec2(12.9898, 78.233))) * 43758.5453); }
float pressure(vec3 q) {   // smooth noise 0..1 on a grid of ${PRESSURE_CELL} m, from the stored position (terrain changes do not shimmer it)
  vec2 g = (u_ink.xy + q.xy * u_ink.z + q.z * vec2(0.7, 1.3)) / ${PRESSURE_CELL.toFixed(2)}, i = floor(g), f = fract(g);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(cellHash(i), cellHash(i + vec2(1.0, 0.0)), f.x), mix(cellHash(i + vec2(0.0, 1.0)), cellHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
// half width (device px) and alpha of a stroke end at clip w, for class c and stored position q
vec2 ink(vec3 c, float w, vec3 q) {
  float mpp = w * u_mpp, beyond = (w - u_depth.x) * u_depth.y;
  float thin = max(smoothstep(${f(MPP[1])}, ${f(MPP[2])}, mpp), smoothstep(${f(FADE_M[0])}, ${f(FADE_M[1])}, beyond));
  float fade = max(smoothstep(${f(MPP[2])}, ${f(MPP[3])}, mpp), smoothstep(${f(FADE_M[0])}, ${f(FADE_M[1])}, beyond));
  float width = mix(c.x, c.y, smoothstep(${f(MPP[0])}, ${f(MPP[1])}, mpp)) * mix(1.0, 0.6, thin) * (1.0 + ${f(PRESSURE)} * (2.0 * pressure(q) - 1.0));
  return vec2(0.5 * width * u_pr, c.z * (1.0 - fade));
}
float narrowest(float kind) { return kind < 0.5 ? 1.0 : kind < 1.5 ? ${f(TAPER_CORNER)} : 0.0; }
void main() {
  vec3 c = a_f.x < 0.5 ? u_cls[0] : a_f.x < 1.5 ? u_cls[1] : u_cls[2];
  vec3 pa = vec3(a_ab.xy, a_z.x * u_exag + a_z.y), pb = vec3(a_ab.zw, a_z.x * u_exag + a_z.z);
  // a fixed distance toward the camera (not a clip-space depth offset: that is worth metres far away and lets lines behind a wall show through)
  pa += normalize(u_cam - pa) * ${f(NUDGE)}; pb += normalize(u_cam - pb) * ${f(NUDGE)};
  vec4 ca = u_matrix * vec4(pa, 1.0), cb = u_matrix * vec4(pb, 1.0);
  // the near plane (z = -w): an end behind it moves along the segment onto it; a segment wholly behind it is dropped
  float da = ca.z + ca.w, db = cb.z + cb.w, eps = 1e-5 * max(abs(ca.w), abs(cb.w));
  if (da < eps && db < eps) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); return; }
  float ka = a_f.y, kb = a_f.z;
  if (da < eps) { ca = mix(ca, cb, (eps - da) / (db - da)); ka = 0.0; }
  if (db < eps) { cb = mix(cb, ca, (eps - db) / (da - db)); kb = 0.0; }
  vec2 sa = ca.xy / ca.w * 0.5 * u_view, sb = cb.xy / cb.w * 0.5 * u_view, d = sb - sa;
  float len = length(d);
  vec2 dir = len > 1e-3 ? d / len : vec2(1.0, 0.0), perp = vec2(-dir.y, dir.x);
  vec2 ia = ink(c, ca.w, vec3(a_ab.xy, a_z.y)), ib = ink(c, cb.w, vec3(a_ab.zw, a_z.z));
  if (ia.y <= 0.0 && ib.y <= 0.0) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); return; }   // faded out: no pixels to shade
  float hmax = max(ia.x, ib.x) + 1.0;   // + 1 px for the soft edge
  float ta = ka > 0.5 ? min(${f(TAPER)} * len, ${f(TAPER_PX)} * u_pr) : 0.0, tb = kb > 0.5 ? min(${f(TAPER)} * len, ${f(TAPER_PX)} * u_pr) : 0.0;
  // ends run on by their own half width there (a joint: the full half width, a corner: its narrowed one), so strokes meeting at an angle
  // close the corner; a free end stops at its point. Plus 1 px for the soft edge.
  float xa = ka < 0.5 ? ia.x : ka < 1.5 ? ${f(TAPER_CORNER)} * ia.x : 0.0, xb = kb < 0.5 ? ib.x : kb < 1.5 ? ${f(TAPER_CORNER)} * ib.x : 0.0;
  float ea = xa + 1.0, eb = xb + 1.0;
  bool atB = a_quad.x > 0.5;
  vec4 cp = atB ? cb : ca;
  float along = atB ? len + eb : -ea, across = a_quad.y * hmax;
  vec2 off = dir * (atB ? eb : -ea) + perp * across;
  gl_Position = vec4(cp.xy + off * 2.0 / u_view * cp.w, cp.z, cp.w);
  v_w = cp.w; v_q = vec3(along, across, 0.0) * cp.w;
  v_len = vec4(len, ta, tb, 0.0); v_half = vec4(ia.x, ib.x, narrowest(ka), narrowest(kb)); v_alpha = vec2(ia.y, ib.y); v_ext = vec2(xa, xb);
}`;
  const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec4 u_edgecolor;  // premultiplied alpha
varying vec3 v_q;
varying float v_w;
varying vec4 v_len;
varying vec4 v_half;
varying vec2 v_alpha;
varying vec2 v_ext;
void main() {
  float along = v_q.x / v_w, across = abs(v_q.y / v_w), s = clamp(along / max(v_len.x, 1e-3), 0.0, 1.0);
  float h = mix(v_half.x, v_half.y, s);
  if (v_len.y > 0.0) h *= mix(v_half.z, 1.0, smoothstep(0.0, 1.0, clamp(along / v_len.y, 0.0, 1.0)));
  if (v_len.z > 0.0) h *= mix(v_half.w, 1.0, smoothstep(0.0, 1.0, clamp((v_len.x - along) / v_len.z, 0.0, 1.0)));
  // the share of this pixel the stroke covers (box filter across it): smooth edges, and a thin tip stays faint instead of breaking up
  float cover = clamp(min(h, across + 0.5) - max(-h, across - 0.5), 0.0, 1.0);
  cover *= clamp(along + v_ext.x + 0.5, 0.0, 1.0) * clamp(v_len.x + v_ext.y - along + 0.5, 0.0, 1.0);   // soft square ends
  float a = cover * mix(v_alpha.x, v_alpha.y, s);
  if (a < 0.003) discard;
  gl_FragColor = u_edgecolor * a;
}`;

  // WebGL 2 has vertex arrays and instancing built in; WebGL 1 needs two extensions (every iPhone and current browser has them)
  function glApi(gl) {
    if (typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext) {
      return { version: 2, create: () => gl.createVertexArray(), bind: (v) => gl.bindVertexArray(v), drop: (v) => gl.deleteVertexArray(v),
        divisor: (i, d) => gl.vertexAttribDivisor(i, d), draw: (n, count) => gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, n, count) };
    }
    const va = gl.getExtension("OES_vertex_array_object"), inst = gl.getExtension("ANGLE_instanced_arrays");
    if (!va) throw new Error("WebGL 1 without vertex arrays");
    if (!inst) throw new Error("WebGL 1 without instancing");
    return { version: 1, create: () => va.createVertexArrayOES(), bind: (v) => va.bindVertexArrayOES(v), drop: (v) => va.deleteVertexArrayOES(v),
      divisor: (i, d) => inst.vertexAttribDivisorANGLE(i, d), draw: (n, count) => inst.drawArraysInstancedANGLE(gl.TRIANGLE_STRIP, 0, n, count) };
  }
  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("edge shader: " + (gl.getShaderInfoLog(s) || "did not compile"));
    return s;
  }
  const ATTRS = ["a_quad", "a_ab", "a_z", "a_f"];
  function program(gl) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT)); gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    ATTRS.forEach((a, i) => gl.bindAttribLocation(p, i, a));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("edge shaders: " + (gl.getProgramInfoLog(p) || "did not link"));
    const u = (n) => gl.getUniformLocation(p, n);
    return { p, matrix: u("u_matrix"), color: u("u_edgecolor"), exag: u("u_exag"), cam: u("u_cam"), ink: u("u_ink"), view: u("u_view"), pr: u("u_pr"),
      mpp: u("u_mpp"), depth: u("u_depth"), cls: u("u_cls") };
  }

  // The camera in the matrix's own space: the one point whose clip x, y and w are all 0 (three equations, Cramer's rule). Column-major
  // matrix; no allocation (it runs every frame).
  const det3 = (a, b, c, d, e, f, g, h, i) => a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  function cameraAt(M, out) {
    // rows x, y, w of the matrix: [M[r], M[4 + r], M[8 + r]] . p = -M[12 + r]
    const d = det3(M[0], M[4], M[8], M[1], M[5], M[9], M[3], M[7], M[11]);
    if (!d) { out[0] = out[1] = out[2] = 0; return out; }
    out[0] = det3(-M[12], M[4], M[8], -M[13], M[5], M[9], -M[15], M[7], M[11]) / d;
    out[1] = det3(M[0], -M[12], M[8], M[1], -M[13], M[9], M[3], -M[15], M[11]) / d;
    out[2] = det3(M[0], M[4], -M[12], M[1], M[5], -M[13], M[3], M[7], -M[15]) / d;
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
  const turnAt = (P, p, i, j) => {   // how much the outline turns at vertex i (from p to j), rad
    let d = Math.abs(Math.atan2(P[2 * j + 1] - P[2 * i + 1], P[2 * j] - P[2 * i]) - Math.atan2(P[2 * i + 1] - P[2 * p + 1], P[2 * i] - P[2 * p]));
    return d > Math.PI ? 2 * Math.PI - d : d;
  };
  // per-ring working arrays, reused from ring to ring (a tile has tens of thousands of rings)
  class Scratch {
    constructor(size) {
      this.size = size; this.len = new Float64Array(size); this.turn = new Float64Array(size); this.hn = new Float32Array(size); this.corner = new Float32Array(size);
      this.isCut = new Uint8Array(size); this.roof = new Uint8Array(size); this.base = new Uint8Array(size);
    }
  }
  let scratch = new Scratch(256);
  // One vector tile's buildings -> stroke segments in mercator units, each pointing at its building (the ground height that terrain gives it)
  function readTile(key, feats) {
    const [z, x, y] = key.split("/").map(Number), cut = cutter(z), s = 2 ** z;
    const metre = 1 / mercPerMetre(Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / s))) * (180 / Math.PI)) ;   // metres per mercator unit here
    // every ring of every polygon (any height: a low neighbour still shares a wall), its vertices in mercator units
    const polys = [];
    let verts = 0;
    for (const ft of feats) {
      const h = +ft.properties.h || 0;
      for (const poly of polygons(ft.geometry)) {
        const rings = [];
        for (const ring of poly) {
          const m = ring.length - 1;   // the ring repeats its first point at the end
          if (m < 3) continue;
          const P = new Float64Array(m * 2);
          for (let i = 0; i < m; i++) { P[2 * i] = mercX(ring[i][0]); P[2 * i + 1] = mercY(ring[i][1]); }
          rings.push({ P, m, ll: ring }); verts += m;
        }
        if (rings.length) polys.push({ h, rings });
      }
    }
    // party walls: the same edge (same two points, either way) in two polygons. Points are matched on a grid 8x finer than the tile's own.
    const ids = new Map(), owner = new Map(), shared = new Map();
    const pid = (P, i) => { const k = Math.round((P[2 * i] * s - x) * 32768 + 65536) * 262144 + Math.round((P[2 * i + 1] * s - y) * 32768 + 65536);
      let v = ids.get(k); if (v === undefined) ids.set(k, (v = ids.size)); return v; };
    const edgeKeys = polys.map((pl) => pl.rings.map(({ P, m }) => {
      const K = new Float64Array(m), first = pid(P, 0);
      for (let i = 0, a = first; i < m; i++) { const b = i + 1 < m ? pid(P, i + 1) : first; K[i] = a < b ? a * 67108864 + b : b * 67108864 + a; a = b; }
      return K;
    }));
    polys.forEach((pl, n) => edgeKeys[n].forEach((K) => K.forEach((k) => {
      const o = owner.get(k);
      if (o === undefined) owner.set(k, n);
      else if (o !== n) { let l = shared.get(k); if (!l) shared.set(k, (l = [o])); if (!l.includes(n)) l.push(n); }
    })));
    const neighbour = (k, n) => { const l = shared.get(k); if (!l) return -1; let hn = -1; for (const o of l) if (o !== n && polys[o].h > hn) hn = polys[o].h; return hn; };

    const cap = verts * 3;   // at most a roof segment, a base segment and a corner line per vertex
    const seg = new Float64Array(cap * 4), zz = new Float32Array(cap * 2), fl = new Uint8Array(cap * 4), bld = new Uint32Array(cap);
    const nbAll = polys.length, lng = new Float64Array(nbAll), lat = new Float64Array(nbAll);
    let n = 0, b = 0, roofs = 0, corners = 0, bases = 0;
    const st = { seamEdges: 0, stepEdges: 0, seamCorners: 0, jogCorners: 0 };
    const put = (ax, ay, bx, by, za, zb, cls, ka, kb) => {
      seg[4 * n] = ax; seg[4 * n + 1] = ay; seg[4 * n + 2] = bx; seg[4 * n + 3] = by; zz[2 * n] = za; zz[2 * n + 1] = zb;
      fl[4 * n] = cls; fl[4 * n + 1] = ka; fl[4 * n + 2] = kb; bld[n++] = b;
    };
    polys.forEach((pl, pn) => {
      const h = pl.h;
      if (h < MIN_HEIGHT) return;
      const first = n;
      let sx = 0, sy = 0, sn = 0;
      pl.rings.forEach(({ P, m, ll }, rn) => {
        if (m > scratch.size) scratch = new Scratch(2 * m);
        const K = edgeKeys[pn][rn], { len, isCut, hn, roof, turn, corner, base } = scratch;   // per edge / vertex; corner: the height a corner line starts from (-1 = none)
        for (let i = 0; i < m; i++) {
          const j = (i + 1) % m;
          sx += ll[i][0]; sy += ll[i][1]; sn++;
          len[i] = Math.hypot(P[2 * j] - P[2 * i], P[2 * j + 1] - P[2 * i + 1]) * metre;
          isCut[i] = cut(P[2 * i], P[2 * i + 1], P[2 * j], P[2 * j + 1]) ? 1 : 0;
          hn[i] = isCut[i] ? -1 : neighbour(K[i], pn);
          roof[i] = !isCut[i] && (hn[i] < 0 || h - hn[i] > STEP) ? 1 : 0;
          if (!isCut[i] && hn[i] >= 0) { if (roof[i]) st.stepEdges++; else st.seamEdges++; }
          turn[i] = turnAt(P, (i + m - 1) % m, i, j);
          corner[i] = -1; base[i] = !isCut[i] && hn[i] < 0 ? 1 : 0;
        }
        for (let i = 0; i < m; i++) {
          const p = (i + m - 1) % m;
          if (isCut[i] || isCut[p] || turn[i] <= TURN) continue;
          const low = Math.max(hn[p], hn[i]);   // a party wall on either side: the line runs only from the lower roof up, if it shows
          if (low >= 0 && h - low <= STEP) { st.seamCorners++; continue; }
          if (len[p] < MIN_JOG || len[i] < MIN_JOG) { st.jogCorners++; continue; }
          corner[i] = Math.max(low, 0);
        }
        // how a roof (or base) stroke ends at vertex v, coming from edge e and going on along edge o (the other edge at v)
        const endKind = (v, o, drawn) => {
          if (isCut[o]) return JOINT;                                        // it goes on in the next tile
          if (drawn[o] && turn[v] <= TURN) return JOINT;                     // the same stroke goes on
          if (hn[o] >= 0 && !drawn[o]) return JOINT;                         // a party wall: it goes on along the neighbour's roof
          return drawn[o] || corner[v] >= 0 ? CORNER_END : FREE;
        };
        for (let i = 0; i < m; i++) {
          const j = (i + 1) % m, p = (i + m - 1) % m, ax = P[2 * i], ay = P[2 * i + 1], bx = P[2 * j], by = P[2 * j + 1];
          if (roof[i]) { put(ax, ay, bx, by, h, h, 0, endKind(i, p, roof), endKind(j, j, roof)); roofs++; }
          if (base[i]) { put(ax, ay, bx, by, BASE_LIFT, BASE_LIFT, 2, endKind(i, p, base), endKind(j, j, base)); bases++; }
          if (corner[i] >= 0) { put(P[2 * i], P[2 * i + 1], P[2 * i], P[2 * i + 1], corner[i] > 0 ? corner[i] : BASE_LIFT, h, 1, corner[i] > 0 ? CORNER_END : GROUND, CORNER_END); corners++; }
        }
      });
      if (n === first || !sn) return;   // nothing of this polygon was kept
      lng[b] = sx / sn; lat[b] = sy / sn; b++;
    });
    return { key, z, x, y, raw: feats.length, n, nb: b, lines: roofs + corners, bases, roofs, corners, ...st,
      seg: seg.slice(0, n * 4), zz: zz.slice(0, n * 2), fl: fl.slice(0, n * 4), bld: bld.slice(0, n),
      lng: lng.slice(0, b), lat: lat.slice(0, b), elev: new Float32Array(b), elevFor: null };
  }

  class EdgeLayer {
    // opts: id, layerId (the fill-extrusion layer whose buildings get lines), minzoom (drawn from), demZoom (the terrain tiles' max zoom),
    // base (true: also the ground outline, as a lighter stroke), color ([r, g, b, a]: 0-255 and 0-1), onFail(reason)
    constructor(map, opts) {
      this.id = opts.id; this.type = "custom"; this.renderingMode = "3d";
      this.map = map;
      this.opt = { layerId: "bld-3d", minzoom: 15, demZoom: 14, base: false, color: [30, 33, 96, 0.92], ...opts };
      this.color = new Float32Array(4); this.setColor(this.opt.color);
      this.cls = Float32Array.from([...ROOF, ...CORNER, ...BASE]);
      this.tiles = new Map(); this.count = 0; this.pending = null; this.origin = [0, 0, 1]; this.ink = [0, 0, 1];
      this.error = null; this.gl = null; this.timer = 0; this.warned = false;
      // drawn: stroke segments in the last frame; bytes: the GPU buffer
      this.stats = { drawn: 0, frames: 0, rebuilds: 0, rebuildMs: 0, capped: false, elevMin: 0, elevMax: 0, webgl: 0, bytes: 0, seamEdges: 0, stepEdges: 0, seamCorners: 0, jogCorners: 0 };
      this.matrix = new Float32Array(16); this.cam = new Float32Array(3); this.view = new Float32Array(2);
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
        gl.deleteProgram(g.prog.p); gl.deleteBuffer(g.buffer); gl.deleteBuffer(g.quad); g.api.drop(g.vao);
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

    // ---- data: the source's loaded tiles -> one array of stroke segments, measured from the map's centre
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
      const c = this.map.getCenter(), ox = mercX(c.lng), oy = mercY(c.lat), k = mercPerMetre(c.lat), base = !!this.opt.base;
      const near = (t) => { const s = 2 ** t.z; return Math.hypot((t.x + 0.5) / s - ox, (t.y + 0.5) / s - oy); };
      const used = []; let lines = 0, capped = false;
      const sum = { seamEdges: 0, stepEdges: 0, seamCorners: 0, jogCorners: 0 };
      for (const t of [...this.tiles.values()].sort((a, b) => near(a) - near(b))) {
        const tl = t.lines + (base ? t.bases : 0);
        if (lines + tl > MAX_LINES) { capped = true; continue; }
        used.push(t); lines += tl;
        for (const key in sum) sum[key] += t[key];
      }
      Object.assign(this.stats, sum, { capped });
      const buf = new ArrayBuffer(lines * FLOATS * 4), out = new Float32Array(buf), bytes = new Uint8Array(buf), keys = new Set(used.map((t) => t.key));
      let j = 0;
      for (const t of used) {
        const zc = t.z + 1, child = (mx, my) => keys.has(`${zc}/${Math.floor(mx * 2 ** zc)}/${Math.floor(my * 2 ** zc)}`);
        const covered = [0, 1].some((dx) => [0, 1].some((dy) => keys.has(`${zc}/${2 * t.x + dx}/${2 * t.y + dy}`)));
        for (let i = 0; i < t.n; i++) {
          const b = t.bld[i], q = i * 4, cls = t.fl[q];
          if (cls === 2 && !base) continue;
          if (covered && child(mercX(t.lng[b]), mercY(t.lat[b]))) continue;
          const o = j * FLOATS;
          out[o] = (t.seg[q] - ox) / k; out[o + 1] = (t.seg[q + 1] - oy) / k; out[o + 2] = (t.seg[q + 2] - ox) / k; out[o + 3] = (t.seg[q + 3] - oy) / k;
          out[o + 4] = t.elev[b]; out[o + 5] = t.zz[2 * i]; out[o + 6] = t.zz[2 * i + 1];
          const ka = t.fl[q + 1];
          bytes[4 * o + 28] = cls; bytes[4 * o + 29] = ka === GROUND ? (base ? CORNER_END : FREE) : ka; bytes[4 * o + 30] = t.fl[q + 2];
          j++;
        }
      }
      return { data: new Uint8Array(buf, 0, j * FLOATS * 4), count: j, origin: [ox, oy, k], ink: inkOrigin(ox, oy, k) };
    }

    // ---- drawing (inside MapLibre's frame, which resets its own GL state afterwards)
    init(gl) {
      const api = glApi(gl), prog = program(gl), vao = api.create(), buffer = gl.createBuffer(), quad = gl.createBuffer();
      api.bind(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.bufferData(gl.ARRAY_BUFFER, Float32Array.from([0, -1, 0, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0); api.divisor(0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      const S = FLOATS * 4;
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, S, 0); api.divisor(1, 1);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, S, 16); api.divisor(2, 1);
      gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, false, S, 28); api.divisor(3, 1);
      api.bind(null);
      this.gl = { api, prog, vao, buffer, quad };
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
        this.count = this.pending.count; this.origin = this.pending.origin; this.ink = this.pending.ink; this.stats.bytes = this.pending.data.byteLength; this.pending = null;
      }
      this.stats.drawn = map.getZoom() < o.minzoom ? 0 : this.count;
      if (!this.stats.drawn) return;
      // MapLibre 5 gives custom layers a matrix from mercator units (x, y and z) to clip space; ours starts at the origin, in metres
      const A = args && args.defaultProjectionData ? args.defaultProjectionData.mainMatrix : args, M = this.matrix;
      const ctr = map.transform && map.transform.center ? map.transform.center : map.getCenter();   // (the transform's own: no allocation)
      const ox = this.origin[0], oy = this.origin[1], k = this.origin[2], kz = mercPerMetre(ctr.lat);   // MapLibre scales heights at the map's centre
      for (let i = 0; i < 4; i++) { M[i] = A[i] * k; M[4 + i] = A[4 + i] * k; M[8 + i] = A[8 + i] * kz; M[12 + i] = A[i] * ox + A[4 + i] * oy + A[12 + i]; }
      // the drawing buffer and its real pixel ratio; metres per CSS px at clip w: 2 w pr / (|clip y per metre| * height)
      const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight, css = map.getCanvas().clientWidth, pr = css > 0 ? W / css : 1;
      const yPerMetre = Math.hypot(M[1], M[5], M[9]), wPerMetre = Math.hypot(M[3], M[7], M[11]);
      const cx = (mercX(ctr.lng) - ox) / k, cy = (mercY(ctr.lat) - oy) / k;   // the map's centre, in our metres (on the flat ground)
      this.view[0] = W; this.view[1] = H;
      gl.useProgram(g.prog.p);
      gl.uniform3fv(g.prog.cam, cameraAt(M, this.cam));
      gl.uniformMatrix4fv(g.prog.matrix, false, M);
      gl.uniform4fv(g.prog.color, this.color);
      gl.uniform3fv(g.prog.ink, this.ink);
      gl.uniform1f(g.prog.exag, map.terrain ? map.terrain.exaggeration : 1);
      gl.uniform2fv(g.prog.view, this.view);
      gl.uniform1f(g.prog.pr, pr);
      gl.uniform1f(g.prog.mpp, yPerMetre > 0 ? (2 * pr) / (yPerMetre * H) : 0);
      gl.uniform2f(g.prog.depth, M[3] * cx + M[7] * cy + M[15], wPerMetre > 0 ? 1 / wPerMetre : 0);
      gl.uniform3fv(g.prog.cls, this.cls);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(false);
      gl.disable(gl.CULL_FACE);
      g.api.bind(g.vao);
      g.api.draw(4, this.count);
      g.api.bind(null);
      gl.depthMask(true);
      this.stats.frames++;
    }
  }

  window.BikeEdges3D = { create: (map, opts) => new EdgeLayer(map, opts), MAX_LINES, readTile };   // readTile: for the tests
})();
