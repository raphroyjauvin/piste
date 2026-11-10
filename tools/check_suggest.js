// Ride-suggestion quality check: plans loops and one-way rides from several starts and lengths on the published graph and
// reports, per suggestion, the length error, the share of its length ridden on a street already ridden (either way) and the U-turns.
// Plain Node, no browser. Usage: node tools/check_suggest.js [--suggest <file>]   (another suggest.js, to compare: e.g. a copy of an older one)
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = path.resolve(__dirname, "..");

function load(suggestFile = "prototypes/shared/suggest.js") {
  const ctx = { window: {}, setTimeout, console }; ctx.self = ctx.window; vm.createContext(ctx);
  const run = (f) => vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx);
  run("prototypes/shared/data/graph_island.js"); run("prototypes/shared/data/pois.js");
  ctx.window.BikeRouter = require(path.join(ROOT, "prototypes/shared/router.js"));
  run(suggestFile);
  const R = ctx.window.BikeRouter;
  return { router: new R.Router(ctx.window.GRAPH_ISLAND), pois: ctx.window.POIS, R, S: ctx.window.BikeSuggest };
}

// share of the ride on an edge already ridden earlier in the ride (either direction)
function reuseShare(route) {
  const seen = new Set(); let dup = 0;
  for (const l of route.legs) { if (seen.has(l.e)) dup += l.len || 0; else seen.add(l.e); }
  return route.length ? dup / route.length : 0;
}
const STARTS = {
  "Mont-Royal east (Pierre-De Coubertin)": [-73.5495, 45.5640],
  "Plateau": [-73.5795, 45.5235],
  "Rosemont": [-73.5810, 45.5460],
  "Verdun": [-73.5710, 45.4590],
  "NDG": [-73.6200, 45.4730],
  "Ahuntsic": [-73.6600, 45.5450],
  "Hochelaga": [-73.5330, 45.5430],
  "Lachine": [-73.6700, 45.4430],
};
const CASES = [{ km: 8, loop: true }, { km: 15, loop: true }, { km: 25, loop: true }, { km: 10, loop: false }, { km: 20, loop: false }, { km: 10, loop: true, stop: "cafe" }];

// 2026-11-09: when the rides leave (opening hours decide which places exist), fixed so the report never depends on the clock: Monday 14:30 local,
// or another hour with --at HH:MM
const AT = process.argv.indexOf("--at"), [LH, LM] = (AT > 0 ? process.argv[AT + 1] : "14:30").split(":").map(Number);
const LEAVE = new Date(2026, 10, 9, LH, LM);

async function measure(env, start, c) {
  const { router, pois, R, S } = env;
  const sg = new S.Suggester(router, pois), t0 = process.hrtime.bigint();
  const picks = await sg.suggest({ start, km: c.km, loop: c.loop, stop: c.stop || "", weights: R.weightsFor(0.8, false), now: LEAVE });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, picks: picks.map((p) => ({ errM: Math.round(p.route.length - c.km * 1000), reuse: reuseShare(p.route), u: (env.judge || S).turnbacks(router, p.route), km: p.route.length / 1000 })) };
}

async function main() {
  const i = process.argv.indexOf("--suggest"), env = load(i > 0 ? process.argv[i + 1] : undefined), rows = [];
  if (i > 0) env.judge = load().S;   // U-turns are always counted by the current code, whichever suggester made the rides
  for (const [name, start] of Object.entries(STARTS)) for (const c of CASES) {
    const m = await measure(env, start, c);
    rows.push({ name, c, ...m });
  }
  const kind = (c) => (c.stop ? "stop" : c.loop ? "loop" : "one-way");
  for (const r of rows) console.log(`${r.name.padEnd(40)} ${String(r.c.km).padStart(3)} km ${kind(r.c).padEnd(7)} ${Math.round(r.ms)} ms  ` + r.picks.map((p) => `[${p.errM >= 0 ? "+" : ""}${p.errM} m, reuse ${(p.reuse * 100).toFixed(0)}%, U ${p.u}]`).join(" "));
  const all = rows.flatMap((r) => r.picks), mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  console.log(`
${all.length} suggestions (${rows.length} queries): U-turns ${all.reduce((n, p) => n + p.u, 0)} (rides with one: ${all.filter((p) => p.u).length}), reuse mean ${(100 * mean(all.map((p) => p.reuse))).toFixed(1)}% worst ${(100 * Math.max(...all.map((p) => p.reuse))).toFixed(0)}%`);
  for (const k of ["loop", "one-way", "stop"]) {
    const rs = rows.filter((r) => kind(r.c) === k), ps = rs.flatMap((r) => r.picks), within = ps.filter((p) => Math.abs(p.errM) <= 500).length;
    console.log(`  ${k.padEnd(7)} within +-500 m: ${within}/${ps.length}, mean |error| ${Math.round(mean(ps.map((p) => Math.abs(p.errM))))} m, best-of-query within: ${rs.filter((r) => r.picks.some((p) => Math.abs(p.errM) <= 500)).length}/${rs.length} queries, ms mean ${Math.round(mean(rs.map((r) => r.ms)))} max ${Math.round(Math.max(...rs.map((r) => r.ms)))}`);
  }
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { load, reuseShare, measure, STARTS };
