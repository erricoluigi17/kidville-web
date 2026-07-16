import { describe, it, expect, vi, beforeEach } from 'vitest'

// P12 — Galleria isolata per sede (fix D3). Copre:
//  (a) POST valorizza scuola_id (sede di scrittura dell'uploader);
//  (b) POST degrada su PGRST204 (colonna assente sul DB E2E CI non migrato);
//  (c) GET docente NON restituisce media di un'altra sede con classe omonima;
//  (d) GET degrada su 42703 (SELECT senza la colonna → retry senza filtro sede);
//  (e) GET genitore vede solo i broadcast della SEDE del figlio.
//
// La galleria è dati di minori: nel mock si verifica l'isolamento per tenant,
// non basta che "compili".

// UUID validi (z.guid: formato 8-4-4-4-12).
const SEDE_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const SEDE_B = 'bbbbbbbb-0000-4000-8000-000000000002'
const ALU_A = 'a1a1a1a1-1111-4111-8111-111111111111'
const ALU_B = 'b2b2b2b2-2222-4222-8222-222222222222'
const CLASSE_OMONIMA = 'Girasoli'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  requireParentOfStudent: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  resolveScuolaScrittura: vi.fn(),
  notificaEvento: vi.fn(),
  logEvento: vi.fn(),
  // Stato del "DB" simulato, riscritto per test in beforeEach/nel test.
  alunniMaster: [] as Array<{ id: string; classe_sezione?: string; scuola_id?: string }>,
  mediaAll: [] as Array<Record<string, unknown>>,
  utente: null as Record<string, unknown> | null,
  media: null as Record<string, unknown> | null,
  legame: null as Record<string, unknown> | null,
  // Iniezione errori per i rami di degrado.
  mediaScuolaError: null as string | null, // '42703' → la SELECT media con filtro sede fallisce
  insertScuolaError: null as string | null, // 'PGRST204' → l'INSERT con scuola_id fallisce
  insertedRows: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: h.requireParentOfStudent }))
vi.mock('@/lib/auth/scope', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/scope')>()),
  resolveScuoleAttive: h.resolveScuoleAttive,
  resolveScuolaScrittura: h.resolveScuolaScrittura,
}))
vi.mock('@/lib/notifiche/triggers', async (orig) => ({
  ...(await orig<typeof import('@/lib/notifiche/triggers')>()),
  notificaEvento: h.notificaEvento,
}))
// Si spia SOLO logEvento (il resto del logger resta reale e silenzioso sotto
// VITEST). Gli eventi di dominio della galleria hanno dominio 'galleria'.
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))

// -----------------------------------------------------------------------------
// Client Supabase simulato: query builder concatenabile + thenable, con stato
// per-query. La differenza rispetto ai mock "piatti" degli altri test: qui il
// filtro `.in('scuola_id', ...)` viene applicato davvero, così l'isolamento per
// sede è verificato e non solo asserito.
// -----------------------------------------------------------------------------
type State = { table: string; filters: Record<string, unknown> }

function resolveList(state: State): { data: unknown[]; error: unknown } {
  if (state.table === 'alunni') {
    let rows = h.alunniMaster.slice()
    if ('classe_sezione' in state.filters) rows = rows.filter((a) => a.classe_sezione === state.filters.classe_sezione)
    if ('classe_sezione__in' in state.filters) {
      const s = new Set(state.filters.classe_sezione__in as string[])
      rows = rows.filter((a) => s.has(a.classe_sezione ?? ''))
    }
    if ('scuola_id' in state.filters) rows = rows.filter((a) => a.scuola_id === state.filters.scuola_id)
    if ('scuola_id__in' in state.filters) {
      const s = new Set(state.filters.scuola_id__in as string[])
      rows = rows.filter((a) => s.has(a.scuola_id ?? ''))
    }
    return { data: rows, error: null }
  }
  // utenti (arricchimento uploader) e legame_genitori_alunni (destinatari): non
  // rilevanti per lo scope, tornano vuoti.
  return { data: [], error: null }
}

function resolveSingle(state: State): { data: unknown; error: unknown } {
  if (state.table === 'alunni') {
    const a = h.alunniMaster.find((x) => x.id === state.filters.id)
    return { data: a ? { scuola_id: a.scuola_id ?? null } : null, error: null }
  }
  if (state.table === 'galleria_media_v2') return { data: h.media, error: null }
  if (state.table === 'utenti') return { data: h.utente, error: null }
  if (state.table === 'legame_genitori_alunni') return { data: h.legame, error: null }
  return { data: null, error: null }
}

