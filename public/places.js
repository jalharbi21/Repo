// Place search shared by the browser and the Node server: Google Places (New) and Apple Maps Server API,
// merged into one list, plus the sample places used before any keys are set.
// Every place has the same shape:
// { id, name, category, at: [lat, lng], address, hours, openNow, rating, ratingCount, price, phone, website, sources }

export const CATEGORIES = {
  food: { label: "Restaurants", one: "Restaurant", q: "restaurants", words: ["food", "restaurant", "eat", "pizza", "deli", "steak", "dinner", "lunch", "breakfast"] },
  coffee: { label: "Coffee", one: "Coffee shop", q: "coffee", words: ["coffee", "cafe", "café", "espresso"] },
  gas: { label: "Gas", one: "Gas station", q: "gas station", words: ["gas", "fuel", "petrol"] },
  ev: { label: "EV charging", one: "EV charging", q: "ev charging station", words: ["ev", "charging", "charger", "electric"] },
  parking: { label: "Parking", one: "Parking", q: "parking", words: ["parking", "garage", "park my car"] },
  grocery: { label: "Groceries", one: "Groceries", q: "grocery store", words: ["grocery", "groceries", "supermarket", "market"] },
  pharmacy: { label: "Pharmacy", one: "Pharmacy", q: "pharmacy", words: ["pharmacy", "drugstore", "chemist"] },
  hotel: { label: "Hotels", one: "Hotel", q: "hotels", words: ["hotel", "stay", "lodging"] },
  park: { label: "Parks", one: "Park", q: "parks", words: ["park", "garden", "outdoors"] },
  museum: { label: "Museums", one: "Museum", q: "museums", words: ["museum", "art", "gallery"] },
  landmark: { label: "Sights", one: "Landmark", q: "tourist attractions", words: ["sight", "landmark", "attraction", "tour"] },
  transit: { label: "Transit", one: "Station", q: "train station", words: ["train", "station", "subway", "transit"] },
  airport: { label: "Airports", one: "Airport", q: "airport", words: ["airport", "flight", "terminal"] },
  venue: { label: "Venues", one: "Venue", q: "arena", words: ["arena", "concert", "venue", "stadium"] },
  address: { label: "Addresses", one: "Address", q: "", words: [] },
};
// Category chips on the home screen, in order.
export const CHIPS = ["food", "coffee", "gas", "ev", "parking", "grocery", "pharmacy", "hotel"];

// Google place types → our categories.
const GOOGLE_TYPES = [
  [/gas_station/, "gas"], [/electric_vehicle_charging/, "ev"], [/parking/, "parking"], [/cafe|coffee/, "coffee"],
  [/grocery|supermarket|market/, "grocery"], [/pharmacy|drugstore/, "pharmacy"], [/hotel|lodging|motel|inn/, "hotel"],
  [/airport/, "airport"], [/museum|art_gallery/, "museum"], [/park|garden/, "park"], [/station|transit/, "transit"],
  [/stadium|arena|venue|concert/, "venue"], [/restaurant|food|bakery|bar|meal/, "food"], [/tourist|landmark|historical/, "landmark"],
];
// Apple poiCategory values → our categories.
const APPLE_TYPES = {
  GasStation: "gas", EVCharger: "ev", Parking: "parking", Cafe: "coffee", Bakery: "food", Restaurant: "food", FoodMarket: "grocery",
  Pharmacy: "pharmacy", Hotel: "hotel", Airport: "airport", Museum: "museum", Park: "park", NationalPark: "park",
  PublicTransport: "transit", Stadium: "venue", Theater: "venue", MusicVenue: "venue", Landmark: "landmark",
};

export function categoryFromGoogle(types = []) {
  for (const t of types) for (const [re, c] of GOOGLE_TYPES) if (re.test(t)) return c;
  return "address";
}
export const categoryFromApple = (poi) => APPLE_TYPES[poi] || (poi ? "landmark" : "address");

// Which category a free-text search is asking for, if any ("coffee near me" → coffee).
export function categoryForQuery(q = "") {
  const t = q.toLowerCase();
  for (const [key, c] of Object.entries(CATEGORIES)) {
    if (c.label.toLowerCase() === t || c.words.some((w) => new RegExp(`\\b${w}\\b`).test(t))) return key;
  }
  return null;
}

// ---- Distances

export function metresBetween(a, b) {
  const k = Math.PI / 180;
  const dLat = (b[0] - a[0]) * k, dLng = (b[1] - a[1]) * k;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * k) * Math.cos(b[0] * k) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

