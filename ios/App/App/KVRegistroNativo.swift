import Foundation
import os

// ═══════════════════════════════════════════════════════════════════════════════════════════
//  KVRegistroNativo — i log dei caricamenti nativi (spec §8.1-8.2, compito I1)
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// Perché esiste: con l'app chiusa o a telefono bloccato il JavaScript non gira, ma il caricamento sì, e un caricamento che
// fallisce senza lasciare traccia è un caricamento rotto (AGENTS.md, «Logging obbligatorio»). Questo registro scrive i log del
// nativo sul disco, li tiene fino a che non si possono spedire a `POST /api/logs` (porta anonima del server, evento
// `caricamento-nativo`, salvato `client:caricamento-nativo`) e li spedisce a lotti.
//
// ─── IL TIPO GARANTISCE LA PRIVACY, NON LA DISCIPLINA ───────────────────────────────────────
// Le funzioni di log qui sotto (la regione «API di log») NON hanno nessun parametro `String`: i messaggi sono un elenco chiuso
// (`KVMessaggioLog`), le chiavi dei campi un elenco chiuso (`KVChiaveCampo`), i valori numeri, booleani o enumerati
// (`KVCampo`); un job si nomina con un `UUID`, un errore di sistema con dominio (da un elenco) e codice numerico. Non c'è un
// modo di scrivere il nome di un file, un percorso, un URL, un token o un hash: non compilerebbe. Dentro i log dei minori non
// passa niente che non abbiamo previsto (AGENTS.md, regola 8).
//
// ─── COME SI SPEDISCE ────────────────────────────────────────────────────────────────────────
//  · `POST` a `registro.url` con `x-user-id: <utenteId della voce>` e corpo `{eventi, piattaforma}`; lotti di AL PIÙ 20 eventi
//    dello stesso utente, AL PIÙ UNO OGNI 10 SECONDI (la route accetta 30 richieste al minuto per indirizzo);
//  · 2xx → il lotto esce dal registro; 429 → si aspetta `Retry-After` e si tiene; altro 4xx → il lotto è scartato e CONTATO (un
//    lotto che il server rifiuta oggi lo rifiuterebbe domani); 5xx o nessuna risposta → si tiene;
//  · il registro ha un TETTO di 200 eventi: oltre, si scartano i più vecchi e si contano, e al primo svuotamento utile un evento
//    `registro-nativo-scartati` dice quanti ne sono persi;
//  · il trasporto è iniettabile (`KVTrasportoRegistro`): quello vero usa una sessione `.ephemeral` (niente cookie, niente cache).
//
// ─── COME LO USA IL MOTORE (compito I2) ──────────────────────────────────────────────────────
//  · all'avvio: `KVRegistroNativo(cartella:trasporto:versioneApp:)` con `KVTrasportoRegistroRete()` e
//    `versioneApp(infoDictionary: Bundle.main.infoDictionary)`; poi la coda con `KVCodaCaricamenti(cartella:registro:)`, così la coda
//    scrive da sola `coda-nativa-corrotta` e i `video-nativo-fallito` dei token scaduti trovati dalla pulizia;
//  · a ogni `accodaVideo`: `impostaDestinazione(<registro.url>)` (rifiuta ciò che non è un host ammesso);
//  · a ogni transizione terminale, all'avvio e al ritorno in primo piano: `svuota(completamento:)`, e il completamento della
//    sessione in background si chiama DOPO quello del registro;
//  · lo svuotamento che CHIUDE il lavoro di una sessione in background è l'unico che passa `forza: true` (D1 del collaudo C1): salta i
//    10 secondi di cortesia (se l'avvio ne ha già consumato la finestra, i log di ciò che è appena successo aspetterebbero un'app che
//    il sistema sospende subito dopo) ma non un `Retry-After` del server; e se un lotto è ancora in volo, il suo completamento aspetta la
//    fine di quel lotto e di un ultimo tentativo.
//
// Questo file importa solo `Foundation` e `os`: si compila nell'harness `ios/prove/caricamenti/`.

// MARK: - I vocabolari del log

enum KVLivelloLog: String, Codable {
    case warn
    case error
}

/// I messaggi che il NATIVO può scrivere: l'elenco chiuso di §8.2 (`EVENTI_LOG_NATIVI` in `caricamenti-nativi-tipi.ts`, nello stesso
/// ordine) più `put-oltre-scadenza`, che §3 e §4.5 chiedono dopo l'esito di S0 e che §8.2 non elenca ancora. Un messaggio nuovo si
/// aggiunge qui, in TS, nella spec e nel PRD nello stesso lavoro, mai come testo libero.
enum KVMessaggioLog: String, CaseIterable {
    case videoNativoAccodato = "video-nativo-accodato"
    case videoNativoInviato = "video-nativo-inviato"
    case videoNativoRitento = "video-nativo-ritento"
    case videoNativoRinnovo = "video-nativo-rinnovo"
    case videoNativoAttesaRete = "video-nativo-attesa-rete"
    /// Solo Android (FGS/UIDT): iOS non la scrive, ma l'elenco dei messaggi è uno solo per i due sistemi.
    case videoNativoPausa = "video-nativo-pausa"
    case videoNativoRipresoDopoChiusura = "video-nativo-ripreso-dopo-chiusura"
    case videoNativoAnnullato = "video-nativo-annullato"
    case videoNativoFallito = "video-nativo-fallito"
    case mediaNativoPreparazioneFallita = "media-nativo-preparazione-fallita"
    case caricamentiNativiMotore = "caricamenti-nativi-motore"
    case codaNativaCorrotta = "coda-nativa-corrotta"
    case registroNativoScartati = "registro-nativo-scartati"
    case notificaLocaleNonAutorizzata = "notifica-locale-non-autorizzata"
    case putOltreScadenza = "put-oltre-scadenza"

