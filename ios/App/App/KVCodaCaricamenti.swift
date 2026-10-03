import Foundation
import os

// ═══════════════════════════════════════════════════════════════════════════════════════════
//  KVCodaCaricamenti — il giornale persistente dei caricamenti nativi (spec §4.6, compito I1)
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// Che cosa è: la coda delle voci (`coda.json`), la cartella dei video copiati (`file/`) e di quelli scelti
// e non ancora inviati (`scelti/`), con la pulizia. Sta in `Application Support/KidvilleCaricamenti/`, che
// nessun backup porta via e che iOS non svuota. NESSUN SEGRETO: il token di rinnovo e l'URL firmato stanno nel
// Portachiavi (`KVSegretiCaricamenti`, compito I2), mai qui.
//
// Come è fatta:
//  · ogni cambiamento di STATO passa da `applica`, che consulta la tabella di §4.4 (`KVPoliticaCaricamento`)
//    e rifiuta i passi che la tabella non prevede: nessun altro punto scrive `stato`. A ogni stato terminale la
//    copia del video si cancella lì, nello stesso passo;
//  · la scrittura è ATOMICA (`Data.write(.atomic)`, protezione `completeUntilFirstUserAuthentication`, mai
//    `complete`: col blocco schermo il demone non leggerebbe il file proprio nello scenario che ci interessa)
//    e segue ogni cambiamento;
//  · una coda illeggibile o di una versione che non conosciamo NON si butta: si RINOMINA in
//    `coda.corrotta-<istante>.json` e si riparte da una coda vuota (il server chiuderà i job di quelle voci dopo 48 ore e
//    avviserà l'insegnante); i file di video che nessuna voce nomina più sono «orfani» e la pulizia li toglie;
//  · UNA SOLA voce fuori forma in un file per il resto buono non porta via le altre (come su Android, §4.6): si scarta quella e si conta
//    (`voci_scartate` nella riga `coda-nativa-corrotta`);
//  · uno stato TERMINALE si scrive su disco PRIMA di cancellare la copia del video (e, nel motore, i segreti): se la scrittura fallisce la
//    copia resta, e la pulizia ripassa comunque sui residui;
//  · se invece il file esiste ma NON SI RIESCE A LEGGERE (dati protetti non ancora disponibili, permessi) non è
//    corrotto, e sovrascriverlo con una coda vuota farebbe sparire i video in volo: `carica()` risponde
//    `illeggibileOra`, la coda resta «non pronta» e rifiuta ogni scrittura finché un nuovo `carica()` non riesce;
//  · la classe è sicura fra thread (un'unica serratura): la chiamano la sessione in background, il ponte e il monitor
//    di rete.
//
// Questo file importa solo `Foundation` e `os`: si compila nell'harness `ios/prove/caricamenti/`.

// MARK: - Da dove viene l'elemento

/// Da dove viene un video: la galleria del telefono, «Scegli da File», oppure un elemento di prova creato dalle
/// build Debug (`creaElementoDiProva`).
enum KVOrigineCaricamento: String, Codable, CaseIterable {
    case galleria
    case file
    case prova
}

// MARK: - I testi delle notifiche

/// I testi delle notifiche native, passati dal JS a ogni `accodaVideo` (dai cataloghi it/en) e conservati nella coda. Se
/// mancano, o sono vuoti, vale il ripiego italiano: il progetto nativo non ha cataloghi suoi.
struct KVTestiNotifiche: Codable, Equatable {
    var titolo: String
    var invio: String
    var attesaRete: String
    var pausa: String

    static let ripiegoItaliano = KVTestiNotifiche(
        titolo: "Kidville",
        invio: "Invio dei video in corso",
        attesaRete: "Il video è in attesa di rete: riprenderà da solo",
        pausa: "Invio in pausa: tocca per riprendere"
    )

    static let lunghezzaMassima = 200

    /// Sostituisce con il ripiego ogni testo vuoto (o di soli spazi) e taglia quelli troppo lunghi.
    func conRipiego() -> KVTestiNotifiche {
        func scelto(_ valore: String, _ ripiego: String) -> String {
            let pulito = valore.trimmingCharacters(in: .whitespacesAndNewlines)
            return pulito.isEmpty ? ripiego : String(pulito.prefix(Self.lunghezzaMassima))
        }
        let r = KVTestiNotifiche.ripiegoItaliano
        return KVTestiNotifiche(titolo: scelto(titolo, r.titolo), invio: scelto(invio, r.invio),
                                attesaRete: scelto(attesaRete, r.attesaRete), pausa: scelto(pausa, r.pausa))
    }
}

// MARK: - Una voce della coda

/// Una voce della coda nativa: un video preso in carico. I campi sono quelli di §4.6, e nient'altro: niente URL, niente
/// token. Gli identificativi sono `UUID` (nel file maiuscoli, sul ponte sempre minuscoli).
struct KVVoceCoda: Codable, Equatable {
    var jobId: UUID
    var intentId: UUID
    var utenteId: UUID
    var scuolaId: UUID
    /// Solo per lo schermo: mai in un log.
    var nome: String
    /// Percorso RELATIVO alla cartella della coda (`file/<jobId>.<ext>`).
    var file: String
    var byte: Int64
    var mime: String
    var stato: KVStatoCaricamento
    /// I cicli di tentativo avviati (un ciclo = rinnovo se serve + PUT): da qui l'attesa dopo un transitorio.
    var tentativi: Int
    var rinnovi: Int
    /// I rinnovi chiesti da un rifiuto della PUT, di fila: vedi `KVCausaRinnovo` e `rinnoviConsecutiviDopoPut` (un esito che non è un rifiuto lo azzera).
    var rinnoviConsecutivi: Int
    var codice: KVCodiceCaricamento?
    var prossimoTentativoIl: Date?
    /// Quando scade l'URL di PUT (all'apertura `expires_at` del job; dopo un rinnovo, ricezione + 7200 s). `nil` = età sconosciuta: il motore rinnova
    /// prima della prossima PUT (`rinnovoProattivoNecessario`). Dopo un rifiuto della PUT il motore la AZZERA, così il giro seguente — anche dopo
    /// un'attesa per un 429 o una rete caduta del rinnovo — comincia dal rinnovo e non rispedisce l'URL rifiutato.
    var urlScadeIl: Date?
    /// Quando scade il token di rinnovo (48 ore dall'apertura): oltre, la voce è `fallito`/`TOKEN_SCADUTO`.
    var tokenScadeIl: Date
    var origine: KVOrigineCaricamento
    var creatoIl: Date
    var aggiornatoIl: Date
    /// iOS: il trasferimento è stato creato mentre l'app non era in primo piano (un task creato in background iOS lo
    /// tratta da discrezionale: alla prima apertura si ricrea).
    var creatoInBackground: Bool

