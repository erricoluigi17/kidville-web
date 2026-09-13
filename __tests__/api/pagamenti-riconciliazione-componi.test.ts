import { it, expect, vi, beforeEach, describe } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/pagamenti/riconciliazione/[id]/componi — «Componi il pagamento»
//
// La rotta che REGISTRA i soldi veri di un bonifico ripartito su più voci. Il
// motore atomico è la RPC `registra_transazione_contabile`, il cui contratto è
// congelato: qui si collaudano i SETTE presidi che solo la rotta può portare, e
// che la RPC per costruzione non ha (non ha né `request` né utente chiamante).
//
//  1. alunni non ATTIVI rifiutati (ritirato · anonimizzato GDPR · sede E2E)
//  2. la sede delle voci/alunni dev'essere ACCESSIBILE a chi opera (403)
//  3. la sede del DOCUMENTO è dichiarata dal client e va validata + loggata
//  4. `stato_atteso` si legge dal MOVIMENTO, mai dal client; `confermato` mai
//  5. `KV409` → HTTP 409, non 500
//  6. i tetti stanno nella `zod` (quantità int32 · 2 decimali · importo · righe)
//  7. il gate è `puoConfermare`, e la quadratura si rifà lato server
//
// Più la REGRESSIONE ZERO: senza i campi nuovi il payload verso la RPC porta i
// campi storici e `[]` — mai `null` — sui tre nuovi.
// ─────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  scope: vi.fn(),
  notifica: vi.fn(),
  audit: vi.fn(),
  revoca: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  rpcCalls: [] as { fn: string; params: unknown }[],
  rpcResult: { data: null as unknown, error: null as { code?: string; message?: string } | null },
  movimento: null as Record<string, unknown> | null,
  movimentoError: null as { code?: string; message?: string } | null,
  /** Simula il DB NON migrato: `riconciliazione_movimenti.transazione_id` assente. */
  colonnaTransazioneAssente: false,
  /** Simula il DB NON migrato: `alunni.anonimizzato_il` assente. */
  colonnaAnonimizzatoAssente: false,
  pagamenti: [] as Record<string, unknown>[],
  pagamentiError: null as { code?: string; message?: string } | null,
  alunni: [] as Record<string, unknown>[],
  alunniError: null as { code?: string; message?: string } | null,
  schools: [] as { id: string; nome: string }[],
  /** `student_parents` — il ponte ANAGRAFICO: dà direttamente il `parents.id`. */
  studentParents: [] as { parent_id: string; student_id: string }[],
  studentParentsError: null as { code?: string; message?: string } | null,
  /** `legame_genitori_alunni` — il ponte RUNTIME: dà l'ACCOUNT, non il `parents.id`. */
  legameRuntime: [] as { alunno_id: string; genitore_id: string }[],
  legameRuntimeError: null as { code?: string; message?: string } | null,
  /** `parents` — serve a tradurre account → `parents.id` (e viceversa). */
  parentsRighe: [] as { id: string; auth_user_id: string | null }[],
  parentsError: null as { code?: string; message?: string } | null,
  /**
   * `fatture_emesse` del pagamento a cui il movimento era abbinato PRIMA di
   * essere riaperto. Vuoto è il caso di sempre; una riga viva è il caso che la
   * seconda porta deve fermare.
   */
  fatture: [] as { numero: number; anno: number | null; sezionale: string | null; sdi_stato: number | null }[],
  fattureError: null as { code?: string; message?: string } | null,
  letture: [] as { tabella: string; colonne: string }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({ resolveScuoleAttive: (...a: unknown[]) => h.scope(...a) }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: (...a: unknown[]) => h.notifica(...a) }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: (...a: unknown[]) => h.audit(...a) }))
vi.mock('@/lib/pagamenti/sospensione', () => ({ verificaRevocaSospensioneMorosita: (...a: unknown[]) => h.revoca(...a) }))
// Mock PARZIALE: `withRoute` importa dallo stesso modulo e non deve perdere il resto.
vi.mock('@/lib/logging/logger', async (originale) => {
  const m = (await originale()) as Record<string, unknown>
  return { ...m, logEvento: (...a: unknown[]) => h.logEvento(...a), logErrore: (...a: unknown[]) => h.logErrore(...a) }
})

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    rpc: async (fn: string, params: unknown) => {
      h.rpcCalls.push({ fn, params })
      return h.rpcResult
    },
    from: (tabella: string) => {
      const b: Record<string, unknown> & { _col?: string } = {}
      const risolvi = () => {
        const col = b._col ?? ''
        if (tabella === 'riconciliazione_movimenti') {
          if (h.colonnaTransazioneAssente && col.includes('transazione_id')) {
            return { data: null, error: { code: '42703', message: 'column "transazione_id" does not exist' } }
          }
          if (h.movimentoError) return { data: null, error: h.movimentoError }
          return { data: h.movimento, error: null }
        }
        if (tabella === 'pagamenti') return { data: h.pagamenti, error: h.pagamentiError }
        if (tabella === 'alunni') {
          if (h.colonnaAnonimizzatoAssente && col.includes('anonimizzato_il')) {
            return { data: null, error: { code: '42703', message: 'column "anonimizzato_il" does not exist' } }
          }
          return { data: h.alunni, error: h.alunniError }
        }
        if (tabella === 'schools') return { data: h.schools, error: null }
        // I DUE PONTI genitore↔bambino. Il finto client ignora i filtri: le
        // fixture si scrivono corte apposta, una per caso.
        if (tabella === 'student_parents') return { data: h.studentParents, error: h.studentParentsError }
        if (tabella === 'legame_genitori_alunni') return { data: h.legameRuntime, error: h.legameRuntimeError }
        if (tabella === 'parents') return { data: h.parentsRighe, error: h.parentsError }
        if (tabella === 'fatture_emesse') return { data: h.fatture, error: h.fattureError }
        return { data: [], error: null }
      }
      b.select = (c: string) => { b._col = c; h.letture.push({ tabella, colonne: c }); return b }
      b.eq = () => b
      b.in = () => b
      b.limit = () => b
      b.order = () => b
      b.maybeSingle = async () => risolvi()
      b.single = async () => risolvi()
      b.then = (resolve: (v: unknown) => unknown) => resolve(risolvi())
      return b
    },
  }),
}))

import { POST } from '@/app/api/pagamenti/riconciliazione/[id]/componi/route'
// Il motore PURO, importato qui per una ragione sola: misurare l'invariante da cui
// dipende l'irraggiungibilità del secondo `CONCILIAZIONE_ANCORA_MANCANTE` (in fondo).
import { proponiAncora, puoConfermare, type RigaComposizione } from '@/lib/pagamenti/conciliazione-composita'

const URL_BASE = 'http://localhost/api/pagamenti/riconciliazione'
const MOV = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SEDE_A = '22222222-2222-4222-8222-222222222222'
const SEDE_B = '77777777-7777-4777-8777-777777777777'
const SEDE_E2E = 'e2e00000-0000-4000-8000-000000000000'
const PARENT = '33333333-3333-4333-8333-333333333333'
const P1 = '11111111-1111-4111-8111-111111111111'
const P2 = '44444444-4444-4444-8444-444444444444'
const AL1 = '55555555-5555-4555-8555-555555555555'
const AL2 = '66666666-6666-4666-8666-666666666666'
const CAT = '88888888-8888-4888-8888-888888888888'
/** Un `parents.id` VERO ma di un'altra famiglia: la FK lo accetta, il gate no. */
const PARENT_ESTRANEO = '99999999-9999-4999-8999-999999999999'
/** Un genitore che l'anagrafica non conosce e che esiste solo nel ponte runtime. */
const PARENT_RUNTIME = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ACCOUNT_RUNTIME = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const post = (body: unknown, id = MOV) =>
  POST(
    new Request(`${URL_BASE}/${id}/componi`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'seg-1' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  )

/** Il payload `p` passato alla RPC nell'ultima chiamata. */
const payloadRpc = () => (h.rpcCalls.at(-1)!.params as { p: Record<string, unknown> }).p

const eventiRotta = () =>
  h.logEvento.mock.calls.filter((c) => {
    const campi = c[2] as { operazione?: string } | undefined
    return campi?.operazione === 'pagamenti/riconciliazione/[id]/componi:POST'
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE_A } })
  h.scope.mockResolvedValue([SEDE_A, SEDE_B])
  h.notifica.mockResolvedValue(undefined)
  h.audit.mockResolvedValue(undefined)
  h.revoca.mockResolvedValue({ revocati: [] })
  h.rpcCalls = []
  h.rpcResult = {
    data: {
      transazione_id: 'tx-1', incassi: 1, ricariche: 0, eccedenza: 0,
      voci_nuove: 0, voci_ticket: 0, movimento_id: MOV,
      ancora_pagamento_id: P1, ancora_incasso_id: 'inc-1',
    },
    error: null,
  }
  h.movimento = {
    id: MOV, importo: 100, stato: 'suggerito', scuola_id: null,
    data_operazione: '2026-09-10', transazione_id: null,
  }
  h.movimentoError = null
  h.colonnaTransazioneAssente = false
  h.colonnaAnonimizzatoAssente = false
  // Il fixture somiglia al database VERO: `pagamenti.descrizione` è NOT NULL e in
  // produzione non ce n'è una vuota su 825 righe (misurato il 2026-09-13). Senza
  // quel campo il motore emette `descrizione_vuota` e il gate dice no — che è il
  // comportamento giusto su un dato che a database non può esistere.
  h.pagamenti = [
    { id: P1, alunno_id: AL1, scuola_id: SEDE_A, descrizione: 'Retta settembre', importo: 100, importo_pagato: 0, sconto: 0, stato: 'da_pagare', tipo: 'singolo', scadenza: '2026-09-01', payment_categories: { slug: 'retta' } },
    { id: P2, alunno_id: AL2, scuola_id: SEDE_B, descrizione: 'Laboratorio musica', importo: 60, importo_pagato: 0, sconto: 0, stato: 'da_pagare', tipo: 'singolo', scadenza: '2026-09-01', payment_categories: { slug: 'laboratorio' } },
  ]
  h.pagamentiError = null
  h.alunni = [
    { id: AL1, scuola_id: SEDE_A, stato: 'iscritto', anonimizzato_il: null },
    { id: AL2, scuola_id: SEDE_B, stato: 'iscritto', anonimizzato_il: null },
  ]
  h.alunniError = null
  h.schools = [
    { id: SEDE_A, nome: 'Kidville Giugliano' },
    { id: SEDE_B, nome: 'Kidville Aversa' },
    { id: SEDE_E2E, nome: 'Kidville E2E' },
  ]
  // Il caso normale: PARENT è il genitore di tutt'e due i bambini, e lo è
  // nell'anagrafica — che è la sorgente da cui viene il 92% dei legami veri
  // (misurato il 2026-09-13: 937 legami in entrambe le sorgenti, 81 nella sola
  // anagrafica, 4 nel solo runtime).
  h.studentParents = [
    { parent_id: PARENT, student_id: AL1 },
    { parent_id: PARENT, student_id: AL2 },
  ]
  h.studentParentsError = null
  h.legameRuntime = []
  h.legameRuntimeError = null
  h.parentsRighe = []
  h.parentsError = null
  h.fatture = []
  h.fattureError = null
  h.letture = []
})

