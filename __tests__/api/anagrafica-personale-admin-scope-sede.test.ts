import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import { verificaCoerenza } from '@/lib/fiscale/coerenza'

// =============================================================================
// ISOLAMENTO FRA SEDI del cruscotto «Scadenze documenti», e POVERTÀ dell'elenco.
//
// Sei cose, e nessuna è teorica in questo repo:
//
//  1. LA SEDE NON STA SULL'ANAGRAFICA. `anagrafica_personale` non ha
//     `scuola_id`: la sede vive in `utenti`. L'elenco si costruisce in due tempi
//     e il filtro di sede sta nella PRIMA query — se qualcuno un giorno leggesse
//     l'anagrafica per prima, il cruscotto porterebbe dentro il personale di
//     tutte e tre le sedi senza nessun errore da nessuna parte.
//  2. IL RUOLO SI FILTRA IN POSITIVO. `utenti.ruolo` è un `varchar` senza CHECK e
//     senza enum (misurato in produzione l'11/08/2026): un `neq('ruolo',
//     'genitore')` concede a `'Genitore'`, a `'genitore '` e a qualunque valore
//     nascesse domani. Il test mette in tabella proprio quel caso.
//  3. L'ELENCO È POVERO. Codice fiscale, numero del documento e residenza NON
//     escono in lista: escono aprendo UNA persona. È la lezione di «Moduli
//     ricevuti» (493 kB di dati sensibili verso il browser a ogni apertura di
//     pagina), e qui il dato è il numero di un documento d'identità.
//  4. `?doc=` FUORI SCOPE è respinto PRIMA della firma. Una URL firmata è
//     scaricabile SENZA sessione: produrla e poi rispondere 403 sarebbe una fuga
//     con un altro nome. Il test guarda il CONTATORE delle firme, non lo stato.
//  4-bis. `?doc=` MALFORMATO è respinto PRIMA DELLA QUERY. Lo schema `zod` di
//     quel parametro impone solo una lunghezza: la forma la decide
//     `percorsoDocumentoAmmesso`, e deve decidersi prima che quel testo entri in
//     un filtro. La prova non guarda lo status — che è lo stesso di «non
//     esiste», e deve esserlo — ma il CONTATORE delle tabelle interrogate: se è
//     zero, il gate di forma è davvero il primo.
//  5. LA COERENZA DEL CODICE FISCALE SI RICALCOLA IN LETTURA. Una colonna di
//     cache direbbe se il codice era coerente con i dati di ALLORA — e i dati
//     cambiano (cognome da nubile, luogo di nascita corretto a mano).
//  6. SCHEMA ASSENTE ⇒ 503 DICHIARATO, mai un elenco vuoto. Su questa pagina
//     «nessun documento in scadenza» si legge come «va tutto bene», ed è
//     indistinguibile da «non abbiamo guardato».
// =============================================================================

type Riga = Record<string, unknown>
interface Filtro { col: string; vals: unknown[] }

const ADMIN = { id: 'aaaaaaaa-1111-4000-8000-000000000001', role: 'admin', scuola_id: SEDE_A }

const MIA = 'dddddddd-0000-4000-8000-00000000000a'
const ALTRUI = 'dddddddd-0000-4000-8000-00000000000b'
const GENITORE_STRANO = 'dddddddd-0000-4000-8000-00000000000c'
const CESSATA = 'dddddddd-0000-4000-8000-00000000000d'
const IN_REGOLA = 'dddddddd-0000-4000-8000-00000000000e'
const SENZA_DOCUMENTO = 'dddddddd-0000-4000-8000-00000000000f'

