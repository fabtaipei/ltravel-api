/**
 * Verifies hotel pricing factors the number of people (rooms).
 * Compares 2 travellers (1 room) vs 4 travellers (2 rooms) for the same
 * city + dates: a correct multi-room total should be ~2x the 1-room total.
 * Run: npx tsx scripts/test-hotels.ts
 */
import { loadEnvConfig } from '@next/env';

loadEnvConfig(process.cwd());

import { getHotelsForCity } from '../lib/hotels';

const CITY = 'Paris';
const CHECK_IN = '2026-08-20';
const CHECK_OUT = '2026-08-23';

async function main() {
  if (!process.env.LITEAPI_KEY) {
    console.log('LITEAPI_KEY not set — aborting.');
    process.exit(1);
  }

  for (const travellers of [2, 4]) {
    const hotels = await getHotelsForCity(CITY, CHECK_IN, CHECK_OUT, travellers, 'mid-range', 3);
    console.log(`\n=== ${travellers} travellers (${hotels[0]?.rooms ?? '?'} room(s)) ===`);
    if (hotels.length === 0) {
      console.log('  no hotels returned');
      continue;
    }
    for (const h of hotels) {
      console.log(
        `  ${h.name.padEnd(34).slice(0, 34)} ${h.currency} ${h.totalAmount} total · ${h.currency} ${h.pricePerNight}/night · ${h.rooms} room(s) for ${h.travellers}`,
      );
    }
  }
  console.log(
    '\nIf the 4-traveller totals are ~2x the 2-traveller totals, the amount covers all rooms (correct).',
  );
  console.log('If they are about equal, LiteAPI returns a per-room amount and we must multiply by rooms.');
}

main().catch((err) => {
  console.error('threw:', err);
  process.exit(2);
});
