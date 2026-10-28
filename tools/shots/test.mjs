// Functional smoke tests for the app, in headless Edge. Usage: node C:\bikeapp\tools\shots\test.mjs
import { chromium } from "playwright-core";

const BASE = "http://localhost:8765/";
const APP = "a-positron/index.html";
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
const idle = "new Promise((r) => { const m = window.__app.map; let d = false; const f = () => { if (!d) { d = true; r(); } }; m.once('idle', f); m.triggerRepaint(); setTimeout(f, 10000); })";

await run("search, slider, layers, ride", `${APP}?trip=montroyal`, async (page) => {
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

await run("elevation layers, legend, LiDAR terrain", `${APP}?trip=montroyal`, async (page) => {
  await page.evaluate(idle);
  return await page.evaluate(async (idleSrc) => {
    const app = window.__app, m = app.map;
    const visible = ["tint", "relief", "contours-index", "contours-minor", "contour-labels"].map((id) => [id, m.getLayoutProperty(id, "visibility") || "visible"]);
    const order = m.getStyle().layers.map((l) => l.id);
    const tintUnderParks = order.indexOf("park") < order.indexOf("tint") && order.indexOf("tint") < order.indexOf("water") && order.indexOf("water") < order.indexOf("relief");
    const ramp = getComputedStyle(document.querySelector("#elev-ramp")).backgroundImage.startsWith("linear-gradient");
    document.querySelector('[data-layer="tint"]').click();
    const tintOff = m.getLayoutProperty("tint", "visibility");
    document.querySelector('[data-layer="tint"]').click();
    app.set3d(true); await eval(idleSrc);
    const local = performance.getEntriesByType("resource").filter((e) => e.name.includes("/shared/terrain/")).length;
    const ex = m.terrain ? m.terrain.exaggeration : null;
    const elevSummit = m.terrain ? Math.round(m.terrain.getElevationForLngLatZoom(new maplibregl.LngLat(-73.5873, 45.5065), 14) / ex) : null;
    return { ok: visible.every((v) => v[1] === "visible") && tintUnderParks && ramp && tintOff === "none" && local > 0 && ex === app.CAM.terrain && elevSummit > 150,
      visible, tintUnderParks, legendRamp: ramp, tintToggleOff: tintOff, localTerrainTiles: local, exaggeration: ex, mountRoyalSummitM: elevSummit };
  }, idle);
});

await run("climbs: chevrons, profile, hill-ahead in 3D ride", `${APP}?trip=rachel`, async (page) => {
  await page.evaluate(idle);
  return await page.evaluate(async (idleSrc) => {
    const app = window.__app, m = app.map, sel = app.state.routes[0];
    const climbs = sel.climbs.map((c) => `${Math.round(c.start)}+${Math.round(c.length)}m +${Math.round(c.rise)}m`);
    const chevrons = m.queryRenderedFeatures({ layers: ["climb-chev"] }).length;
    const profileClimb = !!document.querySelector(".profile clipPath") && /climb/.test(document.querySelector(".climb-note").textContent);
    const big = sel.climbs.slice().sort((a, b) => b.rise - a.rise)[0];
    const inClimb = (d) => sel.climbs.some((c) => d >= c.start - 60 && d < c.start + c.length + 60);
    let before = big.start - 250; while (before > 0 && inClimb(before)) before -= 20;
    document.querySelector('input[name="opt-view"][value="birdseye"]').checked = true;
    app.startRide(); app.pauseRide(true);
    const at = (d) => { app.state.snap = true; app.state.ride.seek(d); };
    at(0);
    const flat = { ex: +m.terrain.exaggeration.toFixed(2), pitch: Math.round(m.getPitch()), card: document.querySelector("#hill-card").hidden ? "hidden" : document.querySelector("#hill-title").textContent };
    at(Math.max(0, before));
    const ahead = { ex: +m.terrain.exaggeration.toFixed(2), pitch: Math.round(m.getPitch()), card: document.querySelector("#hill-title").textContent, sub: document.querySelector("#hill-sub").textContent };
    at(big.start + big.length / 2);
    const on = { card: document.querySelector("#hill-title").textContent, sub: document.querySelector("#hill-sub").textContent };
    at(big.start + big.length + 20);
    const top = document.querySelector("#hill-title").textContent;
    const pad = m.getPadding(), H = m.getContainer().clientHeight;
    const riderAt = +(((pad.top + H - pad.bottom) / 2) / H).toFixed(2);
    return { ok: climbs.length > 0 && chevrons > 0 && profileClimb && ahead.ex > flat.ex + 0.5 && /Climb in/.test(ahead.card) && /Climbing/.test(on.card) && /Top/.test(top) && flat.pitch === 70 && riderAt === 0.7,
      climbs, chevronsRendered: chevrons, profileShowsClimbs: profileClimb, flat, ahead, on, top, riderAt };
  }, idle);
});

await run("phone layout", `${APP}?trip=rachel&safe=62,34`, async (page) => {
  return await page.evaluate(() => {
    const turnTop = (() => { const h = document.querySelector("#ride-hud"); h.hidden = false; const t = document.querySelector(".turn-card").getBoundingClientRect().top; h.hidden = true; return Math.round(t); })();
    return { ok: document.documentElement.scrollWidth <= innerWidth && turnTop >= 62, scrollW: document.documentElement.scrollWidth, innerW: innerWidth, turnCardTop: turnTop };
  });
}, { width: 402, height: 874 });

await browser.close();
let failed = 0;
for (const r of results) { console.log(JSON.stringify(r)); if (!r.ok) failed++; }
console.log(failed ? `${failed} test(s) FAILED` : "all tests passed");
process.exitCode = failed ? 1 : 0;
