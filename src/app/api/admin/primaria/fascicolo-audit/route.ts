import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertAlunnoInScope, resolveScuoleAttive } from '@/lib/auth/scope'
import { parseQuery } from '@/lib/validation/http'
import { zUuid, zLimite, zBool } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'
import { FINALITA_AUDIT_ANAGRAFICA } from '@/lib/anagrafiche/docente/tipi'

const getQuerySchema = z.object({
  // '' oggi equivale ad assente (filtro saltato): normalizzato prima della validazione
  alunnoId: z.preprocess((v) => (v === '' ? undefined : v), zUuid.optional()),
  // default 100 e cap 500, ma anche un PAVIMENTO: `Math.min(limit ?? 100, 500)` era un
  // tetto senza minimo, quindi `?limit=-1` arrivava intatto a PostgREST — 416, e questa
  // rotta il ramo d'errore lo chiude con un 500 che rimanda al chiamante il `message` del
  // database. Stessa regola della rotta genitore, in un posto solo (rilievi Q18/Q20).
  limit: zLimite({ predefinito: 100, max: 500 }),
  // Le aperture della scheda anagrafica dal docente (`anagrafica-docente`) si chiedono A
  // PARTE: sono decine al giorno per insegnante, e dentro una finestra di 200 righe
  // spingerebbero fuori in poche ore le visioni vere di PEI/PDP. Di default si escludono.
  conAnagrafica: zBool.default(false),
})

// GET /api/admin/primaria/fascicolo-audit?alunnoId=&limit=&conAnagrafica=&userId=
// Vista di sola lettura del log accessi al fascicolo (immodificabile). Solo staff.
export const GET = withRoute('admin/primaria/fascicolo-audit:GET', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { alunnoId, limit, conAnagrafica } = q.data

    const supabase = await createAdminClient()

    // Isolamento per sede. Questo elenco non contiene il fascicolo, ma rivela
    // QUALI minori ne hanno uno — cioè chi ha un PEI, un PDP o una 104 — e con
    // nome e cognome. Su tutte le sedi era un'informazione che non doveva
    // uscire dal plesso. `!inner` perché il filtro sull'alunno embedded scarti
    // davvero la riga di audit.
    if (alunnoId) {
      const fuoriScope = await assertAlunnoInScope(supabase, auth.user, alunnoId)
      if (fuoriScope) return fuoriScope
    }
    const plessi = await resolveScuoleAttive(request, supabase, auth.user)
    let query = supabase
      .from('fascicolo_accessi_audit')
      .select('id, alunno_id, documento_id, utente_id, azione, finalita, ip, creato_il, utenti:utente_id(nome, cognome, ruolo, role), alunni:alunno_id!inner(nome, cognome, scuola_id)')
      .in('alunni.scuola_id', plessi)
      .order('creato_il', { ascending: false })
      .limit(limit)
    if (alunnoId) query = query.eq('alunno_id', alunnoId)
    // `or` e non `neq`: in SQL `NULL <> 'anagrafica-docente'` vale NULL, quindi un `neq`
    // scarterebbe anche le righe senza finalità, che sono la maggioranza del registro.
    // Con `alunnoId` non si esclude: «chi ha aperto il fascicolo di QUESTO bambino» comprende
    // chi ne ha aperto la scheda anagrafica, e per un bambino solo le righe sono poche.
    if (!conAnagrafica && !alunnoId) query = query.or(`finalita.is.null,finalita.neq.${FINALITA_AUDIT_ANAGRAFICA}`)

    const { data, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (err) {
    logErrore({ operazione: 'admin/primaria/fascicolo-audit:GET', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
