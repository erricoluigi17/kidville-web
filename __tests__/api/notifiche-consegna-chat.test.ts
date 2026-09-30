import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * «CONSEGNATO» QUANDO IL MESSAGGIO ARRIVA, NON QUANDO SI APRE LA LISTA CHAT (D2).
 *
 * Segnalazione del 2026-09-29: una mamma scrive alle 10:52 e per cinque ore vede UNA spunta
 * grigia. Il messaggio era arrivato eccome — ma `delivered_at` si valorizzava solo dentro
 * `chat/threads:GET`, cioè quando la destinataria apriva la lista. Lei l'app l'aveva aperta:
 * non era andata su «Messaggi».
 *
 * `GET /api/notifiche` è la route che TUTTI interrogano — la campanella la chiama all'apertura
 * e ogni 60 s. Se il conteggio della chat dice che ci sono messaggi non letti, allora l'app di
 * quella persona è accesa e quei messaggi sono ARRIVATI: la doppia spunta si accende qui.
 *
 * Le promesse che questo file tiene ferme, una per test:
 *  · la consegna gira DOPO la risposta, con `after()`: la GET non aspetta un UPDATE;
 *  · `creatiFinoA` è l'istante in cui la GET È COMINCIATA, non quello in cui `after()` parte:
 *    un messaggio nato nel frattempo non è stato «consegnato» da questa richiesta;
 *  · niente da leggere (0) o non lo so (`null`) → nessuna consegna e nessun `after`;
 *  · `after()` indisponibile (test, script) o consegna fallita → la risposta NON cambia e NON
 *    diventa 500. La doppia spunta arriva al giro dopo; una campanella rotta no.
 *
 * UUID finti e fissi, nessun dato di una persona vera.
 */

const UTENTE_DEL_GATE = 'aaaaaaaa-0000-4000-8000-000000000001'
const UTENTE_ALTRUI = 'bbbbbbbb-0000-4000-8000-000000000002'
const INIZIO_GET = '2026-09-30T10:52:00.000Z'

/**
 * Quanto avanza l'orologio finto a OGNI query del client finto.
 *
 * Non è una misura della realtà — nella realtà la finestra è di decine o centinaia di
 * millisecondi — ma un orologio FERMO è un test che non prova niente: con la data immobile
 * `creatiFinoA` verrebbe uguale preso all'inizio della GET, preso dopo le query o ricalcolato
 * dentro `programmaConsegnaChat`, e tre implementazioni diverse passerebbero tutte. Cinque
 * secondi per query sono solo abbastanza da rendere la differenza visibile.
 */
const AVANZAMENTO_PER_QUERY_MS = 5_000

// Client finto: builder thenable con code per tabella, come negli altri test di questa route.
const h = vi.hoisted(() => {
  const state = {
    queues: {} as Record<string, Array<unknown>>,
    used: {} as Record<string, number>,
    calls: [] as Array<{ table: string; m: string; args: unknown[] }>,
    /** Chiamato a ogni query: serve a far avanzare l'orologio finto. */
    onQuery: null as null | (() => void),
  }
  function take(table: string) {
    state.onQuery?.()
    const q = state.queues[table] || []
    const i = state.used[table] ?? 0
    state.used[table] = i + 1
    return q[i] ?? { data: [], count: 0, error: null }
  }
  const client = {
    from(table: string) {
      const qb: Record<string, unknown> = {}
      const rec = (m: string) => (...args: unknown[]) => { state.calls.push({ table, m, args }); return qb }
      for (const m of ['select', 'is', 'or', 'order', 'limit', 'in', 'neq', 'update', 'delete', 'eq', 'lte']) qb[m] = rec(m)
      qb.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(take(table)).then(res, rej)
      return qb
    },
  }
  return {
    state,
    client,
    after: vi.fn(),
    consegnaSeInAttesa: vi.fn(),
    requireUser: vi.fn(),
    logEvento: vi.fn(),
    logErrore: vi.fn(),
  }
})

