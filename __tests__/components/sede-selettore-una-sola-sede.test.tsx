import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'

/**
 * WARNING del collaudo 2026-07-31 — il selettore di sede DESKTOP compariva anche
 * con una sola sede, e diceva «TUTTE LE SEDI · 25 alunni · 1 struttura».
 *
 * Tre cose sbagliate in una riga: un'etichetta plurale per un plesso solo, un
 * menu con due voci che fanno la stessa identica cosa («Tutte le sedi» e l'unica
 * sede), e una promessa di scelta dove scelta non c'è. La variante MOBILE si
 * nascondeva già (`if (compatto && sedi.length <= 1) return null`): la guardia
 * era solo sul ramo compatto. Qui si allinea il desktop e si toglie anche la
 * chiamata a `/api/admin/dashboard` che quel ramo faceva su OGNI pagina del
 * cockpit per calcolare un contatore che nessuno avrebbe letto.
 */

const h = vi.hoisted(() => ({
    sedi: [] as { id: string; nome: string }[],
    logClient: vi.fn(),
}))

vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: () => 'e' }))
vi.mock('@/lib/context/sede-context', () => ({
    useSediAttive: () => ({
        sedi: h.sedi,
        selezionate: [],
        effettive: h.sedi.map((s) => s.id),
        sedeCorrente: h.sedi.length === 1 ? h.sedi[0].id : null,
        reFetchKey: h.sedi.map((s) => s.id).join(','),
        epocaSede: 0,
        loading: false,
        toggle: vi.fn(),
        soloSede: vi.fn(),
        tutte: vi.fn(),
    }),
}))

const fetchMock = vi.fn()

beforeEach(() => {
    vi.clearAllMocks()
    h.sedi = [{ id: SEDE_A, nome: NOME_SEDE_A }, { id: SEDE_B, nome: NOME_SEDE_B }]
    fetchMock.mockImplementation(() =>
        Promise.resolve({ ok: true, status: 200, json: async () => ({ studenti: { iscritti: 25 } }) }),
    )
    vi.stubGlobal('fetch', fetchMock)
})

import { SedeSelector } from '@/components/ui/cockpit'

const chiamateDashboard = () =>
    fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/admin/dashboard'))

describe('SedeSelector — con una sola sede non c\'è niente da scegliere', () => {
    it('DESKTOP, una sola sede: non si monta affatto (niente «Tutte le sedi»)', async () => {
        h.sedi = [{ id: SEDE_A, nome: NOME_SEDE_A }]
        const { container } = render(<SedeSelector userId="u1" />)

        expect(container).toBeEmptyDOMElement()
        expect(screen.queryByRole('button')).not.toBeInTheDocument()
        // …e nemmeno interroga il server per un contatore che nessuno vedrà.
        await waitFor(() => expect(chiamateDashboard()).toHaveLength(0))
    })

    it('DESKTOP, due sedi: il selettore c\'è, e conta gli alunni', async () => {
        render(<SedeSelector userId="u1" />)

        expect(screen.getByRole('button')).toBeInTheDocument()
        await waitFor(() => expect(chiamateDashboard().length).toBeGreaterThan(0))
    })

    it('MOBILE, una sola sede: resta nascosto (comportamento invariato)', () => {
        h.sedi = [{ id: SEDE_A, nome: NOME_SEDE_A }]
        const { container } = render(<SedeSelector userId="u1" compatto />)
        expect(container).toBeEmptyDOMElement()
    })

    it('MOBILE, due sedi: si monta e non chiede il conteggio', async () => {
        const { container } = render(<SedeSelector userId="u1" compatto />)
        expect(container).not.toBeEmptyDOMElement()
        await waitFor(() => expect(chiamateDashboard()).toHaveLength(0))
    })

    it('nessuna sede ancora caricata: non si monta (evita il lampeggio di «Tutte le sedi»)', () => {
        h.sedi = []
        const { container } = render(<SedeSelector userId="u1" />)
        expect(container).toBeEmptyDOMElement()
    })
})
