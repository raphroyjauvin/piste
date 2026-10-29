// Quick load check: opens a URL of the app in headless Edge, prints console errors and a few state values.
// Usage: node smoke.mjs "<query string>" [width] [height]
import { chromium } from "playwright-core";
const q = process.argv[2] || "", w = +(process.argv[3] || 1440), h = +(process.argv[4] || 900);
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: w, height: h } });
const errs = [];
page.on("pageerror", (e) => errs.push("pageerror: " + String(e).slice(0, 300)));
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errs.push(m.type() + ": " + m.text().slice(0, 200)); });
const t = Date.now();
await page.goto("http://localhost:8765/a-positron/index.html" + q, { waitUntil: "load", timeout: 90000 });
try { await page.waitForFunction(() => !!window.__app, null, { timeout: 60000 }); } catch (e) { errs.push("no __app after 60 s"); }
const info = await page.evaluate(() => { const a = window.__app; if (!a) return null; const s = a.state; return { nodes: a.router.n, routes: s.routes.length, tab: s.tab, smode: s.smode, mode: s.mode,
  first: s.routes[0] ? Math.round(s.routes[0].r.length) : null, bixi: s.bixi ? s.bixi.features.length : 0, lang: window.BikeI18n.lang }; });
console.log(`loaded in ${((Date.now() - t) / 1000).toFixed(1)} s`, JSON.stringify(info));
for (const e of [...new Set(errs)].slice(0, 12)) console.log(" ", e);
await browser.close();
