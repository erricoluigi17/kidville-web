'use client';

import { Contrast } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useContext } from 'react';
import { AccessibilityContext } from '@/lib/accessibility/context';

/**
 * Interruttore «Alto contrasto» per le pagine di impostazioni (Genitore,
 * Docente, Direzione).
 *
 * PERCHÉ ESISTE, e perché non è più una voce di menu (2026-09-04). Prima
 * l'Alto contrasto era una riga dentro il menu account di ogni area — stessa
 * forma di «Esci» e «Cambia profilo», cioè di un COMANDO. Ma non è un comando:
 * è uno STATO, dura un anno (cookie `kv_contrast`), sopravvive al logout, e
 * ridipinge l'intera app di nero e bianco. Un tocco per sbaglio in un menu
 * rapido, e l'app non somiglia più a sé stessa finché qualcuno non ritrova
 * quella riga — che nel frattempo non dava alcun segno di essere accesa: il
 * bottone aveva `aria-pressed`, quindi lo screen reader lo sapeva, ma
 * l'occhio no.
 *
 * Qui lo stato si VEDE (binario acceso/spento) e la forma dice che è uno stato,
 * non un'azione: `role="switch"` con `aria-checked`, non un `<button>` muto.
 *
 * NON si sposta anche il gemello pubblico (`PublicContrastButton`): chi non ha
 * fatto l'accesso non ha una pagina impostazioni, e la baseline AgID / Legge
 * Stanca chiede che l'aiuto sia raggiungibile dalle pagine pubbliche.
 */
export function ContrastSwitch({ className }: { className?: string }) {
  const t = useTranslations('shared');
  // `useContext` grezzo e non `useAccessibility()`, che LANCIA fuori dal provider.
  // Stessa scelta di `PublicContrastButton`, e qui pesa di più: questo interruttore
  // vive nella pagina profilo, insieme al CAMBIO PASSWORD. Se un albero lo rendesse
  // fuori dal provider — un layout nuovo, una pagina d'errore, un test che monta la
  // sola pagina — un comando accessorio porterebbe giù la schermata con cui si
  // recupera l'accesso. È il principio del logger fail-open: un guasto
  // dell'accessorio non può diventare un guasto del prodotto.
  const ctx = useContext(AccessibilityContext);
  if (!ctx) return null;
  const { highContrast, toggle } = ctx;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={highContrast}
      onClick={toggle}
      className={
        className ??
        'flex w-full items-center gap-3 rounded-card bg-kidville-white px-4 py-3 text-left ' +
          'shadow-[0_1px_2px_rgba(0,84,75,.04),0_8px_24px_-18px_rgba(0,84,75,.28)] ' +
          'transition-colors hover:bg-kidville-cream ' +
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kidville-green'
      }
    >
      <Contrast size={20} strokeWidth={2.2} className="shrink-0 text-kidville-green" aria-hidden="true" />
      <span className="flex-1 font-barlow text-base font-extrabold uppercase tracking-wide text-kidville-ink">
        {t('altoContrasto')}
      </span>
      {/* Il binario: verde pieno = acceso, grigio bordato = spento. È l'unico
          segno di stato che c'era da aggiungere — prima non ce n'era nessuno. */}
      <span
        aria-hidden="true"
        className={`relative h-6 w-11 shrink-0 rounded-pill transition-colors ${
          highContrast ? 'bg-kidville-green' : 'border border-kidville-line bg-kidville-neutral-soft'
        }`}
      >
        <span
          className={`absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-pill transition-all ${
            highContrast ? 'left-[26px] bg-kidville-yellow' : 'left-1 bg-kidville-muted'
          }`}
        />
      </span>
    </button>
  );
}
