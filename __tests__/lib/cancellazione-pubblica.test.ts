import { describe, it, expect } from 'vitest'
import { SEDE_A } from '../fixtures/sedi'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  creaTicketCancellazione,
  costruisciLinkConferma,
  risolviGenitorePerEmail,
} from '@/lib/gdpr/cancellazione-pubblica'
import { verifyTicket } from '@/lib/auth/otp-ticket'

// Mock minimale di un client PostgREST: una coda di risultati per tabella,
// consumata dai terminali `.then`/`.maybeSingle`. Tutti i metodi di catena
// (select/ilike/eq/limit) sono chainable.
function makeClient(queues: Record<string, Array<{ data: unknown; error: unknown }>>): SupabaseClient {
  const used: Record<string, number> = {}
  const take = (table: string) => {
    const q = queues[table] || []
    const i = used[table] ?? 0
    used[table] = i + 1
    return q[i] ?? { data: null, error: null }
  }
  return {
    from(table: string) {
      const qb: Record<string, unknown> = {}
      for (const m of ['select', 'ilike', 'eq', 'limit', 'order', 'in']) qb[m] = () => qb
      qb.maybeSingle = () => Promise.resolve(take(table))
      qb.single = () => Promise.resolve(take(table))
      qb.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(take(table)).then(res, rej)
      return qb
    },
  } as unknown as SupabaseClient
}

const PARENT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01'
const SCUOLA_ID = SEDE_A

describe('creaTicketCancellazione + verifyTicket (round-trip)', () => {
  it('produce un ticket accettato da verifyTicket per la stessa email', () => {
    const email = 'genitore@example.com'
    const { code, expiry, ticket } = creaTicketCancellazione(email)
    expect(expiry).toBeGreaterThan(Date.now())
    expect(verifyTicket(email, code, expiry, ticket)).toEqual({ ok: true })
  })

  it('il ticket NON è valido per un\'altra email (email firmata nell\'HMAC)', () => {
    const { code, expiry, ticket } = creaTicketCancellazione('genitore@example.com')
    const v = verifyTicket('altro@example.com', code, expiry, ticket)
    expect(v.ok).toBe(false)
  })

  it('un ticket scaduto viene rifiutato da verifyTicket', () => {
    const email = 'genitore@example.com'
    // expiry nel passato → verifyTicket deve segnalare scadenza
    const past = Date.now() - 1000
    const { ticket } = creaTicketCancellazione(email, past - 60 * 60 * 1000)
    // ricalcolo un ticket coerente con expiry passato
    const scaduto = creaTicketCancellazione(email, past - 60 * 60 * 1000)
    const v = verifyTicket(email, scaduto.code, past, scaduto.ticket)
    expect(v.ok).toBe(false)
    void ticket
  })
})

describe('costruisciLinkConferma', () => {
  it('costruisce un URL /cancellazione-account/conferma con tutti i parametri', () => {
    const link = costruisciLinkConferma({
      baseUrl: 'https://app.kidville.it',
      email: 'genitore@example.com',
      code: 'abc123',
      expiry: 1234567890,
      ticket: 'deadbeef',
    })
    const u = new URL(link)
    expect(u.pathname).toBe('/cancellazione-account/conferma')
    expect(u.searchParams.get('email')).toBe('genitore@example.com')
    expect(u.searchParams.get('code')).toBe('abc123')
    expect(u.searchParams.get('expiry')).toBe('1234567890')
    expect(u.searchParams.get('ticket')).toBe('deadbeef')
  })
})

describe('risolviGenitorePerEmail', () => {
  it('ritorna il genitore per un\'email che corrisponde a un parent non anonimizzato', async () => {
    const client = makeClient({
      utenti: [{ data: [{ id: PARENT_ID, email: 'genitore@example.com', scuola_id: SCUOLA_ID }], error: null }],
      parents: [{ data: { id: PARENT_ID, anonimizzato_il: null }, error: null }],
    })
    const r = await risolviGenitorePerEmail(client, 'genitore@example.com')
    expect(r.error).toBeNull()
    expect(r.genitore).toEqual({ parentId: PARENT_ID, scuolaId: SCUOLA_ID })
  })

  it('è case-insensitive: input in maiuscolo trova l\'utente registrato in minuscolo', async () => {
    const client = makeClient({
      utenti: [{ data: [{ id: PARENT_ID, email: 'genitore@example.com', scuola_id: SCUOLA_ID }], error: null }],
      parents: [{ data: { id: PARENT_ID, anonimizzato_il: null }, error: null }],
    })
    const r = await risolviGenitorePerEmail(client, 'Genitore@Example.COM')
    expect(r.genitore?.parentId).toBe(PARENT_ID)
  })

  it('ritorna null se nessun utente combacia', async () => {
    const client = makeClient({ utenti: [{ data: [], error: null }] })
    const r = await risolviGenitorePerEmail(client, 'ignoto@example.com')
    expect(r).toEqual({ genitore: null, error: null })
  })

  it('ritorna null se l\'utente non è un genitore (nessuna riga parents)', async () => {
    const client = makeClient({
      utenti: [{ data: [{ id: PARENT_ID, email: 'staff@example.com', scuola_id: SCUOLA_ID }], error: null }],
      parents: [{ data: null, error: null }],
    })
    const r = await risolviGenitorePerEmail(client, 'staff@example.com')
    expect(r).toEqual({ genitore: null, error: null })
  })

  it('ritorna null se il genitore è già anonimizzato', async () => {
    const client = makeClient({
      utenti: [{ data: [{ id: PARENT_ID, email: 'ex@example.com', scuola_id: SCUOLA_ID }], error: null }],
      parents: [{ data: { id: PARENT_ID, anonimizzato_il: '2026-01-01T00:00:00Z' }, error: null }],
    })
    const r = await risolviGenitorePerEmail(client, 'ex@example.com')
    expect(r).toEqual({ genitore: null, error: null })
  })

  it('degrada a null (nessun errore) se lo schema è assente (DB E2E non migrato)', async () => {
    const client = makeClient({ utenti: [{ data: null, error: { code: '42P01' } }] })
    const r = await risolviGenitorePerEmail(client, 'x@example.com')
    expect(r).toEqual({ genitore: null, error: null })
  })

  it('propaga un errore DB inatteso al chiamante (che loggherà e risponderà 500)', async () => {
    const err = { code: '08006', message: 'connection failure' }
    const client = makeClient({ utenti: [{ data: null, error: err }] })
    const r = await risolviGenitorePerEmail(client, 'x@example.com')
    expect(r.genitore).toBeNull()
    expect(r.error).toBe(err)
  })

  it('scarta i falsi positivi ILIKE (wildcard _) con il ricontrollo esatto lato JS', async () => {
    // Un input con `_` non deve matchare un\'email diversa: il ricontrollo esatto filtra.
    const client = makeClient({
      utenti: [{ data: [{ id: PARENT_ID, email: 'genitoreXexample.com', scuola_id: SCUOLA_ID }], error: null }],
    })
    const r = await risolviGenitorePerEmail(client, 'genitore_example.com')
    expect(r.genitore).toBeNull()
  })
})
