# Two-Map Navigator

A navigation web app that uses **Google Maps** and **Apple Maps** as its data sources. It asks both for routes at the same time, shows them side by side (travel time, traffic delay, distance, alternatives, street-by-street steps, both routes on one map), and tells you which is faster.

Then it navigates you itself, without opening the Google or Apple apps:

- a turn banner with the next maneuver, distance to it, and the turn after that
- the map follows your position along the route, with the road behind you greyed out
- time and distance left, arrival time, and the street you're on
- spoken directions ("In 200 meters, turn right onto Market St"), which you can mute
- off-route detection: leave the line and it asks Google or Apple for a new route from where you are
- live GPS, or a simulated drive (1×, 4×, 10×) for trying it from a desk

It opens with a sample trip in San Francisco so you can see how it works before adding any keys.

## Run it

Needs Node.js 18 or newer. There is nothing to install.

```bash
cp .env.example .env     # then fill in your keys
npm start                # opens on http://localhost:3000
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

- `server.js` is a small Node server with no dependencies. `POST /api/routes` calls both services in parallel and returns one combined answer; a failure on one side doesn't block the other.
- `public/providers.js` talks to the [Google Routes API](https://developers.google.com/maps/documentation/routes) and the [Apple Maps Server API](https://developer.apple.com/documentation/applemapsserverapi) and turns both answers into the same shape.
- `public/nav.js` is the navigation engine: it snaps your position onto the route, works out the current and next step, distance and time left, when to speak, and when you've left the route.
- `public/index.html` is the page. The map uses Leaflet with OpenStreetMap tiles, so neither company's map is needed just to draw the lines.
- Without the server (for example opened as a hosted page), the page can take keys pasted into the *API keys* dialog and call the services straight from the browser, where the browser allows it.

Live GPS needs the page on `localhost` or HTTPS (browsers block location on plain HTTP). To use it on your phone, host the app behind HTTPS or open it through a tunnel.

Travel modes: drive, walk and bike. Apple doesn't offer cycling directions everywhere; when it can't, the Apple card says so.

## Tests

```bash
npm test
```
