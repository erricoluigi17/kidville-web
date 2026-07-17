import { describe, it, expect, vi, beforeEach } from 'vitest'

// E1 (collaudo giornata 2026-07-17) — Diario 0-6 nota per SINGOLO bambino.
// La nota di sezione (nota_libera) resta broadcast a TUTTI i genitori; la nota
// per-bambino (nota_bambino) è persistita in una colonna dedicata e resa SOLO al
// genitore di quel bambino. Il codice degrada pulito se la colonna non esiste
// (DB E2E CI non migrato): PGRST204 su INSERT/UPDATE, 42703 su SELECT.

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  rows: {} as Record<string, Record<string, unknown>[]>,
  inserted: [] as { table: string; payload: Record<string, unknown> }[],
  updated: [] as { table: string; payload: Record<string, unknown> }[],
  // Se valorizzato, una INSERT/UPDATE che contiene questa chiave torna PGRST204.
  failWriteCol: null as string | null,
  // Se valorizzato, una SELECT il cui elenco colonne contiene questa stringa torna 42703.
  failSelectCol: null as string | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: vi.fn(),
  requireDocente: h.requireDocente,
}))
vi.mock('@/lib/auth/require-parent', () => ({
  requireParentOfStudent: async () => ({ user: { id: 'gen-1', role: 'genitore' } }),
}))
vi.mock('@/lib/auth/scope', () => ({
  assertAlunnoInScope: async () => null,
  resolveScuoleAttive: h.resolveScuoleAttive,
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn() }))
vi.mock('@/lib/primaria/notifiche', () => ({
  notificaTitolariScrittura: vi.fn(),
  enqueueDiarioGenitori: vi.fn(),
}))
vi.mock('@/lib/settings/module-config', () => ({ getModuleConfig: async () => ({}) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(table: string) {
      const rowsOf = () => h.rows[table] ?? []
      let inserted: Record<string, unknown> | null = null
      let updated: Record<string, unknown> | null = null
      let selectCols = ''
      const result = () => {
        if (h.failSelectCol && selectCols.includes(h.failSelectCol)) {
          return {
            data: null,
            error: { code: '42703', message: `column "${h.failSelectCol}" of relation "${table}" does not exist` },
          }
        }
        if (inserted) {
          if (h.failWriteCol && h.failWriteCol in inserted) {
            return {
              data: null,
              error: { code: 'PGRST204', message: `Could not find the '${h.failWriteCol}' column of '${table}' in the schema cache` },
            }
          }
          return { data: [{ id: 'ev-new', alunno_id: inserted.alunno_id, tipo_evento: inserted.tipo_evento }], error: null }
        }
        if (updated) {
          if (h.failWriteCol && h.failWriteCol in updated) {
            return {
              data: null,
              error: { code: 'PGRST204', message: `Could not find the '${h.failWriteCol}' column of '${table}' in the schema cache` },
            }
          }
          const ex = rowsOf()[0] ?? {}
          return { data: [{ id: 'ev-upd', alunno_id: ex.alunno_id ?? null, tipo_evento: ex.tipo_evento ?? null }], error: null }
        }
        return { data: rowsOf(), error: null }
      }
      const b: Record<string, unknown> = {
        maybeSingle: async () => ({ data: rowsOf()[0] ?? null, error: null }),
        single: async () => ({ data: rowsOf()[0] ?? null, error: null }),
        then: (res: (v: { data: unknown; error: unknown }) => unknown) => res(result()),
      }
      const chain = () => b
      b.select = (cols: unknown) => { if (typeof cols === 'string') selectCols = cols; return b }
      b.eq = chain; b.in = chain; b.gte = chain; b.lte = chain; b.order = chain; b.limit = chain
      // Snapshot del payload al momento della chiamata: la route MUTA il record fra
      // un tentativo e l'altro (retry che rimuove la colonna mancante), quindi salvare
      // il riferimento registrerebbe tutti i tentativi con lo stato finale.
      b.insert = (payload: Record<string, unknown>) => { inserted = payload; h.inserted.push({ table, payload: { ...payload } }); return b }
      b.update = (payload: Record<string, unknown>) => { updated = payload; h.updated.push({ table, payload: { ...payload } }); return b }
      b.delete = chain
      return b
    },
  }),
}))

import { GET, POST } from '@/app/api/diary/entries/route'

const ALUNNO_A = '11111111-1111-1111-1111-111111111111'
const ALUNNO_B = '22222222-2222-2222-2222-222222222222'

const getReq = (qs: string) =>
  ({ url: `http://test/api/diary/entries?${qs}`, nextUrl: { searchParams: new URLSearchParams(qs) }, headers: new Headers(), cookies: { get: () => undefined } }) as never
const postReq = (body: unknown) =>
  ({ url: 'http://test/api/diary/entries', json: async () => body, headers: new Headers(), nextUrl: { searchParams: new URLSearchParams() }, cookies: { get: () => undefined } }) as never

const diarioEventi = (table: string) => h.inserted.filter(i => i.table === table)

beforeEach(() => {
  vi.clearAllMocks()
  h.rows = {}
  h.inserted = []
  h.updated = []
  h.failWriteCol = null
  h.failSelectCol = null
  h.requireDocente.mockResolvedValue({ user: { id: 'doc-1', role: 'educator', scuola_id: 'sc-1' } })
  h.resolveScuoleAttive.mockResolvedValue(['sc-1'])
})

