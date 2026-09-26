import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import * as XLSX from 'xlsx'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, SEDE_C, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'

// =============================================================================
// K2 (2026-09-26) — `GET /api/pagamenti/export`: filtro per classi e colonna Sede.
//
// Con tre plessi l'export dello Scadenzario (e quello per l'Agenzia delle
// Entrate) mescolava righe di sedi diverse senza dire di quale sede fosse ogni
// riga: due «Sezione A» — una di Giugliano, una di Aversa — erano la stessa
// stringa. Da qui:
//  · colonna «Sede» PRIMA colonna, col NOME della sede, in entrambi gli export;
//  · `section_ids` (uuid separati da virgola) che filtra lo Scadenzario per
//    `alunni.section_id` — con join `!inner`, altrimenti PostgREST NON scarta la
//    riga: le mette solo `alunni: null`, e l'export «della Sezione A» uscirebbe
//    con tutte le voci della sede.
//
// Finto client che FILTRA davvero e `scope.ts` VERO (nessun mock dello scope).
// =============================================================================

const SEZ_1 = '10000000-0000-4000-8000-000000000001'
const SEZ_2 = '20000000-0000-4000-8000-000000000002'
const SEZ_3 = '30000000-0000-4000-8000-000000000003'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  db: {} as DBFinto,
  tabelle: [] as string[],
  scritture: [] as Scrittura[],
  errori: {} as Record<string, { code: string }>,
  selectPagamenti: [] as string[],
  logEvento: vi.fn(),
  logErrore: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
// Spie che CONSERVANO l'implementazione vera: il log si verifica senza spegnerlo
// (la redazione e il fail-open restano quelli di produzione).
vi.mock('@/lib/logging/logger', async (importActual) => {
  const vero = await importActual<typeof import('@/lib/logging/logger')>()
  h.logEvento.mockImplementation(vero.logEvento)
  h.logErrore.mockImplementation(vero.logErrore)
  return { ...vero, logEvento: h.logEvento, logErrore: h.logErrore }
})
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  // Registra la stringa di `select` su `pagamenti`: il finto client tratta un
  // filtro annidato COME un `!inner` anche quando `!inner` manca, quindi la
  // sola asserzione sulle righe non vedrebbe la sua assenza. La stringa sì.
  const conSpia = (vero: ReturnType<typeof creaFintoSupabase>) =>
    new Proxy(vero as unknown as Record<string, unknown>, {
      get(t, p) {
        if (p !== 'from') return t[p as string]
        return (tabella: string) => {
          const q = (t.from as (x: string) => Record<string, unknown>)(tabella)
          if (tabella !== 'pagamenti') return q
          return new Proxy(q, {
            get(qt, qp) {
              if (qp !== 'select') return qt[qp as string]
              return (colonne: string, opts?: unknown) => {
                h.selectPagamenti.push(colonne)
                return (qt.select as (c: string, o?: unknown) => unknown)(colonne, opts)
              }
            },
          })
        }
      },
    })
  return {
    createAdminClient: async () =>
      conSpia(creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture, errori: h.errori })),
  }
})

import { GET } from '@/app/api/pagamenti/export/route'

const scrittureSu = (tabella: string) => h.scritture.filter((s) => s.tabella === tabella)

const req = (qs: string, cookie?: string) =>
  new NextRequest(`http://localhost/api/pagamenti/export?${qs}`, cookie ? { headers: { cookie } } : undefined)

const ADMIN_AB = { id: 'admin-1', role: 'admin', scuola_id: SEDE_A }

const alunno = (sede: string, sezione: string | null, nome: string) => ({
  nome, cognome: 'Prova', classe_sezione: 'Sezione A', section_id: sezione, scuola_id: sede,
})

