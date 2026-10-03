// Le finte con cui la prova pilota il MOTORE dei caricamenti nativi (compito I2).
//
// Il motore (`KVMotoreCaricamenti`) non sa niente del mondo: trasporto della PUT, cliente del rinnovo, segreti, notifica, monitor di rete,
// lavoro in background, orologio, numero casuale e pianificatore gli arrivano da fuori. Qui ci sono le versioni che la prova può PILOTARE:
// niente parte da sola, tutto si risolve a comando (`completa`, `rispondi`, `avanza`), e l'orologio (`orologioProva`, in `main.swift`) lo
// sposta la prova. Così una corsa si legge come un copione: «la PUT prende 400 InvalidJWT → il rinnovo parte → risponde da-caricare → il task
// nuovo è questo», e ogni passo si può mettere fuori ordine (un rinnovo che risponde dopo un `annulla`, un secondo `accoda` col token ruotato).
//
// Le finte NON ricopiano la logica del motore: tengono i fatti (che cosa è stato chiesto, in che ordine) e li mostrano. Le decisioni restano
// del codice di produzione, ed è quello che la prova guarda.

import Foundation
import Security
import UserNotifications

// MARK: - Dati comuni

let utenteProva = 7
let urlRinnovoProva = "https://app.kidville.it/api/video-uploads/rinnovo"
let urlRegistroProva = "https://app.kidville.it/api/logs"
let tokenA = "kvr_aaaaaaaaaaaaaaaaaaaaaaaa"
let tokenB = "kvr_bbbbbbbbbbbbbbbbbbbbbbbb"

/// Un URL firmato di PUT in forma di quelli veri, con una «firma» riconoscibile.
func urlPutProva(_ job: Int, _ firma: String = "a") -> String {
    return "https://abcdefghij.supabase.co/storage/v1/object/upload/sign/video_originals/utente/job\(job).mov?token=firma-\(firma)"
}

func iso(_ data: Date) -> String { KVPoliticaCaricamento.isoZ(data) }

/// Un messaggio di log com'è scritto dal registro: `slug: job=<uuid>` e, se c'è, ` <suffisso>`.
func messaggio(_ slug: String, job: Int, _ suffisso: String? = nil) -> String {
    return "\(slug): job=\(uuid(job).uuidString.lowercased())" + (suffisso.map { " " + $0 } ?? "")
}

// MARK: - Il trasporto della PUT

final class TrasportoPutFinto: KVTrasportoPut {
    weak var delegato: KVTrasportoPutDelegato?
    private let serratura = NSLock()
    private(set) var richieste: [KVRichiestaPut] = []
    private(set) var vivi: [Int: KVRichiestaPut] = [:]
    private(set) var annullati: [Int] = []
    private var jobPerTask: [Int: UUID] = [:]
    private var byteSpediti: [Int: Int64] = [:]
    private var ordine: [Int] = []
    private var prossimoId = 100
    /// Task che il «sistema» ha già (un processo precedente li ha creati): `getAllTasks` li restituisce.
    var extraVivi: [KVTaskVivo] = []
    var rifiutaAvvio = false
    /// Eseguito DENTRO `taskVivi`, prima di rispondere: l'harness ci consegna gli eventi in sospeso che il sistema darebbe alla creazione della sessione.
    var primaDiRispondere: (() -> Void)?
    private(set) var chiamateTaskVivi = 0
    /// Se `true` `taskVivi` non risponde mai da solo (un sistema che non risponde): il completamento resta in `risposteInSospeso` e lo si dà a mano.
    var nonRispondeATaskVivi = false
    private var risposteInSospeso: [([KVTaskVivo]) -> Void] = []

    func taskVivi(completamento: @escaping ([KVTaskVivo]) -> Void) {
        serratura.lock()
        chiamateTaskVivi += 1
        serratura.unlock()
        primaDiRispondere?()
        serratura.lock()
        let propri = vivi.keys.sorted().map { KVTaskVivo(job: vivi[$0]!.job, identificativo: $0, byteInviati: byteSpediti[$0] ?? 0) }
        let tutti = propri + extraVivi
        if nonRispondeATaskVivi {
            risposteInSospeso.append(completamento)
            serratura.unlock()
            return
        }
        serratura.unlock()
        completamento(tutti)
    }

