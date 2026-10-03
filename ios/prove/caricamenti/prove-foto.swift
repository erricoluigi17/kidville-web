// Le prove del compito I3 («app 1.2», PR 3): il selettore, «Scegli da File», le foto ridotte, la facciata del plugin e la versione.
//
//   sh ios/prove/caricamenti/esegui.sh      (le lancia dopo la prova principale, in release e in debug)
//
// Perché sta in un PROGRAMMA A PARTE e non in `main.swift`: ha un suo `@main` (`-parse-as-library`) e compila solo i file di cui ha bisogno
// (`KVElaborazioneFoto`, `KVSelettoreMedia` e i tre che questi usano), così non tocca la prova principale, che altri compiti stanno modificando.
//
// Che cosa prova, sul codice di produzione e con FILE VERI (nessuna copia della logica):
//   1. la RIDUZIONE delle foto (`KVElaborazioneFoto`, §5.6): una HEIC da 48 megapixel GENERATA qui — con orientamento, EXIF, GPS e TIFF —
//      esce di al più 1920 px, dritta, e SENZA un solo metadato (si guardano i SEGMENTI del file JPEG, non solo ciò che il sistema ne ricava);
//      tutti gli otto orientamenti; la trasparenza su bianco; mai un ingrandimento; la qualità; i quattro modi di non riuscire;
//   2. la PREPARAZIONE dei video (`KVPreparazioneMedia`, §5.5): un filmato H.264 VERO scritto da AVAssetWriter (durata, miniatura dritta,
//      `sha256` confrontato con un SHA-256 indipendente), i rifiuti (troppo grande, troppo lungo, poco spazio al byte, file troncato, formato che
//      AVFoundation non conosce ma che si converte), l'annullamento, nessuna copia che resti, nessun nome nei log;
//   3. le foto preparate (`leggiFoto` che cancella, `scartaScelti` che non tocca i video);
//   4. la SESSIONE del selettore (`KVSelettoreMedia`): ordine, avanzamento, annullamento a metà, `GIA_IN_CORSO`, copie temporanee tolte —
//      con `NSItemProvider(contentsOf:)` al posto di un risultato di PHPicker e con file veri al posto di quelli di `UIDocumentPicker`;
//   5. `creaElementoDiProva` (solo Debug) e lo spazio forzato da una variabile d'ambiente (che in Release NON ha effetto);
//   6. i SORGENTI: i nove metodi del plugin = `METODI_PLUGIN_CARICAMENTI`, `creaElementoDiProva` solo sotto `#if DEBUG`, la registrazione prima
//      dei `guard`, nessun permesso, nessun metadato copiato, nessun nome nei log, la versione 1.2 (6).
//
// I valori attesi sono scritti QUI a mano, dalla spec e dalla tabella degli orientamenti EXIF: non si calcolano con il codice che si prova.
// Argomenti: <release|debug> <cartella dei file di produzione> <caricamenti-nativi-tipi.ts>.

import AVFoundation
import CommonCrypto
import CoreGraphics
import CoreVideo
import Foundation
import ImageIO
import UniformTypeIdentifiers

// MARK: - Cerimoniale

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

// MARK: - File e cartelle di prova

let radiceProva = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
    .appendingPathComponent("kv-prove-foto-\(UUID().uuidString)", isDirectory: true)

func nuovaCartella() -> URL {
    let url = radiceProva.appendingPathComponent(UUID().uuidString, isDirectory: true)
    do {
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: nil)
    } catch {
        print("FATALE: cartella di prova non creata: \(error)")
        exit(3)
    }
    return url
}

func leggiTesto(_ percorso: String) -> String? {
    return try? String(contentsOfFile: percorso, encoding: .utf8)
}

func esiste(_ url: URL) -> Bool { FileManager.default.fileExists(atPath: url.path) }

func nomiIn(_ url: URL) -> [String] {
    return ((try? FileManager.default.contentsOfDirectory(atPath: url.path)) ?? []).sorted()
}

func pesoDi(_ url: URL) -> Int64 {
    return ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? NSNumber)?.int64Value ?? -1
}

func casuali(_ byte: Int) -> Data {
    var dati = Data(count: byte)
    dati.withUnsafeMutableBytes { buffer in
        if let base = buffer.baseAddress { _ = SecRandomCopyBytes(kSecRandomDefault, buffer.count, base) }
    }
    return dati
}

/// Una copia fresca di un file di prova (le funzioni di produzione CONSUMANO la sorgente: spostano o cancellano).
func copiaFresca(_ origine: URL, nome: String? = nil) -> URL {
    let destinazione = nuovaCartella().appendingPathComponent(nome ?? origine.lastPathComponent)
    do {
        try FileManager.default.copyItem(at: origine, to: destinazione)
    } catch {
        print("FATALE: copia di prova non riuscita: \(error)")
        exit(3)
    }
    return destinazione
}

/// Lo SHA-256 con CommonCrypto, tutto il file in una volta: un'implementazione INDIPENDENTE da quella di produzione (CryptoKit, a blocchi).
func shaIndipendente(_ url: URL) -> String? {
    guard let dati = try? Data(contentsOf: url) else { return nil }
    var impronta = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
    dati.withUnsafeBytes { buffer in _ = CC_SHA256(buffer.baseAddress, CC_LONG(dati.count), &impronta) }
    return impronta.map { String(format: "%02x", $0) }.joined()
}

// MARK: - Immagini di prova

let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!

/// Quattro quadranti come stanno in MEMORIA, prima di ogni orientamento: alto-sinistra ROSSO, alto-destra VERDE, basso-sinistra BLU, basso-destra GIALLO.
func quadranti(_ larghezza: Int, _ altezza: Int) -> CGImage {
    let contesto = CGContext(data: nil, width: larghezza, height: altezza, bitsPerComponent: 8, bytesPerRow: 0, space: sRGB,
                             bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    func riempi(_ colonna: Int, _ riga: Int, _ r: CGFloat, _ g: CGFloat, _ b: CGFloat) {
        contesto.setFillColor(CGColor(srgbRed: r, green: g, blue: b, alpha: 1))
        // CGContext ha l'origine in BASSO a sinistra: la riga 1 (la metà alta dell'immagine) sta a y = altezza / 2.
        contesto.fill(CGRect(x: colonna * larghezza / 2, y: riga * altezza / 2, width: larghezza / 2, height: altezza / 2))
    }
    riempi(0, 1, 1, 0, 0)
    riempi(1, 1, 0, 1, 0)
    riempi(0, 0, 0, 0, 1)
    riempi(1, 0, 1, 1, 0)
    return contesto.makeImage()!
}

/// Un'immagine piena di rumore: la qualità del JPEG si vede nel peso solo se c'è qualcosa da comprimere.
func rumorosa(_ larghezza: Int, _ altezza: Int) -> CGImage {
    var pixel = casuali(larghezza * altezza * 4)
    return pixel.withUnsafeMutableBytes { buffer -> CGImage in
        let contesto = CGContext(data: buffer.baseAddress, width: larghezza, height: altezza, bitsPerComponent: 8, bytesPerRow: larghezza * 4, space: sRGB,
                                 bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        return contesto.makeImage()!
    }
}

/// Proprietà che un telefono scrive e che NON devono uscire: orientamento, EXIF con data, GPS, marca e modello.
func proprietaDiUnTelefono(orientamento: Int) -> [CFString: Any] {
    return [
        kCGImagePropertyOrientation: orientamento,
        kCGImagePropertyExifDictionary: [kCGImagePropertyExifUserComment: "commento di prova", kCGImagePropertyExifDateTimeOriginal: "2026:10:03 10:00:00"],
        kCGImagePropertyGPSDictionary: [kCGImagePropertyGPSLatitude: 40.85, kCGImagePropertyGPSLatitudeRef: "N",
                                        kCGImagePropertyGPSLongitude: 14.27, kCGImagePropertyGPSLongitudeRef: "E"],
        kCGImagePropertyTIFFDictionary: [kCGImagePropertyTIFFMake: "MarcaDiProva", kCGImagePropertyTIFFModel: "ModelloDiProva"],
    ]
}

@discardableResult
func scriviImmagine(_ immagine: CGImage, in url: URL, tipo: UTType, proprieta: [CFString: Any] = [:]) -> Bool {
    guard let destinazione = CGImageDestinationCreateWithURL(url as CFURL, tipo.identifier as CFString, 1, nil) else { return false }
    var tutte = proprieta
    if tipo == .jpeg || tipo == .heic { tutte[kCGImageDestinationLossyCompressionQuality] = 0.95 }
    CGImageDestinationAddImage(destinazione, immagine, tutte as CFDictionary)
    return CGImageDestinationFinalize(destinazione)
}

func proprietaDel(_ url: URL) -> [CFString: Any] {
    guard let sorgente = CGImageSourceCreateWithURL(url as CFURL, nil) else { return [:] }
    return CGImageSourceCopyPropertiesAtIndex(sorgente, 0, nil) as? [CFString: Any] ?? [:]
}

func leggiImmagine(_ url: URL) -> CGImage? {
    guard let sorgente = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(sorgente, 0, nil)
}

/// Il colore di un pixel (origine in alto a sinistra), in sRGB.
func colore(_ immagine: CGImage, x: Int, y: Int) -> (r: Int, g: Int, b: Int)? {
    guard let ritaglio = immagine.cropping(to: CGRect(x: x, y: y, width: 1, height: 1)) else { return nil }
    var px = [UInt8](repeating: 0, count: 4)
    var riuscito = false
    px.withUnsafeMutableBytes { buffer in
        guard let contesto = CGContext(data: buffer.baseAddress, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: sRGB,
                                       bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return }
        contesto.draw(ritaglio, in: CGRect(x: 0, y: 0, width: 1, height: 1))
        riuscito = true
    }
    return riuscito ? (Int(px[0]), Int(px[1]), Int(px[2])) : nil
}

enum Angolo: String { case altoSx = "alto-sinistra", altoDx = "alto-destra", bassoSx = "basso-sinistra", bassoDx = "basso-destra" }

/// Il colore al CENTRO di un quadrante dell'immagine come la si vede.
func coloreDelQuadrante(_ immagine: CGImage, _ angolo: Angolo) -> (r: Int, g: Int, b: Int)? {
    let w = immagine.width, h = immagine.height
    switch angolo {
    case .altoSx: return colore(immagine, x: w / 4, y: h / 4)
    case .altoDx: return colore(immagine, x: 3 * w / 4, y: h / 4)
    case .bassoSx: return colore(immagine, x: w / 4, y: 3 * h / 4)
    case .bassoDx: return colore(immagine, x: 3 * w / 4, y: 3 * h / 4)
    }
}

enum Tinta: String {
    case rosso, verde, blu, giallo, bianco
    var attesa: (r: Int, g: Int, b: Int) {
        switch self {
        case .rosso: return (255, 0, 0)
        case .verde: return (0, 255, 0)
        case .blu: return (0, 0, 255)
        case .giallo: return (255, 255, 0)
        case .bianco: return (255, 255, 255)
        }
    }
}

func eTinta(_ c: (r: Int, g: Int, b: Int)?, _ tinta: Tinta, tolleranza: Int = 45) -> Bool {
    guard let c = c else { return false }
    let a = tinta.attesa
    return abs(c.r - a.r) <= tolleranza && abs(c.g - a.g) <= tolleranza && abs(c.b - a.b) <= tolleranza
}

func descrivi(_ c: (r: Int, g: Int, b: Int)?) -> String { c.map { "(\($0.r),\($0.g),\($0.b))" } ?? "nil" }

/// I segmenti di un file JPEG, dal marcatore SOI fino a SOS: per scoprire un APP1 (EXIF e XMP), un APP13 (IPTC) o un COM che le proprietà lette
/// dal sistema potrebbero non mostrare.
func marcatoriJPEG(_ dati: Data) -> [UInt8] {
    guard dati.count > 4, dati[0] == 0xFF, dati[1] == 0xD8 else { return [] }
    var marcatori: [UInt8] = []
    var i = 2
    while i + 4 <= dati.count {
        guard dati[i] == 0xFF else { break }
        let m = dati[i + 1]
        if m == 0xDA { marcatori.append(m); break }
        marcatori.append(m)
        let lunghezza = Int(dati[i + 2]) << 8 | Int(dati[i + 3])
        i += 2 + lunghezza
    }
    return marcatori
}

// MARK: - Un filmato vero

/// Un clip H.264 vero scritto da AVAssetWriter: `secondi` secondi a 15 fotogrammi al secondo, con i quattro quadranti colorati. `rotazione` è la
/// trasformazione che un telefono scrive per un video girato in verticale. L'indice `moov` sta IN FONDO al file (come in una registrazione).
func scriviClip(_ url: URL, secondi: Double, larghezza: Int, altezza: Int, rotazione: Double = 0) -> Bool {
    try? FileManager.default.removeItem(at: url)
    guard let scrittore = try? AVAssetWriter(outputURL: url, fileType: .mp4) else { return false }
    let ingresso = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: larghezza,
                                                                          AVVideoHeightKey: altezza])
    ingresso.expectsMediaDataInRealTime = false
    ingresso.transform = CGAffineTransform(rotationAngle: CGFloat(rotazione))
    let adattatore = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: ingresso, sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: larghezza,
        kCVPixelBufferHeightKey as String: altezza])
    scrittore.add(ingresso)
    guard scrittore.startWriting() else { return false }
    scrittore.startSession(atSourceTime: .zero)
    let fps = 15
    for i in 0..<Int(secondi * Double(fps)) {
        var scadenza = 0
        while !ingresso.isReadyForMoreMediaData && scadenza < 5000 { Thread.sleep(forTimeInterval: 0.002); scadenza += 1 }
        var buffer: CVPixelBuffer?
        CVPixelBufferCreate(nil, larghezza, altezza, kCVPixelFormatType_32BGRA, nil, &buffer)
        guard let pb = buffer else { return false }
        CVPixelBufferLockBaseAddress(pb, [])
        let base = CVPixelBufferGetBaseAddress(pb)!.assumingMemoryBound(to: UInt8.self)
        let riga = CVPixelBufferGetBytesPerRow(pb)
        for y in 0..<altezza {
            for x in 0..<larghezza {
                let o = y * riga + x * 4
                let alto = y < altezza / 2, sinistra = x < larghezza / 2
                let (r, g, b): (UInt8, UInt8, UInt8) = alto ? (sinistra ? (255, 0, 0) : (0, 255, 0)) : (sinistra ? (0, 0, 255) : (255, 255, 0))
                base[o] = b; base[o + 1] = g; base[o + 2] = r; base[o + 3] = 255
            }
        }
        CVPixelBufferUnlockBaseAddress(pb, [])
        adattatore.append(pb, withPresentationTime: CMTime(value: Int64(i), timescale: Int32(fps)))
    }
    ingresso.markAsFinished()
    let semaforo = DispatchSemaphore(value: 0)
    scrittore.finishWriting { semaforo.signal() }
    semaforo.wait()
    return scrittore.status == .completed
}

// MARK: - Le finte e il banco

final class TrasportoRegistroFinto: KVTrasportoRegistro {
    func invia(_ richiesta: KVRichiestaRegistro, completamento: @escaping (KVRispostaRegistro) -> Void) {
        completamento(.stato(200, retryAfter: nil))
    }
}

/// Una coda, un registro e una preparazione su una cartella nuova. `spazio` è lo spazio libero che la preparazione crede di avere.
struct Banco {
    let radice: URL
    let coda: KVCodaCaricamenti
    let registro: KVRegistroNativo
    let preparazione: KVPreparazioneMedia
    var scelti: URL { coda.cartellaScelti }

    init(spazio: @escaping () -> Int64? = { 50_000_000_000 }) {
        radice = nuovaCartella()
        registro = KVRegistroNativo(cartella: radice, trasporto: TrasportoRegistroFinto(), versioneApp: "1.2+6", ambiente: .release)
        coda = KVCodaCaricamenti(cartella: radice, registro: registro)
        _ = coda.preparaCartelle()
        preparazione = KVPreparazioneMedia(coda: coda, registro: registro, spazioDisponibile: spazio)
    }

    var eventi: [KVEventoRegistrato] { registro.stato().eventi }
}

func opzioni(sorgente: KVSorgenteScelta = .file, massimo: Int = 50, lato: Int = 1920, qualita: Double = 0.85, byteMassimi: Int64 = 2_000_000_000,
             durataMassima: Int = 300) -> KVOpzioniScelta {
    return KVOpzioniScelta(sorgente: sorgente, massimoElementi: massimo, latoMassimoFoto: lato, qualitaFoto: qualita, byteMassimiVideo: byteMassimi,
                           durataMassimaVideoSecondi: durataMassima)
}

func attendi(_ descrizione: String, secondi: TimeInterval = 15, _ condizione: () -> Bool) -> Bool {
    let limite = Date().addingTimeInterval(secondi)
    while Date() < limite {
        if condizione() { return true }
        Thread.sleep(forTimeInterval: 0.02)
    }
    verifica("(attesa) \(descrizione)", false, "non avvenuto entro \(secondi) s")
    return false
}

/// Raccoglie ciò che una sessione consegna (avanzamento ed esito), da thread diversi.
final class Raccolta {
    private let serratura = NSLock()
    private var avanzamentiInterni: [KVAvanzamentoPreparazione] = []
    private var esitoInterno: KVEsitoSelettore?
    let semaforo = DispatchSemaphore(value: 0)

    var avanzamenti: [KVAvanzamentoPreparazione] { serratura.lock(); defer { serratura.unlock() }; return avanzamentiInterni }
    var esito: KVEsitoSelettore? { serratura.lock(); defer { serratura.unlock() }; return esitoInterno }

    func avanzamento(_ a: KVAvanzamentoPreparazione) {
        serratura.lock(); avanzamentiInterni.append(a); serratura.unlock()
    }

    func completamento(_ e: KVEsitoSelettore) {
        serratura.lock(); esitoInterno = e; serratura.unlock()
        semaforo.signal()
    }

    func attendiEsito(secondi: TimeInterval = 30) -> KVEsitoSelettore? {
        return semaforo.wait(timeout: .now() + secondi) == .success ? esito : nil
    }
}

// MARK: - Le risorse (generate una volta)

struct Risorse {
    let cartella: URL
    let clip: URL
    let clipVerticale: URL
    let clipTroncato: URL
    let heic48: URL
    let junkAvi: URL
    let junkMov: URL
    var pesoJunk: Int { 9 * 1024 * 1024 + 123 }
}

