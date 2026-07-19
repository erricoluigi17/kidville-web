// Causale consigliata per il bonifico. Un MODELLO a segnaposto, personalizzabile
// per categoria di pagamento (pannello Contabilità → Causali). Il modello viene
// reso coi dati del pagamento: «{descrizione} - per il minore {nome_completo} -
// {codice_fiscale} - {sede}» (predefinito). Scrivere questa causale rende univoco
// l'abbinamento automatico dei bonifici (riconciliazione). Il CF del minore va
// SOLO al genitore (card «Copia» + email di sollecito), MAI nei log.
//
// Funzioni PURE, senza I/O: condivise da UI genitore, solleciti e anteprima admin.

export interface DatiCausale {
    descrizione?: string | null
    nome?: string | null
    cognome?: string | null
    codiceFiscale?: string | null
    sede?: string | null
    /** Mese di competenza in lettere it-IT (es. «settembre»), da periodo_competenza. */
    mese?: string | null
    /** Anno di competenza (es. «2026»). */
    anno?: string | number | null
    /** Importo già formattato it-IT (es. «€ 150,00»). */
    importo?: string | null
    /** Scadenza già formattata it-IT (es. «30/09/2026»). */
    scadenza?: string | null
}

/** «Nome Cognome» ripulito: niente spazi doppi né «undefined» da campi assenti. */
export function nomeCompleto({ nome, cognome }: Pick<DatiCausale, 'nome' | 'cognome'>): string {
    return [nome, cognome]
        .map((s) => (s ?? '').trim())
        .filter(Boolean)
        .join(' ')
}

/** true se il CF è presente e non vuoto (dopo trim). */
export function haCodiceFiscale(cf?: string | null): boolean {
    return !!(cf && cf.trim())
}

/**
 * Nome sede per la causale: MAIUSCOLO, senza il prefisso «Kidville».
 * «Kidville Giugliano» → «GIUGLIANO». Vuoto/assente → «».
 */
export function sedeCausale(nome?: string | null): string {
    return (nome ?? '').trim().toUpperCase().replace(/^KIDVILLE\s+/, '').trim()
}

/** Modello PREDEFINITO (retro-compatibile con la causale storica). */
export const DEFAULT_CAUSALE_TEMPLATE = '{descrizione} - per il minore {nome_completo} - {codice_fiscale} - {sede}'

/** Segnaposto disponibili per l'editor admin (chiave · etichetta · esempio d'anteprima). */
export const PLACEHOLDER_CAUSALE: { chiave: string; label: string; esempio: string }[] = [
    { chiave: 'descrizione', label: 'Descrizione voce', esempio: 'Retta Settembre 2026' },
    { chiave: 'nome_completo', label: 'Nome e cognome', esempio: 'Mario Rossi' },
    { chiave: 'nome', label: 'Nome', esempio: 'Mario' },
    { chiave: 'cognome', label: 'Cognome', esempio: 'Rossi' },
    { chiave: 'codice_fiscale', label: 'Codice fiscale', esempio: 'RSSMRA85T10A562S' },
    { chiave: 'sede', label: 'Sede', esempio: 'GIUGLIANO' },
    { chiave: 'mese', label: 'Mese di competenza', esempio: 'settembre' },
    { chiave: 'anno', label: 'Anno', esempio: '2026' },
    { chiave: 'importo', label: 'Importo', esempio: '€ 150,00' },
    { chiave: 'scadenza', label: 'Scadenza', esempio: '30/09/2026' },
]

/** Valori dei segnaposto ricavati dai dati (CF/sede normalizzati). */
function valoriSegnaposto(dati: DatiCausale): Record<string, string> {
    const cf = (dati.codiceFiscale ?? '').trim().toUpperCase()
    return {
        descrizione: (dati.descrizione ?? '').trim(),
        nome: (dati.nome ?? '').trim(),
        cognome: (dati.cognome ?? '').trim(),
        nome_completo: nomeCompleto(dati),
        codice_fiscale: cf,
        cf, // alias comodo
        sede: sedeCausale(dati.sede),
        mese: (dati.mese ?? '').trim(),
        anno: dati.anno != null ? String(dati.anno).trim() : '',
        importo: (dati.importo ?? '').trim(),
        scadenza: (dati.scadenza ?? '').trim(),
    }
}

/**
 * Rende un MODELLO di causale sostituendo i segnaposto `{chiave}` coi dati, lavorando
 * PER SEGMENTO (separatore « - »): un segmento che contiene segnaposto ma li ha TUTTI
 * vuoti viene OMESSO (niente label penzolante tipo «per il minore» senza nome, né doppi
 * trattini); il testo fisso senza segnaposto resta sempre; gli spazi doppi si comprimono.
 * Così le parti assenti (CF/sede) spariscono con grazia e il predefinito riproduce
 * esattamente il formato storico.
 */
export function renderCausale(template: string, dati: DatiCausale): string {
    const v = valoriSegnaposto(dati)
    // Difesa: un `template` non-stringa (config malformata via API diretta) NON deve
    // far esplodere `.split` (→ 500 sull'intera lista pagamenti del genitore) → si
    // ricade sul modello predefinito.
    const tpl = typeof template === 'string' ? template : DEFAULT_CAUSALE_TEMPLATE
    return tpl
        .split(' - ')
        .map((seg) => {
            const placeholders = seg.match(/\{([a-z_]+)\}/g) ?? []
            // Segmento con segnaposto ma tutti vuoti → si omette del tutto.
            if (placeholders.length > 0 && !placeholders.some((p) => (v[p.slice(1, -1)] ?? '') !== '')) {
                return ''
            }
            return seg.replace(/\{([a-z_]+)\}/g, (_m, k: string) => v[k] ?? '').replace(/\s+/g, ' ').trim()
        })
        .filter(Boolean)
        .join(' - ')
        .trim()
}

/**
 * La causale consigliata col MODELLO indicato (o il predefinito): stringa da
 * copiare/incollare nel bonifico. Parti assenti omesse.
 */
export function causaleBonifico(dati: DatiCausale, template?: string | null): string {
    return renderCausale(template || DEFAULT_CAUSALE_TEMPLATE, dati)
}

/**
 * La riga per il corpo dell'email di sollecito, col modello (o il predefinito).
 * Se non c'è nulla da comporre (tutti i campi assenti) ritorna stringa vuota.
 */
export function rigaCausaleSollecito(dati: DatiCausale, template?: string | null): string {
    const causale = causaleBonifico(dati, template)
    if (!causale) return ''
    return `Per pagare tramite bonifico, indicate come causale: "${causale}".`
}
