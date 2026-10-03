import Foundation

// ═══════════════════════════════════════════════════════════════════════════════════════════
//  KVPoliticaCaricamento — le tabelle di decisione dei caricamenti nativi in background
//  (spec 2026-10-03 «app 1.2: caricamenti nativi in background», §4.4, §4.5, §9 — compito I1)
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// **Vincolo deliberato:** questo file importa solo `Foundation`. Niente Capacitor, niente UIKit,
// niente WebKit, niente rete, niente disco, niente orologio: ogni funzione riceve ciò che le serve
// (compreso «adesso» e il numero casuale dello scarto) e restituisce una decisione. Così si compila
// e si prova riga per riga con `ios/prove/caricamenti/esegui.sh`, senza simulatore, e il motore
// (`KVMotoreCaricamenti`, compito I2) non deve rifare i conti: legge la decisione e la esegue.
//
// Che cosa c'è:
//   · i vocabolari (stati, codici, esiti), IDENTICI a quelli di
//     `src/lib/native/caricamenti-nativi-tipi.ts`: è lì la fonte dei nomi, e l'harness li confronta;
//   · la tabella di §4.4 (`transizione`) e il suo uso a due passi (`catena`);
//   · la tabella della PUT di §4.5 (`decidiPut`) e quella del rinnovo (`leggiRispostaRinnovo`,
//     `decidiRinnovo`);
//   · le attese (`attesa`), la soglia dei 10 minuti di S0 (`rinnovoProattivoNecessario`), la scadenza
//     del token, il diradamento dei log dei ritentativi;
//   · gli host ammessi (§9) per Release e Debug;
//   · i piccoli mattoni che il ponte verso il JavaScript pretende (date ISO con la `Z`, nome da 1 a
//     255 unità UTF-16, id e hash nella forma che gli schemi zod di S1 accettano).
//
// Che cosa NON c'è: il motore, la sessione `URLSession`, il Portachiavi, la notifica locale (I2);
// il selettore, le foto, la facciata del plugin (I3).

// MARK: - I vocabolari (identici a `caricamenti-nativi-tipi.ts`)

/// Lo stato di una voce della coda nativa (§4.4). Stessi sette valori di `STATI_NATIVI`.
enum KVStatoCaricamento: String, Codable, CaseIterable {
    case inCoda = "in-coda"
    case inInvio = "in-invio"
    case inAttesa = "in-attesa"
    case inPausa = "in-pausa"
    case inviato = "inviato"
    case fallito = "fallito"
    case annullato = "annullato"

    /// Da uno stato terminale non si esce più: copia e segreti sono già cancellati e la voce
    /// aspetta solo `dimentica` o la pulizia dei 7 giorni.
    var eTerminale: Bool {
        switch self {
        case .inviato, .fallito, .annullato: return true
        case .inCoda, .inInvio, .inAttesa, .inPausa: return false
        }
    }
}

/// Il PERCHÉ di un'attesa, di una pausa o di un esito. Mai testo libero. Stessi quattordici
/// valori di `CODICI_NATIVI`: `FGS_NON_AVVIABILE` e `UIDT_NON_PROGRAMMABILE` sono di Android e su
/// iOS non vengono mai prodotti, ma il vocabolario è uno solo per i due sistemi.
enum KVCodiceCaricamento: String, Codable, CaseIterable {
    case rete = "RETE"
    case server = "SERVER"
    case firmaRifiutata = "FIRMA_RIFIUTATA"
    case tokenNonValido = "TOKEN_NON_VALIDO"
    case tokenScaduto = "TOKEN_SCADUTO"
    case rinnovoCiclico = "RINNOVO_CICLICO"
    case troppoGrande = "TROPPO_GRANDE"
    case fileAssente = "FILE_ASSENTE"
    case pesoDiverso = "PESO_DIVERSO"
    case annullatoDalServer = "ANNULLATO_DAL_SERVER"
    case chiusuraForzata = "CHIUSURA_FORZATA"
    case fgsNonAvviabile = "FGS_NON_AVVIABILE"
    case uidtNonProgrammabile = "UIDT_NON_PROGRAMMABILE"
    case interno = "INTERNO"
}

/// Come è finito un invio riuscito (campo `esito` di `video-nativo-inviato`): la PUT è andata a
/// buon fine, oppure il rinnovo ha risposto «arrivato» (seconda PUT rifiutata come duplicato).
enum KVEsitoInvio: String {
    case put = "put"
    case giaArrivato = "gia-arrivato"
}

/// Su quale operazione è caduta una voce (campo `operazione` di `video-nativo-fallito`).
enum KVOperazione: String {
    case put = "put"
    case rinnovo = "rinnovo"
    case copia = "copia"
}

/// L'esito di una chiamata di rinnovo come si scrive nel log (`video-nativo-rinnovo: job=… <esito>`).
enum KVEsitoRinnovoLog: String {
    case daCaricare = "da-caricare"
    case arrivato = "arrivato"
    case annullato = "annullato"
    case negato = "negato"
    case tetto = "tetto"
    case rete = "rete"
    case server = "server"
}

/// I nomi d'errore dello Storage che il nativo sa leggere nel corpo di un rifiuto: un ELENCO CHIUSO, il
/// resto vale `altro` (§4.5). Il `message` non si legge e non si logga mai. `Duplicate` e
/// `InvalidJWT` sono misurati (S0-d, S0-c); gli altri sono i nomi che lo Storage usa per i suoi
/// rifiuti e che la spec nomina.
enum KVErroreStorage: String, CaseIterable {
    case duplicate = "Duplicate"
    case invalidJWT = "InvalidJWT"
    case entityTooLarge = "EntityTooLarge"
    case unauthorized = "Unauthorized"
    case invalidRequest = "InvalidRequest"
    case noSuchKey = "NoSuchKey"
    case altro = "altro"
}

