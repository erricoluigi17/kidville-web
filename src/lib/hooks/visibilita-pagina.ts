import { isNativeApp } from '@/lib/push/native-register';
import { logClient } from '@/lib/logging/client';

/**
 * I DUE SEGNALI DI VISIBILITÀ, IN UN MECCANISMO SOLO.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * PERCHÉ DUE SEGNALI E NON UNO. `document.hidden` è lo standard del web, ma questa app gira
 * anche dentro una WebView Capacitor, e non è dato per scontato che `visibilitychange` scatti
 * quando l'app va in secondo piano — su iOS in particolare. Non lo si assume: si montano
 * ENTRAMBI i segnali, così la correttezza non dipende da quale dei due funzioni.
 *
 * Il precedente che impone questa cautela sta in `client.ts`: per 31 giorni il campo
 * `piattaforma` ha detto `web` per 3.625 eventi su 3.626, perché Capacitor NON si scrive nello
 * user-agent e qualcuno l'aveva dedotto invece di chiederlo al bridge.
 *
 * LA COALESCENZA non è un ornamento. I due segnali possono scattare per la STESSA ripresa, e su
 * Android è documentato (`BiometricGate.tsx:33-45`) che arrivi un `isActive:true` spurio, perché
 * l'Activity del prompt biometrico è dichiarata traslucida. Senza coalescenza il risveglio
 * costerebbe due giri invece di uno — cioè proprio il difetto che questo meccanismo toglie. Qui
 * la coalescenza è **strutturale**: lo stato è un booleano, e senza transizione non succede
 * niente. La finestra di tempo è la seconda cintura, contro lo sfarfallio.
 *
 * ─── PERCHÉ È UN MODULO A PARTE (2026-10-12) ───────────────────────────────────
 *
 * Il meccanismo è nato dentro `usePollingVisibile`, che è ancora il suo chiamante principale.
 * Da oggi lo usa anche `ControlloVersione`, che al ritorno in primo piano chiede al server quale
 * rilascio stia servendo. Scriverne un secondo sarebbe stato il modo di farli divergere: due
 * ascoltatori per lo stesso evento, due idee diverse di quando una ripresa è «la stessa
 * ripresa», e l'`isActive:true` spurio di Android contato una volta da uno e due volte
 * dall'altro.
 *
 * ─── LA SONDA, E PERCHÉ ADESSO TACE (S7-D) ─────────────────────────────────────
 *
 * Qui c'era una sonda che segnava, una volta per sessione di pagina e per segnale, QUALE
 * sorgente di visibilità avesse parlato davvero su un dispositivo nativo. Era nata per
 * rispondere con un dato — e non con un'opinione — alla domanda «`visibilitychange` funziona
 * nella WebView iOS?», e parlava anche a cose funzionanti perché «nessun log» non distingue «il
 * segnale arriva» da «la sonda non è mai partita».
 *
 * **Ha risposto.** I due segnali arrivano, e la sonda continuava a scrivere ~1.300 righe al
 * giorno PER TIPO (misurato il 12/10/2026) a livello `warn` — cioè persistite in `app_log`, con
 * il loro peso sulle quote e sul rumore — per riconfermare ogni giorno un fatto già noto. Un
 * canale di osservabilità che ripete una risposta acquisita non è osservabilità: è volume.
 *
 * Resta la riga che dice ciò che NON si sa: il bridge nativo che non risponde (`catch` qui
 * sotto). Lì il silenzio significherebbe reggersi sul solo `visibilitychange` senza saperlo, e
 * un `catch` che non logga è un bug (AGENTS, regola 6).
 * ─────────────────────────────────────────────────────────────────────────────────
 */

/** Due segnali per la stessa ripresa entro questa finestra contano come uno. */
export const FINESTRA_COALESCENZA_MS = 1_000;

