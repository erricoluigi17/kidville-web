package it.kidville.app.caricamenti;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.util.Log;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import it.kidville.app.BuildConfig;
import it.kidville.app.caricamenti.PianificatoreCaricamenti.CodiceRifiuto;
import it.kidville.app.caricamenti.PianificatoreCaricamenti.RifiutoAccodamento;
import it.kidville.app.caricamenti.SelettoreMedia.ElementoSorgente;
import it.kidville.app.caricamenti.SelettoreMedia.Opzioni;
import it.kidville.app.caricamenti.SelettoreMedia.Preparati;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

/**
 * LA FACCIATA DEL PLUGIN `KidvilleCaricamenti` PER ANDROID: il ponte fra il JavaScript e il motore dei caricamenti nativi.
 * (spec 2026-10-03 «app 1.2: caricamenti nativi in background», §4.1 «un plugin solo, nostro, locale», §4.2, §4.3, §6.5, §7.1; compito A3)
 *
 * ─── CHE COSA È ──────────────────────────────────────────────────────────────────────────────
 * Una facciata SOTTILE: legge i parametri, chiama chi sa fare (`SelettoreMedia` per scegliere, preparare e consegnare i media;
 * `PianificatoreCaricamenti` per la coda, l'invio e lo stato) e traduce il risultato in JSON e i rifiuti in un codice dell'elenco chiuso.
 * Il motore è un singolo indipendente dal ponte: gira anche quando questa classe non esiste (app chiusa, guscio avviato dal sistema); il
 * ponte si limita a chiamarlo e a inoltrare i suoi eventi al JavaScript.
 *
 * ─── I METODI (identici a `METODI_PLUGIN_CARICAMENTI` di `caricamenti-nativi-tipi.ts`, che il lock di J4 e JUnit confrontano) ──────────
 * `info`, `scegliMedia`, `annullaScelta`, `leggiFoto`, `scartaScelti`, `accodaVideo`, `elenco`, `annulla`, `dimentica`. In più
 * `creaElementoDiProva`, che esiste SOLO nelle build Debug (`BuildConfig.DEBUG`: nelle build di rilascio risponde «non implementato») e
 * non sta nell'elenco del contratto: serve al collaudo del motore (C1). Gli eventi sono `preparazione` e `caricamento`.
 *
 * ─── COME È FATTA ────────────────────────────────────────────────────────────────────────────
 *  · REGISTRATA IN `MainActivity.onCreate`, PRIMA di `super.onCreate`: è un plugin locale, non un pacchetto npm, e non passa da
 *    `capacitor.plugins.json` né da `npx cap sync` (che qui non si lancia mai).
 *  · `scegliMedia` NON BLOCCA IL FILO DEI PLUGIN. Capacitor esegue i metodi di TUTTI i plugin su un solo thread: copiare un video da 2 GB
 *    lì dentro fermerebbe le notifiche, la sessione, le altre chiamate. Il metodo lancia il selettore di sistema
 *    (`startActivityForResult` + `@ActivityCallback`: Capacitor conserva la chiamata se l'Activity viene ricreata) e torna; quando il
 *    selettore si chiude la preparazione gira su un thread suo e la chiamata si risolve alla fine, con gli elementi già pronti.
 *  · UNA SCELTA ALLA VOLTA (`GIA_IN_CORSO`), e lo stato è del PROCESSO: un'Activity ricreata mentre il selettore è aperto ritrova la
 *    sua scelta. Una scelta rimasta aperta da più di un quarto d'ora senza preparare niente è considerata abbandonata, così un risultato
 *    mai arrivato non spegne il selettore fino al riavvio.
 *  · I RIFIUTI SONO CODICI (`CODICI_RIFIUTO_PONTE`) con per messaggio il codice stesso: mai un percorso, un indirizzo o il messaggio di
 *    un'eccezione. Il JavaScript traduce il codice, non legge il testo.
 *  · NESSUN NOME, NESSUN INDIRIZZO NEI LOG: `Log.e` con la sola CLASSE dell'eccezione. Gli eventi che il JavaScript deve poter leggere
 *    nel database passano da `RegistroNativo`, non da qui.
 *  · NON SI NOMINA L'ARCHIVIO DEI COOKIE, e non si inietta codice nella pagina: le chiamate native non usano la sessione della WebView
 *    (lo pretende il lock `cookie-sessione-persistito-android`, che scandisce tutti i sorgenti Java dell'app).
 */
@CapacitorPlugin(name = "KidvilleCaricamenti")
public class KidvilleCaricamentiPlugin extends Plugin {

