import Foundation
import os
import Security

// ═══════════════════════════════════════════════════════════════════════════════════════════
//  KVSegretiCaricamenti — i segreti dei caricamenti nativi nel Portachiavi (spec §2.2, §4.6, §5.1, §9, compito I2)
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// Che cosa c'è qui dentro, per ogni job, e PERCHÉ qui e non in `coda.json`:
//   · il TOKEN di rinnovo (`kvr_…`): per 48 ore è l'unica credenziale con cui il telefono, senza nessuna sessione, può chiedere un URL
//     nuovo (`POST /api/video-uploads/rinnovo`). Rubarlo dà al più un URL di caricamento per QUEL percorso (spec PR 2 §6.2);
//   · l'URL FIRMATO della PUT: una credenziale di due ore, stessa custodia del token;
//   · il `content-type` che il server ha dichiarato per quella PUT (con l'URL cambia a ogni rinnovo: sta insieme all'URL);
//   · l'indirizzo del rinnovo (`rinnovo.url`): non è un segreto, ma `coda.json` ha i campi di §4.6 e nessun altro, e dopo che l'app è
//     stata uccisa e riaperta il motore deve saper dove chiedere. Sta con gli altri, che si cancellano insieme.
// La coda (`KVCodaCaricamenti`) NON ha mai un token né un URL: il file è nella cartella privata, ma un file è un file; il Portachiavi è fatto per questo.
//
// ─── COME SONO CUSTODITI ─────────────────────────────────────────────────────────────────────
// Un elemento `kSecClassGenericPassword` per job, servizio `it.kidville.app.caricamenti`, account = il `jobId` in minuscolo, accessibilità
// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`:
//   · `AfterFirstUnlock` perché il motore deve poter leggere il token e l'URL quando il sistema risveglia l'app a telefono BLOCCATO (è
//     proprio lo scenario che ci interessa); `WhenUnlocked` lo renderebbe illeggibile lì. Prima del primo sblocco dopo un riavvio il
//     Portachiavi risponde `errSecInteractionNotAllowed`: NON è un'assenza (`nonDisponibili`), e il motore aspetta invece di fallire;
//   · `ThisDeviceOnly` perché un backup o un telefono nuovo non portano con sé una credenziale legata a un file che non c'è più;
//   · non sincronizzabile con iCloud (`kSecAttrSynchronizable` = `false`).
// I segreti si cancellano a OGNI stato terminale, e la pulizia toglie quelli che non hanno più una voce (`tuttiIJob`).
//
// ─── PER PROVARLO ────────────────────────────────────────────────────────────────────────────
// Un binario Catalyst non firmato (l'harness `ios/prove/caricamenti`) non può usare il Portachiavi (`-34018`, nessun entitlement), e
// non si deve inventare un finto che cambi il codice che gira nell'app: le quattro chiamate di sistema (`SecItemAdd`, `…CopyMatching`,
// `…Update`, `…Delete`) passano da `KVOperazioniSicurezza`, e l'harness ne inietta una versione in memoria che si comporta come il vero
// (duplicati, assenze, «non adesso») e registra le query, per provare che gli attributi sono quelli giusti. Il Portachiavi VERO si prova
// nel simulatore (`ios/prove/caricamenti/esegui-simulatore.sh`).
//
// Questo file importa `Foundation`, `os` e `Security`: si compila nell'harness.

// MARK: - Ciò che si custodisce

/// I segreti di UN job. Si salva come JSON in un solo elemento del Portachiavi.
struct KVSegretiVoce: Codable, Equatable {
    /// Il token di rinnovo (`kvr_…`), che va nell'intestazione `x-kidville-rinnovo` e MAI altrove.
    var token: String
    /// L'URL firmato della PUT: vale due ore dal momento in cui è stato firmato.
    var urlPut: String
    /// Il `content-type` che il server vuole su quella PUT (l'unica intestazione che si manda).
    var contentType: String
    /// Dove chiedere un URL nuovo: `<origine>/api/video-uploads/rinnovo`.
    var urlRinnovo: String
}

