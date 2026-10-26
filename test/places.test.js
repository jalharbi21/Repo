import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchGooglePlaces, fetchApplePlaces, fetchGoogleSuggest, fetchAppleSuggest, mergePlaces, mergeSuggestions, openStatus, hoursTable,
  categoryForQuery, categoryFromGoogle, loadDemoPlaces, searchDemoPlaces, nearestDemoPlace, metresBetween,
} from "../public/places.js";
import { demoPlaceRoutes, mergeRoutes, fetchGoogleRoutes, fetchAppleRoutes } from "../public/providers.js";
import { createLibrary, monthStats, suggestedShortcut } from "../public/library.js";
import { server } from "../server.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const memStorage = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; };
// A Monday at the given local hour.
const monday = (h, m = 0) => new Date(2026, 9, 26, h, m);

test("Google place search sends a field mask and location bias, and normalizes places", async () => {
  let sent;
  const fetchImpl = async (url, opts) => {
    sent = { url, opts };
    return json({ places: [{
      id: "abc", displayName: { text: "Blue Cafe" }, formattedAddress: "1 Main St", location: { latitude: 40.7, longitude: -74 },
      types: ["cafe", "food"], rating: 4.6, userRatingCount: 120, priceLevel: "PRICE_LEVEL_MODERATE", currentOpeningHours: { openNow: true },
      regularOpeningHours: { weekdayDescriptions: ["Monday: 7 AM – 5 PM"] }, nationalPhoneNumber: "(212) 555-0100", websiteUri: "https://blue.example",
    }] });
  };
  const r = await fetchGooglePlaces({ apiKey: "k", query: "coffee", near: [40.7, -74], fetchImpl });
  assert.match(sent.url, /places:searchText$/);
  assert.equal(sent.opts.headers["X-Goog-Api-Key"], "k");
  assert.match(sent.opts.headers["X-Goog-FieldMask"], /places\.displayName/);
  const body = JSON.parse(sent.opts.body);
  assert.equal(body.textQuery, "coffee");
  assert.deepEqual(body.locationBias.circle.center, { latitude: 40.7, longitude: -74 });
  const p = r.places[0];
  assert.equal(p.id, "g:abc");
  assert.equal(p.category, "coffee");
  assert.deepEqual(p.at, [40.7, -74]);
  assert.equal(p.price, 2);
  assert.equal(p.openNow, true);
  assert.deepEqual(p.sources, ["google"]);
});

test("Apple place search normalizes results", async () => {
  let url;
  const fetchImpl = async (u) => { url = u; return json({ results: [{ id: "x1", name: "Blue Cafe", coordinate: { latitude: 40.7001, longitude: -74.0001 }, formattedAddressLines: ["1 Main St", "New York"], poiCategory: "Cafe" }] }); };
  const r = await fetchApplePlaces({ accessToken: "t", query: "coffee", near: [40.7, -74], fetchImpl });
  assert.match(url, /\/v1\/search\?q=coffee/);
  assert.match(url, /searchLocation=40\.7%2C-74/);
  assert.equal(r.places[0].category, "coffee");
  assert.equal(r.places[0].address, "1 Main St, New York");
});

test("autocomplete from both services is merged without repeats", async () => {
  const g = await fetchGoogleSuggest({ apiKey: "k", query: "blu", fetchImpl: async () => json({ suggestions: [{ placePrediction: { structuredFormat: { mainText: { text: "Blue Cafe" }, secondaryText: { text: "Main St" } } } }] }) });
  const a = await fetchAppleSuggest({ accessToken: "t", query: "blu", fetchImpl: async () => json({ results: [{ displayLines: ["Blue Cafe", "Main St"] }, { displayLines: ["Blue Bottle", "5th Ave"] }] }) });
  const list = mergeSuggestions({ google: { ok: true, ...g }, apple: { ok: true, ...a } });
  assert.deepEqual(list.map((s) => s.text), ["Blue Cafe", "Blue Bottle"]);
});

