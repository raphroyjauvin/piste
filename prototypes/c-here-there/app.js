/* Prototype C: "Here & There". A true axonometric white model in three.js, with the world ahead bending
   gently up toward you and hills ahead exaggerated, after Schulze & Webb's horizonless Manhattan map. */
import * as THREE from "three";
import { CSS2DRenderer, CSS2DObject } from "three/addons/CSS2DRenderer.js";

const C = window.BikeCommon;
const { Router, weightsFor, PROFILES, buildCursor } = window.BikeRouter;
const $ = (s) => document.querySelector(s);
const say = (t) => ($("#loading-msg").textContent = t);
const breathe = () => new Promise((r) => setTimeout(r, 0));

// ------------------------------------------------------------------ local metric frame
const DEM = window.DEM_GRID;
const LON0 = (DEM.w + DEM.e) / 2, LAT0 = (DEM.s + DEM.n) / 2;
const KX = 111320 * Math.cos((LAT0 * Math.PI) / 180), KY = 110540;
const toX = (lon) => (lon - LON0) * KX, toZ = (lat) => -(lat - LAT0) * KY;
const toLon = (x) => x / KX + LON0, toLat = (z) => -z / KY + LAT0;
let ZMIN = Infinity; for (const v of DEM.z) if (v < ZMIN) ZMIN = v; ZMIN /= 10;
function relElev(lon, lat) {
  const fx = Math.max(0, Math.min(DEM.nx - 1.001, ((lon - DEM.w) / (DEM.e - DEM.w)) * (DEM.nx - 1)));
  const fy = Math.max(0, Math.min(DEM.ny - 1.001, ((DEM.n - lat) / (DEM.n - DEM.s)) * (DEM.ny - 1)));
  const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j, z = DEM.z, nx = DEM.nx;
  const a = z[j * nx + i], b = z[j * nx + i + 1], c = z[(j + 1) * nx + i], d = z[(j + 1) * nx + i + 1];
  return ((a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v) / 10 - ZMIN;
}

// ------------------------------------------------------------------ renderer, scene, camera
const stage = $("#stage");
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
stage.appendChild(renderer.domElement);
const labels = new CSS2DRenderer(); labels.setSize(innerWidth, innerHeight);
Object.assign(labels.domElement.style, { position: "absolute", inset: "0", pointerEvents: "none" });
stage.appendChild(labels.domElement);
const scene = new THREE.Scene();
const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -20000, 40000);
let needs = true; // render-request flag (kept simple: we render every frame for now)
scene.add(new THREE.HemisphereLight(0xffffff, 0xd9d3c7, 1.15));
const sun = new THREE.DirectionalLight(0xfff6ea, 2.5);
sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -420, right: 420, top: 420, bottom: -420, near: 1, far: 4000 });
sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.6;
scene.add(sun, sun.target);

// shared uniforms for the bend: focus point, forward direction, bend and hills
const U = { uFocus: { value: new THREE.Vector2() }, uFwd: { value: new THREE.Vector2(0, -1) }, uBend: { value: 0.35 }, uExag: { value: 1.8 }, uAhead: { value: 1.2 } };
const BEND_GLSL = `
  vec2 bRel = transformed.xz - uFocus;
  float bS = dot(bRel, uFwd);
  transformed.y += aGround * (uExag - 1.0 + uAhead * smoothstep(40.0, 700.0, bS));
  float bK = max(0.0, bS - 90.0);
  transformed.y += uBend * bK * bK / 520.0;`;
function bendable(mat) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = "attribute float aGround;\nuniform vec2 uFocus;\nuniform vec2 uFwd;\nuniform float uBend;\nuniform float uExag;\nuniform float uAhead;\n" +
      sh.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\n" + BEND_GLSL);
  };
  mat.customProgramCacheKey = () => "bend";
  return mat;
}
function bentY(x, z, g, y) { // same maths as the shader, for labels and the rider
  const s = (x - U.uFocus.value.x) * U.uFwd.value.x + (z - U.uFocus.value.y) * U.uFwd.value.y;
  const sm = Math.min(1, Math.max(0, (s - 40) / 660)); const smooth = sm * sm * (3 - 2 * sm);
  const k = Math.max(0, s - 90);
  return y + g * (U.uExag.value - 1 + U.uAhead.value * smooth) + (U.uBend.value * k * k) / 520;
}
const depthMat = bendable(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }));

