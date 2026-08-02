import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import itAdmin from '../../messages/it/adminComunicazioni.json'
import enAdmin from '../../messages/en/adminComunicazioni.json'
import itTeacher from '../../messages/it/teacherComunicazioni.json'
import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'

// =============================================================================
// W3-F — /admin/avvisi: la sede scelta arriva DAVVERO al server, e un rifiuto
// non passa più inosservato (R69 client, R78).
//
// Il difetto in produzione il 2026-07-31: la pagina appiattiva le sezioni delle
// tre sedi in `[...new Set(nomi)]` e faceva `POST /api/avvisi` senza `scuola_id`.
// La route archiviava nella sede PRIMARIA dell'autore (Giugliano) un avviso per
// una classe di Aversa: destinatari zero, feed del genitore vuoto, e nemmeno
// l'autore lo ritrovava. Risposta 201, e la pagina non guardava nemmeno quella.
//
// Da W2-B il server accetta `scuola_id` e senza di quello risponde **400**: se
// il client non lo manda, l'avviso non parte più — e se la pagina non guarda
// l'esito, l'operatore non lo scopre. I due difetti si tengono per mano.
//
// Si asserisce il CORPO della POST (con quale `scuola_id` e quali classi) e lo
// stato del modulo dopo un 400 — non «non è fallito».
// =============================================================================

const USER = 'aaaabbbb-1111-4111-8111-cccccccccccc'

const h = vi.hoisted(() => ({ logClient: vi.fn(), push: vi.fn() }))

vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: () => 'Error' }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: h.push }) }))
vi.mock('@/lib/auth/use-session-identity', () => ({
    useSessionIdentity: () => ({ userId: USER, role: 'admin', ready: true }),
}))

/** `/api/admin/sections/scoped` raggruppa GIÀ per sede: la pagina lo appiattiva. */
const SCOPED = {
    success: true,
    data: [
        {
            scuolaId: SEDE_A,
            scuolaNome: NOME_SEDE_A,
            sezioni: [
                { id: 'sez-a-2anni', name: '2 ANNI', school_type: 'nido' },
                { id: 'sez-a-3anni', name: '3 ANNI A', school_type: 'infanzia' },
            ],
        },
        {
            scuolaId: SEDE_B,
            scuolaNome: NOME_SEDE_B,
            // Omonima di quella della sede A: è la trappola del nome-classe.
            sezioni: [{ id: 'sez-b-2anni', name: '2 ANNI', school_type: 'nido' }],
        },
    ],
}

const fetchMock = vi.fn()

/** Risposta della POST: la decide ogni test. */
let rispostaPost: { ok: boolean; status: number; body: unknown } = { ok: true, status: 201, body: { id: 'x' } }

beforeEach(() => {
    vi.clearAllMocks()
    rispostaPost = { ok: true, status: 201, body: { id: 'x' } }
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
        const u = String(url)
        if (init?.method === 'POST') {
            return Promise.resolve({
                ok: rispostaPost.ok,
                status: rispostaPost.status,
                json: async () => rispostaPost.body,
            })
        }
        if (u.includes('/api/admin/sections/scoped')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => SCOPED })
        }
        // GET /api/avvisi → bacheca vuota
        return Promise.resolve({ ok: true, status: 200, json: async () => [] })
    })
    vi.stubGlobal('fetch', fetchMock)
})

import AdminAvvisiPage from '@/app/(dashboard)/admin/avvisi/page'

/** Corpo JSON dell'unica POST partita. */
function corpoPost(): Record<string, unknown> {
    const call = fetchMock.mock.calls.find((c) => (c[1] as { method?: string } | undefined)?.method === 'POST')
    expect(call, 'nessuna POST /api/avvisi è partita').toBeTruthy()
    return JSON.parse(String((call![1] as { body?: string }).body))
}

async function apriModuloECompila() {
    render(<AdminAvvisiPage />)
    await waitFor(() => expect(screen.getByText(itAdmin.avvisiVuotoTitolo)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: new RegExp(itAdmin.avvisiNuovoAvviso, 'i') }))
    fireEvent.change(await screen.findByPlaceholderText(itTeacher.formPlaceholderTitolo), { target: { value: 'Chiusura straordinaria' } })
    fireEvent.change(screen.getByPlaceholderText(itTeacher.formPlaceholderContenuto), { target: { value: 'Venerdì la sede resta chiusa.' } })
}

const pubblica = () => screen.getByRole('button', { name: new RegExp(itTeacher.formSubmitPubblicaAvviso, 'i') })

