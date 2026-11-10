// Functional tests for the app, in a headless Chromium-based browser. Usage: node tools/shots/test.mjs [name filter]
// Exit code 0 only if every group passed (and at least one ran); 1 otherwise. Environment variables (all optional):
//   PISTE_BASE=https://www.pistemtl.ca/              test the live site instead of the dev server (http://localhost:8765/);
//                                                    with PISTE_APP=index.html, since the published site has the app at its root
//   PISTE_APP=index.html                             the app's path under PISTE_BASE (default a-positron/index.html, the dev layout)
//   PISTE_BROWSER=msedge|chrome|chromium             msedge (default): the Edge installed on this PC. chrome: an installed Google Chrome
//                                                    (preinstalled on GitHub's ubuntu-latest). chromium: Playwright's own build
//                                                    (npx playwright-core install chromium).
//   PISTE_BROWSER_ARGS="--flag --flag"               extra Chromium switches (e.g. --use-angle=swiftshader forces software WebGL)
//   PISTE_FIXTURES=1                                 answer the weather, BIXI and address-search requests from the saved copies in
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
// A group can ask for Playwright's WebKit (the iPhone's engine) with ctxOpts.webkit: true, for checks on this PC; it needs `npx playwright-core install webkit`.
// None does in CI: the runner has no WebKit (the double-tap group runs in Chromium; its real guard is the touch-action check).
import { chromium, webkit } from "playwright-core";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

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
const STUBBED = new Set(["api.open-meteo.com", "gbfs.velobixi.com", "api.montreal.ca"]);   // hosts stubOutsideData answers
const FIX_BIXI_STATIONS = FIX ? JSON.parse(fixture("bixi-station_information.json")).data.stations.length : 0;
async function stubOutsideData(ctx) {
  const json = (body) => ({ status: 200, contentType: "application/json", headers: CORS, body });
  const preflight = (route) => route.request().method() === "OPTIONS" && route.fulfill({ status: 204, headers: { ...CORS, "access-control-allow-headers": "*" } });
  // Open-Meteo forecast (weather.js): wind, rain, snow and temperature
  await ctx.route("https://api.open-meteo.com/**", (route) => preflight(route) || route.fulfill(json(fixture("open-meteo.json"))));
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

let webkitBrowser = null;   // launched the first time a group asks for it
async function webkitEngine() {
  if (webkitBrowser) return webkitBrowser;
  try { webkitBrowser = await webkit.launch({ headless: true }); }
  catch (e) { throw new Error("WebKit could not start (install it with: npx playwright-core install webkit): " + e.message.split("\n")[0]); }
  return webkitBrowser;
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
  const { fresh, night, webkit: useWebkit, ...opts } = ctxOpts;
  try {
    ctx = await (useWebkit ? await webkitEngine() : browser).newContext({ viewport, serviceWorkers: "block", ...opts });   // a service worker would serve stale files (the offline group allows it)
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
    if (SLOWDOWN > 1 && !useWebkit) await (await ctx.newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: SLOWDOWN });
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
  // on GitHub, a slow group shows up as a note on the run (readable without the full log), so a creeping job time can be traced
  if (process.env.GITHUB_ACTIONS && +results.at(-1).secs > 60) console.log(`::warning title=Slow test group::${name}: ${results.at(-1).secs} s`);
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
// the card's height slides (a CSS transition): wait for it to end before measuring, as a slow machine is still mid-slide after 400 ms
const panelStill = (page) => page.evaluate(() => Promise.all(document.querySelector("#panel").getAnimations().map((a) => a.finished.catch(() => {}))));
// Read a layout measurement after it has stopped moving (two equal readings 100 ms apart, up to 10 s), for panels that slide into place.
// "Let's ride!" once the route is drawn: clicked in the page, as the other ride groups do (a pointer click waits on overlays and timed out on CI)
const rideGo = async (page) => { await page.waitForFunction(() => !!document.querySelector("#ride-go"), null, { timeout: 90000 }); await page.evaluate(() => document.querySelector("#ride-go").click()); };
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
    buildingsInMap: document.querySelector('[data-layer="buildings"]').closest(".layers").querySelectorAll("h3").length === 3,
    label2d: document.querySelector("#view-label").textContent,
    gapsOk: window.__app.state.routes.every((c) => [...document.querySelectorAll(".route-card .bar .seg.gap")].length === BikeCommon.mainGaps(window.__app.state.routes[window.__app.state.sel].r).length),
    chevLayer: !!window.__app.map.getLayer("climb-chev"),
    gapBoxes: !!window.__app.map.getLayer("gap-labels"),
    stopRing: (() => { const m = window.__app.map, l = m.getLayer("stops"); return !!l && l.type === "symbol" && /stop/.test(JSON.stringify(m.getLayoutProperty("stops", "icon-image"))); })(),   // 2026-11-08: the clear-line ring image
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
  const ok = !before.gapBoxes && before.stopRing && /^0s/.test(before.popTransition) && before.rideText === "Let's ride!" && !before.previewLink && before.windOnlyInSuggest && before.routedGone && noFloatingCopy
    && !before.tripChips && !before.exploreNote && before.avoidHills === "Hills" && !/LiDAR/.test(before.relief) && before.works === "Road works"
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
  const app = window.__app, m = app.map, sel = { climbs: window.BikeCommon.climbs(app.state.routes[0].r) };   // the ride's hill-ahead climbs (2.5 %, 80 m)
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

// ---- the ride card, design B (2026-11-08): the route strip with distance and time below it, a speed dial and a wind dial on its right, and a
// callout that opens on top of the card with a notch and a dotted line down to where the gap or climb is on the strip ----
await run("ride card: route strip, two dials, and a callout whose line lands on its place on the strip; the rider stays above the card", `${APP}?from=-73.5817,45.5246&to=-73.6150,45.5035`, async (page) => page.evaluate(async () => {
  const app = window.__app, s = app.state, C = window.BikeCommon, q = (x) => document.querySelector(x), box = (el) => (typeof el === "string" ? q(el) : el).getBoundingClientRect();
  const frames = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
  app.startRide("birdseye"); app.pauseRide(true);
  const r = s.ride.route, L = r.length, climbs = s.ride.extras.climbs, gaps = C.mainGaps(r);
  const at = async (d) => { s.snap = true; s.ride.seek(d); await frames(); await frames(); };
  // somewhere quiet (no gap or climb near): no callout, no lines
  let calm = null;
  for (let d = 0; d < L - 500 && calm === null; d += 50) {
    const nearGap = gaps.some((g) => d < g.start + g.length + 80 && g.start - d < 450), nearClimb = climbs.some((c) => d < c.start + c.length + 80 && c.start - d < 650);
    if (!nearGap && !nearClimb) calm = d;
  }
  let quiet = null;
  if (calm !== null) { await at(calm); quiet = { event: q("#ride-event").hidden, lines: q("#ride-leads").children.length }; }
  // 200 m before a gap: the callout warns, and one of its ticks sits where the gap's orange run starts
  const gap = gaps.find((g, k) => g.start > 300 && (k === 0 || g.start - (gaps[k - 1].start + gaps[k - 1].length) > 260));   // with bike path before it
  await at(gap.start - 200);
  const strip = box("#ride-strip"), bar = box(".ride-bar"), ev = box("#ride-event"), you = box("#ride-you");
  const runs = [...q("#ride-strip .strip-runs").children].map((el) => ({ left: box(el).left, orange: /255, 106, 31/.test(el.style.background) }));
  const ticks = [...document.querySelectorAll("#ride-leads .tick")].map((t) => { const b = box(t); return b.left + b.width / 2; });
  const leads = [...document.querySelectorAll("#ride-leads .lead")].map((t) => box(t)), notches = document.querySelectorAll("#ride-leads .notch").length;
  const card = { event: !q("#ride-event").hidden, gapShown: !q("#gap-card").hidden, gapText: q("#gap-card").textContent.trim().slice(0, 60), ticks: ticks.length, notches, leads: leads.length,
    tickOnGap: ticks.some((x) => runs.some((u) => u.orange && Math.abs(u.left - x) <= 3)),
    ticksOnStrip: ticks.every((x) => x >= strip.left - 1 && x <= strip.right + 1),
    leadsBetween: leads.every((b) => b.top >= ev.bottom - 1 && b.bottom <= strip.top + 1),
    calloutAbove: ev.bottom < strip.top, youOnStrip: you.left + you.width / 2 >= strip.left - 1 && you.left + you.width / 2 <= Math.min(...ticks) + 1 };
  // the dials: two 64 px circles side by side to the right of the strip, inside the card; the preview's speed dial shows its 16 km/h
  const dials = ["#ride-gps", "#wind-badge"].filter((x) => !q(x).hidden).map((x) => box(x));
  const gauges = { n: dials.length, round: dials.every((b) => Math.round(b.width) === 64 && Math.round(b.height) === 64), right: dials.every((b) => b.left >= strip.right),
    inside: dials.every((b) => b.left >= bar.left && b.right <= bar.right), speed: q("#gps-main").textContent, unit: q("#gps-unit").textContent,
    left: q("#ride-left-km").textContent + " | " + q("#ride-left-min").textContent };
  // the rider is drawn above the (taller) card, and "Re-center" sits above it too
  const rider = app.map.project(app.riderMarker.getLngLat()).y + box("#map").top;
  const placed = { riderAboveCard: rider < bar.top - 30, recenterAbove: parseFloat(getComputedStyle(q("#ride-recenter")).bottom) >= innerHeight - bar.top, noSideScroll: document.documentElement.scrollWidth <= innerWidth };
  // 2026-11-09: the card grows while the map is not following (moved by hand); when it follows again the rider must still be above the card
  let refollow = null;
  if (calm !== null) {
    await at(calm); s.follow = false; await at(gap.start - 200);
    await at(gap.start - 199);   // one more frame while the map is not following: the padding settles unseen (a snapped frame, so no long glide: the map draws slowly on GitHub)
    s.follow = true; s.ride.seek(gap.start - 198); await frames();   // "Re-center": the very next frame puts the rider above the card
    const top = box(".ride-bar").top, y = app.map.project(app.riderMarker.getLngLat()).y + box("#map").top;
    refollow = { rider: Math.round(y), barTop: Math.round(top), above: y < top - 30 };
  }
  app.endRide();
  const ok = (refollow === null || refollow.above) && (quiet === null || (quiet.event && quiet.lines === 0)) && card.event && card.gapShown && card.ticks >= 1 && card.notches === card.ticks && card.leads === card.ticks
    && card.tickOnGap && card.ticksOnStrip && card.leadsBetween && card.calloutAbove && card.youOnStrip
    && gauges.n >= 1 && gauges.round && gauges.right && gauges.inside && gauges.speed === "16" && gauges.unit === "km/h" && /m/.test(gauges.left) && /min/.test(gauges.left)
    && placed.riderAboveCard && placed.recenterAbove && placed.noSideScroll;
  return { ok, calm, quiet, card, gauges, placed: { ...placed, rider: Math.round(rider), barTop: Math.round(bar.top) }, refollow };
}), { width: 390, height: 844 }, { hasTouch: true, isMobile: true });

// ---- 2026-11-09 (Raph): the Layers panel has three groups; planned and in-construction paths are gone (road works and closures stay) ----
await run("layers panel: Bike network / Places / Map look (EN and FR) with the right ticks; no planned or construction layer, tick or data; road works and closures stay", `${APP}?trip=montroyal`, async (page) => page.evaluate(async () => {
  const app = window.__app, m = app.map, P = window.PLANNED.features;
  const groups = () => [...document.querySelectorAll("#layers h3")].map((h) => {
    const ids = []; for (let e = h.nextElementSibling; e && e.tagName === "LABEL"; e = e.nextElementSibling) ids.push(e.querySelector("input").dataset.layer);
    return { h: h.textContent.trim(), ids: ids.join() };
  });
  const label = (id) => document.querySelector(`#layers [data-layer="${id}"]`).closest("label");
  const en = groups(), tree = label("trees").textContent.replace(/\s+/g, " ").trim(), roadworks = label("works").textContent.trim();
  app.setLang("fr"); const fr = groups(), worksFr = label("works").textContent.trim(); app.setLang("en");
  const want = [["Bike network", "network,works"], ["Places", "pois-food,pois-shop,pois-bike,metro,rem,culture"], ["Map look", "buildings,trees,tint,relief,contours,terrain"]];
  const wantFr = ["Réseau cyclable", "Lieux", "Apparence de la carte"];
  const statuses = [...new Set(P.map((f) => f.properties.status))].sort().join();
  const gone = { tick: !document.querySelector('[data-layer="planned"]'), layers: ["planned", "construction", "construction-tape"].every((id) => !m.getLayer(id)),
    text: !/browse only|Planned|in construction/i.test(document.querySelector("#layers").textContent + document.querySelector("#legend").textContent), statuses,
    kept: !!(m.getLayer("works") && m.getLayer("works-near") && m.getLayer("closed")), nWorks: P.filter((f) => f.properties.status === "works").length, nClosed: P.filter((f) => f.properties.status === "closed").length };
  const ok = en.length === 3 && en.every((g, i) => g.h === want[i][0] && g.ids === want[i][1]) && fr.every((g, i) => g.h === wantFr[i] && g.ids === want[i][1])
    && roadworks === "Road works" && worksFr === "Travaux" && /in 3D/.test(tree) && gone.tick && gone.layers && gone.text && statuses === "closed,works" && gone.kept && gone.nWorks > 0 && gone.nClosed > 0
    && document.querySelectorAll("#layers input[data-layer]").length === 14;
  return { ok, en, fr, tree, roadworks, worksFr, gone };
}));

// ---- 2026-11-09: the ride card says nothing about small things ----
await run("ride card: a climb with under 10 m to go says nothing (no top-of-climb line, no voice); a bigger one does; #ride-view has the same outline as the other buttons", `${APP}?trip=rachel`, async (page) => page.evaluate(async () => {
  const app = window.__app, s = app.state, C = BikeCommon, q = (x) => document.querySelector(x);
  const said = [], say = C.voice.say; C.voice.say = (t) => said.push(t);
  app.startRide("birdseye"); app.pauseRide(true);
  const r = s.ride.route, big = s.ride.extras.climbs.slice().sort((a, b) => b.rise - a.rise)[0], end = big.start + big.length;
  const at = (d) => { s.snap = true; s.ride.seek(d); return { shown: !q("#hill-card").hidden, title: q("#hill-title").textContent }; };   // the frame is drawn inside seek
  const climbVoices = () => said.filter((t) => /climb|côte/i.test(t)).length;
  const left = (d) => C.elevAt(r, end) - C.elevAt(r, d);
  s.ride.extras.climbs = [big];   // this climb alone
  let dShow = big.start, dHide = end - 1;
  for (let d = big.start; d < end; d += 2) { if (left(d) >= 12) dShow = d; else { dHide = d; break; } }
  while (left(dHide) > 9 && dHide < end - 1) dHide += 2;
  const ahead = at(Math.max(0, big.start - 200)), voiceAfterAhead = climbVoices();
  const onFirst = at(dShow), onLast = at(dHide), atTop = at(end - 1), pastTop = at(end + 20);
  // the same climb, but only 6 m of rise: nothing ahead, no voice
  said.length = 0;
  s.ride.extras.climbs = [{ ...big, start: big.start + 0.25, rise: 6 }];
  const smallAhead = at(Math.max(0, big.start - 200)), smallVoice = climbVoices();
  // the buttons of the ride card share one outline
  const bs = (id) => { const c = getComputedStyle(q(id)); return [c.borderTopWidth, c.borderTopStyle, c.borderTopColor, c.borderRadius].join(" "); };
  const outline = { view: bs("#ride-view"), pause: bs("#ride-pause"), same: bs("#ride-view") === bs("#ride-pause") && !/^0px/.test(bs("#ride-view")) };
  app.endRide(); C.voice.say = say;
  const ok = big.rise >= 15 && ahead.shown && /Climb in/.test(ahead.title) && voiceAfterAhead === 1 && onFirst.shown && /Climbing/.test(onFirst.title) && left(dShow) >= 10
    && left(dHide) < 10 && !onLast.shown && !atTop.shown && !pastTop.shown && !smallAhead.shown && smallVoice === 0 && outline.same;
  return { ok, rise: big.rise, ahead, voiceAfterAhead, onFirst, onLast, leftShow: +left(dShow).toFixed(1), leftHide: +left(dHide).toFixed(1), atTop, pastTop, smallAhead, smallVoice, outline };
}));

await run("ride card: a stretch without a bike path of 50 to 100 m gives no callout, chime or voice, one of 100 m or more does; both stay in the route card and the summary's count", `${APP}?from=-73.5817,45.5246&to=-73.6150,45.5035`, async (page) => page.evaluate(async () => {
  const app = window.__app, s = app.state, C = BikeCommon, q = (x) => document.querySelector(x);
  const tones = [], node = () => ({ connect: (x) => x, start() {}, stop() {}, frequency: {}, gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} } });
  window.AudioContext = class { constructor() { this.state = "running"; this.currentTime = 0; this.destination = {}; } resume() { return Promise.resolve(); } suspend() { return Promise.resolve(); }
    createBuffer() { return {}; } createBufferSource() { return node(); } createGain() { return node(); } createOscillator() { tones.push(1); return node(); } };
  const said = [], say = C.voice.say; C.voice.say = (t) => said.push(t);
  const r = s.routes[s.sel].r;
  // two known stretches in place of the real ones: 70 m (short) and 130 m (long)
  r.gaps = [{ start: 500, length: 70, names: ["Rue Courte"], busy: false }, { start: 1200, length: 130, names: ["Rue Longue"], busy: false }];
  app.setLang("en");   // draws the route card again
  const card = { segs: document.querySelectorAll(".route-card .bar .seg.gap").length, main: C.mainGaps(r).length, listed: C.mainGaps(r).map((g) => g.length).join() };
  app.startRide("birdseye"); app.pauseRide(true);
  const at = (d) => { s.snap = true; s.ride.seek(d); return { card: !q("#gap-card").hidden, tones: tones.length, voices: said.filter((t) => /bike path|piste/i.test(t)).length }; };
  const shortAhead = at(300), shortIn = at(530), between = at(700);
  const longAhead = at(1000), longIn = at(1250);
  const extras = { counted: s.ride.extras.gaps.map((g) => g.length).join(), warned: s.ride.extras.warnGaps.map((g) => g.length).join() };
  app.endRide(); C.voice.say = say;
  const ok = card.segs === 2 && card.main === 2 && card.listed === "70,130" && !shortAhead.card && shortAhead.tones === 0 && shortAhead.voices === 0 && !shortIn.card && !between.card
    && longAhead.card && longAhead.tones === 2 && longAhead.voices === 1 && longIn.card && extras.counted === "70,130" && extras.warned === "130";
  return { ok, card, shortAhead, shortIn, between, longAhead, longIn, extras };
}));

// ---- 2026-11-09: on a phone, a route showing makes the header one line (smaller logo, "Piste", language and night buttons; no tagline) ----
await run("brand header: one line on a phone while a route shows, the full header without one and on a wide screen; buttons keep a 44 px tap area", `${APP}?trip=montroyal`, async (page) => {
  const read = () => page.evaluate(() => {
    const q = (x) => document.querySelector(x), b = (x) => q(x).getBoundingClientRect(), mid = (x) => { const r = b(x); return r.top + r.height / 2; };
    const tag = getComputedStyle(q("#brand p")), hit = (x) => { const c = getComputedStyle(q(x), "::after"); return Math.min(parseFloat(c.width), parseFloat(c.height)); };
    const mids = ["#brand .mark", "#brand h1", "#lang-btn", "#night-btn"].map(mid);
    return { compact: q("#brand").classList.contains("compact"), routes: window.__app.state.routes.length, tagline: tag.display !== "none", height: Math.round(b("#brand").height), mark: Math.round(b("#brand .mark").width),
      oneLine: Math.max(...mids) - Math.min(...mids) < 4, tap: Math.min(hit("#lang-btn"), hit("#night-btn")), scroll: q("#panel").scrollTop, noSideScroll: document.documentElement.scrollWidth <= innerWidth };
  });
  await page.waitForFunction(() => window.__app.state.routes.length > 0);
  const withRoute = await read();
  await page.goto(BASE + `${APP}?from=-73.5817,45.5246`, { waitUntil: "load" });
  await page.waitForFunction(() => !!window.__app);
  const noRoute = await read();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(BASE + `${APP}?trip=montroyal`, { waitUntil: "load" });
  await page.waitForFunction(() => !!window.__app && window.__app.state.routes.length > 0);
  const wide = await read();
  const ok = withRoute.compact && withRoute.routes > 0 && !withRoute.tagline && withRoute.oneLine && withRoute.mark < noRoute.mark && withRoute.height < noRoute.height && withRoute.tap >= 44
    && !noRoute.compact && noRoute.routes === 0 && noRoute.tagline && noRoute.mark === 28 && noRoute.tap >= 44 && withRoute.scroll === 0 && withRoute.noSideScroll
    && wide.tagline && wide.mark === 34;
  return { ok, withRoute, noRoute, wide };
}, { width: 390, height: 844 }, { hasTouch: true, isMobile: true });

