package it.kidville.app.caricamenti;

import android.annotation.SuppressLint;
import android.app.job.JobParameters;
import android.app.job.JobService;
import android.content.Context;
import android.os.Build;
import android.util.Log;

import androidx.annotation.NonNull;

import it.kidville.app.caricamenti.CodaCaricamenti.Testi;
import it.kidville.app.caricamenti.EsecutoreCoda.EsitoCiclo;
import it.kidville.app.caricamenti.NotificheCaricamento.Situazione;

import java.util.concurrent.atomic.AtomicBoolean;

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
 * ─── UN RIAVVIO CHE ARRIVA MENTRE IL CICLO PRECEDENTE STA USCENDO (n. 76) ────────────────────
 * Dopo `onStopJob` il ciclo vecchio non esce subito (un rinnovo in volo non si interrompe). Se il sistema riavvia il job in quei secondi,
 * il thread nuovo trova l'esecutore ancora attivo: non chiude il job «senza lavoro» (prima lo faceva, e le voci restavano ferme senza
 * nessun job, in silenzio) ma aspetta che l'altro finisca e riparte ({@link CicloDelGuscio}). La fermata è PER ESECUZIONE
 * ({@link Esecuzione}), non un campo dell'istanza: un thread vecchio che esce in ritardo non deve vedere la bandiera del job nuovo, né il
 * job nuovo ereditare quella del vecchio.
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
     * UN'ESECUZIONE DEL JOB, dal suo `onStartJob` al suo `jobFinished`. Porta la bandiera «il sistema ha fermato QUESTA esecuzione»: serve
     * per la finestra fra `onStartJob` e l'avvio del ciclo (l'esecutore non è ancora attivo e `fermaIlGuscio` non ha niente da
     * interrompere, ma il ciclo non deve partire su un job che non esiste più), e per l'attesa di un ciclo precedente.
     */
    static final class Esecuzione {
        private final AtomicBoolean fermata = new AtomicBoolean(false);

        void ferma() {
            fermata.set(true);
        }

        boolean fermata() {
            return fermata.get();
        }
    }

    /** L'esecuzione in corso (l'ultima partita): `onStopJob` ferma quella. Un thread vecchio ha in mano la propria. */
    private volatile Esecuzione corrente;

    /** Comincia una nuova esecuzione: quella di prima, se un thread la sta ancora finendo, resta com'è (fermata o no). */
    Esecuzione nuovaEsecuzione() {
        Esecuzione nuova = new Esecuzione();
        corrente = nuova;
        return nuova;
    }

    /** Il sistema ha fermato il job: la bandiera si alza SOLO sull'esecuzione in corso. */
    void fermaLEsecuzioneCorrente() {
        Esecuzione esecuzione = corrente;
        if (esecuzione != null) esecuzione.ferma();
    }

    @Override
    public boolean onStartJob(final JobParameters parametri) {
        final Esecuzione esecuzione = nuovaEsecuzione();
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
                riprogramma = eseguiIlGiro(motore::eseguiSuGuscio, presentazione, esecuzione, Thread::sleep);
            } finally {
                jobFinished(parametri, riprogramma);
            }
        }, "kidville-uidt");
        filo.start();
        return true;
    }

    /**
     * Il corpo del thread del job: fa girare il ciclo e dice se `jobFinished` deve chiedere la riprogrammazione. NON LANCIA MAI: un guasto
     * vale «riprogramma» (le voci stanno su disco), e si dice.
     *
     * Chiede la riprogrammazione se la rete è mancata oltre il tetto (`RIPROVA`) o se un ciclo precedente non ha finito di uscire
     * (`GIA_ATTIVO`, dopo l'attesa di {@link CicloDelGuscio}); non la chiede se il ciclo è finito o se il sistema ha fermato il job
     * (`INTERROTTO`: lo riprogramma lui, `onStopJob` ha detto `true`).
     */
    static boolean eseguiIlGiro(CicloDelGuscio.MotoreDelGuscio motore, EsecutoreCoda.Presentazione presentazione, Esecuzione esecuzione,
                                CicloDelGuscio.Pausa pausa) {
        try {
            EsitoCiclo esito = CicloDelGuscio.esegui(motore, presentazione, LavoroCaricamenti.ATTESA_RETE_MASSIMA_MS, esecuzione::fermata, pausa);
            return CicloDelGuscio.serveUnaRipresa(esito);
        } catch (RuntimeException guasto) {
            DiagnosticaLocale.errore("ciclo del job interrotto da un guasto (" + DiagnosticaLocale.classe(guasto) + ")");
            return true;
        }
    }

    /**
     * Il sistema ferma il job (la rete è caduta, il job ha superato un limite, l'utente lo ha fermato dal Task Manager): la PUT in volo
     * si interrompe e le voci tornano `in-attesa`, ferme finché il job non riparte. Restituire `true` lo fa riprogrammare.
     */
    @Override
    public boolean onStopJob(JobParameters parametri) {
        fermaLEsecuzioneCorrente();
        try {
            PianificatoreCaricamenti.condiviso(getApplicationContext()).fermaIlGuscio();
        } catch (RuntimeException guasto) {
            Log.e(TAG, "arresto del job non riuscito (" + guasto.getClass().getSimpleName() + ")");
        }
        return true;
    }

    /**
     * API 34+: con un vincolo di rete il sistema avvisa quando la rete usata dal job CAMBIA (da Wi-Fi a cellulare, per esempio) e, se la
     * classe non ha un'implementazione propria, scrive in logcat «onNetworkChanged() not implemented… Must override» a ogni cambio
     * (secondario n. 88). Qui non c'è niente da fare: il job non lega il trasferimento a una rete in particolare (non usa
     * `JobParameters#getNetwork`) e la PUT in corso continua sulla rete predefinita; se quella cade, la PUT cade e il ciclo riprova
     * come per ogni altra caduta (§4.5). Si dice con una riga `info` senza dati, e non si chiama la versione della classe base.
     */
    @Override
    public void onNetworkChanged(@NonNull JobParameters parametri) {
        DiagnosticaLocale.info("rete del job cambiata: il trasferimento prosegue sulla rete predefinita");
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
