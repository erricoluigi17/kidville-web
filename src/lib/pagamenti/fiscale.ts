// Regole fiscali della contabilità:
//  • tracciabilità dei pagamenti (L. 160/2019: detrazione 19% solo con metodi
//    tracciabili; i contanti, anche parziali, escludono la detrazione);
//  • marca da bollo su documenti esenti IVA art. 10 DPR 633/72 oltre € 77,47;
//  • dati struttura per ricevute/attestazioni con fallback sui dati fiscali
//    già configurati per Aruba (aruba_config.fiscal).

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

/** Vero solo se OGNI incasso usa un metodo tracciabile (contanti/altro/ignoto escludono). */
export function isTracciabile(metodi: (string | null | undefined)[]): boolean {
    if (metodi.length === 0) return false
    return metodi.every((m) => !!m && METODI_TRACCIABILI.has(m))
}

/** Importo del bollo dovuto sul documento (0 se non dovuto o bollo disattivato). */
export function bolloDovuto(importo: number, cfg?: FiscaleConfig | null): number {
    if (!cfg?.bollo_enabled) return 0
    const soglia = cfg.bollo_soglia ?? BOLLO_SOGLIA_DEFAULT
    if (!(importo > soglia)) return 0
    return cfg.bollo_importo ?? BOLLO_IMPORTO_DEFAULT
}

/** Dati struttura per i documenti: fiscale_config prevale, fallback su aruba_config.fiscal. */
export function datiStruttura(fiscale?: FiscaleConfig | null, aruba?: ArubaFiscalConfig | null): DatiStruttura {
    const f = fiscale ?? {}
    const a = aruba?.fiscal ?? {}
    return {
        denominazione: f.denominazione ?? a.ragione_sociale ?? '',
        piva: f.piva ?? a.piva ?? '',
        codice_fiscale: f.codice_fiscale ?? a.cf ?? '',
        indirizzo: f.indirizzo ?? a.indirizzo ?? '',
        cap: f.cap ?? a.cap ?? '',
        comune: f.comune ?? a.comune ?? '',
        provincia: f.provincia ?? a.provincia ?? '',
    }
}
