import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import { sezioniVisibiliConEsito } from '@/lib/sezioni/docenti'

/**
 * Il roster di una classe di un anno PASSATO (L6-1, rilievo 2 della revisione del lotto 6).
 *
 * `alunni.section_id` è la classe di OGGI: dopo `passaggio_ricopia_schede` (1° settembre) punta alla classe nuova, quindi
 * leggere da lì la classe del 2026/27 la darebbe VUOTA — con una frase falsa. L'appartenenza di quell'anno sta nelle
 * `frequenze` di quell'anno (`anno_id`) con quel `section_id`: una riga per bambino e per anno, non cambia con la ricopia.
 * (L'alternativa, `alunni_classi_storico` dentro il periodo, esiste e la usa la lettura storica dello staff: qui serve la
 * classe dell'ANNO, non quella di un giorno, e le frequenze sono la fonte che il resto dell'anno scolastico già usa.)
 *
 * Esito: `null` = la sezione NON è di un anno passato (o il DB non ha lo schema dell'anno): vale la lettura di sempre.
 * `[]` = anno passato senza bambini. Una frequenza SENZA `section_id` non appartiene a nessuna classe di quell'anno e resta
 * fuori dal roster (misurato in produzione: 3 su 25 negli anni chiusi); nessun ripiego, di proposito. Un guasto di lettura LANCIA: una classe vuota per un errore è la bugia che qui si evita.
 */
const STATI_PASSATI = ['in_chiusura', 'chiuso']
const CODICI_SCHEMA_ASSENTE = ['42703', '42P01', 'PGRST204', 'PGRST205']

/**
 * Schema dell'anno assente (DB E2E non migrato): si ricade sulla lettura ordinaria. Il ripiego si LOGGA, col solo codice
 * d'errore: senza, un guasto vero di schema in produzione tornerebbe alla lettura che il rilievo 2 voleva evitare, in silenzio.
 */
function schemaAssente(e: { code?: string } | null, lettura: string): boolean {
  const assente = !!e && CODICI_SCHEMA_ASSENTE.includes(e.code ?? '')
  if (assente) logEvento('db', 'warn', { operazione: 'sezioni/roster-anno', esito: 'schema-anno-assente-ripiego', lettura, codice: e?.code ?? '' })
  return assente
}

export async function rosterDellAnnoDellaSezione(db: SupabaseClient, sectionId: string): Promise<string[] | null> {
  const sez = await db.from('sections').select('anno_id, scuola_id').eq('id', sectionId).maybeSingle()
  if (sez.error) {
    if (schemaAssente(sez.error, 'sections')) return null
    throw sez.error
  }
  const annoId = (sez.data as { anno_id?: string | null } | null)?.anno_id
  const scuolaId = (sez.data as { scuola_id?: string | null } | null)?.scuola_id
  if (!annoId || !scuolaId) return null

  const sede = await db.from('anni_sede').select('stato').eq('anno_id', annoId).eq('scuola_id', scuolaId).maybeSingle()
  if (sede.error) {
    if (schemaAssente(sede.error, 'anni_sede')) return null
    throw sede.error
  }
  const stato = (sede.data as { stato?: string } | null)?.stato
  if (!stato || !STATI_PASSATI.includes(stato)) return null

  const fr = await db.from('frequenze').select('alunno_id').eq('anno_id', annoId).eq('section_id', sectionId).neq('stato', 'in_attesa')
  if (fr.error) {
    if (schemaAssente(fr.error, 'frequenze')) return null
    throw fr.error
  }
  return [...new Set(((fr.data ?? []) as { alunno_id: string }[]).map((r) => r.alunno_id))]
}

/** Il docente vede il roster di una classe passata solo se la funzione dell'anno la dà fra le sue (`sezioni_visibili_docente`). */
export async function docenteVedeLaSezione(db: SupabaseClient, userId: string, sectionId: string): Promise<boolean> {
  const esito = await sezioniVisibiliConEsito(db, userId)
  if (!esito.ok) {
    logEvento('db', 'warn', { operazione: 'sezioni/roster-anno', esito: 'sezioni-visibili-non-lette' })
    return false
  }
  return esito.sezioni.some((s) => s.sectionId === sectionId)
}

/**
 * Il periodo (primo e ultimo giorno) dell'anno di una classe PASSATA, `anni_sede` della sua sede (lotto 8). Serve a tenere la
 * lettura in sola lettura dentro le date di quell'anno: una classe passata non mostra le foto e il diario di un anno diverso.
 * `null` = non è una classe di un anno passato, oppure il periodo non c'è (date assenti): chi chiama risponde VUOTO e logga l'errore
 * (`periodo-anno-assente`), non legge senza finestra.
 */
export async function periodoDellAnnoPassato(db: SupabaseClient, sectionId: string): Promise<{ inizio: string; fine: string } | null> {
  const sez = await db.from('sections').select('anno_id, scuola_id').eq('id', sectionId).maybeSingle()
  if (sez.error) {
    if (schemaAssente(sez.error, 'sections')) return null
    throw sez.error
  }
  const annoId = (sez.data as { anno_id?: string | null } | null)?.anno_id
  const scuolaId = (sez.data as { scuola_id?: string | null } | null)?.scuola_id
  if (!annoId || !scuolaId) return null
  const sede = await db.from('anni_sede').select('stato, inizio, fine').eq('anno_id', annoId).eq('scuola_id', scuolaId).maybeSingle()
  if (sede.error) {
    if (schemaAssente(sede.error, 'anni_sede')) return null
    throw sede.error
  }
  const r = sede.data as { stato?: string; inizio?: string | null; fine?: string | null } | null
  if (!r?.stato || !STATI_PASSATI.includes(r.stato) || !r.inizio || !r.fine) return null
  return { inizio: r.inizio.slice(0, 10), fine: r.fine.slice(0, 10) }
}
