// Solleciti di pagamento: configurazione a 3 livelli con template, funzioni
// PURE per il rendering e la scelta del livello. L'invio effettivo vive nelle
// route (email + push), il log in tabella `solleciti`.

export interface LivelloSollecito {
    giorni_da_scadenza: number
    oggetto: string
    testo: string
}

export interface SollecitiConfig {
    enabled?: boolean
    cadenza_min_giorni?: number
    livelli?: Partial<LivelloSollecito>[]
}

export const DEFAULT_LIVELLI: LivelloSollecito[] = [
    {
        giorni_da_scadenza: 3,
        oggetto: 'Promemoria pagamento — {descrizione}',
        testo:
            'Gentile famiglia di {alunno},\n\nvi ricordiamo che risulta ancora da saldare "{descrizione}" ' +
            'con scadenza {scadenza}: importo residuo {residuo}.\n\nSe avete già provveduto al pagamento, ' +
            'vi preghiamo di ignorare questo messaggio.\n\n{scuola}',
    },
    {
        giorni_da_scadenza: 10,
        oggetto: 'Sollecito di pagamento — {descrizione}',
        testo:
            'Gentile famiglia di {alunno},\n\nnon risulta ancora saldato "{descrizione}" scaduto il {scadenza} ' +
            'da {giorni_ritardo} giorni: importo residuo {residuo}.\n\nVi invitiamo a regolarizzare la posizione ' +
            'in segreteria o tramite bonifico.\n\n{scuola}',
    },
    {
        giorni_da_scadenza: 20,
        oggetto: 'Secondo sollecito — {descrizione}',
        testo:
            'Gentile famiglia di {alunno},\n\nnonostante il precedente sollecito, "{descrizione}" risulta ancora ' +
            'insoluto da {giorni_ritardo} giorni (residuo {residuo}, scadenza {scadenza}).\n\nVi chiediamo di ' +
            'contattare la segreteria al più presto per regolarizzare la posizione.\n\n{scuola}',
    },
]

export const DEFAULT_SOLLECITI_CONFIG = {
    enabled: false,
    cadenza_min_giorni: 7,
    livelli: DEFAULT_LIVELLI,
}

/** Livelli effettivi: la config sovrascrive per-indice, i default coprono i buchi. */
export function livelliEffettivi(cfg?: SollecitiConfig | null): LivelloSollecito[] {
    return DEFAULT_LIVELLI.map((def, i) => ({ ...def, ...(cfg?.livelli?.[i] ?? {}) }))
}

/** Sostituisce i segnaposto {chiave}; le chiavi ignote restano intatte. */
export function renderTemplate(testo: string, ctx: Record<string, string | number>): string {
    return testo.replace(/\{([a-z_]+)\}/g, (match, chiave: string) =>
        chiave in ctx ? String(ctx[chiave]) : match,
    )
}

/**
 * Prossimo livello da inviare: sempre sequenziale (mai saltare), solo se il
 * ritardo ha raggiunto la soglia del livello. `null` = niente da inviare.
 */
export function prossimoLivello(
    cfg: SollecitiConfig | null | undefined,
    giorniRitardo: number,
    maxGiaInviato: number,
): number | null {
    const livelli = livelliEffettivi(cfg)
    const next = maxGiaInviato + 1
    if (next > livelli.length) return null
    return giorniRitardo >= livelli[next - 1].giorni_da_scadenza ? next : null
}
