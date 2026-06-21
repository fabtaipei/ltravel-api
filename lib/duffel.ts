import { EstimateError } from './errors';
import type { TravelLeg, TravelOption, TripData } from './schema';

/**
 * Duffel flight search.
 *
 * We resolve each city name to an IATA code (Duffel Places), then run a one-way
 * offer search per inter-city hop, mapping the cheapest few offers into the
 * `TravelLeg`/`TravelOption` shape the app renders.
 *
 * REAL DATA ONLY: there is no heuristic/placeholder fallback. If a token is
 * missing, a city can't be resolved, no flights exist, or Duffel errors, this
 * throws an EstimateError saying what's wrong and how to fix it — the caller
 * surfaces that to the user rather than inventing fake flights.
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
  return {
    Authorization: `Bearer ${process.env.DUFFEL_ACCESS_TOKEN ?? ''}`,
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

/** Read a short slice of the error body for debugging, without throwing. */
async function safeText(res: Response): Promise<string | undefined> {
  try {
    const t = await res.text();
    return t ? t.slice(0, 500) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fetch from Duffel and parse JSON, mapping every non-OK status / network error
 * to an actionable EstimateError. Never returns a fabricated result.
 */
async function duffelFetch(url: string, init: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new EstimateError({
      code: 'flight_network_error',
      source: 'flights',
      status: 502,
      message: 'Could not reach Duffel for flight search.',
      fix: 'Check network/egress connectivity and retry. If it persists, see status.duffel.com.',
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  if (res.ok) return res.json();

  const detail = await safeText(res);
  if (res.status === 401 || res.status === 403) {
    throw new EstimateError({
      code: 'duffel_token_invalid',
      source: 'flights',
      status: 502,
      message: `Duffel rejected the access token (HTTP ${res.status}).`,
      fix: 'DUFFEL_ACCESS_TOKEN is missing, invalid, or for the wrong environment. Regenerate it in the Duffel dashboard (Developers → Access tokens), update ltravel-api/.env.local (test tokens start with duffel_test_), and restart the server.',
      detail,
    });
  }
  if (res.status === 429) {
    throw new EstimateError({
      code: 'duffel_rate_limited',
      source: 'flights',
      status: 429,
      message: 'Duffel rate limit reached (HTTP 429).',
      fix: 'Wait a few seconds and retry. If it keeps happening, reduce search frequency or ask Duffel to raise your rate limit.',
      detail,
    });
  }
  throw new EstimateError({
    code: 'flight_search_failed',
    source: 'flights',
    status: 502,
    message: `Duffel flight search failed (HTTP ${res.status}).`,
    fix: 'This is usually a temporary Duffel issue — retry shortly. If it persists, check status.duffel.com and the detail below.',
    detail,
  });
}

// Resolve city/airport names to IATA codes once per request (cities repeat across legs).
const placeCache = new Map<string, string | null>();

/** Resolve a free-text place ("London", "Tokyo") to an IATA code, preferring a
 *  city code (e.g. LON) over a single airport. Returns null only when Duffel
 *  responded OK but had no matching place (auth/upstream errors throw). */
async function resolveIata(query: string): Promise<string | null> {
  const key = query.trim().toLowerCase();
  if (placeCache.has(key)) return placeCache.get(key) ?? null;

  const url = `${DUFFEL_BASE}/places/suggestions?query=${encodeURIComponent(query)}`;
  const json = (await duffelFetch(url, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(6000),
  })) as { data?: PlaceSuggestion[] };

  const data = json.data ?? [];
  const city = data.find((p) => p.type === 'city' && p.iata_code);
  const airport = data.find((p) => p.type === 'airport' && p.iata_code);
  const code = (city ?? airport)?.iata_code ?? null;
  placeCache.set(key, code);
  return code;
}

/** Run a one-way offer search for a single hop. Returns the offers Duffel found
 *  (possibly empty); upstream/auth errors throw. */
async function searchOffers(
  origin: string,
  destination: string,
  departureDate: string,
  travellers: number,
  cabin: string,
): Promise<DuffelOffer[]> {
  const body = {
    data: {
      slices: [{ origin, destination, departure_date: departureDate }],
      passengers: Array.from({ length: travellers }, () => ({ type: 'adult' })),
      cabin_class: cabin,
    },
  };
  // return_offers=true → offers come back inline on the offer_request resource.
  const url = `${DUFFEL_BASE}/air/offer_requests?return_offers=true&supplier_timeout=10000`;
  const json = (await duffelFetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  })) as { data?: { offers?: DuffelOffer[] } };
  return json.data?.offers ?? [];
}

/**
 * Map a Duffel offer to a TravelOption, or null if the offer is missing any
 * field we'd otherwise have to fabricate (price, carrier, segments, duration).
 * REAL DATA ONLY: we never invent a carrier name, assume "direct", or default a
 * duration/price — a malformed offer is dropped, and the caller errors if every
 * offer on a leg is dropped.
 */
function offerToOption(offer: DuffelOffer, legId: string, index: number): TravelOption | null {
  const slice = offer.slices?.[0];
  const segments = slice?.segments;
  const carrier = offer.owner?.name ?? slice?.segments?.[0]?.marketing_carrier?.name ?? null;
  const minutes = parseIsoDuration(slice?.duration);
  const price = Math.round(Number(offer.total_amount));

  if (!Number.isFinite(price) || price <= 0) return null; // NaN/0 price → not real
  if (!carrier) return null; // no real carrier name → don't fabricate "Airline"
  if (!segments || segments.length === 0) return null; // unknown stops → don't assume "direct"
  if (minutes <= 0) return null; // unparseable/missing duration → don't show 0

  const stops = segments.length - 1;
  const stopLabel = stops === 0 ? 'direct' : `${stops} stop${stops === 1 ? '' : 's'}`;

  return {
    id: `${legId}-${offer.id ?? index}`,
    mode: 'flight',
    carrier,
    // NOTE: total_amount is in offer.total_currency (often GBP for test tokens).
    // We surface the currency in the detail so it's never silently wrong; converting
    // to the app's USD base is a separate follow-up.
    detail: `${stopLabel} · ${formatDuration(minutes)} · ${offer.total_currency} ${price}`,
    price,
    durationMinutes: minutes,
  };
}

/**
 * Build REAL flight legs for the whole trip: departureCity → city1 → city2 → …
 * Departure dates derive from the trip start date plus the cumulative days spent
 * in prior cities. Throws an actionable EstimateError on any condition that would
 * otherwise need a fake fallback (no token, unresolved city, no flights, upstream
 * error). Returns every hop's legs only on full success.
 */
export async function buildDuffelLegs(trip: TripData): Promise<TravelLeg[]> {
  if (!process.env.DUFFEL_ACCESS_TOKEN) {
    throw new EstimateError({
      code: 'duffel_token_missing',
      source: 'config',
      status: 500,
      message: 'Flight search is not configured: DUFFEL_ACCESS_TOKEN is not set.',
      fix: 'Add DUFFEL_ACCESS_TOKEN to ltravel-api/.env.local (use a duffel_test_… token for development) and restart `npm run dev`. In production, add it in Vercel → Project → Settings → Environment Variables.',
    });
  }

  const stops = [trip.departureCity.trim(), ...trip.cities.map((c) => c.trim())].filter(Boolean);
  if (stops.length < 2) {
    throw new EstimateError({
      code: 'no_route',
      source: 'input',
      status: 422,
      message: 'Need a departure city and at least one destination to search flights.',
      fix: 'Provide departureCity and at least one entry in cities.',
    });
  }

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
    if (!origin || !destination) {
      const unresolved = !origin ? from : to;
      throw new EstimateError({
        code: 'flight_city_unresolved',
        source: 'flights',
        status: 422,
        message: `Couldn't find an airport or city for "${unresolved}".`,
        fix: 'Check the spelling, or use a recognizable city/airport name (e.g. "London", "New York"). Very small towns may have no airport Duffel can search.',
      });
    }

    const offers = await searchOffers(origin, destination, departureDate, travellers, cabin);
    if (offers.length === 0) {
      throw new EstimateError({
        code: 'no_flights_found',
        source: 'flights',
        status: 422,
        message: `No flights found for ${from} → ${to} on ${departureDate}.`,
        fix: 'Try different dates (use a future date in YYYY-MM-DD format), a nearby major city, or confirm the route is flown. Note: with a duffel_test_ token, only Duffel\'s synthetic "Duffel Airways" routes return offers.',
      });
    }

    const legId = `${slug(from)}-${slug(to)}`;
    // Map → drop offers missing real data → sort cheapest-first → cap.
    const options = offers
      .map((o, idx) => offerToOption(o, legId, idx))
      .filter((o): o is TravelOption => o !== null)
      .sort((a, b) => a.price - b.price)
      .slice(0, MAX_OPTIONS_PER_LEG);

    if (options.length === 0) {
      throw new EstimateError({
        code: 'no_valid_flight_options',
        source: 'flights',
        status: 502,
        message: `Duffel returned offers for ${from} → ${to} but none had complete data (price, carrier, duration).`,
        fix: 'This is a Duffel data issue — retry shortly. If it persists, inspect the raw offer payload and contact Duffel support.',
      });
    }

    // Cheapest is first after the sort — nudge the user toward it.
    options[0].recommended = true;
    options[0].recommendReason = 'lowest fare we found for this hop';

    legs.push({ id: legId, from, to, options });
  }

  return legs;
}
