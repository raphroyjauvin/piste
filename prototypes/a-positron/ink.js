/* Piste: the "inked drawing" hints (2026-11-09). Loaded before app.js; app.js only calls PisteInk.pop() when the turn instruction changes.
 *  - A hand-inked outline on the route card, the chosen classic ride's card and the ride card: two SVG pen passes that bow a little and overlap at the start without quite meeting. Seeded, so the line is the same at every
 *    draw (no shimmer). It draws itself on once, when a card appears where there was none or a different route/ride is shown; a re-render of
 *    the same card (a slider move) and a resize redraw it at once. Nothing here runs per ride frame: it reacts to the page changing and to
 *    a card changing size, a few times at most.
 *  - Without this file (or with an error) the cards keep their ordinary CSS border: the outline's colour is only hidden once the pen is on.
 */
(function () {
  "use strict";
  const NS = "http://www.w3.org/2000/svg";
  const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  // a seeded random (mulberry32): same seed, same line
  const rng = (seed) => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const f = (n) => n.toFixed(1);

  // One pass round a rounded box: four sides that bow a little, corners as curves. It starts a little before its first corner and runs a
  // little past it, so the two ends overlap without quite meeting (where the pen came down and lifted).
  function pass(w, h, r, j, rnd, overlap) {
    const q = () => (rnd() - 0.5) * 2 * j;
    const side = (x1, y1, x2, y2) => `Q${f((x1 + x2) / 2 + q())} ${f((y1 + y2) / 2 + q())} ${f(x2 + q() * 0.4)} ${f(y2 + q() * 0.4)}`;
    const k = r * 0.45, x0 = r + 6;   // k: the corner curve's handle
    let d = `M${f(x0)} ${f(q() * 0.3)}` + side(x0, 0, w - r, 0) + `C${f(w - k)} 0 ${f(w)} ${f(k)} ${f(w)} ${f(r)}`;
    d += side(w, r, w, h - r) + `C${f(w)} ${f(h - k)} ${f(w - k)} ${f(h)} ${f(w - r)} ${f(h)}`;
    d += side(w - r, h, r, h) + `C${f(k)} ${f(h)} 0 ${f(h - k)} 0 ${f(h - r)}`;
    d += side(0, h - r, 0, r) + `C0 ${f(k)} ${f(k)} 0.5 ${f(r)} 0.9` + `L${f(x0 + overlap)} ${f(1.9 + q() * 0.3)}`;
    return d;
  }
  // [path, stroke width, opacity] for a box of this size: a firm pass and a thin, fainter second pass
  function boxPaths(w, h, r, seed) {
    const rnd = rng(seed * 7919 + 13);
    return [[pass(w, h, r, 0.5, rnd, 12), 1.6, 1], [pass(w, h, r, 1.1, rnd, 20), 0.85, 0.5]];
  }
  // The cards that carry an outline. key says which card this is: a new key is a new card (it draws on), the same key is the same card
  // drawn again (it does not). The route card's key is stamped by app.js (data-ink on #routes: the trip, or the suggested rides).
  const SLOTS = [
    { name: "route", sel: "#routes div.route-card", seed: 1, key: (el) => el.parentElement.dataset.ink || "" },
    { name: "classic", sel: ".classic-card.sel", seed: 2, key: (el) => el.dataset.i },
    { name: "ride", sel: ".ride-bar", seed: 3, key: () => "ride" },
  ];
  const state = new WeakMap();   // card -> { svg, w, h }
  const lastKeys = {};           // slot name -> the keys showing at the previous look
  const ro = new ResizeObserver(() => schedule());

  function build(el) {
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "ink-svg"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
    for (let i = 0; i < 2; i++) { const p = document.createElementNS(NS, "path"); p.setAttribute("pathLength", "1"); svg.appendChild(p); }
    el.appendChild(svg);
    state.set(el, { svg, w: 0, h: 0 });
    ro.observe(el);
  }
  // set (or reset) the lines for the card's current size; the svg sits over the card's border box, and the line is held 1.6px inside it so
  // that cards with overflow: hidden do not trim it
  function shape(el, slot) {
    const s = state.get(el), w = el.offsetWidth, h = el.offsetHeight;
    if (w === s.w && h === s.h) return false;
    s.w = w; s.h = h;
    const bw = parseFloat(getComputedStyle(el).borderTopWidth) || 0, inset = 1.6;
    const r = Math.min(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 4, 14);
    const list = boxPaths(w - 2 * inset, h - 2 * inset, r, slot.seed);
    s.svg.setAttribute("width", w); s.svg.setAttribute("height", h);
    s.svg.style.left = s.svg.style.top = -bw + "px";
    s.svg.querySelectorAll("path").forEach((p, i) => {
      p.setAttribute("d", list[i][0]); p.setAttribute("stroke-width", list[i][1]); p.setAttribute("opacity", list[i][2]);
      p.setAttribute("transform", `translate(${inset} ${inset})`);
    });
    return true;
  }
  // the draw-on: each pass is drawn by moving a dash along it (pathLength 1, so it works at any size); once done, the line is simply there
  function drawOn(svg) {
    svg.dataset.draw = "on";
    svg.querySelectorAll("path").forEach((p, i) => p.animate(
      [{ strokeDasharray: 1, strokeDashoffset: 1 }, { strokeDasharray: 1, strokeDashoffset: 0 }],
      { duration: 380 - i * 40, delay: i * 80, easing: "cubic-bezier(.3,.7,.3,1)", fill: "backwards" }));
  }

  function look() {
    queued = false;
    const live = new Set();
    for (const slot of SLOTS) {
      const els = [...document.querySelectorAll(slot.sel)].filter((el) => el.getClientRects().length);
      const before = lastKeys[slot.name] || new Set(), now = new Set();
      for (const el of els) {
        const key = slot.key(el); now.add(key); live.add(el);
        let fresh = false;
        if (!state.has(el)) { build(el); fresh = !before.has(key) && !calm(); }
        const drew = shape(el, slot);
        if (drew) { if (fresh) drawOn(state.get(el).svg); else state.get(el).svg.dataset.draw = state.get(el).svg.dataset.draw || "at once"; }
        el.classList.add("ink-on");
      }
      lastKeys[slot.name] = now;
    }
    // a card that is no longer one of the inked ones (another classic ride chosen) gives its border back
    document.querySelectorAll(".ink-on").forEach((el) => { if (!live.has(el)) { el.classList.remove("ink-on"); const s = state.get(el); if (s) { s.svg.remove(); state.delete(el); ro.unobserve(el); } } });
  }
  let queued = false;
  function schedule() { if (!queued) { queued = true; requestAnimationFrame(look); } }

  // the cards are rewritten as a whole when the route, the chosen ride or the language changes (childList); a size change is the observer's
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  addEventListener("resize", schedule);
  schedule();

  // The turn distance pops once when the instruction changes to a new one (not when only the distance counts down). Not with reduced motion.
  function pop() {
    if (calm()) return;
    const el = document.getElementById("turn-dist"); if (!el) return;
    el.classList.remove("turn-pop"); void el.offsetWidth; el.classList.add("turn-pop");
  }
  window.PisteInk = { pop };
})();
