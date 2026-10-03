package it.kidville.app.caricamenti;

import it.kidville.app.caricamenti.CodaCaricamenti.EsitoTransizione;
import it.kidville.app.caricamenti.CodaCaricamenti.TipoTransizione;
import it.kidville.app.caricamenti.CodaCaricamenti.VoceCoda;
import it.kidville.app.caricamenti.PoliticaCaricamento.Codice;
import it.kidville.app.caricamenti.PoliticaCaricamento.CorpoRifiuto;
import it.kidville.app.caricamenti.PoliticaCaricamento.DecisionePut;
import it.kidville.app.caricamenti.PoliticaCaricamento.DecisioneRinnovo;
import it.kidville.app.caricamenti.PoliticaCaricamento.ErroreStorage;
import it.kidville.app.caricamenti.PoliticaCaricamento.EsitoRinnovo;
import it.kidville.app.caricamenti.PoliticaCaricamento.EventoStato;
import it.kidville.app.caricamenti.PoliticaCaricamento.RispostaRinnovo;
import it.kidville.app.caricamenti.PoliticaCaricamento.Stato;
import it.kidville.app.caricamenti.PoliticaCaricamento.TipoRinnovo;
import it.kidville.app.caricamenti.RegistroNativo.ClasseErrore;
import it.kidville.app.caricamenti.RegistroNativo.Da;
import it.kidville.app.caricamenti.RegistroNativo.EsitoInvio;
import it.kidville.app.caricamenti.RegistroNativo.Operazione;
import it.kidville.app.caricamenti.SegretiCaricamenti.Esito;
import it.kidville.app.caricamenti.SegretiCaricamenti.Lettura;
import it.kidville.app.caricamenti.SegretiCaricamenti.Segreti;

import java.io.File;
import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.LongConsumer;

/**
 * L'ESECUTORE DELLA CODA: il ciclo SEQUENZIALE, uno solo, condiviso dai due gusci (WorkManager e UIDT).
 * (spec 2026-10-03 «app 1.2: caricamenti nativi in background», §3, §4.3-4.6, §6.1, §6.2, §8; compito A2)
 *
 * ─── CHE COSA FA ─────────────────────────────────────────────────────────────────────────────
 * Prende le voci vive di {@link CodaCaricamenti} dalla più vecchia e per ognuna rifà il giro che la politica
 * ({@link PoliticaCaricamento}) detta, una voce alla volta: controlla che la copia ci sia e pesi quanto deve, che il token non sia
 * scaduto, rinnova l'URL se è stato firmato da più di 10 minuti (regola di S0: lo Storage verifica la firma all'ULTIMO byte),
 * spedisce con una PUT, legge l'esito e lo porta nello stato della voce, nel registro dei log e verso chi ascolta. Finché c'è
 * qualcosa da fare non esce: dorme (con un tetto) quando tutte le voci aspettano il loro prossimo tentativo, aspetta la rete quando
 * manca, e ritorna solo quando non resta niente (`FINITO`), quando il guscio lo ferma (`INTERROTTO`) o quando la rete è mancata
 * oltre il tetto che il guscio ha dato (`RIPROVA`).
 *
 * ─── PERCHÉ UNO SOLO, E SEQUENZIALE ──────────────────────────────────────────────────────────
 * «Android: esecutore sequenziale» (§2.2): il guscio è uno (un lavoro unico di WorkManager, un job UIDT con un solo ID) e due PUT
 * in parallelo dividerebbero la banda senza finire prima. Un video da 2 GB che aspetta dietro un altro è un'attesa; due che
 * competono sono due trasferimenti che cadono insieme.
 *
 * ─── COME È FATTO ────────────────────────────────────────────────────────────────────────────
 *  · PURO: niente `android.*`, niente `Context`, niente orologio né rete direttamente. Tutto ciò che tocca il mondo è una
 *    INTERFACCIA iniettata ({@link TrasportoPut}, {@link TrasportoRinnovo}, {@link Rete}, {@link Ambiente}, {@link Presentazione}):
 *    in produzione le implementano `CaricatorePut`, `RinnovoFirma` e `PianificatoreCaricamenti`; nei test dei finti con un orologio
 *    che si sposta a comando. Per questo ogni scenario di §11.1 che si può giudicare senza un telefono è provato in JUnit.
 *  · LE DECISIONI SONO DELLA POLITICA. Qui non c'è nessuna tabella: ogni «che cosa faccio di questo esito?» passa da
 *    `PoliticaCaricamento` (provata riga per riga), e questo file le esegue nell'ordine giusto. Sono quattro gli ordini che contano,
 *    e li hanno scoperti i secondari di A1:
 *      1. il rinnovo si fa DOPO `AVVIATO`/`RIPRESO`: da `in-coda`, `in-attesa` o `in-pausa` un `arrivato` → `inviato` non è nella
 *         tabella di §4.4 (`NON_AMMESSA`);
 *      2. dopo un rifiuto della PUT `urlScadeIl` si AZZERA: finché il rinnovo non ne consegna uno nuovo non si rispedisce con
 *         quello, e se il rinnovo cade (429, rete) il giro dopo ricomincia dal rinnovo;
 *      3. i segreti nuovi si salvano PRIMA di aggiornare la coda: se il processo muore in mezzo, la coda dice «URL sconosciuto» e si
 *         rinnova di nuovo, mentre il contrario userebbe un URL scaduto credendolo fresco;
 *      4. `rinnoviConsecutivi` conta solo i rinnovi chiesti da un RIFIUTO della PUT: il proattivo non lo alza, un esito transitorio
 *         lo azzera (vedi la testata di `PoliticaCaricamento`).
 *  · LO STATO SI SCRIVE SUBITO. Ogni transizione e ogni attesa vanno su `coda.json` prima del passo dopo: un processo ucciso a
 *    metà lascia lo stato di prima o quello di dopo. `byteInviati` invece sta SOLO in memoria (una PUT che riparte ricomincia da
 *    zero), ed è ciò che il ponte legge per l'avanzamento.
 *  · LA RETE CHE MANCA NON È UN GUASTO. Prima di ogni giro si guarda {@link Rete#disponibile}: se manca, le voci vanno `in-attesa`
 *    (`RETE`) senza consumare un tentativo, e si aspetta la rete fino al tetto del guscio (10' per il lavoro di WorkManager, che
 *    tiene il servizio in primo piano; §6.2). Tornata la rete le voci in attesa `RETE` ripartono SUBITO, senza finire il loro
 *    ritardo. Una PUT che cade con la rete presente invece segue le attese di §4.5 (30 s, 1', 2'...).
 *  · NESSUN TETTO AL NUMERO DI TENTATIVI: «mai più errori» vuol dire insistere finché il server lo permette (il token vale 48 ore),
 *    non arrendersi al quinto. Sono i LOG dei ritentativi a diradarsi (1, 2, 4, 8, 16...), non la coda.
 *  · NIENTE DATI PERSONALI IN NESSUN LOG: il registro (`RegistroNativo`) prende solo uuid, numeri ed enumerati, e questo file non
 *    passa mai un nome di file, un percorso, un URL, un token o un hash. I guasti interni vanno in {@link Ambiente#guasto} con la
 *    sola CLASSE dell'eccezione.
 *
 * ─── CHI PARLA CON L'ESECUTORE, DA ALTRI THREAD ──────────────────────────────────────────────
 * Il ponte (`accodaVideo`, `annulla`) e il guscio (`onStopJob`, `onStopped`) lo chiamano mentre il ciclo gira: {@link #notificaLavoro}
 * dice se un ciclo attivo si accorgerà da solo di una voce nuova (altrimenti il chiamante deve avviare un guscio), {@link #annulla}
 * ferma il trasferimento in volo e chiude la voce, {@link #ferma} interrompe tutto, {@link #segnala} sveglia un'attesa. Il passaggio
 * fra «il ciclo sta finendo» e «arriva una voce nuova» è ATOMICO (un solo blocco, {@link #serratura}): una voce non resta mai
 * accodata senza nessuno che la guardi.
 */
