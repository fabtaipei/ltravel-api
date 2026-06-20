import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Ltravel API',
  description: 'Trip-cost estimate backend — AI estimates + live FX.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
          background: '#0e0a1f',
          color: '#f4f1fb',
        }}
      >
        {children}
      </body>
    </html>
  );
}
