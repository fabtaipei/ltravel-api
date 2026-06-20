import type { TravelLeg, TravelOption, TripData } from './schema';

/**
 * Duffel flight search.
 *
 * We resolve each city name to an IATA code (Duffel Places), then run a one-way
 * offer search per inter-city hop, mapping the cheapest few offers into the
 * `TravelLeg`/`TravelOption` shape the app already renders. Every network path
 * fails soft (returns []), so a Duffel outage just falls back to the model legs
 * in estimate.ts — never a 500 (the MD's robustness rule).
 *
 * Auth: server-side only. Set DUFFEL_ACCESS_TOKEN (a `duffel_test_…` token while
 * developing). Test tokens hit the same base URL; the prefix decides test vs live.
 */

const DUFFEL_BASE = 'https://api.duffel.com';
const DUFFEL_VERSION = 'v2';

type TripStyle = TripData['tripStyle'];

// Trip style → cabin. Luxury flies up front; everyone else economy for the estimate.
const CABIN_BY_STYLE: Record<TripStyle, 'economy' | 'premium_economy' | 'business' | 'first'> = {
  budget: 'economy',
  'mid-range': 'economy',
  luxury: 'business',
};

// Cap offers surfaced per leg — the UI shows 2 then "show more", so a handful is plenty.
const MAX_OPTIONS_PER_LEG = 5;

// ─── Minimal shapes of the Duffel responses we touch ─────────────────
interface PlaceSuggestion {
  iata_code: string | null;
  type: string; // 'airport' | 'city'
  name: string;
}
interface OfferSegment {
  marketing_carrier?: { name?: string };
}
interface OfferSlice {
  duration?: string; // ISO-8601, e.g. "PT11H30M"
  segments?: OfferSegment[];
}
interface DuffelOffer {
  id?: string;
  total_amount: string;
  total_currency: string;
  owner?: { name?: string };
  slices?: OfferSlice[];
}

function authHeaders(): Record<string, string> {
  const token = process.env.DUFFEL_ACCESS_TOKEN ?? '';
  return {
    Authorization: `Bearer ${token}`,
    'Duffel-Version': DUFFEL_VERSION,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

/** "PT11H30M" → 690 (minutes). Returns 0 for missing/unparseable input. */
function parseIsoDuration(iso: string | undefined): number {
  if (!iso) return 0;
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?/.exec(iso);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
}

/** Minutes → "11h 30m" / "45m" / "11h". */
function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h === 0) return `${rem}m`;
  if (rem === 0) return `${h}h`;
  return `${h}h ${rem}m`;
}

/** Add whole days to a 'YYYY-MM-DD' date, returning the same format (UTC-safe). */
function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Resolve city/airport names to IATA codes once per request (cities repeat across legs).
const placeCache = new Map<string, string | null>();

/** Resolve a free-text place ("London", "Tokyo") to an IATA code, preferring a
 *  city code (e.g. LON) over a single airport. Returns null if nothing matches. */
