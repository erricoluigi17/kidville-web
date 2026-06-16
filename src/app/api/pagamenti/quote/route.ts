import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'

// POST/PATCH /api/pagamenti/quote  (staff) — crea/aggiorna le quote split
// Body: { userId, pagamento_id, quote: [{adult_id, importo, etichetta?}] }
// Valida che la somma delle quote == importo del pagamento. Imposta tipo='split'.
async function upsertQuote(request: Request) {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response

  const body = await request.json()
  const { pagamento_id, quote } = body
  if (!pagamento_id || !Array.isArray(quote) || quote.length < 2) {
    return NextResponse.json({ error: 'pagamento_id e almeno 2 quote sono obbligatori' }, { status: 400 })
  }
  for (const q of quote) {
    if (!q.adult_id || q.importo == null) {
      return NextResponse.json({ error: 'Ogni quota richiede adult_id e importo' }, { status: 400 })
    }
  }

  const supabase = await createAdminClient()
  const { data: pag, error: pErr } = await supabase
    .from('pagamenti').select('id, importo, tipo').eq('id', pagamento_id).single()
  if (pErr || !pag) return NextResponse.json({ error: 'Pagamento non trovato' }, { status: 404 })

  const somma = quote.reduce((s: number, q: { importo: number }) => s + Number(q.importo), 0)
  if (Math.abs(somma - Number(pag.importo)) > 0.01) {
    return NextResponse.json(
      { error: `La somma delle quote (${somma}) deve coincidere con l'importo (${pag.importo})` },
      { status: 400 }
    )
  }

  // sostituisce le quote esistenti
  await supabase.from('pagamenti_quote').delete().eq('pagamento_id', pagamento_id)
  const rows = quote.map((q: { adult_id: string; importo: number; etichetta?: string }) => ({
    pagamento_id, adult_id: q.adult_id, importo: q.importo, etichetta: q.etichetta ?? null,
  }))
  const { data: created, error: qErr } = await supabase.from('pagamenti_quote').insert(rows).select()
  if (qErr) return NextResponse.json({ error: qErr.message }, { status: 500 })

  if (pag.tipo !== 'split') {
    await supabase.from('pagamenti').update({ tipo: 'split' }).eq('id', pagamento_id)
  }

  return NextResponse.json({ success: true, data: created }, { status: 200 })
}

export async function POST(request: Request) {
  try { return await upsertQuote(request) } catch (err) {
    console.error('Errore API POST quote:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
export async function PATCH(request: Request) {
  try { return await upsertQuote(request) } catch (err) {
    console.error('Errore API PATCH quote:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// GET /api/pagamenti/quote?pagamento_id=&userId=  (staff) — quote di un pagamento
export async function GET(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { searchParams } = new URL(request.url)
    const pagamentoId = searchParams.get('pagamento_id')
    if (!pagamentoId) return NextResponse.json({ error: 'pagamento_id è obbligatorio' }, { status: 400 })

    const supabase = await createAdminClient()
    const { data, error } = await supabase
      .from('pagamenti_quote')
      .select('id, pagamento_id, adult_id, importo, etichetta, utenti:adult_id ( id, nome, cognome )')
      .eq('pagamento_id', pagamentoId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data })
  } catch (err) {
    console.error('Errore API GET quote:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