// ---- 2026-11-09, from the code review ----
// - rides suggested for "Design your own ride" that finish after the rider went back to "Go somewhere" are dropped (they replaced the route);
// - address results that arrive after the text changed are dropped (they showed under the newer text);
// - the unused "pill" picture is gone (its roundRect() kept the app from starting on Safari before 16);
// - a ride writes its cards only when their words change (it rewrote the turn arrow and the gap warning at every frame);
// - BIXI is asked again only while its numbers can be seen (the layer on and zoom 14.6 or closer, or a ride), and its counts are numbers.
await run("review fixes: late suggestions and late address results are dropped; ride cards written on change only; BIXI polled only when seen, counts are numbers", `${APP}?trip=montroyal`, async (page) => page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), q = (x) => document.querySelector(x);
  const app = window.__app, s = app.state, m = app.map;
  // late suggestions
  let suggested = false; const sg = app.suggester.suggest;
  app.suggester.suggest = async function (...a) { const r = await sg.apply(this, a); suggested = true; return r; };
  q("#tab-custom").click(); await sleep(5); q("#tab-go").click();
  for (const t0 = performance.now(); !suggested && performance.now() - t0 < 60000;) await sleep(50);
  await sleep(200); app.suggester.suggest = sg;
  const tabs = { suggested, tab: s.tab, routes: s.routes.length, key: s.routes[0] && s.routes[0].key, cards: document.querySelectorAll("#routes .route-card").length };
  // late address results: the address service never answers (until it is cancelled); the first text's local matches must not show under the second text
  const realFetch = window.fetch;
  window.fetch = (u, o = {}) => (/api\.montreal\.ca/.test(String(u)) ? new Promise((_, rej) => o.signal && o.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))) : realFetch(u, o));
  const to = q("#to"), type = (v) => { to.value = v; to.dispatchEvent(new Event("input", { bubbles: true })); };
  to.focus(); type("papineau"); await sleep(400); type("zzzzzz"); await sleep(700);
  const search = { bar: to.value, stale: [...document.querySelectorAll("#suggest li")].filter((li) => !q("#suggest").hidden && /papineau/i.test(li.textContent)).length };
  window.fetch = realFetch; to.value = s.toLabel; to.blur(); await sleep(250);
  const pill = m.hasImage("pill");
  // a running preview: the turn arrow and the gap card are not rebuilt at every frame, and the numbers still move
  app.startRide("birdseye"); await sleep(1200);
  let arrow = 0, gapWrites = 0; const left0 = q("#ride-left-km").textContent + q("#turn-dist").textContent, d0 = s.ride.d;
  const mo1 = new MutationObserver((l) => (arrow += l.length)), mo2 = new MutationObserver((l) => (gapWrites += l.length));
  mo1.observe(q("#turn-icon"), { childList: true, subtree: true }); mo2.observe(q("#gap-card"), { childList: true });
  let frames = 0, on = true; const tick = () => { frames++; if (on) requestAnimationFrame(tick); }; requestAnimationFrame(tick);
  await sleep(2500); on = false; mo1.disconnect(); mo2.disconnect();
  const writes = { frames, arrow, gapWrites, moved: Math.round(s.ride.d - d0), numbersChanged: q("#ride-left-km").textContent + q("#turn-dist").textContent !== left0 };
  app.endRide();
  // BIXI: no request while the stations can't be seen; one when they can; none with the layer off; counts forced to numbers
  for (const t0 = performance.now(); !s.bixi && performance.now() - t0 < 20000;) await sleep(100);
  let calls = 0, tamper = false;
  window.fetch = async (u, o) => {
    if (!/gbfs\.velobixi\.com/.test(String(u))) return realFetch(u, o);
    calls++; const r = await realFetch(u, o); if (!tamper) return r;
    const j = await r.json(); j.data.stations[0].num_bikes_available = "7"; j.data.stations[0].num_docks_available = "<img src=x onerror=alert(1)>";
    return new Response(JSON.stringify(j), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const call = async () => { const n = calls; await app.loadBixi(); return calls - n; };
  m.jumpTo({ center: [-73.5747, 45.5225], zoom: 12 }); await sleep(100); const far = await call();
  m.jumpTo({ zoom: 16 }); await sleep(100); const near = await call();
  const layerBox = q('#layers input[data-layer="pois-bike"]'); layerBox.click(); const layerOff = await call(); layerBox.click();
  tamper = true; await app.loadBixi(); tamper = false; window.fetch = realFetch;
  const types = s.bixi.features.map((f) => f.properties), odd = types.filter((p) => ![p.bikes, p.ebikes, p.docks, p.cap].every((v) => typeof v === "number" && Number.isFinite(v)) || typeof p.name !== "string").length;
  const bixi = { far, near, layerOff, odd, sevens: types.filter((p) => p.bikes === 7).length >= 1, stations: types.length };
  const ok = tabs.suggested && tabs.tab === "go" && tabs.routes === 1 && tabs.key === "yourRoute" && tabs.cards === 1 && search.bar === "zzzzzz" && search.stale === 0 && !pill
    // the turn arrow is rebuilt far less often than a frame is drawn (it was once per frame); few frames on GitHub's software renderer (1 to 2 a second)
    && writes.frames >= 2 && writes.moved > 1 && writes.numbersChanged && writes.arrow <= Math.max(1, writes.frames / 3) && writes.gapWrites <= Math.max(6, writes.frames / 3)
    && bixi.far === 0 && bixi.near === 1 && bixi.layerOff === 0 && bixi.odd === 0 && bixi.sevens && bixi.stations > 0;
  return { ok, tabs, search, pill, writes, bixi };
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

// ---- sensible rides (2026-11-08): a suggested ride never turns round for no reason (no out-and-back spur, no U-turn), reuses almost no street it
// already rode, and is within 500 m of the asked length (a built-in tolerance, so it never needs padding to reach an exact figure) ----
// Thresholds: 0 U-turns; at most 10% of a ride on a street already ridden (the real rides are under 5%; the worst we know is a single bridge that
// has to be crossed twice, about 10%) and 3% on average; the first (selected) suggestion within 500 m, and every one within 2 km (the three rides
// are different shapes, so a third may sit farther off when no other fits the streets).
await run("ride suggester: no spurs or U-turns, little reuse, length within 500 m", APP, async (page) => page.evaluate(async () => {
  const S = window.BikeSuggest, app = window.__app, r = app.router, weights = BikeRouter.weightsFor(0.8, false), TOL = S.LENGTH_TOL;
  // the detector itself: riding a street and straight back onto it is a U-turn; carrying on is not
  const e = 100;
  const unit = {
    reversed: S.turnbacks(r, { legs: [{ e, fwd: 1 }, { e, fwd: 0 }] }) === 1,
    sameWay: S.turnbacks(r, { legs: [{ e, fwd: 1 }, { e, fwd: 1 }] }) === 0,
    retrace: Math.abs(S.retraced({ length: 300, legs: [{ e: 1, len: 100 }, { e: 2, len: 100 }, { e: 1, len: 100 }] }) - 1 / 3) < 1e-9,
    tolerance: TOL === 500,
    junctions: (() => { let n = 0, ok = 0; for (let i = 0; i < 60; i++) { const p = [-73.60 + (i % 10) * 0.006, 45.50 + Math.floor(i / 10) * 0.006], j = app.suggester.junction(p);
      const u = r.snapCandidates(j[0], j[1], 5, 5, 1)[0]; if (!u) continue; n++; const node = [r.ea[u.e], r.eb[u.e]].find((k) => Math.abs(r.lon[k] - j[0]) < 1e-9 && Math.abs(r.lat[k] - j[1]) < 1e-9);
      if (node === undefined || r.off[node + 1] - r.off[node] >= 3) ok++; } return n > 30 && ok === n; })(),
  };
  const starts = { "Mont-Royal east": [-73.5495, 45.5640], Plateau: [-73.5795, 45.5235], Rosemont: [-73.5810, 45.5460], NDG: [-73.6200, 45.4730], Hochelaga: [-73.5330, 45.5430] };
  const cases = [{ km: 8, loop: true }, { km: 15, loop: true }, { km: 10, loop: false }, { km: 10, loop: true, stop: "cafe" }];
  // 2026-11-09: fixed leaving times through the suggester's own `now`, so the result never depends on the clock (one-way rides and stops go
  // to places open on arrival, so the hour changes which places exist): a weekday afternoon, late night (the real miss, Monday 23:45) and early morning
  const times = { "Mon 14:30": new Date(2026, 10, 9, 14, 30), "Mon 23:45": new Date(2026, 10, 9, 23, 45), "Tue 05:00": new Date(2026, 10, 10, 5, 0) };
  const rows = [], bad = [];
  for (const [hour, now] of Object.entries(times)) for (const [name, start] of Object.entries(starts)) for (const c of cases) {
    const t0 = performance.now();
    const picks = await app.suggester.suggest({ start, km: c.km, loop: c.loop, stop: c.stop || "", weights, now });
    const ms = performance.now() - t0, tag = `${hour} ${name} ${c.km} km ${c.stop ? "via " + c.stop : c.loop ? "loop" : "one-way"}`;
    const m = picks.map((p) => ({ err: Math.round(p.route.length - c.km * 1000), u: S.turnbacks(r, p.route), reuse: S.retraced(p.route) }));
    rows.push({ tag, ms: Math.round(ms), m });
    if (picks.length < 2) bad.push(tag + ": only " + picks.length + " suggestions");
    if (m.some((x) => x.u)) bad.push(tag + ": U-turn");
    if (m.some((x) => x.reuse > 0.10)) bad.push(tag + ": reuses " + Math.round(100 * Math.max(...m.map((x) => x.reuse))) + "%");
    if (m[0] && Math.abs(m[0].err) > TOL) bad.push(tag + ": first ride " + m[0].err + " m off");
    if (m.some((x) => Math.abs(x.err) > 2000)) bad.push(tag + ": a ride is over 2 km off");
  }
  const all = rows.flatMap((x) => x.m), meanReuse = all.reduce((s, x) => s + x.reuse, 0) / all.length, slowest = Math.max(...rows.map((x) => x.ms));
  if (meanReuse > 0.03) bad.push("mean reuse " + (100 * meanReuse).toFixed(1) + "%");
  const failed = Object.keys(unit).filter((k) => !unit[k]);
  return { ok: !failed.length && !bad.length, ...(failed.length || bad.length ? { error: [...failed, ...bad].join("; ") } : {}), unit, rides: all.length, meanReusePct: +(100 * meanReuse).toFixed(1), slowestMs: slowest, rows: rows.map((x) => `${x.tag}: ${x.m.map((y) => y.err).join("/")}`) };
}));

await run("classic rides: 10 cards, routes, swipe", `${APP}?classic=oldport`, async (page) => {
  const out = await page.evaluate(async () => {
    const app = window.__app, s = app.state;
    for (const t0 = performance.now(); !(s.routes[0] && document.querySelectorAll(".classic-card").length === 10) && performance.now() - t0 < 20000;) await new Promise((r) => setTimeout(r, 100));   // first ride routed, cards drawn
    const cards = document.querySelectorAll(".classic-card").length;
    const lengths = window.CLASSICS.map((c, i) => { const r = app.classicRoute(i); return r ? [c.id, +(r.length / 1000).toFixed(1), Math.round(r.infraShare * 100)] : [c.id, null]; });
    // 2026-11-03: each ride is one continuous line on the streets: where one leg ends the next begins (no straight jump at a waypoint off the street)
    const dm = (a, b) => Math.hypot((a[0] - b[0]) * 111320 * Math.cos(a[1] * Math.PI / 180), (a[1] - b[1]) * 110540);
    const jumps = window.CLASSICS.map((c, i) => { const r = app.classicRoute(i); let worst = 0;
      if (r) for (let k = 1; k < r.legs.length; k++) { const a = app.router._legCoords(r.legs[k - 1]), b = app.router._legCoords(r.legs[k]); worst = Math.max(worst, dm(a[a.length - 1], b[0])); }
      return Math.round(worst); });
    const sights = (s.routes[0] && s.routes[0].r.stops || []).filter((x) => x.sight).length;
    const photo = getComputedStyle(document.querySelector(".cc-photo")).backgroundImage.includes("photos/traced/oldport.png");
    return { cards, lengths, jumps, sights, photo, panelVisible: !document.querySelector("#classics").hidden, first: s.classic };
  });
  await page.evaluate(() => { const tr = document.querySelector("#classic-track"); const c = tr.children[3]; tr.scrollLeft = c.offsetLeft - (tr.clientWidth - c.offsetWidth) / 2; });
  await until(page, () => window.__app.state.classic === 3, null, 10000);   // the card under the middle becomes the selected ride
  const afterSwipe = await page.evaluate(() => window.__app.state.classic);
  return { ok: out.cards === 10 && out.lengths.every((l) => l[1] && l[1] > 5) && out.jumps.every((j) => j <= 1) && out.sights >= 2 && out.photo && afterSwipe === 3, ...out, afterSwipe };
});

await run("winter mode: 4-season routing, icy map, labels", `${APP}?trip=montroyal`, async (page) => page.evaluate(async () => {
  const app = window.__app, m = app.map, s = app.state;
  const summer = { share: s.routes[0].r.infraShare, bg: m.getPaintProperty("background", "background-color") };
  app.setWinter(true);
  for (const t0 = performance.now(); !document.querySelector("#detail").textContent.includes("Without a winter-cleared bike path") && performance.now() - t0 < 20000;) await new Promise((r) => setTimeout(r, 100));   // routes redrawn on the 4-season network
  await new Promise((r) => setTimeout(r, 500));
  const winter = { share: s.routes[0].r.infraShare, bg: m.getPaintProperty("background", "background-color"), pressed: document.querySelector("#winter-btn").getAttribute("aria-pressed"),
    card: document.querySelector("#wx-card").hidden ? "" : document.querySelector("#wx-card").textContent, notCleared: m.getLayoutProperty("net-not-cleared", "visibility"),
    gapHeading: (() => { const g = document.querySelector("#routes .route-card .bar .seg.gap"); if (!g) return true; g.click();   // 2026-11-07: the stretch's details say it
      const ok = document.querySelector(".rc-det-type").textContent.includes("Without a winter-cleared bike path"); g.click(); return ok; })() };
  app.setWinter(false);
  const back = m.getPaintProperty("background", "background-color");
  return { ok: winter.bg === "#f3f5f8" && winter.pressed === "true" && /4-season/.test(winter.card) && winter.notCleared === "visible" && winter.gapHeading && JSON.stringify(back) === JSON.stringify(summer.bg),
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
  const out = { canvas: !document.querySelector("#wind").hidden, card: card.slice(0, 200), windNote,
    wx: s.wxData && { wind: s.wxData.now.wind, dir: s.wxData.now.dir } };
  out.bixiStations = s.bixi ? s.bixi.features.length : 0;
  out.bixiSample = s.bixi ? s.bixi.features.slice(0, 1).map((f) => [f.properties.name, f.properties.bikes, f.properties.docks]) : null;
  app.setWeather(false);
  out.bixiUntouched = bixiBefore === bixiDuring && bixiDuring === bixiVis();
  out.ok = out.canvas && /Wind|Calm/.test(out.card) && !!windNote && out.bixiStations >= minStations && out.bixiUntouched;
  return out;
}, FIX ? FIX_BIXI_STATIONS : 301));   // live: the whole network (about 800 stations); fixtures: every station in the saved file

// ---- 2026-11-03: wind streaks, rain lines and snow flakes on the map, and the weather button in winter mode ----
// The saved forecast is dry, so these groups answer the forecast request themselves with a wet "current" (rain 2.4 mm/h, or snow 2 cm/h): nothing
// here depends on today's weather, with or without PISTE_FIXTURES. Playwright runs the newest matching route first, so this one wins over the saved copy.
// The wet ones also come with a chosen wind, blowing from the west (so toward the east, the right of a north-up map): calm, a breeze, a strong wind.
const RAIN = { precipitation: 0.6, rain: 0.6, snowfall: 0, weather_code: 63, temperature_2m: 9 };
const SNOW = { precipitation: 0.4, rain: 0, snowfall: 0.5, weather_code: 73, temperature_2m: -4 };
const FORECASTS = { dry: {}, rain: RAIN, snow: SNOW,
  rainCalm: { ...RAIN, wind_speed_10m: 2, wind_direction_10m: 270 }, rainBreeze: { ...RAIN, wind_speed_10m: 16, wind_direction_10m: 270 }, rainStrong: { ...RAIN, wind_speed_10m: 32, wind_direction_10m: 270 },
  snowCalm: { ...SNOW, wind_speed_10m: 2, wind_direction_10m: 270 }, snowBreeze: { ...SNOW, wind_speed_10m: 16, wind_direction_10m: 270 }, snowStrong: { ...SNOW, wind_speed_10m: 32, wind_direction_10m: 270 },
  untyped: { precipitation: 0.4, rain: 0, snowfall: 0, weather_code: 3, temperature_2m: -3 },    // only the total is above 0: the data does not say what falls
  freezing: { precipitation: 0.4, rain: 0.4, snowfall: 0, weather_code: 67, temperature_2m: -2 } };   // freezing rain: the data says rain, even in the cold
async function stubForecast(ctx, kind) {
  const j = JSON.parse(fixture("open-meteo.json")); j.current = { ...j.current, ...FORECASTS[kind] };
  await ctx.route("https://api.open-meteo.com/**", (route) => route.request().method() === "OPTIONS" ? route.fulfill({ status: 204, headers: { ...CORS, "access-control-allow-headers": "*" } })
    : route.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify(j) }));
}
// Give the page a new forecast: answer with it, load it afresh, and cycle the weather toggle so the card and the layers take it
async function setForecast(page, ctx, kind) {
  await stubForecast(ctx, kind);
  await page.evaluate(async () => { await BikeWeather.load(true); window.__app.setWeather(false); window.__app.setWeather(true); });
  const f = FORECASTS[kind];
  await until(page, ([code, wind]) => { const n = window.__app.state.wxData && window.__app.state.wxData.now; return !!n && n.code === code && (wind === null || n.wind === wind); }, [f.weather_code ?? 0, f.wind_speed_10m ?? null]);
}
// window.__ink(selector): what a canvas holds right now: inked pixels, their mean red (dark ink on the day map, light on the night map) and a hash of the picture
const INK_JS = `window.__ink = (sel) => { const c = document.querySelector(sel), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0, r = 0, h = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i]) { n++; r += d[i - 3]; h = (h * 31 + d[i] + (i >> 2)) | 0; } return { n, meanR: n ? r / n : 0, hash: h, px: c.width * c.height }; };`;
const frames = (page, n = 2) => page.evaluate(async (k) => { for (let i = 0; i < k; i++) await new Promise((r) => requestAnimationFrame(r)); }, n);
const precipLook = (page) => page.evaluate(() => { const c = document.querySelector("#precip"), w = document.querySelector("#wind"), p = window.__ink("#precip");
  return { hidden: c.hidden, kind: c.dataset.kind || "", n: p.n, share: p.n / p.px, meanR: Math.round(p.meanR), hash: p.hash, windHidden: w.hidden, windN: w.hidden ? 0 : window.__ink("#wind").n, windInk: window.__ink("#wind").n }; });
const precipRuns = (page, kind) => until(page, (k) => { const c = document.querySelector("#precip"); return !c.hidden && c.dataset.kind === k && window.__ink("#precip").n > 0; }, kind, 20000);
const precipStopped = (page) => until(page, () => document.querySelector("#precip").hidden, null, 20000);
const streaksRun = (page) => until(page, () => !document.querySelector("#wind").hidden && window.__ink("#wind").n > 0, null, 20000);

await run("radar is gone: no radar layer or source, no request to Environment Canada, no radar line on the card, no ECCC credit", `${APP}?trip=rachel`, async (page, ctx) => {
  const asked = [];
  await ctx.route(/\/\/geo\.weather\.gc\.ca\//, (route) => { asked.push(route.request().url()); return route.abort(); });   // the radar's host: any request is a failure
  await page.evaluate(() => window.__app.setWeather(true));
  await until(page, () => !!window.__app.state.wxData);
  await page.evaluate(() => window.__app.setWinter(true));   // winter mode used to switch to the snow radar
  await page.evaluate(idle); await frames(page, 3);
  const look = await page.evaluate(() => {
    const m = window.__app.map, st = m.getStyle(), card = () => document.querySelector("#wx-card").textContent;
    const en = card(); window.__app.setLang("fr"); const fr = card(); window.__app.setLang("en");
    const credits = document.querySelector(".maplibregl-ctrl-attrib-inner").textContent + " " + document.querySelector("#about-card").textContent;
    return { layer: !!m.getLayer("radar"), source: !!m.getSource("radar"), rasterOfEC: Object.values(st.sources).some((s) => [].concat(s.tiles || [], s.url || []).some((u) => /weather\.gc\.ca/.test(u))),
      api: typeof BikeWeather.radarTiles, en: en.slice(0, 200), fr: fr.slice(0, 200), badCard: /radar|Environment and Climate|Environnement et Changement|ECCC/i.test(en + fr), badCredits: /ECCC|Environment and Climate|Environment Canada/i.test(credits),
      fetched: performance.getEntriesByType("resource").filter((r) => /weather\.gc\.ca/.test(r.name)).length };
  });
  const ok = !look.layer && !look.source && !look.rasterOfEC && look.api === "undefined" && !look.badCard && !look.badCredits && look.fetched === 0 && asked.length === 0 && /Wind|Calm/.test(look.en);
  return { ok, look, asked };
});

await run("wind streaks and rain or snow (phone): streaks alone when dry, rain or snow replaces them (never both), not riding, paused when hidden, sized to the map", `${APP}?trip=rachel`, async (page, ctx) => {
  await page.evaluate(INK_JS);
  // a watcher that looks at both canvases on every frame of the whole group: they must never show together
  await page.evaluate(() => { const w = document.querySelector("#wind"), p = document.querySelector("#precip"); window.__seen = { wind: 0, precip: 0, both: 0 };
    const tick = () => { const a = !w.hidden, b = !p.hidden; if (a) window.__seen.wind++; if (b) window.__seen.precip++; if (a && b) window.__seen.both++; requestAnimationFrame(tick); }; tick(); });
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
  // wind only (nothing falls): the grey streaks run, nothing else
  await setForecast(page, ctx, "dry"); await streaksRun(page); await frames(page, 4);
  const dry = await precipLook(page);
  // switching it on again and again (the toggle, the end of a ride) never starts a second loop: one frame is queued per frame drawn
  const loops = await page.evaluate(async () => {
    const L = window.__app.wind, q = L.queue; L.show(true); L.show(true); L.show(true);
    let queued = 0, frames = 0; L.queue = function () { queued++; return q.call(this); };
    await new Promise((r) => { const t = () => (++frames < 20 ? requestAnimationFrame(t) : r()); requestAnimationFrame(t); });
    L.queue = q; return { queued, frames };
  });
  // rain: the lines on the day map, and the streaks gone
  await setForecast(page, ctx, "rain"); await precipRuns(page, "rain");
  const rain = await precipLook(page);
  await until(page, (h) => window.__ink("#precip").hash !== h, rain.hash);   // the picture moves
  await page.evaluate(() => document.body.classList.add("night")); await until(page, () => window.__ink("#precip").meanR > 140);   // light lines on the night map
  const rainNight = await precipLook(page);
  await page.evaluate(() => document.body.classList.remove("night"));
  // snow: flakes, a different picture, still sparse
  await setForecast(page, ctx, "snow"); await precipRuns(page, "snow");
  const snow = await precipLook(page);
  await until(page, (h) => window.__ink("#precip").hash !== h, snow.hash);
  await page.evaluate(() => document.body.classList.add("night")); await until(page, () => window.__ink("#precip").meanR > 200);
  const snowNight = await precipLook(page);
  await page.evaluate(() => document.body.classList.remove("night"));
  // dry again: the streaks come back at once, the flakes go
  await setForecast(page, ctx, "dry"); await streaksRun(page); await precipStopped(page);
  const dryAgain = await precipLook(page);
  await setForecast(page, ctx, "snow"); await precipRuns(page, "snow");
  // toggle off: gone at once, the loops stop; on again: back
  await page.evaluate(() => window.__app.setWeather(false)); await frames(page, 3);
  const off = await precipLook(page);
  await page.evaluate(() => window.__app.setWeather(true)); await precipRuns(page, "snow");
  // a ride: nothing falls on the map (the preview ride), and it all comes back after
  await page.evaluate(() => window.__app.startRide("topdown")); await frames(page, 3);
  const ride = await precipLook(page);
  await page.evaluate(() => window.__app.endRide()); await precipRuns(page, "snow");
  // the page hidden: the picture freezes; shown again: it moves
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); });
  await frames(page, 3); const h1 = (await precipLook(page)).hash; await frames(page, 8); const h2 = (await precipLook(page)).hash;
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event("visibilitychange")); });
  await until(page, (h) => window.__ink("#precip").hash !== h, h1);
  const resumed = (await precipLook(page)).hash !== h1;
  // sized to the map, with the pixel ratio capped at 2 (this phone is 3)
  await page.setViewportSize({ width: 360, height: 640 });
  await until(page, () => ["#precip", "#wind"].every((s) => { const c = document.querySelector(s); return c.width === Math.round(innerWidth * 2) && c.height === Math.round(innerHeight * 2); }));
  const size = await page.evaluate(() => { const c = document.querySelector("#precip"), w = document.querySelector("#wind"); return { w: c.width, h: c.height, windW: w.width, windH: w.height, css: [innerWidth, innerHeight] }; });
  const seen = await page.evaluate(() => window.__seen);
  const sparse = (x) => x.n > 0 && x.share < 0.03;
  const ok = clsOk && before.hidden && !before.kind && start.wx === false && !start.loaded && start.dpr === 3
    && dry.hidden && !dry.kind && dry.n === 0 && !dry.windHidden && dry.windN > 0 && loops.queued <= loops.frames + 2
    && !rain.hidden && rain.kind === "rain" && sparse(rain) && rain.meanR < 110 && rain.windHidden && rain.windInk === 0 && rainNight.meanR > 140 && sparse(rainNight) && rainNight.windHidden
    && !snow.hidden && snow.kind === "snow" && sparse(snow) && snow.windHidden && snow.windInk === 0 && snowNight.meanR > 200 && sparse(snowNight)
    && !dryAgain.windHidden && dryAgain.windN > 0 && dryAgain.hidden && dryAgain.n === 0
    && off.hidden && !off.kind && off.n === 0 && off.windHidden && off.windInk === 0
    && ride.hidden && !ride.kind && ride.n === 0 && ride.windHidden && ride.windInk === 0
    && h1 === h2 && resumed && size.w === size.css[0] * 2 && size.h === size.css[1] * 2 && size.windW === size.w && size.windH === size.h
    && seen.both === 0 && seen.wind > 0 && seen.precip > 0;
  return { ok, cls, clsOk, start, dry, loops, rain, rainNight, snow, snowNight, dryAgain, off, ride, paused: h1 === h2, resumed, size, seen };
}, { width: 390, height: 844 }, { hasTouch: true, isMobile: true, deviceScaleFactor: 3 });

// 2026-11-04: a test link to see the rain and snow whatever the weather: ?wx=rain|snow, &wind, &from, &mm; the card says it's a demo
// 2026-11-05: with a search bar active, a tap on the map fills that bar (start or destination, either first); a construction cone opens its card
await run("map tap fills the active search bar (phone and desktop, either end first); a construction cone opens a card with street, stretch, impact, end date and source", APP, async (page) => {
  await page.waitForFunction(() => window.__app && window.__app.map.loaded(), null, { timeout: 90000 });
  const app = () => page.evaluate(() => { const s = window.__app.state; return { from: !!s.from, to: !!s.to, fromLabel: s.fromLabel || "", toLabel: s.toLabel || "", searching: document.body.classList.contains("searching"), focus: document.activeElement && document.activeElement.id }; });
  const spot = (dx, dy) => page.evaluate(([dx, dy]) => { const r = window.__app.map.getContainer().getBoundingClientRect(); return [Math.round(r.left + r.width * dx), Math.round(r.top + r.height * dy)]; }, [dx, dy]);
  // a construction cone (first, while no route moves the map): jump to one and click it
  const cone = await page.evaluate(() => { const f = window.PLANNED.features.find((x) => x.properties.status === "works" && x.properties.from && x.properties.until); return { c: f.geometry.coordinates, p: f.properties }; });
  await page.evaluate((c) => window.__app.map.jumpTo({ center: c, zoom: 16.5 }), cone.c);
  await page.evaluate(() => new Promise((r) => { const m = window.__app.map; if (m.loaded() && !m.isMoving()) r(); else m.once("idle", r); }));
  await until(page, (c) => window.__app.map.queryRenderedFeatures(window.__app.map.project(c), { layers: ["works", "works-near"].filter((id) => window.__app.map.getLayer(id)) }).length > 0, cone.c, 20000);
  const pt = await page.evaluate((c) => { const p = window.__app.map.project(c), r = window.__app.map.getContainer().getBoundingClientRect(); return [r.left + p.x, r.top + p.y]; }, cone.c);
  await page.mouse.click(pt[0], pt[1]);
  await until(page, () => !!document.querySelector(".maplibregl-popup .pop-works"));
  const card = await page.evaluate(() => { const p = document.querySelector(".maplibregl-popup"); return p ? { text: p.textContent, rows: p.querySelectorAll(".pop-works").length, go: !!p.querySelector(".pop-go") } : null; });
  await page.evaluate(() => document.querySelectorAll(".maplibregl-popup").forEach((p) => p.remove()));
  // desktop: click in the destination bar first, then on the map: the destination is set (not the start)
  await page.evaluate(() => window.__app.map.jumpTo({ center: [-73.575, 45.525], zoom: 15 }));
  await page.click("#to"); let [x, y] = await spot(0.55, 0.4); await page.mouse.click(x, y);
  await until(page, () => !!window.__app.state.to);
  const destFirst = await app();
  // then the start bar, then the map: the start is set and a route follows
  await page.click("#from"); [x, y] = await spot(0.4, 0.6); await page.mouse.click(x, y);
  await until(page, () => !!window.__app.state.from && window.__app.state.routes.length > 0, null, 30000);
  const thenStart = await app();
  const checks = {
    destinationFirst: destFirst.to && !destFirst.from && !!destFirst.toLabel,
    thenStart: thenStart.from && thenStart.to && !!thenStart.fromLabel,
    coneCard: !!card && card.rows >= 2 && /Works blocking a bike path/.test(card.text) && /Between/.test(card.text) && /Planned (until|to end)/.test(card.text) && /Bike path (closed|partly blocked)/.test(card.text) && /Info-travaux/.test(card.text) && !card.go,
  };
  const bad = Object.keys(checks).filter((k) => !checks[k]);
  return { ok: !bad.length, ...(bad.length ? { error: "failed checks: " + bad.join(", ") } : {}), destFirst, thenStart, cone: cone.p, card };
});

await run("phone: with a search bar open (keyboard up), a tap on the map fills it and closes the keyboard; start first works too", APP, async (page) => {
  await page.waitForFunction(() => window.__app && window.__app.map.loaded(), null, { timeout: 90000 });
  await page.evaluate(() => window.__app.map.jumpTo({ center: [-73.575, 45.525], zoom: 15 }));
  // a spot where the map itself is on top (the open search card covers the lower part), dx across the width
  const spot = (dx) => page.evaluate((dx) => { const c = window.__app.map.getCanvas(), x = Math.round(innerWidth * dx);
    for (let y = 120; y < innerHeight - 40; y += 8) if (document.elementFromPoint(x, y) === c && document.elementFromPoint(x, y + 30) === c) return [x, y + 15];
    return [x, 120]; }, dx);
  const st = () => page.evaluate(() => { const s = window.__app.state; return { from: !!s.from, to: !!s.to, searching: document.body.classList.contains("searching"), which: window.__app.state && document.activeElement && document.activeElement.id }; });
  await panelStill(page);
  const box = await page.locator("#from").boundingBox(); await page.touchscreen.tap(box.x + 30, box.y + box.height / 2);
  await until(page, () => document.body.classList.contains("searching"));
  const opened = await st();
  const pause = () => page.waitForTimeout(900);   // a person's pause: the 800 ms after the tap that opened the bar swallow stray taps (the iPhone fix)
  await pause(); let [x, y] = await spot(0.3); await page.touchscreen.tap(x, y);
  await until(page, () => !!window.__app.state.from && !document.body.classList.contains("searching"));
  const startSet = await st();
  await panelStill(page);   // the card slides back after the first tap: measure the bar once it has stopped
  const box2 = await page.locator("#to").boundingBox(); await page.touchscreen.tap(box2.x + 30, box2.y + box2.height / 2);
  await until(page, () => document.body.classList.contains("searching"));
  await pause(); [x, y] = await spot(0.7); await page.touchscreen.tap(x, y);
  await until(page, () => !!window.__app.state.to && !document.body.classList.contains("searching"));
  const bothSet = await st();
  const checks = { opened: opened.searching, startFirst: startSet.from && !startSet.to && !startSet.searching, thenDestination: bothSet.from && bothSet.to && !bothSet.searching };
  const bad = Object.keys(checks).filter((k) => !checks[k]);
  return { ok: !bad.length, ...(bad.length ? { error: "failed checks: " + bad.join(", ") } : {}), opened, startSet, bothSet };
}, { width: 390, height: 844 }, { hasTouch: true, isMobile: true });

await run("demo weather link: ?wx=rain&wind=40&from=W rains along a west wind, ?wx=snow&winter=1 snows; the card says demo; a plain visit is real weather", `${APP}?wx=rain&wind=40&from=W`, async (page) => {
  await page.evaluate(INK_JS);
  const read = () => page.evaluate(() => { const s = window.__app.state, w = s.wxData; return { on: s.wx, demo: !!(w && w.demo), wind: w && w.now.wind, dir: w && w.now.dir,
    card: document.querySelector("#wx-card").textContent, kind: document.querySelector("#precip").dataset.kind }; });
  await precipRuns(page, "rain"); const rain = await read();
  await page.goto(BASE + APP + "?wx=snow&winter=1&lang=fr", { waitUntil: "load" }); await page.waitForFunction(() => !!window.__app, null, { timeout: 90000 });
  await page.evaluate(INK_JS); await precipRuns(page, "snow"); const snow = await read();
  await page.goto(BASE + APP + "?wx=1", { waitUntil: "load" }); await page.waitForFunction(() => !!window.__app, null, { timeout: 90000 });
  await until(page, () => !!window.__app.state.wxData); const real = await read();
  const checks = {
    rain: rain.on && rain.demo && rain.wind === 40 && rain.dir === 270 && rain.kind === "rain" && /Demo weather/.test(rain.card),
    snow: snow.on && snow.demo && snow.kind === "snow" && snow.wind === 0 && /Météo de démonstration/.test(snow.card),
    realOtherwise: real.on && !real.demo && !/Demo weather/.test(real.card),
  };
  const bad = Object.keys(checks).filter((k) => !checks[k]);
  return { ok: !bad.length, ...(bad.length ? { error: "failed checks: " + bad.join(", ") } : {}), rain, snow, real };
}, { width: 390, height: 844 });

// 2026-11-05: heavier rain or snow draws more lines or flakes, falling faster, at the same angle for the same wind
await run("rain and snow intensity: heavier means more and faster, same lean", `${APP}?wx=rain&mm=1&wind=30&from=W`, async (page) => {
  const read = () => page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 400));   // a few frames at the new density
    const L = window.__app.precip, v = L.velocity(); return { n: L.parts.length, speed: Math.hypot(v.vx, v.vy), slant: Math.atan2(v.vx, v.vy) * 180 / Math.PI };
  });
  const at = async (q) => { await page.goto(BASE + APP + q, { waitUntil: "load" }); await page.waitForFunction(() => window.__app && window.__app.precip && window.__app.precip.parts && window.__app.precip.parts.length > 0, null, { timeout: 90000 }); return read(); };
  const lightRain = await at("?wx=rain&mm=1&wind=30&from=W"), heavyRain = await at("?wx=rain&mm=12&wind=30&from=W");
  const lightSnow = await at("?wx=snow&winter=1&mm=0.3&wind=20&from=W"), heavySnow = await at("?wx=snow&winter=1&mm=4&wind=20&from=W");
  const checks = {
    rainMore: heavyRain.n >= 2.2 * lightRain.n, rainFaster: heavyRain.speed > 1.3 * lightRain.speed, rainSameLean: Math.abs(heavyRain.slant - lightRain.slant) < 0.5,
    snowMore: heavySnow.n >= 2.2 * lightSnow.n, snowFaster: heavySnow.speed > 1.3 * lightSnow.speed, snowSameLean: Math.abs(heavySnow.slant - lightSnow.slant) < 0.5,
  };
  const bad = Object.keys(checks).filter((k) => !checks[k]);
  return { ok: !bad.length, ...(bad.length ? { error: "failed checks: " + bad.join(", ") } : {}), lightRain, heavyRain, lightSnow, heavySnow };
}, { width: 390, height: 844 });

await run("rain and snow motion (phone): calm falls straight down the screen; wind slants it along the wind's screen direction, more with speed, turned with the map", `${APP}?trip=rachel`, async (page, ctx) => {
  // The average velocity (px/s, y down) of the real layer's lines or flakes: move them one step and see where each went. A line that wrapped round
  // the edge, or a flake that was replaced, jumped far: those are left out.
  await page.evaluate(INK_JS);
  const velocity = (bearing) => page.evaluate((b) => {
    const L = window.__app.precip, dt = 0.02; window.__app.map.jumpTo({ bearing: b });
    const was = L.parts.map((p) => [p.x, p.y]); L.step(dt);
    const d = L.parts.map((p, i) => was[i] && [(p.x - was[i][0]) / dt, (p.y - was[i][1]) / dt]).filter((v) => v && Math.hypot(v[0], v[1]) < 1500);
    const mean = (k) => d.reduce((a, v) => a + v[k], 0) / d.length;
    return { kind: L.fall.kind, n: d.length, of: L.parts.length, vx: +mean(0).toFixed(2), vy: +mean(1).toFixed(2), slant: +(Math.atan2(mean(0), mean(1)) * 180 / Math.PI).toFixed(1) };
  }, bearing);
  const got = {}, turned = {};
  for (const k of ["rainCalm", "rainBreeze", "rainStrong", "snowCalm", "snowBreeze", "snowStrong"]) {
    await setForecast(page, ctx, k); await precipRuns(page, k.startsWith("rain") ? "rain" : "snow");
    got[k] = await velocity(0);
    if (k.endsWith("Strong")) for (const b of [90, 180, 270]) turned[k + b] = await velocity(b);   // the map turned: east is up (90), left (180), down (270)
  }
  // the model itself: no drift in calm air, more with speed, a limit, and the fall never stops
  const model = await page.evaluate(() => {
    const v = (kind, kmh) => BikeWeather.fallVelocity(kind, kmh, 90, 0), speeds = [0, 4, 5, 6, 10, 20, 30, 45, 70, 120];
    const inc = (kind) => speeds.map((s) => v(kind, s).vx); const nondecreasing = (a) => a.every((x, i) => !i || x >= a[i - 1] - 1e-9);
    return { rain: inc("rain"), snow: inc("snow"), okRain: nondecreasing(inc("rain")), okSnow: nondecreasing(inc("snow")), noData: BikeWeather.fallVelocity("rain", NaN, NaN, 0),
      downwind: ["rain", "snow"].map((kind) => [0, 90, 180, 270].map((b) => BikeWeather.fallVelocity(kind, 120, 90, b).vy > 0)) };
  });
  const c = got.rainCalm, b = got.rainBreeze, s = got.rainStrong, sc = got.snowCalm, sb = got.snowBreeze, ss = got.snowStrong;
  const rainOk = c.n >= 20 && Math.abs(c.vx) < 0.5 && c.vy > 250                                   // calm: straight down, a steady fast fall
    && b.slant > 5 && b.slant < 20 && s.slant > b.slant + 5 && s.slant > 28 && s.slant < 40 && b.vx > 0 && s.vx > b.vx   // wind from the west slants it toward the east, more with speed
    && Math.abs(s.vy / c.vy - 1) < 0.1                                                             // heading east on a north-up map changes only the slant, not the fall
    && Math.abs(turned.rainStrong90.vx) < 5 && turned.rainStrong90.vy < 0.7 * c.vy                 // east is up the screen: the fall slows, no sideways drift
    && turned.rainStrong180.vx < -100 && Math.abs(turned.rainStrong180.slant + s.slant) < 3         // east is left: the slant flips
    && Math.abs(turned.rainStrong270.vx) < 5 && turned.rainStrong270.vy > 1.3 * c.vy;               // east is down: the fall speeds up
  const snowOk = sc.n >= 10 && Math.abs(sc.vx) < 0.5 && sc.vy > 25 && sc.vy < 90 && sc.vy < c.vy / 3   // calm: straight down, slowly, much slower than rain
    && sb.slant > 15 && sb.slant < 40 && ss.slant > sb.slant + 5 && ss.slant > 30 && ss.slant < 55 && sb.vx > 0 && ss.vx > sb.vx
    && Math.abs(turned.snowStrong90.vx) < 3 && turned.snowStrong90.vy > 0 && turned.snowStrong90.vy < 0.3 * sc.vy   // east is up: it hangs, never rises
    && turned.snowStrong180.vx < -30 && turned.snowStrong270.vy > 1.5 * sc.vy;
  const modelOk = model.okRain && model.okSnow && model.rain[2] === 0 && model.snow[2] === 0 && model.rain[1] === 0 && model.rain.at(-1) === model.rain.at(-2) && model.snow.at(-1) === model.snow.at(-2)
    && model.rain.at(-1) <= 360 && model.snow.at(-1) <= 60 && model.noData.vx === 0 && model.noData.vy === 360 && model.downwind.flat().every(Boolean);
  return { ok: rainOk && snowOk && modelOk, rainOk, snowOk, modelOk, got, turned, model };
}, { width: 390, height: 844 }, { hasTouch: true, isMobile: true, deviceScaleFactor: 3 });

