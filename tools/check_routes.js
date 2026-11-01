// Route safety checks: plan hundreds of trips across the island on the published routing graph and fail on
// unsafe or broken routes. Runs in plain Node (no browser), in about 5 seconds. GitHub runs it before every deploy.
//
// Usage: node tools/check_routes.js            run the checks; exit code 1 if any fails
//        node tools/check_routes.js --update   also record the current routes as the new baseline
//        node tools/check_routes.js --verbose  list every warning, not just the first few
//
// What fails the check (any one is enough):
//  - Network: the bike network splits into pieces; a road named "Autoroute"/"Bretelle" is open to bikes without a
//    bike path; more one-way dead ends than the baseline (places you can ride into but not out of); a gap in a street
//    (two intersections under 0.3 m apart with no segment between them).
//  - The capped-routing API in prototypes/shared/router.js (relaxing steps, the limit, repeatable results) and places that
//    were fixed (Sainte-Anne-de-Bellevue village core): a failed expectation is a failure. Planning speed is measured and
//    printed; one trip taking over 1 s fails.
//  - Any route: no route found; a start or end snaps more than 150 m away (commutes only); a segment closed to bikes;
//    a one-way street ridden the wrong way; a break where two segments don't meet; riding the same segment twice;
//    a route longer than the detour cap (max(1.5 x the shortest legal path, shortest + 300 m); "Your route" and "Most
//    bike paths" are planned with Router.routeCapped, like the app does); "Most direct" has its own 1.15 limit (listed).
//  - Commutes and classic rides, against tools/route_baseline.json: the share on bike paths drops by more than
//    3 points, the ride gets more than 15% longer, or the longest stretch on a busy street without a bike path
//    grows by more than 300 m.
//  - Random trips, against the baseline: the average share on bike paths drops by more than 1.5 points.
// Improvements are listed but don't fail; record them with --update.
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = path.resolve(__dirname, "..");
const { Router, PROFILES, SHORTEST, DETOUR, U_TURN, CAPPED_KINDS, weightsFor, routeSettings, relaxSteps, distM, bearing } = require(path.join(ROOT, "prototypes/shared/router.js"));
const BASELINE = path.join(__dirname, "route_baseline.json");
const UPDATE = process.argv.includes("--update"), VERBOSE = process.argv.includes("--verbose");

const ctx = { window: {} }; vm.createContext(ctx);
for (const f of ["graph_island.js", "classics.js"]) vm.runInContext(fs.readFileSync(path.join(ROOT, "prototypes/shared/data", f), "utf8"), ctx);
const G = ctx.window.GRAPH_ISLAND, CLASSICS = ctx.window.CLASSICS;
const r = new Router(G);
const t0 = Date.now();

// ---------------------------------------------------------------- route types, planned by the same Router.planRoute as the app
// What each kind means (settings, the detour cap, the relaxing steps) lives in prototypes/shared/router.js, so the app and
// this check cannot drift apart. Detour cap (2026-10-31): "Your route" and "Most bike paths" are at most
// max(1.5 x the shortest legal path, shortest + 300 m); a route over the cap is a failure. "Most direct" has no cap:
// it keeps its own 1.15 limit.
const STRICT = 0.85;   // the app's default slider position
const TYPES = {
  yourRoute: { label: "Your route", kind: "yourRoute", settings: { strictness: STRICT }, winter: true },
  avoidHills: { label: "Your route, avoid hills", kind: "yourRoute", settings: { strictness: STRICT, avoidHills: true }, winter: false },
  mostLanes: { label: "Most bike paths", kind: "mostLanes", settings: {}, winter: true },
  mostDirect: { label: "Most direct", kind: "mostDirect", settings: {}, winter: false, maxDetour: 1.15 },
};
const isCapped = (T) => CAPPED_KINDS.includes(T.kind);
// SHORTEST (the shortest legal path: every bike-legal segment costs its length) and DETOUR come from the router

