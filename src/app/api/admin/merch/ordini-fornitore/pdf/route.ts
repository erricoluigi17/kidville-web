import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { scuoleDiUtente } from '@/lib/auth/scope'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { getModuleConfig } from '@/lib/settings/module-config'
import { datiStruttura, type ArubaFiscalConfig, type FiscaleConfig } from '@/lib/pagamenti/fiscale'
import { buildOrdineFornitorePdf } from '@/lib/merch/pdf'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// GET /api/admin/merch/ordini-fornitore/pdf?id= — PDF (ristampabile) del PO al
// fornitore: intestazione committente (scuola) + fornitore + matrice articolo/taglia.

const getQuerySchema = z.object({ id: zUuid })

export const GET = withRoute('admin/merch/ordini-fornitore/pdf:GET', async (request: Request) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { id } = q.data

    const supabase = await createAdminClient()
    const plessi = await scuoleDiUtente(supabase, auth.user)
    const { data: po } = await supabase
      .from('merch_ordini_fornitore')
      .select('id, scuola_id, fornitore_id, fornitore_nome, numero, note, creato_il')
      .eq('id', id)
      .maybeSingle()
    if (!po) return NextResponse.json({ error: 'PO non trovato' }, { status: 404 })
    if (!plessi.includes(po.scuola_id as string)) {
      return NextResponse.json({ error: 'Accesso negato: PO fuori dal tuo plesso' }, { status: 403 })
    }

    const [{ data: forn }, { data: righe }] = await Promise.all([
      po.fornitore_id
        ? supabase.from('merch_fornitori').select('nome, referente, email, telefono, indirizzo, piva').eq('id', po.fornitore_id).maybeSingle()
        : Promise.resolve({ data: null }),
      supabase.from('divise_ordini_righe').select('articolo_nome, taglia, quantita, stato').eq('ordine_fornitore_id', id),
    ])

    const fiscale = (await getModuleConfig(supabase, 'fiscale_config', po.scuola_id as string)) as FiscaleConfig
    const aruba = (await getModuleConfig(supabase, 'aruba_config', po.scuola_id as string)) as ArubaFiscalConfig
    const struttura = datiStruttura(fiscale, aruba)

    const righeValide = (righe ?? [])
      .filter((r) => String(r.stato) !== 'annullato')
      .map((r) => ({ articolo: String(r.articolo_nome), taglia: String(r.taglia ?? ''), quantita: Number(r.quantita) }))

    const pdf = buildOrdineFornitorePdf({
      numero: po.numero as string,
      data: po.creato_il ? new Date(po.creato_il as string).toLocaleDateString('it-IT') : null,
      committente: {
        denominazione: struttura.denominazione,
        piva: struttura.piva,
        indirizzo: [struttura.indirizzo, [struttura.cap, struttura.comune, struttura.provincia].filter(Boolean).join(' ')].filter(Boolean).join(' — '),
      },
      fornitore: {
        nome: (forn?.nome as string) ?? (po.fornitore_nome as string),
        referente: (forn?.referente as string) ?? null,
        email: (forn?.email as string) ?? null,
        telefono: (forn?.telefono as string) ?? null,
        indirizzo: (forn?.indirizzo as string) ?? null,
        piva: (forn?.piva as string) ?? null,
      },
      righe: righeValide,
      note: (po.note as string) ?? null,
    })

    return new NextResponse(pdf, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${po.numero}.pdf"`,
      },
    })
  } catch (err) {
    logErrore({ operazione: 'admin/merch/ordini-fornitore/pdf:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
