import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Consecutivos Contractuales · SULICOR',
  description: 'Generación controlada de números consecutivos para contratos — Doctux SAS',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body className="antialiased">{children}</body>
    </html>
  );
}
