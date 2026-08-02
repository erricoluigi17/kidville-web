// Prova di COMPORTAMENTO del filtro sugli annullamenti di navigazione (step S28).
//
// Perché esiste: i lock in `__tests__/architecture/ios-navigazione-annullata.test.ts` sono
// grep sul sorgente — dicono che il codice C'È, non che FUNZIONA. Swift non gira in vitest,
// quindi la domanda vera («Capacitor viene ancora chiamato quando la navigazione è stata
// solo annullata?») va risposta compilando ed eseguendo il file di produzione per davvero.
//
// Qui NON si ricopia niente: si compilano gli stessi due file che finiscono nell'app
// (`KVPoliticaErroriNavigazione.swift` e `KVBridgeViewController.swift`), si inietta un
// delegato finto al posto di quello di Capacitor e si guarda SE VIENE CHIAMATO. L'asserzione
// è sulla conseguenza — l'inoltro che carica `errorPath` — non sulla presenza di una stringa.
//
// Si esegue con `./esegui.sh` (compila per il simulatore e lancia con `simctl spawn`).

import Foundation
import UIKit
import WebKit

// MARK: - Il delegato che Capacitor installa, sostituito da uno che tiene il conto

/// Sta al posto di `WebViewDelegationHandler`. Non carica `errorPath` — annota soltanto di
/// essere stato chiamato. Se il filtro lascia passare un annullamento, qui il contatore sale:
/// nell'app vera, al posto del contatore, c'è il caricamento della schermata «non
/// raggiungibile».
final class DelegatoCapacitorFinto: NSObject, WKNavigationDelegate {
    var inoltriProvisional: [Int] = []
    var inoltriDidFail: [Int] = []
    var inoltriDidFinish = 0

    // swiftlint:disable:next implicitly_unwrapped_optional
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        inoltriProvisional.append((error as NSError).code)
    }

    // swiftlint:disable:next implicitly_unwrapped_optional
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        inoltriDidFail.append((error as NSError).code)
    }

    // Serve a provare che l'inoltro trasparente non tronca i metodi che non trattiamo.
    // swiftlint:disable:next implicitly_unwrapped_optional
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        inoltriDidFinish += 1
    }
}

// MARK: - Piccolo cerimoniale di prova

var fallimenti: [String] = []
var superate = 0

func verifica(_ descrizione: String, _ condizione: @autoclosure () -> Bool) {
    if condizione() {
        superate += 1
        print("  ok   \(descrizione)")
    } else {
        fallimenti.append(descrizione)
        print("  FAIL \(descrizione)")
    }
}

func errore(_ dominio: String, _ codice: Int) -> NSError {
    NSError(domain: dominio, code: codice, userInfo: nil)
}

let annullataDaAltraNavigazione = errore("NSURLErrorDomain", -999) // NSURLErrorCancelled
let interrottaDaPolicy = errore("WKErrorDomain", 102)             // frameLoadInterrupted
let reteAssente = errore("NSURLErrorDomain", -1009)               // notConnectedToInternet
let serverIrraggiungibile = errore("NSURLErrorDomain", -1004)     // cannotConnectToHost

// MARK: - Montaggio: com'è nell'app, senza Xcode

let webView = WKWebView(frame: .zero)
let capacitor = DelegatoCapacitorFinto()
webView.navigationDelegate = capacitor

let controller = KVBridgeViewController()
controller.webView = webView
// È esattamente il punto in cui Capacitor chiama il nostro codice: in coda a `loadView()`.
controller.capacitorDidLoad()

guard let filtro = webView.navigationDelegate else {
    print("FAIL: dopo capacitorDidLoad la WebView non ha più nessun navigationDelegate")
    exit(1)
}

print("S28 — il filtro sugli annullamenti, provato sul codice di produzione")

// `navigationDelegate` è `weak`: se il controller non tenesse un riferimento forte al filtro,
// qui troveremmo il delegato di Capacitor (o nil) e tutto il resto della prova sarebbe finto.
verifica("il filtro è installato e sopravvive (riferimento forte, non deallocato)",
         filtro is KVDelegatoNavigazioneFiltrante)

// MARK: - Il difetto misurato: annullamento su navigazione NON ancora cominciata

filtro.webView?(webView, didFailProvisionalNavigation: nil, withError: annullataDaAltraNavigazione)
verifica("didFailProvisionalNavigation, -999: Capacitor NON viene chiamato (niente errorPath)",
         capacitor.inoltriProvisional.isEmpty)

filtro.webView?(webView, didFailProvisionalNavigation: nil, withError: interrottaDaPolicy)
verifica("didFailProvisionalNavigation, WKError 102: Capacitor NON viene chiamato",
         capacitor.inoltriProvisional.isEmpty)

// MARK: - Il gemello scoperto in S28: navigazione GIÀ cominciata e poi annullata

filtro.webView?(webView, didFail: nil, withError: annullataDaAltraNavigazione)
verifica("didFail, -999: Capacitor NON viene chiamato (era il buco rimasto aperto)",
         capacitor.inoltriDidFail.isEmpty)

filtro.webView?(webView, didFail: nil, withError: interrottaDaPolicy)
verifica("didFail, WKError 102: Capacitor NON viene chiamato",
         capacitor.inoltriDidFail.isEmpty)

// MARK: - Il controllo positivo: senza rete la schermata offline DEVE ancora comparire

filtro.webView?(webView, didFailProvisionalNavigation: nil, withError: reteAssente)
verifica("didFailProvisionalNavigation, -1009 (rete assente): Capacitor VIENE chiamato",
         capacitor.inoltriProvisional == [-1009])

filtro.webView?(webView, didFail: nil, withError: serverIrraggiungibile)
verifica("didFail, -1004 (server irraggiungibile): Capacitor VIENE chiamato",
         capacitor.inoltriDidFail == [-1004])

// MARK: - L'inoltro trasparente non deve aver perso per strada gli altri metodi

filtro.webView?(webView, didFinish: nil)
verifica("i metodi che non trattiamo arrivano comunque a Capacitor (didFinish)",
         capacitor.inoltriDidFinish == 1)
// Controllo POSITIVO: un selettore che ha solo Capacitor deve risultare gestito dal filtro…
verifica("responds(to:) è vero per un metodo che ha solo Capacitor (didFinish)",
         filtro.responds(to: #selector(WKNavigationDelegate.webView(_:didFinish:))))
// …e controllo NEGATIVO: se `responds(to:)` dicesse sempre sì, WebKit chiamerebbe metodi che
// nessuno implementa e l'app cadrebbe con «unrecognized selector».
verifica("responds(to:) è falso per un metodo che non ha nessuno dei due",
         !filtro.responds(to: #selector(WKNavigationDelegate.webViewWebContentProcessDidTerminate(_:))))

print("")
if fallimenti.isEmpty {
    print("TUTTE VERDI: \(superate) verifiche")
    exit(0)
} else {
    print("ROSSE: \(fallimenti.count) su \(superate + fallimenti.count)")
    for f in fallimenti { print("  - \(f)") }
    exit(1)
}
