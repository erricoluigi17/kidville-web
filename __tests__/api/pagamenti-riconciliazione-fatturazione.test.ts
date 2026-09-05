import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * GET /api/pagamenti/riconciliazione — lo STATO DI FATTURAZIONE sulle righe confermate.
 *
 * ⚠️ IL FINTO CLIENT QUI SOTTO NON È PIATTO, ed è il punto di questo file.
 * Un mock che risponde le stesse righe a ogni `from(…)` sarebbe verde CON e SENZA la
 * correzione: `fattura_stato` arriverebbe anche da `riconciliazione_movimenti`, che quella
 * colonna non ce l'ha. Qui ogni tabella ha il suo elenco (`h.db`), e la risposta è
 * PROIETTATA sulle sole colonne chieste nella `select(…)` — esattamente come fa PostgREST.
 * Conseguenze volute:
 *   · se la route non aggiunge `fattura_stato` alla `select` batch, il campo esce `null`;
 *   · se la route non estende gli id ai `pagamento_id` dei CONFERMATI, il `.in('id', …)`
 *     non pesca la riga e il campo esce `null`;
 *   · lo `stato` del MOVIMENTO ('confermato') e lo `stato` del PAGAMENTO ('pagato') sono
 *     due valori diversi in due tabelle diverse: scambiarli si vede.
 */

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  sediAttive: ['sc-1'] as string[],
  db: {} as Record<string, Record<string, unknown>[]>,
  errori: {} as Record<string, { code: string; message: string } | null>,
  /**
   * Errore su UNA sola chiamata (1-based) a quella tabella: serve a dire «il terzo
   * blocco della batch è caduto», che con `errori` (tutte o nessuna) non è dicibile.
   */
  erroreAllaChiamata: {} as Record<string, { indice: number; errore: { code: string; message: string } }>,
  /** Quante volte ogni tabella è stata interrogata (il contatore che `erroreAllaChiamata` legge). */
  conteggio: {} as Record<string, number>,
  /** Ogni interrogazione, così com'è arrivata: tabella, colonne, filtri, tetto chiesto. */
  chiamate: [] as { tabella: string; cols: string; filtri: { op: string; col: string; val: unknown }[]; limite: number | null }[],
  eventi: [] as { evento: string; livello: string; campi: Record<string, unknown> }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn() }))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuolaScrittura: async () => ({ scuolaId: 'sc-1' }),
  resolveScuoleAttive: async () => h.sediAttive,
}))
vi.mock('@/lib/logging/logger', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/logging/logger')>()
  return {
    ...vero,
    logEvento: (evento: string, livello: string, campi: Record<string, unknown>) => {
      h.eventi.push({ evento, livello, campi })
    },
  }
})

vi.mock('@/lib/supabase/server-client', () => {
  type Filtro = { op: 'eq' | 'in' | 'gte' | 'lte'; col: string; val: unknown }

  const proietta = (riga: Record<string, unknown>, cols: string) => {
    const chiavi = cols.split(',').map((c) => c.trim()).filter(Boolean)
    if (chiavi.length === 0) return { ...riga }
    return Object.fromEntries(chiavi.map((k) => [k, k in riga ? riga[k] : null]))
  }

  const passa = (riga: Record<string, unknown>, filtri: Filtro[]) =>
    filtri.every((f) => {
      const v = riga[f.col]
      if (f.op === 'eq') return v === f.val
      if (f.op === 'in') return Array.isArray(f.val) && f.val.includes(v)
      if (f.op === 'gte') return String(v) >= String(f.val)
      return String(v) <= String(f.val)
    })

  return {
    createAdminClient: async () => ({
      from: (table: string) => {
        const filtri: Filtro[] = []
        let cols = ''
        // ⚠️ IL TETTO SI APPLICA DAVVERO. Con `limit()` ignorato, una finestra piena
        // non esiste: la route restituirebbe sempre tutto e «troncato» resterebbe
        // verde con e senza la correzione — cioè un mock che dice di sì.
        let limite: number | null = null
        const b: Record<string, unknown> = {}
        b.select = (c?: string) => { cols = c ?? ''; return b }
        b.eq = (col: string, val: unknown) => { filtri.push({ op: 'eq', col, val }); return b }
        b.in = (col: string, val: unknown) => { filtri.push({ op: 'in', col, val }); return b }
        b.gte = (col: string, val: unknown) => { filtri.push({ op: 'gte', col, val }); return b }
        b.lte = (col: string, val: unknown) => { filtri.push({ op: 'lte', col, val }); return b }
        b.order = () => b
        b.limit = (n: number) => { limite = n; return b }
        b.range = () => b
        b.then = (resolve: (v: unknown) => unknown) => {
          const indice = (h.conteggio[table] ?? 0) + 1
          h.conteggio[table] = indice
          h.chiamate.push({ tabella: table, cols, filtri: [...filtri], limite })
          const soloUna = h.erroreAllaChiamata[table]
          const errore = h.errori[table] ?? (soloUna && soloUna.indice === indice ? soloUna.errore : null)
          if (errore) return resolve({ data: null, error: errore })
          const righe = (h.db[table] ?? []).filter((r) => passa(r, filtri))
          const finestra = limite == null ? righe : righe.slice(0, limite)
          return resolve({ data: finestra.map((r) => proietta(r, cols)), error: null })
        }
        return b
      },
    }),
  }
})

