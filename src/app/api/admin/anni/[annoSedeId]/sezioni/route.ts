import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { requireStaff } from '@/lib/auth/require-staff'
import {
  assertAnnoSedeInScope,
  rispostaErroreImpostazioni,
  rispostaNonRiconosciuta,
} from '@/lib/anno/impostazioni'
import { logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zUuid } from '@/lib/validation/common'
import { parseBody, parseData } from '@/lib/validation/http'

const OPERAZIONE = 'admin/anni/[annoSedeId]/sezioni:POST'
const STAFF = ['admin', 'coordinator', 'segreteria'] as const
const FASCE = ['nido_1', 'nido_2', 'primavera', 'infanzia', 'primaria', 'spazio_bambini'] as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * POST — copia le sezioni dell'anno in corso della sede nell'anno che si sta preparando (`annoSedeId`), con
 * `anno_copia_sezioni` (M45d). Serve a RILANCIARE la copia dopo aver aggiunto una classe all'anno in corso: all'apertura
 * delle iscrizioni la fa già `anno_apri_iscrizioni`. Corpo vuoto: l'anno di partenza è sempre quello attivo della sede.
 * Rifatta non duplica niente: `{ copiate, gia_presenti }`. Non copia mai docenti, orari o materie.
 *
 * Nessun anno in corso da cui partire = niente da copiare, non un errore (`copiate: 0`, con un `info`).
 */
export const POST = withRoute(
  'admin/anni/[annoSedeId]/sezioni:POST',
  async (request: NextRequest, context: { params: Promise<{ annoSedeId: string }> }) => {
    const auth = await requireStaff(request, ['admin', 'coordinator', 'segreteria'])
    if (auth.response) return auth.response
    const { annoSedeId: grezzo } = await context.params

    const id = parseData(zUuid, grezzo)
    if ('response' in id) return id.response
    const annoSedeId = id.data

    const supabase = await createAdminClient()
    const annoLetto: { scuolaId?: string } = {}
    const fuoriSede = await assertAnnoSedeInScope(supabase, auth.user, annoSedeId, OPERAZIONE, annoLetto)
    if (fuoriSede) return fuoriSede
    const chi = { utente: auth.user.id, annoSedeId }
    const contestoErrore = { ...chi, operazione: OPERAZIONE, tipoRifiuto: 'anno-iscrizioni-rifiutate' as const }

    const attivo = await supabase.rpc('anno_attivo', { p_scuola: annoLetto.scuolaId })
    if (attivo.error) return rispostaErroreImpostazioni(attivo.error, contestoErrore)
    const partenza = typeof attivo.data === 'string' && UUID.test(attivo.data) ? attivo.data : null
    if (!partenza) {
      logEvento('anno-scolastico', 'info', { tipo: 'anno-sezioni-senza-partenza', anno_sede_id: annoSedeId, utente: auth.user.id })
      return NextResponse.json({ success: true, data: { copiate: 0, gia_presenti: 0 } })
    }

    const { data, error } = await supabase.rpc('anno_copia_sezioni', { p_da: partenza, p_a: annoSedeId })
    if (error) return rispostaErroreImpostazioni(error, contestoErrore)
    const r = data as { copiate?: unknown; gia_presenti?: unknown } | null
    if (!r || typeof r.copiate !== 'number' || typeof r.gia_presenti !== 'number') return rispostaNonRiconosciuta(OPERAZIONE)

    // Anche una copia che non ha copiato niente è un fatto da vedere (la segreteria ha premuto il pulsante): `n` è il conteggio.
    logEvento('anno-scolastico', 'info', {
      tipo: 'anno-sezioni-copiate',
      anno_sede_id: annoSedeId,
      utente: auth.user.id,
      n: r.copiate,
    })
    return NextResponse.json({ success: true, data: { copiate: r.copiate, gia_presenti: r.gia_presenti } })
  },
)

type Contesto = { params: Promise<{ annoSedeId: string }> }
type RigaClasse = { id: string; name: string; school_type: string; fascia: string | null }

/**
 * GET — le classi dell'anno che si sta preparando (o già aperto) con la loro fascia: la scheda «Classi» le mostra e lascia scegliere la
 * fascia (4.5.15, C3). `{ success: true, data: { sezioni: [{ id, name, school_type, fascia }] } }`. Il nome di una classe non è un dato
 * personale. Solo un anno `in_preparazione` o `iscrizioni_aperte`: l'anno in corso non si cambia da qui.
 */
