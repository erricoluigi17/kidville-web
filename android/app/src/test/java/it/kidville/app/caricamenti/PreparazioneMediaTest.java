package it.kidville.app.caricamenti;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import it.kidville.app.caricamenti.CodaCaricamenti.Origine;
import it.kidville.app.caricamenti.ElaborazioneFoto.FotoRifiutata;
import it.kidville.app.caricamenti.ElaborazioneFoto.Rifiuto;
import it.kidville.app.caricamenti.FintiDelSelettore.FlussoGenerato;
import it.kidville.app.caricamenti.FintiDelSelettore.RaccoltaEventi;
import it.kidville.app.caricamenti.FintiDelSelettore.SorgenteDiProva;
import it.kidville.app.caricamenti.FintiDelSelettore.StrumentiDiProva;
import it.kidville.app.caricamenti.RegistroNativo.ClasseErrore;
import it.kidville.app.caricamenti.SelettoreMedia.Cancellazione;
import it.kidville.app.caricamenti.SelettoreMedia.ElementoAssente;
import it.kidville.app.caricamenti.SelettoreMedia.ElementoSorgente;
import it.kidville.app.caricamenti.SelettoreMedia.Esito;
import it.kidville.app.caricamenti.SelettoreMedia.Opzioni;
import it.kidville.app.caricamenti.SelettoreMedia.Preparati;
import it.kidville.app.caricamenti.SelettoreMedia.Preparato;
import it.kidville.app.caricamenti.SelettoreMedia.Sorgente;
import it.kidville.app.caricamenti.SelettoreMedia.TipoElemento;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.regex.Pattern;

/**
 * La preparazione di una scelta (spec §4.3 `scegliMedia`, §6.3; compito A3): ciò che il selettore fa con gli elementi che l'insegnante ha
 * scelto. La copia, l'impronta SHA-256, i file in `scelti/` e il registro sono codice vero su una cartella temporanea; l'elemento scelto, lo
 * spazio, l'orologio e la riduzione delle foto sono i finti di `FintiDelSelettore`.
 *
 * Ogni rifiuto si prova con DUE condizioni: il motivo giusto, e «zero byte copiati, nessun file rimasto» (un rifiuto che costa una copia da
 * 2 GB non è un rifiuto).
 */
public class PreparazioneMediaTest {

    @Rule
    public TemporaryFolder temporanea = new TemporaryFolder();

    private File scelti;
    private Preparati registro;
    private StrumentiDiProva mondo;
    private RaccoltaEventi eventi;
    private Cancellazione cancellazione;

    @Before
    public void preparaIlBanco() throws IOException {
        scelti = temporanea.newFolder("caricamenti", "scelti");
        registro = new Preparati();
        mondo = new StrumentiDiProva();
        eventi = new RaccoltaEventi();
        cancellazione = new Cancellazione();
    }

    private static Opzioni opzioni() {
        return new Opzioni(Sorgente.GALLERIA, 50, 1920, 0.85, 2_000_000_000L, 300);
    }

    private Esito prepara(Opzioni o, ElementoSorgente... sorgenti) {
        return new SelettoreMedia.Preparazione(scelti, registro, mondo, o, cancellazione, eventi).esegui(Arrays.asList(sorgenti));
    }

    private Esito prepara(ElementoSorgente... sorgenti) {
        return prepara(opzioni(), sorgenti);
    }

    private String[] fileInScelti() {
        String[] nomi = scelti.list();
        if (nomi == null) return new String[0];
        Arrays.sort(nomi);
        return nomi;
    }

    private static SorgenteDiProva video(String nome, byte[] contenuto) {
        return new SorgenteDiProva(nome, "video/mp4", contenuto);
    }

    private static JSONObject unico(Esito esito) {
        assertFalse(esito.annullato);
        assertEquals(1, esito.elementi.size());
        return esito.elementi.get(0);
    }

