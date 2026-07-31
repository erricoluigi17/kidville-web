import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import itAdmin from '../../messages/it/adminStudents.json'
import enAdmin from '../../messages/en/adminStudents.json'
import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi'

/**
 * F1 — /admin/students/sezioni/[id]: il dettaglio sezione INGOIAVA il rifiuto
 * del server.
 *
 * Misurato in produzione il 2026-07-31: cambiando «Tipo di Scuola» il menu
 * lampeggia e torna indietro. La PATCH era partita davvero e il server aveva
 * risposto **400 «Specificare la sede»** (il 400 nato con `resolveScuolaScrittura`
 * quando le sedi sono tre). Gli elementi `[role="alert"]` sulla pagina erano
 * ZERO e la console muta: dall'esterno è indistinguibile da un click non
 * registrato.
 *
 * Tre scritture, tre modi di perdere l'esito:
 *   · `changeSchoolType` → `if (res.ok) setSezione(...)`, nessun ramo `else`;
 *   · `addTeacher`       → `await fetch(...)` e basta, per giunta con
 *                          `setNewTeacherId('')` PRIMA di sapere com'è andata:
 *                          su un rifiuto azzerava il modulo;
 *   · `removeTeacher`    → `await fetch(...)` e ricarica, comunque sia andata.
 *
 * E la stessa pagina confondeva «non ho potuto caricare» con «la sezione non
 * esiste»: un GET fallito mostrava la card «Sezione non disponibile».
 *
 * Qui si asserisce ciò che l'operatore VEDE (il messaggio del server, il campo
 * NON azzerato, la tendina che non mente) e ciò che finisce nei log.
 */

const SEZ = 'sez-a-2anni'
const DOCENTE = 'dddddddd-0000-4000-8000-00000000000d'

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

type Risposta = { ok: boolean; status: number; body: unknown }

const fetchMock = vi.fn()

/** Esiti per metodo, decisi da ogni test. */
let esiti: Record<string, Risposta>
/** `/api/admin/sections/scoped` fallisce? (rete giù, non «sezione inesistente») */
let scopedRotto: 'no' | 'rete' | '500'

beforeEach(() => {
    vi.clearAllMocks()
    esiti = {
        PATCH: { ok: true, status: 200, body: { success: true } },
        POST: { ok: true, status: 200, body: { success: true } },
        DELETE: { ok: true, status: 200, body: { success: true } },
    }
    scopedRotto = 'no'
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
        const u = String(url)
        const metodo = init?.method ?? 'GET'
        if (metodo !== 'GET') {
            const r = esiti[metodo]
            return Promise.resolve({ ok: r.ok, status: r.status, json: async () => r.body })
        }
        if (u.includes('/teachers')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => DOCENTI })
        }
        if (u.includes('/api/admin/sections/scoped')) {
            if (scopedRotto === 'rete') return Promise.reject(new TypeError('Failed to fetch'))
            if (scopedRotto === '500') {
                return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'Errore interno' }) })
            }
            return Promise.resolve({ ok: true, status: 200, json: async () => SCOPED })
        }
        // /api/admin/students?scuola_id=…
        return Promise.resolve({ ok: true, status: 200, json: async () => [] })
    })
    vi.stubGlobal('fetch', fetchMock)
})

import SezioneDetailPage from '@/app/(dashboard)/admin/students/sezioni/[id]/page'

/** La tendina del grado: è l'unica che offre «nido». */
const tendinaTipo = () =>
    Array.from(document.querySelectorAll('select')).find((s) =>
        Array.from(s.options).some((o) => o.value === 'nido'),
    ) as HTMLSelectElement

/** La tendina degli insegnanti disponibili. */
const tendinaDocente = () =>
    Array.from(document.querySelectorAll('select')).find((s) =>
        Array.from(s.options).some((o) => o.value === DOCENTE),
    ) as HTMLSelectElement

// NB: il mock di next-intl in `test/setup.ts` NON interpola i parametri ICU,
// quindi l'intestazione esce come «Sezione {nome}»: si àncora sul nome della
// sede, che è testo vero, e sulla presenza della tendina del grado.
async function apri() {
    render(<SezioneDetailPage />)
    await waitFor(() => expect(tendinaTipo()).toBeTruthy())
    expect(screen.getAllByText(NOME_SEDE_A).length).toBeGreaterThan(0)
}

/** Il corpo dell'unica richiesta con quel metodo. */
function corpo(metodo: string): Record<string, unknown> {
    const call = fetchMock.mock.calls.find((c) => (c[1] as { method?: string } | undefined)?.method === metodo)
    expect(call, `nessuna ${metodo} è partita`).toBeTruthy()
    return JSON.parse(String((call![1] as { body?: string }).body))
}

