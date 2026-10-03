package it.kidville.app.caricamenti;

import it.kidville.app.caricamenti.EsecutoreCoda.RispostaHttp;
import it.kidville.app.caricamenti.RegistroNativo.ClasseErrore;

import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;

/**
 * IL RINNOVO DELLA FIRMA: `POST /api/video-uploads/rinnovo` col token nell'intestazione, e niente altro.
 * (spec 2026-10-03 «app 1.2: caricamenti nativi in background», §1.2 «Rinnovo senza sessione», §4.5, §5.4, §6.1, §9; compito A2)
 *
 * ─── CHE COSA È ──────────────────────────────────────────────────────────────────────────────
 * L'URL di PUT firmato vale due ore, e lo Storage ne verifica la firma all'ULTIMO byte (S0): il nativo ne chiede uno nuovo prima di
 * ogni PUT su un URL vecchio di più di 10 minuti, e dopo ogni PUT rifiutata. La porta è fissa e NON ha sessione: il token di rinnovo
 * nell'intestazione `x-kidville-rinnovo` è tutto ciò che serve, e tutto ciò che questa classe manda (più `accept`). Risponde 200
 * con `da-caricare` (un URL nuovo), `arrivato` o `annullato`; 404 uniforme per ogni token che non vale; 429 con `Retry-After`.
 *
 * ─── COME È FATTA ────────────────────────────────────────────────────────────────────────────
 *  · `HttpURLConnection`, corpo VUOTO (`Content-Length: 0`), tempo massimo di 30 s per leggere la risposta (§5.4) e 15 s per
 *    connettersi. Nessun reindirizzamento.
 *  · AUTENTICA COL TOKEN, NON COI COOKIE: la richiesta non aggiunge `authorization`, `apikey` o un `x-user-id` (il rinnovo non ne ha
 *    bisogno: la porta è anonima per costruzione) e il codice non legge né scrive cookie. Ma NON è vero che non ne porti: Capacitor
 *    carica sempre il suo plugin dei cookie, che nel `load()` installa un gestore globale (`CookieHandler.setDefault`, anche con i
 *    suoi due interruttori spenti), e l'`HttpURLConnection` di sistema lo consulta: una richiesta nativa verso il dominio dell'app
 *    PUÒ portare i cookie della WebView. Il rinnovo non li usa e non ne dipende (la route non li legge: conta solo il token).
 *    Correzione del secondario n. 78; la frase «le chiamate native non usano i cookie» di §6.5 la corregge J4.
 *  · NON LANCIA MAI. Come {@link CaricatorePut}, un guasto è un valore: `stato = 0` («nessuna risposta») con la CLASSE dell'eccezione, e
 *    sta alla politica (`PoliticaCaricamento.leggiRispostaRinnovo`) decidere che cosa significhi ogni stato.
 *  · Il corpo della risposta si legge fino a {@link #CORPO_MASSIMO_BYTE} (32 KB): quello vero pesa meno di 1 KB (un URL firmato), e un
 *    server impazzito non deve poter riempire la memoria. Oltre il limite il JSON è troncato, e la politica lo legge come
 *    «fuori schema» (transitorio).
 *  · IL TOKEN NON ESCE DA QUI: non compare in nessun URL, in nessun messaggio, in nessuna eccezione. L'unica cosa che lo porta è
 *    l'intestazione della richiesta.
 */
public final class RinnovoFirma implements EsecutoreCoda.TrasportoRinnovo {

    /** L'intestazione che porta il token (`contratto.ts`, `INTESTAZIONE_TOKEN_RINNOVO`). */
    public static final String INTESTAZIONE_TOKEN = "x-kidville-rinnovo";
    /** Per connettersi: 15 s. */
    public static final int TIMEOUT_CONNESSIONE_MS = 15_000;
    /** Per leggere la risposta: 30 s (§5.4). */
    public static final int TIMEOUT_LETTURA_MS = 30_000;
    /** Del corpo della risposta si leggono al più 32 KB. */
    public static final int CORPO_MASSIMO_BYTE = 32 * 1024;

    private final int timeoutConnessioneMs;
    private final int timeoutLetturaMs;

    public RinnovoFirma() {
        this(TIMEOUT_CONNESSIONE_MS, TIMEOUT_LETTURA_MS);
    }

