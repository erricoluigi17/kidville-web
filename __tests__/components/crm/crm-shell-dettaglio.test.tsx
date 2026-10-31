import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useState } from 'react'
import { SEDE_A } from '../../fixtures/sedi'
import { CrmShell } from '@/components/features/crm/CrmShell'

/**
 * CRM della segreteria · Compito 1.6 — il pannello di dettaglio della cornice.
 *
 * Aprire una famiglia (dall'elenco, dall'agenda o dai richiami) la mostra nello stesso pannello.
 * Le schermate vere arrivano dalle sessioni 2, 3 e 5: qui sono finte, e fanno una cosa sola —
 * chiamare `onApri` / `onApriScheda` con un id — perché è l'unico gesto che la cornice deve capire.
 *
 * I contatori di montaggio servono al difetto che il test «non rimonta l'agenda» sorveglia: se la
 * cornice cambiasse la forma dell'albero aprendo il pannello, l'agenda verrebbe distrutta e
 * ricreata, e la settimana che la segreteria stava guardando tornerebbe a quella di oggi.
 */

const h = vi.hoisted(() => ({
  query: '',
  montaggi: { agenda: 0, elenco: 0, richiamare: 0 },
  dettaglio: [] as string[],
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(h.query),
  usePathname: () => '/admin/crm',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))

vi.mock('@/components/features/crm/agenda/AgendaSettimana', () => ({
  AgendaSettimana: ({ onApriScheda }: { onApriScheda: (id: string) => void }) => {
    useState(() => {
      h.montaggi.agenda++
      return null
    })
    return (
      <button type="button" onClick={() => onApriScheda('scheda-dall-agenda')}>
        apri-dall-agenda
      </button>
    )
  },
}))
vi.mock('@/components/features/crm/schede/ElencoSchede', () => ({
  ElencoSchede: ({ onApri }: { onApri: (id: string) => void }) => {
    useState(() => {
      h.montaggi.elenco++
      return null
    })
    return (
      <>
        <button type="button" onClick={() => onApri('scheda-1')}>
          apri-scheda-1
        </button>
        <button type="button" onClick={() => onApri('scheda-2')}>
          apri-scheda-2
        </button>
      </>
    )
  },
}))
vi.mock('@/components/features/crm/follow-up/DaRichiamare', () => ({
  DaRichiamare: ({ onApriScheda }: { onApriScheda: (id: string) => void }) => {
    useState(() => {
      h.montaggi.richiamare++
      return null
    })
    return (
      <button type="button" onClick={() => onApriScheda('scheda-dal-richiamo')}>
        apri-dal-richiamo
      </button>
    )
  },
}))
vi.mock('@/components/features/crm/schede/DettaglioScheda', () => ({
  DettaglioScheda: ({ schedaId, onChiudi }: { schedaId: string; onChiudi: () => void }) => {
    useState(() => {
      h.dettaglio.push(schedaId)
      return null
    })
    return (
      <div data-testid="dettaglio" data-scheda-id={schedaId}>
        <button type="button" onClick={onChiudi}>
          chiudi-dettaglio
        </button>
      </div>
    )
  },
}))

const INVITO = 'Scegli una scheda dall’elenco per vederne lo storico.'

beforeEach(() => {
  h.query = ''
  h.montaggi.agenda = 0
  h.montaggi.elenco = 0
  h.montaggi.richiamare = 0
  h.dettaglio.length = 0
  window.history.replaceState(null, '', '/admin/crm')
})

describe('CrmShell · il pannello di dettaglio', () => {
  it('nella linguetta Schede il pannello c’è sempre, con l’invito a sceglierne una', () => {
    h.query = 'tab=schede'
    render(<CrmShell scuolaId={SEDE_A} />)
    expect(screen.getByText(INVITO)).toBeTruthy()
    expect(screen.queryByTestId('dettaglio')).toBeNull()
  })

  it('aprire una famiglia dall’elenco la mostra nel pannello, al posto dell’invito', () => {
    h.query = 'tab=schede'
    render(<CrmShell scuolaId={SEDE_A} />)

    fireEvent.click(screen.getByRole('button', { name: 'apri-scheda-1' }))

    expect(screen.getByTestId('dettaglio').getAttribute('data-scheda-id')).toBe('scheda-1')
    expect(screen.queryByText(INVITO)).toBeNull()
  })

  it('passare da una famiglia all’altra rimonta il dettaglio: niente stato della scheda di prima', () => {
    h.query = 'tab=schede'
    render(<CrmShell scuolaId={SEDE_A} />)

    fireEvent.click(screen.getByRole('button', { name: 'apri-scheda-1' }))
    fireEvent.click(screen.getByRole('button', { name: 'apri-scheda-2' }))

    expect(screen.getByTestId('dettaglio').getAttribute('data-scheda-id')).toBe('scheda-2')
    // Una montatura per famiglia: con la stessa istanza riusata, un campo digitato per la prima
    // resterebbe compilato davanti alla seconda.
    expect(h.dettaglio).toEqual(['scheda-1', 'scheda-2'])
  })

  it('«chiudi» riporta l’invito', () => {
    h.query = 'tab=schede'
    render(<CrmShell scuolaId={SEDE_A} />)
    fireEvent.click(screen.getByRole('button', { name: 'apri-scheda-1' }))

    fireEvent.click(screen.getByRole('button', { name: 'chiudi-dettaglio' }))

    expect(screen.queryByTestId('dettaglio')).toBeNull()
    expect(screen.getByText(INVITO)).toBeTruthy()
  })

  it('dall’agenda il pannello compare solo quando si apre una famiglia, e senza rimontare l’agenda', () => {
    h.query = 'tab=agenda'
    render(<CrmShell scuolaId={SEDE_A} />)
    expect(screen.queryByText(INVITO)).toBeNull()
    expect(h.montaggi.agenda).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: 'apri-dall-agenda' }))

    expect(screen.getByTestId('dettaglio').getAttribute('data-scheda-id')).toBe('scheda-dall-agenda')
    // ⚠️ Il contenuto sta nello stesso punto dell'albero con o senza pannello.
    expect(h.montaggi.agenda).toBe(1)
  })

  it('dai richiami si apre allo stesso modo', () => {
    h.query = 'tab=richiamare'
    render(<CrmShell scuolaId={SEDE_A} />)

    fireEvent.click(screen.getByRole('button', { name: 'apri-dal-richiamo' }))

    expect(screen.getByTestId('dettaglio').getAttribute('data-scheda-id')).toBe('scheda-dal-richiamo')
    expect(h.montaggi.richiamare).toBe(1)
  })

  it('cambiare linguetta chiude il dettaglio: non resta una famiglia accanto a un elenco che non è il suo', () => {
    h.query = 'tab=richiamare'
    render(<CrmShell scuolaId={SEDE_A} />)
    fireEvent.click(screen.getByRole('button', { name: 'apri-dal-richiamo' }))
    expect(screen.getByTestId('dettaglio')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Agenda' }))

    expect(screen.queryByTestId('dettaglio')).toBeNull()
    // …e tornando all'elenco dei richiami non c'è un pannello fantasma.
    fireEvent.click(screen.getByRole('button', { name: 'Da richiamare' }))
    expect(screen.queryByTestId('dettaglio')).toBeNull()
  })

  it('disponibilità e statistiche non hanno mai un pannello: non aprono famiglie', () => {
    for (const tab of ['disponibilita', 'statistiche']) {
      h.query = `tab=${tab}`
      const { unmount } = render(<CrmShell scuolaId={SEDE_A} />)
      expect(screen.queryByText(INVITO)).toBeNull()
      expect(screen.queryByTestId('dettaglio')).toBeNull()
      unmount()
    }
  })
})