describe('POST /api/diary/entries — nota per-bambino', () => {
  it('INSERT: persiste nota_bambino (per singolo) E nota_libera (di sezione)', async () => {
    h.rows['eventi_diario'] = [] // nessun evento oggi → percorso INSERT
    h.rows['alunni'] = [{ section_id: null, scuola_id: 'sc-1' }]
    const res = await POST(postReq([
      { alunno_id: ALUNNO_A, tipo_evento: 'pranzo', dettagli: { corsi: {} }, nota_libera: 'buona giornata a tutti', nota_bambino: 'oggi ha starnutito due volte' },
    ]))
    expect(res.status).toBe(200)
    const rec = diarioEventi('eventi_diario')[0]?.payload
    expect(rec).toMatchObject({
      alunno_id: ALUNNO_A,
      nota_libera: 'buona giornata a tutti',
      nota_bambino: 'oggi ha starnutito due volte',
    })
  })

  it('INSERT: la nota di sezione è identica per tutti, la nota per-bambino no', async () => {
    h.rows['eventi_diario'] = []
    h.rows['alunni'] = [{ section_id: null, scuola_id: 'sc-1' }]
    await POST(postReq([
      { alunno_id: ALUNNO_A, tipo_evento: 'pranzo', dettagli: {}, nota_libera: 'sezione', nota_bambino: 'nota di A' },
      { alunno_id: ALUNNO_B, tipo_evento: 'pranzo', dettagli: {}, nota_libera: 'sezione', nota_bambino: null },
    ]))
    const righe = diarioEventi('eventi_diario')
    const a = righe.find(r => r.payload.alunno_id === ALUNNO_A)?.payload
    const b = righe.find(r => r.payload.alunno_id === ALUNNO_B)?.payload
    expect(a?.nota_libera).toBe('sezione')
    expect(b?.nota_libera).toBe('sezione') // di sezione: replicata a tutti
    expect(a?.nota_bambino).toBe('nota di A')
    expect(b?.nota_bambino).toBeNull() // per-bambino: solo per A, non trapela su B
  })

  it('UPDATE: persiste nota_bambino nel record di aggiornamento', async () => {
    h.rows['eventi_diario'] = [{ id: 'ex-1', alunno_id: ALUNNO_A, tipo_evento: 'pranzo' }] // esiste già oggi → UPDATE
    h.rows['alunni'] = [{ section_id: null, scuola_id: 'sc-1' }]
    const res = await POST(postReq([
      { alunno_id: ALUNNO_A, tipo_evento: 'pranzo', dettagli: {}, nota_libera: 'sez', nota_bambino: 'aggiornata' },
    ]))
    expect(res.status).toBe(200)
    const upd = h.updated.find(u => u.table === 'eventi_diario')?.payload
    expect(upd).toMatchObject({ nota_libera: 'sez', nota_bambino: 'aggiornata' })
  })

  it('degrada pulito se la colonna nota_bambino non esiste (PGRST204 → riprova senza)', async () => {
    h.rows['eventi_diario'] = []
    h.rows['alunni'] = [{ section_id: null, scuola_id: 'sc-1' }]
    h.failWriteCol = 'nota_bambino' // DB E2E CI non migrato
    const res = await POST(postReq([
      { alunno_id: ALUNNO_A, tipo_evento: 'pranzo', dettagli: {}, nota_libera: 'sez', nota_bambino: 'x' },
    ]))
    expect(res.status).toBe(200) // niente 207: l'errore è recuperato dal retry
    const tentativi = diarioEventi('eventi_diario')
    expect(tentativi.length).toBe(2) // primo con la colonna (fallito), secondo senza
    expect('nota_bambino' in tentativi[0].payload).toBe(true)
    expect('nota_bambino' in tentativi[1].payload).toBe(false)
  })
})

describe('GET /api/diary/entries — ramo genitore', () => {
  it('espone sia la nota di sezione (note) sia la nota del proprio bambino (notaBambino)', async () => {
    h.rows['eventi_diario'] = [
      { id: 'e1', tipo_evento: 'pranzo', orario_inizio: '2026-06-27T12:00:00Z', dettagli: {}, nota_libera: 'a tutti', nota_bambino: 'solo per te' },
    ]
    const res = await GET(getReq(`alunno_id=${ALUNNO_A}&from=2026-06-27&to=2026-06-27`))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j[0]).toMatchObject({ tipo_evento: 'pranzo', note: 'a tutti', notaBambino: 'solo per te' })
  })

  it('degrada pulito se la colonna nota_bambino non esiste (42703 → riprova senza)', async () => {
    h.rows['eventi_diario'] = [
      { id: 'e1', tipo_evento: 'pranzo', orario_inizio: '2026-06-27T12:00:00Z', dettagli: {}, nota_libera: 'a tutti' },
    ]
    h.failSelectCol = 'nota_bambino'
    const res = await GET(getReq(`alunno_id=${ALUNNO_A}&from=2026-06-27&to=2026-06-27`))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j[0]).toMatchObject({ note: 'a tutti', notaBambino: null })
  })
})
