# Existing apps (scan of 2026-10-25)

**Bottom line:** safe-first bike routing already exists, including from a Montreal company (Transit). No app I found warns you *before* a gap during the ride, lets you choose how strict the routing is, or uses Montreal's own infrastructure types (4-season network, REV, closures). That is the opening.

| App | In Montreal? | How it routes | What it shows | Warns before a gap while riding? | 3D | Notes |
|---|---|---|---|---|---|---|
| **Transit, GO bike** (2024) | Yes; Montreal company | Protected lanes first, even if longer. "Paint is not infrastructure": painted lanes get almost no preference. Quiet streets are the fallback, busy roads are flagged, and routes favour flat ground | % of route protected. Legend: green with neon outline = protected; green = painted lane *or* quiet street; grey with yellow car = busy road | Not documented | No | Up to 3 options; audio cues; lock-screen trip view. Personal bikes only (no bikeshare or e-bikes), no bike + transit trips, no strictness setting |
| **Apple Maps** | Yes, since March 2022 | "Avoid busy roads" and "avoid hills" toggles | Elevation, how busy streets are, stairs | Not documented | Detailed 3D city in Montreal | iPhone only |
| **Google Maps** | Yes | Prefers trails and bike lanes. No "bike lanes only" option | Lane % breakdown (London, Berlin, Amsterdam, 2023). Legend: dark green = trails, green = bike lanes, dotted green = bike-friendly roads | No | Immersive View for routes, in about 15 cities; Montreal not in the 2023 list | Its developer API has a bicycle mode in beta, with no bike-lane option |
| **BIXI app** | Yes | Bikeshare-focused | Lanes by type: dark blue = separated, light blue = alongside the road, dashed = one-way | No | No | |
| **City of Montreal map** | Yes | No routing | Network by type | n/a | n/a | services.montreal.ca/cartes/pistes-cyclables |
| **Cycling Guide** | No: Waterloo Region, Ottawa, Halifax, Sarnia, Saskatoon; London ON testing | Level of Traffic Stress (LTS), from OSM | Lower-stress routes | Not documented | No | Free and Canadian; closest in spirit |
| **Bike Ottawa LTS map** | No (Ottawa) | LTS 1–4 on every street | Stress map and routing | n/a | n/a | Advocacy group tool |
| **Cyclemate** | No: NYC, San Francisco, LA | A model tuned per city that favours bike lanes and avoids very busy intersections | | Not documented | No | Audio and Apple Watch directions |
| **Ruti** | No (Philadelphia) | Google routing plus the region's LTS data | | n/a | n/a | Text-message planner |
| Komoot, Ride with GPS, Strava, Bikemap | Yes (global) | Leisure and sport planning | Surface and way types | No | | Not built for commuting |
| CyclOSM, BRouter, OsmAnd, CycleStreets, cycle.travel, Geovelo | Varies | Open or OSM-based tools. CycleStreets has a "quietest" route; Geovelo is France's safe-route app | | | | Useful references |

## Lessons for us
- Transit's line "paint is not infrastructure" matches Can-BICS, where painted lanes are only low comfort. Our tiers keep painted lanes apart from protected ones, and apart from quiet streets; Transit merges those last two into one green.
- In Streetsblog's test, Transit still sent the rider through a left turn onto a very busy avenue. **Intersections matter, not only segments.** Later: penalise turning onto or crossing arterials where there is no signal (the City publishes a traffic-signal layer).
- Nobody publishes their routing weights. A visible strictness slider sets us apart.
- Google and Transit use green for bike infrastructure; BIXI uses blue. Dashed lines for one-way lanes (BIXI) are a known convention.
- Google and Apple are strong in 3D, but neither uses it to show bike infrastructure.

## Sources
- Transit: [Streetsblog, 2024-09-16](https://cal.streetsblog.org/2024/09/16/transit-app-now-provides-safety-first-bike-directions) · [Mass Transit press release](https://www.masstransitmag.com/technology/passenger-info/mobile-applications/press-release/55140104/transit-transit-app-now-features-safe-bike-routes) · [Transit blog, GO bike](https://blog.transitapp.com/go-bike/) · [Transit help 513, updated 2026-07-02](https://help.transitapp.com/article/513-get-better-bike-directions)
- Apple: [MobileSyrup, 2022](https://mobilesyrup.com/2022/03/24/after-toronto-and-vancouver-bicycle-directions-in-apple-maps-are-now-available-in-montreal/) · [Apple Newsroom Canada, 2022](https://apple.com/ca/newsroom/2022/03/apple-maps-delivers-new-beautifully-detailed-experiences-to-explore-canadian-cities)
- Google: [Cycling Industry News, 2023](https://cyclingindustry.news/google-maps-sees-ongoing-cycling-focused-development-work/) · [Google blog, Oct 2023 (Immersive View for routes)](https://blog.google/products/maps/Google-maps-october-2023-update/) · [Routes API, bicycling](https://developers.google.com/maps/documentation/javascript/routes/route-bicycling?hl=en)
- BIXI: [Where are the bike lanes in Montréal](https://support.bixi.com/hc/en-ca/articles/7857976979987-Where-are-the-bike-lanes-in-Montr%C3%A9al) · City: [bicycle network map](https://montreal.ca/en/services/map-of-bike-paths)
- Cycling Guide: [CTV News](https://www.ctvnews.ca/kitchener/article/waterloo-region-cycling-app-expands-across-canada-as-demand-for-safer-routes-grows/) · Bike Ottawa: [bikeottawa.ca](https://bikeottawa.ca/?p=522) · Cyclemate: [App Store](https://apps.apple.com/app/id6755404903) · Ruti: [DVRPC](https://alpha.dvrpc.org/ruti)
- Can-BICS: [Statistics Canada, Health Reports](https://www150.statcan.gc.ca/n1/pub/82-003-x/2022010/article/00001-eng.htm) · [Observatoire du vélo: Montreal through Can-BICS](https://observatoire.velo.qc.ca/en/news/the-evolution-of-cycling-infrastructure-in-the-montreal-region-through-the-lens-o/)
