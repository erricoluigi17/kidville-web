import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { logScrittura } from '@/lib/audit/scrittura'
import { seedCertificato } from '@/lib/competenze/certificato-store'
import { COMPETENZE_SIGNIFICATIVE_CODICE } from '@/lib/competenze/modello'

// GET /api/admin/competenze?sectionId=&userId=  — elenco certificati della sezione.
export async function GET(request: NextRequest) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const sectionId = new URL(request.url).searchParams.get('sectionId')
    if (!sectionId) return NextResponse.json({ error: 'sectionId obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()
    const { data: certs } = await supabase
      .from('certificati_competenze')
      .select('id, alunno_id, anno_scolastico, stato, generato_il, alunni(nome, cognome), certificato_competenza_livelli(competenza_codice, livello, note, ordine)')
      .eq('section_id', sectionId)
      .order('created_at', { ascending: false })
    return NextResponse.json({ success: true, data: certs ?? [] })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// POST /api/admin/competenze?userId=  — crea/riallinea le bozze (1 alunno o intera classe).
// body: { sectionId, alunnoId? }. Guard livello-5/scrutinio-chiuso da seedCertificato.
export async function POST(request: NextRequest) {
  try {
    const auth = await requireStaff(request, ['admin', 'coordinator'])
    if (auth.response) return auth.response
    const body = await request.json().catch(() => ({}))
    if (!body.sectionId) return NextResponse.json({ error: 'sectionId obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()
    let alunniIds: string[] = []
    if (body.alunnoId) alunniIds = [body.alunnoId]
    else {
      const { data: alunni } = await supabase.from('alunni').select('id').eq('section_id', body.sectionId)
      alunniIds = ((alunni ?? []) as { id: string }[]).map((a) => a.id)
    }

    let creati = 0
    const errori: { alunnoId: string; error?: string; status?: number }[] = []
    let firstErrStatus: number | undefined
    for (const alunnoId of alunniIds) {
      const r = await seedCertificato(supabase, body.sectionId, alunnoId)
      if (r.error) {
        errori.push({ alunnoId, error: r.error, status: r.status })
        firstErrStatus = firstErrStatus ?? r.status
      } else {
        creati++
        await logScrittura(supabase, {
          attore: auth.user,
          entitaTipo: 'certificato_competenze',
          entitaId: r.certificatoId,
          azione: 'insert',
          scuolaId: auth.user.scuola_id ?? null,
        })
      }
    }
    // Se nessun certificato è stato creato e c'è un errore di guard, propaga lo status.
    if (creati === 0 && firstErrStatus) return NextResponse.json({ error: errori[0].error, errori }, { status: firstErrStatus })
    return NextResponse.json({ success: true, creati, totale: alunniIds.length, errori })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// PATCH /api/admin/competenze?userId=  — modifica livelli + competenze significative.
// body: { certificatoId, livelli: [{competenza_codice, livello, note?}], competenzeSignificative? }
export async function PATCH(request: NextRequest) {
  try {
    const auth = await requireStaff(request, ['admin', 'coordinator'])
    if (auth.response) return auth.response
    const body = await request.json().catch(() => ({}))
    if (!body.certificatoId) return NextResponse.json({ error: 'certificatoId obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()
    const rows: { certificato_id: string; competenza_codice: string; livello: string | null; note: string | null }[] = []
    for (const l of (body.livelli ?? []) as { competenza_codice: string; livello?: string | null; note?: string | null }[]) {
      rows.push({ certificato_id: body.certificatoId, competenza_codice: l.competenza_codice, livello: l.livello ?? null, note: l.note ?? null })
    }
    if (body.competenzeSignificative !== undefined) {
      rows.push({ certificato_id: body.certificatoId, competenza_codice: COMPETENZE_SIGNIFICATIVE_CODICE, livello: null, note: body.competenzeSignificative ?? null })
    }
    if (rows.length) {
      await supabase.from('certificato_competenza_livelli').upsert(rows, { onConflict: 'certificato_id,competenza_codice' })
    }
    // Una modifica invalida la firma precedente: torna in bozza.
    await supabase.from('certificati_competenze').update({ stato: 'bozza', updated_at: new Date().toISOString() }).eq('id', body.certificatoId)

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'certificato_competenze',
      entitaId: body.certificatoId,
      azione: 'update',
      scuolaId: auth.user.scuola_id ?? null,
    })
    return NextResponse.json({ success: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