/**
 * `true` quando il gate del pagante ha DECISO — cioè quando NON è caduto nel ramo
 * fail-open («non so»). Serve perché un 200 da solo non distingue «ammesso» da
 * «non verificato»: con l'unione vuota la rotta prosegue, e un test che guardasse
 * il solo stato sarebbe verde anche a ponte SPENTO. Misurato il 2026-09-13:
 * togliendo il ponte runtime dal modulo, il file restava 82/82 verde.
 */
const pagantePonderato = () =>
  !eventiRotta().some((c) => (c[2] as { esito?: string }).esito === 'pagante-non-verificato')

/** Una composizione di SOLE voci esistenti che quadra: 100 € contro 100 € di bonifico. */
const soloVociEsistenti = {
  scuola_id: SEDE_A,
  pagante_parent_id: PARENT,
  voci: [{ pagamento_id: P1, importo: 100 }],
}

// ─────────────────────────────────────────────────────────────────────────────
describe('componi — il caso felice e la regressione zero', () => {
  it('composizione che quadra → 200 e UNA sola chiamata alla RPC', async () => {
    const res = await post(soloVociEsistenti)
    expect(res.status).toBe(200)
    expect(h.rpcCalls).toHaveLength(1)
    expect(h.rpcCalls[0].fn).toBe('registra_transazione_contabile')
  })

  it('REGRESSIONE ZERO · senza i campi nuovi il payload porta i campi storici e [] — mai null', async () => {
    await post(soloVociEsistenti)
    const p = payloadRpc()
    // I campi STORICI, gli stessi che manda «Incasso unico».
    expect(p.pagante_parent_id).toBe(PARENT)
    expect(p.scuola_id).toBe(SEDE_A)
    expect(p.importo_totale).toBe(100)
    expect(p.voci).toEqual([{ pagamento_id: P1, importo: 100 }])
    expect(p.ricariche_mensa).toEqual([])
    expect(p.eccedenza_a_credito).toBe(0)
    expect(p.registrato_da).toBe('seg-1')
    // I tre NUOVI: array vuoti. `null` farebbe esplodere `jsonb_array_elements`
    // con un errore criptico — difetto noto e dichiarato nella migrazione.
    expect(p.voci_nuove).toEqual([])
    expect(p.voci_ticket).toEqual([])
    expect(p.voci_nuove).not.toBeNull()
    expect(p.voci_ticket).not.toBeNull()
  })

  it('la data valuta dell\'incasso è quella del MOVIMENTO, non del client', async () => {
    await post({ ...soloVociEsistenti, data_valuta: '1999-01-01' })
    expect(payloadRpc().data_valuta).toBe('2026-09-10')
  })

  it('l\'evento critico logga anche il SUCCESSO, e traccia la sede del documento', async () => {
    await post(soloVociEsistenti)
    const ok = eventiRotta().find((c) => (c[2] as { esito?: string }).esito === 'conciliazione_composita_registrata')
    expect(ok).toBeDefined()
    expect(ok![0]).toBe('pagamento')
    expect(ok![1]).toBe('info')
    expect((ok![2] as { sede_id?: string }).sede_id).toBe(SEDE_A)
    expect(h.audit).toHaveBeenCalledTimes(1)
  })
})

