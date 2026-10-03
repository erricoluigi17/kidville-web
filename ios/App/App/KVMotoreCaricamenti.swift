import Foundation
import Network
import os
import UIKit

// ═══════════════════════════════════════════════════════════════════════════════════════════
//  KVMotoreCaricamenti — il motore dei caricamenti nativi in background (spec §4.3-4.6, §5, §8, §9, compito I2)
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// Che cosa è: UN singolo (`KVMotoreCaricamenti.condiviso`), indipendente dal ponte con la WebView, che possiede
//   · la SESSIONE `URLSession` in background (identificativo `it.kidville.app.caricamenti`) e le sue PUT da file;
//   · la coda persistente (`KVCodaCaricamenti`), il registro dei log (`KVRegistroNativo`), i segreti (`KVPortachiavi`);
//   · il rinnovo dell'URL firmato (`KVRinnovoFirma`), il monitor di rete e la notifica locale d'attesa (`KVNotificaAttesa`).
// Il sistema lo risveglia anche senza WebView (rilancio in background per gli eventi della sessione); la facciata del plugin (I3) si limita a
// chiamarlo (`accoda`, `elenco`, `annulla`, `dimentica`) e a inoltrare al JS ciò che esce da `alCambiamento`.
//
// ─── COME È FATTO ────────────────────────────────────────────────────────────────────────────
//  · TUTTO lo stato del motore vive su UNA coda seriale (`q`): le chiamate che arrivano da fuori (AppDelegate, ponte) e i ritorni di rete, del
//    trasporto, del rinnovo, della notifica, dei timer e del monitor vi rientrano sempre. Una chiamata che restituisce un valore passa da
//    `sulMotore` (sincrona, e rientrante se si è già lì); mai `DispatchQueue.main.sync` dal motore (si incrocerebbe con un chiamante che
//    aspetta il motore).
//  · Le DECISIONI le prende `KVPoliticaCaricamento` (tabelle di §4.4-4.5, provate riga per riga dall'harness): questo file le esegue. Gli
//    STATI li cambia solo `KVCodaCaricamenti.applica`.
//  · Ogni cosa che tocca il mondo passa da un protocollo e arriva dal `KVDipendenzeMotore`: trasporto della PUT, cliente del rinnovo, segreti,
//    notificatore, monitor di rete, lavoro in background, orologio, numero casuale, pianificatore. L'harness (`ios/prove/caricamenti`) ne
//    inietta di finti e pilota il motore a comando, con un orologio suo: i veri sono in fondo a questo file.
//  · Si crea UNA volta per processo: due istanze sulla stessa cartella si sovrascriverebbero il file a vicenda. Chi serve la coda o il
//    registro (il selettore, I3) li prende da qui (`motore.coda`, `motore.registro`), non ne crea altri.
//
// ─── IL CICLO DI UNA VOCE ────────────────────────────────────────────────────────────────────
//   `accoda` → `avanza` → [rinnovo se l'URL è firmato da più di 10 minuti, S0] → task `uploadTask(fromFile:)` → il sistema carica anche a
//   app sospesa → `putFinita` → `decidiPut` → inviato · fallito · attesa e nuovo giro · rinnovo (`rinnovoRisposto` → `decidiRinnovo`) → …
//   Un CICLO è «rinnovo se serve + PUT»: `tentativi` conta i cicli avviati e da lì viene l'attesa dopo un transitorio. I rinnovi di fila dopo una
//   PUT RIFIUTATA sono `rinnoviConsecutivi` (oltre 3: `RINNOVO_CICLICO`); il rinnovo che è solo «l'URL è vecchio» non conta.
//   Dopo un transitorio il prossimo task si crea SUBITO, con `earliestBeginDate`, e non con un timer: a app sospesa o morta ci pensa il
//   sistema; il timer del processo (`programmaRisveglio`) è solo una rete di sicurezza e per il rinnovo che non è riuscito.
//
// ─── COSA SI SCRIVE NEI LOG ──────────────────────────────────────────────────────────────────
//   Solo le funzioni di `KVRegistroNativo` (enumerati e numeri: il tipo garantisce la privacy) e il log di sistema `os.Logger` con soli codici
//   numerici e nomi d'errore di un elenco. Mai: nome del file, percorso, URL, token, hash, `localizedDescription`.

// MARK: - Il trasporto della PUT

/// Un task del sistema che il trasporto ha ancora, com'è visto dal motore (`getAllTasks`).
struct KVTaskVivo: Equatable {
    var job: UUID
    var identificativo: Int
    /// I byte che il sistema dichiara già spediti.
    var byteInviati: Int64
}

/// La PUT da creare: l'unica cosa che parte verso lo Storage, e nient'altro che il server ha deciso (§2.2).
struct KVRichiestaPut: Equatable {
    var job: UUID
    var url: URL
    /// Il solo `content-type` che il server ha dichiarato: l'unica intestazione che si manda.
    var contentType: String
    var file: URL
    var byte: Int64
    /// Il sistema non la fa partire prima (attesa dopo un transitorio). `nil` = subito.
    var nonPrima: Date?
}

/// Il motore, visto dal trasporto. I metodi possono arrivare da un thread qualunque: il motore rientra da solo sulla sua coda.
protocol KVTrasportoPutDelegato: AnyObject {
    func trasporto(avanzamentoDi job: UUID, task: Int, byteInviati: Int64)
    /// Il task è finito: con una risposta HTTP (anche un rifiuto: una PUT rifiutata NON porta `error`), o con un errore di sistema.
    func trasporto(terminatoPer job: UUID, task: Int, risposta: KVRispostaPut, byteInviati: Int64)
    /// `urlSessionDidFinishEvents(forBackgroundURLSession:)`: il sistema ha consegnato tutti gli eventi accumulati.
    func trasportoHaConsegnatoTuttiGliEventi()
    /// La sessione è stata invalidata (il trasporto ne ricrea una alla prossima richiesta).
    func trasportoInvalidato()
}

/// Chi crea e tiene le PUT. Il vero è `KVTrasportoPutURLSession`; l'harness ne inietta uno che completa i task a comando.
protocol KVTrasportoPut: AnyObject {
    var delegato: KVTrasportoPutDelegato? { get set }
    /// I task che il sistema ha ancora (compresi quelli in attesa del loro `earliestBeginDate`).
    func taskVivi(completamento: @escaping ([KVTaskVivo]) -> Void)
    /// Crea e fa partire la PUT. Restituisce l'identificativo del task, o `nil` se non si è potuta creare.
    func avvia(_ richiesta: KVRichiestaPut) -> Int?
    /// Ferma un task. Il suo completamento arriverà come errore `NSURLErrorCancelled`: il motore lo ignora.
    func annulla(task: Int)
}

// MARK: - La rete

/// Il monitor di rete (`NWPathMonitor`). `disponibile` è `nil` finché non è arrivata la prima fotografia: non si decide nulla su un «non so».
protocol KVMonitorRete: AnyObject {
    var disponibile: Bool? { get }
    var cambiamento: ((Bool) -> Void)? { get set }
    func avvia()
}

// MARK: - Le dipendenze

struct KVDipendenzeMotore {
    var coda: KVCodaCaricamenti
    var registro: KVRegistroNativo
    var segreti: KVDepositoSegreti
    /// Si chiama UNA volta, la prima volta che serve: creare la sessione in background vuol dire riagganciarsi agli eventi in sospeso.
    var trasporto: () -> KVTrasportoPut
    var rinnovo: KVClienteRinnovo
    var notificatore: KVNotificatore
    var rete: KVMonitorRete
    var lavoro: KVLavoroInBackground
    /// Letto da `avvia()`, che gira sul thread principale in `didFinishLaunching`: l'app è stata lanciata dal sistema in background?
    var inBackgroundAlLancio: () -> Bool
    var ambiente: KVAmbienteBuild
    var orologio: () -> Date
    /// Un numero uniforme in [0, 1] per lo scarto delle attese.
    var casuale: () -> Double
    /// Fa scattare `lavoro` fra `dopo` secondi, su un thread qualunque; restituisce come annullarlo.
    var pianifica: (_ dopo: TimeInterval, _ lavoro: @escaping () -> Void) -> () -> Void

    /// Le dipendenze vere: quelle dell'app.
    static func predefinite() -> KVDipendenzeMotore {
        let cartella = KVCodaCaricamenti.cartellaPredefinita()
        let registro = KVRegistroNativo(cartella: cartella, trasporto: KVTrasportoRegistroRete(),
                                        versioneApp: KVRegistroNativo.versioneApp(infoDictionary: Bundle.main.infoDictionary))
        let coda = KVCodaCaricamenti(cartella: cartella, registro: registro)
        let lavoro = KVLavoroInBackgroundUIKit()
        return KVDipendenzeMotore(
            coda: coda,
            registro: registro,
            segreti: KVPortachiavi(),
            trasporto: { KVTrasportoPutURLSession() },
            rinnovo: KVRinnovoFirma(lavoro: lavoro),
            notificatore: KVNotificaAttesa(),
            rete: KVMonitorReteNW(),
            lavoro: lavoro,
            inBackgroundAlLancio: { Thread.isMainThread && UIApplication.shared.applicationState == .background },
            ambiente: .corrente,
            orologio: { Date() },
            casuale: { Double.random(in: 0...1) },
            pianifica: { dopo, lavoro in
                let compito = DispatchWorkItem(block: lavoro)
                DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + dopo, execute: compito)
                return { compito.cancel() }
            }
        )
    }
}

// MARK: - L'accodamento

/// Perché `accoda` rifiuta. Il ponte (I3) li traduce nei suoi codici costanti: `ELEMENTO_ASSENTE`, `ELEMENTO_DIVERSO`, `HOST_NON_AMMESSO`,
/// `PARAMETRI_NON_VALIDI`, `INTERNO`.
enum KVRifiutoAccodamento: String, Equatable {
    case elementoAssente
    case elementoDiverso
    case hostNonAmmesso
    case parametriNonValidi
    case interno
}

