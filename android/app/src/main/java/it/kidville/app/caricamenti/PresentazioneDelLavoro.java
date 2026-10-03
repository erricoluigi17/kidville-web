package it.kidville.app.caricamenti;

import it.kidville.app.caricamenti.CodaCaricamenti.Testi;
import it.kidville.app.caricamenti.NotificheCaricamento.Situazione;

import java.util.function.BooleanSupplier;

/**
 * L'AVANZAMENTO SULLA NOTIFICA DEL SERVIZIO IN PRIMO PIANO (API 24-33), e SOLO finché il lavoro non è stato fermato.
 * (spec 2026-10-03 «app 1.2: caricamenti nativi in background», §6.2; secondario n. 91 della PR 3)
 *
 * ─── LA NOTIFICA ORFANA (n. 91) ──────────────────────────────────────────────────────────────
 * La notifica «Invio dei video in corso» è quella del servizio in primo piano: la toglie il SERVIZIO quando WorkManager ferma il lavoro.
 * Ma il ciclo dell'esecutore non esce nello stesso istante in cui `onStopped` lo ferma, e finché esce continua a chiamare l'avanzamento.
 * `aggiornaInvio` è un `notify` con lo stesso id (73001) e `setOngoing(true)`: se arriva DOPO che il servizio l'ha tolta, la RIPUBBLICA, e su
 * Android 13 e precedenti una notifica `ongoing` non si scorre via: resta lì, orfana, finché il lavoro successivo non la ritoglie.
 *
 * La guardia è una sola: a lavoro fermato (`fermato`, in produzione `Worker.isStopped`) non si pubblica più niente.
 */
final class PresentazioneDelLavoro implements EsecutoreCoda.Presentazione {

    /** Ciò che serve della notifica: in produzione `NotificheCaricamento::aggiornaInvio`. */
    interface Notificatore {
        void aggiornaInvio(Testi testi, Situazione situazione, long inviati, long totale);
    }

    private final Notificatore notificatore;
    private final Testi testi;
    private final BooleanSupplier fermato;

    PresentazioneDelLavoro(Notificatore notificatore, Testi testi, BooleanSupplier fermato) {
        this.notificatore = notificatore;
        this.testi = testi;
        this.fermato = fermato;
    }

    @Override
    public void avanzamento(long inviatiVoce, long totaleVoce, long inviatiNelGiro) {
        if (fermato.getAsBoolean()) return;
        notificatore.aggiornaInvio(testi, Situazione.INVIO, inviatiVoce, totaleVoce);
    }

    @Override
    public void inAttesaDiRete(boolean inAttesa) {
        if (fermato.getAsBoolean()) return;
        notificatore.aggiornaInvio(testi, inAttesa ? Situazione.ATTESA_RETE : Situazione.INVIO, 0L, 0L);
    }
}
