import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * S7 — LA LISTA DELLE CONVERSAZIONI COSTA POCHE RICHIESTE, E NON SCRIVE (robustezza 2, sessione 12).
 *
 *  · col riepilogo installato: UNA chiamata `rpc` e UNA lettura delle sospensioni, comunque siano
 *    tante le conversazioni (prima: 3 + 4·N, cioè 151 con 37);
 *  · `p_utente` è l'id del GATE, anche se la query string ne porta un altro;
 *  · nessun UPDATE: la consegna è uscita dalla GET (`POST /api/chat/threads/consegnati`);
 *  · senza riepilogo (`PGRST202`) il percorso di prima, con una riga `info`; con un guasto, lo
 *    stesso percorso con una riga `error`.
 */

const IO = 'bbbbbbbb-0000-4000-8000-000000000c01'
const ALTRO = 'bbbbbbbb-0000-4000-8000-000000000c02'
const DOCENTE = 'aaaaaaaa-0000-4000-8000-000000000c03'
const tid = (n: number) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`
const N = 37

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  marcaConsegnati: vi.fn(),
  logEvento: vi.fn(),
  chiamate: [] as string[],
  argomentiRpc: [] as unknown[],
  rispostaRpc: { data: null, error: null } as { data: unknown; error: unknown },
  threads: [] as Record<string, unknown>[],
  sospensioni: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/chat/delivered', () => ({ marcaConsegnati: h.marcaConsegnati }))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))

const adminClient = {
  rpc(nome: string, argomenti: unknown) {
    h.chiamate.push(`rpc:${nome}`)
    h.argomentiRpc.push(argomenti)
    return Promise.resolve(h.rispostaRpc)
  },
  from(table: string) {
    h.chiamate.push(`from:${table}`)
    const b: Record<string, unknown> = {}
    for (const nome of ['select', 'or', 'eq', 'neq', 'order', 'limit', 'is', 'in']) b[nome] = () => b
    b.update = () => {
      h.chiamate.push(`update:${table}`)
      return b
    }
    b.maybeSingle = async () => ({ data: null, error: null })
    b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
      let esito: unknown = { data: null, error: null }
      if (table === 'chat_threads') esito = { data: h.threads, error: null }
      else if (table === 'conversazioni_sospensioni') esito = { data: h.sospensioni, error: null }
      else if (table === 'chat_messages') esito = { count: 0, error: null }
      return Promise.resolve(esito).then(ok, ko)
    }
    return b
  },
}
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => adminClient }))

import { GET } from '@/app/api/chat/threads/route'

const richiesta = (query = '') => new Request(`http://localhost/api/chat/threads${query}`)

const rigaRiepilogo = (n: number) => ({
  id: tid(n),
  teacher_id: DOCENTE,
  parent_id: IO,
  student_id: null,
  last_message_at: null,
  other_user: { first_name: 'A', last_name: 'B', role: 'teacher' },
  student: { nome: '?', cognome: '?', classe_sezione: '?' },
  last_message: null,
  unread_count: n % 3,
})

const rigaThread = (n: number) => ({ id: tid(n), teacher_id: DOCENTE, parent_id: IO, student_id: null, last_message_at: null })

beforeEach(() => {
  vi.clearAllMocks()
  h.chiamate = []
  h.argomentiRpc = []
  h.sospensioni = []
  h.threads = Array.from({ length: N }, (_, i) => rigaThread(i + 1))
  h.rispostaRpc = { data: Array.from({ length: N }, (_, i) => rigaRiepilogo(i + 1)), error: null }
  h.requireUser.mockResolvedValue({ user: { id: IO, role: 'genitore', scuola_id: 'sc-1' } })
  h.marcaConsegnati.mockResolvedValue({ esito: 'ok', n: 0 })
})

