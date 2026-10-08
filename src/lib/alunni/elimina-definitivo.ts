import type { SupabaseClient } from '@supabase/supabase-js'
import { contaCosaDistrugge, type ConteggiOblio } from '@/lib/gdpr/cosa-distrugge'
import {
  BUCKET_ISCRIZIONI,
  obliaAllegatiChat,
  obliaCertificatiMediciAlunno,
  obliaFascicoloAlunno,
  obliaFotoAlunno,
  obliaIntentiVideoAlunno,
} from '@/lib/gdpr/esegui'
import { obliaFotoNewsAlunno } from '@/lib/news/permanenza-consenso'
import { bloccanti, rimuoviEVerifica } from '@/lib/storage/rimozione-verificata'
import { leggiRegistroPrimaria } from '@/lib/alunni/registro-primaria'
import { logErrore } from '@/lib/logging/logger'

// =============================================================================
// ELIMINAZIONE DEFINITIVA — il motore della route `admin/students/elimina`.
//
// Tre pezzi, ognuno con un compito solo:
//  · `contaPerEliminazione` — SOLE `SELECT`: che cosa è collegato alla scheda.
//    Dove non riesce a leggere risponde `ok: false`, mai uno zero: davanti a
//    un'operazione senza annulla «non lo so» non può travestirsi da «niente».
//  · `scelteDisponibili` — pura: dai numeri alle scelte offerte, con il motivo.
//    È la tabella delle decisioni del titolare (2026-10-08), in un posto solo.
//  · `rimuoviFileAlunno` — i FILE, prima del database, con le stesse funzioni
//    dell'oblio (nessuna copia: `gdpr-erase-canale-unico`). Le pagelle non ci
//    sono perché il registro della primaria blocca l'eliminazione a monte.
// =============================================================================

export type SceltaEliminazione = 'elimina' | 'elimina_con_pagamenti' | 'anonimizza'

export type MotivoBloccoEliminazione =
  | 'REGISTRO_PRIMARIA_DA_CONSERVARE'
  | 'ALUNNO_ELIMINAZIONE_HA_PAGAMENTI'
  | 'ALUNNO_ELIMINAZIONE_PAGAMENTI_BLOCCATI'

export interface ConteggiEliminazione extends ConteggiOblio {
  presenze: number
  diario: number
  legami_genitori: number
  pagamenti: number
  /** Pagamenti con ricevuta, fattura, bonifico abbinato, incasso o quote altrui + ricevute senza pagamento. */
  pagamenti_bloccati: number
  registro_primaria: boolean
}

export type EsitoMisura = { ok: true; conteggi: ConteggiEliminazione } | { ok: false }

export function scelteDisponibili(c: {
  pagamenti: number
  pagamenti_bloccati: number
  registro_primaria: boolean
}): { scelte: Record<SceltaEliminazione, boolean>; motivo: MotivoBloccoEliminazione | null } {
  if (c.registro_primaria) {
    return {
      scelte: { elimina: false, elimina_con_pagamenti: false, anonimizza: false },
      motivo: 'REGISTRO_PRIMARIA_DA_CONSERVARE',
    }
  }
  if (c.pagamenti > 0 || c.pagamenti_bloccati > 0) {
    const bloccati = c.pagamenti_bloccati > 0
    return {
      scelte: { elimina: false, elimina_con_pagamenti: !bloccati, anonimizza: true },
      motivo: bloccati ? 'ALUNNO_ELIMINAZIONE_PAGAMENTI_BLOCCATI' : 'ALUNNO_ELIMINAZIONE_HA_PAGAMENTI',
    }
  }
  return { scelte: { elimina: true, elimina_con_pagamenti: false, anonimizza: false }, motivo: null }
}

async function conta(
  supabase: SupabaseClient,
  tabella: string,
  colonna: string,
  id: string,
  op: string,
): Promise<number | null> {
  const { count, error } = await supabase
    .from(tabella)
    .select(colonna, { count: 'exact', head: true })
    .eq(colonna, id)
  // ⚠️ Con `head: true` una richiesta HEAD non ha corpo: un 404 (tabella assente,
  // gateway) torna come `error: null, count: null`, e gli altri errori arrivano
  // senza `code`. `count === null` è quindi un GUASTO, mai uno zero
  // (postgrest-js 2.112, `dist/index.cjs:488-503`; misurato in revisione).
  if (error || count === null) {
    logErrore({ operazione: op, evento: `elimina_conta_${tabella}` }, error ?? { message: 'conteggio assente' })
    return null
  }
  return count
}