// ------------------------------------------------------------------ build the model
const router = new Router(window.GRAPH_STUDY);
let terrainMesh;
async function build() {
  say("Terrain from LiDAR (NRCan 2023)…"); await breathe();
  // painted ground: landcover + contours on a canvas texture
  const W = 4096, H = Math.round(4096 * ((DEM.n - DEM.s) * KY) / ((DEM.e - DEM.w) * KX));
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const g = cv.getContext("2d");
  const px = (lon) => ((lon - DEM.w) / (DEM.e - DEM.w)) * W, py = (lat) => ((DEM.n - lat) / (DEM.n - DEM.s)) * H;
  g.fillStyle = "#ece9e2"; g.fillRect(0, 0, W, H);
  const FILL = { park: "#d7e6cf", wood: "#c8dcbf", sport: "#dfe9d6", cemetery: "#dfe4d5", water: "#c3d9e6" };
  const poly = (coords) => { g.beginPath(); for (const ring of coords) { ring.forEach(([lo, la], k) => (k ? g.lineTo(px(lo), py(la)) : g.moveTo(px(lo), py(la)))); g.closePath(); } g.fill("evenodd"); };
  for (const f of window.LANDCOVER.features) {
    const c = f.properties.c; if (!FILL[c]) continue; g.fillStyle = FILL[c];
    if (f.geometry.type === "Polygon") poly(f.geometry.coordinates); else if (f.geometry.type === "MultiPolygon") f.geometry.coordinates.forEach(poly);
  }
  g.lineCap = "round";
  // contours are left out here: at riding zoom they read as stains; relief comes from the shaded terrain and "Hills ×"
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  // terrain mesh
  const nx = DEM.nx, ny = DEM.ny, pos = new Float32Array(nx * ny * 3), uv = new Float32Array(nx * ny * 2), gr = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i, lon = DEM.w + ((DEM.e - DEM.w) * i) / (nx - 1), lat = DEM.n - ((DEM.n - DEM.s) * j) / (ny - 1);
    const e = DEM.z[k] / 10 - ZMIN;
    pos[3 * k] = toX(lon); pos[3 * k + 1] = e; pos[3 * k + 2] = toZ(lat); gr[k] = e;
    uv[2 * k] = i / (nx - 1); uv[2 * k + 1] = 1 - j / (ny - 1);
  }
  const idx = new Uint32Array((nx - 1) * (ny - 1) * 6); let q = 0;
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
    idx.set([a, c, b, b, c, d], q); q += 6;
  }
  const tg = new THREE.BufferGeometry();
  tg.setAttribute("position", new THREE.BufferAttribute(pos, 3)); tg.setAttribute("uv", new THREE.BufferAttribute(uv, 2)); tg.setAttribute("aGround", new THREE.BufferAttribute(gr, 1));
  tg.setIndex(new THREE.BufferAttribute(idx, 1)); tg.computeVertexNormals();
  terrainMesh = new THREE.Mesh(tg, bendable(new THREE.MeshLambertMaterial({ map: tex })));
  terrainMesh.receiveShadow = true; terrainMesh.customDepthMaterial = depthMat; scene.add(terrainMesh);

  say("Streets and bike network…"); await breathe();
  buildStreets();
  say("71,000 buildings, heights from LiDAR…"); await breathe();
  await buildBuildings();
}

