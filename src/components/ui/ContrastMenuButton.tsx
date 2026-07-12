'use client';

import { Contrast } from 'lucide-react';
import { useAccessibility } from '@/lib/accessibility/useAccessibility';

// Voce "Alto contrasto" riutilizzabile per i menu account (drawer Direzione,
// bottom nav Docente/Genitore, dropdown della TopBar). Gemella di
// LogoutMenuButton: il container decide lo stile via className, qui vivono solo
// icona + label + il toggle globale (provider + cookie SSR).
//
// Prima il toggle stava SOLO nella pagina di login: chi era già dentro l'app non
// poteva più cambiarlo. Ora è raggiungibile da ogni area — è la baseline di
// accessibilità AgID / Legge Stanca (P1, DL-008).

export function ContrastMenuButton({
  className,
  iconSize = 20,
}: {
  className?: string;
  iconSize?: number;
}) {
  const { highContrast, toggle } = useAccessibility();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={highContrast}
      className={className}
    >
      <Contrast size={iconSize} strokeWidth={2.2} className="shrink-0" />
      <span>Alto contrasto</span>
    </button>
  );
}