const dbBase = (): DBFinto => ({
  schools: [
    { id: SEDE_A, nome: NOME_SEDE_A },
    { id: SEDE_B, nome: NOME_SEDE_B },
    { id: SEDE_C, nome: 'Sede Terza' },
  ],
  scuole: [
    { id: SEDE_A, attiva: true },
    { id: SEDE_B, attiva: true },
    { id: SEDE_C, attiva: true },
  ],
  utenti_scuole: [
    { utente_id: 'admin-1', scuola_id: SEDE_A },
    { utente_id: 'admin-1', scuola_id: SEDE_B },
  ],
  pagamenti: [
    {
      id: 'p-a1', scuola_id: SEDE_A, descrizione: 'Retta A1', importo: 150, importo_pagato: 0,
      scadenza: '2026-09-05', periodo_competenza: '2026-09-01', stato: 'da_pagare', tipo: 'singolo',
      fattura_stato: null, categoria_id: null,
      alunni: alunno(SEDE_A, SEZ_1, 'Uno'), payment_categories: { nome: 'Retta' },
    },
    {
      id: 'p-a2', scuola_id: SEDE_A, descrizione: 'Retta A2', importo: 150, importo_pagato: 0,
      scadenza: '2026-09-06', periodo_competenza: '2026-09-01', stato: 'da_pagare', tipo: 'singolo',
      fattura_stato: null, categoria_id: null,
      alunni: alunno(SEDE_A, SEZ_2, 'Due'), payment_categories: { nome: 'Retta' },
    },
    {
      id: 'p-b3', scuola_id: SEDE_B, descrizione: 'Retta B3', importo: 160, importo_pagato: 0,
      scadenza: '2026-09-07', periodo_competenza: '2026-09-01', stato: 'da_pagare', tipo: 'singolo',
      fattura_stato: null, categoria_id: null,
      alunni: alunno(SEDE_B, SEZ_3, 'Tre'), payment_categories: { nome: 'Retta' },
    },
    {
      // Voce senza alunno (es. un addebito di sede): senza filtro classi DEVE
      // restare nell'export — il `!inner` vale solo quando le classi si chiedono.
      id: 'p-b0', scuola_id: SEDE_B, descrizione: 'Addebito di sede', importo: 10, importo_pagato: 0,
      scadenza: '2026-09-08', periodo_competenza: '2026-09-01', stato: 'da_pagare', tipo: 'singolo',
      fattura_stato: null, categoria_id: null,
      alunni: null, payment_categories: null,
    },
    {
      // Sede NON in scope: non deve comparire mai, neanche nominandone la sezione.
      id: 'p-c9', scuola_id: SEDE_C, descrizione: 'Retta C9', importo: 170, importo_pagato: 0,
      scadenza: '2026-09-09', periodo_competenza: '2026-09-01', stato: 'da_pagare', tipo: 'singolo',
      fattura_stato: null, categoria_id: null,
      alunni: alunno(SEDE_C, SEZ_1, 'Nove'), payment_categories: { nome: 'Retta' },
    },
  ],
})

async function foglio(res: Response, nome: string) {
  const wb = XLSX.read(Buffer.from(await res.arrayBuffer()))
  const ws = wb.Sheets[nome]
  return {
    intestazione: (XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 })[0] ?? []) as string[],
    righe: XLSX.utils.sheet_to_json<Record<string, unknown>>(ws),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.errori = {}
  h.selectPagamenti = []
  h.requireStaff.mockResolvedValue({ user: ADMIN_AB })
})

