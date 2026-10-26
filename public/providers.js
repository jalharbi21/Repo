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
export async function fetchGoogleRoutes({ apiKey, origin, destination, mode = "drive", fetchImpl = fetch }) {
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
  if (travelMode === "DRIVE") body.routingPreference = "TRAFFIC_AWARE";
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
        distanceM: r.distanceMeters || 0,
        warnings: r.warnings || [],
        path,
        steps: steps.filter((st) => st.instruction),
      };
    }),
  };
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

export async function fetchAppleRoutes({ authToken, accessToken, origin, destination, mode = "drive", fetchImpl = fetch }) {
  const token = accessToken || (await getAppleAccessToken({ authToken, fetchImpl }));
  const params = new URLSearchParams({
    origin: origin.trim(),
    destination: destination.trim(),
    transportType: APPLE_MODES[mode] || "Automobile",
    requestsAlternateRoutes: "true",
    lang: "en-US",
  });
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
        distanceM: r.distanceMeters || 0,
        warnings: r.hasTolls ? ["This route has tolls"] : [],
        path,
        steps: outSteps,
      };
    }),
  };
}

// Sample data so the app can be tried before any keys are set.
// Ferry Building -> Golden Gate Park (San Francisco). Times and paths are illustrative, not live.
export function demoRoutes() {
  const ferry = [37.7955, -122.3937];
  const google = {
    provider: "google",
    routes: [
      {
        name: "via Fell St",
        durationSec: 1260,
        distanceM: 7400,
        path: [ferry, [37.7929, -122.3967], [37.7845, -122.4073], [37.7795, -122.4138], [37.7766, -122.4194], [37.7739, -122.4307], [37.7726, -122.4408], [37.7711, -122.4537], [37.7694, -122.4658]],
        steps: [
          { instruction: "Head southwest on The Embarcadero", distanceM: 350, startIdx: 0 },
          { instruction: "Turn right onto Market St", distanceM: 2400, startIdx: 1 },
          { instruction: "Continue onto Fell St", distanceM: 3600, startIdx: 4 },
          { instruction: "Turn left into Golden Gate Park", distanceM: 1050, startIdx: 7 },
        ],
      },
      {
        name: "via Oak St",
        durationSec: 1440,
        distanceM: 7900,
        path: [ferry, [37.7929, -122.3967], [37.7845, -122.4073], [37.7772, -122.4166], [37.7752, -122.4244], [37.7731, -122.4360], [37.7713, -122.4480], [37.7694, -122.4658]],
        steps: [
          { instruction: "Head southwest on The Embarcadero", distanceM: 350, startIdx: 0 },
          { instruction: "Turn right onto Market St", distanceM: 2700, startIdx: 1 },
          { instruction: "Turn right onto Oak St", distanceM: 3900, startIdx: 3 },
          { instruction: "Arrive at Golden Gate Park", distanceM: 950, startIdx: 6 },
        ],
      },
    ],
  };
  const apple = {
    provider: "apple",
    routes: [
      {
        name: "via Turk Blvd",
        durationSec: 1320,
        distanceM: 7700,
        path: [ferry, [37.7944, -122.3995], [37.7878, -122.4081], [37.7835, -122.4161], [37.7812, -122.4265], [37.7790, -122.4394], [37.7772, -122.4520], [37.7731, -122.4590], [37.7694, -122.4658]],
        steps: [
          { instruction: "Head west on Washington St", distanceM: 900, startIdx: 0 },
          { instruction: "Turn left onto Kearny St", distanceM: 700, startIdx: 1 },
          { instruction: "Turn right onto Turk Blvd", distanceM: 4800, startIdx: 3 },
          { instruction: "Turn left onto Stanyan St", distanceM: 1300, startIdx: 6 },
        ],
      },
      {
        name: "via Fell St",
        durationSec: 1380,
        distanceM: 7450,
        path: [ferry, [37.7929, -122.3967], [37.7845, -122.4073], [37.7795, -122.4138], [37.7766, -122.4194], [37.7739, -122.4307], [37.7726, -122.4408], [37.7711, -122.4537], [37.7694, -122.4658]],
        steps: [
          { instruction: "Head southwest on The Embarcadero", distanceM: 350, startIdx: 0 },
          { instruction: "Turn right onto Market St", distanceM: 2400, startIdx: 1 },
          { instruction: "Continue onto Fell St", distanceM: 3650, startIdx: 4 },
          { instruction: "Turn left into Golden Gate Park", distanceM: 1050, startIdx: 7 },
        ],
      },
    ],
  };
  for (const r of [...google.routes, ...apple.routes]) {
    r.trafficDelaySec = 0;
    r.warnings = [];
    for (const st of r.steps) {
      st.maneuver = maneuverFrom(null, st.instruction);
      st.street = streetFrom(st.instruction);
      st.durationSec = Math.round((st.distanceM / r.distanceM) * r.durationSec);
    }
  }
  return { origin: "Ferry Building, San Francisco", destination: "Golden Gate Park, San Francisco", google, apple };
}
