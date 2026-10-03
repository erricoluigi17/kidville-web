// La prova del Portachiavi VERO (`KVPortachiavi` con `KVOperazioniSicurezza.sistema`), che gira nel SIMULATORE (compito I2).
//
// Perché sta qui e non nell'harness: un binario Catalyst non firmato non può usare il Portachiavi (`errSecMissingEntitlement`, -34018), così
// l'harness prova i segreti con le quattro chiamate di sistema iniettate (`SicurezzaFinta`). Quella finta dice che il CODICE costruisce le query
// che vogliamo; non dice che il Portachiavi VERO le accetti e le capisca come crediamo (`kSecMatchLimitAll` con `kSecReturnAttributes`,
// l'aggiornamento di un duplicato, l'accessibilità `AfterFirstUnlockThisDeviceOnly`, l'esclusione dalla sincronizzazione). Qui si guarda.
//
// Gira dentro un simulatore avviato (`esegui-simulatore.sh`), con gli entitlement incorporati nel binario. Non tocca gli elementi dell'app vera:
// ogni giro usa un SERVIZIO proprio (`it.kidville.app.caricamenti.prova-<uuid>`) e lo ripulisce, e il gruppo di accesso del binario di prova non è
// quello dell'app.
//
// Non si può provare qui: il Portachiavi che risponde «non adesso» (`errSecInteractionNotAllowed`, telefono riavviato e non ancora sbloccato).
// Quel ramo lo prova l'harness con `SicurezzaFinta.statoForzato`; la prova vera è la prova sul campo.

import Foundation
import Security

@main
enum ProvaSimulatore {

    static var riuscite = 0
    static var fallimenti: [String] = []

    static func verifica(_ descrizione: String, _ condizione: @autoclosure () -> Bool, _ dettaglio: @autoclosure () -> String = "") {
        if condizione() {
            riuscite += 1
        } else {
            fallimenti.append(descrizione)
            let extra = dettaglio()
            print("  FAIL \(descrizione)" + (extra.isEmpty ? "" : "\n         \(extra)"))
        }
    }

    static func sezione(_ titolo: String) { print("▸ \(titolo)") }

    static func uuid(_ n: Int) -> UUID { UUID(uuidString: String(format: "abcdef12-3456-4abc-9def-%012ld", n))! }

    static func segreti(_ n: Int, token: String = "kvr_aaaaaaaaaaaaaaaaaaaaaaaa", firma: String = "a") -> KVSegretiVoce {
        return KVSegretiVoce(token: token,
                             urlPut: "https://abcdefghij.supabase.co/storage/v1/object/upload/sign/video_originals/utente/job\(n).mov?token=firma-\(firma)",
                             contentType: "video/quicktime", urlRinnovo: "https://app.kidville.it/api/video-uploads/rinnovo")
    }

