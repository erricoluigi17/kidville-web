import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
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
vi.mock('@/lib/auth/scope', () => ({ resolveScuoleAttive: async () => h.state.scuole }))
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
  const senzaEmbed = cols.replace(/[\w:]*candidature_sedi(!inner)?\s*\([^)]*\)/g, '')
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
        filtri.every((f) => {
          // `candidature_sedi.scuola_id` → il filtro vive sull'EMBED: la
          // candidatura passa se ALMENO UNA delle sue righe di sede corrisponde.
          const punto = f.col.indexOf('.')
          if (punto > 0) {
            const tabellaEmbed = f.col.slice(0, punto)
            const colonna = f.col.slice(punto + 1)
            if (tabellaEmbed !== TABELLA_SEDI_FINTA) return true
            return sediDi(h, r.id).some((s) => f.vals.some((v) => s[colonna] === v))
          }
          return f.vals.some((v) => r[f.col] === v)
        })
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
        // L'embed NON filtrato (`sedi:candidature_sedi(...)`) porta TUTTE le sedi
        // della candidatura: è ciò che permette alla scheda di dire «questa
        // persona è in gioco anche altrove». Quello filtrato (`!inner`) non
        // compare nella proiezione — serve solo a restringere.
        const conSedi = /sedi:candidature_sedi\s*\(/.test(cols)
        return {
          data: pagina.map((r) => {
            const proiettata = proietta(r, cols)
            if (conSedi) proiettata.sedi = sediDi(h, r.id).map((x) => ({ ...x }))
            return proiettata
          }),
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

import { GET } from '@/app/api/admin/candidature-insegnanti/route'

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
