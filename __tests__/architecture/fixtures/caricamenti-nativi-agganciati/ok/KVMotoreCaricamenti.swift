// FIXTURE del lock `caricamenti-nativi-agganciati` — VERDE per costruzione (regole 4 e 5, e le chiamate di log della regola 9).
// Il motore (il singolo che l'AppDelegate chiama) e la sessione `URLSession` in background con i parametri di §5.2.
//
// Nei commenti compaiono di proposito le parole che il lock vieta DENTRO una chiamata di log: `absoluteString`, `lastPathComponent`,
// `suggestedName`, `localizedDescription`, `apikey`, `authorization`, `x-upsert`. Qui sono commenti, e un commento non è una chiamata.
import Foundation
import os

final class KVMotoreCaricamenti {
    static let identificativoSessione = "it.kidville.app.caricamenti"
    static let condiviso = KVMotoreCaricamenti()

    private let diagnostica = Logger(subsystem: "it.kidville.app", category: "caricamenti-motore")
    let registro = KVRegistroNativo()

    func avvia() {}

    func ricollega(_ identificativo: String, _ completamento: @escaping () -> Void) {
        guard identificativo == Self.identificativoSessione else { return completamento() }
        completamento()
    }

    func riprendiInPrimoPiano() {}
    func notificaSeFermo() {}

    func accoda(job: UUID, utente: UUID, byte: Int64) {
        // Una chiamata di log VERDE: solo uuid, numeri ed enumerati.
        registro.registraAccodato(job: job, utente: utente, byte: byte)
        diagnostica.error("transizione non applicata: codice \(byte, privacy: .public)")
    }

    /// Il nome del file serve allo schermo e basta: leggerlo FUORI da una chiamata di log è lecito.
    func nomePerLoSchermo(_ provider: NSItemProvider, _ url: URL) -> String {
        let nome = provider.suggestedName ?? url.lastPathComponent
        return nome
    }

    /// Un `authorizationStatus` dentro un log non è la credenziale `authorization`: il lock confronta parole intere.
    func notificheAmmesse(_ stato: Int) {
        diagnostica.info("notifiche: stato \(stato, privacy: .public) authorizationStatus")
    }
}

final class KVTrasportoPutURLSession {
    static let identificativo = KVMotoreCaricamenti.identificativoSessione

    static func configurazione() -> URLSessionConfiguration {
        let configurazione = URLSessionConfiguration.background(withIdentifier: identificativo)
        configurazione.sessionSendsLaunchEvents = true
        configurazione.isDiscretionary = false
        configurazione.allowsCellularAccess = true
        configurazione.allowsExpensiveNetworkAccess = true
        configurazione.allowsConstrainedNetworkAccess = true
        configurazione.timeoutIntervalForResource = 24 * 3600
        configurazione.httpShouldSetCookies = false
        return configurazione
    }
}
