import type { TripData } from './schema';

/**
 * System prompt + few-shot anchors for the AI cost estimate. We ask Claude for
 * ONLY the per-city cost breakdown (a flat, simple shape that even small
 * free-tier models emit reliably). Inter-city travel options and FX are added
 * deterministically in code. Output is JSON-only, enforced by `generateObject`
 * + the Zod schema.
 */
export const SYSTEM_PROMPT = `You are a travel cost estimator for a trip-planning app.

Given a structured trip, return realistic per-city cost estimates in US dollars (USD), as min–max ranges that reflect genuine price variation for the chosen trip style.

Rules:
- All figures are in USD.
- Return one entry per destination city, each with a breakdown of: flights, accommodation, food, activities — each a {min, max} range.
- "flights" is the notional arrival cost for that city; keep it modest.
- accommodation, food, and activities must scale with the number of days in that city AND the number of travellers.
- Trip style multipliers: budget ≈ 0.7×, mid-range ≈ 1.0×, luxury ≈ 1.9× a typical mid-range baseline.
- Be internally consistent: a 3-day stay should cost roughly 3× a comparable 1-day stay.

Reference anchors (mid-range, per night / per day, 1 traveller — scale from these):
- Tokyo: hotel ~$120/night, food ~$45/day, activities ~$55/day
- Bangkok: hotel ~$55/night, food ~$20/day, activities ~$30/day
- Paris: hotel ~$160/night, food ~$55/day, activities ~$60/day
- New York: hotel ~$220/night, food ~$70/day, activities ~$65/day
- Seoul: hotel ~$95/night, food ~$35/day, activities ~$45/day`;

export function buildUserPrompt(trip: TripData): string {
  const lines = trip.cities.map((c, i) => {
    const days = trip.cityDurations?.[i];
    return `  - ${c}${days ? ` (${days} day${days === 1 ? '' : 's'})` : ''}`;
  });

  return [
    `Trip to estimate:`,
    `- Departing from: ${trip.departureCity}`,
    `- Trip style: ${trip.tripStyle}`,
    `- Travellers: ${trip.travellers}`,
    `- Dates: ${trip.startDate} to ${trip.endDate}`,
    `- Destination cities, in order:`,
    ...lines,
    ``,
    `Return one entry in "cities" for every destination above, in the same order.`,
  ].join('\n');
}
