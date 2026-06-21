import type { TripData } from './schema';

/**
 * LiteAPI (Nuitée) — hotel search.
 *
 * Two-call flow per destination city:
 *   1. GET /data/hotels  → list of hotels (id + name + metadata) for the city
 *   2. POST /hotels/rates → cheapest priced offer per hotel id (for the date window)
 * then join on hotel id (note: the LIST returns `id`, the RATES response returns
 * `hotelId` — same value, different key) and return the cheapest hotel.
 *
 * City → countryCode/coordinates is resolved via Duffel's free `/places/suggestions`
 * (the same endpoint the flight search uses), so no paid geocoder is needed.
 *
 * Auth: LiteAPI uses the `X-API-Key` header (LITEAPI_KEY — a `sand_…` key in test,
 * `prod_…` in production). Every path fails soft (returns null/[]), so a missing
 * key or upstream hiccup yields no hotels rather than a 500.
 */

const LITEAPI_BASE = 'https://api.liteapi.travel/v3.0';
const DUFFEL_BASE = 'https://api.duffel.com';
const DUFFEL_VERSION = 'v2';

// How many hotels per city to price in one rates call, and the geo fallback radius.
const MAX_HOTELS_PER_CITY = 30;
const GEO_RADIUS_METERS = 20000;
// How many cheapest hotels to return per city.
const MAX_HOTEL_RESULTS = 5;

// Hotels price per ROOM, not per guest. Split the party into rooms of ~2 adults
// so a group of 4 prices as two doubles (real hotel pricing) instead of 4 adults
// crammed into a single room.
const ADULTS_PER_ROOM = 2;

/** Distribute `travellers` across rooms of up to ADULTS_PER_ROOM adults each. */
function roomOccupancies(travellers: number): { adults: number }[] {
  const guests = Math.max(1, travellers);
  const rooms = Math.ceil(guests / ADULTS_PER_ROOM);
  const base = Math.floor(guests / rooms);
  const extra = guests % rooms;
  return Array.from({ length: rooms }, (_, i) => ({ adults: base + (i < extra ? 1 : 0) }));
}

type TripStyle = TripData['tripStyle'];

// Minimum star rating preferred per trip style. Hotels at/above the threshold
// come first (cheapest-first within the tier); the rest fill any remaining slots.
const STAR_THRESHOLD_BY_STYLE: Record<TripStyle, number> = {
  budget: 0,
  'mid-range': 3,
  luxury: 4,
};

// The app is GBP-first; ask LiteAPI to quote in GBP so prices match the UI.
const DEFAULT_CURRENCY = 'GBP';
const DEFAULT_NATIONALITY = 'GB';

export interface CityHotel {
  city: string;
  name: string;
  /** Star rating 1–5 (LiteAPI `stars`), or null. */
  rating: number | null;
  /** Guest review score, e.g. 8.6 (LiteAPI `rating`, 0–10), or null. */
  reviewScore: number | null;
  currency: string | null;
  /** Number of guests this price covers. */
  travellers: number;
  /** Rooms booked to fit the guests (~2 adults/room). */
  rooms: number;
  /** Cheapest offer total for the whole stay, covering all rooms for all guests. */
  totalAmount: number | null;
  nights: number;
  /** Total per night across all rooms (totalAmount / nights). */
  pricePerNight: number | null;
  address: string | null;
  checkInDate: string;
  checkOutDate: string;
}

