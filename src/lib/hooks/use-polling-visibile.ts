'use client';

import { useEffect, useRef } from 'react';
import { isNativeApp } from '@/lib/push/native-register';
import { logClient } from '@/lib/logging/client';

/**
 * IL POLLING SI FERMA QUANDO NESSUNO GUARDA.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * COS'ERA IL DIFETTO, misurato il 7 settembre 2026. L'app è andata lenta per tutta la mattina:
 * 427 famiglie collegate hanno prodotto **2.231.291 richieste a Supabase in un giorno**, 399.395
 * nella sola ora 11:00-12:00 contro le 21.099 dell'ora di punta del giorno prima — circa 4.940
 * richieste a testa. E non era solo più gente: i fetch falliti per persona erano RADDOPPIATI, 9,34
 * a testa contro i 3,58-3,65 dei giorni tranquilli, tutti con `stato_http = 0` — richieste che non
 * arrivano nemmeno a destinazione.
 *
 * Dentro quel volume c'erano dieci orologi, ognuno scritto a mano dentro il proprio componente, e
 * **nessuno guardava se qualcuno stesse guardando**. Un genitore fermo sulla pagina della chat
 * faceva ~11 richieste al minuto senza toccare niente — e continuava a farle col telefono in
 * tasca e lo schermo spento. Questo hook esiste perché quel caso costi zero.
 *
 * PERCHÉ DUE SEGNALI E NON UNO. `document.hidden` è lo standard del web, ma questa app gira anche
 * dentro una WebView Capacitor, e non è dato per scontato che `visibilitychange` scatti quando
 * l'app va in secondo piano — su iOS in particolare. Non lo si assume: si montano **entrambi** i
 * segnali, così la correttezza non dipende da quale dei due funzioni. Quale sia arrivato davvero
 * lo dice la sonda qui sotto, che risponde con un dato invece che con un'opinione.
 *
 * Il precedente che impone questa cautela sta in `client.ts`: per 31 giorni il campo `piattaforma`
 * ha detto `web` per 3.625 eventi su 3.626, perché Capacitor NON si scrive nello user-agent e
 * qualcuno l'aveva dedotto invece di chiederlo al bridge.
 *
 * LA COALESCENZA non è un ornamento. I due segnali possono scattare per la STESSA ripresa, e su
 * Android è documentato (`BiometricGate.tsx:33-45`) che arrivi un `isActive:true` spurio, perché
 * l'Activity del prompt biometrico è dichiarata traslucida. Senza coalescenza il risveglio
 * costerebbe due fetch invece di uno — cioè proprio il difetto che questo file toglie. Qui la
 * coalescenza è **strutturale**: lo stato è un booleano, e senza transizione non succede niente.
 * La finestra di tempo è la seconda cintura, contro lo sfarfallio.
 * ─────────────────────────────────────────────────────────────────────────────────
 */

/** Due segnali per la stessa ripresa entro questa finestra contano come uno. */
const FINESTRA_COALESCENZA_MS = 1_000;

/**
 * LA SONDA. Segna, una volta per sessione di pagina e per segnale, quale sorgente di visibilità
 * ha parlato davvero su un dispositivo nativo.
 *
 * Perché parla anche quando tutto va bene: due silenzi opposti non si distinguono. «Nessun log»
 * non separa «`visibilitychange` funziona» da «la sonda non è mai partita» — è la stessa
 * ambiguità che in questo progetto ha tenuto nascosto per mesi il guasto delle email, e la
 * ragione per cui AGENTS.md pretende che gli eventi critici registrino anche il successo.
 *
 * Il livello è `warn` perché il canale del client non ne ha altri (`livello: 'warn' | 'error'`),
 * non perché sia un guasto. La `piattaforma` non la si passa: la mette il logger, chiedendola al
 * bridge — e quella è già la versione corretta dopo il difetto del 2026-09-01.
 *
 * Costa al massimo due righe per sessione nativa, e `app_log` le deduplica per `(impronta,
 * giorno)`: i messaggi sono diversi apposta, altrimenti il secondo segnale sparirebbe dentro il
 * primo e la domanda resterebbe senza risposta.
 */
const sondaVista = new Set<string>();

function sonda(segnale: string, nativo: boolean): void {
    if (!nativo || sondaVista.has(segnale)) return;
    sondaVista.add(segnale);
    logClient({
        livello: 'warn',
        evento: 'visibilita',
        messaggio: `segnale di visibilità ricevuto: ${segnale}`,
    });
}

