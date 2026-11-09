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
import { parseBody, parseData } from '@/lib/validation/http'

type Contesto = { params: Promise<{ annoSedeId: string }> }

/**
 * Le RETTE e i SERVIZI MENSILI del listino di un anno (`annoSedeId` = `anni_sede.id`): l'importo mensile per fascia o per
 * tutte, e i mesi in cui si genera. La regola (stati ammessi, importo > 0, categoria, specchio del default di sede) sta in
 * `anno_listino_retta_imposta` (M46b); qui si giudicano chi chiede e per quale sede, si valida il corpo e si traduce il
 * rifiuto. Nessun importo è scritto nel codice: lo decide la segreteria.
 */
const STAFF = ['admin', 'coordinator', 'segreteria'] as const
const FASCE = ['nido_1', 'nido_2', 'primavera', 'infanzia', 'primaria', 'spazio_bambini'] as const
const TENTATIVO = { tipoRifiuto: 'anno-iscrizioni-rifiutate' } as const

type RigaRetta = {
  voce: string
  fascia: string | null
  payment_category_id: string | null
  importo: number | null
  mesi: number[] | null
}

/**
 * GET — le righe `retta` e `servizio` del listino dell'anno, i mesi che VALGONO oggi per ciascuna voce (`mesi_effettivi`,
 * calcolati dal database: settembre-giugno se nessuno li ha scelti) e le fasce che le sezioni dell'anno usano davvero
 * (`fasce_in_uso`). Finché nessuna sezione ha una fascia, le righe per fascia non hanno effetto e la schermata lo dice.
 * `{ success: true, data: { rette: [...], mesi_effettivi: { retta: [...], servizio: [...] }, fasce_in_uso: [...] } }`.
 */
export const GET = withRoute('admin/anni/[annoSedeId]/rette:GET', async (request: NextRequest, context: Contesto) => {
  const auth = await requireStaff(request, [...STAFF])
  if (auth.response) return auth.response
  const operazione = 'admin/anni/[annoSedeId]/rette:GET'
  const { annoSedeId: grezzo } = await context.params

  const id = parseData(zUuid, grezzo)
  if ('response' in id) return id.response
  const annoSedeId = id.data

  const supabase = await createAdminClient()
  const fuoriSede = await assertAnnoSedeInScope(supabase, auth.user, annoSedeId, operazione)
  if (fuoriSede) return fuoriSede
  const contesto = { operazione, annoSedeId, utente: auth.user.id, ...TENTATIVO, lettura: true }

  const voci = await supabase
    .from('listino_voci')
    .select('voce, fascia, payment_category_id, importo, mesi')
    .eq('anno_sede_id', annoSedeId)
    .in('voce', ['retta', 'servizio'])
    .order('voce', { ascending: true })
    .order('fascia', { ascending: true, nullsFirst: true })
  if (voci.error) return rispostaErroreImpostazioni(voci.error, contesto)
  const rette = (Array.isArray(voci.data) ? voci.data : []) as RigaRetta[]

  // I mesi li decide il database (una sola definizione di «settembre-giugno»): qui non si ricalcolano.
  const mesiEffettivi: Record<string, number[]> = {}
  for (const voce of ['retta', 'servizio'] as const) {
    const m = await supabase.rpc('listino_mesi', { p_anno_sede: annoSedeId, p_voce: voce })
    if (m.error) return rispostaErroreImpostazioni(m.error, contesto)
    mesiEffettivi[voce] = Array.isArray(m.data) ? (m.data as number[]) : []
  }

  const anno = await supabase.from('anni_sede').select('anno_id, scuola_id').eq('id', annoSedeId).maybeSingle()
  if (anno.error) return rispostaErroreImpostazioni(anno.error, contesto)
  const a = anno.data as { anno_id?: string; scuola_id?: string } | null
  let fasceInUso: string[] = []
  if (a?.anno_id && a.scuola_id) {
    const sez = await supabase.from('sections').select('fascia').eq('scuola_id', a.scuola_id).eq('anno_id', a.anno_id)
    if (sez.error) return rispostaErroreImpostazioni(sez.error, contesto)
    const viste = new Set<string>()
    for (const s of (Array.isArray(sez.data) ? sez.data : []) as Array<{ fascia: string | null }>) {
      if (s.fascia) viste.add(s.fascia)
    }
    fasceInUso = [...viste].sort()
  }

  return NextResponse.json({ success: true, data: { rette, mesi_effettivi: mesiEffettivi, fasce_in_uso: fasceInUso } })
})

/**
 * Il corpo: UNA riga per volta, `strict`. `fascia: null` = per tutte le fasce; `importo: null` toglie la riga; `mesi`
 * solo sulla riga senza fascia (il database rifiuta il resto con `PARAMETRO_MANCANTE`). L'importo è un NUMERO (una stringa
 * è un 400): se è positivo lo giudica il database, che risponde `IMPORTO_NON_VALIDO` (422).
 */
const putSchema = z
  .object({
    voce: z.enum(['retta', 'servizio']),
    fascia: z.enum(FASCE).nullable(),
    categoria_id: zUuid.nullable().optional(),
    importo: z.number().finite().nullable(),
    mesi: z.array(z.number().int().min(1).max(12)).max(12).nullable().optional(),
  })
  .strict()
  // Una sola riga «retta» per fascia: la categoria si dichiara solo per il servizio (altrimenti nascono due righe senza fascia).
  .refine((c) => !(c.voce === 'retta' && c.categoria_id), { message: 'categoria_id vale solo per il servizio', path: ['categoria_id'] })
  // Togliere la riga e dare dei mesi insieme perderebbe i mesi in silenzio.
  .refine((c) => !(c.importo === null && c.mesi), { message: 'senza importo i mesi non si possono dare', path: ['mesi'] })

/** PUT — imposta (o toglie) la riga di retta o di servizio nominata. */
export const PUT = withRoute('admin/anni/[annoSedeId]/rette:PUT', async (request: NextRequest, context: Contesto) => {
  const auth = await requireStaff(request, [...STAFF])
  if (auth.response) return auth.response
  const operazione = 'admin/anni/[annoSedeId]/rette:PUT'
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

  const { data, error } = await supabase.rpc('anno_listino_retta_imposta', {
    p_anno_sede: annoSedeId,
    p_voce: corpo.voce,
    p_fascia: corpo.fascia,
    p_categoria: corpo.categoria_id ?? null,
    p_importo: corpo.importo,
    p_mesi: corpo.mesi ?? null,
  })
  if (error) {
    return rispostaErroreImpostazioni(error, { operazione, annoSedeId, utente: auth.user.id, ...TENTATIVO })
  }
  const r = risultatoScrittura(data)
  if (!r) return rispostaNonRiconosciuta(operazione)

  // Il successo si scrive solo se qualcosa è cambiato. Niente importo, niente mesi: sono uuid, un codice e un flag.
  if (r.cambiato) {
    logEvento('anno-scolastico', 'info', {
      tipo: 'anno-retta-impostata',
      anno_sede_id: annoSedeId,
      utente: auth.user.id,
      entita_tipo: corpo.voce,
      rimossa: corpo.importo === null,
    })
  }
  return NextResponse.json({ success: true, data: r })
})