// ---- Opening hours

// Sample hours are written like "daily 08-22", "24h", or "mon-fri 07-19; sat-sun 08-19".
// Hours can pass 24 (25 = 1 AM the next day); decimals are fractions of an hour (10.5 = 10:30).
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export function parseHours(text = "") {
  if (!text) return null;
  if (text.trim() === "24h") return { always: true, spans: [] };
  const spans = [];
  for (const part of text.split(";")) {
    const m = /^\s*([a-z]+)(?:-([a-z]+))?\s+([\d.]+)-([\d.]+)\s*$/.exec(part.toLowerCase());
    if (!m) continue;
    let days;
    if (m[1] === "daily") days = [0, 1, 2, 3, 4, 5, 6];
    else {
      const a = DAYS.indexOf(m[1]), b = DAYS.indexOf(m[2] || m[1]);
      days = [];
      for (let d = a; ; d = (d + 1) % 7) { days.push(d); if (d === b) break; }
    }
    for (const d of days) spans.push({ day: d, open: Number(m[3]), close: Number(m[4]) });
  }
  return { always: false, spans };
}

const hourLabel = (h) => {
  const hh = Math.floor(h) % 24, mm = Math.round((h % 1) * 60);
  const d = new Date(2000, 0, 1, hh, mm);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: mm ? "2-digit" : undefined });
};

// { open: true|false, label: "Open · closes 10 PM" } at the given time, or null when hours are unknown.
export function openStatus(hours, now = new Date()) {
  const h = typeof hours === "string" ? parseHours(hours) : hours;
  if (!h) return null;
  if (h.always) return { open: true, label: "Open 24 hours" };
  const day = now.getDay(), t = now.getHours() + now.getMinutes() / 60;
  // Today's span, or yesterday's span running past midnight.
  for (const s of h.spans) {
    if (s.day === day && t >= s.open && t < s.close) return { open: true, label: `Open · closes ${hourLabel(s.close)}`, closingSoon: s.close - t <= 1 };
    if (s.day === (day + 6) % 7 && s.close > 24 && t < s.close - 24) return { open: true, label: `Open · closes ${hourLabel(s.close)}`, closingSoon: s.close - 24 - t <= 1 };
  }
  for (let i = 0; i < 7; i++) {
    const d = (day + i) % 7;
    const next = h.spans.filter((s) => s.day === d && (i > 0 || s.open > t)).sort((a, b) => a.open - b.open)[0];
    if (next) return { open: false, label: `Closed · opens ${i === 0 ? "" : i === 1 ? "tomorrow " : `${DAYS[d][0].toUpperCase()}${DAYS[d].slice(1)} `}${hourLabel(next.open)}` };
  }
  return { open: false, label: "Closed" };
}

// One line per day, Monday first, for the place page.
export function hoursTable(hours) {
  const h = typeof hours === "string" ? parseHours(hours) : hours;
  if (!h) return [];
  if (h.always) return ["Open 24 hours, every day"];
  return [1, 2, 3, 4, 5, 6, 0].map((d) => {
    const s = h.spans.filter((x) => x.day === d);
    const name = DAYS[d][0].toUpperCase() + DAYS[d].slice(1);
    return `${name}  ${s.length ? s.map((x) => `${hourLabel(x.open)}–${hourLabel(x.close)}`).join(", ") : "Closed"}`;
  });
}

// ---- Google Places API (New): https://developers.google.com/maps/documentation/places/web-service/op-overview

const GOOGLE_FIELDS = [
  "id", "displayName", "formattedAddress", "location", "types", "primaryTypeDisplayName", "rating", "userRatingCount",
  "priceLevel", "currentOpeningHours.openNow", "regularOpeningHours.weekdayDescriptions", "nationalPhoneNumber", "websiteUri",
];
const PRICE = { PRICE_LEVEL_INEXPENSIVE: 1, PRICE_LEVEL_MODERATE: 2, PRICE_LEVEL_EXPENSIVE: 3, PRICE_LEVEL_VERY_EXPENSIVE: 4 };

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

export function googlePlace(p) {
  return {
    id: `g:${p.id}`,
    name: p.displayName?.text || "Unnamed place",
    category: categoryFromGoogle(p.types),
    kind: p.primaryTypeDisplayName?.text || "",
    at: [p.location?.latitude, p.location?.longitude],
    address: p.formattedAddress || "",
    openNow: p.currentOpeningHours?.openNow ?? null,
    hoursText: p.regularOpeningHours?.weekdayDescriptions || [],
    rating: p.rating ?? null,
    ratingCount: p.userRatingCount ?? null,
    price: PRICE[p.priceLevel] || null,
    phone: p.nationalPhoneNumber || "",
    website: p.websiteUri || "",
    sources: ["google"],
  };
}

