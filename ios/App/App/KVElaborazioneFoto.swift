import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// ═══════════════════════════════════════════════════════════════════════════════════════════
//  KVElaborazioneFoto — la riduzione delle foto scelte (spec §5.6, compito I3)
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// Che cosa è: ciò che trasforma la foto che il selettore ha consegnato (HEIC da 48 megapixel, JPEG, PNG, un file di «Scegli da File»)
// nel JPEG che parte verso il JavaScript: al più `latoMassimo` pixel sul lato lungo (1920), qualità `qualita` (0,85), dritto, SENZA un
// solo metadato. È la foto che la tela di WebKit non reggeva (foto nere da 1×1): qui non si passa mai da una tela, e il decodificatore
// di sistema non costruisce mai la foto intera in memoria.
//
// ─── COME È FATTO ────────────────────────────────────────────────────────────────────────────
//  · `CGImageSourceCreateThumbnailAtIndex` con `kCGImageSourceThumbnailMaxPixelSize`, `…CreateThumbnailWithTransform` (l'orientamento si
//    APPLICA ai pixel: dopo non c'è più niente da leggere in un tag) e `…CreateThumbnailFromImageAlways` (mai la miniatura incorporata, che
//    è un'altra foto: a volte più piccola, a volte con un'altra inquadratura). Il sistema non ingrandisce: una foto piccola esce com'è.
//  · una foto con la trasparenza (un PNG di «Scegli da File») si compone su fondo BIANCO: il JPEG non ha il canale alfa, e senza questo passo
//    i pixel trasparenti uscirebbero neri.
//  · si scrive con `CGImageDestination` SENZA proprietà: non si passa niente a `CGImageDestinationAddImage` e non si usa
//    `…AddImageFromSource` (che le copierebbe). Niente EXIF, niente GPS, niente TIFF, niente XMP, niente IPTC: la posizione di una scuola o
//    di una casa non esce dal telefono dentro una foto di un bambino. Poi si tolgono dal file anche i segmenti che il codificatore scrive DA
//    SOLO (un EXIF minimo con spazio colore e dimensioni, un blocco Photoshop): misurato, li scrive per ogni immagine opaca. Lo prova l'harness
//    guardando i SEGMENTI del file JPEG, non solo le proprietà che il sistema ne ricava.
//  · il profilo colore resta quello dell'immagine (un Display P3 esce P3, con il suo profilo incorporato dal sistema).
//  · la scrittura è atomica e protetta (`completeFileProtectionUntilFirstUserAuthentication`, come ogni file del giornale).
//
// Questo file importa solo framework di sistema che l'harness compila (`ios/prove/caricamenti/prove-foto.swift`): niente Capacitor, niente
// UIKit. Non scrive nessun log (non ne ha il registro): dice com'è andata, e il chiamante (`KVPreparazioneMedia`) decide che cosa ne scrive.

// MARK: - Gli esiti

struct KVFotoRidotta: Equatable {
    var larghezza: Int
    var altezza: Int
    var byte: Int64
}

/// Come è andata la riduzione. Cinque modi di non riuscire, perché il selettore li tratta in modo diverso: un file che il sistema non conosce, vuoto
/// o che non si decodifica è un rifiuto ATTESO (l'insegnante ne ha scelto uno rotto), mentre una consegna che non si legge, una foto valida che non
/// esce o un posto in cui non si scrive sono un difetto NOSTRO, e vanno nel log.
enum KVEsitoRiduzioneFoto: Equatable {
    case ridotta(KVFotoRidotta)
    /// Il sistema non riconosce il file come un'immagine (byte che non sono una foto, o un formato che non conosce).
    case formatoNonRiconosciuto
    /// Il file è vuoto, o il sistema dice che è un'immagine ma non ne trova nessuna (o non si apre).
    case illeggibile
    /// Non si riescono nemmeno a leggere gli attributi del file che il sistema ci ha appena consegnato (sparito, permessi): non è un file rotto
    /// dell'insegnante, è una consegna che non ha funzionato, e va nel log. L'errore di sistema.
    case sorgenteNonLetta(KVErroreSistema)
    /// Il sistema riconosce una foto ma non ne esce il JPEG ridotto (decodifica fallita, memoria): non è colpa dell'insegnante.
    case riduzioneFallita
    /// Il JPEG c'è ma non si riesce a scriverlo nella destinazione (disco pieno, cartella sparita). L'errore di sistema, se c'è.
    case scritturaFallita(KVErroreSistema?)
}

// MARK: - La riduzione

enum KVElaborazioneFoto {

    /// Il tipo con cui la foto ridotta arriva al JavaScript (`mime` di `leggiFoto`): sempre JPEG.
    static let tipoUscita = "image/jpeg"

    /// La qualità del JPEG della miniatura di un video (non della foto: quella la decide il JavaScript).
    static let qualitaMiniatura = 0.7