public final class EsecutoreCoda {

    /** Come è finito un giro dell'esecutore. */
    public enum EsitoCiclo {
        /** Nessuna voce viva: non c'è più niente da fare. */
        FINITO,
        /** La rete è mancata oltre il tetto del guscio: il guscio si riprogramma (`Result.retry()`, `jobFinished(true)`). */
        RIPROVA,
        /** Il guscio ha chiamato {@link #ferma}: il trasferimento in volo si è interrotto e la voce è tornata `in-attesa`. */
        INTERROTTO,
        /** Un altro giro è già in corso: questo non ha fatto niente (e non ce n'è bisogno, l'altro vede tutto). */
        GIA_ATTIVO
    }

    /** Ogni quanto si guarda la rete mentre si aspetta (§6.2: il worker aspetta, non si sveglia a ogni cambio di rete). */
    public static final long PASSO_ATTESA_RETE_MS = 2_000L;

    /** Non si dorme mai più di così in un colpo solo (un'ora e un minuto): oltre, qualcosa nell'orologio non torna e si ricalcola. */
    static final long TETTO_SONNO_MS = (PoliticaCaricamento.RETRY_AFTER_MASSIMO_SECONDI + 60L) * 1000L;

    /** Un avanzamento di notifica al massimo ogni secondo: il sistema scarta gli aggiornamenti troppo fitti. */
    static final long INTERVALLO_NOTIFICA_MS = 1_000L;

    /** Dopo un'eccezione imprevista non si ripassa subito dalla stessa voce: si dorme questo tanto (poi il ritardo normale). */
    static final long PAUSA_DOPO_GUASTO_MS = 1_000L;

    /** Quanti token «più recenti» si provano in un solo rinnovo prima di arrendersi a `TOKEN_NON_VALIDO` (una rotazione ne lascia uno). */
    static final int GIRI_CON_TOKEN_NUOVO_MASSIMI = 3;

    /**
     * Quante PUT di fila si fanno nello stesso giro di una voce: una, più una per ogni rifiuto risolto da un rinnovo (al più tre,
     * poi `RINNOVO_CICLICO`). Il tetto di sicurezza sta sopra: se si arriva qui c'è un difetto, non un caso, e la voce si ferma.
     */
    static final int GIRI_DI_PUT_MASSIMI = PoliticaCaricamento.TETTO_RINNOVI_CONSECUTIVI + 3;

    /* ────────────────────────────────────────────────────────────────────────────
     * LE INTERFACCE CON IL MONDO
     * ──────────────────────────────────────────────────────────────────────────── */

    /**
     * Interrompere dall'esterno una PUT in volo (un altro thread, il guscio che si ferma, l'utente che annulla). `interrompi` alza una
     * bandiera che il trasportatore legge fra un blocco e l'altro, ed esegue il GANCIO che il trasportatore ha registrato: chiudere
     * la connessione, che è l'unico modo di sbloccare una `write` ferma su una rete che non risponde (le scritture su un socket non
     * hanno un tempo massimo).
     */
    public static final class Interruzione {
        private volatile boolean richiesta;
        private volatile Runnable gancio;

        public boolean richiesta() {
            return richiesta;
        }

        /** Chiede di fermarsi; se un gancio è già registrato lo esegue ora. Si può chiamare più volte, da qualunque thread. */
        public void interrompi() {
            richiesta = true;
            Runnable g = gancio;
            if (g != null) eseguiGancio(g);
        }

        /** Il trasportatore registra come si chiude la connessione. Se l'interruzione era già stata chiesta lo esegue subito. */
        public void agganciaA(Runnable nuovoGancio) {
            gancio = nuovoGancio;
            if (richiesta && nuovoGancio != null) eseguiGancio(nuovoGancio);
        }

        private static void eseguiGancio(Runnable g) {
            try {
                g.run();
            } catch (RuntimeException chiusuraNonRiuscita) {
                // Il gancio chiude una connessione: se non ci riesce la bandiera resta alzata e la PUT si ferma al blocco dopo, o scade.
            }
        }
    }

    /** Ciò che serve al trasportatore per spedire UNA voce. */
    public static final class RichiestaPut {
        public final String url;
        public final String contentType;
        public final File file;
        public final long byteTotali;
        /** Chiamata con i byte spediti finora, al più una volta ogni 500 ms o 1%. */
        public final LongConsumer avanzamento;
        public final Interruzione interruzione;

        public RichiestaPut(String url, String contentType, File file, long byteTotali, LongConsumer avanzamento, Interruzione interruzione) {
            this.url = url;
            this.contentType = contentType;
            this.file = file;
            this.byteTotali = byteTotali;
            this.avanzamento = avanzamento;
            this.interruzione = interruzione;
        }
    }

    /** Come è andata una PUT, già ridotta a ciò che la politica sa leggere. Immutabile; il corpo è al più di 4 KB. */
    public static final class EsitoPut {
        public enum Tipo {
            /** Il server ha risposto: `stato` è lo stato HTTP e `corpo` i primi 4 KB del corpo (vuoto per un 2xx). */
            RISPOSTA,
            /** Nessuna risposta: rete caduta, tempo scaduto, connessione persa. */
            NESSUNA_RISPOSTA,
            /** Qualcuno ha chiesto di fermarsi ({@link Interruzione}). */
            INTERROTTO,
            /** La copia non c'è più sul disco. */
            FILE_ASSENTE,
            /** La copia pesa un numero di byte diverso da quello che la voce dichiara. */
            PESO_DIVERSO
        }

        public final Tipo tipo;
        /** Lo stato HTTP; 0 se non c'è stata una risposta. */
        public final int stato;
        public final byte[] corpo;
        public final long retryAfterSecondi;
        public final long byteInviati;
        /** Quanto è durato il trasferimento, dal primo byte alla risposta o alla caduta. */
        public final long durataMs;
        /** Vero se tutti i byte erano stati spediti quando la risposta è arrivata. */
        public final boolean completo;
        /** La classe dell'eccezione che ha causato una caduta (solo per la diagnostica, mai il messaggio); `null` altrimenti. */
        public final ClasseErrore classe;

        EsitoPut(Tipo tipo, int stato, byte[] corpo, long retryAfterSecondi, long byteInviati, long durataMs, boolean completo,
                 ClasseErrore classe) {
            this.tipo = tipo;
            this.stato = stato;
            this.corpo = corpo == null ? new byte[0] : corpo;
            this.retryAfterSecondi = retryAfterSecondi;
            this.byteInviati = byteInviati;
            this.durataMs = durataMs;
            this.completo = completo;
            this.classe = classe;
        }

