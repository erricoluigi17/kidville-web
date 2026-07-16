import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// CICLO 2 — chiusura falle di sicurezza sulle route chat (dati/PII di minori):
//  · GET  /api/chat/messages   — gate identità in testa + verifica partecipante SEMPRE
//    (prima annidata in `if (markRead)`: senza markRead un non-partecipante vedeva
//    tutti i messaggi del thread → IDOR).
//  · POST /api/chat/messages   — gate + sender_id dal gate (mai dal body → impersonazione)
//    + il mittente deve essere partecipante del thread.
//  · PATCH /api/chat/messages/read — gate + userId dal gate (mai dal body) + i messageIds
//    si limitano ai thread di cui l'utente è partecipante (anti-IDOR su read_at altrui).

// UUID validi (formato 8-4-4-4-12, versione 4, variante 8).
const TEACHER = 'aaaaaaaa-0000-4000-8000-000000000001'
const PARENT = 'bbbbbbbb-0000-4000-8000-000000000002'
const OUTSIDER = 'cccccccc-0000-4000-8000-000000000003'
const THREAD = 'dddddddd-0000-4000-8000-000000000004'
const THREAD_ALTRUI = 'dddddddd-0000-4000-8000-000000000099'
const M1 = 'eeeeeeee-0000-4000-8000-000000000005'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  marcaConsegnati: vi.fn(),
  controparteThread: vi.fn(),
  nomeUtente: vi.fn(),
  notificaEvento: vi.fn(),
  logEvento: vi.fn(),
  // Stato del "DB" simulato.
  thread: null as Record<string, unknown> | null, // riga chat_threads per maybeSingle (GET/POST)
  threadErr: null as unknown, // errore sul load del thread singolo
  messages: [] as Array<Record<string, unknown>>, // lista messaggi (GET .range)
  msgs: [] as Array<Record<string, unknown>>, // {id, thread_id} per PATCH
  threadRows: [] as Array<Record<string, unknown>>, // {id, teacher_id, parent_id} per PATCH
  insertedMessage: null as Record<string, unknown> | null,
  insertErr: null as unknown,
  readUpdateRuns: [] as Array<{ row: Record<string, unknown>; filters: Record<string, unknown> }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/chat/delivered', () => ({ marcaConsegnati: h.marcaConsegnati }))
vi.mock('@/lib/notifiche/destinatari', () => ({ controparteThread: h.controparteThread }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento, nomeUtente: h.nomeUtente }))
// Si spia SOLO logEvento; il resto del logger resta reale e silenzioso sotto vitest.
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))

// -----------------------------------------------------------------------------
// Client Supabase simulato. Distingue i terminali:
//  · maybeSingle → riga singola (chat_threads / utenti)
//  · range       → lista messaggi (GET)
//  · insert().select().single() → messaggio inserito (cattura sender_id)
//  · update()....then → esito UPDATE (cattura il read_at + i filtri)
//  · then (select-list) → chat_messages (msgs) / chat_threads (threadRows) per la PATCH
// -----------------------------------------------------------------------------
const adminClient = {
  from(table: string) {
    const state: { table: string; filters: Record<string, unknown> } = { table, filters: {} }
    const b: Record<string, unknown> = {}
    b.select = () => b
    b.order = () => b
    b.eq = (col: string, val: unknown) => { state.filters[col] = val; return b }
    b.in = (col: string, val: unknown) => { state.filters[col] = val; return b }
    b.maybeSingle = async () => {
      if (table === 'chat_threads') return { data: h.thread, error: h.threadErr }
      if (table === 'utenti') return { data: { scuola_id: 'sc-1' }, error: null }
      return { data: null, error: null }
    }
    b.range = async () => ({ data: h.messages, count: h.messages.length, error: null })
    b.insert = (row: Record<string, unknown>) => {
      h.insertedMessage = { id: 'msg-new', ...row }
      return { select: () => ({ single: async () => ({ data: h.insertedMessage, error: h.insertErr }) }) }
    }
    b.update = (row: Record<string, unknown>) => {
      // `state.filters` è mutato dai filtri concatenati DOPO update(): lo condivido per
      // riferimento così, al termine della catena, porta anche `.in('id', …)` della PATCH.
      if (table === 'chat_messages' && 'read_at' in row) {
        h.readUpdateRuns.push({ row, filters: state.filters })
      }
      const ub: Record<string, unknown> = {}
      ub.eq = () => ub
      ub.neq = () => ub
      ub.is = () => ub
      ub.in = (col: string, val: unknown) => { state.filters[col] = val; return ub }
      ub.then = (res: (v: unknown) => void) => res({ error: null })
      return ub
    }
    b.then = (res: (v: unknown) => void) => {
      if (table === 'chat_messages') return res({ data: h.msgs, error: null })
      if (table === 'chat_threads') return res({ data: h.threadRows, error: null })
      return res({ data: [], error: null })
    }
    return b
  },
}

