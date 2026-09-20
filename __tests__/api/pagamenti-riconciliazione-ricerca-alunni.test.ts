import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * ─── LA RICERCA DEL BAMBINO DA CUI COMPORRE UN BONIFICO ──────────────────────
 *
 * `GET /api/pagamenti/riconciliazione/alunni` non scrive niente: risponde a
 * «quali bambini, fra quelli che posso gestire, rispondono a questo nome, a
 * questo cognome o a questo codice fiscale?».
 *
 * Quello che questo file misura sono le sedici decisioni che la rotta ha preso
 * contro l'alternativa più comoda (sedici: contate qui sotto, non a memoria —
 * questo numero è già invecchiato quattro volte):
 *  1. sotto i due caratteri **non si interroga il database** — e qui è
 *     un'asserzione sulla SPIA, non una speranza: `from()` non deve partire;
 *  2. il perimetro è quello della SCRITTURA (`resolveScuoleAttive`): un bambino
 *     di una sede non attiva non compare;
 *  3. il **codice fiscale è chiave di ricerca, non dato da mostrare**: si trova
 *     un bambino cercandolo per CF, e quel CF non è da nessuna parte nel corpo
 *     della risposta (`JSON.stringify` intero, non campo per campo: una chiave
 *     nuova che lo ricopiasse passerebbe sotto un'asserzione puntuale);
 *  4. un elenco troncato lo **dichiara**, perché «non l'ho trovato» e «non l'ho
 *     guardato tutto» mandano chi cerca a fare due cose opposte;
 *  5. **un ritirato compare** — è la divergenza deliberata da
 *     `legami-familiari?tipo=alunni`, che i ritirati li esclude;
 *  6. `trovato_per_cf` dice «il codice corrisponde e il nome NO», e lo dice su
 *     una riga in cui corrispondono tutt'e due: è l'unico caso in cui quel
 *     `!perNome` può sbagliare, e senza di esso sarebbe decorazione verde;
 *  7. **il perimetro vuoto lascia una TRACCIA**: è l'unico ramo in cui la rotta
 *     nega, e negare in silenzio è di nuovo «non l'ho trovato» spacciato per
 *     «non ho potuto cercare». `scope.ts` lì non logga (il suo `warn` copre solo
 *     il cookie con sedi non più accessibili), quindi la riga la scrive la rotta;
 *  8. la soglia dei due caratteri si misura sul **contenuto**, non sui
 *     caratteri: dentro `ilike` PostgREST legge `*` come `%`, e `q=**` sarebbe
 *     «qualunque riga» del perimetro;
 *  9. la finestra delle voci **troncata** dal `db-max-rows` degrada a `null`
 *     come un errore di lettura, perché un conteggio corto è uno `0` parziale;
 * 10. **la riga ha una forma, e va provata invece che dichiarata**: `nome` è
 *     «Cognome Nome» in quest'ordine (non «Nome Cognome»), `classe_sezione` e
 *     `scuola_id` sono ricopiati e non `null`, l'elenco è ordinato per cognome e
 *     poi nome, e il ripiego di un'anagrafica senza nome è una stringa fissa mai
 *     un vuoto. È l'unico dato di un minore che attraversa il confine e l'unica
 *     cosa su cui si sceglie un bambino: questo blocco esiste perché quattro di
 *     questi campi erano verdi anche SOSTITUITI da una costante;
 * 11. un'eccezione dentro il `try` esce come **500 con il suo codice e con una
 *     riga di log**: `withRoute` non vede le eccezioni CATTURATE, quindi senza
 *     quel `logErrore` il guasto uscirebbe muto.
 * 12. **i tre conteggi del log sono CONTATI, non tre costanti — e la riga c'è su
 *     TUTT'E TRE i ritorni**: `n`, `troncato` e `sedi` sono il contenuto
 *     obbligatorio della riga, e l'unico caso che li guardava aveva `1`, `false`
 *     e `1` — cioè tre valori che coincidevano con tre costanti. Un `n` cablato
 *     rende `app_log` cieco proprio sulla domanda per cui quella riga esiste:
 *     quante anagrafiche di minori sono uscite, e se l'elenco era tagliato.
 *     ⚠️ E i ritorni sono TRE, non uno: il caso pieno, il perimetro vuoto e il
 *     **«nessun risultato»**, che è l'esito PIÙ FREQUENTE di un campo che si
 *     ridisegna a ogni tasto. Quest'ultimo è rimasto scoperto fino al sesto giro
 *     (misurato: cancellando la sua `logEvento`, e cablandone i tre conteggi a
 *     `7`/`true`/`99`, la suite restava verde tutt'e due le volte) — cioè questa
 *     riga di testata prometteva una difesa che il file teneva solo a metà.
 *     ⚠️ E la stessa classe vale per le righe di DEGRADO, che sono log e non
 *     corpo: `voci-aperte-non-lette` era asserita, `nomi-sedi-non-letti` e
 *     `colonna-sconto-assente` no — cancellabili a suite verde, la seconda col
 *     proprio gemello `colonna-stato-assente` asserito otto righe più in là. Un
 *     difetto di forma si cerca su TUTTI i campi con quella forma;
 * 13. **niente N+1**: le due letture di contorno (voci e paganti) sono UNA per
 *     tabella sui ≤ 20 id, e si contano invece di sperarci. Su una schermata che
 *     si ridisegna a ogni tasto battuto venti andate e ritorni al posto di una
 *     sono il guasto «volume» già visto su questo repo;
 * 14. **quante anagrafiche escono si prova ai TRE confini**, non a duecento
 *     passi: 21 è un 400 e 20 è un 200 che chiede 21 righe (un caso lontano come
 *     `limite=500` resta verde anche col tetto decuplicato); `limite=0` è un 400
 *     (senza il minimo la risposta sarebbe elenco VUOTO con `troncato: true`,
 *     cioè i due messaggi opposti insieme); e chi il parametro non lo manda ne
 *     riceve 10 — il DEFAULT, che è il caso normale visto che di chiamanti non ce
 *     n'è ancora nessuno, e che si poteva raddoppiare in silenzio;
 * 15. **le difese silenziose si vedono fallire**, o sono commenti: il gate di
 *     ruolo che precede anche zod (con una query malformata la risposta resta
 *     403, non diventa 400), il `trim()` che tiene fuori dalla mappa delle sedi
 *     un nome di soli spazi, il filtro che scarta una riga di anagrafica senza
 *     id, e il tetto di 200 caratteri sul termine cercato. Tutte e QUATTRO erano
 *     verdi anche tolte — la quarta è arrivata dopo, e il numero qui sopra va
 *     tenuto allineato invece di promettere più di quanto il file tiene;
 * 16. **la BUSTA è un contratto, non una convenzione sperata**: il `success:
 *     true` del successo (la forma di 199 route di `src/app/api`, quella su cui
 *     `esitoFetch` decide se mostrare un elenco o un errore) e, sui due 500, il
 *     campo `error` leggibile ACCANTO al `codice`. Misurato: riducendo
 *     `rispondi()` a `NextResponse.json({ data, troncato, sedi })`, e togliendo
 *     `error:` dai due corpi d'errore, la suite restava verde — il `success`
 *     viveva nel solo TIPO di ritorno di `corpo()`, e del corpo d'errore nessuno
 *     guardava che metà. Il lock `errori-con-codice` non copre il buco: sorveglia
 *     la presenza del CODICE, non quella della frase.
 *
 * ─── COSA NON È FINTO, E PERCHÉ ─────────────────────────────────────────────
 * `pagantiAmmessiPerAlunni` (`@/lib/pagamenti/pagante-ammesso`) e
 * `residuoEffettivo` (`@/lib/pagamenti/aging`) girano PER DAVVERO: sono le due
 * regole che questa rotta deve RIUSARE invece di riscrivere — chi può pagare, e
 * quanto resta da incassare — e mockarle renderebbe il test verde su una copia
 * divergente, cioè proprio sul difetto che si vuole impedire.
 *
 * Dati SINTETICI: uuid, nomi e codici fiscali inventati. Il repository è
 * pubblico e in produzione ci sono anagrafiche di minori.
 */

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logOk: vi.fn(),
  logErrore: vi.fn(),
  logEvento: vi.fn(),
  /** Le sedi del perimetro di SCRITTURA. La rotta non ne deve guardare altre. */
  sediAttive: ['sc-1'] as string[],
  /** Quante volte è stato costruito un client: sotto i 2 caratteri, zero. */
  clientCreati: 0,
  alunni: [] as Record<string, unknown>[],
  voci: [] as Record<string, unknown>[],
  studentParents: [] as Record<string, unknown>[],
  legamiRuntime: [] as Record<string, unknown>[],
  parents: [] as Record<string, unknown>[],
  scuole: [] as Record<string, unknown>[],
  /**
   * Errori pilotati. Un `42703` vale SOLO PER LA PRIMA lettura della tabella: è
   * il degrado vero del DB E2E (la colonna non c'è), e il secondo tentativo —
   * senza quella colonna — deve riuscire. Un finto che fallisse sempre non
   * distinguerebbe «ritenta» da «si arrende».
   */
  alunniError: null as { code: string; message: string } | null,
  alunniLetti: 0,
  vociError: null as { code: string; message: string } | null,
  vociLette: 0,
  scuoleError: null as { code: string; message: string } | null,
  /** Errore sui legami genitore↔alunno: rende `pagantiAmmessiPerAlunni` incompleto. */
  legamiError: null as { code: string; message: string } | null,
  /**
   * Ogni lettura risolta: tabella, colonne, filtri, e il TETTO dichiarato.
   *
   * ⚠️ `limite` non è un di più: il finto restituisce comunque la fixture
   * intera, quindi un `.limit()` TOLTO dal codice lascerebbe verde qualunque
   * asserzione sul risultato. PostgREST invece taglia a `db-max-rows` e non lo
   * dice — l'unico modo di provare che il tetto c'è è guardare che sia stato
   * CHIESTO.
   */
  letture: [] as {
    table: string
    cols: string
    filtri: Record<string, unknown>
    or: string | null
    limite: number | null
  }[],
  /** Ogni `from()`, anche quelli che non arrivano a risolversi. */
  from: [] as string[],
  /** Qualunque scrittura: questa rotta non ne fa nessuna. */
  scritture: [] as string[],
  /** Colonne che una fixture non ha e che quindi il finto non sa filtrare. */
  filtriCiechi: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({ resolveScuoleAttive: async () => h.sediAttive }))
vi.mock('@/lib/logging/logger', () => ({
  logOk: h.logOk,
  logErrore: h.logErrore,
  logEvento: h.logEvento,
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => {
    h.clientCreati += 1
    return {
      from: (table: string) => {
        h.from.push(table)
        const filtri: Record<string, unknown> = {}
        const b: Record<string, unknown> = {}
        let espressioneOr: string | null = null
        let tetto: number | null = null
        const ordini: { col: string; crescente: boolean }[] = []
        b.select = (cols?: string) => { b._cols = cols ?? ''; return b }
        b.eq = (c: string, v: unknown) => { filtri[c] = v; return b }
        b.in = (c: string, v: unknown) => { filtri[c] = v; return b }
        /**
         * `.or('nome.ilike.%mar%,cognome.ilike.%mar%,…')` — la disgiunzione
         * vera, interpretata invece che ignorata. Una `.or` finta che lasciasse
         * passare tutto renderebbe verdi sia la ricerca per codice fiscale sia
         * quella senza accenti **senza che la rotta le chieda**: misurerebbe il
         * finto, non il codice.
         */
        b.or = (espr: string) => { espressioneOr = String(espr); return b }
        /**
         * ⚠️ L'ORDINAMENTO SI APPLICA DAVVERO, e non è fedeltà per sport: con un
         * `order` che restituisce solo sé stesso, togliere dalla rotta
         * `.order('cognome').order('nome')` lascerebbe verde QUALUNQUE
         * asserzione sull'elenco, perché l'ordine sarebbe sempre quello della
         * fixture. Misurato: restava verde. Qui i criteri si accumulano come in
         * SQL — prima `cognome`, poi `nome` a parità — e la `sort` è stabile,
         * quindi senza il secondo `.order()` i pari-cognome restano nell'ordine
         * in cui la fixture li ha scritti, che è appunto ciò che si vuole vedere
         * fallire.
         */
        b.order = (col: string, opz?: { ascending?: boolean }) => {
          ordini.push({ col: String(col), crescente: opz?.ascending !== false })
          return b
        }
        b.limit = (n: number) => { tetto = n; return b }
        b.insert = () => { h.scritture.push(`${table}:insert`); return b }
        b.update = () => { h.scritture.push(`${table}:update`); return b }
        b.delete = () => { h.scritture.push(`${table}:delete`); return b }

        const risposta = (): { data: unknown; error: unknown } => {
          switch (table) {
            case 'alunni':
              h.alunniLetti += 1
              if (h.alunniError && (h.alunniError.code !== '42703' || h.alunniLetti === 1)) {
                return { data: null, error: h.alunniError }
              }
              return { data: h.alunni, error: null }
            case 'pagamenti':
              h.vociLette += 1
              if (h.vociError && (h.vociError.code !== '42703' || h.vociLette === 1)) {
                return { data: null, error: h.vociError }
              }
              return { data: h.voci, error: null }
            case 'student_parents':
              // PostgREST su errore non porta dati: `data: null`, mai la
              // fixture. Restituirla renderebbe ogni degrado indistinguibile
              // dal caso felice.
              if (h.legamiError) return { data: null, error: h.legamiError }
              return { data: h.studentParents, error: null }
            case 'legame_genitori_alunni': return { data: h.legamiRuntime, error: null }
            case 'parents': return { data: h.parents, error: null }
            case 'scuole':
              if (h.scuoleError) return { data: null, error: h.scuoleError }
              return { data: h.scuole, error: null }
            default: return { data: [], error: null }
          }
        }

        /**
         * ⚠️ UNA COLONNA CHE LA FIXTURE NON HA È UN FILTRO CHE IL FINTO NON SA
         * APPLICARE, non un filtro soddisfatto: `return true` sbaglierebbe
         * dalla parte permissiva, ed è proprio sui filtri NUOVI — gli unici che
         * nessuno ha ancora provato — che un finto indulgente è cieco.
         */
        const valore = (riga: Record<string, unknown>, col: string): unknown => {
          if (!(col in riga)) {
            const guaio = `${table}: filtro su \`${col}\`, colonna assente dalla fixture`
            if (!h.filtriCiechi.includes(guaio)) h.filtriCiechi.push(guaio)
            throw new Error(guaio)
          }
          return riga[col]
        }
        /**
         * `ilike` come lo intende PostgREST, non come una sottostringa.
         *
         * ⚠️ I JOLLY SI INTERPRETANO, e non è pignoleria: `%` e `_` sono i
         * metacaratteri di `like`, e **`*` vale `%`** (PostgREST lo traduce
         * prima di passarlo a Postgres). Un finto che confrontasse la
         * sottostringa nuda direbbe che `%**%` non trova nessuno, cioè
         * esattamente il contrario di quello che succede sul database: la
         * guardia che scarta i termini di soli jolly sembrerebbe superflua, e il
         * suo controllo negativo (`ro*` deve trovare «Rossini») misurerebbe il
         * finto invece della rotta.
         */
        const ilike = (v: unknown, pattern: string): boolean => {
          if (typeof v !== 'string') return false
          const rx = pattern
            .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
            .replace(/[%*]/g, '.*')
            .replace(/_/g, '.')
          return new RegExp(`^${rx}$`, 'i').test(v)
        }
        const passaOr = (riga: Record<string, unknown>): boolean => {
          if (!espressioneOr) return true
          return String(espressioneOr).split(',').some((t) => {
            const pezzi = t.split('.')
            const col = pezzi[0]
            const op = pezzi[1]
            const val = pezzi.slice(2).join('.')
            const v = valore(riga, col)
            if (op === 'ilike') return ilike(v, val)
            if (op === 'is') return val === 'null' ? v == null : String(v) === val
            if (op === 'in') return val.slice(1, -1).split(',').filter(Boolean).includes(String(v))
            return String(v) === val
          })
        }
        /**
         * ⚠️ ESCE SOLO CIÒ CHE LA `select` HA CHIESTO, e non è pignoleria di
         * fedeltà: senza la proiezione il ritentativo `42703` riceveva ancora
         * la colonna `sconto` dalla fixture, e il test «senza `sconto` vale 0»
         * misurava il finto invece del degrado. I filtri girano PRIMA, sulla
         * riga intera, come in SQL: una `where` non ha bisogno che la colonna
         * sia nella `select`.
         */
        const proietta = (riga: Record<string, unknown>): Record<string, unknown> => {
          const cols = typeof b._cols === 'string' ? b._cols : ''
          if (cols.trim() === '') return riga
          const volute = cols.split(',').map((c) => c.trim()).filter(Boolean)
          const out: Record<string, unknown> = {}
          for (const c of volute) if (c in riga) out[c] = riga[c]
          return out
        }
        const passa = (riga: Record<string, unknown>): boolean =>
          Object.entries(filtri).every(([col, atteso]) => {
            const v = valore(riga, col)
            return Array.isArray(atteso) ? atteso.includes(v) : v === atteso
          }) && passaOr(riga)

        const filtrate = (): { data: unknown; error: unknown } => {
          const r = risposta()
          h.letture.push({
            table,
            cols: typeof b._cols === 'string' ? b._cols : '',
            filtri: { ...filtri },
            or: espressioneOr,
            limite: tetto,
          })
          if (r.error) return r
          if (!Array.isArray(r.data)) {
            const guaio = `${table}: la fixture non è un array, e così nessun filtro le verrebbe applicato`
            if (!h.filtriCiechi.includes(guaio)) h.filtriCiechi.push(guaio)
            throw new Error(guaio)
          }
          // Filtro → ORDINE → proiezione, nell'ordine di SQL: si ordina sulla
          // riga intera, perché una `order by` non ha bisogno che la colonna sia
          // nella `select` (e il ritentativo `42703` ordina su `cognome` mentre
          // chiede una proiezione più corta).
          const selezionate = (r.data as Record<string, unknown>[]).filter(passa)
          const ordinate = ordini.length === 0 ? selezionate : [...selezionate].sort((x, y) => {
            for (const { col, crescente } of ordini) {
              const vx = valore(x, col)
              const vy = valore(y, col)
              const sx = vx == null ? '' : String(vx)
              const sy = vy == null ? '' : String(vy)
              if (sx !== sy) return (sx < sy ? -1 : 1) * (crescente ? 1 : -1)
            }
            return 0
          })
          const righe = ordinate.map(proietta)
          // ⚠️ IL `.limit()` TAGLIA DAVVERO: è l'unico modo perché il test del
          // troncamento misuri la rotta (che chiede `limite + 1`) invece della
          // lunghezza della fixture.
          return { data: tetto == null ? righe : righe.slice(0, tetto), error: null }
        }

        b.maybeSingle = async () => {
          const r = filtrate()
          return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error }
        }
        b.then = (resolve: (v: unknown) => unknown) => {
          const r = filtrate()
          return resolve({ data: Array.isArray(r.data) ? r.data : [], error: r.error })
        }
        return b
      },
    }
  },
}))

