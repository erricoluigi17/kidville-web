package it.kidville.app.caricamenti;

import it.kidville.app.caricamenti.EsecutoreCoda.EsitoPut;
import it.kidville.app.caricamenti.EsecutoreCoda.Interruzione;
import it.kidville.app.caricamenti.EsecutoreCoda.RichiestaPut;
import it.kidville.app.caricamenti.RegistroNativo.ClasseErrore;

import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;

/**
 * LA PUT: un file intero, a lunghezza fissa, con `HttpURLConnection`, e SOLO le intestazioni che il server ha dichiarato.
 * (spec 2026-10-03 «app 1.2: caricamenti nativi in background», §2.2 «Intestazioni della PUT», §3 (S0), §4.5, §6.1, §9; compito A2)
 *
 * ─── CHE COSA FA ─────────────────────────────────────────────────────────────────────────────
 * Spedisce `file` all'URL firmato con un'unica PUT (`setFixedLengthStreamingMode(long)`: il corpo non passa mai dalla memoria, e
 * `Content-Length` è il peso del file), a blocchi da 256 KB, controllando fra un blocco e l'altro se qualcuno ha chiesto di fermarsi.
 * Poi legge la risposta e restituisce un {@link EsitoPut}: lo stato HTTP, i primi 4 KB del corpo (da cui la politica ricava solo
 * `statusCode` ed `error`), `Retry-After`, quanti byte sono partiti e quanto è durato. NON lancia mai: ogni guasto è un valore.
 *
 * ─── LE INTESTAZIONI ─────────────────────────────────────────────────────────────────────────
 * Esattamente `content-type`, quello di `caricamento.intestazioni`, e nient'altro di nostro: niente `x-upsert` (un URL rubato non
 * deve poter sovrascrivere l'originale: S0-g), niente `authorization`, `apikey` (la firma sta nell'URL: S0-f), `cache-control`, né il
 * token di rinnovo o un cookie. Le intestazioni che `HttpURLConnection` aggiunge da sé (`Host`, `Content-Length`, `User-Agent`,
 * `Accept-Encoding`, `Connection`) non sono nostre e non mandano `Expect: 100-continue`, come negli scenari di S0.
 *
 * ─── TRE COSE CHE QUI NON SONO OVVIE ─────────────────────────────────────────────────────────
 *  1. FERMARE UNA PUT CHE NON RISPONDE. Un `write` su un socket senza rete non ha un tempo massimo (`readTimeout` vale per la
 *     lettura): resta bloccato finché il sistema operativo non si arrende, anche minuti. L'unico modo di svegliarlo da un altro
 *     thread è CHIUDERE la connessione: per questo il trasportatore registra `disconnect` come gancio dell'{@link Interruzione}, e
 *     chi ferma (il guscio che si spegne, l'utente che annulla) la chiude davvero. La bandiera, letta a ogni blocco, copre il resto.
 *  2. UNA RISPOSTA ARRIVATA PRIMA CHE IL CORPO FINISSE. Un URL scaduto o un duplicato vengono rifiutati dallo Storage senza leggere
 *     il file, e il server può chiudere con i byte ancora in viaggio: la `write` lancia, ma il motivo è nella risposta. Se la
 *     scrittura cade si prova comunque a leggerla (`getResponseCode`): se c'è, vale come un esito vero con `completo = false`;
 *     se non c'è, è una caduta di rete. Dove la risposta anticipata non si riesce a leggere (la JVM di JUnit non la mostra, e il
 *     telefono dipende dal sistema) si ricade nel secondo caso, che la politica tratta come transitorio: il giro dopo rinnova perché
 *     l'URL ha più di dieci minuti, e il rinnovo dice se il file c'è già.
 *  3. IL PESO È UN PATTO. Con la lunghezza fissa, spedire meno byte del dichiarato è un errore della connessione e spedirne di più è
 *     impossibile: se la copia pesa un numero diverso da `byteTotali` (o finisce prima del previsto) l'esito è `PESO_DIVERSO`, che
 *     l'esecutore porta in `fallito`, e non una PUT che il sistema chiuderebbe a metà.
 *
 * ─── COSA NON FA ─────────────────────────────────────────────────────────────────────────────
 * Non riprende a metà (una PUT unica riparte da zero), non rinnova l'URL, non decide che cosa significhi uno stato: sono
 * dell'esecutore e della politica. Non logga: non conosce il registro, e un nome di file, un URL o un token non devono poter
 * finire in una riga neppure per distrazione; i guasti sono la CLASSE dell'eccezione, nell'esito, per chi vuole dirli in logcat.
 */
public final class CaricatorePut implements EsecutoreCoda.TrasportoPut {