vi.mock('@/lib/supabase/server-client', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
  createAdminClient: async () => adminClient,
}))

import { GET, POST } from '@/app/api/chat/messages/route'
import { PATCH } from '@/app/api/chat/messages/read/route'

const getReq = (qs: string) => new Request(`http://localhost/api/chat/messages?${qs}`)
const postReq = (body: unknown) =>
  new Request('http://localhost/api/chat/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const patchReq = (body: unknown) =>
  new Request('http://localhost/api/chat/messages/read', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const nega401 = () => ({ response: NextResponse.json({ error: 'Non autenticato: userId mancante' }, { status: 401 }) })

beforeEach(() => {
  vi.clearAllMocks()
  // Default: partecipante autenticato = il teacher del thread.
  h.requireUser.mockResolvedValue({ user: { id: TEACHER, role: 'educator', scuola_id: 'sc-1' } })
  h.marcaConsegnati.mockResolvedValue(undefined)
  h.controparteThread.mockResolvedValue(null) // niente notifica → POST resta isolato
  h.nomeUtente.mockResolvedValue(null)
  h.notificaEvento.mockResolvedValue(undefined)
  h.thread = { teacher_id: TEACHER, parent_id: PARENT }
  h.threadErr = null
  h.messages = [{ id: M1, thread_id: THREAD, sender_id: PARENT, content: 'ciao', read_at: null }]
  h.msgs = [{ id: M1, thread_id: THREAD }]
  h.threadRows = [{ id: THREAD, teacher_id: TEACHER, parent_id: PARENT }]
  h.insertedMessage = null
  h.insertErr = null
  h.readUpdateRuns = []
})

describe('GET /api/chat/messages — gate identità + verifica partecipante SEMPRE', () => {
  it('401 anonimo (gate nega) — anche senza markRead', async () => {
    h.requireUser.mockResolvedValue(nega401())
    const res = await GET(getReq(`threadId=${THREAD}`))
    expect(res.status).toBe(401)
  })

  it('403 utente autenticato NON partecipante (IDOR sventato) — senza markRead', async () => {
    h.requireUser.mockResolvedValue({ user: { id: OUTSIDER, role: 'genitore' } })
    const res = await GET(getReq(`threadId=${THREAD}`))
    expect(res.status).toBe(403)
    // Non torna i messaggi del thread.
    const j = await res.json()
    expect(j.messages).toBeUndefined()
    // Segnale di sicurezza loggato (solo uuid, nessun PII).
    const evt = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'non-partecipante',
    )
    expect(evt).toBeTruthy()
    expect(evt?.[2]).toMatchObject({ threadId: THREAD })
  })

  it('404 se il thread non esiste', async () => {
    h.thread = null
    const res = await GET(getReq(`threadId=${THREAD}`))
    expect(res.status).toBe(404)
  })

  it('200 partecipante (teacher): restituisce i messaggi', async () => {
    const res = await GET(getReq(`threadId=${THREAD}`))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.total).toBe(1)
    expect((j.messages as Array<{ id: string }>)[0].id).toBe(M1)
  })

  it('markRead: identità dal gate, non dal valore in query (mark-read per il partecipante)', async () => {
    // Il valore di markRead è OUTSIDER, ma l'identità reale è il PARENT (gate).
    h.requireUser.mockResolvedValue({ user: { id: PARENT, role: 'genitore' } })
    const res = await GET(getReq(`threadId=${THREAD}&markRead=${OUTSIDER}`))
    expect(res.status).toBe(200)
    // La consegna deriva dal gate (PARENT), mai da OUTSIDER.
    expect(h.marcaConsegnati).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: PARENT, threadIds: [THREAD] }),
    )
    // Un update di mark-read è partito (read_at, senza toccare delivered_at).
    expect(h.readUpdateRuns.length).toBe(1)
    expect(h.readUpdateRuns[0].row).toHaveProperty('read_at')
    expect(h.readUpdateRuns[0].row).not.toHaveProperty('delivered_at')
  })
})

