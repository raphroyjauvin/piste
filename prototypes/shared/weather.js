/* Wind, rain and snow for the app: Open-Meteo forecast (no key, CORS open), the wind's effect along a route, and the moving
   wind streaks, rain lines and snow flakes drawn over the map. Classic script: window.BikeWeather. */
(function () {
  "use strict";
  const { bearing } = window.BikeRouter;
  const D2R = Math.PI / 180;
  const URL_WX = "https://api.open-meteo.com/v1/forecast?latitude=45.52&longitude=-73.58" +
    "&current=temperature_2m,precipitation,rain,snowfall,wind_speed_10m,wind_direction_10m,wind_gusts_10m,weather_code" +
    "&hourly=precipitation,precipitation_probability,snowfall,snow_depth,temperature_2m" +
    "&past_days=1&forecast_days=2&wind_speed_unit=kmh&timezone=America%2FToronto";

  let cache = null, cachedAt = 0, pending = null;
  async function load(force = false) {
    if (!force && cache && Date.now() - cachedAt < 10 * 60e3) return cache;
    if (pending) return pending;
    pending = fetch(URL_WX).then((r) => { if (!r.ok) throw new Error("weather " + r.status); return r.json(); })
      .then((j) => { cache = parse(j); cachedAt = Date.now(); return cache; })
      .finally(() => { pending = null; });
    return pending;
  }
  // Demo weather for checking the animations on a phone (2026-11-04): ?wx=rain or ?wx=snow, optional &wind=<km/h> (default 0, calm),
  // &from=<N, NE, E, SE, S, SW, W, NW or degrees> (where the wind comes from, default W) and &mm=<per hour> (default 2 rain, 1 snow).
  // Only that page load; the card says "Demo weather". Returns null without ?wx=rain|snow.
  const COMPASS = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };
  function demo(params) {
    const kind = params.get("wx");
    if (kind !== "rain" && kind !== "snow") return null;
    const num = (k, d, lo, hi) => { const v = parseFloat(params.get(k)); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
    const f = (params.get("from") || "W").toUpperCase(), dir = f in COMPASS ? COMPASS[f] : num("from", 270, 0, 360) % 360;
    const wind = num("wind", 0, 0, 80), mm = num("mm", kind === "snow" ? 1 : 2, 0.1, 30), q = mm / 4;   // Open-Meteo's "current" values are per 15 min
    const snow = kind === "snow";
    return { demo: true, now: { time: "", temp: snow ? -4 : 9, precip: q, rain: snow ? 0 : q, snow: snow ? q : 0, wind, dir, gust: Math.round(wind * 1.4), code: snow ? 73 : 63 },
      next: [], snow24: snow ? 3 : 0, depth: null, icy: false };
  }
  function parse(j) {
    const c = j.current, h = j.hourly;
    const nowIdx = Math.max(0, h.time.findIndex((t) => t > c.time) - 1);   // local ISO strings sort correctly
    const hours = h.time.map((t, i) => ({ t, hour: t.slice(11, 16), precip: h.precipitation[i] || 0, prob: h.precipitation_probability[i] ?? null,
      snow: h.snowfall[i] || 0, depth: h.snow_depth ? h.snow_depth[i] : null, temp: h.temperature_2m[i] }));
    const past24 = hours.slice(Math.max(0, nowIdx - 23), nowIdx + 1);
    const temps = past24.map((x) => x.temp).filter((v) => v !== null);
    return {
      now: { time: c.time, temp: c.temperature_2m, precip: c.precipitation, rain: c.rain, snow: c.snowfall, wind: c.wind_speed_10m,
        dir: c.wind_direction_10m, gust: c.wind_gusts_10m, code: c.weather_code },
      next: hours.slice(nowIdx + 1, nowIdx + 7),
      snow24: past24.reduce((a, x) => a + x.snow, 0),
      depth: hours[nowIdx] ? hours[nowIdx].depth : null,
      // freeze–thaw: above and below 0 °C in the last day, or freezing rain/drizzle now (WMO 56, 57, 66, 67)
      icy: (temps.length && Math.min(...temps) < -0.5 && Math.max(...temps) > 0.5) || [56, 57, 66, 67].includes(c.weather_code),
    };
  }

  // Rain outlook: now, or the first hour in the next 6 with rain likely
  function rainOutlook(wx) {
    if (wx.now.precip >= 0.1 || wx.now.rain >= 0.1) return { now: true, mm: Math.max(wx.now.precip, wx.now.rain) * 4 };   // 15-min value -> per hour
    const h = wx.next.find((x) => x.precip >= 0.2 || (x.prob ?? 0) >= 50);
    return h ? { at: h.hour, prob: h.prob } : { dryHours: wx.next.length };
  }

  // What falls right now, from Open-Meteo's current values (snow wins when both show): snow if snowfall > 0 or WMO code 71-77 / 85-86
  // (snow, snow showers); rain if rain > 0 or code 51-67 / 80-82 (drizzle, rain, freezing rain, showers, so the data says rain).
  // Precipitation with no type at all (only the total is above 0) is rain, and snow in winter mode (2026-11-03: Raph's call).
  // rate is per hour (the current values are 15-minute amounts, like rainOutlook): mm of rain, cm of snow (an untyped total in mm is
  // about 0.7 cm of snow, Open-Meteo's own 7 cm = 10 mm). Returns null when nothing falls.
  const codeIn = (c, ranges) => ranges.some(([a, b]) => c >= a && c <= b);
  function precipNow(wx, winter = false) {
    const n = wx && wx.now; if (!n) return null;
    const code = Number.isFinite(n.code) ? n.code : -1;
    if (n.snow > 0 || codeIn(code, [[71, 77], [85, 86]])) return { kind: "snow", rate: (n.snow || 0) * 4 };
    if (n.rain > 0 || codeIn(code, [[51, 67], [80, 82]])) return { kind: "rain", rate: Math.max(n.rain || 0, n.precip || 0) * 4 };
    if (n.precip > 0) return winter ? { kind: "snow", rate: n.precip * 4 * 0.7 } : { kind: "rain", rate: n.precip * 4 };
    return null;
  }
  // Snow outlook for winter mode's card: snowing now, or the first hour in the next 6 with snow likely
  function snowOutlook(wx, winter = false) {
    const p = precipNow(wx, winter);
    if (p && p.kind === "snow") return { now: true, cm: p.rate };
    const h = wx.next.find((x) => x.snow >= 0.1 || ((x.prob ?? 0) >= 50 && x.temp <= 0.5));
    return h ? { at: h.hour, prob: h.prob } : { dryHours: wx.next.length };
  }

  // ---- wind along a route --------------------------------------------------------------------------------
  // Speed holding the effort of a 16 km/h ride in still air against a head component h (m/s; negative = tailwind).
  // Upright commuter: CdA 0.6 m², rolling 0.006, 90 kg with bike. Tailwind gains are capped at 25 km/h.
  const RHO = 1.2, CDA = 0.6, CRR = 0.006, MASS = 90, G = 9.81, V0 = 16 / 3.6;
  const P0 = (0.5 * RHO * CDA * V0 * V0 + CRR * MASS * G) * V0;
  function speedWith(h) {
    let lo = 0.5, hi = 14;
    for (let i = 0; i < 36; i++) {
      const v = (lo + hi) / 2, air = v + h;
      const P = (0.5 * RHO * CDA * air * Math.abs(air) + CRR * MASS * G) * v;
      if (P > P0) hi = v; else lo = v;
    }
    return Math.min((lo + hi) / 2, 25 / 3.6);
  }
  // Wind at rider height between buildings is roughly 60% of the 10 m forecast.
  const STREET = 0.6;
  function windOnRoute(route, wx) {
    const W = (wx.now.wind / 3.6) * STREET, from = wx.now.dir, to = (from + 180) % 360, c = route.coords;
    let head = 0, tail = 0, total = 0, t = 0, halfHead = [0, 0];
    const half = route.length / 2;
    for (let i = 1; i < c.length; i++) {
      const L = window.BikeRouter.distM(c[i - 1][0], c[i - 1][1], c[i][0], c[i][1]); if (!L) continue;
      const th = bearing(c[i - 1][0], c[i - 1][1], c[i][0], c[i][1]);
      const along = W * Math.cos((th - to) * D2R);          // + tailwind, - headwind
      t += L / speedWith(-along);
      const angFrom = Math.abs(((th - from + 540) % 360) - 180);   // 0 = riding straight into the wind
      if (W > 0.8 && angFrom < 60) { head += L; halfHead[total < half ? 0 : 1] += L; }
      else if (W > 0.8 && angFrom > 120) tail += L;
      total += L;
    }
    const scale = total ? route.length / total : 1;
    const baseMinutes = route.length / V0 / 60;
    return {
      headShare: total ? head / total : 0, tailShare: total ? tail / total : 0,
      minutes: (t * scale) / 60 - baseMinutes, baseMinutes,
      firstHalfHead: half ? (halfHead[0] * scale) / half : 0, secondHalfHead: half ? (halfHead[1] * scale) / half : 0,
    };
  }

  // ---- weather on the map: wind streaks, or rain lines, or snow flakes (2026-11-03) ------------------------------------------
  // Two canvases over the map, both in screen space and turned with the map's bearing: #wind (WindLayer, the grey streaks that show where the
  // wind blows) and #precip (PrecipLayer, rain or snow). Only one shows at a time: while rain or snow falls now, it replaces the streaks.
  // WindLayer drives both (follow): same weather, same on / off. Neither runs during a ride (the app switches them off), while the page is
  // hidden, or under prefers-reduced-motion (the card still tells the weather). Both are sized to the map, pixel ratio capped at 2.
  class Overlay {
    constructor(map, canvas, { minDt, maxDt }) {
      this.map = map; this.canvas = canvas; this.ctx = canvas.getContext("2d");
      this.minDt = minDt; this.maxDt = maxDt; this.raf = 0; this.last = 0; this.w = this.h = 0;
      this.calm = matchMedia("(prefers-reduced-motion: reduce)");
      this.calm.addEventListener("change", () => this.sync());
      document.addEventListener("visibilitychange", () => this.sync());
      map.on("resize", () => this.resize());
      this.resize();
    }
    resize() {
      const r = this.map.getContainer().getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
      this.w = r.width; this.h = r.height;
      this.canvas.width = Math.round(r.width * dpr); this.canvas.height = Math.round(r.height * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    // Show or hide the canvas and start or stop the loop; called whenever something it depends on changes (wanted() is the subclass's condition)
    sync() {
      const go = this.wanted() && !this.calm.matches;
      this.canvas.hidden = !go;
      if (!go) { cancelAnimationFrame(this.raf); this.raf = 0; this.ctx.clearRect(0, 0, this.w, this.h); this.idle(); return; }
      if (!document.hidden && !this.raf) { this.last = performance.now(); this.queue(); }
    }
    idle() {}   // a subclass lets go of what it was drawing
    queue() { this.raf = requestAnimationFrame((t) => this.frame(t)); }
    frame(t) {
      this.raf = 0;
      if (document.hidden) return;   // the loop starts again when the page is shown (sync)
      this.queue();
      const dt = (t - this.last) / 1000;
      if (dt < this.minDt) return;
      this.last = t; this.step(Math.min(dt, this.maxDt));
    }
  }

  // Wind only (nothing falling): small grey streaks drift across the map the way the wind blows.
  class WindLayer extends Overlay {
    constructor(map, canvas) {
      super(map, canvas, { minDt: 0, maxDt: 0.05 });
      this.on = false; this.known = false; this.falling = false; this.wind = { speed: 0, to: 0 }; this.followers = [];
    }
    resize() {
      super.resize();
      const n = Math.min(240, Math.round((this.w * this.h) / 7000));
      this.parts = Array.from({ length: n }, () => this.spawn(true));
    }
    spawn(anywhere) {
      return { x: Math.random() * this.w, y: Math.random() * this.h, age: anywhere ? Math.random() * 90 : 0, life: 60 + Math.random() * 80 };
    }
    // Layers that follow this one (PrecipLayer): they get the same weather and the same on / off (weather toggle on, not riding)
    follow(layer) { this.followers.push(layer); }
    // wx null: the weather could not be loaded, so the wind is not known and no streak points anywhere. winter: the app's winter mode (see precipNow)
    set(wx, winter = false) {
      this.known = !!wx; this.falling = !!precipNow(wx, winter);
      if (wx) this.wind = { speed: wx.now.wind, to: (wx.now.dir + 180) % 360 };
      for (const f of this.followers) f.set(wx, winter);
      this.sync();
    }
    show(on) { this.on = on; for (const f of this.followers) f.show(on); this.sync(); }
    wanted() { return this.on && this.known && !this.falling; }   // rain or snow falling now takes the picture over
    step(dt) {
      const ctx = this.ctx, a = (this.wind.to - this.map.getBearing()) * D2R;
      const sp = 26 + this.wind.speed * 4;               // px per second: visible even in a light breeze
      const dx = Math.sin(a) * sp * dt, dy = -Math.cos(a) * sp * dt;
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "rgba(0,0,0,0.05)"; ctx.fillRect(0, 0, this.w, this.h);   // slow fade = longer streaks
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = "rgba(52, 92, 124, 0.5)"; ctx.lineWidth = 1.6; ctx.lineCap = "round";
      ctx.beginPath();
      for (const p of this.parts) {
        const nx = p.x + dx * (0.8 + (p.life % 7) / 15), ny = p.y + dy * (0.8 + (p.life % 7) / 15);
        ctx.moveTo(p.x, p.y); ctx.lineTo(nx, ny);
        p.x = nx; p.y = ny; p.age++;
        if (p.age > p.life || p.x < -10 || p.y < -10 || p.x > this.w + 10 || p.y > this.h + 10) Object.assign(p, this.spawn(false));
      }
      ctx.stroke();
    }
  }

  // ---- rain and snow: sparse and quiet, nothing like the wind streaks ----------------------------------------------------
  // Rain: thin straight lines, longer and fainter than the streaks, falling fast and steadily (far ones fainter and slower than near ones).
  // Snow: soft flakes that fall slowly and sway a little. Calm air (under CALM_KMH): straight down the screen. Wind: the fall tilts toward where
  // the wind blows on the screen (so it follows the map's bearing) and the tilt grows with the speed up to a limit: strong wind reads as rain or
  // snow driven along it. The density grows lightly with the rate. Redrawn about 30 times a second (it is slow, so that is plenty).
  const RAIN_FULL = 6, SNOW_FULL = 2;   // mm/h and cm/h at which the density reaches its fullest (still sparse)
  const CALM_KMH = 5;
  const FALL = { rain: { speed: 360, per: 7, cap: 0.7 }, snow: { speed: 50, per: 2.2, cap: 0.9 } };   // px/s straight down; px/s of drift per km/h above CALM_KMH; most drift, as a share of the fall speed (the fall never stops)
  // The velocity of an average line or flake on the screen (px/s, y down) for wind of kmh blowing toward toDeg on a map turned to bearingDeg
  function fallVelocity(kind, kmh, toDeg, bearingDeg) {
    const f = FALL[kind], a = (toDeg - bearingDeg) * D2R || 0;
    const drift = Math.min(f.cap * f.speed, Math.max(0, kmh - CALM_KMH) * f.per) || 0;   // || 0: a missing speed or direction means no drift
    return { vx: Math.sin(a) * drift, vy: f.speed - Math.cos(a) * drift };
  }
  const wrap = (v, lo, size) => ((v - lo) % size + size) % size + lo;
  const EDGE = 44;   // px beyond the map where a rain line comes round again: longer than the longest line, so it jumps while out of sight

  class PrecipLayer extends Overlay {
    constructor(map, canvas) {
      super(map, canvas, { minDt: 0.03, maxDt: 0.1 });
      this.shown = false; this.fall = null; this.wind = { speed: 0, to: 0 }; this.sprites = {};
    }
    resize() { super.resize(); this.parts = []; }   // refilled to suit the new size
    set(wx, winter = false) {   // wx null: the weather could not be loaded, so nothing is known to fall
      const f = precipNow(wx, winter), was = this.fall && this.fall.kind;
      this.fall = f && { kind: f.kind, level: Math.min(1, f.rate / (f.kind === "snow" ? SNOW_FULL : RAIN_FULL)) };
      if (wx) this.wind = { speed: wx.now.wind, to: (wx.now.dir + 180) % 360 };
      if ((f && f.kind) !== was) this.parts = [];
      this.sync();
    }
    show(on) { this.shown = on; this.sync(); }
    wanted() { return this.shown && !!this.fall; }
    idle() { this.parts = []; }
    sync() {
      super.sync();
      if (this.canvas.hidden) delete this.canvas.dataset.kind; else this.canvas.dataset.kind = this.fall.kind;
    }
    velocity() { return fallVelocity(this.fall.kind, this.wind.speed, this.wind.to, this.map.getBearing()); }
    // How many lines or flakes the map holds: by area, a little more as it falls harder
    count(areaPer, max) { return Math.min(max, Math.round(((this.w * this.h) / areaPer) * (0.65 + 0.35 * this.fall.level))); }
    step(dt) {
      this.ctx.clearRect(0, 0, this.w, this.h);
      const night = document.body.classList.contains("night"), v = this.velocity();
      if (this.fall.kind === "rain") { this.moveRain(v, dt); this.drawRain(v, night); } else { this.moveSnow(v, dt); this.drawSnow(v, night); }
    }
    line() {
      const near = Math.random() < 0.4;
      return { x: -EDGE + Math.random() * (this.w + 2 * EDGE), y: -EDGE + Math.random() * (this.h + 2 * EDGE), near,
        s: near ? 1.05 + Math.random() * 0.15 : 0.8 + Math.random() * 0.15, len: near ? 28 + Math.random() * 10 : 18 + Math.random() * 6 };
    }
    moveRain(v, dt) {
      const L = this.parts, want = this.count(4200, 120);   // 51 to 78 lines on a phone screen
      while (L.length < want) L.push(this.line());
      L.length = want;
      for (const p of L) { p.x = wrap(p.x + v.vx * p.s * dt, -EDGE, this.w + 2 * EDGE); p.y = wrap(p.y + v.vy * p.s * dt, -EDGE, this.h + 2 * EDGE); }
    }
    drawRain(v, night) {
      const ctx = this.ctx, mag = Math.hypot(v.vx, v.vy), ux = v.vx / mag, uy = v.vy / mag;   // each line trails behind its head, along the fall
      ctx.lineCap = "round";
      for (const near of [false, true]) {
        ctx.lineWidth = near ? 1.3 : 0.9;
        ctx.strokeStyle = night ? `rgba(190, 214, 238, ${near ? 0.5 : 0.3})` : `rgba(56, 92, 132, ${near ? 0.6 : 0.4})`;
        ctx.beginPath();
        for (const p of this.parts) if (p.near === near) { ctx.moveTo(p.x - ux * p.len, p.y - uy * p.len); ctx.lineTo(p.x, p.y); }
        ctx.stroke();
      }
    }
    flake(anywhere) {
      const life = 8 + Math.random() * 8;
      return { x: Math.random() * this.w, y: Math.random() * this.h, age: anywhere ? Math.random() * life * 0.8 : 0, life, r: 1.7 + Math.random() * 1.9,
        v: 0.7 + Math.random() * 0.6, sway: 3 + Math.random() * 4, freq: 0.9 + Math.random() * 0.8, phase: Math.random() * 6.2832 };
    }
    moveSnow(v, dt) {
      const fl = this.parts, want = this.count(12000, 60);   // 18 to 27 flakes on a phone screen
      while (fl.length < want) fl.push(this.flake(true));
      fl.length = want;
      for (let i = 0; i < fl.length; i++) {
        const f = fl[i]; f.age += dt;
        f.x += v.vx * f.v * dt; f.y += v.vy * f.v * dt;   // x, y: where the flake would be without its sway
        if (f.age >= f.life || f.x < -20 || f.y < -20 || f.x > this.w + 20 || f.y > this.h + 20) fl[i] = this.flake(false);
      }
    }
    drawSnow(v, night) {
      const ctx = this.ctx, img = this.sprite(night), mag = Math.hypot(v.vx, v.vy), px = -v.vy / mag, py = v.vx / mag;   // the sway runs across the fall
      for (const f of this.parts) {
        const u = f.age / f.life, sw = f.sway * Math.sin(f.phase + f.freq * f.age), d = f.r * 3.4;
        ctx.globalAlpha = (night ? 0.8 : 0.9) * Math.min(1, u / 0.12, (1 - u) / 0.25);   // fades in and out, never pops
        ctx.drawImage(img, f.x + px * sw - d / 2, f.y + py * sw - d / 2, d, d);
      }
      ctx.globalAlpha = 1;
    }
    // A soft dot: white core with a faint cool halo on the pale day map (white alone would vanish there), light blue-white on the night map
    sprite(night) {
      const key = night ? "n" : "d";
      if (this.sprites[key]) return this.sprites[key];
      const c = document.createElement("canvas"); c.width = c.height = 32;
      const g = c.getContext("2d"), grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
      const stops = night ? [[0, "rgba(244,249,255,1)"], [0.45, "rgba(226,238,252,0.8)"], [1, "rgba(200,225,250,0)"]]
        : [[0, "rgba(255,255,255,1)"], [0.38, "rgba(255,255,255,0.95)"], [0.62, "rgba(104,150,190,0.6)"], [1, "rgba(104,150,190,0)"]];
      for (const [at, col] of stops) grad.addColorStop(at, col);
      g.fillStyle = grad; g.fillRect(0, 0, 32, 32);
      return (this.sprites[key] = c);
    }
  }

  window.BikeWeather = { demo, load, rainOutlook, snowOutlook, precipNow, windOnRoute, fallVelocity, WindLayer, PrecipLayer, speedWith };
})();
