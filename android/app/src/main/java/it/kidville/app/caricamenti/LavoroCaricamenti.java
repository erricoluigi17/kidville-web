package it.kidville.app.caricamenti;

import android.app.Notification;
import android.content.Context;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.ForegroundInfo;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import it.kidville.app.caricamenti.CodaCaricamenti.Testi;
import it.kidville.app.caricamenti.EsecutoreCoda.EsitoCiclo;
import it.kidville.app.caricamenti.NotificheCaricamento.Situazione;

/**
 * IL GUSCIO PER API 24-33: un lavoro di WorkManager con un servizio in primo piano `dataSync`.
 * (spec 2026-10-03 «app 1.2: caricamenti nativi in background», §6.2 «API 24-33: WorkManager + FGS `dataSync`»; compito A2)
 *
 * ─── CHE COSA FA ─────────────────────────────────────────────────────────────────────────────
 * Un guscio SOTTILE: tutta la logica sta nell'esecutore (`EsecutoreCoda`), che è lo stesso del guscio UIDT. Questo lavoro fa tre cose:
 *  1. chiede il SERVIZIO IN PRIMO PIANO (`setForegroundAsync(...).get()`, tipo `dataSync` da API 29): è ciò che permette di
 *     trasferire per ore a schermo bloccato senza che il sistema uccida il processo, e che tiene la notifica «Invio dei video in corso»;
 *  2. fa girare il ciclo dell'esecutore, finché c'è lavoro;
 *  3. quando il sistema lo ferma (`onStopped`) interrompe la PUT in volo.
 *
 * ─── SE IL SERVIZIO IN PRIMO PIANO NON PARTE ─────────────────────────────────────────────────
 * Su Android 12 e 13 un lavoro avviato DA BACKGROUND (un ritentativo, un riavvio del processo) non può far partire un servizio in
 * primo piano: `setForegroundAsync` fallisce con `ForegroundServiceStartNotAllowedException`. È la pausa che il titolare ha accettato
 * (§2.1: «la pausa "tocca per riprendere" è accettata»): le voci vanno `in-pausa` `FGS_NON_AVVIABILE`, compare la notifica «Invio in
 * pausa: tocca per riprendere» e il lavoro finisce con successo. Quando l'insegnante apre Kidville, `MainActivity.onResume` richiama
 * `PianificatoreCaricamenti.riprendiInPrimoPiano` e il lavoro riparte, questa volta con l'app visibile, quindi col servizio permesso.
 * Su 24-30 l'avvio da background è permesso e questo ramo non scatta mai.
 *
 * ─── LA RETE ─────────────────────────────────────────────────────────────────────────────────
 * Il lavoro NON ha vincoli di rete (§6.2): l'attesa la governa l'esecutore, che con la rete assente tiene il servizio attivo per
 * al più 10 minuti e poi restituisce `RIPROVA` (qui `Result.retry()`, con il backoff esponenziale di WorkManager). Un vincolo di
 * rete avrebbe lasciato il lavoro fermo e invisibile, senza notifica, per tutto il tempo senza rete.
 */
public final class LavoroCaricamenti extends Worker {

    private static final String TAG = "KidvilleCaricamenti";

    /** Per quanto aspettare la rete, con il servizio attivo, prima di restituire `Result.retry()`: 10 minuti (§6.2). */
    static final long ATTESA_RETE_MASSIMA_MS = PoliticaCaricamento.ATTESA_RETE_NEL_WORKER_SECONDI * 1000L;

    public LavoroCaricamenti(@NonNull Context contesto, @NonNull WorkerParameters parametri) {
        super(contesto, parametri);
    }

