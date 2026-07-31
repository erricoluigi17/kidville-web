import { describe, it, expect, vi, beforeEach } from 'vitest'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, SEDE_E2E, NOME_SEDE_A, NOME_SEDE_B, NOME_SEDE_E2E } from '../fixtures/sedi'

/**
 * I RISOLUTORI DI DESTINATARI, DAVANTI A «NON SO QUALE SEDE».
 *
 * Audit 2026-07-31 (F6). Tre difetti nello stesso file, tutti della stessa
 * famiglia — il ramo «nessun destinatario» non lascia traccia:
 *
 *  1. `staffScuola(null)` esce alla PRIMA riga, PRIMA di tutta la strumentazione
 *     della funzione: sette catene `X ?? Y ?? scuolaUnicaReale()` finivano lì e
 *     nei log «non so a quale sede appartiene» e «avvisati tutti» si leggevano
 *     identici;
 *  2. `genitoriDiClassi` senza sede NON filtrava («se ho lo scope filtro,
 *     altrimenti no»: la forma fail-open che la regola vieta), mentre la gemella
 *     `genitoriDiScuola` negava — due semantiche opposte per lo stesso null;
 *  3. gli errori PostgREST venivano ignorati (`const { data } = await q`) e i
 *     `catch` erano muti: una query rotta si travestiva da «zero destinatari».
 *
 * Qui il finto client FILTRA davvero: «i genitori della sede A» è una proprietà
 * verificata, non asserita.
 */

const logEvento = vi.fn()
vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...a: unknown[]) => logEvento(...a),
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))

// I genitori di un alunno: `gen-<id alunno>`. Così la lista dei destinatari dice
// da quali BAMBINI è stata derivata, ed è leggibile nelle asserzioni.
vi.mock('@/lib/anagrafiche/legami', () => ({
  getGenitoriDiAlunni: vi.fn(async (_s: unknown, ids: string[]) => {
    const m = new Map<string, string[]>()
    for (const id of ids) m.set(id, [`gen-${id}`])
    return m
  }),
}))

import {
  staffScuola,
  genitoriDiClassi,
  genitoriDiScuola,
  scuolaUnicaReale,
  controparteThread,
} from '@/lib/notifiche/destinatari'

const RUOLI = ['admin', 'coordinator', 'segreteria']

/** Due bambini nella classe «2 ANNI», uno per sede: il nome-classe è omonimo. */
function dbConDueSedi(): DBFinto {
  return {
    alunni: [
      { id: 'al-a', classe_sezione: '2 ANNI', scuola_id: SEDE_A },
      { id: 'al-b', classe_sezione: '2 ANNI', scuola_id: SEDE_B },
    ],
    utenti: [
      { id: 'segr-a', ruolo: 'segreteria', role: 'segreteria', scuola_id: SEDE_A },
      { id: 'admin-x', ruolo: 'admin', role: 'admin', scuola_id: SEDE_A },
    ],
    utenti_scuole: [{ utente_id: 'admin-x', scuola_id: SEDE_B }],
    schools: [
      { id: SEDE_A, nome: NOME_SEDE_A },
      { id: SEDE_B, nome: NOME_SEDE_B },
      { id: SEDE_E2E, nome: NOME_SEDE_E2E },
    ],
  }
}

const logDi = (esito: string) =>
  logEvento.mock.calls.find((c) => (c[2] as { esito?: string })?.esito === esito)

beforeEach(() => logEvento.mockClear())

