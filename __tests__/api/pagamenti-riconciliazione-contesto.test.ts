import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * ─── IL CONTESTO DI «COMPONI IL PAGAMENTO», MISURATO SULLA RISPOSTA ──────────
 *
 * `GET /api/pagamenti/riconciliazione/[id]/contesto` è l'unico fornitore del
 * pannello che ripartisce un bonifico su più voci. Non scrive niente: risponde
 * a «di chi è questo bonifico, quali figli ha quella famiglia, cosa hanno di
 * aperto, quali categorie esistono, quanto costa un ticket».
 *
 * ─── PERCHÉ IL FINTO SUPABASE DISTINGUE PER TABELLA ─────────────────────────
 * Un finto che rispondesse `[]` a qualunque tabella sarebbe verde anche su una
 * route che non legge niente. Qui ogni tabella ha la sua risposta, pilotata per
 * nome, e le letture si registrano: «`ticket_mensa` è stata interrogata» è
 * un'asserzione, non una speranza.
 *
 * ─── COSA NON È FINTO, E PERCHÉ ─────────────────────────────────────────────
 * `riconosciOrdinante` (`@/lib/pagamenti/ordinante-genitore`),
 * `scegliPaganteComune` (`@/lib/pagamenti/pagante-comune`) e `residuoEffettivo`
 * (`@/lib/pagamenti/aging`) girano PER DAVVERO. Sono le tre regole che questa
 * route deve RIUSARE invece di riscrivere, e mockarle renderebbe il test verde
 * su una copia divergente — cioè proprio sul difetto che si vuole impedire.
 *
 * Dati SINTETICI: uuid e nomi inventati. Il repository è pubblico e in
 * produzione ci sono anagrafiche di minori.
 */

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logOk: vi.fn(),
  logErrore: vi.fn(),
  logEvento: vi.fn(),
  /** Le sedi su cui l'operatore può leggere i NOMI dei minori. */
  sediAttive: ['sc-1'] as string[],
  /**
   * ⚠️ UN ARRAY, non un oggetto — e non è una preferenza di forma.
   *
   * Finché `riconciliazione_movimenti` rispondeva con un OGGETTO, `filtrate()`
   * non applicava NESSUN filtro su questa tabella: misurato il 2026-09-13
   * togliendo `.eq('id', id)` dalla lettura del movimento — **39 test su 39
   * verdi**, con una rotta che leggeva il primo bonifico che capitava invece di
   * quello chiesto. Il finto non vedeva affatto il filtro d'identità.
   */
  movimenti: [] as Record<string, unknown>[],
  /** Risposte per tabella. La chiave `pagamenti` si sdoppia su due letture diverse. */
  pagamentiPerId: [] as Record<string, unknown>[],
  vociAperte: [] as Record<string, unknown>[],
  /**
   * Errore sulla lettura delle voci. Un `42703` vale SOLO PER LA PRIMA lettura:
   * è il degrado vero del DB E2E (la colonna `sconto` non c'è), e il secondo
   * tentativo — senza quella colonna — deve riuscire. Un finto che fallisse
   * sempre non distinguerebbe «ritenta» da «si arrende».
   */
  vociError: null as { code: string; message: string } | null,
  vociLette: 0,
  /** Come `vociError`, per la colonna `alunni.stato`: vale la PRIMA lettura sola. */
  alunniError: null as { code: string; message: string } | null,
  alunniLetti: 0,
  studentParents: [] as Record<string, unknown>[],
  legamiRuntime: [] as Record<string, unknown>[],
  parents: [] as Record<string, unknown>[],
  alunni: [] as Record<string, unknown>[],
  ticket: [] as Record<string, unknown>[],
  categorie: [] as Record<string, unknown>[],
  settings: [] as Record<string, unknown>[],
  scuole: [] as Record<string, unknown>[],
  /**
   * I filtri che il finto NON ha saputo applicare, perché la fixture non aveva
   * quella colonna. Elenco vuoto atteso dopo ogni test (`afterEach`): è il modo
   * in cui una fixture incompleta si NOTA invece di rendere permissivo il finto.
   */
  filtriCiechi: [] as string[],
  /** Ogni lettura risolta: tabella, colonne, filtri. */
  letture: [] as { table: string; cols: string; filtri: Record<string, unknown> }[],
  /** Qualunque scrittura: questa route non ne fa nessuna. */
  scritture: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: async () => h.sediAttive,
}))
vi.mock('@/lib/logging/logger', () => ({
  logOk: h.logOk,
  logErrore: h.logErrore,
  logEvento: h.logEvento,
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const filtri: Record<string, unknown> = {}
      const b: Record<string, unknown> = {}
      /**
       * `.or('scuola_id.is.null,scuola_id.in.(a,b)')` — la disgiunzione vera.
       * Si interpreta invece di ignorarla: una `.or` finta che lasciasse passare
       * tutto renderebbe verde una route che ha smesso di restringere per sede,
       * ed è esattamente il filtro che il lock `isolamento-sede-coverage`
       * pretende sia NELLA QUERY. Forma sola: `col.op.valore`, con `op` fra
       * `is`/`in`/`eq`.
       */
      const disgiunzioni: ((riga: Record<string, unknown>) => boolean)[] = []
      b.select = (cols?: string) => { b._cols = cols ?? ''; return b }
      b.eq = (c: string, v: unknown) => { filtri[c] = v; return b }
      b.in = (c: string, v: unknown) => { filtri[c] = v; return b }
      b.or = (espr: string) => {
        const termini = String(espr).match(/[A-Za-z_]\w*\.(?:is|in|eq)\.(?:\([^)]*\)|[^,]*)/g) ?? []
        disgiunzioni.push((riga) => termini.some((t) => {
          const [col, op, ...resto] = t.split('.')
          const val = resto.join('.')
          // Stessa regola di `passa`, e per la stessa ragione: qui una colonna
          // assente col test `is.null` risponderebbe SÌ — cioè il ramo `.or`
          // sarebbe permissivo proprio dove `passa` è diventato severo, e chi
          // legge il finto crederebbe il contrario.
          if (!(col in riga)) {
            const guaio = `${table}: \`.or\` su \`${col}\`, colonna assente dalla fixture`
            if (!h.filtriCiechi.includes(guaio)) h.filtriCiechi.push(guaio)
            throw new Error(guaio)
          }
          const v = riga[col]
          if (op === 'is') return val === 'null' ? v == null : String(v) === val
          if (op === 'in') return val.slice(1, -1).split(',').filter(Boolean).includes(String(v))
          return String(v) === val
        }))
        return b
      }
      b.order = () => b
      b.limit = () => b
      b.insert = () => { h.scritture.push(`${table}:insert`); return b }
      b.update = () => { h.scritture.push(`${table}:update`); return b }
      b.delete = () => { h.scritture.push(`${table}:delete`); return b }
      const registra = () => {
        h.letture.push({ table, cols: typeof b._cols === 'string' ? b._cols : '', filtri: { ...filtri } })
      }
      const risposta = (): { data: unknown; error: unknown } => {
        switch (table) {
          case 'riconciliazione_movimenti': return { data: h.movimenti, error: null }
          case 'pagamenti':
            // DUE letture distinte sulla stessa tabella: gli alunni dei pagamenti
            // SUGGERITI (`.in('id', …)`) e le voci aperte dei figli
            // (`.in('alunno_id', …)`). Distinguerle per FILTRO è l'unico modo di
            // pilotarle separatamente — e di accorgersi se una delle due sparisce.
            if ('id' in filtri) return { data: h.pagamentiPerId, error: null }
            h.vociLette += 1
            if (h.vociError && (h.vociError.code !== '42703' || h.vociLette === 1)) {
              return { data: null, error: h.vociError }
            }
            return { data: h.vociAperte, error: null }
          case 'student_parents': return { data: h.studentParents, error: null }
          case 'legame_genitori_alunni': return { data: h.legamiRuntime, error: null }
          case 'parents': return { data: h.parents, error: null }
          case 'alunni':
            h.alunniLetti += 1
            if (h.alunniError && (h.alunniError.code !== '42703' || h.alunniLetti === 1)) {
              return { data: null, error: h.alunniError }
            }
            return { data: h.alunni, error: null }
          case 'ticket_mensa': return { data: h.ticket, error: null }
          case 'payment_categories': return { data: h.categorie, error: null }
          case 'admin_settings': return { data: h.settings, error: null }
          case 'scuole': return { data: h.scuole, error: null }
          default: return { data: [], error: null }
        }
      }
      /**
       * ⚠️ I FILTRI SI APPLICANO DAVVERO, e non è un vezzo di fedeltà.
       *
       * La prima stesura di questo finto rispondeva con l'intera fixture a
       * qualunque `.in()`/`.eq()`. Misurato mutando la route: restringere i figli
       * ai soli bambini che il bonifico nomina — cioè disfare la decisione n. 10 —
       * lasciava **35 test su 35 verdi**. Il test «esce anche il fratello di un
       * altro plesso» non poteva vedere la differenza, perché il fratello glielo
       * restituiva il finto e non la route.
       *
       * Ora una riga esce solo se soddisfa ogni filtro che la nomina: se la route
       * non chiede un id, quell'id non torna.
       */
      const passa = (riga: Record<string, unknown>): boolean =>
        Object.entries(filtri).every(([col, atteso]) => {
          /**
           * ⚠️ UNA COLONNA CHE LA FIXTURE NON HA È UN FILTRO CHE IL FINTO NON SA
           * APPLICARE, non un filtro soddisfatto.
           *
           * Qui c'era `return true`, e sbagliava dalla parte permissiva: misurato
           * il 2026-09-13 aggiungendo alla lettura degli alunni un
           * `.eq('anno_scolastico', '2026/27')` — colonna assente da ogni fixture
           * — **39 test su 39 verdi**, mentre in produzione quel filtro
           * svuoterebbe il pannello su OGNI bonifico. Un finto che ignora i filtri
           * che non capisce non è «più fedele»: è cieco proprio sui filtri nuovi,
           * che sono gli unici che nessuno ha ancora provato.
           *
           * Adesso lancia, e `afterEach` stampa quale colonna manca a quale
           * fixture: o si aggiunge il campo, o quel filtro non ci doveva stare.
           */
          if (!(col in riga)) {
            const guaio = `${table}: filtro su \`${col}\`, colonna assente dalla fixture`
            if (!h.filtriCiechi.includes(guaio)) h.filtriCiechi.push(guaio)
            throw new Error(guaio)
          }
          const v = riga[col]
          return Array.isArray(atteso) ? atteso.includes(v) : v === atteso
        }) && disgiunzioni.every((d) => d(riga))
      const filtrate = (): { data: unknown; error: unknown } => {
        const r = risposta()
        if (r.error) return r
        /**
         * ⚠️ OGNI FIXTURE È UN ARRAY, e questa riga lo PRETENDE invece di
         * assecondarlo. Qui c'era `|| !Array.isArray(r.data)`: una risposta che
         * non fosse un array usciva **senza che nessun filtro le fosse
         * applicato** — ed è il modo in cui il filtro d'identità del movimento
         * (`.eq('id', id)`) è rimasto invisibile a 39 test. La porta si chiude
         * qui, non nella fixture: una tabella aggiunta domani con una risposta a
         * oggetto si ferma, invece di scivolare in silenzio nel ramo permissivo.
         */
        if (!Array.isArray(r.data)) {
          const guaio = `${table}: la fixture non è un array, e così nessun filtro le verrebbe applicato`
          if (!h.filtriCiechi.includes(guaio)) h.filtriCiechi.push(guaio)
          throw new Error(guaio)
        }
        return { data: (r.data as Record<string, unknown>[]).filter(passa), error: null }
      }
      b.maybeSingle = async () => {
        registra()
        const r = filtrate()
        return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error }
      }
      b.then = (resolve: (v: unknown) => unknown) => {
        registra()
        const r = filtrate()
        return resolve({ data: Array.isArray(r.data) ? r.data : r.data ? [r.data] : [], error: r.error })
      }
      return b
    },
  }),
}))

