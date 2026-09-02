import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * L'archivio dei documenti firmati — quello che DEVE valere, verificato sulle
 * route e non sulla logica pura (che ha già i suoi test in
 * `__tests__/lib/documenti-registro.test.ts`).
 *
 * Il punto di tutto: un'insegnante vede i documenti sanitari SOLO dei bambini
 * delle proprie sezioni. È la richiesta del titolare, ed è anche la riga che il
 * repo ha già pagato una volta — `GET /api/parent/medical-certificates/file`
 * autorizzava il solo ruolo, e un docente poteva scaricare il certificato medico
 * di un minore di un'altra sede.
 */

const rbac = vi.hoisted(() => ({
  puoAccedereFascicolo: vi.fn(),
  logAccessoFascicolo: vi.fn(),
  sezioniContitolari: vi.fn(),
}))
vi.mock('@/lib/primaria/fascicolo-rbac', () => rbac)

const scope = vi.hoisted(() => ({
  resolveScuoleAttive: vi.fn(),
  sezioniVisibili: vi.fn(),
  vedeTutteLeClassi: vi.fn(),
  assertAlunnoInScope: vi.fn(),
}))
// `restringiSedi` resta VERA: è la funzione in prova (il confronto fra uuid
// senza distinzione di maiuscole), e un finto la renderebbe non misurabile.
vi.mock('@/lib/auth/scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/scope')>()),
  ...scope,
}))

const h = vi.hoisted(() => {
  const state = {
    queues: {} as Record<string, Array<{ data: unknown; error: unknown }>>,
    used: {} as Record<string, number>,
    filtri: [] as { tabella: string; metodo: string; args: unknown[] }[],
  }
  function take(table: string) {
    const q = state.queues[table] || []
    const i = state.used[table] ?? 0
    state.used[table] = i + 1
    return q[i] ?? { data: [], error: null }
  }
  function makeClient() {
    return {
      from(table: string) {
        const qb: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'order', 'limit', 'in', 'is', 'or']) {
          qb[m] = (...args: unknown[]) => {
            state.filtri.push({ tabella: table, metodo: m, args })
            return qb
          }
        }
        qb.single = () => Promise.resolve(take(table))
        qb.maybeSingle = () => Promise.resolve(take(table))
        qb.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(take(table)).then(res, rej)
        return qb
      },
      storage: {
        from: () => ({
          createSignedUrl: () =>
            Promise.resolve({ data: { signedUrl: 'https://signed/documento' }, error: null }),
        }),
      },
    }
  }
  return { state, makeClient }
})
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn().mockResolvedValue(h.makeClient()),
}))

const auth = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  getRequestUserId: vi.fn(),
  resolveIdentity: vi.fn(),
  loadAppUser: vi.fn(),
}))
vi.mock('@/lib/auth/require-staff', () => auth)

import { GET as ELENCO } from '@/app/api/documenti-firmati/route'
import { GET as DETTAGLIO } from '@/app/api/documenti-firmati/dettaglio/route'

// uuid inventato: l'uuid REALE di una sede non entra nei test (lock
// `migrazioni-senza-sede-cablata`) — un id vero nel repo pubblico è un id vero.
const SCUOLA = 'cccccccc-3333-4333-8333-cccccccccccc'
const SEZIONE_MIA = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const SEZIONE_ALTRUI = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const ALUNNO_MIO = '11111111-1111-4111-8111-111111111111'
const ALUNNO_ALTRUI = '22222222-2222-4222-8222-222222222222'
const DOC = '33333333-3333-4333-8333-333333333333'

function req(qs = '') {
  return new NextRequest(`http://localhost/api/documenti-firmati${qs}`, {
    headers: { 'x-user-id': 'u-1' },
  })
}

function comeStaff() {
  auth.requireDocente.mockResolvedValue({ user: { id: 'u-1', role: 'segreteria', scuola_id: SCUOLA } })
  scope.vedeTutteLeClassi.mockReturnValue(true)
  scope.sezioniVisibili.mockResolvedValue(null)
}

function comeDocente(sezioniAssegnate: string[], sezioniContitolari = sezioniAssegnate) {
  auth.requireDocente.mockResolvedValue({ user: { id: 'u-1', role: 'educator', scuola_id: SCUOLA } })
  scope.vedeTutteLeClassi.mockReturnValue(false)
  scope.sezioniVisibili.mockResolvedValue(sezioniAssegnate)
  rbac.sezioniContitolari.mockResolvedValue(sezioniContitolari)
}

