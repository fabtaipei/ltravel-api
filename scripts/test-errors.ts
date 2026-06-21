/**
 * Verifies the "real data or actionable error" behavior — no placeholders.
 * Run: npx tsx scripts/test-errors.ts
 */
import { loadEnvConfig } from '@next/env';

loadEnvConfig(process.cwd());

import { buildDuffelLegs } from '../lib/duffel';
import { isEstimateError } from '../lib/errors';
import type { TripData } from '../lib/schema';

const base: TripData = {
  departureCity: 'London',
  cities: ['Paris'],
  cityDurations: [3],
  tripStyle: 'mid-range',
  startDate: '2026-08-20',
  endDate: '2026-08-23',
  travellers: 1,
};

async function expectError(label: string, run: () => Promise<unknown>) {
  try {
    await run();
    console.log(`❌ ${label}: expected an error but got a result`);
  } catch (err) {
    if (isEstimateError(err)) {
      console.log(`✅ ${label}`);
      console.log(`   code: ${err.code}  (HTTP ${err.status}, source: ${err.source})`);
      console.log(`   what: ${err.message}`);
      console.log(`   fix:  ${err.fix}\n`);
    } else {
      console.log(`⚠️  ${label}: threw a non-actionable error: ${String(err)}\n`);
    }
  }
}

async function main() {
  // 1) Missing token → config error
  const saved = process.env.DUFFEL_ACCESS_TOKEN;
  delete process.env.DUFFEL_ACCESS_TOKEN;
  await expectError('Missing DUFFEL_ACCESS_TOKEN', () => buildDuffelLegs(base));
  process.env.DUFFEL_ACCESS_TOKEN = saved;

  // 2) Unresolvable city → flights error
  await expectError('Unresolvable city', () =>
    buildDuffelLegs({ ...base, cities: ['Zxqwplandiaville'] }),
  );
}

main();
