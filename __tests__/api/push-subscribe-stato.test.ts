import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * `GET /api/push/subscribe` — QUANTI DISPOSITIVI HA QUESTO UTENTE (compito C1, 2026-09-30).
 *
 * PERCHÉ ESISTE. Segnalazione del 29/09, «i messaggi dei genitori non arrivano alle maestre»:
 * una docente su Android, che apre l'app ogni giorno, ha ricevuto 137 messaggi in 30 giorni
 * senza UNA push. Il permesso era negato (`push-nativa-permesso-negato: denied` nei log da
 * inizio settembre), `push_subscriptions` non aveva nessuna sua riga, e in nessuna schermata
 * c'era scritto. Questa route è la sola risposta possibile alla domanda «mi arriveranno?»:
 * il permesso del sistema non basta — su iOS può essere `granted` e il token non essere mai
 * arrivato al server. Quello che conta è la RIGA IN TABELLA.
 *
 * COSA SORVEGLIA QUESTO FILE, e perché ciascuna cosa:
 *
 *  1. **401 senza sessione.** Il conteggio dei dispositivi di qualcuno è un dato suo.
 *  2. **L'identità è quella del GATE, mai quella della query.** `?userId=` è tollerato (lo
 *     scrivono i chiamanti legacy del genitore, vedi la testata di `native-register.ts`) e
 *     IGNORATO: se decidesse il conteggio, chiunque autenticato potrebbe contare i
 *     dispositivi di chiunque altro passando il suo uuid. È il mutante n. 1 del compito.
 *  3. **La forma della risposta** (`{ success, dispositivi }`): la consuma
 *     `AvvisoNotificheDocente`, che su una forma diversa non mostrerebbe nulla — un avviso
 *     che tace è indistinguibile da «tutto a posto».
 *  4. **L'errore di PostgREST non esce dal server.** `{ error }` non lancia (regola 7 di
 *     AGENTS.md): si controlla il valore di ritorno, si logga a livello `error` e si risponde
 *     500 con un CODICE — il `message` di PostgREST riecheggia filtri e valori, cioè l'uuid
 *     dell'utente, e non va a schermo.
 */

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  from: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn().mockResolvedValue({ from: h.from }),
}))
vi.mock('@/lib/push/web-push', () => ({ vapidConfigured: () => true }))
vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/logging/logger', () => ({
  logEvento: h.logEvento,
  logErrore: h.logErrore,
  logOk: vi.fn(),
}))

import { GET } from '@/app/api/push/subscribe/route'

/**
 * L'esito della head-query, e la catena `.from().select().eq()` che ci arriva.
 *
 * `status` c'è perché su una HEAD è l'unica diagnosi disponibile: il corpo è vuoto per HTTP,
 * quindi `message`/`details`/`hint` restano vuoti anche quando qualcosa va storto.
 *
 * ⚠️ QUESTA È UNA FIXTURE, e va tenuta dentro ciò che il driver produce davvero: un `message`
 * pieno o uno `status: 404` qui sarebbero risposte che su una HEAD non esistono (il 404 con
 * corpo vuoto `postgrest-js` lo riscrive in **204**). La controprova col DRIVER VERO su un
 * PostgREST finto sta in `__tests__/api/push-subscribe-stato-driver.test.ts`, che non usa
 * questa fixture e misura la forma delle risposte al posto di dichiararla.
 */
function conEsito(esito: { count: number | null; error?: { message: string } | null; status?: number }) {
  h.eq.mockResolvedValue({ error: null, status: 200, ...esito })
  h.select.mockReturnValue({ eq: h.eq })
  h.from.mockReturnValue({ select: h.select })
}

function req(query = ''): Request {
  return new Request(`http://localhost/api/push/subscribe${query}`)
}

beforeEach(() => {
  vi.clearAllMocks()
  h.requireUser.mockResolvedValue({ user: { id: 'aaaaaaaa-1111-4000-8000-000000000001' } })
  conEsito({ count: 2, error: null })
})