/// Com'è andata la lettura dei segreti di un job.
enum KVEsitoLetturaSegreti: Equatable {
    case presenti(KVSegretiVoce)
    /// Non c'è niente per quel job (mai salvati, o già cancellati), oppure c'è ma non si legge come ci aspettiamo: da qui non si va avanti.
    case assenti
    /// Il Portachiavi non risponde ADESSO (telefono riavviato e non ancora sbloccato, servizio non disponibile): non vuol dire che i segreti
    /// non ci siano. Il motore aspetta e riprova; non chiude la voce.
    case nonDisponibili(KVErroreSistema)
}

/// Dove stanno i segreti. Il vero è `KVPortachiavi`; l'harness ne inietta uno in memoria per provare il motore.
protocol KVDepositoSegreti: AnyObject {
    func leggi(_ job: UUID) -> KVEsitoLetturaSegreti
    /// Salva (o sostituisce, e così si ruota il token) i segreti di un job. `nil` se è riuscito, altrimenti l'errore di sistema.
    @discardableResult
    func salva(_ segreti: KVSegretiVoce, per job: UUID) -> KVErroreSistema?
    /// Cancella i segreti di un job. Un job che non c'è è come uno cancellato: `nil`.
    @discardableResult
    func elimina(_ job: UUID) -> KVErroreSistema?
    /// Tutti i job che hanno dei segreti, o `nil` se non si riesce a elencarli (e in quel caso la pulizia NON toglie niente).
    func tuttiIJob() -> Set<UUID>?
}

// MARK: - Le quattro chiamate di sistema

/// Le quattro chiamate del Portachiavi che usiamo, come valori: così un'altra implementazione (quella dell'harness) prende il loro posto senza
/// cambiare una riga di `KVPortachiavi`.
struct KVOperazioniSicurezza {
    var aggiungi: (_ attributi: CFDictionary) -> OSStatus
    var cerca: (_ query: CFDictionary, _ risultato: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus
    var aggiorna: (_ query: CFDictionary, _ nuoviAttributi: CFDictionary) -> OSStatus
    var cancella: (_ query: CFDictionary) -> OSStatus

    /// Il Portachiavi vero.
    static let sistema = KVOperazioniSicurezza(
        aggiungi: { SecItemAdd($0, nil) },
        cerca: { SecItemCopyMatching($0, $1) },
        aggiorna: { SecItemUpdate($0, $1) },
        cancella: { SecItemDelete($0) }
    )
}

// MARK: - Il Portachiavi

final class KVPortachiavi: KVDepositoSegreti {

    /// Il servizio sotto cui stanno tutti gli elementi (§4.6: la pulizia elenca per questo nome).
    static let servizio = "it.kidville.app.caricamenti"

    private let servizio: String
    private let sicurezza: KVOperazioniSicurezza
    private let diagnostica = Logger(subsystem: Bundle.main.bundleIdentifier ?? "it.kidville.app", category: "caricamenti-segreti")

    init(servizio: String = KVPortachiavi.servizio, sicurezza: KVOperazioniSicurezza = .sistema) {
        self.servizio = servizio
        self.sicurezza = sicurezza
    }

    /// Gli attributi che identificano l'elemento di un job (e, senza `account`, tutti quelli del servizio).
    private func identita(_ job: UUID?) -> [String: Any] {
        var attributi: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: servizio,
            kSecAttrSynchronizable as String: false,
        ]
        if let job = job { attributi[kSecAttrAccount as String] = KVPoliticaCaricamento.uuidPerIlPonte(job) }
        return attributi
    }

    private func errore(_ stato: OSStatus) -> KVErroreSistema {
        return KVErroreSistema(dominio: .altro, codice: Int(stato))
    }

