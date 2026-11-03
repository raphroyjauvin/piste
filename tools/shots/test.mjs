// Functional tests for the app, in a headless Chromium-based browser. Usage: node tools/shots/test.mjs [name filter]
// Exit code 0 only if every group passed (and at least one ran); 1 otherwise. Environment variables (all optional):
//   PISTE_BASE=https://www.pistemtl.ca/              test the live site instead of the dev server (http://localhost:8765/);
//                                                    with PISTE_APP=index.html, since the published site has the app at its root
//   PISTE_APP=index.html                             the app's path under PISTE_BASE (default a-positron/index.html, the dev layout)
//   PISTE_BROWSER=msedge|chrome|chromium             msedge (default): the Edge installed on this PC. chrome: an installed Google Chrome
//                                                    (preinstalled on GitHub's ubuntu-latest). chromium: Playwright's own build
//                                                    (npx playwright-core install chromium).
//   PISTE_BROWSER_ARGS="--flag --flag"               extra Chromium switches (e.g. --use-angle=swiftshader forces software WebGL)
//   PISTE_FIXTURES=1                                 answer the weather, radar, BIXI and address-search requests from the saved copies in
//                                                    tools/shots/fixtures (see the README there) instead of the live services, so results
//                                                    do not depend on today's weather or on those servers being up. CI sets this.
//   PISTE_OFFLINE=1                                  also cut off the basemap (tiles.openfreemap.org), the terrain beyond our own tiles (s3.amazonaws.com)
//                                                    and Google Fonts: the app falls back to its blank offline style. The suite passes either way
//                                                    (checked 2026-10-30); use this if those servers ever make CI flaky.
//   PISTE_FLAT_RIDE=1|0                              the long GPS-ride groups ride with the flat top-down camera instead of the 3D bird's-eye one.
//                                                    Default: yes when WebGL is software (SwiftShader), because the 3D view then draws about 1 to 2
//                                                    frames a second and the smoothness checks mean nothing; no on a PC with a GPU.
//   PISTE_CPU_SLOWDOWN=4                             slow each page's CPU 4x (Chrome DevTools throttling) to try a slow machine
//   PISTE_SHOT_DIR=<folder>                          the phone ride-summary group also saves a 390x844 screenshot there
//   PISTE_NET_REPORT=1                               print, per group, which outside hosts the page called (to spot a new live dependency)
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";

const BASE = process.env.PISTE_BASE || "http://localhost:8765/";
const APP = process.env.PISTE_APP || "a-positron/index.html";   // PISTE_APP=index.html: a site built by tools/build_site.py (the app at the root)
const only = process.argv[2];
const on = (v) => /^(1|true|yes|on)$/i.test(v || "");
const BROWSER = (process.env.PISTE_BROWSER || "msedge").toLowerCase();
const FIX = on(process.env.PISTE_FIXTURES);
const SLOWDOWN = +process.env.PISTE_CPU_SLOWDOWN || 1;
const NET_REPORT = on(process.env.PISTE_NET_REPORT);
const OFFLINE = on(process.env.PISTE_OFFLINE);
let FLAT_RIDE = false;   // set below, once we know what kind of WebGL this browser has
const GROUP_LIMIT_MS = 5 * 60e3;   // no group may run longer than this (a hung page would otherwise hold a CI job for hours)
const T0 = Date.now();

