import AVFoundation
import CryptoKit
import Foundation
import os
import PhotosUI
import UIKit
import UniformTypeIdentifiers

// ═══════════════════════════════════════════════════════════════════════════════════════════
//  KVSelettoreMedia — il selettore di foto e video e la preparazione degli elementi (spec §4.3, §5.5, compito I3)
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// Che cosa è, in due parti:
//
//  1. `KVPreparazioneMedia` — la PREPARAZIONE, senza interfaccia. Prende il file che il sistema ha consegnato (una foto, un video) e ne fa
//     un elemento pronto per il JavaScript: il video si SPOSTA in `scelti/<id>.<ext>` (nessuna copia: lo spostamento è un rinominare) e se ne
//     calcolano lo `sha256` (a blocchi da 4 MiB), la durata e la miniatura; la foto si riduce a un JPEG di 1920 px senza metadati
//     (`KVElaborazioneFoto`) in `scelti/<id>.jpg`; ciò che non entra torna come `rifiutato` con uno dei sei motivi, e la sua copia si cancella.
//     È la parte che l'harness prova sul serio (`ios/prove/caricamenti/prove-foto.swift`), con file veri e senza schermo.
//  2. `KVSelettoreMedia` — l'INTERFACCIA e la sessione di scelta. Apre PHPicker (galleria) o `UIDocumentPicker` («Scegli da File»), tiene
//     la sessione (una per volta: `GIA_IN_CORSO`), prepara gli elementi UNO ALLA VOLTA su una coda di sfondo, manda l'avanzamento, e sa
//     annullare. Non sa niente di Capacitor: lo chiama la facciata del plugin (`KVCaricamentiPlugin`).
//
// ─── I PREPARATI ─────────────────────────────────────────────────────────────────────────────
// Stanno TUTTI in `…/KidvilleCaricamenti/scelti/` (la cartella della coda: protetta, fuori dal backup), foto comprese: `Caches/` iOS può
// svuotarla a metà flusso. Un video preparato vive lì finché `accodaVideo` non lo sposta in `file/<jobId>.<ext>`; una foto finché `leggiFoto`
// non la consegna (e la cancella); ciò che nessuno reclama lo toglie la pulizia della coda dopo 24 ore. L'identità di un elemento è il suo
// `sha256` (nessun `assetIdentifier`: `PHPickerConfiguration()` senza libreria non ne espone, e non chiede nessun permesso).
//
// ─── SPAZIO ──────────────────────────────────────────────────────────────────────────────────
// Prima di spostare un video lo spazio libero (`volumeAvailableCapacityForImportantUsageKey`, già dichiarato E174.1 in `PrivacyInfo`) deve essere
// almeno il peso del video più 200 MB (200 MiB, come su Android), altrimenti `spazio-insufficiente`. La regola è quella della spec, ed è prudente di proposito: il sistema
// ha già fatto la sua copia temporanea prima di consegnarcela, e ciò che resta deve bastare per l'invio e per le altre scelte. Un errore
// `NSCocoaErrorDomain 640` (scrittura senza spazio) dice lo stesso motivo. SOLO nelle build Debug la variabile d'ambiente
// `KV_SPAZIO_LIBERO_FORZATO_BYTE` sostituisce lo spazio letto dal sistema: serve allo scenario S10 del collaudo (§11.1), perché sul
// simulatore il disco del Mac non è mai pieno.
//
// ─── LOG ─────────────────────────────────────────────────────────────────────────────────────
// Un rifiuto atteso (troppo grande, troppo lungo, formato che non conosciamo, file rotto, iCloud assente, poco spazio) NON è un errore e non
// scrive niente: lo vede l'insegnante nell'avviso a schermo e lo conta il JavaScript. Un guasto NOSTRO (il file consegnato non si legge, la copia non
// si sposta, l'impronta non si legge, la riduzione non esce, la miniatura di un video che si riproduce non esce) scrive `media-nativo-preparazione-fallita` con il
// motivo e l'errore di sistema come dominio e codice: SOLO per le funzioni del registro, che accettano enumerati e numeri (mai un nome, un
// percorso, un URL). Il nome del file (`suggestedName`, il nome del file scelto) serve allo schermo e basta: non entra in nessun log.

// MARK: - I vocaboli del ponte

/// Da dove si sceglie (`sorgente` di `scegliMedia`).
enum KVSorgenteScelta: String, Equatable {
    case galleria
    case file
}

/// Le opzioni di una scelta, com'è arrivata dal JavaScript (che le ha prese dai suoi limiti: il nativo non ne riscrive nessuno).
struct KVOpzioniScelta: Equatable {
    var sorgente: KVSorgenteScelta
    var massimoElementi: Int
    var latoMassimoFoto: Int
    var qualitaFoto: Double
    var byteMassimiVideo: Int64
    var durataMassimaVideoSecondi: Int
}

/// Perché un elemento non entra: i sei motivi di `MOTIVI_RIFIUTO` (`caricamenti-nativi-tipi.ts`). La lingua è del JavaScript.
enum KVMotivoRifiuto: String, CaseIterable, Equatable {
    case troppoGrande = "troppo-grande"
    case troppoLungo = "troppo-lungo"
    case formatoNonSupportato = "formato-non-supportato"
    case illeggibile = "illeggibile"
    case spazioInsufficiente = "spazio-insufficiente"
    case icloudNonDisponibile = "icloud-non-disponibile"
}

/// Il campo `origine` di un elemento rifiutato: che cosa era (o sembrava) ciò che non è entrato.
enum KVGenereElemento: String, Equatable {
    case foto
    case video
    case altro
}

struct KVElementoFoto: Equatable {
    let id: String
    let nome: String
    let larghezza: Int
    let altezza: Int
    let byte: Int64
}

/// Un video preparato. Oltre a ciò che va al JavaScript porta ciò che serve a `accodaVideo` per riconoscerlo (origine, estensione, data).
struct KVElementoVideo: Equatable {
    let id: String
    let nome: String
    let byte: Int64
    let mime: String
    /// `nil` se il sistema non sa dire la durata (la misura vera la fa il probe del server): mai zero.
    let durataSecondi: Double?
    /// Un data URL `image/jpeg;base64`, o `nil` se la miniatura non si è potuta fare.
    let miniatura: String?
    /// Esadecimale MINUSCOLO, 64 caratteri, calcolato sui byte che partiranno.
    let sha256: String
    let origine: KVOrigineCaricamento
    let estensione: String
    let creatoIl: Date
}

struct KVElementoRifiutato: Equatable {
    let id: String
    let nome: String
    let origine: KVGenereElemento
    let motivo: KVMotivoRifiuto
}

enum KVElementoScelto: Equatable {
    case foto(KVElementoFoto)
    case video(KVElementoVideo)
    case rifiutato(KVElementoRifiutato)

    var id: String {
        switch self {
        case .foto(let e): return e.id
        case .video(let e): return e.id
        case .rifiutato(let e): return e.id
        }
    }

    /// L'elemento nella forma che gli schemi zod di S1 accettano (`ElementoScelto`): ogni campo `| null` c'è SEMPRE, valorizzato a `NSNull`
    /// (un campo assente non è un null: farebbe cadere l'intera risposta), i numeri sono interi, `nome` sta fra 1 e 255.
    func comeDizionarioPonte() -> [String: Any] {
        switch self {
        case .foto(let e):
            return ["id": e.id, "tipo": "foto", "nome": e.nome, "larghezza": NSNumber(value: e.larghezza),
                    "altezza": NSNumber(value: e.altezza), "byte": NSNumber(value: e.byte)]
        case .video(let e):
            return ["id": e.id, "tipo": "video", "nome": e.nome, "byte": NSNumber(value: e.byte), "mime": e.mime,
                    "durataSecondi": e.durataSecondi.map { $0 as Any } ?? NSNull(),
                    "miniatura": e.miniatura.map { $0 as Any } ?? NSNull(),
                    "sha256": e.sha256]
        case .rifiutato(let e):
            return ["id": e.id, "tipo": "rifiutato", "nome": e.nome, "origine": e.origine.rawValue, "motivo": e.motivo.rawValue]
        }
    }
}

