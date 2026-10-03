import Foundation
import UserNotifications

// ═══════════════════════════════════════════════════════════════════════════════════════════
//  KVNotificaAttesa — la notifica locale «in attesa di rete» (spec §2.1, §5.7, compito I2)
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// Perché c'è: su iOS, a app sospesa, nessun codice nostro gira finché la rete non torna, e la chiusura dal multitasking ferma tutto. Se l'invio
// di un video si è fermato per la rete l'insegnante deve poterlo SAPERE senza riaprire l'app: decisione del titolare, «Notifica locale iOS se
// l'invio si ferma».
//
// Che cosa è:
//   · UNA sola notifica, con identificativo fisso `kidville-caricamento-attesa`: una nuova prende il posto della precedente;
//   · titolo = `testi.titolo` e corpo = `testi.attesaRete` («Il video è in attesa di rete: riprenderà da solo»), passati dal JS a ogni
//     `accodaVideo` nelle due lingue; NESSUN NOME di bambino, di file o di classe, nessuna miniatura, nessun dato in `userInfo`;
//   · consegna immediata (nessun trigger) e senza suono: è un'informazione, non un allarme.
//
// Che cosa NON fa:
//   · non chiede MAI l'autorizzazione alle notifiche (è un'altra schermata, e la chiede già il percorso delle push): senza autorizzazione
//     (`getNotificationSettings`) non programma niente, e lo dice a chi la chiama (`autorizzata: false`) perché scriva
//     `notifica-locale-non-autorizzata`, UNA volta per installazione;
//   · non imposta il delegato di `UNUserNotificationCenter`: ce l'ha Capacitor (`NotificationRouter`). Per questo una notifica locale non si
//     mostra ad app in primo piano e il suo tocco apre l'app dov'era, senza instradare (§1.3, §2.2): è ciò che vogliamo.
//
// Il centro delle notifiche passa da `KVCentroNotifiche`: `UNUserNotificationCenter.current()` in un processo senza bundle (l'harness) fa
// cadere il processo, e la decisione «autorizzata o no» si prova meglio con un finto.
//
// Questo file importa `Foundation` e `UserNotifications`: si compila nell'harness.

// MARK: - Il centro delle notifiche

/// Le tre cose che servono di `UNUserNotificationCenter`. Il vero è `KVCentroNotificheSistema`.
protocol KVCentroNotifiche: AnyObject {
    func statoAutorizzazione(_ completamento: @escaping (UNAuthorizationStatus) -> Void)
    /// Programma una notifica per ORA, con quell'identificativo (sostituisce una uguale). `completamento(true)` se il sistema l'ha accettata.
    func aggiungi(identificativo: String, titolo: String, corpo: String, completamento: @escaping (Bool) -> Void)
    /// Toglie la notifica con quell'identificativo, consegnata o ancora da consegnare.
    func rimuovi(identificativo: String)
}

/// Il centro vero. Il `UNUserNotificationCenter` si prende al primo uso, non alla creazione.
final class KVCentroNotificheSistema: KVCentroNotifiche {

    private var centro: UNUserNotificationCenter { UNUserNotificationCenter.current() }

    func statoAutorizzazione(_ completamento: @escaping (UNAuthorizationStatus) -> Void) {
        centro.getNotificationSettings { impostazioni in completamento(impostazioni.authorizationStatus) }
    }

    func aggiungi(identificativo: String, titolo: String, corpo: String, completamento: @escaping (Bool) -> Void) {
        let contenuto = UNMutableNotificationContent()
        contenuto.title = titolo
        contenuto.body = corpo
        let richiesta = UNNotificationRequest(identifier: identificativo, content: contenuto, trigger: nil)
        centro.add(richiesta) { errore in completamento(errore == nil) }
    }

    func rimuovi(identificativo: String) {
        centro.removePendingNotificationRequests(withIdentifiers: [identificativo])
        centro.removeDeliveredNotifications(withIdentifiers: [identificativo])
    }
}

// MARK: - La notifica

/// Com'è andata una richiesta di notifica: `autorizzata` dice se il sistema ne lasciava mostrare una, `programmata` se è partita davvero.
struct KVEsitoNotificaAttesa: Equatable {
    var autorizzata: Bool
    var programmata: Bool
}

/// Chi mostra la notifica d'attesa. Il vero è `KVNotificaAttesa`; l'harness ne inietta uno che registra le chiamate.
protocol KVNotificatore: AnyObject {
    /// Mostra (o sostituisce) la notifica «in attesa di rete». Non chiede mai l'autorizzazione. `completamento` scatta UNA volta.
    func mostraAttesa(titolo: String, corpo: String, completamento: @escaping (KVEsitoNotificaAttesa) -> Void)
    /// Toglie la notifica d'attesa, consegnata o in arrivo. Va bene chiamarla anche se non c'è.
    func rimuoviAttesa()
}

final class KVNotificaAttesa: KVNotificatore {

    /// L'identificativo fisso: una sola notifica, sostituita.
    static let identificativo = "kidville-caricamento-attesa"

    private let centro: KVCentroNotifiche

    init(centro: KVCentroNotifiche = KVCentroNotificheSistema()) {
        self.centro = centro
    }

    /// Con quali stati di autorizzazione una notifica si può mostrare: concessa, provvisoria (arriva in silenzio nel centro notifiche),
    /// effimera (App Clip). `notDetermined` NON basta: non si chiede, quindi non c'è.
    static func autorizzata(_ stato: UNAuthorizationStatus) -> Bool {
        switch stato {
        case .authorized, .provisional, .ephemeral: return true
        case .notDetermined, .denied: return false
        @unknown default: return false
        }
    }

    func mostraAttesa(titolo: String, corpo: String, completamento: @escaping (KVEsitoNotificaAttesa) -> Void) {
        let centro = self.centro
        centro.statoAutorizzazione { stato in
            guard Self.autorizzata(stato) else {
                completamento(KVEsitoNotificaAttesa(autorizzata: false, programmata: false))
                return
            }
            centro.aggiungi(identificativo: Self.identificativo, titolo: titolo, corpo: corpo) { riuscita in
                completamento(KVEsitoNotificaAttesa(autorizzata: true, programmata: riuscita))
            }
        }
    }

    func rimuoviAttesa() {
        centro.rimuovi(identificativo: Self.identificativo)
    }
}