// Software WebGL (SwiftShader) is what a CI machine without a GPU has; MapLibre needs WebGL either way.
const launch = { headless: true, args: ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", ...(process.env.PISTE_BROWSER_ARGS || "").split(/\s+/).filter(Boolean)] };
if (BROWSER !== "chromium") launch.channel = BROWSER;   // chromium = no channel = Playwright's own download
const browser = await chromium.launch(launch);
console.log(`browser: ${BROWSER} ${browser.version()} | fixtures: ${FIX ? "on" : "off (live data)"} | basemap: ${OFFLINE ? "cut off" : "live"} | cpu slowdown: ${SLOWDOWN}x | base: ${BASE}`);
// Fail at once, with a clear message, if this browser cannot do WebGL (otherwise every group waits 90 s for a map that never starts)
{
  const p = await browser.newPage();
  const gl = await p.evaluate(() => { const c = document.createElement("canvas").getContext("webgl2") || document.createElement("canvas").getContext("webgl");
    if (!c) return null; const x = c.getExtension("WEBGL_debug_renderer_info"); return x ? c.getParameter(x.UNMASKED_RENDERER_WEBGL) : "WebGL (renderer hidden)"; });
  await p.close();
  FLAT_RIDE = process.env.PISTE_FLAT_RIDE ? on(process.env.PISTE_FLAT_RIDE) : /swiftshader|llvmpipe|software/i.test(gl || "");
  console.log(`webgl: ${gl || "NOT AVAILABLE"} | long GPS-ride groups: ${FLAT_RIDE ? "flat top-down camera" : "3D bird's-eye camera"}`);
  if (!gl) { console.log("FAILED: this browser has no WebGL, so the map cannot start. Try PISTE_BROWSER_ARGS=\"--use-angle=swiftshader\" or another PISTE_BROWSER."); await browser.close(); process.exit(1); }
}

// ---- saved copies of the outside data (tools/shots/fixtures), used only when PISTE_FIXTURES=1 ----
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const CORS = { "access-control-allow-origin": "*" };
const STUBBED = new Set(["api.open-meteo.com", "geo.weather.gc.ca", "gbfs.velobixi.com", "api.montreal.ca"]);   // hosts stubOutsideData answers
const FIX_BIXI_STATIONS = FIX ? JSON.parse(fixture("bixi-station_information.json")).data.stations.length : 0;
async function stubOutsideData(ctx) {
  const json = (body) => ({ status: 200, contentType: "application/json", headers: CORS, body });
  const preflight = (route) => route.request().method() === "OPTIONS" && route.fulfill({ status: 204, headers: { ...CORS, "access-control-allow-headers": "*" } });
  // Open-Meteo forecast (weather.js): wind, rain, snow and temperature
  await ctx.route("https://api.open-meteo.com/**", (route) => preflight(route) || route.fulfill(json(fixture("open-meteo.json"))));
  // Environment Canada radar (weather.js): every tile is the same empty (transparent) picture
  await ctx.route("https://geo.weather.gc.ca/**", (route) => preflight(route) || route.fulfill({ status: 200, contentType: "image/png", headers: CORS, body: fixture("radar-tile-empty.png") }));
  // BIXI GBFS (bixi.js): station_information.json and station_status.json
  await ctx.route("https://gbfs.velobixi.com/**", (route) => {
    if (preflight(route)) return;
    const f = /\/(station_information|station_status)\.json/.exec(route.request().url());
    return f ? route.fulfill(json(fixture(`bixi-${f[1]}.json`))) : route.fulfill({ status: 404, headers: CORS, body: "no fixture" });
  });
  // City of Montréal address search (common.js geocoder): answers by the typed text; anything not saved finds nothing
  const addresses = JSON.parse(fixture("montreal-addresses.json"));
  await ctx.route("https://api.montreal.ca/**", (route) => {
    if (preflight(route)) return;
    const q = (new URL(route.request().url()).searchParams.get("q") || "").trim().toLowerCase().normalize("NFC");
    if (!addresses[q]) console.log(`      (no saved address result for "${q}": answered with an empty list)`);
    return route.fulfill(json(JSON.stringify(addresses[q] || { items: [] })));
  });
}

const results = [];
function say(r) {
  const why = r.error || (r.errors && r.errors.length ? "console/page error: " + r.errors[0].slice(0, 200) : "a check was false (see the JSON line)");
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}  (${r.secs} s)${r.ok ? "" : "  " + why}`);
}
// ctxOpts: extra browser-context options (touch, location permission and position for the GPS tests); fn gets (page, ctx).
// Every group starts with the first-visit welcome card already seen, unless ctxOpts has fresh: true (a first visit).
async function run(name, url, fn, viewport = { width: 1440, height: 900 }, ctxOpts = {}) {
  if (only && !name.includes(only)) return;
  console.log(`...   ${name}`);
  const t = Date.now(), errors = [], hosts = new Set();
  let ctx, timer;
  const secs = () => ((Date.now() - t) / 1000).toFixed(1);
  const { fresh, night, ...opts } = ctxOpts;
  try {
    ctx = await browser.newContext({ viewport, serviceWorkers: "block", ...opts });   // a service worker would serve stale files (the offline group allows it)
    if (!fresh) await ctx.addInitScript(() => { try { localStorage.setItem("piste-welcomed", "1"); } catch (e) { /* storage blocked */ } });
    await ctx.addInitScript(() => { try { localStorage.setItem("umami.disabled", "1"); } catch (e) { /* storage blocked */ } });   // tests never count as visits
    if (!ctxOpts.night) await ctx.addInitScript(() => { try { localStorage.setItem("piste-night", "off"); } catch (e) { /* storage blocked */ } });   // Auto would turn the map dark when the tests run at night
    if (FIX) await stubOutsideData(ctx);
    if (OFFLINE) await ctx.route(/^https:\/\/(tiles\.openfreemap\.org|s3\.amazonaws\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//, (route) => route.abort());
    // window.__flatRide(): called by the GPS-ride groups right after a ride starts; switches to the flat camera when FLAT_RIDE is on
    await ctx.addInitScript((flat) => { window.__flatRide = () => { const a = window.__app; if (flat && a && a.state.ride && a.state.rideView === "birdseye") document.querySelector("#ride-view").click(); }; }, FLAT_RIDE);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error" && !/favicon|404|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    if (NET_REPORT) page.on("request", (r) => { const u = new URL(r.url()); if (/^https?:$/.test(u.protocol) && u.host !== new URL(BASE).host) hosts.add(u.host); });
    if (SLOWDOWN > 1) await (await ctx.newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: SLOWDOWN });
    const body = (async () => {
      await page.goto(BASE + url, { waitUntil: "load", timeout: 90000 });
      await page.waitForFunction(() => !!window.__app, null, { timeout: 90000 });
      return fn(page, ctx);
    })();
    const limit = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`group still running after ${GROUP_LIMIT_MS / 1000} s, stopped`)), GROUP_LIMIT_MS); });
    const out = await Promise.race([body, limit]);
    results.push({ name, ok: errors.length === 0 && out.ok !== false, secs: secs(), ...out, errors });
  } catch (e) {
    results.push({ name, ok: false, secs: secs(), error: e.message.split("\n")[0], errors });
  }
  clearTimeout(timer);
  if (NET_REPORT) console.log(`      outside hosts: ${[...hosts].sort().map((h) => (FIX && STUBBED.has(h) ? h + " (saved copy)" : h)).join(", ") || "none"}`);
  say(results.at(-1));
  try { await ctx.close(); } catch (e) { /* the page may already be gone */ }
}
// Wait for the map to be idle (all tiles drawn). MapLibre fires 'idle' only once per burst of work, so if the map had already gone idle before
// we started waiting, the event never comes (the old code then sat out its whole time limit); so a map that has been loaded and still for 0.5 s
// counts too. The limit was 10 s on a PC with a GPU; software WebGL on a CI machine needs longer, so it is 40 s.
const idle = "new Promise((r) => { const m = window.__app.map, t0 = performance.now(); let d = false; const f = () => { if (!d) { d = true; r(); } };" +
  " m.once('idle', f); m.triggerRepaint();" +
  " const poll = () => { if (d) return; if (performance.now() - t0 > 40000 || (performance.now() - t0 > 500 && m.loaded() && !m.isMoving())) f(); else setTimeout(poll, 100); }; poll(); })";
const wait = (ms) => `new Promise((r) => setTimeout(r, ${ms}))`;
// Wait (up to ms) until fn(arg) is true in the page. It never throws: the group then judges whatever state it reached, so a thing that
// never happens still fails the check, but a slow machine gets the time it needs instead of a fixed pause.
const until = (page, fn, arg, ms = 15000) => page.waitForFunction(fn, arg, { timeout: ms }).catch(() => {});
// Read a layout measurement after it has stopped moving (two equal readings 100 ms apart, up to 10 s), for panels that slide into place.
// the card's height slides (a CSS transition): wait for it to end before measuring, as a slow machine is still mid-slide after 400 ms
const panelStill = (page) => page.evaluate(() => Promise.all(document.querySelector("#panel").getAnimations().map((a) => a.finished.catch(() => {}))));
async function settled(page, fn) {
  let prev, same = 0;
  for (let i = 0; i < 100 && same < 2; i++) { const v = JSON.stringify(await page.evaluate(fn)); same = v === prev ? same + 1 : 0; prev = v; if (same < 2) await page.waitForTimeout(100); }
  return JSON.parse(prev);
}

await run("search, slider, island routing, ride starts at once", `${APP}?trip=montroyal`, async (page) => page.evaluate(async () => {
  const app = window.__app; const g = BikeCommon.makeGeocoder(app.router);
  const inter = await g.search("Rachel & Papineau"), addr = await g.search("4500 rue Saint-Denis"), place = await g.search("Parc La Fontaine");
  const el = document.querySelector("#strict");
  el.value = 0; el.dispatchEvent(new Event("input")); const low = app.state.routes.map((r) => [Math.round(r.r.length), Math.round(r.r.infraShare * 100)]);
  el.value = 100; el.dispatchEvent(new Event("input")); const high = app.state.routes.map((r) => [Math.round(r.r.length), Math.round(r.r.infraShare * 100)]);
  // island-wide: Atwater Market to Parc René-Lévesque in Lachine (outside the old study area)
  const far = app.router.route([-73.5768, 45.4796], [-73.6837, 45.4290], { w: BikeRouter.PROFILES.bikemax.w, hill: 4 });
  document.querySelector("#ride-go").click();
  await new Promise((r) => setTimeout(r, 2500)); const d1 = app.state.ride ? app.state.ride.d : -1;
  for (const t0 = performance.now(); app.state.ride && app.state.ride.d <= d1 && performance.now() - t0 < 15000;) await new Promise((r) => setTimeout(r, 100));   // slow machines draw few frames
  const d2 = app.state.ride ? app.state.ride.d : -1;
  return { ok: inter.length > 0 && addr.length > 0 && !!far && far.length > 9000 && d2 > d1 && d1 >= 0 && !document.querySelector("#sheet"),
    nodes: app.router.n, intersection: inter[0] && inter[0].label, address: addr[0] && addr[0].label, place: place[0] && place[0].label,
    sliderLow: low, sliderHigh: high, lachineKm: far && +(far.length / 1000).toFixed(1), rideAdvanced: [Math.round(d1), Math.round(d2)] };
}));

await run("UI clean-up: no test trips, labels, layers panel, 2D/3D button, gaps >= 50 m", `${APP}?trip=montroyal`, async (page) => {
  const before = await page.evaluate(() => ({
    tripChips: !!document.querySelector("#trip-chips"), exploreNote: !!document.querySelector("#explore-note"),
    avoidHills: document.querySelector("#hills").parentElement.textContent.trim(),
    relief: document.querySelector('[data-layer="relief"]').parentElement.textContent.trim(),
    works: document.querySelector('[data-layer="works"]').parentElement.textContent.trim(),
    metroToggle: !!document.querySelector('[data-layer="metro"]'), parksToggle: !!document.querySelector('[data-layer="pois-out"]'),
    buildingsInMap: document.querySelector('[data-layer="buildings"]').closest(".layers").querySelectorAll("h3").length === 2,
    label2d: document.querySelector("#view-label").textContent,
    gapsOk: window.__app.state.routes.every((c) => [...document.querySelectorAll(".gap-item")].length === BikeCommon.mainGaps(window.__app.state.routes[window.__app.state.sel].r).length),
    chevLayer: !!window.__app.map.getLayer("climb-chev"),
    gapBoxes: !!window.__app.map.getLayer("gap-labels"),
    stopRadius: window.__app.map.getPaintProperty("stops", "circle-radius"),
    popTransition: (() => { const d = document.createElement("div"); d.className = "poi-pop"; document.body.appendChild(d); const v = getComputedStyle(d).transitionDuration; d.remove(); return v; })(),
    rideText: document.querySelector("#ride-go") && document.querySelector("#ride-go").textContent,
    previewLink: !!document.querySelector("#ride-preview"),   // desktop: "Let's ride!" is the preview, so no separate link
    windOnlyInSuggest: document.querySelector("#avoid-wind").closest(".toggle").classList.contains("custom-only") && !document.querySelector("#avoid-wind").closest(".toggle").getClientRects().length,   // 2026-11-03: a chip in the Avoid row, custom rides only
    routedGone: !document.querySelector(".routed-in") && !/Routed on this device/.test(document.body.innerText),   // 2026-10-31: the timing line under the route cards is gone
  }));
  const noFloatingCopy = await page.evaluate(() => !document.querySelector("#ride-fab"));
  await page.click("#layers-btn");
  const opened = await page.evaluate(() => !document.querySelector("#layers").hidden);
  await page.mouse.click(700, 500);
  const closed = await page.evaluate(() => document.querySelector("#layers").hidden);
  const fromAfterTap = await page.evaluate(() => window.__app.state.to && window.__app.state.to.join(","));
  await page.click("#view-btn"); await page.waitForTimeout(1200);
  const label3d = await page.evaluate(() => document.querySelector("#view-label").textContent);
  const ok = !before.gapBoxes && before.stopRadius === 7.5 && /^0s/.test(before.popTransition) && before.rideText === "Let's ride!" && !before.previewLink && before.windOnlyInSuggest && before.routedGone && noFloatingCopy
    && !before.tripChips && !before.exploreNote && before.avoidHills === "Hills" && !/LiDAR/.test(before.relief) && before.works === "Construction"
    && before.metroToggle && !before.parksToggle && before.label2d === "3D" && label3d === "2D" && opened && closed && !before.chevLayer && before.gapsOk;
  return { ok, ...before, noFloatingCopy, layersOpened: opened, layersClosedByTap: closed, destinationKept: fromAfterTap, label3d };
});

await run("elevation: tint, shading, detail contours, LiDAR terrain", `${APP}?trip=montroyal`, async (page) => {
  await page.evaluate(idle);
  return page.evaluate(async (idleSrc) => {
    const app = window.__app, m = app.map;
    const visible = ["tint", "relief", "contours-detail", "contours-index", "contours-minor"].map((id) => [id, m.getLayoutProperty(id, "visibility") || "visible"]);
    const detailLines = m.querySourceFeatures("contours", { sourceLayer: "contours", filter: ["==", ["get", "i"], 2] }).length;
    // island-wide tiles: the same layers exist in the West Island, downtown and the east end
    const tileXY = (lon, lat, z) => { const n = 2 ** z, r = (lat * Math.PI) / 180;
      return [Math.floor(((lon + 180) / 360) * n), Math.floor(((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * n)]; };
    const places = { westIsland: [-73.85, 45.49], downtown: [-73.567, 45.503], eastEnd: [-73.53, 45.63] };
    const files = { relief: 14, tint: 12, contours: 14, buildings: 14 };
    const coverage = {};
    for (const [f, z] of Object.entries(files)) {
      const pm = new pmtiles.PMTiles(new URL(`../shared/tiles/${f}.pmtiles`, location.href).href);
      coverage[f] = {};
      for (const [name, [lon, lat]] of Object.entries(places)) { const [x, y] = tileXY(lon, lat, z); const t = await pm.getZxy(z, x, y); coverage[f][name] = t ? t.data.byteLength : 0; }
    }
    const covered = Object.values(coverage).every((c) => Object.values(c).every((b) => b > 0));
    app.set3d(true); await eval(idleSrc);
    const local = performance.getEntriesByType("resource").filter((e) => e.name.includes("/shared/terrain/")).length;
    return { ok: visible.every((v) => v[1] === "visible") && detailLines > 50 && covered && local > 0 && m.terrain && m.terrain.exaggeration === 1.6,
      visible, detailLines, coverage, localTerrainTiles: local, exaggeration: m.terrain && m.terrain.exaggeration, hillBoost: app.CAM.hill.boost };
  }, idle);
});

await run("climbs and hill-ahead (toned down)", `${APP}?trip=rachel`, async (page) => page.evaluate(async () => {
  const app = window.__app, m = app.map, sel = app.state.routes[0];
  const big = sel.climbs.slice().sort((a, b) => b.rise - a.rise)[0];
  const inClimb = (d) => sel.climbs.some((c) => d >= c.start - 60 && d < c.start + c.length + 60);
  let before = big.start - 250; while (before > 0 && inClimb(before)) before -= 20;
  app.startRide("birdseye"); app.pauseRide(true);
  const at = (d) => { app.state.snap = true; app.state.ride.seek(d); };
  at(0); const flatEx = +m.terrain.exaggeration.toFixed(2);
  at(Math.max(0, before)); const ahead = { ex: +m.terrain.exaggeration.toFixed(2), card: document.querySelector("#hill-title").textContent };
  at(big.start + big.length / 2); const on = document.querySelector("#hill-title").textContent;
  return { ok: flatEx === 1.6 && ahead.ex > 1.6 && ahead.ex <= 2.5 && /Climb in/.test(ahead.card) && /Climbing/.test(on), climbs: sel.climbs.length, flatEx, ahead, on };
}));

await run("suggest a ride: custom loops, stops, 100 km box, headwinds", `${APP}?trip=montroyal`, async (page) => page.evaluate(async (fix) => {
  const app = window.__app, s = app.state;
  app.setTab("suggest"); app.setSuggMode("custom");
  await app.computeSuggestions(true);
  const loops = s.routes.map((c) => +(c.r.length / 1000).toFixed(1));
  const stops = [...document.querySelectorAll(".stop-chip")].map((b) => b.dataset.stop);
  const label = document.querySelector('label[for="from"]'); const startLabel = label && !label.hidden ? label.textContent : null;
  const num = document.querySelector("#km-num"); num.value = 250; num.dispatchEvent(new Event("change"));
  const clamped = +document.querySelector("#km").value;
  num.value = 25; num.dispatchEvent(new Event("change")); await new Promise((r) => setTimeout(r, 50));
  await app.computeSuggestions(true); const long = s.routes.map((c) => +(c.r.length / 1000).toFixed(1));
  document.querySelector('.stop-chip[data-stop="toilets"]').click(); await new Promise((r) => setTimeout(r, 50));
  num.value = 8; num.dispatchEvent(new Event("change")); await app.computeSuggestions(true);
  const restroom = s.routes.map((c) => ({ km: +(c.r.length / 1000).toFixed(1), stops: (c.r.stops || []).length }));
  const wind = document.querySelector("#avoid-wind"); wind.checked = true; wind.dispatchEvent(new Event("change"));
  await new Promise((r) => setTimeout(r, 3000)); await app.computeSuggestions(true);
  const windy = s.routes.length;
  return { ok: loops.length === 3 && loops.every((k) => Math.abs(k - 10) <= 3) && stops.includes("toilets") && stops.includes("park") && !stops.includes("market") && !stops.includes("shop") && !stops.includes("viewpoint")
      && startLabel === "Starting location" && clamped === 100 && long.length >= 2 && restroom.length >= 1 && restroom.every((r) => r.stops === 1) && windy >= 1
      && (!fix || !!s.wxData),   // with the saved forecast the wind data must have loaded, so the headwind costs were really applied
    loops, stops, startLabel, clamped, long, restroom, withHeadwindAvoidance: windy, weatherLoaded: !!s.wxData };
}, FIX));

// ---- local first (2026-11-03): the suggester skips chains, fast food and big-box shops (they stay on the map), puts real destinations first,
// and leaves out places closed when you would get there (OSM opening hours: the common simple forms; anything else is unknown, so kept) ----
await run("ride suggester: local first, real destinations first, never closed on arrival", APP, async (page) => page.evaluate(async () => {
  const S = window.BikeSuggest, P = window.POIS, app = window.__app, F = S.FLAGS;
  const mtl = (iso) => new Date(iso);   // Montréal is UTC-5 in November 2026: Wednesday 4 Nov 10:00 there is 15:00Z
  const WED_10 = mtl("2026-11-04T15:00:00Z"), WED_1230 = mtl("2026-11-04T17:30:00Z"), WED_1330 = mtl("2026-11-04T18:30:00Z"), WED_19 = mtl("2026-11-05T00:00:00Z"),
    THU_02 = mtl("2026-11-05T07:00:00Z"), SAT_0730 = mtl("2026-11-07T12:30:00Z"), SAT_09 = mtl("2026-11-07T14:00:00Z"), SUN_12 = mtl("2026-11-08T17:00:00Z"), MON_12 = mtl("2026-11-02T17:00:00Z");
  const open = (text, d) => S.openAt(S.parseHours(text), d);
  const hours = {
    weekdays: open("Mo-Fr 07:00-18:00; Sa,Su 08:00-17:00", WED_10) === true && open("Mo-Fr 07:00-18:00; Sa,Su 08:00-17:00", WED_19) === false
      && open("Mo-Fr 07:00-18:00; Sa,Su 08:00-17:00", SAT_0730) === false && open("Mo-Fr 07:00-18:00; Sa,Su 08:00-17:00", SAT_09) === true,
    always: open("24/7", THU_02) === true, off: open("off", WED_10) === false, dayOff: open("Tu-Su 11:00-22:00; Mo off", MON_12) === false,
    wrapDays: open("Fr-Mo 10:00-14:00", SUN_12) === true && open("Fr-Mo 10:00-14:00", WED_10) === false,
    twoSpans: open("Mo-Fr 08:00-12:00,13:00-17:00", WED_1230) === false && open("Mo-Fr 08:00-12:00,13:00-17:00", WED_1330) === true,
    pastMidnight: open("Mo-Su 16:00-03:00", THU_02) === true && open("Mo-Su 16:00-03:00", WED_10) === false,
    commaRules: open("Su-Th 11:30-23:00,Fr,Sa 11:30-01:00", WED_10) === false && open("Su-Th 11:30-23:00,Fr,Sa 11:30-01:00", WED_1230) === true,
    holidays: open("Mo-Fr 09:00-17:00; PH off", WED_10) === true && open("Mo-Su,PH 07:00-19:00", WED_10) === true,
    unknown: ["sunrise-sunset", "Oct 01-Apr 14 07:00-19:00", "Mo-Su 08:00+", "", "\"by appointment\""].every((x) => S.parseHours(x) === null && open(x, WED_10) === null),
  };
  // arrival = leaving time + riding minutes; a place must still be open 15 minutes after you arrive; unknown hours are kept
  const cafe = (h) => ["cafe", "Test", -73.58, 45.52, F.REAL, h], WED_16 = mtl("2026-11-04T21:00:00Z");
  const arrival = { openAt1620: !S.closedOnArrival(cafe("Mo-Su 08:00-17:00"), WED_16, 20), closingSoon: S.closedOnArrival(cafe("Mo-Su 08:00-17:00"), WED_16, 50),
    closed: S.closedOnArrival(cafe("Mo-Su 08:00-17:00"), WED_16, 70), unknownKept: !S.closedOnArrival(cafe("sunrise-sunset"), WED_16, 70), noHoursKept: !S.closedOnArrival(["cafe", "Bare", -73.58, 45.52], WED_16, 70) };
  // the flags in pois.js: chains, fast food and big-box shops are skipped, but every place stays on the map; BIXI and metro keep their own 5th element
  const named = (n) => P.filter((p) => p[1] === n), mapData = await app.map.getSource("pois").getData();
  const chains = ["Tim Hortons", "McDonald's", "Starbucks", "Subway", "Dollarama"].map((n) => [n, named(n).length, named(n).filter((p) => S.poiFlags(p) & F.SKIP).length]);
  const flags = { chainsSkipped: chains.every(([, n, k]) => n >= 3 && k === n), onMap: mapData.features.length === P.length && mapData.features.some((f) => f.properties.name === "Tim Hortons"),
    transitUntouched: P.filter((p) => p[0] === "bixi" || p[0] === "metro").every((p) => S.poiFlags(p) === 0),
    fastFoodNeverCandidate: !app.suggester.candidates(["food"]).some((i) => /^(McDonald's|Subway|A&W|KFC|Burger King)$/.test(P[i][1])) };
  const counts = Object.fromEntries(Object.entries(S.STOP_KINDS).map(([k, v]) => [k, app.suggester.candidates(v.kinds).length]));
  // a real destination a little farther (within 10% of the distance) comes before a bare entry; a much farther one does not
  const start = [-73.58, 45.52], at = (m, real) => ["cafe", real ? "Real" : "Bare", start[0], start[1] + m / 111000, real ? F.REAL : undefined].filter((v) => v !== undefined);
  const order = (pois) => new S.Suggester(app.router, pois).pick(start, 2000, ["cafe"], WED_10).map((p) => p.name).join();
  const real = { closeReal: order([at(2040, false), at(2160, true)]) === "Real,Bare", farReal: order([at(2000, false), at(2300, true)]) === "Bare,Real",
    skippedNever: order([at(2000, false), ["cafe", "Chain", start[0], start[1] + 2000 / 111000, F.SKIP]]) === "Bare",
    closedNever: order([at(2000, false), ["cafe", "Shut", start[0], start[1] + 2000 / 111000, F.REAL, "Mo-Su 18:00-23:00"]]) === "Bare" };
  // real suggestions, every stop kind, from the Plateau at 10:00 on a Wednesday (and coffee in the West Island): no chain, nothing closed on arrival
  const weights = BikeRouter.weightsFor(1, false), rides = {};
  for (const [name, from, kinds] of [["plateau", [-73.5795, 45.5235], Object.keys(S.STOP_KINDS)], ["westIsland", [-73.8237, 45.4602], ["cafe"]]]) {
    for (const stop of kinds) {
      const picks = await app.suggester.suggest({ start: from, km: 8, loop: true, stop, weights, now: WED_10 });
      const bad = picks.filter((c) => (S.poiFlags(P[c.poi.i]) & F.SKIP) || S.closedOnArrival(P[c.poi.i], WED_10, BikeCommon.rideMinutes(c.route) * c.route.stops[0].at / c.route.length));
      rides[`${name}:${stop}`] = picks.length + (bad.length ? ` (${bad.length} bad)` : "");
    }
  }
  const late = await app.suggester.suggest({ start: [-73.5795, 45.5235], km: 8, loop: true, stop: "cafe", weights, now: mtl("2026-11-05T04:30:00Z") });   // 23:30
  const lateOk = late.every((c) => !S.closedOnArrival(P[c.poi.i], mtl("2026-11-05T04:30:00Z"), BikeCommon.rideMinutes(c.route) * c.route.stops[0].at / c.route.length));
  const checks = { ...Object.fromEntries(Object.entries(hours).map(([k, v]) => ["hours_" + k, v])), ...Object.fromEntries(Object.entries(arrival).map(([k, v]) => ["arrival_" + k, v])),
    ...flags, ...real, everyKind: Object.values(rides).every((v) => /^[123]$/.test(String(v))), lateOk, enoughCandidates: Object.values(counts).every((n) => n >= 100) };
  const bad = Object.keys(checks).filter((k) => !checks[k]);
  return { ok: !bad.length, ...(bad.length ? { error: "failed checks: " + bad.join(", ") } : {}), chains, counts, rides, late: late.length };
}));

await run("classic rides: 10 cards, routes, swipe", `${APP}?classic=oldport`, async (page) => {
  const out = await page.evaluate(async () => {
    const app = window.__app, s = app.state;
    for (const t0 = performance.now(); !(s.routes[0] && document.querySelectorAll(".classic-card").length === 10) && performance.now() - t0 < 20000;) await new Promise((r) => setTimeout(r, 100));   // first ride routed, cards drawn
    const cards = document.querySelectorAll(".classic-card").length;
    const lengths = window.CLASSICS.map((c, i) => { const r = app.classicRoute(i); return r ? [c.id, +(r.length / 1000).toFixed(1), Math.round(r.infraShare * 100)] : [c.id, null]; });
    const sights = (s.routes[0] && s.routes[0].r.stops || []).filter((x) => x.sight).length;
    const photo = getComputedStyle(document.querySelector(".cc-photo")).backgroundImage.includes("photos/oldport.jpg");
    return { cards, lengths, sights, photo, panelVisible: !document.querySelector("#classics").hidden, first: s.classic };
  });
  await page.evaluate(() => { const tr = document.querySelector("#classic-track"); const c = tr.children[3]; tr.scrollLeft = c.offsetLeft - (tr.clientWidth - c.offsetWidth) / 2; });
  await until(page, () => window.__app.state.classic === 3, null, 10000);   // the card under the middle becomes the selected ride
  const afterSwipe = await page.evaluate(() => window.__app.state.classic);
  return { ok: out.cards === 10 && out.lengths.every((l) => l[1] && l[1] > 5) && out.sights >= 2 && out.photo && afterSwipe === 3, ...out, afterSwipe };
});

await run("winter mode: 4-season routing, icy map, labels", `${APP}?trip=montroyal`, async (page) => page.evaluate(async () => {
  const app = window.__app, m = app.map, s = app.state;
  const summer = { share: s.routes[0].r.infraShare, bg: m.getPaintProperty("background", "background-color") };
  app.setWinter(true);
  for (const t0 = performance.now(); !document.querySelector("#detail").textContent.includes("Without a winter-cleared bike path") && performance.now() - t0 < 20000;) await new Promise((r) => setTimeout(r, 100));   // routes redrawn on the 4-season network
  await new Promise((r) => setTimeout(r, 500));
  const winter = { share: s.routes[0].r.infraShare, bg: m.getPaintProperty("background", "background-color"), pressed: document.querySelector("#winter-btn").getAttribute("aria-pressed"),
    card: document.querySelector("#wx-card").hidden ? "" : document.querySelector("#wx-card").textContent, notCleared: m.getLayoutProperty("net-not-cleared", "visibility"),
    gapHeading: document.querySelector("#detail").textContent.includes("Without a winter-cleared bike path") };
  app.setWinter(false);
  const back = m.getPaintProperty("background", "background-color");
  return { ok: winter.bg === "#eef4f8" && winter.pressed === "true" && /4-season/.test(winter.card) && winter.notCleared === "visible" && winter.gapHeading && JSON.stringify(back) === JSON.stringify(summer.bg),
    summerShare: Math.round(summer.share * 100), winterShare: Math.round(winter.share * 100), winterCard: winter.card.slice(0, 160) };
}));

// 2026-11-02: the weather button is wind and rain only; BIXI loads through its own layer and the button never changes it
await run("wind & rain; BIXI loads on its own", `${APP}?trip=rachel`, async (page) => page.evaluate(async (minStations) => {
  const app = window.__app, m = app.map, s = app.state, bixiVis = () => ["bixi-live", "bixi-count"].map((id) => m.getLayoutProperty(id, "visibility")).join();
  for (let i = 0; i < 20 && !s.bixi; i++) await new Promise((r) => setTimeout(r, 500));   // before any weather
  const bixiBefore = bixiVis();
  app.setWeather(true); await new Promise((r) => setTimeout(r, 4000));
  const bixiDuring = bixiVis();
  const card = document.querySelector("#wx-card").textContent;
  const windNote = document.querySelector(".wind-note") ? document.querySelector(".wind-note").textContent : "";
  const out = { radar: m.getLayoutProperty("radar", "visibility"), canvas: !document.querySelector("#wind").hidden, card: card.slice(0, 200), windNote,
    wx: s.wxData && { wind: s.wxData.now.wind, dir: s.wxData.now.dir } };
  out.bixiStations = s.bixi ? s.bixi.features.length : 0;
  out.bixiSample = s.bixi ? s.bixi.features.slice(0, 1).map((f) => [f.properties.name, f.properties.bikes, f.properties.docks]) : null;
  app.setWeather(false);
  out.bixiUntouched = bixiBefore === bixiDuring && bixiDuring === bixiVis();
  out.ok = out.radar === "visible" && out.canvas && /Wind|Calm/.test(out.card) && !!windNote && out.bixiStations >= minStations && out.bixiUntouched;
  return out;
}, FIX ? FIX_BIXI_STATIONS : 301));   // live: the whole network (about 800 stations); fixtures: every station in the saved file

// ---- 2026-11-03: rain and snow on the map, and the weather button in winter mode ----
// The saved forecast is dry, so these groups answer the forecast request themselves with a wet "current" (rain 2.4 mm/h, or snow 2 cm/h): nothing
// here depends on today's weather, with or without PISTE_FIXTURES. Playwright runs the newest matching route first, so this one wins over the saved copy.
const FORECASTS = { dry: {}, rain: { precipitation: 0.6, rain: 0.6, snowfall: 0, weather_code: 63, temperature_2m: 9 },
  snow: { precipitation: 0.4, rain: 0, snowfall: 0.5, weather_code: 73, temperature_2m: -4 } };
async function stubForecast(ctx, kind) {
  const j = JSON.parse(fixture("open-meteo.json")); j.current = { ...j.current, ...FORECASTS[kind] };
  await ctx.route("https://api.open-meteo.com/**", (route) => route.request().method() === "OPTIONS" ? route.fulfill({ status: 204, headers: { ...CORS, "access-control-allow-headers": "*" } })
    : route.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify(j) }));
}
// Give the page a new forecast: answer with it, load it afresh, and cycle the weather toggle so the card and the layers take it
async function setForecast(page, ctx, kind) {
  await stubForecast(ctx, kind);
  await page.evaluate(async () => { await BikeWeather.load(true); window.__app.setWeather(false); window.__app.setWeather(true); });
  await until(page, (code) => window.__app.state.wxData && window.__app.state.wxData.now.code === code, FORECASTS[kind].weather_code ?? 0);
}
// window.__ink(selector): what a canvas holds right now: inked pixels, their mean red (dark ink on the day map, light on the night map) and a hash of the picture
const INK_JS = `window.__ink = (sel) => { const c = document.querySelector(sel), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0, r = 0, h = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i]) { n++; r += d[i - 3]; h = (h * 31 + d[i] + (i >> 2)) | 0; } return { n, meanR: n ? r / n : 0, hash: h, px: c.width * c.height }; };`;
const frames = (page, n = 2) => page.evaluate(async (k) => { for (let i = 0; i < k; i++) await new Promise((r) => requestAnimationFrame(r)); }, n);
const precipLook = (page) => page.evaluate(() => { const c = document.querySelector("#precip"), w = document.querySelector("#wind"), p = window.__ink("#precip");
  return { hidden: c.hidden, kind: c.dataset.kind || "", n: p.n, share: p.n / p.px, meanR: Math.round(p.meanR), hash: p.hash, windHidden: w.hidden, windN: w.hidden ? 0 : window.__ink("#wind").n }; });
const precipRuns = (page, kind) => until(page, (k) => { const c = document.querySelector("#precip"); return !c.hidden && c.dataset.kind === k && window.__ink("#precip").n > 0; }, kind, 20000);
const precipStopped = (page) => until(page, () => document.querySelector("#precip").hidden, null, 20000);

await run("rain and snow animation: only while it falls, toggle on, not riding, motion allowed; streaks alongside; paused when hidden; sized to the map", `${APP}?trip=rachel`, async (page, ctx) => {
  await page.evaluate(INK_JS);
  // what counts as falling (BikeWeather.precipNow): the codes and amounts of the brief
  const cls = await page.evaluate(() => {
    const P = (now) => { const r = BikeWeather.precipNow({ now: { rain: 0, precip: 0, snow: 0, code: 0, ...now } }); return r ? r.kind : null; };
    return { snow: [{ snow: 0.1 }, { code: 71 }, { code: 77 }, { code: 85 }, { code: 86 }, { snow: 0.2, precip: 0.2 }].map(P),
      rain: [{ rain: 0.1 }, { precip: 0.1 }, { code: 51 }, { code: 67 }, { code: 80 }, { code: 82 }].map(P),
      none: [{}, { code: 3 }, { code: 45 }, { code: 78 }, { code: 83 }, { code: 95 }].map(P), noData: BikeWeather.precipNow(null),
      rates: [BikeWeather.precipNow({ now: { rain: 0.6, precip: 0.6, snow: 0, code: 63 } }).rate, BikeWeather.precipNow({ now: { rain: 0, precip: 0.4, snow: 0.5, code: 73 } }).rate] };
  });
  const clsOk = cls.snow.every((k) => k === "snow") && cls.rain.every((k) => k === "rain") && cls.none.every((k) => k === null) && cls.noData === null && cls.rates.join() === "2.4,2";
  const before = await precipLook(page);   // nothing loaded yet: no weather toggle, no forecast
  const start = await page.evaluate(() => ({ wx: window.__app.state.wx, loaded: !!window.__app.state.wxData, dpr: devicePixelRatio }));
  // dry forecast, toggle on: the streaks run, nothing falls
  await setForecast(page, ctx, "dry");
  await until(page, () => !document.querySelector("#wind").hidden && window.__ink("#wind").n > 0);
  await frames(page, 4);
  const dry = await precipLook(page);
  // rain: rings on the day map, with the streaks still running
  await setForecast(page, ctx, "rain"); await precipRuns(page, "rain");
  await until(page, () => window.__ink("#wind").n > 0);
  const rain = await precipLook(page);
  await until(page, (h) => window.__ink("#precip").hash !== h, rain.hash);   // the picture moves
  await page.evaluate(() => document.body.classList.add("night")); await until(page, () => window.__ink("#precip").meanR > 140);   // light rings on the night map
  const rainNight = await precipLook(page);
  await page.evaluate(() => document.body.classList.remove("night"));
  // snow: dots, a different picture, still sparse
  await setForecast(page, ctx, "snow"); await precipRuns(page, "snow");
  await until(page, () => window.__ink("#wind").n > 0);
  const snow = await precipLook(page);
  await until(page, (h) => window.__ink("#precip").hash !== h, snow.hash);
  await page.evaluate(() => document.body.classList.add("night")); await until(page, () => window.__ink("#precip").meanR > 200);
  const snowNight = await precipLook(page);
  await page.evaluate(() => document.body.classList.remove("night"));
  // toggle off: gone at once, the loop stops; on again: back
  await page.evaluate(() => window.__app.setWeather(false)); await frames(page, 3);
  const off = await precipLook(page);
  await page.evaluate(() => window.__app.setWeather(true)); await precipRuns(page, "snow");
  // a ride: nothing falls on the map (the preview ride), and it all comes back after
  await page.evaluate(() => window.__app.startRide("topdown")); await frames(page, 3);
  const ride = await precipLook(page);
  await page.evaluate(() => window.__app.endRide()); await precipRuns(page, "snow");
  // reduced motion: stops when the setting turns on while it runs, stays off while on, starts when it turns off
  await page.emulateMedia({ reducedMotion: "reduce" }); await precipStopped(page); await frames(page, 3);
  const calmLive = await precipLook(page);
  await page.evaluate(() => { window.__app.setWeather(false); window.__app.setWeather(true); }); await frames(page, 3);
  const calmOn = await precipLook(page);
  await page.emulateMedia({ reducedMotion: "no-preference" }); await precipRuns(page, "snow");
  // the page hidden: the picture freezes; shown again: it moves
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); });
  await frames(page, 3); const h1 = (await precipLook(page)).hash; await frames(page, 8); const h2 = (await precipLook(page)).hash;
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event("visibilitychange")); });
  await until(page, (h) => window.__ink("#precip").hash !== h, h1);
  const resumed = (await precipLook(page)).hash !== h1;
  // sized to the map, with the pixel ratio capped at 2 (this phone is 3)
  await page.setViewportSize({ width: 360, height: 640 });
  await until(page, () => { const c = document.querySelector("#precip"); return c.width === Math.round(innerWidth * 2) && c.height === Math.round(innerHeight * 2); });
  const size = await page.evaluate(() => { const c = document.querySelector("#precip"); return { w: c.width, h: c.height, css: [innerWidth, innerHeight] }; });
  const sparse = (x) => x.n > 0 && x.share < 0.03;
  const ok = clsOk && before.hidden && !before.kind && start.wx === false && !start.loaded && start.dpr === 3
    && dry.hidden && !dry.kind && dry.n === 0 && !dry.windHidden && dry.windN > 0
    && !rain.hidden && rain.kind === "rain" && sparse(rain) && rain.meanR < 110 && !rain.windHidden && rain.windN > 0 && rainNight.meanR > 140 && sparse(rainNight)
    && !snow.hidden && snow.kind === "snow" && sparse(snow) && !snow.windHidden && snow.windN > 0 && snowNight.meanR > 200 && sparse(snowNight)
    && off.hidden && !off.kind && off.n === 0 && off.windHidden
    && ride.hidden && !ride.kind && ride.n === 0 && ride.windHidden
    && calmLive.hidden && !calmLive.kind && calmLive.n === 0 && calmOn.hidden && calmOn.n === 0
    && h1 === h2 && resumed && size.w === size.css[0] * 2 && size.h === size.css[1] * 2;
  return { ok, cls, clsOk, start, dry, rain, rainNight, snow, snowNight, off, ride, calmLive, calmOn, paused: h1 === h2, resumed, size };
}, { width: 390, height: 844 }, { hasTouch: true, isMobile: true, deviceScaleFactor: 3 });

await run("wind & snow button (phone): winter swaps the drop for a snowflake, label and card wording in English and French, nothing moves", `${APP}?trip=rachel`, async (page, ctx) => {
  await stubForecast(ctx, "snow");
  await page.evaluate(() => {
    const rect = (el) => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map((v) => +v.toFixed(2)).join(); };
    window.__wxBtn = () => { const b = document.querySelector("#wx-btn"), shown = (s) => getComputedStyle(b.querySelector(s)).display !== "none";
      return { title: b.title, label: b.getAttribute("aria-label"), drop: shown(".drop"), flake: shown(".flake"), icon: rect(b.querySelector("svg")), pressed: b.getAttribute("aria-pressed"),
        boxes: ["#view-btn", "#wx-btn", "#winter-btn", "#layers-btn"].map((s) => rect(document.querySelector(s))).join("|"), h: b.getBoundingClientRect().height, w: b.getBoundingClientRect().width }; };
  });
  const summer = await page.evaluate(() => window.__wxBtn());
  const winter = await page.evaluate(() => { window.__app.setWinter(true); return window.__wxBtn(); });   // read in the same step: the swap is instant
  const winterFr = await page.evaluate(() => { window.__app.setLang("fr"); return window.__wxBtn().title; });
  const summerFr = await page.evaluate(() => { window.__app.setWinter(false); return window.__wxBtn(); });
  const back = await page.evaluate(() => { window.__app.setLang("en"); return window.__wxBtn(); });
  // the card: with snow falling it says snow (winter mode or not), in French too; raining in winter mode it still says rain; dry, winter mode asks for the snow outlook
  const card = () => page.evaluate(() => (document.querySelector("#wx-card").hidden ? "" : document.querySelector("#wx-card").textContent));
  await page.evaluate(() => { window.__app.setWinter(true); window.__app.setWeather(true); });
  await until(page, () => /Snowing now/.test(document.querySelector("#wx-card").textContent));
  const snowEn = await card();
  await page.evaluate(() => window.__app.setLang("fr")); const snowFr = await card();
  await page.evaluate(() => window.__app.setLang("en"));
  await page.evaluate(() => window.__app.setWinter(false)); const snowSummer = await card();
  await page.evaluate(() => window.__app.setWinter(true));
  await setForecast(page, ctx, "rain"); await until(page, () => /Raining now/.test(document.querySelector("#wx-card").textContent));
  const rainWinter = await card();
  await setForecast(page, ctx, "dry"); await until(page, () => /No snow for the next/.test(document.querySelector("#wx-card").textContent));
  const dryWinter = await card();
  await page.evaluate(() => window.__app.setWinter(false)); const drySummer = await card();
  const same = (a, b) => a.boxes === b.boxes && a.icon === b.icon && a.w === b.w && a.h === b.h;
  const ok = summer.title === "Wind & rain" && summer.label === "Wind & rain" && summer.drop && !summer.flake
    && winter.title === "Wind & snow" && winter.label === "Wind & snow" && !winter.drop && winter.flake && same(summer, winter) && winter.h >= 44 && winter.w >= 44
    && winterFr === "Vent et neige" && summerFr.title === "Vent et pluie" && summerFr.drop && !summerFr.flake
    && back.title === "Wind & rain" && back.label === "Wind & rain" && back.drop && !back.flake && same(summer, back)
    && /Snowing now \(2\.0 cm\/h\)/.test(snowEn) && !/rain/i.test(snowEn) && /Il neige \(2,0 cm\/h\)/.test(snowFr) && /Snowing now/.test(snowSummer)
    && /Raining now \(2\.4 mm\/h\)/.test(rainWinter) && /No snow for the next 6 hours/.test(dryWinter) && /Dry for the next 6 hours/.test(drySummer);
  return { ok, summer, winter, winterFr, summerFr: summerFr.title, back: back.title, snowEn: snowEn.slice(0, 120), snowFr: snowFr.slice(0, 120), snowSummer: snowSummer.slice(0, 120),
    rainWinter: rainWinter.slice(0, 120), dryWinter: dryWinter.slice(0, 120), drySummer: drySummer.slice(0, 120) };
}, { width: 390, height: 844 }, { hasTouch: true, isMobile: true });

await run("French", `${APP}?trip=montroyal&lang=fr`, async (page) => page.evaluate(() => {
  const s = window.__app.state, r = s.routes[0].r;
  const tab = document.querySelector("#tab-go").textContent, pct = document.querySelector(".rc-pct").textContent;
  const turn = window.BikeI18n.maneuver(r.maneuvers[1] || r.maneuvers[0]);
  window.__app.setLang("en"); const tabEn = document.querySelector("#tab-go").textContent;
  return { ok: tab === "Itinéraire" && /sur pistes cyclables/.test(pct) && /(Tournez|Continuez|Partez|Légèrement|Virage)/.test(turn) && tabEn === "Go somewhere", tab, pct, turn, tabEn };
}));

await run("2D ride: place icons stay pinned to the map (no shaking)", `${APP}?trip=montroyal`, async (page) => page.evaluate(async () => {
  const app = window.__app, m = app.map;
  app.startRide("topdown");
  const t0 = performance.now();
  while (app.poiMarkers.size < 2 && performance.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 100));
  const box = m.getContainer().getBoundingClientRect();
  // where an icon's anchor point is on screen (left/right anchors, 6 px offset)
  const anchorPt = (mk) => { const r = mk.getElement().getBoundingClientRect(), o = mk.getOffset();
    return { x: (o.x < 0 ? r.right : r.left) - o.x - box.left, y: r.top + r.height / 2 - o.y - box.top }; };
  // each time the map draws, note where every icon belongs; just before that frame is painted, compare with where the icon is
  // (a ResizeObserver runs after all of a frame's animation callbacks, right before paint)
  let worst = 0, sum = 0, n = 0, frames = 0, pending = null, w = 1;
  const probe = document.createElement("div"); probe.style.cssText = "position:absolute;left:0;top:0;height:1px;width:1px;visibility:hidden"; document.body.appendChild(probe);
  const ro = new ResizeObserver(() => {
    const proj = pending; pending = null; if (!proj) return; frames++;
    for (const [mk, p] of proj) {
      if (!mk.getElement().isConnected) continue;
      const a = anchorPt(mk), e = Math.hypot(a.x - p.x, a.y - p.y);
      worst = Math.max(worst, e); sum += e; n++;
    }
  });
  ro.observe(probe);
  const onRender = () => { pending = [...app.poiMarkers.values()].map((mk) => [mk, m.project(mk.getLngLat())]); w = 3 - w; probe.style.width = w + "px"; };
  m.on("render", onRender);
  for (const t0 = performance.now(); (performance.now() - t0 < 5000 || frames < 30) && performance.now() - t0 < 30000;) await new Promise((r) => setTimeout(r, 100));   // a slow machine needs longer to draw 30 frames
  m.off("render", onRender); ro.disconnect(); probe.remove();
  app.pauseRide(true);
  const pop = document.querySelector(".poi-pop");
  const transition = pop ? getComputedStyle(pop).transitionProperty : null;   // MapLibre fades markers in (opacity); nothing may animate their position
  return { ok: frames > 20 && n > 20 && worst < 0.5 && !/transform|all/.test(transition), frames, samples: n, worstPx: +worst.toFixed(2), meanPx: +(sum / Math.max(1, n)).toFixed(3), transition };
}));

await run("phone: swipeable panel, safe areas", `${APP}?trip=rachel&safe=62,34`, async (page) => {
  const H = 874;
  const panelH = () => Math.round(document.querySelector("#panel").getBoundingClientRect().height);
  const half = await page.evaluate(panelH);
  await page.evaluate(() => window.__app.setSheet("full")); await page.waitForTimeout(400); await panelStill(page);
  const full = await settled(page, panelH);
  // drag the grabber down a long way: the panel should drop to the small "peek" size
  const g = await page.locator("#grabber").boundingBox();
  await page.mouse.move(g.x + g.width / 2, g.y + 5); await page.mouse.down(); await page.mouse.move(g.x + g.width / 2, g.y + 600, { steps: 12 }); await page.mouse.up();
  await page.waitForTimeout(500);
  const peek = await settled(page, panelH);
  const layout = await page.evaluate(() => ({ scrollW: document.documentElement.scrollWidth, innerW: innerWidth }));
  await page.evaluate(() => window.__app.setSheet("half")); await page.waitForTimeout(400);
  // tap the destination bar: the card slides so the bars sit just above the keyboard (a guess here: no real keyboard), brand and tabs hide
  const to = await page.locator("#to").boundingBox();
  await page.mouse.click(to.x + 20, to.y + to.height / 2); await page.waitForTimeout(400);
  const docked = await settled(page, () => { const f = document.querySelector("#to").closest(".field").getBoundingClientRect(), c = document.querySelector("#places").getBoundingClientRect();
    return { searching: document.body.classList.contains("searching"), active: document.activeElement.id, brandHidden: getComputedStyle(document.querySelector("#brand")).display === "none",
      fieldBottom: Math.round(f.bottom), chipsTop: Math.round(c.top + 7), chipsBottom: Math.round(c.bottom - 7), kbTop: Math.round(innerHeight - Math.max(260, innerHeight * 0.47)),
      clearShown: getComputedStyle(document.querySelector('.clear[data-target="to"]')).display !== "none" }; });   // the chips' circles sit 7 px inside their 44 px rows
  const suggestShown = () => { const l = document.querySelector("#suggest"); return !l.hidden && l.children.length > 0; };
  // type: suggestions float over the map, above the card (select the old destination first, so the text searched is exactly "marché jean")
  await page.keyboard.press("Control+A"); await page.keyboard.type("marché jean"); await until(page, suggestShown);
  const list = await page.evaluate(() => { const l = document.querySelector("#suggest"), p = document.querySelector("#panel");
    return { shown: !l.hidden, aboveCard: l.getBoundingClientRect().bottom <= p.getBoundingClientRect().top + 1, n: l.children.length }; });
  // the x (2026-10-31) clears the destination: field, point and route go, the search ends, and the keyboard is not opened
  await page.click('.clear[data-target="to"]'); await page.waitForTimeout(500);
  const cancelled = await page.evaluate(() => ({ searching: document.body.classList.contains("searching"), cleared: window.__app.state.to === null && document.querySelector("#to").value === "" && window.__app.state.routes.length === 0,
    noKeyboard: !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName), startKept: !!window.__app.state.from && document.querySelectorAll(".end-pin").length === 1 }));
  // with no destination yet, the return key on a typed start moves straight on to the destination bar
  await page.evaluate(() => { const s = window.__app.state; s.to = null; s.toLabel = ""; document.querySelector("#to").value = ""; });
  const fr = await page.locator("#from").boundingBox();
  await page.mouse.click(fr.x + 20, fr.y + fr.height / 2); await page.waitForTimeout(300);
  await page.keyboard.press("Control+A"); await page.keyboard.type("marché jean"); await until(page, suggestShown);
  await page.keyboard.press("Enter"); await page.waitForTimeout(300);
  const moved = await page.evaluate(() => ({ active: document.activeElement.id, searching: document.body.classList.contains("searching") }));
  // pick the destination from the list: the search ends, the card comes back and the route shows
  await page.keyboard.type("parc la fontaine"); await until(page, () => /Fontaine/i.test(document.querySelector("#suggest").textContent));
  await page.click("#suggest li");
  await until(page, () => !document.body.classList.contains("searching") && window.__app.state.routes.length > 0 && document.querySelector("#panel").dataset.sheet === "half");   // card back, route drawn
  const done = await page.evaluate(() => ({ searching: document.body.classList.contains("searching"), routes: window.__app.state.routes.length, sheet: document.querySelector("#panel").dataset.sheet }));
  return { ok: Math.abs(half - H / 2) < 4 && full >= H - 62 - 10 && peek <= 160 && layout.scrollW <= layout.innerW
      && docked.searching && docked.active === "to" && docked.brandHidden && docked.clearShown && docked.fieldBottom <= docked.chipsTop && docked.chipsBottom <= docked.kbTop && docked.chipsBottom >= docked.kbTop - 30
      && list.shown && list.aboveCard && !cancelled.searching && cancelled.cleared && cancelled.noKeyboard && cancelled.startKept && moved.active === "to" && moved.searching && !done.searching && done.routes > 0 && done.sheet === "half",
    half, full, peek, ...layout, docked, list, cancelled, moved, done };
}, { width: 402, height: 874 });

// ------------------------------------------------------------------ GPS ride (2026-10-30)
// ?gps=replay feeds a pretend ride (1 fix a second, sped up by gpsx, a few metres of noise, a poor fix now and then)
// through navigator.geolocation's interface, so it runs the same code as a real phone.
await run("GPS ride (replayed track): follows the route, ignores poor fixes, re-center, arrives", `${APP}?trip=montroyal&gps=replay&gpsx=3`, async (page) => {
  const follow = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const app = window.__app, m = app.map, s = app.state, C = BikeCommon;
    document.querySelector("#ride-go").click(); window.__flatRide();
    const ride = s.ride, geo = ride.geo;
    const ui = { gps: !!(ride && ride.gps), speedHidden: document.querySelector("#ride-speed").hidden, pauseHidden: document.querySelector("#ride-pause").hidden,
      gpsShown: !document.querySelector("#ride-gps").hidden, first: document.querySelector("#ride-gps").textContent };
    // at every map draw: is the rider on the route, near the latest fix and the true position, with the camera on it?
    const st = { frames: 0, backwards: 0, offLine: 0, fixMax: 0, fixSum: 0, trueMax: 0, trueSum: 0, camMax: 0, stepMax: 0, stepOver: 0, dtMax: 0, dtSum: 0 };
    const v = geo.v * geo.k;   // how fast the pretend rider really moves (m/s)
    let prevD = -1, prevLL = null, prevT = 0, firstT = 0, prevDt = 0, prevDt2 = 0;
    const onRender = () => {
      if (s.ride !== ride || !ride.fix || ride.blend > 0) return;
      const ll = app.riderMarker.getLngLat(), c = m.getCenter(), p = ride.cursor.at(ride.d);
      const last = geo.log.filter((e) => !e.bad).at(-1);   // the latest good fix, snapped to the route
      const fixAlong = ride.track.locate(last.fix[0], last.fix[1], ride.d - 100, ride.d + 100).along;
      const trueAlong = Math.min(ride.cursor.total, last.d + (geo.v * geo.k * (performance.now() - last.t)) / 1000);   // where the pretend rider is now
      const ef = Math.abs(ride.d - fixAlong), et = Math.abs(ride.d - trueAlong);
      st.frames++; if (ride.d < prevD - 0.01) st.backwards++;
      st.offLine = Math.max(st.offLine, C.distM(ll.lng, ll.lat, p.lon, p.lat));
      st.fixMax = Math.max(st.fixMax, ef); st.fixSum += ef; st.trueMax = Math.max(st.trueMax, et); st.trueSum += et;
      st.camMax = Math.max(st.camMax, C.distM(c.lng, c.lat, ll.lng, ll.lat));
      // seconds since the last frame counted here. A slow machine draws fewer frames, so the rider rightly moves further between two of them
      const now = performance.now(), dt = prevT ? (now - prevT) / 1000 : 0; prevT = now; if (!firstT) firstT = now; st.dtMax = Math.max(st.dtMax, dt); st.dtSum += dt;
      // steps are judged from 1.5 s after the first fix: the rider's first move onto that fix (about the size of the GPS noise) is not a stutter
      if (prevLL && now - firstT > 1500) { const step = C.distM(prevLL.lng, prevLL.lat, ll.lng, ll.lat); st.stepMax = Math.max(st.stepMax, step); st.stepOver = Math.max(st.stepOver, step - Math.max(3, v * (dt + prevDt + prevDt2) + 1.5)); }   // a step may be 3 m, or what the rider covers in this frame and the two before it (after a long frame the rider catches up) + 1.5 m
      prevD = ride.d; prevLL = ll; prevDt2 = prevDt; prevDt = dt;
    };
    // sample for at least 8 s and at least 41 frames (a slow machine needs longer for that), but never past 30 s
    m.on("render", onRender);
    for (const t0 = performance.now(); (performance.now() - t0 < 8000 || st.frames <= 40) && performance.now() - t0 < 30000;) await sleep(100);
    m.off("render", onRender);
    const r = (v) => +v.toFixed(2);
    return { ...ui, now: document.querySelector("#ride-gps").textContent, d: Math.round(ride.d), fixes: ride.stats.fixes, ignored: ride.stats.ignored, wake: s.wake,
      frames: st.frames, backwards: st.backwards, offLineM: r(st.offLine), toFixMaxM: r(st.fixMax), toFixMeanM: r(st.fixSum / Math.max(1, st.frames)),
      toTrueMaxM: r(st.trueMax), toTrueMeanM: r(st.trueSum / Math.max(1, st.frames)), cameraM: r(st.camMax), stepMaxM: r(st.stepMax),
      stepOverM: r(st.stepOver), frameMaxMs: Math.round(st.dtMax * 1000), frameMeanMs: Math.round((st.dtSum / Math.max(1, st.frames - 1)) * 1000),
      lagMaxM: r(v * st.dtMax), lagMeanM: r((v * st.dtSum) / Math.max(1, st.frames - 1)) };   // lag*: the distance the rider moves in one frame (the most / on average)
  });
  // drag the map by hand: it stops following and offers "Re-center"; a tap there follows again
  await page.mouse.move(720, 420); await page.mouse.down(); await page.mouse.move(560, 330, { steps: 8 }); await page.mouse.up();
  await page.waitForTimeout(600);
  const dragged = await page.evaluate(() => { const a = window.__app, ll = a.riderMarker.getLngLat(), c = a.map.getCenter();
    return { follow: a.state.follow, button: !document.querySelector("#ride-recenter").hidden, centerToRiderM: Math.round(BikeCommon.distM(c.lng, c.lat, ll.lng, ll.lat)) }; });
  await page.click("#ride-recenter");
  await page.waitForFunction(() => { const a = window.__app, ll = a.riderMarker.getLngLat(), c = a.map.getCenter(); return a.state.follow && BikeCommon.distM(c.lng, c.lat, ll.lng, ll.lat) < 0.5; }, null, { timeout: 15000 }).catch(() => {});
  const recentered = await page.evaluate(() => { const a = window.__app, ll = a.riderMarker.getLngLat(), c = a.map.getCenter();
    return { follow: a.state.follow, button: !document.querySelector("#ride-recenter").hidden, centerToRiderM: +BikeCommon.distM(c.lng, c.lat, ll.lng, ll.lat).toFixed(2) }; });
  // arrival: start again 160 m before the end
  const arrival = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const app = window.__app, s = app.state, total = s.routes[s.sel].r.length;
    app.endRide(); app.startGpsRide({ replay: { speedup: 3, startAt: total - 160 } }); window.__flatRide();
    const ride = s.ride, t0 = performance.now(); let toast = "";
    while (!ride.arrived && performance.now() - t0 < 60000) { await sleep(200); }
    const secs = +((performance.now() - t0) / 1000).toFixed(1);
    toast = document.querySelector("#toast").hidden ? "" : document.querySelector("#toast").textContent;
    await sleep(3000);
    return { arrived: ride.arrived, secs, toast, endedAfter: s.ride === null && !document.querySelector("#ride-summary").hidden && document.querySelector("#panel").hidden, wakeAfter: s.wake };   // 2026-11-01: arriving shows the ride summary
  });
  const f = follow;
  // The rider is drawn once per frame, so on a slow machine the picture is up to one frame behind: a position error may be as large as
  // the distance covered in a frame (lag) plus half the usual limit. On a fast machine the limit is the usual one.
  const allow = (limit, lag) => Math.max(limit, lag + limit / 2);
  const ok = f.gps && f.speedHidden && f.pauseHidden && f.gpsShown && /Waiting for GPS/.test(f.first) && /km\/h/.test(f.now) && f.d > 80 && f.ignored >= 2
    && f.frames > 40 && f.backwards === 0 && f.offLineM < 0.5 && f.toFixMaxM < allow(12, f.lagMaxM) && f.toFixMeanM < allow(6, f.lagMeanM) && f.toTrueMeanM < allow(8, f.lagMeanM) && f.cameraM < 0.5 && f.stepOverM <= 0
    && !dragged.follow && dragged.button && dragged.centerToRiderM > 30 && recentered.follow && !recentered.button && recentered.centerToRiderM < 0.5
    && arrival.arrived && /Arrived/.test(arrival.toast) && arrival.endedAfter && arrival.wakeAfter === "off";
  return { ok, follow, dragged, recentered, arrival };
});

await run("GPS ride (replayed track): a detour triggers exactly one reroute", `${APP}?trip=montroyal&gps=replay&gpsx=3&gpsat=300&detour=400`, async (page) => page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.__app, m = app.map, s = app.state, C = BikeCommon;
  const said = [], say = C.voice.say; C.voice.say = (text) => said.push(text);
  const toasts = new Set(), toastEl = document.querySelector("#toast");
  new MutationObserver(() => { if (!toastEl.hidden) toasts.add(toastEl.textContent); }).observe(toastEl, { childList: true, attributes: true, characterData: true, subtree: true });
  const planned = s.routes[s.sel].r, plannedTrack = C.makeTrack(planned);
  document.querySelector("#ride-go").click(); window.__flatRide();
  const ride = s.ride, geo = ride.geo;
  let offDrawn = 0;   // while off route, the rider is drawn where the phone is, not on the route
  const onRender = () => { if (s.ride === ride && ride.route === planned) { const ll = app.riderMarker.getLngLat(); offDrawn = Math.max(offDrawn, plannedTrack.locate(ll.lng, ll.lat).off); } };
  m.on("render", onRender);
  const t0 = performance.now();
  while (s.reroutes < 1 && performance.now() - t0 < 60000) await sleep(200);
  m.off("render", onRender);
  const secsToReroute = +((performance.now() - t0) / 1000).toFixed(1);
  await sleep(12000);   // long enough for a second reroute, if there were one
  const log = s.rerouteLog[0] || {}, det = geo.det || {};
  const fixToStartM = log.start ? Math.round(C.distM(log.at[0], log.at[1], log.start[0], log.start[1])) : null;
  const detourToStartM = log.start && det.lon ? Math.round(C.distM(det.lon, det.lat, log.start[0], log.start[1])) : null;
  const drawn = (await m.getSource("route").getData()).features.length, newPieces = C.routePiecesGeoJSON(ride.route).features.length;
  const out = { reroutes: s.reroutes, attempts: ride.stats.reroutes, secsToReroute, fixToStartM, detourToStartM, plannedM: Math.round(planned.length), newM: Math.round(ride.route.length),
    dOnNewRoute: Math.round(ride.d), backOnRoute: ride.offCount === 0, offDrawnM: Math.round(offDrawn), drawnPieces: drawn, newPieces, said, toasts: [...toasts], ms: log.ms };
  app.endRide();
  out.restored = (await m.getSource("route").getData()).features.length === C.routePiecesGeoJSON(planned).features.length && s.routes[s.sel].r === planned;
  C.voice.say = say;
  out.ok = out.reroutes === 1 && out.attempts === 1 && fixToStartM !== null && fixToStartM < 70 && detourToStartM < 200 && out.newM !== out.plannedM && out.dOnNewRoute > 60 && out.backOnRoute
    && out.offDrawnM > 30 && drawn === newPieces && said.includes("Rerouting") && out.toasts.includes("New route from here") && out.restored;
  return out;
}));

await run("GPS ride: the heading comes from the last 20-40 m of fixes, and only when moving", `${APP}`, async (page) => page.evaluate(() => {
  const C = BikeCommon, lat0 = 45.5, kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
  // n fixes, step metres apart (east, north), one second apart; v = the phone's speed (m/s) or null
  const track = (n, east, north, v) => Array.from({ length: n }, (_, i) => ({ lon: -73.6 + (i * east) / kx, lat: lat0 + (i * north) / ky, t: 1e6 + i * 1000, v }));
  const angle = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
  const h = C.headingFromFixes, r = {
    north: h(track(8, 0, 5, 5)), east: h(track(8, 5, 0, 5)), southwest: h(track(8, -3.5, -3.5, 5)),
    tooShort: h(track(3, 0, 5, 5)), slow: h(track(30, 0, 1.5, 1.5)), standing: h(track(10, 0, 0, 0)), empty: h([]), single: h(track(1, 0, 5, 5)),
    noPhoneSpeedFast: h(track(8, 5, 0, null)), noPhoneSpeedSlow: h(track(30, 1, 0, null)), sparse: h(track(2, 0, 60, 10)),
  };
  r.ok = angle(r.north, 0) < 1 && angle(r.east, 90) < 1 && angle(r.southwest, 225) < 1 && r.tooShort === null && r.slow === null && r.standing === null && r.empty === null && r.single === null
    && angle(r.noPhoneSpeedFast, 90) < 1 && r.noPhoneSpeedSlow === null && angle(r.sparse, 0) < 1;
  return r;
}));

// The rider leaves the route on purpose (a right-angle turn at 400 m) and keeps riding straight on, ignoring every new route (video of
// 2026-11-01: each reroute went back the way he came, the next turn kept getting farther away, and it rerouted again). The app must
// work out his heading from the GPS fixes and hand it to the router on every reroute, the new route must not start by turning back
// (the router's own limit: under 100 degrees from his heading), and reroutes must not come back to back.
// Where the straight line crosses the streets decides how far the next turn is, so that distance is only listed, not judged.
// No fixed timing: it waits for the reroutes, and only the gap between two reroutes (at least half the 10 s cooldown) is judged.
await run("GPS ride (replayed track): riding straight on after leaving the route, each reroute keeps going ahead", `${APP}?trip=montroyal&gps=replay&gpsx=3&gpsat=300&detour=400&straight`, async (page) => page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.__app, s = app.state, C = BikeCommon, B = BikeRouter;
  const headings = [], route = B.Router.prototype.route;   // what the router is asked during the ride
  B.Router.prototype.route = function (from, to, opts) { headings.push(opts && opts.heading); return route.call(this, from, to, opts); };
  document.querySelector("#ride-go").click(); window.__flatRide();
  const ride = s.ride, geo = ride.geo, t0 = performance.now();
  while (s.reroutes < 3 && performance.now() - t0 < 120000) await sleep(200);
  B.Router.prototype.route = route;
  const riding = (geo.det.h + 90 * geo.det.side + 360) % 360;   // the rider's true heading: a right angle off the route
  const angle = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
  const first30 = (coords) => {   // the bearing of the new route over its first 30 m
    let acc = 0;
    for (let i = 1; i < coords.length; i++) { acc += C.distM(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]); if (acc >= 30) return B.bearing(coords[0][0], coords[0][1], coords[i][0], coords[i][1]); }
    return null;
  };
  const log = s.rerouteLog.filter((l) => l.ok);
  const rows = log.map((l, i) => ({ headingErr: l.heading == null ? null : Math.round(angle(l.heading, riding)), firstLegErr: l.coords && first30(l.coords) != null ? Math.round(angle(first30(l.coords), riding)) : null,
    nextTurnM: l.nextTurnM, lengthM: l.length, gapS: i ? +((l.wall - log[i - 1].wall) / 1000).toFixed(1) : null }));
  const asked = headings.filter(Number.isFinite).length;
  const out = { reroutes: s.reroutes, attempts: ride.stats.reroutes, riding: Math.round(riding), routerCalls: headings.length, askedWithHeading: asked, rows };
  app.endRide();
  out.ok = out.reroutes >= 2 && rows.length === out.reroutes && asked >= out.reroutes
    && rows.every((r) => r.headingErr !== null && r.headingErr < 30 && r.firstLegErr !== null && r.firstLegErr < 100)
    && rows.every((r, i) => !i || r.gapS >= 5);
  return out;
}));

await run("GPS ride (replayed track): on a classic ride, a reroute rejoins the ride ahead", `${APP}?classic=oldport&gps=replay&gpsx=4&gpsat=1500&detour=1600`, async (page) => page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.__app, s = app.state;
  document.querySelector("#ride-go").click(); window.__flatRide();
  for (const t0 = performance.now(); !s.join && performance.now() - t0 < 20000;) await sleep(50);
  const planned = s.ride.route;   // 2026-11-03: a classic ride starts where you are (here 1.5 km into the loop: the loop from there)
  const t0 = performance.now();
  while (s.reroutes < 1 && performance.now() - t0 < 60000) await sleep(200);
  await sleep(1500);
  const r = s.ride.route, log = s.rerouteLog[0] || {}, left = planned.length - (log.d || 0);   // what was left of the ride when you went off it
  const out = { start: s.join && s.join.kind, reroutes: s.reroutes, rejoin: s.rideOpts.rejoin, leftM: Math.round(left), newM: Math.round(r.length), plannedSights: planned.stops.map((x) => x.label),
    sights: r.stops.map((x) => x.label), piecesM: Math.round(r.pieces.reduce((a, p) => a + p.length, 0)), onNewRoute: s.ride.offCount === 0 };
  app.endRide();
  out.ok = out.start === "on" && out.reroutes === 1 && out.rejoin && Math.abs(out.newM - out.leftM) < 400 && out.sights.length >= 1
    && out.sights.join() === planned.stops.filter((x) => x.at > log.d + 250).map((x) => x.label).join() && Math.abs(out.piecesM - out.newM) <= 1 && out.onNewRoute;
  return out;
}));

// 2026-11-03: a classic ride starts where you are (common.js planJoin, app.js joinClassic). On the loop (here 5 km into the Plateau loop) it starts
// at the nearest point and goes once round, back to it: the planned ride turned round, so the length, climb, sights and streets (in order) are the
// same. No lead-in and no notices; the ride ends where it began; after it the planned loop is back on the map.
await run("GPS ride (replayed track): a classic ride started mid-loop starts there and goes once round", `${APP}?classic=plateau&gps=replay&gpsx=4&gpsat=5000`, async (page) => page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.__app, s = app.state, C = BikeCommon;
  const said = [], say = C.voice.say; C.voice.say = (text) => said.push(text);
  const planned = s.routes[0].r, L = planned.length, gap = (a, b) => C.distM(a[0], a[1], b[0], b[1]);
  document.querySelector("#ride-go").click(); window.__flatRide();
  const ride = s.ride, geo = ride.geo;
  for (const t0 = performance.now(); !s.join && performance.now() - t0 < 20000;) await sleep(50);
  const J = s.join || {}, r = ride.route, firstFix = geo.log.find((e) => !e.bad) || {};   // the first good fix decides where the ride starts
  // the same streets in the same order, from the one the rider is on round to it again (it is cut in two: the ride's first and last leg)
  const pe = planned.legs.filter((l) => l.len > 0), k = pe.findIndex((l) => J.joinAt < l.dist0 + l.len), ids = (ls) => ls.map((l) => l.e).join();
  const sameStreets = [ids(pe.slice(k).concat(pe.slice(0, k + 1))), ids(pe.slice(k).concat(pe.slice(0, k)))].includes(ids(r.legs));
  const sightsOk = planned.stops.length === r.stops.length && planned.stops.every((p) => r.stops.some((q) => q.label === p.label && Math.abs(q.at - ((p.at - J.joinAt + L) % L)) < 1));
  const d0 = ride.d; await sleep(3000);   // and it rides on from there
  const drawn = await app.map.getSource("route").getData();
  const out = { kind: J.kind, ms: J.ms, joinAt: Math.round(J.joinAt), riderToJoinM: J.join && firstFix.lon ? +gap([firstFix.lon, firstFix.lat], J.join).toFixed(1) : null,
    plannedM: Math.round(L), routeM: Math.round(r.length), startToJoinM: J.join ? +gap(r.coords[0], J.join).toFixed(2) : null, endToJoinM: J.join ? +gap(r.coords.at(-1), J.join).toFixed(2) : null,
    sameStreets, sightsOk, turns: [planned.maneuvers.length, r.maneuvers.length], climb: [Math.round(planned.climb), Math.round(r.climb)],
    piecesM: Math.round(r.pieces.reduce((a, p) => a + p.length, 0)), advanced: [Math.round(d0), Math.round(ride.d)], onRoute: ride.offCount === 0, reroutes: s.reroutes,
    leadDrawn: drawn.features.filter((f) => f.properties.lead === 1).length, notices: (J.notices || []).length, said, rideEnd: s.rideEnd };
  app.endRide(); C.voice.say = say;
  const after = (await app.map.getSource("route").getData()).features.length, ends = (await app.map.getSource("ends").getData()).features;
  out.restored = after === C.routePiecesGeoJSON(planned).features.length && !!ends[0] && gap(ends[0].geometry.coordinates, planned.coords[0]) < 0.01;
  out.ok = out.kind === "on" && out.riderToJoinM !== null && out.riderToJoinM < 15 && out.joinAt > 1000 && Math.abs(r.length - L) < 0.5 && out.startToJoinM < 0.01 && out.endToJoinM < 0.01
    && out.sameStreets && out.sightsOk && Math.abs(out.turns[0] - out.turns[1]) <= 1 && out.climb[0] === out.climb[1] && Math.abs(out.piecesM - out.routeM) <= 1
    && out.advanced[1] > out.advanced[0] && out.onRoute && out.reroutes === 0 && out.leadDrawn === 0 && out.notices === 0 && !said.some((x) => /loop/.test(x))
    && out.rideEnd !== "Parc La Fontaine" && out.restored;
  return out;
}));

// About 1 km from the Plateau loop (in Outremont): a lead-in on the most bike paths to the join point with the shortest ride (not the loop's nearest
// point in a straight line), drawn in dots, then the whole loop from there, ending back at the join point. "1.1 km to the start of the loop" once
// at the start; the chime and "You're on the loop: 10 km to go" once on reaching it. A detour on the lead-in reroutes to the same join point.
await run("GPS ride (replayed track): a classic ride from 1 km away: lead-in to the best join point, a detour on it, notices once", `${APP}?classic=plateau&gps=replay&gpsx=5&gpsfrom=-73.60423,45.5155&detour=250`, async (page) => page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.__app, s = app.state, C = BikeCommon, from = [-73.60423, 45.5155];
  // the chime: a stand-in Web Audio context that notes when each tone starts (two per chime)
  const tones = [], node = () => ({ connect: (x) => x, start() {}, stop() {}, frequency: {}, gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} } });
  window.AudioContext = class { constructor() { this.state = "running"; this.currentTime = 0; this.destination = {}; } resume() { return Promise.resolve(); } suspend() { return Promise.resolve(); }
    createBuffer() { return {}; } createBufferSource() { return node(); } createGain() { return node(); } createOscillator() { tones.push(performance.now()); return node(); } };
  const said = [], say = C.voice.say; C.voice.say = (text) => said.push({ text, t: performance.now() });
  const toasts = [], toastEl = document.querySelector("#toast");
  new MutationObserver(() => { if (!toastEl.hidden && toasts.at(-1) !== toastEl.textContent) toasts.push(toastEl.textContent); }).observe(toastEl, { childList: true, attributes: true, characterData: true, subtree: true });
  const planned = s.routes[0].r, L = planned.length, gap = (a, b) => C.distM(a[0], a[1], b[0], b[1]);
  document.querySelector("#ride-go").click(); window.__flatRide();
  const ride = s.ride;
  for (const t0 = performance.now(); !s.join && performance.now() - t0 < 20000;) await sleep(50);
  const J = s.join || {}, loop = J.loop, r0 = ride.route;
  // chosen by riding distance: never longer than riding to the loop's nearest point in a straight line
  const near = C.buildCursor(planned).at(C.makeTrack(planned).locate(from[0], from[1]).along);
  const toNearest = app.router.route(from, [near.lon, near.lat], { w: BikeRouter.PROFILES.bikemax.w, hill: 4 });
  await sleep(300);
  const drawn = (await app.map.getSource("route").getData()).features, leadF = drawn.filter((f) => f.properties.lead === 1);
  const dot = (await app.map.getSource("ends").getData()).features[0];
  const start = { kind: J.kind, ms: J.ms, routed: J.routed, cands: J.cands, leadM: Math.round(J.at), toNearestM: toNearest && Math.round(toNearest.length), joinAt: Math.round(J.joinAt),
    loopM: loop && Math.round(loop.length), plannedM: Math.round(L), routeM: Math.round(r0.length), riderToStartM: Math.round(gap(r0.coords[0], from)),
    endToJoinM: +gap(r0.coords.at(-1), J.join).toFixed(2), leadEndToJoinM: J.lead ? +gap(J.lead.coords.at(-1), J.join).toFixed(2) : null, joinToUsualStartM: Math.round(gap(J.join, planned.coords[0])),
    leadDrawnM: leadF.reduce((a, f) => a + f.properties.len, 0), leadPieces: leadF.length, loopPieces: drawn.length - leadF.length,
    leadLayer: !!app.map.getLayer("route-lead") && JSON.stringify(app.map.getPaintProperty("route-lead", "line-dasharray")), dotToJoinM: dot ? +gap(dot.geometry.coordinates, J.join).toFixed(2) : null };
  // the detour 250 m into the lead-in: one reroute, back to the same join point, then the same loop
  for (const t0 = performance.now(); s.reroutes < 1 && performance.now() - t0 < 60000;) await sleep(200);
  const r1 = ride.route, log = s.rerouteLog[0] || {};
  const reroute = { reroutes: s.reroutes, leadIn: log.leadIn, newLeadM: Math.round(J.at), loopM: Math.round(r1.length - J.at), sameLoop: J.loop === loop, endToJoinM: +gap(r1.coords.at(-1), J.join).toFixed(2),
    leadEndToJoinM: J.lead ? +gap(J.lead.coords.at(-1), J.join).toFixed(2) : null, fixToStartM: log.at ? Math.round(gap(log.at, r1.coords[0])) : null, reachedYet: J.reached };
  // on to the loop
  for (const t0 = performance.now(); !J.reached && performance.now() - t0 < 120000;) await sleep(200);
  await sleep(4000);   // long enough for a repeat, if there were one
  const onLoop = said.filter((x) => /^You're on the loop/.test(x.text)), leadSaid = said.filter((x) => /to the start of the loop$/.test(x.text));
  const reached = { reached: J.reached, onLoop: onLoop.map((x) => x.text), leadSaid: leadSaid.map((x) => x.text), tonesWithIt: onLoop[0] ? tones.filter((t) => t <= onLoop[0].t && t > onLoop[0].t - 100).length : 0,
    notices: (J.notices || []).map((n) => n.key).join(), toasts: toasts.filter((x) => /loop/.test(x)), riderAtJoinM: Math.round(Math.abs(ride.d - J.reachAt)), rerouting: said.filter((x) => x.text === "Rerouting").length };
  C.voice.say = say;
  BikeI18n.lang = "fr"; const fr = [BikeI18n.t("leadInLoop", { d: "1,1 km" }), BikeI18n.t("onLoop", { d: "10 km" }), BikeI18n.t("leadInRide", { d: "4 km" }), BikeI18n.t("onRide", { d: "56 km" })]; BikeI18n.lang = "en";
  app.endRide();
  const restored = (await app.map.getSource("route").getData()).features.length === C.routePiecesGeoJSON(planned).features.length;
  const ok = start.kind === "lead" && start.ms < 250 && start.routed >= 2 && start.leadM > 500 && start.leadM < 2500 && start.toNearestM && start.leadM <= start.toNearestM + 1
    && start.loopM === start.plannedM && Math.abs(start.routeM - start.leadM - start.plannedM) <= 1 && start.riderToStartM < 60 && start.endToJoinM < 0.01 && start.leadEndToJoinM < 0.01
    && start.joinToUsualStartM > 300 && Math.abs(start.leadDrawnM - start.leadM) <= start.leadPieces && start.loopPieces > 0 && start.leadLayer === "[0,1.7]" && start.dotToJoinM < 0.01
    && reroute.reroutes === 1 && reroute.leadIn === true && reroute.sameLoop && Math.abs(reroute.loopM - start.plannedM) <= 1 && reroute.endToJoinM < 0.01 && reroute.leadEndToJoinM < 0.01
    && reroute.fixToStartM !== null && reroute.fixToStartM < 70 && !reroute.reachedYet
    && reached.reached && reached.onLoop.length === 1 && reached.onLoop[0] === "You're on the loop: 10 km to go" && reached.leadSaid.length === 1 && /^1\.\d km to the start of the loop$/.test(reached.leadSaid[0])
    && reached.tonesWithIt === 2 && reached.notices === "leadInLoop,onLoop" && reached.toasts.length === 2 && reached.riderAtJoinM < 400 && reached.rerouting === 1
    && /jusqu'au début de la boucle$/.test(fr[0]) && /^Vous êtes sur la boucle : encore 10 km$/.test(fr[1]) && /départ du parcours$/.test(fr[2]) && /sur le parcours/.test(fr[3]) && restored;
  return { ok, start, reroute, reached, fr, restored };
}));

// The out-and-back (Pointe-Claire) joins at one of its two ends; at a loop's own start the ride is the planned one; the preview (no GPS) and a
// refused location start at the usual start, exactly as before: no planning, no lead-in, no notices.
await run("classic rides from where you are: out-and-back ends; the usual start, the preview and a refused location unchanged", `${APP}?classic=plateau&gps=replay&gpsdeny`, async (page) => page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.__app, s = app.state, C = BikeCommon, gap = (a, b) => C.distM(a[0], a[1], b[0], b[1]), w = { w: BikeRouter.PROFILES.bikemax.w, hill: 4 };
  const pc = app.classicRoute(window.CLASSICS.findIndex((c) => c.id === "pointeclaire")), turn = pc.wayAt[2], ends = [0, turn];
  const outback = [[-73.8256, 45.434], [-73.57, 45.486]].map((here) => { const j = C.planJoin(app.router, pc, here, { w, ends });
    return { kind: j.kind, joinAt: Math.round(j.joinAt), leadM: j.lead ? Math.round(j.lead.length) : 0, rideM: j.route ? Math.round(j.route.length - (j.lead ? j.lead.length : 0)) : 0,
      leadEndToJoinM: j.lead ? +gap(j.lead.coords.at(-1), j.join).toFixed(2) : null, ms: j.ms }; });
  const planned = s.routes[0].r, atStart = C.planJoin(app.router, planned, planned.coords[0], { w });
  const leadDrawn = async () => (await app.map.getSource("route").getData()).features.filter((f) => f.properties.lead === 1).length;
  // the preview: the simulated ride on the planned loop, from its start
  document.querySelector("#ride-preview").click();
  await sleep(1200); const d1 = s.ride ? s.ride.d : -1;
  for (const t0 = performance.now(); s.ride && s.ride.d <= d1 && performance.now() - t0 < 15000;) await sleep(100);   // slow machines draw few frames
  const preview = { sim: !!s.ride && !s.ride.gps, samePlanned: !!s.ride && s.ride.route === planned, join: s.join, leadDrawn: await leadDrawn(), advanced: !!s.ride && s.ride.d > d1 && d1 >= 0 && d1 < 400 };
  app.endRide();
  // a refused location: the ride waits on the planned loop, then the calm message; nothing was planned
  document.querySelector("#ride-go").click();
  const waiting = { samePlanned: !!s.ride && s.ride.route === planned, join: s.join };
  for (const t0 = performance.now(); document.querySelector("#notice").hidden && performance.now() - t0 < 8000;) await sleep(100);
  const ends2 = (await app.map.getSource("ends").getData()).features;
  const refused = { notice: document.querySelector("#notice").hidden ? "" : document.querySelector("#notice-text").textContent.slice(0, 40), ride: s.ride, join: s.join, leadDrawn: await leadDrawn(),
    planned: (await app.map.getSource("route").getData()).features.length === C.routePiecesGeoJSON(planned).features.length, dotAtStart: !!ends2[0] && gap(ends2[0].geometry.coordinates, planned.coords[0]) < 0.01 };
  const ok = outback[0].kind === "lead" && Math.abs(outback[0].joinAt - turn) <= 1 && outback[0].leadM > 300 && outback[0].leadEndToJoinM < 0.01 && Math.abs(outback[0].rideM - pc.length) <= 1
    && outback[1].kind === "lead" && outback[1].joinAt === 0 && outback[1].leadM > 300 && Math.abs(outback[1].rideM - pc.length) <= 1 && atStart.kind === "start" && !atStart.route
    && preview.sim && preview.samePlanned && preview.join === null && preview.leadDrawn === 0 && preview.advanced
    && waiting.samePlanned && waiting.join === null && /can't use your location/.test(refused.notice) && refused.ride === null && refused.join === null && refused.leadDrawn === 0 && refused.planned && refused.dotAtStart;
  return { ok, turnM: Math.round(turn), outback, atStart: atStart.kind, preview, waiting, refused };
}));

await run("GPS: location refused shows a calm message, and the preview still works", `${APP}?trip=montroyal&gps=1`, async (page) => page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const s = window.__app.state;
  const previewLink = !!document.querySelector("#ride-preview");
  document.querySelector("#ride-go").click();   // headless Edge refuses location when nobody grants it
  const t0 = performance.now();
  while (document.querySelector("#notice").hidden && performance.now() - t0 < 8000) await sleep(100);
  const notice = document.querySelector("#notice").hidden ? "" : document.querySelector("#notice-text").textContent;
  const back = { ride: s.ride === null, panel: !document.querySelector("#panel").hidden, hudHidden: document.querySelector("#ride-hud").hidden, previewButton: !document.querySelector("#notice-preview").hidden };
  window.__app.setLang("fr"); const fr = document.querySelector("#notice-text").textContent; window.__app.setLang("en");
  document.querySelector("#notice-preview").click();
  await sleep(1200); const d1 = s.ride ? s.ride.d : -1;
  for (const t0 = performance.now(); s.ride && s.ride.d <= d1 && performance.now() - t0 < 15000;) await sleep(100);   // slow machines draw few frames
  const d2 = s.ride ? s.ride.d : -1;
  const preview = { sim: !!s.ride && !s.ride.gps, speedShown: !document.querySelector("#ride-speed").hidden, gpsHidden: document.querySelector("#ride-gps").hidden, noticeGone: document.querySelector("#notice").hidden };
  return { ok: previewLink && /can't use your location/.test(notice) && /accès à votre position/.test(fr) && back.ride && back.panel && back.hudHidden && back.previewButton
      && preview.sim && preview.speedShown && preview.gpsHidden && preview.noticeGone && d1 >= 0 && d2 > d1,
    previewLink, notice: notice.slice(0, 70), fr: fr.slice(0, 50), back, preview, previewAdvanced: [Math.round(d1), Math.round(d2)] };
}));

await run("GPS: the browser's own location moves the ride", `${APP}?trip=montroyal&gps=1`, async (page, ctx) => {
  // positions along the planned route, fed one by one through the browser's real geolocation
  const pts = await page.evaluate(() => { const cur = BikeCommon.buildCursor(window.__app.state.routes[0].r);
    return Array.from({ length: 15 }, (_, i) => { const p = cur.at(40 + i * 10); return [p.lon, p.lat]; }); });
  await ctx.setGeolocation({ longitude: pts[0][0], latitude: pts[0][1], accuracy: 8 });
  await page.evaluate(() => { document.querySelector("#ride-go").click(); window.__flatRide(); });   // flat camera on software WebGL: long frames would merge several of the positions below
  for (const [lon, lat] of pts) { await ctx.setGeolocation({ longitude: lon, latitude: lat, accuracy: 8 }); await page.waitForTimeout(450); }
  await until(page, () => window.__app.state.ride && window.__app.state.ride.d > 140);   // the ride catches up with the last position (180 m)
  return page.evaluate(() => {
    const s = window.__app.state, r = s.ride, status = document.querySelector("#ride-gps").textContent;
    const out = { gps: !!(r && r.gps), fixes: r && r.stats.fixes, d: r && Math.round(r.d), status, rider: getComputedStyle(document.querySelector(".rider-badge")).visibility, reroutes: s.reroutes };
    out.ok = out.gps && out.fixes >= 8 && out.d > 140 && /km\/h/.test(status) && /±8 m/.test(status) && out.rider === "visible" && out.reroutes === 0;
    window.__app.endRide();
    return out;
  });
}, { width: 1440, height: 900 }, { permissions: ["geolocation"], geolocation: { latitude: 45.5246, longitude: -73.58165, accuracy: 8 } });

await run("phone: GPS ride bar, preview link", `${APP}?trip=rachel&gps=replay&gpsx=2&safe=62,34`, async (page) => page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.__app, s = app.state, go = document.querySelector("#ride-go"), pv = document.querySelector("#ride-preview");
  const link = { coarse: matchMedia("(pointer: coarse)").matches, preview: !!pv, below: !!pv && pv.getBoundingClientRect().top >= go.getBoundingClientRect().bottom, text: pv && pv.textContent };
  go.click();
  for (const t0 = performance.now(); !/km\/h/.test(document.querySelector("#ride-gps").textContent) && performance.now() - t0 < 20000;) await sleep(100);   // first fixes in
  await sleep(1500);
  const bar = document.querySelector(".ride-bar").getBoundingClientRect();
  const shown = [...document.querySelectorAll(".ride-buttons > *")].filter((el) => !el.hidden);
  const ui = { gps: !!(s.ride && s.ride.gps), shown: shown.map((el) => el.id).join(","), status: document.querySelector("#ride-gps").textContent,
    fits: shown.every((el) => { const r = el.getBoundingClientRect(); return r.left >= bar.left - 0.5 && r.right <= bar.right + 0.5 && r.bottom <= bar.bottom + 0.5; }),
    scrollW: document.documentElement.scrollWidth, innerW: innerWidth };
  app.endRide(); pv.click(); await sleep(800);
  const preview = { sim: !!s.ride && !s.ride.gps, speedShown: !document.querySelector("#ride-speed").hidden, gpsHidden: document.querySelector("#ride-gps").hidden };
  app.endRide();
  return { ok: link.coarse && link.preview && link.below && link.text === "Preview the ride" && ui.gps && ui.shown === "ride-sound,ride-view,ride-gps,ride-exit" && /km\/h/.test(ui.status)
      && ui.fits && ui.scrollW <= ui.innerW && preview.sim && preview.speedShown && preview.gpsHidden, link, ui, preview };
}), { width: 402, height: 874 }, { hasTouch: true, isMobile: true });

// ------------------------------------------------------------------ first test ride fixes (2026-11-01): music after prompts, shields, place names, wind, ride summary
// The audio session is stubbed here: Chromium has no navigator.audioSession, so this checks what the app asks for, not what an iPhone does with it.
await run("audio session: transient while a prompt or chime plays, auto after (stubbed)", `${APP}?trip=montroyal&gps=replay&gpsx=3`, async (page) => page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const C = BikeCommon, app = window.__app, log = [];
  const as = { t: "auto", get type() { return this.t; }, set type(v) { this.t = v; log.push(v); } };
  Object.defineProperty(navigator, "audioSession", { value: as, configurable: true });
  const spoken = [];
  Object.defineProperty(window, "speechSynthesis", { value: { getVoices: () => [], cancel() {}, speak: (u) => spoken.push(u) }, configurable: true });
  const r = {};
  C.voice.enabled = true;
  C.voice.say("Turn left"); r.during = as.type; spoken[0].onend(); r.afterEnd = as.type;
  C.voice.say("Turn right"); r.duringErr = as.type; spoken[1].onerror({}); r.afterErr = as.type;
  C.voice.say("A"); C.voice.say("B"); spoken[2].onend(); r.overlapMid = as.type; spoken[3].onend(); r.overlapEnd = as.type;   // an old prompt ending must not drop a newer one
  C.audioSession.begin(60); r.duringTimer = as.type; await sleep(250); r.afterTimer = as.type;                           // the timeout safety net
  C.voice.enabled = false;
  document.querySelector("#ride-go").click(); r.rideTap = as.type;   // "Let's ride!" unlocks the chime inside the tap
  await sleep(300); app.endRide(); await sleep(3200); r.afterRide = as.type;   // nothing is left holding the session once the sounds are over
  Object.defineProperty(navigator, "audioSession", { value: undefined, configurable: true });   // an older Safari or another browser: no API, no error
  let threw = false; C.voice.enabled = true; try { C.voice.say("x"); C.voice.prime(); } catch (e) { threw = true; }
  const ok = r.during === "transient" && r.afterEnd === "auto" && r.duringErr === "transient" && r.afterErr === "auto" && r.overlapMid === "transient" && r.overlapEnd === "auto"
    && r.duringTimer === "transient" && r.afterTimer === "auto" && r.rideTap === "transient" && r.afterRide === "auto" && !threw;
  return { ok, ...r, threw, log: log.join(",") };
}));

await run("basemap: road-number shields hidden; place names off the map while riding, back after", `${APP}?trip=montroyal&gps=replay&gpsx=3`, async (page) => page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.__app, map = app.map, layers = map.getStyle().layers;
  const refs = layers.filter((l) => l.type === "symbol" && (/shield/.test(l.id) || JSON.stringify((l.layout || {})["text-field"] || "").includes('"ref"')));
  const visibleRefs = refs.filter((l) => map.getLayoutProperty(l.id, "visibility") !== "none");
  const streetNames = layers.filter((l) => /^highway-name/.test(l.id) && map.getLayoutProperty(l.id, "visibility") !== "none").length;
  const poiIds = layers.filter((l) => /^poi-/.test(l.id)).map((l) => l.id);
  const op = () => poiIds.map((id) => map.getPaintProperty(id, "text-opacity"));
  const before = op();
  document.querySelector("#ride-go").click(); window.__flatRide(); await sleep(600);
  const riding = op(), metroOn = document.querySelector('#layers input[data-layer="metro"]').checked;
  const metroIcon = map.getLayoutProperty("poi-metro", "visibility");   // icons stay (metro stations are the ones kept during a ride)
  app.endRide(); await sleep(300);
  const after = op();
  const ok = visibleRefs.length === 0 && poiIds.length > 0 && before.every((v) => v === 1) && riding.every((v) => v === 0) && after.every((v) => v === 1)
    && metroIcon === (metroOn ? "visible" : "none") && (refs.length === 0 || streetNames > 0);
  return { ok, shieldLayers: refs.map((l) => l.id), visibleShields: visibleRefs.map((l) => l.id), streetNameLayers: streetNames, poiLayers: poiIds.length, before, riding, after, metroIcon };
}));

await run("wind & rain during a ride: radar stays, streaks stop, a still wind badge shows, all restored after", `${APP}?trip=montroyal&wx=1&gps=replay&gpsx=3`, async (page) => page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.__app, s = app.state, map = app.map, vis = (id) => map.getLayoutProperty(id, "visibility");
  for (const t0 = performance.now(); !s.wxData && performance.now() - t0 < 20000;) await sleep(100);
  const before = { radar: vis("radar"), streaks: !document.querySelector("#wind").hidden, badge: !document.querySelector("#wind-badge").hidden };
  document.querySelector("#ride-go").click(); window.__flatRide();
  await sleep(1500);
  const badge = document.querySelector("#wind-badge"), txt = () => `${document.querySelector("#wind-speed").textContent} | ${document.querySelector("#wind-kind").textContent}`;
  const during = { radar: vis("radar"), streaks: !document.querySelector("#wind").hidden, badge: !badge.hidden, text: txt(), arrow: document.querySelector("#wind-arrow").style.transform };
  // the badge changes every 10 s or after a corner, never every frame
  let changes = 0; const mo = new MutationObserver((l) => (changes += l.length)); mo.observe(badge, { subtree: true, childList: true, characterData: true, attributes: true });
  await sleep(3000); mo.disconnect();
  app.setLang("fr"); const fr = txt(); app.setLang("en");
  app.endRide(); await sleep(400);
  const after = { radar: vis("radar"), streaks: !document.querySelector("#wind").hidden, badge: !document.querySelector("#wind-badge").hidden };
  const calmOk = s.wxData.now.wind < 3, kindsEn = /(Headwind|Tailwind|Crosswind)$/, kindsFr = /(Vent de face|Vent de dos|Vent de côté)$/;
  const textOk = calmOk ? /Calm/.test(during.text) : new RegExp(`^${Math.round(s.wxData.now.wind)} km/h \\| `).test(during.text) && kindsEn.test(during.text);
  const ok = !!s.wxData && before.radar === "visible" && before.streaks && !before.badge && during.radar === "visible" && !during.streaks && during.badge && textOk
    && (calmOk || kindsFr.test(fr)) && changes <= 12 && after.radar === "visible" && after.streaks && !after.badge;
  return { ok, before, during, fr, changes, after, wind: s.wxData && s.wxData.now };
}));

// ---- the end-of-ride summary ----
await run("ride summary: numbers, ridden path, Done clears it; End shows it; the preview doesn't", `${APP}?trip=montroyal&gps=replay&gpsx=4`, async (page) => {
  const posts = []; page.on("request", (rq) => { if (rq.method() !== "GET" && rq.method() !== "OPTIONS") posts.push(rq.method() + " " + rq.url()); });   // the track must never be sent anywhere
  // the arithmetic on made-up fixes: a 1 km ride at 18 km/h with a few metres of noise, a 20 m climb, a stretch with no bike path, and a stop at a light
  const unit = await page.evaluate(() => {
    const C = BikeCommon; let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2, lat0 = 45.5, lon0 = -73.6, k = 111320 * Math.cos((lat0 * Math.PI) / 180);
    const ride = Array.from({ length: 201 }, (_, i) => ({ lon: lon0 + (rnd() * 2.5) / k, lat: lat0 + (i * 5 + rnd() * 2.5) / 110540, t: 1e12 + i * 1000, acc: 6, v: 5, z: 30 + i * 0.1 + rnd() * 0.3, d: i * 5, gap: i > 100 && i < 140 }));
    const A = C.rideSummary(ride);
    const still = Array.from({ length: 120 }, (_, i) => ({ lon: lon0 + (rnd() * 3) / k, lat: lat0 + (rnd() * 3) / 110540, t: 1e12 + i * 1000, acc: 6, v: 0, z: 30 + rnd() * 0.3, d: 0, gap: false }));
    const B = C.rideSummary(still);
    return { A: A && { dist: Math.round(A.distanceM), elapsed: A.elapsedS, kmh: +A.avgKmh.toFixed(1), gain: +A.gainM.toFixed(1), loss: +A.lossM.toFixed(1), share: +A.pathShare.toFixed(2) },
      B: B && { dist: Math.round(B.distanceM), gain: B.gainM, loss: B.lossM }, one: C.rideSummary([ride[0]]) };
  });
  const unitOk = !!unit.A && Math.abs(unit.A.dist - 1000) <= 100 && unit.A.elapsed === 200 && Math.abs(unit.A.kmh - 18) <= 2 && Math.abs(unit.A.gain - 20) <= 2 && unit.A.loss < 2
    && Math.abs(unit.A.share - 0.8) <= 0.06 && (!unit.B || (unit.B.dist < 20 && unit.B.gain === 0 && unit.B.loss === 0)) && unit.one === null;
  // a replayed GPS ride to the end: 420 m from the end of the route, so it arrives
  const ride = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const app = window.__app, s = app.state, total = s.routes[s.sel].r.length;
    window.__store0 = Object.keys(localStorage).sort().join();
    app.startGpsRide({ replay: { speedup: 4, startAt: Math.max(0, total - 420) } }); window.__flatRide();
    const r = s.ride, geo = r.geo, t0 = performance.now();
    while (!r.arrived && performance.now() - t0 < 90000) await sleep(200);
    window.__trail = r.trail.slice(); window.__log = geo.log.slice();
    return { arrived: r.arrived, fixes: r.trail.length, hiddenBefore: document.querySelector("#ride-summary").hidden };
  });
  await until(page, () => !document.querySelector("#ride-summary").hidden, null, 12000);
  await until(page, () => !window.__app.map.isMoving(), null, 20000);
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))));
  const shown = await page.evaluate(async () => {
    const app = window.__app, s = app.state, map = app.map, C = BikeCommon, sum = s.summary, el = (id) => document.querySelector(id);
    const trail = window.__trail, log = window.__log, last = trail[trail.length - 1], first = trail[0];
    const i0 = log.findIndex((e) => e.fix[0] === first.lon && e.fix[1] === first.lat), i1 = log.findIndex((e) => e.fix[0] === last.lon && e.fix[1] === last.lat);
    let truth = 0; for (let i = Math.max(1, i0 + 1); i <= i1; i++) truth += C.distM(log[i - 1].lon, log[i - 1].lat, log[i].lon, log[i].lat);   // the pretend rider's true path, before the noise
    const b = map.getBounds(), line = sum && sum.line, inView = !!line && line.every((c) => c[0] >= b.getWest() && c[0] <= b.getEast() && c[1] >= b.getSouth() && c[1] <= b.getNorth());
    const rect = el("#ride-summary").getBoundingClientRect();
    return { visible: !el("#ride-summary").hidden, panelHidden: el("#panel").hidden, hudHidden: el("#ride-hud").hidden, ended: s.ride === null,
      distanceM: sum && Math.round(sum.distanceM), truthM: Math.round(truth), ratio: sum && +(sum.distanceM / truth).toFixed(3), elapsedS: sum && Math.round(sum.elapsedS), kmh: sum && +sum.avgKmh.toFixed(1),
      gain: sum && +sum.gainM.toFixed(1), loss: sum && +sum.lossM.toFixed(1), share: sum && sum.pathShare, hasElev: sum && sum.hasElev,
      texts: ["#rs-distance", "#rs-time", "#rs-speed", "#rs-climb", "#rs-descent", "#rs-paths"].map((id) => el(id).textContent), inView,
      layer: !!map.getLayer("ridden-line"), layerShown: map.getLayoutProperty("ridden-line", "visibility") !== "none", features: map.querySourceFeatures("ridden").length,
      focused: document.activeElement === el("#ride-summary"), pitch: Math.round(map.getPitch()), cardInside: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
      done44: el("#rs-done").getBoundingClientRect().height >= 44, store: Object.keys(localStorage).sort().join() === window.__store0 };
  });
  // "Done": the summary and the ridden path are gone and the normal view is back
  await page.click("#rs-done");
  await until(page, () => window.__app.map.querySourceFeatures("ridden").length === 0, null, 8000);
  const done = await page.evaluate(() => { const a = window.__app, el = (id) => document.querySelector(id);
    return { summaryHidden: el("#ride-summary").hidden, stateCleared: a.state.summary === null, features: a.map.querySourceFeatures("ridden").length,
      panel: !el("#panel").hidden, controls: !el(".map-controls").hidden }; });
  // "End" part-way shows it too (after about 130 m); the preview ride shows none
  const end = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const app = window.__app, s = app.state, total = s.routes[s.sel].r.length;
    app.startGpsRide({ replay: { speedup: 4, startAt: Math.max(0, total - 900) } }); window.__flatRide();
    for (const t0 = performance.now(); s.ride.trail.length < 40 && performance.now() - t0 < 60000;) await sleep(200);
    document.querySelector("#ride-exit").click(); await sleep(300);
    const gps = { visible: !document.querySelector("#ride-summary").hidden, distanceM: s.summary && Math.round(s.summary.distanceM) };
    document.querySelector("#rs-done").click(); await sleep(300);
    app.startRide(); await sleep(800); document.querySelector("#ride-exit").click(); await sleep(300);
    return { gps, preview: { visible: !document.querySelector("#ride-summary").hidden, panel: !document.querySelector("#panel").hidden } };
  });
  const f = shown;
  const ok = unitOk && ride.arrived && ride.hiddenBefore && f.visible && f.panelHidden && f.hudHidden && f.ended && f.ratio >= 0.9 && f.ratio <= 1.1 && f.elapsedS > 0 && f.kmh > 10 && f.kmh < 30
    && f.gain >= 0 && f.loss >= 0 && f.hasElev && f.texts.slice(0, 3).every((x) => x.length > 0) && f.inView && f.layer && f.layerShown && f.features > 0 && f.focused && f.pitch === 0 && f.cardInside && f.done44 && f.store
    && done.summaryHidden && done.stateCleared && done.features === 0 && done.panel && done.controls
    && end.gps.visible && end.gps.distanceM >= 50 && !end.preview.visible && end.preview.panel && posts.length === 0;
  return { ok, unit, ride, shown, done, end, posts };
});

await run("phone: ride summary fits 390x844 and 360x640 (screen reader name, 44 px buttons, nothing under the ride bar)", `${APP}?trip=rachel&gps=replay&gpsx=2&safe=47,34`, async (page) => {
  // a ridden path made up from the route itself: this group is about the layout, the summary test above is about the numbers
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const app = window.__app, s = app.state, C = BikeCommon;
    document.querySelector("#ride-go").click(); window.__flatRide();
    for (const t0 = performance.now(); !s.ride && performance.now() - t0 < 5000;) await sleep(50);
    const ride = s.ride, r = ride.route; ride.trail.length = 0;
    for (let d = 0; d < Math.min(r.length, 3200); d += 6) { const p = ride.cursor.at(d); ride.trail.push({ lon: p.lon, lat: p.lat, t: 1e12 + (d / 5) * 1000, acc: 5, v: 5, z: C.elevAt(r, d), d, gap: d > 900 && d < 1100 }); }
    await sleep(300); app.endRide({ summary: true });
  });
  await until(page, () => !document.querySelector("#ride-summary").hidden && !window.__app.map.isMoving(), null, 20000);
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))));
  const measure = () => settled(page, () => {
    const el = (id) => document.querySelector(id), card = el("#ride-summary"), c = card.getBoundingClientRect(), vv = window.visualViewport;
    const probe = document.createElement("div"); probe.style.cssText = "position:fixed;visibility:hidden;padding:var(--safe-top) 0 var(--safe-bottom)"; document.body.appendChild(probe);
    const cs = getComputedStyle(probe), top = parseFloat(cs.paddingTop) || 0, bottom = parseFloat(cs.paddingBottom) || 0; probe.remove();
    const btns = [...card.querySelectorAll("button")].filter((b) => !b.hidden).map((b) => Math.round(b.getBoundingClientRect().height));
    const hud = [".ride-hud", ".turn-card", ".ride-bar", ".hill-card", ".gap-card"].every((q) => el(q).getClientRects().length === 0);   // none of the ride's cards is still on screen under it
    return { w: Math.round(vv.width), h: Math.round(vv.height), left: Math.round(c.left), right: Math.round(c.right), top: Math.round(c.top), bottom: Math.round(c.bottom), safeBottom: bottom, safeTop: top,
      noScroll: card.scrollHeight <= card.clientHeight + 1, buttons: btns, hud, label: card.getAttribute("aria-labelledby") && el("#" + card.getAttribute("aria-labelledby")).textContent,
      scrollW: document.documentElement.scrollWidth, innerW: innerWidth };
  });
  const fits = (m) => m.left >= 0 && m.right <= m.w && m.top >= m.safeTop && m.bottom <= m.h - m.safeBottom + 0.5 && m.noScroll && m.buttons.length > 0 && m.buttons.every((h) => h >= 44) && m.hud && m.scrollW <= m.innerW;
  const a = await measure();
  if (process.env.PISTE_SHOT_DIR) await page.screenshot({ path: `${process.env.PISTE_SHOT_DIR}/ride-summary-390x844.png` });   // for looking at it by hand
  await page.setViewportSize({ width: 360, height: 640 }); await page.waitForTimeout(400);
  const b = await measure();
  const fr = await page.evaluate(() => { window.__app.setLang("fr"); return document.querySelector("#rs-title").textContent + " | " + document.querySelector("#rs-done").textContent + " | " + document.querySelector("#rs-climb").textContent; });
  const c = await measure();
  return { ok: a.w === 390 && fits(a) && b.w === 360 && fits(b) && fits(c) && /Résumé du trajet \| Terminé \| (\+\d+|0) m/.test(fr) && a.label === "Ride summary", a, b, c, fr };
}, { width: 390, height: 844 }, { hasTouch: true, isMobile: true });

// ------------------------------------------------------------------ welcome card, feedback and guided tour (2026-10-30; a-positron/tour.js)
const DEMO_MIN = 250;   // metres of each kind of bike path (protected, shared, none) the tour's demo route must have, so the colours step shows all three
const welcomeUp = () => !!window.pisteTour && window.pisteTour.welcome === "shown" && !document.querySelector("#welcome").hidden;
const welcomeGone = () => document.querySelector("#welcome").hidden;
// In the page: the welcome card is on screen, inside the safe areas, needs no scrolling, and its buttons are 44 px or taller
const welcomeFits = () => {
  const card = document.querySelector(".welcome-card"), c = card.getBoundingClientRect();
  const probe = document.createElement("div"); probe.style.cssText = "position:fixed;visibility:hidden;padding:var(--safe-top) 0 var(--safe-bottom)"; document.body.appendChild(probe);
  const cs = getComputedStyle(probe), top = parseFloat(cs.paddingTop) || 0, bottom = parseFloat(cs.paddingBottom) || 0; probe.remove();
  const hits = [...card.querySelectorAll("button, a")].map((b) => Math.round(b.getBoundingClientRect().height));
  return { ok: c.left >= 0 && c.right <= innerWidth && c.top >= top && c.bottom <= innerHeight - bottom && card.scrollHeight <= card.clientHeight + 1 && hits.every((h) => h >= 44),
    view: [innerWidth, innerHeight], safe: [top, bottom], card: [c.left, c.top, c.width, c.height].map(Math.round), hits };
};
// In the page: what the tour must have put back (compared before and after it)
const appSnapshot = async () => {
  const a = window.__app, s = a.state, m = a.map, c = m.getCenter();
  return { sheet: document.querySelector("#panel").dataset.sheet, tab: s.tab, smode: s.smode, winter: s.winter, from: document.querySelector("#from").value, to: document.querySelector("#to").value,
    points: [!!s.from, !!s.to], routes: s.routes.length, sel: s.sel, drawn: (await m.getSource("route").getData()).features.length, pins: document.querySelectorAll(".end-pin").length,
    legend: document.querySelector("#legend details").open, layers: !document.querySelector("#layers").hidden, scroll: Math.round(document.querySelector("#panel").scrollTop),
    zoom: +m.getZoom().toFixed(2), center: [+c.lng.toFixed(4), +c.lat.toFixed(4)], pitch: Math.round(m.getPitch()) };
};
// the card's scroll may land 1 px off after a restore (fractional scroll heights round differently): invisible, so allowed
const sameState = (a, b) => JSON.stringify({ ...a, scroll: 0 }) === JSON.stringify({ ...b, scroll: 0 }) && Math.abs((a.scroll || 0) - (b.scroll || 0)) <= 1;
// In the page: is the current step laid out right? Measured here, not taken from the tour's own bookkeeping where possible:
// every target is on screen (all of it inside the panel's visible part if it is in the panel; the route clear of the panel),
// a cut-out covers each target, and the callout is on screen, inside the safe areas, off the targets and off the cut-out's centre.
const tourStepCheck = () => {
  const x = window.pisteTour.info(), a = window.__app, W = innerWidth, H = innerHeight, problems = [];
  const panel = document.querySelector("#panel"), P = panel.getBoundingClientRect(), phone = matchMedia("(max-width: 760px)").matches;
  const probe = document.createElement("div"); probe.style.cssText = "position:fixed;visibility:hidden;padding:var(--safe-top) 0 var(--safe-bottom)"; document.body.appendChild(probe);
  const cs = getComputedStyle(probe), sTop = parseFloat(cs.paddingTop) || 0, sBottom = parseFloat(cs.paddingBottom) || 0; probe.remove();
  const R = (r) => ({ x: r.left, y: r.top, w: r.width, h: r.height });
  const inter = (p, q) => { const x0 = Math.max(p.x, q.x), y0 = Math.max(p.y, q.y), w = Math.min(p.x + p.w, q.x + q.w) - x0, h = Math.min(p.y + p.h, q.y + q.h) - y0; return w > 0 && h > 0 ? { x: x0, y: y0, w, h } : null; };
  const area = (r) => (r ? r.w * r.h : 0);
  const panelView = { x: P.left, y: P.top + (phone ? 30 : 0), w: P.width, h: P.height - (phone ? 30 : 0) };   // below the phone card's grab bar
  const targets = x.targets.map(({ spec }) => {
    let r, inPanel = false, shown = true;
    if (spec === "@route") {   // the selected route, projected here
      const sel = a.state.routes[a.state.sel]; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const c of sel.r.coords) { const p = a.map.project(c); x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
      r = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    } else {
      const els = spec.split(",").map((s) => document.querySelector(s)).filter((e) => e && e.getClientRects().length);
      if (!els.length) { problems.push(`${spec}: missing`); return { spec, vis: null }; }
      r = els.map((e) => R(e.getBoundingClientRect())).reduce((u, q) => { const x0 = Math.min(u.x, q.x), y0 = Math.min(u.y, q.y); return { x: x0, y: y0, w: Math.max(u.x + u.w, q.x + q.w) - x0, h: Math.max(u.y + u.h, q.y + q.h) - y0 }; });
      inPanel = els.some((e) => e.closest("#panel")); shown = els.every((e) => getComputedStyle(e).visibility !== "hidden");
    }
    const onScreen = r.w > 0 && r.h > 0 && r.x >= -0.5 && r.y >= -0.5 && r.x + r.w <= W + 0.5 && r.y + r.h <= H + 0.5;
    const seen = inPanel ? area(inter(r, panelView)) >= area(r) - 1 : spec !== "@route" || !inter(r, R(P));
    const vis = inter(r, inPanel ? panelView : { x: 0, y: 0, w: W, h: H });
    const hole = vis ? Math.max(0, ...x.holes.map((h) => area(inter(h, vis)) / area(vis))) : 0;
    if (!(shown && onScreen && seen && hole >= 0.9)) problems.push(`${spec}:${shown ? "" : " hidden"}${onScreen ? "" : " off screen"}${seen ? "" : " not in view"}${hole >= 0.9 ? "" : ` cut-out covers ${Math.round(hole * 100)}%`}`);
    return { spec, r: [r.x, r.y, r.w, r.h].map(Math.round), vis, hole: +hole.toFixed(2) };
  });
  const c = x.card, h0 = x.holes[0], centre = h0 && { x: h0.x + h0.w / 2, y: h0.y + h0.h / 2 };
  if (!(c.x >= -0.5 && c.x + c.w <= W + 0.5 && c.y >= sTop - 0.5 && c.y + c.h <= H - sBottom + 0.5)) problems.push("callout off screen");
  if (centre && centre.x > c.x && centre.x < c.x + c.w && centre.y > c.y && centre.y < c.y + c.h) problems.push("callout covers the cut-out centre");
  if (targets.some((tg) => tg.vis && area(inter(c, tg.vis)) > 2)) problems.push("callout covers a target");
  const small = [...document.querySelectorAll(".tour-card button")].filter((b) => b.getClientRects().length && getComputedStyle(b).visibility !== "hidden")
    .map((b) => { const r = b.getBoundingClientRect(); return { b, w: r.width, h: r.height }; }).filter((s) => s.h < 43.5 || s.w < 43.5);
  if (small.length) problems.push(`button(s) under 44 px: ${small.map((s) => `${s.b.className} ${s.w.toFixed(1)}x${s.h.toFixed(1)}`).join(", ")}`);
  if (phone && panel.dataset.sheet !== x.sheet) problems.push(`sheet ${panel.dataset.sheet}, wanted ${x.sheet}`);
  if (/^(INPUT|TEXTAREA)$/.test((document.activeElement || {}).tagName || "")) problems.push("a text field has focus");
  const words = (s) => s.trim().split(/\s+/).length;
  if (words(x.title) > 4 || words(x.text) > 20) problems.push(`too wordy: ${words(x.title)} / ${words(x.text)} words`);
  return { i: x.i, id: x.id, ok: !problems.length, problems, sheet: phone ? panel.dataset.sheet : undefined, card: [c.x, c.y, c.w, c.h].map(Math.round), targets: targets.map(({ spec, r, hole }) => ({ spec, r, hole })) };
};
const tourAt = (page, i) => until(page, (i) => { const x = window.pisteTour.info(); return x.open && x.i === i && x.settled; }, i, 20000);
const tourClosed = (page) => until(page, () => !window.pisteTour.info().open && document.querySelector(".tour").hidden && !window.__app.map.isMoving());
// walk the tour from step `from` to step `to`, checking each step (and, with backNext, that Back and Next lead to the step before and back)
async function tourWalk(page, from, to, backNext) {
  const steps = [];
  for (let i = from; i <= to; i++) {
    await tourAt(page, i);
    const chk = await page.evaluate(tourStepCheck);
    if (backNext && i > 0) {
      await page.click(".tour-back"); await tourAt(page, i - 1); const b = await page.evaluate(() => window.pisteTour.info().i);
      await page.click(".tour-next"); await tourAt(page, i); const n = await page.evaluate(() => window.pisteTour.info().i);
      chk.backNext = b === i - 1 && n === i; if (!chk.backNext) chk.ok = false;
    }
    steps.push(chk);
    if (i < to) await page.click(".tour-next");
  }
  return steps;
}
const brief = (steps) => steps.map((s) => (s.ok ? `${s.i + 1} ${s.id} ok` : `${s.i + 1} ${s.id}: ${s.problems.join("; ")}${s.backNext === false ? " back/next failed" : ""}`));

await run("welcome: first visit", APP, async (page, ctx) => {
  await until(page, welcomeUp, null, 30000);
  const en = await page.evaluate(() => {
    const c = document.querySelector(".welcome-card");
    return { title: c.querySelector("h2").textContent, mark: !!c.querySelector(".mark"), beta: c.querySelector(".beta-pill").textContent, betaText: c.querySelector(".beta-note p").textContent,
      tour: document.querySelector("#welcome-tour").textContent, explore: document.querySelector("#welcome-skip").textContent,
      fbTags: ["#welcome-feedback", "#feedback-link"].map((x) => document.querySelector(x).tagName).join(), tourTime: document.querySelector("#welcome-tour small").textContent,
      dialog: c.getAttribute("role") === "dialog" && c.getAttribute("aria-modal") === "true", focusInside: c.contains(document.activeElement), flag: localStorage.getItem("piste-welcomed") };
  });
  // "Send feedback" opens the dialog over the welcome card; Esc closes only the dialog and focus goes back to the link
  await page.click("#welcome-feedback");
  await until(page, () => !document.querySelector("#feedback").hidden);
  const overWelcome = await page.evaluate(() => ({ dialog: !document.querySelector("#feedback").hidden, welcomeShown: !document.querySelector("#welcome").hidden, welcomeInert: document.querySelector("#welcome").inert,
    focusInside: document.querySelector("#feedback-form").contains(document.activeElement), mail: document.querySelector("#fb-mail").getAttribute("href").startsWith("mailto:support@pistemtl.ca") }));
  await page.keyboard.press("Escape");
  await until(page, () => document.querySelector("#feedback").hidden);
  const afterEsc = await page.evaluate(() => ({ dialog: !document.querySelector("#feedback").hidden, welcomeShown: !document.querySelector("#welcome").hidden && window.pisteTour.welcome === "shown",
    focus: document.activeElement && document.activeElement.id }));
  await page.click("#welcome-skip");   // "Explore on my own"
  await until(page, welcomeGone);
  const closed = await page.evaluate(() => ({ hidden: document.querySelector("#welcome").hidden, flag: localStorage.getItem("piste-welcomed") }));
  await page.reload({ waitUntil: "load" });
  await until(page, () => !!window.pisteTour && !!window.pisteTour.welcome, null, 90000);
  const reload = await page.evaluate(() => ({ decided: window.pisteTour.welcome, hidden: document.querySelector("#welcome").hidden }));
  // French, on a first visit again; Esc means "Explore on my own"
  await page.evaluate(() => localStorage.removeItem("piste-welcomed"));
  await page.goto(BASE + APP + "?lang=fr", { waitUntil: "load" });
  await until(page, welcomeUp, null, 90000);
  const fr = await page.evaluate(() => ({ title: document.querySelector("#welcome-title").textContent, beta: document.querySelector(".beta-pill").textContent,
    tour: document.querySelector("#welcome-tour span").textContent, tourTime: document.querySelector("#welcome-tour small").textContent }));
  await page.keyboard.press("Escape");
  await until(page, welcomeGone);
  const frClosed = await page.evaluate(() => ({ hidden: document.querySelector("#welcome").hidden, flag: localStorage.getItem("piste-welcomed") }));
  // phone sizes: the card fits on screen and inside the safe areas (iPhone 13-16 with its notch and home bar, then a small 360 x 640 phone)
  const phones = [];
  for (const [w, h, safe] of [[390, 844, "47,34"], [360, 640, "20,0"]]) {
    await page.evaluate(() => localStorage.removeItem("piste-welcomed"));
    await page.setViewportSize({ width: w, height: h });
    await page.goto(BASE + APP + `?safe=${safe}`, { waitUntil: "load" });
    await until(page, welcomeUp, null, 90000);
    await page.evaluate(() => Promise.all(document.querySelector("#welcome").getAnimations({ subtree: true }).filter((a) => a.effect.getTiming().iterations !== Infinity).map((a) => a.finished)));   // its fade-in can still be running on a slow machine
    phones.push(await settled(page, welcomeFits));
  }
  // storage blocked (some private modes): the card still shows, once per page load, and closes without errors
  const p2 = await ctx.newPage(), errs2 = [];
  p2.on("pageerror", (e) => errs2.push(String(e)));
  p2.on("console", (m) => { if (m.type() === "error" && !/favicon|404|Failed to load resource/.test(m.text())) errs2.push(m.text()); });
  await p2.addInitScript(() => { Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new DOMException("The operation is insecure.", "SecurityError"); } }); });
  await p2.goto(BASE + APP, { waitUntil: "load" });
  await until(p2, welcomeUp, null, 90000);
  const blockedShown = await p2.evaluate(() => !document.querySelector("#welcome").hidden);
  await p2.click("#welcome-skip"); await until(p2, welcomeGone);
  const blocked = { shown: blockedShown, closed: await p2.evaluate(() => document.querySelector("#welcome").hidden), errors: errs2 };
  await p2.close();
  const checks = {   // named, so a failure says which one
    feedbackOverWelcome: overWelcome.dialog && overWelcome.welcomeShown && overWelcome.welcomeInert && overWelcome.focusInside && overWelcome.mail,
    escBackToWelcome: !afterEsc.dialog && afterEsc.welcomeShown && afterEsc.focus === "welcome-feedback",
    feedbackButtons: en.fbTags === "BUTTON,BUTTON", tourTime: en.tourTime === "1 min" && fr.tourTime === "1 min",
    english: en.title === "Welcome to Piste" && en.mark && en.beta === "Beta" && /can be wrong/.test(en.betaText) && /follow the road/i.test(en.betaText) && /Take the tour/.test(en.tour) && en.explore === "Explore on my own",
    firstVisit: en.dialog && en.focusInside && en.flag === null, closes: closed.hidden && closed.flag === "1", notAfterReload: reload.decided === "seen" && reload.hidden,
    french: fr.title === "Bienvenue dans Piste" && fr.beta === "Bêta" && fr.tour === "Faire la visite" && frClosed.hidden && frClosed.flag === "1",
    ...Object.fromEntries(phones.map((p, i) => [`phone${i + 1}Fits`, p.ok])), storageBlocked: blocked.shown && blocked.closed && !blocked.errors.length,
  };
  const bad = Object.keys(checks).filter((k) => !checks[k]);
  return { ok: !bad.length, ...(bad.length ? { error: "failed checks: " + bad.join(", ") } : {}), en, overWelcome, afterEsc, closed, reload, fr, frClosed, phones, blocked };
}, { width: 1440, height: 900 }, { fresh: true });

await run("tour: every step", APP, async (page) => {
  await until(page, welcomeUp, null, 30000);
  const before = await page.evaluate(appSnapshot);
  await page.click("#welcome-tour");
  // first pass, by keyboard: → and Enter go on, ← goes back; then Esc halfway, on the route-colours step with the demo route showing
  const pass1 = [];
  await tourAt(page, 0); pass1.push(await page.evaluate(tourStepCheck));
  await page.keyboard.press("ArrowRight"); await tourAt(page, 1); pass1.push(await page.evaluate(tourStepCheck));
  await page.keyboard.press("Enter"); await tourAt(page, 2); pass1.push(await page.evaluate(tourStepCheck));
  const demo = await page.evaluate(() => { const s = window.__app.state, bt = s.routes.length ? s.routes[s.sel].r.byTier.map(Math.round) : [0, 0, 0, 0, 0, 0];
    return { demo: window.pisteTour.info().demo, routes: s.routes.length, from: document.querySelector("#from").value, to: document.querySelector("#to").value, km: s.routes.length ? +(s.routes[s.sel].r.length / 1000).toFixed(1) : 0,
      protectedM: bt[0], sharedM: bt[2], noPathM: bt[3] + bt[4] }; });
  const stepIds = await page.evaluate(() => window.pisteTour.steps.join());
  await page.keyboard.press("ArrowLeft"); await tourAt(page, 1);
  const leftKey = await page.evaluate(() => window.pisteTour.info().i);
  await page.keyboard.press("ArrowRight"); await tourAt(page, 2);
  await page.keyboard.press("Escape");
  await tourClosed(page);
  await until(page, (b) => { const m = window.__app.map; return !m.isMoving() && Math.abs(m.getZoom() - b.zoom) < 0.01; }, before);
  const afterEsc = await page.evaluate(appSnapshot);
  // second pass: replay from the panel's footer, every step with Back and Next, and finish with "Let's go"
  await page.click("#tour-again");
  const pass2 = await tourWalk(page, 0, 8, true);
  const lastLabel = await page.evaluate(() => document.querySelector(".tour-next").textContent);
  await page.click(".tour-next");
  await tourClosed(page);
  await until(page, (b) => { const m = window.__app.map; return !m.isMoving() && Math.abs(m.getZoom() - b.zoom) < 0.01; }, before);
  const afterDone = await page.evaluate(appSnapshot);
  const focusBack = await page.evaluate(() => document.activeElement && document.activeElement.id);
  // with a route already on screen the tour uses it (no demo route); during a ride there is no "Take the tour"
  await page.goto(BASE + APP + "?trip=montroyal", { waitUntil: "load" });
  await page.waitForFunction(() => !!window.pisteTour, null, { timeout: 90000 });
  await page.evaluate(idle);   // the app's own move to the trip has ended
  const own0 = await page.evaluate(appSnapshot);
  await page.evaluate(() => window.pisteTour.start(2)); await tourAt(page, 2);
  const own = await page.evaluate(() => ({ demo: window.pisteTour.info().demo, from: document.querySelector("#from").value }));
  own.check = await page.evaluate(tourStepCheck);
  await page.keyboard.press("Escape"); await tourClosed(page);
  await until(page, (b) => { const m = window.__app.map; return !m.isMoving() && Math.abs(m.getZoom() - b.zoom) < 0.01; }, own0);
  const own1 = await page.evaluate(appSnapshot);
  const riding = await page.evaluate(() => { const a = window.__app; a.startRide("topdown"); const r = { button: document.querySelector("#tour-again").getClientRects().length > 0, started: window.pisteTour.start(0) }; a.endRide(); return r; });
  // one step per map button, top to bottom: 3D, weather, winter, layers
  const buttonSteps = pass2.slice(4, 8).map((st) => st.targets[0]);
  const buttonsDown = buttonSteps.map((tg) => tg.spec).join() === "#view-btn,#wx-btn,#winter-btn,#layers-btn" && buttonSteps.every((tg, k) => k === 0 || tg.r[1] > buttonSteps[k - 1].r[1]);
  // the colours step's demo route shows all three kinds: protected, shared and no bike path, DEMO_MIN metres or more of each, 2 to 5 km long
  const threeKinds = demo.protectedM >= DEMO_MIN && demo.sharedM >= DEMO_MIN && demo.noPathM >= DEMO_MIN && demo.km >= 2 && demo.km <= 5;
  const ok = stepIds === "search,style,colours,suggest,view3d,weather,winter,layers,feedback" && buttonsDown && threeKinds
    && pass1.every((s) => s.ok) && pass2.length === 9 && pass2.every((s) => s.ok) && demo.demo && demo.routes > 0 && demo.from === "Georges-Vanier metro" && leftKey === 1
    && sameState(before, afterEsc) && sameState(before, afterDone) && afterDone.drawn === 0 && afterDone.pins === 0 && lastLabel === "Let's go" && focusBack === "tour-again"
    && !own.demo && own.from === "Mont-Royal metro" && own.check.ok && sameState(own0, own1) && !riding.button && riding.started === false;
  return { ok, stepIds, buttonsDown, threeKinds, pass1: brief(pass1), pass2: brief(pass2), demo, leftKey, before, afterEsc, afterDone, lastLabel, focusBack, own: { demo: own.demo, from: own.from, check: own.check.problems }, ownRestored: sameState(own0, own1) || [own0, own1], riding,
    detail: pass2.map((s) => ({ id: s.id, card: s.card, targets: s.targets })) };
}, { width: 1440, height: 900 }, { fresh: true });

await run("phone: tour", `${APP}?safe=47,34`, async (page) => {
  // iPhone 13-16 size, with its notch and home bar: from the welcome card, every step, Back and Next once, "Let's go"
  await until(page, welcomeUp, null, 30000);
  const before = await page.evaluate(appSnapshot);
  await page.click("#welcome-tour");
  const big = await tourWalk(page, 0, 8, false);
  await page.click(".tour-back"); await tourAt(page, 7);
  const back = await page.evaluate(() => ({ i: window.pisteTour.info().i, sheet: document.querySelector("#panel").dataset.sheet }));
  await page.click(".tour-next"); await tourAt(page, 8);
  await page.click(".tour-next");
  await tourClosed(page);
  await until(page, (b) => { const m = window.__app.map; return !m.isMoving() && Math.abs(m.getZoom() - b.zoom) < 0.01; }, before);
  const after = await page.evaluate(appSnapshot);
  // a small 360 x 640 phone: open the card fully, scroll to the bottom, replay from the footer, and every step again
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto(BASE + APP + "?safe=20,0", { waitUntil: "load" });
  await page.waitForFunction(() => !!window.pisteTour, null, { timeout: 90000 });
  await page.evaluate(() => window.__app.setSheet("full")); await panelStill(page);
  const foot = await settled(page, () => { const p = document.querySelector("#panel"); p.scrollTop = p.scrollHeight; const r = p.getBoundingClientRect();
    return ["#feedback-link", "#tour-again"].map((s) => { const b = document.querySelector(s).getBoundingClientRect(); return b.top >= r.top && b.bottom <= r.bottom && b.height >= 44; }); });
  const before2 = await page.evaluate(appSnapshot);
  await page.click("#tour-again");
  const small = await tourWalk(page, 0, 8, false);
  await page.click(".tour-next");
  await tourClosed(page);
  await until(page, (b) => { const m = window.__app.map; return !m.isMoving() && Math.abs(m.getZoom() - b.zoom) < 0.01; }, before2);
  const after2 = await page.evaluate(appSnapshot);
  const ok = big.length === 9 && big.every((s) => s.ok) && back.i === 7 && sameState(before, after) && after.drawn === 0 && foot.every(Boolean)
    && small.length === 9 && small.every((s) => s.ok) && sameState(before2, after2);
  return { ok, phone390: brief(big), sheets390: big.map((s) => s.sheet).join(","), back, restored390: sameState(before, after), foot, phone360: brief(small),
    sheets360: small.map((s) => s.sheet).join(","), restored360: sameState(before2, after2), before2, after2, detail390: big.map((s) => ({ id: s.id, card: s.card, targets: s.targets })) };
}, { width: 390, height: 844 }, { hasTouch: true, isMobile: true, fresh: true });

// ------------------------------------------------------------------ search bars (2026-10-31): locator and pick buttons inside, pins outside, a clear x that drops the place
const searchSnap = () => { const a = window.__app, s = a.state;
  return a.map.getSource("route").getData().then((d) => ({ from: s.from && s.from.map((v) => +v.toFixed(4)), to: s.to && s.to.map((v) => +v.toFixed(4)), fromVal: document.querySelector("#from").value, toVal: document.querySelector("#to").value,
    routes: s.routes.length, cards: document.querySelectorAll("#routes .route-card").length, pins: document.querySelectorAll(".end-pin").length, drawn: d.features.length })); };
const setDest = () => { const a = window.__app, p = window.piste; p.setPoint("to", [-73.5745, 45.5163], "Test destination"); a.recompute(false); };   // Parc Jeanne-Mance-ish
await run("search bars: layout, x clears a place and its route, deleting the text does too, Use my location", `${APP}?trip=montroyal`, async (page) => {
  const layout = await page.evaluate(() => {
    const out = {};
    for (const which of ["from", "to"]) {
      const input = document.querySelector("#" + which), field = input.closest(".field"), f = field.getBoundingClientRect(), i = input.getBoundingClientRect();
      const pin = field.parentElement.querySelector(".pin"), pr = pin.getBoundingClientRect(), left = field.querySelector(which === "from" ? ".locate" : ".pick"), lr = left.getBoundingClientRect();
      const cl = field.querySelector(".clear"), cr = cl.getBoundingClientRect();
      out[which] = { pinOutside: !field.contains(pin) && pr.right <= f.left + 0.5, leftInside: lr.left >= f.left - 0.5 && lr.right <= i.left + 1, clearRight: getComputedStyle(cl).display !== "none" && cr.left >= i.right - 1 && cr.right <= f.right + 0.5,
        tap: [lr.width, lr.height, cr.width, cr.height].every((v) => v >= 43.5), icon: left.innerHTML, leftTitle: left.title };
    }
    return out;
  });
  const icons = layout.from.icon !== layout.to.icon && layout.from.leftTitle === "Use my location" && layout.to.leftTitle === "Pick the destination on the map";
  const start = await page.evaluate(searchSnap);
  // x on the destination: its point, marker, route and route cards go; the start stays
  await page.click('.clear[data-target="to"]');
  const afterTo = await page.evaluate(searchSnap);
  const clearHidden = await page.evaluate(() => getComputedStyle(document.querySelector('.clear[data-target="to"]')).display === "none");
  // x on the start too: nothing left
  await page.click('.clear[data-target="from"]');
  const afterBoth = await page.evaluate(searchSnap);
  // the x on a destination with a start only: the start stays, and putting the destination back routes again
  await page.evaluate(() => window.piste.setPoint("from", [-73.5822, 45.5247], "Mont-Royal metro"));
  await page.evaluate(setDest);
  const back = await page.evaluate(searchSnap);
  // emptying a field by typing does the same as the x
  await page.fill("#to", "");
  const typedTo = await page.evaluate(searchSnap);
  await page.evaluate(setDest);
  await page.fill("#from", "");
  const typedFrom = await page.evaluate(searchSnap);
  await page.fill("#to", "");
  const typedBoth = await page.evaluate(searchSnap);
  const free = await page.evaluate(() => ({ pick: window.__app.state.pick, tab: window.__app.state.tab }));
  const ok = layout.from.pinOutside && layout.to.pinOutside && layout.from.leftInside && layout.to.leftInside && layout.from.clearRight && layout.to.clearRight && layout.from.tap && layout.to.tap && icons
    && start.routes > 0 && start.pins === 2
    && afterTo.to === null && afterTo.toVal === "" && afterTo.routes === 0 && afterTo.cards === 0 && afterTo.drawn === 0 && afterTo.pins === 1 && !!afterTo.from && afterTo.fromVal === "Mont-Royal metro" && clearHidden
    && afterBoth.from === null && afterBoth.fromVal === "" && afterBoth.routes === 0 && afterBoth.cards === 0 && afterBoth.drawn === 0 && afterBoth.pins === 0
    && back.routes > 0 && back.pins === 2
    && typedTo.to === null && typedTo.routes === 0 && typedTo.cards === 0 && typedTo.drawn === 0 && typedTo.pins === 1 && !!typedTo.from
    && typedFrom.from === null && typedFrom.routes === 0 && typedFrom.drawn === 0 && typedFrom.pins === 1 && !!typedFrom.to
    && typedBoth.from === null && typedBoth.to === null && typedBoth.pins === 0 && typedBoth.drawn === 0 && free.pick === null;
  return { ok, layout, icons, start, afterTo, clearHidden, afterBoth, back, typedTo, typedFrom, typedBoth };
}, { width: 1440, height: 900 }, { geolocation: { latitude: 45.5232, longitude: -73.5865 }, permissions: ["geolocation"] });

await run("search bars: Use my location (location allowed) sets the start, and routes if there is a destination", `${APP}?trip=montroyal`, async (page) => {
  await page.click('.clear[data-target="from"]'); await page.click('.clear[data-target="to"]');
  await page.evaluate(() => window.piste.setPoint("to", [-73.5745, 45.5163], "Test destination"));
  await page.click("#locate");   // with a destination: routes at once
  await until(page, () => window.__app.state.fromLabel === "My location" && window.__app.state.routes.length > 0);
  const withDest = await page.evaluate(searchSnap);
  const busyOff = await page.evaluate(() => !document.querySelector("#locate").hasAttribute("aria-busy"));
  await page.click('.clear[data-target="from"]'); await page.click('.clear[data-target="to"]');
  await page.click("#locate");   // no destination: the start is set and the map goes there
  await until(page, () => window.__app.state.fromLabel === "My location");
  await until(page, () => !window.__app.map.isMoving());
  const alone = await page.evaluate(async () => { const s = window.__app.state, c = window.__app.map.getCenter(); return { from: s.from.map((v) => +v.toFixed(4)), routes: s.routes.length, pins: document.querySelectorAll(".end-pin").length,
    centre: [+c.lng.toFixed(3), +c.lat.toFixed(3)], val: document.querySelector("#from").value }; });
  await page.evaluate(() => window.__app.setLang("fr"));
  const fr = await page.evaluate(() => ({ title: document.querySelector("#locate").title, my: window.BikeI18n.t("myLocation") }));
  const near = (v, w) => Math.abs(v - w) < 1e-4;
  const ok = near(withDest.from[0], -73.5865) && near(withDest.from[1], 45.5232) && withDest.fromVal === "My location" && withDest.routes > 0 && withDest.pins === 2 && busyOff
    && near(alone.from[0], -73.5865) && near(alone.from[1], 45.5232) && alone.val === "My location" && alone.routes === 0 && alone.pins === 1
    && Math.abs(alone.centre[0] + 73.5865) < 0.003 && Math.abs(alone.centre[1] - 45.5232) < 0.003 && fr.title === "Utiliser ma position" && fr.my === "Ma position";
  return { ok, withDest, alone, fr, busyOff };
}, { width: 1440, height: 900 }, { geolocation: { latitude: 45.5232, longitude: -73.5865 }, permissions: ["geolocation"] });

await run("search bars: Use my location refused shows a calm message and changes nothing", `${APP}?trip=montroyal`, async (page) => {
  const before = await page.evaluate(searchSnap);
  await page.click("#locate");
  await until(page, () => !document.querySelector("#toast").hidden);
  const toast = await page.evaluate(() => ({ text: document.querySelector("#toast").textContent, shown: !document.querySelector("#toast").hidden, busy: document.querySelector("#locate").hasAttribute("aria-busy") }));
  const after = await page.evaluate(searchSnap);
  const ok = toast.shown && toast.text === "Piste can't use your location. You can allow it for this site in your browser or phone settings, or type a start instead." && !toast.busy
    && JSON.stringify(after) === JSON.stringify(before);
  return { ok, toast, before, after };
}, { width: 1440, height: 900 }, { permissions: [] });

// ---- locate on open (2026-11-03): location already allowed, the map opens on you; a first visit asks once, after the welcome card ----
await run("locate on open: location allowed, the map opens on you (a dot, My location), nothing when far away or on a shared link", APP, async (page, ctx) => {
  const infos = []; page.on("console", (m) => { if (m.type() === "info") infos.push(m.text()); });
  await until(page, () => window.__app.state.fromLabel === "My location" && !window.__app.map.isMoving(), null, 20000);
  const here = await page.evaluate(() => { const s = window.__app.state, c = window.__app.map.getCenter(), dot = document.querySelector(".me-dot");
    return { from: s.from && s.from.map((v) => +v.toFixed(4)), val: document.querySelector("#from").value, centre: [+c.lng.toFixed(3), +c.lat.toFixed(3)], zoom: +window.__app.map.getZoom().toFixed(1),
      dot: !!dot && dot.getAttribute("aria-hidden") === "true", focus: document.activeElement.tagName, toast: !document.querySelector("#toast").hidden, routes: s.routes.length }; });
  // far from the island (Toronto): the default view stays and no message shows
  await ctx.setGeolocation({ latitude: 43.6532, longitude: -79.3832 });
  await page.goto(BASE + APP, { waitUntil: "load" }); await page.waitForFunction(() => !!window.__app, null, { timeout: 90000 });
  for (let i = 0; i < 100 && !infos.some((x) => /off the island/.test(x)); i++) await page.waitForTimeout(100);
  const far = await page.evaluate(() => { const c = window.__app.map.getCenter(); return { from: window.__app.state.from, dot: !!document.querySelector(".me-dot"), centre: [+c.lng.toFixed(3), +c.lat.toFixed(3)], toast: !document.querySelector("#toast").hidden }; });
  // a shared link (from, to, trip, suggest, classic, ride) shows what it says, never your position
  await ctx.setGeolocation({ latitude: 45.5232, longitude: -73.5865 });
  await page.goto(BASE + APP + "?trip=montroyal", { waitUntil: "load" }); await page.waitForFunction(() => !!window.__app, null, { timeout: 90000 });
  await page.evaluate(idle);
  const link = await page.evaluate(() => ({ label: window.__app.state.fromLabel, dot: !!document.querySelector(".me-dot") }));
  const near = (a, b) => Math.abs(a - b) < 0.003;
  const checks = { startIsYou: here.val === "My location" && here.from && here.from.join() === "-73.5865,45.5232", centred: near(here.centre[0], -73.5865) && near(here.centre[1], 45.5232) && here.zoom >= 14.5,
    dot: here.dot, noFocusTaken: !/^(INPUT|TEXTAREA)$/.test(here.focus), quiet: !here.toast, noRoute: here.routes === 0,
    farIgnored: far.from === null && !far.dot && near(far.centre[0], -73.585) && near(far.centre[1], 45.522) && !far.toast, farNoted: infos.some((x) => /off the island/.test(x)),
    linkWins: link.label === "Mont-Royal metro" && !link.dot };
  const bad = Object.keys(checks).filter((k) => !checks[k]);
  return { ok: !bad.length, ...(bad.length ? { error: "failed checks: " + bad.join(", ") } : {}), here, far, link, infos };
}, { width: 1440, height: 900 }, { permissions: ["geolocation"], geolocation: { latitude: 45.5232, longitude: -73.5865, accuracy: 10 } });

// The browser's permission and position are stubbed (localStorage "test-geo-perm" = prompt | denied | granted, "test-geo-deny" = 1 refuses),
// so the first-visit question can be followed without a real prompt; every call to getCurrentPosition is counted.
const geoStub = () => {
  window.__geoCalls = 0;
  const ls = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  Object.defineProperty(navigator, "permissions", { configurable: true, value: { query: async ({ name }) => ({ name, state: ls("test-geo-perm") || "prompt" }) } });
  Object.defineProperty(navigator, "geolocation", { configurable: true, value: {
    getCurrentPosition(ok, fail) { window.__geoCalls++; setTimeout(() => (ls("test-geo-deny") ? fail({ code: 1, message: "refused (test)" }) : ok({ coords: { longitude: -73.5795, latitude: 45.5235, accuracy: 12 } })), 30); },
    watchPosition() { return 0; }, clearWatch() {} } });
};
await run("locate on open: a first visit asks once, right after the welcome card (after the tour if taken); refused or denied, nothing more", APP, async (page, ctx) => {
  const fresh = async (perm, deny) => {   // a first visit again, with this permission state
    await page.evaluate(([perm, deny]) => { for (const k of ["piste-welcomed", "piste-locate-asked"]) localStorage.removeItem(k); localStorage.setItem("test-geo-perm", perm); if (deny) localStorage.setItem("test-geo-deny", "1"); else localStorage.removeItem("test-geo-deny"); }, [perm, deny]);
    await page.goto(BASE + APP, { waitUntil: "load" });
    await until(page, welcomeUp, null, 90000);
  };
  const snap = () => page.evaluate(() => ({ calls: window.__geoCalls, label: window.__app.state.fromLabel, asked: localStorage.getItem("piste-locate-asked"), toast: !document.querySelector("#toast").hidden,
    focus: document.activeElement.tagName, welcome: !document.querySelector("#welcome").hidden, dot: !!document.querySelector(".me-dot") }));
  await ctx.addInitScript(geoStub);
  // "prompt": not while the welcome card shows; once it closes, one question, and the start becomes My location
  await fresh("prompt", false);
  const during = await snap();
  await page.click("#welcome-skip");
  await until(page, () => window.__app.state.fromLabel === "My location");
  const after = await snap();
  await page.reload({ waitUntil: "load" }); await page.waitForFunction(() => !!window.__app, null, { timeout: 90000 }); await page.evaluate(idle);
  const reload = await snap();   // still "prompt": already asked, so no question
  // the tour first: no question during the tour, one when it ends
  await fresh("prompt", false);
  await page.click("#welcome-tour"); await until(page, () => window.pisteTour.info().open && window.pisteTour.info().settled, null, 30000);
  const inTour = await snap();
  await page.keyboard.press("Escape"); await until(page, () => !window.pisteTour.info().open);
  await until(page, () => window.__geoCalls === 1 && window.__app.state.fromLabel === "My location");
  const afterTour = await snap();
  // refused at the question: no message, nothing changes, and it is never asked again
  await fresh("prompt", true);
  await page.click("#welcome-skip"); await until(page, () => window.__geoCalls === 1);
  await page.evaluate(idle);
  const refused = await snap();
  await page.reload({ waitUntil: "load" }); await page.waitForFunction(() => !!window.__app, null, { timeout: 90000 }); await page.evaluate(idle);
  const refusedReload = await snap();
  // denied in the browser: never asked
  await fresh("denied", false);
  await page.click("#welcome-skip"); await until(page, () => document.querySelector("#welcome").hidden); await page.evaluate(idle);
  const denied = await snap();
  const checks = { notOverWelcome: during.calls === 0 && during.welcome, askedAfter: after.calls === 1 && after.label === "My location" && after.asked === "1" && after.dot && !after.welcome && !/^(INPUT|TEXTAREA)$/.test(after.focus),
    onceOnly: reload.calls === 0 && reload.label === "", notDuringTour: inTour.calls === 0, afterTour: afterTour.calls === 1 && afterTour.label === "My location",
    refusedQuiet: refused.calls === 1 && refused.label === "" && !refused.toast && refused.asked === "1" && !refused.dot, refusedNotAgain: refusedReload.calls === 0, deniedNever: denied.calls === 0 && denied.label === "" };
  const bad = Object.keys(checks).filter((k) => !checks[k]);
  return { ok: !bad.length, ...(bad.length ? { error: "failed checks: " + bad.join(", ") } : {}), during, after, reload, inTour, afterTour, refused, refusedReload, denied };
}, { width: 1440, height: 900 }, { fresh: true });

await run("search bars (phone): x never opens the keyboard, bars keep their layout in a 390 px card", `${APP}?trip=montroyal&safe=47,34`, async (page) => {
  const fit = await page.evaluate(() => { const panel = document.querySelector("#panel").getBoundingClientRect();
    return ["from", "to"].map((w) => { const f = document.querySelector("#" + w).closest(".field").getBoundingClientRect(), i = document.querySelector("#" + w).getBoundingClientRect();
      return { insideCard: f.left >= panel.left && f.right <= panel.right, inputW: Math.round(i.width), font: parseFloat(getComputedStyle(document.querySelector("#" + w)).fontSize), h: Math.round(f.height) }; }); });
  await page.tap('.clear[data-target="to"]'); await page.waitForTimeout(400);
  const afterTo = await page.evaluate(searchSnap);
  const kb = await page.evaluate(() => ({ active: document.activeElement.tagName, searching: document.body.classList.contains("searching") }));
  await page.tap('.clear[data-target="from"]'); await page.waitForTimeout(400);
  const afterBoth = await page.evaluate(searchSnap);
  const ok = fit.every((f) => f.insideCard && f.inputW >= 150 && f.font >= 16 && f.h >= 44) && afterTo.to === null && afterTo.routes === 0 && afterTo.pins === 1 && !/^(INPUT|TEXTAREA)$/.test(kb.active) && !kb.searching
    && afterBoth.from === null && afterBoth.pins === 0 && afterBoth.routes === 0;
  return { ok, fit, afterTo, kb, afterBoth };
}, { width: 390, height: 844 }, { hasTouch: true, isMobile: true });

// ------------------------------------------------------------------ the language button in the card's header (2026-10-31)
await run("language button: top right of the card's header, visible at every sheet height, 44 px tap area, no sheet drag", `${APP}?trip=montroyal&safe=47,34`, async (page) => {
  const probe = () => { const b = document.querySelector("#lang-btn"), r = b.getBoundingClientRect(), br = document.querySelector("#brand").getBoundingClientRect(), pr = document.querySelector("#panel").getBoundingClientRect(),
      g = document.querySelector("#grabber").getBoundingClientRect(), tb = document.querySelector(".tabs").getBoundingClientRect(), phone = matchMedia("(max-width: 760px)").matches;
    const hit = (x, y) => { const e = document.elementFromPoint(x, y); return !!e && (e === b || b.contains(e)); };
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2, tap = !phone || [[-21, -21], [21, -21], [-21, 21], [21, 21]].every(([dx, dy]) => hit(cx + dx, cy + dy));
    const overlap = (a, c) => a.width > 0 && c.width > 0 && Math.min(a.right, c.right) - Math.max(a.left, c.left) > 0.5 && Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top) > 0.5;
    return { inHeader: r.top >= br.top - 1 && r.bottom <= br.bottom + 1 && Math.abs(r.right - (pr.right - 16)) <= (phone ? 4 : 6), visible: hit(cx, cy) && r.top >= pr.top && r.bottom <= pr.bottom, tap,
      clear: !overlap(r, g) && !overlap(r, tb), text: b.textContent, sheet: document.querySelector("#panel").dataset.sheet, size: [Math.round(r.width), Math.round(r.height)], rect: [r.left, r.top, r.right, r.bottom].map(Math.round) }; };
  const out = {};
  for (const sheet of ["peek", "half", "full"]) {
    await page.evaluate((s) => window.__app.setSheet(s), sheet); await page.waitForTimeout(450);
    out[sheet] = await settled(page, probe);
  }
  await page.evaluate(() => window.__app.setSheet("peek")); await page.waitForTimeout(450);
  await page.click("#lang-btn"); await page.waitForTimeout(300);
  const fr = await page.evaluate(() => ({ lang: document.documentElement.lang, text: document.querySelector("#lang-btn").textContent, title: document.querySelector("#lang-btn").title, sheet: document.querySelector("#panel").dataset.sheet, tab: document.querySelector("#tab-go").textContent }));
  await page.click("#lang-btn"); await page.waitForTimeout(200);
  const en = await page.evaluate(() => ({ lang: document.documentElement.lang, text: document.querySelector("#lang-btn").textContent, title: document.querySelector("#lang-btn").title }));
  await page.setViewportSize({ width: 1440, height: 900 }); await page.waitForTimeout(500);
  const desk = await settled(page, probe);
  const inMapButtons = await page.evaluate(() => !document.querySelector(".map-controls #lang-btn"));
  const ok = ["peek", "half", "full"].every((k) => out[k].inHeader && out[k].visible && out[k].tap && out[k].clear) && out.peek.sheet === "peek"
    && fr.lang === "fr" && fr.text === "EN" && fr.title === "English" && fr.sheet === "peek" && fr.tab === "Itinéraire" && en.lang === "en" && en.text === "FR" && en.title === "Français"
    && desk.inHeader && desk.visible && desk.clear && inMapButtons;
  return { ok, out, fr, en, desk, inMapButtons };
}, { width: 390, height: 844 }, { hasTouch: true, isMobile: true });

// ------------------------------------------------------------------ the data-sources "i" (2026-10-31): bottom right, opens leftwards, turns into an x
const creditsProbe = () => { const q = (s) => document.querySelector(s), btn = q(".maplibregl-ctrl-attrib-button"), b = btn.getBoundingClientRect(), box = q(".maplibregl-ctrl-attrib").getBoundingClientRect(),
    map = q("#map").getBoundingClientRect(), pr = q("#panel").getBoundingClientRect(), phone = matchMedia("(max-width: 760px)").matches, zoom = q(".maplibregl-ctrl-zoom-in"), cx = b.left + b.width / 2, cy = b.top + b.height / 2;
  const hit = (x, y) => { const e = document.elementFromPoint(x, y); return !!e && (e === btn || btn.contains(e) || e.closest(".maplibregl-ctrl-attrib-button") === btn); };
  return { btn: [b.left, b.top, b.right, b.bottom].map((v) => Math.round(v * 10) / 10), box: [box.left, box.top, box.right, box.bottom].map(Math.round), size: [Math.round(b.width), Math.round(b.height)],
    nearRight: map.right - b.right <= 24, nearBottom: map.bottom - b.bottom <= 24, aboveSheet: phone ? pr.top - b.bottom >= 0 && pr.top - b.bottom <= 30 : null, open: q(".maplibregl-ctrl-attrib").classList.contains("maplibregl-compact-show"),
    icon: getComputedStyle(btn).backgroundImage, text: q(".maplibregl-ctrl-attrib-inner").textContent, zoomAbove: zoom && getComputedStyle(zoom).display !== "none" ? zoom.getBoundingClientRect().bottom <= b.top + 0.5 : null,
    tap44: [[-21, -21], [21, -21], [-21, 21], [21, 21]].every(([dx, dy]) => hit(cx + dx, cy + dy)), shown: getComputedStyle(q(".maplibregl-ctrl-bottom-right")).display !== "none", panelTop: Math.round(pr.top) }; };
const creditsText = (t) => /Ville de Montréal/.test(t) && /CC BY 4\.0/.test(t) && /OpenStreetMap/.test(t) && /OpenFreeMap/.test(t) && /© 2026 Piste Montréal/.test(t) && /NRCan/.test(t) && /STM/.test(t) && /BIXI/.test(t) && /Open-Meteo/.test(t) && /ECCC/.test(t);
await run("map credits: the i sits bottom right, opens leftwards, becomes an x (desktop)", `${APP}?trip=montroyal`, async (page) => {
  const closed = await page.evaluate(creditsProbe);
  await page.click(".maplibregl-ctrl-attrib-button"); await page.waitForTimeout(400);
  const open = await page.evaluate(creditsProbe);
  await page.click(".maplibregl-ctrl-attrib-button"); await page.waitForTimeout(400);
  const again = await page.evaluate(creditsProbe);
  const stays = Math.abs(open.btn[2] - closed.btn[2]) <= 1 && Math.abs(open.btn[3] - closed.btn[3]) <= 1;
  // 2026-11-03: the card's footer has no credits line any more; the "i" and About & terms between them name every source it had
  const sources = await page.evaluate(() => {
    const foot = document.querySelector("#panel footer"), i = document.querySelector(".maplibregl-ctrl-attrib-inner").textContent, about = document.querySelector("#about-card").textContent;
    const all = ["Ville de Montréal (CC BY 4.0)", "OpenStreetMap contributors", "NRCan HRDEM 2023 + 2024", "Canopée 2019", "STM", "REM (OpenStreetMap)", "BIXI", "Open-Meteo", "ECCC", "OpenFreeMap"];
    return { footerClean: !/Ville de Montréal|OpenStreetMap|NRCan/.test(foot.textContent) && !document.querySelector(".credits"), missing: all.filter((x) => !i.includes(x) && !about.includes(x)),
      inI: all.filter((x) => i.includes(x)).length, osmInI: /OpenStreetMap/.test(i) };
  });
  const ok = closed.nearRight && closed.nearBottom && closed.size[0] <= 24 && closed.size[1] <= 24 && closed.zoomAbove === true && !closed.open
    && open.open && stays && open.box[0] < closed.btn[0] - 150 && Math.abs(open.box[2] - closed.box[2]) <= 1 && open.icon !== closed.icon && creditsText(open.text)
    && !again.open && again.icon === closed.icon && Math.abs(again.btn[0] - closed.btn[0]) <= 1 && sources.footerClean && !sources.missing.length && sources.osmInI;
  return { ok, closed, open, again, stays, sources };
});
await run("map credits (phone): the i rides just above the bottom sheet, 44 px tap area, hides with the sheet fully up", `${APP}?trip=montroyal&safe=47,34`, async (page) => {
  const at = {};
  for (const sheet of ["half", "peek"]) { await page.evaluate((s) => window.__app.setSheet(s), sheet); await page.waitForTimeout(450); at[sheet] = await settled(page, creditsProbe); }
  await page.evaluate(() => window.__app.setSheet("half")); await page.waitForTimeout(450);
  await page.tap(".maplibregl-ctrl-attrib-button"); await page.waitForTimeout(400);
  const open = await settled(page, creditsProbe);
  await page.tap(".maplibregl-ctrl-attrib-button"); await page.waitForTimeout(300);
  await page.evaluate(() => window.__app.setSheet("full")); await page.waitForTimeout(450);
  const full = await settled(page, () => ({ shown: getComputedStyle(document.querySelector(".maplibregl-ctrl-bottom-right")).display !== "none" }));
  await page.evaluate(() => window.__app.setSheet("half")); await page.waitForTimeout(450);
  const searching = await page.evaluate(() => { document.body.classList.add("searching"); const d = getComputedStyle(document.querySelector(".maplibregl-ctrl-bottom-right")).display; document.body.classList.remove("searching"); return d; });
  const ok = ["half", "peek"].every((k) => at[k].shown && at[k].aboveSheet && at[k].tap44 && at[k].size[0] <= 24) && at.peek.panelTop > at.half.panelTop + 100 && at.peek.btn[3] > at.half.btn[3] + 100
    && open.open && Math.abs(open.btn[2] - at.half.btn[2]) <= 1 && Math.abs(open.btn[3] - at.half.btn[3]) <= 1 && open.box[0] < open.btn[0] - 100 && open.box[0] >= 0 && creditsText(open.text) && !full.shown && searching === "none";
  return { ok, at, open, full, searching };
}, { width: 390, height: 844 }, { hasTouch: true, isMobile: true });

// ------------------------------------------------------------------ the feedback dialog (2026-10-31): Web3Forms is stubbed, no real request is ever sent
async function stubWeb3Forms(ctx, mode) {   // mode.current: "ok" answers like Web3Forms, "fail" answers 500; every POST body is kept
  const calls = [];
  await ctx.route("https://api.web3forms.com/**", (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { ...CORS, "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" } });
    calls.push(JSON.parse(req.postData() || "{}"));
    const good = mode.current === "ok";
    return route.fulfill({ status: good ? 200 : 500, contentType: "application/json", headers: CORS, body: JSON.stringify(good ? { success: true, message: "Email sent successfully!" } : { success: false, message: "stub failure" }) });
  });
  return calls;
}
await run("feedback dialog: opens, stays inside the app, sends through Web3Forms (stubbed), falls back to the mail app", `${APP}?trip=montroyal`, async (page, ctx) => {
  const mode = { current: "ok" }, calls = await stubWeb3Forms(ctx, mode);
  await page.evaluate(() => {   // what the app counts, and which mailto links the dialog tries to open (cancelled here)
    window.__events = []; window.umami = { track: (n, d) => window.__events.push([n, d || null]) };
    window.__mails = [];
    document.addEventListener("click", (e) => { const a = e.target.closest && e.target.closest("a[href^='mailto:']"); if (a) { window.__mails.push(a.getAttribute("href")); e.preventDefault(); } }, true);
  });
  const hidden = () => document.querySelector("#feedback").hidden;
  const open = async () => { await page.click("#feedback-link"); await until(page, () => !document.querySelector("#feedback").hidden); };
  const status = () => page.evaluate(() => ({ text: document.querySelector("#fb-status").textContent, kind: document.querySelector("#fb-status").dataset.kind, open: !document.querySelector("#feedback").hidden,
    sendOn: !document.querySelector("#fb-send").disabled, invalid: [...document.querySelectorAll("[aria-invalid=true]")].map((e) => e.id) }));
  await open();
  const opened = await page.evaluate(() => { const L = (id) => document.querySelector(`label[for="${id}"]`).textContent, c = document.querySelector("#feedback-form");
    return { role: c.getAttribute("role"), modal: c.getAttribute("aria-modal"), title: document.querySelector("#fb-title").textContent, labels: [L("fb-subject"), L("fb-message"), L("fb-email")],
      buttons: [document.querySelector("#fb-cancel").textContent, document.querySelector("#fb-send").textContent], mailText: document.querySelector("#fb-mail").textContent, mailHref: document.querySelector("#fb-mail").getAttribute("href"),
      alt: document.querySelector("#feedback .dialog-alt-line").textContent, focus: document.activeElement.id, emailType: document.querySelector("#fb-email").type, panelInert: document.querySelector("#panel").inert, events: window.__events }; });
  // an empty message is not sent
  await page.click("#fb-send"); const empty = await status();
  // a wrong email is not sent
  await page.fill("#fb-message", "x"); await page.fill("#fb-email", "nope"); await page.click("#fb-send"); const badEmail = await status();
  // no key (the constant is empty): Send opens the mail app, with the subject and message filled in, and nothing is posted
  await page.fill("#fb-subject", "Path question"); await page.fill("#fb-message", "Closed near Rosemont"); await page.fill("#fb-email", "");
  await page.evaluate(() => window.pisteTour.setFeedbackKey(""));   // the no-key path: Send falls back to the mail app
  await page.click("#fb-send"); const noKey = await status(); const noKeyMails = await page.evaluate(() => window.__mails.slice());
  const noKeyCalls = calls.length;
  // with a key: posted to Web3Forms as JSON, thanks, then it closes by itself and clears; counted as feedback-sent; focus returns
  await page.evaluate(() => window.pisteTour.setFeedbackKey("TEST_KEY"));
  await page.fill("#fb-email", "rider@example.com"); await page.click("#fb-send");
  await until(page, () => /Thank you/.test(document.querySelector("#fb-status").textContent)); const thanks = await status();
  await until(page, hidden, null, 8000);
  const sent = await page.evaluate(() => ({ closed: document.querySelector("#feedback").hidden, focus: document.activeElement && document.activeElement.id, panelInert: document.querySelector("#panel").inert,
    cleared: !document.querySelector("#fb-message").value && !document.querySelector("#fb-subject").value, events: window.__events.map((e) => e[0]) }));
  const payload = calls[0] || {};
  // the post fails: an error, the mail app opens instead, the dialog stays and Send works again
  mode.current = "fail"; await open();
  await page.fill("#fb-subject", "Second"); await page.fill("#fb-message", "Second message");
  await page.click("#fb-send"); await until(page, () => /Couldn't send/.test(document.querySelector("#fb-status").textContent)); const failed = await status();
  const failMails = await page.evaluate(() => window.__mails.slice());
  const eventsAfterFail = await page.evaluate(() => window.__events.map((e) => e[0]));
  // the hidden trap field (honeypot) ticked: no request
  const callsBeforeBot = calls.length;
  await page.evaluate(() => document.querySelector("#fb-botcheck").click()); await page.click("#fb-send");
  await until(page, () => /Thank you/.test(document.querySelector("#fb-status").textContent)); await until(page, hidden, null, 8000);
  const bot = { calls: calls.length - callsBeforeBot };
  // Esc and Cancel close it, and focus returns to the link
  await open(); await page.keyboard.press("Escape"); await until(page, hidden);
  const esc = await page.evaluate(() => ({ closed: document.querySelector("#feedback").hidden, focus: document.activeElement && document.activeElement.id }));
  await open(); await page.click("#fb-cancel"); await until(page, hidden);
  const cancel = await page.evaluate(() => ({ closed: document.querySelector("#feedback").hidden, focus: document.activeElement && document.activeElement.id }));
  // French
  await page.evaluate(() => window.__app.setLang("fr")); await open();
  const fr = await page.evaluate(() => ({ title: document.querySelector("#fb-title").textContent, email: document.querySelector('label[for="fb-email"]').textContent, send: document.querySelector("#fb-send").textContent,
    cancel: document.querySelector("#fb-cancel").textContent, alt: document.querySelector("#feedback .dialog-alt-line").textContent }));
  await page.keyboard.press("Escape"); await until(page, hidden);
  // a phone: 16 px fields (no zoom on focus), 44 px buttons, the card inside the screen and following the visible area; no keyboard on open
  await page.evaluate(() => window.__app.setLang("en"));
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(400);
  await open();
  const phone = await settled(page, () => { const c = document.querySelector("#feedback-form").getBoundingClientRect(), L = document.querySelector("#feedback"), v = window.visualViewport;
    const fonts = ["#fb-subject", "#fb-message", "#fb-email"].map((s) => parseFloat(getComputedStyle(document.querySelector(s)).fontSize));
    const hits = ["#fb-send", "#fb-cancel", "#fb-mail"].map((s) => Math.round(document.querySelector(s).getBoundingClientRect().height));
    return { inside: c.left >= 0 && c.right <= innerWidth && c.top >= 0 && c.bottom <= innerHeight, fonts, hits, vvh: L.style.getPropertyValue("--vv-h"), vv: v ? v.height + "px" : null, active: document.activeElement.tagName, noScroll: document.documentElement.scrollWidth <= innerWidth }; });
  await page.keyboard.press("Escape"); await until(page, hidden);
  const ok = opened.role === "dialog" && opened.modal === "true" && opened.title === "Send feedback" && opened.labels.join("|") === "Subject|Message|Your email (if you'd like a reply)" && opened.buttons.join("|") === "Cancel|Send"
    && opened.mailText === "support@pistemtl.ca" && opened.mailHref.startsWith("mailto:support@pistemtl.ca") && opened.alt.startsWith("Or email us at") && opened.focus === "fb-subject" && opened.emailType === "email" && opened.panelInert
    && opened.events.some((e) => e[0] === "feedback" && e[1] && e[1].from === "panel")
    && empty.open && /write a message/.test(empty.text) && empty.invalid.join() === "fb-message" && badEmail.open && /email address/.test(badEmail.text) && badEmail.invalid.join() === "fb-email" && calls.length >= 0 && noKeyCalls === 0
    && noKey.open && noKeyMails.length === 1 && noKeyMails[0] === "mailto:support@pistemtl.ca?subject=Path%20question&body=Closed%20near%20Rosemont" && /mail app/.test(noKey.text)
    && thanks.kind === "ok" && /Thank you/.test(thanks.text) && sent.closed && sent.focus === "feedback-link" && !sent.panelInert && sent.cleared && sent.events.filter((e) => e === "feedback-sent").length === 1
    && Object.keys(payload).sort().join() === "access_key,botcheck,email,from_name,message,subject" && payload.access_key === "TEST_KEY" && payload.subject === "Path question" && payload.message === "Closed near Rosemont" && payload.email === "rider@example.com" && payload.from_name === "Piste" && payload.botcheck === false
    && failed.open && failed.kind === "error" && failed.sendOn && failMails.length === 2 && failMails[1] === "mailto:support@pistemtl.ca?subject=Second&body=Second%20message" && eventsAfterFail.filter((e) => e === "feedback-sent").length === 1
    && bot.calls === 0 && esc.closed && esc.focus === "feedback-link" && cancel.closed && cancel.focus === "feedback-link"
    && fr.title === "Envoyer un commentaire" && /courriel/.test(fr.email) && fr.send === "Envoyer" && fr.cancel === "Annuler" && /^Ou écrivez-nous à/.test(fr.alt)
    && phone.inside && phone.fonts.every((f) => f >= 16) && phone.hits.every((h) => h >= 44) && (phone.vvh === "" || phone.vvh === phone.vv) && phone.active === "FORM" && phone.noScroll;
  return { ok, opened, empty, badEmail, noKey, noKeyMails, thanks, sent, payload, failed, failMails, bot, esc, cancel, fr, phone, calls: calls.length };
});

// ------------------------------------------------------------------ About & terms and the (c) line (2026-10-31)
await run("About & terms: the (c) line, a dialog with who, risk, privacy and credits, Esc, French", APP, async (page) => {
  const foot = await page.evaluate(() => ({ copy: document.querySelector("#panel .copyright").textContent, link: document.querySelector("#about-link").textContent, h: Math.round(document.querySelector("#about-link").getBoundingClientRect().height),
    sameRow: document.querySelector("#panel .copyright").parentElement === document.querySelector("#about-link").parentElement }));
  await page.click("#about-link"); await until(page, () => !document.querySelector("#about").hidden);
  const dlg = await page.evaluate(() => { const c = document.querySelector("#about-card"); return { role: c.getAttribute("role"), modal: c.getAttribute("aria-modal"), text: c.innerText, focus: c.contains(document.activeElement), panelInert: document.querySelector("#panel").inert,
    mail: !!c.querySelector('a[href="mailto:support@pistemtl.ca"]'), closeH: Math.round(document.querySelector("#about-close").getBoundingClientRect().height), items: c.querySelectorAll("li").length }; });
  await page.keyboard.press("Escape"); await until(page, () => document.querySelector("#about").hidden);
  const esc = await page.evaluate(() => ({ closed: document.querySelector("#about").hidden, focus: document.activeElement && document.activeElement.id, inert: document.querySelector("#panel").inert }));
  await page.click("#about-link"); await until(page, () => !document.querySelector("#about").hidden);
  await page.mouse.click(1400, 450); await until(page, () => document.querySelector("#about").hidden);   // the dimmed area closes it too
  const outside = await page.evaluate(() => document.querySelector("#about").hidden);
  // a phone: the text scrolls inside the card, and Close stays in view at the bottom of it
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(400);
  await page.click("#about-link"); await until(page, () => !document.querySelector("#about").hidden);
  await page.evaluate(() => Promise.all(document.querySelector("#about-card").getAnimations().map((a) => a.finished)));   // its slide-in can still be running on a slow machine
  const phone = await settled(page, () => { const c = document.querySelector("#about-card"), cr = c.getBoundingClientRect(), b = document.querySelector("#about-close").getBoundingClientRect();
    return { scrolls: c.scrollHeight > c.clientHeight + 20, closeInView: b.top >= cr.top && b.bottom <= cr.bottom + 1 && b.bottom <= innerHeight, inside: cr.left >= 0 && cr.right <= innerWidth && cr.top >= 0 && cr.bottom <= innerHeight,
      rect: [cr.left, cr.top, cr.right, cr.bottom].map(Math.round).join(","), view: innerWidth + "x" + innerHeight }; });
  await page.keyboard.press("Escape"); await until(page, () => document.querySelector("#about").hidden);
  await page.setViewportSize({ width: 1440, height: 900 }); await page.waitForTimeout(300);
  await page.evaluate(() => window.__app.setLang("fr"));
  const fr = await page.evaluate(() => ({ link: document.querySelector("#about-link").textContent }));
  await page.click("#about-link"); await until(page, () => !document.querySelector("#about").hidden);
  const frDlg = await page.evaluate(() => ({ title: document.querySelector("#ab-title").textContent, text: document.querySelector("#about-card").innerText }));
  await page.click("#about-close"); await until(page, () => document.querySelector("#about").hidden);
  const T = dlg.text;
  // named checks, so a failure says which one (whether the text scrolls depends on the fonts, so only Close in view counts)
  const checks = {
    copyLine: foot.copy === "© 2026 Piste Montréal", link: foot.link === "About & terms", linkTap44: foot.h >= 44, sameRow: foot.sameRow,
    dialog: dlg.role === "dialog" && dlg.modal === "true", focusIn: dlg.focus, panelInert: dlg.panelInert, mail: dlg.mail, close44: dlg.closeH >= 44, fourItems: dlg.items === 4,
    who: /Piste is a Montréal project, in beta/.test(T) && !/Roy-Jauvin|Who made it/.test(T), risk: /own risk/.test(T) && /traffic laws/.test(T),
    privacy: /address service/.test(T) && /anonymously, without cookies/.test(T) && /Web3Forms/.test(T) && /not sent to us/.test(T),
    credits: /Ville de Montréal \(CC BY 4\.0\)/.test(T) && /OpenStreetMap contributors/.test(T) && /OpenFreeMap/.test(T), copyInDialog: /© 2026 Piste Montréal/.test(T), address: /support@pistemtl\.ca/.test(T),
    escCloses: esc.closed && esc.focus === "about-link" && !esc.inert, outsideCloses: outside, phoneCloseInView: phone.closeInView, phoneInside: phone.inside,
    french: fr.link === "À propos et conditions" && frDlg.title === "À propos de Piste" && /Vie privée/i.test(frDlg.text) && /à vos propres risques/.test(frDlg.text),
  };
  const bad = Object.keys(checks).filter((k) => !checks[k]);
  return { ok: !bad.length, ...(bad.length ? { error: `failed checks: ${bad.join(", ")} (phone card ${phone.rect} in ${phone.view})` } : {}), foot, dlg: { ...dlg, text: undefined }, esc, outside, phone, fr, frTitle: frDlg.title };
}, { width: 1440, height: 900 });

// iPhone Safari sends a tap's mouse events after the finger lifts, to whatever is under it by then. The tap that opens search has
// moved the card, so that would be a "tap outside" that closes the keyboard (2026-10-31 bug). The rest of that tap must be cancelled.
await run("phone: the tap that opens a search bar isn't taken as a tap outside", APP, async (page) => page.evaluate(async () => {
  const out = {};
  for (const id of ["to", "from"]) {
    const el = document.getElementById(id), b = el.getBoundingClientRect(), x = b.left + 40, y = b.top + b.height / 2;
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerType: "touch", isPrimary: true, pointerId: 3 }));
    const te = new Event("touchend", { bubbles: true, cancelable: true }); el.dispatchEvent(te);
    await new Promise((r) => setTimeout(r, 300));
    const under = document.elementFromPoint(x, y) || document.body;
    const md = new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: x, clientY: y, detail: 1 }); under.dispatchEvent(md);
    const ck = new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y, detail: 1 }); under.dispatchEvent(ck);
    await new Promise((r) => setTimeout(r, 300));
    out[id] = { touchendCancelled: te.defaultPrevented, mousedownCancelled: under === el || md.defaultPrevented, clickCancelled: under === el || ck.defaultPrevented,
      searching: document.body.classList.contains("searching"), focused: document.activeElement === el };
    window.__app.cancelSearch && window.__app.cancelSearch(); el.blur();
    await new Promise((r) => setTimeout(r, 1000));   // past the swallow window: later taps on the card act normally again
    const later = new MouseEvent("mousedown", { bubbles: true, cancelable: true, detail: 1 }); document.querySelector("#panel").dispatchEvent(later);
    out[id].laterNotSwallowed = !later.defaultPrevented;
  }
  const ok = Object.values(out).every((o) => o.touchendCancelled && o.mousedownCancelled && o.clickCancelled && o.searching && o.focused && o.laterNotSwallowed);
  return { ok, ...(ok ? {} : { error: "failed: " + JSON.stringify(out) }), out };
}), { width: 390, height: 844 }, { hasTouch: true, isMobile: true });

// ---- Avoid construction (2026-11-02): a work site on the route; the checkbox moves the route off it, off by default, remembered ----
await run("avoid construction: off by default, remembered, moves the route off a work site", `${APP}?trip=montroyal`, async (page) => page.evaluate(async () => {
  const a = window.__app, cb = document.querySelector("#avoid-works"), tap = document.querySelector("#avoid-works").closest("label").getBoundingClientRect().height;
  const legs = () => a.state.routes[0].r.legs.map((l) => l.e), same = (x, y) => x.length === y.length && x.every((e, i) => e === y[i]);
  const stored = () => { try { return localStorage.getItem("piste-avoid-works"); } catch (e) { return null; } };
  a.recompute(false);
  const off = legs(), defaults = { checked: cb.checked, stored: stored() };
  const mid = off[Math.floor(off.length / 2)], pts = a.router.edgeCoords(mid, true), p = pts[Math.floor(pts.length / 2)];
  window.PLANNED.features.push({ type: "Feature", geometry: { type: "Point", coordinates: p }, properties: { status: "works", name: "test", until: "2999-12-31" } });
  cb.click(); await new Promise((r) => setTimeout(r, 300));
  const on = legs(), moved = !same(on, off) && !on.includes(mid), kept = stored();
  cb.click(); await new Promise((r) => setTimeout(r, 300));
  const back = same(legs(), off), cleared = stored();
  const ok = !defaults.checked && defaults.stored === null && moved && kept === "1" && back && cleared === "0" && tap >= 44;
  return { ok, defaults, moved, kept, back, cleared, tap, label: cb.parentElement.textContent.trim() };
}));

// ---- the Avoid row (2026-11-03): a small "Avoid" label, then real checkboxes drawn as chips, on one line at 390 px in English and French;
// made-to-order rides have no route-style slider and always take the most bike paths ----
await run("Avoid row: one line of chips at 390 px (EN, FR, all on); made-to-order rides: no slider, most bike paths", `${APP}?trip=montroyal&safe=47,34`, async (page) => {
  const row = () => page.evaluate(async () => {
    const r = document.querySelector(".avoid"), p = document.querySelector("#panel").getBoundingClientRect();
    await Promise.all(r.getAnimations({ subtree: true }).map((a) => a.finished));   // the check marks slide in
    const items = [...r.children].filter((c) => c.getClientRects().length), rects = items.map((c) => c.getBoundingClientRect()), mid = rects.map((b) => b.top + b.height / 2);
    const name = document.getElementById(r.getAttribute("aria-labelledby"));
    return { label: name && name.textContent, role: r.getAttribute("role"), chips: items.slice(1).map((c) => c.textContent.trim()), oneLine: Math.max(...mid) - Math.min(...mid) < 2,
      inside: rects.every((b) => b.left >= p.left + 15.5 && b.right <= p.right - 15.5), right: Math.round(Math.max(...rects.map((b) => b.right))), tap44: items.slice(1).every((c) => c.getBoundingClientRect().height >= 44),
      boxes: items.slice(1).map((c) => { const i = c.querySelector("input"); return `${i.id}:${i.type}:${i.checked}`; }), slider: document.querySelector("#strict").getClientRects().length > 0 };
  });
  const go = await row();
  for (const id of ["hills", "avoid-works"]) await page.tap(`.avoid label:has(#${id})`);
  const goOn = await row();
  // Suggest a ride, made to order: headwinds joins the row, and the route-style slider goes
  await page.evaluate(() => { const s = document.querySelector("#strict"); s.value = 0; s.dispatchEvent(new Event("input")); window.__app.setTab("suggest"); window.__app.setSuggMode("custom"); });
  await page.tap(".avoid label:has(#avoid-wind)");
  const custom = await row();
  await page.evaluate(() => window.__app.setLang("fr"));
  const fr = await row();
  // the suggester is handed the "most bike paths" weights whatever the hidden slider says
  const weights = await page.evaluate(async () => {
    const a = window.__app, sg = a.suggester, orig = sg.suggest.bind(sg); let got = null;
    sg.suggest = (o) => { got = o.weights; return orig(o); };
    await a.computeSuggestions(true); sg.suggest = orig;
    const want = BikeRouter.weightsFor(1, true), low = BikeRouter.weightsFor(0, true);
    return { most: JSON.stringify(got.w) === JSON.stringify(want.w) && got.hill === want.hill, notSlider: JSON.stringify(got.w) !== JSON.stringify(low.w), routes: a.state.routes.length };
  });
  await page.evaluate(() => { window.__app.setLang("en"); window.__app.setTab("go"); });
  const back = await row();
  const checks = { group: go.role === "group" && go.label === "Avoid", goChips: go.chips.join() === "Hills,Construction" && go.oneLine && go.inside && go.tap44 && go.slider,
    realBoxes: go.boxes.join() === "hills:checkbox:false,avoid-works:checkbox:false", goAllOn: goOn.boxes.join() === "hills:checkbox:true,avoid-works:checkbox:true" && goOn.oneLine && goOn.inside,
    customChips: custom.chips.join() === "Hills,Headwinds,Construction" && custom.oneLine && custom.inside && custom.boxes.every((b) => b.endsWith(":true")) && !custom.slider,
    french: fr.label === "Éviter" && fr.chips.join() === "Côtes,Vent de face,Chantiers" && fr.oneLine && fr.inside, mostBikePaths: weights.most && weights.notSlider && weights.routes > 0,
    goSliderBack: back.slider && back.chips.join() === "Hills,Construction" };
  const bad = Object.keys(checks).filter((k) => !checks[k]);
  return { ok: !bad.length, ...(bad.length ? { error: "failed checks: " + bad.join(", ") } : {}), go, goOn, custom, fr, weights, back };
}, { width: 390, height: 844 }, { hasTouch: true, isMobile: true });