import { GET } from '@/app/api/pagamenti/riconciliazione/[id]/contesto/route'

const MID = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1'
/** Un ALTRO bonifico nello stesso registro: serve a vedere il filtro d'identità. */
const ALTRO_MID = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2'
const PAG_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const PAG_2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const PAG_3 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'
/** Il figlio nella sede DELL'OPERATORE. */
const BIMBO_IN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
/** Il fratello in un ALTRO plesso: è il caso che la funzionalità esiste per servire. */
const BIMBO_FUORI = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'
const GENITORE = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1'
const ALTRO_GENITORE = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2'
/**
 * Una famiglia che con questo bonifico non c'entra NIENTE, e che sta nella sede
 * dell'operatore — cioè il caso in cui una fuga si vedrebbe per intero, nome
 * compreso. In produzione, il 2026-09-13, le righe come questa sono **726**:
 * `student_parents` tiene i legami di tutti i 727 bambini del registro, e
 * l'unica cosa che separa una famiglia dalle altre è `.eq('parent_id', …)`.
 */
const ESTRANEO_GENITORE = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc9'
const BIMBO_ESTRANEO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb9'

const get = (qs = '', id = MID) =>
  GET(
    new Request(`http://localhost/api/pagamenti/riconciliazione/${id}/contesto?userId=u1${qs}`, {
      headers: { 'x-user-id': 'u1' },
    }) as never,
    { params: Promise.resolve({ id }) } as never,
  )

const corpo = async (res: Response) => (await res.json()) as {
  success?: boolean
  error?: string
  codice?: string
  data?: {
    movimento: Record<string, unknown>
    pagante: { proposto: { parent_id: string; motivo: string } | null; candidati: { parent_id: string; nome: string }[] }
    figli: {
      alunno_id: string
      nome: string | null
      scuola_id: string | null
      in_sede: boolean
      saldo_ticket: number
      voci_aperte: { id: string; residuo: number; descrizione: string | null }[]
    }[]
    categorie: { id: string; nome: string; slug: string | null; scuola_id: string | null }[]
    pacchetti_ticket: Record<string, { label: string; pezzi: number; costo: number }[]>
    sedi: Record<string, string>
  }
}

const letteDa = (tabella: string) => h.letture.filter((l) => l.table === tabella)

/**
 * La riga di battito del §6 — l'unica che esca con un `esito` che comincia per
 * `proposta`. Si cerca per prefisso e non per valore esatto perché il motivo fa
 * parte dell'esito (`proposta-pagante_comune`, `proposta-assente`, …): un
 * `=== 'proposta'` non troverebbe mai niente, e un test che non trova niente
 * dove cerca una riga è verde solo finché non gli si chiede di asserirci sopra.
 */
const battito = () =>
  h.logEvento.mock.calls
    .map((c) => c[2] as { esito?: string } | undefined)
    .find((c) => typeof c?.esito === 'string' && c.esito.startsWith('proposta'))

beforeEach(() => {
  vi.clearAllMocks()
  h.letture = []
  h.scritture = []
  h.vociError = null
  h.vociLette = 0
  h.alunniError = null
  h.alunniLetti = 0
  h.filtriCiechi = []
  h.sediAttive = ['sc-1']
  h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria', scuola_id: 'sc-1' } })
  h.movimenti = [
    {
      id: MID,
      scuola_id: null,
      importo: 300,
      data_operazione: '2026-09-10',
      causale: 'BONIFICO A VOSTRO FAVORE DA MARIO VERDI PER RETTA TRN 1',
      controparte: 'MARIO VERDI',
      stato: 'suggerito',
      pagamento_id: null,
      suggerimenti: [{ pagamento_id: PAG_1, score: 0.9, cf_match: false }],
    },
    // Il SECONDO bonifico del registro. Esiste perché il filtro d'identità si
    // possa osservare: con una riga sola, `.eq('id', id)` è indistinguibile da
    // «prendi la prima».
    {
      id: ALTRO_MID,
      scuola_id: null,
      importo: 77,
      data_operazione: '2026-09-11',
      causale: 'BONIFICO DI UN ALTRO',
      controparte: null,
      stato: 'da_abbinare',
      pagamento_id: null,
      suggerimenti: [],
    },
  ]
  // Il pagamento suggerito porta l'alunno da cui si risale alla famiglia.
  h.pagamentiPerId = [{ id: PAG_1, alunno_id: BIMBO_IN, scuola_id: 'sc-1' }]
  h.studentParents = [
    { parent_id: GENITORE, student_id: BIMBO_IN, relation_type: 'padre' },
    { parent_id: GENITORE, student_id: BIMBO_FUORI, relation_type: 'padre' },
    // ⚠️ LA FAMIGLIA ESTRANEA STA NELLA FIXTURE DI BASE, non in un test solo:
    // senza una riga che NON deve uscire, `student_parents` è una tabella in cui
    // ogni riga è la risposta giusta, e il filtro che le separa non è osservabile.
    { parent_id: ESTRANEO_GENITORE, student_id: BIMBO_ESTRANEO, relation_type: 'madre' },
  ]
  h.legamiRuntime = []
  h.parents = [
    { id: GENITORE, first_name: 'Mario', last_name: 'Verdi', auth_user_id: null, intestatario_default: true },
    { id: ALTRO_GENITORE, first_name: 'Anna', last_name: 'Bianchi', auth_user_id: null, intestatario_default: false },
  ]
  h.alunni = [
    { id: BIMBO_IN, nome: 'Luca', cognome: 'Verdi', scuola_id: 'sc-1' },
    { id: BIMBO_FUORI, nome: 'Sara', cognome: 'Verdi', scuola_id: 'sc-2' },
    // Nella sede DELL'OPERATORE: se uscisse, uscirebbe col nome e col saldo.
    { id: BIMBO_ESTRANEO, nome: 'Giulia', cognome: 'Neri', scuola_id: 'sc-1' },
  ]
  h.vociAperte = [
    {
      id: PAG_1, alunno_id: BIMBO_IN, scuola_id: 'sc-1', descrizione: 'Retta settembre',
      importo: 200, importo_pagato: 0, sconto: 0, scadenza: '2026-09-05', stato: 'scaduto',
      tipo: 'singolo', categoria_id: 'cat-retta',
    },
    {
      id: PAG_2, alunno_id: BIMBO_FUORI, scuola_id: 'sc-2', descrizione: 'Pomeridiano settembre',
      importo: 120, importo_pagato: 20, sconto: 10, scadenza: '2026-09-08', stato: 'scaduto',
      tipo: 'singolo', categoria_id: 'cat-pom',
    },
  ]
  // 84 righe su 727 alunni in produzione (misurato il 2026-09-13): la maggioranza
  // dei bambini NON ha una riga qui, e vale 0 — non «non esiste». La seconda riga
  // è della famiglia estranea: una fuga porterebbe con sé anche il suo saldo.
  h.ticket = [{ alunno_id: BIMBO_IN, saldo_ticket: 12 }, { alunno_id: BIMBO_ESTRANEO, saldo_ticket: 99 }]
  h.categorie = [
    { id: 'cat-retta', nome: 'Retta', slug: 'retta', scuola_id: null, attivo: true, ordine: 1 },
    { id: 'cat-pom', nome: 'Pomeridiano', slug: 'pomeridiano', scuola_id: 'sc-1', attivo: true, ordine: 2 },
  ]
  h.settings = [
    { scuola_id: 'sc-1', ticket_pacchetti: [{ label: '10 pasti', pezzi: 10, costo: 45 }] },
    // Una sede che l'operatore NON gestisce: il suo pacchetto non deve comparire
    // né come chiave né come costo. Senza questa riga, `.in('scuola_id', …)` sulla
    // lettura dei pacchetti non è osservabile.
    { scuola_id: 'sc-9', ticket_pacchetti: [{ label: '30 pasti', pezzi: 30, costo: 120 }] },
  ]
  h.scuole = [
    { id: 'sc-1', nome: 'Kidville Uno' },
    { id: 'sc-2', nome: 'Kidville Due' },
    // Una sede che questo bonifico non cita: la busta `sedi` non deve nominarla.
    // Senza una riga così, `.in('id', idSediCitate)` non è osservabile — tutte le
    // sedi della fixture sarebbero citate, e togliere il filtro non cambierebbe nulla.
    { id: 'sc-9', nome: 'Kidville Nove' },
  ]
})