/// L'evento `preparazione`: quanti elementi sono pronti su quanti, e i byte lavorati (il totale è `nil` quando il selettore non lo sa dire in
/// anticipo: la galleria consegna un file alla volta).
struct KVAvanzamentoPreparazione: Equatable {
    var fatti: Int
    var totali: Int
    var byteCopiati: Int64
    var byteTotali: Int64?

    func comeDizionarioPonte() -> [String: Any] {
        return ["fatti": NSNumber(value: max(0, fatti)), "totali": NSNumber(value: max(0, totali)),
                "byteCopiati": NSNumber(value: max(0, byteCopiati)),
                "byteTotali": byteTotali.map { NSNumber(value: max(0, $0)) as Any } ?? NSNull()]
    }
}

// MARK: - La preparazione (senza schermo)

/// La preparazione degli elementi, senza schermo: dal file che il sistema ha consegnato (un video, una foto) all'elemento che il ponte restituisce, o al
/// suo rifiuto. Tiene anche il ricordo dei video preparati (che `accodaVideo` confronta con ciò che il JavaScript dichiara) e sa leggere e scartare i
/// preparati in `scelti/`.
final class KVPreparazioneMedia {

    // MARK: Numeri

    /// Il margine di spazio che deve restare oltre al peso del video (§5.5): 200 MB, intesi come 200 MiB (209.715.200 byte), come su Android
    /// (`SelettoreMedia.MARGINE_SPAZIO_BYTE`): le due piattaforme dicono lo stesso numero.
    static let margineSpazioByte: Int64 = 200 * 1024 * 1024
    /// L'impronta si legge a blocchi da 4 MiB (§5.2).
    static let bloccoImprontaByte = 4 * 1024 * 1024
    /// Il lato lungo della miniatura di un video (`LATO_MINIATURA_VIDEO` di `caricamenti-nativi-tipi.ts`).
    static let latoMiniatura = 320
    /// Quanto vive il ricordo di un video preparato (la vita del token di rinnovo, 48 ore): oltre, `accodaVideo` non lo riconoscerebbe comunque.
    static let vitaMassimaRicordoSecondi: TimeInterval = 48 * 3600

    // MARK: Stato

    private let coda: KVCodaCaricamenti
    private let registro: KVRegistroNativo?
    private let spazioDisponibile: () -> Int64?
    private let nuovoId: () -> String
    private let orologio: () -> Date
    private let serratura = NSLock()
    private var ricordi: [String: KVElementoVideo] = [:]
    private let diagnostica = Logger(subsystem: Bundle.main.bundleIdentifier ?? "it.kidville.app", category: "caricamenti-selettore")

    /// `coda` è quella del motore (`KVMotoreCaricamenti.condiviso.coda`): da lì vengono la cartella `scelti/`, la protezione dei file e la
    /// ricerca di un preparato per id. `registro` riceve i guasti nostri (può mancare nelle prove di sola logica).
    init(coda: KVCodaCaricamenti, registro: KVRegistroNativo?, spazioDisponibile: @escaping () -> Int64? = KVPreparazioneMedia.spazioLiberoDelDispositivo,
         nuovoId: @escaping () -> String = { UUID().uuidString.lowercased() }, orologio: @escaping () -> Date = { Date() }) {
        self.coda = coda
        self.registro = registro
        self.spazioDisponibile = spazioDisponibile
        self.nuovoId = nuovoId
        self.orologio = orologio
    }

    private var cartellaScelti: URL { coda.cartellaScelti }

    // MARK: Spazio

    /// La regola della spec: `disponibile ≥ peso + 200 MB` (200 MiB). Se lo spazio non si legge non si blocca niente (un disco davvero pieno lo dirà la
    /// scrittura: `NSCocoaErrorDomain 640`).
    static func spazioSufficiente(disponibile: Int64?, peso: Int64) -> Bool {
        guard let disponibile = disponibile else { return true }
        return disponibile >= peso + margineSpazioByte
    }

    /// Lo spazio che il sistema stima libero per l'uso «importante» (è anche quello che libera, se serve, la cache di sistema). In Debug la
    /// variabile d'ambiente `KV_SPAZIO_LIBERO_FORZATO_BYTE` lo sostituisce (scenario S10 del collaudo).
    static func spazioLiberoDelDispositivo() -> Int64? {
        #if DEBUG
        if let forzato = ProcessInfo.processInfo.environment["KV_SPAZIO_LIBERO_FORZATO_BYTE"], let valore = Int64(forzato), valore >= 0 {
            return valore
        }
        #endif
        do {
            let valori = try URL(fileURLWithPath: NSHomeDirectory()).resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
            return valori.volumeAvailableCapacityForImportantUsage
        } catch {
            let e = KVErroreSistema(error)
            Logger(subsystem: Bundle.main.bundleIdentifier ?? "it.kidville.app", category: "caricamenti-selettore")
                .error("spazio libero non letto: dominio \(e.dominio.rawValue, privacy: .public) codice \(e.codice, privacy: .public)")
            return nil
        }
    }

    // MARK: Errori del sistema → motivi

    /// Ciò che il selettore di sistema dice quando non riesce a consegnare un file, ridotto a un motivo. `daLoggare` è vero per ciò che non è né
    /// «manca la rete» né «manca lo spazio»: quelli sono rifiuti attesi, il resto è un guasto che vogliamo vedere nei log.
    /// Si guarda anche l'errore SOTTOSTANTE (il sistema avvolge spesso l'errore di rete di iCloud dentro uno suo).
    static func motivoPerErrore(_ errore: Error) -> (motivo: KVMotivoRifiuto, daLoggare: Bool) {
        var corrente: NSError? = errore as NSError
        var livello = 0
        while let ns = corrente, livello < 4 {
            if ns.domain == NSCocoaErrorDomain && ns.code == 640 { return (.spazioInsufficiente, false) }
            if ns.domain == NSURLErrorDomain { return (.icloudNonDisponibile, false) }
            // `PHPhotosErrorNetworkAccessRequired` (3164) e `PHPhotosErrorNetworkError` (3169): il video è solo su iCloud e la rete non c'è.
            if ns.domain == "PHPhotosErrorDomain" && (ns.code == 3164 || ns.code == 3169) { return (.icloudNonDisponibile, false) }
            corrente = ns.userInfo[NSUnderlyingErrorKey] as? NSError
            livello += 1
        }
        return (.illeggibile, true)
    }

    /// L'errore di sistema che si scrive nel log per un guasto del selettore. Il sistema avvolge l'errore vero dentro uno suo (`NSItemProviderErrorDomain`,
    /// codice -1000 per tutto), e «altro:-1000» non direbbe niente: si scende lungo `NSUnderlyingErrorKey` fino al primo che non è un involucro (al più
    /// quattro livelli). Se sotto non c'è niente, l'errore stesso. Sempre solo dominio (da un elenco chiuso) e codice numerico.
    static func erroreDaLoggare(_ errore: Error) -> KVErroreSistema {
        var corrente = errore as NSError
        var livello = 0
        while corrente.domain == "NSItemProviderErrorDomain", livello < 4, let sotto = corrente.userInfo[NSUnderlyingErrorKey] as? NSError {
            corrente = sotto
            livello += 1
        }
        return KVErroreSistema(corrente)
    }

    // MARK: Tipi, estensioni, MIME

