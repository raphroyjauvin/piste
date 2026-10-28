// Benchmark the in-browser router in Node on the test trips.
// Usage: node C:\bikeapp\tools\bench_routing.js [graph json path]
const fs = require("fs");
const path = require("path");
const { Router, weightsFor, PROFILES } = require(path.join(__dirname, "..", "prototypes", "shared", "router.js"));

const graphPath = process.argv[2] || path.join(__dirname, "..", "data", "build", "graph_study.json");
const trips = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "prototypes", "shared", "trips.json"), "utf8"));

let t = performance.now();
const g = JSON.parse(fs.readFileSync(graphPath, "utf8"));
const tParse = performance.now() - t;
t = performance.now();
const router = new Router(g);
const tBuild = performance.now() - t;
console.log(`graph: ${router.n} nodes, ${router.m} edges | parse ${tParse.toFixed(0)} ms, index ${tBuild.toFixed(0)} ms`);

const pct = (x) => (100 * x).toFixed(0) + "%";
const km = (m) => (m / 1000).toFixed(2) + " km";
const results = [];
for (const trip of trips) {
  console.log(`\n=== ${trip.name}  (${trip.from.label} -> ${trip.to.label})`);
  for (const key of ["direct", "balanced", "bikemax"]) {
    const p = PROFILES[key];
    // warm + time 20 runs
    let r = null; const N = 20; t = performance.now();
    for (let i = 0; i < N; i++) r = router.route(trip.from.lonlat, trip.to.lonlat, { w: p.w, hill: p.hill });
    const ms = (performance.now() - t) / N;
    if (!r) { console.log(`  ${key}: NO ROUTE`); continue; }
    const gaps = r.gaps.map((gp) => `${Math.round(gp.length)} m ${gp.busy ? "busy" : "quiet"} (${gp.names.slice(0, 2).join(", ") || "unnamed"})`);
    console.log(`  ${p.label.padEnd(16)} ${km(r.length).padStart(9)} | bike infra ${pct(r.infraShare).padStart(4)} | A ${Math.round(r.byTier[0])} B ${Math.round(r.byTier[1])} C ${Math.round(r.byTier[2])} D ${Math.round(r.byTier[3])} E ${Math.round(r.byTier[4])} m | climb ${r.climb.toFixed(0)} m | ${ms.toFixed(2)} ms, ${r.visited} nodes`);
    if (gaps.length) console.log(`      gaps: ${gaps.join("; ")}`);
    console.log(`      via: ${[...new Set(r.maneuvers.map((m) => m.text.replace(/^(Start on|Continue on|Turn left onto|Turn right onto|Slight left onto|Slight right onto|Sharp left onto|Sharp right onto) /, "")))].slice(0, 9).join(" > ")}`);
    results.push({ trip: trip.id, profile: key, length_m: Math.round(r.length), infra_share: +r.infraShare.toFixed(3),
      by_tier_m: r.byTier.map(Math.round), climb_m: Math.round(r.climb), gaps: r.gaps.map((gp) => ({ m: Math.round(gp.length), busy: gp.busy, names: gp.names })),
      ms: +ms.toFixed(2), coords: r.coords.map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)]) });
  }
}
fs.writeFileSync(path.join(__dirname, "..", "data", "build", "bench_ours.json"), JSON.stringify(results));
console.log("\nwrote data/build/bench_ours.json");