describe('GET /api/pagamenti/export?tipo=scadenzario — colonna Sede', () => {
  it('«Sede» è la PRIMA colonna e porta il NOME della sede di ogni riga', async () => {
    const res = await GET(req('tipo=scadenzario'))
    expect(res.status).toBe(200)
    const { intestazione, righe } = await foglio(res, 'Scadenzario')
    expect(intestazione[0]).toBe('Sede')
    const perDescrizione = Object.fromEntries(righe.map((r) => [r.Descrizione, r.Sede]))
    expect(perDescrizione).toEqual({
      'Retta A1': NOME_SEDE_A,
      'Retta A2': NOME_SEDE_A,
      'Retta B3': NOME_SEDE_B,
      'Addebito di sede': NOME_SEDE_B,
    })
  })

  it('senza section_ids niente `!inner`: la voce senza alunno resta nell\'export', async () => {
    const res = await GET(req('tipo=scadenzario'))
    expect(res.status).toBe(200)
    expect(h.selectPagamenti.join(' ')).not.toMatch(/alunni\s*!\s*inner/)
  })

  it('nomi delle sedi non leggibili: 500, mai un export con la colonna Sede vuota', async () => {
    h.errori = { 'schools:select': { code: '57014' } }
    const res = await GET(req('tipo=scadenzario'))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('LETTURA_FALLITA')
    expect(h.logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ operazione: 'pagamenti/export:GET', stato: 500, evento: 'db' }),
      expect.anything(),
    )
  })

  it('log di successo senza filtro: `export-scadenzario` con classi=0 e n = righe esportate', async () => {
    const res = await GET(req('tipo=scadenzario'))
    expect(res.status).toBe(200)
    const chiamate = h.logEvento.mock.calls.filter(
      (c) => c[0] === 'pagamento' && (c[2] as { tipo?: string })?.tipo === 'export-scadenzario',
    )
    expect(chiamate).toHaveLength(1)
    expect(chiamate[0][1]).toBe('info')
    expect(chiamate[0][2]).toEqual(expect.objectContaining({ attive: 2, classi: 0, n: 4 }))
  })
})