// ---- Offline (2026-11-02): with ?sw=1 the service worker (a-positron/sw.js) is installed; with the signal gone, a reload still opens the app and plans a route ----
await run("offline: the service worker keeps the app and routing working without a signal", `${APP}?sw=1`, async (page, ctx) => {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload({ waitUntil: "load" });   // this load is served by the worker, which keeps the basemap and tiles it sees
  await page.waitForFunction(() => !!window.__app);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 1500)));
  const kept = await page.evaluate(async () => {
    const shell = (await caches.keys()).find((k) => k.startsWith("piste-shell-"));
    return { controlled: !!navigator.serviceWorker.controller, shellFiles: shell ? (await (await caches.open(shell)).keys()).length : 0 };
  });
  if (FIX) await ctx.unroute("https://api.montreal.ca/**");   // a saved answer would hide the missing signal
  await ctx.setOffline(true);
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => !!window.__app, null, { timeout: 30000 });
  const typed = async (id, text) => { await page.fill(id, text); await page.evaluate(() => new Promise((r) => setTimeout(r, 600))); };
  await typed("#from", "Parc La Fontaine");
  const note = await page.evaluate(() => (document.querySelector("#suggest .note") || {}).textContent || "");
  await page.fill("#from", ""); await typed("#from", "45.5200, -73.5800"); await page.keyboard.press("Enter");
  await typed("#to", "45.5100, -73.5700"); await page.keyboard.press("Enter");
  await until(page, () => window.__app.state.routes.length > 0, null, 15000);
  const out = await page.evaluate(() => ({ routes: window.__app.state.routes.length, km: window.__app.state.routes[0] ? +(window.__app.state.routes[0].r.length / 1000).toFixed(2) : 0 }));
  await ctx.setOffline(false);
  const ok = kept.controlled && kept.shellFiles >= 20 && /offline/i.test(note) && out.routes > 0 && out.km > 0.5;
  return { ok, kept, note, ...out };
}, undefined, { serviceWorkers: "allow" });

