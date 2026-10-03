// FIXTURE del lock `caricamenti-nativi-agganciati` — VERDE per costruzione (regola 3, Swift).
// Il controller dell'app: il plugin si registra subito dopo `super.capacitorDidLoad()` e PRIMA di ogni `guard` che può uscire.
// Nel commento qui sotto compare di proposito la parola `guard`: un lock che legge i commenti la scambierebbe per un'uscita.
import Foundation
import UIKit
import WebKit
import Capacitor
import os

class KVBridgeViewController: CAPBridgeViewController {

    private let registro = Logger(subsystem: "it.kidville.app", category: "webview")

    override func capacitorDidLoad() {
        super.capacitorDidLoad()

        // Il plugin dei caricamenti: PRIMA dei `guard` che possono uscire, perché il filtro delle navigazioni non deve poterlo spegnere.
        bridge?.registerPluginInstance(KVCaricamentiPlugin())

        guard let webView = webView else {
            registro.error("filtro annullamenti NON agganciato: la WebView non esiste")
            return
        }
        guard webView.navigationDelegate != nil else {
            registro.error("filtro annullamenti NON agganciato: nessun navigationDelegate")
            return
        }
        registro.info("filtro annullamenti agganciato")
    }
}
