package it.kidville.app.caricamenti;

import androidx.core.util.AtomicFile;

import it.kidville.app.caricamenti.PoliticaCaricamento.Codice;
import it.kidville.app.caricamenti.PoliticaCaricamento.Destinazione;
import it.kidville.app.caricamenti.PoliticaCaricamento.ErroreStorage;
import it.kidville.app.caricamenti.PoliticaCaricamento.EsitoRinnovo;
import it.kidville.app.caricamenti.PoliticaCaricamento.Motore;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.function.LongSupplier;
import java.util.function.Supplier;
import java.util.regex.Pattern;

/**
 * IL REGISTRO DEI LOG NATIVI: ciò che il motore racconta di sé, senza poter raccontare altro.
 * (spec 2026-10-03 «app 1.2: caricamenti nativi in background», §4.6, §6.1, §8.1, §8.2, §9; compito A1)
 *
 * ─── PERCHÉ ESISTE ───────────────────────────────────────────────────────────────────────────
 * Un trasferimento in background gira quando nessuno guarda: se fallisce senza dirlo, nessuno lo
 * sa (è già successo, con le email: AGENTS.md, «Logging obbligatorio»). Il motore scrive qui ogni
 * evento che conta — anche i SUCCESSI, perché «nessun log» non distingue «tutto ok» da «non è
 * mai partito niente» — e il registro li spedisce a `POST /api/logs`, dove diventano righe
 * `client:caricamento-nativo` di `app_log`. Gli eventi sono su DISCO (`registro.json`): un
 * processo ucciso un attimo dopo la fine di un video non perde la riga che lo dice.
 *
 * ─── IL TIPO È LA GARANZIA, NON LA DISCIPLINA ────────────────────────────────────────────────
 * Un video è il video di un bambino: nome del file, percorso, URL firmato, token, `sha256`, messaggio
 * di un'eccezione NON devono mai arrivare in un log, e il modo di esserne sicuri è che il codice
 * non possa nemmeno scriverli. Ogni metodo di evento prende SOLO uuid, numeri, booleani ed ENUMERATI
 * (elenchi chiusi: `Codice`, `MimeLog`, `ClasseErrore`...): nessun parametro `String`, `Object` o
 * `Throwable` (un test lo verifica per riflessione su ogni metodo). Il messaggio è sempre uno slug
 * dell'elenco chiuso di §8.2 + `job=<uuid>` + al più un codice enumerato; i `campi` sono solo numeri,
 * booleani e stringhe che escono da un enumerato, sotto chiavi che il server lascia in chiaro.
 * Per un errore di sistema si logga la CLASSE dell'eccezione, mai il suo messaggio (`ClasseErrore.di`).
 *
 * ─── COME SI COMPORTA ────────────────────────────────────────────────────────────────────────
 *  · TETTO 200 EVENTI: oltre, si scartano i più vecchi e si CONTANO; lo scarto non è muto: al
 *    prossimo invio il registro aggiunge `registro-nativo-scartati` col numero.
 *  · SPEDIZIONE: `POST registro.url` con `x-user-id: <utente della voce>`, corpo `{eventi, piattaforma}`,
 *    lotti di al più 20 eventi di UN utente, al più uno ogni 10 secondi. 2xx: il lotto esce; 429: si tiene
 *    e si aspetta `Retry-After`; ogni altro 4xx: il lotto si scarta e si conta (è un nostro difetto, e
 *    ripeterlo non lo guarirebbe); 5xx o rete: si tiene. Un video «normale» costa 4 righe.
 *  · I RITENTATIVI SI DIRADANO: si loggano ai tentativi 1, 2, 4, 8, 16...: la coda insiste, il registro no.
 *  · FAIL-OPEN (AGENTS.md, regola 9): il registro non lancia MAI al chiamante. Un guasto interno
 *    (disco pieno, evento fuori forma) si conta (`erroriInterni`) e si dice in logcat (`Diagnostica`),
 *    senza classi di eccezione che non siano il loro nome.
 *  · La rete non si tiene sotto il blocco: mentre il POST è in volo gli altri thread possono ancora
 *    scrivere eventi.
 *
 * ─── DUE COSE CHE NON SONO NELLA TABELLA DI §8.2, E CHE VANNO ALLINEATE ──────────────────────
 *  · `put-oltre-scadenza` (§3 e §4.5: «con il log `put-oltre-scadenza` che porta la durata del
 *    trasferimento in secondi») è un quindicesimo messaggio, con il campo `durata_s`. Non sta in
 *    `EVENTI_LOG_NATIVI` (TypeScript) né nelle liste del server finto di collaudo: finché non
 *    vi si aggiunge, il lock J4 e le verifiche S12 lo segnaleranno.
 *  · Tutti gli eventi con un utente lo portano nell'intestazione; quelli senza (`coda-nativa-corrotta`
 *    all'avvio, `registro-nativo-scartati` se non resta altro) partono senza `x-user-id`.
 */
public final class RegistroNativo {

    public static final int VERSIONE = 1;
    /** Gli eventi tenuti su disco: oltre, si scartano i più vecchi e si contano (§4.6). */
    public static final int TETTO_EVENTI = 200;
    /** Gli eventi di un lotto: lo stesso tetto di `/api/logs` (`BATCH_MAX`). */
    public static final int LOTTO_MASSIMO = 20;
    /** Al più un POST ogni 10 secondi (§8.1). */
    public static final long INTERVALLO_MINIMO_INVIO_MS = 10_000L;
    /** Gli eventi di un utente non possono pesare più di `/api/logs` (`BYTE_MAX`): oltre il server risponde 413. */
    public static final int CORPO_MASSIMO_BYTE = 64_000;
    /** Il nome dell'evento, uguale per tutto il nativo: salvato dal server come `client:caricamento-nativo` (§8.1). */
    public static final String NOME_EVENTO_LOG = "caricamento-nativo";
    public static final String PIATTAFORMA = "android";
    public static final String INTESTAZIONE_UTENTE = "x-user-id";
    /** I campi di un evento: lo stesso tetto di `/api/logs` (`CAMPI_MAX`). */
    public static final int CAMPI_MASSIMI = 12;

    private static final String TAG_LOGCAT = "KidvilleCaricamenti";
    private static final int MESSAGGIO_MASSIMO = 1000;
    /** `FORMA_VERSIONE_APP` di `src/lib/logging/client.ts`: solo con questa forma il server lascia `versione_app` in chiaro. */
    private static final Pattern FORMA_VERSIONE_APP = Pattern.compile("^\\d{1,4}(\\.\\d{1,4}){0,3}\\+\\d{1,9}$");
    private static final Pattern FORMA_UUID = Pattern.compile("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");