// ---- Night map (2026-11-02): Auto / On / Off in the Layers panel; the basemap goes dark, the route and bike-path colours do not change ----
await run("night map: Auto/On/Off, dark basemap, route and bike-path colours unchanged, sunrise and sunset", `${APP}?trip=montroyal`, async (page) => page.evaluate(async () => {
  const a = window.__app, m = a.map, wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const semantic = () => JSON.stringify(["route-solid", "route-shared", "route-quiet", "route-alts", "net-ab", "net-c", "construction", "closed"].map((id) => m.getPaintProperty(id, "line-color")));
  const bg = () => m.getPaintProperty("background", "background-color"), water = () => m.getPaintProperty("water", "fill-color");
  document.querySelector("#layers-btn").click();
  const radios = [...document.querySelectorAll("input[name=night]")], tap = Math.min(...radios.map((r) => r.closest("label").getBoundingClientRect().height));
  const day = { bg: bg(), water: water(), semantic: semantic(), checked: radios.find((r) => r.checked).value };   // the test setup stores "off"
  radios.find((r) => r.value === "on").click(); await wait(500);
  const night = { bg: bg(), water: water(), semantic: semantic(), stored: localStorage.getItem("piste-night"), body: document.body.classList.contains("night") };
  radios.find((r) => r.value === "off").click(); await wait(500);
  const back = bg();
  // winter keeps working under night: night's colour wins while it is on, winter's again after
  a.setWinter(true); radios.find((r) => r.value === "on").click(); await wait(500);
  const both = bg(); radios.find((r) => r.value === "off").click(); await wait(500);
  const winterBack = bg(); a.setWinter(false);
  // sunrise and sunset in Montréal (Jun 21: 05:06 / 20:46 EDT; Dec 21: 07:25 / 16:23 EST), 15 minutes either side
  const n = (s) => BikeCommon.isNight(new Date(s));
  const sun = [n("2026-06-21T08:50:00Z"), !n("2026-06-21T09:25:00Z"), !n("2026-06-22T00:30:00Z"), n("2026-06-22T01:05:00Z"),
    n("2026-12-21T12:10:00Z"), !n("2026-12-21T12:40:00Z"), !n("2026-12-21T21:10:00Z"), n("2026-12-21T21:40:00Z")];
  const ok = day.checked === "off" && night.bg !== day.bg && night.water !== day.water && night.bg === "#0f1626" && night.semantic === day.semantic && !day.semantic.includes("null") && night.stored === "on" && night.body
    && back === day.bg && both === "#0f1626" && winterBack === "#eef4f8" && sun.every(Boolean) && tap >= 44;
  return { ok, day, night, back, both, winterBack, sun, tap };
}));

