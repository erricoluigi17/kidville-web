import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

import itAdminAltro from '../../messages/it/adminAltro.json'
import enAdminAltro from '../../messages/en/adminAltro.json'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

/**
 * «Copia link» del Modulo d'iscrizione standard (prova di facilità d'uso, 14/11): copiava senza mostrare
 * niente, e il link della singola sede (`/iscrizione?scuola=<id>`) non si trovava da nessuna parte.
 * Il link unico `/iscrizione` resta (è una scelta del titolare): il link della sede si AGGIUNGE.
 */

const h = vi.hoisted(() => ({ sedeCorrente: null as string | null }))

vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({
    sedi: [{ id: 'aaaaaaaa-0000-4000-8000-00000000000a', nome: 'Kidville Prova' }],
    selezionate: [],
    effettive: [],
    sedeCorrente: h.sedeCorrente,
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
vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'errore' }))
vi.mock('next/link', async () => {
  const React = await import('react')
  return { default: ({ children, href }: { children?: React.ReactNode; href: string }) => React.createElement('a', { href }, children) }
})

import { ModuliInviabili } from '@/components/features/admin/iscrizioni/ModuliInviabili'

const scrivi = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  h.sedeCorrente = SEDE_A
  scrivi.mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: scrivi } })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }))
})

const standard = () => screen.getAllByRole('button', { name: itAdminAltro.inviabiliCopiaLink })[0]

describe('ModuliInviabili — «Copia link» mostra l’indirizzo copiato', () => {
  it('il link unico: copia /iscrizione e lo scrive a schermo', async () => {
    render(<ModuliInviabili />)
    await waitFor(() => expect(standard()).toBeInTheDocument())
    fireEvent.click(standard())
    const unico = `${window.location.origin}/iscrizione`
    await waitFor(() => expect(scrivi).toHaveBeenCalledWith(unico))
    expect(await screen.findByText(unico)).toBeInTheDocument()
  })

  it('con UNA sede in vista offre anche il link della sede, e lo mostra', async () => {
    render(<ModuliInviabili />)
    const btn = await screen.findByRole('button', { name: /Kidville Prova/ })
    fireEvent.click(btn)
    const sede = `${window.location.origin}/iscrizione?scuola=${SEDE_A}`
    await waitFor(() => expect(scrivi).toHaveBeenCalledWith(sede))
    expect(await screen.findByText(sede)).toBeInTheDocument()
  })

  it('il link della sede non sostituisce quello unico: i due bottoni ci sono insieme', async () => {
    render(<ModuliInviabili />)
    await screen.findByRole('button', { name: /Kidville Prova/ })
    expect(standard()).toBeInTheDocument()
  })

  it('con più sedi in vista (nessuna sede corrente) il bottone della sede non c’è, resta il link unico', async () => {
    h.sedeCorrente = null
    render(<ModuliInviabili />)
    await waitFor(() => expect(standard()).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /Kidville Prova/ })).toBeNull()
  })

  it('una sede corrente che non è nell’elenco delle sedi (es. la Demo) usa comunque l’id, senza inventarsi un nome', async () => {
    h.sedeCorrente = SEDE_B
    render(<ModuliInviabili />)
    const btn = await screen.findByRole('button', { name: itAdminAltro.inviabiliCopiaLinkSedeSenzaNome })
    fireEvent.click(btn)
    await waitFor(() => expect(scrivi).toHaveBeenCalledWith(`${window.location.origin}/iscrizione?scuola=${SEDE_B}`))
  })

  it('le chiavi nuove esistono in it ed en', () => {
    for (const k of ['inviabiliCopiaLinkSede', 'inviabiliCopiaLinkSedeSenzaNome', 'inviabiliIndirizzoCopiato']) {
      expect(itAdminAltro).toHaveProperty(k)
      expect(enAdminAltro).toHaveProperty(k)
    }
  })
})
