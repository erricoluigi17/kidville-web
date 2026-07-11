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
    const byDescrizione = new Map<string, RigaAttestazione>()

    // Aggregazione per descrizione sul NETTO (gli storni entrano col segno). La
    // voce è tracciabile solo se OGNI incasso lo è: anche un contante di storno
    // rende non detraibile l'intera voce (coerente con isTracciabile()).
    for (const v of voci) {
        const importo = Number(v.importo)
        if (Number.isNaN(importo)) continue
        versato += importo
        const isEscluso = !!v.categoria_slug && CATEGORIE_ESCLUSE_ADE.includes(v.categoria_slug)
        const tracc = metodoTracciabile(v.metodo)

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
        riga.escluso = riga.escluso || isEscluso
        byDescrizione.set(key, riga)
    }

    // Classificazione DOPO l'aggregazione, sul netto per voce: così uno storno
    // non tracciabile compensa il detraibile dell'incasso che rettifica, invece
    // di gonfiare separatamente detraibile e nonTracciabile (#9).
    let detraibile = 0
    let nonTracciabile = 0
    let escluso = 0
    for (const riga of byDescrizione.values()) {
        if (riga.escluso) escluso += riga.importo
        else if (riga.tracciabile) detraibile += riga.importo
        else nonTracciabile += riga.importo
    }

    return {
        versato: round2(versato),
        detraibile: round2(detraibile),
        nonTracciabile: round2(nonTracciabile),
        escluso: round2(escluso),
        righe: [...byDescrizione.values()],
    }
}
