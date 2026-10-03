package it.kidville.app.caricamenti;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import it.kidville.app.caricamenti.ElaborazioneFoto.Codec;
import it.kidville.app.caricamenti.ElaborazioneFoto.Decodificata;
import it.kidville.app.caricamenti.ElaborazioneFoto.Formato;
import it.kidville.app.caricamenti.ElaborazioneFoto.FotoRifiutata;
import it.kidville.app.caricamenti.ElaborazioneFoto.Raster;
import it.kidville.app.caricamenti.ElaborazioneFoto.Riduzione;
import it.kidville.app.caricamenti.ElaborazioneFoto.Rifiuto;
import it.kidville.app.caricamenti.RegistroNativo.ClasseErrore;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.Random;

/**
 * La riduzione delle foto (spec §4.3, §6.3; compito A3): formato, orientamento EXIF, dimensioni, trasparenza, base64 e la pipeline intera,
 * con un EXIF scritto a mano secondo la specifica E con JPEG veri (scritti da libjpeg con Pillow) per il lettore.
 *
 * ⚠️ Cosa si prova qui e cosa no. Si prova tutto ciò che sta SOPRA il codec: ogni riga della pipeline, il lettore EXIF, le otto rotazioni,
 * l'appiattimento sul bianco, il passaggio della qualità, la cancellazione dell'uscita in caso di guasto. Il codec è `CodecDiProva`, che fa i
 * due rami di Android — `BitmapFactory` (orientamento ignorato) e `ImageDecoder` (orientamento applicato dal decodificatore) — con un
 * contenitore giocattolo e pixel ESATTI: i confronti sono pixel per pixel, senza tolleranza. Che la piattaforma si comporti così lo
 * ricontrolla il collaudo sull'emulatore (E1): la JVM non ha `Bitmap`.
 */
public class ElaborazioneFotoTest {

    @Rule
    public TemporaryFolder temporanea = new TemporaryFolder();

    /* ────────────────────────────────────────────────────────────────────────────
     * IL FORMATO
     * ──────────────────────────────────────────────────────────────────────────── */

    private static byte[] byteDi(String testo) {
        return testo.getBytes(StandardCharsets.ISO_8859_1);
    }

    private static byte[] conTesta(int... valori) {
        byte[] b = new byte[Math.max(valori.length, 32)];
        for (int i = 0; i < valori.length; i++) b[i] = (byte) valori[i];
        return b;
    }

    private static byte[] ftyp(String marca) {
        byte[] b = new byte[32];
        b[3] = 0x18;
        System.arraycopy(byteDi("ftyp"), 0, b, 4, 4);
        System.arraycopy(byteDi(marca), 0, b, 8, 4);
        return b;
    }

    @Test
    public void ilFormatoSiRiconoscePerLaFirmaENonPerLEstensione() {
        assertEquals(Formato.JPEG, ElaborazioneFoto.riconosciFormato(conTesta(0xFF, 0xD8, 0xFF, 0xE0), 32));
        assertEquals(Formato.PNG, ElaborazioneFoto.riconosciFormato(conTesta(0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A), 32));
        assertEquals(Formato.GIF, ElaborazioneFoto.riconosciFormato(byteDi("GIF89a..........................."), 32));
        assertEquals(Formato.GIF, ElaborazioneFoto.riconosciFormato(byteDi("GIF87a..........................."), 32));
        assertEquals(Formato.WEBP, ElaborazioneFoto.riconosciFormato(byteDi("RIFF....WEBPVP8 ................"), 32));
        assertEquals(Formato.BMP, ElaborazioneFoto.riconosciFormato(byteDi("BM.............................."), 32));
        for (String marca : new String[]{"heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"}) {
            assertEquals(marca, Formato.HEIF, ElaborazioneFoto.riconosciFormato(ftyp(marca), 32));
        }
        assertEquals(Formato.AVIF, ElaborazioneFoto.riconosciFormato(ftyp("avif"), 32));
        assertEquals(Formato.AVIF, ElaborazioneFoto.riconosciFormato(ftyp("avis"), 32));
    }

    @Test
    public void unFileCortoVuotoNulloOSenzaFirmaNonSiRiconosce() {
        assertEquals(Formato.SCONOSCIUTO, ElaborazioneFoto.riconosciFormato(null, 0));
        assertEquals(Formato.SCONOSCIUTO, ElaborazioneFoto.riconosciFormato(new byte[0], 0));
        assertEquals(Formato.SCONOSCIUTO, ElaborazioneFoto.riconosciFormato(conTesta(0xFF, 0xD8), 2));
        assertEquals("un MP4 (ftyp con la marca isom) non è una foto", Formato.SCONOSCIUTO, ElaborazioneFoto.riconosciFormato(ftyp("isom"), 32));
        assertEquals(Formato.SCONOSCIUTO, ElaborazioneFoto.riconosciFormato(byteDi("%PDF-1.7 ......................."), 32));
        // La lunghezza dichiarata vale più della dimensione del buffer.
        assertEquals(Formato.SCONOSCIUTO, ElaborazioneFoto.riconosciFormato(conTesta(0xFF, 0xD8, 0xFF, 0xE0), 2));
    }

    @Test
    public void unHeicSottoApi28NonSiApreEDaApi28Si() {
        assertFalse(ElaborazioneFoto.formatoAmmesso(Formato.HEIF, 24));
        assertFalse(ElaborazioneFoto.formatoAmmesso(Formato.HEIF, 27));
        assertTrue(ElaborazioneFoto.formatoAmmesso(Formato.HEIF, 28));
        assertTrue(ElaborazioneFoto.formatoAmmesso(Formato.HEIF, 36));
        assertFalse(ElaborazioneFoto.formatoAmmesso(Formato.AVIF, 30));
        assertTrue(ElaborazioneFoto.formatoAmmesso(Formato.AVIF, 31));
        for (Formato f : new Formato[]{Formato.JPEG, Formato.PNG, Formato.GIF, Formato.WEBP, Formato.BMP, Formato.SCONOSCIUTO}) {
            assertTrue(f + " si prova a ogni livello", ElaborazioneFoto.formatoAmmesso(f, 24));
        }
    }

