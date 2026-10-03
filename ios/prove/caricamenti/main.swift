// Prova di COMPORTAMENTO dei caricamenti nativi iOS (PR 3 «app 1.2», compiti I1 e I2).
//
// Perché esiste: Swift non gira in vitest, e la CI non compila il nativo. Una tabella di decisione sbagliata
// (un rinnovo che parte a 11 minuti invece che a 10, un 413 letto come transitorio, un host di sviluppo ammesso
// in Release) o un motore che dimentica di cancellare i segreti non si vedono da nessun grep: si vedono compilando
// ed eseguendo i file di produzione per davvero.
//
// Qui NON si ricopia niente: si compilano gli stessi sette file che finiscono nell'app (`KVPoliticaCaricamento`,
// `KVCodaCaricamenti`, `KVRegistroNativo`, `KVSegretiCaricamenti`, `KVRinnovoFirma`, `KVNotificaAttesa`,
// `KVMotoreCaricamenti`) e si guardano le CONSEGUENZE: la decisione presa per ogni riga di §4.4 e §4.5, il file che
// resta (o no) sul disco, il corpo che parte verso `/api/logs`, il task che il trasporto riceve, il token che
// finisce (o non finisce) nel Portachiavi. Ogni sezione dichiara la riga di spec che prova. I valori attesi sono
// scritti qui a mano, dalla spec, e non calcolati dal codice che si prova.
//
// File: `main.swift` (questo: la parte pura, la coda, il registro, i sorgenti), `fakes.swift` (le finte con cui si
// pilota il motore), `prove-motore.swift` (il motore a comando, e a sequenze casuali di eventi), `prove-componenti.swift`
// (Portachiavi, rinnovo, notifica, trasporto, sessione in background). `prove-simulatore.swift` NON è di questo giro:
// prova `KVPortachiavi` sul Portachiavi vero dentro un simulatore (`esegui-simulatore.sh`).
//
// Si esegue con `sh ios/prove/caricamenti/esegui.sh` (due volte: senza e con `-D DEBUG`).
//
// Argomenti: <release|debug> <cartella dei file di produzione> <caricamenti-nativi-tipi.ts> <server.mjs di S2>.

import Foundation

// Un'uscita a righe: se un processo cade a metà (un `Index out of range` di una prova), ciò che è già stato detto è già uscito.
setvbuf(stdout, nil, _IOLBF, 0)

// MARK: - Piccolo cerimoniale di prova

var fallimenti: [String] = []
var superate = 0
var superateNellaSezione = 0
var sezioneCorrente = ""
let verbosa = ProcessInfo.processInfo.environment["KV_PROVA_VERBOSA"] == "1"

func chiudiSezione() {
    guard !sezioneCorrente.isEmpty else { return }
    if !verbosa { print("       \(superateNellaSezione) verifiche riuscite") }
}

func sezione(_ titolo: String) {
    chiudiSezione()
    sezioneCorrente = titolo
    superateNellaSezione = 0
    print("▸ \(titolo)")
}

func verifica(_ descrizione: String, _ condizione: @autoclosure () -> Bool, _ dettaglio: @autoclosure () -> String = "") {
    if condizione() {
        superate += 1
        superateNellaSezione += 1
        if verbosa { print("  ok   \(descrizione)") }
    } else {
        fallimenti.append("\(sezioneCorrente): \(descrizione)")
        let extra = dettaglio()
        print("  FAIL \(descrizione)" + (extra.isEmpty ? "" : "\n         \(extra)"))
    }
}

func verificaUguali<T: Equatable>(_ descrizione: String, _ ottenuto: @autoclosure () -> T, _ atteso: T) {
    let valore = ottenuto()
    verifica(descrizione, valore == atteso, "ottenuto: \(valore)\n         atteso:   \(atteso)")
}

/// Il testo di un valore, per confrontare insieme valori di TIPI DIVERSI: gli `Optional` si scartano a ogni livello (`nil` è «nil»), gli elenchi si
/// descrivono elemento per elemento, un istante si scrive col suo numero esatto di secondi (la `description` di `Date` ne taglia i decimali).
func testoDi(_ valore: Any?) -> String {
    guard let v = valore else { return "nil" }
    let specchio = Mirror(reflecting: v)
    if specchio.displayStyle == .optional { return specchio.children.first.map { testoDi($0.value) } ?? "nil" }
    if let data = v as? Date { return "data(\(data.timeIntervalSince1970))" }
    if specchio.displayStyle == .collection { return "[" + specchio.children.map { testoDi($0.value) }.joined(separator: ", ") + "]" }
    return "\(v)"
}

/// Come `verificaUguali`, ma su un ELENCO di valori che possono avere tipi diversi (uno stato, un contatore, un istante…): ciò che sta in
/// posizione `i` deve essere uguale a ciò che ci si aspetta in posizione `i`. Un passo di scenario si legge in una riga sola.
func verificaTutto(_ descrizione: String, _ ottenuti: @autoclosure () -> [Any?], _ attesi: [Any?]) {
    let a = ottenuti().map { testoDi($0) }
    let b = attesi.map { testoDi($0) }
    verifica(descrizione, a == b, "ottenuti: \(a)\n         attesi:   \(b)")
}

func vicini(_ a: TimeInterval, _ b: TimeInterval) -> Bool { abs(a - b) < 0.000001 }

// MARK: - I dati di prova

/// 2026-10-03T01:15:00Z, l'ora del GO di S0.
let t0 = Date(timeIntervalSince1970: 1_790_990_100)
func dopo(_ secondi: TimeInterval) -> Date { t0.addingTimeInterval(secondi) }

func uuid(_ n: Int) -> UUID {
    return UUID(uuidString: String(format: "abcdef12-3456-4abc-9def-%012ld", n))!
}

func dati(_ testo: String) -> Data { Data(testo.utf8) }

func jsonDati(_ oggetto: Any) -> Data {
    return try! JSONSerialization.data(withJSONObject: oggetto, options: [.sortedKeys])
}

func corpoStorage(statusCode: String?, errore: String?) -> Data {
    var o: [String: Any] = ["message": "testo che il nativo non deve leggere"]
    if let s = statusCode { o["statusCode"] = s }
    if let e = errore { o["error"] = e }
    return jsonDati(o)
}

/// Una cartella nuova sotto `TMPDIR` (l'`esegui.sh` la punta in una cartella sua, tolta alla fine).
let radiceProva = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
    .appendingPathComponent("kv-caricamenti-\(UUID().uuidString)", isDirectory: true)

func nuovaCartella() -> URL {
    let url = radiceProva.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try! FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: nil)
    return url
}

func scrivi(_ url: URL, byte: Int) {
    try! Data(repeating: 7, count: byte).write(to: url)
}

func esiste(_ url: URL) -> Bool { FileManager.default.fileExists(atPath: url.path) }

func nomiIn(_ url: URL) -> [String] {
    return ((try? FileManager.default.contentsOfDirectory(atPath: url.path)) ?? []).sorted()
}

/// L'orologio delle prove sulla coda e sul registro: lo si sposta a mano.
var orologioProva = Date(timeIntervalSince1970: floor(Date().timeIntervalSince1970))

func leggiTesto(_ percorso: String) -> String? {
    return try? String(contentsOfFile: percorso, encoding: .utf8)
}

/// Fa fallire ogni scrittura atomica su `url` mettendoci al posto del file una CARTELLA non vuota: «scrivi un file temporaneo e rinominalo sopra» non può
/// sostituirla (vale anche da root, a differenza di un `chmod`). Si toglie con `sbloccaLaScrittura`.
func bloccaLaScrittura(_ url: URL) {
    try? FileManager.default.removeItem(at: url)
    try! FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: nil)
    try! Data("x".utf8).write(to: url.appendingPathComponent("x"))
}

func sbloccaLaScrittura(_ url: URL) {
    try? FileManager.default.removeItem(at: url)
}

// MARK: - Argomenti e modo

let argomenti = CommandLine.arguments
guard argomenti.count >= 5 else {
    print("uso: prova <release|debug> <cartella file di produzione> <caricamenti-nativi-tipi.ts> <server.mjs>")
    exit(2)
}
let modo = argomenti[1]
let cartellaProduzione = argomenti[2]
let percorsoTipiTS = argomenti[3]
let percorsoServerFinto = argomenti[4]

print("Caricamenti nativi iOS — la parte pura, provata sul codice di produzione (modo \(modo))")

// MARK: - 0. Il modo compilato

func provaModo() {
    sezione("la configurazione compilata è quella dichiarata")
    #if DEBUG
    let atteso = "debug"
    #else
    let atteso = "release"
    #endif
    verificaUguali("modo di esecuzione = modo di compilazione (\(atteso))", modo, atteso)
    verificaUguali("KVAmbienteBuild.corrente segue `#if DEBUG`", KVAmbienteBuild.corrente, atteso == "debug" ? .debug : .release)
}

// MARK: - 1. Parità con la fonte TS e col server finto

/// `export const NOME = [ 'a', 'b' ]` → ["a", "b"].
func elencoDa(_ sorgente: String, dichiarazione: String) -> [String]? {
    guard let inizio = sorgente.range(of: dichiarazione) else { return nil }
    let resto = sorgente[inizio.upperBound...]
    guard let fine = resto.firstIndex(of: "]") else { return nil }
    var voci: [String] = []
    var corrente: String? = nil
    for carattere in resto[..<fine] {
        if carattere == "'" {
            if let testo = corrente {
                voci.append(testo)
                corrente = nil
            } else {
                corrente = ""
            }
        } else if corrente != nil {
            corrente!.append(carattere)
        }
    }
    return voci
}

func provaParita() {
    sezione("i nomi sono quelli di caricamenti-nativi-tipi.ts (S1) e del server finto (S2)")
    guard let ts = leggiTesto(percorsoTipiTS) else {
        verifica("caricamenti-nativi-tipi.ts leggibile", false, "non trovo \(percorsoTipiTS)")
        return
    }
    let stati = Set(KVStatoCaricamento.allCases.map { $0.rawValue })
    let statiTS = elencoDa(ts, dichiarazione: "export const STATI_NATIVI = [") ?? []
    verificaUguali("stati: gli stessi sette di STATI_NATIVI", stati, Set(statiTS))
    verificaUguali("stati: nessun doppione (\(statiTS.count))", KVStatoCaricamento.allCases.count, statiTS.count)

    let codici = Set(KVCodiceCaricamento.allCases.map { $0.rawValue })
    let codiciTS = elencoDa(ts, dichiarazione: "export const CODICI_NATIVI = [") ?? []
    verificaUguali("codici: gli stessi quattordici di CODICI_NATIVI", codici, Set(codiciTS))
    verificaUguali("codici: nessun doppione (\(codiciTS.count))", KVCodiceCaricamento.allCases.count, codiciTS.count)

    // I messaggi: UGUAGLIANZA ESATTA con EVENTI_LOG_NATIVI (dal 03/10 ci sono anche `put-oltre-scadenza`, che §3 e §4.5 chiedono, e le quindici voci
    // sono lo stesso elenco in TS, Swift e Java). Un messaggio in più o in meno lato Swift è un messaggio che il lock di J4 (messaggi ⊆ EVENTI_LOG_NATIVI)
    // o il server finto di C1 giudicherebbero fuori elenco.
    let messaggi = Set(KVMessaggioLog.allCases.map { $0.rawValue })
    let messaggiTS = Set(elencoDa(ts, dichiarazione: "export const EVENTI_LOG_NATIVI = [") ?? [])
    verificaUguali("EVENTI_LOG_NATIVI si legge dal file TS: sono quindici (senza, il confronto sotto passerebbe a vuoto)", messaggiTS.count, 15)
    verificaUguali("messaggi: quelli di Swift sono ESATTAMENTE quelli di EVENTI_LOG_NATIVI", messaggi, messaggiTS)
    verificaUguali("messaggi: nessun doppione (\(messaggiTS.count))", KVMessaggioLog.allCases.count, messaggiTS.count)

    // Gli host di sviluppo e la validità dell'URL: le stesse costanti.
    let hostTS = elencoDa(ts, dichiarazione: "export const HOST_DEBUG_CARICAMENTI = [") ?? []
    verificaUguali("host di Debug: quelli di HOST_DEBUG_CARICAMENTI, nello stesso ordine", KVPoliticaCaricamento.hostDebug, hostTS)
    if let riga = ts.range(of: "export const VALIDITA_URL_PUT_SECONDI = ") {
        let cifre = ts[riga.upperBound...].prefix(while: { $0.isNumber })
        verificaUguali("validità dell'URL di PUT: VALIDITA_URL_PUT_SECONDI", Int(KVPoliticaCaricamento.validitaUrlPutSecondi), Int(cifre) ?? -1)
    } else {
        verifica("VALIDITA_URL_PUT_SECONDI trovata nel file TS", false)
    }

    // La tabella degli stati: da ogni stato, gli stati raggiungibili in UN passo sono quelli di TRANSIZIONI_STATO_NATIVO.
    if let inizio = ts.range(of: "export const TRANSIZIONI_STATO_NATIVO = {"),
       let fine = ts.range(of: "} as const satisfies", range: inizio.upperBound..<ts.endIndex) {
        var tabellaTS: [String: Set<String>] = [:]
        for riga in ts[inizio.upperBound..<fine.lowerBound].split(separator: "\n") {
            guard let due = riga.firstIndex(of: ":") else { continue }
            let chiave = riga[..<due].trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "'", with: "")
            let valori = riga[due...].split(separator: "'").enumerated().compactMap { $0.offset % 2 == 1 ? String($0.element) : nil }
            tabellaTS[chiave] = Set(valori)
        }
        let eventi: [KVEventoStato] = [.accodato, .trasferimentoAvviato, .inAttesa(.rete), .inPausa(.fgsNonAvviabile), .ripreso,
                                       .inviato, .annullato(nil), .fallito(.interno)]
        for stato in KVStatoCaricamento.allCases {
            let raggiungibili = Set(eventi.compactMap { KVPoliticaCaricamento.transizione(da: stato, evento: $0)?.rawValue })
            verificaUguali("transizioni da \(stato.rawValue): le stesse di TRANSIZIONI_STATO_NATIVO",
                           raggiungibili, tabellaTS[stato.rawValue] ?? ["<assente>"])
        }
    } else {
        verifica("TRANSIZIONI_STATO_NATIVO trovata nel file TS", false)
    }

    // Il server finto di S2 segnala come violazione ogni messaggio o chiave fuori dai suoi elenchi: il nativo non ne deve emettere altri.
    guard let server = leggiTesto(percorsoServerFinto) else {
        verifica("server.mjs del server finto leggibile", false, "non trovo \(percorsoServerFinto)")
        return
    }
    let messaggiS2 = Set(elencoDa(server, dichiarazione: "const MESSAGGI_NATIVI = [") ?? [])
    let chiaviS2 = Set(elencoDa(server, dichiarazione: "const CHIAVI_CAMPI_NATIVI = [") ?? [])
    verificaUguali("il server finto elenca esattamente i messaggi di Swift (altrimenti segnerebbe una violazione LOG_MESSAGGIO_FUORI_ELENCO)", messaggiS2, messaggi)
    verifica("il server finto elenca le sue chiavi di `campi` (\(chiaviS2.count))", chiaviS2.count >= 20)
    let chiavi = Set(KVChiaveCampo.allCases.map { $0.rawValue })
    // `voci_scartate` è la chiave che il 03/10 la spec (§4.6) ha chiesto per `coda-nativa-corrotta`: il server finto di S2 non la conosce ancora (lo
    // segna LOG_CHIAVE_NON_AMMESSA) finché l'orchestratore non gliela insegna, insieme a TS e al PRD. È l'UNICA eccedenza tollerata.
    verifica("chiavi che il server finto non conosce: al più voci_scartate (aggiunta il 03/10, da insegnare a S2)", chiavi.subtracting(chiaviS2).isSubset(of: ["voci_scartate"]),
             "sconosciute al server finto: \(chiavi.subtracting(chiaviS2).sorted())")
    verifica("ogni chiave di `campi` ha la forma che la porta dei log accetta (^[a-z][a-z0-9_]{0,31}$)",
             chiavi.allSatisfy { $0.range(of: "^[a-z][a-z0-9_]{0,31}$", options: .regularExpression) != nil })
    verifica("l'evento sul server (`caricamento-nativo`) ha la forma di uno slug (^[a-z][a-z0-9-]{0,29}$)",
             KVRegistroNativo.nomeEventoSulServer.range(of: "^[a-z][a-z0-9-]{0,29}$", options: .regularExpression) != nil)
}

// MARK: - 2. §4.4 — gli stati

func etichetta(_ e: KVEventoStato) -> String {
    switch e {
    case .accodato: return "accodato"
    case .trasferimentoAvviato: return "trasferimento avviato"
    case .inAttesa(let c): return "in attesa(\(c.rawValue))"
    case .inPausa(let c): return "in pausa(\(c.rawValue))"
    case .ripreso: return "ripreso"
    case .inviato: return "inviato"
    case .annullato(let c): return "annullato(\(c?.rawValue ?? "utente"))"
    case .fallito(let c): return "fallito(\(c.rawValue))"
    }
}

/// La tabella di §4.4, riscritta a mano: lo stato d'arrivo, o `nil` se la tabella non prevede il passo.
func attesoDaTabella(_ da: KVStatoCaricamento?, _ e: KVEventoStato) -> KVStatoCaricamento? {
    switch (da, e) {
    case (nil, .accodato): return .inCoda
    case (.inCoda?, .trasferimentoAvviato): return .inInvio
    case (.inInvio?, .inAttesa): return .inAttesa
    case (.inInvio?, .inPausa), (.inCoda?, .inPausa): return .inPausa  // in-coda → in-pausa dal 03/10 (§6.2, tabelle uguali)
    case (.inAttesa?, .ripreso), (.inPausa?, .ripreso): return .inInvio
    case (.inInvio?, .inviato): return .inviato
    case (.inCoda?, .annullato), (.inInvio?, .annullato), (.inAttesa?, .annullato), (.inPausa?, .annullato): return .annullato
    case (.inCoda?, .fallito), (.inInvio?, .fallito), (.inAttesa?, .fallito), (.inPausa?, .fallito): return .fallito
    default: return nil
    }
}

func provaStati() {
    sezione("§4.4 — una riga per freccia")
    let T = KVPoliticaCaricamento.self
    // Le righe, come sono scritte nella spec.
    verificaUguali("— · accodaVideo riuscito → in-coda", T.transizione(da: nil, evento: .accodato), .inCoda)
    verificaUguali("in-coda · trasferimento avviato → in-invio", T.transizione(da: .inCoda, evento: .trasferimentoAvviato), .inInvio)
    verificaUguali("in-invio · rete assente → in-attesa", T.transizione(da: .inInvio, evento: .inAttesa(.rete)), .inAttesa)
    verificaUguali("in-invio · task in attesa / backoff dopo un transitorio → in-attesa", T.transizione(da: .inInvio, evento: .inAttesa(.server)), .inAttesa)
    verificaUguali("in-invio · FGS non avviabile (Android 12-13) → in-pausa", T.transizione(da: .inInvio, evento: .inPausa(.fgsNonAvviabile)), .inPausa)
    verificaUguali("in-invio · UIDT non programmabile (Android ≥ 14) → in-pausa", T.transizione(da: .inInvio, evento: .inPausa(.uidtNonProgrammabile)), .inPausa)
    verificaUguali("in-attesa · rete tornata / app riaperta → in-invio", T.transizione(da: .inAttesa, evento: .ripreso), .inInvio)
    verificaUguali("in-pausa · rete tornata / app riaperta → in-invio", T.transizione(da: .inPausa, evento: .ripreso), .inInvio)
    verificaUguali("in-invio · PUT 2xx, oppure rinnovo arrivato → inviato", T.transizione(da: .inInvio, evento: .inviato), .inviato)
    for stato in [KVStatoCaricamento.inCoda, .inInvio, .inAttesa, .inPausa] {
        verificaUguali("\(stato.rawValue) · rinnovo annullato → annullato", T.transizione(da: stato, evento: .annullato(.annullatoDalServer)), .annullato)
        verificaUguali("\(stato.rawValue) · annulla dal JS → annullato", T.transizione(da: stato, evento: .annullato(nil)), .annullato)
        verificaUguali("\(stato.rawValue) · esito definitivo (§4.5) → fallito", T.transizione(da: stato, evento: .fallito(.troppoGrande)), .fallito)
        verificaUguali("\(stato.rawValue) · token scaduto → fallito", T.transizione(da: stato, evento: .fallito(.tokenScaduto)), .fallito)
    }

    // Tutto il resto è vietato: il prodotto cartesiano contro la tabella riscritta a mano.
    let eventi: [KVEventoStato] = [.accodato, .trasferimentoAvviato, .inAttesa(.rete), .inAttesa(.server), .inPausa(.fgsNonAvviabile),
                                   .inPausa(.uidtNonProgrammabile), .ripreso, .inviato, .annullato(nil), .annullato(.annullatoDalServer),
                                   .fallito(.troppoGrande), .fallito(.tokenScaduto), .fallito(.rinnovoCiclico), .fallito(.tokenNonValido)]
    let partenze: [KVStatoCaricamento?] = [nil] + KVStatoCaricamento.allCases.map { Optional($0) }
    var divergenze: [String] = []
    var controllate = 0
    for da in partenze {
        for evento in eventi {
            controllate += 1
            if T.transizione(da: da, evento: evento) != attesoDaTabella(da, evento) {
                divergenze.append("\(da?.rawValue ?? "—") + \(etichetta(evento))")
            }
        }
    }
    verifica("nessun passo fuori tabella: \(controllate) combinazioni (stato × evento), nessuna divergenza", divergenze.isEmpty, "divergono: \(divergenze)")

    for terminale in [KVStatoCaricamento.inviato, .fallito, .annullato] {
        verifica("\(terminale.rawValue) è terminale: nessun evento ne fa uscire", eventi.allSatisfy { T.transizione(da: terminale, evento: $0) == nil })
        verifica("\(terminale.rawValue).eTerminale", terminale.eTerminale)
    }
    verifica("gli altri quattro stati non sono terminali",
             [KVStatoCaricamento.inCoda, .inInvio, .inAttesa, .inPausa].allSatisfy { !$0.eTerminale })
    verifica("un voce già esistente non si «riaccoda»", KVStatoCaricamento.allCases.allSatisfy { T.transizione(da: $0, evento: .accodato) == nil })

    // I due passi: un esito che arriva a una voce che non ha ancora fatto il passo prima.
    sezione("§4.4 — la sequenza a due passi (un task che finisce mentre la voce dorme)")
    verificaUguali("in-invio + inviato: un passo solo", T.catena(da: .inInvio, evento: .inviato), [.inviato])
    verificaUguali("in-attesa + inviato: prima `ripreso`", T.catena(da: .inAttesa, evento: .inviato), [.ripreso, .inviato])
    verificaUguali("in-pausa + inviato: prima `ripreso`", T.catena(da: .inPausa, evento: .inviato), [.ripreso, .inviato])
    verificaUguali("in-coda + inviato: prima `trasferimento avviato`", T.catena(da: .inCoda, evento: .inviato), [.trasferimentoAvviato, .inviato])
    verificaUguali("in-coda + in-attesa(RETE): prima `trasferimento avviato`", T.catena(da: .inCoda, evento: .inAttesa(.rete)),
                   [.trasferimentoAvviato, .inAttesa(.rete)])
    verificaUguali("in-attesa + in-attesa(SERVER): prima `ripreso`", T.catena(da: .inAttesa, evento: .inAttesa(.server)), [.ripreso, .inAttesa(.server)])
    verificaUguali("in-attesa + annullato: un passo solo (la tabella lo prevede)", T.catena(da: .inAttesa, evento: .annullato(nil)), [.annullato(nil)])
    verificaUguali("in-coda + fallito: un passo solo", T.catena(da: .inCoda, evento: .fallito(.fileAssente)), [.fallito(.fileAssente)])
    verificaUguali("in-attesa + trasferimento avviato: nessuna sequenza", T.catena(da: .inAttesa, evento: .trasferimentoAvviato), nil)
    verificaUguali("in-coda + ripreso: nessuna sequenza", T.catena(da: .inCoda, evento: .ripreso), nil)
    verificaUguali("in-invio + accodato: nessuna sequenza", T.catena(da: .inInvio, evento: .accodato), nil)
    for terminale in [KVStatoCaricamento.inviato, .fallito, .annullato] {
        verificaUguali("\(terminale.rawValue) + qualunque evento: nessuna sequenza", T.catena(da: terminale, evento: .inviato), nil)
        verificaUguali("\(terminale.rawValue) + annullato: nessuna sequenza", T.catena(da: terminale, evento: .annullato(nil)), nil)
    }

    sezione("§4.4 — il token scade: orologio ≥ rinnovo.scadeIl")
    let scade = dopo(48 * 3600)
    verifica("un secondo prima: non scaduto", !T.tokenScaduto(adesso: scade.addingTimeInterval(-1), tokenScadeIl: scade))
    verifica("proprio all'istante: scaduto (≥)", T.tokenScaduto(adesso: scade, tokenScadeIl: scade))
    verifica("un secondo dopo: scaduto", T.tokenScaduto(adesso: scade.addingTimeInterval(1), tokenScadeIl: scade))
}

// MARK: - 3. §4.5 — la PUT

func riprovaDi(_ d: KVDecisionePut) -> (attesa: TimeInterval, codice: KVCodiceCaricamento, stato: Int)? {
    if case .riprova(let attesa, let codice, let stato) = d { return (attesa, codice, stato) }
    return nil
}

func verificaRiprova(_ descrizione: String, _ d: KVDecisionePut, attesa: TimeInterval, codice: KVCodiceCaricamento, stato: Int) {
    guard let r = riprovaDi(d) else {
        verifica("\(descrizione) → riprova", false, "ottenuto: \(d)")
        return
    }
    verifica("\(descrizione) → riprova fra \(Int(attesa)) s, \(codice.rawValue), stato \(stato)",
             vicini(r.attesa, attesa) && r.codice == codice && r.stato == stato, "ottenuto: \(d)")
}

