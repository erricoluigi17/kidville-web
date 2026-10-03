package it.kidville.app.caricamenti;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import it.kidville.app.caricamenti.CodaCaricamenti.Origine;
import it.kidville.app.caricamenti.CodaCaricamenti.Testi;
import it.kidville.app.caricamenti.CodaCaricamenti.VoceCoda;
import it.kidville.app.caricamenti.EsecutoreCoda.EsitoPut;
import it.kidville.app.caricamenti.EsecutoreCoda.RispostaHttp;
import it.kidville.app.caricamenti.PianificatoreCaricamenti.CodiceRifiuto;
import it.kidville.app.caricamenti.PianificatoreCaricamenti.RifiutoAccodamento;
import it.kidville.app.caricamenti.PoliticaCaricamento.Motore;
import it.kidville.app.caricamenti.SegretiCaricamenti.Esito;
import it.kidville.app.caricamenti.SelettoreMedia.Preparati;
import it.kidville.app.caricamenti.SelettoreMedia.Preparato;
import it.kidville.app.caricamenti.SelettoreMedia.TipoElemento;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

/**
 * `accodaVideo` dal punto di vista del selettore (spec §4.3, §9; compito A3): ciò che si controlla fra il video preparato e il motore. Il
 * motore è quello VERO (`PianificatoreCaricamenti`, con la sua coda, i suoi segreti cifrati e il suo registro); il «sistema» (che programma
 * il guscio, mostra le notifiche) è un finto che non fa partire niente.
 *
 * Ogni rifiuto si prova con la stessa coppia di condizioni: il codice giusto, e «niente è cambiato» — la coda è vuota, nessun segreto è
 * stato scritto, l'elemento è ancora nel registro e il suo file ancora in `scelti/`, così il JavaScript può riprovare.
 */
public class AccodamentoPreparatiTest {

    @Rule
    public TemporaryFolder temporanea = new TemporaryFolder();

    private final AtomicLong ora = new AtomicLong(1_790_000_000_000L);
    private File cartella;
    private File scelti;
    private CodaCaricamenti coda;
    private RegistroNativo registroLog;
    private SegretiCaricamenti segreti;
    private PianificatoreCaricamenti motore;
    private Preparati preparati;

    private static final String HOST_STORAGE = "https://uimulkjyekgemjakmepp.supabase.co/storage/v1/object/upload/sign/video_processing/";
    private static final String URL_RINNOVO = "https://app.kidville.it/api/video-uploads/rinnovo";
    private static final String URL_REGISTRO = "https://app.kidville.it/api/logs";
    private static final String TOKEN = "kvr_" + "A".repeat(43);
    private static final String TOKEN_NUOVO = "kvr_" + "B".repeat(43);
    private static final long ORA_MS = 3_600_000L;

    private static String id(int n) {
        return String.format(Locale.ROOT, "%08x-1111-4111-8111-%012x", n, n);
    }

    private static final String UTENTE = id(2000);
    private static final String SCUOLA = id(3000);

    /** Il sistema finto: il guscio «si programma» (e basta), la pausa non si mostra a nessuno. */
    private static final class FintoSistema implements PianificatoreCaricamenti.Sistema {
        @Override
        public Motore motore() {
            return Motore.UIDT;
        }

        @Override
        public int sdk() {
            return 36;
        }

        @Override
        public boolean debug() {
            return false;
        }

        @Override
        public boolean programma(long byteDaSpedire, boolean subito) {
            return true;
        }

        @Override
        public void mostraPausa(Testi testi) {
        }

        @Override
        public void togliPausa() {
        }

        @Override
        public boolean notificheAutorizzate() {
            return true;
        }

        @Override
        public boolean inBackground() {
            return true;
        }

        @Override
        public void guasto(String evento, Throwable causa) {
        }
    }

