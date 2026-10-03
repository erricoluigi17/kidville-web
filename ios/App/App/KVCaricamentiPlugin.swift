import Foundation
#if canImport(Capacitor)
import Capacitor
import UIKit
#endif

// ═══════════════════════════════════════════════════════════════════════════════════════════
//  KVCaricamentiPlugin — la facciata del plugin `KidvilleCaricamenti` (spec §4.1-4.3, §5.8, compito I3)
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// Che cosa è: il confine fra il JavaScript e il nativo dei caricamenti. NON fa niente di suo: traduce. Ogni metodo legge i parametri dal ponte
// (e rifiuta con un `code` dell'elenco chiuso se non tornano), chiama il pezzo che sa fare la cosa e restituisce la risposta nella forma che gli
// schemi zod di S1 (`src/lib/native/caricamenti-nativi-tipi.ts`) rileggono. Il lavoro vero sta altrove, ed è indipendente dal ponte:
//   · `KVMotoreCaricamenti.condiviso` — la coda e la sessione in background (`accodaVideo`, `elenco`, `annulla`, `dimentica`, e i suoi eventi);
//   · `KVSelettoreMedia` / `KVPreparazioneMedia` — il selettore di sistema e la preparazione degli elementi (`scegliMedia`, `annullaScelta`,
//     `leggiFoto`, `scartaScelti`, `creaElementoDiProva`).
//
// ─── DUE PARTI IN UN FILE ────────────────────────────────────────────────────────────────────
//  1. `KVPonteCaricamenti` e i suoi tipi — SENZA Capacitor: la LETTURA dei parametri (da un dizionario, com'è arrivato dal JavaScript), la
//     DECISIONE di `accodaVideo` (l'elemento è quello scelto? c'è già in coda?) e il suo RISULTATO (la richiesta per il motore, il codice di
//     rifiuto). È la parte dove si sbaglia: una pagina compromessa o un difetto del JavaScript passano da qui. L'harness la compila e la prova
//     con dizionari veri (`#if canImport(Capacitor)` taglia fuori la seconda parte, che lì non può compilare).
//  2. `KVCaricamentiPlugin` — la classe di Capacitor: `jsName`, `pluginMethods`, un metodo `@objc` per ognuno, le code, gli eventi. Solo colla.
//
// ─── NOME E METODI ───────────────────────────────────────────────────────────────────────────
// `jsName = "KidvilleCaricamenti"` e i NOVE metodi di `pluginMethods` sono ESATTAMENTE `NOME_PLUGIN_CARICAMENTI` e `METODI_PLUGIN_CARICAMENTI`
// di `caricamenti-nativi-tipi.ts` (li pretendono il lock `caricamenti-nativi-agganciati` e l'harness). `creaElementoDiProva` esiste solo nelle
// build Debug (`#if DEBUG`, sia il metodo sia la riga che lo elenca) e non sta in quell'elenco: serve al collaudo del motore (C1) e nelle build
// di Release non c'è.
//
// ─── REGISTRAZIONE ───────────────────────────────────────────────────────────────────────────
// `KVBridgeViewController.capacitorDidLoad()`, subito dopo `super.capacitorDidLoad()` e PRIMA dei `guard` che possono uscire: il filtro delle
// navigazioni non deve poter spegnere il plugin. Un plugin locale non richiede `npx cap sync` (che qui è vietato: imbianca l'app).
//
// ─── I RIFIUTI ───────────────────────────────────────────────────────────────────────────────
// Un rifiuto porta un `code` dei sette di `CODICI_RIFIUTO_PONTE` e un messaggio COSTANTE: il JavaScript legge il codice, mai il messaggio, e un
// messaggio che citasse un percorso o un nome finirebbe in un log. Mai il testo di un'eccezione.
//
// ─── I FILI ──────────────────────────────────────────────────────────────────────────────────
// Il ponte chiama ogni metodo sulla sua coda seriale: un lavoro lungo lì dentro fermerebbe anche gli altri plugin. Quindi i metodi che toccano
// il disco o il motore rispondono da una coda NOSTRA; la preparazione di un elemento di prova (che scrive fino a 2 GB) da una a parte; e gli
// eventi verso il JavaScript escono dal thread principale, in ordine.

