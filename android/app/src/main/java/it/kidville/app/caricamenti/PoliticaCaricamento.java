package it.kidville.app.caricamenti;

import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.regex.Pattern;

/**
 * LA POLITICA DEI CARICAMENTI NATIVI: tabelle di decisione, SOLO LOGICA PURA.
 * (spec 2026-10-03 «app 1.2: caricamenti nativi in background», §3 esito di S0, §4.4, §4.5, §6.2, §9; compito A1)
 *
 * ─── CHE COSA È ──────────────────────────────────────────────────────────────────────────────
 * Le decisioni che il motore Android prende senza toccare né rete né disco né orologio: da che
 * stato a che stato si può andare, che cosa fare di un esito della PUT e di una risposta del
 * rinnovo, quanto aspettare, quando rinnovare in anticipo l'URL firmato, verso quali host si può
 * parlare. È l'equivalente Java di `KVPoliticaCaricamento.swift` (compito I1): le stesse righe,
 * gli stessi nomi, e un unico file di JUnit che le prova una per una (`PoliticaCaricamentoTest`).
 *
 * ─── COME È FATTA ────────────────────────────────────────────────────────────────────────────
 *  · NIENTE `android.*`, niente `Context`, niente `Log`, niente `System.currentTimeMillis()`: ogni
 *    istante e ogni numero casuale arriva come PARAMETRO. Per questo gira sulla JVM in JUnit senza
 *    Robolectric (che qui non c'è e non va aggiunto). L'unica libreria è `org.json`, per leggere i
 *    due corpi di risposta (rifiuto dello Storage, risposta del rinnovo).
 *  · I NOMI SONO QUELLI DEL CONTRATTO: i valori di `Stato` e di `Codice` sono identici, lettera per
 *    lettera, a `STATI_NATIVI` e `CODICI_NATIVI` di `src/lib/native/caricamenti-nativi-tipi.ts`
 *    (un test li rilegge da quel file: se uno cambia di là e non di qua, diventa rosso).
 *  · NESSUN LOG QUI. Una funzione pura non scrive niente: restituisce una decisione, e chi la
 *    chiama (l'esecutore della coda, A2) la porta nel registro (`RegistroNativo`). I due punti in cui
 *    un guasto di lettura non ha un'eccezione da mostrare (corpo di rifiuto illeggibile, risposta del
 *    rinnovo fuori forma) NON sono `catch` muti: il fallimento è un VALORE del risultato
 *    (`leggibile == false`, `TRANSITORIO_SERVER`) e finisce nel log come `altro` / `server`.
 *
 * ─── DUE LETTURE DELLA SPEC CHE VALE LA PENA SAPERE ──────────────────────────────────────────
 *  1. LA FRECCIA `in-coda → in-pausa`. §4.4 conosce solo `in-invio → in-pausa`, ma §6.2 manda la
 *     voce `in-pausa` anche quando UIDT non si riesce a programmare già in `accodaVideo` (la voce è
 *     appena nata, quindi `in-coda`) e quando il worker non avvia il FGS con voci ancora `in-coda`.
 *     Qui la freccia c'È. La tabella TypeScript (`TRANSIZIONI_STATO_NATIVO`) oggi non la porta: va
 *     allineata (secondario n. 1 della PR 3).
 *  2. «RINNOVI CONSECUTIVI SENZA UN 2xx» (§4.5, §3). Letto alla lettera, ogni rinnovo conterebbe, e
 *     una voce morirebbe di `RINNOVO_CICLICO` dopo una fila di semplici cadute di rete o di un
 *     guasto dello Storage (ogni ripresa dopo più di 10' rinnova, S0): il contrario di «insistere
 *     finché il server lo permette» (§4.5, Attese). Il ciclo che il tetto deve fermare è un altro:
 *     la PUT RIFIUTATA dal server (4xx) → rinnovo → PUT rifiutata di nuovo (la firma che scade
 *     durante un trasferimento più lungo di 2 ore, S0-b). Quindi qui `rinnoviConsecutivi` conta i
 *     rinnovi CHIESTI DA UN RIFIUTO della PUT, di fila: il rinnovo proattivo non lo alza e non lo
 *     può far scattare, e un esito transitorio della PUT lo azzera (`rinnoviConsecutiviDopoPut`).
 *     Il quarto `da-caricare` di fila dopo un rifiuto vale `RINNOVO_CICLICO`, ma il rinnovo si FA
 *     comunque: la risposta può essere `arrivato` (il file c'era già) e chiuderebbe il caso bene.
 */
public final class PoliticaCaricamento {