// ---------------------------------------------------------------- trips
// Real commutes and errands across the island. Expectations live in the baseline, not here.
const COMMUTES = [
  ["plateau-downtown", "Parc La Fontaine to McGill metro", [-73.5695, 45.5275], [-73.5718, 45.5040]],
  ["rosemont-oldport", "Rosemont metro to Old Port", [-73.5970, 45.5310], [-73.5525, 45.5075]],
  ["verdun-downtown", "Verdun metro to Square-Victoria", [-73.5718, 45.4593], [-73.5602, 45.5017]],
  ["villeray-mileend", "Parc Jarry to Mile End", [-73.6280, 45.5345], [-73.6000, 45.5235]],
  ["ndg-concordia", "Monkland Village to Concordia", [-73.6280, 45.4720], [-73.5790, 45.4970]],
  ["hochelaga-plateau", "Olympic Stadium to Mont-Royal metro", [-73.5515, 45.5580], [-73.5815, 45.5245]],
  ["sainthenri-mcgill", "Atwater Market to McGill campus", [-73.5768, 45.4796], [-73.5770, 45.5048]],
  ["lachine-downtown", "Lachine to Peel Basin", [-73.6700, 45.4320], [-73.5600, 45.4950]],
  ["ahuntsic-plateau", "Henri-Bourassa metro to Laurier metro", [-73.6680, 45.5555], [-73.5890, 45.5275]],
  ["outremont-udem", "Outremont to Université de Montréal", [-73.6070, 45.5170], [-73.6150, 45.5040]],
  ["nunsisland-oldmtl", "Nuns' Island to Old Montréal", [-73.5450, 45.4650], [-73.5540, 45.5080]],
  ["oldport-jeandrapeau", "Old Port to Jean-Drapeau metro", [-73.5525, 45.5075], [-73.5335, 45.5125]],
  ["pointeclaire-dorval", "Pointe-Claire village to Dorval", [-73.8160, 45.4500], [-73.7400, 45.4480]],
  ["montrealnord-stmichel", "Montréal-Nord to Saint-Michel", [-73.6300, 45.5900], [-73.6020, 45.5600]],
  ["pat-anjou", "Pointe-aux-Trembles to Anjou", [-73.5000, 45.6500], [-73.5600, 45.6050]],
  ["cdn-downtown", "Côte-des-Neiges to Peel metro", [-73.6240, 45.4960], [-73.5755, 45.5010]],
];

// Random trips between points on bike-legal segments, 1 to 15 km apart. Fixed seed, so every run plans the same trips.
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function randomTrips(n, seed) {
  const rnd = mulberry32(seed), usable = [], cum = [];
  let tot = 0;
  for (let e = 0; e < r.m; e++) if (r.etier[e] !== 5 && r.edir[e] !== 3) { tot += r.elen[e]; usable.push(e); cum.push(tot); }
  const pick = () => {
    const x = rnd() * tot; let lo = 0, hi = cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < x) lo = mid + 1; else hi = mid; }
    const c = r.edgeCoords(usable[lo], true), p = c[Math.floor(rnd() * c.length)];
    return [+p[0].toFixed(5), +p[1].toFixed(5)];
  };
  const out = [];
  while (out.length < n) {
    const a = pick(), b = pick(), d = distM(a[0], a[1], b[0], b[1]);
    if (d >= 1000 && d <= 15000) out.push([`random-${out.length + 1}`, "random trip", a, b]);
  }
  return out;
}
const RANDOM = randomTrips(200, 20261030);

// ---------------------------------------------------------------- results
const fails = [], warns = [], notes = [];
const fail = (msg) => fails.push(msg), warn = (msg) => warns.push(msg);
const km = (m) => (m / 1000).toFixed(1) + " km";
const pct = (x) => Math.round(x * 100) + "%";

