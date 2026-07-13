import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { logScrittura } from '@/lib/audit/scrittura'
import { seedCertificato } from '@/lib/competenze/certificato-store'
import { COMPETENZE_SIGNIFICATIVE_CODICE } from '@/lib/competenze/modello'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// Gli id restano stringhe libere (niente zUuid): oggi il codice non impone
// alcun formato e nei test/dati seed circolano id non-UUID.
// `userId` in query è consumato dal gate (requireStaff), non qui.

const getQuerySchema = z.object({
  sectionId: z.string({ error: 'sectionId obbligatorio' }).min(1, 'sectionId obbligatorio'),
})

const postBodySchema = z.object({
  sectionId: z.string({ error: 'sectionId obbligatorio' }).min(1, 'sectionId obbligatorio'),
  // opzionale: la guardia truthy resta nell'handler (stringa vuota/null → intera classe, come oggi)
  alunnoId: z.string().nullish(),
})

const patchBodySchema = z.object({
  certificatoId: z.string({ error: 'certificatoId obbligatorio' }).min(1, 'certificatoId obbligatorio'),
  livelli: z
    .array(
      z.object({
        competenza_codice: z.string(),
        livello: z.string().nullish(),
        note: z.string().nullish(),
      })
    )
    .nullish(),
  // presente (anche null) → aggiorna la nota "competenze significative"
  competenzeSignificative: z.string().nullish(),
})

// GET /api/admin/competenze?sectionId=&userId=  — elenco certificati della sezione.
export const GET = withRoute('admin/competenze:GET', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { sectionId } = q.data

    const supabase = await createAdminClient()
    const { data: certs } = await supabase
      .from('certificati_competenze')
      .select('id, alunno_id, anno_scolastico, stato, generato_il, alunni(nome, cognome), certificato_competenza_livelli(competenza_codice, livello, note, ordine)')
      .eq('section_id', sectionId)
      .order('created_at', { ascending: false })
    return NextResponse.json({ success: true, data: certs ?? [] })
  } catch (err) {
    logErrore({ operazione: 'admin/competenze:GET', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})

// POST /api/admin/competenze?userId=  — crea/riallinea le bozze (1 alunno o intera classe).
// body: { sectionId, alunnoId? }. Guard livello-5/scrutinio-chiuso da seedCertificato.
export const POST = withRoute('admin/competenze:POST', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request, ['admin', 'coordinator'])
    if (auth.response) return auth.response
    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const body = b.data

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
    logErrore({ operazione: 'admin/competenze:POST', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})

// PATCH /api/admin/competenze?userId=  — modifica livelli + competenze significative.
// body: { certificatoId, livelli: [{competenza_codice, livello, note?}], competenzeSignificative? }
export const PATCH = withRoute('admin/competenze:PATCH', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request, ['admin', 'coordinator'])
    if (auth.response) return auth.response
    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const body = b.data

    const supabase = await createAdminClient()
    const rows: { certificato_id: string; competenza_codice: string; livello: string | null; note: string | null }[] = []
    for (const l of body.livelli ?? []) {
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
    logErrore({ operazione: 'admin/competenze:PATCH', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
