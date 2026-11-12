import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ScrutinioPeriodiManager } from '@/components/features/admin/primaria/ScrutinioPeriodiManager'

/**
 * R7 (giro 1) · IL RICALCOLO CHE NON RIESCE NON È PIÙ UN SUCCESSO MUTO.
 *
 * Il server salva le date di un periodo e poi riassegna i voti ai quadrimestri; se il secondo passo non riesce risponde 2xx con
 * `ricalcolo: 'non-riuscito'`. Fino alla 4.9 nessuna schermata lo leggeva: la segretaria vedeva «salvato» e i voti restavano senza
 * quadrimestre. Qui la schermata lo dice, e dice altro (niente) quando il ricalcolo è riuscito.
 */

const AVVISO = 'Salvato, ma i voti non sono stati riassegnati ai quadrimestri: avvisa l’assistenza.'
const periodo = { id: 'p1', nome: 'Primo quadrimestre', anno_scolastico: '2026/2027', ordine: 1, data_inizio: '2026-09-15', data_fine: '2027-01-31', attivo: true }

function server(rispostaScrittura: Record<string, unknown>) {
  global.fetch = vi.fn((_url: unknown, init?: RequestInit) => {
    const metodo = init?.method ?? 'GET'
    const corpo = metodo === 'GET' ? { success: true, data: [periodo], dateMancanti: false } : rispostaScrittura
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(corpo) })
  }) as unknown as typeof fetch
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ScrutinioPeriodiManager · il ricalcolo dei voti', () => {
  it('PATCH riuscita con `ricalcolo: non-riuscito` → la schermata lo dice', async () => {
    server({ success: true, ricalcolo: 'non-riuscito' })
    render(<ScrutinioPeriodiManager scuolaId="s1" userId="u1" />)
    fireEvent.click(await screen.findByText('attivo'))
    const avviso = await screen.findByRole('alert')
    expect(avviso.textContent).toBe(AVVISO)
  })

  it('PATCH riuscita con `ricalcolo: fatto` (o non necessario) → nessun avviso', async () => {
    server({ success: true, ricalcolo: 'fatto' })
    render(<ScrutinioPeriodiManager scuolaId="s1" userId="u1" />)
    fireEvent.click(await screen.findByText('attivo'))
    // Prima la PRESENZA di ciò che segue il salvataggio (la ricarica), poi l'assenza.
    await vi.waitFor(() => {
      const chiamate = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
      expect(chiamate.filter((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH')).toHaveLength(1)
      expect(chiamate.length).toBeGreaterThanOrEqual(3)
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
