import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * L'IMPORT CHE ABBINA DA SÉ — la fase che scrive denaro senza che nessuno clicchi.
 *
 * ─── COSA MISURA QUESTO FILE ────────────────────────────────────────────────
 * Non la REGOLA («questo bonifico è certo?»): quella è di `valutaCertezza` e ha i suoi
 * test, ed è una funzione pura. Qui si misura la fase che la chiama dentro il `POST`
 * dell'import: quando parte, quando NON parte, che cosa scrive, che cosa non scrive mai
 * — e soprattutto le due cose che il percorso manuale ha in una persona e qui non ci
 * sono: la scelta del pagante e la notifica alla famiglia.
 *
 * ─── IL FINTO NON È PIATTO, E SI VEDE ───────────────────────────────────────
 * Un mock che risponde sempre la stessa cosa è verde con e senza la correzione. Qui il
 * finto ha uno SCHEMA: la marca `abbinato_auto_il` può mancare (`42703`, com'è il DB
 * E2E della CI), l'elenco degli aperti può non finire mai (il troncamento silenzioso di
 * PostgREST), il compare-and-swap può essere perso, `schools` può non leggersi. E ogni
 * prova che dice «non ha scritto» dice anche, nella stessa prova o nella gemella, che
 * nel caso buono SCRIVE: senza quella metà, «nessuna scrittura» sarebbe vero anche per
 * un import che non è mai partito.
 *
 * ─── I DATI SONO INVENTATI ──────────────────────────────────────────────────
 * Il repository è PUBBLICO e i movimenti veri portano i nomi di seicento famiglie. Qui
 * non c'è nessun nome: le causali citano solo i CODICI VOCE (che sono derivati da uuid
 * inventati) e un codice fiscale nella forma esatta che l'estrattore pretende, che non
 * è di nessuno — è lo stesso già usato dai test dell'oblio.
 */

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  notificaEvento: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  /** Ogni catena chiusa sul client finto: tabella, operazione, colonne, filtri, corpo. */
  chiamate: [] as {
    table: string
    op: string
    cols: string
    filtri: [string, unknown][]
    corpo: unknown
  }[],
  /** Le voci aperte che il database restituisce. */
  aperti: [] as Record<string, unknown>[],
  /** Le righe di `student_parents`: da qui esce il pagante della composita. */
  legami: [] as Record<string, unknown>[],
  /** Errore per TABELLA: `schools` in errore spegne la fase, e si vuole provarlo. */
  errori: {} as Record<string, { code: string; message: string } | null>,
  /** L'errore della sonda sulla marca `abbinato_auto_il` (colonna assente sul DB CI). */
  marcaErrore: null as { code: string; message: string } | null,
  /** `false` = il compare-and-swap è perso: un altro operatore è arrivato prima. */
  casVinto: true,
  /**
   * L'elenco degli aperti non finisce MAI: ogni pagina torna piena, nessuna è vuota.
   * È la sola forma in cui PostgREST tronca — in silenzio — e la rotta se ne accorge
   * solo esaurendo il tetto dei round-trip.
   */
  apertiInfiniti: false,
  /** Gli hash già in registro (dedup). Vuoto: in questi test i movimenti sono nuovi. */
  esistenti: [] as string[],
  /**
   * Le tabelle il cui INSERT con `scuola_id: null` risponde `23502`: è il DB E2E della CI,
   * mai migrato, dove quella colonna è ancora `NOT NULL`. La rotta ritenta con la sede
   * dell'operatore — ed è il RAMO DI DEGRADAZIONE, quello che in CI gira sempre.
   */
  fail23502: new Set<string>(),
  /** L'insert riesce ma il server non restituisce righe: `data: null` col `.select(…)` presente. */
  insertSenzaRighe: false,
  /**
   * Colonne che l'elenco APERTI non ha: chi le chiede prende `42703` e la scala
   * `SACRIFICIO_APERTI` scende di un gradino. È il modo in cui `stato` e `anonimizzato_il`
   * dell'alunno spariscono davvero.
   */
  apertiColonneAssenti: [] as string[],
  /** La RILETTURA per id delle voci torna senza l'embed della categoria. */
  senzaCategoriaSullaRilettura: false,
  /** Le sedi di `schools`. Nessun nome con «e2e»: sono sedi REALI per il predicato. */
  sedi: [] as { id: string; nome: string }[],
  rpc: [] as { nome: string; params: Record<string, unknown> }[],
  rpcEsito: { data: {} as Record<string, unknown> | null, error: null as unknown },
  /** I movimenti che l'INSERT ha scritto, per id: li rileggono le letture successive. */
  scritti: new Map<string, Record<string, unknown>>(),
  prossimoId: 0,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
/**
 * ⚠️ LA SPIA SULLA NOTIFICA È IL PUNTO DI UNA PROVA INTERA (vedi «la famiglia non viene
 * avvisata»): il modulo esiste e il percorso MANUALE lo usa, quindi mockarlo non è una
 * finzione di comodo — è l'unico modo di dimostrare che la strada automatica non ci
 * passa. Se un giorno qualcuno aggiungesse `notificaEvento` alla fase, questa spia lo
 * direbbe subito.
 */
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento }))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: (...a: unknown[]) => h.logEvento(...a),
  logErrore: (...a: unknown[]) => h.logErrore(...a),
}))
vi.mock('@/lib/auth/scope', async (orig) => ({
  // Il PERIMETRO dell'operatore: una sola sede, e NON è il perimetro su cui lavora
  // l'automatismo. È esattamente la deroga che questo file misura. (Dal 2026-09-26, K5,
  // l'import non chiede più una sede di scrittura: `resolveScuolaScrittura` non c'è più.)
  restringiSedi: (await orig<typeof import('@/lib/auth/scope')>()).restringiSedi,
  resolveScuoleAttive: async () => ['sc-operatore'],
}))

/** Un uuid INVENTATO: la forma è quella che lo schema pretende, il valore non è di nessuno. */
const SEDE = '11111111-2222-4333-8444-555555555555'
/**
 * IL SECONDO PLESSO, e non è un uuid decorativo.
 *
 * Le sedi di produzione sono TRE e l'estratto conto è UNO SOLO: un bonifico che
 * paga due fratelli iscritti in plessi diversi è il caso normale, non il margine —
 * ed è la ragione stessa della deroga di sede che questa fase si prende. Serve a
 * una prova sola, la composita cross-sede, dove `scuola_id` del documento e la
 * prima riga della composizione DEVONO essere due valori diversi: con una sede
 * sola quella prova non misurerebbe niente (v. il commento là).
 */
const SEDE2 = '99999999-8888-4777-8666-555555555555'
const PID_A = 'aaaaaaaa-1111-4111-8111-111111111111'
const PID_B = 'bbbbbbbb-2222-4222-8222-222222222222'
const PID_C = 'cccccccc-3333-4333-8333-333333333333'

/**
 * La sede di COLLAUDO, che non è un'invenzione di questo file: il seed della CI la crea
 * col prefisso `e2e00000-…`, e quella riga esiste anche nel database di produzione. È
 * l'unico id su cui «sedi reali e attive» e «tutte le righe di `schools`» divergono.
 */
const SEDE_E2E = 'e2e00000-0000-4000-8000-000000000000'

/** Un codice fiscale INVENTATO, nella forma esatta che `estraiCodiciFiscali` pretende. */
const CF_INVENTATO = 'AAABBB10A01H501X'

type Stato = {
  table: string
  op: string
  cols: string
  /** `.select(…)` è stato chiamato. Su un INSERT decide se tornano righe o `null`. */
  selezionato: boolean
  filtri: [string, unknown][]
  da: number
  a: number
  corpo: unknown
}

/** Il valore di un `.eq(colonna, …)` già registrato sulla catena. */
const eqDi = (st: Stato, colonna: string): unknown =>
  st.filtri.find(([k]) => k === `eq:${colonna}`)?.[1]

const inDi = (st: Stato, colonna: string): unknown[] =>
  (st.filtri.find(([k]) => k === `in:${colonna}`)?.[1] as unknown[]) ?? []

/** La fetta chiesta con `.range()`: il finto rispetta il range, come farebbe il server. */
const pagina = <T>(righe: T[], st: Stato): T[] => righe.slice(st.da, st.a + 1)

/**
 * IL FINTO RISPETTA LA PROIEZIONE, e non è pignoleria.
 *
 * La scala `SACRIFICIO_APERTI` esiste per CHIEDERE MENO COLONNE quando il database non le
 * ha. Un finto che restituisce comunque la riga intera renderebbe quel degrado invisibile:
 * la fase continuerebbe a vedere `stato` e `anonimizzato_il` dell'alunno anche dopo averli
 * persi, e la prova che la cecità sull'oblio spegne la fase sarebbe verde per il motivo
 * sbagliato — misurando il finto, non il codice.
 */
const proietta = (riga: Record<string, unknown>, cols: string): Record<string, unknown> => {
  // Tutto ciò che sta PRIMA dell'embed è la lista delle colonne di `pagamenti`: la
  // `scuola_id` dell'alunno sta dentro le parentesi, e non va confusa con quella del
  // pagamento.
  const testa = cols.split('alunni:')[0]
  const chiaviAlunno = new Set(
    (/alunni:alunno_id \(([^)]*)\)/.exec(cols)?.[1] ?? '').split(',').map((s) => s.trim()),
  )
  const alunni = riga.alunni as Record<string, unknown> | null
  const out: Record<string, unknown> = { ...riga }
  if (!testa.includes('sconto')) delete out.sconto
  if (!testa.includes('scuola_id')) delete out.scuola_id
  if (!cols.includes('payment_categories')) delete out.payment_categories
  out.alunni = alunni
    ? Object.fromEntries(Object.entries(alunni).filter(([k]) => chiaviAlunno.has(k)))
    : null
  return out
}