/** Due alunni: uno nella sezione dell'insegnante, uno in un'altra. */
function alunniInElenco() {
  h.state.queues['alunni'] = [
    {
      data: [
        { id: ALUNNO_MIO, nome: 'A', cognome: 'Rossi', classe_sezione: '1A', section_id: SEZIONE_MIA, scuola_id: SCUOLA },
        { id: ALUNNO_ALTRUI, nome: 'B', cognome: 'Bianchi', classe_sezione: '2B', section_id: SEZIONE_ALTRUI, scuola_id: SCUOLA },
      ],
      error: null,
    },
  ]
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.queues = {}
  h.state.used = {}
  h.state.filtri = []
  scope.resolveScuoleAttive.mockResolvedValue([SCUOLA])
  scope.assertAlunnoInScope.mockResolvedValue(null)
  rbac.puoAccedereFascicolo.mockResolvedValue({ consentito: true, ruolo: 'segreteria', motivo: 'staff' })
  rbac.logAccessoFascicolo.mockResolvedValue(undefined)
  rbac.sezioniContitolari.mockResolvedValue([])
})

describe('GET /api/documenti-firmati — il gate sanitario', () => {
  it("l'insegnante NON vede i documenti sanitari dei bambini di un'altra sezione", async () => {
    comeDocente([SEZIONE_MIA, SEZIONE_ALTRUI], [SEZIONE_MIA])
    alunniInElenco()
    h.state.queues['student_documents'] = [
      {
        data: [
          { id: 'd1', student_id: ALUNNO_MIO, document_type: 'pei', descrizione: null, file_name: null, expiry_date: null, created_at: '2026-08-01T10:00:00Z' },
          { id: 'd2', student_id: ALUNNO_ALTRUI, document_type: 'diagnosi', descrizione: null, file_name: null, expiry_date: null, created_at: '2026-08-02T10:00:00Z' },
        ],
        error: null,
      },
    ]

    const res = await ELENCO(req())
    const json = await res.json()

    expect(res.status).toBe(200)
    const alunniDeiDocumenti = json.data.map((d: { alunnoId: string }) => d.alunnoId)
    expect(alunniDeiDocumenti).toContain(ALUNNO_MIO)
    expect(alunniDeiDocumenti).not.toContain(ALUNNO_ALTRUI)
  })

  it('la segreteria vede i sanitari di tutti gli alunni del proprio plesso', async () => {
    comeStaff()
    alunniInElenco()
    h.state.queues['student_documents'] = [
      {
        data: [
          { id: 'd1', student_id: ALUNNO_MIO, document_type: 'pei', descrizione: null, file_name: null, expiry_date: null, created_at: '2026-08-01T10:00:00Z' },
          { id: 'd2', student_id: ALUNNO_ALTRUI, document_type: 'diagnosi', descrizione: null, file_name: null, expiry_date: null, created_at: '2026-08-02T10:00:00Z' },
        ],
        error: null,
      },
    ]

    const res = await ELENCO(req())
    const json = await res.json()
    expect(json.data).toHaveLength(2)
  })

  it("i documenti AMMINISTRATIVI restano visibili anche dove i sanitari sono negati", async () => {
    comeDocente([SEZIONE_MIA, SEZIONE_ALTRUI], [])
    alunniInElenco()
    h.state.queues['forms_submissions'] = [
      {
        data: [
          { id: 'm1', student_id: ALUNNO_ALTRUI, form_id: 'f1', is_signed: true, signature_log: { signed_at: '2026-08-05T09:00:00Z' }, created_at: '2026-08-05T08:00:00Z', origine: null },
        ],
        error: null,
      },
    ]
    h.state.queues['forms_templates'] = [{ data: [{ id: 'f1', title: 'Autorizzazione gita' }], error: null }]

    const res = await ELENCO(req())
    const json = await res.json()
    expect(json.data).toHaveLength(1)
    expect(json.data[0].categoria).toBe('amministrativo')
    expect(json.data[0].titolo).toBe('Autorizzazione gita')
  })
})