    /// Risponde adesso alle `taskVivi` rimaste in sospeso (la risposta tardiva di un sistema lento).
    func rispondiATaskViviInSospeso() {
        serratura.lock()
        let pronte = risposteInSospeso
        risposteInSospeso = []
        let tutti = vivi.keys.sorted().map { KVTaskVivo(job: vivi[$0]!.job, identificativo: $0, byteInviati: byteSpediti[$0] ?? 0) } + extraVivi
        serratura.unlock()
        pronte.forEach { $0(tutti) }
    }

    func avvia(_ richiesta: KVRichiestaPut) -> Int? {
        serratura.lock(); defer { serratura.unlock() }
        if rifiutaAvvio { return nil }
        let id = prossimoId
        prossimoId += 1
        richieste.append(richiesta)
        ordine.append(id)
        vivi[id] = richiesta
        jobPerTask[id] = richiesta.job
        return id
    }

    func annulla(task: Int) {
        serratura.lock(); defer { serratura.unlock() }
        annullati.append(task)
        vivi.removeValue(forKey: task)
        extraVivi.removeAll { $0.identificativo == task }
    }

    // Dalla prova -----------------------------------------------------------------------------

    /// L'identificativo dell'N-esimo task creato (da 0).
    func id(_ n: Int) -> Int {
        serratura.lock(); defer { serratura.unlock() }
        return ordine[n]
    }

    /// L'identificativo dell'ultimo task creato.
    var ultimoId: Int {
        serratura.lock(); defer { serratura.unlock() }
        return ordine.last ?? -1
    }

    var numeroCreati: Int {
        serratura.lock(); defer { serratura.unlock() }
        return richieste.count
    }

    func richiesta(_ n: Int) -> KVRichiestaPut {
        serratura.lock(); defer { serratura.unlock() }
        return richieste[n]
    }

    var identificativiVivi: [Int] {
        serratura.lock(); defer { serratura.unlock() }
        return vivi.keys.sorted()
    }

    /// Il task `id` è finito. Se era già stato annullato la consegna arriva comunque (il sistema consegna `NSURLErrorCancelled`).
    func completa(_ id: Int, _ risposta: KVRispostaPut, byteInviati: Int64? = nil) {
        serratura.lock()
        let job = jobPerTask[id]
        vivi.removeValue(forKey: id)
        serratura.unlock()
        guard let lavoro = job else { return }
        delegato?.trasporto(terminatoPer: lavoro, task: id, risposta: risposta, byteInviati: byteInviati ?? 0)
    }

    /// Una consegna per un task che il trasporto non ha creato in questo processo (di una vita precedente).
    func completaDiUnaVitaPrecedente(job: UUID, task: Int, _ risposta: KVRispostaPut, byteInviati: Int64) {
        delegato?.trasporto(terminatoPer: job, task: task, risposta: risposta, byteInviati: byteInviati)
    }

    func avanzamento(_ id: Int, byte: Int64) {
        serratura.lock()
        let job = jobPerTask[id]
        byteSpediti[id] = byte
        serratura.unlock()
        guard let lavoro = job else { return }
        delegato?.trasporto(avanzamentoDi: lavoro, task: id, byteInviati: byte)
    }

    /// Da dove ripartono gli identificativi dei task creati da qui in avanti (un processo nuovo non deve ricrearne uno con l'id di un task che il sistema
    /// ha ancora dal processo di prima).
    func impostaProssimoId(_ n: Int) {
        serratura.lock(); defer { serratura.unlock() }
        prossimoId = n
    }

    /// I byte che `getAllTasks` dirà del task `id`, senza che nessun avanzamento arrivi al motore (uno snapshot più vecchio di ciò che il motore sa).
    func impostaByteSpediti(_ id: Int, _ byte: Int64) {
        serratura.lock(); defer { serratura.unlock() }
        byteSpediti[id] = byte
    }

    /// Il sistema ha perso il task `id`: `getAllTasks` non lo elenca più e nessun completamento arriverà (un task finito e già consegnato, o buttato).
    func perdi(_ id: Int) {
        serratura.lock(); defer { serratura.unlock() }
        vivi.removeValue(forKey: id)
    }

