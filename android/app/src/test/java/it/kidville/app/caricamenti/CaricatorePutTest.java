package it.kidville.app.caricamenti;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import it.kidville.app.caricamenti.EsecutoreCoda.EsitoPut;
import it.kidville.app.caricamenti.EsecutoreCoda.Interruzione;
import it.kidville.app.caricamenti.EsecutoreCoda.RichiestaPut;
import it.kidville.app.caricamenti.PoliticaCaricamento.CorpoRifiuto;
import it.kidville.app.caricamenti.PoliticaCaricamento.ErroreStorage;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.ServerSocket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Random;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;

/**
 * La PUT nativa (spec §2.2 «Intestazioni della PUT», §3 S0, §4.5, §6.1; compito A2) contro un server locale che fa ciò che fa uno
 * Storage vero: legge il corpo, lo rifiuta senza leggerlo, non risponde, cade a metà, è lento. Si prova che SOLO `content-type` sia
 * un'intestazione nostra, che il corpo arrivi byte per byte (sha256), che un rifiuto si legga con il suo corpo (≤ 4 KB), che
 * l'interruzione dall'esterno fermi anche una scrittura bloccata, che l'avanzamento sia misurato, e che nessun guasto lanci.
 */
public class CaricatorePutTest {

    @Rule
    public TemporaryFolder temporanea = new TemporaryFolder();

    private static final String CONTENT_TYPE = "video/mp4";

    private File fileCasuale(String nome, int byteTotali) throws IOException {
        File f = new File(temporanea.getRoot(), nome);
        byte[] dati = new byte[byteTotali];
        new Random(42).nextBytes(dati);
        try (FileOutputStream uscita = new FileOutputStream(f)) {
            uscita.write(dati);
        }
        return f;
    }

    private static byte[] contenutoDi(File f) throws IOException {
        return java.nio.file.Files.readAllBytes(f.toPath());
    }

    private static RichiestaPut richiesta(String url, File file, long byteTotali, Interruzione interruzione, List<Long> avanzamenti) {
        return new RichiestaPut(url, CONTENT_TYPE, file, byteTotali, inviati -> {
            if (avanzamenti != null) avanzamenti.add(inviati);
        }, interruzione);
    }

    private static final String PERCORSO = "/storage/v1/object/upload/sign/video_processing/collaudo/x.bin?token=jwt";

