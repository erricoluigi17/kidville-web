package it.kidville.app.caricamenti;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import it.kidville.app.caricamenti.CodaCaricamenti.Origine;
import it.kidville.app.caricamenti.CodaCaricamenti.Testi;
import it.kidville.app.caricamenti.CodaCaricamenti.VoceCoda;
import it.kidville.app.caricamenti.EsecutoreCoda.EsitoCiclo;
import it.kidville.app.caricamenti.EsecutoreCoda.EsitoPut;
import it.kidville.app.caricamenti.EsecutoreCoda.RichiestaPut;
import it.kidville.app.caricamenti.EsecutoreCoda.RispostaHttp;
import it.kidville.app.caricamenti.PianificatoreCaricamenti.CodiceRifiuto;
import it.kidville.app.caricamenti.PianificatoreCaricamenti.RichiestaAccodamento;
import it.kidville.app.caricamenti.PianificatoreCaricamenti.RifiutoAccodamento;
import it.kidville.app.caricamenti.PianificatoreCaricamenti.RisultatoAccodamento;
import it.kidville.app.caricamenti.PoliticaCaricamento.Codice;
import it.kidville.app.caricamenti.PoliticaCaricamento.EventoStato;
import it.kidville.app.caricamenti.PoliticaCaricamento.Motore;
import it.kidville.app.caricamenti.PoliticaCaricamento.Stato;
import it.kidville.app.caricamenti.RegistroNativo.EventoRegistrato;
import it.kidville.app.caricamenti.RegistroNativo.RispostaTrasporto;
import it.kidville.app.caricamenti.SegretiCaricamenti.Esito;
import it.kidville.app.caricamenti.SegretiCaricamenti.Segreti;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Deque;
import java.util.List;
import java.util.Locale;
import java.util.Random;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Function;

/**
 * Il motore dei caricamenti (spec §4.1, §4.3, §6.1, §6.2, §8.1, §9; compito A2): `accodaVideo` con tutti i suoi rifiuti, l'idempotenza, i
 * due ordini che contano (segreti prima della voce, guscio dopo), la pausa quando il guscio non si può avviare, il ritorno in primo
 * piano, l'avvio con una coda guasta, lo svuotamento del registro e la lettura delle date ISO.
 *
 * Il «sistema» è un finto: programma il guscio a comando, mostra la pausa su una lista, lascia girare il lavoro del registro quando il
 * test lo chiede. La coda, i segreti (cifrario software) e il registro sono veri.
 */
public class PianificatoreCaricamentiTest {

    @Rule
    public TemporaryFolder temporanea = new TemporaryFolder();

    private final AtomicLong ora = new AtomicLong(1_790_000_000_000L);
    private File cartella;
    private CodaCaricamenti coda;
    private RegistroNativo registro;
    private CifrarioSoftware cifrario;
    private SegretiCaricamenti segreti;
    private FintoSistema sistema;
    private FintoLavoratore lavoratore;
    private FintoTrasportoLog trasportoLog;
    private FintaPut put;
    private PianificatoreCaricamenti motore;
    private final List<String> guastiDiRegistro = Collections.synchronizedList(new ArrayList<String>());

    private static final long ORA_MS = 3_600_000L;
    private static final int PESO = 4_000;
    private static final String TOKEN = "kvr_" + "A".repeat(43);
    private static final String TOKEN_NUOVO = "kvr_" + "B".repeat(43);
    private static final String HOST_STORAGE = "https://uimulkjyekgemjakmepp.supabase.co/storage/v1/object/upload/sign/video_processing/";
    private static final String URL_RINNOVO = "https://app.kidville.it/api/video-uploads/rinnovo";
    private static final String URL_REGISTRO = "https://app.kidville.it/api/logs";
    private static final Testi TESTI = new Testi("Kidville", "Invio dei video in corso", "Il video è in attesa di rete: riprenderà da solo", "Invio in pausa: tocca per riprendere");

    private static String id(int n) {
        return String.format(Locale.ROOT, "%08x-1111-4111-8111-%012x", n, n);
    }

    private static final String UTENTE = id(2000);
    private static final String ALTRO_UTENTE = id(2001);
    private static final String SCUOLA = id(3000);

    /* ────────────────────────────────────────────────────────────────────────────
     * I FINTI
     * ──────────────────────────────────────────────────────────────────────────── */

    private final class FintoSistema implements PianificatoreCaricamenti.Sistema {
        volatile Motore motore = Motore.UIDT;
        volatile int sdk = 36;
        volatile boolean debug = false;
        volatile boolean programmabile = true;
        volatile RuntimeException lanciaAllaProgrammazione = null;
        volatile boolean inBackground = true;
        volatile boolean autorizzate = true;
        final List<Long> programmazioni = Collections.synchronizedList(new ArrayList<Long>());
        /** Per ogni programmazione, se era «subito» (ritorno in primo piano). */
        final List<Boolean> subito = Collections.synchronizedList(new ArrayList<Boolean>());
        final List<Testi> pause = Collections.synchronizedList(new ArrayList<Testi>());
        final AtomicInteger pauseTolte = new AtomicInteger();
        final List<String> guasti = Collections.synchronizedList(new ArrayList<String>());
        /** Cosa fa il guscio quando lo si programma: di norma niente (il test lo fa girare a mano). */
        volatile Runnable alGuscioProgrammato = null;

        @Override
        public Motore motore() {
            return motore;
        }

        @Override
        public int sdk() {
            return sdk;
        }

        @Override
        public boolean debug() {
            return debug;
        }

        @Override
        public boolean programma(long byteDaSpedire, boolean subito) {
            if (lanciaAllaProgrammazione != null) throw lanciaAllaProgrammazione;
            programmazioni.add(byteDaSpedire);
            this.subito.add(subito);
            Runnable r = alGuscioProgrammato;
            if (programmabile && r != null) r.run();
            return programmabile;
        }

        @Override
        public void mostraPausa(Testi testi) {
            pause.add(testi);
        }

        @Override
        public void togliPausa() {
            pauseTolte.incrementAndGet();
        }

        @Override
        public boolean notificheAutorizzate() {
            return autorizzate;
        }

        @Override
        public boolean inBackground() {
            return inBackground;
        }

        @Override
        public void guasto(String evento, Throwable causa) {
            guasti.add(evento + ":" + causa.getClass().getSimpleName());
        }
    }

    private static final class FintoLavoratore implements PianificatoreCaricamenti.Lavoratore {
        final Deque<Runnable> subito = new ArrayDeque<>();
        final List<Object[]> ritardati = new ArrayList<>();

        @Override
        public synchronized void esegui(Runnable lavoro) {
            subito.add(lavoro);
        }

        @Override
        public synchronized void esegui(Runnable lavoro, long ritardoMs) {
            ritardati.add(new Object[]{lavoro, ritardoMs});
        }

        synchronized int inCoda() {
            return subito.size();
        }

        /** Fa girare ciò che è in coda (non i ritardati). */
        void eseguiSubito() {
            for (;;) {
                Runnable r;
                synchronized (this) {
                    r = subito.poll();
                }
                if (r == null) return;
                r.run();
            }
        }

        /** Fa girare il primo ritardato, e dice con quale ritardo era stato chiesto. */
        long eseguiIlPrimoRitardato() {
            Object[] voce;
            synchronized (this) {
                voce = ritardati.remove(0);
            }
            ((Runnable) voce[0]).run();
            return (Long) voce[1];
        }
    }

    private static final class FintoTrasportoLog implements RegistroNativo.Trasporto {
        final List<String[]> chiamate = Collections.synchronizedList(new ArrayList<String[]>());
        final Deque<Object> risposte = new ArrayDeque<>();

        @Override
        public RispostaTrasporto invia(String url, String utenteId, byte[] corpoJson) throws IOException {
            chiamate.add(new String[]{url, utenteId, new String(corpoJson, StandardCharsets.UTF_8)});
            Object prossima = risposte.pollFirst();
            if (prossima == null) return new RispostaTrasporto(200, 0L);
            if (prossima instanceof IOException) throw (IOException) prossima;
            return (RispostaTrasporto) prossima;
        }
    }

    private static final class FintaPut implements EsecutoreCoda.TrasportoPut {
        final List<RichiestaPut> richieste = Collections.synchronizedList(new ArrayList<RichiestaPut>());
        volatile Function<RichiestaPut, EsitoPut> comportamento = r -> EsitoPut.risposta(200, null, 0L, r.byteTotali, 500L, true);

        @Override
        public EsitoPut invia(RichiestaPut richiesta) {
            richieste.add(richiesta);
            return comportamento.apply(richiesta);
        }
    }

