import type { SupabaseClient } from '@supabase/supabase-js'

// =============================================================================
// LA SONDA DELLA FUNZIONE `elimina_alunno_definitivo` (2026-10-09).
//
// PERCHÉ ESISTE. La route `admin/students/elimina` fa effetti che non tornano
// PRIMA di chiamare la funzione SQL: toglie le tracce di testo e i file. Se la
// funzione manca (database non migrato) lo si scopriva DOPO, e la risposta
// «non disponibile: nessuna modifica è stata fatta» era falsa. La sonda lo
// chiede prima di tutto, con una chiamata che non può avere effetti.
//
// PERCHÉ NON HA EFFETTI. Si chiama con l'uuid nullo, che nessuna scheda porta.
// La migrazione (`20261008220540_alunni_elimina_definitivo.sql`) fa come primo
// passo una `select … for update` sulla scheda e, se non la trova, risponde
// `{ ok: false, code: 'non_trovato' }`: nessuna riga bloccata, nessuna scrittura.
//
// PERCHÉ STA QUI E NON NELLA ROUTE. Il lock `isolamento-sede-coverage` pretende
// che ogni `rpc` di una route riceva la sede o agisca su un oggetto verificato
// dal gate: una funzione SECURITY DEFINER non ha filtri addosso. È la regola
// giusta, ma non sa distinguere una chiamata su un uuid che non esiste da una su
// un oggetto non verificato. Questa non legge né scrive dati di nessuna sede:
// non c'è niente da isolare, e un'esenzione nella route farebbe crescere il
// conto delle esenzioni per una chiamata che non ne ha bisogno. La chiamata VERA,
// sulla scheda dell'alunno, resta nella route, dopo il gate, sotto il lock.
// =============================================================================

/** L'uuid della sonda: l'uuid nullo, che nessuna scheda porta. */
export const SONDA_ALUNNO = '00000000-0000-0000-0000-000000000000'

export type EsitoSondaEliminazione =
  /** La funzione c'è e ha risposto come la migrazione dice. */
  | { esito: 'presente' }
  /** La funzione non c'è (`PGRST202`): database non migrato. */
  | { esito: 'assente'; errore: unknown }
  /** La chiamata non è riuscita per un altro motivo. */
  | { esito: 'guasto'; errore: unknown }
  /** La funzione c'è ma risponde in un modo che la migrazione non prevede: non si sa che cosa farà. */
  | { esito: 'inattesa'; codice: string }

/**
 * Chiede se `elimina_alunno_definitivo` esiste, senza effetti. Non logga: chi la
 * chiama sa per quale scheda la sta chiedendo, e scrive il log con quell'id.
 */
export async function sondaFunzioneEliminazione(supabase: SupabaseClient): Promise<EsitoSondaEliminazione> {
  const { data, error } = await supabase.rpc('elimina_alunno_definitivo', {
    p_alunno: SONDA_ALUNNO,
    p_con_pagamenti: false,
  })
  if (error) {
    if ((error as { code?: string }).code === 'PGRST202') return { esito: 'assente', errore: error }
    return { esito: 'guasto', errore: error }
  }
  const risposta = data as { ok?: boolean; code?: string } | null
  if (risposta?.ok === false && risposta.code === 'non_trovato') return { esito: 'presente' }
  return { esito: 'inattesa', codice: risposta?.code ?? 'risposta-illeggibile' }
}