enum KVEsitoAccodamento: Equatable {
    /// Preso in carico: il preparato è stato spostato in `file/`, i segreti sono nel Portachiavi, il trasferimento sta per partire.
    case accodato(KVVoceCoda)
    /// C'era già una voce VIVA con quel `jobId` (apertura ripetuta, token ruotato): i segreti sono stati sostituiti, lo stato è quello di adesso.
    case giaInCoda(KVVoceCoda)
    case rifiutato(KVRifiutoAccodamento)
}

/// Ciò che il ponte passa al motore per prendere in carico un video. Gli indirizzi e le scadenze sono ancora TESTO, com'è arrivato dal JS: li
/// controlla il motore (la politica degli host, §9), così il controllo sta in un punto solo.
struct KVRichiestaAccodamento {
    var jobId: UUID
    var intentId: UUID
    var utenteId: UUID
    var scuolaId: UUID
    /// Solo per lo schermo: mai in un log.
    var nome: String
    var mime: String
    var origine: KVOrigineCaricamento
    /// L'id del preparato (`scelti/<id>.<ext>`): lo si toglie dalla cartella dei preparati a ripetizione di un accodamento già riuscito.
    var idElemento: String
    /// Il preparato in `scelti/`. `nil` va bene SOLO se c'è già una voce viva con quel `jobId` (apertura ripetuta: il preparato è già in `file/`).
    var sorgente: URL?
    var estensione: String
    var byteAttesi: Int64
    var urlPut: String
    var contentType: String
    /// Scadenza dell'URL di PUT (`expires_at` del job), ISO 8601; `nil` = non nota: si rinnova prima di spedire.
    var scadenzaUrl: String?
    var urlRinnovo: String
    var token: String
    /// Scadenza del token (48 ore), ISO 8601.
    var scadenzaToken: String
    var urlRegistro: String
    var testi: KVTestiNotifiche
}

// MARK: - Lo stato che non si salva

/// Ciò che il motore sa di una voce SOLO finché il processo vive: i byte spediti, il task, il rinnovo in volo, il timer. Mai su disco.
private final class KVStatoRuntime {
    /// L'identificativo del task vivo di questa voce, se il motore lo sa.
    var taskCorrente: Int?
    /// I task che abbiamo fermato noi: il loro completamento (`NSURLErrorCancelled`) non è un esito.
    var ignorati = Set<Int>()
    var byteInviati: Int64 = 0
    var inizio: Date?
    /// Il numero del rinnovo in volo per questa voce, o `nil`. Una risposta si accetta solo se porta questo numero: quella di un rinnovo di una voce
    /// poi chiusa (o chiusa, dimenticata e rimandata: stesso job, un'altra vita) non deve toccare la voce di adesso, né farle un secondo task.
    var rinnovoInCorso: Int?
    /// Il nome d'errore dello Storage della PUT rifiutata che ha causato il rinnovo in corso (per `error_code` del log del rinnovo).
    var erroreStorage: KVErroreStorage?
    var annullaRisveglio: (() -> Void)?
    var ultimaEmissione: Date?
    var byteUltimaEmissione: Int64 = 0
    /// I byte che il task aveva spedito quando la chiusura forzata l'ha annullato (per `video-nativo-ripreso-dopo-chiusura`).
    var byteDellaChiusura: Int64 = 0
}

// MARK: - Il motore

final class KVMotoreCaricamenti: KVTrasportoPutDelegato {

    // MARK: Numeri

    /// L'identificativo della sessione in background: lo stesso a ogni avvio, o gli eventi in sospeso non si ritrovano.
    static let identificativoSessione = "it.kidville.app.caricamenti"
    static let motore = KVMotoreLog.urlsession
    /// Il sistema dà ~30 secondi dopo `handleEventsForBackgroundURLSession`: oltre ~20 si chiude comunque, o l'app viene terminata.
    static let tettoLavoroSessioneSecondi: TimeInterval = 20
    /// Quanto si aspetta prima di riprovare con il Portachiavi che non risponde (telefono non ancora sbloccato dopo un riavvio).
    static let attesaPortachiaviSecondi: TimeInterval = 60
    /// Quante volte `carica()` può rispondere «illeggibile adesso» con l'app in primo piano (cioè col telefono sbloccato) prima di trattare la coda da
    /// corrotta: oltre non è più «non ancora», è guasta.
    static let tentativiPrimaDellEscalation = 3
    /// L'avanzamento arriva al JS al più ogni mezzo secondo, e solo se sono passati almeno 3 secondi o il progresso è di almeno l'1%.
    static let intervalloAvanzamentoMinimo: TimeInterval = 0.5
    static let intervalloAvanzamentoMassimo: TimeInterval = 3

    /// Il motore dell'app. Parte alla prima chiamata: `AppDelegate` lo tocca in `didFinishLaunching`.
    static let condiviso = KVMotoreCaricamenti(dipendenze: .predefinite())

    // MARK: Cose che altri possono prendere

    let coda: KVCodaCaricamenti
    let registro: KVRegistroNativo

    private let segreti: KVDepositoSegreti
    private let creaTrasporto: () -> KVTrasportoPut
    private let rinnovo: KVClienteRinnovo
    private let notificatore: KVNotificatore
    private let rete: KVMonitorRete
    private let lavoro: KVLavoroInBackground
    private let inBackgroundAlLancio: () -> Bool
    private let ambiente: KVAmbienteBuild
    private let orologio: () -> Date
    private let casuale: () -> Double
    private let pianifica: (TimeInterval, @escaping () -> Void) -> () -> Void
    private let diagnostica = Logger(subsystem: Bundle.main.bundleIdentifier ?? "it.kidville.app", category: "caricamenti-motore")

    // MARK: Lo stato (solo su `q`)

    private let q = DispatchQueue(label: "it.kidville.caricamenti.motore")
    private let chiaveCoda = DispatchSpecificKey<UUID>()
    private let identitaCoda = UUID()
    private let serraturaAscoltatore = NSLock()
    private var ascoltatore: ((KVVoceCoda, Int64) -> Void)?
    private let serraturaBlocchi = NSLock()
    private var blocchiInVolo = 0

    private var trasporto: KVTrasportoPut?
    private var runtime: [UUID: KVStatoRuntime] = [:]
    private var avviato = false
    private var avvioCompletato = false
    /// La pulizia della coda è girata almeno una volta? Se all'avvio la coda non si leggeva, gira alla prima riapertura in cui si legge.
    private var pulizieFatte = false
    private var primoPianoRinviato = false
    private var lancioInBackground = false
    private var inPrimoPiano = false
    private var primaAttivazioneDopoAvvio = true
    private var reteDisponibile: Bool?
    private var notificaVisibile = false
    private var tentativiLetturaCoda = 0
    private var rinnoviAvviati = 0
    private var operazioniInSospeso = 0
    private var completamentoSessione: (() -> Void)?
    private var gettoneSessione: Int?
    private var eventiFinitiVisti = false
    private var svuotamentoFinaleFatto = false
    private var annullaGuardiaSessione: (() -> Void)?
    private var annullaSvuotamentoDifferito: (() -> Void)?

    init(dipendenze: KVDipendenzeMotore) {
        self.coda = dipendenze.coda
        self.registro = dipendenze.registro
        self.segreti = dipendenze.segreti
        self.creaTrasporto = dipendenze.trasporto
        self.rinnovo = dipendenze.rinnovo
        self.notificatore = dipendenze.notificatore
        self.rete = dipendenze.rete
        self.lavoro = dipendenze.lavoro
        self.inBackgroundAlLancio = dipendenze.inBackgroundAlLancio
        self.ambiente = dipendenze.ambiente
        self.orologio = dipendenze.orologio
        self.casuale = dipendenze.casuale
        self.pianifica = dipendenze.pianifica
        q.setSpecific(key: chiaveCoda, value: identitaCoda)
    }

    /// Chi riceve ogni cambiamento di una voce (stato, avanzamento): la facciata del plugin lo inoltra al JS come evento `caricamento`. Si chiama su
    /// un thread del motore: chi riceve rientra da solo dove gli serve.
    var alCambiamento: ((KVVoceCoda, Int64) -> Void)? {
        get { serraturaAscoltatore.lock(); defer { serraturaAscoltatore.unlock() }; return ascoltatore }
        set { serraturaAscoltatore.lock(); ascoltatore = newValue; serraturaAscoltatore.unlock() }
    }

    // MARK: Utilità della coda

    /// Esegue `lavoro` sulla coda del motore e ne restituisce il risultato; se si è già lì lo esegue subito.
    private func sulMotore<T>(_ lavoro: () -> T) -> T {
        if DispatchQueue.getSpecific(key: chiaveCoda) == identitaCoda { return lavoro() }
        return q.sync(execute: lavoro)
    }

    /// Aspetta che il motore abbia finito TUTTO ciò che ha in coda, compresi i blocchi che i blocchi accodano a loro volta (un completamento che rientra
    /// sulla coda dopo una chiamata fatta sulla coda). Serve alla prova; non fa parte del funzionamento.
    func attendi() {
        for _ in 0..<500 {
            sulMotore { () -> Void in }
            serraturaBlocchi.lock()
            let ancora = blocchiInVolo
            serraturaBlocchi.unlock()
            if ancora == 0 { return }
        }
    }

    /// Accoda un blocco sulla coda del motore, e lo conta finché non ha finito (per `attendi`).
    private func inCoda(_ lavoro: @escaping () -> Void) {
        serraturaBlocchi.lock()
        blocchiInVolo += 1
        serraturaBlocchi.unlock()
        q.async { [weak self] in
            lavoro()
            guard let self = self else { return }
            self.serraturaBlocchi.lock()
            self.blocchiInVolo -= 1
            self.serraturaBlocchi.unlock()
        }
    }

    /// Un timer il cui lavoro rientra sulla coda del motore. Restituisce come annullarlo.
    private func pianificaSulMotore(dopo secondi: TimeInterval, _ lavoro: @escaping () -> Void) -> () -> Void {
        return pianifica(secondi) { [weak self] in self?.inCoda(lavoro) }
    }

    private func runtimeDi(_ job: UUID) -> KVStatoRuntime {
        if let esistente = runtime[job] { return esistente }
        let nuovo = KVStatoRuntime()
        runtime[job] = nuovo
        return nuovo
    }

    private func ottieniTrasporto() -> KVTrasportoPut {
        if let esistente = trasporto { return esistente }
        let nuovo = creaTrasporto()
        nuovo.delegato = self
        trasporto = nuovo
        return nuovo
    }

