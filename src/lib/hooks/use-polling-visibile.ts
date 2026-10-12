'use client';

import { useEffect, useRef } from 'react';
import { osservaVisibilita } from '@/lib/hooks/visibilita-pagina';

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
 * I DUE SEGNALI (`visibilitychange` e `appStateChange` di Capacitor), la loro coalescenza e la
 * cautela che la impone non stanno più qui: stanno in `@/lib/hooks/visibilita-pagina`, perché
 * dal 2026-10-12 lo stesso meccanismo serve anche al controllo della versione del bundle. Il
 * perché di ciascuna scelta — e perché la sonda che annunciava i segnali adesso tace — si legge
 * là, in un posto solo.
 * ─────────────────────────────────────────────────────────────────────────────────
 */

interface Opzioni {
    /**
     * Il ritmo da usare quando la pagina è nascosta. Omesso (il caso normale) l'orologio si
     * FERMA. Si dà un valore solo dove fermarsi spegnerebbe una funzione: `useUnreadNotifications`
     * è l'unico punto che manda la notifica del browser quando la pagina non è a fuoco.
     */
    intervalloNascostoMs?: number;
    /** `false` non arma niente. Serve ai punti che hanno già un gate proprio (es. una media query). */
    attivo?: boolean;
    /**
     * Se la callback eseguita AL RITORNO risponde `false` («non ce l'ho fatta»), la si riprova
     * UNA volta dopo questi millisecondi — solo se la pagina è ancora visibile e montata, e se
     * nel frattempo non è arrivato un altro ritorno. Omesso: nessun secondo tentativo.
     *
     * Perché: misurato il 2026-09-28 in `app_log`, in 14 giorni la sola lettura del diario è
     * fallita a stato 0 («Failed to fetch» / «Load failed») 967 volte, per ~220 utenti. Senza
     * ritorni con un orologio (`intervalloMs: null`) quella prova andata a vuoto era l'unica:
     * il genitore restava sulla pagina vecchia fino alla riapertura successiva.
     */
    ritentaDopoMs?: number;
}

/**
 * Esegue `callback` a intervalli, ma solo mentre qualcuno sta guardando.
 *
 * NON fa il primo caricamento: quello resta del chiamante, che di solito ha già il proprio
 * `useEffect(() => { carica() }, [carica])`. Questo hook governa il RITMO, non l'avvio.
 *
 * Al ritorno in primo piano esegue **subito**, senza aspettare il tick: chi riapre l'app deve
 * trovare i dati freschi.
 *
 * `intervalloMs: null` = **solo al ritorno**, nessun orologio. Serve dove il dato cambia poche
 * volte al giorno e il momento in cui il vecchio mente è la riapertura, non il minuto che passa:
 * il diario del genitore (2026-09-28) restava fermo a «la maestra non ha ancora compilato» con le
 * voci già in archivio, e un orologio lì sarebbe stato volume senza bisogno.
 */
export function usePollingVisibile(
    callback: () => void | boolean | Promise<void | boolean>,
    intervalloMs: number | null,
    { intervalloNascostoMs, attivo = true, ritentaDopoMs }: Opzioni = {},
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

        const rif: { timer: ReturnType<typeof setInterval> | null } = { timer: null };
        let inPrimoPiano = !document.hidden;
        let smontato = false;
        // Il secondo tentativo in attesa, e il numero del ritorno a cui appartiene: un ritorno
        // nuovo, o la pagina che torna nascosta, lo rendono inutile.
        let ritentativo: ReturnType<typeof setTimeout> | null = null;
        let ritorno = 0;

        const esegui = () => {
            void cb.current();
        };

        const annullaRitentativo = () => {
            if (ritentativo !== null) {
                clearTimeout(ritentativo);
                ritentativo = null;
            }
        };

        /** Il ritorno in primo piano: subito, e — se chiesto — una seconda volta se è andata male. */
        const eseguiAlRitorno = () => {
            annullaRitentativo();
            const questo = ++ritorno;
            const esito = cb.current();
            if (ritentaDopoMs === undefined) return;
            // Nessun gestore del rifiuto, apposta: una callback che lancia resta un rifiuto non
            // gestito, come con `esegui`, e lo raccoglie il logger globale.
            void Promise.resolve(esito).then((riuscito) => {
                if (riuscito !== false || smontato || !inPrimoPiano || questo !== ritorno) return;
                // Un ritorno nuovo, la pagina che torna nascosta e lo smontaggio lo annullano.
                ritentativo = setTimeout(() => {
                    ritentativo = null;
                    esegui();
                }, ritentaDopoMs);
            });
        };

        const arma = () => {
            if (rif.timer !== null) {
                clearInterval(rif.timer);
                rif.timer = null;
            }
            const ritmo = inPrimoPiano ? intervalloMs : intervalloNascostoMs;
            // Nascosto e nessun ritmo lento richiesto: l'orologio resta fermo. È il caso normale.
            // `null` a pagina visibile = «solo al ritorno»: nemmeno lì si arma niente. Va escluso
            // qui e non lasciato a `setInterval`, che con `null` spara a raffica.
            if (ritmo === undefined || ritmo === null) return;
            rif.timer = setInterval(esegui, ritmo);
        };

        // I due segnali, la loro coalescenza e la cautela nativa stanno in `visibilita-pagina`.
        //
        // ⚠️ `arma()` va rifatto a OGNI transizione, non solo sulle riprese vere: lo sfarfallio
        // visibile→nascosto→visibile dentro la finestra di coalescenza non è una ripresa (e non
        // deve ricaricare niente), ma intanto l'orologio si è fermato e va rimesso.
        const stacca = osservaVisibilita(({ primoPiano, ripresa }) => {
            inPrimoPiano = primoPiano;
            if (primoPiano) {
                if (ripresa) eseguiAlRitorno();
            } else {
                annullaRitentativo();
            }
            arma();
        });

        arma();

        return () => {
            smontato = true;
            if (rif.timer !== null) clearInterval(rif.timer);
            annullaRitentativo();
            stacca();
        };
    }, [attivo, intervalloMs, intervalloNascostoMs, ritentaDopoMs]);
}
