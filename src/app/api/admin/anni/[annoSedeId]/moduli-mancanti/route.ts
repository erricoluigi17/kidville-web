import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertAnnoSedeInScope, rispostaErroreImpostazioni } from '@/lib/anno/impostazioni'
import { leggiABlocchi } from '@/lib/anno/lettura-a-blocchi'
import { logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zUuid } from '@/lib/validation/common'
import { parseData, parseQuery } from '@/lib/validation/http'

type Contesto = { params: Promise<{ annoSedeId: string }> }

/**
 * CHI MANCA, PER MODULO (PR 4.5, compito 4.5.10, risposta 10: «la segreteria vede chi manca»). `annoSedeId` = `anni_sede.id` dell'anno.
 *
 * Per ogni modulo richiesto dell'anno: quante frequenze vive della sua lista non lo hanno spuntato (`mancanti`) e QUALI, come uuid
 * (`frequenze`). La route CONTA, non nomina: nessun nome, nessun codice fiscale, nessun documento. I nomi li dà la pagina per le
 * righe che ha già, o il cruscotto (4.7). Il filtro «chi ha i moduli ma non la quota, e viceversa» è del cruscotto, non di qui.
 *
 * «Viva» = `in_attesa` o `iscritto`, e `tipo` uguale alla lista del modulo: chi arriva dal recupero (`tipo` NULL) non ha moduli.
 * Gate e perimetro: staff, e l'anno dev'essere di una sede dell'utente.
 */
const STAFF = ['admin', 'coordinator', 'segreteria'] as const
const TIPO_RIFIUTO = 'anno-iscrizioni-rifiutate' as const
const VIVE = ['in_attesa', 'iscritto']

/** Nessun parametro in query: `userId` è consumato dal gate identità. */
const getQuerySchema = z.object({})

export const GET = withRoute('admin/anni/[annoSedeId]/moduli-mancanti:GET', async (request: NextRequest, context: Contesto) => {
  const auth = await requireStaff(request, [...STAFF])
  if (auth.response) return auth.response
  const operazione = 'admin/anni/[annoSedeId]/moduli-mancanti:GET'
  const { annoSedeId: grezzo } = await context.params

  const id = parseData(zUuid, grezzo)
  if ('response' in id) return id.response
  const annoSedeId = id.data
  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response

  const supabase = await createAdminClient()
  const fuoriSede = await assertAnnoSedeInScope(supabase, auth.user, annoSedeId, operazione)
  if (fuoriSede) return fuoriSede
  const ctx = { operazione, annoSedeId, utente: auth.user.id, tipoRifiuto: TIPO_RIFIUTO, lettura: true } as const

  const m = await supabase
    .from('moduli_richiesti')
    .select('id, codice, lista, ordine')
    .eq('anno_sede_id', annoSedeId)
    .order('lista', { ascending: true })
    .order('ordine', { ascending: true })
    .order('codice', { ascending: true })
  if (m.error) return rispostaErroreImpostazioni(m.error, ctx)
  const moduli = (Array.isArray(m.data) ? m.data : []) as Array<{ id: string; codice: string; lista: string; ordine: number }>
  if (moduli.length === 0) {
    logEvento('anno-scolastico', 'info', { tipo: 'moduli-mancanti-letti', operazione, anno_sede_id: annoSedeId, utente: auth.user.id, n: 0 })
    return NextResponse.json({ success: true, data: { moduli: [] } })
  }

  // Le frequenze vive dell'anno, e tutte le spunte dei suoi moduli: a blocchi, poche colonne, mai oltre il tetto di PostgREST.
  const f = await leggiABlocchi<{ id: string; tipo: string | null }>((da, a) =>
    supabase.from('frequenze').select('id, tipo').eq('anno_sede_id', annoSedeId).in('stato', VIVE).order('id', { ascending: true }).range(da, a),
  )
  if ('error' in f) return rispostaErroreImpostazioni(f.error, ctx)
  const s = await leggiABlocchi<{ frequenza_id: string; modulo_id: string }>((da, a) =>
    supabase
      .from('frequenze_moduli')
      .select('frequenza_id, modulo_id')
      .in('modulo_id', moduli.map((x) => x.id))
      .order('id', { ascending: true })
      .range(da, a),
  )
  if ('error' in s) return rispostaErroreImpostazioni(s.error, ctx)
  const spuntati = new Set(s.righe.map((x) => `${x.frequenza_id}:${x.modulo_id}`))

  const data = moduli.map((x) => {
    const frequenze = f.righe.filter((r) => r.tipo === x.lista && !spuntati.has(`${r.id}:${x.id}`)).map((r) => r.id)
    return { modulo_id: x.id, codice: x.codice, lista: x.lista, mancanti: frequenze.length, frequenze }
  })

  logEvento('anno-scolastico', 'info', {
    tipo: 'moduli-mancanti-letti',
    operazione,
    anno_sede_id: annoSedeId,
    utente: auth.user.id,
    n: data.length,
  })
  return NextResponse.json({ success: true, data: { moduli: data } })
})
