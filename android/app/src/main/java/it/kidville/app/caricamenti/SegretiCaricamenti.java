package it.kidville.app.caricamenti;

import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;

import androidx.annotation.RequiresApi;
import androidx.core.util.AtomicFile;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.Key;
import java.security.KeyStore;
import java.security.ProviderException;
import java.security.UnrecoverableKeyException;
import java.util.Locale;
import java.util.function.Function;
import java.util.function.UnaryOperator;

import javax.crypto.BadPaddingException;
import javax.crypto.Cipher;
import javax.crypto.IllegalBlockSizeException;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * I SEGRETI DEI CARICAMENTI: il token di rinnovo e l'URL firmato, cifrati, mai nel JSON della coda.
 * (spec 2026-10-03 «app 1.2: caricamenti nativi in background», §2.2 «Segreti», §4.6, §6.1, §9; compito A2)
 *
 * ─── CHE COSA È ──────────────────────────────────────────────────────────────────────────────
 * Per ogni video in viaggio, un file `segreti/<jobId>.bin` nella cartella privata e senza backup (`noBackupFilesDir`), cifrato
 * con AES-256-GCM sotto una chiave dell'ANDROIDKEYSTORE (`kidville_caricamenti`) che non lascia mai il modulo di sicurezza del
 * telefono. Dentro, un piccolo JSON con tutto ciò che è una CREDENZIALE o che serve per usarla:
 * <pre>
 *   token         il token di rinnovo (`kvr_…`): da solo dà un URL di caricamento nuovo per QUEL percorso finché l'originale non arriva
 *   urlPut        l'URL di PUT firmato, valido due ore: è una credenziale come il token
 *   contentType   l'intestazione `content-type` che il server ha dichiarato per quella PUT
 *   urlRinnovo    dove si chiede il rinnovo (`${origin}/api/video-uploads/rinnovo`)
 *   urlRegistro   dove si spediscono i log (`${origin}/api/logs`): in Release il nativo usa comunque l'indirizzo fisso
 * </pre>
 * L'indirizzo di rinnovo e quello del registro non sono segreti, ma arrivano con `accodaVideo` e la coda (§4.6) non ha un posto per
 * loro: stanno qui, accanto alla credenziale a cui servono, e scompaiono con lei.
 *
 * ─── PERCHÉ CIFRATO, E PERCHÉ NON NELLA CODA ─────────────────────────────────────────────────
 * Il contratto della PR 2 (§12.5) vuole token e URL «in Keychain/Keystore, esclusi dai backup»: il progetto li metteva in
 * `coda.json`, che è un file in chiaro leggibile da chiunque abbia il telefono sbloccato con un debugger o un backup `adb`. Un
 * token rubato dà al più un URL per quel solo percorso, ma resta una credenziale su un video di un bambino. Con la chiave nel
 * Keystore il file da solo non serve a niente.
 *
 * ─── COME È FATTA ────────────────────────────────────────────────────────────────────────────
 *  · FORMATO: `[versione: 1 byte][cifrato]`, dove il cifrato lo decide il {@link Cifrario} (in produzione `[lunghezza dell'IV][IV]
 *    [testo cifrato + tag di 16 byte]`). Il tag GCM autentica anche i DATI ASSOCIATI, che sono il `jobId`: un file copiato dal
 *    percorso di un job a quello di un altro non si decifra.
 *  · IL CIFRARIO È INIETTABILE. L'`AndroidKeyStore` non esiste sulla JVM di JUnit: i test passano un cifrario software con lo stesso
 *    formato e provano tutto il resto (forma del file, dati associati, manomissione, sostituzione, cancellazione). La classe di
 *    produzione ({@link CifrarioKeystore}) è l'unica che nomina `android.security`, e si carica solo quando serve.
 *  · SCRITTURA ATOMICA E VERIFICATA (`ScritturaAtomica`): un segreto «salvato» che sul disco non c'è lascia un video senza
 *    credenziali. I file sono `segreti/<jobId>.bin`, il percorso che la coda e la pulizia già conoscono (`CodaCaricamenti.fileSegreto`):
 *    una transizione terminale li cancella, e la pulizia toglie quelli senza una voce viva.
 *  · TUTTI I METODI SONO `synchronized`: il motore (un thread) rinnova e il ponte (un altro) può sostituire il token di una voce,
 *    e senza questo un `leggi` + `salva` dell'uno cancellerebbe il token nuovo dell'altro. Per questo c'è {@link #aggiorna}, che
 *    legge, modifica e scrive sotto lo stesso blocco: chi cambia SOLO l'URL non deve poter riportare indietro il token.
 *  · NESSUN LOG DI DATI qui, e niente nelle eccezioni: un segreto che non si legge è un VALORE (`ILLEGGIBILE`, `NON_LEGGIBILE_ORA`) e il
 *    chiamante decide che cosa farne. In logcat va al più una riga — `info` per un guasto che passa, `warn` per uno definitivo — con la
 *    sola CLASSE dell'eccezione. Mai il contenuto, mai un percorso, mai il messaggio di un'eccezione.
 *
 * ─── I TRE MODI DI NON LEGGERE UN SEGRETO (secondario n. 79) ─────────────────────────────────
 * Chiudere la voce `fallito` per un guasto che passa costa un video da rimandare a mano, con copia e segreti già cancellati: per questo la
 * lettura distingue, con criteri ESPLICITI, ciò che è finito da ciò che è solo fermo:
 *  · `ASSENTE` — il file non c'è (e `file.exists()` lo conferma: `FileInputStream` lancia «file non trovato» per OGNI apertura fallita,
 *    anche con il file presente, per troppi file aperti o un permesso). Definitivo: i segreti di quel job non esistono più.
 *  · `ILLEGGIBILE` — il file c'è e non si leggerà MAI: versione o forma sbagliata, contenuto toccato (il tag GCM non torna), file di un
 *    altro job (dati associati diversi), chiave invalidata o non più recuperabile, qualunque guasto che il cifrario non riconosce come
 *    passeggero. Definitivo: la voce non può più né rinnovare né spedire.
 *  · `NON_LEGGIBILE_ORA` — non si legge ADESSO ma il file e la chiave ci sono e riprovare fra poco può riuscire: un errore di lettura del
 *    disco (`IOException` che non sia «file mancante»), un Keystore occupato, che si sta riavviando o che non risponde. Lo dice il
 *    {@link Cifrario} ({@link Cifrario#guastoTransitorio}). Per il Keystore, da API 33, decide il verdetto di
 *    `android.security.KeyStoreException`: è passeggero un guasto che `isTransientFailure()` dichiara tale OPPURE che `isSystemError()` dichiara
 *    del SISTEMA (del Keystore o di KeyMint, non di quella chiave: una chiave nuova non lo risolve). È il caso di SYSTEM_ERROR dopo una
 *    connessione persa col demone, che il sistema NON marca passeggero (KeyStoreException.java:666-668). Il verdetto vince anche sui tipi che
 *    su keystore2 avvolgono ogni errore, passeggeri e di sistema compresi (`UnrecoverableKeyException`, `IllegalBlockSizeException`:
 *    secondari n. 153 e n. 154). Su tutti i livelli: un `ProviderException` (è ciò che il provider lancia per un'operazione che non è
 *    riuscita, non per una chiave cattiva) e l'`IllegalStateException` con cui il sistema dice «Could not connect to Keystore service»
 *    (KeyStore2.java:148-157), che non porta né un tipo suo né una causa. Sempre che nella catena delle cause non ci sia un guasto
 *    definitivo (contenuto toccato, chiave invalidata), che vince su tutto. La voce aspetta (`in-attesa` `INTERNO`, con le attese di §4.5) e
 *    conserva copia e segreti; il tetto di tutto è la vita del token, 48 ore, oltre cui `TOKEN_SCADUTO` la chiude.
 *
 * ─── LA CHIAVE NON SI ELIMINA PER UN GUASTO DEL SISTEMA (secondario n. 154 e seguito) ───────
 * Se `getKey` non restituisce la chiave (`UnrecoverableKeyException`) l'unica via per tornare a scrivere è eliminarla e crearne una nuova, e
 * costa i segreti di TUTTE le voci vive: ciò che era cifrato con la vecchia non si legge più. Ma su keystore2 (API 33+) quell'eccezione avvolge
 * ogni errore di `getKeyEntry` diverso da KEY_NOT_FOUND e KEY_PERMANENTLY_INVALIDATED (AndroidKeyStoreProvider.java:414-417), e fra quelli ci
 * sono i guasti del SISTEMA, che con la chiave non c'entrano. Il più tipico è SYSTEM_ERROR dopo una connessione persa col demone
 * (KeyStore2.java:122-124): NON è marcato passeggero — KeyStoreException.java:666-668 gli dà solo IS_SYSTEM_ERROR, e `isTransientFailure()`
 * è falso — ma è marcato di sistema, e la documentazione di `isSystemError()` (KeyStoreException.java:366-373) dice che un errore di sistema
 * è una funzione che non funziona, mentre solo un errore della chiave «is likely to succeed with a new key»: una chiave nuova non lo risolve.
 * Un intoppo di un istante non può far fallire INTERNO ogni invio in corso, né distruggere i segreti di tutti: sarebbe l'opposto del n. 79.
 * Quindi la chiave si elimina SOLO per cifrare un segreto nuovo E per un guasto della chiave ({@link CifrarioKeystore#eDaEliminare}):
 *  · mai durante una decifratura: si rilancia, e decide `guastoTransitorio`;
 *  · da API 33, mai se il sistema dichiara il guasto passeggero o di sistema; sì se non dice né l'uno né l'altro, oppure se non dice niente
 *    (l'invalidazione permanente arriva come un `UnrecoverableKeyException` col solo messaggio, senza causa: AndroidKeyStoreSpi.java:126-127);
 *  · su API 24-32, dove il sistema non dà un verdetto, come sempre.
 * In ogni caso una riga `warn` in logcat ({@link CifrarioKeystore#trattaLaChiaveInutilizzabile}), con la sola classe dell'eccezione. Quando la
 * chiave si elimina la riga dice che ci si PROVA: è scritta prima dell'eliminazione, e se questa non riesce il suo guasto esce a chi chiama.
 *
 * ─── COSA NON PROTEGGE ───────────────────────────────────────────────────────────────────────
 * La chiave non richiede lo sblocco dello schermo (`setUnlockedDeviceRequired` non c'è, di proposito): l'invio deve poter
 * continuare a telefono bloccato, che è lo scopo di tutto il motore. Chi può eseguire codice nel processo dell'app può usare la
 * chiave: il Keystore protegge il file a riposo, non un processo compromesso.
 */
public final class SegretiCaricamenti {

    /** L'alias della chiave AES nell'AndroidKeyStore. */
    public static final String ALIAS_CHIAVE = "kidville_caricamenti";

    /** La versione del formato del file: si alza solo se cambia la forma, e un file di versione diversa è `ILLEGGIBILE`. */
    public static final int VERSIONE_FILE = 1;

    /** I dati associati autenticati dal tag GCM: il prefisso fisso + il `jobId`. */
    static final String PREFISSO_DATI_ASSOCIATI = "kidville-caricamenti-segreti-v1:";

    /** Cifra e decifra un blocco: l'unico punto che tocca il Keystore. Le eccezioni sono quelle della JCA. */
    public interface Cifrario {
        /** Cifra `chiaro` autenticando `datiAssociati`; il risultato porta con sé l'IV e il tag, ed è tutto ciò che serve a decifrare. */
        byte[] cifra(byte[] chiaro, byte[] datiAssociati) throws GeneralSecurityException, IOException;

        /** L'inverso: lancia se il blocco è stato toccato, o se i dati associati non sono quelli con cui è stato cifrato. */
        byte[] decifra(byte[] cifrato, byte[] datiAssociati) throws GeneralSecurityException, IOException;

        /**
         * Il guasto lanciato da `cifra` o `decifra` è PASSEGGERO? Vero se riprovare fra poco può riuscire (un archivio delle chiavi occupato
         * o che si sta riavviando); falso se il file non si leggerà mai più (toccato, chiave invalidata). Lo può dire solo il cifrario, che
         * conosce il suo sistema. Il predefinito riconosce l'unico caso che vale per ogni cifrario: un errore di I/O. `leggi` lo usa per
         * distinguere `NON_LEGGIBILE_ORA` da `ILLEGGIBILE` (secondario n. 79).
         */
        default boolean guastoTransitorio(Throwable guasto) {
            return guasto instanceof IOException;
        }
    }

    /** Ciò che si custodisce per un job. Immutabile; nessun campo è nullo né vuoto. */
    public static final class Segreti {
        public final String token;
        public final String urlPut;
        public final String contentType;
        public final String urlRinnovo;
        public final String urlRegistro;

        public Segreti(String token, String urlPut, String contentType, String urlRinnovo, String urlRegistro) {
            this.token = richiesto(token, "token");
            this.urlPut = richiesto(urlPut, "urlPut");
            this.contentType = richiesto(contentType, "contentType");
            this.urlRinnovo = richiesto(urlRinnovo, "urlRinnovo");
            this.urlRegistro = richiesto(urlRegistro, "urlRegistro");
        }

        private static String richiesto(String valore, String nome) {
            if (valore == null || valore.isEmpty()) throw new IllegalArgumentException("segreto senza " + nome);
            return valore;
        }

        /** Gli stessi segreti con un URL di PUT nuovo (un rinnovo): il token, e tutto il resto, restano quelli di ora. */
        public Segreti conUrlPut(String nuovoUrlPut, String nuovoContentType) {
            return new Segreti(token, nuovoUrlPut, nuovoContentType, urlRinnovo, urlRegistro);
        }

        /** Senza `equals` ereditato dall'oggetto: due custodie con gli stessi valori sono lo stesso segreto. */
        public boolean uguale(Segreti altri) {
            return altri != null && token.equals(altri.token) && urlPut.equals(altri.urlPut) && contentType.equals(altri.contentType)
                    && urlRinnovo.equals(altri.urlRinnovo) && urlRegistro.equals(altri.urlRegistro);
        }

        /** Mai il contenuto: un segreto non finisce in una riga di log per sbaglio. */
        @Override
        public String toString() {
            return "Segreti{…}";
        }
    }

    /** Come è andata una lettura. */
    public enum Esito {
        /** Il file c'era, si è decifrato e aveva la forma giusta. */
        OK,
        /** Nessun file: la voce non ha (più) segreti. */
        ASSENTE,
        /**
         * Il file c'è ma non si leggerà MAI: toccato, di un'altra versione, di un altro job, cifrato con una chiave che il Keystore non ha
         * più o ha invalidato, o con una forma sbagliata. Vale come «segreti persi»: la voce non può più né rinnovare né spedire.
         */
        ILLEGGIBILE,
        /**
         * Il file c'è e la chiave pure, ma ADESSO non si legge: un errore di lettura del disco, un Keystore occupato o che si sta
         * riavviando (criteri nella testata della classe). NON vale «segreti persi»: la voce aspetta e riprova, con copia e segreti intatti
         * (secondario n. 79).
         */
        NON_LEGGIBILE_ORA
    }

    /** L'esito di una lettura e, solo per `OK`, ciò che c'era scritto. */
    public static final class Lettura {
        public final Esito esito;
        public final Segreti segreti;

        Lettura(Esito esito, Segreti segreti) {
            this.esito = esito;
            this.segreti = segreti;
        }
    }

    private static final Lettura LETTURA_ASSENTE = new Lettura(Esito.ASSENTE, null);
    private static final Lettura LETTURA_ILLEGGIBILE = new Lettura(Esito.ILLEGGIBILE, null);
    private static final Lettura LETTURA_NON_LEGGIBILE_ORA = new Lettura(Esito.NON_LEGGIBILE_ORA, null);

    private final CodaCaricamenti coda;
    private final Cifrario cifrario;
    /** Come si apre il file atomico di un job: `AtomicFile` in produzione; un test ne passa uno che si comporta come quello del telefono. */
    private final Function<File, AtomicFile> aperturaFile;

    /**
     * @param coda     la coda del processo: dà il percorso di `segreti/<jobId>.bin` (e rifiuta un `jobId` che non sia un uuid in minuscolo)
     * @param cifrario in produzione `new CifrarioKeystore()`
     */
    public SegretiCaricamenti(CodaCaricamenti coda, Cifrario cifrario) {
        this(coda, cifrario, AtomicFile::new);
    }

    SegretiCaricamenti(CodaCaricamenti coda, Cifrario cifrario, Function<File, AtomicFile> aperturaFile) {
        this.coda = coda;
        this.cifrario = cifrario;
        this.aperturaFile = aperturaFile;
    }

    /** Il cifrario di produzione, con la chiave `kidville_caricamenti` dell'AndroidKeyStore. */
    public static SegretiCaricamenti diProduzione(CodaCaricamenti coda) {
        return new SegretiCaricamenti(coda, new CifrarioKeystore());
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * SCRITTURA, LETTURA, CANCELLAZIONE
     * ──────────────────────────────────────────────────────────────────────────── */

    /**
     * Salva (o SOSTITUISCE) i segreti di un job: scrittura atomica, verificata. È ciò che fa `accodaVideo`, anche alla ripetizione
     * dell'apertura con il token ruotato.
     *
     * @throws IOException              se non si riesce a cifrare o a scrivere (il file di prima, se c'era, è ancora intero)
     * @throws IllegalArgumentException se `jobId` non è un uuid in minuscolo
     */
    public synchronized void salva(String jobId, Segreti segreti) throws IOException {
        if (segreti == null) throw new IllegalArgumentException("segreti assenti");
        File file = coda.fileSegreto(jobId);
        byte[] cifrato;
        try {
            byte[] chiaro = aJson(segreti).toString().getBytes(StandardCharsets.UTF_8);
            cifrato = cifrario.cifra(chiaro, datiAssociati(jobId));
        } catch (GeneralSecurityException | JSONException | RuntimeException nonCifrabile) {
            throw new IOException("segreti non cifrabili: " + nonCifrabile.getClass().getSimpleName());
        }
        byte[] contenuto = new byte[cifrato.length + 1];
        contenuto[0] = (byte) VERSIONE_FILE;
        System.arraycopy(cifrato, 0, contenuto, 1, cifrato.length);
        IOException errore = ScritturaAtomica.scrivi(aperturaFile.apply(file), contenuto);
        if (errore != null) throw errore;
    }

    /**
     * Legge i segreti di un job. Non lancia mai: il guasto è un valore, e sono TRE (testata della classe, secondario n. 79): `ASSENTE` (il
     * file non c'è), `ILLEGGIBILE` (c'è e non si leggerà mai) e `NON_LEGGIBILE_ORA` (c'è, ma adesso non si legge: riprovare può riuscire).
     */
    public synchronized Lettura leggi(String jobId) {
        File file = coda.fileSegreto(jobId);
        byte[] contenuto;
        try {
            contenuto = aperturaFile.apply(file).readFully();
        } catch (FileNotFoundException nonAperto) {
            // `FileInputStream` lancia questa eccezione per OGNI apertura fallita: «sparito» vale solo se il file davvero non c'è.
            if (!file.exists()) return LETTURA_ASSENTE;
            return nonLeggibileOra("file dei segreti presente ma non apribile", nonAperto);
        } catch (IOException guastoDiLettura) {
            return nonLeggibileOra("file dei segreti non letto", guastoDiLettura);
        } catch (RuntimeException guastoImprevisto) {
            return illeggibile("file dei segreti non leggibile", guastoImprevisto);
        }
        if (contenuto.length < 2 || contenuto[0] != (byte) VERSIONE_FILE) return LETTURA_ILLEGGIBILE;
        byte[] cifrato = new byte[contenuto.length - 1];
        System.arraycopy(contenuto, 1, cifrato, 0, cifrato.length);
        try {
            byte[] chiaro = cifrario.decifra(cifrato, datiAssociati(jobId));
            Segreti segreti = daJson(new JSONObject(new String(chiaro, StandardCharsets.UTF_8)));
            return segreti == null ? LETTURA_ILLEGGIBILE : new Lettura(Esito.OK, segreti);
        } catch (GeneralSecurityException | IOException | JSONException | RuntimeException nonDecifrabile) {
            // Passeggero o definitivo lo dice il cifrario (testata della classe). Il motivo, in logcat, è la sola CLASSE: un messaggio
            // d'eccezione può portare un pezzo di contenuto, e il chiamante non sa che farsene.
            if (cifrario.guastoTransitorio(nonDecifrabile)) return nonLeggibileOra("segreti non decifrati adesso", nonDecifrabile);
            return illeggibile("segreti non decifrabili", nonDecifrabile);
        }
    }

    /** Un guasto che passa: si dice (`info`, con la sola classe) e la lettura vale «non adesso». */
    private static Lettura nonLeggibileOra(String frase, Throwable guasto) {
        DiagnosticaLocale.info(frase + " (" + DiagnosticaLocale.classe(guasto) + "): passeggero, la voce riprova");
        return LETTURA_NON_LEGGIBILE_ORA;
    }

    /** Un guasto che non passa: si dice (`avviso`, con la sola classe) e la lettura vale «mai più». */
    private static Lettura illeggibile(String frase, Throwable guasto) {
        DiagnosticaLocale.avviso(frase + " (" + DiagnosticaLocale.classe(guasto) + "): definitivo");
        return LETTURA_ILLEGGIBILE;
    }

    /**
     * Legge, modifica e riscrive i segreti sotto lo STESSO blocco: chi cambia solo l'URL (un rinnovo) non può riportare indietro un
     * token che nel frattempo `accodaVideo` ha ruotato. Se il file non c'è o non si legge non scrive niente e restituisce la lettura.
     * `modifica` non deve restituire `null`.
     */
    public synchronized Lettura aggiorna(String jobId, UnaryOperator<Segreti> modifica) throws IOException {
        Lettura attuale = leggi(jobId);
        if (attuale.esito != Esito.OK) return attuale;
        Segreti nuovi = modifica.apply(attuale.segreti);
        if (nuovi == null) throw new IllegalArgumentException("segreti nulli");
        salva(jobId, nuovi);
        return new Lettura(Esito.OK, nuovi);
    }

    /**
     * Cancella i segreti di un job e i residui di una scrittura interrotta (`.new`, `.bak`). Vero se non resta niente. Di norma ci
     * pensa già la transizione terminale della coda; qui serve a chi li ha salvati e poi non ha potuto accodare la voce.
     */
    public synchronized boolean cancella(String jobId) {
        File file = coda.fileSegreto(jobId);
        boolean tutto = cancellaSeEsiste(file);
        tutto &= cancellaSeEsiste(new File(file.getPath() + ".new"));
        tutto &= cancellaSeEsiste(new File(file.getPath() + ".bak"));
        return tutto;
    }

    private static boolean cancellaSeEsiste(File file) {
        return !file.exists() || file.delete();
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL CONTENUTO
     * ──────────────────────────────────────────────────────────────────────────── */

    static byte[] datiAssociati(String jobId) {
        return (PREFISSO_DATI_ASSOCIATI + jobId).getBytes(StandardCharsets.UTF_8);
    }

    private static JSONObject aJson(Segreti s) throws JSONException {
        JSONObject json = new JSONObject();
        json.put("token", s.token);
        json.put("urlPut", s.urlPut);
        json.put("contentType", s.contentType);
        json.put("urlRinnovo", s.urlRinnovo);
        json.put("urlRegistro", s.urlRegistro);
        return json;
    }

    /** I cinque campi, tutti stringhe non vuote; altrimenti `null` (e il file vale `ILLEGGIBILE`). */
    private static Segreti daJson(JSONObject json) {
        String token = testo(json, "token");
        String urlPut = testo(json, "urlPut");
        String contentType = testo(json, "contentType");
        String urlRinnovo = testo(json, "urlRinnovo");
        String urlRegistro = testo(json, "urlRegistro");
        if (token == null || urlPut == null || contentType == null || urlRinnovo == null || urlRegistro == null) return null;
        return new Segreti(token, urlPut, contentType, urlRinnovo, urlRegistro);
    }

    /** Il valore se è una stringa non vuota, altrimenti `null` (non `optString`: restituirebbe la parola «null»). */
    private static String testo(JSONObject json, String chiave) {
        Object valore = json.opt(chiave);
        return valore instanceof String && !((String) valore).isEmpty() ? (String) valore : null;
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL CIFRARIO DI PRODUZIONE: AES-256-GCM con una chiave dell'AndroidKeyStore
     * ──────────────────────────────────────────────────────────────────────────── */

    /**
     * La chiave AES-256 `kidville_caricamenti` dell'AndroidKeyStore, creata alla prima volta; la cifratura è `AES/GCM/NoPadding`.
     * Vale la ricetta di riferimento di Android: l'IV lo sceglie il cifrario (il Keystore pretende la cifratura randomizzata) e si legge
     * con `getIV()`; per decifrare si passa un `GCMParameterSpec` a 128 bit.
     *
     * Formato del blocco restituito da {@link #cifra}: `[lunghezza dell'IV: 1 byte][IV][testo cifrato + tag]`.
     *
     * Se la chiave esiste ma non si riesce a usarla (`UnrecoverableKeyException`: succede dopo certi aggiornamenti di sistema o con
     * un Keystore danneggiato) la si ELIMINA e se ne crea una nuova SOLO quando serve per cifrare un segreto nuovo e il guasto è
     * della chiave ({@link #eDaEliminare}): i file cifrati con la vecchia diventano `ILLEGGIBILE` — lo erano già — ma i nuovi segreti si
     * possono di nuovo scrivere; senza questo il motore non potrebbe più accodare niente. Durante una decifratura, o per un guasto che il
     * sistema dichiara passeggero o di sistema (API 33+: un errore di sistema non si risolve con una chiave nuova), la chiave non si tocca:
     * eliminarla renderebbe illeggibili i segreti di tutte le voci vive senza risolvere niente (secondario n. 154).
     */
    public static final class CifrarioKeystore implements Cifrario {
        private static final String PROVIDER = "AndroidKeyStore";
        private static final String TRASFORMAZIONE = "AES/GCM/NoPadding";
        private static final int BIT_DEL_TAG = 128;

        /**
         * Il primo livello di API in cui il sistema dà un verdetto sui guasti del Keystore (`KeyStoreException#isTransientFailure` e
         * `KeyStoreException#isSystemError`: la classe pubblica è «since 33»).
         */
        static final int API_CON_VERDETTO = 33;

        /**
         * Da dove viene la chiave. `perCifrare` dice a che cosa serve: scrivere un segreto NUOVO (vero) o leggerne uno già scritto (falso), perché
         * da quello dipende se una chiave inutilizzabile si può eliminare ({@link CifrarioKeystore#eDaEliminare}). In produzione è il metodo
         * `chiave(boolean)` di questa classe; i test ne passano uno che dà una chiave software, e così provano `cifra` e `decifra` sulla JVM,
         * senza l'AndroidKeyStore.
         */
        interface FornitoreDellaChiave {
            SecretKey chiave(boolean perCifrare) throws GeneralSecurityException, IOException;
        }

        private final String alias;
        private final FornitoreDellaChiave fornitore;

        public CifrarioKeystore() {
            this(ALIAS_CHIAVE);
        }

        CifrarioKeystore(String alias) {
            this.alias = alias;
            this.fornitore = this::chiave;
        }

        /** SOLO PER I TEST: una chiave che non viene dall'AndroidKeyStore (che sulla JVM non esiste). */
        CifrarioKeystore(FornitoreDellaChiave fornitore) {
            this.alias = ALIAS_CHIAVE;
            this.fornitore = fornitore;
        }

        /** Fin dove si risale la catena delle cause: abbastanza per ogni incapsulamento reale, e un tetto contro i cicli. */
        static final int PROFONDITA_MASSIMA_DELLE_CAUSE = 8;

        /**
         * Ciò che il SISTEMA dice di un guasto del Keystore: le due risposte di `android.security.KeyStoreException` (API 33+) su cui si decide,
         * ridotte a due booleani. Così la logica pura ({@link #eTransitorio}, {@link #eDaEliminare}) non nomina `android.*`, e la prova la JVM,
         * dove una `KeyStoreException` non si può costruire. Un verdetto c'è solo se nella catena delle cause c'è una `KeyStoreException`;
         * altrimenti il sistema non ha detto niente (`null`).
         *  · `passeggero` — `isTransientFailure()`: riprovare più tardi può riuscire.
         *  · `erroreDiSistema` — `isSystemError()`: l'errore è del Keystore o di KeyMint, non di QUELLA chiave. Per la documentazione di AOSP gli
         *    errori di sistema indicano «a feature isn't working», mentre quelli della chiave «are likely to succeed with a new key»
         *    (KeyStoreException.java:366-373): una chiave nuova non risolve un errore di sistema. Non implica `passeggero`: SYSTEM_ERROR, che è
         *    ciò che esce dopo una connessione persa col demone (KeyStore2.java:122-124), ha `isSystemError()` vero e `isTransientFailure()`
         *    FALSO (KeyStoreException.java:666-668). Un verdetto che guardasse solo `passeggero` lo scambierebbe per un guasto della chiave.
         */
        static final class Verdetto {
            final boolean passeggero;
            final boolean erroreDiSistema;

            Verdetto(boolean passeggero, boolean erroreDiSistema) {
                this.passeggero = passeggero;
                this.erroreDiSistema = erroreDiSistema;
            }

            /**
             * Il guasto è DELLA CHIAVE: né passeggero né di sistema. È l'unico caso in cui il sistema stesso dice che una chiave nuova è la via
             * (KeyStoreException.java:334-336); per tutto il resto la chiave si lascia dov'è, e un errore di sistema si aspetta.
             */
            boolean eDellaChiave() {
                return !passeggero && !erroreDiSistema;
            }
        }

        /**
         * Il guasto è passeggero? I CRITERI (secondari n. 79, n. 153 e n. 154), nell'ordine:
         *  1. un guasto DEFINITIVO in un punto qualunque della catena delle cause vince su tutto, anche sul verdetto del sistema: chiave
         *     invalidata (`KeyPermanentlyInvalidatedException`), contenuto toccato o cifrato con un'altra chiave (`BadPaddingException`, di
         *     cui `AEADBadTagException` è figlia);
         *  2. `UnrecoverableKeyException` (chiave non recuperabile) e `IllegalBlockSizeException` (misura sbagliata) sono definitive come TIPO,
         *     ma su keystore2 sono anche i CONTENITORI in cui il sistema avvolge ogni errore del Keystore, passeggeri e di sistema compresi
         *     (un'operazione potata, il servizio occupato, la connessione persa col demone). Prima di API 33 non c'è un verdetto a cui chiedere, e
         *     valgono «definitivo»; da API 33 cedono al verdetto del punto 3 se nella catena ce n'è uno (senza, restano definitive).
         *     `InvalidKeyException`, che all'init avvolge lo stesso guasto, NON è in elenco: da API 33 decide il verdetto, prima il punto 4; la
         *     sua figlia `KeyPermanentlyInvalidatedException` è al punto 1;
         *  3. da API 33, se nella catena c'è una `android.security.KeyStoreException`, decide LEI, con le sue due risposte ({@link Verdetto}):
         *     il guasto è passeggero se `isTransientFailure()` OPPURE `isSystemError()`. Un errore di sistema non è un guasto della chiave, e la
         *     voce aspetta: è il caso di SYSTEM_ERROR dopo una connessione persa col demone, che `getKey` avvolge in un
         *     `UnrecoverableKeyException` (AndroidKeyStoreProvider.java:414-417) e per cui `isTransientFailure()` è FALSO
         *     (KeyStoreException.java:666-668). Il «no» vale solo quando sono false tutte e due (una chiave corrotta o inesistente dentro un
         *     `ProviderException` non diventa passeggera);
         *  4. altrimenti (API 24-32, o nessuna `KeyStoreException`): è passeggero un errore di I/O (`IOException`, per esempio l'apertura
         *     dell'archivio delle chiavi), un `ProviderException`, che è ciò che il provider lancia quando un'operazione non riesce (troppe
         *     operazioni aperte, servizio occupato) e non per una chiave cattiva, o l'`IllegalStateException` con cui il sistema dice che il
         *     servizio del Keystore non c'è ({@link #eKeystoreIrraggiungibile}) — sempre che nella catena non ci sia uno dei contenitori del
         *     punto 2, che senza un verdetto restano definitivi;
         *  5. tutto il resto è definitivo.
         */
        @Override
        public boolean guastoTransitorio(Throwable guasto) {
            return eTransitorio(guasto, Build.VERSION.SDK_INT, CifrarioKeystore::verdettoDiProduzione);
        }

        /** La logica del punto precedente, senza `android.*` tranne i tipi delle eccezioni: la prova la JVM (`verdetto` e `sdk` si iniettano). */
        static boolean eTransitorio(Throwable guasto, int sdk, Function<Throwable, Verdetto> verdetto) {
            boolean passeggero = false;
            boolean contenitoreDefinitivo = false;
            int profondita = 0;
            for (Throwable causa = guasto; causa != null && profondita < PROFONDITA_MASSIMA_DELLE_CAUSE; causa = causa.getCause(), profondita++) {
                // Punto 1: i definitivi che nessun verdetto riabilita.
                if (causa instanceof KeyPermanentlyInvalidatedException || causa instanceof BadPaddingException) return false;
                // Punto 2: i contenitori. Prima di API 33 nessun verdetto: definitivi, come sempre.
                if (causa instanceof UnrecoverableKeyException || causa instanceof IllegalBlockSizeException) {
                    if (sdk < API_CON_VERDETTO) return false;
                    contenitoreDefinitivo = true;
                }
                if (causa instanceof IOException || causa instanceof ProviderException || eKeystoreIrraggiungibile(causa)) passeggero = true;
            }
            // Punto 3: da API 33, se il sistema ha detto la sua, ha deciso lui: passeggero, o di sistema (non è la chiave: la voce aspetta).
            Verdetto delSistema = sdk >= API_CON_VERDETTO ? verdettoNellaCatena(guasto, verdetto) : null;
            if (delSistema != null) return !delSistema.eDellaChiave();
            // Punti 4 e 5.
            return passeggero && !contenitoreDefinitivo;
        }

        /**
         * Il Keystore non c'è: l'`IllegalStateException` con cui `KeyStore2.getService` dice che il servizio `IKeystoreService` non si trova,
         * «Could not connect to Keystore service. Keystore may have crashed or not been initialized» (KeyStore2.java:148-157). A differenza
         * degli altri guasti del Keystore arriva NUDA: nessun tipo suo, nessuna causa, nessuna `KeyStoreException` con un verdetto, e `getKey` non
         * la avvolge. Non dice niente della chiave — il servizio non risponde — e riprovare fra poco può riuscire. Un tipo da confrontare non
         * c'è (è un'`IllegalStateException` come tante) e il messaggio è l'unico segno, che si confronta così: il TIPO deve essere quello, e il
         * messaggio, portato in minuscolo con `Locale.ROOT` (mai con la lingua del telefono), deve nominare insieme il verbo «connect» e il
         * «keystore», con qualunque maiuscola, spazio o coda (non si pretende «could not», né «service», né «crashed»): il testo sta nel
         * sistema, non nel nostro codice, e una piccola riformulazione non deve far chiudere un video per un guasto che passa. Senza messaggio, o
         * con un altro, non lo è: un'`IllegalStateException` qualunque resta definitiva. Il messaggio si CONFRONTA soltanto: non si registra né
         * si restituisce.
         */
        static boolean eKeystoreIrraggiungibile(Throwable causa) {
            if (!(causa instanceof IllegalStateException)) return false;
            String messaggio = causa.getMessage();
            if (messaggio == null) return false;
            String minuscolo = messaggio.toLowerCase(Locale.ROOT);
            return minuscolo.contains("connect") && minuscolo.contains("keystore");
        }

        /**
         * Il verdetto del sistema sulla catena delle cause: quello della PRIMA causa che ne ha uno (una `KeyStoreException`), `null` se nessuna
         * ce l'ha. Con lo stesso tetto di profondità di {@link #eTransitorio}. Il chiamante lo chiede solo da API 33.
         */
        static Verdetto verdettoNellaCatena(Throwable guasto, Function<Throwable, Verdetto> verdetto) {
            int profondita = 0;
            for (Throwable causa = guasto; causa != null && profondita < PROFONDITA_MASSIMA_DELLE_CAUSE; causa = causa.getCause(), profondita++) {
                Verdetto delSistema = verdetto.apply(causa);
                if (delSistema != null) return delSistema;
            }
            return null;
        }

        /** Il verdetto di produzione: da API 33 quello di `KeyStoreException` (le sue due risposte), prima nessuno. */
        private static Verdetto verdettoDiProduzione(Throwable causa) {
            return Build.VERSION.SDK_INT >= API_CON_VERDETTO ? VerdettoApi33.su(causa) : null;
        }

        /**
         * La chiave che `getKey` non restituisce (`UnrecoverableKeyException`) si ELIMINA, per crearne una nuova? (secondario n. 154 e seguito)
         * Eliminarla rende ILLEGGIBILI i segreti di tutte le voci vive: si fa solo quando è l'unica via, cioè per un guasto DELLA CHIAVE. Un
         * guasto del sistema non si risolve con una chiave nuova (KeyStoreException.java:366-373): la chiave resta dov'è, e il guasto torna a
         * chi chiama.
         *  · `perCifrare` falso, cioè si sta DECIFRANDO un segreto già scritto: MAI. Si rilancia, e decide chi chiama con
         *    {@link #guastoTransitorio}: eliminare la chiave non farebbe leggere quel segreto, e per un guasto che passa, o del sistema,
         *    distruggerebbe quelli di tutti gli altri;
         *  · `perCifrare` vero, da API 33: decide il verdetto del sistema ({@link Verdetto}). Una `KeyStoreException` nella catena che dice
         *    `isTransientFailure()` OPPURE `isSystemError()` vuol dire che il guasto NON è della chiave — un servizio che si riavvia, una
         *    connessione persa col demone (SYSTEM_ERROR: di sistema ma NON passeggero, KeyStoreException.java:666-668): si rilancia senza
         *    eliminare. Si elimina e si ricrea solo se il verdetto dice «né passeggero né di sistema», oppure se manca (l'invalidazione
         *    permanente arriva come un `UnrecoverableKeyException` col solo messaggio, senza causa: AndroidKeyStoreSpi.java:126-127): è un
         *    guasto della chiave, e il motore non potrebbe più accodare niente;
         *  · `perCifrare` vero, API 24-32: il sistema non dà un verdetto, e vale il comportamento di sempre: si elimina e si ricrea.
         * Pura come {@link #eTransitorio}: la prova la JVM (`sdk` e `verdetto` si iniettano).
         */
        static boolean eDaEliminare(boolean perCifrare, Throwable guasto, int sdk, Function<Throwable, Verdetto> verdetto) {
            if (!perCifrare) return false;
            if (sdk < API_CON_VERDETTO) return true;
            Verdetto delSistema = verdettoNellaCatena(guasto, verdetto);
            return delSistema == null || delSistema.eDellaChiave();
        }

        /** L'eliminazione della chiave dall'archivio: `deleteEntry` in produzione, un finto nei test. */
        interface Eliminazione {
            void esegui() throws GeneralSecurityException;
        }

        /**
         * Che cosa si fa di una chiave che `getKey` non restituisce: la decisione è di {@link #eDaEliminare}, e UNA riga `warn` in logcat dice
         * che cosa si fa, in tutti e due i rami (regola 6 di AGENTS.md: un `catch` che non dice niente è un guasto che nessuno vedrà). Nel ramo
         * «si elimina» la riga è scritta PRIMA dell'eliminazione, e perciò dice che ci si PROVA: se `deleteEntry` fallisce il suo guasto esce a
         * chi chiama, e una riga che affermasse «si elimina» avrebbe detto il falso. Solo la CLASSE dell'eccezione e quella della sua causa, e
         * il livello di API: mai l'alias, mai un percorso, mai il messaggio. Se la chiave non si elimina il guasto si RILANCIA tale e quale:
         * se si proseguisse, il chiamante genererebbe una chiave nuova sullo stesso alias, che nel Keystore la sostituisce — lo stesso
         * disastro per un'altra strada.
         */
        static void trattaLaChiaveInutilizzabile(UnrecoverableKeyException guasto, boolean perCifrare, int sdk, Function<Throwable, Verdetto> verdetto,
                Eliminazione elimina) throws GeneralSecurityException {
            String fase = perCifrare ? "in scrittura" : "in lettura";
            if (!eDaEliminare(perCifrare, guasto, sdk, verdetto)) {
                DiagnosticaLocale.avviso("chiave dei segreti non utilizzabile " + fase + " (" + descrivi(guasto, sdk) + "): non si elimina, il guasto torna a chi chiama");
                throw guasto;
            }
            DiagnosticaLocale.avviso("chiave dei segreti non utilizzabile " + fase + " (" + descrivi(guasto, sdk) + "): guasto permanente, si prova a eliminare la chiave e a crearne una nuova (se riesce, i segreti già salvati diventano illeggibili)");
            elimina.esegui();
        }

        /** «UnrecoverableKeyException, causa: KeyStoreException, API 34»: solo classi e un numero, mai un messaggio. */
        private static String descrivi(Throwable guasto, int sdk) {
            return DiagnosticaLocale.classe(guasto) + ", causa: " + DiagnosticaLocale.classe(guasto.getCause()) + ", API " + sdk;
        }

        /**
         * Il verdetto del sistema (API 33+) su una causa, in una classe a parte: `KeyStoreException` pubblica esiste solo da API 33, e così
         * la classe del cifrario non ne porta il riferimento sui livelli più vecchi (si carica solo quando `sdk >= 33`).
         */
        @RequiresApi(API_CON_VERDETTO)
        private static final class VerdettoApi33 {
            /**
             * `null` se `causa` non è una `KeyStoreException`; altrimenti le sue due risposte, `isTransientFailure()` e `isSystemError()`, ciascuna
             * nella sua variabile. L'ordine degli argomenti di {@link Verdetto} non lo prova nessun test sulla JVM, che una `KeyStoreException`
             * non la costruisce: per questo le due risposte stanno ciascuna in una variabile col suo nome.
             */
            static Verdetto su(Throwable causa) {
                if (!(causa instanceof android.security.KeyStoreException)) return null;
                android.security.KeyStoreException delSistema = (android.security.KeyStoreException) causa;
                boolean passeggero = delSistema.isTransientFailure();
                boolean erroreDiSistema = delSistema.isSystemError();
                return new Verdetto(passeggero, erroreDiSistema);
            }
        }

        @Override
        public byte[] cifra(byte[] chiaro, byte[] datiAssociati) throws GeneralSecurityException, IOException {
            Cipher cifrario = Cipher.getInstance(TRASFORMAZIONE);
            cifrario.init(Cipher.ENCRYPT_MODE, fornitore.chiave(true));
            cifrario.updateAAD(datiAssociati);
            byte[] iv = cifrario.getIV();
            byte[] testoCifrato = cifrario.doFinal(chiaro);
            if (iv == null || iv.length == 0 || iv.length > 255) throw new GeneralSecurityException("IV fuori misura");
            byte[] risultato = new byte[1 + iv.length + testoCifrato.length];
            risultato[0] = (byte) iv.length;
            System.arraycopy(iv, 0, risultato, 1, iv.length);
            System.arraycopy(testoCifrato, 0, risultato, 1 + iv.length, testoCifrato.length);
            return risultato;
        }

        @Override
        public byte[] decifra(byte[] cifrato, byte[] datiAssociati) throws GeneralSecurityException, IOException {
            if (cifrato.length < 2) throw new GeneralSecurityException("blocco troppo corto");
            int lunghezzaIv = cifrato[0] & 0xFF;
            if (lunghezzaIv == 0 || cifrato.length < 1 + lunghezzaIv + 1) throw new GeneralSecurityException("blocco malformato");
            Cipher cifrario = Cipher.getInstance(TRASFORMAZIONE);
            cifrario.init(Cipher.DECRYPT_MODE, fornitore.chiave(false), new GCMParameterSpec(BIT_DEL_TAG, cifrato, 1, lunghezzaIv));
            cifrario.updateAAD(datiAssociati);
            return cifrario.doFinal(cifrato, 1 + lunghezzaIv, cifrato.length - 1 - lunghezzaIv);
        }

        /**
         * La chiave `alias` dell'AndroidKeyStore, creata se non c'è. `perCifrare`: serve per scrivere un segreto nuovo (vero) o per leggerne uno
         * già scritto (falso). Se `getKey` lancia `UnrecoverableKeyException` la chiave si elimina solo per cifrare e solo per un guasto della
         * chiave (non passeggero e non del sistema: {@link #eDaEliminare}); altrimenti l'eccezione esce da qui tale e quale
         * ({@link #trattaLaChiaveInutilizzabile}), e di qui NON si prosegue con la generazione: una chiave nuova sullo stesso alias
         * sostituirebbe quella vecchia, e sarebbe l'eliminazione per un'altra strada.
         */
        private SecretKey chiave(boolean perCifrare) throws GeneralSecurityException, IOException {
            KeyStore keystore = KeyStore.getInstance(PROVIDER);
            keystore.load(null);
            try {
                Key esistente = keystore.getKey(alias, null);
                if (esistente instanceof SecretKey) return (SecretKey) esistente;
            } catch (UnrecoverableKeyException inutilizzabile) {
                trattaLaChiaveInutilizzabile(inutilizzabile, perCifrare, Build.VERSION.SDK_INT, CifrarioKeystore::verdettoDiProduzione,
                        () -> keystore.deleteEntry(alias));
            }
            KeyGenerator generatore = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER);
            generatore.init(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build());
            return generatore.generateKey();
        }
    }
}
