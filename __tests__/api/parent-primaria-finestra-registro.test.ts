import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'

// =============================================================================
// `GET /api/parent/primaria` — LA FINESTRA DEL REGISTRO SI APRE, E SOLO QUELLA.
//
// ─── LA FORMA DEL DIFETTO ────────────────────────────────────────────────────
//
// La route leggeva `registro_orario` con una finestra FISSA di 14 giorni. La
// bacheca Compiti del genitore non aveva quindi alcun modo di mostrare qualcosa
// di più vecchio: dopo una pausa — una malattia, le vacanze — il genitore
// leggeva «Nessun compito assegnato di recente» mentre il registro era pieno.
//
// ─── PERCHÉ LA PARTE PIÙ IMPORTANTE DI QUESTO FILE È L'ULTIMO `describe` ─────
//
// `/api/parent/primaria` non serve solo la bacheca Compiti: la chiamano anche
// `/parent/lezioni` e l'hook `use-child-school-type` — TRE consumatori in tutto,
// non di più: le pagine sotto `/parent/primaria/*` parlano con le sotto-route
// (`/note`, `/assenze`, `/orario`, `/valutazioni`, `/pagella`, `/scrutinio`…) e
// non con questa. Il numero non si ricopia da qui: lo rifà
// `grep -rn 'api/parent/primaria?' src`. E la stessa risposta porta valutazioni,
// note disciplinari, assenze e materie, ognuna con la PROPRIA finestra. Far leggere
// `dataDa` anche a una di quelle sarebbe una regressione SILENZIOSA: nessun
// errore, nessun log, soltanto altre schermate che cambiano contenuto perché è
// stato aggiunto un filtro alla bacheca. L'ultimo blocco confronta filtro per
// filtro le quattro raccolte con e senza `dataDa` ed è il presidio vero.
//
// ─── COME SONO VERIFICATI I FILTRI ───────────────────────────────────────────
//
// Il finto client di `../fixtures/finto-supabase` APPLICA davvero i filtri (le
// righe fuori finestra spariscono come farebbe PostgREST); qui è avvolto in un
// proxy che REGISTRA anche ogni chiamata — tabella, metodo, argomenti — così
// «il valore passato a `.gte('data', …)`» e «gli altri filtri non sono
// cambiati» sono proprietà lette, non dedotte dal contenuto della risposta.
//
// ⚠️ L'orologio è fermo (`toFake: ['Date']`): senza, la soglia del buffer
// notifica delle valutazioni (`Date.now() - bufferMin`) differirebbe di qualche
// millisecondo fra due chiamate e il confronto «i filtri sono identici» sarebbe
// impossibile da scrivere. Con l'orologio fermo il giorno atteso si può anche
// SCRIVERE per esteso invece di ricalcolarlo con le stesse funzioni della
// route, che sarebbe una tautologia.
// =============================================================================

/** L'istante in cui vive tutto il file. A Roma sono le 12:00 del 15/05/2026. */
const ADESSO = new Date('2026-05-15T10:00:00Z')
/** Oggi, nel fuso della scuola. */
const OGGI = '2026-05-15'
/** Oggi meno 14 giorni: la finestra PREIMPOSTATA della bacheca. */
const DA_PREDEFINITO = '2026-05-01'
/** Oggi meno 365 giorni: l'estremo ANCORA accettato. */
const LIMITE = '2025-05-15'
/** Un giorno più in là del tetto: va rifiutato, non clampato. */
const OLTRE_LIMITE = '2025-05-14'

const SEDE = 'aaaaaaaa-0000-4000-8000-00000000000a'
const ALUNNO = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'

/** I metodi che costruiscono il FILTRO di una query (non l'ordinamento). */
const METODI_FILTRO = new Set([
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in',
  'not', 'or', 'filter', 'match', 'contains', 'containedBy', 'overlaps',
])

type Chiamata = { tabella: string; metodo: string; args: unknown[] }

const h = vi.hoisted(() => ({
  requireParentOfStudent: vi.fn(),
  db: {} as DBFinto,
  tabelle: [] as string[],
  /** Ogni metodo invocato su una query, nell'ordine. */
  chiamate: [] as Chiamata[],
  /** Ogni `logEvento` emesso durante la chiamata: `(evento, livello, campi)`. */
  logEvento: vi.fn(),
  /**
   * LA LEVA DEL CONTEGGIO CHE NON ARRIVA.
   *
   * La route chiede `{ count: 'exact' }`, ma `count` è `number | null` e il
   * `null` è un esito possibile a 200 — e la route ha un RAMO apposta per quel
   * caso (`totale === null ? lette >= tetto : totale > lette`). Senza questa
   * leva quel ramo non lo esegue nessuno: il finto client il conteggio lo dà
   * sempre, e la mutazione che lo sostituisce con `false` resta verde.
   *
   * Accesa, il `{ count }` viene tolto agli argomenti passati al finto client —
   * la CHIAMATA registrata resta quella vera, cioè la route continua a chiedere
   * il conteggio e a non riceverlo, che è esattamente la situazione da provare.
   */
  senzaConteggio: false,
}))

vi.mock('@/lib/auth/require-parent', () => ({
  requireParentOfStudent: (...a: unknown[]) => h.requireParentOfStudent(...a),
}))

