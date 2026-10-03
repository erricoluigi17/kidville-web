package it.kidville.app.caricamenti;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import it.kidville.app.caricamenti.CodaCaricamenti.EsitoTransizione;
import it.kidville.app.caricamenti.CodaCaricamenti.Origine;
import it.kidville.app.caricamenti.CodaCaricamenti.ReportPulizia;
import it.kidville.app.caricamenti.CodaCaricamenti.RisultatoAggiunta;
import it.kidville.app.caricamenti.CodaCaricamenti.Testi;
import it.kidville.app.caricamenti.CodaCaricamenti.TipoTransizione;
import it.kidville.app.caricamenti.CodaCaricamenti.VoceCoda;
import it.kidville.app.caricamenti.PoliticaCaricamento.Codice;
import it.kidville.app.caricamenti.PoliticaCaricamento.EventoStato;
import it.kidville.app.caricamenti.PoliticaCaricamento.Stato;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Assume;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Pattern;

/**
 * La coda persistente dei caricamenti (spec §4.4, §4.6, §9; compito A1): il file `coda.json` com'è su disco, la corruzione, la
 * pulizia, le transizioni che cancellano copia e segreti, i guasti di scrittura, la forma che il ponte rilegge con zod.
 *
 * Nessun test usa Android: `AtomicFile` è quello di AndroidX (Java puro), `org.json` quello di Maven, la cartella una
 * `TemporaryFolder`, l'orologio un contatore che il test muove a mano.
 */
public class CodaCaricamentiTest {

    @Rule
    public TemporaryFolder temporanea = new TemporaryFolder();

    private File cartella;
    private final AtomicLong orologio = new AtomicLong(1_790_000_000_000L);

    private static final long ORA = 3_600_000L;
    private static final long GIORNO = 24L * ORA;

    @Before
    public void preparaCartella() throws IOException {
        cartella = temporanea.newFolder("caricamenti");
    }