import { GET } from '@/app/api/pagamenti/riconciliazione/route'

const MID = (n: number) => `dddddddd-dddd-4ddd-8ddd-00000000000${n}`
const PID = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${n}`

const get = (qs = '') =>
  GET(new Request(`http://localhost/api/pagamenti/riconciliazione${qs}`) as never)

/** Movimento del registro: lo `stato` qui è quello del MOVIMENTO, mai quello del pagamento. */
const mov = (n: number, stato: string, pagamentoId: string | null, extra: Record<string, unknown> = {}) => ({
  id: MID(n),
  import_id: null,
  scuola_id: stato === 'confermato' ? 'sc-1' : null,
  data_operazione: '2026-09-05',
  importo: 150,
  causale: 'BONIFICO RETTA',
  controparte: 'ORDINANTE',
  stato,
  suggerimenti: null,
  pagamento_id: pagamentoId,
  confermato_il: stato === 'confermato' ? '2026-09-05T10:00:00Z' : null,
  ...extra,
})

/** Riga di `pagamenti`: qui vivono `stato` (del pagamento) e `fattura_stato`. */
const pag = (n: number, statoPagamento: string, fatturaStato: string | null, scuolaId: string | null = 'sc-1') => ({
  id: PID(n),
  scuola_id: scuolaId,
  stato: statoPagamento,
  fattura_stato: fatturaStato,
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = {}
  h.errori = {}
  h.erroreAllaChiamata = {}
  h.conteggio = {}
  h.chiamate = []
  h.eventi = []
  h.sediAttive = ['sc-1']
  h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
})

