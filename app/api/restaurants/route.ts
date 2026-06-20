import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { getRestaurants } from '@/lib/places';

// Places calls are quick, but give a little headroom for several cities at once.
export const maxDuration = 15;

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

const BodySchema = z.object({
  cities: z.array(z.string().min(1)).min(1, 'at least one city is required'),
});

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad_request', message: 'Request body must be valid JSON.' }, 400);
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: 'invalid_request', message: 'Provide a non-empty "cities" array.' }, 400);
  }

  try {
    const restaurants = await getRestaurants(parsed.data.cities);
    return json({ restaurants });
  } catch (err) {
    console.error('[restaurants] failed', err);
    return json(
      { error: 'restaurants_failed', message: 'Could not fetch restaurants right now.' },
      502,
    );
  }
}