// Mock PARZIALE: si sostituisce il solo `logEvento`, e tutto il resto del modulo
// resta quello vero (`withRoute` importa dallo stesso file e continua a
// funzionare). `logEvento` non delega all'originale, e la ragione scritta qui
// prima era FALSA: diceva che a `warn` il logger vero persiste in tabella e che
// la persistenza passerebbe dal finto client di questo file. Sotto vitest non
// accade — `persisti()` esce alla prima riga (`SILENZIOSO = !!process.env.VITEST`
// in `lib/logging/logger.ts`), e delegando all'originale il file resta verde
// senza sporcare né `h.tabelle` né `h.chiamate`.
// La scelta di non delegare resta, ma per il motivo vero: la spia deve vedere
// gli argomenti COME LI PASSA LA ROUTE, senza dipendere da che cosa il logger
// vero decida di farne. (I sei campi asseriti passano comunque `redact()`
// byte-identici: verificato, qui il difetto del campo redatto non c'è.)
vi.mock('@/lib/logging/logger', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: (...a: unknown[]) => h.logEvento(...a) }
})

vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')

  /** Avvolge una query del finto client registrandone le chiamate. Il finto
   *  client continua a fare il suo lavoro: i filtri vengono APPLICATI. */
  const avvolgi = (query: object, tabella: string): object => {
    const wrapper: object = new Proxy(query as Record<string, unknown>, {
      get(bersaglio, prop, ricevitore) {
        const valore = Reflect.get(bersaglio, prop, ricevitore)
        // `then` si lascia nudo: è il terminatore dell'await, non un filtro.
        if (typeof prop !== 'string' || prop === 'then' || typeof valore !== 'function') return valore
        return (...args: unknown[]) => {
          h.chiamate.push({ tabella, metodo: prop, args })
          // La leva del conteggio assente agisce QUI, dopo la registrazione: si
          // registra ciò che la route ha chiesto, si passa al finto client ciò
          // che PostgREST avrebbe fatto non mandandolo.
          const effettivi =
            h.senzaConteggio && tabella === 'registro_orario' && prop === 'select'
              ? [args[0], { ...(args[1] as object), count: undefined }]
              : args
          const esito = (valore as (...a: unknown[]) => unknown).apply(bersaglio, effettivi)
          // I metodi di filtro restituiscono la query stessa: si continua a
          // registrare anche il resto della catena.
          return esito === bersaglio ? wrapper : esito
        }
      },
    })
    return wrapper
  }

  const client = () => {
    const vero = creaFintoSupabase(h.db, h.tabelle) as unknown as Record<string, unknown>
    return new Proxy(vero, {
      get(bersaglio, prop, ricevitore) {
        const valore = Reflect.get(bersaglio, prop, ricevitore)
        if (prop !== 'from') return valore
        const from = valore as (t: string) => object
        return (tabella: string) => avvolgi(from(tabella), tabella)
      },
    })
  }

  return { createAdminClient: async () => client(), createClient: async () => client() }
})

import { GET } from '@/app/api/parent/primaria/route'

const req = (dataDa?: string) =>
  new NextRequest(
    `http://localhost/api/parent/primaria?studentId=${ALUNNO}` +
      (dataDa === undefined ? '' : `&dataDa=${encodeURIComponent(dataDa)}`),
  )

/** Una lezione a registro. Gli allegati restano vuoti: lo Storage non c'entra
 *  con la finestra, e il finto client LANCIA se lo si tocca. */
const lezione = (id: string, data: string) => ({
  id,
  section_id: 'sec-a',
  data,
  ora_lezione: 1,
  materia: null,
  argomento: `Argomento di ${data}`,
  compiti: `Compiti di ${data}`,
  data_consegna_compiti: null,
  materie: { nome: 'Matematica' },
  firme_docenti: [],
  registro_destinatari: [],
  allegati_registro: [],
})

const dbBase = (): DBFinto => ({
  sections: [{ id: 'sec-a', scuola_id: SEDE, school_type: 'primaria' }],
  alunni: [{ id: ALUNNO, nome: 'Alfa', cognome: 'Beta', section_id: 'sec-a', scuola_id: SEDE }],
  admin_settings: [{ scuola_id: SEDE, notif_buffer_valutazioni_min: 10 }],
  registro_orario: [
    lezione('r-oggi', OGGI),
    lezione('r-dentro', '2026-05-10'), // dentro i 14 giorni
    // ⚠️ IL CONFINE, E SERVE DAVVERO UNA RIGA QUI SOPRA.
    // Datata ESATTAMENTE come l'inizio della finestra preimpostata. Senza,
    // sostituire `.gte` con `.gt` non cambia una sola riga del risultato: il
    // difetto si vedrebbe solo guardando il NOME del metodo registrato, cioè
    // leggendo la query invece dei dati. Con questa riga la mutazione la fa
    // sparire, e il test diventa rosso per il CONTENUTO.
    lezione('r-confine', DA_PREDEFINITO),
    lezione('r-fuori', '2026-04-20'), // fuori dai 14, dentro l'anno
    lezione('r-antico', '2025-04-01'), // oltre il tetto dei 365 giorni
  ],
  valutazioni: [
    {
      id: 'v-1', alunno_id: ALUNNO, materia: 'Italiano', tipo: 'orale', modalita: 'voto',
      argomento: 'Le rime', giudizio_sintetico: 'ottimo', giudizio_testo: null,
      creato_il: '2026-03-01T08:00:00.000Z',
    },
  ],
  note_disciplinari: [
    {
      id: 'n-1', alunno_id: ALUNNO, categoria: 'comportamento', testo: 'nota di prova',
      richiede_firma: false, firmata_il: null, creato_il: '2026-03-02T08:00:00.000Z',
    },
  ],
  presenze: [
    {
      id: 'p-1', alunno_id: ALUNNO, data: '2026-05-04', stato: 'assente', giustificata: true,
      giustificazione_testo: null, giust_vista_il: null,
      registrato_da: 'doc-1', giustificata_da: null,
    },
  ],
  materie: [{ id: 'm-1', section_id: 'sec-a', nome: 'Matematica', attiva: true, ordine: 1 }],
})