// ------------------------------------------------------------------ route cards, sharing a route (2026-11-02)
const shareStub = () => { window.__shared = []; window.__copied = null; window.__copyFails = false;
  Object.defineProperty(navigator, "share", { value: async (d) => { window.__shared.push(d); }, configurable: true });
  Object.defineProperty(navigator, "clipboard", { value: { writeText: async (s) => { if (window.__copyFails) throw new Error("blocked"); window.__copied = s; } }, configurable: true }); };
await run("route cards: no gap count; headwinds only in Suggest a ride; share a route", `${APP}?trip=montroyal`, async (page) => {
  const cards = await page.evaluate(() => ({ subs: [...document.querySelectorAll(".rc-sub")].map((e) => e.textContent), pct: [...document.querySelectorAll(".rc-pct")].map((e) => e.textContent),
    n: document.querySelectorAll(".route-card").length }));
  // headwinds no longer shape the Go routes (even with a strong wind on record), and the checkbox lives in the Suggest form
  const wind = await page.evaluate(() => { const a = window.__app, s = a.state, len = () => s.routes.map((c) => Math.round(c.r.length)).join();
    const before = len(); s.wxData = { now: { wind: 40, dir: 90 } }; s.avoidWind = true; a.recompute(false); const after = len(); s.avoidWind = false; s.wxData = null;
    const chip = document.querySelector("#avoid-wind").closest(".toggle");
    return { same: before === after, customOnly: chip.classList.contains("custom-only"), hiddenInGo: !chip.getClientRects().length }; });
  // the share button: icon only, named, 44 px, not in the tour; Web Share gets the address that reopens the route
  await page.evaluate(shareStub);
  const btn = await page.evaluate(() => { const b = document.querySelector("#detail .share-btn"), r = b && b.getBoundingClientRect();
    return b && { label: b.getAttribute("aria-label"), text: b.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height), svg: !!b.querySelector("svg"), tour: window.pisteTour.steps.join() }; });
  await page.click("#detail .share-btn"); await until(page, () => window.__shared.length === 1);
  const web = await page.evaluate(() => { const s = window.__app.state, ll = (p) => p.map((v) => +v.toFixed(5)).join(","); const d = window.__shared[0];
    return { url: d && d.url, want: `${location.origin}${location.pathname}?from=${ll(s.from)}&to=${ll(s.to)}` }; });
  // no Web Share: the link goes to the clipboard with a toast; a refusal gets a calm message instead of silence
  await page.evaluate(() => Object.defineProperty(navigator, "share", { value: undefined, configurable: true }));
  await page.click("#detail .share-btn"); await until(page, () => window.__copied);
  const copied = await page.evaluate(() => ({ text: window.__copied, toast: document.querySelector("#toast").hidden ? "" : document.querySelector("#toast").textContent }));
  await page.evaluate(() => { window.__copyFails = true; document.querySelector("#toast").hidden = true; });
  await page.click("#detail .share-btn"); await until(page, () => !document.querySelector("#toast").hidden);
  const failed = await page.evaluate(() => document.querySelector("#toast").textContent);
  // the link reopens the same route (its ends rounded to 5 decimals)
  const was = await page.evaluate(() => window.__app.state.routes.map((c) => Math.round(c.r.length)).join());
  await page.goto(web.url, { waitUntil: "load" }); await page.waitForFunction(() => !!window.__app, null, { timeout: 90000 });
  await until(page, () => window.__app.state.routes.length > 0);
  const again = await page.evaluate(() => window.__app.state.routes.map((c) => Math.round(c.r.length)).join());
  // a classic ride shares ?classic=<id>; the made-to-order loops have nothing to share
  await page.goto(BASE + APP + "?classic=oldport", { waitUntil: "load" }); await page.waitForFunction(() => !!window.__app, null, { timeout: 90000 });
  await until(page, () => !!document.querySelector("#detail .share-btn"), null, 30000);
  await page.evaluate(shareStub); await page.click("#detail .share-btn"); await until(page, () => window.__shared.length === 1);
  const classic = await page.evaluate(() => window.__shared[0].url);
  const loops = await page.evaluate(async () => { const a = window.__app; a.setSuggMode("custom"); await a.computeSuggestions(true); return !document.querySelector(".share-btn"); });
  const ok = cards.n >= 1 && cards.subs.every((x) => !/stretch|without a bike path|tronçon/i.test(x)) && cards.pct.every((x) => /on bike paths/.test(x))
    && wind.same && wind.customOnly && wind.hiddenInGo
    && btn && btn.label === "Share this route" && btn.text === "" && btn.svg && btn.w >= 44 && btn.h >= 44 && !/share/i.test(btn.tour)
    && web.url === web.want && !/welcome|notrack/.test(web.url) && copied.text === web.url && copied.toast === "Link copied" && failed === "Couldn't copy the link"
    && again === was && /\?classic=oldport$/.test(classic) && !/welcome|notrack/.test(classic) && loops;
  return { ok, cards, wind, btn, web, copied, failed, was, again, classic, loops };
}, { width: 1440, height: 900 });

