// Le prove dei componenti che il motore usa (compito I2): il Portachiavi, il rinnovo, la notifica, il trasporto della PUT.
//
// Ciascuno si prova con ciò che un binario Catalyst non firmato può fare:
//   · il Portachiavi, con le quattro chiamate di sistema iniettate (`SicurezzaFinta`: si comporta come il vero dove conta e registra le query);
//     il Portachiavi VERO si prova nel simulatore;
//   · il rinnovo e il trasporto della PUT, sui loro oggetti VERI ma con una sessione che passa da un protocollo finto (`ProtocolloFinto`): una
//     sessione in background non ammette protocolli propri, e fuori da un'app non gira;
//   · la notifica, con un centro finto.
//
// Il giudizio su ciò che il motore FA con questi pezzi sta in `prove-motore.swift`.

import Foundation
import Security
import UserNotifications

/// Raccoglie ciò che il trasporto vero consegna al motore. Le consegne arrivano dalla coda del delegato di una sessione, la prova legge dal thread
/// principale: ogni lettura passa dalla stessa serratura (un `Array` letto mentre un altro thread lo allunga è un crash).
final class DelegatoTrasportoRaccolto: KVTrasportoPutDelegato {
    private let serratura = NSLock()
    private var avanzamentiInterni: [(job: UUID, task: Int, byte: Int64)] = []
    private var terminatiInterni: [(job: UUID, task: Int, risposta: KVRispostaPut, byte: Int64)] = []
    private var eventiConsegnatiInterni = 0
    private var invalidazioniInterne = 0
    private let semaforo = DispatchSemaphore(value: 0)

    var avanzamenti: [(job: UUID, task: Int, byte: Int64)] { serratura.lock(); defer { serratura.unlock() }; return avanzamentiInterni }
    var terminati: [(job: UUID, task: Int, risposta: KVRispostaPut, byte: Int64)] { serratura.lock(); defer { serratura.unlock() }; return terminatiInterni }
    var eventiConsegnati: Int { serratura.lock(); defer { serratura.unlock() }; return eventiConsegnatiInterni }
    var invalidazioni: Int { serratura.lock(); defer { serratura.unlock() }; return invalidazioniInterne }

    func trasporto(avanzamentoDi job: UUID, task: Int, byteInviati: Int64) {
        serratura.lock(); avanzamentiInterni.append((job, task, byteInviati)); serratura.unlock()
    }

    func trasporto(terminatoPer job: UUID, task: Int, risposta: KVRispostaPut, byteInviati: Int64) {
        serratura.lock(); terminatiInterni.append((job, task, risposta, byteInviati)); serratura.unlock()
        semaforo.signal()
    }

    func trasportoHaConsegnatoTuttiGliEventi() {
        serratura.lock(); eventiConsegnatiInterni += 1; serratura.unlock()
    }

    func trasportoInvalidato() {
        serratura.lock(); invalidazioniInterne += 1; serratura.unlock()
    }

    /// Aspetta il prossimo task terminato.
    func attendiTerminato(secondi: TimeInterval = 10) -> Bool {
        return semaforo.wait(timeout: .now() + secondi) == .success
    }
}

/// Un task con i contatori e lo stato scelti dalla prova. I byte «spediti» di un task veri li conta la rete: un protocollo finto non li conta mai
/// (restano a zero), e senza di essi non si proverebbe che cosa il trasporto ne ricava. `URLSessionTask.init()` è deprecato — un task lo crea
/// una sessione —, ma è l'unico modo di avere un `URLSessionTask` a cui dire quanti byte ha spedito: lo si chiama dal tipo base (`NSObject`),
/// così il compilatore non ha niente da dire su un inizializzatore che qui è voluto.
final class TaskFinto: URLSessionUploadTask, @unchecked Sendable {
    var inviati: Int64 = 0
    var attesi: Int64 = 0
    var identificativoFinto = 0
    var descrizioneFinta: String?
    var rispostaFinta: URLResponse?
    var statoFinto: URLSessionTask.State = .running
    override var countOfBytesSent: Int64 { inviati }
    override var countOfBytesExpectedToSend: Int64 { attesi }
    override var taskIdentifier: Int { identificativoFinto }
    override var taskDescription: String? { get { descrizioneFinta } set { descrizioneFinta = newValue } }
    override var response: URLResponse? { rispostaFinta }
    override var state: URLSessionTask.State { statoFinto }
}

func nuovoTaskFinto(job: UUID?, identificativo: Int, inviati: Int64 = 0, attesi: Int64 = 0, stato: URLSessionTask.State = .running,
                    statoHTTP: Int? = nil) -> TaskFinto {
    let task = (TaskFinto.self as NSObject.Type).init() as! TaskFinto
    task.identificativoFinto = identificativo
    task.descrizioneFinta = job.map { $0.uuidString.lowercased() }
    task.inviati = inviati
    task.attesi = attesi
    task.statoFinto = stato
    if let codice = statoHTTP {
        task.rispostaFinta = HTTPURLResponse(url: URL(string: urlPutProva(1))!, statusCode: codice, httpVersion: nil, headerFields: nil)
    }
    return task
}

func provaComponenti() {
    provaPortachiavi()
    provaRinnovoFirma()
    provaNotificaAttesa()
    provaTrasportoPut()
    provaTrasportoSuiContatoriDelTask()
}

// MARK: - Il Portachiavi

private func segretiDiProva(_ n: Int = 1, token: String = tokenA, firma: String = "a") -> KVSegretiVoce {
    return KVSegretiVoce(token: token, urlPut: urlPutProva(n, firma), contentType: "video/quicktime", urlRinnovo: urlRinnovoProva)
}

