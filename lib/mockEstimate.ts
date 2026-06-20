import { getFx } from './fx';
import { buildLegs, checkRouteEfficiency, STYLE_MULTIPLIER } from './legs';
import type { CityEstimate, CostRange, TripData, TripEstimate } from './schema';

/**
 * Deterministic estimate with NO AI / NO AI-Gateway call. Used by
 * /api/estimate?mock=1 to prove the Bilt app <-> Vercel backend connection and
 * the response contract work independently of the LLM hop. Mirrors the cost
 * formula from the Bilt app's original local mock so the numbers look familiar.
 */

function totalTripDays(startDate: string, endDate: string): number {
  if (!startDate || !endDate) return 0;
  const start = new Date(`${startDate}T00:00:00`).getTime();
  const end = new Date(`${endDate}T00:00:00`).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return 1;
  return Math.max(1, Math.round((end - start) / (1000 * 60 * 60 * 24)));
}

function range(base: number): CostRange {
  return { min: Math.round(base / 10) * 10, max: Math.round((base * 1.35) / 10) * 10 };
}

export async function buildMockEstimate(trip: TripData): Promise<TripEstimate> {
  const nights = totalTripDays(trip.startDate, trip.endDate);
  const styleFactor = STYLE_MULTIPLIER[trip.tripStyle];
  const cityCount = Math.max(1, trip.cities.length);
  const travellers = Math.max(1, trip.travellers);

  const cities: CityEstimate[] = trip.cities.map((name, index) => {
    const days = Math.max(1, Math.round(trip.cityDurations?.[index] ?? nights / cityCount));
    const variance = 0.85 + ((name.length + index) % 5) * 0.08;
    const f = styleFactor * variance;

    const flights = range(335 * travellers * f);
    const accommodation = range(75 * days * Math.ceil(travellers / 2) * f);
    const food = range(36 * days * travellers * f);
    const activities = range(48 * days * travellers * f);

    const costRange: CostRange = {
      min: accommodation.min + food.min + activities.min,
      max: accommodation.max + food.max + activities.max,
    };

    return { name, costRange, breakdown: { flights, accommodation, food, activities } };
  });

  const stops = [trip.departureCity.trim(), ...trip.cities].filter(Boolean);
  const legs = buildLegs(stops, styleFactor, travellers);
  const routeWarning = checkRouteEfficiency(stops);

  const legsTotal = legs.reduce(
    (sum, leg) => sum + Math.min(...leg.options.map((o) => o.price)),
    0,
  );
  const totalCost: CostRange = cities.reduce<CostRange>(
    (acc, city) => ({ min: acc.min + city.costRange.min, max: acc.max + city.costRange.max }),
    { min: legsTotal, max: legsTotal },
  );

  // FX is keyless (Frankfurter), not the AI Gateway — fine to include here.
  const fx = await getFx(trip.departureCity, trip.cities[0]);

  return { totalCost, cities, legs, routeWarning, fx };
}
