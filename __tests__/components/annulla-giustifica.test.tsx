import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { AnnullaGiustifica } from '@/components/features/presenze/AnnullaGiustifica'
vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Errore' }))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const props = () => ({ presenzaId: 'presenza', firmaIl: '2026-09-10T08:30:00.123456+00:00', onCambiato: vi.fn() })

describe('revoca giustifica nel flusso appello', () => {
  it('chiede conferma e trasmette la versione esatta della firma prima di mostrare successo', async () => {
    const fetch = vi.fn<(url: string, init: RequestInit) => Promise<{ ok: boolean }>>(async () => ({ ok: true }))
    vi.stubGlobal('fetch', fetch)
    const p = props()
    render(<AnnullaGiustifica {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Annulla giustifica' }))
    expect(fetch).not.toHaveBeenCalled()
    expect(screen.getByText(/firma originali restano conservati/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Conferma annullamento' }))
    await screen.findByRole('status')
    expect(JSON.parse(String(fetch.mock.calls[0]![1].body))).toEqual({ presenzaId: 'presenza', firmaIl: p.firmaIl })
    expect(p.onCambiato).toHaveBeenCalledOnce()
  })
  it('un rifiuto non diventa un falso annullamento riuscito', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 409 })))
    const p = props()
    render(<AnnullaGiustifica {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Annulla giustifica' }))
    fireEvent.click(screen.getByRole('button', { name: 'Conferma annullamento' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Giustifica non annullata')
    expect(p.onCambiato).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).toBeNull()
  })
  it('una rilettura fallita dopo il 200 conserva la conferma di revoca effettiva', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })))
    const p = props(); p.onCambiato.mockRejectedValue(new Error('rete'))
    render(<AnnullaGiustifica {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Annulla giustifica' }))
    fireEvent.click(screen.getByRole('button', { name: 'Conferma annullamento' }))
    await waitFor(() => expect(p.onCambiato).toHaveBeenCalled())
    expect(await screen.findByRole('status')).toHaveTextContent('Giustifica annullata. Originale conservato.')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
