import { describe, it, expect, vi, beforeEach } from 'vitest'

import { SEDE_A, SEDE_B } from '../fixtures/sedi'

/* ═══════════════════════════════════════════════════════════════════════════════
 * D1 · le tre rotte della zona pericolosa ammettono la SEGRETERIA, sulla sua sede
 *
 * Dal 2026-09-24 la zona pericolosa compare anche alla Segreteria
 * (`segreteriaVedeZonaPericolosa`). Un comando mostrato e poi respinto è la
 * trappola peggiore, quindi qui si verifica il lato server con un attore
 * `segreteria` — che gli altri file di queste rotte non usano mai: girano tutti
 * con un `admin`.
 *
 * ⚠️ `@/lib/auth/scope` NON è finto, ed è il punto del file. Gli altri test
 * sostituiscono `assertUtenteInScope` con un `null` fisso, cioè sono verdi con e
 * senza il controllo di sede. Qui la sede la decide il codice vero, su righe
 * `utenti` vere del finto database: per la Segreteria `scuoleDiUtente` è la sua
 * sola `scuola_id`, senza letture.
 *
 * ─── PROVA PER ROTTURA — eseguita il 2026-09-25 ───────────────────────────────
 *   • tolto il ramo `haRuolo(attore, 'segreteria')` da `puoEliminareStaff`
 *                                                               → 4 rossi
 *   • `assertUtenteInScope` fatto rispondere sempre `null`       → 4 rossi
 *   • gate di ruolo ristretto alla Direzione, una rotta alla volta:
 *     `requireStaff(request)` → `requireStaff(request, ['admin', 'coordinator'])`
 *       eliminazione (GET e POST)                                → 6 rossi
 *       riporta-a-genitore                                       → 3 rossi
 *       anche-genitore                                           → 3 rossi
 *     (il finto `requireStaff: async () => ({ user })` del giro 1 ignorava i
 *     ruoli ammessi: questa rottura non poteva far diventare rosso niente)
 *   • controprova: un'educatrice della stessa sede prende 403 dal gate, e senza
 *     sessione è 401 — il gate che ammette la Segreteria è quello vero.
 *   Dopo ogni prova il codice è stato rimesso com'era.
 * ═══════════════════════════════════════════════════════════════════════════════ */

const h = vi.hoisted(() => ({
  /** L'uid della sessione: chi è, e con che ruolo, lo decide la riga `utenti`. */
  sessioneUid: null as string | null,
  linkChiamate: [] as unknown[],
}))

// ⚠️ `@/lib/auth/require-staff` NON è finto (correzione del giro 2). Un finto
// `requireStaff: async () => ({ user })` ignora i ruoli ammessi: se una di queste
// rotte passasse a `requireStaff(request, ['admin','coordinator'])`, la Segreteria
// prenderebbe un 403 al primo clic su un comando che la UI ora le mostra, e questo
// file resterebbe verde. Qui si finge solo la SESSIONE (`createClient().auth`,
// più sotto): il gate di ruolo, con i suoi ruoli predefiniti, è quello vero, e il
// ruolo lo legge dalla riga `utenti` del finto database.

vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn(async () => {}) }))
vi.mock('@/lib/storage/rimozione-verificata', () => ({
  rimuoviEVerifica: vi.fn(async (_s: unknown, _b: string, percorsi: string[]) => ({
    rimossi: percorsi,
    giaAssenti: [],
    ancoraPresenti: [],
    incerti: [],
    erroreRimozione: false,
  })),
  bloccanti: () => [],
}))
vi.mock('@/lib/anagrafiche/parents', () => ({
  linkOrCreateParent: vi.fn(async (_s: unknown, _a: unknown, arg: unknown) => {
    h.linkChiamate.push(arg)
    return { parentId: 'd0000000-0000-4000-8000-0000000000d1' }
  }),
}))

import { creaFintoSupabaseConProiezione } from '../fixtures/proiezione'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { VOCI_CHE_PESANO } from '@/lib/personale/tracce-docente'

/** La segretaria che agisce: lavora nella sede B. */
const IO = 'a0000000-0000-4000-8000-0000000000a5'
/** Una docente della sede B: il bersaglio legittimo. */
const DOCENTE = 'b0000000-0000-4000-8000-0000000000b1'
/** Una docente della sede A: fuori dal perimetro della segretaria. */
const DOCENTE_ALTROVE = 'b0000000-0000-4000-8000-0000000000b2'
/** La Direzione della sede B: vietata a chiunque da qui. */
const DIRETTRICE = 'b0000000-0000-4000-8000-0000000000b3'
/** Un'educatrice della sede B: la controprova che il gate di ruolo è quello vero. */
const COLLEGA = 'b0000000-0000-4000-8000-0000000000b4'

