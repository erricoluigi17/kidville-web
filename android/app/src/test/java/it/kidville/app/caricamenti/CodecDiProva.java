package it.kidville.app.caricamenti;

import it.kidville.app.caricamenti.ElaborazioneFoto.Codec;
import it.kidville.app.caricamenti.ElaborazioneFoto.Decodificata;
import it.kidville.app.caricamenti.ElaborazioneFoto.Formato;
import it.kidville.app.caricamenti.ElaborazioneFoto.FotoRifiutata;
import it.kidville.app.caricamenti.ElaborazioneFoto.Raster;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * UN CODEC DI PROVA PER LA JVM, CON PIXEL ESATTI. I test unitari di Android non vedono `java.awt` né `javax.imageio` (il compilatore dei test
 * ha solo `android.jar`) e non hanno `Bitmap`: qui le immagini sono un contenitore GIOCATTOLO che il codec di prova sa leggere e scrivere,
 * e la pipeline di `ElaborazioneFoto` gira intera su pixel che si confrontano uno per uno (nessuna tolleranza da JPEG con perdita).
 *
 * ─── IL CONTENITORE ──────────────────────────────────────────────────────────────────────────
 * `[intestazione che decide il formato] + "TOYRASTER" + qualità(1) + larghezza(4) + altezza(4) + pixel ARGB (4 byte ciascuno, big-endian)`.
 * L'intestazione è ciò che la pipeline guarda davvero: per un «JPEG» sono `FF D8`, i segmenti di metadati scritti dal test (un EXIF
 * secondo la specifica, un XMP) e `FF DA` — il segmento di scansione, dove il lettore EXIF si ferma come su un JPEG vero; per un «PNG» la firma
 * PNG; per un «HEIC» `ftyp` e la marca. La pipeline legge firma ed EXIF dai byte, il codec di prova legge i pixel dal resto.
 *
 * ─── I DUE RAMI DI ANDROID ───────────────────────────────────────────────────────────────────
 *  · `comeBitmapFactory()`: i pixel sono quelli MEMORIZZATI nel file e `orientamentoApplicato` è falso (la pipeline raddrizza da sola);
 *  · `comeImageDecoder(dritta)`: il decodificatore raddrizza da sé e consegna l'immagine DRITTA, che il test conosce e passa qui
 *    (la piattaforma la ricava dall'EXIF; qui non c'è alcun codice di rotazione, quindi nessuna copia di quello sotto prova).
 *
 * ─── LE IMMAGINI VERE ────────────────────────────────────────────────────────────────────────
 * Il lettore EXIF si prova anche su JPEG VERI (scritti da libjpeg con Pillow, con JFIF, tabelle e EXIF a più voci): stanno come
 * stringhe base64 in `ElaborazioneFotoTest`. Che i decodificatori di Android raddrizzino o no come qui si dice è una proprietà della
 * piattaforma, e il collaudo sull'emulatore la ricontrolla con foto vere.
 */
class CodecDiProva implements Codec {

    enum OrientamentoApplicato {
        SI,
        NO
    }

    static final byte[] MAGIA = "TOYRASTER".getBytes(StandardCharsets.US_ASCII);

    private final OrientamentoApplicato ramo;
    private final Raster dritta;
    /** Quante volte la pipeline ha chiesto di decodificare: un HEIC rifiutato in anticipo non deve arrivare qui. */
    int decodifiche;
    int scritture;
    int ultimaQualita = -1;
    IOException daLanciareInDecodifica;
    RuntimeException daLanciareRuntime;
    Error daLanciareErrore;
    FotoRifiutata daLanciareRifiuto;
    /** Se vero, restituisce l'immagine così com'è anche se più grande del lato richiesto (un decodificatore difettoso). */
    boolean ignoraIlLatoMassimo;
    Formato ultimoFormatoVisto;

    private CodecDiProva(OrientamentoApplicato ramo, Raster dritta) {
        this.ramo = ramo;
        this.dritta = dritta;
    }

    /** Come `BitmapFactory`: i pixel del file, orientamento ignorato. */
    static CodecDiProva comeBitmapFactory() {
        return new CodecDiProva(OrientamentoApplicato.NO, null);
    }

