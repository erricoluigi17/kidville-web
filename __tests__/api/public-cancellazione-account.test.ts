import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// Cancellazione account via risorsa web PUBBLICA (C5 §1). Due route:
//  - POST /api/public/cancellazione-account          → sempre 200 generico
//  - POST /api/public/cancellazione-account/conferma → verifica+consuma ticket,
//                                                       inserisce pending
// La pagina di CONFERMA (GET) non deve mutare nulla: test dedicato più sotto.
// =============================================================================

const h = vi.hoisted(() => {
  const state = {
    queues: {} as Record<string, Array<{ data: unknown; error: unknown }>>,
    used: {} as Record<string, number>,
    inserts: [] as Array<{ table: string; value: unknown }>,
  }
  function take(table: string) {
    const q = state.queues[table] || []
    const i = state.used[table] ?? 0
    state.used[table] = i + 1
    return q[i] ?? { data: null, error: null }
  }
  function makeClient() {
    return {
      from(table: string) {
        const qb: Record<string, unknown> = {}
        for (const m of ['select', 'ilike', 'eq', 'order', 'limit', 'in']) qb[m] = () => qb
        qb.insert = (v: unknown) => { state.inserts.push({ table, value: v }); return qb }
        qb.maybeSingle = () => Promise.resolve(take(table))
        qb.single = () => Promise.resolve(take(table))
        qb.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(take(table)).then(res, rej)
        return qb
      },
    }
  }
  return { state, makeClient }
})

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn().mockResolvedValue(h.makeClient()),
}))
const sendEmail = vi.fn().mockResolvedValue(true)
vi.mock('@/lib/email/send', () => ({ sendEmail: (...a: unknown[]) => sendEmail(...a) }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/notifiche/destinatari', () => ({
  staffScuola: vi.fn().mockResolvedValue(['staff-1']),
  scuolaUnicaReale: vi.fn().mockResolvedValue('d53b0fbc-a9eb-4073-b302-73d1d5abd529'),
}))

import { POST as POST_INIT } from '@/app/api/public/cancellazione-account/route'
import { POST as POST_CONF } from '@/app/api/public/cancellazione-account/conferma/route'
import { creaTicketCancellazione } from '@/lib/gdpr/cancellazione-pubblica'

const PARENT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01'
const SCUOLA_ID = 'd53b0fbc-a9eb-4073-b302-73d1d5abd529'

