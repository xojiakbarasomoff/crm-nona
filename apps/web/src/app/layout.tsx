import type { ReactNode } from 'react';
import './globals.css';

export const metadata = { title: 'Turizm CRM', description: 'amoCRM asosidagi turizm CRM' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="uz">
      <body>{children}</body>
    </html>
  );
}
