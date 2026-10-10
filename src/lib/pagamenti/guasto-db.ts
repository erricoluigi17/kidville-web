import { NextResponse } from 'next/server'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { descriviTetto, type EsitoABlocchi } from '@/lib/pagamenti/leggi-a-blocchi'

/**
 * Un guasto del database in una route di `pagamenti` — la risposta e la riga di log, in un posto.
 * (Fase 5 della roadmap di robustezza, sesto pezzo: «ogni `{ error }` di PostgREST controllato».)
 *
 * PERCHÉ ESISTE. PostgREST non lancia: restituisce `{ data: null, error }`. Fino al 2026-10-10
 * la ricognizione di `src/app/api/pagamenti/**` contava 68 letture e scritture col `error` mai
 * guardato, e il `null` diventava un valore: un'attestazione 730 con versato 0, un'anteprima di
 * rette che riproponeva quelle già emesse, un saldo ticket letto 0 e poi SCRITTO sopra quello
 * vero, un 404 «non trovato» al posto di un guasto. Nessuno di questi casi lasciava una riga.
 *
 * DUE FORME, perché i guasti non sono tutti uguali:
 *   · `rispostaGuastoDb` — il dato serviva a decidere o a rispondere: 500 con codice, e la
 *     riga `logErrore` col codice Postgres. Mai un vuoto travestito da risposta;
 *   · `guastoSecondario` — la scrittura principale è GIÀ avvenuta e il guasto è di un passo
 *     accessorio (traccia in `registro_modifiche`, ricalcolo, notifica): rispondere 500
 *     inviterebbe a ripetere un'operazione riuscita. Si logga a livello `error` e si prosegue.
 *
 * Il corpo dell'errore non va nella risposta: può contenere `Key (…)=(…)` con dati personali.
 * Va nel log, dove passa dalla redazione.
 */

export type TipoGuasto = 'lettura' | 'scrittura'

/**
 * 500 per un guasto del database su un dato che serviva. `operazione` è il nome della route
 * (`'pagamenti/attestazione:GET'`), `evento` dice cosa si stava leggendo (`'db:incassi'`).
 */
export function rispostaGuastoDb(
  operazione: string,
  evento: string,
  error: unknown,
  tipo: TipoGuasto = 'lettura',
): NextResponse {
  logErrore({ operazione, stato: 500, evento }, error)
  // Due letterali e non una mappa: il lock `errori-con-codice` verifica solo i
  // codici che sa leggere nel sorgente.
  if (tipo === 'scrittura') {
    return NextResponse.json({ error: 'Scrittura sul database non riuscita', codice: 'PAGAMENTI_SCRITTURA_FALLITA' }, { status: 500 })
  }
  return NextResponse.json({ error: 'Lettura dal database non riuscita', codice: 'LETTURA_FALLITA' }, { status: 500 })
}

/**
 * 500 per una lettura a blocchi (`leggiABlocchi`) non riuscita: per errore, con la riga del
 * guasto vero; per il tetto, con la riga `lettura-troncata` (la forma di `GET /api/pagamenti/export`).
 * Mai una risposta con un pezzo in meno.
 */
export function rispostaBlocchiFalliti(
  operazione: string,
  tipo: string,
  esito: Extract<EsitoABlocchi<unknown>, { ok: false }>,
): NextResponse {
  if (esito.motivo === 'tetto') {
    return rispostaGuastoDb(operazione, 'lettura-troncata', new Error(`${descriviTetto(tipo, esito)}, rifiutata per intero`))
  }
  return rispostaGuastoDb(operazione, `db:${tipo}`, esito.error)
}

/**
 * Un passo accessorio non riuscito DOPO la scrittura principale: livello `error`, nessuna
 * risposta cambiata. Chi chiama decide se aggiungere un avviso alla risposta.
 */
export function guastoSecondario(operazione: string, esito: string, error: unknown): void {
  logEvento('pagamento', 'error', { operazione, esito }, error)
}
