// FIXTURE ROSSA del lock `caricamenti-nativi-agganciati` (regola 9, Swift): una chiamata di log con `absoluteString`.
// L'indirizzo di un caricamento (URL firmato, percorso del file) è una credenziale o un dato di un minore: nel log non entra mai.
// Qui compare in TRE modi diversi di scrivere un log — il registro nativo, il `Logger` di sistema, il `Logger` costruito sul posto —
// e il lock deve nominare ogni riga. Il `print` finale è invece un'altra forma, non meno vietata.
import Foundation
import os

final class KVMotoreFinto {
    private let diagnostica = Logger(subsystem: "it.kidville.app", category: "caricamenti-motore")
    let registro = KVRegistroNativo()

    func fallisce(job: UUID, utente: UUID, url: URL) {
        registro.registraFallito(job: job, utente: utente, dettaglio: url.absoluteString)
        diagnostica.error("invio fallito verso \(url.absoluteString, privacy: .public)")
        Logger(subsystem: "it.kidville.app", category: "caricamenti-motore")
            .info("riprovo \(url.absoluteString)")
        print("riprovo", url.absoluteString)
    }
}