function risolvi(st: Stato): { data: unknown; error: unknown } {
  const errore = h.errori[st.table] ?? null
  if (errore) return { data: null, error: errore }

  switch (st.table) {
    case 'riconciliazione_movimenti': {
      if (st.op === 'insert') {
        const righe = (Array.isArray(st.corpo) ? st.corpo : [st.corpo]) as Record<string, unknown>[]
        if (h.fail23502.has(st.table) && righe.some((r) => r.scuola_id === null)) {
          return {
            data: null,
            error: { code: '23502', message: 'null value in column "scuola_id" violates not-null constraint' },
          }
        }
        const out = righe.map((r) => {
          const id = `mov-${h.prossimoId++}`
          h.scritti.set(id, { ...r, id })
          return { id, hash_movimento: r.hash_movimento }
        })
        // 🔴 SENZA `.select(…)` POSTGREST NON RESTITUISCE NIENTE: `data` è `null`. La riga
        // è scritta lo stesso (sta in `h.scritti`), ma gli uuid non tornano indietro — ed è
        // proprio la differenza che il ramo di degradazione deve avere. Un finto generoso,
        // che consegnasse le righe anche senza `.select`, resterebbe verde con e senza
        // quel `.select`: cioè non misurerebbe niente.
        if (!st.selezionato || h.insertSenzaRighe) return { data: null, error: null }
        return { data: out, error: null }
      }
      if (st.op === 'update') return { data: h.casVinto ? [{ id: eqDi(st, 'id') }] : [], error: null }
      // La sonda della marca: una colonna sola, e sul DB non migrato risponde 42703.
      if (st.cols.includes('abbinato_auto_il')) {
        return h.marcaErrore ? { data: null, error: h.marcaErrore } : { data: [], error: null }
      }
      // La lettura di `registraConciliazione`: `transazione_id` è la sua sonda di schema.
      if (st.cols.includes('transazione_id')) {
        const r = h.scritti.get(String(eqDi(st, 'id')))
        return {
          data: r
            ? [{
                id: r.id,
                importo: r.importo,
                stato: r.stato,
                data_operazione: r.data_operazione,
                scuola_id: null,
                pagamento_id: null,
                transazione_id: null,
              }]
            : [],
          error: null,
        }
      }
      // Resta la finestra di dedup, paginata.
      return { data: pagina(h.esistenti.map((x) => ({ hash_movimento: x })), st), error: null }
    }

    case 'pagamenti': {
      // L'elenco degli APERTI si riconosce dal filtro per stato.
      if (st.filtri.some(([k]) => k === 'in:stato')) {
        // «Quella colonna qui non c'è»: PostgREST la NOMINA, e la scala scende di un
        // gradino. È il solo modo in cui un gruppo di colonne sparisce davvero.
        const assente = h.apertiColonneAssenti.find((c) => st.cols.includes(c))
        if (assente) return { data: null, error: { code: '42703', message: `column "${assente}" does not exist` } }
        // Ogni pagina piena e nessuna vuota: il taglio silenzioso del server.
        if (h.apertiInfiniti) return { data: [proietta(h.aperti[0], st.cols)], error: null }
        return { data: pagina(h.aperti, st).map((p) => proietta(p, st.cols)), error: null }
      }
      // La RILETTURA per id (la fa `registraConciliazione` per conto suo): può tornare in
      // una forma diversa da quella dell'elenco — è il caso che rende l'àncora dichiarata
      // diversa dall'àncora ricalcolata.
      const rileggi = (p: Record<string, unknown>) =>
        h.senzaCategoriaSullaRilettura ? { ...p, payment_categories: null } : p
      const uno = eqDi(st, 'id')
      if (uno !== undefined) return { data: h.aperti.filter((p) => p.id === uno).map(rileggi), error: null }
      const molti = inDi(st, 'id')
      return { data: h.aperti.filter((p) => molti.includes(p.id)).map(rileggi), error: null }
    }

    case 'riconciliazione_import': {
      if (st.op === 'insert') {
        const righe = (Array.isArray(st.corpo) ? st.corpo : [st.corpo]) as Record<string, unknown>[]
        if (h.fail23502.has(st.table) && righe.some((r) => r.scuola_id === null)) {
          return {
            data: null,
            error: { code: '23502', message: 'null value in column "scuola_id" violates not-null constraint' },
          }
        }
      }
      return { data: [{ id: 'imp-1' }], error: null }
    }

    case 'incassi':
      return st.op === 'insert' ? { data: [{ id: 'inc-1' }], error: null } : { data: [], error: null }

    case 'schools':
      return { data: h.sedi, error: null }

    // Il flag `attiva` vive su `scuole`: nessuna riga ⇒ nessuna sede disattivata.
    case 'scuole':
      return { data: [], error: null }

    case 'student_parents':
      return { data: h.legami, error: null }

    default:
      // `legame_genitori_alunni`, `parents`, `fatture_emesse`: vuote e senza errore.
      return { data: [], error: null }
  }
}

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    rpc: async (nome: string, params: Record<string, unknown>) => {
      h.rpc.push({ nome, params })
      return h.rpcEsito
    },
    from: (table: string) => {
      const st: Stato = {
        table, op: 'select', cols: '', selezionato: false,
        filtri: [], da: 0, a: Number.MAX_SAFE_INTEGER, corpo: null,
      }
      const b: Record<string, unknown> = {}
      const chiudi = () => {
        h.chiamate.push({ table: st.table, op: st.op, cols: st.cols, filtri: [...st.filtri], corpo: st.corpo })
        return risolvi(st)
      }
      b.select = (cols?: string) => { st.cols = cols ?? ''; st.selezionato = true; return b }
      b.eq = (c: string, v: unknown) => { st.filtri.push([`eq:${c}`, v]); return b }
      b.in = (c: string, v: unknown) => { st.filtri.push([`in:${c}`, v]); return b }
      b.gte = (c: string, v: unknown) => { st.filtri.push([`gte:${c}`, v]); return b }
      b.lte = (c: string, v: unknown) => { st.filtri.push([`lte:${c}`, v]); return b }
      b.order = () => b
      b.limit = () => b
      b.range = (da: number, a: number) => { st.da = da; st.a = a; return b }
      b.insert = (row: unknown) => { st.op = 'insert'; st.corpo = row; return b }
      b.update = (row: unknown) => { st.op = 'update'; st.corpo = row; return b }
      b.delete = () => { st.op = 'delete'; return b }
      b.single = async () => {
        const r = chiudi()
        return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error }
      }
      b.maybeSingle = b.single
      b.then = (res: (v: unknown) => unknown) => res(chiudi())
      return b
    },
  }),
}))

import { POST } from '@/app/api/pagamenti/riconciliazione/route'
import { createAdminClient } from '@/lib/supabase/server-client'
import { codiceVoce } from '@/lib/pagamenti/codice-voce'
import {
  abbinaImportAutomaticamente,
  BUDGET_AUTO_MS,
  MAX_AUTO_PER_IMPORT,
  type VoceApertaPerAuto,
} from '@/lib/pagamenti/riconciliazione-auto-import'

/**
 * Una voce aperta come torna da PostgREST, embed compresi. La stessa riga serve alle
 * TRE letture che la fase attraversa (l'elenco aperti, il pagamento della conferma a
 * voce singola, le voci della composizione): è la stessa tabella, e un finto che ne
 * desse tre versioni diverse misurerebbe sé stesso.
 */
const aperto = (
  id: string,
  importo: number,
  opzioni: {
    alunno?: string; cf?: string | null; slug?: string; sede?: string | null; tipo?: string
    stato?: string
    /** Abbuono sulla voce: il residuo VERO è `importo − sconto`, non `importo`. */
    sconto?: number
    /** Il fascicolo è passato per l'oblio GDPR: una data qui, e la macchina non deve incassare. */
    anonimizzatoIl?: string | null
  } = {},
) => ({
  id,
  descrizione: 'Retta di prova',
  importo,
  importo_pagato: 0,
  sconto: opzioni.sconto ?? 0,
  scuola_id: opzioni.sede === undefined ? SEDE : opzioni.sede,
  periodo_competenza: null,
  scadenza: null,
  tipo: opzioni.tipo ?? 'singolo',
  stato: 'da_pagare',
  alunno_id: opzioni.alunno ?? 'al-1',
  alunni: {
    nome: 'Nome', cognome: 'Cognome', codice_fiscale: opzioni.cf ?? null, fiscal_code: null,
    stato: opzioni.stato ?? 'iscritto', anonimizzato_il: opzioni.anonimizzatoIl ?? null,
    scuola_id: opzioni.sede === undefined ? SEDE : opzioni.sede,
  },
  payment_categories: { slug: opzioni.slug ?? 'retta' },
})

/** Il CSV della banca, ridotto all'essenziale: una riga per movimento. */
const csv = (righe: { importo: string; causale: string; data?: string }[]) =>
  ['Data;Entrate;Descrizione', ...righe.map((r) => `${r.data ?? '05/09/2026'};${r.importo};${r.causale}`)].join('\n')

const post = (contenuto: string) =>
  new Request('http://localhost/api/pagamenti/riconciliazione', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contenuto }),
  })

/**
 * LA VIA DIRETTA — la fase chiamata senza passare dalla rotta, e non è una scorciatoia.
 *
 * Tre cose non sono raggiungibili dal `POST`, e ognuna ferma un ciclo che scrive DENARO:
 * l'OROLOGIO del budget (l'import non lo passa, e non deve: provarlo di là vorrebbe dire
 * aspettare due minuti veri), il TETTO delle scritture, e la bandiera `contenitore` —
 * perché la rotta i `tipo: 'padre'` li toglie già con un `.filter(…)` prima di costruire
 * l'elenco, quindi dalla rotta quella bandiera non è nemmeno osservabile.
 *
 * ⚠️ Chi legge queste prove tenga presente la METÀ POSITIVA: le due del budget/tetto
 * mostrano che per questa stessa via la fase SCRIVE davvero (`autoSingole` > 0). Senza
 * quella metà, «nessuna scrittura» sarebbe vero anche per una fase che non parte.
 */

/**
 * La riga del database nella forma che la fase legge: è la stessa conversione che fa la
 * rotta (`ApertoDaAbbinare` → `VoceApertaPerAuto`), scritta a mano perché queste prove non
 * passano di là. Si legge dall'embed ciò che la rotta legge dall'embed — `stato` e
 * `anonimizzato_il` compresi — invece di cablarli: un convertitore che mettesse a `null`
 * un campo che in produzione arriva valorizzato renderebbe la prova verde per il motivo
 * sbagliato.
 */
const perFase = (r: Record<string, unknown>): VoceApertaPerAuto => {
  const alunni = r.alunni as Record<string, unknown>
  return {
    id: r.id as string,
    alunno_id: r.alunno_id as string,
    scuola_id: r.scuola_id as string,
    importo: r.importo as number,
    importo_pagato: r.importo_pagato as number,
    sconto: r.sconto as number,
    codice_fiscale: (alunni?.codice_fiscale ?? null) as string | null,
    descrizione: r.descrizione as string,
    categoria_slug: (r.payment_categories as { slug: string }).slug,
    alunno_stato: (alunni?.stato ?? null) as string | null,
    alunno_anonimizzato_il: (alunni?.anonimizzato_il ?? null) as string | null,
    tipo: r.tipo as string,
  }
}

const movimento = (i: number, pagamentoId: string, importo: number) => ({
  id: `mov-${i}`,
  importo,
  causale: `BONIFICO PER ${codiceVoce(pagamentoId)} TRN ${i}`,
  controparte: null,
  dataOperazione: '2026-09-05',
  stato: 'suggerito',
})

/** La fase sola, sugli stessi finti della rotta. `adesso` fermo: qui il tempo non c'entra. */
const faseDiretta = async (
  movimenti: ReturnType<typeof movimento>[],
  opzioni: { adesso?: () => number } = {},
) =>
  abbinaImportAutomaticamente(await createAdminClient(), {
    importId: 'imp-1',
    movimenti,
    aperte: h.aperti.map(perFase),
    apertiTroncati: false,
    attore: { id: 'staff-1' } as never,
    operazione: 'pagamenti/riconciliazione:POST',
    adesso: opzioni.adesso ?? (() => 0),
  })

/** Gli UPDATE partiti su `riconciliazione_movimenti`: è lì che si vede la conferma. */
const conferme = () =>
  h.chiamate.filter((c) => c.table === 'riconciliazione_movimenti' && c.op === 'update')

const incassiScritti = () => h.chiamate.filter((c) => c.table === 'incassi' && c.op === 'insert')

/** Le righe di log con quell'`esito`: `logEvento(evento, livello, campi, err?)`. */
const log = (esito: string) =>
  h.logEvento.mock.calls.filter((c) => (c[2] as { esito?: string })?.esito === esito)

const livelloDi = (esito: string) => log(esito).map((c) => c[1])
const campiDi = (esito: string) => log(esito).map((c) => c[2] as Record<string, unknown>)

