// Il minimo indispensabile di Capacitor per poter compilare `KVBridgeViewController.swift`
// fuori da Xcode. NON è una copia della logica di Capacitor: è solo la superficie che il
// nostro file usa (`webView` e `capacitorDidLoad()`), presa da
// `node_modules/@capacitor/ios/Capacitor/Capacitor/CAPBridgeViewController.swift`.
//
// Unica differenza voluta rispetto all'originale: là `webView` è `fileprivate(set)` e nessuno
// di fuori può assegnarla; qui è scrivibile, perché la prova deve poter iniettare una WebView
// vera. Il codice di produzione la legge soltanto, quindi la differenza non lo tocca.
//
// Se un giorno Capacitor cambiasse queste due firme, questo file smetterebbe di compilare
// insieme al vero `KVBridgeViewController.swift` — ed è il comportamento che vogliamo.

import UIKit
import WebKit

@objc open class CAPBridgeViewController: UIViewController {
    public var webView: WKWebView?
    open func capacitorDidLoad() {}
}