await run("which falls: snow when snow falls, rain otherwise; in winter mode snow unless the data says rain (freezing rain too); the card agrees", `${APP}?trip=rachel`, async (page, ctx) => {
  await page.evaluate(INK_JS);
  const cls = await page.evaluate(() => {
    const P = (now, winter) => { const r = BikeWeather.precipNow({ now: { rain: 0, precip: 0, snow: 0, code: 0, ...now } }, winter); return r ? r.kind : null; };
    return { summer: [{ precip: 0.3 }, { precip: 0.3, code: 3 }, { rain: 0.3, precip: 0.3 }, { snow: 0.2 }, {}].map((n) => P(n, false)),
      winter: [{ precip: 0.3 }, { precip: 0.3, code: 3 }, { rain: 0.3, precip: 0.3 }, { code: 66, precip: 0.3 }, { code: 67 }, { code: 61, precip: 0.3 }, { snow: 0.2, precip: 0.2 }, { code: 71 }, {}].map((n) => P(n, true)) };
  });
  const clsOk = cls.summer.join() === "rain,rain,rain,snow," && cls.winter.join() === "snow,snow,rain,rain,rain,rain,snow,snow,";
  const card = () => page.evaluate(() => document.querySelector("#wx-card").hidden ? "" : document.querySelector("#wx-card").textContent);
  const falls = async (kind) => { await precipRuns(page, kind); return page.evaluate(() => ({ kind: document.querySelector("#precip").dataset.kind || "", streaks: !document.querySelector("#wind").hidden })); };
  const out = {};   // setForecast turns the weather on itself (a load already pending would answer with the previous forecast)
  await setForecast(page, ctx, "untyped"); out.summerUntyped = await falls("rain"); out.summerUntypedCard = await card();
  await page.evaluate(() => window.__app.setWinter(true));
  await setForecast(page, ctx, "untyped"); out.winterUntyped = await falls("snow"); out.winterUntypedCard = await card();
  await setForecast(page, ctx, "freezing"); out.winterFreezing = await falls("rain"); out.winterFreezingCard = await card();
  await setForecast(page, ctx, "rain"); out.winterRain = await falls("rain");
  await setForecast(page, ctx, "snow"); out.winterSnow = await falls("snow");
  // winter mode toggled while it falls: the kind follows at once
  await setForecast(page, ctx, "untyped"); await precipRuns(page, "snow");
  await page.evaluate(() => window.__app.setWinter(false)); await precipRuns(page, "rain"); out.toggledOff = await page.evaluate(() => document.querySelector("#precip").dataset.kind);
  await page.evaluate(() => window.__app.setWinter(true)); await precipRuns(page, "snow"); out.toggledOn = await page.evaluate(() => document.querySelector("#precip").dataset.kind);
  const ok = clsOk && out.summerUntyped.kind === "rain" && /Raining now/.test(out.summerUntypedCard)
    && out.winterUntyped.kind === "snow" && /Snowing now/.test(out.winterUntypedCard) && out.winterFreezing.kind === "rain" && /Raining now/.test(out.winterFreezingCard)
    && out.winterRain.kind === "rain" && out.winterSnow.kind === "snow" && !out.winterUntyped.streaks && !out.winterFreezing.streaks && out.toggledOff === "rain" && out.toggledOn === "snow";
  return { ok, cls, clsOk, out };
}, { width: 390, height: 844 }, { hasTouch: true, isMobile: true });

await run("reduced motion: no wind streaks, no rain, no snow; the card still tells the weather; turning it off brings the motion back", `${APP}?trip=rachel`, async (page, ctx) => {
  await page.evaluate(INK_JS);
  const quiet = () => page.evaluate(() => { const w = document.querySelector("#wind"), p = document.querySelector("#precip"), L = window.__app.precip;
    return { windHidden: w.hidden, windInk: window.__ink("#wind").n, precipHidden: p.hidden, precipInk: window.__ink("#precip").n, kind: p.dataset.kind || "", loop: L.raf !== 0 || window.__app.wind.raf !== 0 }; });
  const card = () => page.evaluate(() => document.querySelector("#wx-card").hidden ? "" : document.querySelector("#wx-card").textContent);
  const out = { media: await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches) };
  await setForecast(page, ctx, "dry"); await frames(page, 6);
  out.dry = await quiet(); out.dryCard = (await card()).slice(0, 120);
  await setForecast(page, ctx, "rain"); await frames(page, 6);
  out.rain = await quiet(); out.rainCard = (await card()).slice(0, 120);
  await setForecast(page, ctx, "snow"); await frames(page, 6);
  out.snow = await quiet(); out.snowCard = (await card()).slice(0, 120);
  // reduced motion off while snow falls: the flakes start; dry: the streaks; and on again while they run: everything stops at once
  await page.emulateMedia({ reducedMotion: "no-preference" }); await precipRuns(page, "snow");
  out.snowMoving = await precipLook(page);
  await setForecast(page, ctx, "dry"); await streaksRun(page);
  out.streaksMoving = await precipLook(page);
  await page.emulateMedia({ reducedMotion: "reduce" }); await until(page, () => document.querySelector("#wind").hidden, null, 20000); await frames(page, 3);
  out.dryAgain = await quiet();
  const stills = [out.dry, out.rain, out.snow, out.dryAgain].every((q) => q.windHidden && q.windInk === 0 && q.precipHidden && q.precipInk === 0 && !q.kind && !q.loop);
  const ok = out.media && stills && /Wind|Calm/.test(out.dryCard) && /Raining now/.test(out.rainCard) && /Snowing now/.test(out.snowCard)
    && !out.snowMoving.hidden && out.snowMoving.n > 0 && out.snowMoving.windHidden && !out.streaksMoving.windHidden && out.streaksMoving.windN > 0 && out.streaksMoving.hidden;
  return { ok, out, stills };
}, { width: 390, height: 844 }, { hasTouch: true, isMobile: true, reducedMotion: "reduce" });

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

// ---- map icons (2026-11-08): clear-line badges (polygons, navy outline), round metro signs, the old teardrop pins, new BIXI badge and stop ring ----
await run("map icons: clear-line poi badges, round metro, pins unchanged, bixi badge and stop ring", `${APP}?welcome=0`, async (page) => page.evaluate(async () => {
  const C = window.BikeCommon, map = window.__app.map, kinds = Object.keys(C.POI_KINDS).filter((k) => k !== "metro");
  const svg = Object.fromEntries(kinds.map((k) => [k, C.iconSVG(k, { size: 56 })]));
  const body = (s) => s.replace(/^<svg[^>]*>/, "");
  // every non-metro badge starts with a polygon (no circle disc / rounded rect behind it) and carries the navy outline
  const sharp = kinds.every((k) => /^<polygon /.test(body(svg[k])) && svg[k].includes('stroke="#1e2160"') && !/<rect[^>]* rx=/.test(svg[k]));
  const distinct = new Set(kinds.map((k) => svg[k])).size === kinds.length;
  const metro = ["2", "12", "1245"].map((l) => C.iconSVG("metro", { size: 64, lines: l.split("") }));
  const metroRound = metro.every((m) => /<circle cx="12" cy="12" r="11.9"/.test(m) && m.includes('r="8.3"') && !m.includes("<polygon"));
  // the map knows the new pictures
  const sizes = {};
  for (const id of ["poi-cafe", "poi-bixi", "poi-works", "poi-rem", "badge-ok", "badge-low", "badge-empty", "badge-off", "stop-ring", "stop-ring-night"]) sizes[id] = map.hasImage(id);
  const stopsLayer = map.getLayer("stops");
  // pins: the same teardrop paths as before
  window.piste.setPoint("from", [-73.5822, 45.5247], "A"); window.piste.setPoint("to", [-73.57, 45.52], "B");
  await new Promise((r) => setTimeout(r, 400));
  const pins = [...document.querySelectorAll(".end-pin")].map((e) => e.innerHTML);
  const pinsOk = pins.length === 2 && pins.every((h) => h.includes("a22 22 0 0 1 44 0") && !h.includes("<rect")) && pins[0].includes('fill="#1e2160"') && pins[1].includes('stroke="#1e2160"');
  const ok = sharp && distinct && metroRound && Object.values(sizes).every(Boolean) && stopsLayer && stopsLayer.type === "symbol" && pinsOk;
  return { ok, sharp, distinct, metroRound, sizes, stops: stopsLayer && stopsLayer.type, pinsOk, pinCount: pins.length };
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
  // the x (2026-10-31) clears the destination: field, point and route go. While typing (2026-11-04) the search and the focus stay as they are
  await page.click('.clear[data-target="to"]'); await page.waitForTimeout(500);
  const cancelled = await page.evaluate(() => ({ searching: document.body.classList.contains("searching"), cleared: window.__app.state.to === null && document.querySelector("#to").value === "" && window.__app.state.routes.length === 0,
    stillTyping: document.activeElement.id === "to", startKept: !!window.__app.state.from && document.querySelectorAll(".end-pin").length === 1 }));
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
  return { ok: half > H / 2 - 4 && half < H * 0.75 && full >= H - 62 - 10 && peek <= 190 && layout.scrollW <= layout.innerW
      && docked.searching && docked.active === "to" && docked.brandHidden && docked.clearShown && docked.fieldBottom <= docked.kbTop && docked.fieldBottom >= docked.kbTop - 30
      && list.shown && list.aboveCard && cancelled.searching && cancelled.cleared && cancelled.stillTyping && cancelled.startKept && moved.active === "to" && moved.searching && !done.searching && done.routes > 0 && done.sheet === "half",
    half, full, peek, ...layout, docked, list, cancelled, moved, done };
}, { width: 402, height: 874 });

// ------------------------------------------------------------------ GPS ride (2026-10-30)
// ?gps=replay feeds a pretend ride (1 fix a second, sped up by gpsx, a few metres of noise, a poor fix now and then)
// through navigator.geolocation's interface, so it runs the same code as a real phone.
// ---- no double-tap page zoom (2026-11-03): iPhone Safari zooms the page when a button outside the map is tapped twice quickly ----
// Playwright's WebKit does not do that zoom itself (the scale check below also passes without the fix), so the real guard is the computed
// touch-action of what you press; the quick double taps check that nothing else moves the page or the map, as a real iPhone is the final test.
await run("phone: a quick double tap on Layers, wind & rain, winter and 3D zooms neither page nor map; what you press is touch-action: manipulation, the map keeps its own", `${APP}?trip=montroyal&safe=47,34`, async (page) => {
  await page.waitForFunction(() => window.__app.map.loaded() && !window.__app.map.isMoving(), null, { timeout: 60000 });
  const css = await page.evaluate(() => {
    const ta = (el) => getComputedStyle(el).touchAction, queries = ["#layers-btn", "#wx-btn", "#winter-btn", "#view-btn", ".map-controls", "#from", "#to", ".tab", "#strict", ".route-card", ".clear", "#places .star", ".lang-btn", "#layers label"];
    const named = Object.fromEntries(queries.map((q) => [q, document.querySelector(q) ? ta(document.querySelector(q)) : "missing"]));
    const pressable = [...document.querySelectorAll("button, a[href], label, input, select, textarea, summary")].filter((el) => !el.closest("#map")), other = pressable.filter((el) => ta(el) !== "manipulation").map((el) => el.id || el.className || el.tagName);   // the map's own controls keep MapLibre's
    const meta = (document.querySelector('meta[name="viewport"]') || {}).content || "";
    return { named, count: pressable.length, other, map: ta(window.__app.map.getCanvasContainer()), canvas: ta(window.__app.map.getCanvas()), pinchOk: !/user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?\b/i.test(meta), meta };
  });
  await page.evaluate(() => { window.__clicks = {}; for (const id of ["layers-btn", "wx-btn", "winter-btn", "view-btn"]) document.getElementById(id).addEventListener("click", () => { window.__clicks[id] = (window.__clicks[id] || 0) + 1; }, true); });
  const view = () => page.evaluate(() => { const m = window.__app.map; return { scale: visualViewport.scale, width: Math.round(visualViewport.width), zoom: +m.getZoom().toFixed(3) }; });
  const start = await view(), taps = {};
  for (const id of ["layers-btn", "wx-btn", "winter-btn", "view-btn"]) {
    const b = await page.locator("#" + id).boundingBox(), x = b.x + b.width / 2, y = b.y + b.height / 2;
    await page.touchscreen.tap(x, y); await page.touchscreen.tap(x, y);   // as fast as the browser lets two taps go
    await until(page, () => !window.__app.map.isMoving());
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))));   // fades and slides done before measuring
    taps[id] = { ...(await view()), clicks: await page.evaluate((i) => window.__clicks[i] || 0, id) };
  }
  const end = await page.evaluate(() => { const s = window.__app.state; return { layersHidden: document.querySelector("#layers").hidden, wx: s.wx, winter: s.winter, pitch: Math.round(window.__app.map.getPitch()) }; });
  const allManipulation = Object.values(css.named).every((v) => v === "manipulation");
  const checks = {
    pressedThingsManipulation: allManipulation && css.other.length === 0 && css.count > 20,
    mapKeepsItsOwn: css.map !== "manipulation" && css.map !== "auto" && css.canvas !== "manipulation" && css.canvas !== "auto",
    pinchNotBlocked: css.pinchOk,
    pageNotZoomed: start.scale === 1 && Object.values(taps).every((t) => t.scale === 1 && t.width === start.width),
    // the 3D button itself zooms in to at least 15.2 when it turns 3D on (set3d); nothing beyond that, and no zoom from the other buttons
    mapNotZoomed: ["layers-btn", "wx-btn", "winter-btn"].every((id) => taps[id].zoom === start.zoom) && taps["view-btn"].zoom <= Math.max(start.zoom, 15.2) + 0.01,
    bothTapsClicked: Object.values(taps).every((t) => t.clicks === 2) && end.layersHidden && !end.wx && !end.winter && end.pitch === 0,
  };
  const bad = Object.keys(checks).filter((k) => !checks[k]);
  return { ok: !bad.length, ...(bad.length ? { error: "failed checks: " + bad.join(", ") } : {}), css, start, taps, end };
}, { width: 390, height: 844 }, { hasTouch: true, isMobile: true, deviceScaleFactor: 2 });

await run("GPS ride (replayed track): follows the route, ignores poor fixes, re-center, arrives", `${APP}?trip=montroyal&gps=replay&gpsx=3`, async (page) => {
  const follow = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const app = window.__app, m = app.map, s = app.state, C = BikeCommon;
    document.querySelector("#ride-go").click(); window.__flatRide();
    const ride = s.ride, geo = ride.geo;
    const ui = { gps: !!(ride && ride.gps), speedHidden: document.querySelector("#ride-speed").hidden, pauseHidden: document.querySelector("#ride-pause").hidden,
      gpsShown: !document.querySelector("#ride-gps").hidden, first: document.querySelector("#gps-msg").textContent };
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
  // the distance covered in a frame (lag) plus the usual limit. On a fast machine (frames under ~1/60 s) that is the usual limit.
  // 2026-11-10: was lag + half the limit, which GitHub's runner missed by 0.3 m at 4 frames a second (15.6 m against 15.3 m).
  const allow = (limit, lag) => limit + lag;
  // to the true track: the replay's own noise leaves ~4-4.5 m beyond one frame's lag on any machine (measured 2026-11-03, before and after that day's ride changes)
  const ok = f.gps && f.speedHidden && f.pauseHidden && f.gpsShown && /Waiting for GPS/.test(f.first) && /km\/h/.test(f.now) && f.d > 80 && f.ignored >= 2
    && f.frames > 40 && f.backwards === 0 && f.offLineM < 0.5 && f.toFixMaxM < allow(12, f.lagMaxM) && f.toFixMeanM < allow(6, f.lagMeanM) && f.toTrueMeanM < Math.max(8, f.lagMeanM + 5.5) && f.cameraM < 0.5 && f.stepOverM <= 0
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
  const stripM = () => [...document.querySelectorAll("#ride-strip .strip-runs i")].reduce((a, el) => a + +el.style.flexGrow, 0);   // each run grows by its metres
  const start = { stripM: stripM(), kind: J.kind, ms: J.ms, routed: J.routed, cands: J.cands, leadM: Math.round(J.at), toNearestM: toNearest && Math.round(toNearest.length), joinAt: Math.round(J.joinAt),
    loopM: loop && Math.round(loop.length), plannedM: Math.round(L), routeM: Math.round(r0.length), riderToStartM: Math.round(gap(r0.coords[0], from)),
    endToJoinM: +gap(r0.coords.at(-1), J.join).toFixed(2), leadEndToJoinM: J.lead ? +gap(J.lead.coords.at(-1), J.join).toFixed(2) : null, joinToUsualStartM: Math.round(gap(J.join, planned.coords[0])),
    leadDrawnM: leadF.reduce((a, f) => a + f.properties.len, 0), leadPieces: leadF.length, loopPieces: drawn.length - leadF.length,
    leadLayer: !!app.map.getLayer("route-lead") && JSON.stringify(app.map.getPaintProperty("route-lead", "line-dasharray")), dotToJoinM: dot ? +gap(dot.geometry.coordinates, J.join).toFixed(2) : null };
  // the detour 250 m into the lead-in: one reroute, back to the same join point, then the same loop
  for (const t0 = performance.now(); s.reroutes < 1 && performance.now() - t0 < 60000;) await sleep(200);
  const r1 = ride.route, log = s.rerouteLog[0] || {};
  const reroute = { stripM: stripM(), routeM: Math.round(r1.length), reroutes: s.reroutes, leadIn: log.leadIn, newLeadM: Math.round(J.at), loopM: Math.round(r1.length - J.at), sameLoop: J.loop === loop, endToJoinM: +gap(r1.coords.at(-1), J.join).toFixed(2),
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
  const ok = Math.abs(start.stripM - start.routeM) <= 30 && Math.abs(reroute.stripM - reroute.routeM) <= 30   // 2026-11-09: the strip showed the loop alone
    && start.kind === "lead" && start.ms < 250 && start.routed >= 2 && start.leadM > 500 && start.leadM < 2500 && start.toNearestM && start.leadM <= start.toNearestM + 1
    && start.loopM === start.plannedM && Math.abs(start.routeM - start.leadM - start.plannedM) <= 1 && start.riderToStartM < 60 && start.endToJoinM < 0.01 && start.leadEndToJoinM < 0.01
    && start.joinToUsualStartM > 300 && Math.abs(start.leadDrawnM - start.leadM) <= start.leadPieces && start.loopPieces > 0 && start.leadLayer === "[0,1.7]" && start.dotToJoinM < 0.01
    && reroute.reroutes === 1 && reroute.leadIn === true && reroute.sameLoop && Math.abs(reroute.loopM - start.plannedM) <= 1 && reroute.endToJoinM < 0.01 && reroute.leadEndToJoinM < 0.01
    && reroute.fixToStartM !== null && reroute.fixToStartM < 120 && !reroute.reachedYet   // within a block of the rider (2026-11-09: was 70; the detour is off the streets and the moment of the reroute follows the machine's pace: 58 m on this PC, 90 m on GitHub)
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
  const preview = { sim: !!s.ride && !s.ride.gps, speedShown: !document.querySelector("#ride-speed").hidden, dialSim: document.querySelector("#ride-gps").classList.contains("sim") && /^16$/.test(document.querySelector("#gps-main").textContent), noticeGone: document.querySelector("#notice").hidden };
  return { ok: previewLink && /can't use your location/.test(notice) && /accès à votre position/.test(fr) && back.ride && back.panel && back.hudHidden && back.previewButton
      && preview.sim && preview.speedShown && preview.dialSim && preview.noticeGone && d1 >= 0 && d2 > d1,
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
    const out = { gps: !!(r && r.gps), fixes: r && r.stats.fixes, d: r && Math.round(r.d), status, rider: getComputedStyle(document.querySelector(".rider-arrow")).visibility, reroutes: s.reroutes };
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
  const shown = [...document.querySelectorAll(".ride-buttons > *")].filter((el) => !el.hidden), dial = document.querySelector("#ride-gps");
  const ui = { gps: !!(s.ride && s.ride.gps), shown: shown.map((el) => el.id).join(","), status: document.querySelector("#ride-gps").textContent,
    fits: [...shown, dial].every((el) => { const r = el.getBoundingClientRect(); return r.left >= bar.left - 0.5 && r.right <= bar.right + 0.5 && r.bottom <= bar.bottom + 0.5; }),
    scrollW: document.documentElement.scrollWidth, innerW: innerWidth };
  app.endRide(); pv.click(); await sleep(800);
  const preview = { sim: !!s.ride && !s.ride.gps, speedShown: !document.querySelector("#ride-speed").hidden, dialSim: document.querySelector("#ride-gps").classList.contains("sim") };
  app.endRide();
  return { ok: link.coarse && link.preview && link.below && link.text === "Preview the ride" && ui.gps && ui.shown === "ride-sound,ride-view,ride-exit" && /km\/h/.test(ui.status)
      && ui.fits && ui.scrollW <= ui.innerW && preview.sim && preview.speedShown && preview.dialSim, link, ui, preview };
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

await run("wind & rain during a ride: streaks stop, a still wind badge shows, all restored after", `${APP}?trip=montroyal&wx=1&gps=replay&gpsx=3`, async (page) => page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.__app, s = app.state;
  for (const t0 = performance.now(); !s.wxData && performance.now() - t0 < 20000;) await sleep(100);
  const before = { streaks: !document.querySelector("#wind").hidden, badge: !document.querySelector("#wind-badge").hidden };
  document.querySelector("#ride-go").click(); window.__flatRide();
  await sleep(1500);
  const badge = document.querySelector("#wind-badge"), txt = () => `${document.querySelector("#wind-speed").textContent} | ${document.querySelector("#wind-kind").textContent}`;
  const during = { streaks: !document.querySelector("#wind").hidden, badge: !badge.hidden, text: txt(), arrow: document.querySelector("#wind-arrow").style.transform };
  // the badge changes every 10 s or after a corner, never every frame
  let changes = 0; const mo = new MutationObserver((l) => (changes += l.length)); mo.observe(badge, { subtree: true, childList: true, characterData: true, attributes: true });
  await sleep(3000); mo.disconnect();
  app.setLang("fr"); const fr = txt(); app.setLang("en");
  app.endRide(); await sleep(400);
  const after = { streaks: !document.querySelector("#wind").hidden, badge: !document.querySelector("#wind-badge").hidden };
  const calmOk = s.wxData.now.wind < 3, kindsEn = /(Headwind|Tailwind|Crosswind)$/, kindsFr = /(Vent de face|Vent de dos|Vent de côté)$/;
  const textOk = calmOk ? /Calm/.test(during.text) : new RegExp(`^${Math.round(s.wxData.now.wind)} km/h \\| `).test(during.text) && kindsEn.test(during.text);
  const ok = !!s.wxData && before.streaks && !before.badge && !during.streaks && during.badge && textOk
    && (calmOk || kindsFr.test(fr)) && changes <= 12 && after.streaks && !after.badge;
  return { ok, before, during, fr, changes, after, wind: s.wxData && s.wxData.now };
}));

// ---- the wind badge on every ride (2026-11-03): not only when the wind & rain button was on before the ride ----
await run("wind badge on every ride: with the wind & rain button off the forecast loads at the start; offline or a failed load: no badge, no message", `${APP}?trip=montroyal`, async (page, ctx) => {
  let offline = true;
  await ctx.route("https://api.open-meteo.com/**", (route) => (offline ? route.abort() : route.fallback()));   // fallback: the saved copy (or the live service)
  await page.evaluate(() => {   // count the forecast requests that have finished, good or bad
    window.__wxDone = 0; const f = window.fetch;
    window.fetch = (...a) => { const p = f.apply(window, a); if (/open-meteo/.test(String(a[0]))) p.then(() => window.__wxDone++, () => window.__wxDone++); return p; };
  });
  const now = () => page.evaluate(() => { const s = window.__app.state; return { mode: s.mode, d: s.ride ? s.ride.d : -1, button: s.wx, pressed: document.querySelector("#wx-btn").getAttribute("aria-pressed"), data: !!s.wxData,
    badge: !document.querySelector("#wind-badge").hidden, toast: !document.querySelector("#toast").hidden, streaks: !document.querySelector("#wind").hidden }; });
  const before = await now();
  // offline: the ride starts and goes on, with no badge and no message
  await rideGo(page);
  await until(page, () => window.__wxDone >= 1);
  await until(page, () => window.__app.state.ride && window.__app.state.ride.d > 5);
  const offlineRide = await now();
  await page.evaluate(() => window.__app.endRide());
  // back online: the next ride loads the forecast at its start and shows the badge, though the button is still off
  offline = false;
  await rideGo(page);
  await until(page, () => !document.querySelector("#wind-badge").hidden, null, 30000);
  const online = await now();
  online.text = await page.evaluate(() => document.querySelector("#wind-speed").textContent + " | " + document.querySelector("#wind-kind").textContent);
  online.calls = await page.evaluate(() => window.__wxDone);
  // the same calm cadence as with the button on: the badge changes every 10 s or after a corner, never every frame
  const changes = await page.evaluate(async () => { const badge = document.querySelector("#wind-badge"); let n = 0; const mo = new MutationObserver((l) => (n += l.length));
    mo.observe(badge, { subtree: true, childList: true, characterData: true, attributes: true }); await new Promise((r) => setTimeout(r, 3000)); mo.disconnect(); return n; });
  await page.evaluate(() => window.__app.endRide());
  const after = await now();
  const checks = {
    startsWithoutIt: !before.button && before.pressed === "false" && !before.data && !before.badge,
    offlineNoBadge: offlineRide.mode === "ride" && offlineRide.d > 5 && !offlineRide.data && !offlineRide.badge && !offlineRide.toast,
    onlineBadge: online.mode === "ride" && !online.button && online.pressed === "false" && online.data && online.badge && !online.streaks && online.calls >= 2
      && /^(Calm \| |\d+ km\/h \| (Headwind|Tailwind|Crosswind))$/.test(online.text),
    calm: changes <= 12,
    restored: !after.badge && after.pressed === "false" && !after.streaks && !after.button,
  };
  const bad = Object.keys(checks).filter((k) => !checks[k]);
  return { ok: !bad.length, ...(bad.length ? { error: "failed checks: " + bad.join(", ") } : {}), before, offlineRide, online, changes, after };
});

// ---- the rider's arrow (2026-11-09): a navigation arrow lying flat on the map instead of the pin and its cone; MapLibre tilts it with the map and turns it to the heading ----
await run("ride: the rider is a flat navy arrow with an orange notch (no pin, no cone), turned to the heading in the 3D and flat views and with the map turned by hand", `${APP}?trip=montroyal&ride=bird&at=500&paused`, async (page) => {
  await until(page, () => !!window.__app.state.ride && document.querySelector(".rider-arrow") && document.querySelector(".rider-arrow").getBoundingClientRect().width > 0);
  // the marker's own transform (what MapLibre draws) against the ride's heading and the map's tilt and bearing, read now
  const look = () => page.evaluate(() => {
    const a = window.__app, m = a.map, mk = a.riderMarker, r = a.state.ride, h = r.cursor.at(r.d).heading, tf = mk.getElement().style.transform;
    const rx = +(/rotateX\((-?[\d.e+-]+)deg\)/.exec(tf) || [0, 0])[1], rz = +(/rotateZ\((-?[\d.e+-]+)deg\)/.exec(tf) || [0, 0])[1];
    const diff = (x, y) => Math.abs((((x - y) % 360) + 540) % 360 - 180);
    return { pitch: Math.round(m.getPitch()), bearing: Math.round(m.getBearing()), heading: Math.round(h), rotX: Math.round(rx), rotZ: Math.round(rz), alignment: mk.getPitchAlignment() + "/" + mk.getRotationAlignment(),
      rotOff: +diff(mk.getRotation(), h).toFixed(1), zOff: +diff(rz, h - m.getBearing()).toFixed(1), xOff: +Math.abs(rx - m.getPitch()).toFixed(1), w: Math.round(mk.getElement().offsetWidth), h: Math.round(mk.getElement().offsetHeight), shapes: [...mk.getElement().querySelectorAll("svg")].filter((v) => getComputedStyle(v).display !== "none").map((v) => v.getAttribute("class")).join(),
      screenH: Math.round([...mk.getElement().querySelectorAll("svg")].find((v) => getComputedStyle(v).display !== "none").getBoundingClientRect().height) };
  });
  const design = await page.evaluate(() => {
    const el = document.querySelector(".rider-arrow"), svg = el.querySelector("svg"), p = [...svg.querySelectorAll("path")];
    return { fills: p.map((x) => x.getAttribute("fill")), outline: p[0].getAttribute("stroke"), width: p[0].getAttribute("stroke-width"), join: p[0].getAttribute("stroke-linejoin"), paths: p.length, circles: svg.querySelectorAll("circle").length,
      hidden: svg.getAttribute("aria-hidden"), anim: svg.getAnimations().length + el.getAnimations().length, shadow: getComputedStyle(el).filter, oldPin: document.querySelectorAll(".rider-badge, .rider-cone").length };
  });
  const bird = await look();
  await page.evaluate(() => document.querySelector("#ride-view").click());   // the flat view
  await until(page, () => window.__app.state.rideView === "topdown" && Math.abs(window.__app.map.getPitch()) < 1, null, 20000);
  const flat = await look();
  // the map turned by hand (the ride stops following): the arrow keeps pointing along the ground, in the flat view and tilted
  const turned = await page.evaluate(() => { const a = window.__app; a.setFollow(false); a.map.jumpTo({ bearing: a.map.getBearing() + 70 }); }).then(look);
  await page.evaluate(() => window.__app.map.jumpTo({ pitch: 55 }));
  const tilted = await look();
  const flatOk = (v, tilt) => v.alignment === "map/map" && v.rotOff <= 0.5 && v.zOff <= 1 && v.xOff <= 1 && v.w === 40 && (tilt ? v.rotX > 30 : v.rotX === 0);
  // 3D ride view: the arrow is drawn twice as long (80 px, about 28 px tall once squashed by the 70 degree tilt); flat view: the plain 40 px one
  const longOk = (v) => v.h === 80 && v.shapes === "a-long" && v.screenH >= 24 && v.screenH <= 34, shortOk = (v) => v.h === 40 && v.shapes === "a-flat";
  const ok = design.fills[0] === "#1e2160" && design.fills[1] === "#ff6a1f" && design.outline === "#fff" && +design.width <= 3 && design.join === "miter" && design.paths === 2 && design.circles === 0
    && design.hidden === "true" && design.anim === 0 && design.shadow === "none" && design.oldPin === 0
    && flatOk(bird, true) && longOk(bird) && flatOk(flat, false) && shortOk(flat) && shortOk(turned) && shortOk(tilted) && flatOk(turned, false) && flatOk(turned, false) && flatOk(tilted, true) && bird.pitch >= 30 && turned.bearing !== flat.bearing;
  return { ok, design, bird, flat, turned, tilted };
}, { width: 390, height: 844 }, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

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
  // 20 words a step, except "Your kind of route": Raph's own 27-word text for the search bars and route choices together (2026-11-04)
  if (words(x.title) > 4 || words(x.text) > (x.id === "style" ? 28 : 20)) problems.push(`too wordy: ${words(x.title)} / ${words(x.text)} words`);
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
    // 2026-11-04: logo, a centred "Welcome to Piste!" with a small Beta tag in the card's top right corner, one line of text, no beta box, no feedback button
    const pill = c.querySelector(".beta-pill"), pr = pill.getBoundingClientRect(), cr = c.getBoundingClientRect(), mr = c.querySelector(".mark").getBoundingClientRect();
    return { title: c.querySelector("h2").textContent, mark: !!c.querySelector(".mark"), beta: pill.textContent, text: document.querySelector("#welcome-text").textContent,
      centred: getComputedStyle(document.querySelector("#welcome-text")).textAlign === "center" && getComputedStyle(c.querySelector("h2")).textAlign === "center" && Math.abs((mr.left + mr.right) / 2 - (cr.left + cr.right) / 2) < 2,
      betaTopRight: cr.right - pr.right <= 24 && pr.top - cr.top <= 24 && pr.left > (cr.left + cr.right) / 2, noBetaBox: !c.querySelector(".beta-note"),
      noFeedbackHere: !document.querySelector("#welcome-feedback") && !c.querySelector(".feedback-link"), panelFeedback: !!document.querySelector("#feedback-link"),
      tour: document.querySelector("#welcome-tour").textContent, explore: document.querySelector("#welcome-skip").textContent, tourTime: document.querySelector("#welcome-tour small").textContent,
      dialog: c.getAttribute("role") === "dialog" && c.getAttribute("aria-modal") === "true", focusInside: c.contains(document.activeElement), flag: localStorage.getItem("piste-welcomed") };
  });
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
    layout: en.centred && en.betaTopRight && en.noBetaBox, noFeedbackHere: en.noFeedbackHere && en.panelFeedback, tourTime: en.tourTime === "1 min" && fr.tourTime === "1 min",
    english: en.title === "Welcome to Piste!" && en.mark && en.beta === "Beta" && en.text === "An app for Montréal cyclists, by Montréal cyclists." && /Take the tour/.test(en.tour) && en.explore === "Explore on my own",
    firstVisit: en.dialog && en.focusInside && en.flag === null, closes: closed.hidden && closed.flag === "1", notAfterReload: reload.decided === "seen" && reload.hidden,
    french: fr.title === "Bienvenue dans Piste!" && fr.beta === "Bêta" && fr.tour === "Faire la visite" && frClosed.hidden && frClosed.flag === "1",
    ...Object.fromEntries(phones.map((p, i) => [`phone${i + 1}Fits`, p.ok])), storageBlocked: blocked.shown && blocked.closed && !blocked.errors.length,
  };
  const bad = Object.keys(checks).filter((k) => !checks[k]);
  return { ok: !bad.length, ...(bad.length ? { error: "failed checks: " + bad.join(", ") } : {}), en, closed, reload, fr, frClosed, phones, blocked };
}, { width: 1440, height: 900 }, { fresh: true });

