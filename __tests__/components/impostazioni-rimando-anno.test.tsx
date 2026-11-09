import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useSyncExternalStore } from 'react'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'

import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi'
import itAdminSettings from '../../messages/it/adminSettings.json'

/**
 * B2 della revisione PR 4.6 · il rimando «Vai ad Anno scolastico → Rette» di Impostazioni SI MUOVE.
 * Un rimando cambia solo la query dell'indirizzo e Next non rimonta la pagina quando cambia la sola query: la sezione deve
 * seguire l'indirizzo anche dopo il montaggio. Si prova sul clic: si preme il rimando, l'indirizzo cambia come fa Next, la
 * pagina (la stessa istanza) passa alla sezione dell'anno.
 */

const nav = vi.hoisted(() => ({ replace: vi.fn(), search: '', ascolti: new Set<() => void>() }))

vi.mock('next/navigation', () => ({
  // come il router di Next: chi legge l'indirizzo viene ridisegnato quando cambia, senza essere rimontato
  useSearchParams: () => {
    const q = useSyncExternalStore(
      (f) => {
        nav.ascolti.add(f)
        return () => {
          nav.ascolti.delete(f)
        }
      },
      () => nav.search,
      () => nav.search,
    )
    return new URLSearchParams(q)
  },
  useRouter: () => ({ replace: nav.replace, push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/impostazioni',
}))
// Il Link vero cambia l'indirizzo senza rimontare la pagina: qui lo stesso gesto, sulla query finta.
vi.mock('next/link', () => ({
  default: ({ href, children, ...resto }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a
      href={href}
      {...resto}
      onClick={(e) => {
        e.preventDefault()
        nav.search = href.replace(/^\?/, '')
        nav.ascolti.forEach((f) => f())
      }}
    >
      {children}
    </a>
  ),
}))
vi.mock('@/lib/auth/use-session-identity', () => ({
  useSessionIdentity: () => ({ userId: 'u1', role: 'admin', ready: true }),
}))
vi.mock('@/lib/context/admin-identity', () => ({
  useAdminIdentity: () => ({ userId: 'u1', ruolo: 'admin', withUser: (h: string) => h }),
  AdminIdentityProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

import { SedeProvider } from '@/lib/context/sede-context'
import AdminImpostazioniPage from '@/app/(dashboard)/admin/impostazioni/page'

const fetchMock = vi.fn(async (url: string) => {
  const u = String(url)
  if (u.startsWith('/api/admin/sedi')) return { ok: true, status: 200, json: async () => [{ id: SEDE_A, nome: NOME_SEDE_A }] }
  if (u.includes('categor')) return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) }
  if (u.split('?')[0] === '/api/admin/settings') return { ok: true, status: 200, json: async () => ({ success: true, data: { scuola_id: SEDE_A, retta_giorno_scadenza: 5 } }) }
  return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) }
})

beforeEach(() => {
  vi.clearAllMocks()
  nav.search = 'userId=u1&sezione=pagamenti'
  document.cookie = `sedi_attive=${SEDE_A}; path=/`
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  document.cookie = 'sedi_attive=; path=/'
})

describe('Impostazioni · il rimando verso Anno scolastico', () => {
  it("premuto il rimando, la pagina passa alla sezione dell'anno senza essere rimontata", async () => {
    render(
      <SedeProvider>
        <AdminImpostazioniPage />
      </SedeProvider>,
    )
    const rimando = await screen.findByRole('link', { name: itAdminSettings.spRettaDefaultLink })
    expect(rimando).toHaveAttribute('href', '?userId=u1&sezione=anno')
    expect(screen.queryByText(itAdminSettings.annoIntro)).toBeNull()
    fireEvent.click(rimando)
    await waitFor(() => expect(screen.queryByRole('link', { name: itAdminSettings.spRettaDefaultLink })).toBeNull())
    // la sezione attiva è quella dell'anno: il suo titolo è un'intestazione, e non c'è più il pannello di morosità
    expect((await screen.findAllByRole('heading', { name: itAdminSettings.annoTitolo })).length).toBeGreaterThan(0)
    expect(screen.queryByRole('heading', { name: new RegExp(itAdminSettings.spRettaMorosita) })).toBeNull()
  })

  it('Indietro verso un indirizzo SENZA sezione riporta alla sezione di partenza', async () => {
    nav.search = 'userId=u1&sezione=anno'
    render(
      <SedeProvider>
        <AdminImpostazioniPage />
      </SedeProvider>,
    )
    expect((await screen.findAllByRole('heading', { name: itAdminSettings.annoTitolo })).length).toBeGreaterThan(0)
    // come il tasto Indietro: l'indirizzo perde `sezione`
    nav.search = 'userId=u1'
    act(() => { nav.ascolti.forEach((f) => f()) })
    expect(await screen.findByRole('link', { name: itAdminSettings.spRettaDefaultLink })).toBeInTheDocument()
  })
})
