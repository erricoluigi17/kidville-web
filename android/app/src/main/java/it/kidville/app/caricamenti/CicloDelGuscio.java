package it.kidville.app.caricamenti;

import it.kidville.app.caricamenti.EsecutoreCoda.EsitoCiclo;
import it.kidville.app.caricamenti.EsecutoreCoda.Presentazione;

import java.util.function.BooleanSupplier;

/**
 * IL CICLO, COME LO VEDE UN GUSCIO: il thread di lavoro del job UIDT (API ≥ 34) o del lavoro di WorkManager (API 24-33) fa girare
 * l'esecutore e, se un ciclo precedente sta ANCORA USCENDO, lo aspetta e riparte da dove quello ha lasciato, invece di chiudere il job
 * «senza lavoro». Logica pura, senza `android.*`: la provano i test sulla JVM, e i due gusci (che sulla JVM non si istanziano) la usano.
 * (spec 2026-10-03 «app 1.2: caricamenti nativi in background», §6.2; secondario n. 76 della PR 3)
 *
 * ─── LA SVEGLIA CHE SI PERDEVA (n. 76) ───────────────────────────────────────────────────────
 * Quando il sistema ferma un guscio (`onStopJob`, `onStopped`) chiama `ferma()`: la PUT in volo si interrompe e il ciclo esce con
 * `INTERROTTO`, lasciando le voci `in-attesa` `RETE`. Ma non esce subito: `ferma()` non interrompe un rinnovo già partito (fino a 15 s
 * di connessione e 30 s di lettura) né il passo di due secondi dell'attesa della rete. Se il sistema RIAVVIA il guscio in quei secondi
 * (la rete è tornata subito) il thread nuovo trova l'esecutore ancora attivo, `GIA_ATTIVO`, e prima di questa classe il guscio
 * rispondeva «niente da fare»: il job si chiudeva senza riprogrammarsi, il ciclo vecchio finiva `INTERROTTO`, e le voci restavano
 * ferme senza nessun guscio, in silenzio (la notifica del job si toglie da sola), fino alla prossima apertura dell'app o al prossimo
 * `accodaVideo`.
 *
 * ─── COME SI RISOLVE ─────────────────────────────────────────────────────────────────────────
 * `GIA_ATTIVO` qui non è una risposta: è un «riprova fra poco». Si aspetta a passi di due secondi (il tetto è {@link #ATTESA_MASSIMA_MS},
 * più dei 45 s che un rinnovo può far durare l'uscita del ciclo vecchio) e si richiama l'esecutore, che appena l'altro ha finito parte e
 * prosegue: il job resta VIVO, con la sua notifica, e le voci rimaste ripartono senza che nessuno riapra niente. Se dopo il tetto l'altro
 * ciclo c'è ancora, si restituisce `GIA_ATTIVO` e il guscio chiede al sistema di richiamarlo ({@link #serveUnaRipresa}): l'ultima rete
 * di sicurezza, non il caso normale.
 *
 * Si smette di aspettare appena il sistema ferma ANCHE questo guscio (`fermato`): in quel caso il ciclo non deve partire su un job che
 * non esiste più, e la riprogrammazione la fa già il sistema (`onStopJob` ha detto `true`).
 */
final class CicloDelGuscio {

    /** Ogni quanto si riprova se un altro ciclo sta ancora uscendo: lo stesso passo con cui l'esecutore aspetta la rete. */
    static final long PASSO_DI_ATTESA_MS = EsecutoreCoda.PASSO_ATTESA_RETE_MS;

    /**
     * Per quanto si aspetta che un altro ciclo finisca di uscire: due minuti. Il caso peggiore è un rinnovo in volo (15 s + 30 s) più il
     * passo dell'attesa della rete (2 s); il resto è margine. Oltre, c'è qualcosa che non finisce: ci pensa il sistema, riprogrammando.
     */
    static final long ATTESA_MASSIMA_MS = 120_000L;

    /** L'esecutore, visto dal guscio: in produzione `PianificatoreCaricamenti::eseguiSuGuscio`. */
    interface MotoreDelGuscio {
        EsitoCiclo eseguiSuGuscio(Presentazione presentazione, long attesaReteMassimaMs);
    }

    /** Come si aspetta: in produzione `Thread::sleep`, nei test un finto che sposta un orologio. */
    interface Pausa {
        void dormi(long ms) throws InterruptedException;
    }

    private CicloDelGuscio() {
    }

    /**
     * Fa girare il ciclo e restituisce come è finito. Blocca finché c'è lavoro.
     *
     * @param fermato vero quando il sistema ha fermato QUESTA esecuzione del guscio (per esecuzione, non per istanza: un guscio che il
     *                sistema riavvia non deve ereditare la fermata del precedente)
     * @return `FINITO`, `RIPROVA` (rete mancata oltre il tetto), `INTERROTTO` (il guscio è stato fermato, o il thread interrotto) oppure
     *         `GIA_ATTIVO` se un altro ciclo non ha finito di uscire entro {@link #ATTESA_MASSIMA_MS}
     */
    static EsitoCiclo esegui(MotoreDelGuscio motore, Presentazione presentazione, long attesaReteMassimaMs, BooleanSupplier fermato,
                             Pausa pausa) {
        // Il sistema ha già fermato il guscio prima ancora che il ciclo partisse: non si parte (e lo riprogramma lui).
        if (fermato.getAsBoolean()) return EsitoCiclo.INTERROTTO;
        long atteso = 0L;
        boolean detto = false;
        for (;;) {
            EsitoCiclo esito = motore.eseguiSuGuscio(presentazione, attesaReteMassimaMs);
            if (esito != EsitoCiclo.GIA_ATTIVO) return esito;
            if (atteso >= ATTESA_MASSIMA_MS) {
                DiagnosticaLocale.avviso("un altro ciclo non ha finito di uscire entro il tetto: si chiede una ripresa al sistema");
                return esito;
            }
            if (!detto) {
                detto = true;
                DiagnosticaLocale.info("un altro ciclo sta ancora uscendo: si aspetta e si riparte da dove ha lasciato");
            }
            try {
                pausa.dormi(PASSO_DI_ATTESA_MS);
            } catch (InterruptedException interrotto) {
                // Il thread è stato interrotto: si esce senza partire, e la bandiera di interruzione resta alzata per chi sta sopra.
                Thread.currentThread().interrupt();
                return EsitoCiclo.INTERROTTO;
            }
            atteso += PASSO_DI_ATTESA_MS;
            if (fermato.getAsBoolean()) return EsitoCiclo.INTERROTTO;
        }
    }

    /**
     * Il guscio deve chiedere al sistema di richiamarlo? Vero se la rete è mancata oltre il tetto (`RIPROVA`) o se un altro ciclo non ha mai
     * finito di uscire (`GIA_ATTIVO`): in entrambi i casi ci sono voci vive e nessuno che le guardi. Falso per `FINITO` e per `INTERROTTO`
     * (a fermare il guscio è stato il sistema, che lo riprogramma da sé).
     */
    static boolean serveUnaRipresa(EsitoCiclo esito) {
        return esito == EsitoCiclo.RIPROVA || esito == EsitoCiclo.GIA_ATTIVO;
    }
}