describe('GET /api/chat/threads — col riepilogo', () => {
  it(`${N} conversazioni: una rpc e una lettura delle sospensioni, cioè ≤ 5 richieste`, async () => {
    const res = await GET(richiesta())
    expect(res.status).toBe(200)
    const corpo = (await res.json()) as Array<Record<string, unknown>>
    expect(corpo).toHaveLength(N)
    expect(h.chiamate).toEqual(['rpc:chat_riepilogo_conversazioni', 'from:conversazioni_sospensioni'])
    expect(h.chiamate.length).toBeLessThanOrEqual(5)
    expect(corpo[1]).toMatchObject({ id: tid(2), unread_count: 2, sospensione: null })
  })

  it('p_utente è l’id del gate, anche con `?userId=` di un altro', async () => {
    await GET(richiesta(`?userId=${ALTRO}`))
    expect(h.argomentiRpc).toEqual([{ p_utente: IO }])
    expect(JSON.stringify(h.argomentiRpc)).not.toContain(ALTRO)
  })

  it('nessun UPDATE e nessuna consegna: la GET non scrive più', async () => {
    await GET(richiesta())
    expect(h.chiamate.some((c) => c.startsWith('update:'))).toBe(false)
    expect(h.marcaConsegnati).not.toHaveBeenCalled()
  })

  it('il motivo della sospensione torna solo a chi ha sospeso', async () => {
    h.sospensioni = [
      { thread_id: tid(1), sospesa_da: IO, sospesa_verso: DOCENTE, motivo: 'motivo finto', sospesa_il: '2026-10-20T08:00:00Z' },
      { thread_id: tid(2), sospesa_da: DOCENTE, sospesa_verso: IO, motivo: 'motivo finto', sospesa_il: '2026-10-20T08:00:00Z' },
    ]
    const corpo = (await (await GET(richiesta())).json()) as Array<{ sospensione: { motivo: string | null } | null }>
    expect(corpo[0].sospensione?.motivo).toBe('motivo finto')
    expect(corpo[1].sospensione?.motivo).toBeNull()
    expect(corpo[2].sospensione).toBeNull()
  })
})

describe('GET /api/chat/threads — senza riepilogo, il percorso di prima', () => {
  it('PGRST202: le letture di prima (2 + 4·N = 150), una riga `info`, e ancora nessun UPDATE', async () => {
    h.rispostaRpc = { data: null, error: { code: 'PGRST202', message: 'funzione assente' } }
    const res = await GET(richiesta())
    expect(res.status).toBe(200)
    expect((await res.json()) as unknown[]).toHaveLength(N)
    expect(h.chiamate.filter((c) => c.startsWith('from:'))).toHaveLength(2 + 4 * N)
    expect(h.chiamate.some((c) => c.startsWith('update:'))).toBe(false)
    expect(h.marcaConsegnati).not.toHaveBeenCalled()
    expect(h.logEvento).toHaveBeenCalledWith('chat', 'info', expect.objectContaining({
      esito: 'riepilogo-non-installato', error_code: 'PGRST202', ripiego: true,
    }))
  })

  it('un guasto della RPC (57014): riga `error` con l’errore, e la lista arriva lo stesso', async () => {
    const errore = { code: '57014', message: 'canceling statement due to statement timeout' }
    h.rispostaRpc = { data: null, error: errore }
    const res = await GET(richiesta())
    expect(res.status).toBe(200)
    expect((await res.json()) as unknown[]).toHaveLength(N)
    expect(h.logEvento).toHaveBeenCalledWith('chat', 'error', expect.objectContaining({ esito: 'riepilogo-rpc-fallito' }), errore)
  })

  it('una risposta di forma inattesa: riga `error`, e la lista arriva lo stesso', async () => {
    h.rispostaRpc = { data: { non: 'una lista' }, error: null }
    const res = await GET(richiesta())
    expect(res.status).toBe(200)
    expect(h.logEvento).toHaveBeenCalledWith('chat', 'error', expect.objectContaining({ esito: 'riepilogo-forma-inattesa' }))
  })
})
