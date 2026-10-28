// Scripted screenshots of the prototypes (drives the installed Microsoft Edge through playwright-core).
// Usage: node C:\bikeapp\tools\shots\shoot.mjs [filter]   (server must be running on http://localhost:8765)
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const BASE = "http://localhost:8765/";
const OUT = "C:\\bikeapp\\prototypes\\screens";
fs.mkdirSync(OUT, { recursive: true });

const desktop = { w: 1440, h: 900, scale: 1 };
const phone = { w: 390, h: 844, scale: 2, mobile: true };
const SHOTS = [
  { name: "0-gallery", url: "index.html", w: 1280, h: 900, scale: 1, page: true },
  { name: "A1-route", url: "a-positron/index.html?trip=montroyal", ...desktop },
  { name: "A2-birdseye", url: "a-positron/index.html?trip=montroyal", ...desktop, steps: [["eval", "window.__app.set3d(true)"], ["wait", 3000]] },
  { name: "A3-ride", url: "a-positron/index.html?trip=biodome", ...desktop, steps: [["eval", "document.querySelector('#ride-go').click(); document.querySelector('#sheet-start').click()"], ["wait", 7500]] },
  { name: "A4-explore-planned", url: "a-positron/index.html?trip=none", ...desktop, steps: [["eval", "document.querySelector('[data-layer=planned]').click(); window.__app.map.jumpTo({center:[-73.585,45.537],zoom:13.3})"], ["wait", 2500]] },
  { name: "A5-phone-ride", url: "a-positron/index.html?trip=montroyal", ...phone, steps: [["eval", "document.querySelector('#ride-go').click(); document.querySelector('#sheet-start').click()"], ["wait", 6000]] },
  { name: "B1-route", url: "b-metro-noir/index.html?trip=davidson", ...desktop },
  { name: "B2-metro-view", url: "b-metro-noir/index.html?trip=davidson", ...desktop, steps: [["eval", "window.__app.openMetro()"], ["wait", 800]] },
  { name: "B3-ride", url: "b-metro-noir/index.html?trip=montroyal", ...desktop, steps: [["eval", "window.__app.startRide()"], ["wait", 6500]] },
  { name: "C1-axo", url: "c-here-there/index.html?trip=montroyal", ...desktop, steps: [["wait", 2500]] },
  { name: "C2-ride", url: "c-here-there/index.html?trip=biodome", ...desktop, steps: [["eval", "window.__app.startRide()"], ["wait", 7000]] },
  { name: "C3-topdown", url: "c-here-there/index.html?trip=rachel", ...desktop, steps: [["eval", "window.__app.setView('top')"], ["wait", 2000]] },
  { name: "C4-phone", url: "c-here-there/index.html?trip=biodome", ...phone, steps: [["wait", 2500]] },
  { name: "C5-phone-ride", url: "c-here-there/index.html?trip=biodome", ...phone, steps: [["eval", "window.__app.startRide()"], ["wait", 7000]] },
];

const filter = process.argv[2];
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
for (const s of SHOTS) {
  if (filter && !s.name.startsWith(filter)) continue;
  const ctx = await browser.newContext({ viewport: { width: s.w, height: s.h }, deviceScaleFactor: s.scale, isMobile: !!s.mobile, hasTouch: !!s.mobile });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  const t = Date.now();
  try {
    await page.goto(BASE + s.url, { waitUntil: "load", timeout: 60000 });
    if (s.page) { await page.waitForTimeout(1500); await page.screenshot({ path: path.join(OUT, s.name + ".png"), fullPage: true }); console.log(`${s.name}: ok`); await ctx.close(); continue; }
    await page.waitForFunction(() => !!window.__app, null, { timeout: 60000 });
    await page.evaluate(() => new Promise((r) => { const m = window.__app.map; if (!m) return setTimeout(r, 500); let done = false; const fin = () => { if (!done) { done = true; r(); } }; m.once("idle", fin); setTimeout(fin, 12000); }));
    for (const [kind, arg] of s.steps || []) {
      if (kind === "eval") await page.evaluate(arg);
      if (kind === "wait") await page.waitForTimeout(arg);
    }
    await page.evaluate(() => new Promise((r) => { const m = window.__app && window.__app.map; if (!m || (window.__app.state && window.__app.state.ride)) return setTimeout(r, 300); let done = false; const fin = () => { if (!done) { done = true; r(); } }; m.once("idle", fin); m.triggerRepaint(); setTimeout(fin, 6000); }));
    await page.screenshot({ path: path.join(OUT, s.name + ".png") });
    console.log(`${s.name}: ok in ${((Date.now() - t) / 1000).toFixed(1)}s${errors.length ? " | errors: " + errors.slice(0, 3).join(" | ") : ""}`);
  } catch (e) {
    console.log(`${s.name}: FAILED ${e.message.split("\n")[0]}${errors.length ? " | errors: " + errors.slice(0, 3).join(" | ") : ""}`);
  }
  await ctx.close();
}
await browser.close();