    func leggi(_ job: UUID) -> KVEsitoLetturaSegreti {
        var query = identita(job)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var risultato: CFTypeRef?
        let stato = sicurezza.cerca(query as CFDictionary, &risultato)
        switch stato {
        case errSecSuccess:
            guard let dati = risultato as? Data,
                  let segreti = try? JSONDecoder().decode(KVSegretiVoce.self, from: dati),
                  Self.segretiValidi(segreti) else {
                diagnostica.error("segreti presenti ma illeggibili: si trattano come assenti")
                return .assenti
            }
            return .presenti(segreti)
        case errSecItemNotFound:
            return .assenti
        default:
            diagnostica.error("lettura dei segreti fallita: codice \(Int(stato), privacy: .public)")
            return .nonDisponibili(errore(stato))
        }
    }

    @discardableResult
    func salva(_ segreti: KVSegretiVoce, per job: UUID) -> KVErroreSistema? {
        guard Self.segretiValidi(segreti) else { return errore(errSecParam) }
        let codificatore = JSONEncoder()
        codificatore.outputFormatting = [.sortedKeys]
        guard let dati = try? codificatore.encode(segreti) else { return errore(errSecParam) }

        var nuovo = identita(job)
        nuovo[kSecValueData as String] = dati
        nuovo[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        var stato = sicurezza.aggiungi(nuovo as CFDictionary)
        if stato == errSecDuplicateItem {
            // Il job c'è già (apertura ripetuta, rinnovo): si sostituisce il contenuto, e si riapplica l'accessibilità.
            let cambi: [String: Any] = [
                kSecValueData as String: dati,
                kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            ]
            stato = sicurezza.aggiorna(identita(job) as CFDictionary, cambi as CFDictionary)
        }
        guard stato == errSecSuccess else {
            diagnostica.error("salvataggio dei segreti fallito: codice \(Int(stato), privacy: .public)")
            return errore(stato)
        }
        return nil
    }

    @discardableResult
    func elimina(_ job: UUID) -> KVErroreSistema? {
        let stato = sicurezza.cancella(identita(job) as CFDictionary)
        guard stato == errSecSuccess || stato == errSecItemNotFound else {
            diagnostica.error("cancellazione dei segreti fallita: codice \(Int(stato), privacy: .public)")
            return errore(stato)
        }
        return nil
    }

    func tuttiIJob() -> Set<UUID>? {
        var query = identita(nil)
        query[kSecReturnAttributes as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitAll
        var risultato: CFTypeRef?
        let stato = sicurezza.cerca(query as CFDictionary, &risultato)
        if stato == errSecItemNotFound { return [] }
        guard stato == errSecSuccess, let elementi = risultato as? [[String: Any]] else {
            diagnostica.error("elenco dei segreti fallito: codice \(Int(stato), privacy: .public)")
            return nil
        }
        // Un account che non è un uuid non è nostro: non lo si nomina (la pulizia non deve poterlo cancellare).
        return Set(elementi.compactMap { ($0[kSecAttrAccount as String] as? String).flatMap { UUID(uuidString: $0) } })
    }

    /// I segreti hanno senso: nessun campo vuoto, nessun carattere di controllo (il token finisce in un'intestazione), e le due URL sono URL.
    static func segretiValidi(_ segreti: KVSegretiVoce) -> Bool {
        func pulito(_ testo: String, massimo: Int) -> Bool {
            return !testo.isEmpty && testo.utf8.count <= massimo
                && !testo.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F })
        }
        return pulito(segreti.token, massimo: 512)
            && pulito(segreti.urlPut, massimo: KVPoliticaCaricamento.lunghezzaMassimaIndirizzo)
            && pulito(segreti.urlRinnovo, massimo: KVPoliticaCaricamento.lunghezzaMassimaIndirizzo)
            && KVPoliticaCaricamento.contentTypeAmmesso(segreti.contentType)
    }
}
