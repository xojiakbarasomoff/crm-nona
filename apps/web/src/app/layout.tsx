import type { ReactNode } from 'react';
import './globals.css';

export const metadata = { title: 'NONA Travel CRM', description: 'CRM для туристического агентства' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