function liteHeaders(): Record<string, string> {
  return {
    'X-API-Key': process.env.LITEAPI_KEY ?? '',
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

function duffelHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.DUFFEL_ACCESS_TOKEN ?? ''}`,
    'Duffel-Version': DUFFEL_VERSION,
    Accept: 'application/json',
  };
}

/** Add whole days to a 'YYYY-MM-DD' date, returning the same format (UTC-safe). */
function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function nightsBetween(checkIn: string, checkOut: string): number {
  const a = new Date(`${checkIn}T00:00:00Z`).getTime();
  const b = new Date(`${checkOut}T00:00:00Z`).getTime();
  return Math.max(1, Math.round((b - a) / (1000 * 60 * 60 * 24)));
}

// ─── Minimal shapes of the responses we touch ───────────────────────
interface DuffelPlace {
  type: string; // 'airport' | 'city'
  iata_country_code?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}
interface ResolvedPlace {
  countryCode: string | null;
  latitude: number | null;
  longitude: number | null;
}
interface LiteHotel {
  id?: string;
  name?: string;
  /** Guest review score 0–10. */
  rating?: number | null;
  /** Star rating 1–5. */
  stars?: number | null;
  address?: string | null;
}
interface LiteRateRoomType {
  // Option-level cheapest price for this room type — an OBJECT, not an array.
  offerRetailRate?: { amount?: number; currency?: string };
}
interface LiteRatesHotel {
  hotelId?: string;
  roomTypes?: LiteRateRoomType[];
}

// Resolve city → place once per request (cities can repeat across a trip).
const placeCache = new Map<string, ResolvedPlace | null>();

/** Resolve a city to ISO-2 country code + coordinates via Duffel Places (free). */
async function resolvePlace(city: string): Promise<ResolvedPlace | null> {
  if (!process.env.DUFFEL_ACCESS_TOKEN) return null;
  const key = city.trim().toLowerCase();
  if (placeCache.has(key)) return placeCache.get(key) ?? null;

  try {
    const url = `${DUFFEL_BASE}/places/suggestions?query=${encodeURIComponent(city)}`;
    const res = await fetch(url, { headers: duffelHeaders(), signal: AbortSignal.timeout(6000) });
    if (!res.ok) {
      placeCache.set(key, null);
      return null;
    }
    const json = (await res.json()) as { data?: DuffelPlace[] };
    const data = json.data ?? [];
    const pick = data.find((p) => p.type === 'city') ?? data[0];
    const place: ResolvedPlace | null = pick
      ? {
          countryCode: pick.iata_country_code ?? null,
          latitude: pick.latitude ?? null,
          longitude: pick.longitude ?? null,
        }
      : null;
    placeCache.set(key, place);
    return place;
  } catch {
    placeCache.set(key, null);
    return null;
  }
}

/** List hotels for a city: prefer countryCode + cityName, fall back to geo. */
async function listHotels(place: ResolvedPlace, city: string): Promise<LiteHotel[]> {
  const queries: string[] = [];
  if (place.countryCode) {
    queries.push(
      `countryCode=${encodeURIComponent(place.countryCode)}&cityName=${encodeURIComponent(city)}`,
    );
  }
  if (place.latitude != null && place.longitude != null) {
    queries.push(`latitude=${place.latitude}&longitude=${place.longitude}&radius=${GEO_RADIUS_METERS}`);
  }

  for (const q of queries) {
    try {
      const res = await fetch(`${LITEAPI_BASE}/data/hotels?${q}&limit=${MAX_HOTELS_PER_CITY}`, {
        headers: liteHeaders(),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const json = (await res.json()) as { data?: LiteHotel[] };
      const hotels = json.data ?? [];
      if (hotels.length > 0) return hotels;
    } catch {
      // try the next query form
    }
  }
  return [];
}

/** Fetch rates for a batch of hotel ids over the date window. Returns [] on failure. */
async function getRates(
  hotelIds: string[],
  checkin: string,
  checkout: string,
  travellers: number,
): Promise<LiteRatesHotel[]> {
  try {
    const body = {
      hotelIds,
      // One occupancy entry per room — prices the whole party correctly.
      occupancies: roomOccupancies(travellers),
      currency: DEFAULT_CURRENCY,
      guestNationality: DEFAULT_NATIONALITY,
      checkin,
      checkout,
      maxRatesPerHotel: 5,
    };
    const res = await fetch(`${LITEAPI_BASE}/hotels/rates`, {
      method: 'POST',
      headers: liteHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: LiteRatesHotel[] };
    return json.data ?? [];
  } catch {
    return [];
  }
}

/** Up to `limit` cheapest hotels for one city's date window. [] on any failure. */
export async function getHotelsForCity(
  city: string,
  checkInDate: string,
  checkOutDate: string,
  adults: number,
  style: TripStyle = 'mid-range',
  limit = MAX_HOTEL_RESULTS,
): Promise<CityHotel[]> {
  if (!process.env.LITEAPI_KEY || !city.trim()) return [];

  const place = await resolvePlace(city);
  if (!place) return [];

  const hotels = await listHotels(place, city);
  // Map id → metadata (name/rating/address) — the rates response lacks these.
  const byId = new Map<string, LiteHotel>();
  for (const h of hotels) if (h.id) byId.set(h.id, h);
  const hotelIds = [...byId.keys()];
  if (hotelIds.length === 0) return [];

  const rates = await getRates(hotelIds, checkInDate, checkOutDate, adults);

  // Cheapest offer per hotel (min offerRetailRate.amount across its roomTypes),
  // carrying the star rating so we can bias the order by trip style.
  const priced: { hotelId: string; amount: number; currency: string; stars: number }[] = [];
  for (const r of rates) {
    if (!r.hotelId || !r.roomTypes?.length) continue;
    let cheapest: { amount: number; currency: string } | null = null;
    for (const rt of r.roomTypes) {
      const amount = rt.offerRetailRate?.amount;
      if (amount == null) continue;
      if (!cheapest || amount < cheapest.amount) {
        cheapest = { amount, currency: rt.offerRetailRate?.currency ?? DEFAULT_CURRENCY };
      }
    }
    if (cheapest) {
      priced.push({ hotelId: r.hotelId, ...cheapest, stars: byId.get(r.hotelId)?.stars ?? 0 });
    }
  }

  // Style ordering: hotels meeting the star threshold first (cheapest-first),
  // then the rest fill remaining slots. So luxury surfaces 4–5★, budget the
  // cheapest overall, with a graceful fallback when a city's tier is thin.
  const threshold = STAR_THRESHOLD_BY_STYLE[style];
  const byAmount = (a: { amount: number }, b: { amount: number }) => a.amount - b.amount;
  const tiered = priced.filter((p) => p.stars >= threshold).sort(byAmount);
  const rest = priced.filter((p) => p.stars < threshold).sort(byAmount);
  const ordered = [...tiered, ...rest].slice(0, limit);

  const nights = nightsBetween(checkInDate, checkOutDate);
  const rooms = roomOccupancies(adults).length;
  return ordered.map(({ hotelId, amount, currency }) => {
    const meta = byId.get(hotelId);
    return {
      city,
      name: meta?.name ?? 'Hotel',
      rating: meta?.stars ?? null,
      reviewScore: meta?.rating ?? null,
      currency,
      travellers: adults,
      rooms,
      totalAmount: Math.round(amount),
      nights,
      pricePerNight: Math.round(amount / nights),
      address: meta?.address ?? null,
      checkInDate,
      checkOutDate,
    };
  });
}

/**
 * One hotel per destination city. Each city's check-in/out window is derived from
 * the trip start date plus the cumulative nights spent in prior cities (same
 * itinerary logic as the flight legs). Fetched concurrently.
 * Returns [] when LITEAPI_KEY is unset.
 */
export async function getTopHotels(trip: TripData): Promise<CityHotel[]> {
  if (!process.env.LITEAPI_KEY) return [];

  const adults = Math.max(1, trip.travellers);

  let cumulativeNights = 0;
  const tasks = trip.cities.map((city, i) => {
    // Missing per-city durations default to 2 nights so the window is valid.
    const nights = Math.max(1, trip.cityDurations?.[i] ?? 2);
    const checkInDate = addDays(trip.startDate, cumulativeNights);
    const checkOutDate = addDays(trip.startDate, cumulativeNights + nights);
    cumulativeNights += nights;
    return getHotelsForCity(city.trim(), checkInDate, checkOutDate, adults, trip.tripStyle);
  });

  const results = await Promise.all(tasks);
  return results.flat();
}
