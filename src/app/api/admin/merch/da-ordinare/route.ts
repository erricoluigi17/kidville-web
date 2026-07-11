import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { scuoleDiUtente } from '@/lib/auth/scope'
import { parseQuery } from '@/lib/validation/http'

const getQuerySchema = z.object({}) // nessun parametro: aggrega tutto il "da ordinare" dei plessi

// GET /api/admin/merch/da-ordinare — righe stato='da_ordinare'/origine='fornitore'
// aggregate PER FORNITORE (matrice articolo×taglia×qty + righe_ids), pronte per
// generare un ordine d'acquisto. Bucket "Senza fornitore" per gli articoli senza
// fornitore associato. Degrada a lista vuota dove il DB non è migrato.

const SCHEMA_MANCANTE = new Set(['42P01', '42703', 'PGRST200', 'PGRST204', 'PGRST205'])

type Riga = {
  id: string
  articolo_id: string | null
  articolo_nome: string
  taglia: string | null
  quantita: number
  ordine: { scuola_id?: string | null } | { scuola_id?: string | null }[] | null
  articolo: { fornitore_id?: string | null } | { fornitore_id?: string | null }[] | null
}

const uno = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null))

interface TagliaAgg { taglia: string; quantita: number; righe_ids: string[] }
interface ArticoloAgg { articolo_id: string | null; nome: string; taglie: TagliaAgg[]; quantita: number }
interface GruppoAgg { fornitore: { id: string; nome: string } | null; quantita: number; articoli: ArticoloAgg[] }

export async function GET(request: Request) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const plessi = await scuoleDiUtente(supabase, auth.user)
    if (plessi.length === 0) return NextResponse.json({ success: true, data: { gruppi: [] } })

    const { data, error } = await supabase
      .from('divise_ordini_righe')
      .select('id, articolo_id, articolo_nome, taglia, quantita, ordine:ordine_id!inner ( scuola_id ), articolo:articolo_id ( fornitore_id )')
      .eq('stato', 'da_ordinare')
      .eq('origine', 'fornitore')
      .in('ordine.scuola_id', plessi)
      .order('id', { ascending: true })
      .limit(20000)
    if (error) {
      if (SCHEMA_MANCANTE.has(error.code ?? '')) return NextResponse.json({ success: true, data: { gruppi: [] } })
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const righe = ((data as unknown as Riga[]) ?? []).filter((r) => {
      const sc = uno(r.ordine)?.scuola_id
      return sc != null && plessi.includes(sc)
    })

    // fornitori presenti → nome
    const fornitoreIds = [...new Set(righe.map((r) => uno(r.articolo)?.fornitore_id).filter(Boolean) as string[])]
    const nomiFornitore = new Map<string, string>()
    if (fornitoreIds.length > 0) {
      const { data: forn } = await supabase.from('merch_fornitori').select('id, nome').in('id', fornitoreIds)
      for (const f of forn ?? []) nomiFornitore.set(f.id as string, f.nome as string)
    }

    // aggregazione: gruppo (fornitore) → articolo → taglia
    const gruppi = new Map<string, GruppoAgg>()
    for (const r of righe) {
      const fid = uno(r.articolo)?.fornitore_id ?? null
      const gkey = fid ?? '__none__'
      let g = gruppi.get(gkey)
      if (!g) {
        g = { fornitore: fid ? { id: fid, nome: nomiFornitore.get(fid) ?? 'Fornitore' } : null, quantita: 0, articoli: [] }
        gruppi.set(gkey, g)
      }
      const akey = r.articolo_id ?? r.articolo_nome
      let a = g.articoli.find((x) => (x.articolo_id ?? x.nome) === akey)
      if (!a) {
        a = { articolo_id: r.articolo_id, nome: r.articolo_nome, taglie: [], quantita: 0 }
        g.articoli.push(a)
      }
      const tkey = r.taglia ?? ''
      let t = a.taglie.find((x) => x.taglia === tkey)
      if (!t) {
        t = { taglia: tkey, quantita: 0, righe_ids: [] }
        a.taglie.push(t)
      }
      t.quantita += r.quantita
      t.righe_ids.push(r.id)
      a.quantita += r.quantita
      g.quantita += r.quantita
    }

    // ordina: prima i fornitori (per nome), "Senza fornitore" in coda
    const out = [...gruppi.values()].sort((x, y) => {
      if (!x.fornitore) return 1
      if (!y.fornitore) return -1
      return x.fornitore.nome.localeCompare(y.fornitore.nome)
    })

    return NextResponse.json({ success: true, data: { gruppi: out } })
  } catch (err) {
    console.error('Errore API GET merch/da-ordinare:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
