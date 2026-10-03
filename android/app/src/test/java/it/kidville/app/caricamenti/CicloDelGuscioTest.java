package it.kidville.app.caricamenti;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import it.kidville.app.caricamenti.EsecutoreCoda.EsitoCiclo;

import org.junit.Test;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Deque;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Il ciclo come lo vede un guscio (spec §6.2; compito A2b, secondario n. 76 della PR 3): se il sistema riavvia il job mentre il ciclo
 * precedente sta ancora uscendo, il thread nuovo trova l'esecutore `GIA_ATTIVO`. Prima rispondeva «niente da fare», chiudeva il job senza
 * riprogrammarlo e lasciava le voci ferme senza nessun guscio, in silenzio; adesso aspetta che l'altro finisca e riparte.
 *
 * Il «motore» è un finto che risponde a copione e un orologio che si sposta a comando: l'attesa è un'addizione.
 */
public class CicloDelGuscioTest {

    private static final long TETTO_RETE_MS = 600_000L;

    /** Un motore che risponde a copione, ricorda quante volte l'hanno chiamato, e (se serve) fa qualcosa a ogni chiamata. */
    private static final class FintoMotore implements CicloDelGuscio.MotoreDelGuscio {
        final Deque<EsitoCiclo> copione = new ArrayDeque<>();
        final List<Long> tettiVisti = new ArrayList<>();
        int chiamate = 0;
        EsitoCiclo quandoFinisceIlCopione = EsitoCiclo.FINITO;
        Runnable allaChiamata = null;

        FintoMotore poi(EsitoCiclo... esiti) {
            copione.addAll(Arrays.asList(esiti));
            return this;
        }

        @Override
        public EsitoCiclo eseguiSuGuscio(EsecutoreCoda.Presentazione presentazione, long attesaReteMassimaMs) {
            chiamate++;
            tettiVisti.add(attesaReteMassimaMs);
            if (allaChiamata != null) allaChiamata.run();
            EsitoCiclo prossimo = copione.pollFirst();
            return prossimo != null ? prossimo : quandoFinisceIlCopione;
        }
    }

    /** Una pausa che non aspetta: somma il tempo che le si chiede di dormire. */
    private static final class PausaFinta implements CicloDelGuscio.Pausa {
        final AtomicLong dormitoMs = new AtomicLong();
        int volte = 0;
        Runnable dopoOgniPausa = null;

        @Override
        public void dormi(long ms) {
            volte++;
            dormitoMs.addAndGet(ms);
            if (dopoOgniPausa != null) dopoOgniPausa.run();
        }
    }

    private static EsitoCiclo esegui(FintoMotore motore, PausaFinta pausa, AtomicBoolean fermato) {
        return CicloDelGuscio.esegui(motore, null, TETTO_RETE_MS, fermato::get, pausa);
    }

    @Test
    public void unCicloCheFinisceSiRestituisceSubitoSenzaAspettareNiente() {
        FintoMotore motore = new FintoMotore().poi(EsitoCiclo.FINITO);
        PausaFinta pausa = new PausaFinta();
        assertSame(EsitoCiclo.FINITO, esegui(motore, pausa, new AtomicBoolean(false)));
        assertEquals(1, motore.chiamate);
        assertEquals("nessuna attesa", 0, pausa.volte);
        assertEquals("il tetto della rete arriva al motore com'è", Arrays.asList(TETTO_RETE_MS), motore.tettiVisti);
    }

    @Test
    public void riprovaEInterrottoPassanoInvariatiSenzaAspettare() {
        for (EsitoCiclo esito : new EsitoCiclo[]{EsitoCiclo.RIPROVA, EsitoCiclo.INTERROTTO}) {
            FintoMotore motore = new FintoMotore().poi(esito);
            PausaFinta pausa = new PausaFinta();
            assertSame(esito, esegui(motore, pausa, new AtomicBoolean(false)));
            assertEquals(esito.name(), 1, motore.chiamate);
            assertEquals(esito.name(), 0, pausa.volte);
        }
    }