    /// Il tipo di un file dalla sua estensione (i file che il sistema ci consegna hanno l'estensione giusta).
    static func tipoDelFile(_ url: URL) -> UTType? {
        let estensione = url.pathExtension
        guard !estensione.isEmpty else { return nil }
        return UTType(filenameExtension: estensione)
    }

    /// Un'estensione fatta di lettere e cifre ASCII, al più otto (la stessa regola con cui la coda nomina la copia in `file/`); altrimenti il ripiego.
    static func estensioneSicura(_ estensione: String, ripiego: String) -> String {
        let pulita = String(estensione.lowercased().filter { $0.isASCII && ($0.isLetter || $0.isNumber) }.prefix(8))
        return pulita.isEmpty ? ripiego : pulita
    }

    /// Il MIME dichiarato di un video: quello del sistema se ha la forma che il server accetta, altrimenti `video/mp4` (il server non si fida
    /// del MIME: l'autorità su che cosa sia il file è ffprobe).
    static func mimeDelVideo(_ tipo: UTType?) -> String {
        if let mime = tipo?.preferredMIMEType, mime.lowercased().hasPrefix("video/"), KVPoliticaCaricamento.contentTypeAmmesso(mime) { return mime }
        return KVPoliticaCaricamento.mimeDiRipiego
    }

    // MARK: Un rifiuto