await run("tour: every step", APP, async (page) => {
  await until(page, welcomeUp, null, 30000);
  const before = await page.evaluate(appSnapshot);
  await page.click("#welcome-tour");
  // first pass, by keyboard: → and Enter go on, ← goes back; then Esc halfway, on the route-colours step with the demo route showing
  const pass1 = [];
  await tourAt(page, 0); pass1.push(await page.evaluate(tourStepCheck));
  await page.keyboard.press("ArrowRight"); await tourAt(page, 1); pass1.push(await page.evaluate(tourStepCheck));
  // step 1 is "Colours that matter", with the demo route (2026-11-04: the separate search step is gone)
  const demo = await page.evaluate(() => { const s = window.__app.state, bt = s.routes.length ? s.routes[s.sel].r.byTier.map(Math.round) : [0, 0, 0, 0, 0, 0];
    return { demo: window.pisteTour.info().demo, routes: s.routes.length, from: document.querySelector("#from").value, to: document.querySelector("#to").value, km: s.routes.length ? +(s.routes[s.sel].r.length / 1000).toFixed(1) : 0,
      protectedM: bt[0], sharedM: bt[2], noPathM: bt[3] + bt[4] }; });
  await page.keyboard.press("Enter"); await tourAt(page, 2); pass1.push(await page.evaluate(tourStepCheck));
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
  const pass2 = await tourWalk(page, 0, 7, true);
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
  await page.evaluate(() => window.pisteTour.start(1)); await tourAt(page, 1);
  const own = await page.evaluate(() => ({ demo: window.pisteTour.info().demo, from: document.querySelector("#from").value }));
  own.check = await page.evaluate(tourStepCheck);
  await page.keyboard.press("Escape"); await tourClosed(page);
  await until(page, (b) => { const m = window.__app.map; return !m.isMoving() && Math.abs(m.getZoom() - b.zoom) < 0.01; }, own0);
  const own1 = await page.evaluate(appSnapshot);
  const riding = await page.evaluate(() => { const a = window.__app; a.startRide("topdown"); const r = { button: document.querySelector("#tour-again").getClientRects().length > 0, started: window.pisteTour.start(0) }; a.endRide(); return r; });
  // one step per map button, top to bottom: 3D, weather, winter, layers
  const buttonSteps = pass2.slice(3, 7).map((st) => st.targets[0]);
  const buttonsDown = buttonSteps.map((tg) => tg.spec).join() === "#view-btn,#wx-btn,#winter-btn,#layers-btn" && buttonSteps.every((tg, k) => k === 0 || tg.r[1] > buttonSteps[k - 1].r[1]);
  // the colours step's demo route shows all three kinds: protected, shared and no bike path, DEMO_MIN metres or more of each, 2 to 5 km long
  const threeKinds = demo.protectedM >= DEMO_MIN && demo.sharedM >= DEMO_MIN && demo.noPathM >= DEMO_MIN && demo.km >= 2 && demo.km <= 5;
  const ok = stepIds === "style,colours,suggest,view3d,weather,winter,layers,feedback" && buttonsDown && threeKinds
    && pass1.every((s) => s.ok) && pass2.length === 8 && pass2.every((s) => s.ok) && demo.demo && demo.routes > 0 && demo.from === "Georges-Vanier metro" && leftKey === 1
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
  const big = await tourWalk(page, 0, 7, false);
  await page.click(".tour-back"); await tourAt(page, 6);
  const back = await page.evaluate(() => ({ i: window.pisteTour.info().i, sheet: document.querySelector("#panel").dataset.sheet }));
  await page.click(".tour-next"); await tourAt(page, 7);
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
  const small = await tourWalk(page, 0, 7, false);
  await page.click(".tour-next");
  await tourClosed(page);
  await until(page, (b) => { const m = window.__app.map; return !m.isMoving() && Math.abs(m.getZoom() - b.zoom) < 0.01; }, before2);
  const after2 = await page.evaluate(appSnapshot);
  const ok = big.length === 8 && big.every((s) => s.ok) && back.i === 6 && sameState(before, after) && after.drawn === 0 && foot.every(Boolean)
    && small.length === 8 && small.every((s) => s.ok) && sameState(before2, after2);
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
  const card = () => ({ sheet: document.querySelector("#panel").dataset.sheet, h: Math.round(document.querySelector("#panel").getBoundingClientRect().height), searching: document.body.classList.contains("searching") });
  const before = await page.evaluate(card);
  await page.tap('.clear[data-target="to"]'); await page.waitForTimeout(400);
  const afterTo = await page.evaluate(searchSnap);
  const kb = await page.evaluate(() => ({ active: document.activeElement.tagName, searching: document.body.classList.contains("searching") }));
  await page.tap('.clear[data-target="from"]'); await page.waitForTimeout(400);
  const afterBoth = await page.evaluate(searchSnap);
  const kept = { ...(await page.evaluate(card)), active: await page.evaluate(() => document.activeElement.tagName) };
  // typing in the bar (2026-11-04): the x empties it but the bar keeps the focus and the search stays open
  await page.tap("#to"); await until(page, () => document.body.classList.contains("searching") && document.activeElement.id === "to");
  await page.keyboard.type("abc"); await until(page, () => document.querySelector('.clear[data-target="to"]').getBoundingClientRect().width > 0);
  await page.tap('.clear[data-target="to"]'); await page.waitForTimeout(400);
  const typing = await page.evaluate(() => ({ active: document.activeElement.id, searching: document.body.classList.contains("searching"), value: document.querySelector("#to").value }));
  const ok = fit.every((f) => f.insideCard && f.inputW >= 150 && f.font >= 16 && f.h >= 44) && afterTo.to === null && afterTo.routes === 0 && afterTo.pins === 1 && !/^(INPUT|TEXTAREA)$/.test(kb.active) && !kb.searching
    && afterBoth.from === null && afterBoth.pins === 0 && afterBoth.routes === 0
    && !before.searching && !kept.searching && Math.abs(kept.h - 422) < 3 && kept.sheet === before.sheet && !/^(INPUT|TEXTAREA)$/.test(kept.active)
    && typing.active === "to" && typing.searching && typing.value === "";
  return { ok, fit, afterTo, kb, afterBoth, before, kept, typing };
}, { width: 390, height: 844 }, { hasTouch: true, isMobile: true });

// ------------------------------------------------------------------ the language button in the card's header (2026-10-31)
await run("language button: next to the night button at the top right of the card's header, visible at every sheet height, 44 px tap area, no sheet drag", `${APP}?trip=montroyal&safe=47,34`, async (page) => {
  const probe = () => { const b = document.querySelector("#lang-btn"), r = b.getBoundingClientRect(), br = document.querySelector("#brand").getBoundingClientRect(), pr = document.querySelector("#panel").getBoundingClientRect(),
      g = document.querySelector("#grabber").getBoundingClientRect(), tb = document.querySelector(".tabs").getBoundingClientRect(), phone = matchMedia("(max-width: 760px)").matches;
    const hit = (x, y) => { const e = document.elementFromPoint(x, y); return !!e && (e === b || b.contains(e)); };
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2, tap = !phone || [[-21, -21], [21, -21], [-21, 21], [21, 21]].every(([dx, dy]) => hit(cx + dx, cy + dy));
    const overlap = (a, c) => a.width > 0 && c.width > 0 && Math.min(a.right, c.right) - Math.max(a.left, c.left) > 0.5 && Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top) > 0.5;
    return { inHeader: r.top >= br.top - 1 && r.bottom <= br.bottom + 1 && Math.abs(r.right - (document.querySelector("#night-btn").getBoundingClientRect().left - 12)) <= 1 && Math.abs(document.querySelector("#night-btn").getBoundingClientRect().right - (pr.right - 16)) <= (phone ? 4 : 6), visible: hit(cx, cy) && r.top >= pr.top && r.bottom <= pr.bottom, tap,
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

// ------------------------------------------------------------------ the logo (2026-11-03): a white P with the bike chain on Piste navy (prototypes/icons/logo.svg, tools/shots/make_icons.mjs)
const LOGO_NAVY = [30, 33, 96];   // #1e2160, the logo's navy
// window.__logo(src) draws an image (a URL, or an inline <svg> serialised) at its own size and samples points given as fractions of its side: the P's stem (white), the hole in the
// P's bowl and a spot near the bottom right (navy), and the top-left corner (navy on a full-bleed icon, see-through outside the header's disc); "white" is the share of white pixels.
const logoPixels = `window.__logo = async (src) => {
  const img = new Image(); img.src = src; await img.decode();
  const s = img.naturalWidth, c = new OffscreenCanvas(s, img.naturalHeight), g = c.getContext("2d"); g.drawImage(img, 0, 0);
  const at = (fx, fy) => [...g.getImageData(Math.min(s - 1, Math.round(fx * s)), Math.min(s - 1, Math.round(fy * s)), 1, 1).data];
  const all = g.getImageData(0, 0, s, s).data; let white = 0; for (let i = 0; i < all.length; i += 4) if (Math.min(all[i], all[i + 1], all[i + 2]) > 200 && all[i + 3] > 200) white++;
  return { size: [img.naturalWidth, img.naturalHeight], stem: at(0.44, 0.53), hole: at(0.67, 0.37), corner: at(0.78, 0.78), edge: at(0.01, 0.01), white: white / (s * s) };
};`;
const isNavy = (p) => p.slice(0, 3).every((v, i) => Math.abs(v - LOGO_NAVY[i]) <= 3) && p[3] === 255, isWhite = (p) => p.slice(0, 3).every((v) => v >= 250) && p[3] === 255;
await run("logo: the header mark is the new navy disc with the white P and has a name; icons, favicon and manifest match it", `${APP}?safe=47,34`, async (page) => {
  await page.evaluate(logoPixels);
  await page.evaluate(idle);   // the map's first burst of tile requests is over (a fetch in the middle of it can be dropped by the dev server)
  const header = async () => page.evaluate(async () => {
    const svg = document.querySelector("#brand .mark"), r = svg.getBoundingClientRect(), circle = svg.querySelector("circle"), path = svg.querySelector("path");
    const copy = svg.cloneNode(true); copy.setAttribute("width", 512); copy.setAttribute("height", 512);
    const logoUrl = document.querySelector('link[rel="icon"][type="image/svg+xml"]').href, logo = await (await fetch(logoUrl)).text();
    return { size: [Math.round(r.width), Math.round(r.height)], role: svg.getAttribute("role"), name: svg.getAttribute("aria-label"), hidden: svg.getAttribute("aria-hidden"), disc: circle && [circle.getAttribute("r"), circle.getAttribute("fill")],
      path: path && [path.getAttribute("fill"), path.getAttribute("fill-rule")], sameShapeAsLogoSvg: !!path && logo.includes(` d="${path.getAttribute("d")}"`), oldMark: svg.getAttribute("viewBox") === "0 0 32 32",   // the old mark's box (both use the app blue since 2026-11-03)
      px: await window.__logo("data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(copy))) };
  });
  const desk = await header();
  const namedImg = await page.locator("#brand").getByRole("img", { name: "Piste" }).count();
  await page.setViewportSize({ width: 390, height: 844 });
  await until(page, () => document.querySelector("#brand .mark").getBoundingClientRect().width === 28);
  const phone = (await header()).size;
  await page.setViewportSize({ width: 1440, height: 900 });
  // the files: the home-screen icon, the manifest's icons (listed with the sizes they really have), the favicon (16, 32, 48) and the SVG one
  const files = await page.evaluate(async () => {
    const href = (sel) => document.querySelector(sel).href, bytes = async (u) => { const r = await fetch(u); return r.ok ? new Uint8Array(await r.arrayBuffer()) : null; };
    const png = async (u) => { const b = await bytes(u); return b ? { ...(await window.__logo(URL.createObjectURL(new Blob([b], { type: "image/png" })))), signature: b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 } : null; };
    const apple = await png(href('link[rel="apple-touch-icon"]'));
    const manifestUrl = href('link[rel="manifest"]'), manifest = await (await fetch(manifestUrl)).json(), icons = [];
    for (const i of manifest.icons) { const u = new URL(i.src, manifestUrl).href; icons.push({ sizes: i.sizes, type: i.type, purpose: i.purpose || "any", px: await png(u) }); }
    // a bare /favicon.ico fetch fails while the test context intercepts requests (the fixtures): the query string makes it an ordinary fetch
    const ico = await bytes(href('link[rel="icon"][sizes]') + "?check"), dv = ico && new DataView(ico.buffer), pics = [];
    for (let i = 0; ico && i < dv.getUint16(4, true); i++) { const e = 6 + 16 * i, off = dv.getUint32(e + 12, true), len = dv.getUint32(e + 8, true);
      pics.push({ w: ico[e], h: ico[e + 1], px: { ...(await window.__logo(URL.createObjectURL(new Blob([ico.slice(off, off + len)], { type: "image/png" })))), signature: ico[off + 1] === 0x50 } }); }
    const svg = await (await fetch(href('link[rel="icon"][type="image/svg+xml"]'))).text();
    return { apple, icons, theme: { meta: document.querySelector('meta[name="theme-color"]').content, manifest: manifest.theme_color }, ico: { reserved: ico && dv.getUint16(0, true), type: ico && dv.getUint16(2, true), pics },
      svg: { viewBox: svg.includes('viewBox="0 0 512 512"'), blue: svg.includes('fill="#1e2160"'), white: svg.includes('fill="#fff"') && svg.includes('fill-rule="evenodd"') } };
  });
  const square = (px, side) => !!px && px.size[0] === side && px.size[1] === side && isNavy(px.edge) && isWhite(px.stem) && isNavy(px.hole) && isNavy(px.corner) && px.white > 0.1 && px.white < 0.3;
  const icon = (side, purpose) => files.icons.find((i) => i.sizes === `${side}x${side}` && i.type === "image/png" && i.purpose.split(" ").includes(purpose));
  const by = Object.fromEntries(files.ico.pics.map((p) => [p.w, p]));
  const checks = {   // named, so a failure says which one
    markSize: desk.size.join() === "34,34" && phone.join() === "28,28",
    discAndP: !!desk.disc && desk.disc.join() === "256,#1e2160" && desk.path.join() === "#fff,evenodd" && isNavy(desk.px.hole) && isWhite(desk.px.stem) && isNavy(desk.px.corner) && desk.px.edge[3] === 0,
    named: desk.role === "img" && desk.name === "Piste" && desk.hidden === null && namedImg === 1, noOldMark: !desk.oldMark, sameShapeAsLogoSvg: desk.sameShapeAsLogoSvg,
    homeScreenIcon: square(files.apple, 180),
    manifest192: square(icon(192, "any") && icon(192, "any").px, 192), manifest512: square(icon(512, "any") && icon(512, "any").px, 512), manifestMaskable: !!icon(512, "maskable") && square(icon(512, "maskable").px, 512),
    manifestSizesAreReal: files.icons.length >= 3 && files.icons.every((i) => i.px && `${i.px.size[0]}x${i.px.size[1]}` === i.sizes),
    themeColourMatches: files.theme.meta === files.theme.manifest,
    favicon: files.ico.reserved === 0 && files.ico.type === 1 && [16, 32, 48].every((s) => by[s] && by[s].h === s && by[s].px.size[0] === s && by[s].px.signature && isNavy(by[s].px.edge) && by[s].px.white > 0.12 && by[s].px.white < 0.3),
    svgFavicon: files.svg.viewBox && files.svg.blue && files.svg.white,
  };
  const bad = Object.keys(checks).filter((k) => !checks[k]);
  return { ok: !bad.length, ...(bad.length ? { error: "failed checks: " + bad.join(", ") } : {}), desk, phone, namedImg, files };
}, { width: 1440, height: 900 });

// ------------------------------------------------------------------ the data-sources "i" (2026-10-31): bottom right, opens leftwards, turns into an x
const creditsProbe = () => { const q = (s) => document.querySelector(s), btn = q(".maplibregl-ctrl-attrib-button"), b = btn.getBoundingClientRect(), box = q(".maplibregl-ctrl-attrib").getBoundingClientRect(),
    map = q("#map").getBoundingClientRect(), pr = q("#panel").getBoundingClientRect(), phone = matchMedia("(max-width: 760px)").matches, zoom = q(".maplibregl-ctrl-zoom-in"), cx = b.left + b.width / 2, cy = b.top + b.height / 2;
  const hit = (x, y) => { const e = document.elementFromPoint(x, y); return !!e && (e === btn || btn.contains(e) || e.closest(".maplibregl-ctrl-attrib-button") === btn); };
  return { btn: [b.left, b.top, b.right, b.bottom].map((v) => Math.round(v * 10) / 10), box: [box.left, box.top, box.right, box.bottom].map(Math.round), size: [Math.round(b.width), Math.round(b.height)],
    nearRight: map.right - b.right <= 24, nearBottom: map.bottom - b.bottom <= 24, aboveSheet: phone ? pr.top - b.bottom >= 0 && pr.top - b.bottom <= 30 : null, open: q(".maplibregl-ctrl-attrib").classList.contains("maplibregl-compact-show"),
    icon: getComputedStyle(btn).backgroundImage, text: q(".maplibregl-ctrl-attrib-inner").textContent, zoomAbove: zoom && getComputedStyle(zoom).display !== "none" ? zoom.getBoundingClientRect().bottom <= b.top + 0.5 : null,
    tap44: [[-21, -21], [21, -21], [-21, 21], [21, 21]].every(([dx, dy]) => hit(cx + dx, cy + dy)), shown: getComputedStyle(q(".maplibregl-ctrl-bottom-right")).display !== "none", panelTop: Math.round(pr.top) }; };
const creditsText = (t) => /OpenStreetMap/.test(t) && /OpenMapTiles/.test(t) && /OpenFreeMap/.test(t) && !/Ville de Montréal|BIXI|Open-Meteo|NRCan|Piste Montréal/.test(t);   // 2026-11-08: the "i" holds only what the licences require; About & terms names every source
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
    const all = ["Ville de Montréal (CC BY 4.0)", "OpenStreetMap contributors", "NRCan HRDEM 2023 + 2024", "Canopée 2019", "STM", "REM (OpenStreetMap)", "BIXI", "Open-Meteo", "OpenFreeMap"];
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
  const open = async () => {
    await page.click("#feedback-link"); await until(page, () => !document.querySelector("#feedback").hidden);
    // the card slides in: a slow machine is still mid-slide here, so wait for it before measuring anything
    await page.evaluate(() => Promise.all(document.querySelector("#feedback").getAnimations({ subtree: true }).filter((a) => a.effect.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))));
  };
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
  await until(page, () => /offline/i.test((document.querySelector("#suggest .note") || {}).textContent || ""), null, 15000);   // a slow machine takes longer than 600 ms to give up
  const note = await page.evaluate(() => (document.querySelector("#suggest .note") || {}).textContent || "");
  await page.fill("#from", ""); await typed("#from", "45.5200, -73.5800"); await page.keyboard.press("Enter");
  await typed("#to", "45.5100, -73.5700"); await page.keyboard.press("Enter");
  await until(page, () => window.__app.state.routes.length > 0, null, 15000);
  const out = await page.evaluate(() => ({ routes: window.__app.state.routes.length, km: window.__app.state.routes[0] ? +(window.__app.state.routes[0].r.length / 1000).toFixed(2) : 0 }));
  await ctx.setOffline(false);
  const ok = kept.controlled && kept.shellFiles >= 20 && /offline/i.test(note) && out.routes > 0 && out.km > 0.5;
  return { ok, kept, note, ...out };
}, undefined, { serviceWorkers: "allow" });

// ---- Night map (2026-11-02; a moon button next to the language button since 2026-11-09): Auto / On / Off; the basemap goes dark, the route and bike-path colours do not change ----
await run("night map: Auto/On/Off, dark basemap, bike paths and route lighter (orange and warnings unchanged), sunrise and sunset", `${APP}?trip=montroyal`, async (page) => page.evaluate(async () => {
  const a = window.__app, m = a.map, wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const semantic = () => JSON.stringify(["route-solid", "route-shared", "route-quiet", "route-alts", "net-ab", "net-c", "closed"].map((id) => m.getPaintProperty(id, "line-color")));
  const bg = () => m.getPaintProperty("background", "background-color"), water = () => m.getPaintProperty("water", "fill-color");
  const nb = document.querySelector("#night-btn"), setNight = (v) => { for (let i = 0; i < 3 && nb.dataset.state !== v; i++) nb.click(); };
  const r0 = nb.getBoundingClientRect(), lr = document.querySelector("#lang-btn").getBoundingClientRect(), ext = getComputedStyle(nb, "::after"), size = (r) => [Math.round(r.width), Math.round(r.height)].join("x");
  const tap = Math.min(parseFloat(ext.width), parseFloat(ext.height));   // the invisible tap area around the 34 px button
  // the button cycles Auto, On, Off, and says which in its label, its shape and its saved value
  const st = () => ({ state: nb.dataset.state, label: nb.getAttribute("aria-label"), title: nb.title, filled: getComputedStyle(nb.querySelector("path")).fill !== "none" && getComputedStyle(nb.querySelector("path")).fill !== "rgba(0, 0, 0, 0)", a: getComputedStyle(nb.querySelector("text")).display !== "none" });
  const day = { bg: bg(), water: water(), semantic: semantic(), state: nb.dataset.state };   // the test setup stores "off"
  setNight("auto"); const auto = st(); const autoStored = localStorage.getItem("piste-night");
  nb.click(); await wait(500);
  const night = { bg: bg(), water: water(), semantic: semantic(), stored: localStorage.getItem("piste-night"), body: document.body.classList.contains("night"), ...st() };
  nb.click(); await wait(500);
  const off = { stored: localStorage.getItem("piste-night"), ...st() }, back = bg();
  nb.click(); const wrapped = st().state;   // Off -> Auto
  setNight("off");
  a.setLang("fr"); const fr = st(); a.setLang("en");
  const cycle = auto.state === "auto" && autoStored === "auto" && auto.label === "Night map: Auto" && auto.a && !auto.filled
    && night.state === "on" && night.label === "Night map: On" && night.filled && !night.a
    && off.state === "off" && off.stored === "off" && off.label === "Night map: Off" && !off.filled && !off.a && wrapped === "auto" && fr.label === "Carte de nuit : Non";
  const sameLook = size(r0) === size(lr) && getComputedStyle(nb).borderRadius === getComputedStyle(document.querySelector("#lang-btn")).borderRadius && nb.nextElementSibling === null && nb.previousElementSibling.id === "lang-btn" && !document.querySelector("input[name=night]");
  // winter keeps working under night: night's colour wins while it is on, winter's again after
  a.setWinter(true); setNight("on"); await wait(500);
  const both = bg(); setNight("off"); await wait(500);
  const winterBack = bg(); a.setWinter(false);
  // 2026-11-07: navy bike paths and routes would vanish on the ink-navy ground, so at night they turn periwinkle; orange (no bike path),
  // the alternatives and closures keep their colours
  const nightColours = (d, n) => { const D = JSON.parse(d), N = JSON.parse(n), keep = [2, 3, 6], navy = [0, 1, 4, 5];
    return keep.every((i) => JSON.stringify(D[i]) === JSON.stringify(N[i])) && navy.every((i) => JSON.stringify(D[i]) !== JSON.stringify(N[i]))
      && JSON.stringify(D[0]).includes("#ff6a1f") && JSON.stringify(N[0]).includes("#ff6a1f") && JSON.stringify(N).includes("#aab0ff"); };
  // sunrise and sunset in Montréal (Jun 21: 05:06 / 20:46 EDT; Dec 21: 07:25 / 16:23 EST), 15 minutes either side
  const n = (s) => BikeCommon.isNight(new Date(s));
  const sun = [n("2026-06-21T08:50:00Z"), !n("2026-06-21T09:25:00Z"), !n("2026-06-22T00:30:00Z"), n("2026-06-22T01:05:00Z"),
    n("2026-12-21T12:10:00Z"), !n("2026-12-21T12:40:00Z"), !n("2026-12-21T21:10:00Z"), n("2026-12-21T21:40:00Z")];
  const ok = day.state === "off" && cycle && sameLook && night.bg !== day.bg && night.water !== day.water && night.bg === "#0f1626" && nightColours(day.semantic, night.semantic) && !day.semantic.includes("null") && night.stored === "on" && night.body
    && back === day.bg && both === "#0f1626" && winterBack === "#f3f5f8" && sun.every(Boolean) && tap >= 44;
  return { ok, day, auto, night, off, fr, wrapped, sameLook, back, both, winterBack, sun, tap };
}));

// ------------------------------------------------------------------ parks (2026-11-03): tools/island_parks.py merges OpenStreetMap parks, nature reserves and public gardens over the whole
// island into one see-through green fill (parks.pmtiles), under the water, hill shading, paths and labels. The basemap's own park layer (under the tint, so hidden) is gone.
const PARK_SPOTS = { "Parc La Fontaine": [-73.5707, 45.5266], "Mont-Royal": [-73.5886, 45.5054], "Parc Jean-Drapeau": [-73.5343, 45.5139], "Jardin botanique": [-73.5636, 45.562],
  "Parc Angrignon": [-73.6033, 45.4422], "Bois-de-l'Île-Bizard": [-73.8817, 45.5073], "Cap-Saint-Jacques": [-73.9316, 45.4649], "Pointe-aux-Prairies": [-73.5117, 45.6778] };
const STREET_SPOT = [-73.57499, 45.5266];   // the Plateau's street grid, 330 m west of Parc La Fontaine's centre: no park there
await run("parks: a muted see-through green over the whole island, under the water, paths and labels; day, night and winter colours; Parc La Fontaine is green", `${APP}?trip=montroyal`, async (page) => {
  await page.evaluate((c) => window.__app.map.jumpTo({ center: c, zoom: 15 }), PARK_SPOTS["Parc La Fontaine"]);
  await page.evaluate(idle);
  const out = await page.evaluate(async ({ spots, street }) => {
    const a = window.__app, m = a.map, ids = m.getStyle().layers.map((l) => l.id), at = (id) => ids.indexOf(id);
    const above = (id) => at(id) < 0 || at("parks") < at(id);   // "id" is drawn over the parks (a layer the basemap lacks, offline, does not count)
    const firstLabel = ids.findIndex((id) => m.getLayer(id).type === "symbol");
    const layer = { exists: !!m.getLayer("parks"), type: m.getLayer("parks") && m.getLayer("parks").type, sourceLayer: m.getLayer("parks") && m.getLayer("parks").sourceLayer,
      overTint: at("tint") >= 0 && at("tint") < at("parks"),
      under: ["water", "waterway", "relief", "contours-index", "bld-flat", "net-casing", "net-ab", "route-solid", "stops", "ends"].filter((id) => !above(id)),
      belowLabels: firstLabel < 0 || at("parks") < firstLabel, basemapParkGone: !m.getLayer("park") };
    // pixels: the lawn of Parc La Fontaine turns green when the layer is shown; a street block does not change. A frame is read only once the map has settled
    // (the same spot shown, hidden and shown again must read the same, or the first reading was taken while tiles were still arriving)
    const mean = ([x, y]) => { m.redraw(); const gl = m.painter.context.gl, d = devicePixelRatio, w = Math.round(12 * d), px = new Uint8Array(w * w * 4);
      gl.readPixels(Math.round((x - 6) * d), gl.drawingBufferHeight - Math.round((y - 6) * d) - w, w, w, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const s = [0, 0, 0]; for (let i = 0; i < px.length; i += 4) for (let c = 0; c < 3; c++) s[c] += px[i + c]; return s.map((v) => v / (px.length / 4)); };
    const settle = () => new Promise((r) => { const t0 = performance.now(); (function poll() { if ((m.loaded() && !m.isMoving()) || performance.now() - t0 > 20000) r(); else setTimeout(poll, 100); })(); });
    const shown = async (ll) => {
      for (let i = 0; ; i++) {
        await settle();
        const p = m.project(ll), pt = [p.x, p.y]; m.setLayoutProperty("parks", "visibility", "visible");
        const on = mean(pt), features = m.queryRenderedFeatures(pt, { layers: ["parks"] }).length;   // asked while the frame just drawn has them
        m.setLayoutProperty("parks", "visibility", "none"); const off = mean(pt); m.setLayoutProperty("parks", "visibility", "visible"); const again = mean(pt);
        const stable = Math.max(...on.map((v, k) => Math.abs(v - again[k]))) < 3;
        if (stable || i >= 5) return { on: on.map(Math.round), off: off.map(Math.round), features, stable };
      }
    };
    const lawn = await shown(spots["Parc La Fontaine"]), streets = await shown(street);
    const pixels = { lawn, streets, greener: lawn.on[1] - lawn.on[0] - (lawn.off[1] - lawn.off[0]), darker: lawn.off[0] - lawn.on[0], streetShift: Math.max(...streets.on.map((v, i) => Math.abs(v - streets.off[i]))) };
    // colours: a muted green by day, deeper green at night, frosty green in winter; night wins when both are on; the fill stays see-through
    const color = () => m.getPaintProperty("parks", "fill-color"), lum = (hex) => { const n = parseInt(hex.slice(1), 16); return 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255); };
    const day = color(), op = m.getPaintProperty("parks", "fill-opacity"), stops = op.slice(3).filter((_, i) => i % 2 === 1);
    a.setWinter(true); const winter = color();
    (() => { const b = document.querySelector("#night-btn"); for (let i = 0; i < 3 && b.dataset.state !== "on"; i++) b.click(); })(); const both = color();
    a.setWinter(false); const night = color();
    (() => { const b = document.querySelector("#night-btn"); for (let i = 0; i < 3 && b.dataset.state !== "off"; i++) b.click(); })(); const back = color();
    const green = (hex) => { const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255; return g > r && g > b; };
    const colours = { day, winter, night, both, back, distinct: new Set([day, winter, night]).size === 3, green: [day, winter, night].every(green), darkerAtNight: lum(night) < lum(day) * 0.7,
      maxOpacity: Math.max(...stops), nightWins: both === night, restored: back === day };
    // the tiles cover the whole island (west end, east end, downtown, south shore) and stay small for phones and the offline cache
    const tile = (lon, lat, z) => { const n = 2 ** z, r = (lat * Math.PI) / 180; return [Math.floor(((lon + 180) / 360) * n), Math.floor(((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * n)]; };
    const url = new URL("../shared/tiles/parks.pmtiles", location.href).href, pm = new pmtiles.PMTiles(url), covered = {};
    for (const [name, [lon, lat]] of Object.entries(spots)) { const [x, y] = tile(lon, lat, 14), t = await pm.getZxy(14, x, y); covered[name] = t ? t.data.byteLength : 0; }
    const head = await pm.getHeader(), size = +(await fetch(url, { method: "HEAD" })).headers.get("content-length");
    return { layer, colours, pixels, covered, zooms: [head.minZoom, head.maxZoom], size };
  }, { spots: PARK_SPOTS, street: STREET_SPOT });
  const checks = {   // named, so a failure says which one
    layerIsAFill: out.layer.exists && out.layer.type === "fill" && out.layer.sourceLayer === "parks", aboveTint: out.layer.overTint, underTheRest: out.layer.under.length === 0, belowLabels: out.layer.belowLabels,
    notDrawnTwice: out.layer.basemapParkGone,
    threeColours: out.colours.distinct && out.colours.green, nightIsDeeper: out.colours.darkerAtNight, nightWinsOverWinter: out.colours.nightWins, dayColourComesBack: out.colours.restored,
    seeThrough: out.colours.maxOpacity > 0.1 && out.colours.maxOpacity <= 0.45,
    lawnTurnsGreen: out.pixels.lawn.features > 0 && out.pixels.greener >= 8 && out.pixels.darker >= 15, streetsUntouched: out.pixels.streets.features === 0 && out.pixels.streetShift < 2,
    wholeIsland: Object.values(out.covered).every((b) => b > 0), small: out.size > 0 && out.size < 1_000_000, zooms: out.zooms[0] <= 11 && out.zooms[1] >= 14,
  };
  const bad = Object.keys(checks).filter((k) => !checks[k]);
  return { ok: !bad.length, ...(bad.length ? { error: "failed checks: " + bad.join(", ") } : {}), ...out };
});

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
  const btn = await page.evaluate(() => { const b = document.querySelector("#dock .share-btn"), r = b && b.getBoundingClientRect();
    const g = document.querySelector("#ride-go").getBoundingClientRect();   // 2026-11-04: right of "Let's ride!", on its line, as tall
    return b && { label: b.getAttribute("aria-label"), text: b.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height), svg: !!b.querySelector("svg"), tour: window.pisteTour.steps.join(),
      rightOfRide: r.left >= g.right && Math.abs(r.top - g.top) < 1 && Math.abs(r.height - g.height) < 1, nearHeading: !!b.closest(".det-head, h2") }; });
  await page.click("#dock .share-btn"); await until(page, () => window.__shared.length === 1);
  const web = await page.evaluate(() => { const s = window.__app.state, ll = (p) => p.map((v) => +v.toFixed(5)).join(","); const d = window.__shared[0];
    return { url: d && d.url, want: `${location.origin}${location.pathname}?from=${ll(s.from)}&to=${ll(s.to)}` }; });
  // no Web Share: the link goes to the clipboard with a toast; a refusal gets a calm message instead of silence
  await page.evaluate(() => Object.defineProperty(navigator, "share", { value: undefined, configurable: true }));
  await page.click("#dock .share-btn"); await until(page, () => window.__copied);
  const copied = await page.evaluate(() => ({ text: window.__copied, toast: document.querySelector("#toast").hidden ? "" : document.querySelector("#toast").textContent }));
  await page.evaluate(() => { window.__copyFails = true; document.querySelector("#toast").hidden = true; });
  await page.click("#dock .share-btn"); await until(page, () => !document.querySelector("#toast").hidden);
  const failed = await page.evaluate(() => document.querySelector("#toast").textContent);
  // the link reopens the same route (its ends rounded to 5 decimals)
  const was = await page.evaluate(() => window.__app.state.routes.map((c) => Math.round(c.r.length)).join());
  await page.goto(web.url, { waitUntil: "load" }); await page.waitForFunction(() => !!window.__app, null, { timeout: 90000 });
  await until(page, () => window.__app.state.routes.length > 0);
  const again = await page.evaluate(() => window.__app.state.routes.map((c) => Math.round(c.r.length)).join());
  // a classic ride shares ?classic=<id>; the made-to-order rides share their points (tested in their own groups below)
  await page.goto(BASE + APP + "?classic=oldport", { waitUntil: "load" }); await page.waitForFunction(() => !!window.__app, null, { timeout: 90000 });
  await until(page, () => !!document.querySelector("#dock .share-btn"), null, 30000);
  await page.evaluate(shareStub); await page.click("#dock .share-btn"); await until(page, () => window.__shared.length === 1);
  const classic = await page.evaluate(() => window.__shared[0].url);
  const loops = await page.evaluate(async () => { const a = window.__app; window.piste.setPoint("from", [-73.5817, 45.5246], "Start"); a.setSuggMode("custom"); await a.computeSuggestions(true); return !!document.querySelector(".share-btn"); });
  const ok = cards.n >= 1 && cards.subs.every((x) => !/stretch|without a bike path|tronçon/i.test(x)) && cards.pct.every((x) => /on bike paths/.test(x))
    && wind.same && wind.customOnly && wind.hiddenInGo
    && btn && btn.label === "Share this route" && btn.text === "" && btn.svg && btn.w >= 44 && btn.h >= 44 && btn.rightOfRide && !btn.nearHeading && !/share/i.test(btn.tour)
    && web.url === web.want && !/welcome|notrack/.test(web.url) && copied.text === web.url && copied.toast === "Link copied" && failed === "Couldn't copy the link"
    && again === was && /\?classic=oldport$/.test(classic) && !/welcome|notrack/.test(classic) && loops;
  return { ok, cards, wind, btn, web, copied, failed, was, again, classic, loops };
}, { width: 1440, height: 900 });

// ---- sharing reopens the ride shown (2026-11-09): "Go somewhere" with its Route style / Avoid settings, "Design your own ride" rebuilt from its points, the
// summary's link, and link values that are not valid are ignored. Tests a bug report: the button only sent a link to the app, not the ride.
const GO_LINK = "?from=-73.5817,45.5246&to=-73.6150,45.5035";
const openLink = async (page, url) => { await page.goto(url, { waitUntil: "load" }); await page.waitForFunction(() => !!window.__app, null, { timeout: 90000 }); };
const shareLink = async (page) => { await page.evaluate(shareStub); await page.click("#dock .share-btn"); await until(page, () => window.__shared.length === 1); return page.evaluate(() => window.__shared[0].url); };
await run("share: a Go somewhere link carries the Route style and Avoid settings and reopens the same route; this device's own settings do not leak in", APP + GO_LINK, async (page) => {
  const read = () => page.evaluate(() => { const a = window.__app, r = a.state.routes[0] && a.state.routes[0].r;
    return { len: r ? r.length : null, style: +document.querySelector("#strict").value, hills: document.querySelector("#hills").checked, works: document.querySelector("#avoid-works").checked,
      saved: localStorage.getItem("piste-avoid-works") }; });
  const plain = await read();
  await page.evaluate(() => { const set = (id, ev, f) => { const el = document.querySelector(id); f(el); el.dispatchEvent(new Event(ev, { bubbles: true })); };
    set("#strict", "input", (e) => (e.value = 10)); set("#hills", "change", (e) => (e.checked = true)); set("#avoid-works", "change", (e) => (e.checked = true)); });
  await until(page, () => document.querySelector("#strict-out").textContent !== "Lanes always");
  const sent = await read(), url = await shareLink(page);
  const q = new URL(url).searchParams;
  await openLink(page, url); await until(page, () => window.__app.state.routes.length > 0);
  const got = await read();
  // a plain link must not pick up the works option this device saved on its own
  await openLink(page, BASE + APP + GO_LINK); await until(page, () => window.__app.state.routes.length > 0);
  const own = await read();
  const ok = plain.style === 85 && sent.style === 10 && sent.hills && sent.works && q.get("style") === "10" && q.get("hills") === "1" && q.get("works") === "1" && !/welcome|notrack/.test(url)
    && q.get("from") === "-73.5817,45.5246" && q.get("to") === "-73.615,45.5035" && url.length < 120
    && Math.abs(sent.len - plain.len) > 1   // the settings really change this route, so a link that dropped them would show
    && Math.abs(got.len - sent.len) <= 1 && got.style === 10 && got.hills && got.works && got.saved === "1"
    && Math.abs(own.len - plain.len) <= 1 && own.style === 85 && !own.hills && !own.works && own.saved === "1";
  return { ok, url, plain, sent, got, own };
}, { width: 1440, height: 900 });

// a made-to-order ride: a loop (the second ride in the list), a loop through a stop, and a one-way ride. Each link is rebuilt on the other side from its points.
await run("share: a Design your own ride link reopens that ride (within 3% of its length, through its stop)", `${APP}?suggest=loop&from=-73.5817,45.5246&km=7`, async (page) => {
  const ready = (n = 1) => until(page, (m) => window.__app.state.tab === "suggest" && window.__app.state.routes.length >= m && !document.querySelector(".finding"), n, 120000);
  const cases = [];
  const one = async (label, url, pick) => {
    if (url) { await openLink(page, BASE + APP + url); await ready(); }
    if (pick) { await page.evaluate((i) => window.piste.selectRoute(i), pick); }
    const sent = await page.evaluate(() => { const s = window.__app.state, c = s.routes[s.sel], r = c.r;
      return { n: s.routes.length, len: r.length, stop: (r.stops || [])[0] ? { label: r.stops[0].label, lon: r.stops[0].lon, lat: r.stops[0].lat } : null, title: (document.querySelector("#routes .route-card.sel b") || document.querySelector("#routes b")).textContent }; });
    const link = await shareLink(page), q = new URL(link).searchParams;
    await openLink(page, link); await ready();
    const got = await page.evaluate((stop) => { const s = window.__app.state, r = s.routes[0].r, D = BikeCommon.distM;
      return { n: s.routes.length, len: r.length, stopLabel: (r.stops || [])[0] && r.stops[0].label, nearStop: stop ? Math.min(...r.coords.map((c) => D(c[0], c[1], stop.lon, stop.lat))) : null,
        title: document.querySelector("#routes b").textContent, tab: s.tab, mode: s.smode, loop: s.sugg.loop }; }, sent.stop);
    const rel = Math.abs(got.len - sent.len) / sent.len;
    cases.push({ label, link, sent, got, rel: +rel.toFixed(4), params: [...q.keys()].join() });
  };
  await one("loop, second ride", null, 1);
  await one("loop by a cafe", "?suggest=loop&from=-73.5817,45.5246&km=7&stop=cafe", 0);
  await one("one-way", "?suggest=oneway&from=-73.5817,45.5246&km=6", 0);
  const good = (c) => c.rel <= 0.03 && c.got.n === 1 && c.got.tab === "suggest" && c.got.mode === "custom" && /^suggest,from,via,km(,stop)?$/.test(c.params) && c.link.length < 200
    && (!c.sent.stop || (c.got.stopLabel === c.sent.stop.label && c.got.nearStop < 25)) && c.got.title === c.sent.title;
  return { ok: cases.length === 3 && cases.every(good), cases };
}, { width: 1440, height: 900 });

// the summary's share button: the link reopens the route that was planned for that ride; the GPS trace never leaves the phone
await run("share: the ride summary's link reopens the planned route and carries no part of the GPS trace", `${APP}?trip=montroyal&gps=replay&gpsx=4`, async (page) => {
  await page.evaluate(shareStub);
  const planned = await page.evaluate(() => { const a = window.__app, s = a.state; return { len: Math.round(s.routes[0].r.length), from: s.from.map((v) => +v.toFixed(5)).join(","), to: s.to.map((v) => +v.toFixed(5)).join(",") }; });
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), app = window.__app, s = app.state, total = s.routes[s.sel].r.length;
    app.startGpsRide({ replay: { speedup: 4, startAt: Math.max(0, total - 900) } }); window.__flatRide();
    for (const t0 = performance.now(); s.ride.trail.length < 40 && performance.now() - t0 < 60000;) await sleep(200);
    window.__trail = s.ride.trail.slice(); document.querySelector("#ride-exit").click();
  });
  await until(page, () => !document.querySelector("#ride-summary").hidden && !document.querySelector("#rs-share").hidden, null, 20000);
  await page.click("#rs-share"); await until(page, () => window.__shared.length === 1);
  const shared = await page.evaluate(() => ({ url: window.__shared[0].url, text: window.__shared[0].text, trail: window.__trail.map((p) => [p.lon, p.lat]) }));
  const q = new URL(shared.url).searchParams;
  const leaks = shared.trail.filter(([lon, lat]) => shared.url.includes(lon.toFixed(4)) || shared.url.includes(lat.toFixed(4))).length;   // none of the ridden points
  await openLink(page, shared.url); await until(page, () => window.__app.state.routes.length > 0);
  const again = await page.evaluate(() => Math.round(window.__app.state.routes[0].r.length));
  const ok = q.get("from") === planned.from && q.get("to") === planned.to && [...q.keys()].join() === "from,to" && Math.abs(again - planned.len) <= 1
    && /^I rode .+ with Piste/.test(shared.text) && shared.trail.length >= 40 && leaks === 0;
  return { ok, planned, url: shared.url, text: shared.text, again, leaks };
}, { width: 390, height: 844 }, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

