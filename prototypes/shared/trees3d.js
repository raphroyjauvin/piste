/* 3D trees drawn with WebGL (2026-11-03): a MapLibre custom layer that stands each LiDAR tree of trees.pmtiles (h = height in m,
   s = seed) upright on the ground as the app's flat illustrated picture, turned to face the camera around the vertical axis only and
   sized in metres, with perspective. Unlike a symbol layer it is depth-tested against the 3D buildings and the terrain, so a tree
   behind a building or a hill is hidden by it. Dense texels are drawn first and hide what is behind them (an alpha test, so the
   trees need no sorting); the soft edges are blended after them without hiding anything. Everything is drawn at 0.85 opacity.
   Tree points: the map's own vector tiles of the source (read with querySourceFeatures when a tile loads and when the map is idle),
   standing at the terrain's height when the terrain is on. WebGL 2, or WebGL 1 with the instancing and vertex-array extensions.
   If anything fails while drawing (an old browser, a shader error, a context found lost) onFail(reason) is called and the layer draws
   nothing, so the app can show its flat tree pictures instead. A lost context also removes every custom layer from the map, so the app
   listens for that itself. Classic script: window.BikeTrees3D. */
(function () {
  "use strict";
  // Texture atlas: one 144 x 192 picture (the 72 x 96 picture at 2x) per cell, one column per picture, a day row and a night row.
  // The spare room around each picture keeps neighbours from bleeding into each other in the smaller mipmap levels.
  const ATLAS = { w: 2048, h: 512, cellW: 224, cellH: 256, picW: 144, picH: 192 };
  const WIDTH = 0.75;            // the picture's width over its height (72 / 96): its bottom edge stands on the ground
  const CORE = 0.6;              // texels at least this opaque are drawn first and hide what is behind them
  const EDGE = 0.02;             // fainter texels are not drawn at all
  const STRIDE = 5;              // per tree: x, y (m from the origin, east and south), ground height (m), size (m), seed
  const EARTH_C = 2 * Math.PI * 6371008.8;   // MapLibre's earth circumference, m
  const mercX = (lng) => (180 + lng) / 360;
  const mercY = (lat) => (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;
  const mercPerMetre = (lat) => 1 / (EARTH_C * Math.cos((lat * Math.PI) / 180));

  const VERT = `
uniform mat4 u_matrix;     // local metres (x east, y south, z up) to clip space
uniform vec2 u_right;      // the screen's right, on the ground
uniform vec3 u_pic;        // first column, number of columns, row (0 day, 1 night)
uniform vec4 u_cell;       // atlas cell size and picture offset, as fractions of the texture
uniform vec2 u_picsize;    // picture size, as fractions of the texture
attribute vec2 a_corner;   // x: -0.5 left, 0.5 right; y: 0 bottom, 1 top
attribute vec4 a_tree;     // x, y, ground height, size
attribute float a_seed;
varying vec2 v_uv;
void main() {
  float col = u_pic.x + floor(mod(a_seed + 0.5, u_pic.y));
  vec2 xy = a_tree.xy + u_right * (a_corner.x * ${WIDTH.toFixed(2)} * a_tree.w);
  gl_Position = u_matrix * vec4(xy, a_tree.z + a_corner.y * a_tree.w, 1.0);
  v_uv = vec2(col, u_pic.z) * u_cell.xy + u_cell.zw + vec2(a_corner.x + 0.5, 1.0 - a_corner.y) * u_picsize;
}`;
  const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D u_atlas;  // premultiplied alpha
uniform float u_opacity;
uniform vec2 u_keep;        // this pass draws the texels with u_keep.x <= alpha < u_keep.y
varying vec2 v_uv;
void main() {
  vec4 c = texture2D(u_atlas, v_uv, -1.0);   // one mipmap level sharper: keeps the thin trunks and branches of small, far trees
  if (c.a < u_keep.x || c.a >= u_keep.y) discard;
  gl_FragColor = c * u_opacity;
}`;

  // WebGL 2 has instancing and vertex arrays built in; WebGL 1 needs two extensions (every iPhone and current browser has them)
  function glApi(gl) {
    if (typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext) {
      return { version: 2, vao: () => gl.createVertexArray(), bind: (v) => gl.bindVertexArray(v), drop: (v) => gl.deleteVertexArray(v),
        divisor: (i, d) => gl.vertexAttribDivisor(i, d), draw: (n) => gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n) };
    }
    const inst = gl.getExtension("ANGLE_instanced_arrays"), va = gl.getExtension("OES_vertex_array_object");
    if (!inst || !va) throw new Error("WebGL 1 without instancing or vertex arrays");
    return { version: 1, vao: () => va.createVertexArrayOES(), bind: (v) => va.bindVertexArrayOES(v), drop: (v) => va.deleteVertexArrayOES(v),
      divisor: (i, d) => inst.vertexAttribDivisorANGLE(i, d), draw: (n) => inst.drawArraysInstancedANGLE(gl.TRIANGLE_STRIP, 0, 4, n) };
  }
  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("tree shader: " + (gl.getShaderInfoLog(s) || "did not compile"));
    return s;
  }
  function program(gl) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT)); gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.bindAttribLocation(p, 0, "a_corner");   // attribute 0 not instanced: some WebGL 1 drivers need that
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("tree shaders: " + (gl.getProgramInfoLog(p) || "did not link"));
    const loc = {};
    for (const n of ["u_matrix", "u_right", "u_pic", "u_cell", "u_picsize", "u_atlas", "u_opacity", "u_keep"]) loc[n] = gl.getUniformLocation(p, n);
    for (const n of ["a_corner", "a_tree", "a_seed"]) loc[n] = gl.getAttribLocation(p, n);
    return { p, loc };
  }
  // images: [day row, night row], each an array of loaded pictures, one per column
  function atlasCanvas(images) {
    const c = document.createElement("canvas");
    c.width = ATLAS.w; c.height = ATLAS.h;
    const ctx = c.getContext("2d");
    images.forEach((row, r) => row.forEach((img, col) => ctx.drawImage(img, col * ATLAS.cellW + (ATLAS.cellW - ATLAS.picW) / 2,
      r * ATLAS.cellH + (ATLAS.cellH - ATLAS.picH) / 2, ATLAS.picW, ATLAS.picH)));
    return c;
  }
  // one vector tile's trees: positions, sizes (the picture's height: the tree's height, at most 30 m, the seed adds up to 8% either way)
  function readTile(key, feats) {
    const n = feats.length, lng = new Float64Array(n), lat = new Float64Array(n), size = new Float32Array(n), seed = new Float32Array(n);
    let j = 0;
    for (const f of feats) {
      const g = f.geometry, h = +f.properties.h, s = (f.properties.s | 0) & 255;
      if (!g || g.type !== "Point" || !(h > 0)) continue;
      lng[j] = g.coordinates[0]; lat[j] = g.coordinates[1];
      size[j] = Math.min(30, h) * (0.92 + 0.04 * (s % 5)); seed[j] = s; j++;
    }
    const [z, x, y] = key.split("/").map(Number);
    return { key, z, x, y, n: j, raw: n, lng, lat, size, seed, elev: new Float32Array(j), elevFor: null };
  }

  class TreeLayer {
    // opts: id, source, sourceLayer, images ([day, night] rows of pictures), demZoom (the terrain tiles' max zoom),
    // minzoom (drawn from), fullAt (fully faded in at), opacity, onFail(reason)
    constructor(map, opts) {
      this.id = opts.id; this.type = "custom"; this.renderingMode = "3d";
      this.map = map;
      this.opt = { demZoom: 14, minzoom: 15.5, fullAt: 16.3, opacity: 0.85, ...opts };
      this.atlas = atlasCanvas(opts.images);
      this.tiles = new Map(); this.count = 0; this.pending = null; this.origin = [0, 0, 1];
      this.pic = [0, 1, 0]; this.error = null; this.gl = null; this.timer = 0;
      this.stats = { drawn: 0, frames: 0, rebuilds: 0, rebuildMs: 0, elevMs: 0, webgl: 0 };   // drawn: trees in the last frame
      this.matrix = new Float32Array(16);
      this.onData = (e) => {
        if (e.sourceId === this.opt.source && e.tile) this.schedule(150);
        const terrain = map.getTerrain && map.getTerrain();
        if (terrain && e.sourceId === terrain.source && e.tile) { this.staleElevation(e.tile.tileID.canonical); this.schedule(150); }
      };
      this.onIdle = () => this.schedule(0);
      this.onTerrain = () => { for (const t of this.tiles.values()) t.elevFor = null; this.schedule(0); };
    }
    // the picture set: [first column, number of columns], and day or night
    setPictures(cols, night) { this.pic = [cols[0], cols[1], night ? 1 : 0]; this.map.triggerRepaint(); }
    info() { return { error: this.error, trees: this.count, tiles: this.tiles.size, pictures: this.pic.slice(), ...this.stats }; }

    onAdd(map) {
      map.on("sourcedata", this.onData); map.on("idle", this.onIdle); map.on("terrain", this.onTerrain);
      this.schedule(0);
    }
    onRemove(map, gl) {
      map.off("sourcedata", this.onData); map.off("idle", this.onIdle); map.off("terrain", this.onTerrain);
      clearTimeout(this.timer);
      if (this.gl && gl && !gl.isContextLost()) {
        const g = this.gl;
        gl.deleteProgram(g.prog.p); gl.deleteBuffer(g.corners); gl.deleteBuffer(g.trees); gl.deleteTexture(g.tex); g.api.drop(g.vao);
      }
      this.gl = null;
    }
    fail(reason) {
      if (this.error) return;
      this.error = reason; this.count = 0;
      setTimeout(() => this.opt.onFail && this.opt.onFail(reason), 0);   // not from inside the map's drawing
    }
    schedule(ms) {
      if (this.timer || this.error) return;
      this.timer = setTimeout(() => { this.timer = 0; try { this.rebuild(); } catch (e) { this.fail("tree data: " + e.message); } }, ms);
    }

    // ---- data: the source's loaded tiles -> one array of trees, measured from the map's centre
    rebuild() {
      const map = this.map, o = this.opt, t0 = performance.now();
      if (!map.getSource(o.source) || map.getLayoutProperty(this.id, "visibility") === "none") return;
      const groups = new Map();
      for (const f of map.querySourceFeatures(o.source, { sourceLayer: o.sourceLayer })) {
        const k = f.tile ? `${f.tile.z}/${f.tile.x}/${f.tile.y}` : "all";
        let g = groups.get(k); if (!g) groups.set(k, (g = [])); g.push(f);
      }
      let changed = false;
      for (const k of [...this.tiles.keys()]) if (!groups.has(k)) { this.tiles.delete(k); changed = true; }
      for (const [k, feats] of groups) {
        const t = this.tiles.get(k);
        if (!t || (k === "all" && t.raw !== feats.length)) { this.tiles.set(k, readTile(k, feats)); changed = true; }
      }
      const t1 = performance.now();
      if (this.sampleElevation()) changed = true;
      if (!changed) return;   // nothing new: leave the map idle (no redraw)
      this.pending = this.pack();
      this.stats.rebuilds++; this.stats.rebuildMs = +(performance.now() - t0).toFixed(1); this.stats.elevMs = +(performance.now() - t1).toFixed(1);
      map.triggerRepaint();
    }
    // the ground under each tree: the terrain's height (exaggerated, as drawn) when the terrain is on, else 0; true if any changed
    sampleElevation() {
      const map = this.map, on = !!(map.getTerrain && map.getTerrain()), T = map.terrain;
      const at = T && typeof T.getElevationForLngLatZoom === "function" ? (ll) => T.getElevationForLngLatZoom(ll, this.opt.demZoom)
        : (ll) => map.queryTerrainElevation(ll) || 0;
      const ll = new maplibregl.LngLat(0, 0), state = on ? "terrain" : "flat";
      let changed = false;
      for (const t of this.tiles.values()) {
        if (t.elevFor === state) continue;
        if (on) for (let i = 0; i < t.n; i++) { ll.lng = t.lng[i]; ll.lat = t.lat[i]; t.elev[i] = at(ll); }
        else t.elev.fill(0);
        t.elevFor = state; changed = true;
      }
      return changed;
    }
    // a terrain tile arrived: the trees on it get their heights again
    staleElevation(c) {
      for (const t of this.tiles.values()) {
        const inside = t.z >= c.z ? (t.x >> (t.z - c.z)) === c.x && (t.y >> (t.z - c.z)) === c.y : (c.x >> (c.z - t.z)) === t.x && (c.y >> (c.z - t.z)) === t.y;
        if (inside) t.elevFor = null;
      }
    }
    // While finer tiles load, a tile and its children can both be on hand: a child's trees win where it has loaded.
    pack() {
      const c = this.map.getCenter(), ox = mercX(c.lng), oy = mercY(c.lat), k = mercPerMetre(c.lat);
      let n = 0;
      for (const t of this.tiles.values()) n += t.n;
      const out = new Float32Array(n * STRIDE);
      let j = 0;
      for (const t of this.tiles.values()) {
        const zc = t.z + 1, child = (x, y) => this.tiles.has(`${zc}/${x}/${y}`);
        const covered = t.key !== "all" && [0, 1].some((dx) => [0, 1].some((dy) => child(2 * t.x + dx, 2 * t.y + dy)));
        for (let i = 0; i < t.n; i++) {
          const mx = mercX(t.lng[i]), my = mercY(t.lat[i]);
          if (covered && child(Math.floor(mx * 2 ** zc), Math.floor(my * 2 ** zc))) continue;
          const q = j++ * STRIDE;
          out[q] = (mx - ox) / k; out[q + 1] = (my - oy) / k; out[q + 2] = t.elev[i]; out[q + 3] = t.size[i]; out[q + 4] = t.seed[i];
        }
      }
      return { data: out.subarray(0, j * STRIDE), count: j, origin: [ox, oy, k] };
    }

    // ---- drawing (inside MapLibre's frame, which resets its own GL state afterwards)
    init(gl) {
      const api = glApi(gl), prog = program(gl), vao = api.vao();
      const corners = gl.createBuffer(), trees = gl.createBuffer(), L = prog.loc;
      api.bind(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, corners);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, 0, 0.5, 0, -0.5, 1, 0.5, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(L.a_corner); gl.vertexAttribPointer(L.a_corner, 2, gl.FLOAT, false, 0, 0); api.divisor(L.a_corner, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, trees);
      gl.enableVertexAttribArray(L.a_tree); gl.vertexAttribPointer(L.a_tree, 4, gl.FLOAT, false, STRIDE * 4, 0); api.divisor(L.a_tree, 1);
      gl.enableVertexAttribArray(L.a_seed); gl.vertexAttribPointer(L.a_seed, 1, gl.FLOAT, false, STRIDE * 4, 16); api.divisor(L.a_seed, 1);
      api.bind(null);
      const tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.atlas);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.gl = { api, prog, vao, corners, trees, tex };
      this.stats.webgl = api.version;
    }
    render(gl, args) {
      if (this.error) return;
      try { this.draw(gl, args); } catch (e) { this.fail(e.message || String(e)); }
    }
    draw(gl, args) {
      if (gl.isContextLost()) { this.fail("WebGL context lost"); return; }
      if (!this.gl) this.init(gl);
      const g = this.gl, L = g.prog.loc, o = this.opt, map = this.map;
      if (this.pending) {
        gl.bindBuffer(gl.ARRAY_BUFFER, g.trees); gl.bufferData(gl.ARRAY_BUFFER, this.pending.data, gl.DYNAMIC_DRAW);
        this.count = this.pending.count; this.origin = this.pending.origin; this.pending = null;
      }
      const zoom = map.getZoom();
      this.stats.drawn = zoom < o.minzoom ? 0 : this.count;
      if (!this.stats.drawn) return;
      // MapLibre 5 gives custom layers a matrix from mercator units (x, y and z) to clip space; ours starts at the trees' origin, in metres
      const A = args && args.defaultProjectionData ? args.defaultProjectionData.mainMatrix : args, M = this.matrix;
      const [ox, oy, k] = this.origin, kz = mercPerMetre(map.getCenter().lat);   // MapLibre scales heights at the map's centre
      for (let i = 0; i < 4; i++) { M[i] = A[i] * k; M[4 + i] = A[4 + i] * k; M[8 + i] = A[8 + i] * kz; M[12 + i] = A[i] * ox + A[4 + i] * oy + A[12 + i]; }
      const b = (map.getBearing() * Math.PI) / 180;
      gl.useProgram(g.prog.p);
      gl.uniformMatrix4fv(L.u_matrix, false, M);
      gl.uniform2f(L.u_right, Math.cos(b), Math.sin(b));
      gl.uniform3f(L.u_pic, this.pic[0], this.pic[1], this.pic[2]);
      gl.uniform4f(L.u_cell, ATLAS.cellW / ATLAS.w, ATLAS.cellH / ATLAS.h, (ATLAS.cellW - ATLAS.picW) / 2 / ATLAS.w, (ATLAS.cellH - ATLAS.picH) / 2 / ATLAS.h);
      gl.uniform2f(L.u_picsize, ATLAS.picW / ATLAS.w, ATLAS.picH / ATLAS.h);
      gl.uniform1f(L.u_opacity, o.opacity * Math.min(1, (zoom - o.minzoom) / (o.fullAt - o.minzoom)));
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, g.tex); gl.uniform1i(L.u_atlas, 0);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.disable(gl.CULL_FACE);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
      g.api.bind(g.vao);
      gl.depthMask(true); gl.uniform2f(L.u_keep, CORE, 2); g.api.draw(this.count);      // dense texels: drawn, and hide what is behind
      gl.depthMask(false); gl.uniform2f(L.u_keep, EDGE, CORE); g.api.draw(this.count);  // soft edges: blended, hide nothing
      gl.depthMask(true);
      g.api.bind(null);
      this.stats.frames++;
    }
  }

  window.BikeTrees3D = { create: (map, opts) => new TreeLayer(map, opts), ATLAS };
})();
