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
 *
 * `operazione` è il nome stabile del punto di chiamata (`crm/schede:POST`): è ciò che si cerca nel log.
 */

const TABELLA_ASSENTE = new Set(['PGRST205', '42P01'])

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
  if (TABELLA_ASSENTE.has(codice)) {
    logEvento('crm', 'warn', { operazione, esito: 'schema-crm-assente' }, error)
    return NextResponse.json(
      { error: 'Il CRM non è ancora disponibile su questo ambiente.', codice: 'CRM_NON_INSTALLATO' },
      { status: 503 },
    )
  }
  logErrore({ operazione, stato: 500 }, error)
  return NextResponse.json(
    { error: 'L’operazione non è riuscita. Riprova fra poco.', codice: 'CRM_OPERAZIONE_NON_RIUSCITA' },
    { status: 500 },
  )
}
