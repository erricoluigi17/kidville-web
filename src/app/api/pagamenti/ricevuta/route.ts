import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { jsPDF } from 'jspdf'

// GET /api/pagamenti/ricevuta?pagamento_id=&userId=  — ricevuta NON fiscale (DL-023).
// Documento di cortesia per un pagamento SALDATO, indipendente dalla fattura
// elettronica Aruba. Accesso: staff oppure genitore del bambino.
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
      .select('id, descrizione, importo, importo_pagato, stato, scadenza, alunno_id, alunni:alunno_id ( nome, cognome )')
      .eq('id', pagamentoId)
      .maybeSingle()
    if (!pag) return NextResponse.json({ error: 'Pagamento non trovato' }, { status: 404 })

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

    if (pag.stato !== 'pagato') {
      return NextResponse.json({ error: 'Ricevuta disponibile solo per pagamenti saldati' }, { status: 409 })
    }

    const al = pag.alunni as unknown as { nome?: string; cognome?: string }
    const doc = new jsPDF()
    doc.setFontSize(18)
    doc.text('Kidville — Ricevuta di pagamento', 20, 25)
    doc.setFontSize(9)
    doc.setTextColor(150)
    doc.text('Documento di cortesia non fiscale. Per la fattura elettronica usare l’apposita funzione.', 20, 32)
    doc.setTextColor(0)
    doc.setFontSize(12)
    doc.text(`Causale: ${pag.descrizione ?? '—'}`, 20, 50)
    doc.text(`Intestatario: ${al?.nome ?? ''} ${al?.cognome ?? ''}`, 20, 58)
    doc.text(`Scadenza: ${pag.scadenza ?? '—'}`, 20, 66)
    doc.setFontSize(14)
    doc.text(`Importo saldato: € ${Number(pag.importo_pagato ?? pag.importo).toFixed(2)}`, 20, 80)
    doc.setFontSize(10)
    doc.setTextColor(120)
    doc.text('Stato: Pagato', 20, 90)

    const pdf = Buffer.from(doc.output('arraybuffer'))
    return new NextResponse(pdf, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="ricevuta-${pagamentoId.slice(0, 8)}.pdf"`,
      },
    })
  } catch (err) {
    console.error('Errore API GET ricevuta:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