beforeEach(() => {
  vi.clearAllMocks()
  h.chiamate = []
  h.aperti = []
  h.legami = []
  h.errori = {}
  h.marcaErrore = null
  h.casVinto = true
  h.apertiInfiniti = false
  h.esistenti = []
  h.fail23502 = new Set()
  h.insertSenzaRighe = false
  h.apertiColonneAssenti = []
  h.senzaCategoriaSullaRilettura = false
  h.sedi = [{ id: SEDE, nome: 'Plesso Primo' }]
  h.rpc = []
  h.rpcEsito = { data: { transazione_id: 'tr-1', movimento_id: 'mov-0', incassi: 2 }, error: null }
  h.scritti = new Map()
  h.prossimoId = 0
  h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
})

describe('import → abbinamento automatico: il caso certo', () => {
  it('(a) movimento certo ⇒ riga confermata, incasso scritto, marca valorizzata, auto_singole: 1', async () => {
    h.aperti = [aperto(PID_A, 150)]
    const res = await POST(post(csv([{ importo: '150,00', causale: `BONIFICO PER ${codiceVoce(PID_A)} TRN 1` }])))

    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.auto_singole).toBe(1)
    expect(j.data.auto_composite).toBe(0)
    expect(j.data.auto_saltati).toBe(0)

    // L'incasso c'è, ed è UNO.
    expect(incassiScritti()).toHaveLength(1)
    expect((incassiScritti()[0].corpo as Record<string, unknown>).pagamento_id).toBe(PID_A)

    // La riga è confermata, la sede è quella del pagamento (non quella dell'operatore),
    // e la MARCA c'è: senza, l'annullamento in blocco non ritroverebbe più questa riga.
    expect(conferme()).toHaveLength(1)
    const patch = conferme()[0].corpo as Record<string, unknown>
    expect(patch.stato).toBe('confermato')
    expect(patch.pagamento_id).toBe(PID_A)
    expect(patch.scuola_id).toBe(SEDE)
    expect(typeof patch.abbinato_auto_il).toBe('string')
    // Il compare-and-swap confronta lo stato LETTO, non «qualunque stato».
    expect(conferme()[0].filtri).toContainEqual(['eq:stato', 'suggerito'])

    // L'audit si fa, riga per riga: è registro.
    expect(h.logScrittura).toHaveBeenCalledTimes(2) // l'import + il movimento abbinato
    const auditMovimento = h.logScrittura.mock.calls
      .map((c) => c[1] as Record<string, unknown>)
      .find((a) => a.entitaTipo === 'riconciliazione_movimenti')
    expect(auditMovimento).toBeTruthy()
    expect((auditMovimento!.valoreDopo as Record<string, unknown>).automatico).toBe(true)

    // Il log di SUCCESSO dell'evento critico: senza, «nessun log» non distinguerebbe
    // «nessun movimento era certo» da «la fase non è mai partita».
    const [campi] = campiDi('auto_abbinamento_eseguito')
    expect(campi).toMatchObject({ import_id: 'imp-1', candidati: 1, auto_singole: 1, auto_composite: 0, saltati: 0 })
    expect(typeof campi.ms).toBe('number')
    // 🔴 E IL LIVELLO È `info`, non «un livello qualunque». Ogni altro livello di
    // questo file è asserito (`auto-non-disponibile`, `auto-scrittura-fallita`,
    // `auto-budget-esaurito`, `auto-id-non-restituiti`) e solo questo non lo era:
    // misurato, portandolo a `warn` restavano 30 prove verdi su 30. Non è
    // pignoleria di forma — è la riga che esce a OGNI import riuscito: su `warn` o
    // `error` diventerebbe un canale rosso a ogni giro di CI, e un canale sempre
    // rosso smette di essere guardato, che è il modo in cui in questo repository
    // un guasto vero è rimasto invisibile per mesi.
    expect(livelloDi('auto_abbinamento_eseguito')).toEqual(['info'])
  })

  it('(i) la famiglia NON viene avvisata sul ramo automatico (e intanto la scrittura è avvenuta)', async () => {
    h.aperti = [aperto(PID_A, 150)]
    const res = await POST(post(csv([{ importo: '150,00', causale: `BONIFICO PER ${codiceVoce(PID_A)} TRN 1` }])))

    expect(res.status).toBe(200)
    // ⚠️ LE DUE METÀ INSIEME. «Nessuna notifica» è vero anche per un import che non ha
    // fatto niente: la prova vale solo se nello stesso giro l'incasso è stato scritto.
    expect((await res.json()).data.auto_singole).toBe(1)
    expect(incassiScritti()).toHaveLength(1)
    expect(h.notificaEvento).not.toHaveBeenCalled()
  })

  it('(j) due movimenti sulla stessa voce nello stesso import: il secondo non dice «certo»', async () => {
    h.aperti = [aperto(PID_A, 100)]
    const res = await POST(post(csv([
      { importo: '100,00', causale: `BONIFICO PER ${codiceVoce(PID_A)} TRN 1` },
      { importo: '100,00', causale: `BONIFICO PER ${codiceVoce(PID_A)} TRN 2`, data: '06/09/2026' },
    ])))

    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.nuovi).toBe(2)
    // Il residuo si consuma IN MEMORIA: il secondo bonifico vede la voce già saldata.
    expect(j.data.auto_singole).toBe(1)
    expect(j.data.auto_saltati).toBe(1)
    expect(incassiScritti()).toHaveLength(1)
    expect(conferme()).toHaveLength(1)
    // E il motivo della rinuncia si legge nell'aggregato, non in duemila righe di log.
    expect(campiDi('auto-rinuncia')).toContainEqual(
      expect.objectContaining({ tipo: 'voce_gia_saldata', n: 1 }),
    )
  })
})