/**
 * Il finto ha incontrato un filtro che non sapeva applicare? Allora la misura di
 * QUESTO test non vale, qualunque colore abbia: o la fixture è incompleta, o la
 * rotta filtra su una colonna che non esiste.
 */
afterEach(() => {
  expect(
    h.filtriCiechi,
    'il finto Supabase ha incontrato un filtro su una colonna che la fixture non ha: finché ' +
      'restava `true` questo era il modo in cui un filtro nuovo passava senza che nessun test lo vedesse.',
  ).toEqual([])
})

describe('il gate viene prima di qualunque lettura', () => {
  it('staff negato ⇒ la risposta del gate, e nessuna query è partita', async () => {
    h.requireStaff.mockResolvedValue({ response: new Response('no', { status: 403 }) })
    const res = await get()
    expect(res.status).toBe(403)
    expect(h.letture, 'una lettura è partita prima del gate').toEqual([])
  })

  it('non scrive mai niente: è una rotta di sola lettura', async () => {
    await get()
    expect(h.scritture).toEqual([])
  })
})

describe('il bonifico che esce è QUELLO chiesto', () => {
  it('il secondo movimento del registro, non il primo', async () => {
    // Il registro bancario è globale e ha molte righe: `.eq('id', id)` è ciò che
    // separa «questo bonifico» da «un bonifico». Con una riga sola nella fixture
    // il filtro era indistinguibile da «prendi la prima», e toglierlo dalla rotta
    // lasciava 39 test su 39 verdi (misurato il 2026-09-13).
    const b = await corpo(await get('', ALTRO_MID))
    expect(b.data!.movimento.id).toBe(ALTRO_MID)
    expect(b.data!.movimento.importo, 'è uscito l’importo di un altro bonifico').toBe(77)
  })
})

describe('🔴 i nomi dei minori escono SOLO per le sedi dell’operatore', () => {
  it('il figlio in sede ha il nome, il fratello di un altro plesso NO', async () => {
    const b = await corpo(await get())
    const dentro = b.data!.figli.find((f) => f.alunno_id === BIMBO_IN)!
    const fuori = b.data!.figli.find((f) => f.alunno_id === BIMBO_FUORI)!
    expect(dentro.nome).toBe('Luca Verdi')
    expect(dentro.in_sede).toBe(true)
    expect(fuori.nome, 'il nome di un minore di un altro plesso è uscito').toBeNull()
    expect(fuori.in_sede).toBe(false)
  })

  it('al posto del nome del minore esce il nome del PLESSO', async () => {
    const b = await corpo(await get())
    const fuori = b.data!.figli.find((f) => f.alunno_id === BIMBO_FUORI)!
    expect(fuori.scuola_id).toBe('sc-2')
    expect(b.data!.sedi['sc-2']).toBe('Kidville Due')
  })

  it('la busta `sedi` nomina SOLO i plessi che questo bonifico cita', async () => {
    // `.in('id', idSediCitate)` sulla lettura di `scuole`: toglierlo lasciava 39
    // test su 39 verdi (misurato il 2026-09-13) perché ogni sede della fixture era
    // citata. Non è un dato sensibile — sono i nomi delle sedi — ma è la stessa
    // abitudine che tiene stretto tutto il resto: si legge ciò che serve, e una
    // lettura che non restringe è quella che il prossimo `select` qui accanto eredita.
    const b = await corpo(await get())
    expect(Object.keys(b.data!.sedi).sort()).toEqual(['sc-1', 'sc-2'])
    expect(b.data!.sedi['sc-9'], 'è uscito il nome di un plesso che il bonifico non cita').toBeUndefined()
  })

  it('nessun nome di minore nella risposta quando NESSUNA sede è attiva', async () => {
    h.sediAttive = []
    const b = await corpo(await get())
    const testo = JSON.stringify(b)
    expect(testo, 'il nome di un minore è nella risposta').not.toMatch(/Luca/)
    expect(testo).not.toMatch(/Sara/)
    // ...ma i figli ci sono lo stesso: una schermata vuota è indistinguibile da un guasto.
    expect(b.data!.figli).toHaveLength(2)
  })

  it('nei log non entrano né i nomi né il testo libero della banca', async () => {
    // ⚠️ `i` NON È UN DETTAGLIO DI STILE. Questo test cercava `/Verdi/` mentre la
    // fixture scrive `MARIO VERDI` — come lo scrive la banca, in maiuscolo:
    // misurato il 2026-09-13, aggiungendo al battito `ordinante: controparte` E
    // `causale: causale`, **46 test su 46 restavano verdi**. Un test sulla privacy
    // cieco alle maiuscole è cieco proprio sul campo che arriva dall'estratto
    // conto, che è l'unico posto da cui un nome può entrare qui senza passare da
    // un `select` che qualcuno ha scritto apposta.
    await get()
    const loggato = JSON.stringify([
      h.logEvento.mock.calls, h.logErrore.mock.calls, h.logOk.mock.calls,
    ])
    // I nomi dei minori: quello in sede, quello fuori, quello di un'altra famiglia.
    expect(loggato, 'il nome di un minore è in un log').not.toMatch(/luca|sara|giulia/i)
    // Il cognome, che è di tutti e tre e anche del genitore.
    expect(loggato, 'un cognome è in un log').not.toMatch(/verdi|neri|bianchi/i)
    // Il nome dell'ADULTO come lo scrive la banca, e la causale: testo libero, e
    // `@/lib/logging/redact` è a lista bianca proprio perché lì dentro può esserci
    // qualunque cosa — un nome, un IBAN, il motivo di un pagamento.
    expect(loggato, 'l’ordinante scritto dalla banca è in un log').not.toMatch(/mario/i)
    expect(loggato, 'la causale del bonifico è in un log').not.toMatch(/bonifico a vostro favore|TRN 1/i)
    // La descrizione di una voce: dice cosa ha comprato quella famiglia.
    expect(loggato, 'la descrizione di una voce è in un log').not.toMatch(/retta settembre|pomeridiano settembre/i)
  })
})

describe('il nome di un ADULTO attraversa il perimetro, ed è dichiarato', () => {
  it('bonifico di un plesso che l’operatore non gestisce: il minore no, il genitore sì', async () => {
    // ⚠️ QUESTO TEST FISSA UNA COSA CHE ESCE, non una che è nascosta — ed è il
    // motivo per cui esiste: la testata della rotta faceva credere che la
    // minimizzazione coprisse tutto, e non è così.
    //
    // Perché esce, in due righe: il pagante si sceglie per NOME (`?pagante=`
    // accetta solo questi candidati), e lo stesso nome è comunque nella risposta
    // come `movimento.controparte` — l'ha scritto la banca. Toglierlo di qui
    // lasciandolo di là sarebbe una protezione vuota alla riga sopra.
    //
    // Il giorno in cui si deciderà di stringere, questo test diventerà rosso: è
    // il punto. Una decisione si cambia vedendola, non scoprendola.
    h.sediAttive = ['sc-1']
    h.movimenti = [{ ...h.movimenti[0], controparte: 'ANNA BIANCHI' }]
    h.pagamentiPerId = [{ id: PAG_1, alunno_id: BIMBO_FUORI, scuola_id: 'sc-2' }]
    h.studentParents = [
      { parent_id: ALTRO_GENITORE, student_id: BIMBO_FUORI, relation_type: 'madre' },
      { parent_id: ESTRANEO_GENITORE, student_id: BIMBO_ESTRANEO, relation_type: 'madre' },
    ]
    const b = await corpo(await get())
    const fuori = b.data!.figli.find((f) => f.alunno_id === BIMBO_FUORI)!
    expect(fuori.nome, 'il nome di un minore fuori perimetro è uscito').toBeNull()
    expect(fuori.in_sede).toBe(false)
    // L'adulto, invece, esce — e queste due righe dicono che lo sappiamo.
    expect(b.data!.pagante.candidati.find((c) => c.parent_id === ALTRO_GENITORE)!.nome).toBe('Anna Bianchi')
    expect(
      b.data!.movimento.controparte,
      'la controparte non esce più: allora il nome del candidato va rivisto insieme a questa',
    ).toBe('ANNA BIANCHI')
  })
})

