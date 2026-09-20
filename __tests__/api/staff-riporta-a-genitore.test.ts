import { describe, it, expect, vi, beforeEach } from 'vitest'

/* ═══════════════════════════════════════════════════════════════════════════════
 * `admin/staff/riporta-a-genitore` — toglie la veste, non l'account
 *
 * ⚠️ L'ORDINE È IL CONTRATTO, e per questo si asserisce sulla SEQUENZA delle
 * scritture e non solo sul risultato. Non c'è transazione fra `utenti`, lo
 * Storage e la RPC: dei due guasti a metà possibili si è scelto il reversibile
 * — fermarsi dopo il ruolo e prima del fascicolo lascia una genitrice con una
 * scheda del personale, che si vede e si ri-cancella; il verso opposto lascia
 * una docente in servizio senza fascicolo, che non si vede e non si recupera.
 *
 * ─── PROVA PER ROTTURA — eseguita il 2026-09-20 ───────────────────────────────
 *   • tolto `.eq('ruolo', ruoloGrezzo)` dalla CAS del ruolo        → 1 rosso
 *   • tolta la guardia «senza ponte parents»                       → 1 rosso
 *   • spostata la cancellazione del fascicolo PRIMA del ruolo      → 1 rosso
 *   • tolto `gradi: []` dall'aggiornamento                         → 1 rosso
 *
 * ⚠️ LA PRIMA RIGA DICEVA 1 MENTRE ERANO 0, e la correzione non è stata
 * abbassare il numero: togliere il CAS lasciava la suite VERDE perché il test
 * che lo difende non esisteva. È esattamente il difetto che la prova per rottura
 * serve a trovare — un presidio scritto, commentato e mai misurato. Il test
 * «IL CAS: se il ruolo cambia fra lettura e scrittura» è nato da lì, e simula la
 * corsa dove avviene: fra la lettura del bersaglio e la scrittura del ruolo.
 * ═══════════════════════════════════════════════════════════════════════════════ */

const h = vi.hoisted(() => ({
  attore: {
    id: 'a0000000-0000-4000-8000-00000000000a',
    role: 'admin',
    ruoli: ['admin'],
    scuola_id: 'e0000000-0000-4000-8000-0000000000e1',
  } as Record<string, unknown>,
  ordine: [] as string[],
  rpcChiamate: [] as { nome: string; args: unknown }[],
  /** Simula la corsa: qualcuno cambia il ruolo fra la lettura e la scrittura. */
  corsaSulRuolo: false,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: vi.fn(async () => ({ user: h.attore })) }))
vi.mock('@/lib/auth/scope', () => ({
  assertUtenteInScope: vi.fn(async () => null),
  assertAlunnoInScope: vi.fn(async () => null),
  scuoleDiUtente: vi.fn(async () => ['e0000000-0000-4000-8000-0000000000e1']),
}))
vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn(async () => {}) }))
vi.mock('@/lib/storage/rimozione-verificata', () => ({
  rimuoviEVerifica: vi.fn(async (_s: unknown, _b: string, percorsi: string[]) => {
    h.ordine.push('storage.remove')
    return { rimossi: percorsi, giaAssenti: [], ancoraPresenti: [], incerti: [], erroreRimozione: false }
  }),
  bloccanti: () => [],
}))

import { creaFintoSupabaseConProiezione } from '../fixtures/proiezione'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'

const BERSAGLIO = 'b0000000-0000-4000-8000-0000000000b1'
const SEDE = 'e0000000-0000-4000-8000-0000000000e1'
const PRATICA = 'c0000000-0000-4000-8000-0000000000c1'

let db: DBFinto
let scritture: Scrittura[]
let proiezioni: { tabella: string; colonne: string }[]

function dbBase(): DBFinto {
  return {
    utenti: [
      {
        id: BERSAGLIO,
        nome: 'X',
        cognome: 'Y',
        email: 'x@y.z',
        cellulare: null,
        ruolo: 'educator',
        role: 'educator',
        scuola_id: SEDE,
        gradi: ['primaria'],
      },
    ],
    parents: [{ id: 'p-1', auth_user_id: BERSAGLIO }],
    anagrafica_personale: [
      {
        utente_id: BERSAGLIO,
        origine_pratica_id: PRATICA,
        documento_fronte_path: 'p/fronte.jpg',
        documento_retro_path: 'p/retro.jpg',
      },
    ],
    pratiche_personale: [{ id: PRATICA, stato: 'approvata', documento_fronte_path: null, documento_retro_path: null }],
    utenti_sezioni: [],
    utenti_sezioni_materie: [],
    utenti_scuole: [],
    orario_settimanale: [],
    task_interni: [],
  }
}

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => {
    const client = creaFintoSupabaseConProiezione(db, [], { scritture }, proiezioni)
    const from = (client as unknown as { from: (t: string) => Record<string, unknown> }).from.bind(client)
    ;(client as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      const b = from(t)
      // La CORSA, simulata dove avviene davvero: fra la lettura del bersaglio e
      // la scrittura del ruolo. Appena la route ha letto `utenti`, qualcun altro
      // porta quella riga a `segreteria`. Il `.eq('ruolo', ruoloGrezzo)` della
      // CAS deve allora trovare zero righe — e senza quel filtro la scrittura
      // passerebbe, sovrascrivendo in silenzio la decisione di un collega.
      if (t === 'utenti' && h.corsaSulRuolo) {
        const orig = (b.maybeSingle as () => Promise<unknown>).bind(b)
        b.maybeSingle = async () => {
          const r = await orig()
          db.utenti[0].ruolo = 'segreteria'
          db.utenti[0].role = 'segreteria'
          h.corsaSulRuolo = false
          return r
        }
      }
      for (const op of ['delete', 'update'] as const) {
        const orig = (b[op] as (...a: unknown[]) => unknown).bind(b)
        b[op] = (...a: unknown[]) => {
          h.ordine.push(`${t}.${op}`)
          return orig(...a)
        }
      }
      return b
    }
    ;(client as unknown as Record<string, unknown>).rpc = async (nome: string, args: unknown) => {
      h.ordine.push(`rpc.${nome}`)
      h.rpcChiamate.push({ nome, args })
      return { data: { pratiche_cancellate: 1, anagrafiche_cancellate: 1 }, error: null }
    }
    return client
  },
}))

