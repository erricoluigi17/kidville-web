import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { calcolaAttestazione, type VoceAttestazione } from '@/lib/pagamenti/attestazione'
import { datiStruttura, type ArubaFiscalConfig, type FiscaleConfig } from '@/lib/pagamenti/fiscale'
import { resolveParentRegistry } from '@/lib/pagamenti/intestatari'
import { buildAttestazionePdf } from '@/lib/pagamenti/pdf'
import { getModuleConfig } from '@/lib/settings/module-config'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

const getQuerySchema = z.object({
  alunno_id: zUuid,
  anno: z.coerce.number().int().min(2000).max(2100),
})

// GET /api/pagamenti/attestazione?alunno_id=&anno=&userId= — attestazione
// annuale dei pagamenti (per il 730): criterio di cassa sull'anno solare,
// totale versato vs totale TRACCIABILE detraibile (contanti e categorie
// divise/materiale esclusi). Accesso: SOLO staff (segreteria/direzione):
// l'attestazione la rilascia la segreteria su richiesta del genitore.
export const GET = withRoute('pagamenti/attestazione:GET', async (request: Request) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { alunno_id: alunnoId, anno } = q.data

    const supabase = await createAdminClient()
    const { data: alunno } = await supabase
      .from('alunni')
      .select('id, nome, cognome, codice_fiscale, scuola_id, intestatario_fatture')
      .eq('id', alunnoId)
      .maybeSingle()
    if (!alunno) return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 })

    // L'alunno deve appartenere a una sede attiva della segreteria (niente PDF
    // con codici fiscali di alunno/pagatore di un altro plesso).
    const sedi = await resolveScuoleAttive(request as NextRequest, supabase, user)
    if (!sedi.includes(String(alunno.scuola_id))) {
      return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 })
    }

    // Pagamenti dell'alunno → incassi dell'anno solare (criterio di cassa).
    const { data: pagamenti } = await supabase
      .from('pagamenti')
      .select('id, descrizione, payment_categories ( slug )')
      .eq('alunno_id', alunnoId)
    const byId = new Map(
      ((pagamenti || []) as { id: string; descrizione?: string | null; payment_categories?: { slug?: string | null } | null }[])
        .map((p) => [p.id, p]),
    )

    let voci: VoceAttestazione[] = []
    if (byId.size > 0) {
      const { data: incassi } = await supabase
        .from('incassi')
        .select('pagamento_id, importo, metodo, data_incasso')
        .in('pagamento_id', [...byId.keys()])
        .gte('data_incasso', `${anno}-01-01`)
        .lte('data_incasso', `${anno}-12-31`)
      voci = ((incassi || []) as { pagamento_id: string; importo: number; metodo?: string | null }[]).map((i) => {
        const pag = byId.get(i.pagamento_id)
        return {
          importo: i.importo,
          metodo: i.metodo,
          categoria_slug: pag?.payment_categories?.slug ?? null,
          descrizione: pag?.descrizione ?? '—',
        }
      })
    }

    const riepilogo = calcolaAttestazione(voci)
    const fiscale = (await getModuleConfig(supabase, 'fiscale_config', alunno.scuola_id)) as FiscaleConfig
    const aruba = (await getModuleConfig(supabase, 'aruba_config', alunno.scuola_id)) as ArubaFiscalConfig

    const intestatarioCfg = alunno.intestatario_fatture as { adult_id?: string | null } | null
    const reg = await resolveParentRegistry(supabase, intestatarioCfg?.adult_id)
    const intestatario = reg
      ? { nome: [reg.first_name, reg.last_name].filter(Boolean).join(' '), codice_fiscale: reg.fiscal_code }
      : { nome: `Famiglia ${alunno.cognome ?? ''}`.trim() }

    const pdf = buildAttestazionePdf({
      anno,
      struttura: datiStruttura(fiscale, aruba),
      intestatario,
      alunno: `${alunno.nome ?? ''} ${alunno.cognome ?? ''}`.trim(),
      codiceFiscaleAlunno: alunno.codice_fiscale as string | null,
      righe: riepilogo.righe,
      versato: riepilogo.versato,
      detraibile: riepilogo.detraibile,
      nonTracciabile: riepilogo.nonTracciabile,
      escluso: riepilogo.escluso,
    })

    return new NextResponse(pdf, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="attestazione-${anno}-${(alunno.cognome ?? 'alunno').toString().toLowerCase()}.pdf"`,
      },
    })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/attestazione:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
