import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, within } from '@testing-library/react'
import { StaffPanel } from '@/components/features/admin/settings/StaffPanel'

/**
 * IL PULSANTE «RIGENERA» DIPENDE DA CHI SI STA GUARDANDO, NON SOLO DA CHI GUARDA.
 *
 * Fino al 2026-09-03 questo pannello aveva un `canEdit` solo, che governava
 * insieme «modifica ruolo/sede/classi» e «rigenera credenziali»: alla Segreteria
 * non compariva nessuno dei due. A Cesa — due segreterie, ZERO account di
 * Direzione — questo significava telefonare al titolare per ogni password persa.
 *
 * Ora i due poteri sono separati. La modifica del ruolo resta della Direzione, ed
 * è ciò che rende non aggirabile la riserva: se la Segreteria potesse promuovere
 * un collega ad `admin`, si prenderebbe per via indiretta ciò che il server le
 * nega sulle credenziali di Direzione.
 */
const h = vi.hoisted(() => ({ ruolo: 'segreteria' as string }))

vi.mock('@/lib/auth/use-session-identity', () => ({
  useSessionIdentity: () => ({ userId: 'u1', role: h.ruolo, ready: true }),
}))
vi.mock('@/lib/auth/ruoli', () => ({
  RUOLI_ASSEGNABILI: [{ value: 'educator', label: 'Docente' }],
  useLabelRuolo: () => (r: string) => r,
}))

const STAFF = [
  { id: 's-edu', nome: 'Rosa', cognome: 'Bianchi', email: 'r@example.test', ruolo: 'educator', scuola_id: 'sede-1' },
  { id: 's-adm', nome: 'Luigi', cognome: 'Verdi', email: 'l@example.test', ruolo: 'admin', scuola_id: 'sede-1' },
  { id: 's-coo', nome: 'Ada', cognome: 'Neri', email: 'a@example.test', ruolo: 'coordinator', scuola_id: 'sede-1' },
]

beforeEach(() => {
  h.ruolo = 'segreteria'
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const corpo = String(url).includes('/api/admin/staff')
      ? { success: true, data: STAFF, schools: [], sections: [], assegnazioni: [] }
      : { success: true, data: [] }
    return new Response(JSON.stringify(corpo), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

/**
 * LA RIGA DI UNA PERSONA, non il primo nodo che contiene quel testo.
 * `getByText` pesca i sosia: in questo repo un `getByText('Riepilogo')` ha fatto
 * passare per due settimane un test che restava sul passo precedente. Qui si
 * risale al contenitore della riga e si cerca DENTRO quello.
 */
async function riga(cognome: string) {
  const nome = await screen.findByText(cognome, { exact: false })
  const contenitore = nome.closest('div.rounded-xl')
  expect(contenitore, `riga di ${cognome} non trovata`).not.toBeNull()
  return within(contenitore as HTMLElement)
}

describe('StaffPanel — «rigenera» segue il bersaglio, «modifica» resta alla Direzione', () => {
  it('la Segreteria vede «rigenera» sulla maestra', async () => {
    render(<StaffPanel userId="u1" />)
    const r = await riga('Bianchi')
    expect(r.getByTitle('Rigenera credenziali')).toBeInTheDocument()
  })

  it.each(['Verdi', 'Neri'])('la Segreteria NON vede «rigenera» su %s (Direzione)', async (cognome) => {
    render(<StaffPanel userId="u1" />)
    const r = await riga(cognome)
    expect(r.queryByTitle('Rigenera credenziali')).toBeNull()
  })

  it('la Segreteria non vede MAI «modifica», nemmeno sulla maestra', async () => {
    render(<StaffPanel userId="u1" />)
    await riga('Bianchi')
    // È la riserva che tiene in piedi l'altra: senza, una segreteria
    // promuoverebbe un collega ad `admin` e da lì rigenererebbe qualunque cosa.
    expect(screen.queryAllByTitle('Modifica')).toHaveLength(0)
  })

  it("l'admin vede entrambi su tutti e tre (non regredisce)", async () => {
    h.ruolo = 'admin'
    render(<StaffPanel userId="u1" />)
    await riga('Bianchi')
    await waitFor(() => expect(screen.getAllByTitle('Rigenera credenziali')).toHaveLength(3))
    expect(screen.getAllByTitle('Modifica')).toHaveLength(3)
  })

  it('una cuoca non vede nessuno dei due, su nessuno', async () => {
    h.ruolo = 'cuoca'
    render(<StaffPanel userId="u1" />)
    await riga('Bianchi')
    expect(screen.queryAllByTitle('Rigenera credenziali')).toHaveLength(0)
    expect(screen.queryAllByTitle('Modifica')).toHaveLength(0)
  })
})