import { GET } from '@/app/api/pagamenti/riconciliazione/alunni/route'

const BIMBO_IN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
const BIMBO_FUORI = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'
const BIMBO_RITIRATO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3'
const BIMBO_TERZO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4'
const GENITORE = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1'
/** Codice fiscale INVENTATO: forma plausibile, persona inesistente. */
const CF_IN = 'RSSMRA20A01H501Z'
/**
 * Anch'esso INVENTATO, e scelto apposta perché contiene le lettere del cognome
 * «Rossini»: un `ross` digitato lo aggancia da tutt'e due le parti, ed è il solo
 * modo per misurare il `!perNome` di `trovato_per_cf` invece di sfiorarlo.
 */
const CF_OMONIMO = 'ROSSNI20A01H501Z'

const get = (qs: string) =>
  GET(
    new Request(`http://localhost/api/pagamenti/riconciliazione/alunni?${qs}`, {
      headers: { 'x-user-id': 'u1' },
    }) as never,
  )

const corpo = async (res: Response) => (await res.json()) as {
  success?: boolean
  error?: string
  codice?: string
  troncato?: boolean
  sedi?: Record<string, string>
  data?: {
    alunno_id: string
    nome: string
    classe_sezione: string | null
    scuola_id: string | null
    attivo: boolean
    voci_aperte: number | null
    residuo_aperto: number | null
    ha_pagante: boolean | null
    trovato_per_cf: boolean
  }[]
}