describe('import → abbinamento automatico: quando NON si scrive', () => {
  it('(b) movimento ambiguo (due combinazioni quadrano) ⇒ nessuna scrittura', async () => {
    // Tre voci dello stesso bambino, agganciate dal CODICE FISCALE in causale: 100 da
    // sola, e 60+40, fanno 100 tutt'e due. Incassare su una è SCEGLIERE, e a scegliere
    // dev'essere una persona.
    h.aperti = [
      aperto(PID_A, 100, { cf: CF_INVENTATO }),
      aperto(PID_B, 60, { cf: CF_INVENTATO }),
      aperto(PID_C, 40, { cf: CF_INVENTATO }),
    ]
    const res = await POST(post(csv([{ importo: '100,00', causale: `BONIFICO ${CF_INVENTATO} TRN 1` }])))

    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.auto_singole).toBe(0)
    expect(j.data.auto_composite).toBe(0)
    expect(j.data.auto_saltati).toBe(1)
    expect(incassiScritti()).toHaveLength(0)
    expect(conferme()).toHaveLength(0)
    expect(campiDi('auto-rinuncia')).toContainEqual(
      expect.objectContaining({ tipo: 'piu_combinazioni', n: 1 }),
    )
  })

  it('(c) marca `abbinato_auto_il` assente (DB non migrato) ⇒ fase spenta, import comunque 200', async () => {
    h.marcaErrore = { code: '42703', message: 'column riconciliazione_movimenti.abbinato_auto_il does not exist' }
    h.aperti = [aperto(PID_A, 150)]
    const res = await POST(post(csv([{ importo: '150,00', causale: `BONIFICO PER ${codiceVoce(PID_A)} TRN 1` }])))

    // L'import — che è il lavoro vero di questa rotta — riesce lo stesso.
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.nuovi).toBe(1)
    expect(j.data.auto_singole).toBe(0)
    expect(incassiScritti()).toHaveLength(0)
    expect(conferme()).toHaveLength(0)
    // Spento NON vuol dire muto: senza la marca non esiste l'annullamento in blocco.
    expect(campiDi('auto-non-disponibile')).toContainEqual(
      expect.objectContaining({ tipo: 'marca-assente' }),
    )
    expect(livelloDi('auto-non-disponibile')).toEqual(['warn'])
    expect(log('auto_abbinamento_eseguito')).toHaveLength(0)
  })

  it('(d) elenco degli aperti TRONCATO ⇒ fase spenta («una sola combinazione» sarebbe falsamente certa)', async () => {
    h.aperti = [aperto(PID_A, 150)]
    h.apertiInfiniti = true
    const res = await POST(post(csv([{ importo: '150,00', causale: `BONIFICO PER ${codiceVoce(PID_A)} TRN 1` }])))

    expect(res.status).toBe(200)
    expect((await res.json()).data.auto_singole).toBe(0)
    expect(incassiScritti()).toHaveLength(0)
    expect(campiDi('auto-non-disponibile')).toContainEqual(
      expect.objectContaining({ tipo: 'aperti-troncati' }),
    )
  })

  it('🔴 la voce è di un bambino passato per l’OBLIO GDPR ⇒ nessun incasso automatico', async () => {
    // 🔴 È LA SOLA GUARDIA, ED È UNA RIGA SOLA.
    //
    // `alunnoAnonimizzato` nasce in `riconciliazione-auto-import.ts` da
    // `p.alunno_anonimizzato_il != null`, e a valle non c'è nient'altro:
    // `registraConciliazione` filtra gli alunni non attivi SOLO su quelli derivati da
    // `voci_nuove`/`voci_ticket` — che l'automatismo manda sempre vuote, quindi quel 403
    // di qui non scatta mai — e `confermaSuVoceSingola` l'anonimizzazione non la guarda
    // affatto. Se quella riga diventasse `false`, la macchina incasserebbe da sola sul
    // fascicolo di un bambino già cancellato, col gate verde e nessuna persona in mezzo.
    //
    // ⚠️ QUESTA È LA VARIANTE DIRETTA, cioè il caso di PRODUZIONE: la colonna c'è, si
    // legge, e il dato dice «cancellato». La prova qui sotto copre l'altra, la variante
    // CIECA (il gruppo di colonne che sparisce dalla scala), che in produzione non si dà
    // quasi mai — e per un periodo è stata l'unica delle due ad avere una prova.
    // La METÀ POSITIVA è la (a): stessa identica fixture senza quella data, e incassa.
    h.aperti = [aperto(PID_A, 150, { anonimizzatoIl: '2026-01-01T00:00:00Z' })]
    const res = await POST(post(csv([{ importo: '150,00', causale: `BONIFICO PER ${codiceVoce(PID_A)} TRN 1` }])))

    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.nuovi).toBe(1)
    expect(j.data.auto_singole).toBe(0)
    expect(j.data.auto_composite).toBe(0)
    expect(j.data.auto_saltati).toBe(1)
    expect(incassiScritti()).toHaveLength(0)
    expect(conferme()).toHaveLength(0)
    // ⚠️ E LA FASE È PARTITA DAVVERO. Senza queste due righe «nessuna scrittura» sarebbe
    // vero anche per una fase spenta da una precondizione, e la prova misurerebbe
    // l'interruttore invece della guardia.
    expect(log('auto-non-disponibile')).toHaveLength(0)
    expect(campiDi('import_ok')[0]).toMatchObject({ auto_attiva: true, aperti_anonimizzati: 1 })
    expect(campiDi('auto-rinuncia')).toContainEqual(
      expect.objectContaining({ tipo: 'alunno_anonimizzato', n: 1 }),
    )
  })

  it('la voce è un CONTENITORE di rate (`tipo: padre`) ⇒ la macchina non incassa', async () => {
    // ⚠️ SI CHIAMA LA FASE DIRETTAMENTE, e non per comodità: la rotta i `padre` li toglie
    // con un `.filter(p => p.tipo !== 'padre')` PRIMA di costruire l'elenco, quindi da lì
    // questa bandiera non è nemmeno osservabile. `riconciliazione-auto-import.ts` la
    // porta esplicita (`contenitore: p.tipo === 'padre'`) proprio perché non dipenda da un
    // filtro scritto altrove — ma una rete che nessuno ha mai visto reggere diventerebbe
    // falsa in silenzio lo stesso, che è esattamente ciò da cui quel commento vuole
    // difendersi.
    //
    // 🔴 E sul ramo a VOCE SINGOLA questa bandiera è l'unica cosa in mezzo:
    // `confermaSuVoceSingola` sul contenitore non ha nessuna guardia (ce l'ha solo
    // `registraConciliazione`, 422). Incassare sul padre lo porterebbe a `pagato`
    // lasciando aperte tutte le rate figlie.
    h.aperti = [aperto(PID_A, 150, { tipo: 'padre' })]
    const esito = await faseDiretta([movimento(0, PID_A, 150)])

    expect(esito.autoSingole).toBe(0)
    expect(esito.autoComposite).toBe(0)
    expect(esito.saltati).toBe(1)
    expect(incassiScritti()).toHaveLength(0)
    expect(conferme()).toHaveLength(0)
    expect(campiDi('auto-rinuncia')).toContainEqual(
      expect.objectContaining({ tipo: 'voce_contenitore', n: 1 }),
    )
  })

  it('l’embed dell’alunno cade dalla scala ⇒ fase spenta: senza `anonimizzato_il` l’oblio non ferma più niente', async () => {
    // 🔴 LA CECITÀ CHE APRE INVECE DI CHIUDERE.
    //
    // `stato` e `anonimizzato_il` dell'alunno cadono INSIEME (stesso gradino della scala).
    // Persi quelli, `alunnoAnonimizzato` è falso su OGNI voce e la rinuncia
    // `alunno_anonimizzato` non scatta mai: la macchina incasserebbe da sola su un
    // fascicolo già passato per l'oblio GDPR, e a valle non c'è nessuna guardia che se ne
    // accorga. Su `sede_pagamento` la cecità produce una rinuncia; qui ne SPEGNE una.
    //
    // Il finto risponde 42703 a chi chiede `anonimizzato_il`: la scala scende davvero,
    // tre gradini, e le righe tornano senza quelle chiavi. La metà positiva è la prova
    // (a): stessa riga, stesso importo, con l'embed intero si abbina.
    h.apertiColonneAssenti = ['anonimizzato_il']
    h.aperti = [aperto(PID_A, 150)]
    const res = await POST(post(csv([{ importo: '150,00', causale: `BONIFICO PER ${codiceVoce(PID_A)} TRN 1` }])))

    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.nuovi).toBe(1)
    expect(j.data.auto_singole).toBe(0)
    expect(j.data.auto_saltati).toBe(1)
    expect(incassiScritti()).toHaveLength(0)
    expect(conferme()).toHaveLength(0)
    // La scala è scesa davvero fino a quel gruppo (se no la prova misurerebbe un 500).
    expect(log('degradazione_ciclo_alunno_aperti')).toHaveLength(1)
    expect(campiDi('auto-non-disponibile')).toContainEqual(
      expect.objectContaining({ tipo: 'ciclo-alunno-cieco', n: 1 }),
    )
    // E l'import dichiara su quanta parte dell'elenco è cieco, e che la fase non è partita.
    expect(campiDi('import_ok')[0]).toMatchObject({ aperti_ciclo_ignoto: 1, auto_attiva: false })
  })

  it('(h) `schools` non leggibile ⇒ fase spenta: il perimetro di sede non si indovina', async () => {
    h.errori.schools = { code: '08006', message: 'connection failure' }
    h.aperti = [aperto(PID_A, 150)]
    const res = await POST(post(csv([{ importo: '150,00', causale: `BONIFICO PER ${codiceVoce(PID_A)} TRN 1` }])))

    expect(res.status).toBe(200)
    expect((await res.json()).data.auto_singole).toBe(0)
    expect(incassiScritti()).toHaveLength(0)
    expect(campiDi('auto-non-disponibile')).toContainEqual(
      expect.objectContaining({ tipo: 'sedi-non-lette' }),
    )
  })

  it('il flag `attiva` non si legge ⇒ fase spenta: il perimetro si allargherebbe DA SOLO', async () => {
    // 🔴 È IL DEGRADO CHE NON SI VEDEVA, ed è il verso peggiore in cui può cadere
    // una fase che scrive denaro.
    //
    // Dentro `sediReali` solo la lettura di `schools` è fail-CLOSED. Il flag
    // `attiva` (il soft-delete di un plesso) si legge da `scuole` ed è
    // fail-OPEN: se quella `SELECT` fallisce — e `42703` su un DB non migrato è
    // il caso NORMALE — i plessi disattivati restano dentro `reali` e `error`
    // resta `null`. La fase non se ne accorgeva: il perimetro si allargava in
    // silenzio, `sede_fittizia` scattava meno spesso, e la macchina avrebbe
    // incassato in un plesso che l'organizzazione ha cancellato. Per un giro di
    // revisione il commento del perimetro prometteva «reali e ATTIVE … se la
    // lettura fallisce la fase non parte» mentre il codice faceva il contrario:
    // una promessa scritta e mai vista reggere.
    //
    // Adesso `sediReali` DICHIARA il degrado (`attivaDegradata`) e qui si spegne.
    // La metà positiva è la (a): stessa identica fixture con `scuole` leggibile,
    // e incassa.
    h.errori.scuole = { code: '42703', message: 'column scuole.attiva does not exist' }
    h.aperti = [aperto(PID_A, 150)]
    const res = await POST(post(csv([{ importo: '150,00', causale: `BONIFICO PER ${codiceVoce(PID_A)} TRN 1` }])))

    expect(res.status).toBe(200)
    const j = await res.json()
    // L'import — il lavoro vero della rotta — riesce lo stesso: la fase spenta è
    // un non-evento, la riga resta gialla.
    expect(j.data.nuovi).toBe(1)
    expect(j.data.auto_singole).toBe(0)
    expect(j.data.auto_saltati).toBe(1)
    expect(incassiScritti()).toHaveLength(0)
    expect(conferme()).toHaveLength(0)
    expect(campiDi('auto-non-disponibile')).toContainEqual(
      expect.objectContaining({ tipo: 'attiva-non-letta', n: 1 }),
    )
    expect(livelloDi('auto-non-disponibile')).toEqual(['warn'])
    // E la deroga non si logga: non si deroga su un perimetro di cui non ci si fida.
    expect(log('auto-perimetro-deroga')).toHaveLength(0)
  })

  it('(e) compare-and-swap perso (409) ⇒ l’import NON fallisce, si logga e si prosegue', async () => {
    h.casVinto = false
    h.aperti = [aperto(PID_A, 150)]
    const res = await POST(post(csv([{ importo: '150,00', causale: `BONIFICO PER ${codiceVoce(PID_A)} TRN 1` }])))

    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.nuovi).toBe(1)
    expect(j.data.auto_singole).toBe(0)
    expect(j.data.auto_saltati).toBe(1)
    // L'incasso era stato inserito e poi STORNATO dal modulo: la riga non resta appesa.
    expect(h.chiamate.some((c) => c.table === 'incassi' && c.op === 'delete')).toBe(true)
    // `error`, perché è il campanello che dice se il predicato mente.
    expect(livelloDi('auto-scrittura-fallita')).toEqual(['error'])
    expect(campiDi('auto-scrittura-fallita')[0]).toMatchObject({ tipo: 'singola', stato: 409 })
    // …E LO STESSO FATTO ENTRA ANCHE NELL'AGGREGATO. Le due righe non sono un
    // doppione: la `error` nomina IL movimento (è il campanello, e si guarda uno
    // per uno), l'aggregato dice QUANTE volte su questo import — che è l'unico
    // modo di accorgersi che il predicato ha smesso di dire il vero su larga
    // scala. Misurato: togliendo `rinuncia('scrittura_fallita')` restava tutto
    // verde, perché nessuna prova guardava questa metà.
    expect(campiDi('auto-rinuncia')).toContainEqual(
      expect.objectContaining({ tipo: 'scrittura_fallita', n: 1 }),
    )
  })

  it('nessuna sede REALE e attiva (solo plessi di collaudo) ⇒ fase spenta, e non un rifiuto per movimento', async () => {
    // ⚠️ NON È LA GEMELLA DI (h). Là `schools` non si legge (`sedi-non-lette`):
    // non sappiamo niente. Qui la lettura RIESCE e dice «nessun plesso reale e
    // attivo» — è l'ambiente con le sole sedi di prova, cioè il DB della CI.
    // Senza questa uscita la fase partirebbe con un perimetro vuoto e ogni
    // movimento verrebbe rifiutato dal gate di sede dei moduli, uno per uno: un
    // round-trip per riga per arrivare alla stessa risposta. Misurato:
    // spegnendo `if (perimetro.length === 0) return spenta('sedi-reali-assenti')`
    // tutto il file restava verde.
    h.sedi = []
    h.aperti = [aperto(PID_A, 150)]
    const res = await POST(post(csv([{ importo: '150,00', causale: `BONIFICO PER ${codiceVoce(PID_A)} TRN 1` }])))

    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.nuovi).toBe(1)
    expect(j.data.auto_singole).toBe(0)
    expect(j.data.auto_saltati).toBe(1)
    expect(incassiScritti()).toHaveLength(0)
    expect(conferme()).toHaveLength(0)
    expect(campiDi('auto-non-disponibile')).toContainEqual(
      expect.objectContaining({ tipo: 'sedi-reali-assenti', n: 1 }),
    )
    expect(livelloDi('auto-non-disponibile')).toEqual(['warn'])
    // E la deroga non si logga: non c'è nessun plesso su cui derogare.
    expect(log('auto-perimetro-deroga')).toHaveLength(0)
  })
})

/**
 * IL RESIDUO È QUELLO EFFETTIVO, MAI QUELLO DEL MATCHER.
 *
 * `riconciliazione-auto-import.ts` chiede il residuo a `residuoEffettivo`
 * (`importo − sconto − incassato`) e non lo ricalcola: su una voce SCONTATA quel numero e
 * `importo − importo_pagato` divergono, e chi dice «certo» userebbe lo sbagliato. Fino a
 * questa coppia di prove tutte le fixture avevano `sconto: 0`, cioè i due numeri
 * coincidevano sempre: l'invariante era dichiarata in maiuscolo e non era mai stata vista
 * fallire.
 *
 * Le due metà si tengono a vicenda — una dice che col residuo giusto SI ABBINA, l'altra
 * che con quello sbagliato non ci si prova nemmeno — e tutte e due diventano rosse se lo
 * `sconto` sparisce da quel calcolo.
 */
