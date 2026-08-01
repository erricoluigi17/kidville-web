import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { assertPagamentoInScope } from '@/lib/auth/scope'
import { genitoreHasFiglio } from '@/lib/anagrafiche/legami'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { emettiORecuperaRicevuta, type PagamentoPerRicevuta } from '@/lib/pagamenti/ricevute'
import { buildRicevutaPdf } from '@/lib/pagamenti/pdf'
import { datiStruttura, isTracciabile } from '@/lib/pagamenti/fiscale'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'
import { formattaIstante } from '@/i18n/config'

const getQuerySchema = z.object({
  pagamento_id: zUuid,
})

const periodoIt = (p?: string | null) =>
  p ? formattaIstante(new Date(p), 'it', { month: 'long', year: 'numeric' }) : null

// GET /api/pagamenti/ricevuta?pagamento_id=&userId= — ricevuta NUMERATA (A5).
// Emissione idempotente al primo download (registro `ricevute_emesse`, una
// sola ricevuta attiva per pagamento): admin e genitore scaricano la STESSA
// ricevuta n. X/AAAA, con annotazione dei metodi (prova di tracciabilità per
// la detrazione) e dati struttura (utile per il Bonus Nido INPS). Dove il
// registro non esiste (DB e2e CI) degrada al PDF di cortesia senza numero.
// Accesso: staff oppure genitore del bambino. Solo pagamenti SALDATI.
export const GET = withRoute('pagamenti/ricevuta:GET', async (request: Request) => {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const { user } = auth
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { pagamento_id: pagamentoId } = q.data

    const supabase = await createAdminClient()

    // Isolamento per sede: il gate di ruolo non bastava — si operava sulle rette
    // di un'altra sede conoscendo l'uuid del pagamento. `pagamenti` ha gia'
    // `scuola_id`, che per la contabilita' e' il dato che conta.
    const fuoriScopePag = await assertPagamentoInScope(supabase, auth.user, pagamentoId)
    if (fuoriScopePag) return fuoriScopePag
    const { data: pag } = await supabase
      .from('pagamenti')
      .select('id, descrizione, importo, importo_pagato, stato, scadenza, periodo_competenza, alunno_id, scuola_id, alunni:alunno_id ( nome, cognome )')
      .eq('id', pagamentoId)
      .maybeSingle()
    if (!pag) return NextResponse.json({ error: 'Pagamento non trovato' }, { status: 404 })

    const isStaff = user.role === 'admin' || user.role === 'coordinator' || user.role === 'segreteria'
    if (!isStaff) {
      // Unione runtime + anagrafica: la ricevuta serve al genitore per la
      // detrazione fiscale, e col solo legame runtime restava irraggiungibile.
      const ok = await genitoreHasFiglio(supabase, user.id, pag.alunno_id)
      if (!ok) return NextResponse.json({ error: 'Accesso negato' }, { status: 403 })
    }

    if (pag.stato !== 'pagato') {
      return NextResponse.json({ error: 'Ricevuta disponibile solo per pagamenti saldati' }, { status: 409 })
    }

    const esito = await emettiORecuperaRicevuta(supabase, pag as unknown as PagamentoPerRicevuta, { creatoDa: user.id })
    if (!esito.ok) {
      return NextResponse.json({ error: 'Errore nell’emissione della ricevuta', details: esito.messaggio }, { status: 500 })
    }
    const record = esito.legacy ? null : esito.record

    const { data: incassi } = await supabase
      .from('incassi')
      .select('importo, data_incasso, metodo')
      .eq('pagamento_id', pagamentoId)
      .order('creato_il', { ascending: true })

    const al = pag.alunni as unknown as { nome?: string; cognome?: string }
    const positivi = (incassi || []).filter((i) => Number(i.importo) > 0)
    const pdf = buildRicevutaPdf({
      numero: record?.numero ?? null,
      anno: record?.anno ?? null,
      struttura:
        record?.dati_struttura ??
        datiStruttura(null, null, {
          operazione: 'pagamenti/ricevuta:GET',
          scuolaId: pag.scuola_id as string,
        }),
      intestatario: record?.intestatario ?? null,
      alunno: `${al?.nome ?? ''} ${al?.cognome ?? ''}`.trim(),
      descrizione: pag.descrizione ?? '—',
      periodo: periodoIt(record?.periodo_competenza ?? pag.periodo_competenza),
      importo: record ? Number(record.importo) : Number(pag.importo_pagato ?? pag.importo),
      incassi: incassi || [],
      tracciabile: record?.tracciabile ?? isTracciabile(positivi.map((i) => i.metodo as string | null)),
      bollo: record?.bollo ?? false,
      dicituraBollo: record?.dati_struttura?.dicitura_bollo,
      emessaIl: record ? formattaIstante(new Date(record.creato_il), 'it') : undefined,
    })

    const filename = record ? `ricevuta-${record.numero}-${record.anno}.pdf` : `ricevuta-${pagamentoId.slice(0, 8)}.pdf`
    return new NextResponse(pdf, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${filename}"`,
      },
    })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/ricevuta:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
