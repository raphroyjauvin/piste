// Functional tests for the app, in headless Edge. Usage: node C:\bikeapp\tools\shots\test.mjs [name filter]
// Test the live site instead: set PISTE_BASE=https://www.raphroyjauvin.ca/piste/ first.
import { chromium } from "playwright-core";

const BASE = process.env.PISTE_BASE || "http://localhost:8765/";
const APP = "a-positron/index.html";
const only = process.argv[2];
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
const results = [];
// ctxOpts: extra browser-context options (touch, location permission and position for the GPS tests); fn gets (page, ctx)
async function run(name, url, fn, viewport = { width: 1440, height: 900 }, ctxOpts = {}) {
  if (only && !name.includes(only)) return;
  const ctx = await browser.newContext({ viewport, ...ctxOpts });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|404|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  const t = Date.now();
  try {
    await page.goto(BASE + url, { waitUntil: "load", timeout: 90000 });
    await page.waitForFunction(() => !!window.__app, null, { timeout: 90000 });
    const out = await fn(page, ctx);
    results.push({ name, ok: errors.length === 0 && out.ok !== false, secs: ((Date.now() - t) / 1000).toFixed(1), ...out, errors });
  } catch (e) {
    results.push({ name, ok: false, error: e.message.split("\n")[0], errors });
  }
  await ctx.close();
}
const idle = "new Promise((r) => { const m = window.__app.map; let d = false; const f = () => { if (!d) { d = true; r(); } }; m.once('idle', f); m.triggerRepaint(); setTimeout(f, 10000); })";
const wait = (ms) => `new Promise((r) => setTimeout(r, ${ms}))`;

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
  await new Promise((r) => setTimeout(r, 1500)); const d2 = app.state.ride ? app.state.ride.d : -1;
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

await run("suggest a ride: custom loops, stops, 100 km box, headwinds", `${APP}?trip=montroyal`, async (page) => page.evaluate(async () => {
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
      && startLabel === "Starting location" && clamped === 100 && long.length >= 2 && restroom.length >= 1 && restroom.every((r) => r.stops === 1) && windy >= 1,
    loops, stops, startLabel, clamped, long, restroom, withHeadwindAvoidance: windy, weatherLoaded: !!s.wxData };
}));

await run("classic rides: 10 cards, routes, swipe", `${APP}?classic=oldport`, async (page) => {
  const out = await page.evaluate(async () => {
    const app = window.__app, s = app.state;
    await new Promise((r) => setTimeout(r, 1500));
    const cards = document.querySelectorAll(".classic-card").length;
    const lengths = window.CLASSICS.map((c, i) => { const r = app.classicRoute(i); return r ? [c.id, +(r.length / 1000).toFixed(1), Math.round(r.infraShare * 100)] : [c.id, null]; });
    const sights = (s.routes[0] && s.routes[0].r.stops || []).filter((x) => x.sight).length;
    const photo = getComputedStyle(document.querySelector(".cc-photo")).backgroundImage.includes("photos/oldport.jpg");
    return { cards, lengths, sights, photo, panelVisible: !document.querySelector("#classics").hidden, first: s.classic };
  });
  await page.evaluate(() => { const tr = document.querySelector("#classic-track"); const c = tr.children[3]; tr.scrollLeft = c.offsetLeft - (tr.clientWidth - c.offsetWidth) / 2; });
  await page.waitForTimeout(700);
  const afterSwipe = await page.evaluate(() => window.__app.state.classic);
  return { ok: out.cards === 10 && out.lengths.every((l) => l[1] && l[1] > 5) && out.sights >= 2 && out.photo && afterSwipe === 3, ...out, afterSwipe };
});

await run("winter mode: 4-season routing, icy map, labels", `${APP}?trip=montroyal`, async (page) => page.evaluate(async () => {
  const app = window.__app, m = app.map, s = app.state;
  const summer = { share: s.routes[0].r.infraShare, bg: m.getPaintProperty("background", "background-color") };
  app.setWinter(true); await new Promise((r) => setTimeout(r, 2500));
  const winter = { share: s.routes[0].r.infraShare, bg: m.getPaintProperty("background", "background-color"), pressed: document.querySelector("#winter-btn").getAttribute("aria-pressed"),
    card: document.querySelector("#wx-card").hidden ? "" : document.querySelector("#wx-card").textContent, notCleared: m.getLayoutProperty("net-not-cleared", "visibility"),
    gapHeading: document.querySelector("#detail").textContent.includes("Without a winter-cleared bike path") };
  app.setWinter(false);
  const back = m.getPaintProperty("background", "background-color");
  return { ok: winter.bg === "#eef4f8" && winter.pressed === "true" && /4-season/.test(winter.card) && winter.notCleared === "visible" && winter.gapHeading && JSON.stringify(back) === JSON.stringify(summer.bg),
    summerShare: Math.round(summer.share * 100), winterShare: Math.round(winter.share * 100), winterCard: winter.card.slice(0, 160) };
}));

