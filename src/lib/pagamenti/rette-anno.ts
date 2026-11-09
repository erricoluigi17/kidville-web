import type { SupabaseClient } from '@supabase/supabase-js'
import { schemaAnnoIndietro } from '@/lib/anno/schema'
import type { StatoAnno } from '@/lib/anno/tipi'
import { leggiABlocchi, type QueryABlocchi } from '@/lib/db/leggi-a-blocchi'
import { logEvento } from '@/lib/logging/logger'

/**
 * LE RETTE DI UN ANNO — gli aiuti TypeScript della PR 4.6.
 *
 * La regola «chi riceve la retta, di quanto, e perché no» sta in UN posto solo: la funzione SQL `rette_da_generare`
 * (M46a). Qui si trova l'anno che l'utente ha scelto, si legge quella funzione a blocchi, si riassume e si logga.
 * Niente di tutto questo ricalcola un importo: se l'anteprima e la generazione divergono, divergono in SQL e insieme.
 *
 * Il database della CI non ha ancora le funzioni (le migrazioni arrivano dopo il codice): ogni lettura che le
 * trova assenti risponde `schemaIndietro: true`, con una riga `info`, e chi chiama torna alla strada di prima.
 */

/** Una riga di `rette_da_generare`: un bambino, un mese. */
export type RigaRetta = {
  periodo: string
  alunno_id: string
  frequenza_id: string
  importo: number | null
  origine_importo: 'frequenza' | 'listino_fascia' | 'listino' | null
  esito: 'esente' | 'pagante_assente' | 'senza_importo' | 'da_generare'
  gia_generato: boolean
  posizione: number
}

export type EsitoLetturaRette =
  | { ok: true; righe: RigaRetta[] }
  | { ok: false; schemaIndietro: true }
  | { ok: false; errore: unknown }

export type EsitoAnnoSede =
  | { ok: true; annoSedeId: string; stato: StatoAnno }
  | { ok: false; codice: 'ANNO_NON_TROVATO' | 'schema-indietro' }
  | { ok: false; codice: 'errore'; errore: unknown }

type ErroreDb = { code?: string | null; message?: string } | null | undefined

function logSchemaIndietro(operazione: string, error: ErroreDb): void {
  logEvento('pagamento', 'info', {
    operazione,
    esito: 'rette-schema-indietro',
    error_code: typeof error?.code === 'string' ? error.code : 'sconosciuto',
  })
}

/** L'ultimo giorno del mese di una data `YYYY-MM-DD`. */
function ultimoDelMese(giorno: string): string {
  const [y, m] = giorno.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}

/**
 * L'anno di sede (`anni_sede`) che l'utente intende, dentro la SEDE data: per id (`annoSedeId`), per anno di inizio
 * (`anno`, come lo chiede il pannello: `2027` = 2027/28) o per il giorno che deve contenere (`periodo`, `YYYY-MM-DD`).
 * L'id e l'anno si cercano sempre con la sede: un anno di un'altra sede non si trova mai.
 */
export async function annoSedeDelPeriodo(
  supabase: SupabaseClient,
  scuolaId: string,
  scelta: { anno?: number; periodo?: string; annoSedeId?: string },
): Promise<EsitoAnnoSede> {
  const operazione = 'pagamenti/rette-anno:anno'
  const periodoValido = scelta.periodo && /^\d{4}-\d{2}-\d{2}$/.test(scelta.periodo) ? scelta.periodo : null
  if (!scelta.annoSedeId && scelta.anno == null && !periodoValido) return { ok: false, codice: 'ANNO_NON_TROVATO' }
  let q = supabase
    .from('anni_sede')
    .select(scelta.annoSedeId || scelta.anno == null ? 'id, stato' : 'id, stato, anni_scolastici!inner(anno_inizio)')
    .eq('scuola_id', scuolaId)
  if (scelta.annoSedeId) q = q.eq('id', scelta.annoSedeId)
  else if (scelta.anno != null) q = q.eq('anni_scolastici.anno_inizio', scelta.anno)
  // Il mese conta anche se l'anno comincia a metà: basta che il mese tocchi l'anno.
  else if (periodoValido) q = q.lte('inizio', ultimoDelMese(periodoValido)).gte('fine', periodoValido)
  const { data, error } = await q.limit(1)
  if (error) {
    if (schemaAnnoIndietro(error)) {
      logSchemaIndietro(operazione, error)
      return { ok: false, codice: 'schema-indietro' }
    }
    return { ok: false, codice: 'errore', errore: error }
  }
  const riga = ((data ?? []) as Array<{ id: string; stato: StatoAnno }>)[0]
  if (!riga) return { ok: false, codice: 'ANNO_NON_TROVATO' }
  return { ok: true, annoSedeId: riga.id, stato: riga.stato }
}

