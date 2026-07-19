// Causale consigliata per il bonifico. Il genitore che scrive in causale il
// CODICE FISCALE del minore rende univoco l'abbinamento automatico dei bonifici
// (riconciliazione): «Nome Cognome CODICE_FISCALE». Se il CF manca, si degrada a
// «Nome Cognome» con l'invito a indicare comunque il nome del bambino.
//
// Funzioni PURE, senza I/O: condivise dalla UI genitore (card «Copia») e dal
// motore dei solleciti (riga nel corpo email). Nessun dato personale passa dai
// log: qui si formatta soltanto una stringa, chi la usa non la logga (il CF è un
// dato che va al genitore, non in `app_log`).

export interface DatiCausale {
    nome?: string | null
    cognome?: string | null
    codiceFiscale?: string | null
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
 * La stringa da copiare/incollare in causale: «Nome Cognome CF» (CF normalizzato
 * in maiuscolo). Senza CF ritorna il solo «Nome Cognome».
 */
export function causaleBonifico(dati: DatiCausale): string {
    const cf = (dati.codiceFiscale ?? '').trim().toUpperCase()
    return [nomeCompleto(dati), cf].filter(Boolean).join(' ')
}

/**
 * La riga da aggiungere al corpo dell'email di sollecito. Con CF mostra la causale
 * completa; senza, invita a indicare nome e cognome del bambino.
 */
export function rigaCausaleSollecito(dati: DatiCausale): string {
    if (haCodiceFiscale(dati.codiceFiscale)) {
        return `Per pagare tramite bonifico, indicate come causale: "${causaleBonifico(dati)}".`
    }
    return `Per pagare tramite bonifico, indicate come causale il nome e cognome del bambino: "${nomeCompleto(dati)}".`
}