describe('import → abbinamento automatico: la voce SCONTATA', () => {
  /** 150 di importo, 50 di abbuono: il residuo vero è 100. */
  const scontata = () => [aperto(PID_A, 150, { sconto: 50 })]

  it('bonifico pari al residuo SCONTATO (100 su 150−50) ⇒ si abbina', async () => {
    h.aperti = scontata()
    const res = await POST(post(csv([{ importo: '100,00', causale: `BONIFICO PER ${codiceVoce(PID_A)} TRN 1` }])))

    expect(res.status).toBe(200)
    const j = await res.json()
    // Col residuo del matcher (150) questo bonifico non quadrerebbe con niente.
    expect(j.data.auto_singole).toBe(1)
    expect(j.data.auto_saltati).toBe(0)
    expect(incassiScritti()).toHaveLength(1)
    expect((incassiScritti()[0].corpo as Record<string, unknown>).pagamento_id).toBe(PID_A)
    expect(conferme()).toHaveLength(1)
  })

  it('bonifico pari all’importo PIENO (150) ⇒ la fase non ci prova nemmeno', async () => {
    // ⚠️ QUI IL DANNO NON SAREBBE UN INCASSO SBAGLIATO, ed è per questo che la prova non
    // si ferma a «non ha scritto». Col residuo del matcher la fase direbbe «certo» su una
    // voce che di aperto ha 100; la scrittura a valle la respingerebbe comunque —
    // `confermaSuVoceSingola` rilegge il pagamento CON lo sconto e risponde 409 — quindi
    // `incassiScritti()` e `conferme()` resterebbero vuoti anche con il difetto dentro.
    // Ciò che cambierebbe è che il predicato MENTIREBBE, e mentire ha una sua riga:
    // `auto-scrittura-fallita`, il campanello che esiste apposta per questo.
    h.aperti = scontata()
    const res = await POST(post(csv([{ importo: '150,00', causale: `BONIFICO PER ${codiceVoce(PID_A)} TRN 1` }])))

    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.nuovi).toBe(1)
    expect(j.data.auto_singole).toBe(0)
    expect(j.data.auto_saltati).toBe(1)
    expect(incassiScritti()).toHaveLength(0)
    expect(conferme()).toHaveLength(0)
    // 🔴 LA RIGA CHE MORDE: nessun tentativo, non «un tentativo respinto».
    expect(log('auto-scrittura-fallita')).toHaveLength(0)
    // 150 supera la somma dei residui candidati (100): è «non capiente», non «non quadra».
    expect(campiDi('auto-rinuncia')).toContainEqual(
      expect.objectContaining({ tipo: 'residuo_non_capiente', n: 1 }),
    )
  })
})

