package it.kidville.app.caricamenti;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import it.kidville.app.caricamenti.CodaCaricamenti.Origine;
import it.kidville.app.caricamenti.SelettoreMedia.MotivoRifiuto;
import it.kidville.app.caricamenti.SelettoreMedia.Opzioni;
import it.kidville.app.caricamenti.SelettoreMedia.OpzioniNonValide;
import it.kidville.app.caricamenti.SelettoreMedia.Sorgente;
import it.kidville.app.caricamenti.SelettoreMedia.TipoElemento;

import org.json.JSONObject;
import org.junit.Test;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Le scelte pure del selettore dei media (spec §4.2, §4.3, §6.3; compito A3): le opzioni di `scegliMedia`, il tipo di un elemento dal
 * MIME e dal nome, lo spazio, i nomi, la forma esatta del JSON che il JavaScript rilegge con zod, e la parità dei vocabolari con il
 * contratto TypeScript. La preparazione vera (copia, impronta, rifiuti, annullamento) sta in `PreparazioneMediaTest`.
 */
public class SelettoreMediaTest {

    private static String leggiTs(String relativo) throws IOException {
        File cartella = new File("").getAbsoluteFile();
        for (int i = 0; i < 8 && cartella != null; i++) {
            File file = new File(cartella, relativo);
            if (file.isFile()) return new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
            cartella = cartella.getParentFile();
        }
        throw new AssertionError("non trovo " + relativo);
    }

