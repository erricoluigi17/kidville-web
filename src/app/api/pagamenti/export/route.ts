import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import * as XLSX from 'xlsx'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { calcolaAttestazione, type VoceAttestazione } from '@/lib/pagamenti/attestazione'
import { resolveParentRegistry, type ParentRegistry } from '@/lib/pagamenti/intestatari'

// ─── Schemi di validazione input ─────────────────────────────────────────────
const zUuidQueryOpzionale = z.preprocess((v) => (v === '' ? undefined : v), zUuid.optional())

const getQuerySchema = z
  .object({
    tipo: z.enum(['scadenzario', 'ade']),
    scuola_id: zUuidQueryOpzionale,
    stato: z.string().optional(),
    categoria_id: zUuidQueryOpzionale,
    anno: z.coerce.number().int().min(2000).max(2100).optional(),
  })
  .refine((q) => q.tipo !== 'ade' || q.anno !== undefined, "l'export AdE richiede l'anno")

const STATO_LABEL: Record<string, string> = {
  da_pagare: 'Da pagare', parziale: 'Parziale', pagato: 'Pagato', scaduto: 'Scaduto',
}
const FATTURA_LABEL: Record<string, string> = {
  non_richiesta: 'Da fatturare', in_attesa: 'In attesa SDI', emessa: 'Fatturata', scartata: 'Scartata',
}

interface RigaPagamento {
  descrizione: string
  importo: number
  importo_pagato: number | null
  scadenza: string | null
  periodo_competenza: string | null
  stato: string
  tipo: string
  fattura_stato: string | null
  alunni?: { nome?: string; cognome?: string; classe_sezione?: string | null } | null
  payment_categories?: { nome?: string } | null
}

