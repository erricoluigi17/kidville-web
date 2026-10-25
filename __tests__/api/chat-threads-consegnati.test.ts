import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * S7 — LA CONSEGNA DEI MESSAGGI È UNA RICHIESTA A SÉ (robustezza 2, sessione 12).
 *
 * Prima la faceva `GET /api/chat/threads` a ogni giro: una lettura che scriveva. Adesso la pagina
 * la chiede quando la lista mostra non letti nuovi. Le garanzie restano quelle di prima: i thread
 * sono quelli di cui si è teacher o parent, con l'id del GATE; il corpo non porta niente.
 */

const IO = 'bbbbbbbb-0000-4000-8000-000000000d01'
const ALTRO = 'bbbbbbbb-0000-4000-8000-000000000d02'
const DOCENTE = 'aaaaaaaa-0000-4000-8000-000000000d03'
const TA = 'dddddddd-0000-4000-8000-000000000d0a'
const TB = 'dddddddd-0000-4000-8000-000000000d0b'
const TC = 'dddddddd-0000-4000-8000-000000000d0c'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  marcaConsegnati: vi.fn(),
  logErrore: vi.fn(),
  chiamate: [] as string[],
  filtriOr: [] as string[],
  righe: [] as Array<{ id: string }>,
  /**
   * Quando c'è, il finto client APPLICA il filtro `or` a queste righe, invece di restituire
   * `righe` qualunque cosa gli si chieda: è il caso che prova l'isolamento fra due utenti.
   */
  tabella: null as null | Array<{ id: string; teacher_id: string; parent_id: string }>,
  errore: null as null | { code: string; message: string },
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/chat/delivered', () => ({ marcaConsegnati: h.marcaConsegnati }))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logErrore: h.logErrore,
}))

/** `teacher_id.eq.X,parent_id.eq.Y` → la riga passa se una delle due condizioni è vera. */
function applicaOr(filtro: string, riga: Record<string, string>): boolean {
  return filtro.split(',').some((condizione) => {
    const [colonna, operatore, ...valore] = condizione.split('.')
    return operatore === 'eq' && riga[colonna] === valore.join('.')
  })
}

const adminClient = {
  from(table: string) {
    h.chiamate.push(`from:${table}`)
    const b: Record<string, unknown> = {}
    b.select = () => b
    b.or = (filtro: string) => {
      h.filtriOr.push(filtro)
      return b
    }
    b.update = () => {
      h.chiamate.push(`update:${table}`)
      return b
    }
    b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
      if (h.errore) return Promise.resolve({ data: null, error: h.errore }).then(ok, ko)
      if (h.tabella) {
        // Senza filtro, tutte le righe: una route che dimentica l'`or` le consegnerebbe tutte.
        const filtri = h.filtriOr
        const righe = h.tabella
          .filter((r) => filtri.every((f) => applicaOr(f, r)))
          .map((r) => ({ id: r.id }))
        return Promise.resolve({ data: righe, error: null }).then(ok, ko)
      }
      return Promise.resolve({ data: h.righe, error: null }).then(ok, ko)
    }
    return b
  },
}
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => adminClient }))

import { POST } from '@/app/api/chat/threads/consegnati/route'

const richiesta = (corpo: unknown = {}, url = 'http://localhost/api/chat/threads/consegnati') =>
  new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.chiamate = []
  h.filtriOr = []
  h.righe = [{ id: TA }, { id: TB }]
  h.tabella = null
  h.errore = null
  h.requireUser.mockResolvedValue({ user: { id: IO, role: 'genitore', scuola_id: 'sc-1' } })
  h.marcaConsegnati.mockResolvedValue({ esito: 'ok', n: 0 })
})