func provaPut() {
    sezione("§4.5 — PUT: una riga per esito")
    func decidi(_ r: KVRispostaPut, tentativo: Int = 1, casuale: Double = 0.5) -> KVDecisionePut {
        return KVPoliticaCaricamento.decidiPut(r, tentativo: tentativo, adesso: t0, casuale: casuale)
    }
    let duplicate = corpoStorage(statusCode: "409", errore: "Duplicate")
    let jwt = corpoStorage(statusCode: "400", errore: "InvalidJWT")

    // 2xx
    for stato in [200, 201, 204, 299] {
        verificaUguali("2xx: HTTP \(stato) → inviato (esito put)", decidi(KVRispostaPut(statoHTTP: stato)), .inviato)
    }
    verificaUguali("2xx vince su un errore di sistema arrivato dopo", decidi(KVRispostaPut(statoHTTP: 200, errore: KVErroreSistema(dominio: .url, codice: -1005))), .inviato)

    // 413
    verificaUguali("HTTP 413 → fallito TROPPO_GRANDE, senza rinnovo", decidi(KVRispostaPut(statoHTTP: 413)), .fallito(.troppoGrande))
    verificaUguali("HTTP 413 con Retry-After → comunque fallito TROPPO_GRANDE",
                   decidi(KVRispostaPut(statoHTTP: 413, retryAfter: "30")), .fallito(.troppoGrande))
    verificaUguali("HTTP 400 col corpo statusCode \"413\" e EntityTooLarge → fallito TROPPO_GRANDE (A16)",
                   decidi(KVRispostaPut(statoHTTP: 400, corpo: corpoStorage(statusCode: "413", errore: "EntityTooLarge"))), .fallito(.troppoGrande))
    verificaUguali("HTTP 400 col solo statusCode \"413\" nel corpo → fallito TROPPO_GRANDE",
                   decidi(KVRispostaPut(statoHTTP: 400, corpo: corpoStorage(statusCode: "413", errore: nil))), .fallito(.troppoGrande))
    verificaUguali("HTTP 400 col solo error EntityTooLarge nel corpo → fallito TROPPO_GRANDE",
                   decidi(KVRispostaPut(statoHTTP: 400, corpo: corpoStorage(statusCode: nil, errore: "EntityTooLarge"))), .fallito(.troppoGrande))
    verificaUguali("statusCode 413 come NUMERO nel corpo → fallito TROPPO_GRANDE",
                   decidi(KVRispostaPut(statoHTTP: 400, corpo: jsonDati(["statusCode": 413]))), .fallito(.troppoGrande))
    verificaUguali("un 400 col statusCode \"412\" NON è troppo grande: rinnovo",
                   decidi(KVRispostaPut(statoHTTP: 400, corpo: corpoStorage(statusCode: "412", errore: nil))),
                   .rinnova(errore: .altro, statoHTTP: 400, oltreScadenzaDopoSecondi: nil))

    // 408 e 429: attesa, con Retry-After se più lungo
    verificaRiprova("HTTP 408", decidi(KVRispostaPut(statoHTTP: 408)), attesa: 30, codice: .server, stato: 408)
    verificaRiprova("HTTP 429 senza Retry-After", decidi(KVRispostaPut(statoHTTP: 429)), attesa: 30, codice: .server, stato: 429)
    verificaRiprova("HTTP 429 con Retry-After 120", decidi(KVRispostaPut(statoHTTP: 429, retryAfter: "120")), attesa: 120, codice: .server, stato: 429)
    verificaRiprova("HTTP 429 con Retry-After 10 (più corto dell'attesa: vince l'attesa)", decidi(KVRispostaPut(statoHTTP: 429, retryAfter: "10")),
                    attesa: 30, codice: .server, stato: 429)
    verificaRiprova("HTTP 429 con Retry-After 86400 (tetto di un'ora)", decidi(KVRispostaPut(statoHTTP: 429, retryAfter: "86400")),
                    attesa: 3600, codice: .server, stato: 429)
    verificaRiprova("HTTP 429 con Retry-After in forma di data (+90 s)", decidi(KVRispostaPut(statoHTTP: 429, retryAfter: "Sat, 03 Oct 2026 01:16:30 GMT")),
                    attesa: 90, codice: .server, stato: 429)
    verificaRiprova("HTTP 429 con Retry-After illeggibile", decidi(KVRispostaPut(statoHTTP: 429, retryAfter: "presto")), attesa: 30, codice: .server, stato: 429)

    // 5xx: come 408
    for stato in [500, 502, 503, 504, 599] {
        verificaRiprova("HTTP \(stato)", decidi(KVRispostaPut(statoHTTP: stato)), attesa: 30, codice: .server, stato: stato)
    }
    verificaRiprova("HTTP 503 con Retry-After 45", decidi(KVRispostaPut(statoHTTP: 503, retryAfter: "45")), attesa: 45, codice: .server, stato: 503)
    verificaRiprova("HTTP 500 con un corpo InvalidJWT è comunque transitorio", decidi(KVRispostaPut(statoHTTP: 500, corpo: jwt, durataSecondi: 7812, trasferimentoCompleto: true)),
                    attesa: 30, codice: .server, stato: 500)
    verificaRiprova("HTTP 500 con una pagina HTML", decidi(KVRispostaPut(statoHTTP: 500, corpo: dati("<html>Bad gateway</html>"))),
                    attesa: 30, codice: .server, stato: 500)

    // qualunque altro 4xx → rinnovo
    for stato in [400, 401, 403, 404, 405, 409, 410, 422, 451, 499] {
        verificaUguali("HTTP \(stato) senza corpo → rinnovo",
                       decidi(KVRispostaPut(statoHTTP: stato)), .rinnova(errore: nil, statoHTTP: stato, oltreScadenzaDopoSecondi: nil))
    }
    verificaUguali("HTTP 400 col 409 nel corpo (Duplicate) → rinnovo: è il rinnovo a dire se il file c'è",
                   decidi(KVRispostaPut(statoHTTP: 400, corpo: duplicate)), .rinnova(errore: .duplicate, statoHTTP: 400, oltreScadenzaDopoSecondi: nil))
    verificaUguali("HTTP 409 vero (non lo manda mai lo Storage, ma se arriva) → rinnovo",
                   decidi(KVRispostaPut(statoHTTP: 409, corpo: duplicate)), .rinnova(errore: .duplicate, statoHTTP: 409, oltreScadenzaDopoSecondi: nil))
    for stato in [100, 199, 300, 301, 302, 304, 308, 600, 700, 999] {
        verificaRiprova("HTTP \(stato) (la tabella non lo nomina: non chiude una voce, e non gira in tondo nel rinnovo)", decidi(KVRispostaPut(statoHTTP: stato)),
                        attesa: 30, codice: .server, stato: stato)
    }
    verificaRiprova("HTTP 302 con Retry-After 90", decidi(KVRispostaPut(statoHTTP: 302, retryAfter: "90")), attesa: 90, codice: .server, stato: 302)
    verificaUguali("il confine fra i 4xx e il resto: 399 è transitorio, 400 e 499 sono rinnovo, 500 è transitorio",
                   [decidi(KVRispostaPut(statoHTTP: 399)), decidi(KVRispostaPut(statoHTTP: 400)), decidi(KVRispostaPut(statoHTTP: 499)), decidi(KVRispostaPut(statoHTTP: 500))].map { d -> String in
                       if case .riprova = d { return "riprova" }
                       if case .rinnova = d { return "rinnova" }
                       return "altro"
                   }, ["riprova", "rinnova", "rinnova", "riprova"])

    // il nome d'errore dello Storage: elenco chiuso
    for nome in ["Duplicate", "InvalidJWT", "Unauthorized", "InvalidRequest", "NoSuchKey"] {
        let atteso = KVErroreStorage(rawValue: nome)
        verificaUguali("il nome d'errore \(nome) si riconosce",
                       decidi(KVRispostaPut(statoHTTP: 400, corpo: corpoStorage(statusCode: "400", errore: nome))),
                       .rinnova(errore: atteso, statoHTTP: 400, oltreScadenzaDopoSecondi: nil))
    }
    verificaUguali("un nome fuori elenco vale `altro`",
                   decidi(KVRispostaPut(statoHTTP: 400, corpo: corpoStorage(statusCode: "400", errore: "Bucket not found"))),
                   .rinnova(errore: .altro, statoHTTP: 400, oltreScadenzaDopoSecondi: nil))
    verificaUguali("un corpo che non è JSON vale `altro`",
                   decidi(KVRispostaPut(statoHTTP: 403, corpo: dati("<html>sfida</html>"))), .rinnova(errore: .altro, statoHTTP: 403, oltreScadenzaDopoSecondi: nil))
    verificaUguali("un corpo JSON che è un array vale `altro`",
                   decidi(KVRispostaPut(statoHTTP: 400, corpo: dati("[1,2]"))), .rinnova(errore: .altro, statoHTTP: 400, oltreScadenzaDopoSecondi: nil))
    verificaUguali("il confronto del nome è esatto (invalidjwt in minuscolo non è InvalidJWT)",
                   decidi(KVRispostaPut(statoHTTP: 400, corpo: corpoStorage(statusCode: "400", errore: "invalidjwt"), durataSecondi: 5000, trasferimentoCompleto: true)),
                   .rinnova(errore: .altro, statoHTTP: 400, oltreScadenzaDopoSecondi: nil))
    verificaUguali("del corpo si leggono solo i primi 4 KB: un 413 dopo il quarto kilobyte non conta",
                   decidi(KVRispostaPut(statoHTTP: 400, corpo: dati(String(repeating: " ", count: 4096) + "{\"statusCode\":\"413\"}"))),
                   .rinnova(errore: .altro, statoHTTP: 400, oltreScadenzaDopoSecondi: nil))

    // S0: l'InvalidJWT arrivato dopo il trasferimento
    sezione("S0 — 400 InvalidJWT dopo un trasferimento = firma scaduta durante l'invio (put-oltre-scadenza)")
    verificaUguali("InvalidJWT a trasferimento completo dopo 7.812 s (il caso misurato di S0-b) → rinnovo e durata nel log",
                   decidi(KVRispostaPut(statoHTTP: 400, corpo: jwt, durataSecondi: 7812, trasferimentoCompleto: true)),
                   .rinnova(errore: .invalidJWT, statoHTTP: 400, oltreScadenzaDopoSecondi: 7812))
    verificaUguali("InvalidJWT a trasferimento completo anche dopo 0 s (un file piccolo): è comunque «oltre la scadenza», con durata 0",
                   decidi(KVRispostaPut(statoHTTP: 400, corpo: jwt, durataSecondi: 0, trasferimentoCompleto: true)),
                   .rinnova(errore: .invalidJWT, statoHTTP: 400, oltreScadenzaDopoSecondi: 0))
    verificaUguali("InvalidJWT con i byte NON finiti (S0-c: URL già scaduto alla partenza, rifiuto in 72 ms) → rinnovo, ma NON «oltre la scadenza»",
                   decidi(KVRispostaPut(statoHTTP: 400, corpo: jwt, durataSecondi: 0, trasferimentoCompleto: false)),
                   .rinnova(errore: .invalidJWT, statoHTTP: 400, oltreScadenzaDopoSecondi: nil))
    verificaUguali("InvalidJWT con i byte non finiti anche dopo molto tempo → non «oltre la scadenza»",
                   decidi(KVRispostaPut(statoHTTP: 400, corpo: jwt, durataSecondi: 7812, trasferimentoCompleto: false)),
                   .rinnova(errore: .invalidJWT, statoHTTP: 400, oltreScadenzaDopoSecondi: nil))
    verificaUguali("InvalidJWT con un 401 a trasferimento completo → comunque «oltre la scadenza»",
                   decidi(KVRispostaPut(statoHTTP: 401, corpo: jwt, durataSecondi: 3000, trasferimentoCompleto: true)),
                   .rinnova(errore: .invalidJWT, statoHTTP: 401, oltreScadenzaDopoSecondi: 3000))
    verificaUguali("un Duplicate a trasferimento completo NON è «oltre la scadenza»",
                   decidi(KVRispostaPut(statoHTTP: 400, corpo: duplicate, durataSecondi: 7812, trasferimentoCompleto: true)),
                   .rinnova(errore: .duplicate, statoHTTP: 400, oltreScadenzaDopoSecondi: nil))
    verificaUguali("un 400 senza nome d'errore a trasferimento completo NON è «oltre la scadenza»",
                   decidi(KVRispostaPut(statoHTTP: 400, durataSecondi: 7812, trasferimentoCompleto: true)),
                   .rinnova(errore: nil, statoHTTP: 400, oltreScadenzaDopoSecondi: nil))
    verificaRiprova("un InvalidJWT che arriva con un 5xx è transitorio, anche a trasferimento completo",
                    decidi(KVRispostaPut(statoHTTP: 503, corpo: jwt, durataSecondi: 7812, trasferimentoCompleto: true)), attesa: 30, codice: .server, stato: 503)

    sezione("§4.5 — il contatore dei rinnovi di fila (RINNOVO_CICLICO) dopo l'esito di una PUT")
    for (nome, decisione) in [("rinnovo (la PUT è stata rifiutata)", KVDecisionePut.rinnova(errore: .invalidJWT, statoHTTP: 400, oltreScadenzaDopoSecondi: nil)),
                              ("rinnovo con «oltre la scadenza»", .rinnova(errore: .invalidJWT, statoHTTP: 400, oltreScadenzaDopoSecondi: 7812))] {
        for attuali in [0, 1, 2, 3] {
            verificaUguali("\(nome): il contatore (\(attuali)) resta com'è, lo alzerà la risposta da-caricare",
                           KVPoliticaCaricamento.rinnoviConsecutiviDopoPut(attuali: attuali, decisione: decisione), attuali)
        }
    }
    verificaUguali("un contatore negativo si riporta a 0", KVPoliticaCaricamento.rinnoviConsecutiviDopoPut(attuali: -4, decisione: .rinnova(errore: nil, statoHTTP: 403, oltreScadenzaDopoSecondi: nil)), 0)
    for (nome, decisione) in [("transitorio (rete)", KVDecisionePut.riprova(attesa: 30, codice: .rete, statoHTTP: 0)),
                              ("transitorio (5xx)", .riprova(attesa: 30, codice: .server, statoHTTP: 503)),
                              ("troppo grande", .fallito(.troppoGrande)),
                              ("inviato", .inviato),
                              ("da ricreare alla riapertura", .ricreaAllaRiapertura)] {
        verificaUguali("\(nome): il server non ha rifiutato di nuovo una firma appena data, il contatore (3) si azzera",
                       KVPoliticaCaricamento.rinnoviConsecutiviDopoPut(attuali: 3, decisione: decisione), 0)
    }

    // nessuna risposta
    sezione("§4.5 — PUT senza risposta, e annullamento di sistema")
    let reteAssente = KVErroreSistema(dominio: .url, codice: -1009)
    for (nome, codice) in [("rete assente", -1009), ("timeout", -1001), ("connessione persa", -1005), ("host irraggiungibile", -1004),
                           ("DNS", -1003), ("connessione TLS fallita", -1200), ("connessione interrotta dal sistema", -1018)] {
        verificaRiprova("nessuna risposta: \(nome) (\(codice))", decidi(KVRispostaPut(errore: KVErroreSistema(dominio: .url, codice: codice))),
                        attesa: 30, codice: .rete, stato: 0)
    }
    verificaRiprova("nessuna risposta e nessun errore", decidi(KVRispostaPut()), attesa: 30, codice: .rete, stato: 0)
    verificaRiprova("stato HTTP 0 vale «nessuna risposta»", decidi(KVRispostaPut(statoHTTP: 0, errore: reteAssente)), attesa: 30, codice: .rete, stato: 0)
    let annullata = KVErroreSistema(dominio: .url, codice: NSURLErrorCancelled)
    verificaUguali("NSURLErrorCancelled · userForceQuitApplication → da ricreare alla riapertura (CHIUSURA_FORZATA)",
                   decidi(KVRispostaPut(errore: annullata, motivoAnnullamento: NSURLErrorCancelledReasonUserForceQuitApplication)), .ricreaAllaRiapertura)
    verificaUguali("… e la costante di sistema vale davvero 0", NSURLErrorCancelledReasonUserForceQuitApplication, 0)
    verificaRiprova("NSURLErrorCancelled · backgroundUpdatesDisabled (l'utente ha spento l'aggiornamento in background) → transitorio",
                    decidi(KVRispostaPut(errore: annullata, motivoAnnullamento: NSURLErrorCancelledReasonBackgroundUpdatesDisabled)),
                    attesa: 30, codice: .rete, stato: 0)
    verificaRiprova("NSURLErrorCancelled · insufficientSystemResources → transitorio",
                    decidi(KVRispostaPut(errore: annullata, motivoAnnullamento: NSURLErrorCancelledReasonInsufficientSystemResources)),
                    attesa: 30, codice: .rete, stato: 0)
    verificaRiprova("NSURLErrorCancelled senza motivo → transitorio", decidi(KVRispostaPut(errore: annullata)), attesa: 30, codice: .rete, stato: 0)
    verificaRiprova("il motivo «chiusura forzata» su un errore che NON è un annullamento non vale niente",
                    decidi(KVRispostaPut(errore: reteAssente, motivoAnnullamento: NSURLErrorCancelledReasonUserForceQuitApplication)),
                    attesa: 30, codice: .rete, stato: 0)
    verificaRiprova("un -999 di un altro dominio non è NSURLErrorCancelled",
                    decidi(KVRispostaPut(errore: KVErroreSistema(dominio: .cocoa, codice: NSURLErrorCancelled),
                                         motivoAnnullamento: NSURLErrorCancelledReasonUserForceQuitApplication)),
                    attesa: 30, codice: .rete, stato: 0)
    verificaUguali("una risposta HTTP vince sull'annullamento: un 200 con motivo di chiusura è inviato",
                   decidi(KVRispostaPut(statoHTTP: 200, errore: annullata, motivoAnnullamento: 0)), .inviato)

    // la progressione delle attese dentro la decisione
    verificaRiprova("transitorio al tentativo 3", decidi(KVRispostaPut(statoHTTP: 500), tentativo: 3), attesa: 120, codice: .server, stato: 500)
    verificaRiprova("transitorio al tentativo 9: 15 minuti fissi", decidi(KVRispostaPut(), tentativo: 9), attesa: 900, codice: .rete, stato: 0)
    verificaRiprova("scarto −20% (casuale 0) sul tentativo 1", decidi(KVRispostaPut(statoHTTP: 500), casuale: 0), attesa: 24, codice: .server, stato: 500)
    verificaRiprova("scarto +20% (casuale 1) sul tentativo 1", decidi(KVRispostaPut(statoHTTP: 500), casuale: 1), attesa: 36, codice: .server, stato: 500)

    sezione("§4.5 — i codici di fallimento hanno la loro operazione (per `video-nativo-fallito`)")
    verificaUguali("TROPPO_GRANDE cade sulla PUT", KVPoliticaCaricamento.operazione(per: .troppoGrande), .put)
    verificaUguali("FILE_ASSENTE cade sulla copia", KVPoliticaCaricamento.operazione(per: .fileAssente), .copia)
    verificaUguali("PESO_DIVERSO cade sulla copia", KVPoliticaCaricamento.operazione(per: .pesoDiverso), .copia)
    for codice in [KVCodiceCaricamento.tokenNonValido, .tokenScaduto, .rinnovoCiclico, .annullatoDalServer] {
        verificaUguali("\(codice.rawValue) cade sul rinnovo", KVPoliticaCaricamento.operazione(per: codice), .rinnovo)
    }
}

// MARK: - 4. §4.5 — le attese

func provaAttese() {
    sezione("§4.5 — attese: 30 s, 1', 2', 5', 10', 15', poi 15' fisse, ±20%; Retry-After vince se più lungo (tetto 1 h)")
    let T = KVPoliticaCaricamento.self
    let attese: [(Int, TimeInterval)] = [(1, 30), (2, 60), (3, 120), (4, 300), (5, 600), (6, 900), (7, 900), (8, 900), (50, 900), (100_000, 900)]
    for (tentativo, base) in attese {
        verifica("tentativo \(tentativo): \(Int(base)) s", vicini(T.attesa(tentativo: tentativo, retryAfter: nil, casuale: 0.5), base))
    }
    verifica("tentativo 0 vale come il primo", vicini(T.attesa(tentativo: 0, retryAfter: nil, casuale: 0.5), 30))
    verifica("tentativo negativo vale come il primo", vicini(T.attesa(tentativo: -3, retryAfter: nil, casuale: 0.5), 30))

    verifica("scarto: casuale 0 → −20% (24 s su 30)", vicini(T.attesa(tentativo: 1, retryAfter: nil, casuale: 0), 24))
    verifica("scarto: casuale 1 → +20% (36 s su 30)", vicini(T.attesa(tentativo: 1, retryAfter: nil, casuale: 1), 36))
    verifica("scarto: casuale 0,25 → −10% (27 s su 30)", vicini(T.attesa(tentativo: 1, retryAfter: nil, casuale: 0.25), 27))
    verifica("scarto sui 15 minuti fissi: 720 s", vicini(T.attesa(tentativo: 6, retryAfter: nil, casuale: 0), 720))
    verifica("scarto sui 15 minuti fissi: 1.080 s", vicini(T.attesa(tentativo: 12, retryAfter: nil, casuale: 1), 1080))
    verifica("un casuale fuori da [0, 1] si riporta dentro: −7 → 24 s", vicini(T.attesa(tentativo: 1, retryAfter: nil, casuale: -7), 24))
    verifica("un casuale fuori da [0, 1] si riporta dentro: 7 → 36 s", vicini(T.attesa(tentativo: 1, retryAfter: nil, casuale: 7), 36))
    verifica("su cento sorteggi l'attesa del tentativo 4 sta sempre fra 240 e 360 s",
             (0...100).allSatisfy { let a = T.attesa(tentativo: 4, retryAfter: nil, casuale: Double($0) / 100); return a >= 239.999 && a <= 360.001 })

    verifica("Retry-After più lungo vince: 120 s su un'attesa di 24", vicini(T.attesa(tentativo: 1, retryAfter: 120, casuale: 0), 120))
    verifica("Retry-After più corto non conta: 10 s su un'attesa di 30", vicini(T.attesa(tentativo: 1, retryAfter: 10, casuale: 0.5), 30))
    verifica("Retry-After a 0 non conta", vicini(T.attesa(tentativo: 1, retryAfter: 0, casuale: 0.5), 30))
    verifica("Retry-After nullo non conta", vicini(T.attesa(tentativo: 2, retryAfter: nil, casuale: 0.5), 60))
    verifica("Retry-After enorme: tetto di un'ora", vicini(T.attesa(tentativo: 1, retryAfter: 1_000_000, casuale: 0.5), 3600))
    verifica("Retry-After di 3.600 s: un'ora esatta", vicini(T.attesa(tentativo: 1, retryAfter: 3600, casuale: 0.5), 3600))
    verifica("Retry-After non prende lo scarto: 1.000 s restano 1.000", vicini(T.attesa(tentativo: 1, retryAfter: 1000, casuale: 1), 1000))

    sezione("§8.1 — i ritentativi si loggano ai tentativi 1, 2, 4, 8, 16, …")
    for n in [1, 2, 4, 8, 16, 32, 64, 1024] {
        verifica("tentativo \(n): si logga", T.tentativoDaLoggare(n))
    }
    for n in [0, -1, -4, 3, 5, 6, 7, 9, 10, 12, 15, 17, 100, 1000] {
        verifica("tentativo \(n): non si logga", !T.tentativoDaLoggare(n))
    }

    sezione("Retry-After: numero di secondi o data HTTP")
    func ra(_ valore: String?) -> TimeInterval? { T.secondiRetryAfter(valore, adesso: t0) }
    verificaUguali("«120» → 120", ra("120"), 120)
    verificaUguali("«  45 » (spazi attorno) → 45", ra("  45 "), 45)
    verificaUguali("«0» → 0", ra("0"), 0)
    verificaUguali("assente → nil", ra(nil), nil)
    verificaUguali("vuoto → nil", ra(""), nil)
    verificaUguali("«-5» → nil", ra("-5"), nil)
    verificaUguali("«+5» → nil", ra("+5"), nil)
    verificaUguali("«1.5» → nil", ra("1.5"), nil)
    verificaUguali("«abc» → nil", ra("abc"), nil)
    verificaUguali("un numero che non entra in un intero → nil", ra("99999999999999999999"), nil)
    verificaUguali("data HTTP fra 2 minuti → 120", ra("Sat, 03 Oct 2026 01:17:00 GMT"), 120)
    verificaUguali("data HTTP già passata → 0", ra("Sat, 03 Oct 2026 01:00:00 GMT"), 0)
    verificaUguali("data HTTP malformata → nil", ra("Sat, 32 Oct 2026 01:17:00 GMT"), nil)
}

// MARK: - 5. §4.5 — il rinnovo

func corpoRinnovo(url: String = "https://abcdefghij.supabase.co/storage/v1/object/upload/sign/video_originals/x/y.mov?token=t",
                  protocollo: String = "put", contentType: Any = "video/quicktime", scadeIl: Any = "2026-10-05T01:15:00.123Z") -> Data {
    let caricamento: [String: Any] = ["protocollo": protocollo, "url": url, "metodo": "PUT", "intestazioni": ["content-type": contentType]]
    return jsonDati(["stato": "da-caricare", "caricamento": caricamento, "scadeIl": scadeIl])
}

func provaRinnovo() {
    sezione("§4.5 — risposta del rinnovo: la forma (ciò che non torna vale transitorio)")
    let T = KVPoliticaCaricamento.self
    func leggi(_ stato: Int?, _ corpo: Data = Data(), ra: String? = nil, ambiente: KVAmbienteBuild = .release) -> KVRispostaRinnovo {
        return T.leggiRispostaRinnovo(statoHTTP: stato, corpo: corpo, retryAfter: ra, adesso: t0, ambiente: ambiente)
    }
    let urlBuono = URL(string: "https://abcdefghij.supabase.co/storage/v1/object/upload/sign/video_originals/x/y.mov?token=t")!
    // 200 da-caricare
    let scadenzaToken = T.leggiDataISO("2026-10-05T01:15:00.123Z")
    verificaUguali("200 da-caricare, forma giusta → nuova PUT, content-type e scadenza del TOKEN",
                   leggi(200, corpoRinnovo()).esito, .daCaricare(url: urlBuono, contentType: "video/quicktime", tokenScadeIl: scadenzaToken!))
    verificaUguali("… col suo stato HTTP", leggi(200, corpoRinnovo()).statoHTTP, 200)
    verificaUguali("scadeIl senza millisecondi si legge lo stesso",
                   leggi(200, corpoRinnovo(scadeIl: "2026-10-05T01:15:00Z")).esito,
                   .daCaricare(url: urlBuono, contentType: "video/quicktime", tokenScadeIl: Date(timeIntervalSince1970: 1_791_162_900)))
    verificaUguali("content-type con parametri dei codec (come lo scrive MediaRecorder) è ammesso",
                   leggi(200, corpoRinnovo(contentType: "video/mp4;codecs=avc1.42E01E,mp4a.40.2")).esito,
                   .daCaricare(url: urlBuono, contentType: "video/mp4;codecs=avc1.42E01E,mp4a.40.2", tokenScadeIl: scadenzaToken!))
    // 200 arrivato / annullato
    verificaUguali("200 arrivato", leggi(200, jsonDati(["stato": "arrivato"])).esito, .arrivato)
    verificaUguali("200 annullato", leggi(200, jsonDati(["stato": "annullato"])).esito, .annullato)
    verificaUguali("200 arrivato con campi in più (un server più nuovo) si legge lo stesso",
                   leggi(200, jsonDati(["stato": "arrivato", "altro": 1])).esito, .arrivato)

    // 200 ma fuori forma → transitorio
    let fuoriSchema = KVRispostaRinnovo.Esito.transitorio(.fuoriSchema)
    verificaUguali("200 con uno stato che non conosciamo → fuori schema", leggi(200, jsonDati(["stato": "boh"])).esito, fuoriSchema)
    verificaUguali("200 senza `stato` → fuori schema", leggi(200, jsonDati(["x": 1])).esito, fuoriSchema)
    verificaUguali("200 con `stato` non stringa → fuori schema", leggi(200, jsonDati(["stato": 1])).esito, fuoriSchema)
    verificaUguali("200 con un array → fuori schema", leggi(200, dati("[]")).esito, fuoriSchema)
    verificaUguali("200 con un corpo che non è JSON → fuori schema", leggi(200, dati("<html>")).esito, fuoriSchema)
    verificaUguali("200 con corpo vuoto → fuori schema", leggi(200, Data()).esito, fuoriSchema)
    verificaUguali("da-caricare senza `caricamento` → fuori schema", leggi(200, jsonDati(["stato": "da-caricare", "scadeIl": "2026-10-05T01:15:00Z"])).esito, fuoriSchema)
    verificaUguali("da-caricare con protocollo tus → fuori schema", leggi(200, corpoRinnovo(protocollo: "tus")).esito, fuoriSchema)
    verificaUguali("da-caricare con URL http in Release → fuori schema", leggi(200, corpoRinnovo(url: "http://abcdefghij.supabase.co/x")).esito, fuoriSchema)
    verificaUguali("da-caricare con un host che non è Supabase → fuori schema (una pagina compromessa non sposta il video)",
                   leggi(200, corpoRinnovo(url: "https://evil.example.com/x")).esito, fuoriSchema)
    verificaUguali("da-caricare con l'host dell'applicazione al posto dello Storage → fuori schema",
                   leggi(200, corpoRinnovo(url: "https://app.kidville.it/x")).esito, fuoriSchema)
    verificaUguali("da-caricare con credenziali nell'URL → fuori schema",
                   leggi(200, corpoRinnovo(url: "https://abcdefghij.supabase.co@evil.com/x")).esito, fuoriSchema)
    verificaUguali("da-caricare senza `intestazioni` → fuori schema",
                   leggi(200, jsonDati(["stato": "da-caricare", "scadeIl": "2026-10-05T01:15:00Z",
                                        "caricamento": ["protocollo": "put", "url": urlBuono.absoluteString]])).esito, fuoriSchema)
    verificaUguali("da-caricare con content-type non stringa → fuori schema", leggi(200, corpoRinnovo(contentType: 7)).esito, fuoriSchema)
    verificaUguali("da-caricare con content-type vuoto → fuori schema", leggi(200, corpoRinnovo(contentType: "")).esito, fuoriSchema)
    verificaUguali("da-caricare con content-type che non è un tipo MIME → fuori schema", leggi(200, corpoRinnovo(contentType: "quicktime")).esito, fuoriSchema)
    verificaUguali("da-caricare con uno spazio dopo il sottotipo («video/mp4 ») → fuori schema (il server lo rifiuta, e non si taglia)",
                   leggi(200, corpoRinnovo(contentType: "video/mp4 ")).esito, fuoriSchema)
    verificaUguali("da-caricare con uno spazio dopo la barra («video/ mp4») → fuori schema",
                   leggi(200, corpoRinnovo(contentType: "video/ mp4")).esito, fuoriSchema)
    verificaUguali("da-caricare con un a capo nel content-type (iniezione in un'intestazione) → fuori schema",
                   leggi(200, corpoRinnovo(contentType: "video/mp4\r\nx-upsert: true")).esito, fuoriSchema)
    verificaUguali("da-caricare senza scadeIl → fuori schema",
                   leggi(200, jsonDati(["stato": "da-caricare", "caricamento": ["protocollo": "put", "url": urlBuono.absoluteString,
                                                                                  "intestazioni": ["content-type": "video/mp4"]]])).esito, fuoriSchema)
    verificaUguali("da-caricare con scadeIl illeggibile → fuori schema", leggi(200, corpoRinnovo(scadeIl: "domani")).esito, fuoriSchema)
    verificaUguali("da-caricare con scadeIl non stringa → fuori schema", leggi(200, corpoRinnovo(scadeIl: 1_791_162_900)).esito, fuoriSchema)

    // gli altri stati
    verificaUguali("404 → token non trovato", leggi(404).esito, .nonTrovato)
    verificaUguali("404 con un corpo JSON qualunque → token non trovato", leggi(404, jsonDati(["error": "VIDEO_NON_TROVATO"])).esito, .nonTrovato)
    verificaUguali("429 con Retry-After 90", leggi(429, ra: "90").esito, .limitato(retryAfter: 90))
    verificaUguali("429 senza Retry-After", leggi(429).esito, .limitato(retryAfter: nil))
    for stato in [500, 502, 503, 504, 599] {
        verificaUguali("\(stato) → transitorio (server)", leggi(stato).esito, .transitorio(.server))
    }
    verificaUguali("nessuna risposta → transitorio (rete)", leggi(nil).esito, .transitorio(.rete))
    verificaUguali("… con stato HTTP 0", leggi(nil).statoHTTP, 0)
    for stato in [201, 202, 204, 301, 302, 400, 401, 403, 405, 409] {
        verificaUguali("\(stato): la porta risponde solo 200, 404, 429 e 5xx → fuori schema", leggi(stato, corpoRinnovo()).esito, fuoriSchema)
    }
    // Debug: l'host di sviluppo si ammette solo in Debug
    verificaUguali("URL di PUT su localhost: in Release → fuori schema",
                   leggi(200, corpoRinnovo(url: "http://localhost:4310/put/x"), ambiente: .release).esito, fuoriSchema)
    verificaUguali("URL di PUT su localhost: in Debug → nuova PUT",
                   leggi(200, corpoRinnovo(url: "http://localhost:4310/put/x"), ambiente: .debug).esito,
                   .daCaricare(url: URL(string: "http://localhost:4310/put/x")!, contentType: "video/quicktime", tokenScadeIl: scadenzaToken!))

    sezione("§8.2 — come si legge l'esito di un rinnovo nel log (da-caricare · arrivato · annullato · negato · tetto · rete · server)")
    verificaUguali("da-caricare", leggi(200, corpoRinnovo()).esitoLog, .daCaricare)
    verificaUguali("arrivato", leggi(200, jsonDati(["stato": "arrivato"])).esitoLog, .arrivato)
    verificaUguali("annullato", leggi(200, jsonDati(["stato": "annullato"])).esitoLog, .annullato)
    verificaUguali("404 → negato", leggi(404).esitoLog, .negato)
    verificaUguali("429 → tetto", leggi(429).esitoLog, .tetto)
    verificaUguali("nessuna risposta → rete", leggi(nil).esitoLog, .rete)
    verificaUguali("500 → server", leggi(500).esitoLog, .server)
    verificaUguali("corpo fuori schema → server", leggi(200, dati("x")).esitoLog, .server)

    sezione("§4.5 — decisione sul rinnovo: nuova PUT, tetto ciclico, 404, 429, transitorio")
    func contesto(_ causa: KVCausaRinnovo = .putRifiutata, consecutivi: Int = 0, tentativo: Int = 1, token: Bool = false, casuale: Double = 0.5) -> KVContestoRinnovo {
        return KVContestoRinnovo(causa: causa, rinnoviConsecutivi: consecutivi, tentativo: tentativo, tokenPiuRecenteDisponibile: token, adesso: dopo(1000), casuale: casuale)
    }
    let daCaricare = KVRispostaRinnovo(esito: .daCaricare(url: urlBuono, contentType: "video/quicktime", tokenScadeIl: scadenzaToken!), statoHTTP: 200)
    func nuovaPut(_ consecutivi: Int) -> KVDecisioneRinnovo {
        return .nuovaPut(url: urlBuono, contentType: "video/quicktime", urlScadeIl: dopo(1000 + 7200), tokenScadeIl: scadenzaToken!, rinnoviConsecutivi: consecutivi)
    }
    verificaUguali("200 da-caricare: nuova PUT, l'URL vale 7.200 s dal momento della RICEZIONE, rinnoviConsecutivi + 1",
                   KVPoliticaCaricamento.decidiRinnovo(daCaricare, contesto: contesto(consecutivi: 0)), nuovaPut(1))
    verificaUguali("… secondo rinnovo consecutivo", KVPoliticaCaricamento.decidiRinnovo(daCaricare, contesto: contesto(consecutivi: 1)), nuovaPut(2))
    verificaUguali("… terzo rinnovo consecutivo: l'ultimo ammesso", KVPoliticaCaricamento.decidiRinnovo(daCaricare, contesto: contesto(consecutivi: 2)), nuovaPut(3))
    verificaUguali("… il quarto (oltre 3 senza un 2xx) → fallito RINNOVO_CICLICO",
                   KVPoliticaCaricamento.decidiRinnovo(daCaricare, contesto: contesto(consecutivi: 3)), .fallito(.rinnovoCiclico))
    verificaUguali("… e a maggior ragione oltre", KVPoliticaCaricamento.decidiRinnovo(daCaricare, contesto: contesto(consecutivi: 50)), .fallito(.rinnovoCiclico))
    verificaUguali("rinnovo fatto solo perché l'URL è vecchio: non conta (nuova PUT, contatore invariato)",
                   KVPoliticaCaricamento.decidiRinnovo(daCaricare, contesto: contesto(.urlVecchio, consecutivi: 0)), nuovaPut(0))
    verificaUguali("… nemmeno dopo tre rinnovi dopo PUT rifiutate: contatore invariato a 3",
                   KVPoliticaCaricamento.decidiRinnovo(daCaricare, contesto: contesto(.urlVecchio, consecutivi: 3)), nuovaPut(3))
    verificaUguali("… e mai ciclico, per quanto sia alto: un'ora di Storage fuori uso non fa fallire il video",
                   KVPoliticaCaricamento.decidiRinnovo(daCaricare, contesto: contesto(.urlVecchio, consecutivi: 99)), nuovaPut(99))
    verificaUguali("200 arrivato → inviato (gia-arrivato)",
                   KVPoliticaCaricamento.decidiRinnovo(KVRispostaRinnovo(esito: .arrivato, statoHTTP: 200), contesto: contesto()), .inviato)
    verificaUguali("200 arrivato conta anche oltre il tetto ciclico",
                   KVPoliticaCaricamento.decidiRinnovo(KVRispostaRinnovo(esito: .arrivato, statoHTTP: 200), contesto: contesto(consecutivi: 9)), .inviato)
    verificaUguali("200 annullato → annullato (ANNULLATO_DAL_SERVER)",
                   KVPoliticaCaricamento.decidiRinnovo(KVRispostaRinnovo(esito: .annullato, statoHTTP: 200), contesto: contesto()), .annullato(.annullatoDalServer))
    let nonTrovato = KVRispostaRinnovo(esito: .nonTrovato, statoHTTP: 404)
    verificaUguali("404 con un token più recente nel Portachiavi → si riprova con quello",
                   KVPoliticaCaricamento.decidiRinnovo(nonTrovato, contesto: contesto(token: true)), .riprovaConTokenPiuRecente)
    verificaUguali("404 senza un token più recente → fallito TOKEN_NON_VALIDO",
                   KVPoliticaCaricamento.decidiRinnovo(nonTrovato, contesto: contesto(token: false)), .fallito(.tokenNonValido))

    func attendi(_ d: KVDecisioneRinnovo) -> TimeInterval? { if case .attendi(let s) = d { return s }; return nil }
    func attesaDi(_ r: KVRispostaRinnovo, tentativo: Int = 1, casuale: Double = 0.5) -> TimeInterval? {
        return attendi(KVPoliticaCaricamento.decidiRinnovo(r, contesto: contesto(tentativo: tentativo, casuale: casuale)))
    }
    verifica("429 con Retry-After 600 → attesa 600 s",
             vicini(attesaDi(KVRispostaRinnovo(esito: .limitato(retryAfter: 600), statoHTTP: 429)) ?? -1, 600))
    verifica("429 con Retry-After 86400 → attesa 3.600 s (tetto)",
             vicini(attesaDi(KVRispostaRinnovo(esito: .limitato(retryAfter: 86400), statoHTTP: 429)) ?? -1, 3600))
    verifica("429 senza Retry-After → l'attesa normale (30 s)",
             vicini(attesaDi(KVRispostaRinnovo(esito: .limitato(retryAfter: nil), statoHTTP: 429)) ?? -1, 30))
    verifica("429 con un Retry-After più corto dell'attesa → vince l'attesa",
             vicini(attesaDi(KVRispostaRinnovo(esito: .limitato(retryAfter: 5), statoHTTP: 429)) ?? -1, 30))
    for motivo in [KVMotivoTransitorio.rete, .server, .fuoriSchema] {
        let risposta = KVRispostaRinnovo(esito: .transitorio(motivo), statoHTTP: 0)
        verifica("transitorio (\(motivo)) al tentativo 1 → 30 s", vicini(attesaDi(risposta, tentativo: 1) ?? -1, 30))
        verifica("transitorio (\(motivo)) al tentativo 3 → 120 s", vicini(attesaDi(risposta, tentativo: 3) ?? -1, 120))
        verifica("transitorio (\(motivo)) al tentativo 30 → 900 s", vicini(attesaDi(risposta, tentativo: 30) ?? -1, 900))
    }
    verifica("il transitorio del rinnovo non porta alcun Retry-After: nessuna attesa più lunga",
             vicini(attesaDi(KVRispostaRinnovo(esito: .transitorio(.server), statoHTTP: 503), tentativo: 1, casuale: 0) ?? -1, 24))
}

