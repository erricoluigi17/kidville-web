import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

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
// `scuolaUnicaReale` risponde `null` — ed è la VERITÀ di produzione dal
// 2026-07-29: con tre sedi reali la funzione è deprecata e ritorna sempre null.
// Il mock che la faceva rispondere con una sede mascherava il difetto W1
// (richiesta con `scuola_id` NULL, invisibile a ogni Direzione).
vi.mock('@/lib/notifiche/destinatari', () => ({
  staffScuola: vi.fn().mockResolvedValue(['staff-1']),
  scuolaUnicaReale: vi.fn().mockResolvedValue(null),
}))

import { POST as POST_INIT } from '@/app/api/public/cancellazione-account/route'
import { POST as POST_CONF } from '@/app/api/public/cancellazione-account/conferma/route'
import { creaTicketCancellazione } from '@/lib/gdpr/cancellazione-pubblica'
import { createAdminClient } from '@/lib/supabase/server-client'
import { resetRateLimit } from '@/lib/security/rate-limit'

const PARENT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01'
const SCUOLA_ID = SEDE_A

// Il rate-limiter è un Map di modulo condiviso da tutti i test del file: senza
// reset, il budget consumato da un test farebbe fallire il successivo.
const LIMITE_POST = 5

function req(path: string, body: unknown, ip?: string): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      ...(ip ? { 'x-forwarded-for': ip } : {}),
    },
  })
}

function utenteMatch(email = 'genitore@example.com') {
  return { data: [{ id: PARENT_ID, email, scuola_id: SCUOLA_ID }], error: null }
}
const parentAttivo = { data: { id: PARENT_ID, anonimizzato_il: null }, error: null }

