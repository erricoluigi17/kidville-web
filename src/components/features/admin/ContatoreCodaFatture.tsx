'use client';

import { useTranslations } from 'next-intl';

/**
 * Il numero accanto alla voce di menu «Coda fatture» (nucleo §4): le voci ATTIVE — in attesa,
 * in invio, in errore. `null` o `0` ⇒ niente: il menu non annuncia una coda vuota, né un
 * numero che non ha potuto leggere.
 *
 * Il numero a schermo è `aria-hidden`; lo screen reader legge la frase intera
 * («3 voci attive in coda»), perché un «3» nudo dentro un link non dice di cosa.
 */
export function ContatoreCodaFatture({ n, attivo = false }: { n: number | null; attivo?: boolean }) {
  const tc = useTranslations('adminContabilita');
  if (n === null || n <= 0) return null;
  return (
    <span
      data-testid="contatore-coda-fatture"
      className={`relative z-10 ml-auto inline-flex min-w-[1.5rem] items-center justify-center rounded-full px-1.5 py-0.5 font-maven text-xs font-bold ${
        attivo ? 'bg-kidville-yellow text-kidville-green' : 'bg-kidville-green-soft text-kidville-green'
      }`}
    >
      <span aria-hidden="true">{n}</span>
      <span className="sr-only">{tc('codaFatture.menu.vociAttive', { n })}</span>
    </span>
  );
}
