import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { scuoleDiUtente } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { caricaGiacenze } from '@/lib/merch/giacenze'

// GET  /api/admin/merch/giacenze — matrice giacenze automatiche + storico rettifiche.
// POST /api/admin/merch/giacenze — rettifica di magazzino (carico/reso/scarico/…).
// Service-role + scoping + audit; degrada su DB non migrato.

const SCHEMA_MANCANTE = new Set(['42P01', '42703', 'PGRST204', 'PGRST205'])
const getQuerySchema = z.object({})

const postBodySchema = z.object({
  articolo_id: zUuid,
  taglia: z.string().trim().max(40).default(''),
  quantita_delta: z.coerce.number().int().refine((n) => n !== 0, 'La quantità non può essere zero'),
  motivo: z.enum(['carico', 'reso', 'scarico', 'inventario', 'correzione']).default('carico'),
  nota: z.string().trim().max(300).nullish(),
})

export async function GET(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const plessi = await scuoleDiUtente(supabase, auth.user)
    if (plessi.length === 0) return NextResponse.json({ success: true, data: { matrice: [], storico: [] } })

    const matrice = await caricaGiacenze(supabase, plessi)

    const st = await supabase
      .from('merch_rettifiche')
      .select('id, articolo_id, articolo_nome, taglia, quantita_delta, motivo, nota, creato_il')
      .in('scuola_id', plessi)
      .order('creato_il', { ascending: false })
      .limit(100)
    const storico = st.error ? [] : (st.data ?? [])

    return NextResponse.json({ success: true, data: { matrice, storico } })
  } catch (err) {
    console.error('Errore API GET merch/giacenze:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response

    const supabase = await createAdminClient()
    const plessi = await scuoleDiUtente(supabase, auth.user)
    const { data: art } = await supabase
      .from('divise_articoli')
      .select('id, scuola_id, nome')
      .eq('id', b.data.articolo_id)
      .maybeSingle()
    if (!art) return NextResponse.json({ error: 'Articolo non trovato' }, { status: 404 })
    if (!plessi.includes(art.scuola_id as string)) {
      return NextResponse.json({ error: 'Accesso negato: articolo fuori dal tuo plesso' }, { status: 403 })
    }

    const record = {
      scuola_id: art.scuola_id,
      articolo_id: art.id,
      articolo_nome: art.nome,
      taglia: b.data.taglia,
      quantita_delta: b.data.quantita_delta,
      motivo: b.data.motivo,
      nota: b.data.nota?.trim() || null,
      creato_da: auth.user.id,
    }
    const { data, error } = await supabase.from('merch_rettifiche').insert(record).select('id').single()
    if (error || !data) {
      if (SCHEMA_MANCANTE.has(error?.code ?? '')) {
        return NextResponse.json({ error: 'Magazzino non disponibile su questo ambiente' }, { status: 503 })
      }
      return NextResponse.json({ error: error?.message ?? 'Rettifica fallita' }, { status: 500 })
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'merch_rettifica',
      entitaId: data.id as string,
      azione: 'insert',
      scuolaId: art.scuola_id as string,
      valoreDopo: record,
    })
    return NextResponse.json({ success: true, data }, { status: 201 })
  } catch (err) {
    console.error('Errore API POST merch/giacenze:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