    var livello: KVLivelloLog {
        switch self {
        case .videoNativoFallito, .mediaNativoPreparazioneFallita, .codaNativaCorrotta: return .error
        default: return .warn
        }
    }
}

/// Le chiavi di `campi`: l'unione delle colonne di §8.1-8.2 più `versione_app`, `durata_s` e `voci_scartate` (le voci fuori forma che la
/// lettura della coda ha scartato da sole, §4.6). Tutte rispettano la forma che la porta dei log accetta (`^[a-z][a-z0-9_]{0,31}$`).
enum KVChiaveCampo: String, CaseIterable {
    case esito
    case errorCode = "error_code"
    case operazione
    case tipo
    case ambiente
    case mime
    case versioneApp = "versione_app"
    case byte
    case ms
    case tentativi
    case rinnovi
    case inBackground = "in_background"
    case tentativo
    case attesaSecondi = "attesa_s"
    case byteInviati = "byte_inviati"
    case notifica
    case autorizzata
    case sdk
    case inCoda = "in_coda"
    case inInvio = "in_invio"
    case taskVivi = "task_vivi"
    case fileOrfani = "file_orfani"
    case scartati
    case durataSecondi = "durata_s"
    case vociScartate = "voci_scartate"
}

/// Il valore di un campo: un numero, un booleano, o un testo che viene SEMPRE da un elenco chiuso (mai da un dato dell'utente).
enum KVValoreCampo: Codable, Equatable {
    case numero(Int64)
    case booleano(Bool)
    case testo(String)