    @Test
    public void ilRamoDelDecodificatoreSiSceglieAlLivello28() {
        assertFalse(ElaborazioneFoto.CodecAndroid.usaImageDecoder(24));
        assertFalse(ElaborazioneFoto.CodecAndroid.usaImageDecoder(27));
        assertTrue(ElaborazioneFoto.CodecAndroid.usaImageDecoder(28));
        assertTrue(ElaborazioneFoto.CodecAndroid.usaImageDecoder(36));
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * L'ORIENTAMENTO EXIF — su file scritti a mano e su JPEG VERI
     * ──────────────────────────────────────────────────────────────────────────── */

    /** Un «JPEG» col suo EXIF scritto a mano. */
    private static byte[] jpegConOrientamento(int orientamento, boolean piccoloFinale, int vociPrima) {
        return CodecDiProva.jpegGiocattolo(CodecDiProva.quadranti(4, 3), 0, CodecDiProva.segmentoJfif(),
                CodecDiProva.segmentoExif(orientamento, piccoloFinale, vociPrima, 3));
    }

    @Test
    public void ilLettoreExifTrovaOgniOrientamentoInLittleEBigEndian() {
        for (int orientamento = 1; orientamento <= 8; orientamento++) {
            for (boolean piccoloFinale : new boolean[]{true, false}) {
                byte[] jpeg = jpegConOrientamento(orientamento, piccoloFinale, 0);
                assertEquals("orientamento " + orientamento + (piccoloFinale ? " II" : " MM"), orientamento,
                        ElaborazioneFoto.orientamentoExif(jpeg, jpeg.length));
            }
        }
    }

    @Test
    public void ilLettoreExifScorreLeVociPrimaDellOrientamentoESaltaGliAltriApp1() {
        byte[] conVoci = jpegConOrientamento(6, true, 3);
        assertEquals(6, ElaborazioneFoto.orientamentoExif(conVoci, conVoci.length));
        // Un APP1 di XMP davanti all'EXIF non lo nasconde.
        byte[] conXmp = CodecDiProva.jpegGiocattolo(CodecDiProva.quadranti(4, 3), 0, CodecDiProva.segmentoXmp(), CodecDiProva.segmentoExif(8, false, 1, 3));
        assertEquals(8, ElaborazioneFoto.orientamentoExif(conXmp, conXmp.length));
    }

    @Test
    public void ilLettoreExifDiceDrittoQuandoNonSaOUnValoreNonEDaElenco() {
        byte[] senza = CodecDiProva.jpegGiocattolo(CodecDiProva.quadranti(4, 3), 0, CodecDiProva.segmentoJfif());
        assertEquals("nessun EXIF", 1, ElaborazioneFoto.orientamentoExif(senza, senza.length));
        byte[] fuoriElenco = jpegConOrientamento(9, true, 0);
        assertEquals("orientamento 9: non esiste", 1, ElaborazioneFoto.orientamentoExif(fuoriElenco, fuoriElenco.length));
        byte[] zero = jpegConOrientamento(0, true, 0);
        assertEquals(1, ElaborazioneFoto.orientamentoExif(zero, zero.length));
        // Tipo LONG invece di SHORT: lo scrittore sbagliato non vale come un orientamento.
        byte[] tipoSbagliato = CodecDiProva.jpegGiocattolo(CodecDiProva.quadranti(4, 3), 0, CodecDiProva.segmentoExif(6, true, 0, 4));
        assertEquals(1, ElaborazioneFoto.orientamentoExif(tipoSbagliato, tipoSbagliato.length));
    }

    @Test
    public void ilLettoreExifNonLanciaMaiSuByteSbagliati() {
        assertEquals(1, ElaborazioneFoto.orientamentoExif(null, 0));
        assertEquals(1, ElaborazioneFoto.orientamentoExif(new byte[0], 0));
        assertEquals(1, ElaborazioneFoto.orientamentoExif(new byte[]{(byte) 0xFF, (byte) 0xD8}, 2));
        byte[] buono = jpegConOrientamento(6, true, 2);
        // Troncato a ogni lunghezza possibile: mai un'eccezione, e mai un orientamento inventato fuori da 1-8.
        for (int n = 0; n <= buono.length; n++) {
            int valore = ElaborazioneFoto.orientamentoExif(buono, n);
            assertTrue("a " + n + " byte: " + valore, valore >= 1 && valore <= 8);
        }
        // Dati a caso dopo una firma JPEG.
        Random caso = new Random(7);
        for (int prova = 0; prova < 300; prova++) {
            byte[] sporco = new byte[64 + caso.nextInt(200)];
            caso.nextBytes(sporco);
            sporco[0] = (byte) 0xFF;
            sporco[1] = (byte) 0xD8;
            int valore = ElaborazioneFoto.orientamentoExif(sporco, sporco.length);
            assertTrue(valore >= 1 && valore <= 8);
        }
        // Una lunghezza di segmento assurda non manda fuori dal buffer.
        byte[] assurdo = {(byte) 0xFF, (byte) 0xD8, (byte) 0xFF, (byte) 0xE1, (byte) 0xFF, (byte) 0xFF, 'E', 'x', 'i', 'f', 0, 0};
        assertEquals(1, ElaborazioneFoto.orientamentoExif(assurdo, assurdo.length));
    }

    // JPEG VERI, scritti da libjpeg con Pillow 11 (24 x 16 px, quattro quadranti): JFIF, tabelle di quantizzazione e di Huffman, e un
    // EXIF big-endian con CINQUE voci (Make, Model, Orientation, Software, DateTime) i cui testi stanno fuori dalla directory.
    // `senza_exif` è lo stesso disegno senza EXIF. Nessun dato di nessuno: un disegno e stringhe di prova.
    private static final String ORI6_PILLOW =
            "/9j/4AAQSkZJRgABAQAAAQABAAD/4QCORXhpZgAATU0AKgAAAAgABQEPAAIAAAALAAAASgEQAAIAAAANAAAAVgESAAMAAAABAAYA"
            + "AAExAAIAAAANAAAAZAEyAAIAAAAUAAAAcgAAAABQcm92YU1hcmNhAABQcm92YU1vZGVsbG8AAEtpZHZpbGxlVGVzdAAAMjAyNjox"
            + "MDowMyAxMDowMDowMAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExci"
            + "JCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4e"
            + "Hh7/wAARCAAQABgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9"
            + "AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNk"
            + "ZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo"
            + "6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSEx"
            + "BhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0"
            + "dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3"
            + "+Pn6/9oADAMBAAIRAxEAPwDga3fCX/Lz/wAA/rXlVe7fsmf8zN/26f8AtaunjfgH/V7I6+ZfWOfk5fd5eW/NOMd+Z2te+x9NxFxd"
            + "/rNl1TK/Y+z9pb3ubmtyyUtuWN78tt1vcZRXvNFfz/8A2/8A9O/x/wCAfmH+of8A1Ef+S/8A2x//2Q==";

    private static final String ORI8_PILLOW =
            "/9j/4AAQSkZJRgABAQAAAQABAAD/4QCORXhpZgAATU0AKgAAAAgABQEPAAIAAAALAAAASgEQAAIAAAANAAAAVgESAAMAAAABAAgA"
            + "AAExAAIAAAANAAAAZAEyAAIAAAAUAAAAcgAAAABQcm92YU1hcmNhAABQcm92YU1vZGVsbG8AAEtpZHZpbGxlVGVzdAAAMjAyNjox"
            + "MDowMyAxMDowMDowMAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExci"
            + "JCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4e"
            + "Hh7/wAARCAAQABgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9"
            + "AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNk"
            + "ZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo"
            + "6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSEx"
            + "BhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0"
            + "dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3"
            + "+Pn6/9oADAMBAAIRAxEAPwDga3fCX/Lz/wAA/rXlVe7fsmf8zN/26f8AtaunjfgH/V7I6+ZfWOfk5fd5eW/NOMd+Z2te+x9NxFxd"
            + "/rNl1TK/Y+z9pb3ubmtyyUtuWN78tt1vcZRXvNFfz/8A2/8A9O/x/wCAfmH+of8A1Ef+S/8A2x//2Q==";

    private static final String ORI3_PILLOW =
            "/9j/4AAQSkZJRgABAQAAAQABAAD/4QCORXhpZgAATU0AKgAAAAgABQEPAAIAAAALAAAASgEQAAIAAAANAAAAVgESAAMAAAABAAMA"
            + "AAExAAIAAAANAAAAZAEyAAIAAAAUAAAAcgAAAABQcm92YU1hcmNhAABQcm92YU1vZGVsbG8AAEtpZHZpbGxlVGVzdAAAMjAyNjox"
            + "MDowMyAxMDowMDowMAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExci"
            + "JCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4e"
            + "Hh7/wAARCAAQABgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9"
            + "AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNk"
            + "ZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo"
            + "6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSEx"
            + "BhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0"
            + "dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3"
            + "+Pn6/9oADAMBAAIRAxEAPwDga3fCX/Lz/wAA/rXlVe7fsmf8zN/26f8AtaunjfgH/V7I6+ZfWOfk5fd5eW/NOMd+Z2te+x9NxFxd"
            + "/rNl1TK/Y+z9pb3ubmtyyUtuWN78tt1vcZRXvNFfz/8A2/8A9O/x/wCAfmH+of8A1Ef+S/8A2x//2Q==";

    private static final String SENZA_EXIF_PILLOW =
            "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0d"
            + "Hx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4e"
            + "Hh4eHh4eHh7/wAARCAAQABgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUF"
            + "BAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVW"
            + "V1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi"
            + "4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAEC"
            + "AxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVm"
            + "Z2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq"
            + "8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDga3fCX/Lz/wAA/rXlVe7fsmf8zN/26f8AtaunjfgH/V7I6+ZfWOfk5fd5eW/NOMd+Z2te"
            + "+x9NxFxd/rNl1TK/Y+z9pb3ubmtyyUtuWN78tt1vcZRXvNFfz/8A2/8A9O/x/wCAfmH+of8A1Ef+S/8A2x//2Q==";

    private static byte[] vero(String base64) {
        return java.util.Base64.getDecoder().decode(base64);
    }

    @Test
    public void ilLettoreExifLeggeLOrientamentoDiJpegVeriScrittiDaLibjpeg() {
        byte[] sei = vero(ORI6_PILLOW);
        byte[] otto = vero(ORI8_PILLOW);
        byte[] tre = vero(ORI3_PILLOW);
        assertEquals("è un JPEG vero: firma e lunghezza", Formato.JPEG, ElaborazioneFoto.riconosciFormato(sei, sei.length));
        assertEquals(883, sei.length);
        assertEquals("EXIF a cinque voci con l'orientamento in terza posizione", 6, ElaborazioneFoto.orientamentoExif(sei, sei.length));
        assertEquals(8, ElaborazioneFoto.orientamentoExif(otto, otto.length));
        assertEquals(3, ElaborazioneFoto.orientamentoExif(tre, tre.length));
    }

    @Test
    public void unJpegVeroSenzaExifVaDrittoEUnoVeroTroncatoNonLanciaMai() {
        byte[] senza = vero(SENZA_EXIF_PILLOW);
        assertEquals(Formato.JPEG, ElaborazioneFoto.riconosciFormato(senza, senza.length));
        assertEquals(1, ElaborazioneFoto.orientamentoExif(senza, senza.length));
        byte[] sei = vero(ORI6_PILLOW);
        // Man mano che il file «arriva» l'orientamento compare in un punto solo e poi non sparisce più: prima vale 1 (dritta), da lì in poi 6.
        int primoByteChePermetteDiLeggerlo = -1;
        for (int n = 0; n <= sei.length; n++) {
            int valore = ElaborazioneFoto.orientamentoExif(sei, n);
            assertTrue("a " + n + " byte: " + valore, valore == 1 || valore == 6);
            if (valore == 6 && primoByteChePermetteDiLeggerlo < 0) primoByteChePermetteDiLeggerlo = n;
            if (primoByteChePermetteDiLeggerlo >= 0) assertEquals("a " + n + " byte, dopo averlo trovato a " + primoByteChePermetteDiLeggerlo, 6, valore);
        }
        assertTrue("lo trova", primoByteChePermetteDiLeggerlo > 0);
        assertTrue("l'EXIF sta all'inizio del file, ben prima dei pixel: lo trova entro i primi 100 byte, non a fine file (" + primoByteChePermetteDiLeggerlo + ")",
                primoByteChePermetteDiLeggerlo < 100);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * LE DIMENSIONI
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void ilLatoLungoVale1920EsattoEMaiSiIngrandisce() {
        assertArrayEquals(new int[]{1920, 1440}, ElaborazioneFoto.dimensioniObiettivo(4032, 3024, 1920));
        assertArrayEquals("verticale", new int[]{1440, 1920}, ElaborazioneFoto.dimensioniObiettivo(3024, 4032, 1920));
        assertArrayEquals("48 MP", new int[]{1920, 1440}, ElaborazioneFoto.dimensioniObiettivo(8000, 6000, 1920));
        assertArrayEquals("quadrata", new int[]{1920, 1920}, ElaborazioneFoto.dimensioniObiettivo(5000, 5000, 1920));
        assertArrayEquals("già piccola: resta com'è", new int[]{800, 600}, ElaborazioneFoto.dimensioniObiettivo(800, 600, 1920));
        assertArrayEquals("esattamente al limite", new int[]{1920, 1080}, ElaborazioneFoto.dimensioniObiettivo(1920, 1080, 1920));
        assertArrayEquals("un pixel sopra il limite", new int[]{1920, 1079}, ElaborazioneFoto.dimensioniObiettivo(1921, 1080, 1920));
    }

    @Test
    public void unPanoramaEstremoNonDiventaUnLatoDiZeroPixel() {
        int[] d = ElaborazioneFoto.dimensioniObiettivo(40000, 10, 1920);
        assertEquals(1920, d[0]);
        assertTrue("l'altro lato resta almeno 1: " + d[1], d[1] >= 1);
        int[] v = ElaborazioneFoto.dimensioniObiettivo(10, 40000, 1920);
        assertEquals(1920, v[1]);
        assertTrue(v[0] >= 1);
    }

    @Test
    public void leDimensioniNonValideSiRifiutano() {
        for (int[] d : new int[][]{{0, 10, 1920}, {10, 0, 1920}, {-1, 10, 1920}, {10, 10, 0}}) {
            try {
                ElaborazioneFoto.dimensioniObiettivo(d[0], d[1], d[2]);
                fail("dovrebbe rifiutare " + Arrays.toString(d));
            } catch (IllegalArgumentException atteso) {
                // atteso
            }
        }
    }

    @Test
    public void ilCampionamentoEUnaPotenzaDiDueCheLasciaIlLatoSopraLObiettivo() {
        assertEquals(1, ElaborazioneFoto.campionamento(1920, 1080, 1920));
        assertEquals(1, ElaborazioneFoto.campionamento(2000, 1500, 1920));
        assertEquals(2, ElaborazioneFoto.campionamento(4032, 3024, 1920));
        assertEquals(4, ElaborazioneFoto.campionamento(8000, 6000, 1920));
        assertEquals("48 MP verticale", 4, ElaborazioneFoto.campionamento(6000, 8000, 1920));
        assertEquals(1, ElaborazioneFoto.campionamento(0, 100, 1920));
        // Il lato decodificato non scende mai sotto l'obiettivo.
        for (int lato = 1920; lato < 20000; lato += 777) {
            int s = ElaborazioneFoto.campionamento(lato, lato / 2, 1920);
            assertTrue("lato " + lato + " campione " + s, lato / s >= 1920);
            assertTrue(Integer.bitCount(s) == 1);
        }
    }

    @Test
    public void laQualitaJpegVieneDalContrattoArrotondataETenutaNellIntervallo() {
        assertEquals(85, ElaborazioneFoto.qualitaJpeg(0.85));
        assertEquals(100, ElaborazioneFoto.qualitaJpeg(1.0));
        assertEquals(1, ElaborazioneFoto.qualitaJpeg(0.004));
        assertEquals(1, ElaborazioneFoto.qualitaJpeg(-3));
        assertEquals(100, ElaborazioneFoto.qualitaJpeg(7));
        assertEquals(85, ElaborazioneFoto.qualitaJpeg(Double.NaN));
        assertEquals("0,855 si arrotonda per eccesso", 86, ElaborazioneFoto.qualitaJpeg(0.855));
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * LE OTTO ROTAZIONI (l'oracolo sta in CodecDiProva: l'immagine MEMORIZZATA si costruisce da quella dritta con le formule inverse)
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void ogniOrientamentoRiportaLImmagineDritta() {
        Raster u = CodecDiProva.dritta(9, 5);
        for (int o = 1; o <= 8; o++) {
            Raster salvata = CodecDiProva.memorizzata(u, o);
            Raster risultato = salvata.conOrientamento(o);
            assertEquals("larghezza con orientamento " + o, u.larghezza, risultato.larghezza);
            assertEquals("altezza con orientamento " + o, u.altezza, risultato.altezza);
            assertArrayEquals("pixel con orientamento " + o, u.argb, risultato.argb);
        }
    }

    @Test
    public void conUnOrientamentoSenzaSensoNonSiTocca() {
        Raster u = CodecDiProva.dritta(6, 4);
        for (int o : new int[]{0, 1, 9, -1, 100}) assertSame(u, u.conOrientamento(o));
    }

    @Test
    public void laRotazioneNonModificaLOriginaleEScambiaLeDimensioniSoloDa5A8() {
        Raster u = CodecDiProva.dritta(7, 3);
        int[] prima = u.argb.clone();
        for (int o = 2; o <= 8; o++) {
            Raster r = u.conOrientamento(o);
            assertArrayEquals("l'originale non cambia", prima, u.argb);
            boolean scambiate = o >= 5;
            assertEquals(scambiate ? 3 : 7, r.larghezza);
            assertEquals(scambiate ? 7 : 3, r.altezza);
        }
    }

    @Test
    public void unaFotoMemorizzataConExif6HaIlSuoAngoloRossoAlPostoGiusto() {
        // Un controllo senza formule: una foto «in piedi» con il rosso in alto a sinistra. Memorizzata con orientamento 6 (come la memorizza un
        // telefono tenuto in verticale) ha il rosso in BASSO a sinistra del file; raddrizzata, il rosso torna in alto a sinistra.
        Raster u = CodecDiProva.dritta(4, 6);
        int rosso = 0xFFFF0000;
        u.argb[0] = rosso; // alto a sinistra
        Raster salvata = CodecDiProva.memorizzata(u, 6);
        assertEquals("nel file il rosso sta in basso a sinistra", rosso, salvata.argb[(salvata.altezza - 1) * salvata.larghezza]);
        Raster risultato = salvata.conOrientamento(6);
        assertEquals("raddrizzata sta in alto a sinistra", rosso, risultato.argb[0]);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * LA TRASPARENZA
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void laTrasparenzaSiStendeSulBianco() {
        int[] px = {
                0x00FF0000, // rosso trasparente → bianco
                0xFF123456, // opaco: invariato
                0x80000000, // nero a metà → grigio
                0x80FFFFFF, // bianco a metà → bianco
                0x40FF0000, // rosso a un quarto
                0x00000000  // tutto trasparente → bianco
        };
        Raster r = new Raster(6, 1, px).appiattitaSuBianco();
        assertEquals(0xFFFFFFFF, r.argb[0]);
        assertEquals(0xFF123456, r.argb[1]);
        assertEquals("nero al 50% su bianco: 127 o 128, mai nero", 0xFF7F7F7F, r.argb[2]);
        assertEquals(0xFFFFFFFF, r.argb[3]);
        int quarto = r.argb[4];
        assertEquals("tutti i pixel escono opachi", 0xFF, quarto >>> 24);
        assertEquals("il rosso a un quarto resta rosso pieno nel canale R", 0xFF, (quarto >> 16) & 0xFF);
        assertTrue("e gli altri canali sono ~ 3/4 di bianco: " + Integer.toHexString(quarto), ((quarto >> 8) & 0xFF) >= 190 && ((quarto >> 8) & 0xFF) <= 195);
        assertEquals(0xFFFFFFFF, r.argb[5]);
        for (int p : r.argb) assertEquals(0xFF, p >>> 24);
    }

    @Test
    public void unPixelOpacoNonCambiaDiUnBit() {
        int[] px = new int[256];
        for (int i = 0; i < px.length; i++) px[i] = 0xFF000000 | (i * 65793);
        assertArrayEquals(px, new Raster(16, 16, px).appiattitaSuBianco().argb);
    }

    @Test
    public void unRasterConDimensioniIncoerentiSiRifiuta() {
        for (int[] d : new int[][]{{0, 4}, {4, 0}, {-1, 4}, {3, 3}}) {
            try {
                new Raster(d[0], d[1], new int[8]);
                fail("dovrebbe rifiutare " + Arrays.toString(d));
            } catch (IllegalArgumentException atteso) {
                // atteso
            }
        }
        try {
            new Raster(2, 2, null);
            fail();
        } catch (IllegalArgumentException atteso) {
            // atteso
        }
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL BASE64
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void ilBase64EQuelloDelJdkSuOgniLunghezzaConIlPadding() {
        Random caso = new Random(11);
        for (int n = 0; n <= 300; n++) {
            byte[] dati = new byte[n];
            caso.nextBytes(dati);
            assertEquals("lunghezza " + n, java.util.Base64.getEncoder().encodeToString(dati), ElaborazioneFoto.base64(dati));
        }
        byte[] grande = new byte[1_000_003];
        caso.nextBytes(grande);
        assertEquals(java.util.Base64.getEncoder().encodeToString(grande), ElaborazioneFoto.base64(grande));
    }

    @Test
    public void ilBase64NonVaMaiACapoEHaIlPaddingCheServe() {
        String uno = ElaborazioneFoto.base64(new byte[]{1});
        String due = ElaborazioneFoto.base64(new byte[]{1, 2});
        String tre = ElaborazioneFoto.base64(new byte[]{1, 2, 3});
        assertTrue(uno, uno.endsWith("=="));
        assertTrue(due, due.endsWith("=") && !due.endsWith("=="));
        assertFalse(tre, tre.contains("="));
        String lunga = ElaborazioneFoto.base64(new byte[5000]);
        assertFalse("niente a capo né spazi", lunga.contains("\n") || lunga.contains("\r") || lunga.contains(" "));
        assertEquals("", ElaborazioneFoto.base64(new byte[0]));
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * LA PIPELINE INTERA
     * ──────────────────────────────────────────────────────────────────────────── */

    private File scrivi(String nome, byte[] dati) throws IOException {
        File f = temporanea.newFile(nome);
        CodecDiProva.scrivi(f, dati);
        return f;
    }

    private File uscita(String nome) {
        return new File(temporanea.getRoot(), nome);
    }

    private static Raster letta(File jpeg) throws IOException {
        return CodecDiProva.leggiRaster(Files.readAllBytes(jpeg.toPath()));
    }

    @Test
    public void unJpegConExif6EsceDrittoSuEntrambiIRami() throws Exception {
        // IL TEST OBBLIGATORIO di §6.3. Una foto 60×80 «in piedi» con rosso in alto a sinistra, verde in alto a destra, blu in basso a sinistra,
        // giallo in basso a destra, memorizzata per traverso (80×60) con Orientation = 6.
        Raster dritta = CodecDiProva.quadranti(60, 80);
        File originale = scrivi("exif6.jpg", CodecDiProva.fotoInPiediMemorizzata(6));
        assertEquals("il file è davvero per traverso", 80, CodecDiProva.leggiRaster(Files.readAllBytes(originale.toPath())).larghezza);

        // Ramo BitmapFactory (sotto API 28): i pixel sono quelli memorizzati, la pipeline legge l'EXIF e raddrizza.
        CodecDiProva comeBitmapFactory = CodecDiProva.comeBitmapFactory();
        File uscitaBf = uscita("uscita-bitmapfactory.jpg");
        Riduzione r1 = ElaborazioneFoto.riduci(originale, uscitaBf, 1920, 85, 26, comeBitmapFactory);
        assertEquals(60, r1.larghezza);
        assertEquals(80, r1.altezza);
        Raster visto1 = letta(uscitaBf);
        assertEquals(60, visto1.larghezza);
        assertEquals(80, visto1.altezza);
        assertArrayEquals("BitmapFactory: dritta, pixel per pixel", dritta.argb, visto1.argb);

        // Ramo ImageDecoder (da API 28): il decodificatore consegna già la foto dritta, e la pipeline NON la ruota una seconda volta.
        CodecDiProva comeImageDecoder = CodecDiProva.comeImageDecoder(dritta);
        File uscitaId = uscita("uscita-imagedecoder.jpg");
        Riduzione r2 = ElaborazioneFoto.riduci(originale, uscitaId, 1920, 85, 30, comeImageDecoder);
        assertEquals(60, r2.larghezza);
        assertEquals(80, r2.altezza);
        assertArrayEquals("ImageDecoder: dritta, pixel per pixel", dritta.argb, letta(uscitaId).argb);
    }

    @Test
    public void ognunoDegliOttoOrientamentiEsceDrittoSuEntrambiIRami() throws Exception {
        Raster dritta = CodecDiProva.quadranti(60, 80);
        for (int o = 1; o <= 8; o++) {
            File originale = scrivi("exif" + o + ".jpg", CodecDiProva.fotoInPiediMemorizzata(o));
            File daBf = uscita("u" + o + "-bf.jpg");
            ElaborazioneFoto.riduci(originale, daBf, 1920, 85, 24, CodecDiProva.comeBitmapFactory());
            Raster r1 = letta(daBf);
            assertEquals("orientamento " + o + " (BitmapFactory) larghezza", 60, r1.larghezza);
            assertEquals("orientamento " + o + " (BitmapFactory) altezza", 80, r1.altezza);
            assertArrayEquals("orientamento " + o + " (BitmapFactory)", dritta.argb, r1.argb);

            File daId = uscita("u" + o + "-id.jpg");
            ElaborazioneFoto.riduci(originale, daId, 1920, 85, 33, CodecDiProva.comeImageDecoder(dritta));
            assertArrayEquals("orientamento " + o + " (ImageDecoder)", dritta.argb, letta(daId).argb);
        }
    }

    @Test
    public void unFileSenzaExifNonSiRuotaSuNessunRamo() throws Exception {
        Raster in = CodecDiProva.dritta(30, 20);
        File originale = scrivi("senza.jpg", CodecDiProva.jpegGiocattolo(in, 0, CodecDiProva.segmentoJfif()));
        File daBf = uscita("senza-bf.jpg");
        ElaborazioneFoto.riduci(originale, daBf, 1920, 85, 24, CodecDiProva.comeBitmapFactory());
        assertArrayEquals(in.argb, letta(daBf).argb);
        assertEquals(30, letta(daBf).larghezza);
    }

    @Test
    public void soloUnJpegPortaLOrientamentoNelFile() throws Exception {
        // Un PNG o un WebP non portano un orientamento EXIF nel file: anche con i byte di un EXIF «6» dopo la firma (un file costruito apposta),
        // sul ramo che non raddrizza la pipeline non ruota niente. L'orientamento si legge solo da un JPEG.
        Raster in = CodecDiProva.dritta(30, 20);
        byte[] png = CodecDiProva.pngGiocattolo(in);
        byte[] conExifDopoLaFirma = new byte[png.length + 64];
        System.arraycopy(png, 0, conExifDopoLaFirma, 0, 8);
        byte[] exif = CodecDiProva.segmentoExif(6, true, 0, 3);
        System.arraycopy(exif, 0, conExifDopoLaFirma, 8, exif.length);
        System.arraycopy(png, 8, conExifDopoLaFirma, 8 + exif.length, png.length - 8);
        File originale = scrivi("a.png", java.util.Arrays.copyOf(conExifDopoLaFirma, 8 + exif.length + png.length - 8));
        File fuori = uscita("a-bf.jpg");
        ElaborazioneFoto.riduci(originale, fuori, 1920, 85, 24, CodecDiProva.comeBitmapFactory());
        Raster visto = letta(fuori);
        assertEquals("30 di larghezza: non è stato ruotato", 30, visto.larghezza);
        assertEquals(20, visto.altezza);
    }

    @Test
    public void seIlDecodificatoreHaGiaRaddrizzatoLaPipelineNonRuotaUnaSecondaVolta() throws Exception {
        // Un decodificatore che dichiara «orientamento applicato» senza averlo fatto lascia la foto per traverso: la pipeline si fida della
        // dichiarazione, e un ramo che raddrizza due volte (o nessuna) è il difetto che i due test sopra fermano.
        File originale = scrivi("exif6-b.jpg", CodecDiProva.fotoInPiediMemorizzata(6));
        final CodecDiProva interno = CodecDiProva.comeBitmapFactory();
        Codec bugiardo = new Codec() {
            @Override
            public Decodificata decodifica(File f, int lato, Formato formato) throws IOException, FotoRifiutata {
                Decodificata vera = interno.decodifica(f, lato, formato);
                return new Decodificata(vera.raster, true);
            }

            @Override
            public void scriviJpeg(Raster raster, int qualita, java.io.OutputStream out) throws IOException {
                interno.scriviJpeg(raster, qualita, out);
            }
        };
        File fuori = uscita("bugiardo.jpg");
        ElaborazioneFoto.riduci(originale, fuori, 1920, 85, 33, bugiardo);
        Raster visto = letta(fuori);
        assertEquals("per traverso: la larghezza è quella memorizzata", 80, visto.larghezza);
        assertEquals(60, visto.altezza);
    }

    @Test
    public void unaFotoGrandeVieneRidottaAlLatoMassimoConIlLatoLungoEsatto() throws Exception {
        Raster grande = CodecDiProva.quadranti(1200, 900);
        File originale = scrivi("grande.jpg", CodecDiProva.jpegGiocattolo(grande, 0, CodecDiProva.segmentoJfif()));
        File fuori = uscita("ridotta.jpg");
        Riduzione r = ElaborazioneFoto.riduci(originale, fuori, 600, 85, 33, CodecDiProva.comeImageDecoder(null));
        assertEquals("il lato lungo vale ESATTAMENTE il massimo", 600, r.larghezza);
        assertEquals(450, r.altezza);
        assertEquals(fuori.length(), r.byteTotali);
        Raster visto = letta(fuori);
        assertEquals(600, visto.larghezza);
        assertEquals(450, visto.altezza);
    }

    @Test
    public void laQualitaDelContrattoArrivaAlCodec() throws Exception {
        File originale = scrivi("q.jpg", CodecDiProva.jpegGiocattolo(CodecDiProva.quadranti(20, 20), 0));
        CodecDiProva codec = CodecDiProva.comeImageDecoder(null);
        File fuori = uscita("q-uscita.jpg");
        ElaborazioneFoto.riduci(originale, fuori, 1920, ElaborazioneFoto.qualitaJpeg(0.85), 33, codec);
        assertEquals(85, codec.ultimaQualita);
        assertEquals(85, CodecDiProva.qualitaScritta(Files.readAllBytes(fuori.toPath())));
        assertEquals("il codec ha scritto una volta sola", 1, codec.scritture);
    }

    @Test
    public void unaFotoGiaPiccolaNonSiIngrandisceESiRicodificaComunque() throws Exception {
        byte[] piccola = CodecDiProva.jpegGiocattolo(CodecDiProva.quadranti(32, 24), 0, CodecDiProva.segmentoJfif(), CodecDiProva.segmentoExif(1, true, 2, 3));
        File originale = scrivi("piccola.jpg", piccola);
        File fuori = uscita("piccola-uscita.jpg");
        Riduzione r = ElaborazioneFoto.riduci(originale, fuori, 1920, 85, 33, CodecDiProva.comeImageDecoder(null));
        assertEquals(32, r.larghezza);
        assertEquals(24, r.altezza);
        byte[] scritti = Files.readAllBytes(fuori.toPath());
        assertFalse("la foto è stata RICODIFICATA, non copiata", Arrays.equals(piccola, scritti));
        assertEquals(85, CodecDiProva.qualitaScritta(scritti));
    }

    @Test
    public void unaFotoConExifEGpsEsceSenzaNessunMetadato() throws Exception {
        byte[] conExif = CodecDiProva.jpegGiocattolo(CodecDiProva.quadranti(40, 30), 0, CodecDiProva.segmentoJfif(), CodecDiProva.segmentoExif(1, true, 4, 3),
                CodecDiProva.segmentoXmp());
        assertTrue("la fixture ha davvero dei metadati", CodecDiProva.haMetadati(conExif));
        File originale = scrivi("conexif.jpg", conExif);
        File fuori = uscita("senzaexif.jpg");
        // La foto è più piccola del lato massimo: non si ridimensiona, e proprio per questo non deve sopravvivere nemmeno un byte di metadati.
        ElaborazioneFoto.riduci(originale, fuori, 1920, 85, 33, CodecDiProva.comeImageDecoder(null));
        assertFalse("nessun segmento APP1 (EXIF/XMP) nel JPEG di uscita", CodecDiProva.haMetadati(Files.readAllBytes(fuori.toPath())));
    }

    @Test
    public void unPngConSfondoTrasparenteEsceSuBiancoENonSuNero() throws Exception {
        int blu = 0xFF2020E0;
        int[] px = new int[8 * 4];
        for (int y = 0; y < 4; y++) {
            for (int x = 0; x < 8; x++) px[y * 8 + x] = x < 4 ? 0x00000000 : blu; // metà trasparente (nero a alpha 0), metà blu opaco
        }
        File originale = scrivi("trasparente.png", CodecDiProva.pngGiocattolo(new Raster(8, 4, px)));
        File fuori = uscita("trasparente.jpg");
        ElaborazioneFoto.riduci(originale, fuori, 1920, 90, 33, CodecDiProva.comeImageDecoder(null));
        Raster visto = letta(fuori);
        for (int y = 0; y < 4; y++) {
            for (int x = 0; x < 8; x++) {
                assertEquals("pixel " + x + "," + y, x < 4 ? 0xFFFFFFFF : blu, visto.argb[y * 8 + x]);
            }
        }
    }

    @Test
    public void unHeicSottoApi28ViRifiutatoSenzaChiamareIlCodec() throws Exception {
        File heic = scrivi("foto.heic", CodecDiProva.heicGiocattolo(CodecDiProva.quadranti(8, 8)));
        CodecDiProva codec = CodecDiProva.comeImageDecoder(null);
        File fuori = uscita("heic.jpg");
        try {
            ElaborazioneFoto.riduci(heic, fuori, 1920, 85, 27, codec);
            fail("un HEIC sotto API 28 si rifiuta");
        } catch (FotoRifiutata rifiuto) {
            assertEquals(Rifiuto.FORMATO_NON_SUPPORTATO, rifiuto.rifiuto);
            assertNull("è un rifiuto atteso: nessuna riga di log", rifiuto.daSegnalare);
        }
        assertEquals("il decodificatore non è stato nemmeno chiamato", 0, codec.decodifiche);
        assertFalse(fuori.exists());
    }

    @Test
    public void unHeicDaApi28SiDecodifica() throws Exception {
        Raster in = CodecDiProva.dritta(16, 12);
        File heic = scrivi("foto2.heic", CodecDiProva.heicGiocattolo(in));
        CodecDiProva codec = CodecDiProva.comeImageDecoder(null);
        File fuori = uscita("heic2.jpg");
        Riduzione r = ElaborazioneFoto.riduci(heic, fuori, 1920, 85, 28, codec);
        assertEquals("da API 28 il codec viene chiamato", 1, codec.decodifiche);
        assertEquals(Formato.HEIF, codec.ultimoFormatoVisto);
        assertEquals(16, r.larghezza);
        assertEquals(12, r.altezza);
        assertArrayEquals(in.argb, letta(fuori).argb);
    }

    @Test
    public void ilCodecRiceveIlFormatoRiconosciutoEIlRifiutoAttesoNonSiSegnala() throws Exception {
        File jpeg = scrivi("a.jpg", CodecDiProva.jpegGiocattolo(CodecDiProva.quadranti(20, 20), 0));
        CodecDiProva codec = CodecDiProva.comeImageDecoder(null);
        codec.daLanciareRifiuto = new FotoRifiutata(Rifiuto.FORMATO_NON_SUPPORTATO, null);
        File fuori = uscita("a-uscita.jpg");
        try {
            ElaborazioneFoto.riduci(jpeg, fuori, 1920, 85, 33, codec);
            fail();
        } catch (FotoRifiutata rifiuto) {
            assertEquals(Rifiuto.FORMATO_NON_SUPPORTATO, rifiuto.rifiuto);
            assertNull(rifiuto.daSegnalare);
        }
        assertEquals(Formato.JPEG, codec.ultimoFormatoVisto);
        assertFalse(fuori.exists());
    }

    @Test
    public void unFileCheIlCodecNonSaLeggereEIlleggibileSeLaFirmaELaDiUnFormatoNotoENonSupportatoSeNo() throws Exception {
        // Una firma JPEG ma nessun pixel che il codec riconosca: file corrotto.
        File corrotto = scrivi("corrotto.jpg", new byte[]{(byte) 0xFF, (byte) 0xD8, (byte) 0xFF, (byte) 0xDA, 1, 2, 3, 4, 5, 6, 7, 8});
        assertEquals(Rifiuto.ILLEGGIBILE, rifiutoDi(CodecDiProva.comeBitmapFactory(), corrotto, uscita("c1.jpg")).rifiuto);
        // Nessuna firma che conosciamo: un formato che nessuno apre.
        File strano = scrivi("strano.dat", "questo non è un'immagine di nessun tipo, solo testo lungo abbastanza".getBytes(StandardCharsets.UTF_8));
        FotoRifiutata rifiuto = rifiutoDi(CodecDiProva.comeBitmapFactory(), strano, uscita("c2.jpg"));
        assertEquals(Rifiuto.FORMATO_NON_SUPPORTATO, rifiuto.rifiuto);
        assertNull("rifiuti attesi: nessuna riga di log", rifiuto.daSegnalare);
    }

    private static FotoRifiutata rifiutoDi(Codec codec, File originale, File uscita) {
        try {
            ElaborazioneFoto.riduci(originale, uscita, 1920, 85, 33, codec);
        } catch (FotoRifiutata rifiuto) {
            return rifiuto;
        }
        fail("doveva rifiutare");
        return null;
    }

    @Test
    public void ogniGuastoDelCodecDiventaUnRifiutoConLaClasseDaSegnalare() throws Exception {
        File jpeg = scrivi("b.jpg", CodecDiProva.jpegGiocattolo(CodecDiProva.quadranti(20, 20), 0));
        File fuori = uscita("b-uscita.jpg");

        CodecDiProva io = CodecDiProva.comeImageDecoder(null);
        io.daLanciareInDecodifica = new IOException("disco");
        FotoRifiutata r1 = rifiutoDi(io, jpeg, fuori);
        assertEquals(Rifiuto.ILLEGGIBILE, r1.rifiuto);
        assertEquals(ClasseErrore.IO, r1.daSegnalare);

        CodecDiProva memoria = CodecDiProva.comeImageDecoder(null);
        memoria.daLanciareErrore = new OutOfMemoryError();
        FotoRifiutata r2 = rifiutoDi(memoria, jpeg, fuori);
        assertEquals(Rifiuto.ILLEGGIBILE, r2.rifiuto);
        assertEquals(ClasseErrore.MEMORIA_ESAURITA, r2.daSegnalare);

        CodecDiProva sicurezza = CodecDiProva.comeImageDecoder(null);
        sicurezza.daLanciareRuntime = new SecurityException("negato");
        assertEquals(ClasseErrore.SICUREZZA, rifiutoDi(sicurezza, jpeg, fuori).daSegnalare);

        CodecDiProva generico = CodecDiProva.comeImageDecoder(null);
        generico.daLanciareRuntime = new IllegalStateException("x");
        assertEquals(ClasseErrore.STATO_ILLEGALE, rifiutoDi(generico, jpeg, fuori).daSegnalare);

        assertFalse("nessun file di uscita dopo un guasto", fuori.exists());
    }

    @Test
    public void unGuastoDiScritturaNonLasciaUnJpegMezzoScritto() throws Exception {
        File jpeg = scrivi("w.jpg", CodecDiProva.jpegGiocattolo(CodecDiProva.quadranti(20, 20), 0));
        final CodecDiProva interno = CodecDiProva.comeImageDecoder(null);
        Codec scrittoreRotto = new Codec() {
            @Override
            public Decodificata decodifica(File f, int lato, Formato formato) throws IOException, FotoRifiutata {
                return interno.decodifica(f, lato, formato);
            }

            @Override
            public void scriviJpeg(Raster raster, int qualita, java.io.OutputStream out) throws IOException {
                out.write(new byte[]{(byte) 0xFF, (byte) 0xD8, 1, 2, 3}); // un pezzo, poi il disco si rompe
                throw new IOException("No space left on device");
            }
        };
        File fuori = uscita("w-uscita.jpg");
        FotoRifiutata rifiuto = rifiutoDi(scrittoreRotto, jpeg, fuori);
        assertEquals(Rifiuto.ILLEGGIBILE, rifiuto.rifiuto);
        assertEquals(ClasseErrore.IO, rifiuto.daSegnalare);
        assertFalse("il file mezzo scritto è stato cancellato", fuori.exists());
    }

    @Test
    public void unCodecCheNonScriveNienteNonProduceUnJpegVuoto() throws Exception {
        File jpeg = scrivi("v.jpg", CodecDiProva.jpegGiocattolo(CodecDiProva.quadranti(20, 20), 0));
        final CodecDiProva interno = CodecDiProva.comeImageDecoder(null);
        Codec silenzioso = new Codec() {
            @Override
            public Decodificata decodifica(File f, int lato, Formato formato) throws IOException, FotoRifiutata {
                return interno.decodifica(f, lato, formato);
            }

            @Override
            public void scriviJpeg(Raster raster, int qualita, java.io.OutputStream out) {
                // non scrive niente e non lancia: un codec che «riesce» senza produrre byte
            }
        };
        File fuori = uscita("v-uscita.jpg");
        FotoRifiutata rifiuto = rifiutoDi(silenzioso, jpeg, fuori);
        assertEquals(Rifiuto.ILLEGGIBILE, rifiuto.rifiuto);
        assertEquals("è un guasto nostro: si segnala", ClasseErrore.IO, rifiuto.daSegnalare);
        assertFalse("il file vuoto non resta in scelti/", fuori.exists());
    }

    @Test
    public void unDecodificatoreChePassaIlLatoMassimoVieneFermatoENonProduceUnaFotoTroppoGrande() throws Exception {
        File jpeg = scrivi("c.jpg", CodecDiProva.jpegGiocattolo(CodecDiProva.quadranti(2500, 1000), 0));
        CodecDiProva difettoso = CodecDiProva.comeImageDecoder(null);
        difettoso.ignoraIlLatoMassimo = true;
        File fuori = uscita("c-uscita.jpg");
        FotoRifiutata rifiuto = rifiutoDi(difettoso, jpeg, fuori);
        assertEquals(Rifiuto.ILLEGGIBILE, rifiuto.rifiuto);
        assertEquals("è un difetto nostro: si segnala", ClasseErrore.STATO_ILLEGALE, rifiuto.daSegnalare);
        assertFalse(fuori.exists());
    }

    @Test
    public void unFileOriginaleCheNonEsisteDiventaUnRifiutoENonUnaEccezione() {
        File assente = new File(temporanea.getRoot(), "non-esiste.jpg");
        FotoRifiutata rifiuto = rifiutoDi(CodecDiProva.comeImageDecoder(null), assente, uscita("x.jpg"));
        assertEquals(Rifiuto.ILLEGGIBILE, rifiuto.rifiuto);
        assertEquals(ClasseErrore.FILE_NON_TROVATO, rifiuto.daSegnalare);
    }

    @Test
    public void ilMessaggioDiUnRifiutoNonContieneMaiUnPercorso() throws Exception {
        File jpeg = scrivi("segretissimo-nome-del-bambino.jpg", CodecDiProva.jpegGiocattolo(CodecDiProva.quadranti(20, 20), 0));
        CodecDiProva io = CodecDiProva.comeImageDecoder(null);
        io.daLanciareInDecodifica = new IOException(jpeg.getAbsolutePath());
        FotoRifiutata rifiuto = rifiutoDi(io, jpeg, uscita("m.jpg"));
        assertFalse("il messaggio non porta il percorso", String.valueOf(rifiuto.getMessage()).contains("segretissimo"));
        assertNull("né una causa che lo porterebbe", rifiuto.getCause());
        assertEquals(Rifiuto.ILLEGGIBILE.name(), rifiuto.getMessage());
    }

    @Test
    public void leggiTestaLeggeAlPiuIlMassimoRichiestoEUnFileCortoPerIntero() throws Exception {
        byte[] dati = new byte[1000];
        new Random(3).nextBytes(dati);
        File f = scrivi("testa.bin", dati);
        assertArrayEquals(Arrays.copyOf(dati, 100), ElaborazioneFoto.leggiTesta(f, 100));
        assertArrayEquals(dati, ElaborazioneFoto.leggiTesta(f, 5000));
        assertEquals(0, ElaborazioneFoto.leggiTesta(scrivi("vuoto.bin", new byte[0]), 100).length);
    }
}