describe('GET /api/pagamenti/riconciliazione — stato di fatturazione della riga', () => {
  it('riga CONFERMATA di sede attiva: `pagamento_stato` e `fattura_stato` arrivano da `pagamenti`', async () => {
    h.db.riconciliazione_movimenti = [mov(1, 'confermato', PID(1))]
    h.db.pagamenti = [pag(1, 'pagato', 'non_richiesta')]

    const res = await get()
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data).toHaveLength(1)
    // lo stato del MOVIMENTO resta quello del registro (non viene sovrascritto dal pagamento)
    expect(j.data[0].stato).toBe('confermato')
    expect(j.data[0].pagamento_stato).toBe('pagato')
    expect(j.data[0].fattura_stato).toBe('non_richiesta')
  })

  it('riga confermata di sede NON attiva: entrambi i campi `null` (minimizzazione)', async () => {
    h.db.riconciliazione_movimenti = [mov(1, 'confermato', PID(1))]
    h.db.pagamenti = [pag(1, 'pagato', 'emessa', 'sc-99')]

    const j = await (await get()).json()
    expect(j.data[0].pagamento_stato).toBeNull()
    expect(j.data[0].fattura_stato).toBeNull()
  })

  it('righe suggerito / da_abbinare / ignorato: entrambi i campi `null` anche col pagamento in mano', async () => {
    h.db.riconciliazione_movimenti = [
      mov(1, 'suggerito', PID(1)),
      mov(2, 'da_abbinare', PID(2)),
      mov(3, 'ignorato', PID(3)),
    ]
    h.db.pagamenti = [pag(1, 'pagato', 'emessa'), pag(2, 'pagato', 'emessa'), pag(3, 'pagato', 'emessa')]

    const j = await (await get()).json()
    expect(j.data).toHaveLength(3)
    for (const r of j.data) {
      expect(r.pagamento_stato).toBeNull()
      expect(r.fattura_stato).toBeNull()
    }
  })

  it('i due campi ci sono SEMPRE, anche quando non c’è nessun pagamento da risolvere', async () => {
    h.db.riconciliazione_movimenti = [mov(1, 'da_abbinare', null)]
    h.db.pagamenti = []

    const j = await (await get()).json()
    expect(j.data[0]).toHaveProperty('pagamento_stato', null)
    expect(j.data[0]).toHaveProperty('fattura_stato', null)
  })

  it('?fattura=da_fatturare: solo confermate+pagate con fattura non_richiesta o scartata', async () => {
    h.db.riconciliazione_movimenti = [
      mov(1, 'confermato', PID(1)), // pagato · non_richiesta   → SÌ
      mov(2, 'confermato', PID(2)), // pagato · scartata        → SÌ
      mov(3, 'confermato', PID(3)), // parziale · non_richiesta → no (non pagato)
      mov(4, 'confermato', PID(4)), // pagato · in_attesa       → no
      mov(5, 'confermato', PID(5)), // pagato · emessa          → no
      mov(6, 'suggerito', null),    // nemmeno confermata       → no
    ]
    h.db.pagamenti = [
      pag(1, 'pagato', 'non_richiesta'),
      pag(2, 'pagato', 'scartata'),
      pag(3, 'parziale', 'non_richiesta'),
      pag(4, 'pagato', 'in_attesa'),
      pag(5, 'pagato', 'emessa'),
    ]

    const j = await (await get('?fattura=da_fatturare')).json()
    expect(j.data.map((r: { id: string }) => r.id)).toEqual([MID(1), MID(2)])
  })

  it('?fattura=fatturate: solo in_attesa ed emessa', async () => {
    h.db.riconciliazione_movimenti = [
      mov(1, 'confermato', PID(1)),
      mov(2, 'confermato', PID(2)),
      mov(3, 'confermato', PID(3)),
      mov(4, 'confermato', PID(4)),
      mov(5, 'confermato', PID(5)),
    ]
    h.db.pagamenti = [
      pag(1, 'pagato', 'non_richiesta'),
      pag(2, 'pagato', 'scartata'),
      pag(3, 'parziale', 'non_richiesta'),
      pag(4, 'pagato', 'in_attesa'),
      pag(5, 'pagato', 'emessa'),
    ]

    const j = await (await get('?fattura=fatturate')).json()
    expect(j.data.map((r: { id: string }) => r.id)).toEqual([MID(4), MID(5)])
  })

  it('?stato=confermato&fattura=da_fatturare: i due filtri si compongono', async () => {
    // Le tre righe cadono per tre ragioni diverse, e servono TUTTE: senza la 5 il caso
    // sarebbe verde anche con il filtro `fattura` inesistente (lo `?stato=` da solo basterebbe).
    h.db.riconciliazione_movimenti = [
      mov(1, 'confermato', PID(1)), // pagato · non_richiesta → SÌ
      mov(5, 'confermato', PID(5)), // pagato · emessa        → cade sul filtro FATTURA
      mov(6, 'suggerito', null),    // cade sul filtro STATO
    ]
    h.db.pagamenti = [pag(1, 'pagato', 'non_richiesta'), pag(5, 'pagato', 'emessa')]

    const j = await (await get('?stato=confermato&fattura=da_fatturare')).json()
    expect(j.data.map((r: { id: string }) => r.id)).toEqual([MID(1)])
  })

  it('?fattura=valore-sconosciuto → 400 (come gli altri parametri)', async () => {
    expect((await get('?fattura=x')).status).toBe(400)
    expect((await get('?fattura=emessa')).status).toBe(400)
  })

  it('batch su `pagamenti` fallito → 200, campi `null`, label dei suggerimenti oscurati, evento loggato', async () => {
    h.db.riconciliazione_movimenti = [
      mov(1, 'confermato', PID(1), {
        suggerimenti: [{ pagamento_id: PID(1), score: 90, label: 'Nome Cognome · Retta' }],
      }),
    ]
    h.db.pagamenti = [pag(1, 'pagato', 'emessa')]
    h.errori.pagamenti = { code: '08006', message: 'connection failure' }

    const res = await get()
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data[0].pagamento_stato).toBeNull()
    expect(j.data[0].fattura_stato).toBeNull()
    expect(j.data[0].suggerimenti[0].label).toBeNull()
    const esiti = h.eventi.filter((e) => e.evento === 'pagamento').map((e) => e.campi.esito)
    expect(esiti).toContain('fatturazione_movimenti_non_risolta')
  })
})