// `after` è l'unica cosa sostituita di `next/server`: `NextResponse` resta quello vero.
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: h.after,
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn().mockResolvedValue(h.client),
}))
vi.mock('@/lib/logging/logger', () => ({ logEvento: h.logEvento, logErrore: h.logErrore, logOk: vi.fn() }))
vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
// Solo la consegna è finta: `leggiChatNonLetti` gira DAVVERO, così i `threadIds` che la
// consegna riceve sono quelli letti da `chat_threads` e non un valore inventato dal test.
vi.mock('@/lib/chat/delivered', () => ({
  marcaConsegnati: vi.fn(),
  consegnaSeInAttesa: h.consegnaSeInAttesa,
}))

import { GET } from '@/app/api/notifiche/route'

function req(qs = ''): Request {
  return new Request(`http://localhost/api/notifiche${qs}`)
}

function elenco(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `n${i}`, tipo: 't', titolo: 'x', corpo: null, link: null,
    entita_tipo: null, entita_id: null, letta_il: null, creato_il: '2026-09-30T00:00:00Z',
  }))
}

/** Una GET con 2 messaggi di chat non letti su due conversazioni. */
function codeConNonLetti(n = 2) {
  return {
    notifiche: [{ data: elenco(1), error: null }, { count: 3, error: null }],
    chat_threads: [{ data: [{ id: 'th-1' }, { id: 'th-2' }], error: null }],
    chat_messages: [{ count: n, error: null }],
  }
}

/** Esegue il giro che la route ha consegnato ad `after()`, come farebbe la piattaforma. */
async function eseguiGiro(): Promise<void> {
  const giro = h.after.mock.calls[0]?.[0] as (() => unknown) | undefined
  expect(typeof giro).toBe('function')
  await giro?.()
}