beforeEach(() => {
  vi.clearAllMocks()
  resetRateLimit()
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

// =============================================================================
// Rate-limit. Questo endpoint è PUBBLICO (nessun login) e spedisce un'email
// all'indirizzo indicato: senza limite è un'arma di email-bombing verso la
// casella di una famiglia, ripetibile all'infinito. Il limite deve scattare
// PRIMA della risoluzione del genitore — altrimenti la risposta generica
// dell'anti-enumerazione (sempre 200) maschererebbe l'abuso invece di fermarlo.
// Indirizzi IP dai range di documentazione (TEST-NET-2/3): non sono dati reali.
// =============================================================================
describe('POST /api/public/cancellazione-account — rate-limit anti email-bombing', () => {
  const PATH = '/api/public/cancellazione-account'
  const IP_A = '203.0.113.9'
  const IP_B = '198.51.100.7'

  it(`le prime ${LIMITE_POST} richieste dallo stesso IP passano (200 generico)`, async () => {
    for (let i = 0; i < LIMITE_POST; i++) {
      const res = await POST_INIT(req(PATH, { email: 'ignoto@example.com' }, IP_A))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
    }
  })

  it('sotto il limite l’anti-enumerazione resta intatta: email esistente e inesistente → stessa 200', async () => {
    h.state.queues = { utenti: [utenteMatch()], parents: [parentAttivo] }
    const esistente = await POST_INIT(req(PATH, { email: 'genitore@example.com' }, IP_A))
    const inesistente = await POST_INIT(req(PATH, { email: 'ignoto@example.com' }, IP_A))
    expect(esistente.status).toBe(200)
    expect(inesistente.status).toBe(200)
    expect(await esistente.json()).toEqual(await inesistente.json())
  })

  it(`la richiesta ${LIMITE_POST + 1} dallo stesso IP → 429 con Retry-After, senza toccare DB né email`, async () => {
    for (let i = 0; i < LIMITE_POST; i++) {
      await POST_INIT(req(PATH, { email: 'ignoto@example.com' }, IP_A))
    }
    // Azzera i contatori DOPO aver esaurito il budget: quello che segue deve
    // dimostrare che la richiesta in eccesso non esegue NESSUNA logica.
    vi.mocked(createAdminClient).mockClear()
    sendEmail.mockClear()

    const res = await POST_INIT(req(PATH, { email: 'ignoto@example.com' }, IP_A))
    expect(res.status).toBe(429)
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(createAdminClient).not.toHaveBeenCalled() // → né risolviGenitorePerEmail
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('il limite vale anche per un’email ESISTENTE (è il caso che fa male alla famiglia)', async () => {
    h.state.queues = { utenti: [], parents: [] } // code vuote: irrilevante, non si arriva al DB
    for (let i = 0; i < LIMITE_POST; i++) {
      await POST_INIT(req(PATH, { email: 'genitore@example.com' }, IP_A))
    }
    sendEmail.mockClear()
    const res = await POST_INIT(req(PATH, { email: 'genitore@example.com' }, IP_A))
    expect(res.status).toBe(429)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('IP diversi non condividono il contatore', async () => {
    for (let i = 0; i < LIMITE_POST; i++) {
      await POST_INIT(req(PATH, { email: 'ignoto@example.com' }, IP_A))
    }
    expect((await POST_INIT(req(PATH, { email: 'ignoto@example.com' }, IP_A))).status).toBe(429)
    expect((await POST_INIT(req(PATH, { email: 'ignoto@example.com' }, IP_B))).status).toBe(200)
  })

  it('il 429 non menziona OTP (non è quel contesto) ed è in italiano', async () => {
    for (let i = 0; i < LIMITE_POST; i++) {
      await POST_INIT(req(PATH, { email: 'ignoto@example.com' }, IP_A))
    }
    const res = await POST_INIT(req(PATH, { email: 'ignoto@example.com' }, IP_A))
    const body = (await res.json()) as { error?: string }
    expect(res.status).toBe(429)
    expect(body.error).toBe('Troppe richieste. Riprova tra qualche minuto.')
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

// =============================================================================
// W1 sul CANALE PUBBLICO. Stessa catena morta del canale in-app:
// `genitore.scuolaId ?? await scuolaUnicaReale(admin)`. Qui fa anche più danno:
// il genitore che usa il magic-link spesso non ha più l'app, quindi non ha
// nessun altro modo di accorgersi che la sua richiesta non è arrivata a nessuno.
// =============================================================================
describe('POST /api/public/cancellazione-account/conferma — sede della richiesta (W1)', () => {
  const ticketValido = () => creaTicketCancellazione('genitore@example.com')
  const invia = (t: ReturnType<typeof creaTicketCancellazione>) =>
    POST_CONF(
      req('/api/public/cancellazione-account/conferma', {
        email: 'genitore@example.com', code: t.code, expiry: t.expiry, ticket: t.ticket,
      }),
    )

  it('identità senza sede → la sede viene dal FIGLIO, non da scuolaUnicaReale', async () => {
    h.state.queues = {
      otp_ticket_consumati: [{ data: null, error: null }],
      utenti: [{ data: [{ id: PARENT_ID, email: 'genitore@example.com', scuola_id: null }], error: null }],
      parents: [parentAttivo],
      student_parents: [{ data: [{ student_id: 'al-1', alunni: { scuola_id: SEDE_B } }], error: null }],
      richieste_cancellazione: [{ data: { id: 'req-1' }, error: null }],
    }
    const res = await invia(ticketValido())
    expect(res.status).toBe(200)
    const ins = h.state.inserts.find((i) => i.table === 'richieste_cancellazione')
    expect((ins!.value as { scuola_id?: unknown }).scuola_id).toBe(SEDE_B)
  })

  it('MAI una richiesta con scuola_id null: senza sede deducibile si RIFIUTA (422)', async () => {
    h.state.queues = {
      otp_ticket_consumati: [{ data: null, error: null }],
      utenti: [{ data: [{ id: PARENT_ID, email: 'genitore@example.com', scuola_id: null }], error: null }],
      parents: [parentAttivo],
      student_parents: [{ data: [], error: null }],
    }
    const res = await invia(ticketValido())
    expect(res.status).toBe(422)
    expect(h.state.inserts.filter((i) => i.table === 'richieste_cancellazione')).toHaveLength(0)
  })
})
