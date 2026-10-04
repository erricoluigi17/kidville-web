import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import primaria from '../../messages/it/adminPrimaria.json'
import { FascicoloAuditViewer } from '@/components/features/admin/primaria/FascicoloAuditViewer'

const T = primaria as Record<string, string>

const riga = (id: string, finalita: string | null, cognome: string) => ({
  id,
  azione: 'view',
  finalita,
  ip: null,
  creato_il: '2026-10-04T08:00:00.000Z',
  utenti: { nome: 'Docente', cognome: 'Prova-E2E' },
  alunni: { nome: 'Bimbo', cognome },
})

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        success: true,
        data: [riga('r1', 'anagrafica-docente', 'Anagrafica-E2E'), riga('r2', 'stampa del modulo', 'Altro-E2E'), riga('r3', null, 'Nulla-E2E')],
      }),
    })),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('FascicoloAuditViewer — la finalità «anagrafica docente»', () => {
  it('la riga della scheda anagrafica dice che cosa è stato aperto', async () => {
    render(<FascicoloAuditViewer scuolaId="s" userId="u" />)
    const cella = (await screen.findByText(/Anagrafica-E2E/)).closest('tr') as HTMLElement
    expect(within(cella).getByText(T.fascicoloFinalitaAnagraficaDocente)).toBeTruthy()
  })

  it('le altre righe restano come prima', async () => {
    render(<FascicoloAuditViewer scuolaId="s" userId="u" />)
    for (const cognome of [/Altro-E2E/, /Nulla-E2E/]) {
      const tr = (await screen.findByText(cognome)).closest('tr') as HTMLElement
      expect(within(tr).queryByText(T.fascicoloFinalitaAnagraficaDocente)).toBeNull()
      expect(within(tr).getByText(T.fascicoloAzioneView)).toBeTruthy()
    }
  })
})
