package it.kidville.app.caricamenti;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import it.kidville.app.caricamenti.CodaCaricamenti.Origine;
import it.kidville.app.caricamenti.CodaCaricamenti.VoceCoda;
import it.kidville.app.caricamenti.EsecutoreCoda.EsitoCiclo;
import it.kidville.app.caricamenti.EsecutoreCoda.EsitoPut;
import it.kidville.app.caricamenti.EsecutoreCoda.RichiestaPut;
import it.kidville.app.caricamenti.EsecutoreCoda.RispostaHttp;
import it.kidville.app.caricamenti.PoliticaCaricamento.Codice;
import it.kidville.app.caricamenti.PoliticaCaricamento.EventoStato;
import it.kidville.app.caricamenti.PoliticaCaricamento.Stato;
import it.kidville.app.caricamenti.RegistroNativo.EventoRegistrato;
import it.kidville.app.caricamenti.SegretiCaricamenti.Esito;
import it.kidville.app.caricamenti.SegretiCaricamenti.Segreti;

import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Deque;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;

/**
 * L'esecutore della coda (spec §3, §4.3-4.6, §6.1, §6.2, §8, §11.1; compito A2): il ciclo sequenziale che rifà, voce per voce, il giro
 * della politica. Qui gira DAVVERO — coda su disco, segreti cifrati, registro, politica — con i soli confini finti: la PUT, il rinnovo,
 * la rete, l'orologio e l'ambiente. Ogni scenario di C1 che si può giudicare senza un telefono è provato qui, e ogni ORDINE che i
 * secondari di A1 hanno scoperto (rinnovo dopo `AVVIATO`, `urlScadeIl` azzerato dopo un rifiuto, segreti prima della coda, conteggio dei
 * rinnovi) ha il suo test che diventa rosso se si inverte.
 *
 * L'orologio è un contatore che si sposta a comando: l'attesa è un'addizione, e un giorno di rete caduta costa quanto un attimo.
 */
public class EsecutoreCodaTest {

    @Rule
    public TemporaryFolder temporanea = new TemporaryFolder();

    private final AtomicLong ora = new AtomicLong(1_790_000_000_000L);
    private File cartella;
    private CodaCaricamenti coda;
    private RegistroNativo registro;
    private CifrarioSoftware cifrario;
    private SegretiCaricamenti segreti;
    private FintoPut put;
    private FintoRinnovo rinnovo;
    private FintaRete rete;
    private FintoAmbiente ambiente;
    private FintaPresentazione presentazione;
    private EsecutoreCoda esecutore;
    private final List<String> osservate = Collections.synchronizedList(new ArrayList<String>());

    private static final long SECONDO = 1_000L;
    private static final long MINUTO = 60 * SECONDO;
    private static final long ORA_MS = 60 * MINUTO;
    private static final long TETTO_RETE_MS = 600 * SECONDO;
    private static final String TOKEN = "kvr_" + "A".repeat(43);
    private static final String URL_RINNOVO = "https://app.kidville.it/api/video-uploads/rinnovo";
    private static final String URL_REGISTRO = "https://app.kidville.it/api/logs";
    private static final String HOST_STORAGE = "https://uimulkjyekgemjakmepp.supabase.co/storage/v1/object/upload/sign/video_processing/";
    private static final int PESO = 5_000;

    private static String id(int n) {
        return String.format(Locale.ROOT, "%08x-1111-4111-8111-%012x", n, n);
    }

    private static final String UTENTE = id(2000);
    private static final String SCUOLA = id(3000);

    /* ────────────────────────────────────────────────────────────────────────────
     * I CONFINI FINTI
     * ──────────────────────────────────────────────────────────────────────────── */

    private final class FintoPut implements EsecutoreCoda.TrasportoPut {
        final Deque<Object> copione = new ArrayDeque<>();
        final List<RichiestaPut> richieste = Collections.synchronizedList(new ArrayList<RichiestaPut>());
        /** Una PUT che parte, e che per un attimo il test può guardare (fa da punto di sincronizzazione). */
        volatile Runnable allaPartenza = null;
        /** Cosa risponde quando il copione è finito: di norma `ok`, ma un test può farlo dipendere dalla voce. */
        volatile Function<RichiestaPut, EsitoPut> predefinita = r -> ok();

        FintoPut poi(Object... esiti) {
            copione.addAll(Arrays.asList(esiti));
            return this;
        }

        @SuppressWarnings("unchecked")
        @Override
        public EsitoPut invia(RichiestaPut richiesta) {
            richieste.add(richiesta);
            Runnable r = allaPartenza;
            if (r != null) r.run();
            Object prossimo = copione.pollFirst();
            if (prossimo == null) prossimo = predefinita;
            if (prossimo instanceof RuntimeException) throw (RuntimeException) prossimo;
            EsitoPut esito = prossimo instanceof Function ? ((Function<RichiestaPut, EsitoPut>) prossimo).apply(richiesta) : (EsitoPut) prossimo;
            if (esito.tipo != EsitoPut.Tipo.INTERROTTO) ora.addAndGet(esito.durataMs);
            return esito;
        }
    }

    private static EsitoPut ok() {
        return EsitoPut.risposta(200, null, 0L, PESO, 1_000L, true);
    }

    private static EsitoPut senzaRisposta() {
        return EsitoPut.nessunaRisposta(1_000L, 3_000L, RegistroNativo.ClasseErrore.IO);
    }

    private static EsitoPut server(int stato) {
        return EsitoPut.risposta(stato, null, 0L, 0L, 500L, false);
    }

    private static EsitoPut rifiuto(String errore, String statusCode, boolean completo, long durataMs) {
        byte[] corpo = ("{\"statusCode\":\"" + statusCode + "\",\"error\":\"" + errore + "\",\"message\":\"x\"}").getBytes(StandardCharsets.UTF_8);
        return EsitoPut.risposta(400, corpo, 0L, completo ? PESO : 100L, durataMs, completo);
    }

    private final class FintoRinnovo implements EsecutoreCoda.TrasportoRinnovo {
        final Deque<Object> copione = new ArrayDeque<>();
        final List<String[]> chiamate = Collections.synchronizedList(new ArrayList<String[]>());
        /** Cosa succede DENTRO la chiamata (il test guarda lo stato mentre il rinnovo è in volo). */
        volatile Runnable dentro = null;

        FintoRinnovo poi(Object... risposte) {
            copione.addAll(Arrays.asList(risposte));
            return this;
        }

        @Override
        public RispostaHttp rinnova(String url, String token) {
            chiamate.add(new String[]{url, token});
            Runnable r = dentro;
            if (r != null) r.run();
            Object prossimo = copione.pollFirst();
            if (prossimo == null) return daCaricare("nuovo");
            if (prossimo instanceof RuntimeException) throw (RuntimeException) prossimo;
            return (RispostaHttp) prossimo;
        }
    }

    private static RispostaHttp daCaricare(String contrassegno) {
        return new RispostaHttp(200, "{\"stato\":\"da-caricare\",\"caricamento\":{\"protocollo\":\"put\",\"url\":\"" + HOST_STORAGE + contrassegno
                + ".mp4?token=" + contrassegno + "\",\"metodo\":\"PUT\",\"intestazioni\":{\"content-type\":\"video/mp4\"}},\"scadeIl\":\"2026-10-05T10:00:00.000Z\"}",
                0L, null);
    }

    private static RispostaHttp arrivato() {
        return new RispostaHttp(200, "{\"stato\":\"arrivato\"}", 0L, null);
    }

    private static RispostaHttp annullato() {
        return new RispostaHttp(200, "{\"stato\":\"annullato\"}", 0L, null);
    }

    private static RispostaHttp trovatoNo() {
        return new RispostaHttp(404, "{\"codice\":\"VIDEO_NON_TROVATO\"}", 0L, null);
    }

    private final class FintaRete implements EsecutoreCoda.Rete {
        volatile boolean su = true;
        volatile long tornaAlle = Long.MAX_VALUE;
        final AtomicInteger attese = new AtomicInteger();
        /** Cosa succede alla prima attesa (per un test che agisce MENTRE si aspetta la rete). */
        volatile Runnable allaPrimaAttesa = null;

        @Override
        public boolean disponibile() {
            return su;
        }

        @Override
        public void attendi(long massimoMs) {
            if (attese.incrementAndGet() == 1 && allaPrimaAttesa != null) allaPrimaAttesa.run();
            ora.addAndGet(massimoMs);
            if (ora.get() >= tornaAlle) su = true;
        }
    }

    private final class FintoAmbiente implements EsecutoreCoda.Ambiente {
        final AtomicInteger daSvuotare = new AtomicInteger();
        final List<String> guasti = Collections.synchronizedList(new ArrayList<String>());
        volatile boolean inBackground = true;
        volatile boolean autorizzate = true;
        volatile double casuale = 0.5;
        final AtomicLong dormitoMs = new AtomicLong();

        @Override
        public long adesso() {
            return ora.get();
        }

        @Override
        public double casuale() {
            return casuale;
        }

        @Override
        public boolean debug() {
            return false;
        }

        @Override
        public boolean inBackground() {
            return inBackground;
        }

        @Override
        public boolean notificheAutorizzate() {
            return autorizzate;
        }

        @Override
        public void pausa(Object monitor, long ms) {
            // Il tempo non si aspetta, si somma: un'attesa di un giorno costa un attimo.
            dormitoMs.addAndGet(ms);
            ora.addAndGet(ms);
        }

        @Override
        public void registroDaSvuotare() {
            daSvuotare.incrementAndGet();
        }

        @Override
        public void guasto(String evento, Throwable causa) {
            guasti.add(evento + ":" + causa.getClass().getSimpleName());
        }
    }

    private static final class FintaPresentazione implements EsecutoreCoda.Presentazione {
        final List<long[]> avanzamenti = Collections.synchronizedList(new ArrayList<long[]>());
        final List<Boolean> attese = Collections.synchronizedList(new ArrayList<Boolean>());
        volatile boolean lancia = false;

        @Override
        public void avanzamento(long inviatiVoce, long totaleVoce, long inviatiNelGiro) {
            avanzamenti.add(new long[]{inviatiVoce, totaleVoce, inviatiNelGiro});
            if (lancia) throw new IllegalStateException("la notifica non si aggiorna");
        }

        @Override
        public void inAttesaDiRete(boolean inAttesa) {
            attese.add(inAttesa);
        }
    }

    @Before
    public void preparaIlBanco() throws IOException {
        cartella = temporanea.newFolder("caricamenti");
        coda = new CodaCaricamenti(cartella, ora::get);
        ambiente = new FintoAmbiente();
        registro = new RegistroNativo(new File(cartella, "registro.json"), "1.2+6", ora::get, (evento, causa) -> {
            throw new AssertionError("il registro ha avuto un guasto interno: " + evento);
        });
        cifrario = new CifrarioSoftware();
        segreti = new SegretiCaricamenti(coda, cifrario);
        put = new FintoPut();
        rinnovo = new FintoRinnovo();
        rete = new FintaRete();
        presentazione = new FintaPresentazione();
        esecutore = new EsecutoreCoda(coda, registro, segreti, put, rinnovo, rete, ambiente);
        esecutore.impostaOsservatore((voce, byteInviati) -> osservate.add(voce.stato.valore() + ":" + byteInviati));
    }

