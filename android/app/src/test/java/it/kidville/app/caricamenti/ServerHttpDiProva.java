package it.kidville.app.caricamenti;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Un server HTTP minimo su `ServerSocket` per i test dei trasportatori nativi (`CaricatorePut`, `RinnovoFirma`), con i comportamenti che
 * un server vero può avere con un corpo di molti megabyte: leggerlo tutto e rispondere, RISPONDERE SUBITO senza leggerlo (un URL scaduto
 * o un duplicato, rifiutati dallo Storage prima del corpo), leggerlo e non rispondere mai, chiudere a metà, leggerlo con calma.
 * Non si usa `com.sun.net.httpserver`: i test si compilano contro android.jar, che non lo espone.
 *
 * Una connessione per thread: un test che ferma una PUT mentre un'altra richiesta è in corso non si blocca da solo.
 */
final class ServerHttpDiProva implements AutoCloseable {

    enum Modo {
        /** Legge tutto il corpo (secondo `Content-Length`) e poi risponde: il comportamento di un server che non ha fretta. */
        LEGGI_TUTTO_E_RISPONDI,
        /** Risponde appena letti gli header e chiude, senza leggere il corpo: un rifiuto anticipato. */
        RISPONDI_SUBITO_SENZA_LEGGERE,
        /** Legge tutto il corpo e poi non dice niente: una risposta che non arriva mai. */
        LEGGI_E_NON_RISPONDERE,
        /** Legge `chiudiDopoByte` byte e chiude la connessione senza rispondere: una caduta a metà. */
        CHIUDI_DOPO_N_BYTE,
        /** Legge il corpo a blocchi, dormendo `pausaPerBloccoMs` fra l'uno e l'altro: una rete lenta. */
        LEGGI_LENTAMENTE,
        /**
         * Non legge NIENTE del corpo per `fermoMs` e poi chiude: dopo qualche megabyte i buffer del socket sono pieni e la `write` del client
         * resta BLOCCATA. È una rete che non risponde: la sola cosa che sblocca quella `write` è chiudere la connessione.
         */
        NON_LEGGERE_IL_CORPO
    }

    /** Ciò che il server ha visto di una richiesta. */
    static final class Richiesta {
        volatile String metodo;
        volatile String percorso;
        /** Intestazioni, nomi senza distinzione di maiuscole, nell'ordine in cui sono arrivate per ogni nome. */
        final Map<String, List<String>> intestazioni = new TreeMap<>(String.CASE_INSENSITIVE_ORDER);
        /** Il corpo, se pesa al più 8 MB; altrimenti `null` (si guardano `byteLetti` e `sha256`). */
        volatile byte[] corpo;
        final AtomicLong byteLetti = new AtomicLong();
        volatile String sha256;

        String intestazione(String nome) {
            List<String> valori = intestazioni.get(nome);
            return valori == null || valori.isEmpty() ? null : valori.get(0);
        }

        boolean haIntestazione(String nome) {
            return intestazioni.containsKey(nome);
        }
    }

    private static final int CORPO_MASSIMO_REGISTRATO = 8 * 1024 * 1024;

    final ServerSocket ascolto;
    final List<Richiesta> richieste = Collections.synchronizedList(new ArrayList<Richiesta>());
    final AtomicInteger connessioni = new AtomicInteger();

    volatile Modo modo = Modo.LEGGI_TUTTO_E_RISPONDI;
    volatile int stato = 200;
    volatile String corpoRisposta = "{\"ok\":true}";
    volatile Map<String, String> intestazioniRisposta = new LinkedHashMap<>();
    volatile long chiudiDopoByte = 0L;
    volatile long pausaPerBloccoMs = 0L;
    volatile int bloccoLettura = 64 * 1024;
    /** Ritardo prima di rispondere, dopo aver letto il corpo (per provare il tempo massimo di lettura). */
    volatile long ritardoRispostaMs = 0L;
    /** Per `NON_LEGGERE_IL_CORPO`: per quanto tempo il server sta fermo prima di chiudere. */
    volatile long fermoMs = 20_000L;

    /** Scatta quando il server ha cominciato a leggere il corpo di una richiesta (almeno un byte). */
    final CountDownLatch corpoIniziato = new CountDownLatch(1);

    private volatile boolean chiuso = false;
    private final Thread filoDiAscolto;

    ServerHttpDiProva() throws IOException {
        this.ascolto = new ServerSocket(0, 50, InetAddress.getLoopbackAddress());
        this.filoDiAscolto = new Thread(this::cicloDiAscolto, "server-http-di-prova");
        this.filoDiAscolto.setDaemon(true);
        this.filoDiAscolto.start();
    }

    int porta() {
        return ascolto.getLocalPort();
    }

    String url(String percorso) {
        return "http://127.0.0.1:" + porta() + percorso;
    }

    Richiesta ultima() {
        synchronized (richieste) {
            return richieste.isEmpty() ? null : richieste.get(richieste.size() - 1);
        }
    }

    /** Aspetta che il server abbia visto almeno `quante` richieste (con le intestazioni lette). */
    boolean aspettaRichieste(int quante, long massimoMs) throws InterruptedException {
        long fine = System.nanoTime() + massimoMs * 1_000_000L;
        while (System.nanoTime() < fine) {
            if (richieste.size() >= quante) return true;
            Thread.sleep(10);
        }
        return richieste.size() >= quante;
    }

    private void cicloDiAscolto() {
        while (!chiuso) {
            try {
                final Socket connessione = ascolto.accept();
                connessioni.incrementAndGet();
                Thread filo = new Thread(() -> gestisci(connessione), "server-http-di-prova-connessione");
                filo.setDaemon(true);
                filo.start();
            } catch (IOException chiusuraOCaduta) {
                if (chiuso) return;
            }
        }
    }

