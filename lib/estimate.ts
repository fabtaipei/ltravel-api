import { generateObject } from 'ai';

import { buildDuffelLegs } from './duffel';
import { EstimateError } from './errors';
import { getFx } from './fx';
import { buildUserPrompt, SYSTEM_PROMPT } from './prompt';
import { getRouteSuggestion } from './routeOrder';
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
 *
 * Default is Haiku because it's the model the AI Gateway FREE tier ($5/mo)
 * reliably serves. Override with ESTIMATE_MODEL once you have paid credits.
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

/**
 * Ask the model for the per-city breakdown, retrying a few times — small models
 * occasionally emit output that fails schema validation. On exhausting retries
 * this throws an actionable EstimateError rather than letting a raw SDK error
 * surface (no placeholder estimate is ever substituted).
 */
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
  throw new EstimateError({
    code: 'ai_estimate_failed',
    source: 'ai',
    status: 502,
    message: `The AI cost estimate failed (model: ${MODEL}).`,
    fix: 'Most often the AI Gateway is not authed. For local dev, set AI_GATEWAY_API_KEY in ltravel-api/.env.local (create one at Vercel → AI Gateway → API Keys). In production on Vercel, connect the AI Gateway to the project so the OIDC token is injected. You can also set ESTIMATE_MODEL to a model your plan serves.',
    detail: lastErr instanceof Error ? lastErr.message : String(lastErr),
  });
}

/**
 * Build a trip estimate from REAL data only:
 *   - AI (Vercel AI Gateway) for the per-city cost numbers
 *   - Duffel for live inter-city flights
 *   - Frankfurter for live FX (additive — see below)
 *
 * If the AI estimate or flight search can't produce real results, this throws an
 * EstimateError describing what's wrong and how to fix it — there is no heuristic
 * or mock fallback. FX is the one additive exception: if ECB rates are momentarily
 * unavailable we return `fx: null` (the conversion is simply not shown) rather
 * than failing the whole estimate or inventing a rate.
 */
export async function buildEstimate(trip: TripData): Promise<TripEstimate> {
  // Run the real data sources concurrently. allSettled so one rejection doesn't
  // leave the others as unhandled rejections; we then surface the actionable error.
  const [modelRes, legsRes, fxRes, routeRes] = await Promise.allSettled([
    generateModelEstimate(trip),
    buildDuffelLegs(trip),
    getFx(trip.departureCity, trip.cities[0]),
    getRouteSuggestion(trip),
  ]);

  // Core data must be real — surface the first source that failed.
  if (modelRes.status === 'rejected') throw modelRes.reason;
  if (legsRes.status === 'rejected') throw legsRes.reason;

  const model = modelRes.value;
  const legs = legsRes.value;
  const fx = fxRes.status === 'fulfilled' ? fxRes.value : null;
  // Route suggestion is additive (real coords or null) — never fails the estimate.
  const route =
    routeRes.status === 'fulfilled'
      ? routeRes.value
      : { routeWarning: null, suggestedOrder: null, suggestedOrderReason: null };

  const cities: CityEstimate[] = model.cities.map((c) => ({
    name: c.name,
    breakdown: c.breakdown,
    costRange: cityCostRange(c.breakdown),
  }));

  // Cheapest available option per leg feeds the baseline trip total.
  const legsTotal = legs.reduce((sum, leg) => sum + Math.min(...leg.options.map((o) => o.price)), 0);
  const totalCost: CostRange = cities.reduce<CostRange>(
    (acc, city) => ({ min: acc.min + city.costRange.min, max: acc.max + city.costRange.max }),
    { min: legsTotal, max: legsTotal },
  );

  // routeWarning + suggestedOrder come from getRouteSuggestion, which uses REAL
  // coordinates (Duffel Places) and returns null when the order is already fine
  // or coordinates aren't available — never fabricated geography.
  return {
    totalCost,
    cities,
    legs,
    routeWarning: route.routeWarning,
    suggestedOrder: route.suggestedOrder,
    suggestedOrderReason: route.suggestedOrderReason,
    fx,
  };
}