async function idsDove(
  supabase: SupabaseClient,
  tabella: string,
  colonnaId: string,
  colonnaFiltro: string,
  valori: string[],
  op: string,
): Promise<Set<string> | null> {
  // Nessun valore ⇒ nessuna query: un `in` con lista vuota su PostgREST è un
  // filtro che non filtra.
  if (valori.length === 0) return new Set()
  const { data, error } = await supabase.from(tabella).select(colonnaId).in(colonnaFiltro, valori)
  if (error) {
    logErrore({ operazione: op, evento: `elimina_blocchi_${tabella}` }, error)
    return null
  }
  return new Set(
    ((data ?? []) as unknown as Record<string, unknown>[])
      .map((r) => r[colonnaId])
      .filter((v): v is string => typeof v === 'string'),
  )
}

/**
 * Le tabelle che rendono un pagamento CONTABILITÀ VERA, cioè non cancellabile.
 * Stessa regola della funzione SQL `elimina_alunno_definitivo`, che la ricontrolla
 * da sé dentro la transazione: questa è l'anteprima, quella è la porta.
 */
const TABELLE_CHE_BLOCCANO_UN_PAGAMENTO = [
  'ricevute_emesse',
  'fatture_emesse',
  'riconciliazione_movimenti',
  'incassi',
] as const

export async function contaPerEliminazione(
  supabase: SupabaseClient,
  alunnoId: string,
  op: string,
): Promise<EsitoMisura> {
  const oblio = await contaCosaDistrugge(supabase, alunnoId, op)
  if (Object.values(oblio).some((v) => v === null)) return { ok: false }

  const presenze = await conta(supabase, 'presenze', 'alunno_id', alunnoId, op)
  const diario = await conta(supabase, 'eventi_diario', 'alunno_id', alunnoId, op)
  const legami = await conta(supabase, 'student_parents', 'student_id', alunnoId, op)
  if (presenze === null || diario === null || legami === null) return { ok: false }

  const { data: pag, error: pagErr } = await supabase
    .from('pagamenti')
    .select('id')
    .eq('alunno_id', alunnoId)
  if (pagErr) {
    logErrore({ operazione: op, evento: 'elimina_conta_pagamenti' }, pagErr)
    return { ok: false }
  }
  const pagIds = ((pag ?? []) as { id: string }[]).map((p) => p.id)

  // Quali pagamenti sono contabilità vera: stessa regola della funzione SQL.
  const bloccati = new Set<string>()
  for (const tabella of TABELLE_CHE_BLOCCANO_UN_PAGAMENTO) {
    const ids = await idsDove(supabase, tabella, 'pagamento_id', 'pagamento_id', pagIds, op)
    if (ids === null) return { ok: false }
    ids.forEach((id) => bloccati.add(id))
  }
  // Le quote di un ALTRO alunno appese a un suo pagamento: la cascata su
  // `parent_payment_id` le porterebbe via. `alunno_id` nullo conta come «altro»,
  // come `is distinct from` in SQL.
  if (pagIds.length > 0) {
    const { data: figli, error: figliErr } = await supabase
      .from('pagamenti')
      .select('parent_payment_id, alunno_id')
      .in('parent_payment_id', pagIds)
    if (figliErr) {
      logErrore({ operazione: op, evento: 'elimina_blocchi_quote' }, figliErr)
      return { ok: false }
    }
    for (const f of (figli ?? []) as { parent_payment_id: string | null; alunno_id: string | null }[]) {
      if (f.parent_payment_id && f.alunno_id !== alunnoId) bloccati.add(f.parent_payment_id)
    }
  }
  // Le ricevute dell'alunno che non stanno su un suo pagamento: in SQL ogni
  // ricevuta dell'alunno blocca, e quelle su un suo pagamento sono già contate
  // qui sopra come pagamento bloccato.
  const ricevuteSenzaPagamento = await supabase
    .from('ricevute_emesse')
    .select('id, pagamento_id')
    .eq('alunno_id', alunnoId)
  if (ricevuteSenzaPagamento.error) {
    logErrore({ operazione: op, evento: 'elimina_conta_ricevute' }, ricevuteSenzaPagamento.error)
    return { ok: false }
  }
  const orfane = ((ricevuteSenzaPagamento.data ?? []) as { pagamento_id: string | null }[]).filter(
    (r) => r.pagamento_id === null || !pagIds.includes(r.pagamento_id),
  ).length

  const registro = await leggiRegistroPrimaria(supabase, alunnoId)
  if (!registro.ok) {
    logErrore({ operazione: op, evento: 'elimina_registro_primaria' }, registro.errore)
    return { ok: false }
  }

  return {
    ok: true,
    conteggi: {
      ...oblio,
      presenze,
      diario,
      legami_genitori: legami,
      pagamenti: pagIds.length,
      pagamenti_bloccati: bloccati.size + orfane,
      registro_primaria: registro.presente,
    },
  }
}