/// I domini d'errore di sistema che finiscono in un log. Un dominio fuori elenco vale `altro`: nel
/// log non entra mai una stringa che non abbiamo scelto noi.
enum KVDominioErrore: String, CaseIterable {
    case url = "NSURLErrorDomain"
    case cocoa = "NSCocoaErrorDomain"
    case posix = "NSPOSIXErrorDomain"
    case altro = "altro"
}

/// Un errore di sistema ridotto a ciò che si può scrivere in un log: il dominio (da un elenco chiuso)
/// e il codice numerico. Mai il testo dell'errore.
struct KVErroreSistema: Equatable {
    let dominio: KVDominioErrore
    let codice: Int

    init(dominio: KVDominioErrore, codice: Int) {
        self.dominio = dominio
        self.codice = codice
    }

    init(_ errore: Error) {
        let ns = errore as NSError
        self.dominio = KVDominioErrore(rawValue: ns.domain) ?? .altro
        self.codice = ns.code
    }

    /// `NSURLErrorDomain:-1009`: la forma di `error_code` nei log (un enumerato, FORMA_ENUMERATO di `redact.ts`).
    var testo: String { "\(dominio.rawValue):\(codice)" }
}

/// Dove si usa un indirizzo: l'elenco degli host ammessi dipende da qui (§9).
enum KVUsoIndirizzo {
    case put
    case rinnovo
    case registro
}

/// Release o Debug: in Debug si ammettono in più gli host di sviluppo (§9).
enum KVAmbienteBuild {
    case release
    case debug

    /// L'ambiente del binario in esecuzione: lo decide la compilazione (`#if DEBUG`).
    static var corrente: KVAmbienteBuild {
        #if DEBUG
        return .debug
        #else
        return .release
        #endif
    }
}

// MARK: - Gli eventi di stato (§4.4)

/// Gli eventi che muovono una voce da uno stato all'altro: le righe della tabella di §4.4. Ogni evento
/// porta il suo codice quando ne ha uno, così non si può scrivere un `fallito` senza dire perché.
enum KVEventoStato: Equatable {
    /// `accodaVideo` riuscito (— → `in-coda`).
    case accodato
    /// Il trasferimento è partito (`in-coda` → `in-invio`).
    case trasferimentoAvviato
    /// Rete assente, task in attesa, backoff dopo un transitorio (`in-invio` → `in-attesa`).
    case inAttesa(KVCodiceCaricamento)
    /// Android 12-13: FGS non avviabile da background; Android ≥ 14: UIDT non programmabile
    /// (`in-invio` → `in-pausa`). Su iOS non succede.
    case inPausa(KVCodiceCaricamento)
    /// Rete tornata o app riaperta (`in-attesa`/`in-pausa` → `in-invio`).
    case ripreso
    /// PUT 2xx, oppure rinnovo `arrivato` (`in-invio` → `inviato`).
    case inviato
    /// Rinnovo `annullato`, oppure `annulla` dal JS (qualunque non terminale → `annullato`).
    case annullato(KVCodiceCaricamento?)
    /// Esito definitivo di §4.5, oppure token scaduto (qualunque non terminale → `fallito`).
    case fallito(KVCodiceCaricamento)

    var codice: KVCodiceCaricamento? {
        switch self {
        case .inAttesa(let codice), .inPausa(let codice), .fallito(let codice): return codice
        case .annullato(let codice): return codice
        case .accodato, .trasferimentoAvviato, .ripreso, .inviato: return nil
        }
    }
}

// MARK: - La PUT (§4.5, prima tabella)

/// Ciò che il motore sa dire di una PUT finita, nella forma in cui lo ha: lo stato HTTP (`nil` = nessuna
/// risposta), i primi 4 KB del corpo, il valore grezzo di `Retry-After`, l'errore di sistema se c'è, il
/// motivo con cui iOS ha annullato il task (`NSURLErrorBackgroundTaskCancelledReasonKey`), la durata
/// del trasferimento in secondi e se TUTTI i byte erano già partiti quando è arrivata la risposta
/// (`countOfBytesSent` ≥ `countOfBytesExpectedToSend` del task).
struct KVRispostaPut: Equatable {
    var statoHTTP: Int?
    var corpo: Data
    var retryAfter: String?
    var errore: KVErroreSistema?
    var motivoAnnullamento: Int?
    var durataSecondi: Int
    var trasferimentoCompleto: Bool

    init(statoHTTP: Int? = nil, corpo: Data = Data(), retryAfter: String? = nil,
         errore: KVErroreSistema? = nil, motivoAnnullamento: Int? = nil, durataSecondi: Int = 0,
         trasferimentoCompleto: Bool = false) {
        self.statoHTTP = statoHTTP
        self.corpo = corpo
        self.retryAfter = retryAfter
        self.errore = errore
        self.motivoAnnullamento = motivoAnnullamento
        self.durataSecondi = durataSecondi
        self.trasferimentoCompleto = trasferimentoCompleto
    }
}

/// Che cosa si legge nel corpo di un rifiuto dello Storage: `statusCode` ed `error`, e basta.
struct KVCorpoStorage: Equatable {
    var statusCode: Int?
    /// `nil` se il corpo era vuoto; `.altro` se c'era ma non lo riconosciamo.
    var errore: KVErroreStorage?
}

