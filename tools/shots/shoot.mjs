// Scripted screenshots of the app (drives the installed Microsoft Edge through playwright-core).
// Usage: node C:\bikeapp\tools\shots\shoot.mjs [filter]   (server must be running on http://localhost:8765)
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

// PISTE_BASE points at another copy (e.g. the live site); PISTE_SHOTS writes the images somewhere else
const BASE = process.env.PISTE_BASE || "http://localhost:8765/";
const OUT = process.env.PISTE_SHOTS || "C:\\bikeapp\\prototypes\\screens";
fs.mkdirSync(OUT, { recursive: true });

const desktop = { w: 1440, h: 900, scale: 1 };
const phone = { w: 402, h: 874, scale: 2, mobile: true };   // iPhone 17 / 17 Pro size in CSS pixels
const APP = "a-positron/index.html";
const SHOTS = [
  { name: "P0-phone-preview", url: "phone.html", w: 1440, h: 980, scale: 1, page: true, wait: 14000 },
  { name: "A1-route", url: `${APP}?trip=montroyal`, ...desktop },
  { name: "A2-birdseye", url: `${APP}?trip=montroyal`, ...desktop, steps: [["eval", "window.__app.set3d(true)"], ["wait", 3500]] },
  { name: "A3-elevation", url: `${APP}`, ...desktop, steps: [["eval", "window.__app.map.jumpTo({center:[-73.582,45.516],zoom:14.1})"], ["wait", 2500]] },
  { name: "A3b-contours-on-climbs", url: `${APP}`, ...desktop, steps: [["eval", "window.__app.map.jumpTo({center:[-73.5800,45.5200],zoom:15.6})"], ["wait", 2500]] },
  { name: "A4-climb-route", url: `${APP}?trip=rachel`, ...desktop, steps: [["wait", 1500]] },
  { name: "A5-ride-hill-ahead", url: `${APP}?trip=rachel&ride=bird&at=650&paused`, ...desktop, steps: [["wait", 4000]] },
  { name: "A6-ride-climbing", url: `${APP}?trip=rachel&ride=bird&at=1500&paused`, ...desktop, steps: [["wait", 4000]] },
  { name: "A7-ride-topdown", url: `${APP}?trip=biodome&ride=top&at=600&paused`, ...desktop, steps: [["wait", 3000]] },
  { name: "A8-explore-planned", url: `${APP}`, ...desktop, steps: [["eval", "document.querySelector('[data-layer=planned]').click(); window.__app.map.jumpTo({center:[-73.585,45.537],zoom:13.3})"], ["wait", 2500]] },
  { name: "A9-suggest-loop", url: `${APP}?trip=montroyal&suggest=loop&km=10&stop=cafe`, ...desktop, steps: [["wait", 2000]] },
  { name: "A10-classics", url: `${APP}?classic=lachine`, ...desktop, steps: [["wait", 2500]] },
  { name: "A11-winter", url: `${APP}?trip=montroyal&winter=1`, ...desktop, steps: [["wait", 3500]] },
  { name: "A12-wind-rain", url: `${APP}?trip=rachel&wx=1`, ...desktop, steps: [["wait", 4500]] },
  { name: "A13-french", url: `${APP}?trip=montroyal&lang=fr`, ...desktop, steps: [["wait", 1500]] },
  { name: "A14-bixi-live", url: `${APP}`, ...desktop, steps: [["wait", 3000], ["eval", "window.__app.map.jumpTo({center:[-73.5800,45.5230],zoom:16.2})"], ["wait", 3000]] },
  { name: "P1-phone-route", url: `${APP}?trip=rachel&safe=62,34`, ...phone, steps: [["wait", 1500]] },
  { name: "P2-phone-ride", url: `${APP}?trip=rachel&ride=bird&at=650&paused&safe=62,34`, ...phone, steps: [["wait", 4000]] },
  { name: "P3-phone-suggest", url: `${APP}?trip=montroyal&suggest=loop&km=10&safe=62,34`, ...phone, steps: [["wait", 2000]] },
  { name: "P4-phone-classics", url: `${APP}?classic=oldport&safe=62,34`, ...phone, steps: [["wait", 2500]] },
  { name: "P5-phone-winter-fr", url: `${APP}?trip=montroyal&winter=1&lang=fr&safe=62,34`, ...phone, steps: [["wait", 3500]] },
  { name: "P6-phone-search", url: `${APP}?trip=rachel&safe=62,34`, ...phone, steps: [["eval", "document.querySelector('#to').focus()"], ["wait", 600],
    ["eval", "(() => { const i = document.querySelector('#to'); i.value = 'marché jean'; i.dispatchEvent(new Event('input', { bubbles: true })); })()"], ["wait", 1500]] },
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
    if (s.page) { await page.waitForTimeout(s.wait || 1500); await page.screenshot({ path: path.join(OUT, s.name + ".png"), fullPage: true }); console.log(`${s.name}: ok`); await ctx.close(); continue; }
    await page.waitForFunction(() => !!window.__app, null, { timeout: 60000 });
    await page.evaluate(() => new Promise((r) => { const m = window.__app.map; if (!m) return setTimeout(r, 500); let done = false; const fin = () => { if (!done) { done = true; r(); } }; m.once("idle", fin); setTimeout(fin, 12000); }));
    for (const [kind, arg] of s.steps || []) {
      if (kind === "eval") await page.evaluate(arg);
      if (kind === "wait") await page.waitForTimeout(arg);
    }
    // wait for tiles; a running (unpaused) ride never goes idle, so cap the wait
    await page.evaluate(() => new Promise((r) => { const m = window.__app && window.__app.map; if (!m) return setTimeout(r, 300); let done = false; const fin = () => { if (!done) { done = true; r(); } }; m.once("idle", fin); m.triggerRepaint(); setTimeout(fin, 6000); }));
    await page.screenshot({ path: path.join(OUT, s.name + ".png") });
    console.log(`${s.name}: ok in ${((Date.now() - t) / 1000).toFixed(1)}s${errors.length ? " | errors: " + errors.slice(0, 3).join(" | ") : ""}`);
  } catch (e) {
    console.log(`${s.name}: FAILED ${e.message.split("\n")[0]}${errors.length ? " | errors: " + errors.slice(0, 3).join(" | ") : ""}`);
  }
  await ctx.close();
}
await browser.close();