// ------------------------------------------------------------------ saved places (2026-11-02): Home, Work, others; recents; all on this device
// 2026-11-03: the chips are Home, Work, ★ and +, icon only (names in aria-label and title); ★ (once there is a saved place or a recent
// destination) opens the list of saved places and the last two destinations; an empty search bar shows no list.
const placeChips = () => [...document.querySelectorAll("#places .place")].map((b) => b.textContent.trim() || b.getAttribute("aria-label"));
const listRows = () => [...document.querySelectorAll("#place-list .pl-row")].map((b) => b.textContent.trim());
await run("saved places: icon chips, set Home, use it, ★ list (saved, last 2 destinations), edit and delete from it, no list on an empty bar, nothing sent", `${APP}`, async (page, ctx) => {
  const seen = []; ctx.on("request", (r) => seen.push(r.url() + " " + (r.postData() || "")));
  const out = {};
  const chipLook = () => page.evaluate(() => [...document.querySelectorAll("#places .place")].map((b) => ({ name: b.getAttribute("aria-label"), title: b.title, text: b.textContent.trim(), svg: !!b.querySelector("svg"),
    edge: getComputedStyle(b, "::before").borderTopStyle, w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height) })));
  out.start = await page.evaluate(placeChips);
  out.look = await chipLook();
  await page.click('#places [data-kind="home"]');   // nothing chosen yet
  out.nothingToast = await page.evaluate(() => (document.querySelector("#toast").hidden ? "" : document.querySelector("#toast").textContent));
  // choose a place, then "Set home" keeps it; Home keeps working after a reload
  await page.evaluate(() => { window.piste.setPoint("to", [-73.5745, 45.5163], "Zorglub"); });
  await page.click('#places [data-kind="home"]');
  out.afterSet = await chipLook();
  await page.reload({ waitUntil: "load" }); await page.waitForFunction(() => !!window.__app, null, { timeout: 90000 });
  out.afterReload = await page.evaluate(() => ({ chips: [...document.querySelectorAll("#places .place")].map((b) => b.getAttribute("aria-label")), store: JSON.parse(localStorage.getItem("piste-places")) }));
  // a start only: the Home chip becomes the destination and the route is made
  await page.evaluate(() => { window.piste.setPoint("from", [-73.5875, 45.5231], "Start place"); });
  await page.click('#places [data-i="0"]');
  await until(page, () => window.__app.state.routes.length > 0);
  out.routed = await page.evaluate(() => { const s = window.__app.state; return { to: s.to && s.to.map((v) => +v.toFixed(4)), label: s.toLabel, routes: s.routes.length }; });
  // "+": name the destination; it is not a chip of its own, ★ appears and lists it
  await page.click("#places .add");
  out.dialog = await page.evaluate(() => ({ open: !document.querySelector("#place-dialog").hidden, name: document.querySelector("#pl-name").value, del: document.querySelector("#pl-delete").hidden }));
  await page.fill("#pl-name", "Café Zorglub"); await page.keyboard.press("Enter");
  await until(page, () => document.querySelector("#place-dialog").hidden);
  out.named = await page.evaluate(placeChips);
  await page.click("#places .star");
  out.list = await page.evaluate(() => ({ open: !document.querySelector("#place-list").hidden, expanded: document.querySelector("#places .star").getAttribute("aria-expanded"),
    rows: [...document.querySelectorAll("#place-list .pl-row")].map((b) => b.textContent.trim()), edit: document.querySelector("#place-list .pl-edit") && document.querySelector("#place-list .pl-edit").getAttribute("aria-label") }));
  // its pencil: the place form (rename), then focus back on ★
  await page.click("#place-list .pl-edit"); await until(page, () => !document.querySelector("#place-dialog").hidden);
  out.editOpen = await page.evaluate(() => ({ title: document.querySelector("#pl-title").textContent, name: document.querySelector("#pl-name").value, listClosed: document.querySelector("#place-list").hidden }));
  await page.fill("#pl-name", "Café 2"); await page.click('#place-form button[type="submit"]');
  await until(page, () => document.querySelector("#place-dialog").hidden);
  out.renamed = await page.evaluate(() => ({ focus: document.activeElement.classList.contains("star"), names: JSON.parse(localStorage.getItem("piste-places")).map((p) => p.name) }));
  // move it to the current place, then delete it: ★ goes with it (no recent destinations yet)
  await page.evaluate(() => { window.piste.setPoint("to", [-73.6, 45.53], "Elsewhere"); });
  await page.click("#places .star"); await page.click("#place-list .pl-edit"); await until(page, () => !document.querySelector("#place-dialog").hidden);
  await page.click("#pl-use"); await until(page, () => document.querySelector("#place-dialog").hidden);
  out.moved = await page.evaluate(() => JSON.parse(localStorage.getItem("piste-places"))[1].ll);
  await page.click("#places .star"); await page.click("#place-list .pl-edit"); await until(page, () => !document.querySelector("#place-dialog").hidden);
  await page.click("#pl-delete"); await until(page, () => document.querySelector("#place-dialog").hidden);
  out.deleted = await page.evaluate(() => ({ chips: [...document.querySelectorAll("#places .place")].map((b) => b.getAttribute("aria-label")), n: JSON.parse(localStorage.getItem("piste-places")).length, focus: document.activeElement.className }));
  // an empty bar shows no list (2026-11-03); typing still searches, and a chosen destination becomes a recent one
  await page.evaluate(() => { window.piste.clearPoint("to"); document.querySelector("#to").blur(); });
  await page.click("#to");
  out.emptyBar = await page.evaluate(() => ({ focus: document.activeElement.id, list: !document.querySelector("#suggest").hidden && document.querySelectorAll("#suggest li").length }));
  await page.keyboard.type("Rachel & Papineau");
  await until(page, () => /Rachel/.test((document.querySelector("#suggest li") || {}).textContent || ""));
  await page.keyboard.press("Enter");
  out.recent = await page.evaluate(() => ({ recents: JSON.parse(localStorage.getItem("piste-recents")).length, chips: [...document.querySelectorAll("#places .place")].map((b) => b.getAttribute("aria-label")) }));
  await page.evaluate(() => { window.piste.clearPoint("to"); document.querySelector("#to").blur(); });
  await page.click("#to"); await page.keyboard.press("Backspace");
  out.emptyAgain = await page.evaluate(() => !document.querySelector("#suggest").hidden && document.querySelectorAll("#suggest li").length);
  // the list holds saved places first, then only the last two destinations; a row is used as a chip would be
  await page.evaluate(() => {
    localStorage.setItem("piste-places", JSON.stringify([{ kind: "home", name: "", ll: [-73.5745, 45.5163] }, { kind: "", name: "Atelier Bravo", ll: [-73.59, 45.53] }]));
    localStorage.setItem("piste-recents", JSON.stringify(["Rec One", "Rec Two", "Rec Three"].map((name, i) => ({ name, ll: [-73.57 - i / 100, 45.51] }))));
  });
  await page.reload({ waitUntil: "load" }); await page.waitForFunction(() => !!window.__app, null, { timeout: 90000 });
  await page.evaluate(() => { window.piste.setPoint("from", [-73.5875, 45.5231], "Start place"); });
  await page.click("#places .star");
  out.rows = await page.evaluate(listRows);
  await page.click('#place-list .pl-row[data-use="recent"]');
  await until(page, () => window.__app.state.routes.length > 0);
  out.used = await page.evaluate(() => ({ to: window.__app.state.toLabel, closed: document.querySelector("#place-list").hidden, expanded: document.querySelector("#places .star").getAttribute("aria-expanded") }));
  // keyboard: Enter on ★ opens it with focus on the first row, arrows move, Esc closes it and focus goes back to ★; a click outside closes it too
  await page.focus("#places .star"); await page.keyboard.press("Enter");
  out.kb = await page.evaluate(() => ({ open: !document.querySelector("#place-list").hidden, focus: document.activeElement.textContent.trim() }));
  await page.keyboard.press("ArrowDown");
  out.kb.next = await page.evaluate(() => document.activeElement.className);
  await page.keyboard.press("Escape");
  out.kb.esc = await page.evaluate(() => ({ closed: document.querySelector("#place-list").hidden, onStar: document.activeElement.classList.contains("star"), expanded: document.activeElement.getAttribute("aria-expanded") }));
  await page.click("#places .star"); await page.mouse.click(900, 450);
  out.outside = await page.evaluate(() => document.querySelector("#place-list").hidden);
  // clearing the recent places from the list
  await page.click("#places .star"); await page.click("#place-list .pl-clear");
  out.cleared = await page.evaluate(() => ({ recents: JSON.parse(localStorage.getItem("piste-recents")).length, star: !!document.querySelector("#places .star") }));
  await page.evaluate(() => window.__app.setLang("fr"));
  out.fr = await page.evaluate(() => [...document.querySelectorAll("#places .place")].map((b) => b.getAttribute("aria-label")));
  const safe = (u) => { try { return decodeURIComponent(u); } catch (e) { return u; } };
  const leaked = seen.filter((u) => /Zorglub|Elsewhere|Bravo|45\.5163|73\.5745/.test(safe(u)));
  const checks = {
    firstVisit: out.start.join() === "Set home,Set work,Save a place",
    iconOnly: out.look.every((c) => c.text === "" && c.svg && c.title === c.name && c.w >= 44 && c.h >= 44) && out.look[0].edge === "dashed" && out.look[1].edge === "dashed" && out.look[2].edge === "solid",
    pickFirst: /pick a place first/i.test(out.nothingToast), homeSet: out.afterSet.map((c) => c.name).join() === "Home,Set work,Save a place" && out.afterSet[0].edge === "solid" && out.afterSet[0].title === "Home",
    reload: out.afterReload.chips.join() === "Home,Set work,Save a place" && out.afterReload.store.length === 1 && out.afterReload.store[0].kind === "home",
    homeUsed: out.routed.to.join() === "-73.5745,45.5163" && out.routed.label === "Home" && out.routed.routes > 0,
    plusDialog: out.dialog.open && out.dialog.name === "Home" && out.dialog.del, noCustomChip: out.named.join() === "Home,Set work,Saved and recent places,Save a place",
    starList: out.list.open && out.list.expanded === "true" && out.list.rows.length === 1 && /^Café Zorglub\s*Saved$/.test(out.list.rows[0]) && out.list.edit === "Edit Café Zorglub",
    editFromList: out.editOpen.title === "Edit place" && out.editOpen.name === "Café Zorglub" && out.editOpen.listClosed && out.renamed.focus && out.renamed.names.join() === ",Café 2",
    moveFromList: out.moved.join() === "-73.6,45.53", deleteFromList: out.deleted.n === 1 && out.deleted.chips.join() === "Home,Set work,Save a place",
    noEmptyBarList: out.emptyBar.focus === "to" && !out.emptyBar.list && !out.emptyAgain, typedSearch: out.recent.recents === 1 && out.recent.chips.includes("Saved and recent places"),
    savedThenTwoRecents: out.rows.length === 3 && /^Atelier Bravo\s*Saved$/.test(out.rows[0]) && /^Rec One\s*Recent$/.test(out.rows[1]) && /^Rec Two\s*Recent$/.test(out.rows[2]),
    rowUsed: out.used.to === "Rec One" && out.used.closed && out.used.expanded === "false",
    keyboard: out.kb.open && /^Atelier Bravo/.test(out.kb.focus) && out.kb.next === "pl-edit" && out.kb.esc.closed && out.kb.esc.onStar && out.kb.esc.expanded === "false", outsideCloses: out.outside,
    clearRecents: out.cleared.recents === 0 && out.cleared.star, french: out.fr.join() === "Maison,Ajouter le travail,Lieux enregistrés et récents,Enregistrer un lieu", nothingSent: leaked.length === 0,
  };
  const bad = Object.keys(checks).filter((k) => !checks[k]);
  return { ok: !bad.length, ...(bad.length ? { error: "failed checks: " + bad.join(", ") } : {}), ...out, requests: seen.length, leaked };
}, { width: 1440, height: 900 });

