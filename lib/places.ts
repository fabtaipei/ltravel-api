/**
 * Google Places API (New) — restaurant discovery.
 *
 * Server-side only: reads GOOGLE_PLACES_API_KEY from env so the key never reaches
 * the client. Given a city, returns the single top restaurant with a price
 * indicator. Every failure path returns null so a missing restaurant can never
 * break the rest of a response (same robustness rule as fx.ts).
 */

const PLACES_TEXT_SEARCH = 'https://places.googleapis.com/v1/places:searchText';

// Field mask keeps the response — and the billing SKU — tight: only what we render.
const FIELD_MASK = [
  'places.displayName',
  'places.rating',
  'places.priceLevel',
  'places.formattedAddress',
  'places.priceRange',
].join(',');

// How many restaurants to return per city.
const MAX_RESTAURANTS_PER_CITY = 5;

type TripStyle = 'budget' | 'mid-range' | 'luxury';

// Restaurant price tier (Google priceLevels) biased by the trip style.
const PRICE_LEVELS_BY_STYLE: Record<TripStyle, string[]> = {
  budget: ['PRICE_LEVEL_INEXPENSIVE', 'PRICE_LEVEL_MODERATE'],
  'mid-range': ['PRICE_LEVEL_MODERATE', 'PRICE_LEVEL_EXPENSIVE'],
  luxury: ['PRICE_LEVEL_EXPENSIVE', 'PRICE_LEVEL_VERY_EXPENSIVE'],
};

export type PriceLevel =
  | 'PRICE_LEVEL_FREE'
  | 'PRICE_LEVEL_INEXPENSIVE'
  | 'PRICE_LEVEL_MODERATE'
  | 'PRICE_LEVEL_EXPENSIVE'
  | 'PRICE_LEVEL_VERY_EXPENSIVE';

export interface Restaurant {
  city: string;
  name: string;
  /** Google's average rating (0–5), or null when unrated. */
  rating: number | null;
  /** Price tier as a symbol, e.g. "$$" — null when Google has no price data. */
  priceSymbol: string | null;
  /** Rough per-person USD estimate for display, from Google's range or the tier. */
  priceEstimateUsd: number | null;
  /** Number of diners the group estimate covers. */
  partySize: number;
  /** Rough total for the whole party = priceEstimateUsd × partySize. */
  groupEstimateUsd: number | null;
  address: string | null;
}

// Map Google's price tier to a $ symbol + a rough per-person USD figure to show.
const PRICE_TIER: Record<PriceLevel, { symbol: string; usd: number }> = {
  PRICE_LEVEL_FREE: { symbol: 'Free', usd: 0 },
  PRICE_LEVEL_INEXPENSIVE: { symbol: '$', usd: 15 },
  PRICE_LEVEL_MODERATE: { symbol: '$$', usd: 40 },
  PRICE_LEVEL_EXPENSIVE: { symbol: '$$$', usd: 80 },
  PRICE_LEVEL_VERY_EXPENSIVE: { symbol: '$$$$', usd: 150 },
};

interface PriceRange {
  startPrice?: { currencyCode?: string; units?: string };
  endPrice?: { currencyCode?: string; units?: string };
}

interface PlaceResult {
  displayName?: { text?: string };
  rating?: number;
  priceLevel?: PriceLevel | 'PRICE_LEVEL_UNSPECIFIED';
  formattedAddress?: string;
  priceRange?: PriceRange;
}

interface PlacesResponse {
  places?: PlaceResult[];
}

/** Midpoint of Google's real price range (when both ends are present), else null. */
function priceFromRange(range?: PriceRange): number | null {
  // `units` arrives as a stringified integer; only trust it when both ends parse.
  const start = Number(range?.startPrice?.units);
  const end = Number(range?.endPrice?.units);
  if (Number.isFinite(start) && Number.isFinite(end) && end > 0) {
    return Math.round((start + end) / 2);
  }
  return null;
}

/**
 * Find the single top restaurant in a city via Places Text Search (New).
 * Returns null on any failure (missing key, no result, network/timeout error).
 */
/** Map one Google place to our Restaurant shape. Returns null if it has no name. */
function placeToRestaurant(city: string, place: PlaceResult, partySize: number): Restaurant | null {
  if (!place?.displayName?.text) return null;
  const tier =
    place.priceLevel && place.priceLevel !== 'PRICE_LEVEL_UNSPECIFIED'
      ? PRICE_TIER[place.priceLevel]
      : null;
  // Prefer Google's real price range when present; fall back to the tier estimate.
  const priceEstimateUsd = priceFromRange(place.priceRange) ?? tier?.usd ?? null;
  return {
    city,
    name: place.displayName.text,
    rating: place.rating ?? null,
    priceSymbol: tier?.symbol ?? null,
    priceEstimateUsd,
    partySize,
    // Per-person figure × diners — a meal here for the whole party.
    groupEstimateUsd: priceEstimateUsd != null ? priceEstimateUsd * partySize : null,
    address: place.formattedAddress ?? null,
  };
}

/** Up to `limit` top restaurants in a city (relevance order). [] on any failure. */
export async function getRestaurantsForCity(
  city: string,
  style: TripStyle = 'mid-range',
  limit = MAX_RESTAURANTS_PER_CITY,
  partySize = 1,
): Promise<Restaurant[]> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey || !city.trim()) return [];

  try {
    const res = await fetch(PLACES_TEXT_SEARCH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify({
        textQuery: `best restaurants in ${city.trim()}`,
        includedType: 'restaurant',
        pageSize: limit,
        // Bias toward the trip's price tier so picks differ by style.
        priceLevels: PRICE_LEVELS_BY_STYLE[style],
      }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return [];

    const data = (await res.json()) as PlacesResponse;
    return (data.places ?? [])
      .map((p) => placeToRestaurant(city, p, partySize))
      .filter((r): r is Restaurant => r !== null);
  } catch {
    return [];
  }
}

/** Several restaurants per city, flattened — price tier set by trip style,
 *  group estimate scaled by party size. */
export async function getRestaurants(
  cities: string[],
  style: TripStyle = 'mid-range',
  partySize = 1,
): Promise<Restaurant[]> {
  const perCity = await Promise.all(
    cities.map((c) => getRestaurantsForCity(c, style, MAX_RESTAURANTS_PER_CITY, partySize)),
  );
  return perCity.flat();
}