function resolveMedia(state: State): { data: unknown[] | null; count: number | null; error: unknown } {
  const hasScuolaFilter = 'scuola_id__in' in state.filters
  // Degrado: la SELECT con il filtro sede fallisce (colonna assente su E2E CI).
  if (hasScuolaFilter && h.mediaScuolaError) {
    return { data: null, count: null, error: { code: h.mediaScuolaError } }
  }
  let rows = h.mediaAll.slice()
  // Isolamento per sede: è il cuore del fix D3. (Le condizioni `.or` broadcast/tag
  // non sono emulate: qui si verifica proprio che il filtro sede escluda il
  // cross-tenant a prescindere dai tag.)
  if (hasScuolaFilter) {
    const allowed = new Set(state.filters.scuola_id__in as string[])
    rows = rows.filter((m) => allowed.has((m.scuola_id as string) ?? ''))
  }
  return { data: rows, count: rows.length, error: null }
}

const adminClient = {
  from(table: string) {
    const state: State = { table, filters: {} }
    const b: Record<string, unknown> = {}
    b.select = () => b
    b.order = () => b
    b.gte = () => b
    b.lte = () => b
    b.or = () => b
    b.not = () => b
    b.eq = (col: string, val: unknown) => {
      state.filters[col] = val
      return b
    }
    b.in = (col: string, vals: unknown) => {
      state.filters[`${col}__in`] = vals
      return b
    }
    b.range = async () => resolveMedia(state)
    b.maybeSingle = async () => resolveSingle(state)
    b.insert = (row: Record<string, unknown>) => {
      h.insertedRows.push(row)
      return {
        select: () => ({
          single: async () => {
            if ('scuola_id' in row && h.insertScuolaError) {
              return { data: null, error: { code: h.insertScuolaError } }
            }
            return { data: { id: 'm1', ...row }, error: null }
          },
        }),
      }
    }
    b.update = (row: Record<string, unknown>) => ({
      eq: () => ({ select: () => ({ single: async () => ({ data: { id: 'm1', ...row }, error: null }) }) }),
    })
    // Thenable: `await query` (liste alunni/utenti/legame terminate con .in/.eq).
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(resolveList(state)).then(res, rej)
    return b
  },
}

vi.mock('@/lib/supabase/server-client', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
  createAdminClient: async () => adminClient,
}))

import { GET, POST } from '@/app/api/gallery/route'