describe('GET /api/documenti-firmati — perimetro e filtri', () => {
  it('un educator senza sezioni assegnate riceve un elenco vuoto, non tutto il plesso', async () => {
    comeDocente([])
    const res = await ELENCO(req())
    const json = await res.json()
    expect(json.data).toEqual([])
    expect(json.alunni).toEqual([])
    // Non deve nemmeno aver interrogato gli alunni.
    expect(h.state.filtri.some((f) => f.tabella === 'alunni')).toBe(false)
  })

  it('una sede fuori dalle proprie è 403, anche se l uuid è valido', async () => {
    comeStaff()
    const res = await ELENCO(req('?scuolaId=99999999-9999-4999-8999-999999999999'))
    expect(res.status).toBe(403)
  })

  it('🔴 la PROPRIA sede scritta in MAIUSCOLO non è un diniego', async () => {
    // In Postgres `uuid` è un TIPO: `'CCCC-…'` e `'cccc-…'` sono lo STESSO
    // valore. Il confronto era `p === scuolaId`, cioè fra due STRINGHE, e chi
    // chiedeva la propria sede in maiuscolo si prendeva un 403 — misurato sui
    // dati veri il 2026-07-31, ed è il difetto per cui esiste `formaConfronto`.
    comeStaff()
    alunniInElenco()
    const res = await ELENCO(req(`?scuolaId=${SCUOLA.toUpperCase()}`))
    expect(res.status).toBe(200)
    // …e ciò che arriva alla query è la forma CANONICA del database, non la
    // stringa maiuscola arrivata dal client: il resto del codice ci fa `===`.
    const inSede = h.state.filtri.find(
      (f) => f.tabella === 'alunni' && f.metodo === 'in' && f.args[0] === 'scuola_id',
    )
    expect(inSede?.args[1]).toEqual([SCUOLA])
  })

  it('il filtro per classe arriva alla query come uguaglianza su classe_sezione', async () => {
    comeStaff()
    alunniInElenco()
    await ELENCO(req('?classe=1A'))
    const eqClasse = h.state.filtri.find(
      (f) => f.tabella === 'alunni' && f.metodo === 'eq' && f.args[0] === 'classe_sezione',
    )
    expect(eqClasse?.args[1]).toBe('1A')
  })

  it('il filtro per alunno arriva alla query', async () => {
    comeStaff()
    alunniInElenco()
    await ELENCO(req(`?alunnoId=${ALUNNO_MIO}`))
    const eqAlunno = h.state.filtri.find(
      (f) => f.tabella === 'alunni' && f.metodo === 'eq' && f.args[0] === 'id',
    )
    expect(eqAlunno?.args[1]).toBe(ALUNNO_MIO)
  })

  it('gli alunni anonimizzati non compaiono', async () => {
    comeStaff()
    alunniInElenco()
    await ELENCO(req())
    const isAnonimizzato = h.state.filtri.find(
      (f) => f.tabella === 'alunni' && f.metodo === 'is' && f.args[0] === 'anonimizzato_il',
    )
    expect(isAnonimizzato).toBeDefined()
    expect(isAnonimizzato?.args[1]).toBeNull()
  })

  it("soloFirmati=1 toglie i documenti non firmati", async () => {
    comeStaff()
    alunniInElenco()
    h.state.queues['forms_submissions'] = [
      {
        data: [
          { id: 'm1', student_id: ALUNNO_MIO, form_id: null, is_signed: true, signature_log: { signed_at: '2026-08-05T09:00:00Z' }, created_at: '2026-08-05T08:00:00Z' },
          { id: 'm2', student_id: ALUNNO_MIO, form_id: null, is_signed: false, signature_log: null, created_at: '2026-08-06T08:00:00Z' },
        ],
        error: null,
      },
    ]
    const res = await ELENCO(req('?soloFirmati=1'))
    const json = await res.json()
    expect(json.data).toHaveLength(1)
    expect(json.data[0].firmato).toBe(true)
  })

  it('una fonte caduta non svuota l elenco in silenzio: lo dichiara', async () => {
    comeStaff()
    alunniInElenco()
    h.state.queues['certificati_medici'] = [{ data: null, error: { code: '42703', message: 'colonna assente' } }]
    h.state.queues['forms_submissions'] = [
      { data: [{ id: 'm1', student_id: ALUNNO_MIO, form_id: null, is_signed: true, signature_log: null, created_at: '2026-08-05T08:00:00Z' }], error: null },
    ]

    const res = await ELENCO(req())
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.data).toHaveLength(1)
    expect(json.fonti_cadute).toContain('certificati_medici')
  })
})

