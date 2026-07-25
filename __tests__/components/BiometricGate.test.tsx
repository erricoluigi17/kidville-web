import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, render, screen, waitFor, cleanup } from '@testing-library/react'
import { BiometricGate } from '@/components/providers/BiometricGate'
import { isNativeApp } from '@/lib/push/native-register'
import {
  biometriaAttiva,
  impostaBiometria,
  statoBiometria,
  verificaBiometria,
} from '@/lib/native/biometric'
import { usePathname } from 'next/navigation'

/**
 * Il gate biometrico non aveva alcun test, ed è così che sono passati i due
 * difetti peggiori del collaudo: il LOOP del prompt su Android (l'app si
 * auto-bloccava e si usciva solo col force-stop) e il gate ARMATO SENZA
 * SESSIONE (l'overlay copriva la schermata di login).
 *
 * Il nodo è il ciclo di vita nativo: `@capacitor/app` va mockato con un registro
 * di listener controllabile, così si possono scatenare `pause` e `resume` nella
 * sequenza esatta prodotta dall'AuthActivity traslucida del plugin biometrico.
 */

const listeners = vi.hoisted(() => new Map<string, () => void>())
const addListener = vi.hoisted(() =>
  vi.fn(async (nome: string, cb: () => void) => {
    listeners.set(nome, cb)
    return { remove: vi.fn() }
  }),
)
vi.mock('@capacitor/app', () => ({ App: { addListener } }))

vi.mock('@/lib/push/native-register', () => ({ isNativeApp: vi.fn() }))
vi.mock('@/lib/native/biometric', async (orig) => {
  const reale = await orig<typeof import('@/lib/native/biometric')>()
  return {
    ANNULLAMENTI_BIOMETRIA: reale.ANNULLAMENTI_BIOMETRIA,
    biometriaAttiva: vi.fn(),
    impostaBiometria: vi.fn(),
    statoBiometria: vi.fn(),
    verificaBiometria: vi.fn(),
  }
})
vi.mock('@/lib/auth/logout', () => ({ doLogout: vi.fn() }))
vi.mock('@/lib/auth/current-user', () => ({ haIdentitaLocale: vi.fn(() => false) }))
vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn() }))
vi.mock('next/navigation', () => ({ usePathname: vi.fn() }))

const mockNativo = vi.mocked(isNativeApp)
const mockAttiva = vi.mocked(biometriaAttiva)
const mockStato = vi.mocked(statoBiometria)
const mockVerifica = vi.mocked(verificaBiometria)
const mockImposta = vi.mocked(impostaBiometria)
const mockPathname = vi.mocked(usePathname)

/** L'overlay di blocco, se presente. */
const overlay = () => screen.queryByRole('dialog')

/**
 * Lascia girare le microtask pendenti.
 *
 * Serve perché `richiediSblocco` comincia con `await Promise.resolve()`: un
 * `waitFor` su «è stata chiamata UNA volta» passerebbe SUBITO, prima che una
 * eventuale seconda chiamata parta — e il test direbbe che il loop non c'è
 * anche quando c'è. Verificato: senza questa attesa i test del loop restano
 * verdi perfino rimettendo il listener `resume` incondizionato.
 */