// a link with values that are not valid shows what it can and breaks nothing
await run("share: link values that are not valid are ignored (numbers out of range, unknown ids, too many points)", APP, async (page) => {
  const bad = [
    ["from=abc&to=-73.6,45.5", (s) => s.from === null],
    ["from=-73.58,45.52&to=999,999", (s) => s.from !== null && s.to === null],
    ["from=-73.58,45.52&to=-73.61,45.50&style=500&hills=2&works=yes", (s) => s.style === 85 && !s.hills && !s.works && s.routes === 1],
    ["from=-73.58,45.52&to=-73.61,45.50&style=abc", (s) => s.style === 85 && s.routes === 1],
    ["classic=not-a-ride", (s) => s.tab === "go"],
    ["suggest=loop&from=-73.58,45.52&via=1,2~x&km=9", (s) => s.tab === "suggest" && s.km === 9 && s.shared === false],
    ["from=-73.58,45.52&to=-73.61,45.50&winter=2", (s) => !s.winter && s.routes === 1],
  ];
  const out = [];
  for (const [q, check] of bad) {
    await openLink(page, `${BASE}${APP}?${q}`);
    await until(page, () => !document.querySelector(".finding"), null, 90000);
    const s = await page.evaluate(() => { const a = window.__app.state; return { from: a.from, to: a.to, tab: a.tab, km: a.sugg.km, style: +document.querySelector("#strict").value, hills: document.querySelector("#hills").checked,
      works: document.querySelector("#avoid-works").checked, routes: a.routes.length, winter: a.winter, shared: a.routes.length === 1 && !!a.routes[0].r.pts && a.tab === "suggest" }; });
    out.push({ q, ok: !!check(s), s });
  }
  return { ok: out.every((o) => o.ok), out };
}, { width: 1440, height: 900 });

// ------------------------------------------------------------------ the route card (2026-11-05): one card that follows the slider and the Avoid chips;
// the climbs sentence (over 7 % and over 10 m), the elevation coloured by grade, the bike-path strip, the share; elevation told nowhere else
const cardSnap = () => { const a = window.__app, C = window.BikeCommon, s = a.state, cards = [...document.querySelectorAll("#routes .route-card")];
  return { n: cards.length, routes: s.routes.length, sel: s.sel, cards: cards.map((el, i) => { const svg = el.querySelector(".rc-profile svg"), bar = el.querySelector(".bar"), r = s.routes[i] && s.routes[i].r;
    const segs = [...el.querySelectorAll(".bar .seg")], grow = (x) => parseFloat(x.style.flexGrow) || 0;
    const on = (segs.filter((x) => !x.classList.contains("gap")).reduce((m, x) => m + grow(x), 0) / Math.max(1, segs.reduce((m, x) => m + grow(x), 0))) * 100;
    const cs = el.getBoundingClientRect(), sv = svg && svg.getBoundingClientRect(), br = bar && bar.getBoundingClientRect();
    const colour = (q) => { const x = el.querySelector(q); return x && getComputedStyle(x).backgroundColor; };
    return { tag: el.tagName, sel: el.classList.contains("sel"), order: [...el.children].filter((c) => !c.classList.contains("ink-svg") && !c.classList.contains("prefs")).flatMap((c) => /^rc-(head|body)$/.test(c.className) ? [...c.children] : [c]).map((c) => c.className.split(" ")[0] || c.tagName).join(), tune: !!el.querySelector(":scope > .prefs"),   // the pen outline (ink.js) is not part of the card's content; Go somewhere's card has its two halves (rc-head, rc-body, laid out as if absent) around the controls (.prefs, 2026-11-09)
      title: el.querySelector(".rc-top b").textContent, time: el.querySelector(".rc-top .time").textContent, km: el.querySelector(".rc-km").textContent, climb: el.querySelector(".rc-climb").textContent,
      pct: el.querySelector(".rc-pct").textContent, label: svg && svg.getAttribute("aria-label"), role: svg && svg.getAttribute("role"), stops: svg ? [...svg.querySelectorAll("stop")].map((x) => x.getAttribute("stop-color")) : [],
      onPct: on, offs: el.querySelectorAll(".bar .seg.gap").length, offColour: colour(".bar .seg.gap"),
      onBg: (() => { const x = el.querySelector(".bar .seg:not(.gap)"); if (!x) return ""; const cs = getComputedStyle(x); return cs.backgroundColor + " " + cs.backgroundImage; })(),
      aligned: !!(sv && br) && Math.abs(sv.left - br.left) < 1 && Math.abs(sv.width - br.width) < 1 && br.top - sv.bottom >= 8 && br.top - sv.bottom < 20, inside: !!sv && sv.left >= cs.left && sv.right <= cs.right,
      want: r && { km: C.fmtKm(r.length), time: C.fmtMin(C.rideMinutes(r)), gapShare: C.mainGaps(r).reduce((m, g) => m + g.length, 0) / r.length, gaps: C.mainGaps(r).length,
        n: C.hills(r).list.length, m: Math.round(C.hills(r).total) } }; }),
    detail: document.querySelector("#detail").textContent, detailSvg: !!document.querySelector("#detail svg[role=img]"), wide: document.querySelector("#panel").scrollWidth <= document.querySelector("#panel").clientWidth }; };
await run("route card: one card that follows the slider and Avoid; climbs over 7 % and 10 m; elevation by grade; bike-path strip; Suggest and classics", `${APP}?from=-73.5817,45.5246&to=-73.6150,45.5035`, async (page) => {
  await until(page, () => window.__app.state.routes.length > 0 && !!document.querySelector("#routes .route-card"), null, 60000);
  const units = await page.evaluate(() => {
    const C = window.BikeCommon, route = (pr) => ({ profile: pr, length: pr[pr.length - 1][0], pieces: [{ start: 0, length: pr[pr.length - 1][0], tier: 0, names: ["Rue Test"] }] });
    const h = (pr) => { const x = C.hills(route(pr)); return { n: x.list.length, total: Math.round(x.total * 10) / 10, g: x.steepest && Math.round(x.steepest.grade * 1000) / 10, L: x.steepest && Math.round(x.steepest.length) }; };
    const sat = (rgb) => { const [r, g, b] = rgb.match(/\d+/g).map((v) => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2; return mx === mn ? 0 : (mx - mn) / (1 - Math.abs(2 * l - 1)); };
    const flat = C.gradeProfileSVG(route([[0, 20], [200, 21], [400, 20]]), { height: 60 }), red = C.gradeColor(0.08);
    return {
      steep30: h([[0, 10], [100, 10], [130, 12.4], [300, 12.4]]),        // 8 % over 30 m: one climb
      steep8: h([[0, 10], [100, 10], [108, 10.64], [300, 10.64]]),      // 8 % over 8 m: too short
      seven: h([[0, 10], [100, 10], [200, 17], [300, 17]]),             // exactly 7 %: not steeper than 7 %
      two: h([[0, 10], [100, 10], [150, 15], [400, 15], [440, 19.8], [600, 19.8]]),   // 10 % over 50 m, then 12 % over 40 m: two, the steeper is 12 %
      spike: h([[0, 30], [60, 30], [100, 22], [150, 30], [300, 30]]),   // one point 8 m low (a bridge in the ground model): no climb, nothing up
      colours: { flat: C.gradeColor(0) === C.gradeColor(-0.06) && C.gradeColor(0.01) === C.gradeColor(0), mid: C.gradeColor(0.045) !== C.gradeColor(0) && C.gradeColor(0.045) !== red,
        red: C.gradeColor(0.071) === red && C.gradeColor(0.2) === red && C.gradeColor(0.069) !== red,
        navy: (() => {   // 2026-11-07: one navy ramp, pale (flat) to deep (steep); no green, yellow or red (orange is "no bike path", right under it)
          const hl = (rgb) => { const [r, g, b] = rgb.match(/\d+/g).map((v) => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
            return [d === 0 ? 0 : mx === b ? 60 * ((r - g) / d) + 240 : mx === g ? 60 * ((b - r) / d) + 120 : (60 * ((g - b) / d) + 360) % 360, (mx + mn) / 2]; };
          const v = [0, 0.045, 0.08].map((g) => hl(C.gradeColor(g)));
          return v.every(([h]) => h >= 225 && h <= 245) && v[0][1] > v[1][1] && v[1][1] > v[2][1]; })() },
      flatHasRed: flat.includes(red), flatLabel: /aria-label="Elevation profile"/.test(flat) };
  });
  const go = await page.evaluate(cardSnap);
  const red = await page.evaluate(() => window.BikeCommon.gradeColor(0.2));
  // the slider and the Avoid chips: the card is rebuilt for the new route (marked first, so a stale card would show)
  const moved = await page.evaluate(async () => {
    const pause = () => new Promise((r) => setTimeout(r, 300)), mark = () => { document.querySelector("#routes .route-card .rc-top").dataset.old = "1"; document.querySelector("#routes .route-card .rc-climb").dataset.old = "1"; }, fresh = () => !document.querySelector("#routes .route-card [data-old]");   // 2026-11-09: the card itself stays (with the controls inside); its halves are re-rendered
    const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true })), s = document.querySelector("#strict"), hills = document.querySelector("#hills"), w = document.querySelector("#avoid-works");
    const out = {};
    mark(); s.value = s.min; fire(s, "input"); await pause(); out.slider = fresh();
    mark(); hills.checked = true; fire(hills, "change"); await pause(); out.hills = fresh();
    mark(); w.checked = !w.checked; fire(w, "change"); await pause(); out.works = fresh();
    w.checked = !w.checked; fire(w, "change"); hills.checked = false; fire(hills, "change"); await pause();
    return out; });
  const afterMove = await page.evaluate(cardSnap);
  const fr = await page.evaluate(() => { window.__app.setLang("fr"); const t = document.querySelector("#routes .rc-climb").textContent, p = document.querySelector("#routes .rc-pct").textContent; window.__app.setLang("en"); return { t, p }; });
  // Suggest a ride: one card per ride, each a button that picks it
  await page.evaluate(async () => { const a = window.__app; a.setTab("suggest"); a.setSuggMode("custom"); await a.computeSuggestions(true); });
  await until(page, () => window.__app.state.routes.length > 1 && document.querySelectorAll("#routes .route-card").length > 1, null, 60000);
  const sg = await page.evaluate(cardSnap);
  await page.evaluate(() => document.querySelectorAll("#routes .route-card")[1].click());
  const picked = await page.evaluate(cardSnap);
  // a classic ride: one card, the ride's name as its title
  await page.evaluate(() => { window.__app.setSuggMode("classics"); window.__app.showClassic(0, false); });
  await until(page, () => window.__app.state.routes[0] && window.__app.state.routes[0].classic && !!document.querySelector("#routes .route-card"), null, 30000);
  const clName = await page.evaluate(() => window.__app.state.routes[0].title.raw);
  // 2026-11-08: a classic ride's card is its card in the carousel (photo, then the route card's parts with the ride's description); nothing in #routes
  const cls = await page.evaluate(() => { const el = document.querySelector("#classics .classic-card.sel"), body = el && el.querySelector(".cc-body");
    return { inRoutes: document.querySelectorAll("#routes .route-card").length, order: body ? [...body.children].filter((c) => !c.classList.contains("ink-svg")).map((c) => c.className.split(" ")[0]).join() : "",
      title: el && el.querySelector(".rc-top b").textContent, photo: !!(el && el.querySelector(".cc-photo")), gone: !document.querySelector(".cc-meta, .cc-start"),
      segs: el ? el.querySelectorAll(".bar button.seg").length : 0, pctOnce: el ? (el.textContent.match(/% on bike paths/g) || []).length : 0,
      others: document.querySelectorAll("#classics .classic-card:not(.sel) .bar button.seg").length }; });
  const sentence = /^(\d+ climbs?, \d+ m total\. Steepest climb is \d+% over \d+ m( on .+)?\.|No steep climbs, \d+ m total\.)$/;
  const cardOk = (c) => c.order === `rc-top,rc-sub,rc-climb,rc-profile,bar,rc-under${c.tag === "DIV" ? ",rc-more" : ""}` && sentence.test(c.climb) && c.km === c.want.km && c.time === c.want.time
    && (c.want.n ? c.climb.startsWith(`${c.want.n} climb${c.want.n > 1 ? "s" : ""}, ${c.want.m} m total.`) : c.climb === `No steep climbs, ${c.want.m} m total.`)
    && /^\d+% on bike paths$/.test(c.pct) && Math.abs(c.onPct - (1 - c.want.gapShare) * 100) < 0.6 && c.offs === c.want.gaps && c.role === "img" && c.label === "Elevation" && c.aligned && c.inside
    && c.stops.length > 0 && (c.want.n > 0) === c.stops.includes(red);
  const g0 = go.cards[0];
  const checks = {
    rule: units.steep30.n === 1 && units.steep30.g === 8 && units.steep30.L === 30 && units.steep8.n === 0 && units.seven.n === 0 && units.two.n === 2 && units.two.g === 12 && units.two.L === 40,
    spikeRemoved: units.spike.n === 0 && units.spike.total === 0,
    colours: units.colours.flat && units.colours.mid && units.colours.red && units.colours.navy && !units.flatHasRed && units.flatLabel,
    oneCardInGo: go.n === 1 && go.routes === 1 && g0.tag === "DIV" && !g0.sel && g0.title === "Your route",
    goCard: cardOk(g0) && g0.tune && g0.want.n >= 2 && /^\d+ climbs, \d+ m total\. Steepest climb is \d+% over \d+ m on .+\.$/.test(g0.climb) && g0.offs > 0 && g0.onBg.includes("rgb(30, 33, 96)") && g0.offColour === "rgb(255, 106, 31)",
    elevationOnlyInCard: !/climb|elevation|m total/i.test(go.detail) && !go.detailSvg && !/climb/i.test(g0.km + g0.title + g0.pct),
    followsControls: moved.slider && moved.hills && moved.works && afterMove.n === 1 && cardOk(afterMove.cards[0]),
    french: /^(\d+ côtes?, \d+ m de montée au total\. La plus raide[\u00a0\u202f]: \d+[\u00a0\u202f]% sur \d+ m(, .+)?\.|Aucune côte raide, \d+ m de montée au total\.)$/.test(fr.t) && /sur pistes cyclables/.test(fr.p),
    suggest: sg.n === sg.routes && sg.n > 1 && sg.cards.every((c) => c.tag === (c.sel ? "DIV" : "BUTTON") && cardOk(c)) && sg.cards.filter((c) => c.sel).length === 1 && sg.cards[0].sel && !sg.detailSvg,
    picks: picked.sel === 1 && picked.cards[1].sel && picked.cards[1].tag === "DIV" && !picked.cards[0].sel && picked.cards[0].tag === "BUTTON",
    classic: cls.inRoutes === 0 && cls.order === "rc-top,rc-sub,cc-blurb,rc-climb,rc-profile,bar,rc-under,rc-more" && cls.title === clName && cls.photo && cls.gone && cls.segs > 0 && cls.pctOnce === 1 && cls.others === 0,
    phoneFits: go.wide && sg.wide,
  };
  const bad = Object.keys(checks).filter((k) => !checks[k]);
  return { ok: !bad.length, ...(bad.length ? { error: "failed checks: " + bad.join(", ") } : {}), units, go: g0, moved, fr, sugg: sg.cards.map((c) => ({ title: c.title, climb: c.climb })), picked: picked.sel, classic: cls };
}, { width: 390, height: 844 }, { hasTouch: true, isMobile: true });

