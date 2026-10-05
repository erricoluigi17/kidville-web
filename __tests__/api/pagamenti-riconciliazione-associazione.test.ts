import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * A CHE COSA È ASSOCIATO QUESTO BONIFICO? — `GET /api/pagamenti/riconciliazione/[id]`
 * e il seguito `poi: 'ignorato'` della riapertura (`PATCH … { azione: 'riapri' }`).
 *
 * ─── CHE COSA CAMBIA ─────────────────────────────────────────────────────────
 * Il popup di Riconciliazione sapeva dire lo stato della fattura della voce
 * àncora e basta: non la voce, non il bambino, non chi aveva confermato. La GET
 * risponde alla domanda intera in UNA richiesta. Il PATCH impara a «eliminare
 * l'associazione»: riaprire il confermato e, nello stesso giro, mettere la riga
 * fra gli ignorati — ma solo se è davvero tornata in coda (`stato = 'da_abbinare'`).
 *
 * ─── COME MORDONO QUESTI TEST ───────────────────────────────────────────────
 * Il finto distingue per TABELLA e per FILTRO: `pagamenti` risponde solo con le
 * righe chieste in `.in('id', …)`, `fatture_coda` solo con quelle degli stati
 * chiesti. Un incasso stornato che il codice dimenticasse di escludere arriverebbe
 * quindi davvero nella risposta. Gli UPDATE di `riconciliazione_movimenti`
 * rispondono da una CODA di esiti: il primo è la riapertura (compare-and-swap),
 * il secondo l'«ignora» di `poi`.
 *
 * Dati SINTETICI: uuid finti e nomi inventati (il repo è pubblico).
 */

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  notificaEvento: vi.fn(),
  verificaRevoca: vi.fn(),
  logOk: vi.fn(),
  logErrore: vi.fn(),
  logEvento: vi.fn(),
  sediAttive: ['sc-1'] as string[],
  /** La risposta del gate `assertPagamentoInScope` (null = dentro il perimetro). */
  fuoriScopePagamento: null as Response | null,
  movimento: null as Record<string, unknown> | null,
  /** Errore iniettabile sulla lettura del movimento che chiede `abbinato_auto_il`. */
  marcaError: null as { code: string; message: string } | null,
  /** Gli incassi della transazione composita (`.eq('transazione_id', …)`). */
  incassiTx: [] as Record<string, unknown>[],
  incassiTxError: null as { code: string; message: string } | null,
  /** L'incasso della voce singola (`.eq('id', …).maybeSingle()`). */
  incasso: null as Record<string, unknown> | null,
  /**
   * Il DB E2E della CI, non migrato: su `incassi` le colonne `stornato_il` e
   * `storno_di` non esistono. Ogni lettura che le NOMINA risponde con questo
   * codice (`42703`/`PGRST204`); la stessa lettura senza, va. Si emula sul
   * CONTENUTO della select, non con «la prima lettura fallisce».
   */
  colonneStornoAssenti: null as string | null,
  pagamenti: [] as Record<string, unknown>[],
  pagamentiError: null as { code: string; message: string } | null,
  coda: [] as Record<string, unknown>[],
  codaError: null as { code: string; message: string } | null,
  utente: null as Record<string, unknown> | null,
  utenteError: null as { code: string; message: string } | null,
  transazione: null as Record<string, unknown> | null,
  letture: [] as { table: string; cols: string; filtri: Record<string, unknown> }[],
  inserts: [] as { table: string; row: unknown }[],
  updates: [] as { table: string; row: Record<string, unknown>; filtri: Record<string, unknown> }[],
  /** Esiti in coda degli UPDATE di `riconciliazione_movimenti` (vuota = una riga toccata). */
  esitiUpdateMov: [] as { data: unknown; error: { code: string; message: string } | null }[],
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento }))
vi.mock('@/lib/pagamenti/sospensione', () => ({ verificaRevocaSospensioneMorosita: h.verificaRevoca }))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuolaScrittura: async () => ({ scuolaId: 'sc-1' }),
  resolveScuoleAttive: async () => h.sediAttive,
  assertPagamentoInScope: async () => h.fuoriScopePagamento,
}))
vi.mock('@/lib/logging/logger', () => ({
  logOk: h.logOk,
  logErrore: h.logErrore,
  logEvento: h.logEvento,
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => finto(),
}))

