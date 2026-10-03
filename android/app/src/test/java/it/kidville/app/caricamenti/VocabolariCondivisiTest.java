package it.kidville.app.caricamenti;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import it.kidville.app.caricamenti.CodaCaricamenti.Origine;
import it.kidville.app.caricamenti.CodaCaricamenti.VoceCoda;
import it.kidville.app.caricamenti.PoliticaCaricamento.Codice;
import it.kidville.app.caricamenti.PoliticaCaricamento.Motore;
import it.kidville.app.caricamenti.PoliticaCaricamento.Stato;
import it.kidville.app.caricamenti.RegistroNativo.Campo;
import it.kidville.app.caricamenti.RegistroNativo.Evento;

import org.json.JSONObject;
import org.junit.Test;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * I NOMI SONO UNA FONTE SOLA: ciò che il nativo dice al JavaScript e al server deve coincidere, lettera per lettera, con ciò che
 * il JavaScript e il server si aspettano (spec §4.2, §8.2; compito A1: «nomi di stati, codici ed eventi IDENTICI a
 * `src/lib/native/caricamenti-nativi-tipi.ts`»).
 *
 * Il test RILEGGE i due file veri del repository (`caricamenti-nativi-tipi.ts` e il server finto di collaudo
 * `scripts/collaudo-caricamenti/server.mjs`) ed estrae gli elenchi con un'espressione regolare: un elenco copiato qui dentro
 * non potrebbe dire «manca». È la sola prova automatica di questa parità finché il lock di J4 (`caricamenti-nativi-agganciati`,
 * in vitest) non esiste.
 *
 * ⚠️ Gradle non sa che questo test legge quei due file: se si cambia SOLO il file TypeScript, `testDebugUnitTest` risulta
 * «UP-TO-DATE» e non rigira. Dopo una modifica ai vocabolari si rilancia con `--rerun-tasks` o `cleanTestDebugUnitTest`.
 */
public class VocabolariCondivisiTest {

    private static File radiceDelRepository() {
        File cartella = new File("").getAbsoluteFile();
        for (int i = 0; i < 8 && cartella != null; i++) {
            if (new File(cartella, "src/lib/native/caricamenti-nativi-tipi.ts").isFile()) return cartella;
            cartella = cartella.getParentFile();
        }
        throw new AssertionError("non trovo la radice del repository partendo da " + new File("").getAbsolutePath());
    }

