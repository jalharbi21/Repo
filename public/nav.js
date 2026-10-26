// Turn-by-turn navigation engine. Pure functions, no DOM: given a route and a
// position, it works out where you are on the route, the next turn, and what's left.

const R = 6371008.8; // mean Earth radius, metres
const rad = (d) => (d * Math.PI) / 180;

export function distanceM(a, b) {
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearingDeg(a, b) {
  const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
  const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// Precomputes distances along the route and where each step starts.
export function prepareRoute(route) {
  const path = route.path;
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + distanceM(path[i - 1], path[i]));
  const total = cum.at(-1) || 0;
  const stepSum = route.steps.reduce((t, s) => t + (s.distanceM || 0), 0) || 1;
  let run = 0;
  const steps = route.steps.map((s) => {
    // Prefer the exact start point on the line; otherwise place the step by its share of the distance.
    const startDist = Number.isInteger(s.startIdx) && s.startIdx < cum.length ? cum[s.startIdx] : (run / stepSum) * total;
    run += s.distanceM || 0;
    return { ...s, startDist };
  });
  steps.sort((a, b) => a.startDist - b.startDist);
  return { route, path, cum, total, steps, durationSec: route.durationSec || 0 };
}

// Point -> nearest point on the route. Works in a local flat projection, which is exact enough at street scale.
export function snapToRoute(nav, pos, hintIdx = 0) {
  const { path, cum } = nav;
  if (path.length < 2) return { along: 0, offBy: path.length ? distanceM(pos, path[0]) : Infinity, segIdx: 0, point: path[0] || pos };
  const kx = Math.cos(rad(pos[0])) * 111320;
  const ky = 110540;
  // Search near where we were last time, then fall back to the whole line.
  const ranges = [[Math.max(0, hintIdx - 5), Math.min(path.length - 1, hintIdx + 60)], [0, path.length - 1]];
  let best = null;
  for (const [from, to] of ranges) {
    for (let i = from; i < to; i++) {
      const a = path[i], b = path[i + 1];
      const ax = (a[1] - pos[1]) * kx, ay = (a[0] - pos[0]) * ky;
      const bx = (b[1] - pos[1]) * kx, by = (b[0] - pos[0]) * ky;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      const px = ax + t * dx, py = ay + t * dy;
      const d = Math.hypot(px, py);
      if (!best || d < best.offBy) {
        best = { offBy: d, segIdx: i, t, along: cum[i] + t * (cum[i + 1] - cum[i]), point: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])] };
      }
    }
    if (best && best.offBy < 40) break; // close enough in the local window
  }
  return best;
}

// Point at a given distance along the route (used by the drive simulator).
export function pointAt(nav, along) {
  const { path, cum } = nav;
  if (along <= 0) return { point: path[0], segIdx: 0 };
  if (along >= nav.total) return { point: path.at(-1), segIdx: path.length - 2 };
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= along) lo = mid; else hi = mid;
  }
  const t = (along - cum[lo]) / (cum[hi] - cum[lo] || 1);
  const a = path[lo], b = path[hi];
  return { point: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])], segIdx: lo, heading: bearingDeg(a, b) };
}

// Where you are in the turn list and what's left.
export function progress(nav, along) {
  const { steps, total, durationSec } = nav;
  let i = 0;
  while (i + 1 < steps.length && steps[i + 1].startDist <= along + 1) i++;
  const next = steps[i + 1] || null;
  const remainingM = Math.max(0, total - along);
  return {
    stepIdx: i,
    current: steps[i] || null,
    next,
    toNextM: next ? Math.max(0, next.startDist - along) : remainingM,
    remainingM,
    remainingSec: total ? durationSec * (remainingM / total) : 0,
    arrived: remainingM < 25,
  };
}

// Stateful tracker: feed it positions, it tells you what to show and say.
export function createTracker(route, { offRouteM = 45, offRouteFixes = 3, imperial = false } = {}) {
  const nav = prepareRoute(route);
  let hint = 0, lastStep = -1, strikes = 0, spoken = new Set(), maxAlong = 0, stepStartToNext = 0, justSaid = "";
  return {
    nav,
    update(pos) {
      const snap = snapToRoute(nav, pos, hint);
      hint = snap.segIdx;
      const offRoute = snap.offBy > offRouteM;
      strikes = offRoute ? strikes + 1 : 0;
      // Don't jump backwards on small GPS wobble.
      const along = offRoute ? maxAlong : Math.max(snap.along, maxAlong - 30);
      if (!offRoute) maxAlong = Math.max(maxAlong, snap.along);
      const p = progress(nav, along);
      const announce = [];
      if (p.stepIdx !== lastStep) {
        lastStep = p.stepIdx;
        spoken = new Set();
        stepStartToNext = p.toNextM;
        const alreadySaid = p.current && p.current.instruction === justSaid;
        if (p.current && !alreadySaid) {
          announce.push(p.next ? `${p.current.instruction}. Then, in ${speakDist(p.toNextM, imperial)}, ${lowerFirst(p.next.instruction)}` : p.current.instruction);
        } else if (p.next && p.toNextM < 800) {
          announce.push(`Then, in ${speakDist(p.toNextM, imperial)}, ${lowerFirst(p.next.instruction)}`);
        }
      }
      if (p.next) {
        // Reminders as the turn gets close, only for distances we actually crossed during this step.
        for (const mark of [800, 200]) {
          if (stepStartToNext > mark * 1.25 && p.toNextM <= mark && !spoken.has(mark)) {
            spoken.add(mark);
            announce.push(`In ${speakDist(p.toNextM, imperial)}, ${lowerFirst(p.next.instruction)}`);
          }
        }
        if (stepStartToNext > 80 && p.toNextM <= 40 && !spoken.has("now")) {
          spoken.add("now");
          justSaid = p.next.instruction;
          announce.push(p.next.instruction);
        }
      }
      if (p.arrived && !spoken.has("arrived")) {
        spoken.add("arrived");
        announce.push("You have arrived at your destination");
      }
      return { ...p, snapped: snap.point, offBy: snap.offBy, needsReroute: strikes >= offRouteFixes, announce };
    },
  };
}

export function speakDist(m, imperial = false) {
  if (imperial) {
    const mi = m / 1609.344;
    if (mi >= 0.2) {
      if (mi < 0.35) return "a quarter mile";
      if (mi < 0.65) return "half a mile";
      if (mi < 0.9) return "three quarters of a mile";
      const r = mi >= 10 ? Math.round(mi) : Math.round(mi * 10) / 10;
      return `${r} ${r === 1 ? "mile" : "miles"}`;
    }
    const ft = m * 3.28084;
    return `${Math.max(50, Math.round(ft / 100) * 100 || 50)} feet`;
  }
  if (m >= 1000) return `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} kilometers`;
  if (m >= 100) return `${Math.round(m / 50) * 50} meters`;
  return `${Math.max(10, Math.round(m / 10) * 10)} meters`;
}
const lowerFirst = (t) => (t ? t[0].toLowerCase() + t.slice(1) : t);
