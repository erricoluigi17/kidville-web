import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'

import type { SchedaGenitore, SchedeGenitoreRisposta } from '@/lib/votazioni/tipi'

// =============================================================================
// LA PAGINA /parent/votazioni — il cablaggio dell'identità.
//
// L'elenco e la scheda hanno i loro file di test; qui si prova che la PAGINA risolva chi sei
// (`useSessionIdentity`, finto) e lo passi all'elenco: l'header `x-user-id` della GET, e nessuna
// chiamata finché l'identità non c'è.
// =============================================================================

const identita = vi.hoisted(() => ({ valore: { userId: null as string | null, role: null as string | null, ready: false } }))
vi.mock('@/lib/auth/use-session-identity', () => ({
  useSessionIdentity: () => identita.valore,
}))

import ParentVotazioniPage from '@/app/(dashboard)/parent/votazioni/page'

afterEach(cleanup)

const PARENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const scheda: SchedaGenitore = {
  votazioneId: uuid(1),
  titolo: 'TEST Elezione',
  scadenza: '2026-11-20T17:00:00.000Z',
  ambito: 'classe',
  sectionId: uuid(2),
  classeNome: '3 ANNI A',
  sedeNome: 'TEST Sede Nord',
  candidati: [{ utenteId: uuid(3), nome: 'TEST Alfa' }],
  sceltaAttuale: null,
}

const fetchOriginale = globalThis.fetch

function fetchFinta() {
  const finta = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void input
    void init
    return {
      ok: true,
      status: 200,
      json: async () => ({ disponibile: true, schede: [scheda] }) satisfies SchedeGenitoreRisposta,
    } as unknown as Response
  })
  globalThis.fetch = finta as unknown as typeof globalThis.fetch
  return finta
}

beforeEach(() => {
  identita.valore = { userId: null, role: null, ready: false }
  globalThis.fetch = fetchOriginale
})
afterEach(() => {
  globalThis.fetch = fetchOriginale
})

describe('/parent/votazioni · la pagina', () => {
  it('con l’identità risolta: intestazione, GET con x-user-id e la scheda', async () => {
    identita.valore = { userId: PARENT, role: 'genitore', ready: true }
    const finta = fetchFinta()
    render(<ParentVotazioniPage />)

    expect(screen.getByRole('heading', { level: 1, name: 'Votazioni' })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Rappresentante di classe — 3 ANNI A' })).toBeInTheDocument()

    expect(finta).toHaveBeenCalledTimes(1)
    const [url, init] = finta.mock.calls[0] as unknown as [string, RequestInit | undefined]
    expect(url).toBe('/api/parent/votazioni')
    expect(init?.headers).toMatchObject({ 'x-user-id': PARENT })
  })

  it('🔴 identità non ancora risolta: resta in «caricamento» e NON chiama il server', async () => {
    const finta = fetchFinta()
    render(<ParentVotazioniPage />)

    expect(screen.getByRole('status')).toHaveTextContent('Caricamento delle votazioni…')
    // Il controllo di assenza viene dopo un giro intero di macrotask: «non è stata chiamata» sarebbe
    // vero anche un istante prima di una chiamata che sta per partire.
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(finta).not.toHaveBeenCalled()
    expect(screen.getByRole('status')).toBeInTheDocument()
  })
})
