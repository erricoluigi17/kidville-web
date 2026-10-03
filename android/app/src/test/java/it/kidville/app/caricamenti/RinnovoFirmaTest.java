package it.kidville.app.caricamenti;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import it.kidville.app.caricamenti.EsecutoreCoda.RispostaHttp;
import it.kidville.app.caricamenti.PoliticaCaricamento.RispostaRinnovo;
import it.kidville.app.caricamenti.PoliticaCaricamento.TipoRinnovo;

import org.junit.Test;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.ServerSocket;
import java.net.URI;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/**
 * Il rinnovo della firma (spec §1.2, §4.5, §5.4; compito A2): un POST con il token nell'intestazione e un corpo vuoto, nessun cookie e
 * nessuna credenziale, le risposte del server lette per forma dalla politica, e nessun guasto che lanci.
 */
public class RinnovoFirmaTest {

    private static final String TOKEN = "kvr_" + "T".repeat(43);
    private static final String PERCORSO = "/api/video-uploads/rinnovo";

    private static final String DA_CARICARE = "{\"stato\":\"da-caricare\",\"caricamento\":{\"protocollo\":\"put\",\"url\":\"https://uimulkjyekgemjakmepp.supabase.co/storage/v1/object/upload/sign/b/p?token=t\","
            + "\"metodo\":\"PUT\",\"intestazioni\":{\"content-type\":\"video/mp4\"}},\"scadeIl\":\"2026-10-05T10:00:00.000Z\"}";

    @Test(timeout = 60_000)
    public void unPostConIlTokenNellIntestazioneELaRispostaDelServer() throws Exception {
        try (ServerHttpDiProva server = new ServerHttpDiProva()) {
            server.corpoRisposta = DA_CARICARE;
            RispostaHttp risposta = new RinnovoFirma().rinnova(server.url(PERCORSO), TOKEN);
            assertEquals(200, risposta.stato);
            assertEquals(DA_CARICARE, risposta.corpo);
            assertNull(risposta.classe);

            ServerHttpDiProva.Richiesta vista = server.ultima();
            assertEquals("POST", vista.metodo);
            assertEquals("il token NON è nell'indirizzo", PERCORSO, vista.percorso);
            assertEquals("il token sta nell'intestazione, una volta sola", Arrays.asList(TOKEN), vista.intestazioni.get("x-kidville-rinnovo"));
            assertEquals("corpo vuoto", "0", vista.intestazione("content-length"));
            assertEquals(0L, vista.byteLetti.get());
            assertEquals("application/json", vista.intestazione("accept"));
            assertFalse("nessun cookie: è una porta senza sessione", vista.haIntestazione("cookie"));
            assertFalse("nessuna credenziale", vista.haIntestazione("authorization"));
            assertFalse(vista.haIntestazione("apikey"));
            assertFalse("il rinnovo non ha bisogno di un'identità", vista.haIntestazione("x-user-id"));
        }
    }

    @Test(timeout = 60_000)
    public void lElencoCompletoDelleIntestazioniELaNostraPiuQuelleDelSistema() throws Exception {
        try (ServerHttpDiProva server = new ServerHttpDiProva()) {
            new RinnovoFirma().rinnova(server.url(PERCORSO), TOKEN);
            // Più il `content-type` che `HttpURLConnection` aggiunge da sé a un POST (la route non legge il corpo, che è vuoto).
            Set<String> ammesse = new HashSet<>(Arrays.asList("host", "user-agent", "accept", "connection", "content-length", "content-type", "x-kidville-rinnovo"));
            for (String nome : server.ultima().intestazioni.keySet()) {
                assertTrue("intestazione inattesa: " + nome, ammesse.contains(nome.toLowerCase()));
            }
        }
    }

