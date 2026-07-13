import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * LA CODA DELLE NOTIFICHE NON PUÒ FALLIRE IN SILENZIO.
 *
 * IL DIFETTO CHE QUESTI TEST BLOCCANO. `enqueueNotifiche` faceva
 *
 *     try { await supabase.from('notifiche').insert(rows) }
 *     catch (err) { console.error(…) }
 *
 * e `notificaEvento` avvolgeva tutto in un altro try/catch con dentro un altro console.error.
 * Ma **PostgREST non lancia: RITORNA `{ error }`** (regola 7 di AGENTS.md). Quei due catch non
 * sono mai scattati una volta: quando l'insert falliva non succedeva NIENTE — nessuna eccezione
 * verso le route, nessuna riga di log, nessuna notifica. La coda restava vuota e il sistema
 * sembrava sano. Un genitore non scopriva mai che il figlio aveva preso una nota, che la domanda
 * era stata respinta, che la mensa era sospesa. È lo stesso guasto silenzioso che in questo repo
 * ha già tenuto ferme le email per mesi.
 *
 * LA PROVA CHE IL VECCHIO CODICE NON LOGGAVA NIENTE è nel primo test: il finto PostgREST
 * RISOLVE con `{ error }` (`resolves`, non `rejects`) — esattamente come quello vero. Un catch
 * su una promise che risolve è codice morto per costruzione. Se qualcuno rimettesse il log solo
 * nel catch, quel test diventerebbe rosso.
 *
 * COME SI OSSERVA. Il logger è SILENZIOSO sotto vitest (`.env.local` punta al DB di PRODUZIONE:
 * una suite che scrive righe di log in produzione è un incidente, non un test), quindi non lo si
 * può ispezionare: si mocka con delle spie e si asserisce sulle CHIAMATE. Che una riga `error`
 * finisca davvero in `app_log` lo prova `vaPersistito`, quello VERO, nell'ultimo test.
 */

// ── Le spie sul logger ───────────────────────────────────────────────────────
const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => log)

// ── Il lookup dei destinatari, pilotabile ────────────────────────────────────
// Serve a un test solo, ma è quello che copre il ramo "esplode la PREPARAZIONE": è il caso in
// cui i 28 catch delle route restano legittimi, e va tenuto vivo.
const dest = vi.hoisted(() => ({ genitoriDiAlunni: vi.fn(async () => ['p1', 'p2'] as string[]) }))
vi.mock('@/lib/notifiche/destinatari', () => ({ genitoriDiAlunni: dest.genitoriDiAlunni }))

import { enqueueNotifiche } from '@/lib/push/enqueue'
import { notificaEvento, nomeUtente } from '@/lib/notifiche/triggers'

/**
 * L'errore come lo restituisce PostgREST davvero: un oggetto con `code`/`details`/`hint`, non un
 * `Error`. Sono i tre campi che dicono PERCHÉ — ed è il motivo per cui l'oggetto va passato
 * INTERO come 4° argomento al logger, mai riassunto con `String(e)`.
 */
const ERR_PG = {
  code: '23503',
  message: 'insert or update on table "notifiche" violates foreign key constraint',
  details: 'Key (utente_id)=(u1) is not present in table "utenti".',
  hint: null,
}

interface Opzioni {
  insertError?: unknown
  deleteError?: unknown
  insertLancia?: boolean
  utenteError?: unknown
}

/** Finto client: RISOLVE con `{ error }` — come PostgREST, che non solleva mai. */
function creaClient(opts: Opzioni = {}) {
  const inserts: Array<Record<string, unknown>> = []
  const deletes: Array<Record<string, unknown>> = []

  const supabase = {
    from(table: string) {
      const filtri: Record<string, unknown> = { table }
      const catena: Record<string, unknown> = {
        eq: (col: string, val: unknown) => { filtri[col] = val; return catena },
        is: async (col: string, val: unknown) => {
          filtri[col] = val
          deletes.push({ ...filtri })
          return { error: opts.deleteError ?? null }
        },
        maybeSingle: async () => ({
          data: opts.utenteError ? null : { nome: 'Mario', cognome: 'Rossi' },
          error: opts.utenteError ?? null,
        }),
      }
      return {
        select: () => catena,
        delete: () => catena,
        insert: async (rows: Array<Record<string, unknown>>) => {
          inserts.push(...rows)
          if (opts.insertLancia) throw new Error('fetch failed')
          return { error: opts.insertError ?? null }
        },
      }
    },
  } as unknown as SupabaseClient

  return { supabase, inserts, deletes }
}

