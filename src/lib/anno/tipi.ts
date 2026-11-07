/**
 * I TIPI DELL'ANNO SCOLASTICO nelle scritture (PR 3).
 *
 * `StatoAnno` è lo stato di `anni_sede.stato` (CHECK della migrazione della PR 1).
 * `EsitoAnno` è ciò che `resolveAnnoScrittura` / `annoDellaData` restituiscono (Compito 3.2):
 * `annoSedeId`, `annoId` e `stato` sono `null` SOLO con `schemaIndietro: true`, cioè sul
 * database della CI, che non ha ancora lo schema dell'anno.
 *
 */
export type StatoAnno =
  | 'in_preparazione'
  | 'iscrizioni_aperte'
  | 'corrente'
  | 'in_chiusura'
  | 'chiuso'

export type EsitoAnno = {
  annoSedeId: string | null
  annoId: string | null
  stato: StatoAnno | null
  gettone?: string
  gettoni?: string[]
  schemaIndietro?: true
}

/**
 * Il pezzo di payload che dichiara l'anno: `{ anno_id }`, oppure `{}` sul database senza lo schema
 * dell'anno (`schemaIndietro`), dove la colonna non c'è e un `anno_id` farebbe `PGRST204`.
 * `anno_id` è `anni_scolastici.id`, non `anni_sede.id`.
 */
export function conAnno(esito: EsitoAnno): { anno_id?: string } {
  return esito.schemaIndietro || !esito.annoId ? {} : { anno_id: esito.annoId }
}

/**
 * I codici che i trigger dell'anno sollevano e che `erroreAnno` traduce in HTTP.
 * Lista LETTERALE: la riusa `supabase-fetch.ts` (Compito 3.4) per riconoscere un errore
 * dell'anno senza importare la funzione che costruisce la risposta.
 * `ANNO_DA_SPECIFICARE` e `ANNO_NON_DELLA_SEDE` li solleva anche l'app
 * (`resolveAnnoScrittura`); il primo lo solleva già il trigger della PR 2.
 * `ANNO_NON_VISIBILE` e `MOTIVO_OBBLIGATORIO` li solleva SOLO l'app (Compito 3.2): sono qui perché
 * `erroreAnno` è l'unico posto in cui un codice dell'anno diventa una risposta.
 */
export const CODICI_ANNO = [
  'ANNO_CHIUSO',
  'PASSAGGIO_DA_FARE',
  'SEZIONE_DI_ALTRO_ANNO',
  'SEZIONE_DI_ALTRA_SEDE',
  'ANNO_NON_COERENTE',
  'ANNO_DA_SPECIFICARE',
  'ANNO_NON_DELLA_SEDE',
  'MODULO_NON_RICHIESTO',
  'CONFINE_NON_VALIDO',
  'CONFINE_CON_RIGHE',
  'CALENDARIO_NON_CONTINUO',
  'GIORNO_SENZA_ANNO',
  'ANNO_NON_VISIBILE',
  'MOTIVO_OBBLIGATORIO',
] as const

export type CodiceAnno = (typeof CODICI_ANNO)[number]

/**
 * Il codice in testa a un messaggio d'errore: la prima parola MAIUSCOLA seguita da fine stringa,
 * spazio o due punti (`ANNO_CHIUSO`, `ANNO_CHIUSO: dettaglio`). Una regola sola, in un modulo
 * puro: la usano `errori.ts` (`erroreAnno`) e `supabase-fetch.ts` (la rete di `withRoute`), e
 * quest'ultimo non può importare `errori.ts` (importa il logger, che importa il contesto: ciclo).
 */
export function codiceDaMessaggio(message: unknown): string | null {
  const m = typeof message === 'string' ? /^\s*([A-Z][A-Z0-9_]+)(?=$|[\s:])/.exec(message) : null
  return m ? m[1] : null
}

/** Il codice dell'anno contenuto nel messaggio, se è uno di `CODICI_ANNO`; altrimenti `null`. */
export function codiceAnnoDa(message: unknown): CodiceAnno | null {
  const c = codiceDaMessaggio(message)
  return c !== null && (CODICI_ANNO as readonly string[]).includes(c) ? (c as CodiceAnno) : null
}