// ---------------------------------------------------------------- 1. the network itself
const usableEdge = (e) => r.etier[e] !== 5 && r.edir[e] !== 3;
const network = {};
{
  // one connected piece
  const parent = Int32Array.from({ length: r.n }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let e = 0; e < r.m; e++) if (usableEdge(e)) { const a = find(r.ea[e]), b = find(r.eb[e]); if (a !== b) parent[a] = b; }
  const comp = new Map();
  for (let e = 0; e < r.m; e++) if (usableEdge(e)) { const c = find(r.ea[e]); const o = comp.get(c) || { len: 0, e }; o.len += r.elen[e]; comp.set(c, o); }
  const comps = [...comp.values()].sort((a, b) => b.len - a.len);
  network.km = Math.round(comps[0].len / 1000);
  network.pieces = comps.length;
  for (const o of comps.slice(1)) {
    const at = `${r.lon[r.ea[o.e]].toFixed(5)},${r.lat[r.ea[o.e]].toFixed(5)}`;
    (o.len > 300 ? fail : warn)(`Network: ${Math.round(o.len)} m of bike-legal segments cut off from the rest, near ${at} (${r.names[r.ename[o.e]] || "unnamed"})`);
  }
  // expressways and ramps must stay closed to bikes, unless the segment is a bike path beside them
  const hw = new Map();
  for (let e = 0; e < r.m; e++) {
    if (!usableEdge(e) || r.etier[e] <= 2) continue;
    const n = r.names[r.ename[e]] || "";
    if (/^(autoroute|bretelle)\b/i.test(n)) hw.set(n, (hw.get(n) || 0) + r.elen[e]);
  }
  for (const [n, L] of hw) fail(`Network: ${Math.round(L)} m of "${n}" is open to bikes without a bike path`);
  // one-way dead ends: nodes you can ride into but can't ride back out of to the rest of the network (or the reverse)
  const fwdAdj = Array.from({ length: r.n }, () => []), revAdj = Array.from({ length: r.n }, () => []);
  for (let e = 0; e < r.m; e++) {
    if (!usableEdge(e)) continue;
    const a = r.ea[e], b = r.eb[e], d = r.edir[e];
    if (d === 0 || d === 1) { fwdAdj[a].push(b); revAdj[b].push(a); }
    if (d === 0 || d === 2) { fwdAdj[b].push(a); revAdj[a].push(b); }
  }
  const reach = (start, adj) => { const seen = new Uint8Array(r.n), st = [start]; seen[start] = 1; while (st.length) { const u = st.pop(); for (const v of adj[u]) if (!seen[v]) { seen[v] = 1; st.push(v); } } return seen; };
  const hub = r.snap(-73.5698, 45.5171).e;   // a node downtown, in the main network
  const out = reach(r.ea[hub], fwdAdj), back = reach(r.ea[hub], revAdj);
  const trap = new Uint8Array(r.n);
  let traps = 0;
  for (let i = 0; i < r.n; i++) if (fwdAdj[i].length + revAdj[i].length && (!out[i] || !back[i])) { trap[i] = 1; traps++; }
  network.oneWayDeadEnds = traps;
  // group them into areas (joined by any bike-legal segment); a whole area cut off is a data error, a corner is not
  const inc = Array.from({ length: r.n }, () => []);
  for (let e = 0; e < r.m; e++) if (usableEdge(e)) { inc[r.ea[e]].push(e); inc[r.eb[e]].push(e); }
  const seen = new Uint8Array(r.n), areas = [];
  for (let i = 0; i < r.n; i++) {
    if (!trap[i] || seen[i]) continue;
    const a = { n: 0, names: new Set(), at: `${r.lon[i].toFixed(5)},${r.lat[i].toFixed(5)}`, kind: back[i] ? "you can't ride into" : "you can't ride out of" };
    const st = [i]; seen[i] = 1;
    while (st.length) {
      const u = st.pop(); a.n++;
      for (const e of inc[u]) { const v = r.ea[e] === u ? r.eb[e] : r.ea[e]; a.names.add(r.names[r.ename[e]] || "unnamed"); if (trap[v] && !seen[v]) { seen[v] = 1; st.push(v); } }
    }
    areas.push(a);
  }
  areas.sort((x, y) => y.n - x.n);
  network.deadEndAreas = areas.length;
  network.biggestDeadEnd = areas.length ? areas[0].n : 0;
  for (const a of areas) {
    const msg = `Network: ${a.n} intersections ${a.kind} because of one-way segments, near ${a.at} (${[...a.names].slice(0, 4).join(", ")})`;
    if (a.n > 50) fail(msg); else if (a.n >= 10) warn(msg);
  }
  // Gaps in a street: two intersections less than 0.3 m apart with no segment between them are one junction the build
  // failed to join (a sliver of a split street was dropped, 2026-10-31: it cut off Sainte-Anne-de-Bellevue's village core).
  const cell = 0.00001, hash = new Map();   // ~1 m cells
  for (let i = 0; i < r.n; i++) { const k = Math.floor(r.lon[i] / cell) + "," + Math.floor(r.lat[i] / cell); (hash.get(k) || hash.set(k, []).get(k)).push(i); }
  const joined = new Set();
  for (let e = 0; e < r.m; e++) joined.add(Math.min(r.ea[e], r.eb[e]) * 1e6 + Math.max(r.ea[e], r.eb[e]));
  let gaps = 0;
  for (let i = 0; i < r.n; i++) {
    const ci = Math.floor(r.lon[i] / cell), cj = Math.floor(r.lat[i] / cell);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const j of hash.get((ci + di) + "," + (cj + dj)) || []) {
      if (j <= i || distM(r.lon[i], r.lat[i], r.lon[j], r.lat[j]) >= 0.3 || joined.has(i * 1e6 + j)) continue;
      gaps++;
      if (gaps <= 5) fail(`Network: gap in the street at ${r.lon[i].toFixed(6)},${r.lat[i].toFixed(6)}: two intersections under 0.3 m apart with no segment between them (see the sliver step in tools/build_graph.py)`);
    }
  }
  network.gaps = gaps;
  if (gaps > 5) fail(`Network: ${gaps} gaps in the street in all`);
}