describe('staffScuola — sede non risolta', () => {
  it('sede null ⇒ [] E LO DICE (livello error): è il ramo che rendeva mute 7 catene', async () => {
    const db = dbConDueSedi()
    const letture: string[] = []
    const ids = await staffScuola(creaFintoSupabase(db, letture), null, RUOLI)

    expect(ids).toEqual([])
    // Nessuna query: si nega prima di leggere.
    expect(letture).toEqual([])
    const riga = logDi('sede-non-risolta')
    expect(riga).toBeDefined()
    expect(riga?.[0]).toBe('notifica')
    expect(riga?.[1]).toBe('error')
    // Mai PII nei log.
    expect(JSON.stringify(riga?.[2])).not.toMatch(/@/)
  })

  it('elenco ruoli vuoto ⇒ [] e una riga di log distinta (è un errore di programmazione)', async () => {
    const ids = await staffScuola(creaFintoSupabase(dbConDueSedi()), SEDE_A, [])
    expect(ids).toEqual([])
    expect(logDi('ruoli-non-indicati')).toBeDefined()
  })

  it('la sede la trova comunque dal ponte (regressione 2026-07-29, con un client che FILTRA)', async () => {
    const ids = await staffScuola(creaFintoSupabase(dbConDueSedi()), SEDE_B, RUOLI)
    // `admin-x` ha come sede primaria la A: sulla B ci arriva solo da `utenti_scuole`.
    expect(ids).toEqual(['admin-x'])
  })
})

describe('genitoriDiClassi — scope vuoto ⇒ nega', () => {
  it('sede nota ⇒ SOLO i genitori di quella sede (il nome-classe è omonimo)', async () => {
    const out = await genitoriDiClassi(creaFintoSupabase(dbConDueSedi()), SEDE_A, ['2 ANNI'])
    expect(out).toEqual(['gen-al-a'])
  })

  it('sede assente ⇒ [] + warn, NON «tutte le sedi» per omissione', async () => {
    const out = await genitoriDiClassi(creaFintoSupabase(dbConDueSedi()), null, ['2 ANNI'])
    expect(out).toEqual([])
    const riga = logDi('sede-non-risolta')
    expect(riga?.[0]).toBe('notifica')
    expect(riga?.[1]).toBe('warn')
  })

  it('«tutte le sedi» si CHIEDE, e allora arriva davvero a tutte', async () => {
    const out = await genitoriDiClassi(creaFintoSupabase(dbConDueSedi()), null, ['2 ANNI'], {
      tutteLeSedi: true,
    })
    expect([...out].sort()).toEqual(['gen-al-a', 'gen-al-b'])
    // Scelta esplicita del chiamante: non è un degrado, non si grida.
    expect(logDi('sede-non-risolta')).toBeUndefined()
  })

  it('query fallita ⇒ [] + error: una lettura rotta non si traveste da «zero destinatari»', async () => {
    const out = await genitoriDiClassi(
      creaFintoSupabase(dbConDueSedi(), [], { errori: { alunni: { code: '42703' } } }),
      SEDE_A,
      ['2 ANNI'],
    )
    expect(out).toEqual([])
    const riga = logDi('alunni-non-letti')
    expect(riga?.[1]).toBe('error')
  })
})

describe('genitoriDiScuola — la gemella, stessa semantica', () => {
  it('sede nota ⇒ i genitori della sola sede', async () => {
    const out = await genitoriDiScuola(creaFintoSupabase(dbConDueSedi()), SEDE_B)
    expect(out).toEqual(['gen-al-b'])
  })

  it('sede assente ⇒ [] + warn (prima taceva)', async () => {
    const out = await genitoriDiScuola(creaFintoSupabase(dbConDueSedi()), null)
    expect(out).toEqual([])
    expect(logDi('sede-non-risolta')?.[1]).toBe('warn')
  })

  it('query fallita ⇒ [] + error', async () => {
    const out = await genitoriDiScuola(
      creaFintoSupabase(dbConDueSedi(), [], { errori: { alunni: { code: '42703' } } }),
      SEDE_A,
    )
    expect(out).toEqual([])
    expect(logDi('alunni-non-letti')?.[1]).toBe('error')
  })
})

