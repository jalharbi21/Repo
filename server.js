// Small server for the navigation app. It keeps API keys off the browser,
// calls Google and Apple for routes, and serves the web page in public/.
// No dependencies: needs Node 18 or newer.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createPrivateKey, sign } from "node:crypto";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchGoogleRoutes, fetchAppleRoutes, getAppleAccessToken, demoRoutes } from "./public/providers.js";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC = join(ROOT, "public");

// Load .env if present (KEY=value lines).
const envFile = join(ROOT, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const PORT = Number(process.env.PORT) || 3000;
const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY || "";

// Apple: either a ready-made token, or the pieces to sign one (team id, key id, .p8 private key).
function appleKeyPem() {
  if (process.env.APPLE_MAPS_PRIVATE_KEY) return process.env.APPLE_MAPS_PRIVATE_KEY.replace(/\\n/g, "\n");
  const path = process.env.APPLE_MAPS_PRIVATE_KEY_PATH;
  return path && existsSync(path) ? readFileSync(path, "utf8") : "";
}

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

export function signAppleToken({ teamId, keyId, privateKeyPem, ttlSec = 1800 }) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iss: teamId, iat: now, exp: now + ttlSec }));
  const key = createPrivateKey(privateKeyPem);
  const sig = sign("sha256", Buffer.from(`${header}.${payload}`), { key, dsaEncoding: "ieee-p1363" });
  return `${header}.${payload}.${b64url(sig)}`;
}

function appleAuthToken() {
  if (process.env.APPLE_MAPS_TOKEN) return process.env.APPLE_MAPS_TOKEN;
  const teamId = process.env.APPLE_TEAM_ID;
  const keyId = process.env.APPLE_MAPS_KEY_ID;
  const privateKeyPem = appleKeyPem();
  if (teamId && keyId && privateKeyPem) return signAppleToken({ teamId, keyId, privateKeyPem });
  return "";
}

// Cache Apple's short-lived access token (valid ~30 min).
let appleCache = { token: "", expires: 0 };
async function appleAccessToken() {
  if (appleCache.token && Date.now() < appleCache.expires) return appleCache.token;
  const token = await getAppleAccessToken({ authToken: appleAuthToken() });
  appleCache = { token, expires: Date.now() + 25 * 60 * 1000 };
  return token;
}

const config = () => ({ google: Boolean(GOOGLE_KEY), apple: Boolean(appleAuthToken()) });

async function settle(promise) {
  try {
    return { ok: true, ...(await promise) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function handleRoutes(body) {
  const { origin, destination, mode = "drive", demo } = body || {};
  if (demo) {
    const d = demoRoutes();
    return { demo: true, origin: d.origin, destination: d.destination, google: { ok: true, ...d.google }, apple: { ok: true, ...d.apple } };
  }
  if (!origin || !destination) return { status: 400, error: "Enter both a start and a destination" };
  const cfg = config();
  const [google, apple] = await Promise.all([
    cfg.google
      ? settle(fetchGoogleRoutes({ apiKey: GOOGLE_KEY, origin, destination, mode }))
      : { ok: false, error: "Google isn't set up on the server (GOOGLE_MAPS_API_KEY)" },
    cfg.apple
      ? settle(appleAccessToken().then((accessToken) => fetchAppleRoutes({ accessToken, origin, destination, mode })))
      : { ok: false, error: "Apple isn't set up on the server (see README)" },
  ]);
  return { origin, destination, mode, google, apple };
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

export const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/api/config") return send(res, 200, config());
    if (url.pathname === "/api/routes" && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 10_000) return send(res, 413, { error: "Request too large" });
      }
      const result = await handleRoutes(JSON.parse(raw || "{}"));
      return send(res, result.status || 200, result);
    }
    const rel = normalize(url.pathname === "/" ? "/index.html" : url.pathname).replace(/^(\.\.[/\\])+/, "");
    const file = join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC)) return send(res, 403, "Forbidden", "text/plain");
    let data = await readFile(file);
    // index.html is written without <html>/<head> so it can also be published as a single page; wrap it here.
    if (file.endsWith(".html") && !/^\s*<!doctype/i.test(data.toString("utf8", 0, 50))) {
      data = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body>\n${data}\n</body></html>`;
    }
    return send(res, 200, data, TYPES[extname(file)] || "application/octet-stream");
  } catch (err) {
    if (err.code === "ENOENT") return send(res, 404, "Not found", "text/plain");
    return send(res, 500, { error: err.message });
  }
});

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  server.listen(PORT, () => {
    const cfg = config();
    console.log(`Navigation app running at http://localhost:${PORT}`);
    console.log(`  Google Maps: ${cfg.google ? "ready" : "not set up"}`);
    console.log(`  Apple Maps:  ${cfg.apple ? "ready" : "not set up"}`);
  });
}