    private static List<String> elencoTs(String sorgente, String nome) {
        Matcher m = Pattern.compile("(?:export\\s+)?const\\s+" + Pattern.quote(nome) + "\\s*=\\s*\\[(.*?)\\]", Pattern.DOTALL).matcher(sorgente);
        assertTrue("non trovo l'elenco " + nome, m.find());
        List<String> voci = new ArrayList<>();
        Matcher q = Pattern.compile("'([^']*)'").matcher(m.group(1).replaceAll("(?m)//.*$", ""));
        while (q.find()) voci.add(q.group(1));
        assertFalse("elenco vuoto: " + nome, voci.isEmpty());
        return voci;
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * LE OPZIONI
     * ──────────────────────────────────────────────────────────────────────────── */

    private static JSONObject opzioniGiuste() throws Exception {
        return new JSONObject("{\"sorgente\":\"galleria\",\"massimoElementi\":50,\"latoMassimoFoto\":1920,\"qualitaFoto\":0.85,"
                + "\"byteMassimiVideo\":2000000000,\"durataMassimaVideoSecondi\":300}");
    }

    @Test
    public void leOpzioniDelContrattoSiRileggono() throws Exception {
        Opzioni o = Opzioni.da(opzioniGiuste());
        assertEquals(Sorgente.GALLERIA, o.sorgente);
        assertEquals(50, o.massimoElementi);
        assertEquals(1920, o.latoMassimoFoto);
        assertEquals(0.85, o.qualitaFoto, 1e-9);
        assertEquals(2_000_000_000L, o.byteMassimiVideo);
        assertEquals(300, o.durataMassimaVideoSecondi);
        Opzioni file = Opzioni.da(opzioniGiuste().put("sorgente", "file"));
        assertEquals(Sorgente.FILE, file.sorgente);
    }

    private static void assertNonValide(JSONObject dati, String perche) {
        try {
            Opzioni.da(dati);
            fail("doveva rifiutare: " + perche);
        } catch (OpzioniNonValide atteso) {
            assertEquals("il messaggio è il solo codice", "PARAMETRI_NON_VALIDI", atteso.getMessage());
        }
    }

    @Test
    public void leOpzioniFuoriDaiLimitiDelContrattoSiRifiutano() throws Exception {
        assertNonValide(null, "assenti");
        assertNonValide(new JSONObject(), "vuote");
        for (String campo : new String[]{"sorgente", "massimoElementi", "latoMassimoFoto", "qualitaFoto", "byteMassimiVideo", "durataMassimaVideoSecondi"}) {
            JSONObject senza = opzioniGiuste();
            senza.remove(campo);
            assertNonValide(senza, "manca " + campo);
        }
        assertNonValide(opzioniGiuste().put("sorgente", "cloud"), "sorgente sconosciuta");
        assertNonValide(opzioniGiuste().put("sorgente", 1), "sorgente non testo");
        assertNonValide(opzioniGiuste().put("massimoElementi", 0), "zero elementi: PHPicker lo leggerebbe «senza limite»");
        assertNonValide(opzioniGiuste().put("massimoElementi", -3), "negativo");
        assertNonValide(opzioniGiuste().put("massimoElementi", 1001), "troppi");
        assertNonValide(opzioniGiuste().put("massimoElementi", 2.5), "non intero");
        assertNonValide(opzioniGiuste().put("massimoElementi", "50"), "testo al posto di un numero");
        assertNonValide(opzioniGiuste().put("latoMassimoFoto", 0), "lato zero");
        assertNonValide(opzioniGiuste().put("latoMassimoFoto", 1921), "oltre il contratto");
        assertNonValide(opzioniGiuste().put("qualitaFoto", 0), "qualità zero");
        assertNonValide(opzioniGiuste().put("qualitaFoto", 1.01), "qualità oltre 1");
        assertNonValide(opzioniGiuste().put("qualitaFoto", -0.5), "qualità negativa");
        assertNonValide(opzioniGiuste().put("qualitaFoto", "0.85"), "qualità testo");
        assertNonValide(opzioniGiuste().put("byteMassimiVideo", 0), "peso zero");
        assertNonValide(opzioniGiuste().put("byteMassimiVideo", 2_000_000_001L), "peso oltre i 2 GB");
        assertNonValide(opzioniGiuste().put("durataMassimaVideoSecondi", 0), "durata zero");
        assertNonValide(opzioniGiuste().put("durataMassimaVideoSecondi", 301), "durata oltre i 5 minuti");
        assertNonValide(opzioniGiuste().put("durataMassimaVideoSecondi", 300.5), "durata non intera");
        assertNonValide(opzioniGiuste().put("qualitaFoto", JSONObject.NULL), "qualità null");
    }

    @Test
    public void ilPrimoPostoEIlMassimoVengonoAccettati() throws Exception {
        assertEquals(1, Opzioni.da(opzioniGiuste().put("massimoElementi", 1)).massimoElementi);
        assertEquals(1000, Opzioni.da(opzioniGiuste().put("massimoElementi", 1000)).massimoElementi);
        assertEquals(1, Opzioni.da(opzioniGiuste().put("latoMassimoFoto", 1)).latoMassimoFoto);
        assertEquals(1.0, Opzioni.da(opzioniGiuste().put("qualitaFoto", 1)).qualitaFoto, 1e-9);
        assertEquals(1L, Opzioni.da(opzioniGiuste().put("byteMassimiVideo", 1)).byteMassimiVideo);
        assertEquals(1, Opzioni.da(opzioniGiuste().put("durataMassimaVideoSecondi", 1)).durataMassimaVideoSecondi);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL TIPO DI UN ELEMENTO
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void unTipoMimePrecisoDecideDaSolo() {
        assertEquals(TipoElemento.FOTO, SelettoreMedia.classifica("image/jpeg", "x.mp4"));
        assertEquals(TipoElemento.FOTO, SelettoreMedia.classifica("image/heic", null));
        assertEquals(TipoElemento.VIDEO, SelettoreMedia.classifica("video/mp4", "x.jpg"));
        assertEquals(TipoElemento.VIDEO, SelettoreMedia.classifica("video/quicktime", null));
        assertEquals("anche con parametri e maiuscole", TipoElemento.VIDEO, SelettoreMedia.classifica("Video/MP4; codecs=avc1", null));
        assertEquals(TipoElemento.ALTRO, SelettoreMedia.classifica("application/pdf", "documento.jpg"));
        assertEquals(TipoElemento.ALTRO, SelettoreMedia.classifica("audio/mpeg", "x.mp4"));
        assertEquals(TipoElemento.ALTRO, SelettoreMedia.classifica("text/plain", null));
    }

    @Test
    public void unTipoMancanteOGenericoSiDecideDallEstensione() {
        assertEquals(TipoElemento.VIDEO, SelettoreMedia.classifica(null, "VID_2026.MP4"));
        assertEquals(TipoElemento.VIDEO, SelettoreMedia.classifica("application/octet-stream", "filmato.mov"));
        assertEquals(TipoElemento.VIDEO, SelettoreMedia.classifica("binary/octet-stream", "a.mkv"));
        assertEquals(TipoElemento.VIDEO, SelettoreMedia.classifica("", "a.3gp"));
        assertEquals(TipoElemento.FOTO, SelettoreMedia.classifica("application/octet-stream", "IMG.HEIC"));
        assertEquals(TipoElemento.FOTO, SelettoreMedia.classifica(null, "a.webp"));
        assertEquals("né il tipo né l'estensione dicono niente", TipoElemento.ALTRO, SelettoreMedia.classifica("application/octet-stream", "dati.bin"));
        assertEquals(TipoElemento.ALTRO, SelettoreMedia.classifica(null, null));
        assertEquals(TipoElemento.ALTRO, SelettoreMedia.classifica(null, "senzaestensione"));
        assertEquals(TipoElemento.ALTRO, SelettoreMedia.classifica(null, "finisceconpunto."));
    }

    @Test
    public void ilMimeDelVideoEIlSuoQuandoEUnVideoAltrimentiQuelloDellEstensioneAltrimentiMp4() {
        assertEquals("video/quicktime", SelettoreMedia.mimeDelVideo("video/quicktime", "x.mp4"));
        assertEquals("video/mp4", SelettoreMedia.mimeDelVideo("Video/MP4; codecs=avc1", null));
        assertEquals("video/quicktime", SelettoreMedia.mimeDelVideo("application/octet-stream", "filmato.MOV"));
        assertEquals("video/x-matroska", SelettoreMedia.mimeDelVideo(null, "a.mkv"));
        assertEquals("video/mp4", SelettoreMedia.mimeDelVideo(null, null));
        assertEquals("un'immagine non è un MIME da video", "video/mp4", SelettoreMedia.mimeDelVideo("image/jpeg", "x.jpg"));
        assertEquals("video/mp4", SelettoreMedia.mimeDelVideo("video/", "x.dat"));
    }

    @Test
    public void ilMimeDelVideoPassaSempreLoSchemaDelServer() {
        // La stessa espressione di MIME_DICHIARABILE (contratto.ts): ciò che il nativo dichiara all'apertura passa dal server.
        Pattern server = Pattern.compile("^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}(?:\\s*;[^\\n]*)?$", Pattern.CASE_INSENSITIVE);
        for (String mime : new String[]{"video/mp4", "video/quicktime", "video/3gpp", "video/3gpp2", "video/webm", "video/x-matroska", "video/x-msvideo",
                "video/x-m4v", "video/mpeg", "video/mp2t", "video/x-ms-wmv", "video/x-flv", "video/ogg"}) {
            String scelto = SelettoreMedia.mimeDelVideo(mime, null);
            assertEquals(mime, scelto);
            assertTrue(scelto, server.matcher(scelto).matches());
        }
        for (String ripiego : new String[]{null, "", "x", "image/png", "video", "application/octet-stream"}) {
            assertTrue(String.valueOf(ripiego), server.matcher(SelettoreMedia.mimeDelVideo(ripiego, null)).matches());
        }
    }

    @Test
    public void l_estensioneDellaCopiaVieneDalMimeOppureDalNomeOppureEMp4() {
        assertEquals("mp4", SelettoreMedia.estensioneDelVideo("video/mp4", "x.mov"));
        assertEquals("mov", SelettoreMedia.estensioneDelVideo("video/quicktime", null));
        assertEquals("3gp", SelettoreMedia.estensioneDelVideo("video/3gpp", null));
        assertEquals("mkv", SelettoreMedia.estensioneDelVideo("video/x-matroska", "a.dat"));
        assertEquals("dal nome, quando il MIME non si conosce", "avi", SelettoreMedia.estensioneDelVideo("video/boh", "a.AVI"));
        assertEquals("mp4", SelettoreMedia.estensioneDelVideo(null, null));
        assertEquals("un'estensione troppo lunga non è un'estensione", "mp4", SelettoreMedia.estensioneDelVideo(null, "a.estensionelunga"));
        assertEquals("né con simboli", "mp4", SelettoreMedia.estensioneDelVideo(null, "a.m/p4"));
        assertEquals("né il percorso di un altro file", "mp4", SelettoreMedia.estensioneDelVideo(null, "../../etc/passwd"));
        Pattern valida = Pattern.compile("^[a-z0-9]{1,5}$");
        for (String nome : new String[]{"a.mp4", "A.MOV", "../x.y", "a.b.c", "x.", ".", "..", "a.verylongext", "a.é", "a. mp4"}) {
            assertTrue(nome, valida.matcher(SelettoreMedia.estensioneDelVideo(null, nome)).matches());
        }
    }

    @Test
    public void ilNomeDaMostrareHaIlRipiegoESiTagliaA255() {
        assertEquals("Video", SelettoreMedia.nomeDaMostrare(null, "Video"));
        assertEquals("Foto", SelettoreMedia.nomeDaMostrare("", "Foto"));
        assertEquals("File", SelettoreMedia.nomeDaMostrare("   ", "File"));
        assertEquals("VID_1.mp4", SelettoreMedia.nomeDaMostrare("  VID_1.mp4 ", "Video"));
        StringBuilder lungo = new StringBuilder();
        for (int i = 0; i < 300; i++) lungo.append('a');
        assertEquals(255, SelettoreMedia.nomeDaMostrare(lungo.toString(), "Video").length());
        // Non si spezza una coppia surrogata (un emoji): una metà sola sarebbe una stringa che il JavaScript non sa leggere.
        StringBuilder conEmoji = new StringBuilder();
        for (int i = 0; i < 254; i++) conEmoji.append('a');
        conEmoji.append("😀😀");
        String tagliato = SelettoreMedia.nomeDaMostrare(conEmoji.toString(), "Video");
        assertTrue(tagliato.length() <= 255);
        assertFalse(Character.isHighSurrogate(tagliato.charAt(tagliato.length() - 1)));
    }

    @Test
    public void unaFotoPerdeLEstensioneDelNomeMaUnNomeFattoSoloDiEstensioneResta() {
        assertEquals("IMG_1", SelettoreMedia.senzaEstensione("IMG_1.HEIC"));
        assertEquals("a.b", SelettoreMedia.senzaEstensione("a.b.jpg"));
        assertEquals("senza", SelettoreMedia.senzaEstensione("senza"));
        assertEquals(".jpg", SelettoreMedia.senzaEstensione(".jpg"));
        assertEquals("a.estensionelunga", SelettoreMedia.senzaEstensione("a.estensionelunga"));
        assertNull(SelettoreMedia.senzaEstensione(null));
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * LO SPAZIO
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void loSpazioDeveSuperareIlPesoDiAlmeno200Mb() {
        long mb = 1024L * 1024L;
        assertEquals(200L * mb, SelettoreMedia.MARGINE_SPAZIO_BYTE);
        assertTrue(SelettoreMedia.spazioSufficiente(1000 * mb + 200 * mb, 1000 * mb));
        assertFalse("un byte in meno basta a rifiutare", SelettoreMedia.spazioSufficiente(1000 * mb + 200 * mb - 1, 1000 * mb));
        assertFalse(SelettoreMedia.spazioSufficiente(0, 1));
        assertTrue("un peso ignoto conta zero: il margine vale comunque", SelettoreMedia.spazioSufficiente(200 * mb, -1));
        assertFalse(SelettoreMedia.spazioSufficiente(200 * mb - 1, -1));
        assertTrue(SelettoreMedia.spazioSufficiente(Long.MAX_VALUE, 2_000_000_000L));
        assertFalse("il peso più il margine non trabocca", SelettoreMedia.spazioSufficiente(Long.MAX_VALUE, Long.MAX_VALUE));
    }

    @Test
    public void ilPhotoPickerNonRiceveUnMassimoSopraIlLimiteDelSistema() {
        assertEquals(50, SelettoreMedia.tettoDelSelettore(50, 100));
        assertEquals(100, SelettoreMedia.tettoDelSelettore(150, 100));
        assertEquals(1, SelettoreMedia.tettoDelSelettore(1, 100));
        // Prima di API 33 il limite non si può leggere dal sistema: il tetto è quello fisso di 100, così 1000 elementi non fanno lanciare androidx.
        assertEquals(100, SelettoreMedia.LIMITE_SELETTORE_PRIMA_DI_API_33);
        assertEquals(100, SelettoreMedia.tettoDelSelettore(1000, SelettoreMedia.LIMITE_SELETTORE_PRIMA_DI_API_33));
        assertEquals(50, SelettoreMedia.tettoDelSelettore(50, SelettoreMedia.LIMITE_SELETTORE_PRIMA_DI_API_33));
    }

    @Test
    public void unaSceltaAbbandonataESoloUnaSceltaFermaAlSelettoreDaPiuDiUnQuartoDora() {
        long quartoDora = 15L * 60L * 1000L;
        assertEquals(quartoDora, SelettoreMedia.ATTESA_MASSIMA_SELETTORE_MS);
        assertFalse(SelettoreMedia.sceltaAbbandonata(false, quartoDora));
        assertTrue(SelettoreMedia.sceltaAbbandonata(false, quartoDora + 1));
        assertFalse("una copia da 2 GB può durare minuti: mai abbandonata", SelettoreMedia.sceltaAbbandonata(true, quartoDora * 100));
        assertFalse(SelettoreMedia.sceltaAbbandonata(false, 0));
    }

    @Test
    public void lOrigineSiRicavaDalPrefissoDellIdElemento() {
        assertEquals(Origine.GALLERIA, SelettoreMedia.origineDaId("g-3b0a2a6e-1111-4111-8111-000000000001"));
        assertEquals(Origine.FILE, SelettoreMedia.origineDaId("f-3b0a2a6e-1111-4111-8111-000000000001"));
        assertEquals(Origine.PROVA, SelettoreMedia.origineDaId("p-3b0a2a6e-1111-4111-8111-000000000001"));
        assertEquals(Origine.GALLERIA, SelettoreMedia.origineDaId("senzaprefisso"));
        assertEquals(Origine.GALLERIA, SelettoreMedia.origineDaId(null));
        assertEquals(Sorgente.GALLERIA.origine, Origine.GALLERIA);
        assertEquals(Sorgente.FILE.origine, Origine.FILE);
    }

    @Test
    public void gliIdDegliElementiHannoLaFormaDelContrattoESiDistinguono() {
        Pattern forma = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"); // schemaIdElemento di caricamenti-nativi-tipi.ts
        Set<String> visti = new HashSet<>();
        for (Sorgente s : Sorgente.values()) {
            for (int i = 0; i < 50; i++) {
                String id = SelettoreMedia.nuovoId(s.prefissoId);
                assertTrue(id, forma.matcher(id).matches());
                assertTrue(id, id.startsWith(s.prefissoId + "-"));
                assertEquals(SelettoreMedia.origineDaId(id), s.origine);
                assertTrue("id doppio: " + id, visti.add(id));
                assertTrue("lo schema di SelettoreMedia è lo stesso del contratto", SelettoreMedia.FORMA_ID.matcher(id).matches());
            }
        }
        assertTrue(SelettoreMedia.nuovoId("p").startsWith("p-"));
        for (String no : new String[]{"", ".", "..", "a/b", "a.b", "-a", "a b", "../x", "a\\b"}) {
            assertFalse("«" + no + "» non è un id", SelettoreMedia.FORMA_ID.matcher(no).matches());
        }
    }

    @Test
    public void l_esadecimaleEMinuscoloECompleto() {
        assertEquals("00ff10ab", SelettoreMedia.esadecimale(new byte[]{0, (byte) 0xFF, 0x10, (byte) 0xAB}));
        assertEquals("", SelettoreMedia.esadecimale(new byte[0]));
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * LA FORMA DEL JSON (ogni campo che manca è un rifiuto di zod; ogni `null` va scritto con JSONObject.NULL)
     * ──────────────────────────────────────────────────────────────────────────── */

    private static Set<String> chiavi(JSONObject json) {
        Set<String> k = new HashSet<>();
        java.util.Iterator<String> it = json.keys();
        while (it.hasNext()) k.add(it.next());
        return k;
    }

    @Test
    public void unaFotoHaEsattamenteICampiDelContratto() throws Exception {
        JSONObject json = SelettoreMedia.jsonFoto("g-1", "IMG", 1920, 1440, 345_678L);
        assertEquals(new HashSet<>(Arrays.asList("id", "tipo", "nome", "larghezza", "altezza", "byte")), chiavi(json));
        assertEquals("foto", json.getString("tipo"));
        assertEquals(1920, json.getInt("larghezza"));
        assertEquals(1440, json.getInt("altezza"));
        assertEquals(345_678L, json.getLong("byte"));
    }

    @Test
    public void unVideoHaEsattamenteICampiDelContrattoEIPropriNullSonoNullVeri() throws Exception {
        JSONObject json = SelettoreMedia.jsonVideo("g-2", "VID", 5_000_000L, "video/mp4", 12_500L, "data:image/jpeg;base64,AAAA", "ab".repeat(32));
        assertEquals(new HashSet<>(Arrays.asList("id", "tipo", "nome", "byte", "mime", "durataSecondi", "miniatura", "sha256")), chiavi(json));
        assertEquals("video", json.getString("tipo"));
        assertEquals(12.5, json.getDouble("durataSecondi"), 1e-9);
        assertEquals("data:image/jpeg;base64,AAAA", json.getString("miniatura"));

        for (long durataIgnota : new long[]{-1L, 0L}) {
            JSONObject senza = SelettoreMedia.jsonVideo("g-3", "VID", 10L, "video/mp4", durataIgnota, null, "cd".repeat(32));
            assertTrue("la chiave durataSecondi c'è: se mancasse zod rifiuterebbe l'elemento", senza.has("durataSecondi"));
            assertTrue("e vale null, non zero", senza.isNull("durataSecondi"));
            assertTrue(senza.has("miniatura"));
            assertTrue(senza.isNull("miniatura"));
            assertEquals(JSONObject.NULL, senza.get("miniatura"));
        }
    }

    @Test
    public void unRifiutatoHaIlMotivoEL_origine() throws Exception {
        JSONObject json = SelettoreMedia.jsonRifiutato("f-4", "grande.mp4", TipoElemento.VIDEO, MotivoRifiuto.TROPPO_GRANDE);
        assertEquals(new HashSet<>(Arrays.asList("id", "tipo", "nome", "origine", "motivo")), chiavi(json));
        assertEquals("rifiutato", json.getString("tipo"));
        assertEquals("video", json.getString("origine"));
        assertEquals("troppo-grande", json.getString("motivo"));
    }

    @Test
    public void unaFotoLettaPortaIlBase64IlMimeEIByteDichiarati() throws Exception {
        JSONObject json = SelettoreMedia.jsonFotoLetta("AQID", 3L, 10, 20);
        assertEquals(new HashSet<>(Arrays.asList("base64", "mime", "byte", "larghezza", "altezza")), chiavi(json));
        assertEquals("image/jpeg", json.getString("mime"));
        assertEquals(3L, json.getLong("byte"));
    }

    @Test
    public void l_eventoDiPreparazioneHaIQuattroCampiEIlTotaleIgnotoENull() throws Exception {
        JSONObject json = SelettoreMedia.jsonPreparazione(1, 5, 1000L, 50_000L);
        assertEquals(new HashSet<>(Arrays.asList("fatti", "totali", "byteCopiati", "byteTotali")), chiavi(json));
        assertEquals(50_000L, json.getLong("byteTotali"));
        JSONObject ignoto = SelettoreMedia.jsonPreparazione(0, 5, 0L, -1L);
        assertTrue("la chiave c'è", ignoto.has("byteTotali"));
        assertTrue("e vale null", ignoto.isNull("byteTotali"));
    }

    @Test
    public void unEsitoAnnullatoNonPortaMaiElementi() throws Exception {
        JSONObject annullato = SelettoreMedia.Esito.annullato().aJson();
        assertTrue(annullato.getBoolean("annullato"));
        assertEquals(0, annullato.getJSONArray("elementi").length());
        // Nemmeno costruendolo a mano con elementi: «annullato» li esclude (un elemento consegnato con un annullamento sarebbe una copia che
        // nessuno scarterà mai).
        List<JSONObject> uno = new ArrayList<>();
        uno.add(SelettoreMedia.jsonFoto("g-1", "x", 1, 1, 1L));
        assertEquals(0, new SelettoreMedia.Esito(true, uno).aJson().getJSONArray("elementi").length());
        JSONObject normale = new SelettoreMedia.Esito(false, uno).aJson();
        assertFalse(normale.getBoolean("annullato"));
        assertEquals(1, normale.getJSONArray("elementi").length());
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * LA PARITÀ COL CONTRATTO TYPESCRIPT
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void imotiviDiRifiutoDiAndroidSonoUnSottoinsiemeDiQuelliDelContrattoEManca_soloQuelloDiICloud() throws Exception {
        List<String> contratto = elencoTs(leggiTs("src/lib/native/caricamenti-nativi-tipi.ts"), "MOTIVI_RIFIUTO");
        Set<String> nostri = new HashSet<>();
        for (MotivoRifiuto m : MotivoRifiuto.values()) nostri.add(m.valore);
        assertTrue("ogni motivo di Android è nel contratto: " + nostri, contratto.containsAll(nostri));
        Set<String> mancanti = new HashSet<>(contratto);
        mancanti.removeAll(nostri);
        assertEquals("l'unico motivo che Android non produce è quello di iCloud", new HashSet<>(Arrays.asList("icloud-non-disponibile")), mancanti);
    }

    @Test
    public void leSorgentiEiTipiDiElementoSonoQuelliDelContratto() throws Exception {
        String ts = leggiTs("src/lib/native/caricamenti-nativi-tipi.ts");
        List<String> sorgenti = elencoTs(ts, "SORGENTI_SCELTA");
        Set<String> nostre = new HashSet<>();
        for (Sorgente s : Sorgente.values()) nostre.add(s.valore);
        assertEquals(new HashSet<>(sorgenti), nostre);
        // L'`origine` di un rifiutato: 'foto' | 'video' | 'altro'.
        Matcher origini = Pattern.compile("origine: z\\.enum\\(\\['foto', 'video', 'altro'\\]\\)").matcher(ts);
        assertTrue("l'enumerazione delle origini nel contratto è cambiata", origini.find());
        Set<String> tipi = new HashSet<>();
        for (TipoElemento t : TipoElemento.values()) tipi.add(t.valore);
        assertEquals(new HashSet<>(Arrays.asList("foto", "video", "altro")), tipi);
    }

    @Test
    public void iTettiDelContrattoSonoQuelliDelNativo() throws Exception {
        String ts = leggiTs("src/lib/native/caricamenti-nativi-tipi.ts");
        Matcher lato = Pattern.compile("export const LATO_MASSIMO_FOTO = (\\d+)").matcher(ts);
        assertTrue(lato.find());
        assertEquals(Integer.parseInt(lato.group(1)), SelettoreMedia.LATO_MASSIMO_FOTO);
        Matcher durata = Pattern.compile("export const MAX_VIDEO_DURATION_SECONDS = (\\d+)").matcher(leggiTs("src/lib/media/video/limiti.ts"));
        assertTrue(durata.find());
        assertEquals(Integer.parseInt(durata.group(1)), SelettoreMedia.DURATA_MASSIMA_VIDEO_SECONDI);
        // Il tetto di elementi del JavaScript (50) sta sotto quello che il nativo accetta.
        Matcher elementi = Pattern.compile("export const MAX_ELEMENTI_PER_SCELTA = (\\d+)").matcher(leggiTs("src/lib/gallery/selettore-media.ts"));
        assertTrue(elementi.find());
        assertTrue(Integer.parseInt(elementi.group(1)) <= SelettoreMedia.MASSIMO_ELEMENTI_ACCETTATO);
    }

    @Test
    public void ilSelettoreDiFileChiedeSoloVideoEImmagini() {
        assertEquals(Arrays.asList("video/*", "image/*"), Arrays.asList(SelettoreMedia.MIME_DEL_SELETTORE_FILE));
    }

    @Test
    public void unaSorgenteSconosciutaNonSiRiconosce() {
        assertEquals(Sorgente.GALLERIA, Sorgente.daValore("galleria"));
        assertEquals(Sorgente.FILE, Sorgente.daValore("file"));
        assertNull(Sorgente.daValore("Galleria"));
        assertNull(Sorgente.daValore(""));
        assertNull(Sorgente.daValore(null));
        assertNotEquals(Sorgente.GALLERIA.prefissoId, Sorgente.FILE.prefissoId);
    }
}