func provaPortachiavi() {
    sezione("Portachiavi — gli attributi giusti: AfterFirstUnlockThisDeviceOnly, non sincronizzabile, un elemento per job")
    do {
        let sicurezza = SicurezzaFinta()
        let pc = KVPortachiavi(sicurezza: sicurezza.operazioni)
        verificaUguali("un job senza segreti: assenti", pc.leggi(uuid(1)), .assenti)
        verifica("salva un job: riesce (nil = nessun errore)", pc.salva(segretiDiProva(1), per: uuid(1)) == nil)
        verificaUguali("… un solo elemento nel Portachiavi", sicurezza.numero, 1)
        guard let aggiunta = sicurezza.queryAggiunte.first else { verifica("c'è una query di aggiunta", false); return }
        verificaUguali("classe: password generica", aggiunta[kSecClass as String] as? String, kSecClassGenericPassword as String)
        verificaUguali("servizio: it.kidville.app.caricamenti", aggiunta[kSecAttrService as String] as? String, "it.kidville.app.caricamenti")
        verificaUguali("account: il jobId in minuscolo", aggiunta[kSecAttrAccount as String] as? String, uuid(1).uuidString.lowercased())
        verificaUguali("accessibilità: AfterFirstUnlockThisDeviceOnly (leggibile a telefono bloccato dopo il primo sblocco, mai in un backup)",
                       aggiunta[kSecAttrAccessible as String] as? String, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        verificaUguali("non sincronizzabile con iCloud", aggiunta[kSecAttrSynchronizable as String] as? Bool, false)
        let dati = aggiunta[kSecValueData as String] as? Data ?? Data()
        let json = (try? JSONSerialization.jsonObject(with: dati) as? [String: Any]) ?? [:]
        verificaUguali("il contenuto è JSON con i quattro segreti e nient'altro", Set(json.keys), Set(["token", "urlPut", "contentType", "urlRinnovo"]))
        verificaUguali("… il token", json["token"] as? String, tokenA)
        verificaUguali("… l'URL della PUT", json["urlPut"] as? String, urlPutProva(1))
        verificaUguali("leggi: ritrova quello che ha salvato", pc.leggi(uuid(1)), .presenti(segretiDiProva(1)))
        let lettura = sicurezza.queryLettura.last ?? [:]
        verifica("la lettura chiede i dati di UN elemento", (lettura[kSecReturnData as String] as? Bool) == true && lettura[kSecMatchLimit as String] as? String == kSecMatchLimitOne as String)
        verificaTutto("… sullo stesso servizio e account", [lettura[kSecAttrService as String] as? String, lettura[kSecAttrAccount as String] as? String],
                       ["it.kidville.app.caricamenti", uuid(1).uuidString.lowercased()])

        sezione("Portachiavi — la rotazione: salvare di nuovo sostituisce (un elemento solo), e riapplica l'accessibilità")
        let ruotati = segretiDiProva(1, token: tokenB, firma: "b")
        verifica("salva col token ruotato: riesce", pc.salva(ruotati, per: uuid(1)) == nil)
        verificaUguali("… ancora UN solo elemento", sicurezza.numero, 1)
        verificaUguali("… leggi dà il nuovo token e il nuovo URL", pc.leggi(uuid(1)), .presenti(ruotati))
        verificaUguali("… la sostituzione è passata da SecItemUpdate (la prima SecItemAdd ha dato duplicato)", sicurezza.queryAggiornamenti.count, 1)
        verificaUguali("… e l'aggiornamento riapplica l'accessibilità giusta",
                       sicurezza.queryAggiornamenti.first?[kSecAttrAccessible as String] as? String, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        verifica("… due query di aggiunta (la prima, e il tentativo che ha dato duplicato)", sicurezza.queryAggiunte.count == 2)

        sezione("Portachiavi — elimina, elenco, e un Portachiavi che non risponde")
        _ = pc.salva(segretiDiProva(2), per: uuid(2))
        verificaUguali("tuttiIJob: i due job", pc.tuttiIJob(), Set([uuid(1), uuid(2)]))
        let senzaAccount = sicurezza.queryLettura.last ?? [:]
        verifica("… l'elenco chiede gli attributi di TUTTI gli elementi del servizio (nessun account, nessun dato)",
                 senzaAccount[kSecAttrAccount as String] == nil && (senzaAccount[kSecReturnAttributes as String] as? Bool) == true && senzaAccount[kSecMatchLimit as String] as? String == kSecMatchLimitAll as String
                 && senzaAccount[kSecReturnData as String] == nil)
        sicurezza.semina(servizio: "it.kidville.app.caricamenti", account: "non-un-uuid", dati: Data("x".utf8))
        sicurezza.semina(servizio: "altro.servizio", account: uuid(9).uuidString.lowercased(), dati: Data("x".utf8))
        verificaUguali("… un account che non è un uuid, o di un altro servizio, non entra nell'elenco (la pulizia non lo cancellerebbe)", pc.tuttiIJob(), Set([uuid(1), uuid(2)]))
        verifica("elimina un job: riesce", pc.elimina(uuid(1)) == nil)
        verificaUguali("… e non c'è più", pc.leggi(uuid(1)), .assenti)
        verifica("elimina un job che non c'è: è come cancellato (nil)", pc.elimina(uuid(1)) == nil)
        verificaUguali("… l'altro c'è ancora", pc.leggi(uuid(2)), .presenti(segretiDiProva(2)))
        let vuoto = KVPortachiavi(sicurezza: SicurezzaFinta().operazioni)
        verificaUguali("tuttiIJob con il Portachiavi vuoto: insieme vuoto, non nil", vuoto.tuttiIJob(), Set<UUID>())

        sicurezza.statoForzato = -25308 // errSecInteractionNotAllowed: telefono riavviato e non ancora sbloccato
        if case .nonDisponibili(let errore) = pc.leggi(uuid(2)) {
            verificaUguali("Portachiavi che non risponde (-25308): leggi NON è «assenti» ma «non disponibili», col codice", errore, KVErroreSistema(dominio: .altro, codice: -25308))
        } else { verifica("-25308: nonDisponibili", false) }
        verificaUguali("… salva dà l'errore, non lo nasconde", pc.salva(segretiDiProva(3), per: uuid(3)), KVErroreSistema(dominio: .altro, codice: -25308))
        verificaUguali("… elimina dà l'errore", pc.elimina(uuid(2)), KVErroreSistema(dominio: .altro, codice: -25308))
        verificaUguali("… tuttiIJob dà nil (e la pulizia non toglie niente)", pc.tuttiIJob(), nil)
        sicurezza.statoForzato = nil

        sezione("Portachiavi — segreti che non hanno senso non si salvano, e un contenuto illeggibile vale «assenti»")
        let prima = sicurezza.numero
        let cattivi: [(String, KVSegretiVoce)] = [
            ("token vuoto", KVSegretiVoce(token: "", urlPut: urlPutProva(4), contentType: "video/mp4", urlRinnovo: urlRinnovoProva)),
            ("token con un a capo (finirebbe in un'intestazione)", KVSegretiVoce(token: "kvr_a\r\nx-upsert: true", urlPut: urlPutProva(4), contentType: "video/mp4", urlRinnovo: urlRinnovoProva)),
            ("URL della PUT vuoto", KVSegretiVoce(token: tokenA, urlPut: "", contentType: "video/mp4", urlRinnovo: urlRinnovoProva)),
            ("content-type che non è un MIME", KVSegretiVoce(token: tokenA, urlPut: urlPutProva(4), contentType: "boh", urlRinnovo: urlRinnovoProva)),
            ("content-type con uno spazio in coda", KVSegretiVoce(token: tokenA, urlPut: urlPutProva(4), contentType: "video/mp4 ", urlRinnovo: urlRinnovoProva)),
            ("token enorme", KVSegretiVoce(token: String(repeating: "k", count: 513), urlPut: urlPutProva(4), contentType: "video/mp4", urlRinnovo: urlRinnovoProva)),
        ]
        for (nome, segreti) in cattivi {
            verifica("\(nome): non si salva", pc.salva(segreti, per: uuid(4)) != nil)
        }
        verificaUguali("… e nel Portachiavi non è entrato niente", sicurezza.numero, prima)
        sicurezza.semina(servizio: "it.kidville.app.caricamenti", account: uuid(5).uuidString.lowercased(), dati: Data("non è JSON".utf8))
        verificaUguali("un elemento il cui contenuto non è JSON: assenti (si tratta come se non ci fosse)", pc.leggi(uuid(5)), .assenti)
        sicurezza.semina(servizio: "it.kidville.app.caricamenti", account: uuid(6).uuidString.lowercased(),
                         dati: try! JSONEncoder().encode(KVSegretiVoce(token: "", urlPut: "x", contentType: "y", urlRinnovo: "z")))
        verificaUguali("… e un contenuto JSON ma senza senso: assenti", pc.leggi(uuid(6)), .assenti)
    }
}

// MARK: - Il rinnovo

func provaRinnovoFirma() {
    sezione("Rinnovo (vero, su un protocollo finto) — POST con x-kidville-rinnovo, corpo vuoto, nessuna credenziale")
    ProtocolloFinto.ripristina()
    defer { ProtocolloFinto.ripristina() }
    let lavoro = LavoroFinto()
    let configurazione = URLSessionConfiguration.ephemeral
    configurazione.protocolClasses = [ProtocolloFinto.self]
    let cliente = KVRinnovoFirma(lavoro: lavoro, configurazione: configurazione)
    func chiama(_ token: String = tokenA) -> KVEsitoRinnovoRete? {
        let semaforo = DispatchSemaphore(value: 0)
        var esito: KVEsitoRinnovoRete? = nil
        cliente.rinnova(url: URL(string: urlRinnovoProva)!, token: token) { r in
            esito = r
            semaforo.signal()
        }
        return semaforo.wait(timeout: .now() + 10) == .success ? esito : nil
    }
    ProtocolloFinto.corpo = Data("{\"stato\":\"arrivato\"}".utf8)
    let risposto = chiama()
    verificaUguali("200 → stato HTTP 200", risposto?.statoHTTP, 200)
    verificaUguali("… e il corpo com'è arrivato", risposto.flatMap { String(data: $0.corpo, encoding: .utf8) }, "{\"stato\":\"arrivato\"}")
    let richiesta = ProtocolloFinto.richieste.last
    verificaUguali("metodo POST", richiesta?.httpMethod, "POST")
    verificaUguali("all'indirizzo del rinnovo", richiesta?.url?.absoluteString, urlRinnovoProva)
    verificaUguali("l'intestazione x-kidville-rinnovo porta il token", richiesta?.value(forHTTPHeaderField: "x-kidville-rinnovo"), tokenA)
    let nomi = Set((richiesta?.allHTTPHeaderFields ?? [:]).keys.map { $0.lowercased() })
    verifica("nessun cookie, nessuna credenziale, nessun upsert, nessuna chiave", !nomi.contains("cookie") && !nomi.contains("authorization") && !nomi.contains("apikey") && !nomi.contains("x-upsert"), "\(nomi.sorted())")
    verifica("il corpo è vuoto", (ProtocolloFinto.corpi.last ?? Data()).isEmpty)
    verificaUguali("il token NON è nell'indirizzo", richiesta?.url?.query, nil)
    verifica("il lavoro in background è stato aperto e chiuso (la richiesta non viene sospesa a metà)", lavoro.iniziati == 1 && lavoro.terminati == [1])

    ProtocolloFinto.risposta = (429, ["Retry-After": "120"])
    ProtocolloFinto.corpo = Data()
    let limitato = chiama(tokenB)
    verificaTutto("429 con Retry-After → stato e intestazione riportati", [limitato?.statoHTTP.map { String($0) }, limitato?.retryAfter], ["429", "120"])
    verificaUguali("… col token dell'altra chiamata (non uno in cache)", ProtocolloFinto.richieste.last?.value(forHTTPHeaderField: "x-kidville-rinnovo"), tokenB)
    ProtocolloFinto.risposta = (404, [:])
    verificaUguali("404 → stato 404", chiama()?.statoHTTP, 404)
    ProtocolloFinto.risposta = nil
    let senzaRete = chiama()
    verificaTutto("rete caduta → nessuna risposta (statoHTTP nil), e la chiamata finisce lo stesso", [senzaRete != nil, senzaRete?.statoHTTP == nil], [true, true])
    ProtocolloFinto.risposta = (200, [:])
    ProtocolloFinto.corpo = Data(repeating: 65, count: 100_000)
    verificaUguali("un corpo di 100 KB si tiene a 64 KiB", chiama()?.corpo.count, 65536)
    verificaTutto("il lavoro in background si chiude a ogni chiamata", [lavoro.iniziati, lavoro.terminati.count], [5, 5])

    sezione("Rinnovo — la sessione: ephemeral, senza cookie né cache né credenziali, 30 secondi; i reindirizzamenti NON si seguono")
    let c = KVRinnovoFirma.configurazione()
    verifica("senza cookie (httpShouldSetCookies = false, accettazione `never`, nessun archivio)", !c.httpShouldSetCookies && c.httpCookieAcceptPolicy == .never && c.httpCookieStorage == nil)
    verifica("senza cache e senza credenziali condivise", c.urlCache == nil && c.urlCredentialStorage == nil && c.requestCachePolicy == .reloadIgnoringLocalCacheData)
    verifica("30 secondi di richiesta e di totale, senza attesa di connettività", c.timeoutIntervalForRequest == 30 && c.timeoutIntervalForResource == 30 && !c.waitsForConnectivity)
    let richiestaPura = KVRinnovoFirma.richiesta(url: URL(string: urlRinnovoProva)!, token: tokenA)
    verificaUguali("la richiesta: POST", richiestaPura.httpMethod, "POST")
    verificaUguali("… l'UNICA intestazione nostra è x-kidville-rinnovo", Set((richiestaPura.allHTTPHeaderFields ?? [:]).keys), Set(["x-kidville-rinnovo"]))
    verificaUguali("… tempo massimo 30 s", richiestaPura.timeoutInterval, 30)
    verifica("… e corpo vuoto", (richiestaPura.httpBody ?? Data()).isEmpty)
    let sessioneProva = URLSession(configuration: .ephemeral)
    let compito = sessioneProva.dataTask(with: URL(string: urlRinnovoProva)!)
    var rispostoRedirect: URLRequest? = URLRequest(url: URL(string: "https://evil.example.com/")!)
    var chiamato = false
    cliente.urlSession(sessioneProva, task: compito, willPerformHTTPRedirection: HTTPURLResponse(url: URL(string: urlRinnovoProva)!, statusCode: 307, httpVersion: nil, headerFields: ["Location": "https://evil.example.com/"])!,
                       newRequest: URLRequest(url: URL(string: "https://evil.example.com/")!)) { nuova in
        rispostoRedirect = nuova
        chiamato = true
    }
    verificaTutto("un reindirizzamento 307 verso un altro host NON si segue (il token non lo accompagna)", [chiamato, rispostoRedirect == nil], [true, true])
    sessioneProva.invalidateAndCancel()
}

// MARK: - La notifica

func provaNotificaAttesa() {
    sezione("Notifica d'attesa — una sola, identificativo fisso, testi del JS, nessuna autorizzazione chiesta")
    verificaUguali("l'identificativo fisso", KVNotificaAttesa.identificativo, "kidville-caricamento-attesa")
    let stati: [(UNAuthorizationStatus, Bool)] = [(.authorized, true), (.provisional, true), (.ephemeral, true), (.denied, false), (.notDetermined, false)]
    for (stato, atteso) in stati {
        verificaUguali("autorizzata(\(stato.rawValue)) = \(atteso) (`notDetermined` NON basta: non si chiede)", KVNotificaAttesa.autorizzata(stato), atteso)
    }
    let centro = CentroNotificheFinto()
    let notifica = KVNotificaAttesa(centro: centro)
    var esito: KVEsitoNotificaAttesa? = nil
    notifica.mostraAttesa(titolo: "Kidville", corpo: "Il video è in attesa di rete: riprenderà da solo") { esito = $0 }
    verificaUguali("autorizzata e accettata: (autorizzata, programmata)", esito, KVEsitoNotificaAttesa(autorizzata: true, programmata: true))
    verificaUguali("… UNA notifica aggiunta", centro.aggiunte.count, 1)
    verificaUguali("… con l'identificativo fisso", centro.aggiunte.first?.identificativo, "kidville-caricamento-attesa")
    verificaTutto("… titolo e corpo sono quelli passati dal JS, tali e quali", [centro.aggiunte.first?.titolo, centro.aggiunte.first?.corpo],
                   ["Kidville", "Il video è in attesa di rete: riprenderà da solo"])
    notifica.mostraAttesa(titolo: "Kidville", corpo: "In attesa") { _ in }
    verificaUguali("una seconda richiesta usa lo stesso identificativo (il sistema sostituisce)", Set(centro.aggiunte.map { $0.identificativo }), ["kidville-caricamento-attesa"])
    centro.stato = .denied
    notifica.mostraAttesa(titolo: "Kidville", corpo: "x") { esito = $0 }
    verificaUguali("non autorizzata: niente programmato, e lo dice", esito, KVEsitoNotificaAttesa(autorizzata: false, programmata: false))
    verificaUguali("… e non si è aggiunto niente", centro.aggiunte.count, 2)
    centro.stato = .notDetermined
    notifica.mostraAttesa(titolo: "Kidville", corpo: "x") { esito = $0 }
    verificaTutto("autorizzazione non ancora decisa: non si chiede, non si programma", [esito?.autorizzata, esito?.programmata, centro.aggiunte.count == 2 ? true : false], [false, false, true])
    centro.stato = .provisional
    centro.accetta = false
    notifica.mostraAttesa(titolo: "Kidville", corpo: "x") { esito = $0 }
    verificaUguali("autorizzata ma il sistema rifiuta la richiesta: (true, false)", esito, KVEsitoNotificaAttesa(autorizzata: true, programmata: false))
    notifica.rimuoviAttesa()
    verificaUguali("rimuoviAttesa toglie quella con l'identificativo fisso (consegnata o in arrivo)", centro.rimosse, ["kidville-caricamento-attesa"])
    let sorgente = leggiTesto(cartellaProduzione + "/KVNotificaAttesa.swift") ?? ""
    verifica("il sorgente non chiede mai l'autorizzazione (`requestAuthorization`) e non imposta il delegato del centro",
             !sorgente.contains("requestAuthorization") && !sorgente.contains(".delegate =") && !senzaCommenti(sorgente).contains("userInfo") && !senzaCommenti(sorgente).contains("UNNotificationSound"))
}

// MARK: - Il trasporto della PUT

func provaTrasportoPut() {
    sezione("Trasporto della PUT (vero, su un protocollo finto) — PUT da file, solo il content-type, jobId nella descrizione")
    ProtocolloFinto.ripristina()
    defer { ProtocolloFinto.ripristina() }
    let configurazione = URLSessionConfiguration.ephemeral
    configurazione.protocolClasses = [ProtocolloFinto.self]
    let trasporto = KVTrasportoPutURLSession(configurazione: configurazione)
    let delegato = DelegatoTrasportoRaccolto()
    trasporto.delegato = delegato
    let cartella = nuovaCartella()
    let file = cartella.appendingPathComponent("video.mov")
    scrivi(file, byte: 5000)
    func richiesta(_ job: Int = 1, contentType: String = "video/quicktime", nonPrima: Date? = nil) -> KVRichiestaPut {
        return KVRichiestaPut(job: uuid(job), url: URL(string: urlPutProva(job))!, contentType: contentType, file: file, byte: 5000, nonPrima: nonPrima)
    }

    ProtocolloFinto.risposta = (200, [:])
    ProtocolloFinto.corpo = Data()
    let id1 = trasporto.avvia(richiesta())
    verifica("avvia restituisce l'identificativo del task", id1 != nil)
    verifica("il task finisce", delegato.attendiTerminato())
    let fatto = delegato.terminati.last
    verificaUguali("il delegato riceve il job giusto (dalla `taskDescription`)", fatto?.job, uuid(1))
    verificaUguali("… e l'identificativo del task", fatto?.task, id1)
    verificaUguali("… stato HTTP 200", fatto?.risposta.statoHTTP, 200)
    verificaUguali("… nessun errore di sistema", fatto?.risposta.errore, nil)
    let put = ProtocolloFinto.richieste.last
    verificaUguali("metodo PUT", put?.httpMethod, "PUT")
    verificaUguali("sull'URL firmato", put?.url?.absoluteString, urlPutProva(1))
    verificaUguali("il content-type è quello del server", put?.value(forHTTPHeaderField: "content-type"), "video/quicktime")
    let nomi = Set((put?.allHTTPHeaderFields ?? [:]).keys.map { $0.lowercased() })
    let vietati: Set<String> = ["authorization", "apikey", "x-upsert", "cookie", "cache-control", "x-kidville-rinnovo", "expect", "x-user-id"]
    verificaUguali("nessuna intestazione vietata (autenticazione, apikey, upsert, cache-control, cookie, token)", nomi.intersection(vietati), [])
    verificaUguali("il corpo che arriva è il file, intero", ProtocolloFinto.corpi.last?.count, 5000)
    verificaUguali("… e coi suoi byte", ProtocolloFinto.corpi.last, Data(repeating: 7, count: 5000))
    let dichiarato = ProtocolloFinto.proprietaDelTask.last
    verificaTutto("il task dichiara al sistema: il job nella descrizione, nessun inizio più presto (parte subito), 5.000 + 1.024 byte da spedire e 4.096 da ricevere",
                  [dichiarato?.descrizione, dichiarato?.nonPrima, dichiarato?.attesiInvio, dichiarato?.attesiRicezione], [uuid(1).uuidString.lowercased(), nil, Int64(5000 + 1024), Int64(4096)])
    // Un task differito (l'attesa dopo un transitorio vive nel sistema, non in un timer): l'inizio più presto arriva al sistema. Una data già passata,
    // così la sessione di prova (che non è in background) non lo fa aspettare davvero.
    let giaPassato = t0.addingTimeInterval(-3600)
    _ = trasporto.avvia(richiesta(8, nonPrima: giaPassato))
    verifica("il task differito finisce", delegato.attendiTerminato())
    verificaUguali("un task con un'attesa porta al sistema il suo `earliestBeginDate`", ProtocolloFinto.proprietaDelTask.last?.nonPrima, giaPassato)

    sezione("Trasporto — il corpo di un rifiuto (≤ 4 KB), Retry-After, errore di sistema, `taskVivi` e annullamento")
    ProtocolloFinto.risposta = (400, ["Retry-After": "30"])
    ProtocolloFinto.corpo = corpoStorage(statusCode: "409", errore: "Duplicate")
    _ = trasporto.avvia(richiesta(2))
    verifica("il task finisce", delegato.attendiTerminato())
    let rifiutato = delegato.terminati.last
    verificaTutto("un rifiuto: stato 400, e SENZA errore di sistema (una PUT rifiutata non porta `error`)", [rifiutato?.risposta.statoHTTP, rifiutato?.risposta.errore == nil ? 1 : 0], [400, 1])
    verificaUguali("… il corpo arriva (il motore ne ricava statusCode ed error)", KVPoliticaCaricamento.leggiCorpoStorage(rifiutato?.risposta.corpo ?? Data()), KVCorpoStorage(statusCode: 409, errore: .duplicate))
    verificaUguali("… e Retry-After", rifiutato?.risposta.retryAfter, "30")
    ProtocolloFinto.risposta = (500, [:])
    ProtocolloFinto.corpo = Data(repeating: 66, count: 10_000)
    _ = trasporto.avvia(richiesta(3))
    verifica("il task finisce", delegato.attendiTerminato())
    verificaUguali("un corpo di 10 KB si tiene a 4 KB", delegato.terminati.last?.risposta.corpo.count, KVPoliticaCaricamento.byteCorpoMassimo)
    ProtocolloFinto.risposta = nil
    _ = trasporto.avvia(richiesta(4))
    verifica("il task finisce", delegato.attendiTerminato())
    let caduto = delegato.terminati.last
    verificaTutto("rete caduta: nessuno stato HTTP e l'errore di sistema (dominio e codice, mai il testo)", [caduto?.risposta.statoHTTP == nil, caduto?.risposta.errore?.dominio == .url], [true, true])
    verificaUguali("… codice NSURLErrorNotConnectedToInternet", caduto?.risposta.errore?.codice, NSURLErrorNotConnectedToInternet)
    verificaUguali("… e nessun motivo di annullamento", caduto?.risposta.motivoAnnullamento, nil)

    // un task che non finisce: taskVivi, e annulla
    ProtocolloFinto.risposta = (200, [:])
    ProtocolloFinto.sospendi = true
    let idLento = trasporto.avvia(richiesta(5))
    let semaforo = DispatchSemaphore(value: 0)
    var vivi: [KVTaskVivo] = []
    trasporto.taskVivi { elenco in vivi = elenco; semaforo.signal() }
    _ = semaforo.wait(timeout: .now() + 10)
    verificaUguali("taskVivi: il task in volo, col suo job e il suo identificativo", vivi.map { [$0.job.uuidString, String($0.identificativo)] }, [[uuid(5).uuidString, String(idLento ?? -1)]])
    trasporto.annulla(task: idLento ?? -1)
    verifica("annulla: il task finisce, come errore di annullamento", delegato.attendiTerminato())
    let annullato = delegato.terminati.last
    verificaUguali("… NSURLErrorCancelled, dominio URL (il motore lo ignora perché il task l'ha fermato lui)", annullato?.risposta.errore, KVErroreSistema(dominio: .url, codice: NSURLErrorCancelled))
    ProtocolloFinto.sospendi = false
    let semaforo2 = DispatchSemaphore(value: 0)
    var dopoAnnullo: [KVTaskVivo] = [KVTaskVivo(job: uuid(99), identificativo: 99, byteInviati: 0)]
    trasporto.taskVivi { elenco in dopoAnnullo = elenco; semaforo2.signal() }
    _ = semaforo2.wait(timeout: .now() + 10)
    verificaUguali("dopo l'annullamento taskVivi non lo restituisce più", dopoAnnullo.count, 0)
    verificaTutto("il trasporto non ha sollevato eventi di sessione da solo", [delegato.eventiConsegnati, delegato.invalidazioni], [0, 0])

    sezione("Trasporto — i motivi dell'annullamento e i reindirizzamenti, sui callback veri del delegato")
    // `didCompleteWithError` con un errore che porta il motivo `userForceQuitApplication`: si ricostruisce da un task non avviato.
    let sessioneProva = URLSession(configuration: .ephemeral)
    let compito = sessioneProva.uploadTask(with: URLRequest(url: URL(string: urlPutProva(6))!), fromFile: file)
    compito.taskDescription = uuid(6).uuidString.lowercased()
    let errore = NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled,
                         userInfo: [NSURLErrorBackgroundTaskCancelledReasonKey: NSURLErrorCancelledReasonUserForceQuitApplication])
    trasporto.urlSession(sessioneProva, task: compito, didCompleteWithError: errore)
    let chiuso = delegato.terminati.last
    verificaUguali("annullamento di sistema con motivo userForceQuitApplication: il motivo arriva al motore", chiuso?.risposta.motivoAnnullamento, NSURLErrorCancelledReasonUserForceQuitApplication)
    verificaUguali("… per il job della descrizione", chiuso?.job, uuid(6))
    verificaUguali("… e la decisione della politica è «ricrea alla riapertura»", chiuso.map { KVPoliticaCaricamento.decidiPut($0.risposta, tentativo: 1, adesso: t0, casuale: 0.5) }, .ricreaAllaRiapertura)
    let senzaDescrizione = sessioneProva.uploadTask(with: URLRequest(url: URL(string: urlPutProva(7))!), fromFile: file)
    let prima = delegato.terminati.count
    trasporto.urlSession(sessioneProva, task: senzaDescrizione, didCompleteWithError: nil)
    verificaUguali("un task che non è nostro (senza `taskDescription`) non solleva niente", delegato.terminati.count, prima)
    var seguito: URLRequest? = URLRequest(url: URL(string: "https://evil.example.com/")!)
    var consultato = false
    trasporto.urlSession(sessioneProva, task: compito, willPerformHTTPRedirection: HTTPURLResponse(url: URL(string: urlPutProva(6))!, statusCode: 307, httpVersion: nil, headerFields: ["Location": "https://evil.example.com/"])!,
                         newRequest: URLRequest(url: URL(string: "https://evil.example.com/")!)) { nuova in
        seguito = nuova
        consultato = true
    }
    // ⚠️ Questa prova è sul METODO del delegato, chiamato a mano su una sessione ephemeral: dice che il rifiuto c'è, dove il sistema lo chiede. Nella sessione IN
    // BACKGROUND della PUT vera il sistema non lo chiede mai (segue i 3xx da solo): lì la difesa è l'host unico (`KVPoliticaCaricamento.hostPut`), provato altrove.
    verificaTutto("il delegato rifiuta un 307 verso un altro host (vale dove il sistema lo consulta; NON nella sessione in background della PUT vera, dove la difesa è l'host unico)", [consultato, seguito == nil], [true, true])
    trasporto.urlSessionDidFinishEvents(forBackgroundURLSession: sessioneProva)
    verificaUguali("urlSessionDidFinishEvents arriva al motore", delegato.eventiConsegnati, 1)
    sessioneProva.invalidateAndCancel()

    sezione("Trasporto — la configurazione della sessione in background (§5.2)")
    let c = KVTrasportoPutURLSession.configurazione()
    verificaUguali("identificativo it.kidville.app.caricamenti", c.identifier, "it.kidville.app.caricamenti")
    verificaUguali("… lo stesso che il motore dichiara", KVMotoreCaricamenti.identificativoSessione, "it.kidville.app.caricamenti")
    verifica("sessionSendsLaunchEvents (il sistema risveglia l'app a trasferimento finito)", c.sessionSendsLaunchEvents)
    verifica("isDiscretionary = false (parte subito, non quando conviene al sistema)", !c.isDiscretionary)
    verifica("cellulare, rete costosa e dati ridotti AMMESSI (decisione del titolare: «qualunque rete»)",
             c.allowsCellularAccess && c.allowsExpensiveNetworkAccess && c.allowsConstrainedNetworkAccess)
    verificaUguali("24 ore di tempo totale", c.timeoutIntervalForResource, 24 * 3600)
    verificaUguali("due connessioni per host", c.httpMaximumConnectionsPerHost, 2)
    verifica("niente cookie, niente cache", !c.httpShouldSetCookies && c.httpCookieAcceptPolicy == .never && c.httpCookieStorage == nil && c.urlCache == nil)
    verificaUguali("niente cache nelle richieste", c.requestCachePolicy, .reloadIgnoringLocalCacheData)
}

// MARK: - Il trasporto sui contatori del task

/// Ciò che il trasporto ricava dai CONTATORI di un task: se il trasferimento è arrivato in fondo (S0: lo Storage verifica la firma a fine
/// trasferimento, quindi un rifiuto a byte tutti spediti è «firma scaduta durante l'invio» e uno a metà no), quanti byte sono partiti, ogni quanto
/// si inoltra l'avanzamento, e quali task sono «vivi». Un protocollo finto non conta i byte spediti: i task sono finti (`TaskFinto`) e i callback
/// sono quelli veri del delegato.
func provaTrasportoSuiContatoriDelTask() {
    sezione("Trasporto — la risposta: trasferimento completo solo a byte tutti spediti, e i byte spediti arrivano al motore")
    let trasporto = KVTrasportoPutURLSession(configurazione: .ephemeral)
    let delegato = DelegatoTrasportoRaccolto()
    trasporto.delegato = delegato
    let sessione = URLSession(configuration: .ephemeral)
    defer { sessione.invalidateAndCancel() }

    func chiudi(_ n: Int, inviati: Int64, attesi: Int64, stato: Int?) -> (risposta: KVRispostaPut, byte: Int64, job: UUID)? {
        let prima = delegato.terminati.count
        trasporto.urlSession(sessione, task: nuovoTaskFinto(job: uuid(n), identificativo: 60 + n, inviati: inviati, attesi: attesi, statoHTTP: stato),
                             didCompleteWithError: nil)
        guard delegato.terminati.count == prima + 1, let ultimo = delegato.terminati.last else { return nil }
        return (ultimo.risposta, ultimo.byte, ultimo.job)
    }

    let completo = chiudi(1, inviati: 5000, attesi: 5000, stato: 403)
    verificaTutto("5000 byte spediti su 5000 e un 403: il trasferimento è completo, lo stato è quello, e i byte sono 5000",
                  [completo?.risposta.trasferimentoCompleto, completo?.risposta.statoHTTP, completo?.byte, completo?.job], [true, 403, Int64(5000), uuid(1)])
    let aMeta = chiudi(2, inviati: 2000, attesi: 5000, stato: 403)
    verificaTutto("2000 byte su 5000 e un 403 (il server ha risposto prima della fine): NON è completo, e i byte sono 2000",
                  [aMeta?.risposta.trasferimentoCompleto, aMeta?.byte], [false, Int64(2000)])
    let senzaPeso = chiudi(3, inviati: 0, attesi: 0, stato: 400)
    verificaTutto("un task che non sa quanti byte deve spedire (0 su 0) non è «completo»: lo zero non è un trasferimento finito",
                  [senzaPeso?.risposta.trasferimentoCompleto, senzaPeso?.byte], [false, Int64(0)])
    let oltre = chiudi(4, inviati: 5001, attesi: 5000, stato: 200)
    verificaUguali("più byte del previsto (il sistema ne conta anche di cornice): è completo", oltre?.risposta.trasferimentoCompleto, true)
    let senzaRisposta = chiudi(5, inviati: 700, attesi: 5000, stato: nil)
    verificaTutto("senza risposta HTTP (rete caduta a metà): nessuno stato, non completo, byte 700",
                  [senzaRisposta?.risposta.statoHTTP == nil, senzaRisposta?.risposta.trasferimentoCompleto, senzaRisposta?.byte], [true, false, Int64(700)])

    sezione("Trasporto — l'avanzamento si inoltra al più ogni quarto di secondo, ma l'ultimo byte passa sempre")
    var ora = t0
    trasporto.orologio = { ora }
    let task = nuovoTaskFinto(job: uuid(8), identificativo: 68, attesi: 1000)
    func spedisci(_ totale: Int64, dopo secondi: TimeInterval) {
        ora = t0.addingTimeInterval(secondi)
        trasporto.urlSession(sessione, task: task, didSendBodyData: 10, totalBytesSent: totale, totalBytesExpectedToSend: 1000)
    }
    func inoltrati() -> [Int64] { delegato.avanzamenti.filter { $0.job == uuid(8) }.map { $0.byte } }
    spedisci(10, dopo: 0)
    verificaUguali("il primo avanzamento passa subito", inoltrati(), [10])
    spedisci(20, dopo: 0.0)
    spedisci(30, dopo: 0.2)
    verificaUguali("altri due entro il quarto di secondo (a 0 e a 0,2 s) NON passano", inoltrati(), [10])
    spedisci(40, dopo: 0.25)
    verificaUguali("a 0,25 s dall'ultimo inoltrato passa", inoltrati(), [10, 40])
    spedisci(50, dopo: 0.3)
    spedisci(1000, dopo: 0.3)
    verificaUguali("a 0,05 s dall'ultimo non passa, ma l'ultimo byte (1000 su 1000) passa sempre", inoltrati(), [10, 40, 1000])
    verificaTutto("… tutti per il task giusto", delegato.avanzamenti.filter { $0.job == uuid(8) }.map { $0.task }, [68, 68, 68])
    let altrui = nuovoTaskFinto(job: nil, identificativo: 69, attesi: 1000)
    let primaDiAltrui = delegato.avanzamenti.count
    trasporto.urlSession(sessione, task: altrui, didSendBodyData: 10, totalBytesSent: 500, totalBytesExpectedToSend: 1000)
    verificaUguali("un task che non è nostro (senza `taskDescription`) non solleva avanzamenti", delegato.avanzamenti.count, primaDiAltrui)
    let altro = nuovoTaskFinto(job: uuid(9), identificativo: 70, attesi: 1000)
    ora = t0.addingTimeInterval(0.3)
    trasporto.urlSession(sessione, task: altro, didSendBodyData: 10, totalBytesSent: 5, totalBytesExpectedToSend: 1000)
    verificaUguali("il quarto di secondo si conta per TASK: un altro task, a 0,3 s dal suo nulla, passa subito", delegato.avanzamenti.filter { $0.job == uuid(9) }.map { $0.byte }, [5])

    sezione("Trasporto — i task vivi: quelli nostri (descrizione = jobId), in volo o sospesi, coi byte che hanno già spedito")
    let vivi = KVTrasportoPutURLSession.vivi(tra: [
        nuovoTaskFinto(job: uuid(1), identificativo: 11, inviati: 100, attesi: 1000, stato: .running),
        nuovoTaskFinto(job: uuid(2), identificativo: 12, inviati: 0, attesi: 1000, stato: .suspended),
        nuovoTaskFinto(job: uuid(3), identificativo: 13, inviati: 1000, attesi: 1000, stato: .completed),
        nuovoTaskFinto(job: uuid(4), identificativo: 14, inviati: 50, attesi: 1000, stato: .canceling),
        nuovoTaskFinto(job: nil, identificativo: 15, inviati: 70, attesi: 1000, stato: .running),
    ])
    verificaUguali("in volo e sospeso sì, finito e in annullamento no, senza descrizione no",
                   vivi.map { "\($0.job.uuidString.lowercased()) \($0.identificativo) \($0.byteInviati)" },
                   ["\(uuid(1).uuidString.lowercased()) 11 100", "\(uuid(2).uuidString.lowercased()) 12 0"])
    let nonUnJob = nuovoTaskFinto(job: nil, identificativo: 16, inviati: 10, attesi: 1000, stato: .running)
    nonUnJob.descrizioneFinta = "non-un-uuid"
    verificaUguali("una descrizione che non è un uuid non è nostra", KVTrasportoPutURLSession.vivi(tra: [nonUnJob]).count, 0)
}