    private CodaCaricamenti apri() {
        return new CodaCaricamenti(cartella, orologio::get);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * UTENSILI
     * ──────────────────────────────────────────────────────────────────────────── */

    private static String id(int n) {
        return String.format(Locale.ROOT, "%08x-1111-4111-8111-%012x", n, n);
    }

    private static final String UTENTE = id(2000);
    private static final String ALTRO_UTENTE = id(2001);
    private static final String SCUOLA = id(3000);
    /** Un carattere fuori dal piano base (U+1F3A5): in UTF-16 sono DUE unità, una coppia surrogata. Costruito, non scritto. */
    private static final String FUORI_DAL_PIANO_BASE = new String(Character.toChars(0x1F3A5));

    private VoceCoda nuova(int n) {
        String job = id(n);
        return VoceCoda.nuova(job, id(1000 + n), UTENTE, SCUOLA, "prova-" + n + ".mp4", "file/" + job + ".mp4", 5_000_000L + n,
                "video/mp4", Origine.GALLERIA, orologio.get() + 2 * ORA, orologio.get() + 2 * GIORNO);
    }

    private File fileDi(String sottocartella, String nome) {
        File dir = new File(cartella, sottocartella);
        dir.mkdirs();
        return new File(dir, nome);
    }

    private File creaFile(String sottocartella, String nome, long ultimaModificaMs) throws IOException {
        File f = fileDi(sottocartella, nome);
        try (FileOutputStream uscita = new FileOutputStream(f)) {
            uscita.write(new byte[]{1, 2, 3, 4});
        }
        assertTrue(f.setLastModified(ultimaModificaMs));
        return f;
    }

    private JSONObject leggiCoda() throws Exception {
        byte[] dati = java.nio.file.Files.readAllBytes(new File(cartella, "coda.json").toPath());
        return new JSONObject(new String(dati, StandardCharsets.UTF_8));
    }

    private void scrivi(String nome, byte[] contenuto) throws IOException {
        try (FileOutputStream uscita = new FileOutputStream(new File(cartella, nome))) {
            uscita.write(contenuto);
        }
    }

    private void scrivi(String nome, String contenuto) throws IOException {
        scrivi(nome, contenuto.getBytes(StandardCharsets.UTF_8));
    }

    private List<File> corrotte() {
        List<File> trovate = new ArrayList<>();
        File[] tutti = cartella.listFiles();
        if (tutti == null) return trovate;
        for (File f : tutti) {
            if (f.getName().matches("^coda\\.corrotta-\\d+(-\\d)?\\.json$")) trovate.add(f);
        }
        return trovate;
    }

    private static Set<String> nomi(JSONObject json) {
        Set<String> nomi = new HashSet<>();
        Iterator<String> it = json.keys();
        while (it.hasNext()) nomi.add(it.next());
        return nomi;
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * AVVIO E FORMA DEL FILE
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void senzaFileLaCodaEVuotaENonSegnalaNiente() throws Exception {
        CodaCaricamenti coda = apri();
        assertEquals(0, coda.numeroVoci());
        assertFalse(coda.rapporto().corrotta);
        assertEquals(0, coda.rapporto().fileOrfani);
        assertEquals(0, coda.rapporto().vociScartate);
        assertFalse(coda.rapporto().daSegnalare());
        assertFalse("senza scritture non nasce nessun file", new File(cartella, "coda.json").exists());
        assertTrue(corrotte().isEmpty());
        assertEquals("i testi sono quelli di ripiego", "Kidville", coda.testi().titolo);
    }

    @Test
    public void laCartellaSiCreaSeManca() {
        File nuovaCartella = new File(temporanea.getRoot(), "livello1/livello2/caricamenti");
        CodaCaricamenti coda = new CodaCaricamenti(nuovaCartella, orologio::get);
        assertTrue(nuovaCartella.isDirectory());
        assertEquals(0, coda.numeroVoci());
    }

    @Test
    public void aggiungiScriveSubitoIlFileConLeChiaviDiSpec() throws Exception {
        CodaCaricamenti coda = apri();
        RisultatoAggiunta r = coda.aggiungi(nuova(1));
        assertFalse(r.giaPresente);
        assertSame(Stato.IN_CODA, r.voce.stato);

        JSONObject radice = leggiCoda();
        assertEquals(1, radice.getInt("versione"));
        assertEquals(new HashSet<>(Arrays.asList("versione", "testi", "voci")), nomi(radice));
        assertEquals(new HashSet<>(Arrays.asList("titolo", "invio", "attesaRete", "pausa")), nomi(radice.getJSONObject("testi")));
        JSONArray voci = radice.getJSONArray("voci");
        assertEquals(1, voci.length());
        JSONObject v = voci.getJSONObject(0);
        // §4.6: jobId, intentId, utenteId, scuolaId, nome, file, byte, mime, stato, tentativi, rinnovi, rinnoviConsecutivi, codice,
        // prossimoTentativoIl, urlScadeIl, tokenScadeIl, origine, creatoIl, aggiornatoIl (creatoInBackground è solo iOS).
        assertEquals(new HashSet<>(Arrays.asList("jobId", "intentId", "utenteId", "scuolaId", "nome", "file", "byte", "mime", "stato",
                "tentativi", "rinnovi", "rinnoviConsecutivi", "codice", "prossimoTentativoIl", "urlScadeIl", "tokenScadeIl", "origine",
                "creatoIl", "aggiornatoIl")), nomi(v));
        assertEquals(id(1), v.getString("jobId"));
        assertEquals(id(1001), v.getString("intentId"));
        assertEquals(UTENTE, v.getString("utenteId"));
        assertEquals(SCUOLA, v.getString("scuolaId"));
        assertEquals("file/" + id(1) + ".mp4", v.getString("file"));
        assertEquals(5_000_001L, v.getLong("byte"));
        assertEquals("video/mp4", v.getString("mime"));
        assertEquals("in-coda", v.getString("stato"));
        assertEquals(0, v.getInt("tentativi"));
        assertEquals(0, v.getInt("rinnovi"));
        assertEquals(0, v.getInt("rinnoviConsecutivi"));
        assertTrue("codice presente e nullo", v.has("codice") && v.isNull("codice"));
        assertEquals("galleria", v.getString("origine"));
        assertEquals(orologio.get(), v.getLong("creatoIl"));
        assertEquals(orologio.get(), v.getLong("aggiornatoIl"));
    }

    @Test
    public void ilFileNonPortaSegretiNeUrlNeToken() throws Exception {
        CodaCaricamenti coda = apri();
        coda.aggiungi(nuova(1));
        coda.transita(id(1), EventoStato.AVVIATO, null);
        String testo = new String(java.nio.file.Files.readAllBytes(new File(cartella, "coda.json").toPath()), StandardCharsets.UTF_8);
        // (la CHIAVE `tokenScadeIl` è un istante, non un segreto: si cercano le forme in cui un token comparirebbe davvero)
        for (String vietato : new String[]{"http", "://", "supabase", "kvr_", "\"token\"", "token=", "authorization", "apikey", cartella.getPath(),
                temporanea.getRoot().getPath()}) {
            assertFalse("«" + vietato + "» non deve stare nella coda", testo.toLowerCase(Locale.ROOT).contains(vietato.toLowerCase(Locale.ROOT)));
        }
        // `file` è RELATIVO: mai un percorso assoluto, che cambierebbe a ogni reinstallazione.
        JSONObject v = leggiCoda().getJSONArray("voci").getJSONObject(0);
        assertTrue(v.getString("file").startsWith("file/"));
        assertFalse(v.getString("file").startsWith("/"));
    }

    @Test
    public void unaCodaRiapertaRitrovaLeVociEgliStati() throws Exception {
        CodaCaricamenti prima = apri();
        prima.aggiungi(nuova(1));
        prima.aggiungi(nuova(2));
        orologio.addAndGet(5_000L);
        prima.transita(id(1), EventoStato.AVVIATO, null);
        prima.transita(id(1), EventoStato.IN_ATTESA_DI_RETE, Codice.RETE);
        prima.modifica(id(1), v -> {
            v.tentativi = 4;
            v.rinnovi = 2;
            v.rinnoviConsecutivi = 1;
            v.prossimoTentativoIl = 123_456L;
            v.urlScadeIl = 777_000L;
            v.tokenScadeIl = 888_000L;
        });

        CodaCaricamenti dopo = apri();
        assertFalse(dopo.rapporto().daSegnalare());
        assertEquals(2, dopo.numeroVoci());
        VoceCoda a = dopo.trova(id(1));
        assertSame(Stato.IN_ATTESA, a.stato);
        assertSame(Codice.RETE, a.codice);
        assertEquals(4, a.tentativi);
        assertEquals(2, a.rinnovi);
        assertEquals(1, a.rinnoviConsecutivi);
        assertEquals(123_456L, a.prossimoTentativoIl);
        assertEquals(777_000L, a.urlScadeIl);
        assertEquals(888_000L, a.tokenScadeIl);
        assertEquals("file/" + id(1) + ".mp4", a.file);
        assertEquals(5_000_001L, a.byteTotali);
        assertEquals(UTENTE, a.utenteId);
        assertEquals(id(1001), a.intentId);
        assertSame(Origine.GALLERIA, a.origine);
        assertEquals(1_790_000_000_000L, a.creatoIl);
        assertEquals(1_790_000_005_000L, a.aggiornatoIl);
        assertSame(Stato.IN_CODA, dopo.trova(id(2)).stato);
    }

    @Test
    public void ilNomeDiUnaVoceVuotoOLungoSiSistemaAllIngresso() throws Exception {
        CodaCaricamenti coda = apri();
        VoceCoda vuota = nuova(1);
        vuota.nome = "   ";
        assertEquals("Video", coda.aggiungi(vuota).voce.nome);
        VoceCoda lunga = nuova(2);
        lunga.nome = repeat('x', 400);
        assertEquals(255, coda.aggiungi(lunga).voce.nome.length());
        VoceCoda normale = nuova(3);
        normale.nome = "  Gita al parco.mp4 ";
        assertEquals("Gita al parco.mp4", coda.aggiungi(normale).voce.nome);
    }

    private static String repeat(char c, int volte) {
        char[] caratteri = new char[volte];
        Arrays.fill(caratteri, c);
        return new String(caratteri);
    }

    @Test
    public void gliIstantiLiMetteLaCodaDalSuoOrologio() throws Exception {
        CodaCaricamenti coda = apri();
        VoceCoda v = nuova(1);
        v.creatoIl = 5L;
        v.aggiornatoIl = 6L;
        VoceCoda dentro = coda.aggiungi(v).voce;
        assertEquals(1_790_000_000_000L, dentro.creatoIl);
        assertEquals(1_790_000_000_000L, dentro.aggiornatoIl);
        orologio.addAndGet(9_000L);
        EsitoTransizione e = coda.transita(id(1), EventoStato.AVVIATO, null);
        assertEquals("creatoIl non cambia", 1_790_000_000_000L, e.voce.creatoIl);
        assertEquals("aggiornatoIl segue l'orologio", 1_790_000_009_000L, e.voce.aggiornatoIl);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * AGGIUNGI
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void aggiungiEIdempotenteSuJobIdELaSecondaChiamataNonTocca() throws Exception {
        CodaCaricamenti coda = apri();
        coda.aggiungi(nuova(1));
        coda.transita(id(1), EventoStato.AVVIATO, null);
        VoceCoda diversa = nuova(1);
        diversa.nome = "un altro nome.mp4";
        diversa.byteTotali = 99L;
        RisultatoAggiunta seconda = coda.aggiungi(diversa);
        assertTrue(seconda.giaPresente);
        assertSame("restituisce lo stato attuale, non quello della richiesta", Stato.IN_INVIO, seconda.voce.stato);
        assertEquals("prova-1.mp4", seconda.voce.nome);
        assertEquals(5_000_001L, seconda.voce.byteTotali);
        assertEquals(1, coda.numeroVoci());
    }

    @Test
    public void aggiungiRifiutaLeVociFuoriForma() throws Exception {
        CodaCaricamenti coda = apri();
        List<VoceCoda> rotte = new ArrayList<>();
        String job = id(1);
        for (String id : new String[]{null, "", "non-un-uuid", id(10).toUpperCase(Locale.ROOT), id(1) + "x", id(1).substring(1),
                "../" + id(1), id(1).replace('-', '_')}) {
            VoceCoda v = new VoceCoda(id, id(1001), UTENTE, SCUOLA);
            riempi(v, job);
            rotte.add(v);
            VoceCoda v2 = new VoceCoda(job, id, UTENTE, SCUOLA);
            riempi(v2, job);
            rotte.add(v2);
            VoceCoda v3 = new VoceCoda(job, id(1001), id, SCUOLA);
            riempi(v3, job);
            rotte.add(v3);
            VoceCoda v4 = new VoceCoda(job, id(1001), UTENTE, id);
            riempi(v4, job);
            rotte.add(v4);
        }
        for (String file : new String[]{"", "file/", "file/x.mp4", "file/../" + job + ".mp4", "/" + job + ".mp4", "scelti/" + job + ".mp4",
                "file/" + id(2) + ".mp4", "file/" + job + ".MP4", "file/" + job + ".mp4x6c", "file/" + job + ".", "file/" + job,
                "file/" + job + ".mp4/../x", "file//" + job + ".mp4", "file\\" + job + ".mp4", "./file/" + job + ".mp4",
                "/data/data/it.kidville.app/file/" + job + ".mp4", "file/" + job + ".mp4 "}) {
            VoceCoda v = nuova(1);
            v.file = file;
            rotte.add(v);
        }
        VoceCoda senzaCopia = nuova(1);
        senzaCopia.file = null;
        rotte.add(senzaCopia);
        VoceCoda senzaPeso = nuova(1);
        senzaPeso.byteTotali = 0L;
        rotte.add(senzaPeso);
        VoceCoda pesoNegativo = nuova(1);
        pesoNegativo.byteTotali = -4L;
        rotte.add(pesoNegativo);
        VoceCoda senzaNome = nuova(1);
        senzaNome.nome = null;
        rotte.add(senzaNome);
        VoceCoda senzaMime = nuova(1);
        senzaMime.mime = null;
        rotte.add(senzaMime);
        VoceCoda mimeVuoto = nuova(1);
        mimeVuoto.mime = "";
        rotte.add(mimeVuoto);
        VoceCoda senzaOrigine = nuova(1);
        senzaOrigine.origine = null;
        rotte.add(senzaOrigine);
        VoceCoda contatoreNegativo = nuova(1);
        contatoreNegativo.tentativi = -1;
        rotte.add(contatoreNegativo);
        VoceCoda istanteNegativo = nuova(1);
        istanteNegativo.urlScadeIl = -1L;
        rotte.add(istanteNegativo);
        rotte.add(null);

        for (VoceCoda rotta : rotte) {
            try {
                coda.aggiungi(rotta);
                fail("accettata una voce fuori forma: " + (rotta == null ? "null" : rotta.jobId + " / " + rotta.file));
            } catch (IllegalArgumentException atteso) {
                // è il rifiuto che il chiamante traduce in PARAMETRI_NON_VALIDI
            }
        }
        assertEquals("nessuna voce fuori forma è entrata", 0, coda.numeroVoci());
        assertFalse("e nessun file è stato scritto", new File(cartella, "coda.json").exists());
    }

    private void riempi(VoceCoda v, String job) {
        v.nome = "prova.mp4";
        v.file = "file/" + job + ".mp4";
        v.byteTotali = 1000L;
        v.mime = "video/mp4";
        v.stato = Stato.IN_CODA;
        v.origine = Origine.GALLERIA;
    }

    @Test
    public void unaVoceVivaSenzaCopiaNonEntra() throws Exception {
        // Non c'è niente da spedire: `file` nullo è lecito solo per una voce terminale riletta da disco.
        CodaCaricamenti coda = apri();
        VoceCoda v = nuova(1);
        v.file = null;
        try {
            coda.aggiungi(v);
            fail("una voce viva senza copia");
        } catch (IllegalArgumentException atteso) {
            // PARAMETRI_NON_VALIDI
        }
        assertEquals(0, coda.numeroVoci());
    }

    @Test
    public void statoCodiceEIstantiInIngressoSonoDellaCodaENonDelChiamante() throws Exception {
        CodaCaricamenti coda = apri();
        VoceCoda v = nuova(1);
        v.stato = Stato.INVIATO;                    // uno stato terminale in ingresso non fa nascere una voce viva senza copia
        v.codice = Codice.INTERNO;
        v.creatoIl = 5L;
        v.aggiornatoIl = 6L;
        VoceCoda dentro = coda.aggiungi(v).voce;
        assertSame(Stato.IN_CODA, dentro.stato);
        assertNull(dentro.codice);
        assertEquals(1_790_000_000_000L, dentro.creatoIl);
        assertEquals("file/" + id(1) + ".mp4", dentro.file);
        assertSame("l'oggetto del chiamante non si tocca", Stato.INVIATO, v.stato);
        assertEquals(5L, v.creatoIl);
        VoceCoda senzaStato = nuova(2);
        senzaStato.stato = null;
        assertSame("lo stato in ingresso non conta nemmeno se manca", Stato.IN_CODA, coda.aggiungi(senzaStato).voce.stato);
    }

    @Test
    public void aggiungiSpostandoPortaIlFileNelPercorsoDellaVoceEAccodaTuttoInsieme() throws Exception {
        CodaCaricamenti coda = apri();
        File preparato = creaFile("scelti", "elemento-uno.mp4", orologio.get());
        RisultatoAggiunta r = coda.aggiungiSpostando(nuova(1), preparato);
        assertFalse(r.giaPresente);
        assertFalse("il preparato non è più in scelti/", preparato.exists());
        assertTrue(coda.fileCopia(r.voce.file).isFile());
        assertEquals(new File(cartella, "file/" + id(1) + ".mp4"), coda.fileCopia(r.voce.file));
        assertEquals(1, apri().numeroVoci());
    }

    @Test
    public void aggiungiSpostandoNonSpostaSeLaVoceEGiaInCoda() throws Exception {
        CodaCaricamenti coda = apri();
        File primo = creaFile("scelti", "elemento-uno.mp4", orologio.get());
        coda.aggiungiSpostando(nuova(1), primo);
        File secondo = creaFile("scelti", "elemento-due.mp4", orologio.get());
        RisultatoAggiunta r = coda.aggiungiSpostando(nuova(1), secondo);
        assertTrue(r.giaPresente);
        assertTrue("il secondo preparato è rimasto dov'era", secondo.exists());
    }

    @Test
    public void aggiungiSpostandoSenzaSorgenteLanciaENonLasciaVoci() throws Exception {
        CodaCaricamenti coda = apri();
        try {
            coda.aggiungiSpostando(nuova(1), new File(cartella, "scelti/non-esiste.mp4"));
            fail("la sorgente non esiste");
        } catch (IOException atteso) {
            // spostamento non riuscito
        }
        assertEquals(0, coda.numeroVoci());
    }

    @Test
    public void aggiungiSpostandoRiportaIlFileAlSuoPostoSeLaCodaNonSiScrive() throws Exception {
        CodaCaricamenti coda = apri();
        File preparato = creaFile("scelti", "elemento-uno.mp4", orologio.get());
        // La scrittura della coda fallisce perché `coda.json.new` è una cartella: lo `startWrite` non può aprirla.
        assertTrue(new File(cartella, "coda.json.new").mkdirs());
        try {
            coda.aggiungiSpostando(nuova(1), preparato);
            fail("la coda non si scrive");
        } catch (IOException atteso) {
            // coda non scritta
        }
        assertTrue("il file è tornato in scelti/", preparato.exists());
        assertFalse("e non è rimasta nessuna copia in file/", new File(cartella, "file/" + id(1) + ".mp4").exists());
        assertEquals(0, coda.numeroVoci());
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * LETTURA: trova, elenco, vive, copie
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void iMetodiRestituisconoCopieEModificarleNonCambiaLaCoda() throws Exception {
        CodaCaricamenti coda = apri();
        coda.aggiungi(nuova(1));
        VoceCoda fuori = coda.trova(id(1));
        fuori.stato = Stato.INVIATO;
        fuori.tentativi = 99;
        fuori.nome = "manomesso";
        VoceCoda ancora = coda.trova(id(1));
        assertSame(Stato.IN_CODA, ancora.stato);
        assertEquals(0, ancora.tentativi);
        assertEquals("prova-1.mp4", ancora.nome);
        coda.elenco(UTENTE).get(0).tentativi = 7;
        coda.vive().get(0).tentativi = 8;
        assertEquals(0, coda.trova(id(1)).tentativi);
        assertNull(coda.trova(id(404)));
        assertNull(coda.trova(null));
    }

    @Test
    public void elencoFiltraPerUtenteEOrdinaPerCreazioneConParitaNellOrdineDiAccodamento() throws Exception {
        CodaCaricamenti coda = apri();
        coda.aggiungi(nuova(3));            // stesso istante di 5: resta prima di 5
        coda.aggiungi(nuova(5));
        orologio.addAndGet(1_000L);
        VoceCoda altro = new VoceCoda(id(4), id(1004), ALTRO_UTENTE, SCUOLA);
        riempi(altro, id(4));
        altro.origine = Origine.FILE;
        coda.aggiungi(altro);
        coda.aggiungi(nuova(1));            // più recente
        List<VoceCoda> mie = coda.elenco(UTENTE);
        assertEquals(Arrays.asList(id(3), id(5), id(1)), ids(mie));
        assertEquals(Arrays.asList(id(4)), ids(coda.elenco(ALTRO_UTENTE)));
        assertTrue(coda.elenco(id(9999)).isEmpty());
        assertTrue(coda.elenco(null).isEmpty());
    }

    private static List<String> ids(List<VoceCoda> voci) {
        List<String> ids = new ArrayList<>();
        for (VoceCoda v : voci) ids.add(v.jobId);
        return ids;
    }

    @Test
    public void elencoEViveSonoOrdinatiPerCreazioneAncheSeIlFileEraInAltroOrdine() throws Exception {
        File sotto = temporanea.newFolder();
        cartella = sotto;
        CodaCaricamenti prima = new CodaCaricamenti(sotto, orologio::get);
        prima.aggiungi(nuova(1));
        orologio.addAndGet(1_000L);
        prima.aggiungi(nuova(2));
        orologio.addAndGet(1_000L);
        prima.aggiungi(nuova(3));
        JSONObject radice = leggiCoda();
        JSONArray voci = radice.getJSONArray("voci");
        JSONArray rovesciate = new JSONArray();
        for (int i = voci.length() - 1; i >= 0; i--) rovesciate.put(voci.get(i));
        radice.put("voci", rovesciate);
        scrivi("coda.json", radice.toString());
        CodaCaricamenti dopo = new CodaCaricamenti(sotto, orologio::get);
        assertEquals(Arrays.asList(id(1), id(2), id(3)), ids(dopo.elenco(UTENTE)));
        assertEquals("anche per l'esecutore: la più vecchia per prima", Arrays.asList(id(1), id(2), id(3)), ids(dopo.vive()));
    }

    @Test
    public void viveEscludeITerminali() throws Exception {
        CodaCaricamenti coda = apri();
        for (int n = 1; n <= 4; n++) coda.aggiungi(nuova(n));
        coda.transita(id(2), EventoStato.FALLITO, Codice.TOKEN_SCADUTO);
        coda.transita(id(3), EventoStato.ANNULLATO, null);
        assertEquals(Arrays.asList(id(1), id(4)), ids(coda.vive()));
        assertEquals(4, coda.numeroVoci());
    }

    @Test
    public void unaVoceTerminaleConUnJobIdOstileNonEntraMaiEQuindiNonCancellaNienteFuoriCartella() throws Exception {
        // `jobId` costruisce i percorsi dei segreti e delle copie che una transizione terminale cancella: con `../../vittima`
        // cancellerebbe un file FUORI dalla cartella dei caricamenti. La voce è terminale e senza `file`, così nessun altro
        // controllo la fermerebbe: lo ferma la forma del `jobId`.
        File radiceTemp = temporanea.getRoot();
        File vittima = new File(radiceTemp, "vittima.bin");
        assertTrue(vittima.createNewFile());
        for (String ostile : new String[]{"../../vittima", "../vittima", "xyz", "", id(10).toUpperCase(Locale.ROOT), id(1) + "/", id(1) + "\\..",
                "00000001-1111-4111-8111-00000000000/", "/etc/passwd"}) {
            File sotto = temporanea.newFolder();
            cartella = sotto;
            CodaCaricamenti prima = new CodaCaricamenti(sotto, orologio::get);
            prima.aggiungi(nuova(1));
            prima.aggiungi(nuova(2));
            prima.transita(id(1), EventoStato.ANNULLATO, null);
            JSONObject radice = leggiCoda();
            radice.getJSONArray("voci").getJSONObject(0).put("jobId", ostile);   // terminale, senza file: nient'altro la fermerebbe
            scrivi("coda.json", radice.toString());
            CodaCaricamenti dopo = new CodaCaricamenti(sotto, orologio::get);
            assertEquals("«" + ostile + "»", 1, dopo.rapporto().vociScartate);
            assertNull(dopo.trova(ostile));
            assertEquals(1, dopo.numeroVoci());
            dopo.dimentica(Arrays.asList(ostile, id(2)));
            dopo.pulisci();
            assertTrue("«" + ostile + "»: la vittima fuori cartella è ancora lì", vittima.exists());
        }
    }

    @Test
    public void iPercorsiPubbliciRifiutanoCioCheUscirebbeDallaCartella() {
        CodaCaricamenti coda = apri();
        for (String ostile : new String[]{null, "", "../../vittima", "../x", "xyz", id(10).toUpperCase(Locale.ROOT), id(1) + "/x", "/etc/passwd"}) {
            try {
                coda.fileSegreto(ostile);
                fail("fileSegreto ha accettato «" + ostile + "»");
            } catch (IllegalArgumentException atteso) {
                // rifiutato
            }
        }
        for (String ostile : new String[]{null, "", "../../vittima", "file/../../vittima", "/etc/passwd", "scelti/" + id(1) + ".mp4",
                "file/" + id(1), "file/" + id(1) + ".MP4", "file/" + id(1) + ".mp4/..", "file\\" + id(1) + ".mp4", "file/x.mp4"}) {
            try {
                coda.fileCopia(ostile);
                fail("fileCopia ha accettato «" + ostile + "»");
            } catch (IllegalArgumentException atteso) {
                // rifiutato
            }
        }
        assertEquals(new File(cartella, "file/" + id(1) + ".mov"), coda.fileCopia("file/" + id(1) + ".mov"));
    }

    @Test
    public void ilPercorsoDeiSegretiEDelleCopieEQuelloDelLayout() {
        CodaCaricamenti coda = apri();
        assertEquals(new File(cartella, "segreti/" + id(1) + ".bin"), coda.fileSegreto(id(1)));
        assertEquals(new File(cartella, "file/" + id(1) + ".mp4"), coda.fileCopia("file/" + id(1) + ".mp4"));
        assertEquals(new File(cartella, "scelti"), coda.cartellaScelti());
        assertEquals(cartella, coda.cartella());
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * TRANSITA (§4.4): la politica applicata alla coda
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void ilPercorsoFelicePassaDaInCodaAInviato() throws Exception {
        CodaCaricamenti coda = apri();
        coda.aggiungi(nuova(1));
        assertSame(Stato.IN_INVIO, coda.transita(id(1), EventoStato.AVVIATO, null).voce.stato);
        EsitoTransizione attesa = coda.transita(id(1), EventoStato.IN_ATTESA_DI_RETE, Codice.RETE);
        assertSame(TipoTransizione.APPLICATA, attesa.tipo);
        assertSame(Stato.IN_ATTESA, attesa.voce.stato);
        assertSame(Codice.RETE, attesa.voce.codice);
        EsitoTransizione ripreso = coda.transita(id(1), EventoStato.RIPRESO, null);
        assertSame(Stato.IN_INVIO, ripreso.voce.stato);
        assertNull("in-invio non ha codice", ripreso.voce.codice);
        EsitoTransizione fine = coda.transita(id(1), EventoStato.INVIATO, null);
        assertSame(Stato.INVIATO, fine.voce.stato);
        assertTrue(fine.persistita);
        assertEquals("inviato", leggiCoda().getJSONArray("voci").getJSONObject(0).getString("stato"));
    }

    @Test
    public void unaTransizioneNonPrevistaNonCambiaNientePerNessunaCoppia() throws Exception {
        for (Stato partenza : new Stato[]{Stato.IN_CODA, Stato.IN_INVIO, Stato.IN_ATTESA, Stato.IN_PAUSA, Stato.INVIATO, Stato.FALLITO,
                Stato.ANNULLATO}) {
            for (EventoStato evento : EventoStato.values()) {
                CodaCaricamenti coda = new CodaCaricamenti(temporanea.newFolder(), orologio::get);
                coda.aggiungi(nuova(1));
                portaA(coda, partenza);
                VoceCoda prima = coda.trova(id(1));
                EsitoTransizione e = coda.transita(id(1), evento, Codice.INTERNO);
                Stato atteso = PoliticaCaricamento.transizione(partenza, evento);
                String dove = partenza + " con " + evento;
                if (prima.stato == evento.destinazione()) {
                    assertSame(dove, TipoTransizione.GIA_IN_QUELLO_STATO, e.tipo);
                } else if (atteso == null) {
                    assertSame(dove, TipoTransizione.NON_AMMESSA, e.tipo);
                    assertSame(dove + ": lo stato non cambia", prima.stato, e.voce.stato);
                    assertEquals(dove + ": nemmeno l'ora", prima.aggiornatoIl, e.voce.aggiornatoIl);
                } else {
                    assertSame(dove, TipoTransizione.APPLICATA, e.tipo);
                    assertSame(dove, atteso, e.voce.stato);
                }
            }
        }
    }

    private void portaA(CodaCaricamenti coda, Stato stato) {
        switch (stato) {
            case IN_CODA:
                return;
            case IN_INVIO:
                coda.transita(id(1), EventoStato.AVVIATO, null);
                return;
            case IN_ATTESA:
                coda.transita(id(1), EventoStato.AVVIATO, null);
                coda.transita(id(1), EventoStato.IN_ATTESA_DI_RETE, Codice.RETE);
                return;
            case IN_PAUSA:
                coda.transita(id(1), EventoStato.IN_PAUSA, Codice.UIDT_NON_PROGRAMMABILE);
                return;
            case INVIATO:
                coda.transita(id(1), EventoStato.AVVIATO, null);
                coda.transita(id(1), EventoStato.INVIATO, null);
                return;
            case FALLITO:
                coda.transita(id(1), EventoStato.FALLITO, Codice.INTERNO);
                return;
            case ANNULLATO:
                coda.transita(id(1), EventoStato.ANNULLATO, null);
                return;
            default:
                throw new IllegalStateException();
        }
    }

    @Test
    public void unaVoceAppenaNataPuoAndareInPausaPerUidtNonProgrammabile() throws Exception {
        // §6.2: «se la programmazione lancia (app non più visibile al momento di accodaVideo) la voce va in-pausa».
        CodaCaricamenti coda = apri();
        coda.aggiungi(nuova(1));
        EsitoTransizione e = coda.transita(id(1), EventoStato.IN_PAUSA, Codice.UIDT_NON_PROGRAMMABILE);
        assertSame(TipoTransizione.APPLICATA, e.tipo);
        assertSame(Stato.IN_PAUSA, e.voce.stato);
        assertSame(Codice.UIDT_NON_PROGRAMMABILE, e.voce.codice);
        assertSame(Stato.IN_INVIO, coda.transita(id(1), EventoStato.RIPRESO, null).voce.stato);
    }

    @Test
    public void unaVoceAssenteODunEventoNulloDaVoceAssente() throws Exception {
        CodaCaricamenti coda = apri();
        coda.aggiungi(nuova(1));
        assertSame(TipoTransizione.VOCE_ASSENTE, coda.transita(id(404), EventoStato.AVVIATO, null).tipo);
        assertSame(TipoTransizione.VOCE_ASSENTE, coda.transita(null, EventoStato.AVVIATO, null).tipo);
        assertSame(TipoTransizione.VOCE_ASSENTE, coda.transita(id(1), null, null).tipo);
        assertNull(coda.transita(id(404), EventoStato.AVVIATO, null).voce);
        assertSame(Stato.IN_CODA, coda.trova(id(1)).stato);
    }

    @Test
    public void lStessoEventoRipetutoSuUnoStatoVivoAggiornaSoloIlCodice() throws Exception {
        CodaCaricamenti coda = apri();
        coda.aggiungi(nuova(1));
        coda.transita(id(1), EventoStato.AVVIATO, null);
        coda.transita(id(1), EventoStato.IN_ATTESA_DI_RETE, Codice.RETE);
        orologio.addAndGet(1_000L);
        EsitoTransizione stessa = coda.transita(id(1), EventoStato.IN_ATTESA_DI_RETE, Codice.RETE);
        assertSame(TipoTransizione.GIA_IN_QUELLO_STATO, stessa.tipo);
        assertEquals("niente da scrivere se non cambia nulla", 1_790_000_000_000L, stessa.voce.aggiornatoIl);
        EsitoTransizione cambiata = coda.transita(id(1), EventoStato.IN_ATTESA_DI_RETE, Codice.SERVER);
        assertSame(TipoTransizione.GIA_IN_QUELLO_STATO, cambiata.tipo);
        assertSame(Codice.SERVER, cambiata.voce.codice);
        assertTrue(cambiata.persistita);
        assertEquals("SERVER", leggiCoda().getJSONArray("voci").getJSONObject(0).getString("codice"));
        assertSame(Stato.IN_ATTESA, cambiata.voce.stato);
    }

    @Test
    public void ilCodiceSiNormalizzaPerStato() throws Exception {
        CodaCaricamenti coda = apri();
        for (int n = 1; n <= 7; n++) coda.aggiungi(nuova(n));
        // in-invio: nessun codice, anche se ne arriva uno
        assertNull(coda.transita(id(1), EventoStato.AVVIATO, Codice.RETE).voce.codice);
        // inviato: nessun codice
        coda.transita(id(2), EventoStato.AVVIATO, null);
        assertNull(coda.transita(id(2), EventoStato.INVIATO, Codice.INTERNO).voce.codice);
        // fallito: sempre un codice (INTERNO se manca), e quello dato se c'è
        assertSame(Codice.INTERNO, coda.transita(id(3), EventoStato.FALLITO, null).voce.codice);
        assertSame(Codice.TOKEN_SCADUTO, coda.transita(id(4), EventoStato.FALLITO, Codice.TOKEN_SCADUTO).voce.codice);
        // annullato: ANNULLATO_DAL_SERVER si tiene, ogni altro codice cade
        assertSame(Codice.ANNULLATO_DAL_SERVER, coda.transita(id(5), EventoStato.ANNULLATO, Codice.ANNULLATO_DAL_SERVER).voce.codice);
        assertNull(coda.transita(id(6), EventoStato.ANNULLATO, Codice.RETE).voce.codice);
        // in-pausa tiene il codice dato
        assertSame(Codice.FGS_NON_AVVIABILE, coda.transita(id(7), EventoStato.IN_PAUSA, Codice.FGS_NON_AVVIABILE).voce.codice);
    }

    @Test
    public void unTerminaleRipetutoNonSiTocca() throws Exception {
        CodaCaricamenti coda = apri();
        coda.aggiungi(nuova(1));
        coda.transita(id(1), EventoStato.AVVIATO, null);
        coda.transita(id(1), EventoStato.INVIATO, null);
        orologio.addAndGet(5_000L);
        EsitoTransizione di_nuovo = coda.transita(id(1), EventoStato.INVIATO, null);
        assertSame(TipoTransizione.GIA_IN_QUELLO_STATO, di_nuovo.tipo);
        assertEquals(1_790_000_000_000L, di_nuovo.voce.aggiornatoIl);
        assertSame("da inviato non si va a fallito", TipoTransizione.NON_AMMESSA, coda.transita(id(1), EventoStato.FALLITO, Codice.INTERNO).tipo);
        assertSame(Stato.INVIATO, coda.trova(id(1)).stato);
    }

    @Test
    public void unTerminaleRipetutoConUnAltroCodiceNonCambiaIlCodiceNeLOra() throws Exception {
        CodaCaricamenti coda = apri();
        coda.aggiungi(nuova(1));
        coda.transita(id(1), EventoStato.FALLITO, Codice.TOKEN_SCADUTO);
        orologio.addAndGet(5_000L);
        EsitoTransizione e = coda.transita(id(1), EventoStato.FALLITO, Codice.RETE);
        assertSame(TipoTransizione.GIA_IN_QUELLO_STATO, e.tipo);
        assertSame("il codice del primo esito non si riscrive", Codice.TOKEN_SCADUTO, e.voce.codice);
        assertEquals(1_790_000_000_000L, e.voce.aggiornatoIl);
        assertSame("nemmeno su disco", Codice.TOKEN_SCADUTO, apri().trova(id(1)).codice);

        coda.aggiungi(nuova(2));
        coda.transita(id(2), EventoStato.ANNULLATO, Codice.ANNULLATO_DAL_SERVER);
        assertSame(Codice.ANNULLATO_DAL_SERVER, coda.transita(id(2), EventoStato.ANNULLATO, null).voce.codice);
    }

    @Test
    public void ogniTerminaleCancellaLaCopiaEISegretiEAzzeraIlFile() throws Exception {
        for (EventoStato terminale : new EventoStato[]{EventoStato.INVIATO, EventoStato.FALLITO, EventoStato.ANNULLATO}) {
            File radice = temporanea.newFolder();
            CodaCaricamenti coda = new CodaCaricamenti(radice, orologio::get);
            coda.aggiungi(nuova(1));
            coda.transita(id(1), EventoStato.AVVIATO, null);
            File copia = new File(radice, "file/" + id(1) + ".mp4");
            File segreto = coda.fileSegreto(id(1));
            File residuoNuovo = new File(segreto.getPath() + ".new");
            File residuoVecchio = new File(segreto.getPath() + ".bak");
            File altra = new File(radice, "file/" + id(2) + ".mp4");
            File altroSegreto = coda.fileSegreto(id(2));
            for (File f : new File[]{copia, segreto, residuoNuovo, residuoVecchio, altra, altroSegreto}) {
                f.getParentFile().mkdirs();
                assertTrue(f.createNewFile());
            }
            EsitoTransizione e = coda.transita(id(1), terminale, terminale == EventoStato.FALLITO ? Codice.INTERNO : null);
            assertSame(terminale.name(), TipoTransizione.APPLICATA, e.tipo);
            assertFalse(terminale.name() + ": copia cancellata", copia.exists());
            assertFalse(terminale.name() + ": segreto cancellato", segreto.exists());
            assertFalse(terminale.name() + ": residuo .new cancellato", residuoNuovo.exists());
            assertFalse(terminale.name() + ": residuo .bak cancellato", residuoVecchio.exists());
            assertFalse(e.residuiRimasti);
            assertNull(terminale.name() + ": nessun file nominato", e.voce.file);
            assertTrue("la copia e i segreti di un'ALTRA voce restano", altra.exists() && altroSegreto.exists());
            assertNull("persistito senza file", new CodaCaricamenti(radice, orologio::get).trova(id(1)).file);
        }
    }

    @Test
    public void unaCancellazioneCheFallisceLoDiceEResiduiRimasti() throws Exception {
        CodaCaricamenti coda = apri();
        coda.aggiungi(nuova(1));
        coda.transita(id(1), EventoStato.AVVIATO, null);
        // La «copia» è una cartella non vuota: `File.delete()` non la toglie.
        File copia = new File(cartella, "file/" + id(1) + ".mp4");
        assertTrue(copia.mkdirs());
        assertTrue(new File(copia, "dentro").createNewFile());
        EsitoTransizione e = coda.transita(id(1), EventoStato.INVIATO, null);
        assertSame("la voce è comunque terminale", Stato.INVIATO, e.voce.stato);
        assertTrue(e.residuiRimasti);
        assertTrue("il file non è più nominato da nessuna voce: la pulizia ci riprova", e.voce.file == null);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * MODIFICA
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void modificaCambiaSoloContatoriEIstantiELiScrive() throws Exception {
        CodaCaricamenti coda = apri();
        coda.aggiungi(nuova(1));
        orologio.addAndGet(2_000L);
        EsitoTransizione e = coda.modifica(id(1), v -> {
            v.tentativi = 3;
            v.rinnovi = 1;
            v.rinnoviConsecutivi = 1;
            v.prossimoTentativoIl = 42L;
            v.urlScadeIl = 43L;
            v.tokenScadeIl = 44L;
            // ...e tutto il resto che NON si può cambiare da qui:
            v.stato = Stato.INVIATO;
            v.codice = Codice.INTERNO;
            v.file = null;
            v.nome = "altro";
            v.mime = "audio/x";
            v.byteTotali = 1L;
            v.creatoIl = 1L;
            v.origine = Origine.PROVA;
        });
        assertSame(TipoTransizione.APPLICATA, e.tipo);
        assertTrue(e.persistita);
        VoceCoda dopo = coda.trova(id(1));
        assertEquals(3, dopo.tentativi);
        assertEquals(1, dopo.rinnovi);
        assertEquals(1, dopo.rinnoviConsecutivi);
        assertEquals(42L, dopo.prossimoTentativoIl);
        assertEquals(43L, dopo.urlScadeIl);
        assertEquals(44L, dopo.tokenScadeIl);
        assertEquals(1_790_000_002_000L, dopo.aggiornatoIl);
        assertSame("lo stato si cambia solo con transita", Stato.IN_CODA, dopo.stato);
        assertNull(dopo.codice);
        assertEquals("file/" + id(1) + ".mp4", dopo.file);
        assertEquals("prova-1.mp4", dopo.nome);
        assertEquals("video/mp4", dopo.mime);
        assertEquals(5_000_001L, dopo.byteTotali);
        assertEquals(1_790_000_000_000L, dopo.creatoIl);
        assertSame(Origine.GALLERIA, dopo.origine);
        assertEquals(3, leggiCoda().getJSONArray("voci").getJSONObject(0).getInt("tentativi"));
    }

    @Test
    public void modificaNonAccettaValoriNegativi() throws Exception {
        CodaCaricamenti coda = apri();
        coda.aggiungi(nuova(1));
        coda.modifica(id(1), v -> {
            v.tentativi = -5;
            v.rinnovi = -1;
            v.rinnoviConsecutivi = -9;
            v.prossimoTentativoIl = -100L;
            v.urlScadeIl = -100L;
            v.tokenScadeIl = -100L;
        });
        VoceCoda v = coda.trova(id(1));
        assertEquals(0, v.tentativi);
        assertEquals(0, v.rinnovi);
        assertEquals(0, v.rinnoviConsecutivi);
        assertEquals(0L, v.prossimoTentativoIl);
        assertEquals(0L, v.urlScadeIl);
        assertEquals(0L, v.tokenScadeIl);
        // E un file così si riapre senza che nessuna voce venga scartata.
        assertFalse(apri().rapporto().daSegnalare());
    }

    @Test
    public void unaVoceTerminaleONonEsistenteNonSiModifica() throws Exception {
        CodaCaricamenti coda = apri();
        coda.aggiungi(nuova(1));
        coda.transita(id(1), EventoStato.ANNULLATO, null);
        AtomicInteger chiamate = new AtomicInteger();
        EsitoTransizione terminale = coda.modifica(id(1), v -> {
            chiamate.incrementAndGet();
            v.tentativi = 50;
        });
        assertSame(TipoTransizione.NON_AMMESSA, terminale.tipo);
        assertEquals(0, coda.trova(id(1)).tentativi);
        assertSame(TipoTransizione.VOCE_ASSENTE, coda.modifica(id(404), v -> chiamate.incrementAndGet()).tipo);
        assertEquals("il modificatore non gira nemmeno", 0, chiamate.get());
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * DIMENTICA
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void dimenticaToglieSoloLeVociTerminaliIndicate() throws Exception {
        CodaCaricamenti coda = apri();
        for (int n = 1; n <= 5; n++) coda.aggiungi(nuova(n));
        coda.transita(id(1), EventoStato.FALLITO, Codice.INTERNO);
        coda.transita(id(2), EventoStato.ANNULLATO, null);
        coda.transita(id(3), EventoStato.AVVIATO, null);
        coda.transita(id(3), EventoStato.INVIATO, null);
        // 4 e 5 restano vive.
        int tolte = coda.dimentica(Arrays.asList(id(1), id(3), id(4), id(404)));
        assertEquals("1 e 3 sono terminali; 4 è viva; 404 non c'è", 2, tolte);
        assertNull(coda.trova(id(1)));
        assertNull(coda.trova(id(3)));
        assertNotNull(coda.trova(id(2)));
        assertNotNull("una voce viva non si dimentica", coda.trova(id(4)));
        assertNotNull(coda.trova(id(5)));
        assertEquals(3, apri().numeroVoci());
    }

    @Test
    public void dimenticaConElencoVuotoONulloNonFaNiente() throws Exception {
        CodaCaricamenti coda = apri();
        coda.aggiungi(nuova(1));
        coda.transita(id(1), EventoStato.ANNULLATO, null);
        assertEquals(0, coda.dimentica(null));
        assertEquals(0, coda.dimentica(new ArrayList<String>()));
        assertEquals(1, coda.numeroVoci());
    }

    @Test
    public void dimenticareDueVolteLaStessaVoceLaTogliUnaVoltaSola() throws Exception {
        CodaCaricamenti coda = apri();
        coda.aggiungi(nuova(1));
        coda.transita(id(1), EventoStato.ANNULLATO, null);
        assertEquals(1, coda.dimentica(Arrays.asList(id(1), id(1))));
        assertEquals(0, coda.dimentica(Arrays.asList(id(1))));
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * FILE ROTTO (§4.6)
     * ──────────────────────────────────────────────────────────────────────────── */

    private void verificaCodaCorrotta(String descrizione, byte[] contenuto, int orfaniAttesi) throws Exception {
        File sotto = temporanea.newFolder();
        cartella = sotto;
        scrivi("coda.json", contenuto);
        for (int i = 0; i < orfaniAttesi; i++) {
            File orfano = new File(sotto, "file/" + id(500 + i) + ".mp4");
            orfano.getParentFile().mkdirs();
            assertTrue(orfano.createNewFile());
        }
        orologio.addAndGet(1);
        CodaCaricamenti coda = apri();
        assertTrue(descrizione + ": rapporto corrotta", coda.rapporto().corrotta);
        assertTrue(descrizione, coda.rapporto().daSegnalare());
        assertEquals(descrizione + ": file orfani", orfaniAttesi, coda.rapporto().fileOrfani);
        assertEquals(descrizione + ": la coda riparte vuota", 0, coda.numeroVoci());
        List<File> messe = corrotte();
        assertEquals(descrizione + ": un solo file messo da parte", 1, messe.size());
        assertTrue(descrizione + ": il nome ha l'istante", messe.get(0).getName().contains(String.valueOf(orologio.get())));
        assertEquals(descrizione + ": il contenuto è quello di prima", new String(contenuto, StandardCharsets.UTF_8),
                new String(java.nio.file.Files.readAllBytes(messe.get(0).toPath()), StandardCharsets.UTF_8));
        assertFalse(descrizione + ": coda.json non c'è più", new File(sotto, "coda.json").exists());
        // E si può riprendere a lavorare: la prima scrittura crea una coda nuova e valida.
        coda.aggiungi(nuova(1));
        assertEquals(1, leggiCoda().getJSONArray("voci").length());
        assertFalse("la riapertura successiva è pulita", new CodaCaricamenti(sotto, orologio::get).rapporto().daSegnalare());
    }

    @Test
    public void unFileDiSpazzaturaVieneMessoDaParte() throws Exception {
        verificaCodaCorrotta("byte casuali", new byte[]{(byte) 0xde, (byte) 0xad, (byte) 0xbe, (byte) 0xef, 0, 1, 2}, 0);
    }

    @Test
    public void unFileVuotoOTroncatoVieneMessoDaParte() throws Exception {
        verificaCodaCorrotta("vuoto", new byte[0], 0);
        verificaCodaCorrotta("troncato", "{\"versione\":1,\"voci\":[{\"jobId\":\"".getBytes(StandardCharsets.UTF_8), 0);
        verificaCodaCorrotta("solo spazi", "    ".getBytes(StandardCharsets.UTF_8), 0);
    }

    @Test
    public void unFileDiVersioneSconosciutaOSenzaVersioneVieneMessoDaParte() throws Exception {
        verificaCodaCorrotta("versione 2", "{\"versione\":2,\"testi\":{},\"voci\":[]}".getBytes(StandardCharsets.UTF_8), 0);
        verificaCodaCorrotta("versione 0", "{\"versione\":0,\"voci\":[]}".getBytes(StandardCharsets.UTF_8), 0);
        verificaCodaCorrotta("senza versione", "{\"voci\":[]}".getBytes(StandardCharsets.UTF_8), 0);
        verificaCodaCorrotta("versione testo", "{\"versione\":\"1\",\"voci\":[]}".getBytes(StandardCharsets.UTF_8), 0);
        verificaCodaCorrotta("oggetto vuoto", "{}".getBytes(StandardCharsets.UTF_8), 0);
    }

    @Test
    public void unFileCheNonEUnOggettoOSenzaElencoDiVociVieneMessoDaParte() throws Exception {
        verificaCodaCorrotta("array", "[]".getBytes(StandardCharsets.UTF_8), 0);
        verificaCodaCorrotta("voci non elenco", "{\"versione\":1,\"voci\":{}}".getBytes(StandardCharsets.UTF_8), 0);
        verificaCodaCorrotta("voci assenti", "{\"versione\":1}".getBytes(StandardCharsets.UTF_8), 0);
        verificaCodaCorrotta("voci testo", "{\"versione\":1,\"voci\":\"x\"}".getBytes(StandardCharsets.UTF_8), 0);
    }

    @Test
    public void conLaCodaCorrottaTuttiIFileDellaCartellaFileSonoOrfani() throws Exception {
        verificaCodaCorrotta("tre copie senza coda", "{rotto".getBytes(StandardCharsets.UTF_8), 3);
    }

    @Test
    public void laPuliziaDopoUnaCodaCorrottaTogliGliOrfani() throws Exception {
        File sotto = temporanea.newFolder();
        cartella = sotto;
        scrivi("coda.json", "{rotto");
        File orfano = new File(sotto, "file/" + id(7) + ".mp4");
        orfano.getParentFile().mkdirs();
        assertTrue(orfano.createNewFile());
        File segreto = new File(sotto, "segreti/" + id(7) + ".bin");
        segreto.getParentFile().mkdirs();
        assertTrue(segreto.createNewFile());
        CodaCaricamenti coda = apri();
        assertTrue("la copia c'è ancora finché non gira la pulizia", orfano.exists());
        ReportPulizia r = coda.pulisci();
        assertEquals(1, r.fileOrfani);
        assertEquals("senza segreti non partirebbero mai: anche i segreti senza voce", 1, r.segreti);
        assertFalse(orfano.exists());
        assertFalse(segreto.exists());
    }

    @Test
    public void unaCodaCorrottaNonLasciaResiduiDiScritturaInterrotta() throws Exception {
        File sotto = temporanea.newFolder();
        cartella = sotto;
        scrivi("coda.json", "{rotto");
        scrivi("coda.json.new", "mezza scrittura");
        scrivi("coda.json.bak", "vecchio");
        apri();
        assertFalse(new File(sotto, "coda.json.new").exists());
        assertFalse(new File(sotto, "coda.json.bak").exists());
    }

    @Test
    public void duePerditeNelloStessoMillisecondoNonSiSovrascrivono() throws Exception {
        File sotto = temporanea.newFolder();
        cartella = sotto;
        scrivi("coda.json", "{rotto uno");
        apri();
        scrivi("coda.json", "{rotto due");
        apri();     // stesso istante dell'orologio: il nome sarebbe lo stesso
        assertEquals(2, corrotte().size());
    }

    @Test
    public void unaVoceFuoriFormaNonPortaViaLeAltre() throws Exception {
        File sotto = temporanea.newFolder();
        cartella = sotto;
        CodaCaricamenti prima = apri();
        prima.aggiungi(nuova(1));
        prima.aggiungi(nuova(2));
        prima.aggiungi(nuova(3));
        JSONObject radice = leggiCoda();
        radice.getJSONArray("voci").getJSONObject(1).put("stato", "non-esiste");
        scrivi("coda.json", radice.toString());
        for (int n = 1; n <= 3; n++) {
            File copia = new File(sotto, "file/" + id(n) + ".mp4");
            copia.getParentFile().mkdirs();
            assertTrue(copia.createNewFile());
        }

        CodaCaricamenti dopo = apri();
        assertFalse("il file è buono", dopo.rapporto().corrotta);
        assertEquals(1, dopo.rapporto().vociScartate);
        assertTrue(dopo.rapporto().daSegnalare());
        assertEquals("la copia della voce scartata è orfana", 1, dopo.rapporto().fileOrfani);
        assertEquals(Arrays.asList(id(1), id(3)), ids(dopo.vive()));
        assertTrue("nessun file messo da parte", corrotte().isEmpty());
    }

    /** Per ogni campo di una voce, i valori con cui il file NON è più una voce: la tabella dei rifiuti del caricamento. */
    private static Object[][] campiRotti() {
        Object nullo = JSONObject.NULL;
        String uuidMaiuscolo = id(10).toUpperCase(Locale.ROOT);       // con lettere esadecimali: id(1) ha solo cifre
        return new Object[][]{
                {"jobId", nullo, "xyz", 7, true, uuidMaiuscolo, id(9) + "x"},
                {"intentId", nullo, "xyz", 7, true, uuidMaiuscolo},
                {"utenteId", nullo, "xyz", 7, true, uuidMaiuscolo},
                {"scuolaId", nullo, "xyz", 7, true, uuidMaiuscolo},
                {"nome", nullo, 7, true},
                {"file", nullo, "xyz", 7, true, "file/../" + id(1) + ".mp4", "file/" + id(2) + ".mp4"},
                {"byte", nullo, "xyz", -1, 0, 1.5, true},
                {"mime", nullo, "", 7, true},
                {"stato", nullo, "xyz", "IN_CODA", 7, true},
                {"tentativi", nullo, "xyz", -1, 1.5, true, 3_000_000_000L},
                {"rinnovi", nullo, "xyz", -1, 1.5, true, 3_000_000_000L},
                {"rinnoviConsecutivi", nullo, "xyz", -1, 1.5, true, 3_000_000_000L},
                {"codice", "xyz", "rete", 7, true},
                {"prossimoTentativoIl", nullo, "xyz", -1, 1.5, true},
                {"urlScadeIl", nullo, "xyz", -1, 1.5, true},
                {"tokenScadeIl", nullo, "xyz", -1, 1.5, true},
                {"origine", nullo, "xyz", "Galleria", 7, true},
                {"creatoIl", nullo, "xyz", -1, 1.5, true},
                {"aggiornatoIl", nullo, "xyz", -1, 1.5, true},
        };
    }

    @Test
    public void ogniCampoFuoriFormaScartaLaVoceENonLAltra() throws Exception {
        int casi = 0;
        for (Object[] riga : campiRotti()) {
            String chiave = (String) riga[0];
            for (int i = 1; i < riga.length; i++) {
                Object valoreRotto = riga[i];
                File sotto = temporanea.newFolder();
                cartella = sotto;
                CodaCaricamenti prima = new CodaCaricamenti(sotto, orologio::get);
                prima.aggiungi(nuova(1));
                prima.aggiungi(nuova(2));
                JSONObject radice = leggiCoda();
                radice.getJSONArray("voci").getJSONObject(0).put(chiave, valoreRotto);
                scrivi("coda.json", radice.toString());
                CodaCaricamenti dopo = new CodaCaricamenti(sotto, orologio::get);
                String dove = chiave + " = " + valoreRotto;
                assertNull(dove + ": la voce rotta non c'è", dopo.trova(id(1)));
                assertNotNull(dove + ": l'altra sì", dopo.trova(id(2)));
                assertEquals(dove, 1, dopo.rapporto().vociScartate);
                assertFalse(dove + ": il file non è corrotto, è una voce sola", dopo.rapporto().corrotta);
                casi++;
            }
        }
        assertTrue("la tabella copre tutti i campi di una voce: " + casi, casi > 80);
    }

    @Test
    public void campiCheLaSpecLasciaVuotiOFacoltativiNonScartanoLaVoce() throws Exception {
        // `codice` nullo è il caso normale; una voce terminale può non nominare nessuna copia; chiavi in più (un binario più
        // nuovo, un'altra versione dell'app) si ignorano come fa il lettore TypeScript.
        File sotto = temporanea.newFolder();
        cartella = sotto;
        CodaCaricamenti prima = new CodaCaricamenti(sotto, orologio::get);
        prima.aggiungi(nuova(1));
        prima.aggiungi(nuova(2));
        prima.transita(id(2), EventoStato.ANNULLATO, null);
        JSONObject radice = leggiCoda();
        radice.getJSONArray("voci").getJSONObject(0).put("campoDiUnaVersioneFutura", "ciao");
        radice.put("chiaveInPiuNellaRadice", 1);
        scrivi("coda.json", radice.toString());
        CodaCaricamenti dopo = new CodaCaricamenti(sotto, orologio::get);
        assertFalse(dopo.rapporto().daSegnalare());
        assertEquals(2, dopo.numeroVoci());
        assertNull(dopo.trova(id(2)).file);
        assertNull(dopo.trova(id(1)).codice);
    }

    @Test
    public void unJobIdDuplicatoNelFileScartaLaSecondaCopia() throws Exception {
        File sotto = temporanea.newFolder();
        cartella = sotto;
        CodaCaricamenti prima = new CodaCaricamenti(sotto, orologio::get);
        prima.aggiungi(nuova(1));
        JSONObject radice = leggiCoda();
        JSONObject doppione = new JSONObject(radice.getJSONArray("voci").getJSONObject(0).toString());
        doppione.put("nome", "doppione");
        radice.getJSONArray("voci").put(doppione);
        scrivi("coda.json", radice.toString());
        CodaCaricamenti dopo = new CodaCaricamenti(sotto, orologio::get);
        assertEquals(1, dopo.numeroVoci());
        assertEquals("prova-1.mp4", dopo.trova(id(1)).nome);
        assertEquals(1, dopo.rapporto().vociScartate);
    }

    @Test
    public void unaVoceTerminaleNonPuoNominareUnaCopia() throws Exception {
        File sotto = temporanea.newFolder();
        cartella = sotto;
        CodaCaricamenti prima = new CodaCaricamenti(sotto, orologio::get);
        prima.aggiungi(nuova(1));
        JSONObject radice = leggiCoda();
        radice.getJSONArray("voci").getJSONObject(0).put("stato", "inviato");   // il file nomina ancora la copia
        scrivi("coda.json", radice.toString());
        File copia = new File(sotto, "file/" + id(1) + ".mp4");
        copia.getParentFile().mkdirs();
        assertTrue(copia.createNewFile());
        CodaCaricamenti dopo = new CodaCaricamenti(sotto, orologio::get);
        assertNull("il terminale non nomina più nessuna copia", dopo.trova(id(1)).file);
        ReportPulizia r = dopo.pulisci();
        assertEquals("e così la copia diventa orfana e si toglie", 1, r.fileOrfani);
        assertFalse(copia.exists());
    }

    @Test
    public void unElementoCheNonEUnOggettoScartaSoloQuelloENonLAltro() throws Exception {
        File sotto = temporanea.newFolder();
        cartella = sotto;
        CodaCaricamenti prima = new CodaCaricamenti(sotto, orologio::get);
        prima.aggiungi(nuova(1));
        JSONObject radice = leggiCoda();
        radice.getJSONArray("voci").put("una stringa");
        radice.getJSONArray("voci").put(JSONObject.NULL);
        radice.getJSONArray("voci").put(42);
        scrivi("coda.json", radice.toString());
        CodaCaricamenti dopo = new CodaCaricamenti(sotto, orologio::get);
        assertEquals(1, dopo.numeroVoci());
        assertEquals(3, dopo.rapporto().vociScartate);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * PULIZIA (§4.6)
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void laPuliziaTogliGliSceltiPiuVecchiDi24Ore() throws Exception {
        CodaCaricamenti coda = apri();
        long adesso = orologio.get();
        File vecchio = creaFile("scelti", "vecchio.mp4", adesso - 25 * ORA);
        File appenaOltre = creaFile("scelti", "appena-oltre.mp4", adesso - 24 * ORA - 1_000L);
        File esatto = creaFile("scelti", "esatto.mp4", adesso - 24 * ORA);
        File fresco = creaFile("scelti", "fresco.mp4", adesso - 23 * ORA);
        File nuovo = creaFile("scelti", "nuovo.jpg", adesso);
        ReportPulizia r = coda.pulisci();
        assertEquals(2, r.scelti);
        assertFalse(vecchio.exists());
        assertFalse(appenaOltre.exists());
        assertTrue("esattamente 24 ore non è «più vecchio di 24 ore»", esatto.exists());
        assertTrue(fresco.exists());
        assertTrue(nuovo.exists());
    }

    @Test
    public void laPuliziaTogliIFileNonNominatiMaMaiQuelliDiUnaVoceViva() throws Exception {
        CodaCaricamenti coda = apri();
        long adesso = orologio.get();
        File nominato = creaFile("file", id(1) + ".mp4", adesso - 40 * GIORNO);        // vecchissimo, ma di una voce viva
        coda.aggiungi(nuova(1));
        File orfano = creaFile("file", id(9) + ".mp4", adesso);                         // nuovissimo, ma di nessuno
        File orfanoParziale = creaFile("file", id(9) + ".mp4.part", adesso);
        File senzaNome = creaFile("file", "qualcosa.bin", adesso);
        ReportPulizia r = coda.pulisci();
        assertTrue("la copia di una voce viva non si tocca mai", nominato.exists());
        assertFalse(orfano.exists());
        assertFalse(orfanoParziale.exists());
        assertFalse(senzaNome.exists());
        assertEquals(3, r.fileOrfani);
    }

    @Test
    public void unaCopiaDiUnaVoceInPausaOInAttesaNonSiTocca() throws Exception {
        CodaCaricamenti coda = apri();
        for (int n = 1; n <= 3; n++) {
            coda.aggiungi(nuova(n));
            creaFile("file", id(n) + ".mp4", orologio.get() - 40 * GIORNO);
        }
        coda.transita(id(2), EventoStato.AVVIATO, null);
        coda.transita(id(2), EventoStato.IN_ATTESA_DI_RETE, Codice.RETE);
        coda.transita(id(3), EventoStato.IN_PAUSA, Codice.FGS_NON_AVVIABILE);
        assertEquals(0, coda.pulisci().fileOrfani);
        for (int n = 1; n <= 3; n++) assertTrue(new File(cartella, "file/" + id(n) + ".mp4").exists());
    }

    @Test
    public void laPuliziaTogliLeVociTerminaliPiuVecchieDiSetteGiorni() throws Exception {
        CodaCaricamenti coda = apri();
        for (int n = 1; n <= 5; n++) coda.aggiungi(nuova(n));
        coda.transita(id(1), EventoStato.FALLITO, Codice.INTERNO);       // diventa terminale ora...
        coda.transita(id(2), EventoStato.ANNULLATO, null);
        coda.transita(id(3), EventoStato.FALLITO, Codice.INTERNO);
        // ...e poi passa il tempo, ma non per tutte alla stessa maniera.
        orologio.addAndGet(7 * GIORNO - 1_000L);
        coda.transita(id(4), EventoStato.FALLITO, Codice.INTERNO);       // terminale da pochi secondi
        orologio.addAndGet(1_000L);                                      // ora 1, 2 e 3 hanno ESATTAMENTE 7 giorni
        ReportPulizia esatti = coda.pulisci();
        assertEquals("esattamente 7 giorni non è «più vecchio di 7 giorni»", 0, esatti.vociTerminali);
        orologio.addAndGet(1L);                                          // 7 giorni e 1 ms
        ReportPulizia vecchie = coda.pulisci();
        assertEquals(3, vecchie.vociTerminali);
        assertNull(coda.trova(id(1)));
        assertNull(coda.trova(id(2)));
        assertNull(coda.trova(id(3)));
        assertNotNull("terminale da poco: resta, il JavaScript potrebbe non averla ancora letta", coda.trova(id(4)));
        assertNotNull("viva da 7 giorni e più: la pulizia non la tocca", coda.trova(id(5)));
        assertTrue(vecchie.persistita);
        assertEquals(2, apri().numeroVoci());
    }

    @Test
    public void laPuliziaTogliISegretiSenzaUnaVoceViva() throws Exception {
        CodaCaricamenti coda = apri();
        long adesso = orologio.get();
        coda.aggiungi(nuova(1));                                     // viva
        coda.aggiungi(nuova(2));
        coda.transita(id(2), EventoStato.ANNULLATO, null);           // terminale: i suoi segreti sono già stati tolti dalla transizione
        File viva = creaFile("segreti", id(1) + ".bin", adesso);
        File vivaNuova = creaFile("segreti", id(1) + ".bin.new", adesso);
        File terminale = creaFile("segreti", id(2) + ".bin", adesso);     // rimasto per un guasto
        File senzaVoce = creaFile("segreti", id(77) + ".bin", adesso);
        File senzaVoceBak = creaFile("segreti", id(77) + ".bin.bak", adesso);
        File ignoto = creaFile("segreti", "chiave.dat", adesso);
        File maiuscolo = creaFile("segreti", id(78).toUpperCase(Locale.ROOT) + ".bin", adesso);
        File senzaEstensione = creaFile("segreti", id(79), adesso);
        ReportPulizia r = coda.pulisci();
        assertEquals(3, r.segreti);
        assertTrue(viva.exists());
        assertTrue(vivaNuova.exists());
        assertFalse(terminale.exists());
        assertFalse(senzaVoce.exists());
        assertFalse(senzaVoceBak.exists());
        assertTrue("un nome che non conosce non lo tocca: è di A2", ignoto.exists());
        assertTrue(maiuscolo.exists());
        assertTrue(senzaEstensione.exists());
    }

    @Test
    public void laPuliziaNonEntraNelleSottocartelleEReggeCartelleAssenti() throws Exception {
        CodaCaricamenti coda = apri();
        File sotto = new File(cartella, "scelti/sotto");
        assertTrue(sotto.mkdirs());
        File dentro = new File(sotto, "x.mp4");
        assertTrue(dentro.createNewFile());
        assertTrue(dentro.setLastModified(orologio.get() - 99 * GIORNO));
        ReportPulizia r = coda.pulisci();
        assertEquals(0, r.scelti);
        assertTrue(dentro.exists());
        assertTrue("nessuna cartella (file/, segreti/) e tutto va bene", r.persistita);
    }

    @Test
    public void laPuliziaSenzaNullaDaFareNonRiscriveLaCoda() throws Exception {
        CodaCaricamenti coda = apri();
        coda.aggiungi(nuova(1));
        File coda_json = new File(cartella, "coda.json");
        assertTrue(coda_json.setLastModified(1_000L));
        ReportPulizia r = coda.pulisci();
        assertEquals(0, r.scelti + r.fileOrfani + r.vociTerminali + r.segreti);
        assertEquals("nessun cambiamento: nessuna scrittura", 1_000L, coda_json.lastModified());
    }

    @Test
    public void laPuliziaPassaTutteEQuattroLeMisureInUnColpoSolo() throws Exception {
        CodaCaricamenti coda = apri();
        long adesso = orologio.get();
        coda.aggiungi(nuova(1));
        coda.aggiungi(nuova(2));
        coda.transita(id(2), EventoStato.ANNULLATO, null);
        creaFile("scelti", "a.mp4", adesso - 30 * ORA);
        creaFile("scelti", "b.mp4", adesso - 30 * ORA);
        creaFile("file", id(1) + ".mp4", adesso);
        creaFile("file", id(50) + ".mp4", adesso);
        creaFile("segreti", id(1) + ".bin", adesso);
        creaFile("segreti", id(60) + ".bin", adesso);
        orologio.addAndGet(8 * GIORNO);
        ReportPulizia r = coda.pulisci();
        assertEquals(2, r.scelti);
        assertEquals(1, r.fileOrfani);
        assertEquals(1, r.vociTerminali);
        assertEquals(1, r.segreti);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * GUASTI DI SCRITTURA
     * ──────────────────────────────────────────────────────────────────────────── */

    private boolean sappiamoRendereLaCartellaNonScrivibile(File dir) throws IOException {
        if (!dir.setWritable(false, false)) return false;
        File prova = new File(dir, "prova-scrittura.tmp");
        boolean scritta = false;
        try {
            scritta = prova.createNewFile();
        } catch (IOException atteso) {
            scritta = false;
        }
        if (scritta) {
            prova.delete();
            dir.setWritable(true, false);
            return false;
        }
        return true;
    }

    @Test
    public void unaCodaCheNonSiScriveFaLanciareAggiungiENonTieneLaVoce() throws Exception {
        CodaCaricamenti coda = apri();
        Assume.assumeTrue("serve una cartella davvero non scrivibile (non da root)", sappiamoRendereLaCartellaNonScrivibile(cartella));
        try {
            try {
                coda.aggiungi(nuova(1));
                fail("la coda non si può scrivere: il video non va dichiarato accodato");
            } catch (IOException atteso) {
                // coda non scritta
            }
            assertEquals("la voce non resta in memoria", 0, coda.numeroVoci());
            assertNull(coda.trova(id(1)));
        } finally {
            assertTrue(cartella.setWritable(true, false));
        }
        coda.aggiungi(nuova(1));
        assertEquals("tornata scrivibile, si riesce", 1, apri().numeroVoci());
    }

    @Test
    public void unaTransizioneCheNonSiScriveLoDiceEAggiornaLaMemoria() throws Exception {
        CodaCaricamenti coda = apri();
        coda.aggiungi(nuova(1));
        Assume.assumeTrue("serve una cartella davvero non scrivibile (non da root)", sappiamoRendereLaCartellaNonScrivibile(cartella));
        try {
            EsitoTransizione e = coda.transita(id(1), EventoStato.AVVIATO, null);
            assertSame(TipoTransizione.APPLICATA, e.tipo);
            assertFalse("persistita = false", e.persistita);
            assertSame("la memoria è aggiornata", Stato.IN_INVIO, coda.trova(id(1)).stato);
            EsitoTransizione m = coda.modifica(id(1), v -> v.tentativi = 2);
            assertFalse(m.persistita);
            assertFalse(coda.impostaTesti(new Testi("Altro", null, null, null)));
        } finally {
            assertTrue(cartella.setWritable(true, false));
        }
        assertSame("su disco c'è ancora lo stato di prima", Stato.IN_CODA, apri().trova(id(1)).stato);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * TESTI DELLE NOTIFICHE
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void iTestiDiRipiegoSonoQuelliDellaSpec() {
        Testi t = Testi.predefiniti();
        assertEquals("Kidville", t.titolo);
        assertEquals("Invio dei video in corso", t.invio);
        assertEquals("Il video è in attesa di rete: riprenderà da solo", t.attesaRete);
        assertEquals("Invio in pausa: tocca per riprendere", t.pausa);
    }

    @Test
    public void iTestiPassatiSiConservanoESopravvivonoAlRiavvio() throws Exception {
        CodaCaricamenti coda = apri();
        assertTrue(coda.impostaTesti(new Testi("Kidville", "Sending videos", "Waiting for network", "Paused: tap to resume")));
        Testi dopo = apri().testi();
        assertEquals("Sending videos", dopo.invio);
        assertEquals("Waiting for network", dopo.attesaRete);
        assertEquals("Paused: tap to resume", dopo.pausa);
        assertEquals("Kidville", dopo.titolo);
    }

    @Test
    public void unTestoVuotoNulloOTroppoLungoTornaAlRipiegoCampoPerCampo() {
        Testi t = new Testi(null, "   ", repeat('x', 201), "Pausa");
        Testi base = Testi.predefiniti();
        assertEquals(base.titolo, t.titolo);
        assertEquals(base.invio, t.invio);
        assertEquals(base.attesaRete, t.attesaRete);
        assertEquals("un campo buono si tiene", "Pausa", t.pausa);
        assertEquals("200 caratteri vanno bene", 200, new Testi(repeat('x', 200), null, null, null).titolo.length());
    }

    @Test
    public void unTestoNulloONonStringaNelFileTornaAlRipiegoNonALaParolaNull() throws Exception {
        File sotto = temporanea.newFolder();
        cartella = sotto;
        CodaCaricamenti prima = new CodaCaricamenti(sotto, orologio::get);
        prima.impostaTesti(new Testi("A", "B", "C", "D"));
        JSONObject radice = leggiCoda();
        radice.getJSONObject("testi").put("titolo", JSONObject.NULL);
        radice.getJSONObject("testi").put("invio", 42);
        radice.getJSONObject("testi").remove("attesaRete");
        scrivi("coda.json", radice.toString());
        Testi dopo = new CodaCaricamenti(sotto, orologio::get).testi();
        Testi base = Testi.predefiniti();
        assertEquals(base.titolo, dopo.titolo);
        assertEquals(base.invio, dopo.invio);
        assertEquals(base.attesaRete, dopo.attesaRete);
        assertEquals("il campo buono resta", "D", dopo.pausa);
    }

    @Test
    public void impostareTestiNulliRiportaIRipiegoEUgualiNonRiscrivono() throws Exception {
        CodaCaricamenti coda = apri();
        coda.impostaTesti(new Testi("A", "B", "C", "D"));
        coda.impostaTesti(null);
        assertEquals(Testi.predefiniti().invio, coda.testi().invio);
        coda.aggiungi(nuova(1));
        File f = new File(cartella, "coda.json");
        assertTrue(f.setLastModified(1_000L));
        assertTrue(coda.impostaTesti(Testi.predefiniti()));
        assertEquals("stessi testi: nessuna scrittura", 1_000L, f.lastModified());
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL PONTE: la forma di `CaricamentoNativo` (S1, secondario n. 2)
     * ──────────────────────────────────────────────────────────────────────────── */

    private static final Pattern DATA_ISO_Z = Pattern.compile("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$");
    private static final Pattern UUID_MINUSCOLO = Pattern.compile("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");
    private static final Pattern MIME_PERMISSIVO = Pattern.compile(
            "^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}(?:\\s*;[^\\n]*)?$", Pattern.CASE_INSENSITIVE);

    /** Le regole di `schemaCaricamentoNativo` (S1) riscritte qui: ciò che il JavaScript rilegge. */
    private static void verificaFormaDelPonte(JSONObject json) throws Exception {
        assertEquals("esattamente i quattordici campi di CaricamentoNativo",
                new HashSet<>(Arrays.asList("jobId", "intentId", "utenteId", "scuolaId", "nome", "mime", "stato", "byteInviati", "byteTotali",
                        "tentativi", "rinnovi", "codice", "creatoIl", "aggiornatoIl")), nomi(json));
        for (String chiave : new String[]{"jobId", "intentId", "utenteId", "scuolaId"}) {
            assertTrue(chiave, json.get(chiave) instanceof String && UUID_MINUSCOLO.matcher(json.getString(chiave)).matches());
        }
        String nome = json.getString("nome");
        assertTrue("nome da 1 a 255", nome.length() >= 1 && nome.length() <= 255);
        String mime = json.getString("mime");
        assertTrue("mime ammesso", mime.length() >= 3 && mime.length() <= 255 && MIME_PERMISSIVO.matcher(mime).matches());
        assertNotNull(Stato.daValore(json.getString("stato")));
        assertTrue(json.get("byteInviati") instanceof Number);
        assertTrue(json.get("byteTotali") instanceof Number);
        assertTrue(json.getLong("byteInviati") >= 0 && json.getLong("byteInviati") <= json.getLong("byteTotali"));
        assertTrue(json.getLong("byteTotali") >= 1);
        assertTrue(json.getLong("tentativi") >= 0 && json.getLong("rinnovi") >= 0);
        assertTrue("codice c'è sempre (anche nullo)", json.has("codice"));
        if (!json.isNull("codice")) assertNotNull(Codice.daValore(json.getString("codice")));
        assertTrue(DATA_ISO_Z.matcher(json.getString("creatoIl")).matches());
        assertTrue(DATA_ISO_Z.matcher(json.getString("aggiornatoIl")).matches());
    }

    @Test
    public void laVoceNellaFormaDelPonteHaTuttiIQuattordiciCampi() throws Exception {
        CodaCaricamenti coda = apri();
        VoceCoda v = coda.aggiungi(nuova(1)).voce;
        JSONObject json = CodaCaricamenti.aJsonPonte(v, 1_234L);
        verificaFormaDelPonte(json);
        assertEquals(id(1), json.getString("jobId"));
        assertEquals(id(1001), json.getString("intentId"));
        assertEquals(UTENTE, json.getString("utenteId"));
        assertEquals(SCUOLA, json.getString("scuolaId"));
        assertEquals("prova-1.mp4", json.getString("nome"));
        assertEquals("video/mp4", json.getString("mime"));
        assertEquals("in-coda", json.getString("stato"));
        assertEquals(1_234L, json.getLong("byteInviati"));
        assertEquals(5_000_001L, json.getLong("byteTotali"));
        assertEquals("2026-09-21T14:13:20.000Z", json.getString("creatoIl"));
    }

    @Test
    public void ilCodiceNulloSiScriveComeNullENonSiToglieLaChiave() throws Exception {
        // JSObject.put(chiave, null) TOGLIE la chiave, e una chiave mancante rende l'intera risposta illeggibile al JavaScript:
        // qui il valore è JSONObject.NULL, che sopravvive alla serializzazione e al rientro.
        CodaCaricamenti coda = apri();
        VoceCoda v = coda.aggiungi(nuova(1)).voce;
        JSONObject json = CodaCaricamenti.aJsonPonte(v, 0L);
        assertTrue(json.has("codice"));
        assertSame(JSONObject.NULL, json.get("codice"));
        String serializzato = json.toString();
        assertTrue(serializzato, serializzato.contains("\"codice\":null"));
        JSONObject riletto = new JSONObject(serializzato);
        assertTrue("dopo il giro di serializzazione la chiave c'è ancora", riletto.has("codice") && riletto.isNull("codice"));
    }

    @Test
    public void ogniCodiceSiScriveComeIlSuoNomeDelContratto() throws Exception {
        CodaCaricamenti coda = apri();
        VoceCoda v = coda.aggiungi(nuova(1)).voce;
        for (Codice codice : Codice.values()) {
            v.codice = codice;
            v.stato = Stato.FALLITO;
            JSONObject json = CodaCaricamenti.aJsonPonte(v, 0L);
            assertEquals(codice.name(), json.getString("codice"));
            verificaFormaDelPonte(json);
        }
    }

    @Test
    public void ogniStatoSiScriveComeIlSuoValoreDelContratto() throws Exception {
        CodaCaricamenti coda = apri();
        VoceCoda v = coda.aggiungi(nuova(1)).voce;
        for (Stato stato : Stato.values()) {
            v.stato = stato;
            assertEquals(stato.valore(), CodaCaricamenti.aJsonPonte(v, 0L).getString("stato"));
        }
    }

    @Test
    public void leDateDelPonteSonoIsoConLaZMaiConIlFusoNumerico() throws Exception {
        assertEquals("1970-01-01T00:00:00.000Z", CodaCaricamenti.isoUtc(0L));
        assertEquals("2023-11-14T22:13:20.123Z", CodaCaricamenti.isoUtc(1_700_000_000_123L));
        assertEquals("2026-09-21T14:13:20.007Z", CodaCaricamenti.isoUtc(1_790_000_000_007L));
        assertEquals("2000-02-29T12:00:00.000Z", CodaCaricamenti.isoUtc(951_825_600_000L));
        for (long ms : new long[]{0L, 1L, 999L, 86_399_999L, 1_700_000_000_000L, 4_102_444_800_000L}) {
            String s = CodaCaricamenti.isoUtc(ms);
            assertTrue(s, DATA_ISO_Z.matcher(s).matches());
            assertTrue(s.endsWith("Z"));
            assertFalse("mai +0000 (il modello Z di SimpleDateFormat)", s.contains("+"));
            assertFalse("mai un fuso numerico in coda", s.matches(".*[+-]\\d{2}:?\\d{2}$"));
        }
    }

    @Test
    public void leDateNonDipendonoDallaLinguaNeDalFusoDelTelefono() throws Exception {
        Locale prima = Locale.getDefault();
        java.util.TimeZone fusoPrima = java.util.TimeZone.getDefault();
        try {
            java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone("Asia/Kolkata"));
            for (Locale lingua : new Locale[]{Locale.forLanguageTag("ar-SA"), Locale.forLanguageTag("th-TH"), Locale.forLanguageTag("hi-IN"), Locale.JAPAN}) {
                Locale.setDefault(lingua);
                assertEquals(lingua.toString(), "2023-11-14T22:13:20.123Z", CodaCaricamenti.isoUtc(1_700_000_000_123L));
            }
        } finally {
            Locale.setDefault(prima);
            java.util.TimeZone.setDefault(fusoPrima);
        }
    }

    @Test
    public void ilNomeDelPonteHaSempreDa1A255CaratteriConUnRipiego() throws Exception {
        CodaCaricamenti coda = apri();
        VoceCoda v = coda.aggiungi(nuova(1)).voce;
        for (String nome : new String[]{null, "", " ", "\t\n", "a", repeat('é', 255), repeat('é', 256), repeat('x', 1000)}) {
            v.nome = nome;
            JSONObject json = CodaCaricamenti.aJsonPonte(v, 0L);
            verificaFormaDelPonte(json);
            int atteso = nome == null || nome.trim().isEmpty() ? 5 : Math.min(nome.trim().length(), 255);
            assertEquals("«" + nome + "»", atteso, json.getString("nome").length());
        }
    }

    @Test
    public void unNomeTagliatoNonSpezzaUnaCoppiaSurrogata() throws Exception {
        // 254 lettere + un carattere fuori dal piano base (due unità UTF-16): tagliare a 255 spezzerebbe la coppia.
        String nome = repeat('x', 254) + FUORI_DAL_PIANO_BASE + "fine";
        String tagliato = CodaCaricamenti.nomeValido(nome);
        assertEquals(254, tagliato.length());
        assertFalse(Character.isHighSurrogate(tagliato.charAt(tagliato.length() - 1)));
        // Con la coppia tutta dentro il limite, invece, si tiene intera.
        String dentro = repeat('x', 253) + FUORI_DAL_PIANO_BASE + "fine";
        assertEquals(255, CodaCaricamenti.nomeValido(dentro).length());
        assertTrue(CodaCaricamenti.nomeValido(dentro).endsWith(FUORI_DAL_PIANO_BASE));
    }

    @Test
    public void ilMimeDelPonteHaUnRipiegoSeQuelloSalvatoNonVaBene() throws Exception {
        CodaCaricamenti coda = apri();
        VoceCoda v = coda.aggiungi(nuova(1)).voce;
        for (String mime : new String[]{"", "x", "video", "video/", "non un mime", "video/mp4\nx", null}) {
            v.mime = mime;
            assertEquals("«" + mime + "»", "video/mp4", CodaCaricamenti.aJsonPonte(v, 0L).getString("mime"));
        }
        v.mime = "video/quicktime";
        assertEquals("video/quicktime", CodaCaricamenti.aJsonPonte(v, 0L).getString("mime"));
        v.mime = "video/mp4;codecs=avc1.42E01E,mp4a.40.2";
        assertEquals("il suffisso dei codec è ammesso", "video/mp4;codecs=avc1.42E01E,mp4a.40.2", CodaCaricamenti.aJsonPonte(v, 0L).getString("mime"));
    }

    @Test
    public void iByteInviatiStannoSempreFraZeroEIlTotale() throws Exception {
        CodaCaricamenti coda = apri();
        VoceCoda v = coda.aggiungi(nuova(1)).voce;
        long totale = v.byteTotali;
        assertEquals(0L, CodaCaricamenti.aJsonPonte(v, -50L).getLong("byteInviati"));
        assertEquals(0L, CodaCaricamenti.aJsonPonte(v, 0L).getLong("byteInviati"));
        assertEquals(1_000L, CodaCaricamenti.aJsonPonte(v, 1_000L).getLong("byteInviati"));
        assertEquals(totale, CodaCaricamenti.aJsonPonte(v, totale).getLong("byteInviati"));
        assertEquals("oltre il totale: il totale", totale, CodaCaricamenti.aJsonPonte(v, totale + 99L).getLong("byteInviati"));
        assertEquals(totale, CodaCaricamenti.aJsonPonte(v, Long.MAX_VALUE).getLong("byteInviati"));
    }

    @Test
    public void unaVoceInviataHaSempreInviatoTuttiIByte() throws Exception {
        CodaCaricamenti coda = apri();
        coda.aggiungi(nuova(1));
        coda.transita(id(1), EventoStato.AVVIATO, null);
        VoceCoda fine = coda.transita(id(1), EventoStato.INVIATO, null).voce;
        JSONObject json = CodaCaricamenti.aJsonPonte(fine, 0L);
        assertEquals("un 'gia-arrivato' non ha avanzamento in memoria, ma i byte ci sono tutti", fine.byteTotali, json.getLong("byteInviati"));
        verificaFormaDelPonte(json);
    }

    @Test
    public void iContatoriNegativiNonUsciranno() throws Exception {
        CodaCaricamenti coda = apri();
        VoceCoda v = coda.aggiungi(nuova(1)).voce;
        v.tentativi = -3;
        v.rinnovi = -2;
        JSONObject json = CodaCaricamenti.aJsonPonte(v, 0L);
        assertEquals(0, json.getInt("tentativi"));
        assertEquals(0, json.getInt("rinnovi"));
    }

    @Test
    public void unaVoceDopoLoSpostamentoDeiTerminaliHaSempreUnaFormaValida() throws Exception {
        CodaCaricamenti coda = apri();
        for (int n = 1; n <= 7; n++) coda.aggiungi(nuova(n));
        coda.transita(id(1), EventoStato.AVVIATO, null);
        coda.transita(id(2), EventoStato.AVVIATO, null);
        coda.transita(id(2), EventoStato.IN_ATTESA_DI_RETE, Codice.RETE);
        coda.transita(id(3), EventoStato.IN_PAUSA, Codice.FGS_NON_AVVIABILE);
        coda.transita(id(4), EventoStato.FALLITO, Codice.TOKEN_SCADUTO);
        coda.transita(id(5), EventoStato.ANNULLATO, Codice.ANNULLATO_DAL_SERVER);
        coda.transita(id(6), EventoStato.AVVIATO, null);
        coda.transita(id(6), EventoStato.INVIATO, null);
        for (VoceCoda v : coda.elenco(UTENTE)) verificaFormaDelPonte(CodaCaricamenti.aJsonPonte(v, 10L));
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * CONCORRENZA
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test(timeout = 60_000)
    public void piuThreadChePrendonoLaStessaCodaNonSiPestanoIPiedi() throws Exception {
        final CodaCaricamenti coda = apri();
        final int thread = 8;
        final int perThread = 15;
        final CountDownLatch via = new CountDownLatch(1);
        final CountDownLatch fatto = new CountDownLatch(thread);
        final List<Throwable> errori = java.util.Collections.synchronizedList(new ArrayList<Throwable>());
        for (int t = 0; t < thread; t++) {
            final int base = 100 + t * perThread;
            new Thread(() -> {
                try {
                    via.await();
                    for (int i = 0; i < perThread; i++) {
                        coda.aggiungi(nuova(base + i));
                        coda.transita(id(base + i), EventoStato.AVVIATO, null);
                        coda.elenco(UTENTE);
                        coda.modifica(id(base + i), v -> v.tentativi++);
                        coda.vive();
                    }
                } catch (Throwable errore) {
                    errori.add(errore);
                } finally {
                    fatto.countDown();
                }
            }).start();
        }
        via.countDown();
        assertTrue(fatto.await(50, TimeUnit.SECONDS));
        assertTrue("errori nei thread: " + errori, errori.isEmpty());
        assertEquals(thread * perThread, coda.numeroVoci());
        CodaCaricamenti riaperta = apri();
        assertFalse(riaperta.rapporto().daSegnalare());
        assertEquals("il file su disco ha tutte le voci", thread * perThread, riaperta.numeroVoci());
        for (VoceCoda v : riaperta.vive()) {
            assertSame(Stato.IN_INVIO, v.stato);
            assertEquals(1, v.tentativi);
        }
    }

    @Test
    public void lOrigineSiScriveEsiRilegge() throws Exception {
        CodaCaricamenti coda = apri();
        for (Origine origine : Origine.values()) {
            VoceCoda v = nuova(10 + origine.ordinal());
            v.origine = origine;
            coda.aggiungi(v);
        }
        CodaCaricamenti dopo = apri();
        for (Origine origine : Origine.values()) {
            assertSame(origine, dopo.trova(id(10 + origine.ordinal())).origine);
        }
        assertNull(Origine.daValore("sconosciuta"));
        assertNull(Origine.daValore(null));
        assertEquals(Arrays.asList("galleria", "file", "prova"), Arrays.asList(Origine.GALLERIA.valore(), Origine.FILE.valore(), Origine.PROVA.valore()));
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * COMPITO A2: LE CORREZIONI AI MATTONI DI A1 (secondari n. 43-49 della PR 3)
     * ──────────────────────────────────────────────────────────────────────────── */

    private File codaJson() {
        return new File(cartella, "coda.json");
    }

    /** Una coda il cui disco si comporta come quello del TELEFONO: `finishWrite` non lancia, e se `traslocaDavvero` è falso non rinomina. */
    private CodaCaricamenti codaSuUnDiscoCheSiPuoRompere(AtomicFileCheNonTrasloca atomico) {
        return new CodaCaricamenti(cartella, orologio::get, atomico);
    }

    @Test
    public void unaScritturaCheSulTelefonoNonRinominaFaLanciareAggiungiENonTieneLaVoce() throws Exception {
        AtomicFileCheNonTrasloca nonTrasloca = new AtomicFileCheNonTrasloca(codaJson(), false);
        CodaCaricamenti coda = codaSuUnDiscoCheSiPuoRompere(nonTrasloca);
        try {
            coda.aggiungi(nuova(1));
            fail("sul telefono `finishWrite` non lancia: è la verifica a dire che il video NON è accodato (secondario n. 45)");
        } catch (IOException atteso) {
            // non accodato
        }
        assertEquals("la voce non resta in memoria", 0, coda.numeroVoci());
        assertFalse("e sul disco non c'è niente", codaJson().exists());
        nonTrasloca.traslocaDavvero = true;
        coda.aggiungi(nuova(1));
        assertEquals("riaccesa la rinomina, si riesce", 1, apri().numeroVoci());
    }

    @Test
    public void unaTransizioneCheSulTelefonoNonSiScriveDaPersistitaFalsa() throws Exception {
        AtomicFileCheNonTrasloca nonTrasloca = new AtomicFileCheNonTrasloca(codaJson(), true);
        CodaCaricamenti coda = codaSuUnDiscoCheSiPuoRompere(nonTrasloca);
        coda.aggiungi(nuova(1));
        nonTrasloca.traslocaDavvero = false;
        EsitoTransizione e = coda.transita(id(1), EventoStato.AVVIATO, null);
        assertFalse("`persistita` dice la verità anche quando finishWrite non lancia", e.persistita);
        assertSame("la memoria è aggiornata", Stato.IN_INVIO, coda.trova(id(1)).stato);
        assertSame("il disco è quello di prima", Stato.IN_CODA, apri().trova(id(1)).stato);
    }

    @Test
    public void ilTerminaleNonRiuscitoASalvareLasciaCopiaESegretiEIlDiscoCoraAncoraViva() throws Exception {
        AtomicFileCheNonTrasloca nonTrasloca = new AtomicFileCheNonTrasloca(codaJson(), true);
        CodaCaricamenti coda = codaSuUnDiscoCheSiPuoRompere(nonTrasloca);
        coda.aggiungi(nuova(1));
        coda.transita(id(1), EventoStato.AVVIATO, null);
        File copia = creaFile("file", id(1) + ".mp4", orologio.get());
        File segreto = coda.fileSegreto(id(1));
        segreto.getParentFile().mkdirs();
        assertTrue(segreto.createNewFile());

        nonTrasloca.traslocaDavvero = false;       // il disco «non dà più i numeri»
        EsitoTransizione e = coda.transita(id(1), EventoStato.INVIATO, null);
        assertSame(TipoTransizione.APPLICATA, e.tipo);
        assertFalse(e.persistita);
        assertTrue("senza il disco la copia e i segreti restano (e `residuiRimasti` lo dice)", e.residuiRimasti);
        assertTrue("la copia c'è ancora: sul disco la voce è viva e la nomina", copia.exists());
        assertTrue("i segreti ci sono ancora", segreto.exists());
        assertNull("in memoria la voce è terminale e non nomina più niente", e.voce.file);
        // Alla riapertura la voce è com'era: viva, col suo file, pronta a riprendere (la PUT ripetuta dà il duplicato che il rinnovo risolve).
        VoceCoda dopoIlRiavvio = apri().trova(id(1));
        assertSame(Stato.IN_INVIO, dopoIlRiavvio.stato);
        assertEquals("file/" + id(1) + ".mp4", dopoIlRiavvio.file);
    }

    @Test
    public void ilTerminaleSiSalvaPrimaDellaCancellazioneEUnaCancellazioneCheFallisceNonDisfaIlSalvataggio() throws Exception {
        CodaCaricamenti coda = apri();
        coda.aggiungi(nuova(1));
        coda.transita(id(1), EventoStato.AVVIATO, null);
        // La «copia» è una cartella non vuota: `File.delete()` non la toglie. Lo stato terminale è però GIÀ su disco (secondario n. 43).
        File copia = new File(cartella, "file/" + id(1) + ".mp4");
        assertTrue(copia.mkdirs());
        assertTrue(new File(copia, "dentro").createNewFile());
        EsitoTransizione e = coda.transita(id(1), EventoStato.INVIATO, null);
        assertTrue(e.persistita);
        assertTrue(e.residuiRimasti);
        VoceCoda dalDisco = apri().trova(id(1));
        assertSame("il disco ha lo stato terminale: la cancellazione fallita non lo cancella", Stato.INVIATO, dalDisco.stato);
        assertNull(dalDisco.file);
    }

    @Test
    public void ogniTerminaleSalvaPrimaEPoiCancella() throws Exception {
        for (EventoStato terminale : new EventoStato[]{EventoStato.INVIATO, EventoStato.FALLITO, EventoStato.ANNULLATO}) {
            File radice = temporanea.newFolder();
            AtomicFileCheNonTrasloca nonTrasloca = new AtomicFileCheNonTrasloca(new File(radice, "coda.json"), true);
            CodaCaricamenti coda = new CodaCaricamenti(radice, orologio::get, nonTrasloca);
            coda.aggiungi(nuova(1));
            coda.transita(id(1), EventoStato.AVVIATO, null);
            File copia = new File(radice, "file/" + id(1) + ".mp4");
            copia.getParentFile().mkdirs();
            assertTrue(copia.createNewFile());
            nonTrasloca.traslocaDavvero = false;
            coda.transita(id(1), terminale, terminale == EventoStato.FALLITO ? Codice.INTERNO : null);
            assertTrue(terminale.name() + ": con il disco che non salva la copia non si tocca", copia.exists());
        }
    }

    @Test
    public void aggiungiSuUnJobConUnaVoceTerminaleLaSostituisceEIlVideoRiparte() throws Exception {
        for (EventoStato terminale : new EventoStato[]{EventoStato.INVIATO, EventoStato.FALLITO, EventoStato.ANNULLATO}) {
            File radice = temporanea.newFolder();
            CodaCaricamenti coda = new CodaCaricamenti(radice, orologio::get);
            coda.aggiungi(nuova(1));
            coda.transita(id(1), EventoStato.AVVIATO, null);
            coda.transita(id(1), terminale, terminale == EventoStato.FALLITO ? Codice.INTERNO : null);
            assertTrue(coda.trova(id(1)).stato.terminale());
            long creataPrima = coda.trova(id(1)).creatoIl;
            orologio.addAndGet(5_000L);

            RisultatoAggiunta r = coda.aggiungi(nuova(1));
            assertFalse(terminale.name() + ": una voce NUOVA, non la terminale restituita (secondario n. 44)", r.giaPresente);
            assertSame(Stato.IN_CODA, r.voce.stato);
            assertNull(r.voce.codice);
            assertEquals("file/" + id(1) + ".mp4", r.voce.file);
            assertEquals("una voce sola, non due", 1, coda.numeroVoci());
            assertEquals(creataPrima + 5_000L, coda.trova(id(1)).creatoIl);
            assertSame("e la riapertura la ritrova viva", Stato.IN_CODA, new CodaCaricamenti(radice, orologio::get).trova(id(1)).stato);
        }
    }

    @Test
    public void aggiungiSuUnaVoceVivaRestaIdempotenteENonLaTocca() throws Exception {
        CodaCaricamenti coda = apri();
        coda.aggiungi(nuova(1));
        coda.transita(id(1), EventoStato.AVVIATO, null);
        coda.modifica(id(1), v -> v.tentativi = 4);
        RisultatoAggiunta r = coda.aggiungi(nuova(1));
        assertTrue(r.giaPresente);
        assertSame(Stato.IN_INVIO, r.voce.stato);
        assertEquals(4, r.voce.tentativi);
    }

    @Test
    public void aggiungiSpostandoSostituisceUnaTerminaleEPortaIlFileNelPercorsoDellaVoce() throws Exception {
        CodaCaricamenti coda = apri();
        coda.aggiungi(nuova(1));
        coda.transita(id(1), EventoStato.ANNULLATO, null);
        File preparato = creaFile("scelti", "nuovo.mp4", orologio.get());
        RisultatoAggiunta r = coda.aggiungiSpostando(nuova(1), preparato);
        assertFalse(r.giaPresente);
        assertFalse("il preparato è stato spostato", preparato.exists());
        assertTrue(new File(cartella, "file/" + id(1) + ".mp4").isFile());
        assertSame(Stato.IN_CODA, coda.trova(id(1)).stato);
    }

    @Test
    public void seLaSostituzioneDiUnaTerminaleNonSiScriveLaTerminaleTornaAlSuoPosto() throws Exception {
        AtomicFileCheNonTrasloca nonTrasloca = new AtomicFileCheNonTrasloca(codaJson(), true);
        CodaCaricamenti coda = codaSuUnDiscoCheSiPuoRompere(nonTrasloca);
        coda.aggiungi(nuova(1));
        coda.transita(id(1), EventoStato.FALLITO, Codice.INTERNO);
        nonTrasloca.traslocaDavvero = false;
        try {
            coda.aggiungi(nuova(1));
            fail("la coda non si scrive");
        } catch (IOException atteso) {
            // non sostituita
        }
        assertSame("la terminale è ancora lì", Stato.FALLITO, coda.trova(id(1)).stato);
        assertEquals(1, coda.numeroVoci());
        File preparato = creaFile("scelti", "nuovo.mp4", orologio.get());
        try {
            coda.aggiungiSpostando(nuova(1), preparato);
            fail("la coda non si scrive");
        } catch (IOException atteso) {
            // non sostituita
        }
        assertTrue("e il preparato è tornato dov'era", preparato.exists());
        assertFalse(new File(cartella, "file/" + id(1) + ".mp4").exists());
    }

    @Test
    public void dimenticaControllaLEsitoDellaScritturaERimettePosteLeVociSeNonRiesce() throws Exception {
        AtomicFileCheNonTrasloca nonTrasloca = new AtomicFileCheNonTrasloca(codaJson(), true);
        CodaCaricamenti coda = codaSuUnDiscoCheSiPuoRompere(nonTrasloca);
        coda.aggiungi(nuova(1));
        coda.aggiungi(nuova(2));
        coda.transita(id(1), EventoStato.ANNULLATO, null);
        coda.transita(id(2), EventoStato.FALLITO, Codice.INTERNO);
        nonTrasloca.traslocaDavvero = false;
        assertEquals("non scritto: nessuna voce è stata dimenticata (secondario n. 49)", 0, coda.dimentica(Arrays.asList(id(1), id(2))));
        assertNotNull("e le voci sono ancora lì, in memoria", coda.trova(id(1)));
        assertNotNull(coda.trova(id(2)));
        assertEquals(2, apri().numeroVoci());
        nonTrasloca.traslocaDavvero = true;
        assertEquals("riaccesa la rinomina, si riesce", 2, coda.dimentica(Arrays.asList(id(1), id(2))));
        assertEquals(0, apri().numeroVoci());
    }

    @Test
    public void lePulizieTolgonoICodaCorrottaVecchiDiSetteGiorniDalNomeENonDallaDataDelFile() throws Exception {
        CodaCaricamenti coda = apri();
        long adesso = orologio.get();
        File vecchioNelNome = scrivi(cartella, "coda.corrotta-" + (adesso - 8 * GIORNO) + ".json", adesso);              // data del file RECENTE
        File recenteNelNome = scrivi(cartella, "coda.corrotta-" + (adesso - 1 * GIORNO) + ".json", adesso - 30 * GIORNO);  // data del file VECCHIA
        File conSuffisso = scrivi(cartella, "coda.corrotta-" + (adesso - 9 * GIORNO) + "-2.json", adesso);
        File senzaNumero = scrivi(cartella, "coda.corrotta-x.json", adesso - 20 * GIORNO);                                // si ripiega sulla data
        File senzaNumeroRecente = scrivi(cartella, "coda.corrotta-y.json", adesso);
        File altroTipo = scrivi(cartella, "coda.corrotta-" + (adesso - 99 * GIORNO) + ".txt", adesso - 99 * GIORNO);        // non è un file di coda guasta
        File nonCorrotto = scrivi(cartella, "registro.json", adesso - 99 * GIORNO);
        ReportPulizia r = coda.pulisci();
        assertEquals("tre tolti: il vecchio nel nome, quello col suffisso, quello senza numero con la data vecchia", 3, r.codeCorrotte);
        assertFalse(vecchioNelNome.exists());
        assertFalse(conSuffisso.exists());
        assertFalse(senzaNumero.exists());
        assertTrue("recente nel nome: resta, anche se il file è vecchio", recenteNelNome.exists());
        assertTrue(senzaNumeroRecente.exists());
        assertTrue("un altro tipo di file non si tocca", altroTipo.exists());
        assertTrue("il registro non si tocca mai", nonCorrotto.exists());
    }

    private File scrivi(File dir, String nome, long ultimaModificaMs) throws IOException {
        File f = new File(dir, nome);
        try (FileOutputStream uscita = new FileOutputStream(f)) {
            uscita.write(new byte[]{'{', '}'});
        }
        assertTrue(f.setLastModified(ultimaModificaMs));
        return f;
    }

    @Test
    public void lIstanteDelNomeDiUnFileCorrottoSiLeggeFinoAlPrimoNonNumero() {
        assertEquals(1_790_000_000_123L, CodaCaricamenti.istanteDelFileCorrotto("coda.corrotta-1790000000123.json", -1L));
        assertEquals(1_790_000_000_123L, CodaCaricamenti.istanteDelFileCorrotto("coda.corrotta-1790000000123-3.json", -1L));
        assertEquals("niente numero: il ripiego", 77L, CodaCaricamenti.istanteDelFileCorrotto("coda.corrotta-abc.json", 77L));
        assertEquals(77L, CodaCaricamenti.istanteDelFileCorrotto("coda.corrotta-.json", 77L));
    }

    @Test
    public void laPuliziaSenzaFileCorrottiNonLiContaEMantieneIlRapportoACinqueMisure() throws Exception {
        CodaCaricamenti coda = apri();
        coda.aggiungi(nuova(1));
        ReportPulizia r = coda.pulisci();
        assertEquals(0, r.codeCorrotte);
        assertEquals(0, r.scelti + r.fileOrfani + r.vociTerminali + r.segreti);
    }

    @Test
    public void iByteTotaliDelPonteNonSuperanoMaiIlTettoDiUnVideo() throws Exception {
        VoceCoda v = nuova(1);
        v.byteTotali = 3_000_000_000L;           // oltre i 2 GB: renderebbe RISPOSTA_NON_VALIDA l'intero elenco
        v.stato = Stato.IN_INVIO;
        JSONObject json = CodaCaricamenti.aJsonPonte(v, 2_900_000_000L);
        assertEquals(CodaCaricamenti.MAX_VIDEO_INPUT_BYTES, json.getLong("byteTotali"));
        assertTrue("e byteInviati sta nel totale limitato", json.getLong("byteInviati") <= CodaCaricamenti.MAX_VIDEO_INPUT_BYTES);
        v.stato = Stato.INVIATO;
        JSONObject inviata = CodaCaricamenti.aJsonPonte(v, 0L);
        assertEquals("una voce inviata ha inviato tutto, nel totale limitato", CodaCaricamenti.MAX_VIDEO_INPUT_BYTES, inviata.getLong("byteInviati"));
        assertEquals(CodaCaricamenti.MAX_VIDEO_INPUT_BYTES, inviata.getLong("byteTotali"));
        assertEquals("sotto il tetto non cambia niente", 5_000_001L, CodaCaricamenti.aJsonPonte(nuova(1), 0L).getLong("byteTotali"));
    }

    @Test
    public void ilTettoDiUnVideoEQuelloDelContratto() {
        assertEquals(2_000_000_000L, CodaCaricamenti.MAX_VIDEO_INPUT_BYTES);
    }

    @Test
    public void laCodaDiProduzioneERestituitaSempreLaStessaPerLaStessaCartella() throws Exception {
        File a = temporanea.newFolder("processo-a");
        CodaCaricamenti prima = CodaCaricamenti.perCartella(a, orologio::get);
        assertSame("la seconda chiamata restituisce LO STESSO oggetto: una sola istanza per processo", prima, CodaCaricamenti.perCartella(a, orologio::get));
        assertSame("anche se la cartella è scritta in un altro modo", prima, CodaCaricamenti.perCartella(new File(a, "../processo-a"), orologio::get));
        assertNotNull(CodaCaricamenti.perCartella(a, () -> 0L));
        File b = temporanea.newFolder("processo-b");
        assertTrue("un'altra cartella è un'altra coda", prima != CodaCaricamenti.perCartella(b, orologio::get));
        // E condividono lo stato: una voce aggiunta da una strada si vede dall'altra.
        prima.aggiungi(nuova(1));
        assertEquals(1, CodaCaricamenti.perCartella(a, orologio::get).numeroVoci());
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * COMPITO A2b: LA PULIZIA NON TOCCA CIÒ CHE IL DISCO NOMINA ANCORA (secondario n. 81 della PR 3)
     * ──────────────────────────────────────────────────────────────────────────── */

    /** Il disco di un telefono che smette di rinominare: una voce con copia e segreti, già `in-invio`, e la scrittura che da qui non riesce. */
    private static final class VoceSuDiscoRotto {
        final AtomicFileCheNonTrasloca disco;
        final CodaCaricamenti coda;
        final File copia;
        final File segreto;

        VoceSuDiscoRotto(CodaCaricamentiTest banco, int n) throws IOException {
            disco = new AtomicFileCheNonTrasloca(banco.codaJson(), true);
            coda = banco.codaSuUnDiscoCheSiPuoRompere(disco);
            coda.aggiungi(banco.nuova(n));
            coda.transita(id(n), EventoStato.AVVIATO, null);
            copia = banco.creaFile("file", id(n) + ".mp4", banco.orologio.get());
            segreto = coda.fileSegreto(id(n));
            segreto.getParentFile().mkdirs();
            assertTrue(segreto.createNewFile());
        }
    }

    @Test
    public void laPuliziaNonCancellaComeOrfaniCopiaESegretiDiUnaTerminaleNonArrivataSulDisco() throws Exception {
        VoceSuDiscoRotto v = new VoceSuDiscoRotto(this, 1);
        File orfanoVero = creaFile("file", id(77) + ".mp4", orologio.get());
        v.disco.traslocaDavvero = false;
        EsitoTransizione e = v.coda.transita(id(1), EventoStato.INVIATO, null);
        assertTrue(e.residuiRimasti);
        assertFalse("lo stato terminale non è sul disco", e.persistita);

        ReportPulizia r = v.coda.pulisci();

        assertTrue("sul disco la voce è ancora viva e nomina la copia: la pulizia non la tocca (n. 81)", v.copia.exists());
        assertTrue("e i segreti nemmeno", v.segreto.exists());
        assertFalse("un orfano VERO, invece, si toglie ancora", orfanoVero.exists());
        assertEquals("un solo orfano tolto, quello vero", 1, r.fileOrfani);
        assertEquals("nessun segreto tolto", 0, r.segreti);
        // Alla riapertura la voce è com'era: viva, col suo file, pronta a riprendere (la PUT ripetuta dà il duplicato che il rinnovo risolve).
        VoceCoda dopoIlRiavvio = apri().trova(id(1));
        assertSame(Stato.IN_INVIO, dopoIlRiavvio.stato);
        assertEquals("file/" + id(1) + ".mp4", dopoIlRiavvio.file);
    }

    @Test
    public void quandoIlDiscoTornaLaPuliziaScriveLoStatoTerminaleEPoiTogliCopiaESegreti() throws Exception {
        VoceSuDiscoRotto v = new VoceSuDiscoRotto(this, 1);
        v.disco.traslocaDavvero = false;
        v.coda.transita(id(1), EventoStato.INVIATO, null);
        v.coda.pulisci();
        assertTrue(v.copia.exists());

        v.disco.traslocaDavvero = true;                   // il disco «torna a dare i numeri»
        ReportPulizia r = v.coda.pulisci();

        assertSame("lo stato terminale è arrivato sul disco", Stato.INVIATO, apri().trova(id(1)).stato);
        assertNull(apri().trova(id(1)).file);
        assertFalse("e adesso la copia è davvero orfana: si toglie", v.copia.exists());
        assertFalse("anche i segreti", v.segreto.exists());
        assertEquals("e si toglie come un orfano qualunque, contato come tale", 1, r.fileOrfani);
        assertEquals(1, r.segreti);
        assertEquals("e la protezione è finita: una pulizia dopo non trova più niente da proteggere", 0, v.coda.pulisci().fileOrfani);
    }

    @Test
    public void unaPuliziaCheNonRiescePerLoStessoMotivoTieneProtettoESiRiprovaAlGiroDopo() throws Exception {
        VoceSuDiscoRotto v = new VoceSuDiscoRotto(this, 1);
        v.disco.traslocaDavvero = false;
        v.coda.transita(id(1), EventoStato.INVIATO, null);
        for (int giro = 0; giro < 3; giro++) {
            v.coda.pulisci();                             // il disco non c'è ancora: la pulizia riprova a scrivere, non riesce, e non tocca niente
            assertTrue("giro " + giro + ": la copia resta", v.copia.exists());
            assertTrue("giro " + giro + ": i segreti restano", v.segreto.exists());
        }
        v.disco.traslocaDavvero = true;
        v.coda.pulisci();
        assertFalse(v.copia.exists());
    }

    @Test
    public void riaccodareLoStessoJobDopoUnaTerminaleNonSalvataNonLasciaALaPuliziaLaCopiaNuova() throws Exception {
        VoceSuDiscoRotto v = new VoceSuDiscoRotto(this, 1);
        v.disco.traslocaDavvero = false;
        v.coda.transita(id(1), EventoStato.INVIATO, null);
        v.disco.traslocaDavvero = true;

        // L'insegnante rimanda lo stesso video agli stessi bambini: stesso job, preparato nuovo, segreti nuovi (come fa `accodaVideo`).
        File preparato = creaFile("scelti", "nuovo.mp4", orologio.get());
        RisultatoAggiunta r = v.coda.aggiungiSpostando(nuova(1), preparato);
        assertFalse(r.giaPresente);
        assertTrue("segreti nuovi per la voce nuova", v.segreto.exists() || v.segreto.createNewFile());

        ReportPulizia pulizia = v.coda.pulisci();

        assertEquals("la voce è viva: niente da togliere", 0, pulizia.fileOrfani);
        assertTrue("la copia nuova è al suo posto", new File(cartella, "file/" + id(1) + ".mp4").isFile());
        assertTrue("i segreti nuovi pure", v.segreto.exists());
        assertSame(Stato.IN_CODA, v.coda.trova(id(1)).stato);
    }

    @Test
    public void riaccodareLoStessoJobConUnaCopiaDiversaSostituisceLaProtezioneELaCopiaVecchiaNonRestaProtetta() throws Exception {
        VoceSuDiscoRotto v = new VoceSuDiscoRotto(this, 1);          // la copia della prima voce è file/<id>.mp4
        v.disco.traslocaDavvero = false;
        v.coda.transita(id(1), EventoStato.INVIATO, null);           // terminale non salvata: protegge la copia .mp4
        v.disco.traslocaDavvero = true;

        // Lo stesso video rimandato agli stessi bambini, ma preparato come `.mov`: stesso job, un'altra copia.
        VoceCoda comeMov = VoceCoda.nuova(id(1), id(1001), UTENTE, SCUOLA, "prova-1.mov", "file/" + id(1) + ".mov", 5_000_001L, "video/quicktime",
                Origine.GALLERIA, orologio.get() + 2 * ORA, orologio.get() + 2 * GIORNO);
        v.coda.aggiungiSpostando(comeMov, creaFile("scelti", "nuovo.mov", orologio.get()));
        v.disco.traslocaDavvero = false;                              // e il disco smette di nuovo di rinominare
        // Un cambiamento che non arriva sul disco: senza, la scrittura della pulizia «riuscirebbe» (riscriverebbe gli stessi byte già lì).
        v.coda.modifica(id(1), x -> x.tentativi = 1);

        v.coda.pulisci();

        assertFalse("la voce nuova è viva e il disco ha già lei (l'aggiunta è stata scritta): la vecchia copia .mp4 non è di nessuno e non resta protetta",
                v.copia.exists());
        assertTrue("la copia nuova resta", new File(cartella, "file/" + id(1) + ".mov").isFile());
        assertSame(Stato.IN_CODA, v.coda.trova(id(1)).stato);
    }

    @Test
    public void dimenticareUnaTerminaleNonSalvataTogliAncheLaCopiaCheProteggeva() throws Exception {
        VoceSuDiscoRotto v = new VoceSuDiscoRotto(this, 1);
        v.disco.traslocaDavvero = false;
        v.coda.transita(id(1), EventoStato.INVIATO, null);
        v.disco.traslocaDavvero = true;

        assertEquals(1, v.coda.dimentica(Arrays.asList(id(1))));

        assertEquals("la voce è sparita anche dal disco", 0, apri().numeroVoci());
        assertFalse("e con lei la copia che il disco nominava", v.copia.exists());
        assertFalse(v.segreto.exists());
    }

    @Test
    public void unaTerminaleNonSalvataNonSiTogliDallaCodaPerEtaFincheIlDiscoNonLaPrende() throws Exception {
        VoceSuDiscoRotto v = new VoceSuDiscoRotto(this, 1);
        v.disco.traslocaDavvero = false;
        v.coda.transita(id(1), EventoStato.INVIATO, null);
        orologio.addAndGet(8 * GIORNO);                   // oltre la ritenzione delle terminali (7 giorni)

        ReportPulizia r = v.coda.pulisci();

        assertEquals("nessuna voce tolta per età: sul disco è ancora viva", 0, r.vociTerminali);
        assertNotNull(v.coda.trova(id(1)));
        assertTrue(v.copia.exists());
    }

    @Test
    public void unaScritturaCheNonRiesceSiDiceInLogcatConLaSolaClasseDellErrore() throws Exception {
        final List<String> righe;
        try (RigheDiLogcat logcat = new RigheDiLogcat()) {
            VoceSuDiscoRotto v = new VoceSuDiscoRotto(this, 1);
            v.disco.traslocaDavvero = false;
            v.coda.transita(id(1), EventoStato.INVIATO, null);
            righe = new ArrayList<>(logcat.righe);
        }
        assertEquals(Arrays.asList("W KidvilleCaricamenti coda non scritta (IOException): lo stato resta in memoria"), righe);
        for (String riga : righe) assertFalse("nessun percorso in una riga di log: " + riga, riga.contains(cartella.getName()));
    }
}
