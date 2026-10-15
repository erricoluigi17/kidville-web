import { afterEach, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { CompetenzaStorica } from '@/components/features/primaria/CompetenzaStorica'

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Errore' }))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const props = () => ({ attiva: true, sectionId: 'classe', userId: 'staff', data: '2026-01-10', onData: vi.fn(), docenteId: '', onDocente: vi.fn() })

describe('competenze storiche nella pagina condivisa admin/docente', () => {
  it('il docente ordinario non vede né carica opzioni amministrative', () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    render(<CompetenzaStorica {...props()} attiva={false} />)
    expect(screen.queryByLabelText('Data di competenza')).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })
  it('per lo staff rende data storica e titolare, escludendo personale non docente', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: true, assigned: [
      { id: 'maestra', nome: 'Ada', cognome: 'Fittizia', ruolo: 'educator' },
      { id: 'staff', nome: 'Staff', cognome: 'Fittizio', ruolo: 'segreteria' },
    ] }) })))
    const p = props()
    render(<CompetenzaStorica {...p} />)
    expect(await screen.findByRole('option', { name: 'Fittizia Ada' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Fittizio Staff' })).toBeNull()
    fireEvent.change(screen.getByLabelText('Data di competenza'), { target: { value: '2020-04-02' } })
    fireEvent.change(screen.getByLabelText('Docente titolare'), { target: { value: 'maestra' } })
    expect(p.onData).toHaveBeenCalledWith('2020-04-02')
    expect(p.onDocente).toHaveBeenCalledWith('maestra')
    expect(screen.getByRole('status')).toHaveTextContent('senza inviare avvisi alla famiglia')
  })
})