    private func inizioOperazione() { operazioniInSospeso += 1 }

    private func fineOperazione() {
        operazioniInSospeso = max(0, operazioniInSospeso - 1)
        tentaCompletamentoSessione()
    }

    // MARK: - Il ciclo di vita (AppDelegate)

    /// `didFinishLaunching`: ricrea la sessione con lo stesso identificativo (riceve gli eventi in sospeso), riconcilia la coda con `getAllTasks`, fa
    /// la pulizia. NON crea task: lo fa `riprendiInPrimoPiano` (app attiva) o l'esito di un task (rilancio in background).
    func avvia() {
        let inBackground = inBackgroundAlLancio()
        inCoda { self.avviaSulMotore(inBackground: inBackground) }
    }

    private func avviaSulMotore(inBackground: Bool) {
        guard !avviato else { return }
        avviato = true
        lancioInBackground = inBackground
        // I log nati prima del primo `accodaVideo` partono lo stesso: in Release la destinazione è nota fin dall'avvio.
        registro.impostaDestinazionePredefinita()
        rete.cambiamento = { [weak self] disponibile in self?.inCoda { self?.reteCambiata(disponibile) } }
        rete.avvia()
        assicuraCodaPronta()
        // La sessione si crea DOPO aver caricato la coda: gli eventi in sospeso che il sistema consegna (un task finito mentre l'app era morta)
        // rientrano sulla coda del motore, cioè dopo questo blocco, e trovano la coda pronta.
        let trasporto = ottieniTrasporto()
        inizioOperazione()
        var fatto = false
        var annullaGuardia: (() -> Void)?
        trasporto.taskVivi { [weak self] vivi in
            self?.inCoda {
                guard let self = self, !fatto else { return }
                fatto = true
                annullaGuardia?()
                self.completaAvvio(vivi: vivi)
                self.fineOperazione()
            }
        }
        // Se il sistema non risponde a `getAllTasks` la pulizia non resta indietro per sempre.
        annullaGuardia = pianificaSulMotore(dopo: 15) { [weak self] in
            guard let self = self, !fatto else { return }
            fatto = true
            self.completaAvvio(vivi: [])
            self.fineOperazione()
        }
    }

    /// Dopo che il sistema ha detto quali task ha ancora — e quindi dopo che gli eventi consegnati alla creazione della sessione sono stati
    /// applicati — si riconcilia e SI PULISCE: un task finito con successo a token appena scaduto si segna `inviato` prima che la pulizia lo chiuda
    /// come `TOKEN_SCADUTO`.
    private func completaAvvio(vivi: [KVTaskVivo]) {
        riconcilia(vivi)
        pulisciLaCoda()
        let vive = coda.tutte().filter { !$0.stato.eTerminale }
        if !vive.isEmpty {
            registro.registraMotore(motore: Self.motore, occasione: lancioInBackground ? .rilancioBackground : .avvio,
                                    inCoda: vive.filter { $0.stato == .inCoda }.count, inInvio: vive.filter { $0.stato == .inInvio }.count,
                                    taskVivi: vive.filter { runtime[$0.jobId]?.taskCorrente != nil }.count)
        }
        avvioCompletato = true
        svuotaRegistro()
        if primoPianoRinviato {
            primoPianoRinviato = false
            riprendiInPrimoPianoSulMotore()
        }
    }

    /// `application(_:handleEventsForBackgroundURLSession:completionHandler:)`: il sistema ha risvegliato l'app per gli eventi della sessione. Il
    /// completamento si chiama sul main DOPO il lavoro conseguente (rinnovo, nuovo task, svuotamento del registro), e comunque entro ~20 secondi.
    func ricollega(_ identificativo: String, _ completamento: @escaping () -> Void) {
        guard identificativo == Self.identificativoSessione else {
            DispatchQueue.main.async(execute: completamento)
            return
        }
        let gettone = lavoro.inizia(alScadere: { [weak self] in self?.inCoda { self?.chiudiLavoroDellaSessione() } })
        inCoda {
            if let precedente = self.completamentoSessione {
                // Due richiami di fila: il primo si chiude (la sessione è una sola e l'esito è lo stesso).
                DispatchQueue.main.async(execute: precedente)
                if let vecchio = self.gettoneSessione { self.lavoro.termina(vecchio) }
            }
            self.completamentoSessione = completamento
            self.gettoneSessione = gettone
            self.svuotamentoFinaleFatto = false
            _ = self.ottieniTrasporto()
            self.annullaGuardiaSessione?()
            self.annullaGuardiaSessione = self.pianificaSulMotore(dopo: Self.tettoLavoroSessioneSecondi) { [weak self] in
                self?.chiudiLavoroDellaSessione()
            }
            self.tentaCompletamentoSessione()
        }
    }

    /// Il sistema ha consegnato tutti gli eventi. Si completa quando anche il lavoro conseguente è finito.
    private func tentaCompletamentoSessione() {
        guard completamentoSessione != nil, eventiFinitiVisti, operazioniInSospeso == 0 else { return }
        if !svuotamentoFinaleFatto {
            // Un ultimo svuotamento del registro PRIMA di chiudere: i log di ciò che è appena successo non devono aspettare la prossima volta.
            svuotamentoFinaleFatto = true
            svuotaRegistro()
            return
        }
        chiudiLavoroDellaSessione()
    }

    /// Chiama il completamento del sistema (sul main) e libera il lavoro in background. Va bene richiamarla: la seconda volta non fa niente.
    private func chiudiLavoroDellaSessione() {
        annullaGuardiaSessione?()
        annullaGuardiaSessione = nil
        guard let completamento = completamentoSessione else { return }
        completamentoSessione = nil
        eventiFinitiVisti = false
        svuotamentoFinaleFatto = false
        let gettone = gettoneSessione
        gettoneSessione = nil
        let lavoro = self.lavoro
        DispatchQueue.main.async {
            completamento()
            if let gettone = gettone { lavoro.termina(gettone) }
        }
    }

    /// `applicationDidBecomeActive`: l'app è in primo piano. Ricrea le voci senza task vivo, quelle chiuse a forza e quelle create in background con
    /// 0 byte (iOS le tratta da discrezionali); toglie la notifica d'attesa.
    func riprendiInPrimoPiano() {
        inCoda { self.riprendiInPrimoPianoSulMotore() }
    }

    private func riprendiInPrimoPianoSulMotore() {
        guard avviato else { return }
        if !inPrimoPiano {
            // Gli eventi consegnati quando l'app si è aperta in primo piano non aspettano nessun completamento: il segno che
            // `urlSessionDidFinishEvents` ha lasciato vale solo per un rilancio in background.
            eventiFinitiVisti = completamentoSessione != nil && eventiFinitiVisti
        }
        inPrimoPiano = true
        notificatore.rimuoviAttesa()
        notificaVisibile = false
        guard avvioCompletato else {
            primoPianoRinviato = true
            return
        }
        let loggaIlPrimoPiano = !primaAttivazioneDopoAvvio || lancioInBackground
        primaAttivazioneDopoAvvio = false
        assicuraCodaPronta()
        registro.riprovaLettura()
        inizioOperazione()
        ottieniTrasporto().taskVivi { [weak self] vivi in
            self?.inCoda {
                guard let self = self else { return }
                self.riprendiConTaskVivi(vivi, logga: loggaIlPrimoPiano)
                self.fineOperazione()
            }
        }
    }

    private func riprendiConTaskVivi(_ vivi: [KVTaskVivo], logga: Bool) {
        riconcilia(vivi)
        guard coda.pronta else { return }
        if !pulizieFatte { pulisciLaCoda() }
        let vive = coda.tutte().filter { !$0.stato.eTerminale }
        if logga && !vive.isEmpty {
            registro.registraMotore(motore: Self.motore, occasione: .primoPiano,
                                    inCoda: vive.filter { $0.stato == .inCoda }.count, inInvio: vive.filter { $0.stato == .inInvio }.count,
                                    taskVivi: vive.filter { runtime[$0.jobId]?.taskCorrente != nil }.count)
        }
        for voce in vive {
            let rt = runtimeDi(voce.jobId)
            if rt.taskCorrente == nil {
                if voce.stato == .inAttesa && voce.codice == .chiusuraForzata {
                    registro.registraRipresoDopoChiusura(job: voce.jobId, utente: voce.utenteId, byteInviati: rt.byteDellaChiusura)
                }
                ripartiOra(voce)
            } else if voce.creatoInBackground && rt.byteInviati == 0, let id = rt.taskCorrente {
                // Un task creato in background iOS lo tratta da discrezionale (può aspettare ore, Wi-Fi, carica): in primo piano non lo è.
                rt.ignorati.insert(id)
                rt.taskCorrente = nil
                ottieniTrasporto().annulla(task: id)
                ripartiOra(voce)
            }
        }
        svuotaRegistro()
    }

    /// `applicationDidEnterBackground`: con voci che stanno inviando o aspettando e la rete assente, la notifica locale parte SUBITO (dopo, a app
    /// sospesa, nessun codice gira finché la rete non torna).
    func notificaSeFermo() {
        inCoda {
            self.inPrimoPiano = false
            guard self.coda.pronta else { return }
            if self.reteDisponibile == false && self.esistonoVociInInvioOInAttesa() { self.mostraLaNotificaDiAttesa() }
        }
    }

    // MARK: - L'API per la facciata del plugin (I3)

    /// Prende in carico un video preparato: controlla i parametri e gli host (§9), sposta il preparato in `file/<jobId>.<ext>`, salva i segreti,
    /// crea il trasferimento. **Idempotente su `jobId`**: se c'è già una voce viva (apertura ripetuta, token ruotato) sostituisce i segreti e
    /// restituisce lo stato attuale. Il confronto dell'`sha256` con l'elemento scelto è della facciata, che conosce gli elementi.
    ///
    /// L'ORDINE conta, perché in nessun punto una interruzione deve lasciare un video perso senza traccia: i segreti, poi la voce in coda, poi la
    /// copia in `file/`. Se qualcosa non riesce si disfa il passo prima: i segreti sono residui che la pulizia toglie, la voce si toglie subito
    /// (`rimuoviVoce`), il preparato non si è mosso. Una voce senza copia (interruzione fra i due ultimi passi) è visibile: `FILE_ASSENTE`.
    func accoda(_ richiesta: KVRichiestaAccodamento) -> KVEsitoAccodamento {
        return sulMotore { accodaSulMotore(richiesta) }
    }