// ---------------------------------------------------------------- 2. every route
const startNode = (l) => (l.t0 === 0 ? r.ea[l.e] : l.t0 === 1 ? r.eb[l.e] : -1);
const endNode = (l) => (l.t1 === 1 ? r.eb[l.e] : l.t1 === 0 ? r.ea[l.e] : -1);
function checkRoute(rt, where) {
  const bad = [];
  const seen = new Map();
  rt.legs.forEach((l, i) => {
    const d = r.edir[l.e], name = r.names[r.ename[l.e]] || "unnamed";
    if (r.etier[l.e] === 5 || d === 3) bad.push(`uses ${name}, closed to bikes`);
    if ((l.fwd && d === 2) || (!l.fwd && d === 1)) bad.push(`rides ${name} the wrong way (one-way)`);
    if (i > 0) { const a = endNode(rt.legs[i - 1]), b = startNode(l); if (a < 0 || b < 0 || a !== b) bad.push(`breaks between ${r.names[r.ename[rt.legs[i - 1].e]] || "unnamed"} and ${name}`); }
    // a 0 m step (the route ends right at a corner) doesn't count as riding a segment
    if (r.elen[l.e] * Math.abs(l.t1 - l.t0) >= 1) seen.set(l.e, (seen.get(l.e) || 0) + 1);
  });
  for (const [e, c] of seen) if (c > 1) {
    // starting and ending on the same segment can need a loop around the block; anything else is a U-turn
    const name = r.names[r.ename[e]] || "unnamed";
    if (rt.legs[0].e === e && rt.legs[rt.legs.length - 1].e === e && c === 2) warn(`${where}: starts and ends on ${name}, looping around the block`);
    else bad.push(`rides ${name} twice`);
  }
  for (const b of bad) fail(`${where}: ${b}`);
  return bad.length === 0;
}
const longestBusy = (rt) => Math.round(Math.max(0, ...rt.gaps.filter((g) => g.busy).map((g) => g.length)));
const summary = (rt) => ({ km: +(rt.length / 1000).toFixed(2), bikePaths: Math.round(rt.infraShare * 1000) / 10, climb: Math.round(rt.climb), busy: longestBusy(rt) });

const results = {};   // id -> { "type|season": summary }
let routes = 0, slowest = 0;
const detours = {}, longDetours = [], overLimit = {}, capStats = {}, capped = [];
function planTrip([id, label, a, b], isCommute) {
  results[id] = {};
  if (isCommute) for (const [p, which] of [[a, "start"], [b, "end"]]) {
    const s = r.snap(p[0], p[1]);
    if (!s || s.dist > 150) fail(`${id} (${label}): the ${which} is ${s ? Math.round(s.dist) + " m" : "over 400 m"} from the nearest bike-legal segment`);
  }
  for (const winter of [false, true]) {
    r.setWinter(winter);
    const season = winter ? "winter" : "summer";
    const short = r.route(a, b, SHORTEST);
    if (!short) { fail(`${id} (${label}), ${season}: no route at all`); continue; }
    // the limit the app uses; the rule is restated here from the short route on purpose, as a check on detourLimit()
    const limit = r.detourLimit(a, b), spec = Math.max(DETOUR.factor * short.length, short.length + DETOUR.floor);
    if (Math.abs(limit - spec) > 1e-6) fail(`${id} (${label}), ${season}: detourLimit() gives ${Math.round(limit)} m, the rule says ${Math.round(spec)} m`);
    for (const [key, T] of Object.entries(TYPES)) {
      if (winter && !T.winter) continue;
      const t = Date.now();
      const rt = r.planRoute(a, b, T.kind, T.settings, limit);
      slowest = Math.max(slowest, Date.now() - t); routes++;
      const where = `${id} (${label}), ${T.label}, ${season}`;
      if (!rt) { fail(`${where}: no route`); continue; }
      checkRoute(rt, where);
      const ratio = rt.length / Math.max(short.length, 1);
      (detours[key] = detours[key] || []).push(ratio);
      if (isCapped(T)) {
        const cs = capStats[key] = capStats[key] || { n: 0, relaxed: 0 };
        cs.n++;
        if (rt.steps) { cs.relaxed++; capped.push({ where, steps: rt.steps, km: rt.length / 1000, share: rt.infraShare }); }
        if (rt.length > limit) fail(`${where}: ${km(rt.length)} is over the detour cap of ${km(limit)} (shortest legal path ${km(short.length)}); even the "Most direct" settings don't fit`);
        results[id][`${key}|${season}`] = summary(rt);
        continue;
      }
      // long detours are listed, and their number is compared with the baseline (some are the price of staying on bike paths)
      if (ratio > T.maxDetour && rt.length - short.length > 300) {
        longDetours.push(`${where}: ${km(rt.length)} at ${pct(rt.infraShare)} on bike paths, ${ratio.toFixed(2)} times the shortest legal path (${km(short.length)}, ${pct(short.infraShare)})`);
        if (id.startsWith("random-")) overLimit[`${key}|${season}`] = (overLimit[`${key}|${season}`] || 0) + 1;
      }
      results[id][`${key}|${season}`] = summary(rt);
    }
  }
  r.setWinter(false);
}
for (const t of COMMUTES) planTrip(t, true);
for (const t of RANDOM) planTrip(t, false);

