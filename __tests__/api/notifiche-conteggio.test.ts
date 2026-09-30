import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock generico: builder thenable (risolve per-tabella FIFO) + registro chiamate.
// Stessa forma di `push-dispatch.test.ts`, con una differenza che è tutto il punto
// del file: la voce in coda può portare anche `count`, perché la `head`-query del
// conteggio ritorna `{ count, error }` e NON `{ data }`.
const h = vi.hoisted(() => {
  const state = {
    queues: {} as Record<string, Array<{ data?: unknown; count?: number | null; error: unknown }>>,
    used: {} as Record<string, number>,
    calls: [] as Array<{ table: string; m: string; args: unknown[] }>,
  }
  function take(table: string) {
    const q = state.queues[table] || []
    const i = state.used[table] ?? 0
    state.used[table] = i + 1
    return q[i] ?? { data: [], error: null }
  }
  function makeClient() {
    return {
      from(table: string) {
        const qb: Record<string, unknown> = {}
        const rec = (m: string) => (...args: unknown[]) => { state.calls.push({ table, m, args }); return qb }
        // `neq` è entrato il 2026-09-29 con il conteggio della chat: senza, la catena
        // `select().in().neq().is()` di `leggiChatNonLetti` alza un TypeError, che il suo
        // `catch` inghiotte restituendo `null`. Lo prenderebbe soltanto il caso della chat più
        // in basso: gli altri non hanno thread in coda e non arrivano mai a `neq`.
        for (const m of ['select', 'is', 'or', 'order', 'limit', 'in', 'neq', 'update', 'delete', 'eq']) qb[m] = rec(m)
        qb.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(take(table)).then(res, rej)
        return qb
      },
    }
  }
  return { state, makeClient }
})

// `after` è l'UNICA cosa sostituita di `next/server` (`NextResponse` resta quello vero).
// Non è un finto di comodo: con `chat_non_letti > 0` la route programma DOPO la risposta la
// consegna «delivered» della chat, e in vitest — fuori da un contesto di richiesta — `after()`
// LANCIA. Senza questa riga il suo warn comparirebbe fra i `logEvento('chat','warn',…)` del
// caso felice qui sotto, che pretende zero warn: un guasto d'AMBIENTE dentro il file che parla
// del conteggio. Qui il giro viene solo registrato e mai eseguito; la consegna ha i suoi test
// in `notifiche-consegna-chat.test.ts`, compreso il caso di `after()` indisponibile.
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: vi.fn(),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn().mockResolvedValue(h.makeClient()),
}))
const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => log)
const auth = vi.hoisted(() => ({ requireUser: vi.fn() }))
vi.mock('@/lib/auth/require-staff', () => auth)

import { GET } from '@/app/api/notifiche/route'

function req(qs = ''): Request {
  return new Request(`http://localhost/api/notifiche${qs}`)
}

/** Un elenco di `n` notifiche non lette, come lo restituirebbe PostgREST. */
function elenco(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `n${i}`, tipo: 't', titolo: 'x', corpo: null, link: null,
    entita_tipo: null, entita_id: null, letta_il: null, creato_il: '2026-08-03T00:00:00Z',
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.queues = {}
  h.state.used = {}
  h.state.calls = []
  // Un UUID, non più `'u1'`: dal 2026-09-29 `leggiChatNonLetti` rifiuta un `utenteId` che non
  // sia un uuid (quella stringa entra in un filtro PostgREST interpolato), e con `'u1'` la
  // chat tornava `null` senza toccare il database. Il gate in produzione dà sempre un uuid:
  // la finzione si allinea alla realtà, non il codice alla finzione.
  auth.requireUser.mockResolvedValue({
    response: null,
    user: { id: 'aaaaaaaa-0000-4000-8000-000000000001' },
  })
})

/**
 * T17-F2 — IL BADGE SI FERMAVA A 100, E NESSUN TEST LO VEDEVA.
 *
 * `non_lette` si ricavava filtrando l'array dell'ELENCO, che è tagliato a
 * `LIMITE_ELENCO = 100`: era quindi il minimo fra le non lette vere e 100. Su un
 * account reale con 268 non lette il badge diceva 100 e 168 restavano invisibili;
 * e leggendone una il numero non si muoveva, il che è indistinguibile da una
 * campanella rotta.
 *
 * La correzione dà al conteggio una `head`-query sua. Questi casi la tengono ferma:
 * finché il conteggio non è UNA QUERY SEPARATA, il primo caso è rosso.
 */