    /* ────────────────────────────────────────────────────────────────────────────
     * IL CORPO, LA LUNGHEZZA FISSA, LE INTESTAZIONI
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test(timeout = 60_000)
    public void unaPutRiuscitaMandaTuttiIByteALunghezzaFissaESoloLeIntestazioniDichiarate() throws Exception {
        File file = fileCasuale("video.mp4", 3 * 1024 * 1024 + 123);
        try (ServerHttpDiProva server = new ServerHttpDiProva()) {
            EsitoPut esito = new CaricatorePut().invia(richiesta(server.url(PERCORSO), file, file.length(), new Interruzione(), null));
            assertSame(EsitoPut.Tipo.RISPOSTA, esito.tipo);
            assertEquals(200, esito.stato);
            assertTrue("tutti i byte erano partiti quando è arrivata la risposta", esito.completo);
            assertEquals(file.length(), esito.byteInviati);
            assertEquals("un 2xx non porta un corpo di rifiuto", 0, esito.corpo.length);
            assertEquals(0L, esito.retryAfterSecondi);

            ServerHttpDiProva.Richiesta vista = server.ultima();
            assertEquals("PUT", vista.metodo);
            assertEquals(PERCORSO, vista.percorso);
            assertEquals("Content-Length = il peso del file", String.valueOf(file.length()), vista.intestazione("content-length"));
            assertFalse("corpo a lunghezza fissa, mai chunked", vista.haIntestazione("transfer-encoding"));
            assertEquals(CONTENT_TYPE, vista.intestazione("content-type"));
            assertEquals("il corpo è il file, byte per byte", ServerHttpDiProva.sha256Di(contenutoDi(file)), vista.sha256);
            assertEquals(file.length(), vista.byteLetti.get());
        }
    }

    @Test(timeout = 60_000)
    public void nessunaIntestazioneNostraOltreAContentTypeNeUnaVietata() throws Exception {
        File file = fileCasuale("v.mp4", 100_000);
        try (ServerHttpDiProva server = new ServerHttpDiProva()) {
            new CaricatorePut().invia(richiesta(server.url(PERCORSO), file, file.length(), new Interruzione(), null));
            ServerHttpDiProva.Richiesta vista = server.ultima();
            // Le vietate di §2.2 e S0: la firma sta nell'URL, e un URL rubato non deve poter sovrascrivere né portare un'identità.
            for (String vietata : new String[]{"x-upsert", "authorization", "apikey", "cache-control", "x-kidville-rinnovo", "cookie", "expect",
                    "x-user-id", "pragma", "if-none-match"}) {
                assertFalse("intestazione vietata sulla PUT: " + vietata, vista.haIntestazione(vietata));
            }
            // E l'elenco completo: quelle che `HttpURLConnection` aggiunge da sé, più la nostra. Nient'altro.
            Set<String> ammesse = new HashSet<>(Arrays.asList("host", "user-agent", "accept", "connection", "content-type", "content-length"));
            for (String nome : vista.intestazioni.keySet()) {
                assertTrue("intestazione inattesa: " + nome, ammesse.contains(nome.toLowerCase()));
            }
        }
    }

    @Test(timeout = 60_000)
    public void ilContentTypeVaCosiComeIlServerLoHaDichiaratoConIParametri() throws Exception {
        File file = fileCasuale("v.mp4", 1000);
        try (ServerHttpDiProva server = new ServerHttpDiProva()) {
            new CaricatorePut().invia(new RichiestaPut(server.url(PERCORSO), "video/mp4;codecs=avc1.42E01E", file, 1000, x -> {
            }, new Interruzione()));
            assertEquals("video/mp4;codecs=avc1.42E01E", server.ultima().intestazione("content-type"));
        }
    }

    @Test
    public void laConnessioneSiConfiguraConLunghezzaFissaESenzaReindirizzamenti() throws Exception {
        HttpURLConnection c = (HttpURLConnection) URI.create("http://127.0.0.1:9/x").toURL().openConnection();
        CaricatorePut.configura(c, "video/quicktime", 3_000_000_000L, 11_111, 22_222);   // oltre i 2 GiB: serve la versione `long`
        assertEquals("PUT", c.getRequestMethod());
        assertEquals(11_111, c.getConnectTimeout());
        assertEquals(22_222, c.getReadTimeout());
        assertFalse("un reindirizzamento non si segue: su Android diventerebbe una GET e il file non andrebbe dove deve", c.getInstanceFollowRedirects());
        assertTrue(c.getDoOutput());
        assertEquals("video/quicktime", c.getRequestProperty("content-type"));
        for (String nome : new String[]{"x-upsert", "authorization", "apikey", "cache-control", "x-kidville-rinnovo", "cookie", "expect"}) {
            assertNull(nome, c.getRequestProperty(nome));
        }
    }

    @Test
    public void iTempiMassimiDiProduzioneSonoQuelliDellaSpec() {
        assertEquals("blocchi da 256 KB", 256 * 1024, CaricatorePut.BLOCCO_BYTE);
        assertEquals("connectTimeout 30 s", 30_000, CaricatorePut.TIMEOUT_CONNESSIONE_MS);
        assertEquals("readTimeout 300 s", 300_000, CaricatorePut.TIMEOUT_LETTURA_MS);
        assertEquals("avanzamento ogni 500 ms", 500L, CaricatorePut.INTERVALLO_AVANZAMENTO_MS);
        assertEquals("corpo d'errore ≤ 4 KB", 4096, CaricatorePut.CORPO_ERRORE_MASSIMO_BYTE);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * LE RISPOSTE
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test(timeout = 60_000)
    public void unRifiutoDelloStorageConIlSuoCorpoSiLeggeEllaPoliticaLoCapisce() throws Exception {
        File file = fileCasuale("v.mp4", 500_000);
        try (ServerHttpDiProva server = new ServerHttpDiProva()) {
            server.stato = 400;
            server.corpoRisposta = "{\"statusCode\":\"409\",\"error\":\"Duplicate\",\"message\":\"The resource already exists\"}";
            EsitoPut esito = new CaricatorePut().invia(richiesta(server.url(PERCORSO), file, file.length(), new Interruzione(), null));
            assertSame(EsitoPut.Tipo.RISPOSTA, esito.tipo);
            assertEquals("lo Storage manda i suoi rifiuti come HTTP 400", 400, esito.stato);
            assertTrue(esito.completo);
            CorpoRifiuto corpo = PoliticaCaricamento.leggiCorpoRifiuto(esito.corpo);
            assertTrue(corpo.leggibile);
            assertEquals(409, corpo.statusCode);
            assertSame(ErroreStorage.DUPLICATE, corpo.errore);
        }
    }

    @Test(timeout = 60_000)
    public void ilCorpoDiUnRifiutoSiLeggeAlPiuFinoA4KB() throws Exception {
        File file = fileCasuale("v.mp4", 10_000);
        try (ServerHttpDiProva server = new ServerHttpDiProva()) {
            server.stato = 400;
            StringBuilder lungo = new StringBuilder("{\"statusCode\":\"400\",\"error\":\"InvalidJWT\",\"message\":\"");
            for (int i = 0; i < 20_000; i++) lungo.append('x');
            lungo.append("\"}");
            server.corpoRisposta = lungo.toString();
            EsitoPut esito = new CaricatorePut().invia(richiesta(server.url(PERCORSO), file, file.length(), new Interruzione(), null));
            assertEquals("4096 byte e non uno di più", 4096, esito.corpo.length);
            assertTrue("e sono l'inizio vero del corpo", new String(esito.corpo, StandardCharsets.UTF_8).startsWith("{\"statusCode\":\"400\",\"error\":\"InvalidJWT\""));
            // Un corpo di 20 KB tagliato a 4 KB non è più JSON: la politica lo legge come «illeggibile» (`error_code: altro`). Uno Storage vero
            // risponde con poche decine di byte, e il caso non esiste: conta che la lettura sia LIMITATA, non che un corpo gigante si capisca.
            assertFalse(PoliticaCaricamento.leggiCorpoRifiuto(esito.corpo).leggibile);
        }
    }

    @Test(timeout = 60_000)
    public void retryAfterSiLeggeInSecondiEUnoStato5xxEUnaRispostaVera() throws Exception {
        File file = fileCasuale("v.mp4", 10_000);
        try (ServerHttpDiProva server = new ServerHttpDiProva()) {
            server.stato = 429;
            server.intestazioniRisposta.put("Retry-After", "120");
            EsitoPut limitato = new CaricatorePut().invia(richiesta(server.url(PERCORSO), file, file.length(), new Interruzione(), null));
            assertEquals(429, limitato.stato);
            assertEquals(120L, limitato.retryAfterSecondi);
            server.stato = 503;
            server.intestazioniRisposta.clear();
            EsitoPut giu = new CaricatorePut().invia(richiesta(server.url(PERCORSO), file, file.length(), new Interruzione(), null));
            assertSame(EsitoPut.Tipo.RISPOSTA, giu.tipo);
            assertEquals(503, giu.stato);
            assertEquals(0L, giu.retryAfterSecondi);
        }
    }

    @Test(timeout = 60_000)
    public void unReindirizzamentoNonSiSegueEArrivaComeStato() throws Exception {
        File file = fileCasuale("v.mp4", 10_000);
        try (ServerHttpDiProva server = new ServerHttpDiProva()) {
            server.stato = 302;
            server.intestazioniRisposta.put("Location", "http://127.0.0.1:1/altrove");
            EsitoPut esito = new CaricatorePut().invia(richiesta(server.url(PERCORSO), file, file.length(), new Interruzione(), null));
            assertEquals(302, esito.stato);
            assertEquals("e il server ha visto UNA richiesta sola", 1, server.richieste.size());
        }
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * I GUASTI: nessuno lancia
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test(timeout = 60_000)
    public void unaConnessioneRifiutataEUnaCadutaDiReteVeloceENonUnaEccezione() throws Exception {
        File file = fileCasuale("v.mp4", 10_000);
        int portaChiusa;
        try (ServerSocket occupata = new ServerSocket(0)) {
            portaChiusa = occupata.getLocalPort();
        }
        long inizio = System.nanoTime();
        EsitoPut esito = new CaricatorePut(5_000, 5_000).invia(richiesta("http://127.0.0.1:" + portaChiusa + PERCORSO, file, file.length(), new Interruzione(), null));
        assertSame(EsitoPut.Tipo.NESSUNA_RISPOSTA, esito.tipo);
        assertEquals(0, esito.stato);
        assertNotNull("la CLASSE dell'eccezione per la diagnostica, mai il messaggio", esito.classe);
        assertFalse(esito.completo);
        assertTrue("senza il tempo massimo di connessione pagato due volte", (System.nanoTime() - inizio) / 1_000_000L < 4_000L);
    }

    @Test(timeout = 60_000)
    public void unIndirizzoCheNonSiLeggeEUnaCadutaENonUnaEccezione() throws Exception {
        File file = fileCasuale("v.mp4", 1000);
        for (String url : new String[]{"::::", "http://", "esempio senza schema"}) {
            EsitoPut esito = new CaricatorePut(2_000, 2_000).invia(richiesta(url, file, file.length(), new Interruzione(), null));
            assertSame("«" + url + "»", EsitoPut.Tipo.NESSUNA_RISPOSTA, esito.tipo);
        }
    }

    @Test(timeout = 60_000)
    public void unaRispostaCheNonArrivaScadeEUnaCadutaEnonUnAttesaInfinita() throws Exception {
        File file = fileCasuale("v.mp4", 50_000);
        try (ServerHttpDiProva server = new ServerHttpDiProva()) {
            server.modo = ServerHttpDiProva.Modo.LEGGI_E_NON_RISPONDERE;
            long inizio = System.nanoTime();
            EsitoPut esito = new CaricatorePut(2_000, 500).invia(richiesta(server.url(PERCORSO), file, file.length(), new Interruzione(), null));
            assertSame(EsitoPut.Tipo.NESSUNA_RISPOSTA, esito.tipo);
            assertEquals("tutti i byte erano partiti: la caduta è in lettura", file.length(), esito.byteInviati);
            // Un solo tempo massimo di lettura (500 ms), non due: dopo la caduta in lettura non si prova un'altra lettura.
            assertTrue("scaduto in fretta: " + (System.nanoTime() - inizio) / 1_000_000L + " ms", (System.nanoTime() - inizio) / 1_000_000L < 3_000L);
        }
    }

    @Test(timeout = 60_000)
    public void unaConnessioneChiusaAMetaEUnaCadutaConIBytePartitiENessunaRisposta() throws Exception {
        File file = fileCasuale("v.mp4", 12 * 1024 * 1024);
        try (ServerHttpDiProva server = new ServerHttpDiProva()) {
            server.modo = ServerHttpDiProva.Modo.CHIUDI_DOPO_N_BYTE;
            server.chiudiDopoByte = 1024 * 1024;
            EsitoPut esito = new CaricatorePut(5_000, 5_000).invia(richiesta(server.url(PERCORSO), file, file.length(), new Interruzione(), null));
            assertSame(EsitoPut.Tipo.NESSUNA_RISPOSTA, esito.tipo);
            assertTrue("non tutti i byte sono arrivati", esito.byteInviati < file.length());
            assertFalse(esito.completo);
        }
    }

    @Test(timeout = 60_000)
    public void unRifiutoAnticipatoSenzaLeggereIlCorpoNonBloccaENonLancia() throws Exception {
        // Lo Storage rifiuta un URL scaduto o un duplicato SENZA leggere il file e chiude. La `write` può lanciare con i byte ancora in
        // viaggio; la risposta si prova a leggere comunque. In JVM (HttpURLConnection del JDK) non sempre si riesce: l'esito è `RISPOSTA`
        // 400 oppure `NESSUNA_RISPOSTA` — e la politica tratta il secondo come transitorio: il giro dopo rinnova (l'URL ha più di 10') e il
        // rinnovo dice se il file c'è. In nessun caso il trasportatore lancia o si pianta.
        File file = fileCasuale("v.mp4", 20 * 1024 * 1024);
        try (ServerHttpDiProva server = new ServerHttpDiProva()) {
            server.modo = ServerHttpDiProva.Modo.RISPONDI_SUBITO_SENZA_LEGGERE;
            server.stato = 400;
            server.corpoRisposta = "{\"statusCode\":\"400\",\"error\":\"InvalidJWT\",\"message\":\"jwt expired\"}";
            long inizio = System.nanoTime();
            EsitoPut esito = new CaricatorePut(5_000, 5_000).invia(richiesta(server.url(PERCORSO), file, file.length(), new Interruzione(), null));
            assertTrue("in fretta: " + (System.nanoTime() - inizio) / 1_000_000L + " ms", (System.nanoTime() - inizio) / 1_000_000L < 15_000L);
            assertTrue("o la risposta anticipata, o una caduta: " + esito.tipo, esito.tipo == EsitoPut.Tipo.RISPOSTA || esito.tipo == EsitoPut.Tipo.NESSUNA_RISPOSTA);
            if (esito.tipo == EsitoPut.Tipo.RISPOSTA) {
                assertEquals(400, esito.stato);
                assertSame(ErroreStorage.INVALID_JWT, PoliticaCaricamento.leggiCorpoRifiuto(esito.corpo).errore);
            }
        }
    }

    @Test(timeout = 60_000)
    public void unFileAssenteOConUnPesoDiversoNonApreNemmenoUnaConnessione() throws Exception {
        File file = fileCasuale("v.mp4", 10_000);
        try (ServerHttpDiProva server = new ServerHttpDiProva()) {
            assertSame(EsitoPut.Tipo.FILE_ASSENTE, new CaricatorePut().invia(richiesta(server.url(PERCORSO), new File(temporanea.getRoot(), "non-c-e.mp4"), 10_000, new Interruzione(), null)).tipo);
            assertSame("una cartella non è un file", EsitoPut.Tipo.FILE_ASSENTE, new CaricatorePut().invia(richiesta(server.url(PERCORSO), temporanea.getRoot(), 10_000, new Interruzione(), null)).tipo);
            assertSame("più pesante del dichiarato", EsitoPut.Tipo.PESO_DIVERSO, new CaricatorePut().invia(richiesta(server.url(PERCORSO), file, 9_999, new Interruzione(), null)).tipo);
            assertSame("più leggero del dichiarato", EsitoPut.Tipo.PESO_DIVERSO, new CaricatorePut().invia(richiesta(server.url(PERCORSO), file, 10_001, new Interruzione(), null)).tipo);
            assertEquals("nessuna connessione aperta", 0, server.connessioni.get());
        }
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * L'AVANZAMENTO
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test(timeout = 60_000)
    public void lAvanzamentoCrescePerSempreEFinisceAlTotaleEHaUnNumeroLimitatoDiChiamate() throws Exception {
        File file = fileCasuale("v.mp4", 10 * 1024 * 1024);
        try (ServerHttpDiProva server = new ServerHttpDiProva()) {
            List<Long> avanzamenti = new ArrayList<>();
            EsitoPut esito = new CaricatorePut().invia(richiesta(server.url(PERCORSO), file, file.length(), new Interruzione(), avanzamenti));
            assertSame(EsitoPut.Tipo.RISPOSTA, esito.tipo);
            assertFalse(avanzamenti.isEmpty());
            long precedente = -1;
            for (long valore : avanzamenti) {
                assertTrue("mai all'indietro: " + avanzamenti, valore > precedente);
                assertTrue(valore <= file.length());
                precedente = valore;
            }
            assertEquals("l'ultimo è il totale", file.length(), (long) avanzamenti.get(avanzamenti.size() - 1));
            // Al più una chiamata per ogni 1% (un blocco da 256 KB su 10 MB è il 2,5%: una per blocco) o ogni 500 ms: poche decine.
            long tetto = 100 + esito.durataMs / CaricatorePut.INTERVALLO_AVANZAMENTO_MS + 3;
            assertTrue("troppe chiamate: " + avanzamenti.size() + " (tetto " + tetto + ")", avanzamenti.size() <= tetto);
        }
    }

    @Test(timeout = 60_000)
    public void unAvanzamentoCheLanciaFaFallireLaPutDentroUnEsitoENonUnaEccezione() throws Exception {
        // Il patto è che il callback non lanci (lo garantisce l'esecutore, che lo racchiude): se lo fa lo stesso, `invia` non esce con
        // un'eccezione ma con una caduta, e la politica la tratta come transitoria.
        File file = fileCasuale("v.mp4", 1_000_000);
        try (ServerHttpDiProva server = new ServerHttpDiProva()) {
            EsitoPut esito = new CaricatorePut().invia(new RichiestaPut(server.url(PERCORSO), CONTENT_TYPE, file, file.length(), inviati -> {
                throw new IllegalStateException("boom");
            }, new Interruzione()));
            assertSame(EsitoPut.Tipo.NESSUNA_RISPOSTA, esito.tipo);
        }
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * L'INTERRUZIONE
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test(timeout = 60_000)
    public void unaInterruzioneDaUnAltroThreadFermaUnaPutInVoloAncheSeIlServerELento() throws Exception {
        File file = fileCasuale("grande.mp4", 24 * 1024 * 1024);
        try (ServerHttpDiProva server = new ServerHttpDiProva()) {
            server.modo = ServerHttpDiProva.Modo.LEGGI_LENTAMENTE;
            server.pausaPerBloccoMs = 40;
            final Interruzione interruzione = new Interruzione();
            final AtomicReference<EsitoPut> esito = new AtomicReference<>();
            Thread filo = new Thread(() -> esito.set(new CaricatorePut(5_000, 60_000).invia(richiesta(server.url(PERCORSO), file, file.length(), interruzione, null))));
            filo.start();
            assertTrue("il server ha cominciato a leggere", ServerHttpDiProva.aspetta(server.corpoIniziato, 10_000));
            long chiesta = System.nanoTime();
            interruzione.interrompi();
            filo.join(15_000);
            assertFalse("il thread della PUT si è fermato", filo.isAlive());
            assertNotNull(esito.get());
            assertSame(EsitoPut.Tipo.INTERROTTO, esito.get().tipo);
            assertTrue("si è fermata subito: " + (System.nanoTime() - chiesta) / 1_000_000L + " ms", (System.nanoTime() - chiesta) / 1_000_000L < 10_000L);
            assertTrue("e non ha spedito tutto", esito.get().byteInviati < file.length());
            assertTrue("il server non ha ricevuto tutto", server.richieste.get(0).byteLetti.get() < file.length());
        }
    }

    @Test(timeout = 60_000)
    public void unaWriteBloccataSuUnaReteCheNonRispondeSiSbloccaSoloChiudendoLaConnessione() throws Exception {
        // Il server non legge niente: dopo qualche megabyte i buffer sono pieni e la `write` del client resta ferma, senza un tempo massimo
        // (`readTimeout` vale per la lettura). La bandiera di interruzione, letta fra un blocco e l'altro, non basta: serve il GANCIO che
        // chiude la connessione. Senza, la PUT resterebbe appesa fino a quando il server chiude (qui 20 s, sul telefono minuti).
        File file = fileCasuale("bloccata.mp4", 48 * 1024 * 1024);
        try (ServerHttpDiProva server = new ServerHttpDiProva()) {
            server.modo = ServerHttpDiProva.Modo.NON_LEGGERE_IL_CORPO;
            server.fermoMs = 25_000L;
            final Interruzione interruzione = new Interruzione();
            final AtomicReference<EsitoPut> esito = new AtomicReference<>();
            Thread filo = new Thread(() -> esito.set(new CaricatorePut(5_000, 60_000).invia(richiesta(server.url(PERCORSO), file, file.length(), interruzione, null))));
            filo.start();
            assertTrue(ServerHttpDiProva.aspetta(server.corpoIniziato, 10_000));
            Thread.sleep(1_500);                      // il tempo di riempire i buffer: la write è ferma
            long chiesta = System.nanoTime();
            interruzione.interrompi();
            filo.join(12_000);
            assertFalse("la PUT è ripartita dalla write ferma", filo.isAlive());
            assertSame(EsitoPut.Tipo.INTERROTTO, esito.get().tipo);
            assertTrue("e subito, non dopo la chiusura del server: " + (System.nanoTime() - chiesta) / 1_000_000L + " ms", (System.nanoTime() - chiesta) / 1_000_000L < 8_000L);
        }
    }

    @Test(timeout = 60_000)
    public void unaInterruzioneGiaChiestaPrimaDellaPartenzaNonSpedisceNiente() throws Exception {
        File file = fileCasuale("v.mp4", 5 * 1024 * 1024);
        try (ServerHttpDiProva server = new ServerHttpDiProva()) {
            Interruzione interruzione = new Interruzione();
            interruzione.interrompi();
            EsitoPut esito = new CaricatorePut().invia(richiesta(server.url(PERCORSO), file, file.length(), interruzione, null));
            assertSame(EsitoPut.Tipo.INTERROTTO, esito.tipo);
            assertEquals("nemmeno un blocco", 0L, esito.byteInviati);
        }
    }

    @Test(timeout = 60_000)
    public void dopoLaPutIlGancioDiInterruzioneNonPuntaPiuAUnaConnessioneChiusa() throws Exception {
        File file = fileCasuale("v.mp4", 10_000);
        try (ServerHttpDiProva server = new ServerHttpDiProva()) {
            Interruzione interruzione = new Interruzione();
            new CaricatorePut().invia(richiesta(server.url(PERCORSO), file, file.length(), interruzione, null));
            interruzione.interrompi();    // tardiva: non deve lanciare né toccare niente
            assertTrue(interruzione.richiesta());
        }
    }

    @Test
    public void lInterruzioneEsegueIlGancioUnaVoltaPerChiamataENonLanciaSeIlGancioLancia() {
        Interruzione interruzione = new Interruzione();
        final int[] chiamate = {0};
        interruzione.agganciaA(() -> chiamate[0]++);
        assertEquals("non ancora richiesta: il gancio non gira", 0, chiamate[0]);
        interruzione.interrompi();
        assertEquals(1, chiamate[0]);
        // Un gancio registrato dopo la richiesta gira subito.
        interruzione.agganciaA(() -> chiamate[0] += 10);
        assertEquals(11, chiamate[0]);
        // Un gancio che lancia non fa lanciare la richiesta.
        Interruzione cheLancia = new Interruzione();
        cheLancia.agganciaA(() -> {
            throw new IllegalStateException("chiusura impossibile");
        });
        cheLancia.interrompi();
        assertTrue(cheLancia.richiesta());
    }

    @Test
    public void iFattoriDegliEsitiHannoLeForme() {
        EsitoPut r = EsitoPut.risposta(400, "{}".getBytes(StandardCharsets.UTF_8), 5L, 10L, 20L, true);
        assertSame(EsitoPut.Tipo.RISPOSTA, r.tipo);
        assertEquals(400, r.stato);
        assertArrayEquals("{}".getBytes(StandardCharsets.UTF_8), r.corpo);
        assertTrue(r.completo);
        EsitoPut senza = EsitoPut.risposta(200, null, 0L, 0L, 0L, true);
        assertEquals("il corpo non è mai null", 0, senza.corpo.length);
        assertSame(EsitoPut.Tipo.INTERROTTO, EsitoPut.interrotto(1L, 2L).tipo);
        assertSame(EsitoPut.Tipo.FILE_ASSENTE, EsitoPut.fileAssente().tipo);
        assertSame(EsitoPut.Tipo.PESO_DIVERSO, EsitoPut.pesoDiverso().tipo);
        assertEquals(0, EsitoPut.nessunaRisposta(1L, 2L, null).stato);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * COMPITO A2b (secondario n. 84 della PR 3)
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void unaChiusuraDiUnFlussoCheFallisceNonCambiaLEsitoMaSiDiceInLogcatSenzaDati() {
        try (RigheDiLogcat logcat = new RigheDiLogcat()) {
            CaricatorePut.chiudi(() -> {
                throw new IOException("/data/user/0/it.kidville.app/privato/video.mp4: Input/output error");
            });
            CaricatorePut.chiudi(null);                            // niente da chiudere: nessuna riga
            assertEquals("una riga `info`, col tag del pacchetto, la sola classe e perché non conta",
                    Arrays.asList("I KidvilleCaricamenti chiusura di un flusso della PUT non riuscita (IOException): ignorabile, l'esito della PUT è già noto"),
                    new ArrayList<>(logcat.righe));
            for (String riga : logcat.righe) assertFalse("niente percorso né messaggio d'eccezione: " + riga, riga.contains("/data/") || riga.contains("video.mp4"));
        }
    }

    @Test
    public void unaChiusuraCheRiesceNonDiceNiente() {
        try (RigheDiLogcat logcat = new RigheDiLogcat()) {
            CaricatorePut.chiudi(() -> {
            });
            assertTrue(logcat.righe.isEmpty());
        }
    }
}
