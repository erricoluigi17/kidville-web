import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * /admin/students/[id]?kind=adult — IL MESSAGGIO SUL CODICE DUPLICATO, DALLA
 * PAGINA VERA E NON DA UN CONTENITORE FINTO.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ PERCHÉ QUESTO FILE ESISTE. `ParentDetailPanel` sapeva già tradurre il
 * `23505` di Postgres in una frase leggibile, e i suoi test lo dimostravano — con
 * un `onSave` finto che restituiva `{ ok: false, errore }`. Ma il contenitore VERO
 * è uno solo (questa pagina, riga 136), e fino all'11 agosto la sua
 * `handleSaveParent` faceva `.catch(() => null)` e non restituiva NIENTE: `esito`
 * arrivava alla scheda come `undefined`, il ramo `esito.ok === false` non scattava
 * mai, e il messaggio esisteva soltanto dentro i test. Peggio: `flash()` faceva
 * `router.push` verso la lista dopo 900 ms — quindi il fallimento portava via
 * anche le correzioni appena digitate.
 *
 * Un test con un contenitore finto misura il componente; il pezzo che in
 * produzione mancava era proprio il contenitore. Qui si monta la ROUTA, con una
 * `fetch` che risponde 500 col messaggio vero di Postgres.
 *
 * IL NUMERO CHE RENDE IL CASO REALE, misurato in produzione l'11 agosto:
 * `parents.fiscal_code` è UNIQUE, e su 50 genitori **uno ha già la stringa vuota**
 * (26 hanno NULL). Il duplicato non è un caso di scuola: è a una riga di distanza.
 *
 * ⚠️ REPOSITORY PUBBLICO: nessuna persona, nessun codice fiscale con checksum
 * valida.
 */

const ID_GENITORE = '00000000-0000-4000-8000-000000000001'
const MESSAGGIO_POSTGRES =
    'duplicate key value violates unique constraint "parents_fiscal_code_key"'

const h = vi.hoisted(() => ({ push: vi.fn(), logClient: vi.fn() }))

vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: () => 'Error' }))
vi.mock('next/navigation', () => ({
    useParams: () => ({ id: ID_GENITORE }),
    useSearchParams: () => new URLSearchParams('kind=adult'),
    useRouter: () => ({ push: h.push, refresh: vi.fn() }),
    usePathname: () => `/admin/students/${ID_GENITORE}`,
}))

import AnagraficaDetailPage from '@/app/(dashboard)/admin/students/[id]/page'

/** Il genitore su cui si sta correggendo il codice: anagrafica minima e vera-per-finta. */
const GENITORE = {
    id: ID_GENITORE,
    first_name: 'Prova',
    last_name: 'Esempio',
    gender: 'F',
    birth_date: '1985-03-07',
    birth_city: '',
    birth_province: '',
    birth_nation: '',
    codice_belfiore_nascita: null,
    fiscal_code: '',
    emails: [],
    phone_numbers: [],
    residence_address: '',
    residence_city: '',
    zip_code: '',
}

/** `esitoPatch` decide come risponde `PATCH /api/admin/parents`. */
function fintaRete(esitoPatch: { stato: number; corpo: unknown }) {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/api/anagrafiche/comuni')) {
            return new Response(JSON.stringify({ comuni: [] }), { status: 200 })
        }
        if (url.includes(`/api/admin/parents/${ID_GENITORE}`)) {
            return new Response(JSON.stringify(GENITORE), { status: 200 })
        }
        if (url.includes('/api/admin/parents') && init?.method === 'PATCH') {
            return new Response(JSON.stringify(esitoPatch.corpo), { status: esitoPatch.stato })
        }
        return new Response('{"error":"non previsto"}', { status: 500 })
    })
}

const campoCf = () => screen.getByLabelText(/Codice Fiscale/)
const salva = () => screen.getByRole('button', { name: /Salva Modifiche/i })