    /* ────────────────────────────────────────────────────────────────────────────
     * I VOCABOLARI CHIUSI
     * ──────────────────────────────────────────────────────────────────────────── */

    public enum Livello {
        WARN("warn"),
        ERROR("error");

        private final String valore;

        Livello(String valore) {
            this.valore = valore;
        }

        public String valore() {
            return valore;
        }

        static Livello daValore(String valore) {
            for (Livello livello : values()) {
                if (livello.valore.equals(valore)) return livello;
            }
            return null;
        }
    }

    /**
     * I messaggi che il nativo può scrivere: i quattordici di §8.2 (`EVENTI_LOG_NATIVI`) e `put-oltre-scadenza` (testata). Lo slug
     * apre il messaggio; il livello è quello della tabella: i successi critici sono `warn`, perché `/api/logs` non accetta `info`.
     */
    public enum Evento {
        VIDEO_ACCODATO("video-nativo-accodato", Livello.WARN),
        VIDEO_INVIATO("video-nativo-inviato", Livello.WARN),
        VIDEO_RITENTO("video-nativo-ritento", Livello.WARN),
        VIDEO_RINNOVO("video-nativo-rinnovo", Livello.WARN),
        VIDEO_ATTESA_RETE("video-nativo-attesa-rete", Livello.WARN),
        VIDEO_PAUSA("video-nativo-pausa", Livello.WARN),
        VIDEO_RIPRESO_DOPO_CHIUSURA("video-nativo-ripreso-dopo-chiusura", Livello.WARN),
        VIDEO_ANNULLATO("video-nativo-annullato", Livello.WARN),
        VIDEO_FALLITO("video-nativo-fallito", Livello.ERROR),
        MEDIA_PREPARAZIONE_FALLITA("media-nativo-preparazione-fallita", Livello.ERROR),
        MOTORE("caricamenti-nativi-motore", Livello.WARN),
        CODA_CORROTTA("coda-nativa-corrotta", Livello.ERROR),
        REGISTRO_SCARTATI("registro-nativo-scartati", Livello.WARN),
        NOTIFICA_NON_AUTORIZZATA("notifica-locale-non-autorizzata", Livello.WARN),
        PUT_OLTRE_SCADENZA("put-oltre-scadenza", Livello.WARN);

        private final String slug;
        private final Livello livello;

        Evento(String slug, Livello livello) {
            this.slug = slug;
            this.livello = livello;
        }

        public String slug() {
            return slug;
        }

        public Livello livello() {
            return livello;
        }

        static Evento daSlug(String slug) {
            for (Evento evento : values()) {
                if (evento.slug.equals(slug)) return evento;
            }
            return null;
        }
    }

    /**
     * Le chiavi di `campi`: l'unione delle colonne di §8.1 e §8.2, più `versione_app` e `durata_s`. Le prime sei portano
     * stringhe (che il server lascia in chiaro e ammette solo con la forma di un enumerato); le altre numeri o booleani.
     */
    enum Campo {
        ESITO("esito"),
        ERROR_CODE("error_code"),
        OPERAZIONE("operazione"),
        TIPO("tipo"),
        AMBIENTE("ambiente"),
        MIME("mime"),
        VERSIONE_APP("versione_app"),
        BYTE("byte"),
        MS("ms"),
        TENTATIVI("tentativi"),
        RINNOVI("rinnovi"),
        IN_BACKGROUND("in_background"),
        TENTATIVO("tentativo"),
        ATTESA_S("attesa_s"),
        BYTE_INVIATI("byte_inviati"),
        NOTIFICA("notifica"),
        AUTORIZZATA("autorizzata"),
        SDK("sdk"),
        IN_CODA("in_coda"),
        IN_INVIO("in_invio"),
        TASK_VIVI("task_vivi"),
        FILE_ORFANI("file_orfani"),
        SCARTATI("scartati"),
        DURATA_S("durata_s");

        private final String chiave;

        Campo(String chiave) {
            this.chiave = chiave;
        }

        String chiave() {
            return chiave;
        }

        static Campo daChiave(String chiave) {
            for (Campo campo : values()) {
                if (campo.chiave.equals(chiave)) return campo;
            }
            return null;
        }
    }

    /** Il tipo di un video, da un elenco chiuso: del MIME salvato si logga solo la parte prima del `;`, e solo se è fra questi. */
    public enum MimeLog {
        MP4("video/mp4"),
        QUICKTIME("video/quicktime"),
        TRE_GPP("video/3gpp"),
        TRE_GPP2("video/3gpp2"),
        WEBM("video/webm"),
        MATROSKA("video/x-matroska"),
        M4V("video/x-m4v"),
        MPEG("video/mpeg"),
        ALTRO("altro");

        private final String valore;

        MimeLog(String valore) {
            this.valore = valore;
        }

        public String valore() {
            return valore;
        }

        /** Riduce un MIME qualunque (anche `video/mp4;codecs=avc1`) all'elemento dell'elenco; ciò che non c'è vale `ALTRO`. */
        public static MimeLog da(String mime) {
            if (mime == null) return ALTRO;
            String base = mime;
            int punto = base.indexOf(';');
            if (punto >= 0) base = base.substring(0, punto);
            base = base.trim().toLowerCase(Locale.ROOT);
            for (MimeLog candidato : values()) {
                if (candidato != ALTRO && candidato.valore.equals(base)) return candidato;
            }
            return ALTRO;
        }
    }

    /** Come è finita la spedizione: la PUT è andata a buon fine, o il rinnovo ha detto che il file c'era già (§8.2). */
    public enum EsitoInvio {
        PUT("put"),
        GIA_ARRIVATO("gia-arrivato");

        private final String valore;

        EsitoInvio(String valore) {
            this.valore = valore;
        }

        public String valore() {
            return valore;
        }
    }

    /** Chi ha annullato la voce. */
    public enum Da {
        UTENTE("utente"),
        SERVER("server");

        private final String valore;

        Da(String valore) {
            this.valore = valore;
        }

        public String valore() {
            return valore;
        }
    }

    /** Che cosa stava facendo la voce quando è fallita (`video-nativo-fallito`, campo `operazione`). */
    public enum Operazione {
        PUT("put"),
        RINNOVO("rinnovo"),
        COPIA("copia");

        private final String valore;

        Operazione(String valore) {
            this.valore = valore;
        }

        public String valore() {
            return valore;
        }
    }

    public enum TipoMedia {
        FOTO("foto"),
        VIDEO("video");

        private final String valore;

        TipoMedia(String valore) {
            this.valore = valore;
        }