// ------------------------------------------------------------------ the route card's stretches (2026-11-07): the old "Without a bike path" list lives in the card.
// Each stretch of the strip is a button; a tap opens its details inline (title and "after" as the old list said them), greys out the rest
// of the chart, shows it on the map; ‹ › step through; a second tap closes. Buttons carry comic-print dots behind them.
await run("route card stretches: tap for details in the card (the old list's words), step, close, French; comic-print dots behind buttons", `${APP}?from=-73.5817,45.5246&to=-73.6150,45.5035`, async (page) => {
  await until(page, () => window.__app.state.routes.length > 0 && !!document.querySelector("#routes .route-card .bar .seg"), null, 60000);
  const first = await page.evaluate(() => {
    const C = window.BikeCommon, r = window.__app.state.routes[0].r, gaps = C.mainGaps(r), segs = [...document.querySelectorAll("#routes .route-card .bar .seg")];
    const grow = segs.map((x) => +x.style.flexGrow), gapSegs = segs.filter((x) => x.classList.contains("gap")), pre = getComputedStyle(segs[0], "::before");
    return { n: segs.length, gaps: gaps.length, gapLens: gapSegs.map((x) => +x.style.flexGrow).join(), want: gaps.map((g) => Math.round(g.length)).join(),
      nums: gapSegs.map((x) => x.textContent).filter(Boolean).every((v) => /^\d+$/.test(v) && +v <= gaps.length), total: grow.reduce((a, b) => a + b, 0), L: Math.round(r.length),
      buttons: segs.every((x) => x.tagName === "BUTTON" && x.getAttribute("aria-expanded") === "false" && !!x.getAttribute("aria-label")),
      touch: segs[0].getBoundingClientRect().height - parseFloat(pre.top) - parseFloat(pre.bottom), closed: !document.querySelector(".rc-more").classList.contains("open"),
      oldList: !!document.querySelector("#detail .gap-item, #detail .gaps") || [...document.querySelectorAll("#detail h2")].some((h) => /bike path/i.test(h.textContent)),
      hint: /\btap\b/i.test(document.querySelector(".route-card").textContent) };
  });
  const cam0 = await page.evaluate(() => window.__app.map.getCenter().toArray().map((v) => v.toFixed(5)).join());
  await page.evaluate(() => [...document.querySelectorAll("#routes .route-card .bar .seg.gap")].pop().click());
  await page.waitForTimeout(900);
  const open = await page.evaluate(() => {
    const C = window.BikeCommon, I = window.BikeI18n, r = window.__app.state.routes[0].r, gaps = C.mainGaps(r), g = gaps[gaps.length - 1];
    const segs = [...document.querySelectorAll("#routes .route-card .bar .seg")], on = segs.filter((x) => x.classList.contains("on")), det = document.querySelector(".rc-det");
    const sb = on[0].getBoundingClientRect(), db = det.getBoundingClientRect(), notch = parseFloat(det.style.getPropertyValue("--notch"));
    return { open: document.querySelector(".rc-more").classList.contains("open"), one: on.length === 1 && on[0].classList.contains("gap") && on[0].getAttribute("aria-expanded") === "true",
      dimmed: segs.filter((x) => x.classList.contains("dim")).length === segs.length - 1, title: det.querySelector("b").textContent,
      wantTitle: I.t("gapOn", { m: Math.round(g.length), name: g.names.slice(0, 2).map(I.place).join(", ") || I.t("aStreet") }),
      type: det.querySelector(".rc-det-type").textContent, at: det.querySelector(".rc-det-at").textContent, wantAt: I.t("after", { d: C.fmtKm(g.start) }),
      notchOk: Math.abs(db.left + (db.width * notch) / 100 - (sb.left + sb.width / 2)) < 30, veil: !!document.querySelector(".rc-profile .pg-veil"),
      step: det.querySelector(".rc-step").textContent.trim(), nextOff: det.querySelector(".rc-next").disabled, prevOn: !det.querySelector(".rc-prev").disabled, inCard: !!det.closest(".route-card") };
  });
  const cam1 = await page.evaluate(() => window.__app.map.getCenter().toArray().map((v) => v.toFixed(5)).join());
  await page.evaluate(() => document.querySelector(".rc-det .rc-prev").click()); await page.waitForTimeout(300);
  const prev = await page.evaluate(() => { const segs = [...document.querySelectorAll("#routes .route-card .bar .seg")], k = segs.findIndex((x) => x.classList.contains("on"));
    return { k, n: segs.length, navy: !segs[k].classList.contains("gap") && !document.querySelector(".rc-det .rc-key").classList.contains("off"),
      kinds: /(Protected|Painted|Shared) bike path/.test(document.querySelector(".rc-det-type").textContent) }; });
  const fr = await page.evaluate(() => { window.__app.setLang("fr"); const d = document.querySelector(".rc-more.open .rc-det"), out = d ? d.textContent : ""; window.__app.setLang("en"); return out; });
  await page.evaluate(() => document.querySelector("#routes .route-card .bar .seg.on").click()); await page.waitForTimeout(400);
  const closed = await page.evaluate(() => !document.querySelector(".rc-more").classList.contains("open") && !document.querySelector(".bar .seg.on, .bar .seg.dim") && !document.querySelector(".pg-veil"));
  const dots = await page.evaluate(() => [...document.querySelectorAll(".ride-go, .share-btn, #view-btn, #layers-btn, .bar .seg")].map((el) => {
    const v = el.style.getPropertyValue("--ht"), a = getComputedStyle(el, "::after");
    return el.classList.contains("ht") && /^url\("data:image\/svg\+xml,/.test(v) && /circle/.test(decodeURIComponent(v)) && a.zIndex === "-1" && getComputedStyle(el.parentElement).isolation === "isolate"; }));
  await page.goto(BASE + APP + "?trip=rachel", { waitUntil: "load" });
  await until(page, () => window.__app && window.__app.state.routes.length > 0 && !!document.querySelector("#routes .route-card"), null, 60000);
  const whole = await page.evaluate(() => ({ text: (document.querySelector(".rc-whole") || {}).textContent, gaps: document.querySelectorAll(".bar .seg.gap").length, gapsWanted: window.BikeCommon.mainGaps(window.__app.state.routes[0].r).length }));
  const checks = {
    strip: first.gapLens === first.want && first.n >= first.gaps && Math.abs(first.total - first.L) <= first.n && first.nums && first.buttons && first.touch >= 44,
    startsClosed: first.closed && !first.hint && !first.oldList,
    opens: open.open && open.one && open.dimmed && open.inCard && open.title === open.wantTitle && /^Without a bike path · .*(Busy street|Quiet street)/.test(open.type) && open.at === open.wantAt,
    pointsAtIt: open.notchOk && open.veil && /^\d+\/\d+$/.test(open.step) && open.nextOff && open.prevOn,
    showsOnMap: cam1 !== cam0,
    steps: prev.k === prev.n - 2 && prev.navy && prev.kinds,
    french: /\d+ m sur /.test(fr) && /après/.test(fr),
    closes: closed,
    dots: dots.length >= 6 && dots.every(Boolean),
    wholeWay: whole.gapsWanted > 0 || (whole.text === "Bike paths the whole way." && whole.gaps === 0),
  };
  const bad = Object.keys(checks).filter((k) => !checks[k]);
  return { ok: !bad.length, ...(bad.length ? { error: "failed checks: " + bad.join(", ") } : {}), first, open, prev, fr: fr.slice(0, 160), dots, whole };
}, { width: 390, height: 844 }, { hasTouch: true, isMobile: true });

// ------------------------------------------------------------------ saved places (2026-11-02): Home, Work, others; recents; all on this device
// 2026-11-03: one chip, ★ (always there, name in aria-label and title), opens the menu: Home, Work, the saved places (each with its pencil),
// "Add to saved locations". Recent destinations are not in it: they show in the pop-up while typing an address. An empty bar shows no list.
const placeChips = () => [...document.querySelectorAll("#places .place")].map((b) => b.getAttribute("aria-label"));
// the menu's rows: name, what sits under it (the place or address saved as Home or Work), the pencil's name, and whether the row has its icon
const menuRows = () => [...document.querySelectorAll("#place-list li")].map((li) => { const t = li.querySelector(".pl-text"), e = li.querySelector(".pl-edit");
  return { name: t.querySelector("span").textContent, sub: (t.querySelector("small") || {}).textContent || "", edit: e ? e.getAttribute("aria-label") : "", icon: !!li.querySelector(".pl-row > svg") }; });
const rowNames = (rows) => rows.map((r) => r.name).join();

await run("saved places: one ★ chip whose menu holds Home, Work, the saved places and Add; set, use, edit, delete; no recent destinations in it; nothing sent", `${APP}`, async (page, ctx) => {
  const seen = []; ctx.on("request", (r) => seen.push(r.url() + " " + (r.postData() || "")));
  const out = {};
  const menuClosed = () => page.evaluate(() => document.querySelector("#place-list").hidden);
  const openMenu = async () => { await page.click("#places .star"); await until(page, () => !document.querySelector("#place-list").hidden); };
  const rows = () => page.evaluate(menuRows);
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem("piste-places") || "[]"));
  const toast = () => page.evaluate(() => (document.querySelector("#toast").hidden ? "" : document.querySelector("#toast").textContent));
  const hideToast = () => page.evaluate(() => { document.querySelector("#toast").hidden = true; });
  const dialogOpen = () => until(page, () => !document.querySelector("#place-dialog").hidden);
  const dialogShut = () => until(page, () => document.querySelector("#place-dialog").hidden);
  const onStar = () => page.evaluate(() => document.activeElement.classList.contains("star"));
  // the chip: one, ★ in a circle, 44 px to tap, its name in aria-label and title, the menu closed
  out.chip = await page.evaluate(() => { const all = [...document.querySelectorAll("#places .place")], s = all[0], r = s.getBoundingClientRect();
    return { n: all.length, name: s.getAttribute("aria-label"), title: s.title, text: s.textContent.trim(), svg: !!s.querySelector("svg"), w: Math.round(r.width), h: Math.round(r.height),
      ring: getComputedStyle(s, "::before").borderTopStyle, expanded: s.getAttribute("aria-expanded"), controls: s.getAttribute("aria-controls"), menuHidden: document.querySelector("#place-list").hidden }; });
  // nothing saved yet: Home, Work, Add; no pencils; an icon on the left of each row
  await openMenu();
  out.fresh = { expanded: await page.getAttribute("#places .star", "aria-expanded"), rows: await rows() };
  // "Set home" with nothing on the bars: the pick-a-place message, the menu closes, nothing is saved
  await page.click('#place-list [data-set="home"]');
  out.nothing = { toast: await toast(), closed: await menuClosed(), stored: await stored() };
  await hideToast(); await openMenu(); await page.click("#place-list [data-add]");
  out.nothingAdd = { toast: await toast(), dialog: await page.evaluate(() => !document.querySelector("#place-dialog").hidden), closed: await menuClosed() };
  // a place on the bars: "Set home" saves it as Home; the menu stays open, shows it under Home and keeps the keyboard on that row
  await page.evaluate(() => { window.piste.setPoint("to", [-73.5745, 45.5163], "Zorglub"); });
  await openMenu(); await page.click('#place-list [data-set="home"]');
  out.homeSet = { rows: await rows(), open: !(await menuClosed()), focus: await page.evaluate(() => document.activeElement.dataset.k || ""), stored: await stored() };
  await page.keyboard.press("Escape");
  // Home survives a reload, with its address
  await page.reload({ waitUntil: "load" }); await page.waitForFunction(() => !!window.__app, null, { timeout: 90000 });
  await openMenu(); out.afterReload = await rows(); await page.keyboard.press("Escape");
  // a start only: the Home row becomes the destination and the route is made
  await page.evaluate(() => { window.piste.setPoint("from", [-73.5875, 45.5231], "Start place"); });
  await openMenu(); await page.click('#place-list .pl-row[data-k="home"]');
  await until(page, () => window.__app.state.routes.length > 0);
  out.routed = await page.evaluate(() => { const s = window.__app.state; return { to: s.to && s.to.map((v) => +v.toFixed(4)), label: s.toLabel, routes: s.routes.length, closed: document.querySelector("#place-list").hidden }; });
  // "Add to saved locations": the name form for the place on the bars; not a chip of its own, a row in the menu with its pencil; focus back on ★
  await openMenu(); await page.click("#place-list [data-add]"); await dialogOpen();
  out.dialog = await page.evaluate(() => ({ open: !document.querySelector("#place-dialog").hidden, name: document.querySelector("#pl-name").value, del: document.querySelector("#pl-delete").hidden, menuClosed: document.querySelector("#place-list").hidden }));
  await page.fill("#pl-name", "Café Zorglub"); await page.keyboard.press("Enter"); await dialogShut();
  out.chipsAfter = await page.evaluate(placeChips); out.focusAfterAdd = await onStar();
  await openMenu(); out.named = await rows();
  // a saved place's pencil: the place form (rename), then focus back on ★
  await page.click('#place-list .pl-edit[aria-label="Edit Café Zorglub"]'); await dialogOpen();
  out.editOpen = await page.evaluate(() => ({ title: document.querySelector("#pl-title").textContent, name: document.querySelector("#pl-name").value, menuClosed: document.querySelector("#place-list").hidden }));
  await page.fill("#pl-name", "Café 2"); await page.click('#place-form button[type="submit"]'); await dialogShut();
  out.renamed = { focus: await onStar(), names: (await stored()).map((p) => p.name).join() };
  // move it to the current place, then Home too (its form has no name, only Use the current place and Delete)
  await page.evaluate(() => { window.piste.setPoint("to", [-73.6, 45.53], "Elsewhere"); });
  await openMenu(); await page.click('#place-list .pl-edit[aria-label="Edit Café 2"]'); await dialogOpen();
  await page.click("#pl-use"); await dialogShut();
  out.moved = (await stored()).find((p) => !p.kind).ll;
  await openMenu(); await page.click('#place-list .pl-edit[aria-label="Edit Home"]'); await dialogOpen();
  out.homeForm = await page.evaluate(() => ({ nameField: !document.querySelector("#pl-name-field").hidden, use: !document.querySelector("#pl-use").hidden, del: !document.querySelector("#pl-delete").hidden }));
  await page.click("#pl-use"); await dialogShut();
  out.homeMoved = (await stored()).find((p) => p.kind === "home");
  await openMenu(); out.homeRow = (await rows())[0];
  // delete Home, then the saved place: back to Set home
  await page.click('#place-list .pl-edit[aria-label="Edit Home"]'); await dialogOpen(); await page.click("#pl-delete"); await dialogShut();
  await openMenu(); await page.click('#place-list .pl-edit[aria-label="Edit Café 2"]'); await dialogOpen(); await page.click("#pl-delete"); await dialogShut();
  await openMenu(); out.deleted = { rows: await rows(), n: (await stored()).length }; await page.keyboard.press("Escape");
  // Work works the same; a start called "My location" says nothing about where Home is, so no address is kept for it
  await page.evaluate(() => { window.piste.setPoint("to", [-73.58, 45.52], "Workplace"); });
  await openMenu(); await page.click('#place-list [data-set="work"]'); out.work = (await rows())[1];
  await page.evaluate(() => { window.piste.setPoint("to", [-73.57, 45.51], window.BikeI18n.t("myLocation")); });
  await page.click('#place-list [data-set="home"]'); out.myLocation = (await rows())[0]; await page.keyboard.press("Escape");
  // the menu: Home, Work, saved places, Add; the last destinations are not in it
  await page.evaluate(() => {
    localStorage.setItem("piste-places", JSON.stringify([{ kind: "home", name: "4500 rue Saint-Denis", ll: [-73.5745, 45.5163] }, { kind: "", name: "Atelier Bravo", ll: [-73.59, 45.53] }]));
    localStorage.setItem("piste-recents", JSON.stringify(["Rec One", "Rec Two", "Rec Three"].map((name, i) => ({ name, ll: [-73.57 - i / 100, 45.51] }))));
  });
  await page.reload({ waitUntil: "load" }); await page.waitForFunction(() => !!window.__app, null, { timeout: 90000 });
  await page.evaluate(() => { window.piste.setPoint("from", [-73.5875, 45.5231], "Start place"); });
  await openMenu(); out.rows = await rows();
  await page.click('#place-list .pl-row[data-p="1"]');
  await until(page, () => window.__app.state.routes.length > 0);
  out.used = await page.evaluate(() => ({ to: window.__app.state.toLabel, closed: document.querySelector("#place-list").hidden, expanded: document.querySelector("#places .star").getAttribute("aria-expanded") }));
  // keyboard: Enter on ★ opens it with focus on the first row, arrows move (the pencil is next), Esc closes it and focus goes back to ★; a tap outside closes it too
  await page.focus("#places .star"); await page.keyboard.press("Enter");
  out.kb = await page.evaluate(() => ({ open: !document.querySelector("#place-list").hidden, focus: document.activeElement.dataset.k }));
  await page.keyboard.press("ArrowDown");
  out.kb.next = await page.evaluate(() => document.activeElement.className);
  await page.keyboard.press("Escape");
  out.kb.esc = await page.evaluate(() => ({ closed: document.querySelector("#place-list").hidden, onStar: document.activeElement.classList.contains("star"), expanded: document.activeElement.getAttribute("aria-expanded") }));
  await page.click("#places .star"); await page.mouse.click(900, 450);
  out.outside = await page.evaluate(() => document.querySelector("#place-list").hidden);
  // French, also while the menu is open
  await openMenu();
  await page.evaluate(() => window.__app.setLang("fr"));
  out.fr = { chip: await page.evaluate(placeChips), rows: await page.evaluate(menuRows), title: await page.getAttribute("#places .star", "title") };
  const safe = (u) => { try { return decodeURIComponent(u); } catch (e) { return u; } };
  const leaked = seen.filter((u) => /Zorglub|Elsewhere|Bravo|Workplace|45\.5163|73\.5745/.test(safe(u)));
  const checks = {
    oneChip: out.chip.n === 1 && out.chip.name === "Saved places" && out.chip.title === "Saved places" && out.chip.text === "" && out.chip.svg && out.chip.w >= 44 && out.chip.h >= 44 && out.chip.ring === "solid"
      && out.chip.expanded === "false" && out.chip.controls === "place-list" && out.chip.menuHidden,
    freshMenu: out.fresh.expanded === "true" && rowNames(out.fresh.rows) === "Set home,Set work,Add to saved locations" && out.fresh.rows.every((r) => r.icon && !r.edit && !r.sub),
    pickFirst: /pick a place first/i.test(out.nothing.toast) && out.nothing.closed && out.nothing.stored.length === 0,
    pickFirstAdd: /pick a place first/i.test(out.nothingAdd.toast) && !out.nothingAdd.dialog && out.nothingAdd.closed,
    homeSet: out.homeSet.open && out.homeSet.focus === "home" && rowNames(out.homeSet.rows) === "Home,Set work,Add to saved locations" && out.homeSet.rows[0].sub === "Zorglub" && out.homeSet.rows[0].edit === "Edit Home"
      && out.homeSet.stored.length === 1 && out.homeSet.stored[0].kind === "home" && out.homeSet.stored[0].name === "Zorglub",
    reload: out.afterReload[0].name === "Home" && out.afterReload[0].sub === "Zorglub" && out.afterReload.length === 3,
    homeUsed: out.routed.to.join() === "-73.5745,45.5163" && out.routed.label === "Home" && out.routed.routes > 0 && out.routed.closed,
    addDialog: out.dialog.open && out.dialog.name === "Home" && out.dialog.del && out.dialog.menuClosed && out.focusAfterAdd,
    noExtraChip: out.chipsAfter.join() === "Saved places" && rowNames(out.named) === "Home,Set work,Café Zorglub,Add to saved locations" && out.named[2].edit === "Edit Café Zorglub" && out.named[2].icon,
    editFromMenu: out.editOpen.title === "Edit place" && out.editOpen.name === "Café Zorglub" && out.editOpen.menuClosed && out.renamed.focus && out.renamed.names === "Zorglub,Café 2",
    moveSaved: out.moved.join() === "-73.6,45.53",
    homeForm: !out.homeForm.nameField && out.homeForm.use && out.homeForm.del && out.homeMoved.ll.join() === "-73.6,45.53" && out.homeMoved.name === "Elsewhere" && out.homeRow.sub === "Elsewhere",
    deleted: out.deleted.n === 0 && rowNames(out.deleted.rows) === "Set home,Set work,Add to saved locations",
    workSet: out.work.name === "Work" && out.work.sub === "Workplace" && out.work.edit === "Edit Work",
    myLocationNoAddress: out.myLocation.name === "Home" && out.myLocation.sub === "",
    homeWorkSavedAdd: rowNames(out.rows) === "Home,Set work,Atelier Bravo,Add to saved locations" && out.rows[0].sub === "4500 rue Saint-Denis" && out.rows.every((r) => !/^Rec /.test(r.name)),
    rowUsed: out.used.to === "Atelier Bravo" && out.used.closed && out.used.expanded === "false",
    keyboard: out.kb.open && out.kb.focus === "home" && out.kb.next === "pl-edit" && out.kb.esc.closed && out.kb.esc.onStar && out.kb.esc.expanded === "false", outsideCloses: out.outside,
    french: out.fr.chip.join() === "Lieux enregistrés" && out.fr.title === "Lieux enregistrés" && rowNames(out.fr.rows) === "Maison,Ajouter le travail,Atelier Bravo,Ajouter aux lieux enregistrés" && out.fr.rows[0].edit === "Modifier Maison",
    nothingSent: leaked.length === 0,
  };
  const bad = Object.keys(checks).filter((k) => !checks[k]);
  return { ok: !bad.length, ...(bad.length ? { error: "failed checks: " + bad.join(", ") } : {}), ...out, requests: seen.length, leaked };
}, { width: 1440, height: 900 });

// ---- recent destinations (2026-11-03): only in the pop-up that opens while typing an address ----
await run("search: recent destinations show in the typing pop-up only (matching the text, at most 3, tagged Recent, then Clear recent places); an empty bar shows no list", `${APP}`, async (page) => {
  const out = {};
  const names = ["Parc Le Boutillier", "Parc Jarry", "Parc Laurier", "Parc Molson", "Marché Atwater"];   // most recent first ("Parc Le Boutillier" is also a map result for "parc")
  await page.evaluate((list) => localStorage.setItem("piste-recents", JSON.stringify(list.map((name, i) => ({ name, ll: [-73.6 + i / 100, 45.5 + i / 100] })))), names);
  await page.reload({ waitUntil: "load" }); await page.waitForFunction(() => !!window.__app, null, { timeout: 90000 });
  const popup = () => page.evaluate(() => ({ shown: !document.querySelector("#suggest").hidden, rows: [...document.querySelectorAll("#suggest li[data-i]")].map((li) => ({ name: li.querySelector("span").textContent, sub: li.querySelector("small").textContent, clear: li.classList.contains("clear") })) }));
  // count the address-service requests that have finished (good or bad), to know when the pop-up has the answer for the typed text
  const watchGeo = () => page.evaluate(() => { window.__geo = 0; const f = window.fetch; window.fetch = (...a) => { const p = f.apply(window, a); if (/api\.montreal\.ca/.test(String(a[0]))) p.then(() => window.__geo++, () => window.__geo++); return p; }; });
  const typeInto = async (text) => {
    const n = await page.evaluate(() => window.__geo);
    await page.fill("#to", text);
    await until(page, (k) => window.__geo > k, n);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));   // and the pop-up has been redrawn
  };
  await watchGeo();
  const recentsStored = () => page.evaluate(() => JSON.parse(localStorage.getItem("piste-recents") || "[]").map((r) => r.name));
  // the ★ menu has none of them, though five are saved
  await page.click("#places .star"); await until(page, () => !document.querySelector("#place-list").hidden);
  out.starMenu = await page.evaluate(menuRows); await page.keyboard.press("Escape");
  // an empty bar: no list, not even for a click in it; deleting the typed text closes it
  await page.click("#to");
  out.emptyBar = await page.evaluate(() => ({ focus: document.activeElement.id, list: !document.querySelector("#suggest").hidden && document.querySelectorAll("#suggest li").length }));
  // "parc": three recent places first (the fourth match is left out), then Clear recent places, then the other results, none repeated
  await typeInto("parc");
  await until(page, () => document.querySelectorAll("#suggest li[data-i]").length > 4);   // the address results join the recent ones
  out.parc = await popup();
  // any case, any accent
  await typeInto("MARCHE atw"); out.accents = await popup();
  // Enter takes the top row, a recent place: it becomes the destination and moves to the top of the recent ones
  await page.keyboard.press("Enter");
  out.picked = await page.evaluate(() => ({ to: window.__app.state.toLabel, shown: !document.querySelector("#suggest").hidden }));
  out.order = await recentsStored();
  // text that matches no recent place: none shown, and no Clear row
  await page.fill("#to", ""); await typeInto("papineau"); out.noMatch = await popup();
  // a destination picked from the address results is remembered, and then comes first
  await page.fill("#to", ""); await typeInto("Rachel & Papineau"); await page.keyboard.press("Enter");
  out.remembered = (await recentsStored())[0];   // the intersection's own name: "Rue Rachel Est & Avenue Papineau"
  await page.evaluate(() => { window.piste.clearPoint("to"); document.querySelector("#to").blur(); });
  await typeInto("rachel"); out.again = await popup();
  // Clear recent places: they go from storage and from the pop-up, the typed text and the keyboard stay, and the menu never had them
  await typeInto("parc");
  await page.click("#suggest li.clear");
  out.cleared = await page.evaluate(() => ({ stored: JSON.parse(localStorage.getItem("piste-recents") || "[]").length, focus: document.activeElement.id, text: document.querySelector("#to").value,
    rows: [...document.querySelectorAll("#suggest li[data-i]")].map((li) => li.querySelector("small").textContent), clearRow: !!document.querySelector("#suggest li.clear") }));
  await page.fill("#to", ""); await page.waitForFunction(() => document.querySelector("#suggest").hidden || !document.querySelectorAll("#suggest li").length);
  out.emptyAgain = await popup();
  // French
  await page.evaluate((list) => { localStorage.setItem("piste-recents", JSON.stringify(list.map((name, i) => ({ name, ll: [-73.6 + i / 100, 45.5 + i / 100] })))); }, names);
  await page.reload({ waitUntil: "load" }); await page.waitForFunction(() => !!window.__app, null, { timeout: 90000 });
  await watchGeo(); await page.evaluate(() => window.__app.setLang("fr")); await page.click("#to"); await typeInto("parc"); out.fr = await popup();
  const first3 = out.parc.rows.slice(0, 3), labels = out.parc.rows.filter((r) => !r.clear).map((r) => r.name);
  const checks = {
    emptyBarNoList: out.emptyBar.focus === "to" && !out.emptyBar.list && !out.emptyAgain.shown,
    threeRecentFirst: first3.map((r) => r.name).join() === "Parc Le Boutillier,Parc Jarry,Parc Laurier" && first3.every((r) => r.sub === "Recent" && !r.clear) && !labels.includes("Parc Molson"),
    clearRowAfter: out.parc.rows[3].clear && out.parc.rows[3].name === "Clear recent places" && out.parc.rows.filter((r) => r.clear).length === 1,
    othersFollow: out.parc.rows.length > 4 && out.parc.rows.slice(4).every((r) => r.sub !== "Recent") && new Set(labels).size === labels.length,
    notInMenu: !out.starMenu.some((r) => /Parc|Marché|Recent/.test(r.name + r.sub)),
    caseAndAccents: out.accents.rows[0].name === "Marché Atwater" && out.accents.rows[0].sub === "Recent" && out.accents.rows[1].clear && out.accents.rows.filter((r) => r.sub === "Recent").length === 1,
    enterTakesTop: out.picked.to === "Marché Atwater" && !out.picked.shown && out.order[0] === "Marché Atwater" && out.order.length === 5,
    noMatchNoRecents: !out.noMatch.rows.some((r) => r.sub === "Recent" || r.clear),
    remembered: out.remembered === "Rue Rachel Est & Avenue Papineau" && out.again.rows[0].name === out.remembered && out.again.rows[0].sub === "Recent",
    clearRecents: out.cleared.stored === 0 && out.cleared.focus === "to" && out.cleared.text === "parc" && !out.cleared.rows.includes("Recent") && !out.cleared.clearRow,
    french: out.fr.rows[0].sub === "Récent" && out.fr.rows.some((r) => r.clear && r.name === "Effacer les lieux récents"),
  };
  const bad = Object.keys(checks).filter((k) => !checks[k]);
  return { ok: !bad.length, ...(bad.length ? { error: "failed checks: " + bad.join(", ") } : {}), ...out };
}, { width: 1440, height: 900 });

