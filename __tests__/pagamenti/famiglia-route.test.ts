import { it, expect, vi, beforeEach, describe } from 'vitest'

// GET /api/pagamenti/famiglia?parent_id= — dati per la transazione unica (slice S4).
//  figli via unione legami; voci aperte con residuo effettivo ordinate per scadenza
//  ASC (più vecchie prima); saldo credito famiglia; saldo ticket per figlio;
//  degradazione: colonna sconto assente (42703) → retry senza; genitore senza figli.
const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  scope: vi.fn(),
  parentInScope: vi.fn(),
  figli: vi.fn(),
  saldo: vi.fn(),
  parent: { id: '33333333-3333-4333-8333-333333333333', first_name: 'Anna', last_name: 'Rossi', auth_user_id: 'acc-1' } as Record<string, unknown> | null,
  studentParents: [] as unknown[],
  alunni: [] as unknown[],
  ticket: [] as unknown[],
  pagamenti: { data: [] as unknown, error: null as { code?: string } | null },
  pagamentiRetry: { data: [] as unknown, error: null as { code?: string } | null },
  scuole: { data: [] as unknown, error: null as { code?: string } | null },
  alunniErr: null as { code?: string } | null,
  spErr: null as { code?: string } | null,
  ticketErr: null as { code?: string } | null,
  eventi: [] as unknown[][],
  errori: [] as unknown[][],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
// Il logger vero resta al suo posto; si registrano solo gli argomenti, per
// vedere che ogni ramo d'errore e di degradazione LASCIA una traccia.
vi.mock('@/lib/logging/logger', async (orig) => {
  const vero = await orig<typeof import('@/lib/logging/logger')>()
  return {
    ...vero,
    logEvento: (...a: Parameters<typeof vero.logEvento>) => {
      h.eventi.push(a)
      return vero.logEvento(...a)
    },
    logErrore: (...a: Parameters<typeof vero.logErrore>) => {
      h.errori.push(a)
      return vero.logErrore(...a)
    },
  }
})
// Qui il gate di sede NON è l'oggetto del test (lo è in
// `__tests__/api/pagamenti-famiglia-scope-sede.test.ts`, col finto client e lo
// scope VERO): si lascia passare, così restano coperti i rami di FORMA della
// risposta — ordinamento, degradazione 42703, 404, genitore senza figli.
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: (...a: unknown[]) => h.scope(...a),
  assertParentInScope: (...a: unknown[]) => h.parentInScope(...a),
}))
vi.mock('@/lib/anagrafiche/legami', () => ({ getFigliDiGenitore: (...a: unknown[]) => h.figli(...a) }))
vi.mock('@/lib/pagamenti/credito', () => ({ saldoCredito: (...a: unknown[]) => h.saldo(...a) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      let sconto = true
      // Id ricevuti da `.in('id', …)`: il finto di `scuole` risponde SOLO con
      // quelli, come il DB vero. Senza filtro resterebbe verde anche una route
      // che dimenticasse di chiedere le sedi delle voci.
      let idRichiesti: string[] | null = null
      const b: Record<string, unknown> = {}
      b.select = (cols?: string) => { sconto = typeof cols === 'string' ? cols.includes('sconto') : true; return b }
      b.eq = () => b
      b.in = (col: string, vals: string[]) => { if (col === 'id') idRichiesti = vals; return b }
      b.order = () => b
      b.maybeSingle = async () => (table === 'parents' ? { data: h.parent, error: null } : { data: null, error: null })
      b.then = (resolve: (v: unknown) => unknown) => {
        if (table === 'student_parents') return resolve(h.spErr ? { data: null, error: h.spErr } : { data: h.studentParents, error: null })
        if (table === 'alunni') return resolve(h.alunniErr ? { data: null, error: h.alunniErr } : { data: h.alunni, error: null })
        if (table === 'ticket_mensa') return resolve(h.ticketErr ? { data: null, error: h.ticketErr } : { data: h.ticket, error: null })
        if (table === 'scuole') {
          if (h.scuole.error || !Array.isArray(h.scuole.data)) return resolve(h.scuole)
          const ids = idRichiesti ?? []
          return resolve({ data: (h.scuole.data as { id: string }[]).filter((s) => ids.includes(s.id)), error: null })
        }
        if (table === 'pagamenti') return resolve(sconto ? h.pagamenti : h.pagamentiRetry)
        return resolve({ data: [], error: null })
      }
      return b
    },
  }),
}))

import { GET } from '@/app/api/pagamenti/famiglia/route'