    @Test(timeout = 60_000)
    public void laRispostaDaCaricareSiLeggePerFormaConLaPolitica() throws Exception {
        try (ServerHttpDiProva server = new ServerHttpDiProva()) {
            server.corpoRisposta = DA_CARICARE;
            RispostaHttp r = new RinnovoFirma().rinnova(server.url(PERCORSO), TOKEN);
            RispostaRinnovo letta = PoliticaCaricamento.leggiRispostaRinnovo(r.stato, r.corpo, r.retryAfterSecondi, false);
            assertSame(TipoRinnovo.DA_CARICARE, letta.tipo);
            assertEquals("video/mp4", letta.contentType);
            assertTrue(letta.urlPut.startsWith("https://uimulkjyekgemjakmepp.supabase.co/"));
        }
    }

    @Test(timeout = 60_000)
    public void unQuattrocentoQuattroELaSuaRispostaUniforme() throws Exception {
        try (ServerHttpDiProva server = new ServerHttpDiProva()) {
            server.stato = 404;
            server.corpoRisposta = "{\"codice\":\"VIDEO_NON_TROVATO\"}";
            RispostaHttp r = new RinnovoFirma().rinnova(server.url(PERCORSO), TOKEN);
            assertEquals(404, r.stato);
            assertEquals("il corpo di un rifiuto si legge", "{\"codice\":\"VIDEO_NON_TROVATO\"}", r.corpo);
            assertSame(TipoRinnovo.NON_TROVATO, PoliticaCaricamento.leggiRispostaRinnovo(r.stato, r.corpo, 0L, false).tipo);
        }
    }

    @Test(timeout = 60_000)
    public void unQuattrocentoVentinoveHaIlRetryAfter() throws Exception {
        try (ServerHttpDiProva server = new ServerHttpDiProva()) {
            server.stato = 429;
            server.intestazioniRisposta.put("Retry-After", "90");
            RispostaHttp r = new RinnovoFirma().rinnova(server.url(PERCORSO), TOKEN);
            assertEquals(429, r.stato);
            assertEquals(90L, r.retryAfterSecondi);
        }
    }

    @Test(timeout = 60_000)
    public void unCorpoEnormeSiLeggeSoloFinoAlLimiteEdAMemoriaLimitata() throws Exception {
        try (ServerHttpDiProva server = new ServerHttpDiProva()) {
            StringBuilder enorme = new StringBuilder("{\"stato\":\"da-caricare\",\"x\":\"");
            for (int i = 0; i < 200_000; i++) enorme.append('x');
            enorme.append("\"}");
            server.corpoRisposta = enorme.toString();
            RispostaHttp r = new RinnovoFirma().rinnova(server.url(PERCORSO), TOKEN);
            assertEquals(200, r.stato);
            assertEquals("32 KB e non uno di più", RinnovoFirma.CORPO_MASSIMO_BYTE, r.corpo.length());
            assertSame("troncato, il JSON non è valido: transitorio, mai un esito definitivo", TipoRinnovo.TRANSITORIO_SERVER,
                    PoliticaCaricamento.leggiRispostaRinnovo(r.stato, r.corpo, 0L, false).tipo);
        }
    }

    @Test(timeout = 60_000)
    public void nessunaRispostaEUnValoreConLaClasseDellEccezioneENonUnaEccezione() throws Exception {
        int portaChiusa;
        try (ServerSocket occupata = new ServerSocket(0)) {
            portaChiusa = occupata.getLocalPort();
        }
        RispostaHttp r = new RinnovoFirma(2_000, 2_000).rinnova("http://127.0.0.1:" + portaChiusa + PERCORSO, TOKEN);
        assertEquals(0, r.stato);
        assertNull(r.corpo);
        assertNotNull(r.classe);
        assertSame(TipoRinnovo.TRANSITORIO_RETE, PoliticaCaricamento.leggiRispostaRinnovo(r.stato, r.corpo, 0L, false).tipo);
    }