    /** Un blocco di lettura/scrittura: 256 KB (§6.1). */
    public static final int BLOCCO_BYTE = 256 * 1024;
    /** Per connettersi (e fare la stretta di mano TLS): 30 s (§6.1). */
    public static final int TIMEOUT_CONNESSIONE_MS = 30_000;
    /** Per leggere la risposta dopo l'ultimo byte (lo Storage la dà dopo aver messo da parte il file): 300 s (§6.1). */
    public static final int TIMEOUT_LETTURA_MS = 300_000;
    /** L'avanzamento si comunica al più una volta ogni 500 ms o ogni 1% (§6.1). */
    public static final long INTERVALLO_AVANZAMENTO_MS = 500L;
    /** Del corpo di un rifiuto si leggono al più 4 KB (§4.5): la stessa soglia della politica. */
    public static final int CORPO_ERRORE_MASSIMO_BYTE = PoliticaCaricamento.CORPO_ERRORE_MASSIMO_BYTE;

    private final int timeoutConnessioneMs;
    private final int timeoutLetturaMs;

    public CaricatorePut() {
        this(TIMEOUT_CONNESSIONE_MS, TIMEOUT_LETTURA_MS);
    }

    /** Con tempi massimi diversi: i test li stringono per provare che una risposta che non arriva scada davvero. */
    public CaricatorePut(int timeoutConnessioneMs, int timeoutLetturaMs) {
        this.timeoutConnessioneMs = timeoutConnessioneMs;
        this.timeoutLetturaMs = timeoutLetturaMs;
    }

    @Override
    public EsitoPut invia(RichiestaPut richiesta) {
        File file = richiesta.file;
        if (file == null || !file.isFile()) return EsitoPut.fileAssente();
        if (file.length() != richiesta.byteTotali) return EsitoPut.pesoDiverso();
        final Interruzione interruzione = richiesta.interruzione;
        final long inizioNs = System.nanoTime();
        HttpURLConnection connessione = null;
        InputStream dalFile = null;
        long inviati = 0L;
        boolean connesso = false;
        boolean corpoCompleto = false;
        try {
            // `URI.create(...).toURL()` e non `new URL(String)`, deprecato dal JDK 20: l'indirizzo è già passato dalla politica degli host.
            connessione = (HttpURLConnection) URI.create(richiesta.url).toURL().openConnection();
            configura(connessione, richiesta.contentType, richiesta.byteTotali, timeoutConnessioneMs, timeoutLetturaMs);
            final HttpURLConnection daChiudere = connessione;
            // Se qualcuno ha già chiesto di fermarsi, `agganciaA` chiude subito: la PUT non parte nemmeno.
            interruzione.agganciaA(daChiudere::disconnect);
            dalFile = new FileInputStream(file);
            OutputStream alServer = connessione.getOutputStream();
            connesso = true;
            long tenutoPerLAvanzamentoMs = 0L;
            long ultimiByteComunicati = 0L;
            long unPercento = Math.max(1L, richiesta.byteTotali / 100L);
            byte[] blocco = new byte[BLOCCO_BYTE];
            while (inviati < richiesta.byteTotali) {
                if (interruzione.richiesta()) return fermata(connessione, inviati, inizioNs);
                int daLeggere = (int) Math.min(blocco.length, richiesta.byteTotali - inviati);
                int letti = dalFile.read(blocco, 0, daLeggere);
                if (letti < 0) {
                    // La copia è finita prima del peso dichiarato: con la lunghezza fissa non si può più completare.
                    connessione.disconnect();
                    return EsitoPut.pesoDiverso();
                }
                alServer.write(blocco, 0, letti);
                inviati += letti;
                long adessoMs = (System.nanoTime() - inizioNs) / 1_000_000L;
                if (adessoMs - tenutoPerLAvanzamentoMs >= INTERVALLO_AVANZAMENTO_MS || inviati - ultimiByteComunicati >= unPercento) {
                    tenutoPerLAvanzamentoMs = adessoMs;
                    ultimiByteComunicati = inviati;
                    richiesta.avanzamento.accept(inviati);
                }
            }
            if (inviati != ultimiByteComunicati) richiesta.avanzamento.accept(inviati);
            // Tutti i byte sono partiti: chiudere il corpo lo completa e il server può rispondere.
            alServer.close();
            corpoCompleto = true;
            return leggiLaRisposta(connessione, inviati, true, inizioNs);
        } catch (IOException | RuntimeException caduta) {
            if (interruzione.richiesta()) return EsitoPut.interrotto(inviati, durataMs(inizioNs));
            // Una risposta ANTICIPATA ha senso solo se il corpo non era finito: se la caduta è avvenuta mentre si LEGGEVA la risposta (tempo
            // scaduto, connessione persa) un secondo tentativo di lettura pagherebbe di nuovo il tempo massimo, per niente.
            return rispostaAnticipataOCaduta(connesso && !corpoCompleto ? connessione : null, caduta, inviati, inizioNs);
        } finally {
            chiudi(dalFile);
            if (connessione != null) connessione.disconnect();
            // Il gancio punta a una connessione che non esiste più: non va lasciato dove una `interrompi` tardiva lo chiamerebbe.
            interruzione.agganciaA(null);
        }
    }

