import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { assertSezioneInScope, assertAlunniInSezione } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { notificaTitolariScrittura } from '@/lib/primaria/notifiche'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { parseBody, parseData, parseQuery } from '@/lib/validation/http'
import { zDataYMD, zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

const STATI = ['presente', 'assente', 'ritardo', 'uscita_anticipata'] as const

const getQuerySchema = z.object({
  sectionId: zUuid,
  data: zDataYMD,
})

// Base loose: il dispatch singolo/bulk legge dal body campi diversi (records
// oppure alunnoId/stato/... top-level), poi validati con recordsSchema.
const postBaseSchema = z.object({
  sectionId: zUuid,
  data: zDataYMD,
}).loose()

const recordSchema = z.object({
  alunnoId: zUuid,
  stato: z.enum(STATI),
  noteAppello: z.string().nullish(),
  // 'HH:MM'; altri formati ricadono su null (toTs) come oggi: nessun vincolo qui.
  orarioEntrata: z.string().nullish(),
  orarioUscita: z.string().nullish(),
})
const recordsSchema = z.array(recordSchema)

// GET /api/primaria/appello?sectionId=&data=&userId=
// Alunni della classe + stato presenza del giorno.
export const GET = withRoute('primaria/appello:GET', async (request: NextRequest) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { sectionId, data } = q.data

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
    logErrore({ operazione: 'primaria/appello:GET', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})

// POST /api/primaria/appello?userId=
//   singolo: { sectionId, alunnoId, data, stato, noteAppello? }
//   bulk:    { sectionId, data, records: [{ alunnoId, stato, noteAppello? }] }
export const POST = withRoute('primaria/appello:POST', async (request: NextRequest) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const userId = auth.user.id
    const b = await parseBody(request, postBaseSchema)
    if ('response' in b) return b.response
    const { sectionId, data } = b.data

    const supabase = await createAdminClient()
    const scopeErr = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (scopeErr) return scopeErr

    // Dispatch singolo/bulk come oggi: records array → bulk, altrimenti campi top-level.
    const rawRecords = Array.isArray(b.data.records)
      ? b.data.records
      : [{ alunnoId: b.data.alunnoId, stato: b.data.stato, noteAppello: b.data.noteAppello, orarioEntrata: b.data.orarioEntrata, orarioUscita: b.data.orarioUscita }]
    const rec = parseData(recordsSchema, rawRecords)
    if ('response' in rec) return rec.response
    const records = rec.data

    // Compone un timestamp completo da data (YYYY-MM-DD) + orario (HH:MM).
    const toTs = (orario?: string | null) =>
      orario && /^\d{2}:\d{2}$/.test(orario) ? `${data}T${orario}:00` : null

    // Gli alunni dei record devono appartenere alla sezione asserita (no upsert cross-sezione).
    const alunniErr = await assertAlunniInSezione(supabase, records.map((r) => r.alunnoId), sectionId)
    if (alunniErr) return alunniErr

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

    // Notifica "assenza all'appello" ai genitori (best-effort). Scatta SOLO per
    // chi DIVENTA assente senza assenza comunicata (giustificata/giustificata_da
    // sulla riga preesistente = il genitore aveva avvisato). Il buffer 10' è la
    // finestra di correzione: assente → presente/ritardo revoca la pending.
    try {
      const primaByAlunno = new Map(
        ((prima ?? []) as Array<{ alunno_id: string; stato?: string | null; giustificata?: boolean | null; giustificata_da?: string | null }>)
          .map((p) => [p.alunno_id, p]),
      )
      const { data: sezione } = await supabase.from('sections').select('scuola_id').eq('id', sectionId).maybeSingle()
      const scuolaId = (sezione?.scuola_id as string | undefined) ?? null

      const revocati = records
        .filter((r) => r.stato !== 'assente' && primaByAlunno.get(r.alunnoId)?.stato === 'assente')
        .map((r) => r.alunnoId)
      for (const alunnoId of revocati) {
        await supabase
          .from('notifiche')
          .delete()
          .eq('tipo', 'assenza_non_comunicata')
          .eq('entita_id', alunnoId)
          .is('push_inviata_il', null)
      }

      const nuoviAssenti = records
        .filter((r) => {
          if (r.stato !== 'assente') return false
          const p = primaByAlunno.get(r.alunnoId)
          if (p?.stato === 'assente') return false // ri-salvataggio: già gestito
          if (p?.giustificata || p?.giustificata_da) return false // assenza comunicata
          return true
        })
        .map((r) => r.alunnoId)
      if (nuoviAssenti.length > 0) {
        const { data: anagrafiche } = await supabase.from('alunni').select('id, nome').in('id', nuoviAssenti)
        for (const a of (anagrafiche ?? []) as Array<{ id: string; nome?: string | null }>) {
          await notificaEvento(supabase, {
            tipo: 'assenza_non_comunicata',
            scuolaId,
            alunnoIds: [a.id],
            titolo: 'Assenza registrata all’appello',
            corpo: `${a.nome ?? 'Tuo figlio'} è risultato assente oggi senza un'assenza comunicata. Ricordati di giustificare.`,
            link: '/parent/primaria/assenze',
            entitaTipo: 'presenza',
            entitaId: a.id,
            bufferMin: 10,
            debounce: true,
          })
        }
      }
    } catch (e) {
      console.error('Notifica assenza appello fallita (non bloccante):', e)
    }

    return NextResponse.json({ success: true, data: saved ?? [] })
  } catch (err) {
    logErrore({ operazione: 'primaria/appello:POST', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
