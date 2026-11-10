/* Piste service worker (2026-11-02): routing and navigation keep working when the signal drops mid-ride.
 *  - Installing caches the app itself (pages, scripts, styles, routing graph, data, icons), so it opens and plans routes offline.
 *  - While browsing, the basemap, our map tiles, the terrain and the photos you look at are kept too, for the next time.
 *  - Address search, weather, BIXI, the feedback form and Umami always go to the network; they are never stored.
 * One file for both layouts: paths are relative to this file, and tools/build_site.py moves the ones that climb a folder for the site root.
 * It registers only on pistemtl.ca or with ?sw=1 (app.js). A new version installs in the background and takes over the next
 * time the app is opened, never while a tab is open, so a ride is never interrupted. */
"use strict";

const VERSION = "dev";                    // tools/build_site.py stamps a hash of the built files here: every deploy is a new version
const SHELL = `piste-shell-${VERSION}`;   // the app itself: filled on install, replaced as a whole by the next version
const TILES = "piste-tiles-2";            // tiles and photos, filled while browsing. Bump the number when a .pmtiles or terrain file is rebuilt
const MAX_TILES = 2500;                   // entries kept in TILES, oldest dropped first (about 100 MB at 20-60 KB a tile)

const SHELL_FILES = [
  "./", "index.html", "style.css", "ink.js", "app.js", "tour.js",
  "../manifest.webmanifest", "../favicon.ico", "../icons/icon-192.png", "../icons/icon-512.png", "../icons/apple-touch-icon.png",
  "../vendor/maplibre/maplibre-gl.css", "../vendor/maplibre/maplibre-gl.js", "../vendor/pmtiles/pmtiles.js",
  "../shared/router.js", "../shared/i18n.js", "../shared/common.js", "../shared/suggest.js", "../shared/weather.js", "../shared/trees3d.js", "../shared/edges3d.js", "../shared/bixi.js",
  "../shared/data/graph_island.js", "../shared/data/planned.js", "../shared/data/pois.js", "../shared/data/rem.js", "../shared/data/elevation_tint.js",
  "../shared/data/terrain_index.js", "../shared/data/trips.js", "../shared/data/classics.js",
];

// What is kept while browsing: our own tiles and photos, and the basemap, terrain and font files from these hosts.
const OWN_TILES = /\/shared\/(tiles|terrain|photos)\//;
const tileHost = (u) => u.hostname === "tiles.openfreemap.org" || u.hostname === "fonts.googleapis.com" || u.hostname === "fonts.gstatic.com"
  || (u.hostname === "s3.amazonaws.com" && u.pathname.startsWith("/elevation-tiles-prod/"));

self.addEventListener("install", (event) => {
  // "reload": the copies kept are the fresh ones, not the browser's older ones
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES.map((f) => new Request(f, { cache: "reload" })))));
});

self.addEventListener("activate", (event) => {
  const keep = [SHELL, TILES];
  event.waitUntil(caches.keys()
    .then((names) => Promise.all(names.filter((n) => n.startsWith("piste-") && !keep.includes(n)).map((n) => caches.delete(n))))
    .then(() => self.clients.claim()));   // only matters for the very first install: the page that registered us starts caching at once
});

self.addEventListener("fetch", (event) => {
  const req = event.request, url = new URL(req.url);
  if (req.method !== "GET") return;
  if (url.origin === location.origin) {
    event.respondWith(OWN_TILES.test(url.pathname) ? tile(event) : shell(req));
  } else if (tileHost(url)) {
    event.respondWith(tile(event));
  }   // anything else is not ours to answer: the network handles it, and fails on its own when there is no signal
});

// The app's own files: the copy from install, whatever the ?query (?trip=...); the network only for a file we don't hold.
async function shell(req) {
  const hit = await (await caches.open(SHELL)).match(req, { ignoreSearch: true });
  return hit || fetch(req);
}

// Tiles and photos: stale-while-revalidate. The kept copy answers at once and a fresh one is fetched behind it; with no copy,
// the network answers. A PMTiles byte range (the answer is a 206, which a cache refuses) is kept as a 200 under its own key and
// served back as a 206; ranges never change, so they are not refreshed.
async function tile(event) {
  const req = event.request, range = req.headers.get("range");
  const key = range ? new Request(`${req.url}?range=${range}`) : req;
  const cache = await caches.open(TILES);
  const hit = await cache.match(key);
  if (hit && range) return new Response(hit.body, { status: 206, headers: hit.headers });
  const fresh = fetch(req).then(async (res) => {
    if (res.ok || res.type === "opaque") {   // opaque: a font file from another host, which we may keep but not read
      await cache.put(key, range ? new Response(res.clone().body, { status: 200, headers: res.headers }) : res.clone());
      trim(cache);
    }
    return res;
  });
  if (hit) { event.waitUntil(fresh.catch(() => {})); return hit; }   // offline: the refresh fails quietly and the kept copy stands
  return fresh;
}

let puts = 0;
async function trim(cache) {   // every 50th store: drop the oldest entries beyond MAX_TILES
  if (++puts % 50) return;
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_TILES)).map((k) => cache.delete(k)));
}