// ---------------------------------------------------------------- 2b. the capped-routing API (prototypes/shared/router.js)
{
  const expect = (ok, msg) => { if (!ok) fail(`Router API: ${msg}`); };
  const sameW = (x, y) => !!x && !!y && x.hill === y.hill && x.w.length === y.w.length && x.w.every((v, i) => v === y.w[i]);
  const direct = routeSettings("mostDirect", {}), directHills = routeSettings("mostDirect", { avoidHills: true });
  // relaxSteps: the strictness drops 0.15 a step, then the "Most direct" settings, then null
  const st = relaxSteps("yourRoute", { strictness: 0.85 });
  [0.7, 0.55, 0.4, 0.25, 0.1].forEach((x, i) => expect(sameW(st(i + 1), weightsFor(x, false)), `your route, step ${i + 1} is not strictness ${x}`));
  expect(sameW(st(6), direct), "your route, step 6 is not the Most direct settings");
  expect(st(7) === null, "your route has a step 7");
  expect(JSON.stringify(st(3)) === JSON.stringify(st(3)), "relaxSteps is not repeatable");
  expect(relaxSteps("yourRoute", { strictness: 0 })(1) === null, "strictness 0 should have no relaxing steps (it is already direct)");
  const sh = relaxSteps("yourRoute", { strictness: 0.85, avoidHills: true });
  expect([1, 2, 3, 4, 5, 6].every((i) => sh(i).hill === 12), "avoid hills not kept through the steps");
  expect(sameW(sh(6), directHills), "avoid hills, the last step is not Most direct with hills avoided");
  const wind = { windFwd: new Float32Array(1), windBack: new Float32Array(1) };
  const sw = relaxSteps("yourRoute", { strictness: 0.85, wind });
  expect([1, 2, 3, 4, 5].every((i) => sw(i).windFwd === wind.windFwd && sw(i).windBack === wind.windBack), "wind not kept through the steps");
  const sm = relaxSteps("mostLanes", {});
  expect(sameW(sm(1), Object.assign(weightsFor(0.85, false), { hill: 4 })) && sm(8) === null && sameW(sm(7), direct), "most bike paths steps are wrong (0.85 first, hill 4, direct at step 7, none after)");
  expect(!("limit" in (r.planRoute(...COMMUTES[0].slice(2), "mostDirect") || {})), "Most direct must not be capped");
  // the limit: 1.5 x for long trips, shortest + 300 m for short ones
  const near = [[-73.5698, 45.5171], [-73.5698, 45.5190]], [, , farA, farB] = COMMUTES.find((c) => c[0] === "lachine-downtown");
  const sNear = r.route(near[0], near[1], SHORTEST).length, sFar = r.route(farA, farB, SHORTEST).length;
  expect(sNear < 600 && Math.abs(r.detourLimit(near[0], near[1]) - (sNear + DETOUR.floor)) < 1e-6, "a short trip's limit is not shortest + 300 m");
  expect(sFar > 3000 && Math.abs(r.detourLimit(farA, farB) - sFar * DETOUR.factor) < 1e-6, "a long trip's limit is not 1.5 x the shortest");
  // routeCapped: a route that fits is returned as planned; when nothing fits, the last step (Most direct) is returned
  const o = routeSettings("yourRoute", { strictness: STRICT }), relax = relaxSteps("yourRoute", { strictness: STRICT });
  const plain = r.route(farA, farB, o), fits = r.routeCapped(farA, farB, o, relax, Infinity), none = r.routeCapped(farA, farB, o, relax, 0);
  expect(fits.steps === 0 && JSON.stringify(fits.legs) === JSON.stringify(plain.legs), "a route under the limit should come back unchanged");
  expect(none.steps === 6 && Math.abs(none.length - r.route(farA, farB, direct).length) < 1e-6, "when no step fits, the Most direct route should come back");
  expect(r.routeCapped(farA, farB, o, null, 0).steps === 0, "no steps given: the first route comes back");
  // repeatable: the same trip planned twice gives the same legs
  let same = true;
  for (const [, , a, b] of COMMUTES.slice(0, 6)) for (const k of Object.values(TYPES)) {
    const x = r.planRoute(a, b, k.kind, k.settings), y = r.planRoute(a, b, k.kind, k.settings);
    if (JSON.stringify(x.legs) !== JSON.stringify(y.legs) || x.steps !== y.steps) same = false;
  }
  expect(same, "planning the same trip twice gave different routes");
  // a limit passed in or not gives the same route
  const [, , ca, cb] = COMMUTES[5];
  expect(JSON.stringify(r.planRoute(ca, cb, "mostLanes", {}).legs) === JSON.stringify(r.planRoute(ca, cb, "mostLanes", {}, r.detourLimit(ca, cb)).legs), "planRoute differs with and without the limit passed");
}