    func consegnaEventi() {
        delegato?.trasportoHaConsegnatoTuttiGliEventi()
    }
}

// MARK: - Il cliente del rinnovo

final class RinnovoFinto: KVClienteRinnovo {
    private let serratura = NSLock()
    private(set) var chiamate: [(url: URL, token: String)] = []
    private var inSospeso: [Int: (KVEsitoRinnovoRete) -> Void] = [:]

    func rinnova(url: URL, token: String, completamento: @escaping (KVEsitoRinnovoRete) -> Void) {
        serratura.lock(); defer { serratura.unlock() }
        chiamate.append((url, token))
        inSospeso[chiamate.count - 1] = completamento
    }

    var numeroChiamate: Int {
        serratura.lock(); defer { serratura.unlock() }
        return chiamate.count
    }

    var senzaRisposta: Int {
        serratura.lock(); defer { serratura.unlock() }
        return inSospeso.count
    }

    /// Gli indici (da 0) delle chiamate che aspettano ancora una risposta, e il token con cui sono state fatte.
    var inAttesaDiRisposta: [(indice: Int, token: String)] {
        serratura.lock(); defer { serratura.unlock() }
        return inSospeso.keys.sorted().map { ($0, chiamate[$0].token) }
    }

    /// Risponde alla chiamata `indice` (da 0). Se non c'è, o ha già risposto, non fa niente e restituisce `false`.
    @discardableResult
    func rispondi(_ indice: Int, _ esito: KVEsitoRinnovoRete) -> Bool {
        serratura.lock()
        let completamento = inSospeso.removeValue(forKey: indice)
        serratura.unlock()
        guard let lavoro = completamento else { return false }
        lavoro(esito)
        return true
    }

    /// Risponde all'ultima chiamata.
    @discardableResult
    func rispondiUltimo(_ esito: KVEsitoRinnovoRete) -> Bool {
        return rispondi(numeroChiamate - 1, esito)
    }
}

/// Le risposte del rinnovo di uso comune.
func rinnovoDaCaricare(url: String, contentType: String = "video/quicktime", scadeIl: Date) -> KVEsitoRinnovoRete {
    return KVEsitoRinnovoRete(statoHTTP: 200, corpo: corpoRinnovo(url: url, contentType: contentType, scadeIl: iso(scadeIl)), retryAfter: nil)
}
let rinnovoArrivato = KVEsitoRinnovoRete(statoHTTP: 200, corpo: jsonDati(["stato": "arrivato"]), retryAfter: nil)
let rinnovoAnnullato = KVEsitoRinnovoRete(statoHTTP: 200, corpo: jsonDati(["stato": "annullato"]), retryAfter: nil)
let rinnovoNonTrovato = KVEsitoRinnovoRete(statoHTTP: 404, corpo: jsonDati(["error": "VIDEO_NON_TROVATO"]), retryAfter: nil)
func rinnovoLimitato(_ retryAfter: String?) -> KVEsitoRinnovoRete { KVEsitoRinnovoRete(statoHTTP: 429, corpo: Data(), retryAfter: retryAfter) }
let rinnovoErroreServer = KVEsitoRinnovoRete(statoHTTP: 503, corpo: Data(), retryAfter: nil)
let rinnovoSenzaRete = KVEsitoRinnovoRete(statoHTTP: nil, corpo: Data(), retryAfter: nil)

// MARK: - Le risposte della PUT

func putRiuscita(durata: Int = 5) -> KVRispostaPut {
    return KVRispostaPut(statoHTTP: 200, corpo: Data(), durataSecondi: durata, trasferimentoCompleto: true)
}

/// Un rifiuto dello Storage: HTTP `stato`, col corpo `{statusCode, error}` (o vuoto se `errore` è `nil`).
func putRifiutata(_ stato: Int = 400, errore: String? = "InvalidJWT", completo: Bool = true, durata: Int = 3) -> KVRispostaPut {
    let corpo = errore.map { corpoStorage(statusCode: String(stato), errore: $0) } ?? Data()
    return KVRispostaPut(statoHTTP: stato, corpo: corpo, durataSecondi: durata, trasferimentoCompleto: completo)
}