describe('GET /api/push/subscribe', () => {
  it('senza sessione → 401 e nessuna lettura', async () => {
    h.requireUser.mockResolvedValue({ response: new Response('no', { status: 401 }) })
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(h.from).not.toHaveBeenCalled()
  })

  it('conta i dispositivi dell utente autenticato e risponde { success, dispositivi }', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, dispositivi: 2 })
    expect(h.from).toHaveBeenCalledWith('push_subscriptions')
    // Head-query: il conteggio non porta indietro nemmeno un endpoint (che è
    // l'indirizzo del dispositivo).
    expect(h.select.mock.calls[0][1]).toMatchObject({ count: 'exact', head: true })
    expect(h.eq).toHaveBeenCalledWith('utente_id', 'aaaaaaaa-1111-4000-8000-000000000001')
  })

  it('un `userId` in query NON sostituisce l identità del gate', async () => {
    const res = await GET(req('?userId=bbbbbbbb-2222-4000-8000-000000000002'))
    expect(res.status).toBe(200)
    expect(h.eq).toHaveBeenCalledTimes(1)
    expect(h.eq).toHaveBeenCalledWith('utente_id', 'aaaaaaaa-1111-4000-8000-000000000001')
  })

  it('un `userId` fuori forma → 400 (lo schema della query resta una lista bianca)', async () => {
    const res = await GET(req('?userId=non-un-uuid'))
    expect(res.status).toBe(400)
    expect(h.from).not.toHaveBeenCalled()
  })

  it('un `userId` SEMINATO (variant non standard) passa: `zUuid` è `z.guid()`, non `uuid()`', async () => {
    // ⚠️ Misurato: `z.string().uuid()` applica lo strict RFC 9562 e rifiuta
    // `aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa` — la forma degli account seminati, e della sede di
    // collaudo della CI. Con quello schema la lettura tornerebbe 400 proprio in E2E, dove il
    // parametro c'è: un 400 su un parametro che si IGNORA. Il perché sta nella testata di
    // `src/lib/validation/common.ts`.
    const res = await GET(req('?userId=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'))
    expect(res.status).toBe(200)
    expect(h.eq).toHaveBeenCalledWith('utente_id', 'aaaaaaaa-1111-4000-8000-000000000001')
  })

  it('zero dispositivi → `dispositivi: 0`, non un campo mancante', async () => {
    conEsito({ count: 0, error: null })
    expect(await (await GET(req())).json()).toEqual({ success: true, dispositivi: 0 })
  })

  it('🔴 `count` nullo NON è uno zero: 500 col codice, e il log porta lo `stato`', async () => {
    // La firma del 404 con corpo vuoto (tabella fuori dalla schema cache) COM'È DAVVERO:
    // `error: null`, `count: null`, e lo stato **204**, perché `postgrest-js` riscrive così
    // quel caso. Con un `?? 0` la route direbbe «zero dispositivi» a tutte le docenti, e
    // l'avviso comparirebbe a tutte insieme per un guasto di lettura.
    conEsito({ count: null, status: 204 })
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ codice: 'PUSH_STATO_NON_LETTO' })
    expect(h.logEvento).toHaveBeenCalledWith(
      'push',
      'error',
      expect.objectContaining({ esito: 'stato-non-letto', stato: 204 }),
      undefined,
    )
  })

  it('errore PostgREST → 500 col codice, il messaggio del driver NON nel corpo, e un log `error`', async () => {
    // Il `message` è VUOTO perché su una HEAD il corpo non esiste: è così che il driver
    // riempie l'errore su un 5xx. Un messaggio pieno qui sarebbe una fixture che descrive una
    // risposta impossibile — e un test che misura la propria invenzione.
    conEsito({ count: null, error: { message: '' }, status: 500 })
    const res = await GET(req())
    expect(res.status).toBe(500)
    const corpo = (await res.json()) as { error: string; codice: string }
    expect(corpo.codice).toBe('PUSH_STATO_NON_LETTO')
    // Nel corpo non finisce niente del driver: il suo messaggio riecheggia il filtro, e il
    // filtro è l'identità dell'utente.
    expect(JSON.stringify(corpo)).not.toContain('push_subscriptions')
    // L'errore viaggia come QUARTO argomento e lo `stato` nei campi: su una HEAD è lo stato
    // l'unica diagnosi (vedi la testata della fixture), e senza di esso resterebbe solo un
    // errore con il messaggio vuoto.
    expect(h.logEvento).toHaveBeenCalledWith(
      'push',
      'error',
      expect.objectContaining({ operazione: 'push/subscribe:GET', esito: 'stato-non-letto', stato: 500 }),
      expect.objectContaining({ message: '' }),
    )
  })

  it('un ECCEZIONE nel giro → 500 con LO STESSO codice, e `logErrore` (che `withRoute` non vedrebbe)', async () => {
    // `withRoute` osserva l'esito ma NON vede le eccezioni catturate: senza il `logErrore` di
    // questo ramo un guasto del client Supabase uscirebbe come un 500 muto. E il corpo porta
    // il codice come l'altro ramo: per chi chiede il conteggio è lo stesso fatto.
    h.from.mockImplementation(() => {
      throw new TypeError('bridge rotto')
    })
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ codice: 'PUSH_STATO_NON_LETTO' })
    expect(h.logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ operazione: 'push/subscribe:GET', stato: 500 }),
      expect.any(TypeError),
    )
  })
})