export interface EsitoFileAlunno {
  ok: boolean
  numeri: {
    foto_rimosse: number
    foto_sganciate: number
    news_ritirate: number
    certificati: number
    fascicolo: number
    allegati_chat: number
    documento: number
    restanti: number
  }
}

/**
 * Toglie i FILE del bambino, PRIMA del database. `ok: false` se anche un solo
 * file non è uscito o un inventario non si è potuto leggere: allora la route si
 * ferma e la scheda resta intatta.
 *
 * Dal blog pubblico contano `fileNonRimossi` e non `fileTrattenuti`, come
 * nell'oblio (`anonimizzaAlunno`): un file «trattenuto» resta perché un ALTRO
 * articolo, che questo bambino non lo dichiara, lo nomina ancora — nessun nuovo
 * tentativo lo toglierebbe, e `obliaFotoNewsAlunno` lo logga già a livello `error`.
 */
export async function rimuoviFileAlunno(
  supabase: SupabaseClient,
  alunno: { id: string; documento_path?: string | null },
  op: string,
): Promise<EsitoFileAlunno> {
  const foto = await obliaFotoAlunno(supabase, alunno.id, op)
  const news = await obliaFotoNewsAlunno(supabase, alunno.id, op)
  const video = await obliaIntentiVideoAlunno(supabase, alunno.id, op)
  const certificati = await obliaCertificatiMediciAlunno(supabase, alunno.id, op)
  const fascicolo = await obliaFascicoloAlunno(supabase, alunno.id, op)

  const { data: thread, error: threadErr } = await supabase
    .from('chat_threads')
    .select('id')
    .eq('student_id', alunno.id)
  if (threadErr) logErrore({ operazione: op, evento: 'elimina_thread_chat' }, threadErr)
  const chat = threadErr
    ? { rimossi: 0, nonRimossi: 0, fermi: [], letto: false }
    : await obliaAllegatiChat(supabase, ((thread ?? []) as { id: string }[]).map((t) => t.id), op)

  const documento = await rimuoviEVerifica(supabase, BUCKET_ISCRIZIONI, [alunno.documento_path], op)
  const documentoRestanti = bloccanti(documento).length + (documento.erroreRimozione ? 1 : 0)

  const restanti =
    foto.fileNonRimossi +
    news.fileNonRimossi +
    certificati.nonRimossi +
    fascicolo.nonRimossi +
    chat.nonRimossi +
    documentoRestanti
  const tuttoLetto = foto.letto && news.letto && video.letto && certificati.letto && fascicolo.letto && chat.letto

  return {
    ok: tuttoLetto && restanti === 0,
    numeri: {
      foto_rimosse: foto.fotoRimosse,
      foto_sganciate: foto.fotoSganciate,
      news_ritirate: news.ritirati,
      certificati: certificati.rimossi,
      fascicolo: fascicolo.rimossi,
      allegati_chat: chat.rimossi,
      documento: documento.rimossi.length,
      restanti,
    },
  }
}