describe('Dettaglio sezione — il rifiuto del server si VEDE', () => {
    it('«Tipo di Scuola»: un 400 «Specificare la sede» compare a schermo, e la tendina non mente', async () => {
        esiti.PATCH = { ok: false, status: 400, body: { error: 'Specificare la sede su cui operare.' } }
        await apri()

        expect(tendinaTipo().value).toBe('infanzia')
        fireEvent.change(tendinaTipo(), { target: { value: 'primaria' } })

        // La PATCH è partita davvero (il difetto NON era il click non registrato).
        await waitFor(() => expect(corpo('PATCH')).toMatchObject({ id: SEZ, school_type: 'primaria' }))
        // …e adesso l'operatore lo legge, col messaggio del SERVER.
        const avviso = await screen.findByRole('alert')
        expect(avviso).toHaveTextContent('Specificare la sede su cui operare.')
        // La tendina torna al valore vero: il grado non è cambiato.
        expect(tendinaTipo().value).toBe('infanzia')
        // Lo `stato` è un numero: passa la lista bianca di `redact` ed è l'unica
        // cosa che distingue «sede ambigua» (400) da «non sei autorizzato» (403).
        expect(h.logClient).toHaveBeenCalledWith(
            expect.objectContaining({ livello: 'error', evento: 'fetch', stato: 400 }),
        )
    })

    it('«Tipo di Scuola» riuscito: nessun allarme, e il grado cambia', async () => {
        await apri()
        fireEvent.change(tendinaTipo(), { target: { value: 'primaria' } })

        await waitFor(() => expect(tendinaTipo().value).toBe('primaria'))
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
        expect(h.logClient).not.toHaveBeenCalled()
    })

    it('«Aggiungi insegnante» respinto: il messaggio si vede e il modulo NON si azzera', async () => {
        esiti.POST = { ok: false, status: 403, body: { error: 'Docente di un altro plesso' } }
        await apri()

        fireEvent.change(await waitFor(() => tendinaDocente()), { target: { value: DOCENTE } })
        fireEvent.click(screen.getByRole('button', { name: new RegExp(itAdmin.sezAggiungi, 'i') }))

        const avviso = await screen.findByRole('alert')
        expect(avviso).toHaveTextContent('Docente di un altro plesso')
        // ⚠️ IL PUNTO: la selezione è ancora lì. Prima veniva azzerata PRIMA di
        // sapere l'esito, cioè su un rifiuto si perdeva anche ciò che si era scelto.
        expect(tendinaDocente().value).toBe(DOCENTE)
        expect(h.logClient).toHaveBeenCalledWith(
            expect.objectContaining({ livello: 'error', evento: 'fetch', stato: 403 }),
        )
    })

    it('«Aggiungi insegnante» riuscito: il modulo si azzera e l\'elenco si ricarica', async () => {
        await apri()
        fireEvent.change(await waitFor(() => tendinaDocente()), { target: { value: DOCENTE } })
        fireEvent.click(screen.getByRole('button', { name: new RegExp(itAdmin.sezAggiungi, 'i') }))

        await waitFor(() => expect(tendinaDocente().value).toBe(''))
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('«Rimuovi insegnante» respinto: lo dice, invece di ricaricare e basta', async () => {
        esiti.DELETE = { ok: false, status: 403, body: { error: 'Assegnazione di un altro plesso' } }
        await apri()

        fireEvent.click(await screen.findByRole('button', { name: itAdmin.sezRimuoviInsegnante }))

        const avviso = await screen.findByRole('alert')
        expect(avviso).toHaveTextContent('Assegnazione di un altro plesso')
        expect(h.logClient).toHaveBeenCalledWith(
            expect.objectContaining({ livello: 'error', evento: 'fetch', stato: 403 }),
        )
    })
})

describe('Dettaglio sezione — «non ho potuto caricare» ≠ «non esiste»', () => {
    it('rete giù: dice che il caricamento è fallito, NON che la sezione non esiste', async () => {
        scopedRotto = 'rete'
        render(<SezioneDetailPage />)

        await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
        expect(screen.queryByText(itAdmin.sezNonDisp)).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: new RegExp(itAdmin.sezRiprova, 'i') })).toBeInTheDocument()
        expect(h.logClient).toHaveBeenCalledWith(
            expect.objectContaining({ livello: 'error', evento: 'fetch' }),
        )
    })

    it('500 del server: stessa storia, col messaggio del server', async () => {
        scopedRotto = '500'
        render(<SezioneDetailPage />)

        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Errore interno'))
        expect(screen.queryByText(itAdmin.sezNonDisp)).not.toBeInTheDocument()
    })

    it('sezione davvero inesistente (200 ma non c\'è): resta la card «non disponibile», senza allarmi', async () => {
        fetchMock.mockImplementation((url: string) => {
            const u = String(url)
            if (u.includes('/teachers')) return Promise.resolve({ ok: true, status: 200, json: async () => DOCENTI })
            if (u.includes('/api/admin/sections/scoped')) {
                return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: [] }) })
            }
            return Promise.resolve({ ok: true, status: 200, json: async () => [] })
        })
        render(<SezioneDetailPage />)

        await waitFor(() => expect(screen.getByText(itAdmin.sezNonDisp)).toBeInTheDocument())
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
})

describe('Dettaglio sezione — i18n', () => {
    it('le chiavi nuove esistono in ENTRAMBI i cataloghi', () => {
        for (const k of ['sezErroreOperazione', 'sezErroreCaricamento', 'sezRiprova']) {
            expect(itAdmin, `manca in it/adminStudents.json: ${k}`).toHaveProperty(k)
            expect(enAdmin, `manca in en/adminStudents.json: ${k}`).toHaveProperty(k)
        }
    })

    it('adminStudents: it ed en espongono lo stesso set di chiavi', () => {
        expect(Object.keys(itAdmin).sort()).toEqual(Object.keys(enAdmin).sort())
    })
})
