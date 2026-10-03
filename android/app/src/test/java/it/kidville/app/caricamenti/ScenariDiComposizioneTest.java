package it.kidville.app.caricamenti;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import it.kidville.app.caricamenti.CodaCaricamenti.Origine;
import it.kidville.app.caricamenti.CodaCaricamenti.VoceCoda;
import it.kidville.app.caricamenti.PoliticaCaricamento.AzionePut;
import it.kidville.app.caricamenti.PoliticaCaricamento.Codice;
import it.kidville.app.caricamenti.PoliticaCaricamento.CorpoRifiuto;
import it.kidville.app.caricamenti.PoliticaCaricamento.DecisionePut;
import it.kidville.app.caricamenti.PoliticaCaricamento.DecisioneRinnovo;
import it.kidville.app.caricamenti.PoliticaCaricamento.ErroreStorage;
import it.kidville.app.caricamenti.PoliticaCaricamento.EventoStato;
import it.kidville.app.caricamenti.PoliticaCaricamento.Motore;
import it.kidville.app.caricamenti.PoliticaCaricamento.RispostaRinnovo;
import it.kidville.app.caricamenti.PoliticaCaricamento.Stato;
import it.kidville.app.caricamenti.RegistroNativo.EsitoInvio;
import it.kidville.app.caricamenti.RegistroNativo.EventoRegistrato;
import it.kidville.app.caricamenti.RegistroNativo.MimeLog;
import it.kidville.app.caricamenti.RegistroNativo.Operazione;

import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.IOException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Deque;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Le tre classi insieme, come le userà l'esecutore di A2 (compito A1): la politica decide, la coda ricorda, il registro racconta.
 *
 * Qui c'è un MOTORE IN MINIATURA, tutto in memoria e con un orologio che si sposta a comando, che fa ciò che farà
 * `EsitoreCoda`: prima di ogni PUT rinnova se l'URL ha più di 10', legge l'esito, aggiorna lo stato, aspetta, rinnova, scrive le
 * righe di log. Non è il motore: è la prova che i pezzi di A1 bastano a farne uno — che nessuna informazione manchi, che i
 * numeri dei log siano quelli di §8.2, che un video normale costi 2 righe e un video con tutti i guai non ne costi cento — e
 * ricalca gli scenari di C1 (§11.1) che si possono giudicare senza un telefono.
 */
public class ScenariDiComposizioneTest {

    @Rule
    public TemporaryFolder temporanea = new TemporaryFolder();

    private final AtomicLong ora = new AtomicLong(1_790_000_000_000L);
    private File cartella;
    private CodaCaricamenti coda;
    private RegistroNativo registro;
    private MotoreInMiniatura motore;

    private static final UUID JOB = UUID.fromString("00000001-1111-4111-8111-000000000001");
    private static final UUID INTENTO = UUID.fromString("00000002-1111-4111-8111-000000000002");
    private static final UUID UTENTE = UUID.fromString("00000003-1111-4111-8111-000000000003");
    private static final UUID SCUOLA = UUID.fromString("00000004-1111-4111-8111-000000000004");
    private static final long ORA_MS = 3_600_000L;

