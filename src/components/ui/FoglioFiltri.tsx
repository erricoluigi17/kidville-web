'use client';

import { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';
import { cx } from '@/lib/ui/cx';
import { useOverlayIndietro } from '@/lib/mobile/overlay-indietro';
import { focusabiliIn } from '@/lib/accessibility/focus-dialogo';
import type { TestiBarraFiltri } from '@/lib/ui/filtri/tipi';

/**
 * ─── IL FOGLIO DEI FILTRI — dal basso, non da destra ─────────────────────────
 *
 * Su un telefono i filtri si aprono dal BASSO. Il `Drawer` del cockpit
 * (`components/ui/cockpit.tsx`) è ancorato a destra e alto quanto lo schermo:
 * su un telefono diventa una pagina intera che arriva di lato, il pollice non
 * raggiunge i comandi in alto e il gesto di chiusura è quello sbagliato. Questo
 * foglio ricalca invece `AdminMenuSheet`, che è la forma già in uso nel cockpit
 * mobile di questo progetto: scrim, `rounded-t-[26px]`, `max-h-[70vh]`
 * scrollabile, scroll-lock dello sfondo, safe-area in fondo, Escape, tasto
 * Indietro di Android, fuoco che entra e torna.
 *
 * ── PERCHÉ È UN GUSCIO E BASTA ──────────────────────────────────────────────
 * Il contenuto arriva da fuori (`children`). Così i controlli dei campi vivono
 * in UN posto solo — `BarraFiltri`, che li disegna uguali nella prima riga, nel
 * pannello del desktop e qui dentro — e la dipendenza fra i due file resta a
 * senso unico (`BarraFiltri` → `FoglioFiltri`), senza il giro vizioso che
 * nascerebbe se il guscio conoscesse i campi.
 *
 * ── LA MICRO-INTERAZIONE CHE VALE PIÙ DI TUTTO IL RESTO ─────────────────────
 * La CTA in fondo non dice «Applica»: dice **«Mostra 12 risultati»**, e il
 * numero cambia mentre si toccano le pastiglie. Dice PRIMA di chiudere se la
 * selezione ha senso — invece di far chiudere, guardare, riaprire e correggere.
 *
 * ⚠️ Per i filtri SERVER quel numero è quello dell'ultima lettura: chi monta la
 * barra passa `mostrati` e finché la richiesta non torna il conto è ancora
 * quello di prima. Per i filtri client cambia sotto le dita, che è il caso in
 * cui questa interazione serve davvero.
 */

/** L'altezza minima di un bersaglio da toccare col pollice (WCAG 2.5.5, AAA). */
export const BERSAGLIO_TOCCO = 'min-h-[44px]';

interface FoglioFiltriProps {
  aperto: boolean;
  onChiudi: () => void;
  testi: TestiBarraFiltri;
  /** Quante righe si vedranno chiudendo. Cambia mentre si tocca. */
  mostrati: number;
  /** Quanti filtri sono attivi: a zero «Pulisci» non avrebbe niente da fare. */
  nAttivi: number;
  onPulisci: () => void;
  /** Il comando che ha aperto il foglio: lì torna il fuoco alla chiusura. */
  ritornoFuocoRef: React.RefObject<HTMLButtonElement | null>;
  /** Id del foglio, per l'`aria-controls` del comando che lo apre. */
  id?: string;
  children: React.ReactNode;
}

export function FoglioFiltri({
  aperto,
  onChiudi,
  testi,
  mostrati,
  nAttivi,
  onPulisci,
  ritornoFuocoRef,
  id,
  children,
}: FoglioFiltriProps) {
  const idBase = useId();
  const idTitolo = `${idBase}-foglio-filtri-titolo`;
  const dialogoRef = useRef<HTMLDivElement>(null);
  const chiudiRef = useRef<HTMLButtonElement>(null);

  // Il tasto Indietro fisico di Android chiude il foglio invece di navigare via.
  // Questo foglio non passa dalla primitiva `ui/Modal`, quindi la riga va
  // ripetuta qui: senza, premendo Indietro la pagina SOTTO cambia mentre il
  // foglio resta aperto sopra.
  useOverlayIndietro(aperto, onChiudi);

  // Fuoco iniziale sul «Chiudi», scroll-lock dello sfondo, e alla chiusura il
  // fuoco TORNA al comando che ha aperto (WCAG 2.4.3). `aperto` guida il
  // contenuto, quindi il cleanup di questo effetto coincide con la chiusura.
  useEffect(() => {
    if (!aperto) return;
    const precedente = ritornoFuocoRef.current;
    const overflowPrecedente = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    chiudiRef.current?.focus();
    return () => {
      document.body.style.overflow = overflowPrecedente;
      precedente?.focus();
    };
  }, [aperto, ritornoFuocoRef]);

  if (!aperto) return null;

  // Escape chiude; il Tab CICLA dentro il foglio. `aria-modal="true"` dice allo
  // screen reader che fuori è inerte: senza il ciclo, il Tab direbbe il
  // contrario e porterebbe sui comandi coperti dallo scrim — invisibili ma
  // attivabili con Invio (WCAG 2.4.11).
  const suTasto = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onChiudi();
      return;
    }
    if (e.key !== 'Tab') return;
    const lista = focusabiliIn(dialogoRef.current);
    if (lista.length === 0) return;
    const primo = lista[0];
    const ultimo = lista[lista.length - 1];
    if (e.shiftKey && document.activeElement === primo) {
      e.preventDefault();
      ultimo.focus();
    } else if (!e.shiftKey && document.activeElement === ultimo) {
      e.preventDefault();
      primo.focus();
    }
  };

  return (
    // Niente `lg:hidden` qui: a decidere se il foglio esiste è la `variante`
    // della barra, non una media query. Nasconderlo anche via CSS lo renderebbe
    // invisibile — ma ancora montato, con lo sfondo bloccato e il fuoco dentro —
    // a chiunque scegliesse la variante compatta su uno schermo largo.
    <div className="fixed inset-0 z-[112]" onKeyDown={suTasto}>
      <div className="absolute inset-0 bg-kidville-green/30 backdrop-blur-[2px]" onClick={onChiudi} aria-hidden="true" />
      <div
        ref={dialogoRef}
        id={id}
        role="dialog"
        aria-modal="true"
        aria-labelledby={idTitolo}
        className="kv-admin-sheet absolute bottom-0 left-1/2 flex max-h-[70vh] w-full max-w-[520px] -translate-x-1/2 flex-col rounded-t-[26px] bg-kidville-white px-4 pt-4 shadow-[0_-8px_40px_rgba(0,0,0,0.18)]"
        style={{ paddingBottom: 'max(16px, calc(env(safe-area-inset-bottom) + 12px))' }}
      >
        <div className="mb-3 flex items-center justify-between gap-3 px-1">
          <h2
            id={idTitolo}
            className="font-barlow text-xl font-black uppercase leading-none tracking-wide text-kidville-green"
          >
            {testi.filtri}
          </h2>
          <button
            ref={chiudiRef}
            type="button"
            onClick={onChiudi}
            aria-label={testi.chiudi}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-kidville-cream-dark text-kidville-green"
          >
            <X className="h-4 w-4" strokeWidth={2.4} />
          </button>
        </div>

        {/* Il corpo scorre, i due comandi in fondo NO: restano sotto il pollice
            anche con dieci filtri aperti. */}
        <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 pb-3">{children}</div>

        <div className="flex items-center gap-2 border-t border-kidville-line pt-3">
          <button
            type="button"
            onClick={onPulisci}
            disabled={nAttivi === 0}
            className={cx(
              BERSAGLIO_TOCCO,
              'inline-flex flex-1 items-center justify-center rounded-pill border border-kidville-line px-4 font-maven text-sm font-semibold text-kidville-ink/80 transition-colors hover:border-kidville-green disabled:opacity-50',
            )}
          >
            {testi.pulisciBreve}
          </button>
          <button
            type="button"
            data-testid="foglio-mostra"
            onClick={onChiudi}
            className={cx(
              BERSAGLIO_TOCCO,
              'inline-flex flex-[2] items-center justify-center rounded-pill bg-kidville-green px-4 font-barlow text-sm font-bold uppercase tracking-[0.03em] text-kidville-white transition-colors hover:bg-kidville-green-dark',
            )}
          >
            {testi.mostraRisultati(mostrati)}
          </button>
        </div>
      </div>
    </div>
  );
}
