package it.kidville.app.caricamenti;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import androidx.work.ListenableWorker.Result;

import it.kidville.app.caricamenti.CodaCaricamenti.Testi;
import it.kidville.app.caricamenti.EsecutoreCoda.EsitoCiclo;
import it.kidville.app.caricamenti.NotificheCaricamento.Situazione;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Il guscio di WorkManager (spec §6.2; compito A2b, secondari n. 80 e n. 91 della PR 3): ciò che si può provare sulla JVM senza un telefono.
 * Il lavoro vero non si istanzia (ha bisogno di un `Context` e dei parametri di WorkManager), ma ciò che decide è fatto di funzioni statiche
 * e di una presentazione con la sua guardia, e quelle girano.
 */
public class LavoroCaricamentiTest {

    private static final Testi TESTI = new Testi("Kidville", "Invio dei video in corso", "Il video è in attesa di rete: riprenderà da solo",
            "Invio in pausa: tocca per riprendere");

    /* ────────────────────────────────────────────────────────────────────────────
     * N. 80: DOPO UNA RETE MANCATA SI ACCODA UNA RIPRESA, NON SI CHIEDE UN RITENTATIVO CON BACKOFF
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void unCicloFinitoOInterrottoFinisceConSuccessoSenzaAccodareNiente() {
        for (EsitoCiclo esito : new EsitoCiclo[]{EsitoCiclo.FINITO, EsitoCiclo.INTERROTTO}) {
            AtomicInteger accodamenti = new AtomicInteger();
            Result r = LavoroCaricamenti.risultatoPer(esito, () -> {
                accodamenti.incrementAndGet();
                return true;
            });
            assertTrue(esito.name(), r instanceof Result.Success);
            assertEquals(esito.name() + ": niente da riprendere", 0, accodamenti.get());
        }
    }

    @Test
    public void laReteMancataOltreIlTettoAccodaUnaRipresaEFinisceConSuccessoSenzaIlBackoffDiWorkManager() {
        for (EsitoCiclo esito : new EsitoCiclo[]{EsitoCiclo.RIPROVA, EsitoCiclo.GIA_ATTIVO}) {
            AtomicInteger accodamenti = new AtomicInteger();
            Result r = LavoroCaricamenti.risultatoPer(esito, () -> {
                accodamenti.incrementAndGet();
                return true;
            });
            assertTrue(esito.name() + ": `Result.success()`, non `Result.retry()` (il cui backoff arriva a 5 ore)", r instanceof Result.Success);
            assertEquals(esito.name() + ": una ripresa accodata, una sola", 1, accodamenti.get());
        }
    }

    @Test
    public void seLaRipresaNonSiRiesceAdAccodareSiRipiegaSulRitentativoDelSistema() {
        for (EsitoCiclo esito : new EsitoCiclo[]{EsitoCiclo.RIPROVA, EsitoCiclo.GIA_ATTIVO}) {
            Result r = LavoroCaricamenti.risultatoPer(esito, () -> false);
            assertTrue(esito.name(), r instanceof Result.Retry);
        }
    }

    @Test
    public void ilTettoDellaReteDelLavoroEQuelloDiDieciMinutiDiPolitica() {
        assertEquals(600_000L, LavoroCaricamenti.ATTESA_RETE_MASSIMA_MS);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * N. 91: LA NOTIFICA DEL SERVIZIO NON SI RIPUBBLICA A LAVORO FERMATO
     * ──────────────────────────────────────────────────────────────────────────── */

    private static final class Notificatore implements PresentazioneDelLavoro.Notificatore {
        final List<String> chiamate = new ArrayList<>();

        @Override
        public void aggiornaInvio(Testi testi, Situazione situazione, long inviati, long totale) {
            chiamate.add(situazione + ":" + inviati + "/" + totale);
        }
    }

    @Test
    public void fincheIlLavoroGiraLaNotificaSiAggiornaConIlTestoGiusto() {
        Notificatore notifiche = new Notificatore();
        PresentazioneDelLavoro p = new PresentazioneDelLavoro(notifiche, TESTI, () -> false);
        p.avanzamento(2_500L, 5_000L, 2_500L);
        p.inAttesaDiRete(true);
        p.inAttesaDiRete(false);
        assertEquals(java.util.Arrays.asList("INVIO:2500/5000", "ATTESA_RETE:0/0", "INVIO:0/0"), notifiche.chiamate);
    }

    @Test
    public void aLavoroFermatoNonSiRipubblicaPiuNienteLaNotificaOrfanaDelSecondarioNovantuno() {
        Notificatore notifiche = new Notificatore();
        AtomicBoolean fermato = new AtomicBoolean(false);
        PresentazioneDelLavoro p = new PresentazioneDelLavoro(notifiche, TESTI, fermato::get);
        p.avanzamento(1_000L, 5_000L, 1_000L);
        assertEquals(1, notifiche.chiamate.size());

        fermato.set(true);                                 // WorkManager ferma il lavoro: il servizio toglie la notifica
        p.avanzamento(2_000L, 5_000L, 2_000L);              // il ciclo, che sta ancora uscendo, continua a chiamare...
        p.inAttesaDiRete(true);
        p.inAttesaDiRete(false);                           // ...e chiudiIlGiro chiama anche questo, all'uscita

        assertEquals("nessun `notify` dopo la fermata: la notifica ongoing non si ripubblica", 1, notifiche.chiamate.size());
        assertFalse(notifiche.chiamate.toString().contains("2000"));
    }

    @Test
    public void unLavoroGiaFermatoNonPubblicaNemmenoLaPrimaVolta() {
        Notificatore notifiche = new Notificatore();
        PresentazioneDelLavoro p = new PresentazioneDelLavoro(notifiche, TESTI, () -> true);
        p.avanzamento(1L, 2L, 1L);
        p.inAttesaDiRete(true);
        assertTrue(notifiche.chiamate.isEmpty());
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL CABLAGGIO DEL LAVORO (`doWork` non si esegue sulla JVM: si prova che il codice chiami ciò che deve)
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void doWorkFaGirareIlCicloDalCorpoProvatoConLaGuardiaDellaFermataERispondeConLaFunzioneProvata() throws Exception {
        String corpo = SorgentiDiProva.corpoDi(SorgentiDiProva.codiceSenzaCommenti("LavoroCaricamenti"), "public Result doWork()");
        assertTrue("il ciclo passa dal corpo che aspetta un ciclo precedente che sta uscendo (n. 76)", corpo.contains("CicloDelGuscio.esegui(motore::eseguiSuGuscio"));
        assertTrue("la presentazione ha la guardia `isStopped` (n. 91)", corpo.contains("new PresentazioneDelLavoro(notifiche::aggiornaInvio, testi, fermato)"));
        assertTrue("e `fermato` è `isStopped`", corpo.contains("fermato = this::isStopped"));
        assertTrue("la risposta a WorkManager viene dalla funzione provata, che accoda la ripresa con rete (n. 80)",
                corpo.contains("return risultatoPer(esito, motore::programmaRipresaConRete);"));
        assertFalse("il vecchio `esito == EsitoCiclo.RIPROVA ? Result.retry()` non c'è più: il backoff di WorkManager arriva a 5 ore", corpo.contains("EsitoCiclo.RIPROVA"));
    }
}