    @After
    public void nessunGuastoInaspettato() {
        // Ogni test che si aspetta un guasto lo svuota prima di finire: gli altri non ne devono avere.
        assertTrue("guasti interni imprevisti: " + ambiente.guasti, ambiente.guasti.isEmpty());
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * UTENSILI
     * ──────────────────────────────────────────────────────────────────────────── */

    /** Accoda una voce come farebbe `accodaVideo`: segreti salvati, file spostato in `file/`, token valido 48 ore. */
    private VoceCoda accoda(int n) throws IOException {
        return accoda(n, 2 * ORA_MS, 48 * ORA_MS);
    }

    private VoceCoda accoda(int n, long urlScadeInMs, long tokenScadeInMs) throws IOException {
        String job = id(n);
        File preparato = new File(cartella, "scelti/prova-" + n + ".mp4");
        preparato.getParentFile().mkdirs();
        try (FileOutputStream uscita = new FileOutputStream(preparato)) {
            uscita.write(new byte[PESO]);
        }
        segreti.salva(job, new Segreti(TOKEN, HOST_STORAGE + "primo-" + n + ".mp4?token=primo", "video/mp4", URL_RINNOVO, URL_REGISTRO));
        VoceCoda voce = VoceCoda.nuova(job, id(1000 + n), UTENTE, SCUOLA, "prova-" + n + ".mp4", "file/" + job + ".mp4", PESO, "video/mp4",
                Origine.GALLERIA, ora.get() + urlScadeInMs, ora.get() + tokenScadeInMs);
        coda.aggiungiSpostando(voce, preparato);
        return coda.trova(job);
    }

    private EsitoCiclo esegui() {
        return esecutore.esegui(presentazione, TETTO_RETE_MS);
    }

    private VoceCoda voce(int n) {
        return coda.trova(id(n));
    }

    private Stato stato(int n) {
        return voce(n).stato;
    }

    /** I messaggi del registro senza `: job=<uuid>`: `video-nativo-inviato`, `video-nativo-rinnovo da-caricare`... */
    private List<String> messaggi() {
        List<String> risultato = new ArrayList<>();
        for (EventoRegistrato e : registro.eventi()) risultato.add(senzaJob(e.messaggio));
        return risultato;
    }

    private static String senzaJob(String messaggio) {
        return messaggio.replaceAll(": job=[0-9a-f-]{36}", "").replaceAll(" job=[0-9a-f-]{36}", "");
    }

    private int conta(String prefisso) {
        int n = 0;
        for (String m : messaggi()) if (m.startsWith(prefisso)) n++;
        return n;
    }

    private EventoRegistrato evento(String prefisso) {
        for (EventoRegistrato e : registro.eventi()) if (senzaJob(e.messaggio).startsWith(prefisso)) return e;
        throw new AssertionError("nessun evento «" + prefisso + "» fra " + messaggi());
    }

    private static long numero(EventoRegistrato e, String chiave) {
        return ((Number) e.campi.get(chiave)).longValue();
    }

    private void verificaChiusuraPulita(int n, Stato atteso) {
        VoceCoda v = voce(n);
        assertSame(atteso, v.stato);
        assertNull("nessuna copia nominata", v.file);
        assertFalse("la copia non c'è più sul disco", new File(cartella, "file/" + id(n) + ".mp4").exists());
        assertFalse("i segreti non ci sono più", coda.fileSegreto(id(n)).exists());
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL GIRO NORMALE
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void unVideoNormaleVaInInvioEsceInviatoEChiudePulito() throws Exception {
        accoda(1);
        assertSame(EsitoCiclo.FINITO, esegui());
        verificaChiusuraPulita(1, Stato.INVIATO);
        assertEquals(Arrays.asList("video-nativo-inviato"), messaggi());
        EventoRegistrato inviato = registro.eventi().get(0);
        assertEquals(PESO, numero(inviato, "byte"));
        assertEquals("la durata della PUT", 1_000L, numero(inviato, "ms"));
        assertEquals(0L, numero(inviato, "tentativi"));
        assertEquals(0L, numero(inviato, "rinnovi"));
        assertEquals("put", inviato.campi.get("esito"));
        assertEquals("l'app è in background", Boolean.TRUE, inviato.campi.get("in_background"));
        assertEquals("una PUT sola, nessun rinnovo", 1, put.richieste.size());
        assertEquals(0, rinnovo.chiamate.size());
        assertEquals("il registro si svuota alla fine della voce", 1, ambiente.daSvuotare.get());
    }

    @Test
    public void inBackgroundVieneDallAmbienteAlMomentoDellInvio() throws Exception {
        accoda(1);
        ambiente.inBackground = false;
        esegui();
        assertEquals(Boolean.FALSE, evento("video-nativo-inviato").campi.get("in_background"));
    }

    @Test
    public void laPutVaAllUrlEAlContentTypeDeiSegretiENonDellaCoda() throws Exception {
        accoda(1);
        esegui();
        RichiestaPut r = put.richieste.get(0);
        assertEquals(HOST_STORAGE + "primo-1.mp4?token=primo", r.url);
        assertEquals("video/mp4", r.contentType);
        assertEquals(PESO, r.byteTotali);
        assertEquals("la copia che sta in file/", "file/" + id(1) + ".mp4", "file/" + r.file.getName());
        assertNotNull(r.interruzione);
    }

    @Test
    public void lOsservatoreVedeInInvioLAvanzamentoELInviato() throws Exception {
        accoda(1);
        put.poi((Function<RichiestaPut, EsitoPut>) r -> {
            r.avanzamento.accept(2_500L);
            ora.addAndGet(600L);
            r.avanzamento.accept(5_000L);
            return ok();
        });
        esegui();
        // Per una voce terminale l'osservatore riceve 0: è `aJsonPonte` a mettere `byteInviati = byteTotali` per `inviato`.
        assertEquals(Arrays.asList("in-invio:0", "in-invio:2500", "in-invio:5000", "inviato:0"), new ArrayList<>(osservate));
    }

    @Test
    public void laNotificaSiAggiornaAlPiuUnaVoltaAlSecondoEConIByteDelGiro() throws Exception {
        accoda(1);
        put.poi((Function<RichiestaPut, EsitoPut>) r -> {
            r.avanzamento.accept(1_000L);      // t = 0: si mostra
            ora.addAndGet(500L);
            r.avanzamento.accept(2_000L);      // t = 500 ms: troppo presto
            ora.addAndGet(1_000L);
            r.avanzamento.accept(4_000L);      // t = 1,5 s: si mostra
            return ok();
        });
        esegui();
        assertEquals(2, presentazione.avanzamenti.size());
        assertEquals(1_000L, presentazione.avanzamenti.get(0)[0]);
        assertEquals(PESO, presentazione.avanzamenti.get(0)[1]);
        assertEquals(4_000L, presentazione.avanzamenti.get(1)[0]);
        assertEquals("byte del giro: 4000 spediti, più il resto fino al totale non contato nel callback", 4_000L, presentazione.avanzamenti.get(1)[2]);
    }

    @Test
    public void unaNotificaCheLanciaNonFermaIlTrasferimentoEIlGuastoSiDice() throws Exception {
        accoda(1);
        presentazione.lancia = true;
        put.poi((Function<RichiestaPut, EsitoPut>) r -> {
            r.avanzamento.accept(1_000L);
            return ok();
        });
        esegui();
        verificaChiusuraPulita(1, Stato.INVIATO);
        assertEquals(Arrays.asList("avanzamento:IllegalStateException"), ambiente.guasti);
        ambiente.guasti.clear();
    }

    @Test
    public void lAvanzamentoInMemoriaSiVedeDuranteLaPutESiDimenticaAllaFine() throws Exception {
        accoda(1);
        AtomicLong visto = new AtomicLong(-1);
        put.poi((Function<RichiestaPut, EsitoPut>) r -> {
            r.avanzamento.accept(3_000L);
            visto.set(esecutore.byteInviati(id(1)));
            return ok();
        });
        esegui();
        assertEquals("durante la PUT il ponte legge i byte spediti", 3_000L, visto.get());
        assertEquals("a fine voce non resta niente in memoria", 0L, esecutore.byteInviati(id(1)));
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL RINNOVO PROATTIVO (S0) E I SUOI ORDINI
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void unUrlFirmatoDaPiuDiDieciMinutiSiRinnovaPrimaDellaPutEDopoAvviato() throws Exception {
        accoda(1, 2 * ORA_MS - 11 * MINUTO, 48 * ORA_MS);     // firmato 11 minuti fa
        AtomicReference<Stato> statoDuranteIlRinnovo = new AtomicReference<>();
        rinnovo.dentro = () -> statoDuranteIlRinnovo.set(stato(1));
        rinnovo.poi(daCaricare("rinnovato"));
        esegui();
        assertSame("il rinnovo si fa DOPO AVVIATO: da in-coda un `arrivato` non sarebbe ammesso (§4.4)", Stato.IN_INVIO, statoDuranteIlRinnovo.get());
        assertEquals(1, rinnovo.chiamate.size());
        assertEquals(URL_RINNOVO, rinnovo.chiamate.get(0)[0]);
        assertEquals(TOKEN, rinnovo.chiamate.get(0)[1]);
        assertTrue("la PUT parte sull'URL NUOVO", put.richieste.get(0).url.contains("rinnovato"));
        assertEquals(Arrays.asList("video-nativo-rinnovo da-caricare", "video-nativo-inviato"), messaggi());
        EventoRegistrato rinnovoLog = evento("video-nativo-rinnovo");
        assertEquals(1L, numero(rinnovoLog, "rinnovi"));
        assertFalse("il rinnovo proattivo non ha un nome d'errore", rinnovoLog.campi.containsKey("error_code"));
        assertEquals(200, rinnovoLog.stato.intValue());
        assertEquals(1L, numero(evento("video-nativo-inviato"), "rinnovi"));
    }

    @Test
    public void unUrlFirmatoDaMenoDiDieciMinutiNonSiRinnovaEDieciEsattiNemmeno() throws Exception {
        accoda(1, 2 * ORA_MS - 10 * MINUTO, 48 * ORA_MS);     // firmato esattamente 10 minuti fa
        esegui();
        assertEquals("a 10' esatti non basta (S0: «più di 10 minuti»)", 0, rinnovo.chiamate.size());
        accoda(2, 2 * ORA_MS - 10 * MINUTO + 1, 48 * ORA_MS);   // 10' meno un millisecondo
        esegui();
        assertEquals(0, rinnovo.chiamate.size());
        accoda(3, 2 * ORA_MS - 10 * MINUTO - 1, 48 * ORA_MS);   // 10' e un millisecondo
        esegui();
        assertEquals("a 10' e un millisecondo sì", 1, rinnovo.chiamate.size());
    }

    @Test
    public void unaScadenzaDelloUrlSconosciutaSiRinnovaPrima() throws Exception {
        accoda(1, 2 * ORA_MS, 48 * ORA_MS);
        coda.modifica(id(1), v -> v.urlScadeIl = 0L);
        esegui();
        assertEquals("spedire fino a 2 GB su un URL di cui non si sa l'età è la spesa che S0 vuole evitare", 1, rinnovo.chiamate.size());
    }

    @Test
    public void dopoUnRinnovoISegretiHannoIlNuovoUrlIlTokenDiPrimaELaCodaLaScadenzaDiRicezionePiu7200s() throws Exception {
        accoda(1, 2 * ORA_MS - 11 * MINUTO, 48 * ORA_MS);
        rinnovo.poi(daCaricare("rinnovato"));
        AtomicLong istanteDiRicezione = new AtomicLong();
        rinnovo.dentro = () -> istanteDiRicezione.set(ora.get());
        AtomicReference<Segreti> segretiAllaPut = new AtomicReference<>();
        AtomicReference<VoceCoda> voceAllaPut = new AtomicReference<>();
        put.allaPartenza = () -> {
            segretiAllaPut.set(segreti.leggi(id(1)).segreti);
            voceAllaPut.set(voce(1));
        };
        esegui();
        Segreti visti = segretiAllaPut.get();
        assertNotNull(visti);
        assertEquals("il token è quello di prima", TOKEN, visti.token);
        assertTrue("l'URL è quello nuovo", visti.urlPut.contains("rinnovato"));
        assertEquals("video/mp4", visti.contentType);
        assertEquals(URL_RINNOVO, visti.urlRinnovo);
        VoceCoda alla = voceAllaPut.get();
        assertEquals("scadenza dell'URL = istante di ricezione + 7200 s (la risposta porta solo quella del token)", istanteDiRicezione.get() + 7_200_000L, alla.urlScadeIl);
        assertEquals(1, alla.rinnovi);
        assertEquals("il rinnovo proattivo non alza il conto dei consecutivi", 0, alla.rinnoviConsecutivi);
        assertSame(Stato.IN_INVIO, alla.stato);
    }

    @Test
    public void seIlRinnovoNonRiesceASalvareIlNuovoUrlLaScadenzaRestaSconosciutaELaPutVaComunqueConQuelloInMemoria() throws Exception {
        accoda(1, 2 * ORA_MS - 11 * MINUTO, 48 * ORA_MS);
        // Un cifrario che smette di funzionare dopo il primo salvataggio (quello di `accoda`): il rinnovo non può riscrivere i segreti.
        final AtomicBoolean rotto = new AtomicBoolean(false);
        SegretiCaricamenti.Cifrario cheSiRompe = new SegretiCaricamenti.Cifrario() {
            @Override
            public byte[] cifra(byte[] chiaro, byte[] datiAssociati) throws java.security.GeneralSecurityException, IOException {
                if (rotto.get()) throw new java.security.GeneralSecurityException("Keystore non disponibile");
                return cifrario.cifra(chiaro, datiAssociati);
            }

            @Override
            public byte[] decifra(byte[] cifrato, byte[] datiAssociati) throws java.security.GeneralSecurityException, IOException {
                return cifrario.decifra(cifrato, datiAssociati);
            }
        };
        SegretiCaricamenti segretiCheSiRompono = new SegretiCaricamenti(coda, cheSiRompe);
        EsecutoreCoda esecutoreConKeystoreRotto = new EsecutoreCoda(coda, registro, segretiCheSiRompono, put, rinnovo, rete, ambiente);
        rotto.set(true);
        final long scadenzaIniziale = voce(1).urlScadeIl;
        rinnovo.poi(daCaricare("rinnovato"));
        AtomicReference<VoceCoda> allaPrimaPut = new AtomicReference<>();
        put.allaPartenza = () -> {
            if (allaPrimaPut.get() == null) allaPrimaPut.set(voce(1));
        };
        put.poi(server(503));
        esecutoreConKeystoreRotto.esegui(presentazione, TETTO_RETE_MS);
        // Due rinnovi (il primo, e quello dopo l'attesa: l'URL non si è mai rinfrescato), due volte il guasto, e un video comunque arrivato.
        assertEquals("il guasto si dice, con la sola classe", Arrays.asList("rinnovo-segreti-non-salvati:IOException", "rinnovo-segreti-non-salvati:IOException"),
                ambiente.guasti);
        ambiente.guasti.clear();
        assertTrue("la PUT è partita sull'URL NUOVO, tenuto in memoria", put.richieste.get(0).url.contains("rinnovato"));
        assertEquals("e la scadenza dell'URL è rimasta quella di prima, NON «fresca»: dopo un riavvio si rinnoverebbe di nuovo",
                scadenzaIniziale, allaPrimaPut.get().urlScadeIl);
        verificaChiusuraPulita(1, Stato.INVIATO);
    }

    /**
     * L'esecutore NON VEDE MAI una voce prima dei suoi segreti. `accodaVideo` salva i segreti (che qui il cifrario tiene fermi) e SOLO
     * dopo accoda la voce: se l'ordine fosse l'inverso, un ciclo che gira in quel momento la troverebbe senza segreti e la darebbe per
     * perduta (`fallito INTERNO`).
     */
    @Test(timeout = 60_000)
    public void unaVoceCheSiStaAccodandoNonSiVedeFinoAChePortaConSeISuoiSegreti() throws Exception {
        final CountDownLatch dentroIlCifrario = new CountDownLatch(1);
        final CountDownLatch via = new CountDownLatch(1);
        SegretiCaricamenti.Cifrario lento = new SegretiCaricamenti.Cifrario() {
            @Override
            public byte[] cifra(byte[] chiaro, byte[] datiAssociati) throws java.security.GeneralSecurityException, IOException {
                dentroIlCifrario.countDown();
                try {
                    via.await(20, TimeUnit.SECONDS);
                } catch (InterruptedException interrotto) {
                    Thread.currentThread().interrupt();
                }
                return cifrario.cifra(chiaro, datiAssociati);
            }

            @Override
            public byte[] decifra(byte[] cifrato, byte[] datiAssociati) throws java.security.GeneralSecurityException, IOException {
                return cifrario.decifra(cifrato, datiAssociati);
            }
        };
        final SegretiCaricamenti segretiLenti = new SegretiCaricamenti(coda, lento);
        final EsecutoreCoda esecutoreLento = new EsecutoreCoda(coda, registro, segretiLenti, put, rinnovo, rete, ambiente);
        File preparato = new File(cartella, "scelti/prova-1.mp4");
        preparato.getParentFile().mkdirs();
        try (FileOutputStream uscita = new FileOutputStream(preparato)) {
            uscita.write(new byte[PESO]);
        }
        final String job = id(1);
        final AtomicReference<Throwable> errore = new AtomicReference<>();
        // Come `PianificatoreCaricamenti.accoda`: i segreti PRIMA, poi la voce.
        Thread accodamento = new Thread(() -> {
            try {
                segretiLenti.salva(job, new Segreti(TOKEN, HOST_STORAGE + "x.mp4?token=a", "video/mp4", URL_RINNOVO, URL_REGISTRO));
                coda.aggiungiSpostando(VoceCoda.nuova(job, id(1001), UTENTE, SCUOLA, "prova-1.mp4", "file/" + job + ".mp4", PESO, "video/mp4",
                        Origine.GALLERIA, ora.get() + 2 * ORA_MS, ora.get() + 48 * ORA_MS), new File(cartella, "scelti/prova-1.mp4"));
            } catch (Throwable guasto) {
                errore.set(guasto);
            }
        });
        accodamento.start();
        assertTrue(dentroIlCifrario.await(10, TimeUnit.SECONDS));
        // Mentre i segreti si stanno ancora cifrando, un ciclo che gira non deve trovare la voce.
        assertSame("nessuna voce ancora: niente da fare", EsitoCiclo.FINITO, esecutoreLento.esegui(presentazione, TETTO_RETE_MS));
        assertEquals("e niente è stato dichiarato perduto", 0, conta("video-nativo-fallito"));
        assertNull(coda.trova(job));
        via.countDown();
        accodamento.join(20_000);
        assertNull(errore.get());
        assertSame(Stato.IN_CODA, stato(1));
        assertSame("e adesso, coi segreti, parte e arriva", EsitoCiclo.FINITO, esecutoreLento.esegui(presentazione, TETTO_RETE_MS));
        verificaChiusuraPulita(1, Stato.INVIATO);
    }

    @Test
    public void ilRinnovoSalvaSoloLUrlENonRiportaIndietroUnTokenRuotatoNelFrattempo() throws Exception {
        accoda(1, 2 * ORA_MS - 11 * MINUTO, 48 * ORA_MS);
        final String tokenRuotato = "kvr_" + "R".repeat(43);
        // Durante la chiamata al rinnovo `accodaVideo` ruota il token: il rinnovo che torna salva SOLO l'URL (ordine 3 e `aggiorna`).
        rinnovo.dentro = () -> {
            try {
                segreti.salva(id(1), new Segreti(tokenRuotato, HOST_STORAGE + "primo-1.mp4?token=primo", "video/mp4", URL_RINNOVO, URL_REGISTRO));
            } catch (IOException impossibile) {
                throw new AssertionError(impossibile);
            }
        };
        rinnovo.poi(daCaricare("rinnovato"));
        AtomicReference<Segreti> segretiAllaPut = new AtomicReference<>();
        put.allaPartenza = () -> segretiAllaPut.set(segreti.leggi(id(1)).segreti);
        esegui();
        assertEquals("il token ruotato resta", tokenRuotato, segretiAllaPut.get().token);
        assertTrue("e l'URL è quello nuovo", segretiAllaPut.get().urlPut.contains("rinnovato"));
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * LA RETE
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void cadeAMetaConLaReteCheCiEPoiRiparteDopoLaPrimaAttesaDi30Secondi() throws Exception {
        accoda(1);
        put.poi(senzaRisposta());
        long inizio = ora.get();
        assertSame(EsitoCiclo.FINITO, esegui());
        verificaChiusuraPulita(1, Stato.INVIATO);
        assertEquals(Arrays.asList("video-nativo-ritento RETE", "video-nativo-inviato"), messaggi());
        assertEquals(1L, numero(evento("video-nativo-inviato"), "tentativi"));
        EventoRegistrato ritento = evento("video-nativo-ritento");
        assertEquals(1L, numero(ritento, "tentativo"));
        assertEquals("la prima attesa è di 30 s", 30L, numero(ritento, "attesa_s"));
        assertEquals("nessuna risposta: stato 0", 0, ritento.stato.intValue());
        assertEquals(30_000L, ambiente.dormitoMs.get());
        assertEquals("URL fresco: nessun rinnovo", 0, rinnovo.chiamate.size());
        assertEquals(2, put.richieste.size());
        assertTrue(ora.get() - inizio >= 30_000L);
    }

    @Test
    public void unaCadutaDiReteLasciaLaVoceInAttesaConIlRitardoESenzaInviarla() throws Exception {
        accoda(1);
        put.poi(senzaRisposta());
        AtomicReference<VoceCoda> durante = new AtomicReference<>();
        put.allaPartenza = () -> {
            if (put.richieste.size() == 2) durante.set(voce(1));
        };
        esegui();
        VoceCoda alSecondoGiro = durante.get();
        assertNotNull(alSecondoGiro);
        assertSame("al secondo giro la voce era in-invio (ripresa)", Stato.IN_INVIO, alSecondoGiro.stato);
        assertEquals(1, alSecondoGiro.tentativi);
        assertEquals(0, alSecondoGiro.rinnoviConsecutivi);
    }

    @Test
    public void conLaReteAssenteAllAvvioLeVociVannoInAttesaSenzaConsumareUnTentativoERipartonoSubitoAlRitorno() throws Exception {
        accoda(1);
        rete.su = false;
        rete.tornaAlle = ora.get() + 20 * SECONDO;      // torna dopo 20 s
        long inizio = ora.get();
        assertSame(EsitoCiclo.FINITO, esegui());
        verificaChiusuraPulita(1, Stato.INVIATO);
        assertEquals("nessun tentativo consumato: non c'era niente da tentare", 0L, numero(evento("video-nativo-inviato"), "tentativi"));
        assertEquals("niente ritento: la rete assente non è un guasto", 0, conta("video-nativo-ritento"));
        assertTrue("è ripartita appena tornata la rete, non dopo 30 s di ritardo: " + (ora.get() - inizio) + " ms", ora.get() - inizio < 30_000L);
        assertEquals("la notifica ha cambiato testo e poi è tornata", Arrays.asList(true, false), new ArrayList<>(presentazione.attese));
        assertEquals("una sola PUT, quando la rete c'era", 1, put.richieste.size());
        assertEquals("sotto i 60 s non si scrive video-nativo-attesa-rete", 0, conta("video-nativo-attesa-rete"));
    }

    @Test
    public void unaReteAssentePiuDiSessantaSecondiSiScriveUnaVoltaPerVoceConLaNotificaELAutorizzazione() throws Exception {
        accoda(1);
        accoda(2);
        rete.su = false;
        rete.tornaAlle = ora.get() + 130 * SECONDO;
        ambiente.autorizzate = false;
        esegui();
        assertEquals("una riga per ogni voce in attesa, una volta sola", 2, conta("video-nativo-attesa-rete"));
        EventoRegistrato attesa = evento("video-nativo-attesa-rete");
        assertEquals(Boolean.FALSE, attesa.campi.get("autorizzata"));
        assertEquals(Boolean.FALSE, attesa.campi.get("notifica"));
    }

    @Test
    public void unaCadutaDiReteDuranteLaPutConLaReteChePoiMancaRipartePerLaRete() throws Exception {
        accoda(1);
        put.poi((Function<RichiestaPut, EsitoPut>) r -> {
            rete.su = false;                         // la rete cade MENTRE si spedisce
            rete.tornaAlle = ora.get() + 90 * SECONDO;
            return senzaRisposta();
        });
        long inizio = ora.get();
        assertSame(EsitoCiclo.FINITO, esegui());
        verificaChiusuraPulita(1, Stato.INVIATO);
        assertEquals("il ritento RETE c'è, perché la PUT ha provato", 1, conta("video-nativo-ritento"));
        // Tornata la rete la voce riparte SUBITO: il suo ritardo di 30 s è trascorso insieme all'attesa, comunque più lunga.
        assertTrue(ora.get() - inizio < 120 * SECONDO);
        assertEquals(1, conta("video-nativo-attesa-rete"));
    }

    @Test
    public void tornataLaReteLeVociInAttesaReteRipartonoSubitoAncheSeIlLoroRitardoEraPiuLungo() throws Exception {
        accoda(1);
        coda.modifica(id(1), v -> v.tentativi = 5);          // il prossimo ritardo sarebbe di 15 minuti (30 s, 1', 2', 5', 10', 15')
        put.poi((Function<RichiestaPut, EsitoPut>) r -> {
            rete.su = false;                                  // la rete cade durante la PUT e torna dopo un minuto
            rete.tornaAlle = ora.get() + 60 * SECONDO;
            return senzaRisposta();
        });
        long inizio = ora.get();
        assertSame(EsitoCiclo.FINITO, esegui());
        verificaChiusuraPulita(1, Stato.INVIATO);
        assertTrue("riparte appena torna la rete (~1 minuto), non dopo i 15 minuti del ritardo: " + (ora.get() - inizio) / 1000 + " s",
                ora.get() - inizio < 5 * MINUTO);
        assertEquals("il ritento RETE c'è (6° tentativo: non si logga, 6 non è una potenza di due)", 0, conta("video-nativo-ritento"));
        assertEquals(6, voce(1).tentativi);
    }

    @Test
    public void annullareMentreSiAspettaLaReteFaUscireIlCicloSenzaAspettareIlTettoELaNotificaTornaNormale() throws Exception {
        accoda(1);
        rete.su = false;                                      // la rete non torna mai
        rete.allaPrimaAttesa = () -> assertTrue(esecutore.annulla(id(1)));
        long inizio = ora.get();
        assertSame("nessuna voce viva: il ciclo finisce, non aspetta 10 minuti inutilmente", EsitoCiclo.FINITO, esegui());
        assertTrue("ha aspettato pochi secondi: " + (ora.get() - inizio) + " ms", ora.get() - inizio < 10 * SECONDO);
        assertEquals("la notifica di attesa si chiude prima di rilasciare il ciclo", Arrays.asList(true, false), new ArrayList<>(presentazione.attese));
        verificaChiusuraPulita(1, Stato.ANNULLATO);
        assertFalse(esecutore.attivo());
    }

    @Test
    public void unaReteAssenteOltreIlTettoDelGuscioRestituisceRiprovaELeVociRestanoInAttesa() throws Exception {
        accoda(1);
        rete.su = false;
        long inizio = ora.get();
        assertSame(EsitoCiclo.RIPROVA, esegui());
        assertTrue("ha aspettato il tetto di 10 minuti", ora.get() - inizio >= TETTO_RETE_MS);
        assertTrue(ora.get() - inizio < TETTO_RETE_MS + 5 * SECONDO);
        assertSame(Stato.IN_ATTESA, stato(1));
        assertSame(Codice.RETE, voce(1).codice);
        assertEquals("nessun tentativo: la rete non c'era", 0, voce(1).tentativi);
        assertEquals("pronta a ripartire subito", 0L, voce(1).prossimoTentativoIl);
        assertEquals("nessuna PUT", 0, put.richieste.size());
        assertEquals("la notifica torna normale anche uscendo", Arrays.asList(true, false), new ArrayList<>(presentazione.attese));
        assertTrue(new File(cartella, "file/" + id(1) + ".mp4").exists());
        // Il giro dopo (con la rete) riparte da lì e arriva.
        rete.su = true;
        assertSame(EsitoCiclo.FINITO, esegui());
        verificaChiusuraPulita(1, Stato.INVIATO);
    }

    @Test
    public void piuGiriDiReteAssenteNonFannoScadereIlTokenSeVale() throws Exception {
        accoda(1, 2 * ORA_MS, 30 * MINUTO);          // il token vale 30 minuti
        rete.su = false;
        rete.tornaAlle = ora.get() + 20 * MINUTO;     // la rete manca 20 minuti, ma il tetto del guscio è 10': due giri
        assertSame(EsitoCiclo.RIPROVA, esegui());
        assertSame(EsitoCiclo.FINITO, esegui());
        verificaChiusuraPulita(1, Stato.INVIATO);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * GLI ESITI DELLA PUT (tabella §4.5)
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void unUrlRifiutatoSiRinnovaERiparteSubitoConLUrlScadeIlAzzeratoDuranteIlRinnovo() throws Exception {
        accoda(1);
        put.poi(rifiuto("InvalidJWT", "400", false, 70L));
        AtomicLong urlScadeIlDuranteIlRinnovo = new AtomicLong(-1);
        rinnovo.dentro = () -> urlScadeIlDuranteIlRinnovo.set(voce(1).urlScadeIl);
        long inizio = ora.get();
        esegui();
        verificaChiusuraPulita(1, Stato.INVIATO);
        assertEquals("dopo un rifiuto l'URL è «sconosciuto» finché il rinnovo non ne consegna uno (ordine 2)", 0L, urlScadeIlDuranteIlRinnovo.get());
        assertEquals(Arrays.asList("video-nativo-rinnovo da-caricare", "video-nativo-inviato"), messaggi());
        EventoRegistrato rinnovoLog = evento("video-nativo-rinnovo");
        assertEquals("il nome d'errore dello Storage che ha chiesto il rinnovo", "InvalidJWT", rinnovoLog.campi.get("error_code"));
        assertEquals(1L, numero(rinnovoLog, "rinnovi"));
        assertEquals("non è «oltre la scadenza»: il trasferimento non era completo", 0, conta("put-oltre-scadenza"));
        assertEquals(2, put.richieste.size());
        assertTrue("la seconda PUT è subito, senza attese: " + (ora.get() - inizio) + " ms", ora.get() - inizio < 5_000L);
        assertEquals("la PUT dopo il rinnovo usa l'URL nuovo", true, put.richieste.get(1).url.contains("nuovo"));
    }

    @Test
    public void laFirmaScadutaDuranteUnInvioLungoLasciaIlLogPutOltreScadenzaConLaDurata() throws Exception {
        accoda(1);
        put.poi(rifiuto("InvalidJWT", "400", true, 7_812_000L));         // 2 h 10' di PUT, poi 400 InvalidJWT (S0-b)
        esegui();
        verificaChiusuraPulita(1, Stato.INVIATO);
        assertEquals(Arrays.asList("put-oltre-scadenza", "video-nativo-rinnovo da-caricare", "video-nativo-inviato"), messaggi());
        EventoRegistrato oltre = evento("put-oltre-scadenza");
        assertEquals("la durata del trasferimento in secondi", 7_812L, numero(oltre, "durata_s"));
        assertEquals(Integer.valueOf(400), oltre.stato);
    }

    @Test
    public void laSecondaPutRifiutataComeDuplicatoSiChiudeComeGiaArrivatoSenzaUnaTerzaPut() throws Exception {
        accoda(1);
        put.poi(rifiuto("Duplicate", "409", true, 2_000L));
        rinnovo.poi(arrivato());
        esegui();
        verificaChiusuraPulita(1, Stato.INVIATO);
        assertEquals(Arrays.asList("video-nativo-rinnovo arrivato", "video-nativo-inviato"), messaggi());
        EventoRegistrato inviato = evento("video-nativo-inviato");
        assertEquals("gia-arrivato", inviato.campi.get("esito"));
        assertEquals("Duplicate", evento("video-nativo-rinnovo").campi.get("error_code"));
        assertEquals("nessun URL nuovo: nessun rinnovo contato", 0L, numero(inviato, "rinnovi"));
        assertEquals("una PUT sola", 1, put.richieste.size());
        assertEquals("ms zero: non c'è stato nessun trasferimento nuovo", 0L, numero(inviato, "ms"));
    }

    @Test
    public void unRinnovoNegatoFallisceConTokenNonValidoENonLasciaNiente() throws Exception {
        accoda(1);
        put.poi(rifiuto("Unauthorized", "403", false, 60L));
        rinnovo.poi(trovatoNo());
        esegui();
        verificaChiusuraPulita(1, Stato.FALLITO);
        assertSame(Codice.TOKEN_NON_VALIDO, voce(1).codice);
        assertEquals(Arrays.asList("video-nativo-rinnovo negato", "video-nativo-fallito TOKEN_NON_VALIDO"), messaggi());
        assertEquals("rinnovo", evento("video-nativo-fallito").campi.get("operazione"));
        assertSame("l'ultimo è un errore", RegistroNativo.Livello.ERROR, registro.eventi().get(1).livello);
        assertEquals(404, evento("video-nativo-rinnovo").stato.intValue());
    }

    @Test
    public void unRinnovoChePuntaAUnTokenRuotatoRiprovaConQuelloENonFallisce() throws Exception {
        accoda(1);
        final String tokenNuovo = "kvr_" + "N".repeat(43);
        put.poi(rifiuto("Unauthorized", "403", false, 60L));
        AtomicBoolean primaVolta = new AtomicBoolean(true);
        rinnovo.dentro = () -> {
            if (primaVolta.getAndSet(false)) {
                // L'apertura ripetuta ha ruotato il token mentre il rinnovo col vecchio era in volo: il server risponde 404 al vecchio.
                try {
                    segreti.salva(id(1), new Segreti(tokenNuovo, HOST_STORAGE + "primo-1.mp4?token=primo", "video/mp4", URL_RINNOVO, URL_REGISTRO));
                } catch (IOException impossibile) {
                    throw new AssertionError(impossibile);
                }
            }
        };
        rinnovo.poi(trovatoNo(), daCaricare("conTokenNuovo"));
        esegui();
        verificaChiusuraPulita(1, Stato.INVIATO);
        assertEquals(2, rinnovo.chiamate.size());
        assertEquals(TOKEN, rinnovo.chiamate.get(0)[1]);
        assertEquals("il secondo rinnovo usa il token nuovo", tokenNuovo, rinnovo.chiamate.get(1)[1]);
        assertEquals(Arrays.asList("video-nativo-rinnovo negato", "video-nativo-rinnovo da-caricare", "video-nativo-inviato"), messaggi());
    }

    @Test
    public void unQuattroCentoQuattroConLoStessoTokenDueVolteNonSiRiprovaALungo() throws Exception {
        accoda(1);
        put.poi(rifiuto("Unauthorized", "403", false, 60L));
        rinnovo.poi(trovatoNo(), trovatoNo(), trovatoNo(), trovatoNo());
        esegui();
        assertSame(Stato.FALLITO, stato(1));
        assertEquals("un solo rinnovo: il token riletto è lo stesso, non c'è niente di più recente da provare", 1, rinnovo.chiamate.size());
    }

    @Test
    public void ilRinnovoAnnullatoChiudeLaVoceComeAnnullataDalServer() throws Exception {
        accoda(1);
        put.poi(rifiuto("InvalidRequest", "400", false, 40L));
        rinnovo.poi(annullato());
        esegui();
        verificaChiusuraPulita(1, Stato.ANNULLATO);
        assertSame(Codice.ANNULLATO_DAL_SERVER, voce(1).codice);
        assertEquals(Arrays.asList("video-nativo-rinnovo annullato", "video-nativo-annullato server"), messaggi());
        assertEquals(1, ambiente.daSvuotare.get());
    }

    @Test
    public void unTroppoGrandeNelCorpoFallisceSenzaChiamareIlRinnovo() throws Exception {
        accoda(1);
        put.poi(rifiuto("EntityTooLarge", "413", true, 4_000L));
        esegui();
        verificaChiusuraPulita(1, Stato.FALLITO);
        assertSame(Codice.TROPPO_GRANDE, voce(1).codice);
        assertEquals(0, rinnovo.chiamate.size());
        assertEquals(Arrays.asList("video-nativo-fallito TROPPO_GRANDE"), messaggi());
        assertEquals("put", evento("video-nativo-fallito").campi.get("operazione"));
    }

    @Test
    public void unCicloDiFirmeRifiutateSiFermaAlQuartoRinnovoConRinnovoCiclicoEUnRinnovoDaCaricareNelLog() throws Exception {
        accoda(1);
        for (int i = 0; i < 10; i++) put.poi(rifiuto("InvalidJWT", "400", true, 7_800_000L));
        esegui();
        verificaChiusuraPulita(1, Stato.FALLITO);
        VoceCoda v = voce(1);
        assertSame(Codice.RINNOVO_CICLICO, v.codice);
        assertEquals("quattro PUT rifiutate, quattro chiamate al rinnovo (la quarta dice «da-caricare» e si ferma)", 4, put.richieste.size());
        assertEquals(4, rinnovo.chiamate.size());
        assertEquals(4, v.rinnovi);
        assertEquals("il quarto rinnovo non alza più il contatore: si ferma", 3, v.rinnoviConsecutivi);
        assertEquals(4, conta("put-oltre-scadenza"));
        // I rinnovi si diradano (potenze di due): il 1°, il 2° e il 4° — il 3° no. E il rinnovo che fa scattare il tetto ha risposto
        // `da-caricare`: RINNOVO_CICLICO è un CODICE di `video-nativo-fallito`, non un esito del rinnovo.
        assertEquals(3, conta("video-nativo-rinnovo da-caricare"));
        assertEquals(0, conta("video-nativo-rinnovo tetto"));
        List<String> m = messaggi();
        assertEquals("video-nativo-fallito RINNOVO_CICLICO", m.get(m.size() - 1));
        assertEquals("video-nativo-rinnovo da-caricare", m.get(m.size() - 2));
        assertEquals(4L, numero(evento("video-nativo-fallito"), "rinnovi"));
        assertEquals("rinnovo", evento("video-nativo-fallito").campi.get("operazione"));
        assertEquals("nemmeno qui il registro esplode", 8, m.size());
    }

    @Test
    public void unRinnovoLimitatoAspettaIlRetryAfterEILogLoChiamaTetto() throws Exception {
        accoda(1);
        put.poi(rifiuto("InvalidJWT", "400", false, 50L));
        rinnovo.poi(new RispostaHttp(429, "{\"codice\":\"TROPPE_RICHIESTE\"}", 120L, null), daCaricare("dopoIl429"));
        esegui();
        verificaChiusuraPulita(1, Stato.INVIATO);
        assertTrue("l'attesa è almeno il Retry-After: " + ambiente.dormitoMs.get(), ambiente.dormitoMs.get() >= 120_000L);
        assertEquals(2, rinnovo.chiamate.size());
        assertEquals("il 429 sono i tetti del rinnovo: esito tetto (come su iOS)", "video-nativo-rinnovo tetto", messaggi().get(0));
        assertEquals(429, registro.eventi().get(0).stato.intValue());
        assertEquals("poi il ritento col suo Retry-After", "video-nativo-ritento SERVER", messaggi().get(1));
        assertEquals(120L, numero(registro.eventi().get(1), "attesa_s"));
    }

    @Test
    public void unRinnovoCheCadeInRetePerLaVoceInAttesaEPoiRiesce() throws Exception {
        accoda(1);
        put.poi(rifiuto("InvalidJWT", "400", false, 50L));
        rinnovo.poi(RispostaHttp.nessunaRisposta(RegistroNativo.ClasseErrore.IO), daCaricare("dopoLaRete"));
        esegui();
        verificaChiusuraPulita(1, Stato.INVIATO);
        assertEquals(Arrays.asList("video-nativo-rinnovo rete", "video-nativo-ritento RETE", "video-nativo-rinnovo da-caricare", "video-nativo-inviato"), messaggi());
        assertEquals("nessuna risposta: stato 0", 0, registro.eventi().get(0).stato.intValue());
    }

    @Test
    public void unGuastoLungoDelloStorageNonFaMaiRinnovoCiclicoEIlRegistroNonInsiste() throws Exception {
        accoda(1);
        for (int i = 0; i < 40; i++) put.poi(server(503));
        esegui();
        verificaChiusuraPulita(1, Stato.INVIATO);
        VoceCoda v = voce(1);
        assertEquals(40, v.tentativi);
        assertEquals("un transitorio azzera il conto: mai un ciclo", 0, v.rinnoviConsecutivi);
        assertTrue("dopo i primi dieci minuti ogni ripresa rinnova (URL con più di 10'): " + v.rinnovi, v.rinnovi >= 30);
        List<Integer> tentativiLoggati = new ArrayList<>();
        for (EventoRegistrato e : registro.eventi()) {
            if (e.messaggio.startsWith("video-nativo-ritento")) tentativiLoggati.add(((Number) e.campi.get("tentativo")).intValue());
        }
        assertEquals("i ritentativi si loggano ai tentativi 1, 2, 4, 8, 16, 32: la coda insiste, il registro no",
                Arrays.asList(1, 2, 4, 8, 16, 32), tentativiLoggati);
        // I rinnovi si diradano (secondario n. 48): potenze di due del loro conteggio, non uno a ogni ripresa.
        List<Long> contatoriDeiRinnoviLoggati = new ArrayList<>();
        for (EventoRegistrato e : registro.eventi()) {
            if (e.messaggio.startsWith("video-nativo-rinnovo")) contatoriDeiRinnoviLoggati.add(numero(e, "rinnovi"));
        }
        assertEquals("potenze di due e niente di più", Arrays.asList(1L, 2L, 4L, 8L, 16L, 32L), contatoriDeiRinnoviLoggati);
        assertTrue("il registro resta piccolo: " + registro.numeroEventi() + " righe per " + v.rinnovi + " rinnovi", registro.numeroEventi() <= 14);
    }

    @Test
    public void unaCadutaDiReteDiUnGiornoInteroNonFinisceMaiInErroreDentroLaVitaDelToken() throws Exception {
        accoda(1);
        for (int i = 0; i < 100; i++) put.poi(senzaRisposta());
        esegui();
        verificaChiusuraPulita(1, Stato.INVIATO);
        VoceCoda v = voce(1);
        assertEquals(100, v.tentativi);
        assertTrue("circa un giorno di attesa: " + ambiente.dormitoMs.get() / ORA_MS + " ore", ambiente.dormitoMs.get() > 20 * ORA_MS && ambiente.dormitoMs.get() < 30 * ORA_MS);
        assertEquals(0, v.rinnoviConsecutivi);
        assertEquals("cento tentativi, sette righe di ritento: 1, 2, 4, 8, 16, 32, 64", 7, conta("video-nativo-ritento"));
        assertTrue(registro.numeroEventi() <= RegistroNativo.TETTO_EVENTI);
    }

    @Test
    public void ilTokenCheScadeMentreSiAspettaFallisceConTokenScaduto() throws Exception {
        accoda(1, 2 * ORA_MS, 3 * ORA_MS);                    // il token vale solo 3 ore
        for (int i = 0; i < 100; i++) put.poi(server(503));
        esegui();
        verificaChiusuraPulita(1, Stato.FALLITO);
        assertSame(Codice.TOKEN_SCADUTO, voce(1).codice);
        assertTrue("l'orologio ha superato la scadenza", ora.get() >= 1_790_000_000_000L + 3 * ORA_MS);
        List<String> m = messaggi();
        assertEquals("video-nativo-fallito TOKEN_SCADUTO", m.get(m.size() - 1));
        assertEquals("rinnovo", registro.eventi().get(registro.numeroEventi() - 1).campi.get("operazione"));
    }

    @Test
    public void unErroreDelServerDi4xxQualunqueRinnova() throws Exception {
        int[] stati = {401, 403, 404, 409, 410};
        for (int i = 0; i < stati.length; i++) accoda(i + 1);
        // Ogni voce riceve il SUO 4xx alla prima PUT, poi la PUT riesce: il copione non può essere una coda unica, perché dopo un rinnovo
        // la stessa voce rispedisce subito e consumerebbe il 4xx di un'altra.
        final List<String> viste = Collections.synchronizedList(new ArrayList<String>());
        put.predefinita = r -> {
            String nome = r.file.getName();
            if (viste.contains(nome)) return ok();
            viste.add(nome);
            int numero = Integer.parseInt(nome.substring(7, 8), 16);       // l'ultima cifra del primo gruppo dell'uuid: 1..5
            return EsitoPut.risposta(stati[numero - 1], null, 0L, 100L, 50L, false);
        };
        esegui();
        assertEquals("ogni 4xx (tranne 408/413/429) porta al rinnovo, che dice se il file c'è", 5, rinnovo.chiamate.size());
        for (int i = 1; i <= stati.length; i++) assertSame(Stato.INVIATO, stato(i));
        assertEquals("due PUT per voce", 10, put.richieste.size());
    }

    @Test
    public void unEsitoTransitorioDelServerAspettaESiRipete() throws Exception {
        accoda(1);
        put.poi(EsitoPut.risposta(408, null, 0L, 100L, 50L, false), EsitoPut.risposta(429, null, 0L, 100L, 50L, false), server(500), server(502));
        esegui();
        verificaChiusuraPulita(1, Stato.INVIATO);
        assertEquals("quattro attese", 4, voce(1).tentativi);
        assertEquals("un transitorio non chiede mai un rinnovo (qui l'URL ha meno di 10 minuti)", 0, rinnovo.chiamate.size());
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * I GUASTI DEL FILE E DEI SEGRETI
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void unaCopiaCheNonCEPiuFallisceConFileAssenteSenzaSpedireNiente() throws Exception {
        accoda(1);
        assertTrue(new File(cartella, "file/" + id(1) + ".mp4").delete());
        esegui();
        verificaChiusuraPulita(1, Stato.FALLITO);
        assertSame(Codice.FILE_ASSENTE, voce(1).codice);
        assertEquals(0, put.richieste.size());
        assertEquals(0, rinnovo.chiamate.size());
        assertEquals(Arrays.asList("video-nativo-fallito FILE_ASSENTE"), messaggi());
        assertEquals("copia", evento("video-nativo-fallito").campi.get("operazione"));
    }

    @Test
    public void unaCopiaCheNonPesaQuelloCheLaVoceDichiaraFallisceConPesoDiverso() throws Exception {
        accoda(1);
        try (FileOutputStream uscita = new FileOutputStream(new File(cartella, "file/" + id(1) + ".mp4"), true)) {
            uscita.write(new byte[]{1, 2, 3});
        }
        esegui();
        verificaChiusuraPulita(1, Stato.FALLITO);
        assertSame(Codice.PESO_DIVERSO, voce(1).codice);
        assertEquals(0, put.richieste.size());
    }

    @Test
    public void ISegretiCheNonCiSonoPiuOCheNonSiLeggonoFannoFallireLaVoceConInterno() throws Exception {
        accoda(1);
        assertTrue(coda.fileSegreto(id(1)).delete());
        esegui();
        verificaChiusuraPulita(1, Stato.FALLITO);
        assertSame(Codice.INTERNO, voce(1).codice);
        assertEquals(0, put.richieste.size());

        accoda(2);
        byte[] dati = Files.readAllBytes(coda.fileSegreto(id(2)).toPath());
        dati[dati.length - 1] ^= 1;
        Files.write(coda.fileSegreto(id(2)).toPath(), dati);
        esegui();
        verificaChiusuraPulita(2, Stato.FALLITO);
        assertSame("segreti manomessi: stessa fine, e mai una PUT con un URL che non si fida", Codice.INTERNO, voce(2).codice);
        assertEquals(0, put.richieste.size());
        assertEquals("put", evento("video-nativo-fallito").campi.get("operazione"));
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * ANNULLA, FERMA, STATI DI PARTENZA
     * ──────────────────────────────────────────────────────────────────────────── */

    private static void pausa(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException interrotta) {
            Thread.currentThread().interrupt();
        }
    }

    /** Una PUT che resta in volo finché qualcuno non chiede di fermarla: poi restituisce `INTERROTTO`. */
    private Function<RichiestaPut, EsitoPut> putInVoloFinoAllInterruzione(CountDownLatch inVolo) {
        return richiesta -> {
            inVolo.countDown();
            long limite = System.nanoTime() + 20_000_000_000L;
            while (!richiesta.interruzione.richiesta() && System.nanoTime() < limite) pausa(5);
            return EsitoPut.interrotto(1_234L, 50L);
        };
    }

    @Test(timeout = 60_000)
    public void annullareInVoloFermaIByteChiudeLaVoceEScriveAnnullatoUtente() throws Exception {
        accoda(1);
        CountDownLatch inVolo = new CountDownLatch(1);
        put.poi(putInVoloFinoAllInterruzione(inVolo));
        AtomicReference<EsitoCiclo> esito = new AtomicReference<>();
        Thread filo = new Thread(() -> esito.set(esegui()));
        filo.start();
        assertTrue(inVolo.await(10, TimeUnit.SECONDS));
        assertTrue("c'era una voce viva da annullare", esecutore.annulla(id(1)));
        filo.join(20_000);
        assertFalse("il ciclo è finito", filo.isAlive());
        assertSame(EsitoCiclo.FINITO, esito.get());
        verificaChiusuraPulita(1, Stato.ANNULLATO);
        assertEquals(1, put.richieste.size());
        assertEquals(Arrays.asList("video-nativo-annullato utente"), messaggi());
        assertEquals(1, ambiente.daSvuotare.get());
        assertFalse("annullare di nuovo non fa niente", esecutore.annulla(id(1)));
        assertFalse("e una voce che non c'è nemmeno", esecutore.annulla(id(404)));
        assertFalse(esecutore.annulla(null));
    }

    @Test
    public void annullareUnaVoceCheNonStaSpedendoLaChiudeSubito() throws Exception {
        accoda(1);
        assertTrue(esecutore.annulla(id(1)));
        verificaChiusuraPulita(1, Stato.ANNULLATO);
        assertEquals(Arrays.asList("video-nativo-annullato utente"), messaggi());
        assertSame("l'esecutore non trova più niente da fare", EsitoCiclo.FINITO, esegui());
        assertEquals(0, put.richieste.size());
    }

    @Test(timeout = 60_000)
    public void fermareIlGuscioInterrompeLaPutLasciaLaVoceInAttesaSenzaSegnarlaFallitaERipartePoi() throws Exception {
        accoda(1);
        CountDownLatch inVolo = new CountDownLatch(1);
        put.poi(putInVoloFinoAllInterruzione(inVolo));
        AtomicReference<EsitoCiclo> esito = new AtomicReference<>();
        Thread filo = new Thread(() -> esito.set(esegui()));
        filo.start();
        assertTrue(inVolo.await(10, TimeUnit.SECONDS));
        esecutore.ferma();
        filo.join(20_000);
        assertFalse(filo.isAlive());
        assertSame(EsitoCiclo.INTERROTTO, esito.get());
        VoceCoda v = voce(1);
        assertSame("non è fallita: è in attesa", Stato.IN_ATTESA, v.stato);
        assertSame(Codice.RETE, v.codice);
        assertEquals("nessun tentativo consumato dalla fermata", 0, v.tentativi);
        assertEquals("pronta a ripartire subito", 0L, v.prossimoTentativoIl);
        assertTrue("copia e segreti intatti", new File(cartella, "file/" + id(1) + ".mp4").exists() && coda.fileSegreto(id(1)).exists());
        assertEquals("nessuna riga di fallimento", 0, conta("video-nativo-fallito"));
        assertFalse("il guscio non è più attivo", esecutore.attivo());
        // Un nuovo giro (il sistema riavvia il guscio): riparte da zero e arriva.
        assertSame(EsitoCiclo.FINITO, esegui());
        verificaChiusuraPulita(1, Stato.INVIATO);
        assertEquals(2, put.richieste.size());
    }

    @Test
    public void fermareQuandoNonCEUnCicloNonFaNienteENonSporcaIlGiroDopo() throws Exception {
        accoda(1);
        esecutore.ferma();       // nessun ciclo attivo: ignorato
        assertSame("il giro che parte dopo NON è fermato", EsitoCiclo.FINITO, esegui());
        verificaChiusuraPulita(1, Stato.INVIATO);
    }

    @Test
    public void unaVoceRimastaInInvioDaUnProcessoMortoRiprendeSenzaTransizioniInutili() throws Exception {
        accoda(1);
        coda.transita(id(1), EventoStato.AVVIATO, null);
        assertSame(Stato.IN_INVIO, stato(1));
        esegui();
        verificaChiusuraPulita(1, Stato.INVIATO);
        // Nessuno la stava spedendo in questo processo: si dice che riprende dopo una chiusura (S7: `am force-stop`, uccisione del sistema).
        assertEquals(Arrays.asList("video-nativo-ripreso-dopo-chiusura", "video-nativo-inviato"), messaggi());
        assertEquals(0L, numero(evento("video-nativo-ripreso-dopo-chiusura"), "byte_inviati"));
    }

    @Test
    public void unaVoceCheQuestoProcessoStaGiaSpedendoNonSiDiceRipresaDopoUnaChiusura() throws Exception {
        accoda(1);
        put.poi(server(503));
        esegui();
        // La voce è passata da in-invio → in-attesa → in-invio DENTRO lo stesso processo: nessuna «ripresa dopo chiusura».
        assertEquals(0, conta("video-nativo-ripreso-dopo-chiusura"));
    }

    @Test
    public void unaVoceInPausaRiprendeQuandoIlGuscioPuoPartire() throws Exception {
        accoda(1);
        coda.transita(id(1), EventoStato.IN_PAUSA, Codice.FGS_NON_AVVIABILE);
        esegui();
        verificaChiusuraPulita(1, Stato.INVIATO);
    }

    @Test
    public void ilTokenGiaScadutoAllInizioFallisceSenzaNemmenoProvare() throws Exception {
        accoda(1, 2 * ORA_MS, 48 * ORA_MS);
        ora.addAndGet(49 * ORA_MS);
        esegui();
        assertSame(Stato.FALLITO, stato(1));
        assertSame(Codice.TOKEN_SCADUTO, voce(1).codice);
        assertEquals(0, put.richieste.size());
        assertEquals(0, rinnovo.chiamate.size());
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * PIÙ VOCI, GUASTI IMPREVISTI, CONCORRENZA
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void leVociVannoUnaAllaVoltaInOrdineDiCreazioneEUnaInAttesaNonBloccaLAltra() throws Exception {
        accoda(1);
        ora.addAndGet(10);
        accoda(2);
        put.poi(server(503));          // la prima fallisce, poi la seconda parte mentre la prima aspetta, poi la prima ritenta
        List<String> ordine = new ArrayList<>();
        put.allaPartenza = () -> ordine.add(put.richieste.get(put.richieste.size() - 1).file.getName());
        esegui();
        verificaChiusuraPulita(1, Stato.INVIATO);
        verificaChiusuraPulita(2, Stato.INVIATO);
        assertEquals(Arrays.asList(id(1) + ".mp4", id(2) + ".mp4", id(1) + ".mp4"), ordine);
    }

    @Test
    public void unEccezioneImprevistaNelGiroDiUnaVoceNonFermaIlCicloELaVoceRiprovaDopoUnaPausa() throws Exception {
        accoda(1);
        put.poi(new IllegalStateException("bug"));
        esegui();
        verificaChiusuraPulita(1, Stato.INVIATO);
        assertEquals("il guasto si dice, con la sola classe", Arrays.asList("esecutore-lavora:IllegalStateException"), ambiente.guasti);
        ambiente.guasti.clear();
        assertEquals("tentativo INTERNO, con un ritardo di 30 s", Arrays.asList("video-nativo-ritento INTERNO", "video-nativo-inviato"), messaggi());
    }

    @Test
    public void unTrasportatoreDelRinnovoCheLanciaVaListoComeNessunaRisposta() throws Exception {
        accoda(1, 2 * ORA_MS - 11 * MINUTO, 48 * ORA_MS);
        rinnovo.poi(new IllegalStateException("bug del trasportatore"));
        esegui();
        verificaChiusuraPulita(1, Stato.INVIATO);
        assertEquals(Arrays.asList("rinnovo-trasporto:IllegalStateException"), ambiente.guasti);
        ambiente.guasti.clear();
        assertEquals("video-nativo-rinnovo rete", messaggi().get(0));
    }

    @Test
    public void notificaLavoroDiceVeroSoloMentreIlCicloGiraEFalsoDopo() throws Exception {
        accoda(1);
        assertFalse("nessun ciclo: chi accoda deve avviare il guscio", esecutore.notificaLavoro());
        AtomicBoolean durante = new AtomicBoolean(false);
        AtomicBoolean attivoDurante = new AtomicBoolean(false);
        put.poi((Function<RichiestaPut, EsitoPut>) r -> {
            durante.set(esecutore.notificaLavoro());
            attivoDurante.set(esecutore.attivo());
            return ok();
        });
        esegui();
        assertTrue("con un ciclo attivo basta avvisarlo", durante.get());
        assertTrue(attivoDurante.get());
        assertFalse(esecutore.attivo());
        assertFalse("finito: di nuovo tocca a chi accoda", esecutore.notificaLavoro());
    }

    @Test(timeout = 60_000)
    public void unSecondoGiroMentreUnoGiraRestituisceGiaAttivoSenzaFareNiente() throws Exception {
        accoda(1);
        CountDownLatch inVolo = new CountDownLatch(1);
        CountDownLatch rilascia = new CountDownLatch(1);
        put.poi((Function<RichiestaPut, EsitoPut>) r -> {
            inVolo.countDown();
            try {
                rilascia.await(20, TimeUnit.SECONDS);
            } catch (InterruptedException interrotto) {
                Thread.currentThread().interrupt();
            }
            return ok();
        });
        Thread filo = new Thread(this::esegui);
        filo.start();
        assertTrue(inVolo.await(10, TimeUnit.SECONDS));
        assertSame(EsitoCiclo.GIA_ATTIVO, esegui());
        rilascia.countDown();
        filo.join(20_000);
        verificaChiusuraPulita(1, Stato.INVIATO);
        assertEquals("una PUT sola", 1, put.richieste.size());
    }

    /**
     * IL PASSAGGIO FRA «STO FINENDO» E «ARRIVA UNA VOCE»: un thread accoda voci e, se `notificaLavoro` dice falso, avvia un guscio (un
     * thread che chiama `esegui`), come fa `PianificatoreCaricamenti`. Alla fine OGNI voce deve essere inviata: nessuna resta accodata senza
     * che nessuno la guardi.
     */
    @Test(timeout = 120_000)
    public void nessunaVoceRestaAccodataSenzaNessunoCheLaGuardi() throws Exception {
        final int voci = 60;
        final List<Thread> gusci = Collections.synchronizedList(new ArrayList<Thread>());
        for (int n = 1; n <= voci; n++) {
            accoda(n);
            if (!esecutore.notificaLavoro()) {
                Thread guscio = new Thread(this::esegui);
                gusci.add(guscio);
                guscio.start();
            }
            if (n % 7 == 0) pausa(1);
        }
        for (Thread guscio : new ArrayList<>(gusci)) guscio.join(60_000);
        long limite = System.nanoTime() + 30_000_000_000L;
        while (System.nanoTime() < limite && coda.vive().size() > 0) pausa(10);
        assertEquals("tutte le voci sono state guardate", 0, coda.vive().size());
        for (int n = 1; n <= voci; n++) assertSame("voce " + n, Stato.INVIATO, stato(n));
        assertEquals(voci, put.richieste.size());
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * PRIVACY
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void nessunLogDelRegistroPortaTokenUrlNomiDiFileOHash() throws Exception {
        accoda(1);
        accoda(2);
        put.poi(senzaRisposta(), rifiuto("InvalidJWT", "400", true, 7_812_000L), server(503));
        rinnovo.poi(new RispostaHttp(429, null, 30L, null), daCaricare("x"));
        esegui();
        assertTrue("lo scenario ha prodotto un po' di righe", registro.numeroEventi() >= 5);
        for (EventoRegistrato e : registro.eventi()) {
            String tutto = e.messaggio + " " + e.campi;
            for (String vietato : new String[]{TOKEN, "kvr_", "supabase", "://", "prova-", ".mp4", "storage/v1", "app.kidville.it", "token=", "http"}) {
                assertFalse("«" + vietato + "» in «" + tutto + "»", tutto.contains(vietato));
            }
            assertEquals("versione_app", "1.2+6", e.campi.get("versione_app"));
            assertTrue(e.campi.size() <= RegistroNativo.CAMPI_MASSIMI);
            assertEquals(UTENTE, e.utenteId);
        }
    }

    @Test
    public void laCodaSuDiscoNonPortaMaiTokenNeUrlNeDopoUnRinnovo() throws Exception {
        accoda(1, 2 * ORA_MS - 11 * MINUTO, 48 * ORA_MS);
        rinnovo.poi(daCaricare("rinnovato"));
        put.poi(server(503), server(503));
        AtomicReference<String> codaSuDisco = new AtomicReference<>();
        put.allaPartenza = () -> {
            try {
                codaSuDisco.set(new String(Files.readAllBytes(new File(cartella, "coda.json").toPath()), StandardCharsets.UTF_8));
            } catch (IOException impossibile) {
                throw new AssertionError(impossibile);
            }
        };
        esegui();
        String json = codaSuDisco.get();
        assertNotNull(json);
        for (String vietato : new String[]{TOKEN, "kvr_", "supabase", "://", "token=", "rinnovato", "http"}) {
            assertFalse("«" + vietato + "» nella coda su disco", json.contains(vietato));
        }
    }

    @Test
    public void iSegretiSonoSempreCifratiSuDisco() throws Exception {
        accoda(1);
        byte[] grezzo = Files.readAllBytes(coda.fileSegreto(id(1)).toPath());
        String testo = new String(grezzo, StandardCharsets.ISO_8859_1);
        assertFalse(testo.contains("kvr_"));
        assertFalse(testo.contains("supabase"));
        assertSame(Esito.OK, segreti.leggi(id(1)).esito);
    }

    @Test
    public void ilRegistroNonVedeMaiLeStringheDelleVoci() throws Exception {
        // Ogni riga ha un solo job, come uuid minuscolo, e al più un codice: il resto è un numero, un booleano o un enumerato.
        accoda(1);
        put.poi(server(503));
        esegui();
        for (EventoRegistrato e : registro.eventi()) {
            assertTrue(e.messaggio, e.messaggio.matches("^[a-z-]+(: job=[0-9a-f-]{36})?( [A-Za-z-]+)?$"));
        }
    }


    /* ════════════════════════════════════════════════════════════════════════════
     * COMPITO A2b: LE CORREZIONI AL MOTORE DI INVIO (secondari n. 76-92 della PR 3)
     * ════════════════════════════════════════════════════════════════════════════ */

    /** Un guasto che il cifrario dichiara PASSEGGERO (un Keystore occupato): il marcatore con cui `CifrarioDiProva` lo riconosce. */
    private static final class GuastoPasseggero extends java.security.GeneralSecurityException {
        GuastoPasseggero() {
            super("Keystore occupato");
        }
    }

    /**
     * Un cifrario che decifra come quello software, ma: fa fallire le decifrature che si scelgono per numero (la prima è la 1), con un
     * guasto passeggero (`GuastoPasseggero`) o definitivo (un tag GCM che non torna), e dopo ogni decifratura riuscita lascia partire un
     * gancio col suo numero: è il punto in cui un test fa succedere qualcosa «fra la lettura dei segreti e ciò che viene dopo».
     */
    private final class CifrarioDiProva implements SegretiCaricamenti.Cifrario {
        final AtomicInteger decifrature = new AtomicInteger();
        final java.util.Map<Integer, Exception> guasti = new java.util.concurrent.ConcurrentHashMap<>();
        volatile java.util.function.IntConsumer dopoLaDecifratura = null;
        volatile boolean tuttoPasseggero = false;

        @Override
        public byte[] cifra(byte[] chiaro, byte[] datiAssociati) throws java.security.GeneralSecurityException, IOException {
            return cifrario.cifra(chiaro, datiAssociati);
        }

        @Override
        public byte[] decifra(byte[] cifrato, byte[] datiAssociati) throws java.security.GeneralSecurityException, IOException {
            int n = decifrature.incrementAndGet();
            Exception g = tuttoPasseggero ? new GuastoPasseggero() : guasti.get(n);
            if (g instanceof java.security.GeneralSecurityException) throw (java.security.GeneralSecurityException) g;
            if (g instanceof IOException) throw (IOException) g;
            byte[] chiaro = cifrario.decifra(cifrato, datiAssociati);
            java.util.function.IntConsumer gancio = dopoLaDecifratura;
            if (gancio != null) gancio.accept(n);
            return chiaro;
        }

        @Override
        public boolean guastoTransitorio(Throwable guasto) {
            return guasto instanceof GuastoPasseggero || SegretiCaricamenti.Cifrario.super.guastoTransitorio(guasto);
        }
    }

    /** Rimonta segreti ed esecutore sul cifrario di prova (dopo, `accoda(n)` salva con quello). */
    private CifrarioDiProva conCifrarioDiProva() {
        CifrarioDiProva c = new CifrarioDiProva();
        segreti = new SegretiCaricamenti(coda, c);
        esecutore = new EsecutoreCoda(coda, registro, segreti, put, rinnovo, rete, ambiente);
        esecutore.impostaOsservatore((voce, byteInviati) -> osservate.add(voce.stato.valore() + ":" + byteInviati));
        return c;
    }

    /** Aspetta che un thread sia finito o fermo su un monitor: i due soli modi in cui un `annulla` concorrente può trovarsi. */
    private static void aspettaCheSiaFinitoOBloccato(Thread t) throws InterruptedException {
        long limite = System.nanoTime() + 10_000_000_000L;
        while (System.nanoTime() < limite && t.getState() != Thread.State.TERMINATED && t.getState() != Thread.State.BLOCKED) Thread.sleep(1);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * N. 76: IL RIAVVIO DEL GUSCIO MENTRE IL CICLO PRECEDENTE STA USCENDO, con l'esecutore vero
     * ──────────────────────────────────────────────────────────────────────────── */

    /**
     * Il caso del secondario: il sistema ferma il job (`ferma()`), la PUT in volo esce piano (un rinnovo che non si interrompe...), e in
     * quei secondi riavvia il job. Il thread nuovo trova `GIA_ATTIVO`: prima chiudeva il job senza lavoro, e la voce restava `in-attesa`
     * senza nessun guscio. Adesso aspetta che il vecchio finisca e porta a termine il lavoro rimasto.
     */
    @Test(timeout = 60_000)
    public void unGuscioRiavviatoMentreIlCicloPrecedenteStaUscendoPortaATermineIlLavoroRimasto() throws Exception {
        accoda(1);
        CountDownLatch inVolo = new CountDownLatch(1);
        CountDownLatch uscitaLenta = new CountDownLatch(1);
        put.poi((Function<RichiestaPut, EsitoPut>) r -> {
            inVolo.countDown();
            long limite = System.nanoTime() + 20_000_000_000L;
            while (!r.interruzione.richiesta() && System.nanoTime() < limite) pausa(2);
            try {
                uscitaLenta.await(20, TimeUnit.SECONDS);       // l'uscita del ciclo vecchio è LENTA: il sistema riavvia il job nel frattempo
            } catch (InterruptedException interrotto) {
                Thread.currentThread().interrupt();
            }
            return EsitoPut.interrotto(1_234L, 50L);
        });
        AtomicReference<EsitoCiclo> vecchio = new AtomicReference<>();
        Thread filoVecchio = new Thread(() -> vecchio.set(esegui()));
        filoVecchio.start();
        assertTrue(inVolo.await(10, TimeUnit.SECONDS));
        esecutore.ferma();                                         // onStopJob

        // Il job riparte: il thread nuovo passa dal ciclo del guscio, come `ServizioCaricamentiUidt`.
        CountDownLatch trovatoAttivo = new CountDownLatch(1);
        AtomicReference<EsitoCiclo> nuovo = new AtomicReference<>();
        Thread filoNuovo = new Thread(() -> nuovo.set(CicloDelGuscio.esegui((p, tetto) -> {
            EsitoCiclo e = esecutore.esegui(p, tetto);
            if (e == EsitoCiclo.GIA_ATTIVO) trovatoAttivo.countDown();
            return e;
        }, presentazione, TETTO_RETE_MS, () -> false, ms -> Thread.sleep(20))));
        filoNuovo.start();
        assertTrue("il job nuovo ha trovato il ciclo vecchio ancora attivo", trovatoAttivo.await(10, TimeUnit.SECONDS));
        assertSame("e il ciclo vecchio non è ancora uscito", Stato.IN_INVIO, stato(1));

        uscitaLenta.countDown();                                   // il ciclo vecchio finisce di uscire
        filoVecchio.join(20_000);
        filoNuovo.join(20_000);
        assertFalse(filoVecchio.isAlive() || filoNuovo.isAlive());
        assertSame("il vecchio è uscito perché fermato", EsitoCiclo.INTERROTTO, vecchio.get());
        assertSame("il nuovo ha fatto il lavoro rimasto invece di chiudersi senza", EsitoCiclo.FINITO, nuovo.get());
        verificaChiusuraPulita(1, Stato.INVIATO);
        assertEquals("due PUT: quella interrotta e quella del job nuovo", 2, put.richieste.size());
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * N. 79: UN GUASTO PASSEGGERO DEI SEGRETI NON FA FALLIRE LA VOCE
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void unKeystoreOccupatoPerUnIstanteNonFaFallireLaVoceAspettaConCopiaESegretiEPoiArriva() throws Exception {
        CifrarioDiProva c = conCifrarioDiProva();
        accoda(1);
        c.guasti.put(1, new GuastoPasseggero());                  // la prima decifratura (quella dell'esecutore) fallisce, la seconda no
        AtomicReference<VoceCoda> allaPut = new AtomicReference<>();
        put.allaPartenza = () -> allaPut.set(voce(1));

        List<String> righeDiLogcat;
        try (RigheDiLogcat logcat = new RigheDiLogcat()) {
            assertSame(EsitoCiclo.FINITO, esegui());
            righeDiLogcat = new ArrayList<>(logcat.righe);
        }

        assertTrue("il guasto passeggero si dice in logcat, senza dati: " + righeDiLogcat,
                righeDiLogcat.contains("I KidvilleCaricamenti segreti non decifrati adesso (GuastoPasseggero): passeggero, la voce riprova")
                        && righeDiLogcat.contains("I KidvilleCaricamenti segreti non leggibili adesso: la voce aspetta e riprova, copia e segreti restano"));
        verificaChiusuraPulita(1, Stato.INVIATO);
        assertEquals("una PUT sola: arrivata al secondo giro, dopo l'attesa", 1, put.richieste.size());
        assertEquals("un tentativo consumato: l'attesa di §4.5", 1, allaPut.get().tentativi);
        assertEquals("nessun fallimento: la voce non è mai stata dichiarata persa", 0, conta("video-nativo-fallito"));
        assertEquals("il ritentativo si dice, con codice INTERNO", 1, conta("video-nativo-ritento INTERNO"));
        assertEquals("e il video è arrivato", 1, conta("video-nativo-inviato"));
        assertEquals(30_000L, ambiente.dormitoMs.get());
    }

    @Test
    public void durantelAttesaPerUnGuastoPasseggeroLaVoceEInAttesaInternoConCopiaESegretiAlloStessoPosto() throws Exception {
        CifrarioDiProva c = conCifrarioDiProva();
        accoda(1);
        c.guasti.put(1, new GuastoPasseggero());
        List<String> viste = Collections.synchronizedList(new ArrayList<String>());
        esecutore.impostaOsservatore((v, byteInviati) -> {
            if (v.stato == Stato.IN_ATTESA) {
                viste.add(v.codice + "|copia=" + new File(cartella, "file/" + id(1) + ".mp4").exists() + "|segreti=" + coda.fileSegreto(id(1)).exists());
            }
        });

        esegui();

        assertEquals("quando la voce passa in attesa: codice INTERNO, e la copia e i segreti ci sono ancora", Arrays.asList("INTERNO|copia=true|segreti=true"),
                new ArrayList<>(viste));
    }

    @Test
    public void unGuastoDefinitivoDeiSegretiChiudeLaVoceFallitaInternoCometPrima() throws Exception {
        CifrarioDiProva c = conCifrarioDiProva();
        accoda(1);
        c.guasti.put(1, new javax.crypto.AEADBadTagException("contenuto toccato"));
        esegui();
        verificaChiusuraPulita(1, Stato.FALLITO);
        assertSame(Codice.INTERNO, voce(1).codice);
        assertEquals(0, put.richieste.size());
        assertEquals("put", evento("video-nativo-fallito").campi.get("operazione"));
    }

    @Test
    public void unGuastoPasseggeroCheNonPassaMaiSiFermaAllaScadenzaDelTokenNonPrima() throws Exception {
        CifrarioDiProva c = conCifrarioDiProva();
        accoda(1, 2 * ORA_MS, 3 * ORA_MS);                         // il token vale 3 ore
        c.tuttoPasseggero = true;
        esegui();
        verificaChiusuraPulita(1, Stato.FALLITO);
        assertSame("è la vita del token a chiudere la voce, non il guasto", Codice.TOKEN_SCADUTO, voce(1).codice);
        assertTrue("l'orologio ha superato la scadenza", ora.get() >= 1_790_000_000_000L + 3 * ORA_MS);
        assertEquals("mai una PUT con segreti che non si leggono", 0, put.richieste.size());
        assertTrue("ha ritentato più volte", voce(1).tentativi >= 10);
        assertTrue("i log dei ritentativi si diradano (1, 2, 4, 8, ...): nessuna riga a ogni tentativo (" + conta("video-nativo-ritento INTERNO") + " righe)",
                conta("video-nativo-ritento INTERNO") <= 6);
    }

    @Test
    public void unRinnovoRespintoConIlTokenPiuRecenteChePerUnIstanteNonSiLeggeNonFaFallireLaVoceTokenNonValido() throws Exception {
        CifrarioDiProva c = conCifrarioDiProva();
        accoda(1, 2 * ORA_MS - 11 * MINUTO, 48 * ORA_MS);          // firmato 11 minuti fa: rinnovo proattivo
        // 1ª decifratura: i segreti dell'esecutore. 2ª: la rilettura dopo il 404 (potrebbe esserci un token ruotato): il Keystore è occupato.
        c.guasti.put(2, new GuastoPasseggero());
        rinnovo.poi(trovatoNo(), daCaricare("riprovato"));

        List<String> righeDiLogcat;
        try (RigheDiLogcat logcat = new RigheDiLogcat()) {
            assertSame(EsitoCiclo.FINITO, esegui());
            righeDiLogcat = new ArrayList<>(logcat.righe);
        }

        assertTrue("l'attesa dopo il rinnovo respinto si dice in logcat: " + righeDiLogcat,
                righeDiLogcat.contains("I KidvilleCaricamenti segreti non leggibili adesso dopo un rinnovo respinto: la voce aspetta e riprova"));
        verificaChiusuraPulita(1, Stato.INVIATO);
        assertEquals("nessun «negato»: un 404 con la rilettura impossibile non è un verdetto", 0, conta("video-nativo-rinnovo negato"));
        assertEquals(0, conta("video-nativo-fallito"));
        assertEquals("si è riprovato dopo l'attesa, e il rinnovo seguente ha risposto", 2, rinnovo.chiamate.size());
        assertEquals(1, conta("video-nativo-ritento INTERNO"));
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * N. 81: LA PULIZIA DI FINE GIRO NON TOCCA CIÒ CHE IL DISCO NOMINA ANCORA
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void seLoStatoTerminaleNonArrivaSulDiscoLaPuliziaDiFineGiroNonCancellaCopiaESegreti() throws Exception {
        AtomicFileCheNonTrasloca disco = new AtomicFileCheNonTrasloca(new File(cartella, "coda.json"), true);
        coda = new CodaCaricamenti(cartella, ora::get, disco);
        segreti = new SegretiCaricamenti(coda, cifrario);
        esecutore = new EsecutoreCoda(coda, registro, segreti, put, rinnovo, rete, ambiente);
        accoda(1);
        put.allaPartenza = () -> disco.traslocaDavvero = false;    // il disco «non dà più i numeri» mentre la PUT è in volo

        assertSame(EsitoCiclo.FINITO, esegui());

        assertSame("in memoria la voce è inviata", Stato.INVIATO, stato(1));
        assertEquals("e il video è arrivato davvero", 1, conta("video-nativo-inviato"));
        assertTrue("ma sul disco la voce è ancora viva e nomina la copia: la pulizia di fine giro non la tocca (n. 81)",
                new File(cartella, "file/" + id(1) + ".mp4").exists());
        assertTrue("né i segreti", coda.fileSegreto(id(1)).exists());
        // Alla riapertura la voce non cade in FILE_ASSENTE: è viva, col suo file, e riprende.
        VoceCoda dopoIlRiavvio = new CodaCaricamenti(cartella, ora::get).trova(id(1));
        assertNotNull(dopoIlRiavvio);
        assertSame(Stato.IN_INVIO, dopoIlRiavvio.stato);
        assertEquals("file/" + id(1) + ".mp4", dopoIlRiavvio.file);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * N. 82: IL RINNOVO NON FA RISORGERE I SEGRETI DI UNA VOCE ANNULLATA
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test(timeout = 60_000)
    public void unAnnullaCheArrivaFraLaLetturaELaScritturaDeiSegretiDopoUnRinnovoNonLiFaRisorgere() throws Exception {
        CifrarioDiProva c = conCifrarioDiProva();
        accoda(1, 2 * ORA_MS - 11 * MINUTO, 48 * ORA_MS);          // rinnovo proattivo: dopo il rinnovo, `aggiorna` riscrive i segreti
        rinnovo.poi(daCaricare("rinnovato"));
        final AtomicReference<Thread> annullatore = new AtomicReference<>();
        // La 1ª decifratura è quella dell'esecutore; la 2ª è la LETTURA di `aggiorna`: è lì che il ponte annulla, da un altro thread.
        c.dopoLaDecifratura = n -> {
            if (n != 2) return;
            Thread t = new Thread(() -> esecutore.annulla(id(1)), "ponte-annulla");
            annullatore.set(t);
            t.start();
            try {
                aspettaCheSiaFinitoOBloccato(t);
            } catch (InterruptedException interrotto) {
                Thread.currentThread().interrupt();
            }
        };

        esegui();
        annullatore.get().join(20_000);

        assertFalse(annullatore.get().isAlive());
        assertTrue("la voce è chiusa (annullata, o già inviata se la PUT è arrivata prima)", voce(1).stato.terminale());
        assertFalse("i segreti di una voce terminale NON si riscrivono: non devono esserci (n. 82)", coda.fileSegreto(id(1)).exists());
        assertFalse(new File(cartella, "file/" + id(1) + ".mp4").exists());
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * N. 83: IL RICONTROLLO PRIMA DELLA PUT (la mutazione MC3 del critico)
     * ──────────────────────────────────────────────────────────────────────────── */

    /** Una PUT che rispetta l'interruzione come `CaricatorePut`: se è già stata chiesta all'avvio non spedisce nemmeno un byte. */
    private Function<RichiestaPut, EsitoPut> putCheRispettaLInterruzioneGiaChiesta() {
        return richiesta -> richiesta.interruzione.richiesta() ? EsitoPut.interrotto(0L, 0L) : ok();
    }

    @Test
    public void unaFermataCheArrivaPrimaChePubblichiLInterruzioneImpedisceLaPutNonLaFaPartire() throws Exception {
        accoda(1, 2 * ORA_MS - 11 * MINUTO, 48 * ORA_MS);
        rinnovo.poi(daCaricare("rinnovato"));
        // Il guscio si ferma MENTRE il rinnovo è in volo: `interruzioneInCorso` non c'è ancora, `ferma()` non ha niente da interrompere.
        rinnovo.dentro = () -> esecutore.ferma();
        put.poi(putCheRispettaLInterruzioneGiaChiesta());

        assertSame(EsitoCiclo.INTERROTTO, esegui());

        assertEquals(1, put.richieste.size());
        assertTrue("la PUT parte GIÀ interrotta: il ricontrollo di `spedisci` la ferma prima del primo byte", put.richieste.get(0).interruzione.richiesta());
        assertSame("e la voce non è stata inviata: aspetta, senza un tentativo consumato", Stato.IN_ATTESA, stato(1));
        assertEquals(0, voce(1).tentativi);
        assertEquals(0, conta("video-nativo-inviato"));
    }

    @Test
    public void unAnnullaCheArrivaPrimaChePubblichiLInterruzioneImpedisceLaPutDiUnVideoAnnullato() throws Exception {
        CifrarioDiProva c = conCifrarioDiProva();
        accoda(1);
        // L'utente annulla fra la lettura dei segreti e la PUT: la voce è già terminale quando `spedisci` parte.
        c.dopoLaDecifratura = n -> assertTrue("c'era una voce viva da annullare", esecutore.annulla(id(1)));
        put.poi(putCheRispettaLInterruzioneGiaChiesta());

        esegui();

        assertEquals(1, put.richieste.size());
        assertTrue("nessun byte per un video annullato: la PUT parte già interrotta", put.richieste.get(0).interruzione.richiesta());
        verificaChiusuraPulita(1, Stato.ANNULLATO);
        assertEquals(Arrays.asList("video-nativo-annullato utente"), messaggi());
    }

    @Test
    public void unaVoceSparitaPrimaDellaPutNonFaScattareUnaEccezioneEImpedisceLaPut() throws Exception {
        CifrarioDiProva c = conCifrarioDiProva();
        accoda(1);
        // Annullata e poi dimenticata dal ponte: alla PUT la voce non c'è più (`coda.trova` restituisce `null`).
        c.dopoLaDecifratura = n -> {
            assertTrue(esecutore.annulla(id(1)));
            assertEquals(1, coda.dimentica(Arrays.asList(id(1))));
        };
        put.poi(putCheRispettaLInterruzioneGiaChiesta());

        esegui();

        assertEquals("nessuna eccezione imprevista nel giro (lo verifica anche @After)", Collections.<String>emptyList(), ambiente.guasti);
        assertEquals(1, put.richieste.size());
        assertTrue(put.richieste.get(0).interruzione.richiesta());
        assertEquals(0, coda.numeroVoci());
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * N. 89: residuiVisti È ATOMICO, E UNA RICHIESTA DEL PONTE NON SI PERDE
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void unAnnullaDelPonteFuoriDaUnCicloCheLasciaResiduiViveEFaPulireAlGiroDopo() throws Exception {
        AtomicFileCheNonTrasloca disco = new AtomicFileCheNonTrasloca(new File(cartella, "coda.json"), true);
        coda = new CodaCaricamenti(cartella, ora::get, disco);
        segreti = new SegretiCaricamenti(coda, cifrario);
        esecutore = new EsecutoreCoda(coda, registro, segreti, put, rinnovo, rete, ambiente);
        accoda(1);

        // Il ponte annulla (sul SUO thread, fuori da ogni ciclo) mentre il disco non scrive: copia e segreti restano, e si segna la pulizia.
        disco.traslocaDavvero = false;
        Thread ponte = new Thread(() -> assertTrue(esecutore.annulla(id(1))), "ponte");
        ponte.start();
        ponte.join(20_000);
        assertTrue("restano, perché il disco non ha preso lo stato terminale", new File(cartella, "file/" + id(1) + ".mp4").exists());

        // Il disco torna; parte un ciclo per un'altra voce. La richiesta del ponte non si deve essere persa: a fine giro si pulisce.
        disco.traslocaDavvero = true;
        accoda(2);
        assertSame(EsitoCiclo.FINITO, esegui());

        verificaChiusuraPulita(2, Stato.INVIATO);
        assertFalse("la copia della voce annullata è stata tolta dalla pulizia di fine giro (la richiesta del ponte non si perde)",
                new File(cartella, "file/" + id(1) + ".mp4").exists());
        assertFalse(coda.fileSegreto(id(1)).exists());
    }

    @Test
    public void ilCampoCheDueThreadScrivonoEAtomico() throws Exception {
        java.lang.reflect.Field campo = EsecutoreCoda.class.getDeclaredField("residuiVisti");
        assertTrue("`residuiVisti` lo scrive anche `annulla()` sul thread del ponte (n. 89): un `boolean` semplice non lo rende visibile al thread che esegue",
                java.util.concurrent.atomic.AtomicBoolean.class.isAssignableFrom(campo.getType()) || java.lang.reflect.Modifier.isVolatile(campo.getModifiers()));
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * N. 90: LA RETE CHE MANCA NON AZZERA IL RITARDO DI UN 5xx DEL SERVER
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void unaVoceInAttesaPerUnCinqueCentoDelServerRispettaIlSuoRitardoAnchePoiCheLaReteECaduta() throws Exception {
        accoda(1);
        List<Long> partenze = new ArrayList<>();
        List<Long> finiDellePut = new ArrayList<>();
        put.allaPartenza = () -> partenze.add(ora.get());
        put.poi((Function<RichiestaPut, EsitoPut>) r -> {
            rete.su = false;                                       // subito dopo il 503 la rete cade e torna dopo 5 secondi
            rete.tornaAlle = ora.get() + 5 * SECONDO;
            finiDellePut.add(ora.get() + 500L);                    // `server(503)` dura 500 ms
            return server(503);
        });

        assertSame(EsitoCiclo.FINITO, esegui());

        verificaChiusuraPulita(1, Stato.INVIATO);
        assertEquals(2, partenze.size());
        assertTrue("la rete è tornata dopo ~5 s ma il server aveva detto «non adesso» per 30 s: la seconda PUT non parte prima. Parte dopo "
                        + (partenze.get(1) - finiDellePut.get(0)) + " ms",
                partenze.get(1) - finiDellePut.get(0) >= 30 * SECONDO);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * N. 84: IL GANCIO DELL'INTERRUZIONE CHE LANCIA SI DICE IN LOGCAT
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void unGancioDiInterruzioneCheLanciaSiDiceConUnaRigaInfoESenzaDatiENonFermaChiInterrompe() {
        try (RigheDiLogcat logcat = new RigheDiLogcat()) {
            EsecutoreCoda.Interruzione registrataPrima = new EsecutoreCoda.Interruzione();
            registrataPrima.agganciaA(() -> {
                throw new IllegalStateException("socket già chiuso /data/privato/video.mp4");
            });
            registrataPrima.interrompi();                          // il gancio c'era già: lo esegue `interrompi`
            assertTrue("la bandiera resta alzata comunque", registrataPrima.richiesta());

            EsecutoreCoda.Interruzione richiestaPrima = new EsecutoreCoda.Interruzione();
            richiestaPrima.interrompi();
            richiestaPrima.agganciaA(() -> {
                throw new IllegalStateException("socket già chiuso /data/privato/video.mp4");
            });                                                    // l'interruzione era già chiesta: lo esegue `agganciaA`

            assertEquals("una riga per ognuno dei due modi, `info`, col tag del pacchetto e la sola classe", Arrays.asList(
                    "I KidvilleCaricamenti gancio dell'interruzione non riuscito (IllegalStateException): ignorabile, la bandiera resta alzata e la PUT si ferma al blocco dopo",
                    "I KidvilleCaricamenti gancio dell'interruzione non riuscito (IllegalStateException): ignorabile, la bandiera resta alzata e la PUT si ferma al blocco dopo"),
                    new ArrayList<>(logcat.righe));
            for (String riga : logcat.righe) assertFalse("niente percorso né messaggio d'eccezione: " + riga, riga.contains("/data/") || riga.contains("video.mp4"));
        }
    }
}