await run("saved places (phone): four chips fit, long press edits Home, typing shows the chips and no list, ★ works with the keyboard up", `${APP}?safe=47,34`, async (page) => {
  await page.evaluate(() => {
    localStorage.setItem("piste-places", JSON.stringify([{ kind: "home", name: "", ll: [-73.5745, 45.5163] }, ...["Alpha", "Bravo place"].map((name, i) => ({ kind: "", name, ll: [-73.58 - i / 100, 45.52] }))]));
    localStorage.setItem("piste-recents", JSON.stringify([{ name: "Rec One", ll: [-73.57, 45.51] }]));
  });
  await page.reload({ waitUntil: "load" }); await page.waitForFunction(() => !!window.__app, null, { timeout: 90000 });
  await page.evaluate(() => window.__app.setSheet("half")); await page.waitForTimeout(500);
  const row = await settled(page, () => { const r = document.querySelector("#places"), chips = [...r.querySelectorAll(".place")].map((c) => c.getBoundingClientRect()), s = document.querySelector(".search");
    const withRow = s.offsetHeight; r.style.display = "none"; const without = s.offsetHeight; r.style.display = "";
    return { n: chips.length, fits: r.scrollWidth <= r.clientWidth + 1, tap44: chips.every((c) => c.height >= 44 && c.width >= 43.5), added: withRow - without, pageX: document.documentElement.scrollWidth <= innerWidth,
      panelH: Math.round(document.querySelector("#panel").getBoundingClientRect().height), half: Math.round(innerHeight / 2) }; });
  // a long press (finger held on Home) opens the editor and does not also use the place
  const hold = await page.evaluate(async () => {
    const chip = document.querySelector('#places [data-i="0"]'), b = chip.getBoundingClientRect(), o = { bubbles: true, pointerType: "touch", pointerId: 7, isPrimary: true, clientX: b.left + 20, clientY: b.top + 22 };
    chip.dispatchEvent(new PointerEvent("pointerdown", o)); await new Promise((r) => setTimeout(r, 650));
    chip.dispatchEvent(new PointerEvent("pointerup", o)); chip.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    return { open: !document.querySelector("#place-dialog").hidden, title: document.querySelector("#pl-title").textContent, usedIt: !!window.__app.state.to || !!window.__app.state.from };
  });
  await page.click("#pl-cancel"); await until(page, () => document.querySelector("#place-dialog").hidden);
  // tap the empty destination bar: the bar, the chips under it (just above the keyboard) and no list
  await page.tap("#to");
  await until(page, () => document.body.classList.contains("searching"));
  const search = await settled(page, () => { const p = document.querySelector("#panel").getBoundingClientRect(), c = document.querySelector("#places").getBoundingClientRect(), f = document.querySelector("#to").closest(".field").getBoundingClientRect();
    return { chips: getComputedStyle(document.querySelector("#places")).display !== "none", underBar: c.top >= f.bottom - 1, aboveKb: c.bottom - 7 <= innerHeight - Math.max(260, innerHeight * 0.47) + 1,
      list: !document.querySelector("#suggest").hidden, focus: document.activeElement.id }; });
  // ★ with the keyboard up: the list floats over the map just above the card, typing goes on, a row is the destination and the search ends.
  // (Taps in the first 800 ms after the one that opened search are swallowed on purpose, app.js swallowUntil: a time window, so it is waited out.)
  await page.waitForTimeout(900);
  await page.tap("#places .star");
  const star = await settled(page, () => { const l = document.querySelector("#place-list"), r = l.getBoundingClientRect(), p = document.querySelector("#panel").getBoundingClientRect();
    return { open: !l.hidden, aboveCard: r.bottom <= p.top + 1 && r.top >= 0, focus: document.activeElement.id, searching: document.body.classList.contains("searching"), rows: [...l.querySelectorAll(".pl-row")].map((b) => b.textContent.trim()) }; });
  await page.tap('#place-list .pl-row[data-use="saved"]');
  await until(page, () => !document.body.classList.contains("searching"));
  const used = await page.evaluate(() => ({ to: window.__app.state.toLabel, closed: document.querySelector("#place-list").hidden, sheet: document.querySelector("#panel").dataset.sheet }));
  const checks = { fourFit: row.n === 4 && row.fits && row.tap44 && row.pageX && row.added <= 40 && row.panelH === row.half, holdEdits: hold.open && hold.title === "Edit place" && !hold.usedIt,
    typingShowsChips: search.chips && search.underBar && search.aboveKb && !search.list && search.focus === "to",
    starOverKeyboard: star.open && star.aboveCard && star.focus === "to" && star.searching && star.rows.length === 3 && /^Alpha/.test(star.rows[0]) && /^Rec One/.test(star.rows[2]),
    rowUsed: used.to === "Alpha" && used.closed && used.sheet === "half" };
  const bad = Object.keys(checks).filter((k) => !checks[k]);
  return { ok: !bad.length, ...(bad.length ? { error: "failed checks: " + bad.join(", ") } : {}), row, hold, search, star, used };
}, { width: 390, height: 844 }, { hasTouch: true, isMobile: true });