// MARK: - 5b. `contentTypeAmmesso` = `MIME_DICHIARABILE` del server

/// Il `content-type` che il nativo lascia passare sta DENTRO ciò che il server accetta. La tabella è l'uscita della regex vera del server
/// (`src/lib/media/video/contratto.ts:743`: `/^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}(?:\s*;[^\n]*)?$/i`) valutata in Node su
/// ciascuna stringa, più i due divieti del nativo (da 3 a 255 byte, nessun carattere di controllo). Un valore che il nativo accetta e il server no non
/// resta un dettaglio: `comeDizionarioPonte` lo darebbe al JS e la rilettura zod, che è tutto o niente, farebbe cadere l'INTERO `elenco`.
func provaContentType() {
    sezione("`contentTypeAmmesso` è la regex del server (MIME_DICHIARABILE), più 3-255 byte e niente caratteri di controllo")
    let casi: [(String, Bool)] = [
        ("video/mp4", true),
        ("video/quicktime", true),
        ("VIDEO/MP4", true),
        ("Video/QuickTime", true),
        ("video/x-m4v", true),
        ("video/3gpp", true),
        ("application/octet-stream", true),
        ("video/mp4;codecs=avc1.42E01E,mp4a.40.2", true),
        ("video/mp4; codecs=\"avc1.42E01E\"", true),
        ("video/mp4 ;codecs=x", true),
        ("video/mp4   ;x", true),
        ("video/mp4;", true),
        ("video/mp4 ;", true),
        ("video/mp4 ", false),
        (" video/mp4", false),
        ("video/ mp4", false),
        ("video /mp4", false),
        ("video/mp4  ", false),
        ("video/mp4 x", false),
        ("video/mp4 codecs", false),
        ("video/mp4\u{00A0};x", true),
        ("video/mp4\u{00A0}", false),
        ("video/mp4\u{3000};x", true),
        ("video/mp4\u{FEFF};x", true),
        ("video/mp4\u{2003};x", true),
        ("video/mp4\u{0085};x", false),
        ("video", false),
        ("video/", false),
        ("/mp4", false),
        ("a/b", true),
        ("a/", false),
        ("/b", false),
        ("1/2", true),
        ("a/b;", true),
        ("+a/b", false),
        ("a/+b", false),
        ("-a/b", false),
        ("a-b/c-d", true),
        ("a.b/c.d", true),
        ("a_b/c_d", true),
        ("a+b/c+d", true),
        ("a!b/c#d", true),
        ("a$b/c&d", true),
        ("a^b/c^d", true),
        ("a b/c", false),
        ("a/b c", false),
        ("a/b/c", false),
        ("a//b", false),
        ("a/b;c;d", true),
        ("a/b;c/d", true),
        ("a/b ; c", true),
        ("video/mp4;codecs=\u{00E9}", true),
        ("video/mp4;\u{1F600}", true),
        ("v\u{00EF}deo/mp4", false),
        ("video/m\u{00F6}p4", false),
        ("vide\u{212A}/mp4", false),
        ("video/mp4\u{017F}", false),
        ("\u{0130}/x", false),
        ("video/mp4;a\u{0009}b", false),
        ("video/mp4\u{0009};x", false),
        ("video/mp4;a\u{000D}b", false),
        ("video/mp4\u{000A}", false),
        ("video/mp4;a\u{000A}b", false),
        ("video/mp4\u{0000}", false),
        ("", false),
        ("ab", false),
        ("abc", false),
        ("quicktime", false),
        ("boh", false),
    ]
    for (testo, atteso) in casi {
        let visibile = testo.unicodeScalars.map { $0.value < 0x20 || $0.value > 0x7E ? "\\u{\(String($0.value, radix: 16, uppercase: true))}" : String($0) }.joined()
        verificaUguali("«\(visibile)» → \(atteso)", KVPoliticaCaricamento.contentTypeAmmesso(testo), atteso)
    }
    // I confini di lunghezza, che la tabella non può scrivere per esteso.
    let meta = String(repeating: "x", count: 127)
    verifica("127 caratteri per metà (il massimo del server): ammesso", KVPoliticaCaricamento.contentTypeAmmesso(meta + "/" + meta))
    verifica("128 caratteri nel tipo: respinto", !KVPoliticaCaricamento.contentTypeAmmesso(meta + "x/y"))
    verifica("128 caratteri nel sottotipo: respinto", !KVPoliticaCaricamento.contentTypeAmmesso("x/" + meta + "y"))
    verifica("255 byte in tutto (127 + / + 127 non basta a 255: si completa con i parametri): ammesso", KVPoliticaCaricamento.contentTypeAmmesso("x/y;" + String(repeating: "z", count: 251)))
    verifica("256 byte in tutto: respinto", !KVPoliticaCaricamento.contentTypeAmmesso("x/y;" + String(repeating: "z", count: 252)))
    verifica("parametri di 300 caratteri: respinti (oltre 255 byte)", !KVPoliticaCaricamento.contentTypeAmmesso("video/mp4;" + String(repeating: "p", count: 300)))
    verifica("i byte contano, non i caratteri: 130 lettere accentate nei parametri fanno 260 byte e sono respinte",
             !KVPoliticaCaricamento.contentTypeAmmesso("video/mp4;" + String(repeating: "\u{00E8}", count: 130)))
    // Tutto ciò che il nativo ammette passa per il ponte com'è; tutto il resto diventa il ripiego.
    for (testo, atteso) in casi {
        let nelPonte = voce(1, mime: testo).comeDizionarioPonte(byteInviati: 0)["mime"] as? String
        verificaUguali("sul ponte, «\(testo.unicodeScalars.map { $0.value < 0x20 || $0.value > 0x7E ? "?" : String($0) }.joined())» → \(atteso ? "se stesso" : "il ripiego")",
                       nelPonte, atteso ? testo : KVPoliticaCaricamento.mimeDiRipiego)
    }
}

// MARK: - 6. S0 — la soglia dei 10 minuti

func provaSoglia() {
    sezione("S0 — rinnovo prima di ogni PUT se l'URL è stato firmato da PIÙ di 10 minuti")
    let T = KVPoliticaCaricamento.self
    let firmato = dopo(0)
    let scade = firmato.addingTimeInterval(7200)
    func serve(_ trascorsi: TimeInterval, scadenza: Date? = nil) -> Bool {
        return T.rinnovoProattivoNecessario(urlScadeIl: scadenza ?? scade, adesso: firmato.addingTimeInterval(trascorsi))
    }
    verifica("appena firmato (0 s): niente rinnovo", !serve(0))
    verifica("dopo 1 minuto: niente rinnovo", !serve(60))
    verifica("dopo 9 minuti e 59 secondi: niente rinnovo", !serve(599))
    verifica("esattamente 10 minuti: ancora niente («più di»)", !serve(600))
    verifica("10 minuti e un millesimo: rinnovo", serve(600.001))
    verifica("10 minuti e un secondo: rinnovo", serve(601))
    verifica("un'ora: rinnovo", serve(3600))
    verifica("1 ora e 59 minuti (l'URL sta per scadere): rinnovo", serve(7140))
    verifica("scaduto da un pezzo: rinnovo", serve(100_000))
    verifica("l'orologio è tornato indietro (adesso prima della firma): niente rinnovo", !serve(-300))
    // L'istante di firma si ricava dalla scadenza: se la scadenza è un'altra, cambia.
    verifica("la scadenza spostata di 10 minuti avanti sposta la soglia: a 1.199 s il rinnovo non serve ancora, a 1.201 sì",
             !serve(1199, scadenza: scade.addingTimeInterval(600)) && serve(1201, scadenza: scade.addingTimeInterval(600)))
    // Scadenza ignota (e dopo un rifiuto della PUT il motore la azzera): si rinnova sempre, qualunque sia l'ora.
    for trascorsi in [0.0, 1, 599, 600, 601, 7200, 100_000] as [TimeInterval] {
        verifica("scadenza ignota (nil), a \(Int(trascorsi)) s: si rinnova prima della PUT (non si spedisce su un URL di cui non si sa l'età)",
                 T.rinnovoProattivoNecessario(urlScadeIl: nil, adesso: firmato.addingTimeInterval(trascorsi)))
    }
    verificaUguali("la soglia scritta è 600 secondi", T.sogliaRinnovoProattivoSecondi, 600)
    verificaUguali("la validità dell'URL scritta è 7.200 secondi", T.validitaUrlPutSecondi, 7200)
    verificaUguali("il tetto dei rinnovi consecutivi scritto è 3", T.tettoRinnoviConsecutivi, 3)
}

// MARK: - 7. §9 — gli host ammessi

func provaHost() {
    let T = KVPoliticaCaricamento.self
    sezione("§9 — host ammessi in Release: PUT solo https://*.supabase.co, rinnovo e registro solo https://app.kidville.it")
    func ammesso(_ testo: String, _ uso: KVUsoIndirizzo, _ ambiente: KVAmbienteBuild) -> Bool {
        return T.indirizzoAmmesso(testo, uso: uso, ambiente: ambiente) != nil
    }
    let putBuoni = [
        "https://abcdefghij.supabase.co/storage/v1/object/upload/sign/video_originals/a/b.mov?token=eyJhbGciOi.x.y",
        "https://abcdefghij.supabase.co",
        "HTTPS://ABCDEFGHIJ.SUPABASE.CO/x",
        "https://abcdefghij.supabase.co:443/x",
        "https://a.b.supabase.co/x",
        "https://abcdefghij.supabase.co/x?a=b&c=d#frammento",
    ]
    for testo in putBuoni { verifica("PUT ammessa in Release: \(testo.prefix(50))", ammesso(testo, .put, .release)) }
    let putCattivi = [
        "http://abcdefghij.supabase.co/x",
        "https://supabase.co/x",
        "https://.supabase.co/x",
        "https://evilsupabase.co/x",
        "https://abcdefghij.supabase.co.evil.com/x",
        "https://evil.com/.supabase.co",
        "https://evil.com/x?h=.supabase.co",
        "https://abcdefghij.supabase.co@evil.com/x",
        "https://evil.com@abcdefghij.supabase.co/x",
        "https://abcdefghij.supabase.co\\@evil.com/x",
        "https://abcdefghij.supabase.co:8443/x",
        "https://abcdefghij.supabase.co:0/x",
        "https://abcdefghij.supabase.co:65536/x",
        "https://abcdefghij.supabase.co:99999/x",
        "https://abcdefghij.supabase.co:abc/x",
        "https://abcdefghij.supabase.co:/x",
        "https://abcdefghij.supabase.co:443:443/x",
        "https://abcdefghij.supabase.co%2eevil.com/x",
        "https://abcdefghij.supabase.co:443@evil.com/x",
        "https://-abc.supabase.co/x",
        "https://abc..supabase.co/x",
        "https://app.kidville.it/x",
        "https://localhost/x",
        "https://127.0.0.1/x",
        "http://localhost:3101/x",
        "http://10.0.2.2:3101/x",
        "https://[::1]/x",
        "ftp://abcdefghij.supabase.co/x",
        "//abcdefghij.supabase.co/x",
        "abcdefghij.supabase.co/x",
        "https://",
        "https:///x",
        "",
        "https://abcdefghij.supabase.co/x y",
        "https://abcdefghij.supabase.co/x\n",
        "https://abcdefghij.supabase.co/\u{00E9}",
        " https://abcdefghij.supabase.co/x",
        "https://abcdefghij.supabase.co/" + String(repeating: "a", count: 2100),
    ]
    for testo in putCattivi { verifica("PUT respinta in Release: \(testo.prefix(50).replacingOccurrences(of: "\n", with: "\\n"))", !ammesso(testo, .put, .release)) }

    let appBuoni = ["https://app.kidville.it/api/video-uploads/rinnovo", "https://app.kidville.it/api/logs", "https://app.kidville.it",
                    "https://APP.KIDVILLE.IT/api/logs", "https://app.kidville.it:443/api/logs"]
    for testo in appBuoni {
        verifica("rinnovo ammesso in Release: \(testo)", ammesso(testo, .rinnovo, .release))
        verifica("registro ammesso in Release: \(testo)", ammesso(testo, .registro, .release))
    }
    let appCattivi = ["http://app.kidville.it/api/logs", "https://kidville.it/api/logs", "https://evil.app.kidville.it/api/logs",
                      "https://app.kidville.it.evil.com/", "https://abcdefghij.supabase.co/api/logs", "https://app.kidville.it:8080/api/logs",
                      "http://localhost:3101/api/logs", "http://10.0.2.2:3101/api/logs", "https://app.kidville.it@evil.com/api/logs",
                      "https://evil.com/app.kidville.it", "https://xapp.kidville.it/api/logs", ""]
    for testo in appCattivi {
        verifica("rinnovo respinto in Release: \(testo.prefix(50))", !ammesso(testo, .rinnovo, .release))
        verifica("registro respinto in Release: \(testo.prefix(50))", !ammesso(testo, .registro, .release))
    }

    sezione("§9 — in Debug, in più: http(s) verso localhost, 127.0.0.1 e 10.0.2.2, con qualunque porta")
    let sviluppo = ["http://localhost:3101/api/logs", "http://127.0.0.1:4310/put/x", "http://10.0.2.2:3101/api/video-uploads/rinnovo",
                    "https://localhost:8443/x", "http://localhost/x", "http://LOCALHOST:3101/x", "http://localhost:1/x", "http://localhost:65535/x"]
    for testo in sviluppo {
        for uso in [KVUsoIndirizzo.put, .rinnovo, .registro] {
            verifica("Debug ammette \(testo) per \(uso)", ammesso(testo, uso, .debug))
            verifica("Release respinge \(testo) per \(uso)", !ammesso(testo, uso, .release))
        }
    }
    for testo in putBuoni { verifica("Debug ammette ancora la PUT di Release: \(testo.prefix(40))", ammesso(testo, .put, .debug)) }
    for testo in appBuoni { verifica("Debug ammette ancora il rinnovo di Release: \(testo)", ammesso(testo, .rinnovo, .debug)) }
    let sviluppoCattivo = ["http://localhost.evil.com/x", "http://evil.com@localhost/x", "http://localhost@evil.com/x", "http://10.0.2.3/x",
                           "http://10.0.2.2.evil.com/x", "http://192.168.1.5:3101/x", "http://0.0.0.0/x", "http://[::1]:3101/x", "http://[::1]/x",
                           "http://abcdefghij.supabase.co/x", "http://app.kidville.it/api/logs", "http://localhost:99999/x", "http://localhost:0/x",
                           "http://localhost:abc/x", "http://localhost:/x", "http://127.1/x", "http://2130706433/x", "http://localhost\\@evil.com/x"]
    for testo in sviluppoCattivo {
        verifica("Debug respinge \(testo)", !ammesso(testo, .put, .debug) && !ammesso(testo, .rinnovo, .debug) && !ammesso(testo, .registro, .debug))
    }
    // Il valore restituito è l'URL da usare, con lo stesso host.
    verificaUguali("l'URL restituito ha l'host letto", T.indirizzoAmmesso("https://ABCDEFGHIJ.supabase.co/x?token=1", uso: .put, ambiente: .release)?.host?.lowercased(), "abcdefghij.supabase.co")
    verificaUguali("in Debug la porta si conserva", T.indirizzoAmmesso("http://10.0.2.2:3101/api/logs", uso: .registro, ambiente: .debug)?.port, 3101)
    verificaUguali("la query si conserva (è la firma)", T.indirizzoAmmesso("https://abcdefghij.supabase.co/x?token=abc.def", uso: .put, ambiente: .release)?.query, "token=abc.def")
}

// MARK: - 8. Il ponte verso il JavaScript

func voce(_ n: Int, nome: String = "gita.mov", byte: Int64 = 1000, creatoIl: Date = t0, tokenScadeIl: Date? = nil, utente: Int = 1,
          origine: KVOrigineCaricamento = .galleria, mime: String = "video/quicktime") -> KVVoceCoda {
    return KVVoceCoda(jobId: uuid(n), intentId: uuid(100 + n), utenteId: uuid(utente), scuolaId: uuid(900), nome: nome,
                      file: KVCodaCaricamenti.percorsoRelativoCopia(jobId: uuid(n), estensione: "mov"), byte: byte, mime: mime,
                      origine: origine, urlScadeIl: creatoIl.addingTimeInterval(7200),
                      tokenScadeIl: tokenScadeIl ?? creatoIl.addingTimeInterval(48 * 3600), creatoIl: creatoIl)
}

func provaPonte() {
    let T = KVPoliticaCaricamento.self
    sezione("ponte JS — la voce com'è vista da `elenco`: quattordici campi, null presenti, date con la Z")
    var v = voce(1, nome: "Gita al mare.mov", byte: 52_000_000)
    v.stato = .inAttesa
    v.codice = .rete
    v.tentativi = 3
    v.rinnovi = 1
    v.aggiornatoIl = dopo(90)
    let d = v.comeDizionarioPonte(byteInviati: 12_000_000)
    let attese = Set(["jobId", "intentId", "utenteId", "scuolaId", "nome", "mime", "stato", "byteInviati", "byteTotali", "tentativi",
                      "rinnovi", "codice", "creatoIl", "aggiornatoIl"])
    verificaUguali("esattamente i quattordici campi di CaricamentoNativo", Set(d.keys), attese)
    verificaUguali("jobId minuscolo", d["jobId"] as? String, "abcdef12-3456-4abc-9def-000000000001")
    verificaUguali("intentId minuscolo", d["intentId"] as? String, "abcdef12-3456-4abc-9def-000000000101")
    verificaUguali("stato", d["stato"] as? String, "in-attesa")
    verificaUguali("codice", d["codice"] as? String, "RETE")
    verificaUguali("nome", d["nome"] as? String, "Gita al mare.mov")
    verificaUguali("byteInviati", (d["byteInviati"] as? NSNumber)?.int64Value, 12_000_000)
    verificaUguali("byteTotali", (d["byteTotali"] as? NSNumber)?.int64Value, 52_000_000)
    verificaUguali("tentativi", (d["tentativi"] as? NSNumber)?.intValue, 3)
    verificaUguali("rinnovi", (d["rinnovi"] as? NSNumber)?.intValue, 1)
    verificaUguali("creatoIl: ISO con la Z, al secondo", d["creatoIl"] as? String, "2026-10-03T01:15:00Z")
    verificaUguali("aggiornatoIl: ISO con la Z, al secondo", d["aggiornatoIl"] as? String, "2026-10-03T01:16:30Z")

    let senzaCodice = voce(2).comeDizionarioPonte(byteInviati: 0)
    verifica("`codice` assente → il campo C'È e vale NSNull (non una chiave in meno)", senzaCodice["codice"] is NSNull && senzaCodice.keys.contains("codice"))
    let testoJSON = String(data: try! JSONSerialization.data(withJSONObject: senzaCodice, options: [.sortedKeys]), encoding: .utf8) ?? ""
    verifica("serializzato, `codice` è `null`", testoJSON.contains("\"codice\":null"), testoJSON)
    verifica("il dizionario è serializzabile in JSON", JSONSerialization.isValidJSONObject(d))
    let forma = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"
    verifica("le date non hanno offset numerici né frazioni (zod 4 rifiuta +0000 e +00)",
             [d["creatoIl"], d["aggiornatoIl"], senzaCodice["creatoIl"]].allSatisfy { ($0 as? String)?.range(of: forma, options: .regularExpression) != nil })
    verifica("tutti gli uuid sono minuscoli di 36 caratteri",
             ["jobId", "intentId", "utenteId", "scuolaId"].allSatisfy {
                 let s = d[$0] as? String ?? ""
                 return s.count == 36 && s == s.lowercased()
             })
    for stato in KVStatoCaricamento.allCases {
        var w = voce(3)
        w.stato = stato
        verificaUguali("stato \(stato.rawValue) passa com'è", w.comeDizionarioPonte(byteInviati: 0)["stato"] as? String, stato.rawValue)
    }
    for codice in KVCodiceCaricamento.allCases {
        var w = voce(3)
        w.codice = codice
        verificaUguali("codice \(codice.rawValue) passa com'è", w.comeDizionarioPonte(byteInviati: 0)["codice"] as? String, codice.rawValue)
    }

    sezione("ponte JS — byte inviati, nome da 1 a 255, MIME sempre valido")
    func inviati(_ stato: KVStatoCaricamento, _ passati: Int64, byte: Int64 = 1000) -> Int64? {
        var w = voce(4, byte: byte)
        w.stato = stato
        return (w.comeDizionarioPonte(byteInviati: passati)["byteInviati"] as? NSNumber)?.int64Value
    }
    verificaUguali("byte inviati negativi → 0", inviati(.inInvio, -50), 0)
    verificaUguali("byte inviati oltre il totale → il totale", inviati(.inInvio, 5000), 1000)
    verificaUguali("byte inviati nel mezzo → quelli", inviati(.inInvio, 400), 400)
    verificaUguali("inviato → tutto, qualunque sia l'avanzamento in memoria", inviati(.inviato, 0), 1000)
    verificaUguali("in-coda a zero", inviati(.inCoda, 0), 0)
    verificaUguali("byteTotali non scende sotto 1", (voce(5, byte: 0).comeDizionarioPonte(byteInviati: 0)["byteTotali"] as? NSNumber)?.int64Value, 1)

    func nomeDel(_ nome: String) -> String? { voce(6, nome: nome).comeDizionarioPonte(byteInviati: 0)["nome"] as? String }
    verificaUguali("nome vuoto → ripiego", nomeDel(""), "Video")
    verificaUguali("nome di soli spazi e a capo → ripiego", nomeDel("  \n\t "), "Video")
    verificaUguali("nome con spazi attorno → ripulito", nomeDel("  film.mov  "), "film.mov")
    verificaUguali("nome di 255 caratteri → intatto", nomeDel(String(repeating: "a", count: 255)), String(repeating: "a", count: 255))
    verificaUguali("nome di 256 caratteri → tagliato a 255", nomeDel(String(repeating: "a", count: 256)), String(repeating: "a", count: 255))
    verificaUguali("nome di 1.000 caratteri → tagliato a 255", nomeDel(String(repeating: "b", count: 1000))?.utf16.count, 255)
    // Una faccina sono DUE unità UTF-16: a 254 + una faccina si taglia prima della faccina, non a metà.
    let conFaccina = String(repeating: "a", count: 254) + "\u{1F600}"
    verificaUguali("254 caratteri + una faccina (256 unità UTF-16): si taglia PRIMA della faccina", nomeDel(conFaccina), String(repeating: "a", count: 254))
    verificaUguali("253 caratteri + una faccina (255 unità): intatto", nomeDel(String(repeating: "a", count: 253) + "\u{1F600}"),
                   String(repeating: "a", count: 253) + "\u{1F600}")
    verificaUguali("il nome tagliato non ha mai più di 255 unità UTF-16, qualunque sia la posizione delle faccine",
                   (200...260).allSatisfy { (nomeDel(String(repeating: "\u{1F600}", count: $0))?.utf16.count ?? 999) <= 255 }, true)
    verificaUguali("nome con lettere accentate conta le unità, non i byte", nomeDel(String(repeating: "\u{00E8}", count: 255))?.utf16.count, 255)

    verificaUguali("MIME di un video: passa", voce(7, mime: "video/mp4").comeDizionarioPonte(byteInviati: 0)["mime"] as? String, "video/mp4")
    verificaUguali("MIME malformato → un MIME che il server accetta", voce(7, mime: "boh").comeDizionarioPonte(byteInviati: 0)["mime"] as? String, "video/mp4")
    verificaUguali("MIME vuoto → un MIME che il server accetta", voce(7, mime: "").comeDizionarioPonte(byteInviati: 0)["mime"] as? String, "video/mp4")

    sezione("ponte JS — mattoni: id, sha256, uuid, date")
    for ok in ["a", "A9", "abc123", "a_b-c", "abcdef12-3456-4abc-9def-000000000001", String(repeating: "x", count: 64)] {
        verifica("id elemento valido: \(ok.prefix(20))", T.idElementoValido(ok))
    }
    for no in ["", "_a", "-a", "a.b", "a/b", "../x", "a b", "a\u{00E8}", String(repeating: "x", count: 65), "a\n"] {
        verifica("id elemento respinto: «\(no.prefix(20).replacingOccurrences(of: "\n", with: "\\n"))»", !T.idElementoValido(no))
    }
    let hash = String(repeating: "ab", count: 32)
    verifica("sha256 valido: 64 esadecimali minuscoli", T.sha256Valido(hash))
    verifica("sha256 con una maiuscola → respinto (il JS non normalizza)", !T.sha256Valido(String(repeating: "AB", count: 32)))
    verifica("sha256 di 63 caratteri → respinto", !T.sha256Valido(String(hash.dropLast())))
    verifica("sha256 di 65 caratteri → respinto", !T.sha256Valido(hash + "a"))
    verifica("sha256 con un carattere non esadecimale → respinto", !T.sha256Valido(String(repeating: "g", count: 64)))
    verifica("sha256 vuoto → respinto", !T.sha256Valido(""))
    verificaUguali("uuid per il ponte: minuscolo", T.uuidPerIlPonte(UUID(uuidString: "ABCDEF01-2345-4678-9ABC-DEF012345678")!), "abcdef01-2345-4678-9abc-def012345678")
    verificaUguali("isoZ: l'ora del GO", T.isoZ(t0), "2026-10-03T01:15:00Z")
    verificaUguali("isoZ: l'epoca", T.isoZ(Date(timeIntervalSince1970: 0)), "1970-01-01T00:00:00Z")
    verificaUguali("isoZ: i decimi di secondo si scartano", T.isoZ(Date(timeIntervalSince1970: 1_790_990_100.9)), "2026-10-03T01:15:00Z")
    verificaUguali("leggiDataISO: con la Z", T.leggiDataISO("2026-10-03T01:15:00Z"), t0)
    verificaUguali("leggiDataISO: con i millisecondi", T.leggiDataISO("2026-10-03T01:15:00.250Z")?.timeIntervalSince1970, 1_790_990_100.25)
    verificaUguali("leggiDataISO: con l'offset +02:00", T.leggiDataISO("2026-10-03T03:15:00+02:00"), t0)
    verificaUguali("leggiDataISO: illeggibile", T.leggiDataISO("ieri"), nil)
    verificaUguali("nome di ripiego scritto", T.nomeDiRipiego, "Video")
    verificaUguali("MIME di ripiego scritto", T.mimeDiRipiego, "video/mp4")
    verificaUguali("lunghezza massima del nome scritta", T.lunghezzaMassimaNome, 255)
}

// MARK: - 9. La coda