func putTransitoria(_ stato: Int = 503, retryAfter: String? = nil) -> KVRispostaPut {
    return KVRispostaPut(statoHTTP: stato, retryAfter: retryAfter, durataSecondi: 1)
}

func putSenzaRete(_ codice: Int = -1009) -> KVRispostaPut {
    return KVRispostaPut(errore: KVErroreSistema(dominio: .url, codice: codice))
}

// MARK: - I segreti

final class DepositoSegretiInMemoria: KVDepositoSegreti {
    private let serratura = NSLock()
    private var voci: [UUID: KVSegretiVoce] = [:]
    var fallisciSalva = false
    var leggiNonDisponibile = false
    var elencoNonDisponibile = false
    private(set) var salvataggi = 0
    private(set) var cancellazioni: [UUID] = []

    func leggi(_ job: UUID) -> KVEsitoLetturaSegreti {
        serratura.lock(); defer { serratura.unlock() }
        if leggiNonDisponibile { return .nonDisponibili(KVErroreSistema(dominio: .altro, codice: -25308)) }
        return voci[job].map { .presenti($0) } ?? .assenti
    }

    func salva(_ segreti: KVSegretiVoce, per job: UUID) -> KVErroreSistema? {
        serratura.lock(); defer { serratura.unlock() }
        if fallisciSalva { return KVErroreSistema(dominio: .altro, codice: -25308) }
        salvataggi += 1
        voci[job] = segreti
        return nil
    }

    func elimina(_ job: UUID) -> KVErroreSistema? {
        serratura.lock(); defer { serratura.unlock() }
        cancellazioni.append(job)
        voci.removeValue(forKey: job)
        return nil
    }

    func tuttiIJob() -> Set<UUID>? {
        serratura.lock(); defer { serratura.unlock() }
        return elencoNonDisponibile ? nil : Set(voci.keys)
    }

    // Dalla prova
    func contiene(_ job: UUID) -> Bool {
        serratura.lock(); defer { serratura.unlock() }
        return voci[job] != nil
    }

    func segreti(_ job: UUID) -> KVSegretiVoce? {
        serratura.lock(); defer { serratura.unlock() }
        return voci[job]
    }

    func semina(_ job: UUID, _ segreti: KVSegretiVoce) {
        serratura.lock(); defer { serratura.unlock() }
        voci[job] = segreti
    }

    var numero: Int {
        serratura.lock(); defer { serratura.unlock() }
        return voci.count
    }
}

// MARK: - La notifica

final class NotificatoreFinto: KVNotificatore {
    private let serratura = NSLock()
    private(set) var mostrate: [(titolo: String, corpo: String)] = []
    private(set) var rimozioni = 0
    var esito = KVEsitoNotificaAttesa(autorizzata: true, programmata: true)
    /// Se `true` il completamento non scatta da solo: lo fa `risolvi()`.
    var sospeso = false
    private var inSospeso: [() -> Void] = []

    func mostraAttesa(titolo: String, corpo: String, completamento: @escaping (KVEsitoNotificaAttesa) -> Void) {
        serratura.lock()
        mostrate.append((titolo, corpo))
        let esitoAdesso = esito
        let aspetta = sospeso
        if aspetta { inSospeso.append { completamento(esitoAdesso) } }
        serratura.unlock()
        if !aspetta { completamento(esitoAdesso) }
    }

    func rimuoviAttesa() {
        serratura.lock(); defer { serratura.unlock() }
        rimozioni += 1
    }

    func risolvi() {
        serratura.lock()
        let pronti = inSospeso
        inSospeso = []
        serratura.unlock()
        pronti.forEach { $0() }
    }

    var numeroMostrate: Int {
        serratura.lock(); defer { serratura.unlock() }
        return mostrate.count
    }
}

// MARK: - La rete

final class ReteFinta: KVMonitorRete {
    private let serratura = NSLock()
    private var valore: Bool?
    private var gestore: ((Bool) -> Void)?
    private(set) var partita = false

    var disponibile: Bool? {
        serratura.lock(); defer { serratura.unlock() }
        return valore
    }

