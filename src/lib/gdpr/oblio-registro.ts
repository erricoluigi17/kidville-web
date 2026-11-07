import type { SupabaseClient } from '@supabase/supabase-js'
import { ARCHIVE_ERASURE } from '@/lib/forms/signed-path'
import { aBlocchi } from '@/lib/db/blocchi'
import { schemaAssente } from '@/lib/news/schema-assente'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { sediReali } from '@/lib/scuole/reali'

/**
 * L'OBLIO E LA RETENTION SCRIVONO IL REGISTRO DELL'ANNO SOLO DA QUI (Compito 3.6).
 *
 * Quando la guardia dell'anno chiuso sarà accesa, una cancellazione dovuta per legge deve continuare a funzionare
 * senza gettone: passa dalle RPC di M3 (`anno_oblio_scrivi`, `anno_oblio_svuota`), che accendono l'interruttore
 * `anno_chiuso.oblio` DENTRO la transazione e hanno un'allowlist di coppie azione/tabella/colonna. Una `.from(tabella)`
 * diretta su una tabella del registro, in questa zona, è il bug che il lock del 3.9 cerca.
 *
 * ─── IL RIPIEGO ───────────────────────────────────────────────────────────────
 * Il DB della CI non è migrato: l'RPC risponde `PGRST202`. Lì (e solo lì) si scrive in modo diretto, ma con la STESSA
 * cintura che l'SQL mette alla coppia: un ripiego senza cintura cancellerebbe sul DB della CI ciò che l'RPC protegge in
 * produzione. Un rifiuto dell'allowlist (`OBLIO_NON_AMMESSO`) invece NON si aggira mai.
 *
 * Mai i valori del filtro o del `set` nei log: solo `op`, tabella, azione, conteggi e codici.
 */

export type AzioneOblio = 'update' | 'delete' | 'delete_cestino'

export type EsitoOblio =
  | { ok: true; righe: number; via: 'rpc' | 'diretta' }
  | { ok: false; codice?: string }

/** I valori del filtro si dividono a blocchi: come facevano i siti, uno per volta. */
export const BLOCCO_OBLIO = 200

/**
 * La copia TypeScript dell'allowlist di `anno_oblio_scrivi` (M3). Serve SOLO al ripiego: l'RPC ha la sua, dentro il
 * `CASE`. Un test confronta questo elenco con quel `CASE`, letto come testo.
 */
export const COPPIE_OBLIO_AMMESSE: readonly string[] = [
  'update|chat_messages|id',
  'update|enrollment_submissions|id',
  'delete|enrollment_submissions|id',
  'update|galleria_media_v2|id',
  'delete|galleria_media_v2|id',
  'delete_cestino|galleria_media_v2|id',
  'update|eventi_diario|alunno_id',
  'update|eventi_diario|id',
  'update|presenze|alunno_id',
  'update|frequenze|alunno_id',
  'delete|student_documents|id',
  'delete_cestino|student_documents|id',
  'delete|pagelle|id',
  'delete|forms_submissions|id',
]

type Riposta = { count: number | null; error: { code?: string; message?: string } | null }
type Costruttore = PromiseLike<Riposta> & {
  in(colonna: string, valori: string[]): Costruttore
  not(colonna: string, operatore: string, valore: unknown): Costruttore
  lt(colonna: string, valore: string): Costruttore
  eq(colonna: string, valore: unknown): Costruttore
  neq(colonna: string, valore: unknown): Costruttore
  or(filtro: string): Costruttore
}
type TabellaDiretta = {
  update(set: Record<string, unknown>, opzioni: { count: 'exact' }): Costruttore
  delete(opzioni: { count: 'exact' }): Costruttore
}

export interface OpzioniOblio {
  azione: AzioneOblio
  tabella: string
  colonnaFiltro: string
  valoriFiltro: string[]
  /** Solo per `update`. */
  set?: Record<string, unknown>
  /** Il nome della route/dell'operazione: finisce nel riepilogo che l'RPC scrive. */
  op: string
  /** Solo per `delete_cestino` su `student_documents`: la soglia ISO (cintura «scaduto da prima di»). */
  primaDi?: string
}

