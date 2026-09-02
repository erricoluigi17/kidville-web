import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { assertAlunnoInScope, resolveScuoleAttive } from '@/lib/auth/scope'
import { risolviSezione } from '@/lib/sezioni/risoluzione'
import { logScrittura } from '@/lib/audit/scrittura'
import { periodoValido } from '@/lib/certificati/stato'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// Filtri opzionali senza vincoli aggiuntivi: `stato` oggi è passato com'è alla
// query (nessun enum imposto) e `class_name` filtra in memoria.
const getQuerySchema = z.object({
  stato: z.string().optional(),
  class_name: z.string().optional(),
})

// `id` resta stringa permissiva (oggi basta un valore truthy; niente zUuid per
// non rompere gli id non-RFC dei fixture). L'esito era già enumerato da
// isEsitoValidazione; le date restano soggette al check incrociato
// periodoValido (entrambe presenti e inizio <= fine). `nota_validazione` è
// accettata oggi con QUALSIASI tipo (i non-string diventano null nel patch).
const patchBodySchema = z.object({
  id: z.string().min(1, 'id è obbligatorio'),
  esito: z.enum(['validato', 'rifiutato'], { error: 'esito non valido (validato|rifiutato)' }),
  data_inizio: z.string().nullish(),
  data_fine: z.string().nullish(),
  nota_validazione: z.unknown().optional(),
})

// GET /api/teacher/medical-certificates — elenco certificati per la Segreteria.
// Filtri opzionali: ?stato=in_validazione | ?class_name=
export const GET = withRoute('teacher/medical-certificates:GET', async (request: NextRequest) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { stato, class_name: className } = q.data

    const supabase = await createAdminClient()
    // Il gate qui sotto scatta SOLO se arriva `?class_name=`, e comunque non filtra le
    // righe: sono due presidi diversi e servono entrambi (cfr. il commento di
    // `assertClasseNomeInScope` in src/lib/auth/scope.ts). Senza il filtro,
    // una GET senza parametri restituiva i certificati medici — periodo di malattia,
    // note cliniche libere, `file_path` — di TUTTE le sedi; e con `?class_name=2 ANNI`
    // entravano anche gli omonimi dell'altro plesso. `!inner` è necessario perché il
    // filtro sulla risorsa embedded scarti davvero la riga padre; scope vuoto ⇒
    // `.in(…, [])` ⇒ nessuna riga, cioè si nega, non si apre.
    const plessi = await resolveScuoleAttive(request, supabase, auth.user)

    // Docente (educator) → certificati della propria sezione; lo scope impedisce
    // letture cross-plesso. Staff → proprio plesso.
    //
    // ⚠️ QUESTA ROUTE FILTRAVA DUE VOLTE per nome — nella query e poi in JS — e
    // le due cose vanno cambiate INSIEME: correggerne una sola avrebbe lasciato
    // il risultato vuoto lo stesso, con l'aria di una correzione fatta.
    let sezioniClasse: string[] = []
    if (className) {
      const classe = await risolviSezione(supabase, auth.user, { nome: className }, plessi)
      if (classe.response) return classe.response
      if (classe.sectionIds.length === 0) return NextResponse.json([])
      sezioniClasse = classe.sectionIds
    }

    let query = supabase
      .from('certificati_medici')
      .select('id, alunno_id, file_path, data_inizio, data_fine, stato, note, nota_validazione, validato_il, creato_il, alunno:alunni!inner(nome, cognome, section_id, classe_sezione)')
      .in('alunno.scuola_id', plessi)
      .order('creato_il', { ascending: false })
    if (stato) query = query.eq('stato', stato)
    if (className) query = query.in('alunno.section_id', sezioniClasse)

    const { data, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    let rows = (data ?? []) as Record<string, unknown>[]
    if (className) {
      // Il secondo filtro, gemello del primo: per UUID, non per nome.
      rows = rows.filter((c) => {
        const a = c.alunno as { section_id?: string | null } | null
        return Boolean(a?.section_id) && sezioniClasse.includes(a!.section_id as string)
      })
    }
    // appiattisce nome/cognome alunno per retro-compat con la UI
    rows = rows.map((c) => {
      const a = c.alunno as { nome?: string; cognome?: string } | null
      return { ...c, nome_alunno: a?.nome ?? '', cognome_alunno: a?.cognome ?? '' }
    })
    return NextResponse.json({ success: true, data: rows })
  } catch (err) {
    logErrore({ operazione: 'teacher/medical-certificates:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// PATCH /api/teacher/medical-certificates — validazione Segreteria (DL-027).
// Body: { id, esito: 'validato'|'rifiutato', data_inizio?, data_fine?, nota_validazione? }
export const PATCH = withRoute('teacher/medical-certificates:PATCH', async (request: Request) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response

    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const body = b.data
    const id = body.id

    const supabase = await createAdminClient()

    // Scope: il docente valida solo certificati di alunni nel proprio ambito
    // (educator = proprie sezioni; staff = proprio plesso).
    const { data: certScope } = await supabase
      .from('certificati_medici').select('alunno_id').eq('id', id).maybeSingle()
    if (!certScope) return NextResponse.json({ error: 'Certificato non trovato' }, { status: 404 })
    const scopeErr = await assertAlunnoInScope(supabase, auth.user, certScope.alunno_id as string)
    if (scopeErr) return scopeErr

    const patch: Record<string, unknown> = {
      stato: body.esito,
      validato_da: auth.user.id,
      validato_il: new Date().toISOString(),
      nota_validazione: typeof body.nota_validazione === 'string' ? body.nota_validazione : null,
    }
    // la Segreteria/docente può correggere il periodo in fase di validazione
    if (body.data_inizio || body.data_fine) {
      if (!periodoValido({ data_inizio: body.data_inizio, data_fine: body.data_fine })) {
        return NextResponse.json({ error: 'Periodo di copertura non valido' }, { status: 400 })
      }
      patch.data_inizio = body.data_inizio
      patch.data_fine = body.data_fine
    }

    const { error } = await supabase.from('certificati_medici').update(patch).eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'certificato_medico',
      entitaId: id,
      azione: 'update',
      scuolaId: auth.user.scuola_id,
      valoreDopo: { stato: body.esito },
    })

    return NextResponse.json({ success: true, data: { id, stato: body.esito } })
  } catch (err) {
    logErrore({ operazione: 'teacher/medical-certificates:PATCH', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
