// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * `/m/[token]` — UN DATABASE CHE NON RISPONDE NON È UN MODULO INESISTENTE.
 *
 * Fase 11 della roadmap di robustezza («errori non ignorati», 2026-10-19). La pagina leggeva il
 * modello col solo `data`: PostgREST non lancia, quindi un guasto diventava `model = null` e poi
 * `notFound()` — cioè il 404 che dice alla famiglia «il link è sbagliato» mentre il link è giusto
 * e il database è giù. Adesso il guasto si logga e si lancia: risponde `app/error.tsx`, col suo
 * «Riprova».
 *
 * Il token è la CREDENZIALE che apre il modulo di preiscrizione di un minore: non deve comparire
 * né nel log né nell'errore lanciato.
 */

const esito = vi.hoisted(() => ({
  risultato: { data: null as unknown, error: null as unknown },
}))

vi.mock('@/lib/supabase/server-client', () => {
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => esito.risultato,
  }
  return {
    createAdminClient: async () => ({ from: () => builder }),
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
  }
})

const notFound = vi.hoisted(() => vi.fn(() => { throw new Error('NEXT_NOT_FOUND') }))
vi.mock('next/navigation', () => ({ notFound }))

vi.mock('next-intl/server', () => ({
  getTranslations: async () => Object.assign((k: string) => k, { rich: (k: string) => k }),
}))

// Il wizard è un componente client: qui si misura solo la decisione del server.
vi.mock('@/components/features/parent/forms/WizardContainer', () => ({ WizardContainer: () => null }))

const logErrore = vi.hoisted(() => vi.fn())
vi.mock('@/lib/logging/logger', () => ({ logErrore }))

import PublicFormPage from '@/app/m/[token]/page'

const TOKEN = 'tok-di-prova-0123456789abcdef'

beforeEach(() => {
  vi.clearAllMocks()
  esito.risultato = { data: null, error: null }
})

describe('/m/[token] — guasto del database contro modulo inesistente', () => {
  it('un guasto di lettura NON diventa un 404: si logga e si lancia', async () => {
    esito.risultato = { data: null, error: { code: '08006', message: 'connection failure' } }

    const errore = await PublicFormPage({ params: Promise.resolve({ token: TOKEN }) }).catch((e: unknown) => e)

    expect(errore).toBeInstanceOf(Error)
    expect((errore as Error).message).not.toBe('NEXT_NOT_FOUND')
    expect(notFound).not.toHaveBeenCalled()
    expect(logErrore).toHaveBeenCalledTimes(1)
    expect(logErrore.mock.calls[0][0]).toMatchObject({ operazione: 'm/[token]:page', stato: 500, evento: 'db:form_models' })
    // La credenziale non esce: né nella riga di log né nel messaggio dell'errore.
    expect(JSON.stringify(logErrore.mock.calls)).not.toContain(TOKEN)
    expect((errore as Error).message).not.toContain(TOKEN)
  })

  it('un modello che non c’è resta un 404, come prima', async () => {
    esito.risultato = { data: null, error: null }

    const errore = await PublicFormPage({ params: Promise.resolve({ token: TOKEN }) }).catch((e: unknown) => e)

    expect((errore as Error).message).toBe('NEXT_NOT_FOUND')
    expect(notFound).toHaveBeenCalledTimes(1)
    expect(logErrore).not.toHaveBeenCalled()
  })
})