describe('i figli sono TUTTI quelli della famiglia (decisione n. 10)', () => {
  it('esce anche il fratello di un plesso che non è dell’operatore', async () => {
    const b = await corpo(await get())
    expect(b.data!.figli.map((f) => f.alunno_id).sort()).toEqual([BIMBO_IN, BIMBO_FUORI].sort())
  })

  it('e con lui le sue voci aperte: è il caso per cui la funzionalità esiste', async () => {
    const b = await corpo(await get())
    const fuori = b.data!.figli.find((f) => f.alunno_id === BIMBO_FUORI)!
    expect(fuori.voci_aperte.map((v) => v.id)).toEqual([PAG_2])
  })
})

describe('🔴 i figli sono di QUESTA famiglia: il filtro che la separa dalle altre 726', () => {
  it('il bambino di un’altra famiglia non entra, né col nome né col saldo', async () => {
    // Il muro è una riga sola: `.eq('parent_id', proposto.parent_id)` sulla
    // lettura di `student_parents` che compone i figli. Toglierla, il 2026-09-13,
    // lasciava 39 test su 39 verdi — e in produzione avrebbe messo nella risposta
    // i 727 bambini del registro, con i nomi (per le sedi attive), le voci aperte,
    // gli importi e i saldi ticket di OGNI famiglia della scuola.
    const b = await corpo(await get())
    // Controllo positivo: la riga estranea c'è davvero, altrimenti questo test
    // sarebbe una frase su una fixture vuota.
    expect(h.studentParents.some((r) => r.parent_id === ESTRANEO_GENITORE)).toBe(true)
    expect(h.alunni.some((a) => a.id === BIMBO_ESTRANEO)).toBe(true)
    expect(b.data!.figli.map((f) => f.alunno_id)).not.toContain(BIMBO_ESTRANEO)
    expect(JSON.stringify(b), 'il nome di un minore di un’altra famiglia è nella risposta').not.toMatch(/Giulia|Neri/i)
  })

  it('e nemmeno quando l’operatrice sceglie il pagante a mano', async () => {
    // `?pagante=` ricompone il contesto su un'altra famiglia: il filtro deve
    // reggere anche su quella strada, che è l'unica in cui l'uuid arriva dal client.
    h.studentParents = [
      ...h.studentParents,
      { parent_id: ALTRO_GENITORE, student_id: BIMBO_IN, relation_type: 'madre' },
    ]
    const b = await corpo(await get(`&pagante=${ALTRO_GENITORE}`))
    expect(b.data!.figli.map((f) => f.alunno_id)).not.toContain(BIMBO_ESTRANEO)
  })
})

describe('il residuo viene da `residuoEffettivo`, non da una sottrazione a mano', () => {
  it('importo − sconto − incassato: 120 − 10 − 20 = 90', async () => {
    const b = await corpo(await get())
    const fuori = b.data!.figli.find((f) => f.alunno_id === BIMBO_FUORI)!
    expect(fuori.voci_aperte[0].residuo).toBe(90)
  })

  it('una voce già saldata non è una voce aperta', async () => {
    h.vociAperte = [{
      id: PAG_1, alunno_id: BIMBO_IN, scuola_id: 'sc-1', descrizione: 'Retta agosto',
      importo: 200, importo_pagato: 200, sconto: 0, scadenza: '2026-08-05', stato: 'pagato',
      tipo: 'singolo', categoria_id: 'cat-retta',
    }]
    const b = await corpo(await get())
    expect(b.data!.figli.flatMap((f) => f.voci_aperte)).toEqual([])
  })

  it('un contenitore `padre` non è una voce da incassare', async () => {
    h.vociAperte = [{
      id: PAG_1, alunno_id: BIMBO_IN, scuola_id: 'sc-1', descrizione: 'Rateizzazione',
      importo: 900, importo_pagato: 0, sconto: 0, scadenza: '2026-09-05', stato: 'scaduto',
      tipo: 'padre', categoria_id: 'cat-retta',
    }]
    const b = await corpo(await get())
    expect(b.data!.figli.flatMap((f) => f.voci_aperte)).toEqual([])
  })
})

describe('l’ordine delle voci è quello dell’ALLOCAZIONE, e muove denaro', () => {
  it('le voci di uno stesso bambino escono dalla più vecchia alla più recente', async () => {
    // ⚠️ NON È UN ORDINAMENTO DI CORTESIA. Quando il bonifico non copre tutto, il
    // motore alloca in quest'ordine: la prima voce dell'elenco è quella che viene
    // pagata, l'ultima è quella che resta scoperta. Invertirlo — o toglierlo —
    // lasciava 39 test su 39 verdi (misurato il 2026-09-13), e cambia QUALE retta
    // risulta saldata.
    //
    // Le voci sono tutte dello STESSO bambino e in fixture stanno nell'ordine
    // sbagliato: con voci di due figli diversi l'ordine non è osservabile, perché
    // il raggruppamento per bambino lo nasconde.
    h.vociAperte = [
      {
        id: PAG_2, alunno_id: BIMBO_IN, scuola_id: 'sc-1', descrizione: 'Retta ottobre',
        importo: 200, importo_pagato: 0, sconto: 0, scadenza: '2026-10-05', stato: 'emesso',
        tipo: 'singolo', categoria_id: 'cat-retta',
      },
      {
        id: PAG_3, alunno_id: BIMBO_IN, scuola_id: 'sc-1', descrizione: 'Materiale',
        importo: 30, importo_pagato: 0, sconto: 0, scadenza: null, stato: 'emesso',
        tipo: 'singolo', categoria_id: 'cat-retta',
      },
      {
        id: PAG_1, alunno_id: BIMBO_IN, scuola_id: 'sc-1', descrizione: 'Retta luglio',
        importo: 200, importo_pagato: 0, sconto: 0, scadenza: '2026-07-05', stato: 'scaduto',
        tipo: 'singolo', categoria_id: 'cat-retta',
      },
    ]
    const b = await corpo(await get())
    const voci = b.data!.figli.find((f) => f.alunno_id === BIMBO_IN)!.voci_aperte
    expect(
      voci.map((v) => v.id),
      'l’ordine non è quello dell’allocazione: cambia quale voce viene pagata quando il bonifico non copre tutto',
    ).toEqual([PAG_1, PAG_2, PAG_3])
  })
})

describe('il saldo ticket si innesta sugli ALUNNI, non sulla tabella dei saldi', () => {
  it('chi non ha mai ricaricato vale 0, e resta nell’elenco', async () => {
    const b = await corpo(await get())
    const fuori = b.data!.figli.find((f) => f.alunno_id === BIMBO_FUORI)!
    expect(fuori.saldo_ticket).toBe(0)
  })

  it('chi ha ricaricato porta il suo saldo', async () => {
    const b = await corpo(await get())
    const dentro = b.data!.figli.find((f) => f.alunno_id === BIMBO_IN)!
    expect(dentro.saldo_ticket).toBe(12)
  })

  it('`ticket_mensa` è stata interrogata sugli ALUNNI, non letta per intero', async () => {
    await get()
    const l = letteDa('ticket_mensa')
    expect(l).toHaveLength(1)
    expect(l[0].filtri.alunno_id).toBeDefined()
  })
})

