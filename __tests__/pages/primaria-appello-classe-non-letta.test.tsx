import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'

import itPrimaria from '../../messages/it/teacherPrimaria.json'

/**
 * PR 4.1 · giro finale (M5) · la lettura della classe dell'appello (lista alunni + sede della sezione)
 * non cade più in silenzio: un rifiuto di rete o una risposta non ok lasciano UNA riga di log col codice
 * e l'uuid della sezione, e la pagina resta in piedi.
 */

const stub = vi.hoisted(() => ({
    params: { sectionId: 'sez-1' } as Record<string, string>,
    search: new URLSearchParams(),
}))

vi.mock('next/navigation', () => ({
    useParams: () => stub.params,
    useSearchParams: () => stub.search,
    usePathname: () => '/teacher/primaria/sez-1/appello',
    useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}))
vi.mock('@/lib/auth/current-teacher', () => ({ getCurrentTeacherId: () => 'd-1' }))
vi.mock('@/lib/logging/client', async (originale) => ({
    ...(await originale<typeof import('@/lib/logging/client')>()),
    logClient: vi.fn(),
}))

import { logClient } from '@/lib/logging/client'
import AppelloPage from '@/app/(dashboard)/teacher/primaria/[sectionId]/appello/page'

const fetchMock = vi.fn()
const righeClasse = () =>
    vi.mocked(logClient).mock.calls.filter((c) => String(c[0].messaggio).startsWith('appello-primaria-classe-non-letta'))

beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => cleanup())

describe('appello primaria · lettura della classe', () => {
    it('la fetch che rifiuta → una riga di log, la pagina non si rompe', async () => {
        fetchMock.mockImplementation(async (url: RequestInfo | URL) => {
            if (String(url).startsWith('/api/primaria/classe/')) throw new TypeError('rete')
            return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) }
        })
        render(<AppelloPage />)
        await waitFor(() => expect(righeClasse()).toHaveLength(1))
        expect(righeClasse()[0][0]).toMatchObject({ livello: 'error', evento: 'fetch', campi: { section_id: 'sez-1' } })
        expect(screen.getByLabelText(itPrimaria.appelloDataAria)).toBeInTheDocument()
    })

    it('una risposta non ok (500) → una riga col codice, senza leggere il corpo', async () => {
        fetchMock.mockImplementation(async (url: RequestInfo | URL) => {
            if (String(url).startsWith('/api/primaria/classe/')) {
                return { ok: false, status: 500, json: async () => { throw new Error('non si legge') } }
            }
            return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) }
        })
        render(<AppelloPage />)
        await waitFor(() => expect(righeClasse()).toHaveLength(1))
        expect(righeClasse()[0][0]).toMatchObject({ livello: 'error', stato: 500, campi: { section_id: 'sez-1' } })
        expect(screen.getByLabelText(itPrimaria.appelloDataAria)).toBeInTheDocument()
    })

    it('la risposta buona non scrive niente', async () => {
        fetchMock.mockImplementation(async (url: RequestInfo | URL) => {
            const u = String(url)
            const data = u.startsWith('/api/primaria/classe/') ? { alunni: [], section: { scuola_id: 'sede-1' } } : []
            return { ok: true, status: 200, json: async () => ({ success: true, data }) }
        })
        render(<AppelloPage />)
        await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).startsWith('/api/primaria/classe/'))).toBe(true))
        expect(righeClasse()).toHaveLength(0)
    })
})
