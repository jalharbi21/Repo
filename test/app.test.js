import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { decodePolyline, fetchGoogleRoutes, fetchAppleRoutes, handoffLinks, parseLatLng, demoRoutes } from "../public/providers.js";
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
  assert.deepEqual(r.routes[0].steps, [{ instruction: "Head north", distanceM: 500 }]);
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
  assert.deepEqual(r.routes[0].steps, [{ instruction: "Take I-280 N", distanceM: 9000 }]);
});

test("builds hand-off links for both apps", () => {
  const l = handoffLinks("Ferry Building", "Golden Gate Park", "walk");
  assert.match(l.google, /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&origin=Ferry\+Building/);
  assert.match(l.google, /travelmode=walking/);
  assert.match(l.apple, /^https:\/\/maps\.apple\.com\/\?saddr=Ferry\+Building&daddr=Golden\+Gate\+Park&dirflg=w/);
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