    /**
     * Tutto ciò che si imposta su una connessione PRIMA di aprirla, in un punto solo e senza rete: così un test lo guarda senza
     * server. `setInstanceFollowRedirects(false)` conta davvero su Android, dove un 301/302 verrebbe seguito con una GET e il file
     * non andrebbe dove deve; solo `content-type` è un'intestazione nostra.
     */
    static void configura(HttpURLConnection connessione, String contentType, long byteTotali, int timeoutConnessioneMs,
                          int timeoutLetturaMs) throws IOException {
        connessione.setRequestMethod("PUT");
        connessione.setConnectTimeout(timeoutConnessioneMs);
        connessione.setReadTimeout(timeoutLetturaMs);
        // NIENTE `setUseCaches(false)`: `HttpURLConnection` lo traduce nelle intestazioni `Cache-Control: no-cache` e `Pragma: no-cache`
        // (misurato sul JDK dai test), e lo Storage prende il `cache-control` della richiesta come metadato dell'oggetto. Il server dichiara
        // solo `content-type` (§2.2: «niente cache-control»). Una cache di risposte per una PUT non esiste comunque: nessun `ResponseCache`.
        connessione.setInstanceFollowRedirects(false);
        connessione.setDoOutput(true);
        // La versione `long`: la `int` non basterebbe oltre i 2 GiB, e il tetto di un video è di 2.000.000.000 byte, vicinissimo.
        connessione.setFixedLengthStreamingMode(byteTotali);
        connessione.setRequestProperty("content-type", contentType);
    }

    /** L'interruzione chiesta mentre si scriveva: si chiude la connessione (sblocca anche una `write` ferma) e si restituisce. */
    private static EsitoPut fermata(HttpURLConnection connessione, long inviati, long inizioNs) {
        connessione.disconnect();
        return EsitoPut.interrotto(inviati, durataMs(inizioNs));
    }

    /**
     * La scrittura è caduta. Se il server ha risposto prima (un rifiuto che non ha aspettato il corpo) la risposta si legge e vale come
     * un esito; se non c'è, è una caduta di rete: la CLASSE dell'eccezione primaria resta nell'esito, mai il suo messaggio. `connessione`
     * è `null` se la caduta è avvenuta PRIMA di aprire il corpo (la connessione non c'è mai stata) o DOPO averlo finito (si stava già
     * leggendo la risposta): in entrambi i casi un secondo tentativo di lettura pagherebbe di nuovo il tempo massimo, per niente. Una
     * risposta letta così vale `completo = false`: il corpo non era finito quando il server ha parlato.
     */
    private EsitoPut rispostaAnticipataOCaduta(HttpURLConnection connessione, Throwable caduta, long inviati, long inizioNs) {
        if (connessione != null && !(caduta instanceof RuntimeException)) {
            try {
                return leggiLaRisposta(connessione, inviati, false, inizioNs);
            } catch (IOException | RuntimeException nessunaRisposta) {
                caduta.addSuppressed(nessunaRisposta);
            }
        }
        return EsitoPut.nessunaRisposta(inviati, durataMs(inizioNs), ClasseErrore.di(caduta));
    }

    /** Lo stato, `Retry-After` e i primi 4 KB del corpo di un rifiuto; per un 2xx il corpo non serve e si scarta. */
    private static EsitoPut leggiLaRisposta(HttpURLConnection connessione, long inviati, boolean completo, long inizioNs)
            throws IOException {
        int stato = connessione.getResponseCode();
        long retryAfter = PoliticaCaricamento.leggiRetryAfterSecondi(connessione.getHeaderField("Retry-After"), System.currentTimeMillis());
        byte[] corpo = new byte[0];
        if (stato >= 400) {
            InputStream errore = connessione.getErrorStream();
            if (errore != null) {
                try {
                    corpo = leggiFinoA(errore, CORPO_ERRORE_MASSIMO_BYTE);
                } finally {
                    chiudi(errore);
                }
            }
        }
        return EsitoPut.risposta(stato, corpo, retryAfter, inviati, durataMs(inizioNs), completo);
    }

    /** Legge al più `massimo` byte: il resto del corpo, se c'è, non interessa (e si chiude la connessione). */
    private static byte[] leggiFinoA(InputStream dentro, int massimo) throws IOException {
        ByteArrayOutputStream raccolti = new ByteArrayOutputStream();
        byte[] pezzo = new byte[1024];
        while (raccolti.size() < massimo) {
            int letti = dentro.read(pezzo, 0, Math.min(pezzo.length, massimo - raccolti.size()));
            if (letti < 0) break;
            raccolti.write(pezzo, 0, letti);
        }
        return raccolti.toByteArray();
    }

    private static long durataMs(long inizioNs) {
        return Math.max(0L, (System.nanoTime() - inizioNs) / 1_000_000L);
    }

    /**
     * Chiude un flusso a esito GIÀ NOTO: se la chiusura fallisce l'esito della PUT non cambia, e non c'è niente da fare né da dire
     * (la connessione si chiude comunque con `disconnect`, il file si rilascia con il processo).
     */
    private static void chiudi(Closeable flusso) {
        if (flusso == null) return;
        try {
            flusso.close();
        } catch (IOException chiusuraNonRiuscita) {
            // Vedi sopra.
        }
    }
}
