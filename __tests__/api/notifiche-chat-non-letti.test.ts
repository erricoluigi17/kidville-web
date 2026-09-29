import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * `GET /api/notifiche` PORTA ANCHE IL NUMERO DEI MESSAGGI DI CHAT NON LETTI.
 *
 * Segnalazione del 2026-09-29: i messaggi arrivano, ma fuori dalla pagina «Messaggi» l'app
 * non dice mai che ci sono. Il numero viaggia QUI perché la campanella interroga già questa
 * route all'apertura e ogni 60 s: nessuna richiesta HTTP in più.
 *
 * Le due promesse che questo file tiene ferme:
 *  · la GET non risponde MAI 500 per colpa della chat (gli E2E si aspettano una risposta ok);
 *  · il conteggio usa l'identità del GATE, non un `?userId=`.
 */

// Mock generico: builder thenable (risolve per-tabella FIFO) + registro chiamate. Stessa
// forma di `notifiche-conteggio.test.ts`, con DUE aggiunte che sono il punto del file:
// `neq` (senza, la catena della chat esplode e il verde sarebbe per la ragione sbagliata) e
// le code di `chat_threads`/`chat_messages`. Una voce in coda può essere una PROMISE
// pendente: è così che si dimostra il parallelismo.
const h = vi.hoisted(() => {
  const state = {
    queues: {} as Record<string, Array<unknown>>,
    used: {} as Record<string, number>,
    calls: [] as Array<{ table: string; m: string; args: unknown[] }>,
  }
  function take(table: string) {
    const q = state.queues[table] || []
    const i = state.used[table] ?? 0
    state.used[table] = i + 1
    return q[i] ?? { data: [], count: 0, error: null }
  }
  function makeClient() {
    return {
      from(table: string) {
        const qb: Record<string, unknown> = {}
        const rec = (m: string) => (...args: unknown[]) => { state.calls.push({ table, m, args }); return qb }
        for (const m of ['select', 'is', 'or', 'order', 'limit', 'in', 'neq', 'update', 'delete', 'eq']) qb[m] = rec(m)
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
const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => log)
const auth = vi.hoisted(() => ({ requireUser: vi.fn() }))
vi.mock('@/lib/auth/require-staff', () => auth)

import { GET } from '@/app/api/notifiche/route'

const UTENTE_DEL_GATE = 'aaaaaaaa-0000-4000-8000-000000000001'
const UTENTE_ALTRUI = 'bbbbbbbb-0000-4000-8000-000000000002'

function req(qs = ''): Request {
  return new Request(`http://localhost/api/notifiche${qs}`)
}

/** Un elenco di `n` notifiche, come lo restituirebbe PostgREST. */
function elenco(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `n${i}`, tipo: 't', titolo: 'x', corpo: null, link: null,
    entita_tipo: null, entita_id: null, letta_il: null, creato_il: '2026-09-29T00:00:00Z',
  }))
}

/** I `warn` della chat emessi in questo giro. */
function warnChat() {
  return (log.logEvento.mock.calls as Array<[string, string, Record<string, unknown>]>)
    .filter((c) => c[0] === 'chat' && c[1] === 'warn')
    .map((c) => c[2])
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.queues = {}
  h.state.used = {}
  h.state.calls = []
  auth.requireUser.mockResolvedValue({ response: null, user: { id: UTENTE_DEL_GATE } })
})

