package it.kidville.app.caricamenti;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import it.kidville.app.caricamenti.PoliticaCaricamento.Codice;
import it.kidville.app.caricamenti.PoliticaCaricamento.ErroreStorage;
import it.kidville.app.caricamenti.PoliticaCaricamento.EsitoRinnovo;
import it.kidville.app.caricamenti.PoliticaCaricamento.Motore;
import it.kidville.app.caricamenti.RegistroNativo.Da;
import it.kidville.app.caricamenti.RegistroNativo.ClasseErrore;
import it.kidville.app.caricamenti.RegistroNativo.EsitoInvio;
import it.kidville.app.caricamenti.RegistroNativo.EsitoSvuotamento;
import it.kidville.app.caricamenti.RegistroNativo.Evento;
import it.kidville.app.caricamenti.RegistroNativo.EventoRegistrato;
import it.kidville.app.caricamenti.RegistroNativo.Livello;
import it.kidville.app.caricamenti.RegistroNativo.MimeLog;
import it.kidville.app.caricamenti.RegistroNativo.MotivoPreparazione;
import it.kidville.app.caricamenti.RegistroNativo.Occasione;
import it.kidville.app.caricamenti.RegistroNativo.Operazione;
import it.kidville.app.caricamenti.RegistroNativo.RispostaTrasporto;
import it.kidville.app.caricamenti.RegistroNativo.TipoMedia;
import it.kidville.app.caricamenti.RegistroNativo.Trasporto;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Assume;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.lang.reflect.Method;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Deque;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Pattern;

/**
 * Il registro dei log nativi (spec §4.6, §8.1, §8.2, §9; compito A1): che ogni messaggio sia quello di §8.2, che il tipo non
 * lasci scrivere altro che enumerati e numeri, il tetto di 200, i lotti da 20, il ritmo di un POST ogni 10 secondi, le
 * risposte 2xx / 429 / 4xx / 5xx, il fail-open, e il trasporto HTTP vero contro un server locale.
 */
public class RegistroNativoTest {

    @Rule
    public TemporaryFolder temporanea = new TemporaryFolder();

    private File fileRegistro;
    private final AtomicLong orologio = new AtomicLong(1_790_000_000_000L);
    private DiagnosticaMemoria diagnostica;

    private static final String URL_SITO = "https://app.kidville.it/api/logs";
    private static final String VERSIONE = "1.2+4";