describe('le categorie della voce nuova: solo quelle che ESISTONO (decisione n. 3)', () => {
  it('escono le globali e quelle della sede, con id e slug', async () => {
    const b = await corpo(await get())
    expect(b.data!.categorie.map((c) => c.slug).sort()).toEqual(['pomeridiano', 'retta'])
    expect(b.data!.categorie.find((c) => c.slug === 'retta')!.scuola_id).toBeNull()
    // ⚠️ E LA CATEGORIA DI PLESSO PORTA LA SUA SEDE. Asserire il solo `null` della
    // globale era una prova a senso unico: forzando `scuola_id: null` su TUTTE le
    // categorie, 39 test su 39 restavano verdi (misurato il 2026-09-13) — e il
    // pannello perdeva il modo di sapere che «Pomeridiano» è di un plesso solo,
    // cioè offriva a un fratello di un'altra sede una categoria che la scrittura
    // rifiuta.
    expect(
      b.data!.categorie.find((c) => c.slug === 'pomeridiano')!.scuola_id,
      'la categoria di plesso è uscita senza la sua sede: indistinguibile da una globale',
    ).toBe('sc-1')
  })

  it('la lettura filtra sulle ATTIVE', async () => {
    await get()
    const l = letteDa('payment_categories')
    expect(l.some((x) => x.filtri.attivo === true), 'le categorie disattivate entrerebbero in tendina').toBe(true)
  })

  it('la categoria di una sede che non si può gestire NON entra in tendina', async () => {
    // Il muro è qui: offrire la categoria di un plesso su cui la scrittura
    // risponderebbe 403 manda l'operatrice contro un rifiuto che sapevamo.
    h.categorie = [
      ...h.categorie,
      { id: 'cat-altro', nome: 'Doposcuola', slug: 'doposcuola', scuola_id: 'sc-9', attivo: true, ordine: 3 },
    ]
    const b = await corpo(await get())
    expect(b.data!.categorie.map((c) => c.slug)).not.toContain('doposcuola')
  })

  it('senza NESSUNA sede attiva restano le sole categorie globali', async () => {
    // `resolveScuoleAttive` risponde `[]` quando la sede scelta nel selettore non
    // è (o non è più) accessibile. Lì il ramo del filtro cambia — non c'è nessuna
    // lista da mettere nell'`in` — ed è il punto in cui un `.or` scritto male
    // smette di restringere senza che nulla lo dica.
    h.sediAttive = []
    const b = await corpo(await get())
    expect(b.data!.categorie.map((c) => c.slug)).toEqual(['retta'])
    expect(b.data!.categorie.every((c) => c.scuola_id === null)).toBe(true)
  })

  it('la categoria della sede del FRATELLO fuori portata non entra', async () => {
    h.categorie = [
      ...h.categorie,
      { id: 'cat-due', nome: 'Trasporto', slug: 'trasporto', scuola_id: 'sc-2', attivo: true, ordine: 4 },
    ]
    const b = await corpo(await get())
    expect(b.data!.categorie.map((c) => c.slug)).not.toContain('trasporto')
  })
})

describe('i pacchetti ticket precompilano il costo unitario (decisione n. 7)', () => {
  it('escono per sede, perché il costo di un pasto è della sede', async () => {
    const b = await corpo(await get())
    expect(b.data!.pacchetti_ticket['sc-1']).toEqual([{ label: '10 pasti', pezzi: 10, costo: 45 }])
  })

  it('una sede senza pacchetti configurati non inventa un costo', async () => {
    h.settings = [{ scuola_id: 'sc-1', ticket_pacchetti: null }]
    const b = await corpo(await get())
    expect(b.data!.pacchetti_ticket['sc-1']).toEqual([])
  })

  it('DUE sedi, due costi diversi: ognuna riceve il SUO, non quello dell’altra', async () => {
    // ⚠️ IL TEST CHE MANCAVA, ed è quello che rende la decisione n. 7 una
    // decisione invece di una frase. Con UNA sola sede componibile — com'era
    // questa fixture fino al 2026-09-13 — una mappa per sede e un numero solo
    // sono indistinguibili: sbagliare la chiave, applicare i pacchetti di una
    // sede a tutte, o togliere `.in('scuola_id', …)` lasciava 39 test su 39 verdi.
    //
    // E il caso è quello per cui la funzionalità esiste: due fratelli in due
    // plessi. Un costo unico sarebbe sbagliato per uno dei due, e la ricarica
    // partirebbe con il prezzo di un altro plesso — in silenzio.
    h.sediAttive = ['sc-1', 'sc-2']
    h.settings = [
      { scuola_id: 'sc-1', ticket_pacchetti: [{ label: '10 pasti', pezzi: 10, costo: 45 }] },
      { scuola_id: 'sc-2', ticket_pacchetti: [{ label: '20 pasti', pezzi: 20, costo: 96 }] },
      { scuola_id: 'sc-9', ticket_pacchetti: [{ label: '30 pasti', pezzi: 30, costo: 120 }] },
    ]
    const b = await corpo(await get())
    expect(
      Object.keys(b.data!.pacchetti_ticket).sort(),
      'è comparsa la chiave di una sede che l’operatore non gestisce',
    ).toEqual(['sc-1', 'sc-2'])
    expect(b.data!.pacchetti_ticket['sc-1']).toEqual([{ label: '10 pasti', pezzi: 10, costo: 45 }])
    expect(b.data!.pacchetti_ticket['sc-2']).toEqual([{ label: '20 pasti', pezzi: 20, costo: 96 }])
    expect(
      b.data!.pacchetti_ticket['sc-1'],
      'le due sedi hanno lo stesso listino: il costo di un pasto ha smesso di essere della sede',
    ).not.toEqual(b.data!.pacchetti_ticket['sc-2'])
  })

  it('una sede SENZA riga in `admin_settings` ha comunque la sua chiave, vuota', async () => {
    // Misurato in produzione il 2026-09-13: solo Giugliano ha un pacchetto;
    // Cesa (245 bambini) e Aversa (120) ne hanno zero, e la sede di collaudo non
    // ha nemmeno la riga. «Chiave assente» sarebbe quindi il caso NORMALE su due
    // sedi su tre, e darne due rappresentazioni significa due rami di rendering.
    h.settings = []
    const b = await corpo(await get())
    expect(b.data!.pacchetti_ticket).toEqual({ 'sc-1': [] })
  })
})

describe('il pagante proposto riusa `riconosciOrdinante`, non una regola nuova', () => {
  it('ordinante scritto come il genitore ⇒ proposta con motivo `bonifico_esatto`', async () => {
    const b = await corpo(await get())
    expect(b.data!.pagante.proposto).toEqual({ parent_id: GENITORE, motivo: 'bonifico_esatto' })
  })

  it('ordinante illeggibile ⇒ ripiega sul PAGANTE COMUNE, e lo dichiara', async () => {
    h.movimenti = [{ ...h.movimenti[0], controparte: null }, ...h.movimenti.slice(1)]
    const b = await corpo(await get())
    expect(b.data!.pagante.proposto).toEqual({ parent_id: GENITORE, motivo: 'pagante_comune' })
  })

  it('nessun genitore comune e nessun nome riconosciuto ⇒ nessuna proposta, mai «il primo»', async () => {
    // Il bonifico nomina DUE bambini, e nessun genitore li copre entrambi: è
    // l'unico modo di osservare il ritorno vuoto di `scegliPaganteComune` —
    // con un bambino solo, il suo genitore è sempre «comune a tutti».
    h.movimenti = [
      {
        ...h.movimenti[0],
        controparte: 'CHI NON ESISTE',
        suggerimenti: [{ pagamento_id: PAG_1 }, { pagamento_id: PAG_2 }],
      },
      ...h.movimenti.slice(1),
    ]
    h.pagamentiPerId = [
      { id: PAG_1, alunno_id: BIMBO_IN },
      { id: PAG_2, alunno_id: BIMBO_FUORI },
    ]
    h.studentParents = [
      { parent_id: GENITORE, student_id: BIMBO_IN, relation_type: 'padre' },
      { parent_id: ALTRO_GENITORE, student_id: BIMBO_FUORI, relation_type: 'madre' },
    ]
    const b = await corpo(await get())
    expect(b.data!.pagante.proposto).toBeNull()
  })

  it('i candidati escono comunque: la proposta si deve poter cambiare', async () => {
    const b = await corpo(await get())
    expect(b.data!.pagante.candidati.map((c) => c.parent_id)).toContain(GENITORE)
    expect(b.data!.pagante.candidati.find((c) => c.parent_id === GENITORE)!.nome).toBe('Mario Verdi')
  })
})

describe('i bambini che il bonifico NOMINA restano, anche se l’anagrafica non li collega', () => {
  it('cambiando pagante, il bambino dell’altro suggerimento non sparisce', async () => {
    // Il bonifico nomina DUE bambini di due famiglie diverse, e l'operatrice
    // sceglie uno dei due paganti. L'altro bambino non è figlio di quel pagante:
    // senza `for (const a of alunniCitati) ids.add(a)` uscirebbe dalla schermata
    // in cui si sarebbe visto che l'anagrafica è incompleta — e quel bonifico
    // resterebbe inspiegabile. Toglierla lasciava 39 test su 39 verdi.
    h.movimenti = [{ ...h.movimenti[0], suggerimenti: [{ pagamento_id: PAG_1 }, { pagamento_id: PAG_2 }] }]
    h.pagamentiPerId = [
      { id: PAG_1, alunno_id: BIMBO_IN, scuola_id: 'sc-1' },
      { id: PAG_2, alunno_id: BIMBO_FUORI, scuola_id: 'sc-2' },
    ]
    h.studentParents = [
      { parent_id: GENITORE, student_id: BIMBO_IN, relation_type: 'padre' },
      { parent_id: ALTRO_GENITORE, student_id: BIMBO_FUORI, relation_type: 'madre' },
      { parent_id: ESTRANEO_GENITORE, student_id: BIMBO_ESTRANEO, relation_type: 'madre' },
    ]
    const b = await corpo(await get(`&pagante=${ALTRO_GENITORE}`))
    const ids = b.data!.figli.map((f) => f.alunno_id)
    // Il figlio del pagante scelto, per legame...
    expect(ids).toContain(BIMBO_FUORI)
    // ...e il bambino che il bonifico nomina, che con quel pagante non ha legami.
    expect(ids, 'un bambino nominato dal bonifico è sparito dalla schermata').toContain(BIMBO_IN)
    // Il muro resta in piedi: la famiglia estranea non entra comunque.
    expect(ids).not.toContain(BIMBO_ESTRANEO)
  })
})