async function montaPagina(esitoPatch: { stato: number; corpo: unknown }) {
    vi.stubGlobal('fetch', fintaRete(esitoPatch))
    render(<AnagraficaDetailPage />)
    await waitFor(() => expect(campoCf()).toBeInTheDocument())
}

beforeEach(() => {
    h.push.mockClear()
    h.logClient.mockClear()
    vi.unstubAllGlobals()
})

describe('la pagina vera inoltra il rifiuto del server alla scheda', () => {
    it('PATCH 500 col vincolo UNIQUE → frase leggibile in pagina, e NIENTE riga di Postgres', async () => {
        await montaPagina({ stato: 500, corpo: { error: MESSAGGIO_POSTGRES } })
        fireEvent.change(campoCf(), { target: { value: 'BBBBBB00B00B000B' } })

        fireEvent.click(salva())

        const avviso = await screen.findByRole('alert')
        expect(avviso).toHaveTextContent('Esiste già un genitore con questo codice fiscale')
        expect(avviso).not.toHaveTextContent('constraint')
        expect(avviso).not.toHaveTextContent('parents_fiscal_code_key')
    })

    it('sul fallimento NON si naviga via: le correzioni appena digitate restano', async () => {
        await montaPagina({ stato: 500, corpo: { error: MESSAGGIO_POSTGRES } })
        fireEvent.change(campoCf(), { target: { value: 'BBBBBB00B00B000B' } })

        fireEvent.click(salva())
        await screen.findByRole('alert')

        // ⚠️ Il pezzo che valeva più del messaggio: `flash()` faceva `push` verso la
        // lista dopo 900 ms, cioè smontava il modulo col lavoro dell'operatore
        // dentro. Su una scheda che serve a CORREGGERE un codice sbagliato.
        expect(campoCf()).toHaveValue('BBBBBB00B00B000B')
        expect(h.push).not.toHaveBeenCalled()
        expect(salva()).not.toBeDisabled()
    })

    it('un errore che NON è il duplicato non si traveste da duplicato', async () => {
        await montaPagina({ stato: 500, corpo: { error: 'null value in column "x" violates not-null constraint' } })

        fireEvent.click(salva())

        const avviso = await screen.findByRole('alert')
        expect(avviso).toHaveTextContent('Errore nel salvataggio')
        expect(avviso).not.toHaveTextContent('not-null')
    })

    it('un 500 senza corpo JSON resta un fallimento, non un’eccezione', async () => {
        // `res.json()` lancia: la pagina non deve far risalire niente, e la scheda
        // deve comunque dire che il salvataggio non è andato.
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input)
            if (url.includes('/api/anagrafiche/comuni')) return new Response(JSON.stringify({ comuni: [] }), { status: 200 })
            if (url.includes(`/api/admin/parents/${ID_GENITORE}`)) return new Response(JSON.stringify(GENITORE), { status: 200 })
            if (url.includes('/api/admin/parents') && init?.method === 'PATCH') {
                return new Response('<html>502 Bad Gateway</html>', { status: 502 })
            }
            return new Response('{"error":"non previsto"}', { status: 500 })
        }))
        render(<AnagraficaDetailPage />)
        await waitFor(() => expect(campoCf()).toBeInTheDocument())

        fireEvent.click(salva())

        expect(await screen.findByRole('alert')).toHaveTextContent('Errore nel salvataggio')
        expect(h.push).not.toHaveBeenCalled()
    })

    it('quando il salvataggio riesce, la pagina conferma e torna all’elenco', async () => {
        await montaPagina({ stato: 200, corpo: { success: true } })

        fireEvent.click(salva())

        // Nessun allarme, e il ritorno alla lista resta il comportamento di sempre.
        await waitFor(() => expect(screen.getByText(/Anagrafica aggiornata con successo/)).toBeInTheDocument())
        expect(screen.queryByRole('alert')).toBeNull()
        await waitFor(() => expect(h.push).toHaveBeenCalled(), { timeout: 2000 })
    })
})