    @Before
    public void preparaFile() throws IOException {
        fileRegistro = new File(temporanea.newFolder("caricamenti"), "registro.json");
        diagnostica = new DiagnosticaMemoria();
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * UTENSILI
     * ──────────────────────────────────────────────────────────────────────────── */

    private static final class DiagnosticaMemoria implements RegistroNativo.Diagnostica {
        final List<String> voci = Collections.synchronizedList(new ArrayList<String>());
        volatile boolean lancia = false;

        @Override
        public void errore(String evento, Throwable causa) {
            voci.add(evento + ":" + (causa == null ? "-" : causa.getClass().getSimpleName()));
            if (lancia) throw new IllegalStateException("la diagnostica è caduta");
        }
    }

    private static final class Chiamata {
        final String url;
        final String utenteId;
        final String corpo;

        Chiamata(String url, String utenteId, String corpo) {
            this.url = url;
            this.utenteId = utenteId;
            this.corpo = corpo;
        }

        JSONObject json() throws Exception {
            return new JSONObject(corpo);
        }

        JSONArray eventi() throws Exception {
            return json().getJSONArray("eventi");
        }
    }

    /** Un trasporto finto: registra le chiamate e risponde a comando (una risposta, un'eccezione, o 200 se la coda è vuota). */
    private static final class FintoTrasporto implements Trasporto {
        final List<Chiamata> chiamate = Collections.synchronizedList(new ArrayList<Chiamata>());
        final Deque<Object> risposte = new ArrayDeque<>();
        volatile Runnable durante = null;

        FintoTrasporto rispondi(Object... cosa) {
            risposte.addAll(Arrays.asList(cosa));
            return this;
        }

        @Override
        public RispostaTrasporto invia(String url, String utenteId, byte[] corpoJson) throws IOException {
            chiamate.add(new Chiamata(url, utenteId, new String(corpoJson, StandardCharsets.UTF_8)));
            Runnable r = durante;
            if (r != null) r.run();
            Object prossima = risposte.pollFirst();
            if (prossima == null) return new RispostaTrasporto(200, 0L);
            if (prossima instanceof IOException) throw (IOException) prossima;
            if (prossima instanceof RuntimeException) throw (RuntimeException) prossima;
            return (RispostaTrasporto) prossima;
        }
    }

    private static RispostaTrasporto http(int stato) {
        return new RispostaTrasporto(stato, 0L);
    }

    private static RispostaTrasporto http(int stato, long retryAfterSecondi) {
        return new RispostaTrasporto(stato, retryAfterSecondi);
    }

    private RegistroNativo registro() {
        return new RegistroNativo(fileRegistro, VERSIONE, orologio::get, diagnostica);
    }

    private static UUID job(int n) {
        return UUID.fromString(String.format(Locale.ROOT, "%08x-2222-4222-8222-%012x", n, n));
    }

    private static UUID utente(int n) {
        return UUID.fromString(String.format(Locale.ROOT, "%08x-3333-4333-8333-%012x", n, n));
    }

    private static Object numero(Object valore) {
        return valore instanceof Number ? Long.valueOf(((Number) valore).longValue()) : valore;
    }

    private static void assertCampi(EventoRegistrato e, Object... coppie) {
        Map<String, Object> attesi = new java.util.LinkedHashMap<>();
        for (int i = 0; i < coppie.length; i += 2) attesi.put((String) coppie[i], numero(coppie[i + 1]));
        attesi.put("versione_app", VERSIONE);
        Map<String, Object> visti = new java.util.LinkedHashMap<>();
        for (Map.Entry<String, Object> campo : e.campi.entrySet()) visti.put(campo.getKey(), numero(campo.getValue()));
        assertEquals("campi di «" + e.messaggio + "»", attesi, visti);
    }

    private static EventoRegistrato unico(RegistroNativo registro) {
        List<EventoRegistrato> eventi = registro.eventi();
        assertEquals(1, eventi.size());
        return eventi.get(0);
    }

    private static void aggiungiN(RegistroNativo registro, int quanti, int utente) {
        for (int i = 0; i < quanti; i++) registro.videoRipresoDopoChiusura(job(i + 1), utente(utente), i);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * GLI EVENTI DI §8.2, UNO PER UNO
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void videoAccodato() {
        RegistroNativo r = registro();
        r.videoAccodato(job(1), utente(1), 1_234_567L, MimeLog.da("video/mp4;codecs=avc1.42E01E"), Motore.WORKMANAGER);
        EventoRegistrato e = unico(r);
        assertEquals("video-nativo-accodato: job=" + job(1), e.messaggio);
        assertSame(Livello.WARN, e.livello);
        assertNull(e.stato);
        assertEquals(utente(1).toString(), e.utenteId);
        assertFalse(e.meta);
        assertCampi(e, "byte", 1_234_567L, "mime", "video/mp4", "ambiente", "workmanager");
    }

    @Test
    public void videoInviato() {
        RegistroNativo r = registro();
        r.videoInviato(job(1), utente(1), 5_000_000L, 12_345L, 3, 1, EsitoInvio.PUT, true);
        EventoRegistrato e = unico(r);
        assertEquals("video-nativo-inviato: job=" + job(1), e.messaggio);
        assertSame("un successo critico si logga a warn: /api/logs non accetta info", Livello.WARN, e.livello);
        assertCampi(e, "byte", 5_000_000L, "ms", 12_345L, "tentativi", 3, "rinnovi", 1, "esito", "put", "in_background", true);
    }

    @Test
    public void videoInviatoPerRinnovoArrivato() {
        RegistroNativo r = registro();
        r.videoInviato(job(1), utente(1), 100L, 5L, 2, 1, EsitoInvio.GIA_ARRIVATO, false);
        assertCampi(unico(r), "byte", 100L, "ms", 5L, "tentativi", 2, "rinnovi", 1, "esito", "gia-arrivato", "in_background", false);
    }

    @Test
    public void videoRitentoAlPrimoTentativo() {
        RegistroNativo r = registro();
        assertTrue(r.videoRitento(job(1), utente(1), Codice.RETE, 0, 1, 30L, 4096L));
        EventoRegistrato e = unico(r);
        assertEquals("video-nativo-ritento: job=" + job(1) + " RETE", e.messaggio);
        assertSame(Livello.WARN, e.livello);
        assertEquals("lo stato HTTP sta nel campo `stato` dell'evento: 0 = nessuna risposta", Integer.valueOf(0), e.stato);
        assertCampi(e, "tentativo", 1, "attesa_s", 30L, "byte_inviati", 4096L);
    }

    @Test
    public void videoRitentoConUnoStatoDelServer() {
        RegistroNativo r = registro();
        r.videoRitento(job(1), utente(1), Codice.SERVER, 503, 2, 60L, 0L);
        EventoRegistrato e = unico(r);
        assertEquals("video-nativo-ritento: job=" + job(1) + " SERVER", e.messaggio);
        assertEquals(Integer.valueOf(503), e.stato);
    }

    @Test
    public void videoRinnovoConIlNomeDErroreDellaPut() {
        RegistroNativo r = registro();
        r.videoRinnovo(job(1), utente(1), EsitoRinnovo.DA_CARICARE, 200, 2, ErroreStorage.INVALID_JWT);
        EventoRegistrato e = unico(r);
        assertEquals("video-nativo-rinnovo: job=" + job(1) + " da-caricare", e.messaggio);
        assertEquals(Integer.valueOf(200), e.stato);
        assertCampi(e, "rinnovi", 2, "error_code", "InvalidJWT");
    }

    @Test
    public void videoRinnovoProattivoNonHaErrorCode() {
        RegistroNativo r = registro();
        r.videoRinnovo(job(1), utente(1), EsitoRinnovo.TETTO, 200, 4, null);
        EventoRegistrato e = unico(r);
        assertEquals("video-nativo-rinnovo: job=" + job(1) + " tetto", e.messaggio);
        assertCampi(e, "rinnovi", 4);
        assertFalse(e.campi.containsKey("error_code"));
    }

    @Test
    public void videoAttesaRete() {
        RegistroNativo r = registro();
        r.videoAttesaRete(job(1), utente(1), true, false);
        EventoRegistrato e = unico(r);
        assertEquals("video-nativo-attesa-rete: job=" + job(1), e.messaggio);
        assertCampi(e, "notifica", true, "autorizzata", false);
    }

    @Test
    public void videoInPausa() {
        RegistroNativo r = registro();
        r.videoInPausa(job(1), utente(1), Codice.FGS_NON_AVVIABILE, 33);
        EventoRegistrato e = unico(r);
        assertEquals("video-nativo-pausa: job=" + job(1) + " FGS_NON_AVVIABILE", e.messaggio);
        assertCampi(e, "sdk", 33);
    }

    @Test
    public void videoRipresoDopoChiusura() {
        RegistroNativo r = registro();
        r.videoRipresoDopoChiusura(job(1), utente(1), 777L);
        EventoRegistrato e = unico(r);
        assertEquals("video-nativo-ripreso-dopo-chiusura: job=" + job(1), e.messaggio);
        assertCampi(e, "byte_inviati", 777L);
    }

    @Test
    public void videoAnnullato() {
        RegistroNativo r = registro();
        r.videoAnnullato(job(1), utente(1), Da.SERVER, 50L);
        EventoRegistrato e = unico(r);
        assertEquals("video-nativo-annullato: job=" + job(1) + " server", e.messaggio);
        assertSame(Livello.WARN, e.livello);
        assertCampi(e, "byte_inviati", 50L);
    }

    @Test
    public void videoFallitoELivelloError() {
        RegistroNativo r = registro();
        r.videoFallito(job(1), utente(1), Codice.TOKEN_SCADUTO, Operazione.RINNOVO, 9, 3);
        EventoRegistrato e = unico(r);
        assertEquals("video-nativo-fallito: job=" + job(1) + " TOKEN_SCADUTO", e.messaggio);
        assertSame(Livello.ERROR, e.livello);
        assertCampi(e, "operazione", "rinnovo", "tentativi", 9, "rinnovi", 3);
    }

    @Test
    public void putOltreScadenzaPortaLaDurataInSecondi() {
        RegistroNativo r = registro();
        r.putOltreScadenza(job(1), utente(1), 7_812L, 400);
        EventoRegistrato e = unico(r);
        assertEquals("put-oltre-scadenza: job=" + job(1), e.messaggio);
        assertSame(Livello.WARN, e.livello);
        assertEquals(Integer.valueOf(400), e.stato);
        assertCampi(e, "durata_s", 7_812L);
    }

    @Test
    public void preparazioneFallitaELivelloErrorENonHaUnJob() {
        RegistroNativo r = registro();
        r.preparazioneFallita(utente(1), TipoMedia.FOTO, MotivoPreparazione.RIDUZIONE, ClasseErrore.di(new IOException("percorso/segreto.jpg")));
        EventoRegistrato e = unico(r);
        assertEquals("media-nativo-preparazione-fallita: RIDUZIONE", e.messaggio);
        assertSame(Livello.ERROR, e.livello);
        assertCampi(e, "tipo", "foto", "error_code", "IOException");
        assertFalse("il messaggio dell'eccezione non entra mai", e.messaggio.contains("segreto") || e.campi.toString().contains("segreto"));
    }

    @Test
    public void motore() {
        RegistroNativo r = registro();
        r.motore(utente(1), Motore.UIDT, Occasione.PRIMO_PIANO, 1, 2, 3);
        EventoRegistrato e = unico(r);
        assertEquals("caricamenti-nativi-motore: uidt primo-piano", e.messaggio);
        assertSame(Livello.WARN, e.livello);
        assertCampi(e, "in_coda", 1, "in_invio", 2, "task_vivi", 3);
    }

    @Test
    public void codaCorrottaSenzaUtenteNeJob() {
        RegistroNativo r = registro();
        r.codaCorrotta(null, 4, 0);
        EventoRegistrato e = unico(r);
        assertEquals("coda-nativa-corrotta", e.messaggio);
        assertSame(Livello.ERROR, e.livello);
        assertNull(e.utenteId);
        assertCampi(e, "file_orfani", 4, "voci_scartate", 0);
    }

    @Test
    public void codaCorrottaPortaLeVociScartateEUnUtenteDiUnaVoceViva() {
        RegistroNativo r = registro();
        r.codaCorrotta(utente(7), 0, 3);
        EventoRegistrato e = unico(r);
        assertEquals("coda-nativa-corrotta", e.messaggio);
        assertEquals("l'utente di una voce viva dà un x-user-id all'evento", utente(7).toString(), e.utenteId);
        assertCampi(e, "file_orfani", 0, "voci_scartate", 3);
    }

    @Test
    public void notificaNonAutorizzata() {
        RegistroNativo r = registro();
        r.notificaNonAutorizzata(utente(1));
        EventoRegistrato e = unico(r);
        assertEquals("notifica-locale-non-autorizzata", e.messaggio);
        assertSame(Livello.WARN, e.livello);
        assertCampi(e);
    }

    @Test
    public void iLivelliSonoQuelliDiSpecETuttiIMessaggiCiSono() {
        // I livelli di §8.2: tre errori (fallito, preparazione fallita, coda corrotta), tutti gli altri warn.
        Set<Evento> errori = new HashSet<>(Arrays.asList(Evento.VIDEO_FALLITO, Evento.MEDIA_PREPARAZIONE_FALLITA, Evento.CODA_CORROTTA));
        for (Evento evento : Evento.values()) {
            assertSame(evento.slug(), errori.contains(evento) ? Livello.ERROR : Livello.WARN, evento.livello());
        }
        assertEquals("quattordici messaggi di §8.2 e put-oltre-scadenza", 15, Evento.values().length);
        assertEquals("error", Livello.ERROR.valore());
        assertEquals("warn", Livello.WARN.valore());
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL TIPO È LA GARANZIA: nessun parametro stringa
     * ──────────────────────────────────────────────────────────────────────────── */

    private static final List<String> METODI_DI_EVENTO = Arrays.asList("videoAccodato", "videoInviato", "videoRitento", "videoRinnovo",
            "videoAttesaRete", "videoInPausa", "videoRipresoDopoChiusura", "videoAnnullato", "videoFallito", "putOltreScadenza",
            "preparazioneFallita", "motore", "codaCorrotta", "notificaNonAutorizzata");

    @Test
    public void iMetodiDiEventoAccettanoSoloUuidNumeriBooleaniEdEnumerati() {
        Set<String> trovati = new HashSet<>();
        for (Method metodo : RegistroNativo.class.getDeclaredMethods()) {
            if (!METODI_DI_EVENTO.contains(metodo.getName())) continue;
            if (!java.lang.reflect.Modifier.isPublic(metodo.getModifiers())) continue;
            trovati.add(metodo.getName());
            for (Class<?> tipo : metodo.getParameterTypes()) {
                boolean ammesso = tipo == UUID.class || tipo == int.class || tipo == long.class || tipo == boolean.class || tipo.isEnum();
                assertTrue(metodo.getName() + " ha un parametro di tipo " + tipo.getName() + ": un'API di log non accetta altro", ammesso);
            }
        }
        assertEquals("ogni evento ha il suo metodo", new HashSet<>(METODI_DI_EVENTO), trovati);
    }

    @Test
    public void soloSvuotaPerCartellaEDestinazionePrendonoUnaStringaTraIMetodiPubblici() {
        // `svuota` e `destinazione` prendono l'INDIRIZZO a cui spedire (mai il contenuto di un evento), `perCartella` la versione dell'app
        // da scrivere in `versione_app`: sono i soli tre punti dove una stringa entra, e nessuno di loro scrive un evento.
        for (Method metodo : RegistroNativo.class.getDeclaredMethods()) {
            if (!java.lang.reflect.Modifier.isPublic(metodo.getModifiers())) continue;
            for (Class<?> tipo : metodo.getParameterTypes()) {
                if (tipo == String.class || tipo == CharSequence.class || tipo == Object.class || tipo == Throwable.class) {
                    assertTrue("«" + metodo.getName() + "» prende un " + tipo.getSimpleName(),
                            metodo.getName().equals("svuota") || metodo.getName().equals("perCartella")
                                    || metodo.getName().equals("destinazione"));
                }
            }
        }
    }

    @Test
    public void classeErroreRiduceUnEccezioneAlSuoNomeSenzaIlMessaggio() {
        assertSame(ClasseErrore.FILE_NON_TROVATO, ClasseErrore.di(new java.io.FileNotFoundException("/data/x.mp4")));
        assertSame(ClasseErrore.IO, ClasseErrore.di(new IOException("disco pieno")));
        assertSame("un'eccezione di I/O più specifica di IOException vale comunque IO", ClasseErrore.IO, ClasseErrore.di(new java.io.EOFException()));
        assertSame(ClasseErrore.SICUREZZA, ClasseErrore.di(new SecurityException()));
        assertSame(ClasseErrore.MEMORIA_ESAURITA, ClasseErrore.di(new OutOfMemoryError()));
        assertSame(ClasseErrore.STATO_ILLEGALE, ClasseErrore.di(new IllegalStateException()));
        assertSame(ClasseErrore.ARGOMENTO_ILLEGALE, ClasseErrore.di(new IllegalArgumentException()));
        assertSame(ClasseErrore.PUNTATORE_NULLO, ClasseErrore.di(new NullPointerException()));
        assertSame(ClasseErrore.ALTRO, ClasseErrore.di(new UnsupportedOperationException()));
        assertSame(ClasseErrore.ALTRO, ClasseErrore.di(new Exception()));
        assertSame(ClasseErrore.ALTRO, ClasseErrore.di(null));
    }

    @Test
    public void mimeLogRiduceAUnElencoChiusoEIgnoraIParametri() {
        assertSame(MimeLog.MP4, MimeLog.da("video/mp4"));
        assertSame(MimeLog.MP4, MimeLog.da("VIDEO/MP4"));
        assertSame(MimeLog.MP4, MimeLog.da("video/mp4;codecs=avc1.42E01E,mp4a.40.2"));
        assertSame(MimeLog.MP4, MimeLog.da("  video/mp4 ; codecs=x"));
        assertSame(MimeLog.QUICKTIME, MimeLog.da("video/quicktime"));
        assertSame(MimeLog.TRE_GPP, MimeLog.da("video/3gpp"));
        assertSame(MimeLog.WEBM, MimeLog.da("video/webm"));
        assertSame(MimeLog.MATROSKA, MimeLog.da("video/x-matroska"));
        for (String altro : new String[]{null, "", "altro", "video/x-strano", "audio/mp4", "image/jpeg", "percorso/segreto.mp4", "x@y.it"}) {
            assertSame("«" + altro + "»", MimeLog.ALTRO, MimeLog.da(altro));
        }
    }

    @Test
    public void iVocabolariChiusiHannoLeStringheDelContratto() {
        assertEquals(Arrays.asList("video/mp4", "video/quicktime", "video/3gpp", "video/3gpp2", "video/webm", "video/x-matroska",
                "video/x-m4v", "video/mpeg", "altro"), valoriDi(MimeLog.values()));
        assertEquals(Arrays.asList("put", "gia-arrivato"), valoriDi(EsitoInvio.values()));
        assertEquals(Arrays.asList("utente", "server"), valoriDi(Da.values()));
        assertEquals(Arrays.asList("put", "rinnovo", "copia"), valoriDi(Operazione.values()));
        assertEquals(Arrays.asList("foto", "video"), valoriDi(TipoMedia.values()));
        assertEquals(Arrays.asList("avvio", "rilancio-background", "primo-piano"), valoriDi(Occasione.values()));
        assertEquals(Arrays.asList("Duplicate", "InvalidJWT", "EntityTooLarge", "Unauthorized", "InvalidRequest", "NoSuchKey", "altro"),
                valoriDi(ErroreStorage.values()));
        assertEquals(Arrays.asList("COPIA", "HASH", "RIDUZIONE", "INTERNO"), nomiDi(MotivoPreparazione.values()));
        assertEquals(Arrays.asList("FileNotFoundException", "IOException", "SecurityException", "OutOfMemoryError", "IllegalStateException",
                "IllegalArgumentException", "NullPointerException", "altro"), valoriDi(ClasseErrore.values()));
    }

    private static List<String> valoriDi(Object[] valori) {
        List<String> risultato = new ArrayList<>();
        for (Object v : valori) {
            try {
                risultato.add((String) v.getClass().getMethod("valore").invoke(v));
            } catch (ReflectiveOperationException errore) {
                throw new AssertionError(errore);
            }
        }
        return risultato;
    }

    private static List<String> nomiDi(Enum<?>[] valori) {
        List<String> risultato = new ArrayList<>();
        for (Enum<?> v : valori) risultato.add(v.name());
        return risultato;
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * CIÒ CHE ESCE NON PUÒ ESSERE UN DATO PERSONALE: la matrice completa
     * ──────────────────────────────────────────────────────────────────────────── */

    /** Le regole di `REGOLE_TESTO` del server finto di collaudo (S12), riscritte: nessuna di queste forme in un log. */
    private static final Pattern[] FORME_VIETATE = {
            Pattern.compile("://"),
            Pattern.compile("kvr_", Pattern.CASE_INSENSITIVE),
            Pattern.compile("\\b[0-9a-f]{64}\\b", Pattern.CASE_INSENSITIVE),
            Pattern.compile("(?:supabase\\.co|localhost|127\\.0\\.0\\.1|10\\.0\\.2\\.2)", Pattern.CASE_INSENSITIVE),
            Pattern.compile("(?:^|[\\s=:(,'\"])/[A-Za-z0-9._-]+/|[A-Za-z]:\\\\|KidvilleCaricamenti|noBackupFiles|Application Support"),
            Pattern.compile("\\.(?:mp4|mov|m4v|3gp|jpe?g|png|heic|webp|bin)\\b", Pattern.CASE_INSENSITIVE),
            Pattern.compile("[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}"),
    };

    /** `FORMA_ENUMERATO` di `src/lib/logging/redact.ts`: solo con questa forma il server lascia in chiaro un valore stringa. */
    private static final Pattern FORMA_ENUMERATO = Pattern.compile("^[A-Za-z0-9/][A-Za-z0-9._:/+\\[\\]-]{0,63}$");
    private static final Pattern CHIAVE_CAMPO = Pattern.compile("^[a-z][a-z0-9_]{0,31}$");
    private static final Set<String> CHIAVI_DI_STRINGA = new HashSet<>(Arrays.asList("esito", "error_code", "operazione", "tipo", "ambiente",
            "mime", "versione_app"));

    private static void verificaCheNonSiaUnDatoPersonale(EventoRegistrato e) {
        for (Pattern forma : FORME_VIETATE) {
            assertFalse("messaggio «" + e.messaggio + "» contiene " + forma.pattern(), forma.matcher(e.messaggio).find());
        }
        assertTrue("messaggio in un alfabeto chiuso: " + e.messaggio, e.messaggio.matches("^[a-z][a-z-]*[a-z](: [A-Za-z0-9=_ .-]+)?$"));
        assertTrue(e.messaggio.length() <= 120);
        assertTrue("al più 12 campi", e.campi.size() <= RegistroNativo.CAMPI_MASSIMI);
        for (Map.Entry<String, Object> campo : e.campi.entrySet()) {
            String chiave = campo.getKey();
            Object valore = campo.getValue();
            assertTrue("chiave «" + chiave + "» fuori forma", CHIAVE_CAMPO.matcher(chiave).matches());
            if (valore instanceof String) {
                assertTrue("la chiave «" + chiave + "» non è una di quelle che il server lascia in chiaro", CHIAVI_DI_STRINGA.contains(chiave));
                String testo = (String) valore;
                assertTrue("«" + testo + "» non ha la forma di un enumerato: il server lo redigerebbe", FORMA_ENUMERATO.matcher(testo).matches());
                for (Pattern forma : FORME_VIETATE) {
                    assertFalse("campo " + chiave + " «" + testo + "» contiene " + forma.pattern(), forma.matcher(testo).find());
                }
            } else {
                assertTrue("tipo " + (valore == null ? "null" : valore.getClass()) + " per «" + chiave + "»",
                        valore instanceof Number || valore instanceof Boolean);
            }
        }
    }

    @Test
    public void ogniEventoConOgniValoreDiOgniElencoChiusoPassaLeRegoleDiPrivacy() {
        UUID j = job(1);
        UUID u = utente(1);
        // Un registro per gruppo: il tetto di 200 righe non deve coprire la matrice.
        RegistroNativo a = registro();
        for (MimeLog mime : MimeLog.values()) {
            for (Motore motore : Motore.values()) a.videoAccodato(j, u, 1L, mime, motore);
        }
        for (EsitoInvio esito : EsitoInvio.values()) {
            a.videoInviato(j, u, 1L, 1L, 1, 1, esito, true);
            a.videoInviato(j, u, 1L, 1L, 1, 1, esito, false);
        }
        for (Da da : Da.values()) a.videoAnnullato(j, u, da, 5L);
        a.videoAttesaRete(j, u, true, true);
        a.videoRipresoDopoChiusura(j, u, 1L);
        a.putOltreScadenza(j, u, 1L, 400);
        a.codaCorrotta(u, 1, 0);
        a.notificaNonAutorizzata(u);
        for (Motore motore : Motore.values()) {
            for (Occasione occasione : Occasione.values()) a.motore(u, motore, occasione, 1, 1, 1);
        }
        assertTrue(a.numeroEventi() > 20 && a.numeroEventi() < 200);
        for (EventoRegistrato e : a.eventi()) verificaCheNonSiaUnDatoPersonale(e);

        RegistroNativo b = registro();
        for (Codice codice : Codice.values()) {
            b.videoRitento(j, u, codice, 599, 1, 30L, 1L);
            b.videoInPausa(j, u, codice, 34);
            for (Operazione operazione : Operazione.values()) b.videoFallito(j, u, codice, operazione, 1, 1);
        }
        for (EsitoRinnovo esito : EsitoRinnovo.values()) {
            b.videoRinnovo(j, u, esito, 200, 1, null);
            for (ErroreStorage errore : ErroreStorage.values()) b.videoRinnovo(j, u, esito, 400, 1, errore);
        }
        for (TipoMedia tipo : TipoMedia.values()) {
            for (MotivoPreparazione motivo : MotivoPreparazione.values()) {
                for (ClasseErrore classe : ClasseErrore.values()) b.preparazioneFallita(u, tipo, motivo, classe);
            }
        }
        assertTrue(b.numeroEventi() > 100 && b.numeroEventi() <= 200);
        for (EventoRegistrato e : b.eventi()) verificaCheNonSiaUnDatoPersonale(e);
    }

    @Test
    public void ogniValoreDiUnElencoChiusoHaLaFormaDiUnEnumerato() {
        List<String> tutti = new ArrayList<>();
        tutti.addAll(valoriDi(MimeLog.values()));
        tutti.addAll(valoriDi(EsitoInvio.values()));
        tutti.addAll(valoriDi(Operazione.values()));
        tutti.addAll(valoriDi(TipoMedia.values()));
        tutti.addAll(valoriDi(ErroreStorage.values()));
        tutti.addAll(valoriDi(ClasseErrore.values()));
        tutti.addAll(valoriDi(Motore.values()));
        tutti.add(VERSIONE);
        for (String valore : tutti) {
            assertTrue("«" + valore + "» sarebbe redatto dal server", FORMA_ENUMERATO.matcher(valore).matches());
        }
    }

    @Test
    public void ilMessaggioNonContieneMaiNienteChePassiDalChiamante() {
        // Un job che non è un uuid non esiste: UUID.toString() è sempre minuscolo e canonico. Il resto del messaggio sono slug e codici.
        RegistroNativo r = registro();
        UUID strano = UUID.fromString("ABCDEF01-0000-4000-8000-0000000000AB");
        r.videoAccodato(strano, utente(1), 1L, MimeLog.MP4, Motore.UIDT);
        assertEquals("video-nativo-accodato: job=abcdef01-0000-4000-8000-0000000000ab", unico(r).messaggio);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * versione_app
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void ogniEventoPortaVersioneApp() {
        RegistroNativo r = registro();
        r.codaCorrotta(null, 1, 0);
        r.notificaNonAutorizzata(null);
        r.videoAccodato(job(1), utente(1), 1L, MimeLog.MP4, Motore.UIDT);
        for (EventoRegistrato e : r.eventi()) assertEquals(VERSIONE, e.campi.get("versione_app"));
    }

    @Test
    public void unaVersioneConUnaFormaDiversaDaQuellaDelServerSiOmette() {
        for (String forma : new String[]{null, "", "1.2", "abc", "1.2+", "+4", "1.2.3.4.5+1", "12345.1+1", "1.2+1234567890", "1.2 +4", "v1.2+4", "1.2+4\n"}) {
            File f = new File(fileRegistro.getParentFile(), "r-" + (forma == null ? "null" : Integer.toHexString(forma.hashCode())) + ".json");
            RegistroNativo r = new RegistroNativo(f, forma, orologio::get, diagnostica);
            r.codaCorrotta(null, 1, 0);
            assertFalse("«" + forma + "»", unico(r).campi.containsKey("versione_app"));
        }
        for (String valida : new String[]{"1.2+4", "1.2.3+10", "10.20.30.40+999999999", "1+1", "1234.5678+0"}) {
            File f = new File(fileRegistro.getParentFile(), "v-" + Integer.toHexString(valida.hashCode()) + ".json");
            RegistroNativo r = new RegistroNativo(f, valida, orologio::get, diagnostica);
            r.codaCorrotta(null, 1, 0);
            assertEquals(valida, unico(r).campi.get("versione_app"));
        }
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL GIRO DEI RITENTATIVI (§8.1)
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void iRitentativiSiLoggaanoAi1_2_4_8_16() {
        assertTrue(RegistroNativo.siLoggaIlRitento(1));
        assertTrue(RegistroNativo.siLoggaIlRitento(2));
        assertFalse(RegistroNativo.siLoggaIlRitento(3));
        assertTrue(RegistroNativo.siLoggaIlRitento(4));
        for (int n : new int[]{5, 6, 7, 9, 10, 12, 15, 17, 31, 33, 100}) assertFalse("n = " + n, RegistroNativo.siLoggaIlRitento(n));
        for (int n : new int[]{8, 16, 32, 64, 128, 1024, 1 << 20, 1 << 30}) assertTrue("n = " + n, RegistroNativo.siLoggaIlRitento(n));
        for (int n : new int[]{0, -1, -2, -4, Integer.MIN_VALUE}) assertFalse("n = " + n, RegistroNativo.siLoggaIlRitento(n));

        RegistroNativo r = registro();
        List<Integer> scritti = new ArrayList<>();
        for (int tentativo = 0; tentativo <= 20; tentativo++) {
            boolean scritto = r.videoRitento(job(1), utente(1), Codice.RETE, 0, tentativo, 30L, 0L);
            if (scritto) scritti.add(tentativo);
        }
        assertEquals(Arrays.asList(1, 2, 4, 8, 16), scritti);
        assertEquals("e nel registro ci sono solo quelle righe", 5, r.numeroEventi());
    }

    @Test
    public void unRitentoNonLoggatoNonLasciaTraccia() {
        RegistroNativo r = registro();
        assertFalse(r.videoRitento(job(1), utente(1), Codice.SERVER, 503, 3, 60L, 0L));
        assertEquals(0, r.numeroEventi());
        assertFalse("nemmeno sul disco", fileRegistro.exists());
    }

    @Test
    public void loStatoHttpVieneRiportatoAlIntervalloDelServer() {
        RegistroNativo r = registro();
        r.videoRitento(job(1), utente(1), Codice.SERVER, -5, 1, 0L, 0L);
        r.videoRitento(job(1), utente(1), Codice.SERVER, 999, 2, 0L, 0L);
        r.videoRitento(job(1), utente(1), Codice.SERVER, 599, 4, 0L, 0L);
        r.videoRitento(job(1), utente(1), Codice.SERVER, 100, 8, 0L, 0L);
        List<EventoRegistrato> eventi = r.eventi();
        assertEquals(Integer.valueOf(0), eventi.get(0).stato);
        assertEquals(Integer.valueOf(599), eventi.get(1).stato);
        assertEquals(Integer.valueOf(599), eventi.get(2).stato);
        assertEquals(Integer.valueOf(100), eventi.get(3).stato);
    }

    @Test
    public void iNumeriNegativiNonEntranoNeiCampi() {
        RegistroNativo r = registro();
        r.videoAnnullato(job(1), utente(1), Da.UTENTE, -50L);
        r.videoInviato(job(1), utente(1), -1L, -2L, -3, -4, EsitoInvio.PUT, false);
        List<EventoRegistrato> eventi = r.eventi();
        assertEquals(0L, ((Number) eventi.get(0).campi.get("byte_inviati")).longValue());
        for (String chiave : new String[]{"byte", "ms", "tentativi", "rinnovi"}) {
            assertEquals(chiave, 0L, ((Number) eventi.get(1).campi.get(chiave)).longValue());
        }
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL TETTO DI 200 EVENTI (§4.6)
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void ilTettoEDi200EventiSiScartanoIPiuVecchiESiContano() {
        RegistroNativo r = registro();
        for (int i = 0; i < 205; i++) r.videoRipresoDopoChiusura(job(1), utente(1), i);
        assertEquals(200, r.numeroEventi());
        assertEquals(5L, r.scartati());
        List<EventoRegistrato> eventi = r.eventi();
        assertEquals("il più vecchio rimasto è il sesto", 5L, ((Number) eventi.get(0).campi.get("byte_inviati")).longValue());
        assertEquals("il più nuovo è l'ultimo", 204L, ((Number) eventi.get(199).campi.get("byte_inviati")).longValue());
    }

    @Test
    public void ilTettoEsattamenteA200NonScartaNiente() {
        RegistroNativo r = registro();
        aggiungiN(r, 200, 1);
        assertEquals(200, r.numeroEventi());
        assertEquals(0L, r.scartati());
        r.codaCorrotta(null, 1, 0);
        assertEquals(200, r.numeroEventi());
        assertEquals(1L, r.scartati());
    }

    @Test
    public void ilTettoEIlConteggioSopravvivonoAlRiavvio() throws Exception {
        RegistroNativo r = registro();
        for (int i = 0; i < 230; i++) r.videoRipresoDopoChiusura(job(1), utente(1), i);
        RegistroNativo dopo = registro();
        assertEquals(200, dopo.numeroEventi());
        assertEquals(30L, dopo.scartati());
        assertEquals(30L, ((Number) dopo.eventi().get(0).campi.get("byte_inviati")).longValue());
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * SPEDIZIONE (§8.1)
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void senzaEventiNonParteNiente() {
        RegistroNativo r = registro();
        FintoTrasporto t = new FintoTrasporto();
        assertSame(EsitoSvuotamento.NIENTE_DA_INVIARE, r.svuota(URL_SITO, false, t));
        assertTrue(t.chiamate.isEmpty());
    }

    @Test
    public void unLottoRiuscitoEsceDalRegistro() throws Exception {
        RegistroNativo r = registro();
        r.videoAccodato(job(1), utente(1), 100L, MimeLog.MP4, Motore.UIDT);
        r.videoInviato(job(1), utente(1), 100L, 10L, 1, 0, EsitoInvio.PUT, true);
        FintoTrasporto t = new FintoTrasporto().rispondi(http(200));
        assertSame(EsitoSvuotamento.INVIATO, r.svuota(URL_SITO, false, t));
        assertEquals(1, t.chiamate.size());
        assertEquals(URL_SITO, t.chiamate.get(0).url);
        assertEquals(utente(1).toString(), t.chiamate.get(0).utenteId);
        assertEquals(2, t.chiamate.get(0).eventi().length());
        assertEquals(0, r.numeroEventi());
        assertEquals("e il file su disco è vuoto di eventi", 0, registro().numeroEventi());
    }

    @Test
    public void ogniDueXxEUnSuccessoEIlLottoEsce() {
        for (int stato : new int[]{200, 201, 202, 204, 206, 299}) {
            RegistroNativo r = new RegistroNativo(new File(fileRegistro.getParentFile(), "ok" + stato + ".json"), VERSIONE, orologio::get, diagnostica);
            aggiungiN(r, 3, 1);
            assertSame("stato " + stato, EsitoSvuotamento.INVIATO, r.svuota(URL_SITO, false, new FintoTrasporto().rispondi(http(stato))));
            assertEquals("stato " + stato, 0, r.numeroEventi());
        }
    }

    @Test
    public void ilCorpoDelLottoHaLaFormaDiApiLogs() throws Exception {
        RegistroNativo r = registro();
        r.videoRitento(job(1), utente(1), Codice.RETE, 0, 1, 30L, 4096L);
        r.videoFallito(job(1), utente(1), Codice.TOKEN_SCADUTO, Operazione.PUT, 4, 1);
        r.putOltreScadenza(job(1), utente(1), 7_800L, 400);
        FintoTrasporto t = new FintoTrasporto();
        r.svuota(URL_SITO, false, t);
        JSONObject corpo = t.chiamate.get(0).json();
        assertEquals("solo `eventi` e `piattaforma`", new HashSet<>(Arrays.asList("eventi", "piattaforma")), chiaviDi(corpo));
        assertEquals("android", corpo.getString("piattaforma"));
        JSONArray eventi = corpo.getJSONArray("eventi");
        assertEquals(3, eventi.length());
        for (int i = 0; i < eventi.length(); i++) {
            JSONObject e = eventi.getJSONObject(i);
            assertEquals("caricamento-nativo", e.getString("evento"));
            assertTrue("livello warn o error", e.getString("livello").equals("warn") || e.getString("livello").equals("error"));
            assertTrue(e.getString("messaggio").length() >= 1 && e.getString("messaggio").length() <= 1000);
            assertTrue("`campi` è un oggetto", e.get("campi") instanceof JSONObject);
            assertFalse("niente stack", e.has("stack"));
            assertFalse("niente route", e.has("route"));
            assertFalse("l'identità non è nel corpo: sta nell'intestazione", e.has("utenteId") || e.has("userId") || e.has("utente"));
            assertFalse(e.has("meta"));
            for (String chiave : chiaviDi(e)) {
                assertTrue("chiave ammessa dallo schema di /api/logs: " + chiave,
                        Arrays.asList("livello", "evento", "messaggio", "stato", "campi").contains(chiave));
            }
        }
        assertEquals("error", eventi.getJSONObject(1).getString("livello"));
        assertEquals(0, eventi.getJSONObject(0).getInt("stato"));
        assertEquals(400, eventi.getJSONObject(2).getInt("stato"));
        assertFalse("un evento senza stato non porta la chiave", eventi.getJSONObject(1).has("stato"));
        assertTrue(t.chiamate.get(0).corpo.length() < RegistroNativo.CORPO_MASSIMO_BYTE);
    }

    private static Set<String> chiaviDi(JSONObject json) {
        Set<String> chiavi = new HashSet<>();
        Iterator<String> it = json.keys();
        while (it.hasNext()) chiavi.add(it.next());
        return chiavi;
    }

    @Test
    public void ilLottoHaAlPiu20EventiEUnLottoPienoPesaMenoDelTetto() throws Exception {
        RegistroNativo r = registro();
        aggiungiN(r, 45, 1);
        FintoTrasporto t = new FintoTrasporto();
        assertSame(EsitoSvuotamento.INVIATO, r.svuota(URL_SITO, false, t));
        assertEquals(20, t.chiamate.get(0).eventi().length());
        assertEquals(25, r.numeroEventi());
        assertTrue("20 eventi di campi al massimo: ben sotto i 64 KB", t.chiamate.get(0).corpo.length() < 20_000);
        orologio.addAndGet(RegistroNativo.INTERVALLO_MINIMO_INVIO_MS);
        r.svuota(URL_SITO, false, t);
        assertEquals(20, t.chiamate.get(1).eventi().length());
        orologio.addAndGet(RegistroNativo.INTERVALLO_MINIMO_INVIO_MS);
        r.svuota(URL_SITO, false, t);
        assertEquals(5, t.chiamate.get(2).eventi().length());
        assertEquals(0, r.numeroEventi());
        // I lotti escono nell'ordine in cui gli eventi sono stati scritti.
        assertEquals(0, t.chiamate.get(0).eventi().getJSONObject(0).getJSONObject("campi").getInt("byte_inviati"));
        assertEquals(20, t.chiamate.get(1).eventi().getJSONObject(0).getJSONObject("campi").getInt("byte_inviati"));
        assertEquals(40, t.chiamate.get(2).eventi().getJSONObject(0).getJSONObject("campi").getInt("byte_inviati"));
    }

    @Test
    public void unLottoNonMescolaMaiGliUtentiEPartePerPrimoQuelloDelPiuVecchio() throws Exception {
        RegistroNativo r = registro();
        r.videoRipresoDopoChiusura(job(1), utente(1), 1L);     // u1
        r.videoRipresoDopoChiusura(job(2), utente(2), 2L);     // u2
        r.videoRipresoDopoChiusura(job(3), utente(1), 3L);     // u1
        r.codaCorrotta(null, 4, 0);                                // nessuno
        r.videoRipresoDopoChiusura(job(4), utente(2), 5L);     // u2
        FintoTrasporto t = new FintoTrasporto();
        List<String> utentiVisti = new ArrayList<>();
        List<List<Long>> contenuti = new ArrayList<>();
        for (int giro = 0; giro < 3; giro++) {
            assertSame(EsitoSvuotamento.INVIATO, r.svuota(URL_SITO, false, t));
            Chiamata c = t.chiamate.get(giro);
            utentiVisti.add(c.utenteId);
            List<Long> numeri = new ArrayList<>();
            for (int i = 0; i < c.eventi().length(); i++) {
                JSONObject campi = c.eventi().getJSONObject(i).getJSONObject("campi");
                numeri.add(campi.has("byte_inviati") ? campi.getLong("byte_inviati") : -campi.getLong("file_orfani"));
            }
            contenuti.add(numeri);
            orologio.addAndGet(RegistroNativo.INTERVALLO_MINIMO_INVIO_MS);
        }
        assertEquals(Arrays.asList(utente(1).toString(), utente(2).toString(), null), utentiVisti);
        assertEquals(Arrays.asList(1L, 3L), contenuti.get(0));
        assertEquals(Arrays.asList(2L, 5L), contenuti.get(1));
        assertEquals("l'evento senza utente parte da solo e senza identità", Arrays.asList(-4L), contenuti.get(2));
        assertEquals(0, r.numeroEventi());
    }

    @Test
    public void alPiuUnPostOgniDieciSecondi() {
        RegistroNativo r = registro();
        aggiungiN(r, 50, 1);
        FintoTrasporto t = new FintoTrasporto();
        assertSame(EsitoSvuotamento.INVIATO, r.svuota(URL_SITO, false, t));
        assertEquals(RegistroNativo.INTERVALLO_MINIMO_INVIO_MS, r.attesaProssimoInvioMs());
        orologio.addAndGet(9_999L);
        assertEquals(1L, r.attesaProssimoInvioMs());
        assertSame("a 9,999 s è ancora presto", EsitoSvuotamento.RIMANDATO, r.svuota(URL_SITO, false, t));
        assertEquals(1, t.chiamate.size());
        orologio.addAndGet(1L);
        assertEquals(0L, r.attesaProssimoInvioMs());
        assertSame("a 10 s esatti si può", EsitoSvuotamento.INVIATO, r.svuota(URL_SITO, false, t));
        assertEquals(2, t.chiamate.size());
        assertEquals(10_000L, RegistroNativo.INTERVALLO_MINIMO_INVIO_MS);
    }

    @Test
    public void ilRitmoSiApplicaAnchePerUnaRispostaNegativa() {
        RegistroNativo r = registro();
        r.codaCorrotta(null, 1, 0);
        FintoTrasporto t = new FintoTrasporto().rispondi(http(503), http(503));
        assertSame(EsitoSvuotamento.TENUTO_PER_SERVER, r.svuota(URL_SITO, false, t));
        assertSame("anche dopo un fallimento: non si martella il server", EsitoSvuotamento.RIMANDATO, r.svuota(URL_SITO, false, t));
        assertEquals(1, t.chiamate.size());
        orologio.addAndGet(10_000L);
        assertSame(EsitoSvuotamento.TENUTO_PER_SERVER, r.svuota(URL_SITO, false, t));
        assertEquals(2, t.chiamate.size());
    }

    @Test
    public void unQuattroVentinoveTieneGliEventiEAspettaIlRetryAfter() {
        RegistroNativo r = registro();
        aggiungiN(r, 3, 1);
        FintoTrasporto t = new FintoTrasporto().rispondi(http(429, 120L));
        assertSame(EsitoSvuotamento.TENUTO_PER_LIMITE, r.svuota(URL_SITO, false, t));
        assertEquals("gli eventi restano", 3, r.numeroEventi());
        assertEquals(0L, r.scartati());
        assertEquals(120_000L, r.attesaProssimoInvioMs());
        orologio.addAndGet(119_999L);
        assertSame(EsitoSvuotamento.RIMANDATO, r.svuota(URL_SITO, false, t));
        orologio.addAndGet(1L);
        assertSame(EsitoSvuotamento.INVIATO, r.svuota(URL_SITO, false, t));
        assertEquals(0, r.numeroEventi());
    }

    @Test
    public void unQuattroVentinoveSenzaRetryAfterAspettaAlmenoDieciSecondi() {
        RegistroNativo r = registro();
        aggiungiN(r, 1, 1);
        r.svuota(URL_SITO, false, new FintoTrasporto().rispondi(http(429, 0L)));
        assertEquals(10_000L, r.attesaProssimoInvioMs());
        r.svuota(URL_SITO, false, new FintoTrasporto().rispondi(http(429, 3L)));   // rimandato: non è nemmeno partito
        orologio.addAndGet(10_000L);
        r.svuota(URL_SITO, false, new FintoTrasporto().rispondi(http(429, 3L)));
        assertEquals("un Retry-After più corto dell'intervallo non lo accorcia", 10_000L, r.attesaProssimoInvioMs());
    }

    @Test
    public void ilRetryAfterDelRegistroHaIlTettoDiUnOra() {
        RegistroNativo r = registro();
        aggiungiN(r, 1, 1);
        r.svuota(URL_SITO, false, new FintoTrasporto().rispondi(http(429, 86_400L)));
        assertEquals(3_600_000L, r.attesaProssimoInvioMs());
        RegistroNativo q = new RegistroNativo(new File(fileRegistro.getParentFile(), "altro.json"), VERSIONE, orologio::get, diagnostica);
        aggiungiN(q, 1, 1);
        q.svuota(URL_SITO, false, new FintoTrasporto().rispondi(http(429, -50L)));
        assertEquals("un Retry-After negativo non conta", 10_000L, q.attesaProssimoInvioMs());
    }

    @Test
    public void ogniAltro4xxScartaIlLottoELoConta() throws Exception {
        for (int stato : new int[]{400, 401, 403, 404, 408, 410, 413, 422, 451, 499}) {
            File sotto = temporanea.newFolder();
            DiagnosticaMemoria diag = new DiagnosticaMemoria();
            RegistroNativo r = new RegistroNativo(new File(sotto, "registro.json"), VERSIONE, orologio::get, diag);
            aggiungiN(r, 30, 1);
            FintoTrasporto t = new FintoTrasporto().rispondi(http(stato));
            assertSame("stato " + stato, EsitoSvuotamento.LOTTO_SCARTATO, r.svuota(URL_SITO, false, t));
            assertEquals("stato " + stato + ": il lotto di 20 è uscito", 10, r.numeroEventi());
            assertEquals("stato " + stato + ": e si contano", 20L, r.scartati());
            assertEquals("stato " + stato + ": un lotto scartato è un difetto del nostro client e si dice in logcat",
                    Arrays.asList("svuota-lotto-scartato:-"), diag.voci);
            assertEquals(1, r.erroriInterni());
        }
    }

    @Test
    public void ilConteggioDegliScartatiSiDichiaraConUnaRigaAlProssimoInvio() throws Exception {
        RegistroNativo r = registro();
        aggiungiN(r, 25, 1);
        r.svuota(URL_SITO, false, new FintoTrasporto().rispondi(http(400)));     // 20 scartati, ne restano 5
        orologio.addAndGet(10_000L);
        FintoTrasporto t = new FintoTrasporto();
        assertSame(EsitoSvuotamento.INVIATO, r.svuota(URL_SITO, false, t));
        JSONArray inviati = t.chiamate.get(0).eventi();
        assertEquals("5 eventi rimasti + la dichiarazione", 6, inviati.length());
        JSONObject ultima = inviati.getJSONObject(5);
        assertEquals("registro-nativo-scartati", ultima.getString("messaggio"));
        assertEquals("warn", ultima.getString("livello"));
        assertEquals(20, ultima.getJSONObject("campi").getInt("scartati"));
        assertEquals(VERSIONE, ultima.getJSONObject("campi").getString("versione_app"));
        assertEquals("la dichiarazione porta l'utente del lotto", utente(1).toString(), t.chiamate.get(0).utenteId);
        assertEquals(0L, r.scartati());
    }

    @Test
    public void laDichiarazioneDegliScartatiNonSiConta() throws Exception {
        // Se anche la dichiarazione viene respinta con un 4xx non rientra nel conto: si andrebbe avanti all'infinito.
        RegistroNativo r = registro();
        aggiungiN(r, 21, 1);
        r.svuota(URL_SITO, false, new FintoTrasporto().rispondi(http(400)));            // 20 scartati, 1 resta
        orologio.addAndGet(10_000L);
        r.svuota(URL_SITO, false, new FintoTrasporto().rispondi(http(400)));            // la riga resta + dichiarazione: scartate
        assertEquals(0, r.numeroEventi());
        assertEquals("soltanto l'evento vero (1) si conta in più, non la dichiarazione", 1L, r.scartati());
        orologio.addAndGet(10_000L);
        FintoTrasporto t = new FintoTrasporto();
        assertSame(EsitoSvuotamento.INVIATO, r.svuota(URL_SITO, false, t));
        assertEquals(1, t.chiamate.get(0).eventi().length());
        assertEquals(1, t.chiamate.get(0).eventi().getJSONObject(0).getJSONObject("campi").getInt("scartati"));
    }

    @Test
    public void conIlRegistroPienoEUnGuastoPersistenteCeUnaSolaDichiarazione() throws Exception {
        RegistroNativo r = registro();
        aggiungiN(r, 205, 1);        // 200 tenuti, 5 scartati
        FintoTrasporto rete = new FintoTrasporto();
        for (int giro = 0; giro < 30; giro++) rete.rispondi(new IOException("rete assente"));
        for (int giro = 0; giro < 30; giro++) {
            orologio.addAndGet(10_000L);
            assertSame(EsitoSvuotamento.TENUTO_PER_RETE, r.svuota(URL_SITO, false, rete));
        }
        int dichiarazioni = 0;
        long conto = 0;
        for (EventoRegistrato e : r.eventi()) {
            if (e.meta) {
                dichiarazioni++;
                conto += ((Number) e.campi.get("scartati")).longValue();
            }
        }
        assertEquals("una riga sola, non una per tentativo", 1, dichiarazioni);
        assertTrue("e il conto cresce solo con le righe davvero perse: " + conto + " + " + r.scartati(), conto + r.scartati() >= 5L);
        assertEquals(200, r.numeroEventi());
    }

    @Test
    public void unaDichiarazioneNonSpeditaCheEsceDalTettoRiportaNelContoIlNumeroCheDichiarava() {
        RegistroNativo r = registro();
        aggiungiN(r, 205, 1);                                   // 200 tenuti, 5 scartati
        r.svuota(URL_SITO, false, new FintoTrasporto().rispondi(new IOException("rete")));
        List<EventoRegistrato> dopoIlTentativo = r.eventi();
        EventoRegistrato ultima = dopoIlTentativo.get(dopoIlTentativo.size() - 1);
        assertTrue("la dichiarazione è in fondo", ultima.meta);
        assertEquals(5L, ((Number) ultima.campi.get("scartati")).longValue());
        assertEquals("e per farle posto ne è uscita una vecchia", 1L, r.scartati());
        // Ora altri 200 eventi senza spedire: i 199 vecchi escono uno a uno, poi esce anche la dichiarazione.
        for (int i = 0; i < 200; i++) r.codaCorrotta(null, i, 0);
        assertEquals("1 di prima + 199 eventi vecchi + i 5 che la dichiarazione portava", 205L, r.scartati());
        for (EventoRegistrato e : r.eventi()) assertFalse(e.meta);
    }

    @Test
    public void unOrologioPortatoIndietroDopoUn429NonBloccaIlRegistroPerSempre() {
        RegistroNativo r = registro();
        aggiungiN(r, 3, 1);
        r.svuota(URL_SITO, false, new FintoTrasporto().rispondi(http(429, 120L)));
        assertEquals(120_000L, r.attesaProssimoInvioMs());
        orologio.addAndGet(-5_000L);
        assertEquals("un orologio indietro di pochi secondi allunga l'attesa di pochi secondi", 125_000L, r.attesaProssimoInvioMs());
        orologio.addAndGet(5_000L);
        orologio.addAndGet(-86_400_000L);                          // il telefono torna indietro di un giorno
        assertEquals("un conto impossibile si riporta a un intervallo minimo", 10_000L, r.attesaProssimoInvioMs());
        FintoTrasporto t = new FintoTrasporto();
        assertSame(EsitoSvuotamento.RIMANDATO, r.svuota(URL_SITO, false, t));
        orologio.addAndGet(10_000L);
        assertEquals(0L, r.attesaProssimoInvioMs());
        assertSame(EsitoSvuotamento.INVIATO, r.svuota(URL_SITO, false, t));
    }

    @Test
    public void cinqueXxEStatiInattesiTengonoGliEventi() {
        for (int stato : new int[]{500, 502, 503, 504, 599, 100, 301, 302, 304, 600}) {
            RegistroNativo r = new RegistroNativo(new File(fileRegistro.getParentFile(), "s" + stato + ".json"), VERSIONE, orologio::get, diagnostica);
            aggiungiN(r, 3, 1);
            assertSame("stato " + stato, EsitoSvuotamento.TENUTO_PER_SERVER, r.svuota(URL_SITO, false, new FintoTrasporto().rispondi(http(stato))));
            assertEquals(3, r.numeroEventi());
            assertEquals(0L, r.scartati());
        }
    }

    @Test
    public void nessunaRispostaTieneGliEventiELoDice() {
        RegistroNativo r = registro();
        aggiungiN(r, 3, 1);
        assertSame(EsitoSvuotamento.TENUTO_PER_RETE, r.svuota(URL_SITO, false, new FintoTrasporto().rispondi(http(0))));
        orologio.addAndGet(10_000L);
        assertSame(EsitoSvuotamento.TENUTO_PER_RETE, r.svuota(URL_SITO, false, new FintoTrasporto().rispondi(new IOException("giù"))));
        assertEquals(3, r.numeroEventi());
        assertEquals("un'eccezione di rete si dice in logcat, col solo nome della classe", Arrays.asList("svuota-rete:IOException"), diagnostica.voci);
    }

    @Test
    public void unTrasportoCheLanciaUnErroreNonRompeIlRegistro() {
        RegistroNativo r = registro();
        aggiungiN(r, 2, 1);
        assertSame(EsitoSvuotamento.TENUTO_PER_RETE,
                r.svuota(URL_SITO, false, new FintoTrasporto().rispondi(new IllegalStateException("boom"))));
        assertEquals(2, r.numeroEventi());
        assertEquals(1, r.erroriInterni());
        orologio.addAndGet(10_000L);
        assertSame("e non resta «in volo»: il giro dopo parte", EsitoSvuotamento.INVIATO, r.svuota(URL_SITO, false, new FintoTrasporto()));
    }

    @Test
    public void unTrasportoNulloNonRompeIlRegistro() {
        RegistroNativo r = registro();
        aggiungiN(r, 2, 1);
        assertSame(EsitoSvuotamento.TENUTO_PER_RETE, r.svuota(URL_SITO, false, null));
        assertEquals(2, r.numeroEventi());
    }

    @Test
    public void soloLIndirizzoDelSitoEAmmessoEPrimaCheParta() {
        RegistroNativo r = registro();
        aggiungiN(r, 2, 1);
        FintoTrasporto t = new FintoTrasporto();
        for (String url : new String[]{"https://evil.example/api/logs", "http://app.kidville.it/api/logs", "https://app.kidville.it.evil.example/api/logs",
                "http://localhost:3101/api/logs", "http://10.0.2.2:3101/api/logs", "https://abcd.supabase.co/api/logs", "", null}) {
            assertSame("Release «" + url + "»", EsitoSvuotamento.DESTINAZIONE_NON_AMMESSA, r.svuota(url, false, t));
        }
        assertTrue("niente è partito", t.chiamate.isEmpty());
        assertEquals(2, r.numeroEventi());
        assertEquals("e una destinazione rifiutata non consuma l'intervallo", 0L, r.attesaProssimoInvioMs());
        assertSame(EsitoSvuotamento.INVIATO, r.svuota(URL_SITO, false, t));
    }

    @Test
    public void inDebugAncheILoopbackDelCollaudoSonoAmmessi() {
        for (String url : new String[]{"http://10.0.2.2:3101/api/logs", "http://localhost:3101/api/logs", "http://127.0.0.1:4310/api/logs"}) {
            File f = new File(fileRegistro.getParentFile(), "d" + Integer.toHexString(url.hashCode()) + ".json");
            RegistroNativo r = new RegistroNativo(f, VERSIONE, orologio::get, diagnostica);
            aggiungiN(r, 1, 1);
            FintoTrasporto t = new FintoTrasporto();
            assertSame(url, EsitoSvuotamento.INVIATO, r.svuota(url, true, t));
            assertEquals(url, t.chiamate.get(0).url);
        }
    }

    @Test
    public void unEventoSenzaUtentePartePerSoloSenzaIdentita() {
        RegistroNativo r = registro();
        r.codaCorrotta(null, 2, 0);
        FintoTrasporto t = new FintoTrasporto();
        r.svuota(URL_SITO, false, t);
        assertNull(t.chiamate.get(0).utenteId);
    }

    @Test(timeout = 30_000)
    public void unaSecondaSvuotaMentreLaPrimaEInVoloVieneRifiutata() throws Exception {
        final RegistroNativo r = registro();
        aggiungiN(r, 3, 1);
        final AtomicReference<EsitoSvuotamento> interno = new AtomicReference<>();
        FintoTrasporto t = new FintoTrasporto();
        t.durante = () -> interno.set(r.svuota(URL_SITO, false, new FintoTrasporto()));
        assertSame(EsitoSvuotamento.INVIATO, r.svuota(URL_SITO, false, t));
        assertSame(EsitoSvuotamento.GIA_IN_CORSO, interno.get());
        assertEquals(0, r.numeroEventi());
    }

    @Test(timeout = 30_000)
    public void gliEventiScrittiMentreIlPostEInVoloRestanoEQuelliSpeditiEscono() throws Exception {
        final RegistroNativo r = registro();
        aggiungiN(r, 3, 1);
        FintoTrasporto t = new FintoTrasporto();
        t.durante = () -> r.codaCorrotta(null, 77, 0);
        assertSame(EsitoSvuotamento.INVIATO, r.svuota(URL_SITO, false, t));
        List<EventoRegistrato> restano = r.eventi();
        assertEquals("i 3 spediti sono usciti, quello scritto durante il volo no", 1, restano.size());
        assertEquals("coda-nativa-corrotta", restano.get(0).messaggio);
    }

    @Test(timeout = 30_000)
    public void seIlTettoTogliLeRigheDelLottoInVoloLoSvuotamentoNonRompeNiente() throws Exception {
        final RegistroNativo r = registro();
        aggiungiN(r, 20, 1);
        FintoTrasporto t = new FintoTrasporto();
        // Durante il volo il registro si riempie di altro e il tetto butta via le 20 righe del lotto.
        t.durante = () -> {
            for (int i = 0; i < 205; i++) r.videoRipresoDopoChiusura(job(1), utente(2), 1000 + i);
        };
        assertSame(EsitoSvuotamento.INVIATO, r.svuota(URL_SITO, false, t));
        assertEquals("nessuna riga nuova è stata tolta al posto di quelle vecchie", 200, r.numeroEventi());
        for (EventoRegistrato e : r.eventi()) assertEquals(utente(2).toString(), e.utenteId);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * PERSISTENZA
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void ogniEventoSiScriveSubitoSuDiscoEITipiSopravvivono() throws Exception {
        RegistroNativo r = registro();
        r.videoRitento(job(1), utente(1), Codice.RETE, 0, 1, 30L, 4096L);
        r.videoAttesaRete(job(1), utente(1), true, false);
        r.codaCorrotta(null, 3, 0);
        assertTrue(fileRegistro.isFile());
        JSONObject radice = new JSONObject(new String(java.nio.file.Files.readAllBytes(fileRegistro.toPath()), StandardCharsets.UTF_8));
        assertEquals(1, radice.getInt("versione"));
        assertEquals(new HashSet<>(Arrays.asList("versione", "eventi", "scartati")), chiaviDi(radice));
        assertEquals(3, radice.getJSONArray("eventi").length());

        RegistroNativo dopo = registro();
        List<EventoRegistrato> eventi = dopo.eventi();
        assertEquals(3, eventi.size());
        assertEquals("video-nativo-ritento: job=" + job(1) + " RETE", eventi.get(0).messaggio);
        assertEquals(Integer.valueOf(0), eventi.get(0).stato);
        assertEquals(utente(1).toString(), eventi.get(0).utenteId);
        assertSame(Livello.WARN, eventi.get(0).livello);
        assertEquals(30L, ((Number) eventi.get(0).campi.get("attesa_s")).longValue());
        assertEquals(Boolean.TRUE, eventi.get(1).campi.get("notifica"));
        assertEquals(Boolean.FALSE, eventi.get(1).campi.get("autorizzata"));
        assertNull(eventi.get(2).utenteId);
        assertNull(eventi.get(2).stato);
        assertSame(Livello.ERROR, eventi.get(2).livello);
        assertTrue(diagnostica.voci.isEmpty());
    }

    @Test
    public void ilFileNonPortaInfoPersonaliNeUrlNeToken() throws Exception {
        RegistroNativo r = registro();
        r.videoAccodato(job(1), utente(1), 1L, MimeLog.MP4, Motore.UIDT);
        r.videoRinnovo(job(1), utente(1), EsitoRinnovo.DA_CARICARE, 200, 1, ErroreStorage.DUPLICATE);
        String testo = new String(java.nio.file.Files.readAllBytes(fileRegistro.toPath()), StandardCharsets.UTF_8);
        for (Pattern forma : FORME_VIETATE) assertFalse(forma.pattern(), forma.matcher(testo).find());
        assertFalse(testo.contains(temporanea.getRoot().getPath()));
    }

    @Test
    public void unEventoPersistitoFuoriFormaNonRientra() throws Exception {
        RegistroNativo r = registro();
        r.codaCorrotta(null, 1, 0);
        r.videoAccodato(job(1), utente(1), 1L, MimeLog.MP4, Motore.UIDT);
        JSONObject radice = new JSONObject(new String(java.nio.file.Files.readAllBytes(fileRegistro.toPath()), StandardCharsets.UTF_8));
        JSONArray eventi = radice.getJSONArray("eventi");
        eventi.put(new JSONObject("{\"utenteId\":null,\"livello\":\"warn\",\"messaggio\":\"testo libero con un nome proprio qualunque\",\"stato\":null,\"campi\":{},\"meta\":false}"));
        eventi.put(new JSONObject("{\"utenteId\":null,\"livello\":\"info\",\"messaggio\":\"coda-nativa-corrotta\",\"stato\":null,\"campi\":{},\"meta\":false}"));
        eventi.put(new JSONObject("{\"utenteId\":null,\"livello\":\"warn\",\"messaggio\":\"coda-nativa-corrotta\",\"stato\":null,\"campi\":{\"nome_file\":\"x\"},\"meta\":false}"));
        eventi.put(new JSONObject("{\"utenteId\":null,\"livello\":\"warn\",\"messaggio\":\"coda-nativa-corrotta\",\"stato\":null,\"campi\":{\"esito\":{\"a\":1}},\"meta\":false}"));
        eventi.put(new JSONObject("{\"utenteId\":\"NON-UN-UUID\",\"livello\":\"warn\",\"messaggio\":\"coda-nativa-corrotta\",\"stato\":null,\"campi\":{},\"meta\":false}"));
        eventi.put(new JSONObject("{\"utenteId\":null,\"livello\":\"warn\",\"messaggio\":\"coda-nativa-corrotta\",\"stato\":700,\"campi\":{},\"meta\":false}"));
        eventi.put(new JSONObject("{\"utenteId\":null,\"livello\":\"warn\",\"messaggio\":\"\",\"stato\":null,\"campi\":{},\"meta\":false}"));
        eventi.put(new JSONObject("{\"utenteId\":null,\"livello\":\"warn\",\"stato\":null,\"campi\":{},\"meta\":false}"));
        eventi.put("una stringa");
        eventi.put(JSONObject.NULL);
        try (FileOutputStream uscita = new FileOutputStream(fileRegistro)) {
            uscita.write(radice.toString().getBytes(StandardCharsets.UTF_8));
        }
        RegistroNativo dopo = registro();
        assertEquals("solo i due eventi veri rientrano", 2, dopo.numeroEventi());
        assertEquals("gli altri dieci si contano", 10L, dopo.scartati());
    }

    @Test
    public void unFileIllegibileOdiVersioneSconosciutaSiButtaEIlRegistroRipartePulito() throws Exception {
        for (String contenuto : new String[]{"{rotto", "", "[]", "{\"versione\":2,\"eventi\":[],\"scartati\":0}", "{\"versione\":1}", "{\"versione\":\"1\",\"eventi\":[]}"}) {
            File sotto = temporanea.newFolder();
            File f = new File(sotto, "registro.json");
            try (FileOutputStream uscita = new FileOutputStream(f)) {
                uscita.write(contenuto.getBytes(StandardCharsets.UTF_8));
            }
            DiagnosticaMemoria diag = new DiagnosticaMemoria();
            RegistroNativo r = new RegistroNativo(f, VERSIONE, orologio::get, diag);
            assertEquals("«" + contenuto + "»", 0, r.numeroEventi());
            assertEquals("«" + contenuto + "»", 0L, r.scartati());
            assertEquals("«" + contenuto + "»: il guasto si dice in logcat", 1, diag.voci.size());
            r.codaCorrotta(null, 1, 0);
            assertEquals("e si può scrivere di nuovo", 1, new RegistroNativo(f, VERSIONE, orologio::get, diag).numeroEventi());
        }
    }

    @Test
    public void conIlTettoSuperatoNelFileSiRiduceERiconta() throws Exception {
        RegistroNativo r = registro();
        for (int i = 0; i < 10; i++) r.videoRipresoDopoChiusura(job(1), utente(1), i);
        JSONObject radice = new JSONObject(new String(java.nio.file.Files.readAllBytes(fileRegistro.toPath()), StandardCharsets.UTF_8));
        JSONArray eventi = radice.getJSONArray("eventi");
        JSONObject modello = eventi.getJSONObject(0);
        for (int i = 0; i < 250; i++) eventi.put(new JSONObject(modello.toString()));
        try (FileOutputStream uscita = new FileOutputStream(fileRegistro)) {
            uscita.write(radice.toString().getBytes(StandardCharsets.UTF_8));
        }
        RegistroNativo dopo = registro();
        assertEquals(200, dopo.numeroEventi());
        assertEquals(60L, dopo.scartati());
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * FAIL-OPEN (AGENTS.md, regola 9)
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void unArgomentoNulloNonLanciaENonLasciaUnEventoMezzo() {
        RegistroNativo r = registro();
        r.videoAccodato(null, utente(1), 1L, MimeLog.MP4, Motore.UIDT);                 // job nullo: si può scrivere (non c'è job nel messaggio)
        r.videoAccodato(job(1), utente(1), 1L, null, Motore.UIDT);                      // mime nullo
        r.videoAccodato(job(1), utente(1), 1L, MimeLog.MP4, null);                      // motore nullo
        r.videoInviato(job(1), utente(1), 1L, 1L, 1, 1, null, true);
        assertFalse(r.videoRitento(job(1), utente(1), null, 0, 1, 1L, 1L));
        r.videoRinnovo(job(1), utente(1), null, 200, 1, null);
        r.videoInPausa(job(1), utente(1), null, 34);
        r.videoAnnullato(job(1), utente(1), null, 1L);
        r.videoFallito(job(1), utente(1), null, Operazione.PUT, 1, 1);
        r.videoFallito(job(1), utente(1), Codice.INTERNO, null, 1, 1);
        r.preparazioneFallita(utente(1), null, MotivoPreparazione.COPIA, ClasseErrore.ALTRO);
        r.preparazioneFallita(utente(1), TipoMedia.VIDEO, null, ClasseErrore.ALTRO);
        r.preparazioneFallita(utente(1), TipoMedia.VIDEO, MotivoPreparazione.COPIA, null);
        r.motore(utente(1), null, Occasione.AVVIO, 1, 1, 1);
        r.motore(utente(1), Motore.UIDT, null, 1, 1, 1);
        assertEquals("14 chiamate con un argomento nullo non enumerato: il registro non ha lanciato", 14, r.erroriInterni());
        assertEquals("solo la prima (job nullo) è un evento valido: il messaggio non porta job", 1, r.numeroEventi());
        assertEquals("video-nativo-accodato", r.eventi().get(0).messaggio);
        assertEquals(14, diagnostica.voci.size());
    }

    @Test
    public void ilDiscoPienoNonRompeUnChiamanteEGliEventiRestanoInMemoria() throws Exception {
        RegistroNativo r = registro();
        Assume.assumeTrue("serve una cartella davvero non scrivibile (non da root)", rendiNonScrivibile(fileRegistro.getParentFile()));
        try {
            r.videoAccodato(job(1), utente(1), 1L, MimeLog.MP4, Motore.UIDT);
            r.videoInviato(job(1), utente(1), 1L, 1L, 1, 0, EsitoInvio.PUT, false);
            assertEquals(2, r.numeroEventi());
            assertEquals(2, r.erroriInterni());
            assertTrue(diagnostica.voci.get(0).startsWith("salva-registro:"));
            FintoTrasporto t = new FintoTrasporto();
            assertSame("anche senza disco si spedisce quel che c'è in memoria", EsitoSvuotamento.INVIATO, r.svuota(URL_SITO, false, t));
            assertEquals(2, t.chiamate.get(0).eventi().length());
        } finally {
            assertTrue(fileRegistro.getParentFile().setWritable(true, false));
        }
    }

    private boolean rendiNonScrivibile(File dir) throws IOException {
        if (!dir.setWritable(false, false)) return false;
        File prova = new File(dir, "prova.tmp");
        boolean scritta;
        try {
            scritta = prova.createNewFile();
        } catch (IOException atteso) {
            scritta = false;
        }
        if (scritta) {
            prova.delete();
            dir.setWritable(true, false);
            return false;
        }
        return true;
    }

    @Test
    public void seAncheLaDiagnosticaLanciaIlRegistroNonRompeNiente() {
        diagnostica.lancia = true;
        RegistroNativo r = registro();
        r.videoAccodato(job(1), utente(1), 1L, null, Motore.UIDT);
        r.videoAccodato(job(1), utente(1), 1L, MimeLog.MP4, null);
        assertEquals(2, r.erroriInterni());
        assertEquals("l'ultima rete: si conta quante volte è caduta", 2, r.diagnosticheCadute());
        assertEquals(0, r.numeroEventi());
    }

    @Test
    public void unEventoValidoDopoUnGuastoSiScriveRegolarmente() {
        RegistroNativo r = registro();
        r.videoAccodato(job(1), utente(1), 1L, null, Motore.UIDT);
        r.videoAccodato(job(1), utente(1), 1L, MimeLog.MP4, Motore.UIDT);
        assertEquals(1, r.numeroEventi());
        assertEquals(1, r.erroriInterni());
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * CONCORRENZA
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test(timeout = 60_000)
    public void piuThreadCheScrivonoEUnoCheSpedisceNonPerdonoNeDuplicanoEventi() throws Exception {
        final RegistroNativo r = registro();
        final int thread = 6;
        final int perThread = 30;
        final CountDownLatch via = new CountDownLatch(1);
        final CountDownLatch fatto = new CountDownLatch(thread);
        final List<Throwable> errori = Collections.synchronizedList(new ArrayList<Throwable>());
        final AtomicInteger spediti = new AtomicInteger();
        final FintoTrasporto t = new FintoTrasporto();
        t.durante = () -> {
            try {
                Chiamata ultima = t.chiamate.get(t.chiamate.size() - 1);
                spediti.addAndGet(ultima.eventi().length());
            } catch (Exception errore) {
                errori.add(errore);
            }
        };
        for (int i = 0; i < thread; i++) {
            final int numero = i;
            new Thread(() -> {
                try {
                    via.await();
                    for (int k = 0; k < perThread; k++) r.videoRipresoDopoChiusura(job(numero + 1), utente(1), numero * 1000 + k);
                } catch (Throwable errore) {
                    errori.add(errore);
                } finally {
                    fatto.countDown();
                }
            }).start();
        }
        via.countDown();
        int giri = 0;
        while (fatto.getCount() > 0 && giri < 200) {
            orologio.addAndGet(10_000L);
            r.svuota(URL_SITO, false, t);
            giri++;
        }
        assertTrue(fatto.await(50, TimeUnit.SECONDS));
        for (int i = 0; i < 20 && r.numeroEventi() > 0; i++) {
            orologio.addAndGet(10_000L);
            r.svuota(URL_SITO, false, t);
        }
        assertTrue("errori nei thread: " + errori, errori.isEmpty());
        assertEquals("ogni evento è partito una volta sola", thread * perThread, spediti.get());
        assertEquals(0, r.numeroEventi());
        assertEquals(0L, r.scartati());
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL TRASPORTO HTTP VERO, contro un server locale (com.sun.net.httpserver)
     * ──────────────────────────────────────────────────────────────────────────── */

    private static final class Registrata {
        volatile String metodo;
        volatile String percorso;
        volatile Map<String, List<String>> intestazioni;
        volatile byte[] corpo;
    }

    /**
     * Un server HTTP minimo su `ServerSocket`, un'unica connessione alla volta, che registra la richiesta e risponde come gli si
     * dice. Non si usa `com.sun.net.httpserver`: i test si compilano contro android.jar, che non lo espone.
     */
    private static final class ServerFinto implements AutoCloseable {
        final ServerSocket ascolto;
        final Thread filo;
        final Registrata registrata;
        final int stato;
        final Map<String, String> intestazioniRisposta;
        final long ritardoMs;
        volatile boolean chiuso = false;

        ServerFinto(Registrata registrata, int stato, Map<String, String> intestazioniRisposta, long ritardoMs) throws IOException {
            this.ascolto = new ServerSocket(0, 50, InetAddress.getLoopbackAddress());
            this.registrata = registrata;
            this.stato = stato;
            this.intestazioniRisposta = intestazioniRisposta;
            this.ritardoMs = ritardoMs;
            this.filo = new Thread(this::ciclo, "server-finto");
            this.filo.setDaemon(true);
            this.filo.start();
        }

        int porta() {
            return ascolto.getLocalPort();
        }

        private void ciclo() {
            while (!chiuso) {
                try (Socket connessione = ascolto.accept()) {
                    gestisci(connessione);
                } catch (IOException cadutaOChiusura) {
                    // chiusura del server o client caduto (test dei tempi massimi): si riparte, o si esce se chiuso
                    if (chiuso) return;
                }
            }
        }

        private static String leggiRiga(InputStream dentro) throws IOException {
            ByteArrayOutputStream riga = new ByteArrayOutputStream();
            int precedente = -1;
            int c;
            while ((c = dentro.read()) >= 0) {
                if (c == '\n' && precedente == '\r') {
                    byte[] byteRiga = riga.toByteArray();
                    return new String(byteRiga, 0, byteRiga.length - 1, StandardCharsets.ISO_8859_1);
                }
                riga.write(c);
                precedente = c;
            }
            throw new IOException("richiesta interrotta");
        }

        private void gestisci(Socket connessione) throws IOException {
            connessione.setSoTimeout(10_000);
            InputStream dentro = connessione.getInputStream();
            String primaRiga = leggiRiga(dentro);
            String[] parti = primaRiga.split(" ");
            Map<String, List<String>> viste = new java.util.TreeMap<>(String.CASE_INSENSITIVE_ORDER);
            String riga;
            while (!(riga = leggiRiga(dentro)).isEmpty()) {
                int duePunti = riga.indexOf(':');
                String nome = riga.substring(0, duePunti).trim();
                List<String> valori = viste.get(nome);
                if (valori == null) {
                    valori = new ArrayList<>();
                    viste.put(nome, valori);
                }
                valori.add(riga.substring(duePunti + 1).trim());
            }
            int lunghezza = viste.containsKey("content-length") ? Integer.parseInt(viste.get("content-length").get(0)) : 0;
            byte[] corpo = new byte[lunghezza];
            int letti = 0;
            while (letti < lunghezza) {
                int n = dentro.read(corpo, letti, lunghezza - letti);
                if (n < 0) throw new IOException("corpo interrotto");
                letti += n;
            }
            registrata.metodo = parti[0];
            registrata.percorso = parti[1];
            registrata.intestazioni = viste;
            registrata.corpo = corpo;
            if (ritardoMs > 0) {
                try {
                    Thread.sleep(ritardoMs);
                } catch (InterruptedException interrotto) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
            byte[] risposta = "{\"ok\":true}".getBytes(StandardCharsets.UTF_8);
            StringBuilder testa = new StringBuilder("HTTP/1.1 ").append(stato).append(" X\r\n");
            testa.append("Content-Type: application/json\r\nContent-Length: ").append(risposta.length).append("\r\nConnection: close\r\n");
            for (Map.Entry<String, String> voce : intestazioniRisposta.entrySet()) {
                testa.append(voce.getKey()).append(": ").append(voce.getValue()).append("\r\n");
            }
            testa.append("\r\n");
            java.io.OutputStream fuori = connessione.getOutputStream();
            fuori.write(testa.toString().getBytes(StandardCharsets.ISO_8859_1));
            fuori.write(risposta);
            fuori.flush();
        }

        @Override
        public void close() {
            chiuso = true;
            try {
                ascolto.close();
            } catch (IOException giaChiuso) {
                // il server è già chiuso: è ciò che si voleva
            }
            filo.interrupt();
        }
    }

    private ServerFinto avviaServer(final Registrata registrata, final int stato, final Map<String, String> intestazioniRisposta,
                                    final long ritardoMs) throws IOException {
        return new ServerFinto(registrata, stato, intestazioniRisposta, ritardoMs);
    }

    private static String urlDi(ServerFinto server) {
        return "http://127.0.0.1:" + server.porta() + "/api/logs";
    }

    private static String intestazione(Registrata registrata, String nome) {
        List<String> valori = registrata.intestazioni.get(nome);
        return valori == null || valori.isEmpty() ? null : valori.get(0);
    }

    @Test(timeout = 30_000)
    public void ilTrasportoHttpFaUnPostJsonConLIdentitaNellIntestazione() throws Exception {
        Registrata vista = new Registrata();
        ServerFinto server = avviaServer(vista, 200, Collections.<String, String>emptyMap(), 0L);
        try {
            byte[] corpo = "{\"eventi\":[],\"piattaforma\":\"android\"}".getBytes(StandardCharsets.UTF_8);
            RispostaTrasporto r = new RegistroNativo.TrasportoHttp().invia(urlDi(server), utente(1).toString(), corpo);
            assertEquals(200, r.stato);
            assertEquals(0L, r.retryAfterSecondi);
            assertEquals("POST", vista.metodo);
            assertEquals("/api/logs", vista.percorso);
            assertEquals("niente identità nell'indirizzo", -1, vista.percorso.indexOf("userId"));
            assertEquals("application/json; charset=utf-8", intestazione(vista, "content-type"));
            assertEquals(utente(1).toString(), intestazione(vista, "x-user-id"));
            assertEquals(String.valueOf(corpo.length), intestazione(vista, "content-length"));
            assertEquals(new String(corpo, StandardCharsets.UTF_8), new String(vista.corpo, StandardCharsets.UTF_8));
            assertNull("nessun cookie", intestazione(vista, "cookie"));
            assertNull("nessuna credenziale", intestazione(vista, "authorization"));
            assertNull(intestazione(vista, "apikey"));
        } finally {
            server.close();
        }
    }

    @Test
    public void laConnessioneSiConfiguraSenzaReindirizzamentiNeCacheNeCookie() throws Exception {
        java.net.HttpURLConnection c = (java.net.HttpURLConnection) java.net.URI.create("http://127.0.0.1:9/api/logs").toURL().openConnection();
        RegistroNativo.TrasportoHttp.configura(c, utente(1).toString(), 123, 11_111, 22_222);
        assertEquals("POST", c.getRequestMethod());
        assertEquals(11_111, c.getConnectTimeout());
        assertEquals(22_222, c.getReadTimeout());
        assertFalse("niente cache", c.getUseCaches());
        assertFalse("un reindirizzamento non si segue: su Android diventerebbe una GET altrove", c.getInstanceFollowRedirects());
        assertTrue(c.getDoOutput());
        assertEquals("application/json; charset=utf-8", c.getRequestProperty("content-type"));
        assertEquals("application/json", c.getRequestProperty("accept"));
        assertEquals(utente(1).toString(), c.getRequestProperty("x-user-id"));
        assertNull(c.getRequestProperty("cookie"));
        assertNull(c.getRequestProperty("authorization"));

        java.net.HttpURLConnection senza = (java.net.HttpURLConnection) java.net.URI.create("http://127.0.0.1:9/api/logs").toURL().openConnection();
        RegistroNativo.TrasportoHttp.configura(senza, null, 1, 1_000, 1_000);
        assertNull(senza.getRequestProperty("x-user-id"));
    }

    @Test(timeout = 30_000)
    public void senzaUtenteNonVaIntestazioneDiIdentita() throws Exception {
        Registrata vista = new Registrata();
        ServerFinto server = avviaServer(vista, 200, Collections.<String, String>emptyMap(), 0L);
        try {
            new RegistroNativo.TrasportoHttp().invia(urlDi(server), null, "{}".getBytes(StandardCharsets.UTF_8));
            assertNull(intestazione(vista, "x-user-id"));
        } finally {
            server.close();
        }
    }

    @Test(timeout = 30_000)
    public void ilTrasportoHttpPassaGliStatiEIlRetryAfter() throws Exception {
        long adesso = 784111767000L;                       // Sun, 06 Nov 1994 08:49:27 GMT
        Object[][] casi = {
                {200, null, 0L}, {201, null, 0L}, {400, null, 0L}, {403, null, 0L}, {404, null, 0L}, {413, null, 0L}, {500, null, 0L}, {503, "30", 30L},
                {429, "120", 120L}, {429, " 45 ", 45L}, {429, "99999", 3600L}, {429, "abc", 0L}, {429, "Sun, 06 Nov 1994 08:49:57 GMT", 30L},
                {429, null, 0L},
        };
        for (Object[] caso : casi) {
            Registrata vista = new Registrata();
            Map<String, String> intestazioni = new java.util.HashMap<>();
            if (caso[1] != null) intestazioni.put("Retry-After", (String) caso[1]);
            ServerFinto server = avviaServer(vista, (Integer) caso[0], intestazioni, 0L);
            try {
                RispostaTrasporto r = new RegistroNativo.TrasportoHttp(5_000, 5_000, () -> adesso)
                        .invia(urlDi(server), utente(1).toString(), "{}".getBytes(StandardCharsets.UTF_8));
                assertEquals("stato " + caso[0], ((Integer) caso[0]).intValue(), r.stato);
                assertEquals("Retry-After «" + caso[1] + "»", ((Long) caso[2]).longValue(), r.retryAfterSecondi);
            } finally {
                server.close();
            }
        }
    }

    @Test(timeout = 30_000)
    public void unReindirizzamentoNonSiSegueSiRestituisceLoStato() throws Exception {
        Registrata vista = new Registrata();
        ServerFinto server = avviaServer(vista, 302, Collections.singletonMap("Location", "http://127.0.0.1:1/altrove"), 0L);
        try {
            RispostaTrasporto r = new RegistroNativo.TrasportoHttp().invia(urlDi(server), null, "{}".getBytes(StandardCharsets.UTF_8));
            assertEquals(302, r.stato);
        } finally {
            server.close();
        }
    }

    @Test(timeout = 30_000)
    public void unaConnessioneRifiutataELanciaIoException() throws Exception {
        ServerFinto server = avviaServer(new Registrata(), 200, Collections.<String, String>emptyMap(), 0L);
        String url = urlDi(server);
        server.close();                       // la porta ora non ascolta più
        try {
            new RegistroNativo.TrasportoHttp(2_000, 2_000, System::currentTimeMillis).invia(url, null, "{}".getBytes(StandardCharsets.UTF_8));
            fail("la connessione doveva essere rifiutata");
        } catch (IOException atteso) {
            // nessuna risposta: il registro tiene gli eventi
        }
    }

    @Test(timeout = 30_000)
    public void unaRispostaCheNonArrivaScadeEUnIoExceptionEnonUnAttesaInfinita() throws Exception {
        Registrata vista = new Registrata();
        ServerFinto server = avviaServer(vista, 200, Collections.<String, String>emptyMap(), 8_000L);
        try {
            long inizio = System.nanoTime();
            try {
                new RegistroNativo.TrasportoHttp(2_000, 300, System::currentTimeMillis).invia(urlDi(server), null, "{}".getBytes(StandardCharsets.UTF_8));
                fail("il tempo massimo di lettura doveva scadere");
            } catch (SocketTimeoutException atteso) {
                // scaduto
            }
            assertTrue("è scaduto in fretta, non dopo gli 8 s del server", (System.nanoTime() - inizio) / 1_000_000L < 6_000L);
        } finally {
            server.close();
        }
    }

    /** Le regole di `eventoSchema` e `campiAmmessi` di `src/app/api/logs/route.ts`, riscritte: ciò che il server vero accetterebbe. */
    private static void verificaCheApiLogsLoAccetti(String corpo) throws Exception {
        assertTrue(corpo.length() <= 64_000);
        JSONObject radice = new JSONObject(corpo);
        assertTrue(Arrays.asList("web", "ios", "android").contains(radice.getString("piattaforma")));
        JSONArray eventi = radice.getJSONArray("eventi");
        assertTrue("1-20 eventi", eventi.length() >= 1 && eventi.length() <= 20);
        for (int i = 0; i < eventi.length(); i++) {
            JSONObject e = eventi.getJSONObject(i);
            assertTrue(e.getString("livello").equals("warn") || e.getString("livello").equals("error"));
            assertTrue("slug ^[a-z][a-z0-9-]{0,29}$", e.getString("evento").matches("^[a-z][a-z0-9-]{0,29}$"));
            assertTrue(e.getString("messaggio").length() >= 1 && e.getString("messaggio").length() <= 1000);
            if (e.has("stato")) assertTrue(e.getInt("stato") >= 0 && e.getInt("stato") <= 599);
            JSONObject campi = e.getJSONObject("campi");
            assertTrue("al più 12 campi", campi.length() <= 12);
            Iterator<String> chiavi = campi.keys();
            while (chiavi.hasNext()) {
                String chiave = chiavi.next();
                assertTrue("chiave " + chiave, CHIAVE_CAMPO.matcher(chiave).matches());
                Object valore = campi.get(chiave);
                if (valore instanceof String) {
                    assertTrue(((String) valore).length() <= 64);
                    assertTrue("chiave in chiaro: " + chiave, CHIAVI_DI_STRINGA.contains(chiave));
                    assertTrue(FORMA_ENUMERATO.matcher((String) valore).matches());
                } else {
                    assertTrue(valore instanceof Number || valore instanceof Boolean);
                }
            }
        }
    }

    @Test(timeout = 30_000)
    public void dalRegistroAlServerLocaleConIlTrasportoVero() throws Exception {
        Registrata vista = new Registrata();
        ServerFinto server = avviaServer(vista, 200, Collections.<String, String>emptyMap(), 0L);
        try {
            RegistroNativo r = registro();
            UUID j = job(7);
            UUID u = utente(7);
            r.videoAccodato(j, u, 3_000_000L, MimeLog.da("video/quicktime"), Motore.WORKMANAGER);
            r.videoRitento(j, u, Codice.RETE, 0, 1, 30L, 1000L);
            r.videoRinnovo(j, u, EsitoRinnovo.DA_CARICARE, 200, 1, ErroreStorage.INVALID_JWT);
            r.putOltreScadenza(j, u, 7_800L, 400);
            r.videoInviato(j, u, 3_000_000L, 9_000L, 2, 1, EsitoInvio.PUT, true);
            EsitoSvuotamento esito = r.svuota(urlDi(server), true, new RegistroNativo.TrasportoHttp());
            assertSame(EsitoSvuotamento.INVIATO, esito);
            assertEquals(u.toString(), intestazione(vista, "x-user-id"));
            verificaCheApiLogsLoAccetti(new String(vista.corpo, StandardCharsets.UTF_8));
            assertEquals(5, new JSONObject(new String(vista.corpo, StandardCharsets.UTF_8)).getJSONArray("eventi").length());
            assertEquals(0, r.numeroEventi());
        } finally {
            server.close();
        }
    }

    @Test(timeout = 30_000)
    public void unServerChePerdeUnLottoConUn500NonFaPerdereGliEventi() throws Exception {
        Registrata vista = new Registrata();
        ServerFinto server = avviaServer(vista, 500, Collections.<String, String>emptyMap(), 0L);
        try {
            RegistroNativo r = registro();
            r.videoAccodato(job(1), utente(1), 1L, MimeLog.MP4, Motore.UIDT);
            assertSame(EsitoSvuotamento.TENUTO_PER_SERVER, r.svuota(urlDi(server), true, new RegistroNativo.TrasportoHttp()));
            assertEquals(1, r.numeroEventi());
        } finally {
            server.close();
        }
    }

    @Test
    public void ilTrasportoDiProduzioneEIlTrasportoHttp() {
        // La factory di produzione usa logcat per la diagnostica e `registro.json` nella cartella dei caricamenti: qui si
        // verifica solo il nome del file, che il resto (Context, Log) non esiste sulla JVM.
        assertNotNull(RegistroNativo.TrasportoHttp.class);
        try {
            RegistroNativo.class.getMethod("perCartella", File.class, String.class);
        } catch (NoSuchMethodException assente) {
            fail("manca la factory di produzione");
        }
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * COMPITO A2: LE CORREZIONI AI MATTONI DI A1 (secondari n. 45-49 della PR 3)
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void iRinnoviSiDiradanoFraUnGuastoLungoMaLeFiniEIGuastiDaVedereSiScrivonoSempre() {
        // Sempre: la fine di una storia (arrivato, annullato) o un guasto da vedere (negato).
        for (EsitoRinnovo sempre : new EsitoRinnovo[]{EsitoRinnovo.ARRIVATO, EsitoRinnovo.ANNULLATO, EsitoRinnovo.NEGATO}) {
            for (int contatore : new int[]{0, 1, 2, 3, 5, 6, 7, 100}) {
                assertTrue(sempre + " " + contatore, RegistroNativo.siLoggaIlRinnovo(sempre, contatore));
            }
        }
        // Diradati come i ritentativi: potenze di due del contatore.
        for (EsitoRinnovo diradato : new EsitoRinnovo[]{EsitoRinnovo.DA_CARICARE, EsitoRinnovo.TETTO, EsitoRinnovo.RETE, EsitoRinnovo.SERVER}) {
            List<Integer> scritti = new ArrayList<>();
            for (int contatore = 0; contatore <= 70; contatore++) if (RegistroNativo.siLoggaIlRinnovo(diradato, contatore)) scritti.add(contatore);
            assertEquals(diradato.name(), Arrays.asList(1, 2, 4, 8, 16, 32, 64), scritti);
            assertFalse(RegistroNativo.siLoggaIlRinnovo(diradato, -1));
        }
    }

    @Test
    public void inReleaseLaDestinazioneEFissaEInDebugEQuellaDellaPagina() {
        assertEquals("https://app.kidville.it/api/logs", RegistroNativo.URL_REGISTRO_RELEASE);
        assertTrue("l'indirizzo fisso passa la politica degli host di Release (§9)",
                PoliticaCaricamento.urlAmmesso(RegistroNativo.URL_REGISTRO_RELEASE, PoliticaCaricamento.Destinazione.REGISTRO, false));
        assertEquals("Release: sempre il sito, anche senza una voce che lo porti (all'avvio, al primo piano)", RegistroNativo.URL_REGISTRO_RELEASE,
                RegistroNativo.destinazione(null, false));
        assertEquals("Release: qualunque cosa abbia passato la pagina", RegistroNativo.URL_REGISTRO_RELEASE,
                RegistroNativo.destinazione("https://app.kidville.it/altro", false));
        assertEquals("Debug: quella della pagina (il server finto di collaudo)", "http://10.0.2.2:3101/api/logs",
                RegistroNativo.destinazione("http://10.0.2.2:3101/api/logs", true));
        assertNull("Debug senza indirizzo noto: non si spedisce niente (i log di una build Debug non vanno in produzione)", RegistroNativo.destinazione(null, true));
    }

    @Test
    public void ilRegistroDiProduzioneEUnoSoloPerCartella() throws Exception {
        File cartella = temporanea.newFolder("processo");
        RegistroNativo primo = RegistroNativo.perCartella(cartella, "1.2+6");
        assertSame("una sola istanza per processo", primo, RegistroNativo.perCartella(cartella, "1.2+7"));
        assertSame("anche con la cartella scritta in un altro modo", primo, RegistroNativo.perCartella(new File(cartella, "../processo"), "1.2+6"));
        assertTrue(primo != RegistroNativo.perCartella(temporanea.newFolder("altro"), "1.2+6"));
        primo.videoRipresoDopoChiusura(job(1), utente(1), 5L);
        assertEquals("stesso stato", 1, RegistroNativo.perCartella(cartella, "1.2+6").numeroEventi());
    }

    @Test
    public void unaScritturaCheSulTelefonoNonRinominaVieneContataComeGuastoInternoENonSiPerdeIlRegistroInMemoria() throws Exception {
        AtomicFileCheNonTrasloca nonTrasloca = new AtomicFileCheNonTrasloca(fileRegistro, false);
        RegistroNativo r = new RegistroNativo(nonTrasloca, VERSIONE, orologio::get, diagnostica);
        r.videoRipresoDopoChiusura(job(1), utente(1), 10L);
        assertEquals("l'evento c'è in memoria: si potrà ancora spedire", 1, r.numeroEventi());
        assertEquals("ma il guasto si conta e si dice (sul telefono finishWrite non lancia: lo dice la verifica)", 1, r.erroriInterni());
        assertEquals("una sola riga di guasto, col nome dell'operazione e la CLASSE dell'eccezione (qui il file base non c'è)",
                Arrays.asList("salva-registro:FileNotFoundException"), diagnostica.voci);
        assertFalse("sul disco non c'è niente", fileRegistro.exists());
        nonTrasloca.traslocaDavvero = true;
        r.videoRipresoDopoChiusura(job(2), utente(1), 20L);
        assertEquals("riaccesa la rinomina il registro scrive TUTTO, anche l'evento di prima", 2, registro().numeroEventi());
    }

    @Test
    public void codaCorrottaEVociScartateHannoLeChiaviDelContratto() {
        assertEquals("voci_scartate", RegistroNativo.Campo.VOCI_SCARTATE.chiave());
        assertSame(RegistroNativo.Campo.VOCI_SCARTATE, RegistroNativo.Campo.daChiave("voci_scartate"));
        assertEquals("durata_s", RegistroNativo.Campo.DURATA_S.chiave());
    }
}