    /** IL CASO DEL SECONDARIO N. 76: l'altro ciclo sta uscendo, il job nuovo aspetta, riparte, e porta a termine il lavoro rimasto. */
    @Test
    public void unCicloPrecedenteCheStaUscendoSiAspettaESiRiparteInveceDiChiudereIlJobSenzaLavoro() {
        FintoMotore motore = new FintoMotore().poi(EsitoCiclo.GIA_ATTIVO, EsitoCiclo.GIA_ATTIVO, EsitoCiclo.GIA_ATTIVO, EsitoCiclo.FINITO);
        PausaFinta pausa = new PausaFinta();
        EsitoCiclo esito = esegui(motore, pausa, new AtomicBoolean(false));
        assertSame("il lavoro rimasto è stato fatto: il job può chiudersi senza chiedere altro", EsitoCiclo.FINITO, esito);
        assertEquals("tre «già attivo» e poi il ciclo vero", 4, motore.chiamate);
        assertEquals("si è aspettato fra un tentativo e l'altro", 3, pausa.volte);
        assertEquals(3 * CicloDelGuscio.PASSO_DI_ATTESA_MS, pausa.dormitoMs.get());
        assertFalse("e un ciclo finito non chiede una ripresa", CicloDelGuscio.serveUnaRipresa(esito));
    }

    @Test
    public void lAttesaDiUnCicloPrecedenteSiDiceUnaVoltaSolaInLogcatEQuandoSiRinunciaSiDiceConUnAvviso() {
        try (RigheDiLogcat logcat = new RigheDiLogcat()) {
            FintoMotore motore = new FintoMotore().poi(EsitoCiclo.GIA_ATTIVO, EsitoCiclo.GIA_ATTIVO, EsitoCiclo.GIA_ATTIVO, EsitoCiclo.FINITO);
            esegui(motore, new PausaFinta(), new AtomicBoolean(false));
            assertEquals("tre attese, una riga sola: si dice quando comincia", Arrays.asList(
                    "I KidvilleCaricamenti un altro ciclo sta ancora uscendo: si aspetta e si riparte da dove ha lasciato"), new ArrayList<>(logcat.righe));
        }
        try (RigheDiLogcat logcat = new RigheDiLogcat()) {
            FintoMotore sempreAttivo = new FintoMotore();
            sempreAttivo.quandoFinisceIlCopione = EsitoCiclo.GIA_ATTIVO;
            esegui(sempreAttivo, new PausaFinta(), new AtomicBoolean(false));
            assertEquals(Arrays.asList(
                    "I KidvilleCaricamenti un altro ciclo sta ancora uscendo: si aspetta e si riparte da dove ha lasciato",
                    "W KidvilleCaricamenti un altro ciclo non ha finito di uscire entro il tetto: si chiede una ripresa al sistema"), new ArrayList<>(logcat.righe));
        }
        try (RigheDiLogcat logcat = new RigheDiLogcat()) {
            esegui(new FintoMotore().poi(EsitoCiclo.FINITO), new PausaFinta(), new AtomicBoolean(false));
            assertTrue("un ciclo che parte subito non dice niente", logcat.righe.isEmpty());
        }
    }

    @Test
    public void ilCicloCheRipartePuoFinireInOgniModoEQuelloVieneRestituito() {
        for (EsitoCiclo finale : new EsitoCiclo[]{EsitoCiclo.RIPROVA, EsitoCiclo.INTERROTTO, EsitoCiclo.FINITO}) {
            FintoMotore motore = new FintoMotore().poi(EsitoCiclo.GIA_ATTIVO, finale);
            assertSame(finale, esegui(motore, new PausaFinta(), new AtomicBoolean(false)));
            assertEquals(2, motore.chiamate);
        }
    }

    @Test
    public void unCicloCheNonFiniscePiuDelTettoLasciaGiaAttivoEIlGuscioChiedeUnaRipresa() {
        FintoMotore motore = new FintoMotore();
        motore.quandoFinisceIlCopione = EsitoCiclo.GIA_ATTIVO;
        PausaFinta pausa = new PausaFinta();
        EsitoCiclo esito = esegui(motore, pausa, new AtomicBoolean(false));
        assertSame(EsitoCiclo.GIA_ATTIVO, esito);
        assertEquals("si è aspettato il tetto, né più né meno", CicloDelGuscio.ATTESA_MASSIMA_MS, pausa.dormitoMs.get());
        assertEquals("un tentativo in più dei passi di attesa", CicloDelGuscio.ATTESA_MASSIMA_MS / CicloDelGuscio.PASSO_DI_ATTESA_MS + 1, motore.chiamate);
        assertTrue("è l'ultima rete di sicurezza: il sistema richiama il guscio", CicloDelGuscio.serveUnaRipresa(esito));
    }

    @Test
    public void ilTettoDiAttesaCopreIlCasoPeggioreDiUnRinnovoInVolo() {
        // Un rinnovo già partito non si interrompe: fino a 15 s di connessione e 30 s di lettura, più il passo dell'attesa della rete (2 s).
        long casoPeggioreMs = (RinnovoFirma.TIMEOUT_CONNESSIONE_MS + RinnovoFirma.TIMEOUT_LETTURA_MS) + EsecutoreCoda.PASSO_ATTESA_RETE_MS;
        assertTrue("il tetto (" + CicloDelGuscio.ATTESA_MASSIMA_MS + " ms) sta sopra l'uscita più lenta (" + casoPeggioreMs + " ms)",
                CicloDelGuscio.ATTESA_MASSIMA_MS > casoPeggioreMs);
        assertEquals("e il passo è quello con cui l'esecutore aspetta la rete", EsecutoreCoda.PASSO_ATTESA_RETE_MS, CicloDelGuscio.PASSO_DI_ATTESA_MS);
    }

