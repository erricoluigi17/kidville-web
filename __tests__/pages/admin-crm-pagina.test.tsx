import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'
import AdminCrmPage from '@/app/(dashboard)/admin/crm/page'

/**
 * CRM della segreteria · Compito 1.6 — la pagina `/admin/crm`.
 *
 * La sede è UNA e si dichiara (AGENTS.md, Note): la pagina sta dentro `SedeRequired`. Con più sedi
 * attive e nessuna scelta non deve partire niente — né una schermata né una richiesta — e la
 * segreteria con la sua sede sola deve vedere la cornice subito.
 */

const h = vi.hoisted(() => ({
  stato: {
    sedi: [] as { id: string; nome: string }[],
    sedeCorrente: null as string | null,
    loading: false,
  },
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('tab=schede'),
  usePathname: () => '/admin/crm',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))

// Riproduzione fedele del guard vero (sede-context.tsx): senza UNA sede risolta non rende i figli.
vi.mock('@/lib/context/sede-context', () => ({
  useSediAttive: () => ({ sedi: h.stato.sedi, sedeCorrente: h.stato.sedeCorrente, loading: h.stato.loading }),
  SedeRequired: ({ cosa, children }: { cosa?: string; children: (id: string) => React.ReactNode }) =>
    h.stato.loading ? (
      <div>attendi</div>
    ) : h.stato.sedeCorrente ? (
      <>{children(h.stato.sedeCorrente)}</>
    ) : (
      <div data-testid="sede-notice">{cosa}</div>
    ),
}))

beforeEach(() => {
  h.stato.sedi = [
    { id: SEDE_A, nome: NOME_SEDE_A },
    { id: SEDE_B, nome: NOME_SEDE_B },
  ]
  h.stato.sedeCorrente = null
  h.stato.loading = false
})

describe('/admin/crm', () => {
  it('con più sedi attive e nessuna scelta mostra l’invito e non monta nessuna scheda', () => {
    render(<AdminCrmPage />)

    expect(screen.getByTestId('sede-notice').textContent).toBe('il CRM')
    expect(document.querySelector('[data-crm-segnaposto]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Schede' })).toBeNull()
  })

  it('con una sede risolta monta la cornice e le passa QUELLA sede', () => {
    h.stato.sedeCorrente = SEDE_B
    render(<AdminCrmPage />)

    expect(screen.getByRole('heading', { name: 'CRM' })).toBeTruthy()
    const elenco = document.querySelector('[data-crm-segnaposto="ElencoSchede"]')
    expect(elenco?.getAttribute('data-scuola-id')).toBe(SEDE_B)
  })

  it('mentre le sedi si caricano non monta niente', () => {
    h.stato.loading = true
    render(<AdminCrmPage />)
    expect(document.querySelector('[data-crm-segnaposto]')).toBeNull()
  })
})
