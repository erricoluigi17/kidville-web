// Aging delle scadenze: classifica i pagamenti APERTI (residuo > 0, niente
// contenitori padre) in bucket temporali rispetto a una data di riferimento.
// Conta la DATA di scadenza, non lo stato: un "da_pagare" col trigger non
// ancora girato ma scaduto ieri finisce comunque tra gli scaduti.

export type AgingBucketId = 'scaduti_oltre_30' | 'scaduti_entro_30' | 'settimana' | 'mese'

export interface AgingPagamento {
    importo: number | string
    importo_pagato?: number | string | null
    scadenza?: string | null
    stato: string
    tipo?: string | null
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

export function residuoDi(p: AgingPagamento): number {
    return Number(p.importo) - Number(p.importo_pagato || 0)
}

export function bucketDiPagamento(p: AgingPagamento, oggi: string): AgingBucketId | null {
    if (p.tipo === 'padre') return null
    if (!STATI_APERTI.has(p.stato)) return null
    if (!p.scadenza) return null
    if (residuoDi(p) <= 0) return null
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
        out[b].totale += residuoDi(r)
        out[b].items.push(r)
    }
    return out
}
