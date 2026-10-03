package it.kidville.app.caricamenti;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotSame;
import static org.junit.Assert.assertSame;

import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * La diagnostica locale (AGENTS.md, «Logging obbligatorio», regole 6 e 9; secondario n. 84 della PR 3): le righe di logcat dei `catch`
 * ignorabili. Si prova che arrivino al tag del pacchetto ai tre livelli, che portino solo la classe di un'eccezione, e che non rompano
 * mai chi le scrive: se logcat lancia (e sulla JVM di JUnit `android.util.Log` lancia «not mocked») la riga si perde e si conta.
 */
public class DiagnosticaLocaleTest {

    @Test
    public void leRigheArrivanoAlTagDelPacchettoAiTreLivelli() {
        try (RigheDiLogcat logcat = new RigheDiLogcat()) {
            DiagnosticaLocale.info("una");
            DiagnosticaLocale.avviso("due");
            DiagnosticaLocale.errore("tre");
            assertEquals(Arrays.asList("I KidvilleCaricamenti una", "W KidvilleCaricamenti due", "E KidvilleCaricamenti tre"), new ArrayList<>(logcat.righe));
        }
        assertEquals("KidvilleCaricamenti", DiagnosticaLocale.TAG);
    }

    @Test
    public void ilNomeDiUnaEccezioneEIlSoloNomeSempliceDellaClasseMaiIlMessaggio() {
        assertEquals("IllegalStateException", DiagnosticaLocale.classe(new IllegalStateException("/data/privato/video.mp4")));
        assertEquals("IOException", DiagnosticaLocale.classe(new java.io.IOException("token kvr_x")));
        assertEquals("senza causa", DiagnosticaLocale.classe(null));
    }

    @Test
    public void unaUscitaCheLanciaNonRompeChiScriveELaRigaPersaSiConta() {
        DiagnosticaLocale.Uscita cheLancia = new DiagnosticaLocale.Uscita() {
            @Override
            public void info(String tag, String testo) {
                throw new IllegalStateException("not mocked");
            }

            @Override
            public void avviso(String tag, String testo) {
                throw new IllegalStateException("not mocked");
            }

            @Override
            public void errore(String tag, String testo) {
                throw new IllegalStateException("not mocked");
            }
        };
        DiagnosticaLocale.Uscita prima = DiagnosticaLocale.sostituisciUscita(cheLancia);
        try {
            int persePrima = DiagnosticaLocale.righeNonScritte();
            DiagnosticaLocale.info("a");
            DiagnosticaLocale.avviso("b");
            DiagnosticaLocale.errore("c");
            assertEquals("tre righe perse, nessuna eccezione verso chi scrive (fail-open, regola 9)", persePrima + 3, DiagnosticaLocale.righeNonScritte());
        } finally {
            DiagnosticaLocale.sostituisciUscita(prima);
        }
    }

    @Test
    public void conLaUscitaDiProduzioneSullaJvmNonLanciaMai() {
        // Sulla JVM `android.util.Log` lancia «not mocked»: la diagnostica lo assorbe. (Se un giorno i test avessero `returnDefaultValues`
        // la riga andrebbe nel vuoto: in entrambi i casi chi scrive non vede niente.)
        DiagnosticaLocale.Uscita prima = DiagnosticaLocale.sostituisciUscita(null);
        try {
            DiagnosticaLocale.info("x");
            DiagnosticaLocale.avviso("y");
            DiagnosticaLocale.errore("z");
        } finally {
            DiagnosticaLocale.sostituisciUscita(prima);
        }
    }

    @Test
    public void sostituireLUscitaRestituisceQuellaDiPrimaEPassareNullRimetteLogcat() {
        List<String> righe = new ArrayList<>();
        DiagnosticaLocale.Uscita mia = new DiagnosticaLocale.Uscita() {
            @Override
            public void info(String tag, String testo) {
                righe.add(testo);
            }

            @Override
            public void avviso(String tag, String testo) {
            }

            @Override
            public void errore(String tag, String testo) {
            }
        };
        DiagnosticaLocale.Uscita originale = DiagnosticaLocale.sostituisciUscita(mia);
        try {
            DiagnosticaLocale.info("dentro");
            assertEquals(Arrays.asList("dentro"), righe);
            DiagnosticaLocale.Uscita restituita = DiagnosticaLocale.sostituisciUscita(null);
            assertSame("restituisce quella che c'era (la mia)", mia, restituita);
            DiagnosticaLocale.info("fuori");
            assertEquals("con `null` la mia non riceve più niente", Arrays.asList("dentro"), righe);
            assertNotSame(mia, DiagnosticaLocale.sostituisciUscita(originale));
        } finally {
            DiagnosticaLocale.sostituisciUscita(originale);
        }
        assertFalse(righe.contains("fuori"));
    }
}