/** I soli filtri applicati a una tabella, nell'ordine e con i loro argomenti. */
const filtriDi = (tabella: string): string[] =>
  h.chiamate
    .filter((c) => c.tabella === tabella && METODI_FILTRO.has(c.metodo))
    .map((c) => `${c.metodo}(${JSON.stringify(c.args)})`)

/** Il valore passato a `.gte('data', …)` sulla lettura del registro. */
const gteRegistro = (): unknown => {
  const c = h.chiamate.find(
    (x) => x.tabella === 'registro_orario' && x.metodo === 'gte' && x.args[0] === 'data',
  )
  return c?.args[1]
}

/** Il tetto passato a `.limit(…)` sulla lettura del registro, come numero. */
const limiteRegistro = (): number | undefined => {
  const c = h.chiamate.find((x) => x.tabella === 'registro_orario' && x.metodo === 'limit')
  return typeof c?.args[0] === 'number' ? (c.args[0] as number) : undefined
}

/** Le tabelle su cui la route ha chiesto `{ count: … }`, e con quale modalità. */
const conteggiChiesti = (): Record<string, unknown> =>
  Object.fromEntries(
    h.chiamate
      .filter((x) => x.metodo === 'select' && (x.args[1] as { count?: unknown } | undefined)?.count)
      .map((x) => [x.tabella, (x.args[1] as { count?: unknown }).count]),
  )

async function chiama(dataDa?: string) {
  const res = await GET(req(dataDa))
  const corpo = await res.json()
  return { res, corpo }
}