/** Le righe emesse sul canale, filtrate per livello. */
function righe(livello: string): Array<{ evento: string; campi: Record<string, unknown>; err: unknown }> {
  return log.logEvento.mock.calls
    .filter((c) => c[1] === livello)
    .map((c) => ({ evento: c[0] as string, campi: c[2] as Record<string, unknown>, err: c[3] }))
}

beforeEach(() => {
  vi.clearAllMocks()
  dest.genitoriDiAlunni.mockResolvedValue(['p1', 'p2'])
})

// ═════════════════════════════════════════════════════════════════════════════
describe('enqueueNotifiche — l\'insert che falliva in silenzio', () => {
  it('il finto PostgREST RISOLVE con { error }: è la prova che il vecchio catch era codice morto', async () => {
    const { supabase } = creaClient({ insertError: ERR_PG })
    // `resolves`, non `rejects`. Nessun `catch` può vedere questo errore: chi lo voleva loggare
    // di lì scriveva codice che non gira. L'unico modo di accorgersene è il VALORE DI RITORNO.
    await expect(supabase.from('notifiche').insert([{ utente_id: 'u1' }] as never))
      .resolves.toEqual({ error: ERR_PG })
  })

  it('insert fallito → UNA riga di log `error` con l\'errore PostgREST INTERO', async () => {
    const { supabase } = creaClient({ insertError: ERR_PG })

    await enqueueNotifiche(supabase, { utenteIds: ['u1', 'u2'], tipo: 'nota_disciplinare', titolo: 'T' })

    const errori = righe('error')
    expect(errori).toHaveLength(1)
    expect(errori[0].evento).toBe('notifica')
    expect(errori[0].campi).toMatchObject({
      operazione: 'enqueueNotifiche',
      esito: 'insert-fallito',
      tipo: 'nota_disciplinare',
      n: 2, // quante notifiche sono andate perse, non solo che sono andate perse
    })
    // L'oggetto intero, non un riassunto: `code`, `details` e `hint` devono arrivare al logger.
    expect(errori[0].err).toBe(ERR_PG)
  })

  it('insert fallito → non lancia comunque verso il chiamante (il contratto best-effort regge)', async () => {
    const { supabase } = creaClient({ insertError: ERR_PG })
    await expect(
      enqueueNotifiche(supabase, { utenteIds: ['u1'], tipo: 'avviso', titolo: 'T' })
    ).resolves.toBeUndefined()
  })

  it('insert riuscito → nessuna riga di errore (il log non fa rumore quando tutto va)', async () => {
    const { supabase, inserts } = creaClient()
    await enqueueNotifiche(supabase, { utenteIds: ['u1'], tipo: 'avviso', titolo: 'T' })
    expect(inserts).toHaveLength(1)
    expect(righe('error')).toHaveLength(0)
    expect(righe('warn')).toHaveLength(0)
  })

  it('guasto di TRASPORTO (il fetch lancia) → riga `error`, e nessuna eccezione fuori', async () => {
    const { supabase } = creaClient({ insertLancia: true })
    await expect(
      enqueueNotifiche(supabase, { utenteIds: ['u1'], tipo: 'avviso', titolo: 'T' })
    ).resolves.toBeUndefined()

    const errori = righe('error')
    expect(errori).toHaveLength(1)
    expect(errori[0].campi).toMatchObject({ operazione: 'enqueueNotifiche', esito: 'insert-non-eseguito' })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('notificaEvento — best-effort NON vuol dire invisibile', () => {
  it('l\'insert fallito in fondo alla catena emerge come riga di log (e la route non se ne accorge)', async () => {
    const { supabase } = creaClient({ insertError: ERR_PG })

    // È lo scenario reale: la route chiama `notificaEvento`, che non lancia mai. Se il log non
    // nascesse ALLA SORGENTE, di questo guasto non resterebbe traccia da nessuna parte.
    await expect(
      notificaEvento(supabase, { tipo: 'nota_disciplinare', scuolaId: null, alunnoIds: ['a1'], titolo: 'T' })
    ).resolves.toBeUndefined()

    const errori = righe('error')
    expect(errori).toHaveLength(1)
    expect(errori[0].campi).toMatchObject({ operazione: 'enqueueNotifiche', esito: 'insert-fallito', n: 2 })
  })

  it('debounce fallito → `warn` (la notifica parte lo stesso: una in più, non una in meno)', async () => {
    const { supabase, inserts } = creaClient({ deleteError: ERR_PG })

    await notificaEvento(supabase, {
      tipo: 'chat_genitore', scuolaId: null, utenteIds: ['p1'], titolo: 'T', entitaId: 'th1', debounce: true,
    })

    const avvisi = righe('warn')
    expect(avvisi).toHaveLength(1)
    expect(avvisi[0].evento).toBe('notifica')
    expect(avvisi[0].campi).toMatchObject({ operazione: 'notificaEvento', esito: 'debounce-fallito' })
    expect(avvisi[0].err).toBe(ERR_PG)
    // E il punto del livello `warn`: il risultato è SALVO — l'enqueue è avvenuto lo stesso.
    expect(inserts).toHaveLength(1)
    expect(righe('error')).toHaveLength(0)
  })

  it('la PREPARAZIONE esplode (lookup destinatari) → `error`, e nessuna eccezione verso la route', async () => {
    dest.genitoriDiAlunni.mockRejectedValue(new Error('connessione persa'))
    const { supabase, inserts } = creaClient()

    await expect(
      notificaEvento(supabase, { tipo: 'avviso', scuolaId: null, alunnoIds: ['a1'], titolo: 'T' })
    ).resolves.toBeUndefined()

    const errori = righe('error')
    expect(errori).toHaveLength(1)
    expect(errori[0].campi).toMatchObject({ operazione: 'notificaEvento', esito: 'notifica-non-accodata' })
    expect(inserts).toHaveLength(0)
  })

  it('tutto a posto → nessuna riga di guasto', async () => {
    const { supabase, inserts } = creaClient()
    await notificaEvento(supabase, { tipo: 'avviso', scuolaId: null, utenteIds: ['p1'], titolo: 'T' })
    expect(inserts).toHaveLength(1)
    expect(righe('error')).toHaveLength(0)
    expect(righe('warn')).toHaveLength(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('nomeUtente — il catch muto', () => {
  it('lettura fallita → `warn` (la notifica parte col nome generico) e ritorna null', async () => {
    const { supabase } = creaClient({ utenteError: ERR_PG })

    expect(await nomeUtente(supabase, 'u1')).toBeNull()

    const avvisi = righe('warn')
    expect(avvisi).toHaveLength(1)
    expect(avvisi[0].campi).toMatchObject({ operazione: 'nomeUtente', esito: 'utente-non-letto' })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('la riga finisce davvero in app_log', () => {
  it('`vaPersistito` VERO: un `error` su evento `notifica` viene persistito', async () => {
    // Non la spia: il modulo vero. Se un domani la politica dei livelli cambiasse e gli `error`
    // smettessero di finire in tabella, tutto il lavoro qui sopra tornerebbe a essere fumo — e
    // ce ne accorgeremmo qui, non in produzione.
    const logger = await vi.importActual<typeof import('@/lib/logging/logger')>('@/lib/logging/logger')
    expect(logger.vaPersistito('error', 'notifica')).toBe(true)
    expect(logger.vaPersistito('warn', 'notifica')).toBe(true)
  })
})