/// Che cosa fare dopo una PUT.
enum KVDecisionePut: Equatable {
    /// 2xx → `inviato` (`esito: put`).
    case inviato
    /// Esito definitivo senza rinnovo (oggi solo `TROPPO_GRANDE`).
    case fallito(KVCodiceCaricamento)
    /// Transitorio: aspettare `attesa` secondi, poi rifare un giro (e la regola di S0 dice se prima si
    /// rinnova). `statoHTTP` 0 = nessuna risposta. `codice` è `RETE` o `SERVER`.
    case riprova(attesa: TimeInterval, codice: KVCodiceCaricamento, statoHTTP: Int)
    /// Qualunque altro 4xx: è il rinnovo a dire se il file c'è. `errore` è il nome d'errore dello
    /// Storage (per il log del rinnovo); `oltreScadenzaDopoSecondi` è la durata del trasferimento quando
    /// il rifiuto è un `InvalidJWT` arrivato dopo che TUTTI i byte erano partiti (la firma è scaduta mentre
    /// salivano, S0-b/S0-b2): va scritto `put-oltre-scadenza`.
    case rinnova(errore: KVErroreStorage?, statoHTTP: Int, oltreScadenzaDopoSecondi: Int?)
    /// iOS ha annullato il task perché l'utente ha chiuso l'app dal multitasking: si ricrea alla riapertura
    /// (`CHIUSURA_FORZATA`, §5.7).
    case ricreaAllaRiapertura
}

// MARK: - Il rinnovo (§4.5, seconda tabella)

/// Perché si sta rinnovando. Conta per `RINNOVO_CICLICO`: si contano solo i rinnovi che seguono una PUT
/// RIFIUTATA, perché sono gli unici che possono girare in tondo (la nuova firma non basta e il rifiuto
/// torna). Un rinnovo fatto solo perché l'URL è vecchio (la regola dei 10 minuti di S0, dopo un'attesa)
/// non indica nessun ciclo: contarlo farebbe fallire per sempre un video dopo un'ora di Storage fuori uso.
/// Lo stesso conto vale su Android (`PoliticaCaricamento.decidiRinnovo`): la lettura è una sola per i due sistemi.
enum KVCausaRinnovo: Equatable {
    case putRifiutata
    case urlVecchio
}

/// Perché una risposta del rinnovo vale «riprova più tardi».
enum KVMotivoTransitorio: Equatable {
    case rete
    case server
    case fuoriSchema
}

/// La risposta del rinnovo, già riletta per forma (`leggiRispostaRinnovo`): ciò che non torna vale
/// transitorio, mai un'azione.
struct KVRispostaRinnovo: Equatable {
    enum Esito: Equatable {
        case daCaricare(url: URL, contentType: String, tokenScadeIl: Date)
        case arrivato
        case annullato
        case nonTrovato
        case limitato(retryAfter: TimeInterval?)
        case transitorio(KVMotivoTransitorio)
    }

    var esito: Esito
    /// 0 = nessuna risposta.
    var statoHTTP: Int

    /// Come si scrive nel log (`video-nativo-rinnovo: job=… <esito>`).
    var esitoLog: KVEsitoRinnovoLog {
        switch esito {
        case .daCaricare: return .daCaricare
        case .arrivato: return .arrivato
        case .annullato: return .annullato
        case .nonTrovato: return .negato
        case .limitato: return .tetto
        case .transitorio(let motivo): return motivo == .rete ? .rete : .server
        }
    }
}

/// Ciò che la decisione sul rinnovo deve sapere oltre alla risposta.
struct KVContestoRinnovo: Equatable {
    var causa: KVCausaRinnovo
    /// Il valore di `rinnoviConsecutivi` della voce prima di questa risposta.
    var rinnoviConsecutivi: Int
    /// Il numero di tentativi della voce (per la progressione delle attese).
    var tentativo: Int
    /// Nel Portachiavi c'è un token più recente di quello usato (rotazione appena arrivata).
    var tokenPiuRecenteDisponibile: Bool
    var adesso: Date
    /// Un numero uniforme in [0, 1] per lo scarto delle attese.
    var casuale: Double

    init(causa: KVCausaRinnovo, rinnoviConsecutivi: Int, tentativo: Int,
         tokenPiuRecenteDisponibile: Bool = false, adesso: Date, casuale: Double) {
        self.causa = causa
        self.rinnoviConsecutivi = rinnoviConsecutivi
        self.tentativo = tentativo
        self.tokenPiuRecenteDisponibile = tokenPiuRecenteDisponibile
        self.adesso = adesso
        self.casuale = casuale
    }
}

/// Che cosa fare dopo la risposta del rinnovo.
enum KVDecisioneRinnovo: Equatable {
    /// 200 `da-caricare`: nuova PUT sul nuovo URL, che vale da adesso `validitaUrlPutSecondi` secondi.
    /// `rinnoviConsecutivi` è il valore da scrivere nella voce; `tokenScadeIl` è quello dichiarato dal
    /// server (la scadenza del TOKEN, che il rinnovo non allunga).
    case nuovaPut(url: URL, contentType: String, urlScadeIl: Date, tokenScadeIl: Date, rinnoviConsecutivi: Int)
    /// 200 `arrivato` → `inviato` (`esito: gia-arrivato`).
    case inviato
    /// 200 `annullato` → `annullato` (`ANNULLATO_DAL_SERVER`).
    case annullato(KVCodiceCaricamento)
    /// `RINNOVO_CICLICO` (oltre tre rinnovi dopo una PUT rifiutata) o `TOKEN_NON_VALIDO` (404). Il rinnovo che fa scattare il tetto ha comunque
    /// consegnato un URL: il motore lo conta in `rinnovi` (è il numero che finisce in `video-nativo-fallito`).
    case fallito(KVCodiceCaricamento)
    /// 404 ma nel Portachiavi c'è un token più recente: si riprova con quello.
    case riprovaConTokenPiuRecente
    /// 429, 5xx, rete, corpo fuori schema: si aspetta e si rifà il giro.
    case attendi(secondi: TimeInterval)
}

// MARK: - La politica

enum KVPoliticaCaricamento {

    // MARK: Numeri

    /// Per quanto vale un URL di PUT firmato: due ore (`VALIDITA_FIRMA_SECONDI` del server, `VALIDITA_URL_PUT_SECONDI` in TS).
    static let validitaUrlPutSecondi: TimeInterval = 7200