/** Le righe di `righe` che passano TUTTI i filtri registrati (`eq` = uguale, `in` = appartiene). */
function filtra(righe: Record<string, unknown>[], filtri: Record<string, unknown>) {
  return righe.filter((r) =>
    Object.entries(filtri).every(([c, v]) => (Array.isArray(v) ? v.includes(r[c]) : r[c] === v)),
  )
}

function finto() {
  return {
    from: (table: string) => {
      const filtri: Record<string, unknown> = {}
      const b: Record<string, unknown> = {}
      b.select = (cols?: string) => { b._cols = cols ?? ''; return b }
      b.eq = (c: string, v: unknown) => { filtri[c] = v; return b }
      b.in = (c: string, v: unknown) => { filtri[c] = v; return b }
      b.is = (c: string, v: unknown) => { filtri[c] = v; return b }
      b.order = () => b
      b.limit = () => b
      const cols = () => (typeof b._cols === 'string' ? b._cols : '')
      const registra = () => h.letture.push({ table, cols: cols(), filtri: { ...filtri } })
      const colonnaStornoRespinta = () =>
        table === 'incassi' && h.colonneStornoAssenti && /stornato_il|storno_di/.test(cols())
          ? { data: null, error: { code: h.colonneStornoAssenti, message: 'column incassi.stornato_il does not exist' } }
          : null
      b.maybeSingle = async () => {
        registra()
        const respinta = colonnaStornoRespinta()
        if (respinta) return respinta
        if (table === 'riconciliazione_movimenti') {
          if (cols().includes('abbinato_auto_il') && h.marcaError) return { data: null, error: h.marcaError }
          return { data: h.movimento, error: null }
        }
        if (table === 'incassi') {
          const r = h.incasso && (!('id' in filtri) || h.incasso.id === filtri.id) ? h.incasso : null
          return { data: r, error: null }
        }
        if (table === 'utenti') return { data: h.utenteError ? null : h.utente, error: h.utenteError }
        if (table === 'pagamenti_transazioni') return { data: h.transazione, error: null }
        return { data: null, error: null }
      }
      b.single = async () => { registra(); return { data: null, error: null } }
      b.insert = (row: unknown) => {
        h.inserts.push({ table, row })
        return {
          select: () => ({ single: async () => ({ data: { id: `${table}-new` }, error: null }) }),
          then: (r: (v: unknown) => unknown) => r({ data: null, error: null }),
        }
      }
      b.update = (row: Record<string, unknown>) => {
        const uf: Record<string, unknown> = {}
        const u: Record<string, unknown> = {}
        u.eq = (c: string, v: unknown) => { uf[c] = v; return u }
        u.in = (c: string, v: unknown) => { uf[c] = v; return u }
        u.is = (c: string, v: unknown) => { uf[c] = v; return u }
        const spingi = () => h.updates.push({ table, row, filtri: { ...uf } })
        u.select = () => ({
          then: (r: (v: unknown) => unknown) => {
            spingi()
            if (table === 'riconciliazione_movimenti') {
              return r(h.esitiUpdateMov.shift() ?? { data: [{ id: 'mov-upd' }], error: null })
            }
            return r({ data: [{ id: `${table}-upd` }], error: null })
          },
        })
        u.then = (r: (v: unknown) => unknown) => { spingi(); return r({ data: null, error: null }) }
        return u
      }
      b.then = (resolve: (v: unknown) => unknown) => {
        registra()
        const respinta = colonnaStornoRespinta()
        if (respinta) return resolve(respinta)
        if (table === 'incassi' && 'transazione_id' in filtri) {
          return resolve({ data: h.incassiTxError ? null : filtra(h.incassiTx, filtri), error: h.incassiTxError })
        }
        if (table === 'pagamenti') {
          return resolve({ data: h.pagamentiError ? null : filtra(h.pagamenti, filtri), error: h.pagamentiError })
        }
        if (table === 'fatture_coda') {
          return resolve({ data: h.codaError ? null : filtra(h.coda, filtri), error: h.codaError })
        }
        return resolve({ data: [], error: null })
      }
      return b
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.rpcCalls.push({ name, args })
      return { data: null, error: null }
    },
  }
}

import { GET, PATCH } from '@/app/api/pagamenti/riconciliazione/[id]/route'

