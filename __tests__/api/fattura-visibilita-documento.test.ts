import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const PAGAMENTO = '10000000-0000-4000-8000-000000000001'
const SCUOLA = '20000000-0000-4000-8000-000000000002'
const SCUOLA_ALTRA = '20000000-0000-4000-8000-000000000099'
const ALUNNO = '30000000-0000-4000-8000-000000000003'
const AUTH_PADRE = '40000000-0000-4000-8000-000000000004'
const PARENT_PADRE = '50000000-0000-4000-8000-000000000005'
const PARENT_MADRE = '60000000-0000-4000-8000-000000000006'
const PARENT_TERZO = '70000000-0000-4000-8000-000000000007'
const FATTURA_ORDINARIA = '80000000-0000-4000-8000-000000000008'
const FATTURA_PADRE = '90000000-0000-4000-8000-000000000009'
const FATTURA_MADRE = 'a0000000-0000-4000-8000-00000000000a'

type Riga = Record<string, unknown>

const h = vi.hoisted(() => ({
  user: null as Riga | null,
  pagamento: null as Riga | null,
  fatture: [] as Riga[],
  scopeResponse: null as Response | null,
  letture: [] as string[],
  downloads: [] as string[],
  listeStorage: 0,
  bucket: [] as { name: string }[],
  flagVisibilita: '2026-09-16T12:00:00Z' as string | null,
  erroreParents: null as { code: string; message: string } | null,
}))

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))

vi.mock('@/lib/logging/logger', () => log)
vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: vi.fn(async () => ({ user: h.user })),
  requireStaff: vi.fn(async () => ({ user: h.user })),
}))
vi.mock('@/lib/pagamenti/scope-fattura', () => ({
  assertFatturaInScope: vi.fn(async () => h.scopeResponse),
}))
vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: vi.fn(async () => ({ ok: true, remaining: 119, retryAfterMs: 0 })),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(table: string) {
      h.letture.push(table)
      const filtri: Record<string, unknown> = {}
      let colonne = ''
      const b: Record<string, unknown> = {}
      b.select = (scelte = '') => { colonne = scelte; return b }
      b.eq = (colonna: string, valore: unknown) => { filtri[colonna] = valore; return b }
      b.order = () => b
      b.limit = () => b
      b.maybeSingle = async () => {
        if (table === 'pagamenti') {
          // Solo le colonne chieste, come il database: una route che smette di leggere `tipo` deve vedere `undefined`.
          const chieste = colonne.split(',').map((c) => c.trim())
          const riga = Object.entries(h.pagamento ?? {}).filter(([colonna]) => chieste.includes(colonna))
          return { data: h.pagamento ? Object.fromEntries(riga) : null, error: null }
        }
        if (table === 'admin_settings') {
          return { data: { fatture_visibilita_attiva_il: h.flagVisibilita }, error: null }
        }
        if (table === 'parents') {
          if (h.erroreParents) return { data: null, error: h.erroreParents }
          return {
            data: filtri.auth_user_id === AUTH_PADRE ? { id: PARENT_PADRE } : null,
            error: null,
          }
        }
        if (table === 'fatture_emesse') {
          // `fattura/esito` legge la riga chiesta: la cerca per id, come il database.
          return { data: h.fatture.find((riga) => riga.id === filtri.id) ?? null, error: null }
        }
        return { data: null, error: null }
      }
      b.then = (ok: (value: unknown) => unknown) => ok({
        data: table === 'fatture_emesse' ? h.fatture : [],
        error: null,
      })
      return b
    },
    storage: {
      from: () => ({
        download: async (chiave: string) => {
          h.downloads.push(chiave)
          return { data: new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])]), error: null }
        },
        list: async () => {
          h.listeStorage += 1
          return { data: h.bucket, error: null }
        },
      }),
    },
  }),
}))

import { GET as scarica } from '@/app/api/pagamenti/fattura/route'
import { GET as elenco } from '@/app/api/pagamenti/fattura/list/route'
import { POST as registraEsito } from '@/app/api/pagamenti/fattura/esito/route'