let db: DBFinto
let scritture: Scrittura[]

function dbBase(): DBFinto {
  const riga = (id: string, ruolo: string, scuola_id: string) => ({
    id,
    nome: 'Prova',
    cognome: 'Esempio',
    email: `${id.slice(-3)}@esempio.test`,
    cellulare: null,
    ruolo,
    role: ruolo,
    scuola_id,
    gradi: [],
    archiviato_il: null,
  })
  const d: DBFinto = {
    utenti: [
      riga(IO, 'segreteria', SEDE_B),
      riga(DOCENTE, 'educator', SEDE_B),
      riga(DOCENTE_ALTROVE, 'educator', SEDE_A),
      riga(DIRETTRICE, 'coordinator', SEDE_B),
      riga(COLLEGA, 'educator', SEDE_B),
    ],
    // Il ponte genitore c'è per tutti i bersagli: «riporta a genitore» lo esige.
    parents: [
      { id: 'p-1', auth_user_id: DOCENTE },
      { id: 'p-2', auth_user_id: DOCENTE_ALTROVE },
      { id: 'p-3', auth_user_id: DIRETTRICE },
    ],
    anagrafica_personale: [],
    pratiche_personale: [],
    utenti_sezioni: [],
    utenti_sezioni_materie: [],
    utenti_scuole: [],
    push_subscriptions: [],
    orario_settimanale: [],
    task_interni: [],
  }
  for (const v of VOCI_CHE_PESANO) d[v.tabella] = d[v.tabella] ?? []
  return d
}

vi.mock('@/lib/supabase/server-client', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.sessioneUid ? { id: h.sessioneUid } : null }, error: null }) },
  }),
  createAdminClient: async () => {
    const client = creaFintoSupabaseConProiezione(db, [], { scritture }, [])
    ;(client as unknown as Record<string, unknown>).rpc = async () => ({
      data: { pratiche_cancellate: 0, anagrafiche_cancellate: 0 },
      error: null,
    })
    ;(client as unknown as Record<string, unknown>).auth = {
      admin: { deleteUser: async () => ({ error: null }) },
    }
    return client
  },
}))

import { GET as GET_ELIMINAZIONE, POST as POST_ELIMINAZIONE } from '@/app/api/admin/staff/eliminazione/route'
import { POST as POST_RIPORTA } from '@/app/api/admin/staff/riporta-a-genitore/route'
import { POST as POST_ANCHE } from '@/app/api/admin/staff/anche-genitore/route'

const post = (percorso: string, corpo: unknown) =>
  new Request(`http://localhost/api/admin/staff/${percorso}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
  })

const anteprima = (id: string) => GET_ELIMINAZIONE(new Request(`http://localhost/api/admin/staff/eliminazione?id=${id}`) as never)
const elimina = (id: string, decisioneAttesa: string) =>
  POST_ELIMINAZIONE(post('eliminazione', { id, decisioneAttesa, conferma: true }) as never)
const riporta = (utenteId: string) => POST_RIPORTA(post('riporta-a-genitore', { utenteId, conferma: true }) as never)
const ancheGenitore = (utenteId: string) => POST_ANCHE(post('anche-genitore', { utenteId }) as never)

const ruoloDi = (id: string) => db.utenti.find((u) => u.id === id)?.ruolo

beforeEach(() => {
  vi.clearAllMocks()
  db = dbBase()
  scritture = []
  h.linkChiamate = []
  h.sessioneUid = IO
})

describe('Segreteria sulla PROPRIA sede: le tre rotte la ammettono', () => {
  it('eliminazione GET: l’anteprima arriva', async () => {
    // Nessuna traccia di lavoro, ma il ponte genitore c'è: è il caso reale del
    // compito — «profilo-doppio», che porta a «Trasforma in genitore».
    const res = await anteprima(DOCENTE)
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.decisione).toBe('profilo-doppio')
    expect(data.ponteGenitore).toBe(true)
  })

  it('eliminazione POST: archivia davvero', async () => {
    db.parents = []
    db.eventi_diario = [{ maestra_id: DOCENTE }]
    const res = await elimina(DOCENTE, 'archivia')
    expect(res.status).toBe(200)
    expect((await res.json()).data.esito).toBe('archiviato')
    expect(db.utenti.find((u) => u.id === DOCENTE)?.archiviato_il).toBeTruthy()
  })

  it('riporta-a-genitore POST: il ruolo diventa genitore', async () => {
    const res = await riporta(DOCENTE)
    expect(res.status).toBe(200)
    expect(ruoloDi(DOCENTE)).toBe('genitore')
  })

  it('anche-genitore POST: il profilo genitore viene collegato', async () => {
    const res = await ancheGenitore(DOCENTE)
    expect(res.status).toBe(200)
    expect(h.linkChiamate).toHaveLength(1)
  })
})