// DUE FACCE, DUE PERCORSI. Dal 12/08/2026 (migrazione `20260812194501`) il fascicolo
// tiene `documento_fronte_path` e `documento_retro_path`: `documento_path` non esiste
// più. Il gate deve risolvere il percorso su ENTRAMBE — cercare solo il fronte
// significa negare la firma del retro di una persona della propria sede.
//
// ⚠️ I PERCORSI SONO NELLA FORMA CANONICA, e non è un vezzo: `documenti/mio.pdf` —
// che è quello che c'era — non passa `percorsoDocumentoAmmesso`, cioè da questo giro
// verrebbe respinto dal gate di FORMA prima ancora di essere cercato. Il percorso
// felice sarebbe rimasto verde per la ragione sbagliata (403 da forma invece di 200
// da firma), e le prove sulla risoluzione non avrebbero misurato più niente. La forma
// è quella che `iscrizione/personale/upload:POST` produce davvero:
// `documenti/<uuid>/<uuid>.<ext>` — misurata in produzione il 12/08/2026, dove l'unico
// percorso archiviato ha esattamente questa forma (87 caratteri).
const DOC_MIO = 'documenti/0f2b1c4e-9a3d-4f61-8b2c-7d5e6a1b0c9d/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d.pdf'
const DOC_MIO_RETRO = 'documenti/0f2b1c4e-9a3d-4f61-8b2c-7d5e6a1b0c9d/b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e.jpg'
const DOC_ALTRUI = 'documenti/1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d/c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f.pdf'

/**
 * IL PERCORSO CHE RISCRIVE IL FILTRO — la ragione per cui il gate di forma esiste.
 *
 * Con due colonne da confrontare la scrittura che viene naturale è
 * `.or('documento_fronte_path.eq.<X>,documento_retro_path.eq.<X>')`, e in quella
 * sintassi la virgola SEPARA le condizioni: un `<X>` che ne contenga una non rompe il
 * filtro, lo RISCRIVE. Questo valore è quell'attacco scritto per esteso — finisce con
 * un'estensione legittima apposta, così a respingerlo può essere solo la FORMA.
 */
const DOC_MALFORMATO =
  `${DOC_MIO},documento_retro_path.eq.${DOC_ALTRUI}`

/**
 * Il codice fiscale della persona di prova, CALCOLATO dalla stessa funzione che
 * la route usa per verificarlo — mai scritto a mano.
 *
 * Il repository è pubblico: un codice fiscale battuto a mano assomiglierebbe a
 * quello di qualcuno, e nessuno saprebbe dire di chi. Questo invece è
 * l'implicazione aritmetica di un'anagrafica inventata (`H501` è Roma: un codice
 * catastale, non un dato personale).
 */
const ANAGRAFICA_PROVA = {
  nome: 'Prova',
  cognome: 'Prova',
  sesso: 'F',
  dataNascita: '1990-01-01',
  codiceBelfiore: 'H501',
}
const CF_COERENTE = verificaCoerenza('', ANAGRAFICA_PROVA).codiceAtteso ?? ''

const h = vi.hoisted(() => {
  const state = {
    utente: null as { id: string; role: string; scuola_id: string } | null,
    scuole: [] as string[],
    tabelle: {} as Record<string, Riga[]>,
    letture: [] as { table: string; cols: string; filtri: Filtro[] }[],
    /**
     * OGNI `from(<tabella>)`, anche quando la query poi fallisce o non viene mai
     * eseguita. `letture` non basta a provare che il gate di forma venga PRIMA:
     * registra solo le query andate a termine, quindi resterebbe vuoto anche se la
     * route costruisse il filtro e prendesse un errore. Qui si conta il gesto di
     * rivolgersi al database, che è ciò che un `doc` malformato non deve provocare.
     */
    tabelleInterrogate: [] as string[],
    firme: [] as { bucket: string; path: string; secondi: number }[],
    erroreTabella: null as null | { code?: string; message: string },
  }
  return { state, requireStaff: vi.fn(), logScrittura: vi.fn(), logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }
})

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: async () => h.state.scuole,
  // Realistico invece che sempre-null: il gate del dettaglio è metà di ciò che
  // questo file misura, e un mock che concede sempre lo renderebbe cieco.
  assertUtenteInScope: async (_c: unknown, _u: unknown, id: string) => {
    const riga = (h.state.tabelle.utenti ?? []).find((r) => r.id === id)
    if (!riga) return NextResponse.json({ error: 'Utente non trovato' }, { status: 404 })
    if (!h.state.scuole.includes(riga.scuola_id as string)) {
      return NextResponse.json({ error: 'Utente fuori dal tuo plesso' }, { status: 403 })
    }
    return null
  },
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/logging/logger', () => ({ logEvento: h.logEvento, logErrore: h.logErrore, logOk: h.logOk }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => finto(),
  createClient: async () => finto(),
}))

