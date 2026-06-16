import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'

// Genera pagamenti una tantum per una categoria, su una classe o un elenco di alunni.
// Riusa il filtro alunni di genera-rette e la logica di creazione di pagamenti/rate.

interface RataInput { importo: number; scadenza: string }

// GET /api/pagamenti/genera?userId=&categoria_id=&classe_sezione=&gruppo=  (staff)
//   Preview: alunni candidati (iscritti con sezione), esclusi quelli che hanno
//   già un pagamento con lo stesso `gruppo`.
export async function GET(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const { searchParams } = new URL(request.url)
    const scuolaId = searchParams.get('scuola_id') || auth.user.scuola_id
    const classeSezione = searchParams.get('classe_sezione')
    const gruppo = searchParams.get('gruppo')

    const supabase = await createAdminClient()

    let alQuery = supabase
      .from('alunni')
      .select('id, nome, cognome, classe_sezione, section_id, scuola_id')
      .eq('stato', 'iscritto')
    if (scuolaId) alQuery = alQuery.eq('scuola_id', scuolaId)
    if (classeSezione) alQuery = alQuery.eq('classe_sezione', classeSezione)
    const { data: alunniRaw } = await alQuery
    const alunni = (alunniRaw || []).filter((a) => a.classe_sezione != null || a.section_id != null)

    // esclude chi ha già un pagamento con lo stesso gruppo
    let giaFatti = new Set<string>()
    if (gruppo) {
      const { data: esistenti } = await supabase
        .from('pagamenti').select('alunno_id').eq('gruppo', gruppo)
      giaFatti = new Set((esistenti || []).map((e) => e.alunno_id))
    }
    const candidati = alunni.filter((a) => !giaFatti.has(a.id))

    return NextResponse.json({
      success: true,
      data: { candidati, gia_generati: giaFatti.size },
    })
  } catch (err) {
    console.error('Errore API GET genera:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// POST /api/pagamenti/genera  (staff) — conferma generazione
// Body: { userId, categoria_id?, descrizione, importo, scadenza,
//         alunno_ids?: string[], classe_sezione?, obbligatorio?, gruppo?,
//         rate?: [{importo, scadenza}]  // se presente → piano rateale per alunno }
export async function POST(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth

    const body = await request.json()
    const { descrizione, importo, scadenza, gruppo } = body
    const rate: RataInput[] | undefined = Array.isArray(body.rate) && body.rate.length >= 2 ? body.rate : undefined

    if (!descrizione || (!rate && (importo == null || !scadenza))) {
      return NextResponse.json(
        { error: 'descrizione e (importo + scadenza) oppure rate sono obbligatori' },
        { status: 400 }
      )
    }

    const supabase = await createAdminClient()

    // risolve l'elenco alunni target
    let alunnoIds: string[] = Array.isArray(body.alunno_ids) ? body.alunno_ids : []
    if (alunnoIds.length === 0) {
      const scuolaId = body.scuola_id || user.scuola_id
      let alQuery = supabase.from('alunni').select('id, classe_sezione, section_id').eq('stato', 'iscritto')
      if (scuolaId) alQuery = alQuery.eq('scuola_id', scuolaId)
      if (body.classe_sezione) alQuery = alQuery.eq('classe_sezione', body.classe_sezione)
      const { data: al } = await alQuery
      alunnoIds = (al || []).filter((a) => a.classe_sezione != null || a.section_id != null).map((a) => a.id)
    }
    if (alunnoIds.length === 0) {
      return NextResponse.json({ error: 'Nessun alunno selezionato' }, { status: 400 })
    }

    // esclude i duplicati per gruppo
    if (gruppo) {
      const { data: esistenti } = await supabase.from('pagamenti').select('alunno_id').eq('gruppo', gruppo)
      const giaFatti = new Set((esistenti || []).map((e) => e.alunno_id))
      alunnoIds = alunnoIds.filter((id) => !giaFatti.has(id))
    }
    if (alunnoIds.length === 0) {
      return NextResponse.json({ error: 'Tutti gli alunni hanno già questo pagamento' }, { status: 400 })
    }

    // scuola_id per alunno (per coerenza multi-scuola)
    const { data: alunniInfo } = await supabase.from('alunni').select('id, scuola_id').in('id', alunnoIds)
    const scuolaByAlunno = new Map((alunniInfo || []).map((a) => [a.id, a.scuola_id]))

    const obbligatorio = body.obbligatorio ?? true
    const categoriaId = body.categoria_id ?? null

    let generati = 0

    if (rate) {
      // valida che la somma delle rate coincida col totale
      const somma = rate.reduce((s, r) => s + Number(r.importo), 0)
      const tot = Number(importo ?? somma)
      if (Math.abs(somma - tot) > 0.01) {
        return NextResponse.json({ error: `La somma delle rate (${somma}) deve coincidere col totale (${tot})` }, { status: 400 })
      }
      const ultimaScadenza = rate.map((r) => r.scadenza).sort().slice(-1)[0]

      for (const aId of alunnoIds) {
        const scuolaId = scuolaByAlunno.get(aId)
        const { data: padre, error: pErr } = await supabase.from('pagamenti').insert({
          alunno_id: aId, scuola_id: scuolaId, descrizione, importo: tot, scadenza: ultimaScadenza,
          categoria_id: categoriaId, tipo: 'padre', obbligatorio, gruppo: gruppo ?? null,
          creato_da: user.id, stato: 'da_pagare',
        }).select('id').single()
        if (pErr || !padre) continue
        const figlie = rate.map((r, i) => ({
          alunno_id: aId, scuola_id: scuolaId, descrizione: `${descrizione} — Rata ${i + 1}/${rate.length}`,
          importo: r.importo, scadenza: r.scadenza, categoria_id: categoriaId,
          tipo: 'rata', obbligatorio, parent_payment_id: padre.id, gruppo: gruppo ?? null,
          creato_da: user.id, stato: 'da_pagare',
        }))
        const { error: rErr } = await supabase.from('pagamenti').insert(figlie)
        if (rErr) { await supabase.from('pagamenti').delete().eq('id', padre.id); continue }
        generati += 1
      }
    } else {
      const records = alunnoIds.map((aId) => ({
        alunno_id: aId, scuola_id: scuolaByAlunno.get(aId), descrizione,
        importo, scadenza, categoria_id: categoriaId, tipo: 'singolo',
        obbligatorio, gruppo: gruppo ?? null, creato_da: user.id, stato: 'da_pagare',
      }))
      const { data: created, error } = await supabase.from('pagamenti').insert(records).select('id')
      if (error) {
        console.error('Errore POST genera:', error)
        return NextResponse.json({ error: 'Errore nella generazione', details: error.message }, { status: 500 })
      }
      generati = created?.length ?? 0
    }

    await supabase.from('registro_modifiche').insert({
      azione: 'genera_pagamenti_categoria',
      tabella_interessata: 'pagamenti',
      record_id: null,
      nuovo_valore: { categoria_id: categoriaId, descrizione, gruppo, generati, rate: !!rate },
      utente_id: user.id,
    }).then(() => {}, () => {})

    return NextResponse.json({ success: true, data: { generati } }, { status: 201 })
  } catch (err) {
    console.error('Errore API POST genera:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