// MARK: - I rifiuti del ponte

/// I sette `code` con cui il ponte rifiuta una chiamata (`CODICI_RIFIUTO_PONTE`), ognuno col suo messaggio costante.
enum KVRifiutoPonte: String, CaseIterable, Equatable {
    case giaInCorso = "GIA_IN_CORSO"
    case selettoreNonDisponibile = "SELETTORE_NON_DISPONIBILE"
    case parametriNonValidi = "PARAMETRI_NON_VALIDI"
    case elementoAssente = "ELEMENTO_ASSENTE"
    case elementoDiverso = "ELEMENTO_DIVERSO"
    case hostNonAmmesso = "HOST_NON_AMMESSO"
    case interno = "INTERNO"

    /// Un messaggio costante per ogni codice: nessun percorso, nessun nome, nessun testo di eccezione.
    var messaggio: String {
        switch self {
        case .giaInCorso: return "Una scelta è già in corso"
        case .selettoreNonDisponibile: return "Il selettore non è disponibile"
        case .parametriNonValidi: return "Parametri non validi"
        case .elementoAssente: return "Elemento non trovato"
        case .elementoDiverso: return "L'elemento non corrisponde a quello scelto"
        case .hostNonAmmesso: return "Indirizzo non ammesso"
        case .interno: return "Errore interno"
        }
    }
}

extension KVRifiutoAccodamento {
    /// Il rifiuto del motore (`accoda`) nel codice del ponte. Uno a uno: il motore ha già scelto la sua ragione.
    var comeRifiutoDelPonte: KVRifiutoPonte {
        switch self {
        case .elementoAssente: return .elementoAssente
        case .elementoDiverso: return .elementoDiverso
        case .hostNonAmmesso: return .hostNonAmmesso
        case .parametriNonValidi: return .parametriNonValidi
        case .interno: return .interno
        }
    }
}

// MARK: - I parametri di accodaVideo

/// I parametri di `accodaVideo`, già nei tipi giusti. Gli indirizzi e le scadenze restano TESTO: li controlla il motore (la politica degli host, §9),
/// così il controllo sta in un punto solo. `testi` può mancare o essere incompleto: vale il ripiego italiano.
struct KVParametriAccodamento: Equatable {
    var idElemento: String
    var sha256: String
    var byteAttesi: Int64
    var jobId: UUID
    var intentId: UUID
    var utenteId: UUID
    var scuolaId: UUID
    var urlPut: String
    var contentType: String
    var scadenzaUrl: String?
    var urlRinnovo: String
    var token: String
    var scadenzaToken: String
    var urlRegistro: String
    var testi: KVTestiNotifiche
}

/// Che cosa fare di un `accodaVideo`, dopo aver confrontato ciò che il JavaScript dichiara con ciò che questa sessione dell'app sa.
enum KVDecisioneAccodamento: Equatable {
    /// Si passa al motore. `sorgente` è il preparato da spostare in `file/`, o `nil` per l'apertura ripetuta di un video che è già in coda.
    case procedi(sorgente: URL?)
    case rifiuta(KVRifiutoPonte)
}

// MARK: - Il ponte, senza Capacitor

enum KVPonteCaricamenti {

    /// La versione del protocollo fra JavaScript e nativo (`PROTOCOLLO_CARICAMENTI`): si alza solo se una forma cambia in modo incompatibile.
    static let protocollo = 1

    /// Quanti id al massimo in una chiamata che ne porta un elenco: una pagina non ne ha mai di più (50 elementi per scelta), e un elenco enorme
    /// non è un uso, è un guasto.
    static let massimoIdPerChiamata = 1000

    // MARK: Valori elementari

