// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

// La pagina di conferma è un GET PURO: caricarla non deve toccare il DB né
// registrare alcuna richiesta (uno scanner email che prefetcha il link non deve
// poterla attivare). Lo si prova mostrando che createAdminClient — l'unico modo
// per ottenere un client DB — non viene MAI invocato al rendering della pagina.
const createAdminClient = vi.fn(() => {
  throw new Error('createAdminClient non deve essere chiamato dal GET della pagina di conferma')
})
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient }))

vi.mock('next-intl/server', () => ({
  getTranslations: async () => Object.assign((k: string) => k, { rich: (k: string) => k }),
}))

import ConfermaCancellazionePage from '@/app/cancellazione-account/conferma/page'

beforeEach(() => vi.clearAllMocks())

describe('GET /cancellazione-account/conferma — nessuna mutazione', () => {
  it('con parametri completi non accede al DB (nessun createAdminClient)', async () => {
    const el = await ConfermaCancellazionePage({
      searchParams: Promise.resolve({
        email: 'genitore@example.com',
        code: 'abc',
        expiry: String(Date.now() + 60000),
        ticket: 'deadbeef',
      }),
    })
    expect(el).toBeTruthy()
    expect(createAdminClient).not.toHaveBeenCalled()
  })

  it('anche senza parametri (link incompleto) non accede al DB', async () => {
    const el = await ConfermaCancellazionePage({ searchParams: Promise.resolve({}) })
    expect(el).toBeTruthy()
    expect(createAdminClient).not.toHaveBeenCalled()
  })
})
