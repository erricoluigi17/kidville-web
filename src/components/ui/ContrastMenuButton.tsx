'use client';

import { Contrast } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAccessibility } from '@/lib/accessibility/useAccessibility';

// ⚠️ DAL 2026-09-04 QUESTO COMPONENTE NON È PIÙ MONTATO DALL'APP.
// L'Alto contrasto è uscito dai menu rapidi ed è diventato `ContrastSwitch`,
// un interruttore con lo stato visibile dentro le pagine impostazioni
// (`/parent/profilo`, `/teacher/profilo`, `/admin/impostazioni`). La ragione sta
// nel commento di quel file: è uno STATO che dura un anno, non un comando, e in
// un menu rapido si accendeva per sbaglio senza dare alcun segno di essere acceso.
// Resta qui perché `__tests__/components/login-contrast.test.tsx` lo monta
// direttamente. Chi passa di qui decida: o quel test si sposta su `ContrastSwitch`
// e questo file si cancella, o si dichiara perché il componente deve sopravvivere.
// Un componente che nessuna schermata rende, e che un test tiene in vita, è debito.
//
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
  const t = useTranslations('shared');
  const { highContrast, toggle } = useAccessibility();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={highContrast}
      className={className}
    >
      <Contrast size={iconSize} strokeWidth={2.2} className="shrink-0" />
      <span>{t('altoContrasto')}</span>
    </button>
  );
}