async function lezioniDi(dataDa?: string): Promise<string[]> {
  const { res, corpo } = await chiama(dataDa)
  expect(res.status).toBe(200)
  return (corpo.data.lezioni as Array<{ id: string }>).map((l) => l.id)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(ADESSO)
  h.tabelle = []
  h.chiamate = []
  h.senzaConteggio = false
  h.db = dbBase()
  h.requireParentOfStudent.mockResolvedValue({ user: { id: 'gen-1', role: 'genitore' }, response: null })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('senza `dataDa` non cambia niente: la finestra resta di 14 giorni', () => {
  it('la lettura del registro parte da oggi meno 14 giorni, nel fuso della scuola', async () => {
    await lezioniDi()
    expect(gteRegistro()).toBe(DA_PREDEFINITO)
  })

  it('escono le sole lezioni dentro i 14 giorni', async () => {
    expect(await lezioniDi()).toEqual(['r-oggi', 'r-dentro', 'r-confine'])
  })

  it('il confine è INCLUSIVO: la lezione datata come il primo giorno della finestra c\'è', async () => {
    // `.gte` e non `.gt`. Questa asserzione guarda le RIGHE tornate, non il
    // nome del metodo: con `.gt` al posto di `.gte` `r-confine` sparisce.
    expect(
      await lezioniDi(),
      `la lezione del ${DA_PREDEFINITO} è dentro una finestra che parte dal ${DA_PREDEFINITO}`,
    ).toContain('r-confine')
  })
})

// ─── IL GIORNO LO DECIDE ROMA, NON UTC ───────────────────────────────────────
//
// La finestra preimpostata parte da `addGiorni(oggiFiscaleISO(), -14)`. La forma
// che sembra equivalente —
//   `new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10)`
// — lo è per ventidue ore su ventiquattro e sbaglia di un giorno nelle altre
// due: il runtime gira in UTC, e fra le 00:00 e le 02:00 italiane `toISOString()`
// è ancora a IERI. La bacheca di quella fascia mostrava quindi un giorno di
// registro in più o in meno di quello chiesto.
//
// ⚠️ QUESTI DUE CASI ESISTONO PERCHÉ SENZA DI LORO IL CAMBIO È INVISIBILE.
// Misurato rimettendo l'espressione UTC nella route: 6 file, 60 test, TUTTI
// VERDI. Un calcolo che si può sostituire con uno diverso senza far arrossire
// niente non è collaudato — è soltanto scritto. Gli altri test del file girano
// alle 12:00 di Roma, dove le due forme coincidono e non possono separarle.
//
// ⚠️ LE DATE ATTESE SONO SCRITTE PER ESTESO, NON RICALCOLATE.
// Rifarle qui con `addGiorni`/`oggiFiscaleISO` — le stesse funzioni della route
// — produrrebbe un test che misura sé stesso: resterebbe verde anche se
// entrambe sbagliassero allo stesso modo.
describe('la finestra preimpostata parte dal giorno di ROMA, non da quello di UTC', () => {
  it('alle 00:30 di Roma il giorno è già quello nuovo (UTC direbbe il precedente)', async () => {
    vi.setSystemTime(new Date('2026-05-15T22:30:00Z')) // a Roma: 16/05, 00:30 (CEST)
    const { res } = await chiama()
    expect(res.status).toBe(200)
    expect(
      gteRegistro(),
      'oggi a Roma è il 16/05: 16 meno 14 fa il 2; in UTC è ancora il 15, e uscirebbe 2026-05-01',
    ).toBe('2026-05-02')
  })

  it("a cavallo d'anno la finestra si apre nel 2026, non negli ultimi giorni del 2025", async () => {
    vi.setSystemTime(new Date('2026-01-14T23:30:00Z')) // a Roma: 15/01, 00:30 (CET)
    const { res } = await chiama()
    expect(res.status).toBe(200)
    expect(
      gteRegistro(),
      "oggi a Roma è il 15/01/2026: 15 meno 14 fa l'1; in UTC uscirebbe 2025-12-31, anno sbagliato",
    ).toBe('2026-01-01')
  })
})

describe('con `dataDa` la bacheca guarda più indietro', () => {
  it('la `.gte` usa il giorno chiesto, e la lezione più vecchia compare', async () => {
    const lezioni = await lezioniDi('2026-04-01')
    expect(gteRegistro()).toBe('2026-04-01')
    expect(lezioni).toEqual(['r-oggi', 'r-dentro', 'r-confine', 'r-fuori'])
  })

  it('un `dataDa` RECENTE stringe la finestra invece di allargarla', async () => {
    const lezioni = await lezioniDi('2026-05-12')
    expect(gteRegistro()).toBe('2026-05-12')
    expect(lezioni).toEqual(['r-oggi'])
  })

  it('anche con un `dataDa` esplicito il confine è incluso', async () => {
    // Il giorno chiesto è ESATTAMENTE quello di `r-dentro`: con `.gt` al posto
    // di `.gte` la lezione del giorno richiesto sparirebbe dalla risposta —
    // il genitore che chiede «dal 10 maggio» non vedrebbe il 10 maggio.
    expect(await lezioniDi('2026-05-10')).toEqual(['r-oggi', 'r-dentro'])
  })

  it(`al limite esatto dei 365 giorni (${LIMITE}) si legge, e la riga oltre resta fuori`, async () => {
    const lezioni = await lezioniDi(LIMITE)
    expect(gteRegistro()).toBe(LIMITE)
    expect(lezioni, 'la lezione del 2025-04-01 è più vecchia del limite').toEqual([
      'r-oggi', 'r-dentro', 'r-confine', 'r-fuori',
    ])
  })
})

describe('un `dataDa` inaccettabile è un 400, non un clamp silenzioso', () => {
  it(`oltre i 365 giorni (${OLTRE_LIMITE}) → 400, e il database non viene toccato`, async () => {
    const { res, corpo } = await chiama(OLTRE_LIMITE)
    expect(res.status).toBe(400)
    expect(JSON.stringify(corpo)).toContain('365')
    expect(h.tabelle, 'il 400 esce PRIMA di qualunque lettura').toEqual([])
    expect(h.requireParentOfStudent).not.toHaveBeenCalled()
  })

  it('un clamp travestito da successo sarebbe il difetto: niente 200 con la finestra ridotta', async () => {
    const { res } = await chiama('2020-01-01')
    expect(res.status).toBe(400)
    expect(gteRegistro(), 'nessuna query è partita').toBeUndefined()
  })

  it.each(['2026-13-01', '2026-02-30', '15/05/2026', 'ieri'])(
    '`dataDa=%s` non è una data del calendario → 400',
    async (valore) => {
      const { res } = await chiama(valore)
      expect(res.status).toBe(400)
      expect(h.tabelle).toEqual([])
    },
  )

  // ⚠️ LA STRINGA VUOTA NON STA NELL'ELENCO QUI SOPRA, ED È UNA SCELTA.
  //
  // `?dataDa=` non è un tentativo malriuscito di scrivere una data: è ciò che
  // una barra filtri lascia nell'indirizzo quando il periodo torna a «tutto» —
  // il `<select>` a «Tutti» vale `''`, e il parametro resta nella query string
  // invece di sparirne. Rispondere 400 lì significa rompere l'azione più
  // innocua della barra. `zOpzionale` lo traduce in «non specificato», che è la
  // convenzione del repo (`@/lib/validation/common`, `zPeriodo`).
  it('`dataDa` VUOTO vale «non specificato»: 200 con la finestra preimpostata', async () => {
    const { res } = await chiama('')
    expect(res.status).toBe(200)
    expect(gteRegistro(), 'la finestra è quella di chi non chiede niente').toBe(DA_PREDEFINITO)
  })

  it('un `dataDa` nel futuro è una finestra vuota, non un errore', async () => {
    const lezioni = await lezioniDi('2026-06-01')
    expect(gteRegistro()).toBe('2026-06-01')
    expect(lezioni).toEqual([])
  })
})

// ─── IL PRESIDIO CONTRO LA REGRESSIONE SILENZIOSA ────────────────────────────
describe('`dataDa` tocca SOLO `registro_orario`', () => {
  const TABELLE = ['valutazioni', 'note_disciplinari', 'presenze', 'materie', 'registro_orario']
  const istantanea = (): Record<string, string[]> =>
    Object.fromEntries(TABELLE.map((t) => [t, filtriDi(t)]))

  /** Le due chiamate — senza e con `dataDa` — con i filtri di ciascuna. */
  async function filtriDelleDueChiamate() {
    h.chiamate = []
    const { res: r1, corpo: corpoSenza } = await chiama()
    expect(r1.status).toBe(200)
    const senza = istantanea()

    h.chiamate = []
    const { res: r2, corpo: corpoCon } = await chiama('2026-04-01')
    expect(r2.status).toBe(200)
    const con = istantanea()

    return { senza, con, corpoSenza, corpoCon }
  }

  it.each(['valutazioni', 'note_disciplinari', 'presenze', 'materie'])(
    'i filtri su `%s` sono IDENTICI con e senza `dataDa`',
    async (tabella) => {
      const { senza, con } = await filtriDelleDueChiamate()
      expect(senza[tabella].length, `nessun filtro registrato su ${tabella}`).toBeGreaterThan(0)
      expect(con[tabella]).toEqual(senza[tabella])
      expect(
        con[tabella].join(' | '),
        `${tabella} non deve nemmeno nominare il giorno chiesto per il registro`,
      ).not.toContain('2026-04-01')
    },
  )

  it('il registro invece cambia, e cambia SOLO nel valore della `.gte` sulla data', async () => {
    const { senza, con } = await filtriDelleDueChiamate()
    expect(con.registro_orario).not.toEqual(senza.registro_orario)
    expect(con.registro_orario.map((f) => f.replace('2026-04-01', '«da»'))).toEqual(
      senza.registro_orario.map((f) => f.replace(DA_PREDEFINITO, '«da»')),
    )
  })

  it('le altre quattro raccolte della risposta arrivano identiche', async () => {
    const { corpoSenza, corpoCon } = await filtriDelleDueChiamate()
    for (const chiave of ['valutazioni', 'note', 'assenze', 'materie']) {
      expect(corpoCon.data[chiave], chiave).toEqual(corpoSenza.data[chiave])
      expect(corpoCon.data[chiave], `${chiave} non deve essere vuoto: un confronto fra due vuoti non prova niente`)
        .not.toEqual([])
    }
    expect(corpoCon.data.lezioni.length).toBeGreaterThan(corpoSenza.data.lezioni.length)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// IL TETTO DELLE RIGHE — il troncamento si DICHIARA, non si subisce
//
// ─── LA FORMA DEL DIFETTO, introdotta da NOI in questo stesso ramo ───────────
//
// La lettura di `registro_orario` non aveva nessun `.limit()` e nessun `count`.
// Con la finestra fissa a 14 giorni non poteva far danni; da quando la bacheca
// arriva all'anno scolastico, una classe compilata per intero (misurato in
// produzione: 5 ore al giorno per 5 giorni, ≈1.000 righe l'anno) arriva al
// `max_rows = 1000` di PostgREST, che taglia IN SILENZIO dentro un 200 — e con
// l'ordine `data DESC` a sparire è la parte più VECCHIA, cioè proprio quella che
// il genitore ha chiesto allargando il periodo.
//
// ⚠️ QUESTI CASI NON SI POSSONO SCRIVERE CON CINQUE RIGHE DI FIXTURE: il tetto
// morde solo oltre le centinaia di righe, quindi il registro qui è FITTO davvero
// (5 ore × 104 giorni = 520 righe). Un test che «verifica il troncamento» su un
// database di cinque righe è verde con e senza il `.limit()`.
// ═════════════════════════════════════════════════════════════════════════════

/** Il giorno `n` giorni prima di `OGGI`, in aritmetica UTC pura (niente fusi). */
const giorniPrima = (n: number): string =>
  new Date(Date.UTC(2026, 4, 15) - n * 86_400_000).toISOString().slice(0, 10)

/** L'id di una riga del registro fitto: ordinabile come si legge. */
const idFitto = (giorno: number, ora: number) => `r-g${String(giorno).padStart(3, '0')}-o${ora}`

/** Un registro con `giorni` giorni di lezione pieni, 5 ore ciascuno. */
const registroFitto = (giorni: number) => {
  const righe = []
  for (let g = 0; g < giorni; g++) {
    for (let o = 1; o <= 5; o++) {
      righe.push({ ...lezione(idFitto(g, o), giorniPrima(g)), ora_lezione: o })
    }
  }
  return righe
}

/** Il `max_rows` dichiarato per PostgREST: si LEGGE, non si ricopia. */
const maxRowsDichiarato = (): number => {
  const testo = readFileSync(join(process.cwd(), 'supabase/config.toml'), 'utf8')
  const trovato = /^\s*max_rows\s*=\s*(\d+)/m.exec(testo)
  if (!trovato) throw new Error('max_rows non dichiarato in supabase/config.toml')
  return Number(trovato[1])
}

describe('il tetto delle righe di registro', () => {
  it('il `.limit()` c\'è, ed è COMODAMENTE sotto il `max_rows` di PostgREST', async () => {
    await chiama()
    const limite = limiteRegistro()
    const maxRows = maxRowsDichiarato()
    // Senza tetto nostro a tagliare sarebbe PostgREST, e il suo taglio non si
    // vede: nessun errore, nessun log, una risposta 200 identica alla completa.
    expect(limite, 'la lettura del registro deve dichiarare un `.limit()`').toBeTypeOf('number')
    expect(maxRows, 'controllo positivo: il file dichiara davvero un max_rows').toBeGreaterThan(0)
    // «Comodamente», non «appena»: un tetto pari a `max_rows` sarebbe
    // indistinguibile dal suo, e un tetto appena sotto smetterebbe di esserlo il
    // giorno in cui quel numero scendesse.
    expect(limite!).toBeLessThanOrEqual(maxRows / 2)
  })

  it('il conteggio esatto si chiede SOLO sul registro, non sulle altre quattro letture', async () => {
    await chiama()
    // `count: 'exact'` è ciò che rende il taglio dichiarabile invece che
    // indovinabile. Chiederlo anche alle altre quattro sarebbe lavoro per il
    // database su finestre che nessuno tronca.
    expect(conteggiChiesti()).toEqual({ registro_orario: 'exact' })
  })
})

describe('la finestra che sta nel tetto: nessun troncamento dichiarato', () => {
  it('con tre lezioni in finestra la risposta dice «letta per intero», col totale vero', async () => {
    const { res, corpo } = await chiama()
    expect(res.status).toBe(200)
    expect(corpo.data.lezioni).toHaveLength(3)
    expect(corpo.data.finestraRegistro).toEqual({ troncata: false, lette: 3, totale: 3 })
  })

  it('un registro fitto che sta ESATTAMENTE nel tetto non è troncato', async () => {
    // Il confine, e serve davvero: `totale > lette` e `totale >= lette` si
    // separano solo qui. Con `>=` questo caso direbbe «troncata» avendo letto
    // tutto, cioè manderebbe la bacheca a scusarsi di niente.
    const limite = (await chiama(), limiteRegistro())!
    h.db.registro_orario = registroFitto(limite / 5)
    h.chiamate = []
    const { corpo } = await chiama('2026-01-01')
    expect(corpo.data.lezioni).toHaveLength(limite)
    expect(corpo.data.finestraRegistro).toEqual({ troncata: false, lette: limite, totale: limite })
  })
})

describe('la finestra che NON ci sta: troncamento dichiarato, e il totale vero', () => {
  const GIORNI = 104 // 104 × 5 ore = 520 righe

  beforeEach(() => {
    h.db.registro_orario = registroFitto(GIORNI)
  })

  it('la risposta dichiara il troncamento e porta il totale del PERIODO, non delle righe lette', async () => {
    const { res, corpo } = await chiama('2026-01-01')
    expect(res.status).toBe(200)
    const limite = limiteRegistro()!
    const finestra = corpo.data.finestraRegistro
    expect(finestra.troncata).toBe(true)
    expect(finestra.lette, 'si legge fino al tetto, non oltre').toBe(limite)
    expect(corpo.data.lezioni).toHaveLength(limite)
    // ⚠️ L'ASSERZIONE CHE CONTA: `totale` è il conteggio del DATABASE sull'intera
    // finestra, quindi 520 e non 500. Se qualcuno lo facesse derivare dalle
    // righe lette, i due numeri coinciderebbero sempre e `troncata` non
    // potrebbe più essere vero: il campo direbbe sempre «letto tutto».
    expect(finestra.totale, 'il totale è quello del periodo, non quello letto').toBe(GIORNI * 5)
    expect(finestra.totale).toBeGreaterThan(finestra.lette)
  })

  it('a restare fuori è la parte più VECCHIA, ed è il motivo per cui va detto', async () => {
    const { corpo } = await chiama('2026-01-01')
    const ids = (corpo.data.lezioni as Array<{ id: string }>).map((l) => l.id)
    const limite = limiteRegistro()!
    const giorniLetti = limite / 5

    // Il giorno di OGGI c'è tutto…
    expect(ids).toContain(idFitto(0, 1))
    expect(ids).toContain(idFitto(giorniLetti - 1, 5))
    // …e i giorni oltre il tetto non ci sono affatto: il taglio non assottiglia
    // in modo uniforme, porta via un capo dell'intervallo.
    for (let g = giorniLetti; g < GIORNI; g++) {
      expect(ids, `il giorno ${g} (fra i più vecchi) è stato tagliato`).not.toContain(idFitto(g, 1))
    }
    // E la prima riga è la più recente: l'ordine è quello che decide QUALE capo
    // sparisce, quindi è parte del difetto, non un dettaglio di resa.
    expect(ids[0]).toBe(idFitto(0, 1))
  })

  it('le altre quattro raccolte NON sono toccate dal tetto del registro', async () => {
    // Il presidio delle altre tre pagine, nel caso peggiore: registro troncato,
    // e le altre quattro finestre che devono restare quelle di sempre.
    const { corpo } = await chiama('2026-01-01')
    expect(corpo.data.finestraRegistro.troncata, 'controllo positivo: qui il tetto morde').toBe(true)
    expect(corpo.data.valutazioni).toHaveLength(1)
    expect(corpo.data.note).toHaveLength(1)
    expect(corpo.data.assenze).toHaveLength(1)
    expect(corpo.data.materie).toHaveLength(1)
    // Nessun `.limit()` e nessun conteggio sono stati aggiunti alle altre
    // letture: il tetto riguarda il solo registro.
    expect(h.chiamate.filter((c) => c.metodo === 'limit').map((c) => c.tabella)).toEqual([
      'registro_orario',
    ])
  })
})

// ─── IL RIPIEGO: IL TETTO RIEMPITO QUANDO IL CONTEGGIO NON ARRIVA ────────────
//
// `count` è `number | null`, e il `null` è un esito possibile dentro un 200.
// Quando arriva, `troncata` è un confronto fra due numeri letti; quando NON
// arriva, l'unico indizio che resta è il tetto riempito — e la route sceglie
// deliberatamente di sbagliare da quel lato («dichiarare un troncamento che non
// c'è è meno grave che tacerne uno che c'è»).
//
// ⚠️ QUESTO RAMO NON ERA STATO VISTO FALLIRE DA NESSUNO. Misurato: sostituendo
// la condizione con `totale === null ? false : totale > lette` — cioè togliendo
// il ripiego — tutti i test di questo file restavano VERDI. Una scelta scritta
// in un commento e non provata da niente è una scelta che il primo «semplifica
// questa riga» porta via senza far arrossire nulla.
describe('il conteggio che non arriva: si ripiega sul tetto riempito', () => {
  it('registro oltre il tetto e `count` assente → troncata, con `totale: null`', async () => {
    h.db.registro_orario = registroFitto(104)
    h.senzaConteggio = true
    const { res, corpo } = await chiama('2026-01-01')
    expect(res.status).toBe(200)
    const limite = limiteRegistro()!
    expect(corpo.data.finestraRegistro).toEqual({ troncata: true, lette: limite, totale: null })
  })

  it('il conteggio la route lo CHIEDE lo stesso: è la risposta a non portarlo', async () => {
    // Controllo positivo della leva: senza questa asserzione il caso qui sopra
    // resterebbe verde anche se qualcuno togliesse `{ count: 'exact' }` dalla
    // route, cioè proverebbe il ripiego rendendolo la norma.
    h.db.registro_orario = registroFitto(104)
    h.senzaConteggio = true
    await chiama('2026-01-01')
    expect(conteggiChiesti()).toEqual({ registro_orario: 'exact' })
  })

  it('il ripiego NON è «dichiara sempre»: sotto il tetto e senza conteggio la finestra è intera', async () => {
    // L'altra metà, e serve: un ripiego che dicesse `true` senza guardare le
    // righe manderebbe la bacheca a scusarsi di un taglio mai avvenuto —
    // spegnendo per giunta l'invito ad allargare il periodo, che lì servirebbe.
    h.senzaConteggio = true
    const { res, corpo } = await chiama()
    expect(res.status).toBe(200)
    expect(corpo.data.finestraRegistro).toEqual({ troncata: false, lette: 3, totale: null })
  })
})

// ─── IL LOG DEL TRONCAMENTO ──────────────────────────────────────────────────
//
// Oggi in produzione `registro_orario` ha meno di cento righe: il tetto non
// morde, e il giorno in cui cominciasse a mordere questo `warn` sarebbe l'UNICO
// canale da cui saperlo — nessun errore, nessuna schermata rotta, una risposta
// 200 identica a quella completa. È la regola 5 di AGENTS.md vista dall'altro
// lato: senza il log, «nessuna riga» non distinguerebbe «non tronca mai» da
// «tronca e non lo sa nessuno».
//
// ⚠️ ANCHE QUESTO RAMO NON ERA STATO VISTO PARTIRE. Misurato: con `if (false)`
// al posto di `if (troncata)` il file restava tutto verde.
describe('il troncamento lascia una traccia, e la lascia una volta sola', () => {
  /** Le sole chiamate a `logEvento` che parlano di questo troncamento. */
  const tracce = () =>
    h.logEvento.mock.calls.filter(
      (c) => (c[2] as { esito?: unknown } | undefined)?.esito === 'finestra-registro-troncata',
    )

  it('la finestra troncata emette UN `warn`, con sezione, tetto, lette e totale', async () => {
    h.db.registro_orario = registroFitto(104)
    const { corpo } = await chiama('2026-01-01')
    expect(corpo.data.finestraRegistro.troncata, 'controllo positivo: qui il tetto morde').toBe(true)

    const righe = tracce()
    expect(righe, 'una sola riga: il log non si ripete per lezione').toHaveLength(1)
    const [evento, livello, campi] = righe[0] as [string, string, Record<string, unknown>]
    expect(evento).toBe('registro')
    // `warn` e non `info`: una riga che non deve comparire mai, e che quando
    // compare è il segnale da cui si decide se alzare il tetto.
    expect(livello).toBe('warn')
    expect(campi).toMatchObject({
      operazione: 'parent/primaria:GET',
      sezione: 'sec-a',
      limite: limiteRegistro()!,
      n_lette: limiteRegistro()!,
      n_totale: 104 * 5,
    })
  })

  it('senza conteggio il log parte lo stesso, col totale a `null`', async () => {
    h.db.registro_orario = registroFitto(104)
    h.senzaConteggio = true
    await chiama('2026-01-01')
    expect(tracce()).toHaveLength(1)
    expect((tracce()[0] as unknown[])[2]).toMatchObject({ n_totale: null })
  })

  it('la finestra letta per intero NON logga niente: è ciò che rende leggibile il silenzio', async () => {
    const { corpo } = await chiama()
    expect(corpo.data.finestraRegistro.troncata).toBe(false)
    expect(tracce(), 'un warn che parte sempre non informa più di un warn che non parte mai').toHaveLength(0)
  })
})

// ─── LE DUE RACCOLTE SENZA TETTO, E IL FATTO CHE CI RESTANO APPOSTA ──────────
//
// `presenze` ha una finestra vera (30 giorni + `limitaAiFatti`) e `materie` è
// limitata per costruzione. Le altre due no: `valutazioni` ha il solo estremo
// SUPERIORE del buffer notifica — che nasconde il troppo recente, non limita
// quanto indietro si legge — e `note_disciplinari` non ha nessun filtro di data.
// Nessuna delle due ha `.limit()` né `count`.
//
// Oggi non fanno danni (misurato in produzione il 2026-09-19 con due
// `max(count(*))` per alunno: 4 valutazioni e 12 note nel caso peggiore, e il
// loro consumatore `PrimariaParentView` non è montato da nessuna pagina), e
// chiuderle cambierebbe un payload che questo ramo ha promesso di non toccare.
//
// ⚠️ QUESTI DUE CASI NON CHIEDONO UNA CORREZIONE: chiedono che la scelta non
// venga ribaltata IN SILENZIO. Il giorno in cui qualcuno «uniformasse» anche
// queste letture al tetto del registro, il rosso arriva qui invece che a una
// famiglia cui sparisce mezza pagella.
describe('`valutazioni` e `note_disciplinari` restano senza tetto: è una scelta, non una svista', () => {
  /** `n` valutazioni già visibili (scritte prima del buffer notifica). */
  const valutazioniFitte = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `v-${i}`, alunno_id: ALUNNO, materia: 'Italiano', tipo: 'orale', modalita: 'voto',
      argomento: `Prova ${i}`, giudizio_sintetico: 'ottimo', giudizio_testo: null,
      creato_il: `2026-03-01T08:00:00.${String(i % 1000).padStart(3, '0')}Z`,
    }))

  /** `n` note disciplinari. */
  const noteFitte = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `n-${i}`, alunno_id: ALUNNO, categoria: 'comportamento', testo: `nota ${i}`,
      richiede_firma: false, firmata_il: null,
      creato_il: `2026-03-02T08:00:00.${String(i % 1000).padStart(3, '0')}Z`,
    }))

  it('più valutazioni del tetto del REGISTRO: escono tutte, nessuna è tagliata', async () => {
    // Il numero si prende dalla route, non si ricopia: è il tetto vero, e il
    // punto è proprio che su questa lettura non si applica.
    const limite = (await chiama(), limiteRegistro())!
    const quante = limite + 40
    h.db.valutazioni = valutazioniFitte(quante)
    h.chiamate = []
    const { res, corpo } = await chiama()
    expect(res.status).toBe(200)
    expect(corpo.data.valutazioni).toHaveLength(quante)
  })

  it('più note del tetto del REGISTRO: escono tutte anche quelle', async () => {
    const limite = (await chiama(), limiteRegistro())!
    const quante = limite + 40
    h.db.note_disciplinari = noteFitte(quante)
    h.chiamate = []
    const { res, corpo } = await chiama()
    expect(res.status).toBe(200)
    expect(corpo.data.note).toHaveLength(quante)
  })

  it('il `.limit()` resta su una tabella sola, anche quando le altre sono piene', async () => {
    const limite = (await chiama(), limiteRegistro())!
    h.db.valutazioni = valutazioniFitte(limite + 40)
    h.db.note_disciplinari = noteFitte(limite + 40)
    h.db.registro_orario = registroFitto(104)
    h.chiamate = []
    await chiama('2026-01-01')
    expect(
      h.chiamate.filter((c) => c.metodo === 'limit').map((c) => c.tabella),
      'chi aggiunge un tetto alle altre due deve venire a cambiare anche questa riga, e il commento della route accanto',
    ).toEqual(['registro_orario'])
    expect(conteggiChiesti(), 'e nemmeno un conteggio: stesso motivo').toEqual({ registro_orario: 'exact' })
  })
})