describe('i legami vengono da DUE sorgenti vive, ed è la ragione di questa rotta', () => {
  // ⚠️ FINO AL 2026-09-13 QUESTE DUE STRADE ERANO CODICE MORTO PER I TEST:
  // `h.legamiRuntime` valeva `[]` in ogni test e `auth_user_id` era `null` su
  // entrambi i genitori, quindi il ramo `if (account)` non veniva MAI eseguito.
  // Misurato: sostituendo `getGenitoriDiAlunniEsito` con una mappa vuota, 39 test
  // su 39 restavano verdi; neutralizzando `getFigliDiGenitoreEsito`, idem.
  // La testata della rotta dichiara che queste due sorgenti chiudono «un difetto
  // già pagato una volta» — i tutori di un bambino arrivato dal modulo pubblico
  // che «non risultavano». Senza queste due prove, quella frase non la teneva niente.

  it('un genitore che l’ANAGRAFICA non conosce ancora è comunque un candidato', async () => {
    // `student_parents` vuota — è il caso del bambino iscritto dal modulo
    // pubblico: il legame esiste solo in `legame_genitori_alunni`, e il ponte per
    // arrivare al record `parents` è `auth_user_id`.
    h.studentParents = []
    h.legamiRuntime = [{ alunno_id: BIMBO_IN, genitore_id: 'acc-1' }]
    h.parents = [
      { id: GENITORE, first_name: 'Mario', last_name: 'Verdi', auth_user_id: 'acc-1', intestatario_default: true },
      { id: ALTRO_GENITORE, first_name: 'Anna', last_name: 'Bianchi', auth_user_id: null, intestatario_default: false },
    ]
    const b = await corpo(await get())
    expect(
      b.data!.pagante.candidati.map((c) => c.parent_id),
      'il tutore noto alla sola sorgente runtime non è fra i candidati: è il difetto già pagato',
    ).toContain(GENITORE)
    expect(b.data!.pagante.proposto).toEqual({ parent_id: GENITORE, motivo: 'bonifico_esatto' })
  })

  it('un figlio che l’ANAGRAFICA non collega al pagante esce lo stesso', async () => {
    // Il verso opposto: il pagante è noto all'anagrafica per un figlio, e il
    // secondo figlio lo conosce solo il runtime. Senza quella lettura il fratello
    // sparisce dal pannello, e il bonifico di famiglia non si può comporre.
    h.studentParents = [
      { parent_id: GENITORE, student_id: BIMBO_IN, relation_type: 'padre' },
      { parent_id: ESTRANEO_GENITORE, student_id: BIMBO_ESTRANEO, relation_type: 'madre' },
    ]
    h.legamiRuntime = [{ alunno_id: BIMBO_FUORI, genitore_id: 'acc-1' }]
    h.parents = [
      { id: GENITORE, first_name: 'Mario', last_name: 'Verdi', auth_user_id: 'acc-1', intestatario_default: true },
      { id: ALTRO_GENITORE, first_name: 'Anna', last_name: 'Bianchi', auth_user_id: null, intestatario_default: false },
    ]
    const b = await corpo(await get())
    const ids = b.data!.figli.map((f) => f.alunno_id)
    expect(ids).toContain(BIMBO_IN)
    expect(ids, 'il fratello noto alla sola sorgente runtime non è uscito').toContain(BIMBO_FUORI)
    expect(ids).not.toContain(BIMBO_ESTRANEO)
  })
})

describe('l’operatrice può cambiare il pagante, ma non enumerare l’archivio', () => {
  it('`?pagante=` fra i candidati ricompone il contesto su quella famiglia', async () => {
    h.studentParents = [
      { parent_id: GENITORE, student_id: BIMBO_IN, relation_type: 'padre' },
      { parent_id: ALTRO_GENITORE, student_id: BIMBO_IN, relation_type: 'madre' },
      { parent_id: ALTRO_GENITORE, student_id: BIMBO_FUORI, relation_type: 'madre' },
    ]
    const b = await corpo(await get(`&pagante=${ALTRO_GENITORE}`))
    expect(b.data!.pagante.proposto).toEqual({ parent_id: ALTRO_GENITORE, motivo: 'scelto' })
    expect(b.data!.figli.map((f) => f.alunno_id).sort()).toEqual([BIMBO_IN, BIMBO_FUORI].sort())
  })

  it('un `pagante` che non è fra i candidati è un 403 col suo codice', async () => {
    const res = await get('&pagante=eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee9')
    expect(res.status).toBe(403)
    const b = await corpo(res)
    expect(b.codice).toBe('CONCILIAZIONE_PAGANTE_NON_AMMESSO')
  })

  it('un `pagante` che non è un uuid è un 400, non una query', async () => {
    const res = await get('&pagante=pippo')
    expect(res.status).toBe(400)
  })
})

describe('gli errori hanno un codice, e un guasto non si traveste da elenco vuoto', () => {
  it('movimento inesistente ⇒ 404 col codice', async () => {
    h.movimenti = []
    const res = await get()
    expect(res.status).toBe(404)
    expect((await corpo(res)).codice).toBe('CONCILIAZIONE_MOVIMENTO_NON_TROVATO')
  })

  it('PostgREST che ritorna `{ error }` sulle voci ⇒ 500 col codice, non `voci_aperte: []`', async () => {
    h.vociError = { code: '08006', message: 'connessione caduta' }
    const res = await get()
    expect(res.status).toBe(500)
    expect((await corpo(res)).codice).toBe('CONCILIAZIONE_CONTESTO_NON_LETTO')
    expect(h.logErrore, 'un errore 500 senza una riga di log').toHaveBeenCalled()
  })

  it('un id che non è un uuid è un 400', async () => {
    const res = await get('', 'non-un-uuid')
    expect(res.status).toBe(400)
  })
})

describe('degrado pulito sul DB E2E della CI, che non è migrato', () => {
  it('`42703` su `sconto` si ritenta senza quella colonna, e il residuo esce lo stesso', async () => {
    // Il DB della CI non ha `sconto`: senza il secondo tentativo la risposta
    // sarebbe un 500 su ogni bonifico, in ogni esecuzione di Playwright.
    h.vociError = { code: '42703', message: 'column pagamenti.sconto does not exist' }
    h.vociAperte = [{
      id: PAG_1, alunno_id: BIMBO_IN, scuola_id: 'sc-1', descrizione: 'Retta settembre',
      importo: 200, importo_pagato: 50, scadenza: '2026-09-05', stato: 'scaduto',
      tipo: 'singolo', categoria_id: 'cat-retta',
    }]
    const res = await get()
    expect(res.status).toBe(200)
    const b = await corpo(res)
    // 200 − 50, con lo sconto assente trattato come 0.
    expect(b.data!.figli.find((f) => f.alunno_id === BIMBO_IN)!.voci_aperte[0].residuo).toBe(150)
    // Due letture delle voci: la prima caduta, la seconda senza `sconto`.
    const voci = letteDa('pagamenti').filter((l) => 'alunno_id' in l.filtri)
    expect(voci).toHaveLength(2)
    expect(voci[0].cols).toMatch(/sconto/)
    expect(voci[1].cols, 'il secondo tentativo richiede ancora la colonna che non c’è').not.toMatch(/sconto/)
  })

  it('`42703` su `alunni.stato` non svuota il pannello: si degrada APERTI', async () => {
    // `stato` è fra le colonne che il DB E2E può non avere (`COLONNE_VISIBILITA`).
    // Senza il ripiego questa rotta risponderebbe 500 su ogni bonifico in CI, e
    // la schermata «Componi il pagamento» non sarebbe mai collaudata da Playwright.
    h.alunniError = { code: '42703', message: 'column alunni.stato does not exist' }
    const res = await get()
    expect(res.status).toBe(200)
    const b = await corpo(res) as unknown as { data: { figli: { attivo: boolean }[] } }
    expect(b.data.figli).toHaveLength(2)
    // Il criterio non si applica: nessuno viene dichiarato ritirato per una
    // colonna che non esiste. Il rifiuto resta quello della scrittura.
    expect(b.data.figli.every((f) => f.attivo)).toBe(true)
    const letture = letteDa('alunni')
    expect(letture).toHaveLength(2)
    expect(letture[1].cols, 'il ripiego richiede ancora la colonna che non c’è').not.toMatch(/stato/)
  })

  it('un errore che NON è 42703 sugli alunni resta un 500 col suo codice', async () => {
    // Il ripiego vale per la colonna assente, non per un guasto: senza questa
    // distinzione una connessione caduta uscirebbe come «questa famiglia non ha
    // figli», con un 200 sopra.
    h.alunniError = { code: '08006', message: 'connessione caduta' }
    const res = await get()
    expect(res.status).toBe(500)
    expect((await corpo(res)).codice).toBe('CONCILIAZIONE_CONTESTO_NON_LETTO')
  })
})

