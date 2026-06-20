import { NextResponse } from 'next/server';

// Lightweight liveness check — confirms the deployment is up without calling the LLM.
export async function GET() {
  return NextResponse.json({
    ok: true,
    service: 'ltravel-api',
    endpoints: ['/api/estimate'],
  });
}
