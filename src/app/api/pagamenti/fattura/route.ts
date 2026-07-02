import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff, requireUser } from '@/lib/auth/require-staff'
import { emettiFatturaPagamento } from '@/lib/aruba/emissione'
import { jsPDF } from 'jspdf'

// POST /api/pagamenti/fattura  (staff) — "Invia Fattura" → emissione REALE Aruba/SDI.
// Body: { userId, pagamento_id, causale? }. Richiede pagamento saldato.
export async function POST(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const body = await request.json()
    const { pagamento_id } = body
    if (!pagamento_id) return NextResponse.json({ error: 'pagamento_id è obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()

    // causale personalizzata dalla Segreteria → persistita prima dell'emissione
    if (typeof body.causale === 'string' && body.causale.trim()) {
      await supabase.from('pagamenti').update({ fattura_causale: body.causale.trim() }).eq('id', pagamento_id)
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
    console.error('Errore API POST fattura:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// GET /api/pagamenti/fattura?pagamento_id=&userId=  — scarica la copia di cortesia.
// Accesso: staff oppure genitore del bambino. Preferisce il PDF reale di Aruba
// (storage `fatture`), con fallback a un'anteprima generata finché lo SDI non
// ha restituito il documento.
export async function GET(request: Request) {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const { user } = auth
    const { searchParams } = new URL(request.url)
    const pagamentoId = searchParams.get('pagamento_id')
    if (!pagamentoId) return NextResponse.json({ error: 'pagamento_id è obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()
    const { data: pag } = await supabase
      .from('pagamenti')
      .select(
        'id, descrizione, fattura_causale, importo, fattura_stato, fattura_aruba_id, fattura_pdf_path, fattura_emessa_il, alunno_id, alunni:alunno_id ( nome, cognome )'
      )
      .eq('id', pagamentoId)
      .single()
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
    const al = pag.alunni as unknown as { nome?: string; cognome?: string }
    const doc = new jsPDF()
    doc.setFontSize(18)
    doc.text('Kidville — Ricevuta / Fattura', 20, 25)
    doc.setFontSize(10)
    doc.setTextColor(150)
    doc.text('Copia di cortesia. La fattura elettronica è stata trasmessa allo SDI tramite Aruba;', 20, 33)
    doc.text('il PDF ufficiale è disponibile appena lo SDI conferma la consegna.', 20, 38)
    doc.setTextColor(0)
    doc.setFontSize(12)
    doc.text(`N. documento: ${pag.fattura_aruba_id ?? '—'}`, 20, 55)
    doc.text(`Data: ${(pag.fattura_emessa_il ?? '').slice(0, 10)}`, 20, 63)
    doc.text(`Intestatario alunno: ${al?.nome ?? ''} ${al?.cognome ?? ''}`, 20, 71)
    doc.text(`Causale: ${pag.fattura_causale ?? pag.descrizione}`, 20, 79)
    doc.setFontSize(14)
    doc.text(`Importo: € ${Number(pag.importo).toFixed(2)}`, 20, 92)

    const pdf = Buffer.from(doc.output('arraybuffer'))
    return new NextResponse(pdf, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="fattura-${pagamentoId.slice(0, 8)}.pdf"`,
      },
    })
  } catch (err) {
    console.error('Errore API GET fattura:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