    /// Un intero (non un booleano, non una frazione) fra i valori di una chiamata. I numeri arrivano dal ponte come `NSNumber`; un `true` è un
    /// `NSNumber` anch'esso, e qui non vale 1.
    static func intero(_ valore: Any?) -> Int64? {
        guard let numero = valore as? NSNumber, CFGetTypeID(numero) != CFBooleanGetTypeID() else { return nil }
        let decimale = numero.doubleValue
        guard decimale.isFinite, decimale == decimale.rounded(), abs(decimale) <= 9_007_199_254_740_991 else { return nil }
        return numero.int64Value
    }

    static func decimale(_ valore: Any?) -> Double? {
        guard let numero = valore as? NSNumber, CFGetTypeID(numero) != CFBooleanGetTypeID() else { return nil }
        let d = numero.doubleValue
        return d.isFinite ? d : nil
    }

    /// Un elenco di stringhe, o `nil` se non è un elenco o anche un solo elemento non è una stringa.
    static func stringhe(_ valori: Any?) -> [String]? {
        guard let elenco = valori as? [Any] else { return nil }
        var testi: [String] = []
        for valore in elenco {
            guard let testo = valore as? String else { return nil }
            testi.append(testo)
        }
        return testi
    }

    /// Un uuid scritto come testo (maiuscolo o minuscolo: lo stesso job).
    static func uuid(_ valore: Any?) -> UUID? {
        guard let testo = valore as? String else { return nil }
        return UUID(uuidString: testo)
    }

    /// Un elenco di uuid (`dimentica`): se anche uno solo non lo è, `nil`; oltre `massimoIdPerChiamata` voci, `nil`.
    static func elencoDiUuid(_ valori: Any?) -> [UUID]? {
        guard let testi = stringhe(valori), testi.count <= massimoIdPerChiamata else { return nil }
        var uuid: [UUID] = []
        for testo in testi {
            guard let u = UUID(uuidString: testo) else { return nil }
            uuid.append(u)
        }
        return uuid
    }

    /// Un elenco di id di elementi (`scartaScelti`): oltre `massimoIdPerChiamata` voci, `nil`. Gli id con la forma sbagliata non si rifiutano qui:
    /// `scarta` li ignora uno per uno (un id sbagliato non deve impedire di togliere gli altri).
    static func elencoDiId(_ valori: Any?) -> [String]? {
        guard let testi = stringhe(valori), testi.count <= massimoIdPerChiamata else { return nil }
        return testi
    }

    // MARK: scegliMedia

    /// Le opzioni di `scegliMedia`. Intervalli sani per ognuna: `massimoElementi` ≥ 1 (PHPicker legge 0 come «senza limite»), la qualità in (0, 1].
    /// I limiti veri (50 elementi, 2 GB, 5 minuti, 1920 px) li decide il JavaScript e il nativo non li riscrive: qui si rifiuta solo ciò che non ha
    /// senso per nessun limite.
    static func leggiOpzioniDiScelta(_ opzioni: [String: Any]) -> KVOpzioniScelta? {
        guard let testoSorgente = opzioni["sorgente"] as? String, let sorgente = KVSorgenteScelta(rawValue: testoSorgente),
              let massimo = intero(opzioni["massimoElementi"]), (1...1000).contains(massimo),
              let lato = intero(opzioni["latoMassimoFoto"]), (1...8192).contains(lato),
              let qualita = decimale(opzioni["qualitaFoto"]), qualita > 0, qualita <= 1,
              let byteMassimi = intero(opzioni["byteMassimiVideo"]), byteMassimi >= 1,
              let durataMassima = intero(opzioni["durataMassimaVideoSecondi"]), (1...86_400).contains(durataMassima) else { return nil }
        return KVOpzioniScelta(sorgente: sorgente, massimoElementi: Int(massimo), latoMassimoFoto: Int(lato), qualitaFoto: qualita,
                               byteMassimiVideo: byteMassimi, durataMassimaVideoSecondi: Int(durataMassima))
    }

    // MARK: accodaVideo