describe('retrocompatibilità: chi non conosce `dataDa` non se ne accorge', () => {
  it('la risposta senza il parametro ha la forma di sempre, più il campo della finestra', async () => {
    const { res, corpo } = await chiama()
    expect(res.status).toBe(200)
    expect(corpo.success).toBe(true)
    expect(Object.keys(corpo.data).sort()).toEqual(
      [
        'assenze', 'child', 'finestraRegistro', 'lezioni', 'materie', 'note',
        'schoolType', 'valutazioni',
      ].sort(),
    )
    expect(corpo.data.schoolType).toBe('primaria')
  })

  it('una sezione che non è primaria esce con gli elenchi vuoti e senza leggere il registro', async () => {
    h.db.sections = [{ id: 'sec-a', scuola_id: SEDE, school_type: 'infanzia' }]
    const { res, corpo } = await chiama('2026-04-01')
    expect(res.status).toBe(200)
    expect(corpo.data.lezioni).toEqual([])
    expect(h.tabelle).not.toContain('registro_orario')
    // Il campo c'è anche su questo ramo: un contratto che compare e scompare
    // costringe ogni chiamante a un `?.` in più, ed è quel `?.` il posto dove il
    // troncamento torna a essere silenzioso.
    expect(corpo.data.finestraRegistro).toEqual({ troncata: false, lette: 0, totale: 0 })
  })
})
