// Route safety checks: plan hundreds of trips across the island on the published routing graph and fail on
// unsafe or broken routes. Runs in plain Node (no browser), in about a minute. GitHub runs it before every deploy.
//
// Usage: node tools/check_routes.js            run the checks; exit code 1 if any fails
//        node tools/check_routes.js --update   also record the current routes as the new baseline
//        node tools/check_routes.js --verbose  list every warning, not just the first few
//
// What fails the check (any one is enough):
//  - Network: the bike network splits into pieces; a road named "Autoroute"/"Bretelle" is open to bikes without a
//    bike path; more one-way dead ends than the baseline (places you can ride into but not out of).
//  - Any route: no route found; a start or end snaps more than 150 m away (commutes only); a segment closed to bikes;
//    a one-way street ridden the wrong way; a break where two segments don't meet; riding the same segment twice;
//    a detour far longer than the shortest legal path (limits per route type below).
//  - Commutes and classic rides, against tools/route_baseline.json: the share on bike paths drops by more than
//    3 points, the ride gets more than 15% longer, or the longest stretch on a busy street without a bike path
//    grows by more than 300 m.
//  - Random trips, against the baseline: the average share on bike paths drops by more than 1.5 points.
// Improvements are listed but don't fail; record them with --update.
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = path.resolve(__dirname, "..");
const { Router, PROFILES, weightsFor, distM } = require(path.join(ROOT, "prototypes/shared/router.js"));
const BASELINE = path.join(__dirname, "route_baseline.json");
const UPDATE = process.argv.includes("--update"), VERBOSE = process.argv.includes("--verbose");

const ctx = { window: {} }; vm.createContext(ctx);
for (const f of ["graph_island.js", "classics.js"]) vm.runInContext(fs.readFileSync(path.join(ROOT, "prototypes/shared/data", f), "utf8"), ctx);
const G = ctx.window.GRAPH_ISLAND, CLASSICS = ctx.window.CLASSICS;
const r = new Router(G);
const t0 = Date.now();

// ---------------------------------------------------------------- route types, as the app builds them (app.js routeWeights)
const STRICT = 0.85;   // the app's default slider position
const TYPES = {
  yourRoute: { label: "Your route", opts: weightsFor(STRICT, false), winter: true, maxDetour: 1.8 },
  avoidHills: { label: "Your route, avoid hills", opts: weightsFor(STRICT, true), winter: false, maxDetour: 2.0 },
  mostLanes: { label: "Most bike paths", opts: { w: PROFILES.bikemax.w, hill: 4 }, winter: true, maxDetour: 2.0 },
  mostDirect: { label: "Most direct", opts: { w: PROFILES.direct.w, hill: 0 }, winter: false, maxDetour: 1.15 },
};
// shortest legal path: every bike-legal segment costs its length
const SHORTEST = { w: [1, 1, 1, 1, 1, Infinity], hill: 0 };

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
const detours = {}, longDetours = [], overLimit = {};
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
    for (const [key, T] of Object.entries(TYPES)) {
      if (winter && !T.winter) continue;
      const t = Date.now();
      const rt = r.route(a, b, T.opts);
      slowest = Math.max(slowest, Date.now() - t); routes++;
      const where = `${id} (${label}), ${T.label}, ${season}`;
      if (!rt) { fail(`${where}: no route`); continue; }
      checkRoute(rt, where);
      const ratio = rt.length / Math.max(short.length, 1);
      (detours[key] = detours[key] || []).push(ratio);
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
for (const [key, xs] of Object.entries(detours)) console.log(`  ${TYPES[key].label.padEnd(26)} ${q(xs, 0.5).toFixed(2)} / ${q(xs, 0.95).toFixed(2)} / ${Math.max(...xs).toFixed(2)}, limit ${TYPES[key].maxDetour}`);
const list = (title, xs) => { if (!xs.length) return; console.log(`\n${title} (${xs.length}):`); for (const x of VERBOSE ? xs : xs.slice(0, 15)) console.log("  - " + x); if (!VERBOSE && xs.length > 15) console.log(`  … ${xs.length - 15} more (--verbose lists them all)`); };
list("Notes", notes);
list("Long detours (compared with the baseline by count)", longDetours);
list("Warnings", warns);
list("FAILURES", fails);
console.log(fails.length ? `\nFAIL: ${fails.length} problem(s)` : "\nPASS");
process.exitCode = fails.length ? 1 : 0;