    static func leggiAccodamento(_ opzioni: [String: Any]) -> KVParametriAccodamento? {
        guard let idElemento = opzioni["idElemento"] as? String, KVPoliticaCaricamento.idElementoValido(idElemento),
              let sha256 = opzioni["sha256"] as? String, KVPoliticaCaricamento.sha256Valido(sha256),
              let byteAttesi = intero(opzioni["byteAttesi"]), byteAttesi >= 1,
              let job = uuid(opzioni["jobId"]), let intento = uuid(opzioni["intentId"]),
              let utente = uuid(opzioni["utenteId"]), let scuola = uuid(opzioni["scuolaId"]),
              let caricamento = opzioni["caricamento"] as? [String: Any],
              let urlPut = caricamento["url"] as? String,
              let contentType = caricamento["contentType"] as? String,
              let rinnovo = opzioni["rinnovo"] as? [String: Any],
              let urlRinnovo = rinnovo["url"] as? String,
              let token = rinnovo["token"] as? String,
              let scadenzaToken = rinnovo["scadeIl"] as? String,
              let registro = opzioni["registro"] as? [String: Any],
              let urlRegistro = registro["url"] as? String else { return nil }
        // `scadeIl` dell'URL: una data, oppure `null` («non nota: si rinnova prima di spedire»). Qualunque altra cosa non è una data.
        var scadenzaUrl: String?
        if let valore = caricamento["scadeIl"], !(valore is NSNull) {
            guard let testo = valore as? String else { return nil }
            scadenzaUrl = testo
        }
        var testi = KVTestiNotifiche(titolo: "", invio: "", attesaRete: "", pausa: "")
        if let oggetto = opzioni["testi"] as? [String: Any] {
            testi = KVTestiNotifiche(titolo: oggetto["titolo"] as? String ?? "", invio: oggetto["invio"] as? String ?? "",
                                     attesaRete: oggetto["attesaRete"] as? String ?? "", pausa: oggetto["pausa"] as? String ?? "")
        }
        return KVParametriAccodamento(idElemento: idElemento, sha256: sha256, byteAttesi: byteAttesi, jobId: job, intentId: intento, utenteId: utente,
                                      scuolaId: scuola, urlPut: urlPut, contentType: contentType, scadenzaUrl: scadenzaUrl, urlRinnovo: urlRinnovo,
                                      token: token, scadenzaToken: scadenzaToken, urlRegistro: urlRegistro, testi: testi)
    }

    /// Che cosa fare, dato ciò che il JavaScript dichiara e ciò che questa sessione dell'app sa.
    ///  · il video lo ha preparato questa sessione (`ricordo`): `sha256` e `byteAttesi` devono coincidere COL VIDEO SCELTO, altrimenti
    ///    `ELEMENTO_DIVERSO` (la pagina non può far partire un file diverso da quello che l'insegnante ha scelto); il preparato in `scelti/`
    ///    (`preparato`) va al motore per essere spostato in `file/` — o `nil` se non c'è più, e allora il motore accetta solo un video già in coda;
    ///  · nessun ricordo: va bene SOLO per l'apertura ripetuta di un video che è già in coda con quel `jobId` (viva, non terminale) e dello stesso
    ///    peso: il suo file è già in `file/` e non c'è niente da spostare. Un id che questa sessione non ha preparato non si può confrontare con
    ///    niente, e un file in `scelti/` di cui non si conosce l'impronta non parte (`ELEMENTO_ASSENTE`).
    static func decidiAccodamento(parametri: KVParametriAccodamento, ricordo: KVElementoVideo?, preparato: URL?, voceEsistente: KVVoceCoda?) -> KVDecisioneAccodamento {
        if let ricordo = ricordo {
            guard ricordo.sha256 == parametri.sha256, ricordo.byte == parametri.byteAttesi else { return .rifiuta(.elementoDiverso) }
            return .procedi(sorgente: preparato)
        }
        guard let voce = voceEsistente, !voce.stato.eTerminale else { return .rifiuta(.elementoAssente) }
        guard voce.byte == parametri.byteAttesi else { return .rifiuta(.elementoDiverso) }
        return .procedi(sorgente: nil)
    }