    @Test(timeout = 60_000)
    public void unIndirizzoCheNonSiLeggeNonLancia() {
        for (String url : new String[]{"::::", "http://", "senza schema"}) {
            assertEquals("«" + url + "»", 0, new RinnovoFirma(1_000, 1_000).rinnova(url, TOKEN).stato);
        }
    }

    @Test(timeout = 60_000)
    public void unaRispostaCheNonArrivaScadeAlTempoMassimoDiLettura() throws Exception {
        try (ServerHttpDiProva server = new ServerHttpDiProva()) {
            server.modo = ServerHttpDiProva.Modo.LEGGI_E_NON_RISPONDERE;
            long inizio = System.nanoTime();
            RispostaHttp r = new RinnovoFirma(2_000, 400).rinnova(server.url(PERCORSO), TOKEN);
            assertEquals(0, r.stato);
            assertTrue("scaduta in fretta", (System.nanoTime() - inizio) / 1_000_000L < 5_000L);
        }
    }

    @Test(timeout = 60_000)
    public void unReindirizzamentoNonSiSegue() throws Exception {
        try (ServerHttpDiProva server = new ServerHttpDiProva()) {
            server.stato = 301;
            server.intestazioniRisposta.put("Location", "http://127.0.0.1:1/altrove");
            RispostaHttp r = new RinnovoFirma().rinnova(server.url(PERCORSO), TOKEN);
            assertEquals("lo stato arriva com'è, e la politica lo legge come transitorio", 301, r.stato);
            assertEquals(1, server.richieste.size());
            assertSame(TipoRinnovo.TRANSITORIO_SERVER, PoliticaCaricamento.leggiRispostaRinnovo(r.stato, r.corpo, 0L, false).tipo);
        }
    }

    @Test
    public void laConnessioneSiConfiguraSenzaCookieNeCredenziali() throws Exception {
        HttpURLConnection c = (HttpURLConnection) URI.create("http://127.0.0.1:9/x").toURL().openConnection();
        RinnovoFirma.configura(c, TOKEN, 11_111, 22_222);
        assertEquals("POST", c.getRequestMethod());
        assertEquals(11_111, c.getConnectTimeout());
        assertEquals(22_222, c.getReadTimeout());
        assertFalse(c.getInstanceFollowRedirects());
        assertEquals(TOKEN, c.getRequestProperty("x-kidville-rinnovo"));
        assertNull(c.getRequestProperty("cookie"));
        assertNull(c.getRequestProperty("authorization"));
        assertNull(c.getRequestProperty("apikey"));
    }

    @Test
    public void iTempiMassimiEIlNomeDellIntestazioneSonoQuelliDelContratto() {
        assertEquals("x-kidville-rinnovo", RinnovoFirma.INTESTAZIONE_TOKEN);
        assertEquals("30 s per leggere (§5.4)", 30_000, RinnovoFirma.TIMEOUT_LETTURA_MS);
        assertEquals(15_000, RinnovoFirma.TIMEOUT_CONNESSIONE_MS);
    }

    @Test(timeout = 60_000)
    public void ilTokenNonCompareInNessunaEccezioneNeMessaggioDelRisultato() throws Exception {
        // Il risultato porta lo stato, il corpo del server e la CLASSE dell'eccezione: mai un testo che possa contenere il token.
        RispostaHttp r = new RinnovoFirma(500, 500).rinnova("http://127.0.0.1:1/" + TOKEN, TOKEN);
        assertEquals(0, r.stato);
        assertFalse(String.valueOf(r.classe).contains("kvr_"));
        for (java.lang.reflect.Field campo : RispostaHttp.class.getDeclaredFields()) {
            assertTrue("campo inatteso nel risultato: " + campo.getName(), Arrays.asList("stato", "corpo", "retryAfterSecondi", "classe").contains(campo.getName()));
        }
    }

