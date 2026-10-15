import { deveNotificareGenitori, type ContestoNotificaOperazione } from '@/lib/storici/retroattivita'
import type { SupabaseClient } from '@supabase/supabase-js'
import { isNotificaAbilitata } from '@/lib/notifiche/config'
import { logEvento } from '@/lib/logging/logger'
import { colonnaNuovaAssente } from '@/lib/db/colonna-assente'
import { ritiraPendingOperazione } from '@/lib/notifiche/ritira-pending'

// =============================================================================
// Core module-agnostico per accodare notifiche bufferizzate (servizio Push P1).
//
// Inserisce una riga `notifiche` per utente con `invio_programmato_il = now +
// bufferMin`. Il dispatch effettivo (push) avviene quando il cron generico
// drena il buffer (vedi notifiche_dispatch_tick + /api/push/dispatch).
// Best-effort: gli errori non bloccano il flusso chiamante.
//
// Toggle per scuola (admin_settings.notifiche_config): passando `scuolaId` il
// tipo viene verificato con isNotificaAbilitata (fail-open); senza scuolaId la
// notifica è sempre accodata (comportamento storico).
//
// QUESTA È LA CODA DI TUTTO IL SISTEMA DI NOTIFICA: ventotto trigger diversi
// finiscono qui, e quello che non viene inserito in `notifiche` non verrà mai
// più spedito da nessuno. Perciò l'insert qui sotto è l'unico punto del modulo
// che NON può fallire in silenzio — vedi il commento sull'insert.
// =============================================================================

export interface EnqueueNotificheParams {
  utenteIds: string[]
  tipo: string
  titolo: string
  corpo?: string | null
  link?: string | null
  entitaTipo?: string | null
  entitaId?: string | null
  /** Minuti di buffer prima che la notifica sia inviabile. Default 0 (subito). */
  bufferMin?: number
  /** Scuola per il gate dei toggle notifiche (assente = nessun gate, fail-open). */
  scuolaId?: string | null
  /** Contesto calcolato dal server per l'operazione originale. */
  operazione?: ContestoNotificaOperazione
  destinatario?: 'genitore' | 'personale'
}

