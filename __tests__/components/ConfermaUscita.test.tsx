import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

// «Esci» chiude la sessione: un tocco sbagliato non deve poterla chiudere (collaudo 13/11: un tocco caduto
// su «Esci» mentre il foglio scorreva per inerzia ha fatto uscire da tutti i dispositivi). Finto solo `doLogout`.
const doLogout = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/lib/auth/logout', () => ({ doLogout }))

import { LogoutMenuButton } from '@/components/ui/LogoutMenuButton'
import { UserMenu } from '@/components/ui/UserMenu'

beforeEach(() => doLogout.mockClear())

describe('LogoutMenuButton: l\'uscita passa dalla conferma', () => {
  it('il primo tocco su «Esci» NON esce: apre «Vuoi uscire da Kidville su questo dispositivo?»', () => {
    render(<LogoutMenuButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Esci' }))
    expect(doLogout).not.toHaveBeenCalled()
    const dialogo = screen.getByRole('dialog')
    expect(dialogo).toHaveAccessibleName('Vuoi uscire da Kidville su questo dispositivo?')
  })

  it('«Annulla» è il predefinito (ha il focus) e chiude senza uscire', async () => {
    render(<LogoutMenuButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Esci' }))
    const annulla = screen.getByRole('button', { name: 'Annulla' })
    await waitFor(() => expect(annulla).toHaveFocus())
    fireEvent.click(annulla)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(doLogout).not.toHaveBeenCalled()
  })

  it('Esc chiude senza uscire', () => {
    render(<LogoutMenuButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Esci' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(doLogout).not.toHaveBeenCalled()
  })

  it('il secondo tocco, su «Esci» DEL DIALOGO, esce una volta sola', async () => {
    render(<LogoutMenuButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Esci' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Esci' }))
    await waitFor(() => expect(doLogout).toHaveBeenCalledTimes(1))
  })

  it('le due azioni del dialogo hanno almeno 44px di area di tocco', () => {
    render(<LogoutMenuButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Esci' }))
    for (const b of within(screen.getByRole('dialog')).getAllByRole('button')) {
      expect(b.className).toContain('min-h-[44px]')
    }
  })
})

describe('UserMenu (barra della segreteria): stessa conferma', () => {
  it('il menuitem «Esci» apre la conferma e non esce; «Esci» del dialogo esce', async () => {
    render(<UserMenu ruoloLabel="Segreteria" />)
    fireEvent.click(screen.getByRole('button', { name: /menu account/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Esci/i }))
    expect(doLogout).not.toHaveBeenCalled()
    const dialogo = screen.getByRole('dialog')
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Annulla' }))
    expect(doLogout).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /menu account/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Esci/i }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Esci' }))
    await waitFor(() => expect(doLogout).toHaveBeenCalledTimes(1))
  })
})

describe('la conferma sta in un portale su document.body (B1)', () => {
  it('dentro un foglio con transform il dialogo NON è figlio del foglio ma di document.body', () => {
    // Un antenato con `transform` diventa il blocco contenitore dei discendenti `fixed`: il dialogo non coprirebbe
    // lo schermo (collaudo/revisione 13/11, fogli Menu di segreteria, docente e genitore).
    render(
      <div data-testid="foglio" style={{ transform: 'translateX(-50%)', overflowY: 'auto' }}>
        <LogoutMenuButton />
      </div>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Esci' }))
    const dialogo = screen.getByRole('dialog')
    expect(screen.getByTestId('foglio').contains(dialogo)).toBe(false)
    expect(document.body.contains(dialogo)).toBe(true)
    let n: HTMLElement | null = dialogo
    while (n && n.parentElement !== document.body) n = n.parentElement
    expect(n?.parentElement).toBe(document.body)
  })
})

describe('dopo «Annulla» il focus torna a un elemento che resta montato (S2)', () => {
  it('LogoutMenuButton: torna al pulsante «Esci»', async () => {
    render(<LogoutMenuButton />)
    const esci = screen.getByRole('button', { name: 'Esci' })
    fireEvent.click(esci)
    fireEvent.click(screen.getByRole('button', { name: 'Annulla' }))
    await waitFor(() => expect(document.activeElement).toBe(esci))
  })

  it('UserMenu: torna al pulsante «Menu account» (il menuitem si smonta)', async () => {
    render(<UserMenu ruoloLabel="Segreteria" />)
    const trigger = screen.getByRole('button', { name: /menu account/i })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /Esci/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Annulla' }))
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })
})
