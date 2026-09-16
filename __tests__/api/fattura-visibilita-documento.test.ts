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
}))

vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: vi.fn(async () => ({ user: h.user })),
  requireStaff: vi.fn(async () => ({ user: h.user })),
}))
vi.mock('@/lib/pagamenti/scope-fattura', () => ({
  assertFatturaInScope: vi.fn(async () => h.scopeResponse),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(table: string) {
      h.letture.push(table)
      const filtri: Record<string, unknown> = {}
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = (colonna: string, valore: unknown) => { filtri[colonna] = valore; return b }
      b.order = () => b
      b.limit = () => b
      b.maybeSingle = async () => {
        if (table === 'pagamenti') return { data: h.pagamento, error: null }
        if (table === 'admin_settings') {
          return { data: { fatture_visibilita_attiva_il: h.flagVisibilita }, error: null }
        }
        if (table === 'parents') {
          return {
            data: filtri.auth_user_id === AUTH_PADRE ? { id: PARENT_PADRE } : null,
            error: null,
          }
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