    /** Come `ImageDecoder` davanti a un file il cui contenuto dritto è `dritta` (null: il file non ha orientamento, si legge com'è). */
    static CodecDiProva comeImageDecoder(Raster dritta) {
        return new CodecDiProva(OrientamentoApplicato.SI, dritta);
    }

    @Override
    public Decodificata decodifica(File originale, int latoMassimo, Formato formato) throws IOException, FotoRifiutata {
        decodifiche++;
        ultimoFormatoVisto = formato;
        if (daLanciareRifiuto != null) throw daLanciareRifiuto;
        if (daLanciareInDecodifica != null) throw daLanciareInDecodifica;
        if (daLanciareRuntime != null) throw daLanciareRuntime;
        if (daLanciareErrore != null) throw daLanciareErrore;
        byte[] dati = Files.readAllBytes(originale.toPath());
        Raster daiPixelDelFile = leggiRasterONull(dati);
        if (daiPixelDelFile == null) throw ElaborazioneFoto.rifiutoDiFormato(formato);
        Raster risultato = ramo == OrientamentoApplicato.SI && dritta != null ? dritta : daiPixelDelFile;
        if (!ignoraIlLatoMassimo) {
            int[] obiettivo = ElaborazioneFoto.dimensioniObiettivo(risultato.larghezza, risultato.altezza, latoMassimo);
            if (obiettivo[0] != risultato.larghezza || obiettivo[1] != risultato.altezza) risultato = ridimensiona(risultato, obiettivo[0], obiettivo[1]);
        }
        return new Decodificata(risultato, ramo == OrientamentoApplicato.SI);
    }

    @Override
    public void scriviJpeg(Raster raster, int qualita, OutputStream uscita) throws IOException {
        scritture++;
        ultimaQualita = qualita;
        uscita.write(jpegGiocattolo(raster, qualita));
    }

