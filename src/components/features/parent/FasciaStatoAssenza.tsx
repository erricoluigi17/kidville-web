'use client';

import type { ReactNode, Ref } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { FUOCO_ESITO } from '@/lib/ui/fuoco';

/**
 * Le fasce di stato della funzione «Comunica un'assenza»: l'AVVISO che il giorno
 * scelto è già stato comunicato, il RIFIUTO del server, la CONFERMA.
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────
 * Perché le stesse tre fasce erano scritte due volte — in `/parent/attendance`
 * e nella card di `/parent/primaria/assenze` — come due elenchi di classi
 * ricopiati a mano, e le due copie erano già divergenti. Misurato dal collaudo
 * del 2026-08-08 con `getComputedStyle`, a parità di parole e di colori:
 *
 *   avviso «già comunicata» · raggio 12px (pagina)  VS  16px (card)
 *   riquadro d'errore       · bordo + triangolo     VS  né bordo né icona
 *   riquadro di conferma    · solo inchiostro       VS  fascia piena
 *
 * `FUOCO_ESITO` centralizzava l'anello di fuoco e dichiarava esplicitamente di
 * NON contenere il raggio, «lasciandolo a ogni punto d'uso»: il lock che ne
 * derivava verificava che un raggio ci fosse, non che fosse lo stesso. Qui
 * l'ANATOMIA sta in un posto solo — raggio, bordo, icona, spaziatura — e le due
 * schermate passano soltanto le parole, che vengono da cataloghi diversi e per
 * questo non possono vivere dentro. È la stessa scelta di
 * `RigaAssenzaComunicata`, per la stessa ragione.
 *
 * ─── LE MISURE DI CONTRASTO, CHE NON SONO A OCCHIO ──────────────────────────
 * Gli inchiostri sono i token FORTI, non le tinte di riempimento:
 *   · `error-strong` #C62828 su `error-soft`   = 4,92:1
 *   · `success-strong` #1B5E20 su `success-soft` = 8,00:1
 *   · `warn` è RIMAPPATO da globals.css a `warn-strong` #A64F09 → 4,95:1
 * Lock: `__tests__/a11y/contrasto-schermate-assenza.test.tsx`.
 */

export type TipoFascia = 'avviso' | 'errore' | 'conferma';

const ANATOMIA: Record<TipoFascia, { classi: string; Icona: typeof AlertCircle }> = {
  avviso: {
    classi: 'border-kidville-warn/30 bg-kidville-warn-soft text-kidville-warn',
    Icona: AlertCircle,
  },
  errore: {
    classi: 'border-kidville-error/20 bg-kidville-error-soft text-kidville-error-strong',
    Icona: AlertTriangle,
  },
  conferma: {
    classi: 'border-kidville-success/30 bg-kidville-success-soft text-kidville-success-strong',
    Icona: CheckCircle2,
  },
};

interface Props {
  tipo: TipoFascia;
  /**
   * `status` (annuncio gentile, alla prima pausa) oppure `alert` (interrompe).
   * Lo decide chi la usa perché dipende dal MOMENTO, non dal colore: lo stesso
   * avviso arancione è `status` quando compare cambiando giorno e `alert`
   * quando è la risposta a un gesto appena fatto.
   */
  ruolo: 'status' | 'alert';
  children: ReactNode;
  /**
   * Il RICOVERO DEL FUOCO. Ogni esito smonta il comando che l'ha lanciato: chi
   * ha premuto da tastiera si ritroverebbe il fuoco su `<body>`, cioè all'inizio
   * della pagina (WCAG 2.4.3). Chi passa il ref passa anche `tabIndex={-1}`:
   * raggiungibile dal codice, mai dal Tab.
   */
  ricovero?: Ref<HTMLDivElement>;
  tabIndex?: number;
  className?: string;
}

export function FasciaStatoAssenza({ tipo, ruolo, children, ricovero, tabIndex, className }: Props) {
  const { classi, Icona } = ANATOMIA[tipo];
  return (
    <div
      ref={ricovero}
      role={ruolo}
      tabIndex={tabIndex}
      className={`flex items-start gap-2 rounded-xl border px-3 py-2 font-maven text-xs ${classi} ${FUOCO_ESITO} ${className ?? ''}`}
    >
      <Icona size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}
