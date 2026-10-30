/* BikeRouter: client-side bike routing on a compact graph (works in browsers and Node).
 *
 * Graph JSON (built by tools/build_graph.py):
 *   nodes: [lonE6, latE6, ...]      node coordinates in micro-degrees
 *   elev:  [dm, ...]                node elevation in decimetres (optional)
 *   a, b:  [node, ...]              edge endpoints
 *   len:   [dm, ...]                edge length in decimetres
 *   tier:  [0..5, ...]              0 A protected, 1 B painted/calm, 2 C shared, 3 D gap quiet, 4 E gap busy, 5 X no bikes
 *   dir:   [0..3, ...]              0 both ways, 1 a->b only, 2 b->a only, 3 closed
 *   name:  [index, ...]             into names[]
 *   cf, cb:[dm, ...]                climb (decimetres) going a->b and b->a
 *   geom:  [[dLonE6, dLatE6, ...]]  intermediate vertices, delta-encoded from node a
 *   names: [string]
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.BikeRouter = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const TIERS = [
    { key: "A", label: "Protected", infra: true },
    { key: "B", label: "Painted lane", infra: true },
    { key: "C", label: "Shared lane", infra: true },
    { key: "D", label: "No bike lane (quiet street)", infra: false },
    { key: "E", label: "No bike lane (busy street)", infra: false },
    { key: "X", label: "Closed to bikes", infra: false },
  ];

  // Penalty multipliers on distance, per tier. Bike infrastructure stays close to 1 so any
  // bike facility is preferred over any street without one.
  const PROFILES = {
    direct: { label: "Most direct", w: [1.0, 1.0, 1.0, 1.0, 1.15, Infinity], hill: 0 },
    balanced: { label: "Balanced", w: [1.0, 1.03, 1.08, 1.7, 3.0, Infinity], hill: 4 },
    bikemax: { label: "Most bike lanes", w: [1.0, 1.05, 1.12, 3.2, 7.0, Infinity], hill: 4 },
  };

  function weightsFor(strictness, avoidHills) {
    // strictness 0 = direct, 1 = most bike lanes (linear blend on each multiplier)
    const s = Math.max(0, Math.min(1, strictness));
    const a = PROFILES.direct.w, b = PROFILES.bikemax.w;
    const w = a.map((v, i) => (i === 5 ? Infinity : v + (b[i] - v) * s));
    return { w, hill: avoidHills ? 12 : 3 * s };
  }

  const R = 6371008.8, D2R = Math.PI / 180;
  function distM(lon1, lat1, lon2, lat2) {
    const x = (lon2 - lon1) * D2R * Math.cos(((lat1 + lat2) / 2) * D2R);
    const y = (lat2 - lat1) * D2R;
    return Math.sqrt(x * x + y * y) * R;
  }
  function bearing(lon1, lat1, lon2, lat2) {
    const y = Math.sin((lon2 - lon1) * D2R) * Math.cos(lat2 * D2R);
    const x = Math.cos(lat1 * D2R) * Math.sin(lat2 * D2R) - Math.sin(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.cos((lon2 - lon1) * D2R);
    return (Math.atan2(y, x) / D2R + 360) % 360;
  }

  // ---------- binary heap keyed by float priority ----------
  class Heap {
    constructor(cap) { this.k = new Float64Array(cap); this.v = new Int32Array(cap); this.n = 0; }
    push(key, val) {
      if (this.n === this.k.length) { const k = new Float64Array(this.n * 2); k.set(this.k); this.k = k; const v = new Int32Array(this.n * 2); v.set(this.v); this.v = v; }
      let i = this.n++;
      while (i > 0) { const p = (i - 1) >> 1; if (this.k[p] <= key) break; this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p; }
      this.k[i] = key; this.v[i] = val;
    }
    pop() {
      const top = this.v[0]; const key = this.k[--this.n]; const val = this.v[this.n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1; if (c >= this.n) break;
        if (c + 1 < this.n && this.k[c + 1] < this.k[c]) c++;
        if (this.k[c] >= key) break;
        this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c;
      }
      this.k[i] = key; this.v[i] = val; return top;
    }
  }

  class Router {
    constructor(g) {
      this.names = g.names;
      const nn = g.nodes.length / 2;
      this.n = nn;
      this.lon = new Float64Array(nn); this.lat = new Float64Array(nn);
      for (let i = 0; i < nn; i++) { this.lon[i] = g.nodes[2 * i] / 1e6; this.lat[i] = g.nodes[2 * i + 1] / 1e6; }
      this.elev = g.elev ? Float32Array.from(g.elev, (v) => v / 10) : null;
      const ne = g.a.length;
      this.m = ne;
      this.ea = Int32Array.from(g.a); this.eb = Int32Array.from(g.b);
      this.elen = Float32Array.from(g.len, (v) => v / 10);
      this.etier = Uint8Array.from(g.tier); this.edir = Uint8Array.from(g.dir);
      this.etierBase = this.etier;
      this.eflags = g.flags ? Uint16Array.from(g.flags) : new Uint16Array(ne);
      const fb = (g.meta && g.meta.flags) || {};
      this.F = { S4: fb["4S"] ?? 2, OFF: fb.OFFSTREET ?? 32, PROT4S: fb.PROT4S ?? 0 };
      this.winter = false;
      this.ename = Int32Array.from(g.name);
      this.ecf = g.cf ? Float32Array.from(g.cf, (v) => v / 10) : new Float32Array(ne);
      this.ecb = g.cb ? Float32Array.from(g.cb, (v) => v / 10) : new Float32Array(ne);
      this.egeom = g.geom || null;
      // CSR adjacency of directed arcs
      const deg = new Int32Array(nn + 1);
      for (let e = 0; e < ne; e++) {
        const d = this.edir[e]; if (d === 3) continue;
        if (d === 0 || d === 1) deg[this.ea[e] + 1]++;
        if (d === 0 || d === 2) deg[this.eb[e] + 1]++;
      }
      for (let i = 0; i < nn; i++) deg[i + 1] += deg[i];
      this.off = deg;
      this.arcE = new Int32Array(deg[nn]); this.arcFwd = new Uint8Array(deg[nn]);
      const fill = deg.slice(0, nn);
      for (let e = 0; e < ne; e++) {
        const d = this.edir[e]; if (d === 3) continue;
        if (d === 0 || d === 1) { const k = fill[this.ea[e]]++; this.arcE[k] = e; this.arcFwd[k] = 1; }
        if (d === 0 || d === 2) { const k = fill[this.eb[e]]++; this.arcE[k] = e; this.arcFwd[k] = 0; }
      }
      this._buildGrid();
      this.gScore = new Float64Array(nn + 2);
      this.prevArc = new Int32Array(nn + 2);
      this.closed = new Uint8Array(nn + 2);
    }

    // ---------- winter: only the 4-season network counts as bike infrastructure ----------
    // Lanes the City doesn't clear become "no bike lane"; off-street paths that aren't cleared also cost 2.5x (snow);
    // cleared protected lanes that lose their separators in winter count as painted lanes.
    setWinter(on) {
      if (on && !this.etierWinter) {
        const t = new Uint8Array(this.m), pen = new Float32Array(this.m).fill(1), F = this.F;
        for (let e = 0; e < this.m; e++) {
          const base = this.etierBase[e], f = this.eflags[e];
          t[e] = base;
          if (base > 2) continue;
          if (!(f & F.S4)) { t[e] = 3; if (f & F.OFF) pen[e] = 2.5; }
          else if (base === 0 && F.PROT4S && !(f & F.PROT4S)) t[e] = 1;
        }
        this.etierWinter = t; this.winterPen = pen;
      }
      this.winter = !!on;
      this.etier = this.winter ? this.etierWinter : this.etierBase;
    }

    // ---------- "avoid headwinds": how much slower each direction of each edge is today ----------
    // toDeg: where the wind blows to; W: wind at rider height (m/s); speedFn(head m/s) -> riding speed (m/s).
    // Only headwinds cost extra (>= 1), so the A* estimate stays a lower bound.
    windCost(toDeg, W, speedFn) {
      const fwd = new Float32Array(this.m), back = new Float32Array(this.m), V0 = 16 / 3.6;
      for (let e = 0; e < this.m; e++) {
        const b = bearing(this.lon[this.ea[e]], this.lat[this.ea[e]], this.lon[this.eb[e]], this.lat[this.eb[e]]);
        const along = W * Math.cos((b - toDeg) * D2R);   // + tailwind riding a->b
        fwd[e] = Math.max(1, V0 / speedFn(-along));
        back[e] = Math.max(1, V0 / speedFn(along));
      }
      return { windFwd: fwd, windBack: back };
    }

    // ---------- spatial index on edge vertices (for snapping) ----------
    _buildGrid() {
      this.cell = 0.0015; // degrees, ~120 m x 170 m
      const grid = new Map();
      const add = (lon, lat, e) => {
        const key = Math.floor(lon / this.cell) * 100000 + Math.floor(lat / this.cell);
        let arr = grid.get(key); if (!arr) grid.set(key, (arr = [])); arr.push(e);
      };
      for (let e = 0; e < this.m; e++) {
        if (this.edir[e] === 3 || this.etier[e] === 5) continue;
        const pts = this.edgeCoords(e, true);
        for (let i = 0; i < pts.length; i++) add(pts[i][0], pts[i][1], e);
        // also add interpolated points on long straight parts
        for (let i = 1; i < pts.length; i++) {
          const L = distM(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
          const k = Math.floor(L / 60);
          for (let j = 1; j <= k; j++) {
            const t = j / (k + 1);
            add(pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t, e);
          }
        }
      }
      this.grid = grid;
    }

    edgeCoords(e, forward) {
      const pts = [[this.lon[this.ea[e]], this.lat[this.ea[e]]]];
      const gm = this.egeom && this.egeom[e];
      if (gm && gm.length) {
        let x = this.lon[this.ea[e]] * 1e6, y = this.lat[this.ea[e]] * 1e6;
        for (let i = 0; i < gm.length; i += 2) { x += gm[i]; y += gm[i + 1]; pts.push([x / 1e6, y / 1e6]); }
      }
      pts.push([this.lon[this.eb[e]], this.lat[this.eb[e]]]);
      return forward === false ? pts.reverse() : pts;
    }

    // Candidate attachment points near (lon, lat): nearest point on each nearby edge, within ~40 m of the
    // closest one. Routing tries all of them, so a start next to a one-way carriageway or a busy street can
    // begin on the side street or the other carriageway when that gives a better ride.
    snapCandidates(lon, lat, maxDist = 400, slack = 40, maxN = 8) {
      const cands = [];
      const cx = Math.floor(lon / this.cell), cy = Math.floor(lat / this.cell);
      const seen = new Set();
      for (let r = 0; r <= 3; r++) {
        for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const arr = this.grid.get((cx + dx) * 100000 + (cy + dy)); if (!arr) continue;
          for (const e of arr) {
            if (seen.has(e)) continue; seen.add(e);
            cands.push(this._projectOnEdge(e, lon, lat));
          }
        }
        if (cands.length && r >= 1) break;
      }
      if (!cands.length) return [];
      cands.sort((a, b) => a.dist - b.dist);
      const nearest = cands[0].dist;
      if (nearest > maxDist) return [];
      return cands.filter((c) => c.dist <= nearest + slack).slice(0, maxN);
    }

    snap(lon, lat, maxDist = 400) {
      const SNAP_BIAS = [0, 4, 8, 14, 40, 1e9];
      let best = null, bestScore = Infinity;
      for (const c of this.snapCandidates(lon, lat, maxDist, 35)) {
        const score = c.dist + SNAP_BIAS[this.etier[c.e]];
        if (score < bestScore) { bestScore = score; best = c; }
      }
      return best;
    }

    _projectOnEdge(e, lon, lat) {
      const pts = this.edgeCoords(e, true);
      const kx = Math.cos(lat * D2R) * R * D2R, ky = R * D2R;
      let best = { dist: Infinity }, acc = 0;
      const total = this.elen[e] || 1;
      let geomLen = 0; const segL = [];
      for (let i = 1; i < pts.length; i++) { const L = distM(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]); segL.push(L); geomLen += L; }
      for (let i = 1; i < pts.length; i++) {
        const ax = pts[i - 1][0] * kx, ay = pts[i - 1][1] * ky, bx = pts[i][0] * kx, by = pts[i][1] * ky;
        const px = lon * kx, py = lat * ky;
        const vx = bx - ax, vy = by - ay; const L2 = vx * vx + vy * vy;
        let t = L2 ? ((px - ax) * vx + (py - ay) * vy) / L2 : 0; t = Math.max(0, Math.min(1, t));
        const qx = ax + vx * t, qy = ay + vy * t; const d = Math.hypot(px - qx, py - qy);
        if (d < best.dist) best = { e, dist: d, lon: qx / kx, lat: qy / ky, along: acc + segL[i - 1] * t };
        acc += segL[i - 1];
      }
      best.t = geomLen ? best.along / geomLen : 0;
      best.alongM = best.t * total;
      return best;
    }

    // ---------- A* between two snapped points ----------
    route(from, to, opts = {}) {
      const { w, hill } = opts.w ? opts : weightsFor(opts.strictness ?? 0.8, opts.avoidHills);
      const APPROACH = 1.6; // cost per metre between the clicked point and where the ride starts/ends
      const sc = from.e !== undefined ? [from] : this.snapCandidates(from[0], from[1]);
      const tc = to.e !== undefined ? [to] : this.snapCandidates(to[0], to[1]);
      if (!sc.length || !tc.length) return null;
      const n = this.n;
      const gS = this.gScore, prev = this.prevArc, closed = this.closed;
      gS.fill(Infinity); prev.fill(-1); closed.fill(0);
      const tl = tc[0].lon, tla = tc[0].lat;
      const wmin = Math.min(...w);
      const h = (i) => Math.max(0, distM(this.lon[i], this.lat[i], tl, tla) - 45) * wmin;
      // opts.penalty: optional per-edge cost multipliers (>= 1), e.g. so a loop's way back avoids the way out
      const pen = opts.penalty || null, wpen = this.winter ? this.winterPen : null;
      // opts.windFwd / windBack: per-edge slow-down riding a->b / b->a into the wind (>= 1), from windCost()
      const wf = opts.windFwd || null, wb = opts.windBack || null;
      const cost = (e, fwd, part) => {
        const L = this.elen[e] * part;
        const climb = (fwd ? this.ecf[e] : this.ecb[e]) * part;
        return L * w[this.etier[e]] * (pen ? pen[e] : 1) * (wpen ? wpen[e] : 1) * (wf ? (fwd ? wf[e] : wb[e]) : 1) + climb * hill;
      };
      const usable = (c) => this.edir[c.e] !== 3 && this.etier[c.e] !== 5;
      // virtual arcs from the start point to both ends of every candidate edge (respecting one-ways)
      const heap = new Heap(1024);
      const virtPrev = new Map(); // node -> {s, fwd}
      for (const s of sc) {
        if (!usable(s)) continue;
        const ds = this.edir[s.e], ap = s.dist * APPROACH;
        const opts2 = [];
        if (ds === 0 || ds === 1) opts2.push([this.eb[s.e], ap + cost(s.e, 1, 1 - s.t), 1]);
        if (ds === 0 || ds === 2) opts2.push([this.ea[s.e], ap + cost(s.e, 0, s.t), 0]);
        for (const [node, c, fwd] of opts2) {
          if (c < gS[node]) { gS[node] = c; prev[node] = -2; virtPrev.set(node, { s, fwd }); heap.push(c + h(node), node); }
        }
      }
      // virtual arcs from candidate edge ends to the destination
      const virtToDst = new Map(); // node -> {cost, fwd, t}
      for (const t of tc) {
        if (!usable(t)) continue;
        const dt = this.edir[t.e], ap = t.dist * APPROACH;
        const add = (node, c, fwd) => { const cur = virtToDst.get(node); if (!cur || c < cur.cost) virtToDst.set(node, { cost: c, fwd, t }); };
        if (dt === 0 || dt === 1) add(this.ea[t.e], ap + cost(t.e, 1, t.t), 1);
        if (dt === 0 || dt === 2) add(this.eb[t.e], ap + cost(t.e, 0, 1 - t.t), 0);
      }
      // same-edge shortcuts
      let direct = null;
      for (const s of sc) for (const t of tc) {
        if (s.e !== t.e || !usable(s)) continue;
        const d = this.edir[s.e], ap = (s.dist + t.dist) * APPROACH;
        if ((d === 0 || d === 1) && t.t >= s.t) { const c = ap + cost(s.e, 1, t.t - s.t); if (!direct || c < direct.cost) direct = { cost: c, fwd: 1, s, t }; }
        if ((d === 0 || d === 2) && t.t <= s.t) { const c = ap + cost(s.e, 0, s.t - t.t); if (!direct || c < direct.cost) direct = { cost: c, fwd: 0, s, t }; }
      }
      let bestDst = direct ? direct.cost : Infinity, bestLast = direct ? -3 : -1, visited = 0;
      while (heap.n) {
        const u = heap.pop();
        if (closed[u]) continue; closed[u] = 1; visited++;
        if (gS[u] >= bestDst) break;
        const vd = virtToDst.get(u);
        if (vd && gS[u] + vd.cost < bestDst) { bestDst = gS[u] + vd.cost; bestLast = u; }
        for (let k = this.off[u]; k < this.off[u + 1]; k++) {
          const e = this.arcE[k], fwd = this.arcFwd[k];
          const v = fwd ? this.eb[e] : this.ea[e];
          if (closed[v]) continue;
          const ng = gS[u] + cost(e, fwd, 1);
          if (ng < gS[v]) { gS[v] = ng; prev[v] = k; heap.push(ng + h(v), v); }
        }
      }
      if (bestDst === Infinity) return null;
      // rebuild legs: [{e, fwd, t0, t1}] (t = fraction along edge from node a)
      const legs = [];
      let s, t;
      if (bestLast === -3) {
        s = direct.s; t = direct.t;
        legs.push({ e: s.e, fwd: direct.fwd, t0: s.t, t1: t.t });
      } else {
        const vd = virtToDst.get(bestLast); t = vd.t;
        legs.push({ e: t.e, fwd: vd.fwd, t0: vd.fwd ? 0 : 1, t1: t.t });
        let v = bestLast;
        while (prev[v] >= 0) {
          const k = prev[v]; const e = this.arcE[k], fwd = this.arcFwd[k];
          legs.push({ e, fwd, t0: fwd ? 0 : 1, t1: fwd ? 1 : 0 });
          v = fwd ? this.ea[e] : this.eb[e];
        }
        const sp = virtPrev.get(v); s = sp.s;
        legs.push({ e: s.e, fwd: sp.fwd, t0: s.t, t1: sp.fwd ? 1 : 0 });
        legs.reverse();
      }
      return this._summarize(legs, { cost: bestDst, visited, from: s, to: t, weights: w });
    }

    // portion of edge geometry between fractions t0..t1 (in travel direction)
    _legCoords(leg) {
      const pts = this.edgeCoords(leg.e, true);
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + distM(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
      const L = cum[cum.length - 1] || 1;
      const at = (f) => {
        const d = f * L;
        for (let i = 1; i < pts.length; i++) if (cum[i] >= d) {
          const u = (d - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
          return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * u, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * u];
        }
        return pts[pts.length - 1];
      };
      const lo = Math.min(leg.t0, leg.t1), hi = Math.max(leg.t0, leg.t1);
      const out = [at(lo)];
      for (let i = 1; i < pts.length - 1; i++) if (cum[i] / L > lo && cum[i] / L < hi) out.push(pts[i]);
      out.push(at(hi));
      return leg.t0 <= leg.t1 ? out : out.reverse();
    }

    _summarize(legs, info) {
      const coords = [], pieces = [], byTier = [0, 0, 0, 0, 0, 0];
      const profile = []; let dist = 0, climb = 0, descent = 0;
      let cur = null;
      for (const leg of legs) {
        const part = Math.abs(leg.t1 - leg.t0);
        const L = this.elen[leg.e] * part; if (L < 0.5 && legs.length > 1) continue;
        const tier = this.etier[leg.e];
        const lc = this._legCoords(leg);
        const name = this.names[this.ename[leg.e]] || "";
        if (!cur || cur.tier !== tier) {
          cur = { tier, name, start: dist, length: 0, coords: coords.length ? [coords[coords.length - 1]] : [] };
          pieces.push(cur);
        }
        for (const p of lc) { if (!coords.length || coords[coords.length - 1][0] !== p[0] || coords[coords.length - 1][1] !== p[1]) coords.push(p); cur.coords.push(p); }
        if (!cur.names) cur.names = new Set();
        if (name) cur.names.add(name);
        byTier[tier] += L; cur.length += L;
        const up = (leg.fwd ? this.ecf[leg.e] : this.ecb[leg.e]) * part;
        const down = (leg.fwd ? this.ecb[leg.e] : this.ecf[leg.e]) * part;
        climb += up; descent += down;
        if (this.elev) {
          const a = this.elev[leg.fwd ? this.ea[leg.e] : this.eb[leg.e]], b = this.elev[leg.fwd ? this.eb[leg.e] : this.ea[leg.e]];
          if (!profile.length) profile.push([dist, a]);
          profile.push([dist + L, a + (b - a) * (leg.fwd ? leg.t1 : 1 - leg.t1)]);
        }
        dist += L;
        leg.dist0 = dist - L; leg.len = L; leg.tier = tier; leg.name = name;
      }
      for (const p of pieces) { p.names = [...p.names]; }
      // gaps = contiguous stretches with no bike infrastructure (tiers D/E)
      const gaps = [];
      for (const p of pieces) {
        if (p.tier < 3 || p.tier > 4) continue;
        const last = gaps[gaps.length - 1];
        if (last && Math.abs(last.start + last.length - p.start) < 1) { last.length += p.length; last.busy = last.busy || p.tier === 4; p.names.forEach((n) => last.names.includes(n) || last.names.push(n)); }
        else gaps.push({ start: p.start, length: p.length, busy: p.tier === 4, names: [...p.names] });
      }
      const infra = byTier[0] + byTier[1] + byTier[2];
      return {
        legs, coords, pieces, gaps, profile, byTier,
        length: dist, infraShare: dist ? infra / dist : 0,
        climb, descent, cost: info.cost, visited: info.visited,
        maneuvers: this._maneuvers(legs),
        from: info.from, to: info.to,
      };
    }

    _maneuvers(legs) {
      const out = []; let curName = null, groupStart = 0, lastBearing = null;
      for (const leg of legs) {
        if (!leg.len) continue;
        const name = leg.name || "path";
        const lc = this._legCoords(leg);
        if (lc.length < 2) continue;
        const b0 = bearing(lc[0][0], lc[0][1], lc[1][0], lc[1][1]);
        if (name !== curName) {
          let kind = "start";
          if (curName !== null && lastBearing !== null) {
            const d = ((b0 - lastBearing + 540) % 360) - 180;
            kind = Math.abs(d) < 25 ? "continue" : d > 0 ? (d > 120 ? "sharpR" : d > 50 ? "right" : "slightR") : (d < -120 ? "sharpL" : d < -50 ? "left" : "slightL");
          }
          // kind + name let the app word it in any language; text stays as the English version
          out.push({ at: leg.dist0, kind, name, text: `${TURN_EN[kind]} ${name}`, tier: leg.tier, lon: lc[0][0], lat: lc[0][1] });
          curName = name; groupStart = leg.dist0;
        }
        const n = lc.length; lastBearing = bearing(lc[n - 2][0], lc[n - 2][1], lc[n - 1][0], lc[n - 1][1]);
      }
      return out;
    }

    // Chain routes end to end (a ride through stops or waypoints) into one route object. stopLabels[i], when given,
    // names the stop between parts i and i+1 and becomes a "Stop: …" instruction; waypoints have no label.
    // Turn instructions are rebuilt across the joins.
    join(parts, stopLabels = []) {
      const out = { legs: [], coords: [], pieces: [], gaps: [], profile: [], byTier: [0, 0, 0, 0, 0, 0],
        length: 0, climb: 0, descent: 0, cost: 0, visited: 0, stops: [] };
      parts.forEach((r, i) => {
        const off = out.length;
        for (const l of r.legs) out.legs.push(Object.assign({}, l, { dist0: (l.dist0 || 0) + off }));
        for (const c of r.coords) { const last = out.coords[out.coords.length - 1]; if (!last || last[0] !== c[0] || last[1] !== c[1]) out.coords.push(c); }
        for (const p of r.pieces) {
          const prev = out.pieces[out.pieces.length - 1];
          if (prev && prev.tier === p.tier && Math.abs(prev.start + prev.length - (p.start + off)) < 1) {
            prev.length += p.length; prev.coords = prev.coords.concat(p.coords.slice(1));
            p.names.forEach((n) => prev.names.includes(n) || prev.names.push(n));
          } else out.pieces.push(Object.assign({}, p, { start: p.start + off, coords: p.coords.slice(), names: p.names.slice() }));
        }
        for (const g of r.gaps) {
          const prev = out.gaps[out.gaps.length - 1];
          if (prev && Math.abs(prev.start + prev.length - (g.start + off)) < 1) {
            prev.length += g.length; prev.busy = prev.busy || g.busy; g.names.forEach((n) => prev.names.includes(n) || prev.names.push(n));
          } else out.gaps.push(Object.assign({}, g, { start: g.start + off, names: g.names.slice() }));
        }
        for (const [d, z] of r.profile) out.profile.push([d + off, z]);
        r.byTier.forEach((m, k) => (out.byTier[k] += m));
        out.length += r.length; out.climb += r.climb; out.descent += r.descent; out.cost += r.cost; out.visited += r.visited || 0;
        const lab = stopLabels[i];
        if (i < parts.length - 1 && lab) {
          const end = r.coords[r.coords.length - 1];
          out.stops.push({ at: out.length, label: lab.label || lab, sight: !!lab.sight, lon: end[0], lat: end[1] });
        }
      });
      // at the same spot, "Stop: …" comes before the turn that leaves it
      out.maneuvers = this._maneuvers(out.legs)
        .concat(out.stops.map((s) => ({ at: s.at, kind: s.sight ? "sight" : "stop", name: s.label, text: `${s.sight ? "Sight" : "Stop"}: ${s.label}`, tier: 0, lon: s.lon, lat: s.lat, stop: true })))
        .sort((a, b) => a.at - b.at || (b.stop ? 1 : 0) - (a.stop ? 1 : 0));
      const infra = out.byTier[0] + out.byTier[1] + out.byTier[2];
      out.infraShare = out.length ? infra / out.length : 0;
      out.from = parts[0].from; out.to = parts[parts.length - 1].to;
      return out;
    }

    // Up to 3 distinct routes: most bike lanes, balanced, most direct
    alternatives(from, to, opts = {}) {
      const res = [];
      for (const key of ["bikemax", "balanced", "direct"]) {
        const p = PROFILES[key];
        const r = this.route(from, to, { w: p.w, hill: opts.avoidHills ? 12 : p.hill });
        if (!r) continue;
        const sig = new Set(r.legs.map((l) => l.e));
        const dup = res.some((o) => { let c = 0; for (const e of o.sig) if (sig.has(e)) c++; return c / Math.max(o.sig.size, sig.size) > 0.92; });
        if (!dup) res.push(Object.assign(r, { profileKey: key, profileLabel: p.label, sig }));
      }
      return res;
    }
  }

  const TURN_EN = { start: "Start on", continue: "Continue on", slightL: "Slight left onto", left: "Turn left onto", sharpL: "Sharp left onto",
    slightR: "Slight right onto", right: "Turn right onto", sharpR: "Sharp right onto" };

  // Along-route helpers for ride simulation
  function buildCursor(route) {
    const c = route.coords, cum = [0];
    for (let i = 1; i < c.length; i++) cum.push(cum[i - 1] + distM(c[i - 1][0], c[i - 1][1], c[i][0], c[i][1]));
    const total = cum[cum.length - 1];
    const scale = total ? route.length / total : 1;
    return {
      total: route.length,
      at(d) { // position and heading at distance d (metres along route)
        const g = Math.max(0, Math.min(total, d / scale));
        let lo = 0, hi = cum.length - 1;
        while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= g) lo = mid; else hi = mid; }
        const u = (g - cum[lo]) / ((cum[hi] - cum[lo]) || 1);
        const lon = c[lo][0] + (c[hi][0] - c[lo][0]) * u, lat = c[lo][1] + (c[hi][1] - c[lo][1]) * u;
        return { lon, lat, heading: bearing(c[lo][0], c[lo][1], c[hi][0], c[hi][1]) };
      },
      // side (-1 left, +1 right) and distance-along for a point near the route
      locate(lon, lat) {
        let best = { d: Infinity };
        const kx = Math.cos(lat * D2R) * R * D2R, ky = R * D2R;
        for (let i = 1; i < c.length; i++) {
          const ax = c[i - 1][0] * kx, ay = c[i - 1][1] * ky, bx = c[i][0] * kx, by = c[i][1] * ky, px = lon * kx, py = lat * ky;
          const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy;
          let t = L2 ? ((px - ax) * vx + (py - ay) * vy) / L2 : 0; t = Math.max(0, Math.min(1, t));
          const qx = ax + vx * t, qy = ay + vy * t, d = Math.hypot(px - qx, py - qy);
          if (d < best.d) best = { d, along: (cum[i - 1] + Math.sqrt(L2) * t) * scale, side: vx * (py - ay) - vy * (px - ax) > 0 ? -1 : 1 };
        }
        return best;
      },
    };
  }

  return { Router, TIERS, PROFILES, weightsFor, distM, bearing, buildCursor };
});
