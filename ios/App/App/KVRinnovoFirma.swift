import Foundation

// ═══════════════════════════════════════════════════════════════════════════════════════════
//  KVRinnovoFirma — `POST /api/video-uploads/rinnovo`, il rinnovo dell'URL firmato (spec §5.4, §9, compito I2)
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// Che cosa fa: manda UNA richiesta con `x-kidville-rinnovo: <token>` e riporta quello che è tornato — lo stato HTTP, i byte del corpo, `Retry-After` —
// senza interpretarlo. Interpretarlo (`stato` ∈ tre valori, `protocollo == "put"`, URL `https`, la politica degli host) è di
// `KVPoliticaCaricamento.leggiRispostaRinnovo`, che non conosce la rete: ciò che non torna vale «transitorio», mai un'azione.
//
// Com'è fatta la richiesta:
//   · sessione `.ephemeral`, senza cookie, senza cache, senza credenziali condivise: il rinnovo è una porta SENZA SESSIONE
//     (`rinnovo/route.ts`), e una sessione col cookie dell'insegnante non serve a niente e non deve poter finire qui;
//   · corpo vuoto; l'unica intestazione nostra è `x-kidville-rinnovo`; tempo massimo 30 secondi;
//   · i REINDIRIZZAMENTI NON SI SEGUONO: un 3xx verso un altro indirizzo si porterebbe dietro il token. La 3xx arriva come risposta e vale
//     «fuori schema», cioè transitorio;
//   · gira DENTRO un lavoro in background (`KVLavoroInBackground`): se l'app passa in secondo piano mentre la richiesta è in volo, il
//     sistema non la sospende prima della risposta.
// Il token non compare mai in un log né in un URL: questo file non ha nessuna chiamata di log, e non nomina mai il valore del token se non per
// metterlo nell'intestazione.
//
// Questo file importa solo `Foundation`: si compila nell'harness `ios/prove/caricamenti/`.

// MARK: - Il lavoro in background

/// Chiede al sistema di non sospendere l'app per un po' (`beginBackgroundTask` su iOS). Il vero sta in `KVMotoreCaricamenti.swift`, perché
/// UIKit non deve entrare in questo file; l'harness ne inietta uno finto.
protocol KVLavoroInBackground: AnyObject {
    /// Inizia un lavoro e restituisce un gettone da passare a `termina`. `alScadere` scatta se il sistema ritira il tempo concesso prima che
    /// il lavoro sia finito: chi lo riceve deve chiudere subito (il gettone si termina da solo).
    func inizia(alScadere: @escaping () -> Void) -> Int
    /// Il lavoro è finito. Un gettone già terminato (o sconosciuto) non fa niente.
    func termina(_ gettone: Int)
}

// MARK: - Il cliente

/// Ciò che torna da una chiamata di rinnovo, grezzo. `statoHTTP` è `nil` se non c'è stata nessuna risposta (rete, timeout).
struct KVEsitoRinnovoRete: Equatable {
    var statoHTTP: Int?
    var corpo: Data
    var retryAfter: String?
}

/// Chi fa la chiamata. Il vero è `KVRinnovoFirma`; l'harness ne inietta uno che risponde a comando.
protocol KVClienteRinnovo: AnyObject {
    /// `completamento` scatta UNA volta, su un thread qualunque.
    func rinnova(url: URL, token: String, completamento: @escaping (KVEsitoRinnovoRete) -> Void)
}

final class KVRinnovoFirma: NSObject, KVClienteRinnovo, URLSessionTaskDelegate {

    /// Del corpo di una risposta del rinnovo non si tengono più di 64 KiB (una risposta vera è di qualche centinaio di byte).
    static let corpoMassimoByte = 65536
    static let tempoMassimoSecondi: TimeInterval = 30
    static let intestazioneToken = "x-kidville-rinnovo"

    private let lavoro: KVLavoroInBackground?
    private var sessione: URLSession!

    /// `configurazione` si può passare per iniettare un protocollo finto (l'harness); senza, `.ephemeral`.
    init(lavoro: KVLavoroInBackground?, configurazione: URLSessionConfiguration? = nil) {
        self.lavoro = lavoro
        super.init()
        self.sessione = URLSession(configuration: Self.configurazione(base: configurazione), delegate: self, delegateQueue: nil)
    }

    /// La configurazione della sessione del rinnovo: senza cookie, senza cache, senza credenziali, 30 secondi.
    static func configurazione(base: URLSessionConfiguration? = nil) -> URLSessionConfiguration {
        let configurazione = base ?? URLSessionConfiguration.ephemeral
        configurazione.httpShouldSetCookies = false
        configurazione.httpCookieAcceptPolicy = .never
        configurazione.httpCookieStorage = nil
        configurazione.urlCache = nil
        configurazione.urlCredentialStorage = nil
        configurazione.requestCachePolicy = .reloadIgnoringLocalCacheData
        configurazione.timeoutIntervalForRequest = tempoMassimoSecondi
        configurazione.timeoutIntervalForResource = tempoMassimoSecondi
        configurazione.waitsForConnectivity = false
        return configurazione
    }

    /// La richiesta: `POST`, corpo vuoto, la sola intestazione `x-kidville-rinnovo`.
    static func richiesta(url: URL, token: String) -> URLRequest {
        var richiesta = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: tempoMassimoSecondi)
        richiesta.httpMethod = "POST"
        richiesta.httpBody = Data()
        richiesta.setValue(token, forHTTPHeaderField: intestazioneToken)
        return richiesta
    }

    func rinnova(url: URL, token: String, completamento: @escaping (KVEsitoRinnovoRete) -> Void) {
        let gettone = lavoro?.inizia(alScadere: {})
        let lavoro = self.lavoro
        let task = sessione.dataTask(with: Self.richiesta(url: url, token: token)) { dati, risposta, _ in
            // Un errore di rete non si legge: senza risposta HTTP è «nessuna risposta» e la politica lo tratta da transitorio (rete).
            let http = risposta as? HTTPURLResponse
            let esito = KVEsitoRinnovoRete(statoHTTP: http?.statusCode,
                                           corpo: Data((dati ?? Data()).prefix(Self.corpoMassimoByte)),
                                           retryAfter: http?.value(forHTTPHeaderField: "Retry-After"))
            completamento(esito)
            if let gettone = gettone { lavoro?.termina(gettone) }
        }
        task.resume()
    }

    // MARK: URLSessionTaskDelegate

    /// Nessun reindirizzamento: il token non deve seguire un 3xx verso un altro indirizzo.
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