describe('GET /api/pagamenti/export?tipo=scadenzario — section_ids', () => {
  it('una classe: solo le voci degli alunni di QUELLA sezione, e il join è `!inner`', async () => {
    const res = await GET(req(`tipo=scadenzario&section_ids=${SEZ_1}`))
    expect(res.status).toBe(200)
    const { righe } = await foglio(res, 'Scadenzario')
    expect(righe.map((r) => r.Descrizione)).toEqual(['Retta A1'])
    expect(h.selectPagamenti.join(' ')).toMatch(/alunni\s*!\s*inner/)
  })

  it('più classi separate da virgola, anche di sedi diverse: l\'unione, con la Sede di ciascuna', async () => {
    const res = await GET(req(`tipo=scadenzario&section_ids=${SEZ_1},${SEZ_3}`))
    expect(res.status).toBe(200)
    const { righe } = await foglio(res, 'Scadenzario')
    expect(righe.map((r) => [r.Descrizione, r.Sede])).toEqual([
      ['Retta A1', NOME_SEDE_A],
      ['Retta B3', NOME_SEDE_B],
    ])
    // Il log dice QUANTE classi e QUANTE righe — mai quali alunni: il contesto
    // ha solo queste chiavi, e nessun valore è un nome o una descrizione.
    const chiamate = h.logEvento.mock.calls.filter(
      (c) => c[0] === 'pagamento' && (c[2] as { tipo?: string })?.tipo === 'export-scadenzario',
    )
    expect(chiamate).toHaveLength(1)
    const ctx = chiamate[0][2] as Record<string, unknown>
    expect(ctx).toEqual(expect.objectContaining({ attive: 2, classi: 2, n: 2 }))
    expect(Object.keys(ctx).sort()).toEqual(['attive', 'azione', 'classi', 'n', 'ruolo', 'tipo', 'utente'])
  })

  it('parametro RIPETUTO (`section_ids=a&section_ids=b`, che parseQuery consegna come array): accettato', async () => {
    const res = await GET(req(`tipo=scadenzario&section_ids=${SEZ_1}&section_ids=${SEZ_3}`))
    expect(res.status).toBe(200)
    const { righe } = await foglio(res, 'Scadenzario')
    expect(righe.map((r) => r.Descrizione)).toEqual(['Retta A1', 'Retta B3'])
  })

  it('oltre il tetto di 200 classi: 400, e `pagamenti` non viene nemmeno interrogato', async () => {
    const tanti = Array.from({ length: 201 }, (_, i) =>
      `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`)
    expect(new Set(tanti).size).toBe(201)
    const res = await GET(req(`tipo=scadenzario&section_ids=${tanti.join(',')}`))
    expect(res.status).toBe(400)
    expect(h.selectPagamenti).toEqual([])
  })

  it('esattamente 200 classi: accettate (il tetto è incluso)', async () => {
    const duecento = Array.from({ length: 199 }, (_, i) =>
      `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`)
    const res = await GET(req(`tipo=scadenzario&section_ids=${[SEZ_1, ...duecento].join(',')}`))
    expect(res.status).toBe(200)
    const { righe } = await foglio(res, 'Scadenzario')
    expect(righe.map((r) => r.Descrizione)).toEqual(['Retta A1'])
  })

  it('la classe NON restringe fuori dallo scope: una sezione condivisa con una sede non propria non porta le sue righe', async () => {
    // SEZ_1 compare anche sotto SEDE_C (fixture volutamente sporca): lo scope di
    // sede resta il primo filtro, la classe viene dopo.
    const res = await GET(req(`tipo=scadenzario&section_ids=${SEZ_1}`))
    const { righe } = await foglio(res, 'Scadenzario')
    expect(righe.map((r) => r.Descrizione)).not.toContain('Retta C9')
  })

  it('section_ids con un valore non uuid: 400', async () => {
    const res = await GET(req(`tipo=scadenzario&section_ids=${SEZ_1},non-un-uuid`))
    expect(res.status).toBe(400)
    expect(h.selectPagamenti).toEqual([])
  })

  // Audit GDPR (`logScrittura` → `audit_scritture_docente`): chi esporta lo
  // Scadenzario di ALCUNE classi deve risultare così, non come se avesse
  // esportato tutta la sede. K2.md lo promette: qui lo si prova.
  it('audit: `valore_dopo.classi` registra le classi FILTRATE dello Scadenzario', async () => {
    const res = await GET(req(`tipo=scadenzario&section_ids=${SEZ_1},${SEZ_3}`))
    expect(res.status).toBe(200)
    const audit = scrittureSu('audit_scritture_docente')
    expect(audit).toHaveLength(1)
    const riga = audit[0].valori[0] as { entita_tipo: string; valore_dopo: Record<string, unknown> }
    expect(riga.entita_tipo).toBe('export_pagamenti')
    expect(riga.valore_dopo.tipo).toBe('scadenzario')
    expect(riga.valore_dopo.classi).toEqual([SEZ_1, SEZ_3])
  })

  it('audit: senza section_ids `valore_dopo.classi` è null (export di tutte le classi)', async () => {
    const res = await GET(req('tipo=scadenzario'))
    expect(res.status).toBe(200)
    const audit = scrittureSu('audit_scritture_docente')
    expect(audit).toHaveLength(1)
    const riga = audit[0].valori[0] as { valore_dopo: Record<string, unknown> }
    expect(riga.valore_dopo).toHaveProperty('classi', null)
  })

  it('section_ids vuoto equivale ad assente (nessun filtro)', async () => {
    const res = await GET(req('tipo=scadenzario&section_ids='))
    expect(res.status).toBe(200)
    const { righe } = await foglio(res, 'Scadenzario')
    expect(righe).toHaveLength(4)
  })

})