    @Test
    public void unaCadutaInScritturaDelCorpoVuotoNonLanciaMai() throws Exception {
        // Una connessione accettata e chiusa subito dal server: nessuna eccezione verso l'esecutore.
        try (ServerSocket chiudiSubito = new ServerSocket(0)) {
            Thread filo = new Thread(() -> {
                try {
                    chiudiSubito.accept().close();
                } catch (IOException fine) {
                    // il test è finito
                }
            });
            filo.setDaemon(true);
            filo.start();
            RispostaHttp r = new RinnovoFirma(2_000, 2_000).rinnova("http://127.0.0.1:" + chiudiSubito.getLocalPort() + PERCORSO, TOKEN);
            assertEquals(0, r.stato);
        }
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * COMPITO A2b (secondari n. 78 e n. 84 della PR 3)
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void unaChiusuraDiUnFlussoCheFallisceNonCambiaLaRispostaMaSiDiceInLogcatSenzaDati() {
        try (RigheDiLogcat logcat = new RigheDiLogcat()) {
            RinnovoFirma.chiudi(() -> {
                throw new IOException("/data/user/0/it.kidville.app/privato: Input/output error");
            });
            assertEquals("una riga `info`, col tag del pacchetto, la sola classe e perché non conta",
                    Arrays.asList("I KidvilleCaricamenti chiusura di un flusso del rinnovo non riuscita (IOException): ignorabile, la risposta è già stata letta"),
                    new java.util.ArrayList<>(logcat.righe));
            for (String riga : logcat.righe) assertFalse("niente percorso né messaggio d'eccezione: " + riga, riga.contains("/data/") || riga.contains("privato"));
        }
    }

    @Test
    public void unaChiusuraCheRiesceNonDiceNiente() {
        try (RigheDiLogcat logcat = new RigheDiLogcat()) {
            RinnovoFirma.chiudi(() -> {
            });
            assertTrue(logcat.righe.isEmpty());
        }
    }

    @Test(timeout = 60_000)
    public void unRinnovoCheRiesceNonScriveRigheDiLogcatPerLaChiusuraDelFlusso() throws Exception {
        try (ServerHttpDiProva server = new ServerHttpDiProva(); RigheDiLogcat logcat = new RigheDiLogcat()) {
            server.corpoRisposta = DA_CARICARE;
            RispostaHttp risposta = new RinnovoFirma().rinnova(server.url(PERCORSO), TOKEN);
            assertEquals(200, risposta.stato);
            assertTrue("nessun guasto, nessuna riga: " + logcat.righe, logcat.righe.isEmpty());
        }
    }

    @Test
    public void ilCommentoDiRinnovoFirmaNonPromettePiuNessunCookieMaDiceLaVerita() throws Exception {
        // Secondario n. 78: CapacitorCookies installa un gestore globale (`CookieHandler.setDefault`), quindi una richiesta nativa verso il
        // dominio dell'app PUÒ portare i cookie della WebView. La promessa «nessun cookie» era falsa; il commento deve dire come stanno le cose.
        java.io.File sorgente = new java.io.File(new java.io.File("").getAbsoluteFile(), "src/main/java/it/kidville/app/caricamenti/RinnovoFirma.java");
        if (!sorgente.isFile()) sorgente = new java.io.File(new java.io.File("").getAbsoluteFile(), "app/src/main/java/it/kidville/app/caricamenti/RinnovoFirma.java");
        String testo = new String(java.nio.file.Files.readAllBytes(sorgente.toPath()), java.nio.charset.StandardCharsets.UTF_8);
        assertFalse("la promessa falsa non c'è più", testo.contains("NESSUN COOKIE"));
        assertTrue("dice che il gestore globale di Capacitor può portare i cookie della WebView", testo.contains("CookieHandler.setDefault") && testo.contains("PUÒ portare i cookie"));
        assertTrue("e che il rinnovo non li usa: autentica col token", testo.contains("AUTENTICA COL TOKEN, NON COI COOKIE"));
    }
}