    /// S0 (§3): lo Storage verifica la firma quando arriva l'ULTIMO byte, quindi prima di ogni PUT si rinnova se
    /// l'URL è stato firmato da più di 10 minuti: ogni trasferimento ha davanti quasi due ore piene.
    static let sogliaRinnovoProattivoSecondi: TimeInterval = 600

    /// Oltre questo numero di rinnovi consecutivi dopo una PUT rifiutata, senza un 2xx: `RINNOVO_CICLICO`.
    static let tettoRinnoviConsecutivi = 3

    /// Le attese dopo un transitorio: 30 s, 1', 2', 5', 10', 15', poi 15' fisse. Nessun tetto al numero di tentativi
    /// dentro la vita del token (48 h): si insiste finché il server lo permette.
    static let attesePerTentativo: [TimeInterval] = [30, 60, 120, 300, 600, 900]

    /// Lo scarto casuale delle attese: ±20%.
    static let scartoAttesa = 0.2

    /// `Retry-After` vince se più lungo dell'attesa, ma al massimo un'ora.
    static let tettoRetryAfterSecondi: TimeInterval = 3600

    /// Del corpo di una risposta si leggono i primi 4 KB.
    static let byteCorpoMassimo = 4096

    /// Il nome per lo schermo (e dichiarato al server) sta fra 1 e 255 unità UTF-16, come `schemaNome` di S1. Il ripiego è lo stesso di Android.
    static let lunghezzaMassimaNome = 255
    static let nomeDiRipiego = "Video"
    /// Il MIME che il ponte porta quando quello salvato non ha la forma che il server accetta: mai una risposta fuori schema (lo stesso valore di Android).
    static let mimeDiRipiego = "video/mp4"

    /// Gli host di sviluppo ammessi in Debug (§9): gli stessi di `HOST_DEBUG_CARICAMENTI` in TS.
    static let hostDebug = ["localhost", "127.0.0.1", "10.0.2.2"]
    static let suffissoHostPut = ".supabase.co"
    static let hostApplicazione = "app.kidville.it"
    static let lunghezzaMassimaIndirizzo = 2048

    // MARK: Gli stati (§4.4)

    /// La tabella di §4.4, una riga per freccia. `stato` è `nil` per «—» (la voce non esiste ancora).
    /// Restituisce lo stato d'arrivo, o `nil` se la tabella non prevede quel passo (compreso ogni passo da uno
    /// stato terminale).
    ///
    /// `in-coda` → `in-pausa` (deciso il 03/10 dopo l'ondata 2): la usa Android (§6.2); qui c'è perché le tabelle di
    /// TS, Swift e Java sono la stessa, ma su iOS nessun evento la percorre.
    static func transizione(da stato: KVStatoCaricamento?, evento: KVEventoStato) -> KVStatoCaricamento? {
        guard let stato = stato else {
            if case .accodato = evento { return .inCoda }
            return nil
        }
        if stato.eTerminale { return nil }
        switch (stato, evento) {
        case (.inCoda, .trasferimentoAvviato): return .inInvio
        case (.inInvio, .inAttesa): return .inAttesa
        case (.inInvio, .inPausa), (.inCoda, .inPausa): return .inPausa
        case (.inAttesa, .ripreso), (.inPausa, .ripreso): return .inInvio
        case (.inInvio, .inviato): return .inviato
        case (_, .annullato): return .annullato
        case (_, .fallito): return .fallito
        default: return nil
        }
    }

    /// La tabella descrive i passi della politica; il motore, a volte, riceve l'esito mentre la voce non ha ancora
    /// fatto il passo prima (un task che finisce con la voce ancora `in-attesa` perché l'app dormiva, un esito che
    /// arriva mentre la voce è ancora `in-coda`). Questa è la sequenza di eventi da applicare: l'evento da solo se la
    /// tabella lo prevede, altrimenti UN passo preparatorio (`trasferimentoAvviato` da `in-coda`, `ripreso` da
    /// `in-attesa`/`in-pausa`) e poi l'evento. `nil` se nemmeno così il passo esiste.
    static func catena(da stato: KVStatoCaricamento, evento: KVEventoStato) -> [KVEventoStato]? {
        if transizione(da: stato, evento: evento) != nil { return [evento] }
        let preparatorio: KVEventoStato
        switch stato {
        case .inCoda: preparatorio = .trasferimentoAvviato
        case .inAttesa, .inPausa: preparatorio = .ripreso
        case .inInvio, .inviato, .fallito, .annullato: return nil
        }
        guard let intermedio = transizione(da: stato, evento: preparatorio),
              transizione(da: intermedio, evento: evento) != nil else { return nil }
        return [preparatorio, evento]
    }

    /// Il token di rinnovo vale fino a `tokenScadeIl` (48 ore dall'apertura): da lì in poi la voce è `fallito`
    /// (`TOKEN_SCADUTO`) e non si insiste più.
    static func tokenScaduto(adesso: Date, tokenScadeIl: Date) -> Bool {
        return adesso >= tokenScadeIl
    }

    // MARK: La PUT (§4.5)

