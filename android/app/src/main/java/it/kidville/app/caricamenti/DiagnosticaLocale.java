package it.kidville.app.caricamenti;

import android.util.Log;

import java.util.concurrent.atomic.AtomicInteger;

/**
 * LA DIAGNOSTICA LOCALE: le righe che vanno in logcat e basta, col tag del pacchetto. Mai nel registro dei log (`RegistroNativo`): il
 * registro è l'elenco chiuso di §8.2, e questo è il posto per ciò che sta sotto: un guasto che il codice sa assorbire e che chi legge
 * logcat vuole poter vedere.
 * (spec 2026-10-03 «app 1.2: caricamenti nativi in background», §8.1; AGENTS.md, «Logging obbligatorio», regole 6 e 9; secondario n. 84)
 *
 * ─── PERCHÉ ESISTE ───────────────────────────────────────────────────────────────────────────
 * Un `catch` che non dice niente è un guasto che nessuno vedrà mai. Quelli di questo pacchetto che sono DAVVERO ignorabili (chiudere
 * un flusso il cui esito è già noto, staccare una connessione già caduta) si scrivono qui a livello `info`, spiegando perché non
 * contano: la regola 6 vuole una riga, non un commento. Il resto (una scrittura della coda che non riesce, un guscio che aspetta un
 * ciclo che non finisce) sono `avviso` ed `errore`.
 *
 * ─── COME È FATTA ────────────────────────────────────────────────────────────────────────────
 *  · SOLO LA CLASSE, MAI I DATI. Chi chiama passa una frase costante e, al più, il nome SEMPLICE della classe di un'eccezione
 *    ({@link #classe}): il messaggio di un'eccezione può portare un percorso, un indirizzo o il nome di un file, e questo pacchetto
 *    maneggia i video di bambini. Un test scandisce i sorgenti e rifiuta una riga con `getMessage`, un percorso, un indirizzo o un token.
 *  · FAIL-OPEN (regola 9). Il logger non deve mai rompere l'app: se logcat lancia — e nella JVM di JUnit `android.util.Log` lancia
 *    «not mocked» — la riga si perde e si CONTA ({@link #righeNonScritte}), ma il chiamante non lo sa. Un `catch` che chiude una
 *    risorsa e poi scrive qui non può quindi diventare lui un guasto.
 *  · L'USCITA È SOSTITUIBILE ({@link #sostituisciUscita}): i test leggono le righe invece di mandarle a logcat, e provano che il
 *    `catch` le scriva davvero (togliere la riga fa diventare rosso il test).
 */
final class DiagnosticaLocale {

    /** Il tag di tutto il pacchetto. */
    static final String TAG = "KidvilleCaricamenti";

    /** Dove vanno le righe. In produzione è logcat; i test mettono la propria. */
    interface Uscita {
        void info(String tag, String testo);

        void avviso(String tag, String testo);

        void errore(String tag, String testo);
    }

    private static final Uscita LOGCAT = new Uscita() {
        @Override
        public void info(String tag, String testo) {
            Log.i(tag, testo);
        }

        @Override
        public void avviso(String tag, String testo) {
            Log.w(tag, testo);
        }

        @Override
        public void errore(String tag, String testo) {
            Log.e(tag, testo);
        }
    };

    private static volatile Uscita uscita = LOGCAT;

    /** Le righe che l'uscita non ha preso (logcat non disponibile): non cambiano niente per chi chiama, ma si possono contare. */
    private static final AtomicInteger RIGHE_NON_SCRITTE = new AtomicInteger();

    private DiagnosticaLocale() {
    }

    /** Un guasto ignorabile, e perché. Livello `info`. */
    static void info(String testo) {
        try {
            uscita.info(TAG, testo);
        } catch (RuntimeException uscitaNonDisponibile) {
            RIGHE_NON_SCRITTE.incrementAndGet();
        }
    }

    /** Qualcosa che non è andato e che il codice ha assorbito, ma che conviene sapere. Livello `warn`. */
    static void avviso(String testo) {
        try {
            uscita.avviso(TAG, testo);
        } catch (RuntimeException uscitaNonDisponibile) {
            RIGHE_NON_SCRITTE.incrementAndGet();
        }
    }

    /** Un guasto vero. Livello `error`. */
    static void errore(String testo) {
        try {
            uscita.errore(TAG, testo);
        } catch (RuntimeException uscitaNonDisponibile) {
            RIGHE_NON_SCRITTE.incrementAndGet();
        }
    }

    /**
     * Il nome SEMPLICE della classe di un'eccezione, e niente altro: mai il messaggio (può portare un percorso, un indirizzo o il nome di un
     * file). `senza causa` se non ce n'è una.
     */
    static String classe(Throwable causa) {
        return causa == null ? "senza causa" : causa.getClass().getSimpleName();
    }

    /** Quante righe si sono perse perché logcat non rispondeva. */
    static int righeNonScritte() {
        return RIGHE_NON_SCRITTE.get();
    }

    /** SOLO PER I TEST: sostituisce l'uscita e restituisce quella di prima (da rimettere in un `finally`). */
    static Uscita sostituisciUscita(Uscita nuova) {
        Uscita prima = uscita;
        uscita = nuova == null ? LOGCAT : nuova;
        return prima;
    }
}