export async function fetchGooglePlaces({ apiKey, query, near, radiusM = 8000, max = 10, fetchImpl = fetch }) {
  if (!apiKey) throw new Error("No Google API key set");
  const body = { textQuery: query, maxResultCount: max, languageCode: "en" };
  if (near) body.locationBias = { circle: { center: { latitude: near[0], longitude: near[1] }, radius: radiusM } };
  const res = await fetchImpl("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": GOOGLE_FIELDS.map((f) => `places.${f}`).join(",") },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readError(res, "Google Places API");
  const data = await res.json();
  return { provider: "google", places: (data.places || []).map(googlePlace) };
}

export async function fetchGoogleSuggest({ apiKey, query, near, fetchImpl = fetch }) {
  if (!apiKey) throw new Error("No Google API key set");
  const body = { input: query, languageCode: "en" };
  if (near) body.locationBias = { circle: { center: { latitude: near[0], longitude: near[1] }, radius: 20000 } };
  const res = await fetchImpl("https://places.googleapis.com/v1/places:autocomplete", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readError(res, "Google Places autocomplete");
  const data = await res.json();
  return {
    provider: "google",
    suggestions: (data.suggestions || []).map((s) => s.placePrediction || s.queryPrediction).filter(Boolean).map((p) => ({
      text: p.structuredFormat?.mainText?.text || p.text?.text || "",
      sub: p.structuredFormat?.secondaryText?.text || "",
    })).filter((s) => s.text),
  };
}

// ---- Apple Maps Server API search: https://developer.apple.com/documentation/applemapsserverapi

export function applePlace(p, i = 0) {
  const at = [p.coordinate?.latitude, p.coordinate?.longitude];
  return {
    id: `a:${p.id || `${at[0]?.toFixed(5)},${at[1]?.toFixed(5)}`}`,
    name: p.name || p.formattedAddressLines?.[0] || `Result ${i + 1}`,
    category: categoryFromApple(p.poiCategory),
    kind: p.poiCategory ? p.poiCategory.replace(/([a-z])([A-Z])/g, "$1 $2") : "",
    at,
    address: (p.formattedAddressLines || []).join(", "),
    openNow: null, hoursText: [], rating: null, ratingCount: null, price: null, phone: "", website: "",
    sources: ["apple"],
  };
}

export async function fetchApplePlaces({ accessToken, query, near, fetchImpl = fetch }) {
  if (!accessToken) throw new Error("No Apple Maps token set");
  const params = new URLSearchParams({ q: query, lang: "en-US" });
  if (near) params.set("searchLocation", `${near[0]},${near[1]}`);
  const res = await fetchImpl(`https://maps-api.apple.com/v1/search?${params}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw await readError(res, "Apple Maps search");
  const data = await res.json();
  return { provider: "apple", places: (data.results || []).map(applePlace) };
}

export async function fetchAppleSuggest({ accessToken, query, near, fetchImpl = fetch }) {
  if (!accessToken) throw new Error("No Apple Maps token set");
  const params = new URLSearchParams({ q: query, lang: "en-US" });
  if (near) params.set("searchLocation", `${near[0]},${near[1]}`);
  const res = await fetchImpl(`https://maps-api.apple.com/v1/searchAutocomplete?${params}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw await readError(res, "Apple Maps autocomplete");
  const data = await res.json();
  return {
    provider: "apple",
    suggestions: (data.results || []).map((r) => ({ text: r.displayLines?.[0] || "", sub: r.displayLines?.slice(1).join(", ") || "" })).filter((s) => s.text),
  };
}

export async function fetchAppleReverse({ accessToken, at, fetchImpl = fetch }) {
  if (!accessToken) throw new Error("No Apple Maps token set");
  const res = await fetchImpl(`https://maps-api.apple.com/v1/reverseGeocode?loc=${at[0]},${at[1]}&lang=en-US`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw await readError(res, "Apple Maps reverse geocode");
  const data = await res.json();
  const r = data.results?.[0];
  return r ? (r.formattedAddressLines || []).join(", ") : "";
}

// ---- Combining both services

const words = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 1 && !["the", "of", "and", "nyc"].includes(w)));
export function sameNamedPlace(a, b) {
  if (!a.at?.[0] || !b.at?.[0] || metresBetween(a.at, b.at) > 150) return false;
  const x = words(a.name), y = words(b.name);
  if (!x.size || !y.size) return false;
  let common = 0;
  for (const w of x) if (y.has(w)) common++;
  return common / Math.min(x.size, y.size) >= 0.5;
}

// Takes { google, apple } search results and returns one list. A place both services know is shown once,
// with Google's details (rating, hours) and Apple's address when Google has none.
export function mergePlaces(results, near) {
  const g = results.google?.ok ? results.google.places : [];
  const a = results.apple?.ok ? results.apple.places : [];
  const out = g.map((p, i) => ({ ...p, rank: i }));
  a.forEach((p, i) => {
    const twin = out.find((x) => x.sources[0] === "google" && !x.sources.includes("apple") && sameNamedPlace(x, p));
    if (twin) {
      twin.sources = ["google", "apple"];
      twin.address ||= p.address;
      twin.appleId = p.id;
      twin.rank = Math.min(twin.rank, i) - 0.5; // both agree → a little higher
    } else out.push({ ...p, rank: i + 0.25 });
  });
  out.sort((x, y) => x.rank - y.rank);
  return out.map(({ rank, ...p }) => (near && p.at?.[0] ? { ...p, distanceM: metresBetween(near, p.at) } : p));
}

export function mergeSuggestions(results, max = 6) {
  const seen = new Set(), out = [];
  const lists = [results.google?.ok ? results.google.suggestions : [], results.apple?.ok ? results.apple.suggestions : []];
  for (let i = 0; out.length < max && i < 10; i++) {
    for (const list of lists) {
      const s = list[i];
      if (!s) continue;
      const k = s.text.toLowerCase();
      if (!seen.has(k)) { seen.add(k); out.push(s); }
    }
  }
  return out.slice(0, max);
}

// ---- Sample places

let demoCache = null;
export async function loadDemoPlaces() {
  if (!demoCache) demoCache = (await import("./demo-places.js")).DEMO_PLACES;
  return demoCache;
}

// Which sample places each service "knows", so the sample shows how answers are combined.
const ONLY_GOOGLE = new Set(["coffee-bryant", "parking-34th"]);
const ONLY_APPLE = new Set(["gas-lic", "pharmacy-40th"]);

export function demoPlace(p) {
  const sources = ONLY_GOOGLE.has(p.id) ? ["google"] : ONLY_APPLE.has(p.id) ? ["apple"] : ["google", "apple"];
  return {
    id: p.id, name: p.name, category: p.category, kind: CATEGORIES[p.category]?.one || "", at: p.at, address: p.address,
    hours: p.hours, openNow: null, hoursText: [], rating: null, ratingCount: null, price: null, phone: "", website: p.website || "",
    sources, demo: true,
  };
}

// Search the sample places by words, category, or both.
export function searchDemoPlaces(catalog, { query = "", category = null, near = null } = {}) {
  const cat = category || categoryForQuery(query);
  const q = query.toLowerCase().trim();
  const tokens = q.split(/\s+/).filter((t) => t.length > 1 && !["near", "me", "the", "nearby", "in"].includes(t));
  let list = catalog.places.map(demoPlace).map((p) => {
    const hay = `${p.name} ${p.address} ${CATEGORIES[p.category]?.label || ""} ${CATEGORIES[p.category]?.words.join(" ") || ""}`.toLowerCase();
    let score = 0;
    if (cat && p.category === cat) score += 3;
    const n = p.name.toLowerCase();
    if (q && (n === q || n.startsWith(`${q} `) || (q.length > 3 && n.startsWith(q) && !cat))) score += 4;
    for (const t of tokens) if (hay.includes(t)) score += 1;
    return { p, score };
  });
  list = list.filter((x) => (category ? x.p.category === category : x.score > 0));
  const withDist = list.map(({ p, score }) => ({ ...p, score, distanceM: near ? metresBetween(near, p.at) : undefined }));
  withDist.sort((a, b) => b.score - a.score || (a.distanceM ?? 0) - (b.distanceM ?? 0));
  return withDist.map(({ score, ...p }) => p);
}

export function findDemoPlace(catalog, id) {
  const p = catalog.places.find((x) => x.id === id);
  return p ? demoPlace(p) : null;
}

// The sample place nearest to a point, if one is within `withinM`.
export function nearestDemoPlace(catalog, at, withinM = 200) {
  let best = null, bestD = Infinity;
  for (const p of catalog.places) {
    const d = metresBetween(at, p.at);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best && bestD <= withinM ? demoPlace(best) : null;
}
