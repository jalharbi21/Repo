# Two-Map Navigator

A navigation web app that uses **Google Maps** and **Apple Maps** as its data sources. For each trip it asks both services, merges their answers, and shows you one list with the fastest route on top. You don't pick a provider; the app does.

- **One route panel:** travel time, distance, arrival time, traffic delay, and every alternative ranked by time. When Google and Apple suggest the same road, it's shown once.
- **Tolls:** each route shows its toll price (from Google's toll estimates) or "No tolls". Apple only says whether a route has tolls, so when both services found the same road the app uses Google's price for it.
- **Avoid tolls / Avoid highways:** switches that are sent to both services. Apple can't avoid highways, so with that switch on only Google's routes are used.
- **Built-in turn-by-turn navigation**, without opening the Google or Apple apps:
  - turn banner with the next maneuver, the distance to it, and the turn after that
  - the map follows you, with the road behind you greyed out
  - time and distance left, arrival time, the street you're on, and the toll
  - spoken directions, which you can mute
  - when you leave the route, it gets a new one from where you are
  - live GPS, or a simulated drive (1×, 4×, 10×) for trying it from a desk

It opens with a sample trip from Times Square to JFK Airport, which has a toll tunnel, a toll-free bridge route and a no-highway route, so the switches have something to show before you add keys.

## Run it

Needs Node.js 18 or newer. There is nothing to install.

```bash
cp .env.example .env     # then fill in your keys
npm start                # opens on http://localhost:3000
```

### Compiled build

```bash
npm install          # installs the build tool (esbuild)
npm run build        # bundles and minifies into dist/
npm run start:prod   # runs dist/server.js
```

## Keys you need

Each provider is optional. With only one set up, the app shows that one and says the other is missing.

**Google Maps**
1. In the [Google Cloud console](https://console.cloud.google.com/), create a project and turn on billing (Google gives a monthly free allowance).
2. Enable the **Routes API**.
3. Create an API key under *APIs & Services → Credentials* and put it in `GOOGLE_MAPS_API_KEY`.

**Apple Maps** (needs a paid Apple Developer account)
1. In [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/identifiers/list/mapsId), create a **Maps ID**, then a **Key** with *MapKit JS / Maps* enabled. Download the `.p8` file.
2. Either put your Team ID, the Key ID and the `.p8` path in `.env` (the server then signs fresh tokens on its own), or create a Maps token on the developer site and paste it into `APPLE_MAPS_TOKEN`.

Keys stay on the server and never reach the browser.

## How it works

- `server.js` is a small Node server with no dependencies. `POST /api/routes` calls both services in parallel, merges the results, and returns them fastest first. A failure on one side doesn't block the other.
- `public/providers.js` talks to the [Google Routes API](https://developers.google.com/maps/documentation/routes) and the [Apple Maps Server API](https://developer.apple.com/documentation/applemapsserverapi), turns both answers into the same shape, and merges them (`mergeRoutes`).
- `public/nav.js` is the navigation engine. It snaps your position onto the route and works out the current and next step, the distance and time left, and when to speak. It also notices when you've left the route.
- `public/app.js` and `public/index.html` are the page. The map uses Leaflet with OpenStreetMap tiles.
- `public/demo-trip.js` and `public/demo-basemap.json` hold the sample trip. The streets come from OpenStreetMap, the routes from the OSRM demo router, and the times and toll price are examples. The built-in vector map is only used where map tiles can't load, such as on a claude.ai page.
- Without the server, the page can take keys pasted into the key dialog and call the services straight from the browser, where the browser allows it.

Live GPS needs the page on `localhost` or HTTPS (browsers block location on plain HTTP). To use it on your phone, host the app behind HTTPS or open it through a tunnel.

Travel modes: drive, walk and bike. Apple doesn't offer cycling directions everywhere; when it can't, the Apple card says so.

## Tests

```bash
npm test
```
