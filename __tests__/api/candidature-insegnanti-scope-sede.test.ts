import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import { madreSopravvive, materializzaEmbedSede, togliGliEmbed } from '../helpers/embed-sede'
import { LIMITE_ISCRIZIONI_MAX } from '@/lib/api/paginazione'

// =============================================================================
// ISOLAMENTO FRA SEDI del cockpit delle candidature, e POVERTÀ dell'elenco.
//
// Quattro cose, e nessuna è teorica in questo repo:
//
//  1. IL FILTRO DI SEDE STA NELLA STESSA QUERY dell'elenco (`.in('scuola_id', …)`),
//     non «da qualche parte nell'handler»: è l'unico posto in cui l'AND lo rende vero.
//  2. L'ELENCO È POVERO. Email, telefono, note, titolo di studio e `cv_path` NON
//     escono dalla lista: escono aprendo UNA candidatura (`?id=`). È la lezione già
//     pagata su «Moduli ricevuti» (`ModuliRicevuti.tsx:33-42`), dove il payload
//     completo di 299 domande partiva verso il browser a ogni apertura di pagina.
//  3. `?id=` DI UN'ALTRA SEDE risponde ESATTAMENTE come `?id=` inesistente: stesso
//     stato, stesso corpo. Distinguerli direbbe a chi non ha titolo che quella
//     candidatura esiste — e da lì esce il curriculum di una persona.
//  4. `?doc=` FUORI SCOPE è respinto PRIMA della firma. Una signed URL vive dieci
//     minuti ed è scaricabile senza sessione: produrla e poi rispondere 403 sarebbe
//     una fuga con un altro nome. Il test guarda il CONTATORE delle firme, non il
//     numero della risposta.
// =============================================================================

type Riga = Record<string, unknown>
interface Filtro { col: string; vals: unknown[] }

const ADMIN = { id: 'aaaaaaaa-1111-4000-8000-000000000001', role: 'admin', scuola_id: SEDE_A }

const MIA = 'dddddddd-0000-4000-8000-00000000000a'
const ALTRUI = 'dddddddd-0000-4000-8000-00000000000b'
const MAI_ESISTITA = 'dddddddd-0000-4000-8000-00000000000f'

const CV_MIO = 'candidature/cv-mio.pdf'
const CV_ALTRUI = 'candidature/cv-altrui.pdf'

const h = vi.hoisted(() => {
  const state = {
    utente: null as { id: string; role: string; scuola_id: string } | null,
    scuole: [] as string[],
    tabelle: {} as Record<string, Riga[]>,
    letture: [] as { table: string; cols: string; filtri: { col: string; vals: unknown[] }[] }[],
    firme: [] as { bucket: string; path: string }[],
    erroreTabella: null as null | { code?: string; message: string },
    /** Lo storage che non firma: bucket irraggiungibile, token scaduto, guasto. */
    erroreFirma: null as null | { message: string },
  }
  return { state, requireStaff: vi.fn(), logScrittura: vi.fn(), logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }
})

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
// ⚠️ `formaConfronto` è quella VERA, non un finto. È la funzione che decide se
// un uuid del client è la stessa sede di una letta dal database, e sostituirla
// con `(x) => x` renderebbe verde proprio il difetto che il caso «maiuscolo»
// esiste per provare: un mock che semplifica la regola prova la semplificazione.
vi.mock('@/lib/auth/scope', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/auth/scope')>()
  return { formaConfronto: vero.formaConfronto, resolveScuoleAttive: async () => h.state.scuole }
})
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/logging/logger', () => ({ logEvento: h.logEvento, logErrore: h.logErrore, logOk: h.logOk }))
vi.mock('@/lib/email/send', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/email/send')>()
  return { ...actual, sendEmailDetailed: async () => ({ ok: true, error: null }) }
})
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => finto(),
  createClient: async () => finto(),
}))

function proietta(r: Riga, cols: string): Riga {
  if (!cols || cols.trim() === '*') return { ...r }
  // Gli EMBED (`sedi:candidature_sedi(a, b)`) hanno le parentesi: si tolgono
  // prima di spezzare sulle virgole, o `scuola_id` e `stato` di dentro
  // verrebbero scambiati per colonne della candidatura.
  const senzaEmbed = togliGliEmbed(cols)
  const fuori: Riga = {}
  for (const c of senzaEmbed.split(',').map((s) => s.trim()).filter(Boolean)) if (c in r) fuori[c] = r[c]
  return fuori
}

