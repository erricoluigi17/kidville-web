import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

/**
 * FASE 11 DELLA ROADMAP DI ROBUSTEZZA — «errori non ignorati», lato INTERFACCIA.
 *
 * Fino al 2026-10-19 in questi componenti una lettura che non andava a buon fine finiva in un
 * `.catch(() => {})`: nessuna riga nel log del client, e lo schermo diceva la cosa sbagliata —
 * «Nessun modulo» al posto di «non ho potuto guardare», «Configura prima un periodo» a una
 * segreteria che i periodi li ha già. Qui si prova un caso per forma di correzione:
 *
 *  · il componente che aveva GIÀ uno stato d'errore ora lo mostra (ModuliInviabili, la barra
 *    di stato; ScrutinioGiudiziManager e GeneratoreCategoria, il loro avviso);
 *  · il componente che non ne aveva uno scrive almeno la riga di log (SezioniMultiSelect).
 *
 * Il logger del client è una spia: si misura CHE COSA esce (solo uno slug e il NOME della classe
 * d'errore, mai il suo testo), non come viene spedito.
 */

const logClient = vi.hoisted(() => vi.fn())
vi.mock('@/lib/logging/client', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/logging/client')>()
  return { ...vero, logClient }
})

vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: [],
    selezionate: [],
    effettive: [],
    sedeCorrente: null,
    reFetchKey: '',
    epocaSede: 0,
    errore: false,
    loading: false,
    toggle: vi.fn(),
    soloSede: vi.fn(),
    tutte: vi.fn(),
    ricarica: vi.fn(),
  }),
}))

vi.mock('next/link', async () => {
  const React = await import('react')
  return {
    default: ({ children, href }: { children?: React.ReactNode; href: string }) =>
      React.createElement('a', { href }, children),
  }
})

import { ModuliInviabili } from '@/components/features/admin/iscrizioni/ModuliInviabili'
import { ScrutinioGiudiziManager } from '@/components/features/admin/primaria/ScrutinioGiudiziManager'
import { GeneratoreCategoria } from '@/components/features/admin/pagamenti/GeneratoreCategoria'
import { SezioniMultiSelect } from '@/components/features/admin/SezioniMultiSelect'

const UTENTE = '11111111-1111-4111-8111-111111111111'
const SEDE = '22222222-2222-4222-8222-222222222222'

/** Il testo vero del catalogo `shared` (il mock di next-intl risolve sui messaggi IT reali). */
const LETTURA_FALLITA = 'Non è stato possibile leggere l’elenco'

const risposta = (stato: number, corpo: unknown) => ({
  ok: stato >= 200 && stato < 300,
  status: stato,
  json: async () => corpo,
})

/** La rete giù: la fetch RIFIUTA, che è il caso che il vecchio `.catch(() => {})` inghiottiva. */
const reteGiu = () => Promise.reject(new TypeError('Failed to fetch'))

const messaggi = () => logClient.mock.calls.map((c) => (c[0] as { messaggio: string }).messaggio)

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => vi.unstubAllGlobals())

describe('ModuliInviabili · una lettura fallita non è un elenco vuoto', () => {
  it('un 500 sui modelli mostra lo stato d’errore, non «nessun modulo»', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(url.startsWith('/api/admin/forms/models') ? risposta(500, { error: 'x' }) : risposta(200, {})),
    )
    render(<ModuliInviabili />)

    expect(await screen.findByText(LETTURA_FALLITA)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Riprova' })).toBeInTheDocument()
  })

  it('la rete giù mostra lo stato d’errore E lascia la riga nel log, col solo nome della classe', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.startsWith('/api/admin/forms/models') ? reteGiu() : Promise.resolve(risposta(200, {})),
    )
    render(<ModuliInviabili />)

    expect(await screen.findByText(LETTURA_FALLITA)).toBeInTheDocument()
    expect(messaggi()).toContain('moduli-inviabili-non-caricati: TypeError')
    expect(JSON.stringify(logClient.mock.calls)).not.toContain('Failed to fetch')
  })
})

describe('ScrutinioGiudiziManager · «Configura prima un periodo» non è vero se i periodi non si sono letti', () => {
  it('la lettura dei periodi che fallisce si dice a schermo e nel log', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/scrutinio-periodi')) return reteGiu()
      if (url.includes('/primaria/giudizi')) return Promise.resolve(risposta(200, { success: true, data: { scala: [] } }))
      if (url.includes('/admin/sections')) return Promise.resolve(risposta(200, []))
      return Promise.resolve(risposta(200, { success: true, data: [] }))
    })
    render(<ScrutinioGiudiziManager scuolaId={SEDE} userId={UTENTE} />)

    const avviso = await screen.findByRole('alert')
    expect(avviso).toHaveTextContent(LETTURA_FALLITA)
    expect(messaggi()).toContain('scrutinio-giudizi-periodi-non-caricati: TypeError')
  })
})

describe('GeneratoreCategoria · senza alunni il «tutti» non colpirebbe nessuno', () => {
  it('la lettura degli alunni che fallisce mostra l’avviso di rete prima di qualunque anteprima', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/admin/settings/categorie')) {
        return Promise.resolve(risposta(200, { success: true, data: [{ id: 'c1', nome: 'Gita', slug: 'gita' }] }))
      }
      if (url.startsWith('/api/admin/students')) return reteGiu()
      return Promise.resolve(risposta(200, { success: true, data: [] }))
    })
    render(<GeneratoreCategoria userId={UTENTE} scuolaId={SEDE} />)

    expect(await screen.findByText('Errore di rete')).toBeInTheDocument()
    expect(messaggi()).toContain('generatore-alunni-non-caricati: TypeError')
  })
})

describe('SezioniMultiSelect · nessuno stato d’errore da mostrare: resta la riga di log', () => {
  it('la rete giù sulle sezioni lascia la riga, e il selettore smette di caricare', async () => {
    fetchMock.mockImplementation(() => reteGiu())
    render(<SezioniMultiSelect value={[]} onChange={() => {}} />)

    await waitFor(() => expect(messaggi()).toContain('sezioni-selettore-non-caricate: TypeError'))
    const evento = logClient.mock.calls[0][0] as { livello: string; evento: string }
    expect(evento.livello).toBe('warn')
    expect(evento.evento).toBe('fetch')
  })
})