describe('scuolaUnicaReale — la primitiva mono-sede, ora deprecata', () => {
  it('con più sedi reali ⇒ null E una riga di log: il suo esito non è più «normale»', async () => {
    const out = await scuolaUnicaReale(creaFintoSupabase(dbConDueSedi()))
    expect(out).toBeNull()
    const riga = logDi('sede-non-univoca')
    expect(riga).toBeDefined()
    expect(riga?.[1]).toBe('warn')
  })

  it('una sola sede reale (+ la finta E2E) ⇒ quella, senza log di degrado', async () => {
    const db = dbConDueSedi()
    db.schools = [
      { id: SEDE_A, nome: NOME_SEDE_A },
      { id: SEDE_E2E, nome: NOME_SEDE_E2E },
    ]
    const out = await scuolaUnicaReale(creaFintoSupabase(db))
    expect(out).toBe(SEDE_A)
    expect(logDi('sede-non-univoca')).toBeUndefined()
  })
})

// =============================================================================
// W9 — `controparteThread`: l'ULTIMO catch muto del file.
//
// Era l'unica funzione che l'audit non aveva toccato: `catch { return null }` e
// la lettura di `chat_threads` senza guardare `{ error }` (PostgREST non lancia).
// Decide CHI riceve la notifica di un messaggio in chat: se fallisce, il
// messaggio viene salvato — 201 — e la notifica non parte. Il `try/catch` del
// chiamante (`chat/messages:POST`) non aiuta: questa funzione non lancia mai,
// quindi quel catch non scatta. Zero righe, e il genitore scopre il messaggio
// solo se apre la chat per caso.
// =============================================================================

describe('controparteThread — chi riceve la notifica di un messaggio', () => {
  const dbChat = (): DBFinto => ({
    chat_threads: [{ id: 'th-1', teacher_id: 'doc-1', parent_id: 'gen-1' }],
  })

  it('dal docente ⇒ il genitore, e viceversa (nessun log: è il percorso felice)', async () => {
    expect(await controparteThread(creaFintoSupabase(dbChat()), 'th-1', 'doc-1')).toEqual({
      utenteId: 'gen-1',
      versoGenitore: true,
    })
    expect(await controparteThread(creaFintoSupabase(dbChat()), 'th-1', 'gen-1')).toEqual({
      utenteId: 'doc-1',
      versoGenitore: false,
    })
    expect(logEvento).not.toHaveBeenCalled()
  })

  it('errore di lettura ⇒ null MA con una riga `error`: non si finge «nessuna controparte»', async () => {
    const supabase = creaFintoSupabase(dbChat(), [], {
      errori: { chat_threads: { code: '42501', message: 'permission denied' } },
    })
    expect(await controparteThread(supabase, 'th-1', 'doc-1')).toBeNull()
    const riga = logDi('controparte-non-risolta')
    expect(riga).toBeDefined()
    expect(riga?.[0]).toBe('notifica')
    expect(riga?.[1]).toBe('error')
    // L'errore del provider viaggia attaccato: codice e messaggio in tabella.
    expect(riga?.[3]).toMatchObject({ code: '42501' })
  })

  it('thread inesistente ⇒ null e un warn: la notifica non parte, e si sa perché', async () => {
    expect(await controparteThread(creaFintoSupabase(dbChat()), 'th-inesistente', 'doc-1')).toBeNull()
    expect(logDi('controparte-thread-assente')?.[1]).toBe('warn')
  })

  it('mittente estraneo al thread ⇒ null e un warn distinto', async () => {
    expect(await controparteThread(creaFintoSupabase(dbChat()), 'th-1', 'segreteria-9')).toBeNull()
    expect(logDi('controparte-non-nel-thread')?.[1]).toBe('warn')
  })

  it('eccezione vera (rete/DNS) ⇒ null e una riga `error`, mai un catch muto', async () => {
    const supabase = {
      from: () => {
        throw new Error('getaddrinfo ENOTFOUND')
      },
    } as never
    expect(await controparteThread(supabase, 'th-1', 'doc-1')).toBeNull()
    expect(logDi('controparte-non-risolta')?.[1]).toBe('error')
  })

  it('nessun log porta identificativi in chiaro oltre agli uuid tecnici', async () => {
    await controparteThread(creaFintoSupabase(dbChat()), 'th-1', 'segreteria-9')
    for (const c of logEvento.mock.calls) {
      expect(JSON.stringify(c[2])).not.toMatch(/@/)
    }
  })
})
