// The user's own data, kept on their device: Home and Work, saved lists, recent searches,
// the trip ledger, and settings. Pure logic over a storage object, so it can be tested in Node.

const KEY = "nav.library.v1";
const MAX_RECENTS = 15;
const MAX_TRIPS = 200;

export const DEFAULT_SETTINGS = {
  units: "auto",        // auto | mi | km
  theme: "auto",        // auto | light | dark
  voice: true,
  avoidTolls: false,
  avoidHighways: false,
  keepHistory: true,    // remember recent searches and trips
};

const DEFAULT_LISTS = () => [
  { id: "favorites", name: "Favorites", icon: "star", places: [] },
  { id: "want", name: "Want to go", icon: "flag", places: [] },
];

function emptyData() {
  return { home: null, work: null, lists: DEFAULT_LISTS(), recents: [], trips: [], reports: [], settings: { ...DEFAULT_SETTINGS } };
}

// What we keep of a place: enough to show it and route to it again.
export function slim(p) {
  if (!p) return null;
  const { id, name, category, kind, at, address, hours, website, phone, sources, demo } = p;
  return { id: id || placeKey(p), name, category, kind, at, address, hours, website, phone, sources, demo };
}
export const placeKey = (p) => p.id || `${p.at[0].toFixed(5)},${p.at[1].toFixed(5)}`;

export function createLibrary(storage) {
  let data = emptyData();
  try {
    const raw = storage?.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      data = { ...data, ...saved, settings: { ...DEFAULT_SETTINGS, ...(saved.settings || {}) } };
      if (!Array.isArray(data.lists) || !data.lists.length) data.lists = DEFAULT_LISTS();
    }
  } catch {}
  const save = () => { try { storage?.setItem(KEY, JSON.stringify(data)); } catch {} };
  const listeners = new Set();
  const changed = () => { save(); for (const f of listeners) f(); };

  const lib = {
    get data() { return data; },
    onChange(f) { listeners.add(f); return () => listeners.delete(f); },

    // Home and Work
    setShortcut(which, place) { data[which] = slim(place); changed(); },
    clearShortcut(which) { data[which] = null; changed(); },

    // Lists
    list(id) { return data.lists.find((l) => l.id === id); },
    createList(name) {
      const id = `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      data.lists.push({ id, name: name.trim() || "New list", icon: "list", places: [] });
      changed();
      return id;
    },
    renameList(id, name) { const l = lib.list(id); if (l && name.trim()) { l.name = name.trim(); changed(); } },
    deleteList(id) {
      if (id === "favorites") return; // always keep one list
      data.lists = data.lists.filter((l) => l.id !== id);
      changed();
    },
    listsWith(place) { const k = placeKey(place); return data.lists.filter((l) => l.places.some((p) => p.id === k)).map((l) => l.id); },
    isSaved(place) { return lib.listsWith(place).length > 0; },
    toggleInList(id, place) {
      const l = lib.list(id);
      if (!l) return false;
      const k = placeKey(place);
      const i = l.places.findIndex((p) => p.id === k);
      if (i >= 0) l.places.splice(i, 1); else l.places.unshift({ ...slim(place), savedAt: Date.now() });
      changed();
      return i < 0;
    },

    // Recents: places opened and words searched, newest first, no repeats.
    addRecent(entry) {
      if (!data.settings.keepHistory) return;
      const item = entry.place ? { place: slim(entry.place), at: Date.now() } : { query: String(entry.query).trim(), at: Date.now() };
      if (!item.place && !item.query) return;
      const same = (r) => (item.place ? r.place?.id === item.place.id : r.query?.toLowerCase() === item.query.toLowerCase());
      data.recents = [item, ...data.recents.filter((r) => !same(r))].slice(0, MAX_RECENTS);
      changed();
    },
    removeRecent(i) { data.recents.splice(i, 1); changed(); },
    clearRecents() { data.recents = []; changed(); },

    // Trip ledger
    logTrip(trip) {
      if (!data.settings.keepHistory) return;
      data.trips = [{ ...trip, at: trip.at || Date.now() }, ...data.trips].slice(0, MAX_TRIPS);
      changed();
    },
    clearTrips() { data.trips = []; changed(); },

    // Road reports (crash, hazard, police, slowdown) the user marked; they fade after an hour.
    addReport(kind, at) { data.reports = [...lib.activeReports(), { kind, at, time: Date.now() }]; changed(); },
    activeReports(now = Date.now()) { return (data.reports || []).filter((r) => now - r.time < 3600_000); },

    // Settings
    set(key, value) { data.settings[key] = value; if (key === "keepHistory" && !value) { data.recents = []; } changed(); },
    reset() { data = emptyData(); changed(); },
  };
  return lib;
}

// Totals for the trip ledger, for trips in the same calendar month as `now`.
export function monthStats(trips, now = new Date()) {
  const inMonth = trips.filter((t) => {
    const d = new Date(t.at);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  });
  const sum = (f) => inMonth.reduce((s, t) => s + (f(t) || 0), 0);
  const wins = { google: 0, apple: 0, both: 0 };
  for (const t of inMonth) wins[t.winner === "both" ? "both" : t.winner === "apple" ? "apple" : "google"]++;
  const tolls = {};
  for (const t of inMonth) if (t.toll?.amount) tolls[t.toll.currency] = (tolls[t.toll.currency] || 0) + t.toll.amount;
  return {
    trips: inMonth.length,
    distanceM: sum((t) => t.distanceM),
    durationSec: sum((t) => t.durationSec),
    savedSec: sum((t) => t.savedSec),
    tollsAvoided: inMonth.filter((t) => t.avoidedToll).length,
    tolls,
    wins,
  };
}

// What the home screen should offer right now: Work in a weekday morning, Home later in the day.
export function suggestedShortcut({ home, work }, now = new Date(), here = null, near = () => Infinity) {
  const h = now.getHours(), weekday = now.getDay() >= 1 && now.getDay() <= 5;
  const atHome = home && here && near(here, home.at) < 300;
  const atWork = work && here && near(here, work.at) < 300;
  if (work && weekday && h >= 5 && h < 11 && !atWork) return { which: "work", place: work, why: "Morning commute" };
  if (home && !atHome && (h >= 15 || h < 5 || !weekday)) return { which: "home", place: home, why: h >= 15 ? "Heading home?" : "Back home" };
  if (work && !atWork && weekday && h >= 11 && h < 15) return { which: "work", place: work, why: "Back to work" };
  if (home && !atHome) return { which: "home", place: home, why: "Heading home?" };
  return null;
}