    /// La tabella della PUT. Si legge lo STATO HTTP e, solo per i rifiuti, i primi 4 KB del corpo: lo Storage manda
    /// quasi tutti i suoi rifiuti come HTTP 400 (spec PR 2 §6.2, A1/A16), per cui lo stato da solo non distingue «file già
    /// arrivato» da «firma scaduta» da «troppo grande». `tentativo` è il numero della voce (per l'attesa) e `casuale`
    /// lo scarto, un numero uniforme in [0, 1] che passa il chiamante.
    ///
    ///     2xx                                                   → inviato
    ///     413, o corpo statusCode 413 / EntityTooLarge          → fallito TROPPO_GRANDE (senza rinnovo)
    ///     408, 429, 5xx                                         → attesa (Retry-After se più lungo), poi la regola di S0
    ///     qualunque altro 4xx (400 col 409 nel corpo, 400
    ///       InvalidJWT, 401, 403, 404, 409…)                    → rinnovo
    ///     1xx, 3xx, oltre 599                                   → attesa (la tabella non li nomina: non chiudono una voce)
    ///     nessuna risposta                                      → attesa (RETE); chiusura forzata dell'utente → da ricreare
    static func decidiPut(_ risposta: KVRispostaPut, tentativo: Int, adesso: Date, casuale: Double) -> KVDecisionePut {
        guard let stato = risposta.statoHTTP, stato > 0 else {
            return decidiPutSenzaRisposta(risposta, tentativo: tentativo, casuale: casuale)
        }
        // 2xx
        if (200...299).contains(stato) { return .inviato }

        // 413 sull'intestazione, oppure nel corpo: lo Storage manda un 413 come HTTP 400 col `statusCode` dentro.
        let corpo = leggiCorpoStorage(risposta.corpo)
        if stato == 413 || corpo.statusCode == 413 || corpo.errore == .entityTooLarge {
            return .fallito(.troppoGrande)
        }

        // 408, 429 e 5xx: transitorio.
        if stato == 408 || stato == 429 || (500...599).contains(stato) {
            let retryAfter = secondiRetryAfter(risposta.retryAfter, adesso: adesso)
            return .riprova(attesa: attesa(tentativo: tentativo, retryAfter: retryAfter, casuale: casuale),
                            codice: .server, statoHTTP: stato)
        }

        // Qualunque altro 4xx: rinnovo, è lui a dire se il file c'è. Un `InvalidJWT` arrivato dopo che TUTTI i byte erano partiti è la firma
        // scaduta durante l'invio (S0-b, S0-b2); uno arrivato mentre i byte non erano finiti è un URL già scaduto alla partenza (S0-c, rifiuto in
        // 72 ms): rinnovo, ma non «oltre la scadenza».
        if (400...499).contains(stato) {
            var oltreScadenza: Int? = nil
            if corpo.errore == .invalidJWT && risposta.trasferimentoCompleto {
                oltreScadenza = risposta.durataSecondi
            }
            return .rinnova(errore: corpo.errore, statoHTTP: stato, oltreScadenzaDopoSecondi: oltreScadenza)
        }

        // Ciò che la tabella non nomina (1xx, 3xx, oltre 599): transitorio, come sull'altra piattaforma. Ciò che non si conosce non chiude una voce.
        let retryAfter = secondiRetryAfter(risposta.retryAfter, adesso: adesso)
        return .riprova(attesa: attesa(tentativo: tentativo, retryAfter: retryAfter, casuale: casuale),
                        codice: .server, statoHTTP: stato)
    }

    /// Quanti rinnovi di fila vale la voce dopo l'esito di una PUT: un rifiuto che chiede il rinnovo lo lascia com'è (lo alza la risposta `da-caricare`,
    /// in `decidiRinnovo`); qualunque altro esito (un transitorio, un 413, un 2xx, una chiusura forzata) lo azzera, perché il server non ha rifiutato di
    /// nuovo una firma appena data: non è un ciclo.
    static func rinnoviConsecutiviDopoPut(attuali: Int, decisione: KVDecisionePut) -> Int {
        if case .rinnova = decisione { return max(attuali, 0) }
        return 0
    }

    private static func decidiPutSenzaRisposta(_ risposta: KVRispostaPut, tentativo: Int, casuale: Double) -> KVDecisionePut {
        // iOS annulla i trasferimenti quando l'utente chiude l'app dal multitasking, e alla riapertura la sessione
        // consegna `NSURLErrorCancelled` col motivo `userForceQuitApplication` (0): si ricrea, senza attese.
        if let errore = risposta.errore,
           errore.dominio == .url,
           errore.codice == NSURLErrorCancelled,
           risposta.motivoAnnullamento == NSURLErrorCancelledReasonUserForceQuitApplication {
            return .ricreaAllaRiapertura
        }
        // Nessuna risposta (rete, timeout, connessione persa, annullamento di sistema per altri motivi): transitorio.
        // Un annullamento deciso da NOI (`annulla` dal JS) non passa di qui: la voce è già `annullato` e il motore ignora il
        // completamento del task di una voce terminale prima di chiedere una decisione.
        return .riprova(attesa: attesa(tentativo: tentativo, retryAfter: nil, casuale: casuale),
                        codice: .rete, statoHTTP: 0)
    }

    /// Dal corpo di un rifiuto si ricavano solo `statusCode` ed `error`, e `error` si confronta con l'elenco chiuso.
    /// Un corpo vuoto non dice niente (`errore` = `nil`); un corpo che c'è ma non si legge, o un nome fuori elenco,
    /// vale `altro`. Il `message` non si guarda.
    static func leggiCorpoStorage(_ corpo: Data) -> KVCorpoStorage {
        let letto = Data(corpo.prefix(byteCorpoMassimo))
        if letto.isEmpty { return KVCorpoStorage(statusCode: nil, errore: nil) }
        guard let json = try? JSONSerialization.jsonObject(with: letto, options: []),
              let oggetto = json as? [String: Any] else {
            return KVCorpoStorage(statusCode: nil, errore: .altro)
        }
        var statusCode: Int? = nil
        if let testo = oggetto["statusCode"] as? String {
            statusCode = Int(testo)
        } else if let numero = oggetto["statusCode"] as? NSNumber {
            statusCode = numero.intValue
        }
        let errore: KVErroreStorage
        if let nome = oggetto["error"] as? String {
            errore = KVErroreStorage(rawValue: nome) ?? .altro
        } else {
            errore = .altro
        }
        return KVCorpoStorage(statusCode: statusCode, errore: errore)
    }

