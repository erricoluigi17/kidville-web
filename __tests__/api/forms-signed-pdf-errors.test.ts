// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { signedFormsClient, PARENT, SCHOOL, SUBMISSION } from '../fixtures/signed-forms'
import { SIGNED_PDF_ERROR_CODES } from '@/lib/forms/signed-document'
import { CODICI_ERRORE } from '@/lib/ui/esito-fetch'
import itShared from '../../messages/it/shared.json'
import enShared from '../../messages/en/shared.json'

const h = vi.hoisted(() => ({
  auth: vi.fn(), session: vi.fn(), schools: vi.fn(),
  ensure: vi.fn(), download: vi.fn(), client: null as unknown,
}))
vi.mock('@/lib/auth/require-staff', () => ({ requireUserDaSessioneVerificata: h.auth, requireSessioneAuth: h.session }))
vi.mock('@/lib/auth/scope', () => ({ resolveScuoleAttive: h.schools }))
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => h.client }))
vi.mock('@/lib/forms/signed-archive', () => ({ ensureSignedSubmissionPdf: h.ensure, downloadSignedSubmissionPdf: h.download }))
vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
import { GET, POST } from '@/app/api/forms/signed-pdf/route'

const request = (method: 'GET' | 'POST') => new NextRequest(`http://localhost/api/forms/signed-pdf${method === 'GET' ? `?id=${SUBMISSION}` : ''}`, {
  method, headers: { 'content-type': 'application/json' },
  ...(method === 'POST' ? { body: JSON.stringify({ id: SUBMISSION }) } : {}),
})
function expectTranslated(codice: string) {
  const key = (CODICI_ERRORE as Record<string, string>)[codice]
  expect(key).toBeTypeOf('string')
  expect((itShared as Record<string, string>)[key]).toBeTruthy()
  expect((enShared as Record<string, string>)[key]).toBeTruthy()
}
beforeEach(() => {
  vi.resetAllMocks()
  h.auth.mockResolvedValue({ user: { id: PARENT, role: 'genitore' } })
  h.session.mockResolvedValue({ sessione: { authUserId: PARENT } })
  h.schools.mockResolvedValue([SCHOOL])
})

describe('PDF firmato: ogni errore ha un codice tradotto e resta privato', () => {
  it.each(SIGNED_PDF_ERROR_CODES)('prepare/download conservano il codice archivio %s, lo stato e il messaggio', async (pdf_error) => {
    const f = signedFormsClient(); h.client = f.client
    const failure = { pdf_ready: false, pdf_error, pdf_message: 'Messaggio documentale controllato', status: 422, submission: { id: SUBMISSION } }
    h.ensure.mockResolvedValue(failure); h.download.mockResolvedValue(failure)
    for (const method of ['POST', 'GET'] as const) {
      const response = await ({ GET, POST })[method](request(method))
      expect(response.status).toBe(failure.status)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toMatchObject({ error: failure.pdf_message, codice: pdf_error, pdf_error, pdf_ready: false })
    }
    expectTranslated(pdf_error)
    expect(h.auth).toHaveBeenCalledWith(expect.anything(), PARENT)
  })
  it.each(['GET', 'POST'] as const)('%s: errore della query ownership non rivela la prosa DB', async (method) => {
    const f = signedFormsClient(); h.client = f.client
    f.faults['forms_submissions:select'] = { code: 'XX000', message: 'dettaglio database riservato' }
    const response = await ({ GET, POST })[method](request(method))
    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json()
    expect(body).toEqual({ error: 'Documento non disponibile', codice: 'MODULO_FIRMATO_ACCESSO_NON_VERIFICATO' })
    expectTranslated(body.codice)
    expect(h.ensure).not.toHaveBeenCalled(); expect(h.download).not.toHaveBeenCalled()
  })
  it.each(['GET', 'POST'] as const)('%s: altro firmatario ha codice esplicito senza consultare l’archivio', async (method) => {
    const f = signedFormsClient(); h.client = f.client
    h.auth.mockResolvedValue({ user: { id: '66666666-6666-4666-8666-666666666666', role: 'genitore' } })
    const response = await ({ GET, POST })[method](request(method))
    expect(response.status).toBe(403)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json()
    expect(body).toEqual({ error: 'Accesso non consentito', codice: 'MODULO_FIRMATO_ACCESSO_NEGATO' })
    expectTranslated(body.codice)
    expect(h.ensure).not.toHaveBeenCalled(); expect(h.download).not.toHaveBeenCalled()
  })
  it.each([
    { method: 'GET' as const, codice: 'MODULO_FIRMATO_NON_LETTO', error: 'Non è stato possibile leggere il documento' },
    { method: 'POST' as const, codice: 'MODULO_FIRMATO_NON_PREPARATO', error: 'Non è stato possibile preparare il documento' },
  ])('$method: eccezione archivio conserva 500 senza esporre il dettaglio interno', async ({ method, codice, error }) => {
    const f = signedFormsClient(); h.client = f.client
    h.ensure.mockRejectedValue(new Error('dettaglio archivio riservato')); h.download.mockRejectedValue(new Error('dettaglio archivio riservato'))
    const response = await ({ GET, POST })[method](request(method))
    expect(response.status).toBe(500)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({ error, codice })
    expectTranslated(codice)
  })
})
