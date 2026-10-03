package it.kidville.app.caricamenti;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import it.kidville.app.caricamenti.CodaCaricamenti.Testi;
import it.kidville.app.caricamenti.NotificheCaricamento.Situazione;

import org.junit.Test;

/**
 * Le due scelte delle notifiche che si possono giudicare sulla JVM (spec §2.2, §6.1; compito A2): quale TESTO per quale situazione e
 * quanta BARRA. Costruire la notifica vera tocca `NotificationManager` e il canale, e si prova sul telefono (C1, E1).
 */
public class NotificheCaricamentoTest {

    private static final Testi TESTI = new Testi("Kidville", "Invio dei video in corso", "Il video è in attesa di rete: riprenderà da solo",
            "Invio in pausa: tocca per riprendere");

    @Test
    public void ilTestoDipendeDallaSituazioneENonPortaMaiNomi() {
        assertEquals("Invio dei video in corso", NotificheCaricamento.testoPer(Situazione.INVIO, TESTI));
        assertEquals("Il video è in attesa di rete: riprenderà da solo", NotificheCaricamento.testoPer(Situazione.ATTESA_RETE, TESTI));
        assertNotEquals(NotificheCaricamento.testoPer(Situazione.INVIO, TESTI), NotificheCaricamento.testoPer(Situazione.ATTESA_RETE, TESTI));
    }

    @Test
    public void iTestiDiRipiegoSonoQuelliDellaSpecESenzaNomi() {
        Testi ripiego = Testi.predefiniti();
        assertEquals("Kidville", ripiego.titolo);
        assertEquals("Invio dei video in corso", NotificheCaricamento.testoPer(Situazione.INVIO, ripiego));
        assertEquals("Il video è in attesa di rete: riprenderà da solo", NotificheCaricamento.testoPer(Situazione.ATTESA_RETE, ripiego));
        assertEquals("Invio in pausa: tocca per riprendere", ripiego.pausa);
    }

    @Test
    public void laPercentualeStaFra0E100EIndeterminataSenzaTotale() {
        assertEquals(0, NotificheCaricamento.percentuale(0, 100));
        assertEquals(50, NotificheCaricamento.percentuale(50, 100));
        assertEquals(100, NotificheCaricamento.percentuale(100, 100));
        assertEquals("33,3 si arrotonda per difetto: la barra non anticipa", 33, NotificheCaricamento.percentuale(1, 3));
        assertEquals(99, NotificheCaricamento.percentuale(999, 1000));
        assertEquals("mai oltre il 100", 100, NotificheCaricamento.percentuale(150, 100));
        assertEquals("mai sotto lo 0", 0, NotificheCaricamento.percentuale(-5, 100));
        assertEquals("senza totale: indeterminata", -1, NotificheCaricamento.percentuale(10, 0));
        assertEquals(-1, NotificheCaricamento.percentuale(10, -4));
    }

    @Test
    public void laPercentualeRegge2GBEUnTotaleEnormeSenzaTraboccare() {
        assertEquals(99, NotificheCaricamento.percentuale(1_999_999_999L, 2_000_000_000L));
        assertEquals(100, NotificheCaricamento.percentuale(2_000_000_000L, 2_000_000_000L));
        assertEquals(50, NotificheCaricamento.percentuale(1_000_000_000L, 2_000_000_000L));
        int enorme = NotificheCaricamento.percentuale(Long.MAX_VALUE / 2, Long.MAX_VALUE);
        assertTrue("su un totale enorme resta una percentuale vera: " + enorme, enorme >= 49 && enorme <= 50);
        assertEquals(100, NotificheCaricamento.percentuale(Long.MAX_VALUE, Long.MAX_VALUE));
    }

    @Test
    public void leNotificheHannoIdECanaleFissi() {
        assertEquals("kidville_caricamenti", NotificheCaricamento.ID_CANALE);
        assertFalse(NotificheCaricamento.ID_NOTIFICA_INVIO == NotificheCaricamento.ID_NOTIFICA_PAUSA);
    }
}