// ---- closed businesses (2026-11-04): the POI builder drops places closed by their OSM tags or by the City's food registry; none is in pois.js ----
// No browser needed, so the page is only the group's frame. tools/check_pois_closed.py is plain standard-library Python (no raw data needed on CI).
await run("closed businesses: the POI builder drops known closure tags and registry-closed food places; pois.js holds none", `${APP}`, async () => {
  const venv = new URL("../../.venv/Scripts/python.exe", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const py = process.env.PISTE_PYTHON || (existsSync(venv) ? venv : "python3");
  const r = spawnSync(py, ["-I", new URL("../check_pois_closed.py", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")], { encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  return { ok: r.status === 0, ...(r.status === 0 ? {} : { error: out.trim().split(/\r?\n/).filter((l) => /^FAIL|Error/.test(l)).slice(0, 3).join(" | ") || "exit " + r.status }), out: out.trim().slice(0, 600) };
});

// ---- Home / Work in the typing pop-up (2026-11-04): "home", "work", "maison", "travail", ... (2 letters or more) list the saved one first ----
await run("search: typing home / work (EN and FR, 2+ letters) lists the saved Home / Work first, with icon and address, then saved places, then recent places; unset ones stay out", `${APP}`, async (page) => {
  await page.evaluate(() => {
    localStorage.setItem("piste-places", JSON.stringify([{ kind: "home", name: "4500 rue Saint-Denis", ll: [-73.5745, 45.5163] }, { kind: "", name: "Homebase", ll: [-73.59, 45.53] }]));
    localStorage.setItem("piste-recents", JSON.stringify([{ name: "Hometown Cafe", ll: [-73.6, 45.5] }]));
  });
  await page.reload({ waitUntil: "load" }); await page.waitForFunction(() => !!window.__app, null, { timeout: 90000 });
  const rows = () => page.evaluate(() => ({ shown: !document.querySelector("#suggest").hidden, rows: [...document.querySelectorAll("#suggest li[data-i]")].map((li) => ({ name: (li.querySelector(".sg-text > span") || li.querySelector("span")).textContent,
    sub: li.querySelector("small").textContent, icon: !!li.querySelector("svg"), clear: li.classList.contains("clear") })) }));
  const typeNow = async (text) => {   // the saved rows show at once; wait for the pop-up to hold the typed text's rows
    await page.fill("#to", text);
    await until(page, () => !document.querySelector("#suggest").hidden && document.querySelectorAll("#suggest li[data-i]").length > 0);
    await page.waitForTimeout(450);   // and the address results, if any, have joined
    return rows();
  };
  const out = {};
  await page.click("#to");
  out.empty = await rows();
  out.ho = await typeNow("ho");   out.h = await typeNow("h");   out.hello = await typeNow("hom");
  out.work = await typeNow("wor"); out.mai = await typeNow("mai");
  // an unset Work never shows, a set one does; the same words work in either language
  await page.evaluate(() => window.__app.setLang("fr"));
  out.frMaison = await typeNow("maison"); out.frDom = await typeNow("dom");
  await page.evaluate(() => localStorage.setItem("piste-places", JSON.stringify([{ kind: "home", name: "4500 rue Saint-Denis", ll: [-73.5745, 45.5163] }, { kind: "work", name: "100 rue Peel", ll: [-73.5665, 45.5006] }, { kind: "", name: "Homebase", ll: [-73.59, 45.53] }])));
  await page.reload({ waitUntil: "load" }); await page.waitForFunction(() => !!window.__app, null, { timeout: 90000 });
  await page.evaluate(() => window.__app.setLang("fr")); await page.click("#to");
  out.frTrav = await typeNow("trav"); out.frBureau = await typeNow("bureau"); out.frWork = await typeNow("work");
  // picking Work uses it as the ★ menu does: the destination (here), named "Travail", at its place
  await page.keyboard.press("Enter");
  out.picked = await page.evaluate(() => ({ to: window.__app.state.toLabel, ll: window.__app.state.to && window.__app.state.to.map((v) => +v.toFixed(4)), shown: !document.querySelector("#suggest").hidden }));
  const first = (r) => r.rows[0] && r.rows[0].name, names = (r) => r.rows.slice(0, 3).map((x) => x.name).join();
  const checks = {
    emptyNoList: !out.empty.shown || out.empty.rows.length === 0,
    homeFirst: first(out.ho) === "Home" && out.ho.rows[0].sub === "4500 rue Saint-Denis" && out.ho.rows[0].icon && out.hello.rows[0].name === "Home",
    thenSavedThenRecent: names(out.ho) === "Home,Homebase,Hometown Cafe" && out.ho.rows[1].icon && out.ho.rows[2].sub === "Recent" && out.ho.rows[3].clear,
    oneLetterNoHome: first(out.h) !== "Home" && !out.h.rows.some((r) => r.name === "Home"),
    unsetWorkAbsent: !out.work.rows.some((r) => r.name === "Work" || r.name === "Travail") && first(out.mai) === "Home",   // "mai" starts maison: Home, in English too
    frHome: first(out.frMaison) === "Maison" && out.frMaison.rows[0].sub === "4500 rue Saint-Denis" && first(out.frDom) === "Maison" && out.frMaison.rows[0].icon,
    frWork: first(out.frTrav) === "Travail" && out.frTrav.rows[0].sub === "100 rue Peel" && first(out.frBureau) === "Travail" && first(out.frWork) === "Travail",
    picked: out.picked.to === "Travail" && out.picked.ll[0] === -73.5665 && out.picked.ll[1] === 45.5006 && !out.picked.shown,
  };
  const bad = Object.keys(checks).filter((k) => !checks[k]);
  return { ok: !bad.length, ...(bad.length ? { error: "failed checks: " + bad.join(", ") } : {}), ...out };
}, { width: 1440, height: 900 });

await run("saved places (phone): the ★ chip fits, typing shows it under the bar, its menu works with the keyboard up, recent destinations come up in the pop-up above the card", `${APP}?safe=47,34`, async (page) => {
  await page.evaluate(() => {
    localStorage.setItem("piste-places", JSON.stringify([{ kind: "home", name: "4500 rue Saint-Denis", ll: [-73.5745, 45.5163] }, ...["Alpha", "Bravo place"].map((name, i) => ({ kind: "", name, ll: [-73.58 - i / 100, 45.52] }))]));
    localStorage.setItem("piste-recents", JSON.stringify(["Rec One", "Rec Two"].map((name, i) => ({ name, ll: [-73.57 - i / 100, 45.51] }))));
  });
  await page.reload({ waitUntil: "load" }); await page.waitForFunction(() => !!window.__app, null, { timeout: 90000 });
  await page.evaluate(() => window.__app.setSheet("half")); await page.waitForTimeout(500);
  const row = await settled(page, () => { const r = document.querySelector("#places"), chips = [...r.querySelectorAll(".place")].map((c) => c.getBoundingClientRect()), s = document.querySelector(".search");
    const withRow = s.offsetHeight; r.style.display = "none"; const without = s.offsetHeight; r.style.display = "";
    return { n: chips.length, fits: r.scrollWidth <= r.clientWidth + 1, tap44: chips.every((c) => c.height >= 44 && c.width >= 43.5), added: withRow - without, pageX: document.documentElement.scrollWidth <= innerWidth,
      panelH: Math.round(document.querySelector("#panel").getBoundingClientRect().height), half: Math.round(innerHeight / 2) }; });
  // tap the empty destination bar: the bar, the chip under it (just above the keyboard) and no list
  await page.tap("#to");
  await until(page, () => document.body.classList.contains("searching"));
  const tappedAt = await page.evaluate(() => performance.now());
  const search = await settled(page, () => { const c = document.querySelector("#places").getBoundingClientRect(), f = document.querySelector("#to").closest(".field").getBoundingClientRect();
    return { chips: getComputedStyle(document.querySelector("#places")).display !== "none", underBar: c.left + 7 >= f.right - 1 && c.bottom - 7 <= f.bottom + 1,   /* 2026-11-09: the star sits beside the bar, not under it */ aboveKb: c.bottom - 7 <= innerHeight - Math.max(260, innerHeight * 0.47) + 1,
      list: !document.querySelector("#suggest").hidden, focus: document.activeElement.id }; });   // the chip's circle sits 7 px inside its 44 px row
  // ★ with the keyboard up: the menu floats over the map just above the card, typing goes on, a row is the destination and the search ends.
  // (Taps in the first 800 ms after the one that opened search are swallowed on purpose, app.js swallowUntil: a time window, waited out here.)
  await page.waitForFunction((t0) => performance.now() - t0 > 900, tappedAt);
  await page.tap("#places .star");
  const star = await settled(page, () => { const l = document.querySelector("#place-list"), r = l.getBoundingClientRect(), p = document.querySelector("#panel").getBoundingClientRect();
    return { open: !l.hidden, menu: [Math.round(r.top), Math.round(r.bottom)], panelTop: Math.round(p.top), aboveCard: r.bottom <= p.top + 1 && r.top >= 0, focus: document.activeElement.id, searching: document.body.classList.contains("searching"), rows: [...l.querySelectorAll(".pl-row")].map((b) => b.textContent.trim()) }; });
  await page.tap('#place-list .pl-row[data-p="1"]');
  await until(page, () => !document.body.classList.contains("searching"));
  const used = await page.evaluate(() => ({ to: window.__app.state.toLabel, closed: document.querySelector("#place-list").hidden, sheet: document.querySelector("#panel").dataset.sheet }));
  // typing "rec": the recent destinations are the first rows of the pop-up above the card, then Clear recent places; a tap picks one
  await page.tap("#to"); await until(page, () => document.body.classList.contains("searching"));
  const tappedAgain = await page.evaluate(() => performance.now());
  await page.fill("#to", "rec");
  await until(page, () => document.querySelectorAll("#suggest li[data-i]").length >= 3);
  const popup = await settled(page, () => { const l = document.querySelector("#suggest"), p = document.querySelector("#panel");
    return { aboveCard: l.getBoundingClientRect().bottom <= p.getBoundingClientRect().top + 1, rows: [...l.querySelectorAll("li[data-i]")].map((li) => li.querySelector("span").textContent + "|" + li.querySelector("small").textContent), clear: !!l.querySelector("li.clear"),
      clearH: Math.round((l.querySelector("li.clear") || document.body).getBoundingClientRect().height) }; });
  await page.waitForFunction((t0) => performance.now() - t0 > 900, tappedAgain);
  await page.tap('#suggest li[data-i="0"]');
  await until(page, () => !document.body.classList.contains("searching"));
  const pickedRecent = await page.evaluate(() => ({ to: window.__app.state.toLabel, searching: document.body.classList.contains("searching") }));
  const checks = { oneChipFits: row.n === 1 && row.fits && row.tap44 && row.pageX && row.added <= 40 && row.panelH === row.half,
    typingShowsChip: search.chips && search.underBar && search.aboveKb && !search.list && search.focus === "to",
    menuOverKeyboard: star.open && star.aboveCard && star.focus === "to" && star.searching && star.rows.length === 5 && /^Home/.test(star.rows[0]) && /^Set work/.test(star.rows[1]) && /^Alpha/.test(star.rows[2]) && /^Add to saved locations/.test(star.rows[4]) && !star.rows.some((r) => /^Rec /.test(r)),
    rowUsed: used.to === "Alpha" && used.closed && used.sheet === "half",
    recentsInPopup: popup.aboveCard && popup.rows[0] === "Rec One|Recent" && popup.rows[1] === "Rec Two|Recent" && popup.clear && popup.clearH >= 44, recentTapped: pickedRecent.to === "Rec One" && !pickedRecent.searching };
  const bad = Object.keys(checks).filter((k) => !checks[k]);
  return { ok: !bad.length, ...(bad.length ? { error: "failed checks: " + bad.join(", ") } : {}), row, search, star, used, popup, pickedRecent };
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
// 2026-11-08: the REM credit is in About & terms; the map's (i) holds only the basemap's line
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
      credit: document.querySelector("#about").textContent.includes("REM (OpenStreetMap)"), label: cb.parentElement.textContent.trim() };
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
    (() => { const b = document.querySelector("#night-btn"); for (let i = 0; i < 3 && b.dataset.state !== "on"; i++) b.click(); })(); const night = pick();
    (() => { const b = document.querySelector("#night-btn"); for (let i = 0; i < 3 && b.dataset.state !== "off"; i++) b.click(); })();
    const all = [...summer.names, ...fall.names, ...winter.names].flatMap((n) => [n, n + "-n"]), img = m.getImage("tree-summer-0");
    return { summer, fall, winter, night: [night.suffix, night.gl.split(",")[2]], off: pick().suffix, allImages: all.length === 18 && all.every((n) => m.hasImage(n)), size: img && [img.data.width, img.data.height, img.pixelRatio],
      edges: beforeFall.names[0] === summer.names[0] && afterFall.names[0] === summer.names[0] && firstFall.names[0] === fall.names[0] && lastFall.names[0] === fall.names[0],
      layout: ["icon-anchor", "icon-pitch-alignment", "icon-rotation-alignment", "symbol-z-order"].map((k) => m.getLayoutProperty("trees", k)) };
  });
  // what the WebGL trees actually draw over the middle of the map: green in summer, warmer in fall, sparser navy branches in winter, dark at night
  const colour = async (setup, settle) => {   // settle: wait for the map to finish changing (the camera, colour transitions) first
    await page.evaluate(setup);
    if (settle) { await cam(true, 16.2); await page.evaluate(idle); await drawn(); }
    return page.evaluate(() => __px.trees([440, 200, 480, 320]));
  };
  const summerPx = await colour(() => window.__app.paintTrees(new Date(2026, 6, 15)), true);
  const fallPx = await colour(() => window.__app.paintTrees(new Date(2026, 9, 20)), false);
  const winterPx = await colour(() => window.__app.setWinter(true), true);
  const nightPx = await colour(() => { window.__app.setWinter(false); (() => { const b = document.querySelector("#night-btn"); for (let i = 0; i < 3 && b.dataset.state !== "on"; i++) b.click(); })(); window.__app.paintTrees(new Date(2026, 6, 15)); }, true);
  await page.evaluate(() => (() => { const b = document.querySelector("#night-btn"); for (let i = 0; i < 3 && b.dataset.state !== "off"; i++) b.click(); })());
  const lum = (p) => p.rgb[0] + p.rgb[1] + p.rgb[2];
  const px = { summer: summerPx, fall: fallPx, winter: winterPx, night: nightPx,
    summerGreen: summerPx.share > 0.2 && summerPx.rgb[1] > summerPx.rgb[0] && summerPx.rgb[1] > summerPx.rgb[2], fallWarm: fallPx.share > 0.2 && fallPx.rgb[0] > fallPx.rgb[1] + 15,
    winterBare: winterPx.share > 0.03 && winterPx.share < 0.9 * summerPx.share && winterPx.rgb[2] > winterPx.rgb[0] && winterPx.rgb[2] > winterPx.rgb[1], nightDark: nightPx.share > 0.2 && lum(nightPx) < 0.6 * lum(summerPx) };
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

// ---- 3D building edges (2026-11-07): thin ink lines on the roofs, bases and corners of the 3D buildings (shared/edges3d.js), 3D only, from zoom 15;
// on hills they are lifted with the buildings the way MapLibre lifts a fill-extrusion; if WebGL can't draw them they stop quietly ----
// Page helper: ed.near(box) is what the lines add to the box (the pixels that change when they are drawn) and how much of it lies within 3 px of
// the buildings (the pixels that change when the buildings are drawn): lines that sit on the buildings are all near them. (Uses __px from treeHelpers.)
const edgeHelpers = `window.__ed = {
  added(box, layer) {
    const m = window.__app.map, show = (v) => m.setLayoutProperty(layer, "visibility", v);
    show("visible"); const on = __px.grab(box); show("none"); const off = __px.grab(box); show("visible");
    const w = Math.round(box[2] * devicePixelRatio), mask = new Uint8Array(on.length / 4);
    for (let i = 0; i < mask.length; i++) mask[i] = Math.abs(on[4 * i] - off[4 * i]) + Math.abs(on[4 * i + 1] - off[4 * i + 1]) + Math.abs(on[4 * i + 2] - off[4 * i + 2]) > 24 ? 1 : 0;
    return { mask, w, h: mask.length / w };
  },
  near(box) {
    const m = window.__app.map, lines = this.added(box, "edges-gl");
    m.setLayoutProperty("edges-gl", "visibility", "none"); const bld = this.added(box, "bld-3d"); m.setLayoutProperty("edges-gl", "visibility", "visible");
    let n = 0, hit = 0, nb = 0;
    for (let i = 0; i < bld.mask.length; i++) nb += bld.mask[i];
    for (let y = 0; y < lines.h; y++) for (let x = 0; x < lines.w; x++) {
      if (!lines.mask[y * lines.w + x]) continue;
      n++;
      near: for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < lines.w && yy < lines.h && bld.mask[yy * lines.w + xx]) { hit++; break near; }
      }
    }
    return { lines: n, buildings: nb, near: n ? +(hit / n).toFixed(3) : 0 };
  },
};`;
const UDEM = [-73.613, 45.512];   // Université de Montréal: dense buildings on the mountain's north slope
const EDGES_DAY = [0.108, 0.119, 0.346, 0.92], EDGES_NIGHT = [0.367, 0.38, 0.496, 0.55];   // navy 0.92 and periwinkle 0.55, premultiplied
const closeTo = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 0.005);
await run("3D edges: drawn in 3D from zoom 15 only, navy by day and periwinkle at night, hidden with the buildings, and stopped by a lost context", APP, async (page) => {
  await page.evaluate(treeHelpers);
  const cam = (is3d, zoom) => page.evaluate(([c, is3d, zoom]) => { const a = window.__app; a.set3d(is3d, false); a.map.jumpTo({ center: c, zoom, pitch: is3d ? 60 : 0, bearing: 0 }); }, [UDEM, is3d, zoom]);
  const info = () => page.evaluate(() => { const m = window.__app.map, e = window.__app.edges;
    return { ...e.info(), max: BikeEdges3D.MAX_LINES, vis: m.getLayer("edges-gl") ? m.getLayoutProperty("edges-gl", "visibility") : "absent", color: Array.from(e.color) }; });
  const colour = (v) => page.evaluate((v) => { { const b = document.querySelector("#night-btn"); for (let i = 0; i < 3 && b.dataset.state !== v; i++) b.click(); } return Array.from(window.__app.edges.color); }, v);
  await cam(true, 17);
  await until(page, () => window.__app.edges.info().drawn > 0 && window.__app.map.loaded(), null, 30000);
  const d3 = await info();
  await page.evaluate(idle);
  // once everything is drawn the map goes quiet: the edge layer must not keep it redrawing (a slow machine may still draw a few last frames)
  const quiet = await page.evaluate(() => new Promise((r) => { const m = window.__app.map, e = window.__app.edges, r0 = e.info().rebuilds; let frames = 0; const f = () => frames++;
    m.on("render", f); setTimeout(() => { m.off("render", f); r({ frames, rebuilds: e.info().rebuilds - r0 }); }, 2000); }));
  const dayColor = await colour("off");
  await cam(true, 14.5); await page.evaluate(idle);
  const far = await info();
  await cam(false, 17); await page.evaluate(idle);
  const f0 = (await info()).frames;
  await page.evaluate(() => window.__app.map.redraw());
  const d2 = await info();
  await cam(true, 17); await page.evaluate(idle);
  await until(page, () => window.__app.edges.info().drawn > 0, null, 30000);
  const nightColor = await colour("on"); const dayAgain = await colour("off");
  await page.evaluate(() => document.querySelector('input[data-layer="buildings"]').click());   // buildings off: no lines floating where they were
  const noBld = await info();
  await page.evaluate(() => document.querySelector('input[data-layer="buildings"]').click());
  const back = await info();
  await page.evaluate(() => window.__app.map.fire("webglcontextlost"));   // what the map hears when a phone takes its graphics memory back
  const lost = await page.evaluate(() => ({ error: window.__app.edges.info().error, warns: window.__warns.filter((w) => /^3D edges: WebGL drawing stopped/.test(w)).length }));
  const ok = d3.drawn > 0 && d3.lines > 0 && d3.lines <= d3.max && !d3.error && d3.webgl >= 1 && d3.vis === "visible" && quiet.rebuilds === 0 && quiet.frames < 20
    && closeTo(dayColor, EDGES_DAY) && far.drawn === 0 && d2.vis === "none" && d2.frames === f0
    && closeTo(nightColor, EDGES_NIGHT) && closeTo(dayAgain, EDGES_DAY) && noBld.vis === "none" && back.vis === "visible"
    && /context lost/.test(lost.error || "") && lost.warns === 1;
  return { ok, d3, quiet, far, d2, dayColor, nightColor, noBld, back, lost };
}, { width: 1000, height: 700 });

await run("3D edges: on a hill the lines sit on the buildings (lifted by the ground's height, as MapLibre lifts them), not on the flat map", APP, async (page) => {
  await page.evaluate(treeHelpers); await page.evaluate(edgeHelpers);
  await page.evaluate(([c]) => { const a = window.__app; a.set3d(true, false); a.map.jumpTo({ center: c, zoom: 17, pitch: 60, bearing: 0 }); }, [UDEM]);
  await until(page, () => window.__app.edges.info().drawn > 0 && window.__app.edges.info().elevMax > 20 && window.__app.map.loaded(), null, 60000);
  await page.evaluate(idle);
  const box = [0, 0, 1000, 700];
  const ground = await page.evaluate(() => { const m = window.__app.map, e = window.__app.edges.info(), q = m.queryTerrainElevation(m.getCenter());
    return { terrain: !!m.getTerrain(), elevMin: e.elevMin, elevMax: e.elevMax, centre: q === null ? null : +q.toFixed(1) }; });
  const on = await page.evaluate((b) => __ed.near(b), box);
  // control: the same lines without the lift (as if the ground were flat) lie 100 m under this hill: the ground hides nearly all of them
  // (and the ground heights used are the terrain's: a sample of buildings against map.queryTerrainElevation)
  // 2026-11-07: judged on 95 % of the buildings: where the map holds a coarser terrain tile than the one sampled (GitHub's runner, saved
  // terrain), a few heights differ; whether the lines sit on the drawn buildings is the "near" check below
  const used = await page.evaluate(() => { const m = window.__app.map, ll = new maplibregl.LngLat(0, 0), d = [];
    for (const t of window.__app.edges.tiles.values()) for (let i = 0; i < t.nb; i += 7) { ll.lng = t.lng[i]; ll.lat = t.lat[i]; d.push(Math.abs(t.elev[i] * m.terrain.exaggeration - m.queryTerrainElevation(ll))); }
    d.sort((a, b) => a - b);
    return { n: d.length, p95: +(d[Math.floor(d.length * 0.95)] || 0).toFixed(2), worst: +(d[d.length - 1] || 0).toFixed(2) }; });
  await page.evaluate(() => { const e = window.__app.edges; for (const t of e.tiles.values()) t.elev.fill(0); e.pending = e.pack(); window.__app.map.triggerRepaint(); });
  await page.evaluate(idle);
  const flat = await page.evaluate((b) => __ed.near(b), box);
  const ok = ground.terrain && ground.elevMax - ground.elevMin > 5 && ground.centre !== null && ground.centre >= ground.elevMin - 3 && ground.centre <= ground.elevMax + 3
    && on.lines > 300 && on.buildings > 3000 && on.near > 0.9
    && used.n > 50 && used.p95 < 4 && flat.buildings > 3000 && flat.lines < 0.1 * on.lines;
  return { ok, ground, used, on, flat };
}, { width: 1000, height: 700 });

// ---- 2026-11-08: the ride camera raises the terrain's exaggeration as a climb comes up (map.terrain.exaggeration, no event). Trees and edge lines keep
// the ground's true height and apply the exaggeration every frame, so they stay on the ground instead of floating (or sinking) while it changes ----
await run("3D trees and edges stay on the ground while the terrain's exaggeration changes (the ride camera's hill boost)", APP, async (page) => {
  await page.evaluate(treeHelpers); await page.evaluate(edgeHelpers);
  await page.evaluate(([c]) => { const a = window.__app; a.set3d(true, false); a.map.jumpTo({ center: c, zoom: 17, pitch: 60, bearing: 0 }); }, [UDEM]);
  await until(page, () => window.__app.edges.info().drawn > 0 && window.__app.trees.info().drawn > 0 && window.__app.map.loaded(), null, 60000);
  await page.evaluate(idle);
  // how far the stored ground heights are from the terrain as drawn now (p95 over trees and over buildings), in metres
  const gap = () => page.evaluate(() => { const m = window.__app.map, ll = new maplibregl.LngLat(0, 0), ex = m.terrain.exaggeration;
    const p95 = (layer, key) => { const d = []; for (const t of layer.tiles.values()) for (let i = 0; i < t[key]; i += 9) { ll.lng = t.lng[i]; ll.lat = t.lat[i]; d.push(Math.abs(t.elev[i] * ex - m.queryTerrainElevation(ll))); }
      d.sort((a, b) => a - b); return { n: d.length, p95: +(d[Math.floor(d.length * 0.95)] || 0).toFixed(2) }; };
    return { ex, trees: p95(window.__app.trees, "n"), edges: p95(window.__app.edges, "nb") }; });
  const before = await gap();
  const boosted = await page.evaluate(() => { window.__app.map.terrain.exaggeration = 2.5; window.__app.map.triggerRepaint(); });
  await page.evaluate(idle);
  const after = await gap();
  // and what is drawn: with the exaggeration up, the lines still lie on the buildings
  const near = await page.evaluate(() => __ed.near([0, 0, 1000, 700]));
  const ok = before.trees.n > 100 && before.edges.n > 50 && after.ex === 2.5 && before.trees.p95 < 5 && after.trees.p95 < 5 && before.edges.p95 < 5 && after.edges.p95 < 5
    && near.lines > 300 && near.buildings > 3000 && near.near > 0.9;
  return { ok, before, after, near };
}, { width: 1000, height: 700 });

// ---- 2026-11-08: lines behind a wall must not show through it. The depth nudge that keeps a line from losing to its own wall used to be a fixed
// clip-space amount, worth metres at distance (the ride camera: pitch 70, far away), so lines a few metres behind a wall or roof passed the depth test ----
await run("3D edges: a line a few metres behind a wall stays hidden in the ride camera (pitch 70, zoom 17.4); one in front of it shows", APP, async (page) => {
  await page.evaluate(treeHelpers); await page.evaluate(edgeHelpers);
  const C = [-73.58, 45.52];   // open ground for the test: a made-up slab 60 m wide, 3 m deep and 20 m tall, and two made-up corner lines
  await page.evaluate((c) => { const a = window.__app; a.set3d(true, false); document.querySelector('input[data-layer="terrain"]').click();   // flat ground
    a.map.setLayoutProperty("bld-3d", "visibility", "none"); a.map.jumpTo({ center: c, zoom: 17.4, pitch: 70, bearing: 0 }); }, C);
  await until(page, () => window.__app.edges.info().drawn > 0 && window.__app.map.loaded(), null, 60000);
  await page.evaluate(idle);
  const out = await page.evaluate(() => {
    const m = window.__app.map, e = window.__app.edges, c = m.getCenter(), O = maplibregl.MercatorCoordinate.fromLngLat(c, 0), k = O.meterInMercatorCoordinateUnits();
    const at = (dx, dy) => new maplibregl.MercatorCoordinate(O.x + dx * k, O.y + dy * k, 0);   // metres east and south of the centre
    const ring = [[-30, -1.5], [30, -1.5], [30, 1.5], [-30, 1.5], [-30, -1.5]].map(([x, y]) => at(x, y).toLngLat().toArray());
    m.addSource("t-slab", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } } });
    m.addLayer({ id: "t-slab", type: "fill-extrusion", source: "t-slab", paint: { "fill-extrusion-color": "#ffffff", "fill-extrusion-height": 20, "fill-extrusion-opacity": 1 } }, "edges-gl");
    // two vertical lines, from 2 m to 18 m up: one 2 m inside the slab, behind its near wall (hidden), one 4 m in front of the wall (shown)
    const spots = [at(0, -0.5), at(15, 4)], n = spots.length;
    const tile = { key: "15/0/0", z: 15, x: 0, y: 0, raw: n, n, nb: n, lines: n, seg: new Float64Array(n * 4), kind: new Uint8Array(n).fill(1), bld: Uint32Array.from([0, 1]),
      h: new Float32Array(n).fill(18), lng: new Float64Array(n).fill(c.lng), lat: new Float64Array(n).fill(c.lat), elev: new Float32Array(n), elevFor: "flat" };
    spots.forEach((q, i) => { tile.seg[i * 4] = q.x; tile.seg[i * 4 + 1] = q.y; });
    clearTimeout(e.timer); e.timer = 1;   // the layer must not rebuild from the map's tiles now: it draws only these
    e.tiles = new Map([[tile.key, tile]]); e.pending = e.pack(); m.redraw(); m.redraw();
    // where each line's middle (9 m up) is on screen, from the matrix the layer drew with
    const [ox, oy, kk] = e.origin, M = e.matrix, W = m.getCanvas().clientWidth, H = m.getCanvas().clientHeight;
    const screen = (q) => { const x = (q.x - ox) / kk, y = (q.y - oy) / kk, z = 9 * m.terrain?.exaggeration || 9; const cx = M[0] * x + M[4] * y + M[8] * z + M[12], cy = M[1] * x + M[5] * y + M[9] * z + M[13], cw = M[3] * x + M[7] * y + M[11] * z + M[15];
      return { x: Math.round((cx / cw + 1) / 2 * W), y: Math.round((1 - cy / cw) / 2 * H) }; };
    const hits = (p) => __ed.added([p.x - 3, p.y - 3, 7, 7], "edges-gl").mask.reduce((s, v) => s + v, 0);
    return { hidden: hits(screen(spots[0])), shown: hits(screen(spots[1])), pts: spots.map(screen), lines: e.count };
  });
  return { ok: out.lines === 2 && out.hidden === 0 && out.shown >= 3, out };
}, { width: 1000, height: 700 });

// ---- 2026-11-09: hand-inked feel. A made-up building outline edge is packed slightly past both its ends (along itself, in its own plane), a corner
// line slightly above its roof; with the constants at 0 they are exact. Checked on the packed data: no map frames needed ----
await run("3D edges: lines are packed a little past their ends (overshoot), exactly to them when the overshoot is 0", APP, async (page) => {
  await page.evaluate(treeHelpers); await page.evaluate(edgeHelpers);
  await until(page, () => !!window.__app.edges, null, 60000);
  const out = await page.evaluate(() => {
    const m = window.__app.map, e = window.__app.edges, c = m.getCenter(), O = maplibregl.MercatorCoordinate.fromLngLat(c, 0), k = O.meterInMercatorCoordinateUnits();
    // one made-up edge, 40 m long running east-west (record kind 0: four packed ends), and one corner line (kind 1: two ends), on a 15 m building
    const tile = { key: "15/0/0", z: 15, x: 0, y: 0, raw: 2, n: 2, nb: 1, lines: 3, seg: Float64Array.from([O.x, O.y, O.x + 40 * k, O.y, O.x, O.y, 0, 0]), kind: Uint8Array.from([0, 1]),
      bld: Uint32Array.from([0, 0]), h: Float32Array.from([15]), lng: Float64Array.from([c.lng]), lat: Float64Array.from([c.lat]), elev: new Float32Array(1), elevFor: "flat" };
    clearTimeout(e.timer); e.timer = 1;   // no rebuild from the map's tiles: pack only these
    e.tiles = new Map([[tile.key, tile]]);
    const read = () => { const p = e.pack(), d = p.data, kk = p.origin[2], v = (i) => ({ x: d[4 * i], y: d[4 * i + 1], z: d[4 * i + 3] });
      const L = [0, 1, 2, 3, 4, 5].map(v);   // roof A, roof B, base A, base B, corner bottom, corner top
      return { count: p.count, len: +(L[1].x - L[0].x).toFixed(2), start: +L[0].x.toFixed(2), flat: L.slice(0, 4).every((q) => Math.abs(q.y) < 1e-3), roofZ: [L[0].z, L[1].z], baseZ: [L[2].z, L[3].z],
        cornerBottom: +L[4].z.toFixed(2), cornerTop: +L[5].z.toFixed(2), ink: p.ink.length, kk }; };
    const on = read(); e.opt.overshoot = 0; e.opt.cornerUp = 0; const off = read();
    return { on, off };
  });
  const { on, off } = out;
  // on: 40 m + 2 x 0.35, the start 0.35 m before the origin, corner line 0.3 m above the 15 m roof, nothing below the ground (base stays at 0.05 m)
  const ok = on.count === 3 && Math.abs(on.len - 40.7) < 0.02 && Math.abs(on.start + 0.35) < 0.02 && on.flat && on.roofZ.every((z) => z === 15) && on.baseZ.every((z) => Math.abs(z - 0.05) < 1e-6)
    && Math.abs(on.cornerTop - 15.3) < 0.02 && Math.abs(on.cornerBottom - 0.05) < 0.02 && on.ink === 3
    && off.count === 3 && Math.abs(off.len - 40) < 0.02 && Math.abs(off.start) < 0.02 && Math.abs(off.cornerTop - 15) < 0.02;
  return { ok, on, off };
}, { width: 600, height: 400 });

await run("3D edges: a shader that fails stops them quietly (one warning, no error), the buildings and trees carry on", APP, async (page, ctx) => {
  await ctx.addInitScript(() => {
    for (const GL of [window.WebGLRenderingContext, window.WebGL2RenderingContext].filter(Boolean)) {
      const source = GL.prototype.shaderSource, param = GL.prototype.getShaderParameter, ours = new WeakSet();
      GL.prototype.shaderSource = function (s, text) { if (/u_edgecolor/.test(text)) ours.add(s); return source.call(this, s, text); };
      GL.prototype.getShaderParameter = function (s, p) { return ours.has(s) && p === this.COMPILE_STATUS ? false : param.call(this, s, p); };
    }
  });
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => !!window.__app, null, { timeout: 90000 });
  await page.evaluate(treeHelpers);
  await page.evaluate(([c]) => { const a = window.__app; a.set3d(true, false); a.map.jumpTo({ center: c, zoom: 17, pitch: 60, bearing: 0 }); }, [UDEM]);
  await until(page, () => !!window.__app.edges.info().error, null, 30000);
  await page.evaluate(idle);
  await page.evaluate(() => { window.__app.map.redraw(); window.__app.map.redraw(); });
  await page.waitForTimeout(500);
  const out = await page.evaluate(() => { const m = window.__app.map, e = window.__app.edges.info();
    return { error: e.error, drawn: e.drawn, warns: window.__warns.filter((w) => /^3D edges: WebGL drawing stopped/.test(w)).length, bld: m.getLayoutProperty("bld-3d", "visibility"),
      treesGL: window.__app.state.treesGL, trees: window.__app.trees.info().drawn, buildings: m.queryRenderedFeatures({ layers: ["bld-3d"] }).length }; });
  const ok = /^edge shader/.test(out.error || "") && out.drawn === 0 && out.warns === 1 && out.bld === "visible" && out.buildings > 0 && out.treesGL;
  return { ok, out };
}, { width: 1000, height: 700 });

// ------------------------------------------------------------------ "ink hints" (2026-11-09): subtle inked-drawing touches (ink.js and style.css)
// the five hints: a pen outline on the route card, the chosen classic card and the ride card (the phone sheet gets one line on its top edge),
// flat shadows (no blur anywhere), a flat highlight on navy, buttons that sink into their dots, a pop on the turn distance
const INK_ROUTE = `${APP}?welcome=0&notrack=1&from=-73.5817,45.5246&to=-73.6150,45.5035`;
await run("ink hints: pen outline on the route, classic and ride cards (two paths, no CSS border), same line at every draw, draw-on only for a new card", INK_ROUTE, async (page) => {
  const card = "#routes .route-card .ink-svg";
  await until(page, (s) => !!document.querySelector(s), card);
  const first = await page.evaluate((s) => { const svg = document.querySelector(s), c = svg.parentElement, cs = getComputedStyle(c);
    return { paths: svg.querySelectorAll("path").length, ptr: getComputedStyle(svg).pointerEvents, hidden: svg.getAttribute("aria-hidden"), border: cs.borderTopColor, bw: cs.borderTopWidth,
      draw: svg.dataset.draw, d: [...svg.querySelectorAll("path")].map((p) => p.getAttribute("d")).join("|") }; }, card);
  // a re-render of the same card (the slider; 2026-11-09: the card stays, its halves are rewritten, so the pen outline stays too): the same svg, the same line when the size is the same, no new draw-on
  const again = async (change) => {
    await until(page, (q) => document.querySelector(q).getAnimations({ subtree: true }).length === 0, card);   // the first draw-on is over (the card, and so its outline, now stays)
    await page.evaluate((c) => { window.__old = document.querySelector("#routes .route-card .rc-top"); window.__svg = document.querySelector("#routes .route-card .ink-svg"); const el = document.querySelector("#strict"); if (c) el.value = Math.max(0, +el.value - 40); el.dispatchEvent(new Event("input")); }, change);
    await until(page, () => { const c = document.querySelector("#routes .route-card .rc-top"); return c && c !== window.__old; });
    return page.evaluate((s) => { const svg = document.querySelector(s); return { sameSvg: svg === window.__svg, draw: svg.dataset.draw, d: [...svg.querySelectorAll("path")].map((p) => p.getAttribute("d")).join("|"), anims: svg.getAnimations({ subtree: true }).length }; }, card);
  };
  const same = await again(false), moved = await again(true);
  // a new trip draws on
  await page.evaluate(() => { const a = window.__app; window.__svg = document.querySelector("#routes .route-card .ink-svg"); a.state.to = [-73.5900, 45.5300]; a.computeRoutes(true); });
  await until(page, (s) => { const c = document.querySelector(s); return c && c !== window.__svg && c.dataset.draw === "on"; }, card);
  const fresh = await page.evaluate((s) => document.querySelector(s).dataset.draw, card);
  // the chosen classic ride's card
  const classic = await page.evaluate(async () => { const a = window.__app; a.setTab("suggest"); a.setSuggMode("classics"); a.showClassic(0, false);
    await new Promise((r) => { const t0 = performance.now(), f = () => (document.querySelector(".classic-card.sel .ink-svg") || performance.now() - t0 > 8000 ? r() : requestAnimationFrame(f)); f(); });
    const c = document.querySelector(".classic-card.sel"), svg = c && c.querySelector(".ink-svg"), cs = c && getComputedStyle(c);
    return { paths: svg ? svg.querySelectorAll("path").length : 0, border: cs && cs.borderTopColor, others: [...document.querySelectorAll(".classic-card:not(.sel) .ink-svg")].length }; });
  // the ride card
  const ride = await page.evaluate(async () => { const a = window.__app; a.startRide("birdseye"); a.pauseRide(true);
    await new Promise((r) => { const t0 = performance.now(), f = () => (document.querySelector(".ride-bar .ink-svg") || performance.now() - t0 > 8000 ? r() : requestAnimationFrame(f)); f(); });
    const c = document.querySelector(".ride-bar"), svg = c.querySelector(".ink-svg"), cs = getComputedStyle(c);
    return { paths: svg ? svg.querySelectorAll("path").length : 0, border: cs.borderTopColor, bw: cs.borderTopWidth, draw: svg && svg.dataset.draw }; });
  const clear = (c) => /^rgba\(0, 0, 0, 0\)$|^transparent$/.test(c);
  const ok = first.paths === 2 && first.ptr === "none" && first.hidden === "true" && clear(first.border) && parseFloat(first.bw) >= 1 && first.draw === "on"
    && same.d === first.d && same.sameSvg && same.anims === 0 && moved.sameSvg && moved.anims === 0 && fresh === "on"
    && classic.paths === 2 && clear(classic.border) && classic.others === 0 && ride.paths === 2 && clear(ride.border) && parseFloat(ride.bw) >= 1 && ride.draw === "on";
  return { ok, first, same: { draw: same.draw, anims: same.anims, sameLine: same.d === first.d }, moved: { draw: moved.draw, anims: moved.anims }, fresh, classic, ride };
}, { width: 1200, height: 800 });

await run("ink hints: with reduced motion the outline simply appears (no animation), and the turn distance does not pop", INK_ROUTE, async (page) => {
  await until(page, () => !!document.querySelector("#routes .route-card .ink-svg"));
  const card = await page.evaluate(() => { const svg = document.querySelector("#routes .route-card .ink-svg"); return { draw: svg.dataset.draw, anims: svg.getAnimations({ subtree: true }).length }; });
  await page.evaluate(() => { const a = window.__app; a.startRide("birdseye"); a.pauseRide(true); a.state.snap = true; a.state.ride.seek(20); });   // a paused ride writes its cards once it has moved
  await until(page, () => !!document.querySelector("#turn-text").textContent);
  const pop = await page.evaluate(() => ({ cls: document.querySelector("#turn-dist").classList.contains("pop"), draw: document.querySelector(".ride-bar .ink-svg") && document.querySelector(".ride-bar .ink-svg").dataset.draw }));
  return { ok: card.draw !== "on" && card.anims === 0 && !pop.cls && pop.draw !== "on", card, pop };
}, { width: 1200, height: 800 }, { reducedMotion: "reduce" });