        public String valore() {
            return valore;
        }
    }

    /** Quando è partito il motore con voci vive (§8.2). */
    public enum Occasione {
        AVVIO("avvio"),
        RILANCIO_BACKGROUND("rilancio-background"),
        PRIMO_PIANO("primo-piano");

        private final String valore;

        Occasione(String valore) {
            this.valore = valore;
        }

        public String valore() {
            return valore;
        }
    }

    /** Perché la preparazione di un elemento è fallita per un motivo NOSTRO (non i rifiuti attesi: troppo grande, troppo lungo...). */
    public enum MotivoPreparazione {
        COPIA,
        HASH,
        RIDUZIONE,
        INTERNO
    }

    /**
     * La CLASSE di un'eccezione, da un elenco chiuso: per un errore di sistema si logga «il nome semplice della classe» (§8.1)
     * e mai il suo messaggio, che può contenere un percorso o un nome di file. `valore()` ha la forma di un enumerato.
     */
    public enum ClasseErrore {
        FILE_NON_TROVATO("FileNotFoundException"),
        IO("IOException"),
        SICUREZZA("SecurityException"),
        MEMORIA_ESAURITA("OutOfMemoryError"),
        STATO_ILLEGALE("IllegalStateException"),
        ARGOMENTO_ILLEGALE("IllegalArgumentException"),
        PUNTATORE_NULLO("NullPointerException"),
        ALTRO("altro");

        private final String valore;

        ClasseErrore(String valore) {
            this.valore = valore;
        }

        public String valore() {
            return valore;
        }

        /** La classe dell'eccezione; ogni tipo che non è nell'elenco vale `ALTRO`. */
        public static ClasseErrore di(Throwable errore) {
            if (errore instanceof FileNotFoundException) return FILE_NON_TROVATO;
            if (errore instanceof IOException) return IO;
            if (errore instanceof SecurityException) return SICUREZZA;
            if (errore instanceof OutOfMemoryError) return MEMORIA_ESAURITA;
            if (errore instanceof IllegalStateException) return STATO_ILLEGALE;
            if (errore instanceof IllegalArgumentException) return ARGOMENTO_ILLEGALE;
            if (errore instanceof NullPointerException) return PUNTATORE_NULLO;
            return ALTRO;
        }
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL TRASPORTO E LA DIAGNOSTICA (iniettabili)
     * ──────────────────────────────────────────────────────────────────────────── */

    /** L'esito di un POST: lo stato HTTP (0 = nessuna risposta) e `Retry-After` in secondi (0 = assente). */
    public static final class RispostaTrasporto {
        public final int stato;
        public final long retryAfterSecondi;

        public RispostaTrasporto(int stato, long retryAfterSecondi) {
            this.stato = stato;
            this.retryAfterSecondi = retryAfterSecondi;
        }
    }

    /** Come un lotto arriva al server. In produzione `TrasportoHttp`; nei test un finto che registra e risponde a comando. */
    public interface Trasporto {
        /** `utenteId` è `null` per un lotto senza identità. Lancia `IOException` se la risposta non arriva. */
        RispostaTrasporto invia(String url, String utenteId, byte[] corpoJson) throws IOException;
    }

    /**
     * Dove finisce un guasto del registro stesso: in logcat, mai nel registro (si mangerebbe la coda). `evento` è un nome
     * costante di questo file; della causa si dice solo la classe.
     */
    public interface Diagnostica {
        void errore(String evento, Throwable causa);
    }

    /** La diagnostica di produzione. Separata perché solo qui compare `android.util.Log`, che in JUnit non esiste. */
    private static final class DiagnosticaLogcat implements Diagnostica {
        @Override
        public void errore(String evento, Throwable causa) {
            android.util.Log.e(TAG_LOGCAT, evento + " (" + (causa == null ? "senza causa" : causa.getClass().getSimpleName()) + ")");
        }
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * GLI EVENTI REGISTRATI
     * ──────────────────────────────────────────────────────────────────────────── */

    /** Un evento com'è nel registro (vista di sola lettura): ciò che partirebbe verso `/api/logs`, più l'utente che lo firma. */
    public static final class EventoRegistrato {
        /** L'utente della voce (uuid); `null` per un evento senza identità. */
        public final String utenteId;
        public final Livello livello;
        public final String messaggio;
        /** Lo stato HTTP (0 = nessuna risposta); `null` se l'evento non ne ha uno. */
        public final Integer stato;
        /** Chiave → numero, booleano o stringa di un elenco chiuso; nell'ordine in cui sono stati scritti. */
        public final Map<String, Object> campi;
        /** Vero per `registro-nativo-scartati`, scritto dal registro stesso. */
        public final boolean meta;

        EventoRegistrato(String utenteId, Livello livello, String messaggio, Integer stato, Map<String, Object> campi, boolean meta) {
            this.utenteId = utenteId;
            this.livello = livello;
            this.messaggio = messaggio;
            this.stato = stato;
            this.campi = Collections.unmodifiableMap(new LinkedHashMap<>(campi));
            this.meta = meta;
        }
    }

    /** L'esito di un tentativo di svuotare il registro. */
    public enum EsitoSvuotamento {
        /** Non c'era niente da spedire. */
        NIENTE_DA_INVIARE,
        /** Troppo presto: l'ultimo POST è di meno di 10 secondi fa (o c'è un `Retry-After` da rispettare). */
        RIMANDATO,
        /** Un altro thread sta già spedendo. */
        GIA_IN_CORSO,
        /** L'indirizzo non è quello del sito (§9): niente è partito. */
        DESTINAZIONE_NON_AMMESSA,
        /** 2xx: il lotto è uscito dal registro. */
        INVIATO,
        /** Nessuna risposta: gli eventi restano. */
        TENUTO_PER_RETE,
        /** 5xx o uno stato non previsto: gli eventi restano. */
        TENUTO_PER_SERVER,
        /** 429: gli eventi restano e si aspetta `Retry-After`. */
        TENUTO_PER_LIMITE,
        /** Altro 4xx: il lotto è stato scartato e contato. */
        LOTTO_SCARTATO
    }

    private static final class Riga {
        final String utenteId;
        final Livello livello;
        final String messaggio;
        final Integer stato;
        final Map<String, Object> campi;
        final boolean meta;

        Riga(String utenteId, Livello livello, String messaggio, Integer stato, Map<String, Object> campi, boolean meta) {
            this.utenteId = utenteId;
            this.livello = livello;
            this.messaggio = messaggio;
            this.stato = stato;
            this.campi = campi;
            this.meta = meta;
        }
    }

