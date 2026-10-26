import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { decodePolyline, fetchGoogleRoutes, fetchAppleRoutes, parseLatLng, demoRoutes, maneuverFrom, streetFrom } from "../public/providers.js";
import { createTracker, pointAt, prepareRoute, snapToRoute } from "../public/nav.js";
import { server, signAppleToken } from "../server.js";

const json = (body, status = 200) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("decodes Google's example polyline", () => {
  assert.deepEqual(decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@"), [
    [38.5, -120.2],
    [40.7, -120.95],
    [43.252, -126.453],
  ]);
});

test("parses lat,lng text", () => {
  assert.deepEqual(parseLatLng(" 37.79, -122.39 "), [37.79, -122.39]);
  assert.equal(parseLatLng("Ferry Building"), null);
});

test("normalizes a Google Routes response", async () => {
  let sent;
  const fetchImpl = async (url, opts) => {
    sent = { url, opts };
    return json({
      routes: [{
        description: "US-101 N", duration: "1500s", distanceMeters: 12000,
        polyline: { encodedPolyline: "_p~iF~ps|U_ulLnnqC" },
        legs: [{ steps: [{ distanceMeters: 500, navigationInstruction: { instructions: "Head north" } }, { distanceMeters: 10 }] }],
      }],
    })();
  };
  const r = await fetchGoogleRoutes({ apiKey: "k", origin: "A", destination: "37.1,-122.2", mode: "walk", fetchImpl });
  assert.equal(sent.opts.headers["X-Goog-Api-Key"], "k");
  const body = JSON.parse(sent.opts.body);
  assert.equal(body.travelMode, "WALK");
  assert.equal(body.routingPreference, undefined);
  assert.deepEqual(body.destination, { location: { latLng: { latitude: 37.1, longitude: -122.2 } } });
  assert.equal(r.routes[0].name, "via US-101 N");
  assert.equal(r.routes[0].durationSec, 1500);
  assert.equal(r.routes[0].path.length, 2);
  assert.deepEqual(r.routes[0].steps.map(({ instruction, distanceM, maneuver }) => ({ instruction, distanceM, maneuver })), [{ instruction: "Head north", distanceM: 500, maneuver: "depart" }]);
});

test("reports Google errors with the API's message", async () => {
  const fetchImpl = json({ error: { message: "API key not valid" } }, 400);
  await assert.rejects(fetchGoogleRoutes({ apiKey: "bad", origin: "A", destination: "B", fetchImpl }), /API key not valid/);
});

test("normalizes an Apple Maps directions response, exchanging the token first", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url: String(url), auth: opts.headers.Authorization });
    if (String(url).endsWith("/v1/token")) return json({ accessToken: "short-lived", expiresInSeconds: 1800 })();
    return json({
      routes: [{ name: "I-280 N", distanceMeters: 9000, durationSeconds: 1200, stepIndexes: [0, 1] }],
      steps: [
        { stepPathIndex: 0, distanceMeters: 0, instructions: "" },
        { stepPathIndex: 1, distanceMeters: 9000, instructions: "Take I-280 N" },
      ],
      stepPaths: [[{ latitude: 1, longitude: 2 }], [{ latitude: 3, longitude: 4 }, { latitude: 5, longitude: 6 }]],
    })();
  };
  const r = await fetchAppleRoutes({ authToken: "jwt", origin: "A", destination: "B", fetchImpl });
  assert.equal(calls[0].auth, "Bearer jwt");
  assert.equal(calls[1].auth, "Bearer short-lived");
  assert.match(calls[1].url, /transportType=Automobile/);
  assert.equal(r.routes[0].durationSec, 1200);
  assert.deepEqual(r.routes[0].path, [[1, 2], [3, 4], [5, 6]]);
  assert.deepEqual(r.routes[0].steps.map(({ instruction, distanceM, startIdx, street }) => ({ instruction, distanceM, startIdx, street })), [{ instruction: "Take I-280 N", distanceM: 9000, startIdx: 0, street: "" }]);
});

test("reads turn types and street names from instructions", () => {
  assert.equal(maneuverFrom("TURN_SHARP_LEFT", ""), "sharp-left");
  assert.equal(maneuverFrom(null, "Turn right onto Market St"), "right");
  assert.equal(maneuverFrom(null, "Keep left at the fork"), "slight-left");
  assert.equal(maneuverFrom(null, "Make a U-turn"), "uturn");
  assert.equal(maneuverFrom(null, "Arrive at Golden Gate Park"), "arrive");
  assert.equal(streetFrom("Turn left onto Market St"), "Market St");
  assert.equal(streetFrom("Continue on I-80 E toward Oakland"), "I-80 E");
  assert.equal(streetFrom("Make a U-turn"), "");
});

