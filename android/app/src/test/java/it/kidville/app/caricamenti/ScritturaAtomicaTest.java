package it.kidville.app.caricamenti;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import androidx.core.util.AtomicFile;

import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * La scrittura atomica che si VERIFICA (spec §4.6; compito A2, secondario n. 45): sul telefono `AtomicFile.finishWrite` non lancia se la
 * rinomina fallisce, e chi scriveva `finishWrite(uscita); return true;` dichiarava «scritto» un file che sul disco non c'era.
 *
 * Nella JVM l'`AtomicFile` vero LANCIA in quel caso (`Log.e` «not mocked»), quindi per provare il ramo del telefono si usa
 * `AtomicFileCheNonTrasloca`, che si comporta come lui: chiude il file nuovo e non lancia, senza rinominarlo.
 */
public class ScritturaAtomicaTest {

    @Rule
    public TemporaryFolder temporanea = new TemporaryFolder();

    private File base;

    @Before
    public void preparaIlFile() throws IOException {
        base = new File(temporanea.newFolder("c"), "dato.json");
    }

    private static byte[] byteDi(String testo) {
        return testo.getBytes(StandardCharsets.UTF_8);
    }

    @Test
    public void unaScritturaRiuscitaEVerificataRestituisceNullEIlFileEQuelloScritto() throws Exception {
        assertNull(ScritturaAtomica.scrivi(new AtomicFile(base), byteDi("uno")));
        assertArrayEquals(byteDi("uno"), Files.readAllBytes(base.toPath()));
        assertNull(ScritturaAtomica.scrivi(new AtomicFile(base), byteDi("due, più lungo")));
        assertArrayEquals("la seconda scrittura rimpiazza la prima", byteDi("due, più lungo"), Files.readAllBytes(base.toPath()));
    }

    @Test
    public void laCartellaMancanteSiCreaDaSola() {
        File profonda = new File(temporanea.getRoot(), "a/b/c/dato.json");
        assertNull(ScritturaAtomica.scrivi(new AtomicFile(profonda), byteDi("x")));
        assertTrue(profonda.isFile());
    }

    @Test
    public void unaRinominaCheSulTelefonoFallisceSenzaLanciareNonVieneDichiarataRiuscita() throws Exception {
        // Il file base c'è con un contenuto vecchio; `finishWrite` non lancia e non rinomina, come sul telefono quando renameTo dà falso.
        assertNull(ScritturaAtomica.scrivi(new AtomicFile(base), byteDi("vecchio")));
        AtomicFileCheNonTrasloca nonTrasloca = new AtomicFileCheNonTrasloca(base, false);
        IOException errore = ScritturaAtomica.scrivi(nonTrasloca, byteDi("nuovo"));
        assertNotNull("sul telefono nessuna eccezione: è la verifica a dire che non è andata", errore);
        assertEquals("la rinomina è stata tentata (e saltata) una volta", 1, nonTrasloca.rinominePerse);
        assertArrayEquals("il file sul disco è ancora quello di prima", byteDi("vecchio"), Files.readAllBytes(base.toPath()));
    }

    @Test
    public void unaRinominaMancataSenzaUnFileDiPartenzaLasciaIlFileAssenteENonLoDiceRiuscito() {
        AtomicFileCheNonTrasloca nonTrasloca = new AtomicFileCheNonTrasloca(base, false);
        IOException errore = ScritturaAtomica.scrivi(nonTrasloca, byteDi("nuovo"));
        assertNotNull(errore);
        assertFalse("il file base non è mai nato", base.exists());
    }

    @Test
    public void unaCartellaAlPostoDelFileBaseFaFallireLaScritturaENonLancia() throws Exception {
        // Il file base è una CARTELLA con dentro un file: `startWrite` crea il `.new` accanto, ma la rinomina su una cartella non vuota
        // fallisce (e `AtomicFile.rename` prova prima a cancellarla; nella JVM il suo `Log.e` lancia). Non lancia verso chi scrive: il
        // valore restituito dice che non è riuscita.
        assertTrue(base.mkdirs());
        assertTrue(new File(base, "dentro").createNewFile());
        IOException errore = ScritturaAtomica.scrivi(new AtomicFile(base), byteDi("x"));
        assertNotNull(errore);
        assertTrue("il contenuto che c'era non si è perso", new File(base, "dentro").exists());
    }

    @Test
    public void laVerificaConfrontaIByteENonSoloLaLunghezza() throws Exception {
        assertNull(ScritturaAtomica.scrivi(new AtomicFile(base), byteDi("abcd")));
        assertNull(ScritturaAtomica.verifica(new AtomicFile(base), byteDi("abcd")));
        assertNotNull("stessa lunghezza, byte diversi", ScritturaAtomica.verifica(new AtomicFile(base), byteDi("abce")));
        assertNotNull("più corto", ScritturaAtomica.verifica(new AtomicFile(base), byteDi("abc")));
        assertNotNull("più lungo", ScritturaAtomica.verifica(new AtomicFile(base), byteDi("abcde")));
        assertTrue(base.delete());
        assertNotNull("file assente", ScritturaAtomica.verifica(new AtomicFile(base), byteDi("abcd")));
    }

    @Test
    public void unaRinominaMancataOgniVoltaNonLasciaMaiUnFileBaseAMeta() throws Exception {
        // Dieci scritture «che non traslocano»: nessuna dichiarata riuscita e il file base non cambia mai.
        assertNull(ScritturaAtomica.scrivi(new AtomicFile(base), byteDi("stabile")));
        AtomicFileCheNonTrasloca nonTrasloca = new AtomicFileCheNonTrasloca(base, false);
        for (int i = 0; i < 10; i++) {
            assertNotNull("scrittura " + i, ScritturaAtomica.scrivi(nonTrasloca, byteDi("tentativo " + i)));
            assertArrayEquals(byteDi("stabile"), Files.readAllBytes(base.toPath()));
        }
        // Riaccesa la rinomina, la scrittura successiva riesce e ripulisce.
        nonTrasloca.traslocaDavvero = true;
        assertNull(ScritturaAtomica.scrivi(nonTrasloca, byteDi("finalmente")));
        assertArrayEquals(byteDi("finalmente"), Files.readAllBytes(base.toPath()));
    }
}
