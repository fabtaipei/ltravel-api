import type { TravelLeg, TravelOption, TripData } from './schema';

/**
 * Deterministic inter-city travel options + route-efficiency check.
 *
 * Ported from the Bilt app's original local logic (tripEstimate.ts). We compute
 * legs in code rather than asking the LLM, because (a) small free-tier models
 * can't reliably emit the nested legs/options schema, and (b) these options are
 * heuristic placeholders anyway — real flight/rail pricing is a roadmap item
 * (Duffel etc.). The AI focuses on the per-city cost estimate, which is the part
 * that genuinely benefits from a model.
 */

export const STYLE_MULTIPLIER: Record<TripData['tripStyle'], number> = {
  budget: 0.7,
  'mid-range': 1,
  luxury: 1.9,
};

// Stable pseudo-random seed from a string so prices stay consistent per leg.
function seedFromString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) % 100000;
  }
  return hash;
}

function formatMoney(value: number): string {
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

const TRAIN_LINES = ['Regional Express', 'InterCity', 'HighSpeed Rail', 'Coastal Line', 'Star Line'];
const AIRLINES = ['AirAsia', 'Japan Airlines', 'Singapore Airlines', 'Qantas', 'Emirates', 'ANA'];

function trainIsPlausible(from: string, to: string): boolean {
  return seedFromString(`${from}->${to}`) % 100 < 55;
}

function legDistance(from: string, to: string): number {
  return 1 + (seedFromString(`${from}~${to}`) % 100) / 11;
}

export function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h === 0) return `${rem}m`;
  if (rem === 0) return `${h}h`;
  return `${h}h ${rem}m`;
}

function applyRecommendation(options: TravelOption[]): void {
  const flights = options.filter((o) => o.mode === 'flight');
  const trains = options.filter((o) => o.mode === 'train');
  if (flights.length === 0) return;

  const bestFlight = flights.reduce((a, b) => (b.price < a.price ? b : a));

  if (trains.length === 0) {
    bestFlight.recommended = true;
    bestFlight.recommendReason = 'fastest realistic way to cover this distance';
    return;
  }

  const bestTrain = trains.reduce((a, b) => (b.durationMinutes < a.durationMinutes ? b : a));
  const timeGap = bestTrain.durationMinutes - bestFlight.durationMinutes;
  const saving = bestFlight.price - bestTrain.price;

  if (saving > 0 && timeGap <= 45) {
    bestTrain.recommended = true;
    bestTrain.recommendReason =
      timeGap <= 0
        ? `cheaper and faster door-to-door — saves ${formatMoney(saving)}`
        : `similar time, ${formatMoney(saving)} cheaper`;
    return;
  }

  bestFlight.recommended = true;
  bestFlight.recommendReason = 'faster overall once you include airport time';
}

function buildLeg(from: string, to: string, styleFactor: number, travellers: number): TravelLeg {
  const seed = seedFromString(`${from}|${to}`);
  const dist = legDistance(from, to);
  const baseFlight = (180 + (seed % 320)) * styleFactor;
  const flightPrice = Math.round((baseFlight * travellers) / 10) * 10;

  const flightAir = Math.round(35 + dist * 22);
  const airportOverhead = 95;
  const flightTotal = flightAir + airportOverhead;

  const legId = `${from}-${to}`;
  const options: TravelOption[] = [
    {
      id: `${legId}-flight`,
      mode: 'flight',
      carrier: AIRLINES[seed % AIRLINES.length],
      detail: `~${formatDuration(flightAir)} flight + ~${formatDuration(airportOverhead)} airports`,
      price: flightPrice,
      durationMinutes: flightTotal,
    },
  ];

  if (trainIsPlausible(from, to)) {
    const trainPrice = Math.round((flightPrice * 0.55) / 5) * 5;
    const trainTotal = Math.round(45 + dist * 30);
    options.push({
      id: `${legId}-train`,
      mode: 'train',
      carrier: TRAIN_LINES[seed % TRAIN_LINES.length],
      detail: `${formatDuration(trainTotal)} direct`,
      price: trainPrice,
      durationMinutes: trainTotal,
    });
  }

  options.push({
    id: `${legId}-flight-2`,
    mode: 'flight',
    carrier: AIRLINES[(seed + 2) % AIRLINES.length],
    detail: `1 stop · ~${formatDuration(Math.round(flightTotal * 1.6))} total`,
    price: Math.round((flightPrice * 0.82) / 10) * 10,
    durationMinutes: Math.round(flightTotal * 1.6),
  });
  options.push({
    id: `${legId}-flight-3`,
    mode: 'flight',
    carrier: AIRLINES[(seed + 4) % AIRLINES.length],
    detail: `premium cabin · ~${formatDuration(flightTotal)} total`,
    price: Math.round((flightPrice * 1.45) / 10) * 10,
    durationMinutes: flightTotal,
  });
  if (trainIsPlausible(from, to)) {
    const sleeperTotal = Math.round(45 + dist * 30 + 360);
    options.push({
      id: `${legId}-train-2`,
      mode: 'train',
      carrier: TRAIN_LINES[(seed + 1) % TRAIN_LINES.length],
      detail: `sleeper service · ${formatDuration(sleeperTotal)}`,
      price: Math.round((flightPrice * 0.7) / 5) * 5,
      durationMinutes: sleeperTotal,
    });
  }

  applyRecommendation(options);
  options.sort((a, b) => Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)));

  return { id: legId, from, to, options };
}

/** Build every leg for the ordered stop list (departure + destinations). */
export function buildLegs(stops: string[], styleFactor: number, travellers: number): TravelLeg[] {
  const legs: TravelLeg[] = [];
  for (let i = 0; i < stops.length - 1; i++) {
    legs.push(buildLeg(stops[i], stops[i + 1], styleFactor, travellers));
  }
  return legs;
}

export function checkRouteEfficiency(stops: string[]): string | null {
  if (stops.length < 4) return null;
  const pos = stops.map((s) => seedFromString(s) % 100);

  for (let i = 1; i < stops.length - 1; i++) {
    const prev = pos[i - 1];
    const here = pos[i];
    const next = pos[i + 1];
    const directSpan = Math.abs(next - prev);
    const detour = Math.abs(here - prev) + Math.abs(next - here);
    if (detour > directSpan * 2 && detour - directSpan > 45) {
      return `heads up — visiting ${stops[i]} between ${stops[i - 1]} and ${stops[i + 1]} adds a detour. want to try a different order?`;
    }
  }
  return null;
}