    var cambiamento: ((Bool) -> Void)? {
        get { serratura.lock(); defer { serratura.unlock() }; return gestore }
        set { serratura.lock(); gestore = newValue; serratura.unlock() }
    }

    func avvia() {
        serratura.lock(); defer { serratura.unlock() }
        partita = true
    }

    /// Il sistema dice che la rete c'è / non c'è.
    func imposta(_ ok: Bool) {
        serratura.lock()
        valore = ok
        let lavoro = gestore
        serratura.unlock()
        lavoro?(ok)
    }
}

// MARK: - Il lavoro in background

final class LavoroFinto: KVLavoroInBackground {
    private let serratura = NSLock()
    private(set) var iniziati = 0
    private(set) var terminati: [Int] = []
    private var scadenze: [Int: () -> Void] = [:]

    func inizia(alScadere: @escaping () -> Void) -> Int {
        serratura.lock(); defer { serratura.unlock() }
        iniziati += 1
        scadenze[iniziati] = alScadere
        return iniziati
    }

    func termina(_ gettone: Int) {
        serratura.lock(); defer { serratura.unlock() }
        terminati.append(gettone)
    }

    /// Il sistema ritira il tempo concesso.
    func scade(_ gettone: Int) {
        serratura.lock()
        let lavoro = scadenze[gettone]
        serratura.unlock()
        lavoro?()
    }

    var aperti: Int {
        serratura.lock(); defer { serratura.unlock() }
        return iniziati - Set(terminati).count
    }
}

// MARK: - Il pianificatore

final class PianificatoreFinto {
    private final class Voce {
        let numero: Int
        let quando: Date
        let lavoro: () -> Void
        var annullata = false
        init(numero: Int, quando: Date, lavoro: @escaping () -> Void) { self.numero = numero; self.quando = quando; self.lavoro = lavoro }
    }
    private let serratura = NSLock()
    private var voci: [Voce] = []
    private var contatore = 0
    private(set) var programmate = 0

    func pianifica(_ dopo: TimeInterval, _ lavoro: @escaping () -> Void) -> () -> Void {
        serratura.lock(); defer { serratura.unlock() }
        contatore += 1
        programmate += 1
        let voce = Voce(numero: contatore, quando: orologioProva.addingTimeInterval(dopo), lavoro: lavoro)
        voci.append(voce)
        return { [weak voce] in voce?.annullata = true }
    }

    /// Quanti timer aspettano ancora (non annullati, non scattati).
    var pendenti: Int {
        serratura.lock(); defer { serratura.unlock() }
        return voci.filter { !$0.annullata }.count
    }

    /// Fra quanti secondi scatta il prossimo timer attivo (rispetto a `orologioProva`), o `nil`.
    var prossimoFra: TimeInterval? {
        serratura.lock(); defer { serratura.unlock() }
        return voci.filter { !$0.annullata }.map { $0.quando.timeIntervalSince(orologioProva) }.min()
    }

    /// Sposta l'orologio in avanti di `secondi` facendo scattare, nell'ordine, i timer che cadono nell'intervallo; il motore, dopo ogni scatto,
    /// finisce quello che ha da fare. Un timer nato dallo scatto di un altro e che cade ancora nell'intervallo scatta anche lui.
    func avanza(_ secondi: TimeInterval, motore: KVMotoreCaricamenti) {
        let fine = orologioProva.addingTimeInterval(secondi)
        while true {
            serratura.lock()
            let dovuti = voci.filter { !$0.annullata && $0.quando <= fine }.sorted { ($0.quando, $0.numero) < ($1.quando, $1.numero) }
            guard let prossimo = dovuti.first else {
                serratura.unlock()
                break
            }
            voci.removeAll { $0 === prossimo }
            serratura.unlock()
            if prossimo.quando > orologioProva { orologioProva = prossimo.quando }
            prossimo.lavoro()
            motore.attendi()
        }
        orologioProva = fine
    }
}

// MARK: - Le chiamate di sistema del Portachiavi