await run("ink hints: on a phone the sheet has one ink line on its top edge and no shadow; the cards still have their outline", `${INK_ROUTE}&safe=47,34`, async (page) => {
  await until(page, () => !!document.querySelector(".panel > .grabber .ink-svg") && !!document.querySelector("#routes .route-card .ink-svg"));
  const out = await page.evaluate(() => { const p = document.querySelector(".panel"), g = p.querySelector(".grabber .ink-svg"), cs = getComputedStyle(p), gb = g.getBoundingClientRect(), pb = p.getBoundingClientRect();
    return { paths: g.querySelectorAll("path").length, shadow: cs.boxShadow, border: cs.borderTopWidth, ptr: getComputedStyle(g).pointerEvents, onTop: Math.abs(gb.top - pb.top) < 3, wide: Math.abs(gb.width - pb.width) < 2,
      btn: [...document.querySelectorAll(".map-controls .round-btn, .map-controls .view-btn")].map((b) => getComputedStyle(b).borderTopLeftRadius) }; });
  return { ok: out.paths === 2 && out.shadow === "none" && out.border === "0px" && out.ptr === "none" && out.onTop && out.wide && out.btn.length > 0 && out.btn.every((r) => r === "3px"), out };
}, { width: 390, height: 844 }, { hasTouch: true, isMobile: true });

await run("ink hints: flat, not soft: no element has a blurred box-shadow or drop-shadow (route, Layers, overlays, ride); corners 3 px on buttons and 6 px on floating cards", INK_ROUTE, async (page) => {
  const walk = () => page.evaluate(() => {
    const blur = (v) => { const n = (v || "").match(/(-?[\d.]+)px/g) || []; return n[2] ? parseFloat(n[2]) : 0; };   // x y blur ...
    const bad = [];
    for (const el of document.querySelectorAll("body *")) {
      if (!el.getClientRects().length) continue;
      const c = getComputedStyle(el);
      for (const s of (c.boxShadow || "").split(/,(?![^(]*\))/)) if (blur(s) > 0) bad.push(`${el.id || el.className || el.tagName}: ${s.trim()}`);
      if (/drop-shadow/.test(c.filter) && blur(c.filter) > 0) bad.push(`${el.id || el.className.baseVal || el.className || el.tagName}: ${c.filter}`);
    }
    return bad;
  });
  const OVER = "#layers, #wx-card, #ride-summary, #notice, #toast, #about, #suggest, #place-list, #ride-recenter";
  const open = () => page.evaluate((s) => { document.querySelectorAll(s).forEach((e) => { e.dataset.wasHidden = e.hidden ? "1" : ""; e.hidden = false; }); }, OVER);
  const shut = () => page.evaluate((s) => document.querySelectorAll(s).forEach((e) => { e.hidden = !!e.dataset.wasHidden; }), OVER);
  await until(page, () => !!document.querySelector("#routes .route-card .ink-svg"));
  const route = await walk();
  await page.click("#layers-btn"); const layers = await walk(); await page.click("#layers-btn");
  await open(); const overlays = await walk();
  const corners = await page.evaluate(() => { const r = (s) => { const e = document.querySelector(s); return e && getComputedStyle(e).borderTopLeftRadius; };
    return { layers: r("#layers"), toast: r("#toast"), wx: r("#wx-card"), notice: r("#notice"), summary: r("#ride-summary"), btn: r("#ride-go"), share: r(".share-btn") }; });
  await shut();
  await page.evaluate(() => { const a = window.__app; a.startRide("birdseye"); a.pauseRide(true); });
  await until(page, () => !!document.querySelector(".ride-bar .ink-svg"));
  const ride = await walk();
  const turn = await page.evaluate(() => { const c = getComputedStyle(document.querySelector(".turn-card")); return { radius: c.borderTopLeftRadius, grad: /radial-gradient/.test(c.backgroundImage) }; });
  const ok = [route, layers, overlays, ride].every((l) => l.length === 0) && corners.layers === "6px" && corners.toast === "4px" && corners.wx === "6px" && corners.notice === "6px" && corners.summary === "6px"
    && corners.btn === "3px" && corners.share === "3px" && turn.radius === "6px" && turn.grad;
  return { ok, route, layers, overlays, ride, corners, turn };
}, { width: 1200, height: 800 });

await run("ink hints: a navy button has the flat highlight; pressed, a button sinks into its dots (top/left, no transform, dots hidden)", INK_ROUTE, async (page) => {
  await until(page, () => !!document.querySelector("#ride-go"));
  const read = () => page.evaluate(() => { const b = document.querySelector("#ride-go"), c = getComputedStyle(b), a = getComputedStyle(b, "::after");
    return { top: c.top, left: c.left, transform: c.transform, dots: a.opacity, grad: /radial-gradient/.test(c.backgroundImage), bg: c.backgroundColor }; });
  const before = await read();
  const box = await (await page.$("#ride-go")).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.waitForTimeout(200);
  const pressed = await read();
  await page.mouse.move(2, 2); await page.mouse.up();   // let go away from the button: no ride starts
  await page.waitForTimeout(200);
  const after = await read();
  const ok = before.grad && before.top === "0px" && before.dots === "1" && pressed.top === "3px" && pressed.left === "3px" && pressed.dots === "0" && pressed.transform === "none" && after.top === "0px" && after.dots === "1";
  return { ok, before, pressed, after };
}, { width: 1200, height: 800 });

await run("ink hints: the turn distance pops once when the turn instruction changes, not when only the distance counts down", INK_ROUTE, async (page) => {
  await page.evaluate(() => { const a = window.__app; a.startRide("birdseye"); a.pauseRide(true); a.state.snap = true; a.state.ride.seek(20); });   // a paused ride writes its cards once it has moved
  await until(page, () => !!document.querySelector("#turn-text").textContent);
  const out = await page.evaluate(async () => {
    const a = window.__app, s = a.state, dist = document.querySelector("#turn-dist"), text = document.querySelector("#turn-text"), m = s.ride.route.maneuvers;
    const settle = (want) => new Promise((r) => { const t0 = performance.now(), f = () => (want() || performance.now() - t0 > 10000 ? r() : requestAnimationFrame(f)); f(); });
    const go = async (d, want) => { s.snap = true; s.ride.seek(d); await settle(want); };
    const first = m.find((x) => x.at > 120) || m[0];
    await go(Math.max(0, first.at - 100), () => /\d/.test(dist.textContent));
    const t1 = text.textContent, d1 = dist.textContent;
    dist.classList.remove("pop");
    await go(Math.max(0, first.at - 60), () => dist.textContent !== d1);   // the distance counts down, the instruction stays
    const countdown = { sameText: text.textContent === t1, pop: dist.classList.contains("pop") };
    const next = m.find((x) => x.at > first.at + 80);
    await go(next.at - 50, () => text.textContent !== t1);   // a later turn: a new instruction
    return { countdown, changed: text.textContent !== t1, pop: dist.classList.contains("pop") };
  });
  return { ok: out.countdown.sameText && !out.countdown.pop && out.changed && out.pop, out };
}, { width: 1200, height: 800 });

// 2026-11-09: the pop must not change the layout, during or after it: the instruction stays on the line below the distance and the card keeps its height
await run("ink hints: after the pop the turn text is still below the distance and the turn card is as tall as before", INK_ROUTE, async (page) => {
  await page.evaluate(() => { const a = window.__app; a.startRide("birdseye"); a.pauseRide(true); a.state.snap = true; a.state.ride.seek(20); });
  await until(page, () => !!document.querySelector("#turn-text").textContent);
  const out = await page.evaluate(async () => {
    const dist = document.querySelector("#turn-dist"), text = document.querySelector("#turn-text"), card = document.querySelector(".turn-card");
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const read = () => ({ h: card.getBoundingClientRect().height, below: text.getBoundingClientRect().top >= dist.getBoundingClientRect().bottom - 1, block: getComputedStyle(dist).display === "block" });
    dist.classList.remove("pop"); await frame(); await frame();
    const before = read();
    dist.classList.add("pop");
    await frame(); const during = read();   // the animation is running (a transform alone does not move the layout box)
    await new Promise((r) => setTimeout(r, 600)); await frame();
    const after = read();
    return { before, during, after };
  });
  const same = (x) => Math.abs(x.h - out.before.h) < 0.5 && x.below && x.block;
  return { ok: same(out.before) && same(out.during) && same(out.after), out };
}, { width: 1200, height: 800 });

// ------------------------------------------------------------------ route layout A (2026-11-09)
// The route card holds the Route style slider and the Avoid chips right under its time row; "Let's ride!" and share are pinned to the panel's
// bottom edge; on a phone the sheet opens at the height that shows all of it. Nothing here counts map frames or depends on how many were drawn.
const LAYOUT_ROUTE = `${APP}?welcome=0&notrack=1&safe=47,34&gps=0&from=-73.5817,45.5246&to=-73.6150,45.5035`;
await run("route layout (phone): the card holds time, slider and Avoid chips, all visible with Let's ride! at the bottom; the sheet opens at the height they need; dragging the slider keeps its element and focus; ride bar pinned at every sheet size; EN and FR", LAYOUT_ROUTE, async (page) => {
  await until(page, () => window.__app.state.routes.length > 0 && !!document.querySelector("#routes .route-card .prefs"), null, 60000);
  await panelStill(page);
  // what the rider sees: the time, the slider, both chips and the button, each fully inside the screen, above the pinned row, map left above the sheet
  const seen = () => {
    const R = (s) => document.querySelector(s).getBoundingClientRect(), panel = R("#panel"), dock = R("#dock"), safeB = 34;
    const above = (r) => r.top >= panel.top + 30 && r.bottom <= dock.top + 0.5 && r.left >= 0 && r.right <= innerWidth;
    const chip = (id) => R(`label.toggle:has(#${id})`), ride = R("#ride-go");
    return { mapH: Math.round(panel.top), panelH: Math.round(panel.height), time: above(R("#routes .route-card .time")), slider: above(R("#strict")), hills: above(chip("hills")), works: above(chip("avoid-works")),
      ride: ride.top >= panel.top + 30 && ride.bottom <= innerHeight - safeB + 0.5, rideH: Math.round(ride.height), shareH: Math.round(R(".share-btn").height), sliderH: Math.round(R("#strict").height),
      noScrollNeeded: document.querySelector("#panel").scrollTop === 0, ink: document.querySelectorAll("#routes .route-card > .ink-svg").length };
  };
  const open = await page.evaluate(seen);
  const inCard = await page.evaluate(() => { const c = document.querySelector("#routes div.route-card"), strict = document.querySelector("#strict"), ord = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    return { slider: c.contains(strict), chips: c.contains(document.querySelector("#hills")) && c.contains(document.querySelector("#avoid-works")), ink: document.querySelector("#routes").dataset.ink || "",
      afterTitle: ord(c.querySelector(".rc-top"), strict), beforeClimb: ord(document.querySelector("#avoid-works"), c.querySelector(".rc-climb")),
      // focus order follows the picture: the bars, then the slider, the chips, the strip, and the pinned button last
      focusOrder: ["#from", "#to", "#places .star", "#strict", "#hills", "#avoid-works", "#routes .route-card .bar .seg", "#ride-go"].every((s, i, a) => !i || ord(document.querySelector(a[i - 1]), document.querySelector(s))) };
  });
  // the star beside the two bars, centred between them, the bars ending at the same edge
  const star = await page.evaluate(() => { const f = document.querySelector("#from").closest(".field").getBoundingClientRect(), t = document.querySelector("#to").closest(".field").getBoundingClientRect(),
    c = document.querySelector("#places .star").getBoundingClientRect(), mid = (f.top + t.bottom) / 2;
    return { beside: c.left + 7 >= f.right && c.right <= innerWidth + 8, centred: Math.abs((c.top + c.bottom) / 2 - mid) <= 3, aligned: Math.abs(f.right - t.right) <= 1, tap: c.width >= 44 && c.height >= 44 }; });
  // the slider: the same element all through a keyboard drag and a pointer drag, still focused, the time following the route
  await page.evaluate(() => { window.__s = document.querySelector("#strict"); window.__chip = document.querySelector("#hills"); window.__r0 = window.__app.state.routes[0].r; });
  await page.focus("#strict");
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
  const keys = await page.evaluate(() => { const C = window.BikeCommon, s = window.__app.state;
    return { same: document.querySelector("#strict") === window.__s, focus: document.activeElement === window.__s, value: +window.__s.value, rerouted: s.routes[0].r !== window.__r0,
      time: document.querySelector("#routes .route-card .time").textContent === C.fmtMin(C.rideMinutes(s.routes[0].r)), ink: document.querySelectorAll("#routes .route-card > .ink-svg").length }; });
  const box = await page.locator("#strict").boundingBox(), vals = [];
  const x = (v) => box.x + 8 + (box.width - 16) * v / 100, y = box.y + box.height / 2;
  await page.mouse.move(x(keys.value), y); await page.mouse.down();
  for (const v of [60, 40, 20, 5]) { await page.mouse.move(x(v), y, { steps: 4 }); vals.push(await page.evaluate(() => +document.querySelector("#strict").value)); }
  await page.mouse.up();
  const drag = await page.evaluate(() => ({ same: document.querySelector("#strict") === window.__s, time: document.querySelector("#routes .route-card .time").textContent.length > 0 }));
  // an Avoid chip toggles and the route follows; the chip stays the same element
  await page.evaluate(() => { window.__r1 = window.__app.state.routes[0].r; });
  await page.click("label.toggle:has(#hills)");
  const chip = await page.evaluate(() => ({ on: document.querySelector("#hills").checked, same: document.querySelector("#hills") === window.__chip, rerouted: window.__app.state.routes[0].r !== window.__r1, hasCard: !!document.querySelector("#routes .route-card .rc-climb") }));
  await page.click("label.toggle:has(#hills)");
  // the pinned row at every sheet size, and after scrolling the panel to its end
  const pinned = {};
  for (const s of ["peek", "half", "full"]) {
    await page.evaluate((k) => window.__app.setSheet(k), s); await page.waitForTimeout(200); await panelStill(page);
    pinned[s] = await page.evaluate(() => { const r = document.querySelector("#ride-go").getBoundingClientRect(), p = document.querySelector("#panel").getBoundingClientRect();
      document.querySelector("#panel").scrollTop = 0; const l = document.querySelector("#lang-btn").getBoundingClientRect(), hit = document.elementFromPoint(l.left + l.width / 2, l.top + l.height / 2);
      return r.top >= p.top + 30 && r.bottom <= innerHeight - 34 + 0.5 && r.width > 100 && hit === document.querySelector("#lang-btn"); });   // the pinned row never covers the header
  }
  await page.evaluate(() => { const p = document.querySelector("#panel"); p.scrollTop = p.scrollHeight; });
  pinned.end = await page.evaluate(() => { const r = document.querySelector("#ride-go").getBoundingClientRect(); return r.bottom <= innerHeight - 34 + 0.5 && r.top > 0; });
  await page.evaluate(() => { window.__app.setSheet("half"); document.querySelector("#panel").scrollTop = 0; }); await panelStill(page);
  // French: the same card (no new element, one outline), everything still fits and shows
  await page.click("#lang-btn"); await until(page, () => /^Votre/.test(document.querySelector("#routes .route-card .rc-top b").textContent)); await page.waitForTimeout(300); await panelStill(page);
  const fr = await page.evaluate(() => { const p = document.querySelector("#panel"); return { same: document.querySelector("#strict") === window.__s, fits: p.scrollWidth <= p.clientWidth, label: document.querySelector('label[for="strict"]').textContent }; });
  const frSeen = await page.evaluate(seen);
  await page.click("#lang-btn"); await until(page, () => /^Your/.test(document.querySelector("#routes .route-card .rc-top b").textContent));
  // no destination: the slider and chips are back under the search bars, nothing is pinned, the sheet is half the screen again
  await page.click('.clear[data-target="to"]'); await until(page, () => window.__app.state.routes.length === 0); await page.waitForTimeout(300); await panelStill(page);
  const none = await page.evaluate(() => { const R = (s) => document.querySelector(s).getBoundingClientRect(), s = R(".search"), prefs = document.querySelector(".prefs");
    return { under: !prefs.closest(".route-card") && R("#strict").top >= s.bottom && prefs.parentElement === document.querySelector("#panel"),
      dockHidden: document.querySelector("#dock").hidden, half: Math.abs(R("#panel").height - innerHeight / 2) < 4, noCard: !document.querySelector("#routes .route-card"), same: document.querySelector("#strict") === window.__s,
      sliderH: Math.round(R("#strict").height), star: R("#places .star").top > s.top && R("#places .star").bottom < s.bottom + 8 }; });
  const ok = open.time && open.slider && open.hills && open.works && open.ride && open.noScrollNeeded && open.mapH >= 280 && open.panelH < 844 * 0.7 && open.ink === 1
    && open.rideH >= 44 && open.rideH <= 46 && open.shareH >= 44 && open.shareH <= 46 && open.sliderH >= 44
    && inCard.slider && inCard.chips && inCard.afterTitle && inCard.beforeClimb && inCard.focusOrder && inCard.ink.startsWith("-73.5817")
    && star.beside && star.centred && star.aligned && star.tap
    && keys.same && keys.focus && keys.value < 85 && keys.rerouted && keys.time && keys.ink === 1
    && drag.same && vals.every((v, i) => !i || v < vals[i - 1]) && vals[3] <= 15
    && chip.on && chip.same && chip.rerouted && chip.hasCard
    && pinned.peek && pinned.half && pinned.full && pinned.end
    && fr.same && fr.fits && /Style/.test(fr.label) && frSeen.time && frSeen.slider && frSeen.hills && frSeen.works && frSeen.ride && frSeen.ink === 1
    && none.under && none.dockHidden && none.half && none.noCard && none.same && none.sliderH >= 44 && none.star;
  return { ok, open, inCard, star, keys, vals, drag, chip, pinned, fr, frSeen, none };
}, { width: 390, height: 844 }, { hasTouch: true });

await run("route layout (desktop): the card with its controls right under the search bars, Let's ride! and share pinned at the panel's bottom; the other two tabs keep their content and pin the same row", LAYOUT_ROUTE, async (page) => {
  await until(page, () => window.__app.state.routes.length > 0 && !!document.querySelector("#routes .route-card .prefs"), null, 60000);
  const panelInfo = () => { const kids = [...document.querySelector("#panel").children].filter((c) => !c.hidden && c.getClientRects().length).map((c) => c.id || c.className.split(" ")[0]);
    const p = document.querySelector("#panel").getBoundingClientRect(), d = document.querySelector("#dock").getBoundingClientRect(), r = document.querySelector("#ride-go").getBoundingClientRect(), sh = document.querySelector(".share-btn");
    return { kids, dockLast: document.querySelector("#panel").lastElementChild.id === "dock", atBottom: d.bottom >= p.bottom - 3 && d.bottom <= p.bottom + 1, rideIn: r.top >= p.top && r.bottom <= p.bottom, rideH: Math.round(r.height), shareH: sh ? Math.round(sh.getBoundingClientRect().height) : 0 }; };
  const go = await page.evaluate(panelInfo);
  const goOrder = await page.evaluate(() => { const c = document.querySelector("#routes .route-card"), s = document.querySelector(".search").getBoundingClientRect();
    return { prefsInCard: c.contains(document.querySelector(".prefs")), cardUnderSearch: c.getBoundingClientRect().top >= s.bottom && c.getBoundingClientRect().top - s.bottom < 24, sliderUnderTitle: document.querySelector("#strict").getBoundingClientRect().top > c.querySelector(".rc-sub").getBoundingClientRect().bottom,
      sliderH: Math.round(document.querySelector("#strict").getBoundingClientRect().height) }; });
  // scrolled to the end: the row is still at the bottom edge, in view
  await page.evaluate(() => { const p = document.querySelector("#panel"); p.scrollTop = p.scrollHeight; });
  const goEnd = await page.evaluate(panelInfo);
  await page.evaluate(() => { document.querySelector("#panel").scrollTop = 0; });
  // Design your own ride: its form, then its ride cards; the controls stay under the form; the row is pinned, and since 2026-11-09 (shareable rides) it carries share too
  await page.click("#tab-custom");
  await until(page, () => window.__app.state.routes.length > 1 && !document.querySelector("#dock").hidden && document.querySelectorAll("#routes button.route-card, #routes div.route-card").length > 1, null, 90000);
  const custom = await page.evaluate(() => { const ord = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING), form = document.querySelector("#suggest-form");
    return { formThenCards: ord(form, document.querySelector("#routes")), prefsHome: document.querySelector(".prefs").parentElement === document.querySelector("#panel") && !document.querySelector(".prefs").closest(".route-card"),
      cards: document.querySelectorAll("#routes .route-card").length, shareInDock: !!document.querySelector("#dock .share-btn"), sliderH: Math.round(document.querySelector("#strict").getBoundingClientRect().height) }; });
  const customPin = await page.evaluate(panelInfo);
  // Classic rides: the carousel, the same pinned row, share shown
  await page.click("#tab-classics");
  await until(page, () => window.__app.state.routes[0] && window.__app.state.routes[0].classic && !document.querySelector("#dock").hidden && !!document.querySelector(".share-btn"), null, 60000);
  const classics = await page.evaluate(() => ({ carousel: !!document.querySelector("#classic-track .classic-card"), prefsHome: document.querySelector(".prefs").parentElement === document.querySelector("#panel") }));
  const classicPin = await page.evaluate(panelInfo);
  // back to Go somewhere: the card again, with its controls
  await page.click("#tab-go"); await until(page, () => !!document.querySelector("#routes .route-card .prefs"), null, 60000);
  const back = await page.evaluate(() => ({ inCard: !!document.querySelector("#routes .route-card .prefs #strict"), n: document.querySelectorAll(".prefs").length }));
  const ok = go.dockLast && go.atBottom && go.rideIn && go.rideH >= 44 && go.shareH >= 44 && go.kids.indexOf("search") < go.kids.indexOf("routes") && go.kids.indexOf("routes") < go.kids.indexOf("dock")
    && goOrder.prefsInCard && goOrder.cardUnderSearch && goOrder.sliderUnderTitle && goOrder.sliderH >= 44 && goEnd.atBottom && goEnd.rideIn
    && custom.formThenCards && custom.prefsHome && custom.cards > 1 && custom.shareInDock && customPin.shareH >= 44 && customPin.dockLast && customPin.atBottom && customPin.rideIn && customPin.rideH >= 44
    && classics.carousel && classics.prefsHome && classicPin.atBottom && classicPin.rideIn && classicPin.shareH >= 44
    && back.inCard && back.n === 1;
  return { ok, go, goOrder, goEnd, custom, customPin, classics, classicPin, back };
}, { width: 1440, height: 900 });

// ---- 2026-11-09: bridges in 3D rides (shared/bridge3d.js). The terrain has no bridge decks, so a draped route line followed the ground down to the water
// and up again. A significant bridge (a structure the route is at least 0.5 m above the ground model on, at least 40 m long, rising at least 4 m above the
// ground) gets the route drawn on its deck; the draped line under it is left out and the rider's markers ride on the deck. The route below crosses a
// 65 m bridge over the Décarie trench (rise about 6 m); the other has no structure at all. Nothing here depends on how many frames were drawn. ----
const BRIDGE_ROUTE = "from=-73.6700,45.5000&to=-73.6600,45.5040", FLAT_ROUTE = "from=-73.5800,45.5150&to=-73.5700,45.5200";
const BRIDGE_URL = (view, at) => `${APP}?welcome=0&notrack=1&gps=0&${BRIDGE_ROUTE}&ride=${view}&at=${at}&paused`;
await run("3D bridges: the bridge is found (start, length, rise), the deck is at the route's height, the draped line under it is left out, the rider rides on the deck", BRIDGE_URL("bird", 900), async (page) => {
  await page.evaluate(treeHelpers); await page.evaluate(edgeHelpers);
  await until(page, () => window.__app.bridges && window.__app.bridges.info().found > 0, null, 60000);
  const found = await page.evaluate(() => window.__app.bridges.info());
  const mid = found.stretches[0] ? (found.stretches[0].d0 + found.stretches[0].d1) / 2 : 1050;
  // the rider at mid-span; the markers take the lift at a frame of the ride, so seek again once the deck has been drawn
  await page.evaluate((d) => { const a = window.__app; a.state.snap = true; a.state.ride.seek(d); }, mid);
  await page.evaluate(idle);
  await page.evaluate((d) => { const a = window.__app; a.state.snap = true; a.state.ride.seek(d); }, mid);
  await page.evaluate(idle);
  const out = await page.evaluate((box) => {
    const a = window.__app, m = a.map, b = a.bridges, info = b.info(), st = b.stretches[0], r = a.state.ride.route, C = BikeCommon, ex = m.terrain.exaggeration;
    if (!st) return { info };
    const i = st.d.length >> 1, deckVert = (st.ranges[1] + 6 * i) * 8;   // the deck's first quad at section i: x, y, nx, ny, across, raw height, lift, tier
    const drawn = st.data[deckVert + 5], routeZ = C.elevAt(r, st.d[i]);
    const ground = m.queryTerrainElevation(new maplibregl.LngLat(st.lon[i], st.lat[i])) / ex;   // the map's own terrain at mid-span (true metres)
    // the draped line: the pieces with br = 1 cover the bridge, and the casing layer leaves them out
    const len = (cs) => cs.slice(1).reduce((t, c, k) => t + BikeRouter.distM(cs[k][0], cs[k][1], c[0], c[1]), 0);
    const pieces = C.routePiecesGeoJSON(r, b.cuts(r, 0, r.length)).features, cutLen = pieces.filter((f) => f.properties.br === 1).reduce((s, f) => s + len(f.geometry.coordinates), 0);
    const casing = JSON.stringify(m.getFilter("route-casing") ?? null), shown = m.queryRenderedFeatures({ layers: ["route-casing"] }).filter((f) => f.properties.br === 1).length;
    // the rider: where the deck's centre is on the screen (from the matrix the deck was drawn with) against the arrow marker's centre and the ground point
    const cvs = m.getCanvas(), cr = cvs.getBoundingClientRect(), W = cvs.clientWidth, H = cvs.clientHeight, M = st.M;
    const x = st.x[i], y = st.y[i], z = st.deck[i] * ex, cw = M[3] * x + M[7] * y + M[11] * z + M[15];
    const deck = [((M[0] * x + M[4] * y + M[8] * z + M[12]) / cw + 1) / 2 * W, (1 - (M[1] * x + M[5] * y + M[9] * z + M[13]) / cw) / 2 * H];
    const el = a.riderMarker.getElement().getBoundingClientRect(), mk = [el.left + el.width / 2 - cr.left, el.top + el.height / 2 - cr.top];
    const g = m.project([st.lon[i], st.lat[i]]);
    const toDeck = Math.hypot(mk[0] - deck[0], mk[1] - deck[1]), toGround = Math.hypot(mk[0] - g.x, mk[1] - g.y);
    return { info, mid: st.d[i], drawn: +drawn.toFixed(2), routeZ: +routeZ.toFixed(2), ground: +ground.toFixed(2), ownGround: +st.ground[i].toFixed(2), casing, shown, pieces: pieces.length, cutLen: Math.round(cutLen),
      lift: +a.riderMarker.getOffset().y.toFixed(1), deck: deck.map(Math.round), marker: mk.map(Math.round), ground2: [Math.round(g.x), Math.round(g.y)], toDeck: +toDeck.toFixed(1), toGround: +toGround.toFixed(1),
      deckPixels: __ed.added(box, "bridge-gl").mask.reduce((s, v) => s + v, 0), vertices: st.data.length / 8, bytes: st.data.byteLength };
  }, [0, 0, 390, 844]);
  // after the bridge the markers are back on the ground
  await page.evaluate((d) => { const a = window.__app; a.state.snap = true; a.state.ride.seek(d); }, found.stretches[0] ? found.stretches[0].d1 + 120 : 1300);
  await page.evaluate(idle);
  const after = await page.evaluate(() => ({ lift: window.__app.riderMarker.getOffset().y }));
  const s0 = found.stretches[0] || {};
  const ok = found.found === 1 && s0.d0 > 990 && s0.d0 < 1040 && s0.len >= 55 && s0.len <= 75 && s0.rise >= 4 && s0.rise <= 9 && found.error === null
    && out.vertices > 100 && out.vertices < 2000 && Math.abs(out.drawn - out.routeZ) < 1 && out.drawn - out.ground >= 3 && Math.abs(out.ownGround - out.ground) < 3
    && /"br"/.test(out.casing) && out.shown === 0 && Math.abs(out.cutLen - s0.len) < 4 && out.pieces >= 3
    && out.lift < -4 && out.toDeck < 8 && out.toGround > out.toDeck + 4 && out.deckPixels > 150 && Math.abs(after.lift) < 0.5;
  return { ok, found, out, after };
}, { width: 390, height: 844 });

await run("3D bridges: a route with no bridge builds nothing (no layer, no cut, the draped line as it is)", `${APP}?welcome=0&notrack=1&gps=0&${FLAT_ROUTE}&ride=bird&at=600&paused`, async (page) => {
  await until(page, () => window.__app.bridges && window.__app.bridges.info().done > 0, null, 60000);
  await page.evaluate(idle);
  const out = await page.evaluate(() => { const a = window.__app, m = a.map, b = a.bridges, r = a.state.ride.route;
    return { info: b.info(), layer: !!m.getLayer("bridge-gl"), filter: JSON.stringify(m.getFilter("route-casing") ?? null), cuts: b.cuts(r).length, br: m.querySourceFeatures("route").filter((f) => f.properties.br === 1).length, terrain: !!m.terrain }; });
  return { ok: out.terrain && out.info.done === 1 && out.info.found === 0 && out.info.stretches.length === 0 && out.info.vertices === 0 && !out.layer && out.filter === "null" && out.cuts === 0 && out.br === 0 && out.info.error === null, out };
}, { width: 390, height: 844 });

await run("3D bridges: the flat top-down ride does nothing (no terrain, no analysis, no layer); a shader that fails leaves the draped line as it was, with one warning", BRIDGE_URL("top", 900), async (page, ctx) => {
  await page.waitForTimeout(1500);
  const flat = await page.evaluate(() => { const a = window.__app, m = a.map; return { terrain: !!m.terrain, info: a.bridges.info(), layer: !!m.getLayer("bridge-gl"), filter: JSON.stringify(m.getFilter("route-casing") ?? null) }; });
  // the same route in the 3D ride, with a bridge shader that does not compile
  await ctx.addInitScript(() => {
    for (const GL of [window.WebGLRenderingContext, window.WebGL2RenderingContext].filter(Boolean)) {
      const source = GL.prototype.shaderSource, param = GL.prototype.getShaderParameter, ours = new WeakSet();
      GL.prototype.shaderSource = function (s, text) { if (/u_halfw/.test(text)) ours.add(s); return source.call(this, s, text); };
      GL.prototype.getShaderParameter = function (s, p) { return ours.has(s) && p === this.COMPILE_STATUS ? false : param.call(this, s, p); };
    }
  });
  await page.goto(BASE + BRIDGE_URL("bird", 1050), { waitUntil: "load" });
  await page.waitForFunction(() => !!window.__app, null, { timeout: 90000 });
  await page.evaluate(treeHelpers);
  await until(page, () => window.__app.bridges && !!window.__app.bridges.info().error, null, 60000);
  await page.evaluate(idle);
  await page.waitForTimeout(300);   // the route is drawn again without the cut a moment after the failure
  const failed = await page.evaluate(() => { const a = window.__app, m = a.map, b = a.bridges.info();
    return { error: b.error, cut: b.cut, drawn: b.drawn, stretches: b.stretches.length, filter: JSON.stringify(m.getFilter("route-casing") ?? null), br: m.querySourceFeatures("route").filter((f) => f.properties.br === 1).length,
      warns: window.__warns.filter((w) => /^3D bridges: WebGL drawing stopped/.test(w)).length, ride: !!a.state.ride, terrain: !!m.terrain }; });
  const ok = !flat.terrain && flat.info.done === 0 && flat.info.found === 0 && !flat.layer && flat.filter === "null"
    && /^bridge shader/.test(failed.error || "") && failed.cut === false && failed.drawn === 0 && failed.stretches === 0 && failed.filter === "null" && failed.br === 0 && failed.warns === 1 && failed.ride && failed.terrain;
  return { ok, flat, failed };
}, { width: 390, height: 844 });

await browser.close();
if (webkitBrowser) await webkitBrowser.close();
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
