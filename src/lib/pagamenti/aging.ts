// Fonte unica di stato e residuo dei pagamenti (slice S1 — Contabilità v2).
// Aging delle scadenze: classifica i pagamenti APERTI (residuo > 0, niente
// contenitori padre) in bucket temporali rispetto a una data di riferimento.
// Conta la DATA di scadenza, non lo stato: un "da_pagare" col trigger non
// ancora girato ma scaduto ieri finisce comunque tra gli scaduti.

export type AgingBucketId = 'scaduti_oltre_30' | 'scaduti_entro_30' | 'settimana' | 'mese'

export interface AgingPagamento {
    importo: number | string
    importo_pagato?: number | string | null
    /** Sconto/abbuono sulla voce (Contabilità v2). Assente sui DB non migrati → vale 0. */
    sconto?: number | string | null
    scadenza?: string | null
    stato: string
    tipo?: string | null
}

/** Come AgingPagamento ma con i campi derivati che il GET /api/pagamenti già
 *  calcola server-side. Quando presenti sono la fonte autorevole (stessa "oggi"
 *  del server); in loro assenza (risposte vecchie) si ricalcola client-side. */
export interface AgingPagamentoDerivato extends AgingPagamento {
    stato_effettivo?: string | null
    residuo?: number | string | null
}

export interface AgingBucket<T> { count: number; totale: number; items: T[] }

export const AGING_LABEL: Record<AgingBucketId, string> = {
    scaduti_oltre_30: 'Scaduti oltre 30gg',
    scaduti_entro_30: 'Scaduti fino a 30gg',
    settimana: 'Questa settimana',
    mese: 'Prossimi 30gg',
}

const STATI_APERTI = new Set(['da_pagare', 'parziale', 'scaduto'])
const MS_GIORNO = 86_400_000

/**
 * Residuo EFFETTIVO di una voce: importo − sconto − già incassato, **clampato a 0**.
 * Il clamp è la chiave: un sovraincasso (residuo negativo) non deve mai emergere
 * come credito che compensa un'altra voce scaduta (finding #1 della home genitore).
 */
export function residuoEffettivo(p: AgingPagamento): number {
    return Math.max(0, Number(p.importo) - Number(p.sconto || 0) - Number(p.importo_pagato || 0))
}

/** Alias storico mantenuto per compatibilità con i consumatori esistenti. */
export const residuoDi = residuoEffettivo

/**
 * Stato EFFETTIVO derivato SEMPRE dalle date (fonte unica ovunque):
 *  • 'pagato' se il residuo è 0 (e non è un contenitore 'padre': i padre non si
 *    "saldano" da sé, sono la somma delle rate figlie);
 *  • 'scaduto' se resta residuo e la scadenza (giorno) è nel passato — anche se
 *    lo stato scritto in DB è ancora 'da_pagare' (la transizione via cron non è
 *    schedulata: senza questo ramo l'allarme comparirebbe in ritardo);
 *  • altrimenti lo stato memorizzato in DB.
 */
export function statoEffettivo(p: AgingPagamento, oggi: string): string {
    const residuo = residuoEffettivo(p)
    if (residuo === 0 && p.tipo !== 'padre') return 'pagato'
    if (residuo > 0 && !!p.scadenza && p.scadenza.slice(0, 10) < oggi) return 'scaduto'
    return p.stato
}

/**
 * Un pagamento è "moroso" se ha residuo effettivo > 0 e lo stato effettivo è
 * 'scaduto'. I contenitori 'padre' non sono mai morosi in sé: lo sono le rate figlie.
 */
export function isMoroso(p: AgingPagamento, oggi: string): boolean {
    if (p.tipo === 'padre') return false
    if (residuoEffettivo(p) <= 0) return false
    return statoEffettivo(p, oggi) === 'scaduto'
}

export function bucketDiPagamento(p: AgingPagamento, oggi: string): AgingBucketId | null {
    if (p.tipo === 'padre') return null
    if (!STATI_APERTI.has(p.stato)) return null
    if (!p.scadenza) return null
    if (residuoEffettivo(p) <= 0) return null
    const giorni = Math.round((Date.parse(p.scadenza.slice(0, 10)) - Date.parse(oggi)) / MS_GIORNO)
    if (Number.isNaN(giorni)) return null
    if (giorni < 0) return giorni < -30 ? 'scaduti_oltre_30' : 'scaduti_entro_30'
    if (giorni <= 7) return 'settimana'
    if (giorni <= 30) return 'mese'
    return null
}

export function bucketScadenze<T extends AgingPagamento>(rows: T[], oggi: string): Record<AgingBucketId, AgingBucket<T>> {
    const out: Record<AgingBucketId, AgingBucket<T>> = {
        scaduti_oltre_30: { count: 0, totale: 0, items: [] },
        scaduti_entro_30: { count: 0, totale: 0, items: [] },
        settimana: { count: 0, totale: 0, items: [] },
        mese: { count: 0, totale: 0, items: [] },
    }
    for (const r of rows) {
        const b = bucketDiPagamento(r, oggi)
        if (!b) continue
        out[b].count += 1
        out[b].totale += residuoEffettivo(r)
        out[b].items.push(r)
    }
    return out
}

// ─── Tri-stato della home genitore (fonte unica per PagamentiSummary) ─────────

export type StatoHome = 'rosso' | 'ambra' | 'verde'

export interface RiepilogoHome {
    stato: StatoHome
    /** Σ residui effettivi delle SOLE voci con stato effettivo 'scaduto'. */
    scaduto: number
    /** Σ residui effettivi delle altre voci ancora aperte (non scadute). */
    daPagare: number
}

/**
 * Riepilogo tri-stato della home genitore con **clamp per voce, mai compensazioni**:
 *  – scaduto  = somma dei residui effettivi delle voci scadute;
 *  – daPagare = somma dei residui effettivi delle altre voci aperte;
 *  – ROSSO se scaduto>0, AMBRA se solo daPagare>0, VERDE solo a residui tutti zero.
 * Esclude i contenitori 'padre'. Se la riga porta i campi derivati del GET
 * (stato_effettivo/residuo) usa quelli, altrimenti ricalcola da aging.ts.
 */
export function riepilogoHome(rows: AgingPagamentoDerivato[], oggi: string): RiepilogoHome {
    let scaduto = 0
    let daPagare = 0
    for (const r of rows) {
        if (r.tipo === 'padre') continue
        const derivato = r.residuo == null ? NaN : Number(r.residuo)
        const residuo = Number.isFinite(derivato) ? Math.max(0, derivato) : residuoEffettivo(r)
        if (residuo <= 0) continue
        const stato = r.stato_effettivo ?? statoEffettivo(r, oggi)
        if (stato === 'scaduto') scaduto += residuo
        else daPagare += residuo
    }
    const stato: StatoHome = scaduto > 0 ? 'rosso' : daPagare > 0 ? 'ambra' : 'verde'
    return { stato, scaduto, daPagare }
}
