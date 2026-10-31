import { NextResponse } from 'next/server'
import { logErrore, logEvento } from '@/lib/logging/logger'

/**
 * CRM DELLA SEGRETERIA · DA UN ERRORE DEL DATABASE ALLA RISPOSTA GIUSTA.
 *
 * PostgREST non lancia: ritorna `{ error }`, e il suo `code` dice che cosa è successo davvero. Le route
 * del CRM non devono tutte reinventare quel dizionario (né rispondere 500 a un conflitto che è una
 * risposta normale): lo scrivono qui, una volta.
 *
 *  · `23P01` — l'EXCLUDE di `crm_appuntamenti`: la persona ha già una visita che si sovrappone → 409.
 *  · `23505` — la UNIQUE `(domanda_id, domanda_figlio)`: quella domanda è già collegata → 409.
 *  · `PGRST205` / `42P01` — le tabelle `crm_*` non esistono su questo database (il DB E2E della CI non
 *    è migrato, o è la finestra fra il deploy e la migrazione) → 503, con un `warn` persistito: in
 *    produzione non deve mai succedere, ed è una frase diversa da «qualcosa è andato storto».
 *  · tutto il resto → 500. Il testo del database NON torna al client (può nominare tabelle e colonne);
 *    resta nel log, con il codice.
 *  · `rispostaErroreDbSchema` allarga il «non installato» ai pezzi di schema che una migrazione aggiunge
 *    DOPO le tabelle (una funzione `rpc`, una colonna): la quota d'iscrizione ne usa tre, e nella finestra
 *    fra il deploy e la migrazione mancano. Le route che non ne dipendono continuano con `rispostaErroreDb`.
 *
 * `operazione` è il nome stabile del punto di chiamata (`crm/schede:POST`): è ciò che si cerca nel log.
 */

const TABELLA_ASSENTE = new Set(['PGRST205', '42P01'])

/**
 * Tutto ciò che dice «a questo database manca un pezzo dello schema del CRM»: la tabella (`PGRST205`,
 * `42P01`), la funzione (`PGRST202` per PostgREST, `42883` per Postgres), la colonna (`42703` in lettura,
 * `PGRST204` in scrittura). Il database E2E della CI non è migrato e non lo sarà.
 */
export const CODICI_SCHEMA_CRM_ASSENTE = new Set(['PGRST202', 'PGRST205', 'PGRST204', '42P01', '42883', '42703'])

/** Il codice di un errore, comunque sia arrivato (oggetto PostgREST o eccezione): stringa vuota se non c'è. */
export function codiceErroreDb(error: unknown): string {
  const c = (error as { code?: unknown } | null | undefined)?.code
  return typeof c === 'string' ? c : ''
}

/**
 * 503 `CRM_NON_INSTALLATO`, SENZA scrivere nel log: per chi ha già lasciato la sua riga (come
 * `passaQuotaInContabilita`, che registra l'assenza dello schema e poi restituisce un esito).
 */
export function rispostaCrmNonInstallato(): NextResponse {
  return NextResponse.json(
    { error: 'Il CRM non è ancora disponibile su questo ambiente.', codice: 'CRM_NON_INSTALLATO' },
    { status: 503 },
  )
}

/**
 * 500 `CRM_OPERAZIONE_NON_RIUSCITA`, SENZA scrivere nel log: per chi ha già lasciato la sua riga e non ha un
 * errore di database in mano (una funzione SQL che risponde con un esito che è un guasto di configurazione).
 */
export function rispostaCrmNonRiuscita(): NextResponse {
  return NextResponse.json(
    { error: 'L’operazione non è riuscita. Riprova fra poco.', codice: 'CRM_OPERAZIONE_NON_RIUSCITA' },
    { status: 500 },
  )
}

/** Il 503, con un `warn` persistito: in produzione non deve mai succedere. */
function schemaAssente(error: { code?: string; message?: string }, operazione: string): NextResponse {
  logEvento('crm', 'warn', { operazione, esito: 'schema-crm-assente' }, error)
  return rispostaCrmNonInstallato()
}

export function rispostaErroreDb(error: { code?: string; message?: string }, operazione: string): NextResponse {
  const codice = typeof error?.code === 'string' ? error.code : ''

  if (codice === '23P01') {
    return NextResponse.json(
      { error: 'Questo orario è già occupato per la persona scelta.', codice: 'SLOT_OCCUPATO' },
      { status: 409 },
    )
  }
  if (codice === '23505') {
    return NextResponse.json(
      { error: 'Questa domanda di iscrizione è già collegata a un altro bambino.', codice: 'GIA_COLLEGATO' },
      { status: 409 },
    )
  }
  if (TABELLA_ASSENTE.has(codice)) return schemaAssente(error, operazione)
  logErrore({ operazione, stato: 500 }, error)
  return rispostaCrmNonRiuscita()
}

/** Come `rispostaErroreDb`, ma anche una funzione o una colonna mancante è «non installato» (503), non un 500. */
export function rispostaErroreDbSchema(error: { code?: string; message?: string }, operazione: string): NextResponse {
  if (CODICI_SCHEMA_CRM_ASSENTE.has(codiceErroreDb(error))) return schemaAssente(error, operazione)
  return rispostaErroreDb(error, operazione)
}
