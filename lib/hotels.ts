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
  /** Cheapest offer total for the whole stay. */
  totalAmount: number | null;
  nights: number;
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
  adults: number,
): Promise<LiteRatesHotel[]> {
  try {
    const body = {
      hotelIds,
      occupancies: [{ adults }],
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

/** Cheapest priced hotel for one city's date window. Returns null on any failure. */
export async function getTopHotel(
  city: string,
  checkInDate: string,
  checkOutDate: string,
  adults: number,
): Promise<CityHotel | null> {
  if (!process.env.LITEAPI_KEY || !city.trim()) return null;

  const place = await resolvePlace(city);
  if (!place) return null;

  const hotels = await listHotels(place, city);
  // Map id → metadata (name/rating/address) — the rates response lacks these.
  const byId = new Map<string, LiteHotel>();
  for (const h of hotels) if (h.id) byId.set(h.id, h);
  const hotelIds = [...byId.keys()];
  if (hotelIds.length === 0) return null;

  const rates = await getRates(hotelIds, checkInDate, checkOutDate, adults);

  // Cheapest offer across all hotels: min offerRetailRate.amount over roomTypes.
  let best: { hotelId: string; amount: number; currency: string } | null = null;
  for (const r of rates) {
    if (!r.hotelId || !r.roomTypes?.length) continue;
    for (const rt of r.roomTypes) {
      const amount = rt.offerRetailRate?.amount;
      if (amount == null) continue;
      if (!best || amount < best.amount) {
        best = {
          hotelId: r.hotelId,
          amount,
          currency: rt.offerRetailRate?.currency ?? DEFAULT_CURRENCY,
        };
      }
    }
  }
  if (!best) return null;

  const meta = byId.get(best.hotelId);
  const nights = nightsBetween(checkInDate, checkOutDate);
  const total = Math.round(best.amount);

  return {
    city,
    name: meta?.name ?? 'Hotel',
    rating: meta?.stars ?? null,
    reviewScore: meta?.rating ?? null,
    currency: best.currency,
    totalAmount: total,
    nights,
    pricePerNight: Math.round(best.amount / nights),
    address: meta?.address ?? null,
    checkInDate,
    checkOutDate,
  };
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
    return getTopHotel(city.trim(), checkInDate, checkOutDate, adults);
  });

  const results = await Promise.all(tasks);
  return results.filter((h): h is CityHotel => h !== null);
}