    /** Con tempi massimi diversi: i test li stringono per provare che una risposta che non arriva scada davvero. */
    public RinnovoFirma(int timeoutConnessioneMs, int timeoutLetturaMs) {
        this.timeoutConnessioneMs = timeoutConnessioneMs;
        this.timeoutLetturaMs = timeoutLetturaMs;
    }

    @Override
    public RispostaHttp rinnova(String url, String token) {
        HttpURLConnection connessione = null;
        try {
            // `URI.create(...).toURL()` e non `new URL(String)`, deprecato dal JDK 20: l'indirizzo è già passato dalla politica degli host.
            connessione = (HttpURLConnection) URI.create(url).toURL().openConnection();
            configura(connessione, token, timeoutConnessioneMs, timeoutLetturaMs);
            try (OutputStream corpoVuoto = connessione.getOutputStream()) {
                // Un POST senza corpo: chiudere il flusso appena aperto manda l'intestazione con `Content-Length: 0`.
                corpoVuoto.flush();
            }
            int stato = connessione.getResponseCode();
            long retryAfter = PoliticaCaricamento.leggiRetryAfterSecondi(connessione.getHeaderField("Retry-After"), System.currentTimeMillis());
            InputStream dentro = stato >= 400 ? connessione.getErrorStream() : connessione.getInputStream();
            String corpo = null;
            if (dentro != null) {
                try {
                    corpo = new String(leggiFinoA(dentro, CORPO_MASSIMO_BYTE), StandardCharsets.UTF_8);
                } finally {
                    chiudi(dentro);
                }
            }
            return new RispostaHttp(stato, corpo, retryAfter, null);
        } catch (IOException | RuntimeException nessunaRisposta) {
            // La CLASSE dell'eccezione e non il suo messaggio: un messaggio può portare l'indirizzo, e l'indirizzo del rinnovo è fisso ma
            // quello della PUT, in un'altra classe, è una credenziale. Una regola sola per tutte.
            return RispostaHttp.nessunaRisposta(ClasseErrore.di(nessunaRisposta));
        } finally {
            if (connessione != null) connessione.disconnect();
        }
    }

    /**
     * Tutto ciò che si imposta su una connessione PRIMA di aprirla, in un punto solo e senza rete: così un test lo guarda senza server.
     * Il token va nell'intestazione e SOLO lì; il corpo è vuoto, e un `content-type` che il sistema aggiunge da sé non conta (la route
     * non legge il corpo).
     */
    static void configura(HttpURLConnection connessione, String token, int timeoutConnessioneMs, int timeoutLetturaMs) throws IOException {
        connessione.setRequestMethod("POST");
        connessione.setConnectTimeout(timeoutConnessioneMs);
        connessione.setReadTimeout(timeoutLetturaMs);
        // Niente `setUseCaches(false)`: sul JDK diventa `Cache-Control`/`Pragma` nella richiesta, e per un POST non c'è nessuna cache da
        // evitare (la risposta dice da sé `Cache-Control: no-store`, `rinnovo/route.ts`).
        connessione.setInstanceFollowRedirects(false);
        connessione.setDoOutput(true);
        connessione.setFixedLengthStreamingMode(0);
        connessione.setRequestProperty(INTESTAZIONE_TOKEN, token);
        connessione.setRequestProperty("accept", "application/json");
    }

    /** Legge al più `massimo` byte: il resto, se c'è, non interessa. */
    private static byte[] leggiFinoA(InputStream dentro, int massimo) throws IOException {
        ByteArrayOutputStream raccolti = new ByteArrayOutputStream();
        byte[] pezzo = new byte[2048];
        while (raccolti.size() < massimo) {
            int letti = dentro.read(pezzo, 0, Math.min(pezzo.length, massimo - raccolti.size()));
            if (letti < 0) break;
            raccolti.write(pezzo, 0, letti);
        }
        return raccolti.toByteArray();
    }

    /**
     * Chiude un flusso a esito GIÀ NOTO: se la chiusura fallisce la risposta non cambia, e la connessione si chiude comunque. Non si
     * tace: una riga `info` in logcat con la sola CLASSE dell'eccezione (secondario n. 84, AGENTS.md regola 6).
     */
    static void chiudi(Closeable flusso) {
        try {
            flusso.close();
        } catch (IOException chiusuraNonRiuscita) {
            DiagnosticaLocale.info("chiusura di un flusso del rinnovo non riuscita (" + DiagnosticaLocale.classe(chiusuraNonRiuscita)
                    + "): ignorabile, la risposta è già stata letta");
        }
    }
}
