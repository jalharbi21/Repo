// Route providers shared by the browser and the Node server.
// Each provider returns the same shape so the UI can compare them:
// { provider, routes: [{ name, durationSec, distanceM, path: [[lat, lng]], steps: [{ instruction, distanceM }] }] }

const LATLNG = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

export function parseLatLng(text) {
  const m = LATLNG.exec(text || "");
  return m ? [Number(m[1]), Number(m[2])] : null;
}

// Decodes a Google encoded polyline into [[lat, lng], ...].
export function decodePolyline(str) {
  const points = [];
  let index = 0, lat = 0, lng = 0;
  while (index < str.length) {
    for (const which of [0, 1]) {
      let result = 0, shift = 0, b;
      do {
        b = str.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta; else lng += delta;
    }
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

const GOOGLE_MODES = { drive: "DRIVE", walk: "WALK", bike: "BICYCLE" };
const APPLE_MODES = { drive: "Automobile", walk: "Walking", bike: "Cycling" };

function googleWaypoint(text) {
  const ll = parseLatLng(text);
  return ll ? { location: { latLng: { latitude: ll[0], longitude: ll[1] } } } : { address: text };
}

async function readError(res, label) {
  let detail = "";
  try {
    const body = await res.json();
    detail = body?.error?.message || body?.error || JSON.stringify(body);
  } catch {
    detail = res.statusText;
  }
  return new Error(`${label} (${res.status}): ${detail}`);
}

// Google Routes API: https://developers.google.com/maps/documentation/routes
export async function fetchGoogleRoutes({ apiKey, origin, destination, mode = "drive", avoidTolls = false, avoidHighways = false, departAt = null, fetchImpl = fetch }) {
  if (!apiKey) throw new Error("No Google API key set");
  const travelMode = GOOGLE_MODES[mode] || "DRIVE";
  const body = {
    origin: googleWaypoint(origin),
    destination: googleWaypoint(destination),
    travelMode,
    computeAlternativeRoutes: true,
    languageCode: "en-US",
    units: "METRIC",
  };
  if (travelMode === "DRIVE") {
    body.routingPreference = "TRAFFIC_AWARE";
    body.extraComputations = ["TOLLS"];
    body.routeModifiers = { avoidTolls, avoidHighways };
  }
  // A future departure time gets Google's predicted traffic for that time.
  if (departAt && new Date(departAt) > Date.now() + 60_000 && travelMode !== "WALK") body.departureTime = new Date(departAt).toISOString();
  const res = await fetchImpl("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": [
        "routes.description",
        "routes.duration",
        "routes.distanceMeters",
        "routes.polyline.encodedPolyline",
        "routes.staticDuration",
        "routes.warnings",
        "routes.travelAdvisory.tollInfo",
        "routes.legs.steps.distanceMeters",
        "routes.legs.steps.staticDuration",
        "routes.legs.steps.polyline.encodedPolyline",
        "routes.legs.steps.navigationInstruction",
      ].join(","),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readError(res, "Google Routes API");
  const data = await res.json();
  if (!data.routes?.length) throw new Error("Google found no route between these places");
  return {
    provider: "google",
    routes: data.routes.map((r, i) => {
      const allSteps = (r.legs || []).flatMap((leg) => leg.steps || []);
      // Build the path from the step polylines so each step knows where it starts on the line.
      let path = [];
      const steps = [];
      if (allSteps.length && allSteps.every((st) => st.polyline?.encodedPolyline)) {
        for (const st of allSteps) {
          const pts = decodePolyline(st.polyline.encodedPolyline);
          const startIdx = Math.max(0, path.length - 1);
          path = path.length ? path.concat(pts.slice(1)) : pts;
          steps.push(googleStep(st, startIdx));
        }
      } else {
        path = decodePolyline(r.polyline?.encodedPolyline || "");
        for (const st of allSteps) steps.push(googleStep(st, undefined));
      }
      const durationSec = parseInt(r.duration, 10) || 0;
      const staticSec = parseInt(r.staticDuration, 10) || durationSec;
      return {
        name: r.description ? `via ${r.description}` : `Route ${i + 1}`,
        durationSec,
        trafficDelaySec: Math.max(0, durationSec - staticSec),
        hasTolls: Boolean(r.travelAdvisory?.tollInfo),
        toll: googleTollPrice(r.travelAdvisory?.tollInfo),
        distanceM: r.distanceMeters || 0,
        warnings: r.warnings || [],
        path,
        steps: steps.filter((st) => st.instruction),
      };
    }),
  };
}

// Sum of Google's estimated toll prices, e.g. { amount: 6.94, currency: "USD" }. Null when unknown.
function googleTollPrice(info) {
  const prices = info?.estimatedPrice || [];
  if (!prices.length) return null;
  const currency = prices[0].currencyCode;
  const amount = prices
    .filter((p) => p.currencyCode === currency)
    .reduce((t, p) => t + Number(p.units || 0) + Number(p.nanos || 0) / 1e9, 0);
  return { amount: Math.round(amount * 100) / 100, currency };
}

function googleStep(st, startIdx) {
  const instruction = st.navigationInstruction?.instructions || "";
  return {
    instruction,
    distanceM: st.distanceMeters || 0,
    durationSec: parseInt(st.staticDuration, 10) || 0,
    maneuver: maneuverFrom(st.navigationInstruction?.maneuver, instruction),
    street: streetFrom(instruction),
    startIdx,
  };
}

// Turn type in a small shared vocabulary, used for the arrow icons and voice prompts.
const GOOGLE_MANEUVERS = {
  TURN_LEFT: "left", TURN_RIGHT: "right", TURN_SLIGHT_LEFT: "slight-left", TURN_SLIGHT_RIGHT: "slight-right",
  TURN_SHARP_LEFT: "sharp-left", TURN_SHARP_RIGHT: "sharp-right", UTURN_LEFT: "uturn", UTURN_RIGHT: "uturn",
  RAMP_LEFT: "slight-left", RAMP_RIGHT: "slight-right", FORK_LEFT: "slight-left", FORK_RIGHT: "slight-right",
  MERGE: "merge", ROUNDABOUT_LEFT: "roundabout", ROUNDABOUT_RIGHT: "roundabout", ROUNDABOUT_CLOCKWISE: "roundabout",
  ROUNDABOUT_COUNTERCLOCKWISE: "roundabout", STRAIGHT: "straight", NAME_CHANGE: "straight", DEPART: "depart",
  FERRY: "ferry", FERRY_TRAIN: "ferry",
};

export function maneuverFrom(code, text = "") {
  if (code && GOOGLE_MANEUVERS[code]) return GOOGLE_MANEUVERS[code];
  const t = text.toLowerCase();
  if (/arriv|destination|on the (left|right)$/.test(t) && !/turn/.test(t)) return "arrive";
  if (/u-?turn/.test(t)) return "uturn";
  if (/roundabout|rotary|traffic circle/.test(t)) return "roundabout";
  if (/sharp left/.test(t)) return "sharp-left";
  if (/sharp right/.test(t)) return "sharp-right";
  if (/(slight|bear|keep|exit|ramp) left|left (fork|exit|ramp)/.test(t)) return "slight-left";
  if (/(slight|bear|keep|exit|ramp) right|right (fork|exit|ramp)/.test(t)) return "slight-right";
  if (/merge/.test(t)) return "merge";
  if (/\bleft\b/.test(t)) return "left";
  if (/\bright\b/.test(t)) return "right";
  if (/^(head|start|depart)/.test(t)) return "depart";
  return "straight";
}

// Street the step puts you on, from text like "Turn left onto Market St" or "Continue on I-80 E".
export function streetFrom(text = "") {
  const m = /\b(?:onto|on|to stay on|toward|along)\s+(.+?)(?:,|\.|\s+toward\b|\s+for\b|\s+then\b|$)/i.exec(text);
  return m ? m[1].trim() : "";
}

// Apple Maps Server API: https://developer.apple.com/documentation/applemapsserverapi
// authToken is a MapKit JS / Maps token (a signed JWT). It is swapped for a short-lived access token.
export async function getAppleAccessToken({ authToken, fetchImpl = fetch }) {
  if (!authToken) throw new Error("No Apple Maps token set");
  const res = await fetchImpl("https://maps-api.apple.com/v1/token", {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  if (!res.ok) throw await readError(res, "Apple Maps token exchange");
  const data = await res.json();
  return data.accessToken;
}

export async function fetchAppleRoutes({ authToken, accessToken, origin, destination, mode = "drive", avoidTolls = false, departAt = null, fetchImpl = fetch }) {
  const token = accessToken || (await getAppleAccessToken({ authToken, fetchImpl }));
  const params = new URLSearchParams({
    origin: origin.trim(),
    destination: destination.trim(),
    transportType: APPLE_MODES[mode] || "Automobile",
    requestsAlternateRoutes: "true",
    lang: "en-US",
  });
  if (avoidTolls) params.set("avoid", "Tolls"); // Apple can avoid tolls, but has no option to avoid highways
  if (departAt && new Date(departAt) > Date.now() + 60_000) params.set("departureDate", new Date(departAt).toISOString());
  const res = await fetchImpl(`https://maps-api.apple.com/v1/directions?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw await readError(res, "Apple Maps directions");
  const data = await res.json();
  if (!data.routes?.length) throw new Error("Apple found no route between these places");
  const steps = data.steps || [];
  const stepPaths = data.stepPaths || [];
  return {
    provider: "apple",
    routes: data.routes.map((r, i) => {
      const routeSteps = (r.stepIndexes || []).map((idx) => steps[idx]).filter(Boolean);
      const path = [];
      const outSteps = [];
      for (const st of routeSteps) {
        const pts = (stepPaths[st.stepPathIndex] || []).map((p) => [p.latitude, p.longitude]);
        const startIdx = Math.max(0, path.length - 1);
        const same = path.length && pts.length && path.at(-1)[0] === pts[0][0] && path.at(-1)[1] === pts[0][1];
        path.push(...(same ? pts.slice(1) : pts));
        if (st.instructions) {
          outSteps.push({
            instruction: st.instructions,
            distanceM: st.distanceMeters || 0,
            durationSec: st.durationSeconds || 0,
            maneuver: maneuverFrom(null, st.instructions),
            street: streetFrom(st.instructions),
            startIdx,
          });
        }
      }
      return {
        name: r.name ? `via ${r.name}` : `Route ${i + 1}`,
        durationSec: r.durationSeconds || 0,
        trafficDelaySec: 0,
        hasTolls: Boolean(r.hasTolls),
        toll: null, // Apple says whether a route has tolls, not what they cost
        distanceM: r.distanceMeters || 0,
        warnings: [],
        path,
        steps: outSteps,
      };
    }),
  };
}

// ---- Combining both providers into one ranked list

function samplePath(path, n = 24) {
  if (path.length <= n) return path;
  return Array.from({ length: n }, (_, i) => path[Math.round((i * (path.length - 1)) / (n - 1))]);
}
function metres(a, b) {
  const k = Math.PI / 180;
  const x = (b[1] - a[1]) * k * Math.cos(((a[0] + b[0]) / 2) * k);
  const y = (b[0] - a[0]) * k;
  return Math.sqrt(x * x + y * y) * 6371000;
}
// Average distance from points on one line to the nearest sampled point on the other.
function pathGap(p, q) {
  const a = samplePath(p), b = samplePath(q, 80);
  return a.reduce((t, pt) => t + Math.min(...b.map((x) => metres(pt, x))), 0) / a.length;
}
export function sameRoad(r1, r2) {
  const d = Math.abs(r1.distanceM - r2.distanceM) / Math.max(r1.distanceM, r2.distanceM, 1);
  return d < 0.05 && pathGap(r1.path, r2.path) < 250;
}

// Takes { google, apple } results and options, returns one list with the fastest route first.
export function mergeRoutes(results, { avoidTolls = false, avoidHighways = false } = {}) {
  const notes = [];
  let list = [];
  for (const provider of ["google", "apple"]) {
    const r = results[provider];
    if (r?.ok) for (const route of r.routes) list.push({ ...route, provider, sources: [provider] });
  }
  // Apple has no "avoid highways" option, so its routes can't be trusted to honor it.
  if (avoidHighways && list.some((r) => r.provider === "google")) {
    list = list.filter((r) => r.provider !== "apple");
  } else if (avoidHighways && list.length) {
    notes.push("Only Apple Maps answered, and it can't avoid highways, so these routes may use them.");
  }
  if (avoidTolls) {
    const free = list.filter((r) => !r.hasTolls);
    if (free.length) list = free;
    else if (list.length) notes.push("No toll-free route was found, so these routes include tolls.");
  }
  // Apple doesn't price tolls: borrow Google's price when both found the same road.
  for (const r of list) {
    if (r.hasTolls && !r.toll) {
      const twin = list.find((g) => g.toll && sameRoad(g, r));
      if (twin) r.toll = { ...twin.toll, estimated: true };
    }
  }
  list.sort((a, b) => a.durationSec - b.durationSec);
  // When both services suggest the same road, keep the faster estimate and remember both agreed.
  const kept = [];
  for (const r of list) {
    const dup = kept.find((k) => k.provider !== r.provider && sameRoad(k, r));
    if (dup) {
      if (!dup.sources.includes(r.provider)) dup.sources.push(r.provider);
      if (!dup.toll && r.toll) dup.toll = r.toll;
    } else kept.push(r);
  }
  return { routes: kept, notes };
}

// ---- Sample routes, so the app can be tried before any keys are set

let demoCache = null, placesCache = null;
async function loadDemoTrip() {
  if (!demoCache) demoCache = (await import("./demo-trip.js")).DEMO_TRIP;
  return demoCache;
}
async function loadDemoPlaces() {
  if (!placesCache) placesCache = (await import("./demo-places.js")).DEMO_PLACES;
  return placesCache;
}

function demoRoute(base, name, extra) {
  return {
    name,
    durationSec: base.durationSec,
    distanceM: base.distanceM,
    trafficDelaySec: 0,
    warnings: [],
    path: base.path,
    steps: base.steps.map((s) => ({ ...s, maneuver: maneuverFrom(null, s.instruction), street: streetFrom(s.instruction) })),
    ...extra,
  };
}

function decodeDeltas(arr) {
  const out = [];
  let a = 0, b = 0;
  for (let i = 0; i < arr.length; i += 2) {
    a += arr[i]; b += arr[i + 1];
    out.push([a / 1e5, b / 1e5]);
  }
  return out;
}

// Small, fixed differences between the two services' times, so the sample shows them disagreeing.
function wobble(id, k) {
  let h = 7;
  for (const c of id + k) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return ((h % 1000) / 1000) * 0.16 - 0.06; // between -6% and +10%
}

// Routes from the sample location to one of the sample places, shaped like each service's answer.
export async function demoPlaceRoutes(placeId, { mode = "drive", avoidTolls = false, avoidHighways = false } = {}) {
  if (placeId === "jfk" && mode === "drive") return demoRoutes({ avoidTolls, avoidHighways });
  const cat = await loadDemoPlaces();
  const place = cat.places.find((p) => p.id === placeId);
  const raw = cat.routes[placeId]?.[mode];
  if (!place || !raw?.length) return null;
  const base = raw.map((r) => demoRoute(
    { durationSec: r.d, distanceM: r.m, path: decodeDeltas(r.path), steps: r.steps.map(([instruction, distanceM, durationSec, startIdx]) => ({ instruction, distanceM, durationSec, startIdx })) },
    r.via ? `via ${r.via}` : "Direct route",
    { hasTolls: mode === "drive" && r.tolls, toll: mode === "drive" && r.tolls ? { amount: 6.94, currency: "USD" } : null, highway: r.highway }
  ));
  let google = base;
  if (avoidHighways) google = google.filter((r) => !r.highway).length ? google.filter((r) => !r.highway) : google;
  if (avoidTolls) google = google.filter((r) => !r.hasTolls).length ? google.filter((r) => !r.hasTolls) : google;
  const apple = (avoidTolls ? base.filter((r) => !r.hasTolls) : base).slice(0, 2).map((r, i) => ({
    ...r, durationSec: Math.round(r.durationSec * (1 + wobble(placeId, mode + i))), toll: null,
  }));
  return {
    demo: true,
    origin: cat.origin.name,
    destination: place.name,
    google: { ok: true, provider: "google", routes: google },
    apple: { ok: true, provider: "apple", routes: apple },
  };
}

// Mimics what each service returns for the sample trip to JFK, honoring the same avoid options they do.
export async function demoRoutes({ avoidTolls = false, avoidHighways = false } = {}) {
  const t = await loadDemoTrip();
  const fast = demoRoute(t.routes.fast, "via Queens-Midtown Tunnel and Van Wyck Expy", { hasTolls: true, toll: { amount: 6.94, currency: "USD" } });
  const free = demoRoute(t.routes.free, "via Queensboro Bridge and Long Island Expy", { hasTolls: false, toll: null });
  const local = demoRoute(t.routes.local, "via Queensboro Bridge and Woodhaven Blvd", { hasTolls: false, toll: null });
  const appleFast = { ...fast, durationSec: fast.durationSec + 140, toll: null };
  const appleFree = { ...free, durationSec: free.durationSec + 90 };
  let google = avoidHighways ? [local] : [fast, free, local];
  if (avoidTolls) google = google.filter((r) => !r.hasTolls);
  const apple = avoidTolls ? [appleFree] : [appleFast, appleFree];
  return {
    demo: true,
    origin: t.origin,
    destination: t.destination,
    google: { ok: true, provider: "google", routes: google },
    apple: { ok: true, provider: "apple", routes: apple },
  };
}