// ribbon helper: flat strip along a polyline, draped on the ground (+ lift), into arrays
function ribbon(out, pts, width, lift, color, dash) {
  const hw = width / 2;
  for (let i = 1; i < pts.length; i++) {
    const [x0, z0, g0] = pts[i - 1], [x1, z1, g1] = pts[i];
    const dx = x1 - x0, dz = z1 - z0, L = Math.hypot(dx, dz); if (L < 0.01) continue;
    const nx = (-dz / L) * hw, nz = (dx / L) * hw;
    const pieces = dash ? Math.max(1, Math.round(L / dash)) : 1;
    for (let p = 0; p < pieces; p++) {
      const t0 = p / pieces, t1 = (p + 1) / pieces;
      const col = dash && p % 2 ? dash.alt || [1, 1, 1] : color;
      const ax = x0 + dx * t0, az = z0 + dz * t0, ag = g0 + (g1 - g0) * t0, bx = x0 + dx * t1, bz = z0 + dz * t1, bg = g0 + (g1 - g0) * t1;
      const quad = [[ax + nx, az + nz, ag], [ax - nx, az - nz, ag], [bx + nx, bz + nz, bg], [bx - nx, bz - nz, bg]];
      for (const k of [0, 1, 2, 2, 1, 3]) { const [x, z, gg] = quad[k]; out.p.push(x, gg + lift, z); out.g.push(gg); out.c.push(...col); }
    }
    // round-ish joint so corners do not show gaps
    if (i < pts.length - 1) for (let s = 0; s < 6; s++) {
      const a0 = (s / 6) * Math.PI * 2, a1 = ((s + 1) / 6) * Math.PI * 2;
      for (const [x, z] of [[x1, z1], [x1 + Math.cos(a0) * hw, z1 + Math.sin(a0) * hw], [x1 + Math.cos(a1) * hw, z1 + Math.sin(a1) * hw]]) { out.p.push(x, g1 + lift, z); out.g.push(g1); out.c.push(...color); }
    }
  }
}
function ribbonMesh(out, order) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(out.p, 3)); geo.setAttribute("aGround", new THREE.Float32BufferAttribute(out.g, 1)); geo.setAttribute("color", new THREE.Float32BufferAttribute(out.c, 3));
  const m = new THREE.Mesh(geo, bendable(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 - order, polygonOffsetUnits: -4 - order })));
  m.renderOrder = order; m.frustumCulled = false; return m;
}
const rgb = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
function edgePts(e) { return router.edgeCoords(e, true).map(([lo, la]) => [toX(lo), toZ(la), relElev(lo, la)]); }
function buildStreets() {
  const streets = { p: [], g: [], c: [] }, bikes = { p: [], g: [], c: [] };
  const OFF = window.GRAPH_STUDY.meta.flags.OFFSTREET;
  const WHITE = rgb("#ffffff"), BUSY = rgb("#fdfcf9"), BIKE = [rgb("#2fb350"), rgb("#5cc471"), rgb("#93d3a0")];
  for (let e = 0; e < router.m; e++) {
    const t = router.etier[e]; if (t === 5) continue;
    const pts = edgePts(e), off = window.GRAPH_STUDY.flags[e] & OFF;
    if (!off) ribbon(streets, pts, t === 4 ? 12 : 8.5, 0.12, t === 4 ? BUSY : WHITE);
    if (t <= 2) ribbon(bikes, pts, off ? 3.2 : [3, 2.4, 1.8][t], 0.3, BIKE[t]);
  }
  scene.add(ribbonMesh(streets, 1), ribbonMesh(bikes, 2));
}
// Buildings load in tiles around the focus point: everything on a desktop, a ~1.4 km radius on a phone.
const IS_PHONE = Math.min(innerWidth, innerHeight) < 600 || (navigator.maxTouchPoints > 0 && innerWidth < 1100);
const CHUNK_R = IS_PHONE ? 1400 : 6000;
const tiles = new Map(); // key -> { cx, cz, items: [{pts, h, g0, area}], mesh }
let tileQueue = [], lastTileFocus = null;
const bldMat = bendable(new THREE.MeshLambertMaterial({ vertexColors: true }));
async function buildBuildings() {
  const P = window.BUILDINGS_PACKED, CH = 16;
  let x = 0, y = 0, k = 0;
  for (let i = 0; i < P.c.length; i++) {
    const ring = [];
    for (let j = 0; j < P.c[i]; j++) { x += P.d[k++]; y += P.d[k++]; ring.push([x / 1e6, y / 1e6]); }
    let cx = 0, cy = 0; for (const [lo, la] of ring) { cx += lo; cy += la; } cx /= ring.length; cy /= ring.length;
    const pts = ring.map(([lo, la]) => [toX(lo), toZ(la)]);
    let area = 0; for (let a = 0; a < pts.length; a++) { const [x0, z0] = pts[a], [x1, z1] = pts[(a + 1) % pts.length]; area += x0 * z1 - x1 * z0; }
    const ck = Math.floor(((cx - DEM.w) / (DEM.e - DEM.w)) * CH) + "_" + Math.floor(((DEM.n - cy) / (DEM.n - DEM.s)) * CH);
    let t = tiles.get(ck); if (!t) tiles.set(ck, (t = { sx: 0, sz: 0, items: [], mesh: null }));
    t.items.push({ pts, h: P.h[i] / 10, g0: relElev(cx, cy), area }); t.sx += toX(cx); t.sz += toZ(cy);
    if (i % 20000 === 0) { say(`Buildings ${i.toLocaleString()} / ${P.c.length.toLocaleString()}…`); await breathe(); }
  }
  for (const t of tiles.values()) { t.cx = t.sx / t.items.length; t.cz = t.sz / t.items.length; }
}
function updateTiles(force) {
  const fx = U.uFocus.value.x, fz = U.uFocus.value.y;
  if (!force && lastTileFocus && Math.hypot(fx - lastTileFocus[0], fz - lastTileFocus[1]) < 150) return;
  lastTileFocus = [fx, fz];
  tileQueue = [];
  for (const t of tiles.values()) {
    const d = Math.hypot(t.cx - fx, t.cz - fz);
    if (d < CHUNK_R && !t.mesh) tileQueue.push([d, t]);
    if (d > CHUNK_R * 1.7 && t.mesh) { scene.remove(t.mesh); t.mesh.geometry.dispose(); t.mesh = null; }
  }
  tileQueue.sort((a, b) => a[0] - b[0]);
}
function buildTile(t) {
  const o = { p: [], n: [], c: [], g: [] };
  const base = new THREE.Color("#f3f1ec");
  const shade = (f) => [base.r * f, base.g * f, base.b * f];
  for (const { pts, h, g0, area } of t.items) {
    // walls (darker at the foot: a cheap contact shadow)
    for (let a = 0; a < pts.length; a++) {
      const [x0, z0] = pts[a], [x1, z1] = pts[(a + 1) % pts.length];
      let nx = z1 - z0, nz = -(x1 - x0); const L = Math.hypot(nx, nz) || 1; nx /= L; nz /= L; if (area < 0) { nx = -nx; nz = -nz; }
      const lo = shade(0.8), hi = shade(1.0);
      const v = [[x0, g0, z0, lo], [x1, g0, z1, lo], [x0, g0 + h, z0, hi], [x1, g0 + h, z1, hi]];
      // wind triangles so their front face points outward (cross(e1, e2) . n > 0)
      const crossDot = (-(z1 - z0)) * nx + (x1 - x0) * nz;
      const order = crossDot > 0 ? [0, 1, 2, 2, 1, 3] : [0, 2, 1, 2, 3, 1];
      for (const q of order) { o.p.push(v[q][0], v[q][1], v[q][2]); o.n.push(nx, 0, nz); o.c.push(...v[q][3]); o.g.push(g0); }
    }
    // roof (wound to face up)
    const tris = THREE.ShapeUtils.triangulateShape(pts.map(([px, pz]) => new THREE.Vector2(px, pz)), []);
    const rc = shade(1.05);
    for (let [a, b, c] of tris) {
      const cy = (pts[b][1] - pts[a][1]) * (pts[c][0] - pts[a][0]) - (pts[b][0] - pts[a][0]) * (pts[c][1] - pts[a][1]);
      if (cy < 0) [b, c] = [c, b];
      for (const q of [a, b, c]) { o.p.push(pts[q][0], g0 + h, pts[q][1]); o.n.push(0, 1, 0); o.c.push(...rc); o.g.push(g0); }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(o.p, 3)); geo.setAttribute("normal", new THREE.Float32BufferAttribute(o.n, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(o.c, 3)); geo.setAttribute("aGround", new THREE.Float32BufferAttribute(o.g, 1));
  const m = new THREE.Mesh(geo, bldMat); m.castShadow = true; m.receiveShadow = true; m.customDepthMaterial = depthMat; m.frustumCulled = false;
  scene.add(m); t.mesh = m;
}

// ------------------------------------------------------------------ the rider: a small abstract cyclist
function makeRider() {
  const grp = new THREE.Group(), blue = new THREE.MeshLambertMaterial({ color: "#0095E6" }), dark = new THREE.MeshLambertMaterial({ color: "#20262c" }), white = new THREE.MeshLambertMaterial({ color: "#ffffff" });
  const wheel = new THREE.TorusGeometry(0.34, 0.06, 8, 24);
  for (const zz of [-0.55, 0.55]) { const w = new THREE.Mesh(wheel, dark); w.position.set(0, 0.36, zz); w.rotation.y = Math.PI / 2; grp.add(w); }
  const bar = (a, b, mat, r = 0.05) => { const v = new THREE.Vector3().subVectors(b, a); const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, v.length(), 6), mat); m.position.copy(a).addScaledVector(v, 0.5); m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v.normalize()); grp.add(m); };
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  bar(V(0, 0.36, 0.55), V(0, 0.75, 0.05), blue); bar(V(0, 0.75, 0.05), V(0, 0.36, -0.55), blue); bar(V(0, 0.75, 0.05), V(0, 0.85, -0.45), blue); bar(V(0, 0.36, -0.55), V(0, 0.85, -0.45), blue);
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.5, 4, 8), white); body.position.set(0, 1.2, 0.08); body.rotation.x = 0.45; grp.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 10), blue); head.position.set(0, 1.62, -0.12); grp.add(head);
  const ring = new THREE.Mesh(new THREE.RingGeometry(2.2, 3.0, 40), new THREE.MeshBasicMaterial({ color: "#0095E6", transparent: true, opacity: 0.55, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.05; grp.add(ring);
  grp.scale.setScalar(11); grp.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return grp;
}
const rider = makeRider(); rider.visible = false; scene.add(rider);

// ------------------------------------------------------------------ route rendering
const state = { from: null, to: null, fromLabel: "", toLabel: "", route: null, trip: null, view: "axo", ride: null };
let routeMeshes = [], labelObjs = [], poiObjs = [];
const TIERC = ["#0095E6", "#6cc3f2", "#0095E6", "#f2a865", "#ef8f45", "#d7263d"].map(rgb);
function drawRoute(r) {
  routeMeshes.forEach((m) => { scene.remove(m); m.geometry.dispose(); }); routeMeshes = [];
  labelObjs.forEach((o) => scene.remove(o)); labelObjs = []; poiObjs.forEach((o) => scene.remove(o.obj)); poiObjs = [];
  if (!r) return;
  const casing = { p: [], g: [], c: [] }, line = { p: [], g: [], c: [] };
  for (const piece of r.pieces) {
    const pts = piece.coords.map(([lo, la]) => [toX(lo), toZ(la), relElev(lo, la)]);
    ribbon(casing, pts, 10.5, 0.55, rgb("#0d3550"));
    ribbon(line, pts, 7, 0.8, TIERC[piece.tier], piece.tier === 2 || piece.tier === 3 ? makeDash(piece.tier) : null);
  }
  routeMeshes = [ribbonMesh(casing, 3), ribbonMesh(line, 4)]; routeMeshes.forEach((m) => scene.add(m));
  // labels: ends + gap starts
  const cur = buildCursor(r);
  const lab = (lon, lat, html, cls) => { const d = document.createElement("div"); d.className = "lbl " + cls; d.innerHTML = html; const o = new CSS2DObject(d); o.userData = { x: toX(lon), z: toZ(lat), g: relElev(lon, lat) }; scene.add(o); labelObjs.push(o); return o; };
  lab(r.coords[0][0], r.coords[0][1], C.esc(state.fromLabel || "Start"), "term");
  lab(r.coords[r.coords.length - 1][0], r.coords[r.coords.length - 1][1], C.esc(state.toLabel || "Destination"), "term");
  for (const g of r.gaps) { const p = cur.at(g.start + 1); lab(p.lon, p.lat, `${Math.round(g.length)} m no bike lane`, "gapl"); }
  // POIs along the route
  for (const p of C.routePOIs(r, window.POIS, 70)) {
    const d = document.createElement("div"); d.className = "poi3";
    d.innerHTML = `<img alt="" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(C.iconSVG(p.kind, { size: 56, lines: p.extra }))}"><span>${C.esc(p.name || C.POI_KINDS[p.kind].label)}</span>`;
    const o = new CSS2DObject(d); o.userData = { x: toX(p.lon), z: toZ(p.lat), g: relElev(p.lon, p.lat) }; scene.add(o); poiObjs.push({ obj: o, p });
  }
  placeLabels();
}
// a dash spec is a Number (dash length in metres) carrying the alternate colour
function makeDash(tier) { return Object.assign(new Number(5), { alt: tier === 2 ? rgb("#ffffff") : rgb("#fbe3cf") }); }
function placeLabels() {
  for (const o of labelObjs) o.position.set(o.userData.x, bentY(o.userData.x, o.userData.z, o.userData.g, o.userData.g + 4), o.userData.z);
  const d = state.ride ? state.ride.d : null;
  let lastAlong = -1e9;
  for (const { obj, p } of poiObjs) {
    obj.position.set(obj.userData.x, bentY(obj.userData.x, obj.userData.z, obj.userData.g, obj.userData.g + 3), obj.userData.z);
    const ahead = d === null ? 0 : p.along - d;
    // overview: a sparse set of icons, no names; riding: what is coming up, named when close
    let show = d === null ? ["metro", "cafe", "water", "repair", "bikeshop", "bixi"].includes(p.kind) && p.along - lastAlong > 140 : ahead > -15 && ahead < 350;
    if (show && d === null) lastAlong = p.along;
    obj.element.style.opacity = show ? 1 : 0;
    obj.element.querySelector("span").style.display = d !== null && ahead < 160 ? "" : "none";
  }
}

// ------------------------------------------------------------------ camera & view
const view = { tx: 0, tz: 0, yaw: -34, elev: 36, span: 1400 };
function placeCamera() {
  const yaw = (view.yaw * Math.PI) / 180, el = (view.elev * Math.PI) / 180;
  const f = new THREE.Vector3(Math.sin(yaw), 0, -Math.cos(yaw));
  const gT = relElev(toLon(view.tx), toLat(view.tz)) * U.uExag.value;
  const target = new THREE.Vector3(view.tx, gT, view.tz);
  const D = 6000;
  cam.position.copy(target).addScaledVector(f, -Math.cos(el) * D).add(new THREE.Vector3(0, Math.sin(el) * D, 0));
  cam.up.set(0, 1, 0).multiplyScalar(Math.cos(el)).addScaledVector(f, Math.sin(el)).normalize();
  cam.lookAt(target);
  const asp = innerWidth / innerHeight;
  Object.assign(cam, { top: view.span / 2, bottom: -view.span / 2, left: (-view.span * asp) / 2, right: (view.span * asp) / 2 });
  cam.updateProjectionMatrix();
  U.uFocus.value.set(view.tx, view.tz); U.uFwd.value.set(f.x, f.z);
  // sun from the north-west, shadows centred on the view
  const sunDir = new THREE.Vector3(-0.55, 0.78, -0.3).normalize();
  sun.position.copy(target).addScaledVector(sunDir, 1500); sun.target.position.copy(target);
  const s = Math.min(900, view.span * 0.75); Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s }); sun.shadow.camera.updateProjectionMatrix();
  if (view.elev > 80) { U.uBend.value = 0; U.uAhead.value = 0; } else { U.uBend.value = +$("#bend").value / 100; U.uAhead.value = state.ride ? 1.4 : 0.8; }
  placeLabels(); needs = true;
}
function fitRoute(r) {
  const xs = r.coords.map((c) => toX(c[0])), zs = r.coords.map((c) => toZ(c[1]));
  view.tx = (Math.min(...xs) + Math.max(...xs)) / 2; view.tz = (Math.min(...zs) + Math.max(...zs)) / 2;
  view.span = Math.max(500, Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) * 1.05);
  placeCamera();
}
function setView(v) {
  state.view = v; $("#view-btn").classList.toggle("top", v === "top"); $("#view-label").textContent = v === "top" ? "TOP" : "AXO";
  const goal = v === "top" ? 89.5 : 36, start = view.elev, t0 = performance.now();
  const step = (t) => { const k = Math.min(1, (t - t0) / 600); view.elev = start + (goal - start) * (1 - Math.pow(1 - k, 3)); placeCamera(); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
$("#view-btn").onclick = () => setView(state.view === "top" ? "axo" : "top");
$("#r-view").onclick = () => setView(state.view === "top" ? "axo" : "top");
for (const [id, out, fmt, apply] of [["bend", "bend-out", (v) => (v / 100).toFixed(2), () => placeCamera()], ["exag", "exag-out", (v) => (v / 10).toFixed(1) + "×", (v) => { U.uExag.value = v / 10; placeCamera(); }]]) {
  const el = $("#" + id); const upd = () => { $("#" + out).textContent = fmt(+el.value); apply(+el.value); }; el.addEventListener("input", upd); upd();
}
$("#shadows").onchange = (e) => { sun.castShadow = e.target.checked; needs = true; };

// pan / zoom / rotate / click (mouse and touch; two fingers pinch to zoom)
let drag = null;
const touches = new Map(); let pinch = null;
renderer.domElement.style.touchAction = "none";
renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());
renderer.domElement.addEventListener("pointerdown", (e) => {
  touches.set(e.pointerId, [e.clientX, e.clientY]);
  if (touches.size === 2) { const [a, b] = [...touches.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), span: view.span }; if (drag) drag.moved = true; return; }
  drag = { x: e.clientX, y: e.clientY, b: e.button, moved: false, shift: e.shiftKey }; renderer.domElement.setPointerCapture(e.pointerId);
});
const endTouch = (e) => { touches.delete(e.pointerId); if (touches.size < 2) pinch = null; };
renderer.domElement.addEventListener("pointercancel", endTouch);
renderer.domElement.addEventListener("pointermove", (e) => {
  if (touches.has(e.pointerId)) touches.set(e.pointerId, [e.clientX, e.clientY]);
  if (pinch && touches.size === 2) { const [a, b] = [...touches.values()]; const d = Math.hypot(a[0] - b[0], a[1] - b[1]); view.span = Math.max(120, Math.min(9000, pinch.span * (pinch.d / Math.max(20, d)))); placeCamera(); return; }
  if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
  drag.x = e.clientX; drag.y = e.clientY;
  if (state.ride) return;
  if (drag.b === 2 || e.ctrlKey) { view.yaw += dx * 0.3; view.elev = Math.max(20, Math.min(89.5, view.elev - dy * 0.2)); }
  else {
    const wpp = view.span / innerHeight, yaw = (view.yaw * Math.PI) / 180, el = (view.elev * Math.PI) / 180;
    const rx = Math.cos(yaw), rz = Math.sin(yaw), fx = Math.sin(yaw), fz = -Math.cos(yaw);
    view.tx -= rx * dx * wpp; view.tz -= rz * dx * wpp; view.tx += (fx * dy * wpp) / Math.max(0.35, Math.sin(el)); view.tz += (fz * dy * wpp) / Math.max(0.35, Math.sin(el));
  }
  placeCamera();
});
renderer.domElement.addEventListener("pointerup", (e) => {
  endTouch(e);
  const d = drag; drag = null; if (!d || d.moved || state.ride || d.b !== 0) return;
  const ndc = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  const rc = new THREE.Raycaster(); rc.setFromCamera(ndc, cam);
  const hit = rc.intersectObject(terrainMesh)[0]; if (!hit) return;
  const lon = toLon(hit.point.x), lat = toLat(hit.point.z);
  if (d.shift || !state.from) { state.from = [lon, lat]; state.fromLabel = "Start"; } else { state.to = [lon, lat]; state.toLabel = "Destination"; }
  state.trip = null; document.querySelectorAll(".trips button").forEach((b) => b.classList.remove("on")); route(false);
});
renderer.domElement.addEventListener("wheel", (e) => { e.preventDefault(); view.span = Math.max(120, Math.min(9000, view.span * Math.pow(1.0012, e.deltaY))); placeCamera(); }, { passive: false });
addEventListener("resize", () => { renderer.setSize(innerWidth, innerHeight); labels.setSize(innerWidth, innerHeight); placeCamera(); });