import { POST } from '@/app/api/admin/staff/riporta-a-genitore/route'

const richiesta = (corpo: unknown) =>
  new Request('http://localhost/api/admin/staff/riporta-a-genitore', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
  })

const corpoValido = { utenteId: BERSAGLIO, conferma: true as const }

beforeEach(() => {
  vi.clearAllMocks()
  db = dbBase()
  scritture = []
  proiezioni = []
  h.ordine = []
  h.rpcChiamate = []
  h.corsaSulRuolo = false
  h.attore = { id: 'a0000000-0000-4000-8000-00000000000a', role: 'admin', ruoli: ['admin'], scuola_id: SEDE }
})

describe('il caso vero: una mamma entrata dalla porta sbagliata', () => {
  it('porta il ruolo a genitore, azzera i gradi e NON tocca la sede', async () => {
    const res = await POST(richiesta(corpoValido) as never)
    expect(res.status).toBe(200)
    expect(db.utenti[0].ruolo).toBe('genitore')
    expect(db.utenti[0].gradi).toEqual([])
    // La sede è NOT NULL ed è il ripiego delle sue schermate da genitore: resta
    // dove stanno i figli.
    expect(db.utenti[0].scuola_id).toBe(SEDE)
  })

  it('il ponte genitore resta intatto: è l’accesso della famiglia', async () => {
    await POST(richiesta(corpoValido) as never)
    expect(db.parents).toHaveLength(1)
    expect(db.parents[0].auth_user_id).toBe(BERSAGLIO)
  })

  it('cancella fascicolo e pratica, con i file fuori per primi', async () => {
    const res = await POST(richiesta(corpoValido) as never)
    const { data } = await res.json()
    expect(data.fascicoloCancellato).toBe(true)
    expect(h.rpcChiamate[0]).toMatchObject({ args: { p_utente_id: BERSAGLIO, p_pratica_id: PRATICA } })
    expect(h.ordine.indexOf('storage.remove')).toBeLessThan(
      h.ordine.indexOf('rpc.personale_cancella_fascicolo'),
    )
  })

  it('IL RUOLO PRIMA DEL FASCICOLO: il verso reversibile del guasto', async () => {
    await POST(richiesta(corpoValido) as never)
    expect(h.ordine.indexOf('utenti.update')).toBeLessThan(h.ordine.indexOf('storage.remove'))
  })
})

describe('le guardie', () => {
  it('senza ponte parents si RIFIUTA: non si fabbrica una scheda di genitore', async () => {
    db.parents = []
    const res = await POST(richiesta(corpoValido) as never)
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('RIPORTA_GENITORE_SENZA_PONTE')
    expect(db.utenti[0].ruolo).toBe('educator')
    expect(h.ordine).toEqual([])
  })

  it('già genitore → 409, e non si ricancella un fascicolo già andato', async () => {
    db.utenti[0].ruolo = 'genitore'
    db.utenti[0].role = 'genitore'
    const res = await POST(richiesta(corpoValido) as never)
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('RIPORTA_GENITORE_GIA_GENITORE')
    expect(h.rpcChiamate).toEqual([])
  })

  it('IL CAS: se il ruolo cambia fra lettura e scrittura → 409, e non si sovrascrive', async () => {
    h.corsaSulRuolo = true
    const res = await POST(richiesta(corpoValido) as never)
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('RIPORTA_GENITORE_GIA_DECISO')
    // La decisione del collega resta scritta: non è diventata `genitore`.
    expect(db.utenti[0].ruolo).toBe('segreteria')
    // E il fascicolo NON è stato cancellato: il ruolo non è cambiato.
    expect(h.rpcChiamate).toEqual([])
  })

  it('sé stessi → 403', async () => {
    h.attore = { ...h.attore, id: BERSAGLIO }
    const res = await POST(richiesta(corpoValido) as never)
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('STAFF_ELIMINAZIONE_SE_STESSI')
  })

  it('bersaglio di Direzione → 403', async () => {
    db.utenti[0].ruolo = 'coordinator'
    db.utenti[0].role = 'coordinator'
    const res = await POST(richiesta(corpoValido) as never)
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('STAFF_ELIMINAZIONE_BERSAGLIO_DIREZIONE')
  })

  it('senza `conferma` non passa la validazione', async () => {
    const res = await POST(richiesta({ utenteId: BERSAGLIO }) as never)
    expect(res.status).toBe(400)
    expect(h.ordine).toEqual([])
  })
})

describe('lo sgancio dei poteri', () => {
  it('toglie le sezioni PRIMA di cambiare il ruolo: decidono quali bambini vede', async () => {
    db.utenti_sezioni = [{ utente_id: BERSAGLIO, sezione_id: 's1' }]
    await POST(richiesta(corpoValido) as never)
    expect(db.utenti_sezioni).toEqual([])
    expect(h.ordine.indexOf('utenti_sezioni.delete')).toBeLessThan(h.ordine.indexOf('utenti.update'))
  })
})
