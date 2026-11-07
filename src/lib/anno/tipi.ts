/**
 * I TIPI DELL'ANNO SCOLASTICO nelle scritture (PR 3).
 *
 * `StatoAnno` è lo stato di `anni_sede.stato` (CHECK della migrazione della PR 1).
 * `EsitoAnno` è ciò che `resolveAnnoScrittura` / `annoDellaData` restituiscono (Compito 3.2):
 * `annoSedeId`, `annoId` e `stato` sono `null` SOLO con `schemaIndietro: true`, cioè sul
 * database della CI, che non ha ancora lo schema dell'anno.
 *
 * `conAnno(esito)` — le tre righe pure su questo tipo — arriva col Compito 3.2.
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
 * I codici che i trigger dell'anno sollevano e che `erroreAnno` traduce in HTTP.
 * Lista LETTERALE: la riusa `supabase-fetch.ts` (Compito 3.4) per riconoscere un errore
 * dell'anno senza importare la funzione che costruisce la risposta.
 * `ANNO_DA_SPECIFICARE` e `ANNO_NON_DELLA_SEDE` li solleva anche l'app
 * (`resolveAnnoScrittura`); il primo lo solleva già il trigger della PR 2.
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
] as const

export type CodiceAnno = (typeof CODICI_ANNO)[number]
