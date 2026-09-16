import { NextRequest, NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const SEDE = '11000000-0000-4000-8000-000000000001'
const ALTRA_SEDE = '11000000-0000-4000-8000-000000000099'
const STAFF = '22000000-0000-4000-8000-000000000002'
const ALUNNO = '33000000-0000-4000-8000-000000000003'
const AUTH_DUE = '44000000-0000-4000-8000-000000000004'
const PARENT_UNO = '55000000-0000-4000-8000-000000000005'
const PARENT_DUE = '66000000-0000-4000-8000-000000000006'

type Riga = Record<string, unknown>

const h = vi.hoisted(() => ({
  tabelle: {} as Record<string, Riga[]>,
  errori: {} as Record<string, unknown>,
  authResponse: null as NextResponse | null,
  scopeResponse: null as NextResponse | null,
  sedeRichiesta: null as string | null,
  chiamate: [] as Array<{
    tabella: string
    eq: Record<string, unknown>
    in: Record<string, unknown[]>
    range?: [number, number]
  }>,
}))

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn() }))
vi.mock('@/lib/logging/logger', () => log)
vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: vi.fn(async () => h.authResponse
    ? { response: h.authResponse }
    : { user: { id: STAFF, role: 'segreteria', scuola_id: SEDE } }),
}))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuolaScrittura: vi.fn(async (_request, _supabase, _user, preferita: string) => {
    h.sedeRichiesta = preferita
    return h.scopeResponse ? { response: h.scopeResponse } : { scuolaId: preferita }
  }),
}))

function creaQuery(tabella: string) {
  const eq: Record<string, unknown> = {}
  const valoriIn: Record<string, unknown[]> = {}
  const ordini: Array<{ colonna: string; ascending: boolean }> = []
  let intervallo: [number, number] | undefined
  const query: Record<string, unknown> = {}

  query.select = () => query
  query.eq = (colonna: string, valore: unknown) => {
    eq[colonna] = valore
    return query
  }
  query.in = (colonna: string, valori: unknown[]) => {
    valoriIn[colonna] = valori
    return query
  }
  query.order = (colonna: string, opzioni?: { ascending?: boolean }) => {
    ordini.push({ colonna, ascending: opzioni?.ascending !== false })
    return query
  }
  query.range = (da: number, a: number) => {
    intervallo = [da, a]
    return query
  }

  const esegui = () => {
    h.chiamate.push({ tabella, eq: { ...eq }, in: { ...valoriIn }, range: intervallo })
    const error = h.errori[tabella] ?? null
    let righe = [...(h.tabelle[tabella] ?? [])]
    for (const [colonna, valore] of Object.entries(eq)) {
      righe = righe.filter((riga) => riga[colonna] === valore)
    }
    for (const [colonna, valori] of Object.entries(valoriIn)) {
      righe = righe.filter((riga) => valori.includes(riga[colonna]))
    }
    for (const ordine of [...ordini].reverse()) {
      righe.sort((a, b) => {
        const av = String(a[ordine.colonna] ?? '')
        const bv = String(b[ordine.colonna] ?? '')
        return av.localeCompare(bv) * (ordine.ascending ? 1 : -1)
      })
    }
    if (intervallo) righe = righe.slice(intervallo[0], intervallo[1] + 1)
    return { data: error ? null : righe, error }
  }

  query.maybeSingle = async () => {
    const risultato = esegui()
    return { data: risultato.data?.[0] ?? null, error: risultato.error }
  }
  query.then = (onfulfilled: (valore: unknown) => unknown) => Promise.resolve(onfulfilled(esegui()))
  return query
}

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn(async () => ({ from: (tabella: string) => creaQuery(tabella) })),
}))

import { GET } from '@/app/api/pagamenti/fattura/revisione/route'

function richiesta(query = `scuola_id=${SEDE}`) {
  return new NextRequest(`http://localhost/api/pagamenti/fattura/revisione?${query}`)
}

function fattura(
  id: string,
  pagamentoId: string,
  creatoIl: string,
  modalita: 'ordinaria' | 'quote_separate' | null,
  extra: Riga = {},
): Riga {
  return {
    id,
    pagamento_id: pagamentoId,
    scuola_id: SEDE,
    numero: Number(id.slice(-2)),
    anno: 2026,
    intestatario: { nome: `Nome ${id.slice(-2)}`, cognome: 'Famiglia' },
    sdi_stato: 1,
    pdf_path: `documenti/${id}.pdf`,
    modalita_emissione: modalita,
    parent_registry_id: modalita === 'quote_separate' ? PARENT_UNO : null,
    creato_il: creatoIl,
    ...extra,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.authResponse = null
  h.scopeResponse = null
  h.sedeRichiesta = null
  h.errori = {}
  h.chiamate = []
  h.tabelle = {
    admin_settings: [{ scuola_id: SEDE, fatture_visibilita_attiva_il: null }],
    fatture_emesse: [],
    fatture_visibilita_revisioni: [],
    pagamenti: [],
    student_parents: [],
    legame_genitori_alunni: [],
    parents: [],
  }
})

