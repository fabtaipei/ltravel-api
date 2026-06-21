import type { TripData } from './schema';

/**
 * Route-order suggestion using REAL city coordinates (Duffel Places) — no
 * fabricated geography. We resolve each stop to lat/long, measure the user's
 * open-path travel distance (departure → city1 → … → cityN), then find the
 * destination ordering that minimises total distance. If a meaningfully shorter
 * order exists we return a warning + the suggested order; otherwise everything
 * is null.
 *
 * Additive & fail-soft: if any city can't be resolved to real coordinates we
 * return all-null rather than guess — a suggestion is never fabricated.
 */

const DUFFEL_BASE = 'https://api.duffel.com';
const DUFFEL_VERSION = 'v2';

// Only suggest when the better order is at least this much shorter — avoids
// nagging the user over trivial differences.
const MIN_PCT_SAVING = 0.15;
const MIN_KM_SAVING = 300;
// Brute-force optimal up to this many destinations (7! = 5040); else nearest-neighbour.
const BRUTE_FORCE_MAX = 7;

export interface RouteSuggestion {
  routeWarning: string | null;
  suggestedOrder: string[] | null;
  suggestedOrderReason: string | null;
}

const NONE: RouteSuggestion = {
  routeWarning: null,
  suggestedOrder: null,
  suggestedOrderReason: null,
};

interface Coord {
  lat: number;
  lng: number;
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.DUFFEL_ACCESS_TOKEN ?? ''}`,
    'Duffel-Version': DUFFEL_VERSION,
    Accept: 'application/json',
  };
}

interface DuffelPlace {
  type?: string;
  latitude?: number | null;
  longitude?: number | null;
  // City results carry no coords of their own, but embed their airports (which do).
  airports?: Array<{ latitude?: number | null; longitude?: number | null }>;
}

/** Coordinates for a Duffel place: its own (airports) or its first embedded
 *  airport (cities). null if neither is present. */
function placeCoord(p: DuffelPlace | undefined): Coord | null {
  if (!p) return null;
  if (p.latitude != null && p.longitude != null) return { lat: p.latitude, lng: p.longitude };
  const a = p.airports?.find((x) => x.latitude != null && x.longitude != null);
  return a && a.latitude != null && a.longitude != null
    ? { lat: a.latitude, lng: a.longitude }
    : null;
}

// Resolve city → real coordinates once per request (cities repeat across trips).
const coordCache = new Map<string, Coord | null>();

async function resolveCoord(city: string): Promise<Coord | null> {
  if (!process.env.DUFFEL_ACCESS_TOKEN) return null;
  const key = city.trim().toLowerCase();
  if (coordCache.has(key)) return coordCache.get(key) ?? null;

  try {
    const url = `${DUFFEL_BASE}/places/suggestions?query=${encodeURIComponent(city)}`;
    const res = await fetch(url, { headers: authHeaders(), signal: AbortSignal.timeout(6000) });
    if (!res.ok) {
      coordCache.set(key, null);
      return null;
    }
    const json = (await res.json()) as { data?: DuffelPlace[] };
    // Duffel ranks the best-matching place first — use it (avoids fuzzy name
    // matches like "Rome" → an unrelated airport with "Rom" in its name).
    const coord = placeCoord((json.data ?? [])[0]);
    coordCache.set(key, coord);
    return coord;
  } catch {
    coordCache.set(key, null);
    return null;
  }
}

/** Great-circle distance in km between two coordinates. */
function haversine(a: Coord, b: Coord): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Total distance along an ordered open path (no return to start). */
function pathDistance(coords: Coord[]): number {
  let total = 0;
  for (let i = 0; i < coords.length - 1; i++) total += haversine(coords[i], coords[i + 1]);
  return total;
}

function permutations(arr: number[]): number[][] {
  if (arr.length <= 1) return [arr];
  const out: number[][] = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) out.push([arr[i], ...p]);
  }
  return out;
}

/** Best ordering of destination indices, departure fixed as the origin. */
function bestOrder(depCoord: Coord, destCoords: Coord[]): number[] {
  const idx = destCoords.map((_, i) => i);
  if (destCoords.length <= BRUTE_FORCE_MAX) {
    let best = idx;
    let bestDist = pathDistance([depCoord, ...destCoords]);
    for (const perm of permutations(idx)) {
      const dist = pathDistance([depCoord, ...perm.map((i) => destCoords[i])]);
      if (dist < bestDist) {
        bestDist = dist;
        best = perm;
      }
    }
    return best;
  }
  // Nearest-neighbour for larger trips.
  const remaining = new Set(idx);
  const order: number[] = [];
  let cur = depCoord;
  while (remaining.size > 0) {
    let pick = -1;
    let pickDist = Infinity;
    for (const i of remaining) {
      const d = haversine(cur, destCoords[i]);
      if (d < pickDist) {
        pickDist = d;
        pick = i;
      }
    }
    order.push(pick);
    remaining.delete(pick);
    cur = destCoords[pick];
  }
  return order;
}

/** The interior stop in the user's order that adds the most backtracking. */
function worstDetour(
  names: string[],
  coords: Coord[],
): { city: string; prev: string; next: string } | null {
  let worst: { city: string; prev: string; next: string } | null = null;
  let worstExtra = 0;
  for (let i = 1; i < coords.length - 1; i++) {
    const extra =
      haversine(coords[i - 1], coords[i]) +
      haversine(coords[i], coords[i + 1]) -
      haversine(coords[i - 1], coords[i + 1]);
    if (extra > worstExtra) {
      worstExtra = extra;
      worst = { city: names[i], prev: names[i - 1], next: names[i + 1] };
    }
  }
  return worst;
}

/**
 * Compute a route-order suggestion for the trip. Returns all-null when the
 * chosen order is already efficient or when real coordinates aren't available.
 */
export async function getRouteSuggestion(trip: TripData): Promise<RouteSuggestion> {
  const dests = trip.cities.map((c) => c.trim()).filter(Boolean);
  // Need at least two destinations for a reorder to be possible.
  if (dests.length < 2) return NONE;

  const departure = trip.departureCity.trim();
  const names = [departure, ...dests];
  const resolved = await Promise.all(names.map(resolveCoord));
  // Real data only: if any stop lacks real coordinates, don't guess a route.
  if (resolved.some((c) => c == null)) return NONE;
  const coords = resolved as Coord[];

  const depCoord = coords[0];
  const destCoords = coords.slice(1);

  const userDist = pathDistance([depCoord, ...destCoords]);
  const order = bestOrder(depCoord, destCoords);

  const sameAsUser = order.every((v, i) => v === i);
  if (sameAsUser) return NONE;

  const bestDist = pathDistance([depCoord, ...order.map((i) => destCoords[i])]);
  const saving = userDist - bestDist;
  const pctSaving = userDist > 0 ? saving / userDist : 0;
  // Only suggest a meaningfully shorter order.
  if (pctSaving < MIN_PCT_SAVING || saving < MIN_KM_SAVING) return NONE;

  const suggestedOrder = order.map((i) => dests[i]);
  const detour = worstDetour(names, coords);
  const routeWarning = detour
    ? `visiting ${detour.city} between ${detour.prev} and ${detour.next} adds a long detour`
    : 'your city order backtracks — a different order would cut travel';
  const suggestedOrderReason = `reorders your stops to cut about ${Math.round(pctSaving * 100)}% of the back-and-forth travel`;

  return { routeWarning, suggestedOrder, suggestedOrderReason };
}