describe('import → abbinamento automatico: la composita', () => {
  /** Due voci di due fratelli, ciascuna citata dal suo codice: nessuna ambiguità. */
  const dueFratelli = () => {
    h.aperti = [
      aperto(PID_A, 100, { alunno: 'al-1', slug: 'retta' }),
      aperto(PID_B, 50, { alunno: 'al-2', slug: 'mensa' }),
    ]
    h.legami = [
      { parent_id: 'par-1', student_id: 'al-1', relation_type: 'madre' },
      { parent_id: 'par-1', student_id: 'al-2', relation_type: 'madre' },
    ]
    return csv([{ importo: '150,00', causale: `BONIFICO ${codiceVoce(PID_A)} E ${codiceVoce(PID_B)} TRN 1` }])
  }

  it('(f) la RPC riceve voci_nuove [], voci_ticket [], eccedenza 0 e abbinato_auto true', async () => {
    const res = await POST(post(dueFratelli()))

    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.auto_composite).toBe(1)
    expect(j.data.auto_singole).toBe(0)
    // L'invariante dichiarata da `EsitoFaseAuto`: `candidati = singole + composite + saltati`.
    // Senza questa riga, un `saltati` che dimenticasse le composite resterebbe verde.
    expect(j.data.auto_saltati).toBe(0)

    expect(h.rpc).toHaveLength(1)
    expect(h.rpc[0].nome).toBe('registra_transazione_contabile')
    const p = h.rpc[0].params.p as Record<string, unknown>
    // L'automatismo non crea voci, non accredita ticket, non mette niente a credito.
    expect(p.voci_nuove).toEqual([])
    expect(p.voci_ticket).toEqual([])
    expect(p.eccedenza_a_credito).toBe(0)
    // La marca la scrive la RPC, dentro il proprio compare-and-swap.
    expect(p.abbinato_auto).toBe(true)
    expect(p.pagante_parent_id).toBe('par-1')
    expect(p.voci).toEqual([
      { pagamento_id: PID_A, importo: 100 },
      { pagamento_id: PID_B, importo: 50 },
    ])
    // La sede del documento è quella della voce ÀNCORA (categoria `retta`), non quella
    // dell'operatore: in automatico non la sceglie nessuno, la decide una regola.
    // ⚠️ Qui le due voci stanno nello STESSO plesso, quindi questa riga da sola non
    // distingue la regola da «la prima riga» né da «la maggiore»: a farlo è la prova
    // cross-sede qui sotto, ed è lì che la regola è misurata davvero.
    expect(p.scuola_id).toBe(SEDE)
    expect(p.ancora_pagamento_id).toBe(PID_A)
    // L'AUDIT della composita esce nel plesso del DOCUMENTO, non in quello
    // dell'operatore: una riga di registro archiviata nel plesso sbagliato non la
    // ritrova più nessuno. (La prova cross-sede qui sotto ripete questa asserzione
    // dove i due valori divergono.)
    const auditMovimento = h.logScrittura.mock.calls
      .map((c) => c[1] as Record<string, unknown>)
      .find((a) => a.entitaTipo === 'riconciliazione_movimenti')
    expect(auditMovimento).toBeTruthy()
    expect(auditMovimento!.scuolaId).toBe(SEDE)
    expect((auditMovimento!.valoreDopo as Record<string, unknown>).automatico).toBe(true)
    // E la famiglia non viene avvisata nemmeno qui.
    expect(h.notificaEvento).not.toHaveBeenCalled()
  })

  it('🔴 due PLESSI in un bonifico solo: il documento esce dalla sede dell’ÀNCORA', async () => {
    // ⚠️ QUESTA FIXTURE HA DUE SEDI APPOSTA, ed è l'unica del file: con una sola
    // la prova non misura NIENTE. Tutte le altre composite qui dentro mettono le
    // due voci sullo stesso plesso, e lì `righe[0].scuolaId`, «la sede della voce
    // àncora» e «la sede della voce maggiore» sono lo stesso valore — tre regole
    // diverse indistinguibili, e `expect(p.scuola_id).toBe(SEDE)` resta verde
    // anche sotto la regola sbagliata. Misurato: sostituendo
    // `righe[ancora.indice].scuolaId` con `righe[0].scuolaId` in
    // `riconciliazione-auto-import.ts`, o ricalcolando l'àncora senza le
    // categorie (cioè sulla MAGGIORE), tutte le prove di questo file restavano
    // verdi. Questa cade in tutt'e due i casi.
    //
    // 🔴 E NON È UN GIALLO DI TROPPO: `scuola_id` è ciò che la RPC scrive sul
    // movimento e sulla transazione, cioè il plesso DA CUI ESCE IL DOCUMENTO
    // FISCALE. È il guasto che AGENTS.md nomina per esteso — «una route che
    // indovina la sede archivia i dati nel plesso sbagliato in silenzio» — e il
    // caso cross-sede non è un margine: l'estratto conto è uno solo per le tre
    // sedi, ed è la ragione stessa per cui questa fase si prende la deroga.
    //
    // LA DISPOSIZIONE è scelta perché i tre candidati divergano tutti:
    //  · la MENSA (100, plesso SEDE) è la prima riga della composizione, perché
    //    la causale la nomina per prima, ed è anche la MAGGIORE;
    //  · la RETTA (50, plesso SEDE2) è l'ÀNCORA, perché `proponiAncora` fa vincere
    //    la retta anche quando non è la maggiore — è la riga che dà senso fiscale
    //    al documento (detrazione 730).
    // Esito atteso: SEDE2, che non è né la prima riga né la maggiore.
    h.sedi = [{ id: SEDE, nome: 'Plesso Primo' }, { id: SEDE2, nome: 'Plesso Secondo' }]
    h.aperti = [
      aperto(PID_B, 100, { alunno: 'al-2', slug: 'mensa', sede: SEDE }),
      aperto(PID_A, 50, { alunno: 'al-1', slug: 'retta', sede: SEDE2 }),
    ]
    h.legami = [
      { parent_id: 'par-1', student_id: 'al-1', relation_type: 'madre' },
      { parent_id: 'par-1', student_id: 'al-2', relation_type: 'madre' },
    ]
    const res = await POST(post(csv([
      { importo: '150,00', causale: `BONIFICO ${codiceVoce(PID_B)} E ${codiceVoce(PID_A)} TRN 1` },
    ])))

    expect(res.status).toBe(200)
    expect((await res.json()).data.auto_composite).toBe(1)
    expect(h.rpc).toHaveLength(1)
    const p = h.rpc[0].params.p as Record<string, unknown>
    // L'ordine delle voci è quello della CAUSALE: la mensa per prima.
    expect(p.voci).toEqual([
      { pagamento_id: PID_B, importo: 100 },
      { pagamento_id: PID_A, importo: 50 },
    ])
    // 🔴 LE DUE RIGHE CHE MORDONO: l'àncora è la retta, e la sede del documento è
    // la SUA, non quella della riga che viene prima e non quella della maggiore.
    expect(p.ancora_pagamento_id).toBe(PID_A)
    expect(p.scuola_id).toBe(SEDE2)
    // E l'audit segue il documento nello stesso plesso.
    const auditMovimento = h.logScrittura.mock.calls
      .map((c) => c[1] as Record<string, unknown>)
      .find((a) => a.entitaTipo === 'riconciliazione_movimenti')
    expect(auditMovimento).toBeTruthy()
    expect(auditMovimento!.scuolaId).toBe(SEDE2)
  })

  it('(g) pagante non determinabile ⇒ niente composita, e nessuna RPC', async () => {
    const corpo = dueFratelli()
    // Nessun legame noto: l'insieme dei paganti ammessi è VUOTO. Dove la composizione
    // manuale prosegue (fail-open, perché c'è una persona che guarda il nome sulla
    // fattura), l'automatismo rifiuta.
    h.legami = []
    const res = await POST(post(corpo))

    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.auto_composite).toBe(0)
    expect(j.data.auto_saltati).toBe(1)
    expect(h.rpc).toHaveLength(0)
    expect(incassiScritti()).toHaveLength(0)
    expect(campiDi('auto-pagante-non-determinato')).toContainEqual(
      expect.objectContaining({ tipo: 'nessun-legame-noto' }),
    )
    expect(campiDi('auto-rinuncia')).toContainEqual(
      expect.objectContaining({ tipo: 'pagante_non_determinato', n: 1 }),
    )
  })

  it('(g-bis) i legami NON sono stati letti per intero ⇒ niente composita, anche se un candidato c’è', async () => {
    const corpo = dueFratelli()
    // 🔴 È L'ALTRA PORTA DEL FAIL-CLOSED, e non è la stessa di (g).
    //
    // (g) passa per l'insieme VUOTO. Qui l'insieme NON è vuoto — `student_parents` ha
    // risposto, e `par-1` è un candidato legittimo — ma il ponte runtime è caduto con un
    // errore che NON è «schema assente», quindi l'insieme può essere CORTO: `completo` è
    // falso. In produzione ci si arriva con un guasto solo, e la composizione manuale in
    // quel caso PROSEGUE (fail-open: c'è una persona che legge il nome sul documento).
    // L'automatismo no, e questa è la prova che rifiuta davvero: da quell'uuid esce
    // l'intestatario di un documento fiscale, e qui non c'è nessuno a guardarlo.
    //
    // La metà positiva è la prova (f): stessa identica fixture, con le letture sane,
    // scrive la composita.
    h.errori['legame_genitori_alunni'] = { code: '08006', message: 'connection failure' }
    const res = await POST(post(corpo))

    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.auto_composite).toBe(0)
    expect(j.data.auto_saltati).toBe(1)
    expect(h.rpc).toHaveLength(0)
    expect(incassiScritti()).toHaveLength(0)
    expect(conferme()).toHaveLength(0)
    // Il TIPO distingue le due porte: «non letti», non «nessun legame noto».
    expect(campiDi('auto-pagante-non-determinato')).toContainEqual(
      expect.objectContaining({ tipo: 'legami-non-letti' }),
    )
    expect(campiDi('auto-rinuncia')).toContainEqual(
      expect.objectContaining({ tipo: 'pagante_non_determinato', n: 1 }),
    )
  })

  it('l’ÀNCORA la dichiara la fase: la rilettura senza categoria non sposta l’intestatario', async () => {
    // La voce `retta` NON è la maggiore. Sull'elenco aperti l'àncora è PID_A (la retta
    // vince su tutto: è la riga che dà senso fiscale al documento). Alla rilettura che
    // `registraConciliazione` fa per conto suo l'embed della categoria non c'è, e un
    // ricalcolo là sceglierebbe la MAGGIORE, cioè PID_B: due voci diverse, due
    // intestatari diversi, due competenze diverse sulla stessa fattura.
    h.aperti = [
      aperto(PID_A, 50, { alunno: 'al-1', slug: 'retta' }),
      aperto(PID_B, 100, { alunno: 'al-2', slug: 'mensa' }),
    ]
    h.legami = [
      { parent_id: 'par-1', student_id: 'al-1', relation_type: 'madre' },
      { parent_id: 'par-1', student_id: 'al-2', relation_type: 'madre' },
    ]
    h.senzaCategoriaSullaRilettura = true
    const res = await POST(post(csv([
      { importo: '150,00', causale: `BONIFICO ${codiceVoce(PID_A)} E ${codiceVoce(PID_B)} TRN 1` },
    ])))

    expect(res.status).toBe(200)
    expect((await res.json()).data.auto_composite).toBe(1)
    expect(h.rpc).toHaveLength(1)
    const p = h.rpc[0].params.p as Record<string, unknown>
    // L'àncora mandata ESPLICITA vince sul ricalcolo: senza quella riga nel payload
    // uscirebbe PID_B, e la sede del documento parlerebbe di una voce e l'àncora di
    // un'altra.
    expect(p.ancora_pagamento_id).toBe(PID_A)
    expect(p.scuola_id).toBe(SEDE)
  })

  it('i conteggi quadrano con una composita in gioco: candidati = singole + composite + saltati', async () => {
    h.aperti = [
      aperto(PID_A, 100, { alunno: 'al-1', slug: 'retta' }),
      aperto(PID_B, 50, { alunno: 'al-2', slug: 'mensa' }),
      aperto(PID_C, 70, { alunno: 'al-3', cf: CF_INVENTATO }),
    ]
    h.legami = [
      { parent_id: 'par-1', student_id: 'al-1', relation_type: 'madre' },
      { parent_id: 'par-1', student_id: 'al-2', relation_type: 'madre' },
    ]
    // Due movimenti: il primo è una composita che riesce, il secondo non quadra con
    // niente (99 contro un residuo di 70) e resta alla coda manuale.
    const res = await POST(post(csv([
      { importo: '150,00', causale: `BONIFICO ${codiceVoce(PID_A)} E ${codiceVoce(PID_B)} TRN 1` },
      { importo: '99,00', causale: `BONIFICO ${CF_INVENTATO} TRN 2`, data: '06/09/2026' },
    ])))

    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.nuovi).toBe(2)
    expect(j.data.auto_composite).toBe(1)
    expect(j.data.auto_singole).toBe(0)
    // ⚠️ IL PUNTO DELLA PROVA: un `saltati` che sottraesse solo le singole direbbe 2 —
    // cioè «due movimenti restano», mentre uno è già stato incassato dalla macchina.
    expect(j.data.auto_saltati).toBe(1)
    expect(campiDi('auto_abbinamento_eseguito')[0]).toMatchObject({
      candidati: 2, esaminati: 2, auto_singole: 0, auto_composite: 1, saltati: 1,
    })
  })

  it('il pagante NON è comune ai due fratelli ⇒ niente automatismo', async () => {
    const corpo = dueFratelli()
    // Due genitori, uno per bambino: nessuno dei due può intestare il documento di
    // tutt'e due, e la macchina non sceglie.
    h.legami = [
      { parent_id: 'par-1', student_id: 'al-1', relation_type: 'madre' },
      { parent_id: 'par-2', student_id: 'al-2', relation_type: 'padre' },
    ]
    const res = await POST(post(corpo))

    expect(res.status).toBe(200)
    expect((await res.json()).data.auto_composite).toBe(0)
    expect(h.rpc).toHaveLength(0)
    expect(campiDi('auto-pagante-non-determinato')).toContainEqual(
      expect.objectContaining({ tipo: 'nessun-pagante-comune' }),
    )
  })

  it('due movimenti sulla STESSA coppia di voci: il secondo non dice «certo»', async () => {
    // È la (j) sul ramo COMPOSITO, e fino a qui non esisteva: il consumo del
    // residuo in memoria era provato solo sulla voce singola. Misurato: svuotando
    // `for (const v of verdetto.voci) consuma(v)` in `riconciliazione-auto-import.ts`
    // l'intero file restava verde — cioè la riga che la specifica chiede per nome
    // («due bonifici dello stesso file che agganciano la stessa voce devono vedere
    // il residuo aggiornato») non era una rete, era una promessa.
    //
    // Senza quel consumo il secondo bonifico direbbe «certo» sulla stessa coppia
    // già saldata: seconda RPC, seconda transazione contabile, secondo documento.
    // A valle la guardia di residuo di `registraConciliazione` rileggerebbe dal
    // database e direbbe no — ma è la guardia, non l'igiene, e qui si misura
    // l'igiene: `h.rpc` deve restare UNA.
    h.aperti = [
      aperto(PID_A, 100, { alunno: 'al-1', slug: 'retta' }),
      aperto(PID_B, 50, { alunno: 'al-2', slug: 'mensa' }),
    ]
    h.legami = [
      { parent_id: 'par-1', student_id: 'al-1', relation_type: 'madre' },
      { parent_id: 'par-1', student_id: 'al-2', relation_type: 'madre' },
    ]
    // Causale e data diverse: due righe identiche avrebbero lo stesso hash e la
    // seconda sarebbe un duplicato, cioè non entrerebbe affatto.
    const res = await POST(post(csv([
      { importo: '150,00', causale: `BONIFICO ${codiceVoce(PID_A)} E ${codiceVoce(PID_B)} TRN 1` },
      { importo: '150,00', causale: `BONIFICO ${codiceVoce(PID_A)} E ${codiceVoce(PID_B)} TRN 2`, data: '06/09/2026' },
    ])))

    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.nuovi).toBe(2)
    expect(j.data.auto_composite).toBe(1)
    expect(j.data.auto_saltati).toBe(1)
    expect(h.rpc).toHaveLength(1)
    // Il secondo trova le due voci a residuo zero, e il motivo lo dice.
    expect(campiDi('auto-rinuncia')).toContainEqual(
      expect.objectContaining({ tipo: 'voce_gia_saldata', n: 1 }),
    )
  })

  /**
   * IL RAMO DI FALLIMENTO DELLA COMPOSITA — per un giro di revisione non era provato
   * da nessuna riga, cioè `if (!esito.ok)` di `componiAutomaticamente` non veniva mai
   * percorso: `h.rpcEsito` era sempre buono, e nell'unica prova che poteva arrivarci
   * (il tetto composito) `h.scritti` veniva pre-popolato apposta per evitare il 404.
   *
   * 🔴 Misurato, una mutazione per volta: portando `riuscita: false` a `true` sul
   * ritorno del fallimento restavano **30 prove verdi su 30**, e lo stesso togliendo
   * `scritturaFallita(…)` per sostituirlo con una rinuncia muta. Il ramo non è
   * teorico — ci si arriva con 409 (CAS perso), 422 (non quadra), 403 (sede), 503
   * (RPC assente sul DB non migrato) e 500 — e una regressione lì non sarebbe un
   * giallo di troppo: una composita RIFIUTATA verrebbe contata in `auto_composite`,
   * le sue voci consumate in memoria (e allora un secondo bonifico legittimo dello
   * stesso file uscirebbe `voce_gia_saldata`, cioè sparirebbe), e l'audit
   * scriverebbe `stato: 'confermato'` con `transazione_id: null`. Tutto col gate
   * verde.
   *
   * `KV409` è l'ERRCODE con cui la RPC dichiara di aver perso il compare-and-swap:
   * `conciliazione-registra.ts` lo mappa a 409 con `CONCILIAZIONE_MOVIMENTO_CAMBIATO`.
   * La metà positiva di tutte e tre le prove è la (f): stessa fixture, RPC che
   * risponde bene, e la composita si scrive.
   */
  const rpcRifiuta = () => {
    h.rpcEsito = { data: null, error: { code: 'KV409', message: 'movimento già conciliato' } }
  }

  it('🔴 la RPC RIFIUTA la composita ⇒ non si conta, non si audita, e il campanello suona', async () => {
    const corpo = dueFratelli()
    rpcRifiuta()
    const res = await POST(post(corpo))

    expect(res.status).toBe(200)
    const j = await res.json()
    // L'import resta valido: la fase che cade è un non-evento, la riga resta gialla.
    expect(j.data.nuovi).toBe(1)
    // 🔴 LA RIGA CHE UCCIDE LA MUTAZIONE `riuscita: false` → `true`.
    expect(j.data.auto_composite).toBe(0)
    expect(j.data.auto_singole).toBe(0)
    expect(j.data.auto_saltati).toBe(1)
    // La scrittura è stata TENTATA davvero (se no la prova misurerebbe un rifiuto
    // arrivato prima, e il ramo resterebbe non percorso come lo era).
    expect(h.rpc).toHaveLength(1)
    // …e non ha lasciato niente: nessun incasso, nessuna conferma sulla riga.
    expect(incassiScritti()).toHaveLength(0)
    expect(conferme()).toHaveLength(0)
    // 🔴 NESSUNA RIGA DI AUDIT SUL MOVIMENTO. Sotto la mutazione ne uscirebbe una che
    // dice `stato: 'confermato'` con `transazione_id: null`: un registro che afferma
    // una transazione che non esiste.
    expect(
      h.logScrittura.mock.calls
        .map((c) => c[1] as Record<string, unknown>)
        .filter((a) => a.entitaTipo === 'riconciliazione_movimenti'),
    ).toHaveLength(0)
    // 🔴 IL CAMPANELLO, sul ramo composito: fino a qui l'aveva solo la singola (e).
    // `error` perché è la riga che dice se il predicato MENTE — ha detto «certo» e il
    // database ha detto no.
    expect(livelloDi('auto-scrittura-fallita')).toEqual(['error'])
    expect(campiDi('auto-scrittura-fallita')[0]).toMatchObject({
      tipo: 'composita',
      stato: 409,
      error_code: 'CONCILIAZIONE_MOVIMENTO_CAMBIATO',
      import_id: 'imp-1',
    })
    // E lo stesso fatto entra nell'aggregato: la `error` nomina IL movimento, questa
    // dice QUANTE volte su questo import.
    expect(campiDi('auto-rinuncia')).toContainEqual(
      expect.objectContaining({ tipo: 'scrittura_fallita', n: 1 }),
    )
    // La famiglia non viene avvisata nemmeno quando va male (qui non c'era niente da
    // avvisare, ed è il punto: l'assenza vale su tutt'e due gli esiti).
    expect(h.notificaEvento).not.toHaveBeenCalled()
  })

  it('🔴 composita RIFIUTATA: le voci NON si consumano, e il bonifico gemello viene rivalutato', async () => {
    // ⚠️ È LA RIGA CHE MORDE DAVVERO. Il consumo del residuo in memoria sta dentro
    // `if (fatto.riuscita && fatto.sedeDocumento)`: se ci finisse fuori — o se il
    // ritorno del fallimento dichiarasse `riuscita: true` — le due voci
    // risulterebbero saldate senza che nessuno abbia incassato niente, e il SECONDO
    // bonifico dello stesso file, legittimo e identico, uscirebbe `voce_gia_saldata`
    // invece di essere ritentato: sparirebbe dal riepilogo come «già fatto».
    //
    // Qui la RPC rifiuta tutt'e due le volte, quindi il secondo dev'essere valutato
    // daccapo e tentato daccapo: `h.rpc` DUE, e nessun `voce_gia_saldata`.
    h.aperti = [
      aperto(PID_A, 100, { alunno: 'al-1', slug: 'retta' }),
      aperto(PID_B, 50, { alunno: 'al-2', slug: 'mensa' }),
    ]
    h.legami = [
      { parent_id: 'par-1', student_id: 'al-1', relation_type: 'madre' },
      { parent_id: 'par-1', student_id: 'al-2', relation_type: 'madre' },
    ]
    rpcRifiuta()
    // Causale e data diverse: due righe identiche avrebbero lo stesso hash e la
    // seconda sarebbe un duplicato, cioè non entrerebbe affatto.
    const res = await POST(post(csv([
      { importo: '150,00', causale: `BONIFICO ${codiceVoce(PID_A)} E ${codiceVoce(PID_B)} TRN 1` },
      { importo: '150,00', causale: `BONIFICO ${codiceVoce(PID_A)} E ${codiceVoce(PID_B)} TRN 2`, data: '06/09/2026' },
    ])))

    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.nuovi).toBe(2)
    expect(j.data.auto_composite).toBe(0)
    expect(j.data.auto_saltati).toBe(2)
    // 🔴 DUE tentativi, non uno: le voci sono rimaste libere.
    expect(h.rpc).toHaveLength(2)
    expect(campiDi('auto-rinuncia')).toContainEqual(
      expect.objectContaining({ tipo: 'scrittura_fallita', n: 2 }),
    )
    // E nessuna voce risulta saldata da una scrittura che non c'è stata.
    expect(campiDi('auto-rinuncia').map((c) => c.tipo)).not.toContain('voce_gia_saldata')
    expect(incassiScritti()).toHaveLength(0)
    expect(conferme()).toHaveLength(0)
  })

  it(`🔴 una composita RIFIUTATA pesa sul tetto: ${MAX_AUTO_PER_IMPORT} tentativi, poi ci si ferma`, async () => {
    // ⚠️ LA PROVA GEMELLA DEL TETTO COMPOSITO CONTA SOLO LE RIUSCITE, e il tetto
    // conta i TENTATIVI: `if (fatto.tentata) scritture++`, non `if (fatto.riuscita)`.
    // La differenza non è teorica — è il caso peggiore: il giorno in cui la RPC
    // rifiuta tutto (schema fuori fase, CAS perso a catena), un tetto che contasse
    // solo i successi non si chiuderebbe MAI, e l'import proverebbe a scrivere su
    // tutte e 6.775 le righe di un estratto annuale in una richiesta sola — cioè
    // esattamente il timeout che costa la risposta, e con lei l'`import_id` senza il
    // quale l'annullamento in blocco non esiste.
    //
    // Si misura sul NUMERO DI TENTATIVI (`h.rpc`), che è l'unica cosa osservabile
    // quando nessuna scrittura riesce: 500, non 501.
    const quanti = MAX_AUTO_PER_IMPORT + 1
    const coppie = Array.from({ length: quanti }, (_, i) => [
      `pag-r-${String(i).padStart(4, '0')}`,
      `pag-m-${String(i).padStart(4, '0')}`,
    ])
    h.aperti = coppie.flatMap(([r, m]) => [
      aperto(r, 60, { alunno: 'al-1', slug: 'retta' }),
      aperto(m, 40, { alunno: 'al-1', slug: 'mensa' }),
    ])
    h.legami = [{ parent_id: 'par-1', student_id: 'al-1', relation_type: 'madre' }]
    const movimenti = coppie.map(([r, m], i) => ({
      ...movimento(i, r, 100),
      causale: `BONIFICO ${codiceVoce(r)} E ${codiceVoce(m)} TRN ${i}`,
    }))
    // Per la VIA DIRETTA le righe non sono passate da un insert: senza queste
    // `registraConciliazione` risponderebbe 404 PRIMA della RPC, e la prova
    // conterebbe rifiuti che non hanno mai raggiunto il database.
    for (const mov of movimenti) {
      h.scritti.set(mov.id, {
        id: mov.id, importo: mov.importo, stato: mov.stato, data_operazione: mov.dataOperazione,
      })
    }
    rpcRifiuta()
    // Orologio fermo (il default di `faseDiretta`): a fermare dev'essere il CONTEGGIO.
    const esito = await faseDiretta(movimenti)

    expect(esito.autoComposite).toBe(0)
    expect(esito.autoSingole).toBe(0)
    expect(esito.saltati).toBe(quanti)
    // 🔴 LA RIGA CHE MORDE: il 501° non viene nemmeno tentato.
    expect(h.rpc).toHaveLength(MAX_AUTO_PER_IMPORT)
    expect(campiDi('auto-budget-esaurito')[0]).toMatchObject({
      tipo: 'tetto-scritture', n: 1, scritture: MAX_AUTO_PER_IMPORT,
    })
    expect(campiDi('auto-rinuncia')).toContainEqual(
      expect.objectContaining({ tipo: 'scrittura_fallita', n: MAX_AUTO_PER_IMPORT }),
    )
  })
})

