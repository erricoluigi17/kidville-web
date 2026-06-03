import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff, requireUser } from '@/lib/auth/require-staff'
import { emettiFattura, type ArubaConfig } from '@/lib/aruba/client'
import { jsPDF } from 'jspdf'

const DEFAULT_SCUOLA = '11111111-1111-1111-1111-111111111111'

// POST /api/pagamenti/fattura  (staff) — "Invia Fattura" (STUB Aruba)
// Body: { userId, pagamento_id }. Richiede pagamento saldato.
export async function POST(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const body = await request.json()
    const { pagamento_id } = body
    if (!pagamento_id) return NextResponse.json({ error: 'pagamento_id è obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()
    const { data: pag } = await supabase
      .from('pagamenti')
      .select('id, descrizione, importo, importo_pagato, stato, scuola_id, alunni:alunno_id ( intestatario_fatture )')
      .eq('id', pagamento_id).single()
    if (!pag) return NextResponse.json({ error: 'Pagamento non trovato' }, { status: 404 })
    if (pag.stato !== 'pagato') {
      return NextResponse.json({ error: 'La fattura può essere emessa solo per pagamenti saldati' }, { status: 400 })
    }

    // config Aruba della scuola
    const { data: settings } = await supabase
      .from('admin_settings').select('aruba_config').eq('scuola_id', pag.scuola_id ?? DEFAULT_SCUOLA).maybeSingle()
    const cfg = (settings?.aruba_config ?? {}) as ArubaConfig

    // stato in_attesa
    await supabase.from('pagamenti').update({ fattura_stato: 'in_attesa' }).eq('id', pagamento_id)

    const intestatario = (pag.alunni as unknown as { intestatario_fatture?: unknown })?.intestatario_fatture ?? null
    const res = await emettiFattura(
      { pagamento_id, descrizione: pag.descrizione, importo: Number(pag.importo), intestatario: intestatario as never },
      cfg
    )

    if (!res.ok) {
      await supabase.from('pagamenti').update({ fattura_stato: 'scartata' }).eq('id', pagamento_id)
      return NextResponse.json({ error: res.errore || 'Emissione scartata', data: { fattura_stato: 'scartata' } }, { status: 502 })
    }

    await supabase.from('pagamenti').update({
      fattura_stato: 'emessa',
      fattura_aruba_id: res.fattura_id,
      fattura_pdf_path: res.pdf_path,
      fattura_emessa_il: new Date().toISOString(),
    }).eq('id', pagamento_id)

    return NextResponse.json({ success: true, data: { fattura_stato: 'emessa', fattura_id: res.fattura_id } })
  } catch (err) {
    console.error('Errore API POST fattura:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// GET /api/pagamenti/fattura?pagamento_id=&userId=  — scarica la fattura (PDF scaffold)
// Accesso: staff oppure genitore del bambino. Solo se fattura_stato='emessa'.
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
      .select('id, descrizione, importo, fattura_stato, fattura_aruba_id, fattura_emessa_il, alunno_id, alunni:alunno_id ( nome, cognome )')
      .eq('id', pagamentoId).single()
    if (!pag) return NextResponse.json({ error: 'Pagamento non trovato' }, { status: 404 })

    // scoping genitore
    const isStaff = user.role === 'admin' || user.role === 'coordinator'
    if (!isStaff) {
      const { data: legame } = await supabase
        .from('legame_genitori_alunni').select('alunno_id')
        .eq('genitore_id', user.id).eq('alunno_id', pag.alunno_id).maybeSingle()
      if (!legame) return NextResponse.json({ error: 'Accesso negato' }, { status: 403 })
    }
    if (pag.fattura_stato !== 'emessa') {
      return NextResponse.json({ error: 'Fattura non disponibile' }, { status: 409 })
    }

    // SCAFFOLD: genera un PDF "anteprima fattura" al volo (in produzione: PDF reale Aruba)
    const al = pag.alunni as unknown as { nome?: string; cognome?: string }
    const doc = new jsPDF()
    doc.setFontSize(18); doc.text('Kidville — Ricevuta / Fattura', 20, 25)
    doc.setFontSize(10); doc.setTextColor(150)
    doc.text('Documento di anteprima (scaffold). La fattura elettronica reale sarà', 20, 33)
    doc.text('emessa via Aruba (SDI) in produzione.', 20, 38)
    doc.setTextColor(0); doc.setFontSize(12)
    doc.text(`N. documento: ${pag.fattura_aruba_id ?? '—'}`, 20, 55)
    doc.text(`Data: ${(pag.fattura_emessa_il ?? '').slice(0, 10)}`, 20, 63)
    doc.text(`Intestatario alunno: ${al?.nome ?? ''} ${al?.cognome ?? ''}`, 20, 71)
    doc.text(`Descrizione: ${pag.descrizione}`, 20, 79)
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