describe('POST /api/chat/messages — sender dal gate + partecipante', () => {
  it('201 partecipante: sender_id forzato dal gate, IGNORANDO il body', async () => {
    // Il body dichiara sender_id = OUTSIDER, ma il gate è il TEACHER.
    const res = await POST(postReq({ thread_id: THREAD, sender_id: OUTSIDER, content: 'ciao' }))
    expect(res.status).toBe(201)
    expect(h.insertedMessage).toMatchObject({ sender_id: TEACHER, thread_id: THREAD })
    // MAI il valore del body.
    expect(h.insertedMessage?.sender_id).not.toBe(OUTSIDER)
  })

  it('403 utente autenticato NON partecipante: niente insert', async () => {
    h.requireUser.mockResolvedValue({ user: { id: OUTSIDER, role: 'genitore' } })
    const res = await POST(postReq({ thread_id: THREAD, content: 'intruso' }))
    expect(res.status).toBe(403)
    expect(h.insertedMessage).toBeNull()
  })

  it('404 se il thread non esiste: niente insert', async () => {
    h.thread = null
    const res = await POST(postReq({ thread_id: THREAD, content: 'ciao' }))
    expect(res.status).toBe(404)
    expect(h.insertedMessage).toBeNull()
  })

  it('401 anonimo (gate nega): niente insert', async () => {
    h.requireUser.mockResolvedValue(nega401())
    const res = await POST(postReq({ thread_id: THREAD, content: 'ciao' }))
    expect(res.status).toBe(401)
    expect(h.insertedMessage).toBeNull()
  })

  it('201 anche senza sender_id nel body (schema tollerante)', async () => {
    const res = await POST(postReq({ thread_id: THREAD, content: 'ok' }))
    expect(res.status).toBe(201)
    expect(h.insertedMessage).toMatchObject({ sender_id: TEACHER })
  })
})

describe('PATCH /api/chat/messages/read — userId dal gate + anti-IDOR sui thread altrui', () => {
  it('usa auth.user.id (non il body) e marca i messaggi del proprio thread', async () => {
    h.requireUser.mockResolvedValue({ user: { id: PARENT, role: 'genitore' } })
    const res = await PATCH(patchReq({ messageIds: [M1], userId: OUTSIDER }))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.updated).toBe(1)
    // L'UPDATE è stato eseguito e limitato all'id ammesso.
    expect(h.readUpdateRuns.length).toBe(1)
    expect(h.readUpdateRuns[0].filters).toMatchObject({ id: [M1] })
    // La consegna deriva dal gate (PARENT), mai da OUTSIDER del body.
    expect(h.marcaConsegnati).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: PARENT, messageIds: [M1] }),
    )
  })

  it('anti-IDOR: messageIds di un thread NON dell\'utente → updated 0, nessun UPDATE', async () => {
    // Il messaggio appartiene a un thread di cui l'utente autenticato non è parte.
    h.msgs = [{ id: M1, thread_id: THREAD_ALTRUI }]
    h.threadRows = [{ id: THREAD_ALTRUI, teacher_id: 'ffffffff-0000-4000-8000-0000000000aa', parent_id: 'ffffffff-0000-4000-8000-0000000000bb' }]
    const res = await PATCH(patchReq({ messageIds: [M1] }))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.updated).toBe(0)
    expect(h.readUpdateRuns.length).toBe(0)
    expect(h.marcaConsegnati).not.toHaveBeenCalled()
  })

  it('401 anonimo (gate nega): nessun UPDATE', async () => {
    h.requireUser.mockResolvedValue(nega401())
    const res = await PATCH(patchReq({ messageIds: [M1] }))
    expect(res.status).toBe(401)
    expect(h.readUpdateRuns.length).toBe(0)
  })
})
