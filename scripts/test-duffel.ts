/**
 * Isolated smoke test for the Duffel flight integration.
 * Run: npx tsx scripts/test-duffel.ts
 * Loads DUFFEL_ACCESS_TOKEN from .env.local; never prints the token.
 */
import { loadEnvConfig } from '@next/env';

loadEnvConfig(process.cwd());

import { buildDuffelLegs } from '../lib/duffel';
import type { TripData } from '../lib/schema';

// Single hop keeps it to ~3 Duffel calls (2 place lookups + 1 offer search).
const trip: TripData = {
  departureCity: 'London',
  cities: ['Paris'],
  cityDurations: [3],
  tripStyle: 'mid-range',
  startDate: '2026-08-20',
  endDate: '2026-08-23',
  travellers: 1,
};

async function main() {
  const tokenSet = Boolean(process.env.DUFFEL_ACCESS_TOKEN);
  console.log(`DUFFEL_ACCESS_TOKEN present: ${tokenSet}`);
  if (!tokenSet) {
    console.log('No token loaded — check .env.local. Aborting.');
    process.exit(1);
  }

  console.log(`Searching: ${trip.departureCity} → ${trip.cities.join(' → ')} on ${trip.startDate}\n`);
  const t0 = Date.now();
  const legs = await buildDuffelLegs(trip);
  const ms = Date.now() - t0;

  if (legs.length === 0) {
    console.log(`❌ No legs returned (${ms}ms). Either the token is rejected, the place`);
    console.log('   lookup failed, or no offers were found. See notes printed by the lib.');
    process.exit(2);
  }

  console.log(`✅ Got ${legs.length} leg(s) in ${ms}ms:\n`);
  for (const leg of legs) {
    console.log(`${leg.from} → ${leg.to}  (${leg.options.length} options)`);
    for (const o of leg.options) {
      const rec = o.recommended ? '  ⭐ ' + (o.recommendReason ?? '') : '';
      console.log(`  • ${o.carrier.padEnd(22)} ${o.detail}${rec}`);
    }
    console.log('');
  }
}

main().catch((err) => {
  console.error('Test threw:', err);
  process.exit(3);
});
