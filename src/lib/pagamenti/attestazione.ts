import { CATEGORIE_ESCLUSE_ADE, metodoTracciabile } from './fiscale'

// Attestazione annuale dei pagamenti (per il 730 del genitore): criterio di
// CASSA sull'anno solare (contano gli incassi, storni inclusi col segno).
// Il "detraibile" richiede metodo tracciabile E categoria ammessa (le spese
// non di istruzione — divise/materiale — restano fuori).

export interface VoceAttestazione {
    importo: number | string
    metodo?: string | null
    categoria_slug?: string | null
    descrizione?: string | null
}

export interface RigaAttestazione {
    descrizione: string
    categoria: string | null
    importo: number
    tracciabile: boolean
    escluso: boolean
}

export interface RiepilogoAttestazione {
    versato: number
    detraibile: number
    nonTracciabile: number
    escluso: number
    righe: RigaAttestazione[]
}

const round2 = (n: number) => Math.round(n * 100) / 100

export function calcolaAttestazione(voci: VoceAttestazione[]): RiepilogoAttestazione {
    let versato = 0
    let detraibile = 0
    let nonTracciabile = 0
    let escluso = 0
    const byDescrizione = new Map<string, RigaAttestazione>()

    for (const v of voci) {
        const importo = Number(v.importo)
        if (Number.isNaN(importo)) continue
        versato += importo
        const isEscluso = !!v.categoria_slug && CATEGORIE_ESCLUSE_ADE.includes(v.categoria_slug)
        const tracc = metodoTracciabile(v.metodo)
        if (isEscluso) escluso += importo
        else if (tracc) detraibile += importo
        else nonTracciabile += importo

        const key = v.descrizione || '—'
        const riga = byDescrizione.get(key) ?? {
            descrizione: key,
            categoria: v.categoria_slug ?? null,
            importo: 0,
            tracciabile: true,
            escluso: isEscluso,
        }
        riga.importo = round2(riga.importo + importo)
        riga.tracciabile = riga.tracciabile && tracc
        byDescrizione.set(key, riga)
    }

    return {
        versato: round2(versato),
        detraibile: round2(detraibile),
        nonTracciabile: round2(nonTracciabile),
        escluso: round2(escluso),
        righe: [...byDescrizione.values()],
    }
}