func provaCoda() {
    sezione("§4.6 — la coda: cartelle, protezione, persistenza, forma del file")
    func nuova(registro: KVRegistroNativo? = nil) -> (KVCodaCaricamenti, URL) {
        let cartella = nuovaCartella().appendingPathComponent("KidvilleCaricamenti", isDirectory: true)
        return (KVCodaCaricamenti(cartella: cartella, orologio: { orologioProva }, registro: registro), cartella)
    }
    let (coda, cartella) = nuova()
    verifica("prima del caricamento la coda non è pronta e rifiuta di scrivere", !coda.pronta && coda.aggiungi(voce(1)) == .nonPronta)
    verificaUguali("primo caricamento: coda nuova", coda.carica(), .nuova)
    verifica("dopo il caricamento è pronta", coda.pronta)
    verifica("la cartella della coda esiste", esiste(cartella))
    verifica("la sottocartella file/ esiste", esiste(cartella.appendingPathComponent("file")))
    verifica("la sottocartella scelti/ esiste", esiste(cartella.appendingPathComponent("scelti")))
    for (nome, url) in [("coda", cartella), ("file", cartella.appendingPathComponent("file")), ("scelti", cartella.appendingPathComponent("scelti"))] {
        let escluso = (try? url.resourceValues(forKeys: [.isExcludedFromBackupKey]))?.isExcludedFromBackup
        verificaUguali("fuori dal backup (isExcludedFromBackup): \(nome)/", escluso, true)
        // Il sistema operativo di prova (macOS) può non riportare l'attributo di protezione: se lo riporta, deve essere quello giusto.
        if let protezione = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.protectionKey] as? FileProtectionType {
            verificaUguali("protezione completeUntilFirstUserAuthentication: \(nome)/", protezione, FileProtectionType.completeUntilFirstUserAuthentication)
        }
    }

    var v1 = voce(1, nome: "Primo.mov", byte: 1234)
    v1.urlScadeIl = dopo(7200)
    verificaUguali("aggiungi una voce in-coda", coda.aggiungi(v1), .aggiunta(v1))
    verificaUguali("la stessa voce (apertura ripetuta) → già presente, quella che c'è", coda.aggiungi(voce(1, nome: "Altro.mov", byte: 9)), .giaPresente(v1))
    var fuoriCartella = voce(2)
    fuoriCartella.file = "file/../x.mov"
    verificaUguali("percorso della copia fuori da file/ → non valida", coda.aggiungi(fuoriCartella), .nonValida)
    verificaUguali("peso nullo → non valida", coda.aggiungi(voce(3, byte: 0)), .nonValida)
    var nonInCoda = voce(4)
    nonInCoda.stato = .inInvio
    verificaUguali("una voce nasce in-coda: altro stato → non valida", coda.aggiungi(nonInCoda), .nonValida)
    verificaUguali("dopo i rifiuti c'è solo la prima", coda.tutte().map { $0.jobId }, [uuid(1)])

    // Il file
    let crudo = try! Data(contentsOf: coda.urlFileCoda)
    let radice = try! JSONSerialization.jsonObject(with: crudo) as! [String: Any]
    verificaUguali("coda.json: chiavi {versione, testi, voci}", Set(radice.keys), Set(["versione", "testi", "voci"]))
    verificaUguali("coda.json: versione 1", radice["versione"] as? Int, 1)
    let testi = radice["testi"] as? [String: String] ?? [:]
    verificaUguali("coda.json: testi col ripiego italiano", testi, ["titolo": "Kidville", "invio": "Invio dei video in corso",
                                                                      "attesaRete": "Il video è in attesa di rete: riprenderà da solo",
                                                                      "pausa": "Invio in pausa: tocca per riprendere"])
    let vociJSON = radice["voci"] as? [[String: Any]] ?? []
    verificaUguali("coda.json: una voce", vociJSON.count, 1)
    let campiVoce = Set(vociJSON.first?.keys.map { $0 } ?? [])
    let obbligatori = Set(["jobId", "intentId", "utenteId", "scuolaId", "nome", "file", "byte", "mime", "stato", "tentativi", "rinnovi",
                           "rinnoviConsecutivi", "tokenScadeIl", "origine", "creatoIl", "aggiornatoIl", "creatoInBackground", "urlScadeIl"])
    let facoltativi = Set(["codice", "prossimoTentativoIl"])
    verifica("la voce ha i campi di §4.6 e nessun altro", obbligatori.isSubset(of: campiVoce) && campiVoce.isSubset(of: obbligatori.union(facoltativi)),
             "campi: \(campiVoce.sorted())")
    let testoFile = String(data: crudo, encoding: .utf8) ?? ""
    verifica("NESSUN SEGRETO nel file: né un token kvr_, né un URL, né l'host dello Storage, né il nome dell'intestazione di rinnovo",
             !testoFile.contains("kvr_") && !testoFile.contains("https://") && !testoFile.contains("http://") && !testoFile.contains("supabase")
             && !testoFile.lowercased().contains("x-kidville-rinnovo"))
    verificaUguali("percorso della copia relativo", vociJSON.first?["file"] as? String, "file/abcdef12-3456-4abc-9def-000000000001.mov")
    verificaUguali("le date sono ISO con la Z", vociJSON.first?["creatoIl"] as? String, KVPoliticaCaricamento.isoZ(t0))

    // Il giro completo: un'altra istanza rilegge tutto
    let coda2 = KVCodaCaricamenti(cartella: cartella, orologio: { orologioProva })
    verificaUguali("un'altra istanza rilegge la coda: una voce", coda2.carica(), .caricata(voci: 1))
    verificaUguali("… identica in ogni campo (compresi i facoltativi assenti)", coda2.tutte(), [v1])

    sezione("§4.4 — la coda applica la tabella: nessun altro cambia lo stato")
    let (c, cart) = nuova()
    c.carica()
    let j = uuid(11)
    _ = c.aggiungi(voce(11, byte: 10))
    let copia = cart.appendingPathComponent("file/\(j.uuidString.lowercased()).mov")
    scrivi(copia, byte: 10)
    verificaUguali("voce sconosciuta", c.applica(.trasferimentoAvviato, a: uuid(999)), .voceAssente)
    // Un esito che arriva a una voce mai partita (l'app è morta fra l'accodamento e il task): due passi, in un colpo.
    _ = c.aggiungi(voce(12, byte: 10))
    let copia12 = cart.appendingPathComponent("file/\(uuid(12).uuidString.lowercased()).mov")
    scrivi(copia12, byte: 10)
    if case .applicata(let prima, let v, let passi, _) = c.applica(.inviato, a: uuid(12)) {
        verificaUguali("in-coda + inviato: la sequenza è `trasferimento avviato` e poi `inviato`", passi, [.trasferimentoAvviato, .inviato])
        verificaUguali("… dallo stato in-coda", prima, .inCoda)
        verificaUguali("… a inviato", v.stato, .inviato)
    } else { verifica("in-coda + inviato applicata", false) }
    verifica("… e la copia è cancellata", !esiste(copia12))
    orologioProva = orologioProva.addingTimeInterval(10)
    if case .applicata(let prima, let v, let passi, let persistita) = c.applica(.trasferimentoAvviato, a: j) {
        verificaUguali("in-coda → in-invio: lo stato di prima", prima, .inCoda)
        verificaUguali("in-coda → in-invio: lo stato di dopo", v.stato, .inInvio)
        verificaUguali("in-coda → in-invio: un passo", passi, [.trasferimentoAvviato])
        verifica("in-coda → in-invio: scritta su disco", persistita)
        verificaUguali("aggiornatoIl segue l'orologio", v.aggiornatoIl, orologioProva)
        verificaUguali("creatoIl non cambia", v.creatoIl, t0)
    } else { verifica("in-coda → in-invio applicata", false) }
    verificaUguali("un passo che la tabella non prevede (in-invio + ripreso) è rifiutato e non cambia nulla",
                   c.applica(.ripreso, a: j), .nonAmmessa(stato: .inInvio, evento: .ripreso))
    verificaUguali("… lo stato è ancora in-invio", c.voce(j)?.stato, .inInvio)
    c.aggiorna(j) { $0.prossimoTentativoIl = dopo(500); $0.tentativi = 1 }
    if case .applicata(_, let v, _, _) = c.applica(.inAttesa(.rete), a: j) {
        verificaUguali("in-invio → in-attesa: stato", v.stato, .inAttesa)
        verificaUguali("… col suo codice RETE", v.codice, .rete)
        verificaUguali("… e il prossimo tentativo si conserva (lo scrive il motore)", v.prossimoTentativoIl, dopo(500))
    } else { verifica("in-invio → in-attesa applicata", false) }
    if case .applicata(_, let v, let passi, _) = c.applica(.ripreso, a: j) {
        verificaUguali("in-attesa → in-invio: stato", v.stato, .inInvio)
        verificaUguali("… codice e prossimo tentativo si azzerano", [v.codice == nil, v.prossimoTentativoIl == nil], [true, true])
        verificaUguali("… un passo", passi, [.ripreso])
    } else { verifica("in-attesa → in-invio applicata", false) }
    _ = c.applica(.inAttesa(.server), a: j)
    if case .applicata(let prima, let v, let passi, _) = c.applica(.inviato, a: j) {
        verificaUguali("esito che arriva a una voce che dorme (in-attesa): prima `ripreso`, poi `inviato`", passi, [.ripreso, .inviato])
        verificaUguali("… lo stato di partenza", prima, .inAttesa)
        verificaUguali("… arriva a inviato", v.stato, .inviato)
        verificaUguali("… senza codice", v.codice, nil)
    } else { verifica("in-attesa + inviato applicata", false) }
    verifica("a inviato la COPIA del video è cancellata, nello stesso passo", !esiste(copia))
    verificaUguali("da uno stato terminale non si esce: annullato → non ammessa",
                   c.applica(.annullato(nil), a: j), .nonAmmessa(stato: .inviato, evento: .annullato(nil)))
    verificaUguali("… nemmeno fallito", c.applica(.fallito(.interno), a: j), .nonAmmessa(stato: .inviato, evento: .fallito(.interno)))

    struct CasoTerminale { let nome: String; let evento: KVEventoStato; let stato: KVStatoCaricamento; let codice: KVCodiceCaricamento? }
    let casiTerminali: [CasoTerminale] = [
        CasoTerminale(nome: "annullato dal JS", evento: .annullato(nil), stato: .annullato, codice: nil),
        CasoTerminale(nome: "annullato dal server", evento: .annullato(.annullatoDalServer), stato: .annullato, codice: .annullatoDalServer),
        CasoTerminale(nome: "fallito TROPPO_GRANDE", evento: .fallito(.troppoGrande), stato: .fallito, codice: .troppoGrande),
        CasoTerminale(nome: "fallito TOKEN_NON_VALIDO", evento: .fallito(.tokenNonValido), stato: .fallito, codice: .tokenNonValido),
    ]
    for (indice, caso) in casiTerminali.enumerated() {
        let id = 1000 + indice
        _ = c.aggiungi(voce(id, byte: 5))
        let f = cart.appendingPathComponent("file/\(uuid(id).uuidString.lowercased()).mov")
        scrivi(f, byte: 5)
        _ = c.applica(.trasferimentoAvviato, a: uuid(id))
        if case .applicata(_, let v, _, _) = c.applica(caso.evento, a: uuid(id)) {
            verificaUguali("\(caso.nome): stato", v.stato, caso.stato)
            verificaUguali("\(caso.nome): codice", v.codice, caso.codice)
        } else { verifica("\(caso.nome) applicata", false) }
        verifica("\(caso.nome): la copia è cancellata", !esiste(f))
    }
    // da in-coda si può annullare e fallire direttamente
    _ = c.aggiungi(voce(21, byte: 5))
    if case .applicata(_, let v, let passi, _) = c.applica(.annullato(nil), a: uuid(21)) {
        verificaUguali("in-coda → annullato direttamente, un passo solo", [v.stato == .annullato, passi == [.annullato(nil)]], [true, true])
    } else { verifica("in-coda → annullato applicata", false) }
    _ = c.aggiungi(voce(22, byte: 5))
    if case .applicata(_, let v, _, _) = c.applica(.fallito(.fileAssente), a: uuid(22)) {
        verificaUguali("in-coda → fallito direttamente (FILE_ASSENTE: la copia non c'era)", [v.stato == .fallito, v.codice == .fileAssente], [true, true])
    } else { verifica("in-coda → fallito applicata", false) }

    sezione("la coda: `aggiorna` non cambia lo stato, `dimentica` solo i terminali, `elenco` per utente")
    let (a, _) = nuova()
    a.carica()
    orologioProva = Date(timeIntervalSince1970: floor(Date().timeIntervalSince1970))
    _ = a.aggiungi(voce(31, creatoIl: orologioProva.addingTimeInterval(-300), utente: 1))
    _ = a.aggiungi(voce(32, creatoIl: orologioProva.addingTimeInterval(-100), utente: 2))
    _ = a.aggiungi(voce(33, creatoIl: orologioProva.addingTimeInterval(-500), utente: 1))
    _ = a.aggiungi(voce(34, creatoIl: orologioProva.addingTimeInterval(-200), utente: 1))
    verificaUguali("elenco di un utente, per data di creazione", a.voci(perUtente: uuid(1)).map { $0.jobId }, [uuid(33), uuid(31), uuid(34)])
    verificaUguali("elenco di un altro utente: solo le sue", a.voci(perUtente: uuid(2)).map { $0.jobId }, [uuid(32)])
    verificaUguali("elenco di un utente senza voci", a.voci(perUtente: uuid(3)).count, 0)
    orologioProva = orologioProva.addingTimeInterval(60)
    let toccata = a.aggiorna(uuid(31)) { voce in
        voce.stato = .fallito
        voce.jobId = uuid(777)
        voce.creatoIl = dopo(0)
        voce.tentativi = 5
        voce.rinnovi = 2
        voce.rinnoviConsecutivi = 2
        voce.codice = .firmaRifiutata
        voce.urlScadeIl = dopo(99)
    }
    verificaUguali("aggiorna: lo stato non si cambia da qui", toccata?.stato, .inCoda)
    verificaUguali("aggiorna: il jobId non si cambia", toccata?.jobId, uuid(31))
    verificaUguali("aggiorna: creatoIl non si cambia", toccata?.creatoIl, a.voce(uuid(31))?.creatoIl)
    verificaUguali("aggiorna: gli altri campi sì (tentativi, rinnovi, consecutivi, codice, scadenza)",
                   [toccata?.tentativi == 5, toccata?.rinnovi == 2, toccata?.rinnoviConsecutivi == 2, toccata?.codice == .firmaRifiutata, toccata?.urlScadeIl == dopo(99)],
                   [true, true, true, true, true])
    verificaUguali("aggiorna: aggiornatoIl segue l'orologio", toccata?.aggiornatoIl, orologioProva)
    verificaUguali("aggiorna una voce che non c'è", a.aggiorna(uuid(555)) { $0.tentativi = 1 }, nil)
    _ = a.applica(.trasferimentoAvviato, a: uuid(32))
    _ = a.applica(.inviato, a: uuid(32))
    _ = a.applica(.annullato(nil), a: uuid(33))
    verificaUguali("dimentica: toglie solo le terminali indicate (32 inviato, 33 annullato) e ignora le altre (31 in coda, 34 in coda)",
                   a.dimentica([uuid(32), uuid(33), uuid(31), uuid(555)]), 2)
    verificaUguali("… restano le due non terminali", Set(a.tutte().map { $0.jobId }), Set([uuid(31), uuid(34)]))
    verificaUguali("dimentica una voce terminale non indicata: resta", a.dimentica([]), 0)

    sezione("la copia di una voce: percorso, presenza, peso")
    let (b, bCart) = nuova()
    b.carica()
    let vb = voce(41, byte: 100)
    _ = b.aggiungi(vb)
    verificaUguali("copia assente", b.statoDellaCopia(di: vb), .assente)
    scrivi(bCart.appendingPathComponent(vb.file), byte: 100)
    verificaUguali("copia presente col peso giusto", b.statoDellaCopia(di: vb), .presente)
    scrivi(bCart.appendingPathComponent(vb.file), byte: 99)
    verificaUguali("copia presente ma di peso diverso (PESO_DIVERSO)", b.statoDellaCopia(di: vb), .pesoDiverso(attuale: 99))
    scrivi(bCart.appendingPathComponent(vb.file), byte: 0)
    verificaUguali("copia vuota", b.statoDellaCopia(di: vb), .pesoDiverso(attuale: 0))
    verificaUguali("percorso della copia: url dentro file/", b.urlFile(di: vb)?.path, bCart.appendingPathComponent(vb.file).path)
    for cattivo in ["file/../x.mov", "../x.mov", "/etc/passwd", "file/a/b.mov", "file/.nascosto", "", "file/", "scelti/x.mov", "file", "file//x", "file/a\\b", "file/a\u{0}b"] {
        var w = vb
        w.file = cattivo
        verifica("percorso respinto: «\(cattivo.replacingOccurrences(of: "\u{0}", with: "\\0"))»", b.urlFile(di: w) == nil && b.statoDellaCopia(di: w) == .assente)
    }
    verificaUguali("percorso relativo di una copia", KVCodaCaricamenti.percorsoRelativoCopia(jobId: uuid(1), estensione: "MOV"), "file/abcdef12-3456-4abc-9def-000000000001.mov")
    verificaUguali("estensione ripulita", KVCodaCaricamenti.percorsoRelativoCopia(jobId: uuid(1), estensione: "../m p4!"), "file/abcdef12-3456-4abc-9def-000000000001.mp4")
    verificaUguali("estensione vuota → bin", KVCodaCaricamenti.percorsoRelativoCopia(jobId: uuid(1), estensione: ""), "file/abcdef12-3456-4abc-9def-000000000001.bin")
    verificaUguali("estensione lunga: al più otto", KVCodaCaricamenti.percorsoRelativoCopia(jobId: uuid(1), estensione: "abcdefghijkl"), "file/abcdef12-3456-4abc-9def-000000000001.abcdefgh")
    verifica("un percorso relativo prodotto da noi è sempre valido", KVCodaCaricamenti.percorsoRelativoValido(KVCodaCaricamenti.percorsoRelativoCopia(jobId: UUID(), estensione: "mov")))

    sezione("§4.6 — i preparati (`scelti/`) e il passaggio a `file/` (DOPO `aggiungi`: il secondo passo di accodaVideo)")
    do {
        let (cc, ccCart) = nuova()
        verificaUguali("prima del caricamento non si sposta niente", cc.spostaInFile(da: ccCart.appendingPathComponent("scelti/x.mov"), perVoce: uuid(1)), false)
        cc.carica()
        scrivi(ccCart.appendingPathComponent("scelti/abc123.mov"), byte: 10)
        scrivi(ccCart.appendingPathComponent("scelti/abc12.jpg"), byte: 3)
        verificaUguali("trovaScelto: l'id esatto", cc.trovaScelto(id: "abc123")?.path, ccCart.appendingPathComponent("scelti/abc123.mov").path)
        verificaUguali("trovaScelto: un id che è solo l'inizio di un altro non lo trova", cc.trovaScelto(id: "abc1")?.path, nil)
        verificaUguali("trovaScelto: l'altro id", cc.trovaScelto(id: "abc12")?.path, ccCart.appendingPathComponent("scelti/abc12.jpg").path)
        for cattivo in ["", "../coda", "a/b", "a.mov", ".", "..", "abc123.mov", "a b", "abc123\u{0}"] {
            verifica("trovaScelto: l'id «\(cattivo.replacingOccurrences(of: "\u{0}", with: "\\0"))» non ha la forma giusta e non trova niente", cc.trovaScelto(id: cattivo) == nil)
        }
        verificaUguali("rimuoviScelti: toglie quelli che ci sono, ignora i mancanti e i malformati", cc.rimuoviScelti(ids: ["abc12", "mancante", "../coda", "", "abc12"]), 1)
        verifica("… il file è andato, l'altro no", !esiste(ccCart.appendingPathComponent("scelti/abc12.jpg")) && esiste(ccCart.appendingPathComponent("scelti/abc123.mov")))
        verificaUguali("rimuoviScelti senza id", cc.rimuoviScelti(ids: []), 0)

        // spostaInFile: la voce c'è già (aggiungi), e la sposta nel PERCORSO DELLA VOCE
        let sorgente = ccCart.appendingPathComponent("scelti/abc123.mov")
        verificaUguali("senza voce con quel job non si sposta niente (la voce si aggiunge PRIMA)", cc.spostaInFile(da: sorgente, perVoce: uuid(5)), false)
        verifica("… e il preparato è rimasto dov'era", esiste(sorgente))
        let v5 = voce(5, byte: 10)
        verificaUguali("aggiungi: la voce nasce in-coda", cc.aggiungi(v5), .aggiunta(v5))
        verificaUguali("spostaInFile: sposta il preparato nella copia della voce", cc.spostaInFile(da: sorgente, perVoce: uuid(5)), true)
        let copia5 = ccCart.appendingPathComponent(v5.file)
        verifica("… la sorgente non c'è più e la copia c'è, nel percorso scritto nella voce", !esiste(sorgente) && esiste(copia5))
        verificaUguali("… col suo peso", (try? FileManager.default.attributesOfItem(atPath: copia5.path))?[.size] as? Int, 10)
        verificaUguali("… fuori dal backup", (try? copia5.resourceValues(forKeys: [.isExcludedFromBackupKey]))?.isExcludedFromBackup, true)
        verifica("… e il percorso è valido per una voce", KVCodaCaricamenti.percorsoRelativoValido(v5.file))
        // sorgente fuori da scelti/
        let estraneo = nuovaCartella().appendingPathComponent("altro.mov")
        scrivi(estraneo, byte: 4)
        _ = cc.aggiungi(voce(6, byte: 4))
        verificaUguali("sorgente fuori da scelti/: rifiutata", cc.spostaInFile(da: estraneo, perVoce: uuid(6)), false)
        verifica("… e il file estraneo è intatto", esiste(estraneo))
        let dentroFile = ccCart.appendingPathComponent("file/pezzo.mov")
        scrivi(dentroFile, byte: 4)
        verificaUguali("sorgente dentro file/ (non scelti/): rifiutata", cc.spostaInFile(da: dentroFile, perVoce: uuid(6)), false)
        let traversal = ccCart.appendingPathComponent("scelti/../file/pezzo.mov")
        verificaUguali("sorgente che esce da scelti/ con `..`: rifiutata", cc.spostaInFile(da: traversal, perVoce: uuid(6)), false)
        verifica("… e il file è rimasto dov'era", esiste(dentroFile))
        verificaUguali("sorgente che non esiste: nessuna copia", cc.spostaInFile(da: ccCart.appendingPathComponent("scelti/non-c-e.mov"), perVoce: uuid(6)), false)
        // un residuo con lo stesso nome si sostituisce
        let v7 = voce(7, byte: 12)
        _ = cc.aggiungi(v7)
        scrivi(ccCart.appendingPathComponent(v7.file), byte: 99)
        scrivi(ccCart.appendingPathComponent("scelti/nuovo.mov"), byte: 12)
        verificaUguali("residuo con lo stesso nome (nessun'altra voce lo nomina): sostituito", cc.spostaInFile(da: ccCart.appendingPathComponent("scelti/nuovo.mov"), perVoce: uuid(7)), true)
        verificaUguali("… e pesa quanto il nuovo", (try? FileManager.default.attributesOfItem(atPath: ccCart.appendingPathComponent(v7.file).path))?[.size] as? Int, 12)
        // una voce terminale non riceve una copia
        _ = cc.applica(.annullato(nil), a: uuid(7))
        scrivi(ccCart.appendingPathComponent("scelti/tardivo.mov"), byte: 30)
        verificaUguali("a voce terminale la copia non si sposta", cc.spostaInFile(da: ccCart.appendingPathComponent("scelti/tardivo.mov"), perVoce: uuid(7)), false)
        verifica("… e il preparato è rimasto", esiste(ccCart.appendingPathComponent("scelti/tardivo.mov")))
    }

    sezione("§4.6 — `aggiungi` su un job con una voce TERMINALE la sostituisce (un reinvio deve ripartire); su una VIVA no")
    do {
        let (cc, ccCart) = nuova()
        cc.carica()
        var prima = voce(11, byte: 10)
        prima.urlScadeIl = dopo(100)
        _ = cc.aggiungi(prima)
        _ = cc.applica(.trasferimentoAvviato, a: uuid(11))
        _ = cc.applica(.fallito(.tokenNonValido), a: uuid(11))
        verificaUguali("(setup) la voce è fallita", cc.voce(uuid(11))?.stato, .fallito)
        let seconda = voce(11, nome: "Rimandato.mov", byte: 20)
        verificaUguali("aggiungi sullo stesso job con la voce terminale: la sostituisce", cc.aggiungi(seconda), .sostituita(seconda))
        let corrente = cc.voce(uuid(11))
        verificaUguali("… ora la voce è quella nuova: in-coda", corrente?.stato, .inCoda)
        verificaUguali("… senza il codice di fallimento della vecchia", corrente?.codice, nil)
        verificaUguali("… col suo peso", corrente?.byte, 20)
        verificaUguali("… una sola voce per quel job", cc.tutte().filter { $0.jobId == uuid(11) }.count, 1)
        verificaUguali("… e il nome è quello nuovo", cc.voce(uuid(11))?.nome, "Rimandato.mov")
        let rilettura = KVCodaCaricamenti(cartella: ccCart, orologio: { orologioProva })
        _ = rilettura.carica()
        verificaUguali("… e sta anche su disco", rilettura.voce(uuid(11)), seconda)
        // a voce viva non si tocca
        let terza = voce(11, nome: "Ancora.mov", byte: 30)
        verificaUguali("aggiungi sullo stesso job con la voce VIVA: già presente, quella che c'è", cc.aggiungi(terza), .giaPresente(seconda))
        verificaUguali("… e non è cambiato niente", cc.voce(uuid(11)), seconda)
        // annullata, anche lei si sostituisce
        _ = cc.applica(.annullato(nil), a: uuid(11))
        verificaUguali("a voce ANNULLATA vale lo stesso", cc.aggiungi(terza), .sostituita(terza))
        // inviata, pure
        _ = cc.applica(.trasferimentoAvviato, a: uuid(11))
        _ = cc.applica(.inviato, a: uuid(11))
        verificaUguali("a voce INVIATA vale lo stesso", cc.aggiungi(voce(11, byte: 40)).isSostituita, true)
    }

    sezione("`rimuoviVoce` — il ripristino di accodaVideo: toglie la voce e la sua copia, qualunque sia lo stato")
    do {
        let (cc, ccCart) = nuova()
        cc.carica()
        let v = voce(12, byte: 5)
        _ = cc.aggiungi(v)
        scrivi(ccCart.appendingPathComponent(v.file), byte: 5)
        verificaUguali("rimuoviVoce su una voce viva", cc.rimuoviVoce(uuid(12)), true)
        verifica("… la voce non c'è più, né in memoria né su disco, e la copia nemmeno", cc.voce(uuid(12)) == nil && !esiste(ccCart.appendingPathComponent(v.file))
                 && ((try? String(contentsOf: cc.urlFileCoda, encoding: .utf8)) ?? "").contains(uuid(12).uuidString) == false)
        verificaUguali("rimuoviVoce su una voce che non c'è", cc.rimuoviVoce(uuid(12)), false)
        let altra = KVCodaCaricamenti(cartella: nuovaCartella().appendingPathComponent("KidvilleCaricamenti"), orologio: { orologioProva })
        verificaUguali("a coda non pronta non fa niente", altra.rimuoviVoce(uuid(12)), false)
    }

    sezione("§4.6 — una scrittura FALLITA ripristina lo stato di prima (la coda non dice «aggiunta» ciò che non è su disco)")
    do {
        do {
            let (cc, ccCart) = nuova()
            cc.carica()
            let v1 = voce(21, byte: 5)
            verificaUguali("(setup) una voce scritta bene", cc.aggiungi(v1), .aggiunta(v1))
            bloccaLaScrittura(cc.urlFileCoda)
            verificaUguali("aggiungi con la scrittura che fallisce → scritturaFallita", cc.aggiungi(voce(22, byte: 5)), .scritturaFallita)
            verificaUguali("… e la voce NON è rimasta in memoria (il giornale non mente: una voce che non è su disco non esiste)", cc.tutte().map { $0.jobId }, [uuid(21)])
            // sostituzione di una terminale con scrittura che fallisce: si torna alla terminale
            sbloccaLaScrittura(cc.urlFileCoda)
            _ = cc.applica(.annullato(nil), a: uuid(21))
            verificaUguali("(setup) la voce 21 è annullata", cc.voce(uuid(21))?.stato, .annullato)
            bloccaLaScrittura(cc.urlFileCoda)
            verificaUguali("sostituire una terminale con la scrittura che fallisce → scritturaFallita", cc.aggiungi(voce(21, byte: 9)), .scritturaFallita)
            verificaUguali("… e la voce è ancora quella annullata di prima: lo stato", cc.voce(uuid(21))?.stato, .annullato)
            verificaUguali("… e il peso", cc.voce(uuid(21))?.byte, 5)
            sbloccaLaScrittura(cc.urlFileCoda)
            verificaUguali("sbloccata la scrittura, la stessa aggiunta riesce", cc.aggiungi(voce(21, byte: 9)).isSostituita, true)
            _ = ccCart
        }

        sezione("§4.6 — a uno stato terminale la copia si cancella DOPO aver scritto lo stato, e solo se la scrittura è riuscita")
        do {
            let (cc, ccCart) = nuova()
            cc.carica()
            for n in 31...33 {
                let v = voce(n, byte: 6)
                _ = cc.aggiungi(v)
                scrivi(ccCart.appendingPathComponent(v.file), byte: 6)
                _ = cc.applica(.trasferimentoAvviato, a: uuid(n))
            }
            bloccaLaScrittura(cc.urlFileCoda)
            if case .applicata(_, let v, _, let persistita) = cc.applica(.inviato, a: uuid(31)) {
                verificaUguali("scrittura fallita: l'esito dice persistita = false", persistita, false)
                verificaUguali("… lo stato in memoria è comunque inviato", v.stato, .inviato)
            } else { verifica("inviato applicata con la scrittura fallita", false) }
            verifica("… e la COPIA c'è ancora: se il processo muore ora la voce su disco è viva, e una PUT ripetuta dà un duplicato che il rinnovo risolve", esiste(ccCart.appendingPathComponent(voce(31).file)))
            sbloccaLaScrittura(cc.urlFileCoda)
            if case .applicata(_, _, _, let persistita) = cc.applica(.inviato, a: uuid(32)) {
                verificaUguali("scrittura riuscita: persistita = true", persistita, true)
            } else { verifica("inviato applicata con la scrittura riuscita", false) }
            verifica("… e la copia è cancellata", !esiste(ccCart.appendingPathComponent(voce(32).file)))
            // la pulizia: i token scaduti. `adesso` è 1.000 s dopo: la copia è più vecchia della grazia degli orfani (300 s), quindi a proteggerla
            // dal punto 3 della pulizia non è l'età ma il fatto che la voce appena chiusa la nomina ancora.
            let (pp, ppCart) = nuova()
            pp.carica()
            orologioProva = Date(timeIntervalSince1970: floor(Date().timeIntervalSince1970))
            let scadente = voce(41, byte: 6, creatoIl: orologioProva, tokenScadeIl: orologioProva.addingTimeInterval(100))
            _ = pp.aggiungi(scadente)
            scrivi(ppCart.appendingPathComponent(scadente.file), byte: 6)
            bloccaLaScrittura(pp.urlFileCoda)
            let blocco = pp.pulisci(adesso: orologioProva.addingTimeInterval(1000))
            verificaUguali("pulizia con la scrittura fallita: la voce scaduta è chiusa in memoria", blocco.vociScadute.map { $0.jobId }, [uuid(41)])
            verificaUguali("… persistita = false", blocco.persistita, false)
            verifica("… jobIdAttivi è nil: il motore non toglie nessun segreto", blocco.jobIdAttivi == nil)
            verificaUguali("… nessun orfano rimosso (la copia è della voce appena chiusa, non ancora scritta come terminale)", blocco.orfaniRimossi, 0)
            verifica("… e la copia c'è ancora", esiste(ppCart.appendingPathComponent(scadente.file)))
            sbloccaLaScrittura(pp.urlFileCoda)
            let sblocco = pp.pulisci(adesso: orologioProva.addingTimeInterval(1000))
            verificaUguali("scrittura riuscita (pulizia successiva): persistita = true", sblocco.persistita, true)
            verificaUguali("… la copia della voce ormai terminale è un orfano e si toglie", sblocco.orfaniRimossi, 1)
            verifica("… davvero", !esiste(ppCart.appendingPathComponent(scadente.file)))
            // una pulizia che chiude una voce e scrive: la copia si cancella subito, dopo la scrittura
            let (qq, qqCart) = nuova()
            qq.carica()
            let scadente2 = voce(42, byte: 6, creatoIl: orologioProva, tokenScadeIl: orologioProva.addingTimeInterval(100))
            _ = qq.aggiungi(scadente2)
            scrivi(qqCart.appendingPathComponent(scadente2.file), byte: 6)
            let normale = qq.pulisci(adesso: orologioProva.addingTimeInterval(200))
            verificaUguali("pulizia che chiude e scrive: persistita = true", normale.persistita, true)
            verifica("… e la copia della voce chiusa è già cancellata (dopo la scrittura)", !esiste(qqCart.appendingPathComponent(scadente2.file)))
        }
    }

    sezione("§4.6 — i testi delle notifiche: li passa il JS, il ripiego è italiano")
    let (t, tCart) = nuova()
    t.carica()
    verificaUguali("all'inizio: il ripiego", t.testi, KVTestiNotifiche.ripiegoItaliano)
    t.impostaTesti(KVTestiNotifiche(titolo: "Kidville", invio: "Sending videos", attesaRete: "Waiting for network", pausa: "Paused"))
    verificaUguali("testi del JS conservati", t.testi.invio, "Sending videos")
    let t2 = KVCodaCaricamenti(cartella: tCart, orologio: { orologioProva })
    t2.carica()
    verificaUguali("… e ritrovati da un'altra istanza", t2.testi, KVTestiNotifiche(titolo: "Kidville", invio: "Sending videos", attesaRete: "Waiting for network", pausa: "Paused"))
    t2.impostaTesti(KVTestiNotifiche(titolo: "  ", invio: "", attesaRete: "ok", pausa: String(repeating: "x", count: 500)))
    verificaUguali("un testo vuoto o di soli spazi → ripiego italiano", [t2.testi.titolo, t2.testi.invio], ["Kidville", "Invio dei video in corso"])
    verificaUguali("un testo troppo lungo → tagliato a 200", t2.testi.pausa.count, 200)
    verificaUguali("un testo buono resta", t2.testi.attesaRete, "ok")

    sezione("§4.6 — coda corrotta: rinominata, coda nuova vuota, log coda-nativa-corrotta con i file orfani")
    for (nome, contenuto) in [("rotta (testo che non è JSON)", "questo non è JSON {"),
                              ("vuota (0 byte)", ""),
                              ("JSON ma non un oggetto", "[1,2,3]"),
                              ("versione sconosciuta (2)", "{\"versione\":2,\"testi\":{\"titolo\":\"a\",\"invio\":\"b\",\"attesaRete\":\"c\",\"pausa\":\"d\"},\"voci\":[]}"),
                              ("versione 0", "{\"versione\":0,\"testi\":{\"titolo\":\"a\",\"invio\":\"b\",\"attesaRete\":\"c\",\"pausa\":\"d\"},\"voci\":[]}"),
                              ("senza versione", "{\"testi\":{\"titolo\":\"a\",\"invio\":\"b\",\"attesaRete\":\"c\",\"pausa\":\"d\"},\"voci\":[]}"),
                              ("senza l'elenco delle voci", "{\"versione\":1,\"testi\":{\"titolo\":\"a\",\"invio\":\"b\",\"attesaRete\":\"c\",\"pausa\":\"d\"}}"),
                              ("con l'elenco delle voci che non è un elenco", "{\"versione\":1,\"testi\":{\"titolo\":\"a\",\"invio\":\"b\",\"attesaRete\":\"c\",\"pausa\":\"d\"},\"voci\":{}}"),
                              ("senza i testi", "{\"versione\":1,\"voci\":[]}")] {
        let trasporto = TrasportoFinto()
        let cartellaRegistro = nuovaCartella()
        let registro = KVRegistroNativo(cartella: cartellaRegistro, trasporto: trasporto, versioneApp: "1.2+6", ambiente: .release, orologio: { orologioProva })
        let (cc, ccCart) = nuova(registro: registro)
        try! FileManager.default.createDirectory(at: ccCart.appendingPathComponent("file"), withIntermediateDirectories: true, attributes: nil)
        for i in 1...3 { scrivi(ccCart.appendingPathComponent("file/orfano\(i).mov"), byte: 10) }
        try! Data(contenuto.utf8).write(to: ccCart.appendingPathComponent("coda.json"))
        let esito = cc.carica()
        verificaUguali("coda \(nome): corrotta, con 3 file orfani", esito, .corrotta(fileOrfani: 3))
        let corrotti = nomiIn(ccCart).filter { $0.hasPrefix("coda.corrotta-") }
        verificaUguali("coda \(nome): UN file coda.corrotta-<istante>.json", corrotti.count, 1)
        verificaUguali("coda \(nome): il contenuto si è conservato per l'analisi",
                       corrotti.first.flatMap { try? String(contentsOf: ccCart.appendingPathComponent($0), encoding: .utf8) }, contenuto)
        verifica("coda \(nome): il nome ha la forma coda.corrotta-AAAAMMGGTOOMMSSZ.json",
                 corrotti.first?.range(of: "^coda\\.corrotta-[0-9]{8}T[0-9]{6}Z\\.json$", options: .regularExpression) != nil, "\(corrotti)")
        verifica("coda \(nome): è pronta, vuota, e scrive una coda nuova valida", cc.pronta && cc.tutte().isEmpty && esiste(ccCart.appendingPathComponent("coda.json")))
        let riletta = KVCodaCaricamenti(cartella: ccCart, orologio: { orologioProva })
        verificaUguali("coda \(nome): la coda nuova si rilegge senza altri problemi", riletta.carica(), .caricata(voci: 0))
        let eventi = registro.stato().eventi
        verificaUguali("coda \(nome): UN log", eventi.count, 1)
        verificaUguali("coda \(nome): messaggio coda-nativa-corrotta", eventi.first?.messaggio, "coda-nativa-corrotta")
        verificaUguali("coda \(nome): livello error", eventi.first?.livello, .error)
        verificaUguali("coda \(nome): file_orfani 3", eventi.first?.campi["file_orfani"], .numero(3))
        let pulizia = cc.pulisci(adesso: Date().addingTimeInterval(3600))
        verificaUguali("coda \(nome): la pulizia toglie i 3 orfani", pulizia.orfaniRimossi, 3)
        verifica("coda \(nome): file/ è vuota", nomiIn(ccCart.appendingPathComponent("file")).isEmpty)
    }
    // due corruzioni nello stesso secondo non si sovrascrivono
    do {
        let (cc, ccCart) = nuova()
        cc.carica()
        for i in 1...3 {
            try! Data("rotta \(i)".utf8).write(to: ccCart.appendingPathComponent("coda.json"))
            _ = cc.carica()
        }
        verificaUguali("tre corruzioni nello stesso istante: tre file distinti", nomiIn(ccCart).filter { $0.hasPrefix("coda.corrotta-") }.count, 3)
    }
    // il file c'è ma non si legge: non è corrotto, e non va toccato
    if getuid() != 0 {
        let (cc, ccCart) = nuova()
        cc.carica()
        _ = cc.aggiungi(voce(51))
        let originale = try! Data(contentsOf: ccCart.appendingPathComponent("coda.json"))
        try! FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: ccCart.appendingPathComponent("coda.json").path)
        let altra = KVCodaCaricamenti(cartella: ccCart, orologio: { orologioProva })
        if case .illeggibileOra(let errore) = altra.carica() {
            verificaUguali("coda illeggibile (permessi): dominio Cocoa", errore.dominio, .cocoa)
        } else { verifica("coda illeggibile (permessi): illeggibileOra", false) }
        verifica("non è pronta e rifiuta di scrivere (non sovrascrive i video in volo)", !altra.pronta && altra.aggiungi(voce(52)) == .nonPronta)
        verificaUguali("… né applica transizioni", altra.applica(.trasferimentoAvviato, a: uuid(51)), .nonPronta)
        let pulizia = altra.pulisci(adesso: Date().addingTimeInterval(100 * 24 * 3600))
        verificaUguali("… né toglie niente con la pulizia", [pulizia.vociScadute.count, pulizia.orfaniRimossi, pulizia.sceltiRimossi, pulizia.vociTerminaliRimosse], [0, 0, 0, 0])
        verifica("… e dice di non aver guardato (jobIdAttivi nil: il motore NON deve togliere segreti)", pulizia.jobIdAttivi == nil)
        verifica("nessun file coda.corrotta-* è stato creato", nomiIn(ccCart).filter { $0.hasPrefix("coda.corrotta-") }.isEmpty)
        try! FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: ccCart.appendingPathComponent("coda.json").path)
        verificaUguali("coda.json è rimasto intatto", try! Data(contentsOf: ccCart.appendingPathComponent("coda.json")), originale)
        verificaUguali("un nuovo carica() riesce e ritrova la voce", altra.carica(), .caricata(voci: 1))
        verificaUguali("… e ora scrive", altra.aggiungi(voce(52)).isAggiunta, true)
    } else {
        print("  (provata saltata: eseguita come root, i permessi non bloccano la lettura)")
    }

    sezione("§4.6 — UNA voce fuori forma in un file leggibile si scarta DA SOLA (come su Android), col conteggio in `coda-nativa-corrotta`")
    do {
        /// Una coda con tre voci buone e le loro copie, scritta da una coda vera; poi `rompi` modifica il JSON a mano.
        func codaConTreVoci(rompi: (inout [[String: Any]]) -> Void) -> (cartella: URL, registro: KVRegistroNativo, coda: KVCodaCaricamenti, esito: KVEsitoCaricamentoCoda) {
            let cart = nuovaCartella().appendingPathComponent("KidvilleCaricamenti", isDirectory: true)
            let scrittrice = KVCodaCaricamenti(cartella: cart, orologio: { orologioProva })
            scrittrice.carica()
            for n in 1...3 {
                let v = voce(n, byte: 10 * Int64(n))
                _ = scrittrice.aggiungi(v)
                scrivi(cart.appendingPathComponent(v.file), byte: 10 * n)
            }
            var radice = try! JSONSerialization.jsonObject(with: try! Data(contentsOf: scrittrice.urlFileCoda)) as! [String: Any]
            var elenco = radice["voci"] as! [[String: Any]]
            rompi(&elenco)
            radice["voci"] = elenco
            try! JSONSerialization.data(withJSONObject: radice).write(to: scrittrice.urlFileCoda)
            let registro = KVRegistroNativo(cartella: nuovaCartella(), trasporto: TrasportoFinto(), versioneApp: "1.2+6", ambiente: .release, orologio: { orologioProva })
            let coda = KVCodaCaricamenti(cartella: cart, orologio: { orologioProva }, registro: registro)
            return (cart, registro, coda, coda.carica())
        }
        let casi: [(String, (inout [[String: Any]]) -> Void)] = [
            ("stato che non esiste", { $0[1]["stato"] = "boh" }),
            ("jobId che non è un uuid", { $0[1]["jobId"] = "non-un-uuid" }),
            ("campo obbligatorio mancante (mime)", { $0[1].removeValue(forKey: "mime") }),
            ("campo del tipo sbagliato (byte è una stringa)", { $0[1]["byte"] = "tanti" }),
            ("peso nullo", { $0[1]["byte"] = 0 }),
            ("contatore negativo", { $0[1]["tentativi"] = -1 }),
            ("percorso della copia fuori da file/", { $0[1]["file"] = "file/../x.mov" }),
            ("percorso della copia che nomina un altro job", { $0[1]["file"] = "file/abcdef12-3456-4abc-9def-000000000001.mov" }),
            ("codice di fallimento che non esiste", { $0[1]["codice"] = "BOH" }),
            ("una data che non è una data", { $0[1]["creatoIl"] = "ieri" }),
            ("un oggetto vuoto", { $0[1] = [:] }),
        ]
        for (nome, rompi) in casi {
            let c = codaConTreVoci(rompi: rompi)
            if case .caricataConScarti(let voci, let scartate, let orfani) = c.esito {
                verificaUguali("voce con \(nome): le altre due restano", voci, 2)
                verificaUguali("… e UNA è scartata", scartate, 1)
                verificaUguali("… i file di copia che nessuna voce viva nomina più sono 1", orfani, 1)
            } else {
                verifica("voce con \(nome): caricataConScarti (le altre voci non vanno perse)", false, "esito: \(c.esito)")
                continue
            }
            verificaUguali("… le voci rimaste sono la prima e la terza", Set(c.coda.tutte().map { $0.jobId }), Set([uuid(1), uuid(3)]))
            verifica("… NIENTE file coda.corrotta-*: il file non si butta, si riscrive", nomiIn(c.cartella).filter { $0.hasPrefix("coda.corrotta-") }.isEmpty)
            verifica("… la coda è pronta", c.coda.pronta)
            let log = c.registro.stato().eventi
            verificaUguali("… UN log, coda-nativa-corrotta (error)", log.map { "\($0.messaggio)|\($0.livello.rawValue)" }, ["coda-nativa-corrotta|error"])
            verificaUguali("… con file_orfani 1 e voci_scartate 1", [log.first?.campi["file_orfani"], log.first?.campi["voci_scartate"]], [.numero(1), .numero(1)])
            // riscritta subito: la riga non si ripete a ogni avvio
            let riletta = KVCodaCaricamenti(cartella: c.cartella, orologio: { orologioProva })
            verificaUguali("… e il file è già riscritto senza la voce: un'altra istanza lo legge pulito", riletta.carica(), .caricata(voci: 2))
        }
        // una voce che non è nemmeno un oggetto JSON (un numero, una stringa, un elenco, null): si salta come le altre, senza fermare la lettura
        for (nome, valore) in [("un numero", "42"), ("una stringa", "\"boh\""), ("un elenco", "[1,2]"), ("null", "null")] {
            let cart = nuovaCartella().appendingPathComponent("KidvilleCaricamenti", isDirectory: true)
            let scrittrice = KVCodaCaricamenti(cartella: cart, orologio: { orologioProva })
            scrittrice.carica()
            _ = scrittrice.aggiungi(voce(1, byte: 10))
            _ = scrittrice.aggiungi(voce(2, byte: 20))
            var radice = try! JSONSerialization.jsonObject(with: try! Data(contentsOf: scrittrice.urlFileCoda)) as! [String: Any]
            var elenco = radice["voci"] as! [Any]
            elenco.insert(valore == "null" ? NSNull() : (try! JSONSerialization.jsonObject(with: Data(valore.utf8), options: [.fragmentsAllowed])), at: 1)
            radice["voci"] = elenco
            try! JSONSerialization.data(withJSONObject: radice).write(to: scrittrice.urlFileCoda)
            let letta = KVCodaCaricamenti(cartella: cart, orologio: { orologioProva })
            if case .caricataConScarti(let voci, let scartate, _) = letta.carica() {
                verificaUguali("una voce che è \(nome) in mezzo alle altre: le due buone restano, una scartata", [voci, scartate], [2, 1])
            } else { verifica("una voce che è \(nome): caricataConScarti", false) }
        }
        // due voci rotte, e un doppione
        let due = codaConTreVoci(rompi: { $0[0]["stato"] = "boh"; $0[2]["byte"] = 0 })
        if case .caricataConScarti(let voci, let scartate, _) = due.esito { verificaUguali("due voci rotte: ne resta una, due scartate", [voci, scartate], [1, 2]) }
        else { verifica("due voci rotte: caricataConScarti", false) }
        verificaUguali("… voci_scartate 2 nel log", due.registro.stato().eventi.first?.campi["voci_scartate"], .numero(2))
        let doppione = codaConTreVoci(rompi: { $0.append($0[0]) })
        if case .caricataConScarti(let voci, let scartate, let orfani) = doppione.esito {
            verificaUguali("un jobId ripetuto nel file: la seconda copia è scartata, le tre voci restano", [voci, scartate, orfani], [3, 1, 0])
        } else { verifica("un jobId ripetuto: caricataConScarti", false) }
        // nessuna voce rotta: nessun log, nessuna riscrittura inutile
        let pulita = codaConTreVoci(rompi: { _ in })
        verificaUguali("nessuna voce rotta: caricata, e nessun log", [pulita.esito == .caricata(voci: 3), pulita.registro.stato().eventi.isEmpty], [true, true])
        // tutte le voci rotte: il file è leggibile, quindi NON è corrotto: coda vuota, le voci scartate si contano
        let tutte = codaConTreVoci(rompi: { for i in $0.indices { $0[i]["stato"] = "boh" } })
        if case .caricataConScarti(let voci, let scartate, let orfani) = tutte.esito { verificaUguali("tutte e tre rotte: coda vuota, tre scartate, tre file orfani", [voci, scartate, orfani], [0, 3, 3]) }
        else { verifica("tutte rotte: caricataConScarti", false) }
        verifica("… e il file non è stato rinominato", nomiIn(tutte.cartella).filter { $0.hasPrefix("coda.corrotta-") }.isEmpty)
        // la pulizia toglie l'orfano della voce scartata
        let conOrfano = codaConTreVoci(rompi: { $0[1]["stato"] = "boh" })
        let orfani = conOrfano.coda.pulisci(adesso: Date().addingTimeInterval(3600))
        verificaUguali("la pulizia toglie la copia della voce scartata (nessuno la nomina più)", orfani.orfaniRimossi, 1)
        verificaUguali("… e restano le copie delle due voci buone", nomiIn(conOrfano.cartella.appendingPathComponent("file")).count, 2)
    }

    sezione("§4.6 — l'ESCALATION: una coda che non si riesce mai a leggere (`ripartiDaCapo`)")
    if getuid() != 0 {
        do {
            let trasporto = TrasportoFinto()
            let registro = KVRegistroNativo(cartella: nuovaCartella(), trasporto: trasporto, versioneApp: "1.2+6", ambiente: .release, orologio: { orologioProva })
            let cart = nuovaCartella().appendingPathComponent("KidvilleCaricamenti", isDirectory: true)
            let scrittrice = KVCodaCaricamenti(cartella: cart, orologio: { orologioProva })
            scrittrice.carica()
            _ = scrittrice.aggiungi(voce(1, byte: 5))
            scrivi(cart.appendingPathComponent(voce(1).file), byte: 5)
            let originale = try! Data(contentsOf: scrittrice.urlFileCoda)
            try! FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: scrittrice.urlFileCoda.path)
            let cc = KVCodaCaricamenti(cartella: cart, orologio: { orologioProva }, registro: registro)
            if case .illeggibileOra = cc.carica() {} else { verifica("(setup) la coda non si legge", false) }
            verifica("(setup) non è pronta", !cc.pronta)
            if case .corrotta(let orfani) = cc.ripartiDaCapo() {
                verificaUguali("ripartiDaCapo su un file che non si apre: lo tratta da corrotto, con un file orfano", orfani, 1)
            } else { verifica("ripartiDaCapo: corrotta", false) }
            verifica("… la coda è pronta e vuota", cc.pronta && cc.tutte().isEmpty)
            let corrotti = nomiIn(cart).filter { $0.hasPrefix("coda.corrotta-") }
            verificaUguali("… il file è rimasto da parte, coda.corrotta-<istante>.json", corrotti.count, 1)
            if let nome = corrotti.first {
                try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: cart.appendingPathComponent(nome).path)
                verificaUguali("… col suo contenuto intatto", try? Data(contentsOf: cart.appendingPathComponent(nome)), originale)
            }
            verificaUguali("… e UN log coda-nativa-corrotta", registro.stato().eventi.map { $0.messaggio }, ["coda-nativa-corrotta"])
            verificaUguali("… con file_orfani 1 e senza voci_scartate (è la coda intera che è andata)", [registro.stato().eventi.first?.campi["file_orfani"], registro.stato().eventi.first?.campi["voci_scartate"]], [.numero(1), nil])
            verificaUguali("… la nuova coda si scrive e si rilegge", KVCodaCaricamenti(cartella: cart, orologio: { orologioProva }).carica(), .caricata(voci: 0))
            // un file che ora si legge: si comporta come carica(), non rinomina niente
            let cart2 = nuovaCartella().appendingPathComponent("KidvilleCaricamenti", isDirectory: true)
            let s2 = KVCodaCaricamenti(cartella: cart2, orologio: { orologioProva })
            s2.carica()
            _ = s2.aggiungi(voce(2, byte: 5))
            let c2 = KVCodaCaricamenti(cartella: cart2, orologio: { orologioProva })
            verificaUguali("ripartiDaCapo su un file che si legge: lo carica, non lo butta", c2.ripartiDaCapo(), .caricata(voci: 1))
            verifica("… e non rinomina niente", nomiIn(cart2).filter { $0.hasPrefix("coda.corrotta-") }.isEmpty)
            // senza file
            let c3 = KVCodaCaricamenti(cartella: nuovaCartella().appendingPathComponent("KidvilleCaricamenti"), orologio: { orologioProva })
            verificaUguali("ripartiDaCapo senza file: coda nuova", c3.ripartiDaCapo(), .nuova)
        }
    } else {
        print("  (prova saltata: eseguita come root, i permessi non bloccano la lettura)")
    }

    sezione("§4.6 — pulizia all'avvio: scelti > 24 h, orfani, terminali > 7 giorni, token scaduti, corrotte vecchie")
    do {
        let (cc, ccCart) = nuova()
        cc.carica()
        let adesso = Date()
        // preparati
        scrivi(ccCart.appendingPathComponent("scelti/vecchio.mov"), byte: 4)
        var p = cc.pulisci(adesso: adesso.addingTimeInterval(23 * 3600 + 59 * 60))
        verificaUguali("scelti a 23 h 59: restano", p.sceltiRimossi, 0)
        verifica("… il file c'è ancora", esiste(ccCart.appendingPathComponent("scelti/vecchio.mov")))
        p = cc.pulisci(adesso: adesso.addingTimeInterval(24 * 3600 + 60))
        verificaUguali("scelti a 24 h 01: si tolgono", p.sceltiRimossi, 1)
        verifica("… il file non c'è più", !esiste(ccCart.appendingPathComponent("scelti/vecchio.mov")))
        // orfani, con la grazia
        scrivi(ccCart.appendingPathComponent("file/orfano.mov"), byte: 4)
        p = cc.pulisci(adesso: adesso.addingTimeInterval(240))
        verificaUguali("orfano a 4 minuti: resta (potrebbe essere una copia appena spostata, voce non ancora scritta)", p.orfaniRimossi, 0)
        p = cc.pulisci(adesso: adesso.addingTimeInterval(360))
        verificaUguali("orfano a 6 minuti: si toglie", p.orfaniRimossi, 1)
        // una copia nominata da una voce non terminale resta, anche se vecchia
        let viva = voce(61, byte: 4, creatoIl: orologioProva, tokenScadeIl: orologioProva.addingTimeInterval(48 * 3600))
        _ = cc.aggiungi(viva)
        scrivi(ccCart.appendingPathComponent(viva.file), byte: 4)
        p = cc.pulisci(adesso: adesso.addingTimeInterval(10 * 3600))
        verifica("la copia di una voce non terminale resta, anche dopo 10 ore", esiste(ccCart.appendingPathComponent(viva.file)) && p.orfaniRimossi == 0)
        verificaUguali("jobIdAttivi: la voce non terminale", p.jobIdAttivi, [uuid(61)])
        // terminale: la copia e la voce
        _ = cc.applica(.trasferimentoAvviato, a: uuid(61))
        scrivi(ccCart.appendingPathComponent(viva.file), byte: 4) // ricreata a mano, come se la cancellazione fosse fallita
        _ = cc.applica(.annullato(nil), a: uuid(61))
        scrivi(ccCart.appendingPathComponent(viva.file), byte: 4)
        p = cc.pulisci(adesso: adesso.addingTimeInterval(3600))
        verificaUguali("una copia nominata solo da una voce terminale è un orfano e si toglie", p.orfaniRimossi, 1)
        verificaUguali("jobIdAttivi non nomina le terminali", p.jobIdAttivi, [])
        verificaUguali("la voce terminale di un'ora fa resta", cc.tutte().count, 1)
        let aggiornata = cc.voce(uuid(61))!.aggiornatoIl
        p = cc.pulisci(adesso: aggiornata.addingTimeInterval(7 * 24 * 3600))
        verificaUguali("voce terminale di esattamente 7 giorni: resta", p.vociTerminaliRimosse, 0)
        p = cc.pulisci(adesso: aggiornata.addingTimeInterval(7 * 24 * 3600 + 1))
        verificaUguali("voce terminale di 7 giorni e un secondo: si toglie", p.vociTerminaliRimosse, 1)
        verifica("… e la coda è vuota", cc.tutte().isEmpty)
        // coda corrotta vecchia
        try! Data("rotta".utf8).write(to: ccCart.appendingPathComponent("coda.json"))
        _ = cc.carica()
        verifica("(setup) c'è un file coda corrotta", nomiIn(ccCart).contains { $0.hasPrefix("coda.corrotta-") })
        p = cc.pulisci(adesso: Date().addingTimeInterval(7 * 24 * 3600 - 120))
        verificaUguali("coda corrotta a 6 giorni 23 h 58: resta", p.corrotteRimosse, 0)
        p = cc.pulisci(adesso: Date().addingTimeInterval(7 * 24 * 3600 + 120))
        verificaUguali("coda corrotta a 7 giorni 2 minuti: si toglie", p.corrotteRimosse, 1)
        verifica("coda.json (la nuova) non si tocca", esiste(ccCart.appendingPathComponent("coda.json")))
    }
    do {
        let trasporto = TrasportoFinto()
        let registro = KVRegistroNativo(cartella: nuovaCartella(), trasporto: trasporto, versioneApp: "1.2+6", ambiente: .release, orologio: { orologioProva })
        let (cc, ccCart) = nuova(registro: registro)
        cc.carica()
        orologioProva = Date(timeIntervalSince1970: floor(Date().timeIntervalSince1970))
        let scadente = voce(71, byte: 4, creatoIl: orologioProva, tokenScadeIl: orologioProva.addingTimeInterval(1000))
        let valida = voce(72, byte: 4, creatoIl: orologioProva, tokenScadeIl: orologioProva.addingTimeInterval(5000))
        _ = cc.aggiungi(scadente)
        _ = cc.aggiungi(valida)
        _ = cc.applica(.trasferimentoAvviato, a: uuid(71))
        _ = cc.aggiorna(uuid(71)) { $0.tentativi = 4; $0.rinnovi = 2 }
        scrivi(ccCart.appendingPathComponent(scadente.file), byte: 4)
        scrivi(ccCart.appendingPathComponent(valida.file), byte: 4)
        var p = cc.pulisci(adesso: orologioProva.addingTimeInterval(999))
        verificaUguali("token a un secondo dalla scadenza: nessuna voce chiusa", p.vociScadute.count, 0)
        p = cc.pulisci(adesso: orologioProva.addingTimeInterval(1000))
        verificaUguali("token proprio alla scadenza (≥): la voce scaduta si chiude", p.vociScadute.map { $0.jobId }, [uuid(71)])
        verificaUguali("… come fallito", cc.voce(uuid(71))?.stato, .fallito)
        verificaUguali("… con codice TOKEN_SCADUTO", cc.voce(uuid(71))?.codice, .tokenScaduto)
        verifica("… e la sua copia è cancellata, quella dell'altra no", !esiste(ccCart.appendingPathComponent(scadente.file)) && esiste(ccCart.appendingPathComponent(valida.file)))
        verificaUguali("… jobIdAttivi nomina solo la voce valida", p.jobIdAttivi, [uuid(72)])
        let eventi = registro.stato().eventi
        verificaUguali("… UN log video-nativo-fallito TOKEN_SCADUTO, livello error",
                       eventi.map { "\($0.messaggio)|\($0.livello.rawValue)" }, ["video-nativo-fallito: job=\(uuid(71).uuidString.lowercased()) TOKEN_SCADUTO|error"])
        verificaUguali("… con operazione rinnovo e i contatori della voce",
                       [eventi.first?.campi["operazione"], eventi.first?.campi["tentativi"], eventi.first?.campi["rinnovi"]],
                       [.testo("rinnovo"), .numero(4), .numero(2)])
        p = cc.pulisci(adesso: orologioProva.addingTimeInterval(1001))
        verificaUguali("la pulizia successiva non richiude la stessa voce", p.vociScadute.count, 0)
        verificaUguali("… e il log non si ripete", registro.stato().eventi.count, 1)
    }

    sezione("la coda è sicura fra thread (sessione in background, ponte, monitor di rete)")
    do {
        let (cc, ccCart) = nuova()
        cc.carica()
        _ = cc.aggiungi(voce(81))
        DispatchQueue.concurrentPerform(iterations: 200) { _ in
            cc.aggiorna(uuid(81)) { $0.tentativi += 1 }
        }
        verificaUguali("200 aggiornamenti da thread diversi: nessuno si perde", cc.voce(uuid(81))?.tentativi, 200)
        let rilettura = KVCodaCaricamenti(cartella: ccCart, orologio: { orologioProva })
        _ = rilettura.carica()
        verificaUguali("… e il file su disco dice lo stesso", rilettura.voce(uuid(81))?.tentativi, 200)
        DispatchQueue.concurrentPerform(iterations: 60) { i in
            if i % 3 == 0 { _ = cc.aggiungi(voce(2000 + i)) }
            else if i % 3 == 1 { _ = cc.tutte() }
            else { _ = cc.voci(perUtente: uuid(1)) }
        }
        verificaUguali("scritture e letture insieme: le 20 voci aggiunte ci sono tutte", cc.tutte().count, 21)
        verifica("nessun file temporaneo è rimasto nella cartella della coda", Set(nomiIn(ccCart)).isSubset(of: ["coda.json", "file", "scelti"]), "\(nomiIn(ccCart))")
    }
}

