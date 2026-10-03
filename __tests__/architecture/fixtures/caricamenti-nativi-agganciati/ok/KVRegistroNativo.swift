// FIXTURE del lock `caricamenti-nativi-agganciati` — VERDE per costruzione (regole 9 e 10, iOS).
// Il registro dei log del nativo: l'elenco CHIUSO dei messaggi e la regione «API di log», solo enumerati e numeri.
import Foundation

enum KVMessaggioLog: String, CaseIterable {
    case videoNativoAccodato = "video-nativo-accodato"
    case videoNativoInviato = "video-nativo-inviato"
    case videoNativoRitento = "video-nativo-ritento"
    case videoNativoRinnovo = "video-nativo-rinnovo"
    case videoNativoAttesaRete = "video-nativo-attesa-rete"
    case videoNativoPausa = "video-nativo-pausa"
    case videoNativoRipresoDopoChiusura = "video-nativo-ripreso-dopo-chiusura"
    case videoNativoAnnullato = "video-nativo-annullato"
    case videoNativoFallito = "video-nativo-fallito"
    case mediaNativoPreparazioneFallita = "media-nativo-preparazione-fallita"
    case caricamentiNativiMotore = "caricamenti-nativi-motore"
    case codaNativaCorrotta = "coda-nativa-corrotta"
    case registroNativoScartati = "registro-nativo-scartati"
    case notificaLocaleNonAutorizzata = "notifica-locale-non-autorizzata"
    case putOltreScadenza = "put-oltre-scadenza"
}

final class KVRegistroNativo {

    // MARK: - API di log (solo enumerati, numeri, booleani e UUID)

    func registraAccodato(job: UUID, utente: UUID, byte: Int64) {}
    func registraFallito(job: UUID, utente: UUID, tentativi: Int) {}
    func registraCodaCorrotta(fileOrfani: Int) {}

    // MARK: - Fine API di log

    func stato() -> Int { 0 }
}