    /// La richiesta per il motore. Il nome, il MIME, l'origine e l'estensione sono quelli del video preparato; senza ricordo (apertura ripetuta)
    /// il motore non ne usa nessuno, e valgono ripieghi. Il `content-type` della PUT è SEMPRE quello che il server ha dichiarato.
    static func richiesta(per parametri: KVParametriAccodamento, ricordo: KVElementoVideo?, sorgente: URL?) -> KVRichiestaAccodamento {
        let mimeDelServer = KVPoliticaCaricamento.contentTypeAmmesso(parametri.contentType) ? parametri.contentType : KVPoliticaCaricamento.mimeDiRipiego
        return KVRichiestaAccodamento(
            jobId: parametri.jobId, intentId: parametri.intentId, utenteId: parametri.utenteId, scuolaId: parametri.scuolaId,
            nome: ricordo?.nome ?? KVPoliticaCaricamento.nomeDiRipiego, mime: ricordo?.mime ?? mimeDelServer,
            origine: ricordo?.origine ?? .galleria, idElemento: parametri.idElemento, sorgente: sorgente,
            estensione: ricordo?.estensione ?? "mp4", byteAttesi: parametri.byteAttesi, urlPut: parametri.urlPut,
            contentType: parametri.contentType, scadenzaUrl: parametri.scadenzaUrl, urlRinnovo: parametri.urlRinnovo,
            token: parametri.token, scadenzaToken: parametri.scadenzaToken, urlRegistro: parametri.urlRegistro, testi: parametri.testi)
    }
}

// MARK: - Il plugin (Capacitor)

#if canImport(Capacitor)

