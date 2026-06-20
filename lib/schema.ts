import { z } from 'zod';

/**
 * These types mirror the contract already defined in the Bilt app
 * (`locus/lib/tripEstimate.ts`). The response shape returned by /api/estimate
 * matches `TripEstimate` exactly, plus an additive `fx` block. The app ignores
 * unknown fields, so adding `fx` is backwards-compatible — Agnese can opt into
 * rendering it whenever the frontend types are extended.
 */

// ─── Input: TripData (what the Bilt app POSTs) ───────────────────────
export const TripStyleSchema = z.enum(['budget', 'mid-range', 'luxury']);

export const TripDataSchema = z.object({
  departureCity: z.string().min(1, 'departureCity is required'),
  cities: z.array(z.string().min(1)).min(1, 'at least one destination is required'),
  /** Days spent in each city, same order as `cities`. */
  cityDurations: z.array(z.number().int().positive()).default([]),
  tripStyle: TripStyleSchema,
  startDate: z.string(),
  endDate: z.string(),
  travellers: z.number().int().positive().default(1),
});
export type TripData = z.infer<typeof TripDataSchema>;

// ─── Cost primitives ─────────────────────────────────────────────────
export const CostRangeSchema = z.object({
  min: z.number(),
  max: z.number(),
});
export type CostRange = z.infer<typeof CostRangeSchema>;

// ─── What Claude is asked to produce (the "raw" estimate) ────────────
// We keep this tight so the model only fills in the genuinely-estimated
// numbers. Derived fields (ids, totals, per-city costRange) are computed
// in code so they always match the frontend's conventions.
export const ModelTravelOptionSchema = z.object({
  mode: z.enum(['flight', 'train']),
  carrier: z.string(),
  detail: z.string(),
  price: z.number(),
  durationMinutes: z.number(),
  recommended: z.boolean().optional(),
  recommendReason: z.string().optional(),
});

export const ModelLegSchema = z.object({
  from: z.string(),
  to: z.string(),
  options: z.array(ModelTravelOptionSchema).min(1),
});

export const ModelCitySchema = z.object({
  name: z.string(),
  breakdown: z.object({
    flights: CostRangeSchema,
    accommodation: CostRangeSchema,
    food: CostRangeSchema,
    activities: CostRangeSchema,
  }),
});

export const ModelEstimateSchema = z.object({
  cities: z.array(ModelCitySchema).min(1),
  legs: z.array(ModelLegSchema),
  routeWarning: z.string().nullable(),
});
export type ModelEstimate = z.infer<typeof ModelEstimateSchema>;

// ─── Output: TripEstimate (matches locus/lib/tripEstimate.ts) ────────
export interface TravelOption {
  id: string;
  mode: 'flight' | 'train';
  carrier: string;
  detail: string;
  price: number;
  durationMinutes: number;
  recommended?: boolean;
  recommendReason?: string;
}

export interface TravelLeg {
  id: string;
  from: string;
  to: string;
  options: TravelOption[];
}

export interface CityEstimate {
  name: string;
  costRange: CostRange;
  breakdown: {
    flights: CostRange;
    accommodation: CostRange;
    food: CostRange;
    activities: CostRange;
  };
}

/** Live FX block — additive to the frontend contract. */
export interface FxInfo {
  /** Currency the cost figures above are quoted in. */
  base: string;
  /** Traveller's home currency, inferred from departureCity. */
  home: string;
  /** Destination currency, inferred from the first destination city. */
  destination: string;
  /** 1 unit of `base` = this many `home`. */
  homePerBase: number;
  /** 1 unit of `base` = this many `destination`. */
  destinationPerBase: number;
  /** Handy headline: 1 unit of `home` = this many `destination`. */
  destinationPerHome: number;
  /** Date the rate was published (ECB business day). */
  asOf: string;
  source: 'frankfurter';
}

export interface TripEstimate {
  totalCost: CostRange;
  cities: CityEstimate[];
  legs: TravelLeg[];
  routeWarning: string | null;
  /** Live home→destination FX, or null if rates were unavailable. */
  fx: FxInfo | null;
}
