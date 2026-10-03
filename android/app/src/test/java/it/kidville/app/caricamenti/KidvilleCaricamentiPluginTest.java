package it.kidville.app.caricamenti;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import it.kidville.app.caricamenti.PianificatoreCaricamenti.CodiceRifiuto;

import org.junit.Test;

import java.io.File;
import java.io.IOException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * La facciata del plugin e il suo aggancio all'app (spec §4.1, §6.5, §7.1; compito A3): i metodi IDENTICI a quelli del contratto TypeScript,
 * il nome, il protocollo, i codici di rifiuto, il metodo di sola prova guardato da `BuildConfig.DEBUG`, `registerPlugin` PRIMA di
 * `super.onCreate`, la versione 1.2.
 *
 * Il test rilegge i file veri del repository (`caricamenti-nativi-tipi.ts`, `MainActivity.java`, `build.gradle`): un elenco copiato qui
 * non potrebbe dire «manca». Il lock `caricamenti-nativi-agganciati` di J4 (vitest) rifarà gli stessi confronti sui tre linguaggi; fino ad
 * allora questa è l'unica prova automatica lato Android.
 *
 * ⚠️ Gradle non sa che questo test legge quei file: se si cambia SOLO un file TypeScript, `testDebugUnitTest` risulta «UP-TO-DATE». Dopo una
 * modifica ai vocabolari si rilancia con `--rerun-tasks` o `cleanTestDebugUnitTest`.
 */
public class KidvilleCaricamentiPluginTest {

    private static File radice() {
        File cartella = new File("").getAbsoluteFile();
        for (int i = 0; i < 8 && cartella != null; i++) {
            if (new File(cartella, "src/lib/native/caricamenti-nativi-tipi.ts").isFile()) return cartella;
            cartella = cartella.getParentFile();
        }
        throw new AssertionError("non trovo la radice del repository partendo da " + new File("").getAbsolutePath());
    }

    private static String leggi(String relativo) throws IOException {
        File file = new File(radice(), relativo);
        assertTrue("manca " + relativo, file.isFile());
        return new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
    }

    private static final String PLUGIN = "android/app/src/main/java/it/kidville/app/caricamenti/KidvilleCaricamentiPlugin.java";
    private static final String ATTIVITA = "android/app/src/main/java/it/kidville/app/MainActivity.java";

    private static List<String> elencoTs(String nome) throws IOException {
        Matcher m = Pattern.compile("(?:export\\s+)?const\\s+" + Pattern.quote(nome) + "\\s*=\\s*\\[(.*?)\\]", Pattern.DOTALL)
                .matcher(leggi("src/lib/native/caricamenti-nativi-tipi.ts"));
        assertTrue("non trovo l'elenco " + nome, m.find());
        List<String> voci = new ArrayList<>();
        Matcher q = Pattern.compile("'([^']*)'").matcher(m.group(1).replaceAll("(?m)//.*$", ""));
        while (q.find()) voci.add(q.group(1));
        assertFalse(voci.isEmpty());
        return voci;
    }

    /** Il testo fra le graffe del metodo la cui firma contiene `firma` (la prima occorrenza, a partire dalla dichiarazione). */
    private static String corpoDi(String sorgente, String firma) {
        int inizio = sorgente.indexOf(firma);
        assertTrue("non trovo «" + firma + "»", inizio >= 0);
        int apertura = sorgente.indexOf('{', inizio);
        int profondita = 0;
        for (int i = apertura; i < sorgente.length(); i++) {
            char c = sorgente.charAt(i);
            if (c == '{') profondita++;
            if (c == '}') {
                profondita--;
                if (profondita == 0) return sorgente.substring(apertura + 1, i);
            }
        }
        throw new AssertionError("graffe sbilanciate dopo «" + firma + "»");
    }

