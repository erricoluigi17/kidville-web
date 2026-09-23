'use client';

import { useEffect, useState } from 'react';
import { logClient, nomeErrore } from '@/lib/logging/client';
import type { RispostaConteggiCoda } from '@/lib/fatture-coda/api';

/**
 * IL CONTATORE DELLA VOCE DI MENU «CODA FATTURE» (nucleo §4).
 *
 * Quante voci sono ATTIVE nella coda — in attesa, in invio o in errore — lette da
 * `GET /api/pagamenti/fattura/coda?solo=conteggi`: solo i contatori, senza voci, autori né sedi,
 * perché il menu si monta su ogni pagina del cockpit e non deve trascinarsi fino a 1000 voci
 * per disegnare un numero.
 *
 * NIENTE POLLING. Il volume di richieste a schermo fermo ha già rallentato l'app (vedi
 * `use-polling-visibile.ts`): qui si legge UNA volta per ogni valore di `chiave` — la pagina
 * corrente per la sidebar, l'apertura per il menu mobile. Chi vuole il numero in tempo reale
 * apre la pagina della coda, che ha il suo polling a scheda visibile.
 *
 * `attivo` falso (ruolo che la GET rifiuterebbe, identità non ancora risolta) ⇒ nessuna
 * richiesta e `null`: il menu non mostra un contatore invece di mostrarne uno inventato.
 * Anche un errore o un DB non migrato danno `null`, mai `0`: zero vorrebbe dire «coda vuota».
 */
export function useConteggioCodaFatture(opzioni: {
  attivo: boolean;
  userId: string | null;
  chiave: string;
}): number | null {
  const { attivo, userId, chiave } = opzioni;
  const [letto, setLetto] = useState<number | null>(null);

  useEffect(() => {
    if (!attivo || !userId) return;
    const ctrl = new AbortController();
    fetch('/api/pagamenti/fattura/coda?solo=conteggi', {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { 'x-user-id': userId },
      signal: ctrl.signal,
    }).then(
      async (response) => {
        let corpo: RispostaConteggiCoda | null = null;
        try {
          corpo = (await response.json()) as RispostaConteggiCoda;
        } catch (errore) {
          if (ctrl.signal.aborted) return;
          logClient({
            livello: 'warn',
            evento: 'fetch',
            messaggio: 'coda-fatture-contatore-corpo-illeggibile',
            stato: response.status,
            campi: { error_code: nomeErrore(errore) },
          });
        }
        if (ctrl.signal.aborted) return;
        if (!response.ok || !corpo) {
          logClient({
            livello: response.status >= 500 ? 'error' : 'warn',
            evento: 'fetch',
            messaggio: 'coda-fatture-contatore-non-letto',
            stato: response.status,
          });
          setLetto(null);
          return;
        }
        const n = corpo.disponibile
          ? corpo.conteggi.in_coda + corpo.conteggi.in_invio + corpo.conteggi.errore
          : null;
        setLetto(n);
      },
      (errore: unknown) => {
        if (ctrl.signal.aborted) return;
        logClient({
          livello: 'warn',
          evento: 'fetch',
          messaggio: 'coda-fatture-contatore-non-letto',
          stato: 0,
          campi: { error_code: nomeErrore(errore) },
        });
        setLetto(null);
      },
    );
    return () => ctrl.abort();
  }, [attivo, userId, chiave]);

  if (!attivo || !userId) return null;
  // Fino alla nuova lettura resta il numero della pagina prima: meglio un dato di pochi
  // secondi fa che un contatore che sparisce e ricompare a ogni click.
  return letto;
}