    /// Il nome da mostrare per uno schermo, da 1 a 255 unità UTF-16 (come `schemaNome`). Se il sistema non ne dà uno, o non resta niente dopo aver tolto
    /// gli spazi, un ripiego che dice che cos'era: «Foto», «Video», «File» (gli stessi di Android).
    static func nomeDaMostrare(_ nome: String?, genere: KVGenereElemento) -> String {
        guard let nome = nome, !nome.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            switch genere {
            case .foto: return "Foto"
            case .video: return KVPoliticaCaricamento.nomeDiRipiego
            case .altro: return "File"
            }
        }
        return KVPoliticaCaricamento.nomePerIlPonte(nome)
    }

    /// Un elemento rifiutato per `motivo`, con la copia (se c'è) cancellata: un rifiuto non lascia niente sul telefono.
    func rifiuta(file: URL?, nome: String?, genere: KVGenereElemento, motivo: KVMotivoRifiuto) -> KVElementoScelto {
        if let file = file { rimuovi(file) }
        return .rifiutato(KVElementoRifiutato(id: nuovoId(), nome: Self.nomeDaMostrare(nome, genere: genere), origine: genere, motivo: motivo))
    }

    // MARK: Un video

    /// Prepara un video dal file che il sistema ha consegnato. Il file è NOSTRO: si sposta in `scelti/<id>.<ext>` o si cancella, mai si lascia
    /// dov'era. `avanzamento` riceve i byte dell'impronta già letti; `annullata` si chiede a ogni blocco. Restituisce `nil` se si è annullato (e
    /// non lascia niente), altrimenti il video o il suo rifiuto.
    ///
    /// L'ordine fa costare ai rifiuti il meno possibile: prima il peso e lo spazio (niente da leggere), poi lo spostamento (un rinominare),
    /// poi la durata (l'intestazione), e SOLO per ciò che entra l'impronta, che è la parte lunga (1,9 GB sono secondi di lettura).
    func preparaVideo(daFile sorgente: URL, nome: String?, origine: KVOrigineCaricamento, opzioni: KVOpzioniScelta,
                      avanzamento: (Int64) -> Void, annullata: () -> Bool) -> KVElementoScelto? {
        var presente = sorgente
        func rifiuto(_ motivo: KVMotivoRifiuto) -> KVElementoScelto {
            return rifiuta(file: presente, nome: nome, genere: .video, motivo: motivo)
        }
        func abbandona() -> KVElementoScelto? {
            rimuovi(presente)
            return nil
        }

        let peso: Int64
        switch leggiPeso(sorgente) {
        case .nonLetto(let errore):
            // La consegna del sistema non ha funzionato (il file non c'è, non si legge): un guasto che si scrive, non un video rotto.
            registro?.registraPreparazioneFallita(motivo: .copia, tipo: .video, errorCode: .sistema(errore))
            return rifiuto(.illeggibile)
        case .peso(let letto):
            peso = letto
        }
        if peso <= 0 { return rifiuto(.illeggibile) }
        if peso > opzioni.byteMassimiVideo { return rifiuto(.troppoGrande) }
        if !Self.spazioSufficiente(disponibile: spazioDisponibile(), peso: peso) { return rifiuto(.spazioInsufficiente) }
        if annullata() { return abbandona() }

        let id = nuovoId()
        let tipo = Self.tipoDelFile(sorgente)
        let estensione = Self.estensioneSicura(tipo?.preferredFilenameExtension ?? sorgente.pathExtension, ripiego: "mov")
        let destinazione = cartellaScelti.appendingPathComponent("\(id).\(estensione)")
        do {
            try FileManager.default.moveItem(at: sorgente, to: destinazione)
        } catch {
            let e = KVErroreSistema(error)
            if e.dominio == .cocoa && e.codice == 640 { return rifiuto(.spazioInsufficiente) }
            // Lo spostamento non è riuscito: di solito perché la cartella che ci ha consegnato il file non si può modificare (un file si sposta togliendolo
            // di lì). Un video rifiutato per questo sarebbe un video rifiutato SEMPRE, su quel telefono: si copia. Costa spazio e tempo, ma lo spazio è già
            // stato controllato (peso + margine, ed è proprio la regola di §5.5). La sorgente non si tocca: se non si poteva spostare non si può nemmeno
            // togliere, e il file temporaneo di una galleria lo toglie il sistema quando il completamento ritorna.
            diagnostica.info("spostamento del video non riuscito: dominio \(e.dominio.rawValue, privacy: .public) codice \(e.codice, privacy: .public), si copia")
            do {
                try FileManager.default.copyItem(at: sorgente, to: destinazione)
            } catch {
                let c = KVErroreSistema(error)
                rimuovi(destinazione)
                if c.dominio == .cocoa && c.codice == 640 { return rifiuto(.spazioInsufficiente) }
                registro?.registraPreparazioneFallita(motivo: .copia, tipo: .video, errorCode: .sistema(c))
                return rifiuto(.illeggibile)
            }
        }
        presente = destinazione
        proteggi(destinazione)
        if annullata() { return abbandona() }

        let lettura = Self.leggiIlVideo(destinazione, tipo: tipo)
        if lettura.illeggibile { return rifiuto(.illeggibile) }
        if let durata = lettura.durata, durata > Double(opzioni.durataMassimaVideoSecondi) { return rifiuto(.troppoLungo) }

        let impronta: String
        switch Self.calcolaImpronta(di: destinazione, pesoAtteso: peso, avanzamento: avanzamento, annullata: annullata) {
        case .annullata:
            return abbandona()
        case .fallita(let errore):
            registro?.registraPreparazioneFallita(motivo: .impronta, tipo: .video, errorCode: errore.map { KVErrorCode.sistema($0) })
            return rifiuto(.illeggibile)
        case .fatta(let esadecimale):
            impronta = esadecimale
        }
        if annullata() { return abbandona() }

        let elemento = KVElementoVideo(id: id, nome: Self.nomeDaMostrare(nome, genere: .video), byte: peso,
                                       mime: Self.mimeDelVideo(tipo), durataSecondi: lettura.durata,
                                       miniatura: miniatura(di: destinazione, durata: lettura.durata, riproducibile: lettura.riproducibile),
                                       sha256: impronta, origine: origine, estensione: estensione, creatoIl: orologio())
        ricorda(elemento)
        return .video(elemento)
    }

    // MARK: Una foto

    /// Prepara una foto dal file che il sistema ha consegnato: la riduce a JPEG in `scelti/<id>.jpg` e CANCELLA la sorgente (è nostra). `nil` se
    /// si è annullato. Una foto che non si legge, o che il sistema non conosce, torna come rifiuto.
    func preparaFoto(daFile sorgente: URL, nome: String?, opzioni: KVOpzioniScelta, annullata: () -> Bool) -> KVElementoScelto? {
        defer { rimuovi(sorgente) }
        if annullata() { return nil }
        let id = nuovoId()
        let nomeSchermo = Self.nomeDaMostrare(nome, genere: .foto)
        let destinazione = cartellaScelti.appendingPathComponent("\(id).jpg")
        func rifiuto(_ motivo: KVMotivoRifiuto) -> KVElementoScelto {
            return .rifiutato(KVElementoRifiutato(id: id, nome: nomeSchermo, origine: .foto, motivo: motivo))
        }
        switch KVElaborazioneFoto.riduci(da: sorgente, latoMassimo: opzioni.latoMassimoFoto, qualita: opzioni.qualitaFoto, verso: destinazione) {
        case .ridotta(let foto):
            proteggi(destinazione)
            if annullata() {
                rimuovi(destinazione)
                return nil
            }
            return .foto(KVElementoFoto(id: id, nome: nomeSchermo, larghezza: foto.larghezza, altezza: foto.altezza, byte: foto.byte))
        case .formatoNonRiconosciuto:
            return rifiuto(.formatoNonSupportato)
        case .illeggibile:
            return rifiuto(.illeggibile)
        case .sorgenteNonLetta(let errore):
            registro?.registraPreparazioneFallita(motivo: .copia, tipo: .foto, errorCode: .sistema(errore))
            return rifiuto(.illeggibile)
        case .riduzioneFallita:
            registro?.registraPreparazioneFallita(motivo: .riduzione, tipo: .foto, errorCode: nil)
            return rifiuto(.illeggibile)
        case .scritturaFallita(let errore):
            rimuovi(destinazione)
            if let errore = errore, errore.dominio == .cocoa, errore.codice == 640 { return rifiuto(.spazioInsufficiente) }
            registro?.registraPreparazioneFallita(motivo: .copia, tipo: .foto, errorCode: errore.map { KVErrorCode.sistema($0) })
            return rifiuto(.illeggibile)
        }
    }

    // MARK: Il video: durata, leggibilità, impronta, miniatura

    struct LetturaVideo: Equatable {
        /// `nil` se il sistema non sa dirla: mai zero, mai negativa (lo schema del ponte vuole un numero positivo).
        var durata: Double?
        /// Un contenitore che conosciamo (QuickTime, MP4) in cui AVFoundation non trova NIENTE: il segno di un file troncato (l'indice `moov`
        /// sta in fondo, e una registrazione interrotta non l'ha scritto). Un contenitore che AVFoundation non conosce (MKV, AVI) NON è
        /// illeggibile: lo converte il server.
        var illeggibile: Bool
        var riproducibile: Bool
    }

    static func leggiIlVideo(_ url: URL, tipo: UTType?) -> LetturaVideo {
        let asset = AVURLAsset(url: url)
        let durata = asset.duration
        let secondi = CMTimeGetSeconds(durata)
        let durataNota = durata.isValid && durata.isNumeric && secondi.isFinite && secondi > 0
        let conosciuto = tipo.map { $0.conforms(to: .quickTimeMovie) || $0.conforms(to: .mpeg4Movie) } ?? false
        return LetturaVideo(durata: durataNota ? secondi : nil, illeggibile: conosciuto && asset.tracks.isEmpty && !durataNota,
                            riproducibile: asset.isPlayable)
    }

    enum EsitoImpronta: Equatable {
        case fatta(String)
        case annullata
        /// La lettura è fallita (l'errore di sistema, se c'è) o il file non ha i byte che aveva.
        case fallita(KVErroreSistema?)
    }

    /// Lo SHA-256 di un file, esadecimale minuscolo, letto a blocchi (mai il file intero in memoria). `avanzamento` riceve i byte letti dopo
    /// ogni blocco; `annullata` si chiede prima di ogni lettura. Se alla fine i byte letti non sono `pesoAtteso` il file è cambiato sotto i
    /// piedi, e l'impronta non descriverebbe ciò che parte: `fallita`.
    static func calcolaImpronta(di url: URL, pesoAtteso: Int64, blocco: Int = bloccoImprontaByte, avanzamento: (Int64) -> Void,
                                annullata: () -> Bool) -> EsitoImpronta {
        let lettore: FileHandle
        do {
            lettore = try FileHandle(forReadingFrom: url)
        } catch {
            return .fallita(KVErroreSistema(error))
        }
        var sha = SHA256()
        var letti: Int64 = 0
        var esito: EsitoImpronta?
        do {
            while esito == nil {
                if annullata() {
                    esito = .annullata
                    break
                }
                let finito: Bool = try autoreleasepool {
                    guard let dati = try lettore.read(upToCount: blocco), !dati.isEmpty else { return true }
                    sha.update(data: dati)
                    letti += Int64(dati.count)
                    avanzamento(letti)
                    return false
                }
                if finito { break }
            }
        } catch {
            esito = .fallita(KVErroreSistema(error))
        }
        do {
            try lettore.close()
        } catch {
            let e = KVErroreSistema(error)
            Logger(subsystem: Bundle.main.bundleIdentifier ?? "it.kidville.app", category: "caricamenti-selettore")
                .info("chiusura del file dell'impronta non riuscita: dominio \(e.dominio.rawValue, privacy: .public) codice \(e.codice, privacy: .public)")
        }
        if let esito = esito { return esito }
        guard letti == pesoAtteso else { return .fallita(nil) }
        return .fatta(sha.finalize().map { String(format: "%02x", $0) }.joined())
    }

    /// La miniatura di un video: un fotogramma a circa un secondo (o a metà, se è più corto), al più `latoMiniatura` pixel, JPEG senza metadati,
    /// come data URL. `nil` se non si è potuta fare: il contratto lo ammette. Se il video si riproduce e la miniatura non esce è un guasto
    /// nostro (si scrive); se il sistema nemmeno lo riproduce non lo è (un formato che converte il server).
    private func miniatura(di url: URL, durata: Double?, riproducibile: Bool) -> String? {
        let generatore = AVAssetImageGenerator(asset: AVURLAsset(url: url))
        generatore.appliesPreferredTrackTransform = true
        generatore.maximumSize = CGSize(width: Self.latoMiniatura, height: Self.latoMiniatura)
        generatore.requestedTimeToleranceBefore = .positiveInfinity
        generatore.requestedTimeToleranceAfter = .positiveInfinity
        let istante = CMTime(seconds: min(1.0, (durata ?? 0) / 2), preferredTimescale: 600)
        let errore: KVErroreSistema?
        do {
            let immagine = try generatore.copyCGImage(at: istante, actualTime: nil)
            if let piccola = KVElaborazioneFoto.ridimensionata(immagine, latoMassimo: Self.latoMiniatura),
               let jpeg = KVElaborazioneFoto.codificaJPEG(piccola, qualita: KVElaborazioneFoto.qualitaMiniatura) {
                return "data:image/jpeg;base64," + jpeg.base64EncodedString()
            }
            errore = nil
        } catch {
            errore = KVErroreSistema(error)
        }
        if riproducibile {
            registro?.registraPreparazioneFallita(motivo: .miniatura, tipo: .video, errorCode: errore.map { KVErrorCode.sistema($0) })
        } else {
            // Non è un guasto nostro: il sistema non riproduce questo video (un formato che converte il server), e senza fotogramma non c'è miniatura.
            diagnostica.info("miniatura non fatta: il sistema non riproduce il video")
        }
        return nil
    }

    // MARK: I preparati: ricordo, lettura, scarto

    /// Il video preparato con quell'id, se questa sessione dell'app lo ha preparato (e non è passato più di 48 ore). `accodaVideo` lo confronta
    /// con ciò che il JavaScript dichiara (`sha256`, `byteAttesi`): un elemento che non coincide non parte.
    func video(conId id: String) -> KVElementoVideo? {
        serratura.lock(); defer { serratura.unlock() }
        guard let ricordo = ricordi[id], orologio().timeIntervalSince(ricordo.creatoIl) <= Self.vitaMassimaRicordoSecondi else { return nil }
        return ricordo
    }

    /// Il preparato (`scelti/<id>.<ext>`), se c'è ancora.
    func preparato(conId id: String) -> URL? {
        return coda.trovaScelto(id: id)
    }

    private func ricorda(_ elemento: KVElementoVideo) {
        serratura.lock(); defer { serratura.unlock() }
        let ora = orologio()
        ricordi = ricordi.filter { ora.timeIntervalSince($0.value.creatoIl) <= Self.vitaMassimaRicordoSecondi }
        ricordi[elemento.id] = elemento
    }

    private func dimentica(_ id: String) {
        serratura.lock(); defer { serratura.unlock() }
        ricordi.removeValue(forKey: id)
    }

    /// `scartaScelti`: toglie i preparati con quegli id da `scelti/`. Gli id che non hanno la forma giusta, quelli che non ci sono e quelli di un
    /// video già preso in carico (la sua copia sta in `file/`, che di qui non si tocca mai) si ignorano. Restituisce quanti ne ha tolti.
    @discardableResult
    func scarta(ids: [String]) -> Int {
        var eliminati = 0
        for id in ids where KVPoliticaCaricamento.idElementoValido(id) {
            let tolti = coda.rimuoviScelti(ids: [id])
            if tolti > 0 {
                eliminati += tolti
                dimentica(id)
            }
        }
        return eliminati
    }

    enum LetturaFoto: Equatable {
        /// `base64` standard col suo padding e senza a capo; `byte` sono quelli del file, non della stringa.
        case letta(base64: String, byte: Int, larghezza: Int, altezza: Int)
        case assente
        case fallita
    }

    /// `leggiFoto`: la foto ridotta in base64 E LA CANCELLA (una lettura sola: il JavaScript ne fa un `File`). Solo i preparati `.jpg`: l'id di
    /// un video non cancella mai il video.
    func leggiFoto(id: String) -> LetturaFoto {
        guard KVPoliticaCaricamento.idElementoValido(id), let url = coda.trovaScelto(id: id), url.pathExtension == "jpg" else { return .assente }
        let dati: Data
        do {
            dati = try Data(contentsOf: url)
        } catch {
            segnala("foto preparata non letta", error)
            return .fallita
        }
        guard !dati.isEmpty, let misure = KVElaborazioneFoto.dimensioni(diFile: url) else { return .fallita }
        rimuovi(url)
        return .letta(base64: dati.base64EncodedString(), byte: dati.count, larghezza: misure.larghezza, altezza: misure.altezza)
    }

    // MARK: Il file system

    /// Il peso di un file, o l'errore di sistema se non si legge (sparito, permessi). Un file che non c'è non pesa zero: chi decide che cosa farne è
    /// il chiamante, che distingue «vuoto» (un rifiuto atteso) da «non si legge» (una consegna che non ha funzionato: va nel log).
    func leggiPeso(_ url: URL) -> LetturaPeso {
        do {
            return .peso((try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value ?? 0)
        } catch {
            segnala("peso di un file non letto", error)
            return .nonLetto(KVErroreSistema(error))
        }
    }

    enum LetturaPeso: Equatable {
        case peso(Int64)
        case nonLetto(KVErroreSistema)
    }

    /// Il peso, per chi non ha bisogno di sapere perché manca (l'errore è già nel log di sistema).
    func pesoDelFile(_ url: URL) -> Int64? {
        if case .peso(let peso) = leggiPeso(url) { return peso }
        return nil
    }

    private func proteggi(_ url: URL) {
        coda.proteggi(url)
    }

    /// Cancella un file nostro; se non c'è già, niente da dire.
    func rimuovi(_ url: URL) {
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        do {
            try FileManager.default.removeItem(at: url)
        } catch {
            segnala("file preparato non cancellato", error)
        }
    }

    /// Un guasto del file system lascia un segno nel log di sistema: SOLO dominio e codice numerico, mai il testo dell'errore né un percorso.
    private func segnala(_ cosa: StaticString, _ errore: Error) {
        let e = KVErroreSistema(errore)
        diagnostica.error("\(cosa, privacy: .public): dominio \(e.dominio.rawValue, privacy: .public) codice \(e.codice, privacy: .public)")
    }

    // MARK: Un elemento di prova (solo Debug)

    #if DEBUG
    /// Il blocco in cui si scrive un elemento di prova.
    static let bloccoProvaByte = 1024 * 1024

    /// Un video di BYTE CASUALI del peso chiesto, già preparato (con il suo `sha256`): serve al collaudo del motore (C1), che non ha bisogno di un
    /// filmato vero ma di byte veri da spedire. Non c'è nelle build Release e non è fra i metodi di `METODI_PLUGIN_CARICAMENTI`. Il nome è di una
    /// forma riconoscibile (`collaudo-<8 cifre>.mp4`) che nessun messaggio di log può contenere per caso. Con poco spazio torna il rifiuto
    /// `spazio-insufficiente`, senza aver scritto un byte.
    func creaProva(byte: Int64) -> KVElementoScelto {
        let id = nuovoId()
        let nome = "collaudo-\(id.prefix(8)).mp4"
        guard byte >= 1 else { return rifiuta(file: nil, nome: nome, genere: .video, motivo: .illeggibile) }
        if !Self.spazioSufficiente(disponibile: spazioDisponibile(), peso: byte) {
            return rifiuta(file: nil, nome: nome, genere: .video, motivo: .spazioInsufficiente)
        }
        let destinazione = cartellaScelti.appendingPathComponent("\(id).mp4")
        guard FileManager.default.createFile(atPath: destinazione.path, contents: nil) else {
            registro?.registraPreparazioneFallita(motivo: .copia, tipo: .video, errorCode: nil)
            return rifiuta(file: nil, nome: nome, genere: .video, motivo: .illeggibile)
        }
        proteggi(destinazione)
        var sha = SHA256()
        do {
            let scrittore = try FileHandle(forWritingTo: destinazione)
            var restanti = byte
            var blocco = [UInt8](repeating: 0, count: Self.bloccoProvaByte)
            while restanti > 0 {
                let n = Int(min(Int64(blocco.count), restanti))
                blocco.withUnsafeMutableBytes { arc4random_buf($0.baseAddress, n) }
                let dati = Data(blocco[0..<n])
                try scrittore.write(contentsOf: dati)
                sha.update(data: dati)
                restanti -= Int64(n)
            }
            try scrittore.close()
        } catch {
            let e = KVErroreSistema(error)
            rimuovi(destinazione)
            if e.dominio == .cocoa && e.codice == 640 { return rifiuta(file: nil, nome: nome, genere: .video, motivo: .spazioInsufficiente) }
            registro?.registraPreparazioneFallita(motivo: .copia, tipo: .video, errorCode: .sistema(e))
            return rifiuta(file: nil, nome: nome, genere: .video, motivo: .illeggibile)
        }
        let elemento = KVElementoVideo(id: id, nome: nome, byte: byte, mime: KVPoliticaCaricamento.mimeDiRipiego, durataSecondi: nil, miniatura: nil,
                                       sha256: sha.finalize().map { String(format: "%02x", $0) }.joined(), origine: .prova, estensione: "mp4",
                                       creatoIl: orologio())
        ricorda(elemento)
        return .video(elemento)
    }
    #endif
}