    private PoliticaCaricamento() {
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * I NUMERI
     * ──────────────────────────────────────────────────────────────────────────── */

    /**
     * Per quanto vale un URL di PUT firmato: due ore (`VALIDITA_FIRMA_SECONDI` di `firme.ts`, e
     * `VALIDITA_URL_PUT_SECONDI` del contratto TypeScript). La risposta del rinnovo porta solo la
     * scadenza del TOKEN (48 ore): quella dell'URL si calcola qui, ricezione + questo (§2.2).
     */
    public static final long VALIDITA_URL_PUT_SECONDI = 7200L;

    /**
     * LA REGOLA DI S0 (§3): lo Storage verifica la firma quando arriva l'ULTIMO byte, non alla
     * partenza. Quindi prima di ogni PUT (la prima e ogni ripresa) si rinnova l'URL se è stato
     * firmato da PIÙ di dieci minuti: ogni trasferimento ha davanti quasi due ore piene.
     */
    public static final long SOGLIA_RINNOVO_PROATTIVO_SECONDI = 600L;

    /** Oltre tre rinnovi di fila chiesti da un rifiuto della PUT: `RINNOVO_CICLICO` (§4.5). */
    public static final int TETTO_RINNOVI_CONSECUTIVI = 3;

    /** Del corpo di un rifiuto dello Storage si leggono al più i primi 4 KB (§4.5). */
    public static final int CORPO_ERRORE_MASSIMO_BYTE = 4096;

    /** `Retry-After` vince se più lungo dell'attesa di base, ma non oltre un'ora (§4.5, Attese). */
    public static final long RETRY_AFTER_MASSIMO_SECONDI = 3600L;

    /** Scarto casuale delle attese: ±20% (§4.5), perché due telefoni caduti insieme non richiamino insieme. */
    public static final double SCARTO_ATTESA = 0.20;

    /** 30 s, 1', 2', 5', 10', 15', poi 15' fisse (§4.5). L'indice è il numero del ritentativo meno uno. */
    private static final long[] ATTESE_BASE_SECONDI = {30L, 60L, 120L, 300L, 600L, 900L};

    /** Android 24-33: con la rete caduta il worker aspetta fino a 10' col FGS attivo, poi `Result.retry()` (§6.2). */
    public static final long ATTESA_RETE_NEL_WORKER_SECONDI = 600L;

    /** `video-nativo-attesa-rete` su Android parte quando l'attesa nel worker supera i 60 s (§8.2). */
    public static final long SOGLIA_LOG_ATTESA_RETE_SECONDI = 60L;

    /** Da questo livello di API il motore è UIDT (§6.2); sotto, WorkManager con il servizio in primo piano. */
    public static final int SDK_PRIMO_UIDT = 34;

    /* ────────────────────────────────────────────────────────────────────────────
     * I VOCABOLARI (identici a `caricamenti-nativi-tipi.ts`)
     * ──────────────────────────────────────────────────────────────────────────── */

    /** Gli stati di una voce della coda (§4.4): `valore()` è la stringa che il ponte porta al JavaScript. */
    public enum Stato {
        IN_CODA("in-coda"),
        IN_INVIO("in-invio"),
        IN_ATTESA("in-attesa"),
        IN_PAUSA("in-pausa"),
        INVIATO("inviato"),
        FALLITO("fallito"),
        ANNULLATO("annullato");

        private final String valore;

        Stato(String valore) {
            this.valore = valore;
        }

        public String valore() {
            return valore;
        }

        /** Stati da cui non si esce più: copia e segreti sono già cancellati, la voce aspetta `dimentica` o la pulizia. */
        public boolean terminale() {
            return this == INVIATO || this == FALLITO || this == ANNULLATO;
        }

        /** Lo stato che porta quel nome, o `null` se il nome non è nell'elenco chiuso. */
        public static Stato daValore(String valore) {
            for (Stato stato : values()) {
                if (stato.valore.equals(valore)) return stato;
            }
            return null;
        }
    }

    /**
     * I codici che accompagnano una voce e i messaggi di log: il PERCHÉ di un'attesa, di una pausa o di un esito. I nomi
     * sono quelli di `CODICI_NATIVI`: `name()` è la stringa del ponte. Mai testo libero, mai il messaggio di un'eccezione.
     */
    public enum Codice {
        RETE,
        SERVER,
        FIRMA_RIFIUTATA,
        TOKEN_NON_VALIDO,
        TOKEN_SCADUTO,
        RINNOVO_CICLICO,
        TROPPO_GRANDE,
        FILE_ASSENTE,
        PESO_DIVERSO,
        ANNULLATO_DAL_SERVER,
        CHIUSURA_FORZATA,
        FGS_NON_AVVIABILE,
        UIDT_NON_PROGRAMMABILE,
        INTERNO;

        public static Codice daValore(String valore) {
            for (Codice codice : values()) {
                if (codice.name().equals(valore)) return codice;
            }
            return null;
        }
    }

    /** Gli eventi che spostano una voce da uno stato all'altro: le colonne «Evento» di §4.4. */
    public enum EventoStato {
        /** `accodaVideo` riuscito. */
        ACCODATO(Stato.IN_CODA),
        /** Trasferimento avviato. */
        AVVIATO(Stato.IN_INVIO),
        /** Rete assente, task in attesa, backoff dopo un transitorio. */
        IN_ATTESA_DI_RETE(Stato.IN_ATTESA),
        /** Android 12-13: FGS non avviabile da background; Android ≥ 14: UIDT non programmabile. */
        IN_PAUSA(Stato.IN_PAUSA),
        /** Rete tornata, app riaperta. */
        RIPRESO(Stato.IN_INVIO),
        /** PUT 2xx, oppure rinnovo `arrivato`. */
        INVIATO(Stato.INVIATO),
        /** Rinnovo `annullato`, `annulla` dal JavaScript. */
        ANNULLATO(Stato.ANNULLATO),
        /** Esito definitivo (§4.5), token scaduto. */
        FALLITO(Stato.FALLITO);

        private final Stato destinazione;

        EventoStato(Stato destinazione) {
            this.destinazione = destinazione;
        }

        /** Lo stato a cui porta l'evento, da qualunque stato di partenza ammesso. */
        public Stato destinazione() {
            return destinazione;
        }
    }

    /** Il motore che spedisce, per livello di API (§6.2): le stringhe di `MOTORI_CARICAMENTI` che `info()` restituisce. */
    public enum Motore {
        UIDT("uidt"),
        WORKMANAGER("workmanager");

        private final String valore;

        Motore(String valore) {
            this.valore = valore;
        }

        public String valore() {
            return valore;
        }
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * GLI STATI E LE TRANSIZIONI (§4.4)
     * ──────────────────────────────────────────────────────────────────────────── */

    /**
     * Lo stato a cui porta `evento` partendo da `da` (`null` = «—», la voce non esiste ancora), o `null` se la tabella di §4.4
     * non prevede quel passo. È la tabella così com'è scritta, una riga per freccia, più la freccia di §6.2 (testata, punto 1):
     *
     * <pre>
     *  —                       accodaVideo riuscito                     in-coda
     *  in-coda                 trasferimento avviato                    in-invio
     *  in-invio                rete assente / task in attesa / backoff  in-attesa
     *  in-invio (e in-coda)    FGS non avviabile / UIDT non programm.   in-pausa
     *  in-attesa, in-pausa     rete tornata / app riaperta              in-invio
     *  in-invio                PUT 2xx, oppure rinnovo arrivato         inviato
     *  qualunque non terminale rinnovo annullato · annulla dal JS       annullato
     *  qualunque non terminale esito definitivo · token scaduto         fallito
     * </pre>
     *
     * Dagli stati terminali non si esce con nessun evento. Un passo da uno stato a se stesso NON è una transizione (`null`):
     * chi ripete lo stesso evento (un'altra attesa dopo un'attesa) lo gestisce prima di chiamare, e `CodaCaricamenti` lo
     * tratta come «già in quello stato».
     */
    public static Stato transizione(Stato da, EventoStato evento) {
        if (evento == null) return null;
        if (da != null && da.terminale()) return null;
        switch (evento) {
            case ACCODATO:
                return da == null ? Stato.IN_CODA : null;
            case AVVIATO:
                return da == Stato.IN_CODA ? Stato.IN_INVIO : null;
            case IN_ATTESA_DI_RETE:
                return da == Stato.IN_INVIO ? Stato.IN_ATTESA : null;
            case IN_PAUSA:
                return (da == Stato.IN_INVIO || da == Stato.IN_CODA) ? Stato.IN_PAUSA : null;
            case RIPRESO:
                return (da == Stato.IN_ATTESA || da == Stato.IN_PAUSA) ? Stato.IN_INVIO : null;
            case INVIATO:
                return da == Stato.IN_INVIO ? Stato.INVIATO : null;
            case ANNULLATO:
                return da != null ? Stato.ANNULLATO : null;
            case FALLITO:
                return da != null ? Stato.FALLITO : null;
            default:
                return null;
        }
    }

    /** Vero se almeno un evento di §4.4 porta da `da` ad `a`. */
    public static boolean transizioneAmmessa(Stato da, Stato a) {
        if (da == null || a == null) return false;
        for (EventoStato evento : EventoStato.values()) {
            if (transizione(da, evento) == a) return true;
        }
        return false;
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL MOTORE PER LIVELLO DI API (§6.2, parti pure)
     * ──────────────────────────────────────────────────────────────────────────── */

    /**
     * API ≥ 34: UIDT (job «avviato dall'utente»); API 24-33: WorkManager con il servizio in primo piano `dataSync`.
     * `forzaWorkManager` è la costante `FORZA_WORKMANAGER` del pianificatore: un interruttore di emergenza che
     * riporta tutti i livelli di API sul secondo ramo.
     */
    public static Motore motorePer(int sdk, boolean forzaWorkManager) {
        if (forzaWorkManager) return Motore.WORKMANAGER;
        return sdk >= SDK_PRIMO_UIDT ? Motore.UIDT : Motore.WORKMANAGER;
    }

    /**
     * Il codice con cui una voce va `in-pausa` per quel motore: il servizio in primo piano che non parte da background
     * (Android 12-13, `ForegroundServiceStartNotAllowedException`) o il job UIDT che non si riesce a programmare (app non
     * più visibile al momento di `accodaVideo`).
     */
    public static Codice codicePausa(Motore motore) {
        return motore == Motore.UIDT ? Codice.UIDT_NON_PROGRAMMABILE : Codice.FGS_NON_AVVIABILE;
    }

    /** Il worker ha finito di aspettare la rete: dopo 10' col servizio attivo restituisce `Result.retry()` (§6.2). */
    public static boolean attesaReteNelWorkerEsaurita(long secondiAttesi) {
        return secondiAttesi >= ATTESA_RETE_NEL_WORKER_SECONDI;
    }

    /** L'attesa di rete è abbastanza lunga da meritare la riga `video-nativo-attesa-rete`: più di 60 s (§8.2). */
    public static boolean attesaReteDaLoggare(long secondiAttesi) {
        return secondiAttesi > SOGLIA_LOG_ATTESA_RETE_SECONDI;
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * LA PUT (§4.5)
     * ──────────────────────────────────────────────────────────────────────────── */

    /**
     * I nomi d'errore dello Storage che il nativo riconosce (campo `error` del corpo): l'elenco CHIUSO di §4.5, quello che
     * entra nel campo `error_code` dei log. Tutto il resto vale `ALTRO`. `message` non si legge e non si logga mai.
     * `valore()` ha la forma di un enumerato che il server lascia in chiaro (niente spazi, ≤ 64 caratteri).
     */
    public enum ErroreStorage {
        DUPLICATE("Duplicate"),
        INVALID_JWT("InvalidJWT"),
        ENTITY_TOO_LARGE("EntityTooLarge"),
        UNAUTHORIZED("Unauthorized"),
        INVALID_REQUEST("InvalidRequest"),
        NO_SUCH_KEY("NoSuchKey"),
        ALTRO("altro");

        private final String valore;

        ErroreStorage(String valore) {
            this.valore = valore;
        }

        public String valore() {
            return valore;
        }

        /** Il confronto è esatto (maiuscole comprese): un nome che non coincide con uno dell'elenco vale `ALTRO`. */
        public static ErroreStorage daNome(String nome) {
            for (ErroreStorage errore : values()) {
                if (errore != ALTRO && errore.valore.equals(nome)) return errore;
            }
            return ALTRO;
        }
    }

    /** Ciò che si ricava dal corpo di una risposta di rifiuto: solo `statusCode` ed `error`, mai `message`. */
    public static final class CorpoRifiuto {
        /** Nessun corpo, o corpo che non dice niente di leggibile. */
        public static final CorpoRifiuto ASSENTE = new CorpoRifiuto(0, ErroreStorage.ALTRO, false);

        /** `statusCode` del corpo (lo Storage lo scrive come stringa: `"409"`), da 100 a 599; 0 se manca o è fuori forma. */
        public final int statusCode;
        /** Il nome d'errore riconosciuto, `ALTRO` se manca o non sta nell'elenco. */
        public final ErroreStorage errore;
        /** Falso se il corpo era vuoto, non era JSON o non era un oggetto. */
        public final boolean leggibile;

        CorpoRifiuto(int statusCode, ErroreStorage errore, boolean leggibile) {
            this.statusCode = statusCode;
            this.errore = errore;
            this.leggibile = leggibile;
        }

        /** «Troppo grande» detto dal corpo: `statusCode: "413"` oppure `error: "EntityTooLarge"` (§4.5, A16). */
        public boolean diceTroppoGrande() {
            return statusCode == 413 || errore == ErroreStorage.ENTITY_TOO_LARGE;
        }
    }

    private static final Pattern FORMA_STATUS_CODE = Pattern.compile("^[1-5][0-9]{2}$");

    /**
     * Legge i primi 4 KB di un corpo di rifiuto (UTF-8) e ne ricava `statusCode` ed `error`. Non lancia mai: un corpo
     * vuoto, HTML o troncato dà `leggibile == false` e `ALTRO`, che nel log si legge come `error_code: altro`.
     */
    public static CorpoRifiuto leggiCorpoRifiuto(byte[] corpo) {
        if (corpo == null || corpo.length == 0) return CorpoRifiuto.ASSENTE;
        int lunghezza = Math.min(corpo.length, CORPO_ERRORE_MASSIMO_BYTE);
        return leggiCorpoRifiuto(new String(corpo, 0, lunghezza, StandardCharsets.UTF_8));
    }

    /** Come {@link #leggiCorpoRifiuto(byte[])}, su un testo già decodificato (si ritaglia comunque ai primi 4096 caratteri). */
    public static CorpoRifiuto leggiCorpoRifiuto(String corpo) {
        if (corpo == null || corpo.isEmpty()) return CorpoRifiuto.ASSENTE;
        String testo = corpo.length() > CORPO_ERRORE_MASSIMO_BYTE ? corpo.substring(0, CORPO_ERRORE_MASSIMO_BYTE) : corpo;
        JSONObject oggetto = leggiOggetto(testo);
        if (oggetto == null) return CorpoRifiuto.ASSENTE;
        int statusCode = 0;
        Object grezzoStatus = oggetto.opt("statusCode");
        if (grezzoStatus instanceof String) {
            String s = ((String) grezzoStatus).trim();
            if (FORMA_STATUS_CODE.matcher(s).matches()) statusCode = Integer.parseInt(s);
        } else if (grezzoStatus instanceof Number) {
            double d = ((Number) grezzoStatus).doubleValue();
            if (d >= 100 && d <= 599 && d == Math.rint(d)) statusCode = (int) d;
        }
        Object grezzoErrore = oggetto.opt("error");
        ErroreStorage errore = grezzoErrore instanceof String ? ErroreStorage.daNome((String) grezzoErrore) : ErroreStorage.ALTRO;
        return new CorpoRifiuto(statusCode, errore, true);
    }

    /** Un testo JSON che sia un OGGETTO, o `null`. Il perché non si logga è nella testata: il fallimento è il valore restituito. */
    private static JSONObject leggiOggetto(String testo) {
        try {
            return new JSONObject(testo);
        } catch (JSONException nonJson) {
            return null;
        }
    }

    /** Che cosa fare di un esito della PUT (le righe di §4.5). */
    public enum AzionePut {
        /** 2xx: la voce è `inviato` (`esito: put`). */
        INVIATO,
        /** 413, o 413 / `EntityTooLarge` nel corpo: `fallito` `TROPPO_GRANDE`, senza rinnovo. */
        TROPPO_GRANDE,
        /** Transitorio (rete, timeout, 408, 429, 5xx): si aspetta e si riprova. */
        ATTESA,
        /**
         * Qualunque altro 4xx: si chiede il rinnovo, che dice se il file c'è già. L'URL appena rifiutato non si rispedisce: finché
         * il rinnovo non ne consegna uno nuovo, chi esegue azzera `urlScadeIl` (scadenza sconosciuta), così che il giro seguente
         * — anche dopo un'attesa per un 429 o una rete caduta del rinnovo — cominci dal rinnovo (`serveRinnovoProattivo(0)` è vero).
         */
        RINNOVA
    }

    /** La decisione presa su un esito della PUT. Immutabile. */
    public static final class DecisionePut {
        public final AzionePut azione;
        /** `TROPPO_GRANDE`; per l'attesa `RETE` (nessuna risposta) o `SERVER`; per il rinnovo `FIRMA_RIFIUTATA`; altrimenti `null`. */
        public final Codice codice;
        /** `Retry-After` letto, già limitato a un'ora; 0 se non c'era. Vince sull'attesa di base se più lungo. */
        public final long retryAfterSecondi;
        /**
         * Vero per un 4xx `InvalidJWT` arrivato DOPO un trasferimento completo: la firma è scaduta durante l'invio (S0-b,
         * S0-b2, §4.5). L'azione resta `RINNOVA`; chi chiama scrive `put-oltre-scadenza` con la durata in secondi.
         */
        public final boolean oltreScadenza;

        DecisionePut(AzionePut azione, Codice codice, long retryAfterSecondi, boolean oltreScadenza) {
            this.azione = azione;
            this.codice = codice;
            this.retryAfterSecondi = retryAfterSecondi;
            this.oltreScadenza = oltreScadenza;
        }

        @Override
        public String toString() {
            return "DecisionePut{" + azione + ", " + codice + ", retryAfter=" + retryAfterSecondi + ", oltreScadenza=" + oltreScadenza + "}";
        }
    }

    /**
     * La tabella «Esito della PUT → Azione» di §4.5, riga per riga:
     *
     * <pre>
     *  2xx                                                   INVIATO
     *  HTTP 413, o corpo statusCode 413 / EntityTooLarge     TROPPO_GRANDE (senza rinnovo)
     *  HTTP 408 o 429                                        ATTESA (Retry-After se c'è)
     *  qualunque altro 4xx (400 col 409 nel corpo, 400
     *    InvalidJWT, 401, 403, 404, 409…)                    RINNOVA
     *  5xx                                                   ATTESA
     *  nessuna risposta (statoHttp 0)                        ATTESA (codice RETE)
     * </pre>
     *
     * Ciò che la tabella non nomina (1xx, 3xx, stati oltre 599) vale transitorio: ciò che non si conosce non chiude una voce.
     * Il 2xx vince su tutto; il 413 del corpo vale qualunque sia lo stato HTTP (lo Storage manda i suoi rifiuti come 400).
     *
     * @param statoHttp             lo stato HTTP, 0 se la risposta non è mai arrivata
     * @param corpo                 il corpo di rifiuto già letto (`CorpoRifiuto.ASSENTE` se non c'era)
     * @param retryAfterSecondi     l'intestazione `Retry-After` in secondi, 0 se manca
     * @param trasferimentoCompleto vero se tutti i byte erano già stati spediti quando la risposta è arrivata
     */
    public static DecisionePut decidiPut(int statoHttp, CorpoRifiuto corpo, long retryAfterSecondi, boolean trasferimentoCompleto) {
        CorpoRifiuto letto = corpo == null ? CorpoRifiuto.ASSENTE : corpo;
        long retryAfter = Math.min(Math.max(retryAfterSecondi, 0L), RETRY_AFTER_MASSIMO_SECONDI);
        if (statoHttp >= 200 && statoHttp <= 299) {
            return new DecisionePut(AzionePut.INVIATO, null, 0L, false);
        }
        if (statoHttp == 413 || letto.diceTroppoGrande()) {
            return new DecisionePut(AzionePut.TROPPO_GRANDE, Codice.TROPPO_GRANDE, 0L, false);
        }
        if (statoHttp == 408 || statoHttp == 429) {
            return new DecisionePut(AzionePut.ATTESA, Codice.SERVER, retryAfter, false);
        }
        if (statoHttp >= 400 && statoHttp <= 499) {
            boolean oltreScadenza = trasferimentoCompleto && letto.errore == ErroreStorage.INVALID_JWT;
            return new DecisionePut(AzionePut.RINNOVA, Codice.FIRMA_RIFIUTATA, 0L, oltreScadenza);
        }
        if (statoHttp >= 1 && statoHttp <= 599) {
            return new DecisionePut(AzionePut.ATTESA, Codice.SERVER, retryAfter, false);
        }
        if (statoHttp <= 0) {
            return new DecisionePut(AzionePut.ATTESA, Codice.RETE, 0L, false);
        }
        return new DecisionePut(AzionePut.ATTESA, Codice.SERVER, retryAfter, false);
    }

    /**
     * Quanti rinnovi di fila vale la voce dopo l'esito di una PUT (testata, punto 2): un rifiuto che chiede il rinnovo lo
     * lascia com'è (lo alza la risposta `da-caricare`, in {@link #decidiRinnovo}); un esito transitorio, un 413 o un 2xx lo
     * azzerano, perché il server non ha rifiutato di nuovo una firma appena data: non è un ciclo.
     */
    public static int rinnoviConsecutiviDopoPut(int attuali, AzionePut azione) {
        return azione == AzionePut.RINNOVA ? Math.max(attuali, 0) : 0;
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * LE ATTESE (§4.5)
     * ──────────────────────────────────────────────────────────────────────────── */

    /**
     * Quanto aspettare prima del ritentativo n. `tentativo` (1 = il primo): 30 s, 1', 2', 5', 10', 15', poi 15' fisse, ±20%
     * di scarto casuale; `Retry-After` vince se più lungo, fino a un'ora. Nessun tetto al NUMERO di tentativi: la voce
     * insiste finché il token vale (48 ore).
     *
     * @param casuale un numero in [0, 1] (il chiamante passa `Math.random()`): 0 dà −20%, 0,5 la base, 1 dà +20%
     * @return millisecondi
     */
    public static long attesaMs(int tentativo, long retryAfterSecondi, double casuale) {
        int indice = Math.min(Math.max(tentativo, 1), ATTESE_BASE_SECONDI.length) - 1;
        double c = Double.isNaN(casuale) ? 0.5 : Math.min(1.0, Math.max(0.0, casuale));
        double fattore = 1.0 + SCARTO_ATTESA * (2.0 * c - 1.0);
        long base = Math.round(ATTESE_BASE_SECONDI[indice] * 1000.0 * fattore);
        long richiesta = Math.min(Math.max(retryAfterSecondi, 0L), RETRY_AFTER_MASSIMO_SECONDI) * 1000L;
        return Math.max(base, richiesta);
    }

    private static final Pattern FORMA_RETRY_AFTER_SECONDI = Pattern.compile("^[0-9]{1,10}$");

    /**
     * Legge un'intestazione `Retry-After` — secondi, oppure una data HTTP (`Sun, 06 Nov 1994 08:49:37 GMT`) — e la
     * restituisce in secondi da `adessoMs`, limitata a un'ora. 0 se manca, è illeggibile o la data è già passata.
     */
    public static long leggiRetryAfterSecondi(String valore, long adessoMs) {
        if (valore == null) return 0L;
        String testo = valore.trim();
        if (testo.isEmpty()) return 0L;
        if (FORMA_RETRY_AFTER_SECONDI.matcher(testo).matches()) {
            return Math.min(Long.parseLong(testo), RETRY_AFTER_MASSIMO_SECONDI);
        }
        SimpleDateFormat formato = new SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss 'GMT'", Locale.US);
        formato.setTimeZone(TimeZone.getTimeZone("UTC"));
        formato.setLenient(false);
        try {
            Date data = formato.parse(testo);
            if (data == null) return 0L;
            long secondi = (data.getTime() - adessoMs + 999L) / 1000L;
            return Math.min(Math.max(secondi, 0L), RETRY_AFTER_MASSIMO_SECONDI);
        } catch (ParseException nonUnaData) {
            return 0L;
        }
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * SCADENZE: URL FIRMATO E TOKEN (§2.2, §3)
     * ──────────────────────────────────────────────────────────────────────────── */

    /** La scadenza di un URL appena rinnovato: istante di ricezione + 7200 s (la risposta del rinnovo non la porta). */
    public static long scadenzaUrlDopoRinnovoMs(long ricezioneMs) {
        return ricezioneMs + VALIDITA_URL_PUT_SECONDI * 1000L;
    }

    /**
     * Prima di ogni PUT: l'URL è stato firmato da PIÙ di 10 minuti? (S0, §3). La firma si ricava dalla scadenza
     * (`scadenza − 7200 s`); esattamente 10' non basta, 10' e un millisecondo sì. Una scadenza sconosciuta (≤ 0) vale
     * «da rinnovare»: spedire fino a 2 GB su un URL di cui non si sa l'età è la spesa che S0 vuole evitare.
     */
    public static boolean serveRinnovoProattivo(long urlScadeIlMs, long adessoMs) {
        if (urlScadeIlMs <= 0L) return true;
        long firmatoIl = urlScadeIlMs - VALIDITA_URL_PUT_SECONDI * 1000L;
        return adessoMs - firmatoIl > SOGLIA_RINNOVO_PROATTIVO_SECONDI * 1000L;
    }

    /**
     * Il token di rinnovo è scaduto (orologio ≥ `rinnovo.scadeIl`, §4.4)? Una scadenza sconosciuta (≤ 0) vale «non scaduto»:
     * un campo perso non deve far morire una voce, e il 404 del server dirà la verità.
     */
    public static boolean tokenScaduto(long tokenScadeIlMs, long adessoMs) {
        return tokenScadeIlMs > 0L && adessoMs >= tokenScadeIlMs;
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL RINNOVO (§4.5, §5.4)
     * ──────────────────────────────────────────────────────────────────────────── */

    /** Come è andato un rinnovo, riletto per forma (`leggiRispostaRinnovo`). */
    public enum TipoRinnovo {
        /** 200 `da-caricare`, con un URL ammesso e un `content-type`. */
        DA_CARICARE,
        /** 200 `arrivato`: il file c'è già. */
        ARRIVATO,
        /** 200 `annullato`. */
        ANNULLATO,
        /** 404: token assente, scaduto, ruotato o revocato. */
        NON_TROVATO,
        /** 429. */
        TROPPE_RICHIESTE,
        /** 5xx, corpo fuori schema, qualunque stato non previsto. */
        TRANSITORIO_SERVER,
        /** Nessuna risposta. */
        TRANSITORIO_RETE
    }

    /**
     * Come un rinnovo entra nel log (`video-nativo-rinnovo: job=<uuid> <esito>`, §8.2). Una lettura per ogni valore, uguale su iOS e
     * su Android (deciso il 03/10, dopo l'ondata 2: prima le due piattaforme li scrivevano in modo diverso e le query di §8.4 non
     * avrebbero dato gli stessi numeri):
     * <ul>
     *   <li>`da-caricare`, `arrivato`, `annullato`: la risposta del server, qualunque cosa se ne faccia dopo. In particolare il
     *       rinnovo che fa scattare `RINNOVO_CICLICO` ha risposto `da-caricare` e così si scrive: `RINNOVO_CICLICO` NON è un esito
     *       del rinnovo ma un CODICE di `video-nativo-fallito`;</li>
     *   <li>`negato`: il 404 (token sconosciuto, scaduto, ruotato);</li>
     *   <li>`tetto`: il 429, cioè i tetti del rinnovo (30 richieste ogni 10' per IP e 20 per token, §1.2);</li>
     *   <li>`rete`, `server`: nessuna risposta; 5xx o risposta fuori schema.</li>
     * </ul>
     */
    public enum EsitoRinnovo {
        DA_CARICARE("da-caricare"),
        ARRIVATO("arrivato"),
        ANNULLATO("annullato"),
        NEGATO("negato"),
        TETTO("tetto"),
        RETE("rete"),
        SERVER("server");

        private final String valore;

        EsitoRinnovo(String valore) {
            this.valore = valore;
        }

        public String valore() {
            return valore;
        }
    }

    /** Una risposta del rinnovo già riletta: per `DA_CARICARE` porta l'URL della nuova PUT e il suo `content-type`. */
    public static final class RispostaRinnovo {
        public final TipoRinnovo tipo;
        /** Solo `DA_CARICARE`: l'URL firmato, già controllato contro l'elenco degli host (§9). */
        public final String urlPut;
        /** Solo `DA_CARICARE`: il `content-type` della PUT, quello di `caricamento.intestazioni`. */
        public final String contentType;
        /** Solo `TROPPE_RICHIESTE`: `Retry-After` in secondi, limitato a un'ora; 0 se non c'era. */
        public final long retryAfterSecondi;

        RispostaRinnovo(TipoRinnovo tipo, String urlPut, String contentType, long retryAfterSecondi) {
            this.tipo = tipo;
            this.urlPut = urlPut;
            this.contentType = contentType;
            this.retryAfterSecondi = retryAfterSecondi;
        }
    }

    /** La forma permissiva del MIME dichiarabile (`MIME_DICHIARABILE` di `contratto.ts`): il `content-type` della PUT. */
    private static final Pattern FORMA_CONTENT_TYPE = Pattern.compile(
            "^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}(?:\\s*;[^\\n]*)?$", Pattern.CASE_INSENSITIVE);

    /**
     * Vero se `mime` ha la forma dei tipi dichiarabili del contratto: da 3 a 255 caratteri, `tipo/sottotipo` con parametri
     * facoltativi (anche il suffisso dei codec). È la stessa regola con cui il JavaScript e il server accettano il MIME di un
     * video e il `content-type` di una PUT.
     */
    public static boolean mimeValido(String mime) {
        return mime != null && mime.length() >= 3 && mime.length() <= 255 && FORMA_CONTENT_TYPE.matcher(mime).matches();
    }

    private static RispostaRinnovo transitorio(TipoRinnovo tipo) {
        return new RispostaRinnovo(tipo, null, null, 0L);
    }

    /**
     * Rilegge per FORMA la risposta di `POST /api/video-uploads/rinnovo` (§5.4): `stato` ∈ tre valori, e per
     * `da-caricare` `caricamento.protocollo == "put"`, un URL che passa la politica degli host (https verso lo Storage; in
     * Debug anche i loopback) e un `content-type`. Ciò che non torna vale transitorio, mai un esito definitivo.
     *
     * <pre>
     *  200 con stato da-caricare / arrivato / annullato     DA_CARICARE / ARRIVATO / ANNULLATO
     *  404                                                  NON_TROVATO
     *  429                                                  TROPPE_RICHIESTE (con Retry-After)
     *  nessuna risposta (statoHttp 0)                       TRANSITORIO_RETE
     *  5xx, corpo fuori schema, ogni altro stato            TRANSITORIO_SERVER
     * </pre>
     *
     * Ogni altro stato (un 400, un 403 di un firewall, un 3xx) vale transitorio per la stessa ragione della PUT: non chiude
     * una voce. Il peggio che costa è una piccola POST ogni quarto d'ora fino alla scadenza del token.
     */
    public static RispostaRinnovo leggiRispostaRinnovo(int statoHttp, String corpo, long retryAfterSecondi, boolean debug) {
        if (statoHttp <= 0) return transitorio(TipoRinnovo.TRANSITORIO_RETE);
        if (statoHttp == 404) return transitorio(TipoRinnovo.NON_TROVATO);
        if (statoHttp == 429) {
            long retryAfter = Math.min(Math.max(retryAfterSecondi, 0L), RETRY_AFTER_MASSIMO_SECONDI);
            return new RispostaRinnovo(TipoRinnovo.TROPPE_RICHIESTE, null, null, retryAfter);
        }
        if (statoHttp != 200 || corpo == null) return transitorio(TipoRinnovo.TRANSITORIO_SERVER);
        JSONObject oggetto = leggiOggetto(corpo);
        if (oggetto == null) return transitorio(TipoRinnovo.TRANSITORIO_SERVER);
        Object stato = oggetto.opt("stato");
        if ("arrivato".equals(stato)) return transitorio(TipoRinnovo.ARRIVATO);
        if ("annullato".equals(stato)) return transitorio(TipoRinnovo.ANNULLATO);
        if (!"da-caricare".equals(stato)) return transitorio(TipoRinnovo.TRANSITORIO_SERVER);
        JSONObject caricamento = oggetto.optJSONObject("caricamento");
        if (caricamento == null || !"put".equals(caricamento.opt("protocollo"))) {
            return transitorio(TipoRinnovo.TRANSITORIO_SERVER);
        }
        Object url = caricamento.opt("url");
        if (!(url instanceof String) || !urlAmmesso((String) url, Destinazione.PUT, debug)) {
            return transitorio(TipoRinnovo.TRANSITORIO_SERVER);
        }
        JSONObject intestazioni = caricamento.optJSONObject("intestazioni");
        Object contentType = intestazioni == null ? null : intestazioni.opt("content-type");
        if (!(contentType instanceof String) || !mimeValido((String) contentType)) {
            return transitorio(TipoRinnovo.TRANSITORIO_SERVER);
        }
        return new RispostaRinnovo(TipoRinnovo.DA_CARICARE, (String) url, (String) contentType, 0L);
    }

    /** Che cosa fare di un rinnovo (le righe «Risposta del rinnovo → Azione» di §4.5). */
    public enum AzioneRinnovo {
        /** Nuova URL (scadenza = ricezione + 7200 s) e nuova PUT. */
        NUOVA_PUT,
        /** `arrivato`: la voce è `inviato` (`esito: gia-arrivato`). */
        INVIATO,
        /** `annullato`: la voce è `annullato` (`ANNULLATO_DAL_SERVER`). */
        ANNULLATO,
        /** 404 ma nel Keystore c'è un token più recente di quello usato: si riprova con quello. */
        RIPROVA_CON_TOKEN_NUOVO,
        /** `fallito`: `TOKEN_NON_VALIDO` o `RINNOVO_CICLICO`. */
        FALLITO,
        /** Transitorio o 429: si aspetta (`Retry-After` se c'è) e si riprova. */
        ATTESA
    }

    /** La decisione presa su una risposta del rinnovo. Immutabile. */
    public static final class DecisioneRinnovo {
        public final AzioneRinnovo azione;
        /** `ANNULLATO_DAL_SERVER`, `TOKEN_NON_VALIDO`, `RINNOVO_CICLICO`, oppure `RETE` / `SERVER` per l'attesa; altrimenti `null`. */
        public final Codice codice;
        /** Il valore di `rinnoviConsecutivi` da salvare nella voce. */
        public final int rinnoviConsecutivi;
        /** Vero se il rinnovo ha consegnato un URL e va contato in `rinnovi` (anche quello che fa scattare il tetto). */
        public final boolean contaRinnovo;
        /** `Retry-After` del 429, in secondi; 0 altrimenti. */
        public final long retryAfterSecondi;
        /** Come il rinnovo entra nel log. */
        public final EsitoRinnovo esito;

        DecisioneRinnovo(AzioneRinnovo azione, Codice codice, int rinnoviConsecutivi, boolean contaRinnovo,
                         long retryAfterSecondi, EsitoRinnovo esito) {
            this.azione = azione;
            this.codice = codice;
            this.rinnoviConsecutivi = rinnoviConsecutivi;
            this.contaRinnovo = contaRinnovo;
            this.retryAfterSecondi = retryAfterSecondi;
            this.esito = esito;
        }

        @Override
        public String toString() {
            return "DecisioneRinnovo{" + azione + ", " + codice + ", consecutivi=" + rinnoviConsecutivi + ", conta=" + contaRinnovo
                    + ", retryAfter=" + retryAfterSecondi + ", esito=" + esito + "}";
        }
    }

    /**
     * La tabella «Risposta del rinnovo → Azione» di §4.5, riga per riga:
     *
     * <pre>
     *  200 da-caricare    NUOVA_PUT; chiesto da un rifiuto della PUT: rinnoviConsecutivi + 1, e se erano già 3
     *                     (il quarto di fila) FALLITO RINNOVO_CICLICO; proattivo: nessun conteggio, nessun tetto.
     *                     Nel log il rinnovo resta `da-caricare` anche quando fa scattare il tetto
     *  200 arrivato       INVIATO
     *  200 annullato      ANNULLATO (ANNULLATO_DAL_SERVER)
     *  404                RIPROVA_CON_TOKEN_NUOVO se c'è un token più recente, altrimenti FALLITO TOKEN_NON_VALIDO
     *  429                ATTESA (Retry-After); nel log l'esito `tetto`, come su iOS
     *  5xx, rete, fuori schema   ATTESA
     * </pre>
     *
     * @param rinnoviConsecutivi        il contatore salvato nella voce (rinnovi chiesti da un rifiuto, di fila)
     * @param daRifiutoPut              vero se il rinnovo è stato chiesto da un rifiuto della PUT, falso se è il rinnovo
     *                                  PROATTIVO prima di una PUT (testata, punto 2)
     * @param tokenPiuRecenteDisponibile vero se nel Keystore c'è un token diverso da quello appena usato (rotazione arrivata)
     */
    public static DecisioneRinnovo decidiRinnovo(RispostaRinnovo risposta, int rinnoviConsecutivi, boolean daRifiutoPut,
                                                 boolean tokenPiuRecenteDisponibile) {
        int consecutivi = Math.max(rinnoviConsecutivi, 0);
        switch (risposta.tipo) {
            case DA_CARICARE:
                if (!daRifiutoPut) {
                    return new DecisioneRinnovo(AzioneRinnovo.NUOVA_PUT, null, consecutivi, true, 0L, EsitoRinnovo.DA_CARICARE);
                }
                if (consecutivi >= TETTO_RINNOVI_CONSECUTIVI) {
                    // Il rinnovo ha risposto `da-caricare` e così si scrive; `RINNOVO_CICLICO` è il codice di `video-nativo-fallito`.
                    return new DecisioneRinnovo(AzioneRinnovo.FALLITO, Codice.RINNOVO_CICLICO, consecutivi, true, 0L, EsitoRinnovo.DA_CARICARE);
                }
                return new DecisioneRinnovo(AzioneRinnovo.NUOVA_PUT, null, consecutivi + 1, true, 0L, EsitoRinnovo.DA_CARICARE);
            case ARRIVATO:
                return new DecisioneRinnovo(AzioneRinnovo.INVIATO, null, consecutivi, false, 0L, EsitoRinnovo.ARRIVATO);
            case ANNULLATO:
                return new DecisioneRinnovo(AzioneRinnovo.ANNULLATO, Codice.ANNULLATO_DAL_SERVER, consecutivi, false, 0L,
                        EsitoRinnovo.ANNULLATO);
            case NON_TROVATO:
                if (tokenPiuRecenteDisponibile) {
                    return new DecisioneRinnovo(AzioneRinnovo.RIPROVA_CON_TOKEN_NUOVO, null, consecutivi, false, 0L, EsitoRinnovo.NEGATO);
                }
                return new DecisioneRinnovo(AzioneRinnovo.FALLITO, Codice.TOKEN_NON_VALIDO, consecutivi, false, 0L, EsitoRinnovo.NEGATO);
            case TROPPE_RICHIESTE:
                // Il 429 sono i tetti del rinnovo: esito `tetto` su entrambe le piattaforme.
                return new DecisioneRinnovo(AzioneRinnovo.ATTESA, Codice.SERVER, consecutivi, false, risposta.retryAfterSecondi,
                        EsitoRinnovo.TETTO);
            case TRANSITORIO_RETE:
                return new DecisioneRinnovo(AzioneRinnovo.ATTESA, Codice.RETE, consecutivi, false, 0L, EsitoRinnovo.RETE);
            case TRANSITORIO_SERVER:
            default:
                return new DecisioneRinnovo(AzioneRinnovo.ATTESA, Codice.SERVER, consecutivi, false, 0L, EsitoRinnovo.SERVER);
        }
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * GLI HOST AMMESSI (§9)
     * ──────────────────────────────────────────────────────────────────────────── */

    /** Verso dove va una chiamata: la PUT (lo Storage), il rinnovo, il registro dei log (entrambi il sito). */
    public enum Destinazione {
        PUT,
        RINNOVO,
        REGISTRO
    }

    /** Il sito di produzione: l'unico host del rinnovo e del registro nelle build Release. */
    public static final String HOST_SITO_RELEASE = "app.kidville.it";

    /** Il dominio dello Storage: nelle build Release la PUT va solo a un sottodominio di questo. */
    public static final String SUFFISSO_HOST_STORAGE = ".supabase.co";

    /** Gli host in chiaro delle build Debug (emulatore → computer, simulatore, collaudo col server finto). */
    private static final String[] HOST_DEBUG = {"localhost", "127.0.0.1", "10.0.2.2"};

    private static final Pattern SOLO_ASCII_STAMPABILE = Pattern.compile("^[\\x21-\\x7E]+$");
    private static final Pattern FORMA_PORTA = Pattern.compile("^[0-9]{1,5}$");
    private static final Pattern FORMA_HOST = Pattern.compile("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$");

    /**
     * La politica degli host, la riga per riga di §9. Release: la PUT solo a `https://*.supabase.co`, il rinnovo e il registro
     * solo a `https://app.kidville.it` (porta 443 o assente). Debug, IN PIÙ: `http` o `https` verso `localhost`, `127.0.0.1`,
     * `10.0.2.2` con qualunque porta (per tutte e tre le destinazioni: il collaudo col server finto manda anche la PUT lì).
     *
     * È una difesa vera: l'URL arriva dalla pagina, e una pagina compromessa non deve poter far spedire il video di un
     * bambino altrove. Perciò si legge l'indirizzo a mano e in modo severo, senza `java.net.URI` (che perdona
     * `https://evil.com\@x.supabase.co`): solo caratteri ASCII stampabili, nessuna barra rovescia, nessuna credenziale
     * incorporata (`@`), nessun IPv6, nessuna percentuale nell'autorità, host in lettere minuscole e cifre separate da punti,
     * schema in minuscolo. L'host si confronta per uguaglianza (o per suffisso con il punto: `x.supabase.co`, mai
     * `supabase.co` né `x.supabase.co.evil.com`), e il percorso, la query e il frammento non contano.
     */
    public static boolean urlAmmesso(String url, Destinazione destinazione, boolean debug) {
        if (url == null || destinazione == null || url.length() > 8192) return false;
        if (!SOLO_ASCII_STAMPABILE.matcher(url).matches() || url.indexOf('\\') >= 0) return false;
        int separatore = url.indexOf("://");
        if (separatore <= 0) return false;
        String schema = url.substring(0, separatore);
        if (!schema.equals("http") && !schema.equals("https")) return false;
        String resto = url.substring(separatore + 3);
        int fine = resto.length();
        for (int i = 0; i < resto.length(); i++) {
            char c = resto.charAt(i);
            if (c == '/' || c == '?' || c == '#') {
                fine = i;
                break;
            }
        }
        String autorita = resto.substring(0, fine);
        // Credenziali, IPv6 e percentuali si rifiutano QUI, esplicitamente: `FORMA_HOST` più sotto li respingerebbe comunque (non
        // sono lettere, cifre, `-` o `.`), ma che `https://x@host` non passi non deve dipendere dall'alfabeto di una regex.
        if (autorita.isEmpty() || autorita.indexOf('@') >= 0 || autorita.indexOf('[') >= 0 || autorita.indexOf('%') >= 0) return false;
        String host = autorita;
        int porta = -1;
        int duePunti = autorita.indexOf(':');
        if (duePunti >= 0) {
            if (autorita.indexOf(':', duePunti + 1) >= 0) return false;
            host = autorita.substring(0, duePunti);
            String testoPorta = autorita.substring(duePunti + 1);
            if (!FORMA_PORTA.matcher(testoPorta).matches()) return false;
            porta = Integer.parseInt(testoPorta);
            if (porta < 1 || porta > 65535) return false;
        }
        host = host.toLowerCase(Locale.ROOT);
        if (!FORMA_HOST.matcher(host).matches()) return false;
        if (debug) {
            for (String ammesso : HOST_DEBUG) {
                if (host.equals(ammesso)) return true;
            }
        }
        if (!schema.equals("https")) return false;
        if (porta != -1 && porta != 443) return false;
        if (destinazione == Destinazione.PUT) return host.endsWith(SUFFISSO_HOST_STORAGE);
        return host.equals(HOST_SITO_RELEASE);
    }
}