const letteDa = (tabella: string) => h.letture.filter((l) => l.table === tabella)

beforeEach(() => {
  vi.clearAllMocks()
  h.letture = []
  h.from = []
  h.scritture = []
  h.filtriCiechi = []
  h.clientCreati = 0
  h.alunniError = null
  h.alunniLetti = 0
  h.vociError = null
  h.vociLette = 0
  h.scuoleError = null
  h.legamiError = null
  h.sediAttive = ['sc-1']
  h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria', scuola_id: 'sc-1' } })
  h.alunni = [
    {
      id: BIMBO_IN,
      nome: 'Mario',
      cognome: 'Rossini',
      classe_sezione: 'Primavera A',
      scuola_id: 'sc-1',
      stato: 'iscritto',
      codice_fiscale: CF_IN,
    },
    // Stesso cognome, ALTRO PLESSO: è la riga su cui il perimetro si vede.
    {
      id: BIMBO_FUORI,
      nome: 'Luca',
      cognome: 'Rossini',
      classe_sezione: 'Grandi B',
      scuola_id: 'sc-2',
      stato: 'iscritto',
      codice_fiscale: 'RSSLCU20A01H501Z',
    },
  ]
  h.voci = [
    // Due voci con residuo + un contenitore `padre` (che NON si conta) + una
    // già saldata (residuo 0). Lo sconto entra nel calcolo: 100 − 10 − 40 = 50.
    { alunno_id: BIMBO_IN, importo: 100, importo_pagato: 40, sconto: 10, stato: 'parziale', tipo: 'figlia' },
    { alunno_id: BIMBO_IN, importo: 30, importo_pagato: 0, sconto: 0, stato: 'da_pagare', tipo: null },
    { alunno_id: BIMBO_IN, importo: 500, importo_pagato: 0, sconto: 0, stato: 'da_pagare', tipo: 'padre' },
    { alunno_id: BIMBO_IN, importo: 20, importo_pagato: 20, sconto: 0, stato: 'pagato', tipo: null },
  ]
  h.studentParents = [{ parent_id: GENITORE, student_id: BIMBO_IN, relation_type: 'mother' }]
  h.legamiRuntime = []
  h.parents = [{ id: GENITORE, auth_user_id: null }]
  h.scuole = [{ id: 'sc-1', nome: 'Kidville Uno' }, { id: 'sc-2', nome: 'Kidville Due' }]
})

afterEach(() => {
  expect(h.filtriCiechi, 'Filtri che il finto non ha saputo applicare').toEqual([])
  expect(h.scritture, 'Questa rotta è in sola lettura').toEqual([])
})