// ------------------------------------------------------------------ routing UI
function route(fit) {
  if (!state.from || !state.to) { drawRoute(null); return; }
  const r = router.route(state.from, state.to, weightsFor(+$("#strict").value / 100, false));
  state.route = r; drawRoute(r); renderStats(r); if (fit && r) fitRoute(r); needs = true;
}
function renderStats(r) {
  if (!r) { $("#stats").innerHTML = ""; $("#gaps").innerHTML = ""; return; }
  const bars = r.byTier.map((m, i) => (m > 0 ? `<i style="width:${(m / r.length) * 100}%;background:${["#0095E6", "#6cc3f2", "#a6d9f6", "#f6bf8f", "#ef8f45", "#d7263d"][i]}"></i>` : "")).join("");
  $("#stats").innerHTML = `<div><b>${Math.round(C.rideMinutes(r))}</b><span>min</span></div><div><b>${(r.length / 1000).toFixed(1)}</b><span>km</span></div><div><b>${C.fmtPct(r.infraShare)}</b><span>bike infra</span></div><div class="compo">${bars}</div>`;
  $("#gaps").innerHTML = r.gaps.length ? r.gaps.map((g) => `<div><em>${Math.round(g.length)} m</em><span>no bike lane${g.names[0] ? " · " + C.esc(g.names[0]) : ""}${g.busy ? " · busy" : ""}</span></div>`).join("") : `<div><em>0 m</em><span>Bike infrastructure all the way</span></div>`;
}
for (const t of window.TRIPS) {
  const b = document.createElement("button"); b.dataset.trip = t.id;
  b.textContent = { rachel: "Rachel", montroyal: "Mont-Royal → Papineau", biodome: "Assomption → Biodôme", davidson: "Assomption → Davidson" }[t.id];
  b.onclick = () => useTrip(t); $("#trips").appendChild(b);
}
function useTrip(t) {
  state.trip = t; state.from = t.from.lonlat; state.to = t.to.lonlat; state.fromLabel = t.from.label; state.toLabel = t.to.label;
  document.querySelectorAll(".trips button").forEach((b) => b.classList.toggle("on", b.dataset.trip === t.id)); route(true);
}
$("#strict").addEventListener("input", () => route(false));