export interface CambioVisibilita {
    /** La pagina è in primo piano ADESSO. */
    primoPiano: boolean;
    /**
     * Una RIPRESA vera: transizione verso il primo piano, fuori dalla finestra di coalescenza.
     *
     * È diversa da `primoPiano === true`, e la differenza serve: chi deve RICARICARE qualcosa
     * guarda `ripresa`, chi deve riarmare un orologio guarda `primoPiano` — e lo deve fare a
     * OGNI transizione, compreso lo sfarfallio che non produce una ripresa.
     */
    ripresa: boolean;
    /**
     * Da quanti millisecondi la pagina era nascosta, `0` se non era nascosta.
     *
     * ⚠️ È UNA STIMA PER DIFETTO quando la pagina era GIÀ nascosta al momento in cui si comincia
     * a osservare: lì l'istante in cui è sparita non lo sa nessuno, e si conta dall'inizio
     * dell'osservazione. Il verso dell'errore è quello giusto per chi decide se ricaricare:
     * sottostimare l'assenza fa ricaricare MENO, mai di più.
     */
    nascostaDaMs: number;
}

/**
 * Osserva la visibilità della pagina e annuncia ogni TRANSIZIONE. Restituisce la funzione che
 * stacca tutto.
 *
 * Non fa niente di suo al momento del montaggio: non è un «al primo giro esegui», è un
 * osservatore. Chi ha bisogno del primo caricamento se lo fa.
 */
export function osservaVisibilita(suCambio: (cambio: CambioVisibilita) => void): () => void {
    const nativo = isNativeApp();
    let inPrimoPiano = !document.hidden;
    /** Da quando la pagina è nascosta, o `null` se è in primo piano. */
    let nascostaDa: number | null = inPrimoPiano ? null : Date.now();
    let ultimaRipresa = 0;
    let smontato = false;
    let agganciatoNativo: { remove: () => Promise<void> } | null = null;

    /** L'unico punto in cui i due segnali confluiscono. */
    const aggiorna = (primoPiano: boolean) => {
        // Nessuna transizione ⇒ niente da fare. Qui vive la coalescenza fra i due segnali.
        if (primoPiano === inPrimoPiano) return;
        inPrimoPiano = primoPiano;

        if (!primoPiano) {
            nascostaDa = Date.now();
            suCambio({ primoPiano: false, ripresa: false, nascostaDaMs: 0 });
            return;
        }

        const ora = Date.now();
        const nascostaDaMs = nascostaDa === null ? 0 : ora - nascostaDa;
        const ripresa = ora - ultimaRipresa >= FINESTRA_COALESCENZA_MS;
        if (ripresa) ultimaRipresa = ora;
        // `nascostaDa` NON si azzera qui: un secondo giro dentro la finestra di coalescenza
        // riporterebbe altrimenti l'assenza a ~0 — e dopo un'ora in tasca basterebbe uno
        // sfarfallio per far sembrare l'app appena riaperta.
        suCambio({ primoPiano: true, ripresa, nascostaDaMs });
        if (ripresa) nascostaDa = null;
    };

    const suVisibilita = () => aggiorna(!document.hidden);
    document.addEventListener('visibilitychange', suVisibilita);

    if (nativo) {
        void (async () => {
            try {
                const { App } = await import('@capacitor/app');
                const h = await App.addListener('appStateChange', ({ isActive }) => aggiorna(isActive));
                // Lo smontaggio può avvenire mentre l'import è in volo: senza questo controllo
                // l'ascoltatore resterebbe agganciato a un componente che non c'è più.
                if (smontato) {
                    void h.remove();
                    return;
                }
                agganciatoNativo = h;
            } catch {
                // Il plugin manca o il bridge non risponde: si resta col solo `visibilitychange`,
                // che è comunque il segnale standard. Non è silenzioso — ed è l'unica cosa che
                // questo canale non sa ancora: su quale dei due segnali ci si stia reggendo.
                logClient({
                    livello: 'warn',
                    evento: 'visibilita',
                    messaggio: 'appStateChange non disponibile: solo visibilitychange',
                });
            }
        })();
    }

    return () => {
        smontato = true;
        document.removeEventListener('visibilitychange', suVisibilita);
        void agganciatoNativo?.remove();
    };
}