    @NonNull
    @Override
    public Result doWork() {
        final PianificatoreCaricamenti motore;
        try {
            motore = PianificatoreCaricamenti.condiviso(getApplicationContext());
        } catch (RuntimeException guasto) {
            // Il motore non si apre (la coda non si legge, un guasto di disco): un altro tentativo fra poco, non una voce perduta.
            Log.e(TAG, "motore non disponibile (" + guasto.getClass().getSimpleName() + ")");
            return Result.retry();
        }
        final NotificheCaricamento notifiche = new NotificheCaricamento(getApplicationContext());
        final Testi testi = motore.testiDelleNotifiche();

        try {
            setForegroundAsync(infoPrimoPiano(notifiche.perInvio(testi, Situazione.INVIO, 0L, 0L))).get();
        } catch (InterruptedException interrotto) {
            // Il lavoro è stato fermato mentre aspettava il servizio: non è un guasto del servizio, e non si mettono le voci in pausa.
            Thread.currentThread().interrupt();
            return Result.retry();
        } catch (Exception nonAvviabile) {
            // Di solito `ExecutionException` con dentro `ForegroundServiceStartNotAllowedException` (Android 12-13 da background); ma
            // qualunque eccezione qui vuol dire «il servizio in primo piano non c'è»: il lavoro non può girare senza.
            Log.w(TAG, "servizio in primo piano non avviabile (" + nonAvviabile.getClass().getSimpleName() + ")");
            motore.suForegroundNonAvviabile();
            return Result.success();
        }

        // Mentre si aspettava il servizio il lavoro può essere stato SOSTITUITO (l'insegnante ha riaperto l'app e `REPLACE` ne ha accodato
        // uno nuovo: `PianificatoreCaricamenti.programmaWorkManager`) o fermato dal sistema. In quel momento l'esecutore non è ancora
        // attivo, e `onStopped` non ha niente da interrompere: senza questo controllo il lavoro vecchio farebbe girare il ciclo senza che
        // WorkManager lo sappia, e quello nuovo, trovandolo attivo, finirebbe subito e porterebbe via il servizio in primo piano.
        if (isStopped()) return Result.success();

        EsitoCiclo esito = motore.eseguiSuGuscio(new PresentazioneDelLavoro(notifiche, testi), ATTESA_RETE_MASSIMA_MS);
        return esito == EsitoCiclo.RIPROVA ? Result.retry() : Result.success();
    }

    /** WorkManager ferma il lavoro (vincoli, quote, l'utente): la PUT in volo si interrompe e le voci tornano in attesa. */
    @Override
    public void onStopped() {
        super.onStopped();
        try {
            PianificatoreCaricamenti.condiviso(getApplicationContext()).fermaIlGuscio();
        } catch (RuntimeException guasto) {
            Log.e(TAG, "arresto del lavoro non riuscito (" + guasto.getClass().getSimpleName() + ")");
        }
    }

    /** Il servizio in primo piano: tipo `dataSync` da API 29; sotto, il costruttore senza tipo (il tipo non esiste). */
    private static ForegroundInfo infoPrimoPiano(Notification notifica) {
        if (Build.VERSION.SDK_INT >= 29) {
            return new ForegroundInfo(NotificheCaricamento.ID_NOTIFICA_INVIO, notifica, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        }
        return new ForegroundInfo(NotificheCaricamento.ID_NOTIFICA_INVIO, notifica);
    }

    /** L'avanzamento sulla notifica del servizio (stesso id: si aggiorna in posto). */
    private static final class PresentazioneDelLavoro implements EsecutoreCoda.Presentazione {
        private final NotificheCaricamento notifiche;
        private final Testi testi;

        PresentazioneDelLavoro(NotificheCaricamento notifiche, Testi testi) {
            this.notifiche = notifiche;
            this.testi = testi;
        }

        @Override
        public void avanzamento(long inviatiVoce, long totaleVoce, long inviatiNelGiro) {
            notifiche.aggiornaInvio(testi, Situazione.INVIO, inviatiVoce, totaleVoce);
        }

        @Override
        public void inAttesaDiRete(boolean inAttesa) {
            notifiche.aggiornaInvio(testi, inAttesa ? Situazione.ATTESA_RETE : Situazione.INVIO, 0L, 0L);
        }
    }
}
