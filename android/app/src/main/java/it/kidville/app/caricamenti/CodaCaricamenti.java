package it.kidville.app.caricamenti;

import androidx.core.util.AtomicFile;

import it.kidville.app.caricamenti.PoliticaCaricamento.Codice;
import it.kidville.app.caricamenti.PoliticaCaricamento.EventoStato;
import it.kidville.app.caricamenti.PoliticaCaricamento.Stato;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import java.util.function.Consumer;
import java.util.function.LongSupplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * IL GIORNALE PERSISTENTE DEI CARICAMENTI: la coda `coda.json` e la cartella che la circonda.
 * (spec 2026-10-03 «app 1.2: caricamenti nativi in background», §4.4, §4.6, §6.1, §9; compito A1)
 *
 * ─── CHE COSA È ──────────────────────────────────────────────────────────────────────────────
 * La memoria del motore: quali video sono in viaggio, in che stato, quante volte si è ritentato, fin
 * quando valgono l'URL e il token. Sopravvive alla morte del processo, al riavvio del telefono,
 * alla chiusura dell'app: è ciò che permette di riprendere un trasferimento senza che l'insegnante
 * riapra niente. Ogni cambiamento di una voce si SCRIVE SUBITO, in modo atomico (`AtomicFile`: file
 * nuovo, sincronizzazione, rinomina), così un'interruzione lascia o la coda di prima o quella di
 * dopo, mai una via di mezzo.
 *
 * ─── LA CARTELLA ─────────────────────────────────────────────────────────────────────────────
 * Il chiamante passa `getNoBackupFilesDir()/caricamenti` (Auto Backup non la vede, §9):
 * <pre>
 *   coda.json                       la coda (questo file)
 *   coda.corrotta-&lt;istante&gt;.json     una coda illeggibile, messa da parte
 *   registro.json                   il registro dei log (`RegistroNativo`)
 *   scelti/                         i preparati non ancora inviati, foto comprese (cancellati dopo 24 ore)
 *   file/&lt;jobId&gt;.&lt;ext&gt;            la copia del video di una voce viva (cancellata a ogni stato terminale)
 *   segreti/&lt;jobId&gt;.bin            token e URL firmato, cifrati (`SegretiCaricamenti`, A2)
 * </pre>
 *
 * ─── COME È FATTA ────────────────────────────────────────────────────────────────────────────
 *  · NESSUN SEGRETO nel JSON: né il token di rinnovo né l'URL firmato (stanno cifrati in `segreti/`),
 *    né un percorso assoluto (`file` è RELATIVO, e deve avere la forma `file/<jobId>.<ext>`: una voce
 *    non può puntare fuori dalla sua cartella). Un test lo verifica sul file scritto.
 *  · NIENTE `android.*` tranne `AtomicFile` di AndroidX (Java puro): la classe gira in JUnit sulla JVM.
 *    Clock e cartella arrivano dal chiamante.
 *  · I FALLIMENTI SONO VALORI, non eccezioni mute: `aggiungi` lancia `IOException` (un video che non si
 *    riesce a scrivere in coda non va dichiarato accodato), le altre scritture restituiscono se sono
 *    arrivate su disco. Uno stato non scritto non perde dati: alla riapertura la voce riparte dallo
 *    stato di prima, e una PUT ripetuta su un file già arrivato dà il duplicato che il rinnovo risolve.
 *  · TUTTI i metodi pubblici sono `synchronized`: i thread del ponte (`elenco`, `annulla`) e quello
 *    dell'esecutore leggono e scrivono la stessa lista. Restituiscono COPIE: modificarle non cambia
 *    la coda (per cambiarla ci sono `transita` e `modifica`).
 *  · UNA VOCE TERMINALE NON HA COPIA NÉ SEGRETI: la transizione che la rende tale cancella
 *    `file/<jobId>.<ext>` e `segreti/<jobId>.bin` (§4.4) e azzera `file`. Ma PRIMA SALVA lo stato terminale e SOLO DOPO cancella
 *    (secondario n. 43 della PR 3): al contrario, una scrittura fallita o un processo ucciso in mezzo lasciavano sul disco una
 *    voce viva senza copia né segreti, che alla riapertura cadeva in `FILE_ASSENTE` anche se il video era già arrivato. Se la
 *    scrittura NON riesce la copia e i segreti restano (`residuiRimasti`): sul disco la voce è ancora viva e li nomina, e alla
 *    riapertura riprende (la PUT ripetuta dà il duplicato che il rinnovo risolve). Se invece è una cancellazione a fallire,
 *    la pulizia riprova, perché il file non è più nominato da nessuna voce.
 *  · UNA SOLA ISTANZA PER PROCESSO (secondario n. 49). Due `CodaCaricamenti` sulla stessa cartella si sovrascrivono `coda.json` a
 *    vicenda, e gli aggiornamenti dell'una spariscono sotto quelli dell'altra: lo stato dell'esecutore non coinciderebbe più con
 *    ciò che il ponte legge. L'istanza è quella del motore (`PianificatoreCaricamenti.condiviso`), e la strada di produzione per
 *    ottenerla è {@link #perCartella}, che per la stessa cartella restituisce SEMPRE lo stesso oggetto. Il costruttore pubblico
 *    resta per i test, che riaprono la coda sulla stessa cartella per simulare un riavvio del processo.
 *  · `aggiungi` SU UN JOBID CON UNA VOCE TERMINALE LA SOSTITUISCE (secondario n. 44): l'apertura ripetuta di un video che era
 *    fallito o annullato — stessi bambini, stessa chiave, stesso job, token ruotato — deve ripartire, non restituire indietro la
 *    voce `fallito` e lasciare il video fermo fino a «Rimuovi». Una voce VIVA invece non si tocca (idempotenza).
 *
 * ─── COME SI COMPORTA CON UN FILE ROTTO ──────────────────────────────────────────────────────
 * File assente: coda vuota, nessun evento (è la prima volta). File illeggibile, non JSON, di versione
 * sconosciuta o con `voci` che non è un elenco: rinominato `coda.corrotta-<istante>.json`, coda nuova
 * vuota, `Rapporto.corrotta` con il numero dei file orfani in `file/` (che la pulizia toglie: senza
 * segreti non partirebbero mai; il server chiude quei job a 48 ore e avvisa l'insegnante). Una voce
 * sola fuori forma in un file buono NON porta via le altre: si scarta e si conta (`vociScartate`).
 * Il chiamante scrive `coda-nativa-corrotta` quando il rapporto lo chiede, con `file_orfani` E `voci_scartate`. I file
 * `coda.corrotta-*` contengono nomi di file e identificativi di una coda guasta: la pulizia li toglie dopo 7 giorni, come le
 * voci terminali (secondario n. 46), invece di lasciarli per sempre nella cartella privata.
 *
 * ─── LE DECISIONI DI QUESTO FILE (per chi legge A2/A3) ───────────────────────────────────────
 *  · `origine` (§4.6 la nomina senza definirla) è da dove viene il video: `galleria`, `file`
 *    («Scegli da File») o `prova` (`creaElementoDiProva`, solo Debug).
 *  · `byteInviati` NON si salva: l'avanzamento è della memoria dell'esecutore, una PUT che riparte
 *    ricomincia da zero. `aJsonPonte` lo prende come parametro.
 *  · Gli istanti si salvano in millisecondi dall'epoca; al ponte escono in ISO 8601 con la `Z`.
 */
public final class CodaCaricamenti {

    public static final int VERSIONE = 1;
    public static final String NOME_FILE_CODA = "coda.json";
    public static final String PREFISSO_FILE_CORROTTO = "coda.corrotta-";
    public static final String SOTTOCARTELLA_SCELTI = "scelti";
    public static final String SOTTOCARTELLA_FILE = "file";
    public static final String SOTTOCARTELLA_SEGRETI = "segreti";
    public static final String ESTENSIONE_SEGRETO = ".bin";

    /** I preparati non inviati vivono al più 24 ore (§4.6). */
    public static final long ETA_MASSIMA_SCELTI_MS = 24L * 60L * 60L * 1000L;
    /** Le voci terminali restano 7 giorni, il tempo che il JavaScript le legga e le `dimentichi` (§4.6). */
    public static final long RITENZIONE_TERMINALI_MS = 7L * 24L * 60L * 60L * 1000L;
    /** I file `coda.corrotta-*` restano gli stessi 7 giorni: il tempo di capire che cos'è successo (§4.6). */
    public static final long RITENZIONE_CORROTTE_MS = RITENZIONE_TERMINALI_MS;

    /**
     * Il peso massimo di un video, che il ponte non può superare in nessun campo (`MAX_VIDEO_INPUT_BYTES` di
     * `src/lib/media/video/limiti.ts`, che `schemaByteVideo` e `schemaByteInviati` di `caricamenti-nativi-tipi.ts` applicano a
     * `byteTotali` e `byteInviati`): un solo valore fuori misura renderebbe RISPOSTA_NON_VALIDA l'intero `elenco` (secondario n. 49).
     * Un test lo confronta col file TypeScript.
     */
    public static final long MAX_VIDEO_INPUT_BYTES = 2_000_000_000L;

    /** Un nome da mostrare sta fra 1 e 255 caratteri (`schemaNome` del contratto del ponte). */
    public static final int NOME_MASSIMO = 255;
    /** Il nome quando il sistema non ne dà uno (§4.2: «un ripiego suo»). */
    public static final String NOME_DI_RIPIEGO = "Video";
    /** Il MIME che il ponte porta quando quello salvato non ha la forma ammessa: mai una risposta fuori schema. */
    public static final String MIME_DI_RIPIEGO = "video/mp4";

    private static final String UUID_FORMA = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    private static final Pattern FORMA_UUID = Pattern.compile("^" + UUID_FORMA + "$");
    private static final Pattern FORMA_FILE_VOCE = Pattern.compile("^file/(" + UUID_FORMA + ")\\.[a-z0-9]{1,5}$");
    private static final Pattern FORMA_SEGRETO = Pattern.compile("^(" + UUID_FORMA + ")\\.bin(\\.new|\\.bak)?$");

    /* ────────────────────────────────────────────────────────────────────────────
     * I TIPI
     * ──────────────────────────────────────────────────────────────────────────── */

    /** Da dove viene il video di una voce. */
    public enum Origine {
        GALLERIA("galleria"),
        FILE("file"),
        PROVA("prova");

        private final String valore;

        Origine(String valore) {
            this.valore = valore;
        }

        public String valore() {
            return valore;
        }

        public static Origine daValore(String valore) {
            for (Origine origine : values()) {
                if (origine.valore.equals(valore)) return origine;
            }
            return null;
        }
    }

    /** I testi delle notifiche (§2.2): li passa il JavaScript a ogni `accodaVideo`; qui il ripiego italiano cablato. */
    public static final class Testi {
        public static final int LUNGHEZZA_MASSIMA = 200;
        public final String titolo;
        public final String invio;
        public final String attesaRete;
        public final String pausa;

        public Testi(String titolo, String invio, String attesaRete, String pausa) {
            this.titolo = o(titolo, "Kidville");
            this.invio = o(invio, "Invio dei video in corso");
            this.attesaRete = o(attesaRete, "Il video è in attesa di rete: riprenderà da solo");
            this.pausa = o(pausa, "Invio in pausa: tocca per riprendere");
        }

        /** Il testo se non è vuoto né oltre i 200 caratteri (la stessa regola di `schemaTestoNotifica`), altrimenti il ripiego. */
        private static String o(String testo, String ripiego) {
            if (testo == null || testo.trim().isEmpty() || testo.length() > LUNGHEZZA_MASSIMA) return ripiego;
            return testo;
        }

        public static Testi predefiniti() {
            return new Testi(null, null, null, null);
        }

        boolean uguale(Testi altri) {
            return titolo.equals(altri.titolo) && invio.equals(altri.invio) && attesaRete.equals(altri.attesaRete)
                    && pausa.equals(altri.pausa);
        }
    }

    /**
     * Una voce della coda: un video in viaggio (§4.6). Quella che i metodi restituiscono è una COPIA. I quattro identificativi
     * sono uuid in minuscolo e non cambiano mai.
     */
    public static final class VoceCoda {
        public final String jobId;
        public final String intentId;
        public final String utenteId;
        public final String scuolaId;
        /** Solo per lo schermo: mai in un log. */
        public String nome;
        /** Percorso RELATIVO `file/<jobId>.<ext>`; `null` quando la voce è terminale (la copia non c'è più). */
        public String file;
        public long byteTotali;
        public String mime;
        public Stato stato;
        public int tentativi;
        public int rinnovi;
        public int rinnoviConsecutivi;
        public Codice codice;
        /** Istante (ms) del prossimo tentativo; 0 = subito. */
        public long prossimoTentativoIl;
        /** Istante (ms) in cui l'URL firmato smette di valere; 0 = sconosciuto (si rinnova prima di spedire). */
        public long urlScadeIl;
        /** Istante (ms) in cui il token di rinnovo smette di valere (48 ore dall'apertura). */
        public long tokenScadeIl;
        public Origine origine;
        public long creatoIl;
        public long aggiornatoIl;

        public VoceCoda(String jobId, String intentId, String utenteId, String scuolaId) {
            this.jobId = jobId;
            this.intentId = intentId;
            this.utenteId = utenteId;
            this.scuolaId = scuolaId;
        }

        /**
         * La voce con cui nasce `accodaVideo`: `in-coda`, contatori a zero. Gli istanti `creatoIl` e `aggiornatoIl` li
         * mette la coda al momento di `aggiungi`.
         */
        public static VoceCoda nuova(String jobId, String intentId, String utenteId, String scuolaId, String nome, String file,
                                     long byteTotali, String mime, Origine origine, long urlScadeIl, long tokenScadeIl) {
            VoceCoda voce = new VoceCoda(jobId, intentId, utenteId, scuolaId);
            voce.nome = nome;
            voce.file = file;
            voce.byteTotali = byteTotali;
            voce.mime = mime;
            voce.stato = Stato.IN_CODA;
            voce.origine = origine;
            voce.urlScadeIl = urlScadeIl;
            voce.tokenScadeIl = tokenScadeIl;
            return voce;
        }

        public VoceCoda copia() {
            VoceCoda c = new VoceCoda(jobId, intentId, utenteId, scuolaId);
            c.nome = nome;
            c.file = file;
            c.byteTotali = byteTotali;
            c.mime = mime;
            c.stato = stato;
            c.tentativi = tentativi;
            c.rinnovi = rinnovi;
            c.rinnoviConsecutivi = rinnoviConsecutivi;
            c.codice = codice;
            c.prossimoTentativoIl = prossimoTentativoIl;
            c.urlScadeIl = urlScadeIl;
            c.tokenScadeIl = tokenScadeIl;
            c.origine = origine;
            c.creatoIl = creatoIl;
            c.aggiornatoIl = aggiornatoIl;
            return c;
        }
    }

    /** Com'è andata l'apertura del file all'avvio. */
    public static final class Rapporto {
        /** Il file era illeggibile o di versione sconosciuta: è stato messo da parte e la coda riparte vuota. */
        public final boolean corrotta;
        /** I file di `file/` che nessuna voce nomina (con la coda corrotta sono tutti). */
        public final int fileOrfani;
        /** Voci fuori forma in un file per il resto buono, scartate. */
        public final int vociScartate;

        Rapporto(boolean corrotta, int fileOrfani, int vociScartate) {
            this.corrotta = corrotta;
            this.fileOrfani = fileOrfani;
            this.vociScartate = vociScartate;
        }

        /** Vero se il chiamante deve scrivere `coda-nativa-corrotta`. */
        public boolean daSegnalare() {
            return corrotta || vociScartate > 0;
        }
    }

    public static final class RisultatoAggiunta {
        /** La voce com'è in coda adesso (una copia). */
        public final VoceCoda voce;
        /** Vero se c'era già una voce con quel `jobId`: l'apertura ripetuta non ne crea un'altra. */
        public final boolean giaPresente;

        RisultatoAggiunta(VoceCoda voce, boolean giaPresente) {
            this.voce = voce;
            this.giaPresente = giaPresente;
        }
    }

    public enum TipoTransizione {
        /** La transizione è stata applicata (con `modifica`: la modifica è stata applicata). */
        APPLICATA,
        /** La voce era già nello stato a cui porta l'evento: si aggiorna il codice, niente altro. */
        GIA_IN_QUELLO_STATO,
        /** La tabella di §4.4 non prevede il passo: la voce non è cambiata. */
        NON_AMMESSA,
        /** Nessuna voce con quel `jobId`. */
        VOCE_ASSENTE
    }

    public static final class EsitoTransizione {
        public final TipoTransizione tipo;
        /** La voce dopo la chiamata (una copia); `null` se non esiste. */
        public final VoceCoda voce;
        /** Falso se la scrittura su disco non è riuscita (la memoria è comunque aggiornata). */
        public final boolean persistita;
        /** Vero se una transizione terminale non è riuscita a cancellare la copia o i segreti: la pulizia riprova. */
        public final boolean residuiRimasti;

        EsitoTransizione(TipoTransizione tipo, VoceCoda voce, boolean persistita, boolean residuiRimasti) {
            this.tipo = tipo;
            this.voce = voce;
            this.persistita = persistita;
            this.residuiRimasti = residuiRimasti;
        }
    }

    /** Che cosa ha tolto la pulizia (§4.6), per le righe di log del motore. */
    public static final class ReportPulizia {
        public final int scelti;
        public final int fileOrfani;
        public final int vociTerminali;
        public final int segreti;
        /** I file `coda.corrotta-*` più vecchi di 7 giorni. */
        public final int codeCorrotte;
        public final boolean persistita;

        ReportPulizia(int scelti, int fileOrfani, int vociTerminali, int segreti, int codeCorrotte, boolean persistita) {
            this.scelti = scelti;
            this.fileOrfani = fileOrfani;
            this.vociTerminali = vociTerminali;
            this.segreti = segreti;
            this.codeCorrotte = codeCorrotte;
            this.persistita = persistita;
        }
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * LO STATO
     * ──────────────────────────────────────────────────────────────────────────── */

    private final File cartella;
    private final AtomicFile atomico;
    private final LongSupplier orologio;
    private final List<VoceCoda> voci = new ArrayList<>();
    private Testi testi = Testi.predefiniti();
    private final Rapporto rapporto;

    /** Le istanze di produzione, una per cartella canonica: vedi {@link #perCartella}. */
    private static final Map<String, CodaCaricamenti> ISTANZE_PER_CARTELLA = new HashMap<>();

    /**
     * Apre la coda in `cartella` (la crea se manca) e legge `coda.json`. `orologio` dà gli istanti in millisecondi: in
     * produzione `System::currentTimeMillis`. Non lancia mai: un file rotto è il `Rapporto`.
     *
     * ⚠️ UNA SOLA ISTANZA PER PROCESSO (testata): questo costruttore non lo garantisce, lo fa {@link #perCartella}. Si usa direttamente
     * solo nei test, per simulare un processo che riparte.
     */
    public CodaCaricamenti(File cartella, LongSupplier orologio) {
        this(cartella, orologio, new AtomicFile(new File(cartella, NOME_FILE_CODA)));
    }

    /**
     * Come il costruttore pubblico, ma con l'`AtomicFile` che il chiamante vuole: un test passa un `AtomicFile` che si comporta come
     * quello del telefono (`finishWrite` che NON lancia quando la rinomina fallisce) per provare la verifica della scrittura.
     */
    CodaCaricamenti(File cartella, LongSupplier orologio, AtomicFile atomico) {
        this.cartella = cartella;
        this.orologio = orologio;
        this.atomico = atomico;
        // `mkdirs` restituisce falso anche se la cartella c'è già: l'esito non è un errore. Se la creazione fallisce davvero,
        // la prima scrittura lo dirà (`aggiungi` lancia, le altre restituiscono `persistita = false`).
        cartella.mkdirs();
        this.rapporto = carica();
    }

    /**
     * LA STRADA DI PRODUZIONE: la coda del processo per quella cartella. La prima chiamata la apre, le successive restituiscono
     * LO STESSO oggetto (anche se `orologio` è un altro: conta il primo). Due code sulla stessa cartella si pesterebbero i piedi,
     * e il motore, il ponte e la pulizia devono vedere lo stesso stato: è questo, e non la disciplina di chi chiama, a garantire
     * «una sola istanza per processo».
     */
    public static CodaCaricamenti perCartella(File cartella, LongSupplier orologio) {
        String chiave = chiaveDellaCartella(cartella);
        synchronized (ISTANZE_PER_CARTELLA) {
            CodaCaricamenti esistente = ISTANZE_PER_CARTELLA.get(chiave);
            if (esistente != null) return esistente;
            CodaCaricamenti nuova = new CodaCaricamenti(cartella, orologio);
            ISTANZE_PER_CARTELLA.put(chiave, nuova);
            return nuova;
        }
    }

    /** Il percorso canonico (due scritture della stessa cartella, `a/../b` e `b`, sono la stessa); l'assoluto se non si risolve. */
    static String chiaveDellaCartella(File cartella) {
        try {
            return cartella.getCanonicalPath();
        } catch (IOException nonRisolvibile) {
            return cartella.getAbsolutePath();
        }
    }

    public synchronized Rapporto rapporto() {
        return rapporto;
    }

    public File cartella() {
        return cartella;
    }

    /**
     * Il file dei segreti di una voce: `segreti/<jobId>.bin`. Una sola fonte del percorso, per `SegretiCaricamenti` e per la pulizia.
     * Il `jobId` deve essere un uuid in minuscolo: la transizione terminale cancella questo file, e con un `jobId` come `../../x`
     * cancellerebbe qualcosa fuori dalla cartella dei caricamenti.
     *
     * @throws IllegalArgumentException se `jobId` non è un uuid in minuscolo
     */
    public File fileSegreto(String jobId) {
        if (!uuidMinuscolo(jobId)) throw new IllegalArgumentException("jobId non è un uuid in minuscolo");
        return new File(new File(cartella, SOTTOCARTELLA_SEGRETI), jobId + ESTENSIONE_SEGRETO);
    }

    /**
     * Il file di una copia, dal percorso relativo `file/<jobId>.<ext>` che sta nella voce. Per i preparati di `scelti/` si passa da
     * `cartellaScelti()`.
     *
     * @throws IllegalArgumentException se il percorso non ha la forma `file/<uuid>.<ext>` (niente `..`, niente percorsi assoluti)
     */
    public File fileCopia(String relativo) {
        if (relativo == null || !FORMA_FILE_VOCE.matcher(relativo).matches()) {
            throw new IllegalArgumentException("percorso della copia non ammesso");
        }
        return new File(cartella, relativo);
    }

    public File cartellaScelti() {
        return new File(cartella, SOTTOCARTELLA_SCELTI);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * LETTURA
     * ──────────────────────────────────────────────────────────────────────────── */

    public synchronized VoceCoda trova(String jobId) {
        VoceCoda voce = trovaInterna(jobId);
        return voce == null ? null : voce.copia();
    }

    /** Le voci di QUELL'utente, dalla più vecchia (per `creatoIl`; a pari istante, nell'ordine in cui sono state accodate). */
    public synchronized List<VoceCoda> elenco(String utenteId) {
        List<VoceCoda> risultato = new ArrayList<>();
        for (VoceCoda voce : voci) {
            if (voce.utenteId.equals(utenteId)) risultato.add(voce.copia());
        }
        ordinaPerCreazione(risultato);
        return risultato;
    }

    /** Le voci non terminali di tutti gli utenti, dalla più vecchia: il lavoro dell'esecutore. */
    public synchronized List<VoceCoda> vive() {
        List<VoceCoda> risultato = new ArrayList<>();
        for (VoceCoda voce : voci) {
            if (!voce.stato.terminale()) risultato.add(voce.copia());
        }
        ordinaPerCreazione(risultato);
        return risultato;
    }

    public synchronized int numeroVoci() {
        return voci.size();
    }

    public synchronized Testi testi() {
        return testi;
    }

    private static void ordinaPerCreazione(List<VoceCoda> lista) {
        // `Collections.sort` è stabile: a pari `creatoIl` resta l'ordine di accodamento.
        Collections.sort(lista, (a, b) -> Long.compare(a.creatoIl, b.creatoIl));
    }

    private VoceCoda trovaInterna(String jobId) {
        if (jobId == null) return null;
        for (VoceCoda voce : voci) {
            if (voce.jobId.equals(jobId)) return voce;
        }
        return null;
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * SCRITTURA
     * ──────────────────────────────────────────────────────────────────────────── */

    /**
     * Accoda una voce (`accodaVideo` riuscito → `in-coda`, §4.4). IDEMPOTENTE su `jobId` per una voce VIVA: se c'è già, restituisce
     * quella (senza toccarla) con `giaPresente`, ed è il caso dell'apertura ripetuta. Se la voce che c'è è TERMINALE (`inviato`,
     * `fallito`, `annullato`) la SOSTITUISCE con una nuova (`giaPresente = false`): il video rimandato agli stessi bambini ha la
     * stessa chiave e lo stesso job, e deve ripartire (secondario n. 44). Gli istanti li mette la coda.
     *
     * @throws IllegalArgumentException se la voce è fuori forma (id non uuid minuscoli, `file` assente o che non è
     *                                  `file/<jobId>.<ext>`, peso nullo...): è un errore di chi chiama, che lo traduce in
     *                                  `PARAMETRI_NON_VALIDI`
     * @throws IOException              se la coda non si riesce a scrivere: il video NON è accodato, e la voce non resta in memoria
     *                                  (né la terminale sostituita se ne va: torna al suo posto)
     */
    public synchronized RisultatoAggiunta aggiungi(VoceCoda nuova) throws IOException {
        VoceCoda voce = perLaCreazione(nuova);
        String motivo = motivoNonValida(voce);
        if (motivo != null) throw new IllegalArgumentException(motivo);
        VoceCoda esistente = trovaInterna(voce.jobId);
        if (esistente != null && !esistente.stato.terminale()) return new RisultatoAggiunta(esistente.copia(), true);
        voce.nome = nomeValido(voce.nome);
        // Una voce terminale sullo stesso `jobId` cede il posto: non ha né copia né segreti (la transizione li ha cancellati, o la
        // pulizia lo farà) e, se ne restasse un residuo nello stesso percorso, quello della voce nuova lo rimpiazza.
        int posto = esistente == null ? -1 : voci.indexOf(esistente);
        if (posto >= 0) {
            voci.set(posto, voce);
        } else {
            voci.add(voce);
        }
        if (!salva()) {
            if (posto >= 0) {
                voci.set(posto, esistente);
            } else {
                voci.remove(voce);
            }
            throw new IOException("coda non scritta");
        }
        return new RisultatoAggiunta(voce.copia(), false);
    }

    /**
     * La copia con cui nasce la voce: stato `in-coda`, nessun codice, gli istanti dell'orologio della coda. Di ciò che il chiamante
     * ha scritto in questi campi non si tiene niente: sono della coda, e uno stato terminale in ingresso non deve poter far nascere
     * una voce viva senza copia.
     */
    private VoceCoda perLaCreazione(VoceCoda nuova) {
        if (nuova == null) return null;
        VoceCoda voce = nuova.copia();
        long adesso = orologio.getAsLong();
        voce.stato = Stato.IN_CODA;
        voce.codice = null;
        voce.creatoIl = adesso;
        voce.aggiornatoIl = adesso;
        return voce;
    }

    /**
     * Sposta `sorgente` (un preparato di `scelti/`) nel percorso `voce.file` e accoda la voce, TUTTO sotto lo stesso blocco: la
     * pulizia (anch'essa sincronizzata) non può passare fra lo spostamento e l'accodamento e cancellare, come orfana, la copia
     * appena arrivata. Se la voce VIVA c'è già non si sposta niente (il preparato è già stato preso dalla prima chiamata); se c'è una
     * voce TERMINALE sullo stesso job la si sostituisce e il preparato si sposta (vedi {@link #aggiungi}). Se la scrittura della coda
     * fallisce il file torna dov'era.
     *
     * ⚠️ Il blocco che tiene tutto insieme è il MONITOR della coda (`synchronized` sull'istanza, rientrante): chi deve rendere atomica
     * una sequenza più lunga — il motore salva i segreti DENTRO lo stesso `synchronized (coda)`, così l'esecutore non vede la voce
     * prima dei suoi segreti e la pulizia non li cancella in mezzo — può prenderlo a sua volta.
     */
    public synchronized RisultatoAggiunta aggiungiSpostando(VoceCoda nuova, File sorgente) throws IOException {
        VoceCoda voce = perLaCreazione(nuova);
        String motivo = motivoNonValida(voce);
        if (motivo != null) throw new IllegalArgumentException(motivo);
        VoceCoda esistente = trovaInterna(voce.jobId);
        if (esistente != null && !esistente.stato.terminale()) return new RisultatoAggiunta(esistente.copia(), true);
        File destinazione = fileCopia(voce.file);
        File cartellaDestinazione = destinazione.getParentFile();
        if (cartellaDestinazione != null) cartellaDestinazione.mkdirs();
        if (!sorgente.renameTo(destinazione)) throw new IOException("spostamento non riuscito");
        try {
            return aggiungi(voce);
        } catch (IOException | RuntimeException errore) {
            if (!destinazione.renameTo(sorgente)) {
                // Il file resta in `file/` senza voce: la pulizia lo toglie. L'errore originale è quello che conta per chi chiama.
                destinazione.delete();
            }
            throw errore;
        }
    }

    /**
     * Applica un evento di §4.4 alla voce. Il passo deve essere nella tabella (`PoliticaCaricamento.transizione`); lo stesso
     * evento ripetuto su una voce già nello stato di destinazione non è un errore (`GIA_IN_QUELLO_STATO`: si aggiorna solo il
     * codice, per esempio da `RETE` a `SERVER`). Il codice si normalizza per stato: `inviato`, `in-coda` e `in-invio` non ne
     * hanno; `fallito` ne ha sempre uno (`INTERNO` se manca); `annullato` tiene `ANNULLATO_DAL_SERVER` o niente.
     *
     * Su uno stato terminale SALVA PRIMA lo stato (voce senza `file`) e SOLO DOPO cancella la copia e i segreti: se la scrittura non
     * riesce, o il processo muore fra le due cose, sul disco c'è ancora la voce viva COL SUO file e i suoi segreti, e alla
     * riapertura riprende da dov'era; il contrario lasciava una voce viva senza niente da spedire (secondario n. 43). Se non riesce
     * a cancellare — o se ha rinunciato a farlo perché la scrittura è fallita — lo dice (`residuiRimasti`): la pulizia ripassa.
     */
    public synchronized EsitoTransizione transita(String jobId, EventoStato evento, Codice codice) {
        VoceCoda voce = trovaInterna(jobId);
        if (voce == null || evento == null) return new EsitoTransizione(TipoTransizione.VOCE_ASSENTE, null, true, false);
        Stato destinazione = evento.destinazione();
        if (voce.stato == destinazione) {
            // Già lì: un terminale ripetuto (la PUT e il rinnovo che dicono entrambi `inviato`) non si tocca, mentre su
            // uno stato vivo si aggiorna il solo codice.
            if (voce.stato.terminale()) return new EsitoTransizione(TipoTransizione.GIA_IN_QUELLO_STATO, voce.copia(), true, false);
            Codice nuovoCodice = codicePerStato(destinazione, codice);
            if (nuovoCodice == voce.codice) return new EsitoTransizione(TipoTransizione.GIA_IN_QUELLO_STATO, voce.copia(), true, false);
            voce.codice = nuovoCodice;
            voce.aggiornatoIl = orologio.getAsLong();
            boolean scritta = salva();
            return new EsitoTransizione(TipoTransizione.GIA_IN_QUELLO_STATO, voce.copia(), scritta, false);
        }
        Stato nuovo = PoliticaCaricamento.transizione(voce.stato, evento);
        if (nuovo == null) return new EsitoTransizione(TipoTransizione.NON_AMMESSA, voce.copia(), true, false);
        String fileDaCancellare = nuovo.terminale() ? voce.file : null;
        voce.stato = nuovo;
        voce.codice = codicePerStato(nuovo, codice);
        if (nuovo.terminale()) voce.file = null;
        voce.aggiornatoIl = orologio.getAsLong();
        boolean scritta = salva();
        boolean residui = false;
        if (nuovo.terminale()) {
            // Prima il disco, poi la cancellazione. Se il disco non ha preso lo stato terminale la copia e i segreti restano: sono
            // ancora nominati dalla voce viva che la coda ha scritto l'ultima volta.
            residui = !scritta || !cancellaCopiaESegreti(voce.jobId, fileDaCancellare);
        }
        return new EsitoTransizione(TipoTransizione.APPLICATA, voce.copia(), scritta, residui);
    }

    private static Codice codicePerStato(Stato stato, Codice richiesto) {
        switch (stato) {
            case IN_ATTESA:
            case IN_PAUSA:
                return richiesto;
            case ANNULLATO:
                return richiesto == Codice.ANNULLATO_DAL_SERVER ? richiesto : null;
            case FALLITO:
                return richiesto != null ? richiesto : Codice.INTERNO;
            default:
                return null;
        }
    }

    /**
     * Cambia i campi che l'esecutore aggiorna fra una transizione e l'altra — contatori e istanti — su una COPIA della voce che
     * `modifica` riceve; tutto il resto (stato, codice, file, identificativi, peso, nome, creazione) si ripristina dall'originale
     * qualunque cosa faccia `modifica`, perché lo stato si cambia solo con `transita`. Una voce terminale non si modifica. Il
     * blocco di `modifica` dura quanto la sua esecuzione: va tenuta breve.
     *
     * @return `APPLICATA` con la voce dopo la chiamata (copia); `VOCE_ASSENTE`; `NON_AMMESSA` per una voce terminale
     */
    public synchronized EsitoTransizione modifica(String jobId, Consumer<VoceCoda> modifica) {
        VoceCoda voce = trovaInterna(jobId);
        if (voce == null) return new EsitoTransizione(TipoTransizione.VOCE_ASSENTE, null, true, false);
        if (voce.stato.terminale()) return new EsitoTransizione(TipoTransizione.NON_AMMESSA, voce.copia(), true, false);
        VoceCoda lavoro = voce.copia();
        modifica.accept(lavoro);
        voce.tentativi = Math.max(lavoro.tentativi, 0);
        voce.rinnovi = Math.max(lavoro.rinnovi, 0);
        voce.rinnoviConsecutivi = Math.max(lavoro.rinnoviConsecutivi, 0);
        voce.prossimoTentativoIl = Math.max(lavoro.prossimoTentativoIl, 0L);
        voce.urlScadeIl = Math.max(lavoro.urlScadeIl, 0L);
        voce.tokenScadeIl = Math.max(lavoro.tokenScadeIl, 0L);
        voce.aggiornatoIl = orologio.getAsLong();
        boolean scritta = salva();
        return new EsitoTransizione(TipoTransizione.APPLICATA, voce.copia(), scritta, false);
    }

    /**
     * Toglie dalla coda le voci TERMINALI indicate (`dimentica`, §4.3); le altre le ignora. Restituisce quante ne ha tolte.
     *
     * Controlla l'esito della scrittura (secondario n. 49): se `coda.json` non si riesce a scrivere le voci TORNANO al loro posto e
     * il risultato è 0. Il contrario — toglierle dalla memoria e dire «dimenticate» mentre sul disco restano — farebbe riapparire
     * alla riapertura voci che il JavaScript crede cancellate; con 0 invece sa che non è andata e riprova alla prossima occasione.
     */
    public synchronized int dimentica(Collection<String> jobIds) {
        if (jobIds == null || jobIds.isEmpty()) return 0;
        Set<String> richiesti = new HashSet<>(jobIds);
        List<VoceCoda> prima = new ArrayList<>(voci);
        List<VoceCoda> daTogliere = new ArrayList<>();
        for (Iterator<VoceCoda> it = voci.iterator(); it.hasNext(); ) {
            VoceCoda voce = it.next();
            if (voce.stato.terminale() && richiesti.contains(voce.jobId)) {
                daTogliere.add(voce);
                it.remove();
            }
        }
        if (daTogliere.isEmpty()) return 0;
        if (!salva()) {
            voci.clear();
            voci.addAll(prima);
            return 0;
        }
        for (VoceCoda voce : daTogliere) {
            // Di norma non c'è più niente da cancellare: ripeterlo è gratis e chiude i residui di una cancellazione fallita.
            cancellaCopiaESegreti(voce.jobId, voce.file);
        }
        return daTogliere.size();
    }

    public synchronized boolean impostaTesti(Testi nuovi) {
        Testi validati = nuovi == null ? Testi.predefiniti() : nuovi;
        if (validati.uguale(testi)) return true;
        testi = validati;
        return salva();
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * PULIZIA (§4.6)
     * ──────────────────────────────────────────────────────────────────────────── */

    /**
     * La pulizia all'avvio del motore. Toglie: le voci terminali più vecchie di 7 giorni; i file `coda.corrotta-*` più vecchi di 7
     * giorni (secondario n. 46: contengono nomi di file e identificativi di una coda guasta); i file di `scelti/` più vecchi di 24
     * ore; i file di `file/` che nessuna voce nomina; i segreti di `segreti/` senza una voce VIVA (i terminali non ne hanno). Non
     * tocca mai ciò che una voce viva nomina, né i nomi che non conosce in `segreti/`.
     */
    public synchronized ReportPulizia pulisci() {
        long adesso = orologio.getAsLong();
        int scelti = 0;
        int orfani = 0;
        int terminali = 0;
        int segreti = 0;
        int corrotte = 0;
        boolean cambiata = false;

        for (Iterator<VoceCoda> it = voci.iterator(); it.hasNext(); ) {
            VoceCoda voce = it.next();
            if (voce.stato.terminale() && adesso - voce.aggiornatoIl > RITENZIONE_TERMINALI_MS) {
                it.remove();
                terminali++;
                cambiata = true;
            }
        }

        for (File f : elencaFile(cartella)) {
            String nome = f.getName();
            if (!nome.startsWith(PREFISSO_FILE_CORROTTO) || !nome.endsWith(".json")) continue;
            if (adesso - istanteDelFileCorrotto(nome, f.lastModified()) > RITENZIONE_CORROTTE_MS && f.delete()) corrotte++;
        }

        for (File f : elencaFile(new File(cartella, SOTTOCARTELLA_SCELTI))) {
            if (adesso - f.lastModified() > ETA_MASSIMA_SCELTI_MS && f.delete()) scelti++;
        }

        Set<String> nominati = new HashSet<>();
        Set<String> vivi = new HashSet<>();
        for (VoceCoda voce : voci) {
            if (voce.file != null) nominati.add(voce.file);
            if (!voce.stato.terminale()) vivi.add(voce.jobId);
        }
        for (File f : elencaFile(new File(cartella, SOTTOCARTELLA_FILE))) {
            if (!nominati.contains(SOTTOCARTELLA_FILE + "/" + f.getName()) && f.delete()) orfani++;
        }

        for (File f : elencaFile(new File(cartella, SOTTOCARTELLA_SEGRETI))) {
            Matcher m = FORMA_SEGRETO.matcher(f.getName());
            if (m.matches() && !vivi.contains(m.group(1)) && f.delete()) segreti++;
        }

        boolean persistita = !cambiata || salva();
        return new ReportPulizia(scelti, orfani, terminali, segreti, corrotte, persistita);
    }

    /**
     * L'istante in cui una coda è stata messa da parte, dal nome `coda.corrotta-<istante>[-<n>].json` (millisecondi dall'epoca). Si
     * legge dal NOME e non dalla data del file: la data è quella dell'ULTIMA scrittura della coda guasta, che può essere di molto
     * prima. Se il nome non porta un numero si ripiega sulla data del file.
     */
    static long istanteDelFileCorrotto(String nome, long ripiegoMs) {
        int inizio = PREFISSO_FILE_CORROTTO.length();
        int fine = inizio;
        while (fine < nome.length() && fine - inizio < 15 && Character.isDigit(nome.charAt(fine))) fine++;
        if (fine == inizio) return ripiegoMs;
        try {
            return Long.parseLong(nome.substring(inizio, fine));
        } catch (NumberFormatException nonUnNumero) {
            return ripiegoMs;
        }
    }

    /** I file (non le cartelle) direttamente dentro `cartella`; vuoto se non esiste. */
    private static List<File> elencaFile(File cartella) {
        List<File> risultato = new ArrayList<>();
        File[] contenuto = cartella.listFiles();
        if (contenuto == null) return risultato;
        for (File f : contenuto) {
            if (f.isFile()) risultato.add(f);
        }
        return risultato;
    }

    /**
     * Cancella la copia (`fileRelativo`, `null` se non ce n'è una) e i segreti del job. Vero se non resta niente. Il percorso della
     * copia si passa a parte perché a questo punto la voce l'ha già azzerato (si salva prima lo stato, poi si cancella).
     */
    private boolean cancellaCopiaESegreti(String jobId, String fileRelativo) {
        boolean tutto = true;
        if (fileRelativo != null) tutto &= cancella(fileCopia(fileRelativo));
        File segreto = fileSegreto(jobId);
        tutto &= cancella(segreto);
        tutto &= cancella(new File(segreto.getPath() + ".new"));
        tutto &= cancella(new File(segreto.getPath() + ".bak"));
        return tutto;
    }

    private static boolean cancella(File f) {
        return !f.exists() || f.delete();
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * VALIDAZIONE
     * ──────────────────────────────────────────────────────────────────────────── */

    /** Perché una voce è fuori forma, o `null` se va bene. */
    static String motivoNonValida(VoceCoda voce) {
        if (voce == null) return "voce assente";
        if (!uuidMinuscolo(voce.jobId)) return "jobId non è un uuid in minuscolo";
        if (!uuidMinuscolo(voce.intentId)) return "intentId non è un uuid in minuscolo";
        if (!uuidMinuscolo(voce.utenteId)) return "utenteId non è un uuid in minuscolo";
        if (!uuidMinuscolo(voce.scuolaId)) return "scuolaId non è un uuid in minuscolo";
        if (voce.nome == null) return "nome assente";
        if (voce.mime == null || voce.mime.isEmpty()) return "mime assente";
        if (voce.byteTotali < 1L) return "peso nullo";
        if (voce.stato == null) return "stato assente";
        if (voce.tentativi < 0 || voce.rinnovi < 0 || voce.rinnoviConsecutivi < 0) return "contatore negativo";
        if (voce.prossimoTentativoIl < 0L || voce.urlScadeIl < 0L || voce.tokenScadeIl < 0L || voce.creatoIl < 0L
                || voce.aggiornatoIl < 0L) {
            return "istante negativo";
        }
        if (voce.origine == null) return "origine assente";
        if (voce.file == null) {
            // Una voce viva senza copia non ha niente da spedire. Il guasto «la copia non c'è più sul disco» è un altro
            // (`FILE_ASSENTE`, e il file è nominato): qui si parla di una voce che non l'ha mai avuta, o che l'ha perso dal giornale.
            if (!voce.stato.terminale()) return "voce viva senza copia";
        } else {
            Matcher m = FORMA_FILE_VOCE.matcher(voce.file);
            if (!m.matches()) return "file non ha la forma file/<jobId>.<ext>";
            if (!m.group(1).equals(voce.jobId)) return "file nomina un altro job";
        }
        return null;
    }

    private static boolean uuidMinuscolo(String id) {
        return id != null && FORMA_UUID.matcher(id).matches();
    }

    /**
     * Un nome da mostrare: da 1 a 255 caratteri (come `schemaNome` del ponte). Vuoto o assente → «Video»; oltre 255 si taglia
     * senza spezzare una coppia surrogata (una metà sola farebbe una stringa che il JavaScript non sa leggere).
     */
    public static String nomeValido(String nome) {
        if (nome == null) return NOME_DI_RIPIEGO;
        String pulito = nome.trim();
        if (pulito.isEmpty()) return NOME_DI_RIPIEGO;
        if (pulito.length() > NOME_MASSIMO) {
            int fine = NOME_MASSIMO;
            if (Character.isHighSurrogate(pulito.charAt(fine - 1))) fine--;
            pulito = pulito.substring(0, fine);
        }
        return pulito;
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL PONTE: `CaricamentoNativo` (§4.2)
     * ──────────────────────────────────────────────────────────────────────────── */

    /**
     * L'istante in ISO 8601 UTC con la `Z` e i millisecondi (`2026-10-03T12:00:00.000Z`). Mai `+0000`: il modello `Z` di
     * `SimpleDateFormat` lo scriverebbe, e `z.string().datetime({ offset: true })` lo rifiuta. Il formato nomina la `Z` fra
     * apici (un letterale) e usa `Locale.US`: nessuna lingua del telefono può cambiare le cifre o il calendario.
     */
    public static String isoUtc(long millisecondi) {
        SimpleDateFormat formato = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        formato.setTimeZone(TimeZone.getTimeZone("UTC"));
        return formato.format(new Date(millisecondi));
    }

    /**
     * Una voce nella forma di `CaricamentoNativo` che il JavaScript rilegge con zod (`schemaCaricamentoNativo`): una risposta fuori
     * forma farebbe rifiutare l'intero elenco. Quindi:
     *  · `codice` c'è SEMPRE: `JSONObject.NULL` quando non c'è niente da dire (`put(chiave, null)` TOGLIE la chiave);
     *  · le date sono ISO con la `Z`;
     *  · `nome` sta fra 1 e 255 caratteri e `mime` ha una forma ammessa, con un ripiego se la voce salvata non le rispetta;
     *  · `byteInviati` è l'avanzamento della memoria dell'esecutore, limitato a `[0, byteTotali]`; per una voce `inviato` vale
     *    sempre `byteTotali`;
     *  · `byteTotali` non supera mai `MAX_VIDEO_INPUT_BYTES` (secondario n. 49): una voce fuori misura, oggi irraggiungibile perché il
     *    JavaScript valida `byteAttesi`, renderebbe RISPOSTA_NON_VALIDA l'intero elenco invece della sola riga.
     */
    public static JSONObject aJsonPonte(VoceCoda voce, long byteInviati) {
        JSONObject json = new JSONObject();
        long totali = Math.min(voce.byteTotali, MAX_VIDEO_INPUT_BYTES);
        long inviati = voce.stato == Stato.INVIATO ? totali : Math.max(0L, Math.min(byteInviati, totali));
        try {
            json.put("jobId", voce.jobId);
            json.put("intentId", voce.intentId);
            json.put("utenteId", voce.utenteId);
            json.put("scuolaId", voce.scuolaId);
            json.put("nome", nomeValido(voce.nome));
            json.put("mime", PoliticaCaricamento.mimeValido(voce.mime) ? voce.mime : MIME_DI_RIPIEGO);
            json.put("stato", voce.stato.valore());
            json.put("byteInviati", inviati);
            json.put("byteTotali", totali);
            json.put("tentativi", Math.max(voce.tentativi, 0));
            json.put("rinnovi", Math.max(voce.rinnovi, 0));
            json.put("codice", voce.codice == null ? JSONObject.NULL : voce.codice.name());
            json.put("creatoIl", isoUtc(voce.creatoIl));
            json.put("aggiornatoIl", isoUtc(voce.aggiornatoIl));
        } catch (JSONException impossibile) {
            // `put` lancia solo per un numero non finito, e qui i numeri sono tutti interi: se arrivasse qui è un difetto del codice,
            // non un dato da perdere in silenzio.
            throw new IllegalStateException("voce non convertibile per il ponte", impossibile);
        }
        return json;
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL FILE `coda.json`
     * ──────────────────────────────────────────────────────────────────────────── */

    /**
     * Scrive la coda in modo atomico e VERIFICATO (`ScritturaAtomica`): sul telefono `AtomicFile.finishWrite` non lancia se la
     * rinomina fallisce, e dichiarare «scritto» un file che non lo è accodava video che alla riapertura non c'erano (secondario n. 45).
     * Il fallimento è il VALORE restituito: i chiamanti lo portano nel loro esito (`persistita`, o l'`IOException` di `aggiungi`) e da
     * lì nel registro. Il file vecchio è ancora intero.
     */
    private boolean salva() {
        byte[] dati;
        try {
            JSONArray elenco = new JSONArray();
            for (VoceCoda voce : voci) elenco.put(aJsonCoda(voce));
            JSONObject radice = new JSONObject();
            radice.put("versione", VERSIONE);
            radice.put("testi", aJsonTesti(testi));
            radice.put("voci", elenco);
            dati = radice.toString().getBytes(StandardCharsets.UTF_8);
        } catch (JSONException nonSerializzabile) {
            // `JSONException` in un `catch` a sé: sull'Android vero è un'eccezione controllata, in `org.json` di Maven (JUnit)
            // una `RuntimeException`, e un multi-catch che le mescola compila solo in uno dei due mondi.
            return false;
        } catch (RuntimeException nonSerializzabile) {
            return false;
        }
        return ScritturaAtomica.scrivi(atomico, dati) == null;
    }

    private static JSONObject aJsonTesti(Testi t) throws JSONException {
        JSONObject json = new JSONObject();
        json.put("titolo", t.titolo);
        json.put("invio", t.invio);
        json.put("attesaRete", t.attesaRete);
        json.put("pausa", t.pausa);
        return json;
    }

    private static JSONObject aJsonCoda(VoceCoda voce) throws JSONException {
        JSONObject json = new JSONObject();
        json.put("jobId", voce.jobId);
        json.put("intentId", voce.intentId);
        json.put("utenteId", voce.utenteId);
        json.put("scuolaId", voce.scuolaId);
        json.put("nome", voce.nome);
        json.put("file", voce.file == null ? JSONObject.NULL : voce.file);
        json.put("byte", voce.byteTotali);
        json.put("mime", voce.mime);
        json.put("stato", voce.stato.valore());
        json.put("tentativi", voce.tentativi);
        json.put("rinnovi", voce.rinnovi);
        json.put("rinnoviConsecutivi", voce.rinnoviConsecutivi);
        json.put("codice", voce.codice == null ? JSONObject.NULL : voce.codice.name());
        json.put("prossimoTentativoIl", voce.prossimoTentativoIl);
        json.put("urlScadeIl", voce.urlScadeIl);
        json.put("tokenScadeIl", voce.tokenScadeIl);
        json.put("origine", voce.origine.valore());
        json.put("creatoIl", voce.creatoIl);
        json.put("aggiornatoIl", voce.aggiornatoIl);
        return json;
    }

    /**
     * Il testo di una chiave se è una stringa, altrimenti `null` (e si userà il ripiego). Non `optString`: per un valore `null` del
     * JSON l'`org.json` di Android restituisce la parola «null» e quello di Maven il ripiego, e una notifica intitolata «null» non
     * deve dipendere da quale dei due gira.
     */
    private static String testoOppureNull(JSONObject json, String chiave) {
        Object valore = json.opt(chiave);
        return valore instanceof String ? (String) valore : null;
    }

    private static String stringa(JSONObject json, String chiave) throws JSONException {
        Object valore = json.opt(chiave);
        if (!(valore instanceof String)) throw new JSONException("manca " + chiave);
        return (String) valore;
    }

    private static long intero(JSONObject json, String chiave) throws JSONException {
        Object valore = json.opt(chiave);
        if (!(valore instanceof Number)) throw new JSONException("manca " + chiave);
        double d = ((Number) valore).doubleValue();
        if (d != Math.rint(d) || d < 0 || d > 9.0e15) throw new JSONException(chiave + " non è un intero valido");
        return ((Number) valore).longValue();
    }

    private static int contatore(JSONObject json, String chiave) throws JSONException {
        long valore = intero(json, chiave);
        if (valore > Integer.MAX_VALUE) throw new JSONException(chiave + " fuori misura");
        return (int) valore;
    }

    private static VoceCoda daJsonCoda(JSONObject json) throws JSONException {
        VoceCoda voce = new VoceCoda(stringa(json, "jobId"), stringa(json, "intentId"), stringa(json, "utenteId"),
                stringa(json, "scuolaId"));
        voce.nome = stringa(json, "nome");
        voce.file = json.isNull("file") ? null : stringa(json, "file");
        voce.byteTotali = intero(json, "byte");
        voce.mime = stringa(json, "mime");
        voce.stato = Stato.daValore(stringa(json, "stato"));
        if (voce.stato == null) throw new JSONException("stato sconosciuto");
        voce.tentativi = contatore(json, "tentativi");
        voce.rinnovi = contatore(json, "rinnovi");
        voce.rinnoviConsecutivi = contatore(json, "rinnoviConsecutivi");
        if (json.isNull("codice")) {
            voce.codice = null;
        } else {
            voce.codice = Codice.daValore(stringa(json, "codice"));
            if (voce.codice == null) throw new JSONException("codice sconosciuto");
        }
        voce.prossimoTentativoIl = intero(json, "prossimoTentativoIl");
        voce.urlScadeIl = intero(json, "urlScadeIl");
        voce.tokenScadeIl = intero(json, "tokenScadeIl");
        voce.origine = Origine.daValore(stringa(json, "origine"));
        if (voce.origine == null) throw new JSONException("origine sconosciuta");
        voce.creatoIl = intero(json, "creatoIl");
        voce.aggiornatoIl = intero(json, "aggiornatoIl");
        // Una voce terminale non ha copia: se il file ne nomina una, la nomina a vuoto (resterebbe orfana per sempre).
        if (voce.stato.terminale()) voce.file = null;
        String motivo = motivoNonValida(voce);
        if (motivo != null) throw new JSONException(motivo);
        return voce;
    }

    private Rapporto carica() {
        byte[] dati;
        try {
            dati = atomico.readFully();
        } catch (FileNotFoundException assente) {
            // Nessuna coda ancora (primo avvio): non è un guasto.
            return new Rapporto(false, 0, 0);
        } catch (IOException illeggibile) {
            return mettiDaParteLaCorrotta();
        }
        JSONObject radice;
        JSONArray elenco;
        Testi lettiTesti;
        try {
            radice = new JSONObject(new String(dati, StandardCharsets.UTF_8));
            if (!(radice.opt("versione") instanceof Number) || ((Number) radice.opt("versione")).intValue() != VERSIONE) {
                return mettiDaParteLaCorrotta();
            }
            elenco = radice.optJSONArray("voci");
            if (elenco == null) return mettiDaParteLaCorrotta();
            JSONObject t = radice.optJSONObject("testi");
            lettiTesti = t == null ? Testi.predefiniti()
                    : new Testi(testoOppureNull(t, "titolo"), testoOppureNull(t, "invio"), testoOppureNull(t, "attesaRete"),
                            testoOppureNull(t, "pausa"));
        } catch (JSONException nonJson) {
            return mettiDaParteLaCorrotta();
        }
        testi = lettiTesti;
        int scartate = 0;
        Set<String> visti = new HashSet<>();
        for (int i = 0; i < elenco.length(); i++) {
            JSONObject elemento = elenco.optJSONObject(i);
            if (elemento == null) {
                scartate++;
                continue;
            }
            try {
                VoceCoda voce = daJsonCoda(elemento);
                if (!visti.add(voce.jobId)) {
                    scartate++;
                    continue;
                }
                voci.add(voce);
            } catch (JSONException fuoriForma) {
                scartate++;
            }
        }
        int orfani = scartate > 0 ? contaOrfani() : 0;
        return new Rapporto(false, orfani, scartate);
    }

    /** I file di `file/` che nessuna voce nomina. */
    private int contaOrfani() {
        Set<String> nominati = new HashSet<>();
        for (VoceCoda voce : voci) {
            if (voce.file != null) nominati.add(voce.file);
        }
        int orfani = 0;
        for (File f : elencaFile(new File(cartella, SOTTOCARTELLA_FILE))) {
            if (!nominati.contains(SOTTOCARTELLA_FILE + "/" + f.getName())) orfani++;
        }
        return orfani;
    }

    /**
     * Il file è illeggibile o di versione sconosciuta (§4.6): lo rinomina `coda.corrotta-<istante>.json` (così resta per chi
     * deve capire che cos'è successo) e riparte da una coda vuota. I residui di una scrittura interrotta (`.new`, `.bak`) non
     * servono più. Se la rinomina non riesce il file si cancella: lasciarlo lì farebbe ripetere la stessa scena a ogni avvio,
     * e la prossima scrittura lo rimpiazzerebbe comunque.
     */
    private Rapporto mettiDaParteLaCorrotta() {
        File base = atomico.getBaseFile();
        long istante = orologio.getAsLong();
        if (base.exists()) {
            boolean spostato = false;
            for (int tentativo = 0; tentativo < 5 && !spostato; tentativo++) {
                String suffisso = tentativo == 0 ? "" : "-" + tentativo;
                File destinazione = new File(cartella, PREFISSO_FILE_CORROTTO + istante + suffisso + ".json");
                // `renameTo` sovrascrive un file che c'è già (rename(2)): senza questo controllo due perdite nello stesso
                // millisecondo cancellerebbero la prova della prima.
                if (destinazione.exists()) continue;
                spostato = base.renameTo(destinazione);
            }
            if (!spostato) base.delete();
        }
        new File(base.getPath() + ".new").delete();
        new File(base.getPath() + ".bak").delete();
        voci.clear();
        testi = Testi.predefiniti();
        // La coda nuova è vuota: ogni file di `file/` è orfano.
        return new Rapporto(true, contaOrfani(), 0);
    }
}