function req(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

function utenteMatch(email = 'genitore@example.com') {
  return { data: [{ id: PARENT_ID, email, scuola_id: SCUOLA_ID }], error: null }
}
const parentAttivo = { data: { id: PARENT_ID, anonimizzato_il: null }, error: null }

beforeEach(() => {
  vi.clearAllMocks()
  h.state.queues = {}
  h.state.used = {}
  h.state.inserts = []
})

describe('POST /api/public/cancellazione-account — risposta generica (anti-enumerazione)', () => {
  it('email associata a un genitore → 200 generico e invia il magic-link', async () => {
    h.state.queues = { utenti: [utenteMatch()], parents: [parentAttivo] }
    const res = await POST_INIT(req('/api/public/cancellazione-account', { email: 'genitore@example.com' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(sendEmail).toHaveBeenCalledTimes(1)
  })

  it('email NON associata → STESSA risposta 200 generica, nessuna email inviata', async () => {
    h.state.queues = { utenti: [{ data: [], error: null }] }
    const res = await POST_INIT(req('/api/public/cancellazione-account', { email: 'ignoto@example.com' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('non registra MAI una richiesta al POST iniziale (solo dopo conferma)', async () => {
    h.state.queues = { utenti: [utenteMatch()], parents: [parentAttivo] }
    await POST_INIT(req('/api/public/cancellazione-account', { email: 'genitore@example.com' }))
    expect(h.state.inserts.filter((i) => i.table === 'richieste_cancellazione')).toHaveLength(0)
  })

  it('email non valida → 400 (zod)', async () => {
    const res = await POST_INIT(req('/api/public/cancellazione-account', { email: 'non-una-email' }))
    expect(res.status).toBe(400)
    expect(sendEmail).not.toHaveBeenCalled()
  })
})

describe('POST /api/public/cancellazione-account/conferma — verifica ticket e insert pending', () => {
  it('ticket valido → 200 e crea la richiesta pending con canale=pubblico_email', async () => {
    const t = creaTicketCancellazione('genitore@example.com')
    h.state.queues = {
      otp_ticket_consumati: [{ data: null, error: null }], // consumo ok (ticket fresco)
      utenti: [utenteMatch()],
      parents: [parentAttivo],
      richieste_cancellazione: [{ data: { id: 'req-1' }, error: null }],
    }
    const res = await POST_CONF(
      req('/api/public/cancellazione-account/conferma', {
        email: 'genitore@example.com', code: t.code, expiry: t.expiry, ticket: t.ticket,
      }),
    )
    expect(res.status).toBe(200)
    const ins = h.state.inserts.find((i) => i.table === 'richieste_cancellazione')
    expect(ins).toBeTruthy()
    expect(ins!.value).toMatchObject({ parent_id: PARENT_ID, stato: 'pending', canale: 'pubblico_email' })
  })

  it('ticket SCADUTO → 400, nessun insert', async () => {
    // expiry nel passato: verifyTicket rifiuta prima di toccare il DB
    const past = Date.now() - 60 * 1000
    const t = creaTicketCancellazione('genitore@example.com', past - 60 * 60 * 1000)
    const res = await POST_CONF(
      req('/api/public/cancellazione-account/conferma', {
        email: 'genitore@example.com', code: t.code, expiry: past, ticket: t.ticket,
      }),
    )
    expect(res.status).toBe(400)
    expect(h.state.inserts.filter((i) => i.table === 'richieste_cancellazione')).toHaveLength(0)
  })

  it('ticket manomesso (email diversa) → 400', async () => {
    const t = creaTicketCancellazione('genitore@example.com')
    const res = await POST_CONF(
      req('/api/public/cancellazione-account/conferma', {
        email: 'attaccante@example.com', code: t.code, expiry: t.expiry, ticket: t.ticket,
      }),
    )
    expect(res.status).toBe(400)
    expect(h.state.inserts).toHaveLength(0)
  })

  it('ticket GIÀ consumato (replay) → 409, nessun insert richiesta', async () => {
    const t = creaTicketCancellazione('genitore@example.com')
    h.state.queues = {
      otp_ticket_consumati: [{ data: null, error: { code: '23505' } }], // jti già presente
    }
    const res = await POST_CONF(
      req('/api/public/cancellazione-account/conferma', {
        email: 'genitore@example.com', code: t.code, expiry: t.expiry, ticket: t.ticket,
      }),
    )
    expect(res.status).toBe(409)
    expect(h.state.inserts.filter((i) => i.table === 'richieste_cancellazione')).toHaveLength(0)
  })

  it('email non più associata a un genitore → 404, nessun insert', async () => {
    const t = creaTicketCancellazione('genitore@example.com')
    h.state.queues = {
      otp_ticket_consumati: [{ data: null, error: null }],
      utenti: [{ data: [], error: null }],
    }
    const res = await POST_CONF(
      req('/api/public/cancellazione-account/conferma', {
        email: 'genitore@example.com', code: t.code, expiry: t.expiry, ticket: t.ticket,
      }),
    )
    expect(res.status).toBe(404)
    expect(h.state.inserts.filter((i) => i.table === 'richieste_cancellazione')).toHaveLength(0)
  })

  it('richiesta pending già esistente (indice unico → 23505) → 409', async () => {
    const t = creaTicketCancellazione('genitore@example.com')
    h.state.queues = {
      otp_ticket_consumati: [{ data: null, error: null }],
      utenti: [utenteMatch()],
      parents: [parentAttivo],
      richieste_cancellazione: [{ data: null, error: { code: '23505' } }],
    }
    const res = await POST_CONF(
      req('/api/public/cancellazione-account/conferma', {
        email: 'genitore@example.com', code: t.code, expiry: t.expiry, ticket: t.ticket,
      }),
    )
    expect(res.status).toBe(409)
  })
})