describe('GET /api/pagamenti/riconciliazione/alunni', () => {
  it('sotto i due caratteri risponde vuoto e NON interroga il database', async () => {
    const res = await get('q=r')
    expect(res.status).toBe(200)
    const b = await corpo(res)
    expect(b.data).toEqual([])
    expect(b.troncato).toBe(false)
    // 🔴 La busta è UNA: anche il ritorno vuoto è un SUCCESSO dichiarato, non
    // un corpo più corto. È su `success` che `esitoFetch` decide se la pagina
    // mostra un elenco o un errore, e qui la risposta giusta è «elenco, vuoto».
    expect(b.success).toBe(true)
    // La spia, non la fiducia: nessun client costruito, nessun `from()`.
    expect(h.clientCreati).toBe(0)
    expect(h.from).toEqual([])
  })

  it('senza `q` risponde vuoto e NON interroga il database', async () => {
    const res = await get('userId=u1')
    expect(res.status).toBe(200)
    expect((await corpo(res)).data).toEqual([])
    expect(h.from).toEqual([])
  })

  it('accetta i parametri di troppo che la pagina appende (niente `.strict()`)', async () => {
    const res = await get('q=rossini&userId=u1&_=1730000000')
    expect(res.status).toBe(200)
  })

  it('il perimetro è quello di `resolveScuoleAttive`: l’altro plesso non compare', async () => {
    const res = await get('q=rossini')
    const b = await corpo(res)
    expect(b.data?.map((a) => a.alunno_id)).toEqual([BIMBO_IN])
    // ⚠️ Il filtro di sede sta NELLA QUERY, non a valle: se un giorno migrasse
    // in JavaScript questa asserzione diventerebbe rossa, ed è il punto.
    expect(letteDa('alunni')[0].filtri.scuola_id).toEqual(['sc-1'])
  })

  it('con scope vuoto nega: elenco vuoto, nessuna lettura di alunni, e UNA RIGA DI LOG', async () => {
    h.sediAttive = []
    const res = await get('q=rossini')
    expect(res.status).toBe(200)
    expect((await corpo(res)).data).toEqual([])
    expect(letteDa('alunni')).toHaveLength(0)
    /**
     * 🔴 LA SPIA, non la buona volontà. Questo è l'unico ramo in cui la rotta
     * NEGA, e fino al terzo giro negava in silenzio appoggiandosi a un `warn`
     * che `resolveScuoleAttive` emette solo per il cookie con sedi non più
     * accessibili: quando è `scuoleDiUtente` a rispondere `[]` (un non-admin
     * con `scuola_id` nullo) da `scope.ts` non esce niente. Risultato:
     * l'operatrice cercava, non trovava, e non restava traccia da nessuna
     * parte — «non l'ho trovato» e «non ho potuto cercare» di nuovo
     * indistinguibili, che è la confusione che questa rotta esiste per togliere.
     * `sedi: 0` è ciò che distingue questa riga da quella del «nessun risultato».
     */
    expect(h.logEvento).toHaveBeenCalledWith(
      'pagamento', 'info',
      expect.objectContaining({ esito: 'ricerca-alunni', n: 0, troncato: false, sedi: 0 }),
    )
  })

  it('trova per CODICE FISCALE, e il codice fiscale NON esce dalla risposta', async () => {
    const res = await get(`q=${CF_IN}`)
    const b = await corpo(res)
    expect(b.data?.map((a) => a.alunno_id)).toEqual([BIMBO_IN])
    expect(b.data?.[0].trovato_per_cf).toBe(true)
    // 🔴 Sul corpo INTERO: una chiave nuova che ricopiasse il CF passerebbe
    // sotto un'asserzione campo per campo.
    expect(JSON.stringify(b)).not.toContain(CF_IN)
  })

  it('trovato per NOME non è trovato per codice fiscale', async () => {
    const b = await corpo(await get('q=rossini'))
    expect(b.data?.[0].trovato_per_cf).toBe(false)
  })

  /**
   * ⚠️ IL CASO CHE FA MALE, e l'unico che misuri davvero `perNome`: il termine
   * corrisponde SIA al cognome SIA al codice fiscale, e al cognome solo DOPO la
   * normalizzazione (in anagrafica la `R` è maiuscola, chi cerca scrive minuscolo).
   *
   * Senza questa riga il `!perNome` era decorazione, e provato: sostituendo
   * `testoCorrisponde` con un `includes` grezzo — proprio ciò che il commento
   * della rotta dichiara di aver evitato — oppure togliendo del tutto il
   * `!perNome`, tutti gli altri casi restavano verdi, perché in ognuno il codice
   * fiscale non c'entrava niente. `trovato_per_cf` è l'unica cosa del codice
   * fiscale di un minore che attraversa il confine: la sua semantica va provata,
   * non dichiarata.
   */
  it('trovato per nome RESTA per nome anche se il codice fiscale contiene il termine', async () => {
    h.alunni = [{
      id: BIMBO_IN,
      nome: 'Mario',
      cognome: 'Rossini',
      classe_sezione: null,
      scuola_id: 'sc-1',
      stato: 'iscritto',
      codice_fiscale: CF_OMONIMO,
    }]
    const b = await corpo(await get('q=ross'))
    expect(b.data?.map((a) => a.alunno_id)).toEqual([BIMBO_IN])
    // `trovato_per_cf` vuol dire «non si chiama così, ma il codice è suo». Qui
    // si chiama proprio così: un `true` direbbe all'operatrice che ha agganciato
    // un codice fiscale che non ha mai digitato.
    expect(b.data?.[0].trovato_per_cf).toBe(false)
    expect(JSON.stringify(b)).not.toContain(CF_OMONIMO)
  })

  it('il codice fiscale si trova anche digitato in MINUSCOLO', async () => {
    // `testoCorrisponde` normalizza le maiuscole da tutt'e due i lati; un
    // `includes` grezzo no, e nessuno digita un codice fiscale in stampatello.
    const b = await corpo(await get(`q=${CF_IN.toLowerCase()}`))
    expect(b.data?.map((a) => a.alunno_id)).toEqual([BIMBO_IN])
    expect(b.data?.[0].trovato_per_cf).toBe(true)
  })

  it('un termine di soli segni diacritici non diventa «qualunque riga»', async () => {
    // U+0300 + U+0301: due caratteri, quindi la guardia del minimo NON scatta,
    // e `senzaAccenti` li riduce a stringa vuota. Senza lo scarto della forma
    // vuota l'`or` conterrebbe `nome.ilike.%%`, che in SQL è «tutte le righe».
    const res = await get('q=%CC%80%CC%81')
    expect(res.status).toBe(200)
    const or = letteDa('alunni')[0].or ?? ''
    // 🔴 Sarebbero nome, cognome e classe di ogni bambino del perimetro fino al
    // limite, per un termine che di contenuto non ne ha.
    expect(or).not.toContain('ilike.%%')
    expect(or.split(',')).toHaveLength(3)
    expect((await corpo(res)).data).toEqual([])
  })

  it('un termine di soli JOLLY non diventa «qualunque riga»', async () => {
    // `**` ha due caratteri, quindi la guardia del minimo NON scatta, e
    // `ripulisciTermineRicerca` non tocca l'asterisco (è condivisa con
    // `admin/search`, dove `*` è un carattere come un altro). Ma dentro `ilike`
    // PostgREST lo legge come `%`: `nome.ilike.%**%` vale `%%%%`, cioè tutte le
    // righe del perimetro fino al limite — venti nomi, cognomi e classi di
    // minori per un termine che di contenuto non ne ha.
    const res = await get('q=**')
    expect(res.status).toBe(200)
    expect((await corpo(res)).data).toEqual([])
    // 🔴 Non «zero risultati»: proprio nessuna lettura dell'anagrafica.
    expect(letteDa('alunni')).toHaveLength(0)
  })

  it('un jolly NON ruba il posto a un carattere: `ro*` cerca comunque `ro`', async () => {
    // Il controllo negativo del caso qui sopra: si scarta la forma senza
    // CONTENUTO, non la forma che contiene un asterisco. Altrimenti sarebbe una
    // guardia che nega più di quanto le è stato chiesto, e nessuno se ne
    // accorgerebbe se non cercando un cognome corto.
    const b = await corpo(await get('q=ro*'))
    expect(b.data?.map((a) => a.alunno_id)).toEqual([BIMBO_IN])
    expect(letteDa('alunni')[0].or ?? '').toContain('cognome.ilike.%ro*%')
  })

  it('cerca anche con il termine SENZA ACCENTI (due forme, nessuna migrazione)', async () => {
    h.alunni = [{
      id: BIMBO_IN,
      nome: 'Niccolo',
      cognome: 'Bianchini',
      classe_sezione: null,
      scuola_id: 'sc-1',
      stato: 'iscritto',
      codice_fiscale: null,
    }]
    // In anagrafica il nome è senza accento; chi cerca lo scrive con l'accento.
    // `ilike` non compone i caratteri: senza la seconda forma non lo troverebbe.
    const b = await corpo(await get('q=Niccol%C3%B2'))
    expect(b.data?.map((a) => a.alunno_id)).toEqual([BIMBO_IN])
    const or = letteDa('alunni')[0].or ?? ''
    expect(or).toContain('nome.ilike.%Niccolò%')
    expect(or).toContain('nome.ilike.%Niccolo%')
  })

  it('un bambino RITIRATO compare, e lo dichiara con `attivo: false`', async () => {
    h.alunni = [{
      id: BIMBO_RITIRATO,
      nome: 'Anna',
      cognome: 'Rossini',
      classe_sezione: null,
      scuola_id: 'sc-1',
      stato: 'ritirato',
      codice_fiscale: null,
    }]
    const b = await corpo(await get('q=rossini'))
    // È la divergenza da `legami-familiari?tipo=alunni`, che lo escluderebbe:
    // un bonifico che salda l'arretrato di chi ha lasciato è il caso normale.
    expect(b.data?.map((a) => a.alunno_id)).toEqual([BIMBO_RITIRATO])
    expect(b.data?.[0].attivo).toBe(false)
  })

  /**
   * ─── LA FORMA DELLA RIGA: PROVATA, NON DICHIARATA ───────────────────────────
   *
   * Fino al quarto giro questo file asseriva quasi ovunque i soli `alunno_id`, e
   * quattro campi del contratto restavano verdi anche RIMPIAZZATI: `nome` con la
   * costante `'Bambino senza nome'`, `nome` con l'ordine invertito in «Nome
   * Cognome», `classe_sezione` e `scuola_id` con `null`. Cioè la suite diceva
   * `28 passed` sia col codice giusto sia col codice rotto, che per la regola di
   * questo repo è lo stesso di non avere il test.
   *
   * Non sono campi qualunque: `nome` è quello che la testata della rotta chiama
   * «l'unico dato identificante che questa schermata richiede davvero» — è la
   * sola cosa di un minore che attraversa il confine, ed è ciò su cui si sceglie
   * un bambino prima di incassargli un bonifico; `scuola_id` è la chiave con cui
   * la pagina pesca il plesso dalla mappa `sedi`, e un `null` lì lo farebbe
   * sparire dalla schermata a suite verde.
   */
  it('la riga porta «Cognome Nome», la classe e il plesso: non solo un uuid', async () => {
    const b = await corpo(await get('q=rossini'))
    // L'altra metà del contratto della busta, sul ramo PIENO: `success: true`
    // accompagna `data` sempre, non «quando c'è qualcosa dentro».
    expect(b.success).toBe(true)
    expect(b.data?.[0]).toMatchObject({
      alunno_id: BIMBO_IN,
      // 🔴 «Cognome Nome», in QUEST'ORDINE: è come si legge un elenco di
      // bambini, ed è lo stesso ordine con cui l'elenco è ordinato.
      nome: 'Rossini Mario',
      classe_sezione: 'Primavera A',
      scuola_id: 'sc-1',
      attivo: true,
    })
  })

  it('un’anagrafica senza nome né cognome non esce vuota: «Bambino senza nome»', async () => {
    // Capita, e non è un caso di scuola: una domanda importata a metà. Il
    // bambino si trova lo stesso per codice fiscale, e la sua riga deve restare
    // sceglibile — una stringa vuota in un elenco è una riga che non si clicca.
    h.alunni = [{
      id: BIMBO_IN,
      nome: null,
      cognome: null,
      classe_sezione: null,
      scuola_id: 'sc-1',
      stato: 'iscritto',
      codice_fiscale: CF_IN,
    }]
    const b = await corpo(await get(`q=${CF_IN}`))
    expect(b.data?.[0].nome).toBe('Bambino senza nome')
    expect(b.data?.[0].trovato_per_cf).toBe(true)
    expect(JSON.stringify(b)).not.toContain(CF_IN)
  })

  it('col solo nome in anagrafica non scatta il ripiego (e non resta uno spazio)', async () => {
    h.alunni = [{
      id: BIMBO_IN,
      nome: 'Mario',
      cognome: null,
      classe_sezione: null,
      scuola_id: 'sc-1',
      stato: 'iscritto',
      codice_fiscale: null,
    }]
    const b = await corpo(await get('q=mario'))
    // «Manca il cognome» e «manca tutto» sono due cose diverse: il ripiego vale
    // solo per la seconda.
    expect(b.data?.[0].nome).toBe('Mario')
  })

  it('l’elenco esce ORDINATO per cognome e poi per nome, non come sta nel database', async () => {
    // La fixture è scritta al contrario APPOSTA: senza `.order('cognome')` la
    // rotta ripeterebbe quest'ordine, e senza il secondo `.order('nome')` i due
    // Rossini resterebbero Mario prima di Anna (la `sort` è stabile). Venti
    // bambini in ordine sparso si leggono due volte, e si sbaglia riga.
    h.alunni = [
      {
        id: BIMBO_TERZO,
        nome: 'Mario',
        cognome: 'Rossini',
        classe_sezione: null,
        scuola_id: 'sc-1',
        stato: 'iscritto',
        codice_fiscale: null,
      },
      {
        id: BIMBO_IN,
        nome: 'Anna',
        cognome: 'Rossini',
        classe_sezione: null,
        scuola_id: 'sc-1',
        stato: 'iscritto',
        codice_fiscale: null,
      },
      {
        id: BIMBO_RITIRATO,
        nome: 'Zoe',
        cognome: 'Bianchini',
        classe_sezione: null,
        scuola_id: 'sc-1',
        // Ritirata, e prima in elenco lo stesso: l'ordine è alfabetico, non per
        // stato (vedi la decisione 5).
        stato: 'ritirato',
        codice_fiscale: null,
      },
    ]
    const b = await corpo(await get('q=ini'))
    expect(b.data?.map((a) => a.alunno_id)).toEqual([BIMBO_RITIRATO, BIMBO_IN, BIMBO_TERZO])
    expect(b.data?.map((a) => a.nome)).toEqual(['Bianchini Zoe', 'Rossini Anna', 'Rossini Mario'])
  })

  /**
   * ─── NIENTE N+1: SI CONTANO LE LETTURE, NON SI SPERA ────────────────────────
   *
   * La specifica lo chiede alla lettera — «leggili sui ≤ 20 id risultanti, non
   * uno per uno» — e la rotta lo fa, ma fino al quinto giro niente lo teneva
   * fermo: misurato, sostituendo la sola `.in('alunno_id', ids)` con una lettura
   * per ciascun id (risultati concatenati), e la sola
   * `pagantiAmmessiPerAlunni(supabase, ids, …)` con una chiamata per ciascun id,
   * la suite restava verde tutt'e due le volte. Le uniche asserzioni sulle
   * letture erano sul TETTO e sulle COLONNE della prima, che venti letture
   * lasciano intatti.
   *
   * 🔴 Venti andate e ritorno al posto di una, su una schermata che si ridisegna
   * a ogni tasto battuto: è il guasto «volume» che questo repo ha già pagato una
   * volta (2,23 M richieste al giorno da dieci polling a schermo spento).
   *
   * ⚠️ Un N+1 non è «più di una lettura»: è una lettura che CRESCE col numero
   * dei risultati. `student_parents`, per dire, se ne prende due legittime —
   * `pagantiAmmessiPerAlunni` la legge diretta e `getGenitoriDiAlunniEsito` la
   * rilegge dentro il ponte runtime — ed entrambe stanno su `.in(…, tutti gli
   * id)`. Cablare «due» qui sarebbe fissare le viscere di un altro modulo; si
   * misura invece la proprietà che conta: **lo stesso conteggio di letture con
   * tre bambini e con uno solo**. Un N+1 fa divergere quei due numeri, una
   * lettura in blocco no, e nessuna riscrittura interna del modulo condiviso
   * rende questo test rosso per sbaglio.
   *
   * Più le due cose che un conteggio da solo non vede: che ogni lettura porti
   * TUTTI gli id (una sola lettura che ne dimenticasse due sarebbe peggio di
   * venti), e che ogni riga uscita abbia poi il suo.
   */
  it('voci e paganti: UNA lettura per tabella sui tre id, non una per bambino', async () => {
    h.alunni = [
      {
        id: BIMBO_TERZO,
        nome: 'Mario',
        cognome: 'Rossini',
        classe_sezione: null,
        scuola_id: 'sc-1',
        stato: 'iscritto',
        codice_fiscale: null,
      },
      {
        id: BIMBO_IN,
        nome: 'Anna',
        cognome: 'Rossini',
        classe_sezione: null,
        scuola_id: 'sc-1',
        stato: 'iscritto',
        codice_fiscale: null,
      },
      {
        id: BIMBO_RITIRATO,
        nome: 'Zoe',
        cognome: 'Bianchini',
        classe_sezione: null,
        scuola_id: 'sc-1',
        stato: 'iscritto',
        codice_fiscale: null,
      },
    ]
    // Due fratelli con una voce aperta a testa e lo stesso genitore; la terza
    // bambina non ha né voci né adulti collegati.
    h.voci = [
      { alunno_id: BIMBO_IN, importo: 50, importo_pagato: 0, sconto: 0, stato: 'da_pagare', tipo: null },
      { alunno_id: BIMBO_TERZO, importo: 70, importo_pagato: 0, sconto: 0, stato: 'da_pagare', tipo: null },
    ]
    h.studentParents = [
      { parent_id: GENITORE, student_id: BIMBO_IN, relation_type: 'mother' },
      { parent_id: GENITORE, student_id: BIMBO_TERZO, relation_type: 'mother' },
    ]
    const b = await corpo(await get('q=ini'))
    const usciti = [BIMBO_RITIRATO, BIMBO_IN, BIMBO_TERZO]
    expect(b.data?.map((a) => a.alunno_id)).toEqual(usciti)

    // 🔴 UNA sola lettura delle voci — questa sta nella rotta, e il ramo `42703`
    // non è scattato — e con dentro TUTTI gli id: è la forma che un N+1 non ha.
    expect(letteDa('pagamenti')).toHaveLength(1)
    expect(letteDa('pagamenti')[0].filtri.alunno_id).toEqual(usciti)
    // Il ponte se ne prende due (vedi sopra), e TUTTE E DUE portano i tre id.
    expect(letteDa('student_parents').length).toBeGreaterThan(0)
    for (const l of letteDa('student_parents')) expect(l.filtri.student_id).toEqual(usciti)

    // E la lettura in blocco non ha perso nessuno per strada: ogni riga porta il suo.
    expect(b.data?.map((a) => a.voci_aperte)).toEqual([0, 1, 1])
    expect(b.data?.map((a) => a.residuo_aperto)).toEqual([0, 50, 70])
    expect(b.data?.map((a) => a.ha_pagante)).toEqual([false, true, true])

    // 🔴 IL CONFRONTO CHE DEFINISCE L'N+1: le stesse tabelle, con un bambino
    // solo, devono essere lette lo STESSO numero di volte. Un ciclo per id fa
    // divergere questi due conteggi; una lettura in blocco no.
    const perTabella = () => {
      const m: Record<string, number> = {}
      for (const l of h.letture) m[l.table] = (m[l.table] ?? 0) + 1
      return m
    }
    const conTre = perTabella()
    h.letture = []
    h.alunni = h.alunni.filter((a) => a.id === BIMBO_IN)
    await get('q=ini')
    expect(perTabella()).toEqual(conTre)
  })

  /**
   * ⚠️ UNA DIFESA CHE NESSUN TEST PUÒ VEDER FALLIRE NON È UNA DIFESA: È UN
   * COMMENTO — la stessa regola che questo lotto ha scritto in
   * `__tests__/lib/validation/ricerca-testo.test.ts`. La rotta scarta le righe di
   * anagrafica senza `id` (`.filter((a) => typeof a.id === 'string')`), e
   * misurato quel filtro si poteva togliere del tutto a suite verde.
   *
   * 🔴 Senza, un `null` finirebbe in `alunno_id` — una riga cliccabile che
   * comporrebbe un bonifico contro nessun bambino — e dentro le due letture a
   * valle, che andrebbero a cercare le voci aperte di un id che non esiste.
   */
  it('una riga di anagrafica SENZA id non esce, e non entra nelle letture a valle', async () => {
    h.alunni = [
      // Ordinata PRIMA dell'altra (Aurora < Mario): se il filtro non ci fosse,
      // sarebbe la prima riga dell'elenco.
      {
        id: null,
        nome: 'Aurora',
        cognome: 'Rossini',
        classe_sezione: null,
        scuola_id: 'sc-1',
        stato: 'iscritto',
        codice_fiscale: null,
      },
      {
        id: BIMBO_IN,
        nome: 'Mario',
        cognome: 'Rossini',
        classe_sezione: null,
        scuola_id: 'sc-1',
        stato: 'iscritto',
        codice_fiscale: null,
      },
    ]
    const b = await corpo(await get('q=rossini'))
    expect(b.data?.map((a) => a.alunno_id)).toEqual([BIMBO_IN])
    expect(letteDa('pagamenti')[0].filtri.alunno_id).toEqual([BIMBO_IN])
  })

  it('conta voci e residuo con `residuoEffettivo`: niente contenitori, niente saldate', async () => {
    const b = await corpo(await get('q=rossini'))
    // (100 − 10 − 40) + 30 = 80, su DUE voci: il `padre` da 500 e la saldata no.
    expect(b.data?.[0].voci_aperte).toBe(2)
    expect(b.data?.[0].residuo_aperto).toBe(80)
    expect(b.data?.[0].ha_pagante).toBe(true)
    expect(b.sedi).toEqual({ 'sc-1': 'Kidville Uno' })
  })

  it('un bambino senza voci aperte e senza genitori collegati esce lo stesso', async () => {
    h.voci = []
    h.studentParents = []
    const b = await corpo(await get('q=rossini'))
    expect(b.data?.[0].voci_aperte).toBe(0)
    expect(b.data?.[0].residuo_aperto).toBe(0)
    expect(b.data?.[0].ha_pagante).toBe(false)
  })

  it('il residuo è DENARO: due decimali, non la coda della virgola mobile', async () => {
    // La fixture di sopra usa solo interi, e su interi l'arrotondamento non si
    // vede: si può togliere e la suite resta verde. Qui invece la somma la
    // produce davvero — 0.1 + 0.2 in virgola mobile fa 0.30000000000000004 — e
    // quella coda finirebbe su una schermata che incassa, dove il numero letto
    // dall'operatrice diventa l'importo di un bonifico e poi di una fattura.
    h.voci = [
      { alunno_id: BIMBO_IN, importo: 0.1, importo_pagato: 0, sconto: 0, stato: 'da_pagare', tipo: null },
      { alunno_id: BIMBO_IN, importo: 0.2, importo_pagato: 0, sconto: 0, stato: 'da_pagare', tipo: null },
    ]
    const b = await corpo(await get('q=rossini'))
    expect(b.data?.[0].voci_aperte).toBe(2)
    expect(b.data?.[0].residuo_aperto).toBe(0.3)
  })

  it('dichiara il TRONCAMENTO invece di tacerlo', async () => {
    h.alunni = [BIMBO_IN, BIMBO_RITIRATO, BIMBO_TERZO].map((id, i) => ({
      id,
      nome: `Nome${i}`,
      cognome: 'Rossini',
      classe_sezione: null,
      scuola_id: 'sc-1',
      stato: 'iscritto',
      codice_fiscale: null,
    }))
    const b = await corpo(await get('q=rossini&limite=2'))
    expect(b.data).toHaveLength(2)
    // Chiede `limite + 1` proprio per poterlo dire: un elenco troncato che tace
    // fa concludere «quel bambino non c'è».
    expect(b.troncato).toBe(true)
    expect(letteDa('alunni')[0].cols).toContain('classe_sezione')
    // `limite + 1` CHIESTO al database: è l'unico modo di sapere che c'era una
    // riga in più, e il finto da solo non lo proverebbe (restituisce la fixture).
    expect(letteDa('alunni')[0].limite).toBe(3)
  })

  it('senza troncamento lo dice: `troncato: false`', async () => {
    const b = await corpo(await get('q=rossini&limite=2'))
    expect(b.troncato).toBe(false)
  })

  it('ESATTAMENTE `limite` righe NON è un troncamento (il confine, non solo un lato)', async () => {
    // Il caso qui sopra ha una riga sola dentro il perimetro, e il caso a tre
    // righe ne ha una di troppo: nessuno dei due passa per `trovati.length ===
    // limite`, che è l'UNICO punto in cui `> limite` e `>= limite` divergono.
    // Misurato: con `>=` al posto di `>` la suite restava verde, e in
    // produzione ogni elenco pieno fino all'orlo avrebbe detto «ce n'è ancora»
    // a chi invece li aveva davanti tutti.
    h.alunni = [BIMBO_IN, BIMBO_TERZO].map((id, i) => ({
      id,
      nome: `Nome${i}`,
      cognome: 'Rossini',
      classe_sezione: null,
      scuola_id: 'sc-1',
      stato: 'iscritto',
      codice_fiscale: null,
    }))
    const b = await corpo(await get('q=rossini&limite=2'))
    expect(b.data).toHaveLength(2)
    expect(b.troncato).toBe(false)
    // La riga in più è stata CHIESTA lo stesso: è così che si sa che non c'era.
    expect(letteDa('alunni')[0].limite).toBe(3)
  })

  it('un `limite` fuori scala è un 400 di zod, non un elenco a sorpresa', async () => {
    expect((await get('q=rossini&limite=500')).status).toBe(400)
  })

  /**
   * ─── IL TETTO SI PROVA AL CONFINE, NON A DUECENTO PASSI ─────────────────────
   *
   * `limite=500` è fuori scala col tetto a 20 e lo resta col tetto a 200: quel
   * caso da solo lascia decuplicare in silenzio quante anagrafiche di minori
   * attraversano il confine in una risposta. Misurato: `LIMITE_MASSIMO = 200`
   * teneva la suite verde. Il 21 no — è il primo valore che il contratto
   * (`limite=1..20`) rifiuta, ed è l'unico che vede quella mutazione.
   *
   * L'altro lato del confine conta quanto questo: un tetto abbassato per sbaglio
   * (19) non si vedrebbe senza un caso che pretende `limite=20` accettato.
   *
   * E il contratto è `1..20`, quindi i lati sono TRE: c'è anche il MINIMO, che
   * era scoperto. Misurato: `min(1)` → `min(0)` lasciava la suite verde, e con
   * `limite=0` la rotta chiederebbe `.limit(1)`, taglierebbe con `slice(0, 0)` e
   * risponderebbe `data: []` con `troncato: true` — «non ho trovato nessuno» e
   * «ce n'era dell'altro» nella stessa busta, cioè esattamente la coppia di
   * messaggi contraddittori che questa rotta è costruita per non produrre.
   */
  it('il `limite` è 1..20: il 21 e lo 0 sono 400, il 20 passa e chiede 21 righe', async () => {
    expect((await get('q=rossini&limite=21')).status).toBe(400)
    expect((await get('q=rossini&limite=0')).status).toBe(400)
    // Un 400 di zod non arriva al database: la lettura qui sotto è la prima.
    expect(letteDa('alunni')).toHaveLength(0)
    const res = await get('q=rossini&limite=20')
    expect(res.status).toBe(200)
    // Sempre `limite + 1`, anche all'orlo: è così che si sa se c'era dell'altro.
    expect(letteDa('alunni')[0].limite).toBe(21)
  })

  /**
   * ─── E CHI NON CHIEDE NIENTE? IL «LIMITE» PREDEFINITO ───────────────────────
   *
   * Stessa grandezza della decisione 14, vista dall'altro lato: il tetto dice
   * quanto può chiedere un chiamante, il DEFAULT quanto riceve chi il parametro
   * non lo manda. Ed è il caso normale — oggi di chiamanti non ce n'è nessuno
   * (`grep -rn 'riconciliazione/alunni' src/ e2e/` non trova una riga fuori
   * dalla rotta stessa), e il primo che arriverà potrà benissimo ometterlo.
   *
   * Misurato: `default(10)` → `default(20)` lasciava la suite verde. Il default
   * era pinzato solo dal basso, e per caso — `default(1)` è rosso perché due
   * fixture hanno tre righe — quindi da 3 a 20 si poteva muovere in silenzio,
   * cioè raddoppiare quante anagrafiche di minori escono in una sola risposta.
   */
  it('senza `limite` si chiedono 11 righe: il default è 10, più la riga-spia', async () => {
    await get('q=rossini')
    // `10 + 1` in un colpo solo: uccide sia l'abbassamento sia il raddoppio.
    expect(letteDa('alunni')[0].limite).toBe(11)
  })

  /**
   * ─── IL TETTO DI LUNGHEZZA DEL TERMINE, LA QUARTA DIFESA SILENZIOSA ─────────
   *
   * `q: z.string().max(200)` → `q: z.string()` lasciava la suite verde: una
   * difesa che nessun test poteva vedere fallire, cioè un commento. È la
   * categoria della decisione 15, che ne elencava tre dimenticando questa.
   */
  it('un `q` oltre i 200 caratteri è un 400 e non tocca il database (a 200 passa)', async () => {
    const lungo = 'r'.repeat(201)
    expect((await get(`q=${lungo}`)).status).toBe(400)
    expect(letteDa('alunni')).toHaveLength(0)
    // Il confine, non un valore lontano: a 200 si cerca per davvero.
    expect((await get(`q=${'r'.repeat(200)}`)).status).toBe(200)
    expect(letteDa('alunni')).toHaveLength(1)
  })

  it('NEL LOG non finisce mai il termine cercato', async () => {
    h.alunni = [{
      id: BIMBO_IN,
      nome: 'Zxqwerti',
      cognome: 'Zxqwerti',
      classe_sezione: null,
      scuola_id: 'sc-1',
      stato: 'iscritto',
      codice_fiscale: null,
    }]
    await get('q=zxqwerti')
    const scritto = JSON.stringify([
      h.logEvento.mock.calls, h.logErrore.mock.calls, h.logOk.mock.calls,
    ])
    // 🔴 `app_log` si conserva 30 giorni ed è interrogabile in SQL: un cognome
    // (o un codice fiscale) di minore lì dentro ci resta.
    expect(scritto).not.toContain('zxqwerti')
    expect(scritto).not.toContain('Zxqwerti')
    // E nemmeno gli uuid dei bambini.
    expect(scritto).not.toContain(BIMBO_IN)
    // Ma i CONTEGGI sì: senza, «nessun risultato» e «non è partito niente»
    // sarebbero la stessa riga. (Che siano CONTATI e non cablati lo misura il
    // caso qui sotto: qui valgono 1, false e 1, cioè tre costanti.)
    const riga = h.logEvento.mock.calls.find((c) => (c[2] as { esito?: string })?.esito === 'ricerca-alunni')
    expect(riga?.[2]).toMatchObject({ n: 1, troncato: false, sedi: 1 })
  })

  /**
   * ─── I TRE CONTEGGI DEL LOG SONO CONTATI, NON TRE COSTANTI ──────────────────
   *
   * La specifica elenca `n`, `troncato` e `sedi` come il contenuto obbligatorio
   * di questa riga — l'unico che resta, visto che il termine e gli uuid dei
   * bambini non ci entrano. Ma finché l'unico caso che li guardava aveva un
   * risultato, una sede e nessun troncamento, i tre valori coincidevano con tre
   * costanti: misurato, `n: data.length → n: 1`, `sedi: sedi.length → sedi: 1` e
   * `troncato → false` lasciavano la suite verde tutte e tre.
   *
   * 🔴 In produzione un `n` cablato rende `app_log` cieco proprio sulla domanda
   * per cui la riga esiste: quante anagrafiche di minori sono uscite da questa
   * porta, e se chi cercava stava guardando un elenco tagliato.
   *
   * Qui i tre valori sono DIVERSI da quelle costanti: due sedi nel perimetro,
   * tre bambini che corrispondono, due mostrati.
   */
  it('i conteggi del log sono contati: due sedi, tre trovati, due mostrati', async () => {
    h.sediAttive = ['sc-1', 'sc-2']
    h.alunni = [
      {
        id: BIMBO_IN,
        nome: 'Anna',
        cognome: 'Rossini',
        classe_sezione: null,
        scuola_id: 'sc-1',
        stato: 'iscritto',
        codice_fiscale: null,
      },
      {
        id: BIMBO_TERZO,
        nome: 'Mario',
        cognome: 'Rossini',
        classe_sezione: null,
        scuola_id: 'sc-1',
        stato: 'iscritto',
        codice_fiscale: null,
      },
      // Il terzo sta nell'ALTRO plesso del perimetro: è la riga che fa divergere
      // `sedi` (quante sedi c'erano in cui cercare) da 1.
      {
        id: BIMBO_RITIRATO,
        nome: 'Zoe',
        cognome: 'Rossini',
        classe_sezione: null,
        scuola_id: 'sc-2',
        stato: 'iscritto',
        codice_fiscale: null,
      },
    ]
    const b = await corpo(await get('q=rossini&limite=2'))
    expect(b.data).toHaveLength(2)
    expect(b.troncato).toBe(true)
    const riga = h.logEvento.mock.calls.find((c) => (c[2] as { esito?: string })?.esito === 'ricerca-alunni')
    // `n` è quanti ne sono USCITI (2), non quanti ne sono stati letti (3):
    // `troncato` è il campo che dice che ce n'era dell'altro.
    expect(riga?.[2]).toMatchObject({ n: 2, troncato: true, sedi: 2 })
  })

  /**
   * ─── E LA STESSA RIGA SUL RAMO «NESSUN RISULTATO» ───────────────────────────
   *
   * Il ritorno vuoto DOPO aver cercato (`righe.length === 0`) è l'esito più
   * frequente di questa rotta: un campo che si ridisegna a ogni tasto battuto
   * passa da «nessun risultato» a ogni lettera, e solo l'ultima ne trova uno.
   * Eppure fino al sesto giro la sua riga di log era decorazione — misurato due
   * volte, tutt'e due verdi: cancellando l'intera `logEvento` di quel ramo, e
   * cablandone i tre conteggi a `n: 7, troncato: true, sedi: 99`. Il ramo era già
   * PERCORSO (dal caso dei soli segni diacritici), ma nessuno ne guardava la spia.
   *
   * 🔴 Senza quella riga `app_log` non distingue «ho cercato e non c'era nessuno»
   * da «non è mai partito niente» — la regola «gli eventi critici loggano anche
   * il SUCCESSO», applicata al successo più comune che ci sia. E la specifica la
   * elenca alla lettera: operazione, esito, numero di risultati, troncato, quante
   * sedi.
   *
   * ⚠️ DUE sedi nel perimetro, apposta: con una sola, `sedi: 1` coinciderebbe con
   * la costante `1` e la mutazione che lo cabla resterebbe invisibile — lo stesso
   * inganno del caso qui sopra, un ramo più in là.
   */
  it('anche «nessun risultato» lascia la sua riga: n 0, non troncato, due sedi', async () => {
    h.sediAttive = ['sc-1', 'sc-2']
    const res = await get('q=zxqwertissimo')
    expect(res.status).toBe(200)
    expect((await corpo(res)).data).toEqual([])
    // 🔴 La lettura È partita: questo è il ramo «ho guardato e non c'era
    // nessuno», non quello del perimetro vuoto (che nega prima, con `sedi: 0`).
    expect(letteDa('alunni')).toHaveLength(1)
    const riga = h.logEvento.mock.calls.find((c) => (c[2] as { esito?: string })?.esito === 'ricerca-alunni')
    expect(riga?.[2]).toMatchObject({ n: 0, troncato: false, sedi: 2 })
  })

  it('42703 sugli alunni (DB E2E non migrato): ritenta senza `stato` e risponde 200', async () => {
    h.alunniError = { code: '42703', message: 'column alunni.stato does not exist' }
    const res = await get('q=rossini')
    expect(res.status).toBe(200)
    const b = await corpo(res)
    expect(b.data?.map((a) => a.alunno_id)).toEqual([BIMBO_IN])
    // Degrado APERTO e dichiarato: senza la colonna tutti risultano attivi, e
    // il rifiuto resta quello della scrittura.
    expect(b.data?.[0].attivo).toBe(true)
    expect(letteDa('alunni')[1].cols).not.toContain('stato')
    expect(h.logEvento).toHaveBeenCalledWith('db', 'info', expect.objectContaining({
      esito: 'colonna-stato-assente', error_code: '42703',
    }))
  })

  it('42703 sullo `sconto` delle voci: ritenta senza, e risponde 200', async () => {
    h.vociError = { code: '42703', message: 'column pagamenti.sconto does not exist' }
    const res = await get('q=rossini')
    expect(res.status).toBe(200)
    const b = await corpo(res)
    // Senza la colonna lo sconto vale 0: (100 − 40) + 30 = 90, non 80.
    expect(b.data?.[0].voci_aperte).toBe(2)
    expect(b.data?.[0].residuo_aperto).toBe(90)
    expect(letteDa('pagamenti')[1].cols).not.toContain('sconto')
    // 🔴 In simmetria col gemello `colonna-stato-assente` otto righe più in su,
    // che era asserito mentre questo no: il ritentativo e il residuo 90 restano
    // identici con la riga di log cancellata (misurato) o col suo `esito`
    // rinominato. È l'unica cosa che in CI distingue «il DB E2E non è migrato»
    // da «lo sconto vale davvero zero»: senza, un `42703` che comparisse in
    // PRODUZIONE — dove la colonna c'è — passerebbe per un conto giusto.
    expect(h.logEvento).toHaveBeenCalledWith('db', 'info', expect.objectContaining({
      esito: 'colonna-sconto-assente', entita_tipo: 'pagamenti', error_code: '42703',
    }))
  })

  it('voci non leggibili: `null`, MAI zero (e la ricerca resta utile)', async () => {
    h.vociError = { code: '08006', message: 'connection failure' }
    const res = await get('q=rossini')
    expect(res.status).toBe(200)
    const b = await corpo(res)
    // 🔴 `0` direbbe «questa famiglia non deve niente» a chi sta per incassare
    // un bonifico. `null` dice «non ho potuto guardare», che è la verità.
    expect(b.data?.[0].voci_aperte).toBeNull()
    expect(b.data?.[0].residuo_aperto).toBeNull()
    expect(h.logEvento).toHaveBeenCalledWith(
      'pagamento', 'warn', expect.objectContaining({ esito: 'voci-aperte-non-lette' }), expect.anything(),
    )
  })

  /**
   * ─── LA FINESTRA DELLE VOCI TAGLIATA DAL `db-max-rows` ──────────────────────
   *
   * `supabase/config.toml` dichiara `max_rows = 1000`: PostgREST tronca lì e non
   * lo dice. Una finestra tagliata qui non sbaglia di poco — sottrae voci al
   * `residuo_aperto` di un bambino su una schermata che sta per incassare un
   * bonifico, cioè produce un numero PIÙ BASSO del vero senza che niente lo
   * segnali. È lo `0` travestito da verità, solo più difficile da vedere perché
   * non è zero: è «quasi giusto».
   *
   * Oggi il tetto non morde (contato sul database di produzione il 2026-09-20,
   * sole aggregazioni: 892 righe in tutto, 14 al massimo per bambino, 109 sui
   * venti più carichi), e proprio per questo la difesa non può essere il
   * margine: è il tetto CHIESTO più il degrado onesto quando la pagina torna
   * piena.
   */
  it('finestra delle voci PIENA: degrada a `null`, non a un conteggio corto', async () => {
    // 1000 = il `max_rows` di `supabase/config.toml`, che la rotta dichiara come
    // `BLOCCO_VOCI`. Una pagina piena non prova che ci siano altre righe: prova
    // che non si può sapere, ed è la stessa cosa.
    h.voci = Array.from({ length: 1000 }, () => ({
      alunno_id: BIMBO_IN, importo: 10, importo_pagato: 0, sconto: 0, stato: 'da_pagare', tipo: null,
    }))
    const res = await get('q=rossini')
    expect(res.status).toBe(200)
    const b = await corpo(res)
    // 🔴 Un `10000` sarebbe la somma di ciò che si è riusciti a leggere spacciata
    // per il dovuto della famiglia.
    expect(b.data?.[0].voci_aperte).toBeNull()
    expect(b.data?.[0].residuo_aperto).toBeNull()
    expect(h.logEvento).toHaveBeenCalledWith('pagamento', 'warn', expect.objectContaining({
      esito: 'voci-aperte-finestra-troncata', entita_tipo: 'pagamenti', n: 1,
    }))
    // Il tetto è CHIESTO: il finto restituirebbe la fixture intera comunque,
    // quindi senza questa riga togliere il `.limit()` resterebbe verde.
    expect(letteDa('pagamenti')[0].limite).toBe(1000)
  })

  it('paganti non leggibili: `ha_pagante` è `null`, non `false`', async () => {
    // `pagantiAmmessiPerAlunni` gira per davvero, e un errore che non è «schema
    // assente» rende il suo insieme inaffidabile (`completo: false`).
    h.legamiError = { code: '08006', message: 'connection failure' }
    const res = await get('q=rossini')
    expect(res.status).toBe(200)
    const b = await corpo(res)
    // 🔴 `false` direbbe «questo bambino non ha nessun adulto collegato», e
    // manderebbe la segreteria a creare un genitore che esiste già.
    expect(b.data?.[0].ha_pagante).toBeNull()
  })

  it('la lettura degli ALUNNI che fallisce è un 500 con codice, non un elenco vuoto', async () => {
    h.alunniError = { code: '08006', message: 'connection failure' }
    const res = await get('q=rossini')
    expect(res.status).toBe(500)
    const b = await corpo(res)
    // 🔴 «Non l'ho trovato» e «non ho potuto cercare» mandano l'operatrice a
    // fare due cose opposte: la seconda non deve travestirsi da prima.
    expect(b.codice).toBe('CONCILIAZIONE_RICERCA_ALUNNI_NON_LETTA')
    // ⚠️ `{ error, codice }`, non il solo `codice`: è la forma del corpo d'errore
    // di questo repo, e il lock `errori-con-codice` non la tiene — sorveglia la
    // presenza del CODICE, non quella della frase. Misurato: senza questa riga il
    // corpo si poteva ridurre al solo `codice` a suite verde.
    expect(typeof b.error).toBe('string')
    expect(b.data).toBeUndefined()
    expect(h.logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ evento: 'alunni-non-cercati', error_code: '08006' }),
      expect.anything(),
    )
  })

  it('i nomi di sede non letti degradano ad ASSENZA della chiave, e lo DICHIARANO', async () => {
    h.scuoleError = { code: '08006', message: 'connection failure' }
    const b = await corpo(await get('q=rossini'))
    expect(b.sedi).toEqual({})
    expect(b.data).toHaveLength(1)
    /**
     * 🔴 LA SPIA, non solo il corpo — ed è la stessa classe di difetto del
     * «nessun risultato» (decisione 12), un ramo più in là: guardando solo
     * `b.sedi` e `b.data` questo caso resta verde anche col `logEvento`
     * CANCELLATO dalla rotta (misurato). Qui il degrado è silenzioso a valle di
     * una lettura RIUSCITA: la risposta è un 200 con l'elenco giusto, la mappa
     * `sedi` torna vuota e la schermata scrive «un altro plesso» su ogni riga.
     * Senza questa riga in `app_log` non resta niente da cercare, e «questa sede
     * non ha nome» e «non ho potuto leggere i nomi» tornano indistinguibili —
     * cioè proprio la confusione che questa rotta esiste per togliere.
     */
    expect(h.logEvento).toHaveBeenCalledWith(
      'pagamento',
      'warn',
      expect.objectContaining({
        esito: 'nomi-sedi-non-letti', entita_tipo: 'scuole', n: 1, error_code: '08006',
      }),
      expect.anything(),
    )
  })

  it('una sede SENZA NOME è una chiave assente, non una stringa inventata', async () => {
    // Il caso gemello di quello qui sopra, e l'altra metà della promessa: là la
    // lettura fallisce, qui riesce ma il nome in anagrafica è vuoto. «Sede
    // sconosciuta» scritta dalla rotta sarebbe un nome che nessuno ha mai
    // registrato; l'assenza della chiave fa dire alla schermata «un altro
    // plesso», che è vero.
    h.scuole = [{ id: 'sc-1', nome: null }]
    const b = await corpo(await get('q=rossini'))
    expect(b.sedi).toEqual({})
    expect(b.data).toHaveLength(1)
  })

  it('e un nome di soli SPAZI è la stessa cosa di un nome assente', async () => {
    // Il terzo gemello, e l'unico che misuri il `trim()` di `testo()`: con
    // `nome: null` la promessa regge anche senza, con `nome: '   '` no. Misurato:
    // tolto il `trim()` la suite restava verde, e in `sedi` finiva una chiave
    // il cui valore è una stringa di spazi — sulla schermata un plesso SENZA
    // NOME al posto del «un altro plesso» che l'assenza della chiave produce.
    h.scuole = [{ id: 'sc-1', nome: '   ' }]
    const b = await corpo(await get('q=rossini'))
    expect(b.sedi).toEqual({})
    expect(b.data).toHaveLength(1)
  })

  it('il gate di ruolo viene prima di tutto, zod compreso', async () => {
    h.requireStaff.mockResolvedValue({ response: new Response('no', { status: 403 }) })
    const res = await get('q=rossini')
    expect(res.status).toBe(403)
    expect(h.from).toEqual([])
    /**
     * 🔴 E VIENE PRIMA ANCHE DI ZOD, che è l'unica metà misurabile dell'ordine:
     * `requireStaff` gira comunque prima di ogni `from()`, quindi scambiando i
     * due blocchi la riga qui sopra resterebbe verde. Questa no — con una query
     * MALFORMATA la risposta diventerebbe 400, cioè si direbbe a chi non ha il
     * permesso che cosa c'era di sbagliato nella sua richiesta, e si farebbe
     * girare il parser su ciò che manda un chiamante non autorizzato.
     *
     * ⚠️ Non è il lock `corpo-letto-dopo-il-gate` a tenerlo fermo (sorveglia le
     * letture del CORPO, e questa GET un corpo non ce l'ha): è questa riga.
     */
    const malformata = await get('q=rossini&limite=500')
    expect(malformata.status).toBe(403)
    expect(h.from).toEqual([])
  })

  it('un guasto DENTRO il `try` è un 500 con codice, e lascia una riga di log', async () => {
    // 🔴 `withRoute` NON vede le eccezioni catturate: il suo `catch` sta fuori,
    // e qui l'errore non esce mai dal corpo. Senza il `logErrore` del `catch`
    // finale questo 500 uscirebbe MUTO — l'operatrice vede «riprova fra poco» e
    // in `app_log` non c'è niente da cercare. È la regola «un catch che non
    // logga è un bug», col suo controllo: mutando quella riga in `void err` la
    // suite restava verde.
    h.requireStaff.mockImplementation(() => {
      throw new Error('guasto pilotato')
    })
    const res = await get('q=rossini')
    expect(res.status).toBe(500)
    const b = await corpo(res)
    expect(b.codice).toBe('CONCILIAZIONE_RICERCA_ALUNNI_NON_LETTA')
    // Il gemello dell'altro 500: stessa forma `{ error, codice }`, e va tenuta
    // su tutt'e due le uscite — una sola provata lascia l'altra libera di
    // divergere.
    expect(typeof b.error).toBe('string')
    expect(b.data).toBeUndefined()
    expect(h.logErrore).toHaveBeenCalledWith(
      expect.objectContaining({ stato: 500 }),
      expect.anything(),
    )
  })
})