    /** Toglie commenti e stringhe, per cercare nel CODICE e non nelle sue spiegazioni. */
    private static String senzaCommentiNeStringhe(String sorgente) {
        String s = sorgente.replaceAll("(?s)/\\*.*?\\*/", " ");
        s = s.replaceAll("(?m)//.*$", " ");
        return s.replaceAll("\"(?:\\\\.|[^\"\\\\])*\"", "\"\"");
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * I METODI
     * ──────────────────────────────────────────────────────────────────────────── */

    private static List<String> metodiConAnnotazione() {
        List<String> nomi = new ArrayList<>();
        for (Method metodo : KidvilleCaricamentiPlugin.class.getDeclaredMethods()) {
            if (metodo.isAnnotationPresent(PluginMethod.class)) nomi.add(metodo.getName());
        }
        Collections.sort(nomi);
        return nomi;
    }

    @Test
    public void iMetodiDelPluginSonoEsattamenteQuelliDelContrattoPiuQuelloDiSolaProva() throws Exception {
        List<String> contratto = new ArrayList<>(elencoTs("METODI_PLUGIN_CARICAMENTI"));
        assertEquals("i nove metodi di §4.2", 9, contratto.size());
        List<String> attesi = new ArrayList<>(contratto);
        attesi.add("creaElementoDiProva");
        Collections.sort(attesi);
        assertEquals(attesi, metodiConAnnotazione());
    }

    @Test
    public void ognunoDeiMetodiEPubblicoVoidEPrendeSoloLaChiamata() {
        for (Method metodo : KidvilleCaricamentiPlugin.class.getDeclaredMethods()) {
            if (!metodo.isAnnotationPresent(PluginMethod.class)) continue;
            assertTrue(metodo.getName() + " è pubblico: Capacitor indicizza solo i metodi pubblici", Modifier.isPublic(metodo.getModifiers()));
            assertEquals(metodo.getName(), void.class, metodo.getReturnType());
            assertEquals(metodo.getName(), Collections.singletonList(PluginCall.class), Arrays.asList(metodo.getParameterTypes()));
        }
    }

    @Test
    public void ilNomeDelPluginEQuelloDelContratto() throws Exception {
        CapacitorPlugin annotazione = KidvilleCaricamentiPlugin.class.getAnnotation(CapacitorPlugin.class);
        assertTrue("manca @CapacitorPlugin", annotazione != null);
        Matcher m = Pattern.compile("export const NOME_PLUGIN_CARICAMENTI = '([^']+)'").matcher(leggi("src/lib/native/caricamenti-nativi-tipi.ts"));
        assertTrue(m.find());
        assertEquals(m.group(1), annotazione.name());
        // E nel sorgente è un letterale accanto all'annotazione (il lock di J4 lo cerca lì).
        assertTrue(leggi(PLUGIN).contains("@CapacitorPlugin(name = \"" + m.group(1) + "\")"));
    }

    @Test
    public void ilProtocolloEQuelloDelContratto() throws Exception {
        Matcher m = Pattern.compile("export const PROTOCOLLO_CARICAMENTI = (\\d+)").matcher(leggi("src/lib/native/caricamenti-nativi-tipi.ts"));
        assertTrue(m.find());
        assertEquals(Integer.parseInt(m.group(1)), KidvilleCaricamentiPlugin.PROTOCOLLO);
    }

    @Test
    public void gliEventiSonoQuelliDelContratto() throws Exception {
        List<String> contratto = elencoTs("EVENTI_PLUGIN_CARICAMENTI");
        assertEquals(new HashSet<>(contratto), new HashSet<>(Arrays.asList(KidvilleCaricamentiPlugin.EVENTO_PREPARAZIONE, KidvilleCaricamentiPlugin.EVENTO_CARICAMENTO)));
    }

    @Test
    public void iCodiciDiRifiutoSonoEsattamenteQuelliDelContratto() throws Exception {
        List<String> contratto = elencoTs("CODICI_RIFIUTO_PONTE");
        List<String> nostri = new ArrayList<>();
        for (KidvilleCaricamentiPlugin.Rifiuto r : KidvilleCaricamentiPlugin.Rifiuto.values()) nostri.add(r.name());
        assertEquals(new HashSet<>(contratto), new HashSet<>(nostri));
        assertEquals("nessun doppione", contratto.size(), nostri.size());
        // I codici con cui il motore rifiuta `accodaVideo` esistono tutti fra quelli del ponte, con lo stesso nome.
        for (CodiceRifiuto dalMotore : CodiceRifiuto.values()) {
            assertEquals(dalMotore.name(), KidvilleCaricamentiPlugin.Rifiuto.da(dalMotore).name());
        }
    }

    @Test
    public void unSoloMetodoRiceveIlRisultatoDelSelettoreEIlSuoNomeEQuelloCheLoLancia() throws Exception {
        List<String> callback = new ArrayList<>();
        for (Method metodo : KidvilleCaricamentiPlugin.class.getDeclaredMethods()) {
            if (metodo.isAnnotationPresent(ActivityCallback.class)) callback.add(metodo.getName());
        }
        assertEquals(Collections.singletonList("risultatoSelettore"), callback);
        // Capacitor registra il lanciatore col NOME del metodo: se `startActivityForResult` dicesse un altro nome la chiamata verrebbe rifiutata.
        assertTrue(leggi(PLUGIN).contains("startActivityForResult(call, intent, \"risultatoSelettore\")"));
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL METODO DI SOLA PROVA
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void creaElementoDiProvaCominciaConLaGuardiaDiBuildConfigDebug() throws Exception {
        String codice = senzaCommentiNeStringhe(leggi(PLUGIN));
        String corpo = corpoDi(codice, "public void creaElementoDiProva(PluginCall call)").trim();
        assertTrue("la prima istruzione è la guardia: «" + corpo.substring(0, Math.min(60, corpo.length())) + "»",
                Pattern.compile("^if \\(!BuildConfig\\.DEBUG\\) \\{").matcher(corpo).find());
        String guardia = corpoDi(corpo, "if (!BuildConfig.DEBUG)");
        assertTrue("e nelle build di rilascio esce subito", guardia.contains("return;"));
        assertTrue("risponde «non implementato»", guardia.contains("call.unimplemented("));
    }

    @Test
    public void creaElementoDiProvaNonSiNominaFuoriDallaSuaGuardia() throws Exception {
        String codice = senzaCommentiNeStringhe(leggi(PLUGIN));
        Matcher m = Pattern.compile("\\bcreaProva\\b").matcher(codice);
        int dentro = 0;
        String corpo = corpoDi(codice, "public void creaElementoDiProva(PluginCall call)");
        int inizio = codice.indexOf(corpo);
        while (m.find()) {
            assertTrue("«creaProva» si usa solo dentro creaElementoDiProva (dopo la guardia)", m.start() >= inizio && m.start() <= inizio + corpo.length());
            dentro++;
        }
        assertTrue(dentro >= 1);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * MAINACTIVITY
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void registerPluginSiChiamaPrimaDiSuperOnCreate() throws Exception {
        String codice = senzaCommentiNeStringhe(leggi(ATTIVITA));
        String corpo = corpoDi(codice, "protected void onCreate(Bundle savedInstanceState)");
        int registrazione = corpo.indexOf("registerPlugin(KidvilleCaricamentiPlugin.class)");
        int super_ = corpo.indexOf("super.onCreate(savedInstanceState)");
        assertTrue("manca registerPlugin(KidvilleCaricamentiPlugin.class)", registrazione >= 0);
        assertTrue("manca super.onCreate", super_ >= 0);
        assertTrue("registerPlugin prima di super.onCreate: dopo, il ponte è già costruito e il plugin non esisterebbe", registrazione < super_);
        assertEquals("una registrazione sola", 1, corpo.split("registerPlugin\\(", -1).length - 1);
    }

    @Test
    public void onResumeRiprendeIcaricamentiSenzaPoterFarCadereLActivity() throws Exception {
        String codice = senzaCommentiNeStringhe(leggi(ATTIVITA));
        String corpo = corpoDi(codice, "public void onResume()");
        int superi = corpo.indexOf("super.onResume()");
        int ripresa = corpo.indexOf("PianificatoreCaricamenti.riprendiInPrimoPiano(this)");
        assertTrue(superi >= 0 && ripresa >= 0);
        assertTrue("prima il ciclo di vita di Capacitor, poi i caricamenti", superi < ripresa);
        assertTrue("dentro un try", corpo.indexOf("try") >= 0 && corpo.indexOf("try") < ripresa);
        assertTrue("con un catch di Throwable", Pattern.compile("catch \\(Throwable \\w+\\)").matcher(corpo).find());
        assertTrue("che lo dice in logcat", corpo.contains("Log.e("));
    }

    @Test
    public void onPauseRestaUnoSoloEIntatto() throws Exception {
        // Il lock `cookie-sessione-persistito-android` (vitest) prova il contenuto; qui si fissa solo che l'aggiunta di onCreate/onResume non
        // ne abbia fatto un secondo.
        String codice = senzaCommentiNeStringhe(leggi(ATTIVITA));
        assertEquals(1, codice.split("public void onPause\\(\\)", -1).length - 1);
        assertTrue(codice.contains("CookieManager.getInstance().flush()"));
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * LA VERSIONE
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void laVersioneEAlmenoLa12ConUnVersionCodeSopraQuelloDellaPubblicata() throws Exception {
        String gradle = leggi("android/app/build.gradle");
        Matcher nome = Pattern.compile("(?m)^\\s*versionName \"([^\"]+)\"").matcher(gradle);
        Matcher codice = Pattern.compile("(?m)^\\s*versionCode (\\d+)").matcher(gradle);
        assertTrue(nome.find());
        assertTrue(codice.find());
        assertEquals("la 1.2 (se il numero di versione sale, si aggiorna questo test insieme ai dettagli del rilascio)", "1.2", nome.group(1));
        assertTrue("il versionCode della 1.1 pubblicata è 3: la 1.2 ne vuole uno più alto", Integer.parseInt(codice.group(1)) >= 4);
        assertNotEquals("il vecchio versionName", "1.1", nome.group(1));
    }

    @Test
    public void ilPluginNonNominaMaiLArchivioDeiCookieNeIniettaCodiceNellaPagina() throws Exception {
        String testo = leggi(PLUGIN);
        assertFalse(Pattern.compile("\\bCookieManager\\b").matcher(testo).find());
        assertFalse(Pattern.compile("\\bevaluateJavascript\\b|\\bjavascript\\s*:", Pattern.CASE_INSENSITIVE).matcher(testo).find());
        Set<String> vietati = new HashSet<>(Arrays.asList("READ_" + "MEDIA_IMAGES", "READ_" + "MEDIA_VIDEO", "READ_" + "EXTERNAL_STORAGE",
                "WRITE_" + "EXTERNAL_STORAGE", "ACCESS_" + "MEDIA_LOCATION"));
        for (String v : vietati) assertFalse(v, testo.contains(v));
    }
}