        public static EsitoPut risposta(int stato, byte[] corpo, long retryAfterSecondi, long byteInviati, long durataMs, boolean completo) {
            return new EsitoPut(Tipo.RISPOSTA, stato, corpo, retryAfterSecondi, byteInviati, durataMs, completo, null);
        }

        public static EsitoPut nessunaRisposta(long byteInviati, long durataMs, ClasseErrore classe) {
            return new EsitoPut(Tipo.NESSUNA_RISPOSTA, 0, null, 0L, byteInviati, durataMs, false, classe);
        }

        public static EsitoPut interrotto(long byteInviati, long durataMs) {
            return new EsitoPut(Tipo.INTERROTTO, 0, null, 0L, byteInviati, durataMs, false, null);
        }

        public static EsitoPut fileAssente() {
            return new EsitoPut(Tipo.FILE_ASSENTE, 0, null, 0L, 0L, 0L, false, null);
        }

        public static EsitoPut pesoDiverso() {
            return new EsitoPut(Tipo.PESO_DIVERSO, 0, null, 0L, 0L, 0L, false, null);
        }
    }

    /** Spedisce un file con una PUT. NON lancia mai: ogni guasto è un {@link EsitoPut}. In produzione `CaricatorePut`. */
    public interface TrasportoPut {
        EsitoPut invia(RichiestaPut richiesta);
    }

    /** La risposta HTTP di un rinnovo: `stato` 0 vuol dire nessuna risposta. */
    public static final class RispostaHttp {
        public final int stato;
        public final String corpo;
        public final long retryAfterSecondi;
        public final ClasseErrore classe;

        public RispostaHttp(int stato, String corpo, long retryAfterSecondi, ClasseErrore classe) {
            this.stato = stato;
            this.corpo = corpo;
            this.retryAfterSecondi = retryAfterSecondi;
            this.classe = classe;
        }

        public static RispostaHttp nessunaRisposta(ClasseErrore classe) {
            return new RispostaHttp(0, null, 0L, classe);
        }
    }

    /** `POST` del rinnovo col token nell'intestazione. NON lancia mai. In produzione `RinnovoFirma`. */
    public interface TrasportoRinnovo {
        RispostaHttp rinnova(String url, String token);
    }

    /** La rete del telefono. */
    public interface Rete {
        /** C'è una rete su cui provare? (Internet raggiungibile; non si pretende la «convalida» del sistema: vedi `ReteAndroid`.) */
        boolean disponibile();

        /** Aspetta al più `massimoMs` o finché la rete torna; si può tornare prima. */
        void attendi(long massimoMs) throws InterruptedException;
    }

    /** Tutto il resto del mondo: il tempo, il caso, la build, il primo piano, il log di guasto. */
    public interface Ambiente {
        /** Millisecondi dall'epoca (l'orologio del muro: contano le scadenze del token e dell'URL). */
        long adesso();

        /** Un numero in [0, 1] per lo scarto delle attese. */
        double casuale();

        /** Vero nelle build Debug (host in chiaro verso il computer, §9). */
        boolean debug();

        /** Vero se l'app non è in primo piano (per `in_background` di `video-nativo-inviato`). */
        boolean inBackground();

        /** Vero se il sistema lascia mostrare le notifiche dell'app (per `autorizzata` di `video-nativo-attesa-rete`). */
        boolean notificheAutorizzate();

        /** Aspetta `ms` sul monitor dato (che {@link #segnala} sveglia con `notifyAll`). In produzione `monitor.wait(ms)`. */
        void pausa(Object monitor, long ms) throws InterruptedException;

        /** Il registro ha qualcosa da spedire (una voce è finita): chi lo possiede lo svuota, senza bloccare l'esecutore. */
        void registroDaSvuotare();

        /** Un guasto interno dell'esecutore o dei suoi accessori: va in logcat con la sola CLASSE dell'eccezione. */
        void guasto(String evento, Throwable causa);
    }

    /** Come il guscio fa vedere ciò che succede: la notifica, e i byte trasferiti per il sistema. */
    public interface Presentazione {
        /** Avanzamento: byte della voce in corso, suo totale, e byte spediti in tutto da quando il giro è cominciato. */
        void avanzamento(long inviatiVoce, long totaleVoce, long inviatiNelGiro);

        /** Si è cominciato (`true`) o finito (`false`) di aspettare la rete: la notifica cambia testo. */
        void inAttesaDiRete(boolean inAttesa);
    }

    /** Chi vuole sapere di ogni cambiamento di una voce (il ponte, che lo manda al JavaScript come evento `caricamento`). */
    public interface Osservatore {
        void suVoce(VoceCoda voce, long byteInviati);
    }

    private static final Presentazione PRESENTAZIONE_NULLA = new Presentazione() {
        @Override
        public void avanzamento(long inviatiVoce, long totaleVoce, long inviatiNelGiro) {
        }

        @Override
        public void inAttesaDiRete(boolean inAttesa) {
        }
    };

    /* ────────────────────────────────────────────────────────────────────────────
     * LO STATO
     * ──────────────────────────────────────────────────────────────────────────── */

    private final CodaCaricamenti coda;
    private final RegistroNativo registro;
    private final SegretiCaricamenti segreti;
    private final TrasportoPut put;
    private final TrasportoRinnovo rinnovo;
    private final Rete rete;
    private final Ambiente ambiente;

    /** Tutto ciò che decide se il ciclo è attivo, e chi lo deve avviare: un blocco solo (vedi la testata). */
    private final Object serratura = new Object();
    private boolean attivo;
    private volatile boolean fermo;

    /** L'attesa interrompibile: `segnala` alza `segnalato` e sveglia chi dorme. */
    private final Object sveglia = new Object();
    private boolean segnalato;

    /** Il trasferimento in volo, per fermarlo dall'esterno. */
    private volatile String jobInCorso;
    private volatile Interruzione interruzioneInCorso;

    /** `byteInviati` di ogni voce che sta spedendo: in memoria, mai su disco. */
    private final Map<String, Long> avanzamento = new ConcurrentHashMap<>();
    private volatile Osservatore osservatore;

    /* Stato del giro: toccato solo dal thread che esegue. */
    private boolean inAttesaDiRete;
    private long inizioAttesaRete;
    private boolean attesaReteLoggata;
    private long inviatiNelGiro;
    private long ultimaNotificaMs;
    private boolean residuiVisti;

