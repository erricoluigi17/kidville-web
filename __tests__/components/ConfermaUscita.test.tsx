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
  it('il primo tocco su «Esci» NON esce: apre «Vuoi uscire da Kidville?»', () => {
    render(<LogoutMenuButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Esci' }))
    expect(doLogout).not.toHaveBeenCalled()
    const dialogo = screen.getByRole('dialog')
    expect(dialogo).toHaveAccessibleName('Vuoi uscire da Kidville?')
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