// ─── LA BATCH NON HA PIÙ UN TETTO NASCOSTO, E IL DEGRADO NON MENTE ───────────
//
// Tre report indipendenti (backend · debug · log) hanno trovato la stessa causa in tre
// sintomi diversi, e tutti e tre finiscono nella stessa frase a schermo — «Nessun movimento
// in questo stato», cioè «non c'è niente da fatturare», che è ESATTAMENTE il falso negativo
// che questa funzione era nata per eliminare:
//
//  (a) quando la batch su `pagamenti` cade, le righe escono «oscurate» con `fattura_stato`
//      null PER COSTRUZIONE — e su quelle righe si applicava comunque il filtro. Con
//      `?fattura=da_fatturare` la lista usciva VUOTA. `null` vuol dire «non lo so», e veniva
//      letto come «no»;
//  (b) `.in('id', pagIds)` non aveva tetto: ~39 byte per uuid, 500 confermati → 431 sulla
//      richiesta → degrado → di nuovo lista vuota. In produzione i soli suggerimenti citano
//      già 208 pagamenti distinti (~8,2 KB: il default di nginx per la request line);
//  (c) il filtro lavorava in memoria DOPO il `.limit(500)`: quando i confermati superano
//      500, le righe più vecchie — quelle dimenticate — sparivano dalla lista «Da fatturare»
//      senza nessun segnale.