describe('GET /api/pagamenti/export?tipo=ade — colonna Sede', () => {
  beforeEach(() => {
    h.db.alunni = [
      { id: 'al-a', nome: 'Uno', cognome: 'Prova', codice_fiscale: 'CFALUNNOA', opposizione_ade: false,
        intestatario_fatture: { adult_id: 'par-1' }, scuola_id: SEDE_A, stato: 'iscritto' },
      { id: 'al-b', nome: 'Tre', cognome: 'Prova', codice_fiscale: 'CFALUNNOB', opposizione_ade: true,
        intestatario_fatture: { adult_id: 'par-1' }, scuola_id: SEDE_B, stato: 'iscritto' },
    ]
    h.db.parents = [
      { id: 'par-1', first_name: 'Genitore', last_name: 'Prova', fiscal_code: 'CFPAGATORE', auth_user_id: null },
    ]
    h.db.incassi = [
      { importo: 150, metodo: 'bonifico', data_incasso: '2026-01-10',
        pagamenti: { alunno_id: 'al-a', scuola_id: SEDE_A, descrizione: 'Retta', payment_categories: { slug: 'retta' } } },
      { importo: 160, metodo: 'bonifico', data_incasso: '2026-01-11',
        pagamenti: { alunno_id: 'al-b', scuola_id: SEDE_B, descrizione: 'Retta', payment_categories: { slug: 'retta' } } },
    ]
  })

  it('«Sede» è la prima colonna in «Da comunicare» ed «Escluse», col nome della sede dell\'alunno', async () => {
    const res = await GET(req('tipo=ade&anno=2026'))
    expect(res.status).toBe(200)
    const buf = Buffer.from(await res.arrayBuffer())
    const wb = XLSX.read(buf)
    const da = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['Da comunicare'], { header: 1 })
    const es = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['Escluse'], { header: 1 })
    expect(da[0][0]).toBe('Sede')
    expect(es[0][0]).toBe('Sede')
    const daRighe = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['Da comunicare'])
    const esRighe = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['Escluse'])
    expect(daRighe.map((r) => [r['CF alunno'], r.Sede])).toEqual([['CFALUNNOA', NOME_SEDE_A]])
    expect(esRighe.map((r) => r.Sede)).toEqual([NOME_SEDE_B])
  })

  // Comportamento di PRIMA di K2, conservato: con `tipo=ade` zod scartava la
  // chiave `section_ids` e la risposta era 200. La comunicazione AdE è sull'anno
  // e sulla sede per intero: il filtro classe NON si applica (niente file
  // parziale) e NON rompe il download (niente 400 se l'interfaccia riusa la
  // stessa query dello Scadenzario). Lo si dice nel log, a livello info.
  it('section_ids con tipo=ade: 200, filtro NON applicato (tutte le righe) e log info che lo dice', async () => {
    const res = await GET(req(`tipo=ade&anno=2026&section_ids=${SEZ_1}`))
    expect(res.status).toBe(200)
    const wb = XLSX.read(Buffer.from(await res.arrayBuffer()))
    const daRighe = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['Da comunicare'])
    const esRighe = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['Escluse'])
    expect(daRighe.map((r) => r['CF alunno'])).toEqual(['CFALUNNOA'])
    expect(esRighe).toHaveLength(1)
    expect(h.logEvento).toHaveBeenCalledWith('pagamento', 'info', expect.objectContaining({
      tipo: 'export-ade-classi-ignorate', classi: 1,
    }))
  })

  // Il filtro classi NON si applica all'AdE: l'audit non deve registrare un
  // filtro mai applicato, altrimenti dichiarerebbe un export parziale che invece
  // contiene tutta la sede (mutazione `classi: q.data.section_ids ?? null`).
  it('audit AdE con section_ids: `valore_dopo.classi` resta null (il filtro non è stato applicato)', async () => {
    const res = await GET(req(`tipo=ade&anno=2026&section_ids=${SEZ_1}`))
    expect(res.status).toBe(200)
    const audit = scrittureSu('audit_scritture_docente')
    expect(audit).toHaveLength(1)
    const riga = audit[0].valori[0] as { entita_tipo: string; valore_dopo: Record<string, unknown> }
    expect(riga.entita_tipo).toBe('export_pagamenti')
    expect(riga.valore_dopo.tipo).toBe('ade')
    expect(riga.valore_dopo).toHaveProperty('classi', null)
  })

  it('tipo=ade senza section_ids: nessun log di classi ignorate', async () => {
    const res = await GET(req('tipo=ade&anno=2026'))
    expect(res.status).toBe(200)
    const ignorate = h.logEvento.mock.calls.filter(
      (c) => (c[2] as { tipo?: string })?.tipo === 'export-ade-classi-ignorate',
    )
    expect(ignorate).toEqual([])
  })
})
