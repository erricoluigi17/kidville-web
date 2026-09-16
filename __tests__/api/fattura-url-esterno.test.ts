import { beforeEach, describe, expect, it, vi } from 'vitest'

const PAGAMENTO = '11000000-0000-4000-8000-000000000001'
const SCUOLA = '22000000-0000-4000-8000-000000000002'
const SCUOLA_ALTRA = '22000000-0000-4000-8000-000000000099'
const ALUNNO = '33000000-0000-4000-8000-000000000003'
const AUTH_PADRE = '44000000-0000-4000-8000-000000000004'
const PARENT_PADRE = '55000000-0000-4000-8000-000000000005'
const PARENT_MADRE = '66000000-0000-4000-8000-000000000006'
const FATTURA_PADRE = '77000000-0000-4000-8000-000000000007'
const FATTURA_MADRE = '88000000-0000-4000-8000-000000000008'
const URL_FIRMATO = 'https://storage.test/object/sign/fatture/padre.pdf?token=SEGRETO'
const CAPABILITY_OSTILE = 'https://storage.test/object/sign/fatture/privata.pdf?token=TOKEN-DA-NON-LOGGARE'
const TOKEN_BREVE = 'Ab12X9'
const CODICE_FISCALE = 'RSSMRA80A01H501U'

type Riga = Record<string, unknown>

const h = vi.hoisted(() => ({
  fatture: [] as Riga[],
  letture: [] as string[],
  firme: [] as { bucket: string; path: string; ttl: number; opzioni: unknown }[],
  download: 0,
  rispostaFirma: { data: null, error: null } as {
    data: { signedUrl?: string } | null
    error: unknown
  },
  erroreLanciato: null as unknown,
}))

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => log)
vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: vi.fn(async () => ({
    user: { id: AUTH_PADRE, role: 'genitore', scuola_id: SCUOLA },
  })),
  requireStaff: vi.fn(),
}))
vi.mock('@/lib/pagamenti/scope-fattura', () => ({
  assertFatturaInScope: vi.fn(async () => null),
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
        if (table === 'pagamenti') {
          return {
            data: {
              id: PAGAMENTO,
              scuola_id: SCUOLA,
              alunno_id: ALUNNO,
              fattura_stato: 'emessa',
              fattura_pdf_path: null,
            },
            error: null,
          }
        }
        if (table === 'admin_settings') {
          return { data: { fatture_visibilita_attiva_il: '2026-09-16T12:00:00Z' }, error: null }
        }
        if (table === 'parents') {
          return { data: filtri.auth_user_id === AUTH_PADRE ? { id: PARENT_PADRE } : null, error: null }
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
      from: (bucket: string) => ({
        createSignedUrl: async (path: string, ttl: number, opzioni: unknown) => {
          h.firme.push({ bucket, path, ttl, opzioni })
          if (h.erroreLanciato) throw h.erroreLanciato
          return h.rispostaFirma
        },
        download: async () => {
          h.download += 1
          return { data: null, error: null }
        },
      }),
    },
  }),
}))

import { GET } from '@/app/api/pagamenti/fattura/route'

const riga = (
  id: string,
  numero: number,
  parentRegistryId: string,
  path: string,
  scuolaId = SCUOLA,
): Riga => ({
  id,
  numero,
  anno: '2026',
  pdf_path: path,
  sdi_stato: 7,
  modalita_emissione: 'quote_separate',
  parent_registry_id: parentRegistryId,
  scuola_id: scuolaId,
})

const chiedi = (query: string) => GET(new Request(
  `http://test/api/pagamenti/fattura?pagamento_id=${PAGAMENTO}${query}`,
))

function tuttiGliArgomentiDeiLog(): string {
  return JSON.stringify([
    ...log.logEvento.mock.calls,
    ...log.logErrore.mock.calls,
    ...log.logOk.mock.calls,
  ])
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-16T12:30:00.000Z'))
  vi.clearAllMocks()
  h.fatture = [
    riga(FATTURA_PADRE, 1948, PARENT_PADRE, 'documenti/padre.pdf'),
    riga(FATTURA_MADRE, 1949, PARENT_MADRE, 'documenti/madre.pdf'),
  ]
  h.letture = []
  h.firme = []
  h.download = 0
  h.rispostaFirma = { data: { signedUrl: URL_FIRMATO }, error: null }
  h.erroreLanciato = null
})

