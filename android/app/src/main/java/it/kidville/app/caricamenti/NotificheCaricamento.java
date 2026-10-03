package it.kidville.app.caricamenti;

import android.app.Notification;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import androidx.core.app.NotificationChannelCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import it.kidville.app.R;
import it.kidville.app.caricamenti.CodaCaricamenti.Testi;

/**
 * LE NOTIFICHE DEI CARICAMENTI: quella del servizio in primo piano / del job, e quella della pausa.
 * (spec 2026-10-03 «app 1.2: caricamenti nativi in background», §2.2 «Testi delle notifiche native», §6.1, §6.2, §9; compito A2)
 *
 * ─── CHE COSA MOSTRA ─────────────────────────────────────────────────────────────────────────
 *  · INVIO (`perInvio`): la notifica che il sistema pretende finché il trasferimento gira in primo piano (servizio `dataSync` su API
 *    24-33, job UIDT dal 34). Titolo `testi.titolo`, testo `testi.invio` («Invio dei video in corso»), una barra di avanzamento; se
 *    manca la rete il testo diventa `testi.attesaRete` e la barra si fa indeterminata. Tocco: apre Kidville.
 *  · PAUSA (`mostraPausa`): «Invio in pausa: tocca per riprendere» (`testi.pausa`). Compare quando il sistema non ha lasciato
 *    avviare il servizio in primo piano da background (Android 12-13) o non ha lasciato programmare il job (UIDT con l'app non più
 *    visibile): la pausa che il titolare ha accettato. Il tocco apre Kidville, e `MainActivity.onResume` riprende l'invio.
 *
 * ─── COME È FATTA ────────────────────────────────────────────────────────────────────────────
 *  · CANALE `kidville_caricamenti`, `IMPORTANCE_LOW`: silenzioso, senza vibrazione, sempre visibile nell'area notifiche. Si crea (è
 *    idempotente) prima di ogni uso. Icona `@drawable/ic_stat_kidville`, colore `@color/kv_green`: gli stessi delle push.
 *  · I TESTI LI DÀ IL JAVASCRIPT a ogni `accodaVideo`, dai cataloghi `it`/`en`, e la coda li conserva (`CodaCaricamenti.Testi`, con un
 *    ripiego italiano): il progetto nativo non ha `values-en`, niente traduzioni duplicate.
 *  · NESSUN NOME, NESSUNA MINIATURA: una notifica si vede a telefono bloccato e finisce nelle schermate che si condividono. Il titolo e
 *    il testo sono generici per costruzione: questa classe non riceve nemmeno il nome di un file o di un bambino.
 *  · UN GUASTO DELLE NOTIFICHE NON FERMA L'INVIO: `notify` può essere negato (permesso revocato) o lanciare per un guscio che si sta
 *    chiudendo. Si dice in logcat con la sola CLASSE dell'eccezione e si va avanti: il video continua a salire anche senza che
 *    nessuno lo veda.
 *
 * ─── COSA SI PROVA IN JUNIT, E COSA NO ───────────────────────────────────────────────────────
 * Le due scelte che contano — quale testo per quale situazione, e quanta barra — sono funzioni PURE e statiche
 * ({@link #testoPer}, {@link #percentuale}), provate in JUnit. Costruire la notifica vera tocca il sistema, e si prova sul
 * telefono (C1, E1): i test della JVM non hanno `NotificationManager`.
 */
public final class NotificheCaricamento {

    /** L'id del canale (§6.1). */
    public static final String ID_CANALE = "kidville_caricamenti";
    /** La notifica di invio: la stessa del servizio in primo piano e del job, aggiornata in posto. */
    public static final int ID_NOTIFICA_INVIO = 73_001;
    /** La notifica di pausa. */
    public static final int ID_NOTIFICA_PAUSA = 73_002;

    private static final String TAG = "KidvilleCaricamenti";
    private static final String NOME_CANALE = "Invio dei video";
    private static final String DESCRIZIONE_CANALE = "Avanzamento dell'invio dei video alla galleria";

    /** Che cosa sta facendo il motore, per scegliere il testo. */
    public enum Situazione {
        INVIO,
        ATTESA_RETE
    }

    private final Context contesto;