    private struct ParametriValidati {
        var urlScadeIl: Date?
        var tokenScadeIl: Date
    }

    private func accodaSulMotore(_ r: KVRichiestaAccodamento) -> KVEsitoAccodamento {
        guard avviato else { return .rifiutato(.interno) }
        guard assicuraCodaPronta() else { return .rifiutato(.interno) }

        // 1. Gli indirizzi: una pagina compromessa non può far spedire il video di un bambino altrove.
        guard KVPoliticaCaricamento.indirizzoAmmesso(r.urlPut, uso: .put, ambiente: ambiente) != nil,
              KVPoliticaCaricamento.indirizzoAmmesso(r.urlRinnovo, uso: .rinnovo, ambiente: ambiente) != nil,
              KVPoliticaCaricamento.indirizzoAmmesso(r.urlRegistro, uso: .registro, ambiente: ambiente) != nil else {
            return .rifiutato(.hostNonAmmesso)
        }
        // 2. I parametri.
        let segretiNuovi = KVSegretiVoce(token: r.token, urlPut: r.urlPut, contentType: r.contentType, urlRinnovo: r.urlRinnovo)
        guard r.byteAttesi >= 1, KVPortachiavi.segretiValidi(segretiNuovi),
              let tokenScadeIl = KVPoliticaCaricamento.leggiDataISO(r.scadenzaToken) else {
            return .rifiutato(.parametriNonValidi)
        }
        var urlScadeIl: Date? = nil
        if let testo = r.scadenzaUrl {
            guard let data = KVPoliticaCaricamento.leggiDataISO(testo) else { return .rifiutato(.parametriNonValidi) }
            urlScadeIl = data
        }
        let validati = ParametriValidati(urlScadeIl: urlScadeIl, tokenScadeIl: tokenScadeIl)

        // 3. Una voce viva con questo job: l'apertura è ripetuta (token ruotato), non si crea niente.
        if let esistente = coda.voce(r.jobId), !esistente.stato.eTerminale {
            return riaccodaSulMotore(r, esistente: esistente, segreti: segretiNuovi, validati: validati)
        }

        // 4. Il preparato.
        guard let sorgente = r.sorgente, FileManager.default.fileExists(atPath: sorgente.path) else { return .rifiutato(.elementoAssente) }
        let peso = ((try? FileManager.default.attributesOfItem(atPath: sorgente.path))?[.size] as? NSNumber)?.int64Value
        guard peso == r.byteAttesi else { return .rifiutato(.elementoDiverso) }

        // 5. I segreti, la voce, la copia.
        if segreti.salva(segretiNuovi, per: r.jobId) != nil { return .rifiutato(.interno) }
        let ora = orologio()
        let voce = KVVoceCoda(jobId: r.jobId, intentId: r.intentId, utenteId: r.utenteId, scuolaId: r.scuolaId, nome: r.nome,
                              file: KVCodaCaricamenti.percorsoRelativoCopia(jobId: r.jobId, estensione: r.estensione), byte: r.byteAttesi,
                              mime: r.mime, origine: r.origine, urlScadeIl: validati.urlScadeIl, tokenScadeIl: validati.tokenScadeIl,
                              creatoIl: ora, creatoInBackground: !inPrimoPiano)
        switch coda.aggiungi(voce) {
        case .aggiunta, .sostituita:
            break
        case .giaPresente(let corrente):
            // Non può succedere (si è già guardato sopra, e il motore è seriale); se succede si comporta da apertura ripetuta.
            return riaccodaSulMotore(r, esistente: corrente, segreti: segretiNuovi, validati: validati)
        case .nonValida, .nonPronta, .scritturaFallita:
            segreti.elimina(r.jobId)
            return .rifiutato(.interno)
        }
        guard coda.spostaInFile(da: sorgente, perVoce: r.jobId) else {
            coda.rimuoviVoce(r.jobId)
            segreti.elimina(r.jobId)
            return .rifiutato(.interno)
        }
        coda.impostaTesti(r.testi)
        registro.impostaDestinazione(r.urlRegistro)
        registro.registraAccodato(job: r.jobId, utente: r.utenteId, byte: r.byteAttesi, mime: KVMimeVideo(mime: r.mime), motore: Self.motore)
        _ = runtimeDi(r.jobId)
        emetti(r.jobId)
        avanza(r.jobId)
        return .accodato(coda.voce(r.jobId) ?? voce)
    }

    /// Apertura ripetuta: il server ha ruotato il token (il vecchio è già sconosciuto) e ha dato un URL nuovo. Si sostituiscono i segreti e le
    /// scadenze, si scarta l'eventuale secondo preparato (il video è già in `file/`), e se la voce stava aspettando si riparte.
    private func riaccodaSulMotore(_ r: KVRichiestaAccodamento, esistente: KVVoceCoda, segreti nuovi: KVSegretiVoce,
                                   validati: ParametriValidati) -> KVEsitoAccodamento {
        if segreti.salva(nuovi, per: r.jobId) != nil { return .rifiutato(.interno) }
        coda.aggiorna(r.jobId) { voce in
            voce.urlScadeIl = validati.urlScadeIl
            voce.tokenScadeIl = validati.tokenScadeIl
        }
        coda.impostaTesti(r.testi)
        registro.impostaDestinazione(r.urlRegistro)
        if r.sorgente != nil { coda.rimuoviScelti(ids: [r.idElemento]) }
        emetti(r.jobId)
        let rt = runtimeDi(r.jobId)
        if rt.taskCorrente == nil && rt.rinnovoInCorso == nil { ripartiOra(esistente) }
        return .giaInCoda(coda.voce(r.jobId) ?? esistente)
    }

    /// Le voci di quell'utente, per data di creazione, come le vede il JS (`CaricamentoNativo`).
    func elenco(perUtente utenteId: UUID) -> [[String: Any]] {
        return sulMotore {
            coda.voci(perUtente: utenteId).map { $0.comeDizionarioPonte(byteInviati: runtime[$0.jobId]?.byteInviati ?? 0) }
        }
    }

    /// Ferma il trasferimento, cancella copia e segreti, stato `annullato`. NON ritira l'intento: lo fa il JS. `true` se c'era una voce viva.
    @discardableResult
    func annulla(job: UUID) -> Bool {
        return sulMotore {
            guard let voce = coda.voce(job), !voce.stato.eTerminale else { return false }
            termina(voce, evento: .annullato(nil), statoHTTP: nil)
            return true
        }
    }

    /// Toglie dalla coda le voci TERMINALI indicate; le altre le ignora.
    @discardableResult
    func dimentica(_ jobs: [UUID]) -> Int {
        return sulMotore {
            let tolte = coda.dimentica(jobs)
            for job in jobs where coda.voce(job) == nil {
                runtime[job]?.annullaRisveglio?()
                runtime.removeValue(forKey: job)
            }
            return tolte
        }
    }

    // MARK: - La coda e la riconciliazione

    /// La coda è pronta? Se no prova a leggerla. Se con l'app in primo piano — cioè con i dati protetti certamente disponibili — non si riesce a
    /// leggerla per `tentativiPrimaDellEscalation` volte di fila, non è più «non ancora»: il file è guasto, e lasciarlo così vorrebbe dire che ogni
    /// `accodaVideo` fallisce per sempre. Allora lo si tratta da corrotto (`coda-nativa-corrotta`) e si riparte da una coda vuota.
    @discardableResult
    private func assicuraCodaPronta() -> Bool {
        if coda.pronta { return true }
        let esito = coda.carica()
        if case .illeggibileOra = esito {
            if inPrimoPiano {
                tentativiLetturaCoda += 1
                if tentativiLetturaCoda >= Self.tentativiPrimaDellEscalation {
                    tentativiLetturaCoda = 0
                    coda.ripartiDaCapo()
                }
            }
        } else {
            tentativiLetturaCoda = 0
        }
        return coda.pronta
    }

    /// Mette d'accordo la coda con i task che il sistema ha davvero. Un task vivo per una voce viva si adotta; una voce senza task resta com'è
    /// (non si crea niente qui); un task che nessuna voce viva nomina — o un secondo task per la stessa voce — si ferma.
    private func riconcilia(_ vivi: [KVTaskVivo]) {
        guard coda.pronta else { return }
        let voci = coda.tutte().filter { !$0.stato.eTerminale }
        var adottati: [UUID: Int] = [:]
        for task in vivi {
            guard voci.contains(where: { $0.jobId == task.job }), adottati[task.job] == nil else {
                ottieniTrasporto().annulla(task: task.identificativo)
                continue
            }
            adottati[task.job] = task.identificativo
            let rt = runtimeDi(task.job)
            rt.taskCorrente = task.identificativo
            rt.byteInviati = max(rt.byteInviati, task.byteInviati)
        }
        for voce in voci {
            let rt = runtimeDi(voce.jobId)
            if adottati[voce.jobId] == nil {
                rt.taskCorrente = nil
            } else if voce.stato == .inCoda {
                // Una voce ancora «in coda» con un task vivo (un task differito, o il processo è morto fra la creazione e il passo di stato) sta
                // inviando: si porta a `in-invio` e il JS, se è già agganciato, lo sa.
                _ = applicaStato(.trasferimentoAvviato, a: voce.jobId)
                emetti(voce.jobId)
            }
        }
    }

    /// La pulizia della coda (§4.6) e quella dei segreti che non hanno più una voce. I segreti di una voce chiusa dalla pulizia si tolgono solo se
    /// lo stato terminale è stato scritto; se non si è riusciti a scrivere, non si tocca niente.
    private func pulisciLaCoda() {
        guard coda.pronta else { return }
        pulizieFatte = true
        let esito = coda.pulisci()
        for chiusa in esito.vociScadute {
            if esito.persistita { segreti.elimina(chiusa.jobId) }
            runtime[chiusa.jobId]?.annullaRisveglio?()
            runtime[chiusa.jobId]?.rinnovoInCorso = nil
            if let id = runtime[chiusa.jobId]?.taskCorrente {
                runtime[chiusa.jobId]?.ignorati.insert(id)
                ottieniTrasporto().annulla(task: id)
                runtime[chiusa.jobId]?.taskCorrente = nil
            }
            emetti(chiusa.jobId)
        }
        // Un `jobIdAttivi` nullo vuol dire che la pulizia non ha guardato (o non ha potuto scrivere): non si toglie nessun segreto.
        if let attivi = esito.jobIdAttivi, let tutti = segreti.tuttiIJob() {
            for orfano in tutti.subtracting(attivi) { segreti.elimina(orfano) }
        }
    }

