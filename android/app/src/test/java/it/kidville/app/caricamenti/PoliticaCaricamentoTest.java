package it.kidville.app.caricamenti;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import it.kidville.app.caricamenti.PoliticaCaricamento.AzionePut;
import it.kidville.app.caricamenti.PoliticaCaricamento.AzioneRinnovo;
import it.kidville.app.caricamenti.PoliticaCaricamento.Codice;
import it.kidville.app.caricamenti.PoliticaCaricamento.CorpoRifiuto;
import it.kidville.app.caricamenti.PoliticaCaricamento.DecisionePut;
import it.kidville.app.caricamenti.PoliticaCaricamento.DecisioneRinnovo;
import it.kidville.app.caricamenti.PoliticaCaricamento.Destinazione;
import it.kidville.app.caricamenti.PoliticaCaricamento.ErroreStorage;
import it.kidville.app.caricamenti.PoliticaCaricamento.EsitoRinnovo;
import it.kidville.app.caricamenti.PoliticaCaricamento.EventoStato;
import it.kidville.app.caricamenti.PoliticaCaricamento.Motore;
import it.kidville.app.caricamenti.PoliticaCaricamento.RispostaRinnovo;
import it.kidville.app.caricamenti.PoliticaCaricamento.Stato;
import it.kidville.app.caricamenti.PoliticaCaricamento.TipoRinnovo;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * La politica dei caricamenti, riga per riga (spec §4.4, §4.5, §3 esiti di S0, §6.2, §9; compito A1).
 *
 * Ogni tabella della spec è qui una tabella di casi. Le tre che rischiano di diventare decorazione sono scritte in modo che
 * sia l'ELENCO a fare da giudice, non il codice: la matrice delle transizioni elenca le sole frecce ammesse e verifica TUTTE
 * le altre combinazioni (una freccia in più o in meno la rompe); gli esiti della PUT passano per tutti gli stati HTTP da 0 a
 * 999; gli host ammessi hanno tanti rifiuti quanti sono i modi di truccare un indirizzo.
 */
public class PoliticaCaricamentoTest {

    /* ────────────────────────────────────────────────────────────────────────────
     * VOCABOLARI
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void gliStatiHannoIValoriDelContrattoNellOrdineDiSpec() {
        List<String> valori = new ArrayList<>();
        for (Stato stato : Stato.values()) valori.add(stato.valore());
        assertEquals(Arrays.asList("in-coda", "in-invio", "in-attesa", "in-pausa", "inviato", "fallito", "annullato"), valori);
    }

    @Test
    public void iCodiciHannoINomiDelContrattoNellOrdineDiSpec() {
        List<String> nomi = new ArrayList<>();
        for (Codice codice : Codice.values()) nomi.add(codice.name());
        assertEquals(Arrays.asList("RETE", "SERVER", "FIRMA_RIFIUTATA", "TOKEN_NON_VALIDO", "TOKEN_SCADUTO", "RINNOVO_CICLICO",
                "TROPPO_GRANDE", "FILE_ASSENTE", "PESO_DIVERSO", "ANNULLATO_DAL_SERVER", "CHIUSURA_FORZATA", "FGS_NON_AVVIABILE",
                "UIDT_NON_PROGRAMMABILE", "INTERNO"), nomi);
    }

    @Test
    public void soloInviatoFallitoAnnullatoSonoTerminali() {
        Set<Stato> terminali = new HashSet<>(Arrays.asList(Stato.INVIATO, Stato.FALLITO, Stato.ANNULLATO));
        for (Stato stato : Stato.values()) {
            assertEquals(stato.valore(), terminali.contains(stato), stato.terminale());
        }
    }

    @Test
    public void daValoreCercaPerNomeEsattoERifiutaIlResto() {
        for (Stato stato : Stato.values()) assertSame(stato, Stato.daValore(stato.valore()));
        for (Codice codice : Codice.values()) assertSame(codice, Codice.daValore(codice.name()));
        assertNull(Stato.daValore("IN_CODA"));
        assertNull(Stato.daValore("In-Coda"));
        assertNull(Stato.daValore(""));
        assertNull(Stato.daValore(null));
        assertNull(Codice.daValore("rete"));
        assertNull(Codice.daValore("NON_ESISTE"));
        assertNull(Codice.daValore(null));
    }

    @Test
    public void iMotoriHannoLeStringheDelContratto() {
        assertEquals("uidt", Motore.UIDT.valore());
        assertEquals("workmanager", Motore.WORKMANAGER.valore());
        assertEquals(2, Motore.values().length);
    }

    @Test
    public void gliEsitiDelRinnovoHannoLeStringheDelLog() {
        List<String> valori = new ArrayList<>();
        for (EsitoRinnovo esito : EsitoRinnovo.values()) valori.add(esito.valore());
        // §8.2: `da-caricare`, `arrivato`, `annullato`, `negato`, `tetto`, `rete`, `server`.
        assertEquals(Arrays.asList("da-caricare", "arrivato", "annullato", "negato", "tetto", "rete", "server"), valori);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * §4.4 — LA MATRICE DELLE TRANSIZIONI
     * ──────────────────────────────────────────────────────────────────────────── */

    private static final class Freccia {
        final Stato da;
        final EventoStato evento;
        final Stato a;

        Freccia(Stato da, EventoStato evento, Stato a) {
            this.da = da;
            this.evento = evento;
            this.a = a;
        }
    }

    /** Le frecce di §4.4, una per riga, più `in-coda → in-pausa` di §6.2 (UIDT non programmabile in `accodaVideo`). */
    private static List<Freccia> frecceAmmesse() {
        List<Freccia> f = new ArrayList<>();
        f.add(new Freccia(null, EventoStato.ACCODATO, Stato.IN_CODA));
        f.add(new Freccia(Stato.IN_CODA, EventoStato.AVVIATO, Stato.IN_INVIO));
        f.add(new Freccia(Stato.IN_INVIO, EventoStato.IN_ATTESA_DI_RETE, Stato.IN_ATTESA));
        f.add(new Freccia(Stato.IN_INVIO, EventoStato.IN_PAUSA, Stato.IN_PAUSA));
        f.add(new Freccia(Stato.IN_CODA, EventoStato.IN_PAUSA, Stato.IN_PAUSA));
        f.add(new Freccia(Stato.IN_ATTESA, EventoStato.RIPRESO, Stato.IN_INVIO));
        f.add(new Freccia(Stato.IN_PAUSA, EventoStato.RIPRESO, Stato.IN_INVIO));
        f.add(new Freccia(Stato.IN_INVIO, EventoStato.INVIATO, Stato.INVIATO));
        for (Stato vivo : new Stato[]{Stato.IN_CODA, Stato.IN_INVIO, Stato.IN_ATTESA, Stato.IN_PAUSA}) {
            f.add(new Freccia(vivo, EventoStato.ANNULLATO, Stato.ANNULLATO));
            f.add(new Freccia(vivo, EventoStato.FALLITO, Stato.FALLITO));
        }
        return f;
    }

    private static Stato[] partenze() {
        return new Stato[]{null, Stato.IN_CODA, Stato.IN_INVIO, Stato.IN_ATTESA, Stato.IN_PAUSA, Stato.INVIATO, Stato.FALLITO,
                Stato.ANNULLATO};
    }

    @Test
    public void laMatriceDelleTransizioniAmmetteSoloLeFreccePrevisteESuTuttoIlResto() {
        List<Freccia> ammesse = frecceAmmesse();
        assertEquals("sedici frecce: otto esplicite (con la freccia di §6.2) + quattro «annullato» + quattro «fallito»", 16, ammesse.size());
        int controllate = 0;
        for (Stato da : partenze()) {
            for (EventoStato evento : EventoStato.values()) {
                Stato atteso = null;
                for (Freccia freccia : ammesse) {
                    if (freccia.da == da && freccia.evento == evento) atteso = freccia.a;
                }
                assertSame("da " + da + " con " + evento, atteso, PoliticaCaricamento.transizione(da, evento));
                controllate++;
            }
        }
        assertEquals(8 * 8, controllate);
    }

    @Test
    public void transizioneAmmessaCoincideConLaMatriceSuTutteLeCoppie() {
        Set<String> coppie = new HashSet<>();
        for (Freccia freccia : frecceAmmesse()) {
            if (freccia.da != null) coppie.add(freccia.da + ">" + freccia.a);
        }
        for (Stato da : partenze()) {
            for (Stato a : Stato.values()) {
                boolean atteso = da != null && coppie.contains(da + ">" + a);
                assertEquals("da " + da + " a " + a, atteso, PoliticaCaricamento.transizioneAmmessa(da, a));
            }
        }
    }

    @Test
    public void unPassoDaUnoStatoASeStessoNonETransizioneEDaiTerminaliNonSiEsce() {
        for (Stato stato : Stato.values()) {
            assertFalse("self " + stato, PoliticaCaricamento.transizioneAmmessa(stato, stato));
        }
        for (Stato terminale : new Stato[]{Stato.INVIATO, Stato.FALLITO, Stato.ANNULLATO}) {
            for (Stato a : Stato.values()) {
                assertFalse(terminale + " → " + a, PoliticaCaricamento.transizioneAmmessa(terminale, a));
            }
            for (EventoStato evento : EventoStato.values()) {
                assertNull(terminale + " con " + evento, PoliticaCaricamento.transizione(terminale, evento));
            }
        }
    }

    @Test
    public void laFrecciaInCodaInPausaDiSezione62Esiste() {
        // Secondario n. 1 della PR 3: §6.2 manda la voce `in-pausa` anche quando UIDT non si programma già in `accodaVideo`.
        assertSame(Stato.IN_PAUSA, PoliticaCaricamento.transizione(Stato.IN_CODA, EventoStato.IN_PAUSA));
        assertTrue(PoliticaCaricamento.transizioneAmmessa(Stato.IN_CODA, Stato.IN_PAUSA));
    }

