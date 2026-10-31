# Saved outside data for the browser tests

`node tools/shots/test.mjs` answers the app's requests to these four outside services from the files here when `PISTE_FIXTURES=1`
is set (GitHub Actions sets it). Without it the tests use the live services, as before. Nothing in the app changes: the tests
intercept the requests with Playwright `context.route()`.

The files are snapshots on purpose: **do not refresh them to keep up with today's data**, only if a service changes its format.
They are trimmed to what the app reads. All fetched on 2026-10-30 (about 20:00 Montréal time).

| File | Stands in for | Where it came from | What was trimmed |
|---|---|---|---|
| `open-meteo.json` (3 KB) | `https://api.open-meteo.com/v1/forecast?...` (`prototypes/shared/weather.js`) | the exact URL the app builds (Plateau, `current` + `hourly`, `past_days=1&forecast_days=2`, km/h). Open-Meteo, CC BY 4.0 | nothing; the whole response. Current wind 15.8 km/h from 320 degrees, so the "avoid headwinds" cost is applied (it needs 6 km/h or more) |
| `bixi-station_information.json`, `bixi-station_status.json` (4 KB + 6 KB) | `https://gbfs.velobixi.com/gbfs/2-2/en/station_information.json` and `station_status.json` (`prototypes/shared/bixi.js`) | BIXI's public GBFS feed | the 40 stations nearest 45.52, -73.58 (of about 800), and only the fields `bixi.js` reads. The test "wind & rain and live BIXI" expects every station in this file (40) instead of more than 300 |
| `montreal-addresses.json` (2 KB) | `https://api.montreal.ca/api/geographic/location/v1/addresses?limit=6&q=...` (the geocoder in `prototypes/shared/common.js`) | City of Montréal address API | only the three texts the tests type, `4500 rue saint-denis`, `marché jean` and `parc la fontaine` (lower case, the key is the `q` the page sends), first 2 or 3 results each, only `coordinates` and `humanReadableCode`. Any other text gets an empty list, and the test run prints a line saying so |
| `radar-tile-empty.png` (0.3 KB) | every `https://geo.weather.gc.ca/geomet?...GetMap...` radar tile (`weather.js`) | made with Pillow: a 256 x 256 fully transparent PNG | not a snapshot: the radar layer's visibility is what the test checks, not its picture |

Not stubbed (the suite passes with them cut off too, see `PISTE_OFFLINE=1` in `test.mjs`): the OpenFreeMap basemap
(`tiles.openfreemap.org`), the AWS terrain tiles beyond our own (`s3.amazonaws.com`) and Google Fonts.

To see which outside hosts each test group calls (and so spot a new live dependency): `PISTE_NET_REPORT=1 node tools/shots/test.mjs`.
