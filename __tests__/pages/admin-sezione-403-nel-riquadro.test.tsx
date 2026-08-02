import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

import itAdminRaw from '../../messages/it/adminStudents.json'
import enAdminRaw from '../../messages/en/adminStudents.json'
import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi'

/**
 * S27 — IL 403 DI UN WIDGET RESTA NEL WIDGET.
 *
 * Misurato il 2026-07-31 (collaudo frontend F1) con l'account di segreteria:
 * `GET /api/admin/sections/<id>/teachers` rispondeva 403 e il dettaglio della
 * sezione mostrava in CIMA una fascia rossa «Accesso negato: operazione
 * riservata allo staff» — a un utente che lo staff lo È.
 *
 * Due difetti in uno, e il secondo è quello strutturale:
 *  1. il messaggio diceva il falso (la funzione era della Direzione) → chiuso in
 *     `src/lib/auth/require-staff.ts` e in `admin/sections/[id]/teachers`;
 *  2. il rifiuto di UN riquadro veniva raccontato come errore dell'INTERA
 *     pagina. È questo che va tenuto chiuso per sempre: domani un altro riquadro
 *     risponderà 403 (basta una sezione di un altro plesso) e la pagina non deve
 *     travestirsi da schermata negata.
 *
 * REGOLA CHE QUESTO FILE PROTEGGE: ogni riquadro racconta il PROPRIO esito,
 * dentro di sé. Perciò le asserzioni non sono «c'è un messaggio», ma «il
 * messaggio è DENTRO quel riquadro» e «gli altri riquadri sono ancora al loro
 * posto» — un errore che sposta il messaggio in cima alla pagina torna rosso.
 */

const SEZ = 'sez-a-2anni'
const DOCENTE = 'dddddddd-0000-4000-8000-00000000000d'

const itAdmin = itAdminRaw as Record<string, string>
const enAdmin = enAdminRaw as Record<string, string>

const h = vi.hoisted(() => ({ logClient: vi.fn() }))

vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: () => 'TypeError' }))
vi.mock('next/navigation', () => ({ useParams: () => ({ id: SEZ }) }))

const SCOPED = {
    success: true,
    data: [
        {
            scuolaId: SEDE_A,
            scuolaNome: NOME_SEDE_A,
            sezioni: [{ id: SEZ, name: '2 ANNI', school_type: 'infanzia' }],
        },
    ],
}

const DOCENTI = {
    success: true,
    assigned: [{ id: DOCENTE, nome: 'Anna', cognome: 'Bianchi' }],
    available: [{ id: DOCENTE, nome: 'Anna', cognome: 'Bianchi' }],
}

const ALUNNI = [
    { id: 'al-1', nome: 'Ada', cognome: 'Rossi', scuola_id: SEDE_A, section_id: SEZ, classe_sezione: '2 ANNI' },
]

type Risposta = { ok: boolean; status: number; body: unknown }

const fetchMock = vi.fn()

/** L'esito del GET degli insegnanti, deciso da ogni test. */
let esitoTeachers: Risposta
/** L'esito dell'elenco alunni. */
let esitoAlunni: Risposta
/** L'esito della PATCH del grado. */
let esitoPatch: Risposta

beforeEach(() => {
    vi.clearAllMocks()
    esitoTeachers = { ok: true, status: 200, body: DOCENTI }
    esitoAlunni = { ok: true, status: 200, body: ALUNNI }
    esitoPatch = { ok: true, status: 200, body: { success: true } }
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
        const u = String(url)
        if ((init?.method ?? 'GET') !== 'GET') {
            return Promise.resolve({ ok: esitoPatch.ok, status: esitoPatch.status, json: async () => esitoPatch.body })
        }
        if (u.includes('/teachers')) {
            return Promise.resolve({ ok: esitoTeachers.ok, status: esitoTeachers.status, json: async () => esitoTeachers.body })
        }
        if (u.includes('/api/admin/sections/scoped')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => SCOPED })
        }
        return Promise.resolve({ ok: esitoAlunni.ok, status: esitoAlunni.status, json: async () => esitoAlunni.body })
    })
    vi.stubGlobal('fetch', fetchMock)
})

import SezioneDetailPage from '@/app/(dashboard)/admin/students/sezioni/[id]/page'

/** Il riquadro (regione con nome accessibile) di cui si vuole guardare il contenuto. */
const riquadro = (nome: RegExp) => screen.getByRole('region', { name: nome })

const RX_INSEGNANTI = /Insegnanti di riferimento/i
const RX_IMPOSTAZIONI = /Impostazioni Sezione/i
const RX_ALUNNI = /Alunni in questa sezione/i

/** La tendina del grado: è l'unica che offre «nido». */
const tendinaTipo = () =>
    Array.from(document.querySelectorAll('select')).find((s) =>
        Array.from(s.options).some((o) => o.value === 'nido'),
    ) as HTMLSelectElement

async function apri() {
    render(<SezioneDetailPage />)
    await waitFor(() => expect(tendinaTipo()).toBeTruthy())
}