test("Google step polylines give each step its start point on the route", async () => {
  const fetchImpl = json({
    routes: [{
      duration: "600s", staticDuration: "480s", distanceMeters: 1000, polyline: { encodedPolyline: "" },
      legs: [{ steps: [
        { distanceMeters: 500, polyline: { encodedPolyline: "_p~iF~ps|U_ulLnnqC" }, navigationInstruction: { maneuver: "DEPART", instructions: "Head north on A St" } },
        { distanceMeters: 500, polyline: { encodedPolyline: "_flwFn`faV_mqNvxq`@" }, navigationInstruction: { maneuver: "TURN_LEFT", instructions: "Turn left onto B St" } },
      ] }],
    }],
  });
  const r = (await fetchGoogleRoutes({ apiKey: "k", origin: "A", destination: "B", fetchImpl })).routes[0];
  assert.equal(r.path.length, 3);
  assert.deepEqual(r.steps.map((s) => [s.startIdx, s.maneuver, s.street]), [[0, "depart", "A St"], [1, "left", "B St"]]);
  assert.equal(r.trafficDelaySec, 120);
});

test("navigation follows a drive from start to arrival", () => {
  const route = demoRoutes().google.routes[0];
  const t = createTracker(route);
  const said = [];
  let last;
  for (let d = 0; d <= t.nav.total; d += 100) {
    last = t.update(pointAt(t.nav, d).point);
    said.push(...last.announce);
  }
  last = t.update(route.path.at(-1));
  said.push(...last.announce);
  assert.ok(last.arrived);
  assert.equal(last.remainingM < 25, true);
  assert.match(said[0], /^Head southwest on The Embarcadero\. Then, in \d+ meters, turn right onto Market St/);
  assert.ok(said.some((x) => /^In \d+ meters, turn left into Golden Gate Park/.test(x)));
  assert.equal(said.at(-1), "You have arrived at your destination");
  // Each step's own instruction is said once, not repeated when the step begins.
  assert.equal(said.filter((x) => x === "Turn left into Golden Gate Park").length, 1);
});

test("navigation reports the next turn and distance to it", () => {
  const route = demoRoutes().google.routes[0];
  const nav = prepareRoute(route);
  const t = createTracker(route);
  const mid = (nav.steps[1].startDist + nav.steps[2].startDist) / 2;
  const u = t.update(pointAt(nav, mid).point);
  assert.equal(u.current.street, "Market St");
  assert.equal(u.next.instruction, "Continue onto Fell St");
  assert.ok(Math.abs(u.toNextM - (nav.steps[2].startDist - mid)) < 5);
  assert.ok(u.remainingSec > 0 && u.remainingSec < route.durationSec);
});

test("navigation notices when you leave the route", () => {
  const route = demoRoutes().apple.routes[0];
  const t = createTracker(route);
  t.update(route.path[0]);
  const away = [route.path[2][0] + 0.01, route.path[2][1]]; // about 1 km north of the line
  assert.ok(snapToRoute(t.nav, away).offBy > 500);
  t.update(away);
  t.update(away);
  assert.equal(t.update(away).needsReroute, true);
  assert.equal(t.update(route.path[3]).needsReroute, false);
});

test("signs a valid ES256 token for Apple", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const token = signAppleToken({ teamId: "TEAM123", keyId: "KEY456", privateKeyPem: pem });
  const [h, p, s] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), { alg: "ES256", kid: "KEY456", typ: "JWT" });
  assert.equal(JSON.parse(Buffer.from(p, "base64url")).iss, "TEAM123");
  const ok = verify("sha256", Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  assert.ok(ok);
});

test("server serves the page, config, demo and explains missing keys", async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  try {
    const page = await fetch(base + "/");
    assert.equal(page.status, 200);
    assert.match(await page.text(), /^<!doctype html>/);
    assert.equal((await fetch(base + "/providers.js")).status, 200);
    assert.equal((await fetch(base + "/../server.js")).status, 404);
    const cfg = await (await fetch(base + "/api/config")).json();
    assert.equal(typeof cfg.google, "boolean");
    const demo = await (await fetch(base + "/api/routes", { method: "POST", body: JSON.stringify({ demo: true }) })).json();
    assert.equal(demo.google.routes.length, demoRoutes().google.routes.length);
    const live = await (await fetch(base + "/api/routes", { method: "POST", body: JSON.stringify({ origin: "A", destination: "B" }) })).json();
    if (!cfg.google) assert.match(live.google.error, /GOOGLE_MAPS_API_KEY/);
    if (!cfg.apple) assert.match(live.apple.error, /Apple/);
  } finally {
    server.close();
  }
});