    /// L'operazione su cui cade una voce, per il campo `operazione` di `video-nativo-fallito`.
    static func operazione(per codice: KVCodiceCaricamento) -> KVOperazione {
        switch codice {
        case .fileAssente, .pesoDiverso: return .copia
        case .tokenNonValido, .tokenScaduto, .rinnovoCiclico, .annullatoDalServer, .firmaRifiutata: return .rinnovo
        case .rete, .server, .troppoGrande, .chiusuraForzata, .fgsNonAvviabile, .uidtNonProgrammabile, .interno: return .put
        }
    }

    // MARK: Il rinnovo (§4.5)

    /// Legge la risposta del rinnovo per FORMA: `stato` ∈ tre valori, `caricamento.protocollo == "put"`, URL che passa la
    /// politica degli host, `content-type` e `scadeIl` ben formati. Ciò che non torna vale transitorio. `statoHTTP` `nil`
    /// = nessuna risposta.
    static func leggiRispostaRinnovo(statoHTTP: Int?, corpo: Data, retryAfter: String?, adesso: Date,
                                     ambiente: KVAmbienteBuild) -> KVRispostaRinnovo {
        guard let stato = statoHTTP, stato > 0 else {
            return KVRispostaRinnovo(esito: .transitorio(.rete), statoHTTP: 0)
        }
        switch stato {
        case 200:
            return KVRispostaRinnovo(esito: leggiCorpoRinnovo(corpo, ambiente: ambiente), statoHTTP: stato)
        case 404:
            return KVRispostaRinnovo(esito: .nonTrovato, statoHTTP: stato)
        case 429:
            return KVRispostaRinnovo(esito: .limitato(retryAfter: secondiRetryAfter(retryAfter, adesso: adesso)), statoHTTP: stato)
        case 500...599:
            return KVRispostaRinnovo(esito: .transitorio(.server), statoHTTP: stato)
        default:
            // Una porta che per contratto risponde solo 200, 404, 429 e 5xx: altro è fuori forma.
            return KVRispostaRinnovo(esito: .transitorio(.fuoriSchema), statoHTTP: stato)
        }
    }

    private static func leggiCorpoRinnovo(_ corpo: Data, ambiente: KVAmbienteBuild) -> KVRispostaRinnovo.Esito {
        guard let json = try? JSONSerialization.jsonObject(with: corpo, options: []),
              let oggetto = json as? [String: Any],
              let stato = oggetto["stato"] as? String else {
            return .transitorio(.fuoriSchema)
        }
        switch stato {
        case "arrivato": return .arrivato
        case "annullato": return .annullato
        case "da-caricare":
            guard let caricamento = oggetto["caricamento"] as? [String: Any],
                  (caricamento["protocollo"] as? String) == "put",
                  let testoUrl = caricamento["url"] as? String,
                  let url = indirizzoAmmesso(testoUrl, uso: .put, ambiente: ambiente),
                  let intestazioni = caricamento["intestazioni"] as? [String: Any],
                  let contentType = intestazioni["content-type"] as? String,
                  contentTypeAmmesso(contentType),
                  let testoScadenza = oggetto["scadeIl"] as? String,
                  let tokenScadeIl = leggiDataISO(testoScadenza) else {
                return .transitorio(.fuoriSchema)
            }
            return .daCaricare(url: url, contentType: contentType, tokenScadeIl: tokenScadeIl)
        default:
            return .transitorio(.fuoriSchema)
        }
    }

    /// Il `content-type` che finisce in un'intestazione: da 3 a 255 caratteri, fatto come un tipo MIME e senza caratteri di
    /// controllo (un a capo in un'intestazione è un'iniezione).
    static func contentTypeAmmesso(_ valore: String) -> Bool {
        guard (3...255).contains(valore.utf8.count) else { return false }
        for scalare in valore.unicodeScalars where scalare.value < 0x20 || scalare.value == 0x7F { return false }
        guard let barra = valore.firstIndex(of: "/") else { return false }
        let tipo = String(valore[..<barra])
        let resto = valore[valore.index(after: barra)...]
        let sottotipo = (resto.firstIndex(of: ";").map { resto[..<$0] } ?? resto).trimmingCharacters(in: .whitespaces)
        return parteDiMimeAmmessa(tipo) && parteDiMimeAmmessa(sottotipo)
    }

    /// Una metà di un tipo MIME come la vuole il server (`MIME_DICHIARABILE`): da 1 a 127 caratteri, il primo una lettera o una cifra,
    /// gli altri anche `!#$&^_.+-`.
    private static func parteDiMimeAmmessa(_ parte: String) -> Bool {
        guard (1...127).contains(parte.utf8.count) else { return false }
        for (posizione, scalare) in parte.lowercased().unicodeScalars.enumerated() {
            let valore = scalare.value
            let alfanumerico = (valore >= 0x30 && valore <= 0x39) || (valore >= 0x61 && valore <= 0x7A)
            if alfanumerico { continue }
            if posizione > 0, "!#$&^_.+-".unicodeScalars.contains(scalare) { continue }
            return false
        }
        return true
    }

