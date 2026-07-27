import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid, zPaginazione } from '@/lib/validation/common'
import { schemaAssente } from '@/lib/news/schema-assente'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// =============================================================================
// Coda di triage delle segnalazioni (Direzione). GET: elenco paginato con filtri
// opzionali stato/tipo_oggetto. PATCH: presa in carico / chiusura, con
// `gestita_il`/`gestita_da` scritti SEMPRE server-side (mai dal client).
// =============================================================================

const DIREZIONE = ['admin', 'coordinator'] as const

const getQuerySchema = z.object({
  stato: z.enum(['aperta', 'in_lavorazione', 'chiusa']).optional(),
  tipo_oggetto: z.enum(['messaggio_chat', 'media_galleria', 'voce_diario', 'utente']).optional(),
  ...zPaginazione.shape,
})

const patchBodySchema = z.object({
  id: zUuid,
  stato: z.enum(['in_lavorazione', 'chiusa']),
  note_gestione: z.string().max(2000).optional(),
})

export const GET = withRoute('admin/segnalazioni:GET', async (request: Request) => {
  const auth = await requireStaff(request, [...DIREZIONE])
  if (auth.response) return auth.response

  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response
  const { stato, tipo_oggetto, limit, offset } = q.data

  try {
    const admin = await createAdminClient()
    let query = admin
      .from('segnalazioni')
      .select('*', { count: 'exact' })
      .order('creata_il', { ascending: false })
    if (stato) query = query.eq('stato', stato)
    if (tipo_oggetto) query = query.eq('tipo_oggetto', tipo_oggetto)
    query = query.range(offset, offset + limit - 1)

    const { data, count, error } = await query
    if (error) {
      // DB E2E CI non migrato (tabella assente): coda vuota, niente 500.
      if (schemaAssente(error)) return NextResponse.json({ segnalazioni: [], total: 0 })
      logErrore({ operazione: 'admin/segnalazioni:GET', stato: 500, evento: 'db' }, error)
      return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
    }
    return NextResponse.json({ segnalazioni: data ?? [], total: count ?? 0 })
  } catch (err) {
    logErrore({ operazione: 'admin/segnalazioni:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
  }
})

export const PATCH = withRoute('admin/segnalazioni:PATCH', async (request: Request) => {
  const auth = await requireStaff(request, [...DIREZIONE])
  if (auth.response) return auth.response

  const b = await parseBody(request, patchBodySchema)
  if ('response' in b) return b.response
  const { id, stato, note_gestione } = b.data

  try {
    const admin = await createAdminClient()
    const update = {
      stato,
      note_gestione: note_gestione ?? null,
      // Autorship della gestione SEMPRE server-side: mai dal client.
      gestita_il: new Date().toISOString(),
      gestita_da: auth.user.id,
    }
    const { data, error } = await admin
      .from('segnalazioni')
      .update(update)
      .eq('id', id)
      .select('id')
      .maybeSingle()
    if (error) {
      if (schemaAssente(error)) {
        return NextResponse.json({ error: 'Servizio temporaneamente non disponibile' }, { status: 503 })
      }
      logErrore({ operazione: 'admin/segnalazioni:PATCH', stato: 500, evento: 'db' }, error)
      return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'Segnalazione non trovata' }, { status: 404 })

    logEvento('segnalazione', 'info', {
      operazione: 'admin/segnalazioni:PATCH',
      esito: 'segnalazione-gestita',
      stato,
    })
    return NextResponse.json({ ok: true, id: data.id })
  } catch (err) {
    logErrore({ operazione: 'admin/segnalazioni:PATCH', stato: 500 }, err)
    return NextResponse.json({ error: 'Errore interno' }, { status: 500 })
  }
})