/// Un Portachiavi in memoria che si comporta come quello vero dove conta (duplicati, assenze, «non adesso») e registra le query, per provare che
/// gli attributi sono quelli giusti.
final class SicurezzaFinta {
    struct Elemento { var attributi: [String: Any]; var dati: Data }
    private let serratura = NSLock()
    private(set) var elementi: [String: Elemento] = [:]
    private(set) var queryAggiunte: [[String: Any]] = []
    private(set) var queryAggiornamenti: [[String: Any]] = []
    private(set) var queryLettura: [[String: Any]] = []
    private(set) var queryCancellazione: [[String: Any]] = []
    /// Se non `nil`, ogni chiamata risponde con questo stato (un Portachiavi che non risponde, es. -25308 prima del primo sblocco).
    var statoForzato: OSStatus?

    private func chiave(_ q: [String: Any]) -> String {
        return "\(q[kSecAttrService as String] as? String ?? "?")|\(q[kSecAttrAccount as String] as? String ?? "?")"
    }

    var operazioni: KVOperazioniSicurezza {
        return KVOperazioniSicurezza(
            aggiungi: { [self] attributi in
                let q = attributi as! [String: Any]
                serratura.lock(); defer { serratura.unlock() }
                queryAggiunte.append(q)
                if let forzato = statoForzato { return forzato }
                let k = chiave(q)
                if elementi[k] != nil { return errSecDuplicateItem }
                elementi[k] = Elemento(attributi: q, dati: (q[kSecValueData as String] as? Data) ?? Data())
                return errSecSuccess
            },
            cerca: { [self] query, risultato in
                let q = query as! [String: Any]
                serratura.lock(); defer { serratura.unlock() }
                queryLettura.append(q)
                if let forzato = statoForzato { return forzato }
                if q[kSecAttrAccount as String] == nil {
                    // elenco di tutti gli elementi del servizio
                    let servizio = q[kSecAttrService as String] as? String
                    let trovati = elementi.values.filter { ($0.attributi[kSecAttrService as String] as? String) == servizio }
                    if trovati.isEmpty { return errSecItemNotFound }
                    risultato?.pointee = trovati.map { [kSecAttrAccount as String: $0.attributi[kSecAttrAccount as String] as Any] } as CFTypeRef
                    return errSecSuccess
                }
                guard let e = elementi[chiave(q)] else { return errSecItemNotFound }
                risultato?.pointee = e.dati as CFTypeRef
                return errSecSuccess
            },
            aggiorna: { [self] query, cambi in
                let q = query as! [String: Any]
                let c = cambi as! [String: Any]
                serratura.lock(); defer { serratura.unlock() }
                queryAggiornamenti.append(c)
                if let forzato = statoForzato { return forzato }
                let k = chiave(q)
                guard var e = elementi[k] else { return errSecItemNotFound }
                if let dati = c[kSecValueData as String] as? Data { e.dati = dati }
                elementi[k] = e
                return errSecSuccess
            },
            cancella: { [self] query in
                let q = query as! [String: Any]
                serratura.lock(); defer { serratura.unlock() }
                queryCancellazione.append(q)
                if let forzato = statoForzato { return forzato }
                return elementi.removeValue(forKey: chiave(q)) == nil ? errSecItemNotFound : errSecSuccess
            }
        )
    }

    var numero: Int {
        serratura.lock(); defer { serratura.unlock() }
        return elementi.count
    }

    /// Mette un elemento a mano (un account che non è un uuid, per provare che l'elenco non lo nomina).
    func semina(servizio: String, account: String, dati: Data) {
        serratura.lock(); defer { serratura.unlock() }
        let q: [String: Any] = [kSecAttrService as String: servizio, kSecAttrAccount as String: account]
        elementi[chiave(q)] = Elemento(attributi: q, dati: dati)
    }
}

// MARK: - Il centro delle notifiche

final class CentroNotificheFinto: KVCentroNotifiche {
    var stato: UNAuthorizationStatus = .authorized
    var accetta = true
    private(set) var aggiunte: [(identificativo: String, titolo: String, corpo: String)] = []
    private(set) var rimosse: [String] = []
    private(set) var chiamateStato = 0

    func statoAutorizzazione(_ completamento: @escaping (UNAuthorizationStatus) -> Void) {
        chiamateStato += 1
        completamento(stato)
    }

