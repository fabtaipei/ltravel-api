import { generateObject } from 'ai';

import { getFx } from './fx';
import { buildUserPrompt, SYSTEM_PROMPT } from './prompt';
import {
  ModelEstimateSchema,
  type CityEstimate,
  type CostRange,
  type ModelEstimate,
  type TravelLeg,
  type TravelOption,
  type TripData,
  type TripEstimate,
} from './schema';

/**
 * Model routed through the Vercel AI Gateway. In production on Vercel this is
 * authed via OIDC automatically (no key); locally it uses AI_GATEWAY_API_KEY.
 * The `creator/model` string is the gateway's routing format.
 *
 * Default is Haiku because the AI Gateway FREE tier ($5/mo, no top-up) does not
 * grant access to Opus-tier models. Override with the ESTIMATE_MODEL env var
 * (e.g. 'anthropic/claude-sonnet-4-6' or 'anthropic/claude-opus-4-8') once you
 * have paid credits, without changing code.
 */
const MODEL = process.env.ESTIMATE_MODEL ?? 'anthropic/claude-haiku-4-5';

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

/** Per-city total excludes inter-city flights (those live in `legs`), matching
 * the frontend's convention in locus/lib/tripEstimate.ts. */
function cityCostRange(b: CityEstimate['breakdown']): CostRange {
  return {
    min: b.accommodation.min + b.food.min + b.activities.min,
    max: b.accommodation.max + b.food.max + b.activities.max,
  };
}

/** Map the model's raw estimate into the exact `TripEstimate` shape the app
 * consumes, assigning stable ids and computing derived totals. */
function toTripEstimate(model: ModelEstimate, fx: TripEstimate['fx']): TripEstimate {
  const cities: CityEstimate[] = model.cities.map((c) => ({
    name: c.name,
    breakdown: c.breakdown,
    costRange: cityCostRange(c.breakdown),
  }));

  const legs: TravelLeg[] = model.legs.map((leg) => {
    const legId = `${slug(leg.from)}-${slug(leg.to)}`;
    const options: TravelOption[] = leg.options.map((o, i) => ({
      id: `${legId}-${o.mode}-${i}`,
      mode: o.mode,
      carrier: o.carrier,
      detail: o.detail,
      price: o.price,
      durationMinutes: o.durationMinutes,
      ...(o.recommended ? { recommended: true } : {}),
      ...(o.recommendReason ? { recommendReason: o.recommendReason } : {}),
    }));
    // Keep the recommended option first so it stays visible before "show more".
    options.sort((a, b) => Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)));
    return { id: legId, from: leg.from, to: leg.to, options };
  });

  // Cheapest available option per leg feeds the baseline trip total.
  const legsTotal = legs.reduce(
    (sum, leg) => sum + Math.min(...leg.options.map((o) => o.price)),
    0,
  );

  const totalCost: CostRange = cities.reduce<CostRange>(
    (acc, city) => ({ min: acc.min + city.costRange.min, max: acc.max + city.costRange.max }),
    { min: legsTotal, max: legsTotal },
  );

  return { totalCost, cities, legs, routeWarning: model.routeWarning, fx };
}

/**
 * The estimate logic: parse/think (Claude) + pull live data (Frankfurter FX),
 * then assemble the response. This is the single seam the Bilt app's
 * `getTripEstimate()` swaps to once it points at the deployed URL.
 */
export async function buildEstimate(trip: TripData): Promise<TripEstimate> {
  // Run the LLM estimate and live FX concurrently — they're independent.
  const [{ object: model }, fx] = await Promise.all([
    generateObject({
      model: MODEL,
      schema: ModelEstimateSchema,
      system: SYSTEM_PROMPT,
      prompt: buildUserPrompt(trip),
    }),
    getFx(trip.departureCity, trip.cities[0]),
  ]);

  return toTripEstimate(model, fx);
}
