/**
 * Le tre route che SPEDISCONO un OTP non spediscono niente senza sessione.
 *
 * Il lock di forma (`firma-identita-da-sessione.test.ts`) verifica che il sorgente
 * passi da `requireUser`. Questo file verifica la conseguenza che interessa
 * davvero: **`sendOtp` non viene nemmeno chiamata**. Fino al 2026-07-31 bastava
 * `?userId=<uuid del genitore>` — nessuna sessione, nessuna password — per far
 * partire un'email verso la casella di quel genitore, senza limite di frequenza.
 * Un canale d'invio azionabile dall'esterno.
 *
 * Le tre route non avevano NESSUN test di comportamento prima di questo file.
 *
 * PROVA DI VALIDITÀ (eseguita, 2026-07-31): rimettendo `getRequestUserId` in
 * `parent/presenze/giustifica/otp/route.ts` il caso «nessuna sessione» di quella
 * route diventa rosso — `sendOtp` risulta chiamata 1 volta invece di 0 — perché la
 * query `?userId=` torna a essere accettata.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn().mockResolvedValue({}),
}))

const auth = vi.hoisted(() => ({ requireUser: vi.fn() }))
vi.mock('@/lib/auth/require-staff', () => ({ requireUser: auth.requireUser }))

const otp = vi.hoisted(() => ({ sendOtp: vi.fn() }))
vi.mock('@/lib/auth/otp-ticket', () => otp)

const fea = vi.hoisted(() => ({ logFeaEvent: vi.fn() }))
vi.mock('@/lib/fea/audit', () => fea)

import { POST as postNota } from '@/app/api/parent/primaria/note/firma/otp/route'
import { POST as postPagella } from '@/app/api/parent/primaria/pagella/firma/otp/route'
import { POST as postGiustifica } from '@/app/api/parent/presenze/giustifica/otp/route'

const ROUTE = [
  ['note/firma/otp', postNota, 'http://localhost/api/parent/primaria/note/firma/otp'],
  ['pagella/firma/otp', postPagella, 'http://localhost/api/parent/primaria/pagella/firma/otp'],
  ['presenze/giustifica/otp', postGiustifica, 'http://localhost/api/parent/presenze/giustifica/otp'],
] as const

/** La richiesta esattamente come la faceva l'attacco del 30/07: solo `?userId=`. */
function richiestaSenzaSessione(base: string): NextRequest {
  return new NextRequest(`${base}?userId=11111111-1111-4111-8111-111111111111`, {
    method: 'POST',
    headers: { 'x-user-id': '11111111-1111-4111-8111-111111111111' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  otp.sendOtp.mockResolvedValue({ email: 'genitore@example.test', expiry: 0, ticket: 't' })
})

describe('OTP di firma: senza sessione non parte nessuna email', () => {
  it.each(ROUTE)('%s — 401 e sendOtp mai chiamata', async (_nome, handler, base) => {
    auth.requireUser.mockResolvedValue({
      response: new Response(JSON.stringify({ error: 'Non autenticato' }), { status: 401 }),
    })
    const res = await handler(richiestaSenzaSessione(base))
    expect(res.status).toBe(401)
    expect(otp.sendOtp).not.toHaveBeenCalled()
    expect(fea.logFeaEvent).not.toHaveBeenCalled()
  })

  it.each(ROUTE)('%s — con sessione l\'OTP parte, e va all\'utente della SESSIONE', async (_nome, handler, base) => {
    auth.requireUser.mockResolvedValue({
      user: { id: 'utente-di-sessione', role: 'genitore' },
    })
    // La query porta un uuid DIVERSO: deve essere ignorato.
    const res = await handler(richiestaSenzaSessione(base))
    expect(res.status).toBe(200)
    expect(otp.sendOtp).toHaveBeenCalledTimes(1)
    expect(otp.sendOtp.mock.calls[0][1]).toBe('utente-di-sessione')
  })
})
