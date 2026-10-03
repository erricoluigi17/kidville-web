package it.kidville.app.caricamenti;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.junit.Assume;
import org.junit.Test;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;

/**
 * Il manifest e i sorgenti nativi dei caricamenti (spec §6.4, §9; compito A2): i permessi e i servizi che il motore pretende, e i
 * permessi che NON deve mai chiedere.
 *
 * 🔴 IL VANTAGGIO DA PROTEGGERE (`docs/submission/C2-build-aab.md`, §7): nessun permesso di lettura o scrittura dei media né dello
 * spazio esterno. Dichiararne uno farebbe entrare un'app con foto di bambini nella policy «Foto e video» di Google Play. Il selettore
 * dei media (Photo Picker / SAF) non ne ha bisogno. Si controlla nel manifest dei sorgenti, in quello FUSO (se la build lo ha prodotto)
 * e in tutti i sorgenti Java del modulo. I nomi vietati sono costruiti per pezzi, così nemmeno questo file li contiene per intero.
 */
public class ManifestCaricamentiTest {

    private static final String NS_ANDROID = "http://schemas.android.com/apk/res/android";
    private static final String NS_TOOLS = "http://schemas.android.com/tools";

    /** I permessi che il manifest di un'app con foto di bambini non deve mai dichiarare: costruiti per pezzi. */
    private static final List<String> PERMESSI_VIETATI = Arrays.asList(
            "READ_" + "MEDIA_IMAGES", "READ_" + "MEDIA_VIDEO", "READ_" + "MEDIA_AUDIO", "READ_" + "MEDIA_VISUAL_USER_SELECTED",
            "READ_" + "EXTERNAL_STORAGE", "WRITE_" + "EXTERNAL_STORAGE", "ACCESS_" + "MEDIA_LOCATION", "MANAGE_" + "EXTERNAL_STORAGE");

    private static File moduloApp() {
        File cartella = new File("").getAbsoluteFile();
        for (int i = 0; i < 6 && cartella != null; i++) {
            if (new File(cartella, "src/main/AndroidManifest.xml").isFile()) return cartella;
            File figlia = new File(cartella, "app");
            if (new File(figlia, "src/main/AndroidManifest.xml").isFile()) return figlia;
            cartella = cartella.getParentFile();
        }
        throw new AssertionError("non trovo il modulo `app` partendo da " + new File("").getAbsolutePath());
    }

    private static Document leggiManifest(File file) throws Exception {
        DocumentBuilderFactory fabbrica = DocumentBuilderFactory.newInstance();
        fabbrica.setNamespaceAware(true);
        DocumentBuilder costruttore = fabbrica.newDocumentBuilder();
        return costruttore.parse(file);
    }

    private static Set<String> permessiDichiarati(Document manifest) {
        Set<String> nomi = new HashSet<>();
        NodeList elenco = manifest.getElementsByTagName("uses-permission");
        for (int i = 0; i < elenco.getLength(); i++) {
            nomi.add(((Element) elenco.item(i)).getAttributeNS(NS_ANDROID, "name"));
        }
        return nomi;
    }