// MARK: - Il selettore (schermo e sessione)

/// Come è andato l'avvio di una scelta.
enum KVAvvioScelta: Equatable {
    /// La sessione è partita: l'esito arriva dal completamento.
    case avviata
    /// Ce n'è già una (aperta o in preparazione): `GIA_IN_CORSO`.
    case giaInCorso
}

/// Come finisce una sessione di scelta.
enum KVEsitoSelettore: Equatable {
    /// Gli elementi pronti, oppure `annullato` (selettore chiuso senza scelta, o «Annulla»): un annullamento non porta MAI elementi, perché le
    /// copie parziali si sono cancellate e un elemento consegnato insieme ad `annullato` non lo scarterebbe nessuno.
    case completata(annullato: Bool, elementi: [KVElementoScelto])
    /// Non c'è una schermata da cui aprire il selettore, o non si è aperto: `SELETTORE_NON_DISPONIBILE`.
    case nonDisponibile
    /// La cartella dei preparati non si crea: `INTERNO`.
    case interno
}

final class KVSelettoreMedia: NSObject, PHPickerViewControllerDelegate, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {

    // MARK: Numeri

    /// L'avanzamento arriva al JavaScript al più ogni quarto di secondo (salvo quando cambia il numero degli elementi fatti).
    static let intervalloAvanzamento: TimeInterval = 0.25
    /// Dopo un «Annulla», quanto si aspetta ancora che il sistema consegni (con un errore) il file che stava preparando. Di solito risponde subito; se non
    /// risponde, si smette di aspettare: la coda di sfondo è una sola e non deve restare appesa per tutte le scelte che verranno.
    static let attesaDopoAnnullamentoSecondi: TimeInterval = 3
    /// Se il selettore non si è mostrato entro questo tempo la presentazione è fallita (il sistema scarta una presentazione che si sovrappone a
    /// un'altra, senza dirlo): la chiamata si chiude invece di restare appesa. Dieci secondi: il primo avvio del selettore di sistema, a freddo, può
    /// metterne due o tre, e un errore falso è peggio di una attesa lunga.
    static let attesaPresentazioneSecondi: TimeInterval = 10

