'use client';

import { useState } from 'react';

// Thin browser demo / fallback for the Ltravel backend. Hits the same
// /api/estimate endpoint the Bilt mobile app calls. Also serves as the
// "Best use of Vercel" deliverable — a live page proving the API works.

const SAMPLE = {
  departureCity: 'London',
  cities: ['Tokyo', 'Seoul'],
  cityDurations: [6, 4],
  tripStyle: 'mid-range',
  startDate: '2026-09-01',
  endDate: '2026-09-11',
  travellers: 2,
};

export default function Home() {
  const [input, setInput] = useState(JSON.stringify(SAMPLE, null, 2));
  const [output, setOutput] = useState('');
  const [loading, setLoading] = useState(false);

  async function run() {
    setLoading(true);
    setOutput('');
    try {
      const res = await fetch('/api/estimate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: input,
      });
      const data = await res.json();
      setOutput(JSON.stringify(data, null, 2));
    } catch (err) {
      setOutput(`Request failed: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ maxWidth: 920, margin: '0 auto', padding: '40px 20px' }}>
      <h1 style={{ fontSize: 30, margin: '0 0 4px' }}>Ltravel API</h1>
      <p style={{ color: '#b9aee0', marginTop: 0 }}>
        AI trip-cost estimates + live FX. POST a trip to <code>/api/estimate</code>.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 24 }}>
        <div>
          <label style={{ fontSize: 13, color: '#b9aee0' }}>Request (TripData)</label>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            spellCheck={false}
            style={{
              width: '100%',
              height: 320,
              marginTop: 6,
              padding: 12,
              borderRadius: 12,
              border: '1px solid #2c2150',
              background: '#16102e',
              color: '#f4f1fb',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 13,
              resize: 'vertical',
            }}
          />
        </div>
        <div>
          <label style={{ fontSize: 13, color: '#b9aee0' }}>Response (TripEstimate)</label>
          <pre
            style={{
              width: '100%',
              height: 320,
              marginTop: 6,
              padding: 12,
              borderRadius: 12,
              border: '1px solid #2c2150',
              background: '#16102e',
              color: '#d9d0f5',
              overflow: 'auto',
              fontSize: 13,
            }}
          >
            {output || '// response appears here'}
          </pre>
        </div>
      </div>

      <button
        onClick={run}
        disabled={loading}
        style={{
          marginTop: 16,
          padding: '12px 22px',
          borderRadius: 999,
          border: 'none',
          background: loading ? '#5b4a99' : 'linear-gradient(90deg,#a855f7,#ec4899)',
          color: 'white',
          fontWeight: 600,
          fontSize: 15,
          cursor: loading ? 'default' : 'pointer',
        }}
      >
        {loading ? 'Estimating…' : 'Estimate my trip'}
      </button>
    </main>
  );
}