/** Un errore PostgREST senza messaggio libero: il messaggio può citare un valore (`invalid input … "<uuid>"`). */
function errorePulito(codice: string | undefined): Error {
  return new Error(codice ?? 'errore-oblio')
}

/**
 * Un errore dell'RPC o del ripiego. Sullo schema assente (DB della CI non migrato: tabella o colonna che non c'è) si
 * tace a livello `info`, come facevano i siti con `schemaAssente`; su tutto il resto è `logErrore` con l'`op`.
 */
function segnalaErrore(op: string, evento: string, codice: string | undefined): void {
  if (schemaAssente({ code: codice })) {
    logEvento('gdpr', 'info', { operazione: op, esito: 'oblio-schema-assente', evento, error_code: codice ?? '' })
    return
  }
  logErrore({ operazione: op, evento }, errorePulito(codice))
}

function ripiegoDiretto(supabase: SupabaseClient, o: OpzioniOblio, blocco: string[]): Costruttore {
  const t = supabase.from(o.tabella) as unknown as TabellaDiretta
  if (o.azione === 'update') {
    const set = o.set ?? {}
    let q = t.update(set, { count: 'exact' }).in(o.colonnaFiltro, blocco)
    // Il filtro dei siti di oggi: «solo le righe che hanno ancora il dato». Vale quando il `set` AZZERA (tutti i valori
    // null); con un valore da scrivere (`dettagli`) l'RPC confronta con `IS DISTINCT FROM`, qui si riscrive e basta.
    const chiavi = Object.keys(set)
    if (chiavi.length > 0 && chiavi.every((k) => set[k] === null)) {
      q = q.or(chiavi.map((k) => `${k}.not.is.null`).join(','))
    }
    return q
  }
  let q = t.delete({ count: 'exact' }).in(o.colonnaFiltro, blocco)
  // Le CINTURE della coppia, le stesse dell'SQL (`v_cintura`).
  if (o.azione === 'delete_cestino') {
    q = q.not('eliminato_il', 'is', null)
    if (o.tabella === 'student_documents') q = q.lt('eliminato_il', o.primaDi as string)
  } else if (o.tabella === 'forms_submissions') {
    q = q.eq(`signature_log->>${ARCHIVE_ERASURE}`, true)
  }
  return q
}

/**
 * Il livello del log del ripiego su `PGRST202` (la funzione `anno_oblio_*` non c'è). Sul database della CI, che ha
 * solo la sede finta, è la condizione normale: `info`. Dove ci sono sedi REALI vuol dire che la migrazione M3 manca
 * o che la cache dello schema è vecchia, cioè configurazione mancante: `error` (AGENTS.md, regola 4). Se le sedi
 * non si leggono non si sa che ambiente sia: `error`, perché «non lo so» non è «sono in CI». Il ripiego scrive lo
 * stesso, in entrambi i casi.
 */
async function livelloRipiego(supabase: SupabaseClient, op: string): Promise<'error' | 'info'> {
  const { reali, error } = await sediReali(supabase, op)
  return error || reali.length > 0 ? 'error' : 'info'
}