describe('GET /api/notifiche — `chat_non_letti` accanto a `non_lette`', () => {
  it('la risposta porta i quattro campi, e `chat_non_letti` è la somma dei blocchi', async () => {
    h.state.queues = {
      notifiche: [{ data: elenco(3), error: null }, { count: 9, error: null }],
      chat_threads: [{ data: [{ id: 'th-1' }, { id: 'th-2' }], error: null }],
      chat_messages: [{ count: 4, error: null }],
    }

    const res = await GET(req())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(Object.keys(body).sort()).toEqual(['chat_non_letti', 'data', 'non_lette', 'success'])
    expect(body.success).toBe(true)
    expect(body.data).toHaveLength(3)
    expect(body.non_lette).toBe(9)
    expect(body.chat_non_letti).toBe(4)
    // PERCORSO FELICE: nessun warn della chat. Senza questa riga il file resterebbe verde
    // anche se la catena della chat esplodesse nel `catch` del modulo — che è esattamente
    // com'è successo al passo precedente con un finto senza `.or`.
    expect(warnChat()).toEqual([])
  })

  it('conta con l\'identità del GATE: un `?userId=` di query non conta', async () => {
    h.state.queues = {
      notifiche: [{ data: elenco(1), error: null }, { count: 1, error: null }],
      chat_threads: [{ data: [{ id: 'th-1' }], error: null }],
      chat_messages: [{ count: 2, error: null }],
    }

    const res = await GET(req(`?userId=${UTENTE_ALTRUI}`))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.chat_non_letti).toBe(2)

    const or = h.state.calls.find((c) => c.table === 'chat_threads' && c.m === 'or')
    expect(or?.args[0]).toBe(`teacher_id.eq.${UTENTE_DEL_GATE},parent_id.eq.${UTENTE_DEL_GATE}`)
    const neq = h.state.calls.find((c) => c.table === 'chat_messages' && c.m === 'neq')
    expect(neq?.args).toEqual(['sender_id', UTENTE_DEL_GATE])
    // L'id altrui non finisce in NESSUN filtro.
    expect(JSON.stringify(h.state.calls)).not.toContain(UTENTE_ALTRUI)
  })

  it('la chat conta sui MESSAGGI, non sulle notifiche', async () => {
    h.state.queues = {
      notifiche: [{ data: elenco(2), error: null }, { count: 2, error: null }],
      chat_threads: [{ data: [{ id: 'th-1' }], error: null }],
      chat_messages: [{ count: 5, error: null }],
    }

    const res = await GET(req())
    const body = await res.json()

    // Una notifica di chat copre una raffica di messaggi (debounce per thread): il numero
    // delle notifiche non è il numero dei messaggi. Qui `non_lette` è 2 e i messaggi 5.
    expect(body.non_lette).toBe(2)
    expect(body.chat_non_letti).toBe(5)
    expect(h.state.calls.some((c) => c.table === 'chat_messages' && c.m === 'select')).toBe(true)
  })

  it('errore della CHAT → 200 con `chat_non_letti: null`, `data` e `non_lette` intatti', async () => {
    h.state.queues = {
      notifiche: [{ data: elenco(4), error: null }, { count: 12, error: null }],
      chat_threads: [{ data: null, error: { code: '42P01', message: 'relation does not exist' } }],
    }

    const res = await GET(req())
    const body = await res.json()

    // LA GET NON RISPONDE MAI 500 PER COLPA DELLA CHAT: la campanella è il suo lavoro vero.
    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data).toHaveLength(4)
    expect(body.non_lette).toBe(12)
    // `null` e non 0: il client tiene l'ultimo valore noto invece di dire «hai letto tutto».
    expect(body.chat_non_letti).toBeNull()
    expect('chat_non_letti' in body).toBe(true)
    expect(warnChat()).toEqual([
      { operazione: 'notifiche:GET', esito: 'chat-non-letti-non-contati' },
    ])
  })

  it('la chat parte in PARALLELO: le query delle notifiche non l\'aspettano', async () => {
    // La lettura dei thread resta APPESA. Se il codice la attendesse prima di interrogare
    // `notifiche`, qui non ci sarebbe ancora nessun `select` sulle notifiche.
    let sblocca: (v: unknown) => void = () => {}
    const appesa = new Promise((r) => { sblocca = r })
    h.state.queues = {
      notifiche: [{ data: elenco(2), error: null }, { count: 2, error: null }],
      chat_threads: [appesa],
      chat_messages: [{ count: 3, error: null }],
    }

    const inVolo = GET(req())
    await new Promise((r) => setTimeout(r, 0))

    const selectNotifiche = h.state.calls.filter((c) => c.table === 'notifiche' && c.m === 'select')
    expect(
      selectNotifiche,
      'le query delle notifiche non sono partite finché la chat era appesa: il conteggio è in serie e allunga la risposta',
    ).toHaveLength(2)

    sblocca({ data: [{ id: 'th-1' }], error: null })
    const res = await inVolo
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.non_lette).toBe(2)
    // E il numero della chat è comunque ATTESO prima di rispondere, non perso per strada.
    expect(body.chat_non_letti).toBe(3)
  })

  it('la chat è GIÀ PARTITA mentre l\'elenco delle notifiche è ancora in volo', async () => {
    // LO SPECULARE DEL CASO QUI SOPRA, e serve per forza: quello vede solo la chat ATTESA
    // troppo presto. Resterebbe verde se il conteggio venisse avviato DOPO le due query delle
    // notifiche (tutto in serie: quattro giri di database invece di due), o dopo il controllo
    // d'errore dell'elenco. Qui è l'ELENCO a restare appeso, e si pretende che l'`or` sulla
    // chat sia già partito: le due letture devono essere in volo insieme.
    let sbloccaElenco: (v: unknown) => void = () => {}
    const elencoAppeso = new Promise((r) => { sbloccaElenco = r })
    h.state.queues = {
      notifiche: [elencoAppeso, { count: 2, error: null }],
      chat_threads: [{ data: [{ id: 'th-1' }], error: null }],
      chat_messages: [{ count: 3, error: null }],
    }

    const inVolo = GET(req())
    await new Promise((r) => setTimeout(r, 0))
    const partita = h.state.calls.some((c) => c.table === 'chat_threads' && c.m === 'or')

    // Si sblocca PRIMA di asserire: se l'asserzione cade, niente resta appeso e il test si
    // chiude comunque invece di finire in timeout.
    sbloccaElenco({ data: elenco(2), error: null })
    const res = await inVolo
    const body = await res.json()

    expect(
      partita,
      'con l\'elenco ancora in volo la chat non era partita: il conteggio è in serie e aggiunge un giro',
    ).toBe(true)
    expect(res.status).toBe(200)
    expect(body.chat_non_letti).toBe(3)
  })

  it('errore dell\'ELENCO → 500 come prima, e il rigetto della chat non resta a terra', async () => {
    // Il ritorno anticipato non attende la promise della chat: se `leggiChatNonLetti`
    // potesse rigettare, quello sarebbe un rifiuto non gestito. Non rigetta — lo prova il
    // warn qui sotto, emesso dal suo `catch`.
    const caduta = Promise.reject(new Error('fetch failed'))
    // Un `catch` in più sulla STESSA promise: serve a vitest, non al codice sotto test. Senza,
    // un giorno in cui il codice non arrivasse a consumarla il file annegherebbe in un
    // «unhandled rejection» del test — che maschererebbe l'asserzione vera.
    caduta.catch(() => {})
    h.state.queues = {
      notifiche: [{ data: null, error: { message: 'boom elenco', code: 'PGRST301' } }],
      chat_threads: [caduta],
    }

    const res = await GET(req())
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.error).toBe('boom elenco')
    expect(body.chat_non_letti).toBeUndefined()
    // La query della chat è comunque PARTITA (è lanciata prima dell'await dell'elenco) e il
    // suo guasto è stato gestito dentro il modulo.
    expect(h.state.calls.some((c) => c.table === 'chat_threads')).toBe(true)
    expect(warnChat()).toEqual([
      { operazione: 'notifiche:GET', esito: 'chat-non-letti-non-contati' },
    ])
    expect(log.logEvento).toHaveBeenCalledWith(
      'notifica',
      'error',
      expect.objectContaining({ esito: 'elenco-non-letto' }),
      expect.objectContaining({ code: 'PGRST301' }),
    )
  })

  it('errore del CONTEGGIO → 500 con il codice, invariato', async () => {
    h.state.queues = {
      notifiche: [
        { data: elenco(2), error: null },
        { count: null, error: { message: 'column notifiche.letta_il does not exist', code: '42703' } },
      ],
      chat_threads: [{ data: [{ id: 'th-1' }], error: null }],
      chat_messages: [{ count: 1, error: null }],
    }

    const res = await GET(req())
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.codice).toBe('NOTIFICHE_CONTEGGIO_NON_LETTO')
    expect(JSON.stringify(body)).not.toContain('does not exist')
    // Nessun numero di chat in una risposta d'errore: il client non la legge.
    expect(body.chat_non_letti).toBeUndefined()
  })

  it('nessuna conversazione → `chat_non_letti: 0` e nessuna query sui messaggi', async () => {
    h.state.queues = {
      notifiche: [{ data: elenco(1), error: null }, { count: 1, error: null }],
      chat_threads: [{ data: [], error: null }],
    }

    const res = await GET(req())
    const body = await res.json()

    expect(body.chat_non_letti).toBe(0)
    expect(h.state.calls.some((c) => c.table === 'chat_messages')).toBe(false)
    expect(warnChat()).toEqual([])
  })
})
