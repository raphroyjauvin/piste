// Functional tests for the app, in headless Edge. Usage: node C:\bikeapp\tools\shots\test.mjs [name filter]
// Test the live site instead: set PISTE_BASE=https://www.raphroyjauvin.ca/piste/ first.
import { chromium } from "playwright-core";

const BASE = process.env.PISTE_BASE || "http://localhost:8765/";
const APP = "a-positron/index.html";
const only = process.argv[2];
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
const results = [];
async function run(name, url, fn, viewport = { width: 1440, height: 900 }) {
  if (only && !name.includes(only)) return;
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|404|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  const t = Date.now();
  try {
    await page.goto(BASE + url, { waitUntil: "load", timeout: 90000 });
    await page.waitForFunction(() => !!window.__app, null, { timeout: 90000 });
    const out = await fn(page);
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
    windNextToHills: document.querySelector("#hills").closest(".pref-checks") === document.querySelector("#avoid-wind").closest(".pref-checks"),
  }));
  // scroll the panel to the top so its own button is off screen: the floating copy should appear, then hide again at the bottom
  const fab = await page.evaluate(async () => {
    const panel = document.querySelector("#panel"); panel.style.maxHeight = "420px"; panel.scrollTop = 0;
    await new Promise((r) => setTimeout(r, 400)); const shown = !document.querySelector("#ride-fab").hidden;
    panel.scrollTop = panel.scrollHeight; await new Promise((r) => setTimeout(r, 400)); const hiddenAtEnd = document.querySelector("#ride-fab").hidden;
    panel.style.maxHeight = ""; return { shown, hiddenAtEnd };
  });
  await page.click("#layers-btn");
  const opened = await page.evaluate(() => !document.querySelector("#layers").hidden);
  await page.mouse.click(700, 500);
  const closed = await page.evaluate(() => document.querySelector("#layers").hidden);
  const fromAfterTap = await page.evaluate(() => window.__app.state.to && window.__app.state.to.join(","));
  await page.click("#view-btn"); await page.waitForTimeout(1200);
  const label3d = await page.evaluate(() => document.querySelector("#view-label").textContent);
  const ok = !before.gapBoxes && before.stopRadius === 7.5 && /^0s/.test(before.popTransition) && before.rideText === "Let's ride!" && before.windNextToHills && fab.shown && fab.hiddenAtEnd
    && !before.tripChips && !before.exploreNote && before.avoidHills === "Avoid hills" && !/LiDAR/.test(before.relief) && before.works === "Construction"
    && before.metroToggle && !before.parksToggle && before.label2d === "3D" && label3d === "2D" && opened && closed && !before.chevLayer && before.gapsOk;
  return { ok, ...before, fab, layersOpened: opened, layersClosedByTap: closed, destinationKept: fromAfterTap, label3d };
});

await run("elevation: tint, shading, detail contours, LiDAR terrain", `${APP}?trip=montroyal`, async (page) => {
  await page.evaluate(idle);
  return page.evaluate(async (idleSrc) => {
    const app = window.__app, m = app.map;
    const visible = ["tint", "relief", "contours-detail", "contours-index", "contours-minor"].map((id) => [id, m.getLayoutProperty(id, "visibility") || "visible"]);
    const detailLines = window.CONTOURS.features.filter((f) => f.properties.i === 2).length;
    app.set3d(true); await eval(idleSrc);
    const local = performance.getEntriesByType("resource").filter((e) => e.name.includes("/shared/terrain/")).length;
    return { ok: visible.every((v) => v[1] === "visible") && detailLines > 1000 && local > 0 && m.terrain && m.terrain.exaggeration === 1.6,
      visible, detailLines, localTerrainTiles: local, exaggeration: m.terrain && m.terrain.exaggeration, hillBoost: app.CAM.hill.boost };
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
  const fabPos = await page.evaluate(() => { const f = document.querySelector("#ride-fab"), p = document.querySelector("#panel");
    return { shown: !f.hidden, aboveSheet: !f.hidden && f.getBoundingClientRect().bottom <= p.getBoundingClientRect().top + 1 }; });
  // tap the destination field: it moves to the bottom, map above; tap the map to set the place, then ✓
  const to = await page.locator("#to").boundingBox();
  await page.mouse.click(to.x + 20, to.y + to.height / 2); await page.waitForTimeout(400);
  const focusOpen = await page.evaluate(() => ({ focusing: document.body.classList.contains("focusing"), bar: !document.querySelector("#focus-bar").hidden,
    label: document.querySelector("#focus-label").textContent, panelHidden: getComputedStyle(document.querySelector("#panel")).display === "none" }));
  const before = await page.evaluate(() => window.__app.state.to.join(","));
  await page.mouse.click(200, 300); await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({ to: window.__app.state.to.join(","), input: document.querySelector("#focus-input").value }));
  await page.click("#focus-ok"); await page.waitForTimeout(800);
  const closed = await page.evaluate(() => ({ focusing: document.body.classList.contains("focusing"), routes: window.__app.state.routes.length }));
  return { ok: Math.abs(half - H / 2) < 4 && full >= H - 62 - 10 && peek <= 160 && layout.scrollW <= layout.innerW && fabPos.shown && fabPos.aboveSheet
      && focusOpen.focusing && focusOpen.bar && focusOpen.panelHidden && focusOpen.label === "Destination" && after.to !== before && !!after.input && !closed.focusing && closed.routes > 0,
    half, full, peek, ...layout, fabPos, focusOpen, movedDestination: after.to !== before, focusInput: after.input, closed };
}, { width: 402, height: 874 });

await browser.close();
let failed = 0;
for (const r of results) { console.log(JSON.stringify(r)); if (!r.ok) failed++; }
console.log(failed ? `${failed} test(s) FAILED` : `all ${results.length} tests passed`);
process.exitCode = failed ? 1 : 0;