// ─── IL GATE DI RUOLO, PROVATO SUL RISULTATO E NON SULLA CHIAMATA ────────────
// ⚠️ ESISTE PERCHÉ IL LOCK NON LO VEDE. `gate-coverage.test.ts` cerca il
// LETTERALE `requireStaff(` e dichiara di NON trattare come un ramo l'`if` che
// ne usa il risultato: misurato il 2026-09-13, togliendo
// `if (auth.response) return auth.response` e lasciando la chiamata, questo file
// restava 54/54 verde e `__tests__/architecture` 1511/1511. Sulla rotta che
// registra i soldi veri non esisteva UNA riga che dicesse «un anonimo prende
// 401». Un controllo che verifica la PRESENZA di una chiamata non verifica che
// il suo risultato venga usato.
describe('componi — il gate di ruolo RESPINGE (non basta che `requireStaff` sia chiamato)', () => {
  it('anonimo (401 dal gate) → 401, nessuna RPC e nessuna scrittura collaterale', async () => {
    h.requireStaff.mockResolvedValue({ response: new Response(null, { status: 401 }) })
    const res = await post(soloVociEsistenti)
    expect(res.status).toBe(401)
    expect(h.rpcCalls).toHaveLength(0)
    expect(h.audit).not.toHaveBeenCalled()
    expect(h.notifica).not.toHaveBeenCalled()
  })

  it('ruolo non ammesso (403 dal gate) → 403, nessuna RPC', async () => {
    h.requireStaff.mockResolvedValue({ response: new Response(null, { status: 403 }) })
    const res = await post(soloVociEsistenti)
    expect(res.status).toBe(403)
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('il gate viene PRIMA del corpo: con un corpo illeggibile la risposta resta quella del gate', async () => {
    // Se il corpo fosse letto prima, un anonimo otterrebbe 400 «JSON non valido»
    // — cioè il server avrebbe bufferizzato e parsato il corpo di uno sconosciuto
    // prima di sapere chi è.
    h.requireStaff.mockResolvedValue({ response: new Response(null, { status: 401 }) })
    const res = await POST(
      new Request(`${URL_BASE}/${MOV}/componi`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{ questo non è json',
      }),
      { params: Promise.resolve({ id: MOV }) },
    )
    expect(res.status).toBe(401)
    expect(h.rpcCalls).toHaveLength(0)
  })
})

// ─── OBBLIGO 7 · un solo gate, e la quadratura si rifà lato server ────────────
describe('componi — quadratura ri-verificata lato server (obbligo 7)', () => {
  it('non quadra (99 su 100) → 422 CONCILIAZIONE_NON_QUADRA e NESSUNA chiamata RPC', async () => {
    const res = await post({ ...soloVociEsistenti, voci: [{ pagamento_id: P1, importo: 99 }] })
    expect(res.status).toBe(422)
    expect((await res.json()).codice).toBe('CONCILIAZIONE_NON_QUADRA')
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('due righe sulla STESSA voce che insieme sforano il residuo → 422 anche se la somma quadra', async () => {
    // È il caso che `violazioniRighe` da solo lasciava passare: riga per riga
    // sono entrambe ineccepibili (100 ≤ 100), e insieme incassano 200 su 100.
    h.movimento = { ...h.movimento!, importo: 200 }
    const res = await post({
      ...soloVociEsistenti,
      voci: [{ pagamento_id: P1, importo: 100 }, { pagamento_id: P1, importo: 100 }],
    })
    expect(res.status).toBe(422)
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('il RESIDUO è quello del DATABASE, non quello dichiarato dal client', async () => {
    // A database la voce ha già incassato 90: il residuo vero è 10, non 100.
    h.pagamenti = [{ ...h.pagamenti[0], importo_pagato: 90 }]
    h.movimento = { ...h.movimento!, importo: 100 }
    const res = await post({ ...soloVociEsistenti, voci: [{ pagamento_id: P1, importo: 100, residuo: 100 }] })
    expect(res.status).toBe(422)
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('composizione VUOTA contro movimento a 0 → 422, mai un 200 che non assegna un centesimo', async () => {
    h.movimento = { ...h.movimento!, importo: 0 }
    const res = await post({ scuola_id: SEDE_A, pagante_parent_id: PARENT, voci: [] })
    expect(res.status).toBe(422)
    expect(h.rpcCalls).toHaveLength(0)
  })
})

// ─── OBBLIGO 1 · gli alunni non attivi ───────────────────────────────────────
describe('componi — alunni non attivi (obbligo 1)', () => {
  const conVoceNuova = {
    scuola_id: SEDE_A,
    pagante_parent_id: PARENT,
    voci: [],
    voci_nuove: [{ alunno_id: AL1, categoria_id: CAT, descrizione: 'Uscita anticipata', importo: 100, scadenza: '2026-09-30' }],
  }

  it('alunno RITIRATO su una voce nuova → 403 CONCILIAZIONE_ALUNNO_NON_ATTIVO, nessuna RPC', async () => {
    h.alunni = [{ id: AL1, scuola_id: SEDE_A, stato: 'ritirato', anonimizzato_il: null }]
    const res = await post(conVoceNuova)
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('CONCILIAZIONE_ALUNNO_NON_ATTIVO')
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('alunno ANONIMIZZATO dall\'oblio GDPR → 403, nessuna RPC', async () => {
    h.alunni = [{ id: AL1, scuola_id: SEDE_A, stato: 'iscritto', anonimizzato_il: '2026-08-01T10:00:00Z' }]
    const res = await post(conVoceNuova)
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('CONCILIAZIONE_ALUNNO_NON_ATTIVO')
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('alunno della sede FITTIZIA E2E → 403, nessuna RPC (nessun incasso vero su una sede finta)', async () => {
    h.scope.mockResolvedValue([SEDE_A, SEDE_E2E])
    h.alunni = [{ id: AL1, scuola_id: SEDE_E2E, stato: 'iscritto', anonimizzato_il: null }]
    const res = await post({ ...conVoceNuova, scuola_id: SEDE_A })
    expect(res.status).toBe(403)
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('un ticket per un alunno ritirato è rifiutato come una voce nuova', async () => {
    h.alunni = [{ id: AL1, scuola_id: SEDE_A, stato: 'ritirato', anonimizzato_il: null }]
    const res = await post({
      scuola_id: SEDE_A, pagante_parent_id: PARENT, voci: [],
      voci_ticket: [{ alunno_id: AL1, quantita: 20, costo_unitario: 5 }],
    })
    expect(res.status).toBe(403)
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('una voce ESISTENTE di un alunno ritirato resta incassabile (un insoluto si salda anche dopo il ritiro)', async () => {
    h.alunni = [{ id: AL1, scuola_id: SEDE_A, stato: 'ritirato', anonimizzato_il: null }]
    const res = await post(soloVociEsistenti)
    expect(res.status).toBe(200)
    expect(h.rpcCalls).toHaveLength(1)
  })

  it('colonna `anonimizzato_il` assente (DB non migrato) → si prosegue, ma il presidio cieco si LOGGA', async () => {
    h.colonnaAnonimizzatoAssente = true
    const res = await post(conVoceNuova)
    expect(res.status).toBe(200)
    const avviso = eventiRotta().find((c) => (c[2] as { esito?: string }).esito === 'oblio-non-verificabile')
    expect(avviso).toBeDefined()
    expect(avviso![1]).toBe('warn')
  })
})

// ─── OBBLIGO 2 · derivare la sede non è un gate ──────────────────────────────
describe('componi — sede delle voci e degli alunni (obbligo 2)', () => {
  it('voce ESISTENTE di un plesso non accessibile → 403 CONCILIAZIONE_SEDE_NON_ACCESSIBILE', async () => {
    h.scope.mockResolvedValue([SEDE_A])
    const res = await post({ ...soloVociEsistenti, voci: [{ pagamento_id: P2, importo: 100 }] })
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('CONCILIAZIONE_SEDE_NON_ACCESSIBILE')
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('voce NUOVA per un bambino di un plesso non accessibile → 403 (il 403 che alla RPC manca)', async () => {
    h.scope.mockResolvedValue([SEDE_A])
    h.alunni = [{ id: AL2, scuola_id: SEDE_B, stato: 'iscritto', anonimizzato_il: null }]
    const res = await post({
      scuola_id: SEDE_A, pagante_parent_id: PARENT, voci: [],
      voci_nuove: [{ alunno_id: AL2, categoria_id: CAT, descrizione: 'Laboratorio', importo: 100, scadenza: '2026-09-30' }],
    })
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('CONCILIAZIONE_SEDE_NON_ACCESSIBILE')
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('TICKET per un bambino di un plesso non accessibile → 403', async () => {
    h.scope.mockResolvedValue([SEDE_A])
    h.alunni = [{ id: AL2, scuola_id: SEDE_B, stato: 'iscritto', anonimizzato_il: null }]
    const res = await post({
      scuola_id: SEDE_A, pagante_parent_id: PARENT, voci: [],
      voci_ticket: [{ alunno_id: AL2, quantita: 20, costo_unitario: 5 }],
    })
    expect(res.status).toBe(403)
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('un bonifico CROSS-SEDE fra due plessi entrambi accessibili passa: è il caso che la feature esiste per coprire', async () => {
    h.movimento = { ...h.movimento!, importo: 160 }
    const res = await post({
      scuola_id: SEDE_A, pagante_parent_id: PARENT,
      voci: [{ pagamento_id: P1, importo: 100 }, { pagamento_id: P2, importo: 60 }],
    })
    expect(res.status).toBe(200)
    expect(h.rpcCalls).toHaveLength(1)
  })

  it('voce che a database non esiste → 404, nessuna RPC', async () => {
    h.pagamenti = []
    const res = await post(soloVociEsistenti)
    expect(res.status).toBe(404)
    expect(h.rpcCalls).toHaveLength(0)
  })
})

// ─── IL PAGANTE: È LUI CHE FINISCE SULLA FATTURA ────────────────────────────
// `pagante_parent_id` era validato dalla sola `zod` (`zUuid`) e arrivava INTATTO
// alla RPC. La FK è `REFERENCES parents(id)`: verifica l'esistenza, nient'altro —
// e `parents` non ha nemmeno `scuola_id`, quindi la sede non lo limita.
// Sonda del 2026-09-13: un `pagante_parent_id` di un'ALTRA famiglia dava **200,
// RPC chiamata, uuid intatto nel payload**. Da lì `src/lib/pagamenti/ricevute.ts`
// prende NOME e CODICE FISCALE dell'intestatario: il documento fiscale usciva a
// nome di un estraneo, col suo CF — denaro, detrazione 730 e dato personale di
// un'altra famiglia in un colpo solo.
//
// Il gate esisteva già, ma sulla LETTURA (`contesto/route.ts`, 403
// `CONCILIAZIONE_PAGANTE_NON_AMMESSO`). Una guardia sulla lettura non protegge la
// scrittura.
describe('componi — il pagante dev’essere un genitore dei bambini coinvolti', () => {
  it('pagante di un’ALTRA famiglia → 403 CONCILIAZIONE_PAGANTE_NON_AMMESSO, nessuna RPC', async () => {
    const res = await post({ ...soloVociEsistenti, pagante_parent_id: PARENT_ESTRANEO })
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('CONCILIAZIONE_PAGANTE_NON_AMMESSO')
    expect(h.rpcCalls).toHaveLength(0)
    expect(h.audit).not.toHaveBeenCalled()
    expect(h.notifica).not.toHaveBeenCalled()
  })

  it('il rifiuto non nomina nessuno: nel corpo niente uuid, niente nomi', async () => {
    const res = await post({ ...soloVociEsistenti, pagante_parent_id: PARENT_ESTRANEO })
    const corpo = JSON.stringify(await res.json())
    expect(corpo).not.toContain(PARENT_ESTRANEO)
    expect(corpo).not.toContain(AL1)
  })

  it('il rifiuto lascia una riga di log a `warn`, con i soli conteggi', async () => {
    await post({ ...soloVociEsistenti, pagante_parent_id: PARENT_ESTRANEO })
    const riga = eventiRotta().find((c) => (c[2] as { esito?: string }).esito === 'pagante-fuori-dai-candidati')
    expect(riga).toBeDefined()
    expect(riga![1]).toBe('warn')
    // Nel log nemmeno l'uuid del pagante: identifica una persona, e questa riga
    // finisce in `app_log`.
    expect(JSON.stringify(riga![2])).not.toContain(PARENT_ESTRANEO)
  })

  it('il genitore VERO passa: il gate non blocca il caso normale', async () => {
    const res = await post(soloVociEsistenti)
    expect(res.status).toBe(200)
    expect(payloadRpc().pagante_parent_id).toBe(PARENT)
    expect(pagantePonderato()).toBe(true)
  })

  // ⚠️ DUE PONTI, E DIVERGONO. Misurato sul database vivo il 2026-09-13:
  // 937 legami stanno in tutt'e due le sorgenti, **81 nella sola anagrafica** e
  // **4 nel solo runtime**. Una guardia su UN ponte solo rifiuterebbe 4 o 81
  // incassi legittimi; l'UNIONE è un sovrainsieme di ciascuno e non ne blocca
  // nessuno.
  it('il ponte RUNTIME ammette un pagante che l’anagrafica non conosce (i 4 legami misurati)', async () => {
    h.studentParents = []
    h.legameRuntime = [{ alunno_id: AL1, genitore_id: ACCOUNT_RUNTIME }]
    h.parentsRighe = [{ id: PARENT_RUNTIME, auth_user_id: ACCOUNT_RUNTIME }]
    const res = await post({ ...soloVociEsistenti, pagante_parent_id: PARENT_RUNTIME })
    expect(res.status).toBe(200)
    expect(h.rpcCalls).toHaveLength(1)
    // …e lo è stato AMMESSO, non «non verificato»: senza questa riga il test
    // resterebbe verde anche con il ponte runtime spento (misurato).
    expect(pagantePonderato()).toBe(true)
  })

  it('l’anagrafica ammette un pagante SENZA account, che il ponte runtime non vedrebbe mai (gli 81)', async () => {
    // `getGenitoriDiAlunniEsito` scarta i `parents` con `auth_user_id` nullo: sono
    // 72 su 856 in produzione, e sono intestatari legittimi.
    h.studentParents = [{ parent_id: PARENT, student_id: AL1 }]
    h.legameRuntime = []
    h.parentsRighe = [{ id: PARENT, auth_user_id: null }]
    const res = await post(soloVociEsistenti)
    expect(res.status).toBe(200)
    // Stessa ragione dell'altro ponte: il 200 da solo sarebbe verde anche con la
    // lettura diretta dell'anagrafica spenta, perché l'unione vuota fa fail-open.
    expect(pagantePonderato()).toBe(true)
  })

  it('il gate copre anche i bambini delle voci NUOVE, non solo le voci già a registro', async () => {
    h.studentParents = [{ parent_id: PARENT_ESTRANEO, student_id: AL2 }]
    h.alunni = [{ id: AL2, scuola_id: SEDE_B, stato: 'iscritto', anonimizzato_il: null }]
    const res = await post({
      scuola_id: SEDE_A, pagante_parent_id: PARENT, voci: [],
      voci_nuove: [{ alunno_id: AL2, categoria_id: CAT, descrizione: 'Gita', importo: 100, scadenza: '2026-09-30' }],
    })
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('CONCILIAZIONE_PAGANTE_NON_AMMESSO')
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('il gate copre anche i bambini dei TICKET', async () => {
    h.studentParents = [{ parent_id: PARENT_ESTRANEO, student_id: AL1 }]
    const res = await post({
      scuola_id: SEDE_A, pagante_parent_id: PARENT, voci: [],
      voci_ticket: [{ alunno_id: AL1, quantita: 40, costo_unitario: 2.5 }],
    })
    expect(res.status).toBe(403)
    expect(h.rpcCalls).toHaveLength(0)
  })

  // ── FAIL-OPEN. Un gate che rifiuta quando NON SA è un gate che si scarica
  // addosso all'operatrice il guasto del database.
  it('lettura dei legami FALLITA → si prosegue (mai un 403 per un guasto), e lo si logga', async () => {
    h.studentParentsError = { code: '57014', message: 'statement timeout' }
    const res = await post({ ...soloVociEsistenti, pagante_parent_id: PARENT_ESTRANEO })
    expect(res.status).toBe(200)
    const riga = eventiRotta().find((c) => (c[2] as { esito?: string }).esito === 'pagante-non-verificato')
    expect(riga).toBeDefined()
    expect(riga![1]).toBe('warn')
  })

  it('nessun legame noto per quei bambini → si prosegue: in produzione ci sono 2 bambini così CON voci aperte', async () => {
    // Misurato il 2026-09-13 sull'unione delle due sorgenti: 5 alunni su 727 non
    // hanno alcun genitore, 3 dei quali iscritti, 2 con voci aperte. Rifiutare
    // renderebbe i loro insoluti impossibili da incassare da questa schermata.
    h.studentParents = []
    h.legameRuntime = []
    h.parentsRighe = []
    const res = await post({ ...soloVociEsistenti, pagante_parent_id: PARENT_ESTRANEO })
    expect(res.status).toBe(200)
    const riga = eventiRotta().find((c) => (c[2] as { esito?: string }).esito === 'pagante-non-verificato')
    expect(riga).toBeDefined()
  })
})

// ─── IL CONTENITORE DI RATE NON SI INCASSA ──────────────────────────────────
// La SELECT leggeva già `tipo`, il campo era nell'interfaccia — e non veniva mai
// usato. Il filtro esisteva solo in `contesto/route.ts` («I contenitori `padre`
// non si incassano: sono la somma delle rate figlie»), cioè sulla LETTURA: sonda
// del 2026-09-13, `{...P1, tipo: 'padre'}` su questa rotta dava **200 con la RPC
// chiamata**. Incassare un contenitore lo porta a `pagato` LASCIANDO APERTE le
// rate figlie: lo stesso denaro finisce a registro due volte e la famiglia resta
// morosa sulle rate. In produzione oggi c'è UNA riga `padre` (misurata il
// 2026-09-13 su 825 pagamenti), ed è `pagato`: il varco è dormiente, non chiuso.
describe('componi — una voce contenitore («padre») non è incassabile', () => {
  it('voce `tipo: padre` → 422 CONCILIAZIONE_VOCE_CONTENITORE, nessuna RPC', async () => {
    h.pagamenti = [{ ...h.pagamenti[0], tipo: 'padre' }]
    const res = await post(soloVociEsistenti)
    expect(res.status).toBe(422)
    expect((await res.json()).codice).toBe('CONCILIAZIONE_VOCE_CONTENITORE')
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('il rifiuto NON nomina la voce: nel corpo niente descrizioni, niente id', async () => {
    h.pagamenti = [{ ...h.pagamenti[0], tipo: 'padre', descrizione: 'Piano rate Rossi' }]
    const res = await post(soloVociEsistenti)
    const corpo = JSON.stringify(await res.json())
    expect(corpo).not.toContain('Rossi')
    expect(corpo).not.toContain(P1)
  })

  it('il contenitore respinto lascia una riga di log a `warn`', async () => {
    h.pagamenti = [{ ...h.pagamenti[0], tipo: 'padre' }]
    await post(soloVociEsistenti)
    const riga = eventiRotta().find((c) => (c[2] as { esito?: string }).esito === 'voci-contenitore')
    expect(riga).toBeDefined()
    expect(riga![1]).toBe('warn')
  })

  it('le RATE figlie e le voci singole restano incassabili: si respinge il contenitore, non il piano', async () => {
    h.pagamenti = [{ ...h.pagamenti[0], tipo: 'rata' }]
    const res = await post(soloVociEsistenti)
    expect(res.status).toBe(200)
    expect(h.rpcCalls).toHaveLength(1)
  })
})

// ─── OBBLIGO 3 · la sede del documento è dichiarata e va validata ────────────
describe('componi — sede del DOCUMENTO (obbligo 3)', () => {
  it('sede del documento fuori dallo scope → 403 SEDE_NON_ACCESSIBILE, nessuna RPC', async () => {
    h.scope.mockResolvedValue([SEDE_A])
    const res = await post({ ...soloVociEsistenti, scuola_id: SEDE_B })
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('il rifiuto della sede del documento LASCIA UNA RIGA DI LOG (rifiutoSede non logga da sé)', async () => {
    h.scope.mockResolvedValue([SEDE_A])
    await post({ ...soloVociEsistenti, scuola_id: SEDE_B })
    const rifiuto = eventiRotta().find((c) => (c[2] as { esito?: string }).esito === 'sede-documento-fuori-scope')
    expect(rifiuto).toBeDefined()
    expect(rifiuto![1]).toBe('warn')
    expect((rifiuto![2] as { sede_id?: string }).sede_id).toBe(SEDE_B)
  })

  it('la sede del documento arriva alla RPC così com\'è stata dichiarata e validata', async () => {
    await post({ ...soloVociEsistenti, scuola_id: SEDE_B })
    expect(payloadRpc().scuola_id).toBe(SEDE_B)
  })
})

// ─── OBBLIGO 4 · `stato_atteso` dal movimento, mai dal client ────────────────
describe('componi — stato atteso (obbligo 4)', () => {
  it('`stato_atteso` è quello LETTO dal movimento, e il valore del client viene ignorato', async () => {
    h.movimento = { ...h.movimento!, stato: 'da_abbinare' }
    await post({ ...soloVociEsistenti, stato_atteso: 'confermato' })
    expect(payloadRpc().stato_atteso).toBe('da_abbinare')
  })

  it('movimento GIÀ CONFERMATO → 409 CONCILIAZIONE_MOVIMENTO_CAMBIATO, nessuna RPC', async () => {
    h.movimento = { ...h.movimento!, stato: 'confermato' }
    const res = await post(soloVociEsistenti)
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('CONCILIAZIONE_MOVIMENTO_CAMBIATO')
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('uno stato fuori dai tre ammessi → 409, nessuna RPC (mai un CAS su un vocabolario ignoto)', async () => {
    h.movimento = { ...h.movimento!, stato: 'stato_futuro_sconosciuto' }
    const res = await post(soloVociEsistenti)
    expect(res.status).toBe(409)
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('movimento inesistente → 404, nessuna RPC', async () => {
    h.movimento = null
    const res = await post(soloVociEsistenti)
    expect(res.status).toBe(404)
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('il movimento_id passato alla RPC è quello dell\'URL, non un campo del body', async () => {
    await post({ ...soloVociEsistenti, movimento_id: '99999999-9999-4999-8999-999999999999' })
    expect(payloadRpc().movimento_id).toBe(MOV)
  })
})

// ─── OBBLIGO 5 · KV409 → 409 ─────────────────────────────────────────────────
describe('componi — compare-and-swap perso (obbligo 5)', () => {
  it('la RPC solleva KV409 → 409 CONCILIAZIONE_MOVIMENTO_CAMBIATO, non 500', async () => {
    h.rpcResult = { data: null, error: { code: 'KV409', message: 'Movimento … non è più nello stato atteso' } }
    const res = await post(soloVociEsistenti)
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('CONCILIAZIONE_MOVIMENTO_CAMBIATO')
  })

  it('la corsa persa NON scrive audit e NON manda notifiche — mentre il caso felice le fa entrambe', async () => {
    // Le due metà servono insieme: senza la prima, un handler che non scrive MAI
    // sarebbe verde qui — ed è esattamente quello che è successo provandolo su
    // uno scheletro inerte.
    await post(soloVociEsistenti)
    expect(h.audit).toHaveBeenCalledTimes(1)
    expect(h.notifica).toHaveBeenCalledTimes(1)

    vi.clearAllMocks()
    h.rpcResult = { data: null, error: { code: 'KV409', message: 'corsa persa' } }
    const res = await post(soloVociEsistenti)
    expect(res.status).toBe(409)
    expect(h.audit).not.toHaveBeenCalled()
    expect(h.notifica).not.toHaveBeenCalled()
  })

  it('un errore RPC qualunque resta 500, e viene loggato', async () => {
    h.rpcResult = { data: null, error: { code: 'P0001', message: 'Quadratura fallita: …' } }
    const res = await post(soloVociEsistenti)
    expect(res.status).toBe(500)
    expect(h.logErrore).toHaveBeenCalled()
  })

  it('il corpo della risposta d\'errore NON rimanda il messaggio grezzo della RPC', async () => {
    h.rpcResult = { data: null, error: { code: 'P0001', message: 'Uscita anticipata di un bambino' } }
    const res = await post(soloVociEsistenti)
    expect(res.status).toBe(500)
    const body = JSON.stringify(await res.json())
    expect(body).not.toContain('Uscita anticipata')
    expect(body).not.toContain('bambino')
  })
})

// ─── DEGRADO PULITO · la RPC estesa non c'è ──────────────────────────────────
describe('componi — degrado a 503 senza scritture parziali', () => {
  it('RPC assente (PGRST202) → 503 e nessuna scrittura collaterale', async () => {
    h.rpcResult = { data: null, error: { code: 'PGRST202', message: 'function not found' } }
    const res = await post(soloVociEsistenti)
    expect(res.status).toBe(503)
    expect(h.audit).not.toHaveBeenCalled()
    expect(h.notifica).not.toHaveBeenCalled()
  })

  it('RPC assente (42883) → 503', async () => {
    h.rpcResult = { data: null, error: { code: '42883', message: 'function does not exist' } }
    expect((await post(soloVociEsistenti)).status).toBe(503)
  })

  it('colonna `transazione_id` assente → 503 PRIMA di chiamare la RPC (la vecchia scriverebbe incassi senza legare il movimento)', async () => {
    h.colonnaTransazioneAssente = true
    const res = await post(soloVociEsistenti)
    expect(res.status).toBe(503)
    expect(h.rpcCalls).toHaveLength(0)
    expect(h.audit).not.toHaveBeenCalled()
  })

  it('se la RPC risponde SENZA `movimento_id` (versione vecchia) il movimento NON risulta legato, e si logga a error', async () => {
    h.rpcResult = { data: { transazione_id: 'tx-1', incassi: 1, ricariche: 0, eccedenza: 0 }, error: null }
    const res = await post(soloVociEsistenti)
    expect((await res.json()).data.movimento_confermato).toBe(false)
    expect(eventiRotta().some((c) => (c[2] as { esito?: string }).esito === 'movimento-non-legato' && c[1] === 'error')).toBe(true)
    void res
  })

  // ⚠️ IL 200 ERA MEZZO RIMEDIO. La scelta di non rispondere 500 è giusta — un 500
  // direbbe «nulla è stato scritto», sarebbe falso e inviterebbe a ritentare — ma
  // `movimento_confermato: false` non era leggibile da nessuna parte: misurato il
  // 2026-09-13, quel campo compariva 3 volte in TUTTO il repository (due nella
  // rotta, una nel test), nessun componente e nessuna chiave di catalogo. A
  // schermo restava «fatto», la riga bancaria restava rossa, e l'operatrice
  // ritentava — perché la riga *è* ancora `da_abbinare`. Al secondo giro il doppio
  // incasso è fermato dal residuo riletto SOLO per le voci esistenti: per le voci
  // nuove e i ticket nascono righe nuove e incassi nuovi, e niente li trattiene.
  it('movimento non legato → il 200 porta CONCILIAZIONE_MOVIMENTO_NON_LEGATO nel corpo', async () => {
    h.rpcResult = { data: { transazione_id: 'tx-1', incassi: 1 }, error: null }
    const res = await post(soloVociEsistenti)
    expect(res.status).toBe(200)
    const b = await res.json()
    expect(b.codice).toBe('CONCILIAZIONE_MOVIMENTO_NON_LEGATO')
    expect(b.data.movimento_confermato).toBe(false)
  })

  it('nel caso normale quel codice non compare: un avviso che c’è sempre non è un avviso', async () => {
    const res = await post(soloVociEsistenti)
    const b = await res.json()
    expect(b.codice).toBeUndefined()
    expect(b.data.movimento_confermato).toBe(true)
  })

  // ⚠️ IL LOCK DEI CODICI NON ARRIVA QUI. `errori-con-codice.test.ts` inventaria i
  // `codice` scritti dentro un corpo che porta `error`: questo viaggia su una
  // risposta RIUSCITA, quindi lì è invisibile. Verificato togliendo la
  // dichiarazione: il lock resta verde su questo codice e rosso solo sull'altro.
  // Senza questa riga, una chiave rinominata farebbe ricadere l'avviso sulla prosa
  // italiana — cioè il difetto che il canale dei codici esiste per chiudere.
  it('il codice del 200 anomalo è DICHIARATO e tradotto in tutt’e due le lingue', async () => {
    const { CODICI_ERRORE } = await import('@/lib/ui/esito-fetch')
    const catalogoIt = (await import('../../messages/it/shared.json')).default as Record<string, string>
    const catalogoEn = (await import('../../messages/en/shared.json')).default as Record<string, string>
    const chiave = (CODICI_ERRORE as Record<string, string>).CONCILIAZIONE_MOVIMENTO_NON_LEGATO
    expect(chiave).toBeTruthy()
    expect(catalogoIt[chiave]?.trim()).toBeTruthy()
    expect(catalogoEn[chiave]?.trim()).toBeTruthy()
  })

  it('lettura del movimento fallita per un guasto vero → 500, nessuna RPC', async () => {
    h.movimentoError = { code: '08006', message: 'connection failure' }
    const res = await post(soloVociEsistenti)
    expect(res.status).toBe(500)
    expect(h.rpcCalls).toHaveLength(0)
  })

  // PostgREST NON lancia: ritorna `{ error }`. Una lettura fallita e ignorata
  // diventerebbe «elenco vuoto», cioè «questo bambino non esiste» o «nessuna voce
  // fuori sede» — un 404 sbagliato nel primo caso, un PERMESSO nel secondo.
  it('lettura degli ALUNNI fallita → 500 CONCILIAZIONE_CONTESTO_NON_LETTO, mai un 404 «non esiste»', async () => {
    h.alunniError = { code: '57014', message: 'statement timeout' }
    const res = await post({
      scuola_id: SEDE_A, pagante_parent_id: PARENT, voci: [],
      voci_nuove: [{ alunno_id: AL1, categoria_id: CAT, descrizione: 'Divisa', importo: 100, scadenza: '2026-09-30' }],
    })
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('CONCILIAZIONE_CONTESTO_NON_LETTO')
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('lettura delle VOCI fallita → 500, mai «nessuna voce fuori sede»', async () => {
    h.pagamentiError = { code: '57014', message: 'statement timeout' }
    const res = await post(soloVociEsistenti)
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('CONCILIAZIONE_CONTESTO_NON_LETTO')
    expect(h.rpcCalls).toHaveLength(0)
  })
})

// ─── OBBLIGO 6 · i tetti stanno nella zod ────────────────────────────────────
describe('componi — tetti nella zod (obbligo 6)', () => {
  const conTicket = (quantita: number, costo_unitario: number) => ({
    scuola_id: SEDE_A, pagante_parent_id: PARENT, voci: [],
    voci_ticket: [{ alunno_id: AL1, quantita, costo_unitario }],
  })

  it('quantità ticket oltre 2 147 483 647 → 400 (la RPC casta a int e risponde 22003)', async () => {
    const res = await post(conTicket(2_147_483_648, 1))
    expect(res.status).toBe(400)
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('quantità ticket esattamente 2 147 483 647 supera la zod (è il confine, non oltre)', async () => {
    // Non quadra col movimento da 100 €: il rifiuto arriva dalla quadratura (422), non dalla zod.
    const res = await post(conTicket(2_147_483_647, 1))
    expect(res.status).toBe(422)
  })

  it('costo unitario con TRE decimali → 400 (browser 2,13 · PostgreSQL 2,14 sull\'1,07% dei valori)', async () => {
    const res = await post(conTicket(1, 2.135))
    expect(res.status).toBe(400)
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('costo unitario con DUE decimali passa la zod e arriva intatto alla RPC', async () => {
    h.movimento = { ...h.movimento!, importo: 2.13 }
    const res = await post(conTicket(1, 2.13))
    expect(res.status).toBe(200)
    expect(h.rpcCalls).toHaveLength(1)
    expect((payloadRpc().voci_ticket as { costo_unitario: number }[])[0].costo_unitario).toBe(2.13)
  })

  it('importo di una voce oltre il tetto → 400 (sopra MAX_SAFE_INTEGER il centesimo non esiste più)', async () => {
    const res = await post({ ...soloVociEsistenti, voci: [{ pagamento_id: P1, importo: 1e17 }] })
    expect(res.status).toBe(400)
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('più voci del tetto → 400 (oggi non c\'è né in zod né nella RPC: 500 voci passano)', async () => {
    const voci = Array.from({ length: 51 }, () => ({ pagamento_id: P1, importo: 1 }))
    const res = await post({ ...soloVociEsistenti, voci })
    expect(res.status).toBe(400)
    expect(h.rpcCalls).toHaveLength(0)
  })

  // ⚠️ IL TETTO D'INSIEME NON ERA PRESIDIATO. Misurato il 2026-09-13: portando
  // `MAX_RIGHE_TOTALI` da 60 a 5000 questo file restava 54/54 verde. Il rosso che
  // gli veniva attribuito veniva da `MAX_RIGHE_PER_ELENCO` — cioè dall'altro
  // tetto, quello per singolo elenco, che nessuno stava mettendo in dubbio.
  it('tre elenchi che SOMMANO 61 righe → 400, nessuna RPC (nessuno dei tre sfora il tetto per elenco)', async () => {
    const res = await post({
      scuola_id: SEDE_A, pagante_parent_id: PARENT,
      voci: Array.from({ length: 21 }, () => ({ pagamento_id: P1, importo: 1 })),
      voci_nuove: Array.from({ length: 20 }, () => ({ alunno_id: AL1, categoria_id: CAT, descrizione: 'Gita', importo: 1, scadenza: '2026-09-30' })),
      voci_ticket: Array.from({ length: 20 }, () => ({ alunno_id: AL1, quantita: 1, costo_unitario: 1 })),
    })
    expect(res.status).toBe(400)
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('SESSANTA righe esatte passano: il tetto non blocca il bonifico multi-figlio, si ferma un passo dopo', async () => {
    // Il confine dall'altro lato. Un tetto che rifiutasse a 60 sarebbe altrettanto
    // rotto, e altrettanto invisibile: la segretaria vedrebbe un 400 e nessuno
    // saprebbe perché.
    h.movimento = { ...h.movimento!, importo: 60 }
    const res = await post({
      scuola_id: SEDE_A, pagante_parent_id: PARENT, voci: [],
      voci_nuove: Array.from({ length: 20 }, () => ({ alunno_id: AL1, categoria_id: CAT, descrizione: 'Gita', importo: 1, scadenza: '2026-09-30' })),
      voci_ticket: Array.from({ length: 40 }, () => ({ alunno_id: AL1, quantita: 1, costo_unitario: 1 })),
    })
    expect(res.status).toBe(200)
    expect(h.rpcCalls).toHaveLength(1)
  })

  it('quantità ticket non intera → 400', async () => {
    expect((await post(conTicket(2.5, 1))).status).toBe(400)
  })

  it('costo unitario a ZERO → 400 (l\'INSERT in incassi violerebbe incassi_importo_check)', async () => {
    expect((await post(conTicket(20, 0))).status).toBe(400)
  })
})

// ─── I TICKET ACCREDITANO IL SALDO ───────────────────────────────────────────
describe('componi — ticket mensa', () => {
  it('il ticket entra nel payload come voce_ticket e il suo totale conta nella quadratura', async () => {
    h.movimento = { ...h.movimento!, importo: 150 }
    const res = await post({
      scuola_id: SEDE_A, pagante_parent_id: PARENT,
      voci: [{ pagamento_id: P1, importo: 100 }],
      voci_ticket: [{ alunno_id: AL1, quantita: 20, costo_unitario: 2.5 }],
    })
    expect(res.status).toBe(200)
    const p = payloadRpc()
    expect(p.voci_ticket).toEqual([
      { alunno_id: AL1, quantita: 20, costo_unitario: 2.5, categoria_id: null, scadenza: null, gruppo: null },
    ])
  })

  it('lo `scuola_id` NON viene mandato dentro le voci nuove: la sede la deriva la RPC dall\'alunno', async () => {
    h.movimento = { ...h.movimento!, importo: 100 }
    await post({
      scuola_id: SEDE_A, pagante_parent_id: PARENT, voci: [],
      voci_nuove: [{ alunno_id: AL1, categoria_id: CAT, descrizione: 'Divisa', importo: 100, scadenza: '2026-09-30' }],
    })
    const nuove = payloadRpc().voci_nuove as Record<string, unknown>[]
    expect(nuove).toHaveLength(1)
    expect(nuove[0]).not.toHaveProperty('scuola_id')
  })
})

// ─── L'ÀNCORA ────────────────────────────────────────────────────────────────
describe('componi — àncora della fattura', () => {
  it('àncora assente → si propone, e la RETTA vince anche se non è la maggiore', async () => {
    h.movimento = { ...h.movimento!, importo: 160 }
    await post({
      scuola_id: SEDE_A, pagante_parent_id: PARENT,
      // P2 (laboratorio, 60) prima; P1 (retta, 100) dopo: vince la retta comunque.
      voci: [{ pagamento_id: P2, importo: 60 }, { pagamento_id: P1, importo: 100 }],
    })
    expect(payloadRpc().ancora_pagamento_id).toBe(P1)
  })

  it('àncora su una voce NUOVA → si manda l\'INDICE, non un uuid che il client non può conoscere', async () => {
    h.movimento = { ...h.movimento!, importo: 100 }
    await post({
      scuola_id: SEDE_A, pagante_parent_id: PARENT, voci: [],
      voci_nuove: [{ alunno_id: AL1, categoria_id: CAT, descrizione: 'Divisa', importo: 100, scadenza: '2026-09-30' }],
      ancora: { specie: 'nuova', indice: 0 },
    })
    const p = payloadRpc()
    expect(p.ancora_indice_voce_nuova).toBe(0)
    expect(p.ancora_pagamento_id).toBeNull()
  })

  it('àncora PROPOSTA che cade su un ticket: l\'indice globale si traduce in quello del suo elenco', async () => {
    // È il ramo aritmetico meno ovvio dei tre — `i − voci − nuove` — e sbagliarlo
    // di uno intesterebbe la fattura alla riga accanto, cioè al bambino sbagliato.
    // Con SOLE ricariche l'àncora è la maggiore fra quelle: la seconda (25 €).
    h.movimento = { ...h.movimento!, importo: 35 }
    await post({
      scuola_id: SEDE_A, pagante_parent_id: PARENT, voci: [],
      voci_ticket: [
        { alunno_id: AL1, quantita: 4, costo_unitario: 2.5 },
        { alunno_id: AL1, quantita: 10, costo_unitario: 2.5 },
      ],
    })
    const p = payloadRpc()
    expect(p.ancora_indice_voce_ticket).toBe(1)
    expect(p.ancora_indice_voce_nuova).toBeNull()
    expect(p.ancora_pagamento_id).toBeNull()
  })

  it('àncora con indice fuori dall\'elenco → 400 CONCILIAZIONE_ANCORA_MANCANTE, nessuna RPC', async () => {
    const res = await post({ ...soloVociEsistenti, ancora: { specie: 'esistente', indice: 7 } })
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('CONCILIAZIONE_ANCORA_MANCANTE')
    expect(h.rpcCalls).toHaveLength(0)
  })
})

// ─── IL NOME DELLA ROUTE, SCRITTO DUE VOLTE ──────────────────────────────────
describe('componi — il nome del withRoute e la costante OPERAZIONE non divergono', () => {
  it('sono la stessa stringa, e quella stringa è `<path relativo a api>:<METODO>`', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync('src/app/api/pagamenti/riconciliazione/[id]/componi/route.ts', 'utf8')
    const atteso = 'pagamenti/riconciliazione/[id]/componi:POST'
    // Il lock `logging-coverage` pretende il LETTERALE subito dopo `withRoute(`:
    // una costante lì dentro lo renderebbe cieco su questa route.
    const nelWrapper = /withRoute\(\s*'([^']+)'/.exec(src)
    expect(nelWrapper?.[1]).toBe(atteso)
    // …e i venti log della route usano la costante: se le due divergessero, le
    // righe in `app_log` finirebbero sotto un'operazione che non esiste.
    const costante = /const OPERAZIONE = '([^']+)'/.exec(src)
    expect(costante?.[1]).toBe(atteso)
  })
})

// ─── L'IMPORTO CHE QUADRA VIENE DAL MOVIMENTO, NON DAL CLIENT ────────────────
// È l'invariante GEMELLA del residuo — e quella un test ce l'aveva. Misurato il
// 2026-09-13: aggiungendo `importo_totale` alla zod e usandolo
// (`Number(body.importo_totale ?? movimento.importo)`) il file restava 54/54
// verde. La quadratura si sarebbe fatta contro un totale DICHIARATO dal client, e
// quel numero va poi alla RPC, che quadra su quello: il libro mastro
// divergerebbe dalla banca con un 200 sopra.
describe('componi — il totale è quello del MOVIMENTO (mai un campo del client)', () => {
  it('un `importo_totale` nel corpo viene ignorato: alla RPC va l\'importo della riga bancaria', async () => {
    const res = await post({ ...soloVociEsistenti, importo_totale: 999 })
    expect(res.status).toBe(200)
    expect(payloadRpc().importo_totale).toBe(100)
  })

  it('righe per 999 € contro un bonifico da 100 → 422 anche se il client dichiara 999 di totale', async () => {
    // La riga è NUOVA apposta: su una voce esistente il rifiuto arriverebbe
    // comunque dal residuo, e il test resterebbe verde anche con la quadratura
    // fatta sul numero del client. Qui l'unica rete è la quadratura.
    const res = await post({
      scuola_id: SEDE_A, pagante_parent_id: PARENT, voci: [],
      importo_totale: 999,
      voci_nuove: [{ alunno_id: AL1, categoria_id: CAT, descrizione: 'Gita', importo: 999, scadenza: '2026-09-30' }],
    })
    expect(res.status).toBe(422)
    expect((await res.json()).codice).toBe('CONCILIAZIONE_NON_QUADRA')
    expect(h.rpcCalls).toHaveLength(0)
  })
})

// ─── I TRE PRESIDI MINORI, che erano dichiarati e non provati ────────────────
describe('componi — eccedenza, bambini irraggiungibili, revoca della sospensione', () => {
  it('l\'eccedenza NON esiste su questa strada: alla RPC va sempre 0, anche se il client ne manda una', async () => {
    // Decisione n. 11: qui la quadratura è esatta e bloccante; l'eccedenza →
    // credito famiglia resta di «Incasso unico». La RPC la intercetterebbe in
    // quadratura, ma «la RPC se ne accorgerebbe» non è un presidio di questa rotta.
    const res = await post({ ...soloVociEsistenti, eccedenza_a_credito: 50 })
    expect(res.status).toBe(200)
    expect(payloadRpc().eccedenza_a_credito).toBe(0)
  })

  it('un bambino che a database non esiste più → 404 ALUNNO_NON_APRIBILE, nessuna RPC', async () => {
    h.alunni = []
    const res = await post({
      scuola_id: SEDE_A, pagante_parent_id: PARENT, voci: [],
      voci_nuove: [{ alunno_id: AL1, categoria_id: CAT, descrizione: 'Divisa', importo: 100, scadenza: '2026-09-30' }],
    })
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('ALUNNO_NON_APRIBILE')
    expect(h.rpcCalls).toHaveLength(0)
  })

  it('dopo l\'incasso si verifica la REVOCA della sospensione per morosità, sui bambini coinvolti', async () => {
    // Il mock c'era e non veniva mai asserito: una famiglia che paga poteva
    // restare sospesa e nessun test se ne sarebbe accorto.
    h.movimento = { ...h.movimento!, importo: 160 }
    await post({
      scuola_id: SEDE_A, pagante_parent_id: PARENT,
      voci: [{ pagamento_id: P1, importo: 100 }, { pagamento_id: P2, importo: 60 }],
    })
    expect(h.revoca).toHaveBeenCalledTimes(1)
    const alunni = h.revoca.mock.calls[0][1] as string[]
    expect([...alunni].sort()).toEqual([AL1, AL2].sort())
  })
})

// ─── NOTIFICHE BEST-EFFORT ───────────────────────────────────────────────────
describe('componi — notifiche e audit dopo la scrittura', () => {
  it('una notifica che esplode NON fa fallire la registrazione, e viene loggata', async () => {
    h.notifica.mockRejectedValue(new Error('FCM giù'))
    const res = await post(soloVociEsistenti)
    expect(res.status).toBe(200)
    expect(eventiRotta().some((c) => (c[2] as { esito?: string }).esito === 'notifica_non_inviata')).toBe(true)
  })

  // ⚠️ ERA L'UNICA DELLE TRE CHIAMATE DOPO LA RPC FUORI DA UN `try`. Oggi
  // `logScrittura` non lancia mai — verificato riga per riga — ma quella è una
  // garanzia ALTRUI, e questa rotta ha una rete apposta per non dire mai «nulla è
  // stato scritto» dopo aver scritto. Se quella garanzia si rompesse, l'incasso
  // sarebbe a registro e la risposta direbbe il contrario: l'operatrice
  // ritenterebbe, e per le voci NUOVE e i ticket niente la fermerebbe.
  it('un audit che esplode NON trasforma un incasso RIUSCITO in un 500 «nulla è stato scritto»', async () => {
    h.audit.mockRejectedValue(new Error('app_log irraggiungibile'))
    const res = await post(soloVociEsistenti)
    expect(res.status).toBe(200)
    expect(h.rpcCalls).toHaveLength(1)
    expect(eventiRotta().some((c) => (c[2] as { esito?: string }).esito === 'audit_non_scritto' && c[1] === 'error')).toBe(true)
  })

  it('un audit che esplode non porta via con sé le notifiche alla famiglia', async () => {
    h.audit.mockRejectedValue(new Error('app_log irraggiungibile'))
    await post(soloVociEsistenti)
    expect(h.notifica).toHaveBeenCalledTimes(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 LA CAUSA RADICE DEI DUE RILIEVI QUI SOTTO, DETTA UNA VOLTA SOLA.
//
// `componi` trattava il movimento come se fosse APPENA ARRIVATO DALLA BANCA, e
// non leggeva nessuna delle due cose che la RIAPERTURA conserva apposta:
// `scuola_id` e `pagamento_id`. Le due migrazioni di questa fetta le preservano
// con un commento che spiega perché (`…180200` riga 346: la `SET` dell'UPDATE
// NON le tocca; `[id]:PATCH` riga 669: «a NULL la riga sparirebbe dalla vista di
// sede di chi deve rilavorarla»). Questa rotta non le guardava.
//
// Non sono due difetti: è uno stato nuovo — «movimento RIAPERTO» — nato in
// questo stesso branch col pulsante d'annullo, di cui esistono DUE porte.
// `riconciliazione/[id]:PATCH` è la prima e le legge entrambe. `componi` è la
// seconda, e su quello stato arriva con `da_abbinare`, cioè dentro
// `STATI_CONCILIABILI`.
// ─────────────────────────────────────────────────────────────────────────────

// ─── RILIEVO 1 · IL MOVIMENTO HA UNA SEDE, E VA GUARDATA ─────────────────────
// La `SELECT` portava a casa `scuola_id` e nelle 981 righe non lo usava mai.
// Sonda del 2026-09-13 (prima della correzione): movimento con `scuola_id` fuori
// dalle sedi attive, stato `da_abbinare` → **HTTP 200, RPC chiamata**, e nel
// payload `scuola_id` = la sede DELL'OPERATORE. Il CAS della RPC la scrive
// (`…180100` riga 791: `UPDATE … SET … scuola_id = v_scuola`) con un `WHERE` che
// confronta il solo stato: un operatore di Cesa consumava il bonifico di
// Giugliano E GLI RISCRIVEVA LA SEDE, facendolo sparire dal filtro di Giugliano
// — che a quel punto non poteva più nemmeno riaprirlo, perché la riapertura passa
// da `assertTransazioneInScope` e la transazione era ormai di Cesa.
//
// La rotta sorella quel gate ce l'ha (`[id]:PATCH`, ramo `riapri`:
// `else if (mov.scuola_id && !sediRiapertura.includes(mov.scuola_id))` → 404).
// Due scritture che dicono due cose opposte sulla stessa riga bancaria.
describe('componi — il MOVIMENTO è di una sede che l’operatore non gestisce (rilievo 1)', () => {
  /**
   * Lo scope ristretto a SEDE_A, e le voci ridotte alla sola P1 che vi appartiene.
   * Il finto client IGNORA i filtri `.in(…)`: lasciando nel fixture anche P2 (di
   * SEDE_B) scatterebbe il 403 `voci-fuori-sede`, e questi test sarebbero rossi
   * per la ragione sbagliata — cioè verdi anche senza il gate che collaudano.
   */
  const soloSedeA = () => {
    h.scope.mockResolvedValue([SEDE_A])
    h.pagamenti = h.pagamenti.filter((p) => p.scuola_id === SEDE_A)
    h.alunni = h.alunni.filter((a) => a.scuola_id === SEDE_A)
  }

  it('movimento di un plesso fuori scope → 404 CONCILIAZIONE_MOVIMENTO_NON_TROVATO, nessuna RPC', async () => {
    soloSedeA()
    h.movimento = { ...h.movimento!, scuola_id: SEDE_B }
    const res = await post(soloVociEsistenti)
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('CONCILIAZIONE_MOVIMENTO_NON_TROVATO')
    // È la cosa che conta più del codice HTTP: senza RPC il CAS non può
    // riscrivere `scuola_id`, e la riga resta dov'è.
    expect(h.rpcCalls).toHaveLength(0)
    expect(h.audit).not.toHaveBeenCalled()
    expect(h.notifica).not.toHaveBeenCalled()
  })

  it('404 e non 403: il corpo non conferma l’esistenza di una riga bancaria di un altro plesso', async () => {
    soloSedeA()
    h.movimento = { ...h.movimento!, scuola_id: SEDE_B }
    const res = await post(soloVociEsistenti)
    const corpo = JSON.stringify(await res.json())
    expect(corpo).not.toContain(SEDE_B)
    expect(corpo).not.toContain(MOV)
  })

  it('il rifiuto lascia una riga di log a `warn` (un gate muto non si conta)', async () => {
    soloSedeA()
    h.movimento = { ...h.movimento!, scuola_id: SEDE_B }
    await post(soloVociEsistenti)
    const riga = eventiRotta().find((c) => (c[2] as { esito?: string }).esito === 'movimento-fuori-sede')
    expect(riga).toBeDefined()
    expect(riga![0]).toBe('pagamento')
    expect(riga![1]).toBe('warn')
  })

  it('il gate arriva PRIMA di ogni lettura di voci, bambini e legami', async () => {
    soloSedeA()
    h.movimento = { ...h.movimento!, scuola_id: SEDE_B }
    await post(soloVociEsistenti)
    const tabelle = h.letture.map((l) => l.tabella)
    expect(tabelle).toContain('riconciliazione_movimenti')
    expect(tabelle).not.toContain('pagamenti')
    expect(tabelle).not.toContain('alunni')
    expect(tabelle).not.toContain('student_parents')
  })

  it('movimento SENZA sede → si concilia: sono i 65 conciliabili di oggi, tutti a `scuola_id` NULL', async () => {
    soloSedeA()
    h.movimento = { ...h.movimento!, scuola_id: null }
    const res = await post(soloVociEsistenti)
    expect(res.status).toBe(200)
    expect(h.rpcCalls).toHaveLength(1)
  })

  it('movimento di una sede ACCESSIBILE → si concilia (il gate non blocca il caso normale)', async () => {
    h.scope.mockResolvedValue([SEDE_A, SEDE_B])
    h.movimento = { ...h.movimento!, scuola_id: SEDE_B }
    const res = await post(soloVociEsistenti)
    expect(res.status).toBe(200)
    expect(h.rpcCalls).toHaveLength(1)
  })
})

// ─── RILIEVO 2 · LA SECONDA PORTA SULLO STESSO RIABBINAMENTO ─────────────────
// La `SELECT` del movimento non chiedeva `pagamento_id`, e nelle 981 righe non
// compariva nessuna delle parole `fatture_emesse`, `fatturaViva`,
// `BONIFICO_GIA_FATTURATO`, `BONIFICO_FATTURA_NON_VERIFICABILE`.
//
// La testata di `componi` (§4) mostra che l'autore conosceva il problema e l'ha
// chiuso ESCLUDENDO `confermato` da `STATI_CONCILIABILI`. Ma il movimento di cui
// parla la rotta sorella NON è confermato: è **riaperto**, cioè `da_abbinare` —
// dentro `STATI_CONCILIABILI`. Quella riga copriva metà del caso.
//
// Esito, con un 200 sopra: un documento fiscale vivo senza l'incasso che lo
// giustifica, un secondo incasso, e una notifica «Pagamento registrato» al
// genitore.
describe('componi — un bonifico non si fattura due volte (rilievo 2)', () => {
  /** Il movimento come lo lascia `annulla_transazione_contabile`: riaperto, con la memoria di P2. */
  const riaperto = () => {
    h.movimento = { ...h.movimento!, stato: 'da_abbinare', pagamento_id: P2, transazione_id: null }
  }
  const VIVA = { numero: 2328, anno: 2026, sezionale: 'Asilo', sdi_stato: 1 }

  it('riabbinato ALTROVE con una fattura VIVA sulla voce di prima → 409 BONIFICO_GIA_FATTURATO, nessuna RPC', async () => {
    riaperto()
    h.fatture = [VIVA]
    const res = await post(soloVociEsistenti) // le voci sono [P1], non P2
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('BONIFICO_GIA_FATTURATO')
    expect(h.rpcCalls).toHaveLength(0)
    expect(h.audit).not.toHaveBeenCalled()
    expect(h.notifica).not.toHaveBeenCalled()
  })

  it('il 409 porta il NUMERO del documento — e nient’altro che si possa leggere su una famiglia', async () => {
    riaperto()
    h.fatture = [VIVA]
    const res = await post(soloVociEsistenti)
    const j = (await res.json()) as { error: string }
    // `BONIFICO_GIA_FATTURATO` è in `CODICI_CON_DETTAGLIO`: a schermo si legge la
    // frase tradotta PIÙ questa coda, ed è l'unica cosa che dica quale documento
    // andare a guardare.
    expect(j.error).toContain('Asilo 2328/2026')
    const corpo = JSON.stringify(j)
    expect(corpo).not.toContain(P2)
    expect(corpo).not.toContain('Laboratorio musica')
  })

  it('lettura di `fatture_emesse` FALLITA → 503 BONIFICO_FATTURA_NON_VERIFICABILE, fail-closed', async () => {
    // PostgREST non lancia: ritorna `{ error }`. Con l'errore scartato «nessuna
    // fattura» e «non l'abbiamo potuta leggere» sarebbero la stessa cosa, e un
    // guasto di lettura diventerebbe un secondo incasso.
    riaperto()
    h.fattureError = { code: '57014', message: 'canceling statement due to statement timeout' }
    const res = await post(soloVociEsistenti)
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('BONIFICO_FATTURA_NON_VERIFICABILE')
    expect(h.rpcCalls).toHaveLength(0)
    expect(h.logErrore).toHaveBeenCalled()
  })

  it('fattura SCARTATA dallo SDI non ferma niente: una riga scartata si riemette', async () => {
    riaperto()
    h.fatture = [{ numero: 2328, anno: 2026, sezionale: 'Asilo', sdi_stato: 4 }]
    const res = await post(soloVociEsistenti)
    expect(res.status).toBe(200)
    expect(h.rpcCalls).toHaveLength(1)
  })

  it('la voce di prima è DENTRO la composizione → non è un riabbinamento, e passa', async () => {
    // Il documento continua ad avere l'incasso che lo giustifica: qui non c'è
    // niente da fermare, e fermarlo vieterebbe il caso più normale — ricomporre
    // lo stesso bonifico sulla stessa voce più altre.
    riaperto()
    h.fatture = [VIVA]
    h.movimento = { ...h.movimento!, importo: 160 }
    const res = await post({
      scuola_id: SEDE_A, pagante_parent_id: PARENT,
      voci: [{ pagamento_id: P2, importo: 60 }, { pagamento_id: P1, importo: 100 }],
    })
    expect(res.status).toBe(200)
    expect(h.rpcCalls).toHaveLength(1)
  })

  it('movimento SENZA memoria di un pagamento → `fatture_emesse` non si legge nemmeno', async () => {
    // È il caso di sempre (un bonifico appena arrivato): la guardia costa una
    // lettura, e solo quando il pagamento cambia davvero.
    const res = await post(soloVociEsistenti)
    expect(res.status).toBe(200)
    expect(h.letture.map((l) => l.tabella)).not.toContain('fatture_emesse')
  })

  it('nessuna fattura sulla voce di prima → si riabbina, come oggi', async () => {
    riaperto()
    h.fatture = []
    const res = await post(soloVociEsistenti)
    expect(res.status).toBe(200)
    expect(h.rpcCalls).toHaveLength(1)
  })

  it('il rifiuto lascia una riga di log a `warn`, coi soli numeri', async () => {
    riaperto()
    h.fatture = [VIVA]
    await post(soloVociEsistenti)
    const riga = eventiRotta().find((c) => (c[2] as { esito?: string }).esito === 'bonifico-gia-fatturato-fermato')
    expect(riga).toBeDefined()
    expect(riga![1]).toBe('warn')
    expect((riga![2] as { numero?: number }).numero).toBe(2328)
  })
})

// ─── RILIEVO 3 · LA REVOCA DELLA SOSPENSIONE STA IN UN `try`, E NESSUNO LO DICEVA
// Misura del 2026-09-13: tolto il `try/catch` e lasciata la chiamata nuda, il
// file restava **83/83 verde**. I due presidi fratelli — notifica e audit —
// hanno ciascuno il proprio test; questo no. E il comportamento non è un
// dettaglio: `withRoute` non vede le eccezioni catturate, quindi senza quel
// `try` l'eccezione salterebbe al `catch` in fondo, che risponde
// `500 CONCILIAZIONE_NON_REGISTRATA` — «nulla è stato scritto» col denaro già
// scritto, cioè la bugia esatta che la rete del `movimento_confermato` esiste
// per evitare. L'operatrice ritenterebbe, e sulle voci NUOVE e sui ticket non
// c'è residuo che la fermi.
describe('componi — la revoca della sospensione per morosità è BEST-EFFORT (rilievo 3)', () => {
  it('una revoca che ESPLODE non trasforma un incasso riuscito in un 500 «nulla è stato scritto»', async () => {
    h.revoca.mockRejectedValue(new Error('sospensione: tabella irraggiungibile'))
    const res = await post(soloVociEsistenti)
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)
    expect(h.rpcCalls).toHaveLength(1)
  })

  it('e viene loggata a `error`: un `catch` che non logga è un bug', async () => {
    h.revoca.mockRejectedValue(new Error('sospensione: tabella irraggiungibile'))
    await post(soloVociEsistenti)
    const riga = eventiRotta().find((c) => (c[2] as { esito?: string }).esito === 'revoca_non_verificata')
    expect(riga).toBeDefined()
    expect(riga![1]).toBe('error')
  })

  it('una revoca che esplode non porta via con sé l’audit né le notifiche', async () => {
    h.revoca.mockRejectedValue(new Error('sospensione: tabella irraggiungibile'))
    await post(soloVociEsistenti)
    expect(h.audit).toHaveBeenCalledTimes(1)
    expect(h.notifica).toHaveBeenCalledTimes(1)
  })
})

// ─── RILIEVO 4 · IL SECONDO `CONCILIAZIONE_ANCORA_MANCANTE` È IRRAGGIUNGIBILE ──
// Nessun test può coprirlo, e non per pigrizia: `proponiAncora` ritorna `null`
// SOLTANTO su `righe.length === 0`, e su zero righe `puoConfermare` ha già detto
// no — `violazioniComposizione` emette `composizione_vuota` — cioè la rotta è
// uscita col 422 venti righe prima.
//
// Il ramo RESTA, e la scelta è motivata in testa a quel `if` nella rotta. Qui si
// fa la cosa che un commento non può fare: si MISURA l'invariante da cui
// l'irraggiungibilità dipende. Se domani `proponiAncora` guadagnasse un secondo
// ramo `null` — «nessuna riga fatturabile», per dire — questi due test
// diventerebbero rossi, e chi li legge saprebbe che quel ramo è tornato vivo
// **prima** di scoprirlo da un 400 in produzione. È la differenza fra una
// dichiarazione e una misura.
describe('componi — l’àncora proposta non manca mai (rilievo 4: il ramo è irraggiungibile, e si misura)', () => {
  const esistente: RigaComposizione = {
    specie: 'esistente', pagamentoId: P1, alunnoId: AL1, scuolaId: SEDE_A,
    categoriaSlug: 'laboratorio', descrizione: 'Laboratorio', residuo: 100, importo: 100,
  }
  const nuova: RigaComposizione = {
    specie: 'nuova', alunnoId: AL1, scuolaId: SEDE_A, categoriaId: CAT,
    descrizione: 'Uscita anticipata', importo: 30,
  }
  const ticket: RigaComposizione = {
    specie: 'ticket', alunnoId: AL1, scuolaId: SEDE_A, quantita: 10, costoUnitario: 5,
  }

  it('`proponiAncora` ritorna `null` SOLO sull’elenco vuoto — una riga qualunque basta', () => {
    expect(proponiAncora([])).toBeNull()
    for (const riga of [esistente, nuova, ticket]) {
      expect(proponiAncora([riga])).not.toBeNull()
    }
    expect(proponiAncora([esistente, nuova, ticket])).not.toBeNull()
  })

  it('e sull’elenco vuoto `puoConfermare` ha già detto no: il 422 esce prima, per QUALUNQUE importo', () => {
    for (const importo of [0, 0.01, 1, 100, 1_000_000]) {
      expect(puoConfermare([], importo)).toBe(false)
    }
  })
})
