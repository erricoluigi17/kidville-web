import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { resolveScuolaScrittura, resolveScuoleAttive } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import {
  hashMovimento,
  parseCsv,
  suggerisciMatch,
  type PagamentoAperto,
} from '@/lib/pagamenti/riconciliazione'

const zUuidQueryOpzionale = z.preprocess((v) => (v === '' ? undefined : v), zUuid.optional())

const getQuerySchema = z.object({
  stato: z.enum(['da_abbinare', 'suggerito', 'confermato', 'ignorato']).or(z.literal('')).optional(),
  import_id: zUuidQueryOpzionale,
})

const postBodySchema = z.object({
  filename: z.string().max(200).optional(),
  // contenuto CSV in chiaro: PII bancarie → si persistono SOLO i movimenti normalizzati
  contenuto: z.string().min(1).max(2_000_000),
  mapping: z
    .object({
      data: z.string().max(80).optional(),
      importo: z.string().max(80).optional(),
      causale: z.string().max(80).optional(),
      controparte: z.string().max(80).optional(),
    })
    .optional(),
  scuola_id: zUuid.nullish(),
})

const SCHEMA_MANCANTE = new Set(['42P01', '42703', 'PGRST204', 'PGRST205'])

// GET /api/pagamenti/riconciliazione?stato=&import_id= — coda movimenti (staff).
export async function GET(request: NextRequest) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const sediAttive = await resolveScuoleAttive(request, supabase, auth.user)

    let query = supabase
      .from('riconciliazione_movimenti')
      .select('id, import_id, data_operazione, importo, causale, controparte, stato, suggerimenti, pagamento_id, confermato_il')
      .in('scuola_id', sediAttive)
      .order('data_operazione', { ascending: false })
      .limit(500)
    if (q.data.stato) query = query.eq('stato', q.data.stato)
    if (q.data.import_id) query = query.eq('import_id', q.data.import_id)

    const { data, error } = await query
    if (error) {
      if (SCHEMA_MANCANTE.has(error.code ?? '')) return NextResponse.json({ success: true, data: [], disponibile: false })
      return NextResponse.json({ error: 'Errore nel recupero dei movimenti' }, { status: 500 })
    }
    return NextResponse.json({ success: true, data: data || [] })
  } catch (err) {
    console.error('Errore API GET riconciliazione:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

// POST /api/pagamenti/riconciliazione — import CSV estratto conto (staff).
// Parse + hash anti re-import + suggerimenti calcolati SUBITO sui pagamenti
// aperti della sede. Nessuna conferma automatica.
export async function POST(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const body = b.data

    const supabase = await createAdminClient()
    const sw = await resolveScuolaScrittura(request as NextRequest, supabase, auth.user, body.scuola_id ?? undefined)
    if (sw.response) return sw.response
    const scuolaId = sw.scuolaId as string

    const { movimenti, scartate } = parseCsv(body.contenuto, body.mapping)
    if (movimenti.length === 0) {
      return NextResponse.json(
        { error: 'Nessun accredito riconosciuto nel file: controlla intestazioni/mapping o il separatore' },
        { status: 400 },
      )
    }

    // dedup nel file + contro il registro esistente
    const visti = new Set<string>()
    const conHash = movimenti
      .map((m) => ({ m, hash: hashMovimento(m) }))
      .filter(({ hash }) => (visti.has(hash) ? false : (visti.add(hash), true)))

    const { data: giaRows, error: errEsistenti } = await supabase
      .from('riconciliazione_movimenti')
      .select('hash_movimento')
      .eq('scuola_id', scuolaId)
      .in('hash_movimento', conHash.map((x) => x.hash))
    if (errEsistenti) {
      if (SCHEMA_MANCANTE.has(errEsistenti.code ?? '')) {
        return NextResponse.json({ error: 'Riconciliazione non ancora disponibile.' }, { status: 503 })
      }
      return NextResponse.json({ error: 'Errore nel controllo duplicati' }, { status: 500 })
    }
    const gia = new Set(((giaRows || []) as { hash_movimento: string }[]).map((r) => r.hash_movimento))
    const nuovi = conHash.filter(({ hash }) => !gia.has(hash))

    // pagamenti aperti della sede per i suggerimenti
    const { data: apertiRaw } = await supabase
      .from('pagamenti')
      .select('id, descrizione, importo, importo_pagato, periodo_competenza, tipo, stato, alunni:alunno_id ( nome, cognome )')
      .eq('scuola_id', scuolaId)
      .in('stato', ['da_pagare', 'parziale', 'scaduto'])
    const aperti: PagamentoAperto[] = ((apertiRaw || []) as unknown as {
      id: string; descrizione?: string | null; importo: number; importo_pagato?: number | null
      periodo_competenza?: string | null; tipo: string; alunni?: { nome?: string; cognome?: string } | null
    }[])
      .filter((p) => p.tipo !== 'padre')
      .map((p) => ({
        id: p.id,
        descrizione: p.descrizione,
        importo: p.importo,
        importo_pagato: p.importo_pagato,
        periodo_competenza: p.periodo_competenza,
        alunno_nome: [p.alunni?.nome, p.alunni?.cognome].filter(Boolean).join(' ') || null,
      }))
    const labels = new Map(
      aperti.map((p) => [
        p.id,
        `${p.alunno_nome ?? '—'} · ${p.descrizione ?? '—'} (residuo € ${(Number(p.importo) - Number(p.importo_pagato || 0)).toFixed(2)})`,
      ]),
    )

    const { data: imp, error: errImp } = await supabase
      .from('riconciliazione_import')
      .insert({ scuola_id: scuolaId, filename: body.filename ?? null, righe_totali: nuovi.length, caricato_da: auth.user.id })
      .select()
      .single()
    if (errImp || !imp) {
      return NextResponse.json({ error: "Errore nella creazione dell'import" }, { status: 500 })
    }

    let suggeriti = 0
    const righe = nuovi.map(({ m, hash }) => {
      const s = suggerisciMatch(m, aperti)
      if (s.stato === 'suggerito') suggeriti++
      return {
        import_id: (imp as { id: string }).id,
        scuola_id: scuolaId,
        data_operazione: m.data_operazione,
        importo: m.importo,
        causale: m.causale || null,
        controparte: m.controparte || null,
        hash_movimento: hash,
        stato: s.stato,
        suggerimenti: s.suggerimenti.map((x) => ({ ...x, label: labels.get(x.pagamento_id) ?? null })),
      }
    })
    if (righe.length > 0) {
      const { error: errIns } = await supabase.from('riconciliazione_movimenti').insert(righe)
      if (errIns) return NextResponse.json({ error: 'Errore nel salvataggio dei movimenti' }, { status: 500 })
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'riconciliazione_import',
      entitaId: (imp as { id: string }).id,
      azione: 'insert',
      scuolaId,
      valoreDopo: { filename: body.filename ?? null, nuovi: righe.length, duplicati: conHash.length - nuovi.length },
    })

    return NextResponse.json({
      success: true,
      data: {
        import_id: (imp as { id: string }).id,
        nuovi: righe.length,
        duplicati: conHash.length - nuovi.length,
        scartate,
        suggeriti,
        da_abbinare: righe.length - suggeriti,
      },
    })
  } catch (err) {
    console.error('Errore API POST riconciliazione:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