    @Before
    public void preparaIlBanco() throws IOException {
        cartella = temporanea.newFolder("caricamenti");
        coda = new CodaCaricamenti(cartella, ora::get);
        registro = new RegistroNativo(new File(cartella, "registro.json"), "1.2+4", ora::get, (evento, causa) -> {
            throw new AssertionError("il registro ha avuto un guasto interno: " + evento);
        });
        motore = new MotoreInMiniatura();
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * LA RETE FINTA
     * ──────────────────────────────────────────────────────────────────────────── */

    /** Un esito della PUT: lo stato HTTP (0 = nessuna risposta), il corpo, quanto è durato il trasferimento, se i byte erano tutti spediti. */
    private static final class Put {
        final int stato;
        final String corpo;
        final long durataMs;
        final boolean completo;
        final long retryAfter;

        Put(int stato, String corpo, long durataMs, boolean completo, long retryAfter) {
            this.stato = stato;
            this.corpo = corpo;
            this.durataMs = durataMs;
            this.completo = completo;
            this.retryAfter = retryAfter;
        }
    }

    private static Put ok() {
        return new Put(200, "", 1_000L, true, 0L);
    }

    private static Put senzaRisposta() {
        return new Put(0, null, 3_000L, false, 0L);
    }

    private static Put server(int stato) {
        return new Put(stato, null, 500L, false, 0L);
    }

    private static Put rifiuto(String errore, String statusCode, boolean completo, long durataMs) {
        return new Put(400, "{\"statusCode\":\"" + statusCode + "\",\"error\":\"" + errore + "\",\"message\":\"x\"}", durataMs, completo, 0L);
    }

    private static final String URL_STORAGE = "https://abcdwxyzabcdwxyz.supabase.co/storage/v1/object/upload/sign/video_processing/x?token=t";

    /** Una risposta del rinnovo: lo stato HTTP, il corpo, il `Retry-After`. */
    private static final class Rinnovo {
        final int stato;
        final String corpo;
        final long retryAfter;

        Rinnovo(int stato, String corpo, long retryAfter) {
            this.stato = stato;
            this.corpo = corpo;
            this.retryAfter = retryAfter;
        }
    }

    private static Rinnovo daCaricare() {
        return new Rinnovo(200, "{\"stato\":\"da-caricare\",\"caricamento\":{\"protocollo\":\"put\",\"url\":\"" + URL_STORAGE
                + "\",\"metodo\":\"PUT\",\"intestazioni\":{\"content-type\":\"video/mp4\"}},\"scadeIl\":\"2026-10-05T10:00:00.000Z\"}", 0L);
    }

    private static Rinnovo arrivato() {
        return new Rinnovo(200, "{\"stato\":\"arrivato\"}", 0L);
    }

    private static Rinnovo annullato() {
        return new Rinnovo(200, "{\"stato\":\"annullato\"}", 0L);
    }

    private static Rinnovo trovatoNo() {
        return new Rinnovo(404, "{\"codice\":\"VIDEO_NON_TROVATO\"}", 0L);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL MOTORE IN MINIATURA
     * ──────────────────────────────────────────────────────────────────────────── */

    private final class MotoreInMiniatura {
        final Deque<Put> put = new ArrayDeque<>();
        final Deque<Rinnovo> rinnovi = new ArrayDeque<>();
        final List<String> traccia = new ArrayList<>();
        int chiamateRinnovo = 0;
        int chiamatePut = 0;
        long attesaTotaleMs = 0L;

        /** `accodaVideo`: il file c'è, la voce nasce `in-coda`, il successo si logga. */
        void accoda(long urlScadeInMs, long tokenScadeInMs) throws IOException {
            File preparato = new File(cartella, "scelti/prova.mp4");
            preparato.getParentFile().mkdirs();
            assertTrue(preparato.createNewFile());
            String id = JOB.toString();
            VoceCoda voce = VoceCoda.nuova(id, INTENTO.toString(), UTENTE.toString(), SCUOLA.toString(), "prova.mp4", "file/" + id + ".mp4",
                    5_000_000L, "video/mp4", Origine.GALLERIA, ora.get() + urlScadeInMs, ora.get() + tokenScadeInMs);
            coda.aggiungiSpostando(voce, preparato);
            File segreto = coda.fileSegreto(id);
            segreto.getParentFile().mkdirs();
            assertTrue(segreto.createNewFile());
            registro.videoAccodato(JOB, UTENTE, 5_000_000L, MimeLog.da("video/mp4"), Motore.WORKMANAGER);
        }

        void accoda() throws IOException {
            accoda(2 * ORA_MS, 48 * ORA_MS);
        }

        Put prossimaPut() {
            Put p = put.pollFirst();
            return p == null ? ok() : p;
        }

        Rinnovo prossimoRinnovo() {
            Rinnovo r = rinnovi.pollFirst();
            return r == null ? daCaricare() : r;
        }

        VoceCoda voce() {
            return coda.trova(JOB.toString());
        }

        /** Un'esecuzione completa: gira finché la voce non è terminale. */
        void esegui() {
            for (int giro = 0; giro < 2000; giro++) {
                VoceCoda v = voce();
                if (v.stato.terminale()) return;
                if (PoliticaCaricamento.tokenScaduto(v.tokenScadeIl, ora.get())) {
                    fallisci(v, Codice.TOKEN_SCADUTO, Operazione.RINNOVO);
                    return;
                }
                coda.transita(JOB.toString(), v.stato == Stato.IN_CODA ? EventoStato.AVVIATO : EventoStato.RIPRESO, null);
                v = voce();
                if (PoliticaCaricamento.serveRinnovoProattivo(v.urlScadeIl, ora.get())) {
                    traccia.add("rinnovo-proattivo");
                    if (!rinnova(v, false, null)) continue;
                    v = voce();
                }
                spedisci(v);
            }
            throw new AssertionError("il motore in miniatura non ha concluso in 2000 giri");
        }

        void spedisci(VoceCoda v) {
            Put p = prossimaPut();
            chiamatePut++;
            traccia.add("put " + p.stato);
            ora.addAndGet(p.durataMs);
            CorpoRifiuto corpo = PoliticaCaricamento.leggiCorpoRifiuto(p.corpo);
            DecisionePut d = PoliticaCaricamento.decidiPut(p.stato, corpo, p.retryAfter, p.completo);
            final int consecutivi = PoliticaCaricamento.rinnoviConsecutiviDopoPut(v.rinnoviConsecutivi, d.azione);
            coda.modifica(JOB.toString(), x -> x.rinnoviConsecutivi = consecutivi);
            v = voce();
            switch (d.azione) {
                case INVIATO:
                    coda.transita(JOB.toString(), EventoStato.INVIATO, null);
                    registro.videoInviato(JOB, UTENTE, v.byteTotali, p.durataMs, v.tentativi, v.rinnovi, EsitoInvio.PUT, true);
                    return;
                case TROPPO_GRANDE:
                    fallisci(v, Codice.TROPPO_GRANDE, Operazione.PUT);
                    return;
                case ATTESA:
                    attendi(v, d.codice, d.retryAfterSecondi, p.stato);
                    return;
                case RINNOVA:
                    if (d.oltreScadenza) registro.putOltreScadenza(JOB, UTENTE, p.durataMs / 1000L, p.stato);
                    // L'URL è stato rifiutato: finché il rinnovo non ne consegna uno nuovo non si può rispedire con quello. Si azzera
                    // la scadenza (= «sconosciuta»): `serveRinnovoProattivo(0)` è vero, e se il rinnovo cade (429, rete, 5xx) il giro
                    // dopo ricomincia dal rinnovo e non da una PUT destinata a essere rifiutata ancora.
                    coda.modifica(JOB.toString(), x -> x.urlScadeIl = 0L);
                    rinnova(v, true, corpo.errore);
                    return;
                default:
                    throw new AssertionError(d.azione);
            }
        }

        /** Vero se si può spedire subito dopo (nuova URL); falso se la voce ha aspettato o è terminale. */
        boolean rinnova(VoceCoda v, boolean daRifiuto, ErroreStorage errorePut) {
            Rinnovo r = prossimoRinnovo();
            chiamateRinnovo++;
            RispostaRinnovo risposta = PoliticaCaricamento.leggiRispostaRinnovo(r.stato, r.corpo, r.retryAfter, false);
            DecisioneRinnovo d = PoliticaCaricamento.decidiRinnovo(risposta, v.rinnoviConsecutivi, daRifiuto, false);
            final int rinnoviDopo = v.rinnovi + (d.contaRinnovo ? 1 : 0);
            registro.videoRinnovo(JOB, UTENTE, d.esito, r.stato, rinnoviDopo, errorePut);
            switch (d.azione) {
                case NUOVA_PUT:
                    final long scadenza = PoliticaCaricamento.scadenzaUrlDopoRinnovoMs(ora.get());
                    coda.modifica(JOB.toString(), x -> {
                        x.rinnovi = rinnoviDopo;
                        x.rinnoviConsecutivi = d.rinnoviConsecutivi;
                        x.urlScadeIl = scadenza;
                    });
                    return true;
                case INVIATO:
                    coda.transita(JOB.toString(), EventoStato.INVIATO, null);
                    registro.videoInviato(JOB, UTENTE, v.byteTotali, 0L, v.tentativi, v.rinnovi, EsitoInvio.GIA_ARRIVATO, true);
                    return false;
                case ANNULLATO:
                    coda.transita(JOB.toString(), EventoStato.ANNULLATO, d.codice);
                    registro.videoAnnullato(JOB, UTENTE, RegistroNativo.Da.SERVER, 0L);
                    return false;
                case FALLITO:
                    coda.modifica(JOB.toString(), x -> x.rinnovi = rinnoviDopo);
                    fallisci(voce(), d.codice, Operazione.RINNOVO);
                    return false;
                case ATTESA:
                    attendi(v, d.codice, d.retryAfterSecondi, r.stato);
                    return false;
                default:
                    throw new AssertionError(d.azione);
            }
        }

        void attendi(VoceCoda v, Codice codice, long retryAfterSecondi, int statoHttp) {
            final int tentativo = v.tentativi + 1;
            coda.modifica(JOB.toString(), x -> x.tentativi = tentativo);
            coda.transita(JOB.toString(), EventoStato.IN_ATTESA_DI_RETE, codice);
            long attesa = PoliticaCaricamento.attesaMs(tentativo, retryAfterSecondi, 0.5);
            registro.videoRitento(JOB, UTENTE, codice, statoHttp, tentativo, attesa / 1000L, 0L);
            traccia.add("attesa " + attesa);
            attesaTotaleMs += attesa;
            ora.addAndGet(attesa);
        }

        void fallisci(VoceCoda v, Codice codice, Operazione operazione) {
            coda.transita(JOB.toString(), EventoStato.FALLITO, codice);
            VoceCoda dopo = voce();
            registro.videoFallito(JOB, UTENTE, codice, operazione, dopo.tentativi, dopo.rinnovi);
        }
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * UTENSILI DI VERIFICA
     * ──────────────────────────────────────────────────────────────────────────── */

    /** I messaggi del registro senza `job=<uuid>`: `video-nativo-inviato`, `video-nativo-rinnovo da-caricare`... */
    private List<String> messaggi() {
        List<String> risultato = new ArrayList<>();
        for (EventoRegistrato e : registro.eventi()) risultato.add(e.messaggio.replace(": job=" + JOB, "").replace(" job=" + JOB, ""));
        return risultato;
    }

    private void verificaChiusuraPulita(Stato atteso) {
        VoceCoda v = motore.voce();
        assertSame(atteso, v.stato);
        assertNull("nessuna copia nominata", v.file);
        assertFalse("la copia non c'è più sul disco", new File(cartella, "file/" + JOB + ".mp4").exists());
        assertFalse("i segreti non ci sono più", coda.fileSegreto(JOB.toString()).exists());
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * GLI SCENARI
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void unVideoNormaleCostaDueRigheEChiudePulito() throws Exception {
        motore.accoda();
        motore.esegui();
        verificaChiusuraPulita(Stato.INVIATO);
        assertEquals(Arrays.asList("video-nativo-accodato", "video-nativo-inviato"), messaggi());
        assertTrue("al più 4 righe per un video senza intoppi (§8.1)", registro.numeroEventi() <= 4);
        assertEquals(0, motore.chiamateRinnovo);
        assertEquals(1, motore.chiamatePut);
        assertEquals(Boolean.TRUE, registro.eventi().get(1).campi.get("in_background"));
        assertEquals("put", registro.eventi().get(1).campi.get("esito"));
    }

    @Test
    public void cadeAMetaPoiRiparteEArriva() throws Exception {
        motore.accoda();
        motore.put.add(senzaRisposta());
        motore.esegui();
        verificaChiusuraPulita(Stato.INVIATO);
        assertEquals(Arrays.asList("video-nativo-accodato", "video-nativo-ritento RETE", "video-nativo-inviato"), messaggi());
        assertEquals(1, motore.voce().tentativi);
        assertEquals("la prima attesa è di 30 s", 30_000L, motore.attesaTotaleMs);
        assertEquals("URL ancora fresco: nessun rinnovo", 0, motore.chiamateRinnovo);
        assertEquals(Integer.valueOf(0), registro.eventi().get(1).stato);
    }

    @Test
    public void unUrlGiaScadutoAllaPartenzaSiRinnovaERiparte() throws Exception {
        motore.accoda();
        motore.put.add(rifiuto("InvalidJWT", "400", false, 70L));
        motore.esegui();
        verificaChiusuraPulita(Stato.INVIATO);
        assertEquals(Arrays.asList("video-nativo-accodato", "video-nativo-rinnovo da-caricare", "video-nativo-inviato"), messaggi());
        assertEquals("InvalidJWT", registro.eventi().get(1).campi.get("error_code"));
        assertEquals(1L, ((Number) registro.eventi().get(1).campi.get("rinnovi")).longValue());
        assertEquals(1, motore.voce().rinnovi);
        assertEquals("non è «oltre la scadenza»: il trasferimento non era completo", 0, count("put-oltre-scadenza"));
    }

    @Test
    public void laFirmaScadutaDuranteUnInvioLungoLasciaIlLogPutOltreScadenza() throws Exception {
        motore.accoda();
        motore.put.add(rifiuto("InvalidJWT", "400", true, 7_812_000L));        // 2 h 10' di PUT, poi 400 InvalidJWT (S0-b)
        motore.esegui();
        verificaChiusuraPulita(Stato.INVIATO);
        assertEquals(Arrays.asList("video-nativo-accodato", "put-oltre-scadenza", "video-nativo-rinnovo da-caricare", "video-nativo-inviato"), messaggi());
        EventoRegistrato oltre = registro.eventi().get(1);
        assertEquals("la durata del trasferimento in secondi", 7_812L, ((Number) oltre.campi.get("durata_s")).longValue());
        assertEquals(Integer.valueOf(400), oltre.stato);
        assertEquals(1, motore.voce().rinnovi);
    }

    @Test
    public void laSecondaPutRifiutataComeDuplicatoSiChiudeComeGiaArrivato() throws Exception {
        motore.accoda();
        motore.put.add(rifiuto("Duplicate", "409", true, 2_000L));
        motore.rinnovi.add(arrivato());
        motore.esegui();
        verificaChiusuraPulita(Stato.INVIATO);
        assertEquals(Arrays.asList("video-nativo-accodato", "video-nativo-rinnovo arrivato", "video-nativo-inviato"), messaggi());
        assertEquals("gia-arrivato", registro.eventi().get(2).campi.get("esito"));
        assertEquals("Duplicate", registro.eventi().get(1).campi.get("error_code"));
        assertEquals("nessun URL nuovo: nessun rinnovo contato", 0, motore.voce().rinnovi);
        assertEquals("e una PUT sola", 1, motore.chiamatePut);
    }

    @Test
    public void unRinnovoNegatoFallisceConTokenNonValidoENonLasciaNiente() throws Exception {
        motore.accoda();
        motore.put.add(rifiuto("Unauthorized", "403", false, 60L));
        motore.rinnovi.add(trovatoNo());
        motore.esegui();
        verificaChiusuraPulita(Stato.FALLITO);
        assertSame(Codice.TOKEN_NON_VALIDO, motore.voce().codice);
        assertEquals(Arrays.asList("video-nativo-accodato", "video-nativo-rinnovo negato", "video-nativo-fallito TOKEN_NON_VALIDO"), messaggi());
        assertEquals("rinnovo", registro.eventi().get(2).campi.get("operazione"));
        assertSame("l'ultimo è un errore", RegistroNativo.Livello.ERROR, registro.eventi().get(2).livello);
    }

    @Test
    public void ilRinnovoAnnullatoChiudeLaVoceComeAnnullataDalServer() throws Exception {
        motore.accoda();
        motore.put.add(rifiuto("InvalidRequest", "400", false, 40L));
        motore.rinnovi.add(annullato());
        motore.esegui();
        verificaChiusuraPulita(Stato.ANNULLATO);
        assertSame(Codice.ANNULLATO_DAL_SERVER, motore.voce().codice);
        assertEquals(Arrays.asList("video-nativo-accodato", "video-nativo-rinnovo annullato", "video-nativo-annullato server"), messaggi());
    }

    @Test
    public void unTroppoGrandeFallisceSenzaChiamareIlRinnovo() throws Exception {
        motore.accoda();
        motore.put.add(rifiuto("EntityTooLarge", "413", true, 4_000L));
        motore.esegui();
        verificaChiusuraPulita(Stato.FALLITO);
        assertSame(Codice.TROPPO_GRANDE, motore.voce().codice);
        assertEquals(0, motore.chiamateRinnovo);
        assertEquals(Arrays.asList("video-nativo-accodato", "video-nativo-fallito TROPPO_GRANDE"), messaggi());
        assertEquals("put", registro.eventi().get(1).campi.get("operazione"));
    }

    @Test
    public void unCicloDiFirmeRifiutateSiFermaAlQuartoRinnovoConRinnovoCiclico() throws Exception {
        motore.accoda();
        for (int i = 0; i < 10; i++) motore.put.add(rifiuto("InvalidJWT", "400", true, 7_800_000L));   // ogni PUT dura più di 2 ore
        motore.esegui();
        verificaChiusuraPulita(Stato.FALLITO);
        VoceCoda v = motore.voce();
        assertSame(Codice.RINNOVO_CICLICO, v.codice);
        assertEquals("quattro PUT rifiutate, quattro chiamate al rinnovo (la quarta dice «da-caricare» e si ferma)", 4, motore.chiamatePut);
        assertEquals(4, motore.chiamateRinnovo);
        assertEquals(4, v.rinnovi);
        assertEquals(3, v.rinnoviConsecutivi);
        assertEquals(4, count("put-oltre-scadenza"));
        List<String> m = messaggi();
        assertEquals("il rinnovo che fa scattare il tetto ha risposto da-caricare: RINNOVO_CICLICO è un codice di fallito, non un esito del rinnovo",
                "video-nativo-rinnovo da-caricare", m.get(m.size() - 2));
        assertEquals("video-nativo-fallito RINNOVO_CICLICO", m.get(m.size() - 1));
        assertTrue("nemmeno in questo caso il registro esplode: " + m.size() + " righe", m.size() <= 12);
    }

    @Test
    public void unRinnovoLimitatoAspettaIlRetryAfterEPoiRiesce() throws Exception {
        motore.accoda();
        motore.put.add(rifiuto("InvalidJWT", "400", false, 50L));
        motore.rinnovi.add(new Rinnovo(429, "{\"codice\":\"TROPPE_RICHIESTE\"}", 120L));
        motore.esegui();
        verificaChiusuraPulita(Stato.INVIATO);
        assertTrue("l'attesa è almeno il Retry-After", motore.attesaTotaleMs >= 120_000L);
        assertEquals(2, motore.chiamateRinnovo);
        assertEquals("il 429 sono i tetti del rinnovo: esito `tetto`", "video-nativo-rinnovo tetto", messaggi().get(1));
        assertEquals(429, registro.eventi().get(1).stato.intValue());
    }

    @Test
    public void unGuastoLungoDelloStorageNonFaMaiRinnovoCiclicoEIlRegistroNonInsiste() throws Exception {
        motore.accoda();
        for (int i = 0; i < 40; i++) motore.put.add(server(503));        // lo Storage fuori uso per ore
        motore.esegui();
        verificaChiusuraPulita(Stato.INVIATO);
        VoceCoda v = motore.voce();
        assertEquals(40, v.tentativi);
        assertEquals("un transitorio azzera il conto: mai un ciclo", 0, v.rinnoviConsecutivi);
        assertTrue("dopo la mezz'ora ogni ripresa rinnova (URL con più di 10'): " + v.rinnovi, v.rinnovi >= 30);
        List<Integer> tentativiLoggati = new ArrayList<>();
        for (EventoRegistrato e : registro.eventi()) {
            if (e.messaggio.startsWith("video-nativo-ritento")) tentativiLoggati.add(((Number) e.campi.get("tentativo")).intValue());
        }
        assertEquals("i ritentativi si loggano ai tentativi 1, 2, 4, 8, 16, 32: la coda insiste, il registro no",
                Arrays.asList(1, 2, 4, 8, 16, 32), tentativiLoggati);
    }

    @Test
    public void unaCadutaDiReteDiUnGiornoIntero() throws Exception {
        // 100 tentativi senza risposta: 30 s, 1', 2', 5', 10', poi 15' per volta. Non finisce mai in errore dentro la vita del token.
        motore.accoda();
        for (int i = 0; i < 100; i++) motore.put.add(senzaRisposta());
        motore.esegui();
        verificaChiusuraPulita(Stato.INVIATO);
        VoceCoda v = motore.voce();
        assertEquals(100, v.tentativi);
        assertTrue("circa un giorno di attesa: " + motore.attesaTotaleMs / ORA_MS + " ore", motore.attesaTotaleMs > 20 * ORA_MS && motore.attesaTotaleMs < 30 * ORA_MS);
        assertEquals(0, v.rinnoviConsecutivi);
        List<Integer> tentativiLoggati = new ArrayList<>();
        for (EventoRegistrato e : registro.eventi()) {
            if (e.messaggio.startsWith("video-nativo-ritento")) tentativiLoggati.add(((Number) e.campi.get("tentativo")).intValue());
        }
        assertEquals("cento tentativi, sette righe di ritento: 1, 2, 4, 8, 16, 32, 64", Arrays.asList(1, 2, 4, 8, 16, 32, 64), tentativiLoggati);
        assertTrue("il registro resta sotto il suo tetto anche dopo un giorno intero di insistenza", registro.numeroEventi() <= RegistroNativo.TETTO_EVENTI);
    }

    @Test
    public void ilTokenCheScadeMentreSiAspettaFallisceConTokenScaduto() throws Exception {
        motore.accoda(2 * ORA_MS, 3 * ORA_MS);                            // il token vale solo 3 ore in questo scenario
        for (int i = 0; i < 100; i++) motore.put.add(server(503));
        motore.esegui();
        verificaChiusuraPulita(Stato.FALLITO);
        assertSame(Codice.TOKEN_SCADUTO, motore.voce().codice);
        assertTrue("l'orologio ha superato la scadenza", ora.get() >= 1_790_000_000_000L + 3 * ORA_MS);
        List<String> m = messaggi();
        assertEquals("video-nativo-fallito TOKEN_SCADUTO", m.get(m.size() - 1));
        assertEquals("rinnovo", registro.eventi().get(registro.numeroEventi() - 1).campi.get("operazione"));
    }

    @Test
    public void unaVoceAnnullataDalJavaScriptNonSpedisceNiente() throws Exception {
        motore.accoda();
        coda.transita(JOB.toString(), EventoStato.ANNULLATO, null);
        registro.videoAnnullato(JOB, UTENTE, RegistroNativo.Da.UTENTE, 0L);
        motore.esegui();
        verificaChiusuraPulita(Stato.ANNULLATO);
        assertEquals(0, motore.chiamatePut);
        assertEquals(Arrays.asList("video-nativo-accodato", "video-nativo-annullato utente"), messaggi());
    }

    @Test
    public void iLogDiOgniScenarioPassanoLeRegoleDiPrivacyEDiForma() throws Exception {
        // Un video con tutti i guai insieme: ciò che esce non può contenere nome, percorso, URL, token, hash.
        motore.accoda();
        motore.put.add(senzaRisposta());
        motore.put.add(rifiuto("InvalidJWT", "400", true, 7_812_000L));
        motore.put.add(server(503));
        motore.rinnovi.add(new Rinnovo(429, null, 30L));
        motore.esegui();
        verificaChiusuraPulita(Stato.INVIATO);
        for (EventoRegistrato e : registro.eventi()) {
            assertFalse(e.messaggio, e.messaggio.contains("prova.mp4") || e.messaggio.contains("supabase") || e.messaggio.contains("://"));
            assertFalse(e.campi.toString(), e.campi.toString().contains("prova") || e.campi.toString().contains("supabase") || e.campi.toString().contains("://"));
            assertEquals("versione_app", "1.2+4", e.campi.get("versione_app"));
            assertTrue(e.campi.size() <= RegistroNativo.CAMPI_MASSIMI);
        }
        assertEquals(UTENTE.toString(), registro.eventi().get(0).utenteId);
    }

    private int count(String prefisso) {
        int n = 0;
        for (String m : messaggi()) if (m.startsWith(prefisso)) n++;
        return n;
    }

    @Test
    public void ilFormatoDelleChiaviDiUnJobSiSpiegaDaSolo() {
        // La chiave `String.format("%08x-…")` produce uuid in minuscolo: lo stesso alfabeto che la coda pretende.
        assertEquals("00000001-1111-4111-8111-000000000001", String.format(Locale.ROOT, "%08x-1111-4111-8111-%012x", 1, 1));
    }
}