    // MARK: Tipi interni

    private enum Fase {
        case apertura
        case selezione
        case preparazione
    }

    private enum Lavoro {
        case oggetto(NSItemProvider)
        case file(URL)
    }

    private final class Sessione {
        let opzioni: KVOpzioniScelta
        let avanzamento: (KVAvanzamentoPreparazione) -> Void
        let completamento: (KVEsitoSelettore) -> Void
        var fase: Fase = .apertura
        var finita = false
        var annullata = false
        var presentato = false
        var picker: UIViewController?
        var progresso: Progress?
        var totali = 0
        var fatti = 0
        var byteFatti: Int64 = 0
        var byteTotali: Int64?
        var ultimaEmissione = Date.distantPast
        var preparati: [KVElementoScelto] = []

        init(opzioni: KVOpzioniScelta, avanzamento: @escaping (KVAvanzamentoPreparazione) -> Void, completamento: @escaping (KVEsitoSelettore) -> Void) {
            self.opzioni = opzioni
            self.avanzamento = avanzamento
            self.completamento = completamento
        }
    }

    /// Un risultato che scrive un thread e legge un altro dopo un semaforo: il semaforo è la barriera, la scatola è solo dove si posa.
    private final class Cassetto<T>: @unchecked Sendable {
        var valore: T?
    }

    // MARK: Stato

    /// Come si chiede al sistema il FILE di un oggetto della galleria: `loadFileRepresentation`, che restituisce il `Progress` con cui si annulla. È una
    /// funzione iniettabile solo perché l'harness possa provare un sistema che non risponde più (che il vero non fa, ma una coda di sfondo appesa
    /// per sempre costerebbe tutte le scelte successive).
    typealias CaricatoreDiFile = (NSItemProvider, String, @escaping (URL?, Error?) -> Void) -> Progress

    static let caricatoreDiSistema: CaricatoreDiFile = { oggetto, identificativo, completamento in
        oggetto.loadFileRepresentation(forTypeIdentifier: identificativo, completionHandler: completamento)
    }

    private let coda: KVCodaCaricamenti
    private let preparazione: KVPreparazioneMedia
    private let registro: KVRegistroNativo?
    private let caricaFile: CaricatoreDiFile
    private let serratura = NSLock()
    private var sessione: Sessione?
    private let lavoroDiSfondo = DispatchQueue(label: "it.kidville.caricamenti.selettore", qos: .userInitiated)

    init(coda: KVCodaCaricamenti, preparazione: KVPreparazioneMedia, registro: KVRegistroNativo?,
         caricaFile: @escaping CaricatoreDiFile = KVSelettoreMedia.caricatoreDiSistema) {
        self.coda = coda
        self.preparazione = preparazione
        self.registro = registro
        self.caricaFile = caricaFile
        super.init()
    }

    // MARK: Avvio

    /// Apre il selettore. Si può chiamare da un thread qualunque; `presentatore` (che dà la schermata da cui aprire) e la presentazione girano sul
    /// thread principale. L'esito arriva UNA volta dal `completamento`, su un thread qualunque.
    func scegli(opzioni: KVOpzioniScelta, presentatore: @escaping () -> UIViewController?,
                avanzamento: @escaping (KVAvanzamentoPreparazione) -> Void,
                completamento: @escaping (KVEsitoSelettore) -> Void) -> KVAvvioScelta {
        guard let nuova = apriSessione(opzioni: opzioni, fase: .apertura, avanzamento: avanzamento, completamento: completamento) else {
            return .giaInCorso
        }
        DispatchQueue.main.async { self.presenta(nuova, da: presentatore()) }
        return .avviata
    }

    /// Prepara gli oggetti che il selettore di GALLERIA ha consegnato, come se l'insegnante li avesse appena scelti: da qui in poi la sessione è
    /// quella di sempre. È ciò che fa il delegato di PHPicker con i suoi risultati, ed è l'ingresso con cui l'harness prova la sessione intera
    /// (ordine, avanzamento, annullamento, pulizia) senza schermo: un `NSItemProvider(contentsOf:)` sta al posto di un risultato del selettore.
    func consegnaOggetti(_ oggetti: [NSItemProvider], opzioni: KVOpzioniScelta, avanzamento: @escaping (KVAvanzamentoPreparazione) -> Void,
                         completamento: @escaping (KVEsitoSelettore) -> Void) -> KVAvvioScelta {
        guard let nuova = apriSessione(opzioni: opzioni, fase: .selezione, avanzamento: avanzamento, completamento: completamento) else {
            return .giaInCorso
        }
        consegna(oggetti: oggetti, a: nuova)
        return .avviata
    }

    /// Lo stesso per «Scegli da File»: i file sono copie nostre nella cartella temporanea (`asCopy: true`).
    func consegnaFile(_ file: [URL], opzioni: KVOpzioniScelta, avanzamento: @escaping (KVAvanzamentoPreparazione) -> Void,
                      completamento: @escaping (KVEsitoSelettore) -> Void) -> KVAvvioScelta {
        guard let nuova = apriSessione(opzioni: opzioni, fase: .selezione, avanzamento: avanzamento, completamento: completamento) else {
            return .giaInCorso
        }
        consegna(file: file, a: nuova)
        return .avviata
    }

