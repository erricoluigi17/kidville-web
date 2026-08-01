import Foundation
import UIKit
import WebKit
import Capacitor
import os

/// Il filtro fra WebKit e Capacitor: fa passare i guasti veri, ferma gli annullamenti.
///
/// Capacitor tiene la sua logica in `WebViewDelegationHandler`, che è `open` ma viene
/// creato dentro `CAPBridgeViewController.loadView()`, che è `final`: non c'è modo di
/// sostituirlo con una sottoclasse. Quindi non lo si sostituisce — gli si sta davanti.
/// Questo oggetto diventa il `navigationDelegate` della WebView, tratta i DUE metodi di
/// fallimento e **inoltra tutto il resto** all'originale con `forwardingTarget`.
///
/// L'inoltro trasparente non è un vezzo: se elencassimo a mano i metodi da rigirare, il
/// giorno in cui Capacitor ne aggiunge uno (una decisione di policy, una sfida TLS, il
/// riavvio dopo il crash del processo web) quel metodo sparirebbe in silenzio.
final class KVDelegatoNavigazioneFiltrante: NSObject, WKNavigationDelegate {

    /// Riferimento FORTE all'originale: `WKWebView.navigationDelegate` è `weak`, e un
    /// bersaglio d'inoltro che diventa `nil` è un'app che smette di navigare.
    private let interno: WKNavigationDelegate
    private let registro: Logger

    init(interno: WKNavigationDelegate, registro: Logger) {
        self.interno = interno
        self.registro = registro
        super.init()
    }

    // MARK: - I DUE metodi che trattiamo

    // `WKNavigationDelegate` ha due gestori di fallimento, non uno:
    //   · `didFailProvisionalNavigation` — la pagina non era ancora cominciata ad arrivare;
    //   · `didFail`                      — la navigazione era già stata accettata (committed).
    // Capacitor carica `server.errorPath` in ENTRAMBI, senza distinguere l'annullamento dal
    // guasto (`WebViewDelegationHandler.swift`, righe 131-155 di `@capacitor/ios`). Filtrare
    // solo il primo lascia in piedi metà del difetto: la schermata «KIDVILLE NON È
    // RAGGIUNGIBILE» ricompare quando l'annullamento arriva a navigazione avviata.
    //
    // La decisione è scritta UNA volta sola, in `decidi(_:gestore:inoltraACapacitor:)`:
    // duplicarla significherebbe correggerne una e dimenticare l'altra — cioè esattamente
    // come è nato questo secondo buco.

    // Il force unwrap fa parte della dichiarazione del protocollo.
    // swiftlint:disable:next implicitly_unwrapped_optional
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        decidi(error, gestore: "didFailProvisionalNavigation") {
            interno.webView?(webView, didFailProvisionalNavigation: navigation, withError: error)
        }
    }

    // swiftlint:disable:next implicitly_unwrapped_optional
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        decidi(error, gestore: "didFail") {
            interno.webView?(webView, didFail: navigation, withError: error)
        }
    }

    /// L'unico posto in cui si decide. `inoltraACapacitor` è la palla che si passa
    /// all'originale: chiamarla vuol dire far comparire la schermata offline, non chiamarla
    /// vuol dire lasciare che la navigazione successiva finisca il suo lavoro.
    ///
    /// **Effetto collaterale noto, e voluto.** Non inoltrando `didFail`, salta anche il
    /// ripristino di `webView.isOpaque` che Capacitor fa lì al primo caricamento. Non è una
    /// perdita: quel ripristino avviene comunque in `didFinish`, e la navigazione che ha
    /// annullato questa sta già caricando. Inoltrare per non perderlo significherebbe
    /// riportarsi in casa il difetto: `errorPath` si carica nella stessa riga.
    private func decidi(_ errore: Error, gestore: String, inoltraACapacitor: () -> Void) {
        let ns = errore as NSError
        if KVPoliticaErroriNavigazione.esito(perErrore: errore) == .ignoraAnnullamento {
            // Nel log finiscono SOLO dominio e codice. Mai l'indirizzo: in questo repo il
            // path è una credenziale (`/m/<token>`, vedi `src/middleware.ts`) e gli id dei
            // minori sono segmenti di rotta.
            registro.info("navigazione annullata in \(gestore, privacy: .public): nessuna schermata offline (dominio \(ns.domain, privacy: .public), codice \(ns.code, privacy: .public))")
            return
        }
        registro.error("navigazione fallita in \(gestore, privacy: .public): mostro la schermata offline (dominio \(ns.domain, privacy: .public), codice \(ns.code, privacy: .public))")
        inoltraACapacitor()
    }

    // MARK: - Tutto il resto va a Capacitor

    override func responds(to aSelector: Selector!) -> Bool {
        return super.responds(to: aSelector) || interno.responds(to: aSelector)
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        return interno.responds(to: aSelector) ? interno : super.forwardingTarget(for: aSelector)
    }
}

/// Il controller dell'app: `CAPBridgeViewController` più il filtro sugli annullamenti.
///
/// Lo storyboard `Base.lproj/Main.storyboard` instanzia QUESTA classe. Se qualcuno la
/// rimettesse a `CAPBridgeViewController`, il filtro resterebbe nel repo senza girare mai:
/// è una delle condizioni che il lock
/// `__tests__/architecture/ios-navigazione-annullata.test.ts` sorveglia. La prova che il
/// filtro FUNZIONA (e non solo che esiste) si esegue con
/// `ios/prove/filtro-annullamenti/esegui.sh`.
class KVBridgeViewController: CAPBridgeViewController {

    private var delegatoFiltrante: KVDelegatoNavigazioneFiltrante?

    /// `CAPLog` qui non serve: `capacitor.config.json` ha `loggingBehavior: "none"` (scelta
    /// del 2026-07-25, le foto in base64 finivano nel log) e quindi `CAPLog.print` è muto.
    /// `os.Logger` scrive comunque nel log di sistema, che è dove si è letto `code=-999`.
    private let registro = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "it.kidville.app",
        category: "webview"
    )

    /// Chiamato in coda a `loadView()`: la WebView esiste già e Capacitor le ha appena
    /// assegnato i suoi delegati, ma il primo caricamento (`loadWebView()`, da
    /// `viewDidLoad`) non è ancora partito. È l'unico istante in cui ci si può mettere in
    /// mezzo: `WKWebView` memorizza a quali metodi risponde il delegato nel momento in cui
    /// glielo si assegna.
    override func capacitorDidLoad() {
        super.capacitorDidLoad()

        guard let webView = webView else {
            // Configurazione mancante = livello error (AGENTS.md regola 4): senza WebView
            // il filtro non esiste e la schermata «non raggiungibile» torna a comparire
            // dopo un login riuscito, senza che nessuno sappia perché.
            registro.error("filtro annullamenti NON agganciato: la WebView non esiste")
            return
        }
        guard let originale = webView.navigationDelegate else {
            registro.error("filtro annullamenti NON agganciato: Capacitor non ha impostato il navigationDelegate")
            return
        }

        let filtro = KVDelegatoNavigazioneFiltrante(interno: originale, registro: registro)
        delegatoFiltrante = filtro
        webView.navigationDelegate = filtro
        // Anche il successo si logga (AGENTS.md regola 5): con i soli errori, «nessun log»
        // non distingue «agganciato e nessuna navigazione annullata» da «mai agganciato».
        registro.info("filtro annullamenti agganciato al navigationDelegate")
    }
}
