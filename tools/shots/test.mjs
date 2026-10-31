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
  const { fresh, ...opts } = ctxOpts;
  try {
    ctx = await browser.newContext({ viewport, ...opts });
    if (!fresh) await ctx.addInitScript(() => { try { localStorage.setItem("piste-welcomed", "1"); } catch (e) { /* storage blocked */ } });
    await ctx.addInitScript(() => { try { localStorage.setItem("umami.disabled", "1"); } catch (e) { /* storage blocked */ } });   // tests never count as visits
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
    windNextToHills: document.querySelector("#hills").closest(".pref-checks") === document.querySelector("#avoid-wind").closest(".pref-checks"),
  }));
  const noFloatingCopy = await page.evaluate(() => !document.querySelector("#ride-fab"));
  await page.click("#layers-btn");
  const opened = await page.evaluate(() => !document.querySelector("#layers").hidden);
  await page.mouse.click(700, 500);
  const closed = await page.evaluate(() => document.querySelector("#layers").hidden);
  const fromAfterTap = await page.evaluate(() => window.__app.state.to && window.__app.state.to.join(","));
  await page.click("#view-btn"); await page.waitForTimeout(1200);
  const label3d = await page.evaluate(() => document.querySelector("#view-label").textContent);
  const ok = !before.gapBoxes && before.stopRadius === 7.5 && /^0s/.test(before.popTransition) && before.rideText === "Let's ride!" && !before.previewLink && before.windNextToHills && noFloatingCopy
    && !before.tripChips && !before.exploreNote && before.avoidHills === "Avoid hills" && !/LiDAR/.test(before.relief) && before.works === "Construction"
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

await run("wind & rain and live BIXI", `${APP}?trip=rachel`, async (page) => page.evaluate(async (minStations) => {
  const app = window.__app, m = app.map, s = app.state;
  app.setWeather(true); await new Promise((r) => setTimeout(r, 4000));
  const card = document.querySelector("#wx-card").textContent;
  const windNote = document.querySelector(".wind-note") ? document.querySelector(".wind-note").textContent : "";
  const out = { radar: m.getLayoutProperty("radar", "visibility"), canvas: !document.querySelector("#wind").hidden, card: card.slice(0, 200), windNote,
    wx: s.wxData && { wind: s.wxData.now.wind, dir: s.wxData.now.dir } };
  for (let i = 0; i < 20 && !s.bixi; i++) await new Promise((r) => setTimeout(r, 500));
  out.bixiStations = s.bixi ? s.bixi.features.length : 0;
  out.bixiSample = s.bixi ? s.bixi.features.slice(0, 1).map((f) => [f.properties.name, f.properties.bikes, f.properties.docks]) : null;
  app.setWeather(false);
  out.ok = out.radar === "visible" && out.canvas && /Wind|Calm/.test(out.card) && !!windNote && out.bixiStations >= minStations;
  return out;
}, FIX ? FIX_BIXI_STATIONS : 301));   // live: the whole network (about 800 stations); fixtures: every station in the saved file

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
  await page.evaluate(() => window.__app.setSheet("full")); await page.waitForTimeout(400);
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
  const docked = await settled(page, () => { const f = document.querySelector("#to").closest(".field").getBoundingClientRect();
    return { searching: document.body.classList.contains("searching"), active: document.activeElement.id, brandHidden: getComputedStyle(document.querySelector("#brand")).display === "none",
      fieldBottom: Math.round(f.bottom), kbTop: Math.round(innerHeight - Math.max(260, innerHeight * 0.47)), clearShown: getComputedStyle(document.querySelector('.clear[data-target="to"]')).display !== "none" }; });
  const suggestShown = () => { const l = document.querySelector("#suggest"); return !l.hidden && l.children.length > 0; };
  // type: suggestions float over the map, above the card (select the old destination first, so the text searched is exactly "marché jean")
  await page.keyboard.press("Control+A"); await page.keyboard.type("marché jean"); await until(page, suggestShown);
  const list = await page.evaluate(() => { const l = document.querySelector("#suggest"), p = document.querySelector("#panel");
    return { shown: !l.hidden, aboveCard: l.getBoundingClientRect().bottom <= p.getBoundingClientRect().top + 1, n: l.children.length }; });
  // the ✕ leaves without changing the destination
  const before = await page.evaluate(() => window.__app.state.toLabel);
  await page.click('.clear[data-target="to"]'); await page.waitForTimeout(500);
  const cancelled = await page.evaluate((b) => ({ searching: document.body.classList.contains("searching"), same: window.__app.state.toLabel === b && document.querySelector("#to").value === b }), before);
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
      && docked.searching && docked.active === "to" && docked.brandHidden && docked.clearShown && docked.fieldBottom <= docked.kbTop && docked.fieldBottom >= docked.kbTop - 30
      && list.shown && list.aboveCard && !cancelled.searching && cancelled.same && moved.active === "to" && moved.searching && !done.searching && done.routes > 0 && done.sheet === "half",
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
    return { arrived: ride.arrived, secs, toast, endedAfter: s.ride === null && !document.querySelector("#panel").hidden, wakeAfter: s.wake };
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

