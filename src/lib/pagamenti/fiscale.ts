// Regole fiscali della contabilità:
//  • tracciabilità dei pagamenti (L. 160/2019: detrazione 19% solo con metodi
//    tracciabili; i contanti, anche parziali, escludono la detrazione);
//  • marca da bollo su documenti esenti IVA art. 10 DPR 633/72 oltre € 77,47;
//  • dati struttura per ricevute/attestazioni con fallback sui dati fiscali
//    già configurati per Aruba (aruba_config.fiscal).

import { logEvento } from '@/lib/logging/logger'

export interface FiscaleConfig {
    denominazione?: string
    piva?: string
    codice_fiscale?: string
    indirizzo?: string
    cap?: string
    comune?: string
    provincia?: string
    bollo_enabled?: boolean
    bollo_soglia?: number
    bollo_importo?: number
    dicitura_bollo_ricevuta?: string
}

export interface ArubaFiscalConfig {
    fiscal?: {
        piva?: string
        cf?: string
        ragione_sociale?: string
        indirizzo?: string
        cap?: string
        comune?: string
        provincia?: string
    }
}

export interface DatiStruttura {
    denominazione: string
    piva: string
    codice_fiscale: string
    indirizzo: string
    cap: string
    comune: string
    provincia: string
}

export const BOLLO_SOGLIA_DEFAULT = 77.47
export const BOLLO_IMPORTO_DEFAULT = 2
export const DICITURA_BOLLO_DEFAULT =
    'Imposta di bollo assolta in modo virtuale (documento esente IVA art. 10 DPR 633/72 di importo superiore a € 77,47).'

// Slug di categorie che NON sono spese di istruzione detraibili: restano fuori
// dalla comunicazione AdE e dai totali detraibili delle attestazioni.
export const CATEGORIE_ESCLUSE_ADE = ['divisa', 'materiale']

const METODI_TRACCIABILI = new Set(['bonifico', 'pos', 'assegno'])

/** Il singolo metodo è tracciabile? (contanti/altro/ignoto → no) */
export function metodoTracciabile(metodo?: string | null): boolean {
    return !!metodo && METODI_TRACCIABILI.has(metodo)
}

/** Vero solo se OGNI incasso usa un metodo tracciabile (contanti/altro/ignoto escludono). */
export function isTracciabile(metodi: (string | null | undefined)[]): boolean {
    if (metodi.length === 0) return false
    return metodi.every((m) => metodoTracciabile(m))
}

/** Importo del bollo dovuto sul documento (0 se non dovuto o bollo disattivato). */
export function bolloDovuto(importo: number, cfg?: FiscaleConfig | null): number {
    if (!cfg?.bollo_enabled) return 0
    const soglia = cfg.bollo_soglia ?? BOLLO_SOGLIA_DEFAULT
    if (!(importo > soglia)) return 0
    return cfg.bollo_importo ?? BOLLO_IMPORTO_DEFAULT
}

/** Da dove arriva la richiesta, per la riga di log della config mancante. */
export interface ContestoStruttura {
    /** Nome della route/operazione: finisce nella colonna `operazione` di `app_log`. */
    operazione: string
    /** La sede di cui mancano i dati. Senza, si sa CHE manca ma non A CHI. */
    scuolaId?: string | null
}

/**
 * Dati struttura per i documenti: fiscale_config prevale, fallback su aruba_config.fiscal.
 *
 * ⚠️ CONFIGURAZIONE MANCANTE = INCIDENTE (AGENTS.md §4). Al 2026-07-31
 * `fiscale_config` è `{}` su tutte e quattro le righe di `admin_settings` e
 * `aruba_config` esiste solo per Giugliano, con `piva` e `ragione_sociale`
 * vuote: questa funzione restituisce allora sette stringhe vuote, il PDF stampa
 * l'intestazione generica al posto del nome dell'ente e omette del tutto la
 * riga fiscale — perché P.IVA e codice fiscale si stampano solo se valorizzati.
 * Il documento esce, semplicemente anonimo. È già successo almeno una volta
 * (`ricevute_emesse`: 1 riga), e non c'era un avviso da nessuna parte.
 *
 * Il comportamento NON cambia — i documenti continuano a omettere ciò che
 * manca, e non si inventa nessun dato fiscale — ma il buco adesso si vede.
 *
 * @param ctx senza, la riga di log esce comunque (con `operazione` generica):
 *   un chiamante che non passa il contesto non deve poter spegnere l'allarme.
 */
export function datiStruttura(
    fiscale?: FiscaleConfig | null,
    aruba?: ArubaFiscalConfig | null,
    ctx?: ContestoStruttura,
): DatiStruttura {
    const f = fiscale ?? {}
    const a = aruba?.fiscal ?? {}
    const dati: DatiStruttura = {
        denominazione: f.denominazione ?? a.ragione_sociale ?? '',
        piva: f.piva ?? a.piva ?? '',
        codice_fiscale: f.codice_fiscale ?? a.cf ?? '',
        indirizzo: f.indirizzo ?? a.indirizzo ?? '',
        cap: f.cap ?? a.cap ?? '',
        comune: f.comune ?? a.comune ?? '',
        provincia: f.provincia ?? a.provincia ?? '',
    }

    // Denominazione e partita IVA sono il minimo perché un documento sia
    // riconducibile a chi lo emette: se ne manca anche una sola, il documento
    // che ne esce non è utilizzabile. Nel log finiscono solo BOOLEANI e l'uuid
    // della sede — i dati fiscali non ci entrano, né servirebbero a nessuno lì.
    if (dati.denominazione.trim() === '' || dati.piva.trim() === '') {
        logEvento('fiscale', 'error', {
            operazione: ctx?.operazione ?? 'datiStruttura',
            esito: 'dati-struttura-mancanti',
            scuola_id: ctx?.scuolaId ?? '',
            denominazione_presente: dati.denominazione.trim() !== '',
            piva_presente: dati.piva.trim() !== '',
        })
    }

    return dati
}
