import { NextRequest, NextResponse } from 'next/server';

import { buildEstimate } from '@/lib/estimate';
import { isEstimateError } from '@/lib/errors';
import { TripDataSchema } from '@/lib/schema';

// LLM + flight calls can take a few seconds — give Vercel room (Hobby allows 60s).
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
  // Optional shared secret (Bilt → Vercel hop). Off unless ESTIMATE_SHARED_SECRET is set.
  const requiredSecret = process.env.ESTIMATE_SHARED_SECRET;
  if (requiredSecret && req.headers.get('x-estimate-secret') !== requiredSecret) {
    return json(
      {
        error: 'unauthorized',
        source: 'config',
        message: 'Missing or invalid x-estimate-secret header.',
        fix: 'Send an x-estimate-secret header matching ESTIMATE_SHARED_SECRET, or unset that env var to disable the check.',
      },
      401,
    );
  }

  // Parse the body — a malformed request gets a clear 400, not a 500.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(
      {
        error: 'bad_request',
        source: 'input',
        message: 'Request body must be valid JSON.',
        fix: 'POST a JSON body with header Content-Type: application/json.',
      },
      400,
    );
  }

  const parsed = TripDataSchema.safeParse(body);
  if (!parsed.success) {
    return json(
      {
        error: 'invalid_trip',
        source: 'input',
        message: 'Could not understand the trip. Check the required fields.',
        fix: 'Fix the fields listed in `issues`. Required: departureCity, cities[≥1], tripStyle, startDate, endDate.',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      400,
    );
  }

  try {
    // Real data only — buildEstimate throws an EstimateError if it can't produce it.
    const estimate = await buildEstimate(parsed.data);
    return json(estimate);
  } catch (err) {
    if (isEstimateError(err)) {
      console.error(`[estimate] ${err.code}: ${err.message}`, err.detail ?? '');
      return json(err.toResponse(), err.status);
    }
    // Unexpected error — still tell the caller what happened.
    console.error('[estimate] unexpected', err);
    return json(
      {
        error: 'internal_error',
        source: 'server',
        message: err instanceof Error ? err.message : 'Unexpected server error.',
        fix: 'This is an unexpected server error — check the API server logs for the stack trace.',
      },
      500,
    );
  }
}
