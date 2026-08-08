import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'

import itPrimaria from '../../messages/it/parentPrimaria.json'

/**
 * La pagina «Presenze» del genitore di PRIMARIA monta davvero la card che
 * comunica un'assenza.
 *
 * ─── PERCHÉ ESISTE QUESTO TEST, E NON SOLO QUELLO DEL COMPONENTE ────────────
 * Perché il difetto di partenza NON era nel componente: era che il componente
 * non stava in nessuna pagina. `PrimariaParentView` — 462 righe, `AssenzeCard`
 * col pulsante «Comunica assenza in anticipo» compreso — è esportato e mai
 * importato: un test del solo componente sarebbe stato verde per mesi mentre
 * nessun genitore poteva vederlo. Qui si misura il montaggio, che è l'unica cosa
 * che il collaudo del prodotto avrebbe potuto vedere.
 *
 * Si misura anche l'ORDINE (la card sopra la cronologia): comunicare un'assenza
 * futura è l'azione, l'elenco delle assenze passate è la consultazione.
 */

const stub = vi.hoisted(() => ({
    pathname: '/parent/primaria/assenze',
    params: new URLSearchParams(),
    router: { push: () => {}, replace: () => {}, refresh: () => {} },
}))

vi.mock('next/navigation', () => ({
    usePathname: () => stub.pathname,
    useSearchParams: () => stub.params,
    useRouter: () => stub.router,
}))

const identita = vi.hoisted(() => ({
    parentId: 'p-1' as string | null,
    studentId: 's-1' as string | null,
    ready: true,
}))

vi.mock('@/lib/auth/use-parent-identity', () => ({
    useParentIdentity: () => ({
        parentId: identita.parentId,
        studentId: identita.studentId,
        figliIds: identita.studentId ? [identita.studentId] : [],
        ready: identita.ready,
    }),
}))

import AssenzeGenitorePage from '@/app/(dashboard)/parent/primaria/assenze/page'

const fetchMock = vi.fn()

/** La cronologia che la pagina già mostrava (route `parent/primaria/assenze`). */
const CRONOLOGIA = [
    {
        id: 'pr-vecchia',
        data: '2026-06-02',
        stato: 'assente',
        orario_entrata: null,
        orario_uscita: null,
        giustificata: true,
        giustificazione_testo: null,
        giustificata_il: '2026-06-03T08:00:00Z',
        note_appello: null,
    },
]

/** L'elenco delle assenze comunicate e ancora ritirabili (route `parent/presenze`). */
const COMUNICATE = [
    { id: 'pr-futura', data: '2026-08-12', giustificazione_testo: 'Visita medica', stato: 'assente' },
]

let chiamateCronologia: number
let esitoPost: { ok: boolean; status: number; body: unknown }

beforeEach(() => {
    vi.clearAllMocks()
    chiamateCronologia = 0
    esitoPost = { ok: true, status: 201, body: { success: true } }
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        const metodo = init?.method ?? 'GET'
        if (metodo === 'POST' && url.includes('/comunica-assenza')) {
            return Promise.resolve({ ok: esitoPost.ok, status: esitoPost.status, json: async () => esitoPost.body })
        }
        if (url.includes('/api/parent/primaria/assenze')) {
            chiamateCronologia++
            return Promise.resolve({
                ok: true,
                status: 200,
                json: async () => ({
                    success: true,
                    data: CRONOLOGIA,
                    riepilogo: { presente: 120, assente: 3, ritardo: 1, uscita_anticipata: 0 },
                }),
            })
        }
        if (url.includes('/api/parent/presenze')) {
            return Promise.resolve({
                ok: true,
                status: 200,
                json: async () => ({
                    success: true,
                    data: {
                        schoolType: 'primaria',
                        oggi: { stato: null, orario_entrata: null, orario_uscita: null },
                        riepilogo: {},
                        comunicate: COMUNICATE,
                    },
                }),
            })
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) })
    })
    vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => cleanup())

describe('parent/primaria/assenze — la card «comunica un\'assenza» è montata', () => {
    it('la card compare, sopra la cronologia delle assenze', async () => {
        render(<AssenzeGenitorePage />)

        const titoloCard = await screen.findByText(itPrimaria.comunicaTitolo)
        const titoloElenco = await screen.findByText(itPrimaria.assenzeSezioneTitolo)
        expect(screen.getByRole('button', { name: itPrimaria.comunicaApri })).toBeInTheDocument()

        // DOCUMENT_POSITION_FOLLOWING = 4: l'elenco viene DOPO la card.
        expect(titoloCard.compareDocumentPosition(titoloElenco) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it('mostra le assenze già comunicate e la consultazione storica insieme', async () => {
        render(<AssenzeGenitorePage />)
        // Dalla card (route `parent/presenze`).
        expect(await screen.findByText('Visita medica')).toBeInTheDocument()
        // Dalla pagina (route `parent/primaria/assenze`): il riepilogo storico.
        expect(await screen.findByText('120')).toBeInTheDocument()
    })

    it("dopo un invio riuscito la pagina RICARICA la propria cronologia", async () => {
        render(<AssenzeGenitorePage />)
        await waitFor(() => expect(chiamateCronologia).toBe(1))

        fireEvent.click(screen.getByRole('button', { name: itPrimaria.comunicaApri }))
        fireEvent.click(screen.getByRole('button', { name: itPrimaria.comunicaInvia }))

        // L'assenza appena comunicata è una riga di `presenze`: se la cronologia
        // non si rilegge, il genitore la vede solo dopo un ricaricamento a mano.
        await waitFor(() => expect(chiamateCronologia).toBe(2))
    })

    it('invio respinto: la cronologia NON si ricarica (nessun gesto che sparisce in silenzio)', async () => {
        esitoPost = { ok: false, status: 400, body: { error: 'data passata', codice: 'ASSENZA_DATA_PASSATA' } }
        render(<AssenzeGenitorePage />)
        await waitFor(() => expect(chiamateCronologia).toBe(1))

        fireEvent.click(screen.getByRole('button', { name: itPrimaria.comunicaApri }))
        fireEvent.click(screen.getByRole('button', { name: itPrimaria.comunicaInvia }))

        await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
        expect(chiamateCronologia).toBe(1)
    })
})