    /// La decisione sul rinnovo (la tabella «Risposta del rinnovo» di §4.5).
    static func decidiRinnovo(_ risposta: KVRispostaRinnovo, contesto: KVContestoRinnovo) -> KVDecisioneRinnovo {
        switch risposta.esito {
        case .daCaricare(let url, let contentType, let tokenScadeIl):
            // Solo un rinnovo che segue una PUT rifiutata può girare in tondo: lo si conta, e oltre il tetto si smette.
            var consecutivi = contesto.rinnoviConsecutivi
            if contesto.causa == .putRifiutata {
                consecutivi += 1
                if consecutivi > tettoRinnoviConsecutivi { return .fallito(.rinnovoCiclico) }
            }
            return .nuovaPut(url: url, contentType: contentType,
                             urlScadeIl: contesto.adesso.addingTimeInterval(validitaUrlPutSecondi),
                             tokenScadeIl: tokenScadeIl, rinnoviConsecutivi: consecutivi)
        case .arrivato:
            return .inviato
        case .annullato:
            return .annullato(.annullatoDalServer)
        case .nonTrovato:
            // Una rotazione appena arrivata lascia il vecchio token sconosciuto: se ce n'è uno più recente si riprova con quello.
            return contesto.tokenPiuRecenteDisponibile ? .riprovaConTokenPiuRecente : .fallito(.tokenNonValido)
        case .limitato(let retryAfter):
            return .attendi(secondi: attesa(tentativo: contesto.tentativo, retryAfter: retryAfter, casuale: contesto.casuale))
        case .transitorio:
            return .attendi(secondi: attesa(tentativo: contesto.tentativo, retryAfter: nil, casuale: contesto.casuale))
        }
    }

    // MARK: Attese e soglie

    /// L'attesa prima del tentativo successivo: 30 s, 1', 2', 5', 10', 15', poi 15' fisse, con ±20% di scarto casuale
    /// (`casuale` è un numero uniforme in [0, 1]: 0 dà −20%, 1 dà +20%). `Retry-After` vince se è più lungo, entro l'ora.
    /// `tentativo` parte da 1 (il primo tentativo fallito).
    static func attesa(tentativo: Int, retryAfter: TimeInterval?, casuale: Double) -> TimeInterval {
        let indice = min(max(tentativo, 1), attesePerTentativo.count) - 1
        let base = attesePerTentativo[indice]
        let sorteggio = min(max(casuale, 0), 1)
        let fattore = (1 - scartoAttesa) + (2 * scartoAttesa) * sorteggio
        let conScarto = base * fattore
        guard let retryAfter = retryAfter, retryAfter > 0 else { return conScarto }
        return max(conScarto, min(retryAfter, tettoRetryAfterSecondi))
    }

    /// `Retry-After` è un numero di secondi o una data HTTP (RFC 9110, §10.2.3). Un valore che non si capisce è `nil`.
    static func secondiRetryAfter(_ valore: String?, adesso: Date) -> TimeInterval? {
        guard let grezzo = valore?.trimmingCharacters(in: .whitespaces), !grezzo.isEmpty else { return nil }
        if grezzo.unicodeScalars.allSatisfy({ $0.value >= 0x30 && $0.value <= 0x39 }) {
            return Int(grezzo).map { TimeInterval($0) }
        }
        let formato = DateFormatter()
        formato.locale = Locale(identifier: "en_US_POSIX")
        formato.timeZone = TimeZone(secondsFromGMT: 0)
        formato.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
        guard let data = formato.date(from: grezzo) else { return nil }
        return max(0, data.timeIntervalSince(adesso))
    }

    /// S0 (§3): prima di creare o ricreare un trasferimento si rinnova l'URL se è stato firmato da PIÙ di 10 minuti fa. L'istante di firma è la
    /// scadenza meno la validità. Una scadenza sconosciuta (`nil`) vale «da rinnovare»: spedire fino a 2 GB su un URL di cui non si sa l'età è la spesa
    /// che S0 vuole evitare, e dopo un rifiuto della PUT il motore azzera la scadenza proprio perché il giro seguente cominci dal rinnovo e non
    /// rispedisca l'URL rifiutato. Esattamente 10 minuti non bastano: «più di».
    static func rinnovoProattivoNecessario(urlScadeIl: Date?, adesso: Date) -> Bool {
        guard let urlScadeIl = urlScadeIl else { return true }
        let firmatoIl = urlScadeIl.addingTimeInterval(-validitaUrlPutSecondi)
        return adesso.timeIntervalSince(firmatoIl) > sogliaRinnovoProattivoSecondi
    }

    /// I ritentativi si loggano ai tentativi 1, 2, 4, 8, 16, …: la coda insiste, il registro no (§8.1).
    static func tentativoDaLoggare(_ tentativo: Int) -> Bool {
        return tentativo >= 1 && (tentativo & (tentativo - 1)) == 0
    }

    // MARK: Gli host ammessi (§9)

