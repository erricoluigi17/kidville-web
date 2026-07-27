import { describe, it, expect, vi, beforeEach } from 'vitest'

// C5 §2 — GET /api/chat/threads arricchito con `sospensione` per thread.
//  · UNA sola query batched su conversazioni_sospensioni (thread_id IN (...)):
//    NON una query per-thread (niente N+1);
//  · un genitore con due figli in sezioni diverse ha due thread distinti:
//    sospenderne uno NON tocca l'altro (scoping per thread_id);
//  · il `motivo` (testo libero) torna solo a chi ha sospeso, mai all'altra parte.

const PARENT = 'bbbbbbbb-0000-4000-8000-000000000002'
const TEACHER_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const TEACHER_B = 'aaaaaaaa-0000-4000-8000-00000000000b'
const THREAD_A = 'dddddddd-0000-4000-8000-00000000000a'
const THREAD_B = 'dddddddd-0000-4000-8000-00000000000b'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  marcaConsegnati: vi.fn(),
  threads: [] as Record<string, unknown>[],
  sospensioni: [] as Record<string, unknown>[],
  sospIn: null as string[] | null,
  sospFromCount: 0,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/chat/delivered', () => ({ marcaConsegnati: h.marcaConsegnati }))

const adminClient = {
  from(table: string) {
    if (table === 'conversazioni_sospensioni') h.sospFromCount += 1
    const st = { table, head: false }
    const b: Record<string, unknown> = {}
    b.select = (_c?: unknown, o?: { head?: boolean }) => { if (o?.head) st.head = true; return b }
    b.or = () => b
    b.eq = () => b
    b.neq = () => b
    b.order = () => b
    b.limit = () => b
    b.is = () => b
    b.in = (col: string, vals: string[]) => {
      if (table === 'conversazioni_sospensioni' && col === 'thread_id') h.sospIn = vals
      return b
    }
    b.maybeSingle = async () => {
      if (table === 'chat_messages') return { data: null, error: null } // last message
      if (table === 'utenti') return { data: { first_name: 'X', last_name: 'Y', role: 'educator' }, error: null }
      if (table === 'alunni') return { data: { nome: 'N', cognome: 'C', classe_sezione: 'S' }, error: null }
      return { data: null, error: null }
    }
    // Thenable: chat_threads (.order) → lista; conversazioni_sospensioni (.is) →
    // righe attive; chat_messages count (.is + head) → conteggio.
    b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => {
      let result: unknown
      if (table === 'chat_threads') result = { data: h.threads, error: null }
      else if (table === 'conversazioni_sospensioni') result = { data: h.sospensioni, error: null }
      else if (table === 'chat_messages') result = { count: 0, error: null }
      else result = { data: null, error: null }
      return Promise.resolve(result).then(onF, onR)
    }
    return b
  },
}
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => adminClient }))

import { GET } from '@/app/api/chat/threads/route'

const req = () => new Request(`http://localhost/api/chat/threads?userId=${PARENT}`)

beforeEach(() => {
  vi.clearAllMocks()
  h.requireUser.mockResolvedValue({ user: { id: PARENT, role: 'genitore', scuola_id: 'sc-1' } })
  h.marcaConsegnati.mockResolvedValue(undefined)
  h.sospIn = null
  h.sospFromCount = 0
  h.threads = [
    { id: THREAD_A, teacher_id: TEACHER_A, parent_id: PARENT, student_id: 's-a', last_message_at: '2026-07-27T10:00:00Z' },
    { id: THREAD_B, teacher_id: TEACHER_B, parent_id: PARENT, student_id: 's-b', last_message_at: '2026-07-27T09:00:00Z' },
  ]
  // Solo il thread A è sospeso (verso il genitore); B resta libero.
  h.sospensioni = [
    { thread_id: THREAD_A, sospesa_da: TEACHER_A, sospesa_verso: PARENT, motivo: 'MOTIVO_RISERVATO', sospesa_il: '2026-07-27T10:30:00Z' },
  ]
})

describe('GET /api/chat/threads — arricchimento sospensione (batched)', () => {
  it('una sola query batched su conversazioni_sospensioni con tutti i thread_id (no N+1)', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    // La tabella è interrogata UNA volta sola, con l'IN su TUTTI i thread.
    expect(h.sospFromCount).toBe(1)
    expect(h.sospIn).toEqual([THREAD_A, THREAD_B])
  })

  it('scoping per thread: A sospeso, B intatto', async () => {
    const res = await GET(req())
    const body = (await res.json()) as { id: string; sospensione: unknown }[]
    const a = body.find((t) => t.id === THREAD_A)!
    const b = body.find((t) => t.id === THREAD_B)!
    expect(a.sospensione).toMatchObject({ sospesaDa: TEACHER_A, sospesaVerso: PARENT })
    expect(b.sospensione).toBeNull()
  })

  it('il motivo NON torna a chi non ha sospeso (il genitore è sospesa_verso)', async () => {
    const res = await GET(req())
    const body = (await res.json()) as { id: string; sospensione: { motivo: string | null } | null }[]
    const a = body.find((t) => t.id === THREAD_A)!
    expect(a.sospensione?.motivo).toBeNull()
  })

  it('il motivo torna a chi HA sospeso (richiedente = sospesa_da)', async () => {
    h.requireUser.mockResolvedValue({ user: { id: TEACHER_A, role: 'educator', scuola_id: 'sc-1' } })
    h.threads = [{ id: THREAD_A, teacher_id: TEACHER_A, parent_id: PARENT, student_id: 's-a', last_message_at: '2026-07-27T10:00:00Z' }]
    const res = await GET(req())
    const body = (await res.json()) as { id: string; sospensione: { motivo: string | null } | null }[]
    expect(body[0].sospensione?.motivo).toBe('MOTIVO_RISERVATO')
  })
})
