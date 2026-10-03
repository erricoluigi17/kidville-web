// FIXTURE ROSSA del lock `caricamenti-nativi-agganciati` (regola 2, Swift): un plugin a cui MANCA un metodo.
// `dimentica` è in METODI_PLUGIN_CARICAMENTI (TS) e in Java, ma qui non è né in `pluginMethods` né implementato:
// il JavaScript lo chiamerebbe e il ponte risponderebbe «metodo non implementato». Il lock deve dirlo, per nome.
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
        ]
        #if DEBUG
        metodi.append(CAPPluginMethod(name: "creaElementoDiProva", returnType: CAPPluginReturnPromise))
        #endif
        return metodi
    }()

    @objc func info(_ call: CAPPluginCall) { call.resolve([:]) }
    @objc func scegliMedia(_ call: CAPPluginCall) { call.resolve([:]) }
    @objc func annullaScelta(_ call: CAPPluginCall) { call.resolve([:]) }
    @objc func leggiFoto(_ call: CAPPluginCall) { call.resolve([:]) }
    @objc func scartaScelti(_ call: CAPPluginCall) { call.resolve([:]) }
    @objc func accodaVideo(_ call: CAPPluginCall) { call.resolve([:]) }
    @objc func elenco(_ call: CAPPluginCall) { call.resolve([:]) }
    @objc func annulla(_ call: CAPPluginCall) { call.resolve([:]) }

    #if DEBUG
    @objc func creaElementoDiProva(_ call: CAPPluginCall) { call.resolve([:]) }
    #endif

    private func inoltra() {
        notifyListeners("caricamento", data: [:])
        notifyListeners("preparazione", data: [:])
    }
}

#endif