const riga = (
  id: string,
  numero: number,
  modalita: 'ordinaria' | 'quote_separate' | null,
  parentRegistryId: string | null,
  extra: Riga = {},
): Riga => ({
  id,
  numero,
  anno: 2026,
  quota_label: `Quota ${numero}`,
  quota_adult_id: parentRegistryId,
  intestatario: { nome: 'Nome', cognome: 'Sintetico' },
  pdf_path: `${PAGAMENTO}-${numero}.pdf`,
  sdi_stato: 7,
  sdi_stato_label: 'Consegnata',
  sdi_scarto_motivo: null,
  modalita_emissione: modalita,
  parent_registry_id: parentRegistryId,
  scuola_id: SCUOLA,
  ...extra,
})

const getPdf = (fatturaId?: string) => scarica(new Request(
  `http://test/api/pagamenti/fattura?pagamento_id=${PAGAMENTO}${fatturaId ? `&fattura_id=${fatturaId}` : ''}`,
))
const getList = () => elenco(new Request(
  `http://test/api/pagamenti/fattura/list?pagamento_id=${PAGAMENTO}`,
))
const postEsito = (fatturaId: string) => registraEsito(new Request('http://test/api/pagamenti/fattura/esito', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ pagamento_id: PAGAMENTO, fattura_id: fatturaId, esito: 'visualizzata' }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  h.user = { id: AUTH_PADRE, role: 'genitore', scuola_id: SCUOLA }
  h.pagamento = {
    id: PAGAMENTO,
    scuola_id: SCUOLA,
    alunno_id: ALUNNO,
    fattura_stato: 'emessa',
    fattura_pdf_path: null,
  }
  h.fatture = [
    riga(FATTURA_ORDINARIA, 10, 'ordinaria', PARENT_TERZO),
    riga(FATTURA_PADRE, 11, 'quote_separate', PARENT_PADRE),
    riga(FATTURA_MADRE, 12, 'quote_separate', PARENT_MADRE),
  ]
  h.scopeResponse = null
  h.letture = []
  h.downloads = []
  h.listeStorage = 0
  h.flagVisibilita = '2026-09-16T12:00:00Z'
  h.erroreParents = null
  h.bucket = h.fatture.map((fattura) => ({ name: String(fattura.pdf_path) }))
})