    @Before
    public void preparaIlBanco() throws IOException {
        cartella = temporanea.newFolder("caricamenti");
        coda = new CodaCaricamenti(cartella, ora::get);
        registro = new RegistroNativo(new File(cartella, "registro.json"), "1.2+6", ora::get, (evento, causa) -> guastiDiRegistro.add(evento));
        cifrario = new CifrarioSoftware();
        segreti = new SegretiCaricamenti(coda, cifrario);
        sistema = new FintoSistema();
        lavoratore = new FintoLavoratore();
        trasportoLog = new FintoTrasportoLog();
        put = new FintaPut();
        motore = nuovoMotore(coda, registro, segreti);
    }

    private PianificatoreCaricamenti nuovoMotore(CodaCaricamenti c, RegistroNativo r, SegretiCaricamenti s) {
        PianificatoreCaricamenti.Configurazione conf = new PianificatoreCaricamenti.Configurazione();
        conf.coda = c;
        conf.registro = r;
        conf.segreti = s;
        conf.put = put;
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
        conf.sistema = sistema;
        conf.lavoratore = lavoratore;
        conf.trasportoLog = trasportoLog;
        conf.orologio = ora::get;
        conf.casuale = () -> 0.5;
        return new PianificatoreCaricamenti(conf);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * UTENSILI
     * ──────────────────────────────────────────────────────────────────────────── */

    private File nuovoPreparato(int n, int byteTotali) throws IOException {
        File preparato = new File(cartella, "scelti/preparato-" + n + ".mp4");
        preparato.getParentFile().mkdirs();
        try (FileOutputStream uscita = new FileOutputStream(preparato)) {
            uscita.write(new byte[byteTotali]);
        }
        return preparato;
    }

    private RichiestaAccodamento richiesta(int n) throws IOException {
        return richiesta(n, nuovoPreparato(n, PESO));
    }

    private RichiestaAccodamento richiesta(int n, File preparato) {
        return new RichiestaAccodamento(id(n), id(1000 + n), UTENTE, SCUOLA, "Il mio video " + n + ".mp4", "video/mp4", PESO, Origine.GALLERIA, preparato,
                HOST_STORAGE + "path/" + n + ".mp4?token=primo", "video/mp4", CodaCaricamenti.isoUtc(ora.get() + 2 * ORA_MS), URL_RINNOVO, TOKEN,
                CodaCaricamenti.isoUtc(ora.get() + 48 * ORA_MS), URL_REGISTRO, TESTI);
    }

    private RichiestaAccodamento conCampi(RichiestaAccodamento r, String urlPut, String contentType, String urlRinnovo, String token, String tokenScadeIl,
                                          String urlRegistro, String urlPutScadeIl, String jobId, long byteAttesi, String mime) {
        return new RichiestaAccodamento(jobId != null ? jobId : r.jobId, r.intentId, r.utenteId, r.scuolaId, r.nome, mime != null ? mime : r.mime,
                byteAttesi >= 0 ? byteAttesi : r.byteAttesi, r.origine, r.preparato, urlPut != null ? urlPut : r.urlPut,
                contentType != null ? contentType : r.contentType, urlPutScadeIl != null ? urlPutScadeIl : r.urlPutScadeIl,
                urlRinnovo != null ? urlRinnovo : r.urlRinnovo, token != null ? token : r.token, tokenScadeIl != null ? tokenScadeIl : r.tokenScadeIl,
                urlRegistro != null ? urlRegistro : r.urlRegistro, r.testi);
    }

    private CodiceRifiuto rifiutoDi(RichiestaAccodamento r) {
        try {
            motore.accoda(r);
        } catch (RifiutoAccodamento rifiuto) {
            return rifiuto.codice;
        }
        fail("la richiesta doveva essere rifiutata");
        return null;
    }

    private List<String> messaggi() {
        List<String> risultato = new ArrayList<>();
        for (EventoRegistrato e : registro.eventi()) risultato.add(e.messaggio.replaceAll(": job=[0-9a-f-]{36}", "").replaceAll(" job=[0-9a-f-]{36}", ""));
        return risultato;
    }

    private EventoRegistrato evento(String prefisso) {
        for (EventoRegistrato e : registro.eventi()) if (e.messaggio.startsWith(prefisso)) return e;
        throw new AssertionError("nessun evento «" + prefisso + "» fra " + messaggi());
    }

    private void verificaCheNienteSiaCambiato(File preparato) {
        assertEquals("nessuna voce", 0, coda.numeroVoci());
        assertTrue("il preparato è ancora dov'era", preparato == null || preparato.isFile());
        File[] segretiRimasti = new File(cartella, "segreti").listFiles();
        assertTrue("nessun segreto salvato", segretiRimasti == null || segretiRimasti.length == 0);
        File[] copie = new File(cartella, "file").listFiles();
        assertTrue("nessuna copia in file/", copie == null || copie.length == 0);
        assertEquals("nessun evento", 0, registro.numeroEventi());
        assertEquals("nessun guscio programmato", 0, sistema.programmazioni.size());
    }

    private static boolean contiene(String testo, String... aghi) {
        for (String ago : aghi) if (testo.contains(ago)) return true;
        return false;
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * `accodaVideo`: IL SUCCESSO
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void accodareUnVideoCreaLaVoceSpostaIlFileSalvaISegretiScriveIlLogEProgrammaIlGuscio() throws Exception {
        File preparato = nuovoPreparato(1, PESO);
        RisultatoAccodamento r = motore.accoda(richiesta(1, preparato));
        assertFalse(r.giaPresente);

        // La voce nella forma del ponte: i quattordici campi di `CaricamentoNativo`.
        JSONObject json = r.voce;
        assertEquals(14, json.length());
        assertEquals(id(1), json.getString("jobId"));
        assertEquals(id(1001), json.getString("intentId"));
        assertEquals(UTENTE, json.getString("utenteId"));
        assertEquals(SCUOLA, json.getString("scuolaId"));
        assertEquals("Il mio video 1.mp4", json.getString("nome"));
        assertEquals("video/mp4", json.getString("mime"));
        assertEquals("in-coda", json.getString("stato"));
        assertEquals(0L, json.getLong("byteInviati"));
        assertEquals(PESO, json.getLong("byteTotali"));
        assertTrue(json.isNull("codice"));

        // Il file è stato SPOSTATO (non copiato) nel percorso della voce.
        assertFalse("il preparato non c'è più in scelti/", preparato.exists());
        File copia = new File(cartella, "file/" + id(1) + ".mp4");
        assertTrue(copia.isFile());
        assertEquals(PESO, copia.length());

        // I segreti, cifrati, con tutto ciò che serve.
        SegretiCaricamenti.Lettura l = segreti.leggi(id(1));
        assertSame(Esito.OK, l.esito);
        assertEquals(TOKEN, l.segreti.token);
        assertEquals(HOST_STORAGE + "path/1.mp4?token=primo", l.segreti.urlPut);
        assertEquals("video/mp4", l.segreti.contentType);
        assertEquals(URL_RINNOVO, l.segreti.urlRinnovo);
        assertEquals(URL_REGISTRO, l.segreti.urlRegistro);

        // La coda: scadenze lette dalle date ISO, e NIENTE segreti nel JSON.
        VoceCoda voce = coda.trova(id(1));
        assertSame(Stato.IN_CODA, voce.stato);
        assertEquals(ora.get() + 48 * ORA_MS, voce.tokenScadeIl);
        assertEquals(ora.get() + 2 * ORA_MS, voce.urlScadeIl);
        assertEquals("file/" + id(1) + ".mp4", voce.file);
        String codaSuDisco = new String(Files.readAllBytes(new File(cartella, "coda.json").toPath()), StandardCharsets.UTF_8);
        assertFalse(contiene(codaSuDisco, TOKEN, "kvr_", "supabase", "https", "token=primo"));
        assertEquals("i testi passati dal JavaScript sono conservati", TESTI.attesaRete, coda.testi().attesaRete);

        // Il log: successo a livello warn, con byte, mime ed ambiente (il motore).
        EventoRegistrato accodato = evento("video-nativo-accodato");
        assertEquals(UTENTE, accodato.utenteId);
        assertEquals((long) PESO, ((Number) accodato.campi.get("byte")).longValue());
        assertEquals("video/mp4", accodato.campi.get("mime"));
        assertEquals("uidt", accodato.campi.get("ambiente"));

        // Il guscio: programmato una volta, con la stima dei byte da spedire, e NON «subito» (accodare non sostituisce un lavoro in attesa).
        assertEquals(Arrays.asList((long) PESO), sistema.programmazioni);
        assertEquals(Arrays.asList(false), sistema.subito);
    }

    @Test
    public void lEstensioneDellaCopiaVieneDalPreparatoOAltrimentiDalMime() throws Exception {
        File mov = new File(cartella, "scelti/x.MOV");
        mov.getParentFile().mkdirs();
        assertEquals("mov", PianificatoreCaricamenti.estensioneDellaCopia(mov, "video/mp4"));
        assertEquals("niente punto: dal MIME", "mov", PianificatoreCaricamenti.estensioneDellaCopia(new File("senza-estensione"), "video/quicktime"));
        assertEquals("3gp", PianificatoreCaricamenti.estensioneDellaCopia(new File("a"), "video/3gpp"));
        assertEquals("webm", PianificatoreCaricamenti.estensioneDellaCopia(new File("a"), "video/webm"));
        assertEquals("mkv", PianificatoreCaricamenti.estensioneDellaCopia(new File("a"), "video/x-matroska"));
        assertEquals("mp4", PianificatoreCaricamenti.estensioneDellaCopia(new File("a"), "video/boh"));
        assertEquals("un'estensione troppo lunga o con caratteri strani si scarta", "mp4",
                PianificatoreCaricamenti.estensioneDellaCopia(new File("a.lunghissima"), "video/mp4"));
        assertEquals("mp4", PianificatoreCaricamenti.estensioneDellaCopia(new File("a.mp4;rm"), "video/mp4"));
    }

    @Test
    public void unPreparatoConEstensioneStranaDaUnaCopiaConEstensioneValida() throws Exception {
        File preparato = new File(cartella, "scelti/preparato-9.bin.tmp");
        preparato.getParentFile().mkdirs();
        try (FileOutputStream uscita = new FileOutputStream(preparato)) {
            uscita.write(new byte[PESO]);
        }
        motore.accoda(richiesta(9, preparato));
        VoceCoda v = coda.trova(id(9));
        assertTrue(v.file, v.file.matches("^file/" + id(9) + "\\.[a-z0-9]{1,5}$"));
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * `accodaVideo`: I RIFIUTI, E CHE NON LASCIANO NIENTE
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void inReleaseUnaPutAUnHostCheNonESupabaseSiRifiutaENonLasciaNiente() throws Exception {
        for (String url : new String[]{"http://abcd.supabase.co/x", "https://evil.example.com/x", "https://supabase.co/x", "https://x.supabase.co.evil.com/x",
                "https://user@abcd.supabase.co/x", "https://abcd.supabase.co:8443/x", "http://localhost:3100/x", "http://10.0.2.2:3100/x", "ftp://abcd.supabase.co/x"}) {
            File preparato = nuovoPreparato(1, PESO);
            RichiestaAccodamento r = conCampi(richiesta(1, preparato), url, null, null, null, null, null, null, null, -1, null);
            assertSame("«" + url + "»", CodiceRifiuto.HOST_NON_AMMESSO, rifiutoDi(r));
            verificaCheNienteSiaCambiato(preparato);
        }
    }

    @Test
    public void ilRinnovoEIlRegistroSoloVersoIlSitoInRelease() throws Exception {
        for (String url : new String[]{"http://app.kidville.it/api/logs", "https://evil.example.com/api/logs", "https://abcd.supabase.co/api/logs",
                "https://app.kidville.it.evil.com/api", "http://10.0.2.2:3101/api/logs", "https://x@app.kidville.it/api"}) {
            File preparato = nuovoPreparato(1, PESO);
            RichiestaAccodamento perIlRinnovo = conCampi(richiesta(1, preparato), null, null, url, null, null, null, null, null, -1, null);
            assertSame("rinnovo «" + url + "»", CodiceRifiuto.HOST_NON_AMMESSO, rifiutoDi(perIlRinnovo));
            RichiestaAccodamento perIlRegistro = conCampi(richiesta(1, preparato), null, null, null, null, null, url, null, null, -1, null);
            assertSame("registro «" + url + "»", CodiceRifiuto.HOST_NON_AMMESSO, rifiutoDi(perIlRegistro));
            verificaCheNienteSiaCambiato(preparato);
        }
    }

    @Test
    public void inDebugSiAmmettonoGliHostDelComputerEIlSitoMaNonAltro() throws Exception {
        sistema.debug = true;
        motore.accoda(conCampi(richiesta(1), null, null, "http://10.0.2.2:3101/api/video-uploads/rinnovo", null, null, "http://10.0.2.2:3101/api/logs", null, null, -1, null));
        assertSame(Esito.OK, segreti.leggi(id(1)).esito);
        File preparato = nuovoPreparato(2, PESO);
        assertSame("anche in Debug un host qualunque no", CodiceRifiuto.HOST_NON_AMMESSO,
                rifiutoDi(conCampi(richiesta(2, preparato), null, null, "http://evil.example.com:3101/api", null, null, null, null, null, -1, null)));
        assertTrue(preparato.isFile());
    }

    @Test
    public void unaRichiestaFuoriFormaSiRifiutaConParametriNonValidi() throws Exception {
        List<RichiestaAccodamento> cattive = new ArrayList<>();
        List<String> etichette = new ArrayList<>();
        File preparato = nuovoPreparato(1, PESO);
        RichiestaAccodamento buona = richiesta(1, preparato);
        String conLettere = "0000000a-1111-4111-8111-00000000000a";
        cattive.add(conCampi(buona, null, null, null, null, null, null, null, "NON-UN-UUID", -1, null));
        etichette.add("jobId che non è un uuid");
        cattive.add(conCampi(buona, null, null, null, null, null, null, null, conLettere.toUpperCase(Locale.ROOT), -1, null));
        etichette.add("uuid in maiuscolo");
        cattive.add(conCampi(buona, null, null, null, "token-senza-prefisso", null, null, null, null, -1, null));
        etichette.add("token senza prefisso");
        cattive.add(conCampi(buona, null, null, null, "kvr_corto", null, null, null, null, -1, null));
        etichette.add("token troppo corto");
        cattive.add(conCampi(buona, null, null, null, "kvr_" + "A".repeat(43) + "\r\nx-upsert: true", null, null, null, null, -1, null));
        etichette.add("token con un a capo (iniezione di un'intestazione)");
        cattive.add(conCampi(buona, null, "non-un-mime", null, null, null, null, null, null, -1, null));
        etichette.add("content-type non valido");
        cattive.add(conCampi(buona, null, "video/mp4\r\nx-upsert: true", null, null, null, null, null, null, -1, null));
        etichette.add("content-type con un a capo");
        cattive.add(conCampi(buona, null, null, null, null, null, null, null, null, -1, "boh"));
        etichette.add("mime del video non valido");
        cattive.add(conCampi(buona, null, null, null, null, null, null, null, null, 0, null));
        etichette.add("peso zero");
        cattive.add(conCampi(buona, null, null, null, null, null, null, null, null, 2_000_000_001L, null));
        etichette.add("peso oltre il tetto");
        cattive.add(conCampi(buona, null, null, null, null, "domani", null, null, null, -1, null));
        etichette.add("scadenza del token non ISO");
        cattive.add(conCampi(buona, null, null, null, null, null, null, "2026-13-45T00:00:00Z", null, -1, null));
        etichette.add("scadenza dell'URL impossibile");
        for (int i = 0; i < cattive.size(); i++) {
            assertSame(etichette.get(i), CodiceRifiuto.PARAMETRI_NON_VALIDI, rifiutoDi(cattive.get(i)));
            verificaCheNienteSiaCambiato(preparato);
        }
        try {
            motore.accoda(null);
            fail("una richiesta nulla non è valida");
        } catch (RifiutoAccodamento atteso) {
            assertSame(CodiceRifiuto.PARAMETRI_NON_VALIDI, atteso.codice);
        }
    }

    @Test
    public void ilMessaggioDelRifiutoEIlSoloCodiceMaiUnPercorsoUnUrlUnToken() throws Exception {
        RichiestaAccodamento r = conCampi(richiesta(1), "https://evil.example.com/x?token=segreto", null, null, null, null, null, null, null, -1, null);
        try {
            motore.accoda(r);
            fail();
        } catch (RifiutoAccodamento atteso) {
            assertEquals("HOST_NON_AMMESSO", atteso.getMessage());
        }
    }

    @Test
    public void unPreparatoCheNonCEPiuOCheNonPesaQuantoDettoSiRifiuta() throws Exception {
        assertSame(CodiceRifiuto.ELEMENTO_ASSENTE, rifiutoDi(richiesta(1, null)));
        assertSame(CodiceRifiuto.ELEMENTO_ASSENTE, rifiutoDi(richiesta(1, new File(cartella, "scelti/non-c-e.mp4"))));
        assertSame("una cartella non è un file", CodiceRifiuto.ELEMENTO_ASSENTE, rifiutoDi(richiesta(1, cartella)));
        File peso = nuovoPreparato(1, PESO + 1);
        assertSame(CodiceRifiuto.ELEMENTO_DIVERSO, rifiutoDi(richiesta(1, peso)));
        assertTrue("il file diverso resta dov'è", peso.isFile());
        assertEquals(0, coda.numeroVoci());
        assertEquals(0, sistema.programmazioni.size());
        assertEquals(0, registro.numeroEventi());
    }

    @Test
    public void seISegretiNonSiSalvanoNonCambiaNienteENonSiAccoda() throws Exception {
        SegretiCaricamenti cheNonCifra = new SegretiCaricamenti(coda, new SegretiCaricamenti.Cifrario() {
            @Override
            public byte[] cifra(byte[] chiaro, byte[] datiAssociati) throws java.security.GeneralSecurityException {
                throw new java.security.GeneralSecurityException("Keystore non disponibile");
            }

            @Override
            public byte[] decifra(byte[] cifrato, byte[] datiAssociati) {
                return cifrato;
            }
        });
        PianificatoreCaricamenti senzaKeystore = nuovoMotore(coda, registro, cheNonCifra);
        File preparato = nuovoPreparato(1, PESO);
        try {
            senzaKeystore.accoda(richiesta(1, preparato));
            fail();
        } catch (RifiutoAccodamento atteso) {
            assertSame(CodiceRifiuto.INTERNO, atteso.codice);
        }
        verificaCheNienteSiaCambiato(preparato);
        assertEquals("il guasto si dice in logcat con la sola classe", Arrays.asList("accoda-segreti:IOException"), sistema.guasti);
    }

    @Test
    public void seLaCodaNonSiScriveISegretiSiTolgonoEIlFileTornaInScelti() throws Exception {
        AtomicFileCheNonTrasloca nonTrasloca = new AtomicFileCheNonTrasloca(new File(cartella, "coda.json"), true);
        CodaCaricamenti codaCheNonTrasloca = new CodaCaricamenti(cartella, ora::get, nonTrasloca);
        SegretiCaricamenti segretiDellaNuova = new SegretiCaricamenti(codaCheNonTrasloca, cifrario);
        PianificatoreCaricamenti motoreCheNonScrive = nuovoMotore(codaCheNonTrasloca, registro, segretiDellaNuova);
        nonTrasloca.traslocaDavvero = false;      // da qui il disco «non rinomina»
        File preparato = nuovoPreparato(1, PESO);
        try {
            motoreCheNonScrive.accoda(richiesta(1, preparato));
            fail("un video che non si riesce a scrivere in coda non va dichiarato accodato");
        } catch (RifiutoAccodamento atteso) {
            assertSame(CodiceRifiuto.INTERNO, atteso.codice);
        }
        assertEquals(0, codaCheNonTrasloca.numeroVoci());
        assertTrue("il preparato è tornato in scelti/", preparato.isFile());
        assertFalse("nessuna copia in file/", new File(cartella, "file/" + id(1) + ".mp4").exists());
        assertFalse("i segreti salvati prima sono stati tolti", codaCheNonTrasloca.fileSegreto(id(1)).exists());
        assertEquals(0, registro.numeroEventi());
        assertEquals(0, sistema.programmazioni.size());
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IDEMPOTENZA E SOSTITUZIONE DI UNA TERMINALE
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void accodareDiNuovoLoStessoJobSostituisceISegretiENonSpostaIlSecondoPreparato() throws Exception {
        motore.accoda(richiesta(1));
        coda.transita(id(1), EventoStato.AVVIATO, null);
        coda.transita(id(1), EventoStato.IN_ATTESA_DI_RETE, Codice.SERVER);
        coda.modifica(id(1), v -> v.prossimoTentativoIl = ora.get() + 900_000L);
        coda.modifica(id(1), v -> v.rinnoviConsecutivi = 2);
        int eventiPrima = registro.numeroEventi();

        // L'apertura ripetuta: stesso job, token RUOTATO, un nuovo preparato (l'insegnante ha ripreparato lo stesso video).
        File secondo = nuovoPreparato(1, PESO);
        long scadenzaNuova = ora.get() + 10 * ORA_MS;
        RichiestaAccodamento ripetuta = conCampi(richiesta(1, secondo), HOST_STORAGE + "path/1.mp4?token=SECONDO", null, null, TOKEN_NUOVO,
                CodaCaricamenti.isoUtc(scadenzaNuova), null, CodaCaricamenti.isoUtc(ora.get() + 2 * ORA_MS + 5), null, -1, null);
        RisultatoAccodamento r = motore.accoda(ripetuta);

        assertTrue("c'era già una voce viva", r.giaPresente);
        assertEquals("lo stato attuale, non uno nuovo", "in-attesa", r.voce.getString("stato"));
        assertTrue("il secondo preparato NON è stato spostato: lo scarta il ponte, che ne conosce lo sha256", secondo.isFile());
        assertEquals("una voce sola", 1, coda.numeroVoci());
        SegretiCaricamenti.Lettura l = segreti.leggi(id(1));
        assertEquals("il token ruotato ha sostituito il vecchio", TOKEN_NUOVO, l.segreti.token);
        assertTrue(l.segreti.urlPut.endsWith("SECONDO"));
        VoceCoda v = coda.trova(id(1));
        assertEquals(scadenzaNuova, v.tokenScadeIl);
        assertEquals(ora.get() + 2 * ORA_MS + 5, v.urlScadeIl);
        assertEquals("con il token buono si riprova SUBITO", 0L, v.prossimoTentativoIl);
        assertEquals("e il conto dei rinnovi di fila riparte", 0, v.rinnoviConsecutivi);
        assertEquals("nessuna riga `accodato` in più", eventiPrima, registro.numeroEventi());
        assertEquals("la voce c'era: nessun file in più in file/", 1, new File(cartella, "file").listFiles().length);
    }

    @Test
    public void accodareDiNuovoUnJobConUnaVoceTerminaleLaSostituisceEIlVideoRiparte() throws Exception {
        motore.accoda(richiesta(1));
        coda.transita(id(1), EventoStato.FALLITO, Codice.INTERNO);
        assertSame(Stato.FALLITO, coda.trova(id(1)).stato);
        sistema.programmazioni.clear();

        RisultatoAccodamento r = motore.accoda(richiesta(1));
        assertFalse("una voce nuova: la terminale è stata sostituita", r.giaPresente);
        assertEquals("in-coda", r.voce.getString("stato"));
        assertEquals(1, coda.numeroVoci());
        assertTrue(new File(cartella, "file/" + id(1) + ".mp4").isFile());
        assertSame(Esito.OK, segreti.leggi(id(1)).esito);
        assertEquals(1, sistema.programmazioni.size());
        assertEquals("due righe `accodato`: sono due storie", 2, Collections.frequency(messaggi(), "video-nativo-accodato"));
    }

    @Test
    public void unaTerminaleSenzaIlPreparatoNonSiSostituisce() throws Exception {
        motore.accoda(richiesta(1));
        coda.transita(id(1), EventoStato.ANNULLATO, null);
        assertSame(CodiceRifiuto.ELEMENTO_ASSENTE, rifiutoDi(richiesta(1, null)));
        assertSame("la terminale resta com'era", Stato.ANNULLATO, coda.trova(id(1)).stato);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL GUSCIO: QUANDO NON SI PUÒ PROGRAMMARE
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void unUidtCheNonSiRiescieAProgrammareMetteLaVoceInPausaConLaNotifica() throws Exception {
        sistema.programmabile = false;
        RisultatoAccodamento r = motore.accoda(richiesta(1));
        // `accodaVideo` riesce comunque: il video è in coda e al sicuro; è il guscio che non c'è.
        assertEquals("in-pausa", coda.trova(id(1)).stato.valore());
        assertSame(Codice.UIDT_NON_PROGRAMMABILE, coda.trova(id(1)).codice);
        assertEquals("la voce restituita è quella d'ora: già in pausa", "in-pausa", r.voce.getString("stato"));
        assertEquals("UIDT_NON_PROGRAMMABILE", r.voce.getString("codice"));
        EventoRegistrato pausa = evento("video-nativo-pausa");
        assertEquals("video-nativo-pausa: job=" + id(1) + " UIDT_NON_PROGRAMMABILE", pausa.messaggio);
        assertEquals(36L, ((Number) pausa.campi.get("sdk")).longValue());
        assertEquals("la notifica «tocca per riprendere»", Arrays.asList(TESTI.pausa), pausaTesti());
    }

    private List<String> pausaTesti() {
        List<String> testi = new ArrayList<>();
        for (Testi t : sistema.pause) testi.add(t.pausa);
        return testi;
    }

    @Test
    public void unWorkManagerCheNonParteDaBackgroundMetteLaVoceInPausaConFgsNonAvviabile() throws Exception {
        sistema.motore = Motore.WORKMANAGER;
        sistema.sdk = 33;
        motore.accoda(richiesta(1));
        assertSame("il lavoro è in coda: finché non gira, la voce aspetta", Stato.IN_CODA, coda.trova(id(1)).stato);
        // Il lavoro parte, ma il servizio in primo piano no (Android 12-13 da background): il Worker lo dice al motore.
        motore.suForegroundNonAvviabile();
        VoceCoda v = coda.trova(id(1));
        assertSame(Stato.IN_PAUSA, v.stato);
        assertSame(Codice.FGS_NON_AVVIABILE, v.codice);
        EventoRegistrato pausa = evento("video-nativo-pausa");
        assertEquals("video-nativo-pausa: job=" + id(1) + " FGS_NON_AVVIABILE", pausa.messaggio);
        assertEquals(33L, ((Number) pausa.campi.get("sdk")).longValue());
        assertEquals(1, sistema.pause.size());
        // Chiamarlo di nuovo non ripete niente.
        int righe = registro.numeroEventi();
        motore.suForegroundNonAvviabile();
        assertEquals(righe, registro.numeroEventi());
    }

    @Test
    public void unaProgrammazioneCheLanciaVaInPausaEIlGuastoSiDice() throws Exception {
        sistema.lanciaAllaProgrammazione = new IllegalStateException("il sistema non vuole");
        motore.accoda(richiesta(1));
        assertSame(Stato.IN_PAUSA, coda.trova(id(1)).stato);
        assertEquals(Arrays.asList("programma-guscio:IllegalStateException"), sistema.guasti);
    }

    @Test
    public void ilFgsNonAvviabilePortaInPausaAncheLeVociInAttesaPassandoDaInInvio() throws Exception {
        sistema.motore = Motore.WORKMANAGER;
        motore.accoda(richiesta(1));
        coda.transita(id(1), EventoStato.AVVIATO, null);
        coda.transita(id(1), EventoStato.IN_ATTESA_DI_RETE, Codice.RETE);
        motore.accoda(richiesta(2));
        motore.accoda(richiesta(3));
        coda.transita(id(3), EventoStato.IN_PAUSA, Codice.FGS_NON_AVVIABILE);
        registro.eventi();
        motore.suForegroundNonAvviabile();
        assertSame("da in-attesa (§4.4 non ha la freccia diretta)", Stato.IN_PAUSA, coda.trova(id(1)).stato);
        assertSame("da in-coda", Stato.IN_PAUSA, coda.trova(id(2)).stato);
        assertSame("una già in pausa non si ripete", Stato.IN_PAUSA, coda.trova(id(3)).stato);
        int pause = 0;
        for (String m : messaggi()) if (m.startsWith("video-nativo-pausa")) pause++;
        assertEquals("due righe nuove: la terza era già in pausa", 2, pause);
    }

    @Test
    public void conUnCicloGiaAttivoNonSiProgrammaIlGuscioEIlCicloVedeLaVoceNuova() throws Exception {
        final AtomicInteger programmazioniMentreGira = new AtomicInteger(-1);
        final java.util.concurrent.atomic.AtomicBoolean primaVolta = new java.util.concurrent.atomic.AtomicBoolean(true);
        put.comportamento = r -> {
            if (primaVolta.getAndSet(false)) {
                try {
                    // Dentro la PUT della voce 1 arriva `accodaVideo` per la 2: il ciclo attivo la vedrà da solo.
                    motore.accoda(richiesta(2));
                    programmazioniMentreGira.set(sistema.programmazioni.size());
                } catch (RifiutoAccodamento | IOException guasto) {
                    throw new AssertionError(guasto);
                }
            }
            return EsitoPut.risposta(200, null, 0L, r.byteTotali, 500L, true);
        };
        motore.accoda(richiesta(1));
        assertEquals(1, sistema.programmazioni.size());
        EsitoCiclo esito = motore.eseguiSuGuscio(null, 600_000L);
        assertSame(EsitoCiclo.FINITO, esito);
        assertEquals("durante il ciclo la seconda voce NON ha programmato un secondo guscio", 1, programmazioniMentreGira.get());
        assertEquals("e in tutto un guscio solo", 1, sistema.programmazioni.size());
        assertSame("il ciclo attivo ha spedito anche lei", Stato.INVIATO, coda.trova(id(2)).stato);
        assertSame(Stato.INVIATO, coda.trova(id(1)).stato);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * AVVIO E RITORNO IN PRIMO PIANO
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void ilRitornoInPrimoPianoTogliLaPausaFaRipartireLeVociEProgrammaIlGuscio() throws Exception {
        sistema.programmabile = false;
        motore.accoda(richiesta(1));
        assertSame(Stato.IN_PAUSA, coda.trova(id(1)).stato);
        coda.modifica(id(1), v -> v.prossimoTentativoIl = ora.get() + 3_000_000L);
        sistema.programmabile = true;
        sistema.programmazioni.clear();
        sistema.subito.clear();
        motore.suPrimoPiano();
        assertEquals("la notifica di pausa si toglie", 1, sistema.pauseTolte.get());
        assertEquals("la voce riprova ADESSO", 0L, coda.trova(id(1)).prossimoTentativoIl);
        assertEquals("il guscio si riprogramma, ora che l'app è visibile", 1, sistema.programmazioni.size());
        assertEquals("e lo si chiede SUBITO: un ritentativo già in attesa si sostituisce, non ci si accoda", Arrays.asList(true), sistema.subito);
        EventoRegistrato motoreLog = evento("caricamenti-nativi-motore");
        assertEquals("caricamenti-nativi-motore: uidt primo-piano", motoreLog.messaggio);
        assertEquals(UTENTE, motoreLog.utenteId);
        assertEquals(0L, ((Number) motoreLog.campi.get("in_invio")).longValue());
    }

    @Test
    public void conUnCicloAttivoIlRitornoInPrimoPianoNonScriveLaRigaDelMotoreNeProgramma() throws Exception {
        final int[] righeDentro = {-1};
        final int[] programmazioniDentro = {-1};
        put.comportamento = r -> {
            motore.suPrimoPiano();                      // l'insegnante cambia app e torna, mentre il trasferimento va avanti
            righeDentro[0] = (int) messaggi().stream().filter(m -> m.startsWith("caricamenti-nativi-motore")).count();
            programmazioniDentro[0] = sistema.programmazioni.size();
            return EsitoPut.risposta(200, null, 0L, r.byteTotali, 500L, true);
        };
        motore.accoda(richiesta(1));
        motore.eseguiSuGuscio(null, 600_000L);
        assertEquals("nessuna riga: il ciclo attivo non ha cambiato niente", 0, righeDentro[0]);
        assertEquals("e nessun guscio in più oltre a quello di accoda", 1, programmazioniDentro[0]);
        assertEquals("ma la pausa si toglie sempre", 1, sistema.pauseTolte.get());
    }

    @Test
    public void inReleaseIlRitornoInPrimoPianoNonDecifraNienteInDebugSiPerRicordareLIndirizzoDelRegistro() throws Exception {
        motore.accoda(conCampi(richiesta(1), null, null, null, null, null, null, null, null, -1, null));
        int decifratureDopoAccoda = cifrario.decifrature;
        motore.suPrimoPiano();
        lavoratore.eseguiSubito();
        assertEquals("Release: l'indirizzo è fisso, nessun segreto da leggere a ogni ritorno", decifratureDopoAccoda, cifrario.decifrature);
        trasportoLog.chiamate.clear();
        ora.addAndGet(10_000L);

        // Debug, dopo un riavvio del processo (un motore nuovo, la stessa cartella): l'indirizzo si ritrova nei segreti della voce viva.
        sistema.debug = true;
        CodaCaricamenti codaRiaperta = new CodaCaricamenti(cartella, ora::get);
        SegretiCaricamenti segretiRiaperti = new SegretiCaricamenti(codaRiaperta, cifrario);
        segretiRiaperti.salva(id(1), new Segreti(TOKEN, HOST_STORAGE + "path/1.mp4?token=x", "video/mp4", "http://10.0.2.2:3101/api/video-uploads/rinnovo",
                "http://10.0.2.2:3101/api/logs"));
        PianificatoreCaricamenti riavviato = nuovoMotore(codaRiaperta, registro, segretiRiaperti);
        registro.motore(java.util.UUID.fromString(UTENTE), Motore.UIDT, RegistroNativo.Occasione.AVVIO, 1, 0, 0);
        riavviato.suPrimoPiano();
        lavoratore.eseguiSubito();
        assertTrue("l'indirizzo di Debug si è ritrovato nei segreti: " + trasportoLog.chiamate.size(), trasportoLog.chiamate.size() >= 1);
        assertEquals("http://10.0.2.2:3101/api/logs", trasportoLog.chiamate.get(trasportoLog.chiamate.size() - 1)[0]);
    }

    @Test
    public void ilRitornoInPrimoPianoSenzaVociTogliSoloLaPausaENonScriveNiente() throws Exception {
        motore.suPrimoPiano();
        assertEquals(1, sistema.pauseTolte.get());
        assertEquals(0, registro.numeroEventi());
        assertEquals(0, sistema.programmazioni.size());
    }

    @Test
    public void ilRitornoInPrimoPianoConIlGuscioAncoraNonProgrammabileNonRipeteLaRigaDiPausa() throws Exception {
        sistema.programmabile = false;
        motore.accoda(richiesta(1));
        assertEquals(1, Collections.frequency(messaggi(), "video-nativo-pausa UIDT_NON_PROGRAMMABILE"));
        motore.suPrimoPiano();
        assertSame("ancora in pausa", Stato.IN_PAUSA, coda.trova(id(1)).stato);
        assertEquals("la riga di pausa non si ripete", 1, Collections.frequency(messaggi(), "video-nativo-pausa UIDT_NON_PROGRAMMABILE"));
        assertEquals("ma la notifica si rimostra: l'app è stata appena riaperta, e ci si accorge subito che non riparte", 2, sistema.pause.size());
    }

    @Test
    public void lAvvioConUnaCodaGuastaScriveCodaNativaCorrottaConOrfaniEVociScartate() throws Exception {
        // Una coda con una voce buona e una fuori forma: la fuori forma si scarta e si conta.
        VoceCoda buona = VoceCoda.nuova(id(1), id(1001), UTENTE, SCUOLA, "v.mp4", "file/" + id(1) + ".mp4", PESO, "video/mp4", Origine.GALLERIA, 0L, 0L);
        coda.aggiungi(buona);
        File scritta = new File(cartella, "coda.json");
        JSONObject radice = new JSONObject(new String(Files.readAllBytes(scritta.toPath()), StandardCharsets.UTF_8));
        radice.getJSONArray("voci").put(new JSONObject().put("jobId", "rotto"));
        Files.write(scritta.toPath(), radice.toString().getBytes(StandardCharsets.UTF_8));
        File orfano = new File(cartella, "file/" + id(77) + ".mp4");
        orfano.getParentFile().mkdirs();
        assertTrue(orfano.createNewFile());

        CodaCaricamenti riaperta = new CodaCaricamenti(cartella, ora::get);
        PianificatoreCaricamenti riavviato = nuovoMotore(riaperta, registro, new SegretiCaricamenti(riaperta, cifrario));
        riavviato.avvio();

        EventoRegistrato corrotta = evento("coda-nativa-corrotta");
        assertSame(RegistroNativo.Livello.ERROR, corrotta.livello);
        assertEquals("un file orfano", 1L, ((Number) corrotta.campi.get("file_orfani")).longValue());
        assertEquals("una voce scartata (secondario n. 46)", 1L, ((Number) corrotta.campi.get("voci_scartate")).longValue());
        assertEquals("l'evento non ha un utente proprio: gli si dà quello di una voce viva, così parte con un x-user-id (secondario n. 47)",
                UTENTE, corrotta.utenteId);
        assertFalse("la pulizia ha tolto il file orfano", orfano.exists());
        assertTrue("e un avvio con voci vive lo dice", messaggi().contains("caricamenti-nativi-motore: uidt avvio"));
    }

    @Test
    public void lAvvioNonScriveCodaCorrottaSeLaCodaEIntegra() throws Exception {
        motore.avvio();
        assertEquals(0, registro.numeroEventi());
    }

    @Test
    public void lAvvioFaLaPuliziaDeiFileCorrottiVecchi() throws Exception {
        File vecchio = new File(cartella, "coda.corrotta-" + (ora.get() - 8 * 24 * ORA_MS) + ".json");
        File recente = new File(cartella, "coda.corrotta-" + (ora.get() - 1 * ORA_MS) + ".json");
        assertTrue(vecchio.createNewFile());
        assertTrue(recente.createNewFile());
        motore.avvio();
        assertFalse("oltre 7 giorni si toglie", vecchio.exists());
        assertTrue("sotto i 7 giorni resta", recente.exists());
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * ELENCO, ANNULLA, DIMENTICA, OSSERVATORI
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void lElencoVedeSoloLeVociDiQuellUtente() throws Exception {
        motore.accoda(richiesta(1));
        RichiestaAccodamento diUnAltro = new RichiestaAccodamento(id(2), id(1002), ALTRO_UTENTE, SCUOLA, "altro.mp4", "video/mp4", PESO, Origine.FILE,
                nuovoPreparato(2, PESO), HOST_STORAGE + "p/2.mp4?token=x", "video/mp4", null, URL_RINNOVO, TOKEN, CodaCaricamenti.isoUtc(ora.get() + 48 * ORA_MS),
                URL_REGISTRO, TESTI);
        motore.accoda(diUnAltro);
        List<JSONObject> mie = motore.elenco(UTENTE);
        assertEquals(1, mie.size());
        assertEquals(id(1), mie.get(0).getString("jobId"));
        assertEquals(id(2), motore.elenco(ALTRO_UTENTE).get(0).getString("jobId"));
        assertTrue(motore.elenco(id(9999)).isEmpty());
    }

    @Test
    public void annullareDalPonteChiudeLaVoceEdimenticareLaTogliSoloSeTerminale() throws Exception {
        motore.accoda(richiesta(1));
        motore.accoda(richiesta(2));
        assertTrue(motore.annulla(id(1)));
        assertSame(Stato.ANNULLATO, coda.trova(id(1)).stato);
        assertFalse(new File(cartella, "file/" + id(1) + ".mp4").exists());
        assertFalse(coda.fileSegreto(id(1)).exists());
        assertEquals(1, motore.dimentica(Arrays.asList(id(1), id(2), id(404))));
        assertNull("la terminale è stata tolta", coda.trova(id(1)));
        assertNotNull("la viva no", coda.trova(id(2)));
        assertEquals(0, motore.dimentica(Arrays.asList(id(2))));
        assertEquals(0, motore.dimentica(null));
    }

    @Test
    public void unOsservatoreVedeLaVoceCheNasceELeSueTransizioniNellaFormaDelPonte() throws Exception {
        final List<JSONObject> viste = Collections.synchronizedList(new ArrayList<JSONObject>());
        PianificatoreCaricamenti.OsservatoreCaricamenti osservatore = viste::add;
        motore.aggiungiOsservatore(osservatore);
        motore.aggiungiOsservatore(osservatore);       // due volte lo stesso: una sola
        motore.accoda(richiesta(1));
        motore.eseguiSuGuscio(null, 600_000L);
        List<String> stati = new ArrayList<>();
        for (JSONObject v : viste) {
            assertEquals("ogni evento è un CaricamentoNativo completo", 14, v.length());
            stati.add(v.getString("stato"));
        }
        assertEquals("in-coda alla nascita, poi in-invio, poi inviato (la PUT finta non manda avanzamenti)", Arrays.asList("in-coda", "in-invio", "inviato"), stati);
        assertEquals("inviato porta sempre tutti i byte", PESO, viste.get(viste.size() - 1).getLong("byteInviati"));
        motore.rimuoviOsservatore(osservatore);
        int prima = viste.size();
        motore.accoda(richiesta(2));
        assertEquals("rimosso non riceve più", prima, viste.size());
    }

    @Test
    public void unOsservatoreCheLanciaNonFermaIlMotoreEIlGuastoSiDice() throws Exception {
        motore.aggiungiOsservatore(voce -> {
            throw new IllegalStateException("il ponte è chiuso");
        });
        motore.accoda(richiesta(1));
        motore.eseguiSuGuscio(null, 600_000L);
        assertSame("il trasferimento è finito comunque", Stato.INVIATO, coda.trova(id(1)).stato);
        assertTrue(sistema.guasti.toString(), sistema.guasti.contains("osservatore-ponte:IllegalStateException"));
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL REGISTRO DEI LOG: DESTINAZIONE E RITMO
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void inReleaseIlRegistroVaSempreAlSitoDiProduzioneQualunqueCosaAbbiaDettoLaPagina() throws Exception {
        // La pagina passa un percorso diverso (stesso host, ammesso dalla politica): in Release conta solo l'indirizzo fisso.
        motore.accoda(conCampi(richiesta(1), null, null, null, null, null, "https://app.kidville.it/un/altro/percorso", null, null, -1, null));
        motore.svuotaIlRegistro();
        lavoratore.eseguiSubito();
        assertEquals("un solo POST: gli eventi che c'erano", 1, trasportoLog.chiamate.size());
        assertEquals(RegistroNativo.URL_REGISTRO_RELEASE, trasportoLog.chiamate.get(0)[0]);
        assertEquals("con l'identità nell'intestazione", UTENTE, trasportoLog.chiamate.get(0)[1]);
        assertEquals(0, registro.numeroEventi());
    }

    @Test
    public void inReleaseSiSvuotaAncheSenzaNessunaVoceVivaEAllAvvio() throws Exception {
        // All'avvio (e al primo piano) nessuna voce può portare un indirizzo: in Release c'è quello fisso.
        registro.motore(java.util.UUID.fromString(UTENTE), Motore.UIDT, RegistroNativo.Occasione.AVVIO, 1, 0, 0);
        motore.avvio();
        lavoratore.eseguiSubito();
        assertEquals(1, trasportoLog.chiamate.size());
        assertEquals(RegistroNativo.URL_REGISTRO_RELEASE, trasportoLog.chiamate.get(0)[0]);
        registro.motore(java.util.UUID.fromString(UTENTE), Motore.UIDT, RegistroNativo.Occasione.AVVIO, 2, 0, 0);
        ora.addAndGet(10_000L);
        motore.suPrimoPiano();
        lavoratore.eseguiSubito();
        assertEquals("anche il ritorno in primo piano svuota il registro", 2, trasportoLog.chiamate.size());
    }

    @Test
    public void inDebugIlRegistroVaDovelaPaginaHaDettoEConUnaVoceCheLoPorta() throws Exception {
        sistema.debug = true;
        registro.motore(java.util.UUID.fromString(UTENTE), Motore.UIDT, RegistroNativo.Occasione.AVVIO, 1, 0, 0);     // un evento in attesa
        motore.svuotaIlRegistro();
        lavoratore.eseguiSubito();
        assertEquals("senza un indirizzo noto, in Debug, non si spedisce niente (i log di una build Debug non vanno in produzione)", 0, trasportoLog.chiamate.size());
        assertEquals("e l'evento resta", 1, registro.numeroEventi());
        motore.accoda(conCampi(richiesta(1), null, null, "http://10.0.2.2:3101/api/video-uploads/rinnovo", null, null, "http://10.0.2.2:3101/api/logs", null, null, -1, null));
        motore.svuotaIlRegistro();
        lavoratore.eseguiSubito();
        assertEquals(1, trasportoLog.chiamate.size());
        assertEquals("http://10.0.2.2:3101/api/logs", trasportoLog.chiamate.get(0)[0]);
    }

    @Test
    public void piuRichiesteDiSvuotamentoRavvicinateNeFannoUnaSola() throws Exception {
        registro.motore(java.util.UUID.fromString(UTENTE), Motore.UIDT, RegistroNativo.Occasione.AVVIO, 1, 0, 0);
        for (int i = 0; i < 10; i++) motore.svuotaIlRegistro();
        assertEquals(1, lavoratore.inCoda());
        lavoratore.eseguiSubito();
        assertEquals(1, trasportoLog.chiamate.size());
        motore.svuotaIlRegistro();
        assertEquals("finita la prima se ne può chiedere un'altra", 1, lavoratore.inCoda());
    }

    @Test
    public void unRegistroConPiuDiUnLottoContinuaDopoIlRitardoMinimoFraDuePost() throws Exception {
        for (int i = 0; i < 25; i++) registro.motore(java.util.UUID.fromString(UTENTE), Motore.UIDT, RegistroNativo.Occasione.AVVIO, i, 0, 0);
        motore.svuotaIlRegistro();
        lavoratore.eseguiSubito();
        assertEquals("il primo lotto: 20 eventi", 1, trasportoLog.chiamate.size());
        assertEquals(5, registro.numeroEventi());
        assertEquals("il resto si pianifica allo scadere dei 10 s del registro", 1, lavoratore.ritardati.size());
        ora.addAndGet(10_000L);
        long ritardo = lavoratore.eseguiIlPrimoRitardato();
        assertEquals(10_000L, ritardo);
        assertEquals(2, trasportoLog.chiamate.size());
        assertEquals(0, registro.numeroEventi());
        assertEquals("e finito: niente altro da pianificare", 0, lavoratore.ritardati.size());
    }

    @Test
    public void unPostTroppoPrestoOUn429SiRiprovanoAlloScadereDelRitardo() throws Exception {
        registro.motore(java.util.UUID.fromString(UTENTE), Motore.UIDT, RegistroNativo.Occasione.AVVIO, 1, 0, 0);
        motore.svuotaIlRegistro();
        lavoratore.eseguiSubito();
        registro.motore(java.util.UUID.fromString(UTENTE), Motore.UIDT, RegistroNativo.Occasione.AVVIO, 2, 0, 0);
        motore.svuotaIlRegistro();
        lavoratore.eseguiSubito();                      // troppo presto: sono passati 0 s dall'ultimo POST
        assertEquals(1, trasportoLog.chiamate.size());
        assertEquals(1, lavoratore.ritardati.size());
        assertEquals("riprova quando scade il ritmo di un POST ogni 10 s", 10_000L, (long) (Long) lavoratore.ritardati.get(0)[1]);

        // Scaduto il ritardo il secondo POST parte, e il server risponde 429 con un Retry-After.
        ora.addAndGet(10_000L);
        trasportoLog.risposte.add(new RispostaTrasporto(429, 120L));
        assertEquals(10_000L, lavoratore.eseguiIlPrimoRitardato());
        assertEquals(2, trasportoLog.chiamate.size());
        assertEquals("un 429 rimanda al suo Retry-After", 1, lavoratore.ritardati.size());
        assertEquals(120_000L, (long) (Long) lavoratore.ritardati.get(0)[1]);
        assertEquals("gli eventi restano", 1, registro.numeroEventi());

        // Scaduto anche quello, il terzo POST riesce e non resta più niente da pianificare.
        ora.addAndGet(120_000L);
        assertEquals(120_000L, lavoratore.eseguiIlPrimoRitardato());
        assertEquals(3, trasportoLog.chiamate.size());
        assertEquals(0, registro.numeroEventi());
        assertEquals(0, lavoratore.ritardati.size());
    }

    @Test
    public void unaReteAssenteNonFaInsistereOgniDieciSecondi() throws Exception {
        registro.motore(java.util.UUID.fromString(UTENTE), Motore.UIDT, RegistroNativo.Occasione.AVVIO, 1, 0, 0);
        trasportoLog.risposte.add(new IOException("rete"));
        motore.svuotaIlRegistro();
        lavoratore.eseguiSubito();
        assertEquals(1, trasportoLog.chiamate.size());
        assertEquals("niente ritentativo pianificato: si riprova al prossimo evento, all'avvio o al primo piano", 0, lavoratore.ritardati.size());
        assertEquals("e gli eventi restano", 1, registro.numeroEventi());
    }

    @Test
    public void unaVoceCheFinisceFaPartireLoSvuotamentoDelRegistro() throws Exception {
        motore.accoda(richiesta(1));
        assertEquals("accodare non svuota il registro", 0, lavoratore.inCoda());
        motore.eseguiSuGuscio(null, 600_000L);
        assertTrue("la voce è finita: il registro si svuota", lavoratore.inCoda() >= 1);
        lavoratore.eseguiSubito();
        assertEquals(1, trasportoLog.chiamate.size());
        String corpo = trasportoLog.chiamate.get(0)[2];
        assertTrue(corpo, corpo.contains("video-nativo-accodato") && corpo.contains("video-nativo-inviato"));
        assertFalse("nessun segreto nel POST", contiene(corpo, TOKEN, "kvr_", "supabase", "Il mio video", ".mp4"));
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL MOTORE PER LIVELLO DI API, E L'INTERRUTTORE
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void ilMotorePerLivelloDiApiEUidtDa34EWorkManagerSotto() {
        for (int sdk : new int[]{24, 25, 26, 28, 30, 31, 33}) assertSame("API " + sdk, Motore.WORKMANAGER, PianificatoreCaricamenti.motorePer(sdk));
        for (int sdk : new int[]{34, 35, 36, 37}) assertSame("API " + sdk, Motore.UIDT, PianificatoreCaricamenti.motorePer(sdk));
    }

    @Test
    public void lInterruttoreDiEmergenzaESpentoEPortaTuttiSuWorkManagerSeAcceso() {
        assertFalse("FORZA_WORKMANAGER è spento: si accende solo con una nuova build, e questo test lo dice", PianificatoreCaricamenti.FORZA_WORKMANAGER);
        // La stessa regola con l'interruttore acceso, dalla politica (che lo prende come parametro):
        for (int sdk : new int[]{24, 33, 34, 36}) assertSame(Motore.WORKMANAGER, PoliticaCaricamento.motorePer(sdk, true));
    }

    @Test
    public void idEnomiFissiDelGuscio() {
        assertEquals("kidville-caricamenti", PianificatoreCaricamenti.NOME_LAVORO);
        assertEquals("i due id di notifica sono diversi", false, NotificheCaricamento.ID_NOTIFICA_INVIO == NotificheCaricamento.ID_NOTIFICA_PAUSA);
        assertEquals("kidville_caricamenti", NotificheCaricamento.ID_CANALE);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * UN GUSCIO CHE PARTE DAVVERO, E NESSUNA VOCE PERSA
     * ──────────────────────────────────────────────────────────────────────────── */

    /**
     * `accodaVideo` e il guscio insieme, sui thread veri: ogni volta che `programma` viene chiamato parte un thread che fa girare il ciclo
     * (come farebbe WorkManager o JobScheduler), mentre il thread principale accoda voci a raffica. Alla fine OGNI voce deve essere
     * `inviato` — e nessuna `fallito`: l'esecutore non deve MAI aver visto una voce senza i suoi segreti (se salvati dopo, qualcuna
     * sarebbe stata letta «persa» e sarebbe finita `fallito INTERNO`).
     */
    @Test(timeout = 120_000)
    public void accodareARafficaConIlGuscioCheParteDaSoloNonPerdeNeRompeNessunaVoce() throws Exception {
        final List<Thread> gusci = Collections.synchronizedList(new ArrayList<Thread>());
        sistema.alGuscioProgrammato = () -> {
            Thread guscio = new Thread(() -> motore.eseguiSuGuscio(null, 600_000L));
            gusci.add(guscio);
            guscio.start();
        };
        final int voci = 40;
        for (int n = 1; n <= voci; n++) {
            motore.accoda(richiesta(n));
            if (n % 5 == 0) Thread.sleep(1);
        }
        for (Thread guscio : new ArrayList<>(gusci)) guscio.join(60_000);
        long limite = System.nanoTime() + 30_000_000_000L;
        while (System.nanoTime() < limite && !coda.vive().isEmpty()) Thread.sleep(10);
        assertTrue("nessuna voce resta viva", coda.vive().isEmpty());
        for (int n = 1; n <= voci; n++) assertSame("voce " + n, Stato.INVIATO, coda.trova(id(n)).stato);
        assertEquals(voci, put.richieste.size());
        for (String m : messaggi()) assertFalse(m, m.startsWith("video-nativo-fallito"));
    }

    /**
     * Mentre `accodaVideo` sta ancora cifrando i segreti (il cifrario qui sta fermo), un ciclo che gira NON deve trovare la voce, e dopo —
     * coi segreti salvati — deve spedirla. Le protezioni sono due, e ridondanti: il blocco della coda (nessuno la vede finché non finisce
     * tutto) e l'ordine (i segreti PRIMA della voce, che è ciò che regge se il processo muore in mezzo). Si prova la proprietà, non una
     * delle due: tolte tutte e due, qualche voce verrebbe letta «persa» e finirebbe `fallito INTERNO`.
     */
    @Test(timeout = 60_000)
    public void unCicloCheGiraMentreSiAccodaNonVedeMaiUnaVoceSenzaISuoiSegreti() throws Exception {
        final java.util.concurrent.CountDownLatch dentro = new java.util.concurrent.CountDownLatch(1);
        final java.util.concurrent.CountDownLatch via = new java.util.concurrent.CountDownLatch(1);
        SegretiCaricamenti.Cifrario lento = new SegretiCaricamenti.Cifrario() {
            @Override
            public byte[] cifra(byte[] chiaro, byte[] datiAssociati) throws java.security.GeneralSecurityException, IOException {
                dentro.countDown();
                try {
                    via.await(15, java.util.concurrent.TimeUnit.SECONDS);
                } catch (InterruptedException interrotto) {
                    Thread.currentThread().interrupt();
                }
                return cifrario.cifra(chiaro, datiAssociati);
            }

            @Override
            public byte[] decifra(byte[] cifrato, byte[] datiAssociati) throws java.security.GeneralSecurityException, IOException {
                return cifrario.decifra(cifrato, datiAssociati);
            }
        };
        final PianificatoreCaricamenti conCifrarioLento = nuovoMotore(coda, registro, new SegretiCaricamenti(coda, lento));
        final java.util.concurrent.atomic.AtomicReference<Throwable> errore = new java.util.concurrent.atomic.AtomicReference<>();
        final RichiestaAccodamento richiesta = richiesta(1);
        Thread accodamento = new Thread(() -> {
            try {
                conCifrarioLento.accoda(richiesta);
            } catch (Throwable guasto) {
                errore.set(guasto);
            }
        });
        accodamento.start();
        assertTrue(dentro.await(10, java.util.concurrent.TimeUnit.SECONDS));
        // Un ciclo parte ORA, mentre i segreti si stanno cifrando.
        final java.util.concurrent.atomic.AtomicReference<EsitoCiclo> esito = new java.util.concurrent.atomic.AtomicReference<>();
        Thread ciclo = new Thread(() -> esito.set(conCifrarioLento.eseguiSuGuscio(null, 600_000L)));
        ciclo.start();
        Thread.sleep(400);
        via.countDown();
        accodamento.join(20_000);
        ciclo.join(20_000);
        assertEquals(null, errore.get());
        assertFalse(ciclo.isAlive());
        assertEquals("nessuna voce dichiarata perduta", 0, (int) messaggi().stream().filter(m -> m.startsWith("video-nativo-fallito")).count());
        // Se il ciclo è finito prima che la voce nascesse, la voce aspetta ancora (`in-coda`); altrimenti l'ha già spedita. Mai `fallito`.
        Stato dopo = coda.trova(id(1)).stato;
        assertTrue("stato: " + dopo, dopo == Stato.IN_CODA || dopo == Stato.INVIATO);
        if (dopo == Stato.IN_CODA) {
            assertSame(EsitoCiclo.FINITO, conCifrarioLento.eseguiSuGuscio(null, 600_000L));
        }
        assertSame(Stato.INVIATO, coda.trova(id(1)).stato);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * LE DATE ISO 8601
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void leDateIsoSiLeggonoComeLeScriveIlServer() {
        assertEquals(Instant.parse("2026-10-05T10:00:00.000Z").toEpochMilli(), PianificatoreCaricamenti.leggiIsoMs("2026-10-05T10:00:00.000Z"));
        assertEquals("senza frazione", Instant.parse("2026-10-05T10:00:00Z").toEpochMilli(), PianificatoreCaricamenti.leggiIsoMs("2026-10-05T10:00:00Z"));
        long base = Instant.parse("2026-10-05T10:00:00Z").toEpochMilli();
        assertEquals(base + 500, PianificatoreCaricamenti.leggiIsoMs("2026-10-05T10:00:00.5Z"));
        assertEquals(base + 50, PianificatoreCaricamenti.leggiIsoMs("2026-10-05T10:00:00.05Z"));
        assertEquals(base + 123, PianificatoreCaricamenti.leggiIsoMs("2026-10-05T10:00:00.123Z"));
        assertEquals("oltre i millisecondi si tronca", base + 123, PianificatoreCaricamenti.leggiIsoMs("2026-10-05T10:00:00.123456789Z"));
        assertEquals("con lo scarto +02:00", base, PianificatoreCaricamenti.leggiIsoMs("2026-10-05T12:00:00+02:00"));
        assertEquals("con lo scarto -04:30", base, PianificatoreCaricamenti.leggiIsoMs("2026-10-05T05:30:00-04:30"));
        assertEquals("l'epoca è zero: ed è il valore che `accoda` tratta come non valido", 0L, PianificatoreCaricamenti.leggiIsoMs("1970-01-01T00:00:00Z"));
        assertEquals("anni bisestili: 29 febbraio 2024", Instant.parse("2024-02-29T12:00:00Z").toEpochMilli(), PianificatoreCaricamenti.leggiIsoMs("2024-02-29T12:00:00Z"));
        assertEquals("e il 2000 (divisibile per 400)", Instant.parse("2000-02-29T00:00:00Z").toEpochMilli(), PianificatoreCaricamenti.leggiIsoMs("2000-02-29T00:00:00Z"));
    }

    @Test
    public void leDateIsoCoincidonoConJavaTimeSuMigliaiaDiIstanti() {
        Random caso = new Random(2026);
        long inizio = Instant.parse("1971-01-01T00:00:00Z").toEpochMilli();
        long fine = Instant.parse("2100-12-31T23:59:59Z").toEpochMilli();
        for (int i = 0; i < 5_000; i++) {
            long istante = inizio + (long) (caso.nextDouble() * (fine - inizio));
            String iso = Instant.ofEpochMilli(istante).toString();      // 2026-10-05T10:00:00.123Z, o senza frazione, o con 3/6/9 cifre
            assertEquals(iso, istante, PianificatoreCaricamenti.leggiIsoMs(iso));
        }
    }

    @Test
    public void leDateIsoFuoriFormaOImpossibiliValgonoMenoUno() {
        for (String non : new String[]{null, "", "z", "2026-10-05", "2026-10-05T10:00:00", "2026-10-05T10:00:00+0200", "2026-10-05T10:00:00+02",
                "2026-10-05 10:00:00Z", " 2026-10-05T10:00:00Z", "2026-10-05T10:00:00Z ", "2026-10-05T10:00:00.Z", "2026-02-29T00:00:00Z", "2100-02-29T00:00:00Z",
                "2026-13-01T00:00:00Z", "2026-00-10T00:00:00Z", "2026-10-32T00:00:00Z", "2026-10-00T00:00:00Z", "2026-04-31T00:00:00Z", "2026-10-05T24:00:00Z",
                "2026-10-05T10:60:00Z", "2026-10-05T10:00:60Z", "2026-10-05T10:00:00+24:00", "2026-10-05T10:00:00+02:60", "26-10-05T10:00:00Z",
                "2026-10-05T10:00:00.1234567890Z", "domani", "2026-10-05T10:00:00z"}) {
            assertEquals("«" + non + "»", -1L, PianificatoreCaricamenti.leggiIsoMs(non));
        }
    }
}
