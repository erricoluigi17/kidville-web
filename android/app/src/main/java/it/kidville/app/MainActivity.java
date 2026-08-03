package it.kidville.app;

import android.util.Log;
import android.webkit.CookieManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /**
     * Tag di logcat. NON passa da `com.getcapacitor.Logger`: `capacitor.config.ts` imposta
     * `loggingBehavior: 'none'` — per non far uscire dal bridge i payload nativi, foto
     * comprese — e quel valore zittisce anche il Logger di Capacitor. Qui serve invece una
     * riga che si veda: senza, non c'è modo di sapere se il salvataggio qui sotto è
     * avvenuto. Nel messaggio non finisce mai un cookie, solo esito e millisecondi.
     */
    private static final String TAG = "KidvilleCookie";

    /**
     * Scrive su disco i cookie della WebView prima che l'app possa essere uccisa.
     *
     * PERCHÉ (rilievo T14-F3 del collaudo Android 2026-08-03): chi faceva il login e
     * chiudeva l'app entro una trentina di secondi la riapriva slogato. Il cookie di
     * sessione è persistente per il web — `@supabase/ssr` lo scrive con `Max-Age` di 400
     * giorni — ma la WebView di Android lo tiene in RAM e lo passa su disco quando decide
     * lei. Documentazione dell'SDK, `android/webkit/CookieSyncManager`: «browser cookies
     * are saved in RAM. A separate thread saves the cookies between, driven by a timer»,
     * e l'unico modo di forzarlo è `CookieManager.flush()`, «a synchronous replacement for
     * sync()». Se il processo muore prima del giro di timer, il cookie non è mai esistito
     * su disco: la sessione appena creata svanisce.
     *
     * Capacitor non chiude quella finestra da sé: in `@capacitor/android` 8.4.2 l'unico
     * `flush()` vive nel plugin `CapacitorCookies` (cioè in `CapacitorHttp`, che questa app
     * non usa per l'autenticazione) e `Bridge.onPause/onStop/onDestroy` non toccano i cookie.
     *
     * `onPause` e non `onStop`: è il primo callback garantito quando l'app perde il
     * foreground, cioè l'ultimo istante certo prima che il sistema possa terminare il
     * processo. Il costo è un'operazione di I/O su poche decine di righe, e va pagato QUI,
     * in modo sincrono: spostarlo su un thread lo rimetterebbe in corsa con la morte del
     * processo — cioè ricreerebbe il difetto, con in più l'apparenza di averlo corretto.
     *
     * Resta scoperto, ed è giusto saperlo: un processo che muore SENZA passare da `onPause`
     * (crash del render process, «Arresta» dalle impostazioni di sistema) perde ancora la
     * finestra. Chiuderlo del tutto richiederebbe un flush a ogni scrittura di cookie, cioè
     * un plugin nativo invocato dal login — sproporzionato rispetto al caso reale, che è
     * l'utente che chiude l'app.
     */
    @Override
    public void onPause() {
        super.onPause();

        final long inizio = System.currentTimeMillis();
        try {
            CookieManager.getInstance().flush();
            // Anche il successo, e non solo l'errore: senza questa riga «nessun log» non
            // distingue «salvato» da «non è mai partito niente» — l'ambiguità che ha già
            // nascosto un guasto in questo progetto (AGENTS.md, logging §5).
            Log.i(TAG, "flush cookie WebView: ok in " + (System.currentTimeMillis() - inizio) + " ms");
        } catch (Throwable errore) {
            // `Throwable` e non `Exception`: `CookieManager.getInstance()` lancia quando il
            // pacchetto WebView manca o si sta aggiornando, e un'eccezione non gestita dentro
            // onPause è un crash che l'utente vede. Il flush è una garanzia di durata, non una
            // funzione dell'app: se fallisce si perde una sessione, non l'app.
            Log.e(TAG, "flush cookie WebView: FALLITO, la sessione puo' non sopravvivere alla chiusura", errore);
        }
    }
}