describe('GET /api/documenti-firmati/dettaglio', () => {
  function reqDettaglio(qs: string) {
    return new NextRequest(`http://localhost/api/documenti-firmati/dettaglio${qs}`, {
      headers: { 'x-user-id': 'u-1' },
    })
  }

  it('su un documento sanitario nega quando il gate del fascicolo nega', async () => {
    comeDocente([SEZIONE_MIA])
    rbac.puoAccedereFascicolo.mockResolvedValue({ consentito: false, ruolo: 'educator', motivo: 'negato' })
    h.state.queues['student_documents'] = [
      { data: { id: DOC, student_id: ALUNNO_ALTRUI, document_type: 'diagnosi', descrizione: null, file_name: 'd.pdf', storage_path: 'x/d.pdf', file_url: null, expiry_date: null, created_at: null }, error: null },
    ]

    const res = await DETTAGLIO(reqDettaglio(`?fonte=fascicolo&id=${DOC}`))
    expect(res.status).toBe(403)
    // E nessun link firmato deve essere stato prodotto.
    const json = await res.json()
    expect(json.url).toBeUndefined()
  })

  it("registra l'accesso in audit PRIMA di restituire un sanitario", async () => {
    comeStaff()
    h.state.queues['student_documents'] = [
      { data: { id: DOC, student_id: ALUNNO_MIO, document_type: 'pei', descrizione: null, file_name: 'pei.pdf', storage_path: 'x/pei.pdf', file_url: null, expiry_date: null, created_at: null }, error: null },
    ]

    const res = await DETTAGLIO(reqDettaglio(`?fonte=fascicolo&id=${DOC}`))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(rbac.logAccessoFascicolo).toHaveBeenCalledTimes(1)
    expect(rbac.logAccessoFascicolo.mock.calls[0][1]).toMatchObject({
      alunnoId: ALUNNO_MIO,
      utenteId: 'u-1',
      azione: 'view',
      documentoId: DOC,
    })
    expect(json.data.url).toBe('https://signed/documento')
  })

  it('un documento amministrativo non passa dal gate del fascicolo né dall audit', async () => {
    comeStaff()
    h.state.queues['forms_submissions'] = [
      { data: { id: DOC, student_id: ALUNNO_MIO, form_id: null, answers: { q1: 'sì' }, is_signed: true, signature_log: { method: 'OTP_EMAIL', signed_at: '2026-08-05T09:00:00Z', hash: 'segreto' }, created_at: null, origine: null }, error: null },
    ]

    const res = await DETTAGLIO(reqDettaglio(`?fonte=modulo_firmato&id=${DOC}`))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(rbac.puoAccedereFascicolo).not.toHaveBeenCalled()
    expect(rbac.logAccessoFascicolo).not.toHaveBeenCalled()
    // Il modulo non ha un file archiviato: va detto, non simulato con un link rotto.
    expect(json.data.url).toBeNull()
    expect(json.data.fileAssente).toBe(false)
  })

  it("l'hash dell'OTP non esce nella traccia di firma", async () => {
    comeStaff()
    h.state.queues['forms_submissions'] = [
      { data: { id: DOC, student_id: ALUNNO_MIO, form_id: null, answers: null, is_signed: true, signature_log: { method: 'OTP_EMAIL', provider: 'kidville', signed_at: '2026-08-05T09:00:00Z', hash: 'NON-DEVE-USCIRE', email: 'x@y.z', ip: '1.2.3.4' }, created_at: null, origine: null }, error: null },
    ]

    const res = await DETTAGLIO(reqDettaglio(`?fonte=modulo_firmato&id=${DOC}`))
    const json = await res.json()
    const traccia = JSON.stringify(json.data.firma)

    expect(traccia).not.toContain('NON-DEVE-USCIRE')
    expect(traccia).not.toContain('x@y.z')
    expect(traccia).not.toContain('1.2.3.4')
    expect(json.data.firma.method).toBe('OTP_EMAIL')
  })

  it('fuori scope risponde con la risposta dello scope, senza toccare lo storage', async () => {
    comeDocente([SEZIONE_MIA])
    const { NextResponse } = await import('next/server')
    scope.assertAlunnoInScope.mockResolvedValue(
      NextResponse.json({ error: 'Alunno non nella tua classe' }, { status: 403 }),
    )
    h.state.queues['student_documents'] = [
      { data: { id: DOC, student_id: ALUNNO_ALTRUI, document_type: 'pei', descrizione: null, file_name: null, storage_path: 'x', file_url: null, expiry_date: null, created_at: null }, error: null },
    ]

    const res = await DETTAGLIO(reqDettaglio(`?fonte=fascicolo&id=${DOC}`))
    expect(res.status).toBe(403)
    expect(rbac.puoAccedereFascicolo).not.toHaveBeenCalled()
  })

  it('una riga orfana di alunno è 404, non un documento senza fascicolo', async () => {
    comeStaff()
    h.state.queues['forms_submissions'] = [
      { data: { id: DOC, student_id: null, form_id: null, answers: null, is_signed: true, signature_log: null, created_at: null, origine: null }, error: null },
    ]
    const res = await DETTAGLIO(reqDettaglio(`?fonte=modulo_firmato&id=${DOC}`))
    expect(res.status).toBe(404)
  })
})
