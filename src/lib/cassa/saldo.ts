import type { SupabaseClient } from '@supabase/supabase-js'
import { oggiFiscaleISO } from '@/lib/format/fiscal-date'
import { logErrore, logEvento } from '@/lib/logging/logger'
import type { SaldoCassa, CassaNonDisponibile, EntratoOggiVoce, CassaMovimento } from './tipi'

// =============================================================================
// MODULO CASSA · logica del saldo (contratto §3.2).
//
// «Saldo atteso» = quanto contante DEVE esserci fisicamente nel cassetto:
//   fondo + entrate contanti auto (incassi) + entrate manuali contanti
//   + rettifiche − uscite contanti − prelievi.
//
// Le entrate auto NON si duplicano nel ledger: si calcolano a query-time dagli
// `incassi` con metodo='contanti'. TRAPPOLA (incassi/storno/route.ts:80): lo
// storno di un incasso crea un contro-incasso con metodo='storno' (o 'altro'
// degradato) e `storno_di` = originale — sommare solo metodo='contanti' NON
// basta, il saldo resterebbe gonfiato. Va sottratto risalendo al metodo
// dell'incasso originale via `storno_di`.
// =============================================================================

/** Codici PostgREST «schema cassa assente» (DB E2E CI non migrato). */
export const CASSA_SCHEMA_ASSENTE = new Set(['42P01', '42703', 'PGRST202', 'PGRST204', 'PGRST205'])

/** Metodi incasso che NON sono contante reale (esclusi da «entrato oggi»). */
const METODI_NON_REALI = new Set(['storno', 'rettifica', 'credito_famiglia'])

type IncassoRiga = { id: string; importo: number; metodo: string; storno_di: string | null }

/**
 * PURA. Entrate contanti NETTE dagli incassi: Σ degli incassi metodo='contanti'
 * più gli storni (importo negativo) il cui `storno_di` punta a un incasso
 * contanti presente nel set. Lo storno di un incasso non-contanti NON tocca il
 * totale (l'originale non era contato, il suo storno neppure).
 */
export function sommaEntrateAutoContanti(incassi: IncassoRiga[]): number {
  const metodoById = new Map<string, string>()
  for (const i of incassi) metodoById.set(i.id, i.metodo)

  let tot = 0
  for (const i of incassi) {
    if (i.storno_di) {
      // Riga di storno: sottrai (importo già negativo) solo se l'originale era contanti.
      if (metodoById.get(i.storno_di) === 'contanti') tot += Number(i.importo)
    } else if (i.metodo === 'contanti') {
      tot += Number(i.importo)
    }
  }
  return round2(tot)
}

/**
 * PURA. Aggregati dei movimenti cassa. Gli storni sono contro-movimenti con lo
 * stesso `tipo` e `metodo` e importo negato: ogni Σ per tipo si auto-corregge.
 * Solo le uscite/entrate in CONTANTI muovono il saldo; prelievi e rettifiche
 * sono per definizione in contanti (svuotamento / differenza di cassa).
 */
export function calcolaAggregatiMovimenti(
  movimenti: Pick<CassaMovimento, 'tipo' | 'importo' | 'metodo'>[],
): { entrateManualiContanti: number; usciteContanti: number; prelievi: number; rettifiche: number } {
  let entrateManualiContanti = 0
  let usciteContanti = 0
  let prelievi = 0
  let rettifiche = 0
  for (const m of movimenti) {
    const importo = Number(m.importo)
    if (m.tipo === 'entrata' && m.metodo === 'contanti') entrateManualiContanti += importo
    else if (m.tipo === 'uscita' && m.metodo === 'contanti') usciteContanti += importo
    else if (m.tipo === 'prelievo') prelievi += importo
    else if (m.tipo === 'rettifica') rettifiche += importo
  }
  return {
    entrateManualiContanti: round2(entrateManualiContanti),
    usciteContanti: round2(usciteContanti),
    prelievi: round2(prelievi),
    rettifiche: round2(rettifiche),
  }
}

/**
 * Orchestrazione: fondo + incassi contanti + movimenti → SaldoCassa.
 * Ritorna { disponibile: false } su codici CASSA_SCHEMA_ASSENTE (mai lancia).
 */