describe('GET fattura: accesso al singolo documento', () => {
  it('l’ordinaria resta condivisa anche se è intestata a un terzo', async () => {
    const res = await getPdf(FATTURA_ORDINARIA)
    expect(res.status).toBe(200)
    expect(h.downloads).toEqual([`${PAGAMENTO}-10.pdf`])
  })

  it('la quota del padre è visibile, quella della madre è un 404 indistinguibile e non tocca Storage', async () => {
    expect((await getPdf(FATTURA_PADRE)).status).toBe(200)
    h.downloads = []

    const negata = await getPdf(FATTURA_MADRE)
    expect(negata.status).toBe(404)
    expect((await negata.json()).codice).toBe('FATTURA_NON_TROVATA')
    expect(h.downloads).toEqual([])
  })

  it('confronta gli UUID senza dipendere dalle maiuscole della query', async () => {
    const propriaConLettere = 'c0000000-0000-4000-8000-00000000000c'
    h.fatture = [
      riga(propriaConLettere, 11, 'quote_separate', PARENT_PADRE),
      riga(FATTURA_MADRE, 12, 'quote_separate', PARENT_MADRE),
    ]
    h.bucket = h.fatture.map((fattura) => ({ name: String(fattura.pdf_path) }))

    expect((await getPdf(propriaConLettere.toUpperCase())).status).toBe(200)
    expect(h.downloads).toEqual([`${PAGAMENTO}-11.pdf`])
    h.downloads = []

    const negata = await getPdf(FATTURA_MADRE.toUpperCase())
    expect(negata.status).toBe(404)
    expect((await negata.json()).codice).toBe('FATTURA_NON_TROVATA')
    expect(h.downloads).toEqual([])
  })

  it('senza id sceglie fra le sole righe visibili e non usa lo stato aggregato come gate', async () => {
    h.pagamento = { ...h.pagamento, fattura_stato: 'scartata' }
    h.fatture = [
      riga(FATTURA_PADRE, 11, 'quote_separate', PARENT_PADRE),
      riga(FATTURA_MADRE, 12, 'quote_separate', PARENT_MADRE),
    ]

    const res = await getPdf()
    expect(res.status).toBe(200)
    expect(h.downloads).toEqual([`${PAGAMENTO}-11.pdf`])
  })

  it('senza id: zero righe vive visibili dà 404, più di una dà 409', async () => {
    h.fatture = [riga(FATTURA_MADRE, 12, 'quote_separate', PARENT_MADRE)]
    const nessuna = await getPdf()
    expect(nessuna.status).toBe(404)
    expect(h.downloads).toEqual([])

    h.fatture = [
      riga(FATTURA_ORDINARIA, 10, 'ordinaria', PARENT_TERZO),
      riga(FATTURA_PADRE, 11, 'quote_separate', PARENT_PADRE),
    ]
    const ambigua = await getPdf()
    expect(ambigua.status).toBe(409)
    expect((await ambigua.json()).codice).toBe('FATTURA_PIU_QUOTE')
    expect(h.downloads).toEqual([])
  })

  it('il fallback del pagamento è vietato se il registro totale ha più di una riga', async () => {
    h.pagamento = { ...h.pagamento, fattura_pdf_path: 'fallback-altrui.pdf' }
    h.fatture = [
      riga(FATTURA_PADRE, 11, 'quote_separate', PARENT_PADRE, { pdf_path: null }),
      riga(FATTURA_MADRE, 12, 'quote_separate', PARENT_MADRE),
    ]

    const res = await getPdf()
    expect(res.status).toBe(404)
    expect(h.downloads).toEqual([])
  })

  it('nega una fattura registrata su una sede diversa anche col filtro di visibilità disattivato', async () => {
    h.flagVisibilita = null
    h.fatture = [
      riga(FATTURA_PADRE, 11, 'quote_separate', PARENT_PADRE, { scuola_id: SCUOLA_ALTRA }),
    ]

    const res = await getPdf(FATTURA_PADRE)
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('FATTURA_NON_TROVATA')
    expect(h.downloads).toEqual([])
  })

  it('mantiene il conteggio totale del registro quando una riga è di un’altra sede', async () => {
    h.pagamento = { ...h.pagamento, fattura_pdf_path: 'fallback-altrui.pdf' }
    h.fatture = [
      riga(FATTURA_PADRE, 11, 'quote_separate', PARENT_PADRE, { pdf_path: null }),
      riga(FATTURA_MADRE, 12, 'quote_separate', PARENT_MADRE, { scuola_id: SCUOLA_ALTRA }),
    ]

    const res = await getPdf()
    expect(res.status).toBe(404)
    expect(h.downloads).toEqual([])
  })

  it('lo scope del pagamento ferma la richiesta prima di caricare i flag di visibilità', async () => {
    h.scopeResponse = NextResponse.json({ error: 'negato' }, { status: 403 })
    const res = await getPdf(FATTURA_PADRE)
    expect(res.status).toBe(403)
    expect(h.letture).not.toContain('admin_settings')
    expect(h.letture).not.toContain('fatture_emesse')
  })
})

describe('GET fattura/list: filtro prima del dedupe', () => {
  it('restituisce l’ordinaria e la quota propria, senza la quota dell’altro genitore', async () => {
    const res = await getList()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.map((fattura: { id: string }) => fattura.id)).toEqual([
      FATTURA_ORDINARIA,
      FATTURA_PADRE,
    ])
  })

  it('una quota altrui più recente non elimina la propria durante il dedupe', async () => {
    const stessaQuota = 'b0000000-0000-4000-8000-00000000000b'
    h.fatture = [
      riga(FATTURA_PADRE, 11, 'quote_separate', PARENT_PADRE, { quota_adult_id: stessaQuota }),
      riga(FATTURA_MADRE, 99, 'quote_separate', PARENT_MADRE, { quota_adult_id: stessaQuota }),
    ]
    h.bucket = h.fatture.map((fattura) => ({ name: String(fattura.pdf_path) }))

    const body = await (await getList()).json()
    expect(body.data.map((fattura: { id: string }) => fattura.id)).toEqual([FATTURA_PADRE])
  })

  it('esclude righe di un’altra sede prima della policy e non interroga Storage', async () => {
    h.flagVisibilita = null
    h.fatture = [
      riga(FATTURA_PADRE, 11, 'quote_separate', PARENT_PADRE, { scuola_id: SCUOLA_ALTRA }),
    ]

    const res = await getList()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual([])
    expect(h.listeStorage).toBe(0)
    expect(h.downloads).toEqual([])
  })

  it('anche l’elenco esegue lo scope prima di leggere il flag sede', async () => {
    h.scopeResponse = NextResponse.json({ error: 'negato' }, { status: 403 })
    expect((await getList()).status).toBe(403)
    expect(h.letture).not.toContain('admin_settings')
    expect(h.letture).not.toContain('fatture_emesse')
  })
})