extension KVEsitoAggiunta {
    var isAggiunta: Bool { if case .aggiunta = self { return true }; return false }
    var isSostituita: Bool { if case .sostituita = self { return true }; return false }
}

// MARK: - 10. Il registro dei log

/// Un trasporto finto: tiene le richieste e risponde con quello che gli si è messo in coda.
final class TrasportoFinto: KVTrasportoRegistro {
    var richieste: [KVRichiestaRegistro] = []
    var risposte: [KVRispostaRegistro] = []
    /// Ciò che risponde quando `risposte` è vuota.
    var rispostaPredefinita = KVRispostaRegistro.stato(200, retryAfter: nil)
    var sincrono = true
    var inSospeso: [() -> Void] = []

    func invia(_ richiesta: KVRichiestaRegistro, completamento: @escaping (KVRispostaRegistro) -> Void) {
        richieste.append(richiesta)
        let risposta = risposte.isEmpty ? rispostaPredefinita : risposte.removeFirst()
        if sincrono { completamento(risposta) } else { inSospeso.append { completamento(risposta) } }
    }

    func rispondiAlSospeso() {
        let pronti = inSospeso
        inSospeso = []
        pronti.forEach { $0() }
    }

    func corpo(_ n: Int) -> [String: Any] {
        return (try? JSONSerialization.jsonObject(with: richieste[n].corpo) as? [String: Any]) ?? [:]
    }