    /// Un indirizzo che il JS dà al nativo (la PUT, il rinnovo, il registro) si usa solo se passa di qui. Release: la PUT solo
    /// `https://*.supabase.co`, rinnovo e registro solo `https://app.kidville.it`. Debug: in più `http(s)://` verso
    /// `localhost`, `127.0.0.1`, `10.0.2.2`, con qualunque porta.
    ///
    /// L'indirizzo si SCOMPONE a mano e con regole strette (solo ASCII stampabile, nessuna credenziale, nessun `\`, host fatto di
    /// lettere cifre punti e trattini) PRIMA di fidarsi del parser di sistema, e alla fine i due devono concordare sull'host: due
    /// parser che leggono in modo diverso lo stesso testo sono il modo in cui `https://app.kidville.it\@evil.com` diventa un
    /// invio del video di un bambino altrove. Restituisce l'`URL` da usare, o `nil`.
    static func indirizzoAmmesso(_ testo: String, uso: KVUsoIndirizzo, ambiente: KVAmbienteBuild) -> URL? {
        guard testo.utf8.count <= lunghezzaMassimaIndirizzo else { return nil }
        for scalare in testo.unicodeScalars where scalare.value <= 0x20 || scalare.value >= 0x7F { return nil }

        let schema: String
        let resto: Substring
        let minuscolo = testo.lowercased()
        if minuscolo.hasPrefix("https://") {
            schema = "https"
            resto = testo.dropFirst(8)
        } else if minuscolo.hasPrefix("http://") {
            schema = "http"
            resto = testo.dropFirst(7)
        } else {
            return nil
        }

        let fineAutorita = resto.firstIndex(where: { $0 == "/" || $0 == "?" || $0 == "#" }) ?? resto.endIndex
        let autorita = resto[..<fineAutorita]
        // Credenziali e barra rovesciata fuori subito. È una guardia RIDONDANTE con il controllo dei caratteri dell'host qui sotto (che non ammette né
        // `@` né `\`), e per questo non c'è una prova che la tolga e diventi rossa: sta lì perché dica l'intento, e perché se un domani si allargasse
        // l'elenco dei caratteri dell'host le credenziali restino comunque fuori.
        guard !autorita.isEmpty, !autorita.contains("@"), !autorita.contains("\\") else { return nil }

        let parti = autorita.split(separator: ":", omittingEmptySubsequences: false)
        guard parti.count == 1 || parti.count == 2 else { return nil }
        let host = String(parti[0]).lowercased()
        var porta: Int? = nil
        if parti.count == 2 {
            let cifre = parti[1]
            guard !cifre.isEmpty, cifre.count <= 5,
                  cifre.unicodeScalars.allSatisfy({ $0.value >= 0x30 && $0.value <= 0x39 }),
                  let numero = Int(cifre), (1...65535).contains(numero) else { return nil }
            porta = numero
        }
        guard !host.isEmpty, !host.hasPrefix("."), !host.hasSuffix("."), !host.hasPrefix("-"), !host.contains("..") else { return nil }
        for scalare in host.unicodeScalars {
            let valore = scalare.value
            let lettera = valore >= 0x61 && valore <= 0x7A
            let cifra = valore >= 0x30 && valore <= 0x39
            if !(lettera || cifra || valore == 0x2E || valore == 0x2D) { return nil }
        }

        var ammesso = false
        if ambiente == .debug && hostDebug.contains(host) {
            ammesso = true
        }
        if !ammesso {
            guard schema == "https", porta == nil || porta == 443 else { return nil }
            switch uso {
            case .put:
                guard host.hasSuffix(suffissoHostPut), host.count > suffissoHostPut.count else { return nil }
            case .rinnovo, .registro:
                guard host == hostApplicazione else { return nil }
            }
        }

        // Il parser di sistema deve leggere lo stesso schema, lo stesso host e la stessa porta, e nessuna credenziale.
        guard let url = URL(string: testo),
              let componenti = URLComponents(url: url, resolvingAgainstBaseURL: false),
              componenti.scheme?.lowercased() == schema,
              componenti.host?.lowercased() == host,
              componenti.port == porta,
              componenti.user == nil, componenti.password == nil else { return nil }
        return url
    }

    // MARK: I mattoni del ponte verso il JavaScript

    /// Un istante nella forma che lo schema di S1 accetta: ISO 8601 UTC con la `Z`, al secondo (`2026-10-03T01:15:00Z`). Né
    /// `+0000` né `+00`: zod li rifiuta.
    static func isoZ(_ data: Date) -> String {
        let formato = ISO8601DateFormatter()
        formato.formatOptions = [.withInternetDateTime]
        formato.timeZone = TimeZone(secondsFromGMT: 0)
        return formato.string(from: data)
    }

    /// Legge un istante ISO 8601 con o senza frazione di secondo (il server scrive i millisecondi: `…:00.123Z`).
    static func leggiDataISO(_ testo: String) -> Date? {
        let formato = ISO8601DateFormatter()
        formato.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let data = formato.date(from: testo) { return data }
        formato.formatOptions = [.withInternetDateTime]
        return formato.date(from: testo)
    }

    /// Il nome che va al JS: da 1 a 255 unità UTF-16 (è così che lo schema di S1 conta), senza spazi attorno. Se il sistema non ha dato
    /// un nome, o non resta niente, un ripiego nostro: un nome vuoto diventerebbe un 400 all'apertura dell'intento. Il taglio non spezza
    /// mai un carattere (una faccina sono due unità).
    static func nomePerIlPonte(_ nome: String) -> String {
        let pulito = nome.trimmingCharacters(in: .whitespacesAndNewlines)
        if pulito.isEmpty { return nomeDiRipiego }
        if pulito.utf16.count <= lunghezzaMassimaNome { return pulito }
        var tagliato = ""
        var unita = 0
        for carattere in pulito {
            let lunghezza = String(carattere).utf16.count
            if unita + lunghezza > lunghezzaMassimaNome { break }
            tagliato.append(carattere)
            unita += lunghezza
        }
        let finale = tagliato.trimmingCharacters(in: .whitespacesAndNewlines)
        return finale.isEmpty ? nomeDiRipiego : finale
    }

    /// L'id di un elemento scelto: un gettone senza separatori né punti (dà il nome al file preparato).
    static func idElementoValido(_ id: String) -> Bool {
        guard (1...64).contains(id.utf8.count) else { return false }
        for (posizione, scalare) in id.unicodeScalars.enumerated() {
            let valore = scalare.value
            let alfanumerico = (valore >= 0x30 && valore <= 0x39) || (valore >= 0x41 && valore <= 0x5A) || (valore >= 0x61 && valore <= 0x7A)
            if alfanumerico { continue }
            if posizione > 0 && (valore == 0x5F || valore == 0x2D) { continue }
            return false
        }
        return true
    }

    /// L'impronta SHA-256 in esadecimale MINUSCOLO, 64 caratteri: il JS non la normalizza e il nativo la confronta come stringa.
    static func sha256Valido(_ impronta: String) -> Bool {
        guard impronta.utf8.count == 64 else { return false }
        return impronta.unicodeScalars.allSatisfy { ($0.value >= 0x30 && $0.value <= 0x39) || ($0.value >= 0x61 && $0.value <= 0x66) }
    }

    /// Un uuid nella forma del ponte: minuscolo (`UUID.uuidString` lo dà maiuscolo).
    static func uuidPerIlPonte(_ uuid: UUID) -> String {
        return uuid.uuidString.lowercased()
    }
}