describe('POST /api/chat/threads/consegnati', () => {
  it('senza sessione: 401, e nessuna lettura', async () => {
    h.requireUser.mockResolvedValue({ response: Response.json({ error: 'Non autenticato' }, { status: 401 }) })
    const res = await POST(richiesta())
    expect(res.status).toBe(401)
    expect(h.chiamate).toEqual([])
    expect(h.marcaConsegnati).not.toHaveBeenCalled()
  })

  it('consegna sui thread di cui si è teacher o parent, con l’id del gate e senza limite temporale', async () => {
    const res = await POST(richiesta())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ consegna: 'ok' })
    expect(h.filtriOr).toEqual([`teacher_id.eq.${IO},parent_id.eq.${IO}`])
    expect(h.marcaConsegnati).toHaveBeenCalledTimes(1)
    expect(h.marcaConsegnati.mock.calls[0][1]).toEqual({ userId: IO, threadIds: [TA, TB] })
    expect(h.chiamate.some((c) => c.startsWith('update:')), 'l’UPDATE lo fa marcaConsegnati, non la route').toBe(false)
  })

  it('zero conversazioni: nessuna scrittura', async () => {
    h.righe = []
    const res = await POST(richiesta())
    expect(await res.json()).toEqual({ consegna: 'ok' })
    expect(h.marcaConsegnati).not.toHaveBeenCalled()
  })

  it('la lettura dei thread fallisce: 500 LETTURA_FALLITA, e il guasto è loggato', async () => {
    h.errore = { code: '57014', message: 'canceling statement due to statement timeout' }
    const res = await POST(richiesta())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Lettura dal database non riuscita', codice: 'LETTURA_FALLITA' })
    expect(h.logErrore).toHaveBeenCalledWith(
      { operazione: 'chat/threads/consegnati:POST', stato: 500, evento: 'db:chat_threads' },
      h.errore,
    )
    expect(h.marcaConsegnati).not.toHaveBeenCalled()
  })

  it('il corpo non può portare niente: 400, nessuna lettura', async () => {
    const res = await POST(richiesta({ threadIds: [TA] }))
    expect(res.status).toBe(400)
    expect(h.chiamate).toEqual([])
  })

  it('l’UPDATE si ferma a metà: 200 con `fermati` (il guasto lo registra marcaConsegnati)', async () => {
    h.marcaConsegnati.mockResolvedValue({ esito: 'fermati', n: 0 })
    const res = await POST(richiesta())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ consegna: 'fermati' })
  })
})

/**
 * L'ISOLAMENTO FRA DUE UTENTI, con un finto client che il filtro lo APPLICA davvero: TA è di IO
 * come genitore, TB di IO come docente, TC è una conversazione fra ALTRO e una docente in cui IO
 * non c'entra. Qualunque cosa porti la richiesta, TC non deve arrivare a `marcaConsegnati`.
 */
describe('POST /api/chat/threads/consegnati — i thread di un altro non si toccano', () => {
  beforeEach(() => {
    h.tabella = [
      { id: TA, teacher_id: DOCENTE, parent_id: IO },
      { id: TB, teacher_id: IO, parent_id: ALTRO },
      { id: TC, teacher_id: DOCENTE, parent_id: ALTRO },
    ]
  })

  it('solo le conversazioni di cui il GATE è partecipante, e il destinatario è il gate', async () => {
    const res = await POST(richiesta())
    expect(res.status).toBe(200)
    expect(h.marcaConsegnati).toHaveBeenCalledTimes(1)
    const { userId, threadIds } = h.marcaConsegnati.mock.calls[0][1] as { userId: string; threadIds: string[] }
    expect(userId).toBe(IO)
    expect(threadIds).toEqual([TA, TB])
    expect(threadIds).not.toContain(TC)
  })

  it('un `?userId=` di un altro nella query non cambia l’identità', async () => {
    const res = await POST(richiesta({}, `http://localhost/api/chat/threads/consegnati?userId=${ALTRO}`))
    expect(res.status).toBe(200)
    expect(h.filtriOr).toEqual([`teacher_id.eq.${IO},parent_id.eq.${IO}`])
    expect(h.marcaConsegnati.mock.calls[0][1]).toEqual({ userId: IO, threadIds: [TA, TB] })
  })

  it.each([
    ['un userId di un altro', { userId: ALTRO }],
    ['gli id dei thread di un altro', { threadIds: [TC] }],
    ['un campo qualunque', { tutti: true }],
  ])('un corpo con %s: 400, nessuna lettura e nessuna consegna', async (_caso, corpo) => {
    const res = await POST(richiesta(corpo))
    expect(res.status).toBe(400)
    expect(h.chiamate).toEqual([])
    expect(h.marcaConsegnati).not.toHaveBeenCalled()
  })

  it('un corpo che non è un oggetto: 400', async () => {
    for (const corpo of [[TC], 'tutti', null]) {
      const res = await POST(richiesta(corpo))
      expect(res.status, JSON.stringify(corpo)).toBe(400)
    }
    expect(h.marcaConsegnati).not.toHaveBeenCalled()
  })

  it('l’utente che è solo ALTRO vede solo i suoi: TB e TC, mai TA', async () => {
    h.requireUser.mockResolvedValue({ user: { id: ALTRO, role: 'genitore', scuola_id: 'sc-1' } })
    await POST(richiesta())
    expect(h.marcaConsegnati.mock.calls[0][1]).toEqual({ userId: ALTRO, threadIds: [TB, TC] })
  })
})