    init(from decoder: Decoder) throws {
        let contenitore = try decoder.singleValueContainer()
        if let booleano = try? contenitore.decode(Bool.self) {
            self = .booleano(booleano)
        } else if let numero = try? contenitore.decode(Int64.self) {
            self = .numero(numero)
        } else {
            self = .testo(try contenitore.decode(String.self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var contenitore = encoder.singleValueContainer()
        switch self {
        case .numero(let valore): try contenitore.encode(valore)
        case .booleano(let valore): try contenitore.encode(valore)
        case .testo(let valore): try contenitore.encode(valore)
        }
    }
}

/// Il motore che ha fatto il lavoro (campo `ambiente` e parte del messaggio `caricamenti-nativi-motore`): su iOS uno solo.
enum KVMotoreLog: String {
    case urlsession
}

enum KVOccasioneMotore: String {
    case avvio
    case rilancioBackground = "rilancio-background"
    case primoPiano = "primo-piano"
}

/// I MIME dei video che il selettore può consegnare. Il log non vede mai la stringa del sistema: un MIME fuori elenco vale `altro`.
enum KVMimeVideo: String {
    case mp4 = "video/mp4"
    case quicktime = "video/quicktime"
    case m4v = "video/x-m4v"
    case treGpp = "video/3gpp"
    case mpeg = "video/mpeg"
    case altro = "altro"

    /// Dalla stringa del sistema (anche col suffisso dei parametri, `video/mp4;codecs=…`): si guarda solo il tipo.
    init(mime: String) {
        let tipo = mime.split(separator: ";", maxSplits: 1, omittingEmptySubsequences: false).first
            .map { $0.trimmingCharacters(in: .whitespaces).lowercased() } ?? ""
        self = KVMimeVideo(rawValue: tipo) ?? .altro
    }
}

enum KVTipoMedia: String {
    case foto
    case video
}

/// Chi ha annullato (messaggio `video-nativo-annullato`).
enum KVDaChi: String {
    case utente
    case server
}

/// Perché la preparazione di un elemento è fallita per un motivo NOSTRO (non i rifiuti attesi, che non sono errori).
enum KVMotivoPreparazione: String {
    case copia = "COPIA"
    case impronta = "IMPRONTA"
    case riduzione = "RIDUZIONE"
    case miniatura = "MINIATURA"
    case interno = "INTERNO"
}

/// Il valore di `error_code`: il nome d'errore dello Storage (elenco chiuso) o un errore di sistema (dominio + codice).
enum KVErrorCode: Equatable {
    case storage(KVErroreStorage)
    case sistema(KVErroreSistema)

    var testo: String {
        switch self {
        case .storage(let errore): return errore.rawValue
        case .sistema(let errore): return errore.testo
        }
    }
}

/// Un campo di un evento, TIPATO: ogni caso porta un numero, un booleano o un enumerato. Non esiste un caso che accetti una stringa.
enum KVCampo: Equatable {
    case esito(KVEsitoInvio)
    case errorCode(KVErrorCode)
    case operazione(KVOperazione)
    case tipo(KVTipoMedia)
    case ambiente(KVMotoreLog)
    case mime(KVMimeVideo)
    case byte(Int64)
    case ms(Int64)
    case tentativi(Int)
    case rinnovi(Int)
    case inBackground(Bool)
    case tentativo(Int)
    case attesaSecondi(Int)
    case byteInviati(Int64)
    case notifica(Bool)
    case autorizzata(Bool)
    case inCoda(Int)
    case inInvio(Int)
    case taskVivi(Int)
    case fileOrfani(Int)
    case scartati(Int)
    case durataSecondi(Int)
    case vociScartate(Int)

    var coppia: (chiave: KVChiaveCampo, valore: KVValoreCampo) {
        switch self {
        case .esito(let v): return (.esito, .testo(v.rawValue))
        case .errorCode(let v): return (.errorCode, .testo(v.testo))
        case .operazione(let v): return (.operazione, .testo(v.rawValue))
        case .tipo(let v): return (.tipo, .testo(v.rawValue))
        case .ambiente(let v): return (.ambiente, .testo(v.rawValue))
        case .mime(let v): return (.mime, .testo(v.rawValue))
        case .byte(let v): return (.byte, .numero(v))
        case .ms(let v): return (.ms, .numero(v))
        case .tentativi(let v): return (.tentativi, .numero(Int64(v)))
        case .rinnovi(let v): return (.rinnovi, .numero(Int64(v)))
        case .inBackground(let v): return (.inBackground, .booleano(v))
        case .tentativo(let v): return (.tentativo, .numero(Int64(v)))
        case .attesaSecondi(let v): return (.attesaSecondi, .numero(Int64(v)))
        case .byteInviati(let v): return (.byteInviati, .numero(v))
        case .notifica(let v): return (.notifica, .booleano(v))
        case .autorizzata(let v): return (.autorizzata, .booleano(v))
        case .inCoda(let v): return (.inCoda, .numero(Int64(v)))
        case .inInvio(let v): return (.inInvio, .numero(Int64(v)))
        case .taskVivi(let v): return (.taskVivi, .numero(Int64(v)))
        case .fileOrfani(let v): return (.fileOrfani, .numero(Int64(v)))
        case .scartati(let v): return (.scartati, .numero(Int64(v)))
        case .durataSecondi(let v): return (.durataSecondi, .numero(Int64(v)))
        case .vociScartate(let v): return (.vociScartate, .numero(Int64(v)))
        }
    }
}

// MARK: - L'evento nel giornale

/// Un evento com'è nel giornale su disco. Alla porta dei log vanno solo `livello`, `evento`, `messaggio`, `stato` e `campi`;
/// `progressivo` e `utenteId` servono qui (ordine, `x-user-id`).
struct KVEventoRegistrato: Codable, Equatable {
    var progressivo: Int
    var livello: KVLivelloLog
    var messaggio: String
    /// Lo stato HTTP dello scambio a cui l'evento si riferisce (0 = nessuna risposta); assente se non c'è uno scambio.
    var stato: Int?
    var campi: [String: KVValoreCampo]
    var utenteId: UUID?
}

// MARK: - Il trasporto

struct KVRichiestaRegistro: Equatable {
    let url: URL
    let utenteId: UUID?
    let corpo: Data
}

enum KVRispostaRegistro: Equatable {
    case stato(Int, retryAfter: String?)
    case nessunaRisposta
}

/// Chi spedisce un lotto. Il vero è `KVTrasportoRegistroRete`; l'harness ne inietta uno finto.
protocol KVTrasportoRegistro: AnyObject {
    func invia(_ richiesta: KVRichiestaRegistro, completamento: @escaping (KVRispostaRegistro) -> Void)
}

/// Il trasporto vero: una sessione `.ephemeral` (nessun cookie, nessuna cache, nessuna credenziale condivisa) che fa la POST e riporta lo
/// stato HTTP e `Retry-After`. Il corpo della risposta non si legge. Si può passare una configurazione (la usa l'harness per
/// iniettare un finto sul protocollo).
final class KVTrasportoRegistroRete: KVTrasportoRegistro {
    private let sessione: URLSession
    private let diagnostica = Logger(subsystem: Bundle.main.bundleIdentifier ?? "it.kidville.app", category: "caricamenti-registro")

    init(configurazione: URLSessionConfiguration? = nil) {
        let configurazione = configurazione ?? URLSessionConfiguration.ephemeral
        configurazione.httpShouldSetCookies = false
        configurazione.httpCookieStorage = nil
        configurazione.urlCache = nil
        configurazione.requestCachePolicy = .reloadIgnoringLocalCacheData
        configurazione.timeoutIntervalForRequest = 30
        configurazione.timeoutIntervalForResource = 60
        self.sessione = URLSession(configuration: configurazione)
    }

    func invia(_ richiesta: KVRichiestaRegistro, completamento: @escaping (KVRispostaRegistro) -> Void) {
        var chiamata = URLRequest(url: richiesta.url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        chiamata.httpMethod = "POST"
        chiamata.setValue("application/json", forHTTPHeaderField: "content-type")
        if let utente = richiesta.utenteId {
            chiamata.setValue(KVPoliticaCaricamento.uuidPerIlPonte(utente), forHTTPHeaderField: "x-user-id")
        }
        chiamata.httpBody = richiesta.corpo
        let diagnostica = self.diagnostica
        sessione.dataTask(with: chiamata) { _, risposta, errore in
            guard let http = risposta as? HTTPURLResponse else {
                if let errore = errore {
                    let e = KVErroreSistema(errore)
                    diagnostica.info("invio del registro senza risposta: dominio \(e.dominio.rawValue, privacy: .public) codice \(e.codice, privacy: .public)")
                }
                completamento(.nessunaRisposta)
                return
            }
            completamento(.stato(http.statusCode, retryAfter: http.value(forHTTPHeaderField: "Retry-After")))
        }.resume()
    }
}

/// Com'è andata la richiesta di svuotare il registro.
enum KVEsitoSvuotamento: Equatable {
    /// Niente da spedire (registro vuoto o destinazione ancora ignota).
    case nulla
    /// Meno di 10 secondi dall'ultimo invio (o `Retry-After` in corso): riprovare fra `attesa` secondi. Con `forza` restano solo i secondi che
    /// il server ha chiesto con un 429.
    case troppoPresto(attesa: TimeInterval)
    /// Un invio è già in volo. Con `forza` il completamento non scatta subito: aspetta la fine di quel lotto (e di un ultimo tentativo).
    case giaInCorso
    /// Un lotto di `eventi` eventi è partito.
    case spedito(eventi: Int)
}

/// Una fotografia del registro (per l'harness e per la diagnostica).
struct KVStatoRegistro: Equatable {
    var eventi: [KVEventoRegistrato]
    var scartati: Int
    var destinazione: URL?
    var ultimoUtente: UUID?
}

// MARK: - Il registro

final class KVRegistroNativo {

    static let versioneFile = 1
    static let nomeFile = "registro.json"
    /// Il tetto del giornale: oltre, si scartano i più vecchi e si contano.
    static let tettoEventi = 200
    /// Eventi per lotto: il massimo che la porta dei log accetta.
    static let dimensioneMassimaLotto = 20
    /// Fra due invii passano almeno 10 secondi.
    static let intervalloMinimoTraInvii: TimeInterval = 10
    /// Il nome dell'evento sul server (colonna `evento` di `app_log`, dove si legge come `client:caricamento-nativo`): è lo stesso per il nativo e
    /// per il JavaScript della pipeline nativa, così le due metà di un video si leggono con una query sola.
    static let nomeEventoSulServer = "caricamento-nativo"
    /// La piattaforma dichiarata nel corpo (la porta dei log accetta `web`, `ios`, `android`).
    static let piattaforma = "ios"

    private let cartella: URL
    private let versioneApp: String?
    private let ambiente: KVAmbienteBuild
    private let orologio: () -> Date
    private let trasporto: KVTrasportoRegistro
    private let serratura = NSLock()
    private var eventi: [KVEventoRegistrato] = []
    private var scartatiInterni = 0
    private var prossimoProgressivo = 1
    private var destinazione: URL?
    private var ultimoUtente: UUID?
    private var notificaNonAutorizzataScritta = false
    /// `true` se il file del giornale c'è ma non si è riusciti a leggerlo (dati protetti non ancora disponibili, permessi): NON è rotto, e
    /// scriverci sopra farebbe sparire gli eventi che ancora non sono partiti. Finché è `true` il giornale vive solo in memoria e `salva()`
    /// non scrive; `riprovaLettura()` lo rilegge e fonde.
    private var illeggibileAdesso = false
    private var invioInCorso = false
    /// Non si spedisce prima di questo istante: i 10 secondi dall'ultimo invio, e (se più lungo) il `Retry-After` di un 429.
    private var nonPrimaDi = Date.distantPast
    /// Il solo pezzo di `nonPrimaDi` che viene dal SERVER (`Retry-After` di un 429). I 10 secondi sono una nostra cortesia verso la porta dei log, e lo
    /// svuotamento finale di una sessione in background (`forza`) li salta; ciò che il server ha chiesto di aspettare no.
    private var nonPrimaDiPerIlServer = Date.distantPast
    /// I completamenti di chi ha chiesto lo svuotamento FINALE (`forza`) mentre un lotto era in volo: alla fine di quel lotto si prova a spedire ciò
    /// che è nato nel frattempo, e solo dopo scattano. Si tengono sotto la serratura.
    private var finaliInAttesa: [() -> Void] = []
    private let diagnostica = Logger(subsystem: Bundle.main.bundleIdentifier ?? "it.kidville.app", category: "caricamenti-registro")

    /// `versioneApp` è `<versione>+<build>` (`1.2+6`): se non ha questa forma il campo `versione_app` non parte (il server lo
    /// redigerebbe). Si ricava da `Info.plist` con `versioneApp(infoDictionary:)`.
    init(cartella: URL, trasporto: KVTrasportoRegistro, versioneApp: String?, ambiente: KVAmbienteBuild = .corrente,
         orologio: @escaping () -> Date = { Date() }) {
        self.cartella = cartella
        self.trasporto = trasporto
        self.versioneApp = versioneApp.flatMap { KVRegistroNativo.formaVersioneAppValida($0) ? $0 : nil }
        self.ambiente = ambiente
        self.orologio = orologio
        preparaCartella()
        carica()
    }

    private var urlFile: URL { cartella.appendingPathComponent(Self.nomeFile) }

    /// La cartella del giornale è quella della coda (`Application Support/KidvilleCaricamenti`): se il registro parte per primo la crea lui, già
    /// fuori dal backup, come farebbe la coda.
    private func preparaCartella() {
        do {
            try FileManager.default.createDirectory(at: cartella, withIntermediateDirectories: true, attributes: nil)
            var valori = URLResourceValues()
            valori.isExcludedFromBackup = true
            var destinazione = cartella
            try destinazione.setResourceValues(valori)
        } catch {
            segnala("cartella del registro non preparata", error)
        }
    }

    // MARK: La versione dell'app

    /// `<CFBundleShortVersionString>+<CFBundleVersion>` come `1.2+6`, o `nil` se mancano o non hanno la forma che il server lascia in chiaro
    /// (`^\d{1,4}(\.\d{1,4}){0,3}\+\d{1,9}$`).
    static func versioneApp(infoDictionary: [String: Any]?) -> String? {
        guard let versione = infoDictionary?["CFBundleShortVersionString"] as? String,
              let build = infoDictionary?["CFBundleVersion"] as? String else { return nil }
        let composta = "\(versione.trimmingCharacters(in: .whitespaces))+\(build.trimmingCharacters(in: .whitespaces))"
        return formaVersioneAppValida(composta) ? composta : nil
    }

    static func formaVersioneAppValida(_ testo: String) -> Bool {
        return testo.range(of: "^[0-9]{1,4}(\\.[0-9]{1,4}){0,3}\\+[0-9]{1,9}$", options: .regularExpression) != nil
    }

    // MARK: Destinazione

    /// L'indirizzo dei log di produzione (la porta anonima `/api/logs`).
    static let destinazioneProduzione = "https://app.kidville.it/api/logs"

    /// All'avvio, in Release: se non si conosce ancora nessuna destinazione si usa quella di produzione, così i log nati PRIMA del primo
    /// `accodaVideo` (`media-nativo-preparazione-fallita` su un'installazione nuova, `coda-nativa-corrotta`, `caricamenti-nativi-motore`) partono
    /// lo stesso. Non sostituisce mai una destinazione già nota, e in Debug non fa niente: lì la destinazione è quella del banco di prova
    /// (`http://localhost:…`), che arriva con `accodaVideo`.
    @discardableResult
    func impostaDestinazionePredefinita() -> Bool {
        guard ambiente == .release else { return false }
        serratura.lock()
        let giaNota = destinazione != nil
        serratura.unlock()
        if giaNota { return false }
        return impostaDestinazione(Self.destinazioneProduzione)
    }

    /// L'indirizzo a cui spedire (`registro.url` di `accodaVideo`): vale solo se passa la politica degli host (`https://app.kidville.it` in
    /// Release; in Debug anche gli host di sviluppo). Si ricorda anche dopo un riavvio.
    @discardableResult
    func impostaDestinazione(_ testo: String) -> Bool {
        guard let url = KVPoliticaCaricamento.indirizzoAmmesso(testo, uso: .registro, ambiente: ambiente) else { return false }
        serratura.lock(); defer { serratura.unlock() }
        if destinazione != url {
            destinazione = url
            _ = salva()
        }
        return true
    }

    // MARK: - API di log (solo enumerati, numeri, booleani e UUID)

    /// `accodaVideo` riuscito.
    func registraAccodato(job: UUID, utente: UUID, byte: Int64, mime: KVMimeVideo, motore: KVMotoreLog) {
        accoda(.videoNativoAccodato, job: job, suffisso: nil, utente: utente, stato: nil,
               campi: [.byte(byte), .mime(mime), .ambiente(motore)])
    }

    /// PUT 2xx, oppure rinnovo `arrivato`.
    func registraInviato(job: UUID, utente: UUID, byte: Int64, ms: Int64, tentativi: Int, rinnovi: Int,
                         esito: KVEsitoInvio, inBackground: Bool) {
        accoda(.videoNativoInviato, job: job, suffisso: nil, utente: utente, stato: nil,
               campi: [.byte(byte), .ms(ms), .tentativi(tentativi), .rinnovi(rinnovi), .esito(esito), .inBackground(inBackground)])
    }

    /// Un transitorio. I ritentativi si loggano ai tentativi 1, 2, 4, 8, 16, …: gli altri non lasciano riga.
    func registraRitento(job: UUID, utente: UUID, codice: KVCodiceCaricamento, statoHTTP: Int, tentativo: Int,
                         attesaSecondi: Int, byteInviati: Int64) {
        guard KVPoliticaCaricamento.tentativoDaLoggare(tentativo) else { return }
        accoda(.videoNativoRitento, job: job, suffisso: codice.rawValue, utente: utente, stato: statoHTTP,
               campi: [.tentativo(tentativo), .attesaSecondi(attesaSecondi), .byteInviati(byteInviati)])
    }

    /// Ogni chiamata di rinnovo. `statoHTTP` è quello del rinnovo (0 = nessuna risposta); `errorCode` il nome d'errore della PUT che l'ha
    /// causato (se c'è stata una PUT rifiutata).
    func registraRinnovo(job: UUID, utente: UUID, esito: KVEsitoRinnovoLog, statoHTTP: Int, rinnovi: Int, errorCode: KVErrorCode?) {
        var campi: [KVCampo] = [.rinnovi(rinnovi)]
        if let errorCode = errorCode { campi.append(.errorCode(errorCode)) }
        accoda(.videoNativoRinnovo, job: job, suffisso: esito.rawValue, utente: utente, stato: statoHTTP, campi: campi)
    }

    /// Un `InvalidJWT` arrivato dopo il trasferimento: la firma è scaduta mentre i byte salivano (S0).
    func registraPutOltreScadenza(job: UUID, utente: UUID, durataSecondi: Int, statoHTTP: Int) {
        accoda(.putOltreScadenza, job: job, suffisso: nil, utente: utente, stato: statoHTTP, campi: [.durataSecondi(durataSecondi)])
    }

    /// iOS: la notifica locale «in attesa di rete» è partita (o non ha potuto partire).
    func registraAttesaRete(job: UUID, utente: UUID, notifica: Bool, autorizzata: Bool) {
        accoda(.videoNativoAttesaRete, job: job, suffisso: nil, utente: utente, stato: nil,
               campi: [.notifica(notifica), .autorizzata(autorizzata)])
    }

    /// Un task ricreato dopo la chiusura forzata dal multitasking.
    func registraRipresoDopoChiusura(job: UUID, utente: UUID, byteInviati: Int64) {
        accoda(.videoNativoRipresoDopoChiusura, job: job, suffisso: nil, utente: utente, stato: nil, campi: [.byteInviati(byteInviati)])
    }

    func registraAnnullato(job: UUID, utente: UUID, da: KVDaChi, byteInviati: Int64) {
        accoda(.videoNativoAnnullato, job: job, suffisso: da.rawValue, utente: utente, stato: nil, campi: [.byteInviati(byteInviati)])
    }

    /// Lo stato terminale `fallito`. `statoHTTP` è l'ultimo scambio, se c'è stato.
    func registraFallito(job: UUID, utente: UUID, codice: KVCodiceCaricamento, operazione: KVOperazione,
                         tentativi: Int, rinnovi: Int, statoHTTP: Int?) {
        accoda(.videoNativoFallito, job: job, suffisso: codice.rawValue, utente: utente, stato: statoHTTP,
               campi: [.operazione(operazione), .tentativi(tentativi), .rinnovi(rinnovi)])
    }

    /// La preparazione di un elemento è fallita per un motivo nostro (copia, impronta, riduzione): non i rifiuti attesi.
    func registraPreparazioneFallita(motivo: KVMotivoPreparazione, tipo: KVTipoMedia, errorCode: KVErrorCode?) {
        var campi: [KVCampo] = [.tipo(tipo)]
        if let errorCode = errorCode { campi.append(.errorCode(errorCode)) }
        accoda(.mediaNativoPreparazioneFallita, job: nil, suffisso: motivo.rawValue, utente: nil, stato: nil, campi: campi)
    }

    /// Il motore parte con voci vive.
    func registraMotore(motore: KVMotoreLog, occasione: KVOccasioneMotore, inCoda: Int, inInvio: Int, taskVivi: Int) {
        accoda(.caricamentiNativiMotore, job: nil, suffisso: "\(motore.rawValue) \(occasione.rawValue)", utente: nil, stato: nil,
               campi: [.inCoda(inCoda), .inInvio(inInvio), .taskVivi(taskVivi)])
    }

    /// `coda.json` illeggibile: rinominato, coda nuova (`fileOrfani` = i file di video che nessuna voce nomina più). Oppure, in un file per il
    /// resto buono, `vociScartate` voci fuori forma tolte da sole (§4.6): il campo `voci_scartate` c'è solo se ce n'è almeno una.
    func registraCodaCorrotta(fileOrfani: Int, vociScartate: Int = 0) {
        var campi: [KVCampo] = [.fileOrfani(fileOrfani)]
        if vociScartate > 0 { campi.append(.vociScartate(vociScartate)) }
        accoda(.codaNativaCorrotta, job: nil, suffisso: nil, utente: nil, stato: nil, campi: campi)
    }

    /// Le notifiche non sono autorizzate: UNA riga per installazione (si ricorda anche dopo un riavvio).
    func registraNotificaNonAutorizzata() {
        serratura.lock()
        let giaScritta = notificaNonAutorizzataScritta
        notificaNonAutorizzataScritta = true
        serratura.unlock()
        if giaScritta { return }
        accoda(.notificaLocaleNonAutorizzata, job: nil, suffisso: nil, utente: nil, stato: nil, campi: [])
    }

    // MARK: - Fine API di log

    // MARK: Il giornale

    /// Aggiunge un evento. Mai lancia, mai fa fallire chi la chiama: il logger non deve poter rompere l'app.
    private func accoda(_ messaggio: KVMessaggioLog, job: UUID?, suffisso: String?, utente: UUID?, stato: Int?, campi: [KVCampo]) {
        var mappa: [String: KVValoreCampo] = [:]
        for campo in campi {
            let coppia = campo.coppia
            mappa[coppia.chiave.rawValue] = coppia.valore
        }
        if let versione = versioneApp { mappa[KVChiaveCampo.versioneApp.rawValue] = .testo(versione) }

        var testo = messaggio.rawValue
        if let job = job { testo += ": job=\(KVPoliticaCaricamento.uuidPerIlPonte(job))" }
        if let suffisso = suffisso { testo += (job == nil ? ": " : " ") + suffisso }

        serratura.lock(); defer { serratura.unlock() }
        let statoAmmesso = stato.flatMap { (0...599).contains($0) ? $0 : nil }
        aggiungiEvento(KVEventoRegistrato(progressivo: prossimoProgressivo, livello: messaggio.livello, messaggio: testo,
                                          stato: statoAmmesso, campi: mappa, utenteId: utente))
        if let utente = utente { ultimoUtente = utente }
        _ = salva()
    }

    /// Chi lo chiama tiene la serratura. Oltre il tetto si scartano i più vecchi e si contano.
    private func aggiungiEvento(_ evento: KVEventoRegistrato) {
        prossimoProgressivo += 1
        eventi.append(evento)
        let eccesso = eventi.count - Self.tettoEventi
        if eccesso > 0 {
            eventi.removeFirst(eccesso)
            scartatiInterni += eccesso
        }
    }

    /// Una fotografia, per l'harness e la diagnostica.
    func stato() -> KVStatoRegistro {
        serratura.lock(); defer { serratura.unlock() }
        return KVStatoRegistro(eventi: eventi, scartati: scartatiInterni, destinazione: destinazione, ultimoUtente: ultimoUtente)
    }

    // MARK: Lo svuotamento

    private struct EventoSullaRete: Encodable {
        let livello: String
        let evento: String
        let messaggio: String
        let stato: Int?
        let campi: [String: KVValoreCampo]?
    }

    private struct CorpoSullaRete: Encodable {
        let eventi: [EventoSullaRete]
        let piattaforma: String
    }

    /// Spedisce UN lotto (al più 20 eventi dello stesso utente), se non ne è partito uno meno di 10 secondi fa e se si sa dove spedire. Si
    /// chiama a ogni transizione terminale, all'avvio e al ritorno in primo piano. `completamento` viene chiamato quando l'invio è finito
    /// (o subito, se non parte niente): il motore lo usa per chiudere il lavoro in background solo dopo.
    ///
    /// `forza` è dello svuotamento che CHIUDE il lavoro di una sessione in background, e di nessun altro (D1 del collaudo C1): il sistema sospende
    /// l'app subito dopo il completamento, quindi ciò che non è partito prima non parte per minuti (nella prova, 4'22" dopo, alla riapertura).
    ///  · ignora i 10 secondi di cortesia (l'avvio dell'app ne ha già consumato la finestra, e i log dell'esito arrivano subito dopo), ma NON il
    ///    `Retry-After` di un 429: quello è ciò che il server ha chiesto, non una nostra cortesia;
    ///  · se un lotto è già in volo il completamento NON scatta subito: alla fine di quel lotto si prova a spedire ciò che è nato nel frattempo (un
    ///    lotto composto prima non lo contiene) e solo dopo scatta. Un lotto che non risponde lo chiude il tempo massimo del trasporto, e la guardia
    ///    di tempo della sessione resta sopra a tutto.
    @discardableResult
    func svuota(adesso: Date? = nil, forza: Bool = false, completamento: (() -> Void)? = nil) -> KVEsitoSvuotamento {
        let ora = adesso ?? orologio()
        riprovaLettura()
        serratura.lock()
        if invioInCorso {
            if forza, let completamento = completamento {
                finaliInAttesa.append(completamento)
                serratura.unlock()
                return .giaInCorso
            }
            serratura.unlock()
            completamento?()
            return .giaInCorso
        }
        let nonPrima = forza ? nonPrimaDiPerIlServer : nonPrimaDi
        if ora < nonPrima {
            let attesa = nonPrima.timeIntervalSince(ora)
            serratura.unlock()
            completamento?()
            return .troppoPresto(attesa: attesa)
        }
        guard let url = destinazione else {
            serratura.unlock()
            completamento?()
            return .nulla
        }
        if scartatiInterni > 0 && eventi.count < Self.tettoEventi {
            // Gli eventi persi si dichiarano UNA volta, con quanti sono: «nessun log» non deve poter voler dire «ne ho perso cento». Se il
            // giornale è ancora pieno si aspetta che un invio faccia posto: scrivere l'evento ne farebbe scartare un altro, e il conto non
            // finirebbe mai.
            let persi = scartatiInterni
            scartatiInterni = 0
            aggiungiEvento(KVEventoRegistrato(progressivo: prossimoProgressivo, livello: KVMessaggioLog.registroNativoScartati.livello,
                                              messaggio: KVMessaggioLog.registroNativoScartati.rawValue, stato: nil,
                                              campi: campiDi([.scartati(persi)]), utenteId: nil))
        }
        guard let primo = eventi.first else {
            serratura.unlock()
            completamento?()
            return .nulla
        }
        let utente = primo.utenteId ?? ultimoUtente
        let lotto = Array(eventi.filter { ($0.utenteId ?? ultimoUtente) == utente }.prefix(Self.dimensioneMassimaLotto))
        let progressivi = Set(lotto.map { $0.progressivo })

        let corpo = CorpoSullaRete(
            eventi: lotto.map {
                EventoSullaRete(livello: $0.livello.rawValue, evento: Self.nomeEventoSulServer, messaggio: $0.messaggio,
                                stato: $0.stato, campi: $0.campi.isEmpty ? nil : $0.campi)
            },
            piattaforma: Self.piattaforma
        )
        let codificatore = JSONEncoder()
        codificatore.outputFormatting = [.sortedKeys]
        let dati: Data
        do {
            dati = try codificatore.encode(corpo)
        } catch {
            segnala("corpo del registro non codificato", error)
            serratura.unlock()
            completamento?()
            return .nulla
        }
        invioInCorso = true
        nonPrimaDi = ora.addingTimeInterval(Self.intervalloMinimoTraInvii)
        _ = salva()
        serratura.unlock()

        trasporto.invia(KVRichiestaRegistro(url: url, utenteId: utente, corpo: dati)) { [weak self] risposta in
            self?.concludi(progressivi: progressivi, risposta: risposta)
            completamento?()
            self?.riprendiGliSvuotamentiFinali()
        }
        return .spedito(eventi: lotto.count)
    }

    /// Alla fine di un lotto: chi aveva chiesto lo svuotamento FINALE mentre quel lotto era in volo riprova UNA volta (con `forza`) a spedire ciò che nel
    /// frattempo è nato, e il suo completamento scatta quando anche quel tentativo è finito (subito, se non c'è più niente da spedire).
    private func riprendiGliSvuotamentiFinali() {
        serratura.lock()
        let attesi = finaliInAttesa
        finaliInAttesa = []
        serratura.unlock()
        guard !attesi.isEmpty else { return }
        svuota(forza: true, completamento: { attesi.forEach { $0() } })
    }

    private func campiDi(_ campi: [KVCampo]) -> [String: KVValoreCampo] {
        var mappa: [String: KVValoreCampo] = [:]
        for campo in campi {
            let coppia = campo.coppia
            mappa[coppia.chiave.rawValue] = coppia.valore
        }
        if let versione = versioneApp { mappa[KVChiaveCampo.versioneApp.rawValue] = .testo(versione) }
        return mappa
    }

    private func concludi(progressivi: Set<Int>, risposta: KVRispostaRegistro) {
        serratura.lock(); defer { serratura.unlock() }
        invioInCorso = false
        let ora = orologio()
        switch risposta {
        case .stato(let codice, let retryAfter):
            if (200...299).contains(codice) {
                eventi.removeAll { progressivi.contains($0.progressivo) }
            } else if codice == 429 {
                // Si tiene tutto e si aspetta quanto dice il server (al più un'ora).
                let secondi = KVPoliticaCaricamento.secondiRetryAfter(retryAfter, adesso: ora) ?? 0
                let attesa = min(secondi, KVPoliticaCaricamento.tettoRetryAfterSecondi)
                nonPrimaDi = max(nonPrimaDi, ora.addingTimeInterval(attesa))
                nonPrimaDiPerIlServer = max(nonPrimaDiPerIlServer, ora.addingTimeInterval(attesa))
            } else if (400...499).contains(codice) {
                // Un lotto che il server rifiuta oggi lo rifiuterebbe domani: si butta, e si conta.
                let prima = eventi.count
                eventi.removeAll { progressivi.contains($0.progressivo) }
                scartatiInterni += prima - eventi.count
            }
            // 5xx e altro: si tiene.
        case .nessunaRisposta:
            break
        }
        _ = salva()
    }

    // MARK: Persistenza

    private struct FileRegistro: Codable {
        var versione: Int
        var eventi: [KVEventoRegistrato]
        var scartati: Int
        var prossimoProgressivo: Int
        var destinazione: URL?
        var ultimoUtente: UUID?
        var notificaNonAutorizzataScritta: Bool
    }

    /// Com'è andata la lettura del file del giornale.
    private enum EsitoLettura {
        case assente
        case letto(FileRegistro)
        /// Il file si legge ma non è un giornale che sappiamo leggere (JSON rotto, versione sconosciuta): è una perdita.
        case rotto
        /// Il file c'è ma non si riesce a leggerlo adesso (dati protetti non ancora disponibili, permessi): NON è una perdita.
        case nonLeggibileAdesso
    }

    /// Chi la chiama tiene la serratura.
    private func leggiFile() -> EsitoLettura {
        guard FileManager.default.fileExists(atPath: urlFile.path) else { return .assente }
        let dati: Data
        do {
            dati = try Data(contentsOf: urlFile)
        } catch {
            segnala("lettura del registro fallita", error)
            let errore = KVErroreSistema(error)
            // Sparito fra il controllo e la lettura: è come se non ci fosse.
            if errore.dominio == .cocoa && errore.codice == NSFileReadNoSuchFileError { return .assente }
            return .nonLeggibileAdesso
        }
        guard let file = try? JSONDecoder().decode(FileRegistro.self, from: dati), file.versione == Self.versioneFile else {
            diagnostica.error("registro illeggibile o di versione sconosciuta: si riparte vuoti")
            return .rotto
        }
        return .letto(file)
    }

    /// Legge il giornale (nell'`init`). Un file ROTTO non ferma niente: si riparte vuoti e si dichiara UN evento perso, perché non sappiamo
    /// quanti ce n'erano. Un file che c'è ma NON SI RIESCE A LEGGERE adesso non è rotto: non si tocca (`illeggibileAdesso`) e lo si rilegge dopo.
    private func carica() {
        serratura.lock(); defer { serratura.unlock() }
        switch leggiFile() {
        case .assente:
            return
        case .rotto:
            scartatiInterni = 1
        case .nonLeggibileAdesso:
            illeggibileAdesso = true
        case .letto(let file):
            eventi = file.eventi
            scartatiInterni = file.scartati
            prossimoProgressivo = max(file.prossimoProgressivo, (file.eventi.map { $0.progressivo }.max() ?? 0) + 1)
            destinazione = file.destinazione
            ultimoUtente = file.ultimoUtente
            notificaNonAutorizzataScritta = file.notificaNonAutorizzataScritta
        }
    }

    /// Se all'avvio il file non si leggeva, riprova: appena si legge fonde ciò che c'era su disco (più vecchio) con ciò che nel frattempo è
    /// nato in memoria, e da lì il giornale torna a scriversi. Restituisce `true` se il giornale è scrivibile (lo era già, o lo è diventato).
    /// Si chiama a ogni `svuota` e quando tornano i dati protetti. Se il file, appena letto, risulta ROTTO si riparte da quello che c'è in
    /// memoria dichiarando una perdita.
    @discardableResult
    func riprovaLettura() -> Bool {
        serratura.lock(); defer { serratura.unlock() }
        guard illeggibileAdesso else { return true }
        switch leggiFile() {
        case .nonLeggibileAdesso:
            return false
        case .assente:
            break
        case .rotto:
            scartatiInterni += 1
        case .letto(let file):
            fondi(file)
        }
        illeggibileAdesso = false
        _ = salva()
        return true
    }

    /// Il giornale su disco (più vecchio) davanti, gli eventi nati in memoria dietro, con progressivi nuovi e tutti diversi; il tetto vale anche qui.
    /// Chi la chiama tiene la serratura.
    private func fondi(_ file: FileRegistro) {
        let primoLibero = max(file.prossimoProgressivo, (file.eventi.map { $0.progressivo }.max() ?? 0) + 1)
        var inMemoria = eventi
        for indice in inMemoria.indices { inMemoria[indice].progressivo = primoLibero + indice }
        eventi = file.eventi + inMemoria
        prossimoProgressivo = primoLibero + inMemoria.count
        scartatiInterni += file.scartati
        let eccesso = eventi.count - Self.tettoEventi
        if eccesso > 0 {
            eventi.removeFirst(eccesso)
            scartatiInterni += eccesso
        }
        if destinazione == nil { destinazione = file.destinazione }
        if ultimoUtente == nil { ultimoUtente = file.ultimoUtente }
        notificaNonAutorizzataScritta = notificaNonAutorizzataScritta || file.notificaNonAutorizzataScritta
    }

    /// Chi la chiama tiene la serratura. Non scrive mai finché il file esistente non si è potuto leggere (`illeggibileAdesso`).
    private func salva() -> Bool {
        guard !illeggibileAdesso else { return false }
        let file = FileRegistro(versione: Self.versioneFile, eventi: eventi, scartati: scartatiInterni,
                                prossimoProgressivo: prossimoProgressivo, destinazione: destinazione,
                                ultimoUtente: ultimoUtente, notificaNonAutorizzataScritta: notificaNonAutorizzataScritta)
        let codificatore = JSONEncoder()
        codificatore.outputFormatting = [.sortedKeys]
        do {
            try FileManager.default.createDirectory(at: cartella, withIntermediateDirectories: true, attributes: nil)
            let dati = try codificatore.encode(file)
            try dati.write(to: urlFile, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            return true
        } catch {
            segnala("scrittura del registro fallita", error)
            return false
        }
    }

    /// Un guasto del registro lascia un segno nel log di SISTEMA (dominio e codice numerico, mai il testo dell'errore): il registro non può
    /// scrivere nel registro per dire che non riesce a scrivere.
    private func segnala(_ cosa: StaticString, _ errore: Error) {
        let e = KVErroreSistema(errore)
        diagnostica.error("\(cosa, privacy: .public): dominio \(e.dominio.rawValue, privacy: .public) codice \(e.codice, privacy: .public)")
    }
}