/** I log emessi sul canale `chat` a un livello dato. */
function logChat(livello: string) {
  return (h.logEvento.mock.calls as Array<[string, string, Record<string, unknown>, unknown?]>)
    .filter((c) => c[0] === 'chat' && c[1] === livello)
    .map((c) => c[2])
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.queues = {}
  h.state.used = {}
  h.state.calls = []
  // L'OROLOGIO AVANZA A OGNI QUERY, per tutti i casi: un orologio fermo renderebbe
  // indistinguibili tre momenti diversi in cui si potrebbe leggere `creatiFinoA`.
  h.state.onQuery = () => vi.setSystemTime(new Date(Date.now() + AVANZAMENTO_PER_QUERY_MS))
  h.after.mockReset()
  h.consegnaSeInAttesa.mockReset()
  h.consegnaSeInAttesa.mockResolvedValue(undefined)
  h.requireUser.mockResolvedValue({ response: null, user: { id: UTENTE_DEL_GATE } })
  // Solo `Date` è finto: le promise del client finto restano vere.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(INIZIO_GET))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('GET /api/notifiche — la consegna «delivered» dopo la risposta', () => {
  it('con messaggi non letti programma la consegna: uid del gate, i thread letti, l\'istante della GET', async () => {
    h.state.queues = codeConNonLetti()

    const res = await GET(req())
    const body = await res.json()

    expect(res.status).toBe(200)
    // LA RISPOSTA È IDENTICA: stessa forma, stesse quattro chiavi.
    expect(Object.keys(body).sort()).toEqual(['chat_non_letti', 'data', 'non_lette', 'success'])
    expect(body.chat_non_letti).toBe(2)

    // NON prima della risposta: solo programmata.
    expect(h.after).toHaveBeenCalledTimes(1)
    expect(h.consegnaSeInAttesa).not.toHaveBeenCalled()

    await eseguiGiro()

    expect(h.consegnaSeInAttesa).toHaveBeenCalledTimes(1)
    const [client, params] = h.consegnaSeInAttesa.mock.calls[0]
    expect(client).toBe(h.client)
    expect(params).toEqual({
      userId: UTENTE_DEL_GATE,
      threadIds: ['th-1', 'th-2'],
      creatiFinoA: INIZIO_GET,
    })
  })

  it('`creatiFinoA` è l\'istante PRIMA delle query, non uno preso dopo o al momento del giro', async () => {
    h.state.queues = codeConNonLetti()

    await GET(req())

    // L'orologio è avanzato a ogni query (vedi `AVANZAMENTO_PER_QUERY_MS`) e avanza ancora fra
    // la risposta e il giro: se `creatiFinoA` venisse letto dopo `await chatNonLetti`, o
    // ricalcolato dentro `programmaConsegnaChat`, qui non sarebbe più `INIZIO_GET` — e un
    // messaggio nato in quella finestra prenderebbe una doppia spunta che non si è meritato.
    vi.setSystemTime(new Date(Date.now() + 1_000))
    await eseguiGiro()

    expect(h.consegnaSeInAttesa.mock.calls[0][1].creatiFinoA).toBe(INIZIO_GET)
  })

  it('la GET risponde anche se la consegna non finisce MAI: `after()` non la trattiene', async () => {
    h.state.queues = codeConNonLetti()

    // Il finto esegue la callback SUBITO, come la piattaforma potrebbe fare appena chiusa la
    // risposta — e la consegna non si risolve mai. Se la route attendesse il giro (un `await`
    // al posto di `after`, o un `after` atteso), questa `GET` resterebbe appesa e il test
    // morirebbe in timeout invece di asserire.
    h.consegnaSeInAttesa.mockReturnValue(new Promise(() => {}))
    let giroPartito = false
    h.after.mockImplementation((giro: () => unknown) => { giroPartito = true; void giro() })

    const res = await GET(req())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(Object.keys(body).sort()).toEqual(['chat_non_letti', 'data', 'non_lette', 'success'])
    expect(giroPartito).toBe(true)
    // La consegna è stata avviata e lasciata in volo: la risposta non l'ha aspettata.
    expect(h.consegnaSeInAttesa).toHaveBeenCalledTimes(1)
  })

  it('`chat_non_letti: 0` → nessuna consegna e nessun `after`', async () => {
    h.state.queues = {
      notifiche: [{ data: elenco(1), error: null }, { count: 1, error: null }],
      chat_threads: [{ data: [{ id: 'th-1' }], error: null }],
      chat_messages: [{ count: 0, error: null }],
    }

    const res = await GET(req())
    const body = await res.json()

    expect(body.chat_non_letti).toBe(0)
    // Niente di non letto = niente da consegnare (letto implica consegnato): programmare un
    // giro in `after()` per nessuna riga sarebbe lavoro per niente, ogni 60 s per persona.
    expect(h.after).not.toHaveBeenCalled()
    expect(h.consegnaSeInAttesa).not.toHaveBeenCalled()
  })

  it('nessuna conversazione → nessuna consegna', async () => {
    h.state.queues = {
      notifiche: [{ data: elenco(1), error: null }, { count: 1, error: null }],
      chat_threads: [{ data: [], error: null }],
    }

    const res = await GET(req())
    expect((await res.json()).chat_non_letti).toBe(0)
    expect(h.after).not.toHaveBeenCalled()
  })

  it('`chat_non_letti: null` («non lo so») → nessuna consegna: si consegna ciò che si è contato', async () => {
    h.state.queues = {
      notifiche: [{ data: elenco(2), error: null }, { count: 2, error: null }],
      chat_threads: [{ data: null, error: { code: '42P01', message: 'relation does not exist' } }],
    }

    const res = await GET(req())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.chat_non_letti).toBeNull()
    expect(h.after).not.toHaveBeenCalled()
    expect(h.consegnaSeInAttesa).not.toHaveBeenCalled()
  })

  it('l\'uid è quello del GATE: un `?userId=` di query non consegna niente a nome altrui', async () => {
    h.state.queues = codeConNonLetti()

    await GET(req(`?userId=${UTENTE_ALTRUI}`))
    await eseguiGiro()

    expect(h.consegnaSeInAttesa.mock.calls[0][1].userId).toBe(UTENTE_DEL_GATE)
    expect(JSON.stringify(h.consegnaSeInAttesa.mock.calls[0][1])).not.toContain(UTENTE_ALTRUI)
  })

  it('`after()` che lancia (fuori da una richiesta): `warn`, e la risposta resta 200 identica', async () => {
    h.state.queues = codeConNonLetti()
    h.after.mockImplementation(() => { throw new Error('after() called outside a request scope') })

    const res = await GET(req())
    const body = await res.json()

    // La GET non diventa 500 per colpa della doppia spunta: è un contorno.
    expect(res.status).toBe(200)
    expect(Object.keys(body).sort()).toEqual(['chat_non_letti', 'data', 'non_lette', 'success'])
    expect(body.chat_non_letti).toBe(2)
    expect(body.non_lette).toBe(3)
    // Un `catch` che non logga è un bug: la consegna arriverà dal giro dopo, e si dice.
    expect(logChat('warn')).toEqual([
      expect.objectContaining({ operazione: 'notifiche:GET', esito: 'consegna-chat-non-programmata' }),
    ])
    expect(h.consegnaSeInAttesa).not.toHaveBeenCalled()
  })

  it('consegna che RIGETTA dentro il giro: il giro non propaga, logga, e la risposta era già andata', async () => {
    h.state.queues = codeConNonLetti()
    h.consegnaSeInAttesa.mockRejectedValue(new Error('fetch failed'))

    const res = await GET(req())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.chat_non_letti).toBe(2)

    // `after()` non ha nessuno che raccolga un rifiuto: il giro deve gestirlo di suo.
    await expect(eseguiGiro()).resolves.toBeUndefined()
    expect(
      (h.logEvento.mock.calls as Array<[string, string, Record<string, unknown>, unknown?]>)
        .filter((c) => c[0] === 'chat' && c[1] === 'error')
        .map((c) => c[2]),
    ).toEqual([
      expect.objectContaining({ operazione: 'notifiche:GET', esito: 'consegna-chat-eccezione' }),
    ])
  })

  it('la ROUTE non aggiunge righe sulla consegna riuscita: il log di consegna sta nella libreria', async () => {
    h.state.queues = codeConNonLetti()

    await GET(req())
    await eseguiGiro()

    expect(logChat('info')).toEqual([])
    expect(logChat('warn')).toEqual([])
    expect(logChat('error')).toEqual([])
    expect(h.logErrore).not.toHaveBeenCalled()
  })

  /**
   * ASPETTARE LA PRESENZA PRIMA DI ASSERIRE UN'ASSENZA.
   *
   * Sui due rami 500 la route esce SENZA attendere la promise della chat, che resta in volo. Un
   * `expect(after).not.toHaveBeenCalled()` subito dopo la risposta sarebbe vero comunque —
   * anche con un codice che programma la consegna appena il conteggio arriva, perché a quel
   * momento non è ancora arrivato. Si aspetta quindi che la `head`-query della chat sia stata
   * CONSUMATA, poi si lascia passare un macrotask perché la catena di promise che ne segue si
   * assesti, e solo allora si guarda se qualcuno ha programmato qualcosa.
   */
  async function ilConteggioChatEArrivato(): Promise<void> {
    await vi.waitFor(() => expect(h.state.used.chat_messages).toBe(1))
    await new Promise((r) => setTimeout(r, 0))
  }

  it('errore dell\'ELENCO → 500 come prima, e nessuna consegna programmata', async () => {
    h.state.queues = {
      notifiche: [{ data: null, error: { message: 'boom elenco', code: 'PGRST301' } }],
      chat_threads: [{ data: [{ id: 'th-1' }], error: null }],
      chat_messages: [{ count: 2, error: null }],
    }

    const res = await GET(req())

    expect(res.status).toBe(500)
    await ilConteggioChatEArrivato()
    expect(h.after).not.toHaveBeenCalled()
    expect(h.consegnaSeInAttesa).not.toHaveBeenCalled()
  })

  it('errore del CONTEGGIO delle notifiche → 500 come prima, e nessuna consegna programmata', async () => {
    h.state.queues = {
      notifiche: [
        { data: elenco(2), error: null },
        { count: null, error: { message: 'column notifiche.letta_il does not exist', code: '42703' } },
      ],
      chat_threads: [{ data: [{ id: 'th-1' }], error: null }],
      chat_messages: [{ count: 2, error: null }],
    }

    const res = await GET(req())

    expect(res.status).toBe(500)
    await ilConteggioChatEArrivato()
    expect(h.after).not.toHaveBeenCalled()
    expect(h.consegnaSeInAttesa).not.toHaveBeenCalled()
  })
})
