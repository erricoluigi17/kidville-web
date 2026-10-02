'use client';

import { useCallback, useEffect, useRef } from 'react';

import { usePollingVisibile } from '@/lib/hooks/use-polling-visibile';
import { logClient, nomeErrore } from '@/lib/logging/client';

/**
 * LA RIPRESA AUTOMATICA DEI CARICAMENTI FERMI — senza che nessuno prema niente.
 *
 * ─── IL DIFETTO CHE CHIUDE ───────────────────────────────────────────────────────────────────
 * Un caricamento che la rete interrompe (la galleria della metropolitana, una cella agganciata male)
 * restava «interrotto» finché una persona non premeva «Riprendi»: una scheda che dice «riprende da
 * dove si era fermato» e poi aspetta un dito. Per un video da un gigabyte su una rete mobile
 * quell'attesa è la norma, non l'eccezione. Adesso la schermata riprende da sola, e il pulsante resta
 * come acceleratore per chi non vuole aspettare.
 *
 * ─── QUATTRO SEGNALI, E UN SOLO CANCELLO ────────────────────────────────────────────────────
 *  1. **il ritorno in primo piano** — `usePollingVisibile`, che coalizza `visibilitychange` e
 *     `appStateChange` (su iOS e Android il primo non scatta sempre, e in una WebView Capacitor il
 *     secondo è l'unico che l'app riceve davvero): subito, senza aspettare un orologio;
 *  2. **l'evento `online`** — la rete è tornata: subito, ed è il segnale migliore che esista;
 *  3. **il rientro nella pagina** — lo fa chi monta l'hook, una volta, con il motivo `rientro`;
 *  4. **un orologio con attesa crescente** — 5, 15, 30, 60 secondi, e poi ogni 60 — finché ci sono
 *     righe interrotte E la pagina è visibile. È la rete di tutte le altre: una rete che ritorna
 *     senza dire niente, o una cella che si aggancia da sola.
 *
 * ⚠️ L'ATTESA CRESCE PERCHÉ OGNI TENTATIVO COSTA. Ogni ripresa che non va a buon fine lascia le sue
 * righe nei log e consuma una richiesta di firma; riprovare ogni cinque secondi per un'ora, con la
 * persona che ha lasciato il telefono sul tavolo, è esattamente il volume che il 2026-09-07 ha reso
 * l'app lenta (2,23 milioni di richieste in un giorno). I segnali 1 e 2 azzerano l'attesa: sono
 * notizie, non tentativi. Lo è anche un trasferimento che arriva in fondo: chi monta l'hook lo dice
 * con `azzera()`.
 *
 * ⚠️ IL CONTO DEI TENTATIVI VIVE NELL'HOOK, NON NELL'EFFETTO. Chi lo monta passa `attiva = false`
 * mentre un tentativo gira (la riga è «in caricamento») e di nuovo `true` quando la rete lo interrompe:
 * se il conto stesse dentro l'effetto che dipende da `attiva`, ripartirebbe da zero a ogni giro, e
 * l'attesa resterebbe a 5 secondi per sempre — misurato: tentativi ogni 7 secondi, per ore, invece
 * di 5, 15, 30, 60. Si azzera SOLO con una notizia (rete tornata, ritorno in primo piano,
 * `azzera()`), mai perché il giro è cambiato.
 *
 * ⚠️ SENZA RETE NON SI TENTA. `navigator.onLine === false` salta il giro (l'orologio si riarma e
 * `online` farà partire la ripresa quando serve): ogni tentativo senza campo lascerebbe una riga
 * `error` e un conto che non dice niente.
 *
 * Il «cosa riprendere» non sta qui: lo decide chi monta l'hook (`riprendi`), che conosce le righe.
 */

export type MotivoRipresa = 'rientro' | 'visibilita' | 'online' | 'backoff';

/** Le attese fra un tentativo e il successivo, in millisecondi. Dopo l'ultima si resta lì. */
export const RITARDI_RIPRESA_MS: readonly number[] = [5_000, 15_000, 30_000, 60_000];

export interface OpzioniRipresaAutomatica {
    /** Ci sono righe interrotte da riprendere? Senza, niente si arma e niente si ascolta. */
    attiva: boolean;
    /**
     * Riprende ciò che è interrotto. Risolve quando il giro è finito: l'attesa successiva conta da
     * lì, non dalla partenza (un trasferimento può durare minuti, e due giri non devono accavallarsi).
     */
    riprendi: (motivo: MotivoRipresa) => void | Promise<void>;
}