/**
 * ─── IL FINTO SA FARE IL JOIN, E DEVE ───────────────────────────────────────
 *
 * Dal 2026-08-19 il cockpit non filtra più su `candidature_insegnanti.scuola_id`
 * ma sulle RIGHE DI SEDE, con la sintassi degli embed di PostgREST:
 *
 *     .select('id, …, candidature_sedi!inner(scuola_id), sedi:candidature_sedi(...)')
 *     .in('candidature_sedi.scuola_id', scuole)
 *
 * Un finto che ignorasse il punto in `candidature_sedi.scuola_id` cercherebbe una
 * colonna con quel nome, non la troverebbe, e il predicato non escluderebbe
 * NIENTE: ogni test d'isolamento diventerebbe verde per costruzione — cioè
 * smetterebbe di essere un test proprio mentre lo si crede più severo.
 *
 * Perciò qui il filtro col punto è modellato per quello che è: «tieni la
 * candidatura se ESISTE una sua riga di sede che corrisponde».
 */
const TABELLA_SEDI_FINTA = 'candidature_sedi'

/** Le righe di sede di una candidatura, dal magazzino del finto. */
function sediDi(h_: { state: { tabelle: Record<string, Riga[]> } }, idCandidatura: unknown): Riga[] {
  return (h_.state.tabelle[TABELLA_SEDI_FINTA] ?? []).filter((s) => s.candidatura_id === idCandidatura)
}

function finto() {
  const righeDi = (t: string) => (h.state.tabelle[t] ??= [])
  return {
    from(table: string) {
      const filtri: Filtro[] = []
      let cols = '*'
      let conteggio = false
      let patch: Riga | null = null
      /** La FINESTRA di `range(from, to)`: senza, `limit` non si può misurare. */
      let finestra: { da: number; a: number } | null = null
      const corrisponde = (r: Riga) =>
        // I filtri sulle colonne della madre, uno per uno…
        filtri.every((f) => (f.col.includes('.') ? true : f.vals.some((v) => r[f.col] === v))) &&
        // …e quelli sull'EMBED, che seguono la regola posizionale di PostgREST:
        // la madre sparisce solo se il PRIMO embed è `!inner` e il filtro non
        // gli lascia niente. Vedi `__tests__/helpers/embed-sede.ts`.
        madreSopravvive(cols, sediDi(h, r.id), filtri)
      const esegui = () => {
        if (table === 'candidature_insegnanti' && h.state.erroreTabella) {
          return { data: [] as Riga[], error: h.state.erroreTabella, count: null as number | null }
        }
        const trovate = righeDi(table).filter(corrisponde)
        if (patch) {
          for (const r of trovate) Object.assign(r, patch)
          return { data: trovate.map((r) => proietta(r, cols)), error: null, count: null }
        }
        h.state.letture.push({ table, cols, filtri: filtri.map((f) => ({ ...f })) })
        // `count` è il totale delle righe che CORRISPONDONO, non della pagina: è
        // esattamente la differenza fra «60» e «60 su 200».
        const pagina = finestra ? trovate.slice(finestra.da, finestra.a + 1) : trovate
        // OGNI embed si materializza con il proprio alias e le PROPRIE colonne:
        // il primo filtrato, gli altri interi. Non è un dettaglio di comodo — è
        // l'unico modo in cui questo finto può vedere due difetti che il
        // database vero produce e il finto di prima nascondeva: le due costanti
        // scambiate, e un embed che non chiede `stato` e quindi non lo consegna.
        return {
          data: pagina.map((r) => ({
            ...proietta(r, cols),
            ...materializzaEmbedSede(cols, sediDi(h, r.id), filtri),
          })),
          error: null,
          count: conteggio ? trovate.length : null,
        }
      }
      const b: Record<string, unknown> = {}
      b.select = (c?: string, o?: { count?: string }) => {
        if (typeof c === 'string') cols = c
        if (o?.count === 'exact') conteggio = true
        return b
      }
      b.eq = (col: string, val: unknown) => { filtri.push({ col, vals: [val] }); return b }
      b.in = (col: string, vals: unknown[]) => { filtri.push({ col, vals }); return b }
      b.order = () => b
      b.range = (da: number, a: number) => { finestra = { da, a }; return b }
      b.limit = () => b
      b.update = (v: Riga) => { patch = v; return b }
      b.maybeSingle = async () => { const r = esegui(); return { data: r.data[0] ?? null, error: r.error } }
      b.single = async () => { const r = esegui(); return { data: r.data[0] ?? null, error: r.error } }
      b.then = (res: (v: unknown) => unknown) => Promise.resolve(esegui()).then(res)
      return b
    },
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: async (path: string) => {
          if (h.state.erroreFirma) return { data: null, error: h.state.erroreFirma }
          h.state.firme.push({ bucket, path })
          return { data: { signedUrl: `https://storage.test/${path}?token=finto` }, error: null }
        },
      }),
    },
    auth: { admin: { listUsers: async () => ({ data: { users: [] }, error: null }) } },
  }
}