function proietta(r: Riga, cols: string): Riga {
  if (!cols || cols.trim() === '*') return { ...r }
  const fuori: Riga = {}
  for (const c of cols.split(',').map((s) => s.trim()).filter(Boolean)) if (c in r) fuori[c] = r[c]
  return fuori
}

function finto() {
  const righeDi = (t: string) => (h.state.tabelle[t] ??= [])
  return {
    from(table: string) {
      h.state.tabelleInterrogate.push(table)
      const filtri: Filtro[] = []
      let cols = '*'
      const corrisponde = (r: Riga) => filtri.every((f) => f.vals.some((v) => r[f.col] === v))
      const esegui = () => {
        if (table === 'anagrafica_personale' && h.state.erroreTabella) {
          return { data: [] as Riga[], error: h.state.erroreTabella }
        }
        const trovate = righeDi(table).filter(corrisponde)
        h.state.letture.push({ table, cols, filtri: filtri.map((f) => ({ ...f })) })
        return { data: trovate.map((r) => proietta(r, cols)), error: null }
      }
      const b: Record<string, unknown> = {}
      b.select = (c?: string) => { if (typeof c === 'string') cols = c; return b }
      b.eq = (col: string, val: unknown) => { filtri.push({ col, vals: [val] }); return b }
      b.in = (col: string, vals: unknown[]) => { filtri.push({ col, vals }); return b }
      b.order = () => b
      b.limit = () => b
      b.maybeSingle = async () => { const r = esegui(); return { data: r.data[0] ?? null, error: r.error } }
      b.then = (res: (v: unknown) => unknown) => Promise.resolve(esegui()).then(res)
      return b
    },
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: async (path: string, secondi: number) => {
          h.state.firme.push({ bucket, path, secondi })
          return { data: { signedUrl: `https://storage.test/${path}?token=finto` }, error: null }
        },
      }),
    },
  }
}

import { GET } from '@/app/api/admin/anagrafica-personale/route'
// Il tetto si IMPORTA e non si ribatte: un `200` scritto qui sarebbe la quarta
// dichiarazione dello stesso numero (colonna, costante, schema, prova), e la prima a
// smettere di seguire le altre.
import { DOC_MAX_LUNGHEZZA } from '@/lib/personale/percorso-documento'

const URL_ROUTE = 'http://localhost/api/admin/anagrafica-personale'
const get = (qs = '') => new NextRequest(`${URL_ROUTE}${qs}`)

const utente = (id: string, sede: string, ruolo = 'educator'): Riga => ({
  id, nome: 'Prova', cognome: 'Prova', ruolo, scuola_id: sede, email: `p.${id}@example.test`,
})

