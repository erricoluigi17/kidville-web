package it.kidville.app.caricamenti;

import android.app.ActivityManager;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.util.Log;

import androidx.annotation.RequiresApi;
import androidx.work.BackoffPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;

import it.kidville.app.BuildConfig;
import it.kidville.app.caricamenti.CodaCaricamenti.EsitoTransizione;
import it.kidville.app.caricamenti.CodaCaricamenti.Origine;
import it.kidville.app.caricamenti.CodaCaricamenti.RisultatoAggiunta;
import it.kidville.app.caricamenti.CodaCaricamenti.Testi;
import it.kidville.app.caricamenti.CodaCaricamenti.TipoTransizione;
import it.kidville.app.caricamenti.CodaCaricamenti.VoceCoda;
import it.kidville.app.caricamenti.PoliticaCaricamento.Codice;
import it.kidville.app.caricamenti.PoliticaCaricamento.Destinazione;
import it.kidville.app.caricamenti.PoliticaCaricamento.EventoStato;
import it.kidville.app.caricamenti.PoliticaCaricamento.Motore;
import it.kidville.app.caricamenti.PoliticaCaricamento.Stato;
import it.kidville.app.caricamenti.RegistroNativo.EsitoSvuotamento;
import it.kidville.app.caricamenti.RegistroNativo.MimeLog;
import it.kidville.app.caricamenti.SegretiCaricamenti.Segreti;

import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.DoubleSupplier;
import java.util.function.LongSupplier;
import java.util.regex.Pattern;

/**
 * IL MOTORE DEI CARICAMENTI NATIVI: il singolo che possiede coda, registro, segreti ed esecutore, e li fa girare nel guscio giusto.
 * (spec 2026-10-03 «app 1.2: caricamenti nativi in background», §4.1 «il motore è un singolo indipendente dal ponte», §6.1, §6.2, §8.1; A2)
 *
 * ─── CHE COSA È ──────────────────────────────────────────────────────────────────────────────
 * La facciata che il resto dell'app (il ponte Capacitor, `MainActivity`, i due gusci) usa per parlare con i caricamenti. Il ponte
 * chiama {@link #accoda}, {@link #elenco}, {@link #annulla}, {@link #dimentica} e si registra con {@link #aggiungiOsservatore};
 * `MainActivity.onResume` chiama {@link #riprendiInPrimoPiano}; il guscio del livello di API chiama {@link #eseguiSuGuscio}. Dietro
 * ci sono UNA coda, UN registro, UN archivio di segreti e UN esecutore, per processo: {@link #condiviso} li crea la prima volta e
 * restituisce sempre lo stesso insieme (secondario n. 49 della PR 3: due istanze sulla stessa cartella si sovrascrivono il file).
 *
 * ─── DUE MOTORI, UNO PER LIVELLO DI API (§6.2) ───────────────────────────────────────────────
 *  · API 34 e oltre: UIDT, un job «avviato dall'utente» di JobScheduler (`ServizioCaricamentiUidt`): rete qualunque, persistito, ID
 *    fisso. Si programma SOLO se l'esecutore non è già attivo: riprogrammare lo stesso ID ferma quello in corso. Se la
 *    programmazione lancia (l'app non è più visibile al momento di `accodaVideo`) la voce va `in-pausa` `UIDT_NON_PROGRAMMABILE`, e
 *    `onResume` la riprogramma.
 *  · API 24-33: WorkManager con un servizio in primo piano `dataSync` (`LavoroCaricamenti`): lavoro unico `kidville-caricamenti`, nessun
 *    vincolo di rete (l'attesa la governa l'esecutore). Se il servizio non parte da background (Android 12-13) le voci vanno
 *    `in-pausa` `FGS_NON_AVVIABILE` con la notifica «tocca per riprendere»: la pausa che il titolare ha accettato.
 * {@link #FORZA_WORKMANAGER} è l'interruttore di emergenza: a `true` TUTTI i livelli di API usano il secondo ramo.
 *
 * ─── COME È FATTO ────────────────────────────────────────────────────────────────────────────
 *  · LA LOGICA È PURA, IL MONDO È UN'INTERFACCIA. Tutto ciò che tocca Android (programmare il guscio, mostrare la notifica di pausa,
 *    sapere se l'app è in primo piano, il permesso delle notifiche) sta dietro {@link Sistema}, e la rete e i trasporti dietro le
 *    interfacce dell'esecutore: il costruttore a pacchetto le prende tutte, e i test le sostituiscono. {@link SistemaAndroid} è
 *    l'unica classe che nomina JobScheduler, WorkManager, ConnectivityManager e le notifiche.
 *  · `accodaVideo` È UNA SEQUENZA ATOMICA, e l'ordine conta. Sotto il monitor della coda: (1) si controlla l'elemento, (2) si salvano i
 *    SEGRETI, (3) si accoda la voce spostando il file. Un solo blocco, perché l'esecutore non deve vedere una voce senza i suoi
 *    segreti (la leggerebbe «persa») e la pulizia non deve cancellare dei segreti ancora senza voce. Se il punto 3 fallisce i segreti
 *    del punto 2 si tolgono; se il 2 fallisce non è cambiato niente. Il guscio si programma DOPO, fuori dal monitor (l'esecutore
 *    prende la sua serratura e poi la coda quando esce: l'ordine contrario sarebbe un deadlock).
 *  · IDEMPOTENTE SU `jobId`. L'apertura ripetuta di un video (stessi bambini, stessa chiave) ruota il token e riporta lo stesso job:
 *    se la voce è VIVA si sostituiscono i segreti e `tokenScadeIl`, e si restituisce lo stato attuale. Se è TERMINALE la coda la
 *    sostituisce con una nuova (secondario n. 44).
 *  · IL REGISTRO SI SVUOTA da solo: a ogni voce che finisce, all'avvio e al ritorno in primo piano (§8.1), su un thread a parte, e se il
 *    server dice «troppo presto» o «troppe richieste» si riprova allo scadere del ritardo. In Release la destinazione è sempre
 *    `https://app.kidville.it/api/logs`; in Debug quella che la pagina ha passato (il server finto di collaudo).
 *  · NIENTE DATI PERSONALI nei log: tutto passa da `RegistroNativo` (uuid, numeri, enumerati). I guasti interni vanno in logcat con la
 *    sola classe dell'eccezione.
 */
public final class PianificatoreCaricamenti {

