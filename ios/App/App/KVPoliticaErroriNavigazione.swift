import Foundation

/// Cosa fare quando una navigazione della WebView non arriva a destinazione.
///
/// I due esiti sono deliberatamente due, non uno: il difetto speculare a quello che
/// questo file corregge sarebbe ingoiare TUTTI gli errori e non mostrare più la
/// schermata di ripiego nemmeno quando la rete manca davvero.
enum KVEsitoNavigazione: Equatable {
    /// Guasto vero: la pagina non è arrivata. Si mostra `server.errorPath` (offline.html).
    case mostraSchermataOffline
    /// La navigazione è stata ANNULLATA — da noi o da una navigazione successiva.
    /// Non è successo niente di male: chi ha annullato sta già caricando altro.
    case ignoraAnnullamento
}

/// La politica sugli errori di navigazione della WebView.
///
/// **Perché esiste** (rilievo mobile-ios F3 del collaudo 2026-07-31)
/// Dopo un login andato a buon fine, 1 volta su 6, compariva la schermata
/// «KIDVILLE NON È RAGGIUNGIBILE — controlla la connessione e riprova», con il server
/// perfettamente raggiungibile. Nel log del simulatore:
///
///     DocumentLoader::setMainDocumentError: (type=3, code=-999)
///     Failed provisional load (isTimeout = 0, isCancellation = 1, errorCode = -999)
///
/// `-999` è `NSURLErrorCancelled`: la navigazione non era fallita, era stata annullata da
/// una seconda partita 28 ms dopo (il login faceva `router.replace` e subito
/// `router.refresh`, corretto in `src/app/auth/login/page.tsx`). Capacitor, in
/// `WebViewDelegationHandler.webView(_:didFailProvisionalNavigation:withError:)`, carica
/// `server.errorPath` per QUALUNQUE errore: non distingue l'annullamento dal guasto.
///
/// Dire a una famiglia «non hai rete» quando la rete c'è la manda a controllare il router
/// invece che a riprovare, e fa sembrare rotta un'app che funziona.
///
/// **Vincolo deliberato:** questo file importa solo `Foundation`. Niente WebKit, niente
/// Capacitor. Così la decisione si compila e si prova in isolamento con `swiftc`, senza
/// simulatore — ed è il lock `__tests__/architecture/ios-navigazione-annullata.test.ts` a
/// impedire che qualcuno ci infili dentro una dipendenza e renda la prova non eseguibile.
enum KVPoliticaErroriNavigazione {

    /// `NSURLErrorCancelled`. Il numero è scritto per esteso di proposito: nel log del
    /// simulatore si legge `-999`, e chi indaga deve ritrovarlo qui.
    static let codiceAnnullata = -999 // NSURLErrorCancelled

    /// `WKErrorFrameLoadInterruptedByPolicyChange`. È l'annullamento deciso da NOI:
    /// `decidePolicyFor` di Capacitor annulla le navigazioni di primo livello verso
    /// l'esterno e le apre in Safari. Mostrare «non sei raggiungibile» dopo che l'utente
    /// ha toccato un link esterno è lo stesso difetto, con un'altra faccia.
    static let codiceInterrottaDaPolicy = 102

    static let dominioURL = "NSURLErrorDomain"
    static let dominioWebKit = "WKErrorDomain"

    /// La decisione, in forma pura: dominio e codice dentro, esito fuori.
    static func esito(dominio: String, codice: Int) -> KVEsitoNavigazione {
        if dominio == dominioURL && codice == codiceAnnullata {
            return .ignoraAnnullamento
        }
        if dominio == dominioWebKit && codice == codiceInterrottaDaPolicy {
            return .ignoraAnnullamento
        }
        return .mostraSchermataOffline
    }

    /// Comodo per il chiamante, che ha un `Error` e non due campi.
    static func esito(perErrore errore: Error) -> KVEsitoNavigazione {
        let ns = errore as NSError
        return esito(dominio: ns.domain, codice: ns.code)
    }
}
