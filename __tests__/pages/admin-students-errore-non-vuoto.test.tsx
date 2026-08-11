import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import itAdmin from '../../messages/it/adminStudents.json'
import enAdmin from '../../messages/en/adminStudents.json'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

/**
 * F3 — /admin/students: la rete giù veniva presentata come «non ci sono alunni».
 *
 * `fetchStudents`/`fetchParents`/`fetchStaff` erano `try { … } finally {
 * setIsLoading(false) }` — senza `catch`. Un `TypeError: Failed to fetch` usciva
 * dall'effetto, nessuno stato d'errore veniva impostato, nessuno LOGGAVA (contro
 * AGENTS.md §6) e la pagina mostrava la card «Nessun alunno trovato — Prova a
 * modificare i filtri o la ricerca» con i contatori a zero. Un operatore ne
 * deduce che l'archivio è vuoto: dal 2026-07-31 in produzione ci sono 156
 * preiscrizioni di famiglie vere, e «l'archivio è vuoto» è la conclusione
 * peggiore che si possa indurre.
 *
 * Anche `if (Array.isArray(data))` non aveva ramo alternativo: un 500 che
 * risponde `{ error: … }` finiva esattamente come una lista vuota.
 *
 * La distinzione che questi test difendono è UNA: «non ho potuto caricare»
 * (riquadro d'errore + Riprova) ≠ «non c'è niente» (card vuota). Perciò c'è
 * anche il caso positivo — 200 con `[]` — che deve continuare a mostrare la card
 * vuota e NESSUN allarme: senza quello, «errore sempre» passerebbe il test.
 */

const h = vi.hoisted(() => ({ logClient: vi.fn(), push: vi.fn() }))

vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: () => 'TypeError' }))
vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: h.push, refresh: vi.fn() }),
    useSearchParams: () => new URLSearchParams(''),
    useParams: () => ({}),
    usePathname: () => '/admin/students',
}))
vi.mock('@/lib/context/sede-context', () => ({
    useSediAttive: () => ({
        sedi: [{ id: SEDE_A, nome: 'Kidville Alfa' }, { id: SEDE_B, nome: 'Kidville Beta' }],
        selezionate: [],
        effettive: [SEDE_A, SEDE_B],
        sedeCorrente: null,
        reFetchKey: `${SEDE_A},${SEDE_B}`,
        epocaSede: 0,
        loading: false,
        toggle: vi.fn(),
        soloSede: vi.fn(),
        tutte: vi.fn(),
    }),
}))
vi.mock('@/components/features/admin/SectionsView', () => ({ SectionsView: () => null }))

const ALUNNO = {
    id: 'aaaa1111-0000-4000-8000-000000000001',
    nome: 'Test', cognome: 'Alunno', classe_sezione: '2 ANNI', stato: 'iscritto',
}

type Esito = 'ok' | 'rete' | '500' | 'vuoto'

const fetchMock = vi.fn()
let esitoElenco: Esito

beforeEach(() => {
    vi.clearAllMocks()
    esitoElenco = 'ok'
    fetchMock.mockImplementation((url: string) => {
        const u = String(url)
        if (u.includes('/api/admin/sections')) return Promise.resolve({ ok: true, status: 200, json: async () => [] })
        if (u.includes('/api/admin/gruppi-mensa')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: [] }) })
        }
        // La linguetta «Codici fiscali» ha la sua sorgente, e la pagina la
        // interroga al montaggio perché il CONTEGGIO va sulla pillola della tab.
        // È una richiesta a sé: senza questo ramo il corpo generico degli elenchi
        // le arriverebbe come «forma inattesa», cioè come un guasto — e il
        // controllo positivo qui sotto («nessun allarme») diventerebbe rosso per
        // un'altra tab.
        if (u.includes('/api/admin/anagrafiche/codici-fiscali')) {
            return Promise.resolve({
                ok: true, status: 200,
                json: async () => ({ righe: [], totale: 0, scansionati: 0, troncato: false }),
            })
        }
        // Gli elenchi: alunni, genitori, staff.
        const staff = u.includes('/api/admin/staff')
        if (esitoElenco === 'rete') return Promise.reject(new TypeError('Failed to fetch'))
        if (esitoElenco === '500') {
            return Promise.resolve({
                ok: false, status: 500,
                json: async () => ({ error: 'Elenco non disponibile: riprova fra poco.' }),
            })
        }
        if (esitoElenco === 'vuoto') {
            return Promise.resolve({ ok: true, status: 200, json: async () => (staff ? { success: true, data: [] } : []) })
        }
        return Promise.resolve({
            ok: true, status: 200,
            json: async () => (staff ? { success: true, data: [], schools: [], assegnazioni: [] } : [ALUNNO]),
        })
    })
    vi.stubGlobal('fetch', fetchMock)
})