    private static final String TAG = "KidvilleCaricamenti";

    /** La versione del protocollo fra JS e nativo (`PROTOCOLLO_CARICAMENTI`): `info()` la restituisce, l'involucro rifiuta una diversa. */
    static final int PROTOCOLLO = 1;
    static final String EVENTO_PREPARAZIONE = "preparazione";
    static final String EVENTO_CARICAMENTO = "caricamento";

    /**
     * I `code` con cui il ponte rifiuta una chiamata: l'elenco chiuso `CODICI_RIFIUTO_PONTE` di `caricamenti-nativi-tipi.ts`, che un test
     * confronta con questo. Il messaggio che li accompagna è il codice stesso.
     */
    enum Rifiuto {
        GIA_IN_CORSO,
        SELETTORE_NON_DISPONIBILE,
        PARAMETRI_NON_VALIDI,
        ELEMENTO_ASSENTE,
        ELEMENTO_DIVERSO,
        HOST_NON_AMMESSO,
        INTERNO;

        /** I cinque codici con cui il motore rifiuta `accodaVideo` sono un sottoinsieme di questi, con gli stessi nomi. */
        static Rifiuto da(CodiceRifiuto dalMotore) {
            return valueOf(dalMotore.name());
        }
    }

    private static void rifiuta(PluginCall chiamata, Rifiuto rifiuto) {
        chiamata.reject(rifiuto.name(), rifiuto.name());
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL MOTORE E I SUOI EVENTI
     * ──────────────────────────────────────────────────────────────────────────── */

    private PianificatoreCaricamenti motore() {
        return PianificatoreCaricamenti.condiviso(getContext());
    }

    /** Ogni cambiamento di una voce della coda, dal motore al JavaScript (evento `caricamento`). Dal thread che lo ha prodotto. */
    private final PianificatoreCaricamenti.OsservatoreCaricamenti osservatore = this::inoltraCaricamento;

    private void inoltraCaricamento(JSONObject voce) {
        try {
            notifyListeners(EVENTO_CARICAMENTO, JSObject.fromJSONObject(voce));
        } catch (JSONException | RuntimeException guasto) {
            Log.w(TAG, "evento di caricamento non inoltrato (" + guasto.getClass().getSimpleName() + ")");
        }
    }

    /** L'avanzamento della preparazione, dal selettore al JavaScript (evento `preparazione`). */
    private void inoltraPreparazione(JSONObject evento) {
        try {
            notifyListeners(EVENTO_PREPARAZIONE, JSObject.fromJSONObject(evento));
        } catch (JSONException | RuntimeException guasto) {
            Log.w(TAG, "evento di preparazione non inoltrato (" + guasto.getClass().getSimpleName() + ")");
        }
    }

    @Override
    public void load() {
        try {
            motore().aggiungiOsservatore(osservatore);
        } catch (RuntimeException guasto) {
            Log.e(TAG, "avvio del motore dei caricamenti non riuscito (" + guasto.getClass().getSimpleName() + ")");
        }
    }

    @Override
    protected void handleOnDestroy() {
        try {
            motore().rimuoviOsservatore(osservatore);
        } catch (RuntimeException guasto) {
            Log.e(TAG, "congedo dal motore dei caricamenti non riuscito (" + guasto.getClass().getSimpleName() + ")");
        }
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * info
     * ──────────────────────────────────────────────────────────────────────────── */

    /** Protocollo, piattaforma, motore. Non tocca disco né rete (il motore si decide dal livello di API, senza crearlo). */
    @PluginMethod
    public void info(PluginCall call) {
        JSObject risposta = new JSObject();
        risposta.put("protocollo", PROTOCOLLO);
        risposta.put("piattaforma", "android");
        risposta.put("motore", PianificatoreCaricamenti.motorePer(Build.VERSION.SDK_INT).valore());
        call.resolve(risposta);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * scegliMedia, annullaScelta
     * ──────────────────────────────────────────────────────────────────────────── */

    /** La scelta in corso: la chiamata del JavaScript, il suo interruttore di annullamento, e da quando è aperta. */
    private static final class StatoScelta {
        final PluginCall chiamata;
        final SelettoreMedia.Cancellazione cancellazione = new SelettoreMedia.Cancellazione();
        final long apertaIl = SystemClock.elapsedRealtime();
        volatile boolean inPreparazione;

        StatoScelta(PluginCall chiamata) {
            this.chiamata = chiamata;
        }
    }

    private static final AtomicReference<StatoScelta> SCELTA_IN_CORSO = new AtomicReference<>();

    private static void chiudi(StatoScelta stato) {
        SCELTA_IN_CORSO.compareAndSet(stato, null);
    }

    /**
     * Apre il selettore di sistema. Risolve alla fine della PREPARAZIONE (non alla chiusura del selettore): `{ annullato, elementi }`, con
     * gli elementi già pronti (video copiati con `sha256`, foto ridotte, rifiutati col motivo). Rifiuti: `PARAMETRI_NON_VALIDI`,
     * `GIA_IN_CORSO`, `SELETTORE_NON_DISPONIBILE`, `INTERNO`.
     */
    @PluginMethod
    public void scegliMedia(PluginCall call) {
        final Opzioni opzioni;
        try {
            opzioni = Opzioni.da(call.getData());
        } catch (SelettoreMedia.OpzioniNonValide nonValide) {
            rifiuta(call, Rifiuto.PARAMETRI_NON_VALIDI);
            return;
        }
        StatoScelta precedente = SCELTA_IN_CORSO.get();
        if (precedente != null && SelettoreMedia.sceltaAbbandonata(precedente.inPreparazione,
                SystemClock.elapsedRealtime() - precedente.apertaIl)) {
            chiudi(precedente);
        }
        StatoScelta nuova = new StatoScelta(call);
        if (!SCELTA_IN_CORSO.compareAndSet(null, nuova)) {
            rifiuta(call, Rifiuto.GIA_IN_CORSO);
            return;
        }
        try {
            Intent intent = SelettoreMedia.creaIntent(getContext(), opzioni.sorgente, opzioni.massimoElementi);
            startActivityForResult(call, intent, "risultatoSelettore");
        } catch (ActivityNotFoundException | SecurityException nonDisponibile) {
            chiudi(nuova);
            rifiuta(call, Rifiuto.SELETTORE_NON_DISPONIBILE);
        } catch (RuntimeException guasto) {
            chiudi(nuova);
            Log.e(TAG, "apertura del selettore non riuscita (" + guasto.getClass().getSimpleName() + ")");
            rifiuta(call, Rifiuto.INTERNO);
        }
    }

    /**
     * Il selettore di sistema si è chiuso. Capacitor invoca questo metodo con la chiamata salvata: dopo un'Activity ricreata è un oggetto
     * nuovo, e le opzioni si rileggono da lì invece che da campi del plugin.
     */
    @ActivityCallback
    private void risultatoSelettore(PluginCall call, ActivityResult risultato) {
        if (call == null) {
            // La chiamata non si ritrova (processo ripartito): non c'è nessuno a cui rispondere, ma lo stato non deve restare chiuso.
            SCELTA_IN_CORSO.set(null);
            Log.e(TAG, "risultato del selettore senza chiamata");
            return;
        }
        StatoScelta stato = SCELTA_IN_CORSO.get();
        if (stato == null || stato.chiamata != call) {
            stato = new StatoScelta(call);
            SCELTA_IN_CORSO.set(stato);
        }
        final StatoScelta questa = stato;
        final Opzioni opzioni;
        try {
            opzioni = Opzioni.da(call.getData());
        } catch (SelettoreMedia.OpzioniNonValide nonValide) {
            chiudi(questa);
            rifiuta(call, Rifiuto.PARAMETRI_NON_VALIDI);
            return;
        }
        final List<Uri> scelti = risultato != null && risultato.getResultCode() == Activity.RESULT_OK
                ? SelettoreMedia.estraiUri(risultato.getData(), opzioni.massimoElementi) : Collections.<Uri>emptyList();
        if (scelti.isEmpty() || questa.cancellazione.annullata()) {
            chiudi(questa);
            call.resolve(comeJSObject(SelettoreMedia.Esito.annullato().aJson()));
            return;
        }
        questa.inPreparazione = true;
        try {
            SelettoreMedia.esecutore().execute(() -> preparaERisolvi(questa, call, opzioni, scelti));
        } catch (RuntimeException nonAccodato) {
            chiudi(questa);
            Log.e(TAG, "avvio della preparazione non riuscito (" + nonAccodato.getClass().getSimpleName() + ")");
            rifiuta(call, Rifiuto.INTERNO);
        }
    }

    /** Su un thread di lavoro: prepara gli elementi, risolve la chiamata, libera lo stato. Mai un'eccezione fuori di qui. */
    private void preparaERisolvi(StatoScelta stato, PluginCall call, Opzioni opzioni, List<Uri> scelti) {
        try {
            List<ElementoSorgente> sorgenti = new ArrayList<>();
            for (Uri uri : scelti) sorgenti.add(new SelettoreMedia.ElementoDaUri(getContext(), uri));
            File cartellaScelti = motore().coda().cartellaScelti();
            SelettoreMedia.Preparazione preparazione = new SelettoreMedia.Preparazione(cartellaScelti, Preparati.PROCESSO,
                    new SelettoreMedia.StrumentiAndroid(getContext()), opzioni, stato.cancellazione, this::inoltraPreparazione);
            call.resolve(comeJSObject(preparazione.esegui(sorgenti).aJson()));
        } catch (Throwable guasto) {
            // `Throwable`: l'unico modo di non lasciare una chiamata appesa per sempre è rispondere comunque.
            Log.e(TAG, "preparazione dei media non riuscita (" + guasto.getClass().getSimpleName() + ")");
            rifiuta(call, Rifiuto.INTERNO);
        } finally {
            chiudi(stato);
        }
    }

    /** `JSONObject` → `JSObject`, per `resolve` e `notifyListeners`. */
    private static JSObject comeJSObject(JSONObject json) {
        try {
            return JSObject.fromJSONObject(json);
        } catch (JSONException impossibile) {
            throw new IllegalStateException("risposta non convertibile per il ponte", impossibile);
        }
    }

    /**
     * Ferma la preparazione in corso: la copia lo vede al blocco successivo, cancella le copie parziali e quelle già pronte, e `scegliMedia`
     * risolve con `annullato: true`. Se il selettore di sistema è ancora aperto, la scelta viene scartata alla sua chiusura.
     */
    @PluginMethod
    public void annullaScelta(PluginCall call) {
        StatoScelta stato = SCELTA_IN_CORSO.get();
        JSObject risposta = new JSObject();
        if (stato == null) {
            risposta.put("annullata", false);
        } else {
            stato.cancellazione.annulla();
            risposta.put("annullata", true);
        }
        call.resolve(risposta);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * leggiFoto, scartaScelti
     * ──────────────────────────────────────────────────────────────────────────── */

    /** La foto preparata in base64, UNA volta sola (poi il file si cancella). Rifiuti: `ELEMENTO_ASSENTE`, `INTERNO`. */
    @PluginMethod
    public void leggiFoto(PluginCall call) {
        try {
            call.resolve(comeJSObject(SelettoreMedia.leggiFoto(Preparati.PROCESSO, call.getString("id"))));
        } catch (SelettoreMedia.ElementoAssente assente) {
            rifiuta(call, Rifiuto.ELEMENTO_ASSENTE);
        } catch (IOException | RuntimeException guasto) {
            Log.e(TAG, "lettura della foto non riuscita (" + guasto.getClass().getSimpleName() + ")");
            rifiuta(call, Rifiuto.INTERNO);
        }
    }

    /** Cancella i preparati non inviati (tolti dall'anteprima, «Annulla» al passo dei bambini, smontaggio). */
    @PluginMethod
    public void scartaScelti(PluginCall call) {
        try {
            int eliminati = SelettoreMedia.scarta(Preparati.PROCESSO, motore().coda().cartellaScelti(), testi(call.getData().optJSONArray("ids")));
            JSObject risposta = new JSObject();
            risposta.put("eliminati", eliminati);
            call.resolve(risposta);
        } catch (RuntimeException guasto) {
            Log.e(TAG, "scarto dei preparati non riuscito (" + guasto.getClass().getSimpleName() + ")");
            rifiuta(call, Rifiuto.INTERNO);
        }
    }

    /** Gli elementi stringa di un array JSON, nell'ordine; ignora ciò che non è una stringa. `null` e array assente valgono vuoto. */
    private static List<String> testi(JSONArray array) {
        List<String> elenco = new ArrayList<>();
        if (array == null) return elenco;
        for (int i = 0; i < array.length(); i++) {
            Object voce = array.opt(i);
            if (voce instanceof String) elenco.add((String) voce);
        }
        return elenco;
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * accodaVideo, elenco, annulla, dimentica
     * ──────────────────────────────────────────────────────────────────────────── */

    /**
     * Prende in carico un video preparato: lo confronta con l'elemento, controlla gli host, lo sposta in `file/`, salva i segreti e crea il
     * trasferimento. Idempotente su `jobId`. Risolve con la voce nella forma di `CaricamentoNativo`. Rifiuti: `ELEMENTO_ASSENTE`,
     * `ELEMENTO_DIVERSO`, `HOST_NON_AMMESSO`, `PARAMETRI_NON_VALIDI`, `INTERNO`.
     */
    @PluginMethod
    public void accodaVideo(PluginCall call) {
        try {
            call.resolve(comeJSObject(SelettoreMedia.accodaPreparato(motore(), Preparati.PROCESSO, call.getData())));
        } catch (RifiutoAccodamento rifiuto) {
            rifiuta(call, Rifiuto.da(rifiuto.codice));
        } catch (RuntimeException guasto) {
            Log.e(TAG, "accodamento del video non riuscito (" + guasto.getClass().getSimpleName() + ")");
            rifiuta(call, Rifiuto.INTERNO);
        }
    }

    /** Le voci di QUELL'utente, per data di creazione. */
    @PluginMethod
    public void elenco(PluginCall call) {
        try {
            String utenteId = call.getString("utenteId");
            JSArray caricamenti = new JSArray();
            if (SelettoreMedia.eUuidMinuscolo(utenteId)) {
                SelettoreMedia.ricordaUtente(utenteId);
                for (JSONObject voce : motore().elenco(utenteId)) caricamenti.put(voce);
            }
            JSObject risposta = new JSObject();
            risposta.put("caricamenti", caricamenti);
            call.resolve(risposta);
        } catch (RuntimeException guasto) {
            Log.e(TAG, "lettura della coda non riuscita (" + guasto.getClass().getSimpleName() + ")");
            rifiuta(call, Rifiuto.INTERNO);
        }
    }

    /** Ferma il trasferimento, cancella copia e segreti, stato `annullato`. NON ritira l'intento: lo fa il JavaScript. */
    @PluginMethod
    public void annulla(PluginCall call) {
        try {
            String jobId = call.getString("jobId");
            JSObject risposta = new JSObject();
            risposta.put("annullato", SelettoreMedia.eUuidMinuscolo(jobId) && motore().annulla(jobId));
            call.resolve(risposta);
        } catch (RuntimeException guasto) {
            Log.e(TAG, "annullamento del caricamento non riuscito (" + guasto.getClass().getSimpleName() + ")");
            rifiuta(call, Rifiuto.INTERNO);
        }
    }

    /** Toglie dalla coda le voci TERMINALI indicate; le altre le ignora. */
    @PluginMethod
    public void dimentica(PluginCall call) {
        try {
            List<String> jobIds = new ArrayList<>();
            for (String id : testi(call.getData().optJSONArray("jobIds"))) {
                if (SelettoreMedia.eUuidMinuscolo(id)) jobIds.add(id);
            }
            JSObject risposta = new JSObject();
            risposta.put("dimenticati", motore().dimentica(jobIds));
            call.resolve(risposta);
        } catch (RuntimeException guasto) {
            Log.e(TAG, "pulizia della coda non riuscita (" + guasto.getClass().getSimpleName() + ")");
            rifiuta(call, Rifiuto.INTERNO);
        }
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * creaElementoDiProva — SOLO build Debug
     * ──────────────────────────────────────────────────────────────────────────── */

    /**
     * Un video di byte casuali del peso chiesto (`{ byte }`), già preparato, per il collaudo del motore col server finto (C1). Risolve con un
     * elemento `video` come quelli di `scegliMedia`. Nelle build di rilascio non esiste: risponde «non implementato».
     */
    @PluginMethod
    public void creaElementoDiProva(PluginCall call) {
        if (!BuildConfig.DEBUG) {
            call.unimplemented("creaElementoDiProva esiste solo nelle build Debug");
            return;
        }
        final long byteDaCreare;
        try {
            byteDaCreare = SelettoreMedia.intero(call.getData(), "byte", 1L, CodaCaricamenti.MAX_VIDEO_INPUT_BYTES);
        } catch (SelettoreMedia.OpzioniNonValide nonValide) {
            rifiuta(call, Rifiuto.PARAMETRI_NON_VALIDI);
            return;
        }
        try {
            final File cartellaScelti = motore().coda().cartellaScelti();
            SelettoreMedia.esecutore().execute(() -> {
                try {
                    call.resolve(comeJSObject(SelettoreMedia.creaProva(Preparati.PROCESSO, cartellaScelti, byteDaCreare)));
                } catch (IOException | RuntimeException guasto) {
                    Log.e(TAG, "creazione dell'elemento di prova non riuscita (" + guasto.getClass().getSimpleName() + ")");
                    rifiuta(call, Rifiuto.INTERNO);
                }
            });
        } catch (RuntimeException guasto) {
            Log.e(TAG, "avvio dell'elemento di prova non riuscito (" + guasto.getClass().getSimpleName() + ")");
            rifiuta(call, Rifiuto.INTERNO);
        }
    }
}
