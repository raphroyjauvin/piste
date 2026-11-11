// The link-preview image (prototypes/og.jpg, 1200 x 630): what Reddit, LinkedIn, iMessage and others show when someone
// shares www.pistemtl.ca. It is the live app's map with a route, the panel and buttons hidden, and a card with the name and
// the one-sentence description in English and French. The app's <meta property="og:image"> points at it.
// Usage: node C:\bikeapp\tools\shots\og.mjs [out file]   (server must be running on http://localhost:8765)
// Re-run it after a change to the map's look or to the sentence (keep the sentence the same as in a-positron/index.html).
import { chromium } from "playwright-core";

const BASE = process.env.PISTE_BASE || "http://localhost:8765/";
const APP = process.env.PISTE_APP || "a-positron/index.html";
const OUT = process.argv[2] || "C:\\bikeapp\\prototypes\\og.jpg";
const EN = "Bike routes across Montréal that stay on bike paths.";
const FR = "Des itinéraires à vélo partout à Montréal, sur les pistes cyclables.";
const CARD_W = 520;   // the card's width; the route is fitted into what is left of the 1200 px

const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
const ctx = await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await ctx.addInitScript(() => { try { localStorage.setItem("piste-welcomed", "1"); localStorage.setItem("piste-night", "off"); localStorage.setItem("umami.disabled", "1"); } catch (e) { /* storage blocked */ } });
const page = await ctx.newPage();
await page.goto(`${BASE}${APP}?trip=rachel&lang=en`, { waitUntil: "load", timeout: 60000 });
await page.waitForFunction(() => !!(window.__app && window.__app.map), null, { timeout: 60000 });
const idle = () => page.evaluate(() => new Promise((r) => { const m = window.__app.map; let done = false; const fin = () => { if (!done) { done = true; r(); } }; m.once("idle", fin); m.triggerRepaint(); setTimeout(fin, 12000); }));
await idle();

// Only the map: hide the panel and every button, then fit the route into the space right of the card
await page.addStyleTag({ content: `
  body > :not(#map):not(#og) { display: none !important; }
  .maplibregl-control-container { display: none !important; }
  #og { position: fixed; inset: 0; z-index: 99999; pointer-events: none; font-family: "Barlow", system-ui, sans-serif; color: #1c2228; }
  #og .fade { position: absolute; inset: 0; background: linear-gradient(90deg, rgba(255,255,255,.96) 0, rgba(255,255,255,.96) ${CARD_W}px, rgba(255,255,255,0) ${CARD_W + 150}px); }
  #og .card { position: absolute; left: 56px; top: 0; bottom: 0; width: ${CARD_W - 40}px; display: flex; flex-direction: column; justify-content: center; }
  #og .name { display: flex; align-items: center; gap: 22px; }
  #og .name img { width: 104px; height: 104px; }
  #og .name b { font: 800 112px/1 "Barlow", sans-serif; letter-spacing: .01em; }
  #og p { margin: 0; font: 600 37px/1.18 "Barlow", sans-serif; }
  #og .en { margin-top: 34px; }
  #og .fr { margin-top: 20px; color: #4c555e; }
  #og .metro { display: flex; width: 230px; height: 10px; border-radius: 5px; overflow: hidden; margin-top: 34px; }
  #og .metro i { flex: 1; }
  #og .url { margin-top: 22px; font: 700 30px/1 "Barlow", sans-serif; color: #1e2160; }
` });
await page.evaluate(({ EN, FR, CARD_W }) => {
  const el = document.createElement("div");
  el.id = "og";
  el.innerHTML = `<div class="fade"></div><div class="card">
    <div class="name"><img src="../icons/logo.svg" alt=""><b>Piste</b></div>
    <p class="en"></p><p class="fr"></p>
    <div class="metro"><i style="background:#00B300"></i><i style="background:#D95700"></i><i style="background:#FFD900"></i><i style="background:#0095E6"></i></div>
    <div class="url">pistemtl.ca</div></div>`;
  el.querySelector(".en").textContent = EN;
  el.querySelector(".fr").textContent = FR;
  document.body.appendChild(el);
  const app = window.__app, map = app.map;
  const sel = app.state.routes[app.state.sel || 0], line = (sel.r || sel).coords;
  const b = line.reduce((bb, c) => bb.extend(c), new maplibregl.LngLatBounds(line[0], line[0]));
  map.fitBounds(b, { padding: { left: CARD_W + 150, right: 70, top: 80, bottom: 80 }, bearing: -34, pitch: 0, animate: false });
}, { EN, FR, CARD_W });
await page.evaluate(() => document.fonts.ready);
await idle();
await page.waitForTimeout(1500);
await page.screenshot({ path: OUT, type: "jpeg", quality: 90 });
console.log(`og image: ${OUT}`);
await browser.close();