export async function scriviOblio(supabase: SupabaseClient, o: OpzioniOblio): Promise<EsitoOblio> {
  const chiave = `${o.azione}|${o.tabella}|${o.colonnaFiltro}`
  if (o.valoriFiltro.length === 0) return { ok: true, righe: 0, via: 'rpc' }

  let righe = 0
  let diretta = false
  for (const blocco of aBlocchi(o.valoriFiltro, BLOCCO_OBLIO)) {
    if (!diretta) {
      const { data, error } = await supabase.rpc('anno_oblio_scrivi', {
        p_azione: o.azione,
        p_tabella: o.tabella,
        p_colonna: o.colonnaFiltro,
        p_valori: blocco,
        p_set: o.azione === 'update' ? (o.set ?? {}) : null,
        p_op: o.op,
        p_prima_di: o.primaDi ?? null,
      })
      if (!error) {
        righe += Number(data ?? 0)
        continue
      }
      if (error.code !== 'PGRST202') {
        // `OBLIO_NON_AMMESSO` arriva come messaggio dell'eccezione: un rifiuto della lista non si aggira.
        const codice = error.message === 'OBLIO_NON_AMMESSO' || (error.message ?? '').startsWith('OBLIO_NON_AMMESSO')
          ? 'OBLIO_NON_AMMESSO'
          : error.code
        segnalaErrore(o.op, `oblio_${o.tabella}_${o.azione}`, codice)
        return { ok: false, ...(codice ? { codice } : {}) }
      }
      // PGRST202: la funzione non c'è (DB della CI non migrato) → si ripiega, una volta per chiamata.
      diretta = true
      logEvento('gdpr', await livelloRipiego(supabase, o.op), {
        operazione: o.op,
        esito: 'oblio-ripiego-diretto',
        azione: o.azione,
        evento: `oblio_${o.tabella}`,
        error_code: 'PGRST202',
      })
    }

    if (
      !COPPIE_OBLIO_AMMESSE.includes(chiave) ||
      (o.azione === 'delete_cestino' && o.tabella === 'student_documents' && !o.primaDi)
    ) {
      segnalaErrore(o.op, `oblio_${o.tabella}_${o.azione}`, 'OBLIO_NON_AMMESSO')
      return { ok: false, codice: 'OBLIO_NON_AMMESSO' }
    }
    const { count, error } = await ripiegoDiretto(supabase, o, blocco)
    if (error) {
      segnalaErrore(o.op, `oblio_${o.tabella}_${o.azione}`, error.code)
      return { ok: false, ...(error.code ? { codice: error.code } : {}) }
    }
    righe += count ?? 0
  }
  return { ok: true, righe, via: diretta ? 'diretta' : 'rpc' }
}

export type EsitoSvuota =
  | { ok: true; righe: number; via: 'rpc' | 'diretta' }
  | { ok: false; codice?: string; errori: unknown[] }

const SOLO_ID = new Set(['alunni', 'parents', 'adults'])
const UUID_NULLO = '00000000-0000-0000-0000-000000000000'

/**
 * Svuota UNA tabella del wipe (la lista di `anno_oblio_svuota` in M3: 23 tabelle più `alunni`, `parents`, `adults`).
 * Il ripiego (DB della CI) conserva le due forme di oggi: è pulita se ALMENO UNA delle due DELETE è riuscita, perché non
 * tutte le tabelle hanno sia `id` sia `created_at`; `alunni`, `parents`, `adults` hanno la sola forma per `id`.
 * `errori` porta gli errori grezzi di PostgREST, per chi deve distinguere «tabella assente» da «non svuotata».
 */
export async function svuotaOblio(supabase: SupabaseClient, tabella: string, op: string): Promise<EsitoSvuota> {
  const { data, error } = await supabase.rpc('anno_oblio_svuota', { p_tabella: tabella, p_op: op })
  if (!error) return { ok: true, righe: Number(data ?? 0), via: 'rpc' }
  if (error.code !== 'PGRST202') {
    const codice = (error.message ?? '').startsWith('OBLIO_NON_AMMESSO') ? 'OBLIO_NON_AMMESSO' : error.code
    segnalaErrore(op, `oblio_svuota_${tabella}`, codice)
    return { ok: false, ...(codice ? { codice } : {}), errori: [error] }
  }
  logEvento('gdpr', await livelloRipiego(supabase, op), {
    operazione: op,
    esito: 'oblio-ripiego-diretto',
    azione: 'svuota',
    evento: `oblio_${tabella}`,
    error_code: 'PGRST202',
  })
  const forme: Array<() => PromiseLike<Riposta>> = [
    () => (supabase.from(tabella) as unknown as TabellaDiretta).delete({ count: 'exact' }).neq('id', UUID_NULLO),
  ]
  if (!SOLO_ID.has(tabella)) {
    forme.push(() => (supabase.from(tabella) as unknown as TabellaDiretta).delete({ count: 'exact' }).not('created_at', 'is', null))
  }
  const errori: unknown[] = []
  let righe = 0
  for (const f of forme) {
    const r = await f()
    if (r.error) errori.push(r.error)
    else righe += r.count ?? 0
  }
  if (errori.length === forme.length) return { ok: false, errori }
  return { ok: true, righe, via: 'diretta' }
}
