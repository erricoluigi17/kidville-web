package it.kidville.app.caricamenti;

import android.annotation.SuppressLint;
import android.app.job.JobParameters;
import android.app.job.JobService;
import android.content.Context;
import android.os.Build;
import android.util.Log;

import it.kidville.app.caricamenti.CodaCaricamenti.Testi;
import it.kidville.app.caricamenti.EsecutoreCoda.EsitoCiclo;
import it.kidville.app.caricamenti.NotificheCaricamento.Situazione;

/**
 * IL GUSCIO PER API 34 E OLTRE: un job UIDT («user-initiated data transfer») di JobScheduler.
 * (spec 2026-10-03 «app 1.2: caricamenti nativi in background», §6.2 «API ≥ 34: UIDT»; compito A2)
 *
 * ─── CHE COSA È UN UIDT, E PERCHÉ QUI ────────────────────────────────────────────────────────
 * Da Android 14 il sistema ha un tipo di job fatto apposta per ciò che questa app deve fare: trasferire file grandi, avviati
 * dall'utente, con una notifica che il sistema mostra e che l'utente può fermare dal Task Manager. Non è un servizio in primo piano:
 * non ha il limite di tempo del `dataSync` di Android 15, non ha bisogno di un servizio da avviare («che da background non
 * partirebbe»), passa con il Risparmio dati e con la rete a consumo, e il sistema lo riprende da solo dopo un riavvio (persistito).
 * Va PROGRAMMATO mentre l'app è visibile (`PianificatoreCaricamenti`), e poi gira anche a telefono bloccato.
 *
 * ─── COME È FATTO ────────────────────────────────────────────────────────────────────────────
 * Un guscio SOTTILE, come `LavoroCaricamenti`: la logica sta nell'esecutore.
 *  · `onStartJob` mostra SUBITO la notifica (`setNotification`: il sistema pretende di vederla entro pochi secondi dall'avvio, o ferma il
 *    job) e fa girare il ciclo su un thread a parte: `onStartJob` gira sul thread principale, e un ciclo di ore lo bloccherebbe;
 *  · l'avanzamento va al sistema (`updateTransferredNetworkBytes`: «sta davvero trasferendo») e alla notifica, al più una volta al
 *    secondo (lo decide l'esecutore);
 *  · `onStopJob` ferma l'esecutore (la PUT in volo si interrompe, le voci tornano in attesa) e restituisce `true`: il job si
 *    riprogramma da solo, e una fermata dovuta al vincolo di rete (la rete è caduta) non conta come un guasto.
 *  · Quando il ciclo finisce `jobFinished(params, false)`; se la rete è mancata oltre il tetto, `jobFinished(params, true)`: il sistema lo
 *    riprogramma col backoff esponenziale dichiarato alla programmazione.
 *
 * ─── LA NOTIFICA ─────────────────────────────────────────────────────────────────────────────
 * Titolo e testo sono quelli di `testi` (passati dal JavaScript, senza nomi né miniature), e a fine job la notifica si TOGLIE
 * (`JOB_END_NOTIFICATION_POLICY_REMOVE`): non resta niente nell'area notifiche di un invio finito. Le voci terminali le vede
 * l'insegnante nella Galleria.
 *
 * ─── L'ID DEL JOB E L'AVVISO DI LINT ─────────────────────────────────────────────────────────
 * Gli ID di JobScheduler sono unici per applicazione, e WorkManager ne usa di suoi (dal ramo API 24-33 di questo stesso motore) in un
 * intervallo che di norma è [0, Integer.MAX_VALUE]: l'avviso `SpecifyJobSchedulerIdRange` chiede di restringerlo con un `Application`
 * che implementi `Configuration.Provider`. Qui non lo si fa, di proposito: vorrebbe dire togliere l'inizializzatore automatico di
 * WorkManager dal manifest e toccare l'avvio di tutta l'app per un rischio che richiede 73.100 lavori di sistema programmati da
 * WorkManager sullo stesso telefono (conta da zero, un ID per ogni lavoro nuovo). Su API ≥ 34 questo motore non usa WorkManager, e
 * l'ID fisso ({@link PianificatoreCaricamenti#ID_JOB_UIDT}) sta lontano da dove WorkManager parte a contare.
 */
@SuppressLint("SpecifyJobSchedulerIdRange")
public final class ServizioCaricamentiUidt extends JobService {

    private static final String TAG = "KidvilleCaricamenti";

    /**
     * Il sistema ha fermato il job (`onStopJob`). Serve per la finestra fra `onStartJob` e l'avvio del ciclo: in quel momento l'esecutore
     * non è ancora attivo e `fermaIlGuscio` non ha niente da interrompere, ma il ciclo non deve partire su un job che non esiste più.
     */
    private volatile boolean fermato;