    func eventi(_ n: Int) -> [[String: Any]] { corpo(n)["eventi"] as? [[String: Any]] ?? [] }
}

/// Un protocollo finto per provare il trasporto VERO senza rete.
final class ProtocolloFinto: URLProtocol {
    static let serratura = NSLock()
    static var richieste: [URLRequest] = []
    static var corpi: [Data] = []
    static var risposta: (stato: Int, intestazioni: [String: String])? = (200, [:])
    /// Il corpo della risposta (di solito `{}`).
    static var corpo = Data("{}".utf8)
    /// Se `true` la richiesta non finisce mai (per provare `taskVivi` e l'annullamento).
    static var sospendi = false
    /// Ciò che il TASK che ha portato la richiesta dichiarava al sistema (si legge da `self.task` in `startLoading`): la descrizione, l'inizio più
    /// presto, i byte che pensa di spedire e di ricevere. Sono ciò che il trasporto vero ci mette, e nessun altro punto della prova lo vede.
    static var proprietaDelTask: [(descrizione: String?, nonPrima: Date?, attesiInvio: Int64, attesiRicezione: Int64)] = []

    /// Rimette tutto com'era: ogni prova che ne sposta una la ripristina con questa.
    static func ripristina() {
        serratura.lock(); defer { serratura.unlock() }
        richieste = []
        proprietaDelTask = []
        corpi = []
        risposta = (200, [:])
        corpo = Data("{}".utf8)
        sospendi = false
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var corpo = Data()
        if let flusso = request.httpBodyStream {
            flusso.open()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while flusso.hasBytesAvailable {
                let letti = flusso.read(&buffer, maxLength: buffer.count)
                if letti <= 0 { break }
                corpo.append(buffer, count: letti)
            }
            flusso.close()
        } else if let b = request.httpBody {
            corpo = b
        }
        ProtocolloFinto.serratura.lock()
        ProtocolloFinto.richieste.append(request)
        ProtocolloFinto.proprietaDelTask.append((task?.taskDescription, task?.earliestBeginDate, task?.countOfBytesClientExpectsToSend ?? -1,
                                                 task?.countOfBytesClientExpectsToReceive ?? -1))
        ProtocolloFinto.corpi.append(corpo)
        let risposta = ProtocolloFinto.risposta
        let corpoRisposta = ProtocolloFinto.corpo
        let sospeso = ProtocolloFinto.sospendi
        ProtocolloFinto.serratura.unlock()
        if sospeso { return }
        if let r = risposta {
            let http = HTTPURLResponse(url: request.url!, statusCode: r.stato, httpVersion: "HTTP/1.1", headerFields: r.intestazioni)!
            client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: corpoRisposta)
            client?.urlProtocolDidFinishLoading(self)
        } else {
            client?.urlProtocol(self, didFailWithError: NSError(domain: NSURLErrorDomain, code: NSURLErrorNotConnectedToInternet, userInfo: nil))
        }
    }

    override func stopLoading() {}
}

func nuovoRegistro(_ trasporto: KVTrasportoRegistro, versione: String? = "1.2+6", ambiente: KVAmbienteBuild = .release,
                   cartella: URL? = nil) -> (KVRegistroNativo, URL) {
    let c = cartella ?? nuovaCartella()
    return (KVRegistroNativo(cartella: c, trasporto: trasporto, versioneApp: versione, ambiente: ambiente, orologio: { orologioProva }), c)
}

func conVersione(_ campi: [String: KVValoreCampo], _ versione: String = "1.2+6") -> [String: KVValoreCampo] {
    var c = campi
    c["versione_app"] = .testo(versione)
    return c
}

let destinazioneProduzione = "https://app.kidville.it/api/logs"