// ---- a place's pop-up (2026-11-03): "More info" opens a web search for its name + Montréal in a new tab; named places only ----
await run("place pop-up: More info searches the name + Montréal in a new tab (named places only, EN and FR)", APP, async (page) => {
  await page.evaluate(() => window.__app.map.jumpTo({ center: [-73.5865, 45.5232], zoom: 17.3 }));   // the Plateau: cafés, bakeries, restaurants
  const layers = ["poi-cafe", "poi-food", "poi-bakery"];
  await until(page, (ls) => window.__app.map.queryRenderedFeatures({ layers: ls }).some((f) => f.properties.name), layers, 40000);
  const pt = await page.evaluate((ls) => { const m = window.__app.map, f = m.queryRenderedFeatures({ layers: ls }).find((x) => x.properties.name), p = m.project(f.geometry.coordinates), r = m.getContainer().getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y }; }, layers);
  await page.mouse.click(pt.x, pt.y);   // a real click on a business, as a rider would
  await until(page, () => !!document.querySelector(".maplibregl-popup .pop-more"));
  const link = () => page.evaluate(() => { const pop = document.querySelector(".maplibregl-popup"), a = pop && pop.querySelector(".pop-more");
    return { name: pop ? pop.querySelector("b").textContent : null, href: a && a.getAttribute("href"), target: a && a.target, rel: a && a.rel, text: a && a.textContent.trim(), h: a ? Math.round(a.getBoundingClientRect().height) : 0 }; });
  const clicked = await link();
  // the same pop-up made directly for other kinds: an unnamed restroom and a BIXI station get no link; French words it
  const make = (props, layer = "poi-cafe") => page.evaluate(([props, layer]) => { document.querySelectorAll(".maplibregl-popup").forEach((p) => p.remove());
    window.__app.poiPopup({ layer: { id: layer }, properties: props, geometry: { coordinates: [-73.5865, 45.5232] } }); }, [props, layer]);
  await make({ k: "toilets", name: "" }); const unnamed = await link();
  await make({ name: "de la Commune / Place Jacques-Cartier", bikes: 3, docks: 5, renting: true }, "bixi-live"); const bixi = await link();
  await page.evaluate(() => window.__app.setLang("fr"));
  await make({ k: "bakery", name: "Boulangerie Ange & Fils" }); const fr = await link();
  const want = (name) => `https://www.google.com/search?q=${encodeURIComponent(name + " Montréal")}`;
  const checks = { search: !!clicked.name && clicked.href === want(clicked.name), newTab: clicked.target === "_blank" && /noopener/.test(clicked.rel), words: /^More info/.test(clicked.text) && /new tab/.test(clicked.text),
    tap44: clicked.h >= 44, unnamedNone: unnamed.name !== null && unnamed.href === null, bixiNone: bixi.name !== null && bixi.href === null,
    french: /^Plus d'infos/.test(fr.text) && fr.href === want("Boulangerie Ange & Fils") && /%26/.test(fr.href) };
  const bad = Object.keys(checks).filter((k) => !checks[k]);
  return { ok: !bad.length, ...(bad.length ? { error: "failed checks: " + bad.join(", ") } : {}), clicked, unnamed, bixi, fr };
});

// ---- REM (2026-11-02): light-rail tracks and stations next to the metro, with their own Layers checkbox and credit ----
await run("REM: tracks and stations on the map, a Layers checkbox, the credit", `${APP}?trip=montroyal`, async (page) => {
  await page.evaluate(() => { window.__app.map.jumpTo({ center: [-73.5655, 45.4999], zoom: 15 }); });   // Gare Centrale
  await page.evaluate(idle);
  const out = await page.evaluate(async () => {
    const m = window.__app.map, box = document.querySelector("#layers"), cb = document.querySelector('input[data-layer="rem"]');
    const rendered = (id) => m.queryRenderedFeatures({ layers: [id] }).length;
    const before = { line: rendered("rem-line"), stations: rendered("poi-rem"), visible: m.getLayoutProperty("poi-rem", "visibility") !== "none" };
    const names = window.POIS.filter((p) => p[0] === "rem").map((p) => p[1]);
    cb.click(); await new Promise((r) => setTimeout(r, 300));
    const off = [m.getLayoutProperty("rem-line", "visibility"), m.getLayoutProperty("rem-casing", "visibility"), m.getLayoutProperty("poi-rem", "visibility")];
    cb.click(); await new Promise((r) => setTimeout(r, 300));
    const found = (await BikeCommon.makeGeocoder(window.__app.router).search("Gare Centrale")).some((r) => r.kind === "rem");
    return { before, stationCount: names.length, hasGare: names.includes("Gare Centrale"), lineColor: m.getPaintProperty("rem-line", "line-color"), image: m.hasImage("poi-rem"), off, found,
      credit: document.querySelector(".maplibregl-ctrl-attrib-inner").textContent.includes("REM (OpenStreetMap)"), label: cb.parentElement.textContent.trim() };
  });
  const ok = out.before.line > 0 && out.before.stations > 0 && out.before.visible && out.stationCount >= 20 && out.hasGare && out.lineColor === "#84BD00" && out.image
    && out.off.every((v) => v === "none") && out.found && out.credit && out.label === "REM";
  return { ok, ...out };
});

// ---- 3D trees (2026-11-02; WebGL since 2026-11-03): illustrated trees at the LiDAR tree tops (tools/island_trees.py), stood upright by shared/trees3d.js so
// buildings and hills hide the trees behind them; 3D view only, from zoom 15.5; the picture follows the season and night; the flat symbol layer "trees" is the fallback ----
// Page helpers for the pixel checks: grab(box) draws one frame now and reads a box of the canvas (CSS px from the top left); trees(box) is what the
// trees add to that box: the share of its pixels that change when they are drawn, and those pixels' mean colour. __warns keeps the console warnings.
const treeHelpers = `window.__warns = window.__warns || []; if (!console.warn.__kept) { const w = console.warn; console.warn = (...a) => { window.__warns.push(a.join(" ")); w.apply(console, a); }; console.warn.__kept = 1; }
window.__px = {
  grab(box) { const m = window.__app.map, gl = m.painter.context.gl, [x, y, w, h] = box.map((v) => Math.round(v * devicePixelRatio)), px = new Uint8Array(w * h * 4);
    m.redraw(); gl.readPixels(x, gl.drawingBufferHeight - y - h, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; },
  trees(box) {
    const m = window.__app.map, id = window.__app.state.treesGL ? "trees-gl" : "trees", show = (v) => m.setLayoutProperty(id, "visibility", v);
    show("visible"); const on = this.grab(box); show("none"); const off = this.grab(box); show("visible");
    let n = 0; const sum = [0, 0, 0];
    for (let i = 0; i < on.length; i += 4) if (Math.abs(on[i] - off[i]) + Math.abs(on[i + 1] - off[i + 1]) + Math.abs(on[i + 2] - off[i + 2]) > 24) { n++; for (let c = 0; c < 3; c++) sum[c] += on[i + c]; }
    return { share: +(n / (on.length / 4)).toFixed(3), rgb: n ? sum.map((v) => Math.round(v / n)) : [0, 0, 0] };
  },
};`;
const MONT_ROYAL = [-73.5877, 45.5035];   // the mountain's south slope: dense trees
await run("3D trees: in 3D only, a tile loads, the pictures follow summer, fall, winter and night", APP, async (page) => {
  await page.evaluate(treeHelpers);
  const cam = (is3d, zoom) => page.evaluate(([c, is3d, zoom]) => { const a = window.__app; a.set3d(is3d, false); a.map.jumpTo({ center: c, zoom, pitch: is3d ? 60 : 0, bearing: 0 }); }, [MONT_ROYAL, is3d, zoom]);
  const drawn = () => until(page, () => window.__app.trees.info().drawn > 0 && window.__app.map.loaded(), null, 30000);
  const look = async (is3d, zoom) => {   // polls until the trees are drawn (or, when none should be, until the map is still)
    await cam(is3d, zoom);
    if (is3d && zoom >= 16) await drawn(); else await page.evaluate(idle);
    return page.evaluate(() => { const m = window.__app.map, i = window.__app.trees.info(), f = m.querySourceFeatures("trees", { sourceLayer: "trees" });
      return { drawn: i.drawn, webgl: i.webgl, error: i.error, gl: m.getLayoutProperty("trees-gl", "visibility"), flat: m.getLayoutProperty("trees", "visibility"), sample: f[0] ? f[0].properties : null }; });
  };
  const d3 = await look(true, 16.2);
  // once everything is drawn the map goes quiet: the tree layer must not keep it redrawing (a slow machine may still draw a few last frames)
  await page.evaluate(idle);
  const quiet = await page.evaluate(() => new Promise((r) => { const m = window.__app.map, t = window.__app.trees, r0 = t.info().rebuilds; let frames = 0; const f = () => frames++;
    m.on("render", f); setTimeout(() => { m.off("render", f); r({ frames, rebuilds: t.info().rebuilds - r0 }); }, 2000); }));
  const far = await look(true, 15), d2 = await look(false, 16.2);
  const pics = await page.evaluate(() => {   // which pictures each layer uses: the flat layer's image names, the WebGL layer's atlas columns and row
    const a = window.__app, m = a.map, pick = () => { const e = m.getLayoutProperty("trees", "icon-image"), n = e[2][2]; return { n, suffix: e[3], names: Array.from({ length: n }, (_, k) => e[1] + k), gl: a.trees.info().pictures.join() }; };
    const when = (d) => { a.paintTrees(d); return pick(); };
    const summer = when(new Date(2026, 6, 15)), fall = when(new Date(2026, 9, 20)), beforeFall = when(new Date(2026, 8, 19)), afterFall = when(new Date(2026, 10, 16));
    const firstFall = when(new Date(2026, 8, 20)), lastFall = when(new Date(2026, 10, 15));
    a.setWinter(true); const winter = pick(); a.setWinter(false);
    document.querySelector("input[name=night][value=on]").click(); const night = pick();
    document.querySelector("input[name=night][value=off]").click();
    const all = [...summer.names, ...fall.names, ...winter.names].flatMap((n) => [n, n + "-n"]), img = m.getImage("tree-summer-0");
    return { summer, fall, winter, night: [night.suffix, night.gl.split(",")[2]], off: pick().suffix, allImages: all.length === 18 && all.every((n) => m.hasImage(n)), size: img && [img.data.width, img.data.height, img.pixelRatio],
      edges: beforeFall.names[0] === summer.names[0] && afterFall.names[0] === summer.names[0] && firstFall.names[0] === fall.names[0] && lastFall.names[0] === fall.names[0],
      layout: ["icon-anchor", "icon-pitch-alignment", "icon-rotation-alignment", "symbol-z-order"].map((k) => m.getLayoutProperty("trees", k)) };
  });
  // what the WebGL trees actually draw over the middle of the map: green in summer, warmer in fall, sparse bare branches in winter, dark at night
  const colour = async (setup, settle) => {   // settle: wait for the map to finish changing (the camera, colour transitions) first
    await page.evaluate(setup);
    if (settle) { await cam(true, 16.2); await page.evaluate(idle); await drawn(); }
    return page.evaluate(() => __px.trees([440, 200, 480, 320]));
  };
  const summerPx = await colour(() => window.__app.paintTrees(new Date(2026, 6, 15)), true);
  const fallPx = await colour(() => window.__app.paintTrees(new Date(2026, 9, 20)), false);
  const winterPx = await colour(() => window.__app.setWinter(true), true);
  const nightPx = await colour(() => { window.__app.setWinter(false); document.querySelector("input[name=night][value=on]").click(); window.__app.paintTrees(new Date(2026, 6, 15)); }, true);
  await page.evaluate(() => document.querySelector("input[name=night][value=off]").click());
  const lum = (p) => p.rgb[0] + p.rgb[1] + p.rgb[2];
  const px = { summer: summerPx, fall: fallPx, winter: winterPx, night: nightPx,
    summerGreen: summerPx.share > 0.2 && summerPx.rgb[1] > summerPx.rgb[0] && summerPx.rgb[1] > summerPx.rgb[2], fallWarm: fallPx.share > 0.2 && fallPx.rgb[0] > fallPx.rgb[1] + 15,
    winterBare: winterPx.share > 0.03 && winterPx.share < 0.6 * summerPx.share, nightDark: nightPx.share > 0.2 && lum(nightPx) < 0.6 * lum(summerPx) };
  const tileOk = await page.evaluate(async () => {   // a sample tile straight from the PMTiles file
    const p = new pmtiles.PMTiles(new URL("../shared/tiles/trees.pmtiles", location.href).href), t = await p.getZxy(15, 9685, 11722);
    return { header: (await p.getHeader()).maxZoom, bytes: t ? t.data.byteLength : 0 };
  }).catch((e) => ({ error: String(e) }));
  const ok = d3.drawn > 0 && quiet.rebuilds === 0 && quiet.frames < 20 && d3.gl === "visible" && d3.flat === "none" && d3.webgl >= 1 && !d3.error && d3.sample && d3.sample.h >= 3 && d3.sample.s >= 0 && d3.sample.s <= 255
    && far.drawn === 0 && d2.gl === "none" && d2.flat === "none"
    && [pics.summer.n, pics.fall.n, pics.winter.n].join() === "3,4,2" && pics.summer.names[0] === "tree-summer-0" && pics.fall.names[0] === "tree-fall-0" && pics.winter.names[0] === "tree-winter-0"
    && pics.summer.gl === "0,3,0" && pics.fall.gl === "3,4,0" && pics.winter.gl === "7,2,0" && pics.night.join() === "-n,1"
    && pics.edges && pics.off === "" && pics.allImages && pics.size.join() === "144,192,2"
    && pics.layout.join() === "bottom,viewport,viewport,viewport-y" && px.summerGreen && px.fallWarm && px.winterBare && px.nightDark && tileOk.bytes > 0;
  return { ok, d3, quiet, far, d2, pics, px, tileOk };
}, { width: 1000, height: 700 });

await run("3D trees: a tree behind a tall building is hidden by it; after a lost graphics context the flat pictures take over", APP, async (page) => {
  await page.evaluate(treeHelpers);
  // a 13 m tree 6 m north of a 77 m tower downtown, the camera looking north at it from the south: the tower stands between them
  const TREE = [-73.57435315847397, 45.50262012732853, 13.07];
  await page.evaluate((T) => {
    const a = window.__app; a.set3d(true, false);
    document.querySelector('input[data-layer="terrain"]').click();   // flat ground, so the picture's place on screen is exact
    a.map.jumpTo({ center: [T[0], T[1]], zoom: 17.5, pitch: 60, bearing: 0 });
  }, TREE);
  await page.evaluate(idle); await until(page, () => window.__app.trees.info().drawn > 0 && window.__app.map.loaded(), null, 30000);
  // the middle of the tree's picture, above its trunk: what the trees add there with the buildings shown, then hidden
  const measure = () => page.evaluate((T) => {
    const m = window.__app.map, p = m.project([T[0], T[1]]), ppm = 512 * 2 ** m.getZoom() / (2 * Math.PI * 6371008.8 * Math.cos(T[1] * Math.PI / 180));
    const h = 0.87 * T[2] * ppm, w = 0.75 * T[2] * ppm, box = [p.x - 0.2 * w, p.y - 0.75 * h, 0.4 * w, 0.6 * h];
    return { share: __px.trees(box).share, box: box.map(Math.round), terrain: !!m.getTerrain() };
  }, TREE);
  const buildings = async (v) => { await page.evaluate((v) => { window.__app.map.setLayoutProperty("bld-3d", "visibility", v); }, v); await page.evaluate(idle); };   // idle: flat pictures fade in
  const check = async () => {   // buildings hidden second: a hidden layer lets its tiles go
    const behind = await measure(); await buildings("none"); const open = await measure(); await buildings("visible");
    return { open: open.share, behind: behind.share, box: behind.box, terrain: behind.terrain };
  };
  const gl = await check();
  // what the map hears when a phone takes its graphics memory back (only the event: a real loss and restore also trips a MapLibre 5.24 error, see app.js)
  await page.evaluate(() => { window.__app.map.fire("webglcontextlost"); });   // (braces: the map itself is not sent back)
  await until(page, () => !window.__app.state.treesGL && window.__app.map.getLayoutProperty("trees", "visibility") === "visible", null, 15000);
  await page.evaluate(idle);
  const flat = await check();
  const after = await page.evaluate(() => ({ gl: window.__app.state.treesGL, layer: !!window.__app.map.getLayer("trees-gl"),
    warned: window.__warns.some((w) => /3D trees: WebGL drawing stopped \(WebGL context lost\)/.test(w)) }));
  // WebGL: the tree shows in the open and not behind the tower. The flat pictures are drawn over everything, the tower too (why WebGL draws them now)
  const ok = !gl.terrain && gl.open > 0.3 && gl.behind < 0.02 && !after.gl && !after.layer && after.warned && flat.open > 0.3 && flat.behind > 0.3;
  return { ok, gl, flat, after };
}, { width: 1000, height: 700 });

await run("3D trees: the Layers checkbox (Trees in 3D) is on by default and remembered; a tree shader that fails falls back to the flat pictures", APP, async (page, ctx) => {
  const box = () => page.evaluate(() => { const cb = document.querySelector('input[data-layer="trees"]'), label = cb.closest("label");
    return { checked: cb.checked, label: label.textContent.replace(/\s+/g, " ").trim(), stored: localStorage.getItem("piste-trees"), afterBuildings: !!label.previousElementSibling.querySelector('[data-layer="buildings"]') }; });
  const show3d = () => page.evaluate((c) => { const a = window.__app; a.set3d(true, false); a.map.jumpTo({ center: c, zoom: 16.2, pitch: 60, bearing: 0 }); }, MONT_ROYAL);
  const layers = () => page.evaluate(() => ["trees-gl", "trees-src", "trees"].map((id) => (window.__app.map.getLayer(id) ? window.__app.map.getLayoutProperty(id, "visibility") : "absent")).join());
  const first = await box();
  await show3d(); await until(page, () => window.__app.trees.info().drawn > 0, null, 30000);
  const shown = await layers();
  await page.evaluate(() => document.querySelector('input[data-layer="trees"]').click());
  const hidden = await layers(), off = await box();
  const fr = await page.evaluate(() => { window.__app.setLang("fr"); const t = document.querySelector('input[data-layer="trees"]').closest("label").textContent.replace(/\s+/g, " ").trim(); window.__app.setLang("en"); return t; });
  // next visit, with a tree shader that does not compile: the box is still unticked; ticking it in 3D shows the flat pictures, with a warning
  await ctx.addInitScript(() => {
    for (const GL of [window.WebGLRenderingContext, window.WebGL2RenderingContext].filter(Boolean)) {
      const source = GL.prototype.shaderSource, param = GL.prototype.getShaderParameter, ours = new WeakSet();
      GL.prototype.shaderSource = function (s, text) { if (/u_keep/.test(text)) ours.add(s); return source.call(this, s, text); };
      GL.prototype.getShaderParameter = function (s, p) { return ours.has(s) && p === this.COMPILE_STATUS ? false : param.call(this, s, p); };
    }
  });
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => !!window.__app, null, { timeout: 90000 });
  await page.evaluate(treeHelpers);
  const again = await box();
  await show3d(); await page.evaluate(idle);
  const offIn3d = await layers();
  await page.evaluate(() => document.querySelector('input[data-layer="trees"]').click());
  await until(page, () => !window.__app.state.treesGL && window.__app.map.queryRenderedFeatures({ layers: ["trees"] }).length > 0, null, 30000);
  const fell = await page.evaluate(() => ({ gl: window.__app.state.treesGL, flat: window.__app.map.queryRenderedFeatures({ layers: ["trees"] }).length, error: window.__app.trees.info().error,
    warned: window.__warns.some((w) => /3D trees: WebGL drawing stopped \(tree shader/.test(w)), stored: localStorage.getItem("piste-trees") }));
  const ok = first.checked && first.label === "Trees in 3D" && first.afterBuildings && first.stored === null && shown === "visible,visible,none" && hidden === "none,none,none"
    && !off.checked && off.stored === "0" && fr === "Arbres en 3D" && !again.checked && offIn3d.split(",").every((v) => v === "none" || v === "absent")
    && !fell.gl && fell.flat > 0 && /^tree shader/.test(fell.error || "") && fell.warned && fell.stored === "1";
  return { ok, first, shown, hidden, off, fr, again, offIn3d, fell };
}, { width: 1000, height: 700 });

await browser.close();
// ---- results: the full detail of every group (JSON), then a short summary; exit code 1 if anything failed or nothing ran ----
const failed = results.filter((r) => !r.ok);
console.log("\n=== details ===");
for (const r of results) console.log(JSON.stringify(r));
console.log("\n=== summary ===");
for (const r of results) say(r);
if (process.env.GITHUB_ACTIONS) for (const r of failed) console.log(`::error title=Piste test failed::${r.name}: ${r.error || (r.errors && r.errors[0]) || "a check was false: " + JSON.stringify({ ...r, name: undefined, ok: undefined }).slice(0, 900)}`.replace(/\r?\n/g, " "));
const total = ((Date.now() - T0) / 1000).toFixed(0);
if (!results.length) console.log(`FAILED: no test group matched${only ? ` the filter "${only}"` : ""}`);
else console.log(failed.length ? `${failed.length} of ${results.length} test(s) FAILED in ${total} s` : `all ${results.length} tests passed in ${total} s`);
process.exitCode = failed.length || !results.length ? 1 : 0;