const MID = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1'
const PID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const PID2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const PID3 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'
const TXID = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3'
const INCID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4'
const OPERATORE = 'ffffffff-ffff-4fff-8fff-fffffffffff5'

const get = (id = MID) =>
  GET(new Request(`http://localhost/api/pagamenti/riconciliazione/${id}`), { params: Promise.resolve({ id }) })

const patch = (body: unknown) =>
  PATCH(
    new Request(`http://localhost/api/pagamenti/riconciliazione/${MID}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: MID }) },
  )

const letteDa = (tabella: string) => h.letture.filter((l) => l.table === tabella)
const updateDi = (tabella: string) => h.updates.filter((u) => u.table === tabella)

type Voce = Record<string, unknown>
type CorpoGet = {
  success?: boolean
  codice?: string
  data?: {
    id?: string
    stato?: string
    importo?: number
    data_operazione?: string
    associazione?: { tipo?: string; automatico?: boolean; confermato_il?: string | null; confermato_da?: string | null; voci?: Voce[] } | null
    pagamento?: { stato?: string; fattura_stato?: string | null } | null
  }
}

/** Nessun nome (bambino, operatore) deve finire in un log: solo uuid, numeri, booleani. */
function nessunNomeNeiLog() {
  const tutto = JSON.stringify([...h.logEvento.mock.calls, ...h.logErrore.mock.calls, ...h.logOk.mock.calls])
  for (const nome of ['Mara', 'Bianchi', 'Luca', 'Rossi', 'Anna', 'Verdi']) {
    expect(tutto, `il nome «${nome}» è finito in un log`).not.toContain(nome)
  }
}

const vocePagamento = (id: string, extra: Record<string, unknown> = {}) => ({
  id, descrizione: 'Retta settembre', importo: 300, stato: 'parziale', scuola_id: 'sc-1',
  fattura_stato: null, alunni: { nome: 'Mara', cognome: 'Bianchi' }, ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  h.sediAttive = ['sc-1']
  h.fuoriScopePagamento = null
  h.marcaError = null
  h.letture = []
  h.inserts = []
  h.updates = []
  h.esitiUpdateMov = []
  h.rpcCalls = []
  h.incassiTx = []
  h.incassiTxError = null
  h.colonneStornoAssenti = null
  h.pagamentiError = null
  h.coda = []
  h.codaError = null
  h.utenteError = null
  h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
  h.movimento = {
    id: MID, scuola_id: 'sc-1', importo: 150, data_operazione: '2026-09-05',
    causale: 'BONIFICO', stato: 'confermato', suggerimenti: null,
    pagamento_id: PID, incasso_id: INCID, transazione_id: null, abbinato_auto_il: null,
    confermato_da: OPERATORE, confermato_il: '2026-09-06T10:00:00Z',
  }
  h.incasso = { id: INCID, pagamento_id: PID, importo: 150, metodo: 'bonifico', storno_di: null, stornato_il: null }
  h.pagamenti = [vocePagamento(PID)]
  h.utente = { nome: 'Anna', cognome: 'Verdi' }
  h.transazione = { id: TXID, scuola_id: 'sc-1', annullata_il: null }
})

// ═════════════════════════════════════════════════════════════════════════════
describe('GET — a che cosa è associato il bonifico', () => {
  it('voce SINGOLA: voce, bambino, quanto ha messo il bonifico, chi ha confermato', async () => {
    const res = await get()

    expect(res.status).toBe(200)
    const j = (await res.json()) as CorpoGet
    expect(j.success).toBe(true)
    expect(j.data?.id).toBe(MID)
    expect(j.data?.stato).toBe('confermato')
    expect(j.data?.importo).toBe(150)
    expect(j.data?.data_operazione).toBe('2026-09-05')
    expect(j.data?.associazione).toEqual({
      tipo: 'singola',
      automatico: false,
      confermato_il: '2026-09-06T10:00:00Z',
      confermato_da: 'Anna Verdi',
      voci: [{
        pagamento_id: PID,
        descrizione: 'Retta settembre',
        alunno: 'Mara Bianchi',
        scuola_id: 'sc-1',
        importo_voce: 300,
        incassato_qui: 150,
        stato_voce: 'parziale',
        fattura_stato: null,
        fattura_in_coda: null,
      }],
    })
    // Ciò che prima arrivava da `/api/pagamenti/[id]`: stato e fattura della voce àncora.
    expect(j.data?.pagamento).toEqual({ stato: 'parziale', fattura_stato: null })

    // Il movimento si legge con le due colonne della conferma.
    const mov = letteDa('riconciliazione_movimenti')
    expect(mov[0].cols).toContain('confermato_da')
    expect(mov[0].cols).toContain('confermato_il')
    // L'operatore si cerca per il SUO uuid.
    expect(letteDa('utenti')[0].filtri.id).toBe(OPERATORE)
    nessunNomeNeiLog()
  })

  it('una marca «abbinato dalla macchina» si legge come `automatico: true`', async () => {
    h.movimento = { ...h.movimento!, abbinato_auto_il: '2026-09-06T03:00:00Z' }

    const j = (await (await get()).json()) as CorpoGet

    expect(j.data?.associazione?.automatico).toBe(true)
  })

  it('COMPOSITA: le voci dagli incassi vivi, la voce àncora per prima, lo storno escluso', async () => {
    h.movimento = { ...h.movimento!, transazione_id: TXID, incasso_id: null }
    h.incassiTx = [
      { transazione_id: TXID, pagamento_id: PID2, importo: 80, stornato_il: null, storno_di: null },
      { transazione_id: TXID, pagamento_id: PID, importo: 70, stornato_il: null, storno_di: null },
      // Un incasso stornato e il suo contro-incasso: il denaro NON è più lì.
      { transazione_id: TXID, pagamento_id: PID3, importo: 50, stornato_il: '2026-09-07T09:00:00Z', storno_di: null },
      { transazione_id: TXID, pagamento_id: PID3, importo: -50, stornato_il: null, storno_di: 'inc-x' },
    ]
    h.pagamenti = [
      vocePagamento(PID, { importo: 70, stato: 'pagato', fattura_stato: 'emessa' }),
      vocePagamento(PID2, { importo: 80, stato: 'pagato', alunni: { nome: 'Luca', cognome: 'Rossi' } }),
      vocePagamento(PID3, { importo: 50, stato: 'da_pagare' }),
    ]

    const res = await get()

    expect(res.status).toBe(200)
    const j = (await res.json()) as CorpoGet
    expect(j.data?.associazione?.tipo).toBe('composita')
    const voci = j.data?.associazione?.voci ?? []
    expect(
      voci.map((v) => v.pagamento_id),
      'la voce di un incasso stornato compare ancora fra quelle pagate dal bonifico',
    ).toEqual([PID, PID2])
    expect(voci.map((v) => v.incassato_qui)).toEqual([70, 80])
    expect(voci[1].alunno).toBe('Luca Rossi')
    expect(j.data?.pagamento).toEqual({ stato: 'pagato', fattura_stato: 'emessa' })
    // Gli incassi si leggono per TRANSAZIONE, non per l'incasso della voce àncora.
    expect(letteDa('incassi')[0].filtri.transazione_id).toBe(TXID)
    nessunNomeNeiLog()
  })

  /**
   * ─── UN FRATELLO ISCRITTO IN UN'ALTRA SEDE (privacy multi-sede) ─────────────
   *
   * Un bonifico composito può pagare le voci di due fratelli in due plessi. Il
   * gate di sede lascia passare il movimento (la sua sede è di chi guarda), ma la
   * voce del fratello è di una sede che questa segreteria NON vede: il nome del
   * bambino e la descrizione della voce non devono uscire. Restano le CIFRE — il
   * denaro del bonifico va spiegato per intero, o la somma non torna — e il segno
   * `fuori_sede`, con cui il popup dice «Voce di un'altra sede».
   */
  it('COMPOSITA con un fratello in un’ALTRA sede: la sua voce senza nome né descrizione, le cifre restano', async () => {
    h.movimento = { ...h.movimento!, transazione_id: TXID, incasso_id: null }
    h.incassiTx = [
      { transazione_id: TXID, pagamento_id: PID, importo: 70, stornato_il: null, storno_di: null },
      { transazione_id: TXID, pagamento_id: PID2, importo: 80, stornato_il: null, storno_di: null },
    ]
    h.pagamenti = [
      vocePagamento(PID, { importo: 70, stato: 'pagato' }),
      vocePagamento(PID2, {
        importo: 80, stato: 'pagato', scuola_id: 'sc-2', fattura_stato: 'emessa',
        descrizione: 'Retta di Luca', alunni: { nome: 'Luca', cognome: 'Rossi' },
      }),
    ]
    h.coda = [{ pagamento_id: PID2, stato: 'in_coda' }]

    const res = await get()

    expect(res.status).toBe(200)
    const corpo = await res.text()
    const voci = ((JSON.parse(corpo) as CorpoGet).data?.associazione?.voci ?? [])
    // La voce di casa: tutto in chiaro, e nessun segno «fuori sede».
    expect(voci[0]).toMatchObject({ pagamento_id: PID, alunno: 'Mara Bianchi', descrizione: 'Retta settembre' })
    expect(voci[0].fuori_sede, 'la voce di CASA segnata come di un’altra sede').toBeUndefined()
    // La voce dell'altra sede: nomi tolti, cifre e stati intatti.
    expect(voci[1]).toEqual({
      pagamento_id: PID2,
      descrizione: null,
      alunno: null,
      fuori_sede: true,
      scuola_id: 'sc-2',
      importo_voce: 80,
      incassato_qui: 80,
      stato_voce: 'pagato',
      fattura_stato: 'emessa',
      fattura_in_coda: 'in_coda',
    })
    // …e non solo nel campo: in NESSUN punto della risposta.
    for (const dato of ['Luca', 'Rossi', 'Retta di Luca']) {
      expect(corpo, `«${dato}» di un’altra sede è uscito nella risposta`).not.toContain(dato)
    }
    nessunNomeNeiLog()
  })

  it('una voce SENZA sede è trattata come fuori sede: nel dubbio non si mostra', async () => {
    h.pagamenti = [vocePagamento(PID, { scuola_id: null })]

    const j = (await (await get()).json()) as CorpoGet

    const voce = j.data?.associazione?.voci?.[0]
    expect(voce?.fuori_sede).toBe(true)
    expect(voce?.alunno).toBeNull()
    expect(voce?.importo_voce, 'le cifre restano anche qui').toBe(300)
  })

  it('il confronto delle sedi ignora le maiuscole: la PROPRIA sede scritta diversa resta di casa', async () => {
    // In Postgres `uuid` è un TIPO: 'SC-1' e 'sc-1' sono lo stesso valore. Un `===`
    // oscurerebbe la voce della propria sede (`formaConfronto` in `@/lib/auth/scope`).
    h.sediAttive = ['SC-1']
    h.movimento = { ...h.movimento!, scuola_id: 'SC-1' }

    const j = (await (await get()).json()) as CorpoGet

    const voce = j.data?.associazione?.voci?.[0]
    expect(voce?.alunno).toBe('Mara Bianchi')
    expect(voce?.fuori_sede).toBeUndefined()
  })

  it('voce SINGOLA con l’incasso stornato dal registro: la voce resta, `incassato_qui: 0`', async () => {
    // Uno storno fatto a mano dal registro incassi, senza riaprire il movimento:
    // il denaro non è più sulla voce, e il popup non deve dire che c'è.
    h.incasso = { ...h.incasso!, stornato_il: '2026-09-07T09:00:00Z' }

    const j = (await (await get()).json()) as CorpoGet

    const voci = j.data?.associazione?.voci ?? []
    expect(voci.map((v) => v.pagamento_id)).toEqual([PID])
    expect(voci[0].incassato_qui, 'un incasso stornato conta ancora come denaro del bonifico').toBe(0)
    expect(letteDa('incassi')[0].filtri.id).toBe(INCID)
  })

  it('movimento DA ABBINARE: `associazione: null`, e nessuna lettura delle voci', async () => {
    h.movimento = { ...h.movimento!, stato: 'da_abbinare', pagamento_id: null, incasso_id: null, scuola_id: null }

    const res = await get()

    expect(res.status).toBe(200)
    const j = (await res.json()) as CorpoGet
    expect(j.data?.stato).toBe('da_abbinare')
    expect(j.data?.associazione).toBeNull()
    expect(j.data?.pagamento).toBeNull()
    expect(letteDa('incassi')).toEqual([])
    expect(letteDa('pagamenti')).toEqual([])
  })

  it('errore sulla lettura degli INCASSI: 500 `MOVIMENTO_NON_LETTO`, con il log', async () => {
    h.movimento = { ...h.movimento!, transazione_id: TXID }
    h.incassiTxError = { code: '57014', message: 'canceling statement due to statement timeout' }

    const res = await get()

    expect(res.status).toBe(500)
    expect(((await res.json()) as CorpoGet).codice).toBe('MOVIMENTO_NON_LETTO')
    expect(h.logErrore).toHaveBeenCalled()
  })

  /**
   * ─── IL DB E2E DELLA CI, NON MIGRATO (revisione finale, 2026-10-05) ──────────
   *
   * La lettura degli incassi chiede `stornato_il, storno_di`, che lì possono non
   * esistere: ogni popup di un confermato diceva «non è stato possibile leggere».
   * Ora si ritenta senza quelle colonne — gli incassi contano come vivi, perché
   * senza le colonne dello storno uno storno di quella forma non può esserci — e
   * un `warn` lo dice. Un guasto VERO resta un 500 (il test qui sopra).
   */
  it.each(['42703', 'PGRST204'])('voce SINGOLA, colonne dello storno assenti (%s): si ritenta senza, 200, e un `warn`', async (codice) => {
    h.colonneStornoAssenti = codice

    const res = await get()

    expect(res.status).toBe(200)
    const voci = ((await res.json()) as CorpoGet).data?.associazione?.voci ?? []
    expect(voci.map((v) => v.pagamento_id)).toEqual([PID])
    expect(voci[0].incassato_qui, 'l’incasso del ritentativo non è stato contato').toBe(150)
    // Il primo tentativo nominava le colonne; il secondo no, e cerca lo stesso incasso.
    const inc = letteDa('incassi')
    expect(inc).toHaveLength(2)
    expect(inc[0].cols).toContain('stornato_il')
    expect(inc[1].cols).not.toMatch(/stornato_il|storno_di/)
    expect(inc[1].filtri.id).toBe(INCID)
    const warn = h.logEvento.mock.calls.filter((c) => (c[2] as { esito?: string }).esito === 'associazione-colonne-storno-assenti')
    expect(warn).toHaveLength(1)
    expect(warn[0][1]).toBe('warn')
    expect(h.logErrore).not.toHaveBeenCalled()
    nessunNomeNeiLog()
  })

  it('COMPOSITA, colonne dello storno assenti: le voci dagli incassi della transazione, 200', async () => {
    h.colonneStornoAssenti = '42703'
    h.movimento = { ...h.movimento!, transazione_id: TXID, incasso_id: null }
    h.incassiTx = [
      { transazione_id: TXID, pagamento_id: PID, importo: 70 },
      { transazione_id: TXID, pagamento_id: PID2, importo: 80 },
    ]
    h.pagamenti = [vocePagamento(PID, { importo: 70 }), vocePagamento(PID2, { importo: 80 })]

    const res = await get()

    expect(res.status).toBe(200)
    const voci = ((await res.json()) as CorpoGet).data?.associazione?.voci ?? []
    expect(voci.map((v) => [v.pagamento_id, v.incassato_qui])).toEqual([[PID, 70], [PID2, 80]])
    expect(letteDa('incassi')).toHaveLength(2)
  })

  it('errore sulla lettura delle VOCI: 500 `MOVIMENTO_NON_LETTO`', async () => {
    h.pagamentiError = { code: '57014', message: 'timeout' }

    const res = await get()

    expect(res.status).toBe(500)
    expect(((await res.json()) as CorpoGet).codice).toBe('MOVIMENTO_NON_LETTO')
  })

  it('sede FUORI perimetro: 404, e nessuna voce né nome letti', async () => {
    h.movimento = { ...h.movimento!, scuola_id: 'sc-2' }

    const res = await get()

    expect(res.status).toBe(404)
    expect(((await res.json()) as CorpoGet).codice).toBe('CONCILIAZIONE_MOVIMENTO_NON_TROVATO')
    expect(letteDa('pagamenti')).toEqual([])
    expect(letteDa('utenti')).toEqual([])
  })

  it('confermato SENZA sede sulla riga: decide la sede della voce (`assertPagamentoInScope`)', async () => {
    h.movimento = { ...h.movimento!, scuola_id: null }
    h.fuoriScopePagamento = new Response(JSON.stringify({ error: 'Movimento non trovato' }), { status: 404 })

    const res = await get()

    expect(res.status).toBe(404)
    expect(letteDa('pagamenti')).toEqual([])
  })

  it('`fatture_coda` assente (42P01): `fattura_in_coda: null`, 200, e un `warn`', async () => {
    h.codaError = { code: '42P01', message: 'relation "public.fatture_coda" does not exist' }

    const res = await get()

    expect(res.status).toBe(200)
    const j = (await res.json()) as CorpoGet
    expect(j.data?.associazione?.voci?.[0].fattura_in_coda).toBeNull()
    const warn = h.logEvento.mock.calls.find((c) => c[1] === 'warn' && (c[2] as { esito?: string }).esito === 'associazione-coda-non-letta')
    expect(warn, 'una coda fatture non letta senza traccia nei log').toBeTruthy()
  })

  it('una voce in coda fatture con `errore`: lo dice', async () => {
    h.coda = [{ pagamento_id: PID, stato: 'errore' }, { pagamento_id: PID2, stato: 'in_coda' }]

    const j = (await (await get()).json()) as CorpoGet

    expect(j.data?.associazione?.voci?.[0].fattura_in_coda).toBe('errore')
  })

  it('operatore non leggibile: `confermato_da: null`, 200, e un `warn` senza nomi', async () => {
    h.utenteError = { code: '57014', message: 'timeout' }

    const res = await get()

    expect(res.status).toBe(200)
    const j = (await res.json()) as CorpoGet
    expect(j.data?.associazione?.confermato_da).toBeNull()
    expect(j.data?.associazione?.voci).toHaveLength(1)
    const warn = h.logEvento.mock.calls.find((c) => c[1] === 'warn' && (c[2] as { esito?: string }).esito === 'associazione-operatore-non-letto')
    expect(warn, 'un operatore non letto senza traccia nei log').toBeTruthy()
    nessunNomeNeiLog()
  })

  it('DB non migrato (`abbinato_auto_il` assente): si ritenta senza, 200 e `automatico: false`', async () => {
    h.marcaError = { code: '42703', message: 'column riconciliazione_movimenti.abbinato_auto_il does not exist' }

    const res = await get()

    expect(res.status).toBe(200)
    expect(((await res.json()) as CorpoGet).data?.associazione?.automatico).toBe(false)
    const mov = letteDa('riconciliazione_movimenti')
    expect(mov).toHaveLength(2)
    expect(mov[1].cols).not.toContain('abbinato_auto_il')
    // La variante più povera porta ANCORA le due colonne della conferma.
    expect(mov[1].cols).toContain('confermato_da')
  })

  it('movimento inesistente: 404', async () => {
    h.movimento = null

    expect((await get()).status).toBe(404)
  })

  it('id non uuid: 400, e il database non si tocca', async () => {
    expect((await get('non-un-uuid')).status).toBe(400)
    expect(h.letture).toEqual([])
  })

  it('senza staff: la risposta del gate', async () => {
    h.requireStaff.mockResolvedValue({ response: new Response(null, { status: 403 }) })

    expect((await get()).status).toBe(403)
    expect(h.letture).toEqual([])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('PATCH riapri con `poi` — eliminare l’associazione', () => {
  it('`poi: \'ignorato\'`: dopo la riapertura, un UPDATE condizionale a `da_abbinare` la ignora', async () => {
    const res = await patch({ azione: 'riapri', poi: 'ignorato' })

    expect(res.status).toBe(200)
    const j = (await res.json()) as { success?: boolean; data?: Record<string, unknown> }
    expect(j.success).toBe(true)
    expect(j.data?.stato).toBe('ignorato')
    expect(j.data?.ignorato).toBe(true)

    const upd = updateDi('riconciliazione_movimenti')
    expect(upd).toHaveLength(2)
    expect(upd[0].row.stato).toBe('da_abbinare')
    expect(upd[1].row).toEqual({ stato: 'ignorato' })
    expect(upd[1].filtri.id).toBe(MID)
    expect(
      upd[1].filtri.stato,
      'l’«ignora» non è condizionato a `da_abbinare`: ignorerebbe una riga che qualcuno ha riconfermato nel frattempo',
    ).toBe('da_abbinare')

    const info = h.logEvento.mock.calls.find((c) => (c[2] as { esito?: string }).esito === 'associazione-eliminata')
    expect(info?.[1]).toBe('info')
    expect((info?.[2] as { ignorato?: boolean }).ignorato).toBe(true)
  })

  it('l’«ignora» non tocca righe (corsa persa): 200 lo stesso, `ignorato: false`, e un `warn`', async () => {
    h.esitiUpdateMov = [
      { data: [{ id: MID }], error: null }, // la riapertura riesce
      { data: [], error: null }, // l'«ignora» non trova più la riga in `da_abbinare`
    ]

    const res = await patch({ azione: 'riapri', poi: 'ignorato' })

    expect(res.status).toBe(200)
    const j = (await res.json()) as { data?: Record<string, unknown> }
    expect(j.data?.ignorato).toBe(false)
    expect(j.data?.stato).toBe('da_abbinare')
    const warn = h.logEvento.mock.calls.find((c) => (c[2] as { esito?: string }).esito === 'ignora-dopo-riapertura-non-applicato')
    expect(warn?.[1]).toBe('warn')
  })

  it('errore sull’«ignora»: la riapertura resta valida, 200 con `ignorato: false`', async () => {
    h.esitiUpdateMov = [
      { data: [{ id: MID }], error: null },
      { data: null, error: { code: '57014', message: 'timeout' } },
    ]

    const res = await patch({ azione: 'riapri', poi: 'ignorato' })

    expect(res.status).toBe(200)
    expect(((await res.json()) as { data?: Record<string, unknown> }).data?.ignorato).toBe(false)
  })

  it('senza `poi`: un solo UPDATE, nessuna chiave `ignorato`, esito `associazione-riaperta`', async () => {
    const res = await patch({ azione: 'riapri' })

    expect(res.status).toBe(200)
    const j = (await res.json()) as { data?: Record<string, unknown> }
    expect(j.data?.stato).toBe('da_abbinare')
    expect(j.data && 'ignorato' in j.data).toBe(false)
    expect(updateDi('riconciliazione_movimenti')).toHaveLength(1)
    const info = h.logEvento.mock.calls.find((c) => (c[2] as { esito?: string }).esito === 'associazione-riaperta')
    expect(info?.[1]).toBe('info')
  })

  it('`poi: \'ignorato\'` con la riapertura FALLITA: nessun «ignora»', async () => {
    h.esitiUpdateMov = [{ data: [], error: null }] // compare-and-swap perso

    const res = await patch({ azione: 'riapri', poi: 'ignorato' })

    expect(res.status).toBe(409)
    expect(updateDi('riconciliazione_movimenti')).toHaveLength(1)
  })

  /**
   * ─── L'AUDIT DICE LO STATO FINALE (revisione finale, 2026-10-05) ─────────────
   *
   * `logScrittura` registrava `stato: 'da_abbinare'` PRIMA dell'«ignora», e la riga
   * finiva `ignorato` un istante dopo: il registro raccontava uno stato che la riga
   * non aveva più. Ora l'audit si scrive dopo, con lo stato in cui la riga è rimasta.
   */
  const statoNellAudit = () => {
    expect(h.logScrittura, 'nessuna traccia di chi ha riaperto').toHaveBeenCalledTimes(1)
    return ((h.logScrittura.mock.calls[0] as unknown[])[1] as { valoreDopo?: { stato?: string } }).valoreDopo?.stato
  }

  it('`poi: \'ignorato\'` applicato: l’audit registra `ignorato`, non `da_abbinare`', async () => {
    const res = await patch({ azione: 'riapri', poi: 'ignorato' })

    expect(res.status).toBe(200)
    expect(((await res.json()) as { data?: Record<string, unknown> }).data?.stato).toBe('ignorato')
    expect(statoNellAudit()).toBe('ignorato')
  })

  it('`poi: \'ignorato\'` NON applicato (corsa persa): l’audit registra `da_abbinare`', async () => {
    h.esitiUpdateMov = [
      { data: [{ id: MID }], error: null },
      { data: [], error: null },
    ]

    expect((await patch({ azione: 'riapri', poi: 'ignorato' })).status).toBe(200)
    expect(statoNellAudit()).toBe('da_abbinare')
  })

  it('senza `poi`: l’audit registra `da_abbinare`', async () => {
    expect((await patch({ azione: 'riapri' })).status).toBe(200)
    expect(statoNellAudit()).toBe('da_abbinare')
  })

  it('`poi` fuori dall’elenco: 400', async () => {
    const res = await patch({ azione: 'riapri', poi: 'cancellato' })

    expect(res.status).toBe(400)
    expect(h.updates).toEqual([])
  })
})