describe('GET /api/pagamenti/fattura/revisione', () => {
  it('richiede ruolo staff, sede esplicita e query valida prima di leggere il database', async () => {
    h.authResponse = NextResponse.json({ error: 'vietato' }, { status: 403 })
    const negata = await GET(richiesta())
    expect(negata.status).toBe(403)
    expect(negata.headers.get('cache-control')).toBe('no-store')
    expect(h.chiamate).toEqual([])

    h.authResponse = null
    const invalida = await GET(richiesta('pagina=0&per_pagina=51'))
    expect(invalida.status).toBe(400)
    expect(invalida.headers.get('cache-control')).toBe('no-store')
    expect(h.chiamate).toEqual([])
  })

  it('passa la sede dichiarata al resolver e conserva un suo diniego', async () => {
    h.scopeResponse = NextResponse.json({ error: 'sede non accessibile' }, { status: 403 })
    const risposta = await GET(richiesta())
    expect(risposta.status).toBe(403)
    expect(risposta.headers.get('cache-control')).toBe('no-store')
    expect(h.sedeRichiesta).toBe(SEDE)
    expect(h.chiamate).toEqual([])
  })

  it('decodifica snapshot e bozze senza inferenze e propone l’unione verificabile dei genitori', async () => {
    const f1 = '70000000-0000-4000-8000-000000000001'
    const f2 = '70000000-0000-4000-8000-000000000002'
    const f3 = '70000000-0000-4000-8000-000000000003'
    const f4 = '70000000-0000-4000-8000-000000000004'
    const f5 = '70000000-0000-4000-8000-000000000005'
    const pagamenti = [f1, f2, f3, f4, f5].map((id, indice) => ({
      id: `80000000-0000-4000-8000-00000000000${indice + 1}`,
      alunno_id: ALUNNO,
      scuola_id: indice === 4 ? ALTRA_SEDE : SEDE,
    }))
    h.tabelle.fatture_emesse = [
      fattura(f1, pagamenti[0].id, '2026-09-16T10:05:00Z', 'ordinaria'),
      fattura(f2, pagamenti[1].id, '2026-09-16T10:04:00Z', null),
      fattura(f3, pagamenti[2].id, '2026-09-16T10:03:00Z', null),
      fattura(f4, pagamenti[3].id, '2026-09-16T10:02:00Z', null, { pdf_path: null }),
      fattura(f5, pagamenti[4].id, '2026-09-16T10:01:00Z', 'quote_separate'),
    ]
    h.tabelle.pagamenti = pagamenti
    h.tabelle.fatture_visibilita_revisioni = [
      {
        fattura_id: f2,
        modalita: 'quote_separate',
        parent_registry_id: PARENT_DUE,
        verificata_il: '2026-09-16T11:00:00Z',
        verificata_da: STAFF,
      },
      {
        fattura_id: f3,
        modalita: 'irrisolta',
        parent_registry_id: null,
        verificata_il: '2026-09-16T11:01:00Z',
        verificata_da: STAFF,
      },
    ]
    h.tabelle.student_parents = [{ student_id: ALUNNO, parent_id: PARENT_UNO }]
    h.tabelle.legame_genitori_alunni = [{ alunno_id: ALUNNO, genitore_id: AUTH_DUE }]
    h.tabelle.parents = [
      { id: PARENT_UNO, first_name: 'Ada', last_name: 'Uno', fiscal_code: 'UNOX', auth_user_id: null },
      { id: PARENT_DUE, first_name: 'Bice', last_name: 'Due', fiscal_code: 'DUEY', auth_user_id: AUTH_DUE },
    ]

    const risposta = await GET(richiesta())
    expect(risposta.status).toBe(200)
    expect(risposta.headers.get('cache-control')).toBe('no-store')
    const body = await risposta.json()
    expect(body.data).toMatchObject({
      pagina: 1,
      per_pagina: 25,
      totale: 5,
      attiva_il: null,
      da_verificare: 1,
      revisionate: 2,
      irrisolte: [{ id: f3, numero: 3, anno: 2026, intestatario: 'Nome 03 Famiglia' }],
    })
    expect(body.data.fatture.map((riga: Riga) => ({
      id: riga.id,
      stato: riga.stato,
      definitiva: riga.definitiva,
      parent_registry_id: riga.parent_registry_id,
      anomalia: riga.anomalia,
      ha_pdf: riga.ha_pdf,
      candidati: riga.candidati,
    }))).toEqual([
      {
        id: f1,
        stato: 'ordinaria',
        definitiva: true,
        parent_registry_id: null,
        anomalia: null,
        ha_pdf: true,
        candidati: [
          { id: PARENT_DUE, nome: 'Bice', cognome: 'Due', codice_fiscale: 'DUEY', account_collegato: true },
          { id: PARENT_UNO, nome: 'Ada', cognome: 'Uno', codice_fiscale: 'UNOX', account_collegato: false },
        ],
      },
      {
        id: f2,
        stato: 'quote_separate',
        definitiva: false,
        parent_registry_id: PARENT_DUE,
        anomalia: null,
        ha_pdf: true,
        candidati: expect.any(Array),
      },
      {
        id: f3,
        stato: 'irrisolta',
        definitiva: false,
        parent_registry_id: null,
        anomalia: null,
        ha_pdf: true,
        candidati: expect.any(Array),
      },
      {
        id: f4,
        stato: 'da_verificare',
        definitiva: false,
        parent_registry_id: null,
        anomalia: null,
        ha_pdf: false,
        candidati: expect.any(Array),
      },
      {
        id: f5,
        stato: 'quote_separate',
        definitiva: true,
        parent_registry_id: PARENT_UNO,
        anomalia: 'sede_pagamento_disallineata',
        ha_pdf: true,
        candidati: [],
      },
    ])
    expect(body.data.fatture[1]).toMatchObject({
      verificata_il: '2026-09-16T11:00:00Z',
      verificata_da: STAFF,
    })
  })

  it('legge i metadati a blocchi e calcola totale e irrisolte sull’intera sede oltre 1000 righe', async () => {
    h.tabelle.fatture_emesse = Array.from({ length: 1001 }, (_, indice) => {
      const suffisso = String(indice + 1).padStart(12, '0')
      return fattura(
        `70000000-0000-4000-8000-${suffisso}`,
        `80000000-0000-4000-8000-${suffisso}`,
        new Date(Date.UTC(2026, 0, 1, 0, 0, indice)).toISOString(),
        null,
      )
    })
    const ultima = h.tabelle.fatture_emesse.at(-1)!
    h.tabelle.fatture_visibilita_revisioni = [{
      fattura_id: ultima.id,
      modalita: 'irrisolta',
      parent_registry_id: null,
      verificata_il: '2026-09-16T11:00:00Z',
      verificata_da: STAFF,
    }]

    const risposta = await GET(richiesta(`scuola_id=${SEDE}&pagina=2&per_pagina=2`))
    expect(risposta.status).toBe(200)
    const body = await risposta.json()
    expect(body.data).toMatchObject({
      pagina: 2,
      per_pagina: 2,
      totale: 1001,
      da_verificare: 1000,
      revisionate: 1,
    })
    expect(body.data.fatture).toHaveLength(2)
    expect(body.data.irrisolte).toHaveLength(1)
    expect(body.data.irrisolte[0].id).toBe(ultima.id)
    expect(h.chiamate.filter((chiamata) => chiamata.tabella === 'fatture_emesse').map((c) => c.range)).toEqual([
      [0, 499],
      [500, 999],
      [1000, 1499],
    ])
  })

  it('fallisce in modo controllato se una lettura necessaria ai candidati non è verificabile', async () => {
    const id = '70000000-0000-4000-8000-000000000001'
    const pagamento = '80000000-0000-4000-8000-000000000001'
    h.tabelle.fatture_emesse = [fattura(id, pagamento, '2026-09-16T10:00:00Z', null)]
    h.tabelle.pagamenti = [{ id: pagamento, alunno_id: ALUNNO, scuola_id: SEDE }]
    h.errori.student_parents = { code: 'DB_DOWN', message: 'nomi privati non devono entrare nel log' }

    const risposta = await GET(richiesta())
    expect(risposta.status).toBe(500)
    expect(await risposta.json()).toMatchObject({ codice: 'LETTURA_FALLITA' })
    expect(log.logEvento).toHaveBeenCalledWith(
      'fattura',
      'error',
      expect.objectContaining({
        operazione: 'pagamenti/fattura/revisione:GET',
        esito: 'legami-anagrafici-non-letti',
        scuola_id: SEDE,
      }),
      h.errori.student_parents,
    )
  })
})
