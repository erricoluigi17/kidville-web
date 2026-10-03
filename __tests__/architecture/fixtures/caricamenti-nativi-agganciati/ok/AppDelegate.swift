// FIXTURE del lock `caricamenti-nativi-agganciati` — VERDE per costruzione (regola 4, iOS).
// L'AppDelegate aggancia il motore: avvio, risveglio della sessione in background, primo piano, fermo.
import UIKit
import Capacitor
#if canImport(FirebaseCore)
import FirebaseCore
#endif

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?
    private var firebaseAttivo = false

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        #if canImport(FirebaseCore)
        if Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil {
            FirebaseApp.configure()
            firebaseAttivo = true
        }
        #endif
        // Un commento con `KVMotoreCaricamenti.condiviso.avvia()` dentro: da solo non basta, la chiamata vera sta qui sotto.
        KVMotoreCaricamenti.condiviso.avvia()
        return true
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        KVMotoreCaricamenti.condiviso.notificaSeFermo()
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        KVMotoreCaricamenti.condiviso.riprendiInPrimoPiano()
    }

    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) {
        KVMotoreCaricamenti.condiviso.ricollega(identifier, completionHandler)
    }
}