await run("wind & rain and live BIXI", `${APP}?trip=rachel`, async (page) => page.evaluate(async () => {
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
  out.ok = out.radar === "visible" && out.canvas && /Wind|Calm/.test(out.card) && !!windNote && out.bixiStations > 300;
  return out;
}));

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
  await new Promise((r) => setTimeout(r, 5000));
  m.off("render", onRender); ro.disconnect(); probe.remove();
  app.pauseRide(true);
  const pop = document.querySelector(".poi-pop");
  const transition = pop ? getComputedStyle(pop).transitionProperty : null;   // MapLibre fades markers in (opacity); nothing may animate their position
  return { ok: frames > 20 && n > 20 && worst < 0.5 && !/transform|all/.test(transition), frames, samples: n, worstPx: +worst.toFixed(2), meanPx: +(sum / Math.max(1, n)).toFixed(3), transition };
}));

await run("phone: swipeable panel, safe areas", `${APP}?trip=rachel&safe=62,34`, async (page) => {
  const H = 874;
  const half = await page.evaluate(() => Math.round(document.querySelector("#panel").getBoundingClientRect().height));
  await page.evaluate(() => window.__app.setSheet("full")); await page.waitForTimeout(400);
  const full = await page.evaluate(() => Math.round(document.querySelector("#panel").getBoundingClientRect().height));
  // drag the grabber down a long way: the panel should drop to the small "peek" size
  const g = await page.locator("#grabber").boundingBox();
  await page.mouse.move(g.x + g.width / 2, g.y + 5); await page.mouse.down(); await page.mouse.move(g.x + g.width / 2, g.y + 600, { steps: 12 }); await page.mouse.up();
  await page.waitForTimeout(500);
  const peek = await page.evaluate(() => Math.round(document.querySelector("#panel").getBoundingClientRect().height));
  const layout = await page.evaluate(() => ({ scrollW: document.documentElement.scrollWidth, innerW: innerWidth }));
  await page.evaluate(() => window.__app.setSheet("half")); await page.waitForTimeout(400);
  // tap the destination bar: the card slides so the bars sit just above the keyboard (a guess here: no real keyboard), brand and tabs hide
  const to = await page.locator("#to").boundingBox();
  await page.mouse.click(to.x + 20, to.y + to.height / 2); await page.waitForTimeout(400);
  const docked = await page.evaluate(() => { const f = document.querySelector("#to").closest(".field").getBoundingClientRect();
    return { searching: document.body.classList.contains("searching"), active: document.activeElement.id, brandHidden: getComputedStyle(document.querySelector("#brand")).display === "none",
      fieldBottom: Math.round(f.bottom), kbTop: Math.round(innerHeight - Math.max(260, innerHeight * 0.47)), clearShown: getComputedStyle(document.querySelector('.clear[data-target="to"]')).display !== "none" }; });
  // type: suggestions float over the map, above the card
  await page.keyboard.type("marché jean"); await page.waitForTimeout(800);
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
  await page.keyboard.press("Control+A"); await page.keyboard.type("marché jean"); await page.waitForTimeout(800);
  await page.keyboard.press("Enter"); await page.waitForTimeout(300);
  const moved = await page.evaluate(() => ({ active: document.activeElement.id, searching: document.body.classList.contains("searching") }));
  // pick the destination from the list: the search ends, the card comes back and the route shows
  await page.keyboard.type("parc la fontaine"); await page.waitForTimeout(800);
  await page.click("#suggest li"); await page.waitForTimeout(900);
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
    document.querySelector("#ride-go").click();
    const ride = s.ride, geo = ride.geo;
    const ui = { gps: !!(ride && ride.gps), speedHidden: document.querySelector("#ride-speed").hidden, pauseHidden: document.querySelector("#ride-pause").hidden,
      gpsShown: !document.querySelector("#ride-gps").hidden, first: document.querySelector("#ride-gps").textContent };
    // at every map draw: is the rider on the route, near the latest fix and the true position, with the camera on it?
    const st = { frames: 0, backwards: 0, offLine: 0, fixMax: 0, fixSum: 0, trueMax: 0, trueSum: 0, camMax: 0, stepMax: 0 };
    let prevD = -1, prevLL = null;
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
      if (prevLL) st.stepMax = Math.max(st.stepMax, C.distM(prevLL.lng, prevLL.lat, ll.lng, ll.lat));
      prevD = ride.d; prevLL = ll;
    };
    m.on("render", onRender); await sleep(8000); m.off("render", onRender);
    const r = (v) => +v.toFixed(2);
    return { ...ui, now: document.querySelector("#ride-gps").textContent, d: Math.round(ride.d), fixes: ride.stats.fixes, ignored: ride.stats.ignored, wake: s.wake,
      frames: st.frames, backwards: st.backwards, offLineM: r(st.offLine), toFixMaxM: r(st.fixMax), toFixMeanM: r(st.fixSum / Math.max(1, st.frames)),
      toTrueMaxM: r(st.trueMax), toTrueMeanM: r(st.trueSum / Math.max(1, st.frames)), cameraM: r(st.camMax), stepMaxM: r(st.stepMax) };
  });
  // drag the map by hand: it stops following and offers "Re-center"; a tap there follows again
  await page.mouse.move(720, 420); await page.mouse.down(); await page.mouse.move(560, 330, { steps: 8 }); await page.mouse.up();
  await page.waitForTimeout(600);
  const dragged = await page.evaluate(() => { const a = window.__app, ll = a.riderMarker.getLngLat(), c = a.map.getCenter();
    return { follow: a.state.follow, button: !document.querySelector("#ride-recenter").hidden, centerToRiderM: Math.round(BikeCommon.distM(c.lng, c.lat, ll.lng, ll.lat)) }; });
  await page.click("#ride-recenter"); await page.waitForTimeout(900);
  const recentered = await page.evaluate(() => { const a = window.__app, ll = a.riderMarker.getLngLat(), c = a.map.getCenter();
    return { follow: a.state.follow, button: !document.querySelector("#ride-recenter").hidden, centerToRiderM: +BikeCommon.distM(c.lng, c.lat, ll.lng, ll.lat).toFixed(2) }; });
  // arrival: start again 160 m before the end
  const arrival = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const app = window.__app, s = app.state, total = s.routes[s.sel].r.length;
    app.endRide(); app.startGpsRide({ replay: { speedup: 3, startAt: total - 160 } });
    const ride = s.ride, t0 = performance.now(); let toast = "";
    while (!ride.arrived && performance.now() - t0 < 25000) { await sleep(200); }
    const secs = +((performance.now() - t0) / 1000).toFixed(1);
    toast = document.querySelector("#toast").hidden ? "" : document.querySelector("#toast").textContent;
    await sleep(3000);
    return { arrived: ride.arrived, secs, toast, endedAfter: s.ride === null && !document.querySelector("#panel").hidden, wakeAfter: s.wake };
  });
  const f = follow;
  const ok = f.gps && f.speedHidden && f.pauseHidden && f.gpsShown && /Waiting for GPS/.test(f.first) && /km\/h/.test(f.now) && f.d > 80 && f.ignored >= 2
    && f.frames > 40 && f.backwards === 0 && f.offLineM < 0.5 && f.toFixMaxM < 12 && f.toFixMeanM < 6 && f.toTrueMeanM < 8 && f.cameraM < 0.5 && f.stepMaxM < 3
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
  document.querySelector("#ride-go").click();
  const ride = s.ride, geo = ride.geo;
  let offDrawn = 0;   // while off route, the rider is drawn where the phone is, not on the route
  const onRender = () => { if (s.ride === ride && ride.route === planned) { const ll = app.riderMarker.getLngLat(); offDrawn = Math.max(offDrawn, plannedTrack.locate(ll.lng, ll.lat).off); } };
  m.on("render", onRender);
  const t0 = performance.now();
  while (s.reroutes < 1 && performance.now() - t0 < 30000) await sleep(200);
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
  document.querySelector("#ride-go").click();
  const t0 = performance.now();
  while (s.reroutes < 1 && performance.now() - t0 < 25000) await sleep(200);
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
  await sleep(1200); const d1 = s.ride ? s.ride.d : -1; await sleep(1200); const d2 = s.ride ? s.ride.d : -1;
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
  await page.evaluate(() => document.querySelector("#ride-go").click());
  for (const [lon, lat] of pts) { await ctx.setGeolocation({ longitude: lon, latitude: lat, accuracy: 8 }); await page.waitForTimeout(450); }
  await page.waitForTimeout(800);
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
  go.click(); await sleep(3500);
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

await browser.close();
let failed = 0;
for (const r of results) { console.log(JSON.stringify(r)); if (!r.ok) failed++; }
console.log(failed ? `${failed} test(s) FAILED` : `all ${results.length} tests passed`);
process.exitCode = failed ? 1 : 0;
