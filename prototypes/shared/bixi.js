/* Live BIXI station status from BIXI's public GBFS feed (CORS open): bikes, e-bikes and free docks per station,
   refreshed every minute while the page is visible. Classic script: window.BikeBixi. */
(function () {
  "use strict";
  const BASE = "https://gbfs.velobixi.com/gbfs/2-2/en/";
  let info = null, loadedAt = 0;
  async function getJSON(name) {
    const r = await fetch(BASE + name, { cache: "no-store" });
    if (!r.ok) throw new Error(`BIXI ${name}: ${r.status}`);
    return (await r.json()).data.stations;
  }
  // -> GeoJSON points with {name, bikes, ebikes, docks, renting, returning, updated}
  async function load() {
    if (!info) info = await getJSON("station_information.json");
    const status = new Map((await getJSON("station_status.json")).map((s) => [s.station_id, s]));
    loadedAt = Date.now();
    return {
      type: "FeatureCollection",
      features: info.map((s, i) => {
        const x = status.get(s.station_id) || {};
        const bikes = x.num_bikes_available ?? 0, ebikes = x.num_ebikes_available ?? 0;
        return { type: "Feature", id: i, geometry: { type: "Point", coordinates: [s.lon, s.lat] },
          properties: { name: s.name, bikes, ebikes, docks: x.num_docks_available ?? 0, cap: s.capacity || 0,
            renting: x.is_renting ?? 1, returning: x.is_returning ?? 1, updated: x.last_reported || 0,
            level: !x.is_renting ? "off" : bikes === 0 ? "empty" : bikes <= 2 ? "low" : "ok" } };
      }),
    };
  }
  window.BikeBixi = { load, loadedAt: () => loadedAt };
})();