    /// Una sessione per volta: se ce n'è già una (selettore aperto o preparazione in corso) non se ne apre un'altra.
    private func apriSessione(opzioni: KVOpzioniScelta, fase: Fase, avanzamento: @escaping (KVAvanzamentoPreparazione) -> Void,
                              completamento: @escaping (KVEsitoSelettore) -> Void) -> Sessione? {
        serratura.lock(); defer { serratura.unlock() }
        if sessione != nil { return nil }
        let nuova = Sessione(opzioni: opzioni, avanzamento: avanzamento, completamento: completamento)
        nuova.fase = fase
        sessione = nuova
        return nuova
    }

    /// `annullaScelta`: ferma la sessione. Con il selettore ancora aperto lo chiude; durante la preparazione ferma il file in corso (`Progress.cancel()`)
    /// e fa cancellare ogni copia. In ogni caso la scelta si risolve SUBITO con `annullato`: ciò che resta da fare lo fa la coda di sfondo, da sola.
    /// Restituisce `false` se non c'era niente da annullare.
    @discardableResult
    func annulla() -> Bool {
        serratura.lock()
        guard let corrente = sessione, !corrente.finita else {
            serratura.unlock()
            return false
        }
        corrente.annullata = true
        let progresso = corrente.progresso
        let selettore = corrente.picker
        let eraAperto = corrente.fase != .preparazione
        serratura.unlock()
        progresso?.cancel()
        if eraAperto, let selettore = selettore {
            DispatchQueue.main.async { selettore.dismiss(animated: true) }
        }
        if eraAperto {
            finisci(corrente, .completata(annullato: true, elementi: []))
        } else {
            // In preparazione: gli elementi già pronti non li vedrà nessuno, e vanno tolti PRIMA di dire «annullato».
            scartaPreparati(di: corrente)
            finisci(corrente, .completata(annullato: true, elementi: []))
        }
        return true
    }

    // MARK: Presentazione (thread principale)

    private func presenta(_ s: Sessione, da controller: UIViewController?) {
        guard !isFinita(s) else { return }
        guard coda.preparaCartelle() else {
            finisci(s, .interno)
            return
        }
        guard let controller = controller else {
            finisci(s, .nonDisponibile)
            return
        }
        let selettore: UIViewController
        switch s.opzioni.sorgente {
        case .galleria:
            // `PHPickerConfiguration()` SENZA libreria: niente `assetIdentifier` e nessun permesso (il selettore gira fuori dal nostro processo).
            var configurazione = PHPickerConfiguration()
            configurazione.filter = .any(of: [.images, .videos])
            configurazione.selection = .ordered
            configurazione.selectionLimit = s.opzioni.massimoElementi
            // `.current` conserva i tagli fatti in Foto e non ricodifica quando non serve.
            configurazione.preferredAssetRepresentationMode = .current
            let galleria = PHPickerViewController(configuration: configurazione)
            galleria.delegate = self
            selettore = galleria
        case .file:
            // `asCopy: true`: i file arrivano come copie nella cartella temporanea dell'app, nostre da spostare o cancellare; nessun accesso a risorse
            // «con ambito di sicurezza» da aprire e chiudere.
            let documenti = UIDocumentPickerViewController(forOpeningContentTypes: [.movie, .image], asCopy: true)
            documenti.allowsMultipleSelection = true
            documenti.delegate = self
            selettore = documenti
        }
        selettore.presentationController?.delegate = self
        serratura.lock()
        s.picker = selettore
        s.fase = .selezione
        serratura.unlock()
        controller.present(selettore, animated: true) { [weak self] in
            guard let self = self else { return }
            self.serratura.lock()
            s.presentato = true
            self.serratura.unlock()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.attesaPresentazioneSecondi) { [weak self] in
            guard let self = self else { return }
            self.serratura.lock()
            let mostrato = s.presentato
            self.serratura.unlock()
            if !mostrato && !self.isFinita(s) {
                // Se il selettore compare in ritardo, non deve restare sullo schermo senza che nessuno ne aspetti la scelta.
                s.picker?.dismiss(animated: false)
                self.finisci(s, .nonDisponibile)
            }
        }
    }

