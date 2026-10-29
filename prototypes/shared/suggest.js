/* Ride suggestions ("suggest a ride"): loops and one-way rides of a chosen length, optionally through a stop of a
   chosen kind, on the same router and weights as normal routing. Classic script, exposes window.BikeSuggest.
   Titles come back as {key, vars} so the app can word them in English or French. */
(function () {
  "use strict";
  const { distM, bearing } = window.BikeRouter;
  const D2R = Math.PI / 180;

  // what each stop choice matches in the POI list (kinds from tools/build_layers.py); labels live in i18n.js (stop_<key>)
  const STOP_KINDS = {
    cafe: { kinds: ["cafe"] },
    food: { kinds: ["food"] },
    bakery: { kinds: ["bakery"] },
    icecream: { kinds: ["icecream"] },
    bar: { kinds: ["bar"] },
    toilets: { kinds: ["toilets"] },
    park: { kinds: ["park", "viewpoint"] },
    culture: { kinds: ["culture"] },
    bikeshop: { kinds: ["bikeshop", "repair"] },
  };
  // a one-way ride with no stop ends where getting home is easy (metro) or somewhere pleasant
  const END_KINDS = ["metro", "park", "viewpoint"];
  const ROUTE_FACTOR = 1.25;   // a bike route is ~25% longer than the straight line here
  const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const compass = (b) => COMPASS[Math.round((((b % 360) + 360) % 360) / 45) % 8];
  const tick = () => new Promise((r) => setTimeout(r, 0));   // let the page breathe between batches of routing

  // point d metres from (lon, lat) toward bearing b (degrees)
  function offset(lon, lat, d, b) {
    return [lon + (d * Math.sin(b * D2R)) / (111320 * Math.cos(lat * D2R)), lat + (d * Math.cos(b * D2R)) / 110540];
  }
  // share of a ride spent on streets it already used
  function retraced(route) {
    const seen = new Set(); let dup = 0;
    for (const l of route.legs) { if (seen.has(l.e)) dup += l.len || 0; else seen.add(l.e); }
    return route.length ? dup / route.length : 0;
  }
  function overlap(a, b) {
    let c = 0; for (const e of a.sig) if (b.sig.has(e)) c++;
    return c / Math.max(1, Math.min(a.sig.size, b.sig.size));
  }
  function mainStreets(route, n = 2) {
    const by = new Map();
    for (const l of route.legs) if (l.name && l.name !== "path" && l.name !== "Bike path" && l.name !== "Multi-use path") by.set(l.name, (by.get(l.name) || 0) + (l.len || 0));
    return [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map((e) => e[0]);
  }

  class Suggester {
    constructor(router, pois) { this.router = router; this.pois = pois; }

    // Ride through the points in order. Later legs avoid streets already ridden (4x cost), so a loop comes back another way.
    // labels[i] names a real stop after leg i (it becomes a "Stop: …" instruction); waypoints have none.
    chain(points, labels, weights) {
      const r = this.router, pen = new Float32Array(r.m).fill(1), parts = [];
      for (let i = 1; i < points.length; i++) {
        const part = r.route(points[i - 1], points[i], Object.assign({}, weights, { penalty: pen }));
        if (!part) return null;
        for (const l of part.legs) pen[l.e] = 4;
        parts.push(part);
      }
      const route = parts.length === 1 ? parts[0] : r.join(parts, labels || []);
      route.sig = new Set(route.legs.map((l) => l.e));
      return route;
    }

    // opts: { start: [lon, lat], km, loop, stop: STOP_KINDS key or "", weights: {w, hill}, windCost: route -> extra minutes (optional) }
    // -> up to 3 suggestions: { route, title: {key, vars}, via, loop, end: {key, vars} }
    async suggest(opts) {
      const D = Math.max(1000, opts.km * 1000);
      const cands = opts.stop ? await this._viaStop(opts, D)
        : opts.loop ? await this._loops(opts, D)
        : await this._toPlaces(opts.start, D / ROUTE_FACTOR, END_KINDS, false, opts.weights);
      for (const c of cands) {
        const off = Math.abs(c.route.length - D) / D;
        c.score = c.route.infraShare - 1.5 * off - 0.8 * (c.retrace || 0);
        // avoid headwinds: extra minutes lost to the wind count against a ride, relative to its length
        if (opts.windCost) {
          const w = opts.windCost(c.route);
          c.wind = w;
          c.score -= 2.5 * Math.max(0, w.minutes) / Math.max(10, w.baseMinutes);
          if (c.loop !== false && opts.loop) c.score += 0.08 * (w.firstHalfHead - w.secondHalfHead);   // into the wind first, wind at your back home
        }
      }
      cands.sort((a, b) => b.score - a.score);
      const pick = [];
      for (const c of cands) {
        if (pick.length === 3) break;
        if (pick.some((p) => overlap(p.route, c.route) > 0.45 || (p.poi && c.poi && p.poi.i === c.poi.i))) continue;
        pick.push(c);
      }
      for (const c of pick) {
        c.via = mainStreets(c.route);
        c.loop = !!opts.loop;
        c.end = opts.loop ? { key: "yourStart" } : c.poi ? c.place : { key: "destination" };
      }
      return pick;
    }

    // loops with no stop: a circle through the start, tried in 8 directions, resized until its length fits
    async _loops({ start, weights }, D) {
      const out = [];
      for (let k = 0; k < 8; k++) {
        const theta = k * 45;
        let R = D / (2 * Math.PI * ROUTE_FACTOR), best = null;
        for (let iter = 0; iter < 3; iter++) {
          const c = offset(start[0], start[1], R, theta), back = theta + 180;
          const route = this.chain([start, offset(c[0], c[1], R, back + 120), offset(c[0], c[1], R, back + 240), start], [], weights);
          if (!route) break;
          if (!best || Math.abs(route.length - D) < Math.abs(best.length - D)) best = route;
          const ratio = D / route.length;
          if (Math.abs(1 - ratio) < 0.07) break;
          R *= Math.max(0.6, Math.min(1.6, ratio));
        }
        if (best) out.push({ route: best, title: { key: "loopDir", vars: { dirKey: compass(theta) } }, retrace: retraced(best) });
        await tick();
      }
      return out;
    }

    // through a stop: out to it and (for a loop) back another way
    _viaStop({ start, loop, stop, weights }, D) {
      const kinds = (STOP_KINDS[stop] || {}).kinds || [];
      return this._toPlaces(start, loop ? D / (2 * ROUTE_FACTOR) : D / ROUTE_FACTOR, kinds, loop, weights);
    }

    // candidate places at about the right straight-line distance, spread around the compass
    async _toPlaces(start, ideal, kinds, loop, weights) {
      const pool = [];
      this.pois.forEach((p, i) => {
        if (!kinds.includes(p[0])) return;
        const d = distM(start[0], start[1], p[2], p[3]);
        if (d < ideal * 0.5 || d > ideal * 1.5) return;
        pool.push({ i, kind: p[0], name: p[1], lon: p[2], lat: p[3], d, b: bearing(start[0], start[1], p[2], p[3]) });
      });
      pool.sort((a, b) => Math.abs(a.d - ideal) - Math.abs(b.d - ideal));
      const perSector = new Map(), picked = [];
      for (const p of pool) {
        const s = Math.round(p.b / 45) % 8;
        if ((perSector.get(s) || 0) >= 5) continue;
        perSector.set(s, (perSector.get(s) || 0) + 1); picked.push(p);
        if (picked.length >= 36) break;
      }
      const out = [];
      for (let j = 0; j < picked.length; j++) {
        const p = picked[j];
        // unnamed places (most public toilets, many parks) are called by their kind: "Public restroom", "Park"
        const kindLabel = (window.BikeCommon && window.BikeCommon.poiLabel(p.kind)) || p.kind;
        const place = p.kind === "metro" ? { key: "metroOf", vars: { name: p.name } } : p.name ? { raw: p.name, kind: p.kind } : { poiKind: p.kind };
        const label = p.kind === "metro" ? `${p.name} metro` : p.name || kindLabel;
        const route = this.chain(loop ? [start, [p.lon, p.lat], start] : [start, [p.lon, p.lat]], loop ? [label] : [], weights);
        if (route) out.push({ route, poi: p, place, title: { key: loop ? "loopBy" : "toPlace", vars: { place } }, retrace: loop ? retraced(route) : 0 });
        if (j % 6 === 5) await tick();
      }
      return out;
    }
  }

  window.BikeSuggest = { Suggester, STOP_KINDS };
})();