/** Id a n cifre: i generatori in testa al file reggono una cifra sola. */
const MID_N = (n: number) => `dddddddd-dddd-4ddd-8ddd-${String(n).padStart(12, '0')}`
const PID_N = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`

/** n movimenti confermati, ognuno col suo pagamento saldato e mai fatturato. */
function registro(n: number, fatturaStato = 'non_richiesta'): void {
  h.db.riconciliazione_movimenti = Array.from({ length: n }, (_, i) => ({
    id: MID_N(i),
    import_id: null,
    scuola_id: 'sc-1',
    data_operazione: '2026-09-05',
    importo: 150,
    causale: 'BONIFICO RETTA',
    controparte: 'ORDINANTE',
    stato: 'confermato',
    suggerimenti: null,
    pagamento_id: PID_N(i),
    confermato_il: '2026-09-05T10:00:00Z',
  }))
  h.db.pagamenti = Array.from({ length: n }, (_, i) => ({
    id: PID_N(i),
    scuola_id: 'sc-1',
    stato: 'pagato',
    fattura_stato: fatturaStato,
  }))
}

/** Le interrogazioni su `pagamenti` fatte dalla batch, in ordine. */
const batchPagamenti = () => h.chiamate.filter((c) => c.tabella === 'pagamenti')
/** Gli id chiesti da una interrogazione della batch. */
const idDi = (c: (typeof h.chiamate)[number]) => (c.filtri.find((f) => f.op === 'in')?.val ?? []) as string[]

describe('GET /api/pagamenti/riconciliazione — la batch su `pagamenti` va a BLOCCHI', () => {
  it('250 pagamenti citati → TRE interrogazioni (100 · 100 · 50) e tutte le righe arricchite', async () => {
    registro(250)

    const j = await (await get()).json()
    const blocchi = batchPagamenti()
    expect(blocchi).toHaveLength(3)
    expect(blocchi.map((c) => idDi(c).length)).toEqual([100, 100, 50])
    // nessun id perso e nessuno chiesto due volte
    expect(new Set(blocchi.flatMap(idDi)).size).toBe(250)
    // …e l'arricchimento arriva su TUTTE le righe, non solo sul primo blocco
    expect(j.data).toHaveLength(250)
    expect(j.data.every((r: { fattura_stato: string | null }) => r.fattura_stato === 'non_richiesta')).toBe(true)
  })

  it('un blocco caduto = batch caduta: nessun arricchimento a metà', async () => {
    registro(250)
    h.erroreAllaChiamata.pagamenti = { indice: 2, errore: { code: '08006', message: 'connection failure' } }

    const j = await (await get()).json()
    expect(j.success).toBe(true)
    expect(j.fatturazione_disponibile).toBe(false)
    // Una risposta metà arricchita sarebbe peggio del degrado: le righe del blocco
    // caduto direbbero «da fatturare» solo per non essere state risolte.
    expect(j.data.every((r: { fattura_stato: string | null }) => r.fattura_stato === null)).toBe(true)
  })
})

describe('GET /api/pagamenti/riconciliazione — il degrado non dice mai «niente da fatturare»', () => {
  it('batch caduta CON ?fattura=da_fatturare: le righe NON sono filtrate, e il campo lo dichiara', async () => {
    registro(3)
    h.errori.pagamenti = { code: '08006', message: 'connection failure' }

    const res = await get('?fattura=da_fatturare')
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.success).toBe(true)
    // ⚠️ IL CUORE DI QUESTO FILE. Filtrare righe il cui `fattura_stato` è null per
    // costruzione dà zero risultati, e a schermo diventa «non c'è niente da fatturare».
    expect(j.data).toHaveLength(3)
    expect(j.fatturazione_disponibile).toBe(false)
  })

  it('batch riuscita: `fatturazione_disponibile` è true e il filtro si applica davvero', async () => {
    registro(3)
    h.db.pagamenti[1].fattura_stato = 'emessa'

    const j = await (await get('?fattura=da_fatturare')).json()
    expect(j.fatturazione_disponibile).toBe(true)
    expect(j.data.map((r: { id: string }) => r.id)).toEqual([MID_N(0), MID_N(2)])
  })

  it('nessun pagamento da risolvere: il campo c’è lo stesso, e dice `true`', async () => {
    h.db.riconciliazione_movimenti = [mov(1, 'da_abbinare', null)]
    h.db.pagamenti = []

    const j = await (await get()).json()
    expect(j).toHaveProperty('fatturazione_disponibile', true)
  })

  it('i due eventi del degrado sono `warn`, portano il codice dell’errore e quante righe restano senza stato', async () => {
    registro(4)
    h.errori.pagamenti = { code: 'PGRST301', message: 'JWT expired' }

    await get('?fattura=da_fatturare')
    const degrado = h.eventi.filter((e) =>
      e.campi.esito === 'sedi_suggerimenti_non_risolte' || e.campi.esito === 'fatturazione_movimenti_non_risolta')
    expect(degrado).toHaveLength(2)
    // `info` è il livello di un fatto normale: qui la schermata sta perdendo un dato.
    expect(degrado.every((e) => e.livello === 'warn')).toBe(true)
    // Senza il codice, in `app_log` restava una riga che diceva solo «è andata male»:
    // sul 431 misurato il messaggio persistito era perfino VUOTO.
    expect(degrado.every((e) => e.campi.error_code === 'PGRST301')).toBe(true)
    const fatturazione = degrado.find((e) => e.campi.esito === 'fatturazione_movimenti_non_risolta')
    expect(fatturazione?.campi.confermate_senza_stato).toBe(4)
  })
})

describe('GET /api/pagamenti/riconciliazione — la finestra del filtro di fatturazione', () => {
  const registroMovimenti = () => h.chiamate.filter((c) => c.tabella === 'riconciliazione_movimenti')
  const statoChiesto = (c: (typeof h.chiamate)[number]) => c.filtri.find((f) => f.op === 'eq' && f.col === 'stato')?.val

  it('senza ?fattura= la finestra resta quella di sempre (500) e lo stato non viene forzato', async () => {
    registro(3)

    await get()
    expect(registroMovimenti()).toHaveLength(1)
    expect(registroMovimenti()[0].limite).toBe(500)
    expect(statoChiesto(registroMovimenti()[0])).toBeUndefined()
  })

  it('con ?fattura= la query forza `stato=confermato` e alza il tetto a LIMITE_FATTURAZIONE', async () => {
    registro(3)

    await get('?fattura=da_fatturare')
    const q = registroMovimenti()[0]
    expect(statoChiesto(q)).toBe('confermato')
    // Si chiede UNA riga in più del limite: è così che si sa che ce n'erano altre
    // senza contarle tutte.
    expect(q.limite).toBe(5001)
  })

  it('finestra piena → `troncato: true` e un warn che dice quante righe sono uscite', async () => {
    // 1.000 è `max_rows` di PostgREST: sopra quel numero il taglio è SUO e non lo
    // dichiara — chiedere 5.001 non serve a niente se il server ne dà 1.000 e tace.
    registro(1000)

    const j = await (await get('?fattura=da_fatturare')).json()
    expect(j.troncato).toBe(true)
    const piena = h.eventi.find((e) => e.campi.esito === 'fatturazione_finestra_piena')
    expect(piena?.livello).toBe('warn')
    expect(piena?.campi.righe).toBe(1000)
  })

  it('sotto la soglia nessun troncamento, e nessun allarme', async () => {
    registro(999)

    const j = await (await get('?fattura=da_fatturare')).json()
    expect(j.troncato).toBeUndefined()
    expect(h.eventi.some((e) => e.campi.esito === 'fatturazione_finestra_piena')).toBe(false)
  })
})