    /** `contesto` è quello dell'applicazione: la notifica sopravvive all'Activity che l'ha fatta nascere. */
    public NotificheCaricamento(Context contesto) {
        this.contesto = contesto.getApplicationContext();
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * LE DUE SCELTE PURE
     * ──────────────────────────────────────────────────────────────────────────── */

    /** Il testo della notifica di invio per la situazione: `invio`, o `attesaRete` quando manca la rete. */
    public static String testoPer(Situazione situazione, Testi testi) {
        return situazione == Situazione.ATTESA_RETE ? testi.attesaRete : testi.invio;
    }

    /**
     * Quanta barra mostrare: da 0 a 100, o -1 per «indeterminata» (non si sa il totale, o non c'è avanzamento da mostrare). Un
     * `inviati` fuori dall'intervallo si riporta dentro, e mai si mostra più del 100%.
     */
    public static int percentuale(long inviati, long totale) {
        if (totale <= 0L) return -1;
        long limitati = Math.max(0L, Math.min(inviati, totale));
        // Un video pesa al più 2 miliardi di byte e `limitati * 100` sta largo in un `long`; ma una funzione che si chiama «percentuale» non
        // deve traboccare su un totale enorme: oltre i diecimila miliardi si scala di 1024, che alla barra non cambia un punto.
        long divisore = totale;
        while (divisore > 10_000_000_000_000L) {
            divisore >>= 10;
            limitati >>= 10;
        }
        return (int) (limitati * 100L / divisore);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL SISTEMA
     * ──────────────────────────────────────────────────────────────────────────── */

    /** Il canale `kidville_caricamenti`. Idempotente: si può richiamare a ogni uso (da API 26; sotto non esiste e non serve). */
    public void assicuraIlCanale() {
        NotificationChannelCompat canale = new NotificationChannelCompat.Builder(ID_CANALE, NotificationManagerCompat.IMPORTANCE_LOW)
                .setName(NOME_CANALE)
                .setDescription(DESCRIZIONE_CANALE)
                .setShowBadge(false)
                .setVibrationEnabled(false)
                .build();
        NotificationManagerCompat.from(contesto).createNotificationChannel(canale);
    }

    /**
     * La notifica di invio: quella che si consegna al servizio in primo piano (`ForegroundInfo`) o al job (`setNotification`).
     * `totale <= 0` o `ATTESA_RETE` danno una barra indeterminata.
     */
    public Notification perInvio(Testi testi, Situazione situazione, long inviati, long totale) {
        assicuraIlCanale();
        int percento = situazione == Situazione.ATTESA_RETE ? -1 : percentuale(inviati, totale);
        NotificationCompat.Builder costruttore = base(testi.titolo, testoPer(situazione, testi))
                .setOngoing(true)
                .setCategory(NotificationCompat.CATEGORY_PROGRESS)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE);
        if (percento < 0) {
            costruttore.setProgress(0, 0, true);
        } else {
            costruttore.setProgress(100, percento, false);
        }
        return costruttore.build();
    }

    /** Aggiorna in posto la notifica di invio (stesso id): per i gusci che non hanno un altro modo di farlo (la barra del servizio). */
    public void aggiornaInvio(Testi testi, Situazione situazione, long inviati, long totale) {
        mostra(ID_NOTIFICA_INVIO, perInvio(testi, situazione, inviati, totale));
    }

    /** «Invio in pausa: tocca per riprendere». Si toglie da sola al tocco, e la toglie `togliPausa` alla ripresa. */
    public void mostraPausa(Testi testi) {
        assicuraIlCanale();
        Notification notifica = base(testi.titolo, testi.pausa)
                .setOngoing(false)
                .setAutoCancel(true)
                .build();
        mostra(ID_NOTIFICA_PAUSA, notifica);
    }

    public void togliPausa() {
        try {
            NotificationManagerCompat.from(contesto).cancel(ID_NOTIFICA_PAUSA);
        } catch (RuntimeException negata) {
            Log.w(TAG, "notifica di pausa non rimossa (" + negata.getClass().getSimpleName() + ")");
        }
    }

    /** Il sistema lascia mostrare le notifiche dell'app (permesso concesso e non bloccate dall'utente)? */
    public boolean autorizzate() {
        try {
            return NotificationManagerCompat.from(contesto).areNotificationsEnabled();
        } catch (RuntimeException nonLeggibile) {
            Log.w(TAG, "permesso delle notifiche non leggibile (" + nonLeggibile.getClass().getSimpleName() + ")");
            return false;
        }
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * PICCOLI UTENSILI
     * ──────────────────────────────────────────────────────────────────────────── */

    /** Ciò che le due notifiche hanno in comune: icona, colore, titolo, testo, tocco che apre Kidville, nessun suono. */
    private NotificationCompat.Builder base(String titolo, String testo) {
        NotificationCompat.Builder costruttore = new NotificationCompat.Builder(contesto, ID_CANALE)
                .setSmallIcon(R.drawable.ic_stat_kidville)
                .setColor(ContextCompat.getColor(contesto, R.color.kv_green))
                .setContentTitle(titolo)
                .setContentText(testo)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .setPriority(NotificationCompat.PRIORITY_LOW);
        PendingIntent versoLApp = pendingIntentVersoLApp();
        if (versoLApp != null) costruttore.setContentIntent(versoLApp);
        return costruttore;
    }

    /** Il tocco apre l'app come dall'icona (`MainActivity` è `singleTask`: se è già aperta, torna in primo piano). `null` se non si trova. */
    private PendingIntent pendingIntentVersoLApp() {
        Intent apertura = contesto.getPackageManager().getLaunchIntentForPackage(contesto.getPackageName());
        if (apertura == null) return null;
        return PendingIntent.getActivity(contesto, 0, apertura, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private void mostra(int id, Notification notifica) {
        try {
            NotificationManagerCompat.from(contesto).notify(id, notifica);
        } catch (SecurityException | IllegalStateException negata) {
            // Il permesso alle notifiche revocato, o un servizio che si sta chiudendo: l'invio continua anche senza che nessuno lo veda.
            Log.w(TAG, "notifica non mostrata (" + negata.getClass().getSimpleName() + ")");
        }
    }
}