describe('un bambino non più iscritto: si incassa l’arretrato, non si creano voci nuove', () => {
  it('resta nell’elenco — l’arretrato di chi ha lasciato si incassa comunque', async () => {
    h.alunni = [
      { id: BIMBO_IN, nome: 'Luca', cognome: 'Verdi', scuola_id: 'sc-1', stato: 'ritirato' },
      { id: BIMBO_FUORI, nome: 'Sara', cognome: 'Verdi', scuola_id: 'sc-2', stato: 'iscritto' },
    ]
    const b = await corpo(await get())
    expect(b.data!.figli.map((f) => f.alunno_id)).toContain(BIMBO_IN)
  })

  it('ma è marcato `attivo: false`, così il pannello non offre una voce nuova che verrà rifiutata', async () => {
    h.alunni = [
      { id: BIMBO_IN, nome: 'Luca', cognome: 'Verdi', scuola_id: 'sc-1', stato: 'ritirato' },
      { id: BIMBO_FUORI, nome: 'Sara', cognome: 'Verdi', scuola_id: 'sc-2', stato: 'iscritto' },
    ]
    const b = await corpo(await get()) as unknown as { data: { figli: { alunno_id: string; attivo: boolean }[] } }
    expect(b.data.figli.find((f) => f.alunno_id === BIMBO_IN)!.attivo).toBe(false)
    expect(b.data.figli.find((f) => f.alunno_id === BIMBO_FUORI)!.attivo).toBe(true)
  })

  it('un `sospeso` frequenta ancora: resta attivo', async () => {
    h.alunni = [{ id: BIMBO_IN, nome: 'Luca', cognome: 'Verdi', scuola_id: 'sc-1', stato: 'sospeso' }]
    const b = await corpo(await get()) as unknown as { data: { figli: { attivo: boolean }[] } }
    expect(b.data.figli[0].attivo).toBe(true)
  })
})

describe('le voci alimentano `rigaDaVoceAperta` senza adattatori nel browser', () => {
  it('ogni voce porta i campi che il motore legge, slug della categoria compreso', async () => {
    const b = await corpo(await get())
    const v = b.data!.figli.find((f) => f.alunno_id === BIMBO_IN)!.voci_aperte[0] as Record<string, unknown>
    for (const campo of ['id', 'alunno_id', 'scuola_id', 'descrizione', 'importo', 'importo_pagato', 'scadenza', 'stato', 'tipo']) {
      expect(v, `manca \`${campo}\`: il motore non potrebbe comporre la riga`).toHaveProperty(campo)
    }
    expect((v.payment_categories as { slug?: string } | null)?.slug).toBe('retta')
  })
})

/**
 * ─── `?alunni=`: È QUI CHE SI SBLOCCA IL LAVORO SUI MOVIMENTI ROSSI ──────────
 *
 * Su un movimento che il matcher non ha saputo abbinare non c'è nessun
 * suggerimento. Senza suggerimenti non c'è nessun bambino citato; senza bambini
 * non c'è nessun genitore candidato; senza candidati la tendina dei figli è
 * vuota e «Conferma» resta spento. Non è un difetto del riconoscimento
 * dell'ordinante: anche riconoscendolo alla perfezione non avrebbe su cosa
 * decidere.
 *
 * ⚠️ E `?alunni=` è un uuid CHE ARRIVA DAL CLIENT, l'unico di questa rotta
 * insieme a `?pagante=`. Senza la verifica di sede farebbe di una schermata di
 * incasso un modo per sfogliare l'archivio — voci aperte, residui e nomi dei
 * genitori di una famiglia qualunque — conoscendo un solo id.
 */
/** Un bambino della sede dell'operatore che NESSUN genitore risulta seguire. */
const BIMBO_SENZA_GENITORI = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb7'
/** Un uuid ben formato che in `alunni` non esiste affatto. */
const BIMBO_INESISTENTE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb8'

/** Il movimento ROSSO: nessun suggerimento, nessun pagamento già abbinato. */
const rendiRosso = () => {
  h.movimenti = [
    { ...h.movimenti[0], controparte: 'CHI NON ESISTE', suggerimenti: [], pagamento_id: null },
    ...h.movimenti.slice(1),
  ]
}

describe('un movimento ROSSO si compone solo se si può dire DI CHI è', () => {
  it('senza `?alunni=` non c’è nessun candidato: è il difetto, e si misura', async () => {
    // IL CONTROLLO NEGATIVO, e senza di lui il test qui sotto non proverebbe
    // niente: «candidati non vuoti» è una frase vera anche su una rotta che li
    // avrebbe trovati comunque. Questa è la schermata che l'operatrice vede oggi
    // su un bonifico rosso — e da cui non può fare nulla.
    rendiRosso()
    const b = await corpo(await get())
    expect(b.data!.pagante.candidati).toEqual([])
    expect(b.data!.pagante.proposto).toBeNull()
    expect(b.data!.figli, 'la tendina dei figli non è vuota: il difetto non è riprodotto').toEqual([])
  })

  it('`?alunni=` sblocca candidati, pagante proposto e figli: è la prova che chiude il difetto', async () => {
    rendiRosso()
    const b = await corpo(await get(`&alunni=${BIMBO_IN}`))
    // I candidati sono i genitori di quel bambino, dalle due sorgenti.
    expect(
      b.data!.pagante.candidati.map((c) => c.parent_id),
      'i bambini indicati a mano non arrivano al calcolo dei candidati',
    ).toEqual([GENITORE])
    // L'ordinante è illeggibile («CHI NON ESISTE»): il pagante lo dà il legame,
    // ed è il ripiego che `scegliPaganteComune` già sapeva fare.
    expect(b.data!.pagante.proposto).toEqual({ parent_id: GENITORE, motivo: 'pagante_comune' })
    // ...e con il pagante arrivano i figli, quello indicato compreso.
    expect(b.data!.figli.map((f) => f.alunno_id)).toContain(BIMBO_IN)
    // La famiglia estranea resta fuori: la strada nuova non apre una porta
    // laterale a quella che il muro di `.eq('parent_id', …)` tiene chiusa.
    expect(b.data!.figli.map((f) => f.alunno_id)).not.toContain(BIMBO_ESTRANEO)
  })

  it('e le voci aperte di quel bambino ci sono: è ciò che si sta per incassare', async () => {
    rendiRosso()
    const b = await corpo(await get(`&alunni=${BIMBO_IN}`))
    expect(b.data!.figli.find((f) => f.alunno_id === BIMBO_IN)!.voci_aperte.map((v) => v.id)).toEqual([PAG_1])
  })

  it('il battito conta le due sorgenti SEPARATE: il successo di `?alunni=` lascia una traccia', async () => {
    // AGENTS.md, regola 5: gli eventi critici loggano anche il SUCCESSO. Finché
    // si scriveva solo il rifiuto (`alunno-chiesto-fuori-perimetro`), «nessuna
    // riga» non distingueva «nessuno usa `?alunni=`» da «lo usano tutti e
    // funziona sempre» — cioè la funzionalità per cui esiste questo lotto era
    // invisibile in produzione proprio quando funziona.
    //
    // E c'è una seconda ragione, che è il motivo per cui il campo è NUOVO invece
    // di essere il vecchio riletto: `alunni_citati` ha cambiato significato senza
    // cambiare nome (da «quelli che il bonifico nomina» a «quelli che nomina PIÙ
    // quelli indicati a mano»). Senza un secondo conteggio accanto, una riga di
    // ieri e una di oggi sarebbero indistinguibili interrogando `app_log`.
    rendiRosso()

    await get()
    const senza = battito()
    expect(senza, 'il giro senza `?alunni=` non ha lasciato battito').toBeDefined()
    expect(senza, 'sul giro senza parametro il conteggio non parte da zero').toMatchObject({
      alunni_citati: 0,
      alunni_indicati: 0,
    })

    // Solo il registratore dei log, non i mock di tutto il file: azzerare anche
    // `requireStaff` farebbe fallire il secondo giro sul gate invece che sul
    // battito, e il rosso parlerebbe della cosa sbagliata.
    h.logEvento.mockClear()
    await get(`&alunni=${BIMBO_IN}`)
    const con = battito()
    expect(con, 'il giro con `?alunni=` non ha lasciato battito').toBeDefined()
    // 1 e 1: su un rosso i suggerimenti sono zero per definizione, quindi
    // `alunni_citati` qui è tutto e solo ciò che è arrivato a mano — ed è
    // esattamente la differenza che i due numeri insieme rendono leggibile.
    expect(con, 'il successo di `?alunni=` non si conta: resta indistinguibile dal non averlo usato').toMatchObject({
      alunni_citati: 1,
      alunni_indicati: 1,
    })

    // Conteggi, mai gli uuid: il battito esce anche quando i bambini indicati
    // sono leciti, ed è la riga che si legge più spesso.
    const loggato = JSON.stringify([h.logEvento.mock.calls, h.logErrore.mock.calls, h.logOk.mock.calls])
    expect(loggato, 'l’uuid di un bambino è finito in `app_log`').not.toMatch(BIMBO_IN)
    expect(loggato, 'il nome di un minore è in un log').not.toMatch(/luca|sara|giulia/i)
  })

  it('`?alunni=` vuoto non è un 400: è una richiesta senza bambini indicati', async () => {
    // Il pannello appende il parametro anche quando non ha ancora scelto nessuno:
    // un 400 su `&alunni=` renderebbe rosso ogni caricamento della schermata.
    rendiRosso()
    const res = await get('&alunni=')
    expect(res.status).toBe(200)
    expect((await corpo(res)).data!.pagante.candidati).toEqual([])
  })
})