import { GET, PATCH } from '@/app/api/admin/candidature-insegnanti/route'

const URL_ROUTE = 'http://localhost/api/admin/candidature-insegnanti'
const get = (qs = '') => new NextRequest(`${URL_ROUTE}${qs}`)

const candidatura = (id: string, sede: string, cv: string): Riga => ({
  id,
  scuola_id: sede,
  stato: 'pending',
  nome: 'Prova',
  cognome: 'Prova',
  email: `prova.${id}@example.test`,
  telefono: '+39 000 0000000',
  gradi: ['infanzia'],
  titolo_studio: 'diploma',
  titolo_dettaglio: 'dettaglio di prova',
  anni_esperienza: 3,
  disponibilita: 'tempo_pieno',
  note: 'presentazione di prova',
  cv_path: cv,
  creata_il: '2026-08-10T08:00:00.000Z',
})

beforeEach(() => {
  vi.clearAllMocks()
  h.state.utente = ADMIN
  h.state.scuole = [SEDE_A]
  h.state.letture = []
  h.state.firme = []
  h.state.erroreTabella = null
  h.state.erroreFirma = null
  h.state.tabelle = {
    candidature_insegnanti: [candidatura(MIA, SEDE_A, CV_MIO), candidatura(ALTRUI, SEDE_B, CV_ALTRUI)],
    // ⚠️ LE RIGHE DI SEDE SONO IL CRITERIO D'ACCESSO, dal 2026-08-19: senza,
    // ogni lettura del cockpit non trova niente e i test verdi direbbero solo
    // che il magazzino era vuoto. Qui rispecchiano il backfill della migrazione —
    // una riga per candidatura, sulla sua sede di primo arrivo.
    candidature_sedi: [
      { candidatura_id: MIA, scuola_id: SEDE_A, stato: 'pending' },
      { candidatura_id: ALTRUI, scuola_id: SEDE_B, stato: 'pending' },
    ],
    schools: [{ id: SEDE_A, nome: 'Sede di Prova' }, { id: SEDE_B, nome: 'Altra Sede' }],
  }
  h.requireStaff.mockImplementation(async () =>
    h.state.utente ? { user: h.state.utente } : { response: NextResponse.json({ error: 'x' }, { status: 401 }) },
  )
})