    func aggiungi(identificativo: String, titolo: String, corpo: String, completamento: @escaping (Bool) -> Void) {
        aggiunte.append((identificativo, titolo, corpo))
        completamento(accetta)
    }

    func rimuovi(identificativo: String) {
        rimosse.append(identificativo)
    }
}

// MARK: - Il banco: tutto insieme

/// Un motore con tutte le sue finte, pronto a ricevere un video. Ogni scenario ne crea uno suo, con una cartella sua.
final class BancoMotore {
    let radice: URL
    let trasportoLog = TrasportoFinto()
    let registro: KVRegistroNativo
    let coda: KVCodaCaricamenti
    let segreti = DepositoSegretiInMemoria()
    let trasporto = TrasportoPutFinto()
    let rinnovo = RinnovoFinto()
    let notificatore = NotificatoreFinto()
    let rete = ReteFinta()
    let lavoro = LavoroFinto()
    let pianificatore = PianificatoreFinto()
    let ambiente: KVAmbienteBuild
    var inBackgroundAlLancio: Bool
    var casuale = 0.5
    private let serraturaEmessi = NSLock()
    private var emessiInterni: [(voce: KVVoceCoda, byteInviati: Int64)] = []
    private(set) var motore: KVMotoreCaricamenti!

    /// - `avvia`: chiama `avvia()` e aspetta. - `inPrimoPiano`: chiama anche `riprendiInPrimoPiano()`. - `registroPreesistente`: un registro già
    /// scritto da un processo precedente (la cartella è la stessa).
    init(ambiente: KVAmbienteBuild = .release, inBackground: Bool = false, avvia: Bool = true, inPrimoPiano: Bool = true,
         cartella: URL? = nil, prepara: ((BancoMotore) -> Void)? = nil) {
        orologioProva = t0
        self.ambiente = ambiente
        self.inBackgroundAlLancio = inBackground
        self.radice = cartella ?? nuovaCartella().appendingPathComponent("KidvilleCaricamenti", isDirectory: true)
        // I log restano nel registro anche dopo un «invio»: il trasporto dei log non risponde mai, così la prova li legge tutti.
        trasportoLog.rispostaPredefinita = .nessunaRisposta
        self.registro = KVRegistroNativo(cartella: radice, trasporto: trasportoLog, versioneApp: "1.2+6", ambiente: ambiente, orologio: { orologioProva })
        self.coda = KVCodaCaricamenti(cartella: radice, orologio: { orologioProva }, registro: registro)
        prepara?(self)
        let dipendenze = KVDipendenzeMotore(
            coda: coda, registro: registro, segreti: segreti,
            trasporto: { [unowned self] in self.trasporto },
            rinnovo: rinnovo, notificatore: notificatore, rete: rete, lavoro: lavoro,
            inBackgroundAlLancio: { [unowned self] in self.inBackgroundAlLancio },
            ambiente: ambiente,
            orologio: { orologioProva },
            casuale: { [unowned self] in self.casuale },
            pianifica: { [unowned self] dopo, lavoro in self.pianificatore.pianifica(dopo, lavoro) }
        )
        self.motore = KVMotoreCaricamenti(dipendenze: dipendenze)
        motore.alCambiamento = { [unowned self] voce, byte in
            self.serraturaEmessi.lock()
            self.emessiInterni.append((voce, byte))
            self.serraturaEmessi.unlock()
        }
        if avvia {
            motore.avvia()
            motore.attendi()
            if inPrimoPiano {
                motore.riprendiInPrimoPiano()
                motore.attendi()
            }
        }
    }

    // Lettura dei fatti ----------------------------------------------------------------------

    func voce(_ job: Int) -> KVVoceCoda? { coda.voce(uuid(job)) }
    func stato(_ job: Int) -> KVStatoCaricamento? { voce(job)?.stato }

    func copia(_ job: Int) -> URL { radice.appendingPathComponent(KVCodaCaricamenti.percorsoRelativoCopia(jobId: uuid(job), estensione: "mov")) }
    func scelto(_ id: String, estensione: String = "mov") -> URL { radice.appendingPathComponent("scelti/\(id).\(estensione)") }

