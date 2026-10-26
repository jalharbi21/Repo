// Builds public/demo-places.js: the sample places and real street routes to each of them from the
// sample location (Times Square). Run with `node scripts/make-demo-places.mjs` (needs internet).
// Routes come from the OSRM demo routers on OpenStreetMap data. Hours are examples, not live data.
import { writeFile } from "node:fs/promises";

const ORIGIN = { name: "Times Square", address: "Broadway & 7th Ave, New York, NY", at: [40.758, -73.98551] };

// [id, name, category, lat, lng, address, hours, website]
// hours: "daily HH-HH", "24h", or per-day "mon-fri HH-HH; sat-sun HH-HH". Example values.
const PLACES = [
  ["central-park", "Central Park · Bethesda Terrace", "park", 40.774, -73.9708, "Central Park, New York, NY", "daily 06-25", "https://www.centralparknyc.org"],
  ["moma", "Museum of Modern Art", "museum", 40.7614, -73.9776, "11 W 53rd St, New York, NY", "daily 10.5-17.5", "https://www.moma.org"],
  ["empire-state", "Empire State Building", "landmark", 40.7484, -73.9857, "20 W 34th St, New York, NY", "daily 10-24", "https://www.esbnyc.com"],
  ["grand-central", "Grand Central Terminal", "transit", 40.7527, -73.9772, "89 E 42nd St, New York, NY", "daily 5.5-26", "https://www.grandcentralterminal.com"],
  ["bryant-park", "Bryant Park", "park", 40.7536, -73.9832, "6th Ave & W 42nd St, New York, NY", "daily 07-22", "https://bryantpark.org"],
  ["the-plaza", "The Plaza Hotel", "hotel", 40.7646, -73.9743, "768 5th Ave, New York, NY", "24h", "https://www.theplazany.com"],
  ["joes-pizza", "Joe's Pizza · Broadway", "food", 40.7547, -73.987, "1435 Broadway, New York, NY", "daily 10-28", "https://www.joespizzanyc.com"],
  ["katz", "Katz's Delicatessen", "food", 40.7223, -73.9874, "205 E Houston St, New York, NY", "mon-thu 08-22.75; fri-sat 08-26; sun 08-22.75", "https://katzsdelicatessen.com"],
  ["union-sq-market", "Union Square Greenmarket", "grocery", 40.7359, -73.9906, "E 17th St & Broadway, New York, NY", "mon 08-18; wed 08-18; fri-sat 08-18", "https://www.grownyc.org/greenmarket"],
  ["flatiron", "Flatiron Building", "landmark", 40.7411, -73.9897, "175 5th Ave, New York, NY", "24h", ""],
  ["brooklyn-bridge-park", "Brooklyn Bridge Park · Pier 1", "park", 40.7003, -73.9967, "Furman St, Brooklyn, NY", "daily 06-25", "https://www.brooklynbridgepark.org"],
  ["peter-luger", "Peter Luger Steak House", "food", 40.7099, -73.9625, "178 Broadway, Brooklyn, NY", "mon-thu 11.75-21.75; fri-sat 11.75-22.75; sun 12.75-21.75", "https://peterluger.com"],
  ["devocion", "Devoción", "coffee", 40.7158, -73.9645, "69 Grand St, Brooklyn, NY", "mon-fri 07-19; sat-sun 08-19", "https://www.devocion.com"],
  ["barclays", "Barclays Center", "venue", 40.6826, -73.9754, "620 Atlantic Ave, Brooklyn, NY", "daily 10-23", "https://www.barclayscenter.com"],
  ["prospect-park", "Prospect Park · Grand Army Plaza", "park", 40.6731, -73.9701, "Grand Army Plaza, Brooklyn, NY", "daily 05-25", "https://www.prospectpark.org"],
  ["brooklyn-museum", "Brooklyn Museum", "museum", 40.6712, -73.9636, "200 Eastern Pkwy, Brooklyn, NY", "wed-sun 11-18", "https://www.brooklynmuseum.org"],
  ["home-sample", "7th Ave & 9th St (sample home)", "address", 40.6683, -73.98, "7th Ave & 9th St, Brooklyn, NY", "", ""],
  ["astoria-park", "Astoria Park", "park", 40.779, -73.922, "19 19th St, Astoria, NY", "daily 06-25", ""],
  ["flushing-meadows", "Flushing Meadows Corona Park", "park", 40.74, -73.8407, "Flushing Meadows Corona Park, Queens, NY", "daily 06-25", ""],
  ["lga", "LaGuardia Airport", "airport", 40.7769, -73.874, "LaGuardia Airport, Queens, NY", "24h", "https://www.laguardiaairport.com"],
  ["jfk", "JFK Airport, Terminal 5", "airport", 40.6455, -73.7768, "JFK Airport, Terminal 5, Queens, NY", "24h", "https://www.jfkairport.com"],
  ["gas-11th", "Gas station · 11th Ave & W 45th St", "gas", 40.7631, -73.9967, "11th Ave & W 45th St, New York, NY", "24h", ""],
  ["gas-lic", "Gas station · Northern Blvd, LIC", "gas", 40.7502, -73.9383, "Northern Blvd & 36th St, Long Island City, NY", "24h", ""],
  ["ev-lic", "EV fast charging · Long Island City", "ev", 40.7447, -73.9485, "Jackson Ave, Long Island City, NY", "24h", ""],
  ["ev-brooklyn", "EV charging · Atlantic Terminal garage", "ev", 40.6853, -73.9772, "Atlantic Ave & Flatbush Ave, Brooklyn, NY", "24h", ""],
  ["parking-46th", "Parking garage · W 46th St", "parking", 40.76, -73.987, "W 46th St near 7th Ave, New York, NY", "24h", ""],
  ["parking-34th", "Parking garage · W 33rd St", "parking", 40.7505, -73.992, "W 33rd St near 8th Ave, New York, NY", "24h", ""],
  ["pharmacy-40th", "Pharmacy · 7th Ave & W 40th St", "pharmacy", 40.7547, -73.9877, "7th Ave & W 40th St, New York, NY", "24h", ""],
  ["grocery-atlantic", "Supermarket · Atlantic Ave", "grocery", 40.6862, -73.9776, "Atlantic Ave, Brooklyn, NY", "daily 07-23", ""],
  ["coffee-bryant", "Coffee kiosk · Bryant Park", "coffee", 40.7539, -73.9838, "Bryant Park, New York, NY", "daily 07-19", ""],
];