func provaRegistro() {
    sezione("§8.2 — ogni evento: messaggio, livello, stato, `campi`")
    orologioProva = Date(timeIntervalSince1970: floor(Date().timeIntervalSince1970))
    let j = uuid(1)
    let u = uuid(7)
    let sj = "job=" + j.uuidString.lowercased()
    func ultimo(_ r: KVRegistroNativo, _ nome: String, _ messaggio: String, _ livello: String, stato: Int?, campi: [String: KVValoreCampo], utente: UUID?) {
        guard let e = r.stato().eventi.last else { verifica("\(nome): c'è un evento", false); return }
        verificaUguali("\(nome): messaggio", e.messaggio, messaggio)
        verificaUguali("\(nome): livello", e.livello.rawValue, livello)
        verificaUguali("\(nome): stato HTTP", e.stato, stato)
        verificaUguali("\(nome): campi", e.campi, campi)
        verificaUguali("\(nome): utente", e.utenteId, utente)
    }
    let (r, _) = nuovoRegistro(TrasportoFinto())
    r.registraAccodato(job: j, utente: u, byte: 1500, mime: .quicktime, motore: .urlsession)
    ultimo(r, "video-nativo-accodato", "video-nativo-accodato: \(sj)", "warn", stato: nil,
           campi: conVersione(["byte": .numero(1500), "mime": .testo("video/quicktime"), "ambiente": .testo("urlsession")]), utente: u)
    r.registraInviato(job: j, utente: u, byte: 1500, ms: 8200, tentativi: 2, rinnovi: 1, esito: .put, inBackground: true)
    ultimo(r, "video-nativo-inviato (put)", "video-nativo-inviato: \(sj)", "warn", stato: nil,
           campi: conVersione(["byte": .numero(1500), "ms": .numero(8200), "tentativi": .numero(2), "rinnovi": .numero(1),
                               "esito": .testo("put"), "in_background": .booleano(true)]), utente: u)
    r.registraInviato(job: j, utente: u, byte: 1500, ms: 10, tentativi: 3, rinnovi: 2, esito: .giaArrivato, inBackground: false)
    ultimo(r, "video-nativo-inviato (gia-arrivato)", "video-nativo-inviato: \(sj)", "warn", stato: nil,
           campi: conVersione(["byte": .numero(1500), "ms": .numero(10), "tentativi": .numero(3), "rinnovi": .numero(2),
                               "esito": .testo("gia-arrivato"), "in_background": .booleano(false)]), utente: u)
    r.registraRitento(job: j, utente: u, codice: .rete, statoHTTP: 0, tentativo: 1, attesaSecondi: 30, byteInviati: 777)
    ultimo(r, "video-nativo-ritento (rete)", "video-nativo-ritento: \(sj) RETE", "warn", stato: 0,
           campi: conVersione(["tentativo": .numero(1), "attesa_s": .numero(30), "byte_inviati": .numero(777)]), utente: u)
    r.registraRitento(job: j, utente: u, codice: .server, statoHTTP: 503, tentativo: 2, attesaSecondi: 60, byteInviati: 0)
    ultimo(r, "video-nativo-ritento (503)", "video-nativo-ritento: \(sj) SERVER", "warn", stato: 503,
           campi: conVersione(["tentativo": .numero(2), "attesa_s": .numero(60), "byte_inviati": .numero(0)]), utente: u)
    r.registraRinnovo(job: j, utente: u, esito: .daCaricare, statoHTTP: 200, rinnovi: 2, errorCode: .storage(.invalidJWT))
    ultimo(r, "video-nativo-rinnovo (da-caricare, dopo InvalidJWT)", "video-nativo-rinnovo: \(sj) da-caricare", "warn", stato: 200,
           campi: conVersione(["rinnovi": .numero(2), "error_code": .testo("InvalidJWT")]), utente: u)
    r.registraRinnovo(job: j, utente: u, esito: .arrivato, statoHTTP: 200, rinnovi: 3, errorCode: .storage(.duplicate))
    ultimo(r, "video-nativo-rinnovo (arrivato, dopo Duplicate)", "video-nativo-rinnovo: \(sj) arrivato", "warn", stato: 200,
           campi: conVersione(["rinnovi": .numero(3), "error_code": .testo("Duplicate")]), utente: u)
    r.registraRinnovo(job: j, utente: u, esito: .negato, statoHTTP: 404, rinnovi: 1, errorCode: nil)
    ultimo(r, "video-nativo-rinnovo (negato, senza PUT rifiutata)", "video-nativo-rinnovo: \(sj) negato", "warn", stato: 404,
           campi: conVersione(["rinnovi": .numero(1)]), utente: u)
    for (esito, stato) in [(KVEsitoRinnovoLog.annullato, 200), (.tetto, 429), (.rete, 0), (.server, 503)] {
        r.registraRinnovo(job: j, utente: u, esito: esito, statoHTTP: stato, rinnovi: 1, errorCode: nil)
        ultimo(r, "video-nativo-rinnovo (\(esito.rawValue))", "video-nativo-rinnovo: \(sj) \(esito.rawValue)", "warn", stato: stato,
               campi: conVersione(["rinnovi": .numero(1)]), utente: u)
    }
    r.registraPutOltreScadenza(job: j, utente: u, durataSecondi: 7812, statoHTTP: 400)
    ultimo(r, "put-oltre-scadenza", "put-oltre-scadenza: \(sj)", "warn", stato: 400,
           campi: conVersione(["durata_s": .numero(7812)]), utente: u)
    r.registraAttesaRete(job: j, utente: u, notifica: true, autorizzata: false)
    ultimo(r, "video-nativo-attesa-rete", "video-nativo-attesa-rete: \(sj)", "warn", stato: nil,
           campi: conVersione(["notifica": .booleano(true), "autorizzata": .booleano(false)]), utente: u)
    r.registraRipresoDopoChiusura(job: j, utente: u, byteInviati: 12345)
    ultimo(r, "video-nativo-ripreso-dopo-chiusura", "video-nativo-ripreso-dopo-chiusura: \(sj)", "warn", stato: nil,
           campi: conVersione(["byte_inviati": .numero(12345)]), utente: u)
    r.registraAnnullato(job: j, utente: u, da: .utente, byteInviati: 5)
    ultimo(r, "video-nativo-annullato (utente)", "video-nativo-annullato: \(sj) utente", "warn", stato: nil,
           campi: conVersione(["byte_inviati": .numero(5)]), utente: u)
    r.registraAnnullato(job: j, utente: u, da: .server, byteInviati: 0)
    ultimo(r, "video-nativo-annullato (server)", "video-nativo-annullato: \(sj) server", "warn", stato: nil,
           campi: conVersione(["byte_inviati": .numero(0)]), utente: u)
    r.registraFallito(job: j, utente: u, codice: .rinnovoCiclico, operazione: .rinnovo, tentativi: 4, rinnovi: 4, statoHTTP: 400)
    ultimo(r, "video-nativo-fallito (RINNOVO_CICLICO)", "video-nativo-fallito: \(sj) RINNOVO_CICLICO", "error", stato: 400,
           campi: conVersione(["operazione": .testo("rinnovo"), "tentativi": .numero(4), "rinnovi": .numero(4)]), utente: u)
    r.registraFallito(job: j, utente: u, codice: .fileAssente, operazione: .copia, tentativi: 0, rinnovi: 0, statoHTTP: nil)
    ultimo(r, "video-nativo-fallito (FILE_ASSENTE, nessuno scambio HTTP)", "video-nativo-fallito: \(sj) FILE_ASSENTE", "error", stato: nil,
           campi: conVersione(["operazione": .testo("copia"), "tentativi": .numero(0), "rinnovi": .numero(0)]), utente: u)
    r.registraPreparazioneFallita(motivo: .copia, tipo: .video, errorCode: .sistema(KVErroreSistema(dominio: .cocoa, codice: 640)))
    ultimo(r, "media-nativo-preparazione-fallita", "media-nativo-preparazione-fallita: COPIA", "error", stato: nil,
           campi: conVersione(["tipo": .testo("video"), "error_code": .testo("NSCocoaErrorDomain:640")]), utente: nil)
    r.registraPreparazioneFallita(motivo: .riduzione, tipo: .foto, errorCode: nil)
    ultimo(r, "media-nativo-preparazione-fallita (senza codice)", "media-nativo-preparazione-fallita: RIDUZIONE", "error", stato: nil,
           campi: conVersione(["tipo": .testo("foto")]), utente: nil)
    r.registraMotore(motore: .urlsession, occasione: .rilancioBackground, inCoda: 1, inInvio: 2, taskVivi: 2)
    ultimo(r, "caricamenti-nativi-motore", "caricamenti-nativi-motore: urlsession rilancio-background", "warn", stato: nil,
           campi: conVersione(["in_coda": .numero(1), "in_invio": .numero(2), "task_vivi": .numero(2)]), utente: nil)
    for occasione in [KVOccasioneMotore.avvio, .primoPiano] {
        r.registraMotore(motore: .urlsession, occasione: occasione, inCoda: 0, inInvio: 0, taskVivi: 0)
        verificaUguali("caricamenti-nativi-motore (\(occasione.rawValue)): messaggio", r.stato().eventi.last?.messaggio, "caricamenti-nativi-motore: urlsession \(occasione.rawValue)")
    }
    r.registraCodaCorrotta(fileOrfani: 3)
    ultimo(r, "coda-nativa-corrotta", "coda-nativa-corrotta", "error", stato: nil, campi: conVersione(["file_orfani": .numero(3)]), utente: nil)
    r.registraCodaCorrotta(fileOrfani: 1, vociScartate: 2)
    ultimo(r, "coda-nativa-corrotta (con voci scartate)", "coda-nativa-corrotta", "error", stato: nil,
           campi: conVersione(["file_orfani": .numero(1), "voci_scartate": .numero(2)]), utente: nil)
    r.registraCodaCorrotta(fileOrfani: 0, vociScartate: 0)
    ultimo(r, "coda-nativa-corrotta (voci_scartate = 0 non si scrive)", "coda-nativa-corrotta", "error", stato: nil, campi: conVersione(["file_orfani": .numero(0)]), utente: nil)
    let prima = r.stato().eventi.count
    r.registraNotificaNonAutorizzata()
    ultimo(r, "notifica-locale-non-autorizzata", "notifica-locale-non-autorizzata", "warn", stato: nil, campi: conVersione([:]), utente: nil)
    r.registraNotificaNonAutorizzata()
    r.registraNotificaNonAutorizzata()
    verificaUguali("notifica-locale-non-autorizzata: UNA volta per installazione", r.stato().eventi.count, prima + 1)

    sezione("§8.1 — le regole su ogni evento scritto: slug dell'elenco, chiavi dell'elenco, ≤ 12 campi, niente dati personali")
    let eventiTutti = r.stato().eventi
    let slugAmmessi = Set(KVMessaggioLog.allCases.map { $0.rawValue })
    let chiaviAmmesse = Set(KVChiaveCampo.allCases.map { $0.rawValue })
    verifica("ogni messaggio comincia con uno slug dell'elenco chiuso (\(eventiTutti.count) eventi)",
             eventiTutti.allSatisfy { e in slugAmmessi.contains(String(e.messaggio.prefix(while: { $0 != ":" && $0 != " " }))) })
    verifica("ogni chiave di `campi` è nell'elenco chiuso", eventiTutti.allSatisfy { Set($0.campi.keys).isSubset(of: chiaviAmmesse) })
    verifica("al più 12 campi per evento", eventiTutti.allSatisfy { $0.campi.count <= 12 })
    verifica("ogni evento porta versione_app nella forma 1.2+6", eventiTutti.allSatisfy { $0.campi["versione_app"] == .testo("1.2+6") })
    verifica("ogni stato HTTP sta fra 0 e 599", eventiTutti.allSatisfy { ($0.stato ?? 0) >= 0 && ($0.stato ?? 0) <= 599 })
    let tuttoIlTesto = eventiTutti.flatMap { e in [e.messaggio] + e.campi.values.compactMap { v -> String? in if case .testo(let t) = v { return t }; return nil } }
    verifica("nessun URL, percorso, e-mail, token kvr_ o host dello Storage in nessun testo",
             tuttoIlTesto.allSatisfy { !$0.contains("://") && !$0.contains("@") && !$0.contains("/api/") && !$0.contains("kvr_") && !$0.contains("supabase") && !$0.contains(".mov") })
    verifica("ogni testo di un campo è breve (≤ 64 caratteri, come lo vuole la porta dei log)",
             eventiTutti.allSatisfy { $0.campi.values.allSatisfy { if case .testo(let t) = $0 { return t.count <= 64 }; return true } })
    verifica("i job compaiono solo come uuid minuscolo nel messaggio",
             eventiTutti.filter { $0.messaggio.contains("job=") }.allSatisfy {
                 $0.messaggio.range(of: "job=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}( [A-Za-z_-]+)?$", options: .regularExpression) != nil
             })
    verificaUguali("i livelli sono quelli di §8.2: error solo per fallito, preparazione fallita, coda corrotta",
                   Set(KVMessaggioLog.allCases.filter { $0.livello == .error }.map { $0.rawValue }),
                   Set(["video-nativo-fallito", "media-nativo-preparazione-fallita", "coda-nativa-corrotta"]))

    sezione("§8.1 — i ritentativi si loggano ai tentativi 1, 2, 4, 8, 16, …")
    do {
        let (rr, _) = nuovoRegistro(TrasportoFinto())
        for n in 1...17 { rr.registraRitento(job: j, utente: u, codice: .rete, statoHTTP: 0, tentativo: n, attesaSecondi: 30, byteInviati: 0) }
        verificaUguali("su 17 ritentativi se ne scrivono 5", rr.stato().eventi.count, 5)
        verificaUguali("… quelli dei tentativi 1, 2, 4, 8, 16", rr.stato().eventi.map { $0.campi["tentativo"] }, [1, 2, 4, 8, 16].map { Optional(KVValoreCampo.numero(Int64($0))) })
    }

    sezione("lo stato HTTP di un evento sta fra 0 e 599 (la colonna del server è intera e la porta lo vuole così)")
    do {
        let (rr, _) = nuovoRegistro(TrasportoFinto())
        for (dato, atteso) in [(0, Optional(0)), (599, 599), (600, nil), (700, nil), (99999, nil), (-1, nil), (-500, nil), (503, 503)] as [(Int, Int?)] {
            rr.registraFallito(job: j, utente: u, codice: .interno, operazione: .put, tentativi: 1, rinnovi: 0, statoHTTP: dato)
            verificaUguali("stato HTTP \(dato) → \(atteso.map { String($0) } ?? "assente")", rr.stato().eventi.last?.stato, atteso)
        }
    }

    sezione("dalla decisione al log: ciò che la politica dice e ciò che il registro scrive combaciano (S0, rinnovo, transitorio)")
    do {
        let (rr, _) = nuovoRegistro(TrasportoFinto())
        // 400 InvalidJWT dopo 7.812 s → rinnovo + put-oltre-scadenza con la durata in secondi
        let corpoJwt = corpoStorage(statusCode: "400", errore: "InvalidJWT")
        let d = KVPoliticaCaricamento.decidiPut(KVRispostaPut(statoHTTP: 400, corpo: corpoJwt, durataSecondi: 7812, trasferimentoCompleto: true), tentativo: 1, adesso: t0, casuale: 0.5)
        if case .rinnova(let errore, let stato, let oltre) = d, let durata = oltre {
            rr.registraPutOltreScadenza(job: j, utente: u, durataSecondi: durata, statoHTTP: stato)
            let risposta = KVPoliticaCaricamento.leggiRispostaRinnovo(statoHTTP: 200, corpo: corpoRinnovo(), retryAfter: nil, adesso: t0, ambiente: .release)
            rr.registraRinnovo(job: j, utente: u, esito: risposta.esitoLog, statoHTTP: risposta.statoHTTP, rinnovi: 1, errorCode: errore.map { KVErrorCode.storage($0) })
        } else { verifica("400 InvalidJWT dopo 7.812 s → rinnovo con la durata", false, "ottenuto: \(d)") }
        let scritti = rr.stato().eventi
        verificaUguali("InvalidJWT dopo il trasferimento: due righe, put-oltre-scadenza e poi il rinnovo",
                       scritti.map { $0.messaggio }, ["put-oltre-scadenza: \(sj)", "video-nativo-rinnovo: \(sj) da-caricare"])
        verificaUguali("… put-oltre-scadenza porta la durata in secondi e lo stato HTTP della PUT", [scritti.first?.campi["durata_s"], scritti.first?.stato.map { KVValoreCampo.numero(Int64($0)) }],
                       [.numero(7812), .numero(400)])
        verificaUguali("… il rinnovo porta il nome d'errore della PUT che l'ha causato", scritti.last?.campi["error_code"], .testo("InvalidJWT"))
        // 503 → ritento
        let t = KVPoliticaCaricamento.decidiPut(KVRispostaPut(statoHTTP: 503, retryAfter: "45"), tentativo: 1, adesso: t0, casuale: 0.5)
        if case .riprova(let attesa, let codice, let stato) = t {
            rr.registraRitento(job: j, utente: u, codice: codice, statoHTTP: stato, tentativo: 1, attesaSecondi: Int(attesa.rounded()), byteInviati: 100)
        } else { verifica("503 → riprova", false) }
        verificaUguali("503 con Retry-After 45: il ritento scrive stato 503, attesa_s 45, codice SERVER",
                       [rr.stato().eventi.last?.stato.map { KVValoreCampo.numero(Int64($0)) }, rr.stato().eventi.last?.campi["attesa_s"]], [.numero(503), .numero(45)])
        verificaUguali("… e il messaggio", rr.stato().eventi.last?.messaggio, "video-nativo-ritento: \(sj) SERVER")
    }

    sezione("il MIME nel log: sempre un valore dell'elenco, mai la stringa del sistema")
    for (grezzo, atteso) in [("video/mp4", KVMimeVideo.mp4), ("video/quicktime", .quicktime), ("VIDEO/QuickTime", .quicktime), ("video/x-m4v", .m4v),
                             ("video/3gpp", .treGpp), ("video/mpeg", .mpeg), ("video/mp4;codecs=avc1.42E01E,mp4a.40.2", .mp4),
                             (" video/mp4 ; codecs=avc1", .mp4), ("application/pdf", .altro), ("image/jpeg", .altro), ("", .altro), ("boh", .altro),
                             ("video/x-matroska", .altro), ("video/mp4x", .altro)] {
        verificaUguali("MIME «\(grezzo)» → \(atteso.rawValue)", KVMimeVideo(mime: grezzo), atteso)
    }

    sezione("la versione dell'app: `<versione>+<build>` nella forma che il server lascia in chiaro")
    do {
        let (senza, _) = nuovoRegistro(TrasportoFinto(), versione: nil)
        senza.registraCodaCorrotta(fileOrfani: 1)
        verificaUguali("senza versione il campo non parte", senza.stato().eventi.first?.campi["versione_app"], nil)
        let (storta, _) = nuovoRegistro(TrasportoFinto(), versione: "1.2-beta")
        storta.registraCodaCorrotta(fileOrfani: 1)
        verificaUguali("una versione di forma sbagliata non parte (il server la redigerebbe)", storta.stato().eventi.first?.campi["versione_app"], nil)
    }
    let F = KVRegistroNativo.formaVersioneAppValida
    for ok in ["1.2+6", "1.1+5", "10.20.30+400", "1+1", "1.2.3.4+123456789", "9999.9999+1"] { verifica("forma valida: \(ok)", F(ok)) }
    for no in ["", "1.2", "1.2+", "+6", "1.2+x", "1.2-beta+6", "12345.1+1", "1.2+1234567890", "1.2.3.4.5+1", "v1.2+6", "1.2 +6", "1.2+6\n", "1..2+6"] {
        verifica("forma respinta: «\(no.replacingOccurrences(of: "\n", with: "\\n"))»", !F(no))
    }
    verificaUguali("da Info.plist: 1.2 e 6", KVRegistroNativo.versioneApp(infoDictionary: ["CFBundleShortVersionString": "1.2", "CFBundleVersion": "6"]), "1.2+6")
    verificaUguali("da Info.plist: con spazi attorno", KVRegistroNativo.versioneApp(infoDictionary: ["CFBundleShortVersionString": " 1.2 ", "CFBundleVersion": "6 "]), "1.2+6")
    verificaUguali("da Info.plist: manca la build", KVRegistroNativo.versioneApp(infoDictionary: ["CFBundleShortVersionString": "1.2"]), nil)
    verificaUguali("da Info.plist: manca la versione", KVRegistroNativo.versioneApp(infoDictionary: ["CFBundleVersion": "6"]), nil)
    verificaUguali("da Info.plist: versione di forma sbagliata", KVRegistroNativo.versioneApp(infoDictionary: ["CFBundleShortVersionString": "1.2-beta", "CFBundleVersion": "6"]), nil)
    verificaUguali("da Info.plist: nessun dizionario", KVRegistroNativo.versioneApp(infoDictionary: nil), nil)

    sezione("§8.1 — tetto di 200 eventi: si scartano i più vecchi e si contano; poi `registro-nativo-scartati`")
    do {
        let trasporto = TrasportoFinto()
        let (rr, cart) = nuovoRegistro(trasporto)
        for n in 1...205 { rr.registraAccodato(job: uuid(n), utente: u, byte: Int64(n), mime: .mp4, motore: .urlsession) }
        var s = rr.stato()
        verificaUguali("205 eventi scritti: ne restano 200", s.eventi.count, 200)
        verificaUguali("… i 5 più vecchi sono andati e contati", s.scartati, 5)
        verificaUguali("… il più vecchio rimasto è il sesto", s.eventi.first?.campi["byte"], .numero(6))
        verificaUguali("… il più recente è l'ultimo", s.eventi.last?.campi["byte"], .numero(205))
        verificaUguali("senza destinazione non si spedisce niente", rr.svuota(), .nulla)
        verificaUguali("… e non si tocca niente", rr.stato().eventi.count, 200)
        verificaUguali("destinazione fuori dall'elenco degli host: rifiutata", rr.impostaDestinazione("https://evil.example.com/api/logs"), false)
        verificaUguali("destinazione col sito: accettata", rr.impostaDestinazione(destinazioneProduzione), true)
        orologioProva = orologioProva.addingTimeInterval(100)
        let esito = rr.svuota()
        verificaUguali("il giornale è pieno: parte un lotto di 20", esito, .spedito(eventi: 20))
        s = rr.stato()
        verificaUguali("… l'evento dei persi NON si scrive finché il giornale è pieno (ne farebbe scartare un altro)", s.scartati, 5)
        verificaUguali("… il lotto è uscito (180 rimasti)", s.eventi.count, 180)
        orologioProva = orologioProva.addingTimeInterval(11)
        _ = rr.svuota()
        s = rr.stato()
        verificaUguali("al lotto successivo c'è posto: l'evento dei persi è scritto UNA volta e il conto riparte da zero", s.scartati, 0)
        let sommario = s.eventi.filter { $0.messaggio == "registro-nativo-scartati" }
        verificaUguali("… un solo evento registro-nativo-scartati", sommario.count, 1)
        verificaUguali("… livello warn", sommario.first?.livello, .warn)
        verificaUguali("… scartati 5", sommario.first?.campi["scartati"], .numero(5))
        verifica("… e l'evento dei persi non ha né utente né job", sommario.first?.utenteId == nil && !(sommario.first?.messaggio.contains("job=") ?? true))
        // persiste
        let (rr2, _) = nuovoRegistro(trasporto, cartella: cart)
        verificaUguali("un'altra istanza rilegge gli eventi", rr2.stato().eventi, s.eventi)
        verificaUguali("… e la destinazione", rr2.stato().destinazione?.host, "app.kidville.it")
    }

    sezione("§8.1 — lotti da 20, al più uno ogni 10 secondi")
    do {
        let trasporto = TrasportoFinto()
        let (rr, _) = nuovoRegistro(trasporto)
        _ = rr.impostaDestinazione(destinazioneProduzione)
        let inizio = Date(timeIntervalSince1970: floor(Date().timeIntervalSince1970))
        orologioProva = inizio
        func byteDelLotto(_ n: Int) -> [Int] { trasporto.eventi(n).map { ($0["campi"] as? [String: Any])?["byte"] as? Int ?? -1 } }
        for n in 1...45 { rr.registraAccodato(job: uuid(n), utente: u, byte: Int64(n), mime: .mp4, motore: .urlsession) }
        verificaUguali("primo svuotamento: 20 eventi", rr.svuota(), .spedito(eventi: 20))
        verificaUguali("… una richiesta", trasporto.richieste.count, 1)
        verificaUguali("… il lotto è fatto dei primi 20, in ordine", byteDelLotto(0), Array(1...20))
        verificaUguali("subito dopo: troppo presto (mancano 10 s)", rr.svuota(), .troppoPresto(attesa: 10))
        orologioProva = inizio.addingTimeInterval(5)
        verificaUguali("dopo 5 secondi: ancora troppo presto, ne mancano 5", rr.svuota(), .troppoPresto(attesa: 5))
        orologioProva = inizio.addingTimeInterval(9.999)
        if case .troppoPresto(let attesa) = rr.svuota() { verifica("dopo 9,999 secondi: ancora troppo presto", vicini(attesa, 0.001)) }
        else { verifica("dopo 9,999 secondi: troppo presto", false) }
        verificaUguali("… nessuna richiesta in più", trasporto.richieste.count, 1)
        orologioProva = inizio.addingTimeInterval(10)
        verificaUguali("a 10 secondi esatti: parte il secondo lotto da 20", rr.svuota(), .spedito(eventi: 20))
        verificaUguali("… i successivi 20", byteDelLotto(1), Array(21...40))
        orologioProva = inizio.addingTimeInterval(20)
        verificaUguali("il terzo lotto: gli ultimi 5", rr.svuota(), .spedito(eventi: 5))
        verificaUguali("… i 5 che restavano", byteDelLotto(2), Array(41...45))
        orologioProva = inizio.addingTimeInterval(30)
        verificaUguali("poi non c'è più niente", rr.svuota(), .nulla)
        verificaUguali("… il registro è vuoto", rr.stato().eventi.count, 0)
        verificaUguali("tre richieste in tutto, nessuna con più di 20 eventi", [trasporto.richieste.count, (0..<3).map { trasporto.eventi($0).count }.max() ?? 0], [3, 20])
    }

    sezione("§8.1 — l'esito dell'invio: 2xx esce, 429 aspetta, altro 4xx si butta e si conta, 5xx e rete si tengono")
    func provaStato(_ nome: String, _ risposta: KVRispostaRegistro, rimasti: Int, scartati: Int, prossimoInvio: TimeInterval? = nil) {
        let trasporto = TrasportoFinto()
        trasporto.risposte = [risposta]
        let (rr, _) = nuovoRegistro(trasporto)
        _ = rr.impostaDestinazione(destinazioneProduzione)
        orologioProva = Date(timeIntervalSince1970: floor(Date().timeIntervalSince1970))
        let inizio = orologioProva
        for n in 1...3 { rr.registraAccodato(job: uuid(n), utente: u, byte: Int64(n), mime: .mp4, motore: .urlsession) }
        verificaUguali("\(nome): un lotto parte", rr.svuota(), .spedito(eventi: 3))
        let s = rr.stato()
        verificaUguali("\(nome): eventi rimasti", s.eventi.count, rimasti)
        verificaUguali("\(nome): scartati", s.scartati, scartati)
        if let attesa = prossimoInvio {
            orologioProva = inizio.addingTimeInterval(attesa - 1)
            if case .troppoPresto(let mancano) = rr.svuota() { verifica("\(nome): un secondo prima di \(Int(attesa)) s è troppo presto (mancano \(Int(mancano)) s)", vicini(mancano, 1)) }
            else { verifica("\(nome): un secondo prima di \(Int(attesa)) s è troppo presto", false) }
            orologioProva = inizio.addingTimeInterval(attesa)
            verificaUguali("\(nome): a \(Int(attesa)) s si riprova", rr.svuota(), .spedito(eventi: 3))
        }
    }
    provaStato("200", .stato(200, retryAfter: nil), rimasti: 0, scartati: 0)
    provaStato("201", .stato(201, retryAfter: nil), rimasti: 0, scartati: 0)
    provaStato("429 con Retry-After 120", .stato(429, retryAfter: "120"), rimasti: 3, scartati: 0, prossimoInvio: 120)
    provaStato("429 senza Retry-After (resta il limite dei 10 s)", .stato(429, retryAfter: nil), rimasti: 3, scartati: 0, prossimoInvio: 10)
    provaStato("429 con Retry-After 3 (non scende sotto i 10 s)", .stato(429, retryAfter: "3"), rimasti: 3, scartati: 0, prossimoInvio: 10)
    provaStato("429 con Retry-After enorme (tetto 1 h)", .stato(429, retryAfter: "99999"), rimasti: 3, scartati: 0, prossimoInvio: 3600)
    provaStato("429 con un Retry-After che non si legge", .stato(429, retryAfter: "boh"), rimasti: 3, scartati: 0, prossimoInvio: 10)
    for codice in [400, 401, 403, 404, 408, 413, 422, 499] {
        provaStato("\(codice) (altro 4xx: il lotto è scartato e contato)", .stato(codice, retryAfter: nil), rimasti: 0, scartati: 3)
    }
    for codice in [500, 502, 503, 504] {
        provaStato("\(codice) (5xx: si tiene)", .stato(codice, retryAfter: nil), rimasti: 3, scartati: 0)
    }
    provaStato("nessuna risposta (rete: si tiene)", .nessunaRisposta, rimasti: 3, scartati: 0)
    provaStato("3xx (altro: si tiene)", .stato(302, retryAfter: nil), rimasti: 3, scartati: 0)

    sezione("§8.1 — un lotto per utente, con la sua identità (`x-user-id`); gli eventi senza voce vanno all'ultimo utente noto")
    do {
        let trasporto = TrasportoFinto()
        let (rr, _) = nuovoRegistro(trasporto)
        _ = rr.impostaDestinazione(destinazioneProduzione)
        let inizio = Date(timeIntervalSince1970: floor(Date().timeIntervalSince1970))
        orologioProva = inizio
        rr.registraAccodato(job: uuid(1), utente: uuid(10), byte: 1, mime: .mp4, motore: .urlsession)
        rr.registraAccodato(job: uuid(2), utente: uuid(20), byte: 2, mime: .mp4, motore: .urlsession)
        rr.registraInviato(job: uuid(1), utente: uuid(10), byte: 1, ms: 1, tentativi: 1, rinnovi: 0, esito: .put, inBackground: false)
        rr.registraCodaCorrotta(fileOrfani: 0)
        verificaUguali("l'ultimo utente noto è l'ultimo che ha scritto con una voce", rr.stato().ultimoUtente, uuid(10))
        verificaUguali("primo lotto: gli eventi del primo utente + l'evento senza voce (è dell'ultimo utente noto)", rr.svuota(), .spedito(eventi: 3))
        verificaUguali("… con l'identità del primo", trasporto.richieste.last?.utenteId, uuid(10))
        verificaUguali("… i messaggi, in ordine", trasporto.eventi(0).map { $0["messaggio"] as? String ?? "" },
                       ["video-nativo-accodato: job=\(uuid(1).uuidString.lowercased())", "video-nativo-inviato: job=\(uuid(1).uuidString.lowercased())", "coda-nativa-corrotta"])
        orologioProva = inizio.addingTimeInterval(11)
        verificaUguali("secondo lotto: il secondo utente", rr.svuota(), .spedito(eventi: 1))
        verificaUguali("… con l'identità del secondo", trasporto.richieste.last?.utenteId, uuid(20))
        let (anonimo, _) = nuovoRegistro(trasporto)
        _ = anonimo.impostaDestinazione(destinazioneProduzione)
        anonimo.registraCodaCorrotta(fileOrfani: 0)
        orologioProva = inizio.addingTimeInterval(30)
        _ = anonimo.svuota()
        verificaUguali("un evento senza voce e senza nessun utente noto parte senza identità (la porta è anonima)", trasporto.richieste.last?.utenteId, nil)
    }

    sezione("§8.1 — il corpo: {eventi, piattaforma}, solo le chiavi che la porta dei log legge")
    do {
        let trasporto = TrasportoFinto()
        let (rr, _) = nuovoRegistro(trasporto)
        _ = rr.impostaDestinazione("https://app.kidville.it/api/logs")
        rr.registraRitento(job: j, utente: u, codice: .server, statoHTTP: 503, tentativo: 1, attesaSecondi: 30, byteInviati: 9)
        rr.registraFallito(job: j, utente: u, codice: .troppoGrande, operazione: .put, tentativi: 1, rinnovi: 0, statoHTTP: 413)
        rr.registraNotificaNonAutorizzata()
        _ = rr.svuota()
        verificaUguali("una sola richiesta", trasporto.richieste.count, 1)
        verificaUguali("… all'indirizzo di destinazione", trasporto.richieste.first?.url.host, "app.kidville.it")
        verificaUguali("il corpo ha solo {eventi, piattaforma}", Set(trasporto.corpo(0).keys), Set(["eventi", "piattaforma"]))
        verificaUguali("piattaforma ios", trasporto.corpo(0)["piattaforma"] as? String, "ios")
        let eventi = trasporto.eventi(0)
        verificaUguali("tre eventi", eventi.count, 3)
        verifica("ogni evento ha solo livello, evento, messaggio, stato, campi (niente progressivo, niente utente)",
                 eventi.allSatisfy { Set($0.keys).isSubset(of: ["livello", "evento", "messaggio", "stato", "campi"]) })
        verificaUguali("evento = caricamento-nativo", Set(eventi.compactMap { $0["evento"] as? String }), ["caricamento-nativo"])
        verificaUguali("livelli", eventi.compactMap { $0["livello"] as? String }, ["warn", "error", "warn"])
        verificaUguali("stato presente dove c'è uno scambio HTTP", eventi.map { $0["stato"] as? Int }, [503, 413, nil])
        let campi0 = eventi[0]["campi"] as? [String: Any] ?? [:]
        verificaUguali("campi: numeri come numeri JSON", [campi0["tentativo"] as? Int, campi0["attesa_s"] as? Int, campi0["byte_inviati"] as? Int], [1, 30, 9])
        verificaUguali("campi: versione_app come testo", campi0["versione_app"] as? String, "1.2+6")
        let campi2 = eventi[1]["campi"] as? [String: Any] ?? [:]
        verificaUguali("campi: gli enumerati come testo", [campi2["operazione"] as? String], ["put"])
        let campiAttesa = { () -> [String: Any] in
            let (rr3, _) = nuovoRegistro(trasporto)
            _ = rr3.impostaDestinazione(destinazioneProduzione)
            rr3.registraAttesaRete(job: j, utente: u, notifica: true, autorizzata: false)
            orologioProva = orologioProva.addingTimeInterval(11)
            _ = rr3.svuota()
            return (trasporto.eventi(trasporto.richieste.count - 1).first?["campi"] as? [String: Any]) ?? [:]
        }()
        verificaUguali("campi: i booleani come booleani JSON (non 0/1)", [campiAttesa["notifica"] is Bool, campiAttesa["autorizzata"] is Bool], [true, true])
        verificaUguali("… e coi valori giusti", [campiAttesa["notifica"] as? Bool, campiAttesa["autorizzata"] as? Bool], [true, false])
        let (senzaVersione, _) = nuovoRegistro(trasporto, versione: nil)
        _ = senzaVersione.impostaDestinazione(destinazioneProduzione)
        senzaVersione.registraNotificaNonAutorizzata()
        orologioProva = orologioProva.addingTimeInterval(11)
        _ = senzaVersione.svuota()
        verificaUguali("un evento senza nessun campo parte senza la chiave `campi`", trasporto.eventi(trasporto.richieste.count - 1).first?.keys.contains("campi"), false)
    }

    sezione("l'invio e le chiamate concorrenti")
    do {
        let trasporto = TrasportoFinto()
        trasporto.sincrono = false
        let (rr, _) = nuovoRegistro(trasporto)
        _ = rr.impostaDestinazione(destinazioneProduzione)
        rr.registraCodaCorrotta(fileOrfani: 0)
        var finito = 0
        verificaUguali("parte un invio", rr.svuota(completamento: { finito += 1 }), .spedito(eventi: 1))
        verificaUguali("il completamento non scatta prima della risposta", finito, 0)
        verificaUguali("un secondo svuotamento mentre l'invio è in volo: già in corso", rr.svuota(), .giaInCorso)
        verificaUguali("… e il suo completamento scatta subito (non parte niente)", { () -> Int in
            var n = 0
            _ = rr.svuota(completamento: { n += 1 })
            return n
        }(), 1)
        rr.registraCodaCorrotta(fileOrfani: 1)
        trasporto.rispondiAlSospeso()
        verificaUguali("alla risposta il completamento scatta", finito, 1)
        verificaUguali("… e l'evento arrivato mentre si spediva è rimasto, quello spedito è uscito", rr.stato().eventi.map { $0.campi["file_orfani"] }, [.numero(1)])
        let (rc, _) = nuovoRegistro(TrasportoFinto())
        DispatchQueue.concurrentPerform(iterations: 300) { i in
            rc.registraAccodato(job: uuid(i + 1), utente: uuid(1), byte: Int64(i), mime: .mp4, motore: .urlsession)
        }
        let s = rc.stato()
        verificaUguali("300 eventi scritti da thread diversi: 200 restano e 100 sono contati", [s.eventi.count, s.scartati], [200, 100])
        verificaUguali("… i progressivi sono tutti diversi", Set(s.eventi.map { $0.progressivo }).count, 200)
    }

    sezione("il completamento scatta SEMPRE: quando l'invio finisce, e subito quando non parte niente")
    do {
        let trasporto = TrasportoFinto()
        let (rr, _) = nuovoRegistro(trasporto)
        let inizio = Date(timeIntervalSince1970: floor(Date().timeIntervalSince1970))
        orologioProva = inizio
        func conta(_ r: KVRegistroNativo, adesso: Date? = nil) -> (KVEsitoSvuotamento, Int) {
            var n = 0
            let esito = r.svuota(adesso: adesso, completamento: { n += 1 })
            return (esito, n)
        }
        let senzaDestinazione = conta(rr)
        verificaUguali("senza destinazione: nulla, e il completamento scatta una volta", [senzaDestinazione.0 == .nulla, senzaDestinazione.1 == 1], [true, true])
        _ = rr.impostaDestinazione(destinazioneProduzione)
        let vuoto = conta(rr)
        verificaUguali("registro vuoto: nulla, e il completamento scatta una volta", [vuoto.0 == .nulla, vuoto.1 == 1], [true, true])
        rr.registraCodaCorrotta(fileOrfani: 0)
        let primo = conta(rr)
        verificaUguali("invio sincrono: spedito, e il completamento scatta una volta (alla risposta)", [primo.0 == .spedito(eventi: 1), primo.1 == 1], [true, true])
        rr.registraCodaCorrotta(fileOrfani: 1)
        let presto = conta(rr)
        verificaUguali("troppo presto: il completamento scatta comunque, una volta", [presto.0 == .troppoPresto(attesa: 10), presto.1 == 1], [true, true])
        orologioProva = inizio.addingTimeInterval(11)
        let secondo = conta(rr)
        verificaUguali("dopo l'attesa: spedito, e il completamento scatta una volta", [secondo.0 == .spedito(eventi: 1), secondo.1 == 1], [true, true])
        // un registro che sparisce prima della risposta non deve lasciare il completamento sospeso
        let asincrono = TrasportoFinto()
        asincrono.sincrono = false
        var scattato = 0
        do {
            let (effimero, _) = nuovoRegistro(asincrono)
            _ = effimero.impostaDestinazione(destinazioneProduzione)
            effimero.registraCodaCorrotta(fileOrfani: 2)
            _ = effimero.svuota(adesso: inizio.addingTimeInterval(100), completamento: { scattato += 1 })
        }
        asincrono.rispondiAlSospeso()
        verificaUguali("registro rilasciato prima della risposta: il completamento scatta lo stesso (la sessione in background non resta appesa)", scattato, 1)
    }

    sezione("l'evento dei persi porta anche lui la versione dell'app, e nessun utente né job")
    do {
        let trasporto = TrasportoFinto()
        let (rr, _) = nuovoRegistro(trasporto)
        _ = rr.impostaDestinazione(destinazioneProduzione)
        let inizio = Date(timeIntervalSince1970: floor(Date().timeIntervalSince1970))
        orologioProva = inizio
        for n in 1...201 { rr.registraAccodato(job: uuid(n), utente: u, byte: Int64(n), mime: .mp4, motore: .urlsession) }
        _ = rr.svuota()
        orologioProva = inizio.addingTimeInterval(11)
        _ = rr.svuota()
        let sommari = rr.stato().eventi.filter { $0.messaggio == "registro-nativo-scartati" }
        verificaUguali("c'è l'evento dei persi", sommari.count, 1)
        verificaUguali("… con scartati 1 e versione_app", sommari.first?.campi, ["scartati": .numero(1), "versione_app": .testo("1.2+6")])
    }

    sezione("la destinazione: solo gli host ammessi, e si ricorda")
    do {
        let (rr, cart) = nuovoRegistro(TrasportoFinto(), ambiente: .release)
        for no in ["http://app.kidville.it/api/logs", "https://evil.example.com/api/logs", "http://localhost:3101/api/logs", "https://app.kidville.it@evil.com/api/logs", "", "boh"] {
            verificaUguali("Release respinge \(no)", rr.impostaDestinazione(no), false)
        }
        verificaUguali("… e non ne ha memorizzata nessuna", rr.stato().destinazione, nil)
        verificaUguali("Release accetta https://app.kidville.it", rr.impostaDestinazione("https://app.kidville.it/api/logs"), true)
        verificaUguali("… poi respinge un altro host senza perdere quello buono", [rr.impostaDestinazione("https://evil.example.com/api/logs"), rr.stato().destinazione?.host == "app.kidville.it"], [false, true])
        let (rd, _) = nuovoRegistro(TrasportoFinto(), ambiente: .debug)
        verificaUguali("Debug accetta localhost", rd.impostaDestinazione("http://localhost:3101/api/logs"), true)
        verificaUguali("Debug accetta 10.0.2.2", rd.impostaDestinazione("http://10.0.2.2:3101/api/logs"), true)
        verificaUguali("Debug respinge un host qualunque", rd.impostaDestinazione("http://192.168.1.5:3101/api/logs"), false)
        _ = cart
    }

    sezione("il giornale su disco: ciò che si è perso e ciò che si è già detto restano dopo un riavvio")
    do {
        let cart = nuovaCartella()
        let (primo, _) = nuovoRegistro(TrasportoFinto(), cartella: cart)
        for n in 1...203 { primo.registraAccodato(job: uuid(n), utente: u, byte: Int64(n), mime: .mp4, motore: .urlsession) }
        _ = primo.impostaDestinazione(destinazioneProduzione)
        let (secondo, _) = nuovoRegistro(TrasportoFinto(), cartella: cart)
        verificaUguali("gli eventi scartati per il tetto si ricordano (203 scritti, 200 restano)", [secondo.stato().eventi.count, secondo.stato().scartati], [200, 3])
        verificaUguali("l'ultimo utente noto si ricorda", secondo.stato().ultimoUtente, u)
        verificaUguali("… e la destinazione si ricorda", secondo.stato().destinazione?.host, "app.kidville.it")
    }
    do {
        // Un registro con pochi eventi: il tetto non c'entra, e un evento in più si vede.
        let cart = nuovaCartella()
        let (primo, _) = nuovoRegistro(TrasportoFinto(), cartella: cart)
        primo.registraNotificaNonAutorizzata()
        verificaUguali("«notifica non autorizzata»: scritta la prima volta", primo.stato().eventi.count, 1)
        let (secondo, _) = nuovoRegistro(TrasportoFinto(), cartella: cart)
        secondo.registraNotificaNonAutorizzata()
        verificaUguali("… e dopo un riavvio NON si riscrive: una volta per INSTALLAZIONE, non per avvio", secondo.stato().eventi.count, 1)
    }

    sezione("il giornale su disco: se è rotto si riparte vuoti e si dichiara una perdita")
    do {
        let cart = nuovaCartella()
        try! Data("{ rotto".utf8).write(to: cart.appendingPathComponent("registro.json"))
        let (rr, _) = nuovoRegistro(TrasportoFinto(), cartella: cart)
        verificaUguali("registro illeggibile: vuoto", rr.stato().eventi.count, 0)
        verificaUguali("… con una perdita dichiarata (non sappiamo quanti eventi c'erano)", rr.stato().scartati, 1)
        let (vers, _) = nuovoRegistro(TrasportoFinto(), cartella: nuovaCartella())
        vers.registraCodaCorrotta(fileOrfani: 1)
        let cart2 = nuovaCartella()
        try! Data("{\"versione\":9,\"eventi\":[],\"scartati\":0,\"prossimoProgressivo\":1,\"notificaNonAutorizzataScritta\":false}".utf8).write(to: cart2.appendingPathComponent("registro.json"))
        let (altra, _) = nuovoRegistro(TrasportoFinto(), cartella: cart2)
        verificaUguali("registro di una versione sconosciuta: si riparte vuoti con una perdita", [altra.stato().eventi.count, altra.stato().scartati], [0, 1])
        let cart3 = nuovaCartella()
        let (primo, _) = nuovoRegistro(TrasportoFinto(), cartella: cart3)
        primo.registraAccodato(job: uuid(1), utente: uuid(1), byte: 1, mime: .mp4, motore: .urlsession)
        primo.registraAccodato(job: uuid(2), utente: uuid(1), byte: 2, mime: .mp4, motore: .urlsession)
        let (secondo, _) = nuovoRegistro(TrasportoFinto(), cartella: cart3)
        secondo.registraAccodato(job: uuid(3), utente: uuid(1), byte: 3, mime: .mp4, motore: .urlsession)
        verificaUguali("dopo un riavvio i progressivi non si ripetono", secondo.stato().eventi.map { $0.progressivo }, [1, 2, 3])
        verifica("il giornale nella cartella ha un solo file, senza temporanei", nomiIn(cart3) == ["registro.json"], "\(nomiIn(cart3))")
    }

    sezione("il giornale su disco: ogni TIPO di campo (numero, booleano, testo) torna UGUALE dopo un riavvio")
    do {
        let cart = nuovaCartella()
        let (primo, _) = nuovoRegistro(TrasportoFinto(), cartella: cart)
        primo.registraInviato(job: j, utente: u, byte: 1500, ms: 8200, tentativi: 1, rinnovi: 0, esito: .put, inBackground: true)
        primo.registraInviato(job: j, utente: u, byte: 1500, ms: 0, tentativi: 0, rinnovi: 1, esito: .giaArrivato, inBackground: false)
        primo.registraAttesaRete(job: j, utente: u, notifica: true, autorizzata: false)
        primo.registraAttesaRete(job: j, utente: u, notifica: false, autorizzata: true)
        primo.registraRitento(job: j, utente: u, codice: .rete, statoHTTP: 0, tentativo: 1, attesaSecondi: 30, byteInviati: 0)
        primo.registraRinnovo(job: j, utente: u, esito: .daCaricare, statoHTTP: 200, rinnovi: 1, errorCode: .storage(.invalidJWT))
        primo.registraMotore(motore: .urlsession, occasione: .avvio, inCoda: 0, inInvio: 1, taskVivi: 1)
        let scritti = primo.stato().eventi
        let (secondo, _) = nuovoRegistro(TrasportoFinto(), cartella: cart)
        verificaUguali("un'altra istanza rilegge TUTTI gli eventi identici, campo per campo", secondo.stato().eventi, scritti)
        let riletti = secondo.stato().eventi
        verificaUguali("… `in_background` resta un BOOLEANO (vero e falso)", [riletti[0].campi["in_background"], riletti[1].campi["in_background"]], [.booleano(true), .booleano(false)])
        verificaUguali("… `notifica` e `autorizzata` restano booleani", [riletti[2].campi["notifica"], riletti[2].campi["autorizzata"], riletti[3].campi["notifica"], riletti[3].campi["autorizzata"]],
                       [.booleano(true), .booleano(false), .booleano(false), .booleano(true)])
        verificaUguali("… e i numeri 0 e 1 restano NUMERI, non diventano falso e vero", [riletti[1].campi["ms"], riletti[1].campi["tentativi"], riletti[1].campi["rinnovi"], riletti[4].campi["byte_inviati"], riletti[4].campi["tentativo"]],
                       [.numero(0), .numero(0), .numero(1), .numero(0), .numero(1)])
        verificaUguali("… e i testi restano testi", [riletti[0].campi["esito"], riletti[5].campi["error_code"]], [.testo("put"), .testo("InvalidJWT")])
        verificaUguali("… nessuna perdita dichiarata", secondo.stato().scartati, 0)
    }

    sezione("il giornale su disco: un file che c'è ma NON SI LEGGE non è rotto: non si sovrascrive, e si rilegge dopo")
    if getuid() != 0 {
        do {
            let cart = nuovaCartella()
            let trasporto = TrasportoFinto()
            let (primo, _) = nuovoRegistro(trasporto, cartella: cart)
            primo.registraAccodato(job: uuid(1), utente: u, byte: 1, mime: .mp4, motore: .urlsession)
            primo.registraAccodato(job: uuid(2), utente: u, byte: 2, mime: .mp4, motore: .urlsession)
            _ = primo.impostaDestinazione(destinazioneProduzione)
            let vecchi = primo.stato().eventi
            let file = cart.appendingPathComponent("registro.json")
            let dimensione = (try! FileManager.default.attributesOfItem(atPath: file.path))[.size] as? Int
            try! FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: file.path)
            let (secondo, _) = nuovoRegistro(trasporto, cartella: cart)
            verificaUguali("file illeggibile all'avvio: nessuna perdita dichiarata (non sappiamo niente, e non è una perdita)", secondo.stato().scartati, 0)
            verificaUguali("… e il giornale in memoria è vuoto", secondo.stato().eventi.count, 0)
            secondo.registraCodaCorrotta(fileOrfani: 4)
            secondo.registraNotificaNonAutorizzata()
            verificaUguali("… due eventi nati dopo stanno in memoria", secondo.stato().eventi.count, 2)
            verifica("… e il file NON è stato sovrascritto: è ancora illeggibile e pesa uguale (una scrittura riuscita lo avrebbe sostituito con un file leggibile)",
                     (try? Data(contentsOf: file)) == nil && ((try? FileManager.default.attributesOfItem(atPath: file.path))?[.size] as? Int) == dimensione)
            verificaUguali("… riprovaLettura finché non si legge: ancora no", secondo.riprovaLettura(), false)
            try! FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file.path)
            verificaUguali("tornati i permessi: riprovaLettura riesce", secondo.riprovaLettura(), true)
            let fusi = secondo.stato().eventi
            verificaUguali("… gli eventi di prima ci sono tutti, davanti, e quelli nuovi dietro (4 in tutto)", fusi.map { $0.messaggio },
                           vecchi.map { $0.messaggio } + ["coda-nativa-corrotta", "notifica-locale-non-autorizzata"])
            verificaUguali("… i progressivi sono tutti diversi e crescenti", fusi.map { $0.progressivo }, Array(1...4))
            verificaUguali("… nessuna perdita dichiarata", secondo.stato().scartati, 0)
            verificaUguali("… la destinazione di prima si è ritrovata", secondo.stato().destinazione?.host, "app.kidville.it")
            let (terzo, _) = nuovoRegistro(trasporto, cartella: cart)
            verificaUguali("… e il file ora contiene tutto: un'altra istanza rilegge i 4 eventi", terzo.stato().eventi.map { $0.messaggio }, fusi.map { $0.messaggio })
            // `svuota` rilegge da sé, e i log escono anche col giornale non scrivibile
            let cartB = nuovaCartella()
            let (b1, _) = nuovoRegistro(TrasportoFinto(), cartella: cartB)
            b1.registraCodaCorrotta(fileOrfani: 9)
            let fileB = cartB.appendingPathComponent("registro.json")
            try! FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: fileB.path)
            let trasportoB = TrasportoFinto()
            let (b2, _) = nuovoRegistro(trasportoB, cartella: cartB)
            _ = b2.impostaDestinazione(destinazioneProduzione)
            b2.registraNotificaNonAutorizzata()
            verificaUguali("file illeggibile: i log nuovi escono lo stesso (spedirli non dipende dal disco)", b2.svuota(), .spedito(eventi: 1))
            try! FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: fileB.path)
            orologioProva = orologioProva.addingTimeInterval(11)
            _ = b2.svuota()
            verificaUguali("… e ai permessi tornati lo svuotamento rilegge da solo: l'evento di prima parte", trasportoB.eventi(trasportoB.richieste.count - 1).first?["messaggio"] as? String, "coda-nativa-corrotta")

            // La fusione tiene il conto dei persi di prima, e rispetta il tetto di 200 eventi
            let cartC = nuovaCartella()
            let (c1, _) = nuovoRegistro(TrasportoFinto(), cartella: cartC)
            for n in 1...203 { c1.registraAccodato(job: uuid(n), utente: u, byte: Int64(n), mime: .mp4, motore: .urlsession) }
            verificaUguali("(setup) il giornale su disco ha 200 eventi e 3 persi", [c1.stato().eventi.count, c1.stato().scartati], [200, 3])
            let fileC = cartC.appendingPathComponent("registro.json")
            try! FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: fileC.path)
            let (c2, _) = nuovoRegistro(TrasportoFinto(), cartella: cartC)
            for n in 1...5 { c2.registraAccodato(job: uuid(500 + n), utente: u, byte: Int64(500 + n), mime: .mp4, motore: .urlsession) }
            try! FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: fileC.path)
            verificaUguali("tornati i permessi: la fusione riesce", c2.riprovaLettura(), true)
            let fusiC = c2.stato()
            verificaUguali("la fusione rispetta il tetto: 200 eventi (205 meno 5 scartati dalla fusione)", fusiC.eventi.count, 200)
            verificaUguali("… i persi sono quelli di prima (3) più quelli della fusione (5): 8", fusiC.scartati, 8)
            verificaUguali("… il più vecchio rimasto è il sesto del giornale su disco, il più recente l'ultimo nato in memoria", [fusiC.eventi.first?.campi["byte"], fusiC.eventi.last?.campi["byte"]], [.numero(9), .numero(505)])
            verificaUguali("… e i progressivi sono tutti diversi", Set(fusiC.eventi.map { $0.progressivo }).count, 200)
        }
    } else {
        print("  (prova saltata: eseguita come root, i permessi non bloccano la lettura)")
    }

    sezione("la destinazione di PRODUZIONE fin dall'avvio (Release); in Debug no; mai al posto di una già nota")
    do {
        let cart = nuovaCartella()
        let (rr, _) = nuovoRegistro(TrasportoFinto(), ambiente: .release, cartella: cart)
        verificaUguali("Release: nessuna destinazione all'inizio", rr.stato().destinazione, nil)
        verificaUguali("impostaDestinazionePredefinita in Release la imposta", rr.impostaDestinazionePredefinita(), true)
        verificaUguali("… ed è quella di produzione", rr.stato().destinazione?.absoluteString, "https://app.kidville.it/api/logs")
        verificaUguali("… la costante scritta", KVRegistroNativo.destinazioneProduzione, "https://app.kidville.it/api/logs")
        let (rr2, _) = nuovoRegistro(TrasportoFinto(), ambiente: .release, cartella: cart)
        verificaUguali("… si ricorda dopo un riavvio", rr2.stato().destinazione?.host, "app.kidville.it")
        let (altra, _) = nuovoRegistro(TrasportoFinto(), ambiente: .release)
        _ = altra.impostaDestinazione("https://app.kidville.it/api/altrove")
        verificaUguali("con una destinazione già nota non fa niente", altra.impostaDestinazionePredefinita(), false)
        verificaUguali("… e non la sostituisce", altra.stato().destinazione?.path, "/api/altrove")
        let (dbg, _) = nuovoRegistro(TrasportoFinto(), ambiente: .debug)
        verificaUguali("in Debug non fa niente", dbg.impostaDestinazionePredefinita(), false)
        verificaUguali("… e la destinazione resta vuota (arriva con accodaVideo, dal banco di prova)", dbg.stato().destinazione, nil)
        // il giornale di un'installazione nuova: un log nato prima di ogni accodaVideo parte lo stesso
        let trasporto = TrasportoFinto()
        let (nuova, _) = nuovoRegistro(trasporto, ambiente: .release)
        nuova.registraCodaCorrotta(fileOrfani: 2)
        _ = nuova.impostaDestinazionePredefinita()
        verificaUguali("un log nato prima del primo accodaVideo parte verso produzione", nuova.svuota(), .spedito(eventi: 1))
        verificaUguali("… all'indirizzo di produzione", trasporto.richieste.first?.url.absoluteString, "https://app.kidville.it/api/logs")
    }

    sezione("il trasporto VERO: POST con x-user-id e corpo JSON, senza cookie né altre credenziali (su un protocollo finto)")
    do {
        let configurazione = URLSessionConfiguration.ephemeral
        configurazione.protocolClasses = [ProtocolloFinto.self]
        let trasporto = KVTrasportoRegistroRete(configurazione: configurazione)
        func invia(_ richiesta: KVRichiestaRegistro) -> KVRispostaRegistro? {
            let semaforo = DispatchSemaphore(value: 0)
            var risposta: KVRispostaRegistro? = nil
            trasporto.invia(richiesta) { r in
                risposta = r
                semaforo.signal()
            }
            return semaforo.wait(timeout: .now() + 10) == .success ? risposta : nil
        }
        let corpo = Data("{\"eventi\":[],\"piattaforma\":\"ios\"}".utf8)
        let url = URL(string: "https://app.kidville.it/api/logs")!
        ProtocolloFinto.risposta = (200, [:])
        verificaUguali("200 → stato 200", invia(KVRichiestaRegistro(url: url, utenteId: uuid(10), corpo: corpo)), .stato(200, retryAfter: nil))
        let r0 = ProtocolloFinto.richieste.last
        verificaUguali("metodo POST", r0?.httpMethod, "POST")
        verificaUguali("indirizzo", r0?.url, url)
        verificaUguali("x-user-id minuscolo", r0?.value(forHTTPHeaderField: "x-user-id"), "abcdef12-3456-4abc-9def-000000000010")
        verificaUguali("content-type JSON", r0?.value(forHTTPHeaderField: "content-type"), "application/json")
        verificaUguali("il corpo arriva intero", ProtocolloFinto.corpi.last, corpo)
        let intestazioni = Set((r0?.allHTTPHeaderFields ?? [:]).keys.map { $0.lowercased() })
        verifica("nessun cookie, nessuna credenziale, nessuna chiave: solo x-user-id e content-type (più quelle di sistema)",
                 !intestazioni.contains("cookie") && !intestazioni.contains("authorization") && !intestazioni.contains("apikey")
                 && !intestazioni.contains("x-kidville-rinnovo") && !intestazioni.contains("x-upsert"), "\(intestazioni.sorted())")
        _ = invia(KVRichiestaRegistro(url: url, utenteId: nil, corpo: corpo))
        verifica("senza utente non c'è x-user-id", ProtocolloFinto.richieste.last?.value(forHTTPHeaderField: "x-user-id") == nil)
        ProtocolloFinto.risposta = (429, ["Retry-After": "45"])
        verificaUguali("429 con Retry-After → stato e intestazione", invia(KVRichiestaRegistro(url: url, utenteId: uuid(10), corpo: corpo)), .stato(429, retryAfter: "45"))
        ProtocolloFinto.risposta = (400, [:])
        verificaUguali("400 → stato 400", invia(KVRichiestaRegistro(url: url, utenteId: uuid(10), corpo: corpo)), .stato(400, retryAfter: nil))
        ProtocolloFinto.risposta = (503, [:])
        verificaUguali("503 → stato 503", invia(KVRichiestaRegistro(url: url, utenteId: uuid(10), corpo: corpo)), .stato(503, retryAfter: nil))
        ProtocolloFinto.risposta = nil
        verificaUguali("rete caduta → nessuna risposta", invia(KVRichiestaRegistro(url: url, utenteId: uuid(10), corpo: corpo)), .nessunaRisposta)
        ProtocolloFinto.risposta = (200, [:])
        // Dal registro al trasporto vero, passando per tutto
        let (rr, _) = nuovoRegistro(trasporto)
        _ = rr.impostaDestinazione(destinazioneProduzione)
        rr.registraCodaCorrotta(fileOrfani: 2)
        let semaforo = DispatchSemaphore(value: 0)
        let vistiPrima = ProtocolloFinto.richieste.count
        _ = rr.svuota(completamento: { semaforo.signal() })
        verificaUguali("registro → trasporto vero: il completamento scatta", semaforo.wait(timeout: .now() + 10) == .success, true)
        verificaUguali("… una richiesta in più", ProtocolloFinto.richieste.count, vistiPrima + 1)
        let inviato = (try? JSONSerialization.jsonObject(with: ProtocolloFinto.corpi.last ?? Data()) as? [String: Any]) ?? [:]
        verificaUguali("… col corpo del registro", (inviato["eventi"] as? [[String: Any]])?.first?["messaggio"] as? String, "coda-nativa-corrotta")
        verificaUguali("… e il giornale è stato svuotato dalla risposta 200", rr.stato().eventi.count, 0)
    }
}

