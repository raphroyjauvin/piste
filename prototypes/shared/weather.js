/* Wind, rain and snow for the app: Open-Meteo forecast (no key, CORS open), Environment Canada radar tiles,
   and the wind's effect along a route. Classic script: window.BikeWeather. */
(function () {
  "use strict";
  const { bearing } = window.BikeRouter;
  const D2R = Math.PI / 180;
  const URL_WX = "https://api.open-meteo.com/v1/forecast?latitude=45.52&longitude=-73.58" +
    "&current=temperature_2m,precipitation,rain,snowfall,wind_speed_10m,wind_direction_10m,wind_gusts_10m,weather_code" +
    "&hourly=precipitation,precipitation_probability,snowfall,snow_depth,temperature_2m" +
    "&past_days=1&forecast_days=2&wind_speed_unit=kmh&timezone=America%2FToronto";
  // Environment Canada GeoMet radar (1 km): rain rate in summer, snow in winter mode
  const radarTiles = (winter) => "https://geo.weather.gc.ca/geomet?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&FORMAT=image/png&TRANSPARENT=TRUE" +
    `&LAYERS=${winter ? "RADAR_1KM_RSNO" : "RADAR_1KM_RRAI"}&STYLES=&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256`;

  let cache = null, cachedAt = 0, pending = null;
  async function load(force = false) {
    if (!force && cache && Date.now() - cachedAt < 10 * 60e3) return cache;
    if (pending) return pending;
    pending = fetch(URL_WX).then((r) => { if (!r.ok) throw new Error("weather " + r.status); return r.json(); })
      .then((j) => { cache = parse(j); cachedAt = Date.now(); return cache; })
      .finally(() => { pending = null; });
    return pending;
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

  // ---- wind particles: drifting streaks over the map, in screen space, turned with the map's bearing ----------
  class WindLayer {
    constructor(map, canvas) {
      this.map = map; this.canvas = canvas; this.ctx = canvas.getContext("2d");
      this.parts = []; this.on = false; this.wind = { speed: 0, to: 0 }; this.last = 0;
      addEventListener("resize", () => this.resize());
      document.addEventListener("visibilitychange", () => { if (!document.hidden && this.on) this.loop(); });
      this.resize();
    }
    resize() {
      const r = this.map.getContainer().getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
      this.w = r.width; this.h = r.height;
      this.canvas.width = Math.round(r.width * dpr); this.canvas.height = Math.round(r.height * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = Math.min(240, Math.round((r.width * r.height) / 7000));
      this.parts = Array.from({ length: n }, () => this.spawn(true));
    }
    spawn(anywhere) {
      return { x: Math.random() * this.w, y: Math.random() * this.h, age: anywhere ? Math.random() * 90 : 0, life: 60 + Math.random() * 80 };
    }
    set(wx) { this.wind = { speed: wx.now.wind, to: (wx.now.dir + 180) % 360 }; }
    show(on) {
      this.on = on; this.canvas.hidden = !on;
      if (on) { this.last = performance.now(); this.loop(); } else this.ctx.clearRect(0, 0, this.w, this.h);
    }
    loop() {
      if (!this.on || document.hidden) return;
      requestAnimationFrame((t) => {
        const dt = Math.min(0.05, (t - this.last) / 1000); this.last = t;
        this.step(dt); this.loop();
      });
    }
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

  window.BikeWeather = { load, rainOutlook, windOnRoute, radarTiles, WindLayer, speedWith };
})();