    @Test
    public void ogniEventoHaUnaDestinazioneEQuellaEUsataDallaMatrice() {
        assertSame(Stato.IN_CODA, EventoStato.ACCODATO.destinazione());
        assertSame(Stato.IN_INVIO, EventoStato.AVVIATO.destinazione());
        assertSame(Stato.IN_ATTESA, EventoStato.IN_ATTESA_DI_RETE.destinazione());
        assertSame(Stato.IN_PAUSA, EventoStato.IN_PAUSA.destinazione());
        assertSame(Stato.IN_INVIO, EventoStato.RIPRESO.destinazione());
        assertSame(Stato.INVIATO, EventoStato.INVIATO.destinazione());
        assertSame(Stato.ANNULLATO, EventoStato.ANNULLATO.destinazione());
        assertSame(Stato.FALLITO, EventoStato.FALLITO.destinazione());
    }

    @Test
    public void unEventoNulloNonPortaDaNessunaParte() {
        for (Stato da : partenze()) assertNull(PoliticaCaricamento.transizione(da, null));
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * §4.5 — IL CORPO DI UN RIFIUTO DELLO STORAGE
     * ──────────────────────────────────────────────────────────────────────────── */

    private static CorpoRifiuto corpo(String json) {
        return PoliticaCaricamento.leggiCorpoRifiuto(json);
    }

    private static final String CORPO_DUPLICATO = "{\"statusCode\":\"409\",\"error\":\"Duplicate\",\"message\":\"The resource already exists\"}";
    private static final String CORPO_FIRMA_SCADUTA = "{\"statusCode\":\"400\",\"error\":\"InvalidJWT\",\"message\":\"jwt expired\"}";
    private static final String CORPO_TROPPO_GRANDE = "{\"statusCode\":\"413\",\"error\":\"EntityTooLarge\",\"message\":\"The object exceeded the maximum allowed size\"}";

    @Test
    public void ilCorpoDiUnDuplicatoSiLeggeComeLoScriveLoStorage() {
        CorpoRifiuto letto = corpo(CORPO_DUPLICATO);
        assertTrue(letto.leggibile);
        assertEquals(409, letto.statusCode);
        assertSame(ErroreStorage.DUPLICATE, letto.errore);
        assertFalse(letto.diceTroppoGrande());
    }

    @Test
    public void ilCorpoDiUnaFirmaScadutaSiLegge() {
        CorpoRifiuto letto = corpo(CORPO_FIRMA_SCADUTA);
        assertEquals(400, letto.statusCode);
        assertSame(ErroreStorage.INVALID_JWT, letto.errore);
    }

    @Test
    public void ilCorpoDiUn413SiLeggeDaStatusCodeEDaErrore() {
        assertTrue(corpo(CORPO_TROPPO_GRANDE).diceTroppoGrande());
        assertTrue("solo statusCode", corpo("{\"statusCode\":\"413\"}").diceTroppoGrande());
        assertTrue("statusCode numerico", corpo("{\"statusCode\":413}").diceTroppoGrande());
        assertTrue("solo error", corpo("{\"error\":\"EntityTooLarge\"}").diceTroppoGrande());
        assertFalse("un altro numero", corpo("{\"statusCode\":\"412\",\"error\":\"Duplicate\"}").diceTroppoGrande());
    }

    @Test
    public void erroriNonInElencoValgonoAltroEIlConfrontoEEsatto() {
        for (String nome : new String[]{"duplicate", "DUPLICATE", "InvalidJwt", "Altro", "", "Duplicate "}) {
            assertSame(nome, ErroreStorage.ALTRO, ErroreStorage.daNome(nome));
        }
        assertSame(ErroreStorage.ALTRO, ErroreStorage.daNome(null));
        assertSame(ErroreStorage.UNAUTHORIZED, ErroreStorage.daNome("Unauthorized"));
        assertSame(ErroreStorage.INVALID_REQUEST, ErroreStorage.daNome("InvalidRequest"));
        assertSame(ErroreStorage.NO_SUCH_KEY, ErroreStorage.daNome("NoSuchKey"));
        // «altro» non si può chiedere per nome: è ciò che resta fuori dall'elenco, non un elemento dell'elenco.
        assertSame(ErroreStorage.ALTRO, ErroreStorage.daNome("altro"));
        assertEquals("altro", ErroreStorage.ALTRO.valore());
    }

    @Test
    public void ilMessaggioDelCorpoNonSiLeggeNeSiConserva() {
        // Se `message` fosse letto, un nome di file nel messaggio d'errore finirebbe nel log: il tipo del risultato non lo porta.
        CorpoRifiuto letto = corpo("{\"statusCode\":\"400\",\"error\":\"InvalidRequest\",\"message\":\"percorso/segreto.mp4\"}");
        assertSame(ErroreStorage.INVALID_REQUEST, letto.errore);
        assertEquals(400, letto.statusCode);
        for (java.lang.reflect.Field campo : CorpoRifiuto.class.getFields()) {
            assertTrue("campo inatteso " + campo.getName(),
                    Arrays.asList("ASSENTE", "statusCode", "errore", "leggibile").contains(campo.getName()));
        }
    }

    @Test
    public void corpiVuotiHtmlOStortiNonSonoLeggibiliEValgonoAltro() {
        List<String> inutili = new ArrayList<>(Arrays.asList(null, "", "   ", "<html><body>502 Bad Gateway</body></html>",
                "not json", "[]", "[\"statusCode\"]", "\"stringa\"", "42", "{\"statusCode\":", "{'statusCode':'409'"));
        for (String testo : inutili) {
            CorpoRifiuto letto = corpo(testo);
            assertFalse("leggibile: " + testo, letto.leggibile);
            assertEquals(0, letto.statusCode);
            assertSame(ErroreStorage.ALTRO, letto.errore);
            assertFalse(letto.diceTroppoGrande());
        }
        assertSame(CorpoRifiuto.ASSENTE, PoliticaCaricamento.leggiCorpoRifiuto((byte[]) null));
        assertSame(CorpoRifiuto.ASSENTE, PoliticaCaricamento.leggiCorpoRifiuto(new byte[0]));
    }

    @Test
    public void unOggettoVuotoELeggibileMaNonDiceNiente() {
        CorpoRifiuto letto = corpo("{}");
        assertTrue(letto.leggibile);
        assertEquals(0, letto.statusCode);
        assertSame(ErroreStorage.ALTRO, letto.errore);
    }

    @Test
    public void statusCodeFuoriFormaVale0() {
        for (String statusCode : new String[]{"\"abc\"", "\"41\"", "\"4130\"", "\"099\"", "\"600\"", "-413", "41.3", "true", "null", "[]", "{}"}) {
            assertEquals(statusCode, 0, corpo("{\"statusCode\":" + statusCode + "}").statusCode);
        }
        assertEquals(409, corpo("{\"statusCode\":\" 409 \"}").statusCode);
        assertEquals(500, corpo("{\"statusCode\":500.0}").statusCode);
    }

    @Test
    public void ilCorpoSiLeggeSoloFinoAi4KB() {
        byte[] breve = (CORPO_DUPLICATO + "          ").getBytes(StandardCharsets.UTF_8);
        assertSame(ErroreStorage.DUPLICATE, PoliticaCaricamento.leggiCorpoRifiuto(breve).errore);

        // Un oggetto valido seguito da spazi fino a 5000 byte: i primi 4096 contengono tutto l'oggetto e leggerli basta.
        StringBuilder grande = new StringBuilder(CORPO_DUPLICATO);
        while (grande.length() < 5000) grande.append(' ');
        assertSame(ErroreStorage.DUPLICATE, PoliticaCaricamento.leggiCorpoRifiuto(grande.toString().getBytes(StandardCharsets.UTF_8)).errore);

        // L'oggetto che finisce OLTRE il 4096° byte non si legge: troncato non è JSON, e vale «altro», non un'invenzione.
        StringBuilder lungo = new StringBuilder("{\"statusCode\":\"409\",\"message\":\"");
        while (lungo.length() < 4200) lungo.append('x');
        lungo.append("\",\"error\":\"Duplicate\"}");
        CorpoRifiuto troncato = PoliticaCaricamento.leggiCorpoRifiuto(lungo.toString().getBytes(StandardCharsets.UTF_8));
        assertFalse(troncato.leggibile);
        assertSame(ErroreStorage.ALTRO, troncato.errore);
    }

    @Test
    public void ilTaglioDeiQuattroKbEInByteNonInCaratteri() {
        // 2.500 lettere «è» sono 5.000 byte in UTF-8 ma solo 2.500 caratteri: il campo `error` cade DOPO il 4096° byte.
        StringBuilder corpo = new StringBuilder("{\"statusCode\":\"409\",\"message\":\"");
        for (int i = 0; i < 2500; i++) corpo.append('\u00e8');
        corpo.append("\",\"error\":\"Duplicate\"}");
        byte[] inByte = corpo.toString().getBytes(StandardCharsets.UTF_8);
        assertTrue("più di 4096 byte", inByte.length > 4096);
        assertTrue("ma meno di 4096 caratteri", corpo.length() < 4096);
        CorpoRifiuto aByte = PoliticaCaricamento.leggiCorpoRifiuto(inByte);
        assertFalse("i primi 4096 BYTE tagliano l'oggetto a metà: non è leggibile", aByte.leggibile);
        assertSame(ErroreStorage.ALTRO, aByte.errore);
        // Sul testo già decodificato il limite è di 4096 caratteri: qui l'oggetto ci sta tutto.
        assertSame(ErroreStorage.DUPLICATE, PoliticaCaricamento.leggiCorpoRifiuto(corpo.toString()).errore);
    }

    @Test
    public void ilCorpoInByteSiDecodificaInUtf8SenzaLanciare() {
        byte[] conCaratteriStrani = ("{\"statusCode\":\"409\",\"error\":\"Duplicate\",\"message\":\"àèì\"}").getBytes(StandardCharsets.UTF_8);
        assertSame(ErroreStorage.DUPLICATE, PoliticaCaricamento.leggiCorpoRifiuto(conCaratteriStrani).errore);
        byte[] nonUtf8 = {(byte) 0xff, (byte) 0xfe, (byte) 0x00, (byte) 0x7b};
        assertFalse(PoliticaCaricamento.leggiCorpoRifiuto(nonUtf8).leggibile);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * §4.5 — LA TABELLA «ESITO DELLA PUT → AZIONE», RIGA PER RIGA
     * ──────────────────────────────────────────────────────────────────────────── */

    private static DecisionePut put(int stato, String corpoJson) {
        return PoliticaCaricamento.decidiPut(stato, corpo(corpoJson), 0L, false);
    }

    @Test
    public void ogniDueXxEInviato() {
        for (int stato : new int[]{200, 201, 202, 204, 206, 250, 299}) {
            DecisionePut d = put(stato, null);
            assertSame("stato " + stato, AzionePut.INVIATO, d.azione);
            assertNull(d.codice);
            assertFalse(d.oltreScadenza);
        }
    }

    @Test
    public void unDueXxVinceSuQualunqueCorpoEQualunqueTrasferimento() {
        DecisionePut d = PoliticaCaricamento.decidiPut(200, corpo(CORPO_FIRMA_SCADUTA), 99L, true);
        assertSame(AzionePut.INVIATO, d.azione);
        assertFalse("un 2xx non è mai «oltre la scadenza»", d.oltreScadenza);
        assertEquals("un 2xx non aspetta niente", 0L, d.retryAfterSecondi);
        assertSame(AzionePut.INVIATO, PoliticaCaricamento.decidiPut(204, corpo(CORPO_TROPPO_GRANDE), 0L, true).azione);
    }

    @Test
    public void il413ESempreTroppoGrandeSenzaRinnovo() {
        DecisionePut d = put(413, null);
        assertSame(AzionePut.TROPPO_GRANDE, d.azione);
        assertSame(Codice.TROPPO_GRANDE, d.codice);
        assertFalse(d.oltreScadenza);
    }

    @Test
    public void ilTroppoGrandeNelCorpoVaIgualeQualunqueSiaLoStatoHttp() {
        // Lo Storage manda i suoi rifiuti come HTTP 400 col `statusCode` vero nel corpo (A16).
        for (int stato : new int[]{400, 403, 404, 409, 413, 422, 500, 502}) {
            for (String json : new String[]{CORPO_TROPPO_GRANDE, "{\"statusCode\":\"413\"}", "{\"error\":\"EntityTooLarge\"}"}) {
                DecisionePut d = put(stato, json);
                assertSame("stato " + stato + " corpo " + json, AzionePut.TROPPO_GRANDE, d.azione);
                assertSame(Codice.TROPPO_GRANDE, d.codice);
            }
        }
    }

    @Test
    public void il408EIl429SonoTransitoriConIlRetryAfter() {
        for (int stato : new int[]{408, 429}) {
            DecisionePut senza = put(stato, null);
            assertSame(AzionePut.ATTESA, senza.azione);
            assertSame(Codice.SERVER, senza.codice);
            assertEquals(0L, senza.retryAfterSecondi);
            DecisionePut con = PoliticaCaricamento.decidiPut(stato, CorpoRifiuto.ASSENTE, 120L, false);
            assertSame(AzionePut.ATTESA, con.azione);
            assertEquals(120L, con.retryAfterSecondi);
        }
    }

    @Test
    public void ilRetryAfterDellaPutHaIlTettoDiUnOraEIgnoraIValoriNegativi() {
        assertEquals(3600L, PoliticaCaricamento.decidiPut(429, CorpoRifiuto.ASSENTE, 99999L, false).retryAfterSecondi);
        assertEquals(3600L, PoliticaCaricamento.decidiPut(503, CorpoRifiuto.ASSENTE, 3600L, false).retryAfterSecondi);
        assertEquals(3599L, PoliticaCaricamento.decidiPut(503, CorpoRifiuto.ASSENTE, 3599L, false).retryAfterSecondi);
        assertEquals(0L, PoliticaCaricamento.decidiPut(429, CorpoRifiuto.ASSENTE, -5L, false).retryAfterSecondi);
        assertEquals(3600L, PoliticaCaricamento.decidiPut(429, CorpoRifiuto.ASSENTE, Long.MAX_VALUE, false).retryAfterSecondi);
    }

    @Test
    public void ogniAltro4xxChiedeIlRinnovo() {
        // 400 col 409 nel corpo (il duplicato), 400 InvalidJWT, 401, 403, 404, 409... tutti: è il rinnovo a dire se il file c'è.
        int[] stati = {400, 401, 402, 403, 404, 405, 406, 409, 410, 411, 412, 414, 415, 416, 417, 418, 422, 423, 424, 426, 428, 431, 451, 499};
        for (int stato : stati) {
            for (String json : new String[]{null, CORPO_DUPLICATO, CORPO_FIRMA_SCADUTA, "{}", "<html>"}) {
                DecisionePut d = put(stato, json);
                assertSame("stato " + stato + " corpo " + json, AzionePut.RINNOVA, d.azione);
                assertSame(Codice.FIRMA_RIFIUTATA, d.codice);
                assertEquals(0L, d.retryAfterSecondi);
            }
        }
    }

    @Test
    public void ogniCinqueXxEUnTransitorio() {
        for (int stato : new int[]{500, 501, 502, 503, 504, 507, 511, 599}) {
            DecisionePut d = put(stato, null);
            assertSame("stato " + stato, AzionePut.ATTESA, d.azione);
            assertSame(Codice.SERVER, d.codice);
        }
        assertEquals(45L, PoliticaCaricamento.decidiPut(503, CorpoRifiuto.ASSENTE, 45L, false).retryAfterSecondi);
    }

    @Test
    public void nessunaRispostaEUnTransitorioDiReteSenzaRetryAfter() {
        for (int stato : new int[]{0, -1, Integer.MIN_VALUE}) {
            DecisionePut d = PoliticaCaricamento.decidiPut(stato, CorpoRifiuto.ASSENTE, 500L, false);
            assertSame(AzionePut.ATTESA, d.azione);
            assertSame(Codice.RETE, d.codice);
            assertEquals("senza risposta non c'è un Retry-After", 0L, d.retryAfterSecondi);
        }
    }

    @Test
    public void cioCheLaTabellaNonNominaValeTransitorioMaiEsitoDefinitivo() {
        // 1xx, 3xx (un reindirizzamento non si segue: la PUT ha un corpo), stati oltre 599.
        for (int stato : new int[]{100, 101, 199, 300, 301, 302, 304, 307, 308, 399, 600, 999, 10000}) {
            DecisionePut d = put(stato, null);
            assertSame("stato " + stato, AzionePut.ATTESA, d.azione);
            assertSame(Codice.SERVER, d.codice);
        }
    }

    @Test
    public void ogniStatoDaMenoDueAMilleHaUnaDecisioneEUnaSolaDelleQuattroAzioni() {
        for (int stato = -2; stato <= 1000; stato++) {
            DecisionePut d = put(stato, null);
            assertNotNull("stato " + stato, d);
            AzionePut atteso;
            if (stato >= 200 && stato <= 299) atteso = AzionePut.INVIATO;
            else if (stato == 413) atteso = AzionePut.TROPPO_GRANDE;
            else if (stato == 408 || stato == 429) atteso = AzionePut.ATTESA;
            else if (stato >= 400 && stato <= 499) atteso = AzionePut.RINNOVA;
            else atteso = AzionePut.ATTESA;
            assertSame("stato " + stato, atteso, d.azione);
        }
    }

    @Test
    public void unInvalidJwtDopoUnTrasferimentoCompletoEOltreLaScadenza() {
        // S0-b e S0-b2: la firma si verifica alla FINE della PUT. L'azione resta il rinnovo; cambia il log (put-oltre-scadenza).
        DecisionePut d = PoliticaCaricamento.decidiPut(400, corpo(CORPO_FIRMA_SCADUTA), 0L, true);
        assertSame(AzionePut.RINNOVA, d.azione);
        assertSame(Codice.FIRMA_RIFIUTATA, d.codice);
        assertTrue(d.oltreScadenza);
    }

    @Test
    public void oltreLaScadenzaServonoSiaInvalidJwtSiaIlTrasferimentoCompleto() {
        assertFalse("URL già scaduto alla partenza (S0-c): non è «oltre la scadenza»",
                PoliticaCaricamento.decidiPut(400, corpo(CORPO_FIRMA_SCADUTA), 0L, false).oltreScadenza);
        assertFalse("un duplicato dopo un trasferimento completo non è una firma scaduta",
                PoliticaCaricamento.decidiPut(400, corpo(CORPO_DUPLICATO), 0L, true).oltreScadenza);
        assertFalse("senza corpo non si sa", PoliticaCaricamento.decidiPut(400, CorpoRifiuto.ASSENTE, 0L, true).oltreScadenza);
        assertFalse("senza corpo non si sa", PoliticaCaricamento.decidiPut(403, null, 0L, true).oltreScadenza);
        assertFalse("un 413 non è una firma scaduta", PoliticaCaricamento.decidiPut(413, corpo(CORPO_FIRMA_SCADUTA), 0L, true).oltreScadenza);
        assertFalse("un 5xx non è una firma scaduta", PoliticaCaricamento.decidiPut(503, corpo(CORPO_FIRMA_SCADUTA), 0L, true).oltreScadenza);
    }

    @Test
    public void unInvalidJwtConAltroStato4xxDopoUnTrasferimentoCompletoEOltreLaScadenzaAnche() {
        // Il server finto di collaudo risponde 403 InvalidJWT: l'azione e il log devono essere gli stessi del 400 misurato.
        for (int stato : new int[]{400, 401, 403}) {
            DecisionePut d = PoliticaCaricamento.decidiPut(stato, corpo(CORPO_FIRMA_SCADUTA), 0L, true);
            assertSame(AzionePut.RINNOVA, d.azione);
            assertTrue("stato " + stato, d.oltreScadenza);
        }
    }

    @Test
    public void unCorpoNulloEquivaleAUnCorpoAssente() {
        assertSame(AzionePut.RINNOVA, PoliticaCaricamento.decidiPut(400, null, 0L, false).azione);
        assertSame(AzionePut.INVIATO, PoliticaCaricamento.decidiPut(200, null, 0L, false).azione);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL CONTATORE DEI RINNOVI DI FILA
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void soloUnRifiutoCheChiedeIlRinnovoLasciaIlContatore() {
        assertEquals(2, PoliticaCaricamento.rinnoviConsecutiviDopoPut(2, AzionePut.RINNOVA));
        assertEquals(0, PoliticaCaricamento.rinnoviConsecutiviDopoPut(0, AzionePut.RINNOVA));
        assertEquals("un contatore negativo non esiste", 0, PoliticaCaricamento.rinnoviConsecutiviDopoPut(-4, AzionePut.RINNOVA));
        for (AzionePut azione : new AzionePut[]{AzionePut.ATTESA, AzionePut.TROPPO_GRANDE, AzionePut.INVIATO}) {
            assertEquals(azione.name(), 0, PoliticaCaricamento.rinnoviConsecutiviDopoPut(3, azione));
        }
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * §4.5 — LE ATTESE
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void leAttesePartonoDa30SecondiEArrivanoA15MinutiPoiRestanoFisse() {
        long[] attesiSecondi = {30, 60, 120, 300, 600, 900, 900, 900, 900};
        for (int i = 0; i < attesiSecondi.length; i++) {
            assertEquals("tentativo " + (i + 1), attesiSecondi[i] * 1000L, PoliticaCaricamento.attesaMs(i + 1, 0L, 0.5));
        }
        assertEquals(900_000L, PoliticaCaricamento.attesaMs(1000, 0L, 0.5));
        assertEquals(900_000L, PoliticaCaricamento.attesaMs(Integer.MAX_VALUE, 0L, 0.5));
    }

    @Test
    public void unTentativoZeroONegativoValeIlPrimo() {
        assertEquals(30_000L, PoliticaCaricamento.attesaMs(0, 0L, 0.5));
        assertEquals(30_000L, PoliticaCaricamento.attesaMs(-7, 0L, 0.5));
    }

    @Test
    public void loScartoCasualeEPiuOMenoIlVentePerCento() {
        // casuale 0 → −20%, 1 → +20%: le due estremità, per la prima attesa e per l'ultima.
        assertEquals(24_000L, PoliticaCaricamento.attesaMs(1, 0L, 0.0));
        assertEquals(36_000L, PoliticaCaricamento.attesaMs(1, 0L, 1.0));
        assertEquals(720_000L, PoliticaCaricamento.attesaMs(6, 0L, 0.0));
        assertEquals(1_080_000L, PoliticaCaricamento.attesaMs(6, 0L, 1.0));
        assertEquals(1_080_000L, PoliticaCaricamento.attesaMs(50, 0L, 1.0));
        // Il punto di mezzo dà la base, e lo scarto è lineare.
        assertEquals(27_000L, PoliticaCaricamento.attesaMs(1, 0L, 0.25));
        assertEquals(33_000L, PoliticaCaricamento.attesaMs(1, 0L, 0.75));
    }

    @Test
    public void unNumeroCasualeFuoriDa0A1VieneRiportatoAgliEstremiEUnNanVaAlMezzo() {
        assertEquals(24_000L, PoliticaCaricamento.attesaMs(1, 0L, -3.0));
        assertEquals(36_000L, PoliticaCaricamento.attesaMs(1, 0L, 8.0));
        assertEquals(30_000L, PoliticaCaricamento.attesaMs(1, 0L, Double.NaN));
    }

    @Test
    public void loScartoNonScendeMaiSottoIlVenteNeSaleSopraIlVenteSuTuttaLaScala() {
        for (int tentativo = 1; tentativo <= 12; tentativo++) {
            long base = PoliticaCaricamento.attesaMs(tentativo, 0L, 0.5);
            for (double c = 0.0; c <= 1.0; c += 0.05) {
                long attesa = PoliticaCaricamento.attesaMs(tentativo, 0L, c);
                assertTrue("tentativo " + tentativo + " c=" + c, attesa >= Math.round(base * 0.8) && attesa <= Math.round(base * 1.2));
            }
        }
    }

    @Test
    public void ilRetryAfterVinceSeEPiuLungoENonSeEPiuCorto() {
        assertEquals("più lungo della base di 30 s", 120_000L, PoliticaCaricamento.attesaMs(1, 120L, 0.5));
        assertEquals("più corto della base di 60 s: vince la base", 60_000L, PoliticaCaricamento.attesaMs(2, 10L, 0.5));
        assertEquals("pari", 30_000L, PoliticaCaricamento.attesaMs(1, 30L, 0.5));
        assertEquals("più lungo anche del massimo dello scarto (36 s)", 37_000L, PoliticaCaricamento.attesaMs(1, 37L, 1.0));
        assertEquals("il Retry-After non ha scarto casuale", 120_000L, PoliticaCaricamento.attesaMs(1, 120L, 0.0));
    }

    @Test
    public void ilRetryAfterHaIlTettoDiUnOraEUnRetryAfterNegativoNonContaNiente() {
        assertEquals(3_600_000L, PoliticaCaricamento.attesaMs(1, 3600L, 0.5));
        assertEquals(3_600_000L, PoliticaCaricamento.attesaMs(1, 86_400L, 0.5));
        assertEquals(3_600_000L, PoliticaCaricamento.attesaMs(1, Long.MAX_VALUE, 0.5));
        assertEquals(30_000L, PoliticaCaricamento.attesaMs(1, -100L, 0.5));
    }

    @Test
    public void nonCEUnTettoAlNumeroDiTentativiLAttesaResta15MinutiPerSempre() {
        long ultima = PoliticaCaricamento.attesaMs(7, 0L, 0.5);
        for (int tentativo = 8; tentativo <= 5000; tentativo += 97) {
            assertEquals("tentativo " + tentativo, ultima, PoliticaCaricamento.attesaMs(tentativo, 0L, 0.5));
        }
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * Retry-After (secondi o data HTTP)
     * ──────────────────────────────────────────────────────────────────────────── */

    private static final long ADESSO_1994 = 784111767000L; // Sun, 06 Nov 1994 08:49:27 GMT

    @Test
    public void ilRetryAfterInSecondiSiLegge() {
        assertEquals(120L, PoliticaCaricamento.leggiRetryAfterSecondi("120", 0L));
        assertEquals(45L, PoliticaCaricamento.leggiRetryAfterSecondi("  45 ", 0L));
        assertEquals(0L, PoliticaCaricamento.leggiRetryAfterSecondi("0", 0L));
        assertEquals(3600L, PoliticaCaricamento.leggiRetryAfterSecondi("3600", 0L));
        assertEquals("tetto di un'ora", 3600L, PoliticaCaricamento.leggiRetryAfterSecondi("7200", 0L));
        assertEquals("dieci cifre stanno nel tetto", 3600L, PoliticaCaricamento.leggiRetryAfterSecondi("9999999999", 0L));
    }

    @Test
    public void ilRetryAfterIllegibileVale0() {
        for (String valore : new String[]{null, "", "   ", "-5", "+5", "abc", "1.5", "12 s", "99999999999", "0x10", "Retry"}) {
            assertEquals("«" + valore + "»", 0L, PoliticaCaricamento.leggiRetryAfterSecondi(valore, ADESSO_1994));
        }
    }

    @Test
    public void ilRetryAfterInDataHttpSiLeggeRispettoAdAdesso() {
        assertEquals(10L, PoliticaCaricamento.leggiRetryAfterSecondi("Sun, 06 Nov 1994 08:49:37 GMT", ADESSO_1994));
        assertEquals("arrotondato per eccesso", 11L, PoliticaCaricamento.leggiRetryAfterSecondi("Sun, 06 Nov 1994 08:49:37 GMT", ADESSO_1994 - 500L));
        assertEquals("già passata", 0L, PoliticaCaricamento.leggiRetryAfterSecondi("Sun, 06 Nov 1994 08:49:17 GMT", ADESSO_1994));
        assertEquals("tetto di un'ora", 3600L, PoliticaCaricamento.leggiRetryAfterSecondi("Mon, 07 Nov 1994 08:49:37 GMT", ADESSO_1994));
        assertEquals("data non valida", 0L, PoliticaCaricamento.leggiRetryAfterSecondi("Sun, 32 Nov 1994 08:49:37 GMT", ADESSO_1994));
        assertEquals("fuso diverso da GMT", 0L, PoliticaCaricamento.leggiRetryAfterSecondi("Sun, 06 Nov 1994 08:49:37 +0100", ADESSO_1994));
    }

    @Test
    public void ilRetryAfterNonDipendeDallaLinguaDelTelefono() {
        Locale prima = Locale.getDefault();
        try {
            for (Locale lingua : new Locale[]{Locale.forLanguageTag("ar-SA"), Locale.forLanguageTag("th-TH"), Locale.ITALY, Locale.JAPAN}) {
                Locale.setDefault(lingua);
                assertEquals(lingua.toString(), 10L, PoliticaCaricamento.leggiRetryAfterSecondi("Sun, 06 Nov 1994 08:49:37 GMT", ADESSO_1994));
                assertEquals(lingua.toString(), 77L, PoliticaCaricamento.leggiRetryAfterSecondi("77", 0L));
            }
        } finally {
            Locale.setDefault(prima);
        }
    }

    @Test
    public void ilRetryAfterNonDipendeDalFusoOrarioDelTelefono() {
        java.util.TimeZone prima = java.util.TimeZone.getDefault();
        try {
            for (String fuso : new String[]{"Pacific/Kiritimati", "America/Los_Angeles", "Asia/Kolkata", "UTC"}) {
                java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone(fuso));
                assertEquals(fuso, 10L, PoliticaCaricamento.leggiRetryAfterSecondi("Sun, 06 Nov 1994 08:49:37 GMT", ADESSO_1994));
                assertEquals(fuso, 3600L, PoliticaCaricamento.leggiRetryAfterSecondi("Mon, 07 Nov 1994 08:49:37 GMT", ADESSO_1994));
            }
        } finally {
            java.util.TimeZone.setDefault(prima);
        }
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * S0 (§3) — LA SCADENZA DELL'URL E IL RINNOVO PROATTIVO
     * ──────────────────────────────────────────────────────────────────────────── */

    private static final long FIRMATO_IL = 1_000_000_000_000L;
    private static final long SCADE_IL = FIRMATO_IL + 7_200_000L;

    @Test
    public void unUrlFirmatoDaMenoDiDieciMinutiNonSiRinnova() {
        assertFalse(PoliticaCaricamento.serveRinnovoProattivo(SCADE_IL, FIRMATO_IL));
        assertFalse(PoliticaCaricamento.serveRinnovoProattivo(SCADE_IL, FIRMATO_IL + 1L));
        assertFalse(PoliticaCaricamento.serveRinnovoProattivo(SCADE_IL, FIRMATO_IL + 599_999L));
    }

    @Test
    public void esattamenteDieciMinutiNonBastaDieciMinutiEUnMillisecondoSi() {
        assertFalse("esattamente 10'", PoliticaCaricamento.serveRinnovoProattivo(SCADE_IL, FIRMATO_IL + 600_000L));
        assertTrue("10' e 1 ms", PoliticaCaricamento.serveRinnovoProattivo(SCADE_IL, FIRMATO_IL + 600_001L));
        assertTrue(PoliticaCaricamento.serveRinnovoProattivo(SCADE_IL, FIRMATO_IL + 3_600_000L));
        assertTrue("già scaduto", PoliticaCaricamento.serveRinnovoProattivo(SCADE_IL, SCADE_IL + 1L));
    }

    @Test
    public void unaScadenzaSconosciutaSiRinnovaPrimaDiSpedireFinoADueGb() {
        assertTrue(PoliticaCaricamento.serveRinnovoProattivo(0L, FIRMATO_IL));
        assertTrue(PoliticaCaricamento.serveRinnovoProattivo(-1L, FIRMATO_IL));
    }

    @Test
    public void unOrologioIndietroNonFaRinnovare() {
        assertFalse(PoliticaCaricamento.serveRinnovoProattivo(SCADE_IL, FIRMATO_IL - 5_000_000L));
    }

    @Test
    public void laScadenzaDopoUnRinnovoESempreRicezionePiuDueOre() {
        long ricevuto = 1_700_000_000_000L;
        assertEquals(ricevuto + 7_200_000L, PoliticaCaricamento.scadenzaUrlDopoRinnovoMs(ricevuto));
        long scadenza = PoliticaCaricamento.scadenzaUrlDopoRinnovoMs(ricevuto);
        assertFalse("appena rinnovato", PoliticaCaricamento.serveRinnovoProattivo(scadenza, ricevuto));
        assertFalse(PoliticaCaricamento.serveRinnovoProattivo(scadenza, ricevuto + 600_000L));
        assertTrue(PoliticaCaricamento.serveRinnovoProattivo(scadenza, ricevuto + 600_001L));
    }

    @Test
    public void ilTokenScadeQuandoLOrologioRaggiungeLaScadenza() {
        long scade = 5_000_000L;
        assertFalse(PoliticaCaricamento.tokenScaduto(scade, scade - 1L));
        assertTrue("orologio ≥ scadeIl", PoliticaCaricamento.tokenScaduto(scade, scade));
        assertTrue(PoliticaCaricamento.tokenScaduto(scade, scade + 1L));
    }

    @Test
    public void unaScadenzaDelTokenSconosciutaNonFaMorireLaVoce() {
        assertFalse(PoliticaCaricamento.tokenScaduto(0L, Long.MAX_VALUE));
        assertFalse(PoliticaCaricamento.tokenScaduto(-1L, Long.MAX_VALUE));
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * §4.5 — LA RISPOSTA DEL RINNOVO, RILETTA PER FORMA
     * ──────────────────────────────────────────────────────────────────────────── */

    /**
     * Il progetto Supabase di PRODUZIONE, scritto a mano qui e NON preso da `PoliticaCaricamento.HOST_PUT`: un valore atteso che si ricalcola
     * col codice che si prova non prova niente. È l'unico host della PUT (decisione del 03/10, dopo il critico di I2).
     */
    private static final String HOST_PRODUZIONE = "uimulkjyekgemjakmepp.supabase.co";
    private static final String URL_STORAGE = "https://" + HOST_PRODUZIONE + "/storage/v1/object/upload/sign/video_processing/x?token=t";

    private static String daCaricare(String url, String protocollo, String contentType) {
        return "{\"stato\":\"da-caricare\",\"caricamento\":{\"protocollo\":" + quota(protocollo) + ",\"url\":" + quota(url)
                + ",\"metodo\":\"PUT\",\"intestazioni\":{\"content-type\":" + quota(contentType) + "}},\"scadeIl\":\"2026-10-05T10:00:00.000Z\"}";
    }

    private static String quota(String valore) {
        return valore == null ? "null" : "\"" + valore.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    private static RispostaRinnovo rinnovo(int stato, String corpoJson) {
        return PoliticaCaricamento.leggiRispostaRinnovo(stato, corpoJson, 0L, false);
    }

    @Test
    public void unDaCaricareBenFormatoPortaUrlEContentType() {
        RispostaRinnovo r = rinnovo(200, daCaricare(URL_STORAGE, "put", "video/mp4"));
        assertSame(TipoRinnovo.DA_CARICARE, r.tipo);
        assertEquals(URL_STORAGE, r.urlPut);
        assertEquals("video/mp4", r.contentType);
    }

    @Test
    public void ilContentTypeConIlSuffissoDeiCodecEAmmesso() {
        RispostaRinnovo r = rinnovo(200, daCaricare(URL_STORAGE, "put", "video/mp4;codecs=avc1.42E01E,mp4a.40.2"));
        assertSame(TipoRinnovo.DA_CARICARE, r.tipo);
        assertEquals("video/mp4;codecs=avc1.42E01E,mp4a.40.2", r.contentType);
    }

    @Test
    public void arrivatoEAnnullatoSiLeggonoDalloStatoESenzaAltro() {
        assertSame(TipoRinnovo.ARRIVATO, rinnovo(200, "{\"stato\":\"arrivato\"}").tipo);
        assertSame(TipoRinnovo.ANNULLATO, rinnovo(200, "{\"stato\":\"annullato\"}").tipo);
    }

    @Test
    public void unRinnovoFuoriFormaVaTransitorioMaiUnEsitoDefinitivo() {
        List<String> corpi = new ArrayList<>();
        corpi.add(null);
        corpi.add("");
        corpi.add("non è json");
        corpi.add("[]");
        corpi.add("{}");
        corpi.add("{\"stato\":\"altro\"}");
        corpi.add("{\"stato\":\"DA-CARICARE\"}");
        corpi.add("{\"stato\":\"da-caricare\"}");
        corpi.add("{\"stato\":\"da-caricare\",\"caricamento\":null}");
        corpi.add("{\"stato\":\"da-caricare\",\"caricamento\":{}}");
        corpi.add("{\"stato\":42}");
        corpi.add(daCaricare(URL_STORAGE, "tus", "video/mp4"));
        corpi.add(daCaricare(URL_STORAGE, null, "video/mp4"));
        corpi.add(daCaricare(null, "put", "video/mp4"));
        corpi.add(daCaricare(URL_STORAGE, "put", null));
        corpi.add(daCaricare(URL_STORAGE, "put", "mp4"));
        corpi.add(daCaricare(URL_STORAGE, "put", ""));
        corpi.add(daCaricare(URL_STORAGE, "put", "video/"));
        corpi.add("{\"stato\":\"da-caricare\",\"caricamento\":{\"protocollo\":\"put\",\"url\":\"" + URL_STORAGE + "\"}}");
        for (String corpoJson : corpi) {
            assertSame("«" + corpoJson + "»", TipoRinnovo.TRANSITORIO_SERVER, rinnovo(200, corpoJson).tipo);
        }
    }

    @Test
    public void unUrlDellaNuovaPutFuoriElencoNonDiventaMaiUnaPut() {
        for (String voce : new String[]{"https://evil.example/x", "http://abcd.supabase.co/x", "https://supabase.co/x",
                "https://abcd.supabase.co.evil.example/x", "https://app.kidville.it/x", "ftp://abcd.supabase.co/x",
                "https://u@abcd.supabase.co/x", "http://10.0.2.2:3101/x", "http://localhost:3101/x", ""}) {
            // Le voci sono scritte su `abcd.supabase.co`: si riportano sul progetto di produzione, così ognuna è rifiutata per la SUA ragione
            // (schema, chiocciola, suffisso) e non solo perché l'host è di un altro progetto.
            String url = voce.replace("abcd.supabase.co", HOST_PRODUZIONE);
            assertSame("Release: " + url, TipoRinnovo.TRANSITORIO_SERVER, rinnovo(200, daCaricare(url, "put", "video/mp4")).tipo);
        }
    }

    @Test
    public void laNuovaPutDelRinnovoVersoUnAltroProgettoSupabaseNonDiventaMaiUnaPut() {
        // Un rinnovo manipolato (o un sito compromesso) non può portare il video di un bambino in un progetto Supabase che non è il nostro.
        for (String url : new String[]{"https://abcd.supabase.co/x", "https://abcdwxyzabcdwxyz.supabase.co/storage/v1/object/upload/sign/b/p?token=t",
                "https://a." + HOST_PRODUZIONE + "/x", "https://x" + HOST_PRODUZIONE + "/x"}) {
            assertSame("Release: " + url, TipoRinnovo.TRANSITORIO_SERVER, rinnovo(200, daCaricare(url, "put", "video/mp4")).tipo);
            assertSame("Debug: " + url, TipoRinnovo.TRANSITORIO_SERVER,
                    PoliticaCaricamento.leggiRispostaRinnovo(200, daCaricare(url, "put", "video/mp4"), 0L, true).tipo);
        }
    }

    @Test
    public void inDebugLaNuovaPutPuoEssereUnLoopback() {
        String url = "http://10.0.2.2:3101/put/abc";
        RispostaRinnovo debug = PoliticaCaricamento.leggiRispostaRinnovo(200, daCaricare(url, "put", "video/mp4"), 0L, true);
        assertSame(TipoRinnovo.DA_CARICARE, debug.tipo);
        assertEquals(url, debug.urlPut);
        RispostaRinnovo release = PoliticaCaricamento.leggiRispostaRinnovo(200, daCaricare(url, "put", "video/mp4"), 0L, false);
        assertSame(TipoRinnovo.TRANSITORIO_SERVER, release.tipo);
    }

    @Test
    public void gliStatiDelRinnovoSiMappanoSuITipi() {
        assertSame("404 vale token non valido, qualunque corpo", TipoRinnovo.NON_TROVATO, rinnovo(404, "{\"stato\":\"arrivato\"}").tipo);
        assertSame(TipoRinnovo.NON_TROVATO, rinnovo(404, null).tipo);
        assertSame("nessuna risposta", TipoRinnovo.TRANSITORIO_RETE, rinnovo(0, null).tipo);
        assertSame(TipoRinnovo.TRANSITORIO_RETE, rinnovo(-1, "{\"stato\":\"arrivato\"}").tipo);
        for (int stato : new int[]{500, 502, 503, 504, 599}) {
            assertSame("stato " + stato, TipoRinnovo.TRANSITORIO_SERVER, rinnovo(stato, null).tipo);
        }
    }

    @Test
    public void ogniAltroStatoDelRinnovoVaTransitorioNonChiudeUnaVoce() {
        // 400 / 401 / 403 (un firewall) / 3xx / 201 anche con un corpo che sembrerebbe buono.
        String buono = "{\"stato\":\"arrivato\"}";
        for (int stato : new int[]{100, 201, 202, 204, 301, 302, 400, 401, 403, 405, 409, 410, 422, 600}) {
            assertSame("stato " + stato, TipoRinnovo.TRANSITORIO_SERVER, rinnovo(stato, buono).tipo);
        }
    }

    @Test
    public void il429DelRinnovoPortaIlRetryAfterConIlTettoDiUnOra() {
        assertEquals(0L, PoliticaCaricamento.leggiRispostaRinnovo(429, null, 0L, false).retryAfterSecondi);
        RispostaRinnovo r = PoliticaCaricamento.leggiRispostaRinnovo(429, null, 90L, false);
        assertSame(TipoRinnovo.TROPPE_RICHIESTE, r.tipo);
        assertEquals(90L, r.retryAfterSecondi);
        assertEquals(3600L, PoliticaCaricamento.leggiRispostaRinnovo(429, null, 99999L, false).retryAfterSecondi);
        assertEquals(0L, PoliticaCaricamento.leggiRispostaRinnovo(429, null, -9L, false).retryAfterSecondi);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * §4.5 — LA TABELLA «RISPOSTA DEL RINNOVO → AZIONE», RIGA PER RIGA
     * ──────────────────────────────────────────────────────────────────────────── */

    private static RispostaRinnovo daCaricareOk() {
        return rinnovo(200, daCaricare(URL_STORAGE, "put", "video/mp4"));
    }

    @Test
    public void daCaricareDopoUnRifiutoDellaPutAlzaIlContatoreFinoATre() {
        for (int prima = 0; prima < 3; prima++) {
            DecisioneRinnovo d = PoliticaCaricamento.decidiRinnovo(daCaricareOk(), prima, true, false);
            assertSame("prima " + prima, AzioneRinnovo.NUOVA_PUT, d.azione);
            assertNull(d.codice);
            assertEquals(prima + 1, d.rinnoviConsecutivi);
            assertTrue(d.contaRinnovo);
            assertSame(EsitoRinnovo.DA_CARICARE, d.esito);
            assertEquals(0L, d.retryAfterSecondi);
        }
    }

    @Test
    public void ilQuartoDaCaricareDiFilaDopoUnRifiutoVaRinnovoCiclico() {
        for (int prima : new int[]{3, 4, 10, 1000}) {
            DecisioneRinnovo d = PoliticaCaricamento.decidiRinnovo(daCaricareOk(), prima, true, false);
            assertSame("prima " + prima, AzioneRinnovo.FALLITO, d.azione);
            assertSame(Codice.RINNOVO_CICLICO, d.codice);
            // `RINNOVO_CICLICO` è il codice di `video-nativo-fallito`, NON un esito del rinnovo (deciso il 03/10): il rinnovo che fa
            // scattare il tetto ha risposto `da-caricare`, e così si scrive, come su iOS. `tetto` è solo il 429.
            assertSame(EsitoRinnovo.DA_CARICARE, d.esito);
            assertEquals("il contatore non cresce oltre il tetto", prima, d.rinnoviConsecutivi);
            assertTrue("il rinnovo c'è stato, e si conta", d.contaRinnovo);
        }
    }

    @Test
    public void ilRinnovoProattivoNonSiContaNonFaScattareIlTettoEDaSempreUnaNuovaPut() {
        for (int prima : new int[]{0, 1, 2, 3, 4, 50}) {
            DecisioneRinnovo d = PoliticaCaricamento.decidiRinnovo(daCaricareOk(), prima, false, false);
            assertSame("prima " + prima, AzioneRinnovo.NUOVA_PUT, d.azione);
            assertNull(d.codice);
            assertEquals("il proattivo lascia il contatore com'è", prima, d.rinnoviConsecutivi);
            assertTrue(d.contaRinnovo);
            assertSame(EsitoRinnovo.DA_CARICARE, d.esito);
        }
    }

    @Test
    public void arrivatoChiudeLaVoceComeInviataAncheAlTetto() {
        // La seconda PUT rifiutata come duplicato (o ORIGINALE_SOSTITUITO): il rinnovo dice che il file c'è, ed è l'esito buono.
        for (boolean rifiuto : new boolean[]{true, false}) {
            for (int prima : new int[]{0, 3, 99}) {
                DecisioneRinnovo d = PoliticaCaricamento.decidiRinnovo(rinnovo(200, "{\"stato\":\"arrivato\"}"), prima, rifiuto, true);
                assertSame(AzioneRinnovo.INVIATO, d.azione);
                assertNull(d.codice);
                assertSame(EsitoRinnovo.ARRIVATO, d.esito);
                assertFalse("nessun URL nuovo: non è un rinnovo contato", d.contaRinnovo);
            }
        }
    }

    @Test
    public void annullatoChiudeLaVoceComeAnnullataDalServer() {
        DecisioneRinnovo d = PoliticaCaricamento.decidiRinnovo(rinnovo(200, "{\"stato\":\"annullato\"}"), 1, true, false);
        assertSame(AzioneRinnovo.ANNULLATO, d.azione);
        assertSame(Codice.ANNULLATO_DAL_SERVER, d.codice);
        assertSame(EsitoRinnovo.ANNULLATO, d.esito);
    }

    @Test
    public void un404SenzaTokenPiuRecenteFallisceConTokenNonValido() {
        DecisioneRinnovo d = PoliticaCaricamento.decidiRinnovo(rinnovo(404, null), 0, true, false);
        assertSame(AzioneRinnovo.FALLITO, d.azione);
        assertSame(Codice.TOKEN_NON_VALIDO, d.codice);
        assertSame(EsitoRinnovo.NEGATO, d.esito);
    }

    @Test
    public void un404ConUnTokenPiuRecenteRiprovaConQuello() {
        // Rotazione appena arrivata (l'apertura ripetuta rende sconosciuto il vecchio token): si riprova col nuovo.
        for (boolean rifiuto : new boolean[]{true, false}) {
            DecisioneRinnovo d = PoliticaCaricamento.decidiRinnovo(rinnovo(404, null), 2, rifiuto, true);
            assertSame(AzioneRinnovo.RIPROVA_CON_TOKEN_NUOVO, d.azione);
            assertNull(d.codice);
            assertSame(EsitoRinnovo.NEGATO, d.esito);
            assertEquals("la rotazione non è un rinnovo contato", 2, d.rinnoviConsecutivi);
            assertFalse(d.contaRinnovo);
        }
    }

    @Test
    public void un429AspettaIlRetryAfter() {
        DecisioneRinnovo d = PoliticaCaricamento.decidiRinnovo(PoliticaCaricamento.leggiRispostaRinnovo(429, null, 90L, false), 1, true, false);
        assertSame(AzioneRinnovo.ATTESA, d.azione);
        assertSame(Codice.SERVER, d.codice);
        assertEquals(90L, d.retryAfterSecondi);
        assertSame("il 429 sono i tetti del rinnovo: esito `tetto`, come su iOS (deciso il 03/10)", EsitoRinnovo.TETTO, d.esito);
        assertEquals(1, d.rinnoviConsecutivi);
        assertFalse(d.contaRinnovo);
    }

    @Test
    public void cinqueXxReteECorpoFuoriSchemaSonoTransitori() {
        DecisioneRinnovo server = PoliticaCaricamento.decidiRinnovo(rinnovo(503, null), 2, true, false);
        assertSame(AzioneRinnovo.ATTESA, server.azione);
        assertSame(Codice.SERVER, server.codice);
        assertSame(EsitoRinnovo.SERVER, server.esito);
        DecisioneRinnovo fuoriSchema = PoliticaCaricamento.decidiRinnovo(rinnovo(200, "{\"stato\":\"boh\"}"), 2, false, false);
        assertSame(AzioneRinnovo.ATTESA, fuoriSchema.azione);
        assertSame(Codice.SERVER, fuoriSchema.codice);
        DecisioneRinnovo rete = PoliticaCaricamento.decidiRinnovo(rinnovo(0, null), 2, true, false);
        assertSame(AzioneRinnovo.ATTESA, rete.azione);
        assertSame(Codice.RETE, rete.codice);
        assertSame(EsitoRinnovo.RETE, rete.esito);
        for (DecisioneRinnovo d : new DecisioneRinnovo[]{server, fuoriSchema, rete}) {
            assertEquals("il contatore resta com'è", 2, d.rinnoviConsecutivi);
            assertFalse(d.contaRinnovo);
        }
    }

    @Test
    public void unContatoreNegativoInIngressoSiTrattaComeZero() {
        assertEquals(1, PoliticaCaricamento.decidiRinnovo(daCaricareOk(), -5, true, false).rinnoviConsecutivi);
        assertEquals(0, PoliticaCaricamento.decidiRinnovo(daCaricareOk(), -5, false, false).rinnoviConsecutivi);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL TETTO DEI RINNOVI IN SCENARIO (lettura di «consecutivi», testata della classe)
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void ilCicloDiRifiutiChiudeAlQuartoRinnovoEUnaFilaDiCaduteDiReteNonChiudeMai() {
        // 1. Il ciclo vero: la PUT è rifiutata, si rinnova, la PUT è rifiutata di nuovo (firma che scade durante un invio lungo).
        int consecutivi = 0;
        int rinnoviFatti = 0;
        AzioneRinnovo ultima = null;
        for (int giro = 1; giro <= 6; giro++) {
            DecisionePut put = PoliticaCaricamento.decidiPut(400, corpo(CORPO_FIRMA_SCADUTA), 0L, true);
            assertSame(AzionePut.RINNOVA, put.azione);
            consecutivi = PoliticaCaricamento.rinnoviConsecutiviDopoPut(consecutivi, put.azione);
            DecisioneRinnovo r = PoliticaCaricamento.decidiRinnovo(daCaricareOk(), consecutivi, true, false);
            ultima = r.azione;
            consecutivi = r.rinnoviConsecutivi;
            if (r.azione == AzioneRinnovo.FALLITO) {
                assertSame(Codice.RINNOVO_CICLICO, r.codice);
                break;
            }
            rinnoviFatti++;
        }
        assertSame(AzioneRinnovo.FALLITO, ultima);
        assertEquals("tre rinnovi, poi il quarto rifiuto chiude", 3, rinnoviFatti);

        // 2. Un guasto dello Storage: dopo ogni attesa si rinnova (l'URL ha più di 10') e la PUT dà 503. Per ore. Mai un ciclo.
        consecutivi = 0;
        for (int giro = 1; giro <= 200; giro++) {
            DecisioneRinnovo proattivo = PoliticaCaricamento.decidiRinnovo(daCaricareOk(), consecutivi, false, false);
            assertSame("giro " + giro, AzioneRinnovo.NUOVA_PUT, proattivo.azione);
            consecutivi = proattivo.rinnoviConsecutivi;
            DecisionePut put = PoliticaCaricamento.decidiPut(503, CorpoRifiuto.ASSENTE, 0L, false);
            assertSame(AzionePut.ATTESA, put.azione);
            consecutivi = PoliticaCaricamento.rinnoviConsecutiviDopoPut(consecutivi, put.azione);
        }
        assertEquals(0, consecutivi);

        // 3. Un rifiuto in mezzo a molte cadute non si somma ai rifiuti di ore prima.
        consecutivi = 2;
        consecutivi = PoliticaCaricamento.rinnoviConsecutiviDopoPut(consecutivi, PoliticaCaricamento.decidiPut(0, null, 0L, false).azione);
        assertEquals(0, consecutivi);
        DecisioneRinnovo primoDiUnaNuovaSerie = PoliticaCaricamento.decidiRinnovo(daCaricareOk(), consecutivi, true, false);
        assertSame(AzioneRinnovo.NUOVA_PUT, primoDiUnaNuovaSerie.azione);
        assertEquals(1, primoDiUnaNuovaSerie.rinnoviConsecutivi);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * §9 — GLI HOST AMMESSI
     * ──────────────────────────────────────────────────────────────────────────── */

    private static boolean put(String url, boolean debug) {
        return PoliticaCaricamento.urlAmmesso(url, Destinazione.PUT, debug);
    }

    private static boolean sito(String url, boolean debug) {
        boolean rinnovo = PoliticaCaricamento.urlAmmesso(url, Destinazione.RINNOVO, debug);
        boolean registro = PoliticaCaricamento.urlAmmesso(url, Destinazione.REGISTRO, debug);
        assertEquals("rinnovo e registro hanno la stessa politica: " + url, rinnovo, registro);
        return rinnovo;
    }

    @Test
    public void inReleaseLaPutVaSoloAlProgettoDiProduzioneInHttps() {
        assertTrue(put(URL_STORAGE, false));
        assertTrue(put("https://" + HOST_PRODUZIONE, false));
        assertTrue(put("https://" + HOST_PRODUZIONE + "/", false));
        assertTrue(put("https://" + HOST_PRODUZIONE + "?x=1", false));
        assertTrue(put("https://" + HOST_PRODUZIONE + "#x", false));
        assertTrue("porta 443 esplicita", put("https://" + HOST_PRODUZIONE + ":443/x", false));
        assertTrue("host in maiuscolo: i nomi di dominio non distinguono", put("https://UIMULKJYEKGEMJAKMEPP.SUPABASE.CO/x", false));
        assertEquals("l'host ammesso è quello scritto qui, uno solo", HOST_PRODUZIONE, PoliticaCaricamento.HOST_PUT);
    }

    @Test
    public void unAltroProgettoSupabaseNonEAmmessoNeInReleaseNeInDebug() {
        for (String url : new String[]{
                "https://abcd.supabase.co/x",
                "https://abcdwxyzabcdwxyz.supabase.co/storage/v1/object/upload/sign/video_processing/x?token=t",
                "https://a-b-c.supabase.co/x",
                "https://a1.supabase.co/x",
                "https://uimulkjyekgemjakmepq.supabase.co/x",       // una lettera di differenza
                "https://xuimulkjyekgemjakmepp.supabase.co/x",      // una in più davanti
                "https://uimulkjyekgemjakmep.supabase.co/x",        // una in meno
                "https://a.uimulkjyekgemjakmepp.supabase.co/x",     // un sottodominio del nostro: non è il nostro
                "https://abcd.storage.supabase.co/storage/v1/object/upload/sign/b/o?token=t",
                "https://supabase.co/x"}) {
            assertFalse("Release PUT: «" + url + "»", put(url, false));
            assertFalse("Debug PUT: «" + url + "»", put(url, true));
        }
    }

    /**
     * Il progetto Supabase della CI, scritto a mano qui e NON preso da `PoliticaCaricamento.HOST_PUT_DEBUG`. Ha solo dati di prova e serve al
     * collaudo dell'app vera (E1, §11.2): si ammette SOLO nelle build Debug e SOLO per la PUT.
     */
    private static final String HOST_CI = "azhssawihitkphgnlukl.supabase.co";

    @Test
    public void ilProgettoDellaCiEAmmessoSoloInDebugESoloPerLaPut() {
        String url = "https://" + HOST_CI + "/storage/v1/object/upload/sign/video_originals/x/y.mov?token=t";
        assertTrue("Debug PUT verso la CI", put(url, true));
        assertTrue("Debug PUT verso la CI con la porta 443 esplicita", put("https://" + HOST_CI + ":443/x", true));
        assertFalse("Release PUT verso la CI: MAI", put(url, false));
        assertFalse("Debug PUT verso la CI in chiaro", put("http://" + HOST_CI + "/x", true));
        assertFalse("Debug PUT verso la CI su un'altra porta", put("https://" + HOST_CI + ":8443/x", true));
        assertFalse("Debug PUT verso un sottodominio della CI", put("https://a." + HOST_CI + "/x", true));
        assertFalse("Debug rinnovo e registro verso la CI: vale solo per la PUT", sito(url, true));
        assertEquals("l'host di Debug è quello scritto qui", HOST_CI, PoliticaCaricamento.HOST_PUT_DEBUG);
    }

    @Test
    public void inReleaseLaPutRifiutaOgniAltroIndirizzo() {
        List<String> daRiportare = new ArrayList<>(Arrays.asList(
                "http://abcd.supabase.co/x",                    // niente chiaro
                "https://supabase.co/x",                        // il dominio stesso non è un sottodominio
                "https://.supabase.co/x",                       // etichetta vuota
                "https://abcd.supabase.co.evil.example/x",      // il suffisso non è alla fine
                "https://evil-supabase.co/x",                   // manca il punto
                "https://xsupabase.co/x",
                "https://abcd.supabase.com/x",
                "https://abcd.supabase.io/x",
                "https://evil.example/.supabase.co",            // il suffisso nel percorso
                "https://evil.example/?u=abcd.supabase.co",     // ...e nella query
                "https://evil.example#abcd.supabase.co",        // ...e nel frammento
                "https://abcd.supabase.co@evil.example/x",      // credenziali: l'host vero è dopo la chiocciola
                "https://evil.example@abcd.supabase.co/x",      // anche con l'host buono: le credenziali non servono
                "https://abcd.supabase.co:8443/x",              // porta non standard
                "https://abcd.supabase.co:80/x",
                "https://abcd.supabase.co:/x",                  // porta vuota
                "https://abcd.supabase.co:abc/x",
                "https://abcd.supabase.co:443:443/x",
                "https://abcd.supabase.co.:443/x",
                "https://abcd.supabase.co./x",                  // punto finale
                "https://abcd..supabase.co/x",
                "https://-abcd.supabase.co/x",
                "https://abcd-.supabase.co/x",
                "https://ab_cd.supabase.co/x",
                "https://[::1]/x",
                "https://[abcd.supabase.co]/x",
                "https://abcd.supabase.co%2eevil.example/x",
                "https://abcd.supabase.co\\@evil.example/x",    // la barra rovescia che java.net.URI perdonerebbe
                "https://abcd.supabase.co\\x",
                "https:\\\\abcd.supabase.co/x",
                "https:/abcd.supabase.co/x",
                "https//abcd.supabase.co/x",
                "https:abcd.supabase.co",
                "//abcd.supabase.co/x",
                "abcd.supabase.co/x",
                "HTTPS://abcd.supabase.co/x",                   // lo schema si scrive in minuscolo
                "Https://abcd.supabase.co/x",
                "ftp://abcd.supabase.co/x",
                "file:///data/x",
                "javascript://abcd.supabase.co/x",
                "ws://abcd.supabase.co/x",
                "https://abcd.supabase.co/ x",                  // spazio
                "https://abcd.supabase.co/\tx",
                "https://abcd.supabase.co/\nx",
                "https://abcd.supabase.co/\u0000x",
                "https://abcd.supabase.co/è",                    // non ASCII
                "https://аbcd.supabase.co/x",                    // una «а» cirillica
                " https://abcd.supabase.co/x",
                "https://abcd.supabase.co/x ",
                "",
                "https://",
                "https:///x",
                "://abcd.supabase.co/x",
                "https://localhost/x",
                "https://127.0.0.1/x",
                "https://10.0.2.2/x",
                "https://app.kidville.it/x"));
        // Le voci sono scritte su `abcd.supabase.co`: si riportano sul progetto di produzione, così ognuna è rifiutata per la SUA ragione (schema,
        // chiocciola, porta, suffisso, caratteri) e non solo perché l'host è di un altro progetto.
        List<String> rifiutati = new ArrayList<>();
        for (String voce : daRiportare) rifiutati.add(voce.replace("abcd.supabase.co", HOST_PRODUZIONE));
        rifiutati.add("https://" + repeat('a', 9000) + ".supabase.co/x");
        for (String url : rifiutati) {
            assertFalse("Release PUT: «" + url + "»", put(url, false));
        }
    }

    private static String repeat(char c, int volte) {
        char[] caratteri = new char[volte];
        Arrays.fill(caratteri, c);
        return new String(caratteri);
    }

    @Test
    public void unIndirizzoNulloONonRiconoscibileEInvalido() {
        assertFalse(PoliticaCaricamento.urlAmmesso(null, Destinazione.PUT, true));
        assertFalse(PoliticaCaricamento.urlAmmesso(URL_STORAGE, null, true));
        assertFalse(PoliticaCaricamento.urlAmmesso(null, null, false));
    }

    @Test
    public void inReleaseIlRinnovoEIlRegistroVannoSoloAlSitoDiProduzione() {
        assertTrue(sito("https://app.kidville.it/api/video-uploads/rinnovo", false));
        assertTrue(sito("https://app.kidville.it/api/logs", false));
        assertTrue(sito("https://app.kidville.it", false));
        assertTrue(sito("https://app.kidville.it:443/api/logs", false));
        assertTrue(sito("https://APP.KIDVILLE.IT/api/logs", false));
        for (String url : new String[]{
                "http://app.kidville.it/api/logs",
                "https://kidville.it/api/logs",
                "https://www.app.kidville.it/api/logs",
                "https://evil.app.kidville.it/api/logs",
                "https://app.kidville.it.evil.example/api/logs",
                "https://app.kidville.itx/api/logs",
                "https://xapp.kidville.it/api/logs",
                "https://evil.example/app.kidville.it",
                "https://evil.example/?h=app.kidville.it",
                "https://app.kidville.it@evil.example/api/logs",
                "https://evil.example@app.kidville.it/api/logs",
                "https://app.kidville.it:8443/api/logs",
                "https://app.kidville.it./api/logs",
                "https://app.kidville.it\\@evil.example/api/logs",
                "https://abcd.supabase.co/api/logs",       // lo Storage non è il sito
                "https://localhost/api/logs",
                "http://10.0.2.2:3101/api/logs",
                ""}) {
            assertFalse("Release rinnovo/registro: «" + url + "»", sito(url, false));
        }
    }

    @Test
    public void laPutNonPuoAndareAlSitoENonViceversa() {
        assertFalse(put("https://app.kidville.it/x", false));
        assertFalse(put("https://app.kidville.it/x", true));
        assertFalse(sito(URL_STORAGE, false));
        assertFalse(sito(URL_STORAGE, true));
    }

    @Test
    public void inDebugSiAggiungonoISoliLoopbackDelCollaudoConQualunquePortaEQualunqueSchema() {
        for (String host : new String[]{"localhost", "127.0.0.1", "10.0.2.2"}) {
            for (String schema : new String[]{"http", "https"}) {
                for (String porta : new String[]{"", ":80", ":443", ":3100", ":3101", ":4310", ":65535", ":1"}) {
                    String url = schema + "://" + host + porta + "/x?y=1";
                    assertTrue("Debug PUT " + url, put(url, true));
                    assertTrue("Debug sito " + url, sito(url, true));
                    assertFalse("Release PUT " + url, put(url, false));
                    assertFalse("Release sito " + url, sito(url, false));
                }
            }
        }
        assertTrue("Debug mantiene anche gli host di Release", put(URL_STORAGE, true));
        assertTrue(sito("https://app.kidville.it/api/logs", true));
    }

    @Test
    public void inDebugOgniAltroHostRestaFuori() {
        for (String url : new String[]{
                "http://10.0.2.3:3101/x", "http://10.0.2.2.evil.example/x", "http://localhost.evil.example/x",
                "http://evil.example/localhost", "http://localhost@evil.example/x", "http://evil.example@localhost/x",
                "http://127.0.0.2/x", "http://127.0.0.1.evil.example/x", "http://0.0.0.0/x", "http://192.168.1.10:3101/x",
                "http://10.0.2.2:0/x", "http://10.0.2.2:65536/x", "http://10.0.2.2:99999/x", "http://10.0.2.2:-1/x",
                "http://10.0.2.2:3101:3101/x", "http://[::1]:3101/x", "http://[::1]/x", "http://LOCALHOST.evil/x",
                "http://localhos/x", "http://xlocalhost/x", "http://127.0.0.1\\@evil.example/x", "ftp://localhost/x",
                "http://evil.example/x", "http://abcd.supabase.co/x", "http://app.kidville.it/x"}) {
            assertFalse("Debug PUT «" + url + "»", put(url, true));
            assertFalse("Debug sito «" + url + "»", sito(url, true));
        }
    }

    @Test
    public void unaPortaDiCinqueCifreSiLeggeComeNumero() {
        assertTrue(put("http://localhost:00080/x", true));
        assertFalse(put("http://localhost:000000/x", true));
        assertFalse(put("http://localhost:123456/x", true));
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * §6.2 — IL MOTORE PER LIVELLO DI API (parti pure)
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void daApi34IlMotoreEUidtSottoEWorkManager() {
        for (int sdk = 24; sdk <= 33; sdk++) {
            assertSame("sdk " + sdk, Motore.WORKMANAGER, PoliticaCaricamento.motorePer(sdk, false));
        }
        for (int sdk = 34; sdk <= 40; sdk++) {
            assertSame("sdk " + sdk, Motore.UIDT, PoliticaCaricamento.motorePer(sdk, false));
        }
        assertSame(Motore.WORKMANAGER, PoliticaCaricamento.motorePer(1, false));
        assertSame(Motore.UIDT, PoliticaCaricamento.motorePer(Integer.MAX_VALUE, false));
    }

    @Test
    public void forzaWorkManagerRiportaOgniLivelloSulSecondoRamo() {
        for (int sdk : new int[]{24, 30, 33, 34, 35, 36, 40}) {
            assertSame("sdk " + sdk, Motore.WORKMANAGER, PoliticaCaricamento.motorePer(sdk, true));
        }
    }

    @Test
    public void ilCodiceDellaPausaDipendeDalMotore() {
        assertSame(Codice.FGS_NON_AVVIABILE, PoliticaCaricamento.codicePausa(Motore.WORKMANAGER));
        assertSame(Codice.UIDT_NON_PROGRAMMABILE, PoliticaCaricamento.codicePausa(Motore.UIDT));
    }

    @Test
    public void ilWorkerAspettaLaReteFinoADieciMinutiELaRigaDiLogParteOltreSessantaSecondi() {
        assertFalse(PoliticaCaricamento.attesaReteNelWorkerEsaurita(0L));
        assertFalse(PoliticaCaricamento.attesaReteNelWorkerEsaurita(599L));
        assertTrue(PoliticaCaricamento.attesaReteNelWorkerEsaurita(600L));
        assertTrue(PoliticaCaricamento.attesaReteNelWorkerEsaurita(601L));
        assertFalse(PoliticaCaricamento.attesaReteDaLoggare(0L));
        assertFalse(PoliticaCaricamento.attesaReteDaLoggare(60L));
        assertTrue("oltre 60 s", PoliticaCaricamento.attesaReteDaLoggare(61L));
    }

    @Test
    public void iNumeriDellaSpecSonoQuelliDellaSpec() {
        assertEquals(7200L, PoliticaCaricamento.VALIDITA_URL_PUT_SECONDI);
        assertEquals("S0: più di 10 minuti", 600L, PoliticaCaricamento.SOGLIA_RINNOVO_PROATTIVO_SECONDI);
        assertEquals("oltre 3 rinnovi consecutivi", 3, PoliticaCaricamento.TETTO_RINNOVI_CONSECUTIVI);
        assertEquals("primi 4 KB", 4096, PoliticaCaricamento.CORPO_ERRORE_MASSIMO_BYTE);
        assertEquals("tetto 1 h", 3600L, PoliticaCaricamento.RETRY_AFTER_MASSIMO_SECONDI);
        assertEquals("±20%", 0.20, PoliticaCaricamento.SCARTO_ATTESA, 0.0);
        assertEquals(600L, PoliticaCaricamento.ATTESA_RETE_NEL_WORKER_SECONDI);
        assertEquals(60L, PoliticaCaricamento.SOGLIA_LOG_ATTESA_RETE_SECONDI);
        assertEquals(34, PoliticaCaricamento.SDK_PRIMO_UIDT);
    }

    @Test
    public void ilMimeValidoSegueLaFormaPermissivaDelServer() {
        for (String mime : new String[]{"video/mp4", "video/quicktime", "VIDEO/MP4", "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
                "video/mp4 ; codecs=avc1", "application/octet-stream", "video/x-matroska", "a/b"}) {
            assertTrue(mime, PoliticaCaricamento.mimeValido(mime));
        }
        for (String mime : new String[]{null, "", "mp4", "video", "video/", "/mp4", "video/mp4\nx", "video mp4", "vi/ deo",
                "x/", repeat('a', 300) + "/b"}) {
            assertFalse("«" + mime + "»", PoliticaCaricamento.mimeValido(mime));
        }
    }
}