// ---------------------------------------------------------------- 2b2. heading-aware start (2026-11-01)
// Router.route opts.heading: a GPS reroute that knows which way the rider faces. Starting by turning back costs U_TURN.metres
// (200 m) of riding extra. The scenario is found in the graph: a straight two-way street, the start at its middle (a point, not a
// snapped edge), and destinations whose shortest route starts toward end a. Facing b, the route must start toward b when that is under
// 200 m longer, and still start toward a when turning round saves more. Facing a, or with no heading, nothing changes.
// A router that ignores the heading fails the first expectation.
{
  const expect = (ok, msg) => { if (!ok) fail(`Router heading: ${msg}`); };
  const straight = (e) => !(r.egeom && r.egeom[e] && r.egeom[e].length);
  const legsOf = (rt) => JSON.stringify(rt.legs.map((l) => [l.e, l.fwd, l.t0, l.t1]));
  const towardB = (rt) => rt.legs[0].fwd === 1;   // the first leg rides the start street toward its end b (else toward a)
  let close = null, far = null;
  for (let e = 0; e < r.m && !(close && far); e++) {
    if (r.edir[e] !== 0 || r.etier[e] > 3 || !straight(e) || r.elen[e] < 200 || r.elen[e] > 500) continue;
    const a = [r.lon[r.ea[e]], r.lat[r.ea[e]]], b = [r.lon[r.eb[e]], r.lat[r.eb[e]]], mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (r.snapCandidates(mid[0], mid[1]).length !== 1) continue;   // only this street near the start, so the start is unambiguous
    const toA = bearing(b[0], b[1], a[0], a[1]), toB = bearing(a[0], a[1], b[0], b[1]);
    const dests = [];
    for (let n = 0; n < r.n; n++) { const d = distM(mid[0], mid[1], r.lon[n], r.lat[n]); if (d >= 150 && d <= 600) dests.push([r.lon[n], r.lat[n]]); }
    const step = Math.max(1, Math.ceil(dests.length / 40));
    for (let i = 0; i < dests.length && !(close && far); i += step) {
      const dest = dests[i], none = r.route(mid, dest, SHORTEST);
      if (!none || towardB(none)) continue;
      const facingB = r.route(mid, dest, Object.assign({ heading: toB }, SHORTEST));
      if (!facingB) continue;
      if (towardB(facingB)) { if (!close && facingB.length > none.length + 1) close = { mid, dest, toA, toB, none, facingB }; }
      else if (!far) far = { mid, dest, toA, toB, none, facingB };
    }
  }
  expect(close && far, `no test case found in the graph (${close ? "" : "start where turning round costs under 200 m"}${close || far ? "" : "; "}${far ? "" : "start where turning round is clearly shorter"})`);
  if (close) {
    const { mid, dest, toA, toB, none, facingB } = close;
    expect(facingB.length < none.length + U_TURN.metres, `facing b the route is ${Math.round(facingB.length - none.length)} m longer, over the ${U_TURN.metres} m a U-turn is worth`);
    expect(legsOf(r.route(mid, dest, Object.assign({ heading: toA }, SHORTEST))) === legsOf(none), "facing the way of the shortest route changed that route");
    expect(legsOf(r.route(mid, dest, Object.assign({ heading: undefined }, SHORTEST))) === legsOf(none), "no heading changed the route");
    expect(legsOf(r.route(mid, dest, Object.assign({ heading: NaN }, SHORTEST))) === legsOf(none), "a heading of NaN changed the route");
    const snapped = r.snapCandidates(mid[0], mid[1])[0];
    expect(legsOf(r.route(snapped, dest, Object.assign({ heading: toB }, SHORTEST))) === legsOf(r.route(snapped, dest, SHORTEST)), "a start that is already snapped should ignore the heading");
    // the app's way in: planRoute with settings.heading; the detour cap is then worked out from the shortest route that does not turn back
    const planned = r.planRoute(mid, dest, "yourRoute", { strictness: STRICT, heading: toB });
    expect(planned && Math.abs(planned.limit - r.detourLimit(mid, dest, toB)) < 1e-6, "planRoute with a heading did not use the heading-aware detour limit");
  }
  if (far) expect(!towardB(far.facingB), "facing b, the route still starts toward a when turning round saves over 200 m");
}