const ROUTERS = {
  drive: "https://router.project-osrm.org/route/v1/driving",
  walk: "https://routing.openstreetmap.de/routed-foot/route/v1/driving",
  bike: "https://routing.openstreetmap.de/routed-bike/route/v1/driving",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function osrm(mode, to, extra = "") {
  const url = `${ROUTERS[mode]}/${ORIGIN.at[1]},${ORIGIN.at[0]};${to[1]},${to[0]}?overview=full&geometries=geojson&steps=true&alternatives=${mode === "drive" ? 2 : "false"}${extra}`;
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(url);
      const data = await res.json();
      if (data.code === "Ok") return data.routes;
      if (data.code === "NoRoute") return [];
      throw new Error(data.code);
    } catch (e) {
      await sleep(1500 * (i + 1));
    }
  }
  return [];
}

const DIRS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
const ord = (n) => `${n}${["th", "st", "nd", "rd"][(n % 100 > 10 && n % 100 < 14) || n % 10 > 3 ? 0 : n % 10]}`;
function instruction(st, destName) {
  const m = st.maneuver;
  const name = st.name || st.ref || "";
  const onto = name ? ` onto ${name}` : "";
  const mod = m.modifier || "";
  switch (m.type) {
    case "depart": return `Head ${DIRS[Math.round(m.bearing_after / 45) % 8]}${name ? ` on ${name}` : ""}`;
    case "arrive": return `Arrive at ${destName}`;
    case "merge": return `Merge${onto || " ahead"}`;
    case "on ramp": return `Take the ramp${onto || (st.destinations ? ` toward ${st.destinations}` : "")}`;
    case "off ramp": return `Take the exit${st.destinations ? ` toward ${st.destinations.split(",")[0]}` : onto}`;
    case "fork": return `Keep ${mod.includes("left") ? "left" : "right"}${onto}`;
    case "roundabout": case "rotary": return `At the roundabout, take the ${ord(m.exit || 1)} exit${onto}`;
    case "new name": case "continue": return mod === "uturn" ? `Make a U-turn${onto}` : `Continue${onto || " straight"}`;
    default:
      if (mod === "uturn") return `Make a U-turn${onto}`;
      if (mod === "straight") return `Continue straight${onto}`;
      return `Turn ${mod}${onto}`;
  }
}

