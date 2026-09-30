import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'

/**
 * `NativePushAutoRegister` — L'EVENTO DELLA REGISTRAZIONE RIUSCITA (revisione finale, 2026-09-30).
 *
 * ─── LA CORSA CHE CHIUDE ────────────────────────────────────────────────────────
 *
 * Al primo accesso nell'app due pezzi partono insieme: questo provider (nel layout) chiede il
 * permesso di sistema e registra il token; `AvvisoNotificheDocente` (nella pagina) legge quanti
 * dispositivi ha il server. La seconda risposta arriva per prima, dice «zero dispositivi» e
 * mostra «Le notifiche sono spente · Attiva». Poi la maestra tocca «Consenti», la registrazione
 * riesce — e l'avviso non lo sapeva: nessun evento lo raggiungeva, e un `visibilitychange`
 * entro trenta secondi lo scarta la sua soglia. Restava a schermo a dire il falso.
 *
 * ─── COSA SORVEGLIA QUESTO FILE ─────────────────────────────────────────────────
 *
 *  1. a registrazione RIUSCITA l'evento `kv:push-registrata` parte;
 *  2. su un fallimento NON parte: il conteggio non è cambiato, e un ricontrollo leggerebbe lo
 *     stesso zero di prima — traffico che non cambia niente a schermo;
 *  3. nemmeno quando la promise di `registerNativePush` viene RIFIUTATA;
 *  4. e parte una volta per registrazione, non una per render.
 *
 * Il file è separato da `NativePushAutoRegister-ripresa.test.tsx` di proposito: quello misura la
 * politica anti-raffica del ritorno in primo piano, e i suoi mock sono tarati per quella.
 */

const h = vi.hoisted(() => ({
  identita: { userId: null as string | null, ready: false },
  registerNativePush: vi.fn(),
  statoPermessoPush: vi.fn(),
  logClient: vi.fn(),
}))

vi.mock('@/lib/auth/use-session-identity', () => ({
  useSessionIdentity: () => ({ userId: h.identita.userId, role: 'docente', ready: h.identita.ready }),
}))
vi.mock('@/lib/push/native-register', () => ({
  isNativeApp: () => true,
  registerNativePush: h.registerNativePush,
  statoPermessoPush: h.statoPermessoPush,
}))
vi.mock('@/lib/logging/client', () => ({
  logClient: h.logClient,
  nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
}))
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: () => Promise.resolve({ remove: async () => undefined }),
  },
}))

import { NativePushAutoRegister, __azzeraPerTest } from '@/components/providers/NativePushAutoRegister'
import { EVENTO_PUSH_REGISTRATA } from '@/lib/push/registrazione-riuscita'

const UTENTE = '00000000-0000-4000-8000-0000000000a1'

let eventi = 0
const conta = () => {
  eventi++
}

async function scorri() {
  await act(async () => {
    for (let k = 0; k < 10; k++) await Promise.resolve()
  })
}

async function montaCon(esito: unknown) {
  h.identita = { userId: UTENTE, ready: true }
  h.registerNativePush.mockReset()
  if (esito instanceof Error) h.registerNativePush.mockRejectedValue(esito)
  else h.registerNativePush.mockResolvedValue(esito)
  render(<NativePushAutoRegister />)
  await scorri()
}

beforeEach(() => {
  eventi = 0
  window.addEventListener(EVENTO_PUSH_REGISTRATA, conta)
  h.logClient.mockReset()
  h.statoPermessoPush.mockReset()
  h.statoPermessoPush.mockResolvedValue('granted')
  __azzeraPerTest()
})

afterEach(() => {
  window.removeEventListener(EVENTO_PUSH_REGISTRATA, conta)
  cleanup()
})

describe('NativePushAutoRegister — l evento della registrazione riuscita', () => {
  it('🔴 registrazione RIUSCITA → l evento parte, una volta sola', async () => {
    await montaCon({ ok: true })
    expect(h.registerNativePush).toHaveBeenCalledTimes(1)
    expect(eventi).toBe(1)
  })

  it('🔴 registrazione FALLITA → nessun evento (il conteggio del server non è cambiato)', async () => {
    await montaCon({ ok: false, error: 'permission_denied' })
    expect(h.registerNativePush).toHaveBeenCalledTimes(1)
    expect(eventi).toBe(0)
  })

  it('🔴 un errore ritentabile non è un successo: nessun evento', async () => {
    await montaCon({ ok: false, error: 'registration_timeout' })
    expect(eventi).toBe(0)
  })

  it('🔴 la promise RIFIUTATA non emette niente (e resta loggata)', async () => {
    await montaCon(Object.assign(new Error('bridge rotto'), { name: 'TypeError' }))
    expect(eventi).toBe(0)
    expect(h.logClient).toHaveBeenCalledWith(
      expect.objectContaining({ messaggio: 'push-nativa-tentativo-fallito: TypeError' }),
    )
  })

  it('senza identità non si registra niente, quindi nessun evento', async () => {
    h.identita = { userId: null, ready: false }
    h.registerNativePush.mockReset()
    h.registerNativePush.mockResolvedValue({ ok: true })
    render(<NativePushAutoRegister />)
    await scorri()
    expect(h.registerNativePush).not.toHaveBeenCalled()
    expect(eventi).toBe(0)
  })
})