/** True solo quando le righe sono state accodate; false per esclusioni o scrittura fallita. */
export async function enqueueNotifiche(
  supabase: SupabaseClient,
  params: EnqueueNotificheParams
): Promise<boolean> {
  if (params.destinatario === 'genitore' && !deveNotificareGenitori(params.operazione)) {
    await ritiraPendingOperazione(supabase, params)
    logEvento('notifica', 'info', { operazione: 'enqueueNotifiche', esito: 'rettifica-storica-silenziosa', tipo: params.tipo })
    return false
  }
  const utenti = [...new Set(params.utenteIds ?? [])].filter(Boolean)
  if (utenti.length === 0) {
    // IL SECONDO IMBUTO, e usciva muto come il primo. Qui arrivano anche i chiamanti che NON
    // passano da `notificaEvento` (solleciti, merch, fattura/sync, panic-alert, locker,
    // credenziali): per loro questa è l'unica riga che possa esistere.
    //
    // Il `filter(Boolean)` conta: una lista di soli id vuoti è «zero destinatari», non «un
    // destinatario» — e chi ha invocato con `['']` crede di aver avvisato qualcuno. Il
    // controllo del chiamante sulla lunghezza dell'array grezzo non se ne accorge.
    //
    // `warn`: la lista vuota può essere legittima. Ma resta persistita (`vaPersistito` tiene
    // i warn), così «nessuna notifica accodata oggi per il tipo X nella sede Y» diventa una
    // query invece di un'ipotesi.
    logEvento('notifica', 'warn', {
      operazione: 'enqueueNotifiche',
      esito: 'nessun-destinatario',
      tipo: params.tipo,
      sede_id: params.scuolaId ?? null,
      n_richiesti: params.utenteIds?.length ?? 0,
    })
    return false
  }
  if (!(await isNotificaAbilitata(supabase, params.tipo, params.scuolaId ?? null))) return false

  const programmato = new Date(Date.now() + (params.bufferMin ?? 0) * 60_000).toISOString()
  const righeBase = utenti.map((uid) => ({
    utente_id: uid,
    tipo: params.tipo,
    titolo: params.titolo,
    corpo: params.corpo ?? null,
    link: params.link ?? null,
    entita_tipo: params.entitaTipo ?? null,
    entita_id: params.entitaId ?? null,
    invio_programmato_il: programmato,
  }))
  let rows: Record<string, unknown>[] = params.operazione ? righeBase.map(r => ({ ...r, giorno_competenza: params.operazione!.giornoCompetenza, politica_operazione: params.operazione })) : righeBase

  // POSTGREST NON LANCIA: `insert` RITORNA `{ error }`, non solleva. Il `try/catch` che stava
  // qui attorno — con dentro l'unico console.error del percorso — non è mai scattato una volta:
  // quando l'inserimento falliva non succedeva NIENTE. Niente eccezione verso `notificaEvento`,
  // niente riga sul canale di log, niente notifica. La coda restava vuota e il sistema
  // sembrava a posto: il genitore non scopriva mai che il figlio aveva preso una nota, che la
  // domanda era stata respinta, che il servizio mensa era sospeso. È il guasto silenzioso
  // esattamente nella forma in cui questo repo l'ha già pagato con le email. Il valore di
  // ritorno SI CONTROLLA.
  try {
    let { error } = await supabase.from('notifiche').insert(rows)
    for (let n = 0; error && params.operazione && n < 2
      && (deveNotificareGenitori(params.operazione) || params.destinatario === 'personale'); n++) {
      if (!colonnaNuovaAssente(error)) break
      const assente = /\b(politica_operazione|giorno_competenza)\b/.exec(error.message ?? '')?.[1]
      if (!assente || !(assente in rows[0])) break
      // Il DB precedente non può conservare la policy. Le rettifiche per i
      // genitori sono già escluse prima di qualsiasi insert: qui si recupera
      // soltanto una consegna ammessa, senza ricalcolarla al momento dell'invio.
      // Su uno schema parziale conserva ogni metadato che il database possiede.
      logEvento('notifica', 'warn', {
        operazione: 'enqueueNotifiche', esito: 'metadati-storici-assenti', tipo: params.tipo, n: rows.length,
      }, error)
      rows = rows.map(r => { const precedente = { ...r }; delete precedente[assente]; return precedente })
      const precedente = await supabase.from('notifiche').insert(rows)
      error = precedente.error
    }
    if (error) {
      // `error` e non `warn`: la riga in coda non esiste, nessun altro pezzo del sistema la
      // recupererà (il cron drena `notifiche`, e lì non c'è nulla da drenare) e la route
      // chiamante risponderà comunque 200. È una scrittura PERSA, non un degrado.
      //
      // L'errore si passa INTERO come 4° argomento, mai riassunto con `String(e)`: `code`,
      // `details` e `hint` di PostgREST sono ciò che dice PERCHÉ (una FK verso un utente
      // cancellato, una colonna che il DB E2E non ha, la RLS che nega la scrittura). Un
      // messaggio senza codice è un `403` senza corpo — cioè niente.
      logEvento('notifica', 'error', {
        operazione: 'enqueueNotifiche',
        esito: 'insert-fallito',
        tipo: params.tipo,
        n: rows.length,
      }, error)
      return false
    }
    return true
  } catch (err) {
    // Il ramo che resta possibile davvero: un guasto di TRASPORTO (il fetch che esplode prima
    // di arrivare a PostgREST). Non è il caso che il difetto descriveva, ma esiste — e non deve
    // propagare: il contratto verso `notificaEvento` e verso le 28 route è "best-effort, non
    // lancia mai". Si logga, non si rilancia.
    logEvento('notifica', 'error', {
      operazione: 'enqueueNotifiche',
      esito: 'insert-non-eseguito',
      tipo: params.tipo,
      n: rows.length,
    }, err)
    return false
  }
}