describe('Dettaglio sezione — un 403 sugli insegnanti non è un 403 della pagina', () => {
    it('403: nessuna fascia rossa in cima, e il riquadro dice che mancano i permessi', async () => {
        esitoTeachers = { ok: false, status: 403, body: { error: 'Accesso negato: operazione riservata alla Direzione' } }
        await apri()

        // Lo stato «permessi» sta DENTRO il suo riquadro…
        await waitFor(() =>
            expect(within(riquadro(RX_INSEGNANTI)).getByText(itAdmin.sezInsegnantiNegato)).toBeInTheDocument(),
        )
        // …e non c'è NESSUN allarme sulla pagina: il 403 di un riquadro non è un
        // guasto, è una risposta. Questa è l'asserzione che il difetto rompeva.
        expect(screen.queryAllByRole('alert')).toHaveLength(0)

        // I CONTROLLI POSITIVI: gli altri due riquadri sono al loro posto. Senza,
        // «nessun allarme» sarebbe vero anche su una pagina bianca.
        expect(riquadro(RX_IMPOSTAZIONI)).toBeInTheDocument()
        expect(tendinaTipo().value).toBe('infanzia')
        expect(within(riquadro(RX_ALUNNI)).getByText('Rossi Ada')).toBeInTheDocument()
    })

    it('403: i comandi del riquadro spariscono (niente tendina disabilitata accanto al diniego)', async () => {
        esitoTeachers = { ok: false, status: 403, body: { error: 'Accesso negato: operazione riservata alla Direzione' } }
        await apri()

        const card = await waitFor(() => riquadro(RX_INSEGNANTI))
        await waitFor(() => expect(within(card).queryByText(itAdmin.sezInsegnantiNegato)).toBeInTheDocument())
        expect(within(card).queryByRole('combobox')).not.toBeInTheDocument()
        expect(within(card).queryByRole('button', { name: new RegExp(itAdmin.sezAggiungi, 'i') })).not.toBeInTheDocument()
        // …e nemmeno l'affermazione sui dati fatta senza avere i dati.
        expect(within(card).queryByText(itAdmin.sezNessunInsegnante)).not.toBeInTheDocument()
    })

    it('403: non produce una riga `error` nel client — è una risposta, non un guasto', async () => {
        esitoTeachers = { ok: false, status: 403, body: { error: 'Accesso negato' } }
        await apri()
        await waitFor(() =>
            expect(within(riquadro(RX_INSEGNANTI)).getByText(itAdmin.sezInsegnantiNegato)).toBeInTheDocument(),
        )

        expect(h.logClient).not.toHaveBeenCalled()
    })

    it('CONTROLLO POSITIVO — 200: nessun testo di diniego, e la tendina degli insegnanti c\'è', async () => {
        await apri()

        const card = riquadro(RX_INSEGNANTI)
        await waitFor(() => expect(within(card).getByRole('combobox')).toBeInTheDocument())
        expect(within(card).queryByText(itAdmin.sezInsegnantiNegato)).not.toBeInTheDocument()
        expect(screen.queryAllByRole('alert')).toHaveLength(0)
    })
})

describe('Dettaglio sezione — anche i GUASTI restano nel loro riquadro', () => {
    it('500 sugli insegnanti: l\'allarme è dentro il riquadro insegnanti, non in cima alla pagina', async () => {
        esitoTeachers = { ok: false, status: 500, body: { error: 'Errore nel caricamento del personale' } }
        await apri()

        const avviso = await screen.findByRole('alert')
        expect(avviso).toHaveTextContent('Errore nel caricamento del personale')
        // È DENTRO il riquadro: è questo che il difetto sbagliava.
        expect(riquadro(RX_INSEGNANTI).contains(avviso)).toBe(true)
        // Gli altri riquadri non ne sanno niente.
        expect(within(riquadro(RX_IMPOSTAZIONI)).queryByRole('alert')).not.toBeInTheDocument()
        expect(within(riquadro(RX_ALUNNI)).getByText('Rossi Ada')).toBeInTheDocument()
        // Un 500 sì che è un guasto, e va spedito.
        expect(h.logClient).toHaveBeenCalledWith(
            expect.objectContaining({ livello: 'error', evento: 'fetch', stato: 500 }),
        )
    })

    it('elenco alunni non arrivato: l\'allarme è dentro il riquadro alunni', async () => {
        esitoAlunni = { ok: false, status: 500, body: { error: 'boom' } }
        await apri()

        const avviso = await screen.findByRole('alert')
        expect(riquadro(RX_ALUNNI).contains(avviso)).toBe(true)
        // Il riquadro insegnanti è intatto: la sua tendina c'è.
        expect(within(riquadro(RX_INSEGNANTI)).getByRole('combobox')).toBeInTheDocument()
    })

    it('grado respinto: l\'allarme è dentro «Impostazioni Sezione»', async () => {
        esitoPatch = { ok: false, status: 400, body: { error: 'Specificare la sede su cui operare.' } }
        await apri()

        fireEvent.change(tendinaTipo(), { target: { value: 'primaria' } })

        const avviso = await screen.findByRole('alert')
        expect(avviso).toHaveTextContent('Specificare la sede su cui operare.')
        expect(riquadro(RX_IMPOSTAZIONI).contains(avviso)).toBe(true)
        expect(within(riquadro(RX_INSEGNANTI)).queryByRole('alert')).not.toBeInTheDocument()
    })
})

describe('Dettaglio sezione — i18n delle chiavi nuove', () => {
    it('le chiavi nuove esistono in ENTRAMBI i cataloghi', () => {
        for (const k of ['sezInsegnantiNegato', 'sezInsegnantiErrore', 'sezAlunniErrore']) {
            expect(itAdmin, `manca in it/adminStudents.json: ${k}`).toHaveProperty(k)
            expect(enAdmin, `manca in en/adminStudents.json: ${k}`).toHaveProperty(k)
        }
    })
})