describe('🔴 `?alunni=` non è un modo per sfogliare l’archivio: la sede si verifica PRIMA', () => {
  it('un bambino di un plesso che l’operatore non gestisce è un 404 col suo codice', async () => {
    // Controllo positivo: quel bambino ESISTE davvero nella fixture, ed è in
    // `sc-2`. Senza questa riga il test sarebbe una frase su una tabella vuota.
    expect(h.alunni.some((a) => a.id === BIMBO_FUORI && a.scuola_id === 'sc-2')).toBe(true)
    expect(h.sediAttive).toEqual(['sc-1'])

    rendiRosso()
    const res = await get(`&alunni=${BIMBO_FUORI}`)
    expect(res.status, 'un 403 direbbe che quel bambino esiste altrove').toBe(404)
    const b = await corpo(res)
    expect(b.codice).toBe('CONCILIAZIONE_ALUNNO_NON_TROVATO')
    // ⚠️ E NON un 200 con un elenco vuoto: un diniego travestito da «non c'è
    // niente» manda l'operatrice a cercare un bonifico che invece si può comporre.
    expect(b.data, 'il rifiuto è uscito come una risposta felice vuota').toBeUndefined()
  })

  it('un uuid che in `alunni` non esiste affatto riceve la STESSA risposta', async () => {
    // È il punto dei 404: «non è tuo» e «non esiste» devono essere
    // indistinguibili, o la differenza fra le due risposte diventa essa stessa
    // l'informazione — «quel bambino è iscritto in un altro plesso».
    rendiRosso()
    const res = await get(`&alunni=${BIMBO_INESISTENTE}`)
    expect(res.status).toBe(404)
    expect((await corpo(res)).codice).toBe('CONCILIAZIONE_ALUNNO_NON_TROVATO')
  })

  it('basta UNO fuori perimetro perché la richiesta intera si fermi', async () => {
    // Nessuna risposta parziale: servire i bambini leciti e tacere sugli altri
    // direbbe comunque, per differenza, quali dei due erano fuori.
    rendiRosso()
    const res = await get(`&alunni=${BIMBO_IN},${BIMBO_FUORI}`)
    expect(res.status).toBe(404)
    expect((await corpo(res)).codice).toBe('CONCILIAZIONE_ALUNNO_NON_TROVATO')
  })

  it('il log del rifiuto porta CONTEGGI, mai gli uuid e mai i nomi', async () => {
    rendiRosso()
    await get(`&alunni=${BIMBO_FUORI}`)
    const riga = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string } | undefined)?.esito === 'alunno-chiesto-fuori-perimetro',
    )
    expect(riga, 'il rifiuto è muto: «nessun log» non distingue «non è successo» da «non l’ho scritto»').toBeDefined()
    expect(riga![2]).toMatchObject({ chiesti: 1, dentro: 0 })
    const loggato = JSON.stringify([h.logEvento.mock.calls, h.logErrore.mock.calls, h.logOk.mock.calls])
    expect(loggato, 'l’uuid del bambino chiesto è finito in `app_log`').not.toMatch(BIMBO_FUORI)
    expect(loggato, 'il nome di un minore è in un log').not.toMatch(/luca|sara|giulia/i)
    expect(loggato, 'un cognome è in un log').not.toMatch(/verdi|neri|bianchi/i)
  })

  it('senza NESSUNA sede attiva non esiste perimetro: 404, e nemmeno la query parte', async () => {
    // `resolveScuoleAttive` risponde `[]` quando la sede scelta nel selettore non
    // è (o non è più) accessibile. Lì `.in('scuola_id', [])` non è una condizione
    // — è il modo in cui un filtro smette di restringere proprio dove serve di
    // più — e la verifica deve rispondere di no invece di chiederlo al database.
    h.sediAttive = []
    rendiRosso()
    const res = await get(`&alunni=${BIMBO_IN}`)
    expect(res.status).toBe(404)
    expect((await corpo(res)).codice).toBe('CONCILIAZIONE_ALUNNO_NON_TROVATO')
    expect(letteDa('alunni'), 'una lettura è partita senza un perimetro entro cui verificare').toEqual([])
  })

  it('un guasto di lettura NON si traveste da 404: resta un 500 col suo codice', async () => {
    // PostgREST non lancia. Senza il controllo sul valore di ritorno, un database
    // che non risponde uscirebbe come «quel bambino non esiste» — e manderebbe a
    // cercare un errore di digitazione dove c'è un guasto.
    h.alunniError = { code: '08006', message: 'connessione caduta' }
    rendiRosso()
    const res = await get(`&alunni=${BIMBO_IN}`)
    expect(res.status).toBe(500)
    expect((await corpo(res)).codice).toBe('CONCILIAZIONE_CONTESTO_NON_LETTO')
    expect(h.logErrore, 'un 500 senza una riga di log').toHaveBeenCalled()
  })
})

describe('un bambino che nessun genitore risulta seguire: si vede, e si capisce perché', () => {
  it('candidati vuoti e proposto nullo, ma il bambino resta nell’elenco dei figli', async () => {
    // ⚠️ IL NUMERO È RIMISURATO IL 2026-09-20, non ereditato dalla specifica —
    // che diceva «due bambini a Giugliano» e sbagliava due volte.
    //   SELECT s.nome, count(*) FROM alunni a LEFT JOIN scuole s ON s.id=a.scuola_id
    //   WHERE NOT EXISTS (SELECT 1 FROM student_parents sp WHERE sp.student_id=a.id)
    //     AND NOT EXISTS (SELECT 1 FROM legame_genitori_alunni l WHERE l.alunno_id=a.id)
    //   GROUP BY 1;
    // I bambini senza NESSUN legame sono 9: Giugliano 4, Cesa 4, Aversa 1 (più 2
    // righe della sede fittizia E2E, che non sono produzione). E lo stesso conteggio
    // raggruppato per `a.stato` restituisce UNA riga sola: `ritirato`, 9.
    //
    // Nessuno di loro è ancora iscritto, e questo cambia ciò che il pannello deve
    // fare: NON «creargli una voce» — su un `attivo: false` la scrittura rifiuta
    // comunque una voce nuova (`CONCILIAZIONE_ALUNNO_NON_ATTIVO`, in
    // `conciliazione-registra.ts`) — ma MOSTRARLO e spiegare perché «Conferma»
    // resta spento, che qui sono due motivi e non uno: manca l'intestatario e il
    // bambino non è più iscritto. Rispondere con un elenco vuoto renderebbe
    // «non è tuo», «non ha intestatario» e «ha lasciato» la stessa risposta.
    //
    // Per questo la fixture porta `stato: 'ritirato'`: un bambino ISCRITTO e senza
    // nessun genitore oggi in produzione non esiste, e modellarlo qui vorrebbe dire
    // provare una schermata che nessuno vede.
    rendiRosso()
    h.alunni = [
      ...h.alunni,
      { id: BIMBO_SENZA_GENITORI, nome: 'Dario', cognome: 'Rossi', scuola_id: 'sc-1', stato: 'ritirato' },
    ]
    const b = await corpo(await get(`&alunni=${BIMBO_SENZA_GENITORI}`))
    expect(b.data!.pagante.candidati).toEqual([])
    expect(b.data!.pagante.proposto).toBeNull()
    expect(
      b.data!.figli.map((f) => f.alunno_id),
      'il bambino senza genitori è sparito: il pannello non potrebbe nemmeno mostrarlo',
    ).toEqual([BIMBO_SENZA_GENITORI])
    // È della sede dell'operatore: il nome esce, come per ogni figlio in sede.
    expect(b.data!.figli[0].nome).toBe('Dario Rossi')
    // ...e marcato non attivo, come i 9 veri: è il campo da cui il pannello sa
    // che «aggiungi una voce» qui va spento invece di andare a sbattere sul 422.
    expect(
      (b as unknown as { data: { figli: { attivo: boolean }[] } }).data.figli[0].attivo,
      'un bambino ritirato risulta attivo: il pannello offrirebbe una voce nuova che la conferma rifiuta',
    ).toBe(false)
  })
})

describe('il tetto di `?alunni=` lo applica lo SCHEMA, non una riga dentro la rotta', () => {
  it('più di cinque uuid è un 400, non una query', async () => {
    const sei = Array.from({ length: 6 }, (_, i) => `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb2${i}`)
    rendiRosso()
    const res = await get(`&alunni=${sei.join(',')}`)
    expect(res.status).toBe(400)
    expect(letteDa('alunni'), 'la lista è arrivata al database prima del tetto').toEqual([])
  })

  it('e il tetto non si aggira ripetendo lo stesso uuid', async () => {
    // Il tetto vale su ciò che è ARRIVATO: contarlo dopo aver tolto i doppioni
    // lo renderebbe una formalità, perché sei uuid ripetuti sono comunque sei
    // uuid chiesti.
    rendiRosso()
    const res = await get(`&alunni=${Array(6).fill(BIMBO_IN).join(',')}`)
    expect(res.status).toBe(400)
  })

  it('un `alunni` che non è un uuid è un 400, non una query', async () => {
    rendiRosso()
    const res = await get('&alunni=pippo')
    expect(res.status).toBe(400)
    expect(letteDa('alunni')).toEqual([])
  })
})