    private static Element servizio(Document manifest, String nome) {
        NodeList servizi = manifest.getElementsByTagName("service");
        for (int i = 0; i < servizi.getLength(); i++) {
            Element s = (Element) servizi.item(i);
            if (nome.equals(s.getAttributeNS(NS_ANDROID, "name"))) return s;
        }
        return null;
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL MANIFEST DEI SORGENTI
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void ilManifestDichiaraIPermessiDelMotoreEDellaPausa() throws Exception {
        Document manifest = leggiManifest(new File(moduloApp(), "src/main/AndroidManifest.xml"));
        Set<String> permessi = permessiDichiarati(manifest);
        assertTrue(permessi.toString(), permessi.contains("android.permission.INTERNET"));
        assertTrue("il servizio in primo piano (API 24-33, e il tipo dal 34)", permessi.contains("android.permission.FOREGROUND_SERVICE"));
        assertTrue("il tipo `dataSync` del servizio in primo piano", permessi.contains("android.permission.FOREGROUND_SERVICE_DATA_SYNC"));
        assertTrue("il job UIDT (API 34+)", permessi.contains("android.permission.RUN_USER_INITIATED_JOBS"));
    }

    @Test
    public void laRadiceDichiaraTools() throws Exception {
        Document manifest = leggiManifest(new File(moduloApp(), "src/main/AndroidManifest.xml"));
        assertEquals("xmlns:tools serve al `tools:node` del servizio di WorkManager", NS_TOOLS,
                manifest.getDocumentElement().lookupNamespaceURI("tools"));
    }

    @Test
    public void ilServizioInPrimoPianoDiWorkManagerHaIlTipoDataSyncEUnisceSenzaSostituire() throws Exception {
        Document manifest = leggiManifest(new File(moduloApp(), "src/main/AndroidManifest.xml"));
        Element s = servizio(manifest, "androidx.work.impl.foreground.SystemForegroundService");
        assertNotNull("manca la dichiarazione del tipo del servizio in primo piano di WorkManager", s);
        assertEquals("dataSync", s.getAttributeNS(NS_ANDROID, "foregroundServiceType"));
        assertEquals("`merge`: aggiunge l'attributo alla dichiarazione della libreria, non la sostituisce", "merge", s.getAttributeNS(NS_TOOLS, "node"));
    }

    @Test
    public void ilServizioUidtPretendeIlPermessoDiBindDelSistemaENonEEsportato() throws Exception {
        Document manifest = leggiManifest(new File(moduloApp(), "src/main/AndroidManifest.xml"));
        Element s = servizio(manifest, ".caricamenti.ServizioCaricamentiUidt");
        assertNotNull("manca il servizio del job UIDT", s);
        assertEquals("android.permission.BIND_JOB_SERVICE", s.getAttributeNS(NS_ANDROID, "permission"));
        assertEquals("false", s.getAttributeNS(NS_ANDROID, "exported"));
        // E la classe esiste, ed è un JobService.
        File sorgente = new File(moduloApp(), "src/main/java/it/kidville/app/caricamenti/ServizioCaricamentiUidt.java");
        assertTrue(sorgente.isFile());
        assertTrue(leggi(sorgente).contains("extends JobService"));
    }

    @Test
    public void ilManifestNonDichiaraNessunPermessoSuiMediaNeSulloSpazioEsterno() throws Exception {
        Document manifest = leggiManifest(new File(moduloApp(), "src/main/AndroidManifest.xml"));
        for (String permesso : permessiDichiarati(manifest)) {
            for (String vietato : PERMESSI_VIETATI) {
                assertFalse("il manifest dichiara «" + permesso + "»: un'app con foto di bambini non chiede permessi sui media", permesso.endsWith(vietato));
            }
        }
        String testo = leggi(new File(moduloApp(), "src/main/AndroidManifest.xml"));
        for (String vietato : PERMESSI_VIETATI) assertFalse("«" + vietato + "» compare nel testo del manifest (anche in un commento)", testo.contains(vietato));
    }

    @Test
    public void ilManifestMantieneIlBackupSpentoELActivityDellApp() throws Exception {
        // Non è ciò che A2 ha toccato, ma i due punti su cui un'aggiunta al manifest può fare danni (altri lock li provano a fondo).
        Document manifest = leggiManifest(new File(moduloApp(), "src/main/AndroidManifest.xml"));
        Element applicazione = (Element) manifest.getElementsByTagName("application").item(0);
        assertEquals("false", applicazione.getAttributeNS(NS_ANDROID, "allowBackup"));
        NodeList attivita = manifest.getElementsByTagName("activity");
        boolean mainActivity = false;
        for (int i = 0; i < attivita.getLength(); i++) {
            if (".MainActivity".equals(((Element) attivita.item(i)).getAttributeNS(NS_ANDROID, "name"))) mainActivity = true;
        }
        assertTrue(mainActivity);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL MANIFEST FUSO (se la build lo ha prodotto)
     * ──────────────────────────────────────────────────────────────────────────── */

    private static File manifestFuso() {
        File f = new File(moduloApp(), "build/intermediates/merged_manifest/debug/processDebugMainManifest/AndroidManifest.xml");
        return f;
    }

    @Test
    public void ilManifestFusoDebugHaPermessiEServiziDelMotoreESenzaPermessiMedia() throws Exception {
        File fuso = manifestFuso();
        Assume.assumeTrue("la build non ha ancora prodotto il manifest fuso: lo verifica `assembleDebug`", fuso.isFile());
        Document manifest = leggiManifest(fuso);
        Set<String> permessi = permessiDichiarati(manifest);
        for (String atteso : new String[]{"android.permission.FOREGROUND_SERVICE", "android.permission.FOREGROUND_SERVICE_DATA_SYNC",
                "android.permission.RUN_USER_INITIATED_JOBS", "android.permission.RECEIVE_BOOT_COMPLETED"}) {
            assertTrue("manca nel manifest fuso: " + atteso + " (`RECEIVE_BOOT_COMPLETED` arriva da WorkManager e serve a `setPersisted(true)`)", permessi.contains(atteso));
        }
        for (String permesso : permessi) {
            for (String vietato : PERMESSI_VIETATI) assertFalse("manifest fuso: «" + permesso + "»", permesso.endsWith(vietato));
        }
        Element sfp = servizio(manifest, "androidx.work.impl.foreground.SystemForegroundService");
        assertNotNull(sfp);
        assertEquals("dataSync", sfp.getAttributeNS(NS_ANDROID, "foregroundServiceType"));
        Element uidt = servizio(manifest, "it.kidville.app.caricamenti.ServizioCaricamentiUidt");
        assertNotNull("il servizio UIDT, col nome completo nel manifest fuso", uidt);
        assertEquals("android.permission.BIND_JOB_SERVICE", uidt.getAttributeNS(NS_ANDROID, "permission"));
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * I SORGENTI JAVA DEL MODULO
     * ──────────────────────────────────────────────────────────────────────────── */

    private static String leggi(File f) throws IOException {
        return new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
    }

    private static List<File> sorgentiJava() throws IOException {
        Path radice = new File(moduloApp(), "src/main/java").toPath();
        try (Stream<Path> tutti = Files.walk(radice)) {
            return tutti.filter(p -> p.toString().endsWith(".java")).map(Path::toFile).collect(Collectors.toList());
        }
    }

    @Test
    public void nessunSorgenteDelModuloNominaUnPermessoSuiMedia() throws Exception {
        List<File> sorgenti = sorgentiJava();
        assertTrue("la scansione non vede i sorgenti", sorgenti.size() > 10);
        for (File f : sorgenti) {
            String testo = leggi(f);
            for (String vietato : PERMESSI_VIETATI) assertFalse(f.getName() + " nomina «" + vietato + "»", testo.contains(vietato));
        }
    }

    @Test
    public void iSorgentiDeiCaricamentiNonTocCanoMaiLArchivioDeiCookieNeIniettanoJavaScript() throws Exception {
        // Le stesse regole del lock `cookie-sessione-persistito-android` (vitest), che qui non gira: le classi nuove non nominano mai
        // l'archivio dei cookie (le chiamate native non usano la sessione della WebView) né i canali da cui un cookie esce.
        Pattern accesso = Pattern.compile("\\bgetCookie\\b|\\bsetCookie\\b|\\bhasCookies\\b|document\\s*\\.\\s*cookie");
        Pattern canaleJs = Pattern.compile("\\bevaluateJavascript\\b|\\bjavascript\\s*:", Pattern.CASE_INSENSITIVE);
        Pattern archivio = Pattern.compile("\\bCookieManager\\b");
        int visti = 0;
        for (File f : sorgentiJava()) {
            if (!f.getPath().contains("/caricamenti/")) continue;
            visti++;
            String testo = leggi(f);
            assertFalse(f.getName() + " accede al valore dei cookie", accesso.matcher(testo).find());
            assertFalse(f.getName() + " inietta JavaScript nella WebView", canaleJs.matcher(testo).find());
            assertFalse(f.getName() + " nomina l'archivio dei cookie", archivio.matcher(testo).find());
        }
        assertTrue("la scansione non vede le classi dei caricamenti", visti >= 11);
    }

    @Test
    public void leClassiNuoveNonUsanoMaiConsoleNeStampaNeUnLogDiUnaStringaLibera() throws Exception {
        // Il solo posto dove si scrive in logcat è `Log.w/e` con la CLASSE di un'eccezione; mai `System.out`, mai `printStackTrace` (che
        // stampa il messaggio, con percorsi o indirizzi), mai `Log.d/i/v` di dati.
        Pattern vietati = Pattern.compile("System\\s*\\.\\s*(out|err)|printStackTrace|\\bLog\\s*\\.\\s*[div]\\s*\\(");
        List<String> colpevoli = new ArrayList<>();
        for (File f : sorgentiJava()) {
            if (!f.getPath().contains("/caricamenti/")) continue;
            if (vietati.matcher(leggi(f)).find()) colpevoli.add(f.getName());
        }
        assertTrue("log vietati in: " + colpevoli, colpevoli.isEmpty());
    }

    @Test
    public void nelleChiamateDiLogDelNativoNonCompaionoMaiNomiDiFileUrlTokenOHash() throws Exception {
        // Le chiamate `Log.w` / `Log.e` e `guasto(...)` dei sorgenti di produzione portano al più una costante e il NOME DELLA CLASSE
        // di un'eccezione (`getSimpleName()`): niente `getMessage`, `toString` di un'eccezione, percorsi, indirizzi, token.
        Pattern chiamata = Pattern.compile("(Log\\s*\\.\\s*[we]\\s*\\([^;]*;)|(\\.guasto\\s*\\([^;]*;)", Pattern.DOTALL);
        List<String> colpevoli = new ArrayList<>();
        for (File f : sorgentiJava()) {
            if (!f.getPath().contains("/caricamenti/")) continue;
            java.util.regex.Matcher m = chiamata.matcher(leggi(f));
            while (m.find()) {
                String testo = m.group();
                if (testo.contains("getMessage") || testo.contains("getLocalizedMessage") || testo.contains("getAbsolutePath") || testo.contains("getPath")
                        || testo.contains("token") || testo.contains("url") || testo.contains("sha256") || testo.contains("nome")) {
                    colpevoli.add(f.getName() + ": " + testo.replaceAll("\\s+", " "));
                }
            }
        }
        assertTrue("dati in una riga di log: " + colpevoli, colpevoli.isEmpty());
    }
}