export async function caricaSaldoCassa(
  supabase: SupabaseClient,
  scuolaId: string,
  fondo: number,
): Promise<SaldoCassa | CassaNonDisponibile> {
  // 1) Movimenti cassa della sede. È la query che degrada sul DB CI non migrato
  //    (cassa_movimenti assente): senza il ledger non c'è saldo → non disponibile.
  const { data: movRaw, error: eMov } = await supabase
    .from('cassa_movimenti')
    .select('tipo, importo, metodo')
    .eq('scuola_id', scuolaId)
  if (eMov) {
    const code = (eMov as { code?: string }).code ?? ''
    if (CASSA_SCHEMA_ASSENTE.has(code)) {
      logEvento('cassa', 'info', { operazione: 'caricaSaldoCassa', esito: 'schema-assente' })
      return { disponibile: false }
    }
    logErrore({ operazione: 'caricaSaldoCassa', stato: 500, evento: 'db' }, eMov)
    return { disponibile: false }
  }
  const movimenti = (movRaw ?? []) as { tipo: CassaMovimento['tipo']; importo: number; metodo: CassaMovimento['metodo'] }[]

  // 2) Entrate auto dagli incassi contanti della sede (netto storni).
  const incassi = await incassiPerSaldo(supabase, scuolaId)

  const aggr = calcolaAggregatiMovimenti(movimenti)
  const entrateAuto = sommaEntrateAutoContanti(incassi)
  const entrate_contanti = round2(entrateAuto + aggr.entrateManualiContanti)
  const saldo_atteso = round2(
    fondo + entrateAuto + aggr.entrateManualiContanti + aggr.rettifiche - aggr.usciteContanti - aggr.prelievi,
  )

  const entrato_oggi = await caricaEntratoOggi(supabase, scuolaId)

  return {
    disponibile: true,
    fondo: round2(fondo),
    saldo_atteso,
    entrate_contanti,
    uscite_contanti: aggr.usciteContanti,
    prelievi: aggr.prelievi,
    rettifiche: aggr.rettifiche,
    entrato_oggi,
  }
}

/**
 * Incassi rilevanti per il saldo cassa: sede attribuita correttamente anche con
 * `pagamenti.scuola_id` NULL (fallback via `alunni.scuola_id`). Include gli
 * storni (servono per il netting). Righe irrisolvibili (alunno_id null o alunno
 * non trovato) → escluse e conteggiate in un warn (non gonfiano né sgonfiano).
 */
async function incassiPerSaldo(supabase: SupabaseClient, scuolaId: string): Promise<IncassoRiga[]> {
  const righe: IncassoRiga[] = []

  // A) Diretti: pagamento con scuola_id = scuolaId.
  const diretti = await supabase
    .from('incassi')
    .select('id, importo, metodo, storno_di, pagamenti!inner(scuola_id)')
    .eq('pagamenti.scuola_id', scuolaId)
  if (diretti.error) {
    logErrore({ operazione: 'caricaSaldoCassa', stato: 500, evento: 'db' }, diretti.error)
  } else {
    for (const r of (diretti.data ?? []) as Record<string, unknown>[]) {
      righe.push({ id: String(r.id), importo: Number(r.importo), metodo: String(r.metodo), storno_di: (r.storno_di as string | null) ?? null })
    }
  }

  // B) Con pagamento a scuola_id NULL → risalita a alunni.scuola_id.
  const nulli = await supabase
    .from('incassi')
    .select('id, importo, metodo, storno_di, pagamenti!inner(scuola_id, alunno_id)')
    .is('pagamenti.scuola_id', null)
  if (nulli.error) {
    // Non blocca il saldo: gli incassi senza sede diretta sono rari. Solo warn.
    logEvento('cassa', 'warn', { operazione: 'caricaSaldoCassa', esito: 'incassi-null-non-letti' }, nulli.error)
  } else {
    const daRisolvere = (nulli.data ?? []) as Record<string, unknown>[]
    const alunnoIds = [...new Set(daRisolvere.map((r) => alunnoIdDi(r)).filter((x): x is string => !!x))]
    const mappa = new Map<string, string | null>()
    if (alunnoIds.length) {
      const al = await supabase.from('alunni').select('id, scuola_id').in('id', alunnoIds)
      if (al.error) {
        logEvento('cassa', 'warn', { operazione: 'caricaSaldoCassa', esito: 'alunni-non-letti' }, al.error)
      } else {
        for (const a of (al.data ?? []) as { id: string; scuola_id: string | null }[]) mappa.set(a.id, a.scuola_id)
      }
    }
    let senzaSede = 0
    for (const r of daRisolvere) {
      const aid = alunnoIdDi(r)
      const sede = aid ? mappa.get(aid) ?? null : null
      if (sede === scuolaId) {
        righe.push({ id: String(r.id), importo: Number(r.importo), metodo: String(r.metodo), storno_di: (r.storno_di as string | null) ?? null })
      } else if (!aid || !mappa.has(aid) || sede == null) {
        senzaSede++
      }
      // else: appartiene a un'altra sede → escluso senza conteggiarlo come "senza sede".
    }
    if (senzaSede > 0) {
      logEvento('cassa', 'warn', { operazione: 'caricaSaldoCassa', esito: 'incassi-senza-sede', quantita: senzaSede })
    }
  }

  return righe
}