    // MARK: - Far avanzare una voce

    /// Fa ripartire una voce SUBITO, senza aspettare la sua attesa (app riaperta, rete tornata, apertura ripetuta).
    private func ripartiOra(_ voce: KVVoceCoda) {
        coda.aggiorna(voce.jobId) { $0.prossimoTentativoIl = nil }
        avanza(voce.jobId)
    }

    /// Avvia un nuovo CICLO per la voce, se serve e se si può: «rinnovo se l'URL è vecchio + PUT». Non fa niente se la voce è terminale, se ha già un
    /// task vivo o un rinnovo in volo. Se la voce ha un'attesa davanti (`prossimoTentativoIl` nel futuro) il task si crea comunque adesso, con
    /// `earliestBeginDate`: a app sospesa il sistema lo fa partire da solo.
    private func avanza(_ job: UUID) {
        guard coda.pronta, let voce = coda.voce(job), !voce.stato.eTerminale else { return }
        let rt = runtimeDi(job)
        if rt.taskCorrente != nil || rt.rinnovoInCorso != nil { return }
        rt.annullaRisveglio?()
        rt.annullaRisveglio = nil
        let ora = orologio()

        if KVPoliticaCaricamento.tokenScaduto(adesso: ora, tokenScadeIl: voce.tokenScadeIl) {
            termina(voce, evento: .fallito(.tokenScaduto), statoHTTP: nil)
            return
        }
        switch coda.statoDellaCopia(di: voce) {
        case .assente: termina(voce, evento: .fallito(.fileAssente), statoHTTP: nil); return
        case .pesoDiverso: termina(voce, evento: .fallito(.pesoDiverso), statoHTTP: nil); return
        case .presente: break
        }
        // La causa di un eventuale rinnovo si legge PRIMA di cambiare lo stato: la porta il codice `FIRMA_RIFIUTATA` di una voce che aspetta dopo una
        // PUT rifiutata il cui rinnovo non era riuscito.
        let causa: KVCausaRinnovo = voce.codice == .firmaRifiutata ? .putRifiutata : .urlVecchio
        let partenza = max(ora, voce.prossimoTentativoIl ?? ora)
        iniziaCiclo(voce, subito: partenza <= ora)
        proseguiIlCiclo(job, causa: causa, partenza: partenza)
    }

    /// `tentativi` + 1, e la voce passa a `in-invio` se parte subito.
    private func iniziaCiclo(_ voce: KVVoceCoda, subito: Bool) {
        if subito {
            switch voce.stato {
            case .inCoda: _ = applicaStato(.trasferimentoAvviato, a: voce.jobId)
            case .inAttesa, .inPausa: _ = applicaStato(.ripreso, a: voce.jobId)
            case .inInvio, .inviato, .fallito, .annullato: break
            }
        }
        coda.aggiorna(voce.jobId) { v in
            v.tentativi += 1
            if subito { v.prossimoTentativoIl = nil }
        }
        emetti(voce.jobId)
    }

    /// Il resto di un ciclo: i segreti, poi il rinnovo se l'URL è firmato da più di 10 minuti (S0: la firma si verifica alla FINE della PUT, quindi
    /// ogni trasferimento deve avere davanti quasi due ore), altrimenti la PUT. `partenza` è l'istante in cui la PUT comincerebbe davvero.
    private func proseguiIlCiclo(_ job: UUID, causa: KVCausaRinnovo, partenza: Date) {
        guard let voce = coda.voce(job), !voce.stato.eTerminale else { return }
        let segretiVoce: KVSegretiVoce
        switch segreti.leggi(job) {
        case .presenti(let trovati):
            segretiVoce = trovati
        case .assenti:
            termina(voce, evento: .fallito(.interno), statoHTTP: nil)
            return
        case .nonDisponibili:
            // Telefono riavviato e non ancora sbloccato: i segreti ci sono, non si leggono adesso. Si aspetta, non si chiude.
            attendi(voce, secondi: Self.attesaPortachiaviSecondi, codice: .interno)
            return
        }
        if KVPoliticaCaricamento.rinnovoProattivoNecessario(urlScadeIl: voce.urlScadeIl, adesso: partenza) {
            eseguiRinnovo(job, causa: causa, segreti: segretiVoce, partenza: partenza)
        } else {
            creaIlTask(job, segreti: segretiVoce, partenza: partenza)
        }
    }

    private func creaIlTask(_ job: UUID, segreti segretiVoce: KVSegretiVoce, partenza: Date) {
        guard let voce = coda.voce(job), !voce.stato.eTerminale else { return }
        guard let url = KVPoliticaCaricamento.indirizzoAmmesso(segretiVoce.urlPut, uso: .put, ambiente: ambiente),
              let file = coda.urlFile(di: voce) else {
            termina(voce, evento: .fallito(.interno), statoHTTP: nil)
            return
        }
        // La copia si ricontrolla PROPRIO prima di consegnarla al sistema: dall'inizio del ciclo è passato un rinnovo, e `uploadTask(fromFile:)` su un file che
        // non c'è, in una sessione in background, non risponde con un errore ma con un'eccezione.
        switch coda.statoDellaCopia(di: voce) {
        case .assente: termina(voce, evento: .fallito(.fileAssente), statoHTTP: nil); return
        case .pesoDiverso: termina(voce, evento: .fallito(.pesoDiverso), statoHTTP: nil); return
        case .presente: break
        }
        let ora = orologio()
        let differita = partenza > ora.addingTimeInterval(1)
        let richiesta = KVRichiestaPut(job: job, url: url, contentType: segretiVoce.contentType, file: file, byte: voce.byte,
                                       nonPrima: differita ? partenza : nil)
        guard let identificativo = ottieniTrasporto().avvia(richiesta) else {
            termina(voce, evento: .fallito(.interno), statoHTTP: nil)
            return
        }
        let rt = runtimeDi(job)
        rt.taskCorrente = identificativo
        rt.byteInviati = 0
        // Un task che parte subito: la voce sta inviando (un task differito lo diventa ai primi byte, in `avanzamento`).
        rt.inizio = differita ? nil : ora
        if !differita {
            switch voce.stato {
            case .inCoda: _ = applicaStato(.trasferimentoAvviato, a: job)
            case .inAttesa, .inPausa: _ = applicaStato(.ripreso, a: job)
            case .inInvio, .inviato, .fallito, .annullato: break
            }
        }
        let inBackground = !inPrimoPiano
        coda.aggiorna(job) { $0.creatoInBackground = inBackground }
        emetti(job)
    }

    // MARK: - L'esito della PUT

    func trasporto(avanzamentoDi job: UUID, task: Int, byteInviati: Int64) {
        inCoda { self.avanzamento(job, task: task, byteInviati: byteInviati) }
    }

    func trasporto(terminatoPer job: UUID, task: Int, risposta: KVRispostaPut, byteInviati: Int64) {
        inCoda { self.putFinita(job, task: task, risposta: risposta, byteInviati: byteInviati) }
    }

    func trasportoHaConsegnatoTuttiGliEventi() {
        inCoda {
            // Gli eventi consegnati con l'app in primo piano non aspettano nessun completamento (il sistema non chiama `handleEvents…`): se si
            // segnassero, un richiamo di `ricollega` di molto dopo li troverebbe «già finiti» e chiuderebbe il lavoro prima del tempo. Quelli di un
            // rilancio in background si segnano anche se arrivano PRIMA di `ricollega`: la sessione si crea in `avvia()`, che precede.
            guard self.completamentoSessione != nil || !self.inPrimoPiano else { return }
            self.eventiFinitiVisti = true
            self.tentaCompletamentoSessione()
        }
    }

    func trasportoInvalidato() {
        inCoda {
            // Il trasporto si ricrea da solo alla prossima richiesta; i task che il sistema ha ancora si ritrovano con `getAllTasks`.
            self.diagnostica.error("sessione in background invalidata")
        }
    }

    private func avanzamento(_ job: UUID, task: Int, byteInviati: Int64) {
        let rt = runtimeDi(job)
        if rt.ignorati.contains(task) { return }
        if let corrente = rt.taskCorrente, corrente != task { return }
        rt.taskCorrente = task
        rt.byteInviati = byteInviati
        let ora = orologio()
        // La durata di un invio conta dai primi BYTE: un avviso a zero byte (il task c'è ma non ha spedito niente) non è l'inizio.
        if rt.inizio == nil && byteInviati > 0 { rt.inizio = ora }
        guard coda.pronta, let voce = coda.voce(job), !voce.stato.eTerminale else { return }
        // I primi byte di un task che aspettava (l'attesa è finita, la rete è tornata): la voce sta inviando.
        if byteInviati > 0 && (voce.stato == .inAttesa || voce.stato == .inCoda) {
            let evento: KVEventoStato = voce.stato == .inCoda ? .trasferimentoAvviato : .ripreso
            _ = applicaStato(evento, a: job)
            coda.aggiorna(job) { $0.prossimoTentativoIl = nil }
            rt.ultimaEmissione = ora
            rt.byteUltimaEmissione = byteInviati
            emetti(job)
            aggiornaLaNotifica()
            return
        }
        // Un avanzamento ogni mezzo secondo, e solo se è cambiato abbastanza (1%) o è passato un po' (3 s).
        let trascorso = ora.timeIntervalSince(rt.ultimaEmissione ?? .distantPast)
        let salto = byteInviati - rt.byteUltimaEmissione
        let unPerCento = max(1, voce.byte / 100)
        if trascorso >= Self.intervalloAvanzamentoMinimo && (salto >= unPerCento || trascorso >= Self.intervalloAvanzamentoMassimo) {
            rt.ultimaEmissione = ora
            rt.byteUltimaEmissione = byteInviati
            emetti(job)
        }
    }