// Douglas-Peucker in local metres, so the file stays small.
function simplify(pts, tol = 3) {
  if (pts.length < 3) return pts;
  const k = Math.cos((pts[0][0] * Math.PI) / 180) * 111320;
  const xy = pts.map(([la, ln]) => [ln * k, la * 110540]);
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let best = 0, idx = -1;
    const [ax, ay] = xy[a], [bx, by] = xy[b];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * (xy[i][0] - ax) - dx * (xy[i][1] - ay)) / len;
      if (d > best) { best = d; idx = i; }
    }
    if (best > tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

function encode(path) {
  const out = [];
  let a = 0, b = 0;
  for (const [la, ln] of path) {
    const x = Math.round(la * 1e5), y = Math.round(ln * 1e5);
    out.push(x - a, y - b);
    a = x; b = y;
  }
  return out;
}

function convert(r, destName) {
  const path = [];
  const steps = [];
  let tolls = false, highway = false;
  for (const st of r.legs.flatMap((l) => l.steps)) {
    for (const x of st.intersections || []) {
      if (x.classes?.includes("toll")) tolls = true;
      if (x.classes?.includes("motorway")) highway = true;
    }
    const pts = simplify(st.geometry.coordinates.map(([ln, la]) => [Math.round(la * 1e5) / 1e5, Math.round(ln * 1e5) / 1e5]));
    const startIdx = Math.max(0, path.length - 1);
    path.push(...(path.length ? pts.slice(1) : pts));
    const text = instruction(st, destName);
    const prev = steps.at(-1);
    // Fold tiny "continue" steps into the one before, as the map apps do.
    if (prev && st.maneuver.type !== "arrive" && /^Continue/.test(text) && st.distance < 60) {
      prev[1] += Math.round(st.distance); prev[2] += Math.round(st.duration);
      continue;
    }
    steps.push([text, Math.round(st.distance), Math.round(st.duration), startIdx]);
  }
  // The demo routers don't always tag tolls and motorways, so also read them from the step text.
  const text = steps.map((x) => x[0]).join(" ");
  if (TOLL_NAMES.test(text)) tolls = true;
  if (HIGHWAY_NAMES.test(text)) highway = true;
  const via = [...new Set(r.legs.flatMap((l) => l.steps).filter((s) => s.name && s.distance > 600).sort((a, b) => b.distance - a.distance).map((s) => s.name))].slice(0, 2);
  return { d: Math.round(r.duration), m: Math.round(r.distance), via: via.join(" and "), tolls, highway, path: encode(path), steps };
}

// New York's tolled crossings and the road names that mean a highway.
export const TOLL_NAMES = /Queens-Midtown Tunnel|Hugh L\.? Carey Tunnel|Lincoln Tunnel|Holland Tunnel|RFK Bridge|Triborough|Verrazz?ano|Throgs Neck|Whitestone Bridge/i;
export const HIGHWAY_NAMES = /Expressway|Expwy|Parkway|Pkwy|FDR Drive|\bI \d+/i;

const sameRoute = (a, b) => Math.abs(a.m - b.m) < 80 && Math.abs(a.d - b.d) < 40;

if (process.argv.includes("--retag")) {
  // Re-reads tolls and highways from the existing file without asking the routers again.
  const { DEMO_PLACES } = await import("../public/demo-places.js");
  for (const modes of Object.values(DEMO_PLACES.routes)) {
    for (const r of modes.drive || []) {
      const text = r.steps.map((x) => x[0]).join(" ");
      r.tolls ||= TOLL_NAMES.test(text);
      r.highway ||= HIGHWAY_NAMES.test(text);
    }
  }
  await save(DEMO_PLACES);
  process.exit(0);
}

const out = { origin: ORIGIN, places: [], routes: {} };
for (const [id, name, category, lat, lng, address, hours, website] of PLACES) {
  out.places.push({ id, name, category, at: [lat, lng], address, hours, website });
  out.routes[id] = {};
  for (const mode of ["drive", "walk", "bike"]) {
    if (mode === "drive" && id === "jfk") continue; // uses the original sample trip, with its toll tunnel
    let list = (await osrm(mode, [lat, lng])).map((r) => convert(r, name));
    if (mode === "drive") {
      for (const ex of ["&exclude=toll", "&exclude=motorway"]) {
        for (const r of (await osrm(mode, [lat, lng], ex)).slice(0, 1).map((x) => convert(x, name))) {
          if (!list.some((x) => sameRoute(x, r))) list.push(r);
        }
      }
    }
    out.routes[id][mode] = list.slice(0, 3);
    process.stdout.write(`${id} ${mode}: ${list.length}\n`);
    await sleep(300);
  }
}

await save(out);

async function save(data) {
  const header = `// Sample places and real street routes to them from Times Square. Generated by scripts/make-demo-places.mjs
// from OpenStreetMap data (OSRM routers). Hours are examples, not live data.
// Paths are delta-encoded 1e-5 degrees; steps are [instruction, metres, seconds, path index].
`;
  await writeFile("public/demo-places.js", `${header}export const DEMO_PLACES = ${JSON.stringify(data)};\n`);
  console.log("Wrote public/demo-places.js");
}