    init(jobId: UUID, intentId: UUID, utenteId: UUID, scuolaId: UUID, nome: String, file: String, byte: Int64, mime: String,
         origine: KVOrigineCaricamento, urlScadeIl: Date?, tokenScadeIl: Date, creatoIl: Date, creatoInBackground: Bool = false) {
        self.jobId = jobId
        self.intentId = intentId
        self.utenteId = utenteId
        self.scuolaId = scuolaId
        self.nome = nome
        self.file = file
        self.byte = byte
        self.mime = mime
        self.stato = .inCoda
        self.tentativi = 0
        self.rinnovi = 0
        self.rinnoviConsecutivi = 0
        self.codice = nil
        self.prossimoTentativoIl = nil
        self.urlScadeIl = urlScadeIl
        self.tokenScadeIl = tokenScadeIl
        self.origine = origine
        self.creatoIl = creatoIl
        self.aggiornatoIl = creatoIl
        self.creatoInBackground = creatoInBackground
    }

    /// La voce com'è vista dal JavaScript (`CaricamentoNativo` di `caricamenti-nativi-tipi.ts`), nella forma che gli schemi zod
    /// di S1 accettano — se una sola voce è fuori forma l'INTERO `elenco` viene rifiutato, quindi qui si è più rigidi che altrove:
    ///  · tutti e quattordici i campi ci sono SEMPRE, e `codice` vale `NSNull` quando non c'è (un campo assente non è un null);
    ///  · le date sono ISO 8601 UTC con la `Z`, al secondo;
    ///  · gli uuid sono minuscoli;
    ///  · `nome` sta fra 1 e 255 unità UTF-16, con un ripiego se non resta niente;
    ///  · `byteInviati` è un intero fra 0 e il totale (`inviato` = tutto), `byteTotali` almeno 1;
    ///  · `mime` è sempre una forma che il server accetta.
    /// I byte inviati non stanno nella voce (sono avanzamento del task, in memoria): li passa il chiamante.
    func comeDizionarioPonte(byteInviati: Int64) -> [String: Any] {
        let totale = max(1, byte)
        let inviati: Int64 = stato == .inviato ? totale : min(max(0, byteInviati), totale)
        let mimeValido = KVPoliticaCaricamento.contentTypeAmmesso(mime) ? mime : KVPoliticaCaricamento.mimeDiRipiego
        let codiceDelPonte: Any = codice.map { $0.rawValue as Any } ?? NSNull()
        return [
            "jobId": KVPoliticaCaricamento.uuidPerIlPonte(jobId),
            "intentId": KVPoliticaCaricamento.uuidPerIlPonte(intentId),
            "utenteId": KVPoliticaCaricamento.uuidPerIlPonte(utenteId),
            "scuolaId": KVPoliticaCaricamento.uuidPerIlPonte(scuolaId),
            "nome": KVPoliticaCaricamento.nomePerIlPonte(nome),
            "mime": mimeValido,
            "stato": stato.rawValue,
            "byteInviati": NSNumber(value: inviati),
            "byteTotali": NSNumber(value: totale),
            "tentativi": NSNumber(value: max(0, tentativi)),
            "rinnovi": NSNumber(value: max(0, rinnovi)),
            "codice": codiceDelPonte,
            "creatoIl": KVPoliticaCaricamento.isoZ(creatoIl),
            "aggiornatoIl": KVPoliticaCaricamento.isoZ(aggiornatoIl),
        ]
    }
}

// MARK: - Gli esiti delle operazioni

/// Com'è andato `carica()`.
enum KVEsitoCaricamentoCoda: Equatable {
    /// Nessun file: una coda vuota (la prima volta).
    case nuova
    /// Letta: `voci` voci.
    case caricata(voci: Int)
    /// Letta, ma con `vociScartate` voci fuori forma tolte da sole (§4.6): le altre `voci` restano. `fileOrfani` sono i file di `file/` che
    /// nessuna voce viva nomina più (la pulizia li toglie). La coda ha già scritto `coda-nativa-corrotta` e riscritto il file senza le voci scartate.
    case caricataConScarti(voci: Int, vociScartate: Int, fileOrfani: Int)
    /// Illeggibile o di una versione sconosciuta: rinominata in `coda.corrotta-<istante>.json`, coda nuova vuota.
    /// `fileOrfani` sono i file di video in `file/` che nessuna voce nomina più (la pulizia li toglie): va scritto
    /// `coda-nativa-corrotta` con questo numero.
    case corrotta(fileOrfani: Int)
    /// Il file c'è ma non si riesce a leggerlo adesso (dati protetti non ancora disponibili, permessi): NON è corrotto e non
    /// va toccato. La coda resta non pronta; si riprova.
    case illeggibileOra(KVErroreSistema)
}