beforeEach(() => {
  vi.clearAllMocks()
  // ⚠️ TEMPO CONGELATO al 2026-08-12: le soglie di questo cruscotto sono
  // distanze fra date, e un test con date fisse e orologio vero diventa rosso da
  // solo il giorno in cui la data lo raggiunge.
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-12T09:00:00.000Z'))
  h.state.utente = ADMIN
  h.state.scuole = [SEDE_A]
  h.state.letture = []
  h.state.tabelleInterrogate = []
  h.state.firme = []
  h.state.erroreTabella = null
  h.state.tabelle = {
    utenti: [
      utente(MIA, SEDE_A),
      utente(ALTRUI, SEDE_B),
      // Un «genitore» scritto con la maiuscola: `neq('ruolo','genitore')` lo
      // lascerebbe passare, e il suo nome comparirebbe nel cruscotto del personale.
      utente(GENITORE_STRANO, SEDE_A, 'Genitore'),
      utente(CESSATA, SEDE_A),
      utente(IN_REGOLA, SEDE_A),
      utente(SENZA_DOCUMENTO, SEDE_A),
    ],
    anagrafica_personale: [
      {
        utente_id: MIA, gender: 'F', birth_date: '1990-01-01', codice_belfiore_nascita: 'H501',
        fiscal_code: CF_COERENTE, residence_city: 'Napoli', address: 'Via di Prova 1',
        document_type: 'CI', document_number: 'AB0000000', document_expiry: '2026-08-01',
        documento_fronte_path: DOC_MIO, documento_retro_path: DOC_MIO_RETRO, cessato_il: null,
      },
      {
        utente_id: ALTRUI, fiscal_code: CF_COERENTE, document_type: 'CI', document_number: 'ZZ9999999',
        document_expiry: '2026-08-01', documento_fronte_path: DOC_ALTRUI, cessato_il: null,
      },
      { utente_id: CESSATA, document_type: 'CI', document_expiry: '2020-01-01', cessato_il: '2025-06-30' },
      // Oltre l'orizzonte di 90 giorni: si CONTA, non si elenca.
      { utente_id: IN_REGOLA, document_type: 'PP', document_expiry: '2029-01-01', cessato_il: null },
    ],
  }
  h.requireStaff.mockImplementation(async () =>
    h.state.utente ? { user: h.state.utente } : { response: NextResponse.json({ error: 'x' }, { status: 401 }) },
  )
})

afterEach(() => { vi.useRealTimers() })

const idsDi = (body: { data: { utente_id: string }[] }) => body.data.map((r) => r.utente_id).sort()

