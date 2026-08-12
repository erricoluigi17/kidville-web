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

const DOC_MIO = 'documenti/mio.pdf'
const DOC_ALTRUI = 'documenti/altrui.pdf'

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
        documento_path: DOC_MIO, cessato_il: null,
      },
      {
        utente_id: ALTRUI, fiscal_code: CF_COERENTE, document_type: 'CI', document_number: 'ZZ9999999',
        document_expiry: '2026-08-01', documento_path: DOC_ALTRUI, cessato_il: null,
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
    for (const campo of ['fiscal_code', 'document_number', 'residence_city', 'address', 'documento_path', 'birth_date']) {
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

  it('`?doc=` di un’ALTRA sede: 403 e NESSUNA firma prodotta', async () => {
    const res = await GET(get(`?doc=${encodeURIComponent(DOC_ALTRUI)}`))
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('ANAGRAFICA_PERSONALE_NON_TROVATA')
    expect(h.state.firme, 'la URL firmata è stata prodotta PRIMA del gate').toEqual([])
  })

  it('`?doc=` che non appartiene a nessuna anagrafica: 403 e nessuna firma', async () => {
    const res = await GET(get('?doc=documenti%2Finventato.pdf'))
    expect(res.status).toBe(403)
    expect(h.state.firme).toEqual([])
  })

  it('`?doc=` della propria sede: firma sul bucket privato, e vive cinque minuti', async () => {
    const res = await GET(get(`?doc=${encodeURIComponent(DOC_MIO)}`))
    expect(res.status).toBe(200)
    expect((await res.json()).url).toContain(DOC_MIO)
    expect(h.state.firme).toEqual([{ bucket: 'documenti_personale', path: DOC_MIO, secondi: 300 }])
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