    private static String leggi(String relativo) throws IOException {
        File file = new File(radiceDelRepository(), relativo);
        assertTrue("manca " + relativo, file.isFile());
        return new String(java.nio.file.Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
    }

    /** Gli elementi stringa di `export const NOME = [ 'a', 'b', ... ] as const` (TypeScript) o `const NOME = [ 'a', ... ]` (JavaScript). */
    private static List<String> elencoDi(String sorgente, String nome) {
        Matcher m = Pattern.compile("(?:export\\s+)?const\\s+" + Pattern.quote(nome) + "\\s*=\\s*\\[(.*?)\\]", Pattern.DOTALL).matcher(sorgente);
        assertTrue("non trovo l'elenco " + nome, m.find());
        String corpo = m.group(1).replaceAll("(?m)//.*$", "");
        List<String> voci = new ArrayList<>();
        Matcher q = Pattern.compile("'([^']*)'").matcher(corpo);
        while (q.find()) voci.add(q.group(1));
        assertTrue("l'elenco " + nome + " è vuoto: l'estrazione non funziona", !voci.isEmpty());
        return voci;
    }

    private static List<String> valoriDegliStati() {
        List<String> valori = new ArrayList<>();
        for (Stato stato : Stato.values()) valori.add(stato.valore());
        return valori;
    }

    private static List<String> nomiDeiCodici() {
        List<String> nomi = new ArrayList<>();
        for (Codice codice : Codice.values()) nomi.add(codice.name());
        return nomi;
    }

    private static List<String> slugDegliEventi() {
        List<String> slug = new ArrayList<>();
        for (Evento evento : Evento.values()) slug.add(evento.slug());
        return slug;
    }

    private static List<String> chiaviDeiCampi() {
        List<String> chiavi = new ArrayList<>();
        for (Campo campo : Campo.values()) chiavi.add(campo.chiave());
        return chiavi;
    }

    /**
     * Nessuno scarto: `put-oltre-scadenza` è entrato in `EVENTI_LOG_NATIVI` (TypeScript), in §8.2 e nel server finto il 03/10, dopo
     * l'ondata 2. Un messaggio nostro che il contratto non conosce è un difetto, e il test lo dice.
     */
    private static final Set<String> SLUG_NON_ANCORA_NEL_CONTRATTO = Collections.emptySet();
    /**
     * Nessuno scarto: dal 03/10 `CHIAVI_CAMPI_NATIVI` del server finto di collaudo (`scripts/collaudo-caricamenti/server.mjs`) ha anche
     * `voci_scartate` (il numero di voci fuori forma che `coda-nativa-corrotta` porta, spec §4.6) e `durata_s`. Una chiave nostra che il
     * server finto non conosce farebbe segnare `LOG_CHIAVE_NON_AMMESSA` allo scenario S12 di C1: qui diventa rossa prima.
     */
    private static final Set<String> CHIAVI_NON_ANCORA_NEL_SERVER_FINTO = Collections.emptySet();

    @Test
    public void gliStatiSonoQuelliDiStatiNativi() throws Exception {
        assertEquals(elencoDi(leggi("src/lib/native/caricamenti-nativi-tipi.ts"), "STATI_NATIVI"), valoriDegliStati());
    }

    @Test
    public void iCodiciSonoQuelliDiCodiciNativi() throws Exception {
        assertEquals(elencoDi(leggi("src/lib/native/caricamenti-nativi-tipi.ts"), "CODICI_NATIVI"), nomiDeiCodici());
    }

    @Test
    public void iMotoriChePuoDireAndroidSonoFraQuelliDiMotoriCaricamenti() throws Exception {
        List<String> motori = elencoDi(leggi("src/lib/native/caricamenti-nativi-tipi.ts"), "MOTORI_CARICAMENTI");
        for (Motore motore : Motore.values()) assertTrue(motore.valore(), motori.contains(motore.valore()));
        // E la coppia piattaforma/motore del contratto: su Android solo questi due.
        String sorgente = leggi("src/lib/native/caricamenti-nativi-tipi.ts");
        assertTrue(sorgente.contains("android: ['uidt', 'workmanager']"));
    }

    @Test
    public void gliEventiDiLogCoprononoTuttiQuelliDelContrattoEQuelloInPiuEDichiarato() throws Exception {
        List<String> contratto = elencoDi(leggi("src/lib/native/caricamenti-nativi-tipi.ts"), "EVENTI_LOG_NATIVI");
        Set<String> nostri = new LinkedHashSet<>(slugDegliEventi());
        assertEquals("i quindici messaggi di §8.2 (con put-oltre-scadenza, dopo S0)", 15, contratto.size());
        assertTrue("ogni messaggio del contratto è un evento del registro: " + contratto, nostri.containsAll(contratto));
        Set<String> inPiu = new LinkedHashSet<>(nostri);
        inPiu.removeAll(contratto);
        assertTrue("messaggi che il contratto non conosce: " + inPiu + " (vanno aggiunti a EVENTI_LOG_NATIVI, alla spec e al PRD)",
                SLUG_NON_ANCORA_NEL_CONTRATTO.containsAll(inPiu));
    }

    @Test
    public void ilServerFintoDiCollaudoConosceGliStessiMessaggiEGliStessiCampi() throws Exception {
        String server = leggi("scripts/collaudo-caricamenti/server.mjs");
        List<String> messaggi = elencoDi(server, "MESSAGGI_NATIVI");
        List<String> contratto = elencoDi(leggi("src/lib/native/caricamenti-nativi-tipi.ts"), "EVENTI_LOG_NATIVI");
        assertEquals("S2 e S1 hanno lo stesso elenco di messaggi", new HashSet<>(contratto), new HashSet<>(messaggi));
        Set<String> slugInPiu = new LinkedHashSet<>(slugDegliEventi());
        slugInPiu.removeAll(messaggi);
        assertTrue("messaggi che S2 giudicherebbe violazioni: " + slugInPiu, SLUG_NON_ANCORA_NEL_CONTRATTO.containsAll(slugInPiu));

        List<String> chiaviServer = elencoDi(server, "CHIAVI_CAMPI_NATIVI");
        Set<String> nostre = new LinkedHashSet<>(chiaviDeiCampi());
        assertTrue("ogni chiave che il server finto ammette è un nostro campo: " + chiaviServer, nostre.containsAll(chiaviServer));
        Set<String> chiaviInPiu = new LinkedHashSet<>(nostre);
        chiaviInPiu.removeAll(chiaviServer);
        assertTrue("chiavi che S2 giudicherebbe violazioni: " + chiaviInPiu, CHIAVI_NON_ANCORA_NEL_SERVER_FINTO.containsAll(chiaviInPiu));
    }

    @Test
    public void laTabellaDelleTransizioniDelContrattoEUnSottoinsiemeDiQuellaNativa() throws Exception {
        String sorgente = leggi("src/lib/native/caricamenti-nativi-tipi.ts");
        Matcher blocco = Pattern.compile("export const TRANSIZIONI_STATO_NATIVO = \\{(.*?)\\} as const", Pattern.DOTALL).matcher(sorgente);
        assertTrue(blocco.find());
        Set<String> contratto = new HashSet<>();
        Matcher riga = Pattern.compile("(?m)^\\s*'?([a-z-]+)'?:\\s*\\[(.*?)\\],?\\s*$").matcher(blocco.group(1));
        int partenze = 0;
        while (riga.find()) {
            partenze++;
            Matcher q = Pattern.compile("'([^']*)'").matcher(riga.group(2));
            while (q.find()) contratto.add(riga.group(1) + ">" + q.group(1));
        }
        assertEquals("le sette partenze della tabella", 7, partenze);
        assertEquals("quindici frecce nel contratto (con in-coda → in-pausa)", 15, contratto.size());

        Set<String> nostre = new HashSet<>();
        for (Stato da : Stato.values()) {
            for (Stato a : Stato.values()) {
                if (PoliticaCaricamento.transizioneAmmessa(da, a)) nostre.add(da.valore() + ">" + a.valore());
            }
        }
        assertTrue("ogni freccia del contratto esiste nella politica nativa", nostre.containsAll(contratto));
        Set<String> inPiu = new HashSet<>(nostre);
        inPiu.removeAll(contratto);
        // Dal 03/10 (dopo l'ondata 2) la freccia `in-coda` → `in-pausa` di §6.2 sta anche nella tabella TypeScript: le due
        // tabelle sono la STESSA, e una freccia in più da una parte sola è un difetto.
        assertEquals("nessuna freccia in più nella politica nativa", Collections.emptySet(), inPiu);
    }

    @Test
    public void laValiditaDellUrlEQuellaDelContratto() throws Exception {
        Matcher m = Pattern.compile("export const VALIDITA_URL_PUT_SECONDI = (\\d+)").matcher(leggi("src/lib/native/caricamenti-nativi-tipi.ts"));
        assertTrue(m.find());
        assertEquals(Long.parseLong(m.group(1)), PoliticaCaricamento.VALIDITA_URL_PUT_SECONDI);
    }

    @Test
    public void ilJsonDelPonteHaEsattamenteICampiDiSchemaCaricamentoNativo() throws Exception {
        String sorgente = leggi("src/lib/native/caricamenti-nativi-tipi.ts");
        Matcher blocco = Pattern.compile("export const schemaCaricamentoNativo = z\\.object\\(\\{(.*?)\\n\\}\\)", Pattern.DOTALL).matcher(sorgente);
        assertTrue("non trovo schemaCaricamentoNativo", blocco.find());
        Set<String> campiDelloSchema = new HashSet<>();
        Matcher campo = Pattern.compile("(?m)^\\s*(\\w+):").matcher(blocco.group(1));
        while (campo.find()) campiDelloSchema.add(campo.group(1));
        assertEquals("i quattordici campi di CaricamentoNativo", 14, campiDelloSchema.size());

        VoceCoda v = new VoceCoda("00000001-1111-4111-8111-000000000001", "00000002-1111-4111-8111-000000000002",
                "00000003-1111-4111-8111-000000000003", "00000004-1111-4111-8111-000000000004");
        v.nome = "prova";
        v.file = "file/00000001-1111-4111-8111-000000000001.mp4";
        v.byteTotali = 10L;
        v.mime = "video/mp4";
        v.stato = Stato.IN_CODA;
        v.origine = Origine.GALLERIA;
        v.creatoIl = 1L;
        v.aggiornatoIl = 2L;
        JSONObject json = CodaCaricamenti.aJsonPonte(v, 0L);
        Set<String> nostri = new HashSet<>();
        Iterator<String> it = json.keys();
        while (it.hasNext()) nostri.add(it.next());
        assertEquals("campo per campo, né uno in più né uno in meno", campiDelloSchema, nostri);
    }

    @Test
    public void ilTestoDiRipiegoDelleNotificheStaNellaSpecAllaLettera() throws Exception {
        String spec = leggi("docs/superpowers/specs/2026-10-03-video-pr3-app-1-2-design.md");
        CodaCaricamenti.Testi t = CodaCaricamenti.Testi.predefiniti();
        for (String testo : Arrays.asList(t.titolo, t.invio, t.attesaRete, t.pausa)) {
            assertTrue("«" + testo + "» non è nella spec (§7.8)", spec.contains(testo));
        }
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * COMPITO A2: I NUMERI E I NOMI CHE IL NATIVO CONDIVIDE COL SERVER E COL JAVASCRIPT
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void ilTettoDeiByteDiUnVideoEQuelloDiLimitiTs() throws Exception {
        Matcher m = Pattern.compile("export const MAX_VIDEO_INPUT_BYTES = ([0-9_]+)").matcher(leggi("src/lib/media/video/limiti.ts"));
        assertTrue("non trovo MAX_VIDEO_INPUT_BYTES in limiti.ts", m.find());
        assertEquals("il ponte non deve mai uscire dal tetto che il JavaScript valida (schemaByteVideo, schemaByteInviati)",
                Long.parseLong(m.group(1).replace("_", "")), CodaCaricamenti.MAX_VIDEO_INPUT_BYTES);
    }

    @Test
    public void ilNomeDellIntestazioneDelTokenDiRinnovoEQuelloDelContratto() throws Exception {
        Matcher m = Pattern.compile("export const INTESTAZIONE_TOKEN_RINNOVO = '([^']+)'").matcher(leggi("src/lib/media/video/contratto.ts"));
        assertTrue(m.find());
        assertEquals(m.group(1), RinnovoFirma.INTESTAZIONE_TOKEN);
    }

    @Test
    public void leDuePorteChiamateDalNativoEsistonoNelServerEConIlPercorsoGiusto() throws Exception {
        File radice = radiceDelRepository();
        assertTrue("la route dei log", new File(radice, "src/app/api/logs/route.ts").isFile());
        assertTrue("la route del rinnovo", new File(radice, "src/app/api/video-uploads/rinnovo/route.ts").isFile());
        assertTrue(RegistroNativo.URL_REGISTRO_RELEASE.endsWith("/api/logs"));
        assertEquals("https://" + PoliticaCaricamento.HOST_SITO_RELEASE + "/api/logs", RegistroNativo.URL_REGISTRO_RELEASE);
        // L'identità dei log nativi viaggia nell'intestazione `x-user-id` (spec §2.2, A8) e `getRequestUserId` la legge.
        assertTrue(leggi("src/lib/auth/require-staff.ts").contains("x-user-id"));
        assertEquals("x-user-id", RegistroNativo.INTESTAZIONE_UTENTE);
    }

    @Test
    public void laSogliaDelRinnovoProattivoEQuellaDelContratto() throws Exception {
        Matcher m = Pattern.compile("export const ETA_MASSIMA_URL_PRIMA_DELLA_PUT_SECONDI = (\\d+)").matcher(leggi("src/lib/native/caricamenti-nativi-tipi.ts"));
        assertTrue(m.find());
        assertEquals("S0 (§3): la firma si verifica alla FINE della PUT, quindi si rinnova se l'URL ha più di 10 minuti", Long.parseLong(m.group(1)),
                PoliticaCaricamento.SOGLIA_RINNOVO_PROATTIVO_SECONDI);
    }

    @Test
    public void iTempiDelGuscioEDelRegistroSonoQuelliDellaSpec() {
        assertEquals("il worker aspetta la rete al più 10 minuti (§6.2)", 600L, PoliticaCaricamento.ATTESA_RETE_NEL_WORKER_SECONDI);
        assertEquals("al più un POST di log ogni 10 secondi (§8.1)", 10_000L, RegistroNativo.INTERVALLO_MINIMO_INVIO_MS);
        assertEquals("lotti di al più 20 eventi (§8.1)", 20, RegistroNativo.LOTTO_MASSIMO);
        assertEquals("tetto di 200 eventi sul disco (§4.6)", 200, RegistroNativo.TETTO_EVENTI);
        assertEquals("le voci terminali restano 7 giorni, e i file di una coda guasta con loro (§4.6)", CodaCaricamenti.RITENZIONE_TERMINALI_MS,
                CodaCaricamenti.RITENZIONE_CORROTTE_MS);
    }
}