describe('GET fattura?esterno=1', () => {
  it('firma per 300 secondi col nome del documento e risponde senza cache', async () => {
    const res = await chiedi(`&fattura_id=${FATTURA_PADRE}&esterno=1`)

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({
      success: true,
      data: {
        url: URL_FIRMATO,
        scade_il: '2026-09-16T12:35:00.000Z',
      },
    })
    expect(h.firme).toEqual([{
      bucket: 'fatture',
      path: 'documenti/padre.pdf',
      ttl: 300,
      opzioni: { download: 'fattura-1948-2026.pdf' },
    }])
    expect(h.download).toBe(0)
  })

  it('senza fattura_id seleziona fra le sole righe visibili prima di firmare', async () => {
    const res = await chiedi('&esterno=1')
    expect(res.status).toBe(200)
    expect(h.firme.map((firma) => firma.path)).toEqual(['documenti/padre.pdf'])
  })

  it('esterno=1 e download presente sono una richiesta ambigua: 400 prima del database', async () => {
    const res = await chiedi(`&fattura_id=${FATTURA_PADRE}&esterno=1&download=0`)
    expect(res.status).toBe(400)
    expect(h.letture).toEqual([])
    expect(h.firme).toEqual([])
    expect(h.download).toBe(0)
  })

  it('la quota dell’altro genitore resta un 404 e non genera alcun collegamento', async () => {
    const res = await chiedi(`&fattura_id=${FATTURA_MADRE}&esterno=1`)
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('FATTURA_NON_TROVATA')
    expect(h.firme).toEqual([])
    expect(h.download).toBe(0)
  })

  it('non firma né scarica una fattura registrata su una sede diversa dal pagamento', async () => {
    h.fatture = [
      riga(FATTURA_PADRE, 1948, PARENT_PADRE, 'documenti/padre.pdf', SCUOLA_ALTRA),
    ]

    const res = await chiedi(`&fattura_id=${FATTURA_PADRE}&esterno=1`)
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('FATTURA_NON_TROVATA')
    expect(h.firme).toEqual([])
    expect(h.download).toBe(0)
  })

  it('un errore restituito dallo Storage è controllato e non espone URL o token', async () => {
    const errore = {
      message: `firma non disponibile: ${CAPABILITY_OSTILE}`,
      status: 503,
      code: CAPABILITY_OSTILE,
      cause: { message: CAPABILITY_OSTILE },
      stack: `StorageUnavailable: ${CAPABILITY_OSTILE}`,
    }
    h.rispostaFirma = { data: { signedUrl: URL_FIRMATO }, error: errore }

    const res = await chiedi(`&fattura_id=${FATTURA_PADRE}&esterno=1`)
    expect(res.status).toBe(404)
    const testo = await res.text()
    expect(testo).not.toContain('storage.test')
    expect(testo).not.toContain('SEGRETO')
    expect(JSON.parse(testo).codice).toBe('FATTURA_PDF_NON_DISPONIBILE')
    expect(h.firme).toHaveLength(1)

    const chiamata = log.logEvento.mock.calls.find(
      (call) => call[0] === 'storage' && call[1] === 'error',
    )
    expect(chiamata?.[2]).toMatchObject({
      operazione: 'pagamenti/fattura:GET',
      bucket: 'fatture',
      esito: 'url-firmato-non-generato',
      stato: 503,
      error_code: 'StorageError',
    })
    expect(chiamata).toHaveLength(3)
    expect(tuttiGliArgomentiDeiLog()).not.toContain('storage.test')
    expect(tuttiGliArgomentiDeiLog()).not.toContain('TOKEN-DA-NON-LOGGARE')
  })

  it('anche un’eccezione dello Storage scarta message, cause e stack potenzialmente sensibili', async () => {
    const causa = new Error(`causa: ${CAPABILITY_OSTILE}`)
    const errore = new Error(`trasporto interrotto: ${CAPABILITY_OSTILE}`, { cause: causa }) as Error & {
      code: string
      status: number
    }
    errore.name = 'StorageTransportError'
    errore.code = 'StorageTransportError'
    errore.status = 502
    errore.stack = `StorageTransportError: ${CAPABILITY_OSTILE}`
    h.erroreLanciato = errore
    const res = await chiedi(`&fattura_id=${FATTURA_PADRE}&esterno=1`)
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('FATTURA_PDF_NON_DISPONIBILE')
    const chiamata = log.logEvento.mock.calls.find(
      (call) => call[0] === 'storage' && call[1] === 'error',
    )
    expect(chiamata?.[2]).toMatchObject({
      esito: 'url-firmato-non-generato',
      stato: 502,
      error_code: 'StorageError',
    })
    expect(chiamata).toHaveLength(3)
    expect(tuttiGliArgomentiDeiLog()).not.toContain('storage.test')
    expect(tuttiGliArgomentiDeiLog()).not.toContain('TOKEN-DA-NON-LOGGARE')
  })

  it('usa soltanto codici interni per token brevi e codici fiscali in ogni forma di errore', async () => {
    for (const errore of [
      { code: TOKEN_BREVE },
      { name: CODICE_FISCALE },
      { error: TOKEN_BREVE },
    ]) {
      h.rispostaFirma = { data: null, error: errore }
      const res = await chiedi(`&fattura_id=${FATTURA_PADRE}&esterno=1`)
      expect(res.status).toBe(404)
    }

    h.rispostaFirma = { data: null, error: null }
    h.erroreLanciato = CODICE_FISCALE
    const res = await chiedi(`&fattura_id=${FATTURA_PADRE}&esterno=1`)
    expect(res.status).toBe(404)

    const chiamateFirma = log.logEvento.mock.calls.filter(
      (call) => call[0] === 'storage' && call[1] === 'error',
    )
    expect(chiamateFirma).toHaveLength(4)
    for (const chiamata of chiamateFirma) {
      expect(chiamata).toHaveLength(3)
      expect(chiamata[2]).toMatchObject({ error_code: 'StorageError' })
    }
    expect(tuttiGliArgomentiDeiLog()).not.toContain(TOKEN_BREVE)
    expect(tuttiGliArgomentiDeiLog()).not.toContain(CODICE_FISCALE)
  })

  it('distingue una risposta senza URL con il solo codice interno previsto', async () => {
    h.rispostaFirma = { data: {}, error: null }

    const res = await chiedi(`&fattura_id=${FATTURA_PADRE}&esterno=1`)
    expect(res.status).toBe(404)
    const chiamata = log.logEvento.mock.calls.find(
      (call) => call[0] === 'storage' && call[1] === 'error',
    )
    expect(chiamata?.[2]).toMatchObject({
      esito: 'url-firmato-non-generato',
      error_code: 'SignedUrlMissing',
    })
    expect(chiamata).toHaveLength(3)
  })
})