    private static String leggiRiga(InputStream dentro) throws IOException {
        ByteArrayOutputStream riga = new ByteArrayOutputStream();
        int precedente = -1;
        int c;
        while ((c = dentro.read()) >= 0) {
            if (c == '\n' && precedente == '\r') {
                byte[] byteRiga = riga.toByteArray();
                return new String(byteRiga, 0, byteRiga.length - 1, StandardCharsets.ISO_8859_1);
            }
            riga.write(c);
            precedente = c;
        }
        throw new IOException("richiesta interrotta");
    }

    private void gestisci(Socket connessione) {
        try (Socket chiudiAlla = connessione) {
            connessione.setSoTimeout(30_000);
            InputStream dentro = connessione.getInputStream();
            OutputStream fuori = connessione.getOutputStream();
            Richiesta richiesta = new Richiesta();
            String primaRiga = leggiRiga(dentro);
            String[] parti = primaRiga.split(" ");
            richiesta.metodo = parti[0];
            richiesta.percorso = parti[1];
            String riga;
            while (!(riga = leggiRiga(dentro)).isEmpty()) {
                int duePunti = riga.indexOf(':');
                String nome = riga.substring(0, duePunti).trim();
                List<String> valori = richiesta.intestazioni.get(nome);
                if (valori == null) {
                    valori = new ArrayList<>();
                    richiesta.intestazioni.put(nome, valori);
                }
                valori.add(riga.substring(duePunti + 1).trim());
            }
            richieste.add(richiesta);
            long lunghezza = richiesta.intestazione("content-length") == null ? 0L : Long.parseLong(richiesta.intestazione("content-length"));

            if (modo == Modo.RISPONDI_SUBITO_SENZA_LEGGERE) {
                rispondi(fuori);
                // Chiude senza leggere: i byte ancora in viaggio trovano la porta chiusa (RST), come con uno Storage che rifiuta e chiude.
                return;
            }
            if (modo == Modo.NON_LEGGERE_IL_CORPO) {
                corpoIniziato.countDown();
                Thread.sleep(fermoMs);
                return;
            }

            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            ByteArrayOutputStream raccolto = lunghezza <= CORPO_MASSIMO_REGISTRATO ? new ByteArrayOutputStream((int) Math.max(lunghezza, 0)) : null;
            byte[] blocco = new byte[Math.max(1, bloccoLettura)];
            long letti = 0L;
            while (letti < lunghezza) {
                if (modo == Modo.CHIUDI_DOPO_N_BYTE && letti >= chiudiDopoByte) {
                    corpoIniziato.countDown();
                    return;
                }
                int daLeggere = (int) Math.min(blocco.length, lunghezza - letti);
                if (modo == Modo.CHIUDI_DOPO_N_BYTE) daLeggere = (int) Math.min(daLeggere, Math.max(1L, chiudiDopoByte - letti));
                int n = dentro.read(blocco, 0, daLeggere);
                if (n < 0) throw new IOException("corpo interrotto dopo " + letti + " byte");
                digest.update(blocco, 0, n);
                if (raccolto != null) raccolto.write(blocco, 0, n);
                letti += n;
                richiesta.byteLetti.set(letti);
                corpoIniziato.countDown();
                if (modo == Modo.LEGGI_LENTAMENTE && pausaPerBloccoMs > 0) Thread.sleep(pausaPerBloccoMs);
            }
            richiesta.sha256 = esadecimale(digest.digest());
            if (raccolto != null) richiesta.corpo = raccolto.toByteArray();
            if (modo == Modo.LEGGI_E_NON_RISPONDERE) {
                Thread.sleep(20_000);
                return;
            }
            if (ritardoRispostaMs > 0) Thread.sleep(ritardoRispostaMs);
            rispondi(fuori);
        } catch (IOException | InterruptedException | java.security.NoSuchAlgorithmException cadutaDelClient) {
            // Il client è caduto, o il test ha chiuso il server: la connessione finisce qui.
        }
    }

    private void rispondi(OutputStream fuori) throws IOException {
        byte[] risposta = corpoRisposta.getBytes(StandardCharsets.UTF_8);
        StringBuilder testa = new StringBuilder("HTTP/1.1 ").append(stato).append(" X\r\n");
        testa.append("Content-Type: application/json\r\nContent-Length: ").append(risposta.length).append("\r\nConnection: close\r\n");
        for (Map.Entry<String, String> voce : intestazioniRisposta.entrySet()) {
            testa.append(voce.getKey()).append(": ").append(voce.getValue()).append("\r\n");
        }
        testa.append("\r\n");
        fuori.write(testa.toString().getBytes(StandardCharsets.ISO_8859_1));
        fuori.write(risposta);
        fuori.flush();
    }

    private static String esadecimale(byte[] byteDelDigest) {
        StringBuilder s = new StringBuilder();
        for (byte b : byteDelDigest) s.append(String.format("%02x", b));
        return s.toString();
    }

    static String sha256Di(byte[] dati) throws java.security.NoSuchAlgorithmException {
        return esadecimale(MessageDigest.getInstance("SHA-256").digest(dati));
    }

    @Override
    public void close() {
        chiuso = true;
        try {
            ascolto.close();
        } catch (IOException giaChiuso) {
            // già chiuso: è ciò che si voleva
        }
        filoDiAscolto.interrupt();
    }

    /** Aspetta fino a `ms` che il latch scatti: un'attesa con un tetto, mai infinita. */
    static boolean aspetta(CountDownLatch latch, long ms) throws InterruptedException {
        return latch.await(ms, TimeUnit.MILLISECONDS);
    }
}