    private static void assertRifiuto(JSONObject json, String origine, String motivo) throws Exception {
        assertEquals("rifiutato", json.getString("tipo"));
        assertEquals(origine, json.getString("origine"));
        assertEquals(motivo, json.getString("motivo"));
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * UN VIDEO ENTRA
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void unVideoVieneCopiatoConLImprontaGiustaEDiventaUnElementoDelContratto() throws Exception {
        byte[] contenuto = FintiDelSelettore.casuali(3 * 1024 * 1024 + 17, 1);
        mondo.analisi = new MiniaturaVideo.Analisi(12_500L, "data:image/jpeg;base64,QUJD");
        JSONObject e = unico(prepara(video("VID_20261003.mp4", contenuto).conDurata(12_500L)));

        assertEquals("video", e.getString("tipo"));
        String id = e.getString("id");
        assertTrue(id, Pattern.compile("^g-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").matcher(id).matches());
        assertEquals("VID_20261003.mp4", e.getString("nome"));
        assertEquals(contenuto.length, e.getLong("byte"));
        assertEquals("video/mp4", e.getString("mime"));
        assertEquals(12.5, e.getDouble("durataSecondi"), 1e-9);
        assertEquals("data:image/jpeg;base64,QUJD", e.getString("miniatura"));
        // L'impronta è quella dei byte che PARTIRANNO: la ricalcola il test dal file, non dal codice sotto prova.
        File copia = new File(scelti, id + ".mp4");
        assertTrue("la copia sta in scelti/<id>.<estensione>", copia.isFile());
        assertArrayEquals(contenuto, Files.readAllBytes(copia.toPath()));
        assertEquals(FintiDelSelettore.sha256(contenuto), e.getString("sha256"));
        assertTrue(Pattern.compile("^[0-9a-f]{64}$").matcher(e.getString("sha256")).matches());
        assertArrayEquals("nient'altro in scelti/", new String[]{id + ".mp4"}, fileInScelti());

        Preparato p = registro.trova(id);
        assertNotNull(p);
        assertEquals(TipoElemento.VIDEO, p.tipo);
        assertEquals(contenuto.length, p.byteTotali);
        assertEquals(e.getString("sha256"), p.sha256);
        assertEquals(Origine.GALLERIA, p.origine);
        assertEquals(copia, p.file);
    }

    @Test
    public void conSorgenteFileGliIdELOrigineSonoDiFile() throws Exception {
        byte[] contenuto = FintiDelSelettore.casuali(2000, 2);
        JSONObject e = unico(prepara(new Opzioni(Sorgente.FILE, 50, 1920, 0.85, 2_000_000_000L, 300), video("a.mp4", contenuto)));
        assertTrue(e.getString("id").startsWith("f-"));
        assertEquals(Origine.FILE, registro.trova(e.getString("id")).origine);
    }

    @Test
    public void durataEMiniaturaIgnoteSonoNullVeriENonZeroOStringheVuote() throws Exception {
        mondo.analisi = MiniaturaVideo.Analisi.SCONOSCIUTA;
        JSONObject e = unico(prepara(video("v.mp4", FintiDelSelettore.casuali(1000, 3))));
        assertTrue(e.has("durataSecondi"));
        assertTrue("durata ignota: null", e.isNull("durataSecondi"));
        assertTrue(e.has("miniatura"));
        assertTrue("nessuna miniatura: null", e.isNull("miniatura"));
    }

    @Test
    public void laDurataSiPrendeDallaCopiaQuandoPrimaNonSiSapeva() throws Exception {
        mondo.analisi = new MiniaturaVideo.Analisi(7_000L, null);
        JSONObject e = unico(prepara(video("v.mp4", FintiDelSelettore.casuali(1000, 4)))); // durataMs() = -1: ignota in partenza
        assertEquals(7.0, e.getDouble("durataSecondi"), 1e-9);
    }

    @Test
    public void ilNomeMancanteHaIlRipiegoPerTipoEIlNomeLungoSiTaglia() throws Exception {
        byte[] foto = CodecDiProva.jpegGiocattolo(CodecDiProva.quadranti(40, 30), 0);
        Esito esito = prepara(video(null, FintiDelSelettore.casuali(500, 5)),
                new SorgenteDiProva(null, "image/jpeg", foto),
                new SorgenteDiProva(null, "application/pdf", new byte[10]));
        assertEquals("Video", esito.elementi.get(0).getString("nome"));
        assertEquals("Foto", esito.elementi.get(1).getString("nome"));
        assertEquals("File", esito.elementi.get(2).getString("nome"));
        StringBuilder lungo = new StringBuilder();
        for (int i = 0; i < 400; i++) lungo.append('x');
        JSONObject e = unico(prepara(video(lungo + ".mp4", FintiDelSelettore.casuali(500, 6))));
        assertEquals(255, e.getString("nome").length());
    }

    @Test
    public void gliElementiTornanoNellOrdineDellaScelta() throws Exception {
        List<String> nomi = new ArrayList<>();
        List<ElementoSorgente> sorgenti = new ArrayList<>();
        for (int i = 0; i < 6; i++) {
            nomi.add("video-" + i + ".mp4");
            sorgenti.add(video(nomi.get(i), FintiDelSelettore.casuali(100 + i, 10 + i)));
        }
        Esito esito = new SelettoreMedia.Preparazione(scelti, registro, mondo, opzioni(), cancellazione, eventi).esegui(sorgenti);
        List<String> visti = new ArrayList<>();
        for (JSONObject e : esito.elementi) visti.add(e.getString("nome"));
        assertEquals(nomi, visti);
        assertEquals(6, registro.numero());
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * UN VIDEO NON ENTRA — e non costa un byte copiato
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void unVideoSopraIDueGbSiRifiutaPrimaDiCopiare() throws Exception {
        SorgenteDiProva grande = video("enorme.mp4", new byte[10]).dichiara(2_000_000_001L);
        JSONObject e = unico(prepara(grande));
        assertRifiuto(e, "video", "troppo-grande");
        assertEquals("nemmeno aperto: zero byte copiati", 0, grande.aperture);
        assertArrayEquals(new String[0], fileInScelti());
        assertEquals(0, registro.numero());
        assertEquals("il nome si mostra", "enorme.mp4", e.getString("nome"));
    }

    @Test
    public void ilPesoEsattamenteAlLimiteEntra() throws Exception {
        Opzioni stretta = new Opzioni(Sorgente.GALLERIA, 50, 1920, 0.85, 4096L, 300);
        JSONObject dentro = unico(prepara(stretta, video("a.mp4", new byte[4096])));
        assertEquals("video", dentro.getString("tipo"));
        JSONObject fuori = unico(prepara(stretta, video("b.mp4", new byte[4097])));
        assertRifiuto(fuori, "video", "troppo-grande");
    }

    @Test
    public void unVideoPiuLungoDiCinqueMinutiSiRifiutaMaTrecentoSecondiEsattiEntra() throws Exception {
        SorgenteDiProva limite = video("a.mp4", FintiDelSelettore.casuali(1000, 20)).conDurata(300_000L);
        assertEquals("300 s esatti: entra (si rifiuta SOPRA i 300)", "video", unico(prepara(limite)).getString("tipo"));
        SorgenteDiProva oltre = video("b.mp4", FintiDelSelettore.casuali(1000, 21)).conDurata(300_001L);
        JSONObject e = unico(prepara(oltre));
        assertRifiuto(e, "video", "troppo-lungo");
        assertEquals("rifiutato prima della copia", 0, oltre.aperture);
        assertEquals(1, registro.numero());
        assertEquals(1, fileInScelti().length);
    }

    @Test
    public void unVideoTroppoLungoEAncheTroppoGrandeDiceTroppoGrande() throws Exception {
        SorgenteDiProva entrambi = video("c.mp4", new byte[10]).dichiara(3_000_000_000L).conDurata(900_000L);
        assertRifiuto(unico(prepara(entrambi)), "video", "troppo-grande");
    }

    @Test
    public void loSpazioInsufficienteSiRifiutaPrimaDiCopiareConIlMargineDi200Mb() throws Exception {
        long peso = 5000L;
        mondo.spazio = peso + SelettoreMedia.MARGINE_SPAZIO_BYTE - 1;
        SorgenteDiProva scarso = video("a.mp4", new byte[(int) peso]);
        assertRifiuto(unico(prepara(scarso)), "video", "spazio-insufficiente");
        assertEquals(0, scarso.aperture);
        assertArrayEquals(new String[0], fileInScelti());
        mondo.spazio = peso + SelettoreMedia.MARGINE_SPAZIO_BYTE;
        assertEquals("video", unico(prepara(video("b.mp4", new byte[(int) peso]))).getString("tipo"));
    }

    @Test
    public void unVideoVuotoOConPesoDichiaratoZeroEIlleggibile() throws Exception {
        SorgenteDiProva dichiaratoZero = video("a.mp4", new byte[0]).dichiara(0L);
        assertRifiuto(unico(prepara(dichiaratoZero)), "video", "illeggibile");
        assertEquals(0, dichiaratoZero.aperture);
        // Peso non dichiarato e contenuto vuoto: lo si scopre copiando, e non resta niente.
        SorgenteDiProva vuoto = video("b.mp4", new byte[0]).dichiara(-1L);
        assertRifiuto(unico(prepara(vuoto)), "video", "illeggibile");
        assertArrayEquals(new String[0], fileInScelti());
        assertEquals(0, registro.numero());
    }

    @Test
    public void unPesoNonDichiaratoCheSuperaIlLimiteMentreSiCopiaSiFermaESiPulisce() throws Exception {
        Opzioni stretta = new Opzioni(Sorgente.GALLERIA, 50, 1920, 0.85, 1000L, 300);
        SorgenteDiProva bugiardo = video("a.mp4", null).dichiara(-1L).conFlusso(() -> new FlussoGenerato(50_000L, 4096));
        JSONObject e = unico(prepara(stretta, bugiardo));
        assertRifiuto(e, "video", "troppo-grande");
        assertArrayEquals("nessuna copia parziale", new String[0], fileInScelti());
        // Anche un peso dichiarato basso ma falso.
        SorgenteDiProva falso = video("b.mp4", null).dichiara(10L).conFlusso(() -> new FlussoGenerato(50_000L, 4096));
        assertRifiuto(unico(prepara(stretta, falso)), "video", "troppo-grande");
        assertArrayEquals(new String[0], fileInScelti());
    }

    @Test
    public void unVideoTroppoLungoSoloDallaCopiaSiRifiutaEComunqueSiCancella() throws Exception {
        mondo.analisi = new MiniaturaVideo.Analisi(301_000L, "data:image/jpeg;base64,QUJD");
        SorgenteDiProva ignota = video("a.mp4", FintiDelSelettore.casuali(2000, 30)); // durataMs() = -1
        assertRifiuto(unico(prepara(ignota)), "video", "troppo-lungo");
        assertEquals("la copia c'è stata, e si è cancellata", 1, ignota.aperture);
        assertArrayEquals(new String[0], fileInScelti());
        assertEquals(0, registro.numero());
    }

    @Test
    public void ilContenutoCheNonCEPiuSiRifiutaSenzaSegnalarloEUnGuastoDiLetturaSi() throws Exception {
        SorgenteDiProva assente = video("a.mp4", new byte[100]);
        assente.daLanciareAllApertura = new FileNotFoundException("sparito");
        assertRifiuto(unico(prepara(assente)), "video", "illeggibile");
        assertTrue("un contenuto che non c'è più è un rifiuto atteso: nessuna riga di log", mondo.segnalazioni.isEmpty());

        SorgenteDiProva guasto = video("b.mp4", new byte[100]);
        guasto.daLanciareAllApertura = new IOException("pipe rotta");
        assertRifiuto(unico(prepara(guasto)), "video", "illeggibile");
        assertEquals(Collections.singletonList("video/COPIA/IO"), mondo.segnalazioni);

        mondo.segnalazioni.clear();
        SorgenteDiProva negato = video("c.mp4", new byte[100]);
        negato.daLanciareRuntimeAllApertura = new SecurityException("permesso revocato");
        assertRifiuto(unico(prepara(negato)), "video", "illeggibile");
        assertEquals(Collections.singletonList("video/COPIA/SICUREZZA"), mondo.segnalazioni);

        mondo.segnalazioni.clear();
        SorgenteDiProva strano = video("d.mp4", new byte[100]);
        strano.daLanciareRuntimeAllApertura = new IllegalStateException("x");
        assertRifiuto(unico(prepara(strano)), "video", "illeggibile");
        assertEquals(Collections.singletonList("video/INTERNO/STATO_ILLEGALE"), mondo.segnalazioni);
        assertArrayEquals(new String[0], fileInScelti());
    }

    @Test
    public void unErroreDiScritturaConIlDiscoQuasiPienoDiceSpazioInsufficienteSenzaSegnalare() throws Exception {
        FlussoGenerato flusso = new FlussoGenerato(10_000_000L, 65536);
        flusso.guastoDopo = new IOException("No space left on device");
        flusso.guastoDopoByte = 200_000L;
        flusso.aOgniLettura = () -> mondo.spazio = 1024L * 1024L; // mentre si copia il disco si riempie
        SorgenteDiProva s = video("a.mp4", null).dichiara(10_000_000L).conFlusso(() -> flusso);
        assertRifiuto(unico(prepara(s)), "video", "spazio-insufficiente");
        assertTrue("è un rifiuto atteso", mondo.segnalazioni.isEmpty());
        assertArrayEquals("niente copia parziale", new String[0], fileInScelti());
    }

    @Test
    public void unErroreDiLetturaACopiaIniziataCancellaLaCopiaESiSegnala() throws Exception {
        FlussoGenerato flusso = new FlussoGenerato(10_000_000L, 65536);
        flusso.guastoDopo = new IOException("connessione persa");
        flusso.guastoDopoByte = 200_000L;
        SorgenteDiProva s = video("a.mp4", null).dichiara(10_000_000L).conFlusso(() -> flusso);
        assertRifiuto(unico(prepara(s)), "video", "illeggibile");
        assertEquals(Collections.singletonList("video/COPIA/IO"), mondo.segnalazioni);
        assertArrayEquals(new String[0], fileInScelti());
    }

    @Test
    public void unTipoCheNonEFotoNeVideoESiRifiutaComeNonSupportato() throws Exception {
        JSONObject e = unico(prepara(new SorgenteDiProva("relazione.pdf", "application/pdf", new byte[100])));
        assertRifiuto(e, "altro", "formato-non-supportato");
        assertEquals("relazione.pdf", e.getString("nome"));
        assertArrayEquals(new String[0], fileInScelti());
    }

    @Test
    public void unAnalisiCheLanciaNonFermaIlVideoESiSegnala() throws Exception {
        mondo.analisiLancia = new IllegalStateException("lettore");
        JSONObject e = unico(prepara(video("a.mp4", FintiDelSelettore.casuali(800, 40))));
        assertEquals("il video entra comunque, senza miniatura", "video", e.getString("tipo"));
        assertTrue(e.isNull("miniatura"));
        assertEquals(Collections.singletonList("video/INTERNO/STATO_ILLEGALE"), mondo.segnalazioni);
    }

    @Test
    public void unElementoCheVaStortoNonButtaViaGliAltri() throws Exception {
        // La riduzione della prima foto lancia un'eccezione imprevista: diventa un rifiutato, e la scelta continua col video.
        mondo.riduciLanciaRuntime = new IllegalStateException("bug");
        Esito esito = prepara(new SorgenteDiProva("a.jpg", "image/jpeg", CodecDiProva.jpegGiocattolo(CodecDiProva.quadranti(30, 20), 0)),
                video("b.mp4", FintiDelSelettore.casuali(500, 50)));
        assertEquals(2, esito.elementi.size());
        assertRifiuto(esito.elementi.get(0), "foto", "illeggibile");
        assertEquals("video", esito.elementi.get(1).getString("tipo"));
        assertEquals(Collections.singletonList("foto/INTERNO/STATO_ILLEGALE"), mondo.segnalazioni);
        assertEquals("solo il video resta in scelti/", 1, fileInScelti().length);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * LE FOTO
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void unaFotoGrandeEntraRidottaAlLatoMassimoSenzaChePrimaResti() throws Exception {
        byte[] jpeg = CodecDiProva.jpegGiocattolo(CodecDiProva.quadranti(1200, 900), 0, CodecDiProva.segmentoJfif());
        Opzioni lato600 = new Opzioni(Sorgente.GALLERIA, 50, 600, 0.85, 2_000_000_000L, 300);
        JSONObject e = unico(prepara(lato600, new SorgenteDiProva("IMG_20261003.HEIC", "image/jpeg", jpeg)));
        assertEquals("foto", e.getString("tipo"));
        assertEquals("il nome perde l'estensione: la foto esce JPEG", "IMG_20261003", e.getString("nome"));
        assertEquals("il lato lungo vale il massimo che il JavaScript ha passato", 600, e.getInt("larghezza"));
        assertEquals(450, e.getInt("altezza"));
        String id = e.getString("id");
        File ridotta = new File(scelti, id + ".jpg");
        assertTrue(ridotta.isFile());
        assertEquals(ridotta.length(), e.getLong("byte"));
        assertArrayEquals("l'originale copiato per i decodificatori è sparito", new String[]{id + ".jpg"}, fileInScelti());
        Preparato p = registro.trova(id);
        assertEquals(TipoElemento.FOTO, p.tipo);
        assertEquals(600, p.larghezza);
        assertEquals(450, p.altezza);
        assertNull(p.sha256);
        assertEquals(1, mondo.originaliVisti.size());
        assertFalse("l'originale è stato cancellato", mondo.originaliVisti.get(0).exists());
    }

    @Test
    public void unaFotoConExif6EsceDrittaDalSelettoreInteroEArrivaDrittaAlJavaScript() throws Exception {
        // Il ramo `BitmapFactory` (sotto API 28): il decodificatore NON raddrizza, la pipeline sì. Dal file «per traverso» (80×60, Orientation 6)
        // alla foto dritta (60×80), passando per il registro e per `leggiFoto` (base64): il JavaScript riceve quello che l'insegnante ha scelto.
        mondo.codec = CodecDiProva.comeBitmapFactory();
        mondo.sdk = 26;
        byte[] file = CodecDiProva.fotoInPiediMemorizzata(6);
        JSONObject e = unico(prepara(new SorgenteDiProva("in-piedi.jpg", "image/jpeg", file)));
        assertEquals("foto", e.getString("tipo"));
        assertEquals("60 di larghezza e 80 di altezza: in piedi, non per traverso", 60, e.getInt("larghezza"));
        assertEquals(80, e.getInt("altezza"));
        JSONObject letta = SelettoreMedia.leggiFoto(registro, e.getString("id"));
        byte[] consegnati = java.util.Base64.getDecoder().decode(letta.getString("base64"));
        assertEquals(letta.getLong("byte"), consegnati.length);
        assertArrayEquals("pixel per pixel, i quattro quadranti al loro posto", CodecDiProva.quadranti(60, 80).argb, CodecDiProva.leggiRaster(consegnati).argb);
    }

    @Test
    public void unaFotoRifiutataDalCodecDiventaUnRifiutatoConIlMotivoGiusto() throws Exception {
        mondo.riduciLancia = new FotoRifiutata(Rifiuto.FORMATO_NON_SUPPORTATO, null);
        assertRifiuto(unico(prepara(new SorgenteDiProva("a.heic", "image/heic", new byte[64]))), "foto", "formato-non-supportato");
        assertTrue("rifiuto atteso: nessuna riga", mondo.segnalazioni.isEmpty());
        assertArrayEquals("neanche l'originale copiato resta", new String[0], fileInScelti());

        mondo.riduciLancia = new FotoRifiutata(Rifiuto.ILLEGGIBILE, null);
        assertRifiuto(unico(prepara(new SorgenteDiProva("b.jpg", "image/jpeg", new byte[64]))), "foto", "illeggibile");
        assertTrue(mondo.segnalazioni.isEmpty());

        mondo.riduciLancia = new FotoRifiutata(Rifiuto.ILLEGGIBILE, ClasseErrore.MEMORIA_ESAURITA);
        assertRifiuto(unico(prepara(new SorgenteDiProva("c.jpg", "image/jpeg", new byte[64]))), "foto", "illeggibile");
        assertEquals("un guasto nostro si segnala, col tipo foto e la classe", Collections.singletonList("foto/RIDUZIONE/MEMORIA_ESAURITA"), mondo.segnalazioni);
        assertArrayEquals(new String[0], fileInScelti());
        assertEquals(0, registro.numero());
    }

    @Test
    public void unHeicSottoApi28NonSiPassaAlCodecEDiventaNonSupportato() throws Exception {
        byte[] heic = CodecDiProva.heicGiocattolo(CodecDiProva.quadranti(8, 8));
        mondo.sdk = 27;
        CodecDiProva codec = CodecDiProva.comeImageDecoder(null);
        mondo.codec = codec;
        assertRifiuto(unico(prepara(new SorgenteDiProva("IMG.HEIC", "image/heic", heic))), "foto", "formato-non-supportato");
        assertEquals("il decodificatore non è stato chiamato", 0, codec.decodifiche);
    }

    @Test
    public void unaFotoDichiarataDiPesoZeroEIlleggibileEUnaEnormeETroppoGrande() throws Exception {
        assertRifiuto(unico(prepara(new SorgenteDiProva("a.jpg", "image/jpeg", new byte[0]).dichiara(0L))), "foto", "illeggibile");
        assertRifiuto(unico(prepara(new SorgenteDiProva("b.jpg", "image/jpeg", new byte[10]).dichiara(2_000_000_001L))), "foto", "troppo-grande");
        assertEquals(0, mondo.originaliVisti.size());
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * L'ANNULLAMENTO
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void annullareDopoIlPrimoElementoCancellaTuttoERisolveAnnullatoSenzaElementi() throws Exception {
        eventi.aOgniEvento = evento -> {
            try {
                if (evento.getInt("fatti") == 1) cancellazione.annulla();
            } catch (org.json.JSONException impossibile) {
                throw new IllegalStateException(impossibile);
            }
        };
        Esito esito = prepara(video("a.mp4", FintiDelSelettore.casuali(5000, 60)), video("b.mp4", FintiDelSelettore.casuali(5000, 61)),
                video("c.mp4", FintiDelSelettore.casuali(5000, 62)));
        assertTrue(esito.annullato);
        assertEquals("annullato solo con elementi []", 0, esito.elementi.size());
        assertArrayEquals("anche il primo, già pronto, è stato cancellato", new String[0], fileInScelti());
        assertEquals(0, registro.numero());
    }

    @Test
    public void annullareACopiaInCorsoFermaLaCopiaECancellaLaParziale() throws Exception {
        FlussoGenerato flusso = new FlussoGenerato(50_000_000L, 65536);
        flusso.aOgniLettura = () -> {
            if (flusso.letture == 3) cancellazione.annulla();
        };
        SorgenteDiProva grande = video("a.mp4", null).dichiara(50_000_000L).conFlusso(() -> flusso);
        Esito esito = prepara(grande);
        assertTrue(esito.annullato);
        assertTrue("la copia si è fermata subito, non a fine file", flusso.letture < 10);
        assertArrayEquals("nessuna copia parziale", new String[0], fileInScelti());
        assertEquals(0, registro.numero());
        assertTrue("un annullamento non è un guasto: niente riga", mondo.segnalazioni.isEmpty());
    }

    @Test
    public void annullataPrimaDiCominciareNonSiApreNiente() throws Exception {
        cancellazione.annulla();
        SorgenteDiProva s = video("a.mp4", new byte[100]);
        Esito esito = prepara(s);
        assertTrue(esito.annullato);
        assertEquals(0, s.aperture);
        assertArrayEquals(new String[0], fileInScelti());
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * L'AVANZAMENTO
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void lAvanzamentoCominciaDaZeroEFinisceConTuttiGliElementiEIByteDelTotale() throws Exception {
        long pesoA = 300_000L;
        long pesoB = 200_000L;
        prepara(video("a.mp4", FintiDelSelettore.casuali((int) pesoA, 70)), video("b.mp4", FintiDelSelettore.casuali((int) pesoB, 71)));
        List<JSONObject> v = eventi.eventi;
        assertTrue(v.size() >= 3);
        JSONObject primo = v.get(0);
        assertEquals(0, primo.getInt("fatti"));
        assertEquals(2, primo.getInt("totali"));
        assertEquals(0L, primo.getLong("byteCopiati"));
        assertEquals(pesoA + pesoB, primo.getLong("byteTotali"));
        JSONObject ultimo = v.get(v.size() - 1);
        assertEquals(2, ultimo.getInt("fatti"));
        assertEquals(2, ultimo.getInt("totali"));
        assertEquals(pesoA + pesoB, ultimo.getLong("byteCopiati"));
        long precedente = -1;
        int fattiPrecedenti = -1;
        for (JSONObject e : v) {
            assertTrue("i byte non tornano indietro", e.getLong("byteCopiati") >= precedente);
            assertTrue("gli elementi fatti non tornano indietro", e.getInt("fatti") >= fattiPrecedenti);
            assertTrue(e.getLong("byteCopiati") <= e.getLong("byteTotali"));
            precedente = e.getLong("byteCopiati");
            fattiPrecedenti = e.getInt("fatti");
        }
    }

    @Test
    public void conIlTempoFermoGliEventiSiDiradanoEConIlTempoCheScorreSiVedeLaCopia() throws Exception {
        // Orologio fermo: solo l'evento iniziale e uno per elemento (quelli «forzati»), per quanti blocchi si copino.
        prepara(video("a.mp4", FintiDelSelettore.casuali(2 * 1024 * 1024, 80)));
        assertEquals("iniziale + fine elemento", 2, eventi.eventi.size());

        // Orologio che scorre di 300 ms a ogni lettura: ogni blocco copiato è un evento.
        RaccoltaEventi altri = new RaccoltaEventi();
        FlussoGenerato flusso = new FlussoGenerato(2L * 1024 * 1024, 256 * 1024);
        flusso.aOgniLettura = () -> mondo.orologio.addAndGet(300L);
        SorgenteDiProva s = video("b.mp4", null).dichiara(2L * 1024 * 1024).conFlusso(() -> flusso);
        new SelettoreMedia.Preparazione(scelti, new Preparati(), mondo, opzioni(), new Cancellazione(), altri).esegui(Collections.<ElementoSorgente>singletonList(s));
        assertTrue("un evento per blocco: " + altri.eventi.size(), altri.eventi.size() >= 8);
    }

    @Test
    public void ilTotaleIgnotoDiUnSoloElementoFaDiventareNullIlTotaleDiTutti() throws Exception {
        prepara(video("a.mp4", FintiDelSelettore.casuali(500, 90)), video("b.mp4", FintiDelSelettore.casuali(500, 91)).dichiara(-1L));
        JSONObject primo = eventi.eventi.get(0);
        assertTrue(primo.has("byteTotali"));
        assertTrue("totale ignoto: null", primo.isNull("byteTotali"));
    }

    @Test
    public void unListenerCheLanciaNonFermaLaPreparazione() throws Exception {
        eventi.daLanciare = new IllegalStateException("ponte");
        JSONObject e = unico(prepara(video("a.mp4", FintiDelSelettore.casuali(500, 95))));
        assertEquals("video", e.getString("tipo"));
        assertEquals(1, registro.numero());
    }

    @Test
    public void iRifiutiFannoAvanzareLaBarraFinoInFondo() throws Exception {
        SorgenteDiProva grande = video("g.mp4", new byte[10]).dichiara(3_000_000_000L);
        SorgenteDiProva buono = video("b.mp4", FintiDelSelettore.casuali(1000, 96));
        prepara(grande, buono);
        JSONObject ultimo = eventi.eventi.get(eventi.eventi.size() - 1);
        assertEquals(2, ultimo.getInt("fatti"));
        assertEquals("i 3 GB saltati e i 1000 byte copiati sono il totale", ultimo.getLong("byteTotali"), ultimo.getLong("byteCopiati"));
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * LEGGI FOTO, SCARTA
     * ──────────────────────────────────────────────────────────────────────────── */

    private String preparaUnaFoto() throws Exception {
        byte[] jpeg = CodecDiProva.jpegGiocattolo(CodecDiProva.quadranti(640, 480), 0);
        return unico(prepara(new SorgenteDiProva("a.jpg", "image/jpeg", jpeg))).getString("id");
    }

    @Test
    public void leggiFotoConsegnaIlBase64UnaVoltaSolaELaCancella() throws Exception {
        String id = preparaUnaFoto();
        File ridotta = new File(scelti, id + ".jpg");
        byte[] attesi = Files.readAllBytes(ridotta.toPath());
        JSONObject letta = SelettoreMedia.leggiFoto(registro, id);
        assertEquals("image/jpeg", letta.getString("mime"));
        assertEquals(attesi.length, letta.getLong("byte"));
        assertEquals(640, letta.getInt("larghezza"));
        assertEquals(480, letta.getInt("altezza"));
        assertEquals(java.util.Base64.getEncoder().encodeToString(attesi), letta.getString("base64"));
        assertFalse("il file si è cancellato dopo la lettura", ridotta.exists());
        try {
            SelettoreMedia.leggiFoto(registro, id);
            fail("una lettura sola");
        } catch (ElementoAssente atteso) {
            assertEquals("ELEMENTO_ASSENTE", atteso.getMessage());
        }
    }

    @Test
    public void leggiFotoNonDaMaiUnVideoUnIdSconosciutoOUnIdMalformato() throws Exception {
        String videoId = unico(prepara(video("v.mp4", FintiDelSelettore.casuali(300, 100)))).getString("id");
        for (String id : new String[]{videoId, "g-inesistente", "../../etc/passwd", "a/b", "", null, ".", "g-x.jpg"}) {
            try {
                SelettoreMedia.leggiFoto(registro, id);
                fail("«" + id + "» non è una foto leggibile");
            } catch (ElementoAssente atteso) {
                // atteso
            }
        }
        assertEquals("il video è ancora lì", 1, registro.numero());
    }

    @Test
    public void leggiFotoConIlFileSparitoDiceAssenteEToglieLElementoDalRegistro() throws Exception {
        String id = preparaUnaFoto();
        assertTrue(new File(scelti, id + ".jpg").delete());
        try {
            SelettoreMedia.leggiFoto(registro, id);
            fail();
        } catch (ElementoAssente atteso) {
            // atteso
        }
        assertEquals(0, registro.numero());
    }

    @Test
    public void scartaCancellaFileEdEsemplareDiOgniIdEContaGliElementi() throws Exception {
        String a = preparaUnaFoto();
        String b = unico(prepara(video("v.mp4", FintiDelSelettore.casuali(400, 110)))).getString("id");
        String c = preparaUnaFoto();
        // Un file con un nome che comincia come l'id ma non è suo: si salva.
        File vicino = new File(scelti, a + "x.jpg");
        assertTrue(vicino.createNewFile());
        // E un originale rimasto di una foto: si porta via con il suo id.
        File orig = new File(scelti, b + ".orig");
        assertTrue(orig.createNewFile());

        int eliminati = SelettoreMedia.scarta(registro, scelti, Arrays.asList(a, b, "g-non-esiste", null, "../x", "a/b", ""));
        assertEquals("a e b esistevano; gli altri sono sconosciuti o malformati", 2, eliminati);
        assertFalse(new File(scelti, a + ".jpg").exists());
        assertFalse(new File(scelti, b + ".mp4").exists());
        assertFalse(orig.exists());
        assertTrue("il file del vicino non si tocca", vicino.exists());
        assertTrue("c non era nell'elenco", new File(scelti, c + ".jpg").exists());
        assertNull(registro.trova(a));
        assertNull(registro.trova(b));
        assertNotNull(registro.trova(c));
        assertEquals(0, SelettoreMedia.scarta(registro, scelti, null));
        assertEquals(0, SelettoreMedia.scarta(registro, scelti, Collections.<String>emptyList()));
    }

    @Test
    public void scartaNonEsceMaiDallaCartellaDeiPreparati() throws Exception {
        File fuori = temporanea.newFile("importante.txt");
        int eliminati = SelettoreMedia.scarta(registro, scelti, Arrays.asList("..", "../importante", "../importante.txt", "..%2fimportante"));
        assertEquals(0, eliminati);
        assertTrue("un file fuori dalla cartella non si tocca", fuori.exists());
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * L'ELEMENTO DI PROVA (Debug)
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void lElementoDiProvaHaIlPesoChiestoEImprontaVera() throws Exception {
        int peso = 3 * 1024 * 1024 + 5;
        JSONObject e = SelettoreMedia.creaProva(registro, scelti, peso);
        assertEquals("video", e.getString("tipo"));
        assertEquals(peso, e.getLong("byte"));
        assertEquals("video/mp4", e.getString("mime"));
        assertTrue(e.isNull("durataSecondi"));
        assertTrue(e.isNull("miniatura"));
        String id = e.getString("id");
        assertTrue(id.startsWith("p-"));
        File file = new File(scelti, id + ".mp4");
        assertEquals(peso, file.length());
        assertEquals(FintiDelSelettore.sha256(Files.readAllBytes(file.toPath())), e.getString("sha256"));
        Preparato p = registro.trova(id);
        assertEquals(Origine.PROVA, p.origine);
        assertEquals(e.getString("sha256"), p.sha256);
    }

    @Test
    public void lElementoDiProvaRifiutaPesiFuoriDalContratto() throws Exception {
        for (long peso : new long[]{0L, -1L, 2_000_000_001L}) {
            try {
                SelettoreMedia.creaProva(registro, scelti, peso);
                fail("peso " + peso);
            } catch (IllegalArgumentException atteso) {
                // atteso
            }
        }
        assertEquals(0, registro.numero());
        assertArrayEquals(new String[0], fileInScelti());
    }
}
