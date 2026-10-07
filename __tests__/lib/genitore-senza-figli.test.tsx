import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, renderHook, screen, waitFor } from '@testing-library/react'

/**
 * «NESSUN BAMBINO COLLEGATO A QUESTO ACCESSO» — l'app non deve girare in spinner.
 *
 * Un account genitore con zero legami entrava senza errori e poi non vedeva
 * niente: la home vuota e le altre schermate (galleria, diario, armadietto…) in
 * attesa per sempre di uno `studentId`. Caso reale del 2026-10-06: il bambino era
 * stato collegato a un secondo profilo della stessa persona.
 *
 * ⚠️ E NON DEVE SCATTARE OFFLINE: senza risposta il server non ha detto niente, e
 * «nessun figlio» a chi ha solo la rete giù è peggio di uno spinner.
 */

// Il router DEVE essere lo stesso oggetto a ogni render, come quello vero di Next:
// `useSessionIdentity` lo ha fra le dipendenze di un effetto che poi cambia stato, e
// un oggetto nuovo a ogni chiamata lo rilancia all'infinito (heap esaurito).
const mockRouter = { replace: vi.fn(), refresh: vi.fn() }
let mockSearch = new URLSearchParams()
let mockPathname = '/parent'

vi.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => mockSearch,
  usePathname: () => mockPathname,
}))

import { useParentIdentity, invalidaFigliCache } from '@/lib/auth/use-parent-identity'
import { GuardiaSenzaFigli, eRottaSenzaFiglio } from '@/components/features/parent/GuardiaSenzaFigli'
import catalogoIt from '../../messages/it/parentServizi.json'

const fetchMock = vi.fn()
const risposta = (body: unknown) => ({ ok: true, json: async () => body })

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock.mockReset()
  invalidaFigliCache()
  window.localStorage.clear()
  window.localStorage.setItem('kv_user_id', 'P1')
  mockSearch = new URLSearchParams()
  mockPathname = '/parent'
  vi.stubGlobal('fetch', fetchMock)
})

describe('useParentIdentity — `senzaFigli`', () => {
  it('elenco vuoto e `senza_figli: true` ⇒ senzaFigli vero', async () => {
    fetchMock.mockResolvedValue(risposta({ success: true, data: [], senza_figli: true, in_attesa: false }))
    const { result } = renderHook(() => useParentIdentity())
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.senzaFigli).toBe(true)
    expect(result.current.inAttesa).toBe(false)
    expect(result.current.studentId).toBeNull()
  })

  it('`in_attesa: true` ⇒ senzaFigli FALSO anche se il server mandasse entrambi', async () => {
    fetchMock.mockResolvedValue(risposta({ success: true, data: [], senza_figli: true, in_attesa: true }))
    const { result } = renderHook(() => useParentIdentity())
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.inAttesa).toBe(true)
    expect(result.current.senzaFigli, 'un legame c\'è: il bambino esiste, è solo nascosto').toBe(false)
  })

  it('campo assente (server vecchio) ⇒ FALSO: il comportamento di prima', async () => {
    fetchMock.mockResolvedValue(risposta({ success: true, data: [] }))
    const { result } = renderHook(() => useParentIdentity())
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.senzaFigli).toBe(false)
  })

  it('rete giù ⇒ FALSO', async () => {
    fetchMock.mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() => useParentIdentity())
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.senzaFigli).toBe(false)
  })

  it('endpoint non-ok ⇒ FALSO', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) })
    const { result } = renderHook(() => useParentIdentity())
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.senzaFigli).toBe(false)
  })

  it('un figlio visibile ⇒ FALSO, anche con `senza_figli: true` (contraddittorio: vincono i figli)', async () => {
    fetchMock.mockResolvedValue(risposta({ success: true, data: [{ id: 'A' }], senza_figli: true }))
    const { result } = renderHook(() => useParentIdentity())
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.senzaFigli).toBe(false)
    expect(result.current.studentId).toBe('A')
  })
})

describe('GuardiaSenzaFigli', () => {
  const montaLaPagina = () =>
    render(
      <GuardiaSenzaFigli>
        <div>CONTENUTO-DELLA-PAGINA</div>
      </GuardiaSenzaFigli>,
    )

  it('senza figli ⇒ il pannello al posto della pagina, con la frase del catalogo', async () => {
    fetchMock.mockResolvedValue(risposta({ success: true, data: [], senza_figli: true }))
    montaLaPagina()
    await waitFor(() => expect(screen.getByText(catalogoIt.senzaFigliTitolo)).toBeTruthy())
    expect(screen.queryByText('CONTENUTO-DELLA-PAGINA')).toBeNull()
    expect(screen.getByText(catalogoIt.senzaFigliTesto)).toBeTruthy()
    const link = screen.getByText(catalogoIt.senzaFigliProfilo).closest('a')
    expect(link?.getAttribute('href')).toBe('/parent/profilo')
  })

  it('il PROFILO resta raggiungibile: da lì si esce e si rientra con l\'altro indirizzo', async () => {
    fetchMock.mockResolvedValue(risposta({ success: true, data: [], senza_figli: true }))
    mockPathname = '/parent/profilo'
    montaLaPagina()
    // Si aspetta la risposta della sonda, poi si verifica che NON abbia coperto la pagina.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText('CONTENUTO-DELLA-PAGINA')).toBeTruthy())
    expect(screen.queryByText(catalogoIt.senzaFigliTitolo)).toBeNull()
  })

  it('chi ha un figlio vede la pagina, mai il pannello', async () => {
    fetchMock.mockResolvedValue(risposta({ success: true, data: [{ id: 'A' }], senza_figli: false }))
    montaLaPagina()
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(screen.getByText('CONTENUTO-DELLA-PAGINA')).toBeTruthy()
    expect(screen.queryByText(catalogoIt.senzaFigliTitolo)).toBeNull()
  })

  it('OFFLINE ⇒ la pagina, non il pannello: l\'assenza di risposta non è «nessun figlio»', async () => {
    fetchMock.mockRejectedValue(new Error('offline'))
    montaLaPagina()
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    // Un giro in più: se il pannello dovesse comparire per errore, comparirebbe ora.
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.getByText('CONTENUTO-DELLA-PAGINA')).toBeTruthy()
    expect(screen.queryByText(catalogoIt.senzaFigliTitolo)).toBeNull()
  })

  it('PRIMA della risposta si vede già la pagina: nessun lampo di pannello per chi ha figli', () => {
    fetchMock.mockReturnValue(new Promise(() => {})) // mai risolta
    montaLaPagina()
    expect(screen.getByText('CONTENUTO-DELLA-PAGINA')).toBeTruthy()
  })
})

describe('eRottaSenzaFiglio', () => {
  it('profilo e primo accesso sì; le schermate che vogliono un bambino no', () => {
    expect(eRottaSenzaFiglio('/parent/profilo')).toBe(true)
    expect(eRottaSenzaFiglio('/parent/profilo/qualcosa')).toBe(true)
    expect(eRottaSenzaFiglio('/parent/onboarding')).toBe(true)
    expect(eRottaSenzaFiglio('/parent')).toBe(false)
    expect(eRottaSenzaFiglio('/parent/gallery')).toBe(false)
    expect(eRottaSenzaFiglio('/parent/profilofalso')).toBe(false)
    expect(eRottaSenzaFiglio(null)).toBe(false)
  })
})
