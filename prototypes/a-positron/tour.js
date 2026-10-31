/* Piste: the first-visit welcome card, the feedback links and the guided tour. Loaded after app.js.
   It steers the app only through window.piste (set by app.js once the map is ready).
   ?welcome=1 shows the welcome card again, ?welcome=0 never shows it. window.pisteTour is for tests and screenshots. */
(function () {
  "use strict";
  const I = window.BikeI18n;
  const t = (k, v) => I.t(k, v);
  const $ = (s) => document.querySelector(s);
  const params = new URLSearchParams(location.search);
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const EASE = "cubic-bezier(.2, .8, .2, 1)";
  const easeOut = (x) => 1 - Math.pow(1 - x, 3);
  const MAIL = "support@pistemtl.ca";
  // the demo route when none is showing: Parc La Fontaine to the Old Port (bike paths, a shared stretch and one short gap)
  const DEMO = { from: [-73.57204, 45.52787], to: [-73.5545, 45.5048] };
  let P = null;   // window.piste

  // ------------------------------------------------------------------ feedback: a mail with a blank template, nothing about the person
  const feedbackHref = () => `mailto:${MAIL}?subject=${encodeURIComponent(t("feedbackSubject"))}&body=${encodeURIComponent(t("feedbackBody"))}`;
  function setLinks() { document.querySelectorAll("a[data-mailto]").forEach((a) => (a.href = feedbackHref())); }

  // safe areas in px (env() or the phone preview's ?safe=), read through a probe because the CSS variables may hold env()
  let probe = null;
  function safe() {
    if (!probe) {
      probe = document.createElement("div");
      probe.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding:var(--safe-top) 0 var(--safe-bottom)";
      document.body.appendChild(probe);
    }
    const cs = getComputedStyle(probe);
    return { top: parseFloat(cs.paddingTop) || 0, bottom: parseFloat(cs.paddingBottom) || 0 };
  }
  // Tab stays inside a dialog
  function trapTab(e, root) {
    const f = [...root.querySelectorAll("button, a[href]")].filter((x) => x.getClientRects().length && getComputedStyle(x).visibility !== "hidden");
    if (!f.length) return;
    e.preventDefault();
    const i = f.indexOf(document.activeElement);
    f[e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i < 0 || i === f.length - 1 ? 0 : i + 1)].focus();
  }
  const visible = (el) => !!el && el.isConnected && el.getClientRects().length > 0;

  // ------------------------------------------------------------------ welcome card (first visit)
  const welcome = $("#welcome");
  let welcomeFocus = null, welcomeState = "";   // "seen" (not shown), "due", "shown", "closed"
  function showWelcome() {
    welcomeState = "shown";
    const head = welcome.querySelector(".welcome-head");
    if (!head.querySelector(".mark")) { const m = $("#brand .mark"); if (m) head.prepend(m.cloneNode(true)); }
    welcome.getAnimations().forEach((a) => a.cancel());
    welcome.hidden = false;
    welcome.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "ease-out" });
    welcome.querySelector(".welcome-card").animate(reduced() ? [{ opacity: 0 }, { opacity: 1 }]
      : [{ opacity: 0, transform: "translateY(16px) scale(.98)" }, { opacity: 1, transform: "none" }], { duration: 300, easing: EASE });
    welcomeFocus = document.activeElement;
    welcome.querySelector(".welcome-card").focus({ preventScroll: true });
    document.addEventListener("keydown", welcomeKey, true);
  }
  function welcomeKey(e) {
    if (welcome.hidden) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeWelcome(false); }
    else if (e.key === "Tab") trapTab(e, welcome);
  }
  // either button marks the welcome as seen; "Take the tour" goes straight into the tour
  function closeWelcome(tour) {
    if (welcome.hidden) return;
    P.store.set("welcomed", "1"); welcomeState = "closed";
    document.removeEventListener("keydown", welcomeKey, true);
    const a = welcome.animate([{ opacity: 1 }, { opacity: 0 }], { duration: tour ? 150 : 180, easing: "ease-out", fill: "forwards" });
    a.onfinish = () => { welcome.hidden = true; a.cancel(); };
    if (tour) start(0);
    else if (visible(welcomeFocus) && welcomeFocus !== document.body) welcomeFocus.focus({ preventScroll: true });
    else if (document.activeElement) document.activeElement.blur();
  }

  // ------------------------------------------------------------------ the tour: steps
  // targets: CSS selectors (an array = one highlight around all of them) or "@route" (the route on the map); the first is the main one.
  // sheet: the phone card size for the step. place: where the callout goes, in order of preference.
  const STEPS = [
    { k: 1, id: "search", sheet: "half", scroll: ".search", targets: [".search"], place: ["right", "above", "below"] },
    { k: 2, id: "style", sheet: "half", scroll: ".prefs", targets: [".prefs"], place: ["right", "above", "below"] },
    { k: 3, id: "colours", sheet: "peek", route: true, legend: true, camera: "route", swatches: true, scroll: "#routes .route-card.sel",
      targets: ["@route", "#routes", "#legend details"], phoneTargets: ["@route", "#routes .route-card.sel"], place: ["right", "below", "above", "left"] },
    { k: 4, id: "ride", sheet: "half", route: true, note: true, scroll: "#ride-go", targets: [["#ride-go", "#ride-preview"]], place: ["right", "above", "below"] },
    { k: 5, id: "suggest", tab: "suggest", sheet: "half", scroll: ".tabs", targets: ["#tab-suggest", "#classics"], place: ["right", "above", "below"] },
    { k: 6, id: "winter", sheet: "peek", route: true, winter: true, camera: "wide", targets: ["#winter-btn", "#wx-card"], place: ["left", "below", "above"] },
    { k: 7, id: "tools", sheet: "peek", targets: [["#view-btn", "#layers-btn"]], place: ["left", "below", "above"] },
    { k: 8, id: "feedback", sheet: "half", scroll: "@bottom", targets: ["#foot-links"], place: ["right", "above", "below"] },
  ];
  const specsOf = (st) => (P.isPhone() && st.phoneTargets) || st.targets;

  let overlay = null, card = null, cuts = null, rings = null, shade = null, all = null, maskEl = null, live = null;
  let open = false, cur = -1, gen = 0, raf = 0, orig = null, demo = false, lastFocus = null, wasPhone = false;
  let holes = [], tr = null, settled = false, drawn = "";

  function build() {
    overlay = document.createElement("div");
    overlay.className = "tour"; overlay.hidden = true;
    overlay.innerHTML = `<svg class="tour-dim" aria-hidden="true"><defs><mask id="tour-mask" maskUnits="userSpaceOnUse" x="0" y="0">
        <rect class="tour-all" x="0" y="0" fill="#fff"/><g class="tour-cuts"></g></mask></defs>
        <rect class="tour-shade" x="0" y="0" mask="url(#tour-mask)"/><g class="tour-rings"></g></svg>
      <div class="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-text" tabindex="-1">
        <button type="button" class="tour-skip"></button>
        <h2 id="tour-title"></h2><p id="tour-text"></p><p class="tour-note"></p><div class="tour-swatches"></div>
        <div class="tour-foot"><div class="tour-dots" aria-hidden="true"></div>
          <div class="tour-btns"><button type="button" class="tour-back"></button><button type="button" class="primary tour-next"></button></div></div>
        <span class="sr-only tour-live" aria-live="polite"></span>
      </div>`;
    document.body.appendChild(overlay);
    card = overlay.querySelector(".tour-card"); cuts = overlay.querySelector(".tour-cuts"); rings = overlay.querySelector(".tour-rings");
    shade = overlay.querySelector(".tour-shade"); all = overlay.querySelector(".tour-all"); maskEl = overlay.querySelector("mask");
    live = overlay.querySelector(".tour-live");
    card.querySelector(".tour-next").onclick = () => next();
    card.querySelector(".tour-back").onclick = () => back();
    card.querySelector(".tour-skip").onclick = () => end();
    // the dimmed area swallows taps and clicks, so nothing reaches the app underneath
    for (const ev of ["pointerdown", "pointerup", "click", "dblclick", "contextmenu", "touchstart"]) {
      overlay.addEventListener(ev, (e) => { if (!card.contains(e.target)) { e.stopPropagation(); if (e.cancelable && ev !== "pointerdown" && ev !== "touchstart") e.preventDefault(); } });
    }
    overlay.addEventListener("wheel", (e) => e.preventDefault(), { passive: false });
  }

  function render(st) {
    const i = STEPS.indexOf(st), n = STEPS.length, last = i === n - 1;
    card.querySelector("#tour-title").textContent = t(`tour${st.k}T`);
    card.querySelector("#tour-text").textContent = t(`tour${st.k}`);
    card.querySelector(".tour-note").textContent = st.note ? t(P.gpsDefault() ? "tour4Phone" : "tour4Desk") : "";
    card.querySelector(".tour-swatches").innerHTML = st.swatches
      ? [["sw-a", "lgProtected"], ["sw-b", "lgPainted"], ["sw-c", "lgShared"], ["sw-gap", "lgNoLane"]].map(([c, k]) => `<span><i class="sw ${c}"></i>${t(k)}</span>`).join("") : "";
    card.querySelector(".tour-dots").innerHTML = STEPS.map((_, j) => `<i class="${j === i ? "on" : j < i ? "done" : ""}"></i>`).join("");
    live.textContent = `${t("tourStep", { n: i + 1, total: n })}: ${t(`tour${st.k}T`)}`;
    const back = card.querySelector(".tour-back"), skip = card.querySelector(".tour-skip");
    back.textContent = t("tourBack"); back.style.visibility = i === 0 ? "hidden" : "";
    skip.textContent = t("tourSkip"); skip.hidden = last;
    card.querySelector(".tour-next").textContent = t(last ? "tourDone" : "tourNext");
  }

  // ------------------------------------------------------------------ measuring the targets
  const rr = (r) => ({ x: r.left, y: r.top, w: r.width, h: r.height });
  const union = (a, b) => { const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y); return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }; };
  function inter(a, b) {
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y), w = Math.min(a.x + a.w, b.x + b.w) - x, h = Math.min(a.y + a.h, b.y + b.h) - y;
    return w > 0 && h > 0 ? { x, y, w, h } : null;
  }
  function routeRect() {   // the selected route's outline on screen
    const s = P.state, sel = s.tab === "go" && s.routes[s.sel]; if (!sel) return null;
    const cs = sel.r.coords, n = cs.length, step = Math.max(1, Math.floor(n / 160));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = (c) => { const p = P.map.project(c); x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); };
    for (let i = 0; i < n; i += step) add(cs[i]);
    add(cs[n - 1]);
    const c = P.map.getContainer().getBoundingClientRect();
    return { x: x0 + c.left, y: y0 + c.top, w: x1 - x0, h: y1 - y0 };
  }
  function panelClip() {   // the part of the panel you can see (below the phone card's grab bar)
    const r = rr($("#panel").getBoundingClientRect());
    if (P.isPhone()) { r.y += 30; r.h -= 30; }
    return r;
  }
  function specRect(spec) {   // a target's rectangle as you see it (inside the panel: only the part that shows)
    if (spec === "@route") return routeRect();
    let u = null, inPanel = false;
    for (const s of Array.isArray(spec) ? spec : [spec]) {
      const e = document.querySelector(s);
      if (!visible(e)) continue;
      const r = e.getBoundingClientRect(); if (r.width < 1 || r.height < 1) continue;
      u = u ? union(u, rr(r)) : rr(r);
      inPanel = inPanel || !!e.closest("#panel");
    }
    if (!u || !inPanel) return u;
    const c = panelClip(), v = inter(u, c);
    return v ? Object.assign(v, { clip: c }) : null;
  }
  function holeFor(spec, r) {   // the cut-out around a target, kept on screen (and inside the panel for the panel's parts)
    const route = spec === "@route", pad = route ? 16 : 6;
    const h = { x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad, r: route ? 22 : 14 };
    let v = inter(h, { x: 3, y: 3, w: innerWidth - 6, h: innerHeight - 6 });
    if (v && r.clip) v = inter(v, r.clip);
    return v ? Object.assign(v, { r: h.r }) : null;
  }
  const measure = (specs) => specs.map((s) => { const r = specRect(s); return r ? holeFor(s, r) : null; });
  const exists = (spec) => (spec === "@route" ? !!routeRect() : (Array.isArray(spec) ? spec : [spec]).some((s) => visible(document.querySelector(s))));

  // ------------------------------------------------------------------ drawing the dim layer with its cut-outs
  const NS = "http://www.w3.org/2000/svg";
  function draw(hs) {
    const W = innerWidth, H = innerHeight;
    const sig = W + "x" + H + ":" + hs.map((h) => [h.x, h.y, h.w, h.h, h.r].map((v) => v.toFixed(1)).join(",")).join("|");
    if (sig === drawn) return;
    drawn = sig;
    for (const el of [maskEl, all, shade]) { el.setAttribute("width", W); el.setAttribute("height", H); }
    while (cuts.children.length < hs.length) {
      cuts.appendChild(document.createElementNS(NS, "rect")).setAttribute("fill", "#000");
      rings.appendChild(document.createElementNS(NS, "rect")).setAttribute("class", "tour-glow");
      rings.appendChild(document.createElementNS(NS, "rect")).setAttribute("class", "tour-ring");
    }
    while (cuts.children.length > hs.length) { cuts.lastChild.remove(); rings.lastChild.remove(); rings.lastChild.remove(); }
    hs.forEach((h, k) => {
      const r = Math.max(0, Math.min(h.r, h.w / 2, h.h / 2));
      const set = (el, d) => { el.setAttribute("x", h.x - d); el.setAttribute("y", h.y - d); el.setAttribute("width", Math.max(0, h.w + 2 * d)); el.setAttribute("height", Math.max(0, h.h + 2 * d)); el.setAttribute("rx", r + d); };
      set(cuts.children[k], 0); set(rings.children[2 * k], 3.5); set(rings.children[2 * k + 1], 0);
      const show = h.w > 8 && h.h > 8 && h.w < W && h.h < H ? "" : "none";
      rings.children[2 * k].style.display = rings.children[2 * k + 1].style.display = show;
    });
  }
  const mix = (a, b, e) => ({ x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e, w: a.w + (b.w - a.w) * e, h: a.h + (b.h - a.h) * e, r: a.r + (b.r - a.r) * e });
  const dot = (h) => ({ x: h.x + h.w / 2, y: h.y + h.h / 2, w: 0, h: 0, r: h.r });

  // ------------------------------------------------------------------ the callout card: next to the main target, on screen, off the targets
  function place(hs) {
    const st = STEPS[cur], W = innerWidth, H = innerHeight, sa = safe(), m = 12, gap = 12;
    const cw = card.offsetWidth, ch = card.offsetHeight;
    const minX = m, maxX = W - m - cw, minY = sa.top + m, maxY = Math.max(minY, H - sa.bottom - m - ch);
    const tg = hs.filter(Boolean), p = tg[0] || { x: W / 2, y: H / 2, w: 0, h: 0 };
    const cx = (x) => Math.max(minX, Math.min(maxX, x)), cy = (y) => Math.max(minY, Math.min(maxY, y));
    const at = {
      below: [cx(p.x + p.w / 2 - cw / 2), p.y + p.h + gap], above: [cx(p.x + p.w / 2 - cw / 2), p.y - gap - ch],
      right: [p.x + p.w + gap, cy(p.y + p.h / 2 - ch / 2)], left: [p.x - gap - cw, cy(p.y + p.h / 2 - ch / 2)],
    };
    const cost = (x, y) => tg.reduce((s, h) => { const o = inter({ x, y, w: cw, h: ch }, { x: h.x - 4, y: h.y - 4, w: h.w + 8, h: h.h + 8 }); return s + (o ? o.w * o.h : 0); }, 0);
    let best = null;
    for (const k of [...st.place, "below", "above", "right", "left"]) {
      const [x, y] = at[k];
      if (x < minX - 0.5 || x > maxX + 0.5 || y < minY - 0.5 || y > maxY + 0.5) continue;
      const c = cost(x, y);
      if (!best || c < best[2]) best = [x, y, c];
      if (c === 0) break;
    }
    if (!best || best[2] > 0) {   // no clean side: the free spot on screen that covers the least
      for (let a = 0; a <= 1.0001; a += 0.25) for (let b = 0; b <= 1.0001; b += 0.125) {
        const x = minX + (maxX - minX) * a, y = minY + (maxY - minY) * b, c = cost(x, y);
        if (!best || c < best[2] - 1) best = [x, y, c];
      }
    }
    const pos = [Math.round(best[0]), Math.round(best[1])];
    card.style.transform = `translate(${pos[0]}px, ${pos[1]}px)`;
    return pos;
  }

  // ------------------------------------------------------------------ app state per step
  function snapshot() {
    const s = P.state, m = P.map, c = m.getCenter(), lg = $("#legend details");
    return { tab: s.tab, smode: s.smode, winter: s.winter, sel: s.sel, from: s.from && s.from.slice(), fromLabel: s.fromLabel, to: s.to && s.to.slice(), toLabel: s.toLabel,
      fromVal: $("#from").value, toVal: $("#to").value, sheet: P.sheet.state, scroll: $("#panel").scrollTop, legend: !!(lg && lg.open), layers: !$("#layers").hidden,
      cam: { center: [c.lng, c.lat], zoom: m.getZoom(), bearing: m.getBearing(), pitch: m.getPitch() } };
  }
  function setSmode(v) { P.state.smode = v; const r = document.querySelector(`input[name="smode"][value="${v}"]`); if (r) r.checked = true; }
  function ensureRoute() {   // a route to show: the one on screen, or the demo route
    const s = P.state;
    if (s.routes.length) return;
    if (!demo) { demo = true; P.setPoint("from", DEMO.from, t("tourDemoFrom")); P.setPoint("to", DEMO.to, t("tourDemoTo")); }
    P.computeRoutes(false);
  }
  function apply(st) {
    const s = P.state, phone = P.isPhone();
    if (phone && P.sheet.state !== st.sheet) P.setSheet(st.sheet);   // first, so routes the app fits next leave room for this sheet
    const tab = st.tab || "go";
    if (tab === "suggest" && s.smode !== "classics") setSmode("classics");
    if (s.tab !== tab) P.setTab(tab);
    if (st.route && s.tab === "go") ensureRoute();
    const winter = st.winter ? true : orig.winter;
    if (s.winter !== winter) P.setWinter(winter);
    const lg = $("#legend details");
    if (lg) lg.open = st.legend && !phone ? true : orig.legend;
    if (phone) { const want = sheetFor(st); if (P.sheet.state !== want) P.setSheet(want); }
  }
  function panelSpan(st) {   // top and height of the step's targets inside the panel, or null
    let top = Infinity, bottom = -Infinity;
    for (const spec of specsOf(st)) for (const sel of Array.isArray(spec) ? spec : [spec]) {
      const e = sel[0] === "@" ? null : $(sel);
      if (!visible(e) || !e.closest("#panel")) continue;
      const r = e.getBoundingClientRect(); top = Math.min(top, r.top); bottom = Math.max(bottom, r.bottom);
    }
    return top < Infinity ? { top, h: bottom - top } : null;
  }
  const GRAB = 34;   // the phone card's grab bar, which stays at its top
  function sheetFor(st) {   // the step's card size, or a bigger one if its targets don't fit (small phones)
    const span = st.scroll && st.scroll !== "@bottom" && panelSpan(st), order = ["peek", "half", "full"];
    if (!span) return st.sheet;
    for (let k = order.indexOf(st.sheet); k < 2; k++) if (P.sheetHeight(order[k]) >= span.h + GRAB + 4) return order[k];
    return "full";
  }
  function bbox(cs) {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const [x, y] of cs) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
    return [[w, s], [e, n]];
  }
  function camera(st) {   // moves the map for the step; returns how long the move takes
    const m = P.map, s = P.state, d = reduced() ? 0 : 650, sel = s.tab === "go" && s.routes[s.sel];
    const W = innerWidth, H = innerHeight, sa = safe(), cw = card.offsetWidth, ch = card.offsetHeight;
    if (st.camera === "route" && sel) {
      let pad;
      if (P.isPhone()) {   // the route above the callout, which sits just above the small card
        pad = { top: sa.top + 58, left: 30, right: 96, bottom: P.sheetHeight(P.sheet.state) + ch + 34 };   // right: clear of the map buttons
        if (H - pad.top - pad.bottom < 130) pad.bottom = Math.max(40, H - pad.top - 130);
      } else {   // between the panel and the callout, above the legend
        const lg = $("#legend details"), lgTop = visible(lg) ? lg.getBoundingClientRect().top : H - 60;
        pad = { left: $("#panel").getBoundingClientRect().right + 46, right: cw + 120, top: 86, bottom: Math.max(70, H - lgTop + 30) };
        if (W - pad.left - pad.right < 240) pad.right = Math.max(40, W - pad.left - 240);
        if (H - pad.top - pad.bottom < 220) pad.bottom = Math.max(40, H - pad.top - 220);
      }
      m.fitBounds(bbox(sel.r.coords), { padding: pad, maxZoom: 15.5, duration: d, linear: true, bearing: 0, pitch: 0 });
      return d;
    }
    if (st.camera === "wide") {   // pull back to show the network around the route
      const b = sel ? bbox(sel.r.coords) : null, c = b ? [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2] : m.getCenter().toArray();
      let off = [0, 0];
      if (P.isPhone()) { const wb = $("#winter-btn").getBoundingClientRect(); off = [0, Math.round((wb.bottom + 18 + ch + H - P.sheetHeight(P.sheet.state)) / 2 - H / 2)]; }
      else off = [Math.round(($("#panel").getBoundingClientRect().right + W - cw - 80) / 2 - W / 2), 0];
      m.easeTo({ center: c, zoom: P.isPhone() ? 12.4 : 12.9, bearing: 0, pitch: 0, offset: off, duration: d });
      return d;
    }
    return 0;
  }
  function scrollPlan(st, specs) {   // where the panel should scroll to so the step's targets show
    const panel = $("#panel"), phone = P.isPhone();
    const h = phone ? P.sheetHeight(P.sheet.state) : panel.clientHeight, max = Math.max(0, panel.scrollHeight - h);
    const offset = (e) => e.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop;
    let to = panel.scrollTop;
    if (st.scroll === "@bottom") to = max;
    else if (phone && st.scroll) {   // the targets just under the grab bar (centred when the card is tight)
      const e = $(st.scroll), span = panelSpan(st);
      to = visible(e) ? offset(e) - GRAB - Math.max(2, Math.min(10, span ? (h - GRAB - span.h) / 2 : 10)) : 0;
    }
    else if (!phone) {
      let top = Infinity, bottom = -Infinity;
      for (const spec of specs) for (const sel of Array.isArray(spec) ? spec : [spec]) {
        const e = sel[0] === "@" ? null : $(sel);
        if (!visible(e) || !e.closest("#panel")) continue;
        const o = offset(e); top = Math.min(top, o); bottom = Math.max(bottom, o + e.getBoundingClientRect().height);
      }
      if (top < Infinity) { if (bottom - to > h - 16) to = bottom - h + 16; if (top - to < 16) to = top - 16; }
    }
    to = Math.round(Math.max(0, Math.min(max, to)));
    return Math.abs(to - panel.scrollTop) < 1 ? null : { from: panel.scrollTop, to };
  }

  // ------------------------------------------------------------------ moving between steps
  function go(i, dir = 1) {
    if (!open) return;
    for (let guard = 0; guard < STEPS.length; guard++, i += dir) {
      if (i < 0 || i >= STEPS.length) { if (i >= STEPS.length) end(); return; }
      const st = STEPS[i];
      cur = i; settled = false;
      card.style.opacity = "0"; card.getAnimations().forEach((a) => a.cancel());
      render(st);
      apply(st);
      const specs = specsOf(st).filter(exists);
      if (!specs.length) continue;   // that feature isn't there right now (no route found, say): on to the next step
      const scroll = scrollPlan(st, specs), camMs = camera(st), now = performance.now(), first = !holes.length || holes[0].w >= innerWidth;
      tr = { t0: now, dur: reduced() ? 0 : first ? 420 : 320, from: holes.slice(), specs, scroll, camUntil: now + camMs,
        waitCam: specs.includes("@route"), shown: false, stable: 0, sig: "", placed: "", shownAt: 0 };
      return;
    }
  }
  function next() { if (open) { if (cur >= STEPS.length - 1) end(); else go(cur + 1, 1); } }
  function back() { if (open && cur > 0) go(cur - 1, -1); }

  function frame(now) {
    if (!open) return;
    raf = requestAnimationFrame(frame);
    if (!tr) return;
    const panel = $("#panel"), k = tr.dur ? Math.min(1, (now - tr.t0) / tr.dur) : 1, e = easeOut(k);
    if (tr.scroll) {   // the panel scrolls with the same easing (and again at the end, in case the sheet was still resizing)
      const v = tr.scroll.from + (tr.scroll.to - tr.scroll.from) * e;
      if (Math.abs(panel.scrollTop - v) >= 0.5) panel.scrollTop = v;
      if (k >= 1 && tr.shown) tr.scroll = null;
    }
    const target = measure(tr.specs);
    const n = Math.max(tr.from.length, target.length), hs = [];
    for (let j = 0; j < n; j++) {
      const a = tr.from[j], b = target[j];
      if (b) hs.push(k >= 1 ? b : mix(a || dot(b), b, e));
      else if (a && k < 1) hs.push(mix(a, dot(a), e));   // a highlight that's no longer needed shrinks away
    }
    holes = hs;
    draw(hs);
    // the card shows once the targets hold still (the sheet, panel and map have stopped moving)
    const sig = target.map((h) => (h ? `${Math.round(h.x)},${Math.round(h.y)},${Math.round(h.w)},${Math.round(h.h)}` : "-")).join("|");
    tr.stable = sig === tr.sig ? tr.stable + 1 : 0; tr.sig = sig;
    const camBusy = tr.waitCam && (now < tr.camUntil || P.map.isMoving());
    if (!tr.shown && ((now - tr.t0 > 120 && tr.stable >= 3 && !camBusy) || now - tr.t0 > 3000)) showCard(target, now);
    else if (tr.shown && tr.stable >= 3 && sig !== tr.placed && k >= 1) { place(target); tr.placed = sig; }   // something moved later: follow it
    settled = tr.shown && k >= 1 && now - tr.shownAt > 230 && tr.stable >= 3 && !camBusy && !card.getAnimations().some((a) => a.pending || a.playState === "running");
  }
  function showCard(target, now) {
    tr.shown = true; tr.shownAt = now; tr.placed = tr.sig;
    const [x, y] = place(target);
    card.style.opacity = "1";
    card.animate(reduced() ? [{ opacity: 0 }, { opacity: 1 }]
      : [{ opacity: 0, transform: `translate(${x}px, ${y + 8}px)` }, { opacity: 1, transform: `translate(${x}px, ${y}px)` }], { duration: 210, easing: EASE });
    if (!card.contains(document.activeElement)) card.focus({ preventScroll: true });   // the dialog itself: no ring on a button, never a text field
  }

  function onKey(e) {
    if (!open) return;
    const k = e.key, onButton = card.contains(document.activeElement) && document.activeElement.tagName === "BUTTON";
    if (k === "Escape") end();
    else if (k === "ArrowRight" || (k === "Enter" && !onButton)) next();
    else if (k === "ArrowLeft") back();
    else if (k === "Tab") { trapTab(e, card); return; }
    else return;
    e.preventDefault(); e.stopPropagation();
  }
  function onResize() {
    if (!open || !tr) return;
    if (P.isPhone() !== wasPhone) { wasPhone = P.isPhone(); go(cur); return; }   // phone and desktop layouts differ: set the step up again
    drawn = ""; tr.stable = 0; tr.placed = "";
  }
  function onLang() {
    setLinks();
    if (!open) return;
    if (demo) {   // the demo places' names follow the language
      const s = P.state;
      if (s.from && s.from[0] === DEMO.from[0]) P.setPoint("from", s.from, t("tourDemoFrom"));
      if (s.to && s.to[0] === DEMO.to[0]) P.setPoint("to", s.to, t("tourDemoTo"));
    }
    render(STEPS[cur]);
    if (tr) { tr.placed = ""; tr.stable = 0; }
  }

  // ------------------------------------------------------------------ start and end
  function start(i = 0) {
    if (!P || open || P.state.mode === "ride" || document.body.classList.contains("searching")) return false;
    if (!overlay) build();
    const a = document.activeElement;
    lastFocus = a && a !== document.body && !welcome.contains(a) ? a : null;
    orig = snapshot(); demo = false; open = true; wasPhone = P.isPhone(); gen++;
    P.openLayers(false);
    overlay.getAnimations().forEach((x) => x.cancel());
    overlay.hidden = false; drawn = "";
    holes = [{ x: -60, y: -60, w: innerWidth + 120, h: innerHeight + 120, r: 0 }];   // the dim closes in on the first target
    if (reduced()) overlay.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
    document.addEventListener("keydown", onKey, true);
    addEventListener("resize", onResize);
    go(Math.max(0, Math.min(STEPS.length - 1, i | 0)));
    cancelAnimationFrame(raf); raf = requestAnimationFrame(frame);
    return true;
  }
  function restore() {   // put back what the tour changed
    const s = P.state, o = orig, panel = $("#panel"), hadDemo = demo;
    if (demo) { for (const w of ["from", "to"]) { if (o[w]) P.setPoint(w, o[w], o[w + "Label"]); else P.clearPoint(w); } demo = false; }
    const tabMoved = s.tab !== o.tab || s.smode !== o.smode;
    if (s.smode !== o.smode) setSmode(o.smode);
    if (s.winter !== o.winter) P.setWinter(o.winter);
    if (tabMoved) P.setTab(o.tab);
    else if (hadDemo && s.tab === "go") P.computeRoutes(false);
    if (s.tab === "go" && s.sel !== o.sel && o.sel < s.routes.length) P.selectRoute(o.sel);
    $("#from").value = o.fromVal; $("#to").value = o.toVal;
    const lg = $("#legend details"); if (lg) lg.open = o.legend;
    P.openLayers(o.layers);
    if (P.isPhone()) P.setSheet(o.sheet);
    panel.scrollTop = o.scroll; setTimeout(() => { if (!open) panel.scrollTop = o.scroll; }, 360);   // again once the sheet has its size
    P.map.easeTo(Object.assign({}, o.cam, { duration: reduced() ? 0 : 600 }));
  }
  function end() {
    if (!open) return;
    open = false; tr = null; settled = false;
    cancelAnimationFrame(raf);
    document.removeEventListener("keydown", onKey, true);
    removeEventListener("resize", onResize);
    restore();
    const my = gen;   // fade out and hold there until hidden (start() cancels it)
    const a = overlay.animate([{ opacity: 1 }, { opacity: 0 }], { duration: reduced() ? 150 : 220, easing: "ease-out", fill: "forwards" });
    const hide = () => { if (my === gen && !open) { overlay.hidden = true; holes = []; } };
    a.onfinish = hide; a.oncancel = hide;
    if (visible(lastFocus) && !(P.isPhone() && /^(INPUT|TEXTAREA)$/.test(lastFocus.tagName))) lastFocus.focus({ preventScroll: true });
    else if (card.contains(document.activeElement)) document.activeElement.blur();
  }

  // for tests and screenshots: the step, its targets, the cut-outs and the card, as on screen
  function info() {
    const st = open ? STEPS[cur] : null, b = card && card.getBoundingClientRect();
    return { open, i: cur, id: st && st.id, n: STEPS.length, settled: open && settled, sheet: st && P.isPhone() ? P.sheet.state : null,
      targets: st ? specsOf(st).map((s) => ({ spec: Array.isArray(s) ? s.join(",") : s, rect: specRect(s) })).filter((x) => x.rect) : [],
      holes: open ? holes.map((h) => ({ x: h.x, y: h.y, w: h.w, h: h.h })) : [], card: b ? { x: b.left, y: b.top, w: b.width, h: b.height } : null,
      title: card ? card.querySelector("#tour-title").textContent : "", text: card ? card.querySelector("#tour-text").textContent : "", demo };
  }

  // ------------------------------------------------------------------ start-up, once the map is ready
  function init() {
    P = window.piste;
    setLinks();
    document.addEventListener("piste:lang", onLang);
    $("#welcome-tour").onclick = () => closeWelcome(true);
    $("#welcome-skip").onclick = () => closeWelcome(false);
    $("#tour-again").onclick = () => start(0);
    window.pisteTour = { start, next, back, end, info, steps: STEPS.map((s) => s.id), get welcome() { return welcomeState; } };
    const w = params.get("welcome");
    welcomeState = w === "1" || (w !== "0" && P.store.get("welcomed", "") !== "1" && P.state.mode !== "ride") ? "due" : "seen";
    if (welcomeState === "due") setTimeout(showWelcome, 250);
  }
  if (window.piste) init(); else document.addEventListener("piste:ready", init, { once: true });
})();