    private func putFinita(_ job: UUID, task: Int, risposta: KVRispostaPut, byteInviati: Int64) {
        let rt = runtimeDi(job)
        if rt.ignorati.remove(task) != nil { return }
        let riuscita = risposta.statoHTTP.map { (200...299).contains($0) } ?? false
        if let corrente = rt.taskCorrente, corrente != task {
            // Un task di un altro giro: quello che abbiamo ricreato è quello buono. Conta solo se il vecchio ha CONCLUSO (2xx).
            guard riuscita else { return }
            rt.ignorati.insert(corrente)
            ottieniTrasporto().annulla(task: corrente)
        }
        rt.taskCorrente = nil
        guard coda.pronta, let voce = coda.voce(job), !voce.stato.eTerminale else { return }
        rt.byteInviati = byteInviati
        let ora = orologio()
        let decisione = KVPoliticaCaricamento.decidiPut(risposta, tentativo: voce.tentativi, adesso: ora, casuale: casuale())
        let consecutivi = KVPoliticaCaricamento.rinnoviConsecutiviDopoPut(attuali: voce.rinnoviConsecutivi, decisione: decisione)
        if consecutivi != voce.rinnoviConsecutivi { coda.aggiorna(job) { $0.rinnoviConsecutivi = consecutivi } }

        switch decisione {
        case .inviato:
            let ms = Int64(max(0, ora.timeIntervalSince(rt.inizio ?? ora.addingTimeInterval(-TimeInterval(risposta.durataSecondi)))) * 1000)
            terminaInviato(voce, esito: .put, ms: ms)
        case .fallito(let codice):
            termina(voce, evento: .fallito(codice), statoHTTP: risposta.statoHTTP)
        case .riprova(let attesa, let codice, let statoHTTP):
            transitorio(voce, attesa: attesa, codice: codice, statoHTTP: statoHTTP, byteInviati: byteInviati)
        case .rinnova(let errore, let statoHTTP, let oltreScadenza):
            if let durata = oltreScadenza {
                registro.registraPutOltreScadenza(job: job, utente: voce.utenteId, durataSecondi: durata, statoHTTP: statoHTTP)
            }
            // L'URL rifiutato non si rispedisce: si azzera la scadenza, così ogni giro da qui comincia dal rinnovo (anche dopo un transitorio).
            coda.aggiorna(job) { $0.urlScadeIl = nil }
            rt.erroreStorage = errore
            proseguiIlCiclo(job, causa: .putRifiutata, partenza: ora)
        case .ricreaAllaRiapertura:
            // L'utente ha chiuso l'app dal multitasking: iOS ha annullato il trasferimento e nessun codice è girato. Si ricrea alla riapertura.
            rt.byteDellaChiusura = byteInviati
            if inPrimoPiano {
                registro.registraRipresoDopoChiusura(job: job, utente: voce.utenteId, byteInviati: byteInviati)
                avanza(job)
            } else {
                _ = applicaStato(.inAttesa(.chiusuraForzata), a: job)
                emetti(job)
            }
        }
    }

    /// Un transitorio (rete, 5xx, 408/429): `in-attesa`, il log (diradato: ai tentativi 1, 2, 4, 8, …), la notifica se si è in background per la
    /// rete, e il prossimo task già creato col suo `earliestBeginDate`.
    private func transitorio(_ voce: KVVoceCoda, attesa: TimeInterval, codice: KVCodiceCaricamento, statoHTTP: Int, byteInviati: Int64) {
        attendi(voce, secondi: attesa, codice: codice)
        registro.registraRitento(job: voce.jobId, utente: voce.utenteId, codice: codice, statoHTTP: statoHTTP, tentativo: voce.tentativi,
                                 attesaSecondi: Int(attesa.rounded()), byteInviati: byteInviati)
        if codice == .rete { mostraLaNotificaDiAttesa() } // si guarda da sé: con l'app in primo piano non mostra niente
        avanza(voce.jobId)
    }

    /// La voce aspetta `secondi`: `in-attesa` col suo codice, `prossimoTentativoIl`, e un timer di sicurezza (il task con `earliestBeginDate` lo
    /// crea `avanza`; il timer serve se non si riesce, e perché il processo, se è vivo, non dorma).
    private func attendi(_ voce: KVVoceCoda, secondi: TimeInterval, codice: KVCodiceCaricamento) {
        let job = voce.jobId
        let ora = orologio()
        _ = applicaStato(.inAttesa(codice), a: job)
        coda.aggiorna(job) { $0.prossimoTentativoIl = ora.addingTimeInterval(secondi) }
        emetti(job)
        programmaRisveglio(job, dopo: secondi)
        aggiornaLaNotifica()
    }

    private func programmaRisveglio(_ job: UUID, dopo secondi: TimeInterval) {
        let rt = runtimeDi(job)
        rt.annullaRisveglio?()
        rt.annullaRisveglio = pianificaSulMotore(dopo: secondi) { [weak self] in
            self?.runtime[job]?.annullaRisveglio = nil
            self?.avanza(job)
        }
    }

    // MARK: - Il rinnovo

    private func eseguiRinnovo(_ job: UUID, causa: KVCausaRinnovo, segreti segretiVoce: KVSegretiVoce, partenza: Date) {
        guard let voce = coda.voce(job), !voce.stato.eTerminale else { return }
        guard let url = KVPoliticaCaricamento.indirizzoAmmesso(segretiVoce.urlRinnovo, uso: .rinnovo, ambiente: ambiente) else {
            termina(voce, evento: .fallito(.interno), statoHTTP: nil)
            return
        }
        let rt = runtimeDi(job)
        rinnoviAvviati += 1
        let numero = rinnoviAvviati
        rt.rinnovoInCorso = numero
        inizioOperazione()
        rinnovo.rinnova(url: url, token: segretiVoce.token) { [weak self] esito in
            self?.inCoda {
                guard let self = self else { return }
                self.rinnovoRisposto(job, numero: numero, usati: segretiVoce, causa: causa, partenza: partenza, esito: esito)
                self.fineOperazione()
            }
        }
    }

    private func rinnovoRisposto(_ job: UUID, numero: Int, usati: KVSegretiVoce, causa: KVCausaRinnovo, partenza: Date, esito: KVEsitoRinnovoRete) {
        // La risposta di un rinnovo che non è più quello della voce (la voce è stata chiusa, o chiusa e rimandata) si butta senza toccare niente.
        guard let rt = runtime[job], rt.rinnovoInCorso == numero else { return }
        rt.rinnovoInCorso = nil
        guard coda.pronta, let voce = coda.voce(job), !voce.stato.eTerminale else { return }
        let ora = orologio()
        let risposta = KVPoliticaCaricamento.leggiRispostaRinnovo(statoHTTP: esito.statoHTTP, corpo: esito.corpo, retryAfter: esito.retryAfter,
                                                                   adesso: ora, ambiente: ambiente)
        // La rotazione del token: un'apertura ripetuta ha messo nel Portachiavi un token più recente di quello con cui si è chiesto.
        let attuali = segreti.leggi(job)
        var tokenPiuRecente = false
        if case .presenti(let trovati) = attuali, trovati.token != usati.token { tokenPiuRecente = true }
        let contesto = KVContestoRinnovo(causa: causa, rinnoviConsecutivi: voce.rinnoviConsecutivi, tentativo: voce.tentativi,
                                         tokenPiuRecenteDisponibile: tokenPiuRecente, adesso: ora, casuale: casuale())
        let decisione = KVPoliticaCaricamento.decidiRinnovo(risposta, contesto: contesto)

        // Un rinnovo che ha consegnato un URL si conta, anche se è quello che fa scattare `RINNOVO_CICLICO`.
        var consegnato = false
        if case .daCaricare = risposta.esito { consegnato = true }
        let rinnoviDopo = voce.rinnovi + (consegnato ? 1 : 0)
        logDelRinnovo(voce, risposta: risposta, causa: causa, rinnovi: rinnoviDopo, errore: causa == .putRifiutata ? rt.erroreStorage : nil)

        switch decisione {
        case .nuovaPut(let url, let contentType, let urlScadeIl, let tokenScadeIl, let consecutivi):
            // L'URL nuovo nel Portachiavi PRIMA di toccare la voce, sopra il token più recente se un'apertura ripetuta lo ha ruotato. Se non si salva
            // il task parte lo stesso con quello in memoria: alla prossima riapertura si troverà l'URL vecchio e si rinnoverà ancora.
            var corrente = usati
            if case .presenti(let trovati) = attuali { corrente = trovati }
            corrente.urlPut = url.relativeString
            corrente.contentType = contentType
            _ = segreti.salva(corrente, per: job)
            coda.aggiorna(job) { v in
                v.rinnovi = rinnoviDopo
                v.rinnoviConsecutivi = consecutivi
                v.urlScadeIl = urlScadeIl
                v.tokenScadeIl = tokenScadeIl
            }
            rt.erroreStorage = nil
            creaIlTask(job, segreti: corrente, partenza: partenza)
        case .inviato:
            terminaInviato(voce, esito: .giaArrivato, ms: Int64(max(0, ora.timeIntervalSince(rt.inizio ?? ora)) * 1000))
        case .annullato(let codice):
            termina(voce, evento: .annullato(codice), statoHTTP: nil)
        case .fallito(let codice):
            if consegnato { coda.aggiorna(job) { $0.rinnovi = rinnoviDopo } }
            termina(voce, evento: .fallito(codice), statoHTTP: risposta.statoHTTP)
        case .riprovaConTokenPiuRecente:
            if case .presenti(let ultimo) = attuali {
                eseguiRinnovo(job, causa: causa, segreti: ultimo, partenza: partenza)
            } else {
                termina(voce, evento: .fallito(.tokenNonValido), statoHTTP: risposta.statoHTTP)
            }
        case .attendi(let secondi):
            // La causa si porta nel codice: dopo una PUT rifiutata la voce aspetta come `FIRMA_RIFIUTATA`, e il giro dopo sa che il rinnovo conta.
            let codice: KVCodiceCaricamento
            if causa == .putRifiutata {
                codice = .firmaRifiutata
            } else if case .transitorio(.rete) = risposta.esito {
                codice = .rete
            } else {
                codice = .server
            }
            attendi(voce, secondi: secondi, codice: codice)
        }
    }