async function resolveIata(query: string): Promise<string | null> {
  const key = query.trim().toLowerCase();
  if (placeCache.has(key)) return placeCache.get(key) ?? null;

  try {
    const url = `${DUFFEL_BASE}/places/suggestions?query=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: authHeaders(), signal: AbortSignal.timeout(6000) });
    if (!res.ok) {
      placeCache.set(key, null);
      return null;
    }
    const json = (await res.json()) as { data?: PlaceSuggestion[] };
    const data = json.data ?? [];
    const city = data.find((p) => p.type === 'city' && p.iata_code);
    const airport = data.find((p) => p.type === 'airport' && p.iata_code);
    const code = (city ?? airport)?.iata_code ?? null;
    placeCache.set(key, code);
    return code;
  } catch {
    placeCache.set(key, null);
    return null;
  }
}

/** Run a one-way offer search for a single hop. Returns [] on any failure. */
async function searchOffers(
  origin: string,
  destination: string,
  departureDate: string,
  travellers: number,
  cabin: string,
): Promise<DuffelOffer[]> {
  try {
    const body = {
      data: {
        slices: [{ origin, destination, departure_date: departureDate }],
        passengers: Array.from({ length: travellers }, () => ({ type: 'adult' })),
        cabin_class: cabin,
      },
    };
    // return_offers=true → offers come back inline on the offer_request resource.
    const url = `${DUFFEL_BASE}/air/offer_requests?return_offers=true&supplier_timeout=10000`;
    const res = await fetch(url, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: { offers?: DuffelOffer[] } };
    return json.data?.offers ?? [];
  } catch {
    return [];
  }
}

function offerToOption(offer: DuffelOffer, legId: string, index: number): TravelOption {
  const slice = offer.slices?.[0];
  const stops = Math.max(0, (slice?.segments?.length ?? 1) - 1);
  const minutes = parseIsoDuration(slice?.duration);
  const stopLabel = stops === 0 ? 'direct' : `${stops} stop${stops === 1 ? '' : 's'}`;
  const carrier = offer.owner?.name ?? slice?.segments?.[0]?.marketing_carrier?.name ?? 'Airline';

  return {
    id: `${legId}-${offer.id ?? index}`,
    mode: 'flight',
    carrier,
    // NOTE: total_amount is in offer.total_currency (often GBP for test tokens).
    // We surface the currency in the detail so it's never silently wrong; converting
    // to the app's USD base is a follow-up (see summary).
    detail: `${stopLabel} · ${formatDuration(minutes)} · ${offer.total_currency} ${Math.round(Number(offer.total_amount))}`,
    price: Math.round(Number(offer.total_amount)),
    durationMinutes: minutes,
  };
}

/**
 * Build real flight legs for the whole trip: departureCity → city1 → city2 → …
 * Departure dates are derived from the trip start date plus the cumulative days
 * spent in each prior city. Returns only the legs Duffel could fully price; the
 * caller decides whether that's complete enough to use (else it falls back to
 * the model legs). Returns [] when DUFFEL_ACCESS_TOKEN is unset.
 */
export async function buildDuffelLegs(trip: TripData): Promise<TravelLeg[]> {
  if (!process.env.DUFFEL_ACCESS_TOKEN) return [];

  const stops = [trip.departureCity.trim(), ...trip.cities.map((c) => c.trim())].filter(Boolean);
  if (stops.length < 2) return [];

  const cabin = CABIN_BY_STYLE[trip.tripStyle] ?? 'economy';
  const travellers = Math.max(1, trip.travellers);

  const legs: TravelLeg[] = [];
  let cumulativeDays = 0;

  for (let i = 0; i < stops.length - 1; i++) {
    const from = stops[i];
    const to = stops[i + 1];

    // Leg 0 (home → first city) leaves on the trip start date; each later hop
    // leaves after the days already spent in the cities visited so far.
    const departureDate = i === 0 ? trip.startDate : addDays(trip.startDate, cumulativeDays);
    // stops[i+1] is cities[i]; add its planned stay before the next departure.
    cumulativeDays += trip.cityDurations?.[i] ?? 0;

    const [origin, destination] = await Promise.all([resolveIata(from), resolveIata(to)]);
    if (!origin || !destination) continue;

    const offers = await searchOffers(origin, destination, departureDate, travellers, cabin);
    if (offers.length === 0) continue;

    const legId = `${slug(from)}-${slug(to)}`;
    const options = offers
      .slice()
      .sort((a, b) => Number(a.total_amount) - Number(b.total_amount))
      .slice(0, MAX_OPTIONS_PER_LEG)
      .map((o, idx) => offerToOption(o, legId, idx));

    // Cheapest is first after the sort — nudge the user toward it.
    if (options[0]) {
      options[0].recommended = true;
      options[0].recommendReason = 'lowest fare we found for this hop';
    }

    legs.push({ id: legId, from, to, options });
  }

  return legs;
}