describe('candidature insegnanti · elenco ristretto alla sede', () => {
  it('l’elenco porta solo le candidature delle sedi attive, e il filtro è NELLA query', async () => {
    const res = await GET(get())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.map((r: Riga) => r.id)).toEqual([MIA])
    expect(body.total).toBe(1)

    const lettura = h.state.letture.find((l) => l.table === 'candidature_insegnanti')
    expect(lettura, 'nessuna lettura della tabella delle candidature').toBeTruthy()
    // ⚠️ IL FILTRO È SULL'EMBED, non sulla colonna. Dal 2026-08-19
    // `candidature_insegnanti.scuola_id` è la sede di PRIMO ARRIVO e non
    // autorizza più niente: filtrare su quella non farebbe vedere di più, farebbe
    // vedere di MENO — una candidatura rivolta anche alla mia sede ma arrivata a
    // un'altra sparirebbe dal mio elenco.
    expect(
      lettura!.filtri.some(
        (f) => f.col === 'candidature_sedi.scuola_id' && f.vals.length === 1 && f.vals[0] === SEDE_A,
      ),
      'il filtro di sede non sta nella stessa query dell’elenco, o non passa dalle righe di sede',
    ).toBe(true)
  })

  it('scope vuoto ⇒ elenco vuoto (mai «allora eccoti tutto»)', async () => {
    h.state.scuole = []
    const body = await (await GET(get())).json()
    expect(body.data).toEqual([])
    expect(body.total).toBe(0)
  })

  it('l’elenco NON porta email, telefono, note, titolo di studio né il curriculum', async () => {
    const body = await (await GET(get())).json()
    const riga = body.data[0] as Riga
    for (const campo of ['email', 'telefono', 'note', 'titolo_studio', 'titolo_dettaglio', 'cv_path', 'disponibilita']) {
      expect(riga[campo], `«${campo}» esce dall’elenco: si legge aprendo la candidatura`).toBeUndefined()
    }
    // …e porta ciò che serve a riconoscerla in lista.
    expect(riga.id).toBe(MIA)
    expect(riga.stato).toBe('pending')
    expect(riga.nome).toBe('Prova')
    expect(riga.gradi).toEqual(['infanzia'])
    expect(riga.creata_il).toBeTruthy()
  })

  it('`?id=` della propria sede apre il dettaglio, curriculum compreso', async () => {
    const res = await GET(get(`?id=${MIA}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.id).toBe(MIA)
    expect(body.data.email).toBe(`prova.${MIA}@example.test`)
    expect(body.data.cv_path).toBe(CV_MIO)
  })

  it('`?id=` di un’ALTRA sede risponde come `?id=` inesistente: stesso stato, stesso corpo', async () => {
    const altrui = await GET(get(`?id=${ALTRUI}`))
    const inesistente = await GET(get(`?id=${MAI_ESISTITA}`))
    expect(altrui.status).toBe(404)
    expect(inesistente.status).toBe(404)
    const a = await altrui.json()
    const b = await inesistente.json()
    expect(a).toEqual(b)
    expect(a.codice).toBe('CANDIDATURA_NON_TROVATA')
  })

  it('`?doc=` fuori scope: 403 e NESSUNA firma prodotta', async () => {
    const res = await GET(get(`?doc=${encodeURIComponent(CV_ALTRUI)}`))
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('CANDIDATURA_NON_TROVATA')
    expect(h.state.firme, 'la signed URL è stata prodotta PRIMA del gate').toEqual([])
  })

  it('`?doc=` che non appartiene a nessuna candidatura: 403 e nessuna firma', async () => {
    const res = await GET(get('?doc=candidature/inventato.pdf'))
    expect(res.status).toBe(403)
    expect(h.state.firme).toEqual([])
  })

  it('`?doc=` della propria sede: firma prodotta sul bucket degli allegati', async () => {
    const res = await GET(get(`?doc=${encodeURIComponent(CV_MIO)}`))
    expect(res.status).toBe(200)
    expect((await res.json()).url).toContain(CV_MIO)
    expect(h.state.firme).toEqual([{ bucket: 'form_attachments', path: CV_MIO }])
  })

  it('tabella non ancora migrata (PGRST205): 503 DICHIARATO, mai un elenco vuoto bugiardo', async () => {
    h.state.erroreTabella = { code: 'PGRST205', message: "Could not find the table 'public.candidature_insegnanti'" }
    const res = await GET(get())
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.codice).toBe('CANDIDATURE_OPERAZIONE_NON_RIUSCITA')
    expect(body.data, 'un 503 non porta dati').toBeUndefined()
  })

  it('lettura del dettaglio fallita: 503, non un 404 che dice «non esiste»', async () => {
    h.state.erroreTabella = { code: '08006', message: 'connection failure' }
    const res = await GET(get(`?id=${MIA}`))
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('CANDIDATURE_OPERAZIONE_NON_RIUSCITA')
  })

  it('FIRMA fallita: 503, non il 403 che direbbe «non è tua» di un curriculum che LO È', async () => {
    // Il gate di sede è GIÀ passato: quel curriculum è della sede giusta e chi
    // guarda ne ha titolo. Se lo storage non risponde, rispondere 403 «non esiste
    // oppure è di un'altra sede» veste un guasto da diniego di permesso, e manda
    // la segreteria a cercare un problema che non c'è. Un 403 su un guasto è la
    // stessa bugia del 404 su un guasto, con un altro numero.
    h.state.erroreFirma = { message: 'storage unavailable' }
    const res = await GET(get(`?doc=${encodeURIComponent(CV_MIO)}`))
    expect(res.status, 'un guasto dello storage vestito da diniego').toBe(503)
    const body = await res.json()
    expect(body.codice).toBe('CANDIDATURE_OPERAZIONE_NON_RIUSCITA')
    expect(body.url, 'un 503 non porta una signed URL').toBeUndefined()
    // Il percorso del file — che è il nome della persona — non torna al client.
    expect(JSON.stringify(body)).not.toContain(CV_MIO)
  })

  it('`total` viene dal CONTEGGIO esatto, non dalla lunghezza della pagina', async () => {
    // Con 60 righe su 200 la lunghezza della pagina direbbe «60», e nessuno
    // saprebbe delle altre 140: la paginazione della segreteria si fermerebbe lì.
    h.state.tabelle.candidature_insegnanti = [
      candidatura('dddddddd-0000-4000-8000-000000000001', SEDE_A, 'candidature/a.pdf'),
      candidatura('dddddddd-0000-4000-8000-000000000002', SEDE_A, 'candidature/b.pdf'),
      candidatura('dddddddd-0000-4000-8000-000000000003', SEDE_A, 'candidature/c.pdf'),
    ]
    // Le righe di sede vanno rifatte insieme: sono il criterio d'accesso, e senza
    // di esse l'elenco è vuoto — un test che misurerebbe il magazzino, non la rotta.
    h.state.tabelle.candidature_sedi = h.state.tabelle.candidature_insegnanti.map((c) => ({
      candidatura_id: c.id,
      scuola_id: c.scuola_id,
      stato: 'pending',
    }))
    const body = await (await GET(get('?limit=1'))).json()
    expect(body.data).toHaveLength(1)
    expect(body.total, '`total` conta la pagina, non le righe').toBe(3)
    expect(body.limit).toBe(1)
    expect(body.offset).toBe(0)
  })

  it('`limit` è CLAMPATO agli estremi: `0` non diventa la pagina intera, `99999` non svuota la tabella', async () => {
    const zero = await (await GET(get('?limit=0'))).json()
    expect(zero.limit, '`limit=0` è caduto sul default, cioè sulla pagina intera').toBe(1)

    const enorme = await (await GET(get('?limit=999999'))).json()
    expect(enorme.limit, '`limit=999999` esce dal tetto: l’elenco intero in una risposta sola')
      .toBeLessThanOrEqual(LIMITE_ISCRIZIONI_MAX)
    expect(enorme.limit).toBe(LIMITE_ISCRIZIONI_MAX)

    // …e un `offset` negativo non risale sopra la prima riga.
    const indietro = await (await GET(get('?offset=-5'))).json()
    expect(indietro.offset).toBe(0)
  })
})

describe('candidature insegnanti · una candidatura rivolta a PIÙ sedi', () => {
  /** La candidatura ARRIVATA a B ma rivolta anche ad A, che è la mia. */
  const CONDIVISA = 'eeeeeeee-0000-4000-8000-00000000000e'

  beforeEach(() => {
    h.state.tabelle.candidature_insegnanti.push(
      candidatura(CONDIVISA, SEDE_B, 'candidature/condivisa.pdf'),
    )
    h.state.tabelle.candidature_sedi.push(
      { candidatura_id: CONDIVISA, scuola_id: SEDE_B, stato: 'pending' },
      { candidatura_id: CONDIVISA, scuola_id: SEDE_A, stato: 'pending' },
    )
  })

  it('🔴 la vedo, anche se è ARRIVATA a un’altra sede', async () => {
    // È il caso per cui tutta la multi-sede esiste. Col vecchio filtro sulla
    // colonna `scuola_id` questa candidatura sarebbe invisibile alla mia
    // segreteria — una pratica che devo valutare e che non compare in nessun
    // elenco. Non è «vedo di meno del dovuto»: è una persona senza risposta.
    const body = await (await GET(get())).json()
    expect(body.data.map((r: Riga) => r.id)).toContain(CONDIVISA)
  })

  it('compare UNA volta sola: si cerca una persona, non una pratica', async () => {
    h.state.scuole = [SEDE_A, SEDE_B] // entrambe mie
    const body = await (await GET(get())).json()
    const occorrenze = body.data.filter((r: Riga) => r.id === CONDIVISA).length
    expect(occorrenze, 'il join sdoppia la riga').toBe(1)
    expect(body.total).toBe(body.data.length)
  })

  it('la SCHEDA dice anche le sedi che non sono mie: chi valuta deve sapere', async () => {
    // Senza, due segreterie istruiscono la stessa pratica senza sapere l'una
    // dell'altra, e la persona riceve due convocazioni scoordinate.
    const body = await (await GET(get(`?id=${CONDIVISA}`))).json()
    const sedi = (body.data.sedi ?? []) as Riga[]
    expect(sedi.map((x) => x.scuola_id).sort()).toEqual([SEDE_A, SEDE_B].sort())
  })

  it('il CURRICULUM si apre, anche se la candidatura è arrivata all’altra sede', async () => {
    // Restando sulla colonna, il criterio sarebbe diventato «di chi era la prima
    // sede» invece di «chi ha titolo»: valuterei una persona senza poter leggere
    // il documento che la descrive.
    const res = await GET(get('?doc=candidature%2Fcondivisa.pdf'))
    expect(res.status).toBe(200)
  })

  it('e resta chiuso per una sede che non c’entra: il messaggio è quello del 404', async () => {
    h.state.scuole = ['ffffffff-0000-4000-8000-00000000000f']
    const res = await GET(get('?doc=candidature%2Fcondivisa.pdf'))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toContain('non esiste, oppure appartiene a un')
  })
})

// =============================================================================
// IL FINTO SA DISTINGUERE L'ORDINE DEGLI EMBED — cioè può fare da guardiano.
//
// Questi due test non provano la rotta: provano lo STRUMENTO con cui tutti gli
// altri la provano. Fino al 2026-08-20 il finto popolava `sedi` cablato e non
// materializzava mai l'embed filtrato, quindi non poteva vedere la differenza
// fra la query giusta e quella con le due costanti scambiate — e siccome è
// l'unico posto in cui quella differenza si manifesta, l'isolamento di sede
// era senza guardiani nonostante 12077 test verdi.
//
// Un finto cieco non è un finto imperfetto: è un test che dice sempre sì.
// =============================================================================
/**
 * Il costruttore del finto, tipato: `from()` restituisce un
 * `Record<string, unknown>` e la catena si perde. Qui serve interrogarlo
 * direttamente, quindi gli si dà la forma che ha.
 */
interface QueryFinta extends PromiseLike<{ data: Riga[] }> {
  select(c: string): QueryFinta
  in(c: string, v: unknown[]): QueryFinta
}
const interroga = () => finto().from('candidature_insegnanti') as unknown as QueryFinta

describe('il finto riproduce la semantica posizionale degli embed di PostgREST', () => {
  /** Una candidatura rivolta a DUE sedi, di cui chi guarda ne ha una sola. */
  const SU_DUE = 'eeeeeeee-0000-4000-8000-0000000000dd'

  beforeEach(() => {
    h.state.tabelle.candidature_insegnanti = [candidatura(SU_DUE, SEDE_B, 'candidature/due.pdf')]
    h.state.tabelle.candidature_sedi = [
      { candidatura_id: SU_DUE, scuola_id: SEDE_A, stato: 'approvata' },
      { candidatura_id: SU_DUE, scuola_id: SEDE_B, stato: 'pending' },
    ]
  })

  it('il filtro si lega al PRIMO embed, e gli altri portano tutte le sedi', async () => {
    const { data } = await interroga()
      .select('id, candidature_sedi!inner(scuola_id, stato), sedi:candidature_sedi(scuola_id, stato)')
      .in('candidature_sedi.scuola_id', [SEDE_A])

    const filtrato = (data[0].candidature_sedi ?? []) as Riga[]
    const tutte = (data[0].sedi ?? []) as Riga[]
    expect(filtrato.map((x) => x.scuola_id), 'l’embed filtrato porta solo la mia sede').toEqual([SEDE_A])
    expect(tutte.map((x) => x.scuola_id).sort(), 'quello descrittivo le porta tutte').toEqual(
      [SEDE_A, SEDE_B].sort(),
    )
  })

  it('🔴 invertendo i due embed il filtro cambia bersaglio, e l’isolamento sparisce', async () => {
    // ⚠️ L'ORDINE È SCAMBIATO di proposito: il descrittivo davanti, l'`!inner`
    // dietro. È l'unica differenza rispetto al test qui sopra.
    const { data } = await interroga()
      .select('id, sedi:candidature_sedi(scuola_id, stato), candidature_sedi!inner(scuola_id, stato)')
      .in('candidature_sedi.scuola_id', [SEDE_A])

    // Ora è `sedi` a essere ristretto…
    expect((data[0].sedi as Riga[]).map((x) => x.scuola_id)).toEqual([SEDE_A])
    // …e `candidature_sedi`, l'array su cui il codice della rotta si fida, porta
    // ANCHE la sede che non è di chi guarda. Questo è il difetto, ed è visibile.
    expect((data[0].candidature_sedi as Riga[]), 'l’`!inner` in seconda posizione non restringe più')
      .toHaveLength(2)
  })

  it('🔴 senza `!inner` in testa la madre NON sparisce più: resta con l’array vuoto', async () => {
    // È la seconda metà della stessa regola, e la più pericolosa: `!inner` è ciò
    // che rende la query DI sede invece di limitarsi ad arricchirla. Senza, una
    // candidatura di un plesso altrui resta in elenco.
    h.state.scuole = [SEDE_A]
    const { data } = await interroga()
      .select('id, sedi:candidature_sedi(scuola_id, stato)')
      .in('candidature_sedi.scuola_id', ['ffffffff-0000-4000-8000-00000000000f'])
    expect(data, 'la madre è sparita senza che nessun `!inner` lo chiedesse').toHaveLength(1)
    expect(data[0].sedi).toEqual([])
  })

  it('un embed consegna SOLO le colonne che ha chiesto', async () => {
    // Ovvio nel database, invisibile nei finti di prima — che popolavano l'array
    // con la riga intera. È così che `candidature_sedi!inner(scuola_id)` senza
    // `stato` è potuto restare in produzione mentre il componente leggeva
    // `[…].stato` e ripiegava sull'aggregato.
    const { data } = await interroga()
      .select('id, candidature_sedi!inner(scuola_id)')
      .in('candidature_sedi.scuola_id', [SEDE_A])
    expect((data[0].candidature_sedi as Riga[])[0]).toEqual({ scuola_id: SEDE_A })
  })
})

// =============================================================================
// LO STATO DELLA PROPRIA SEDE ARRIVA DAVVERO ALL'ELENCO.
//
// Trovato il 2026-08-20 e misurato sulla PRODUZIONE, in sola lettura: l'elenco
// interrogava con `candidature_sedi!inner(scuola_id)` — senza `stato` — mentre
// `CandidatureInsegnanti.tsx:942-945` legge `candidature_sedi[…].stato`. Il
// campo arrivava `undefined`, la catena di `??` scivolava fino a `r.stato`, e i
// tre contatori e il badge d'elenco mostravano l'AGGREGATO: cioè esattamente il
// numero che il commit `84a91ef5` dichiarava di aver corretto.
//
// Perché nessuno se n'era accorto: il tipo dichiara `stato?` opzionale, quindi
// TypeScript non poteva dirlo, e il finto popolava gli array a mano invece di
// proiettare le colonne chieste, quindi nessun test poteva vederlo.
// =============================================================================
describe('candidature insegnanti · l’elenco porta lo stato DELLA PROPRIA sede', () => {
  const MISTA = 'eeeeeeee-0000-4000-8000-0000000000ee'

  beforeEach(() => {
    // Giugliano ha già approvato, Aversa sta ancora valutando: l'aggregato vale
    // `pending`, ma chi guarda da Giugliano quella pratica l'ha chiusa.
    h.state.tabelle.candidature_insegnanti = [candidatura(MISTA, SEDE_A, 'candidature/mista.pdf')]
    h.state.tabelle.candidature_sedi = [
      { candidatura_id: MISTA, scuola_id: SEDE_A, stato: 'approvata' },
      { candidatura_id: MISTA, scuola_id: SEDE_B, stato: 'pending' },
    ]
    h.state.scuole = [SEDE_A]
  })

  it('🔴 la riga d’elenco porta `stato` nell’embed filtrato, non solo `scuola_id`', async () => {
    const body = await (await GET(get())).json()
    const riga = body.data.find((r: Riga) => r.id === MISTA) as Riga
    const mie = (riga.candidature_sedi ?? []) as Riga[]
    expect(mie, 'l’embed filtrato non è arrivato affatto').toHaveLength(1)
    expect(
      mie[0].stato,
      'senza `stato` il componente ripiega sull’aggregato, e i contatori dicono il falso',
    ).toBe('approvata')
  })

  it('e non porta lo stato dei plessi ALTRUI: l’elenco resta povero', async () => {
    // L'embed non filtrato mandava il piano decisionale di ogni plesso al
    // browser di ogni membro dello staff, a ogni apertura di pagina, senza che
    // nessuno lo disegnasse.
    const body = await (await GET(get())).json()
    const riga = body.data.find((r: Riga) => r.id === MISTA) as Riga
    expect(riga.sedi, 'le sedi altrui viaggiano ancora nell’elenco').toBeUndefined()
    expect(JSON.stringify(riga)).not.toContain(SEDE_B)
  })
})

// =============================================================================
// UN UUID NON È UNA STRINGA, e confrontarlo come tale nega la propria sede.
//
// `zUuid` è `z.guid()`, che ACCETTA il maiuscolo; le sedi in scope arrivano dal
// database in forma canonica (minuscola). Un `Array.includes()` fra le due
// risponde `false`, e chi dichiara la PROPRIA sede in maiuscolo si vede
// rispondere «non esiste, oppure appartiene a un'altra sede» — più un
// `logEvento('multi_sede','warn',{esito:'sede-fuori-scope'})`.
//
// Due danni, e il secondo è quello che dura: una scrittura legittima negata (la
// si vede, ci si accorge) e un contatore nato come SEGNALE DI SICUREZZA riempito
// di falsi positivi, che nessuno guarda finché non serve. È parola per parola il
// difetto che `src/lib/auth/scope.ts:95-107` racconta come già misurato il
// 2026-07-31, reintrodotto qui perché il confronto era fatto a mano invece che
// con `formaConfronto`.
//
// ⚠️ Normalizzare è un CONFRONTO, non un permesso: il secondo test è il
// controllo negativo, e senza di lui questa correzione sarebbe un buco.
// =============================================================================
describe('candidature insegnanti · l’uuid della sede si confronta normalizzato', () => {
  const MAIUSCOLO = (id: string) => id.toUpperCase()

  beforeEach(() => {
    h.state.scuole = [SEDE_A, SEDE_B]
    h.state.tabelle.candidature_insegnanti = [candidatura(MIA, SEDE_A, CV_MIO)]
    h.state.tabelle.candidature_sedi = [{ candidatura_id: MIA, scuola_id: SEDE_A, stato: 'pending' }]
  })

  const patch = (corpo: Record<string, unknown>) =>
    new NextRequest(URL_ROUTE, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(corpo),
    })

  it('🔴 la PROPRIA sede in maiuscolo NON viene negata', async () => {
    const res = await PATCH(patch({ id: MIA, action: 'approva', scuola_id: MAIUSCOLO(SEDE_A) }))
    expect(res.status, 'la propria sede negata perché scritta in maiuscolo').not.toBe(404)
    expect(
      h.logEvento.mock.calls.some(
        (c: unknown[]) => (c[2] as { esito?: string } | undefined)?.esito === 'sede-fuori-scope',
      ),
      'un falso positivo nel contatore che serve a vedere gli abusi veri',
    ).toBe(false)
  })

  it('e una sede ALTRUI resta negata, maiuscola o no: normalizzare è un confronto', async () => {
    const ALTRA = 'ffffffff-0000-4000-8000-00000000000f'
    const res = await PATCH(patch({ id: MIA, action: 'approva', scuola_id: MAIUSCOLO(ALTRA) }))
    expect(res.status).toBe(404)
  })
})

// =============================================================================
// LA NOTA DI GIUDIZIO NON VIAGGIA FUORI DALL'EMBED FILTRATO.
//
// `motivo_rifiuto` è testo libero con cui una segreteria giudica una persona.
// Questa stessa rotta lo chiama «nota INTERNA» e lo tiene fuori perfino
// dall'audit — «l'audit deve dire che cosa è successo, non conservarne il
// giudizio» — e lo esclude dagli embed non filtrati con due blocchi di commento.
//
// Restava però nella proiezione della MADRE (`COLONNE_DETTAGLIO`), che per sede
// non è filtrata: l'unico posto dove la regola non era applicata. Oggi la
// colonna è vuota e nessuno la scrive più, quindi non perdeva niente — ma il
// giorno di un import o di un backfill tornerebbe a uscire verso ogni plesso in
// scope senza che una riga di codice cambi.
// =============================================================================
describe('candidature insegnanti · `motivo_rifiuto` della MADRE non esce dal dettaglio', () => {
  it('🔴 la scheda non porta `motivo_rifiuto` al primo livello', async () => {
    h.state.tabelle.candidature_insegnanti = [
      { ...candidatura(MIA, SEDE_A, CV_MIO), stato: 'rifiutata', motivo_rifiuto: 'un giudizio su una persona' },
    ]
    h.state.tabelle.candidature_sedi = [
      { candidatura_id: MIA, scuola_id: SEDE_A, stato: 'rifiutata', motivo_rifiuto: 'la nota di casa mia' },
    ]
    const body = await (await GET(get(`?id=${MIA}`))).json()
    expect(body.data.motivo_rifiuto, 'la nota della madre viaggia ancora').toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('un giudizio su una persona')
  })

  it('…e quella della PROPRIA sede continua ad arrivare: è quella che il pannello disegna', async () => {
    h.state.tabelle.candidature_insegnanti = [
      { ...candidatura(MIA, SEDE_A, CV_MIO), stato: 'rifiutata' },
    ]
    h.state.tabelle.candidature_sedi = [
      { candidatura_id: MIA, scuola_id: SEDE_A, stato: 'rifiutata', motivo_rifiuto: 'la nota di casa mia' },
    ]
    const body = await (await GET(get(`?id=${MIA}`))).json()
    const mie = (body.data.candidature_sedi ?? []) as Riga[]
    expect(mie[0]?.motivo_rifiuto).toBe('la nota di casa mia')
  })
})
