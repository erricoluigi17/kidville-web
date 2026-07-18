import { NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { parseData } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { emettiORecuperaRicevutaTransazione, type TransazionePerRicevuta } from '@/lib/pagamenti/ricevute'
import { buildRicevutaFamigliaPdf } from '@/lib/pagamenti/pdf'
import { datiStruttura, isTracciabile } from '@/lib/pagamenti/fiscale'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// Schema locale: l'unico input è il param dinamico [id] (uuid della transazione).
const idSchema = zUuid

const dataIt = (d?: string | null) => (d ? new Date(d).toLocaleDateString('it-IT') : undefined)

type SupabaseAdmin = Awaited<ReturnType<typeof createAdminClient>>
type CaricaTransazione =
  | { response: NextResponse; supabase?: undefined; tx?: undefined; userId?: undefined }
  | { response?: undefined; supabase: SupabaseAdmin; tx: TransazionePerRicevuta; userId: string }

async function caricaTransazione(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<CaricaTransazione> {
  const auth = await requireStaff(request)
  if (auth.response) return { response: auth.response as NextResponse }
  const { id: idGrezzo } = await context.params
  const pid = parseData(idSchema, idGrezzo)
  if ('response' in pid) return { response: pid.response }
  const id = pid.data

  const supabase = await createAdminClient()
  const { data: tx, error } = await supabase
    .from('pagamenti_transazioni')
    .select('id, scuola_id, pagante_parent_id, importo_totale, metodo, riferimento, data_valuta, note, annullata_il, creato_il')
    .eq('id', id)
    .maybeSingle()
  if (error) {
    logErrore({ operazione: 'pagamenti/transazioni/[id]/ricevuta', stato: 500, evento: 'db' }, error)
    return { response: NextResponse.json({ error: 'Errore nel recupero della transazione' }, { status: 500 }) }
  }
  if (!tx) return { response: NextResponse.json({ error: 'Transazione non trovata' }, { status: 404 }) }
  const sedi = await resolveScuoleAttive(request as NextRequest, supabase, auth.user)
  if (!sedi.includes(String((tx as { scuola_id: string }).scuola_id))) {
    return { response: NextResponse.json({ error: 'Transazione non trovata' }, { status: 404 }) }
  }
  if ((tx as { annullata_il?: string | null }).annullata_il) {
    return { response: NextResponse.json({ error: 'Transazione annullata: nessuna ricevuta.' }, { status: 409 }) }
  }
  return { supabase, tx: tx as unknown as TransazionePerRicevuta, userId: auth.user.id }
}

// GET /api/pagamenti/transazioni/[id]/ricevuta  (staff) — PDF ricevuta famiglia.
export const GET = withRoute('pagamenti/transazioni/[id]/ricevuta:GET', async (request: Request, context: { params: Promise<{ id: string }> }) => {
  try {
    const r = await caricaTransazione(request, context)
    if (r.response) return r.response
    const { supabase, tx, userId } = r

    const esito = await emettiORecuperaRicevutaTransazione(supabase, tx, { creatoDa: userId })
    if (!esito.ok) {
      return NextResponse.json({ error: 'Errore nell’emissione della ricevuta', details: esito.messaggio }, { status: 500 })
    }
    const record = esito.legacy ? null : esito.record

    const pdf = buildRicevutaFamigliaPdf({
      numero: record?.numero ?? null,
      anno: record?.anno ?? null,
      struttura: record?.dati_struttura ?? datiStruttura(null, null),
      intestatario: record?.intestatario ?? null,
      righe: record?.righe ?? [],
      importoTotale: record ? Number(record.importo) : Number(tx.importo_totale),
      metodo: tx.metodo,
      riferimento: tx.riferimento,
      dataValuta: tx.data_valuta,
      tracciabile: record?.tracciabile ?? isTracciabile([tx.metodo]),
      bollo: record?.bollo ?? false,
      dicituraBollo: record?.dati_struttura?.dicitura_bollo,
      emessaIl: record ? dataIt(record.creato_il) : undefined,
    })

    const filename = record ? `ricevuta-famiglia-${record.numero}-${record.anno}.pdf` : `ricevuta-famiglia-${tx.id.slice(0, 8)}.pdf`
    return new NextResponse(pdf, {
      status: 200,
      headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${filename}"` },
    })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/transazioni/[id]/ricevuta:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// POST /api/pagamenti/transazioni/[id]/ricevuta  (staff) — emette e ritorna i metadati.
export const POST = withRoute('pagamenti/transazioni/[id]/ricevuta:POST', async (request: Request, context: { params: Promise<{ id: string }> }) => {
  try {
    const r = await caricaTransazione(request, context)
    if (r.response) return r.response
    const { supabase, tx, userId } = r

    const esito = await emettiORecuperaRicevutaTransazione(supabase, tx, { creatoDa: userId })
    if (!esito.ok) {
      return NextResponse.json({ error: 'Errore nell’emissione della ricevuta', details: esito.messaggio }, { status: 500 })
    }
    if (esito.legacy) {
      // Registro non disponibile su questo ambiente: nessun numero, ma non è un errore.
      return NextResponse.json({ success: true, data: { legacy: true } })
    }
    logEvento('pagamento', 'info', {
      operazione: 'pagamenti/transazioni/[id]/ricevuta:POST',
      esito: 'ricevuta_emessa',
      transazione_id: tx.id,
      numero: esito.record.numero,
    })
    return NextResponse.json({ success: true, data: { numero: esito.record.numero, anno: esito.record.anno } })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/transazioni/[id]/ricevuta:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
