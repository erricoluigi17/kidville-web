// Causale consigliata per il bonifico, completa per l'abbinamento automatico
// (riconciliazione) SENZA margine d'errore:
//   «{descrizione} - per il minore {Nome Cognome} - {CODICE FISCALE} - {SEDE}»
// es. «Retta Settembre 2026 - per il minore Mario Rossi - RSSMRA85T10A562S - GIUGLIANO».
// Ogni parte assente viene omessa. Il CF del minore va SOLO al genitore (card
// «Copia» + email di sollecito), MAI nei log: qui si formatta solo una stringa.
//
// Funzioni PURE, senza I/O: condivise dalla UI genitore e dal motore dei solleciti.

export interface DatiCausale {
    descrizione?: string | null
    nome?: string | null
    cognome?: string | null
    codiceFiscale?: string | null
    sede?: string | null
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

/**
 * La stringa da copiare/incollare in causale:
 *   «{descrizione} - per il minore {Nome Cognome} - {CF} - {SEDE}».
 * Le parti assenti sono omesse (join con « - »); il CF è normalizzato in maiuscolo.
 */
export function causaleBonifico(dati: DatiCausale): string {
    const nome = nomeCompleto(dati)
    const cf = (dati.codiceFiscale ?? '').trim().toUpperCase()
    const desc = (dati.descrizione ?? '').trim()
    const sede = sedeCausale(dati.sede)
    return [desc, nome ? `per il minore ${nome}` : '', cf, sede]
        .filter(Boolean)
        .join(' - ')
}

/**
 * La riga da aggiungere al corpo dell'email di sollecito con la causale completa.
 * Se non c'è nulla da comporre (tutti i campi assenti) ritorna stringa vuota.
 */
export function rigaCausaleSollecito(dati: DatiCausale): string {
    const causale = causaleBonifico(dati)
    if (!causale) return ''
    return `Per pagare tramite bonifico, indicate come causale: "${causale}".`
}