describe('import → abbinamento automatico: l’aggregato delle rinunce', () => {
  /**
   * Tre codici fiscali INVENTATI, nella forma esatta che `estraiCodiciFiscali`
   * pretende (6 lettere, 2 cifre, lettera, 2 cifre, lettera, 3 cifre, lettera).
   * Servono a tenere separate tre famiglie finte: con un codice solo i tre
   * movimenti pescherebbero dallo stesso fascicolo e i motivi si mescolerebbero.
   */
  const CF_UNO = CF_INVENTATO
  const CF_DUE = 'CCCDDD10A01H501X'
  const CF_TRE = 'EEEFFF10A01H501X'
  const PID_D = 'dddddddd-4444-4444-8444-444444444444'
  const PID_E = 'eeeeeeee-5555-4555-8555-555555555555'

  it('🔴 una riga per motivo, IN ORDINE ALFABETICO — non nell’ordine in cui i movimenti capitano', async () => {
    // Il commento accanto a `[...rinunce.keys()].sort()` promette l'ordine alfabetico
    // «così due import diversi si confrontano riga per riga». Misurato: togliendo
    // quel `.sort()` restavano 30 prove verdi su 30 — una promessa scritta e mai
    // vista reggere. Fino a qui nessuna prova produceva PIÙ DI UN motivo, quindi
    // l'ordine non era osservabile da nessuna parte.
    //
    // ⚠️ LA DISPOSIZIONE È SCELTA PERCHÉ I DUE ORDINI DIVERGANO: i tre movimenti
    // entrano nella mappa in ordine ESATTAMENTE INVERSO all'alfabetico
    // (`residuo_non_capiente`, `piu_combinazioni`, `alunno_anonimizzato`). Con un
    // ordine d'ingresso già alfabetico la prova sarebbe verde anche senza `.sort()`,
    // cioè non misurerebbe niente — è la stessa trappola della composita a sede
    // unica, dove tre regole diverse davano lo stesso valore.
    h.aperti = [
      // al-1, una voce sola da 70: un bonifico da 99 non ci sta dentro.
      aperto(PID_A, 70, { alunno: 'al-1', cf: CF_UNO }),
      // al-2, tre voci: 100 da sola e 60+40 fanno 100 tutt'e due ⇒ due combinazioni.
      aperto(PID_B, 60, { alunno: 'al-2', cf: CF_DUE }),
      aperto(PID_C, 40, { alunno: 'al-2', cf: CF_DUE }),
      aperto(PID_D, 100, { alunno: 'al-2', cf: CF_DUE }),
      // al-3, fascicolo passato per l'oblio GDPR.
      aperto(PID_E, 150, { alunno: 'al-3', cf: CF_TRE, anonimizzatoIl: '2026-01-01T00:00:00Z' }),
    ]
    const res = await POST(post(csv([
      { importo: '99,00', causale: `BONIFICO ${CF_UNO} TRN 1` },
      { importo: '100,00', causale: `BONIFICO ${CF_DUE} TRN 2`, data: '06/09/2026' },
      { importo: '150,00', causale: `BONIFICO ${CF_TRE} TRN 3`, data: '07/09/2026' },
    ])))

    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.nuovi).toBe(3)
    // Nessuno dei tre è certo: la fase è partita e non ha scritto niente.
    expect(j.data.auto_singole).toBe(0)
    expect(j.data.auto_composite).toBe(0)
    expect(j.data.auto_saltati).toBe(3)
    expect(log('auto-non-disponibile')).toHaveLength(0)

    /** I motivi NELL'ORDINE IN CUI I MOVIMENTI LI PRODUCONO: inverso dell'alfabetico. */
    const nellOrdineDeiMovimenti = ['residuo_non_capiente', 'piu_combinazioni', 'alunno_anonimizzato']
    // La rete sulla FIXTURE: se un domani qualcuno riordinasse i movimenti qui sopra
    // fino a farli entrare già in ordine alfabetico, la prova tornerebbe verde con e
    // senza `.sort()` — cioè smetterebbe di misurare senza diventare rossa. Questa
    // riga lo impedisce.
    expect([...nellOrdineDeiMovimenti].sort()).not.toEqual(nellOrdineDeiMovimenti)

    // 🔴 LA RIGA CHE MORDE: una riga per motivo, col conteggio, in ordine alfabetico.
    expect(campiDi('auto-rinuncia').map((c) => c.tipo)).toEqual([...nellOrdineDeiMovimenti].sort())
    expect(campiDi('auto-rinuncia').map((c) => c.n)).toEqual([1, 1, 1])
    expect(livelloDi('auto-rinuncia')).toEqual(['warn', 'warn', 'warn'])
  })
})