describe('scadenze documenti · l’elenco è ristretto alla sede', () => {
  it('il filtro di sede sta NELLA query del personale, e l’anagrafica si legge solo per quegli id', async () => {
    const res = await GET(get())
    expect(res.status).toBe(200)
    const body = await res.json()

    const suUtenti = h.state.letture.find((l) => l.table === 'utenti')
    expect(suUtenti, 'il personale non è stato letto').toBeTruthy()
    expect(
      suUtenti!.filtri.some((f) => f.col === 'scuola_id' && f.vals.length === 1 && f.vals[0] === SEDE_A),
      'il filtro di sede non sta nella stessa query dell’elenco',
    ).toBe(true)

    const suAnagrafiche = h.state.letture.find((l) => l.table === 'anagrafica_personale')
    expect(suAnagrafiche, 'l’anagrafica non è stata letta').toBeTruthy()
    const perId = suAnagrafiche!.filtri.find((f) => f.col === 'utente_id')
    expect(perId, 'l’anagrafica è stata letta SENZA agganciarsi agli id in scope').toBeTruthy()
    expect(perId!.vals).not.toContain(ALTRUI)

    expect(idsDi(body)).not.toContain(ALTRUI)
  })

  it('il ruolo si filtra in POSITIVO: un «Genitore» con la maiuscola resta fuori', async () => {
    const body = await (await GET(get())).json()
    expect(
      idsDi(body),
      'un valore di `ruolo` non previsto è entrato nel cruscotto del personale',
    ).not.toContain(GENITORE_STRANO)

    const suUtenti = h.state.letture.find((l) => l.table === 'utenti')!
    const perRuolo = suUtenti.filtri.find((f) => f.col === 'ruolo')
    expect(perRuolo, 'il ruolo non è filtrato affatto').toBeTruthy()
    expect(perRuolo!.vals).toContain('educator')
    expect(perRuolo!.vals).not.toContain('genitore')
  })

  it('scope vuoto ⇒ elenco vuoto (mai «allora eccoti tutto»)', async () => {
    h.state.scuole = []
    const body = await (await GET(get())).json()
    expect(body.data).toEqual([])
    expect(body.inRegola).toBe(0)
  })

  it('l’elenco NON porta codice fiscale, numero del documento, residenza né percorso della scansione', async () => {
    const body = await (await GET(get())).json()
    const riga = body.data.find((r: Riga) => r.utente_id === MIA) as Riga
    for (const campo of ['fiscal_code', 'document_number', 'residence_city', 'address', 'documento_fronte_path', 'documento_retro_path', 'birth_date']) {
      expect(riga[campo], `«${campo}» esce dall’elenco: si legge aprendo la persona`).toBeUndefined()
    }
    // …e porta ciò che serve a richiamare qualcuno.
    expect(riga.cognome).toBe('Prova')
    expect(riga.ruolo).toBe('educator')
    expect(riga.document_type).toBe('CI')
    expect(riga.document_expiry).toBe('2026-08-01')
  })

  it('chi è oltre l’orizzonte si CONTA e non si elenca; chi ha il rapporto cessato esce da entrambi', async () => {
    const body = await (await GET(get())).json()
    expect(idsDi(body)).toEqual([MIA, SENZA_DOCUMENTO].sort())
    expect(body.inRegola, 'la persona in regola è finita in elenco invece che nel conteggio').toBe(1)
    expect(body.cessati).toBe(1)
    expect(idsDi(body)).not.toContain(CESSATA)
  })

  it('`oggi` arriva dal SERVER, in ora italiana: è la data con cui si contano i giorni', async () => {
    const body = await (await GET(get())).json()
    expect(body.oggi).toBe('2026-08-12')
    expect(body.orizzonteGiorni).toBe(90)
  })

  it('l’orizzonte si ALLARGA ma non scende sotto i 90 giorni dei riquadri', async () => {
    const largo = await (await GET(get('?scadenza=180'))).json()
    expect(largo.orizzonteGiorni).toBe(180)
    // Con l'orizzonte allargato la persona «in regola» entra in elenco.
    expect(largo.inRegola).toBe(1)

    const stretto = await (await GET(get('?scadenza=0'))).json()
    expect(
      stretto.orizzonteGiorni,
      'un orizzonte sotto i 90 giorni farebbe dire «zero» al riquadro dei 90 con righe in tabella',
    ).toBe(90)

    const fuoriScala = await (await GET(get('?scadenza=99999'))).json()
    expect(fuoriScala.orizzonteGiorni).toBe(365)
  })

  it('`?doc=` di un’ALTRA sede: 403, NESSUNA firma, e la STESSA risposta di «non esiste»', async () => {
    const fuoriSede = await GET(get(`?doc=${encodeURIComponent(DOC_ALTRUI)}`))
    expect(fuoriSede.status).toBe(403)
    const corpoFuoriSede = await fuoriSede.json()
    expect(corpoFuoriSede.codice).toBe('ANAGRAFICA_PERSONALE_NON_TROVATA')
    expect(h.state.firme, 'la URL firmata è stata prodotta PRIMA del gate').toEqual([])

    // Il fronte di un'altra sede e un percorso che non esiste devono uscire dalla
    // STESSA porta, con la stessa frase: distinguerli direbbe a chi non ha titolo di
    // vederla che quella persona lavora qui — e su un documento d'identità quella
    // differenza è già, da sola, un'informazione su una persona vera.
    const inventato = await GET(
      get('?doc=documenti%2F99999999-9999-4999-8999-999999999999%2F88888888-8888-4888-8888-888888888888.pdf'),
    )
    expect(inventato.status).toBe(403)
    expect(await inventato.json()).toEqual(corpoFuoriSede)
    expect(h.state.firme).toEqual([])
  })

  it('🔴 `?doc=` MALFORMATO: 403 con la stessa risposta di «non esiste», e ZERO query alla tabella', async () => {
    /**
     * IL DIFETTO CHE QUESTA RIGA IMPEDISCE. Lo schema `zod` di `?doc=` impone una
     * lunghezza e nient'altro: la forma non è vincolata. Con DUE colonne da
     * confrontare, la scrittura che viene naturale è
     * `.or('documento_fronte_path.eq.<X>,documento_retro_path.eq.<X>')`, e lì la
     * virgola SEPARA le condizioni — un `<X>` che ne contenga una non rompe il filtro,
     * lo RISCRIVE, e il gate direbbe «è della tua sede» di un documento che non lo è.
     *
     * La difesa è l'ORDINE, e questa prova misura l'ordine: il valore malformato non
     * deve arrivare a nessun filtro, quindi il contatore delle tabelle interrogate
     * deve essere VUOTO. Guardare solo lo status sarebbe cieco — un `.or()` che non
     * trova nulla risponde 403 esattamente come il gate di forma.
     */
    const res = await GET(get(`?doc=${encodeURIComponent(DOC_MALFORMATO)}`))
    expect(res.status).toBe(403)
    expect(
      h.state.tabelleInterrogate,
      'un percorso malformato è entrato in una query: il gate di forma non viene per primo',
    ).toEqual([])
    expect(h.state.firme).toEqual([])

    // …e la risposta è IDENTICA a quella di un percorso ben formato che non esiste.
    // Un messaggio diverso direbbe a chi prova che la forma, quella volta, era giusta.
    const inesistente = await GET(
      get('?doc=documenti%2F99999999-9999-4999-8999-999999999999%2F88888888-8888-4888-8888-888888888888.pdf'),
    )
    expect(res.status).toBe(inesistente.status)
    expect(await res.json()).toEqual(await inesistente.json())
  })

  // ── IL TETTO DI `?doc=`, che è il SOLO posto in cui `DOC_MAX_LUNGHEZZA` agisce ──
  //
  // `percorso-documento.ts` lo dichiara per esteso — «dove il tetto agisce DAVVERO:
  // negli schemi `zod` di `?doc=` delle due rotte admin» — e fino al 13/08/2026 nessuna
  // riga lo misurava. Mutazione eseguita quel giorno: `.max(DOC_MAX_LUNGHEZZA)` →
  // `.max(50000)` in questa rotta e nella gemella, e **39 test restavano verdi**. Chi
  // domani rimettesse `.max(500)` — che è ciò che c'era, e che il `check` di colonna
  // (`length(…) <= 200`) non potrebbe nemmeno aver scritto — non troverebbe niente di
  // rosso.
  //
  // ⚠️ LE DUE PROVE VANNO INSIEME, e separate non valgono. Sopra il tetto la risposta è
  // **400** (validazione), sotto è **403** (gate di forma): due status diversi per due
  // difese diverse, e la coppia inchioda il NUMERO da entrambi i lati — un tetto più
  // largo fa fallire la prima, uno più stretto la seconda. Con una sola delle due, metà
  // delle mutazioni sopravvive.
  it('🔴 `?doc=` OLTRE `DOC_MAX_LUNGHEZZA`: 400 di validazione, e non arriva nemmeno al gate di forma', async () => {
    // Un percorso della forma canonica ALLUNGATO nell'estensione: `[A-Za-z0-9]+` la
    // ammetterebbe lunga quanto si vuole, quindi a respingerlo può essere solo il tetto.
    const troppoLungo = DOC_MIO + 'a'.repeat(DOC_MAX_LUNGHEZZA + 1 - DOC_MIO.length)
    expect(troppoLungo.length).toBe(DOC_MAX_LUNGHEZZA + 1)

    const res = await GET(get(`?doc=${encodeURIComponent(troppoLungo)}`))

    expect(res.status, 'sopra il tetto la risposta deve essere 400: il valore non è nemmeno guardato').toBe(400)
    expect(((await res.json()).details as { path: string }[]).map((d) => d.path)).toContain('doc')
    expect(h.state.tabelleInterrogate, 'una stringa oltre il tetto è entrata in una query').toEqual([])
    expect(h.state.firme).toEqual([])
  })

  it('🔴 `?doc=` lungo ESATTAMENTE `DOC_MAX_LUNGHEZZA` passa la validazione: il tetto è quello, non uno più stretto', async () => {
    const alLimite = DOC_MIO + 'a'.repeat(DOC_MAX_LUNGHEZZA - DOC_MIO.length)
    expect(alLimite.length).toBe(DOC_MAX_LUNGHEZZA)

    const res = await GET(get(`?doc=${encodeURIComponent(alLimite)}`))

    // 403 e non 400: `zod` lo lascia passare, lo respinge il gate di FORMA (estensione
    // fuori elenco). È la prova che il numero è esattamente `DOC_MAX_LUNGHEZZA`.
    expect(res.status, 'al limite esatto la risposta è del gate di forma, non della validazione').toBe(403)
  })

  it('🔴 il rifiuto per FORMA ha un `esito` suo: è come si distingue un link vecchio da un tentativo', async () => {
    // Stessa risposta verso il client, log DIVERSO. È l'unico posto in cui la
    // differenza sopravvive, ed è la differenza che conta: `documento-non-risolto` è
    // il 404 banale di un collegamento vecchio, `documento-forma-non-valida` è
    // qualcuno che ha scritto a mano qualcosa che il prodotto non produce.
    await GET(get(`?doc=${encodeURIComponent(DOC_MALFORMATO)}`))
    const riga = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'documento-forma-non-valida',
    )
    expect(riga, 'il rifiuto per forma non lascia nessuna riga distinguibile in `app_log`').toBeTruthy()
    expect(riga?.[0]).toBe('multi_sede')
    expect(riga?.[1]).toBe('warn')

    // ⚠️ E NEL LOG NON C'È IL PERCORSO. Non porta il nome del file — la rotta di
    // caricamento lo butta via — ma resta la chiave che apre il documento d'identità
    // di una persona, e `redact()` non lo ha in lista bianca.
    const scritto = JSON.stringify([...h.logEvento.mock.calls, ...h.logErrore.mock.calls])
    expect(scritto).not.toContain(DOC_MIO)
    expect(scritto).not.toContain(DOC_ALTRUI)
  })

  it('🔴 il gate di forma NON respinge il percorso VERO: il rifiuto per tutto è un gate rotto', async () => {
    // La guardia contro l'autoinganno: una funzione che rispondesse `false` a
    // qualunque cosa renderebbe verdi tutte le prove qui sopra — verde, e con la
    // Segreteria chiusa fuori da ogni documento, che è esattamente il difetto del
    // 12/08/2026 con un altro nome.
    const res = await GET(get(`?doc=${encodeURIComponent(DOC_MIO)}`))
    expect(res.status).toBe(200)
    expect(h.state.tabelleInterrogate.length).toBeGreaterThan(0)
  })

  it('`?doc=` della propria sede: firma sul bucket privato, e vive cinque minuti', async () => {
    const res = await GET(get(`?doc=${encodeURIComponent(DOC_MIO)}`))
    expect(res.status).toBe(200)
    expect((await res.json()).url).toContain(DOC_MIO)
    expect(h.state.firme).toEqual([{ bucket: 'documenti_personale', path: DOC_MIO, secondi: 300 }])
  })

  it('🔴 anche il RETRO si firma: il gate cerca in tutte le colonne del documento', async () => {
    // IL DIFETTO CHE QUESTA RIGA IMPEDISCE, e che è già costato una volta: il gate
    // interrogava UNA colonna sola, scritta a mano. Quando la migrazione
    // `20260812194501` ha rinominato `documento_path` in `documento_fronte_path` la
    // lettura è diventata un `42703`, e su un gate fail-CLOSED un errore vale «non
    // firmo»: la Segreteria ha smesso di poter aprire qualunque documento. Con una
    // colonna sola nel codice il retro sarebbe il prossimo a sparire, in silenzio e
    // con la stessa faccia di un tentativo abusivo.
    const res = await GET(get(`?doc=${encodeURIComponent(DOC_MIO_RETRO)}`))
    expect(res.status).toBe(200)
    expect(h.state.firme).toEqual([
      { bucket: 'documenti_personale', path: DOC_MIO_RETRO, secondi: 300 },
    ])
  })

  it('🔴 DB NON MIGRATO (42703) durante il gate: 503 di indisponibilità, MAI una firma', async () => {
    /**
     * È lo stato in cui il database della CI vive per costruzione, ed è lo stato in
     * cui la PRODUZIONE si è trovata il 12/08/2026 fra la migrazione e questo codice:
     * la colonna interrogata non esiste, PostgREST risponde `42703`, e il gate — che
     * è fail-CLOSED — non sa di chi sia quel documento.
     *
     * Le due cose da tenere ferme sono in questa riga: non si firma NIENTE (non
     * sapere di chi è un documento d'identità non può voler dire consegnarlo), e la
     * risposta è 503 e non 403. Un guasto travestito da diniego manderebbe la
     * Segreteria a cercare un problema di permessi che non c'è — che è, parola per
     * parola, ciò che è successo per un giorno intero.
     */
    h.state.erroreTabella = { code: '42703', message: 'column "documento_fronte_path" does not exist' }
    const res = await GET(get(`?doc=${encodeURIComponent(DOC_MIO)}`))
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('ANAGRAFICA_PERSONALE_NON_DISPONIBILE')
    expect(h.state.firme, 'una URL firmata è stata prodotta con lo schema in errore').toEqual([])
  })

  it('`?utenteId=` di un’altra sede non apre niente', async () => {
    const res = await GET(get(`?utenteId=${ALTRUI}`))
    expect(res.status).toBe(403)
  })

  it('`?utenteId=` della propria sede apre il dettaglio, e la coerenza del CF è RICALCOLATA', async () => {
    const coerente = await (await GET(get(`?utenteId=${MIA}`))).json()
    expect(coerente.data.anagrafica.fiscal_code).toBe(CF_COERENTE)
    expect(coerente.data.coerenza.coerente, 'il codice calcolato dai dati non risulta coerente con sé stesso').toBe(true)

    // Cambia il COGNOME in `utenti` — non una colonna di stato dell'anagrafica —
    // e l'esito cambia con lui: è la prova che non c'è nessuna cache di mezzo.
    const riga = h.state.tabelle.utenti.find((u) => u.id === MIA)!
    riga.cognome = 'Diversa'
    const dopo = await (await GET(get(`?utenteId=${MIA}`))).json()
    expect(dopo.data.coerenza.coerente).toBe(false)
    expect(dopo.data.coerenza.motivi.length).toBeGreaterThan(0)
  })

  it('il dettaglio REGISTRA l’accesso: da lì escono codice fiscale e residenza di una lavoratrice', async () => {
    await GET(get(`?utenteId=${MIA}`))
    const riga = h.logEvento.mock.calls.find(
      (c) => c[0] === 'multi_sede' && (c[2] as { esito?: string })?.esito === 'anagrafica-personale-aperta',
    )
    expect(riga, 'nessuna traccia di chi ha aperto il fascicolo').toBeTruthy()
  })

  it('tabella non ancora migrata (PGRST205): 503 DICHIARATO, mai un elenco vuoto bugiardo', async () => {
    h.state.erroreTabella = { code: 'PGRST205', message: "Could not find the table 'public.anagrafica_personale'" }
    const res = await GET(get())
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.codice).toBe('ANAGRAFICA_PERSONALE_NON_DISPONIBILE')
    expect(body.data, 'un 503 non porta dati').toBeUndefined()
  })

  it('lettura fallita per un guasto vero: 503, e nessuna riga spacciata per «tutto a posto»', async () => {
    h.state.erroreTabella = { code: '08006', message: 'connection failure' }
    const res = await GET(get())
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('ANAGRAFICA_PERSONALE_NON_DISPONIBILE')
  })
})
