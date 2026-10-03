package it.kidville.app.caricamenti;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * Il sorgente di una classe del pacchetto, per i punti in cui il codice di produzione tocca Android (JobScheduler, WorkManager, i gusci)
 * e sulla JVM di JUnit non si può eseguire: lì un test non può provare il COMPORTAMENTO, ma può provare che il CODICE chiami ciò che deve
 * (e non chiami ciò che non deve), guardando il sorgente SENZA commenti — ciò che il codice fa, non ciò che dice di fare. È un cerotto
 * dichiarato, della stessa famiglia dei test che scandiscono i sorgenti in `ManifestCaricamentiTest`, e va usato solo dove manca di meglio:
 * la logica che si può estrarre in una funzione (e provare davvero) sta in `CicloDelGuscio`, `PresentazioneDelLavoro` e simili.
 */
final class SorgentiDiProva {

    private SorgentiDiProva() {
    }

    private static File moduloApp() {
        File cartella = new File("").getAbsoluteFile();
        for (int i = 0; i < 6 && cartella != null; i++) {
            if (new File(cartella, "src/main/java").isDirectory()) return cartella;
            File figlia = new File(cartella, "app");
            if (new File(figlia, "src/main/java").isDirectory()) return figlia;
            cartella = cartella.getParentFile();
        }
        throw new AssertionError("non trovo il modulo `app` partendo da " + new File("").getAbsolutePath());
    }

    /** Il sorgente di `classe` (nel pacchetto dei caricamenti) senza i commenti `/* ... *&#47;` e `// ...`. */
    static String codiceSenzaCommenti(String classe) throws IOException {
        File file = new File(moduloApp(), "src/main/java/it/kidville/app/caricamenti/" + classe + ".java");
        assertTrue("non trovo " + file, file.isFile());
        String testo = new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
        return testo.replaceAll("(?s)/\\*.*?\\*/", " ").replaceAll("(?m)(?<!:)//.*$", " ");
    }

    /**
     * Il corpo (fra le graffe, escluse) del primo metodo la cui intestazione contiene `intestazione`, in un codice già senza commenti.
     * Conta le graffe: i metodi di queste classi non hanno graffe dentro le stringhe.
     */
    static String corpoDi(String codice, String intestazione) {
        int inizio = codice.indexOf(intestazione);
        assertTrue("non trovo il metodo «" + intestazione + "»", inizio >= 0);
        int apre = codice.indexOf('{', inizio);
        assertTrue(apre >= 0);
        int profondita = 0;
        for (int i = apre; i < codice.length(); i++) {
            char c = codice.charAt(i);
            if (c == '{') profondita++;
            if (c == '}') {
                profondita--;
                if (profondita == 0) return codice.substring(apre + 1, i);
            }
        }
        assertNotNull("graffe non bilanciate dopo «" + intestazione + "»", null);
        return "";
    }
}