test("a place both services know is shown once and marked as found by both", () => {
  const near = [40.7, -74];
  const google = { ok: true, places: [
    { id: "g:1", name: "Blue Cafe", at: [40.7, -74], address: "", sources: ["google"], rating: 4.5 },
    { id: "g:2", name: "Corner Deli", at: [40.71, -74], address: "2 Elm", sources: ["google"] },
  ] };
  const apple = { ok: true, places: [
    { id: "a:1", name: "The Blue Cafe", at: [40.7003, -74.0002], address: "1 Main St", sources: ["apple"] },
    { id: "a:2", name: "Book Shop", at: [40.72, -74], address: "3 Oak", sources: ["apple"] },
  ] };
  const list = mergePlaces({ google, apple }, near);
  assert.equal(list.length, 3);
  assert.deepEqual(list[0].sources, ["google", "apple"]);
  assert.equal(list[0].address, "1 Main St"); // filled in from Apple
  assert.equal(list[0].rating, 4.5);          // kept from Google
  assert.ok(list.every((p) => typeof p.distanceM === "number"));
  // One service failing still gives the other's answers.
  assert.equal(mergePlaces({ google: { ok: false }, apple }).length, 2);
});

test("opening hours: open, closing soon, overnight and closed", () => {
  assert.equal(openStatus("daily 08-22", monday(12)).open, true);
  assert.equal(openStatus("daily 08-22", monday(21, 30)).closingSoon, true);
  assert.match(openStatus("daily 08-22", monday(23)).label, /opens tomorrow 8 AM/);
  // Open until 2 AM: still open at 1 AM the next day.
  assert.equal(openStatus("daily 10-26", monday(1)).open, true);
  assert.match(openStatus("wed-sun 11-18", monday(12)).label, /opens Wed 11 AM/);
  assert.equal(openStatus("24h").label, "Open 24 hours");
  assert.equal(openStatus(""), null);
  assert.equal(hoursTable("mon-fri 07-19; sat-sun 08-19.5")[5], "Sat  8 AM–7:30 PM");
});

test("reads a category from searches and Google types", () => {
  assert.equal(categoryForQuery("coffee near me"), "coffee");
  assert.equal(categoryForQuery("Gas"), "gas");
  assert.equal(categoryForQuery("Joe's"), null);
  assert.equal(categoryFromGoogle(["electric_vehicle_charging_station"]), "ev");
});

test("sample places can be searched by words and category", async () => {
  const cat = await loadDemoPlaces();
  const parks = searchDemoPlaces(cat, { query: "park", near: cat.origin.at });
  assert.ok(parks.length >= 4);
  assert.equal(parks[0].category, "park");
  assert.ok(searchDemoPlaces(cat, { category: "gas" }).every((p) => p.category === "gas"));
  assert.equal(searchDemoPlaces(cat, { query: "katz" })[0].id, "katz");
  assert.equal(nearestDemoPlace(cat, [40.7614, -73.9777])?.id, "moma");
  assert.ok(metresBetween([40.758, -73.98551], [40.7614, -73.9776]) < 1000);
});

test("sample routes go from Times Square to each sample place, by car, on foot and by bike", async () => {
  for (const mode of ["drive", "walk", "bike"]) {
    const d = await demoPlaceRoutes("moma", { mode });
    const { routes } = mergeRoutes(d, {});
    assert.ok(routes.length >= 1, mode);
    const r = routes[0];
    assert.ok(r.path.length > 2 && r.steps.length > 1);
    assert.ok(r.steps.every((s) => s.startIdx < r.path.length));
    assert.match(r.steps.at(-1).instruction, /^Arrive at Museum of Modern Art/);
    assert.ok(Math.abs(r.path[0][0] - 40.758) < 0.002);
  }
  // Avoid tolls drops the toll tunnel.
  const free = mergeRoutes(await demoPlaceRoutes("astoria-park", { mode: "drive", avoidTolls: true }), { avoidTolls: true });
  assert.ok(free.routes.length && free.routes.every((r) => !r.hasTolls));
  const tolled = mergeRoutes(await demoPlaceRoutes("astoria-park", { mode: "drive" }), {});
  assert.ok(tolled.routes.some((r) => r.hasTolls));
  assert.equal(await demoPlaceRoutes("nowhere"), null);
});

test("route requests carry a future departure time to both services", async () => {
  const at = new Date(Date.now() + 3600_000).toISOString();
  let gBody, aUrl;
  await fetchGoogleRoutes({ apiKey: "k", origin: "A", destination: "B", departAt: at, fetchImpl: async (u, o) => { gBody = JSON.parse(o.body); return json({ routes: [{ duration: "60s", polyline: { encodedPolyline: "" } }] }); } }).catch(() => {});
  await fetchAppleRoutes({ accessToken: "t", origin: "A", destination: "B", departAt: at, fetchImpl: async (u) => { aUrl = u; return json({ routes: [{ durationSeconds: 60, stepIndexes: [] }] }); } });
  assert.equal(gBody.departureTime, at);
  assert.match(aUrl, /departureDate=/);
});