export const GET = withRoute('admin/anni/[annoSedeId]/sezioni:GET', async (request: NextRequest, context: Contesto) => {
  const auth = await requireStaff(request, [...STAFF])
  if (auth.response) return auth.response
  const operazione = 'admin/anni/[annoSedeId]/sezioni:GET'
  const { annoSedeId: grezzo } = await context.params

  const id = parseData(zUuid, grezzo)
  if ('response' in id) return id.response
  const annoSedeId = id.data

  const supabase = await createAdminClient()
  const fuoriSede = await assertAnnoSedeInScope(supabase, auth.user, annoSedeId, operazione)
  if (fuoriSede) return fuoriSede
  const contesto = { annoSedeId, utente: auth.user.id, operazione, tipoRifiuto: 'anno-iscrizioni-rifiutate' as const, lettura: true }

  const anno = await supabase.from('anni_sede').select('anno_id, scuola_id, stato').eq('id', annoSedeId).maybeSingle()
  if (anno.error) return rispostaErroreImpostazioni(anno.error, contesto)
  const a = anno.data as { anno_id?: string; scuola_id?: string; stato?: string } | null
  if (!a?.anno_id || !a.scuola_id) return rispostaErroreImpostazioni({ message: 'ANNO_NON_TROVATO' }, contesto)
  if (a.stato !== 'in_preparazione' && a.stato !== 'iscrizioni_aperte') {
    return rispostaErroreImpostazioni({ message: 'ANNO_NON_MODIFICABILE' }, contesto)
  }

  const { data, error } = await supabase
    .from('sections')
    .select('id, name, school_type, fascia')
    .eq('scuola_id', a.scuola_id)
    .eq('anno_id', a.anno_id)
    .order('name', { ascending: true })
  if (error) return rispostaErroreImpostazioni(error, contesto)
  return NextResponse.json({ success: true, data: { sezioni: (Array.isArray(data) ? data : []) as RigaClasse[] } })
})

/** `fascia: null` toglie la fascia. Elenco chiuso: un testo qualunque è un 400. */
const patchSchema = z
  .object({
    section_id: zUuid,
    fascia: z.enum(FASCE).nullable(),
  })
  .strict()

/**
 * PATCH — la segreteria sceglie la fascia di una classe dell'anno (`anno_sezione_fascia_imposta`, M45d). La classe dev'essere di
 * QUELL'anno (altrimenti 422 `SEZIONE_DI_ALTRO_ANNO`). Nel log: uuid e il codice della fascia.
 */
export const PATCH = withRoute('admin/anni/[annoSedeId]/sezioni:PATCH', async (request: NextRequest, context: Contesto) => {
  const auth = await requireStaff(request, [...STAFF])
  if (auth.response) return auth.response
  const operazione = 'admin/anni/[annoSedeId]/sezioni:PATCH'
  const { annoSedeId: grezzo } = await context.params

  const id = parseData(zUuid, grezzo)
  if ('response' in id) return id.response
  const annoSedeId = id.data

  const b = await parseBody(request, patchSchema)
  if ('response' in b) return b.response
  const corpo = b.data

  const supabase = await createAdminClient()
  const fuoriSede = await assertAnnoSedeInScope(supabase, auth.user, annoSedeId, operazione)
  if (fuoriSede) return fuoriSede

  const { data, error } = await supabase.rpc('anno_sezione_fascia_imposta', {
    p_anno_sede: annoSedeId,
    p_section: corpo.section_id,
    p_fascia: corpo.fascia,
  })
  if (error) {
    return rispostaErroreImpostazioni(error, { annoSedeId, utente: auth.user.id, operazione, tipoRifiuto: 'anno-iscrizioni-rifiutate' })
  }
  const r = data as { cambiato?: unknown } | null
  if (!r || typeof r.cambiato !== 'boolean') return rispostaNonRiconosciuta(operazione)

  if (r.cambiato) {
    logEvento('anno-scolastico', 'info', {
      tipo: 'anno-sezione-fascia-impostata',
      anno_sede_id: annoSedeId,
      utente: auth.user.id,
      entita_id: corpo.section_id,
      // il codice della fascia (elenco chiuso) sta sotto `entita_tipo`, una chiave in chiaro della lista bianca
      entita_tipo: corpo.fascia ?? 'nessuna',
    })
  }
  return NextResponse.json({ success: true, data: { cambiato: r.cambiato, section_id: corpo.section_id, fascia: corpo.fascia } })
})