// ---------------------------------------------------------------- 2c. places that were fixed: they must stay fixed
// Sainte-Anne-de-Bellevue village core (2026-10-31). Rue Sainte-Anne is two-way in the City's data (Géobase ID_TRC 1619225,
// SENS_CIR 0; bike network ID_CYCL 24971 and 26431, NBR_VOIE 2) but the graph had an 8 cm gap in it, so the core could be
// left by Rue du Collège and not entered. Rue du Collège north of Sainte-Anne is a real one-way (Géobase 1619224, SENS_CIR 1,
// no bike facility in the bike network): it must stay one-way.
{
  const west = [-73.9556, 45.40448], east = [-73.9505, 45.4033], collegeNorth = [-73.95266, 45.40587], corner = [-73.95353, 45.40425];
  for (const [label, a, b] of [["west to east", west, east], ["east to west", east, west]]) {
    const rt = r.planRoute(a, b, "yourRoute", { strictness: STRICT });
    if (!rt) fail(`Sainte-Anne-de-Bellevue ${label}: no route`);
    else if (rt.length > 500) fail(`Sainte-Anne-de-Bellevue ${label}: ${Math.round(rt.length)} m, expected about 400 m along Rue Sainte-Anne (the core was cut off)`);
  }
  const back = r.planRoute(collegeNorth, corner, "yourRoute", { strictness: STRICT });
  if (back && back.legs.some((l) => r.names[r.ename[l.e]] === "Rue du Collège")) fail("Sainte-Anne-de-Bellevue: a route rides Rue du Collège southbound, against its one-way");
}

// ---------------------------------------------------------------- 2d. planning speed, measured (what the app does for one trip)
const speed = {};
{
  const trips = [...COMMUTES, ...RANDOM], kinds = [TYPES.yourRoute, TYPES.mostLanes, TYPES.mostDirect];   // what computeRoutes plans
  const plain = (a, b) => { for (const T of kinds) r.route(a, b, routeSettings(T.kind, T.settings)); };
  const capped = (a, b) => { const lim = r.detourLimit(a, b); for (const T of kinds) r.planRoute(a, b, T.kind, T.settings, lim); };
  const time = (fn, list = trips) => list.map(([, , a, b]) => { const t = process.hrtime.bigint(); fn(a, b); return Number(process.hrtime.bigint() - t) / 1e6; });
  time(plain, trips.slice(0, 30)); time(capped, trips.slice(0, 30));   // warm up the JIT
  const calls = { n: 0 }, orig = r.route.bind(r);
  r.route = (...args) => { calls.n++; return orig(...args); };
  const timesCapped = time(capped); const callsCapped = calls.n; calls.n = 0;
  const timesPlain = time(plain); const callsPlain = calls.n;
  r.route = orig;
  Object.assign(speed, { plain: timesPlain, capped: timesCapped, callsPlain: callsPlain / trips.length, callsCapped: callsCapped / trips.length, trips: trips.length });
  if (Math.max(...timesCapped) > 1000) fail(`Planning speed: one trip took ${Math.round(Math.max(...timesCapped))} ms with the detour cap (limit 1000 ms)`);
}

// the 10 classic rides, built exactly like the app's classicRoute(): most bike paths, the way back avoiding the way out
for (const c of CLASSICS) {
  results["classic-" + c.id] = {};
  for (const winter of [false, true]) {
    r.setWinter(winter);
    const season = winter ? "winter" : "summer", where = `classic ${c.id}, ${season}`;
    const pen = new Float32Array(r.m).fill(1), parts = [];
    let ok = true;
    for (let k = 1; k < c.pts.length; k++) {
      const p = r.route(c.pts[k - 1], c.pts[k], { w: PROFILES.bikemax.w, hill: 4, penalty: pen });
      routes++;
      if (!p) { fail(`${where}: no route for leg ${k}`); ok = false; break; }
      checkRoute(p, `${where}, leg ${k}`);
      if (c.avoidBack) for (const l of p.legs) pen[l.e] = 4;
      parts.push(p);
    }
    if (ok) results["classic-" + c.id][`classic|${season}`] = summary(r.join(parts, []));
  }
  r.setWinter(false);
}

// ---------------------------------------------------------------- 3. against the baseline
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
const randomShare = {};
for (const key of ["yourRoute|summer", "mostLanes|summer", "yourRoute|winter"]) {
  randomShare[key] = Math.round(mean(RANDOM.map(([id]) => results[id][key]).filter(Boolean).map((s) => s.bikePaths)) * 10) / 10;
}
const current = { network: { km: network.km, oneWayDeadEnds: network.oneWayDeadEnds, biggestDeadEnd: network.biggestDeadEnd }, randomShare, randomLongDetours: overLimit, routes: {} };
for (const [id, v] of Object.entries(results)) if (!id.startsWith("random-")) current.routes[id] = v;

