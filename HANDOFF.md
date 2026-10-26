# Handoff: Two-Map Navigator

Read this first when picking up work on this repo.

## What it is
A web navigation app that uses **Google Maps** and **Apple Maps** only as data sources. For each trip it asks both, merges the answers, and drives the **fastest route** with its own turn-by-turn navigation. It never opens the Google or Apple apps.

Owner: Sajan (GitHub `jalharbi21`). Work so far is on branch `claude/project-thread-9295od`, PR #1.

## What's built
- **One route panel** over a full-screen map. It shows the fastest route first, then the alternatives ranked by time. When Google and Apple suggest the same road, it's shown once.
- **Tolls:** each route shows its price from Google (`extraComputations: TOLLS`), or "No tolls". Apple only reports has-tolls, so an Apple route on the same road as a Google route borrows Google's price.
- **Avoid tolls / Avoid highways switches:** sent as Google `routeModifiers` and Apple `avoid=Tolls`. Apple can't avoid highways, so with that switch on only Google's routes are used.
- **Navigation screen:**
  - turn banner with the next and the following maneuver
  - a map that follows your position
  - time and distance left, arrival time, current street and toll
  - spoken directions (miles and feet for US English)
  - off-route detection with re-routing
  - live GPS or a simulated drive (1×, 4×, 10×)
- **Map:** OpenStreetMap raster tiles. Where tiles can't load (claude.ai blocks outside images), it falls back to a built-in vector map of the sample area.
- **Sample trip:** Times Square → JFK on real streets. Its three routes are a toll tunnel (fastest), a toll-free bridge route, and a no-highway route. The times and the $6.94 toll are examples, not live data.
- **Try-it page:** https://claude.ai/artifact/WxkB5dPH5LPUFx6Z3YwC7s. It is published from `public/` and shows the sample trip only, because claude.ai pages can't call outside APIs.

## Files
| Path | What it does |
|---|---|
| `server.js` | Node server with no runtime dependencies. `POST /api/routes` asks both services and merges the results; `GET /api/config` reports which keys are set. It serves `public/`. |
| `public/providers.js` | Google Routes API and Apple Maps Server API clients, `mergeRoutes`, and the sample-trip data source. Shared by the server and the page. |
| `public/nav.js` | Navigation engine (pure functions): snap to route, progress, voice prompts, off-route detection. |
| `public/app.js` | Page logic: search, result panel, map, navigation screen. |
| `public/index.html` | Markup and CSS, with Leaflet's CSS inlined. It has no `<html>`/`<head>`; the server wraps it, and the claude.ai publisher adds its own wrapper. |
| `public/demo-trip.js`, `public/demo-basemap.json` | Sample trip and built-in vector map. They were generated from OSRM routes and OpenFreeMap (OpenMapTiles) vector tiles; the generator scripts were not kept. |
| `scripts/build.mjs` | Production build into `dist/` (esbuild bundle + minify). |
| `test/app.test.js` | `node --test` suite (17 tests). |

## Run it
```bash
cp .env.example .env      # add keys (either provider is optional)
npm start                 # dev: http://localhost:3000
npm test
npm install && npm run build && npm run start:prod   # compiled build in dist/
```
`dist/` is committed. To update it after changing source, run `npm run build`.

## Key setup
- **Google:** a Cloud API key with the **Routes API** enabled, set as `GOOGLE_MAPS_API_KEY`.
- **Apple** (needs a paid developer account): a Maps ID plus a key with MapKit/Maps enabled. Either set `APPLE_TEAM_ID`, `APPLE_MAPS_KEY_ID` and `APPLE_MAPS_PRIVATE_KEY_PATH`, and the server signs ES256 tokens itself, or paste a token into `APPLE_MAPS_TOKEN`.
- Live GPS only works on `localhost` or HTTPS.

## Not done / next steps
- **Never tested against the live Google/Apple APIs or real GPS**, because no keys or device were available. Expect small field-mapping fixes on the first live run, especially Apple's `avoid` and cycling support and Google's toll fields.
- Apple has no toll prices or highway avoidance, so those rely on Google.
- No address autocomplete or geocoding UI. Both APIs take free-text addresses or `lat,lng`.
- No hosting or HTTPS setup yet, which a phone needs for GPS.
- The voice uses the browser's speech engine, and the strings are English only.