describe('import → abbinamento automatico: il perimetro di sede', () => {
  it('lavora su una sede che l’operatore NON gestisce — la deroga, e si vede nei log', async () => {
    // L'operatore scrive su `sc-operatore` (vedi il mock di `@/lib/auth/scope`); la voce
    // sta su un'altra sede REALE. L'estratto conto è uno solo per le tre sedi: senza la
    // deroga, per due plessi su tre l'automatismo non esisterebbe.
    h.aperti = [aperto(PID_A, 150)]
    const res = await POST(post(csv([{ importo: '150,00', causale: `BONIFICO PER ${codiceVoce(PID_A)} TRN 1` }])))

    expect(res.status).toBe(200)
    expect((await res.json()).data.auto_singole).toBe(1)
    expect((conferme()[0].corpo as Record<string, unknown>).scuola_id).toBe(SEDE)
    expect(campiDi('auto-perimetro-deroga')).toContainEqual(
      expect.objectContaining({ sede_id: SEDE, import_id: 'imp-1' }),
    )
  })

  it('la sede di COLLAUDO esiste in produzione, e la macchina lì non incassa', async () => {
    // ⚠️ È IL CASO CHE DISTINGUE «sedi REALI e attive» da «tutte le righe di `schools`».
    // La sede fittizia della CI (`e2e00000-…`) sta nel database di PRODUZIONE: un
    // perimetro costruito su `tutte` la comprenderebbe, e la macchina incasserebbe lì —
    // con il gate verde, perché la riga esiste davvero. La prova gemella qui sotto usa
    // una sede che `schools` non conosce affatto, e quella cadrebbe in tutt'e due i modi.
    h.sedi = [{ id: SEDE, nome: 'Plesso Primo' }, { id: SEDE_E2E, nome: 'Scuola E2E' }]
    h.aperti = [aperto(PID_A, 150, { sede: SEDE_E2E })]
    const res = await POST(post(csv([{ importo: '150,00', causale: `BONIFICO PER ${codiceVoce(PID_A)} TRN 1` }])))

    expect(res.status).toBe(200)
    expect((await res.json()).data.auto_singole).toBe(0)
    expect(incassiScritti()).toHaveLength(0)
    expect(conferme()).toHaveLength(0)
    expect(campiDi('auto-rinuncia')).toContainEqual(
      expect.objectContaining({ tipo: 'sede_fittizia', n: 1 }),
    )
    // E la deroga non la nomina: il perimetro è UNA sede, non due.
    expect(campiDi('auto-perimetro-deroga').map((c) => c.sede_id)).toEqual([SEDE])
  })

  it('voce su una sede che NON è fra quelle reali e attive ⇒ nessuna scrittura', async () => {
    // Una sede che `schools` non conosce (o disattivata, o di collaudo): una macchina
    // lì non incassa. E la voce NON si toglie dall'elenco — toglierla renderebbe «una
    // sola combinazione quadra» falsamente certo: è una bandiera, non un filtro.
    h.aperti = [aperto(PID_A, 150, { sede: 'ffffffff-9999-4999-8999-999999999999' })]
    const res = await POST(post(csv([{ importo: '150,00', causale: `BONIFICO PER ${codiceVoce(PID_A)} TRN 1` }])))

    expect(res.status).toBe(200)
    expect((await res.json()).data.auto_singole).toBe(0)
    expect(incassiScritti()).toHaveLength(0)
    expect(campiDi('auto-rinuncia')).toContainEqual(
      expect.objectContaining({ tipo: 'sede_fittizia', n: 1 }),
    )
  })
})

/**
 * GLI UUID CHE L'INSERT RESTITUISCE — il filo sottile su cui sta tutta la fase.
 *
 * Senza gli uuid appena scritti non c'è compare-and-swap, quindi non c'è abbinamento: la
 * fase riceve un elenco vuoto e non ha niente da guardare. Il modo in cui questo si rompe
 * è peggio di una fase spenta — la fase parte, non trova candidati, e scrive il log di
 * SUCCESSO dicendo «non c'era niente da abbinare» mentre le righe restano in coda. Le due
 * prove qui sotto tengono ferme le due metà: il ramo di degradazione restituisce gli uuid
 * come quello normale, e il caso degenere si conta invece di sparire.
 */
describe('import → abbinamento automatico: gli uuid appena scritti', () => {
  it('DB della CI non migrato (23502): l’insert ritenta con la sede, e la fase abbina lo stesso', async () => {
    // ⚠️ È IL RAMO CHE GIRA IN CI, cioè quello che nessuno guarda mai a mano. Se il
    // ritentativo dimenticasse il `.select('id, hash_movimento')`, `data` tornerebbe
    // `null`: nessun uuid, nessun abbinamento, e un riepilogo che dice zero.
    h.fail23502 = new Set(['riconciliazione_import', 'riconciliazione_movimenti'])
    h.aperti = [aperto(PID_A, 150)]
    const res = await POST(post(csv([{ importo: '150,00', causale: `BONIFICO PER ${codiceVoce(PID_A)} TRN 1` }])))

    expect(res.status).toBe(200)
    const j = await res.json()
    // La degradazione è avvenuta davvero (se no la prova misurerebbe il caso normale).
    expect(log('degradazione_scuola_id_movimenti')).toHaveLength(1)
    // …e il caso (a) resta IDENTICO: stesso abbinamento, stesso incasso, stessa marca.
    expect(j.data.auto_singole).toBe(1)
    expect(j.data.auto_saltati).toBe(0)
    expect(incassiScritti()).toHaveLength(1)
    expect(conferme()).toHaveLength(1)
    expect(typeof (conferme()[0].corpo as Record<string, unknown>).abbinato_auto_il).toBe('string')
    expect(log('auto-id-non-restituiti')).toHaveLength(0)
  })

  it('l’insert non restituisce gli uuid ⇒ il riepilogo NON dice «candidati: 0»', async () => {
    // Il caso degenere: la riga è scritta, l'uuid no. Non è un errore dell'import (le
    // righe ci sono, il pannello riceve il suo `import_id`), ma la fase non può toccarle.
    // 🔴 Il pericolo qui non è la fase spenta: è il log di SUCCESSO che direbbe
    // «candidati: 0, saltati: 0» mentre un movimento resta in coda — cioè l'aggregato
    // che esiste apposta per distinguere «non c'era niente» da «non è partito niente»
    // che afferma il falso.
    h.insertSenzaRighe = true
    h.aperti = [aperto(PID_A, 150)]
    const res = await POST(post(csv([{ importo: '150,00', causale: `BONIFICO PER ${codiceVoce(PID_A)} TRN 1` }])))

    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.nuovi).toBe(1)
    expect(j.data.auto_singole).toBe(0)
    // Il movimento resta alla coda manuale, e il riepilogo dell'import lo dice.
    expect(j.data.auto_saltati).toBe(1)
    expect(incassiScritti()).toHaveLength(0)
    expect(campiDi('auto-id-non-restituiti')[0]).toMatchObject({ n: 1, totali: 1 })
    expect(livelloDi('auto-id-non-restituiti')).toEqual(['warn'])
    expect(campiDi('auto_abbinamento_eseguito')[0]).toMatchObject({
      candidati: 1, esaminati: 0, auto_singole: 0, auto_composite: 0, saltati: 1, restanti: 1,
    })
  })
})

/**
 * IL BUDGET E IL TETTO SI MISURANO CHIAMANDO LA FASE DIRETTAMENTE (`faseDiretta`, in
 * testa al file) — e non è una scorciatoia: dalla rotta quell'orologio non è
 * raggiungibile (l'import non lo passa, e non deve), quindi provarlo di là vorrebbe dire
 * aspettare due minuti veri per una prova sola. Un ramo che ferma un ciclo che scrive
 * DENARO non può restare l'unico mai visto fallire.
 *
 * Sono anche la METÀ POSITIVA della via diretta: qui la fase, chiamata così, SCRIVE.
 */
describe('la fase si ferma: il budget e il tetto', () => {
  it('il BUDGET scaduto ferma il ciclo, dice quanti ne restano, e quelli scritti restano scritti', async () => {
    h.aperti = [aperto(PID_A, 100), aperto(PID_B, 100), aperto(PID_C, 100)]
    // L'orologio: fermo per le prime due letture (l'inizio e il primo giro), poi oltre
    // il budget. Così il primo movimento si abbina e il secondo non viene nemmeno
    // guardato — che è esattamente ciò che il tetto promette.
    let letture = 0
    const esito = await faseDiretta(
      [movimento(0, PID_A, 100), movimento(1, PID_B, 100), movimento(2, PID_C, 100)],
      { adesso: () => (letture++ < 2 ? 0 : BUDGET_AUTO_MS) },
    )

    expect(esito.autoSingole).toBe(1)
    expect(esito.saltati).toBe(2)
    expect(incassiScritti()).toHaveLength(1)
    expect(conferme()).toHaveLength(1)
    expect(campiDi('auto-budget-esaurito')[0]).toMatchObject({ tipo: 'tempo', n: 2 })
    expect(livelloDi('auto-budget-esaurito')).toEqual(['warn'])
    // Il riepilogo dice anche quanti non sono stati guardati affatto.
    expect(campiDi('auto_abbinamento_eseguito')[0]).toMatchObject({ candidati: 3, esaminati: 1, restanti: 2 })
  })

  it(`il TETTO di ${MAX_AUTO_PER_IMPORT} scritture per import ferma il ciclo`, async () => {
    const quanti = MAX_AUTO_PER_IMPORT + 1
    // Un movimento per voce, ciascuno col proprio codice: ogni giro è una scrittura, e
    // il tetto è l'unica cosa che può fermarli.
    const ids = Array.from({ length: quanti }, (_, i) => `pag-${String(i).padStart(4, '0')}`)
    h.aperti = ids.map((id) => aperto(id, 100))
    // L'orologio è fermo (il default di `faseDiretta`): qui a fermare deve essere il
    // CONTEGGIO, non il tempo.
    const esito = await faseDiretta(ids.map((id, i) => movimento(i, id, 100)))

    expect(esito.autoSingole).toBe(MAX_AUTO_PER_IMPORT)
    expect(esito.saltati).toBe(1)
    expect(conferme()).toHaveLength(MAX_AUTO_PER_IMPORT)
    expect(campiDi('auto-budget-esaurito')[0]).toMatchObject({ tipo: 'tetto-scritture', n: 1 })
  })

  it(`il TETTO vale anche per le COMPOSITE: ${MAX_AUTO_PER_IMPORT} transazioni, poi ci si ferma`, async () => {
    // ⚠️ LA PROVA QUI SOPRA CONTA SOLO LE SINGOLE, e il tetto le conta tutte: la
    // specifica dice «scritture», non «conferme a voce singola». Misurato:
    // togliendo `if (fatto.tentata) scritture++` dal ramo composito l'intero file
    // restava verde — cioè su un import di sole composite il tetto non esisteva, e
    // seimila transazioni contabili sarebbero uscite da una richiesta sola. Il
    // tetto non è una protezione contro l'errore (a quello pensano le guardie dei
    // moduli): è il punto oltre il quale una persona deve poter GUARDARE prima che
    // la macchina continui.
    const quanti = MAX_AUTO_PER_IMPORT + 1
    // Una coppia di voci per movimento (60 + 40 = 100), tutte dello stesso
    // bambino: così il pagante è uno solo e il caso resta quello composito.
    const coppie = Array.from({ length: quanti }, (_, i) => [
      `pag-r-${String(i).padStart(4, '0')}`,
      `pag-m-${String(i).padStart(4, '0')}`,
    ])
    h.aperti = coppie.flatMap(([r, m]) => [
      aperto(r, 60, { alunno: 'al-1', slug: 'retta' }),
      aperto(m, 40, { alunno: 'al-1', slug: 'mensa' }),
    ])
    h.legami = [{ parent_id: 'par-1', student_id: 'al-1', relation_type: 'madre' }]
    const movimenti = coppie.map(([r, m], i) => ({
      ...movimento(i, r, 100),
      causale: `BONIFICO ${codiceVoce(r)} E ${codiceVoce(m)} TRN ${i}`,
    }))
    // Per la VIA DIRETTA le righe non sono passate da un insert, e
    // `registraConciliazione` il movimento se lo rilegge per conto suo: senza
    // queste righe risponderebbe 404 e la prova misurerebbe il finto, non il tetto.
    for (const mov of movimenti) {
      h.scritti.set(mov.id, {
        id: mov.id, importo: mov.importo, stato: mov.stato, data_operazione: mov.dataOperazione,
      })
    }
    // Orologio fermo (il default di `faseDiretta`): a fermare dev'essere il
    // CONTEGGIO, non il tempo.
    const esito = await faseDiretta(movimenti)

    expect(esito.autoComposite).toBe(MAX_AUTO_PER_IMPORT)
    expect(esito.autoSingole).toBe(0)
    expect(esito.saltati).toBe(1)
    expect(h.rpc).toHaveLength(MAX_AUTO_PER_IMPORT)
    expect(campiDi('auto-budget-esaurito')[0]).toMatchObject({ tipo: 'tetto-scritture', n: 1 })
  })
})
