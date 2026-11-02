import { NextResponse } from 'next/server'
import it from '../../../messages/it/shared.json'
import { CODICI_ERRORE } from '@/lib/ui/esito-fetch'
import { logErrore, logEvento } from '@/lib/logging/logger'

/**
 * VOTAZIONI · DA UN ERRORE DEL DATABASE ALLA RISPOSTA GIUSTA.
 *
 * PostgREST non lancia: ritorna `{ error }`, e il suo `code` dice che cosa è successo davvero. Le route
 * delle votazioni non reinventano quel dizionario: lo scrivono qui, una volta. Modello:
 * `src/lib/crm/errori.ts`.
 *
 *  · `PGRST205` / `42P01` — le tabelle `votazioni*` non esistono su questo database;
 *  · `PGRST202` / `42883` — manca una funzione SQL;
 *  · `42703` / `PGRST204` — manca una colonna.
 *    Sono la finestra fra il deploy e la migrazione, oppure il database E2E della CI, che non è migrato:
 *    → 503 `VOTAZIONI_NON_DISPONIBILI`, con un `warn` persistito (in produzione non deve mai succedere).
 *  · tutto il resto → 500 `VOTAZIONE_OPERAZIONE_NON_RIUSCITA`. Il testo del database NON torna al client
 *    (può nominare tabelle e colonne); resta nel log, con il codice.
 *
 * I conflitti di chiave (`23505`, `23503`, `23514`) NON si traducono qui: che cosa significano dipende
 * dalla route. Una UNIQUE violata sul voto è una corsa da risolvere con un `update`; la stessa UNIQUE sulle
 * classi è un `409 VOTAZIONE_CLASSE_GIA_APERTA`. Chi lo sa lo gestisce PRIMA di chiamare questa funzione.
 *
 * La PROSA del corpo è quella del catalogo ITALIANO (`messages/it/shared.json`), come in `rifiutoSede`:
 * è la stessa frase che vede un utente italiano, quindi le due strade non possono divergere. Il client
 * traduce comunque il `codice` nella lingua che sta guardando l'utente.
 *
 * `operazione` è il nome stabile del punto di chiamata (`votazioni/elenco:GET`): è ciò che si cerca nel log.
 */

const CATALOGO_IT = it as Record<string, string>

/** Tutto ciò che dice «a questo database manca un pezzo dello schema delle votazioni». */
export const CODICI_SCHEMA_VOTAZIONI_ASSENTE: ReadonlySet<string> = new Set([
  'PGRST202',
  'PGRST204',
  'PGRST205',
  '42P01',
  '42703',
  '42883',
])

/** Il codice di un errore, comunque sia arrivato (oggetto PostgREST o eccezione): stringa vuota se non c'è. */
function codiceErroreDb(error: unknown): string {
  const c = (error as { code?: unknown } | null | undefined)?.code
  return typeof c === 'string' ? c : ''
}

/** Lo schema delle votazioni manca su questo database? Solo un `code` stringa dei sei noti lo dice. */
export function schemaVotazioniAssente(error: unknown): boolean {
  return CODICI_SCHEMA_VOTAZIONI_ASSENTE.has(codiceErroreDb(error))
}

/**
 * 503 `VOTAZIONI_NON_DISPONIBILI`, SENZA scrivere nel log: per chi ha già lasciato la sua riga o decide di
 * degradare in silenzio (l'elenco risponde `{ disponibile: false }`, il genitore non vede la card).
 */
export function rispostaVotazioniNonDisponibili(): NextResponse {
  return NextResponse.json(
    { error: CATALOGO_IT[CODICI_ERRORE.VOTAZIONI_NON_DISPONIBILI], codice: 'VOTAZIONI_NON_DISPONIBILI' },
    { status: 503 },
  )
}

/** 500 `VOTAZIONE_OPERAZIONE_NON_RIUSCITA`, SENZA scrivere nel log: il dettaglio lo ha già registrato chi chiama. */
function rispostaVotazioneNonRiuscita(): NextResponse {
  return NextResponse.json(
    { error: CATALOGO_IT[CODICI_ERRORE.VOTAZIONE_OPERAZIONE_NON_RIUSCITA], codice: 'VOTAZIONE_OPERAZIONE_NON_RIUSCITA' },
    { status: 500 },
  )
}

/**
 * Lo schema assente → `warn` persistito e 503; qualunque altra cosa → `error` e 500.
 *
 * Accetta anche un'eccezione qualunque (`new Error(...)`): senza `code` finisce nel ramo del guasto.
 */
export function rispostaErroreDbVotazioni(
  error: { code?: string; message?: string },
  operazione: string,
): NextResponse {
  if (schemaVotazioniAssente(error)) {
    logEvento('votazioni', 'warn', { operazione, esito: 'schema-votazioni-assente' }, error)
    return rispostaVotazioniNonDisponibili()
  }
  logErrore({ operazione, stato: 500 }, error)
  return rispostaVotazioneNonRiuscita()
}
