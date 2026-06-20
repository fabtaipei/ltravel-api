import { NextRequest, NextResponse } from 'next/server';

import { getTopHotels } from '@/lib/hotels';
import { TripDataSchema } from '@/lib/schema';

// Stays search + geocoding per city — give it room, like /api/estimate.
export const maxDuration = 30;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: CORS_HEADERS });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad_request', message: 'Request body must be valid JSON.' }, 400);
  }

  // Same TripData the app sends to /api/estimate — we reuse it to derive each
  // city's check-in/out window and guest count.
  const parsed = TripDataSchema.safeParse(body);
  if (!parsed.success) {
    return json(
      {
        error: 'invalid_trip',
        message: 'Could not understand the trip. Check the required fields.',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      400,
    );
  }

  try {
    const hotels = await getTopHotels(parsed.data);
    return json({ hotels });
  } catch (err) {
    console.error('[hotels] failed', err);
    return json(
      { error: 'hotels_failed', message: 'Could not fetch hotels right now.' },
      502,
    );
  }
}