/** Estrae l'alunno_id dall'embed pagamenti (to-one → oggetto; difensivo su array). */
function alunnoIdDi(row: Record<string, unknown>): string | null {
  const p = row.pagamenti
  const obj = Array.isArray(p) ? (p[0] as Record<string, unknown> | undefined) : (p as Record<string, unknown> | undefined)
  const aid = obj?.alunno_id
  return typeof aid === 'string' ? aid : null
}

/** Estrae la scuola_id dall'embed pagamenti (to-one → oggetto; difensivo su array). */
function scuolaIdDi(row: Record<string, unknown>): string | null {
  const p = row.pagamenti
  const obj = Array.isArray(p) ? (p[0] as Record<string, unknown> | undefined) : (p as Record<string, unknown> | undefined)
  const sid = obj?.scuola_id
  return typeof sid === 'string' ? sid : null
}

/**
 * «Entrato oggi» = incassi con data_incasso = oggi (Europe/Rome), sede risolta,
 * stornato_il IS NULL, metodo reale (esclusi storno/rettifica/credito_famiglia),
 * raggruppati per metodo. Ritorna [] su qualunque errore (voce cosmetica).
 */
export async function caricaEntratoOggi(supabase: SupabaseClient, scuolaId: string): Promise<EntratoOggiVoce[]> {
  const oggi = oggiFiscaleISO()
  const { data, error } = await supabase
    .from('incassi')
    .select('importo, metodo, stornato_il, pagamenti!inner(scuola_id, alunno_id)')
    .eq('data_incasso', oggi)
    .is('stornato_il', null)
  if (error) {
    logEvento('cassa', 'warn', { operazione: 'caricaEntratoOggi', esito: 'incassi-non-letti' }, error)
    return []
  }

  const righe = (data ?? []) as Record<string, unknown>[]
  // Risolvi la sede (diretta o via alunno) per le righe con scuola_id null.
  const daRisolvere = righe.filter((r) => scuolaIdDi(r) == null)
  const alunnoIds = [...new Set(daRisolvere.map((r) => alunnoIdDi(r)).filter((x): x is string => !!x))]
  const mappa = new Map<string, string | null>()
  if (alunnoIds.length) {
    const al = await supabase.from('alunni').select('id, scuola_id').in('id', alunnoIds)
    if (al.error) {
      logEvento('cassa', 'warn', { operazione: 'caricaEntratoOggi', esito: 'alunni-non-letti' }, al.error)
    } else {
      for (const a of (al.data ?? []) as { id: string; scuola_id: string | null }[]) mappa.set(a.id, a.scuola_id)
    }
  }

  const perMetodo = new Map<string, number>()
  for (const r of righe) {
    const metodo = String(r.metodo)
    if (METODI_NON_REALI.has(metodo)) continue
    const sedeDiretta = scuolaIdDi(r)
    let sede = sedeDiretta
    if (sede == null) {
      const aid = alunnoIdDi(r)
      sede = aid ? mappa.get(aid) ?? null : null
    }
    if (sede !== scuolaId) continue
    perMetodo.set(metodo, round2((perMetodo.get(metodo) ?? 0) + Number(r.importo)))
  }

  return [...perMetodo.entries()].map(([metodo, totale]) => ({ metodo, totale }))
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