// Il titolare, il 04/11: «ognuno riceve solo la propria fattura». Il filtro di sede resta SPENTO: la regola vale lo stesso, ed è la
// route a doverla attivare passando il `tipo` della voce. Il predicato è quello vero: qui si prova che il tipo gli arriva.
describe('voce divisa, filtro di sede spento: ognuno vede solo la propria', () => {
  const eventiFattura = () => log.logEvento.mock.calls.filter(
    (chiamata) => chiamata[0] === 'fattura' && (chiamata[2] as Riga).operazione === 'pagamenti/fattura/esito',
  )

  beforeEach(() => {
    h.flagVisibilita = null
    h.pagamento = { ...h.pagamento, tipo: 'split' }
    h.fatture = [
      riga(FATTURA_PADRE, 11, 'quote_separate', PARENT_PADRE),
      riga(FATTURA_MADRE, 12, 'quote_separate', PARENT_MADRE),
    ]
    h.bucket = h.fatture.map((fattura) => ({ name: String(fattura.pdf_path) }))
  })

  it('fattura/list:GET: il genitore vede solo la propria riga', async () => {
    const res = await getList()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.map((fattura: { id: string }) => fattura.id)).toEqual([FATTURA_PADRE])
  })

  it('fattura/list:GET: l’ordinaria dell’altro e una riga senza registro non escono', async () => {
    const senzaRegistro = 'c0000000-0000-4000-8000-00000000000c'
    h.fatture = [
      riga(FATTURA_PADRE, 11, null, PARENT_PADRE),
      riga(FATTURA_ORDINARIA, 10, 'ordinaria', PARENT_MADRE),
      riga(senzaRegistro, 13, 'ordinaria', null),
    ]
    const body = await (await getList()).json()
    expect(body.data.map((fattura: { id: string }) => fattura.id)).toEqual([FATTURA_PADRE])
  })

  it('fattura:GET col fattura_id dell’altro: 404 FATTURA_NON_TROVATA, e Storage non si tocca', async () => {
    const res = await getPdf(FATTURA_MADRE)
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('FATTURA_NON_TROVATA')
    expect(h.downloads).toEqual([])
  })

  it('fattura:GET senza fattura_id con due quote: esce la propria, senza 409', async () => {
    const res = await getPdf()
    expect(res.status).toBe(200)
    expect(h.downloads).toEqual([`${PAGAMENTO}-11.pdf`])
  })

  it('fattura:GET senza fattura_id, c’è solo il documento dell’altro: 404, non lo rivela e non serve il ripiego', async () => {
    h.pagamento = { ...h.pagamento, fattura_pdf_path: 'chiave-dell-altro.pdf' }
    h.fatture = [riga(FATTURA_MADRE, 12, 'quote_separate', PARENT_MADRE)]

    const res = await getPdf()
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('FATTURA_PDF_NON_DISPONIBILE')
    expect(h.downloads).toEqual([])
  })

  it('fattura/esito:POST sulla riga dell’altro: come una riga non visibile, e nessun evento', async () => {
    const res = await postEsito(FATTURA_MADRE)
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('FATTURA_NON_TROVATA')
    expect(eventiFattura()).toEqual([])
  })

  it('fattura/esito:POST sulla propria: 204, e l’evento c’è', async () => {
    const res = await postEsito(FATTURA_PADRE)
    expect(res.status).toBe(204)
    expect(eventiFattura()).toHaveLength(1)
  })

  it('la contabilità nel proprio plesso le vede tutte, e `parents` non si legge', async () => {
    h.user = { id: AUTH_PADRE, role: 'segreteria', scuola_id: SCUOLA }

    const body = await (await getList()).json()
    expect(body.data.map((fattura: { id: string }) => fattura.id)).toEqual([FATTURA_PADRE, FATTURA_MADRE])
    expect((await getPdf(FATTURA_MADRE)).status).toBe(200)
    expect((await postEsito(FATTURA_MADRE)).status).toBe(204)
    expect(h.letture).not.toContain('parents')
  })
})

