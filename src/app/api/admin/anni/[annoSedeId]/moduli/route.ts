import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireStaff } from '@/lib/auth/require-staff'
import {
  assertAnnoSedeInScope,
  risultatoScrittura,
  rispostaErroreImpostazioni,
  rispostaNonRiconosciuta,
} from '@/lib/anno/impostazioni'
import { logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zUuid } from '@/lib/validation/common'
import { parseBody, parseData, parseQuery } from '@/lib/validation/http'

type Contesto = { params: Promise<{ annoSedeId: string }> }

/**
 * I MODULI RICHIESTI dell'anno che si sta preparando, per lista (`conferma` = chi continua, `nuova` = chi si iscrive).
 * La regola sta in `anno_modulo_richiesto_imposta` / `_togli` (M45d). Il titolo è l'unico testo: fino a 120 caratteri e
 * mai nei log. Il `codice` è la chiave stabile del modulo (minuscole, cifre, trattini bassi).
 */
const STAFF = ['admin', 'coordinator', 'segreteria'] as const
const zLista = z.enum(['conferma', 'nuova'])
const zCodice = z.string().regex(/^[a-z0-9][a-z0-9_]{0,59}$/)

type RigaModulo = { lista: string; codice: string; titolo: string; ordine: number }

/** GET — i moduli dell'anno, per lista e per ordine. `{ success: true, data: { moduli: [...] } }`. */
export const GET = withRoute('admin/anni/[annoSedeId]/moduli:GET', async (request: NextRequest, context: Contesto) => {
  const auth = await requireStaff(request, [...STAFF])
  if (auth.response) return auth.response
  const operazione = 'admin/anni/[annoSedeId]/moduli:GET'
  const { annoSedeId: grezzo } = await context.params

  const id = parseData(zUuid, grezzo)
  if ('response' in id) return id.response
  const annoSedeId = id.data

  const supabase = await createAdminClient()
  const fuoriSede = await assertAnnoSedeInScope(supabase, auth.user, annoSedeId, operazione)
  if (fuoriSede) return fuoriSede

  const { data, error } = await supabase
    .from('moduli_richiesti')
    .select('lista, codice, titolo, ordine')
    .eq('anno_sede_id', annoSedeId)
    .order('lista', { ascending: true })
    .order('ordine', { ascending: true })
    .order('codice', { ascending: true })
  if (error) {
    return rispostaErroreImpostazioni(error, {
      operazione,
      annoSedeId,
      utente: auth.user.id,
      tipoRifiuto: 'anno-iscrizioni-rifiutate',
      lettura: true,
    })
  }
  return NextResponse.json({ success: true, data: { moduli: (Array.isArray(data) ? data : []) as RigaModulo[] } })
})

const putSchema = z
  .object({
    lista: zLista,
    codice: zCodice,
    titolo: z.string().trim().min(1).max(120),
    ordine: z.number().int().min(0).max(1000).optional(),
  })
  .strict()

/** PUT — crea il modulo o ne cambia titolo e ordine. */
export const PUT = withRoute('admin/anni/[annoSedeId]/moduli:PUT', async (request: NextRequest, context: Contesto) => {
  const auth = await requireStaff(request, [...STAFF])
  if (auth.response) return auth.response
  const operazione = 'admin/anni/[annoSedeId]/moduli:PUT'
  const { annoSedeId: grezzo } = await context.params

  const id = parseData(zUuid, grezzo)
  if ('response' in id) return id.response
  const annoSedeId = id.data

  const b = await parseBody(request, putSchema)
  if ('response' in b) return b.response
  const corpo = b.data

  const supabase = await createAdminClient()
  const fuoriSede = await assertAnnoSedeInScope(supabase, auth.user, annoSedeId, operazione)
  if (fuoriSede) return fuoriSede

  const { data, error } = await supabase.rpc('anno_modulo_richiesto_imposta', {
    p_anno_sede: annoSedeId,
    p_lista: corpo.lista,
    p_codice: corpo.codice,
    p_titolo: corpo.titolo,
    p_ordine: corpo.ordine ?? null,
  })
  if (error) {
    return rispostaErroreImpostazioni(error, {
      operazione,
      annoSedeId,
      utente: auth.user.id,
      tipoRifiuto: 'anno-iscrizioni-rifiutate',
    })
  }
  const r = risultatoScrittura(data)
  if (!r) return rispostaNonRiconosciuta(operazione)

  if (r.cambiato) {
    // Né il titolo né il codice: solo la lista (un codice fisso) e chi ha agito.
    logEvento('anno-scolastico', 'info', {
      tipo: 'anno-modulo-impostato',
      anno_sede_id: annoSedeId,
      utente: auth.user.id,
      entita_tipo: corpo.lista,
    })
  }
  return NextResponse.json({ success: true, data: r })
})

const deleteSchema = z.object({ lista: zLista, codice: zCodice })

/** DELETE `?lista=…&codice=…` — toglie il modulo (e con lui le spunte già fatte). Toglierne uno che non c'è: `cambiato: false`. */
export const DELETE = withRoute('admin/anni/[annoSedeId]/moduli:DELETE', async (request: NextRequest, context: Contesto) => {
  const auth = await requireStaff(request, [...STAFF])
  if (auth.response) return auth.response
  const operazione = 'admin/anni/[annoSedeId]/moduli:DELETE'
  const { annoSedeId: grezzo } = await context.params

  const id = parseData(zUuid, grezzo)
  if ('response' in id) return id.response
  const annoSedeId = id.data

  const q = parseQuery(request, deleteSchema)
  if ('response' in q) return q.response

  const supabase = await createAdminClient()
  const fuoriSede = await assertAnnoSedeInScope(supabase, auth.user, annoSedeId, operazione)
  if (fuoriSede) return fuoriSede

  const { data, error } = await supabase.rpc('anno_modulo_richiesto_togli', {
    p_anno_sede: annoSedeId,
    p_lista: q.data.lista,
    p_codice: q.data.codice,
  })
  if (error) {
    return rispostaErroreImpostazioni(error, {
      operazione,
      annoSedeId,
      utente: auth.user.id,
      tipoRifiuto: 'anno-iscrizioni-rifiutate',
    })
  }
  const r = risultatoScrittura(data)
  if (!r) return rispostaNonRiconosciuta(operazione)

  if (r.cambiato) {
    logEvento('anno-scolastico', 'info', {
      tipo: 'anno-modulo-tolto',
      anno_sede_id: annoSedeId,
      utente: auth.user.id,
      entita_tipo: q.data.lista,
    })
  }
  return NextResponse.json({ success: true, data: r })
})
