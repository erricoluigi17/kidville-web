import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { assertSezioneInScope, assertAlunniInSezione } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { risolviValutatore } from '@/lib/audit/valutatore'
import { enqueueNotifichePerAlunni, notificaTitolariScrittura } from '@/lib/primaria/notifiche'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

const CATEGORIE = ['disciplinare', 'didattica', 'compiti_non_svolti'] as const

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({
  sectionId: zUuid,
})

// richiedeFirma/oscurataAdAltri/docenteId restano volutamente permissivi
// (z.unknown()): oggi accettano qualunque valore (coercizioni !! e ?? true;
// docenteId validato da risolviValutatore, 422). NB: .optional() è necessario —
// z.unknown() come chiave di z.object è required a runtime.
const postBodySchema = z.object({
  sectionId: zUuid,
  alunnoIds: z.array(zUuid).min(1, 'alunnoIds[] obbligatorio'),
  categoria: z.enum(CATEGORIE, { error: `categoria in ${CATEGORIE.join('/')}` }),
  testo: z.string().min(1, 'testo obbligatorio'),
  richiedeFirma: z.unknown().optional(),
  oscurataAdAltri: z.unknown().optional(),
  docenteId: z.unknown().optional(),
})

// GET /api/primaria/note?sectionId=&userId=  (vista docente: ultime note della classe)
export const GET = withRoute('primaria/note:GET', async (request: NextRequest) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { sectionId } = q.data

    const supabase = await createAdminClient()
    const scopeErr = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (scopeErr) return scopeErr
    const { data, error } = await supabase
      .from('note_disciplinari')
      .select('id, alunno_id, categoria, testo, richiede_firma, firmata_il, oscurata_ad_altri, nota_gruppo_id, creato_il, alunni(nome, cognome)')
      .eq('section_id', sectionId)
      .order('creato_il', { ascending: false })
      .limit(50)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    logErrore({ operazione: 'primaria/note:GET', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})

// POST /api/primaria/note?userId=
// body: { sectionId, alunnoIds[], categoria, testo, richiedeFirma?, oscurataAdAltri? }
export const POST = withRoute('primaria/note:POST', async (request: NextRequest) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { sectionId, alunnoIds, categoria, testo, richiedeFirma, oscurataAdAltri } = b.data
    const docenteId = b.data.docenteId as string | null | undefined

    const supabase = await createAdminClient()
    const scopeErr = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (scopeErr) return scopeErr

    // Gli alunni destinatari devono appartenere alla sezione asserita (no note cross-sezione).
    const alunniErr = await assertAlunniInSezione(supabase, alunnoIds, sectionId)
    if (alunniErr) return alunniErr

    // Autore della nota = docente (vincolo FEA). educator → sé stesso; segreteria
    // → docente titolare indicato in body.docenteId (validato), altrimenti 422.
    const vr = await risolviValutatore(supabase, auth.user, sectionId, { docenteId })
    if (vr.response) return vr.response
    const maestraId = vr.valutatoreId

    // Gruppo condiviso per assegnazione massiva (trattamento coerente delle note collettive).
    const notaGruppoId = crypto.randomUUID()

    const rows = alunnoIds.map((aid) => ({
      alunno_id: aid,
      section_id: sectionId,
      maestra_id: maestraId,
      categoria,
      testo,
      richiede_firma: !!richiedeFirma,
      oscurata_ad_altri: oscurataAdAltri ?? true,
      nota_gruppo_id: notaGruppoId,
    }))

    const { data, error } = await supabase.from('note_disciplinari').insert(rows).select()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'nota',
      entitaId: notaGruppoId,
      azione: 'insert',
      sectionId,
      valoreDopo: data ?? [],
    })
    await notificaTitolariScrittura(supabase, { attore: auth.user, sectionId, area: 'note', link: `/teacher/primaria/${sectionId}/note` })

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
    logErrore({ operazione: 'primaria/note:POST', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