    /// Porta `origine` a un JPEG di al più `latoMassimo` pixel sul lato lungo e lo scrive in `destinazione` (atomico, protetto).
    /// Non tocca `origine`: chi la riduce decide se cancellarla.
    static func riduci(da origine: URL, latoMassimo: Int, qualita: Double, verso destinazione: URL) -> KVEsitoRiduzioneFoto {
        // Un file vuoto è illeggibile (non «un formato che non conosciamo»); uno di cui non si leggono gli attributi è una consegna fallita.
        let peso: Int64
        do {
            peso = (try FileManager.default.attributesOfItem(atPath: origine.path)[.size] as? NSNumber)?.int64Value ?? 0
        } catch {
            return .sorgenteNonLetta(KVErroreSistema(error))
        }
        if peso == 0 { return .illeggibile }
        switch leggiRidotta(da: origine, latoMassimo: latoMassimo) {
        case .formatoNonRiconosciuto: return .formatoNonRiconosciuto
        case .illeggibile: return .illeggibile
        case .riduzioneFallita: return .riduzioneFallita
        case .immagine(let immagine):
            guard let opaca = suSfondoBianco(immagine), let dati = codificaJPEG(opaca, qualita: qualita) else { return .riduzioneFallita }
            do {
                try dati.write(to: destinazione, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            } catch {
                return .scritturaFallita(KVErroreSistema(error))
            }
            return .ridotta(KVFotoRidotta(larghezza: opaca.width, altezza: opaca.height, byte: Int64(dati.count)))
        }
    }

    /// Le dimensioni in pixel di un file d'immagine, lette dall'intestazione (non decodifica niente): servono a `leggiFoto`, che restituisce
    /// larghezza e altezza di una foto che questo file ha già ridotto.
    static func dimensioni(diFile url: URL) -> (larghezza: Int, altezza: Int)? {
        guard let sorgente = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
              CGImageSourceGetCount(sorgente) > 0,
              let proprieta = CGImageSourceCopyPropertiesAtIndex(sorgente, 0, nil) as? [CFString: Any],
              let larghezza = (proprieta[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
              let altezza = (proprieta[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue,
              larghezza > 0, altezza > 0 else { return nil }
        return (larghezza, altezza)
    }

    // MARK: Lettura

    private enum Lettura {
        case immagine(CGImage)
        case formatoNonRiconosciuto
        case illeggibile
        case riduzioneFallita
    }

    private static func leggiRidotta(da origine: URL, latoMassimo: Int) -> Lettura {
        guard latoMassimo >= 1 else { return .riduzioneFallita }
        // Non si tiene niente in cache: una foto da 48 megapixel decodificata resterebbe in memoria fino al prossimo avviso di memoria.
        let opzioniSorgente: [CFString: Any] = [kCGImageSourceShouldCache: false]
        guard let sorgente = CGImageSourceCreateWithURL(origine as CFURL, opzioniSorgente as CFDictionary) else { return .illeggibile }
        // Byte che non sono un'immagine: il sistema crea comunque una sorgente, ma non ne sa dire il tipo e non ne trova nessuna.
        guard CGImageSourceGetType(sorgente) != nil else { return .formatoNonRiconosciuto }
        guard CGImageSourceGetCount(sorgente) > 0 else { return .illeggibile }
        let opzioni: [CFString: Any] = [
            kCGImageSourceThumbnailMaxPixelSize: latoMassimo,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let immagine = CGImageSourceCreateThumbnailAtIndex(sorgente, 0, opzioni as CFDictionary) else { return .riduzioneFallita }
        return .immagine(immagine)
    }

    // MARK: Trasparenza

    /// Vero se l'immagine porta un canale alfa. Quello dei pixel «saltati» (`noneSkip…`) è spazio vuoto, non trasparenza.
    static func haTrasparenza(_ immagine: CGImage) -> Bool {
        switch immagine.alphaInfo {
        case .none, .noneSkipFirst, .noneSkipLast: return false
        default: return true
        }
    }

    /// L'immagine com'è, se è opaca; altrimenti la stessa composta su fondo bianco (senza canale alfa).
    static func suSfondoBianco(_ immagine: CGImage) -> CGImage? {
        guard haTrasparenza(immagine) else { return immagine }
        // Lo spazio colore dell'immagine, se è un RGB (così un P3 resta P3); un grigio o uno spazio che un contesto da 8 bit non regge → sRGB.
        var spazi: [CGColorSpace] = []
        if let proprio = immagine.colorSpace, proprio.model == .rgb { spazi.append(proprio) }
        if let srgb = CGColorSpace(name: CGColorSpace.sRGB) { spazi.append(srgb) }
        for spazio in spazi {
            guard let contesto = CGContext(data: nil, width: immagine.width, height: immagine.height, bitsPerComponent: 8, bytesPerRow: 0,
                                           space: spazio, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { continue }
            let area = CGRect(x: 0, y: 0, width: immagine.width, height: immagine.height)
            contesto.setFillColor(red: 1, green: 1, blue: 1, alpha: 1)
            contesto.fill(area)
            contesto.draw(immagine, in: area)
            if let composta = contesto.makeImage() { return composta }
        }
        return nil
    }

    // MARK: Scrittura

    /// L'immagine come JPEG, SENZA metadati: nessuna proprietà passata al sistema, nessuna copiata da una sorgente, e poi si tolgono dal file anche
    /// i segmenti che il codificatore scrive da solo (`senzaMetadati`). `qualita` è tenuta in (0, 1]: uno zero produrrebbe un file che nessuno
    /// guarda, e oltre 1 il sistema non va. `nil` se il file che esce non si sa pulire: un JPEG che non si è potuto verificare non parte.
    static func codificaJPEG(_ immagine: CGImage, qualita: Double) -> Data? {
        let dati = NSMutableData()
        guard let destinazione = CGImageDestinationCreateWithData(dati as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        let q = min(max(qualita, 0.01), 1.0)
        CGImageDestinationAddImage(destinazione, immagine, [kCGImageDestinationLossyCompressionQuality: q] as CFDictionary)
        guard CGImageDestinationFinalize(destinazione), dati.length > 0 else { return nil }
        return senzaMetadati(dati as Data)
    }

    /// Toglie da un JPEG ogni segmento che porta metadati. Misurato: dato un `CGImage` opaco, il codificatore di sistema scrive DA SOLO un blocco
    /// EXIF minimo (spazio colore e dimensioni in pixel, APP1) e un blocco Photoshop (APP13), anche se non gli si passa nessuna proprietà. Non
    /// sono dati di una persona, ma «niente EXIF» deve poterlo dire chiunque guardi il file, e non dipende dall'umore del codificatore.
    ///
    /// Si tolgono: APP1 (EXIF e XMP), APP13 (IPTC e Photoshop), ogni altro APP3…APP12 e APP15, e i commenti (COM). Restano ciò che serve a
    /// rileggere l'immagine: APP0 (JFIF), APP2 (il profilo colore ICC: senza, un Display P3 cambierebbe colori), APP14 (il flag del colore Adobe),
    /// le tabelle, l'intestazione e i dati. Dal marcatore SOS in poi il file si copia com'è, fino all'EOI.
    ///
    /// `nil` se non è un JPEG intero (non comincia con SOI, un segmento esce dal file, non si arriva mai a SOS): meglio nessun file che uno che
    /// potrebbe portarsi dietro ciò che non sappiamo leggere.
    static func senzaMetadati(_ jpeg: Data) -> Data? {
        guard jpeg.count > 4, jpeg[jpeg.startIndex] == 0xFF, jpeg[jpeg.startIndex + 1] == 0xD8 else { return nil }
        var uscita = Data(capacity: jpeg.count)
        uscita.append(contentsOf: [0xFF, 0xD8])
        var i = jpeg.startIndex + 2
        while i + 4 <= jpeg.endIndex {
            guard jpeg[i] == 0xFF else { return nil }
            let marcatore = jpeg[i + 1]
            if marcatore == 0xFF {
                // Byte di riempimento fra due segmenti.
                i += 1
                continue
            }
            if marcatore == 0xDA {
                uscita.append(jpeg[i...])
                return uscita
            }
            let lunghezza = Int(jpeg[i + 2]) << 8 | Int(jpeg[i + 3])
            guard lunghezza >= 2, i + 2 + lunghezza <= jpeg.endIndex else { return nil }
            let daTogliere = marcatore == 0xFE || ((0xE1...0xEF).contains(marcatore) && marcatore != 0xE2 && marcatore != 0xEE)
            if !daTogliere { uscita.append(jpeg[i..<(i + 2 + lunghezza)]) }
            i += 2 + lunghezza
        }
        return nil
    }

    /// Porta un'immagine a un lato lungo di al più `lato` pixel (non ingrandisce mai). Serve alla miniatura di un video, che il sistema può
    /// consegnare più grande di ciò che si è chiesto.
    static func ridimensionata(_ immagine: CGImage, latoMassimo lato: Int) -> CGImage? {
        let lungo = max(immagine.width, immagine.height)
        guard lato >= 1, lungo > lato else { return immagine }
        let scala = Double(lato) / Double(lungo)
        let larghezza = max(1, Int((Double(immagine.width) * scala).rounded()))
        let altezza = max(1, Int((Double(immagine.height) * scala).rounded()))
        var spazi: [CGColorSpace] = []
        if let proprio = immagine.colorSpace, proprio.model == .rgb { spazi.append(proprio) }
        if let srgb = CGColorSpace(name: CGColorSpace.sRGB) { spazi.append(srgb) }
        for spazio in spazi {
            guard let contesto = CGContext(data: nil, width: larghezza, height: altezza, bitsPerComponent: 8, bytesPerRow: 0, space: spazio,
                                           bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { continue }
            contesto.interpolationQuality = .high
            contesto.setFillColor(red: 1, green: 1, blue: 1, alpha: 1)
            contesto.fill(CGRect(x: 0, y: 0, width: larghezza, height: altezza))
            contesto.draw(immagine, in: CGRect(x: 0, y: 0, width: larghezza, height: altezza))
            if let ridotta = contesto.makeImage() { return ridotta }
        }
        return nil
    }
}