const SC = '22222222-2222-4222-8222-222222222222'
const SC2 = '77777777-7777-4777-8777-777777777777'
const AL1 = '55555555-5555-4555-8555-555555555555'
const AL2 = '66666666-6666-4666-8666-666666666666'
const get = (qs: string) => new Request(`http://localhost/api/pagamenti/famiglia?${qs}`, { headers: { 'x-user-id': 'seg-1' } }) as never

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SC } })
  h.scope.mockResolvedValue([SC])
  h.parentInScope.mockResolvedValue(null)
  h.figli.mockResolvedValue([AL1, AL2])
  h.saldo.mockResolvedValue(25)
  h.parent = { id: '33333333-3333-4333-8333-333333333333', first_name: 'Anna', last_name: 'Rossi', auth_user_id: 'acc-1' }
  h.studentParents = [{ student_id: AL1 }, { student_id: AL2 }]
  h.alunni = [
    { id: AL1, nome: 'Uno', cognome: 'Rossi', scuola_id: SC },
    { id: AL2, nome: 'Due', cognome: 'Rossi', scuola_id: SC },
  ]
  h.ticket = [{ alunno_id: AL1, saldo_ticket: 8 }]
  // due voci aperte con scadenze diverse: la più vecchia deve venire prima
  h.pagamenti = {
    data: [
      { id: 'p-new', alunno_id: AL1, descrizione: 'Retta luglio', importo: 100, importo_pagato: 0, sconto: 0, scadenza: '2026-07-10', stato: 'da_pagare', tipo: 'singolo' },
      { id: 'p-old', alunno_id: AL2, descrizione: 'Retta giugno', importo: 100, importo_pagato: 20, sconto: 0, scadenza: '2026-06-10', stato: 'da_pagare', tipo: 'singolo' },
      { id: 'p-paid', alunno_id: AL1, descrizione: 'Saldata', importo: 50, importo_pagato: 50, sconto: 0, scadenza: '2026-05-10', stato: 'pagato', tipo: 'singolo' },
    ],
    error: null,
  }
  h.pagamentiRetry = { data: [], error: null }
  h.scuole = { data: [{ id: SC, nome: 'Kidville Alfa' }, { id: SC2, nome: 'Kidville Beta' }], error: null }
  h.alunniErr = null
  h.spErr = null
  h.ticketErr = null
  h.eventi = []
  h.errori = []
})

// Il ramo d'errore di una lettura DB deve lasciare UN logErrore di tipo `db`
// con l'errore PostgREST vero: il catch-all finale (senza `evento`) non conta.
function attendiErroreDb() {
  const db = h.errori.filter((e) => (e[0] as { evento?: string }).evento === 'db')
  expect(db).toHaveLength(1)
  expect(db[0][0]).toMatchObject({ operazione: 'pagamenti/famiglia:GET', stato: 500, evento: 'db' })
  expect(db[0][1]).toMatchObject({ code: '42501' })
}