// ------------------------------------------------------------------ ride
let smoothYaw = 0, afterGap = 0;
$("#ride").onclick = () => startRide();
function startRide() {
  if (!state.route) return;
  state.ride = new C.RideSim(state.route, { mult: 4, pois: C.routePOIs(state.route, window.POIS, 70), onFrame: rideFrame, onEvent: () => {} });
  $("#card").hidden = true; $("#hud").hidden = false; rider.visible = true; smoothYaw = view.yaw;
  if (IS_PHONE) document.querySelector(".dials").hidden = true;
  view.span = 300; if (state.view !== "top") view.elev = 38; state.ride.start();
}
function rideFrame(f) {
  const x = toX(f.pos.lon), z = toZ(f.pos.lat);
  const d = (((f.pos.heading - smoothYaw + 540) % 360) - 180); smoothYaw += d * 0.1;
  const yaw = (smoothYaw * Math.PI) / 180; view.yaw = smoothYaw;
  view.tx = x + Math.sin(yaw) * 70; view.tz = z - Math.cos(yaw) * 70;
  placeCamera();
  U.uFocus.value.set(x, z);
  const g = relElev(f.pos.lon, f.pos.lat);
  rider.position.set(x, bentY(x, z, g, g), z); rider.rotation.y = -((f.pos.heading * Math.PI) / 180) + Math.PI;
  placeLabels();
  const L = f.look;
  $("#turn-dist").textContent = L.next ? C.fmtKm(L.nextDist) : C.fmtKm(f.total - f.d);
  $("#turn-text").textContent = L.next ? L.next.text : "Arrive at " + (state.toLabel || "destination");
  const gp = $("#gap");
  if (L.inGap) { gp.className = "gap"; gp.hidden = false; gp.textContent = `No bike lane for ${C.fmtKm(L.inGap.start + L.inGap.length - f.d)}${L.inGap.names[0] ? " on " + L.inGap.names[0] : ""}${L.inGap.busy ? ", with traffic" : ""}.`; afterGap = performance.now() + 4000; }
  else if (L.nextGap && L.nextGapDist < 400) { gp.className = "gap"; gp.hidden = false; gp.textContent = `In ${C.fmtKm(L.nextGapDist)}: ${Math.round(L.nextGap.length)} m without a bike lane${L.nextGap.names[0] ? " on " + L.nextGap.names[0] : ""}.`; }
  else if (performance.now() < afterGap) { gp.className = "gap ok"; gp.hidden = false; gp.textContent = "Back on a bike lane."; }
  else gp.hidden = true;
  $("#prog").style.width = `${(f.d / f.total) * 100}%`; $("#remain").textContent = `${C.fmtKm(f.total - f.d)} left`;
}
$("#r-speed").onclick = () => { const m = { 1: 4, 4: 10, 10: 1 }[state.ride.mult]; state.ride.mult = m; $("#r-speed").textContent = m + "×"; };
$("#r-pause").onclick = () => { if (state.ride.running) { state.ride.pause(); $("#r-pause").textContent = "Resume"; } else { state.ride.start(); $("#r-pause").textContent = "Pause"; } };
$("#r-end").onclick = () => { state.ride.pause(); state.ride = null; rider.visible = false; $("#hud").hidden = true; $("#card").hidden = false; document.querySelector(".dials").hidden = false; view.elev = state.view === "top" ? 89.5 : 36; fitRoute(state.route); };

// ------------------------------------------------------------------ go
function loop() {
  updateTiles(false);
  const t0 = performance.now();
  while (tileQueue.length && performance.now() - t0 < 12) buildTile(tileQueue.shift()[1]); // a few tiles per frame, no stutter
  renderer.render(scene, cam); labels.render(scene, cam); requestAnimationFrame(loop);
}
await build();
const q = new URLSearchParams(location.search);
useTrip(window.TRIPS.find((t) => t.id === (q.get("trip") || "montroyal")) || window.TRIPS[0]);
say("Placing buildings around the route…"); await breathe();
updateTiles(true);
{ const t0 = performance.now(); while (tileQueue.length && performance.now() - t0 < (IS_PHONE ? 2500 : 6000)) buildTile(tileQueue.shift()[1]); }
$("#loading").hidden = true;
loop();
window.__app = { state, startRide, setView, view, placeCamera, scene, sun, renderer, U };
