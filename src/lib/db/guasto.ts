import { NextResponse } from 'next/server'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { colonnaNuovaAssente } from '@/lib/db/colonna-assente'

/**
 * UN GUASTO DEL DATABASE, FUORI DA `pagamenti` — la risposta e la riga di log, in un posto.
 * (Fase 11 della roadmap di robustezza, «errori non ignorati» — 2026-10-19.)
 *
 * PERCHÉ ESISTE. PostgREST non lancia: restituisce `{ data: null, error }`. La ricognizione del
 * 19/10 su `src/` contava 208 letture col solo `data`, 57 scritture col risultato buttato e 62
 * `.then`/`.catch` muti. Il `null` diventava un valore: un elenco vuoto al posto di un guasto, un
 * 404 «non trovato» al posto di un database che non risponde, una scrittura fallita che l'utente
 * vedeva «salvata». Nessuno di quei casi lasciava una riga nei log.
 *
 * È la stessa forma di `src/lib/pagamenti/guasto-db.ts` (fase 5), che resta per i pagamenti con
 * il suo codice di scrittura: là la frase è la stessa, ma il codice dice da quale area viene.
 *
 * TRE FORME, perché i guasti non sono tutti uguali:
 *   · `rispostaGuastoDb` — il dato serviva a decidere o a rispondere: 500 con codice, e la riga
 *     `logErrore` col codice Postgres. Mai un vuoto travestito da risposta;
 *   · `guastoSecondario` — la scrittura principale è GIÀ avvenuta e il guasto è di un passo
 *     accessorio (traccia, notifica, ricalcolo): rispondere 500 inviterebbe a ripetere
 *     un'operazione riuscita. Si logga a livello `error` e si prosegue;
 *   · `guastoLetturaAccessoria` — una lettura che arricchisce la risposta ma non decide niente
 *     (un contatore, un nome da mostrare): la risposta esce col ripiego e la riga dice perché.
 *     Su una colonna o una tabella che questo database non ha ancora (il DB della CI non è
 *     migrato) la riga è `info`, altrove `error`: in produzione lo schema c'è, e un guasto lì va
 *     visto.
 *   · `rispostaGuastoGiaRegistrato` — la risposta di `rispostaGuastoDb` senza la riga, quando l'ha già scritta
 *     chi chiama (sessione 13).
 *
 * Il corpo dell'errore non va nella risposta: può contenere `Key (…)=(…)` con dati personali.
 * Va nel log, dove passa dalla redazione.
 */

export type TipoGuasto = 'lettura' | 'scrittura'

/**
 * 500 per un guasto del database su un dato che serviva. `operazione` è il nome della route
 * (`'admin/merch/ordini:GET'`), `evento` dice cosa si stava leggendo o scrivendo (`'db:ordini'`).
 */
export function rispostaGuastoDb(
  operazione: string,
  evento: string,
  error: unknown,
  tipo: TipoGuasto = 'lettura',
): NextResponse {
  logErrore({ operazione, stato: 500, evento }, error)
  return rispostaGuastoGiaRegistrato(tipo)
}

/**
 * La stessa risposta di `rispostaGuastoDb`, per quando la riga di log c'è GIÀ: `sediReali` che logga da sé, un
 * `logEvento('modulistica', 'error', …)` scritto una riga sopra con un `esito` più preciso. Una seconda riga per
 * lo stesso guasto raddoppierebbe i conteggi. (Sessione 13 della seconda serie: le porte anonime non mandano più
 * il testo di PostgREST.)
 */
export function rispostaGuastoGiaRegistrato(tipo: TipoGuasto = 'lettura'): NextResponse {
  // Due letterali e non una mappa: il lock `errori-con-codice` verifica solo i codici che sa
  // leggere nel sorgente.
  if (tipo === 'scrittura') {
    return NextResponse.json({ error: 'Scrittura sul database non riuscita', codice: 'SCRITTURA_FALLITA' }, { status: 500 })
  }
  return NextResponse.json({ error: 'Lettura dal database non riuscita', codice: 'LETTURA_FALLITA' }, { status: 500 })
}

/**
 * Un passo accessorio non riuscito DOPO la scrittura principale: livello `error`, nessuna
 * risposta cambiata. `evento` è il dominio (`'registro'`, `'chat'`, …: uno di `EVENTI_NOTI`).
 */
export function guastoSecondario(evento: string, operazione: string, esito: string, error: unknown): void {
  logEvento(evento, 'error', { operazione, esito }, error)
}

/**
 * Una lettura che non decide niente è fallita, e la risposta esce col ripiego. La riga dice
 * QUALE lettura (`esito`) e con quale codice; `info` solo se allo schema manca la colonna o la
 * tabella, che è il caso atteso del database della CI.
 */
export function guastoLetturaAccessoria(evento: string, operazione: string, esito: string, error: unknown): void {
  const codice = (error as { code?: unknown } | null)?.code
  const schemaIndietro =
    colonnaNuovaAssente(error as { code?: string } | null) || codice === '42P01' || codice === 'PGRST205'
  logEvento(evento, schemaIndietro ? 'info' : 'error', { operazione, esito, ripiego: true }, error)
}