// La divisione in due documenti la decide `genitori_separati`, non `tipo`: una voce `singolo` di genitori separati
// ne ha due, e il filtro di sede spento non deve aprire al padre il PDF della madre, con codice fiscale e residenza.
describe('voce singola con due quote, filtro di sede spento: la quota dell’altro non si vede', () => {
  const NON_CLASSIFICATA = 'c0000000-0000-4000-8000-00000000000c'

  beforeEach(() => {
    h.flagVisibilita = null
    h.pagamento = { ...h.pagamento, tipo: 'singolo' }
    h.fatture = [
      riga(FATTURA_PADRE, 11, 'quote_separate', PARENT_PADRE),
      riga(FATTURA_MADRE, 12, 'quote_separate', PARENT_MADRE),
    ]
    h.bucket = h.fatture.map((fattura) => ({ name: String(fattura.pdf_path) }))
  })

  it('fattura/list:GET: la propria, un’ordinaria e una non classificata sì, la quota dell’altro no', async () => {
    h.fatture = [
      riga(FATTURA_ORDINARIA, 10, 'ordinaria', PARENT_TERZO),
      riga(FATTURA_PADRE, 11, 'quote_separate', PARENT_PADRE),
      riga(FATTURA_MADRE, 12, 'quote_separate', PARENT_MADRE),
      riga(NON_CLASSIFICATA, 13, null, null),
    ]
    h.bucket = h.fatture.map((fattura) => ({ name: String(fattura.pdf_path) }))

    const res = await getList()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.map((fattura: { id: string }) => fattura.id).sort()).toEqual(
      [FATTURA_ORDINARIA, FATTURA_PADRE, NON_CLASSIFICATA].sort(),
    )
    expect(h.letture).toContain('parents')
  })

  it('fattura:GET col fattura_id dell’altro: 404 FATTURA_NON_TROVATA, e Storage non si tocca', async () => {
    const res = await getPdf(FATTURA_MADRE)
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('FATTURA_NON_TROVATA')
    expect(h.downloads).toEqual([])
  })

  it('fattura:GET col proprio fattura_id: 200', async () => {
    const res = await getPdf(FATTURA_PADRE)
    expect(res.status).toBe(200)
    expect(h.downloads).toEqual([`${PAGAMENTO}-11.pdf`])
  })

  it('fattura:GET senza fattura_id con due quote: esce la propria, senza 409', async () => {
    const res = await getPdf()
    expect(res.status).toBe(200)
    expect(h.downloads).toEqual([`${PAGAMENTO}-11.pdf`])
  })

  it('fattura:GET: l’ordinaria e la non classificata restano scaricabili, niente dello storico si nasconde', async () => {
    h.fatture = [
      riga(FATTURA_ORDINARIA, 10, 'ordinaria', PARENT_TERZO),
      riga(NON_CLASSIFICATA, 13, null, null),
    ]

    expect((await getPdf(FATTURA_ORDINARIA)).status).toBe(200)
    expect((await getPdf(NON_CLASSIFICATA)).status).toBe(200)
    expect(h.downloads).toEqual([`${PAGAMENTO}-10.pdf`, `${PAGAMENTO}-13.pdf`])
  })

  it('fattura/esito:POST: sulla riga dell’altro 404, sulla propria 204', async () => {
    const altrui = await postEsito(FATTURA_MADRE)
    expect(altrui.status).toBe(404)
    expect((await altrui.json()).codice).toBe('FATTURA_NON_TROVATA')
    expect((await postEsito(FATTURA_PADRE)).status).toBe(204)
  })

  it('la contabilità nel proprio plesso le vede tutte, e `parents` non si legge', async () => {
    h.user = { id: AUTH_PADRE, role: 'segreteria', scuola_id: SCUOLA }

    const body = await (await getList()).json()
    expect(body.data.map((fattura: { id: string }) => fattura.id)).toEqual([FATTURA_PADRE, FATTURA_MADRE])
    expect((await getPdf(FATTURA_MADRE)).status).toBe(200)
    expect((await postEsito(FATTURA_MADRE)).status).toBe(204)
    expect(h.letture).not.toContain('parents')
  })

  it('un errore di lettura su `parents`: 500 sulle tre route, e Storage non si tocca', async () => {
    h.erroreParents = { code: '42501', message: 'permission denied' }

    expect((await getList()).status).toBe(500)
    expect((await getPdf(FATTURA_PADRE)).status).toBe(500)
    expect((await postEsito(FATTURA_PADRE)).status).toBe(500)
    expect(h.downloads).toEqual([])
    expect(h.listeStorage).toBe(0)
  })
})