    public EsecutoreCoda(CodaCaricamenti coda, RegistroNativo registro, SegretiCaricamenti segreti, TrasportoPut put,
                         TrasportoRinnovo rinnovo, Rete rete, Ambiente ambiente) {
        this.coda = coda;
        this.registro = registro;
        this.segreti = segreti;
        this.put = put;
        this.rinnovo = rinnovo;
        this.rete = rete;
        this.ambiente = ambiente;
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL PUNTO DI INGRESSO E I COMANDI DA ALTRI THREAD
     * ──────────────────────────────────────────────────────────────────────────── */

    /**
     * Fa girare il ciclo finché c'è qualcosa da fare. Si chiama dal thread di lavoro del guscio e BLOCCA: ritorna quando le voci vive
     * sono finite, quando il guscio lo ferma o quando la rete è mancata oltre `attesaReteMassimaMs`.
     *
     * @param presentazione   dove mostrare l'avanzamento (può essere `null`)
     * @param attesaReteMassimaMs per quanto aspettare la rete prima di restituire `RIPROVA`: 10' per il lavoro di WorkManager (§6.2)
     */
    public EsitoCiclo esegui(Presentazione presentazione, long attesaReteMassimaMs) {
        synchronized (serratura) {
            if (attivo) return EsitoCiclo.GIA_ATTIVO;
            attivo = true;
            fermo = false;
        }
        inAttesaDiRete = false;
        attesaReteLoggata = false;
        inviatiNelGiro = 0L;
        ultimaNotificaMs = 0L;
        residuiVisti = false;
        Presentazione p = presentazione != null ? presentazione : PRESENTAZIONE_NULLA;
        boolean chiusoDaIlCiclo = false;
        try {
            EsitoCiclo esito = ciclo(p, attesaReteMassimaMs);
            // `ciclo` chiude l'attività SOTTO la serratura quando esce per `FINITO` (e ha già fatto prima le sue pulizie); per gli altri
            // esiti — o per un'eccezione — la chiude il `finally`.
            chiusoDaIlCiclo = esito == EsitoCiclo.FINITO;
            return esito;
        } finally {
            if (!chiusoDaIlCiclo) {
                // Prima si ripulisce lo stato del giro e POI si rilascia `attivo`: un altro guscio che parte subito dopo non deve trovare
                // (né pestare) l'interruzione, la notifica o i residui di questo.
                chiudiIlGiro(p);
                synchronized (serratura) {
                    attivo = false;
                }
            }
        }
    }

    /** Ciò che si fa a ciclo fermo, appena prima di rilasciarlo: nessuna PUT in volo, la notifica torna normale, i residui si puliscono. */
    private void chiudiIlGiro(Presentazione presentazione) {
        jobInCorso = null;
        interruzioneInCorso = null;
        if (inAttesaDiRete) {
            inAttesaDiRete = false;
            presentazione.inAttesaDiRete(false);
        }
        if (residuiVisti) {
            residuiVisti = false;
            pulisciResidui();
        }
    }

    /**
     * Una voce nuova (o un cambiamento che vale subito): se un ciclo è attivo lo avverte e restituisce `true` — vedrà la voce da solo,
     * non serve avviare niente. Se non c'è un ciclo restituisce `false`, e chi chiama deve avviare il guscio. Il controllo e
     * l'uscita del ciclo sono sotto la stessa serratura: non si perde mai una voce fra «stavo finendo» e «è arrivata».
     *
     * ⚠️ Da chiamare FUORI dal blocco della coda (`synchronized (coda)`): il ciclo prende la serratura e POI la coda quando esce, e
     * l'ordine contrario sarebbe un deadlock.
     */
    public boolean notificaLavoro() {
        synchronized (serratura) {
            if (!attivo) return false;
        }
        segnala();
        return true;
    }

    /** Vero se un ciclo sta girando. */
    public boolean attivo() {
        synchronized (serratura) {
            return attivo;
        }
    }

    /** Sveglia un'attesa in corso (ritardo di una voce, attesa della rete): qualcosa è cambiato e conviene riguardare la coda. */
    public void segnala() {
        synchronized (sveglia) {
            segnalato = true;
            sveglia.notifyAll();
        }
    }

    /**
     * Ferma tutto, il prima possibile: la PUT in volo si interrompe (la connessione si chiude, la voce torna `in-attesa`) e il
     * ciclo esce con `INTERROTTO`. Lo chiamano `onStopJob` e `onStopped`. Non fa niente se non c'è un ciclo.
     */
    public void ferma() {
        synchronized (serratura) {
            if (!attivo) return;
            fermo = true;
        }
        Interruzione i = interruzioneInCorso;
        if (i != null) i.interrompi();
        segnala();
    }

    /**
     * L'utente annulla una voce (`annulla` del ponte, §4.3): ferma il trasferimento se è quello in volo, chiude la voce `annullato`
     * (copia e segreti cancellati dalla coda) e lo scrive nel registro. Restituisce vero se c'era una voce VIVA e ora è annullata.
     * NON ritira l'intento sul server: lo fa il JavaScript, dopo (§7.6, regola #58: prima si fermano i byte).
     */
    public boolean annulla(String jobId) {
        if (jobId == null) return false;
        VoceCoda prima = coda.trova(jobId);
        if (prima == null || prima.stato.terminale()) return false;
        if (jobId.equals(jobInCorso)) {
            Interruzione i = interruzioneInCorso;
            if (i != null) i.interrompi();
        }
        EsitoTransizione e = coda.transita(jobId, EventoStato.ANNULLATO, null);
        if (e.tipo != TipoTransizione.APPLICATA) return false;
        long inviati = valore(avanzamento.get(jobId));
        registro.videoAnnullato(uuid(jobId), uuid(e.voce.utenteId), Da.UTENTE, inviati);
        chiudiLaVoce(e);
        segnala();
        return true;
    }

    /** I byte spediti finora dalla voce, in memoria (0 se non sta spedendo, o se il processo è ripartito). */
    public long byteInviati(String jobId) {
        return valore(avanzamento.get(jobId));
    }

    /** Dimentica i byte di una voce (la coda l'ha tolta). */
    public void dimenticaAvanzamento(String jobId) {
        avanzamento.remove(jobId);
    }

    public void impostaOsservatore(Osservatore nuovo) {
        osservatore = nuovo;
    }

    /** Dice all'osservatore (se c'è) che una voce è cambiata. Chiamabile da altri thread. */
    public void notificaVoce(VoceCoda voce) {
        Osservatore o = osservatore;
        if (o == null || voce == null) return;
        try {
            o.suVoce(voce, byteInviatiPerLaNotifica(voce));
        } catch (RuntimeException guastoDelloOsservatore) {
            // Chi ascolta (il ponte verso il JavaScript) non deve poter fermare il trasferimento: si dice e si va avanti.
            ambiente.guasto("osservatore", guastoDelloOsservatore);
        }
    }

    private long byteInviatiPerLaNotifica(VoceCoda voce) {
        return voce.stato == Stato.IN_INVIO ? valore(avanzamento.get(voce.jobId)) : 0L;
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL CICLO
     * ──────────────────────────────────────────────────────────────────────────── */

    private EsitoCiclo ciclo(Presentazione presentazione, long attesaReteMassimaMs) {
        for (;;) {
            if (fermo) return EsitoCiclo.INTERROTTO;
            List<VoceCoda> vive = coda.vive();
            if (vive.isEmpty()) {
                // Le pulizie di fine giro PRIMA del controllo che chiude, e fuori dalla serratura: toccano il disco e la notifica.
                chiudiIlGiro(presentazione);
                synchronized (serratura) {
                    // Il controllo e l'uscita sono atomici rispetto a `notificaLavoro`: o la voce nuova la vediamo qui, o chi l'ha
                    // accodata troverà `attivo == false` e avvierà un guscio. Dopo `attivo = false` questo thread non tocca più niente.
                    if (coda.vive().isEmpty()) {
                        attivo = false;
                        return EsitoCiclo.FINITO;
                    }
                }
                continue;
            }
            long adesso = ambiente.adesso();
            if (!rete.disponibile()) {
                EsitoCiclo uscita = aspettaLaRete(vive, presentazione, attesaReteMassimaMs, adesso);
                if (uscita != null) return uscita;
                continue;
            }
            if (inAttesaDiRete) {
                tornataLaRete(vive, presentazione);
                // Le voci cambiate sono nella coda, non nella lista che si ha in mano: si rilegge, o si sceglierebbe con i ritardi di prima.
                continue;
            }
            VoceCoda scelta = prossimaPronta(vive, adesso);
            if (scelta == null) {
                if (!dormiFinoAlProssimo(vive, adesso)) return EsitoCiclo.INTERROTTO;
                continue;
            }
            try {
                lavora(scelta, presentazione);
            } catch (RuntimeException imprevisto) {
                guastoImprevisto(scelta, imprevisto);
                if (!dormi(PAUSA_DOPO_GUASTO_MS)) return EsitoCiclo.INTERROTTO;
            }
        }
    }

    /** La voce più vecchia il cui prossimo tentativo è arrivato (0 = subito). */
    private static VoceCoda prossimaPronta(List<VoceCoda> vive, long adesso) {
        for (VoceCoda voce : vive) {
            if (voce.prossimoTentativoIl <= adesso) return voce;
        }
        return null;
    }

    /** Dorme fino al primo ritardo che scade (con un tetto), o finché `segnala` non sveglia. `false` se si è stati interrotti. */
    private boolean dormiFinoAlProssimo(List<VoceCoda> vive, long adesso) {
        long minimo = Long.MAX_VALUE;
        for (VoceCoda voce : vive) minimo = Math.min(minimo, voce.prossimoTentativoIl);
        long attesa = Math.min(Math.max(minimo - adesso, 1L), TETTO_SONNO_MS);
        return dormi(attesa);
    }

    /** Dorme `ms` (interrompibile da `segnala`). `false` se il thread è stato interrotto o il guscio ha fermato tutto. */
    private boolean dormi(long ms) {
        try {
            synchronized (sveglia) {
                if (!segnalato && !fermo) ambiente.pausa(sveglia, ms);
                segnalato = false;
            }
        } catch (InterruptedException interrotto) {
            Thread.currentThread().interrupt();
            return false;
        }
        return !fermo;
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * LA RETE CHE MANCA
     * ──────────────────────────────────────────────────────────────────────────── */

    /**
     * Manca la rete: le voci vive vanno `in-attesa` `RETE` e si aspetta fino al tetto. `null` se la rete è tornata (il ciclo
     * riparte), altrimenti l'esito con cui il ciclo esce (`RIPROVA` oltre il tetto, `INTERROTTO` se il guscio ferma tutto).
     */
    private EsitoCiclo aspettaLaRete(List<VoceCoda> vive, Presentazione presentazione, long attesaReteMassimaMs, long adesso) {
        if (!inAttesaDiRete) {
            inAttesaDiRete = true;
            inizioAttesaRete = adesso;
            attesaReteLoggata = false;
            presentazione.inAttesaDiRete(true);
            for (VoceCoda voce : vive) mettiInAttesaDiRete(voce);
        }
        while (!rete.disponibile()) {
            if (fermo) return EsitoCiclo.INTERROTTO;
            // Se nel frattempo le voci sono state annullate non c'è più niente da aspettare: si torna al ciclo, che esce.
            if (coda.vive().isEmpty()) return null;
            long atteso = ambiente.adesso() - inizioAttesaRete;
            if (!attesaReteLoggata && PoliticaCaricamento.attesaReteDaLoggare(atteso / 1000L)) {
                attesaReteLoggata = true;
                loggaAttesaDiRete();
            }
            if (atteso >= attesaReteMassimaMs) return EsitoCiclo.RIPROVA;
            try {
                rete.attendi(Math.max(1L, Math.min(PASSO_ATTESA_RETE_MS, attesaReteMassimaMs - atteso)));
            } catch (InterruptedException interrotto) {
                Thread.currentThread().interrupt();
                return EsitoCiclo.INTERROTTO;
            }
        }
        return null;
    }

    /** Porta una voce viva in `in-attesa` `RETE` passando per gli stati che la tabella di §4.4 vuole; non conta un tentativo. */
    private void mettiInAttesaDiRete(VoceCoda voce) {
        String job = voce.jobId;
        if (voce.stato == Stato.IN_CODA) {
            if (coda.transita(job, EventoStato.AVVIATO, null).tipo != TipoTransizione.APPLICATA) return;
        } else if (voce.stato == Stato.IN_PAUSA) {
            if (coda.transita(job, EventoStato.RIPRESO, null).tipo != TipoTransizione.APPLICATA) return;
        }
        EsitoTransizione e = coda.transita(job, EventoStato.IN_ATTESA_DI_RETE, Codice.RETE);
        if (e.tipo == TipoTransizione.APPLICATA || e.tipo == TipoTransizione.GIA_IN_QUELLO_STATO) notificaVoce(e.voce);
    }

    /** La rete è tornata: le voci che aspettavano la rete ripartono SUBITO, senza finire il ritardo che avevano. */
    private void tornataLaRete(List<VoceCoda> vive, Presentazione presentazione) {
        inAttesaDiRete = false;
        presentazione.inAttesaDiRete(false);
        for (VoceCoda voce : vive) {
            if (voce.stato == Stato.IN_ATTESA && voce.codice == Codice.RETE && voce.prossimoTentativoIl != 0L) {
                coda.modifica(voce.jobId, x -> x.prossimoTentativoIl = 0L);
            }
        }
    }

    private void loggaAttesaDiRete() {
        boolean autorizzata = ambiente.notificheAutorizzate();
        for (VoceCoda voce : coda.vive()) {
            registro.videoAttesaRete(uuid(voce.jobId), uuid(voce.utenteId), autorizzata, autorizzata);
        }
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL GIRO DI UNA VOCE
     * ──────────────────────────────────────────────────────────────────────────── */

    private void lavora(VoceCoda iniziale, Presentazione presentazione) {
        final String job = iniziale.jobId;
        long adesso = ambiente.adesso();

        // 1. La copia c'è e pesa quanto la voce dice: un controllo che costa niente prima di spendere una PUT o un rinnovo.
        File copia = coda.fileCopia(iniziale.file);
        if (!copia.isFile()) {
            fallisci(iniziale, Codice.FILE_ASSENTE, Operazione.COPIA);
            return;
        }
        if (copia.length() != iniziale.byteTotali) {
            fallisci(iniziale, Codice.PESO_DIVERSO, Operazione.COPIA);
            return;
        }

        // 2. Il token vale ancora? Oltre `scadeIl` nessun rinnovo potrà più riuscire: inutile insistere.
        if (PoliticaCaricamento.tokenScaduto(iniziale.tokenScadeIl, adesso)) {
            fallisci(iniziale, Codice.TOKEN_SCADUTO, Operazione.RINNOVO);
            return;
        }

        // 3. `in-invio`. Prima di qualunque rinnovo: da `in-coda`, `in-attesa` o `in-pausa` un `arrivato` non sarebbe ammesso.
        VoceCoda voce = avviaORiprendi(iniziale);
        if (voce == null) return;

        // 4. I segreti. Senza, la voce non può più né rinnovare né spedire: è perduta, e il server la chiuderà a 48 ore.
        Lettura lettura = segreti.leggi(job);
        if (lettura.esito != Esito.OK) {
            fallisci(voce, Codice.INTERNO, Operazione.PUT);
            return;
        }
        Segreti daUsare = lettura.segreti;

        // 5. Il rinnovo PROATTIVO (regola di S0): l'URL è stato firmato da più di 10 minuti, o non se ne sa l'età.
        if (PoliticaCaricamento.serveRinnovoProattivo(voce.urlScadeIl, adesso)) {
            daUsare = rinnova(voce, daUsare, false, null);
            if (daUsare == null) return;
            voce = fresca(job);
            if (voce == null || voce.stato.terminale()) return;
        }

        // 6. La PUT, e — se un rifiuto è stato risolto da un rinnovo che ha consegnato un URL nuovo — di nuovo la PUT, SUBITO: senza
        //    passare dal ciclo e dai suoi ritardi, e senza un secondo rinnovo proattivo (l'URL è appena arrivato).
        for (int giro = 0; giro < GIRI_DI_PUT_MASSIMI; giro++) {
            Segreti prossimi = spedisci(voce, daUsare, copia, presentazione);
            if (prossimi == null) return;
            daUsare = prossimi;
            voce = fresca(job);
            if (voce == null || voce.stato.terminale()) return;
        }
        attendi(voce, Codice.INTERNO, 0L, 0, 0, 0L);
    }

    /** `in-coda` → `AVVIATO`; `in-attesa`/`in-pausa` → `RIPRESO`; `in-invio` (rimasta così da un processo morto) resta com'è, e lo si scrive. */
    private VoceCoda avviaORiprendi(VoceCoda voce) {
        EventoStato evento;
        switch (voce.stato) {
            case IN_CODA:
                evento = EventoStato.AVVIATO;
                break;
            case IN_ATTESA:
            case IN_PAUSA:
                evento = EventoStato.RIPRESO;
                break;
            case IN_INVIO:
                // Una voce `in-invio` trovata a inizio giro è RIMASTA così da un processo morto (chiusura forzata, uccisione del sistema, un
                // crash): in questo processo nessuno la stava spedendo. Si riprende, e si dice (§8.2, S7 di §11.1).
                if (!avanzamento.containsKey(voce.jobId)) {
                    registro.videoRipresoDopoChiusura(uuid(voce.jobId), uuid(voce.utenteId), 0L);
                }
                return voce;
            default:
                return null;
        }
        EsitoTransizione e = coda.transita(voce.jobId, evento, null);
        if (e.tipo != TipoTransizione.APPLICATA && e.tipo != TipoTransizione.GIA_IN_QUELLO_STATO) return null;
        notificaVoce(e.voce);
        return e.voce;
    }

    /**
     * Una PUT e la sua conseguenza. Restituisce `null` se per ora la voce ha finito il suo giro (inviata, in attesa, fallita...), o i
     * segreti nuovi con cui rispedire SUBITO (un rifiuto che un rinnovo ha risolto con un URL nuovo).
     */
    private Segreti spedisci(VoceCoda voce, Segreti segretiDellaPut, File copia, Presentazione presentazione) {
        final String job = voce.jobId;
        final long totale = voce.byteTotali;
        final Interruzione interruzione = new Interruzione();
        avanzamento.put(job, 0L);
        jobInCorso = job;
        interruzioneInCorso = interruzione;
        // Una `ferma` o un `annulla` arrivati prima che `interruzioneInCorso` fosse pubblicata non hanno potuto alzarla: si ricontrolla.
        VoceCoda adessoLaVoce = coda.trova(job);
        if (fermo || adessoLaVoce == null || adessoLaVoce.stato.terminale()) interruzione.interrompi();

        final long[] ultimoAvanzamento = {0L};
        EsitoPut esito;
        try {
            esito = put.invia(new RichiestaPut(segretiDellaPut.urlPut, segretiDellaPut.contentType, copia, totale,
                    inviati -> suAvanzamento(voce, inviati, totale, ultimoAvanzamento, presentazione), interruzione));
        } finally {
            interruzioneInCorso = null;
            jobInCorso = null;
        }
        if (esito == null) esito = EsitoPut.nessunaRisposta(0L, 0L, ClasseErrore.ALTRO);
        inviatiNelGiro += Math.max(0L, esito.byteInviati - ultimoAvanzamento[0]);
        avanzamento.put(job, esito.tipo == EsitoPut.Tipo.RISPOSTA && esito.stato >= 200 && esito.stato <= 299 ? totale : 0L);

        switch (esito.tipo) {
            case INTERROTTO:
                suInterruzione(job);
                return null;
            case FILE_ASSENTE:
                fallisci(coda.trova(job), Codice.FILE_ASSENTE, Operazione.COPIA);
                return null;
            case PESO_DIVERSO:
                fallisci(coda.trova(job), Codice.PESO_DIVERSO, Operazione.COPIA);
                return null;
            default:
                return decidiLaPut(job, esito, segretiDellaPut);
        }
    }

    /**
     * I byte spediti: si tengono in memoria, si avvisa l'osservatore e si aggiorna la notifica (al più una volta al secondo). NON LANCIA
     * MAI, ed è un patto con `CaricatorePut`, che lo chiama dal ciclo di scrittura: una notifica che non si aggiorna (il permesso
     * revocato a metà, un guscio che si sta chiudendo) non deve far cadere un trasferimento da due gigabyte.
     */
    private void suAvanzamento(VoceCoda voce, long inviati, long totale, long[] ultimo, Presentazione presentazione) {
        try {
            avanzamento.put(voce.jobId, inviati);
            long delta = Math.max(0L, inviati - ultimo[0]);
            ultimo[0] = inviati;
            inviatiNelGiro += delta;
            notificaVoce(voce);
            long adesso = ambiente.adesso();
            if (adesso - ultimaNotificaMs >= INTERVALLO_NOTIFICA_MS) {
                ultimaNotificaMs = adesso;
                presentazione.avanzamento(inviati, totale, inviatiNelGiro);
            }
        } catch (RuntimeException guasto) {
            ambiente.guasto("avanzamento", guasto);
        }
    }

    /**
     * La PUT è stata interrotta: o l'utente ha annullato la voce (già terminale, niente da fare) o il guscio si ferma. In questo caso
     * la voce NON è fallita né ha sbagliato: torna `in-attesa` `RETE` con ritardo zero, e riparte da zero al prossimo giro (una PUT
     * unica non si riprende a metà).
     */
    private void suInterruzione(String job) {
        VoceCoda voce = coda.trova(job);
        if (voce == null || voce.stato.terminale()) return;
        coda.modifica(job, x -> x.prossimoTentativoIl = 0L);
        EsitoTransizione e = coda.transita(job, EventoStato.IN_ATTESA_DI_RETE, Codice.RETE);
        if (e.tipo == TipoTransizione.APPLICATA || e.tipo == TipoTransizione.GIA_IN_QUELLO_STATO) notificaVoce(e.voce);
    }

    /**
     * L'esito della PUT letto dalla politica, e il suo effetto sulla voce. `null` se il giro della voce è finito, o i segreti nuovi
     * con cui rispedire subito.
     */
    private Segreti decidiLaPut(String job, EsitoPut esito, Segreti segretiDellaPut) {
        VoceCoda voce = coda.trova(job);
        if (voce == null || voce.stato.terminale()) return null;
        CorpoRifiuto corpo = esito.tipo == EsitoPut.Tipo.RISPOSTA ? PoliticaCaricamento.leggiCorpoRifiuto(esito.corpo) : CorpoRifiuto.ASSENTE;
        DecisionePut decisione = PoliticaCaricamento.decidiPut(esito.stato, corpo, esito.retryAfterSecondi, esito.completo);
        int consecutivi = PoliticaCaricamento.rinnoviConsecutiviDopoPut(voce.rinnoviConsecutivi, decisione.azione);
        switch (decisione.azione) {
            case INVIATO:
                concludiComeInviato(voce, esito.durataMs, EsitoInvio.PUT);
                return null;
            case TROPPO_GRANDE:
                fallisci(voce, Codice.TROPPO_GRANDE, Operazione.PUT);
                return null;
            case ATTESA:
                attendi(voce, decisione.codice, decisione.retryAfterSecondi, esito.stato, consecutivi, esito.byteInviati);
                return null;
            case RINNOVA:
                if (decisione.oltreScadenza) {
                    registro.putOltreScadenza(uuid(job), uuid(voce.utenteId), esito.durataMs / 1000L, esito.stato);
                }
                // L'URL è stato rifiutato: finché il rinnovo non ne consegna uno nuovo non si rispedisce con quello. `urlScadeIl` a zero
                // vuol dire «sconosciuta»: il giro dopo comincia dal rinnovo, anche se questo rinnovo cade (429, rete, 5xx).
                final int perLaVoce = consecutivi;
                coda.modifica(job, x -> {
                    x.urlScadeIl = 0L;
                    x.rinnoviConsecutivi = perLaVoce;
                });
                VoceCoda aggiornata = fresca(job);
                if (aggiornata == null || aggiornata.stato.terminale()) return null;
                return rinnova(aggiornata, segretiDellaPut, true, corpo.errore);
            default:
                throw new IllegalStateException("azione della PUT non prevista");
        }
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL RINNOVO
     * ──────────────────────────────────────────────────────────────────────────── */

    /**
     * Chiede un URL nuovo. Restituisce i segreti con cui spedire adesso (URL nuovo; il token è quello di prima o, se il server ne
     * conosceva uno più recente, quello), oppure `null` se per ora non si spedisce: la voce è già in `in-attesa`, o è terminale.
     *
     * @param daRifiuto  vero se lo chiede un rifiuto della PUT (conta nel tetto di tre), falso se è il rinnovo proattivo
     * @param errorePut  il nome d'errore dello Storage che ha chiesto il rinnovo (per `error_code`), `null` se proattivo
     */
    private Segreti rinnova(VoceCoda voce, Segreti attuali, boolean daRifiuto, ErroreStorage errorePut) {
        final String job = voce.jobId;
        Segreti usati = attuali;
        for (int giro = 0; giro < GIRI_CON_TOKEN_NUOVO_MASSIMI; giro++) {
            RispostaHttp risposta = chiamaIlRinnovo(usati);
            long ricezione = ambiente.adesso();
            RispostaRinnovo letta = PoliticaCaricamento.leggiRispostaRinnovo(risposta.stato, risposta.corpo, risposta.retryAfterSecondi,
                    ambiente.debug());
            Segreti piuRecenti = null;
            if (letta.tipo == TipoRinnovo.NON_TROVATO) {
                // Un 404 può essere una rotazione appena arrivata (`accodaVideo` ripetuto): il token di prima è sconosciuto, ma sul
                // disco ce n'è già uno nuovo. Si riprova con quello, e solo se è DIVERSO da quello appena rifiutato.
                Lettura rilettura = segreti.leggi(job);
                if (rilettura.esito == Esito.OK && !rilettura.segreti.token.equals(usati.token)) piuRecenti = rilettura.segreti;
            }
            VoceCoda corrente = fresca(job);
            if (corrente == null || corrente.stato.terminale()) return null;
            DecisioneRinnovo decisione = PoliticaCaricamento.decidiRinnovo(letta, corrente.rinnoviConsecutivi, daRifiuto, piuRecenti != null);
            int rinnoviDopo = corrente.rinnovi + (decisione.contaRinnovo ? 1 : 0);
            int tentativiDopo = corrente.tentativi + 1;
            loggaIlRinnovo(corrente, decisione.esito, risposta.stato, rinnoviDopo, tentativiDopo, daRifiuto ? errorePut : null);
            switch (decisione.azione) {
                case NUOVA_PUT:
                    return dopoUnRinnovoRiuscito(corrente, usati, letta, decisione, rinnoviDopo, ricezione);
                case INVIATO:
                    concludiComeInviato(corrente, 0L, EsitoInvio.GIA_ARRIVATO);
                    return null;
                case ANNULLATO:
                    annullataDalServer(corrente);
                    return null;
                case RIPROVA_CON_TOKEN_NUOVO:
                    usati = piuRecenti;
                    continue;
                case FALLITO:
                    coda.modifica(job, x -> x.rinnovi = rinnoviDopo);
                    fallisci(fresca(job), decisione.codice, Operazione.RINNOVO);
                    return null;
                case ATTESA:
                    attendi(corrente, decisione.codice, decisione.retryAfterSecondi, risposta.stato, decisione.rinnoviConsecutivi, 0L);
                    return null;
                default:
                    throw new IllegalStateException("azione del rinnovo non prevista");
            }
        }
        // Più di due rotazioni in un solo rinnovo non sono una rotazione: il token non vale.
        fallisci(fresca(job), Codice.TOKEN_NON_VALIDO, Operazione.RINNOVO);
        return null;
    }

    /** La chiamata, che non lancia mai: un'eccezione imprevista del trasportatore vale «nessuna risposta» e si dice in logcat. */
    private RispostaHttp chiamaIlRinnovo(Segreti usati) {
        try {
            RispostaHttp r = rinnovo.rinnova(usati.urlRinnovo, usati.token);
            return r != null ? r : RispostaHttp.nessunaRisposta(ClasseErrore.ALTRO);
        } catch (RuntimeException imprevisto) {
            ambiente.guasto("rinnovo-trasporto", imprevisto);
            return RispostaHttp.nessunaRisposta(ClasseErrore.di(imprevisto));
        }
    }

    /**
     * Il rinnovo ha consegnato un URL: scadenza = istante di ricezione + 7200 s (la risposta porta solo quella del TOKEN). Prima i
     * segreti, poi la coda (ordine 3 della testata): se il processo muore in mezzo la coda dice «URL sconosciuto» e si rinnova di nuovo.
     */
    private Segreti dopoUnRinnovoRiuscito(VoceCoda corrente, Segreti usati, RispostaRinnovo letta, DecisioneRinnovo decisione,
                                           int rinnoviDopo, long ricezione) {
        final String job = corrente.jobId;
        final Segreti conUrlNuovo = usati.conUrlPut(letta.urlPut, letta.contentType);
        boolean persistiti = true;
        try {
            // `aggiorna` e non `salva`: se nel frattempo `accodaVideo` ha ruotato il token, quello nuovo non si deve perdere.
            Lettura scritti = segreti.aggiorna(job, s -> s.conUrlPut(letta.urlPut, letta.contentType));
            persistiti = scritti.esito == Esito.OK;
        } catch (IOException nonScritti) {
            persistiti = false;
            ambiente.guasto("rinnovo-segreti-non-salvati", nonScritti);
        }
        final long scadenza = PoliticaCaricamento.scadenzaUrlDopoRinnovoMs(ricezione);
        final boolean conScadenza = persistiti;
        coda.modifica(job, x -> {
            x.rinnovi = rinnoviDopo;
            x.rinnoviConsecutivi = decisione.rinnoviConsecutivi;
            // Se l'URL nuovo non si è potuto salvare la scadenza resta «sconosciuta»: dopo un riavvio si rinnova di nuovo.
            if (conScadenza) x.urlScadeIl = scadenza;
        });
        return conUrlNuovo;
    }

    /** Il diradamento dei log del rinnovo è in `RegistroNativo.siLoggaIlRinnovo`: una regola sola, provata a parte. */
    private void loggaIlRinnovo(VoceCoda voce, EsitoRinnovo esito, int statoHttp, int rinnoviDopo, int tentativiDopo, ErroreStorage errorePut) {
        int contatore = esito == EsitoRinnovo.DA_CARICARE ? rinnoviDopo : tentativiDopo;
        if (!RegistroNativo.siLoggaIlRinnovo(esito, contatore)) return;
        registro.videoRinnovo(uuid(voce.jobId), uuid(voce.utenteId), esito, statoHttp, rinnoviDopo, errorePut);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * LE FINI: attesa, inviato, annullato, fallito
     * ──────────────────────────────────────────────────────────────────────────── */

    /** Un transitorio: un tentativo in più, un ritardo di §4.5, lo stato `in-attesa`, e (diradata) la riga di log. */
    private void attendi(VoceCoda voce, Codice codice, long retryAfterSecondi, int statoHttp, int rinnoviConsecutivi, long byteInviati) {
        final String job = voce.jobId;
        final int tentativo = voce.tentativi + 1;
        final long attesa = PoliticaCaricamento.attesaMs(tentativo, retryAfterSecondi, ambiente.casuale());
        final long quando = ambiente.adesso() + attesa;
        coda.modifica(job, x -> {
            x.tentativi = tentativo;
            x.rinnoviConsecutivi = rinnoviConsecutivi;
            x.prossimoTentativoIl = quando;
        });
        EsitoTransizione e = coda.transita(job, EventoStato.IN_ATTESA_DI_RETE, codice);
        registro.videoRitento(uuid(job), uuid(voce.utenteId), codice, statoHttp, tentativo, attesa / 1000L, byteInviati);
        avanzamento.put(job, 0L);
        if (e.tipo == TipoTransizione.APPLICATA || e.tipo == TipoTransizione.GIA_IN_QUELLO_STATO) notificaVoce(e.voce);
    }

    private void concludiComeInviato(VoceCoda voce, long durataMs, EsitoInvio esito) {
        EsitoTransizione e = coda.transita(voce.jobId, EventoStato.INVIATO, null);
        // Se la voce è già terminale (annullata nel frattempo) non si scrive un «inviato» che non è la storia vera.
        if (e.tipo != TipoTransizione.APPLICATA) return;
        VoceCoda dopo = e.voce;
        registro.videoInviato(uuid(dopo.jobId), uuid(dopo.utenteId), dopo.byteTotali, durataMs, dopo.tentativi, dopo.rinnovi, esito,
                ambiente.inBackground());
        chiudiLaVoce(e);
    }

    private void annullataDalServer(VoceCoda voce) {
        EsitoTransizione e = coda.transita(voce.jobId, EventoStato.ANNULLATO, Codice.ANNULLATO_DAL_SERVER);
        if (e.tipo != TipoTransizione.APPLICATA) return;
        registro.videoAnnullato(uuid(voce.jobId), uuid(voce.utenteId), Da.SERVER, valore(avanzamento.get(voce.jobId)));
        chiudiLaVoce(e);
    }

    /** `fallito`, con il suo codice e la riga `error` del registro. `voce` può essere `null` (la voce non c'è più): non fa niente. */
    private void fallisci(VoceCoda voce, Codice codice, Operazione operazione) {
        if (voce == null) return;
        EsitoTransizione e = coda.transita(voce.jobId, EventoStato.FALLITO, codice);
        if (e.tipo != TipoTransizione.APPLICATA) return;
        VoceCoda dopo = e.voce;
        registro.videoFallito(uuid(dopo.jobId), uuid(dopo.utenteId), codice, operazione, dopo.tentativi, dopo.rinnovi);
        chiudiLaVoce(e);
    }

    /** Ciò che si fa a ogni stato terminale: l'avanzamento in memoria si dimentica, l'osservatore lo sa, il registro si svuota. */
    private void chiudiLaVoce(EsitoTransizione e) {
        VoceCoda voce = e.voce;
        if (e.residuiRimasti) residuiVisti = true;
        avanzamento.remove(voce.jobId);
        notificaVoce(voce);
        try {
            ambiente.registroDaSvuotare();
        } catch (RuntimeException guasto) {
            ambiente.guasto("registro-da-svuotare", guasto);
        }
    }

    /** Un'eccezione imprevista nel giro di una voce: si dice (con la sola classe), si segna come tentativo `INTERNO` e si va avanti. */
    private void guastoImprevisto(VoceCoda voce, RuntimeException imprevisto) {
        ambiente.guasto("esecutore-lavora", imprevisto);
        try {
            VoceCoda attuale = coda.trova(voce.jobId);
            if (attuale != null && !attuale.stato.terminale()) {
                if (attuale.stato == Stato.IN_CODA || attuale.stato == Stato.IN_PAUSA || attuale.stato == Stato.IN_ATTESA) {
                    avviaORiprendi(attuale);
                    attuale = coda.trova(voce.jobId);
                }
                if (attuale != null && attuale.stato == Stato.IN_INVIO) {
                    attendi(attuale, Codice.INTERNO, 0L, 0, 0, 0L);
                }
            }
        } catch (RuntimeException ancheQuesto) {
            ambiente.guasto("esecutore-guasto-imprevisto", ancheQuesto);
        }
    }

    /** Dopo un giro con copie o segreti che non si sono potuti cancellare: una pulizia toglie ciò che nessuna voce nomina più. */
    private void pulisciResidui() {
        try {
            coda.pulisci();
        } catch (RuntimeException guasto) {
            ambiente.guasto("pulizia-residui", guasto);
        }
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * PICCOLI UTENSILI
     * ──────────────────────────────────────────────────────────────────────────── */

    private VoceCoda fresca(String job) {
        return coda.trova(job);
    }

    private static long valore(Long numero) {
        return numero == null ? 0L : numero.longValue();
    }

    private static UUID uuid(String id) {
        return UUID.fromString(id);
    }
}
