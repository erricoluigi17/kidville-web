// FIXTURE del lock `caricamenti-nativi-agganciati` — VERDE per costruzione.
// La forma MINIMA di un plugin Swift agganciato come vuole la spec (§4.1, §4.3): nome, nove metodi, la prova solo in Debug.
// Non è codice dell'app: sta in `__tests__/architecture/fixtures/` e nessun progetto Xcode la compila.
//
// Questo commento nomina di proposito cose che il lock cerca nel codice vero, per provare che un lock che legge i commenti si
// immunizzerebbe da solo e questo no: `CAPPluginMethod(name: "finto", returnType: CAPPluginReturnPromise)`, `jsName = "Altro"`,
// `#if DEBUG`, `@objc func dimentica(_ call: CAPPluginCall)`, `absoluteString`, `localizedDescription`.
import Foundation
#if canImport(Capacitor)
import Capacitor
#endif

#if canImport(Capacitor)

@objc(KVCaricamentiPlugin)
public class KVCaricamentiPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "KVCaricamentiPlugin"
    public let jsName = "KidvilleCaricamenti"
    public let pluginMethods: [CAPPluginMethod] = {
        var metodi: [CAPPluginMethod] = [
            CAPPluginMethod(name: "info", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "scegliMedia", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "annullaScelta", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "leggiFoto", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "scartaScelti", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "accodaVideo", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "elenco", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "annulla", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "dimentica", returnType: CAPPluginReturnPromise),
        ]
        #if DEBUG
        metodi.append(CAPPluginMethod(name: "creaElementoDiProva", returnType: CAPPluginReturnPromise))
        #endif
        return metodi
    }()

    /// Un letterale con una doppia barra, una graffa e un'interpolazione: il lettore del lock non deve scambiarli per un commento, un blocco o codice.
    private let testoDiProva = "http://esempio.invalid/{x} \(1 + 2) // non è un commento"

    @objc func info(_ call: CAPPluginCall) { call.resolve([:]) }
    @objc func scegliMedia(_ call: CAPPluginCall) { call.resolve([:]) }
    @objc func annullaScelta(_ call: CAPPluginCall) { call.resolve([:]) }
    @objc func leggiFoto(_ call: CAPPluginCall) { call.resolve([:]) }
    @objc func scartaScelti(_ call: CAPPluginCall) { call.resolve([:]) }
    @objc func accodaVideo(_ call: CAPPluginCall) { call.resolve([:]) }
    @objc func elenco(_ call: CAPPluginCall) { call.resolve([:]) }
    @objc func annulla(_ call: CAPPluginCall) { call.resolve([:]) }
    @objc func dimentica(_ call: CAPPluginCall) { call.resolve([:]) }

    #if DEBUG
    @objc func creaElementoDiProva(_ call: CAPPluginCall) { call.resolve([:]) }
    #endif

    private func notifica(_ nome: String, _ dati: [String: Any]) {
        DispatchQueue.main.async { self.notifyListeners(nome, data: dati) }
    }

    private func inoltra() {
        notifica("caricamento", [:])
        notifica("preparazione", [:])
    }
}

#endif
