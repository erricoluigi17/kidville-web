import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff, requireUser } from '@/lib/auth/require-staff'
import { emettiFatturaPagamento } from '@/lib/aruba/emissione'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { jsPDF } from 'jspdf'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// causale: il comportamento pre-esistente accetta qualsiasi tipo e la usa solo
// se è una stringa non vuota → unknown().optional(), il typeof resta nell'handler.
const postBodySchema = z.object({
  pagamento_id: zUuid,
  causale: z.unknown().optional(),
})

const getQuerySchema = z.object({
  pagamento_id: zUuid,
  // opzionale: scarica il PDF di UNA specifica fattura (quota) del pagamento.
  fattura_id: zUuid.optional(),
})

// PDF anteprima "copia di cortesia" generato al volo (in attesa del PDF SDI).
async function anteprimaPdf(opts: {
  pagamentoId: string
  numeroDoc: string
  data: string
  intestatario: string
  causale: string
  importo: number
}): Promise<NextResponse> {
  const doc = new jsPDF()
  doc.setFontSize(18)
  doc.text('Kidville — Ricevuta / Fattura', 20, 25)
  doc.setFontSize(10)
  doc.setTextColor(150)
  doc.text('Copia di cortesia. La fattura elettronica è stata trasmessa allo SDI tramite Aruba;', 20, 33)
  doc.text('il PDF ufficiale è disponibile appena lo SDI conferma la consegna.', 20, 38)
  doc.setTextColor(0)
  doc.setFontSize(12)
  doc.text(`N. documento: ${opts.numeroDoc || '—'}`, 20, 55)
  doc.text(`Data: ${(opts.data ?? '').slice(0, 10)}`, 20, 63)
  doc.text(`Intestatario: ${opts.intestatario}`, 20, 71)
  doc.text(`Causale: ${opts.causale}`, 20, 79)
  doc.setFontSize(14)
  doc.text(`Importo: € ${Number(opts.importo).toFixed(2)}`, 20, 92)
  const pdf = Buffer.from(doc.output('arraybuffer'))
  return new NextResponse(pdf, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="fattura-${opts.pagamentoId.slice(0, 8)}.pdf"`,
    },
  })
}

// POST /api/pagamenti/fattura  (staff) — "Invia Fattura" → emissione REALE Aruba/SDI.
// Body: { userId, pagamento_id, causale? }. Richiede pagamento saldato.
export const POST = withRoute('pagamenti/fattura:POST', async (request: Request) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { pagamento_id, causale } = b.data

    const supabase = await createAdminClient()

    // causale personalizzata dalla Segreteria → persistita prima dell'emissione
    if (typeof causale === 'string' && causale.trim()) {
      await supabase.from('pagamenti').update({ fattura_causale: causale.trim() }).eq('id', pagamento_id)
    }

    const esito = await emettiFatturaPagamento(supabase, pagamento_id, { id: auth.user.id })
    if (!esito.ok) {
      return NextResponse.json(
        { error: esito.messaggio, data: { motivo: esito.motivo } },
        { status: esito.httpStatus }
      )
    }
    return NextResponse.json({
      success: true,
      data: { fattura_stato: esito.fatturaStato, numero: esito.numero, fattura_id: esito.uploadFileName },
    })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/fattura:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// GET /api/pagamenti/fattura?pagamento_id=&userId=  — scarica la copia di cortesia.
// Accesso: staff oppure genitore del bambino. Preferisce il PDF reale di Aruba
// (storage `fatture`), con fallback a un'anteprima generata finché lo SDI non
// ha restituito il documento.
export const GET = withRoute('pagamenti/fattura:GET', async (request: Request) => {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const { user } = auth
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { pagamento_id: pagamentoId, fattura_id: fatturaId } = q.data

    const supabase = await createAdminClient()
    const { data: pag } = await supabase
      .from('pagamenti')
      .select(
        'id, descrizione, fattura_causale, importo, fattura_stato, fattura_aruba_id, fattura_pdf_path, fattura_emessa_il, alunno_id, alunni:alunno_id ( nome, cognome )'
      )
      .eq('id', pagamentoId)
      .maybeSingle()
    if (!pag) return NextResponse.json({ error: 'Pagamento non trovato' }, { status: 404 })

    // scoping genitore
    const isStaff = user.role === 'admin' || user.role === 'coordinator' || user.role === 'segreteria'
    if (!isStaff) {
      const { data: legame } = await supabase
        .from('legame_genitori_alunni')
        .select('alunno_id')
        .eq('genitore_id', user.id)
        .eq('alunno_id', pag.alunno_id)
        .maybeSingle()
      if (!legame) return NextResponse.json({ error: 'Accesso negato' }, { status: 403 })
    }
    const al = pag.alunni as unknown as { nome?: string; cognome?: string }
    const alunnoNome = `${al?.nome ?? ''} ${al?.cognome ?? ''}`.trim()

    // Percorso PER-FATTURA (multi-quota): serve il PDF della singola riga.
    if (fatturaId) {
      const { data: fatt } = await supabase
        .from('fatture_emesse')
        .select('id, numero, causale, importo, intestatario, pdf_path, inviata_il')
        .eq('id', fatturaId)
        .eq('pagamento_id', pagamentoId)
        .maybeSingle()
      if (!fatt) return NextResponse.json({ error: 'Fattura non trovata' }, { status: 404 })
      if (fatt.pdf_path) {
        try {
          const { data: file } = await supabase.storage.from('fatture').download(fatt.pdf_path)
          if (file) {
            const buf = Buffer.from(await file.arrayBuffer())
            return new NextResponse(buf, {
              status: 200,
              headers: {
                'Content-Type': 'application/pdf',
                'Content-Disposition': `inline; filename="fattura-${pagamentoId.slice(0, 8)}-${fatt.numero}.pdf"`,
              },
            })
          }
        } catch (e) {
          console.warn('PDF Aruba non recuperabile, uso anteprima:', e)
        }
      }
      const intest = (fatt.intestatario ?? {}) as { nome?: string; cognome?: string }
      const nomeInt = `${intest.nome ?? ''} ${intest.cognome ?? ''}`.trim() || alunnoNome
      return anteprimaPdf({
        pagamentoId,
        numeroDoc: String(fatt.numero ?? '—'),
        data: fatt.inviata_il ?? '',
        intestatario: nomeInt,
        causale: String(fatt.causale ?? pag.descrizione),
        importo: Number(fatt.importo ?? pag.importo),
      })
    }

    // Percorso legacy (senza param): comportamento odierno (fattura singola).
    if (pag.fattura_stato !== 'emessa') {
      return NextResponse.json({ error: 'Fattura non ancora disponibile' }, { status: 409 })
    }

    // PDF reale di Aruba (copia di cortesia) se già recuperato dallo SDI
    if (pag.fattura_pdf_path) {
      try {
        const { data: file } = await supabase.storage.from('fatture').download(pag.fattura_pdf_path)
        if (file) {
          const buf = Buffer.from(await file.arrayBuffer())
          return new NextResponse(buf, {
            status: 200,
            headers: {
              'Content-Type': 'application/pdf',
              'Content-Disposition': `inline; filename="fattura-${pagamentoId.slice(0, 8)}.pdf"`,
            },
          })
        }
      } catch (e) {
        console.warn('PDF Aruba non recuperabile, uso anteprima:', e)
      }
    }

    // Fallback: anteprima generata (in attesa del PDF SDI)
    return anteprimaPdf({
      pagamentoId,
      numeroDoc: pag.fattura_aruba_id ?? '—',
      data: pag.fattura_emessa_il ?? '',
      intestatario: `Alunno: ${alunnoNome}`,
      causale: String(pag.fattura_causale ?? pag.descrizione),
      importo: Number(pag.importo),
    })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/fattura:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