func generaRisorse() -> Risorse? {
    let cartella = nuovaCartella()
    let clip = cartella.appendingPathComponent("clip.mp4")
    guard scriviClip(clip, secondi: 2, larghezza: 640, altezza: 360) else { print("FATALE: clip non scritto"); return nil }
    let verticale = cartella.appendingPathComponent("verticale.mp4")
    guard scriviClip(verticale, secondi: 2, larghezza: 640, altezza: 360, rotazione: .pi / 2) else { print("FATALE: clip verticale non scritto"); return nil }
    // Una registrazione interrotta: `moov` sta in fondo e manca.
    let troncato = cartella.appendingPathComponent("troncato.mp4")
    guard let dati = try? Data(contentsOf: clip), (try? dati.prefix(dati.count * 4 / 10).write(to: troncato)) != nil else { return nil }
    // La HEIC da 48 megapixel (8064 × 6048, come una foto di un telefono recente), con orientamento 6 e i metadati di un telefono.
    let heic = cartella.appendingPathComponent("foto48.heic")
    guard scriviImmagine(quadranti(8064, 6048), in: heic, tipo: .heic, proprieta: proprietaDiUnTelefono(orientamento: 6)) else {
        print("FATALE: HEIC da 48 MP non generata (il codificatore HEIC di sistema non risponde)")
        return nil
    }
    let junk = casuali(9 * 1024 * 1024 + 123)
    let avi = cartella.appendingPathComponent("junk.avi")
    let mov = cartella.appendingPathComponent("junk.mov")
    guard (try? junk.write(to: avi)) != nil, (try? junk.write(to: mov)) != nil else { return nil }
    return Risorse(cartella: cartella, clip: clip, clipVerticale: verticale, clipTroncato: troncato, heic48: heic, junkAvi: avi, junkMov: mov)
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
//  1. La riduzione delle foto
// ═══════════════════════════════════════════════════════════════════════════════════════════

/// Dove va a finire ciascun angolo della foto IN MEMORIA quando si applica l'orientamento EXIF (tabella standard, scritta qui a mano):
/// (le dimensioni si scambiano, [dove compare il ROSSO (alto-sx in memoria), il VERDE (alto-dx), il BLU (basso-sx), il GIALLO (basso-dx)]).
let tabellaOrientamenti: [(orientamento: Int, scambia: Bool, rosso: Angolo, verde: Angolo, blu: Angolo, giallo: Angolo)] = [
    (1, false, .altoSx, .altoDx, .bassoSx, .bassoDx),   // com'è
    (2, false, .altoDx, .altoSx, .bassoDx, .bassoSx),   // specchio orizzontale
    (3, false, .bassoDx, .bassoSx, .altoDx, .altoSx),   // ruotata di 180°
    (4, false, .bassoSx, .bassoDx, .altoSx, .altoDx),   // specchio verticale
    (5, true, .altoSx, .bassoSx, .altoDx, .bassoDx),    // trasposta
    (6, true, .altoDx, .bassoDx, .altoSx, .bassoSx),    // ruotata di 90° in senso orario
    (7, true, .bassoDx, .altoDx, .bassoSx, .altoSx),    // trasversa
    (8, true, .bassoSx, .altoSx, .bassoDx, .altoDx),    // ruotata di 90° in senso antiorario
]

func provaRiduzioneFoto(_ risorse: Risorse) {
    sezione("la riduzione delle foto — la HEIC da 48 MP esce a 1920 px, dritta e senza un solo metadato (§5.6)")
    // Il controllo POSITIVO: la sorgente ha davvero i metadati (altrimenti «senza metadati» non proverebbe niente).
    let sorgenteProprieta = proprietaDel(risorse.heic48)
    verificaUguali("(controllo) la sorgente è 8064 × 6048", [sorgenteProprieta[kCGImagePropertyPixelWidth] as? Int ?? 0, sorgenteProprieta[kCGImagePropertyPixelHeight] as? Int ?? 0],
                   [8064, 6048])
    verifica("(controllo) la sorgente porta GPS, EXIF e TIFF e l'orientamento 6",
             sorgenteProprieta[kCGImagePropertyGPSDictionary] != nil && sorgenteProprieta[kCGImagePropertyExifDictionary] != nil
             && sorgenteProprieta[kCGImagePropertyTIFFDictionary] != nil && (sorgenteProprieta[kCGImagePropertyOrientation] as? Int) == 6)

    let destinazione = nuovaCartella().appendingPathComponent("uscita.jpg")
    let inizio = Date()
    let esito = KVElaborazioneFoto.riduci(da: risorse.heic48, latoMassimo: 1920, qualita: 0.85, verso: destinazione)
    let durata = Date().timeIntervalSince(inizio)
    guard case .ridotta(let foto) = esito else {
        verifica("la riduzione riesce", false, "esito: \(esito)")
        return
    }
    verifica("la riduzione impiega pochi secondi (\(String(format: "%.2f", durata)) s) — mai una tela, mai la foto intera in memoria", durata < 20)
    verificaUguali("dimensioni: 1440 × 1920 (il lato lungo è ESATTAMENTE 1920; è in verticale perché l'orientamento 6 è stato applicato ai pixel)",
                   [foto.larghezza, foto.altezza], [1440, 1920])
    verificaUguali("il peso dichiarato è quello del file scritto", foto.byte, pesoDi(destinazione))
    guard let dati = try? Data(contentsOf: destinazione) else { verifica("il file c'è", false); return }
    verifica("è un JPEG (SOI FF D8 FF)", dati.count > 3 && dati[0] == 0xFF && dati[1] == 0xD8 && dati[2] == 0xFF)
    verifica("pesa meno di 3 MB (mai una foto da 48 MP in giro)", dati.count < 3_000_000)

    let proprieta = proprietaDel(destinazione)
    for chiave in [kCGImagePropertyExifDictionary, kCGImagePropertyGPSDictionary, kCGImagePropertyTIFFDictionary, kCGImagePropertyIPTCDictionary,
                   kCGImagePropertyMakerAppleDictionary, kCGImagePropertyOrientation] {
        verifica("nessuna proprietà «\(chiave)» nel file scritto", proprieta[chiave] == nil)
    }
    let marcatori = marcatoriJPEG(dati)
    verifica("(controllo) i segmenti si leggono: ci sono almeno la tabella di quantizzazione e l'inizio dei dati (\(marcatori.map { String(format: "%02X", $0) }))",
             marcatori.contains(0xDB) && marcatori.last == 0xDA)
    verifica("tutti i segmenti sono fra quelli che servono a rileggere l'immagine (JFIF, ICC, tabelle, intestazione, dati)",
             marcatori.allSatisfy { [0xE0, 0xE2, 0xEE, 0xDB, 0xDD, 0xC0, 0xC1, 0xC2, 0xC4, 0xDA].contains($0) }, "\(marcatori.map { String(format: "%02X", $0) })")
    verifica("nessun segmento APP1 (EXIF e XMP)", !marcatori.contains(0xE1))
    verifica("nessun segmento APP13 (IPTC / Photoshop)", !marcatori.contains(0xED))
    verifica("nessun commento (COM)", !marcatori.contains(0xFE))
    verifica("nessuna stringa «Exif» né «http://ns.adobe.com» (XMP) nel file", dati.range(of: Data("Exif".utf8)) == nil && dati.range(of: Data("ns.adobe.com".utf8)) == nil)

    guard let uscita = leggiImmagine(destinazione) else { verifica("il JPEG si rilegge", false); return }
    verificaUguali("rilettura: 1440 × 1920, senza orientamento da applicare", [uscita.width, uscita.height], [1440, 1920])
    // Orientamento 6 = ruotata di 90° in senso orario: il rosso (alto-sx in memoria) compare in ALTO A DESTRA, il verde in basso a destra, il giallo in
    // basso a sinistra, il blu in alto a sinistra.
    verifica("orientamento: il rosso in alto a destra \(descrivi(coloreDelQuadrante(uscita, .altoDx)))", eTinta(coloreDelQuadrante(uscita, .altoDx), .rosso))
    verifica("orientamento: il verde in basso a destra \(descrivi(coloreDelQuadrante(uscita, .bassoDx)))", eTinta(coloreDelQuadrante(uscita, .bassoDx), .verde))
    verifica("orientamento: il giallo in basso a sinistra \(descrivi(coloreDelQuadrante(uscita, .bassoSx)))", eTinta(coloreDelQuadrante(uscita, .bassoSx), .giallo))
    verifica("orientamento: il blu in alto a sinistra \(descrivi(coloreDelQuadrante(uscita, .altoSx)))", eTinta(coloreDelQuadrante(uscita, .altoSx), .blu))
    verificaUguali("nella cartella di destinazione c'è SOLO il file scritto (scrittura atomica: nessun temporaneo rimasto)",
                   nomiIn(destinazione.deletingLastPathComponent()), ["uscita.jpg"])
    verificaUguali("la sorgente non si tocca (lo decide il chiamante)", esiste(risorse.heic48), true)
    verificaUguali("`dimensioni(diFile:)` legge le stesse misure dall'intestazione",
                   [KVElaborazioneFoto.dimensioni(diFile: destinazione)?.larghezza ?? 0, KVElaborazioneFoto.dimensioni(diFile: destinazione)?.altezza ?? 0], [1440, 1920])
}

func provaOrientamenti() {
    sezione("tutti gli otto orientamenti EXIF si applicano ai pixel (e il tag non resta)")
    let cartella = nuovaCartella()
    for riga in tabellaOrientamenti {
        let sorgente = cartella.appendingPathComponent("o\(riga.orientamento).jpg")
        let destinazione = cartella.appendingPathComponent("o\(riga.orientamento)-uscita.jpg")
        guard scriviImmagine(quadranti(600, 400), in: sorgente, tipo: .jpeg, proprieta: proprietaDiUnTelefono(orientamento: riga.orientamento)) else {
            verifica("orientamento \(riga.orientamento): sorgente scritta", false)
            continue
        }
        guard case .ridotta(let foto) = KVElaborazioneFoto.riduci(da: sorgente, latoMassimo: 300, qualita: 0.9, verso: destinazione) else {
            verifica("orientamento \(riga.orientamento): la riduzione riesce", false)
            continue
        }
        verificaUguali("orientamento \(riga.orientamento): dimensioni \(riga.scambia ? "scambiate (200 × 300)" : "invariate (300 × 200)")",
                       [foto.larghezza, foto.altezza], riga.scambia ? [200, 300] : [300, 200])
        guard let uscita = leggiImmagine(destinazione) else { verifica("orientamento \(riga.orientamento): si rilegge", false); continue }
        verifica("orientamento \(riga.orientamento): il rosso in \(riga.rosso.rawValue) \(descrivi(coloreDelQuadrante(uscita, riga.rosso)))", eTinta(coloreDelQuadrante(uscita, riga.rosso), .rosso))
        verifica("orientamento \(riga.orientamento): il verde in \(riga.verde.rawValue) \(descrivi(coloreDelQuadrante(uscita, riga.verde)))", eTinta(coloreDelQuadrante(uscita, riga.verde), .verde))
        verifica("orientamento \(riga.orientamento): il blu in \(riga.blu.rawValue) \(descrivi(coloreDelQuadrante(uscita, riga.blu)))", eTinta(coloreDelQuadrante(uscita, riga.blu), .blu))
        verifica("orientamento \(riga.orientamento): il giallo in \(riga.giallo.rawValue) \(descrivi(coloreDelQuadrante(uscita, riga.giallo)))", eTinta(coloreDelQuadrante(uscita, riga.giallo), .giallo))
        let p = proprietaDel(destinazione)
        verifica("orientamento \(riga.orientamento): nessun tag di orientamento, GPS, EXIF o TIFF nel file scritto",
                 p[kCGImagePropertyOrientation] == nil && p[kCGImagePropertyGPSDictionary] == nil && p[kCGImagePropertyExifDictionary] == nil && p[kCGImagePropertyTIFFDictionary] == nil)
        verifica("orientamento \(riga.orientamento): nessun segmento APP1 né APP13", !marcatoriJPEG((try? Data(contentsOf: destinazione)) ?? Data()).contains(0xE1)
                 && !marcatoriJPEG((try? Data(contentsOf: destinazione)) ?? Data()).contains(0xED))
    }
}

func provaRiduzioneVarie() {
    sezione("la riduzione: mai un ingrandimento, il lato si rispetta, la trasparenza va su bianco, la qualità conta")
    let cartella = nuovaCartella()
    // Una foto piccola non si ingrandisce.
    let piccola = cartella.appendingPathComponent("piccola.jpg")
    scriviImmagine(quadranti(800, 600), in: piccola, tipo: .jpeg)
    if case .ridotta(let foto) = KVElaborazioneFoto.riduci(da: piccola, latoMassimo: 1920, qualita: 0.85, verso: cartella.appendingPathComponent("piccola-uscita.jpg")) {
        verificaUguali("800 × 600 con lato 1920: resta 800 × 600 (nessun ingrandimento)", [foto.larghezza, foto.altezza], [800, 600])
    } else {
        verifica("800 × 600: la riduzione riesce", false)
    }
    // Il lato è quello chiesto, in entrambe le direzioni.
    let larga = cartella.appendingPathComponent("larga.jpg")
    scriviImmagine(quadranti(2000, 1000), in: larga, tipo: .jpeg)
    if case .ridotta(let foto) = KVElaborazioneFoto.riduci(da: larga, latoMassimo: 1000, qualita: 0.85, verso: cartella.appendingPathComponent("larga-uscita.jpg")) {
        verificaUguali("2000 × 1000 con lato 1000: 1000 × 500", [foto.larghezza, foto.altezza], [1000, 500])
    } else {
        verifica("2000 × 1000: la riduzione riesce", false)
    }
    let alta = cartella.appendingPathComponent("alta.jpg")
    scriviImmagine(quadranti(1000, 2000), in: alta, tipo: .jpeg)
    if case .ridotta(let foto) = KVElaborazioneFoto.riduci(da: alta, latoMassimo: 1000, qualita: 0.85, verso: cartella.appendingPathComponent("alta-uscita.jpg")) {
        verificaUguali("1000 × 2000 con lato 1000: 500 × 1000", [foto.larghezza, foto.altezza], [500, 1000])
    } else {
        verifica("1000 × 2000: la riduzione riesce", false)
    }

    // La trasparenza: un PNG con il solo quarto in alto a sinistra rosso e opaco; il resto è trasparente (nero con alfa 0).
    let contesto = CGContext(data: nil, width: 400, height: 300, bitsPerComponent: 8, bytesPerRow: 0, space: sRGB, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    contesto.clear(CGRect(x: 0, y: 0, width: 400, height: 300))
    contesto.setFillColor(CGColor(srgbRed: 1, green: 0, blue: 0, alpha: 1))
    contesto.fill(CGRect(x: 0, y: 150, width: 200, height: 150))
    let png = cartella.appendingPathComponent("trasparente.png")
    scriviImmagine(contesto.makeImage()!, in: png, tipo: .png)
    // `suSfondoBianco` DIRETTAMENTE, sull'immagine prima di codificarla: il codificatore di sistema appiattisce da solo sul bianco un'immagine con alfa
    // (misurato), quindi il PNG che passa dal JPEG qui sotto non basterebbe a vedere se il nostro passo c'è.
    let immagineTrasparente = contesto.makeImage()!
    verificaUguali("(controllo) l'immagine di partenza ha il canale alfa", KVElaborazioneFoto.haTrasparenza(immagineTrasparente), true)
    if let composta = KVElaborazioneFoto.suSfondoBianco(immagineTrasparente) {
        verificaUguali("suSfondoBianco: l'immagine composta NON ha più il canale alfa", KVElaborazioneFoto.haTrasparenza(composta), false)
        verificaUguali("… e ha le stesse dimensioni (400 × 300)", [composta.width, composta.height], [400, 300])
        verifica("… il rosso opaco resta rosso \(descrivi(coloreDelQuadrante(composta, .altoSx)))", eTinta(coloreDelQuadrante(composta, .altoSx), .rosso, tolleranza: 3))
        verifica("… la parte trasparente è BIANCA nell'immagine stessa (non nera) \(descrivi(coloreDelQuadrante(composta, .altoDx)))", eTinta(coloreDelQuadrante(composta, .altoDx), .bianco, tolleranza: 3)
                 && eTinta(coloreDelQuadrante(composta, .bassoSx), .bianco, tolleranza: 3) && eTinta(coloreDelQuadrante(composta, .bassoDx), .bianco, tolleranza: 3))
    } else {
        verifica("suSfondoBianco compone l'immagine trasparente", false)
    }
    let opacaIntera = quadranti(100, 100)
    verifica("suSfondoBianco: un'immagine opaca torna la STESSA (nessuna copia inutile)", KVElaborazioneFoto.suSfondoBianco(opacaIntera) === opacaIntera)
    let uscitaPng = cartella.appendingPathComponent("trasparente-uscita.jpg")
    if case .ridotta = KVElaborazioneFoto.riduci(da: png, latoMassimo: 1920, qualita: 0.9, verso: uscitaPng), let uscita = leggiImmagine(uscitaPng) {
        verifica("PNG trasparente: la parte opaca resta rossa \(descrivi(coloreDelQuadrante(uscita, .altoSx)))", eTinta(coloreDelQuadrante(uscita, .altoSx), .rosso))
        verifica("PNG trasparente: la parte trasparente è BIANCA, non nera \(descrivi(coloreDelQuadrante(uscita, .altoDx)))", eTinta(coloreDelQuadrante(uscita, .altoDx), .bianco, tolleranza: 10))
        verifica("PNG trasparente: il basso è bianco \(descrivi(coloreDelQuadrante(uscita, .bassoDx)))", eTinta(coloreDelQuadrante(uscita, .bassoDx), .bianco, tolleranza: 10))
    } else {
        verifica("PNG trasparente: la riduzione riesce", false)
    }
    // `haTrasparenza` guarda solo `alphaInfo`: si prova sulle combinazioni che un contesto di bit sa creare.
    let tuttiGliAlfa: [(CGImageAlphaInfo, Bool)] = [(.noneSkipFirst, false), (.noneSkipLast, false), (.premultipliedFirst, true), (.premultipliedLast, true)]
    for (info, atteso) in tuttiGliAlfa {
        if let contesto = CGContext(data: nil, width: 2, height: 2, bitsPerComponent: 8, bytesPerRow: 0, space: sRGB, bitmapInfo: info.rawValue),
           let immagine = contesto.makeImage() {
            verificaUguali("haTrasparenza(alphaInfo \(info.rawValue)) = \(atteso)", KVElaborazioneFoto.haTrasparenza(immagine), atteso)
        } else {
            verifica("un contesto con alphaInfo \(info.rawValue) si crea", false)
        }
    }

    // La qualità: con il rumore, 0,2 pesa MENO di 0,9.
    let rumore = cartella.appendingPathComponent("rumore.png")
    scriviImmagine(rumorosa(1200, 900), in: rumore, tipo: .png)
    let bassa = cartella.appendingPathComponent("bassa.jpg"), alta90 = cartella.appendingPathComponent("alta90.jpg")
    if case .ridotta(let a) = KVElaborazioneFoto.riduci(da: rumore, latoMassimo: 1920, qualita: 0.2, verso: bassa),
       case .ridotta(let b) = KVElaborazioneFoto.riduci(da: rumore, latoMassimo: 1920, qualita: 0.9, verso: alta90) {
        verifica("qualità 0,2 pesa meno di qualità 0,9 (\(a.byte) < \(b.byte))", a.byte < b.byte)
        verifica("qualità 0,9 su rumore pesa almeno il doppio di 0,2 (la qualità è davvero applicata)", b.byte > a.byte * 2)
    } else {
        verifica("la riduzione con due qualità riesce", false)
    }
    // Una qualità fuori misura non rompe niente (0 e 7 si portano in (0, 1]).
    verifica("qualità 0 → un JPEG valido, non un file vuoto", KVElaborazioneFoto.codificaJPEG(quadranti(64, 64), qualita: 0).map { $0.count > 100 } ?? false)
    verifica("qualità 7 → un JPEG valido", KVElaborazioneFoto.codificaJPEG(quadranti(64, 64), qualita: 7).map { $0.count > 100 } ?? false)

    // `ridimensionata` (la miniatura di un video): scende, non sale.
    verificaUguali("ridimensionata: 2000 × 1000 con lato 320 → 320 × 160", [KVElaborazioneFoto.ridimensionata(quadranti(2000, 1000), latoMassimo: 320)?.width ?? 0,
                                                                          KVElaborazioneFoto.ridimensionata(quadranti(2000, 1000), latoMassimo: 320)?.height ?? 0], [320, 160])
    verificaUguali("ridimensionata: 100 × 50 con lato 320 → invariata", [KVElaborazioneFoto.ridimensionata(quadranti(100, 50), latoMassimo: 320)?.width ?? 0,
                                                                       KVElaborazioneFoto.ridimensionata(quadranti(100, 50), latoMassimo: 320)?.height ?? 0], [100, 50])
}

/// Un JPEG con un segmento `marcatore` inserito subito dopo SOI (e prima di tutto il resto).
func conSegmento(_ jpeg: Data, marcatore: UInt8, contenuto: [UInt8]) -> Data {
    var d = Data([0xFF, 0xD8, 0xFF, marcatore])
    let lunghezza = contenuto.count + 2
    d.append(contentsOf: [UInt8(lunghezza >> 8), UInt8(lunghezza & 0xFF)])
    d.append(contentsOf: contenuto)
    d.append(jpeg.dropFirst(2))
    return d
}

func provaSenzaMetadati() {
    sezione("`senzaMetadati`: toglie i segmenti con metadati, tiene quelli che servono a rileggere l'immagine, e non accetta ciò che non è un JPEG intero")
    let cartella = nuovaCartella()
    // Un JPEG vero con i metadati di un telefono (APP1 con EXIF, GPS, TIFF): la sorgente del controllo positivo.
    let conMetadati = cartella.appendingPathComponent("telefono.jpg")
    scriviImmagine(quadranti(300, 200), in: conMetadati, tipo: .jpeg, proprieta: proprietaDiUnTelefono(orientamento: 1))
    guard let originale = try? Data(contentsOf: conMetadati) else { verifica("la sorgente si scrive", false); return }
    let prima = marcatoriJPEG(originale)
    verifica("(controllo) la sorgente ha un APP1 con EXIF, GPS e TIFF (\(prima.map { String(format: "%02X", $0) }))", prima.contains(0xE1) && originale.range(of: Data("Exif".utf8)) != nil)
    guard let pulito = KVElaborazioneFoto.senzaMetadati(originale) else { verifica("un JPEG intero si pulisce", false); return }
    let dopo = marcatoriJPEG(pulito)
    verifica("nessun APP1 dopo la pulizia", !dopo.contains(0xE1))
    verifica("nessuna stringa «Exif» dopo la pulizia", pulito.range(of: Data("Exif".utf8)) == nil)
    verifica("restano le tabelle e i dati (DQT, SOF, DHT, SOS)", dopo.contains(0xDB) && dopo.contains(0xC0) && dopo.contains(0xC4) && dopo.last == 0xDA)
    verifica("il file pulito è più piccolo e finisce con lo stesso EOI (FF D9)", pulito.count < originale.count && pulito.suffix(2) == Data([0xFF, 0xD9]))
    let filePulito = cartella.appendingPathComponent("pulito.jpg")
    try? pulito.write(to: filePulito)
    if let a = leggiImmagine(filePulito) {
        verificaUguali("il JPEG pulito si rilegge: 300 × 200", [a.width, a.height], [300, 200])
        verifica("… con i colori di prima (rosso in alto a sinistra \(descrivi(coloreDelQuadrante(a, .altoSx))))", eTinta(coloreDelQuadrante(a, .altoSx), .rosso) && eTinta(coloreDelQuadrante(a, .bassoDx), .giallo))
    } else {
        verifica("il JPEG pulito si rilegge", false)
    }
    let p = proprietaDel(filePulito)
    verifica("nessuna proprietà EXIF, GPS o TIFF nel JPEG pulito", p[kCGImagePropertyExifDictionary] == nil && p[kCGImagePropertyGPSDictionary] == nil && p[kCGImagePropertyTIFFDictionary] == nil)
    verificaUguali("la pulizia è idempotente (pulire un file pulito non cambia niente)", KVElaborazioneFoto.senzaMetadati(pulito), pulito)

    // Ogni segmento vietato, inserito a mano, si toglie; ogni segmento che serve, si tiene.
    let base = pulito
    for (nome, marcatore) in [("APP1 (EXIF/XMP)", UInt8(0xE1)), ("APP3", 0xE3), ("APP12", 0xEC), ("APP13 (Photoshop/IPTC)", 0xED), ("APP15", 0xEF), ("commento (COM)", 0xFE)] {
        let sporco = conSegmento(base, marcatore: marcatore, contenuto: Array("SEGRETO".utf8))
        verifica("(controllo) il segmento \(nome) inserito a mano c'è", marcatoriJPEG(sporco).contains(marcatore))
        let ripulito = KVElaborazioneFoto.senzaMetadati(sporco)
        verifica("\(nome): tolto", ripulito.map { !marcatoriJPEG($0).contains(marcatore) && $0.range(of: Data("SEGRETO".utf8)) == nil } ?? false)
        verificaUguali("\(nome): il resto è identico al file di partenza, byte per byte", ripulito, base)
    }
    for (nome, marcatore) in [("APP2 (profilo ICC)", UInt8(0xE2)), ("APP14 (Adobe)", 0xEE)] {
        let conIcc = conSegmento(base, marcatore: marcatore, contenuto: Array("ICC_PROFILE".utf8) + [0, 1, 1])
        verificaUguali("\(nome): si TIENE (serve a rileggere i colori)", KVElaborazioneFoto.senzaMetadati(conIcc), conIcc)
    }
    // Ciò che non è un JPEG intero non passa.
    verificaUguali("dati vuoti → nil", KVElaborazioneFoto.senzaMetadati(Data()), nil)
    verificaUguali("byte che non cominciano con SOI → nil", KVElaborazioneFoto.senzaMetadati(casuali(500)), nil)
    verificaUguali("un JPEG tagliato prima di SOS → nil (non si arriva ai dati)", KVElaborazioneFoto.senzaMetadati(originale.prefix(60)), nil)
    var lunghezzaFalsa = Data([0xFF, 0xD8, 0xFF, 0xE1, 0xFF, 0xFF])
    lunghezzaFalsa.append(Data(repeating: 0, count: 20))
    verificaUguali("un segmento che dichiara più byte di quelli che il file ha → nil", KVElaborazioneFoto.senzaMetadati(lunghezzaFalsa), nil)
    verificaUguali("un segmento con lunghezza < 2 → nil", KVElaborazioneFoto.senzaMetadati(Data([0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x01, 0, 0, 0, 0])), nil)
    verificaUguali("un byte che non è l'inizio di un marcatore fra due segmenti → nil", KVElaborazioneFoto.senzaMetadati(Data([0xFF, 0xD8, 0x00, 0xE1, 0x00, 0x04, 0, 0, 0, 0])), nil)
}

/// Un'immagine di quattro quadranti nello spazio Display P3 (come una foto di un iPhone recente), con il rosso al massimo del P3.
func quadrantiP3(_ larghezza: Int, _ altezza: Int) -> CGImage {
    let p3 = CGColorSpace(name: CGColorSpace.displayP3)!
    let contesto = CGContext(data: nil, width: larghezza, height: altezza, bitsPerComponent: 8, bytesPerRow: 0, space: p3, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    func riempi(_ colonna: Int, _ riga: Int, _ r: CGFloat, _ g: CGFloat, _ b: CGFloat) {
        contesto.setFillColor(CGColor(colorSpace: p3, components: [r, g, b, 1])!)
        contesto.fill(CGRect(x: colonna * larghezza / 2, y: riga * altezza / 2, width: larghezza / 2, height: altezza / 2))
    }
    riempi(0, 1, 1, 0, 0)
    riempi(1, 1, 0, 1, 0)
    riempi(0, 0, 0, 0, 1)
    riempi(1, 0, 1, 1, 0)
    return contesto.makeImage()!
}

func provaProfiloColore() {
    sezione("il profilo colore: un Display P3 esce P3, con il suo profilo ICC (APP2) — altrimenti i colori di una foto di iPhone cambierebbero")
    let cartella = nuovaCartella()
    for (nome, tipo) in [("jpg", UTType.jpeg), ("heic", UTType.heic)] {
        let sorgente = cartella.appendingPathComponent("p3.\(nome)")
        guard scriviImmagine(quadrantiP3(800, 600), in: sorgente, tipo: tipo, proprieta: proprietaDiUnTelefono(orientamento: 1)) else {
            verifica("P3 \(nome): la sorgente si scrive", false)
            continue
        }
        let nomeProfilo = proprietaDel(sorgente)[kCGImagePropertyProfileName] as? String
        verifica("(controllo) la sorgente \(nome) è Display P3 (\(nomeProfilo ?? "nil"))", nomeProfilo?.contains("P3") ?? false)
        let uscita = cartella.appendingPathComponent("p3-\(nome)-uscita.jpg")
        guard case .ridotta(let foto) = KVElaborazioneFoto.riduci(da: sorgente, latoMassimo: 400, qualita: 0.9, verso: uscita) else {
            verifica("P3 \(nome): la riduzione riesce", false)
            continue
        }
        verificaUguali("P3 \(nome): 400 × 300", [foto.larghezza, foto.altezza], [400, 300])
        let marcatori = marcatoriJPEG((try? Data(contentsOf: uscita)) ?? Data())
        verifica("P3 \(nome): il profilo ICC (APP2) c'è ancora dopo la pulizia dei metadati", marcatori.contains(0xE2), "\(marcatori.map { String(format: "%02X", $0) })")
        verifica("P3 \(nome): …e nessun APP1 né APP13", !marcatori.contains(0xE1) && !marcatori.contains(0xED))
        let profiloUscita = proprietaDel(uscita)[kCGImagePropertyProfileName] as? String
        verifica("P3 \(nome): il file scritto dichiara ancora Display P3 (\(profiloUscita ?? "nil"))", profiloUscita?.contains("P3") ?? false)
        if let immagine = leggiImmagine(uscita) {
            let nomeSpazio = (immagine.colorSpace?.name as String?) ?? "?"
            verifica("P3 \(nome): rilegge con uno spazio P3 (\(nomeSpazio))", nomeSpazio.contains("P3"))
            verifica("P3 \(nome): il blu resta blu in basso a sinistra \(descrivi(coloreDelQuadrante(immagine, .bassoSx)))", eTinta(coloreDelQuadrante(immagine, .bassoSx), .blu, tolleranza: 60))
            verifica("P3 \(nome): il verde resta verde in alto a destra \(descrivi(coloreDelQuadrante(immagine, .altoDx)))", eTinta(coloreDelQuadrante(immagine, .altoDx), .verde, tolleranza: 60))
        } else {
            verifica("P3 \(nome): il JPEG si rilegge", false)
        }
    }
}

func provaRiduzioneFallimenti() {
    sezione("la riduzione: i quattro modi di non riuscire, e nessun file che resti")
    let cartella = nuovaCartella()
    let destinazione = cartella.appendingPathComponent("niente.jpg")

    let byteCasuali = cartella.appendingPathComponent("casuali.jpg")
    try? casuali(4096).write(to: byteCasuali)
    verificaUguali("byte che non sono un'immagine → formatoNonRiconosciuto", KVElaborazioneFoto.riduci(da: byteCasuali, latoMassimo: 1920, qualita: 0.85, verso: destinazione),
                   .formatoNonRiconosciuto)
    verificaUguali("… e non si scrive niente", esiste(destinazione), false)

    let vuoto = cartella.appendingPathComponent("vuoto.jpg")
    try? Data().write(to: vuoto)
    verificaUguali("un file vuoto → illeggibile", KVElaborazioneFoto.riduci(da: vuoto, latoMassimo: 1920, qualita: 0.85, verso: destinazione), .illeggibile)
    if case .sorgenteNonLetta(let errore) = KVElaborazioneFoto.riduci(da: cartella.appendingPathComponent("non-esiste.jpg"), latoMassimo: 1920, qualita: 0.85, verso: destinazione) {
        verificaUguali("un file che non esiste → sorgenteNonLetta, con l'errore di sistema «NSCocoaErrorDomain:260» (la consegna non ha funzionato)", errore.testo, "NSCocoaErrorDomain:260")
    } else {
        verifica("un file che non esiste → sorgenteNonLetta", false)
    }
    verificaUguali("una cartella al posto del file → illeggibile", KVElaborazioneFoto.riduci(da: cartella, latoMassimo: 1920, qualita: 0.85, verso: destinazione), .illeggibile)

    // Un JPEG a cui manca la testa: il sistema riconosce il tipo ma non ne esce nessuna immagine → un guasto che non è dell'insegnante.
    let intero = cartella.appendingPathComponent("intero.jpg")
    scriviImmagine(quadranti(400, 300), in: intero, tipo: .jpeg)
    let senzaTesta = cartella.appendingPathComponent("senza-testa.jpg")
    if let dati = try? Data(contentsOf: intero) { try? dati.prefix(300).write(to: senzaTesta) }
    verificaUguali("un JPEG tagliato nella testa → riduzioneFallita", KVElaborazioneFoto.riduci(da: senzaTesta, latoMassimo: 1920, qualita: 0.85, verso: destinazione),
                   .riduzioneFallita)
    verificaUguali("lato 0 → riduzioneFallita (i parametri sbagliati non diventano un'immagine)", KVElaborazioneFoto.riduci(da: intero, latoMassimo: 0, qualita: 0.85, verso: destinazione),
                   .riduzioneFallita)

    // La destinazione che non si può scrivere: una cartella non vuota al suo posto (la scrittura atomica non può sostituirla, nemmeno da root).
    let occupata = cartella.appendingPathComponent("occupata.jpg")
    try? FileManager.default.createDirectory(at: occupata, withIntermediateDirectories: true, attributes: nil)
    try? Data("x".utf8).write(to: occupata.appendingPathComponent("x"))
    if case .scritturaFallita(let errore) = KVElaborazioneFoto.riduci(da: intero, latoMassimo: 1920, qualita: 0.85, verso: occupata) {
        verifica("destinazione non scrivibile → scritturaFallita, con l'errore di sistema (dominio e codice)", errore != nil)
    } else {
        verifica("destinazione non scrivibile → scritturaFallita", false)
    }
    verificaUguali("`dimensioni(diFile:)` di byte casuali → nil", KVElaborazioneFoto.dimensioni(diFile: byteCasuali) == nil, true)
    verificaUguali("… e di un file che non c'è → nil", KVElaborazioneFoto.dimensioni(diFile: cartella.appendingPathComponent("no.jpg")) == nil, true)
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
//  2. Funzioni pure della preparazione
// ═══════════════════════════════════════════════════════════════════════════════════════════

/// `export const NOME = [ 'a', 'b' ]` → ["a", "b"].
func elencoDa(_ sorgente: String, dichiarazione: String) -> [String]? {
    guard let inizio = sorgente.range(of: dichiarazione) else { return nil }
    let resto = sorgente[inizio.upperBound...]
    guard let fine = resto.firstIndex(of: "]") else { return nil }
    var voci: [String] = []
    var corrente: String?
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

/// `export const NOME = 123` → 123.
func numeroDa(_ sorgente: String, dichiarazione: String) -> Int? {
    guard let inizio = sorgente.range(of: dichiarazione) else { return nil }
    let cifre = sorgente[inizio.upperBound...].prefix { $0.isNumber }
    return Int(cifre)
}

func provaFunzioniPure(_ tipiTS: String) {
    sezione("lo spazio: peso + 200 MB (200 MiB), al byte (§5.5)")
    let peso: Int64 = 1_500_000_000
    verificaUguali("disponibile = peso + 200 MiB − 1 → insufficiente", KVPreparazioneMedia.spazioSufficiente(disponibile: peso + 209_715_200 - 1, peso: peso), false)
    verificaUguali("disponibile = peso + 200 MiB → sufficiente", KVPreparazioneMedia.spazioSufficiente(disponibile: peso + 209_715_200, peso: peso), true)
    verificaUguali("disponibile = peso → insufficiente", KVPreparazioneMedia.spazioSufficiente(disponibile: peso, peso: peso), false)
    verificaUguali("disponibile 0 → insufficiente", KVPreparazioneMedia.spazioSufficiente(disponibile: 0, peso: 1), false)
    verificaUguali("spazio non leggibile (nil) → non si blocca niente", KVPreparazioneMedia.spazioSufficiente(disponibile: nil, peso: peso), true)
    verificaUguali("il margine è 200 MB, cioè 200 MiB = 209.715.200 byte (come su Android)", KVPreparazioneMedia.margineSpazioByte, 209_715_200)
    verificaUguali("l'impronta si legge a blocchi da 4 MiB", KVPreparazioneMedia.bloccoImprontaByte, 4_194_304)

    sezione("lo spazio libero: la variabile d'ambiente lo forza SOLO in Debug")
    unsetenv("KV_SPAZIO_LIBERO_FORZATO_BYTE")
    let vero = KVPreparazioneMedia.spazioLiberoDelDispositivo()
    verifica("senza la variabile: lo spazio vero del disco, positivo (\(vero.map { String($0) } ?? "nil"))", (vero ?? 0) > 0)
    setenv("KV_SPAZIO_LIBERO_FORZATO_BYTE", "123456", 1)
    let forzato = KVPreparazioneMedia.spazioLiberoDelDispositivo()
    #if DEBUG
    verificaUguali("in Debug la variabile sostituisce lo spazio letto dal sistema", forzato, 123456)
    setenv("KV_SPAZIO_LIBERO_FORZATO_BYTE", "non-un-numero", 1)
    verifica("in Debug un valore non numerico si ignora (torna lo spazio vero)", (KVPreparazioneMedia.spazioLiberoDelDispositivo() ?? 0) > 0)
    setenv("KV_SPAZIO_LIBERO_FORZATO_BYTE", "-5", 1)
    verifica("in Debug un valore negativo si ignora", (KVPreparazioneMedia.spazioLiberoDelDispositivo() ?? 0) > 0)
    #else
    verifica("in Release la variabile NON ha nessun effetto (\(forzato.map { String($0) } ?? "nil") ≠ 123456)", forzato != 123456)
    #endif
    unsetenv("KV_SPAZIO_LIBERO_FORZATO_BYTE")

    sezione("i motivi di rifiuto, le estensioni, i MIME")
    let motiviTS = elencoDa(tipiTS, dichiarazione: "export const MOTIVI_RIFIUTO = [") ?? []
    verificaUguali("i motivi di rifiuto sono ESATTAMENTE quelli di MOTIVI_RIFIUTO (stesso ordine)", KVMotivoRifiuto.allCases.map { $0.rawValue }, motiviTS)
    verificaUguali("sono sei", motiviTS.count, 6)
    verificaUguali("estensione: «MOV» → mov", KVPreparazioneMedia.estensioneSicura("MOV", ripiego: "x"), "mov")
    verificaUguali("estensione: «mp4/../x» → mp4x (solo lettere e cifre)", KVPreparazioneMedia.estensioneSicura("mp4/../x", ripiego: "x"), "mp4x")
    verificaUguali("estensione: vuota → il ripiego", KVPreparazioneMedia.estensioneSicura("", ripiego: "mov"), "mov")
    verificaUguali("estensione: «…» → il ripiego", KVPreparazioneMedia.estensioneSicura("…", ripiego: "mov"), "mov")
    verificaUguali("estensione: al più otto caratteri", KVPreparazioneMedia.estensioneSicura("abcdefghijkl", ripiego: "x"), "abcdefgh")
    verificaUguali("MIME di un .mov → video/quicktime", KVPreparazioneMedia.mimeDelVideo(UTType(filenameExtension: "mov")), "video/quicktime")
    verificaUguali("MIME di un .mp4 → video/mp4", KVPreparazioneMedia.mimeDelVideo(UTType(filenameExtension: "mp4")), "video/mp4")
    verificaUguali("MIME di un .m4v → video/x-m4v", KVPreparazioneMedia.mimeDelVideo(UTType(filenameExtension: "m4v")), "video/x-m4v")
    verificaUguali("MIME di un tipo che non si conosce → il ripiego video/mp4", KVPreparazioneMedia.mimeDelVideo(nil), "video/mp4")
    verificaUguali("MIME di un'immagine → il ripiego video/mp4 (mai image/* su un video)", KVPreparazioneMedia.mimeDelVideo(UTType(filenameExtension: "jpg")), "video/mp4")
    verifica("ogni MIME che esce passa la forma che il server accetta",
             ["mov", "mp4", "m4v", "avi", "3gp", "mpg", "webm"].allSatisfy { KVPoliticaCaricamento.contentTypeAmmesso(KVPreparazioneMedia.mimeDelVideo(UTType(filenameExtension: $0))) })
    verificaUguali("la miniatura è di 320 px come LATO_MINIATURA_VIDEO", KVPreparazioneMedia.latoMiniatura, numeroDa(tipiTS, dichiarazione: "export const LATO_MINIATURA_VIDEO = ") ?? -1)
    verificaUguali("la miniatura è di 320 px (valore scritto qui a mano dalla spec)", KVPreparazioneMedia.latoMiniatura, 320)

    sezione("gli errori del selettore di sistema diventano un motivo (e dicono se vanno nel log)")
    func errore(_ dominio: String, _ codice: Int, sotto: NSError? = nil) -> NSError {
        return NSError(domain: dominio, code: codice, userInfo: sotto.map { [NSUnderlyingErrorKey: $0] } ?? [:])
    }
    let tabella: [(String, NSError, KVMotivoRifiuto, Bool)] = [
        ("NSCocoaErrorDomain 640 (scrittura senza spazio)", errore(NSCocoaErrorDomain, 640), .spazioInsufficiente, false),
        ("NSURLErrorDomain -1009 (rete assente)", errore(NSURLErrorDomain, -1009), .icloudNonDisponibile, false),
        ("NSURLErrorDomain -1001 (tempo scaduto)", errore(NSURLErrorDomain, -1001), .icloudNonDisponibile, false),
        ("PHPhotosErrorDomain 3164 (serve la rete)", errore("PHPhotosErrorDomain", 3164), .icloudNonDisponibile, false),
        ("PHPhotosErrorDomain 3169 (errore di rete)", errore("PHPhotosErrorDomain", 3169), .icloudNonDisponibile, false),
        ("NSItemProviderErrorDomain -1000 che avvolge un errore di rete", errore("NSItemProviderErrorDomain", -1000, sotto: errore(NSURLErrorDomain, -1009)), .icloudNonDisponibile, false),
        ("un errore che avvolge NSCocoaErrorDomain 640", errore("NSItemProviderErrorDomain", -1000, sotto: errore(NSCocoaErrorDomain, 640)), .spazioInsufficiente, false),
        ("NSCocoaErrorDomain 260 (file non trovato)", errore(NSCocoaErrorDomain, 260), .illeggibile, true),
        ("PHPhotosErrorDomain 3300 (altro)", errore("PHPhotosErrorDomain", 3300), .illeggibile, true),
        ("NSItemProviderErrorDomain -1000 senza niente sotto", errore("NSItemProviderErrorDomain", -1000), .illeggibile, true),
    ]
    for (nome, e, motivo, daLoggare) in tabella {
        let esito = KVPreparazioneMedia.motivoPerErrore(e)
        verificaUguali("\(nome) → \(motivo.rawValue)", esito.motivo, motivo)
        verificaUguali("\(nome) → \(daLoggare ? "si scrive nel log" : "rifiuto atteso, nessun log")", esito.daLoggare, daLoggare)
    }
    verificaUguali("erroreDaLoggare: l'involucro del sistema (-1000) con sotto PHPhotos 3300 → «altro:3300» (l'errore vero, non l'involucro)",
                   KVPreparazioneMedia.erroreDaLoggare(errore("NSItemProviderErrorDomain", -1000, sotto: errore("PHPhotosErrorDomain", 3300))).testo, "altro:3300")
    verificaUguali("erroreDaLoggare: l'involucro con sotto un errore di rete → «NSURLErrorDomain:-1009»",
                   KVPreparazioneMedia.erroreDaLoggare(errore("NSItemProviderErrorDomain", -1000, sotto: errore(NSURLErrorDomain, -1009))).testo, "NSURLErrorDomain:-1009")
    verificaUguali("erroreDaLoggare: l'involucro senza niente sotto → «altro:-1000»", KVPreparazioneMedia.erroreDaLoggare(errore("NSItemProviderErrorDomain", -1000)).testo, "altro:-1000")
    verificaUguali("erroreDaLoggare: un errore che non è un involucro resta com'è", KVPreparazioneMedia.erroreDaLoggare(errore(NSCocoaErrorDomain, 260, sotto: errore(NSURLErrorDomain, -1009))).testo,
                   "NSCocoaErrorDomain:260")
    var involucri = errore("DominioFinale", 5)
    for _ in 0..<10 { involucri = errore("NSItemProviderErrorDomain", -1000, sotto: involucri) }
    verificaUguali("erroreDaLoggare: dieci involucri uno dentro l'altro si fermano a quattro livelli (non incastra)", KVPreparazioneMedia.erroreDaLoggare(involucri).testo, "altro:-1000")
    // Una catena di errori che si avvolgono senza fine non deve incastrare: quattro livelli e poi basta.
    var fondo = errore("DominioSconosciuto", 1)
    for n in 0..<10 { fondo = errore("Avvolgitore\(n)", n, sotto: fondo) }
    verificaUguali("una catena di dieci errori sconosciuti si chiude da sola (illeggibile, nel log)", KVPreparazioneMedia.motivoPerErrore(fondo).motivo, .illeggibile)
    verificaUguali("un errore di rete sepolto a più di quattro livelli non si cerca (illeggibile)",
                   KVPreparazioneMedia.motivoPerErrore(errore("A", 1, sotto: errore("B", 2, sotto: errore("C", 3, sotto: errore("D", 4, sotto: errore(NSURLErrorDomain, -1009)))))).motivo, .illeggibile)
}

func provaDizionariDelPonte() {
    sezione("gli elementi sul ponte hanno la forma che gli schemi zod di S1 accettano (campi null PRESENTI, interi, sha256, id)")
    let idForma = try! NSRegularExpression(pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
    func eId(_ s: String) -> Bool { idForma.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil }
    let sha = String(repeating: "ab", count: 32)
    let video = KVElementoScelto.video(KVElementoVideo(id: UUID().uuidString.lowercased(), nome: "Gita", byte: 1234, mime: "video/quicktime", durataSecondi: 12.5,
                                                       miniatura: "data:image/jpeg;base64,AAAA", sha256: sha, origine: .galleria, estensione: "mov", creatoIl: Date()))
    let d = video.comeDizionarioPonte()
    verificaUguali("video: esattamente gli otto campi di S1", Set(d.keys), Set(["id", "tipo", "nome", "byte", "mime", "durataSecondi", "miniatura", "sha256"]))
    verificaUguali("video: tipo", d["tipo"] as? String, "video")
    verifica("video: id con la forma dello schema", eId(d["id"] as? String ?? ""))
    verifica("video: la durata e la miniatura quando ci sono", (d["durataSecondi"] as? Double) == 12.5 && (d["miniatura"] as? String) == "data:image/jpeg;base64,AAAA")
    let senzaDurata = KVElementoScelto.video(KVElementoVideo(id: "abc", nome: "Gita", byte: 1, mime: "video/mp4", durataSecondi: nil, miniatura: nil, sha256: sha, origine: .prova,
                                                             estensione: "mp4", creatoIl: Date())).comeDizionarioPonte()
    verifica("video senza durata né miniatura: i campi ci sono, valgono NSNull", senzaDurata["durataSecondi"] is NSNull && senzaDurata["miniatura"] is NSNull
             && senzaDurata.keys.contains("durataSecondi") && senzaDurata.keys.contains("miniatura"))
    verifica("… e in JSON diventano null (non campi assenti)", {
        guard let dati = try? JSONSerialization.data(withJSONObject: senzaDurata, options: [.sortedKeys]), let testo = String(data: dati, encoding: .utf8) else { return false }
        return testo.contains("\"durataSecondi\":null") && testo.contains("\"miniatura\":null")
    }())
    verifica("video: un oggetto che JSON sa serializzare", JSONSerialization.isValidJSONObject(d))

    let foto = KVElementoScelto.foto(KVElementoFoto(id: "f1", nome: "Foto", larghezza: 1440, altezza: 1920, byte: 99)).comeDizionarioPonte()
    verificaUguali("foto: esattamente i sei campi di S1", Set(foto.keys), Set(["id", "tipo", "nome", "larghezza", "altezza", "byte"]))
    verificaUguali("foto: tipo", foto["tipo"] as? String, "foto")
    verifica("foto: i numeri sono interi", (foto["larghezza"] as? NSNumber)?.intValue == 1440 && (foto["altezza"] as? NSNumber)?.intValue == 1920 && (foto["byte"] as? NSNumber)?.intValue == 99)

    for genere in [KVGenereElemento.foto, .video, .altro] {
        let r = KVElementoScelto.rifiutato(KVElementoRifiutato(id: "r1", nome: "Altro", origine: genere, motivo: .troppoLungo)).comeDizionarioPonte()
        verificaUguali("rifiutato (\(genere.rawValue)): esattamente i cinque campi di S1", Set(r.keys), Set(["id", "tipo", "nome", "origine", "motivo"]))
        verificaUguali("rifiutato (\(genere.rawValue)): origine e motivo", [r["origine"] as? String ?? "", r["motivo"] as? String ?? ""], [genere.rawValue, "troppo-lungo"])
    }

    let a = KVAvanzamentoPreparazione(fatti: 2, totali: 5, byteCopiati: 1000, byteTotali: nil).comeDizionarioPonte()
    verificaUguali("avanzamento: i quattro campi di S1", Set(a.keys), Set(["fatti", "totali", "byteCopiati", "byteTotali"]))
    verifica("avanzamento: byteTotali è NSNull se non si sa", a["byteTotali"] is NSNull)
    let b = KVAvanzamentoPreparazione(fatti: 5, totali: 5, byteCopiati: 1000, byteTotali: 1000).comeDizionarioPonte()
    verifica("avanzamento: byteTotali è un numero se si sa", (b["byteTotali"] as? NSNumber)?.intValue == 1000)
    let negativo = KVAvanzamentoPreparazione(fatti: -1, totali: -2, byteCopiati: -3, byteTotali: -4).comeDizionarioPonte()
    verifica("avanzamento: mai un numero negativo (lo schema vuole interi ≥ 0)", (negativo["fatti"] as? NSNumber)?.intValue == 0 && (negativo["totali"] as? NSNumber)?.intValue == 0
             && (negativo["byteCopiati"] as? NSNumber)?.intValue == 0 && (negativo["byteTotali"] as? NSNumber)?.intValue == 0)
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
//  3. La preparazione dei video
// ═══════════════════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════════════════
//  2b. Il ponte senza Capacitor (`KVPonteCaricamenti`): lettura dei parametri, decisione di accodaVideo, richiesta per il motore
// ═══════════════════════════════════════════════════════════════════════════════════════════

/// Un oggetto come lo consegna il ponte (JSON → Foundation: `NSNumber`, `String`, `NSNull`, dizionari, elenchi): lo stesso tipo di valori della
/// `call.options` di Capacitor, e un `true` è un `NSNumber` di tipo booleano come in produzione.
func dizionario(_ json: String) -> [String: Any] {
    guard let valore = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else {
        print("FATALE: JSON di prova non valido: \(json.prefix(80))")
        exit(3)
    }
    return valore
}

func con(_ base: [String: Any], _ chiave: String, _ valore: Any?) -> [String: Any] {
    var copia = base
    if let valore = valore { copia[chiave] = valore } else { copia.removeValue(forKey: chiave) }
    return copia
}

func conAnnidato(_ base: [String: Any], _ oggetto: String, _ chiave: String, _ valore: Any?) -> [String: Any] {
    var interno = base[oggetto] as? [String: Any] ?? [:]
    if let valore = valore { interno[chiave] = valore } else { interno.removeValue(forKey: chiave) }
    return con(base, oggetto, interno)
}

let shaDiProva = String(repeating: "0123456789abcdef", count: 4)
let jobDiProva = UUID(uuidString: "11111111-2222-4333-8444-555555555555")!

func accodamentoValido() -> [String: Any] {
    return dizionario("""
    {"idElemento":"elem-1","sha256":"\(shaDiProva)","byteAttesi":1234567,
     "jobId":"11111111-2222-4333-8444-555555555555","intentId":"66666666-7777-4888-9999-aaaaaaaaaaaa",
     "utenteId":"bbbbbbbb-cccc-4ddd-8eee-ffffffffffff","scuolaId":"12345678-1234-4234-8234-123456789012",
     "caricamento":{"url":"https://uimulkjyekgemjakmepp.supabase.co/storage/v1/object/upload/sign/video_originals/x/y.mov?token=abc","contentType":"video/quicktime","scadeIl":"2026-10-03T12:00:00.000Z"},
     "rinnovo":{"url":"https://app.kidville.it/api/video-uploads/rinnovo","token":"kvr_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","scadeIl":"2026-10-05T10:00:00.000Z"},
     "registro":{"url":"https://app.kidville.it/api/logs"},
     "testi":{"titolo":"Kidville","invio":"Invio dei video in corso","attesaRete":"Il video è in attesa di rete: riprenderà da solo","pausa":"Invio in pausa: tocca per riprendere"}}
    """)
}

func provaPonte(_ tipiTS: String) {
    sezione("il ponte: i valori elementari (un `true` non è 1, una frazione non è un intero, l'uuid maiuscolo è lo stesso job)")
    verificaUguali("intero(3) = 3", KVPonteCaricamenti.intero(NSNumber(value: 3)), 3)
    verificaUguali("intero(3.0) = 3 (un JSON può scrivere 3.0)", KVPonteCaricamenti.intero(NSNumber(value: 3.0)), 3)
    verificaUguali("intero(2000000000) = 2e9 (il tetto di un video sta in un intero a 64 bit)", KVPonteCaricamenti.intero(NSNumber(value: 2_000_000_000)), 2_000_000_000)
    verificaUguali("intero(3.5) = nil", KVPonteCaricamenti.intero(NSNumber(value: 3.5)), nil)
    verificaUguali("intero(true) = nil", KVPonteCaricamenti.intero(NSNumber(value: true)), nil)
    verificaUguali("intero(false) = nil", KVPonteCaricamenti.intero(NSNumber(value: false)), nil)
    verificaUguali("intero(\"3\") = nil", KVPonteCaricamenti.intero("3"), nil)
    verificaUguali("intero(nil) = nil", KVPonteCaricamenti.intero(nil), nil)
    verificaUguali("intero(NSNull) = nil", KVPonteCaricamenti.intero(NSNull()), nil)
    verificaUguali("intero(NaN) = nil", KVPonteCaricamenti.intero(NSNumber(value: Double.nan)), nil)
    verificaUguali("intero(infinito) = nil", KVPonteCaricamenti.intero(NSNumber(value: Double.infinity)), nil)
    verificaUguali("intero(1e300) = nil", KVPonteCaricamenti.intero(NSNumber(value: 1e300)), nil)
    verificaUguali("decimale(0.85) = 0.85", KVPonteCaricamenti.decimale(NSNumber(value: 0.85)), 0.85)
    verificaUguali("decimale(true) = nil", KVPonteCaricamenti.decimale(NSNumber(value: true)), nil)
    verificaUguali("decimale(\"0.85\") = nil", KVPonteCaricamenti.decimale("0.85"), nil)
    verificaUguali("decimale(NaN) = nil", KVPonteCaricamenti.decimale(NSNumber(value: Double.nan)), nil)
    let minuscolo = "abcdef12-3456-4abc-9def-0123456789ab"
    verificaUguali("uuid: maiuscolo e minuscolo sono lo stesso UUID", KVPonteCaricamenti.uuid(minuscolo.uppercased()), KVPonteCaricamenti.uuid(minuscolo))
    verificaUguali("uuid: un testo qualunque = nil", KVPonteCaricamenti.uuid("non-un-uuid"), nil)
    verificaUguali("uuid: un numero = nil", KVPonteCaricamenti.uuid(NSNumber(value: 5)), nil)
    verificaUguali("stringhe: un elenco di testi", KVPonteCaricamenti.stringhe(["a", "b"]), ["a", "b"])
    verificaUguali("stringhe: un numero fra i testi → nil (tutto o niente)", KVPonteCaricamenti.stringhe(["a", NSNumber(value: 1)] as [Any]), nil)
    verificaUguali("stringhe: non un elenco → nil", KVPonteCaricamenti.stringhe("a"), nil)
    verificaUguali("elencoDiUuid: valido", KVPonteCaricamenti.elencoDiUuid([minuscolo])?.count, 1)
    verificaUguali("elencoDiUuid: uno non valido rovina tutto → nil", KVPonteCaricamenti.elencoDiUuid([minuscolo, "x"]), nil)
    verificaUguali("elencoDiUuid: vuoto → un elenco vuoto (nessuna voce da dimenticare non è un errore)", KVPonteCaricamenti.elencoDiUuid([String]())?.count, 0)
    verificaUguali("elencoDiUuid: 1000 voci passano, 1001 no",
                   [KVPonteCaricamenti.elencoDiUuid(Array(repeating: minuscolo, count: 1000)) != nil, KVPonteCaricamenti.elencoDiUuid(Array(repeating: minuscolo, count: 1001)) != nil],
                   [true, false])
    verificaUguali("elencoDiId: gli id con la forma sbagliata NON si rifiutano (`scarta` li ignora uno per uno)", KVPonteCaricamenti.elencoDiId(["ok", "../x", ""]), ["ok", "../x", ""])
    verificaUguali("elencoDiId: oltre 1000 voci → nil", KVPonteCaricamenti.elencoDiId(Array(repeating: "a", count: 1001)), nil)
    verificaUguali("elencoDiId: un testo solo, non un elenco → nil", KVPonteCaricamenti.elencoDiId("a"), nil)

    sezione("scegliMedia: le opzioni valide passano, ogni numero fuori misura o di un altro tipo no")
    let valide = dizionario(#"{"sorgente":"galleria","massimoElementi":50,"latoMassimoFoto":1920,"qualitaFoto":0.85,"byteMassimiVideo":2000000000,"durataMassimaVideoSecondi":300}"#)
    verificaUguali("le opzioni di J2 (50 elementi, 1920 px, 0,85, 2 GB, 300 s) → quelle", KVPonteCaricamenti.leggiOpzioniDiScelta(valide),
                   KVOpzioniScelta(sorgente: .galleria, massimoElementi: 50, latoMassimoFoto: 1920, qualitaFoto: 0.85, byteMassimiVideo: 2_000_000_000, durataMassimaVideoSecondi: 300))
    verificaUguali("sorgente file", KVPonteCaricamenti.leggiOpzioniDiScelta(con(valide, "sorgente", "file"))?.sorgente, .file)
    for chiave in ["sorgente", "massimoElementi", "latoMassimoFoto", "qualitaFoto", "byteMassimiVideo", "durataMassimaVideoSecondi"] {
        verificaUguali("senza «\(chiave)» → nil", KVPonteCaricamenti.leggiOpzioniDiScelta(con(valide, chiave, nil)), nil)
    }
    verificaUguali("sorgente «altro» → nil", KVPonteCaricamenti.leggiOpzioniDiScelta(con(valide, "sorgente", "altro")), nil)
    verificaUguali("sorgente numerica → nil", KVPonteCaricamenti.leggiOpzioniDiScelta(con(valide, "sorgente", NSNumber(value: 1))), nil)
    let numeri: [(String, Any, Bool)] = [
        ("massimoElementi", NSNumber(value: 0), false), ("massimoElementi", NSNumber(value: -1), false), ("massimoElementi", NSNumber(value: 1), true),
        ("massimoElementi", NSNumber(value: 1000), true), ("massimoElementi", NSNumber(value: 1001), false), ("massimoElementi", NSNumber(value: 2.5), false),
        ("massimoElementi", NSNumber(value: true), false), ("massimoElementi", "50", false),
        ("latoMassimoFoto", NSNumber(value: 0), false), ("latoMassimoFoto", NSNumber(value: 1), true), ("latoMassimoFoto", NSNumber(value: 8192), true), ("latoMassimoFoto", NSNumber(value: 8193), false),
        ("qualitaFoto", NSNumber(value: 0), false), ("qualitaFoto", NSNumber(value: 0.01), true), ("qualitaFoto", NSNumber(value: 1.0), true), ("qualitaFoto", NSNumber(value: 1.01), false),
        ("qualitaFoto", NSNumber(value: -0.5), false), ("qualitaFoto", NSNumber(value: true), false),
        ("byteMassimiVideo", NSNumber(value: 0), false), ("byteMassimiVideo", NSNumber(value: 1), true), ("byteMassimiVideo", NSNumber(value: -5), false),
        ("durataMassimaVideoSecondi", NSNumber(value: 0), false), ("durataMassimaVideoSecondi", NSNumber(value: 1), true), ("durataMassimaVideoSecondi", NSNumber(value: 86_400), true),
        ("durataMassimaVideoSecondi", NSNumber(value: 86_401), false), ("durataMassimaVideoSecondi", NSNumber(value: 300.5), false),
    ]
    for (chiave, valore, ammesso) in numeri {
        verificaUguali("«\(chiave)» = \(valore) → \(ammesso ? "accettato" : "rifiutato")", KVPonteCaricamenti.leggiOpzioniDiScelta(con(valide, chiave, valore)) != nil, ammesso)
    }

    sezione("accodaVideo: i parametri validi passano nei tipi giusti, ogni campo mancante o di forma sbagliata rifiuta TUTTO")
    let valido = accodamentoValido()
    guard let p = KVPonteCaricamenti.leggiAccodamento(valido) else {
        verifica("i parametri validi si leggono", false)
        return
    }
    verificaUguali("idElemento, sha256, byteAttesi", [p.idElemento, p.sha256, String(p.byteAttesi)], ["elem-1", shaDiProva, "1234567"])
    verificaUguali("i quattro uuid", [p.jobId.uuidString, p.intentId.uuidString, p.utenteId.uuidString, p.scuolaId.uuidString],
                   ["11111111-2222-4333-8444-555555555555", "66666666-7777-4888-9999-AAAAAAAAAAAA", "BBBBBBBB-CCCC-4DDD-8EEE-FFFFFFFFFFFF", "12345678-1234-4234-8234-123456789012"])
    verificaUguali("caricamento: url, content-type, scadenza dell'URL", [p.urlPut, p.contentType, p.scadenzaUrl ?? "nil"],
                   ["https://uimulkjyekgemjakmepp.supabase.co/storage/v1/object/upload/sign/video_originals/x/y.mov?token=abc", "video/quicktime", "2026-10-03T12:00:00.000Z"])
    verificaUguali("rinnovo: url, token, scadenza del TOKEN", [p.urlRinnovo, p.token, p.scadenzaToken],
                   ["https://app.kidville.it/api/video-uploads/rinnovo", "kvr_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "2026-10-05T10:00:00.000Z"])
    verificaUguali("registro: url", p.urlRegistro, "https://app.kidville.it/api/logs")
    verificaUguali("i testi delle notifiche", [p.testi.titolo, p.testi.invio, p.testi.attesaRete, p.testi.pausa],
                   ["Kidville", "Invio dei video in corso", "Il video è in attesa di rete: riprenderà da solo", "Invio in pausa: tocca per riprendere"])
    for (nome, mutato) in [
        ("senza idElemento", con(valido, "idElemento", nil)), ("senza sha256", con(valido, "sha256", nil)), ("senza byteAttesi", con(valido, "byteAttesi", nil)),
        ("senza jobId", con(valido, "jobId", nil)), ("senza intentId", con(valido, "intentId", nil)), ("senza utenteId", con(valido, "utenteId", nil)), ("senza scuolaId", con(valido, "scuolaId", nil)),
        ("senza caricamento", con(valido, "caricamento", nil)), ("senza caricamento.url", conAnnidato(valido, "caricamento", "url", nil)),
        ("senza caricamento.contentType", conAnnidato(valido, "caricamento", "contentType", nil)),
        ("senza rinnovo", con(valido, "rinnovo", nil)), ("senza rinnovo.url", conAnnidato(valido, "rinnovo", "url", nil)), ("senza rinnovo.token", conAnnidato(valido, "rinnovo", "token", nil)),
        ("senza rinnovo.scadeIl", conAnnidato(valido, "rinnovo", "scadeIl", nil)), ("senza registro", con(valido, "registro", nil)), ("senza registro.url", conAnnidato(valido, "registro", "url", nil)),
        ("idElemento con una barra", con(valido, "idElemento", "a/b")), ("idElemento vuoto", con(valido, "idElemento", "")), ("idElemento di 65 caratteri", con(valido, "idElemento", String(repeating: "a", count: 65))),
        ("idElemento che comincia con un punto", con(valido, "idElemento", ".nascosto")),
        ("sha256 in maiuscolo", con(valido, "sha256", shaDiProva.uppercased())), ("sha256 di 63 cifre", con(valido, "sha256", String(shaDiProva.dropLast()))),
        ("sha256 non esadecimale", con(valido, "sha256", String(repeating: "g", count: 64))),
        ("byteAttesi zero", con(valido, "byteAttesi", NSNumber(value: 0))), ("byteAttesi negativo", con(valido, "byteAttesi", NSNumber(value: -1))),
        ("byteAttesi con la virgola", con(valido, "byteAttesi", NSNumber(value: 10.5))), ("byteAttesi booleano", con(valido, "byteAttesi", NSNumber(value: true))), ("byteAttesi testo", con(valido, "byteAttesi", "100")),
        ("jobId non uuid", con(valido, "jobId", "non-un-uuid")), ("utenteId numerico", con(valido, "utenteId", NSNumber(value: 4))),
        ("caricamento non un oggetto", con(valido, "caricamento", "https://x")), ("rinnovo.token numerico", conAnnidato(valido, "rinnovo", "token", NSNumber(value: 1))),
        ("scadeIl dell'URL numerico (non è una data né null)", conAnnidato(valido, "caricamento", "scadeIl", NSNumber(value: 5))),
    ] as [(String, [String: Any])] {
        verificaUguali("\(nome) → nil", KVPonteCaricamenti.leggiAccodamento(mutato), nil)
    }
    verificaUguali("scadeIl dell'URL = null → «non nota» (si rinnova prima di spedire)", KVPonteCaricamenti.leggiAccodamento(conAnnidato(valido, "caricamento", "scadeIl", NSNull()))?.scadenzaUrl, nil)
    verifica("… e il resto dei parametri resta letto", KVPonteCaricamenti.leggiAccodamento(conAnnidato(valido, "caricamento", "scadeIl", NSNull())) != nil)
    verificaUguali("scadeIl dell'URL assente → «non nota»", KVPonteCaricamenti.leggiAccodamento(conAnnidato(valido, "caricamento", "scadeIl", nil))?.scadenzaUrl, nil)
    verificaUguali("uuid in maiuscolo → gli stessi uuid", KVPonteCaricamenti.leggiAccodamento(con(valido, "jobId", "11111111-2222-4333-8444-555555555555".uppercased()))?.jobId, p.jobId)
    verificaUguali("byteAttesi scritto 1234567.0 → lo stesso intero", KVPonteCaricamenti.leggiAccodamento(con(valido, "byteAttesi", NSNumber(value: 1234567.0)))?.byteAttesi, 1234567)
    verificaUguali("testi assenti → il ripiego (vuoti: la coda ci mette l'italiano)", KVPonteCaricamenti.leggiAccodamento(con(valido, "testi", nil))?.testi, KVTestiNotifiche(titolo: "", invio: "", attesaRete: "", pausa: ""))
    verificaUguali("testi parziali → i pezzi che ci sono, gli altri vuoti",
                   KVPonteCaricamenti.leggiAccodamento(con(valido, "testi", ["titolo": "Solo titolo"]))?.testi, KVTestiNotifiche(titolo: "Solo titolo", invio: "", attesaRete: "", pausa: ""))
    verificaUguali("testi di un altro tipo → il ripiego (mai un rifiuto per una cosa cosmetica)", KVPonteCaricamenti.leggiAccodamento(con(valido, "testi", "ciao"))?.testi,
                   KVTestiNotifiche(titolo: "", invio: "", attesaRete: "", pausa: ""))
    verifica("un campo in più (di un JavaScript più nuovo) si ignora", KVPonteCaricamenti.leggiAccodamento(con(valido, "campoNuovo", "x")) != nil)

    sezione("accodaVideo: la DECISIONE — l'elemento deve essere quello scelto; senza ricordo vale solo l'apertura ripetuta di un video già in coda")
    let ricordo = KVElementoVideo(id: "elem-1", nome: "Gita", byte: 1_234_567, mime: "video/quicktime", durataSecondi: 10, miniatura: nil, sha256: shaDiProva, origine: .galleria,
                                  estensione: "mov", creatoIl: Date())
    let preparato = URL(fileURLWithPath: "/tmp/scelti/elem-1.mov")
    func voce(byte: Int64 = 1_234_567, stato: KVStatoCaricamento = .inInvio) -> KVVoceCoda {
        var v = KVVoceCoda(jobId: jobDiProva, intentId: p.intentId, utenteId: p.utenteId, scuolaId: p.scuolaId, nome: "Gita", file: "file/\(jobDiProva.uuidString.lowercased()).mov", byte: byte,
                           mime: "video/quicktime", origine: .galleria, urlScadeIl: nil, tokenScadeIl: Date().addingTimeInterval(3600), creatoIl: Date())
        v.stato = stato
        return v
    }
    func decidi(_ parametri: KVParametriAccodamento, ricordo: KVElementoVideo?, preparato: URL?, voce: KVVoceCoda?) -> KVDecisioneAccodamento {
        return KVPonteCaricamenti.decidiAccodamento(parametri: parametri, ricordo: ricordo, preparato: preparato, voceEsistente: voce)
    }
    verificaUguali("elemento di questa sessione, impronta e peso uguali → si procede col preparato", decidi(p, ricordo: ricordo, preparato: preparato, voce: nil), .procedi(sorgente: preparato))
    verificaUguali("… anche se il preparato non c'è più (già spostato): il motore accetterà solo un video già in coda", decidi(p, ricordo: ricordo, preparato: nil, voce: nil), .procedi(sorgente: nil))
    var altroSha = p
    altroSha.sha256 = String(repeating: "f", count: 64)
    verificaUguali("sha256 DIVERSO da quello dell'elemento → ELEMENTO_DIVERSO", decidi(altroSha, ricordo: ricordo, preparato: preparato, voce: nil), .rifiuta(.elementoDiverso))
    var altroPeso = p
    altroPeso.byteAttesi = 1_234_568
    verificaUguali("byteAttesi DIVERSI (+1) da quelli dell'elemento → ELEMENTO_DIVERSO", decidi(altroPeso, ricordo: ricordo, preparato: preparato, voce: nil), .rifiuta(.elementoDiverso))
    altroPeso.byteAttesi = 1_234_566
    verificaUguali("byteAttesi DIVERSI (−1) → ELEMENTO_DIVERSO", decidi(altroPeso, ricordo: ricordo, preparato: preparato, voce: nil), .rifiuta(.elementoDiverso))
    verificaUguali("una voce viva col solo job uguale NON salva un elemento diverso (il ricordo comanda)", decidi(altroSha, ricordo: ricordo, preparato: preparato, voce: voce()), .rifiuta(.elementoDiverso))
    verificaUguali("nessun ricordo, nessuna voce → ELEMENTO_ASSENTE", decidi(p, ricordo: nil, preparato: nil, voce: nil), .rifiuta(.elementoAssente))
    verificaUguali("nessun ricordo e un file in scelti/ di cui non si conosce l'impronta → ELEMENTO_ASSENTE, e il file NON si passa al motore", decidi(p, ricordo: nil, preparato: preparato, voce: nil), .rifiuta(.elementoAssente))
    for stato in KVStatoCaricamento.allCases {
        let atteso: KVDecisioneAccodamento = stato.eTerminale ? .rifiuta(.elementoAssente) : .procedi(sorgente: nil)
        verificaUguali("apertura ripetuta: nessun ricordo, voce «\(stato.rawValue)» con lo stesso peso → \(stato.eTerminale ? "ELEMENTO_ASSENTE (è terminale)" : "si procede senza sorgente")",
                       decidi(p, ricordo: nil, preparato: nil, voce: voce(stato: stato)), atteso)
    }
    verificaUguali("apertura ripetuta con un peso diverso da quello della voce → ELEMENTO_DIVERSO", decidi(p, ricordo: nil, preparato: nil, voce: voce(byte: 99)), .rifiuta(.elementoDiverso))
    verificaUguali("apertura ripetuta: un file in scelti/ qualunque non si passa mai senza ricordo", decidi(p, ricordo: nil, preparato: preparato, voce: voce()), .procedi(sorgente: nil))

    sezione("accodaVideo: la RICHIESTA per il motore — i campi di ogni parte nel posto giusto")
    let r = KVPonteCaricamenti.richiesta(per: p, ricordo: ricordo, sorgente: preparato)
    verificaUguali("job, intento, utente, scuola", [r.jobId, r.intentId, r.utenteId, r.scuolaId], [p.jobId, p.intentId, p.utenteId, p.scuolaId])
    verificaUguali("dal video preparato: nome, MIME, origine, estensione", [r.nome, r.mime, r.origine.rawValue, r.estensione], ["Gita", "video/quicktime", "galleria", "mov"])
    verificaUguali("idElemento e byteAttesi", [r.idElemento, String(r.byteAttesi)], ["elem-1", "1234567"])
    verificaUguali("sorgente: il preparato", r.sorgente, preparato)
    verificaUguali("la PUT: url e content-type DEL SERVER", [r.urlPut, r.contentType], [p.urlPut, "video/quicktime"])
    verificaUguali("scadenza dell'URL (job) e del token (rinnovo), ciascuna al suo posto", [r.scadenzaUrl ?? "nil", r.scadenzaToken], ["2026-10-03T12:00:00.000Z", "2026-10-05T10:00:00.000Z"])
    verificaUguali("rinnovo e registro", [r.urlRinnovo, r.token, r.urlRegistro], [p.urlRinnovo, p.token, p.urlRegistro])
    verificaUguali("i testi", r.testi, p.testi)
    // Il content-type è quello del SERVER anche quando il video preparato ha un altro MIME.
    var altroTipo = p
    altroTipo.contentType = "video/mp4"
    verificaUguali("il content-type della PUT è quello del server, non il MIME del file (`video/quicktime` ≠ `video/mp4`)", [KVPonteCaricamenti.richiesta(per: altroTipo, ricordo: ricordo, sorgente: preparato).contentType,
                                                                                                                      KVPonteCaricamenti.richiesta(per: altroTipo, ricordo: ricordo, sorgente: preparato).mime], ["video/mp4", "video/quicktime"])
    let senzaRicordo = KVPonteCaricamenti.richiesta(per: p, ricordo: nil, sorgente: nil)
    verificaUguali("senza ricordo: nome di ripiego, MIME del server, origine galleria, estensione mp4, nessuna sorgente", [senzaRicordo.nome, senzaRicordo.mime, senzaRicordo.origine.rawValue, senzaRicordo.estensione, senzaRicordo.sorgente == nil ? "nil" : "?"],
                   ["Video", "video/quicktime", "galleria", "mp4", "nil"])
    var tipoStrano = p
    tipoStrano.contentType = "non un mime"
    verificaUguali("senza ricordo e con un content-type che il server non accetterebbe: MIME di ripiego video/mp4 (il content-type resta com'è, lo giudica il motore)",
                   [KVPonteCaricamenti.richiesta(per: tipoStrano, ricordo: nil, sorgente: nil).mime, KVPonteCaricamenti.richiesta(per: tipoStrano, ricordo: nil, sorgente: nil).contentType], ["video/mp4", "non un mime"])
    let prova = KVElementoVideo(id: "elem-1", nome: "collaudo-1234abcd.mp4", byte: 1_234_567, mime: "video/mp4", durataSecondi: nil, miniatura: nil, sha256: shaDiProva, origine: .prova, estensione: "mp4", creatoIl: Date())
    verificaUguali("un elemento di prova passa la sua origine al motore", KVPonteCaricamenti.richiesta(per: p, ricordo: prova, sorgente: preparato).origine, .prova)

    sezione("i rifiuti del ponte: i sette codici di CODICI_RIFIUTO_PONTE, un messaggio costante ciascuno, e ogni rifiuto del motore ha il suo")
    let codiciTS = elencoDa(tipiTS, dichiarazione: "export const CODICI_RIFIUTO_PONTE = [") ?? []
    verificaUguali("i codici sono ESATTAMENTE quelli di CODICI_RIFIUTO_PONTE, nello stesso ordine", KVRifiutoPonte.allCases.map { $0.rawValue }, codiciTS)
    verificaUguali("sono sette", codiciTS.count, 7)
    verificaUguali("i messaggi sono tutti diversi", Set(KVRifiutoPonte.allCases.map { $0.messaggio }).count, 7)
    verifica("i messaggi non sono vuoti e non portano né percorsi né indirizzi né numeri", KVRifiutoPonte.allCases.allSatisfy {
        !$0.messaggio.isEmpty && !$0.messaggio.contains("/") && !$0.messaggio.contains("http") && $0.messaggio.rangeOfCharacter(from: .decimalDigits) == nil
    })
    verificaUguali("rifiuto del motore elementoAssente → ELEMENTO_ASSENTE", KVRifiutoAccodamento.elementoAssente.comeRifiutoDelPonte, .elementoAssente)
    verificaUguali("rifiuto del motore elementoDiverso → ELEMENTO_DIVERSO", KVRifiutoAccodamento.elementoDiverso.comeRifiutoDelPonte, .elementoDiverso)
    verificaUguali("rifiuto del motore hostNonAmmesso → HOST_NON_AMMESSO", KVRifiutoAccodamento.hostNonAmmesso.comeRifiutoDelPonte, .hostNonAmmesso)
    verificaUguali("rifiuto del motore parametriNonValidi → PARAMETRI_NON_VALIDI", KVRifiutoAccodamento.parametriNonValidi.comeRifiutoDelPonte, .parametriNonValidi)
    verificaUguali("rifiuto del motore interno → INTERNO", KVRifiutoAccodamento.interno.comeRifiutoDelPonte, .interno)
}

func eventiDelRegistro(_ banco: Banco) -> [String] { banco.eventi.map { $0.messaggio } }

func provaImpronta(_ risorse: Risorse) {
    sezione("l'impronta SHA-256: il vettore NIST, i confini dei blocchi da 4 MiB, e un SHA indipendente")
    let cartella = nuovaCartella()
    let abc = cartella.appendingPathComponent("abc.bin")
    try? Data("abc".utf8).write(to: abc)
    verificaUguali("SHA-256 di «abc» = il vettore NIST (scritto a mano)",
                   KVPreparazioneMedia.calcolaImpronta(di: abc, pesoAtteso: 3, avanzamento: { _ in }, annullata: { false }),
                   .fatta("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"))
    let blocco = KVPreparazioneMedia.bloccoImprontaByte
    for (nome, byte) in [("un byte", 1), ("un blocco meno 1", blocco - 1), ("un blocco esatto", blocco), ("un blocco più 1", blocco + 1), ("due blocchi esatti", 2 * blocco),
                         ("2 blocchi + 123", 2 * blocco + 123)] {
        let file = cartella.appendingPathComponent("b\(byte).bin")
        try? casuali(byte).write(to: file)
        var visti: [Int64] = []
        let esito = KVPreparazioneMedia.calcolaImpronta(di: file, pesoAtteso: Int64(byte), avanzamento: { visti.append($0) }, annullata: { false })
        verificaUguali("\(nome) (\(byte) B): lo stesso SHA-256 di CommonCrypto sul file intero", esito, .fatta(shaIndipendente(file) ?? "?"))
        verificaUguali("\(nome): l'avanzamento sale a ogni blocco e finisce sul peso", visti.last, Int64(byte))
        verifica("\(nome): l'avanzamento è strettamente crescente", zip(visti, visti.dropFirst()).allSatisfy { $0 < $1 })
        verificaUguali("\(nome): un avanzamento per blocco (\((byte + blocco - 1) / blocco))", visti.count, (byte + blocco - 1) / blocco)
    }
    // Annullata dopo il primo blocco.
    let grande = cartella.appendingPathComponent("grande.bin")
    try? casuali(3 * blocco).write(to: grande)
    var letti = 0
    verificaUguali("annullata dopo il primo blocco → .annullata", KVPreparazioneMedia.calcolaImpronta(di: grande, pesoAtteso: Int64(3 * blocco),
                                                                                                   avanzamento: { _ in letti += 1 }, annullata: { letti >= 1 }), .annullata)
    verificaUguali("… dopo UN solo blocco letto, non di più", letti, 1)
    // Il file che cambia sotto i piedi: il peso atteso non è quello letto.
    let esitoPeso = KVPreparazioneMedia.calcolaImpronta(di: abc, pesoAtteso: 4, avanzamento: { _ in }, annullata: { false })
    verificaUguali("peso atteso 4 su un file di 3 byte → fallita (l'impronta non descriverebbe ciò che parte)", esitoPeso, .fallita(nil))
    if case .fallita(let e) = KVPreparazioneMedia.calcolaImpronta(di: cartella.appendingPathComponent("non-esiste.bin"), pesoAtteso: 1, avanzamento: { _ in }, annullata: { false }) {
        verifica("un file che non si apre → fallita con l'errore di sistema", e != nil)
    } else {
        verifica("un file che non si apre → fallita", false)
    }
    _ = risorse
}

func provaPreparazioneVideo(_ risorse: Risorse) {
    sezione("un video VERO: spostato in scelti/, con durata, miniatura dritta e sha256 (§5.5)")
    let banco = Banco()
    let sorgente = copiaFresca(risorse.clip, nome: "IMG_0001.mp4")
    let pesoOriginale = pesoDi(sorgente)
    var visti: [Int64] = []
    guard case .video(let v)? = banco.preparazione.preparaVideo(daFile: sorgente, nome: "IMG_0001", origine: .galleria, opzioni: opzioni(sorgente: .galleria),
                                                                 avanzamento: { visti.append($0) }, annullata: { false }) else {
        verifica("il video si prepara", false)
        return
    }
    let idForma = try! NSRegularExpression(pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
    verifica("l'id ha la forma dello schema (gettone senza separatori)", idForma.firstMatch(in: v.id, range: NSRange(v.id.startIndex..., in: v.id)) != nil)
    let destinazione = banco.scelti.appendingPathComponent("\(v.id).mp4")
    verificaUguali("il file sta in scelti/<id>.mp4 (e nient'altro: la sorgente si è SPOSTATA)", nomiIn(banco.scelti), ["\(v.id).mp4"])
    verificaUguali("la sorgente non c'è più", esiste(sorgente), false)
    verificaUguali("il peso è quello del file (\(pesoOriginale) B), spostato senza copia né modifica", [v.byte, pesoDi(destinazione)], [pesoOriginale, pesoOriginale])
    verificaUguali("sha256: lo stesso di CommonCrypto sul file spostato", v.sha256, shaIndipendente(destinazione) ?? "?")
    verifica("sha256: 64 cifre esadecimali minuscole", v.sha256.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil)
    verificaUguali("mime: video/mp4 (dal tipo, non dall'estensione che ci è capitata)", v.mime, "video/mp4")
    verificaUguali("estensione: mp4", v.estensione, "mp4")
    verificaUguali("origine: galleria", v.origine, .galleria)
    verificaUguali("nome: quello del sistema, per lo schermo", v.nome, "IMG_0001")
    verifica("durata ≈ 2 s (\(v.durataSecondi.map { String($0) } ?? "nil"))", abs((v.durataSecondi ?? 0) - 2.0) < 0.2)
    verifica("l'avanzamento dell'impronta c'è e finisce sul peso", visti.last == pesoOriginale && !visti.isEmpty)
    verifica("il video si trova per id (`video(conId:)`) e `preparato(conId:)` dà il file", banco.preparazione.video(conId: v.id) == v
             && banco.preparazione.preparato(conId: v.id)?.lastPathComponent == "\(v.id).mp4")
    verifica("un id che non si è mai preparato non si trova", banco.preparazione.video(conId: "mai-esistito") == nil && banco.preparazione.preparato(conId: "mai-esistito") == nil)
    var protetto: Bool?
    protetto = (try? destinazione.resourceValues(forKeys: [.isExcludedFromBackupKey]))?.isExcludedFromBackup
    verificaUguali("il file è escluso dal backup", protetto, true)
    // La miniatura: un data URL JPEG di al più 320 px, nell'orientamento giusto.
    guard let miniatura = v.miniatura, miniatura.hasPrefix("data:image/jpeg;base64,"),
          let dati = Data(base64Encoded: String(miniatura.dropFirst("data:image/jpeg;base64,".count))) else {
        verifica("miniatura: un data URL image/jpeg;base64", false, "\(v.miniatura ?? "nil")")
        return
    }
    verifica("miniatura: forma `data:image/jpeg;base64,<base64 con padding, senza a capo>`", miniatura.range(of: "^data:image/jpeg;base64,[A-Za-z0-9+/]+={0,2}$", options: .regularExpression) != nil)
    let fileMiniatura = nuovaCartella().appendingPathComponent("miniatura.jpg")
    try? dati.write(to: fileMiniatura)
    if let immagine = leggiImmagine(fileMiniatura) {
        verificaUguali("miniatura: 320 × 180 (il lato lungo è 320, l'aspetto 16:9 resta)", [immagine.width, immagine.height], [320, 180])
        verifica("miniatura: il rosso in alto a sinistra \(descrivi(coloreDelQuadrante(immagine, .altoSx)))", eTinta(coloreDelQuadrante(immagine, .altoSx), .rosso))
        verifica("miniatura: il giallo in basso a destra \(descrivi(coloreDelQuadrante(immagine, .bassoDx)))", eTinta(coloreDelQuadrante(immagine, .bassoDx), .giallo))
    } else {
        verifica("miniatura: si rilegge", false)
    }
    verifica("miniatura: nessun metadato nel JPEG", !marcatoriJPEG(dati).contains(0xE1))
    verificaUguali("nessun log per un video che va bene", eventiDelRegistro(banco), [])

    sezione("un video girato in verticale: la miniatura è dritta (appliesPreferredTrackTransform)")
    let verticale = copiaFresca(risorse.clipVerticale, nome: "verticale.mp4")
    if case .video(let w)? = banco.preparazione.preparaVideo(daFile: verticale, nome: "verticale", origine: .galleria, opzioni: opzioni(), avanzamento: { _ in }, annullata: { false }),
       let miniatura = w.miniatura, let dati = Data(base64Encoded: String(miniatura.dropFirst("data:image/jpeg;base64,".count))) {
        let file = nuovaCartella().appendingPathComponent("m.jpg")
        try? dati.write(to: file)
        if let immagine = leggiImmagine(file) {
            verificaUguali("miniatura di un 640 × 360 ruotato di 90°: 180 × 320 (in verticale)", [immagine.width, immagine.height], [180, 320])
            // La rotazione di 90° in senso orario porta il rosso (alto-sx in memoria) in alto a destra.
            verifica("… col rosso in alto a destra \(descrivi(coloreDelQuadrante(immagine, .altoDx)))", eTinta(coloreDelQuadrante(immagine, .altoDx), .rosso))
        }
    } else {
        verifica("il video verticale si prepara, con la sua miniatura", false)
    }
}

func provaRifiutiVideo(_ risorse: Risorse) {
    sezione("i rifiuti dei video: un motivo, nessuna copia che resti, nessun log (sono rifiuti attesi)")
    func rifiuto(_ nome: String, _ banco: Banco, _ sorgente: URL, _ opz: KVOpzioniScelta, atteso: KVMotivoRifiuto, genere: KVGenereElemento = .video) {
        let esito = banco.preparazione.preparaVideo(daFile: sorgente, nome: "Prova", origine: .file, opzioni: opz, avanzamento: { _ in }, annullata: { false })
        if case .rifiutato(let r)? = esito {
            verificaUguali("\(nome): motivo \(atteso.rawValue)", r.motivo, atteso)
            verificaUguali("\(nome): origine \(genere.rawValue)", r.origine, genere)
            verificaUguali("\(nome): nome per lo schermo", r.nome, "Prova")
        } else {
            verifica("\(nome): rifiutato", false, "esito: \(String(describing: esito))")
        }
        verificaUguali("\(nome): nessuna copia in scelti/", nomiIn(banco.scelti), [])
        verificaUguali("\(nome): la sorgente è cancellata", esiste(sorgente), false)
        verificaUguali("\(nome): nessun log (un rifiuto atteso non è un errore)", eventiDelRegistro(banco), [])
    }
    // Troppo lungo: 2 s con un tetto di 1 s; e al confine esatto (2 s con tetto 2 s) entra.
    rifiuto("troppo lungo (2 s, tetto 1 s)", Banco(), copiaFresca(risorse.clip), opzioni(durataMassima: 1), atteso: .troppoLungo)
    let alConfine = Banco()
    let sorgenteConfine = copiaFresca(risorse.clip)
    if case .video? = alConfine.preparazione.preparaVideo(daFile: sorgenteConfine, nome: "x", origine: .file, opzioni: opzioni(durataMassima: 2), avanzamento: { _ in }, annullata: { false }) {
        verifica("2 s con tetto 2 s: entra (si rifiuta solo ciò che supera il tetto)", true)
    } else {
        verifica("2 s con tetto 2 s: entra", false)
    }
    // Troppo grande: peso > tetto; e al confine esatto entra.
    let pesoClip = pesoDi(risorse.clip)
    rifiuto("troppo grande (tetto \(pesoClip - 1) B, il file ne pesa \(pesoClip))", Banco(), copiaFresca(risorse.clip), opzioni(byteMassimi: pesoClip - 1), atteso: .troppoGrande)
    let pesoEsatto = Banco()
    if case .video? = pesoEsatto.preparazione.preparaVideo(daFile: copiaFresca(risorse.clip), nome: "x", origine: .file, opzioni: opzioni(byteMassimi: pesoClip), avanzamento: { _ in }, annullata: { false }) {
        verifica("peso = tetto: entra", true)
    } else {
        verifica("peso = tetto: entra", false)
    }
    // Poco spazio: al byte.
    rifiuto("poco spazio (disponibile = peso + 200 MiB − 1)", Banco(spazio: { pesoClip + 209_715_200 - 1 }), copiaFresca(risorse.clip), opzioni(), atteso: .spazioInsufficiente)
    let spazioGiusto = Banco(spazio: { pesoClip + 209_715_200 })
    if case .video? = spazioGiusto.preparazione.preparaVideo(daFile: copiaFresca(risorse.clip), nome: "x", origine: .file, opzioni: opzioni(), avanzamento: { _ in }, annullata: { false }) {
        verifica("spazio = peso + 200 MiB: entra", true)
    } else {
        verifica("spazio = peso + 200 MiB: entra", false)
    }
    // Illeggibile: troncato (moov mancante), vuoto, e byte casuali con l'estensione di un contenitore che conosciamo.
    rifiuto("file troncato (manca l'indice moov)", Banco(), copiaFresca(risorse.clipTroncato), opzioni(), atteso: .illeggibile)
    let vuoto = nuovaCartella().appendingPathComponent("vuoto.mov")
    try? Data().write(to: vuoto)
    rifiuto("file vuoto", Banco(), vuoto, opzioni(), atteso: .illeggibile)
    rifiuto("byte casuali con estensione .mov", Banco(), copiaFresca(risorse.junkMov), opzioni(), atteso: .illeggibile)
    // Un video vuoto di un contenitore che AVFoundation non conosce: lo rifiuta il controllo del peso (con un .mov vuoto lo rifiuterebbe già la lettura).
    let vuotoAvi = nuovaCartella().appendingPathComponent("vuoto.avi")
    try? Data().write(to: vuotoAvi)
    rifiuto("file vuoto con estensione .avi (nessun contenitore noto a salvarlo)", Banco(), vuotoAvi, opzioni(), atteso: .illeggibile)
    let inesistente = nuovaCartella().appendingPathComponent("non-c-e.mov")
    let esitoInesistente = Banco().preparazione.preparaVideo(daFile: inesistente, nome: "Prova", origine: .file, opzioni: opzioni(), avanzamento: { _ in }, annullata: { false })
    if case .rifiutato(let r)? = esitoInesistente { verificaUguali("un file che non c'è → illeggibile", r.motivo, .illeggibile) } else { verifica("un file che non c'è → illeggibile", false) }
    do {
        // Un video che non si legge NON è un video vuoto: è una consegna del sistema che non ha funzionato, e si scrive (un vuoto è un rifiuto atteso, senza log).
        let b = Banco()
        _ = b.preparazione.preparaVideo(daFile: inesistente, nome: "Prova", origine: .file, opzioni: opzioni(), avanzamento: { _ in }, annullata: { false })
        verificaUguali("un video che non si legge → un guasto nostro nel log: media-nativo-preparazione-fallita: COPIA", eventiDelRegistro(b), ["media-nativo-preparazione-fallita: COPIA"])
        verificaUguali("… col tipo video e l'errore di sistema «NSCocoaErrorDomain:260»", [b.eventi.first?.campi["tipo"], b.eventi.first?.campi["error_code"]],
                       [KVValoreCampo.testo("video"), KVValoreCampo.testo("NSCocoaErrorDomain:260")] as [KVValoreCampo?])
    }
    // Troppo grande ha la precedenza su troppo lungo e su poco spazio (si dice la ragione che non si aggiusta liberando spazio).
    rifiuto("troppo grande E troppo lungo → troppo-grande", Banco(), copiaFresca(risorse.clip), opzioni(byteMassimi: 10, durataMassima: 1), atteso: .troppoGrande)
    rifiuto("troppo grande E poco spazio → troppo-grande", Banco(spazio: { 0 }), copiaFresca(risorse.clip), opzioni(byteMassimi: 10), atteso: .troppoGrande)

    sezione("un contenitore che AVFoundation non conosce (.avi) NON è illeggibile: entra senza durata, lo converte il server")
    let banco = Banco()
    let avi = copiaFresca(risorse.junkAvi, nome: "film.avi")
    if case .video(let v)? = banco.preparazione.preparaVideo(daFile: avi, nome: "film", origine: .file, opzioni: opzioni(), avanzamento: { _ in }, annullata: { false }) {
        verificaUguali("estensione avi, mime del sistema", [v.estensione, v.mime], ["avi", "video/avi"])
        verificaUguali("durata ignota: nil (mai zero)", v.durataSecondi == nil, true)
        verificaUguali("miniatura assente: nil", v.miniatura == nil, true)
        verificaUguali("sha256 di 9 MiB + 123 byte = quello indipendente (tre blocchi, l'ultimo parziale)", v.sha256, shaIndipendente(banco.scelti.appendingPathComponent("\(v.id).avi")) ?? "?")
        verificaUguali("origine: file", v.origine, .file)
        verificaUguali("nessun log: AVFoundation che non lo riproduce non è un guasto nostro", eventiDelRegistro(banco), [])
    } else {
        verifica("un .avi entra", false)
    }
}

func provaGuastiNostriVideo(_ risorse: Risorse) {
    sezione("un guasto NOSTRO scrive `media-nativo-preparazione-fallita` con motivo, tipo e errore di sistema — e mai un nome")
    let banco = Banco()
    // La cartella dei preparati sparisce a metà: lo spostamento non può riuscire.
    try? FileManager.default.removeItem(at: banco.scelti)
    let sorgente = copiaFresca(risorse.clip, nome: "SEGRETO-nome-di-un-bambino.mp4")
    let esito = banco.preparazione.preparaVideo(daFile: sorgente, nome: "SEGRETO-nome-di-un-bambino", origine: .galleria, opzioni: opzioni(), avanzamento: { _ in }, annullata: { false })
    if case .rifiutato(let r)? = esito {
        verificaUguali("spostamento fallito → rifiutato illeggibile", r.motivo, .illeggibile)
    } else {
        verifica("spostamento fallito → rifiutato illeggibile", false)
    }
    verificaUguali("la sorgente è cancellata anche così", esiste(sorgente), false)
    verificaUguali("un solo evento nel registro", banco.eventi.count, 1)
    if let evento = banco.eventi.first {
        verificaUguali("messaggio: media-nativo-preparazione-fallita: COPIA", evento.messaggio, "media-nativo-preparazione-fallita: COPIA")
        verificaUguali("livello: error", evento.livello, .error)
        verificaUguali("campo tipo: video", evento.campi["tipo"], .testo("video"))
        if case .testo(let codice)? = evento.campi["error_code"] {
            verifica("campo error_code: dominio e codice numerico (\(codice))", codice.range(of: "^[A-Za-z]+:-?[0-9]+$", options: .regularExpression) != nil)
        } else {
            verifica("campo error_code presente", false)
        }
        verificaUguali("campi: solo versione_app, tipo ed error_code", Set(evento.campi.keys), Set(["versione_app", "tipo", "error_code"]))
        let dati = (try? JSONEncoder().encode(evento)) ?? Data()
        let testo = String(data: dati, encoding: .utf8) ?? ""
        verifica("l'evento intero NON contiene il nome del file né un percorso (\(testo.count) caratteri)", !testo.contains("SEGRETO") && !testo.contains("/") && !testo.contains("mp4"))
    }

    sezione("l'annullamento: nessuna copia resta, nessun log")
    let b2 = Banco()
    let grande = copiaFresca(risorse.junkAvi, nome: "grande.avi")
    var blocchi = 0
    let annullato = b2.preparazione.preparaVideo(daFile: grande, nome: "grande", origine: .file, opzioni: opzioni(), avanzamento: { _ in blocchi += 1 }, annullata: { blocchi >= 1 })
    verificaUguali("annullata dopo il primo blocco dell'impronta → nil (niente elemento)", annullato == nil, true)
    verificaUguali("scelti/ è vuoto", nomiIn(b2.scelti), [])
    verificaUguali("la sorgente è cancellata", esiste(grande), false)
    verificaUguali("nessun log", eventiDelRegistro(b2), [])
    let b3 = Banco()
    let prima = copiaFresca(risorse.clip)
    verificaUguali("annullata prima di cominciare → nil", b3.preparazione.preparaVideo(daFile: prima, nome: "x", origine: .file, opzioni: opzioni(), avanzamento: { _ in }, annullata: { true }) == nil, true)
    verificaUguali("… senza lasciare niente", [nomiIn(b3.scelti), [esiste(prima) ? "sorgente" : "ok"]], [[], ["ok"]])
}

func provaSpostamentoNonPermesso(_ risorse: Risorse) {
    sezione("la sorgente sta in una cartella che non si può modificare: lo spostamento non è permesso e il video entra lo stesso, COPIATO")
    let banco = Banco()
    let cartellaSolaLettura = nuovaCartella()
    let sorgente = cartellaSolaLettura.appendingPathComponent("blocco.mp4")
    try? FileManager.default.copyItem(at: risorse.clip, to: sorgente)
    chmod(cartellaSolaLettura.path, 0o555)
    defer { chmod(cartellaSolaLettura.path, 0o755) }
    // Il controllo POSITIVO: qui un file non si può togliere, quindi `moveItem` non può riuscire (serve un utente senza privilegi di amministratore).
    verifica("(controllo) togliere il file da quella cartella è vietato, e leggerlo no", !FileManager.default.isDeletableFile(atPath: sorgente.path) && FileManager.default.isReadableFile(atPath: sorgente.path))
    guard case .video(let v)? = banco.preparazione.preparaVideo(daFile: sorgente, nome: "Bloccato", origine: .galleria, opzioni: opzioni(sorgente: .galleria), avanzamento: { _ in },
                                                                 annullata: { false }) else {
        verifica("il video entra anche se non si può spostare", false)
        return
    }
    verificaUguali("in scelti/ c'è la sua copia, e nient'altro", nomiIn(banco.scelti), ["\(v.id).mp4"])
    verificaUguali("il peso e lo sha256 sono quelli del file di partenza", [String(v.byte), v.sha256], [String(pesoDi(risorse.clip)), shaIndipendente(risorse.clip) ?? "?"])
    verificaUguali("durata ≈ 2 s e miniatura presente (il video è stato letto dalla copia)", [abs((v.durataSecondi ?? 0) - 2) < 0.2, v.miniatura != nil], [true, true])
    verificaUguali("la sorgente, che non si poteva togliere, c'è ancora (la toglie il sistema)", esiste(sorgente), true)
    verificaUguali("nessun log: la copia non è un guasto", eventiDelRegistro(banco), [])
    var protetto: Bool?
    protetto = (try? banco.scelti.appendingPathComponent("\(v.id).mp4").resourceValues(forKeys: [.isExcludedFromBackupKey]))?.isExcludedFromBackup
    verificaUguali("la copia è esclusa dal backup come uno spostamento", protetto, true)
    // Anche la copia rispetta lo spazio: la regola (peso + margine) si controlla PRIMA, e vale per tutte e due le strade.
    let povero = Banco(spazio: { 1000 })
    let sorgente2 = cartellaSolaLettura.appendingPathComponent("blocco2.mp4")
    chmod(cartellaSolaLettura.path, 0o755)
    try? FileManager.default.copyItem(at: risorse.clip, to: sorgente2)
    chmod(cartellaSolaLettura.path, 0o555)
    if case .rifiutato(let r)? = povero.preparazione.preparaVideo(daFile: sorgente2, nome: "Bloccato", origine: .galleria, opzioni: opzioni(), avanzamento: { _ in }, annullata: { false }) {
        verificaUguali("con poco spazio → spazio-insufficiente, anche per un file che si dovrebbe copiare", r.motivo, .spazioInsufficiente)
    } else {
        verifica("con poco spazio → rifiutato", false)
    }
    verificaUguali("… e non si è copiato niente", nomiIn(povero.scelti), [])
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
//  4. Le foto preparate
// ═══════════════════════════════════════════════════════════════════════════════════════════

func provaFotoPreparate(_ risorse: Risorse) {
    sezione("una foto preparata: scelti/<id>.jpg, e `leggiFoto` la consegna in base64 E LA CANCELLA")
    let banco = Banco()
    let sorgente = copiaFresca(risorse.heic48, nome: "IMG_9999.heic")
    guard case .foto(let f)? = banco.preparazione.preparaFoto(daFile: sorgente, nome: "IMG_9999", opzioni: opzioni(), annullata: { false }) else {
        verifica("la foto si prepara", false)
        return
    }
    verificaUguali("dimensioni 1440 × 1920", [f.larghezza, f.altezza], [1440, 1920])
    let file = banco.scelti.appendingPathComponent("\(f.id).jpg")
    verificaUguali("scelti/ contiene SOLO <id>.jpg", nomiIn(banco.scelti), ["\(f.id).jpg"])
    verificaUguali("la sorgente (la HEIC da 48 MP) è cancellata", esiste(sorgente), false)
    verificaUguali("il peso dichiarato è quello del file", f.byte, pesoDi(file))
    verificaUguali("la foto è esclusa dal backup (§9: copie solo nella cartella privata, fuori dal backup)", (try? file.resourceValues(forKeys: [.isExcludedFromBackupKey]))?.isExcludedFromBackup, true)
    verificaUguali("nome: quello del sistema", f.nome, "IMG_9999")
    verificaUguali("nessun log", eventiDelRegistro(banco), [])
    let copia = nuovaCartella().appendingPathComponent("copia.jpg")
    try? FileManager.default.copyItem(at: file, to: copia)
    verificaUguali("un video e una foto non si confondono: la foto non è nei video preparati", banco.preparazione.video(conId: f.id) == nil, true)

    switch banco.preparazione.leggiFoto(id: f.id) {
    case .letta(let base64, let byte, let larghezza, let altezza):
        verifica("base64 standard col padding, senza a capo né spazi", base64.range(of: "^[A-Za-z0-9+/]+={0,2}$", options: .regularExpression) != nil)
        let originale = (try? Data(contentsOf: copia)) ?? Data()
        verificaUguali("il base64 decodificato è il file, byte per byte", Data(base64Encoded: base64) ?? Data(), originale)
        verificaUguali("`byte` è quello del FILE, e il base64 rappresenta esattamente quei byte", byte, originale.count)
        verificaUguali("larghezza e altezza della foto ridotta", [larghezza, altezza], [1440, 1920])
        verificaUguali("(il padding di una stringa di \(base64.count) caratteri torna con \(byte) byte)", (base64.count / 4) * 3 - (base64.hasSuffix("==") ? 2 : base64.hasSuffix("=") ? 1 : 0), byte)
    default:
        verifica("leggiFoto: letta", false)
    }
    verificaUguali("`leggiFoto` ha CANCELLATO la foto (una lettura sola)", nomiIn(banco.scelti), [])
    verificaUguali("una seconda lettura → assente", banco.preparazione.leggiFoto(id: f.id), .assente)
    verificaUguali("un id con la forma sbagliata → assente (non esce dalla cartella)", banco.preparazione.leggiFoto(id: "../../etc/passwd"), .assente)
    verificaUguali("un id vuoto → assente", banco.preparazione.leggiFoto(id: ""), .assente)

    sezione("`leggiFoto` e `scarta` non toccano un video: l'id di un video non cancella mai il video")
    let b2 = Banco()
    guard case .video(let v)? = b2.preparazione.preparaVideo(daFile: copiaFresca(risorse.clip), nome: "v", origine: .file, opzioni: opzioni(), avanzamento: { _ in }, annullata: { false }),
          case .foto(let foto)? = b2.preparazione.preparaFoto(daFile: copiaFresca(risorse.heic48, nome: "f.heic"), nome: "f", opzioni: opzioni(), annullata: { false }) else {
        verifica("un video e una foto si preparano", false)
        return
    }
    verificaUguali("leggiFoto con l'id di un VIDEO → assente", b2.preparazione.leggiFoto(id: v.id), .assente)
    verificaUguali("… e il video è ancora lì", nomiIn(b2.scelti).contains("\(v.id).mp4"), true)
    verificaUguali("scarta(ids:) con un id che non esiste, uno con la forma sbagliata e uno vuoto → 0", b2.preparazione.scarta(ids: ["non-esiste", "../x", "", "a b"]), 0)
    verificaUguali("… e non ha toccato niente", nomiIn(b2.scelti).count, 2)
    verificaUguali("scarta([foto]) → 1", b2.preparazione.scarta(ids: [foto.id]), 1)
    verificaUguali("scarta([foto]) di nuovo → 0 (già tolta)", b2.preparazione.scarta(ids: [foto.id]), 0)
    verificaUguali("il video è ancora lì e la foto no", nomiIn(b2.scelti), ["\(v.id).mp4"])
    verificaUguali("scarta([video]) → 1 e il ricordo del video si toglie", [b2.preparazione.scarta(ids: [v.id]), b2.preparazione.video(conId: v.id) == nil ? 1 : 0], [1, 1])
    verificaUguali("scelti/ è vuoto", nomiIn(b2.scelti), [])

    sezione("`scarta` NON tocca file/: la copia di un video già preso in carico resta (secondario 36)")
    let b3 = Banco()
    let protetta = b3.coda.cartellaFile.appendingPathComponent("11111111-2222-3333-4444-555555555555.mp4")
    try? casuali(1000).write(to: protetta)
    verificaUguali("scarta con un id che somiglia al nome di una copia in file/ → 0", b3.preparazione.scarta(ids: ["11111111-2222-3333-4444-555555555555"]), 0)
    verificaUguali("… e la copia in file/ c'è ancora", esiste(protetta), true)
    verificaUguali("leggiFoto con quell'id → assente, copia intatta", [b3.preparazione.leggiFoto(id: "11111111-2222-3333-4444-555555555555") == .assente, esiste(protetta)], [true, true])

    sezione("le foto che non entrano: un motivo, nessun file, e il log solo per i guasti nostri")
    let b4 = Banco()
    func rifiutoFoto(_ nome: String, _ sorgente: URL, atteso: KVMotivoRifiuto, nomeSistema: String?) -> KVElementoRifiutato? {
        let esito = b4.preparazione.preparaFoto(daFile: sorgente, nome: nomeSistema, opzioni: opzioni(), annullata: { false })
        guard case .rifiutato(let r)? = esito else {
            verifica("\(nome): rifiutata", false, "esito: \(String(describing: esito))")
            return nil
        }
        verificaUguali("\(nome): motivo \(atteso.rawValue)", r.motivo, atteso)
        verificaUguali("\(nome): origine foto", r.origine, .foto)
        verificaUguali("\(nome): nessuna copia in scelti/", nomiIn(b4.scelti), [])
        verificaUguali("\(nome): la sorgente è cancellata", esiste(sorgente), false)
        return r
    }
    let cartella = nuovaCartella()
    let byteCasuali = cartella.appendingPathComponent("a.jpg")
    try? casuali(2048).write(to: byteCasuali)
    _ = rifiutoFoto("byte casuali", byteCasuali, atteso: .formatoNonSupportato, nomeSistema: "a")
    verificaUguali("… un rifiuto atteso: nessun log", eventiDelRegistro(b4), [])
    let vuota = cartella.appendingPathComponent("vuota.jpg")
    try? Data().write(to: vuota)
    _ = rifiutoFoto("file vuoto", vuota, atteso: .illeggibile, nomeSistema: "b")
    verificaUguali("… nessun log", eventiDelRegistro(b4), [])
    let intera = cartella.appendingPathComponent("intera.jpg")
    scriviImmagine(quadranti(400, 300), in: intera, tipo: .jpeg)
    let tagliata = cartella.appendingPathComponent("tagliata.jpg")
    if let dati = try? Data(contentsOf: intera) { try? dati.prefix(300).write(to: tagliata) }
    _ = rifiutoFoto("JPEG tagliato nella testa", tagliata, atteso: .illeggibile, nomeSistema: "c")
    verificaUguali("… questo SÌ è un guasto che vogliamo vedere: media-nativo-preparazione-fallita: RIDUZIONE (tipo foto)", eventiDelRegistro(b4), ["media-nativo-preparazione-fallita: RIDUZIONE"])
    if let evento = b4.eventi.first { verificaUguali("… col campo tipo = foto", evento.campi["tipo"], .testo("foto")) }

    let b6 = Banco()
    if case .rifiutato(let r)? = b6.preparazione.preparaFoto(daFile: cartella.appendingPathComponent("sparita.jpg"), nome: "s", opzioni: opzioni(), annullata: { false }) {
        verificaUguali("una foto che non si legge (la consegna non ha funzionato) → illeggibile", r.motivo, .illeggibile)
    } else {
        verifica("una foto che non si legge → rifiutata", false)
    }
    verificaUguali("… e questo SÌ è un guasto nostro: media-nativo-preparazione-fallita: COPIA, tipo foto, errore «NSCocoaErrorDomain:260»", eventiDelRegistro(b6), ["media-nativo-preparazione-fallita: COPIA"])
    verificaUguali("… campi tipo ed error_code", [b6.eventi.first?.campi["tipo"], b6.eventi.first?.campi["error_code"]], [KVValoreCampo.testo("foto"), KVValoreCampo.testo("NSCocoaErrorDomain:260")] as [KVValoreCampo?])

    sezione("i nomi per lo schermo: ripiego, taglio a 255 unità UTF-16 senza spezzare un carattere")
    let b5 = Banco()
    let senzaNome = b5.preparazione.preparaFoto(daFile: copiaFresca(risorse.heic48, nome: "x.heic"), nome: nil, opzioni: opzioni(), annullata: { false })
    if case .foto(let f)? = senzaNome { verificaUguali("foto senza nome → «Foto»", f.nome, "Foto") } else { verifica("foto senza nome", false) }
    let lungo = String(repeating: "è", count: 200) + String(repeating: "😀", count: 100)
    let conNomeLungo = b5.preparazione.preparaFoto(daFile: copiaFresca(risorse.heic48, nome: "y.heic"), nome: lungo, opzioni: opzioni(), annullata: { false })
    if case .foto(let f)? = conNomeLungo {
        verifica("nome lungo: al più 255 unità UTF-16 (\(f.nome.utf16.count))", f.nome.utf16.count <= 255 && f.nome.utf16.count >= 1)
        verifica("nome lungo: nessuna faccina spezzata a metà", f.nome.unicodeScalars.allSatisfy { $0.value != 0xFFFD })
    } else {
        verifica("foto con nome lungo", false)
    }
    for (genere, atteso) in [(KVGenereElemento.foto, "Foto"), (.video, "Video"), (.altro, "File")] {
        for grezzo in [nil, "", "   ", "\n\t "] as [String?] {
            if case .rifiutato(let r) = b5.preparazione.rifiuta(file: nil, nome: grezzo, genere: genere, motivo: .formatoNonSupportato) {
                verificaUguali("un rifiutato (\(genere.rawValue)) con nome \(grezzo.map { "«\($0.replacingOccurrences(of: "\n", with: "\\n"))»" } ?? "assente") → il ripiego «\(atteso)» (mai un nome vuoto; gli stessi di Android)", r.nome, atteso)
            }
        }
    }
    let fotoSenzaNome = b5.preparazione.preparaFoto(daFile: copiaFresca(risorse.heic48, nome: "z.heic"), nome: "   ", opzioni: opzioni(), annullata: { false })
    if case .foto(let f)? = fotoSenzaNome { verificaUguali("una foto con un nome di soli spazi → «Foto» (non «Video»)", f.nome, "Foto") } else { verifica("foto con nome di soli spazi", false) }
    let videoSenzaNome = b5.preparazione.preparaVideo(daFile: copiaFresca(risorse.clip, nome: "y.mp4"), nome: "", origine: .file, opzioni: opzioni(), avanzamento: { _ in }, annullata: { false })
    if case .video(let v)? = videoSenzaNome { verificaUguali("un video con un nome vuoto → «Video»", v.nome, "Video") } else { verifica("video con nome vuoto", false) }
    verificaUguali("un nome con gli spazi attorno si pulisce («  Gita  » → «Gita»)", KVPreparazioneMedia.nomeDaMostrare("  Gita  ", genere: .video), "Gita")
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
//  5. La sessione del selettore (senza schermo)
// ═══════════════════════════════════════════════════════════════════════════════════════════

func nuovoSelettore(_ banco: Banco) -> KVSelettoreMedia {
    return KVSelettoreMedia(coda: banco.coda, preparazione: banco.preparazione, registro: banco.registro)
}

func provaSessioneDeiFile(_ risorse: Risorse) {
    sezione("«Scegli da File»: ordine, avanzamento, rifiuti, nessuna copia temporanea che resti")
    let banco = Banco()
    let selettore = nuovoSelettore(banco)
    let testo = nuovaCartella().appendingPathComponent("appunti.txt")
    try? Data("niente di video".utf8).write(to: testo)
    let file: [URL] = [copiaFresca(risorse.clip, nome: "primo.mp4"), copiaFresca(risorse.heic48, nome: "secondo.heic"), testo, copiaFresca(risorse.clip, nome: "quarto.mp4")]
    let pesi = file.map { pesoDi($0) }
    let raccolta = Raccolta()
    let avvio = selettore.consegnaFile(file, opzioni: opzioni(durataMassima: 1), avanzamento: raccolta.avanzamento, completamento: raccolta.completamento)
    verificaUguali("avvio", avvio, .avviata)
    verificaUguali("una seconda scelta mentre la prima è in corso → giaInCorso",
                   selettore.consegnaFile([], opzioni: opzioni(), avanzamento: { _ in }, completamento: { _ in }), .giaInCorso)
    verificaUguali("… e anche una dalla galleria", selettore.consegnaOggetti([], opzioni: opzioni(), avanzamento: { _ in }, completamento: { _ in }), .giaInCorso)
    guard let esito = raccolta.attendiEsito(), case .completata(let annullato, let elementi) = esito else {
        verifica("la sessione si chiude con un esito", false, "esito: \(String(describing: raccolta.esito))")
        return
    }
    verificaUguali("non annullata", annullato, false)
    verificaUguali("quattro elementi, nell'ordine in cui sono stati scelti", elementi.count, 4)
    if elementi.count == 4 {
        // 1: un clip da 2 s con tetto 1 s → troppo lungo; 2: la HEIC → foto; 3: un .txt → formato non supportato (origine altro); 4: troppo lungo.
        if case .rifiutato(let r) = elementi[0] { verificaUguali("1° (video di 2 s, tetto 1 s) → troppo-lungo, origine video", [r.motivo.rawValue, r.origine.rawValue], ["troppo-lungo", "video"]) } else { verifica("1° rifiutato", false) }
        if case .foto(let f) = elementi[1] { verificaUguali("2° (HEIC 48 MP) → foto 1440 × 1920", [f.larghezza, f.altezza], [1440, 1920]) } else { verifica("2° è una foto", false) }
        if case .rifiutato(let r) = elementi[2] { verificaUguali("3° (un .txt) → formato-non-supportato, origine altro", [r.motivo.rawValue, r.origine.rawValue], ["formato-non-supportato", "altro"]) } else { verifica("3° rifiutato", false) }
        if case .rifiutato(let r) = elementi[3] { verificaUguali("4° → troppo-lungo", r.motivo.rawValue, "troppo-lungo") } else { verifica("4° rifiutato", false) }
        verificaUguali("i quattro id sono tutti diversi", Set(elementi.map { $0.id }).count, 4)
    }
    let avanzamenti = raccolta.avanzamenti
    verifica("c'è un avanzamento di partenza (0 di 4)", avanzamenti.first.map { $0.fatti == 0 && $0.totali == 4 } ?? false)
    verificaUguali("e uno finale (4 di 4)", avanzamenti.last.map { [$0.fatti, $0.totali] }, [4, 4])
    verifica("i file fatti non scendono mai", zip(avanzamenti, avanzamenti.dropFirst()).allSatisfy { $0.fatti <= $1.fatti })
    verifica("i byte lavorati non scendono mai", zip(avanzamenti, avanzamenti.dropFirst()).allSatisfy { $0.byteCopiati <= $1.byteCopiati })
    verificaUguali("il totale dei byte è noto (sono file) e vale la somma dei pesi", avanzamenti.first?.byteTotali, pesi.reduce(0, +))
    verificaUguali("alla fine i byte lavorati sono tutti quelli del totale", avanzamenti.last?.byteCopiati, pesi.reduce(0, +))
    verificaUguali("le copie temporanee sono state tutte consumate (spostate o cancellate)", file.map { esiste($0) }, [false, false, false, false])
    verificaUguali("scelti/ contiene SOLO la foto", nomiIn(banco.scelti).count, 1)
    verificaUguali("nessun log (rifiuti attesi, nessun guasto)", eventiDelRegistro(banco), [])

    sezione("una scelta annullata a metà: «annullato», nessun elemento, e NIENTE resta sul telefono")
    let b2 = Banco()
    let s2 = nuovoSelettore(b2)
    let file2: [URL] = [copiaFresca(risorse.clip, nome: "a.mp4"), copiaFresca(risorse.heic48, nome: "b.heic"), copiaFresca(risorse.clip, nome: "c.mp4"), copiaFresca(risorse.clip, nome: "d.mp4")]
    let r2 = Raccolta()
    var annullamenti: [Bool] = []
    var scelteAlCompletamento: [String]?
    var vistoNelPrimoElemento = false
    _ = s2.consegnaFile(file2, opzioni: opzioni(), avanzamento: { a in
        r2.avanzamento(a)
        // Appena il PRIMO elemento è pronto (fatti = 1) si annulla.
        if a.fatti == 1 && annullamenti.isEmpty {
            vistoNelPrimoElemento = nomiIn(b2.scelti).count == 1   // (controllo) il primo elemento è davvero lì quando si annulla
            annullamenti.append(s2.annulla())
        }
    }, completamento: { esito in
        // Si guarda scelti/ nell'ISTANTE in cui arriva «annullato»: la risposta non deve precedere la pulizia (altrimenti chi ha ricevuto «annullato» e
        // riapre il selettore ritroverebbe in giro le copie della scelta di prima).
        scelteAlCompletamento = nomiIn(b2.scelti)
        r2.completamento(esito)
    })
    if case .completata(let annullato, let elementi)? = r2.attendiEsito() {
        verificaUguali("annullato = true", annullato, true)
        verificaUguali("un annullamento non porta MAI elementi (le copie parziali si sono cancellate)", elementi.count, 0)
    } else {
        verifica("la sessione annullata si chiude", false)
    }
    verificaUguali("annulla() ha trovato una sessione da annullare", annullamenti, [true])
    verificaUguali("(controllo) quando si è annullato il primo elemento era già pronto in scelti/", vistoNelPrimoElemento, true)
    verificaUguali("nell'istante in cui arriva «annullato» scelti/ è GIÀ vuoto (gli elementi pronti si tolgono PRIMA di rispondere)", scelteAlCompletamento, [])
    verificaUguali("annulla() subito dopo → false (niente da annullare)", s2.annulla(), false)
    _ = attendi("scelti/ si svuota e le copie temporanee spariscono") { nomiIn(b2.scelti).isEmpty && file2.allSatisfy { !esiste($0) } }
    verificaUguali("scelti/ è vuoto (anche il primo elemento, già pronto, è stato tolto)", nomiIn(b2.scelti), [])
    verificaUguali("le quattro copie temporanee non ci sono più (anche quelle mai cominciate)", file2.map { esiste($0) }, [false, false, false, false])
    verificaUguali("nessun log (annullare non è un errore)", eventiDelRegistro(b2), [])
    // Dopo un annullamento si può scegliere di nuovo.
    let r3 = Raccolta()
    verificaUguali("dopo l'annullamento si può aprire una nuova scelta", s2.consegnaFile([copiaFresca(risorse.heic48, nome: "n.heic")], opzioni: opzioni(), avanzamento: r3.avanzamento,
                                                                                        completamento: r3.completamento), .avviata)
    if case .completata(let annullato, let elementi)? = r3.attendiEsito() { verificaUguali("… e completa: 1 foto, non annullata", "\(annullato) \(elementi.count)", "false 1") } else { verifica("la nuova scelta completa", false) }

    sezione("una scelta senza elementi vale «annullato» (selettore chiuso senza scegliere)")
    let b3 = Banco()
    let r4 = Raccolta()
    _ = nuovoSelettore(b3).consegnaFile([], opzioni: opzioni(), avanzamento: r4.avanzamento, completamento: r4.completamento)
    if case .completata(let annullato, let elementi)? = r4.attendiEsito() { verificaUguali("file: nessun file → annullato, nessun elemento", "\(annullato) \(elementi.count)", "true 0") } else { verifica("file: si chiude", false) }
    let r5 = Raccolta()
    _ = nuovoSelettore(b3).consegnaOggetti([], opzioni: opzioni(), avanzamento: r5.avanzamento, completamento: r5.completamento)
    if case .completata(let annullato, let elementi)? = r5.attendiEsito() { verificaUguali("galleria: nessun oggetto → annullato, nessun elemento", "\(annullato) \(elementi.count)", "true 0") } else { verifica("galleria: si chiude", false) }
}

func provaSessioneDellaGalleria(_ risorse: Risorse) {
    sezione("la galleria (PHPicker): gli oggetti di sistema diventano elementi, lavorando DENTRO il completamento di `loadFileRepresentation`")
    let banco = Banco()
    let selettore = nuovoSelettore(banco)
    func oggetto(_ origine: URL, nome: String?) -> NSItemProvider {
        let provider = NSItemProvider(contentsOf: copiaFresca(origine))!
        provider.suggestedName = nome
        return provider
    }
    let sconosciuto = NSItemProvider()
    sconosciuto.suggestedName = "Contatto"
    sconosciuto.registerDataRepresentation(forTypeIdentifier: UTType.vCard.identifier, visibility: .all) { completamento in
        completamento(Data("BEGIN:VCARD\nEND:VCARD".utf8), nil)
        return nil
    }
    let provider: [NSItemProvider] = [oggetto(risorse.clip, nome: "IMG_0100"), oggetto(risorse.heic48, nome: "IMG_0101"), sconosciuto, oggetto(risorse.clipTroncato, nome: "IMG_0102")]
    let raccolta = Raccolta()
    verificaUguali("avvio", selettore.consegnaOggetti(provider, opzioni: opzioni(sorgente: .galleria), avanzamento: raccolta.avanzamento, completamento: raccolta.completamento), .avviata)
    guard let esito = raccolta.attendiEsito(), case .completata(let annullato, let elementi) = esito else {
        verifica("la sessione si chiude con un esito", false)
        return
    }
    verificaUguali("non annullata, quattro elementi", [annullato, elementi.count == 4], [false, true])
    if elementi.count == 4 {
        if case .video(let v) = elementi[0] {
            verificaUguali("1° è un video: nome del sistema, origine galleria, durata ≈ 2 s", [v.nome, v.origine.rawValue, abs((v.durataSecondi ?? 0) - 2) < 0.2 ? "2s" : "?"], ["IMG_0100", "galleria", "2s"])
            verificaUguali("1°: sha256 uguale a quello indipendente", v.sha256, shaIndipendente(banco.scelti.appendingPathComponent("\(v.id).\(v.estensione)")) ?? "?")
            verificaUguali("1°: lo tiene la preparazione (accodaVideo lo ritroverà)", banco.preparazione.video(conId: v.id) == v, true)
        } else { verifica("1° è un video", false) }
        if case .foto(let f) = elementi[1] { verificaUguali("2° è una foto 1440 × 1920 col suo nome", [f.larghezza, f.altezza, f.nome == "IMG_0101" ? 1 : 0], [1440, 1920, 1]) } else { verifica("2° è una foto", false) }
        if case .rifiutato(let r) = elementi[2] { verificaUguali("3° (un contatto) → formato-non-supportato, origine altro, col suo nome", [r.motivo.rawValue, r.origine.rawValue, r.nome], ["formato-non-supportato", "altro", "Contatto"]) } else { verifica("3° rifiutato", false) }
        if case .rifiutato(let r) = elementi[3] { verificaUguali("4° (video troncato) → illeggibile, origine video", [r.motivo.rawValue, r.origine.rawValue], ["illeggibile", "video"]) } else { verifica("4° rifiutato", false) }
    }
    verificaUguali("galleria: totale dei byte sconosciuto (nil), come dice la spec", raccolta.avanzamenti.first?.byteTotali == nil, true)
    verificaUguali("ultimo avanzamento: 4 di 4", raccolta.avanzamenti.last.map { [$0.fatti, $0.totali] }, [4, 4])
    verifica("i byte lavorati non scendono mai e finiscono sopra zero", zip(raccolta.avanzamenti, raccolta.avanzamenti.dropFirst()).allSatisfy { $0.byteCopiati <= $1.byteCopiati }
             && (raccolta.avanzamenti.last?.byteCopiati ?? 0) > 0)
    verificaUguali("scelti/ contiene il video e la foto, nient'altro", nomiIn(banco.scelti).count, 2)
    verificaUguali("nessun log", eventiDelRegistro(banco), [])

    sezione("la galleria: un errore del sistema diventa un motivo (iCloud assente, poco spazio), e il resto un guasto che si scrive")
    for (nome, errore, motivo, logs) in [("rete assente", NSError(domain: NSURLErrorDomain, code: -1009), KVMotivoRifiuto.icloudNonDisponibile, 0),
                                         ("scrittura senza spazio", NSError(domain: NSCocoaErrorDomain, code: 640), .spazioInsufficiente, 0),
                                         ("errore sconosciuto", NSError(domain: "DominioDiProva", code: 7), .illeggibile, 1)] {
        let b = Banco()
        let s = nuovoSelettore(b)
        let p = NSItemProvider()
        p.suggestedName = "Da iCloud"
        p.registerFileRepresentation(forTypeIdentifier: UTType.movie.identifier, fileOptions: [], visibility: .all) { completamento in
            completamento(nil, false, errore)
            return nil
        }
        let r = Raccolta()
        _ = s.consegnaOggetti([p], opzioni: opzioni(sorgente: .galleria), avanzamento: r.avanzamento, completamento: r.completamento)
        if case .completata(_, let elementi)? = r.attendiEsito(), case .rifiutato(let rif)? = elementi.first {
            verificaUguali("\(nome): motivo \(motivo.rawValue), origine video, nome per lo schermo", [rif.motivo.rawValue, rif.origine.rawValue, rif.nome], [motivo.rawValue, "video", "Da iCloud"])
        } else {
            verifica("\(nome): rifiutato", false)
        }
        verificaUguali("\(nome): \(logs == 0 ? "nessun log" : "un log di guasto nostro")", eventiDelRegistro(b).count, logs)
        if logs == 1, let evento = b.eventi.first {
            verificaUguali("\(nome): messaggio media-nativo-preparazione-fallita: COPIA", evento.messaggio, "media-nativo-preparazione-fallita: COPIA")
            verificaUguali("\(nome): campo tipo = video", evento.campi["tipo"], KVValoreCampo.testo("video"))
            verificaUguali("\(nome): campo error_code = «altro:7» (dominio fuori elenco, codice numerico)", evento.campi["error_code"], KVValoreCampo.testo("altro:7"))
        }
    }
}

/// Un contatore che un thread incrementa e un altro legge.
final class Contatore {
    private let serratura = NSLock()
    private var interno = 0
    var valore: Int { serratura.lock(); defer { serratura.unlock() }; return interno }
    func incrementa() { serratura.lock(); interno += 1; serratura.unlock() }
}

func provaSelettoreLento(_ risorse: Risorse) {
    sezione("un selettore di sistema muto: «Annulla» risolve SUBITO, e la coda di sfondo non resta appesa per le scelte che verranno")
    let banco = Banco()
    let selettore = nuovoSelettore(banco)
    let richieste = Contatore()
    let muto = NSItemProvider()
    muto.suggestedName = "Muto"
    muto.registerFileRepresentation(forTypeIdentifier: UTType.movie.identifier, fileOptions: [], visibility: .all) { _ in
        richieste.incrementa()
        return nil   // non chiama mai il completamento: un selettore che si è piantato
    }
    let r = Raccolta()
    verificaUguali("avvio", selettore.consegnaOggetti([muto], opzioni: opzioni(sorgente: .galleria), avanzamento: r.avanzamento, completamento: r.completamento), .avviata)
    _ = attendi("il sistema ha ricevuto la richiesta del file") { richieste.valore >= 1 }
    verificaUguali("mentre il selettore è muto non c'è nessun esito", r.esito == nil, true)
    let inizio = Date()
    verificaUguali("annulla() trova la sessione in preparazione", selettore.annulla(), true)
    if case .completata(let annullato, let elementi)? = r.attendiEsito(secondi: 2) {
        verificaUguali("annullato, nessun elemento", "\(annullato) \(elementi.count)", "true 0")
    } else {
        verifica("la scelta annullata si risolve senza aspettare il sistema", false)
    }
    verifica("… e la risposta arriva SUBITO (\(String(format: "%.2f", Date().timeIntervalSince(inizio))) s), non dopo l'attesa del sistema", Date().timeIntervalSince(inizio) < 1.5)
    // La scelta successiva si prepara comunque: la coda di sfondo si libera da sola dopo l'attesa massima.
    let r2 = Raccolta()
    let avvioSuccessiva = Date()
    verificaUguali("dopo l'annullamento si può aprire una nuova scelta", selettore.consegnaFile([copiaFresca(risorse.heic48, nome: "dopo-il-muto.heic")], opzioni: opzioni(),
                                                                                           avanzamento: r2.avanzamento, completamento: r2.completamento), .avviata)
    if case .completata(let annullato, let elementi)? = r2.attendiEsito(secondi: 30), elementi.count == 1, case .foto = elementi[0] {
        verificaUguali("la nuova scelta si completa: una foto, non annullata", annullato, false)
    } else {
        verifica("la nuova scelta si completa (la coda di sfondo non è appesa)", false)
    }
    verifica("… entro \(String(format: "%.1f", Date().timeIntervalSince(avvioSuccessiva))) s: l'attesa dopo l'annullamento è al più \(Int(KVSelettoreMedia.attesaDopoAnnullamentoSecondi)) s",
             Date().timeIntervalSince(avvioSuccessiva) < KVSelettoreMedia.attesaDopoAnnullamentoSecondi + 10)
    verificaUguali("scelti/ contiene SOLO la foto della scelta nuova", nomiIn(banco.scelti).count, 1)
    verificaUguali("nessun log", eventiDelRegistro(banco), [])

    sezione("un sistema che non risponde NEMMENO all'annullamento: dopo l'attesa massima la coda di sfondo si libera da sola")
    let b0 = Banco()
    let richiesteMute = Contatore()
    let s0 = KVSelettoreMedia(coda: b0.coda, preparazione: b0.preparazione, registro: b0.registro, caricaFile: { _, _, _ in
        richiesteMute.incrementa()
        return Progress()   // un Progress che l'annullamento non ferma, e un completamento che non arriverà mai
    })
    let rMuto = Raccolta()
    let fantasma = NSItemProvider(contentsOf: copiaFresca(risorse.clip))!
    _ = s0.consegnaOggetti([fantasma], opzioni: opzioni(sorgente: .galleria), avanzamento: rMuto.avanzamento, completamento: rMuto.completamento)
    _ = attendi("la richiesta è partita") { richiesteMute.valore >= 1 }
    verificaUguali("annulla() trova la sessione", s0.annulla(), true)
    if case .completata(let annullato, let elementi)? = rMuto.attendiEsito(secondi: 2) { verificaUguali("risolta subito: annullato, nessun elemento", "\(annullato) \(elementi.count)", "true 0") } else { verifica("risolta subito", false) }
    let rDopo = Raccolta()
    let inizioDopo = Date()
    _ = s0.consegnaFile([copiaFresca(risorse.heic48, nome: "dopo-il-fantasma.heic")], opzioni: opzioni(), avanzamento: rDopo.avanzamento, completamento: rDopo.completamento)
    if case .completata(let annullato, let elementi)? = rDopo.attendiEsito(secondi: 30), elementi.count == 1 {
        verificaUguali("la scelta successiva si completa, una foto, non annullata", annullato, false)
    } else {
        verifica("la scelta successiva si completa (la coda di sfondo si è liberata)", false)
    }
    let attesa = Date().timeIntervalSince(inizioDopo)
    verifica("… dopo l'attesa massima (\(String(format: "%.1f", attesa)) s, fra \(Int(KVSelettoreMedia.attesaDopoAnnullamentoSecondi)) e \(Int(KVSelettoreMedia.attesaDopoAnnullamentoSecondi) + 10) s): né subito né mai",
             attesa >= KVSelettoreMedia.attesaDopoAnnullamentoSecondi - 0.5 && attesa < KVSelettoreMedia.attesaDopoAnnullamentoSecondi + 10)

    sezione("un selettore lento: se il file arriva DOPO l'annullamento non finisce in scelti/ e non si perde niente")
    let b2 = Banco()
    let s2 = nuovoSelettore(b2)
    let sorgenteLenta = copiaFresca(risorse.clip, nome: "lento.mp4")
    let chiamate = Contatore()
    let lento = NSItemProvider()
    lento.suggestedName = "Lento"
    lento.registerFileRepresentation(forTypeIdentifier: UTType.movie.identifier, fileOptions: [], visibility: .all) { completamento in
        chiamate.incrementa()
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.8) { completamento(sorgenteLenta, false, nil) }
        return nil
    }
    let r3 = Raccolta()
    _ = s2.consegnaOggetti([lento], opzioni: opzioni(sorgente: .galleria), avanzamento: r3.avanzamento, completamento: r3.completamento)
    _ = attendi("il sistema ha ricevuto la richiesta del file lento") { chiamate.valore >= 1 }
    verificaUguali("annulla() mentre il file sta arrivando", s2.annulla(), true)
    if case .completata(let annullato, let elementi)? = r3.attendiEsito(secondi: 2) { verificaUguali("annullato, nessun elemento", "\(annullato) \(elementi.count)", "true 0") } else { verifica("si risolve subito", false) }
    Thread.sleep(forTimeInterval: 2.5)   // il file lento arriva a 0,8 s: qui si aspetta DOPO il suo arrivo, e si guarda che non sia entrato da nessuna parte
    verificaUguali("scelti/ è vuoto anche dopo l'arrivo tardivo del file", nomiIn(b2.scelti), [])
    verificaUguali("nessun avanzamento oltre «0 di 1» dopo l'annullamento", r3.avanzamenti.allSatisfy { $0.fatti == 0 }, true)
    verificaUguali("nessun log", eventiDelRegistro(b2), [])
    let r4 = Raccolta()
    verificaUguali("e si può scegliere di nuovo", s2.consegnaFile([], opzioni: opzioni(), avanzamento: r4.avanzamento, completamento: r4.completamento), .avviata)
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
//  6. L'elemento di prova (solo Debug)
// ═══════════════════════════════════════════════════════════════════════════════════════════

func provaElementoDiProva() {
    #if DEBUG
    sezione("`creaElementoDiProva` (solo Debug): byte casuali del peso chiesto, già preparati, col loro sha256")
    let banco = Banco()
    let byte: Int64 = 3 * 1024 * 1024 + 17
    guard case .video(let v) = banco.preparazione.creaProva(byte: byte) else {
        verifica("l'elemento di prova si crea", false)
        return
    }
    let file = banco.scelti.appendingPathComponent("\(v.id).mp4")
    verificaUguali("il file sta in scelti/<id>.mp4", nomiIn(banco.scelti), ["\(v.id).mp4"])
    verificaUguali("il peso è quello chiesto", [v.byte, pesoDi(file)], [byte, byte])
    verificaUguali("sha256: quello indipendente, sui byte che partiranno", v.sha256, shaIndipendente(file) ?? "?")
    verifica("il nome ha la forma riconoscibile collaudo-<8 cifre>.mp4", v.nome.range(of: "^collaudo-[0-9a-f]{8}\\.mp4$", options: .regularExpression) != nil)
    verificaUguali("origine: prova, mime video/mp4, durata e miniatura nil", [v.origine.rawValue, v.mime, v.durataSecondi == nil ? "nil" : "?", v.miniatura == nil ? "nil" : "?"], ["prova", "video/mp4", "nil", "nil"])
    verifica("i byte sono casuali (due elementi di prova hanno sha256 diversi)", { if case .video(let w) = banco.preparazione.creaProva(byte: byte) { return w.sha256 != v.sha256 }; return false }())
    verificaUguali("lo trova `video(conId:)`", banco.preparazione.video(conId: v.id) == v, true)
    verificaUguali("nessun log", eventiDelRegistro(banco), [])

    let povero = Banco(spazio: { byte + 209_715_200 - 1 })
    if case .rifiutato(let r) = povero.preparazione.creaProva(byte: byte) {
        verificaUguali("poco spazio (al byte) → rifiutato spazio-insufficiente, origine video, il nome di prova", [r.motivo.rawValue, r.origine.rawValue, r.nome.hasPrefix("collaudo-") ? "collaudo" : "?"],
                       ["spazio-insufficiente", "video", "collaudo"])
    } else {
        verifica("poco spazio → rifiutato", false)
    }
    verificaUguali("… senza aver scritto un solo byte", nomiIn(povero.scelti), [])
    if case .rifiutato = Banco().preparazione.creaProva(byte: 0) { verifica("peso zero → rifiutato", true) } else { verifica("peso zero → rifiutato", false) }
    #else
    sezione("`creaElementoDiProva` NON esiste in Release")
    verifica("(il simbolo è sotto `#if DEBUG`: lo prova il controllo dei sorgenti più sotto)", true)
    #endif
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
//  7. I sorgenti: facciata, registrazione, privacy, versione
// ═══════════════════════════════════════════════════════════════════════════════════════════

/// Il codice SENZA commenti (di riga e di blocco): i commenti spiegano proprio ciò che non si fa e lo nominano. Il contenuto delle stringhe resta
/// (un `//` dentro una stringa non è un commento).
func senzaCommenti(_ sorgente: String) -> String {
    var uscita = ""
    var dentroStringa = false
    var dentroBlocco = false
    let caratteri = Array(sorgente)
    var i = 0
    while i < caratteri.count {
        let c = caratteri[i]
        let prossimo: Character? = i + 1 < caratteri.count ? caratteri[i + 1] : nil
        if dentroBlocco {
            if c == "*" && prossimo == "/" { dentroBlocco = false; i += 2; continue }
            i += 1
            continue
        }
        if dentroStringa {
            uscita.append(c)
            if c == "\\", let successivo = prossimo {
                uscita.append(successivo)
                i += 2
                continue
            }
            if c == "\"" { dentroStringa = false }
            i += 1
            continue
        }
        if c == "/" && prossimo == "/" {
            while i < caratteri.count && caratteri[i] != "\n" { i += 1 }
            continue
        }
        if c == "/" && prossimo == "*" { dentroBlocco = true; i += 2; continue }
        if c == "\"" { dentroStringa = true }
        uscita.append(c)
        i += 1
    }
    return uscita
}

/// Le righe di `sorgente` DENTRO i blocchi `#if DEBUG … #endif` e quelle fuori (la direttiva stessa non è in nessuna delle due).
func regioniDebug(_ sorgente: String) -> (dentro: String, fuori: String) {
    var dentro: [String] = []
    var fuori: [String] = []
    var profondita = 0
    for riga in sorgente.split(separator: "\n", omittingEmptySubsequences: false) {
        let pulita = riga.trimmingCharacters(in: .whitespaces)
        if pulita == "#if DEBUG" { profondita += 1; continue }
        if pulita.hasPrefix("#endif") && profondita > 0 { profondita -= 1; continue }
        if profondita > 0 { dentro.append(String(riga)) } else { fuori.append(String(riga)) }
    }
    return (dentro.joined(separator: "\n"), fuori.joined(separator: "\n"))
}

/// Il testo delle chiamate `prefisso(...)` di `codice`, con le parentesi in pari.
func chiamate(_ prefisso: String, in codice: String) -> [String] {
    var trovate: [String] = []
    var ricerca = codice.startIndex..<codice.endIndex
    while let inizio = codice.range(of: prefisso, range: ricerca) {
        var profondita = 0
        var fine = inizio.upperBound
        var i = inizio.upperBound
        var aperta = false
        while i < codice.endIndex {
            let c = codice[i]
            if c == "(" { profondita += 1; aperta = true }
            if c == ")" { profondita -= 1; if aperta && profondita == 0 { fine = codice.index(after: i); break } }
            i = codice.index(after: i)
        }
        if !aperta { break }
        trovate.append(String(codice[inizio.lowerBound..<fine]))
        ricerca = fine..<codice.endIndex
    }
    return trovate
}

func provaSorgenti(_ cartellaProduzione: String, _ tipiTS: String) {
    sezione("i sorgenti di I3: la facciata ha i nove metodi di METODI_PLUGIN_CARICAMENTI, `creaElementoDiProva` solo sotto #if DEBUG")
    let nomi = ["KVSelettoreMedia.swift", "KVElaborazioneFoto.swift", "KVCaricamentiPlugin.swift"]
    var testo: [String: String] = [:]
    for nome in nomi {
        guard let contenuto = leggiTesto(cartellaProduzione + "/" + nome) else {
            verifica("\(nome) leggibile", false)
            return
        }
        testo[nome] = contenuto
    }
    let plugin = testo["KVCaricamentiPlugin.swift"]!
    let codicePlugin = senzaCommenti(plugin)
    let regioniPlugin = regioniDebug(codicePlugin)
    func nomiDeiMetodi(_ codice: String) -> [String] {
        let espressione = try! NSRegularExpression(pattern: "CAPPluginMethod\\(name:\\s*\"([A-Za-z]+)\"")
        return espressione.matches(in: codice, range: NSRange(codice.startIndex..., in: codice)).compactMap {
            Range($0.range(at: 1), in: codice).map { String(codice[$0]) }
        }
    }
    let metodiTS = elencoDa(tipiTS, dichiarazione: "export const METODI_PLUGIN_CARICAMENTI = [") ?? []
    verificaUguali("(controllo) METODI_PLUGIN_CARICAMENTI ne ha nove", metodiTS.count, 9)
    verificaUguali("`pluginMethods` (fuori da #if DEBUG) = METODI_PLUGIN_CARICAMENTI, nello stesso ordine", nomiDeiMetodi(regioniPlugin.fuori), metodiTS)
    verificaUguali("sotto `#if DEBUG` c'è SOLO `creaElementoDiProva`", nomiDeiMetodi(regioniPlugin.dentro), ["creaElementoDiProva"])
    verifica("`creaElementoDiProva` non compare MAI fuori da #if DEBUG", !regioniPlugin.fuori.contains("creaElementoDiProva"))
    verifica("… e nemmeno il suo peso massimo di prova", !regioniPlugin.fuori.contains("byteMassimiDiProva"))
    verifica("`creaElementoDiProva` non è in METODI_PLUGIN_CARICAMENTI", !metodiTS.contains("creaElementoDiProva"))
    // Ogni metodo elencato ha la sua funzione @objc con la firma di un metodo di Capacitor.
    for metodo in metodiTS + ["creaElementoDiProva"] {
        verifica("c'è `@objc func \(metodo)(_ call: CAPPluginCall)`", codicePlugin.contains("@objc func \(metodo)(_ call: CAPPluginCall)"))
    }
    verifica("jsName = \"KidvilleCaricamenti\" = NOME_PLUGIN_CARICAMENTI", plugin.contains("public let jsName = \"KidvilleCaricamenti\"")
             && tipiTS.contains("export const NOME_PLUGIN_CARICAMENTI = 'KidvilleCaricamenti'"))
    verificaUguali("il protocollo del plugin è PROTOCOLLO_CARICAMENTI", numeroDa(plugin, dichiarazione: "static let protocollo = "), numeroDa(tipiTS, dichiarazione: "export const PROTOCOLLO_CARICAMENTI = "))
    verificaUguali("(e vale 1)", numeroDa(plugin, dichiarazione: "static let protocollo = "), 1)
    verifica("`info()` dice piattaforma ios e il motore del singolo (urlsession)", codicePlugin.contains("\"piattaforma\": \"ios\"") && codicePlugin.contains("KVMotoreCaricamenti.motore.rawValue"))
    let codiciRifiutoTS = elencoDa(tipiTS, dichiarazione: "export const CODICI_RIFIUTO_PONTE = [") ?? []
    let espressioneCodici = try! NSRegularExpression(pattern: "case [a-zA-Z]+ = \"([A-Z_]+)\"")
    let codiciSwift = espressioneCodici.matches(in: codicePlugin, range: NSRange(codicePlugin.startIndex..., in: codicePlugin)).compactMap {
        Range($0.range(at: 1), in: codicePlugin).map { String(codicePlugin[$0]) }
    }
    verificaUguali("i codici di rifiuto della facciata sono ESATTAMENTE CODICI_RIFIUTO_PONTE", codiciSwift, codiciRifiutoTS)
    verifica("ogni rifiuto passa da `rifiuta(_:_:)` con messaggio costante (nessun `call.reject(` con testo libero)",
             chiamate("call.reject(", in: codicePlugin).count == 1 && codicePlugin.contains("call.reject(motivo.messaggio, motivo.rawValue)"))
    verifica("la facciata non ha mai un `try!`, un `fatalError`, un `precondition`, un `print(`", !codicePlugin.contains("try!") && !codicePlugin.contains("fatalError")
             && !codicePlugin.contains("precondition") && !codicePlugin.contains("print("))
    verifica("gli eventi escono dal thread principale (`DispatchQueue.main.async` + `notifyListeners`)", codicePlugin.contains("DispatchQueue.main.async { self.notifyListeners(nome, data: dati) }"))
    verifica("i due eventi sono quelli di EVENTI_PLUGIN_CARICAMENTI (`preparazione` e `caricamento`)",
             (elencoDa(tipiTS, dichiarazione: "export const EVENTI_PLUGIN_CARICAMENTI = [") ?? []) == ["preparazione", "caricamento"]
             && codicePlugin.contains("notifica(\"preparazione\"") && codicePlugin.contains("notifica(\"caricamento\""))
    verifica("accodaVideo e il resto del ponte leggono i parametri da `KVPonteCaricamenti` (provato con dizionari veri qui sopra), non a mano nella classe",
             codicePlugin.contains("KVPonteCaricamenti.leggiAccodamento(parametri(call))") && codicePlugin.contains("KVPonteCaricamenti.decidiAccodamento(")
             && codicePlugin.contains("KVPonteCaricamenti.leggiOpzioniDiScelta(parametri(call))"))
    verifica("la classe di Capacitor sta TUTTA dentro `#if canImport(Capacitor)`, e il ponte senza Capacitor sta fuori (l'harness lo compila)",
             { guard let aperta = plugin.range(of: "#if canImport(Capacitor)\n\n@objc(KVCaricamentiPlugin)"), let ponte = plugin.range(of: "enum KVPonteCaricamenti {") else { return false }
               return ponte.lowerBound < aperta.lowerBound && plugin.hasSuffix("#endif\n") }())
    verifica("i parametri numerici non accettano un booleano (CFBooleanGetTypeID)", codicePlugin.contains("CFGetTypeID(numero) != CFBooleanGetTypeID()"))

    sezione("la registrazione: una riga in capacitorDidLoad, DOPO super e PRIMA di ogni guard; il lock della navigazione resta in piedi")
    if let controller = leggiTesto(cartellaProduzione + "/KVBridgeViewController.swift") {
        let codice = senzaCommenti(controller)
        guard let inizio = codice.range(of: "override func capacitorDidLoad()") else { verifica("capacitorDidLoad c'è", false); return }
        let corpo = String(codice[inizio.upperBound...])
        let posSuper = corpo.range(of: "super.capacitorDidLoad()")?.lowerBound
        let posRegistrazione = corpo.range(of: "bridge?.registerPluginInstance(KVCaricamentiPlugin())")?.lowerBound
        let posGuard = corpo.range(of: "guard ")?.lowerBound
        verifica("la riga `bridge?.registerPluginInstance(KVCaricamentiPlugin())` c'è", posRegistrazione != nil)
        verifica("… dopo `super.capacitorDidLoad()`", posSuper != nil && posRegistrazione != nil && posSuper! < posRegistrazione!)
        verifica("… e PRIMA del primo `guard` (il filtro delle navigazioni non spegne il plugin)", posGuard != nil && posRegistrazione != nil && posRegistrazione! < posGuard!)
        verificaUguali("una sola registrazione", controller.components(separatedBy: "registerPluginInstance(").count - 1, 1)
        verifica("il controller NON nomina `absoluteString`, `webView.url`, `navigationAction.request.url` (nemmeno nei commenti: lo vuole il lock della navigazione)",
                 !controller.contains("absoluteString") && !controller.contains("webView.url") && !controller.contains("navigationAction.request.url"))
        verifica("il filtro resta costruito e trattenuto (`KVDelegatoNavigazioneFiltrante(`, `delegatoFiltrante = filtro`)", controller.contains("KVDelegatoNavigazioneFiltrante(interno: originale, registro: registro)")
                 && controller.contains("delegatoFiltrante = filtro"))
    } else {
        verifica("KVBridgeViewController.swift leggibile", false)
    }

    sezione("privacy: nessun permesso, nessuna libreria, nessun metadato copiato, nessun nome nei log")
    let selettore = testo["KVSelettoreMedia.swift"]!
    let codiceSelettore = senzaCommenti(selettore)
    let codiceFoto = senzaCommenti(testo["KVElaborazioneFoto.swift"]!)
    for (nome, codice) in [("KVSelettoreMedia.swift", codiceSelettore), ("KVElaborazioneFoto.swift", codiceFoto), ("KVCaricamentiPlugin.swift", codicePlugin)] {
        for vietata in ["PHPhotoLibrary", "PHAsset", "assetIdentifier", "requestAuthorization", "NSPhotoLibrary", "AVCaptureDevice", "CLLocationManager"] {
            verifica("\(nome): nessun «\(vietata)» (nessun permesso: PHPicker e UIDocumentPicker girano fuori dal processo)", !codice.contains(vietata))
        }
        for vietata in ["print(", "NSLog(", "debugPrint(", "dump(", "try!", "fatalError", "precondition", "console."] {
            verifica("\(nome): nessun «\(vietata)»", !codice.contains(vietata))
        }
    }
    // L'elemento di prova (byte casuali) esiste solo in Debug: né la funzione, né il suo blocco, né il generatore di numeri casuali fuori da `#if DEBUG`.
    let regioniSelettore = regioniDebug(codiceSelettore)
    verifica("(controllo) sotto `#if DEBUG` c'è `creaProva`", regioniSelettore.dentro.contains("func creaProva(byte: Int64)"))
    for nome in ["creaProva", "bloccoProvaByte", "arc4random_buf", "collaudo-", "KV_SPAZIO_LIBERO_FORZATO_BYTE"] {
        verifica("«\(nome)» non compare MAI fuori da #if DEBUG in KVSelettoreMedia.swift (in Release non esiste)", !regioniSelettore.fuori.contains(nome))
    }
    verifica("il selettore di galleria è `PHPickerConfiguration()` SENZA libreria", codiceSelettore.contains("PHPickerConfiguration()") && !codiceSelettore.contains("photoLibrary"))
    verifica("filtro: immagini e video; selezione ordinata; rappresentazione `.current`", codiceSelettore.contains("filter = .any(of: [.images, .videos])")
             && codiceSelettore.contains("selection = .ordered") && codiceSelettore.contains("preferredAssetRepresentationMode = .current"))
    verifica("il limite di selezione è quello del JavaScript (`selectionLimit = s.opzioni.massimoElementi`)", codiceSelettore.contains("selectionLimit = s.opzioni.massimoElementi"))
    verifica("«Scegli da File»: film e immagini, `asCopy: true`, selezione multipla", codiceSelettore.contains("forOpeningContentTypes: [.movie, .image], asCopy: true")
             && codiceSelettore.contains("allowsMultipleSelection = true"))
    verifica("il video si SPOSTA (`moveItem`); la copia (`copyItem`) c'è UNA volta sola, dopo, come ripiego di uno spostamento che non è permesso",
             { guard let spostamento = codiceSelettore.range(of: "moveItem(at: sorgente, to: destinazione)"), let copia = codiceSelettore.range(of: "copyItem(at: sorgente, to: destinazione)") else { return false }
               return spostamento.lowerBound < copia.lowerBound && codiceSelettore.components(separatedBy: ".copyItem(").count - 1 == 1 && codiceSelettore.components(separatedBy: ".moveItem(").count - 1 == 1 }())
    verifica("chiusura per trascinamento = annullato (`presentationControllerDidDismiss`)", codiceSelettore.contains("func presentationControllerDidDismiss("))
    verifica("la riduzione NON copia le proprietà: nessuna `kCGImageProperty*`, nessuna `AddImageFromSource` (solo la qualità)", !codiceFoto.contains("AddImageFromSource")
             && codiceFoto.components(separatedBy: "kCGImageProperty").count - 1 == 2 && codiceFoto.contains("kCGImagePropertyPixelWidth") && codiceFoto.contains("kCGImagePropertyPixelHeight"))
    verifica("la riduzione applica l'orientamento (`…CreateThumbnailWithTransform: true`) e non usa la miniatura incorporata (`…FromImageAlways: true`)",
             codiceFoto.contains("kCGImageSourceCreateThumbnailWithTransform: true") && codiceFoto.contains("kCGImageSourceCreateThumbnailFromImageAlways: true"))
    verifica("un solo `CGImageDestinationAddImage`, solo con la qualità", codiceFoto.components(separatedBy: "CGImageDestinationAddImage(").count - 1 == 1
             && codiceFoto.contains("[kCGImageDestinationLossyCompressionQuality: q] as CFDictionary"))
    verifica("la foto si scrive atomica e protetta", codiceFoto.contains("options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]"))
    verificaUguali("il selettore non scrive mai un file di suo con `.write(to:`", codiceSelettore.contains(".write(to:"), false)

    // «Dentro una chiamata di log non entra mai un nome, un percorso, un URL, un hash» (lo stesso elenco del lock di J4).
    let vietateNelLog = ["absoluteString", "relativeString", "localizedDescription", "suggestedName", "lastPathComponent", "\\bnome\\b", "\\.path\\b", "\\burl\\b", "sha256", "contentType",
                         "x-upsert", "apikey", "authorization", "token", "\\bfile\\b", "sorgente", "destinazione"]
    var chiamateDiLog = 0
    for (nome, codice) in [("KVSelettoreMedia.swift", codiceSelettore), ("KVCaricamentiPlugin.swift", codicePlugin), ("KVElaborazioneFoto.swift", codiceFoto)] {
        let tutte = chiamate("registro?.registra", in: codice) + chiamate("registro.registra", in: codice)
        chiamateDiLog += tutte.count
        for chiamata in tutte {
            let colpevoli = vietateNelLog.filter { chiamata.range(of: $0, options: [.regularExpression, .caseInsensitive]) != nil }
            verifica("\(nome): \(chiamata.prefix(60).replacingOccurrences(of: "\n", with: " "))… non porta forme vietate", colpevoli.isEmpty, "contiene \(colpevoli)")
        }
    }
    verifica("(il controllo guarda davvero qualcosa: \(chiamateDiLog) chiamate di log nei tre file)", chiamateDiLog >= 8)
    // Il log di SISTEMA: ogni valore interpolato è un numero o un nome di una lista chiusa.
    var interpolazioni = Set<String>()
    for codice in [selettore, testo["KVElaborazioneFoto.swift"]!, plugin] {
        for riga in codice.split(separator: "\n") where riga.contains("privacy: .public") {
            var resto = Substring(riga)
            while let apre = resto.range(of: "\\(") {
                guard let chiude = resto.range(of: ", privacy: .public)", range: apre.upperBound..<resto.endIndex) else { break }
                interpolazioni.insert(String(resto[apre.upperBound..<chiude.lowerBound]))
                resto = resto[chiude.upperBound...]
            }
        }
    }
    verificaUguali("il log di sistema interpola solo «cosa», dominio e codice dell'errore", interpolazioni.subtracting(["cosa", "e.dominio.rawValue", "e.codice"]), [])
    verifica("(e ne interpola davvero: \(interpolazioni.sorted()))", !interpolazioni.isEmpty)

    sezione("gli import: la riduzione e la preparazione non vedono Capacitor; solo la facciata lo importa")
    func importi(_ s: String) -> [String] { s.split(separator: "\n").map { String($0) }.filter { $0.hasPrefix("import ") } }
    verificaUguali("KVElaborazioneFoto.swift importa solo CoreGraphics, Foundation, ImageIO, UniformTypeIdentifiers", importi(testo["KVElaborazioneFoto.swift"]!),
                   ["import CoreGraphics", "import Foundation", "import ImageIO", "import UniformTypeIdentifiers"])
    verificaUguali("KVSelettoreMedia.swift importa framework di sistema (niente Capacitor né WebKit)", importi(selettore),
                   ["import AVFoundation", "import CryptoKit", "import Foundation", "import os", "import PhotosUI", "import UIKit", "import UniformTypeIdentifiers"])
    verificaUguali("KVCaricamentiPlugin.swift importa Foundation, e Capacitor e UIKit SOLO dentro `#if canImport(Capacitor)`", importi(plugin), ["import Foundation", "import Capacitor", "import UIKit"])
    verifica("… e i due import stanno fra `#if canImport(Capacitor)` e `#endif`, in testa al file", plugin.contains("#if canImport(Capacitor)\nimport Capacitor\nimport UIKit\n#endif\n"))

    sezione("la versione 1.2 (6) in ENTRAMBE le configurazioni, e i tre file in Sources")
    if let pbx = leggiTesto(cartellaProduzione + "/../App.xcodeproj/project.pbxproj") {
        verificaUguali("MARKETING_VERSION = 1.2 in due configurazioni", pbx.components(separatedBy: "MARKETING_VERSION = 1.2;").count - 1, 2)
        verificaUguali("CURRENT_PROJECT_VERSION = 6 in due configurazioni", pbx.components(separatedBy: "CURRENT_PROJECT_VERSION = 6;").count - 1, 2)
        verificaUguali("nessun MARKETING_VERSION con un altro valore", pbx.components(separatedBy: "MARKETING_VERSION = ").count - 1, 2)
        verificaUguali("nessun CURRENT_PROJECT_VERSION con un altro valore", pbx.components(separatedBy: "CURRENT_PROJECT_VERSION = ").count - 1, 2)
        let sorgentiFase = pbx.components(separatedBy: "/* Begin PBXSourcesBuildPhase section */").dropFirst().first?.components(separatedBy: "/* End PBXSourcesBuildPhase section */").first ?? ""
        for (nome, serie) in [("KVSelettoreMedia.swift", "17"), ("KVElaborazioneFoto.swift", "18"), ("KVCaricamentiPlugin.swift", "19")] {
            verifica("\(nome) è «in Sources»", sorgentiFase.contains("\(nome) in Sources"))
            verifica("\(nome): ID di costruzione KV28B0F00000000000\(serie) e di riferimento KV28F0F00000000000\(serie) (la serie dopo l'ultimo di I2)",
                     pbx.contains("KV28B0F00000000000\(serie) /* \(nome) in Sources */ = {isa = PBXBuildFile; fileRef = KV28F0F00000000000\(serie) /* \(nome) */; };")
                     && pbx.contains("KV28F0F00000000000\(serie) /* \(nome) */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = \(nome); sourceTree = \"<group>\"; };"))
            verificaUguali("\(nome): sta nel gruppo App (una riga di elenco)", pbx.split(separator: "\n").filter { $0.hasPrefix("\t\t\t\tKV28F0F") && $0.contains("/* \(nome) */,") }.count, 1)
        }
    } else {
        verifica("project.pbxproj leggibile", false)
    }
    if let plist = leggiTesto(cartellaProduzione + "/Info.plist") {
        verifica("Info.plist: nessun `UIBackgroundModes` (una sessione URLSession in background non lo richiede, §1.3)", !plist.contains("UIBackgroundModes"))
        verifica("Info.plist: nessuna chiave per la posizione (PHPicker non la dà e non la chiede)", !plist.contains("NSLocationWhenInUseUsageDescription")
                 && !plist.contains("NSLocationAlwaysAndWhenInUseUsageDescription"))
    }
}

// MARK: - Entrata

@main
struct ProveFoto {
    static func main() {
        setvbuf(stdout, nil, _IOLBF, 0)
        let argomenti = CommandLine.arguments
        guard argomenti.count >= 4 else {
            print("uso: prova-foto <release|debug> <cartella file di produzione> <caricamenti-nativi-tipi.ts>")
            exit(2)
        }
        let modo = argomenti[1]
        let cartellaProduzione = argomenti[2]
        guard let tipiTS = leggiTesto(argomenti[3]) else {
            print("FATALE: non leggo \(argomenti[3])")
            exit(2)
        }
        #if DEBUG
        let compilato = "debug"
        #else
        let compilato = "release"
        #endif
        print("Il compito I3 — selettore, «Scegli da File», foto ridotte, facciata del plugin, versione (modo \(modo))")
        sezione("la configurazione compilata è quella dichiarata")
        verificaUguali("modo di esecuzione = modo di compilazione (\(compilato))", modo, compilato)

        guard let risorse = generaRisorse() else {
            print("FATALE: le risorse di prova non si generano")
            exit(3)
        }
        provaRiduzioneFoto(risorse)
        provaOrientamenti()
        provaRiduzioneVarie()
        provaProfiloColore()
        provaSenzaMetadati()
        provaRiduzioneFallimenti()
        provaFunzioniPure(tipiTS)
        provaDizionariDelPonte()
        provaPonte(tipiTS)
        provaImpronta(risorse)
        provaPreparazioneVideo(risorse)
        provaRifiutiVideo(risorse)
        provaGuastiNostriVideo(risorse)
        provaSpostamentoNonPermesso(risorse)
        provaFotoPreparate(risorse)
        provaSessioneDeiFile(risorse)
        provaSessioneDellaGalleria(risorse)
        provaSelettoreLento(risorse)
        provaElementoDiProva()
        provaSorgenti(cartellaProduzione, tipiTS)
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
    }
}
