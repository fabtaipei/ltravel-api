import { generateObject } from 'ai';

import { getFx } from './fx';
import { buildLegs, checkRouteEfficiency, STYLE_MULTIPLIER } from './legs';
import { buildUserPrompt, SYSTEM_PROMPT } from './prompt';
import {
  ModelEstimateSchema,
  type CityEstimate,
  type CostRange,
  type ModelEstimate,
  type TripData,
  type TripEstimate,
} from './schema';

/**
 * Model routed through the Vercel AI Gateway. In production on Vercel this is
 * authed via OIDC automatically (no key); locally it uses AI_GATEWAY_API_KEY.
 * The `creator/model` string is the gateway's routing format.
 *
 * Default is Haiku because it's the only model the AI Gateway FREE tier
 * ($5/mo, no top-up) actually serves: Opus has no free access and Sonnet is
 * gated. The AI only produces the per-city cost numbers (a flat shape Haiku
 * handles reliably); legs + FX are computed in code. Override with the
 * ESTIMATE_MODEL env var (e.g. 'anthropic/claude-sonnet-4-6') once you have
 * paid credits, without changing code.
 */
const MODEL = process.env.ESTIMATE_MODEL ?? 'anthropic/claude-haiku-4-5';

/** Per-city total excludes inter-city flights (those live in `legs`), matching
 * the frontend's convention in the Bilt app's tripEstimate.ts. */
function cityCostRange(b: CityEstimate['breakdown']): CostRange {
  return {
    min: b.accommodation.min + b.food.min + b.activities.min,
    max: b.accommodation.max + b.food.max + b.activities.max,
  };
}

/** Ask the model for the per-city breakdown, retrying a few times — small
 * models occasionally emit output that fails schema validation. */
async function generateModelEstimate(trip: TripData): Promise<ModelEstimate> {
  const attempts = 3;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const { object } = await generateObject({
        model: MODEL,
        schema: ModelEstimateSchema,
        system: SYSTEM_PROMPT,
        prompt: buildUserPrompt(trip),
      });
      return object;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * Build a trip estimate: AI for the per-city cost numbers, deterministic code
 * for inter-city travel options, plus live FX. Returns the exact `TripEstimate`
 * shape the Bilt app consumes. This is the seam the app's `getTripEstimate()`
 * points at.
 */
export async function buildEstimate(trip: TripData): Promise<TripEstimate> {
  const travellers = Math.max(1, trip.travellers);

  // AI estimate and live FX run concurrently — they're independent.
  const [model, fx] = await Promise.all([
    generateModelEstimate(trip),
    getFx(trip.departureCity, trip.cities[0]),
  ]);

  const cities: CityEstimate[] = model.cities.map((c) => ({
    name: c.name,
    breakdown: c.breakdown,
    costRange: cityCostRange(c.breakdown),
  }));

  // Inter-city legs + route check are deterministic (heuristic placeholders;
  // real flight/rail pricing is a roadmap item).
  const stops = [trip.departureCity.trim(), ...trip.cities].filter(Boolean);
  const styleFactor = STYLE_MULTIPLIER[trip.tripStyle];
  const legs = buildLegs(stops, styleFactor, travellers);
  const routeWarning = checkRouteEfficiency(stops);

  // Cheapest available option per leg feeds the baseline trip total.
  const legsTotal = legs.reduce(
    (sum, leg) => sum + Math.min(...leg.options.map((o) => o.price)),
    0,
  );
  const totalCost: CostRange = cities.reduce<CostRange>(
    (acc, city) => ({ min: acc.min + city.costRange.min, max: acc.max + city.costRange.max }),
    { min: legsTotal, max: legsTotal },
  );

  return { totalCost, cities, legs, routeWarning, fx };
}