/**
 * Le righe di `rette_da_generare` per un anno (e, se dato, un mese e certi bambini), A BLOCCHI: dieci mesi di una sede
 * sono migliaia di righe e PostgREST ne consegna `max_rows` senza dirlo. L'ordine è quello della chiave (mese, frequenza).
 */
export async function leggiRetteDaGenerare(
  supabase: SupabaseClient,
  o: { annoSedeId: string; periodo?: string | null; alunnoIds?: string[] | null },
): Promise<EsitoLetturaRette> {
  const operazione = 'pagamenti/rette-anno:lettura'
  const letto = await leggiABlocchi<RigaRetta>(
    () =>
      supabase.rpc('rette_da_generare', {
        p_anno_sede: o.annoSedeId,
        p_periodo: o.periodo ?? null,
        p_alunno_ids: o.alunnoIds ?? null,
      }) as unknown as QueryABlocchi,
    { chiave: ['periodo', 'frequenza_id'] },
  )
  if (letto.ok) return { ok: true, righe: letto.righe }
  if (letto.motivo === 'errore') {
    if (schemaAnnoIndietro(letto.error as ErroreDb)) {
      logSchemaIndietro(operazione, letto.error as ErroreDb)
      return { ok: false, schemaIndietro: true }
    }
    return { ok: false, errore: letto.error }
  }
  // Oltre il tetto di blocchi: una lettura incompleta che sembra intera è peggio di un errore.
  return { ok: false, errore: new Error(`lettura-troncata: rette_da_generare oltre ${letto.oltre} righe`) }
}

export type RiepilogoRette = {
  /** Le righe che la conferma scriverà: `da_generare` e non ancora fatte. */
  candidati: number
  esenti: number
  /** Bambini senza una retta né nel loro profilo né nel listino: NON ricevono la voce. */
  senzaImporto: number
  paganteAssente: number
  giaGenerati: number
  /** Somma degli importi dei candidati (prima degli sconti). */
  totale: number
  /** Quanti candidati per origine dell'importo: `frequenza`, `listino_fascia`, `listino`. */
  perOrigine: Record<string, number>
}

/**
 * Le righe in numeri. `senza_importo` e `pagante_assente` si contano solo se la voce NON c'è già: chi ha la sua retta
 * di quel mese (fatta a mano, o prima) non ha nulla che manca. `esenti` si contano comunque (è una scelta della segreteria).
 */
export function riepilogoRette(righe: readonly RigaRetta[]): RiepilogoRette {
  const r: RiepilogoRette = { candidati: 0, esenti: 0, senzaImporto: 0, paganteAssente: 0, giaGenerati: 0, totale: 0, perOrigine: {} }
  for (const x of righe) {
    if (x.gia_generato) r.giaGenerati++
    if (x.esito === 'esente') r.esenti++
    else if (x.esito === 'senza_importo' && !x.gia_generato) r.senzaImporto++
    else if (x.esito === 'pagante_assente' && !x.gia_generato) r.paganteAssente++
    else if (x.esito === 'da_generare' && !x.gia_generato) {
      r.candidati++
      r.totale += Number(x.importo ?? 0)
      const o = x.origine_importo ?? 'sconosciuta'
      r.perOrigine[o] = (r.perOrigine[o] ?? 0) + 1
    }
  }
  r.totale = Math.round(r.totale * 100) / 100
  return r
}

/**
 * Il riepilogo nel log: sempre un `info`, e un `warn` per ogni cosa che la segreteria dovrebbe sapere (bambini senza retta,
 * paganti assenti). SOLO uuid e numeri: nessun nome, nessun importo. Le chiavi sono quelle già della lista bianca.
 */
export function logRiepilogoRette(operazione: string, scuolaId: string, annoSedeId: string, r: RiepilogoRette): void {
  const base = { operazione, scuola_id: scuolaId, entita_id: annoSedeId }
  logEvento('pagamento', 'info', { ...base, esito: 'rette-riepilogo', n: r.candidati })
  if (r.senzaImporto > 0) logEvento('pagamento', 'warn', { ...base, esito: 'rette-senza-importo', n: r.senzaImporto })
  if (r.paganteAssente > 0) logEvento('pagamento', 'warn', { ...base, esito: 'rette-pagante-assente', n: r.paganteAssente })
}
