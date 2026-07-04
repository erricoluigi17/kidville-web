import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { assertAlunnoInScope } from '@/lib/auth/scope'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const postBodySchema = z.object({
  alunno_id: zUuid,
  descrizione: z.string().min(1, 'alunno_id, descrizione e almeno 2 rate sono obbligatori'),
  // numero o stringa numerica; assente/null → somma delle rate (calcolata sotto)
  importo_totale: z.union([z.number(), z.string()]).nullish(),
  rate: z
    .array(
      z.object({
        importo: z.union([z.number(), z.string()], { error: 'Ogni rata richiede importo e scadenza' }),
        scadenza: z.string().min(1, 'Ogni rata richiede importo e scadenza'),
      }),
      { error: 'alunno_id, descrizione e almeno 2 rate sono obbligatori' }
    )
    .min(2, 'alunno_id, descrizione e almeno 2 rate sono obbligatori'),
  categoria_id: zUuid.nullish(),
  obbligatorio: z.boolean().nullish(), // default true applicato nel codice
  scuola_id: z.string().nullish(), // assente/vuota → derivata dall'alunno (come oggi)
})

// POST /api/pagamenti/rate  (staff) — crea un piano rateale: 1 padre + N rate
// Body: { userId, alunno_id, descrizione, importo_totale, rate: [{importo, scadenza}],
//         categoria_id?, obbligatorio?, scuola_id? }
export async function POST(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const body = b.data
    const { alunno_id, descrizione, importo_totale, rate } = body
    const somma = rate.reduce((s, r) => s + Number(r.importo), 0)
    const tot = Number(importo_totale ?? somma)
    if (Math.abs(somma - tot) > 0.01) {
      return NextResponse.json({ error: `La somma delle rate (${somma}) deve coincidere col totale (${tot})` }, { status: 400 })
    }

    const supabase = await createAdminClient()

    // Scope: l'alunno deve appartenere ai plessi dell'utente (403/404 se fuori scope)
    const scopeRes = await assertAlunnoInScope(supabase, user, alunno_id)
    if (scopeRes) return scopeRes

    // La sede è SEMPRE derivata dall'alunno: MAI fidarsi dello scuola_id del client
    const { data: al } = await supabase.from('alunni').select('scuola_id').eq('id', alunno_id).maybeSingle()
    if (!al) return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 })
    const scuolaId = al.scuola_id

    const scadenze = rate.map((r) => r.scadenza).sort()
    const ultimaScadenza = scadenze[scadenze.length - 1]

    // padre
    const { data: padre, error: pErr } = await supabase.from('pagamenti').insert({
      alunno_id, scuola_id: scuolaId, descrizione, importo: tot, scadenza: ultimaScadenza,
      categoria_id: body.categoria_id ?? null, tipo: 'padre', obbligatorio: body.obbligatorio ?? true,
      creato_da: user.id, stato: 'da_pagare',
    }).select().single()
    if (pErr || !padre) {
      return NextResponse.json({ error: 'Errore creazione piano', details: pErr?.message }, { status: 500 })
    }

    // rate figlie
    const figlie = rate.map((r, i) => ({
      alunno_id, scuola_id: scuolaId, descrizione: `${descrizione} — Rata ${i + 1}/${rate.length}`,
      importo: r.importo, scadenza: r.scadenza, categoria_id: body.categoria_id ?? null,
      tipo: 'rata', obbligatorio: body.obbligatorio ?? true, parent_payment_id: padre.id,
      creato_da: user.id, stato: 'da_pagare',
    }))
    const { data: created, error: rErr } = await supabase.from('pagamenti').insert(figlie).select()
    if (rErr) {
      await supabase.from('pagamenti').delete().eq('id', padre.id) // rollback padre
      return NextResponse.json({ error: 'Errore creazione rate', details: rErr.message }, { status: 500 })
    }

    return NextResponse.json({ success: true, data: { padre, rate: created } }, { status: 201 })
  } catch (err) {
    console.error('Errore API POST rate:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