describe('GET /api/notifiche — il conteggio non è la lunghezza della lista', () => {
  it('268 non lette con l’elenco tagliato a 100 → non_lette = 268, non 100', async () => {
    h.state.queues = {
      notifiche: [
        { data: elenco(100), error: null }, // l'elenco, tagliato dal LIMITE
        { count: 268, error: null },        // la head-query del conteggio
      ],
    }
    const res = await GET(req())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data).toHaveLength(100)
    // IL NUMERO CHE CONTA: viene dal conteggio, non dalla lista.
    expect(body.non_lette).toBe(268)
  })

  it('il conteggio è una query SUA, con count exact e head (nessuna riga trasferita)', async () => {
    h.state.queues = {
      notifiche: [
        { data: elenco(3), error: null },
        { count: 3, error: null },
      ],
    }
    await GET(req())

    // Due `select` distinti sulla stessa tabella: l'elenco e il conteggio.
    const select = h.state.calls.filter((c) => c.table === 'notifiche' && c.m === 'select')
    expect(select).toHaveLength(2)
    // Il secondo porta le opzioni della head-query: senza `head: true` il conteggio
    // trasferirebbe l'archivio intero a ogni poll (60 s).
    expect(select[1].args[1]).toMatchObject({ count: 'exact', head: true })
  })

  /**
   * L'UNICO CASO DI QUESTO FILE CHE PERCORRE DAVVERO LA CATENA DELLA CHAT.
   *
   * Dal 2026-09-29 la GET conta anche i messaggi di chat non letti. I tre casi qui sopra non
   * mettono thread in coda: `chat_threads` risponde con l'elenco vuoto del default, la
   * funzione prende la scorciatoia («nessuna conversazione → 0») e non arriva mai a
   * `chat_messages`. Sono verdi, ma della chat non provano niente — e non si accorgerebbero
   * nemmeno che al builder finto mancava `neq`.
   *
   * Questo caso invece i thread ce li mette: pretende il numero E l'assenza di qualunque
   * `warn` sul canale `chat`, che è il segno di una catena caduta nel `catch`. È la lezione
   * già visto in `chat-messages-auth.test.ts`, che restò verde su un finto senza `.or`.
   */
  it('il percorso felice porta anche `chat_non_letti`, senza un solo warn della chat', async () => {
    h.state.queues = {
      notifiche: [{ data: elenco(5), error: null }, { count: 5, error: null }],
      chat_threads: [{ data: [{ id: 'th-1' }], error: null }],
      chat_messages: [{ count: 2, error: null }],
    }
    const res = await GET(req())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.chat_non_letti).toBe(2)
    expect(
      log.logEvento.mock.calls.filter((c) => c[0] === 'chat' && c[1] === 'warn'),
      'un warn della chat su un percorso felice: la catena finta non regge quella vera',
    ).toEqual([])
  })

  it('conteggio fallito → 500 con codice, e MAI il messaggio grezzo del database', async () => {
    h.state.queues = {
      notifiche: [
        { data: elenco(2), error: null },
        { count: null, error: { message: 'column notifiche.letta_il does not exist', code: '42703' } },
      ],
    }
    const res = await GET(req())
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.codice).toBe('NOTIFICHE_CONTEGGIO_NON_LETTO')
    // Prosa inglese e nomi di colonna non escono verso una segretaria.
    expect(JSON.stringify(body)).not.toContain('does not exist')
    expect(JSON.stringify(body)).not.toContain('letta_il')
    // Ma il corpo dell'errore resta nel log: è la regola 3 di AGENTS.md.
    expect(log.logEvento).toHaveBeenCalledWith(
      'notifica',
      'error',
      expect.objectContaining({ esito: 'conteggio-non-letto' }),
      expect.objectContaining({ code: '42703' }),
    )
  })
})
