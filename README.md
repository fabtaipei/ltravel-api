# Ltravel API

The Vercel-hosted backend for the Ltravel trip-cost estimator (Encode Club Vibe Coding Hackathon).
The Bilt mobile app ([`agneeep/locus`](https://github.com/agneeep/locus)) calls this over HTTPS.

```
Bilt app  ──HTTPS──▶  /api/estimate  ──▶  Claude (via Vercel AI Gateway)  +  Frankfurter FX
 (App Store)            this repo            the estimate logic               live home→dest rates
```

## What it does

`POST /api/estimate` takes the app's `TripData` and returns a `TripEstimate` — the **exact shape**
already defined in `locus/lib/tripEstimate.ts`, plus an additive live-FX block. So swapping the
app's mock `getTripEstimate()` for this endpoint is a one-line change with no other frontend edits.

- **AI estimate** — Claude (`anthropic/claude-opus-4-8`) produces per-city cost ranges
  (flights / accommodation / food / activities) and inter-city legs, as JSON-only structured output.
- **Live FX** — [Frankfurter](https://frankfurter.dev) (keyless, ECB rates) converts the USD totals
  into the traveller's home and destination currencies.
- **Robust** — bad input returns friendly `400` JSON; upstream failures return friendly `502` JSON.
  Never a raw 500.

## Local development

```sh
npm install
cp .env.example .env.local      # add an AI Gateway key for local dev only
npm run dev                     # http://localhost:3000
```

- The home page (`/`) is a thin browser demo that POSTs to the API.
- `GET /api/health` — liveness check.
- Test the endpoint directly:

```sh
curl -X POST http://localhost:3000/api/estimate \
  -H "Content-Type: application/json" \
  -d @sample-request.json
```

### Why an AI Gateway key locally but not in prod

On Vercel, the gateway is authed automatically via an injected `VERCEL_OIDC_TOKEN` (OIDC) — **no key
to manage in production**. Locally there's no OIDC, so `npm run dev` needs an `AI_GATEWAY_API_KEY`
(create one in the Vercel dashboard → AI Gateway → API Keys). Every Vercel team gets **$5/mo of free
AI Gateway credit** with no per-token markup — ⚠️ do **not** top up, or you lose the recurring free $5.

## Deploy to Vercel (step-by-step)

1. Push this folder to a new **public** GitHub repo, e.g. `ltravel-api`:
   ```sh
   git init && git add -A && git commit -m "Ltravel backend: /api/estimate"
   git branch -M main
   git remote add origin https://github.com/<you>/ltravel-api.git
   git push -u origin main
   ```
2. Go to **vercel.com/new** → **Continue with GitHub** → import `ltravel-api`.
3. Framework auto-detects as **Next.js**. Leave defaults → **Deploy** (~1 min).
4. **Enable the AI Gateway:** in the Vercel project → **AI** tab (or Storage/AI Gateway), connect the
   gateway to this project. This wires the OIDC token so no API key is needed in prod.
5. (Optional) **Project → Settings → Environment Variables** → add `ESTIMATE_SHARED_SECRET` if you
   want to require an `x-estimate-secret` header (skip for the MVP).
6. Live URL is like `https://ltravel-api.vercel.app`. Verify:
   ```sh
   curl https://ltravel-api.vercel.app/api/health
   curl -X POST https://ltravel-api.vercel.app/api/estimate \
     -H "Content-Type: application/json" -d @sample-request.json
   ```

## Wiring the Bilt app to this backend

In `locus/lib/tripEstimate.ts`, replace the body of `getTripEstimate()` with a fetch to the deployed
URL (the return type is unchanged — the app keeps working):

```ts
export async function getTripEstimate(tripData: TripData): Promise<TripEstimate> {
  const res = await fetch('https://ltravel-api.vercel.app/api/estimate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tripData),
  });
  if (!res.ok) throw new Error('estimate request failed');
  return res.json();
}
```

## Response shape

Matches `TripEstimate` from `locus/lib/tripEstimate.ts`, with one additive field:

```jsonc
{
  "totalCost": { "min": 0, "max": 0 },
  "cities": [{ "name": "Tokyo", "costRange": {…}, "breakdown": { "flights": {…}, "accommodation": {…}, "food": {…}, "activities": {…} } }],
  "legs":   [{ "id": "london-tokyo", "from": "London", "to": "Tokyo", "options": [{ "id": "…", "mode": "flight", "carrier": "…", "detail": "…", "price": 0, "durationMinutes": 0, "recommended": true, "recommendReason": "…" }] }],
  "routeWarning": null,
  "fx": {                      // ← additive; the app ignores it until the frontend types opt in
    "base": "USD", "home": "GBP", "destination": "JPY",
    "homePerBase": 0.79, "destinationPerBase": 157.2, "destinationPerHome": 199.0,
    "asOf": "2026-06-19", "source": "frankfurter"
  }
}
```