    /// `video-nativo-rinnovo`: ogni rinnovo, ma i ritentativi si diradano come quelli della PUT (§8.1): durante un guasto lungo ogni ripresa dopo
    /// più di 10 minuti rinnova, e il registro non deve riempirsi. Si scrive sempre ciò che non si ripete da solo: `negato`, `arrivato`, `annullato`,
    /// e il rinnovo che segue una PUT rifiutata (porta il nome d'errore).
    private func logDelRinnovo(_ voce: KVVoceCoda, risposta: KVRispostaRinnovo, causa: KVCausaRinnovo, rinnovi: Int, errore: KVErroreStorage?) {
        let ripetibile: Bool
        switch risposta.esitoLog {
        case .rete, .server, .tetto: ripetibile = true
        case .daCaricare: ripetibile = causa == .urlVecchio
        case .negato, .arrivato, .annullato: ripetibile = false
        }
        if ripetibile && !KVPoliticaCaricamento.tentativoDaLoggare(voce.tentativi) { return }
        registro.registraRinnovo(job: voce.jobId, utente: voce.utenteId, esito: risposta.esitoLog, statoHTTP: risposta.statoHTTP, rinnovi: rinnovi,
                                 errorCode: errore.map { KVErrorCode.storage($0) })
    }

    // MARK: - Gli stati terminali

    /// Applica un passo della tabella; `nil` se la coda non lo ammette.
    @discardableResult
    private func applicaStato(_ evento: KVEventoStato, a job: UUID) -> KVVoceCoda? {
        switch coda.applica(evento, a: job) {
        case .applicata(_, let voce, _, _):
            return voce
        case .voceAssente, .nonPronta, .nonAmmessa:
            diagnostica.error("transizione non applicata")
            return nil
        }
    }

    private func terminaInviato(_ voce: KVVoceCoda, esito: KVEsitoInvio, ms: Int64) {
        let job = voce.jobId
        let rt = runtimeDi(job)
        rt.annullaRisveglio?()
        rt.annullaRisveglio = nil
        rt.rinnovoInCorso = nil
        if let id = rt.taskCorrente {
            rt.ignorati.insert(id)
            ottieniTrasporto().annulla(task: id)
            rt.taskCorrente = nil
        }
        guard case .applicata(_, let chiusa, _, let persistita) = coda.applica(.inviato, a: job) else {
            diagnostica.error("stato inviato non applicato")
            return
        }
        // I segreti si cancellano DOPO aver scritto lo stato terminale (la copia l'ha già fatto la coda con la stessa regola).
        if persistita { segreti.elimina(job) }
        registro.registraInviato(job: job, utente: chiusa.utenteId, byte: chiusa.byte, ms: ms, tentativi: chiusa.tentativi, rinnovi: chiusa.rinnovi,
                                 esito: esito, inBackground: !inPrimoPiano)
        dopoUnaChiusura(job)
    }

    /// `fallito` o `annullato`: ferma il task, scrive lo stato, cancella copia e segreti (in questo ordine), scrive il log.
    private func termina(_ voce: KVVoceCoda, evento: KVEventoStato, statoHTTP: Int?) {
        let job = voce.jobId
        let rt = runtimeDi(job)
        rt.annullaRisveglio?()
        rt.annullaRisveglio = nil
        rt.rinnovoInCorso = nil
        if let id = rt.taskCorrente {
            rt.ignorati.insert(id)
            ottieniTrasporto().annulla(task: id)
            rt.taskCorrente = nil
        }
        guard case .applicata(_, let chiusa, _, let persistita) = coda.applica(evento, a: job) else {
            diagnostica.error("stato terminale non applicato")
            return
        }
        if persistita { segreti.elimina(job) }
        switch evento {
        case .fallito(let codice):
            registro.registraFallito(job: job, utente: chiusa.utenteId, codice: codice, operazione: KVPoliticaCaricamento.operazione(per: codice),
                                     tentativi: chiusa.tentativi, rinnovi: chiusa.rinnovi, statoHTTP: statoHTTP)
        case .annullato(let codice):
            registro.registraAnnullato(job: job, utente: chiusa.utenteId, da: codice == .annullatoDalServer ? .server : .utente,
                                       byteInviati: rt.byteInviati)
        case .accodato, .trasferimentoAvviato, .inAttesa, .inPausa, .ripreso, .inviato:
            break
        }
        dopoUnaChiusura(job)
    }

    private func dopoUnaChiusura(_ job: UUID) {
        emetti(job)
        aggiornaLaNotifica()
        svuotaRegistro()
    }

    // MARK: - La rete

    private func reteCambiata(_ disponibile: Bool) {
        reteDisponibile = disponibile
        guard avviato, coda.pronta else { return }
        let vive = coda.tutte().filter { !$0.stato.eTerminale }
        if !disponibile {
            for voce in vive where voce.stato == .inInvio {
                _ = applicaStato(.inAttesa(.rete), a: voce.jobId)
                emetti(voce.jobId)
            }
        } else {
            for voce in vive where voce.stato == .inAttesa && voce.codice == .rete {
                if runtimeDi(voce.jobId).taskCorrente != nil {
                    _ = applicaStato(.ripreso, a: voce.jobId)
                    emetti(voce.jobId)
                } else {
                    ripartiOra(voce)
                }
            }
        }
        aggiornaLaNotifica()
    }

    // MARK: - La notifica d'attesa

    private func esistonoVociInInvioOInAttesa() -> Bool {
        return coda.tutte().contains { $0.stato == .inInvio || $0.stato == .inAttesa }
    }

    /// L'invio è fermo per la rete: o la rete manca e c'è qualcosa da inviare, o c'è una voce che ha aspettato per un errore di rete.
    private func fermoPerLaRete() -> Bool {
        let vive = coda.tutte().filter { !$0.stato.eTerminale }
        if vive.contains(where: { $0.stato == .inAttesa && $0.codice == .rete }) { return true }
        return reteDisponibile == false && vive.contains { $0.stato == .inInvio || $0.stato == .inAttesa }
    }

    private func mostraLaNotificaDiAttesa() {
        guard !inPrimoPiano, !notificaVisibile else { return }
        guard let prima = coda.tutte().first(where: { $0.stato == .inInvio || $0.stato == .inAttesa }) else { return }
        let testi = coda.testi
        notificaVisibile = true
        inizioOperazione()
        notificatore.mostraAttesa(titolo: testi.titolo, corpo: testi.attesaRete) { [weak self] esito in
            self?.inCoda {
                guard let self = self else { return }
                if !esito.programmata { self.notificaVisibile = false }
                self.registro.registraAttesaRete(job: prima.jobId, utente: prima.utenteId, notifica: esito.programmata, autorizzata: esito.autorizzata)
                if !esito.autorizzata { self.registro.registraNotificaNonAutorizzata() }
                self.fineOperazione()
            }
        }
    }

    /// Si toglie a invio ripreso o concluso (e all'apertura dell'app, in `riprendiInPrimoPiano`).
    private func aggiornaLaNotifica() {
        guard notificaVisibile, coda.pronta, !fermoPerLaRete() else { return }
        notificatore.rimuoviAttesa()
        notificaVisibile = false
    }

    // MARK: - Il registro

    /// Spedisce un lotto del registro. `svuota` ne manda uno solo e, se è troppo presto, risponde senza riprogrammarsi: lo si riprogramma qui.
    private func svuotaRegistro() {
        inizioOperazione()
        let esito = registro.svuota { [weak self] in
            self?.inCoda { self?.fineOperazione() }
        }
        if case .troppoPresto(let attesa) = esito {
            riprogrammaLoSvuotamento(dopo: attesa + 0.1)
        }
    }

    /// Un solo richiamo differito alla volta. Allo scadere si richiama `svuotaRegistro`: se nel frattempo non c'è più niente da spedire `svuota` risponde
    /// `.nulla` senza toccare la rete (e senza un controllo qui, che direbbe due volte la stessa cosa).
    private func riprogrammaLoSvuotamento(dopo secondi: TimeInterval) {
        guard annullaSvuotamentoDifferito == nil else { return }
        annullaSvuotamentoDifferito = pianificaSulMotore(dopo: secondi) { [weak self] in
            guard let self = self else { return }
            self.annullaSvuotamentoDifferito = nil
            self.svuotaRegistro()
        }
    }

    // MARK: - Verso il JavaScript

    /// Dice al plugin che una voce è cambiata (stato o avanzamento).
    private func emetti(_ job: UUID) {
        guard let voce = coda.voce(job), let ascolta = alCambiamento else { return }
        ascolta(voce, runtime[job]?.byteInviati ?? 0)
    }
}

// MARK: - Le cose vere

/// Il lavoro in background di UIKit (`beginBackgroundTask`). `UIApplication` si tocca solo sul thread principale: da un altro thread si rientra col
/// `main.async`, e il gettone si assegna subito; se `termina` arriva prima che il lavoro sia davvero iniziato, il lavoro non comincia.
final class KVLavoroInBackgroundUIKit: KVLavoroInBackground {
    private let serratura = NSLock()
    private var prossimo = 1
    private var attivi: [Int: UIBackgroundTaskIdentifier] = [:]
    private var terminatiPrima = Set<Int>()

    func inizia(alScadere: @escaping () -> Void) -> Int {
        serratura.lock()
        let gettone = prossimo
        prossimo += 1
        serratura.unlock()
        let avvio = { [weak self] in
            guard let self = self else { return }
            self.serratura.lock()
            let giaTerminato = self.terminatiPrima.remove(gettone) != nil
            self.serratura.unlock()
            if giaTerminato { return }
            let identificativo = UIApplication.shared.beginBackgroundTask(withName: "it.kidville.caricamenti") { [weak self] in
                alScadere()
                self?.termina(gettone)
            }
            self.serratura.lock()
            self.attivi[gettone] = identificativo
            self.serratura.unlock()
        }
        if Thread.isMainThread { avvio() } else { DispatchQueue.main.async(execute: avvio) }
        return gettone
    }