// GET /api/pagamenti/export?tipo=scadenzario — XLSX per la segreteria/commercialista
export async function GET(request: NextRequest) {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { scuola_id: scuolaId, stato, categoria_id: categoriaId } = q.data

    const supabase = await createAdminClient()
    const sediAttive = await resolveScuoleAttive(request, supabase, user)

    if (q.data.tipo === 'ade') {
      return exportAde(supabase, sediAttive, q.data.anno!)
    }

    let query = supabase
      .from('pagamenti')
      .select(`
        descrizione, importo, importo_pagato, scadenza, periodo_competenza, stato, tipo, fattura_stato,
        payment_categories ( nome ),
        alunni ( nome, cognome, classe_sezione )
      `)
      .in('scuola_id', sediAttive)
      .order('scadenza', { ascending: true })
    if (scuolaId && sediAttive.includes(scuolaId)) query = query.eq('scuola_id', scuolaId)
    if (stato) query = query.eq('stato', stato)
    if (categoriaId) query = query.eq('categoria_id', categoriaId)

    const { data, error } = await query
    if (error) {
      console.error('Errore export pagamenti:', error)
      return NextResponse.json({ error: 'Errore nel recupero dei pagamenti' }, { status: 500 })
    }

    // I contenitori padre non sono voci esigibili: nell'export contano le rate.
    const righe = ((data || []) as unknown as RigaPagamento[])
      .filter((p) => p.tipo !== 'padre')
      .map((p) => ({
        Alunno: [p.alunni?.nome, p.alunni?.cognome].filter(Boolean).join(' '),
        Sezione: p.alunni?.classe_sezione ?? '',
        Categoria: p.payment_categories?.nome ?? '',
        Descrizione: p.descrizione,
        Scadenza: p.scadenza ?? '',
        'Importo €': Number(p.importo),
        'Pagato €': Number(p.importo_pagato || 0),
        'Residuo €': Math.max(0, Number(p.importo) - Number(p.importo_pagato || 0)),
        Stato: STATO_LABEL[p.stato] ?? p.stato,
        Fattura: p.stato === 'pagato' ? (FATTURA_LABEL[p.fattura_stato ?? 'non_richiesta'] ?? '') : '',
      }))

    const ws = XLSX.utils.json_to_sheet(righe)
    ws['!cols'] = [{ wch: 24 }, { wch: 12 }, { wch: 12 }, { wch: 34 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 14 }]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Scadenzario')

    // SheetJS ritorna Buffer in Node: cast ad ArrayBuffer per NextResponse
    const rawBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as unknown
    const nodeBuffer = rawBuffer as { buffer: ArrayBuffer; byteOffset: number; byteLength: number }
    const arrayBuffer = nodeBuffer.buffer.slice(nodeBuffer.byteOffset, nodeBuffer.byteOffset + nodeBuffer.byteLength)
    const oggi = new Date().toISOString().slice(0, 10)
    return new NextResponse(new Uint8Array(arrayBuffer as ArrayBuffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="scadenzario-${oggi}.xlsx"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    console.error('Errore API export pagamenti:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

interface AlunnoAde {
  id: string
  nome?: string | null
  cognome?: string | null
  codice_fiscale?: string | null
  opposizione_ade?: boolean | null
  intestatario_fatture?: { adult_id?: string | null } | null
}
interface IncassoAde {
  importo: number
  metodo?: string | null
  pagamenti?: {
    alunno_id: string
    descrizione?: string | null
    payment_categories?: { slug?: string | null } | null
  } | null
}

// Export per la comunicazione delle spese scolastiche all'AdE (obbligo dal
// periodo d'imposta 2022, invio entro il 16 marzo): criterio di cassa
// sull'anno solare, SOLO quote tracciabili di categorie ammesse. Il foglio
// "Escluse" motiva ogni esclusione (opposizione, contanti, categorie
// non detraibili, CF pagatore mancante) per il controllo del commercialista.
async function exportAde(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  sediAttive: string[],
  anno: number,
) {
  // select('*') sugli alunni: tollera i DB senza opposizione_ade (e2e CI).
  const { data: alunniRaw, error: errAlunni } = await supabase
    .from('alunni')
    .select('*')
    .in('scuola_id', sediAttive)
  if (errAlunni) {
    console.error('Errore export AdE (alunni):', errAlunni)
    return NextResponse.json({ error: 'Errore nel recupero degli alunni' }, { status: 500 })
  }

  const { data: incassiRaw, error: errIncassi } = await supabase
    .from('incassi')
    .select('importo, metodo, data_incasso, pagamenti!inner ( alunno_id, scuola_id, descrizione, payment_categories ( slug ) )')
    .gte('data_incasso', `${anno}-01-01`)
    .lte('data_incasso', `${anno}-12-31`)
    .in('pagamenti.scuola_id', sediAttive)
  if (errIncassi) {
    console.error('Errore export AdE (incassi):', errIncassi)
    return NextResponse.json({ error: 'Errore nel recupero degli incassi' }, { status: 500 })
  }

  const perAlunno = new Map<string, VoceAttestazione[]>()
  for (const i of (incassiRaw || []) as unknown as IncassoAde[]) {
    const alunnoId = i.pagamenti?.alunno_id
    if (!alunnoId) continue
    const arr = perAlunno.get(alunnoId) ?? []
    arr.push({
      importo: i.importo,
      metodo: i.metodo,
      categoria_slug: i.pagamenti?.payment_categories?.slug ?? null,
      descrizione: i.pagamenti?.descrizione ?? '—',
    })
    perAlunno.set(alunnoId, arr)
  }

  const regCache = new Map<string, ParentRegistry | null>()
  const daComunicare: Record<string, unknown>[] = []
  const escluse: Record<string, unknown>[] = []

  for (const al of (alunniRaw || []) as unknown as AlunnoAde[]) {
    const voci = perAlunno.get(al.id) ?? []
    if (voci.length === 0) continue
    const r = calcolaAttestazione(voci)
    const nome = `${al.nome ?? ''} ${al.cognome ?? ''}`.trim()

    if (r.nonTracciabile > 0) {
      escluse.push({ Alunno: nome, Motivo: 'quota non tracciabile (contanti/altro)', 'Importo €': r.nonTracciabile })
    }
    if (r.escluso > 0) {
      escluse.push({ Alunno: nome, Motivo: 'categoria non detraibile (divise/materiale)', 'Importo €': r.escluso })
    }
    if (r.detraibile <= 0) continue

    if (al.opposizione_ade) {
      escluse.push({ Alunno: nome, Motivo: 'opposizione della famiglia alla comunicazione', 'Importo €': r.detraibile })
      continue
    }

    const adultId = al.intestatario_fatture?.adult_id ?? null
    let reg: ParentRegistry | null = null
    if (adultId) {
      if (regCache.has(adultId)) reg = regCache.get(adultId) ?? null
      else {
        reg = await resolveParentRegistry(supabase, adultId)
        regCache.set(adultId, reg)
      }
    }
    if (!reg?.fiscal_code) {
      escluse.push({ Alunno: nome, Motivo: 'codice fiscale del pagatore mancante', 'Importo €': r.detraibile })
      continue
    }

    daComunicare.push({
      'CF alunno': al.codice_fiscale ?? '',
      Alunno: nome,
      'CF pagatore': reg.fiscal_code,
      Pagatore: [reg.first_name, reg.last_name].filter(Boolean).join(' '),
      'Importo comunicabile €': r.detraibile,
      Anno: anno,
    })
  }

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(daComunicare), 'Da comunicare')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(escluse), 'Escluse')

  const rawBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as unknown
  const nodeBuffer = rawBuffer as { buffer: ArrayBuffer; byteOffset: number; byteLength: number }
  const arrayBuffer = nodeBuffer.buffer.slice(nodeBuffer.byteOffset, nodeBuffer.byteOffset + nodeBuffer.byteLength)
  return new NextResponse(new Uint8Array(arrayBuffer as ArrayBuffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="comunicazione-ade-${anno}.xlsx"`,
      'Cache-Control': 'no-store',
    },
  })
}
