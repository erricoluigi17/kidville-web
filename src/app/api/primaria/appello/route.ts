import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { assertSezioneInScope } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { notificaTitolariScrittura } from '@/lib/primaria/notifiche'

const STATI = ['presente', 'assente', 'ritardo', 'uscita_anticipata'] as const

// GET /api/primaria/appello?sectionId=&data=&userId=
// Alunni della classe + stato presenza del giorno.
export async function GET(request: NextRequest) {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const sp = new URL(request.url).searchParams
    const sectionId = sp.get('sectionId')
    const data = sp.get('data')
    if (!sectionId || !data) return NextResponse.json({ error: 'sectionId e data obbligatori' }, { status: 400 })

    const supabase = await createAdminClient()
    const scopeErr = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (scopeErr) return scopeErr

    const [{ data: alunni }, { data: presenze }] = await Promise.all([
      supabase.from('alunni').select('id, nome, cognome').eq('section_id', sectionId).order('cognome'),
      supabase
        .from('presenze')
        .select('id, alunno_id, stato, note_appello, orario_entrata, orario_uscita, giustificata, giustificazione_testo, giust_vista_il')
        .eq('section_id', sectionId)
        .eq('data', data),
    ])

    const statoByAlunno = new Map((presenze ?? []).map((p) => [p.alunno_id, p]))
    const data_ = (alunni ?? []).map((a) => {
      const p = statoByAlunno.get(a.id)
      return {
        ...a,
        presenza_id: p?.id ?? null,
        stato: p?.stato ?? null,
        note_appello: p?.note_appello ?? null,
        orario_entrata: p?.orario_entrata ?? null,
        orario_uscita: p?.orario_uscita ?? null,
        giustificata: p?.giustificata ?? false,
        giustificazione_testo: p?.giustificazione_testo ?? null,
        giust_vista_il: p?.giust_vista_il ?? null,
      }
    })

    return NextResponse.json({ success: true, data: data_ })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// POST /api/primaria/appello?userId=
//   singolo: { sectionId, alunnoId, data, stato, noteAppello? }
//   bulk:    { sectionId, data, records: [{ alunnoId, stato, noteAppello? }] }
export async function POST(request: NextRequest) {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const userId = auth.user.id
    const body = await request.json()
    const { sectionId, data } = body
    if (!sectionId || !data) return NextResponse.json({ error: 'sectionId e data obbligatori' }, { status: 400 })

    const supabase = await createAdminClient()
    const scopeErr = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (scopeErr) return scopeErr

    const records: { alunnoId: string; stato: string; noteAppello?: string; orarioEntrata?: string; orarioUscita?: string }[] = Array.isArray(body.records)
      ? body.records
      : [{ alunnoId: body.alunnoId, stato: body.stato, noteAppello: body.noteAppello, orarioEntrata: body.orarioEntrata, orarioUscita: body.orarioUscita }]

    for (const r of records) {
      if (!r.alunnoId || !STATI.includes(r.stato as typeof STATI[number])) {
        return NextResponse.json({ error: `Record non valido (stato in ${STATI.join('/')})` }, { status: 400 })
      }
    }

    // Compone un timestamp completo da data (YYYY-MM-DD) + orario (HH:MM).
    const toTs = (orario?: string) =>
      orario && /^\d{2}:\d{2}$/.test(orario) ? `${data}T${orario}:00` : null

    // Stato PRIMA (per audit diff).
    const alunnoIds = records.map((r) => r.alunnoId)
    const { data: prima } = await supabase
      .from('presenze')
      .select('*')
      .eq('section_id', sectionId)
      .eq('data', data)
      .in('alunno_id', alunnoIds)

    const rows = records.map((r) => ({
      alunno_id: r.alunnoId,
      section_id: sectionId,
      data,
      stato: r.stato,
      note_appello: r.noteAppello ?? null,
      // Orario di entrata solo per ritardo, orario di uscita solo per uscita anticipata.
      orario_entrata: r.stato === 'ritardo' ? toTs(r.orarioEntrata) : null,
      orario_uscita: r.stato === 'uscita_anticipata' ? toTs(r.orarioUscita) : null,
      // Provenienza operativa: chi ha registrato (può essere la segreteria). NON è una firma.
      registrato_da: userId,
    }))

    const { data: saved, error } = await supabase
      .from('presenze')
      .upsert(rows, { onConflict: 'alunno_id,data' })
      .select()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Audit (diff prima/dopo) + notifica al docente titolare (se segreteria/direzione).
    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'presenze',
      azione: 'update',
      sectionId,
      valorePrima: prima ?? [],
      valoreDopo: saved ?? [],
    })
    await notificaTitolariScrittura(supabase, { attore: auth.user, sectionId, area: 'appello', link: `/teacher/primaria/${sectionId}/appello` })

    return NextResponse.json({ success: true, data: saved ?? [] })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
