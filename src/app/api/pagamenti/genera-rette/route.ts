import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseData, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'

// `anno` e `periodo` NON sono vincolati nel formato: storicamente un valore
// malformato ricade sull'anteprima/generazione mensile del mese corrente
// (vedi firstOfMonth e il test /^\d{4}$/ a runtime), non è un errore.
const getQuerySchema = z.object({
  anno: z.string().optional(),
  periodo: z.string().optional(),
  // stringa vuota = assente (come il vecchio `searchParams.get(...) || fallback`)
  scuola_id: z.preprocess((v) => (v === '' ? undefined : v), zUuid.optional()),
})

const postBodySchema = z.object({
  // dalla UI `anno` arriva come numero; ammessa anche la stringa (storico)
  anno: z.union([z.number(), z.string()]).nullish(),
  periodo: z.string().nullish(),
})

function firstOfMonth(periodo?: string | null): string {
  if (periodo && /^\d{4}-\d{2}/.test(periodo)) {
    const [y, m] = periodo.split('-')
    return `${y}-${m}-01`
  }
  const now = new Date()
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`
}

// I 10 periodi (primo del mese) di un anno scolastico: set(anno) -> giu(anno+1)
function periodiAnno(annoInizio: number): string[] {
  const out: string[] = []
  for (let m = 9; m <= 12; m++) out.push(`${annoInizio}-${String(m).padStart(2, '0')}-01`)
  for (let m = 1; m <= 6; m++) out.push(`${annoInizio + 1}-${String(m).padStart(2, '0')}-01`)
  return out
}

// importo retta effettivo = importo personalizzato dell'alunno, altrimenti default globale (150)
function importoRetta(a: { importo_retta_mensile?: number | null }, rettaDefault: number): number {
  const personalizzato = Number(a.importo_retta_mensile || 0)
  return personalizzato > 0 ? personalizzato : rettaDefault
}

// La retta si genera solo dal mese di iscrizione in poi (iscrizione prima del
// 1° settembre → tutto l'anno). NULL = alunno storico, iscritto da sempre.
// Stessa regola della RPC SQL genera_rette_mensili (migr. 20260710160000).
function iscrittoEntro(a: { data_iscrizione?: string | null }, periodo: string): boolean {
  if (!a.data_iscrizione) return true
  return `${String(a.data_iscrizione).slice(0, 7)}-01` <= periodo
}

// GET /api/pagamenti/genera-rette?userId=&periodo=YYYY-MM | &anno=YYYY [&scuola_id=]  (staff)
// Preview: alunni candidati alla generazione retta per il mese (periodo) o per l'intero
// anno scolastico (anno = anno di inizio, set->giu).
export async function GET(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const annoParam = q.data.anno
    const scuolaId = q.data.scuola_id || auth.user.scuola_id

    const supabase = await createAdminClient()
    const { data: cat } = await supabase
      .from('payment_categories').select('id').eq('slug', 'retta').is('scuola_id', null).maybeSingle()

    // retta default globale della scuola
    let settQuery = supabase.from('admin_settings').select('retta_default_importo, scuola_id')
    if (scuolaId) settQuery = settQuery.eq('scuola_id', scuolaId)
    const { data: sett } = await settQuery.limit(1).maybeSingle()
    const rettaDefault = Number(sett?.retta_default_importo ?? 150)

    // alunni attivi = iscritti CON sezione valorizzata (classe_sezione o section_id)
    const COLONNE_ALUNNI = 'id, nome, cognome, classe_sezione, section_id, importo_retta_mensile, genitori_separati, scuola_id'
    let alQuery = supabase
      .from('alunni')
      .select(`${COLONNE_ALUNNI}, data_iscrizione`)
      .eq('stato', 'iscritto')
    if (scuolaId) alQuery = alQuery.eq('scuola_id', scuolaId)
    // eslint-disable-next-line prefer-const -- alunniRaw è riassegnato nel retry
    let { data: alunniRaw, error: errAlunni } = await alQuery
    // retry senza data_iscrizione sui DB non migrati (e2e CI): colonna ignorata
    if (errAlunni && (errAlunni as { code?: string }).code === '42703') {
      let retryQ = supabase.from('alunni').select(COLONNE_ALUNNI).eq('stato', 'iscritto')
      if (scuolaId) retryQ = retryQ.eq('scuola_id', scuolaId)
      const retry = await retryQ
      alunniRaw = (retry.data ?? null) as unknown as typeof alunniRaw
    }
    const alunni = (alunniRaw || []).filter((a) => a.classe_sezione != null || a.section_id != null)

    // --- Anteprima ANNUALE (set->giu) ---
    if (annoParam && /^\d{4}$/.test(annoParam)) {
      const annoInizio = parseInt(annoParam, 10)
      const periodi = periodiAnno(annoInizio)

      const { data: esistenti } = await supabase
        .from('pagamenti')
        .select('alunno_id, periodo_competenza')
        .in('periodo_competenza', periodi)
        .eq('categoria_id', cat?.id)
      const fattiPerPeriodo = new Map<string, Set<string>>()
      for (const e of esistenti || []) {
        const key = String(e.periodo_competenza)
        if (!fattiPerPeriodo.has(key)) fattiPerPeriodo.set(key, new Set())
        fattiPerPeriodo.get(key)!.add(e.alunno_id)
      }

      let totaleCandidati = 0
      let totalePrevisto = 0
      const mesi = periodi.map((p) => {
        const giaFatti = fattiPerPeriodo.get(p) ?? new Set()
        const candidati = alunni.filter((a) => !giaFatti.has(a.id) && iscrittoEntro(a, p))
        const importo = candidati.reduce((s, a) => s + importoRetta(a, rettaDefault), 0)
        totaleCandidati += candidati.length
        totalePrevisto += importo
        return { periodo: p, candidati: candidati.length, gia_generati: giaFatti.size, importo }
      })

      return NextResponse.json({
        success: true,
        data: {
          anno_inizio: annoInizio,
          mesi,
          alunni_attivi: alunni.length,
          retta_default: rettaDefault,
          totale_candidati: totaleCandidati,
          totale_previsto: totalePrevisto,
        },
      })
    }

    // --- Anteprima MENSILE ---
    const periodo = firstOfMonth(q.data.periodo)
    const { data: esistenti } = await supabase
      .from('pagamenti')
      .select('alunno_id')
      .eq('periodo_competenza', periodo)
      .eq('categoria_id', cat?.id)
    const giaFatti = new Set((esistenti || []).map((e) => e.alunno_id))

    const candidati = alunni
      .filter((a) => !giaFatti.has(a.id) && iscrittoEntro(a, periodo))
      .map((a) => ({ ...a, importo_previsto: importoRetta(a, rettaDefault) }))
    const totale = candidati.reduce((s, a) => s + a.importo_previsto, 0)

    return NextResponse.json({
      success: true,
      data: { periodo, candidati, gia_generati: giaFatti.size, retta_default: rettaDefault, totale_previsto: totale },
    })
  } catch (err) {
    console.error('Errore API GET genera-rette:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// POST /api/pagamenti/genera-rette  (staff) — conferma generazione
// Body: { userId, periodo?: 'YYYY-MM' }  -> singolo mese
//   oppure { userId, anno: 2026 }        -> intero anno scolastico (set->giu)
export async function POST(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    // Il body è opzionale: senza body (o JSON malformato) si genera il mese
    // corrente (comportamento storico), quindi niente parseBody che darebbe 400.
    const raw: unknown = await request.json().catch(() => ({}))
    const b = parseData(postBodySchema, raw)
    if ('response' in b) return b.response
    const body = b.data

    const supabase = await createAdminClient()

    // --- Generazione ANNUALE ---
    if (body.anno != null && /^\d{4}$/.test(String(body.anno))) {
      const annoInizio = parseInt(String(body.anno), 10)
      const { data, error } = await supabase.rpc('genera_rette_anno', { p_anno_inizio: annoInizio })
      if (error) {
        console.error('Errore genera_rette_anno:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
      await supabase.from('registro_modifiche').insert({
        azione: 'genera_rette_anno',
        tabella_interessata: 'pagamenti',
        record_id: null,
        nuovo_valore: { anno_inizio: annoInizio, generati: data },
        utente_id: auth.user.id,
      }).then(() => {}, () => {})

      return NextResponse.json({ success: true, data: { anno_inizio: annoInizio, generati: data } })
    }

    // --- Generazione MENSILE ---
    const periodo = firstOfMonth(body.periodo)
    const { data, error } = await supabase.rpc('genera_rette_mensili', { p_periodo: periodo })
    if (error) {
      console.error('Errore genera_rette_mensili:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    await supabase.from('registro_modifiche').insert({
      azione: 'genera_rette',
      tabella_interessata: 'pagamenti',
      record_id: null,
      nuovo_valore: { periodo, generati: data },
      utente_id: auth.user.id,
    }).then(() => {}, () => {})

    return NextResponse.json({ success: true, data: { periodo, generati: data } })
  } catch (err) {
    console.error('Errore API POST genera-rette:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