    /// Tutti i messaggi scritti nel registro, in ordine.
    var messaggi: [String] { registro.stato().eventi.map { $0.messaggio } }

    /// Gli eventi del registro il cui messaggio comincia con `slug`.
    func eventi(_ slug: String) -> [KVEventoRegistrato] { registro.stato().eventi.filter { $0.messaggio == slug || $0.messaggio.hasPrefix(slug + ":") || $0.messaggio.hasPrefix(slug + " ") } }

    /// Cambiamenti che il motore ha inoltrato al «JS», in ordine.
    var emessi: [(voce: KVVoceCoda, byteInviati: Int64)] {
        serraturaEmessi.lock(); defer { serraturaEmessi.unlock() }
        return emessiInterni
    }

    func azzeraEmessi() {
        serraturaEmessi.lock(); emessiInterni = []; serraturaEmessi.unlock()
    }

    // Pilotaggio -----------------------------------------------------------------------------

    func attendi() { motore.attendi() }

    /// Sposta l'orologio e fa scattare i timer.
    func avanza(_ secondi: TimeInterval) { pianificatore.avanza(secondi, motore: motore) }

    /// Il preparato `scelti/<id>.mov` di `byte` byte.
    @discardableResult
    func preparaScelto(_ id: String, byte: Int, estensione: String = "mov") -> URL {
        let url = scelto(id, estensione: estensione)
        try! FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: nil)
        scrivi(url, byte: byte)
        return url
    }

    /// Una richiesta di accodamento per il job `job`, con il suo preparato già in `scelti/` (se `preparato`).
    func richiesta(_ job: Int, byte: Int = 1000, token: String = tokenA, firma: String = "a", preparato: Bool = true, nome: String = "Gita.mov",
                   scadenzaUrl: Date?? = nil, scadenzaToken: Date? = nil, idElemento: String? = nil) -> KVRichiestaAccodamento {
        let id = idElemento ?? "e\(job)"
        let sorgente = preparato ? preparaScelto(id, byte: byte) : scelto(id)
        let scadenzaDellUrl: Date? = scadenzaUrl ?? orologioProva.addingTimeInterval(7200)
        return KVRichiestaAccodamento(
            jobId: uuid(job), intentId: uuid(100 + job), utenteId: uuid(utenteProva), scuolaId: uuid(900), nome: nome, mime: "video/quicktime",
            origine: .galleria, idElemento: id, sorgente: preparato ? sorgente : nil, estensione: "mov", byteAttesi: Int64(byte),
            urlPut: urlPutProva(job, firma), contentType: "video/quicktime", scadenzaUrl: scadenzaDellUrl.map { iso($0) },
            urlRinnovo: urlRinnovoProva, token: token, scadenzaToken: iso(scadenzaToken ?? orologioProva.addingTimeInterval(48 * 3600)),
            urlRegistro: urlRegistroProva, testi: testiProva
        )
    }

    @discardableResult
    func accoda(_ job: Int, byte: Int = 1000, token: String = tokenA, firma: String = "a") -> KVEsitoAccodamento {
        let esito = motore.accoda(richiesta(job, byte: byte, token: token, firma: firma))
        motore.attendi()
        return esito
    }

    /// Completa il task `id` (o l'ultimo creato) e aspetta il motore.
    func completa(_ id: Int, _ risposta: KVRispostaPut, byteInviati: Int64? = nil) {
        trasporto.completa(id, risposta, byteInviati: byteInviati)
        motore.attendi()
    }

    func rispondiRinnovo(_ esito: KVEsitoRinnovoRete) {
        rinnovo.rispondiUltimo(esito)
        motore.attendi()
    }

    func giraIlMain(_ secondi: TimeInterval = 0.05) {
        RunLoop.current.run(until: Date().addingTimeInterval(secondi))
    }
}

/// I testi che il «JS» passa a ogni `accoda`: DIVERSI dal ripiego italiano della coda, così se il motore non li conserva la prova se ne accorge.
let testiProva = KVTestiNotifiche(titolo: "Kidville (prova)", invio: "Invio in corso (prova)", attesaRete: "Aspetto la rete (prova)", pausa: "In pausa (prova)")