    // MARK: Delegati

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard let s = sessione(di: picker) else { return }
        consegna(oggetti: results.map { $0.itemProvider }, a: s)
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let s = sessione(di: controller) else { return }
        consegna(file: urls, a: s)
    }

    private func consegna(oggetti: [NSItemProvider], a s: Sessione) {
        if oggetti.isEmpty {
            finisci(s, .completata(annullato: true, elementi: []))
            return
        }
        // La galleria non sa dire i pesi prima di consegnare ogni file: il totale dei byte non si conosce.
        avvia(s, lavori: oggetti.map { Lavoro.oggetto($0) }, byteTotali: nil)
    }

    private func consegna(file urls: [URL], a s: Sessione) {
        if urls.isEmpty {
            finisci(s, .completata(annullato: true, elementi: []))
            return
        }
        // I file sono già copie nella cartella temporanea: i pesi si conoscono in anticipo.
        let totale = urls.reduce(into: Int64(0)) { somma, url in somma += preparazione.pesoDelFile(url) ?? 0 }
        avvia(s, lavori: urls.map { Lavoro.file($0) }, byteTotali: totale)
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        guard let s = sessione(di: controller) else { return }
        finisci(s, .completata(annullato: true, elementi: []))
    }

    /// Chiusura per trascinamento (il gesto verso il basso sul foglio): vale «annullato». Non scatta per le chiusure fatte da noi.
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        serratura.lock()
        let s = sessione
        let aperta = s?.fase == .selezione && s?.picker === presentationController.presentedViewController
        serratura.unlock()
        guard let sessioneAperta = s, aperta else { return }
        finisci(sessioneAperta, .completata(annullato: true, elementi: []))
    }

    private func sessione(di selettore: UIViewController) -> Sessione? {
        serratura.lock(); defer { serratura.unlock() }
        guard let s = sessione, !s.finita, s.picker === selettore, s.fase == .selezione else { return nil }
        return s
    }

    // MARK: Preparazione (coda di sfondo)

    private func avvia(_ s: Sessione, lavori: [Lavoro], byteTotali: Int64?) {
        serratura.lock()
        s.fase = .preparazione
        s.totali = lavori.count
        s.byteTotali = byteTotali
        serratura.unlock()
        emetti(s, forza: true)
        lavoroDiSfondo.async { self.prepara(s, lavori: lavori) }
    }

    /// Gli elementi UNO ALLA VOLTA: due video da 2 GB insieme sarebbero il doppio dei picchi di memoria e di disco, e la scelta non ha fretta.
    private func prepara(_ s: Sessione, lavori: [Lavoro]) {
        for (indice, lavoro) in lavori.enumerated() {
            if eAnnullata(s) {
                // I file di «Scegli da File» che non si sono nemmeno cominciati sono copie nostre nella cartella temporanea: si tolgono.
                for restante in lavori[indice...] {
                    if case .file(let url) = restante { preparazione.rimuovi(url) }
                }
                break
            }
            let pesoSorgente = pesoDi(lavoro)
            let elemento: KVElementoScelto?
            switch lavoro {
            case .oggetto(let provider): elemento = elaboraOggetto(provider, sessione: s)
            case .file(let url): elemento = elaboraFile(url, sessione: s)
            }
            serratura.lock()
            if let elemento = elemento { s.preparati.append(elemento) }
            s.fatti += 1
            // I byte lavorati: il peso della sorgente se si conosceva prima (i file), altrimenti quello dell'elemento (la galleria).
            s.byteFatti += pesoSorgente > 0 ? pesoSorgente : (elemento.map { Self.byteDi($0) } ?? 0)
            serratura.unlock()
            emetti(s, forza: true)
        }
        if eAnnullata(s) {
            // Qualunque cosa sia uscita dopo il «annullato» (un elemento finito proprio mentre si annullava) non la vedrà nessuno.
            scartaPreparati(di: s)
            finisci(s, .completata(annullato: true, elementi: []))
            return
        }
        serratura.lock()
        let tutti = s.preparati
        serratura.unlock()
        finisci(s, .completata(annullato: false, elementi: tutti))
    }

    private func pesoDi(_ lavoro: Lavoro) -> Int64 {
        switch lavoro {
        case .oggetto: return 0
        case .file(let url): return preparazione.pesoDelFile(url) ?? 0
        }
    }

    private static func byteDi(_ elemento: KVElementoScelto) -> Int64 {
        switch elemento {
        case .foto(let e): return e.byte
        case .video(let e): return e.byte
        case .rifiutato: return 0
        }
    }

    /// Un elemento dell'oggetto che il selettore di galleria consegna: si chiede al sistema il FILE (`loadFileRepresentation`) e si lavora DENTRO il
    /// suo completamento, perché il file temporaneo vive solo fin lì. Si aspetta quel completamento (semaforo): la coda di sfondo è nostra, e il
    /// completamento gira su una del sistema, quindi non si incrociano.
    private func elaboraOggetto(_ provider: NSItemProvider, sessione s: Sessione) -> KVElementoScelto? {
        let nome = provider.suggestedName
        // Prima le immagini: una Live Photo ha anche una parte video, ma per noi è una foto (il fermo immagine).
        let genere: KVGenereElemento
        let identificativo: String
        if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
            genere = .foto
            identificativo = UTType.image.identifier
        } else if provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) {
            genere = .video
            identificativo = UTType.movie.identifier
        } else {
            return preparazione.rifiuta(file: nil, nome: nome, genere: .altro, motivo: .formatoNonSupportato)
        }
        let semaforo = DispatchSemaphore(value: 0)
        let esito = Cassetto<KVElementoScelto?>()
        let progresso = caricaFile(provider, identificativo) { url, errore in
            defer { semaforo.signal() }
            esito.valore = .some(self.dalSistema(url: url, errore: errore, genere: genere, nome: nome, origine: .galleria, sessione: s))
        }
        serratura.lock()
        s.progresso = progresso
        let giaAnnullata = s.annullata
        serratura.unlock()
        if giaAnnullata { progresso.cancel() }
        // Si aspetta il completamento. Se nel frattempo si annulla e il sistema non lo consegna entro `attesaDopoAnnullamentoSecondi`, si smette di
        // aspettare: il completamento tardivo troverà la sessione annullata e toglierà da solo il suo file.
        var limiteDopoAnnullamento: Date?
        while semaforo.wait(timeout: .now() + 0.25) == .timedOut {
            guard eAnnullata(s) else { continue }
            let limite = limiteDopoAnnullamento ?? Date().addingTimeInterval(Self.attesaDopoAnnullamentoSecondi)
            limiteDopoAnnullamento = limite
            if Date() >= limite {
                serratura.lock()
                s.progresso = nil
                serratura.unlock()
                return nil
            }
        }
        serratura.lock()
        s.progresso = nil
        serratura.unlock()
        return esito.valore ?? nil
    }

    /// Un file di «Scegli da File» (già una copia nostra nella cartella temporanea): il tipo si ricava dall'estensione.
    private func elaboraFile(_ url: URL, sessione s: Sessione) -> KVElementoScelto? {
        let nome = url.deletingPathExtension().lastPathComponent
        let tipo = KVPreparazioneMedia.tipoDelFile(url)
        if tipo?.conforms(to: .image) == true {
            return dalSistema(url: url, errore: nil, genere: .foto, nome: nome, origine: .file, sessione: s)
        }
        if tipo?.conforms(to: .movie) == true {
            return dalSistema(url: url, errore: nil, genere: .video, nome: nome, origine: .file, sessione: s)
        }
        return preparazione.rifiuta(file: url, nome: nome, genere: .altro, motivo: .formatoNonSupportato)
    }

    /// Ciò che il sistema ha consegnato (un file o un errore) diventa un elemento. Gira dentro il completamento del selettore, o direttamente per
    /// i file di «Scegli da File».
    private func dalSistema(url: URL?, errore: Error?, genere: KVGenereElemento, nome: String?, origine: KVOrigineCaricamento,
                            sessione s: Sessione) -> KVElementoScelto? {
        if eAnnullata(s) {
            // Un annullamento fa fallire anche la consegna del file: non è un guasto, e un file già arrivato non lo vuole più nessuno.
            if let url = url { preparazione.rimuovi(url) }
            return nil
        }
        let tipoLog: KVTipoMedia = genere == .foto ? .foto : .video
        if let errore = errore {
            let (motivo, daLoggare) = KVPreparazioneMedia.motivoPerErrore(errore)
            if daLoggare { registro?.registraPreparazioneFallita(motivo: .copia, tipo: tipoLog, errorCode: .sistema(KVPreparazioneMedia.erroreDaLoggare(errore))) }
            return preparazione.rifiuta(file: url, nome: nome, genere: genere, motivo: motivo)
        }
        guard let url = url else {
            registro?.registraPreparazioneFallita(motivo: .interno, tipo: tipoLog, errorCode: nil)
            return preparazione.rifiuta(file: nil, nome: nome, genere: genere, motivo: .illeggibile)
        }
        switch genere {
        case .foto:
            return preparazione.preparaFoto(daFile: url, nome: nome, opzioni: s.opzioni, annullata: { self.eAnnullata(s) })
        case .video:
            return preparazione.preparaVideo(daFile: url, nome: nome, origine: origine, opzioni: s.opzioni,
                                             avanzamento: { byte in self.avanzaVideo(s, byte: byte) }, annullata: { self.eAnnullata(s) })
        case .altro:
            return preparazione.rifiuta(file: url, nome: nome, genere: .altro, motivo: .formatoNonSupportato)
        }
    }

    // MARK: Avanzamento

    private func avanzaVideo(_ s: Sessione, byte: Int64) {
        emetti(s, forza: false, byteInCorso: byte)
    }

    private func emetti(_ s: Sessione, forza: Bool, byteInCorso: Int64 = 0) {
        serratura.lock()
        let ora = Date()
        if !forza && ora.timeIntervalSince(s.ultimaEmissione) < Self.intervalloAvanzamento {
            serratura.unlock()
            return
        }
        s.ultimaEmissione = ora
        let evento = KVAvanzamentoPreparazione(fatti: s.fatti, totali: s.totali, byteCopiati: s.byteFatti + byteInCorso, byteTotali: s.byteTotali)
        let finita = s.finita
        serratura.unlock()
        if !finita { s.avanzamento(evento) }
    }

    // MARK: Chiusura

    private func isFinita(_ s: Sessione) -> Bool {
        serratura.lock(); defer { serratura.unlock() }
        return s.finita
    }

    private func eAnnullata(_ s: Sessione) -> Bool {
        serratura.lock(); defer { serratura.unlock() }
        return s.annullata
    }

    /// Chiude la sessione UNA volta (una seconda chiamata non fa niente) e consegna l'esito fuori dalla serratura.
    private func finisci(_ s: Sessione, _ esito: KVEsitoSelettore) {
        serratura.lock()
        if s.finita {
            serratura.unlock()
            return
        }
        s.finita = true
        if sessione === s { sessione = nil }
        serratura.unlock()
        s.completamento(esito)
    }

    /// Toglie dal telefono ogni elemento che la sessione ha preparato (annullamento): foto, video, e il ricordo dei video.
    private func scartaPreparati(di s: Sessione) {
        serratura.lock()
        let ids = s.preparati.compactMap { elemento -> String? in
            if case .rifiutato = elemento { return nil }
            return elemento.id
        }
        s.preparati = []
        serratura.unlock()
        preparazione.scarta(ids: ids)
    }
}
