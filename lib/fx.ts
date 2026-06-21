import type { FxInfo } from './schema';

/**
 * Live FX via Frankfurter (frankfurter.dev) — keyless, ECB rates, free.
 * This is one of the two genuinely-live data layers in the demo (the other
 * being events, if/when wired). Cost figures from the model are quoted in USD;
 * we convert into the traveller's home and destination currencies.
 */

const FRANKFURTER_BASE = 'https://api.frankfurter.dev/v1/latest';

// Minimal city/country → ISO-4217 map. Falls back to USD when unknown, which
// makes the FX block a no-op (rate 1.0) rather than a hard failure.
const CURRENCY_BY_PLACE: Record<string, string> = {
  // United Kingdom
  london: 'GBP', manchester: 'GBP', edinburgh: 'GBP', uk: 'GBP', england: 'GBP', scotland: 'GBP',
  // Eurozone
  paris: 'EUR', france: 'EUR', berlin: 'EUR', munich: 'EUR', germany: 'EUR',
  rome: 'EUR', milan: 'EUR', italy: 'EUR', madrid: 'EUR', barcelona: 'EUR', spain: 'EUR',
  amsterdam: 'EUR', netherlands: 'EUR', lisbon: 'EUR', portugal: 'EUR',
  athens: 'EUR', greece: 'EUR', dublin: 'EUR', ireland: 'EUR', vienna: 'EUR', austria: 'EUR',
  // Asia
  tokyo: 'JPY', osaka: 'JPY', kyoto: 'JPY', japan: 'JPY',
  seoul: 'KRW', busan: 'KRW', korea: 'KRW', 'south korea': 'KRW',
  bangkok: 'THB', thailand: 'THB', singapore: 'SGD',
  'hong kong': 'HKD', shanghai: 'CNY', beijing: 'CNY', china: 'CNY',
  'new delhi': 'INR', delhi: 'INR', mumbai: 'INR', india: 'INR',
  dubai: 'AED', uae: 'AED', istanbul: 'TRY', turkey: 'TRY',
  // Americas
  'new york': 'USD', 'los angeles': 'USD', 'san francisco': 'USD', usa: 'USD', 'united states': 'USD',
  toronto: 'CAD', vancouver: 'CAD', canada: 'CAD',
  'mexico city': 'MXN', mexico: 'MXN', 'rio de janeiro': 'BRL', brazil: 'BRL',
  // Oceania
  sydney: 'AUD', melbourne: 'AUD', australia: 'AUD', auckland: 'NZD', 'new zealand': 'NZD',
};

/** Cost figures are produced by the model in USD. */
const BASE_CURRENCY = 'USD';

export function currencyForPlace(place: string): string {
  return CURRENCY_BY_PLACE[place.trim().toLowerCase()] ?? BASE_CURRENCY;
}

/**
 * Fetch live USD→{home,destination} rates. Returns null on any failure so the
 * estimate still succeeds without FX (robustness over completeness — the MD's
 * "never a 500" rule).
 */
export async function getFx(departureCity: string, firstDestination: string): Promise<FxInfo | null> {
  const home = currencyForPlace(departureCity);
  const destination = currencyForPlace(firstDestination);

  const symbols = Array.from(new Set([home, destination].filter((c) => c !== BASE_CURRENCY)));

  // Home and destination are both USD (the base): there's no conversion to show
  // and no real rate to fetch. Return null rather than fabricate an `asOf` date
  // or claim a 'frankfurter' source for numbers we didn't get from Frankfurter.
  if (symbols.length === 0) return null;

  try {
    const url = `${FRANKFURTER_BASE}?base=${BASE_CURRENCY}&symbols=${symbols.join(',')}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) {
      console.error('[estimate/fx] Frankfurter responded', res.status);
      return null;
    }

    const data = (await res.json()) as { date: string; rates: Record<string, number> };
    const rates = data.rates ?? {};

    const homePerBase = home === BASE_CURRENCY ? 1 : rates[home];
    const destinationPerBase = destination === BASE_CURRENCY ? 1 : rates[destination];
    if (homePerBase == null || destinationPerBase == null) {
      console.error('[estimate/fx] missing rate(s) from Frankfurter', { home, destination });
      return null;
    }

    return {
      base: BASE_CURRENCY,
      home,
      destination,
      homePerBase,
      destinationPerBase,
      destinationPerHome: destinationPerBase / homePerBase,
      asOf: data.date,
      source: 'frankfurter',
    };
  } catch (err) {
    console.error('[estimate/fx] Frankfurter fetch failed', err);
    return null;
  }
}