    func termina(_ gettone: Int) {
        serratura.lock()
        let identificativo = attivi.removeValue(forKey: gettone)
        if identificativo == nil { terminatiPrima.insert(gettone) }
        serratura.unlock()
        guard let identificativo = identificativo else { return }
        if Thread.isMainThread {
            UIApplication.shared.endBackgroundTask(identificativo)
        } else {
            DispatchQueue.main.async { UIApplication.shared.endBackgroundTask(identificativo) }
        }
    }
}

/// Il monitor di rete di sistema. «Non disponibile» è solo `unsatisfied`: un percorso che richiede una connessione (la radio cellulare da
/// accendere) non è un'assenza.
final class KVMonitorReteNW: KVMonitorRete {
    private let monitor = NWPathMonitor()
    private let coda = DispatchQueue(label: "it.kidville.caricamenti.rete")
    private let serratura = NSLock()
    private var ultimo: Bool?
    private var partito = false

    var cambiamento: ((Bool) -> Void)?

    var disponibile: Bool? {
        serratura.lock(); defer { serratura.unlock() }
        return ultimo
    }

    func avvia() {
        serratura.lock()
        if partito { serratura.unlock(); return }
        partito = true
        serratura.unlock()
        monitor.pathUpdateHandler = { [weak self] percorso in
            guard let self = self else { return }
            let raggiungibile = percorso.status != .unsatisfied
            self.serratura.lock()
            let cambiato = self.ultimo != raggiungibile
            self.ultimo = raggiungibile
            self.serratura.unlock()
            if cambiato { self.cambiamento?(raggiungibile) }
        }
        monitor.start(queue: coda)
    }
}

/// Il trasporto vero: una sessione `URLSession` in background, una `uploadTask(with:fromFile:)` per voce.
///
/// La CONFIGURAZIONE è quella di §5.2: identificativo fisso, `sessionSendsLaunchEvents` (il sistema risveglia l'app a trasferimento finito),
/// `isDiscretionary = false`, cellulare/rete costosa/dati ridotti ammessi (decisione del titolare: «qualunque rete»), 24 ore di tempo
/// totale, due connessioni per host, nessun cookie, nessuna cache. Il task manda SOLO `content-type` (le intestazioni le decide il server, §2.2);
/// `taskDescription` è il `jobId`; il corpo della risposta si raccoglie in `didReceive` fino a 4 KB (una PUT rifiutata NON porta `error`: lo
/// stato HTTP si legge in `didCompleteWithError`). I reindirizzamenti NON si seguono: un 307 porterebbe il video altrove.
final class KVTrasportoPutURLSession: NSObject, KVTrasportoPut, URLSessionDataDelegate, URLSessionTaskDelegate {

    static let identificativo = KVMotoreCaricamenti.identificativoSessione
    /// L'avanzamento si inoltra al motore al più ogni quarto di secondo per task: `didSendBodyData` scatta ad ogni blocco.
    static let intervalloAvanzamento: TimeInterval = 0.25

    weak var delegato: KVTrasportoPutDelegato?

    /// L'orologio con cui si dosa l'avanzamento: nell'app è `Date()`, nella prova lo si pilota perché il quarto di secondo non dipenda dalla velocità
    /// della macchina.
    var orologio: () -> Date = { Date() }

    private let serratura = NSLock()
    private let configurazioneIniettata: URLSessionConfiguration?
    private var sessione: URLSession?
    private var corpi: [Int: Data] = [:]
    private var durate: [Int: TimeInterval] = [:]
    private var ultimiAvanzamenti: [Int: Date] = [:]

    /// `configurazione` si passa solo nella prova (una sessione NON in background con un protocollo finto: una sessione in background non ammette
    /// protocolli propri e non gira fuori da un'app); nell'app è sempre `nil` e vale `configurazione()`.
    init(configurazione: URLSessionConfiguration? = nil) {
        self.configurazioneIniettata = configurazione
        super.init()
    }

    /// La configurazione della sessione. Un metodo a parte perché l'harness possa leggerla senza creare la sessione.
    static func configurazione() -> URLSessionConfiguration {
        let configurazione = URLSessionConfiguration.background(withIdentifier: identificativo)
        configurazione.sessionSendsLaunchEvents = true
        configurazione.isDiscretionary = false
        configurazione.allowsCellularAccess = true
        configurazione.allowsExpensiveNetworkAccess = true
        configurazione.allowsConstrainedNetworkAccess = true
        configurazione.timeoutIntervalForResource = 24 * 3600
        configurazione.httpMaximumConnectionsPerHost = 2
        configurazione.httpShouldSetCookies = false
        configurazione.httpCookieAcceptPolicy = .never
        configurazione.httpCookieStorage = nil
        configurazione.urlCache = nil
        configurazione.requestCachePolicy = .reloadIgnoringLocalCacheData
        return configurazione
    }

    private func sessioneAttiva() -> URLSession {
        serratura.lock(); defer { serratura.unlock() }
        if let esistente = sessione { return esistente }
        // Una coda di delegato SERIALE: i callback di un task arrivano nell'ordine in cui il sistema li consegna.
        let codaDelegato = OperationQueue()
        codaDelegato.name = "it.kidville.caricamenti.sessione"
        codaDelegato.maxConcurrentOperationCount = 1
        let nuova = URLSession(configuration: configurazioneIniettata ?? Self.configurazione(), delegate: self, delegateQueue: codaDelegato)
        sessione = nuova
        return nuova
    }

    func taskVivi(completamento: @escaping ([KVTaskVivo]) -> Void) {
        sessioneAttiva().getAllTasks { tasks in completamento(Self.vivi(tra: tasks)) }
    }

    /// Dei task che la sessione ha ancora, quelli nostri e in corso: con la `taskDescription` che è un `jobId`, in volo o sospesi (un task finito o in
    /// annullamento non è «vivo»), coi byte che ha già spedito. Un metodo a parte perché la prova lo alimenti con task finti.
    static func vivi(tra tasks: [URLSessionTask]) -> [KVTaskVivo] {
        return tasks.compactMap { task in
            guard task.state == .running || task.state == .suspended,
                  let descrizione = task.taskDescription, let job = UUID(uuidString: descrizione) else { return nil }
            return KVTaskVivo(job: job, identificativo: task.taskIdentifier, byteInviati: task.countOfBytesSent)
        }
    }

    func avvia(_ richiesta: KVRichiestaPut) -> Int? {
        var chiamata = URLRequest(url: richiesta.url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 60)
        chiamata.httpMethod = "PUT"
        chiamata.setValue(richiesta.contentType, forHTTPHeaderField: "content-type")
        let task = sessioneAttiva().uploadTask(with: chiamata, fromFile: richiesta.file)
        task.taskDescription = KVPoliticaCaricamento.uuidPerIlPonte(richiesta.job)
        task.countOfBytesClientExpectsToSend = richiesta.byte + 1024
        task.countOfBytesClientExpectsToReceive = Int64(KVPoliticaCaricamento.byteCorpoMassimo)
        if let nonPrima = richiesta.nonPrima { task.earliestBeginDate = nonPrima }
        task.resume()
        return task.taskIdentifier
    }

    func annulla(task identificativo: Int) {
        sessioneAttiva().getAllTasks { tasks in
            tasks.first(where: { $0.taskIdentifier == identificativo })?.cancel()
        }
    }

    // MARK: URLSessionDataDelegate / URLSessionTaskDelegate

    private func jobDi(_ task: URLSessionTask) -> UUID? {
        return task.taskDescription.flatMap { UUID(uuidString: $0) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64,
                    totalBytesExpectedToSend: Int64) {
        guard let job = jobDi(task) else { return }
        let ora = orologio()
        serratura.lock()
        let ultimo = ultimiAvanzamenti[task.taskIdentifier] ?? .distantPast
        let spedisci = ora.timeIntervalSince(ultimo) >= Self.intervalloAvanzamento || totalBytesSent >= totalBytesExpectedToSend
        if spedisci { ultimiAvanzamenti[task.taskIdentifier] = ora }
        serratura.unlock()
        if spedisci { delegato?.trasporto(avanzamentoDi: job, task: task.taskIdentifier, byteInviati: totalBytesSent) }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        serratura.lock()
        var corpo = corpi[dataTask.taskIdentifier] ?? Data()
        if corpo.count < KVPoliticaCaricamento.byteCorpoMassimo {
            corpo.append(data.prefix(KVPoliticaCaricamento.byteCorpoMassimo - corpo.count))
            corpi[dataTask.taskIdentifier] = corpo
        }
        serratura.unlock()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didFinishCollecting metrics: URLSessionTaskMetrics) {
        serratura.lock()
        durate[task.taskIdentifier] = metrics.taskInterval.duration
        serratura.unlock()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let identificativo = task.taskIdentifier
        serratura.lock()
        let corpo = corpi.removeValue(forKey: identificativo) ?? Data()
        let durata = durate.removeValue(forKey: identificativo) ?? 0
        ultimiAvanzamenti.removeValue(forKey: identificativo)
        serratura.unlock()
        guard let job = jobDi(task) else { return }
        let http = task.response as? HTTPURLResponse
        let nsErrore = error as NSError?
        let risposta = KVRispostaPut(
            statoHTTP: http?.statusCode,
            corpo: corpo,
            retryAfter: http?.value(forHTTPHeaderField: "Retry-After"),
            errore: error.map { KVErroreSistema($0) },
            motivoAnnullamento: nsErrore?.userInfo[NSURLErrorBackgroundTaskCancelledReasonKey] as? Int,
            durataSecondi: Int(durata.rounded()),
            trasferimentoCompleto: task.countOfBytesExpectedToSend > 0 && task.countOfBytesSent >= task.countOfBytesExpectedToSend
        )
        delegato?.trasporto(terminatoPer: job, task: identificativo, risposta: risposta, byteInviati: task.countOfBytesSent)
    }

    /// Nessun reindirizzamento: la PUT è su un URL firmato per QUEL percorso, e un 3xx lo porterebbe altrove con tutto il video.
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        delegato?.trasportoHaConsegnatoTuttiGliEventi()
    }

    func urlSession(_ session: URLSession, didBecomeInvalidWithError error: Error?) {
        serratura.lock()
        sessione = nil
        serratura.unlock()
        delegato?.trasportoInvalidato()
    }
}