import AdminStudentsPage from '@/app/(dashboard)/admin/students/page'

const riquadroErrore = () => screen.queryByRole('alert')
const cardVuota = () => screen.queryByText(itAdmin.vuotoAlunni)

describe('Anagrafica — «non ho potuto caricare» non si spaccia per «non c\'è nessuno»', () => {
    it('rete giù: riquadro d\'errore con Riprova, e NESSUNA card «Nessun alunno trovato»', async () => {
        esitoElenco = 'rete'
        render(<AdminStudentsPage />)

        await waitFor(() => expect(riquadroErrore()).toBeInTheDocument())
        expect(riquadroErrore()).toHaveTextContent(itAdmin.listErrTitolo)
        expect(cardVuota()).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: new RegExp(itAdmin.listErrRiprova, 'i') })).toBeInTheDocument()
        // Un catch che non logga è un bug (AGENTS.md §6): prima non c'era il catch.
        expect(h.logClient).toHaveBeenCalledWith(
            expect.objectContaining({ livello: 'error', evento: 'fetch' }),
        )
    })

    it('500 con corpo `{error}`: si legge il motivo del SERVER, non «nessun alunno»', async () => {
        esitoElenco = '500'
        render(<AdminStudentsPage />)

        await waitFor(() => expect(riquadroErrore()).toBeInTheDocument())
        expect(riquadroErrore()).toHaveTextContent('Elenco non disponibile: riprova fra poco.')
        expect(cardVuota()).not.toBeInTheDocument()
        expect(h.logClient).toHaveBeenCalledWith(
            expect.objectContaining({ livello: 'error', evento: 'fetch', stato: 500 }),
        )
    })

    it('CONTROLLO POSITIVO — 200 con lista vuota: card vuota, e nessun allarme', async () => {
        esitoElenco = 'vuoto'
        render(<AdminStudentsPage />)

        await waitFor(() => expect(cardVuota()).toBeInTheDocument())
        expect(riquadroErrore()).not.toBeInTheDocument()
        expect(h.logClient).not.toHaveBeenCalled()
    })

    it('CONTROLLO POSITIVO — elenco pieno: nessun allarme e nessuna card vuota', async () => {
        render(<AdminStudentsPage />)

        await waitFor(() => expect(screen.getAllByText(/Alunno/).length).toBeGreaterThan(0))
        expect(riquadroErrore()).not.toBeInTheDocument()
        expect(cardVuota()).not.toBeInTheDocument()
    })

    it('«Riprova» richiama davvero il server, e l\'elenco compare', async () => {
        esitoElenco = 'rete'
        render(<AdminStudentsPage />)
        await waitFor(() => expect(riquadroErrore()).toBeInTheDocument())

        esitoElenco = 'ok'
        fireEvent.click(screen.getByRole('button', { name: new RegExp(itAdmin.listErrRiprova, 'i') }))

        await waitFor(() => expect(screen.getAllByText(/Alunno/).length).toBeGreaterThan(0))
        expect(riquadroErrore()).not.toBeInTheDocument()
    })

    it('tab Genitori: stesso guasto, stessa distinzione', async () => {
        esitoElenco = 'rete'
        render(<AdminStudentsPage />)
        await waitFor(() => expect(riquadroErrore()).toBeInTheDocument())

        fireEvent.click(screen.getByRole('button', { name: new RegExp(itAdmin.tabGenitori, 'i') }))
        await waitFor(() => expect(riquadroErrore()).toBeInTheDocument())
        expect(cardVuota()).not.toBeInTheDocument()
    })

    it('tab Staff: un errore non è più un toast che sparisce dopo 3 secondi', async () => {
        esitoElenco = '500'
        render(<AdminStudentsPage />)
        await waitFor(() => expect(riquadroErrore()).toBeInTheDocument())

        fireEvent.click(screen.getByRole('button', { name: new RegExp(itAdmin.tabStaff, 'i') }))
        await waitFor(() =>
            expect(riquadroErrore()).toHaveTextContent('Elenco non disponibile: riprova fra poco.'),
        )
        expect(screen.queryByText(itAdmin.vuotoStaff)).not.toBeInTheDocument()
    })
})

describe('Anagrafica — i18n', () => {
    it('le chiavi nuove esistono in ENTRAMBI i cataloghi', () => {
        for (const k of ['listErrTitolo', 'listErrCaricamento', 'listErrRiprova']) {
            expect(itAdmin, `manca in it/adminStudents.json: ${k}`).toHaveProperty(k)
            expect(enAdmin, `manca in en/adminStudents.json: ${k}`).toHaveProperty(k)
        }
    })
})
