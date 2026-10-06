import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

/**
 * IL TAB CON CUI SI APRE LA SCHEDA DEL PERSONALE (`?tab=`).
 *
 * «Rinnova» nel cruscotto delle scadenze è un collegamento a
 * `/admin/students/<id>?kind=staff&tab=documento`. Se la pagina ignorasse `tab`, il
 * collegamento atterrerebbe sull'Incarico — cioè sul tab dove ruolo, sede e classi si
 * decidono — e la segreteria che stava rinnovando un documento dovrebbe cercarlo da sola:
 * è il giro che il 06/10/2026 non portava da nessuna parte.
 *
 * ⚠️ `tab` ARRIVA DALL'URL, quindi da chiunque. Si accetta solo ciò che la scheda conosce
 * (lista bianca): un valore ignoto apre l'Incarico, come se `tab` non ci fosse, e non
 * passa mai alla scheda una stringa arbitraria.
 *
 * Il pannello è finto: qui si misura il CONTRATTO della pagina (che cosa gli passa), non
 * la scheda, che ha i suoi 141 test in `StaffDetailPanel-anagrafica.test.tsx`.
 */

const ID_STAFF = '00000000-0000-4000-8000-0000000000aa'

const h = vi.hoisted(() => ({ query: 'kind=staff', push: vi.fn() }))

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Error' }))
vi.mock('next/navigation', () => ({
    useParams: () => ({ id: ID_STAFF }),
    useSearchParams: () => new URLSearchParams(h.query),
    useRouter: () => ({ push: h.push, refresh: vi.fn() }),
    usePathname: () => `/admin/students/${ID_STAFF}`,
}))
vi.mock('@/components/features/admin/StaffDetailPanel', () => ({
    StaffDetailPanel: (p: { staffId: string; tabIniziale?: string }) => (
        <div data-testid="staff" data-staff={p.staffId} data-tab={p.tabIniziale ?? '(assente)'} />
    ),
}))

import AnagraficaDetailPage from '@/app/(dashboard)/admin/students/[id]/page'

const tabPassato = () => screen.getByTestId('staff').getAttribute('data-tab')

beforeEach(() => {
    h.query = 'kind=staff'
})

describe('pagina scheda anagrafica · `?tab=` per il personale', () => {
    it.each(['documento', 'anagrafica', 'incarico'])('`tab=%s` arriva alla scheda', (tab) => {
        h.query = `kind=staff&tab=${tab}`
        render(<AnagraficaDetailPage />)
        expect(tabPassato()).toBe(tab)
        expect(screen.getByTestId('staff').getAttribute('data-staff')).toBe(ID_STAFF)
    })

    it('senza `tab` la scheda non riceve niente: resta l’Incarico di sempre', () => {
        render(<AnagraficaDetailPage />)
        expect(tabPassato()).toBe('(assente)')
    })

    it.each(['', 'admin', 'DOCUMENTO', 'documento ', '<script>', '__proto__', 'constructor'])(
        'un `tab` che la scheda non conosce («%s») non le arriva mai',
        (tab) => {
            h.query = `kind=staff&tab=${encodeURIComponent(tab)}`
            render(<AnagraficaDetailPage />)
            expect(tabPassato()).toBe('(assente)')
        },
    )
})