    @Before
    public void preparaIlBanco() throws IOException {
        cartella = temporanea.newFolder("caricamenti");
        scelti = new File(cartella, "scelti");
        assertTrue(scelti.mkdirs());
        coda = new CodaCaricamenti(cartella, ora::get);
        registroLog = new RegistroNativo(new File(cartella, "registro.json"), "1.2+4", ora::get, (evento, causa) -> { });
        segreti = new SegretiCaricamenti(coda, new CifrarioSoftware());
        PianificatoreCaricamenti.Configurazione conf = new PianificatoreCaricamenti.Configurazione();
        conf.coda = coda;
        conf.registro = registroLog;
        conf.segreti = segreti;
        conf.put = richiesta -> EsitoPut.risposta(200, null, 0L, richiesta.byteTotali, 500L, true);
        conf.rinnovo = (url, token) -> RispostaHttp.nessunaRisposta(RegistroNativo.ClasseErrore.IO);
        conf.rete = new EsecutoreCoda.Rete() {
            @Override
            public boolean disponibile() {
                return true;
            }

            @Override
            public void attendi(long massimoMs) {
                ora.addAndGet(massimoMs);
            }
        };
        conf.sistema = new FintoSistema();
        conf.lavoratore = new PianificatoreCaricamenti.Lavoratore() {
            @Override
            public void esegui(Runnable lavoro) {
            }

            @Override
            public void esegui(Runnable lavoro, long ritardoMs) {
            }
        };
        conf.trasportoLog = (url, utenteId, corpo) -> new RegistroNativo.RispostaTrasporto(200, 0L);
        conf.orologio = ora::get;
        conf.casuale = () -> 0.5;
        motore = new PianificatoreCaricamenti(conf);
        preparati = new Preparati();
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * UTENSILI
     * ──────────────────────────────────────────────────────────────────────────── */

    /** Un video già preparato come lo lascia la scelta: il file in `scelti/<id>.mp4` e la sua voce nel registro. */
    private Preparato preparato(String idElemento, byte[] contenuto, Origine origine) throws Exception {
        File file = new File(scelti, idElemento + ".mp4");
        Files.write(file.toPath(), contenuto);
        Preparato p = new Preparato(idElemento, TipoElemento.VIDEO, file, contenuto.length, FintiDelSelettore.sha256(contenuto), "video/mp4",
                "Il mio video.mp4", 0, 0, origine);
        preparati.aggiungi(p);
        return p;
    }

    private JSONObject richiesta(Preparato p, int job) throws Exception {
        return richiesta(p.id, p.sha256, p.byteTotali, job, TOKEN);
    }

    private JSONObject richiesta(String idElemento, String sha256, long byteAttesi, int job, String token) throws Exception {
        return new JSONObject()
                .put("idElemento", idElemento)
                .put("sha256", sha256)
                .put("byteAttesi", byteAttesi)
                .put("jobId", id(job))
                .put("intentId", id(1000 + job))
                .put("utenteId", UTENTE)
                .put("scuolaId", SCUOLA)
                .put("caricamento", new JSONObject()
                        .put("url", HOST_STORAGE + "percorso/" + job + ".mp4?token=firma")
                        .put("contentType", "video/mp4")
                        .put("scadeIl", CodaCaricamenti.isoUtc(ora.get() + 2 * ORA_MS)))
                .put("rinnovo", new JSONObject()
                        .put("url", URL_RINNOVO)
                        .put("token", token)
                        .put("scadeIl", CodaCaricamenti.isoUtc(ora.get() + 48 * ORA_MS)))
                .put("registro", new JSONObject().put("url", URL_REGISTRO))
                .put("testi", new JSONObject()
                        .put("titolo", "Kidville")
                        .put("invio", "Invio dei video in corso")
                        .put("attesaRete", "Il video è in attesa di rete: riprenderà da solo")
                        .put("pausa", "Invio in pausa: tocca per riprendere"));
    }

    private JSONObject accoda(JSONObject dati) throws RifiutoAccodamento {
        return SelettoreMedia.accodaPreparato(motore, preparati, dati);
    }

    private CodiceRifiuto rifiutoDi(JSONObject dati) {
        try {
            accoda(dati);
        } catch (RifiutoAccodamento rifiuto) {
            assertEquals("il messaggio è il solo codice", rifiuto.codice.name(), rifiuto.getMessage());
            return rifiuto.codice;
        }
        fail("doveva rifiutare");
        return null;
    }

    private void assertNienteECambiato(Preparato p, int jobId) {
        assertEquals("nessuna voce in coda", 0, coda.numeroVoci());
        assertFalse("nessun segreto scritto", coda.fileSegreto(id(jobId)).exists());
        assertTrue("il file è ancora in scelti/", p.file.isFile());
        assertNotNull("l'elemento è ancora nel registro", preparati.trova(p.id));
        assertEquals(0, new File(cartella, "file").list() == null ? 0 : new File(cartella, "file").list().length);
    }

    private static byte[] byteDelVideo(int n) {
        return FintiDelSelettore.casuali(40_000, 500 + n);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * L'ACCODAMENTO RIESCE
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void unVideoPreparatoSiAccodaEIlFileSiSposta() throws Exception {
        byte[] contenuto = byteDelVideo(1);
        Preparato p = preparato("g-" + UUID.randomUUID(), contenuto, Origine.GALLERIA);

        JSONObject voce = accoda(richiesta(p, 1));

        assertEquals(id(1), voce.getString("jobId"));
        assertEquals(id(1001), voce.getString("intentId"));
        assertEquals(UTENTE, voce.getString("utenteId"));
        assertEquals("in-coda", voce.getString("stato"));
        assertEquals("Il mio video.mp4", voce.getString("nome"));
        assertEquals(contenuto.length, voce.getLong("byteTotali"));
        assertEquals("video/mp4", voce.getString("mime"));
        File copia = new File(cartella, "file/" + id(1) + ".mp4");
        assertTrue("il file è stato spostato in file/<job>.<estensione>", copia.isFile());
        assertEquals(contenuto.length, copia.length());
        assertFalse("e non c'è più in scelti/", p.file.exists());
        assertNull("l'elemento è consumato: esce dal registro", preparati.trova(p.id));
        VoceCoda inCoda = coda.trova(id(1));
        assertEquals(Origine.GALLERIA, inCoda.origine);
        assertEquals("il nome del file arriva dall'elemento, non dal JavaScript", "Il mio video.mp4", inCoda.nome);
        assertEquals("i testi delle notifiche li ha passati il JavaScript", "Kidville", coda.testi().titolo);
        // I segreti sono cifrati nel loro file, con il token e l'indirizzo della PUT.
        assertEquals(Esito.OK, segreti.leggi(id(1)).esito);
        assertEquals(TOKEN, segreti.leggi(id(1)).segreti.token);
    }

    @Test
    public void lOrigineDellaVoceVieneDalRegistroDegliElementi() throws Exception {
        Preparato dalFile = preparato("f-" + UUID.randomUUID(), byteDelVideo(2), Origine.FILE);
        accoda(richiesta(dalFile, 2));
        assertEquals(Origine.FILE, coda.trova(id(2)).origine);
        Preparato prova = preparato("p-" + UUID.randomUUID(), byteDelVideo(3), Origine.PROVA);
        accoda(richiesta(prova, 3));
        assertEquals(Origine.PROVA, coda.trova(id(3)).origine);
    }

    @Test
    public void unElementoDiProvaCreatoDalSelettoreSiAccoda() throws Exception {
        JSONObject elemento = SelettoreMedia.creaProva(preparati, scelti, 70_000L);
        JSONObject voce = accoda(richiesta(elemento.getString("id"), elemento.getString("sha256"), 70_000L, 4, TOKEN));
        assertEquals("in-coda", voce.getString("stato"));
        assertEquals(70_000L, voce.getLong("byteTotali"));
        assertEquals(Origine.PROVA, coda.trova(id(4)).origine);
    }

    @Test
    public void accodareRicordaLUtenteDelLog() throws Exception {
        Preparato p = preparato("g-" + UUID.randomUUID(), byteDelVideo(5), Origine.GALLERIA);
        accoda(richiesta(p, 5));
        assertEquals(UUID.fromString(UTENTE), SelettoreMedia.utenteDiRiferimento());
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * L'ELEMENTO NON È QUELLO
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void unaImprontaDiversaDaQuellaDelloSceltoDaElementoDiverso() throws Exception {
        Preparato p = preparato("g-" + UUID.randomUUID(), byteDelVideo(6), Origine.GALLERIA);
        String altra = FintiDelSelettore.sha256(new byte[]{1, 2, 3});
        assertEquals(CodiceRifiuto.ELEMENTO_DIVERSO, rifiutoDi(richiesta(p.id, altra, p.byteTotali, 6, TOKEN)));
        assertNienteECambiato(p, 6);
        // L'impronta con una sola lettera diversa.
        String quasi = (p.sha256.charAt(0) == 'a' ? "b" : "a") + p.sha256.substring(1);
        assertEquals(CodiceRifiuto.ELEMENTO_DIVERSO, rifiutoDi(richiesta(p.id, quasi, p.byteTotali, 6, TOKEN)));
        assertNienteECambiato(p, 6);
    }

    @Test
    public void unPesoDiversoDaQuelloDelloSceltoDaElementoDiverso() throws Exception {
        Preparato p = preparato("g-" + UUID.randomUUID(), byteDelVideo(7), Origine.GALLERIA);
        assertEquals(CodiceRifiuto.ELEMENTO_DIVERSO, rifiutoDi(richiesta(p.id, p.sha256, p.byteTotali + 1, 7, TOKEN)));
        assertEquals(CodiceRifiuto.ELEMENTO_DIVERSO, rifiutoDi(richiesta(p.id, p.sha256, p.byteTotali - 1, 7, TOKEN)));
        assertNienteECambiato(p, 7);
    }

    @Test
    public void unaFotoNonSiAccodaComeVideo() throws Exception {
        File jpg = new File(scelti, "g-foto.jpg");
        Files.write(jpg.toPath(), new byte[500]);
        preparati.aggiungi(new Preparato("g-foto", TipoElemento.FOTO, jpg, 500L, null, "image/jpeg", "foto", 10, 10, Origine.GALLERIA));
        assertEquals(CodiceRifiuto.ELEMENTO_DIVERSO, rifiutoDi(richiesta("g-foto", FintiDelSelettore.sha256(new byte[500]), 500L, 8, TOKEN)));
        assertEquals(0, coda.numeroVoci());
        assertTrue(jpg.isFile());
    }

    @Test
    public void unElementoSconosciutoSenzaVoceVivaDaElementoAssente() throws Exception {
        assertEquals(CodiceRifiuto.ELEMENTO_ASSENTE, rifiutoDi(richiesta("g-mai-visto", FintiDelSelettore.sha256(new byte[1]), 1L, 9, TOKEN)));
        assertEquals(0, coda.numeroVoci());
        assertFalse(coda.fileSegreto(id(9)).exists());
    }

    @Test
    public void unElementoNelRegistroConIlFileSparitoDaElementoAssenteEUsciDalRegistro() throws Exception {
        Preparato p = preparato("g-" + UUID.randomUUID(), byteDelVideo(10), Origine.GALLERIA);
        assertTrue(p.file.delete());
        assertEquals(CodiceRifiuto.ELEMENTO_ASSENTE, rifiutoDi(richiesta(p, 10)));
        assertNull("un elemento senza file non resta nel registro", preparati.trova(p.id));
        assertEquals(0, coda.numeroVoci());
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * PARAMETRI E HOST
     * ──────────────────────────────────────────────────────────────────────────── */

    private void assertParametriNonValidi(String perche, JSONObject dati, Preparato p, int job) {
        assertEquals(perche, CodiceRifiuto.PARAMETRI_NON_VALIDI, rifiutoDi(dati));
        assertNienteECambiato(p, job);
    }

    @Test
    public void unaRichiestaFuoriFormaSiRifiutaSenzaCambiareNiente() throws Exception {
        Preparato p = preparato("g-" + UUID.randomUUID(), byteDelVideo(11), Origine.GALLERIA);
        for (String campo : new String[]{"idElemento", "sha256", "byteAttesi", "jobId", "intentId", "utenteId", "scuolaId", "caricamento", "rinnovo", "registro"}) {
            JSONObject senza = richiesta(p, 11);
            senza.remove(campo);
            assertParametriNonValidi("manca " + campo, senza, p, 11);
        }
        for (String[] annidato : new String[][]{{"caricamento", "url"}, {"caricamento", "contentType"}, {"rinnovo", "url"}, {"rinnovo", "token"},
                {"rinnovo", "scadeIl"}, {"registro", "url"}}) {
            JSONObject senza = richiesta(p, 11);
            senza.getJSONObject(annidato[0]).remove(annidato[1]);
            assertParametriNonValidi("manca " + annidato[0] + "." + annidato[1], senza, p, 11);
        }
        assertParametriNonValidi("sha256 maiuscolo", richiesta(p.id, p.sha256.toUpperCase(Locale.ROOT), p.byteTotali, 11, TOKEN), p, 11);
        assertParametriNonValidi("sha256 corto", richiesta(p.id, p.sha256.substring(1), p.byteTotali, 11, TOKEN), p, 11);
        assertParametriNonValidi("sha256 non esadecimale", richiesta(p.id, "z".repeat(64), p.byteTotali, 11, TOKEN), p, 11);
        assertParametriNonValidi("id elemento con un separatore", richiesta("../x", p.sha256, p.byteTotali, 11, TOKEN), p, 11);
        assertParametriNonValidi("peso zero", richiesta(p.id, p.sha256, 0, 11, TOKEN), p, 11);
        assertParametriNonValidi("peso negativo", richiesta(p.id, p.sha256, -5, 11, TOKEN), p, 11);
        assertParametriNonValidi("peso oltre i 2 GB", richiesta(p.id, p.sha256, 2_000_000_001L, 11, TOKEN), p, 11);
        assertParametriNonValidi("peso non intero", richiesta(p.id, p.sha256, 1, 11, TOKEN).put("byteAttesi", 40_000.5), p, 11);
        assertParametriNonValidi("peso testo", richiesta(p, 11).put("byteAttesi", "40000"), p, 11);
        assertParametriNonValidi("token fuori forma", richiesta(p.id, p.sha256, p.byteTotali, 11, "token-qualunque"), p, 11);
        assertParametriNonValidi("job che non è un uuid", richiesta(p, 11).put("jobId", "non-un-uuid"), p, 11);
        assertParametriNonValidi("testi di un tipo sbagliato", richiesta(p, 11).put("testi", "ciao"), p, 11);
        assertParametriNonValidi("scadenza del token non ISO", richiesta(p, 11).put("rinnovo", new JSONObject().put("url", URL_RINNOVO).put("token", TOKEN)
                .put("scadeIl", "domani")), p, 11);
        assertParametriNonValidi("assente", null, p, 11);
    }

    @Test
    public void unHostFuoriElencoSiRifiutaEIlPreparatoResta() throws Exception {
        Preparato p = preparato("g-" + UUID.randomUUID(), byteDelVideo(12), Origine.GALLERIA);
        JSONObject putAltrove = richiesta(p, 12);
        putAltrove.getJSONObject("caricamento").put("url", "https://evil.example.com/storage/v1/object/upload/sign/x?token=y");
        assertEquals(CodiceRifiuto.HOST_NON_AMMESSO, rifiutoDi(putAltrove));
        assertNienteECambiato(p, 12);

        JSONObject rinnovoAltrove = richiesta(p, 12);
        rinnovoAltrove.getJSONObject("rinnovo").put("url", "https://evil.example.com/api/video-uploads/rinnovo");
        assertEquals("il token di rinnovo non parte verso un altro sito", CodiceRifiuto.HOST_NON_AMMESSO, rifiutoDi(rinnovoAltrove));
        assertNienteECambiato(p, 12);

        JSONObject logAltrove = richiesta(p, 12);
        logAltrove.getJSONObject("registro").put("url", "http://app.kidville.it/api/logs");
        assertEquals("in chiaro mai, in Release", CodiceRifiuto.HOST_NON_AMMESSO, rifiutoDi(logAltrove));
        assertNienteECambiato(p, 12);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * L'APERTURA RIPETUTA
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void lAperturaRipetutaSostituisceISegretiNonSpostaNienteECancellaLaCopiaRipreparata() throws Exception {
        byte[] contenuto = byteDelVideo(13);
        Preparato prima = preparato("g-" + UUID.randomUUID(), contenuto, Origine.GALLERIA);
        accoda(richiesta(prima, 13));
        File copiaDelMotore = new File(cartella, "file/" + id(13) + ".mp4");
        assertTrue(copiaDelMotore.isFile());
        assertEquals(TOKEN, segreti.leggi(id(13)).segreti.token);

        // L'insegnante rimanda lo STESSO video agli stessi bambini: stessa chiave, stesso job, token ruotato. La scelta ha ripreparato una
        // seconda copia (stessi byte, stessa impronta, un altro id).
        Preparato seconda = preparato("g-" + UUID.randomUUID(), contenuto, Origine.GALLERIA);
        assertEquals(prima.sha256, seconda.sha256);
        JSONObject voce = accoda(richiesta(seconda.id, seconda.sha256, seconda.byteTotali, 13, TOKEN_NUOVO));

        assertEquals(id(13), voce.getString("jobId"));
        assertEquals("sempre lo stesso job: una voce sola", 1, coda.numeroVoci());
        assertEquals("il token è ruotato: il vecchio non vale più", TOKEN_NUOVO, segreti.leggi(id(13)).segreti.token);
        assertTrue("la copia del motore è rimasta dov'era", copiaDelMotore.isFile());
        assertFalse("la copia ripreparata non serve più: 2 GB di spazio non restano in scelti/ per 24 ore", seconda.file.exists());
        assertNull(preparati.trova(seconda.id));
    }

    @Test
    public void lAperturaRipetutaFunzionaAncheSeLElementoEGiaStatoConsumato() throws Exception {
        Preparato p = preparato("g-" + UUID.randomUUID(), byteDelVideo(14), Origine.GALLERIA);
        accoda(richiesta(p, 14));
        assertNull(preparati.trova(p.id));
        // Stesso job, e l'elemento non c'è più (consumato dalla prima chiamata): la voce è viva, quindi niente ELEMENTO_ASSENTE.
        JSONObject voce = accoda(richiesta(p.id, p.sha256, p.byteTotali, 14, TOKEN_NUOVO));
        assertEquals(id(14), voce.getString("jobId"));
        assertEquals(1, coda.numeroVoci());
        assertEquals(TOKEN_NUOVO, segreti.leggi(id(14)).segreti.token);
    }

    @Test
    public void unaCopiaRipreparataDiUnVideoDiversoNonSiCancella() throws Exception {
        Preparato prima = preparato("g-" + UUID.randomUUID(), byteDelVideo(15), Origine.GALLERIA);
        accoda(richiesta(prima, 15));
        // Stesso job (per costruzione del test), ma l'elemento nuovo pesa un'altra cosa: il motore non lo ha consumato, e non è la copia di quel
        // video. Non si cancella: la pulizia delle 24 ore se ne occuperà.
        byte[] altro = FintiDelSelettore.casuali(12_345, 99);
        Preparato diverso = preparato("g-" + UUID.randomUUID(), altro, Origine.GALLERIA);
        accoda(richiesta(diverso.id, diverso.sha256, diverso.byteTotali, 15, TOKEN_NUOVO));
        assertTrue("non è la copia di quel video", diverso.file.isFile());
    }

    @Test
    public void unaVoceTerminaleSostituitaDaUnaNuovaAperturaRiparteConIlSuoFile() throws Exception {
        byte[] contenuto = byteDelVideo(16);
        Preparato prima = preparato("g-" + UUID.randomUUID(), contenuto, Origine.GALLERIA);
        accoda(richiesta(prima, 16));
        assertTrue(motore.annulla(id(16)));
        assertEquals("annullato", coda.trova(id(16)).stato.valore());

        Preparato seconda = preparato("g-" + UUID.randomUUID(), contenuto, Origine.GALLERIA);
        JSONObject voce = accoda(richiesta(seconda.id, seconda.sha256, seconda.byteTotali, 16, TOKEN_NUOVO));
        assertEquals("in-coda", voce.getString("stato"));
        assertTrue(new File(cartella, "file/" + id(16) + ".mp4").isFile());
        assertFalse("qui il motore ha consumato il file: nessuna copia da cancellare", seconda.file.exists());
        assertNull(preparati.trova(seconda.id));
    }

    @Test
    public void iTestiDelleNotificheVengonoDalJavaScriptEHannoIlRipiegoSeMancano() throws Exception {
        Preparato p = preparato("g-" + UUID.randomUUID(), byteDelVideo(17), Origine.GALLERIA);
        JSONObject dati = richiesta(p, 17);
        dati.remove("testi");
        accoda(dati);
        Testi t = coda.testi();
        assertEquals("senza testi il ripiego italiano", Testi.predefiniti().titolo, t.titolo);
        assertEquals(Testi.predefiniti().invio, t.invio);

        Preparato q = preparato("g-" + UUID.randomUUID(), byteDelVideo(18), Origine.GALLERIA);
        JSONObject conTesti = richiesta(q, 18);
        conTesti.put("testi", new JSONObject().put("titolo", "Kidville").put("invio", "Sending videos").put("attesaRete", "Waiting for network")
                .put("pausa", "Paused"));
        accoda(conTesti);
        assertEquals("Sending videos", coda.testi().invio);
        assertEquals("Paused", coda.testi().pausa);
    }

    @Test
    public void ilRegistroDeiLogDelMotoreDiceIlVideoAccodato() throws Exception {
        Preparato p = preparato("g-" + UUID.randomUUID(), byteDelVideo(19), Origine.GALLERIA);
        accoda(richiesta(p, 19));
        List<String> messaggi = new ArrayList<>();
        for (RegistroNativo.EventoRegistrato e : registroLog.eventi()) messaggi.add(e.messaggio);
        assertTrue(messaggi.toString(), messaggi.contains("video-nativo-accodato: job=" + id(19)));
        assertEquals("una riga sola per un accodamento", 1, messaggi.size());
    }
}