const getReq = (qs: string) => new Request(`http://localhost/api/gallery?${qs}`)
const postReq = (body: unknown) =>
  new Request('http://localhost/api/gallery', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const eventiGalleria = () => h.logEvento.mock.calls.filter((c) => c[0] === 'galleria')
const haDegrado = () =>
  eventiGalleria().some((c) => (c[2] as { esito?: string } | undefined)?.esito === 'degrado-scuola-id-assente')

beforeEach(() => {
  vi.clearAllMocks()
  h.requireDocente.mockResolvedValue({ user: { id: 'ed1', role: 'educator', scuola_id: SEDE_A } })
  h.requireParentOfStudent.mockResolvedValue({ user: { id: 'gen1', role: 'genitore', scuola_id: null } })
  h.resolveScuoleAttive.mockResolvedValue([SEDE_A])
  h.resolveScuolaScrittura.mockResolvedValue({ scuolaId: SEDE_A })
  h.notificaEvento.mockResolvedValue(undefined)
  h.alunniMaster = []
  h.mediaAll = []
  h.utente = { ruolo: 'educator', scuola_id: SEDE_A }
  h.media = null
  h.legame = null
  h.mediaScuolaError = null
  h.insertScuolaError = null
  h.insertedRows = []
})

describe('(a) POST /api/gallery — valorizza scuola_id', () => {
  it('inserisce il media con la scuola_id della sede di scrittura', async () => {
    const res = await POST(postReq({ file_url: 'u1' }))
    expect(res.status).toBe(201)
    expect(h.insertedRows).toHaveLength(1)
    expect(h.insertedRows[0]).toMatchObject({ scuola_id: SEDE_A })
    expect(haDegrado()).toBe(false)
  })
})

describe('(b) POST /api/gallery — degrado su PGRST204 (colonna assente)', () => {
  it('riprova senza scuola_id e pubblica comunque (201 + log info del degrado)', async () => {
    h.insertScuolaError = 'PGRST204'
    const res = await POST(postReq({ file_url: 'u2' }))
    expect(res.status).toBe(201)
    // Primo tentativo con scuola_id, secondo senza.
    expect(h.insertedRows).toHaveLength(2)
    expect(h.insertedRows[0]).toHaveProperty('scuola_id')
    expect(h.insertedRows[1]).not.toHaveProperty('scuola_id')
    // Il degrado è loggato a livello info (non è un errore: DB E2E non migrato).
    const deg = eventiGalleria().filter(
      (c) => (c[2] as { esito?: string })?.esito === 'degrado-scuola-id-assente',
    )
    expect(deg).toHaveLength(1)
    expect(deg[0][1]).toBe('info')
    expect(deg[0][2]).toMatchObject({ operazione: 'gallery:POST' })
  })
})

describe('(c) GET /api/gallery — docente non vede media di un\'altra sede con classe omonima', () => {
  it('restituisce solo i media della sede attiva del docente', async () => {
    // Stessa classe "Girasoli" in due sedi diverse.
    h.alunniMaster = [
      { id: ALU_A, classe_sezione: CLASSE_OMONIMA, scuola_id: SEDE_A },
      { id: ALU_B, classe_sezione: CLASSE_OMONIMA, scuola_id: SEDE_B },
    ]
    h.mediaAll = [
      { id: 'media-A', scuola_id: SEDE_A, is_broadcast: false, tag_students: [ALU_A], uploaded_by: 'ed1' },
      { id: 'media-B', scuola_id: SEDE_B, is_broadcast: false, tag_students: [ALU_B], uploaded_by: 'ed2' },
    ]
    const res = await GET(getReq(`classe=${CLASSE_OMONIMA}`))
    expect(res.status).toBe(200)
    const j = await res.json()
    const ids = (j.media as Array<{ id: string }>).map((m) => m.id)
    expect(ids).toContain('media-A')
    expect(ids).not.toContain('media-B')
    expect(j.total).toBe(1)
  })
})

describe('(d) GET /api/gallery — degrado su 42703 (SELECT senza la colonna)', () => {
  it('riprova senza il filtro sede e continua a servire i media (200 + log info)', async () => {
    h.mediaScuolaError = '42703'
    h.alunniMaster = [{ id: ALU_A, classe_sezione: CLASSE_OMONIMA, scuola_id: SEDE_A }]
    h.mediaAll = [
      { id: 'media-A', scuola_id: SEDE_A, is_broadcast: false, tag_students: [ALU_A], uploaded_by: 'ed1' },
      { id: 'media-B', scuola_id: SEDE_B, is_broadcast: false, tag_students: [ALU_B], uploaded_by: 'ed2' },
    ]
    const res = await GET(getReq(`classe=${CLASSE_OMONIMA}`))
    expect(res.status).toBe(200)
    const j = await res.json()
    // Senza colonna sede il filtro cade: la lettura resta possibile (degrado pulito).
    expect(j.total).toBe(2)
    expect(haDegrado()).toBe(true)
  })
})

describe('(e) GET /api/gallery — genitore vede solo i broadcast della sede del figlio', () => {
  it('esclude i broadcast di un\'altra sede', async () => {
    // Il figlio è nella sede A.
    h.alunniMaster = [{ id: ALU_A, classe_sezione: CLASSE_OMONIMA, scuola_id: SEDE_A }]
    h.mediaAll = [
      { id: 'broadcast-A', scuola_id: SEDE_A, is_broadcast: true, tag_students: [], uploaded_by: 'ed1' },
      { id: 'broadcast-B', scuola_id: SEDE_B, is_broadcast: true, tag_students: [], uploaded_by: 'ed2' },
    ]
    const res = await GET(getReq(`studentId=${ALU_A}`))
    expect(res.status).toBe(200)
    const j = await res.json()
    const ids = (j.media as Array<{ id: string }>).map((m) => m.id)
    expect(ids).toContain('broadcast-A')
    expect(ids).not.toContain('broadcast-B')
    expect(j.total).toBe(1)
  })
})