@objc(KVCaricamentiPlugin)
public class KVCaricamentiPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "KVCaricamentiPlugin"
    public let jsName = "KidvilleCaricamenti"
    public let pluginMethods: [CAPPluginMethod] = {
        var metodi: [CAPPluginMethod] = [
            CAPPluginMethod(name: "info", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "scegliMedia", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "annullaScelta", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "leggiFoto", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "scartaScelti", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "accodaVideo", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "elenco", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "annulla", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "dimentica", returnType: CAPPluginReturnPromise),
        ]
        #if DEBUG
        metodi.append(CAPPluginMethod(name: "creaElementoDiProva", returnType: CAPPluginReturnPromise))
        #endif
        return metodi
    }()

    // MARK: Cose che il plugin usa

    private let motore: KVMotoreCaricamenti
    private let preparazione: KVPreparazioneMedia
    private let selettore: KVSelettoreMedia
    private let lavoro = DispatchQueue(label: "it.kidville.caricamenti.plugin", qos: .userInitiated)

    public override init() {
        let motore = KVMotoreCaricamenti.condiviso
        let preparazione = KVPreparazioneMedia(coda: motore.coda, registro: motore.registro)
        self.motore = motore
        self.preparazione = preparazione
        self.selettore = KVSelettoreMedia(coda: motore.coda, preparazione: preparazione, registro: motore.registro)
        super.init()
    }

    /// I cambiamenti di una voce della coda arrivano al JavaScript come evento `caricamento`: stato e avanzamento, nella forma di `CaricamentoNativo`.
    override public func load() {
        motore.alCambiamento = { [weak self] voce, byteInviati in
            self?.notifica("caricamento", voce.comeDizionarioPonte(byteInviati: byteInviati))
        }
    }

    // MARK: Il ponte

    /// I parametri della chiamata come dizionario di Foundation (`NSNumber`, `String`, `NSNull`, dizionari, elenchi): la lettura sta in
    /// `KVPonteCaricamenti`, che non conosce Capacitor.
    private func parametri(_ call: CAPPluginCall) -> [String: Any] {
        return call.options as? [String: Any] ?? [:]
    }

    private func rifiuta(_ call: CAPPluginCall, _ motivo: KVRifiutoPonte) {
        call.reject(motivo.messaggio, motivo.rawValue)
    }

    // MARK: info

    @objc func info(_ call: CAPPluginCall) {
        call.resolve(["protocollo": NSNumber(value: KVPonteCaricamenti.protocollo), "piattaforma": "ios", "motore": KVMotoreCaricamenti.motore.rawValue])
    }

    // MARK: Il selettore

    /// Apre il selettore (galleria o «Scegli da File»), prepara ogni elemento PRIMA di risolvere e manda l'avanzamento come evento `preparazione`.
    @objc func scegliMedia(_ call: CAPPluginCall) {
        guard let opzioni = KVPonteCaricamenti.leggiOpzioniDiScelta(parametri(call)) else { return rifiuta(call, .parametriNonValidi) }
        let avvio = selettore.scegli(
            opzioni: opzioni,
            presentatore: { [weak self] in self?.schermataInCima() },
            avanzamento: { [weak self] avanzamento in self?.notifica("preparazione", avanzamento.comeDizionarioPonte()) },
            completamento: { [self] esito in chiudiScelta(call, esito) }
        )
        if avvio == .giaInCorso { rifiuta(call, .giaInCorso) }
    }

    private func chiudiScelta(_ call: CAPPluginCall, _ esito: KVEsitoSelettore) {
        switch esito {
        case .completata(let annullato, let elementi):
            call.resolve(["annullato": annullato, "elementi": elementi.map { $0.comeDizionarioPonte() }])
        case .nonDisponibile:
            rifiuta(call, .selettoreNonDisponibile)
        case .interno:
            rifiuta(call, .interno)
        }
    }

    /// Ferma la scelta in corso (selettore aperto o preparazione): la `scegliMedia` in attesa si risolve con `annullato: true`.
    @objc func annullaScelta(_ call: CAPPluginCall) {
        call.resolve(["annullata": selettore.annulla()])
    }

    /// La foto preparata in base64 E LA CANCELLA: una lettura sola, il JavaScript ne fa un `File`.
    @objc func leggiFoto(_ call: CAPPluginCall) {
        guard let id = parametri(call)["id"] as? String, KVPoliticaCaricamento.idElementoValido(id) else { return rifiuta(call, .parametriNonValidi) }
        lavoro.async {
            switch self.preparazione.leggiFoto(id: id) {
            case .letta(let base64, let byte, let larghezza, let altezza):
                call.resolve(["base64": base64, "mime": KVElaborazioneFoto.tipoUscita, "byte": NSNumber(value: byte),
                              "larghezza": NSNumber(value: larghezza), "altezza": NSNumber(value: altezza)])
            case .assente:
                self.rifiuta(call, .elementoAssente)
            case .fallita:
                self.rifiuta(call, .interno)
            }
        }
    }

    /// Toglie i preparati non inviati: tolti dall'anteprima, «Annulla» al passo dei bambini, smontaggio. Ignora ciò che non c'è e ogni video già
    /// preso in carico (la sua copia sta in `file/`, che questo metodo non tocca mai).
    @objc func scartaScelti(_ call: CAPPluginCall) {
        guard let ids = KVPonteCaricamenti.elencoDiId(parametri(call)["ids"]) else { return rifiuta(call, .parametriNonValidi) }
        lavoro.async {
            call.resolve(["eliminati": NSNumber(value: self.preparazione.scarta(ids: ids))])
        }
    }

    // MARK: L'invio

    /// Prende in carico un video preparato. Verifica `sha256` e `byteAttesi` contro l'elemento che questa sessione dell'app ha preparato, passa
    /// al motore (che controlla gli host, §9, sposta il file in `file/<jobId>.<ext>`, salva i segreti e crea il trasferimento). Idempotente su
    /// `jobId`: una seconda chiamata (apertura ripetuta, token ruotato) sostituisce i segreti e restituisce lo stato attuale.
    @objc func accodaVideo(_ call: CAPPluginCall) {
        guard let dichiarati = KVPonteCaricamenti.leggiAccodamento(parametri(call)) else { return rifiuta(call, .parametriNonValidi) }
        lavoro.async {
            let ricordo = self.preparazione.video(conId: dichiarati.idElemento)
            let decisione = KVPonteCaricamenti.decidiAccodamento(parametri: dichiarati, ricordo: ricordo, preparato: self.preparazione.preparato(conId: dichiarati.idElemento),
                                                                 voceEsistente: self.motore.coda.voce(dichiarati.jobId))
            guard case .procedi(let sorgente) = decisione else {
                if case .rifiuta(let motivo) = decisione { self.rifiuta(call, motivo) }
                return
            }
            switch self.motore.accoda(KVPonteCaricamenti.richiesta(per: dichiarati, ricordo: ricordo, sorgente: sorgente)) {
            case .accodato(let voce), .giaInCoda(let voce):
                call.resolve(self.voceCorrente(voce))
            case .rifiutato(let perche):
                self.rifiuta(call, perche.comeRifiutoDelPonte)
            }
        }
    }

    /// Le voci di QUELL'utente, per data di creazione: un altro utente sullo stesso telefono non vede quelle altrui.
    @objc func elenco(_ call: CAPPluginCall) {
        guard let utente = KVPonteCaricamenti.uuid(parametri(call)["utenteId"]) else { return rifiuta(call, .parametriNonValidi) }
        lavoro.async {
            call.resolve(["caricamenti": self.motore.elenco(perUtente: utente)])
        }
    }

    /// Ferma il trasferimento, cancella copia e segreti: stato `annullato`. NON ritira l'intento: lo fa il JavaScript.
    @objc func annulla(_ call: CAPPluginCall) {
        guard let job = KVPonteCaricamenti.uuid(parametri(call)["jobId"]) else { return rifiuta(call, .parametriNonValidi) }
        lavoro.async {
            call.resolve(["annullato": self.motore.annulla(job: job)])
        }
    }

    /// Toglie dalla coda le voci TERMINALI indicate; le altre le ignora.
    @objc func dimentica(_ call: CAPPluginCall) {
        guard let job = KVPonteCaricamenti.elencoDiUuid(parametri(call)["jobIds"]) else { return rifiuta(call, .parametriNonValidi) }
        lavoro.async {
            call.resolve(["dimenticati": NSNumber(value: self.motore.dimentica(job))])
        }
    }

    #if DEBUG
    /// SOLO Debug: un video di byte casuali del peso chiesto, già preparato (con il suo `sha256`). Serve a C1. Da una coda a parte: scrive fino a
    /// 2 GB e ne calcola l'impronta, e non deve fermare `elenco` e gli altri.
    @objc func creaElementoDiProva(_ call: CAPPluginCall) {
        guard let byte = KVPonteCaricamenti.intero(parametri(call)["byte"]), byte >= 1, byte <= Self.byteMassimiDiProva else {
            return rifiuta(call, .parametriNonValidi)
        }
        DispatchQueue.global(qos: .userInitiated).async {
            call.resolve(self.preparazione.creaProva(byte: byte).comeDizionarioPonte())
        }
    }

    /// Il peso massimo di un elemento di prova: il tetto di un video (`MAX_VIDEO_INPUT_BYTES`).
    static let byteMassimiDiProva: Int64 = 2_000_000_000
    #endif

    // MARK: Verso il JavaScript

    /// Un evento per chi ascolta (`addListener`). Dal thread principale e in ordine: `notifyListeners` non è fatto per chiamate concorrenti.
    private func notifica(_ nome: String, _ dati: [String: Any]) {
        DispatchQueue.main.async { self.notifyListeners(nome, data: dati) }
    }

    /// La voce com'è adesso, con i byte inviati che il motore sa e la coda no. Se il motore non la trova (non dovrebbe succedere) la forma della coda.
    private func voceCorrente(_ voce: KVVoceCoda) -> [String: Any] {
        let id = KVPoliticaCaricamento.uuidPerIlPonte(voce.jobId)
        if let trovata = motore.elenco(perUtente: voce.utenteId).first(where: { ($0["jobId"] as? String) == id }) { return trovata }
        return voce.comeDizionarioPonte(byteInviati: 0)
    }

    // MARK: Lo schermo

    /// La schermata da cui aprire il selettore: la più in alto fra quelle presentate sopra il controller dell'app. Solo dal thread principale.
    private func schermataInCima() -> UIViewController? {
        var cima = bridge?.viewController
        while let sopra = cima?.presentedViewController { cima = sopra }
        return cima
    }
}

#endif