    /// Gli attributi di un elemento del servizio, come li vede il Portachiavi vero.
    static func attributi(servizio: String, account: String) -> [String: Any]? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: servizio,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var risultato: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &risultato) == errSecSuccess else { return nil }
        return risultato as? [String: Any]
    }

    /// Mette a mano un elemento nel servizio (un account che non è un uuid, o un contenuto che non è un JSON dei nostri).
    @discardableResult
    static func semina(servizio: String, account: String, dati: Data) -> OSStatus {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: servizio,
            kSecAttrAccount as String: account,
            kSecValueData as String: dati,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        return SecItemAdd(q as CFDictionary, nil)
    }

    static func pulisci(servizio: String) {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: servizio,
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
        ]
        SecItemDelete(q as CFDictionary)
    }

    static func main() {
        let servizio = "it.kidville.app.caricamenti.prova-\(UUID().uuidString.lowercased())"
        let altroServizio = servizio + "-altro"
        defer { pulisci(servizio: servizio); pulisci(servizio: altroServizio) }
        let portachiavi = KVPortachiavi(servizio: servizio)

        sezione("Portachiavi VERO — salva, rileggi, sostituisci (token ruotato), cancella")
        verifica("(setup) il simulatore ci lascia usare il Portachiavi (un elemento di prova si aggiunge)", semina(servizio: altroServizio, account: "setup", dati: Data("x".utf8)) == errSecSuccess,
                 "se qui è -34018 mancano gli entitlement incorporati: vedi esegui-simulatore.sh")
        verifica("un job mai salvato: assenti", portachiavi.leggi(uuid(1)) == .assenti)
        verifica("salva: nessun errore", portachiavi.salva(segreti(1), per: uuid(1)) == nil)
        verifica("rileggi: gli stessi segreti", portachiavi.leggi(uuid(1)) == .presenti(segreti(1)))
        let elemento = attributi(servizio: servizio, account: uuid(1).uuidString.lowercased())
        verifica("l'elemento sta sotto l'account `jobId` minuscolo e il servizio dei caricamenti", elemento != nil)
        verifica("accessibile dopo il primo sblocco, SOLO su questo telefono (`AfterFirstUnlockThisDeviceOnly`)",
                 (elemento?[kSecAttrAccessible as String] as? String) == (kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String),
                 "accessibilità vera: \(String(describing: elemento?[kSecAttrAccessible as String]))")
        verifica("non sincronizzato con iCloud", (elemento?[kSecAttrSynchronizable as String] as? NSNumber).map { $0.boolValue == false } ?? true,
                 "sincronizzazione vera: \(String(describing: elemento?[kSecAttrSynchronizable as String]))")
        verifica("un solo elemento in tutto per quel job", portachiavi.tuttiIJob() == [uuid(1)])

        verifica("salva di nuovo lo stesso job (token ruotato): nessun errore, si sostituisce", portachiavi.salva(segreti(1, token: "kvr_bbbbbbbbbbbbbbbbbbbbbbbb", firma: "n"), per: uuid(1)) == nil)
        verifica("… e si legge il contenuto NUOVO", portachiavi.leggi(uuid(1)) == .presenti(segreti(1, token: "kvr_bbbbbbbbbbbbbbbbbbbbbbbb", firma: "n")))
        verifica("… sempre UN elemento, non due", portachiavi.tuttiIJob() == [uuid(1)])
        let dopoAggiornamento = attributi(servizio: servizio, account: uuid(1).uuidString.lowercased())
        verifica("… e l'accessibilità resta quella (l'aggiornamento non l'ha cambiata)",
                 (dopoAggiornamento?[kSecAttrAccessible as String] as? String) == (kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String))

        verifica("cancella: nessun errore", portachiavi.elimina(uuid(1)) == nil)
        verifica("… e il job non c'è più", portachiavi.leggi(uuid(1)) == .assenti)
        verifica("cancellare un job che non c'è non è un errore", portachiavi.elimina(uuid(1)) == nil)
        verifica("l'elenco, senza elementi, è VUOTO (non «non riuscito»)", portachiavi.tuttiIJob() == [])

        sezione("Portachiavi VERO — elenco dei job: solo i nostri, e solo di questo servizio")
        for n in 2...4 { verifica("salva il job \(n)", portachiavi.salva(segreti(n), per: uuid(n)) == nil) }
        verifica("(setup) un elemento dello stesso servizio il cui account non è un uuid (non è nostro)", semina(servizio: servizio, account: "non-un-uuid", dati: Data("{}".utf8)) == errSecSuccess)
        verifica("(setup) un job di un ALTRO servizio", semina(servizio: altroServizio, account: uuid(9).uuidString.lowercased(), dati: Data("{}".utf8)) == errSecSuccess)
        verifica("l'elenco ha i tre job e basta (né l'account che non è un uuid, né quello dell'altro servizio)", portachiavi.tuttiIJob() == [uuid(2), uuid(3), uuid(4)],
                 "elenco vero: \(String(describing: portachiavi.tuttiIJob()))")
        verifica("cancellare un job non tocca gli altri", portachiavi.elimina(uuid(3)) == nil && portachiavi.tuttiIJob() == [uuid(2), uuid(4)])
        verifica("… né l'elemento che non è nostro (c'è ancora)", attributi(servizio: servizio, account: "non-un-uuid") != nil)
        verifica("… né quello dell'altro servizio", attributi(servizio: altroServizio, account: uuid(9).uuidString.lowercased()) != nil)
        verifica("un servizio con un altro nome non vede i job di questo", KVPortachiavi(servizio: altroServizio).leggi(uuid(2)) == .assenti)

        sezione("Portachiavi VERO — ciò che non si salva, e ciò che si trova e non è nostro")
        var conAcapo = segreti(5)
        conAcapo.token = "kvr_a\r\nx-upsert: true"
        verifica("salva con un a capo nel token (finirebbe in un'intestazione): errore, e niente nel Portachiavi",
                 portachiavi.salva(conAcapo, per: uuid(5)) != nil && attributi(servizio: servizio, account: uuid(5).uuidString.lowercased()) == nil)
        verifica("un contenuto che non è un JSON dei nostri, trovato sotto un job: si tratta da assente (non si fida di ciò che non ha scritto lui)",
                 semina(servizio: servizio, account: uuid(6).uuidString.lowercased(), dati: Data("non json".utf8)) == errSecSuccess && portachiavi.leggi(uuid(6)) == .assenti)
        var lungo = segreti(7)
        lungo.urlPut += "&x=" + String(repeating: "a", count: 1500)
        verifica("un URL lungo (1.600 caratteri) si salva e si rilegge intero", portachiavi.salva(lungo, per: uuid(7)) == nil && portachiavi.leggi(uuid(7)) == .presenti(lungo))

        let totale = riuscite + fallimenti.count
        print("")
        if fallimenti.isEmpty {
            print("TUTTE VERDI nel simulatore: \(riuscite) verifiche sul Portachiavi vero")
        } else {
            print("ROSSE nel simulatore: \(fallimenti.count) su \(totale)")
            for f in fallimenti { print("  - \(f)") }
            exit(1)
        }
    }
}
