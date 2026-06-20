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
export async function getTopRestaurant(city: string): Promise<Restaurant | null> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey || !city.trim()) return null;

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
        pageSize: 1, // we only want the single top pick
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as PlacesResponse;
    const place = data.places?.[0];
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
      address: place.formattedAddress ?? null,
    };
  } catch {
    return null;
  }
}

/** One restaurant per city, fetched concurrently. Index aligns with `cities`. */
export async function getTopRestaurants(cities: string[]): Promise<(Restaurant | null)[]> {
  return Promise.all(cities.map((c) => getTopRestaurant(c)));
}