    /** Costruisce i `campi` di un evento: solo chiavi dell'enum `Campo`, solo numeri, booleani e stringhe che escono da un enumerato. */
    private static final class Campi {
        final LinkedHashMap<String, Object> valori = new LinkedHashMap<>();

        Campi numero(Campo campo, long valore) {
            valori.put(campo.chiave(), Long.valueOf(Math.max(valore, 0L)));
            return this;
        }

        Campi booleano(Campo campo, boolean valore) {
            valori.put(campo.chiave(), Boolean.valueOf(valore));
            return this;
        }

        /** Il valore è SEMPRE il `valore()` di un enum chiuso di questo file: nessun metodo pubblico accetta una stringa. */
        Campi enumerato(Campo campo, String valoreDiUnEnum) {
            valori.put(campo.chiave(), valoreDiUnEnum);
            return this;
        }
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * LO STATO
     * ──────────────────────────────────────────────────────────────────────────── */

    private final AtomicFile atomico;
    private final String versioneApp;
    private final LongSupplier orologio;
    private final Diagnostica diagnostica;
    private final List<Riga> righe = new ArrayList<>();
    private long scartati = 0L;
    private long nonPrimaDiMs = 0L;
    private boolean inVolo = false;
    private int erroriInterni = 0;
    private int diagnosticheCadute = 0;

    /**
     * @param fileRegistro `registro.json`, dentro la cartella dei caricamenti (`getNoBackupFilesDir()/caricamenti`)
     * @param versioneApp  nella forma `1.2+4` (`versionName+versionCode`): finisce in `versione_app` di ogni evento. Una forma
     *                     diversa la farebbe cancellare dal server, e il campo si omette
     * @param orologio     millisecondi dall'epoca (`System::currentTimeMillis`)
     */
    public RegistroNativo(File fileRegistro, String versioneApp, LongSupplier orologio, Diagnostica diagnostica) {
        this.atomico = new AtomicFile(fileRegistro);
        this.versioneApp = versioneApp != null && FORMA_VERSIONE_APP.matcher(versioneApp).matches() ? versioneApp : null;
        this.orologio = orologio;
        this.diagnostica = diagnostica;
        carica();
    }

