import { describe, it, expect } from 'vitest'
import { ticketJti, consumeTicket, makeTicket } from '@/lib/auth/otp-ticket'
import type { SupabaseClient } from '@supabase/supabase-js'

// M5 — consumo uso-singolo del ticket OTP (anti-replay Sistema B).
// Il jti deriva deterministicamente dal ticket (hash) → nessun cambio al formato
// del ticket né alla verifica HMAC esistente.

function clientInsert(result: { error: unknown }): SupabaseClient {
  return {
    from: () => ({
      insert: () => Promise.resolve(result),
    }),
  } as unknown as SupabaseClient
}

describe('ticketJti', () => {
  it('è deterministico per lo stesso ticket', () => {
    const t = makeTicket('p@x.it', '424242', 1_000_000)
    expect(ticketJti(t)).toBe(ticketJti(t))
  })

  it('differisce tra ticket diversi', () => {
    const a = makeTicket('p@x.it', '424242', 1_000_000)
    const b = makeTicket('p@x.it', '424243', 1_000_000)
    expect(ticketJti(a)).not.toBe(ticketJti(b))
  })
})

describe('consumeTicket', () => {
  it('primo uso (INSERT ok) → { ok: true }', async () => {
    const supabase = clientInsert({ error: null })
    const r = await consumeTicket(supabase, 'ticket-xyz', 'test:op')
    expect(r).toEqual({ ok: true })
  })

  it('replay (violazione chiave primaria 23505) → { replay: true }', async () => {
    const supabase = clientInsert({ error: { code: '23505' } })
    const r = await consumeTicket(supabase, 'ticket-xyz', 'test:op')
    expect(r).toEqual({ replay: true })
  })

  it('store non ancora migrato (tabella assente PGRST205) → degrada a { ok: true }', async () => {
    const supabase = clientInsert({ error: { code: 'PGRST205' } })
    const r = await consumeTicket(supabase, 'ticket-xyz', 'test:op')
    expect(r).toEqual({ ok: true })
  })

  it('tabella assente 42P01 → degrada a { ok: true }', async () => {
    const supabase = clientInsert({ error: { code: '42P01' } })
    const r = await consumeTicket(supabase, 'ticket-xyz', 'test:op')
    expect(r).toEqual({ ok: true })
  })

  it('errore DB inatteso → fail-open { ok: true } (backstop = indice unique firme)', async () => {
    const supabase = clientInsert({ error: { code: 'XX000' } })
    const r = await consumeTicket(supabase, 'ticket-xyz', 'test:op')
    expect(r).toEqual({ ok: true })
  })
})