describe('/admin/avvisi — la sede arriva al server', () => {
    it('la POST porta la sede SCELTA e la classe di quella sede, non la sede dell\'autore', async () => {
        await apriModuloECompila()

        // Le due sedi arrivano dal raggruppamento del server: niente dedup.
        const sede = await screen.findByLabelText(itTeacher.formLabelSedePubblicazione)
        expect(Array.from(sede.querySelectorAll('option')).map((o) => (o as HTMLOptionElement).textContent))
            .toEqual([itTeacher.formSedeScegli, NOME_SEDE_A, NOME_SEDE_B])

        fireEvent.change(sede, { target: { value: SEDE_B } })
        fireEvent.click(screen.getByRole('button', { name: itTeacher.formDestinatariPerClasse }))
        // Della sede B esiste UNA sola classe: l'omonima «2 ANNI».
        expect(screen.getAllByRole('button', { name: '2 ANNI' })).toHaveLength(1)
        expect(screen.queryByRole('button', { name: '3 ANNI A' })).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: '2 ANNI' }))
        fireEvent.click(pubblica())

        await waitFor(() => expect(corpoPost()).toBeTruthy())
        const body = corpoPost()
        expect(body.scuola_id).toBe(SEDE_B)
        expect(body.target_scope).toBe('classe')
        expect(body.target_classes).toEqual(['2 ANNI'])
    })

    it('un 400 del server: il modulo resta aperto con il messaggio, e il rifiuto è LOGGATO', async () => {
        rispostaPost = {
            ok: false,
            status: 400,
            body: { error: 'Classi non presenti nella sede selezionata: 2 ANNI. Controlla la sede di pubblicazione.' },
        }
        await apriModuloECompila()
        fireEvent.change(await screen.findByLabelText(itTeacher.formLabelSedePubblicazione), { target: { value: SEDE_A } })
        fireEvent.click(pubblica())

        await waitFor(() => expect(screen.getByText(/Classi non presenti nella sede selezionata/)).toBeInTheDocument())
        // Il testo scritto dall'operatore è ancora lì: non è stato buttato via.
        expect((screen.getByPlaceholderText(itTeacher.formPlaceholderTitolo) as HTMLInputElement).value)
            .toBe('Chiusura straordinaria')
        // Lo STATO è un numero (passa la lista bianca di `redact`) ed è l'unica
        // cosa che distingue «sede ambigua» da «non sei autorizzato».
        expect(h.logClient).toHaveBeenCalledWith(
            expect.objectContaining({ livello: 'error', evento: 'fetch', stato: 400 }),
        )
    })

    it('riuscito: il modulo si chiude e la bacheca si ricarica', async () => {
        await apriModuloECompila()
        fireEvent.change(await screen.findByLabelText(itTeacher.formLabelSedePubblicazione), { target: { value: SEDE_A } })
        fireEvent.click(pubblica())

        await waitFor(() =>
            expect(screen.queryByPlaceholderText(itTeacher.formPlaceholderTitolo)).not.toBeInTheDocument(),
        )
        expect(h.logClient).not.toHaveBeenCalled()
    })
})

describe('/admin/avvisi — eliminazione', () => {
    it('un DELETE respinto lo dice, invece di far finta che sia andato', async () => {
        vi.stubGlobal('confirm', () => true)
        fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
            const u = String(url)
            if (init?.method === 'DELETE') {
                return Promise.resolve({ ok: false, status: 403, json: async () => ({ error: 'Avviso di un altro plesso' }) })
            }
            if (u.includes('/api/admin/sections/scoped')) {
                return Promise.resolve({ ok: true, status: 200, json: async () => SCOPED })
            }
            return Promise.resolve({
                ok: true,
                status: 200,
                json: async () => [
                    {
                        id: 'avv-1', author_id: USER, titolo: 'Vecchio avviso', contenuto: '…',
                        tipo: 'presa_visione', target_scope: 'globale', target_classes: null,
                        scadenza: null, attachment_url: null, created_at: '2026-07-30T10:00:00Z',
                        author: { first_name: 'A', last_name: 'B', role: 'admin' },
                        stats: { letti: 0, adesioni_si: 0, adesioni_no: 0 },
                    },
                ],
            })
        })

        render(<AdminAvvisiPage />)
        await waitFor(() => expect(screen.getByText('Vecchio avviso')).toBeInTheDocument())
        fireEvent.click(screen.getByTitle(itAdmin.avvisiAzioneElimina))

        await waitFor(() => expect(screen.getByText(/Avviso di un altro plesso/)).toBeInTheDocument())
        expect(h.logClient).toHaveBeenCalledWith(
            expect.objectContaining({ livello: 'error', evento: 'fetch', stato: 403 }),
        )
    })
})

describe('/admin/avvisi — i18n', () => {
    it('la chiave dell\'errore esiste in ENTRAMBI i cataloghi', () => {
        expect(itAdmin).toHaveProperty('avvisiErroreOperazione')
        expect(enAdmin).toHaveProperty('avvisiErroreOperazione')
    })

    it('adminComunicazioni: it ed en espongono lo stesso set di chiavi', () => {
        expect(Object.keys(itAdmin).sort()).toEqual(Object.keys(enAdmin).sort())
    })
})