describe('Segreteria su UN’ALTRA sede: 403, e niente scritto', () => {
  it('eliminazione GET', async () => {
    const res = await anteprima(DOCENTE_ALTROVE)
    expect(res.status).toBe(403)
  })

  it('eliminazione POST', async () => {
    db.eventi_diario = [{ maestra_id: DOCENTE_ALTROVE }]
    const res = await elimina(DOCENTE_ALTROVE, 'archivia')
    expect(res.status).toBe(403)
    expect(scritture).toEqual([])
  })

  it('riporta-a-genitore POST', async () => {
    const res = await riporta(DOCENTE_ALTROVE)
    expect(res.status).toBe(403)
    expect(ruoloDi(DOCENTE_ALTROVE)).toBe('educator')
    expect(scritture).toEqual([])
  })

  it('anche-genitore POST', async () => {
    const res = await ancheGenitore(DOCENTE_ALTROVE)
    expect(res.status).toBe(403)
    expect(h.linkChiamate).toEqual([])
  })
})

describe('Segreteria su un account di Direzione o su sé stessa: 403 col codice giusto', () => {
  it.each([
    ['eliminazione GET', () => anteprima(DIRETTRICE)],
    ['eliminazione POST', () => elimina(DIRETTRICE, 'archivia')],
    ['riporta-a-genitore POST', () => riporta(DIRETTRICE)],
    ['anche-genitore POST', () => ancheGenitore(DIRETTRICE)],
  ])('Direzione — %s', async (_nome, chiama) => {
    const res = await chiama()
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('STAFF_ELIMINAZIONE_BERSAGLIO_DIREZIONE')
    expect(ruoloDi(DIRETTRICE)).toBe('coordinator')
    expect(scritture).toEqual([])
    expect(h.linkChiamate).toEqual([])
  })

  it.each([
    ['eliminazione GET', () => anteprima(IO)],
    ['eliminazione POST', () => elimina(IO, 'archivia')],
    ['riporta-a-genitore POST', () => riporta(IO)],
    ['anche-genitore POST', () => ancheGenitore(IO)],
  ])('sé stessa — %s', async (_nome, chiama) => {
    const res = await chiama()
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('STAFF_ELIMINAZIONE_SE_STESSI')
    expect(scritture).toEqual([])
  })
})

// ─── CONTROPROVA: il gate di ruolo che ha lasciato passare la Segreteria è VERO ───
// Senza questi due blocchi un `requireStaff` che dicesse sempre di sì (un finto
// rimasto, un ramo aperto) renderebbe verdi i test qui sopra per la ragione
// sbagliata. Un'educatrice della STESSA sede deve essere fermata dal gate prima
// che la rotta guardi sede e bersaglio.
describe('il gate di ruolo è quello vero: chi non è staff resta fuori', () => {
  const chiamate = [
    ['eliminazione GET', () => anteprima(DOCENTE)],
    ['eliminazione POST', () => elimina(DOCENTE, 'archivia')],
    ['riporta-a-genitore POST', () => riporta(DOCENTE)],
    ['anche-genitore POST', () => ancheGenitore(DOCENTE)],
  ] as const

  it.each(chiamate)('educatrice della stessa sede — %s: 403 dal gate', async (_nome, chiama) => {
    h.sessioneUid = COLLEGA
    db.eventi_diario = [{ maestra_id: DOCENTE }]
    const res = await chiama()
    expect(res.status).toBe(403)
    // Nessun codice di `permessi-eliminazione`: a respingere è stato il gate.
    expect((await res.json()).codice).toBeUndefined()
    expect(ruoloDi(DOCENTE)).toBe('educator')
    expect(scritture).toEqual([])
    expect(h.linkChiamate).toEqual([])
  })

  it.each(chiamate)('nessuna sessione — %s: 401', async (_nome, chiama) => {
    h.sessioneUid = null
    const res = await chiama()
    expect(res.status).toBe(401)
    expect(scritture).toEqual([])
  })
})