// MARK: - 11. Controlli sui sorgenti di produzione

/// Le firme delle funzioni nella regione «API di log»: (nome, testo dei parametri).
func firmeDellaRegione(_ regione: String) -> [(nome: String, parametri: String)] {
    var firme: [(String, String)] = []
    var cursore = regione.startIndex
    while let trovato = regione.range(of: "func ", range: cursore..<regione.endIndex) {
        let dopoFunc = regione[trovato.upperBound...]
        guard let apri = dopoFunc.firstIndex(of: "(") else { break }
        let nome = String(dopoFunc[..<apri])
        var profondita = 0
        var fine = apri
        var i = apri
        while i < dopoFunc.endIndex {
            if dopoFunc[i] == "(" { profondita += 1 }
            if dopoFunc[i] == ")" {
                profondita -= 1
                if profondita == 0 { fine = i; break }
            }
            i = dopoFunc.index(after: i)
        }
        firme.append((nome, String(dopoFunc[dopoFunc.index(after: apri)..<fine])))
        cursore = fine
    }
    return firme
}

/// Il sorgente senza i commenti `//` e `///` (che i controlli sulle dipendenze non devono leggere: un commento che spiega ciò che NON c'è nomina proprio
/// quelle cose). Un `//` dentro una stringa (`"https://"`) resta.
func senzaCommenti(_ sorgente: String) -> String {
    var risultato = ""
    for riga in sorgente.split(separator: "\n", omittingEmptySubsequences: false) {
        var tenuta = ""
        var dentroStringa = false
        var scappato = false
        var i = riga.startIndex
        while i < riga.endIndex {
            let c = riga[i]
            let successivo = riga.index(after: i)
            if dentroStringa {
                tenuta.append(c)
                if scappato { scappato = false }
                else if c == "\\" { scappato = true }
                else if c == "\"" { dentroStringa = false }
            } else if c == "\"" {
                dentroStringa = true
                tenuta.append(c)
            } else if c == "/" && successivo < riga.endIndex && riga[successivo] == "/" {
                break
            } else {
                tenuta.append(c)
            }
            i = successivo
        }
        risultato += tenuta + "\n"
    }
    return risultato
}

let nomiSorgentiI1 = ["KVPoliticaCaricamento.swift", "KVCodaCaricamenti.swift", "KVRegistroNativo.swift"]
let nomiSorgentiI2 = ["KVSegretiCaricamenti.swift", "KVRinnovoFirma.swift", "KVNotificaAttesa.swift", "KVMotoreCaricamenti.swift"]

/// Il testo di ogni chiamata che comincia con `prefisso` (per esempio `registro.registra`): dal prefisso alla parentesi che chiude, senza farsi
/// ingannare dalle parentesi dentro una stringa. Serve a guardare DENTRO le chiamate di log.
func chiamate(_ prefisso: String, in sorgente: String) -> [String] {
    var trovate: [String] = []
    var cursore = sorgente.startIndex
    while let inizio = sorgente.range(of: prefisso, range: cursore..<sorgente.endIndex) {
        guard let apri = sorgente[inizio.upperBound...].firstIndex(of: "(") else { break }
        var profondita = 0
        var dentroStringa = false
        var scappato = false
        var fine = apri
        var i = apri
        while i < sorgente.endIndex {
            let c = sorgente[i]
            if dentroStringa {
                if scappato { scappato = false } else if c == "\\" { scappato = true } else if c == "\"" { dentroStringa = false }
            } else if c == "\"" {
                dentroStringa = true
            } else if c == "(" {
                profondita += 1
            } else if c == ")" {
                profondita -= 1
                if profondita == 0 { fine = i; break }
            }
            i = sorgente.index(after: i)
        }
        trovate.append(String(sorgente[inizio.lowerBound...fine]))
        cursore = inizio.upperBound
    }
    return trovate
}

/// Il corpo (da `{` a `}` bilanciate) della prima funzione la cui firma contiene `firma`.
func corpoDi(_ sorgente: String, firma: String) -> String? {
    guard let inizio = sorgente.range(of: firma), let apri = sorgente[inizio.upperBound...].firstIndex(of: "{") else { return nil }
    var profondita = 0
    var i = apri
    while i < sorgente.endIndex {
        if sorgente[i] == "{" { profondita += 1 }
        if sorgente[i] == "}" {
            profondita -= 1
            if profondita == 0 { return String(sorgente[apri...i]) }
        }
        i = sorgente.index(after: i)
    }
    return nil
}

func provaSorgenti() {
    sezione("i sorgenti di produzione: il tipo garantisce la privacy, e le dipendenze sono quelle dichiarate")
    var testo: [String: String] = [:]
    for nome in nomiSorgentiI1 + nomiSorgentiI2 {
        guard let contenuto = leggiTesto(cartellaProduzione + "/" + nome) else {
            verifica("\(nome) leggibile", false)
            return
        }
        testo[nome] = contenuto
    }
    func importi(_ s: String) -> [String] {
        return s.split(separator: "\n").map { String($0) }.filter { $0.hasPrefix("import ") }
    }
    let importAttesi: [(String, [String])] = [
        ("KVPoliticaCaricamento.swift", ["import Foundation"]),
        ("KVCodaCaricamenti.swift", ["import Foundation", "import os"]),
        ("KVRegistroNativo.swift", ["import Foundation", "import os"]),
        ("KVSegretiCaricamenti.swift", ["import Foundation", "import os", "import Security"]),
        ("KVRinnovoFirma.swift", ["import Foundation"]),
        ("KVNotificaAttesa.swift", ["import Foundation", "import UserNotifications"]),
        ("KVMotoreCaricamenti.swift", ["import Foundation", "import Network", "import os", "import UIKit"]),
    ]
    for (nome, atteso) in importAttesi {
        verificaUguali("\(nome) importa solo \(atteso.map { String($0.dropFirst(7)) }.joined(separator: ", "))", importi(testo[nome]!), atteso)
    }
    for nome in ["KVPoliticaCaricamento.swift", "KVCodaCaricamenti.swift", "KVRegistroNativo.swift", "KVRinnovoFirma.swift"] {
        verifica("\(nome) non importa né Capacitor né WebKit", !testo[nome]!.contains("import Capacitor") && !testo[nome]!.contains("import WebKit"))
    }
    verifica("UIKit entra in UN file solo (il motore, per il lavoro in background): né la politica, né la coda, né il registro, né i segreti, né il rinnovo, né la notifica lo vedono",
             nomiSorgentiI1.filter { testo[$0]!.contains("import UIKit") }.isEmpty && testo["KVSegretiCaricamenti.swift"]!.contains("import UIKit") == false
             && testo["KVRinnovoFirma.swift"]!.contains("import UIKit") == false && testo["KVNotificaAttesa.swift"]!.contains("import UIKit") == false)

    // La politica è PURA, come dice la sua testata: niente disco, niente rete, niente orologio, niente thread, niente preferenze, niente log di sistema.
    let impuri = ["FileManager", "URLSession", "URLRequest", "Date()", "Date.init", "Date(timeIntervalSinceNow", "DispatchQueue", "Thread", "OperationQueue",
                  "UserDefaults", "Bundle", "ProcessInfo", "Logger", "OSLog", "NotificationCenter", "Keychain", "SecItem"]
    let codicePolitica = senzaCommenti(testo["KVPoliticaCaricamento.swift"]!)
    verifica("(il controllo di purezza legge il codice, non i commenti: la testata nomina URLSession per dire che non c'è)", !codicePolitica.contains("Che cosa NON c'è"))
    for forma in impuri {
        verifica("KVPoliticaCaricamento.swift è pura: il codice non nomina «\(forma)»", !codicePolitica.contains(forma))
    }

    // Le forme vietate: lo stesso elenco del lock di J4 («dentro una chiamata di log nativa»), qui applicato a TUTTO il file nei tre sorgenti di I1.
    let vietate = ["absoluteString", "localizedDescription", "lastPathComponent", "suggestedName", "x-upsert", "apikey", "authorization",
                   "NSLog(", "print(", "debugPrint(", "dump(", "console."]
    for nome in nomiSorgentiI1 {
        let basso = testo[nome]!.lowercased()
        for forma in vietate {
            verifica("\(nome) non contiene «\(forma)»", !basso.contains(forma.lowercased()))
        }
    }
    // Nei quattro di I2 lo stesso elenco vale per tutto il CODICE (i commenti spiegano proprio ciò che non si fa, e lo nominano), tranne `authorization` — che in
    // `KVNotificaAttesa` è il nome del sistema (`authorizationStatus`, `UNAuthorizationStatus`) e non l'intestazione. Lì si toglie ciò che il sistema chiama così e
    // si guarda che non resti altro.
    for nome in nomiSorgentiI2 {
        var corpo = senzaCommenti(testo[nome]!)
        if nome == "KVNotificaAttesa.swift" {
            corpo = corpo.replacingOccurrences(of: "UNAuthorizationStatus", with: "").replacingOccurrences(of: "authorizationStatus", with: "")
        }
        let basso = corpo.lowercased()
        for forma in vietate {
            verifica("\(nome) non contiene «\(forma)»", !basso.contains(forma.lowercased()))
        }
    }
    for nome in nomiSorgentiI1 + nomiSorgentiI2 {
        let contenuto = testo[nome]!
        verifica("\(nome) non usa `try!`, né `fatalError`, né `precondition` (il logger non rompe l'app)",
                 !contenuto.contains("try!") && !contenuto.contains("fatalError") && !contenuto.contains("precondition"))
    }

    // La protezione dei file: MAI `complete` (a schermo bloccato il demone non leggerebbe il file, proprio lo scenario che ci interessa) e
    // MAI una scrittura non atomica (un file a metà è una coda corrotta).
    for nome in ["KVCodaCaricamenti.swift", "KVRegistroNativo.swift"] {
        let contenuto = testo[nome]!
        verifica("\(nome): scrive con la protezione completeUntilFirstUserAuthentication", contenuto.contains(".completeFileProtectionUntilFirstUserAuthentication"))
        for forma in ["\\.completeFileProtection(?!UntilFirstUserAuthentication)", "\\.completeFileProtectionUnlessOpen", "\\.noFileProtection",
                      "FileProtectionType\\.complete(?!UntilFirstUserAuthentication)", "FileProtectionType\\.none"] {
            verifica("\(nome): nessuna protezione diversa da completeUntilFirstUserAuthentication (\(forma))", contenuto.range(of: forma, options: .regularExpression) == nil)
        }
        if nome == "KVCodaCaricamenti.swift" {
            verifica("\(nome): protegge cartelle e copie con completeUntilFirstUserAuthentication (`setAttributes`)",
                     contenuto.contains("[.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]"))
            verifica("\(nome): esclude cartelle e copie dal backup", contenuto.contains("valori.isExcludedFromBackup = true"))
        }
        let scritture = contenuto.components(separatedBy: ".write(to:").count - 1
        let sicure = contenuto.components(separatedBy: "options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]").count - 1
        verificaUguali("\(nome): ogni scrittura (\(scritture)) è atomica e protetta", sicure, scritture)
        verifica("\(nome): ha almeno una scrittura su disco", scritture >= 1)
    }
    for nome in ["KVSegretiCaricamenti.swift", "KVRinnovoFirma.swift", "KVNotificaAttesa.swift", "KVMotoreCaricamenti.swift"] {
        verifica("\(nome): non scrive file di suo (la coda e il registro sono gli unici a scrivere sul disco)", !testo[nome]!.contains(".write(to:") && !testo[nome]!.contains("createFile("))
    }

    // La regione dell'API di log
    let registro = testo["KVRegistroNativo.swift"]!
    guard let inizio = registro.range(of: "// MARK: - API di log"),
          let fine = registro.range(of: "// MARK: - Fine API di log"),
          inizio.upperBound < fine.lowerBound else {
        verifica("la regione «API di log» è delimitata nel sorgente", false)
        return
    }
    let regione = String(registro[inizio.upperBound..<fine.lowerBound])
    let firme = firmeDellaRegione(regione)
    verificaUguali("la regione contiene le tredici funzioni di log, né una di più né una di meno",
                   firme.map { $0.nome }.sorted(),
                   ["registraAccodato", "registraAnnullato", "registraAttesaRete", "registraCodaCorrotta", "registraFallito", "registraInviato", "registraMotore",
                    "registraNotificaNonAutorizzata", "registraPreparazioneFallita", "registraPutOltreScadenza", "registraRinnovo", "registraRipresoDopoChiusura",
                    "registraRitento"])
    let tipiVietati = ["String", "Substring", "Any", "NSString", "CustomStringConvertible", "URL", "Data", "[String"]
    for firma in firme {
        let colpevoli = tipiVietati.filter { tipo in
            firma.parametri.range(of: ":\\s*\\(?\\[?\(NSRegularExpression.escapedPattern(for: tipo))", options: .regularExpression) != nil
        }
        verifica("\(firma.nome): nessun parametro di tipo stringa, URL, dati o Any (solo enumerati, numeri, booleani, UUID)", colpevoli.isEmpty,
                 "parametri: \(firma.parametri.replacingOccurrences(of: "\n", with: " ")) → \(colpevoli)")
    }
    verifica("ogni funzione della regione prende un UUID per il job (tranne quelle senza voce) e mai un nome",
             firme.filter { $0.parametri.contains("job: UUID") }.count == 9, "\(firme.filter { $0.parametri.contains("job: UUID") }.map { $0.nome })")

    // I nomi: tutti i caratteri minuscoli, nessun maiuscolo che farebbe fallire la porta
    verifica("ogni slug di messaggio è minuscolo con trattini",
             KVMessaggioLog.allCases.allSatisfy { $0.rawValue.range(of: "^[a-z][a-z0-9-]*$", options: .regularExpression) != nil })

    // ───────────────────────── I2: dentro le chiamate di log, e nel log di sistema ─────────────────────────
    sezione("I2 — dentro una chiamata di log non entra mai un nome, un percorso, un URL, un token, un hash")
    let nelLog = ["absoluteString", "relativeString", "localizedDescription", "suggestedName", "lastPathComponent", "\\.nome\\b", "\\.file\\b", "\\.path\\b", "urlPut", "urlRinnovo",
                  "urlRegistro", "\\.token\\b", "sha256", "contentType", "x-upsert", "apikey", "authorization", "x-kidville-rinnovo", "x-user-id"]
    var chiamateDiLog = 0
    var funzioniChiamate = Set<String>()
    for nome in ["KVMotoreCaricamenti.swift", "KVCodaCaricamenti.swift"] {
        let tutte = chiamate("registro.registra", in: testo[nome]!) + chiamate("registro?.registra", in: testo[nome]!)
        chiamateDiLog += tutte.count
        for chiamata in tutte {
            let colpevoli = nelLog.filter { chiamata.range(of: $0, options: [.regularExpression, .caseInsensitive]) != nil }
            verifica("\(nome): \(chiamata.prefix(44).replacingOccurrences(of: "\n", with: " "))… non porta \(nelLog.count) forme vietate", colpevoli.isEmpty, "contiene \(colpevoli)")
            if let fine = chiamata.firstIndex(of: "("), let inizio = chiamata.range(of: "registra") {
                funzioniChiamate.insert(String(chiamata[inizio.lowerBound..<fine]))
            }
        }
    }
    verifica("(il controllo guarda davvero qualcosa: \(chiamateDiLog) chiamate di log nel motore e nella coda)", chiamateDiLog >= 14)
    verificaUguali("il motore e la coda scrivono TUTTI i messaggi di log tranne quello del selettore (I3): nessun messaggio resta solo sulla carta",
                   Set(firme.map { $0.nome }).subtracting(funzioniChiamate), Set(["registraPreparazioneFallita"]))
    // Il log di SISTEMA (`os.Logger`): ogni valore interpolato è un numero o un nome di una lista chiusa, e ha `privacy: .public` solo per quelli.
    let ammessiNelLogDiSistema: Set<String> = ["cosa", "e.dominio.rawValue", "e.codice", "Int(stato)"]
    var interpolazioni: Set<String> = []
    for nome in nomiSorgentiI1 + nomiSorgentiI2 {
        for riga in testo[nome]!.split(separator: "\n") where riga.contains("diagnostica.") {
            var resto = Substring(riga)
            while let apre = resto.range(of: "\\(") {
                guard let chiude = resto.range(of: ", privacy: .public)", range: apre.upperBound..<resto.endIndex) else { break }
                interpolazioni.insert(String(resto[apre.upperBound..<chiude.lowerBound]))
                resto = resto[chiude.upperBound...]
            }
        }
    }
    verificaUguali("il log di sistema interpola solo codici numerici, nomi d'errore e dominio (nessun URL, percorso, token, descrizione)", interpolazioni.subtracting(ammessiNelLogDiSistema), [])
    verifica("(e ne interpola davvero: \(interpolazioni.sorted()))", !interpolazioni.isEmpty)
    verifica("nessun `Logger` interpola un valore senza dichiarare `privacy: .public` solo se è una costante enumerata",
             !testo["KVMotoreCaricamenti.swift"]!.contains("privacy: .private"))

    sezione("I2 — la PUT manda SOLO il content-type; il rinnovo SOLO x-kidville-rinnovo; nessuna credenziale e nessun upsert")
    let motore = testo["KVMotoreCaricamenti.swift"]!
    let rinnovoSorgente = testo["KVRinnovoFirma.swift"]!
    verificaUguali("nel motore c'è UNA sola `setValue` (la PUT: il content-type)", motore.components(separatedBy: ".setValue(").count - 1, 1)
    verifica("… ed è il content-type del server, sull'intestazione `content-type`", motore.contains("setValue(richiesta.contentType, forHTTPHeaderField: \"content-type\")"))
    verifica("nel motore nessun `addValue`, `allHTTPHeaderFields`, `httpAdditionalHeaders`",
             !motore.contains(".addValue(") && !motore.contains("allHTTPHeaderFields") && !motore.contains("httpAdditionalHeaders"))
    verificaUguali("nel rinnovo c'è UNA sola `setValue` (l'intestazione col token)", rinnovoSorgente.components(separatedBy: ".setValue(").count - 1, 1)
    verifica("… ed è `x-kidville-rinnovo`", rinnovoSorgente.contains("setValue(token, forHTTPHeaderField: intestazioneToken)") && rinnovoSorgente.contains("\"x-kidville-rinnovo\""))
    verifica("l'intestazione del token sta in UN solo sorgente (il rinnovo): nel CODICE degli altri sei non compare",
             (nomiSorgentiI1 + ["KVMotoreCaricamenti.swift", "KVSegretiCaricamenti.swift", "KVNotificaAttesa.swift"]).allSatisfy { !senzaCommenti(testo[$0]!).contains("x-kidville-rinnovo") })
    verifica("la PUT è `uploadTask(with:fromFile:)`, metodo PUT, con `taskDescription`, i byte attesi e i 4 KB di risposta",
             motore.contains("uploadTask(with: chiamata, fromFile: richiesta.file)") && motore.contains("httpMethod = \"PUT\"") && motore.contains("task.taskDescription =")
             && motore.contains("task.countOfBytesClientExpectsToSend = richiesta.byte + 1024") && motore.contains("task.countOfBytesClientExpectsToReceive = Int64(KVPoliticaCaricamento.byteCorpoMassimo)"))
    verifica("la sessione: identificativo fisso, sessionSendsLaunchEvents, isDiscretionary = false, tre reti a true",
             motore.contains("URLSessionConfiguration.background(withIdentifier: identificativo)") && motore.contains("sessionSendsLaunchEvents = true") && motore.contains("isDiscretionary = false")
             && motore.contains("allowsCellularAccess = true") && motore.contains("allowsExpensiveNetworkAccess = true") && motore.contains("allowsConstrainedNetworkAccess = true"))
    verifica("l'identificativo della sessione è it.kidville.app.caricamenti", motore.contains("static let identificativoSessione = \"it.kidville.app.caricamenti\""))
    verifica("i reindirizzamenti non si seguono né nella PUT né nel rinnovo", motore.contains("willPerformHTTPRedirection") && motore.contains("completionHandler(nil)")
             && rinnovoSorgente.contains("willPerformHTTPRedirection") && rinnovoSorgente.contains("completionHandler(nil)"))

    sezione("I2 — i segreti stanno nel Portachiavi, AfterFirstUnlockThisDeviceOnly, mai nella coda né nel registro")
    let segretiSorgente = testo["KVSegretiCaricamenti.swift"]!
    verifica("accessibilità kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly", segretiSorgente.contains("kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly"))
    verifica("nessun'altra accessibilità (né WhenUnlocked, né Always, né AfterFirstUnlock senza ThisDeviceOnly)",
             segretiSorgente.range(of: "kSecAttrAccessible(WhenUnlocked|Always|AfterFirstUnlock(?!ThisDeviceOnly)|WhenPasscodeSet)", options: .regularExpression) == nil)
    verifica("non sincronizzabile con iCloud (kSecAttrSynchronizable = false) e servizio it.kidville.app.caricamenti",
             segretiSorgente.contains("kSecAttrSynchronizable as String: false") && segretiSorgente.contains("static let servizio = \"it.kidville.app.caricamenti\""))
    verifica("la coda e il registro non nominano né il Portachiavi né i segreti (`SecItem`, `KVSegretiVoce`, `x-kidville-rinnovo`)",
             nomiSorgentiI1.filter { $0 != "KVPoliticaCaricamento.swift" }.allSatisfy { !testo[$0]!.contains("SecItem") && !testo[$0]!.contains("KVSegretiVoce") && !testo[$0]!.contains("kvr_") })
    verifica("la coda non ha campi per il token né per l'URL firmato (`struct KVVoceCoda` senza token/url della PUT)",
             !(corpoDi(testo["KVCodaCaricamenti.swift"]!, firma: "struct KVVoceCoda") ?? "").lowercased().contains("token:") && !(corpoDi(testo["KVCodaCaricamenti.swift"]!, firma: "struct KVVoceCoda") ?? "").contains("urlPut"))

    sezione("I2 — l'AppDelegate aggancia il motore ai quattro punti, e Firebase e le due push restano")
    if let appDelegate = leggiTesto(cartellaProduzione + "/AppDelegate.swift") {
        let lancio = corpoDi(appDelegate, firma: "func application(_ application: UIApplication, didFinishLaunchingWithOptions") ?? ""
        verifica("didFinishLaunching: KVMotoreCaricamenti.condiviso.avvia() (dopo Firebase, prima di `return true`)",
                 lancio.contains("KVMotoreCaricamenti.condiviso.avvia()") && lancio.contains("FirebaseApp.configure()")
                 && (lancio.range(of: "FirebaseApp.configure()")?.lowerBound ?? lancio.endIndex) < (lancio.range(of: "KVMotoreCaricamenti.condiviso.avvia()")?.lowerBound ?? lancio.startIndex)
                 && (lancio.range(of: "KVMotoreCaricamenti.condiviso.avvia()")?.lowerBound ?? lancio.endIndex) < (lancio.range(of: "return true")?.lowerBound ?? lancio.startIndex))
        verifica("applicationDidBecomeActive → riprendiInPrimoPiano()", (corpoDi(appDelegate, firma: "func applicationDidBecomeActive(") ?? "").contains("KVMotoreCaricamenti.condiviso.riprendiInPrimoPiano()"))
        verifica("applicationDidEnterBackground → notificaSeFermo()", (corpoDi(appDelegate, firma: "func applicationDidEnterBackground(") ?? "").contains("KVMotoreCaricamenti.condiviso.notificaSeFermo()"))
        verifica("application(_:handleEventsForBackgroundURLSession:completionHandler:) → ricollega(identifier, completionHandler)",
                 (corpoDi(appDelegate, firma: "func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void)") ?? "")
                    .contains("KVMotoreCaricamenti.condiviso.ricollega(identifier, completionHandler)"))
        // Il CORPO di ciascun hook, non la presenza del nome in un punto qualunque del file: `.capacitorDidFailToRegisterForRemoteNotifications` compare anche
        // dentro il ramo FCM, e un hook svuotato lascerebbe quel nome al suo posto con il token che non arriva più a `/api/push/subscribe`.
        let registrata = corpoDi(appDelegate, firma: "func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data)") ?? ""
        let fallita = corpoDi(appDelegate, firma: "func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error)") ?? ""
        verifica("le due push restano COL LORO CORPO: il token FCM (o APNs) e la registrazione fallita arrivano a Capacitor",
                 registrata.contains("Messaging.messaging().apnsToken = deviceToken")
                 && registrata.contains("NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: token)")
                 && registrata.contains("NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)")
                 && fallita.contains("NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)"))
        verifica("l'apertura da URL e da Universal Link passano ancora da `ApplicationDelegateProxy` (le richiede Capacitor)",
                 (corpoDi(appDelegate, firma: "func application(_ app: UIApplication, open url: URL") ?? "").contains("ApplicationDelegateProxy.shared.application(app, open: url, options: options)")
                 && (corpoDi(appDelegate, firma: "func application(_ application: UIApplication, continue userActivity: NSUserActivity") ?? "")
                    .contains("ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)"))
        let codiceAppDelegate = senzaCommenti(appDelegate).replacingOccurrences(of: "handleEventsForBackgroundURLSession", with: "")
        verifica("l'AppDelegate non nomina la sessione, i segreti, la coda: parla solo col motore",
                 !codiceAppDelegate.contains("URLSession") && !codiceAppDelegate.contains("KVPortachiavi") && !codiceAppDelegate.contains("KVCodaCaricamenti") && !codiceAppDelegate.contains("SecItem"))
    } else {
        verifica("AppDelegate.swift leggibile", false)
    }

    sezione("I2 — ogni file Swift dell'app è «in Sources» nel pbxproj, con ID della serie KV28…010 e seguenti")
    if let pbx = leggiTesto(cartellaProduzione + "/../App.xcodeproj/project.pbxproj"),
       let sorgentiFase = pbx.components(separatedBy: "/* Begin PBXSourcesBuildPhase section */").dropFirst().first?.components(separatedBy: "/* End PBXSourcesBuildPhase section */").first {
        let swiftNellaCartella = ((try? FileManager.default.contentsOfDirectory(atPath: cartellaProduzione)) ?? []).filter { $0.hasSuffix(".swift") }.sorted()
        verifica("(si guardano davvero dei file: \(swiftNellaCartella.count) .swift in ios/App/App)", swiftNellaCartella.count >= 10)
        for nome in swiftNellaCartella {
            verifica("\(nome) è in Sources", sorgentiFase.contains("\(nome) in Sources"))
        }
        for nome in nomiSorgentiI1 + nomiSorgentiI2 {
            let righeBuild = pbx.split(separator: "\n").filter { $0.contains("\(nome) in Sources */ = {isa = PBXBuildFile;") }
            verificaUguali("\(nome): una riga PBXBuildFile sola", righeBuild.count, 1)
            let rigaBuild = String(righeBuild.first ?? "")
            let idBuild = rigaBuild.range(of: "KV28B0F[0-9A-F]{13}", options: .regularExpression).map { String(rigaBuild[$0]) } ?? ""
            let numero = Int(idBuild.suffix(2), radix: 16) ?? 0
            verifica("\(nome): ID di costruzione \(idBuild) nella serie nuova (≥ ...010)", numero >= 0x10, "id: \(idBuild)")
            verificaUguali("\(nome): una riga PBXFileReference sola", pbx.split(separator: "\n").filter { $0.contains("/* \(nome) */ = {isa = PBXFileReference;") }.count, 1)
            verificaUguali("\(nome): sta nel gruppo App (una riga di elenco)", pbx.split(separator: "\n").filter { $0.hasPrefix("\t\t\t\tKV28F0F") && $0.contains("/* \(nome) */,") }.count, 1)
        }
        let tuttiGliId = pbx.split(separator: "\n").compactMap { riga -> String? in
            guard riga.hasPrefix("\t\tKV28"), let fine = riga.firstIndex(of: " ") else { return nil }
            return String(riga[riga.index(riga.startIndex, offsetBy: 2)..<fine])
        }
        verificaUguali("nessun ID del pbxproj è definito due volte (\(tuttiGliId.count) definizioni KV28…)", Set(tuttiGliId).count, tuttiGliId.count)
        verifica("capacitor.config.json resta com'era nel pbxproj (una sola riga di file, una fra le risorse)", pbx.components(separatedBy: "capacitor.config.json in Resources").count == 3)
    } else {
        verifica("project.pbxproj leggibile", false)
    }
}

// MARK: - Esecuzione

provaModo()
provaParita()
provaStati()
provaPut()
provaAttese()
provaRinnovo()
provaContentType()
provaSoglia()
provaHost()
provaPonte()
provaCoda()
provaRegistro()
provaComponenti()
provaMotore()
provaSorgenti()
chiudiSezione()
try? FileManager.default.removeItem(at: radiceProva)

print("")
if fallimenti.isEmpty {
    print("TUTTE VERDI (\(modo)): \(superate) verifiche")
    exit(0)
} else {
    print("ROSSE (\(modo)): \(fallimenti.count) su \(superate + fallimenti.count)")
    for f in fallimenti { print("  - \(f)") }
    exit(1)
}
