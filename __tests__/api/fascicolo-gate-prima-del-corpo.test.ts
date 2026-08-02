// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * IL GATE VIENE PRIMA DELLA LETTURA DEL CORPO (collaudo del 2026-08-02, terza tornata · F1).
 *
 * ─── MISURATO, sul server vivo, prima della correzione ───────────────────────
 *   curl -X POST -H 'content-type: application/json' -d '{"x":1}' \
 *        http://localhost:3100/api/primaria/fascicolo
 *   → HTTP 500 {"error":"Content-Type was not one of \"multipart/form-data\" or
 *                \"application/x-www-form-urlencoded\"."}
 *
 * ─── LA CAUSA, che è un ORDINE e non una funzione mancante ───────────────────
 * `await request.formData()` stava alla riga 72; `resolveIdentity` — il gate — alla 75.
 * Il corpo veniva letto PRIMA di sapere chi stesse chiamando, e `formData()` LANCIA su un
 * Content-Type che non sia multipart: l'eccezione scavalcava il gate e finiva nel `catch`
 * generico, che risponde 500 rimandando indietro `err.message`.
 *
 * Un anonimo otteneva quindi due cose a cui non ha diritto: un 500 (che dice «il guasto è
 * mio», sporca ogni misura di salute e scrive una riga `error` in `app_log` a comando) e il
 * messaggio interno del runtime. Su `primaria/fascicolo`, cioè la rotta che custodisce
 * diagnosi, PEI, PDP e verbali della 104 — dati sanitari di minori.
 *
 * ─── PERCHÉ NON BASTA «USARE `parseMultipart`» ──────────────────────────────
 * Con la primitiva ma nell'ordine sbagliato, l'anonimo prenderebbe un 400 pulito invece del
 * 500 — meglio, ma continuerebbe a far LEGGERE al server un corpo arbitrario prima di sapere
 * chi è: su una rotta di upload significa accettare e bufferizzare 15 MB da chiunque. È
 * l'ordine il presidio; la primitiva è solo il numero giusto quando l'ordine è già a posto.
 * Per questo il primo test qui sotto è sull'ANONIMO, e chiede 401 — non 400.
 */

const h = vi.hoisted(() => ({
  logErrore: vi.fn(),
  userId: null as string | null,
}))

vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logErrore: (...a: unknown[]) => h.logErrore(...a),
}))

vi.mock('@/lib/auth/require-staff', () => ({
  resolveIdentity: async () => ({ userId: h.userId, source: 'header' }),
  loadAppUser: async () => null,
}))

vi.mock('@/lib/primaria/fascicolo-rbac', () => ({
  puoAccedereFascicolo: async () => ({ consentito: true, ruolo: 'coordinator', motivo: 'staff' }),
  logAccessoFascicolo: async () => undefined,
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'order', 'in', 'insert']) b[m] = () => b
      b.single = async () => ({ data: { id: 'doc-1' }, error: null })
      b.maybeSingle = async () => ({ data: null, error: null })
      b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok)
      return b
    },
    storage: {
      listBuckets: async () => ({ data: [], error: null }),
      createBucket: async () => ({ error: null }),
      from: () => ({ upload: async () => ({ error: null }) }),
    },
  }),
}))

import { POST } from '@/app/api/primaria/fascicolo/route'
import type { NextRequest } from 'next/server'

const json = () =>
  new Request('http://localhost/api/primaria/fascicolo', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"x":1}',
  }) as unknown as NextRequest

/** L'altra forma in cui `formData()` lancia: nessun Content-Type affatto. */
const senzaTipo = () =>
  new Request('http://localhost/api/primaria/fascicolo', { method: 'POST' }) as unknown as NextRequest

beforeEach(() => {
  vi.clearAllMocks()
  h.userId = null
})

describe('POST /api/primaria/fascicolo · il gate precede la lettura del corpo', () => {
  it('anonimo con Content-Type sbagliato → 401, non 500', async () => {
    const res = await POST(json())
    expect(
      res.status,
      'Un anonimo non deve poter far esplodere il runtime del fascicolo sanitario: se il ' +
        'corpo si legge prima del gate, il numero che torna lo decide il client scegliendo ' +
        "un header. Il gate è l'unica cosa che deve rispondere per prima.",
    ).toBe(401)
  })

  it('anonimo senza nessun Content-Type → 401', async () => {
    expect((await POST(senzaTipo())).status).toBe(401)
  })

  it("all'anonimo non esce il messaggio interno del runtime", async () => {
    const res = await POST(json())
    const testo = JSON.stringify(await res.json())
    expect(
      testo,
      'Oggi è una stringa di Next; domani è quello che ci finisce dentro. A chi non si è ' +
        'nemmeno identificato non si racconta cosa è andato storto dentro casa.',
    ).not.toMatch(/multipart\/form-data|x-www-form-urlencoded/i)
  })

  it('e non lascia una riga `error`: il canale dei guasti resta pulito', async () => {
    await POST(json())
    expect(
      h.logErrore,
      'Una richiesta anonima malformata non è un incidente del server. Se ogni POST storta ' +
        "scrive `error` in `app_log`, il giorno del guasto vero non lo vede nessuno — ed è " +
        'un canale che si riempie a comando, da fuori.',
    ).not.toHaveBeenCalled()
  })

  it('autenticato con Content-Type sbagliato → 400 (errore del client), non 500', async () => {
    h.userId = 'u-1'
    const res = await POST(json())
    expect(
      res.status,
      'Passato il gate, un Content-Type sbagliato resta un errore del CLIENT: 400. Il 500 ' +
        'è riservato ai guasti nostri.',
    ).toBe(400)
    expect(JSON.stringify(await res.json())).not.toMatch(/multipart\/form-data/i)
  })

  it('autenticato e malformato non scrive `error` (è un 400, non un guasto)', async () => {
    h.userId = 'u-1'
    await POST(json())
    expect(h.logErrore).not.toHaveBeenCalled()
  })
})
