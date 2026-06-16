import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { enqueueNotifichePerAlunni } from '@/lib/primaria/notifiche'

const CATEGORIE = ['disciplinare', 'didattica', 'compiti_non_svolti'] as const

// GET /api/primaria/note?sectionId=&userId=  (vista docente: ultime note della classe)
export async function GET(request: NextRequest) {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const sp = new URL(request.url).searchParams
    const sectionId = sp.get('sectionId')
    if (!sectionId) return NextResponse.json({ error: 'sectionId obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()
    const { data, error } = await supabase
      .from('note_disciplinari')
      .select('id, alunno_id, categoria, testo, richiede_firma, firmata_il, oscurata_ad_altri, nota_gruppo_id, creato_il, alunni(nome, cognome)')
      .eq('section_id', sectionId)
      .order('creato_il', { ascending: false })
      .limit(50)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// POST /api/primaria/note?userId=
// body: { sectionId, alunnoIds[], categoria, testo, richiedeFirma?, oscurataAdAltri? }
export async function POST(request: NextRequest) {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const userId = auth.user.id
    const body = await request.json()
    const { sectionId, alunnoIds, categoria, testo, richiedeFirma, oscurataAdAltri } = body

    if (!sectionId || !Array.isArray(alunnoIds) || alunnoIds.length === 0 || !categoria || !testo) {
      return NextResponse.json({ error: 'sectionId, alunnoIds[], categoria, testo obbligatori' }, { status: 400 })
    }
    if (!CATEGORIE.includes(categoria)) {
      return NextResponse.json({ error: `categoria in ${CATEGORIE.join('/')}` }, { status: 400 })
    }

    const supabase = await createAdminClient()
    // Gruppo condiviso per assegnazione massiva (trattamento coerente delle note collettive).
    const notaGruppoId = crypto.randomUUID()

    const rows = alunnoIds.map((aid: string) => ({
      alunno_id: aid,
      section_id: sectionId,
      maestra_id: userId,
      categoria,
      testo,
      richiede_firma: !!richiedeFirma,
      oscurata_ad_altri: oscurataAdAltri ?? true,
      nota_gruppo_id: notaGruppoId,
    }))

    const { data, error } = await supabase.from('note_disciplinari').insert(rows).select()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Notifica nota (con buffer; richiesta firma se prevista). Best-effort.
    try {
      await enqueueNotifichePerAlunni(supabase, {
        alunnoIds,
        tipo: richiedeFirma ? 'nota_firma' : 'nota',
        titolo: richiedeFirma ? 'Nuova nota — richiesta firma' : 'Nuova nota',
        corpo: testo.slice(0, 140),
        link: '/parent/primaria/note',
        entitaTipo: 'nota',
      })
    } catch { /* non bloccare */ }

    return NextResponse.json({ success: true, data: data ?? [] }, { status: 201 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
