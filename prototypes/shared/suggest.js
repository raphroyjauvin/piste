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

  // ---------------------------------------------------------------- local first (2026-11-03)
  // pois.js rows carry flags after the coordinates (tools/build_layers.py poi_tail): SKIP = a chain, fast food or a big-box shop
  // (still on the map, never suggested); REAL = a real destination (opening hours, a website or a cuisine), preferred when close.
  // BIXI rows use that slot for their capacity and metro rows for their lines, so only a number on another kind is a flag.
  const FLAGS = { SKIP: 1, REAL: 2 };
  const poiFlags = (p) => (typeof p[4] === "number" && p[0] !== "bixi" ? p[4] : 0);
  const REAL_EDGE = 0.1;      // a real destination counts as 10% of the ideal distance closer when the candidates are picked
  const REAL_SCORE = 0.03;    // and as 3 points more on bike paths when the rides are ranked: a tie-breaker, never a filter
  const OPEN_MARGIN = 15;     // minutes a place must stay open after you arrive

  // Opening hours: the common simple forms of OSM opening_hours. "24/7"; rules split by ";" (a later rule replaces the days it
  // names) or by "," before a new day list; a rule is [days] times | off | closed, with days such as Mo, Mo-Fr, Sa,Su or Fr-Mo
  // and times such as 07:00-18:00,19:00-23:00 (16:00-03:00 runs past midnight). A rule for public holidays only (PH) is left
  // out, since holidays aren't known here. Anything else (months, dates, sunrise, "||", comments) gives null: unknown, so kept.
  const DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
  const DAY = "(?:Mo|Tu|We|Th|Fr|Sa|Su|PH)";
  const DAY_LIST = new RegExp(`^${DAY}(?:-${DAY})?(?:,${DAY}(?:-${DAY})?)*$`);
  const ALWAYS = { always: true };
  function parseDays(sel) {   // "Mo-Fr,Su" -> [0, 1, 2, 3, 4, 6]; PH is dropped
    const out = new Set();
    for (const part of sel.split(",")) {
      const [a, b] = part.split("-");
      if (a === "PH") continue;
      if (b === "PH") return null;
      const i = DAYS.indexOf(a), j = b ? DAYS.indexOf(b) : i;
      for (let k = i; ; k = (k + 1) % 7) { out.add(k); if (k === j) break; }   // Fr-Mo wraps over the weekend
    }
    return [...out];
  }
  function parseTimes(s) {   // "07:00-12:00,13:00-01:00" -> [[420, 720], [780, 1500]] (minutes from that day's midnight)
    const out = [];
    for (const span of s.split(",")) {
      const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(span);
      if (!m) return null;
      const a = +m[1] * 60 + +m[2];
      let b = +m[3] * 60 + +m[4];
      if (+m[1] > 24 || +m[3] > 24 || +m[2] > 59 || +m[4] > 59) return null;
      if (b <= a) b += 1440;   // past midnight (and 00:00-24:00, 06:00-00:00)
      out.push([a, b]);
    }
    return out;
  }
  function parseHours(text) {
    const s = String(text || "").trim().replace(/\s+/g, " ").replace(/ ?([;,]) ?/g, "$1");   // "Sa, Su" -> "Sa,Su"
    if (!s) return null;
    if (s === "24/7") return ALWAYS;
    const week = DAYS.map(() => []);
    const rules = s.replace(/(\d|off|closed),(?=(?:Mo|Tu|We|Th|Fr|Sa|Su|PH)\b)/g, "$1;").split(";").filter(Boolean);
    for (const rule of rules) {
      const sp = rule.indexOf(" "), head = sp < 0 ? rule : rule.slice(0, sp);
      const hasDays = DAY_LIST.test(head);
      const days = hasDays ? parseDays(head) : [0, 1, 2, 3, 4, 5, 6];
      const what = (hasDays ? (sp < 0 ? "" : rule.slice(sp + 1)) : rule).replace(/ open$/, "").trim();
      if (!days || !what) return null;
      if (!days.length) continue;   // holidays only
      const times = what === "off" || what === "closed" ? [] : parseTimes(what);
      if (!times) return null;
      for (const d of days) week[d] = times;
    }
    return { week };
  }
  // the day (0 = Monday) and minute of the day in Montréal, wherever the phone thinks it is
  let mtlFmt = null;
  function mtlClock(date) {
    try {
      mtlFmt ??= new Intl.DateTimeFormat("en-US", { timeZone: "America/Toronto", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
      const p = Object.fromEntries(mtlFmt.formatToParts(date).map((x) => [x.type, x.value]));
      return { day: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday), min: (+p.hour % 24) * 60 + +p.minute };
    } catch (e) {   // no time-zone data: the phone's own clock
      return { day: (date.getDay() + 6) % 7, min: date.getHours() * 60 + date.getMinutes() };
    }
  }
  // open at that moment: true / false, or null when the hours are unknown
  function openAt(hours, date) {
    if (!hours) return null;
    if (hours.always) return true;
    const { day, min } = mtlClock(date), prev = (day + 6) % 7;
    return hours.week[day].some(([a, b]) => min >= a && min < b) || hours.week[prev].some(([, b]) => b > 1440 && min + 1440 < b);
  }
  // closed when you get there (or closing within OPEN_MARGIN minutes): only places with known hours ever are
  const parsed = new Map();   // opening_hours text -> its parse (many places share the same hours)
  function hoursOf(p) {
    if (typeof p[5] !== "string") return null;
    if (!parsed.has(p[5])) parsed.set(p[5], parseHours(p[5]));
    return parsed.get(p[5]);
  }
  function closedOnArrival(p, now, minutes) {
    const h = hoursOf(p), t = now.getTime() + minutes * 60e3;
    return !!h && !(openAt(h, new Date(t)) && openAt(h, new Date(t + OPEN_MARGIN * 60e3)));
  }
  // riding minutes for a distance (and climb), as the route cards count them
  const rideMin = (m, climb = 0) => (window.BikeCommon ? window.BikeCommon.rideMinutes({ length: m, climb }) : m / 1000 / 16 * 60 + climb / 10);

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

    // opts: { start: [lon, lat], km, loop, stop: STOP_KINDS key or "", weights: {w, hill}, windCost: route -> extra minutes (optional),
    //   now: Date (optional; when you leave, for opening hours) }
    // -> up to 3 suggestions: { route, title: {key, vars}, via, loop, end: {key, vars} }
    async suggest(opts) {
      const D = Math.max(1000, opts.km * 1000), now = opts.now || new Date();
      const cands = opts.stop ? await this._viaStop(opts, D, now)
        : opts.loop ? await this._loops(opts, D)
        : await this._toPlaces(opts.start, D / ROUTE_FACTOR, END_KINDS, false, opts.weights, now);
      for (const c of cands) {
        const off = Math.abs(c.route.length - D) / D;
        c.score = c.route.infraShare - 1.5 * off - 0.8 * (c.retrace || 0) + (c.poi && c.poi.real ? REAL_SCORE : 0);
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
    _viaStop({ start, loop, stop, weights }, D, now) {
      const kinds = (STOP_KINDS[stop] || {}).kinds || [];
      return this._toPlaces(start, loop ? D / (2 * ROUTE_FACTOR) : D / ROUTE_FACTOR, kinds, loop, weights, now);
    }

    // the places of these kinds a ride may go to: no chains, fast food or big-box shops (they stay on the map)
    candidates(kinds) {
      const out = [];
      this.pois.forEach((p, i) => { if (kinds.includes(p[0]) && !(poiFlags(p) & FLAGS.SKIP)) out.push(i); });
      return out;
    }

    // up to 36 places at about the right straight-line distance (real destinations first when close), spread around the compass,
    // open when you'd get there
    pick(start, ideal, kinds, now = new Date()) {
      const pool = [];
      for (const i of this.candidates(kinds)) {
        const p = this.pois[i], d = distM(start[0], start[1], p[2], p[3]);
        if (d < ideal * 0.5 || d > ideal * 1.5) continue;
        if (closedOnArrival(p, now, rideMin(d * ROUTE_FACTOR))) continue;   // a first guess at the riding time; checked again on the route
        pool.push({ i, kind: p[0], name: p[1], lon: p[2], lat: p[3], d, b: bearing(start[0], start[1], p[2], p[3]), real: !!(poiFlags(p) & FLAGS.REAL) });
      }
      const gap = (p) => Math.abs(p.d - ideal) - (p.real ? REAL_EDGE * ideal : 0);
      pool.sort((a, b) => gap(a) - gap(b));
      const perSector = new Map(), picked = [];
      for (const p of pool) {
        const s = Math.round(p.b / 45) % 8;
        if ((perSector.get(s) || 0) >= 5) continue;
        perSector.set(s, (perSector.get(s) || 0) + 1); picked.push(p);
        if (picked.length >= 36) break;
      }
      return picked;
    }

    // a ride to each picked place (out and back another way, for a loop); a place the route reaches after closing time is left out
    async _toPlaces(start, ideal, kinds, loop, weights, now = new Date()) {
      const picked = this.pick(start, ideal, kinds, now), out = [];
      for (let j = 0; j < picked.length; j++) {
        const p = picked[j];
        // unnamed places (most public toilets, many parks) are called by their kind: "Public restroom", "Park"
        const kindLabel = (window.BikeCommon && window.BikeCommon.poiLabel(p.kind)) || p.kind;
        const place = p.kind === "metro" ? { key: "metroOf", vars: { name: p.name } } : p.name ? { raw: p.name, kind: p.kind } : { poiKind: p.kind };
        const label = p.kind === "metro" ? `${p.name} metro` : p.name || kindLabel;
        const route = this.chain(loop ? [start, [p.lon, p.lat], start] : [start, [p.lon, p.lat]], loop ? [label] : [], weights);
        const at = route && (loop && route.stops && route.stops[0] ? route.stops[0].at : route && route.length);   // metres ridden to the place
        if (route && !closedOnArrival(this.pois[p.i], now, rideMin(at, (route.climb * at) / Math.max(1, route.length)))) {
          out.push({ route, poi: p, place, title: { key: loop ? "loopBy" : "toPlace", vars: { place } }, retrace: loop ? retraced(route) : 0 });
        }
        if (j % 6 === 5) await tick();
      }
      return out;
    }
  }

  window.BikeSuggest = { Suggester, STOP_KINDS, FLAGS, poiFlags, parseHours, openAt, closedOnArrival };
})();