    /** Il ridimensionamento più semplice possibile (il vicino più prossimo): ai test servono le dimensioni, non la qualità. */
    static Raster ridimensiona(Raster r, int larghezza, int altezza) {
        int[] argb = new int[larghezza * altezza];
        for (int y = 0; y < altezza; y++) {
            int sorgenteY = Math.min(r.altezza - 1, (int) ((long) y * r.altezza / altezza));
            for (int x = 0; x < larghezza; x++) {
                int sorgenteX = Math.min(r.larghezza - 1, (int) ((long) x * r.larghezza / larghezza));
                argb[y * larghezza + x] = r.argb[sorgenteY * r.larghezza + sorgenteX];
            }
        }
        return new Raster(larghezza, altezza, argb);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL CONTENITORE: SCRITTURA E LETTURA
     * ──────────────────────────────────────────────────────────────────────────── */

    private static void scrivi32(ByteArrayOutputStream uscita, int valore) {
        uscita.write((valore >> 24) & 0xFF);
        uscita.write((valore >> 16) & 0xFF);
        uscita.write((valore >> 8) & 0xFF);
        uscita.write(valore & 0xFF);
    }

    /** `MAGIA` + qualità + dimensioni + pixel. */
    static byte[] corpo(Raster raster, int qualita) {
        ByteArrayOutputStream uscita = new ByteArrayOutputStream(raster.argb.length * 4 + 32);
        uscita.write(MAGIA, 0, MAGIA.length);
        uscita.write(qualita & 0xFF);
        scrivi32(uscita, raster.larghezza);
        scrivi32(uscita, raster.altezza);
        for (int pixel : raster.argb) scrivi32(uscita, pixel);
        return uscita.toByteArray();
    }

    /** Un «JPEG»: `FF D8`, i `segmenti` di metadati, `FF DA` (scansione), il corpo, `FF D9`. */
    static byte[] jpegGiocattolo(Raster raster, int qualita, byte[]... segmenti) {
        ByteArrayOutputStream uscita = new ByteArrayOutputStream();
        uscita.write(0xFF);
        uscita.write(0xD8);
        for (byte[] segmento : segmenti) uscita.write(segmento, 0, segmento.length);
        uscita.write(0xFF);
        uscita.write(0xDA);
        byte[] dati = corpo(raster, qualita);
        uscita.write(dati, 0, dati.length);
        uscita.write(0xFF);
        uscita.write(0xD9);
        return uscita.toByteArray();
    }

    /** Un «PNG»: la firma PNG e il corpo (i pixel possono avere trasparenza). */
    static byte[] pngGiocattolo(Raster raster) {
        ByteArrayOutputStream uscita = new ByteArrayOutputStream();
        byte[] firma = {(byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A};
        uscita.write(firma, 0, firma.length);
        byte[] dati = corpo(raster, 0);
        uscita.write(dati, 0, dati.length);
        return uscita.toByteArray();
    }

    /** Un «HEIC»: 32 byte con `ftyp` e la marca, e il corpo. */
    static byte[] heicGiocattolo(Raster raster) {
        ByteArrayOutputStream uscita = new ByteArrayOutputStream();
        byte[] testa = new byte[32];
        testa[3] = 0x18;
        System.arraycopy("ftypheic".getBytes(StandardCharsets.ISO_8859_1), 0, testa, 4, 8);
        uscita.write(testa, 0, testa.length);
        byte[] dati = corpo(raster, 0);
        uscita.write(dati, 0, dati.length);
        return uscita.toByteArray();
    }

    private static int indiceDellaMagia(byte[] dati) {
        for (int i = 0; i + MAGIA.length <= dati.length; i++) {
            boolean uguale = true;
            for (int k = 0; k < MAGIA.length; k++) {
                if (dati[i + k] != MAGIA[k]) {
                    uguale = false;
                    break;
                }
            }
            if (uguale) return i;
        }
        return -1;
    }

    private static int leggi32(byte[] dati, int posizione) {
        return ((dati[posizione] & 0xFF) << 24) | ((dati[posizione + 1] & 0xFF) << 16) | ((dati[posizione + 2] & 0xFF) << 8) | (dati[posizione + 3] & 0xFF);
    }

    /** I pixel di un file del contenitore, o `null` se non lo è. */
    static Raster leggiRasterONull(byte[] dati) {
        int inizio = indiceDellaMagia(dati);
        if (inizio < 0) return null;
        int p = inizio + MAGIA.length + 1;
        if (p + 8 > dati.length) return null;
        int larghezza = leggi32(dati, p);
        int altezza = leggi32(dati, p + 4);
        p += 8;
        if (larghezza <= 0 || altezza <= 0 || (long) larghezza * altezza * 4L > dati.length - p) return null;
        int[] argb = new int[larghezza * altezza];
        for (int i = 0; i < argb.length; i++) argb[i] = leggi32(dati, p + 4 * i);
        return new Raster(larghezza, altezza, argb);
    }

    /** I pixel di un file del contenitore; fa fallire il test se non lo è. */
    static Raster leggiRaster(byte[] dati) {
        Raster r = leggiRasterONull(dati);
        if (r == null) throw new AssertionError("non è un file del contenitore di prova");
        return r;
    }

    /** La qualità con cui il file è stato scritto. */
    static int qualitaScritta(byte[] dati) {
        int inizio = indiceDellaMagia(dati);
        if (inizio < 0) throw new AssertionError("non è un file del contenitore di prova");
        return dati[inizio + MAGIA.length] & 0xFF;
    }

    /**
     * Vero se, fra `FF D8` e la scansione (`FF DA`), c'è un qualunque segmento APP1 (EXIF, XMP...): i metadati. Cammina i segmenti come un
     * lettore vero, e non cerca `FF E1` nei byte (nei pixel potrebbe comparire per caso).
     */
    static boolean haMetadati(byte[] dati) {
        int p = 2;
        while (p + 4 <= dati.length) {
            if ((dati[p] & 0xFF) != 0xFF) return false;
            int marcatore = dati[p + 1] & 0xFF;
            if (marcatore == 0xDA || marcatore == 0xD9) return false;
            if (marcatore == 0xE1) return true;
            int lunghezza = ((dati[p + 2] & 0xFF) << 8) | (dati[p + 3] & 0xFF);
            p += 2 + lunghezza;
        }
        return false;
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * I PIXEL DEI TEST E L'ORACOLO DELLE ROTAZIONI EXIF
     * ──────────────────────────────────────────────────────────────────────────── */

    static final int ROSSO = 0xFFE02020;
    static final int VERDE = 0xFF20C020;
    static final int BLU = 0xFF2020E0;
    static final int GIALLO = 0xFFE0E020;

    /** Quattro quadranti: rosso in alto a sinistra, verde in alto a destra, blu in basso a sinistra, giallo in basso a destra. */
    static Raster quadranti(int larghezza, int altezza) {
        int[] argb = new int[larghezza * altezza];
        for (int y = 0; y < altezza; y++) {
            for (int x = 0; x < larghezza; x++) {
                boolean destra = x >= larghezza / 2;
                boolean sotto = y >= altezza / 2;
                argb[y * larghezza + x] = !sotto ? (!destra ? ROSSO : VERDE) : (!destra ? BLU : GIALLO);
            }
        }
        return new Raster(larghezza, altezza, argb);
    }

    /** Un'immagine dritta in cui ogni pixel è diverso: un errore di un solo indice si vede. */
    static Raster dritta(int larghezza, int altezza) {
        int[] argb = new int[larghezza * altezza];
        for (int y = 0; y < altezza; y++) {
            for (int x = 0; x < larghezza; x++) argb[y * larghezza + x] = 0xFF000000 | ((x * 7 + 1) << 16) | ((y * 11 + 3) << 8) | ((x ^ y) & 0xFF);
        }
        return new Raster(larghezza, altezza, argb);
    }

    /**
     * La memorizzazione di una foto dritta `u` con l'orientamento EXIF `o`: la costruisce da `u` con le formule INVERSE della tabella EXIF
     * (scritte qui, a parte dagli indici lineari di `Raster.conOrientamento`: chi prova quello non può copiare da questo).
     */
    static Raster memorizzata(Raster u, int o) {
        int w = u.larghezza;
        int h = u.altezza;
        boolean scambia = o >= 5;
        int sl = scambia ? h : w;
        int sa = scambia ? w : h;
        int[] s = new int[sl * sa];
        for (int y = 0; y < sa; y++) {
            for (int x = 0; x < sl; x++) {
                int xu;
                int yu;
                switch (o) {
                    case 1:
                        xu = x;
                        yu = y;
                        break;
                    case 2: // specchio orizzontale
                        xu = w - 1 - x;
                        yu = y;
                        break;
                    case 3: // mezzo giro
                        xu = w - 1 - x;
                        yu = h - 1 - y;
                        break;
                    case 4: // specchio verticale
                        xu = x;
                        yu = h - 1 - y;
                        break;
                    case 5: // trasposizione
                        xu = y;
                        yu = x;
                        break;
                    case 6: // chi la guarda deve girarla di un quarto ORARIO: l'abbiamo girata di un quarto ANTIORARIO
                        xu = w - 1 - y;
                        yu = x;
                        break;
                    case 7: // trasposizione rovesciata
                        xu = w - 1 - y;
                        yu = h - 1 - x;
                        break;
                    default: // 8: chi la guarda deve girarla di un quarto ANTIORARIO: l'abbiamo girata di un quarto ORARIO
                        xu = y;
                        yu = h - 1 - x;
                        break;
                }
                s[y * sl + x] = u.argb[yu * w + xu];
            }
        }
        return new Raster(sl, sa, s);
    }

    /**
     * Il file «JPEG» di una foto «in piedi» (60 px di larghezza, 80 di altezza, quattro quadranti) MEMORIZZATA con l'orientamento `o`, con
     * il suo EXIF: come la scrive un telefono. Raddrizzata deve tornare ai quattro quadranti al loro posto.
     */
    static byte[] fotoInPiediMemorizzata(int o) {
        return jpegGiocattolo(memorizzata(quadranti(60, 80), o), 0, segmentoExif(o, true, 1, 3));
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * I SEGMENTI DI METADATI (scritti secondo la specifica EXIF, a mano)
     * ──────────────────────────────────────────────────────────────────────────── */

    /**
     * Un segmento APP1 EXIF con la voce `Orientation`. `vociPrima` aggiunge altrettante voci ASCII prima dell'orientamento (per provare che il
     * lettore le scorre), `piccoloFinale` sceglie `II` o `MM`, `tipo` il tipo della voce (3 = SHORT, quello vero).
     */
    static byte[] segmentoExif(int orientamento, boolean piccoloFinale, int vociPrima, int tipo) {
        ByteArrayOutputStream tiff = new ByteArrayOutputStream();
        scrivi(tiff, piccoloFinale ? "II" : "MM");
        scrivi16(tiff, 42, piccoloFinale);
        scrivi32(tiff, 8, piccoloFinale);
        int voci = vociPrima + 1;
        scrivi16(tiff, voci, piccoloFinale);
        for (int i = 0; i < vociPrima; i++) {
            scrivi16(tiff, 0x010F + i, piccoloFinale); // Make e simili
            scrivi16(tiff, 2, piccoloFinale); // ASCII
            scrivi32(tiff, 1, piccoloFinale);
            scrivi32(tiff, 0, piccoloFinale);
        }
        scrivi16(tiff, 0x0112, piccoloFinale);
        scrivi16(tiff, tipo, piccoloFinale);
        scrivi32(tiff, 1, piccoloFinale);
        if (tipo == 3) {
            scrivi16(tiff, orientamento, piccoloFinale);
            scrivi16(tiff, 0, piccoloFinale);
        } else {
            scrivi32(tiff, orientamento, piccoloFinale);
        }
        scrivi32(tiff, 0, piccoloFinale); // nessuna IFD successiva
        byte[] contenuto = tiff.toByteArray();

        ByteArrayOutputStream segmento = new ByteArrayOutputStream();
        segmento.write(0xFF);
        segmento.write(0xE1);
        int lunghezza = 2 + 6 + contenuto.length;
        segmento.write((lunghezza >> 8) & 0xFF);
        segmento.write(lunghezza & 0xFF);
        scrivi(segmento, "Exif");
        segmento.write(0);
        segmento.write(0);
        segmento.write(contenuto, 0, contenuto.length);
        return segmento.toByteArray();
    }

    /** Un segmento APP1 di XMP (non EXIF): il lettore deve saltarlo e cercare l'EXIF dopo. */
    static byte[] segmentoXmp() {
        byte[] intestazione = "http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>".getBytes(StandardCharsets.ISO_8859_1);
        ByteArrayOutputStream segmento = new ByteArrayOutputStream();
        segmento.write(0xFF);
        segmento.write(0xE1);
        int lunghezza = 2 + intestazione.length;
        segmento.write((lunghezza >> 8) & 0xFF);
        segmento.write(lunghezza & 0xFF);
        segmento.write(intestazione, 0, intestazione.length);
        return segmento.toByteArray();
    }

    /** Un segmento APP0 (JFIF) di 16 byte, come lo scrive ogni encoder: il lettore deve scavalcarlo per arrivare all'EXIF. */
    static byte[] segmentoJfif() {
        return new byte[]{(byte) 0xFF, (byte) 0xE0, 0x00, 0x10, 'J', 'F', 'I', 'F', 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00};
    }

    static void scrivi(File file, byte[] dati) throws IOException {
        Files.write(file.toPath(), dati);
    }

    private static void scrivi(ByteArrayOutputStream uscita, String testo) {
        byte[] byteDelTesto = testo.getBytes(StandardCharsets.ISO_8859_1);
        uscita.write(byteDelTesto, 0, byteDelTesto.length);
    }

    private static void scrivi16(ByteArrayOutputStream uscita, int valore, boolean piccoloFinale) {
        if (piccoloFinale) {
            uscita.write(valore & 0xFF);
            uscita.write((valore >> 8) & 0xFF);
        } else {
            uscita.write((valore >> 8) & 0xFF);
            uscita.write(valore & 0xFF);
        }
    }

    private static void scrivi32(ByteArrayOutputStream uscita, long valore, boolean piccoloFinale) {
        if (piccoloFinale) {
            scrivi16(uscita, (int) (valore & 0xFFFF), true);
            scrivi16(uscita, (int) ((valore >> 16) & 0xFFFF), true);
        } else {
            scrivi16(uscita, (int) ((valore >> 16) & 0xFFFF), false);
            scrivi16(uscita, (int) (valore & 0xFFFF), false);
        }
    }
}
