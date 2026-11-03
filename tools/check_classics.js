// Dev check: route every classic ride on the island graph and print length, bike-lane share and climb.
// Usage: node C:\bikeapp\tools\check_classics.js
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = path.resolve(__dirname, "..");
const { Router, PROFILES } = require(path.join(ROOT, "prototypes/shared/router.js"));
const ctx = { window: {} }; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, "prototypes/shared/data/classics.js"), "utf8"), ctx);
const r = new Router(JSON.parse(fs.readFileSync(path.join(ROOT, "data/build/graph_island.json"), "utf8")));
const w = { w: PROFILES.bikemax.w, hill: 4 };
for (const winter of [false, true]) {
  r.setWinter(winter);
  console.log(winter ? "\n-- winter (4-season network) --" : "-- summer --");
  for (const c of ctx.window.CLASSICS) {
    const pen = new Float32Array(r.m).fill(1), parts = [];
    let ok = true;
    const closes = c.pts.length > 2 && c.pts[0][0] === c.pts[c.pts.length - 1][0] && c.pts[0][1] === c.pts[c.pts.length - 1][1];
    for (let i = 1; i < c.pts.length; i++) {
      // as classicRoute() in app.js: each leg starts where the last one ended; a loop ends where it began
      const from = i > 1 ? parts[i - 2].to : c.pts[0], to = closes && i === c.pts.length - 1 ? parts[0].from : c.pts[i];
      const o = Object.assign({}, w, { penalty: pen });
      const p = r.route(from, to, o) || r.route(c.pts[i - 1], c.pts[i], o);
      if (!p) { ok = false; console.log(`${c.id}: NO ROUTE leg ${i}`); break; }
      if (c.avoidBack) for (const l of p.legs) pen[l.e] = 4;
      parts.push(p);
    }
    if (!ok) continue;
    const rt = r.join(parts, []);
    // the straight jump where one leg ends and the next begins (0 when each leg starts where the last one ended)
    const dm = (a, b) => Math.hypot((a[0] - b[0]) * 111320 * Math.cos(a[1] * Math.PI / 180), (a[1] - b[1]) * 110540);
    const jump = Math.round(Math.max(0, ...parts.slice(1).map((p, k) => dm(parts[k].coords[parts[k].coords.length - 1], p.coords[0]))));
    const snaps = c.pts.map((p) => { const s = r.snap(p[0], p[1]); return s ? Math.round(s.dist) : -1; });
    console.log(`${c.id.padEnd(13)} ${(rt.length / 1000).toFixed(1).padStart(5)} km  jump ${String(jump).padStart(3)} m  ${String(Math.round(rt.infraShare * 100)).padStart(3)}% lanes  climb ${String(Math.round(rt.climb)).padStart(4)} m  gaps>=50m ${rt.gaps.filter((g) => g.length >= 50).length}  snap m ${snaps.join(",")}`);
  }
}