await run("GPS ride (replayed track): on a classic ride, a reroute rejoins the ride ahead", `${APP}?classic=oldport&gps=replay&gpsx=4&gpsat=1500&detour=1600`, async (page) => page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.__app, s = app.state;
  const planned = s.routes[0].r;
  document.querySelector("#ride-go").click(); window.__flatRide();
  const t0 = performance.now();
  while (s.reroutes < 1 && performance.now() - t0 < 60000) await sleep(200);
  await sleep(1500);
  const r = s.ride.route, log = s.rerouteLog[0] || {}, left = planned.length - (log.d || 0);   // what was left of the ride when you went off it
  const out = { reroutes: s.reroutes, rejoin: s.rideOpts.rejoin, leftM: Math.round(left), newM: Math.round(r.length), plannedSights: planned.stops.map((x) => x.label),
    sights: r.stops.map((x) => x.label), piecesM: Math.round(r.pieces.reduce((a, p) => a + p.length, 0)), onNewRoute: s.ride.offCount === 0 };
  app.endRide();
  out.ok = out.reroutes === 1 && out.rejoin && Math.abs(out.newM - out.leftM) < 400 && out.sights.length >= 1
    && out.sights.join() === planned.stops.filter((x) => x.at > log.d + 250).map((x) => x.label).join() && Math.abs(out.piecesM - out.newM) <= 1 && out.onNewRoute;
  return out;
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

// ------------------------------------------------------------------ welcome card, feedback and guided tour (2026-10-30; a-positron/tour.js)
const MAIL_EN = "mailto:support@pistemtl.ca?subject=Piste%20feedback&body=" + encodeURIComponent("What happened:\n\n\nWhere (street or place):\n\n");
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
const sameState = (a, b) => JSON.stringify(a) === JSON.stringify(b);
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
      href: document.querySelector("#welcome-feedback").getAttribute("href"), footHref: document.querySelector("#feedback-link").getAttribute("href"),
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
    tour: document.querySelector("#welcome-tour span").textContent, href: document.querySelector("#welcome-feedback").getAttribute("href") }));
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
  const ok = en.title === "Welcome to Piste" && en.mark && en.beta === "Beta" && /can be wrong/.test(en.betaText) && /follow the road/i.test(en.betaText) && /Take the tour/.test(en.tour) && en.explore === "Explore on my own"
    && en.href === MAIL_EN && en.footHref === MAIL_EN && en.dialog && en.focusInside && en.flag === null && closed.hidden && closed.flag === "1" && reload.decided === "seen" && reload.hidden
    && fr.title === "Bienvenue dans Piste" && fr.beta === "Bêta" && fr.tour === "Faire la visite" && fr.href.startsWith("mailto:support@pistemtl.ca?subject=Commentaires%20Piste&body=")
    && frClosed.hidden && frClosed.flag === "1" && phones.every((p) => p.ok) && blocked.shown && blocked.closed && !blocked.errors.length;
  return { ok, en, closed, reload, fr, frClosed, phones, blocked };
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
  const demo = await page.evaluate(() => ({ demo: window.pisteTour.info().demo, routes: window.__app.state.routes.length, from: document.querySelector("#from").value }));
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
  await page.evaluate(() => window.pisteTour.start(2)); await tourAt(page, 2);
  const own = await page.evaluate(() => ({ demo: window.pisteTour.info().demo, from: document.querySelector("#from").value }));
  own.check = await page.evaluate(tourStepCheck);
  await page.keyboard.press("Escape"); await tourClosed(page);
  await until(page, (b) => { const m = window.__app.map; return !m.isMoving() && Math.abs(m.getZoom() - b.zoom) < 0.01; }, own0);
  const own1 = await page.evaluate(appSnapshot);
  const riding = await page.evaluate(() => { const a = window.__app; a.startRide("topdown"); const r = { button: document.querySelector("#tour-again").getClientRects().length > 0, started: window.pisteTour.start(0) }; a.endRide(); return r; });
  const ok = pass1.every((s) => s.ok) && pass2.length === 8 && pass2.every((s) => s.ok) && demo.demo && demo.routes > 0 && demo.from === "Parc La Fontaine" && leftKey === 1
    && sameState(before, afterEsc) && sameState(before, afterDone) && afterDone.drawn === 0 && afterDone.pins === 0 && lastLabel === "Let's go" && focusBack === "tour-again"
    && !own.demo && own.from === "Mont-Royal metro" && own.check.ok && sameState(own0, own1) && !riding.button && riding.started === false;
  return { ok, pass1: brief(pass1), pass2: brief(pass2), demo, leftKey, before, afterEsc, afterDone, lastLabel, focusBack, own: { demo: own.demo, from: own.from, check: own.check.problems }, ownRestored: sameState(own0, own1) || [own0, own1], riding,
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
  await page.evaluate(() => window.__app.setSheet("full"));
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

await browser.close();
// ---- results: the full detail of every group (JSON), then a short summary; exit code 1 if anything failed or nothing ran ----
const failed = results.filter((r) => !r.ok);
console.log("\n=== details ===");
for (const r of results) console.log(JSON.stringify(r));
console.log("\n=== summary ===");
for (const r of results) say(r);
if (process.env.GITHUB_ACTIONS) for (const r of failed) console.log(`::error title=Piste test failed::${r.name}: ${r.error || (r.errors && r.errors[0]) || "a check was false"}`.replace(/\r?\n/g, " "));
const total = ((Date.now() - T0) / 1000).toFixed(0);
if (!results.length) console.log(`FAILED: no test group matched${only ? ` the filter "${only}"` : ""}`);
else console.log(failed.length ? `${failed.length} of ${results.length} test(s) FAILED in ${total} s` : `all ${results.length} tests passed in ${total} s`);
process.exitCode = failed.length || !results.length ? 1 : 0;