let base = null;
try { base = JSON.parse(fs.readFileSync(BASELINE, "utf8")); } catch (e) { notes.push("No baseline yet: run with --update to record one."); }
if (base) {
  if (current.network.oneWayDeadEnds > base.network.oneWayDeadEnds)
    fail(`Network: ${current.network.oneWayDeadEnds} intersections cut off by one-way segments, up from ${base.network.oneWayDeadEnds} (listed under warnings with --verbose)`);
  for (const [key, n] of Object.entries(overLimit)) {
    const was = (base.randomLongDetours || {})[key] || 0;
    if (n > was + 2) fail(`Random trips, ${key.replace("|", ", ")}: ${n} long detours, up from ${was}`);
  }
  for (const [key, v] of Object.entries(randomShare)) {
    const was = base.randomShare[key];
    if (was === undefined) continue;
    if (v < was - 1.5) fail(`Random trips, ${key.replace("|", ", ")}: ${v}% on bike paths on average, down from ${was}%`);
    else if (v > was + 1.5) notes.push(`Random trips, ${key.replace("|", ", ")}: ${v}% on bike paths on average, up from ${was}%`);
  }
  for (const [id, v] of Object.entries(current.routes)) for (const [key, s] of Object.entries(v)) {
    const b = base.routes[id] && base.routes[id][key];
    const where = `${id}, ${key.replace("|", ", ")}`;
    if (!b) { notes.push(`${where}: new, not in the baseline yet`); continue; }
    if (s.bikePaths < b.bikePaths - 3) fail(`${where}: ${s.bikePaths}% on bike paths, down from ${b.bikePaths}%`);
    if (s.km > b.km * 1.15) fail(`${where}: ${s.km} km, up from ${b.km} km`);
    if (s.busy > b.busy + 300) fail(`${where}: longest busy street without a bike path is ${s.busy} m, up from ${b.busy} m`);
    if (s.bikePaths > b.bikePaths + 3 || s.km < b.km * 0.85 || s.busy < b.busy - 300)
      notes.push(`${where}: better than the baseline (${s.bikePaths}% bike paths, ${s.km} km, busy ${s.busy} m; was ${b.bikePaths}%, ${b.km} km, ${b.busy} m)`);
  }
}
if (UPDATE) {
  current.recorded = new Date().toISOString().slice(0, 10);
  current.graphBuilt = G.meta.built;
  fs.writeFileSync(BASELINE, JSON.stringify(current, null, 1) + "\n");
  notes.push(`Baseline recorded in ${path.relative(ROOT, BASELINE)}`);
}

// ---------------------------------------------------------------- report
const secs = ((Date.now() - t0) / 1000).toFixed(0);
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
console.log(`Route safety checks: ${COMMUTES.length} commutes, ${RANDOM.length} random trips, ${CLASSICS.length} classic rides; ${routes} routes in ${secs} s (slowest ${slowest} ms)`);
console.log(`Network: ${network.km} km in ${network.pieces} piece(s); one-way dead ends: ${network.oneWayDeadEnds}${base ? ` (baseline ${base.network.oneWayDeadEnds})` : ""}`);
console.log(`Random trips on bike paths (average): your route ${randomShare["yourRoute|summer"]}%, most bike paths ${randomShare["mostLanes|summer"]}%, winter ${randomShare["yourRoute|winter"]}%`);
console.log("Detour vs the shortest legal path (median / 95th percentile / max, limit):");
for (const [key, xs] of Object.entries(detours)) console.log(`  ${TYPES[key].label.padEnd(26)} ${q(xs, 0.5).toFixed(2)} / ${q(xs, 0.95).toFixed(2)} / ${Math.max(...xs).toFixed(2)}, ${isCapped(TYPES[key]) ? `capped at max(${DETOUR.factor}x, +${DETOUR.floor} m)` : `limit ${TYPES[key].maxDetour}`}`);
for (const [key, cs] of Object.entries(capStats)) console.log(`  ${TYPES[key].label.padEnd(26)} cap made ${cs.relaxed} of ${cs.n} routes less strict`);
console.log(`Planning one trip (the 3 route types, ${speed.trips} trips, ms, median / 95th / max): without the cap ${[0.5, 0.95, 1].map((p) => q(speed.plain, p).toFixed(1)).join(" / ")} (${speed.callsPlain.toFixed(1)} searches); with the cap ${[0.5, 0.95, 1].map((p) => q(speed.capped, p).toFixed(1)).join(" / ")} (${speed.callsCapped.toFixed(1)} searches)`);
const list = (title, xs) => { if (!xs.length) return; console.log(`\n${title} (${xs.length}):`); for (const x of VERBOSE ? xs : xs.slice(0, 15)) console.log("  - " + x); if (!VERBOSE && xs.length > 15) console.log(`  … ${xs.length - 15} more (--verbose lists them all)`); };
list("Notes", notes);
list("Long detours (compared with the baseline by count)", longDetours);
list("Warnings", warns);
list("FAILURES", fails);
console.log(fails.length ? `\nFAIL: ${fails.length} problem(s)` : "\nPASS");
process.exitCode = fails.length ? 1 : 0;