interface Opzioni {
    /**
     * Il ritmo da usare quando la pagina è nascosta. Omesso (il caso normale) l'orologio si
     * FERMA. Si dà un valore solo dove fermarsi spegnerebbe una funzione: `useUnreadNotifications`
     * è l'unico punto che manda la notifica del browser quando la pagina non è a fuoco.
     */
    intervalloNascostoMs?: number;
    /** `false` non arma niente. Serve ai punti che hanno già un gate proprio (es. una media query). */
    attivo?: boolean;
}

/**
 * Esegue `callback` a intervalli, ma solo mentre qualcuno sta guardando.
 *
 * NON fa il primo caricamento: quello resta del chiamante, che di solito ha già il proprio
 * `useEffect(() => { carica() }, [carica])`. Questo hook governa il RITMO, non l'avvio.
 *
 * Al ritorno in primo piano esegue **subito**, senza aspettare il tick: chi riapre l'app deve
 * trovare i dati freschi.
 */
export function usePollingVisibile(
    callback: () => void | Promise<void>,
    intervalloMs: number,
    { intervalloNascostoMs, attivo = true }: Opzioni = {},
): void {
    /**
     * La callback vive in un ref, e l'orologio NON dipende da lei.
     *
     * È anche una correzione: il timer di `parent/locker/page.tsx` dipendeva da `activeTab` e
     * `month`, quindi a ogni cambio di scheda o di mese l'orologio si ricreava e il conto
     * ripartiva da zero. Qui il ritmo resta quello, e a scattare è sempre l'ultima versione.
     */
    const cb = useRef(callback);
    useEffect(() => {
        cb.current = callback;
    });

    useEffect(() => {
        if (!attivo) return;

        const nativo = isNativeApp();
        const rif: { timer: ReturnType<typeof setInterval> | null; nativoAgganciato: { remove: () => Promise<void> } | null } = {
            timer: null,
            nativoAgganciato: null,
        };
        let inPrimoPiano = !document.hidden;
        let ultimaRipresa = 0;
        let smontato = false;

        const esegui = () => {
            void cb.current();
        };

        const arma = () => {
            if (rif.timer !== null) {
                clearInterval(rif.timer);
                rif.timer = null;
            }
            const ritmo = inPrimoPiano ? intervalloMs : intervalloNascostoMs;
            // Nascosto e nessun ritmo lento richiesto: l'orologio resta fermo. È il caso normale.
            if (ritmo === undefined) return;
            rif.timer = setInterval(esegui, ritmo);
        };

        /** L'unico punto in cui i due segnali confluiscono. */
        const aggiorna = (primoPiano: boolean, segnale: string) => {
            sonda(segnale, nativo);
            // Nessuna transizione ⇒ niente da fare. Qui vive la coalescenza fra i due segnali.
            if (primoPiano === inPrimoPiano) return;
            inPrimoPiano = primoPiano;
            if (primoPiano) {
                const ora = Date.now();
                if (ora - ultimaRipresa >= FINESTRA_COALESCENZA_MS) {
                    ultimaRipresa = ora;
                    esegui();
                }
            }
            arma();
        };

        const suVisibilita = () => aggiorna(!document.hidden, 'visibilitychange');
        document.addEventListener('visibilitychange', suVisibilita);

        if (nativo) {
            void (async () => {
                try {
                    const { App } = await import('@capacitor/app');
                    const h = await App.addListener('appStateChange', ({ isActive }) =>
                        aggiorna(isActive, 'appStateChange'),
                    );
                    // Lo smontaggio può avvenire mentre l'import è in volo: senza questo controllo
                    // l'ascoltatore resterebbe agganciato a un componente che non c'è più.
                    if (smontato) {
                        void h.remove();
                        return;
                    }
                    rif.nativoAgganciato = h;
                } catch {
                    // Il plugin manca o il bridge non risponde: si resta col solo
                    // `visibilitychange`, che è comunque il segnale standard. Non è silenzioso —
                    // la sonda lo dice, ed è esattamente l'informazione che serve a capire su
                    // quale dei due segnali ci si stia reggendo davvero.
                    sonda('appStateChange-non-disponibile', nativo);
                }
            })();
        }

        arma();

        return () => {
            smontato = true;
            if (rif.timer !== null) clearInterval(rif.timer);
            document.removeEventListener('visibilitychange', suVisibilita);
            void rif.nativoAgganciato?.remove();
        };
    }, [attivo, intervalloMs, intervalloNascostoMs]);
}
