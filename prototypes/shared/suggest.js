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
  const LOOP_TRIES = 7;       // shapes tried per direction before the least faulty one is kept
  const TURN_STEP = 15;       // degrees a loop is swung when it turns back on itself
  // The circle radius to try next so a ride of length len comes out at D: in proportion, or along the line through the last two
  // tries; if a bigger circle gave the same ride (the waypoints snapped to the same intersections), a bigger step.
  function nextRadius(R, len, D, prev) {
    let next = R * D / len;
    if (prev && Math.abs(len - prev.len) > 50) { const slope = (R - prev.R) / (len - prev.len); if (slope > 0) next = R + (D - len) * slope; }
    else if (prev) next = R * (D / len) ** 3;
    return Math.max(0.6 * R, Math.min(1.6 * R, next));
  }
  const CALIBRATE_N = 8;      // places ridden first to learn how much longer than the straight line a ride is here
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
  // share of a ride spent on streets it already used (either way)
  function retraced(route) {
    const seen = new Set(); let dup = 0;
    for (const l of route.legs) { if (seen.has(l.e)) dup += l.len || 0; else seen.add(l.e); }
    return route.length ? dup / route.length : 0;
  }
  // heading (degrees) of a leg where it starts or ends, over its first or last HEADING_M metres (less on a short street)
  const HEADING_M = 25;
  function legHeading(router, l, atEnd) {
    const pts = router.edgeCoords(l.e, !!l.fwd), i = atEnd ? pts.length - 1 : 0, step = atEnd ? -1 : 1;
    let j = i + step;
    while (j + step >= 0 && j + step < pts.length && distM(pts[i][0], pts[i][1], pts[j][0], pts[j][1]) < HEADING_M) j += step;
    if (distM(pts[i][0], pts[i][1], pts[j][0], pts[j][1]) < 1) return null;
    return atEnd ? bearing(pts[j][0], pts[j][1], pts[i][0], pts[i][1]) : bearing(pts[i][0], pts[i][1], pts[j][0], pts[j][1]);
  }
  // U-turns: a leg that goes back onto the street just ridden, or leaves an intersection almost the way it arrived
  const U_TURN_DEG = 160;
  function turnbacks(router, route) {
    let n = 0; const L = route.legs;
    for (let i = 1; i < L.length; i++) {
      if (L[i].e === L[i - 1].e) { if (L[i].fwd !== L[i - 1].fwd) n++; continue; }
      const a = legHeading(router, L[i - 1], true), b = legHeading(router, L[i], false);
      if (a !== null && b !== null && 180 - Math.abs(180 - ((((b - a) % 360) + 360) % 360)) >= U_TURN_DEG) n++;
    }
    return n;
  }
  // A ride may be this far (metres) off the asked length, either way (Raph, 2026-11-08): it never needs padding to fit.
  // A very short ride gets a quarter of its length instead.
  const LENGTH_TOL = 500;
  const tolM = (D) => Math.min(LENGTH_TOL, D / 4);
  // what is wrong with a ride, and what that costs in the ranking: a U-turn outweighs any gain in bike-path share
  function faults(router, route, D) {
    return { turns: turnbacks(router, route), retrace: retraced(route), excess: Math.max(0, Math.abs(route.length - D) - tolM(D)) };
  }
  const faultCost = (f, D) => 3 * f.turns + 4 * f.retrace + (8 * f.excess) / D;
  const isClean = (f) => f.turns === 0 && f.retrace < 0.02 && f.excess === 0;
  function overlap(a, b) {
    let c = 0; for (const e of a.sig) if (b.sig.has(e)) c++;
    return c / Math.max(1, Math.min(a.sig.size, b.sig.size));
  }
  function mainStreets(route, n = 2) {
    const by = new Map();
    for (const l of route.legs) if (l.name && l.name !== "path" && l.name !== "Bike path" && l.name !== "Multi-use path") by.set(l.name, (by.get(l.name) || 0) + (l.len || 0));
    return [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map((e) => e[0]);
  }

  // how a place is named in a ride's title and in its "Stop: …" line: unnamed places (most public toilets, many parks) are called by
  // their kind: "Public restroom", "Park"
  function placeOf(p) {
    const kindLabel = (window.BikeCommon && window.BikeCommon.poiLabel(p.kind)) || p.kind;
    return { place: p.kind === "metro" ? { key: "metroOf", vars: { name: p.name } } : p.name ? { raw: p.name, kind: p.kind } : { poiKind: p.kind },
      label: p.kind === "metro" ? `${p.name} metro` : p.name || kindLabel };
  }

  class Suggester {
    constructor(router, pois) { this.router = router; this.pois = pois; }

    // A point to ride through near `pt`: the closest intersection where the ride can go on in more than one direction. A waypoint
    // on a dead end or mid-block makes the ride turn round there (a spur); at an intersection it just carries on.
    junction(pt) {
      const r = this.router; let best = null;
      for (const c of r.snapCandidates(pt[0], pt[1], 400, 150, 16)) {
        for (const u of [r.ea[c.e], r.eb[c.e]]) {
          const d = distM(pt[0], pt[1], r.lon[u], r.lat[u]);
          if (r.off[u + 1] - r.off[u] >= 3 && (!best || d < best.d)) best = { d, p: [r.lon[u], r.lat[u]] };
        }
      }
      return best && best.d <= 400 ? best.p : pt;
    }

    // Ride through the points in order. Later legs avoid streets already ridden (6x cost), so a loop comes back another way.
    // labels[i] names a real stop after leg i (it becomes a "Stop: …" instruction); waypoints have none.
    chain(points, labels, weights) {
      const r = this.router, pen = new Float32Array(r.m).fill(1), parts = [];
      for (let i = 1; i < points.length; i++) {
        const part = r.route(points[i - 1], points[i], Object.assign({}, weights, { penalty: pen }));
        if (!part) return null;
        for (const l of part.legs) pen[l.e] = 6;
        parts.push(part);
      }
      const route = parts.length === 1 ? parts[0] : r.join(parts, labels || []);
      route.sig = new Set(route.legs.map((l) => l.e));
      route.pts = points;   // 2026-11-09: what it was ridden through, so a shared link can rebuild this very ride (rebuild, below)
      return route;
    }

    // 2026-11-09: a ride shared by link, made again from its start and the points it goes through (route.pts without the start, and
    // without the start again at the end of a loop). The same points, weights and "avoid streets already ridden" rule give the same ride;
    // nothing here reads the wind, the clock or the opening hours. -> { route, title, via, loop, end }, or null when it cannot be ridden
    rebuild({ start, via, loop, stop, weights }) {
      const kinds = stop ? (STOP_KINDS[stop] || {}).kinds : loop ? null : END_KINDS;
      let poi = null;   // the place the ride goes to: the closest one of that kind within 80 m of the first point
      if (kinds && via.length) {
        let best = 80;
        for (const i of this.candidates(kinds)) { const p = this.pois[i], d = distM(via[0][0], via[0][1], p[2], p[3]); if (d < best) { best = d; poi = { kind: p[0], name: p[1] }; } }
      }
      const pts = [start, ...via, ...(loop ? [start] : [])], named = stop && poi ? placeOf(poi) : null;
      const route = this.chain(pts, pts.slice(1, -1).map((_, i) => (i === 0 && named ? named.label : null)), weights);
      if (!route) return null;
      const place = poi ? placeOf(poi).place : { key: "destination" };
      const mid = [0, 1].map((k) => via.reduce((sum, v) => sum + v[k], 0) / via.length);   // a loop's two points lie either side of the way out: their middle is its direction
      const title = loop ? (named ? { key: "loopBy", vars: { place } } : { key: "loopDir", vars: { dirKey: compass(bearing(start[0], start[1], mid[0], mid[1])) } })
        : { key: "toPlace", vars: { place } };
      return { route, title, via: mainStreets(route), loop: !!loop, end: loop ? { key: "yourStart" } : poi ? place : { key: "destination" } };
    }

    // opts: { start: [lon, lat], km, loop, stop: STOP_KINDS key or "", weights: {w, hill}, windCost: route -> extra minutes (optional),
    //   now: Date (optional; when you leave, for opening hours) }
    // -> up to 3 suggestions: { route, title: {key, vars}, via, loop, end: {key, vars} }
    async suggest(opts) {
      const D = Math.max(1000, opts.km * 1000), now = opts.now || new Date();
      const cands = opts.stop ? await this._viaStop(opts, D, now)
        : opts.loop ? await this._loops(opts, D)
        : await this._toPlaces(opts.start, D, END_KINDS, false, opts.weights, now);
      for (const c of cands) {
        c.faults ||= faults(this.router, c.route, D);
        c.score = c.route.infraShare - faultCost(c.faults, D) + (c.poi && c.poi.real ? REAL_SCORE : 0);
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

    // loops with no stop: a circle through the start, tried in 8 directions. Each is resized until its length is within the
    // tolerance and, if it still turns back on itself, swung a little: never padded with a detour.
    async _loops({ start, weights }, D) {
      const out = [];
      for (let k = 0; k < 8; k++) {
        const best = this._loop(start, k * 45, D, weights);
        if (best) out.push({ route: best.route, faults: best.f, title: { key: "loopDir", vars: { dirKey: compass(k * 45) } } });
        await tick();
      }
      return out;
    }
    _loop(start, theta0, D, weights) {
      let R = D / (2 * Math.PI * ROUTE_FACTOR), theta = theta0, swings = 0, best = null, prev = null;
      for (let iter = 0; iter < LOOP_TRIES; iter++) {
        const c = offset(start[0], start[1], R, theta), back = theta + 180;
        const via = [120, 240].map((a) => this.junction(offset(c[0], c[1], R, back + a)));
        const route = this.chain([start, ...via, start], [], weights);
        if (!route) break;
        const f = faults(this.router, route, D);
        if (!best || faultCost(f, D) < faultCost(best.f, D)) best = { route, f };
        if (isClean(f)) break;
        if (f.excess) { const next = nextRadius(R, route.length, D, prev); prev = { R, len: route.length }; R = next; }
        else { swings++; theta = theta0 + (swings % 2 ? 1 : -1) * TURN_STEP * Math.ceil(swings / 2); }   // the right length but a spur: swing the circle and look again
      }
      return best;
    }

    // through a stop: out to it and (for a loop) back another way
    _viaStop({ start, loop, stop, weights }, D, now) {
      return this._toPlaces(start, D, (STOP_KINDS[stop] || {}).kinds || [], loop, weights, now);
    }

    // start -> place -> start. If coming back turns round or retraces the way out, try a waypoint to the side of the way out
    // (each side) so the return takes another street; the cleanest ride is kept.
    _outAndBack(start, p, label, D, weights) {
      let best = null;
      const consider = (via) => {
        const route = this.chain(via ? [start, [p.lon, p.lat], via, start] : [start, [p.lon, p.lat], start], via ? [label, null] : [label], weights);
        if (!route) return false;
        const f = faults(this.router, route, D);
        if (!best || faultCost(f, D) < faultCost(best.f, D)) best = { route, f };
        return isClean(f);
      };
      if (consider(null)) return best;
      const mid = [(start[0] + p.lon) / 2, (start[1] + p.lat) / 2], side = Math.max(300, p.d * 0.4);
      for (const turn of [90, -90]) if (consider(this.junction(offset(mid[0], mid[1], side, p.b + turn)))) break;
      return best;
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

    // The ride to one picked place (out and back another way, for a loop), or null: no route, or the place is shut by the time you get there.
    _rideTo(start, p, loop, D, weights, now) {
      // unnamed places (most public toilets, many parks) are called by their kind: "Public restroom", "Park"
      const { place, label } = placeOf(p);
      const made = loop ? this._outAndBack(start, p, label, D, weights) : { route: this.chain([start, [p.lon, p.lat]], [], weights) };
      const route = made && made.route;
      if (!route) return null;
      const at = loop && route.stops && route.stops[0] ? route.stops[0].at : route.length;   // metres ridden to the place
      if (closedOnArrival(this.pois[p.i], now, rideMin(at, (route.climb * at) / Math.max(1, route.length)))) return null;
      return { route, poi: p, place, title: { key: loop ? "loopBy" : "toPlace", vars: { place } }, faults: made.f };
    }

    // A ride to each picked place. Places are first picked by a guess of how much longer than the straight line a ride is; the
    // nearest few are ridden and show how winding the streets here really are, and the places are picked again by that.
    async _toPlaces(start, D, kinds, loop, weights, now = new Date()) {
      const legs = loop ? 2 : 1, out = [], done = new Set();
      const ride = async (picks) => {
        for (let j = 0; j < picks.length; j++) {
          done.add(picks[j].i);
          const c = this._rideTo(start, picks[j], loop, D, weights, now);
          if (c) out.push(c);
          if (j % 6 === 5) await tick();
        }
      };
      await ride(this.pick(start, D / legs / ROUTE_FACTOR, kinds, now).slice(0, CALIBRATE_N));
      const ratios = out.map((c) => c.route.length / legs / c.poi.d).sort((x, y) => x - y);
      const factor = ratios.length >= 3 ? ratios[ratios.length >> 1] : ROUTE_FACTOR;
      await ride(this.pick(start, D / legs / factor, kinds, now).filter((p) => !done.has(p.i)));
      return out;
    }
  }

  window.BikeSuggest = { Suggester, STOP_KINDS, FLAGS, poiFlags, parseHours, openAt, closedOnArrival, turnbacks, retraced, faults, LENGTH_TOL };
})();