describe('GET famiglia', () => {
  it('ritorna figli, saldo ticket, credito e voci aperte ordinate per scadenza ASC', async () => {
    const res = await GET(get('parent_id=33333333-3333-4333-8333-333333333333'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.credito).toBe(25)
    expect(j.data.figli).toHaveLength(2)
    const al1 = j.data.figli.find((f: { id: string }) => f.id === AL1)
    expect(al1.saldo_ticket).toBe(8)
    // solo le voci con residuo > 0 (la saldata esclusa), ordinate più vecchie prima
    expect(j.data.voci.map((v: { id: string }) => v.id)).toEqual(['p-old', 'p-new'])
    const old = j.data.voci[0]
    expect(old.residuo).toBe(80)
  })

  it('colonna sconto assente (42703) → retry senza sconto, non 500', async () => {
    h.pagamenti = { data: null, error: { code: '42703' } }
    h.pagamentiRetry = {
      data: [{ id: 'p-old', alunno_id: AL2, descrizione: 'Retta giugno', importo: 100, importo_pagato: 20, scadenza: '2026-06-10', stato: 'da_pagare', tipo: 'singolo' }],
      error: null,
    }
    const res = await GET(get('parent_id=33333333-3333-4333-8333-333333333333'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.voci).toHaveLength(1)
    expect(j.data.voci[0].residuo).toBe(80)
  })

  it('parent_id mancante → 400', async () => {
    const res = await GET(get(''))
    expect(res.status).toBe(400)
  })

  it('genitore inesistente → 404', async () => {
    h.parent = null
    const res = await GET(get('parent_id=33333333-3333-4333-8333-333333333333'))
    expect(res.status).toBe(404)
  })

  it('genitore senza figli → data vuota ma credito presente', async () => {
    h.studentParents = []
    h.figli.mockResolvedValue([])
    const res = await GET(get('parent_id=33333333-3333-4333-8333-333333333333'))
    const j = await res.json()
    expect(j.data.figli).toEqual([])
    expect(j.data.voci).toEqual([])
    expect(j.data.credito).toBe(25)
  })

  it('figli con scuola_id e scuola_nome, voci con scuola_nome (famiglia su due sedi)', async () => {
    h.scope.mockResolvedValue([SC, SC2])
    h.alunni = [
      { id: AL1, nome: 'Uno', cognome: 'Rossi', scuola_id: SC },
      { id: AL2, nome: 'Due', cognome: 'Rossi', scuola_id: SC2 },
    ]
    h.pagamenti = {
      data: [
        { id: 'p-a', alunno_id: AL1, scuola_id: SC, importo: 100, importo_pagato: 0, sconto: 0, scadenza: '2026-06-10', stato: 'da_pagare', tipo: 'singolo' },
        { id: 'p-b', alunno_id: AL2, scuola_id: SC2, importo: 100, importo_pagato: 0, sconto: 0, scadenza: '2026-07-10', stato: 'da_pagare', tipo: 'singolo' },
      ],
      error: null,
    }
    const res = await GET(get('parent_id=33333333-3333-4333-8333-333333333333'))
    expect(res.status).toBe(200)
    const j = await res.json()
    const perId = (id: string) => j.data.figli.find((f: { id: string }) => f.id === id)
    expect(perId(AL1)).toMatchObject({ scuola_id: SC, scuola_nome: 'Kidville Alfa' })
    expect(perId(AL2)).toMatchObject({ scuola_id: SC2, scuola_nome: 'Kidville Beta' })
    expect(j.data.voci.map((v: { id: string; scuola_nome: string }) => [v.id, v.scuola_nome])).toEqual([
      ['p-a', 'Kidville Alfa'],
      ['p-b', 'Kidville Beta'],
    ])
  })

  it('lo scuola_nome della voce è quello della VOCE (pagamenti.scuola_id), non quello del figlio', async () => {
    // Figlio a SC (Alfa), voce registrata su SC2 (Beta), entrambe nello scope:
    // è la sede della voce che decide in quale transazione finirà. Nessun altro
    // figlio o voce sta su SC2, quindi il nome Beta arriva SOLO se la route
    // mette le sedi delle voci nella lettura di `scuole`.
    h.scope.mockResolvedValue([SC, SC2])
    h.figli.mockResolvedValue([AL1])
    h.studentParents = [{ student_id: AL1 }]
    h.alunni = [{ id: AL1, nome: 'Uno', cognome: 'Rossi', scuola_id: SC }]
    h.pagamenti = {
      data: [
        { id: 'p-x', alunno_id: AL1, scuola_id: SC2, importo: 100, importo_pagato: 0, sconto: 0, scadenza: '2026-06-10', stato: 'da_pagare', tipo: 'singolo' },
      ],
      error: null,
    }
    const res = await GET(get('parent_id=33333333-3333-4333-8333-333333333333'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.figli).toHaveLength(1)
    expect(j.data.figli[0]).toMatchObject({ id: AL1, scuola_id: SC, scuola_nome: 'Kidville Alfa' })
    expect(j.data.voci).toHaveLength(1)
    expect(j.data.voci[0]).toMatchObject({ id: 'p-x', scuola_id: SC2, scuola_nome: 'Kidville Beta' })
  })

  it('nomi delle sedi non leggibili ⇒ 200 con scuola_nome null (il nome è un\'etichetta)', async () => {
    h.scuole = { data: null, error: { code: '42501' } }
    const res = await GET(get('parent_id=33333333-3333-4333-8333-333333333333'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.figli[0].scuola_id).toBe(SC)
    expect(j.data.figli[0].scuola_nome).toBeNull()
    // La degradazione è segnalata, una volta, a livello warn, con l'errore vero.
    const warn = h.eventi.filter((e) => (e[2] as { esito?: string }).esito === 'nomi-sede-non-letti')
    expect(warn).toHaveLength(1)
    expect(warn[0][1]).toBe('warn')
    expect(warn[0][3]).toMatchObject({ code: '42501' })
    expect(h.errori).toHaveLength(0)
  })

  it('lettura degli alunni fallita ⇒ 500, mai «nessun figlio»', async () => {
    h.alunniErr = { code: '42501' }
    const res = await GET(get('parent_id=33333333-3333-4333-8333-333333333333'))
    expect(res.status).toBe(500)
    attendiErroreDb()
  })

  it('lettura di student_parents fallita ⇒ 500, mai «nessun figlio»', async () => {
    // I legami via account (getFigliDiGenitore) non bastano a mascherarlo: un
    // genitore SENZA account resterebbe «senza figli» in silenzio.
    h.spErr = { code: '42501' }
    h.parent = { ...(h.parent as Record<string, unknown>), auth_user_id: null }
    const res = await GET(get('parent_id=33333333-3333-4333-8333-333333333333'))
    expect(res.status).toBe(500)
    attendiErroreDb()
  })

  it('lettura di ticket_mensa fallita ⇒ 500, mai un saldo ticket 0 inventato', async () => {
    h.ticketErr = { code: '42501' }
    const res = await GET(get('parent_id=33333333-3333-4333-8333-333333333333'))
    expect(res.status).toBe(500)
    attendiErroreDb()
  })
})
