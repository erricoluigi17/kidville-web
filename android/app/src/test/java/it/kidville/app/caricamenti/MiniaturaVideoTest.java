package it.kidville.app.caricamenti;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Base64;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * La miniatura e la durata di un video (spec §4.2, §6.3; compito A3): le tre scelte che si possono giudicare sulla JVM — a che istante
 * prendere il fotogramma, con che dimensioni, in che forma consegnarlo. Il lettore vero (`MediaMetadataRetriever`) si prova sul telefono.
 */
public class MiniaturaVideoTest {

    private static String leggiTs(String relativo) throws IOException {
        File cartella = new File("").getAbsoluteFile();
        for (int i = 0; i < 8 && cartella != null; i++) {
            File file = new File(cartella, relativo);
            if (file.isFile()) return new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
            cartella = cartella.getParentFile();
        }
        throw new AssertionError("non trovo " + relativo);
    }

    @Test
    public void ilFotogrammaSiPrendeDopoUnSecondoSeIlVideoDuraAlmenoDueSecondi() {
        assertEquals(1_000_000L, MiniaturaVideo.istanteFotogrammaUs(2_000L));
        assertEquals(1_000_000L, MiniaturaVideo.istanteFotogrammaUs(300_000L));
        assertEquals("sotto i due secondi: il primo fotogramma", 0L, MiniaturaVideo.istanteFotogrammaUs(1_999L));
        assertEquals(0L, MiniaturaVideo.istanteFotogrammaUs(500L));
        assertEquals("durata ignota: il primo fotogramma, che c'è sempre", 0L, MiniaturaVideo.istanteFotogrammaUs(-1L));
        assertEquals(0L, MiniaturaVideo.istanteFotogrammaUs(0L));
    }

    @Test
    public void conUnaRotazioneDi90O270LeDimensioniSiScambiano() {
        assertArrayEquals(new int[]{1920, 1080}, MiniaturaVideo.dimensioniVisualizzate(1920, 1080, 0));
        assertArrayEquals("un video girato in verticale è memorizzato per traverso", new int[]{1080, 1920}, MiniaturaVideo.dimensioniVisualizzate(1920, 1080, 90));
        assertArrayEquals(new int[]{1920, 1080}, MiniaturaVideo.dimensioniVisualizzate(1920, 1080, 180));
        assertArrayEquals(new int[]{1080, 1920}, MiniaturaVideo.dimensioniVisualizzate(1920, 1080, 270));
        assertArrayEquals("360 è un giro intero", new int[]{1920, 1080}, MiniaturaVideo.dimensioniVisualizzate(1920, 1080, 360));
        assertArrayEquals("-90 è 270", new int[]{1080, 1920}, MiniaturaVideo.dimensioniVisualizzate(1920, 1080, -90));
        assertArrayEquals(new int[]{1080, 1920}, MiniaturaVideo.dimensioniVisualizzate(1920, 1080, 450));
    }

    @Test
    public void ilDataUrlHaLaFormaCheLoSchemaDelPonteAccetta() {
        byte[] jpeg = new byte[]{(byte) 0xFF, (byte) 0xD8, (byte) 0xFF, (byte) 0xE0, 0, 16, 'J', 'F', 'I', 'F', 0, 1, 1, 0, 0, 1, 0, 1};
        String url = MiniaturaVideo.dataUrl(jpeg);
        assertTrue(url, url.startsWith("data:image/jpeg;base64,"));
        // La stessa espressione di `schemaMiniatura` (caricamenti-nativi-tipi.ts).
        assertTrue(url, Pattern.compile("^data:image/jpeg;base64,[A-Za-z0-9+/]+={0,2}$").matcher(url).matches());
        assertArrayEquals(jpeg, Base64.getDecoder().decode(url.substring(MiniaturaVideo.PREFISSO_DATA_URL.length())));
    }

    @Test
    public void ilLatoDellaMiniaturaEQuelloDelContratto() throws Exception {
        Matcher m = Pattern.compile("export const LATO_MINIATURA_VIDEO = (\\d+)").matcher(leggiTs("src/lib/native/caricamenti-nativi-tipi.ts"));
        assertTrue(m.find());
        assertEquals("il lato lungo della miniatura sta in `caricamenti-nativi-tipi.ts` e qui: un test li confronta", Integer.parseInt(m.group(1)),
                MiniaturaVideo.LATO_MASSIMO);
    }

    @Test
    public void unaAnalisiSconosciutaDiceNonLoSo() {
        assertEquals(-1L, MiniaturaVideo.Analisi.SCONOSCIUTA.durataMs);
        assertNull(MiniaturaVideo.Analisi.SCONOSCIUTA.miniatura);
    }
}