    /**
     * L'interruttore di emergenza (§6.2): `true` riporta TUTTI i livelli di API sul ramo WorkManager + servizio in primo piano, per il
     * caso in cui UIDT desse problemi su certi telefoni dopo l'uscita. Cambiarlo vuol dire una nuova build.
     */
    public static final boolean FORZA_WORKMANAGER = false;

    /** Il nome del lavoro unico di WorkManager. */
    public static final String NOME_LAVORO = "kidville-caricamenti";

    /** L'ID fisso del job UIDT: un solo job, che l'esecutore tiene occupato finché ci sono voci. */
    public static final int ID_JOB_UIDT = 73_100;

    private static final String TAG = "KidvilleCaricamenti";

    /** Il motore che gira a questo livello di API: UIDT da 34, WorkManager sotto (o sempre, con l'interruttore). */
    public static Motore motorePer(int sdk) {
        return PoliticaCaricamento.motorePer(sdk, FORZA_WORKMANAGER);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * LE INTERFACCE: tutto ciò che il motore chiede ad Android
     * ──────────────────────────────────────────────────────────────────────────── */

    /** Il sistema operativo, visto dal motore. In produzione {@link SistemaAndroid}; nei test un finto. */
    interface Sistema {
        Motore motore();

        int sdk();

        boolean debug();

        /**
         * Programma il guscio (job UIDT o lavoro di WorkManager) perché esegua il ciclo. `true` se è programmato; `false` se il sistema
         * non lo permette ADESSO (UIDT con l'app non più visibile) — e allora le voci vanno `in-pausa`. Può lanciare: è lo stesso.
         *
         * `subito` è vero quando l'insegnante ha appena riaperto l'app (`suPrimoPiano`): se c'è già un lavoro IN ATTESA — un ritentativo
         * con un backoff che può arrivare a ore — lo si SOSTITUISCE, invece di accodarci dietro. Non si chiama mai con un ciclo attivo
         * (`notificaLavoro` lo ha già intercettato), quindi non si ferma mai un trasferimento in corso.
         */
        boolean programma(long byteDaSpedire, boolean subito);

        /** Mostra «Invio in pausa: tocca per riprendere». */
        void mostraPausa(Testi testi);

        void togliPausa();

        boolean notificheAutorizzate();

        boolean inBackground();

        /** Un guasto interno: in logcat, con la sola CLASSE dell'eccezione. */
        void guasto(String evento, Throwable causa);
    }

    /** Chi esegue il lavoro del registro (la spedizione dei log): un thread a parte, con la possibilità di ritardare. */
    interface Lavoratore {
        void esegui(Runnable lavoro);

        void esegui(Runnable lavoro, long ritardoMs);
    }

    /** Chi vuole sapere di ogni cambiamento di una voce: il ponte, che lo manda al JavaScript come evento `caricamento`. */
    public interface OsservatoreCaricamenti {
        /** `voce` è nella forma di `CaricamentoNativo` (stessi campi di `schemaCaricamentoNativo`). Chiamato da thread diversi. */
        void suCaricamento(JSONObject voce);
    }

    /** Tutto ciò che serve a costruire un motore: i test lo riempiono di finti, `condiviso` di cose vere. */
    static final class Configurazione {
        CodaCaricamenti coda;
        RegistroNativo registro;
        SegretiCaricamenti segreti;
        EsecutoreCoda.TrasportoPut put;
        EsecutoreCoda.TrasportoRinnovo rinnovo;
        EsecutoreCoda.Rete rete;
        Sistema sistema;
        Lavoratore lavoratore;
        RegistroNativo.Trasporto trasportoLog;
        LongSupplier orologio = System::currentTimeMillis;
        DoubleSupplier casuale = Math::random;
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * L'UNICA ISTANZA DEL PROCESSO
     * ──────────────────────────────────────────────────────────────────────────── */

    private static PianificatoreCaricamenti istanza;

    /**
     * Il motore del processo: la prima chiamata lo costruisce (apre coda e registro, fa la pulizia, scrive `caricamenti-nativi-motore`
     * se ci sono voci vive e `coda-nativa-corrotta` se la coda era guasta, e svuota il registro), le altre restituiscono LO STESSO.
     * Non avvia niente: un guscio parte solo quando c'è una voce da spedire ({@link #accoda}) o l'app torna in primo piano.
     */
    public static synchronized PianificatoreCaricamenti condiviso(Context contesto) {
        if (istanza != null) return istanza;
        Context applicazione = contesto.getApplicationContext();
        File cartella = new File(applicazione.getNoBackupFilesDir(), "caricamenti");
        Configurazione c = new Configurazione();
        c.coda = CodaCaricamenti.perCartella(cartella, System::currentTimeMillis);
        c.registro = RegistroNativo.perCartella(cartella, BuildConfig.VERSION_NAME + "+" + BuildConfig.VERSION_CODE);
        c.segreti = SegretiCaricamenti.diProduzione(c.coda);
        c.put = new CaricatorePut();
        c.rinnovo = new RinnovoFirma();
        c.rete = new ReteAndroid(applicazione);
        c.sistema = new SistemaAndroid(applicazione);
        c.lavoratore = new LavoratoreAsincrono();
        c.trasportoLog = new RegistroNativo.TrasportoHttp();
        PianificatoreCaricamenti nuovo = new PianificatoreCaricamenti(c);
        nuovo.avvio();
        istanza = nuovo;
        return nuovo;
    }

    /**
     * Il ritorno in primo piano (`MainActivity.onResume`, §6.5): toglie la notifica di pausa, fa ripartire subito le voci che
     * aspettavano (una voce `in-pausa` o `in-attesa` riprova adesso: l'app è aperta, il servizio in primo piano e il job UIDT si
     * possono avviare) e svuota il registro. Non lancia mai: un guasto del motore non deve far cadere l'Activity.
     */
    public static void riprendiInPrimoPiano(Context contesto) {
        try {
            condiviso(contesto).suPrimoPiano();
        } catch (RuntimeException guasto) {
            Log.e(TAG, "ripresa in primo piano non riuscita (" + guasto.getClass().getSimpleName() + ")");
        }
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * LO STATO
     * ──────────────────────────────────────────────────────────────────────────── */

    private final CodaCaricamenti coda;
    private final RegistroNativo registro;
    private final SegretiCaricamenti segreti;
    private final EsecutoreCoda esecutore;
    private final Sistema sistema;
    private final Lavoratore lavoratore;
    private final RegistroNativo.Trasporto trasportoLog;
    private final LongSupplier orologio;
    private final CopyOnWriteArrayList<OsservatoreCaricamenti> osservatori = new CopyOnWriteArrayList<>();

    /** Un solo svuotamento del registro in coda alla volta, e un solo ritentativo pianificato alla volta. */
    private final AtomicBoolean svuotamentoPrevisto = new AtomicBoolean(false);
    private final AtomicBoolean ritentativoPrevisto = new AtomicBoolean(false);

    /** L'ultimo indirizzo di registro che una pagina ha passato (serve solo in Debug: in Release l'indirizzo è fisso). */
    private volatile String urlRegistroConosciuto;

    PianificatoreCaricamenti(Configurazione c) {
        this.coda = c.coda;
        this.registro = c.registro;
        this.segreti = c.segreti;
        this.sistema = c.sistema;
        this.lavoratore = c.lavoratore;
        this.trasportoLog = c.trasportoLog;
        this.orologio = c.orologio;
        this.esecutore = new EsecutoreCoda(c.coda, c.registro, c.segreti, c.put, c.rinnovo, c.rete, new AmbienteDelMotore(c.casuale));
        this.esecutore.impostaOsservatore((voce, byteInviati) -> {
            JSONObject json = CodaCaricamenti.aJsonPonte(voce, byteInviati);
            for (OsservatoreCaricamenti o : osservatori) {
                try {
                    o.suCaricamento(json);
                } catch (RuntimeException guastoDelPonte) {
                    sistema.guasto("osservatore-ponte", guastoDelPonte);
                }
            }
        });
    }

    /** L'ambiente dell'esecutore: l'orologio, il caso, la build, e le due cose che toccano il motore (svuotare il registro, dire un guasto). */
    private final class AmbienteDelMotore implements EsecutoreCoda.Ambiente {
        private final DoubleSupplier casuale;

        AmbienteDelMotore(DoubleSupplier casuale) {
            this.casuale = casuale;
        }

        @Override
        public long adesso() {
            return orologio.getAsLong();
        }

        @Override
        public double casuale() {
            return casuale.getAsDouble();
        }

        @Override
        public boolean debug() {
            return sistema.debug();
        }

        @Override
        public boolean inBackground() {
            return sistema.inBackground();
        }

        @Override
        public boolean notificheAutorizzate() {
            return sistema.notificheAutorizzate();
        }

        @Override
        public void pausa(Object monitor, long ms) throws InterruptedException {
            monitor.wait(ms);
        }

        @Override
        public void registroDaSvuotare() {
            svuotaIlRegistro();
        }

        @Override
        public void guasto(String evento, Throwable causa) {
            sistema.guasto(evento, causa);
        }
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * ACCESSORI PER IL PONTE
     * ──────────────────────────────────────────────────────────────────────────── */

    /** La coda del processo (il ponte ne vuole `cartellaScelti()` per preparare i media). */
    public CodaCaricamenti coda() {
        return coda;
    }

    /** Il registro del processo (il ponte scrive `media-nativo-preparazione-fallita`). */
    public RegistroNativo registro() {
        return registro;
    }

    public Motore motore() {
        return sistema.motore();
    }

    public void aggiungiOsservatore(OsservatoreCaricamenti osservatore) {
        if (osservatore != null) osservatori.addIfAbsent(osservatore);
    }

    public void rimuoviOsservatore(OsservatoreCaricamenti osservatore) {
        osservatori.remove(osservatore);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * `accodaVideo`
     * ──────────────────────────────────────────────────────────────────────────── */

    /** I `code` con cui il ponte rifiuta `accodaVideo` (§4.3): gli stessi di `CODICI_RIFIUTO_PONTE`, e il messaggio è una costante. */
    public enum CodiceRifiuto {
        ELEMENTO_ASSENTE,
        ELEMENTO_DIVERSO,
        HOST_NON_AMMESSO,
        PARAMETRI_NON_VALIDI,
        INTERNO
    }

    /** `accodaVideo` rifiutato: il ponte lo traduce in `call.reject(<messaggio costante>, codice.name())`. */
    public static final class RifiutoAccodamento extends Exception {
        public final CodiceRifiuto codice;

        RifiutoAccodamento(CodiceRifiuto codice) {
            // Il messaggio è il solo nome del codice: mai un percorso, un URL o un token.
            super(codice.name());
            this.codice = codice;
        }
    }

    /**
     * Ciò che il ponte passa ad `accoda`: i campi di `RichiestaAccodaVideo` già verificati contro l'elemento. Le date sono le stringhe
     * ISO 8601 che il JavaScript ha ricevuto dal server (`expires_at`, `rinnovo.scadeIl`): le legge {@link #accoda}.
     *
     * ⚠️ REGOLE PER CHI COSTRUISCE LA RICHIESTA (`KidvilleCaricamentiPlugin.accodaVideo`):
     *  · `preparato` è il file dell'elemento in `scelti/` PRIMA dello spostamento, `null` se il ponte non lo trova più. Il confronto
     *    dello `sha256` con quello dell'elemento lo fa il ponte (è lui a conoscerlo, lo ha calcolato durante la copia): se non
     *    coincide risponde `ELEMENTO_DIVERSO` senza chiamare il motore. Qui si controlla il peso, e che il file ci sia;
     *  · se la voce c'è già VIVA (apertura ripetuta) `preparato` non serve: il ponte può passarlo `null` anche se l'elemento è già
     *    stato consumato dalla prima chiamata, e il motore non risponde `ELEMENTO_ASSENTE` per questo.
     */
    public static final class RichiestaAccodamento {
        public final String jobId;
        public final String intentId;
        public final String utenteId;
        public final String scuolaId;
        /** Solo per lo schermo (`nome` della voce): mai in un log. */
        public final String nome;
        public final String mime;
        public final long byteAttesi;
        public final Origine origine;
        public final File preparato;
        public final String urlPut;
        public final String contentType;
        /** `expires_at` del job (la scadenza dell'URL), ISO 8601; `null` se il server non la dice. */
        public final String urlPutScadeIl;
        public final String urlRinnovo;
        public final String token;
        /** `rinnovo.scadeIl` (la scadenza del TOKEN, 48 ore), ISO 8601. */
        public final String tokenScadeIl;
        public final String urlRegistro;
        public final Testi testi;

        public RichiestaAccodamento(String jobId, String intentId, String utenteId, String scuolaId, String nome, String mime,
                                    long byteAttesi, Origine origine, File preparato, String urlPut, String contentType,
                                    String urlPutScadeIl, String urlRinnovo, String token, String tokenScadeIl, String urlRegistro,
                                    Testi testi) {
            this.jobId = jobId;
            this.intentId = intentId;
            this.utenteId = utenteId;
            this.scuolaId = scuolaId;
            this.nome = nome;
            this.mime = mime;
            this.byteAttesi = byteAttesi;
            this.origine = origine;
            this.preparato = preparato;
            this.urlPut = urlPut;
            this.contentType = contentType;
            this.urlPutScadeIl = urlPutScadeIl;
            this.urlRinnovo = urlRinnovo;
            this.token = token;
            this.tokenScadeIl = tokenScadeIl;
            this.urlRegistro = urlRegistro;
            this.testi = testi;
        }
    }

    /**
     * L'esito di `accoda`: la voce nella forma del ponte e se c'era GIÀ una voce viva (apertura ripetuta: i segreti sono stati sostituiti e
     * il preparato NON è stato spostato). In quel caso il ponte può scartare la copia in `scelti/` che l'insegnante ha ripreparato:
     * qui non lo si fa, perché solo il ponte sa se quell'elemento ha lo stesso `sha256` della voce.
     */
    public static final class RisultatoAccodamento {
        public final JSONObject voce;
        public final boolean giaPresente;

        RisultatoAccodamento(JSONObject voce, boolean giaPresente) {
            this.voce = voce;
            this.giaPresente = giaPresente;
        }
    }

    private static final Pattern FORMA_UUID = Pattern.compile("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");
    /** Il token di rinnovo: `kvr_` e caratteri base64url (la lunghezza la decide il server). Niente a capo: finisce in un'intestazione. */
    private static final Pattern FORMA_TOKEN = Pattern.compile("^kvr_[A-Za-z0-9_-]{16,128}$");
    private static final Pattern FORMA_ESTENSIONE = Pattern.compile("^[a-z0-9]{1,5}$");

    /**
     * Prende in carico un video preparato (§4.3): verifica la forma della richiesta, gli host (§9), la presenza e il peso della copia;
     * salva i segreti; sposta il file in `file/<jobId>.<ext>`; crea la voce `in-coda`; scrive `video-nativo-accodato`; programma il guscio.
     * Idempotente su `jobId` (vedi la testata). Restituisce la voce nella forma di `CaricamentoNativo`.
     *
     * @throws RifiutoAccodamento col codice che il ponte porta al JavaScript
     */
    public RisultatoAccodamento accoda(RichiestaAccodamento r) throws RifiutoAccodamento {
        verificaLaForma(r);
        verificaGliHost(r);
        final long tokenScadeIlMs = leggiIsoMs(r.tokenScadeIl);
        final long urlScadeIlMs = r.urlPutScadeIl == null ? 0L : leggiIsoMs(r.urlPutScadeIl);
        if (tokenScadeIlMs <= 0L || (r.urlPutScadeIl != null && urlScadeIlMs <= 0L)) {
            throw new RifiutoAccodamento(CodiceRifiuto.PARAMETRI_NON_VALIDI);
        }
        final Segreti nuoviSegreti = new Segreti(r.token, r.urlPut, r.contentType, r.urlRinnovo, r.urlRegistro);
        final Testi testi = r.testi == null ? Testi.predefiniti() : r.testi;
        VoceCoda risultato;
        boolean nuova;
        synchronized (coda) {
            VoceCoda esistente = coda.trova(r.jobId);
            if (esistente != null && !esistente.stato.terminale()) {
                // L'apertura ripetuta: il token è ruotato e il vecchio non vale più. Si sostituiscono i segreti e le scadenze, e la
                // voce, se aspettava un ritardo, riprova adesso col token buono.
                salvaISegreti(r.jobId, nuoviSegreti);
                coda.modifica(r.jobId, v -> {
                    v.tokenScadeIl = tokenScadeIlMs;
                    v.urlScadeIl = urlScadeIlMs;
                    v.rinnoviConsecutivi = 0;
                    v.prossimoTentativoIl = 0L;
                });
                coda.impostaTesti(testi);
                risultato = coda.trova(r.jobId);
                nuova = false;
            } else {
                // Una voce nuova, o una terminale da sostituire: serve il file.
                if (r.preparato == null || !r.preparato.isFile()) throw new RifiutoAccodamento(CodiceRifiuto.ELEMENTO_ASSENTE);
                if (r.preparato.length() != r.byteAttesi) throw new RifiutoAccodamento(CodiceRifiuto.ELEMENTO_DIVERSO);
                String relativo = SOTTOCARTELLA_FILE_DELLE_VOCI + "/" + r.jobId + "." + estensioneDellaCopia(r.preparato, r.mime);
                VoceCoda daAccodare = VoceCoda.nuova(r.jobId, r.intentId, r.utenteId, r.scuolaId, r.nome, relativo, r.byteAttesi, r.mime,
                        r.origine, urlScadeIlMs, tokenScadeIlMs);
                // I segreti PRIMA della voce, sotto lo stesso blocco: l'esecutore non la vede senza (la leggerebbe «persa») e la pulizia
                // non può cancellare dei segreti ancora senza voce.
                salvaISegreti(r.jobId, nuoviSegreti);
                RisultatoAggiunta aggiunta;
                try {
                    aggiunta = coda.aggiungiSpostando(daAccodare, r.preparato);
                } catch (IOException | RuntimeException nonAccodata) {
                    segreti.cancella(r.jobId);
                    throw new RifiutoAccodamento(nonAccodata instanceof IllegalArgumentException ? CodiceRifiuto.PARAMETRI_NON_VALIDI
                            : CodiceRifiuto.INTERNO);
                }
                coda.impostaTesti(testi);
                risultato = aggiunta.voce;
                nuova = !aggiunta.giaPresente;
            }
        }
        // FUORI dal monitor della coda: da qui in poi si toccano l'esecutore, il registro e il sistema.
        urlRegistroConosciuto = r.urlRegistro;
        if (nuova) {
            esecutore.dimenticaAvanzamento(r.jobId);
            registro.videoAccodato(uuid(r.jobId), uuid(r.utenteId), r.byteAttesi, MimeLog.da(r.mime), sistema.motore());
        }
        esecutore.notificaVoce(risultato);
        avviaIlGuscio();
        VoceCoda dopo = coda.trova(r.jobId);
        return new RisultatoAccodamento(CodaCaricamenti.aJsonPonte(dopo != null ? dopo : risultato, esecutore.byteInviati(r.jobId)), !nuova);
    }

    private static final String SOTTOCARTELLA_FILE_DELLE_VOCI = CodaCaricamenti.SOTTOCARTELLA_FILE;

    private void salvaISegreti(String jobId, Segreti daSalvare) throws RifiutoAccodamento {
        try {
            segreti.salva(jobId, daSalvare);
        } catch (IOException nonSalvati) {
            sistema.guasto("accoda-segreti", nonSalvati);
            throw new RifiutoAccodamento(CodiceRifiuto.INTERNO);
        }
    }

    private void verificaLaForma(RichiestaAccodamento r) throws RifiutoAccodamento {
        if (r == null) throw new RifiutoAccodamento(CodiceRifiuto.PARAMETRI_NON_VALIDI);
        boolean valida = uuidMinuscolo(r.jobId) && uuidMinuscolo(r.intentId) && uuidMinuscolo(r.utenteId) && uuidMinuscolo(r.scuolaId)
                && r.nome != null && PoliticaCaricamento.mimeValido(r.mime) && PoliticaCaricamento.mimeValido(r.contentType)
                && r.byteAttesi >= 1L && r.byteAttesi <= CodaCaricamenti.MAX_VIDEO_INPUT_BYTES && r.origine != null
                && r.urlPut != null && r.urlRinnovo != null && r.urlRegistro != null
                && r.token != null && FORMA_TOKEN.matcher(r.token).matches() && r.tokenScadeIl != null;
        if (!valida) throw new RifiutoAccodamento(CodiceRifiuto.PARAMETRI_NON_VALIDI);
    }

    /** Gli host (§9): una pagina compromessa non può far spedire il video di un bambino, né il suo token, altrove. */
    private void verificaGliHost(RichiestaAccodamento r) throws RifiutoAccodamento {
        boolean debug = sistema.debug();
        boolean ammessi = PoliticaCaricamento.urlAmmesso(r.urlPut, Destinazione.PUT, debug)
                && PoliticaCaricamento.urlAmmesso(r.urlRinnovo, Destinazione.RINNOVO, debug)
                && PoliticaCaricamento.urlAmmesso(r.urlRegistro, Destinazione.REGISTRO, debug);
        if (!ammessi) throw new RifiutoAccodamento(CodiceRifiuto.HOST_NON_AMMESSO);
    }

    private static boolean uuidMinuscolo(String id) {
        return id != null && FORMA_UUID.matcher(id).matches();
    }

    /** L'estensione della copia: quella del preparato se è del tipo giusto, altrimenti quella del MIME, altrimenti `mp4`. */
    static String estensioneDellaCopia(File preparato, String mime) {
        String nome = preparato.getName();
        int punto = nome.lastIndexOf('.');
        if (punto >= 0) {
            String estensione = nome.substring(punto + 1).toLowerCase(Locale.ROOT);
            if (FORMA_ESTENSIONE.matcher(estensione).matches()) return estensione;
        }
        switch (MimeLog.da(mime)) {
            case QUICKTIME:
                return "mov";
            case TRE_GPP:
                return "3gp";
            case TRE_GPP2:
                return "3g2";
            case WEBM:
                return "webm";
            case MATROSKA:
                return "mkv";
            case M4V:
                return "m4v";
            case MPEG:
                return "mpg";
            default:
                return "mp4";
        }
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * `elenco`, `annulla`, `dimentica`
     * ──────────────────────────────────────────────────────────────────────────── */

    /** Le voci di QUELL'utente, per data di creazione, nella forma di `CaricamentoNativo` (§4.3). */
    public List<JSONObject> elenco(String utenteId) {
        List<JSONObject> risultato = new ArrayList<>();
        for (VoceCoda voce : coda.elenco(utenteId)) {
            risultato.add(CodaCaricamenti.aJsonPonte(voce, esecutore.byteInviati(voce.jobId)));
        }
        return risultato;
    }

    /** Ferma il trasferimento e chiude la voce `annullato`: copia e segreti cancellati. NON ritira l'intento: lo fa il JavaScript (§7.6). */
    public boolean annulla(String jobId) {
        return esecutore.annulla(jobId);
    }

    /** Toglie dalla coda le voci TERMINALI indicate; le altre le ignora (§4.3). */
    public int dimentica(Collection<String> jobIds) {
        int tolte = coda.dimentica(jobIds);
        if (tolte > 0 && jobIds != null) {
            for (String id : jobIds) esecutore.dimenticaAvanzamento(id);
        }
        return tolte;
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL GUSCIO
     * ──────────────────────────────────────────────────────────────────────────── */

    /**
     * Fa girare il ciclo dell'esecutore nel guscio che lo chiama (il thread di lavoro di `LavoroCaricamenti` o del job UIDT).
     * Blocca finché c'è lavoro. Alla fine svuota il registro. Vedi `EsecutoreCoda.esegui`.
     */
    public EsecutoreCoda.EsitoCiclo eseguiSuGuscio(EsecutoreCoda.Presentazione presentazione, long attesaReteMassimaMs) {
        try {
            return esecutore.esegui(presentazione, attesaReteMassimaMs);
        } finally {
            svuotaIlRegistro();
        }
    }

    /** Il guscio si ferma (`onStopJob`, `onStopped`): la PUT in volo si interrompe e le voci tornano in attesa. */
    public void fermaIlGuscio() {
        esecutore.ferma();
    }

    /** I testi che le notifiche del guscio devono mostrare (quelli passati dal JavaScript, o il ripiego italiano). */
    public Testi testiDelleNotifiche() {
        return coda.testi();
    }

    /** I byte di tutte le voci vive: la stima del job UIDT (`setEstimatedNetworkBytes`). */
    long byteDaSpedire() {
        long totale = 0L;
        for (VoceCoda voce : coda.vive()) totale += Math.max(voce.byteTotali, 0L);
        return totale;
    }

    /**
     * Se un ciclo è attivo lo avverte; altrimenti programma il guscio. Se il sistema non lo permette (UIDT con l'app non più
     * visibile; WorkManager non inizializzato) le voci vanno `in-pausa` con la loro notifica «tocca per riprendere».
     */
    void avviaIlGuscio() {
        avviaIlGuscio(false);
    }

    private void avviaIlGuscio(boolean subito) {
        if (coda.vive().isEmpty()) return;
        if (esecutore.notificaLavoro()) return;
        boolean programmato;
        try {
            programmato = sistema.programma(byteDaSpedire(), subito);
        } catch (RuntimeException nonProgrammabile) {
            sistema.guasto("programma-guscio", nonProgrammabile);
            programmato = false;
        }
        if (!programmato) metteInPausa(PoliticaCaricamento.codicePausa(sistema.motore()));
    }

    /** Il servizio in primo piano non è partito (Android 12-13 da background): il lavoro non può girare, le voci aspettano l'app. */
    void suForegroundNonAvviabile() {
        metteInPausa(Codice.FGS_NON_AVVIABILE);
    }

    /**
     * Tutte le voci vive passano `in-pausa` con `codice` (`FGS_NON_AVVIABILE` o `UIDT_NON_PROGRAMMABILE`), si scrive
     * `video-nativo-pausa` per ognuna e si mostra la notifica «Invio in pausa: tocca per riprendere». Una voce `in-attesa` passa prima
     * da `in-invio` (§4.4 non ha la freccia diretta); una già `in-pausa` non si ripete.
     */
    private void metteInPausa(Codice codice) {
        List<VoceCoda> vive = coda.vive();
        if (vive.isEmpty()) return;
        for (VoceCoda voce : vive) {
            if (voce.stato == Stato.IN_PAUSA) continue;
            if (voce.stato == Stato.IN_ATTESA && coda.transita(voce.jobId, EventoStato.RIPRESO, null).tipo != TipoTransizione.APPLICATA) {
                continue;
            }
            EsitoTransizione e = coda.transita(voce.jobId, EventoStato.IN_PAUSA, codice);
            if (e.tipo != TipoTransizione.APPLICATA) continue;
            registro.videoInPausa(uuid(voce.jobId), uuid(voce.utenteId), codice, sistema.sdk());
            esecutore.notificaVoce(e.voce);
        }
        sistema.mostraPausa(coda.testi());
        svuotaIlRegistro();
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * AVVIO E RITORNO IN PRIMO PIANO
     * ──────────────────────────────────────────────────────────────────────────── */

    /** Il primo uso del processo: la pulizia, i log di coda corrotta e di motore con voci vive, lo svuotamento del registro. */
    void avvio() {
        try {
            CodaCaricamenti.Rapporto rapporto = coda.rapporto();
            if (rapporto.daSegnalare()) registro.codaCorrotta(utenteDiRiferimento(), rapporto.fileOrfani, rapporto.vociScartate);
            coda.pulisci();
            loggaIlMotore(RegistroNativo.Occasione.AVVIO);
        } catch (RuntimeException guasto) {
            sistema.guasto("avvio-motore", guasto);
        }
        svuotaIlRegistro();
    }

    /** `MainActivity.onResume`: vedi {@link #riprendiInPrimoPiano}. */
    void suPrimoPiano() {
        sistema.togliPausa();
        List<VoceCoda> vive = coda.vive();
        for (VoceCoda voce : vive) {
            if (voce.stato == Stato.IN_ATTESA || voce.stato == Stato.IN_PAUSA) {
                coda.modifica(voce.jobId, v -> v.prossimoTentativoIl = 0L);
            }
        }
        if (!vive.isEmpty()) {
            // La riga si scrive solo se c'è qualcosa da riprendere: con un ciclo attivo l'app che torna in primo piano non ha cambiato
            // niente, e una riga a ogni cambio di app riempirebbe il registro (200 righe) di rumore.
            if (!esecutore.attivo()) loggaIlMotore(RegistroNativo.Occasione.PRIMO_PIANO);
            ricordaLIndirizzoDelRegistro(vive);
            esecutore.segnala();
            avviaIlGuscio(true);
        }
        svuotaIlRegistro();
    }

    /** `caricamenti-nativi-motore: <motore> <occasione>`: solo se ci sono voci vive (§8.2). */
    private void loggaIlMotore(RegistroNativo.Occasione occasione) {
        int inCoda = 0;
        int inInvio = 0;
        UUID utente = null;
        for (VoceCoda voce : coda.vive()) {
            if (voce.stato == Stato.IN_CODA) inCoda++;
            if (voce.stato == Stato.IN_INVIO) inInvio++;
            if (utente == null) utente = uuid(voce.utenteId);
        }
        if (utente == null) return;
        registro.motore(utente, sistema.motore(), occasione, inCoda, inInvio, esecutore.attivo() ? 1 : 0);
    }

    /** L'utente di una voce viva (la più recente), per dare un `x-user-id` a un evento che non ne ha uno suo; `null` se non ce n'è. */
    private UUID utenteDiRiferimento() {
        List<VoceCoda> vive = coda.vive();
        return vive.isEmpty() ? null : uuid(vive.get(vive.size() - 1).utenteId);
    }

    /** Dopo un riavvio, in Debug, l'indirizzo del registro è quello che la voce viva ha nei segreti (la pagina non l'ha ripassato). */
    private void ricordaLIndirizzoDelRegistro(List<VoceCoda> vive) {
        // In Release l'indirizzo è fisso e non serve leggere un segreto (una decifratura) a ogni ritorno in primo piano.
        if (!sistema.debug() || urlRegistroConosciuto != null) return;
        for (VoceCoda voce : vive) {
            SegretiCaricamenti.Lettura l = segreti.leggi(voce.jobId);
            if (l.esito == SegretiCaricamenti.Esito.OK) {
                urlRegistroConosciuto = l.segreti.urlRegistro;
                return;
            }
        }
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL REGISTRO DEI LOG
     * ──────────────────────────────────────────────────────────────────────────── */

    /**
     * Chiede lo svuotamento del registro, su un thread a parte (il POST è bloccante e non deve fermare né il ciclo né l'Activity). Più
     * richieste ravvicinate ne fanno una sola. Il registro stesso garantisce al più un POST ogni 10 secondi (§8.1).
     */
    void svuotaIlRegistro() {
        if (!svuotamentoPrevisto.compareAndSet(false, true)) return;
        lavoratore.esegui(() -> {
            svuotamentoPrevisto.set(false);
            svuotaDavvero();
        });
    }

    private void svuotaDavvero() {
        try {
            boolean debug = sistema.debug();
            String destinazione = RegistroNativo.destinazione(urlRegistroConosciuto, debug);
            if (destinazione == null) return;
            EsitoSvuotamento esito = registro.svuota(destinazione, debug, trasportoLog);
            switch (esito) {
                case INVIATO:
                case LOTTO_SCARTATO:
                    // Un lotto è al più di 20 eventi, di UN utente: se ne restano si continua (il registro rispetta i suoi 10 secondi).
                    if (registro.numeroEventi() > 0) riprovaSvuotare(Math.max(registro.attesaProssimoInvioMs(), 1_000L));
                    break;
                case RIMANDATO:
                case TENUTO_PER_LIMITE:
                    riprovaSvuotare(Math.max(registro.attesaProssimoInvioMs(), 1_000L));
                    break;
                default:
                    // Niente da spedire, o la rete/il server non ci sono: si riprova al prossimo evento terminale, all'avvio o al ritorno in
                    // primo piano. Insistere ogni dieci secondi con la rete assente costerebbe batteria per righe che non scadono.
                    break;
            }
        } catch (RuntimeException guasto) {
            sistema.guasto("svuota-registro", guasto);
        }
    }

    private void riprovaSvuotare(long ritardoMs) {
        if (!ritentativoPrevisto.compareAndSet(false, true)) return;
        lavoratore.esegui(() -> {
            ritentativoPrevisto.set(false);
            svuotaDavvero();
        }, ritardoMs);
    }

    private static UUID uuid(String id) {
        return UUID.fromString(id);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * LE DATE ISO 8601
     * ──────────────────────────────────────────────────────────────────────────── */

    private static final Pattern FORMA_ISO = Pattern.compile(
            "^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(?:\\.(\\d{1,9}))?(Z|[+-]\\d{2}:\\d{2})$");

    /**
     * Un istante ISO 8601 con la `Z` o con uno scarto `±hh:mm` (`2026-10-05T10:00:00.000Z`: la forma di `z.string().datetime({ offset:
     * true })`) in millisecondi dall'epoca; -1 se non ha quella forma o non è una data vera. Fatta a mano e non con `java.time` (API 26) né
     * con `SimpleDateFormat` (il modello `XXX` e le lingue del telefono): è una regola sola, provata, e identica su ogni livello di API.
     */
    public static long leggiIsoMs(String testo) {
        if (testo == null) return -1L;
        java.util.regex.Matcher m = FORMA_ISO.matcher(testo);
        if (!m.matches()) return -1L;
        int anno = Integer.parseInt(m.group(1));
        int mese = Integer.parseInt(m.group(2));
        int giorno = Integer.parseInt(m.group(3));
        int ore = Integer.parseInt(m.group(4));
        int minuti = Integer.parseInt(m.group(5));
        int secondi = Integer.parseInt(m.group(6));
        if (mese < 1 || mese > 12 || giorno < 1 || giorno > giorniDelMese(anno, mese)) return -1L;
        if (ore > 23 || minuti > 59 || secondi > 59) return -1L;
        long millisecondi = 0L;
        if (m.group(7) != null) {
            String frazione = (m.group(7) + "000").substring(0, 3);
            millisecondi = Long.parseLong(frazione);
        }
        long scartoMs = 0L;
        String fuso = m.group(8);
        if (!fuso.equals("Z")) {
            int oreFuso = Integer.parseInt(fuso.substring(1, 3));
            int minutiFuso = Integer.parseInt(fuso.substring(4, 6));
            if (oreFuso > 23 || minutiFuso > 59) return -1L;
            scartoMs = (oreFuso * 60L + minutiFuso) * 60_000L * (fuso.charAt(0) == '-' ? -1L : 1L);
        }
        long giorni = giorniDallEpoca(anno, mese, giorno);
        return (((giorni * 24L + ore) * 60L + minuti) * 60L + secondi) * 1000L + millisecondi - scartoMs;
    }

    private static int giorniDelMese(int anno, int mese) {
        switch (mese) {
            case 2:
                return (anno % 4 == 0 && (anno % 100 != 0 || anno % 400 == 0)) ? 29 : 28;
            case 4:
            case 6:
            case 9:
            case 11:
                return 30;
            default:
                return 31;
        }
    }

    /** I giorni dal 1970-01-01 a una data del calendario gregoriano (l'algoritmo «days from civil» di Howard Hinnant). */
    private static long giorniDallEpoca(int anno, int mese, int giorno) {
        long a = mese <= 2 ? anno - 1L : anno;
        long era = (a >= 0 ? a : a - 399L) / 400L;
        long annoDellEra = a - era * 400L;
        long giornoDellAnno = (153L * (mese + (mese > 2 ? -3 : 9)) + 2L) / 5L + giorno - 1L;
        long giornoDellEra = annoDellEra * 365L + annoDellEra / 4L - annoDellEra / 100L + giornoDellAnno;
        return era * 146_097L + giornoDellEra - 719_468L;
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL LAVORATORE DEL REGISTRO DI PRODUZIONE
     * ──────────────────────────────────────────────────────────────────────────── */

    /** Un thread solo, daemon (non tiene vivo il processo), che esegue la spedizione dei log e i suoi ritentativi. */
    private static final class LavoratoreAsincrono implements Lavoratore {
        private final ScheduledExecutorService servizio = Executors.newSingleThreadScheduledExecutor(lavoro -> {
            Thread filo = new Thread(lavoro, "kidville-registro");
            filo.setDaemon(true);
            return filo;
        });

        @Override
        public void esegui(Runnable lavoro) {
            servizio.execute(lavoro);
        }

        @Override
        public void esegui(Runnable lavoro, long ritardoMs) {
            servizio.schedule(lavoro, ritardoMs, TimeUnit.MILLISECONDS);
        }
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * LA RETE
     * ──────────────────────────────────────────────────────────────────────────── */

    /**
     * La rete vista da `ConnectivityManager`: c'è una rete attiva con la capacità INTERNET. Non si pretende la «convalida» del sistema
     * (`NET_CAPABILITY_VALIDATED`): dove il controllo di Google è bloccato, o su una rete aziendale, la rete funziona ma non risulta mai
     * convalidata, e si aspetterebbe per sempre una rete che c'è. Se la rete c'è ma non porta fuori la PUT cade e segue le attese di §4.5.
     * Si aspetta a passi di due secondi (non c'è un callback da registrare e rimuovere): costo trascurabile per i dieci minuti del tetto.
     */
    static final class ReteAndroid implements EsecutoreCoda.Rete {
        private final ConnectivityManager connettivita;

        ReteAndroid(Context applicazione) {
            this.connettivita = (ConnectivityManager) applicazione.getSystemService(Context.CONNECTIVITY_SERVICE);
        }

        @Override
        public boolean disponibile() {
            if (connettivita == null) return true;
            try {
                Network rete = connettivita.getActiveNetwork();
                if (rete == null) return false;
                NetworkCapabilities capacita = connettivita.getNetworkCapabilities(rete);
                return capacita != null && capacita.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
            } catch (RuntimeException nonLeggibile) {
                // Il sistema non dice com'è la rete (`SecurityException` rarissima): nel dubbio si prova, e se non c'è la PUT cade da sola.
                Log.w(TAG, "rete non leggibile (" + nonLeggibile.getClass().getSimpleName() + ")");
                return true;
            }
        }

        @Override
        public void attendi(long massimoMs) throws InterruptedException {
            long fine = System.nanoTime() + massimoMs * 1_000_000L;
            while (!disponibile()) {
                long restanteMs = (fine - System.nanoTime()) / 1_000_000L;
                if (restanteMs <= 0L) return;
                Thread.sleep(Math.min(restanteMs, 500L));
            }
        }
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL SISTEMA DI PRODUZIONE
     * ──────────────────────────────────────────────────────────────────────────── */

    /** Il sistema vero: JobScheduler, WorkManager, le notifiche, lo stato del processo. L'unica classe che nomina Android. */
    static final class SistemaAndroid implements Sistema {
        private final Context applicazione;
        private final NotificheCaricamento notifiche;

        SistemaAndroid(Context applicazione) {
            this.applicazione = applicazione;
            this.notifiche = new NotificheCaricamento(applicazione);
        }

        @Override
        public Motore motore() {
            return motorePer(Build.VERSION.SDK_INT);
        }

        @Override
        public int sdk() {
            return Build.VERSION.SDK_INT;
        }

        @Override
        public boolean debug() {
            return BuildConfig.DEBUG;
        }

        @Override
        public boolean programma(long byteDaSpedire, boolean subito) {
            if (motore() == Motore.UIDT && Build.VERSION.SDK_INT >= PoliticaCaricamento.SDK_PRIMO_UIDT) {
                return programmaUidt(byteDaSpedire);
            }
            return programmaWorkManager(subito);
        }

        /**
         * Il job UIDT (§6.2): avviato dall'utente, rete qualunque (anche cellulare e a consumo: «qualunque rete»), persistito (sopravvive al
         * riavvio: `RECEIVE_BOOT_COMPLETED` arriva dal manifest di WorkManager), con il backoff esponenziale di sistema per i casi in cui
         * il guscio si ferma a metà. Se c'è già un job con quell'ID — in attesa o in corso — NON si riprogramma: riprogrammare lo stesso ID
         * ferma quello in esecuzione, e il ciclo in corso vedrà da solo le voci nuove (`notificaLavoro`).
         */
        @RequiresApi(34)
        private boolean programmaUidt(long byteDaSpedire) {
            JobScheduler pianificatore = applicazione.getSystemService(JobScheduler.class);
            if (pianificatore == null) return false;
            if (pianificatore.getPendingJob(ID_JOB_UIDT) != null) return true;
            ComponentName servizio = new ComponentName(applicazione, ServizioCaricamentiUidt.class);
            JobInfo job = new JobInfo.Builder(ID_JOB_UIDT, servizio)
                    .setUserInitiated(true)
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setEstimatedNetworkBytes(0L, byteDaSpedire > 0L ? byteDaSpedire : JobInfo.NETWORK_BYTES_UNKNOWN)
                    .setPersisted(true)
                    .setBackoffCriteria(30_000L, JobInfo.BACKOFF_POLICY_EXPONENTIAL)
                    .build();
            return pianificatore.schedule(job) == JobScheduler.RESULT_SUCCESS;
        }

        /**
         * Il lavoro unico di WorkManager: nessun vincolo di rete (l'attesa la governa il worker, §6.2) e `APPEND_OR_REPLACE`, così un
         * lavoro programmato mentre un altro gira si accoda invece di sostituirlo. Quando l'insegnante ha appena riaperto l'app
         * (`subito`) il lavoro si SOSTITUISCE (`REPLACE`): un ritentativo già in attesa col suo backoff — che WorkManager fa crescere
         * fino a cinque ore — non deve far aspettare chi ha l'app davanti. Il ciclo attivo non si tocca mai: se c'è, `notificaLavoro` lo ha
         * già intercettato prima di arrivare qui.
         */
        private boolean programmaWorkManager(boolean subito) {
            OneTimeWorkRequest richiesta = new OneTimeWorkRequest.Builder(LavoroCaricamenti.class)
                    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30L, TimeUnit.SECONDS)
                    .build();
            WorkManager.getInstance(applicazione).enqueueUniqueWork(NOME_LAVORO,
                    subito ? ExistingWorkPolicy.REPLACE : ExistingWorkPolicy.APPEND_OR_REPLACE, richiesta);
            return true;
        }

        @Override
        public void mostraPausa(Testi testi) {
            notifiche.mostraPausa(testi);
        }

        @Override
        public void togliPausa() {
            notifiche.togliPausa();
        }

        @Override
        public boolean notificheAutorizzate() {
            return notifiche.autorizzate();
        }

        /** L'app non è in primo piano: la sua importanza di processo è peggiore di «in primo piano» (il nostro stesso servizio vale 125). */
        @Override
        public boolean inBackground() {
            try {
                ActivityManager.RunningAppProcessInfo stato = new ActivityManager.RunningAppProcessInfo();
                ActivityManager.getMyMemoryState(stato);
                return stato.importance > ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND;
            } catch (RuntimeException nonLeggibile) {
                Log.w(TAG, "stato del processo non leggibile (" + nonLeggibile.getClass().getSimpleName() + ")");
                return true;
            }
        }

        @Override
        public void guasto(String evento, Throwable causa) {
            // La sola CLASSE: il messaggio di un'eccezione può portare un percorso, un indirizzo o un nome di file.
            Log.e(TAG, evento + " (" + (causa == null ? "senza causa" : causa.getClass().getSimpleName()) + ")");
        }
    }
}
