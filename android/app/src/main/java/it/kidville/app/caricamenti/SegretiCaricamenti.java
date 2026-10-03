package it.kidville.app.caricamenti;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

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
import java.security.UnrecoverableKeyException;
import java.util.function.Function;
import java.util.function.UnaryOperator;

import javax.crypto.Cipher;
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
 *  · NESSUN LOG qui, e niente nelle eccezioni: un segreto che non si decifra è il VALORE `ILLEGGIBILE`, e il chiamante lo porta nel
 *    registro come `video-nativo-fallito INTERNO`. Mai il contenuto, mai un percorso, mai il messaggio di un'eccezione.
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
         * Il file c'è ma non si legge: toccato, di un'altra versione, di un altro job, cifrato con una chiave che il Keystore non ha più,
         * o con una forma sbagliata. Vale come «segreti persi»: la voce non può più né rinnovare né spedire.
         */
        ILLEGGIBILE
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

    /** Legge i segreti di un job. Non lancia mai: il guasto è un valore (`ILLEGGIBILE`). */
    public synchronized Lettura leggi(String jobId) {
        File file = coda.fileSegreto(jobId);
        byte[] contenuto;
        try {
            contenuto = aperturaFile.apply(file).readFully();
        } catch (FileNotFoundException assente) {
            return LETTURA_ASSENTE;
        } catch (IOException | RuntimeException nonLeggibile) {
            return LETTURA_ILLEGGIBILE;
        }
        if (contenuto.length < 2 || contenuto[0] != (byte) VERSIONE_FILE) return LETTURA_ILLEGGIBILE;
        byte[] cifrato = new byte[contenuto.length - 1];
        System.arraycopy(contenuto, 1, cifrato, 0, cifrato.length);
        try {
            byte[] chiaro = cifrario.decifra(cifrato, datiAssociati(jobId));
            Segreti segreti = daJson(new JSONObject(new String(chiaro, StandardCharsets.UTF_8)));
            return segreti == null ? LETTURA_ILLEGGIBILE : new Lettura(Esito.OK, segreti);
        } catch (GeneralSecurityException | IOException | JSONException | RuntimeException nonDecifrabile) {
            // Il motivo non si dice: un messaggio d'eccezione può portare un pezzo di contenuto, e il chiamante non sa che farsene.
            return LETTURA_ILLEGGIBILE;
        }
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
     * un Keystore danneggiato) la si ELIMINA e se ne crea una nuova: i file cifrati con la vecchia diventano `ILLEGGIBILE` — lo
     * erano già — ma i nuovi segreti si possono di nuovo scrivere; senza questo il motore non potrebbe più accodare niente.
     */
    public static final class CifrarioKeystore implements Cifrario {
        private static final String PROVIDER = "AndroidKeyStore";
        private static final String TRASFORMAZIONE = "AES/GCM/NoPadding";
        private static final int BIT_DEL_TAG = 128;

        private final String alias;

        public CifrarioKeystore() {
            this(ALIAS_CHIAVE);
        }

        CifrarioKeystore(String alias) {
            this.alias = alias;
        }

        @Override
        public byte[] cifra(byte[] chiaro, byte[] datiAssociati) throws GeneralSecurityException, IOException {
            Cipher cifrario = Cipher.getInstance(TRASFORMAZIONE);
            cifrario.init(Cipher.ENCRYPT_MODE, chiave());
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
            cifrario.init(Cipher.DECRYPT_MODE, chiave(), new GCMParameterSpec(BIT_DEL_TAG, cifrato, 1, lunghezzaIv));
            cifrario.updateAAD(datiAssociati);
            return cifrario.doFinal(cifrato, 1 + lunghezzaIv, cifrato.length - 1 - lunghezzaIv);
        }

        private SecretKey chiave() throws GeneralSecurityException, IOException {
            KeyStore keystore = KeyStore.getInstance(PROVIDER);
            keystore.load(null);
            try {
                Key esistente = keystore.getKey(alias, null);
                if (esistente instanceof SecretKey) return (SecretKey) esistente;
            } catch (UnrecoverableKeyException inutilizzabile) {
                keystore.deleteEntry(alias);
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