    @Override
    public boolean onStartJob(final JobParameters parametri) {
        fermato = false;
        final PianificatoreCaricamenti motore;
        try {
            motore = PianificatoreCaricamenti.condiviso(getApplicationContext());
        } catch (RuntimeException guasto) {
            // Il motore non si apre: il job si riprogramma (col backoff) invece di sparire. Una voce non si perde: sta su disco.
            // Il contratto di JobService: `false` vuol dire «nessun lavoro da fare» (il job finisce, senza riprogrammazione), `true` «il
            // lavoro è in corso» e si chiude con `jobFinished`. Qui si vuole la riprogrammazione: `true`, e `jobFinished` da un altro thread.
            Log.e(TAG, "motore non disponibile (" + guasto.getClass().getSimpleName() + ")");
            new Thread(() -> jobFinished(parametri, true), "kidville-uidt-guasto").start();
            return true;
        }
        final Context applicazione = getApplicationContext();
        final NotificheCaricamento notifiche = new NotificheCaricamento(applicazione);
        final Testi testi = motore.testiDelleNotifiche();
        // Subito, prima di qualunque altra cosa: senza la notifica il sistema ferma il job.
        mostraLaNotifica(parametri, notifiche, testi, Situazione.INVIO, 0L, 0L);
        final PresentazioneDelJob presentazione = new PresentazioneDelJob(parametri, notifiche, testi);

        Thread filo = new Thread(() -> {
            boolean riprogramma = true;
            try {
                if (fermato) {
                    // Il sistema ha già fermato il job (e lo riprogramma lui, `onStopJob` ha detto `true`): non si parte.
                    riprogramma = false;
                } else {
                    EsitoCiclo esito = motore.eseguiSuGuscio(presentazione, LavoroCaricamenti.ATTESA_RETE_MASSIMA_MS);
                    // `RIPROVA`: la rete è mancata oltre il tetto, il sistema ripropone il job. `INTERROTTO`: lo ha già fermato lui
                    // (`onStopJob`), e il suo `jobFinished` non conta. Negli altri casi il lavoro è finito.
                    riprogramma = esito == EsitoCiclo.RIPROVA;
                }
            } catch (RuntimeException guasto) {
                Log.e(TAG, "ciclo del job interrotto da un guasto (" + guasto.getClass().getSimpleName() + ")");
            } finally {
                jobFinished(parametri, riprogramma);
            }
        }, "kidville-uidt");
        filo.start();
        return true;
    }

    /**
     * Il sistema ferma il job (la rete è caduta, il job ha superato un limite, l'utente lo ha fermato dal Task Manager): la PUT in volo
     * si interrompe e le voci tornano `in-attesa`, ferme finché il job non riparte. Restituire `true` lo fa riprogrammare.
     */
    @Override
    public boolean onStopJob(JobParameters parametri) {
        fermato = true;
        try {
            PianificatoreCaricamenti.condiviso(getApplicationContext()).fermaIlGuscio();
        } catch (RuntimeException guasto) {
            Log.e(TAG, "arresto del job non riuscito (" + guasto.getClass().getSimpleName() + ")");
        }
        return true;
    }

    /** `setNotification` esiste da API 34: il servizio non parte mai prima, ma il controllo costa niente. */
    private void mostraLaNotifica(JobParameters parametri, NotificheCaricamento notifiche, Testi testi, Situazione situazione,
                                  long inviati, long totale) {
        if (Build.VERSION.SDK_INT < 34) return;
        try {
            setNotification(parametri, NotificheCaricamento.ID_NOTIFICA_INVIO, notifiche.perInvio(testi, situazione, inviati, totale),
                    JobService.JOB_END_NOTIFICATION_POLICY_REMOVE);
        } catch (RuntimeException negata) {
            // Se il sistema rifiuta la notifica (un guscio che si sta chiudendo) l'invio continua: il job è comunque protetto.
            Log.w(TAG, "notifica del job non mostrata (" + negata.getClass().getSimpleName() + ")");
        }
    }

    /** L'avanzamento verso il sistema e verso la notifica del job. */
    private final class PresentazioneDelJob implements EsecutoreCoda.Presentazione {
        private final JobParameters parametri;
        private final NotificheCaricamento notifiche;
        private final Testi testi;

        PresentazioneDelJob(JobParameters parametri, NotificheCaricamento notifiche, Testi testi) {
            this.parametri = parametri;
            this.notifiche = notifiche;
            this.testi = testi;
        }

        @Override
        public void avanzamento(long inviatiVoce, long totaleVoce, long inviatiNelGiro) {
            if (Build.VERSION.SDK_INT >= 34) {
                try {
                    // Download 0: questo job solo spedisce. `inviatiNelGiro` cresce sempre: è ciò che il sistema vuole vedere.
                    updateTransferredNetworkBytes(parametri, 0L, inviatiNelGiro);
                } catch (RuntimeException negata) {
                    Log.w(TAG, "byte trasferiti non comunicati (" + negata.getClass().getSimpleName() + ")");
                }
            }
            mostraLaNotifica(parametri, notifiche, testi, Situazione.INVIO, inviatiVoce, totaleVoce);
        }

        @Override
        public void inAttesaDiRete(boolean inAttesa) {
            mostraLaNotifica(parametri, notifiche, testi, inAttesa ? Situazione.ATTESA_RETE : Situazione.INVIO, 0L, 0L);
        }
    }
}
