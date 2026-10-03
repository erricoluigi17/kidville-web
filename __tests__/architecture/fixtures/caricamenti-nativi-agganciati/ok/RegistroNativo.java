// FIXTURE del lock `caricamenti-nativi-agganciati` — VERDE per costruzione (regole 9 e 10, Android).
// Il registro dei log del nativo: l'elenco CHIUSO dei messaggi (`enum Evento`) e i metodi di log, tutti a enumerati e numeri.
package it.kidville.app.fixture;

import java.util.UUID;

public final class RegistroNativo {

    public enum Livello {
        WARN("warn"),
        ERROR("error");

        private final String valore;

        Livello(String valore) {
            this.valore = valore;
        }
    }

    public enum Evento {
        VIDEO_ACCODATO("video-nativo-accodato", Livello.WARN),
        VIDEO_INVIATO("video-nativo-inviato", Livello.WARN),
        VIDEO_RITENTO("video-nativo-ritento", Livello.WARN),
        VIDEO_RINNOVO("video-nativo-rinnovo", Livello.WARN),
        VIDEO_ATTESA_RETE("video-nativo-attesa-rete", Livello.WARN),
        VIDEO_PAUSA("video-nativo-pausa", Livello.WARN),
        VIDEO_RIPRESO_DOPO_CHIUSURA("video-nativo-ripreso-dopo-chiusura", Livello.WARN),
        VIDEO_ANNULLATO("video-nativo-annullato", Livello.WARN),
        VIDEO_FALLITO("video-nativo-fallito", Livello.ERROR),
        MEDIA_PREPARAZIONE_FALLITA("media-nativo-preparazione-fallita", Livello.ERROR),
        MOTORE("caricamenti-nativi-motore", Livello.WARN),
        CODA_CORROTTA("coda-nativa-corrotta", Livello.ERROR),
        REGISTRO_SCARTATI("registro-nativo-scartati", Livello.WARN),
        NOTIFICA_NON_AUTORIZZATA("notifica-locale-non-autorizzata", Livello.WARN),
        PUT_OLTRE_SCADENZA("put-oltre-scadenza", Livello.WARN);

        private final String slug;
        private final Livello livello;

        Evento(String slug, Livello livello) {
            this.slug = slug;
            this.livello = livello;
        }
    }

    /* ───────────────────────────────────────────
     * GLI EVENTI (§8.2): un metodo per messaggio, tutti a enumerati e numeri
     * ─────────────────────────────────────────── */

    public void videoAccodato(UUID job, UUID utente, long byteTotali) {
    }

    public void videoFallito(UUID job, UUID utente, int tentativi) {
    }

    public void codaCorrotta(UUID utente, int fileOrfani) {
    }

    /* ───────────────────────────────────────────
     * REGISTRAZIONE
     * ─────────────────────────────────────────── */

    /** Non è un metodo di log: il primo parametro non è un UUID. */
    public static boolean siLoggaIlRitento(int tentativo) {
        return tentativo >= 1 && (tentativo & (tentativo - 1)) == 0;
    }
}