async function respira(volte = 4) {
  for (let i = 0; i < volte; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

function montaGate(autenticato = true) {
  return render(
    <BiometricGate autenticato={autenticato}>
      <div>contenuto app</div>
    </BiometricGate>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  listeners.clear()
  mockNativo.mockReturnValue(true)
  mockAttiva.mockReturnValue(true)
  mockPathname.mockReturnValue('/parent/home')
  mockStato.mockResolvedValue({ disponibile: true, codice: '' })
  mockVerifica.mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('BiometricGate — il loop del prompt (bloccante Android)', () => {
  it('un resume subito dopo lo sblocco riuscito NON ri-mostra l’overlay', async () => {
    // È il difetto esatto: l'AuthActivity del plugin è traslucida, quindi
    // chiudendosi fa emettere `resume` alla MainActivity. Prima quel resume
    // richiamava lo sblocco e riapriva il prompt, all'infinito.
    montaGate()
    await waitFor(() => expect(mockVerifica).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(overlay()).toBeNull())

    act(() => listeners.get('resume')?.())
    await respira()
    expect(mockVerifica).toHaveBeenCalledTimes(1)
    expect(overlay()).toBeNull()
  })

  it('anche dopo un ANNULLAMENTO il resume non riapre un secondo prompt', async () => {
    mockVerifica.mockResolvedValue({ ok: false, codice: 'userCancel' })
    montaGate()
    await waitFor(() => expect(mockVerifica).toHaveBeenCalledTimes(1))
    expect(overlay()).not.toBeNull()

    act(() => listeners.get('resume')?.())
    await respira()
    expect(mockVerifica).toHaveBeenCalledTimes(1)
    // L'utente resta bloccato, ma con «Esci» raggiungibile e MAI disabilitato:
    // è l'unica via d'uscita quando la biometria non passa.
    const esci = screen.getByRole('button', { name: /esci/i })
    expect(esci).not.toBeDisabled()
  })

  it('un pause emesso MENTRE la verifica è in volo non conta come uscita', async () => {
    // È la firma esatta dell'AuthActivity: pause all'apertura del prompt,
    // resume alla sua chiusura. Nessuno dei due è un'uscita dall'app.
    let risolvi: (v: { ok: boolean }) => void = () => {}
    mockVerifica.mockReturnValue(new Promise((r) => { risolvi = r }))
    montaGate()
    await waitFor(() => expect(mockVerifica).toHaveBeenCalledTimes(1))

    act(() => listeners.get('pause')?.())
    await act(async () => {
      risolvi({ ok: true })
    })
    await waitFor(() => expect(overlay()).toBeNull())

    act(() => listeners.get('resume')?.())
    await respira()
    expect(mockVerifica).toHaveBeenCalledTimes(1)
  })

  it('il re-lock LEGITTIMO continua a funzionare (uscita vera, poi rientro)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    montaGate()
    await vi.waitFor(() => expect(mockVerifica).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(overlay()).toBeNull())

    // Oltre la finestra di grazia: è un'uscita vera, non la chiusura del prompt.
    vi.advanceTimersByTime(5000)
    act(() => {
      listeners.get('pause')?.()
      listeners.get('resume')?.()
    })
    await vi.waitFor(() => expect(mockVerifica).toHaveBeenCalledTimes(2))
  })

  it('due richieste concorrenti producono UN solo prompt', async () => {
    let risolvi: (v: { ok: boolean }) => void = () => {}
    mockVerifica.mockReturnValue(new Promise((r) => { risolvi = r }))
    montaGate()
    await waitFor(() => expect(mockVerifica).toHaveBeenCalledTimes(1))

    act(() => {
      listeners.get('pause')?.()
      listeners.get('resume')?.()
      listeners.get('resume')?.()
    })
    await respira()
    expect(mockVerifica).toHaveBeenCalledTimes(1)
    await act(async () => {
      risolvi({ ok: true })
    })
  })
})

describe('BiometricGate — quando si arma (bloccante lockout sul login)', () => {
  it('senza sessione NON si arma: l’overlay non deve coprire il login', async () => {
    montaGate(false)
    await respira()
    expect(screen.getByText('contenuto app')).toBeInTheDocument()
    expect(mockVerifica).not.toHaveBeenCalled()
    expect(overlay()).toBeNull()
  })

  it('sulle rotte PUBBLICHE non si arma, nemmeno con la sessione', async () => {
    // Rete anti-lockout non aggirabile: qualunque cosa dicano le altre
    // condizioni, il gate non può coprire /auth/*.
    mockPathname.mockReturnValue('/auth/login')
    montaGate(true)
    await respira()
    expect(screen.getByText('contenuto app')).toBeInTheDocument()
    expect(mockVerifica).not.toHaveBeenCalled()
  })

  it('su web è un passthrough puro', async () => {
    mockNativo.mockReturnValue(false)
    montaGate()
    await respira()
    expect(screen.getByText('contenuto app')).toBeInTheDocument()
    expect(mockVerifica).not.toHaveBeenCalled()
  })

  it('a opt-in spento non si arma', async () => {
    mockAttiva.mockReturnValue(false)
    montaGate()
    await respira()
    expect(screen.getByText('contenuto app')).toBeInTheDocument()
    expect(mockVerifica).not.toHaveBeenCalled()
  })
})

describe('BiometricGate — biometria sparita dopo l’opt-in', () => {
  it('non disponibile in modo PERMANENTE → spegne l’opt-in e sblocca', async () => {
    // Dito ri-registrato, Face ID rimosso, codice del dispositivo tolto: nessuno
    // deve restare chiuso fuori dai dati del proprio figlio.
    mockStato.mockResolvedValue({ disponibile: false, codice: 'biometryNotEnrolled' })
    montaGate()
    await waitFor(() => expect(mockImposta).toHaveBeenCalledWith(false))
    await respira()
    expect(overlay()).toBeNull()
    expect(mockVerifica).not.toHaveBeenCalled()
  })

  it('blocco TEMPORANEO (lockout) → l’overlay resta e l’opt-in non si tocca', async () => {
    mockStato.mockResolvedValue({ disponibile: false, codice: 'biometryLockout' })
    mockVerifica.mockResolvedValue({ ok: false, codice: 'biometryLockout' })
    montaGate()
    await waitFor(() => expect(overlay()).not.toBeNull())
    expect(mockImposta).not.toHaveBeenCalled()
  })
})

describe('BiometricGate — accessibilità del contenuto coperto', () => {
  it('a gate sbloccato NON lascia l’attributo inert nel DOM', async () => {
    const { container } = montaGate()
    await waitFor(() => expect(overlay()).toBeNull())
    expect(container.querySelector('[inert]')).toBeNull()
  })

  it('a gate bloccato rende inerte il contenuto sottostante', async () => {
    mockVerifica.mockResolvedValue({ ok: false, codice: 'userCancel' })
    const { container } = montaGate()
    await waitFor(() => expect(overlay()).not.toBeNull())
    expect(container.querySelector('[inert]')).not.toBeNull()
  })
})