    @Test
    public void unGuscioGiaFermatoNonFaPartireIlCicloEIlSistemaLoRiprogramma() {
        FintoMotore motore = new FintoMotore().poi(EsitoCiclo.FINITO);
        PausaFinta pausa = new PausaFinta();
        EsitoCiclo esito = esegui(motore, pausa, new AtomicBoolean(true));
        assertSame(EsitoCiclo.INTERROTTO, esito);
        assertEquals("il ciclo non è partito su un job che non esiste più", 0, motore.chiamate);
        assertFalse("e non si chiede una ripresa: lo riprogramma il sistema (onStopJob ha detto `true`)", CicloDelGuscio.serveUnaRipresa(esito));
    }

    @Test
    public void seIlSistemaFermaQuestoGuscioMentreSiAspettaSiSmetteDiAspettareESiNonRiparte() {
        FintoMotore motore = new FintoMotore();
        motore.quandoFinisceIlCopione = EsitoCiclo.GIA_ATTIVO;
        PausaFinta pausa = new PausaFinta();
        AtomicBoolean fermato = new AtomicBoolean(false);
        pausa.dopoOgniPausa = () -> {
            if (pausa.volte == 2) fermato.set(true);       // il sistema ferma anche il job nuovo
        };
        EsitoCiclo esito = esegui(motore, pausa, fermato);
        assertSame(EsitoCiclo.INTERROTTO, esito);
        assertEquals("due tentativi, due pause, poi basta", 2, motore.chiamate);
        assertEquals(2, pausa.volte);
    }

    @Test
    public void unThreadInterrottoEsceSenzaPartireELasciaLaBandieraAlzata() {
        FintoMotore motore = new FintoMotore();
        motore.quandoFinisceIlCopione = EsitoCiclo.GIA_ATTIVO;
        CicloDelGuscio.Pausa cheLancia = ms -> {
            throw new InterruptedException("fermato");
        };
        try {
            EsitoCiclo esito = CicloDelGuscio.esegui(motore, null, TETTO_RETE_MS, () -> false, cheLancia);
            assertSame(EsitoCiclo.INTERROTTO, esito);
            assertEquals(1, motore.chiamate);
            assertTrue("chi sta sopra deve poter vedere che il thread è stato interrotto", Thread.currentThread().isInterrupted());
        } finally {
            Thread.interrupted();                          // la bandiera non deve sporcare i test dopo
        }
    }

    @Test
    public void laRipresaSiChiedeSoloQuandoCeLavoroSenzaNessunoCheLoGuardi() {
        assertTrue("la rete è mancata oltre il tetto", CicloDelGuscio.serveUnaRipresa(EsitoCiclo.RIPROVA));
        assertTrue("un altro ciclo non finisce mai di uscire", CicloDelGuscio.serveUnaRipresa(EsitoCiclo.GIA_ATTIVO));
        assertFalse("tutto spedito", CicloDelGuscio.serveUnaRipresa(EsitoCiclo.FINITO));
        assertFalse("fermato dal sistema, che lo riprogramma da sé", CicloDelGuscio.serveUnaRipresa(EsitoCiclo.INTERROTTO));
    }

    @Test
    public void laPresentazioneArrivaAlMotoreSenzaEssereTrasformata() {
        FintoMotore motore = new FintoMotore().poi(EsitoCiclo.FINITO);
        final EsecutoreCoda.Presentazione[] vista = new EsecutoreCoda.Presentazione[1];
        motore.allaChiamata = null;
        EsecutoreCoda.Presentazione presentazione = new EsecutoreCoda.Presentazione() {
            @Override
            public void avanzamento(long inviatiVoce, long totaleVoce, long inviatiNelGiro) {
            }

            @Override
            public void inAttesaDiRete(boolean inAttesa) {
            }
        };
        CicloDelGuscio.MotoreDelGuscio registrante = (p, tetto) -> {
            vista[0] = p;
            return EsitoCiclo.FINITO;
        };
        CicloDelGuscio.esegui(registrante, presentazione, TETTO_RETE_MS, () -> false, ms -> {
        });
        assertNotNull(vista[0]);
        assertSame(presentazione, vista[0]);
    }
}
