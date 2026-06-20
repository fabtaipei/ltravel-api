import { NextRequest, NextResponse } from 'next/server';

import { buildEstimate } from '@/lib/estimate';
import { TripDataSchema } from '@/lib/schema';

// LLM calls can take a few seconds — give Vercel room (Hobby allows up to 60s).
export const maxDuration = 30;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-estimate-secret',
};

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: CORS_HEADERS });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(req: NextRequest) {
  // Temporary diagnostics: append ?debug=1 to surface the real upstream error.
  const debug = req.nextUrl.searchParams.get('debug') === '1';

  // Optional shared secret (Bilt → Vercel hop). Off unless ESTIMATE_SHARED_SECRET is set.
  const requiredSecret = process.env.ESTIMATE_SHARED_SECRET;
  if (requiredSecret && req.headers.get('x-estimate-secret') !== requiredSecret) {
    return json({ error: 'unauthorized', message: 'Missing or invalid x-estimate-secret header.' }, 401);
  }

  // Parse body defensively — never throw a 500 on bad input.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad_request', message: 'Request body must be valid JSON.' }, 400);
  }

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
    const estimate = await buildEstimate(parsed.data);
    return json(estimate);
  } catch (err) {
    // Graceful failure — friendly JSON, no stack trace leaked to the client.
    console.error('[estimate] failed', err);
    return json(
      {
        error: 'estimate_failed',
        message: 'We could not build an estimate right now. Please try again.',
        ...(debug ? { detail: err instanceof Error ? err.message : String(err) } : {}),
      },
      502,
    );
  }
}