enum KVEsitoAggiunta: Equatable {
    case aggiunta(KVVoceCoda)
    /// Esisteva una voce TERMINALE con quel `jobId` (un video fallito o annullato che si rimanda con gli stessi bambini: stessa chiave
    /// d'idempotenza, stesso job): la nuova la sostituisce, e il reinvio riparte da zero.
    case sostituita(KVVoceCoda)
    /// Esiste già una voce VIVA con quel `jobId` (apertura ripetuta): non si tocca, si restituisce lo stato attuale.
    case giaPresente(KVVoceCoda)
    /// Percorso della copia fuori dalla cartella dei file, o peso nullo.
    case nonValida
    case nonPronta
    case scritturaFallita
}

enum KVEsitoTransizione: Equatable {
    /// Applicata: `passi` sono gli eventi eseguiti (uno, o due se serviva il passo preparatorio di `catena`);
    /// `persistita` dice se la scrittura su disco è riuscita.
    case applicata(prima: KVStatoCaricamento, voce: KVVoceCoda, passi: [KVEventoStato], persistita: Bool)
    case voceAssente
    /// La tabella di §4.4 non prevede quel passo da quello stato (compreso ogni passo da uno stato terminale).
    case nonAmmessa(stato: KVStatoCaricamento, evento: KVEventoStato)
    case nonPronta
}

/// Che cosa c'è sul disco della copia di una voce.
enum KVStatoCopia: Equatable {
    case presente
    case assente
    /// C'è, ma pesa `attuale` byte invece di quelli dichiarati (`PESO_DIVERSO`).
    case pesoDiverso(attuale: Int64)
}

struct KVEsitoPulizia: Equatable {
    var sceltiRimossi = 0
    var orfaniRimossi = 0
    var vociTerminaliRimosse = 0
    var corrotteRimosse = 0
    /// Voci non terminali con il token scaduto: la pulizia le ha chiuse come `fallito`/`TOKEN_SCADUTO` (e cancellato la copia) e, se la coda ha un
    /// registro, ha già scritto `video-nativo-fallito`. Il motore avvisa il JS e toglie i segreti.
    var vociScadute: [KVVoceCoda] = []
    /// `false` se la pulizia ha modificato la coda e la scrittura è fallita: le voci appena chiuse sono terminali solo in memoria, e il motore NON
    /// ne cancella i segreti (come la coda non ne ha cancellato le copie).
    var persistita = true
    /// I `jobId` delle voci NON terminali: i segreti di qualunque altro `jobId` non hanno più una voce e il motore li toglie.
    /// ⚠️ `nil` se la pulizia NON è girata (la coda non era pronta) o se non è riuscita a scrivere: in quel caso non si toglie nessun segreto. Un
    /// elenco vuoto «per errore» farebbe cancellare dal Portachiavi i segreti di tutti i video in volo.
    var jobIdAttivi: Set<UUID>? = nil
}

// MARK: - La coda

final class KVCodaCaricamenti {

    // MARK: Nomi e numeri

    static let versioneFile = 1
    static let nomeFileCoda = "coda.json"
    static let prefissoFileCorrotto = "coda.corrotta-"
    static let nomeCartellaFile = "file"
    static let nomeCartellaScelti = "scelti"
    /// I preparati non ancora inviati (`scelti/*`) più vecchi di così si tolgono.
    static let vitaMassimaScelti: TimeInterval = 24 * 3600
    /// Le voci terminali (e i file di coda corrotti) più vecchi di così si tolgono.
    static let vitaMassimaTerminali: TimeInterval = 7 * 24 * 3600
    /// Un file in `file/` che nessuna voce nomina viene tolto solo se ha più di così: fra lo spostamento della copia e la
    /// comparsa della voce passa un istante, e la pulizia non deve poterlo scambiare per un orfano.
    static let graziaFileOrfani: TimeInterval = 300

