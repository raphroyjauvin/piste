/* English / French strings for the app. Classic script: window.BikeI18n.
   t(key, vars) fills {name} placeholders; static HTML uses data-i18n="key" (text), data-i18n-ph (placeholder),
   data-i18n-title (title + aria-label). French follows Québec usage (5 %, « Arrêt : », 1,8 km). */
(function () {
  "use strict";
  const NB = " ";   // narrow no-break space before % and : in French
  const S = {
    en: {
      letsRide: "Let's ride!", focusFrom: "Start", focusTo: "Destination", focusHint: "Type an address, or tap the map", accept: "Done", cancel: "Cancel",
      stopPrefix: "Stop · ", kindOneWay: "One-way",
      wxTitle: "Wind & rain", winterTitle: "Winter", classicsLoading: "Routing the classics…",
      tagline: "Montréal by bike path · prototype",
      tabGo: "Go somewhere", tabSuggest: "Suggest a ride",
      fromPh: "Start: address, place, or Rachel & Papineau", toPh: "Destination",
      pickFrom: "Pick the start on the map", pickTo: "Pick the destination on the map",
      startLabel: "Starting location",
      routeStyle: "Route style", mostDirect: "Most direct", mostlyDirect: "Mostly direct", balanced: "Balanced",
      lanesFirst: "Bike paths first", lanesAlways: "Bike paths, whatever it takes", mostLanes: "Most bike paths",
      avoidHills: "Avoid hills", avoidWind: "Avoid headwinds",
      classics: "Classic rides", custom: "Make your own",
      loopHere: "Loop back here", oneWay: "One-way", distance: "Distance", aboutMin: "about {t}",
      stopOnWay: "Stop on the way", optional: "optional", none: "None",
      stop_cafe: "Coffee", stop_food: "Restaurant", stop_bakery: "Bakery", stop_icecream: "Ice cream", stop_bar: "Bar",
      stop_toilets: "Public restroom", stop_park: "Park or viewpoint", stop_culture: "Museum", stop_bikeshop: "Bike shop",
      finding: "Finding rides…",
      layers: "Layers", layersMap: "Map", layersElev: "Elevation",
      lyNetwork: "Bike paths", lyPlanned: "Planned & in construction", lyBrowseOnly: "browse only", lyWorks: "Construction",
      lyFood: "Cafés & food", lyShops: "Shops", lyBike: "BIXI, water, repair, parking", lyMetro: "Metro", lyCulture: "Museums & culture",
      lyBuildings: "Buildings", lyTint: "Elevation colours", lyRelief: "Hill shading", lyContours: "Contours", lyTerrain: "Terrain relief", lyIn3d: "in 3D",
      legend: "Legend", lgRoute: "Your route", lgProtected: "Protected bike path", lgPainted: "Painted bike path", lgShared: "Shared bike path", lgNoLane: "No bike path",
      lgNetwork: "Bike paths", lgLanes: "Bike paths", lgPlanned: "Planned (browse only)", lgElev: "Elevation above sea level",
      lgContours: "Contour every 5 m, bold every 25 m; extra 1 m lines on climbs",
      lg4s: "Bike paths cleared in winter (4-season)", lgNot4s: "Bike paths not cleared in winter",
      to3d: "Switch to bird's-eye 3D", to2d: "Switch to top-down 2D", weatherBtn: "Wind & rain", winterBtn: "Winter mode", langBtn: "Français",
      yourRoute: "Your route", climbM: "climb {m} m", gapsN: "{n} stretches without a bike path", gaps1: "1 stretch without a bike path",
      lanesAllWay: "bike paths all the way", onInfra: "on bike paths", on4s: "on 4-season bike paths", routedIn: "Routed on this device in {ms} ms",
      elevation: "Elevation", withoutLane: "Without a bike path", withoutLaneWinter: "Without a winter-cleared bike path",
      gapOn: "{m} m on {name}", aStreet: "a street", busyStreet: "Busy street, ride with traffic", quietStreet: "Quiet street", after: "after {d}",
      lanesWhole: "Bike paths the whole way.", turnByTurn: "Turn by turn ({n})",
      flat: "Mostly flat · {m} m of climbing in all",
      climbs1: "1 climb, {m} m up in all. Steepest: {g} {on} (+{rise} m over {d})",
      climbsN: "{n} climbs, {m} m up in all. Steepest: {g} {on} (+{rise} m over {d})", onStreet: "on {name}",
      start: "Start on {name}", continue: "Continue on {name}", slightL: "Slight left onto {name}", left: "Turn left onto {name}",
      sharpL: "Sharp left onto {name}", slightR: "Slight right onto {name}", right: "Turn right onto {name}", sharpR: "Sharp right onto {name}",
      stop: "Stop: {name}", sight: "Sight: {name}", arrive: "Arrive at {name}", yourStart: "your start", destination: "destination",
      bikePath: "Bike path", multiPath: "Multi-use path", path: "path",
      nearBy: "{a} near {b}", droppedPin: "Dropped pin",
      gapInside: "No bike path for {d}{on}. {tip}", rideTraffic: "Ride with traffic.", quietTip: "Quiet street.",
      gapAhead: "In {d}: {m} m without a bike path{on}{busy}", busyTag: " · busy street", backOnLane: "Back on a bike path",
      gapAheadWinter: "In {d}: {m} m without a winter-cleared bike path{on}", gapInsideWinter: "No winter-cleared bike path for {d}{on}. Take care.",
      climbIn: "Climb in {d}", climbStats: "+{rise} m over {d} · {avg} avg{max}", maxPart: ", {g} max", climbing: "Climbing · {g}",
      toTop: "{d} to the top · +{m} m to go", topOfClimb: "Top of the climb", riseDone: "+{m} m done",
      pause: "Pause", resume: "Resume", end: "End", starting: "Starting…", soundOff: "Sound off", soundChime: "Chime", soundVoice: "Voice",
      arrived: "Arrived. Nice ride.", arrivedVoice: "You have arrived.", climbVoice: "Climb ahead, plus {m} metres.",
      gapVoice: "In {d} metres, {m} metres without a bike path{on}{busy}.", gapVoiceBusy: ", with traffic",
      rideHere: "Ride here", pickStartToast: "Now pick a start: click the map or type it",
      nothingFits: "Nothing of that length fits from here on the mapped area. Try a shorter ride.", offline: "Basemap offline: showing our data only",
      loopDir: "{dir} loop", loopBy: "Loop by {place}", toPlace: "To {place}", metroOf: "{name} metro", stopAfter: "stop after {d}", via: "via {streets}",
      dir_N: "North", dir_NE: "North-east", dir_E: "East", dir_SE: "South-east", dir_S: "South", dir_SW: "South-west", dir_W: "West", dir_NW: "North-west",
      from_N: "the north", from_NE: "the north-east", from_E: "the east", from_SE: "the south-east", from_S: "the south", from_SW: "the south-west", from_W: "the west", from_NW: "the north-west",
      startAt: "Start: {name}", kindLoop: "Loop", kindOutBack: "Out and back", photoBy: "Photo: {credit} (cropped)",
      windFrom: "Wind from {dir}, {v} km/h", gusts: "gusts {v}", calm: "Calm wind", rainNow: "Raining now ({mm} mm/h)",
      rainAt: "Rain likely from {h} ({p})", dryFor: "Dry for the next {n} hours", wxLoading: "Loading weather…", wxFailed: "Weather unavailable right now",
      windHead: "Headwind for {p} of the ride · about +{min} min", windTail: "Tailwind for {p} of the ride · about −{min} min",
      windCross: "Mostly crosswind · little effect on time", windNone: "Wind has little effect today", radarCredit: "Radar: Environment and Climate Change Canada",
      winterOn: "Winter mode: routes use the 4-season bike paths", snow24: "Snow: {cm} cm in the last 24 h · {t} °C", noSnow: "No recent snow · {t} °C",
      icy: "Icy patches likely (freeze–thaw)", noClearing: "Live snow-clearing status isn't public yet",
      bixiStation: "BIXI station", bixiBikes: "{n} bikes", bixiEbikes: "{n} electric", bixiDocks: "{n} free docks", bixiUpdated: "updated {n} min ago",
      bixiClosed: "Not renting right now", bixiLive: "live",
    },
    fr: {
      letsRide: "Allons-y!", focusFrom: "Départ", focusTo: "Destination", focusHint: "Tapez une adresse ou touchez la carte", accept: "OK", cancel: "Annuler",
      stopPrefix: "Arrêt · ", kindOneWay: "Aller simple",
      wxTitle: "Vent et pluie", winterTitle: "Hiver", classicsLoading: "Calcul des balades classiques…",
      tagline: "Montréal en piste cyclable · prototype",
      tabGo: "Itinéraire", tabSuggest: "Suggérer une balade",
      fromPh: "Départ : adresse, lieu ou Rachel & Papineau", toPh: "Destination",
      pickFrom: "Choisir le départ sur la carte", pickTo: "Choisir la destination sur la carte",
      startLabel: "Point de départ",
      routeStyle: "Style d'itinéraire", mostDirect: "Le plus direct", mostlyDirect: "Plutôt direct", balanced: "Équilibré",
      lanesFirst: "Pistes cyclables d'abord", lanesAlways: "Pistes cyclables, coûte que coûte", mostLanes: "Le plus de pistes cyclables",
      avoidHills: "Éviter les côtes", avoidWind: "Éviter le vent de face",
      classics: "Balades classiques", custom: "Sur mesure",
      loopHere: "Boucle", oneWay: "Aller simple", distance: "Distance", aboutMin: "environ {t}",
      stopOnWay: "Arrêt en chemin", optional: "facultatif", none: "Aucun",
      stop_cafe: "Café", stop_food: "Restaurant", stop_bakery: "Boulangerie", stop_icecream: "Crème glacée", stop_bar: "Bar",
      stop_toilets: "Toilettes publiques", stop_park: "Parc ou belvédère", stop_culture: "Musée", stop_bikeshop: "Atelier vélo",
      finding: "Recherche de balades…",
      layers: "Calques", layersMap: "Carte", layersElev: "Relief",
      lyNetwork: "Pistes cyclables", lyPlanned: "Prévu et en construction", lyBrowseOnly: "exploration", lyWorks: "Travaux",
      lyFood: "Cafés et restos", lyShops: "Boutiques", lyBike: "BIXI, eau, réparation, stationnement", lyMetro: "Métro", lyCulture: "Musées et culture",
      lyBuildings: "Bâtiments", lyTint: "Couleurs d'altitude", lyRelief: "Ombrage du relief", lyContours: "Courbes de niveau", lyTerrain: "Relief du terrain", lyIn3d: "en 3D",
      legend: "Légende", lgRoute: "Votre itinéraire", lgProtected: "Piste cyclable protégée", lgPainted: "Piste cyclable peinte", lgShared: "Piste cyclable partagée", lgNoLane: "Sans piste cyclable",
      lgNetwork: "Pistes cyclables", lgLanes: "Pistes cyclables", lgPlanned: "Prévu (exploration)", lgElev: "Altitude",
      lgContours: "Courbe aux 5 m, en gras aux 25 m; lignes aux 1 m dans les côtes",
      lg4s: "Pistes cyclables déneigées l'hiver (4 saisons)", lgNot4s: "Pistes cyclables non déneigées l'hiver",
      to3d: "Passer en vue 3D", to2d: "Passer en vue 2D", weatherBtn: "Vent et pluie", winterBtn: "Mode hiver", langBtn: "English",
      yourRoute: "Votre itinéraire", climbM: "montée {m} m", gapsN: "{n} tronçons sans piste cyclable", gaps1: "1 tronçon sans piste cyclable",
      lanesAllWay: "pistes cyclables tout du long", onInfra: "sur pistes cyclables", on4s: "sur pistes cyclables 4 saisons", routedIn: "Calculé sur l'appareil en {ms} ms",
      elevation: "Dénivelé", withoutLane: "Sans piste cyclable", withoutLaneWinter: "Sans piste cyclable déneigée",
      gapOn: "{m} m sur {name}", aStreet: "une rue", busyStreet: "Rue achalandée, roulez avec la circulation", quietStreet: "Rue tranquille", after: "après {d}",
      lanesWhole: "Pistes cyclables tout du long.", turnByTurn: "Étape par étape ({n})",
      flat: "Plutôt plat · {m} m de montée au total",
      climbs1: "1 côte, {m} m de montée au total. La plus raide{nb}: {g} {on} (+{rise} m sur {d})",
      climbsN: "{n} côtes, {m} m de montée au total. La plus raide{nb}: {g} {on} (+{rise} m sur {d})", onStreet: "sur {name}",
      start: "Partez sur {name}", continue: "Continuez sur {name}", slightL: "Légèrement à gauche sur {name}", left: "Tournez à gauche sur {name}",
      sharpL: "Virage serré à gauche sur {name}", slightR: "Légèrement à droite sur {name}", right: "Tournez à droite sur {name}", sharpR: "Virage serré à droite sur {name}",
      stop: "Arrêt{nb}: {name}", sight: "À voir{nb}: {name}", arrive: "Arrivée{nb}: {name}", yourStart: "votre point de départ", destination: "destination",
      bikePath: "Piste cyclable", multiPath: "Sentier polyvalent", path: "sentier",
      nearBy: "{a} près de {b}", droppedPin: "Point sur la carte",
      gapInside: "Pas de piste cyclable sur {d}{on}. {tip}", rideTraffic: "Roulez avec la circulation.", quietTip: "Rue tranquille.",
      gapAhead: "Dans {d}{nb}: {m} m sans piste cyclable{on}{busy}", busyTag: " · rue achalandée", backOnLane: "De retour sur une piste cyclable",
      gapAheadWinter: "Dans {d}{nb}: {m} m sans piste cyclable déneigée{on}", gapInsideWinter: "Pas de piste cyclable déneigée sur {d}{on}. Prudence.",
      climbIn: "Côte dans {d}", climbStats: "+{rise} m sur {d} · moy. {avg}{max}", maxPart: ", max. {g}", climbing: "En montée · {g}",
      toTop: "{d} jusqu'au sommet · encore +{m} m", topOfClimb: "Sommet de la côte", riseDone: "+{m} m de faits",
      pause: "Pause", resume: "Reprendre", end: "Fin", starting: "Départ…", soundOff: "Son coupé", soundChime: "Carillon", soundVoice: "Voix",
      arrived: "Arrivé. Belle balade!", arrivedVoice: "Vous êtes arrivé.", climbVoice: "Côte à venir, plus {m} mètres.",
      gapVoice: "Dans {d} mètres, {m} mètres sans piste cyclable{on}{busy}.", gapVoiceBusy: ", avec la circulation",
      rideHere: "Y aller", pickStartToast: "Choisissez maintenant un départ : cliquez la carte ou tapez-le",
      nothingFits: "Rien de cette longueur ne tient dans la zone cartographiée d'ici. Essayez une balade plus courte.", offline: "Fond de carte hors ligne : nos données seulement",
      loopDir: "Boucle vers le {dir}", loopBy: "Boucle par {place}", toPlace: "Vers {place}", metroOf: "métro {name}", stopAfter: "arrêt après {d}", via: "par {streets}",
      dir_N: "nord", dir_NE: "nord-est", dir_E: "est", dir_SE: "sud-est", dir_S: "sud", dir_SW: "sud-ouest", dir_W: "ouest", dir_NW: "nord-ouest",
      from_N: "du nord", from_NE: "du nord-est", from_E: "d'est", from_SE: "du sud-est", from_S: "du sud", from_SW: "du sud-ouest", from_W: "d'ouest", from_NW: "du nord-ouest",
      startAt: "Départ{nb}: {name}", kindLoop: "Boucle", kindOutBack: "Aller-retour", photoBy: "Photo{nb}: {credit} (recadrée)",
      windFrom: "Vent {dir}, {v} km/h", gusts: "rafales {v}", calm: "Vent calme", rainNow: "Il pleut ({mm} mm/h)",
      rainAt: "Pluie probable dès {h} ({p})", dryFor: "Sec pour les {n} prochaines heures", wxLoading: "Chargement de la météo…", wxFailed: "Météo indisponible pour l'instant",
      windHead: "Vent de face sur {p} du trajet · environ +{min} min", windTail: "Vent dans le dos sur {p} du trajet · environ −{min} min",
      windCross: "Surtout vent de côté · peu d'effet sur le temps", windNone: "Le vent a peu d'effet aujourd'hui", radarCredit: "Radar : Environnement et Changement climatique Canada",
      winterOn: "Mode hiver : itinéraires sur les pistes cyclables 4 saisons", snow24: "Neige{nb}: {cm} cm dans les dernières 24 h · {t} °C", noSnow: "Pas de neige récente · {t} °C",
      icy: "Plaques de glace probables (gel-dégel)", noClearing: "L'état du déneigement en temps réel n'est pas encore public",
      bixiStation: "Station BIXI", bixiBikes: "{n} vélos", bixiEbikes: "{n} électriques", bixiDocks: "{n} points d'ancrage libres", bixiUpdated: "mis à jour il y a {n} min",
      bixiClosed: "Location suspendue pour l'instant", bixiLive: "en direct",
    },
  };
  const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const I = {
    lang: "en",
    t(key, vars = {}) {
      const s = (S[I.lang] && S[I.lang][key]) ?? S.en[key] ?? key;
      return s.replace(/\{(\w+)\}/g, (m, k) => (k === "nb" ? (I.lang === "fr" ? NB : "") : vars[k] !== undefined ? vars[k] : m));
    },
    pct(x) { return Math.round(x * 100) + (I.lang === "fr" ? NB + "%" : "%"); },
    num(v, digits = 1) { const s = (+v).toFixed(digits); return I.lang === "fr" ? s.replace(".", ",") : s; },
    compassKey(deg) { return COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8]; },
    duration(min) {
      if (min < 1) return "<1 min";
      if (min < 60) return Math.round(min) + " min";
      const h = Math.floor(min / 60), m = Math.round(min % 60);
      return m ? `${h} h ${String(m).padStart(2, "0")}` : `${h} h`;
    },
    // street and path names come from the data in English for generic paths
    place(name) {
      if (!name) return I.t("aStreet");
      if (name === "Bike path") return I.t("bikePath");
      if (name === "Multi-use path") return I.t("multiPath");
      if (name === "path") return I.t("path");
      return name;
    },
    maneuver(m) {
      if (m.kind === "stop" || m.kind === "sight") return I.t(m.kind, { name: m.name });
      return I.t(m.kind || "continue", { name: I.place(m.name) });
    },
    apply(root = document) {
      root.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = I.t(el.dataset.i18n)));
      root.querySelectorAll("[data-i18n-ph]").forEach((el) => (el.placeholder = I.t(el.dataset.i18nPh)));
      root.querySelectorAll("[data-i18n-title]").forEach((el) => { el.title = I.t(el.dataset.i18nTitle); el.setAttribute("aria-label", el.title); });
      document.documentElement.lang = I.lang;
    },
    initial() {
      try { const saved = localStorage.getItem("piste-lang"); if (saved === "en" || saved === "fr") return saved; } catch (e) { /* private mode */ }
      return /^fr/i.test(navigator.language || "") ? "fr" : "en";
    },
    save() { try { localStorage.setItem("piste-lang", I.lang); } catch (e) { /* private mode */ } },
  };
  window.BikeI18n = I;
})();