    /** Il registro di produzione: `registro.json` nella cartella dei caricamenti, logcat per i guasti interni. */
    public static RegistroNativo perCartella(File cartellaCaricamenti, String versioneApp) {
        return new RegistroNativo(new File(cartellaCaricamenti, "registro.json"), versioneApp, System::currentTimeMillis,
                new DiagnosticaLogcat());
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * GLI EVENTI (§8.2): un metodo per messaggio, tutti a enumerati e numeri
     * ──────────────────────────────────────────────────────────────────────────── */

    /** `video-nativo-accodato: job=<uuid>` — `accodaVideo` riuscito. */
    public void videoAccodato(UUID job, UUID utente, long byteTotali, MimeLog mime, Motore ambiente) {
        registra("video-accodato", Evento.VIDEO_ACCODATO, utente, job, () -> new Dettagli(null, null,
                new Campi().numero(Campo.BYTE, byteTotali).enumerato(Campo.MIME, mime.valore())
                        .enumerato(Campo.AMBIENTE, ambiente.valore())));
    }

    /** `video-nativo-inviato: job=<uuid>` — PUT 2xx, o rinnovo `arrivato`. `ms` è la durata del trasferimento. */
    public void videoInviato(UUID job, UUID utente, long byteTotali, long ms, int tentativi, int rinnovi, EsitoInvio esito,
                             boolean inBackground) {
        registra("video-inviato", Evento.VIDEO_INVIATO, utente, job, () -> new Dettagli(null, null,
                new Campi().numero(Campo.BYTE, byteTotali).numero(Campo.MS, ms).numero(Campo.TENTATIVI, tentativi)
                        .numero(Campo.RINNOVI, rinnovi).enumerato(Campo.ESITO, esito.valore())
                        .booleano(Campo.IN_BACKGROUND, inBackground)));
    }

    /**
     * `video-nativo-ritento: job=<uuid> <CODICE>` — un transitorio (rete, 5xx, 408/429). Si logga solo ai tentativi 1, 2, 4, 8, 16...
     * (§8.1): la coda insiste, il registro no. `statoHttp` è quello della PUT (0 = nessuna risposta).
     *
     * @return vero se la riga è stata scritta
     */
    public boolean videoRitento(UUID job, UUID utente, Codice codice, int statoHttp, int tentativo, long attesaSecondi,
                                long byteInviati) {
        if (!siLoggaIlRitento(tentativo)) return false;
        return registra("video-ritento", Evento.VIDEO_RITENTO, utente, job, () -> new Dettagli(codice.name(), statoHttp,
                new Campi().numero(Campo.TENTATIVO, tentativo).numero(Campo.ATTESA_S, attesaSecondi)
                        .numero(Campo.BYTE_INVIATI, byteInviati)));
    }

    /**
     * `video-nativo-rinnovo: job=<uuid> <esito>` — ogni rinnovo. `statoHttp` è quello della risposta del rinnovo. `errorePut` è
     * il nome d'errore dello Storage che ha chiesto il rinnovo (`null` per il rinnovo proattivo): finisce in `error_code`.
     */
    public void videoRinnovo(UUID job, UUID utente, EsitoRinnovo esito, int statoHttp, int rinnovi, ErroreStorage errorePut) {
        registra("video-rinnovo", Evento.VIDEO_RINNOVO, utente, job, () -> {
            Campi campi = new Campi().numero(Campo.RINNOVI, rinnovi);
            if (errorePut != null) campi.enumerato(Campo.ERROR_CODE, errorePut.valore());
            return new Dettagli(esito.valore(), statoHttp, campi);
        });
    }

    /**
     * `video-nativo-attesa-rete: job=<uuid>` — Android: attesa di rete oltre i 60 secondi nel worker. `notifica` dice se c'è
     * una notifica visibile, `autorizzata` se il permesso alle notifiche c'è.
     */
    public void videoAttesaRete(UUID job, UUID utente, boolean notifica, boolean autorizzata) {
        registra("video-attesa-rete", Evento.VIDEO_ATTESA_RETE, utente, job, () -> new Dettagli(null, null,
                new Campi().booleano(Campo.NOTIFICA, notifica).booleano(Campo.AUTORIZZATA, autorizzata)));
    }

    /** `video-nativo-pausa: job=<uuid> <CODICE>` — `FGS_NON_AVVIABILE` o `UIDT_NON_PROGRAMMABILE`; `sdk` è il livello di API. */
    public void videoInPausa(UUID job, UUID utente, Codice codice, int sdk) {
        registra("video-in-pausa", Evento.VIDEO_PAUSA, utente, job,
                () -> new Dettagli(codice.name(), null, new Campi().numero(Campo.SDK, sdk)));
    }

    /** `video-nativo-ripreso-dopo-chiusura: job=<uuid>` — un trasferimento ripartito dopo una chiusura forzata dell'app. */
    public void videoRipresoDopoChiusura(UUID job, UUID utente, long byteInviati) {
        registra("video-ripreso-dopo-chiusura", Evento.VIDEO_RIPRESO_DOPO_CHIUSURA, utente, job,
                () -> new Dettagli(null, null, new Campi().numero(Campo.BYTE_INVIATI, byteInviati)));
    }

    /** `video-nativo-annullato: job=<uuid> <da>` — `utente` o `server`. */
    public void videoAnnullato(UUID job, UUID utente, Da da, long byteInviati) {
        registra("video-annullato", Evento.VIDEO_ANNULLATO, utente, job,
                () -> new Dettagli(da.valore(), null, new Campi().numero(Campo.BYTE_INVIATI, byteInviati)));
    }

    /** `video-nativo-fallito: job=<uuid> <CODICE>` — stato terminale `fallito` (livello `error`). */
    public void videoFallito(UUID job, UUID utente, Codice codice, Operazione operazione, int tentativi, int rinnovi) {
        registra("video-fallito", Evento.VIDEO_FALLITO, utente, job, () -> new Dettagli(codice.name(), null,
                new Campi().enumerato(Campo.OPERAZIONE, operazione.valore()).numero(Campo.TENTATIVI, tentativi)
                        .numero(Campo.RINNOVI, rinnovi)));
    }

    /**
     * `put-oltre-scadenza: job=<uuid>` — la PUT è stata rifiutata con `InvalidJWT` DOPO un trasferimento completo: la firma è
     * scaduta durante l'invio (S0-b, §3). `durataSecondi` è la durata del trasferimento. Vedi la testata: non è nella tabella di §8.2.
     */
    public void putOltreScadenza(UUID job, UUID utente, long durataSecondi, int statoHttp) {
        registra("put-oltre-scadenza", Evento.PUT_OLTRE_SCADENZA, utente, job,
                () -> new Dettagli(null, statoHttp, new Campi().numero(Campo.DURATA_S, durataSecondi)));
    }

    /** `media-nativo-preparazione-fallita: <MOTIVO>` — copia, hash o riduzione falliti per un motivo nostro (livello `error`). */
    public void preparazioneFallita(UUID utente, TipoMedia tipo, MotivoPreparazione motivo, ClasseErrore classe) {
        registra("preparazione-fallita", Evento.MEDIA_PREPARAZIONE_FALLITA, utente, null, () -> new Dettagli(motivo.name(), null,
                new Campi().enumerato(Campo.TIPO, tipo.valore()).enumerato(Campo.ERROR_CODE, classe.valore())));
    }

    /** `caricamenti-nativi-motore: <motore> <occasione>` — avvio del motore con voci vive. */
    public void motore(UUID utente, Motore motore, Occasione occasione, int inCoda, int inInvio, int taskVivi) {
        registra("motore", Evento.MOTORE, utente, null, () -> new Dettagli(motore.valore() + " " + occasione.valore(), null,
                new Campi().numero(Campo.IN_CODA, inCoda).numero(Campo.IN_INVIO, inInvio).numero(Campo.TASK_VIVI, taskVivi)));
    }

    /** `coda-nativa-corrotta` — `coda.json` illeggibile (livello `error`); `fileOrfani` viene dal `Rapporto` della coda. */
    public void codaCorrotta(UUID utente, int fileOrfani) {
        registra("coda-corrotta", Evento.CODA_CORROTTA, utente, null,
                () -> new Dettagli(null, null, new Campi().numero(Campo.FILE_ORFANI, fileOrfani)));
    }

    /** `notifica-locale-non-autorizzata` — una volta per installazione (iOS; qui per parità di vocabolario). */
    public void notificaNonAutorizzata(UUID utente) {
        registra("notifica-non-autorizzata", Evento.NOTIFICA_NON_AUTORIZZATA, utente, null,
                () -> new Dettagli(null, null, new Campi()));
    }

    /** I ritentativi si loggano ai tentativi 1, 2, 4, 8, 16... (§8.1): le potenze di due. */
    public static boolean siLoggaIlRitento(int tentativo) {
        return tentativo >= 1 && (tentativo & (tentativo - 1)) == 0;
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * REGISTRAZIONE
     * ──────────────────────────────────────────────────────────────────────────── */

    /** Ciò che distingue un evento da un altro oltre allo slug: l'eventuale codice del messaggio, lo stato HTTP, i campi. */
    private static final class Dettagli {
        final String suffisso;
        final Integer stato;
        final Campi campi;

        Dettagli(String suffisso, Integer stato, Campi campi) {
            this.suffisso = suffisso;
            this.stato = stato;
            this.campi = campi;
        }
    }

    /**
     * Scrive un evento. FAIL-OPEN: i dettagli si costruiscono DENTRO il blocco protetto (un enumerato nullo passato per errore
     * lancia qui, non nel chiamante) e qualunque guasto — un argomento nullo, il disco pieno — si conta e si dice in logcat senza
     * uscire di qui. Restituisce se l'evento è stato accodato.
     */
    private boolean registra(String nome, Evento evento, UUID utente, UUID job, Supplier<Dettagli> dettagli) {
        try {
            Dettagli d = dettagli.get();
            String messaggio = evento.slug();
            if (job != null) messaggio += ": job=" + job;
            if (d.suffisso != null) messaggio += (job != null ? " " : ": ") + d.suffisso;
            Map<String, Object> valori = d.campi.valori;
            if (versioneApp != null) valori.put(Campo.VERSIONE_APP.chiave(), versioneApp);
            if (valori.size() > CAMPI_MASSIMI) throw new IllegalStateException("troppi campi");
            Integer statoValido = d.stato == null ? null : Integer.valueOf(Math.max(0, Math.min(d.stato.intValue(), 599)));
            aggiungiRiga(new Riga(utente == null ? null : utente.toString(), evento.livello(), messaggio, statoValido, valori, false));
            return true;
        } catch (RuntimeException guasto) {
            guastoInterno("registra-" + nome, guasto);
            return false;
        }
    }

    private synchronized void aggiungiRiga(Riga riga) {
        righe.add(riga);
        troncaAlTetto();
        salva();
    }

    /**
     * Tiene al massimo `TETTO_EVENTI` righe: toglie le più vecchie e le conta. Se la più vecchia è una riga
     * `registro-nativo-scartati` non ancora spedita, il numero che portava torna nel conto: la perdita non si cancella perdendo la
     * riga che la dichiara.
     */
    private void troncaAlTetto() {
        while (righe.size() > TETTO_EVENTI) {
            Riga scartata = righe.remove(0);
            scartati += scartata.meta ? contoDelMeta(scartata) : 1L;
        }
    }

    private static long contoDelMeta(Riga meta) {
        Object conto = meta.campi.get(Campo.SCARTATI.chiave());
        return conto instanceof Number ? Math.max(((Number) conto).longValue(), 0L) : 0L;
    }

    private void guastoInterno(String evento, Throwable causa) {
        synchronized (this) {
            erroriInterni++;
        }
        try {
            diagnostica.errore(evento, causa);
        } catch (RuntimeException ancheLaDiagnostica) {
            // La diagnostica è l'ultima rete: se anche lei cade non c'è altro posto dove dirlo e il registro non rompe l'app.
            // Resta il conto, che si legge (`diagnosticheCadute`).
            synchronized (this) {
                diagnosticheCadute++;
            }
        }
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * LETTURA (per i test e per la diagnostica)
     * ──────────────────────────────────────────────────────────────────────────── */

    public synchronized List<EventoRegistrato> eventi() {
        List<EventoRegistrato> copia = new ArrayList<>();
        for (Riga riga : righe) {
            copia.add(new EventoRegistrato(riga.utenteId, riga.livello, riga.messaggio, riga.stato, riga.campi, riga.meta));
        }
        return copia;
    }

    public synchronized int numeroEventi() {
        return righe.size();
    }

    /** Gli eventi persi per il tetto o per un lotto scartato, non ancora dichiarati con `registro-nativo-scartati`. */
    public synchronized long scartati() {
        return scartati;
    }

    /** Quanti guasti interni il registro ha inghiottito (e detto in logcat) da quando è nato. */
    public synchronized int erroriInterni() {
        return erroriInterni;
    }

    /** Quante volte la stessa diagnostica ha lanciato: l'ultima rete, e quel conto è tutto ciò che ne resta. */
    public synchronized int diagnosticheCadute() {
        return diagnosticheCadute;
    }

    /** Fra quanti millisecondi si può spedire di nuovo (0 = adesso). */
    public synchronized long attesaProssimoInvioMs() {
        return attesaResidua(orologio.getAsLong());
    }

    /**
     * L'attesa che resta prima del prossimo POST. Un'attesa legittima non supera mai un'ora di `Retry-After` più l'intervallo
     * minimo: se il conto dice di più, l'orologio del telefono è stato portato indietro dopo un 429 (`nonPrimaDiMs` è rimasto
     * nel futuro lontano) e il registro non spedirebbe più fino al riavvio del processo. In quel caso la scadenza si riporta a
     * un intervallo minimo da adesso: la linea del tempo non è più fidata, e dieci secondi bastano a non martellare il server.
     */
    private long attesaResidua(long adesso) {
        long resto = nonPrimaDiMs - adesso;
        long massima = PoliticaCaricamento.RETRY_AFTER_MASSIMO_SECONDI * 1000L + INTERVALLO_MINIMO_INVIO_MS;
        if (resto > massima) {
            nonPrimaDiMs = adesso + INTERVALLO_MINIMO_INVIO_MS;
            resto = INTERVALLO_MINIMO_INVIO_MS;
        }
        return Math.max(0L, resto);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * SPEDIZIONE
     * ──────────────────────────────────────────────────────────────────────────── */

    /**
     * Spedisce AL PIÙ un lotto (≤ 20 eventi dello stesso utente, i più vecchi) verso `urlRegistro`. Da chiamare a ogni transizione
     * terminale, all'avvio e al ritorno in primo piano (§8.1); se è troppo presto (`RIMANDATO`) i chiamanti riprovano al prossimo
     * trigger o fra `attesaProssimoInvioMs()`. Va chiamato su un thread di lavoro: il POST è bloccante, ma NON tiene il blocco del
     * registro.
     *
     * Se prima si erano persi eventi (tetto, lotti scartati) ne scrive prima la riga `registro-nativo-scartati` col numero.
     * L'indirizzo deve passare la politica degli host (`https://app.kidville.it`; in Debug anche i loopback): altrimenti niente parte.
     */
    public EsitoSvuotamento svuota(String urlRegistro, boolean debug, Trasporto trasporto) {
        final List<Riga> lotto;
        final String utente;
        final long adesso = orologio.getAsLong();
        synchronized (this) {
            if (inVolo) return EsitoSvuotamento.GIA_IN_CORSO;
            if (righe.isEmpty() && scartati == 0L) return EsitoSvuotamento.NIENTE_DA_INVIARE;
            if (!PoliticaCaricamento.urlAmmesso(urlRegistro, Destinazione.REGISTRO, debug)) {
                return EsitoSvuotamento.DESTINAZIONE_NON_AMMESSA;
            }
            if (attesaResidua(adesso) > 0L) return EsitoSvuotamento.RIMANDATO;
            dichiaraScartati();
            if (righe.isEmpty()) return EsitoSvuotamento.NIENTE_DA_INVIARE;
            utente = righe.get(0).utenteId;
            lotto = new ArrayList<>();
            for (Riga riga : righe) {
                if (lotto.size() >= LOTTO_MASSIMO) break;
                if (Objects.equals(riga.utenteId, utente)) lotto.add(riga);
            }
            inVolo = true;
            nonPrimaDiMs = adesso + INTERVALLO_MINIMO_INVIO_MS;
        }

        RispostaTrasporto risposta = null;
        IOException guastoDiRete = null;
        try {
            risposta = trasporto.invia(urlRegistro, utente, corpoDelLotto(lotto));
        } catch (IOException nessunaRisposta) {
            guastoDiRete = nessunaRisposta;
        } catch (RuntimeException guasto) {
            guastoInterno("svuota-trasporto", guasto);
        } finally {
            synchronized (this) {
                inVolo = false;
            }
        }
        return concludiSpedizione(lotto, risposta, guastoDiRete, adesso);
    }

    private synchronized EsitoSvuotamento concludiSpedizione(List<Riga> lotto, RispostaTrasporto risposta, IOException guastoDiRete,
                                                             long adesso) {
        if (risposta == null) {
            if (guastoDiRete != null) guastoInterno("svuota-rete", guastoDiRete);
            return EsitoSvuotamento.TENUTO_PER_RETE;
        }
        int stato = risposta.stato;
        if (stato >= 200 && stato <= 299) {
            togliLotto(lotto, false);
            salva();
            return EsitoSvuotamento.INVIATO;
        }
        if (stato == 429) {
            long richiesti = Math.min(Math.max(risposta.retryAfterSecondi, 0L), PoliticaCaricamento.RETRY_AFTER_MASSIMO_SECONDI);
            long attesa = Math.max(INTERVALLO_MINIMO_INVIO_MS, richiesti * 1000L);
            nonPrimaDiMs = Math.max(nonPrimaDiMs, adesso + attesa);
            return EsitoSvuotamento.TENUTO_PER_LIMITE;
        }
        if (stato >= 400 && stato <= 499) {
            togliLotto(lotto, true);
            salva();
            guastoInterno("svuota-lotto-scartato", null);
            return EsitoSvuotamento.LOTTO_SCARTATO;
        }
        if (stato <= 0) return EsitoSvuotamento.TENUTO_PER_RETE;
        return EsitoSvuotamento.TENUTO_PER_SERVER;
    }

    /** Toglie il lotto dal registro (per identità degli oggetti: nel frattempo il tetto può aver tolto altre righe). */
    private void togliLotto(List<Riga> lotto, boolean contaComeScartati) {
        for (Riga riga : lotto) {
            for (int i = 0; i < righe.size(); i++) {
                if (righe.get(i) == riga) {
                    righe.remove(i);
                    if (contaComeScartati && !riga.meta) scartati++;
                    break;
                }
            }
        }
    }

    /**
     * `registro-nativo-scartati`: il registro dichiara quanti eventi ha perso, poi azzera il conto. Ce n'è UNA sola riga per volta:
     * se una dichiarazione non è ancora partita, il nuovo conto si somma a quella invece di aggiungerne un'altra. Senza questo,
     * con la rete assente e il registro pieno ogni tentativo di spedire scriverebbe una riga e ne butterebbe una vecchia, e in poche
     * ore il registro sarebbe fatto solo di dichiarazioni.
     */
    private void dichiaraScartati() {
        if (scartati <= 0L) return;
        for (Riga riga : righe) {
            if (riga.meta) {
                riga.campi.put(Campo.SCARTATI.chiave(), Long.valueOf(contoDelMeta(riga) + scartati));
                scartati = 0L;
                salva();
                return;
            }
        }
        String utente = righe.isEmpty() ? null : righe.get(0).utenteId;
        Campi campi = new Campi().numero(Campo.SCARTATI, scartati);
        if (versioneApp != null) campi.valori.put(Campo.VERSIONE_APP.chiave(), versioneApp);
        scartati = 0L;
        righe.add(new Riga(utente, Evento.REGISTRO_SCARTATI.livello(), Evento.REGISTRO_SCARTATI.slug(), null, campi.valori, true));
        troncaAlTetto();
        salva();
    }

    private static byte[] corpoDelLotto(List<Riga> lotto) {
        try {
            JSONArray eventi = new JSONArray();
            for (Riga riga : lotto) {
                JSONObject evento = new JSONObject();
                evento.put("livello", riga.livello.valore());
                evento.put("evento", NOME_EVENTO_LOG);
                evento.put("messaggio", riga.messaggio);
                if (riga.stato != null) evento.put("stato", riga.stato.intValue());
                evento.put("campi", aJsonCampi(riga.campi));
                eventi.put(evento);
            }
            JSONObject radice = new JSONObject();
            radice.put("eventi", eventi);
            radice.put("piattaforma", PIATTAFORMA);
            return radice.toString().getBytes(StandardCharsets.UTF_8);
        } catch (JSONException impossibile) {
            // `put` lancia solo per un numero non finito, e qui i numeri sono interi: un difetto del codice, non un dato da tacere.
            throw new IllegalStateException("lotto non serializzabile", impossibile);
        }
    }

    private static JSONObject aJsonCampi(Map<String, Object> campi) throws JSONException {
        JSONObject json = new JSONObject();
        for (Map.Entry<String, Object> voce : campi.entrySet()) json.put(voce.getKey(), voce.getValue());
        return json;
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL FILE `registro.json`
     * ──────────────────────────────────────────────────────────────────────────── */

    private boolean salva() {
        FileOutputStream uscita = null;
        try {
            JSONArray eventi = new JSONArray();
            for (Riga riga : righe) {
                JSONObject evento = new JSONObject();
                evento.put("utenteId", riga.utenteId == null ? JSONObject.NULL : riga.utenteId);
                evento.put("livello", riga.livello.valore());
                evento.put("messaggio", riga.messaggio);
                evento.put("stato", riga.stato == null ? JSONObject.NULL : riga.stato);
                evento.put("campi", aJsonCampi(riga.campi));
                evento.put("meta", riga.meta);
                eventi.put(evento);
            }
            JSONObject radice = new JSONObject();
            radice.put("versione", VERSIONE);
            radice.put("eventi", eventi);
            radice.put("scartati", scartati);
            byte[] dati = radice.toString().getBytes(StandardCharsets.UTF_8);
            File cartella = atomico.getBaseFile().getParentFile();
            if (cartella != null) cartella.mkdirs();
            uscita = atomico.startWrite();
            uscita.write(dati);
            atomico.finishWrite(uscita);
            return true;
        } catch (JSONException nonScritto) {
            // `JSONException` in un `catch` a sé: controllata sull'Android vero, non controllata in `org.json` di Maven (JUnit).
            return scritturaFallita(uscita, nonScritto);
        } catch (IOException | RuntimeException nonScritto) {
            return scritturaFallita(uscita, nonScritto);
        }
    }

    private boolean scritturaFallita(FileOutputStream uscita, Throwable causa) {
        if (uscita != null) atomico.failWrite(uscita);
        guastoInterno("salva-registro", causa);
        return false;
    }

    /**
     * Rilegge il file. Un evento fuori forma (messaggio che non apre con uno slug dell'elenco chiuso, chiave di `campi` che non è
     * un `Campo`, valore di un tipo non ammesso...) NON rientra: l'elenco chiuso vale anche al ritorno da disco. Un file
     * illeggibile si cancella e il registro riparte vuoto (di eventi non critici: i critici stanno già sul server o non più).
     */
    private void carica() {
        byte[] dati;
        try {
            dati = atomico.readFully();
        } catch (FileNotFoundException assente) {
            return;
        } catch (IOException illeggibile) {
            guastoInterno("carica-registro-illeggibile", illeggibile);
            atomico.delete();
            return;
        }
        try {
            JSONObject radice = new JSONObject(new String(dati, StandardCharsets.UTF_8));
            if (!(radice.opt("versione") instanceof Number) || ((Number) radice.opt("versione")).intValue() != VERSIONE) {
                guastoInterno("carica-registro-versione", null);
                atomico.delete();
                return;
            }
            JSONArray eventi = radice.optJSONArray("eventi");
            if (eventi == null) {
                guastoInterno("carica-registro-forma", null);
                atomico.delete();
                return;
            }
            long persi = radice.optLong("scartati", 0L);
            scartati = Math.max(persi, 0L);
            for (int i = 0; i < eventi.length(); i++) {
                Riga riga = daJson(eventi.optJSONObject(i));
                if (riga == null) {
                    scartati++;
                } else {
                    righe.add(riga);
                }
            }
            troncaAlTetto();
        } catch (JSONException nonJson) {
            guastoInterno("carica-registro-json", nonJson);
            righe.clear();
            scartati = 0L;
            atomico.delete();
        }
    }

    private static Riga daJson(JSONObject evento) {
        if (evento == null) return null;
        Object messaggio = evento.opt("messaggio");
        Livello livello = Livello.daValore(evento.opt("livello") instanceof String ? (String) evento.opt("livello") : null);
        if (!(messaggio instanceof String) || livello == null) return null;
        String testo = (String) messaggio;
        if (testo.isEmpty() || testo.length() > MESSAGGIO_MASSIMO) return null;
        int fineSlug = 0;
        while (fineSlug < testo.length() && testo.charAt(fineSlug) != ':' && testo.charAt(fineSlug) != ' ') fineSlug++;
        if (Evento.daSlug(testo.substring(0, fineSlug)) == null) return null;
        String utente = null;
        if (!evento.isNull("utenteId")) {
            Object grezzo = evento.opt("utenteId");
            if (!(grezzo instanceof String) || !FORMA_UUID.matcher((String) grezzo).matches()) return null;
            utente = (String) grezzo;
        }
        Integer stato = null;
        if (!evento.isNull("stato")) {
            Object grezzo = evento.opt("stato");
            if (!(grezzo instanceof Number)) return null;
            double d = ((Number) grezzo).doubleValue();
            if (d < 0 || d > 599 || d != Math.rint(d)) return null;
            stato = Integer.valueOf((int) d);
        }
        JSONObject grezziCampi = evento.optJSONObject("campi");
        if (grezziCampi == null) return null;
        LinkedHashMap<String, Object> campi = new LinkedHashMap<>();
        Iterator<String> chiavi = grezziCampi.keys();
        while (chiavi.hasNext()) {
            String chiave = chiavi.next();
            Object valore = grezziCampi.opt(chiave);
            if (Campo.daChiave(chiave) == null) return null;
            if (valore instanceof Number) {
                double d = ((Number) valore).doubleValue();
                if (Double.isNaN(d) || Double.isInfinite(d)) return null;
                campi.put(chiave, valore);
            } else if (valore instanceof Boolean) {
                campi.put(chiave, valore);
            } else if (valore instanceof String && ((String) valore).length() <= 64) {
                campi.put(chiave, valore);
            } else {
                return null;
            }
        }
        if (campi.size() > CAMPI_MASSIMI) return null;
        boolean meta = Boolean.TRUE.equals(evento.opt("meta"));
        return new Riga(utente, livello, testo, stato, campi, meta);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL TRASPORTO HTTP DI PRODUZIONE
     * ──────────────────────────────────────────────────────────────────────────── */

    /**
     * `POST` JSON con `HttpURLConnection`: è una chiamata NATIVA, che non porta niente della sessione della WebView (il registro
     * non ne nomina mai l'archivio), nessun reindirizzamento, tempi massimi di 15 s per connettersi e 30 s per
     * leggere la risposta (se scadono, `IOException`: vale «nessuna risposta» e il registro tiene gli eventi). Intestazioni: `content-type`, `accept` e, se c'è, `x-user-id`. Il corpo della risposta non si legge:
     * conta lo stato e `Retry-After`.
     */
    public static final class TrasportoHttp implements Trasporto {
        private final int timeoutConnessioneMs;
        private final int timeoutLetturaMs;
        private final LongSupplier orologio;

        public TrasportoHttp() {
            this(15_000, 30_000, System::currentTimeMillis);
        }

        public TrasportoHttp(int timeoutConnessioneMs, int timeoutLetturaMs, LongSupplier orologio) {
            this.timeoutConnessioneMs = timeoutConnessioneMs;
            this.timeoutLetturaMs = timeoutLetturaMs;
            this.orologio = orologio;
        }

        @Override
        public RispostaTrasporto invia(String url, String utenteId, byte[] corpoJson) throws IOException {
            // `URI.create(...).toURL()` e non `new URL(String)`, deprecato dal JDK 20: l'indirizzo è già passato dalla politica degli host.
            HttpURLConnection connessione = (HttpURLConnection) URI.create(url).toURL().openConnection();
            try {
                configura(connessione, utenteId, corpoJson.length, timeoutConnessioneMs, timeoutLetturaMs);
                try (OutputStream corpo = connessione.getOutputStream()) {
                    corpo.write(corpoJson);
                }
                int stato = connessione.getResponseCode();
                long retryAfter = PoliticaCaricamento.leggiRetryAfterSecondi(connessione.getHeaderField("Retry-After"),
                        orologio.getAsLong());
                return new RispostaTrasporto(stato, retryAfter);
            } finally {
                connessione.disconnect();
            }
        }

        /**
         * Tutto ciò che si imposta su una connessione PRIMA di aprirla, in un punto solo e senza rete: così un test lo guarda
         * senza server. `setInstanceFollowRedirects(false)` conta davvero su Android, dove un 301/302 verrebbe seguito con una GET
         * (perdendo il corpo e andando altrove); la JVM, con il corpo in streaming, non segue comunque e non lo vedrebbe.
         */
        static void configura(HttpURLConnection connessione, String utenteId, int lunghezzaCorpo, int timeoutConnessioneMs,
                              int timeoutLetturaMs) throws IOException {
            connessione.setRequestMethod("POST");
            connessione.setConnectTimeout(timeoutConnessioneMs);
            connessione.setReadTimeout(timeoutLetturaMs);
            connessione.setUseCaches(false);
            connessione.setInstanceFollowRedirects(false);
            connessione.setDoOutput(true);
            connessione.setFixedLengthStreamingMode(lunghezzaCorpo);
            connessione.setRequestProperty("content-type", "application/json; charset=utf-8");
            connessione.setRequestProperty("accept", "application/json");
            if (utenteId != null) connessione.setRequestProperty(INTESTAZIONE_UTENTE, utenteId);
        }
    }
}