    /// Dove vive la coda su iOS: `Application Support/KidvilleCaricamenti`.
    static func cartellaPredefinita() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        return base.appendingPathComponent("KidvilleCaricamenti", isDirectory: true)
    }

    /// Il percorso relativo della copia di un video in coda: `file/<jobId minuscolo>.<estensione>`. L'estensione si riduce a lettere e
    /// cifre ASCII (al più otto), altrimenti `bin`.
    static func percorsoRelativoCopia(jobId: UUID, estensione: String) -> String {
        let pulita = String(estensione.lowercased().filter { $0.isASCII && ($0.isLetter || $0.isNumber) }.prefix(8))
        return "\(nomeCartellaFile)/\(KVPoliticaCaricamento.uuidPerIlPonte(jobId)).\(pulita.isEmpty ? "bin" : pulita)"
    }

    /// Un percorso di copia è ammesso se sta SOLO dentro `file/` (due componenti, nessuna risalita, nessun nome nascosto).
    static func percorsoRelativoValido(_ percorso: String) -> Bool {
        let componenti = percorso.split(separator: "/", omittingEmptySubsequences: false)
        guard componenti.count == 2, componenti[0] == nomeCartellaFile else { return false }
        let nome = componenti[1]
        guard !nome.isEmpty, !nome.hasPrefix("."), !nome.contains("\\") else { return false }
        return !nome.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F })
    }

    // MARK: Stato

    let cartella: URL
    private let orologio: () -> Date
    private let registro: KVRegistroNativo?
    private let serratura = NSLock()
    private var vociInterne: [KVVoceCoda] = []
    private var testiInterni = KVTestiNotifiche.ripiegoItaliano
    private var prontaInterna = false
    private let diagnostica = Logger(subsystem: Bundle.main.bundleIdentifier ?? "it.kidville.app", category: "caricamenti-coda")

    /// `registro` è dove si scrivono i log che nascono QUI dentro (una coda corrotta, un token scaduto trovato dalla pulizia): se c'è, il giornale
    /// non può dimenticarsi di scriverli. Senza (nei test di sola logica) non si scrive niente.
    init(cartella: URL, orologio: @escaping () -> Date = { Date() }, registro: KVRegistroNativo? = nil) {
        self.cartella = cartella
        self.orologio = orologio
        self.registro = registro
    }

    var cartellaFile: URL { cartella.appendingPathComponent(Self.nomeCartellaFile, isDirectory: true) }
    var cartellaScelti: URL { cartella.appendingPathComponent(Self.nomeCartellaScelti, isDirectory: true) }
    var urlFileCoda: URL { cartella.appendingPathComponent(Self.nomeFileCoda) }

    /// `true` dopo un `carica()` riuscito (compreso il caso di coda nuova o corrotta). Finché è `false` ogni scrittura è rifiutata.
    var pronta: Bool {
        serratura.lock(); defer { serratura.unlock() }
        return prontaInterna
    }

    // MARK: Cartelle e protezione

    /// Crea la cartella della coda e le sue due sottocartelle, ESCLUSE dal backup e con la protezione
    /// `completeUntilFirstUserAuthentication`. Si può richiamare: riapplica gli attributi anche a cartelle già esistenti.
    @discardableResult
    func preparaCartelle() -> Bool {
        var riuscito = true
        for url in [cartella, cartellaFile, cartellaScelti] {
            if !creaProtetta(url) { riuscito = false }
        }
        return riuscito
    }

    private func creaProtetta(_ url: URL) -> Bool {
        do {
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: nil)
        } catch {
            segnala("creazione di una cartella fallita", error)
            return false
        }
        return proteggi(url)
    }

    /// Protegge un file o una cartella del giornale: `completeUntilFirstUserAuthentication` e fuori dal backup. Lo usa anche chi
    /// sposta una copia dentro `file/`. Restituisce `false` (e lascia un segno nel log di sistema) se un attributo non si applica.
    @discardableResult
    func proteggi(_ url: URL) -> Bool {
        var riuscito = true
        do {
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                                                  ofItemAtPath: url.path)
        } catch {
            segnala("protezione di un file non applicata", error)
            riuscito = false
        }
        do {
            var valori = URLResourceValues()
            valori.isExcludedFromBackup = true
            var destinazione = url
            try destinazione.setResourceValues(valori)
        } catch {
            segnala("esclusione dal backup non applicata", error)
            riuscito = false
        }
        return riuscito
    }

    // MARK: Caricamento

    /// Legge la coda dal disco. Da chiamare all'avvio del motore (e di nuovo se risponde `illeggibileOra`).
    @discardableResult
    func carica() -> KVEsitoCaricamentoCoda {
        serratura.lock(); defer { serratura.unlock() }
        preparaCartelle()
        let percorso = urlFileCoda

        guard FileManager.default.fileExists(atPath: percorso.path) else {
            vociInterne = []
            testiInterni = .ripiegoItaliano
            prontaInterna = true
            return .nuova
        }

        let dati: Data
        do {
            dati = try Data(contentsOf: percorso)
        } catch {
            let errore = KVErroreSistema(error)
            segnala("lettura della coda fallita", error)
            if errore.dominio == .cocoa && errore.codice == NSFileReadNoSuchFileError {
                // Sparito fra il controllo e la lettura: è come se non ci fosse.
                vociInterne = []
                testiInterni = .ripiegoItaliano
                prontaInterna = true
                return .nuova
            }
            prontaInterna = false
            return .illeggibileOra(errore)
        }

        guard let letto = leggi(dati) else { return isolaECominciaDaCapo() }
        vociInterne = letto.voci
        testiInterni = letto.testi
        prontaInterna = true
        if letto.vociScartate == 0 { return .caricata(voci: letto.voci.count) }
        // Una voce sola fuori forma non porta via le altre (§4.6, come su Android): si scarta, si riscrive il file senza, si dichiara. Si
        // riscrive SUBITO perché la riga di log esca una volta sola e non a ogni avvio.
        let orfani = contaFileOrfani()
        _ = salva()
        registro?.registraCodaCorrotta(fileOrfani: orfani, vociScartate: letto.vociScartate)
        return .caricataConScarti(voci: letto.voci.count, vociScartate: letto.vociScartate, fileOrfani: orfani)
    }

    /// L'ESCALATION per una coda che non si riesce MAI a leggere: se `carica()` risponde `illeggibileOra` anche quando i dati protetti sono
    /// certamente disponibili (l'app è in primo piano, il telefono è sbloccato), un `coda.json` che si ostina a non aprirsi è guasto per
    /// davvero (un errore di I/O) e lasciarlo lì vuol dire che OGNI `accodaVideo` fallisce, per sempre. Allora lo si tratta da corrotto:
    /// rinominato `coda.corrotta-<istante>.json`, coda nuova vuota, `coda-nativa-corrotta`. Il motore la chiama solo dopo più tentativi.
    /// Se il file non c'è più, o ora si legge, non rinomina niente e si comporta come `carica()`.
    @discardableResult
    func ripartiDaCapo() -> KVEsitoCaricamentoCoda {
        serratura.lock()
        let esiste = FileManager.default.fileExists(atPath: urlFileCoda.path)
        let leggibile = esiste && (try? Data(contentsOf: urlFileCoda)) != nil
        if esiste && !leggibile {
            let esito = isolaECominciaDaCapo()
            serratura.unlock()
            return esito
        }
        serratura.unlock()
        return carica()
    }

    /// Il file è illeggibile, rotto o di una versione che non conosciamo: lo si tiene da parte e si riparte da una coda vuota. Chi la chiama
    /// tiene la serratura.
    private func isolaECominciaDaCapo() -> KVEsitoCaricamentoCoda {
        let orfani = contaFileInCartella(cartellaFile)
        isolaFileCorrotto()
        vociInterne = []
        testiInterni = .ripiegoItaliano
        prontaInterna = true
        _ = salva()
        registro?.registraCodaCorrotta(fileOrfani: orfani)
        return .corrotta(fileOrfani: orfani)
    }

    private struct FileCoda: Codable {
        var versione: Int
        var testi: KVTestiNotifiche
        var voci: [KVVoceCoda]
    }

    private struct SoloVersione: Codable {
        var versione: Int
    }

    /// Il file com'è in LETTURA: la versione e i testi come prima (se mancano, il file è corrotto per intero), ma le voci UNA PER UNA: una che
    /// non si decodifica non fa fallire le altre, si salta e si conta.
    private struct FileCodaInLettura: Decodable {
        var versione: Int
        var testi: KVTestiNotifiche
        var voci: [KVVoceCoda] = []
        var scartate = 0

        private enum Chiavi: String, CodingKey { case versione, testi, voci }
        /// Si decodifica da qualunque valore JSON senza leggerlo: serve a far avanzare il contenitore oltre una voce che non si è decodificata
        /// (un contenitore non avanza da solo dopo un errore).
        private struct Qualunque: Decodable { init(from decoder: Decoder) throws {} }

        init(from decoder: Decoder) throws {
            let radice = try decoder.container(keyedBy: Chiavi.self)
            versione = try radice.decode(Int.self, forKey: .versione)
            testi = try radice.decode(KVTestiNotifiche.self, forKey: .testi)
            var elenco = try radice.nestedUnkeyedContainer(forKey: .voci)
            while !elenco.isAtEnd {
                if let voce = try? elenco.decode(KVVoceCoda.self) {
                    voci.append(voce)
                } else {
                    _ = try elenco.decode(Qualunque.self)
                    scartate += 1
                }
            }
        }
    }

    /// Una voce che si decodifica ma non ha senso è fuori forma quanto una che non si decodifica: peso nullo, contatori negativi, percorso della copia
    /// che esce da `file/` o che nomina un altro job (a uno stato terminale la copia si cancella: un percorso sbagliato cancellerebbe il video di un altro).
    static func voceValida(_ voce: KVVoceCoda) -> Bool {
        guard voce.byte >= 1, voce.tentativi >= 0, voce.rinnovi >= 0, voce.rinnoviConsecutivi >= 0 else { return false }
        guard percorsoRelativoValido(voce.file), let nome = voce.file.split(separator: "/").last else { return false }
        return nome.hasPrefix(KVPoliticaCaricamento.uuidPerIlPonte(voce.jobId) + ".")
    }

    /// Le voci buone, i testi e quante voci si sono scartate; `nil` se il contenuto non è una coda che sappiamo leggere per intero: JSON rotto,
    /// elenco delle voci assente o che non è un elenco, versione diversa.
    private func leggi(_ dati: Data) -> (voci: [KVVoceCoda], testi: KVTestiNotifiche, vociScartate: Int)? {
        let decodificatore = JSONDecoder()
        decodificatore.dateDecodingStrategy = .iso8601
        guard let intestazione = try? decodificatore.decode(SoloVersione.self, from: dati),
              intestazione.versione == Self.versioneFile,
              let file = try? decodificatore.decode(FileCodaInLettura.self, from: dati) else { return nil }
        var viste = Set<UUID>()
        var buone: [KVVoceCoda] = []
        var scartate = file.scartate
        for voce in file.voci {
            if Self.voceValida(voce) && viste.insert(voce.jobId).inserted {
                buone.append(voce)
            } else {
                scartate += 1
            }
        }
        return (buone, file.testi, scartate)
    }

    /// I file di `file/` che nessuna voce VIVA nomina (come li vede la pulizia).
    private func contaFileOrfani() -> Int {
        let nominati = Set(vociInterne.filter { !$0.stato.eTerminale }.compactMap { nomeDelFile($0.file) })
        return nomiInCartella(cartellaFile).filter { !nominati.contains($0) }.count
    }

    /// `coda.json` → `coda.corrotta-<istante>.json` (con un suffisso se quel nome esiste già).
    private func isolaFileCorrotto() {
        let formato = DateFormatter()
        formato.locale = Locale(identifier: "en_US_POSIX")
        formato.timeZone = TimeZone(secondsFromGMT: 0)
        formato.dateFormat = "yyyyMMdd'T'HHmmss'Z'"
        let istante = formato.string(from: orologio())
        var destinazione = cartella.appendingPathComponent("\(Self.prefissoFileCorrotto)\(istante).json")
        var progressivo = 1
        while FileManager.default.fileExists(atPath: destinazione.path) {
            destinazione = cartella.appendingPathComponent("\(Self.prefissoFileCorrotto)\(istante)-\(progressivo).json")
            progressivo += 1
        }
        do {
            try FileManager.default.moveItem(at: urlFileCoda, to: destinazione)
        } catch {
            segnala("coda corrotta non rinominata", error)
            // Meglio perdere la copia per l'analisi che non poter più scrivere la coda: la scrittura atomica la sostituirà.
        }
    }

    // MARK: Lettura

    func tutte() -> [KVVoceCoda] {
        serratura.lock(); defer { serratura.unlock() }
        return vociInterne
    }

    func voce(_ jobId: UUID) -> KVVoceCoda? {
        serratura.lock(); defer { serratura.unlock() }
        return vociInterne.first(where: { $0.jobId == jobId })
    }

    /// Le voci di UN utente, per data di creazione (il metodo `elenco` del plugin).
    func voci(perUtente utenteId: UUID) -> [KVVoceCoda] {
        serratura.lock(); defer { serratura.unlock() }
        return vociInterne.filter { $0.utenteId == utenteId }.sorted {
            $0.creatoIl != $1.creatoIl ? $0.creatoIl < $1.creatoIl : $0.jobId.uuidString < $1.jobId.uuidString
        }
    }

    var testi: KVTestiNotifiche {
        serratura.lock(); defer { serratura.unlock() }
        return testiInterni
    }

    // MARK: Scrittura

    func impostaTesti(_ testi: KVTestiNotifiche) {
        serratura.lock(); defer { serratura.unlock() }
        guard prontaInterna else { return }
        let nuovi = testi.conRipiego()
        if nuovi == testiInterni { return }
        testiInterni = nuovi
        _ = salva()
    }

    /// Aggiunge una voce `in-coda`. Se c'è già una voce VIVA con quel `jobId` non fa niente e restituisce quella che c'è (`accodaVideo` è
    /// idempotente sul `jobId`). Se c'è una voce TERMINALE con quel `jobId` (un video fallito o annullato che si rimanda con gli stessi
    /// bambini: la chiave d'idempotenza è deterministica, quindi il job è lo stesso) la SOSTITUISCE: un reinvio deve ripartire, non
    /// restituire un `fallito` che non si muove più. La copia e i segreti della terminale non ci sono già (si cancellano a ogni stato terminale).
    ///
    /// La copia del video NON si sposta qui: si sposta DOPO, con `spostaInFile(da:perVoce:)`, e se non riesce si toglie la voce con
    /// `rimuoviVoce` — così una voce aggiunta e non scritta, o una copia spostata senza voce, non restano mai in giro.
    func aggiungi(_ voce: KVVoceCoda) -> KVEsitoAggiunta {
        serratura.lock(); defer { serratura.unlock() }
        guard prontaInterna else { return .nonPronta }
        let esistente = vociInterne.firstIndex(where: { $0.jobId == voce.jobId })
        if let indice = esistente, !vociInterne[indice].stato.eTerminale { return .giaPresente(vociInterne[indice]) }
        guard Self.voceValida(voce), voce.stato == .inCoda else { return .nonValida }
        if let indice = esistente {
            let precedente = vociInterne[indice]
            vociInterne[indice] = voce
            if !salva() {
                vociInterne[indice] = precedente
                return .scritturaFallita
            }
            return .sostituita(voce)
        }
        vociInterne.append(voce)
        if !salva() {
            vociInterne.removeLast()
            return .scritturaFallita
        }
        return .aggiunta(voce)
    }

    /// Toglie una voce dalla coda qualunque sia il suo stato, con la sua copia: è il ripristino di `accodaVideo` quando, dopo l'`aggiungi`,
    /// qualcosa non è riuscito (la copia non si sposta, i segreti non si salvano). Non è un `dimentica`: quello vale solo per le terminali.
    @discardableResult
    func rimuoviVoce(_ jobId: UUID) -> Bool {
        serratura.lock(); defer { serratura.unlock() }
        guard prontaInterna, let indice = vociInterne.firstIndex(where: { $0.jobId == jobId }) else { return false }
        let voce = vociInterne.remove(at: indice)
        _ = salva()
        rimuoviCopia(voce)
        return true
    }

    /// Cambia lo STATO di una voce, e solo qui lo si cambia. Applica la sequenza di `KVPoliticaCaricamento.catena`. A uno stato terminale la copia del
    /// video si cancella DOPO aver scritto lo stato su disco, e solo se la scrittura è riuscita: se fallisce (o il processo muore in mezzo) la
    /// voce sul disco resta viva CON la sua copia, e alla riapertura riparte (il server dirà con un duplicato se il file era già arrivato); se invece
    /// la copia sparisse prima, la stessa voce rinascerebbe in `FILE_ASSENTE` anche a video arrivato. La pulizia ripassa comunque sui residui.
    /// I segreti (Portachiavi) li toglie il motore, che lo sa dal risultato, con la stessa regola.
    func applica(_ evento: KVEventoStato, a jobId: UUID) -> KVEsitoTransizione {
        serratura.lock(); defer { serratura.unlock() }
        guard prontaInterna else { return .nonPronta }
        guard let indice = vociInterne.firstIndex(where: { $0.jobId == jobId }) else { return .voceAssente }
        let prima = vociInterne[indice].stato
        guard let passi = KVPoliticaCaricamento.catena(da: prima, evento: evento) else {
            return .nonAmmessa(stato: prima, evento: evento)
        }
        let ora = orologio()
        for passo in passi { eseguiPasso(passo, sulla: indice, ora: ora) }
        let persistita = salva()
        if persistita && vociInterne[indice].stato.eTerminale { rimuoviCopia(vociInterne[indice]) }
        return .applicata(prima: prima, voce: vociInterne[indice], passi: passi, persistita: persistita)
    }

    /// Un passo della tabella, già verificato. Chi lo chiama tiene la serratura e, a uno stato terminale, cancella la copia DOPO aver scritto.
    private func eseguiPasso(_ passo: KVEventoStato, sulla indice: Int, ora: Date) {
        guard let nuovo = KVPoliticaCaricamento.transizione(da: vociInterne[indice].stato, evento: passo) else { return }
        vociInterne[indice].stato = nuovo
        vociInterne[indice].codice = passo.codice
        vociInterne[indice].aggiornatoIl = ora
        if nuovo == .inInvio || nuovo.eTerminale { vociInterne[indice].prossimoTentativoIl = nil }
    }

    /// Cambia gli altri campi di una voce (contatori, scadenze, codice, `prossimoTentativoIl`…). Lo `stato`, il `jobId` e `creatoIl` non si
    /// possono cambiare da qui: se la chiusura li tocca, vengono rimessi. Restituisce la voce com'è dopo, o `nil` se non c'è (o la coda
    /// non è pronta). La chiusura gira con la serratura presa: non deve richiamare la coda.
    @discardableResult
    func aggiorna(_ jobId: UUID, _ modifica: (inout KVVoceCoda) -> Void) -> KVVoceCoda? {
        serratura.lock(); defer { serratura.unlock() }
        guard prontaInterna, let indice = vociInterne.firstIndex(where: { $0.jobId == jobId }) else { return nil }
        var voce = vociInterne[indice]
        let (stato, id, creatoIl) = (voce.stato, voce.jobId, voce.creatoIl)
        modifica(&voce)
        voce.stato = stato
        voce.jobId = id
        voce.creatoIl = creatoIl
        voce.aggiornatoIl = orologio()
        vociInterne[indice] = voce
        _ = salva()
        return voce
    }

    /// Toglie dalla coda le voci TERMINALI indicate; le altre le ignora (`dimentica` del plugin). Restituisce quante ne ha tolte.
    @discardableResult
    func dimentica(_ jobIds: [UUID]) -> Int {
        serratura.lock(); defer { serratura.unlock() }
        guard prontaInterna else { return 0 }
        let richiesti = Set(jobIds)
        let prima = vociInterne.count
        vociInterne.removeAll { richiesti.contains($0.jobId) && $0.stato.eTerminale }
        let tolte = prima - vociInterne.count
        if tolte > 0 { _ = salva() }
        return tolte
    }

    // MARK: La copia di una voce

    /// L'indirizzo della copia, o `nil` se il percorso nella voce esce da `file/`.
    func urlFile(di voce: KVVoceCoda) -> URL? {
        guard Self.percorsoRelativoValido(voce.file) else { return nil }
        return cartella.appendingPathComponent(voce.file)
    }

    /// Prima di creare un trasferimento: la copia c'è, ed è di quanti byte si è dichiarato?
    func statoDellaCopia(di voce: KVVoceCoda) -> KVStatoCopia {
        guard let url = urlFile(di: voce) else { return .assente }
        guard FileManager.default.fileExists(atPath: url.path) else { return .assente }
        let attributi: [FileAttributeKey: Any]
        do {
            attributi = try FileManager.default.attributesOfItem(atPath: url.path)
        } catch {
            segnala("peso della copia non letto", error)
            return .assente
        }
        let peso = (attributi[.size] as? NSNumber)?.int64Value ?? -1
        return peso == voce.byte ? .presente : .pesoDiverso(attuale: peso)
    }

    private func rimuoviCopia(_ voce: KVVoceCoda) {
        guard let url = urlFile(di: voce), FileManager.default.fileExists(atPath: url.path) else { return }
        do {
            try FileManager.default.removeItem(at: url)
        } catch {
            segnala("copia non cancellata a stato terminale", error)
        }
    }

    // MARK: I preparati (`scelti/`) e il passaggio a `file/`

    /// Il preparato con quell'id (`scelti/<id>.<estensione>`), o `nil`. L'id deve avere la forma dei nostri (`idElementoValido`: niente
    /// separatori né punti), così un id che arriva dal ponte non può uscire dalla cartella.
    func trovaScelto(id: String) -> URL? {
        serratura.lock(); defer { serratura.unlock() }
        return trovaSceltoSenzaSerratura(id: id)
    }

    private func trovaSceltoSenzaSerratura(id: String) -> URL? {
        guard KVPoliticaCaricamento.idElementoValido(id) else { return nil }
        let prefisso = id + "."
        guard let nome = nomiInCartella(cartellaScelti).first(where: { $0.hasPrefix(prefisso) }) else { return nil }
        return cartellaScelti.appendingPathComponent(nome)
    }

    /// Toglie i preparati con quegli id (`scartaScelti`): gli id che non hanno la forma giusta o che non ci sono si ignorano. Restituisce
    /// quanti ne ha tolti.
    @discardableResult
    func rimuoviScelti(ids: [String]) -> Int {
        serratura.lock(); defer { serratura.unlock() }
        var tolti = 0
        for id in ids {
            if let url = trovaSceltoSenzaSerratura(id: id), rimuovi(url) { tolti += 1 }
        }
        return tolti
    }

    /// Sposta un preparato di `scelti/` nella copia della voce `jobId`, `file/<jobId>.<estensione>` (è il secondo passo di `accodaVideo`, DOPO
    /// `aggiungi`), e la protegge. Restituisce `false` se non riesce: la voce non c'è o è terminale, la sorgente sta fuori da `scelti/`, lo
    /// spostamento fallisce. In quel caso la sorgente è ancora dov'era e chi chiama toglie la voce con `rimuoviVoce` (il ripristino). Una
    /// destinazione che esiste già (un residuo: nessun'altra voce viva la nomina) si sostituisce.
    func spostaInFile(da sorgente: URL, perVoce jobId: UUID) -> Bool {
        serratura.lock(); defer { serratura.unlock() }
        guard prontaInterna else { return false }
        guard let voce = vociInterne.first(where: { $0.jobId == jobId }), !voce.stato.eTerminale,
              let destinazione = urlFile(di: voce) else { return false }
        let radiceScelti = cartellaScelti.standardizedFileURL.path + "/"
        guard sorgente.standardizedFileURL.path.hasPrefix(radiceScelti) else { return false }
        do {
            if FileManager.default.fileExists(atPath: destinazione.path) { try FileManager.default.removeItem(at: destinazione) }
            try FileManager.default.moveItem(at: sorgente, to: destinazione)
        } catch {
            segnala("spostamento della copia fallito", error)
            return false
        }
        proteggi(destinazione)
        return true
    }

    // MARK: Pulizia (all'avvio del motore)

    /// Cosa si toglie, in quest'ordine:
    ///  1. le voci non terminali col token scaduto vengono chiuse `fallito`/`TOKEN_SCADUTO` (con la copia): è ciò che tiene il tetto di vita
    ///     di una copia alla vita del token, 48 ore, più l'intervallo fino al primo risveglio dell'app;
    ///  2. le voci terminali più vecchie di 7 giorni;
    ///  3. i file di `file/` che nessuna voce NON terminale nomina (e più vecchi della grazia);
    ///  4. i preparati di `scelti/` più vecchi di 24 ore;
    ///  5. i file di coda corrotti più vecchi di 7 giorni.
    /// L'età di un file è la PIÙ RECENTE fra data di modifica, di creazione e di cambio dei metadati: una copia spostata qui porta con sé la data
    /// del video di partenza (magari di mesi fa), ma il cambio dei metadati è l'istante in cui è arrivata.
    func pulisci(adesso: Date? = nil) -> KVEsitoPulizia {
        serratura.lock(); defer { serratura.unlock() }
        var esito = KVEsitoPulizia()
        guard prontaInterna else { return esito } // jobIdAttivi resta nil: non si è guardato niente
        let ora = adesso ?? orologio()
        var modificata = false

        // 1. token scaduti
        for indice in vociInterne.indices {
            let voce = vociInterne[indice]
            guard !voce.stato.eTerminale, KVPoliticaCaricamento.tokenScaduto(adesso: ora, tokenScadeIl: voce.tokenScadeIl) else { continue }
            eseguiPasso(.fallito(.tokenScaduto), sulla: indice, ora: ora)
            let chiusa = vociInterne[indice]
            esito.vociScadute.append(chiusa)
            registro?.registraFallito(job: chiusa.jobId, utente: chiusa.utenteId, codice: .tokenScaduto,
                                      operazione: KVPoliticaCaricamento.operazione(per: .tokenScaduto),
                                      tentativi: chiusa.tentativi, rinnovi: chiusa.rinnovi, statoHTTP: nil)
            modificata = true
        }

        // 2. voci terminali vecchie
        let prima = vociInterne.count
        vociInterne.removeAll { $0.stato.eTerminale && ora.timeIntervalSince($0.aggiornatoIl) > Self.vitaMassimaTerminali }
        esito.vociTerminaliRimosse = prima - vociInterne.count
        if esito.vociTerminaliRimosse > 0 { modificata = true }

        // 3. file orfani. Le copie delle voci appena chiuse al punto 1 NON lo sono ancora: si cancellano in fondo, dopo aver scritto lo stato.
        let nominati = Set((vociInterne.filter { !$0.stato.eTerminale } + esito.vociScadute).compactMap { nomeDelFile($0.file) })
        for nome in nomiInCartella(cartellaFile) where !nominati.contains(nome) {
            let url = cartellaFile.appendingPathComponent(nome)
            if let eta = ultimaAttivita(url), ora.timeIntervalSince(eta) > Self.graziaFileOrfani, rimuovi(url) {
                esito.orfaniRimossi += 1
            }
        }

        // 4. preparati vecchi
        for nome in nomiInCartella(cartellaScelti) {
            let url = cartellaScelti.appendingPathComponent(nome)
            if let eta = ultimaAttivita(url), ora.timeIntervalSince(eta) > Self.vitaMassimaScelti, rimuovi(url) {
                esito.sceltiRimossi += 1
            }
        }

        // 5. coda corrotta vecchia
        for nome in nomiInCartella(cartella) where nome.hasPrefix(Self.prefissoFileCorrotto) {
            let url = cartella.appendingPathComponent(nome)
            if let eta = ultimaAttivita(url), ora.timeIntervalSince(eta) > Self.vitaMassimaTerminali, rimuovi(url) {
                esito.corrotteRimosse += 1
            }
        }

        if modificata {
            // Le copie delle voci appena chiuse si cancellano DOPO aver scritto lo stato (come in `applica`): se la scrittura fallisce restano, e la
            // pulizia successiva le prende come orfane quando la voce risulterà terminale su disco.
            if salva() {
                for chiusa in esito.vociScadute { rimuoviCopia(chiusa) }
            } else {
                esito.persistita = false
                return esito // jobIdAttivi resta nil: nessun segreto si toglie
            }
        }
        esito.jobIdAttivi = Set(vociInterne.filter { !$0.stato.eTerminale }.map { $0.jobId })
        return esito
    }

    /// Il nome del file di una voce (la seconda parte di `file/<nome>`).
    private func nomeDelFile(_ percorso: String) -> String? {
        guard Self.percorsoRelativoValido(percorso) else { return nil }
        return percorso.split(separator: "/", omittingEmptySubsequences: false).last.map(String.init)
    }

    private func nomiInCartella(_ cartella: URL) -> [String] {
        do {
            return try FileManager.default.contentsOfDirectory(atPath: cartella.path).filter { !$0.hasPrefix(".") }.sorted()
        } catch {
            segnala("cartella non elencata", error)
            return []
        }
    }

    private func contaFileInCartella(_ cartella: URL) -> Int {
        return nomiInCartella(cartella).count
    }

    /// L'istante in cui un file è arrivato qui: il più recente fra le sue tre date. `nil` se non si legge (nel dubbio non si tocca).
    private func ultimaAttivita(_ url: URL) -> Date? {
        do {
            let valori = try url.resourceValues(forKeys: [.contentModificationDateKey, .creationDateKey, .attributeModificationDateKey])
            return [valori.contentModificationDate, valori.creationDate, valori.attributeModificationDate].compactMap { $0 }.max()
        } catch {
            segnala("data di un file non letta", error)
            return nil
        }
    }

    private func rimuovi(_ url: URL) -> Bool {
        do {
            try FileManager.default.removeItem(at: url)
            return true
        } catch {
            segnala("file non rimosso dalla pulizia", error)
            return false
        }
    }

    // MARK: Persistenza

    /// Scrive la coda. Chi la chiama tiene la serratura.
    private func salva() -> Bool {
        let file = FileCoda(versione: Self.versioneFile, testi: testiInterni, voci: vociInterne)
        let codificatore = JSONEncoder()
        codificatore.dateEncodingStrategy = .iso8601
        codificatore.outputFormatting = [.sortedKeys]
        do {
            let dati = try codificatore.encode(file)
            try dati.write(to: urlFileCoda, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            return true
        } catch {
            segnala("scrittura della coda fallita", error)
            return false
        }
    }

    /// Un guasto del giornale lascia un segno nel log di sistema: SOLO dominio e codice numerico, mai il testo dell'errore né un percorso. Il
    /// registro dei log del JS non si usa da qui: un guasto di scrittura non deve dipendere da un altro file da scrivere.
    private func segnala(_ cosa: StaticString, _ errore: Error) {
        let e = KVErroreSistema(errore)
        diagnostica.error("\(cosa, privacy: .public): dominio \(e.dominio.rawValue, privacy: .public) codice \(e.codice, privacy: .public)")
    }
}