export interface RipresaAutomatica {
    /**
     * Una buona notizia dalla rete — un trasferimento arrivato in fondo: l'attesa riparte da 5 secondi
     * e, se l'orologio è armato, si riarma. Senza righe interrotte (`attiva = false`) azzera soltanto
     * il conto, che alla prossima interruzione riparte dal primo gradino.
     */
    azzera: () => void;
}

export function useRipresaAutomatica({ attiva, riprendi }: OpzioniRipresaAutomatica): RipresaAutomatica {
    // La funzione vive in un ref: gli orologi non devono ricrearsi a ogni render del chiamante.
    const riprendiRif = useRef(riprendi);
    useEffect(() => {
        riprendiRif.current = riprendi;
    });
    /**
     * Quanti tentativi a vuoto di fila: sceglie la prossima attesa (`RITARDI_RIPRESA_MS`). Sta qui e
     * non nell'effetto perché `attiva` si spegne durante ogni tentativo e l'effetto ricomincerebbe da zero.
     */
    const tentativoRif = useRef(0);
    /** Azzera l'attesa e riarma l'orologio: la chiamano i segnali che sono notizie, non tentativi. */
    const azzeraRif = useRef<() => void>(() => undefined);
    const azzera = useCallback(() => {
        tentativoRif.current = 0;
        azzeraRif.current();
    }, []);

    // 1 · il ritorno in primo piano. `null` = «solo al ritorno», nessun orologio: l'orologio crescente
    // è qui sotto, perché questo ha un ritmo fisso e a noi serve un'attesa che cresce.
    usePollingVisibile(
        () => {
            azzeraRif.current();
            void riprendiRif.current('visibilita');
        },
        null,
        { attivo: attiva },
    );

    useEffect(() => {
        if (!attiva) return;

        let vivo = true;
        let orologio: ReturnType<typeof setTimeout> | null = null;

        const ferma = () => {
            if (orologio !== null) {
                clearTimeout(orologio);
                orologio = null;
            }
        };

        const arma = () => {
            ferma();
            // Pagina nascosta: nessun orologio. Al ritorno lo riarma `suVisibilita`.
            if (!vivo || document.hidden) return;
            const attesa = RITARDI_RIPRESA_MS[Math.min(tentativoRif.current, RITARDI_RIPRESA_MS.length - 1)];
            orologio = setTimeout(() => {
                orologio = null;
                void scatta();
            }, attesa);
        };

        const scatta = async () => {
            if (!vivo || document.hidden) return;
            // Senza rete non si tenta e non si consuma un'attesa: si riguarda fra altrettanto.
            if (typeof navigator !== 'undefined' && navigator.onLine === false) {
                arma();
                return;
            }
            tentativoRif.current += 1;
            try {
                await riprendiRif.current('backoff');
            } catch (err) {
                // Un giro che lancia non deve fermare l'orologio, né sparire: il prossimo tentativo
                // c'è comunque, ma questa riga dice che il precedente non è arrivato in fondo.
                logClient({
                    livello: 'error',
                    evento: 'offline',
                    messaggio: 'video-ripresa-automatica-interrotta',
                    campi: { motivo: 'backoff', tentativo: tentativoRif.current, error_code: nomeErrore(err) },
                });
            }
            arma();
        };

        // 2 · la rete è tornata: è una notizia, quindi l'attesa riparte da capo.
        const suOnline = () => {
            tentativoRif.current = 0;
            arma();
            void riprendiRif.current('online');
        };
        const suVisibilita = () => {
            if (document.hidden) {
                ferma();
            } else {
                tentativoRif.current = 0;
                arma();
            }
        };

        azzeraRif.current = () => {
            tentativoRif.current = 0;
            arma();
        };
        window.addEventListener('online', suOnline);
        document.addEventListener('visibilitychange', suVisibilita);
        arma();

        return () => {
            vivo = false;
            ferma();
            azzeraRif.current = () => undefined;
            window.removeEventListener('online', suOnline);
            document.removeEventListener('visibilitychange', suVisibilita);
        };
    }, [attiva]);

    return { azzera };
}