test("library keeps Home, Work, lists and recents on the device", () => {
  const storage = memStorage();
  const lib = createLibrary(storage);
  const cafe = { id: "g:1", name: "Blue Cafe", at: [40.7, -74], category: "coffee", rating: 4.5 };
  lib.setShortcut("home", cafe);
  assert.equal(lib.data.home.name, "Blue Cafe");
  assert.equal(lib.data.home.rating, undefined); // only what's needed is kept
  assert.equal(lib.toggleInList("favorites", cafe), true);
  assert.ok(lib.isSaved(cafe));
  const id = lib.createList("Weekend");
  lib.toggleInList(id, cafe);
  assert.deepEqual(lib.listsWith(cafe).sort(), ["favorites", id].sort());
  assert.equal(lib.toggleInList("favorites", cafe), false);
  lib.addRecent({ query: "coffee" });
  lib.addRecent({ place: cafe });
  lib.addRecent({ query: "Coffee" }); // same search again moves to the top, not twice
  assert.deepEqual(lib.data.recents.map((r) => r.query || r.place.name), ["Coffee", "Blue Cafe"]);
  // Reloads from storage.
  const again = createLibrary(storage);
  assert.equal(again.data.home.name, "Blue Cafe");
  assert.equal(again.data.lists.length, 3);
  // Turning history off clears and stops it.
  again.set("keepHistory", false);
  again.addRecent({ query: "pizza" });
  again.logTrip({ durationSec: 60 });
  assert.equal(again.data.recents.length, 0);
  assert.equal(again.data.trips.length, 0);
  again.deleteList("favorites");
  assert.ok(again.list("favorites"));
});

test("trip ledger totals the month: time saved, tolls and who was fastest", () => {
  const now = new Date(2026, 9, 26);
  const trips = [
    { at: new Date(2026, 9, 2).getTime(), durationSec: 1800, distanceM: 20000, savedSec: 240, winner: "google", toll: { amount: 6.94, currency: "USD" } },
    { at: new Date(2026, 9, 9).getTime(), durationSec: 600, distanceM: 4000, savedSec: 120, winner: "apple", avoidedToll: true },
    { at: new Date(2026, 9, 10).getTime(), durationSec: 300, distanceM: 1000, savedSec: 0, winner: "both" },
    { at: new Date(2026, 8, 30).getTime(), durationSec: 999, distanceM: 999, savedSec: 999, winner: "google" }, // last month
  ];
  const s = monthStats(trips, now);
  assert.equal(s.trips, 3);
  assert.equal(s.savedSec, 360);
  assert.equal(s.distanceM, 25000);
  assert.deepEqual(s.tolls, { USD: 6.94 });
  assert.equal(s.tollsAvoided, 1);
  assert.deepEqual(s.wins, { google: 1, apple: 1, both: 1 });
});

test("home suggests Work on weekday mornings and Home later", () => {
  const home = { at: [40.67, -73.98] }, work = { at: [40.75, -73.98] };
  assert.equal(suggestedShortcut({ home, work }, monday(8))?.which, "work");
  assert.equal(suggestedShortcut({ home, work }, monday(18))?.which, "home");
  // Already at Home in the evening: nothing to suggest.
  assert.equal(suggestedShortcut({ home, work: null }, monday(18), home.at, metresBetween), null);
  assert.equal(suggestedShortcut({ home: null, work: null }, monday(8)), null);
});

test("server answers place searches, sample routes to places and reverse lookups", async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const post = (path, body) => fetch(base + path, { method: "POST", body: JSON.stringify(body) });
  try {
    const demo = await (await post("/api/places", { demo: true, query: "museum" })).json();
    assert.ok(demo.places.some((p) => p.id === "moma"));
    const sug = await (await post("/api/places", { demo: true, query: "kat", kind: "suggest" })).json();
    assert.equal(sug.suggestions[0].text, "Katz's Delicatessen");
    const route = await (await post("/api/routes", { demo: true, placeId: "katz", mode: "bike" })).json();
    assert.ok(route.routes.length >= 1);
    assert.equal((await post("/api/routes", { demo: true, placeId: "nope" })).status, 404);
    const cfg = await (await fetch(base + "/api/config")).json();
    const live = await (await post("/api/places", { query: "coffee" })).json();
    if (!cfg.google && !cfg.apple) assert.deepEqual(live.places, []);
    assert.equal((await post("/api/places", { query: "" })).status, 400);
    assert.equal((await fetch(base + "/api/reverse?at=abc")).status, 400);
    assert.equal((await post("/api/places", "{not json")).status, 400);
  } finally {
    server.close();
  }
});
