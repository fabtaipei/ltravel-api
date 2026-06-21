/**
 * Verifies the real-geography route-order suggestion.
 * Run: npx tsx scripts/test-route.ts
 */
import { loadEnvConfig } from '@next/env';

loadEnvConfig(process.cwd());

import { getRouteSuggestion } from '../lib/routeOrder';
import type { TripData } from '../lib/schema';

const base = {
  cityDurations: [],
  tripStyle: 'mid-range' as const,
  startDate: '2026-08-20',
  endDate: '2026-08-30',
  travellers: 1,
};

const cases: { label: string; trip: TripData }[] = [
  {
    label: 'Backtracking: London → Tokyo → Bangkok → Seoul (Bangkok detours below Seoul)',
    trip: { ...base, departureCity: 'London', cities: ['Tokyo', 'Bangkok', 'Seoul'] },
  },
  {
    label: 'Already efficient: London → Paris → Rome → Athens (west→east)',
    trip: { ...base, departureCity: 'London', cities: ['Paris', 'Rome', 'Athens'] },
  },
];

async function main() {
  if (!process.env.DUFFEL_ACCESS_TOKEN) {
    console.log('DUFFEL_ACCESS_TOKEN not set — aborting.');
    process.exit(1);
  }
  for (const { label, trip } of cases) {
    console.log(`\n=== ${label} ===`);
    console.log(`  order in:  ${[trip.departureCity, ...trip.cities].join(' → ')}`);
    const r = await getRouteSuggestion(trip);
    if (r.suggestedOrder) {
      console.log(`  ⚠️  warning:  ${r.routeWarning}`);
      console.log(`  ✅ suggested: ${[trip.departureCity, ...r.suggestedOrder].join(' → ')}`);
      console.log(`  reason:     ${r.suggestedOrderReason}`);
      // Same set, just reordered?
      const sameSet =
        [...r.suggestedOrder].sort().join('|') === [...trip.cities].sort().join('|');
      console.log(`  same cities (no add/remove): ${sameSet ? 'yes ✓' : 'NO ✗'}`);
    } else {
      console.log('  no suggestion (order already efficient) ✓');
    }
  }
}

main().catch((err) => {
  console.error('threw:', err);
  process.exit(2);
});
