// Functional smoke tests for the prototypes, in headless Edge. Usage: node C:\bikeapp\tools\shots\test.mjs
import { chromium } from "playwright-core";

const BASE = "http://localhost:8765/";
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
const results = [];
async function run(name, url, fn, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|404/.test(m.text())) errors.push(m.text()); });
  const t = Date.now();
  try {
    await page.goto(BASE + url, { waitUntil: "load", timeout: 60000 });
    await page.waitForFunction(() => !!window.__app, null, { timeout: 60000 });
    const out = await fn(page);
    results.push({ name, ok: errors.length === 0 && out.ok !== false, secs: ((Date.now() - t) / 1000).toFixed(1), ...out, errors });
  } catch (e) {
    results.push({ name, ok: false, error: e.message.split("\n")[0], errors });
  }
  await ctx.close();
}

await run("A: search, slider, layers, ride", "a-positron/index.html?trip=montroyal", async (page) => {
  return await page.evaluate(async () => {
    const app = window.__app; const g = BikeCommon.makeGeocoder(app.router);
    const inter = await g.search("Rachel & Papineau");
    const addr = await g.search("4500 rue Saint-Denis");
    const place = await g.search("Parc La Fontaine");
    const el = document.querySelector("#strict");
    el.value = 0; el.dispatchEvent(new Event("input"));
    const low = app.state.routes.map((r) => [r.label, Math.round(r.r.length), Math.round(r.r.infraShare * 100)]);
    el.value = 100; el.dispatchEvent(new Event("input"));
    const high = app.state.routes.map((r) => [r.label, Math.round(r.r.length), Math.round(r.r.infraShare * 100)]);
    // planned layer must stay hidden while a route is shown
    document.querySelector("[data-layer=planned]").click();
    const plannedVisibleWithRoute = app.map.getLayoutProperty("planned", "visibility");
    document.querySelector("[data-layer=planned]").click();
    document.querySelector("#ride-go").click(); document.querySelector("#sheet-start").click();
    await new Promise((r) => setTimeout(r, 4000));
    const d1 = app.state.ride ? app.state.ride.d : -1;
    await new Promise((r) => setTimeout(r, 1500));
    const d2 = app.state.ride ? app.state.ride.d : -1;
    return { ok: inter.length > 0 && addr.length > 0 && d2 > d1 && plannedVisibleWithRoute === "none",
      intersection: inter[0] && inter[0].label, address: addr[0] && addr[0].label + " (" + addr[0].sub + ")", place: place[0] && place[0].label,
      sliderLow: low, sliderHigh: high, plannedVisibleWithRoute, rideAdvanced: [Math.round(d1), Math.round(d2)] };
  });
});

await run("A: phone layout", "a-positron/index.html?trip=rachel", async (page) => {
  return await page.evaluate(() => ({ ok: document.documentElement.scrollWidth <= innerWidth, scrollW: document.documentElement.scrollWidth, innerW: innerWidth }));
}, { width: 390, height: 844 });

await run("B: lines, metro view, ride", "b-metro-noir/index.html?trip=biodome", async (page) => {
  return await page.evaluate(async () => {
    const app = window.__app;
    const lines = [...document.querySelectorAll(".line-card b")].map((b) => b.textContent);
    app.openMetro(); const metroSvg = document.querySelector("#metro-svg svg") ? document.querySelectorAll("#metro-svg text").length : 0;
    document.querySelector("#metro-close").click();
    app.startRide(); await new Promise((r) => setTimeout(r, 5000));
    const rails = document.querySelectorAll(".rail .item").length;
    return { ok: lines.length > 0 && metroSvg > 3, lines, metroLabels: metroSvg, railItems: rails, next: document.querySelector("#next-text").textContent };
  });
});

await run("C: build, bend, view, ride", "c-here-there/index.html?trip=davidson", async (page) => {
  return await page.evaluate(async () => {
    const app = window.__app;
    const bend = document.querySelector("#bend"); bend.value = 80; bend.dispatchEvent(new Event("input"));
    const u = app.U.uBend.value;
    app.setView("top"); await new Promise((r) => setTimeout(r, 900)); const topElev = Math.round(app.view.elev);
    app.setView("axo"); await new Promise((r) => setTimeout(r, 900));
    app.startRide(); await new Promise((r) => setTimeout(r, 4000));
    return { ok: u > 0.7 && topElev > 85 && app.state.ride && app.state.ride.d > 0, uBend: u, topElev, rideD: Math.round(app.state.ride.d), turn: document.querySelector("#turn-text").textContent };
  });
});

await browser.close();
for (const r of results) console.log(JSON.stringify(r));
