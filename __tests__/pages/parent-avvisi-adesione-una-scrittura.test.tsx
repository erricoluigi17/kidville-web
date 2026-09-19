import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { IntlMessageFormat } from 'intl-messageformat'

import itAvvisi from '../../messages/it/avvisi.json'

// =============================================================================
// C3 · /parent/avvisi — «ADERISCO» DA SOLO NON SCRIVE.
//
// È la prova che tiene insieme le tre parti (pagina, card, modale) e l'unica che
// misura la decisione vincolante del committente: **senza il numero l'adesione
// non vale e non viene salvata**, e la scrittura avviene una volta sola, alla
// conferma. Provata sulla card da sola direbbe solo che un callback è stato
// chiamato; provata sulla modale da sola direbbe solo che la modale scrive. Il
// difetto vive nel mezzo: una `POST` al tocco e una alla conferma sarebbero DUE
// righe per la stessa adesione, e a schermo si vedrebbe uguale.
//
// ── E IL FLUSSO A UN TOCCO RESTA ────────────────────────────────────────────
//
// Sugli avvisi che NON chiedono il numero la modale non si apre affatto: non c'è
// niente da chiedere, e un dialogo in più su ogni circolare della scuola è un
// costo pagato da tutte le famiglie per una funzione che riguarda le gite.
// =============================================================================

const T = (chiave: keyof typeof itAvvisi, valori?: Record<string, unknown>): string =>
    valori === undefined
        ? itAvvisi[chiave]
        : String(new IntlMessageFormat(itAvvisi[chiave], 'it').format(valori))

const PARENT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

const stub = vi.hoisted(() => ({
    pathname: '/parent/avvisi',
    params: new URLSearchParams(),
    router: { push: () => {}, replace: () => {}, refresh: () => {} },
}))

vi.mock('next/navigation', () => ({
    usePathname: () => stub.pathname,
    useSearchParams: () => stub.params,
    useRouter: () => stub.router,
}))

vi.mock('@/lib/auth/use-parent-identity', () => ({
    useParentIdentity: () => ({
        parentId: PARENT_ID,
        studentId: 's-1',
        figliIds: ['s-1', 's-2'],
        ready: true,
    }),
}))

vi.mock('@/lib/logging/client', () => ({
    logClient: vi.fn(),
    nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'Error'),
}))

/** Il feed: la pagina lo legge da `fetchConCache`, che qui serve la fixture. */
const feed = vi.hoisted(() => ({ righe: [] as Array<Record<string, unknown>> }))
vi.mock('@/lib/offline/read-cache', () => ({
    fetchConCache: async () => ({ data: feed.righe, offline: false }),
}))

import ParentAvvisiPage from '@/app/(dashboard)/parent/avvisi/page'

const MARCO = { student_id: 's-1', nome: 'TEST Marco' }
const GIULIA = { student_id: 's-2', nome: 'TEST Giulia' }

/**
 * `letto_il` è già valorizzato di proposito: aprire la card manda la PRESA
 * VISIONE, che è una `POST` legittima ma non è quella che questo file conta.
 * Con l'avviso già letto le chiamate rimaste sono solo quelle dell'adesione.
 */
const avvisoBase = (p: Record<string, unknown> = {}) => ({
    id: 'avv-1',
    author_id: 'aut-1',
    titolo: 'TEST Gita al museo',
    contenuto: 'TEST corpo',
    tipo: 'adesione',
    target_scope: 'globale',
    target_classes: null,
    scadenza: null,
    scadenza_avviso: '2026-10-01T09:00:00.000Z',
    scadenza_adesione: '2026-09-25T09:00:00.000Z',
    chiedi_numero: true,
    etichetta_numero: 'TEST quante persone verranno?',
    numero_min: 1,
    numero_max: 10,
    scaduto: false,
    adesioni_chiuse: false,
    attachment_url: null,
    created_at: '2026-09-01T08:00:00.000Z',
    author: { first_name: 'TEST', last_name: 'Segreteria', role: 'segreteria' },
    stats: { letti: 1, adesioni_si: 0, adesioni_no: 0 },
    figli: [MARCO],
    my_response: { letto_il: 'x', risposta: null, risposto_il: null, stato_adesione: null, numero_partecipanti: null },
    ...p,
})

let chiamate: Array<{ url: string; corpo: Record<string, unknown> }> = []
const fetchOriginale = globalThis.fetch

beforeEach(() => {
    chiamate = []
    feed.righe = [avvisoBase()]
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        chiamate.push({
            url: String(input),
            corpo: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
        })
        return { ok: true, status: 200, json: async () => ({ stato: 'ammessa' }) } as unknown as Response
    }) as unknown as typeof globalThis.fetch
})

afterEach(() => {
    globalThis.fetch = fetchOriginale
    cleanup()
})

/** Monta la pagina e apre la card dell'avviso. */
async function apriLaCard(titolo = 'TEST Gita al museo') {
    render(<ParentAvvisiPage />)
    const testata = await screen.findByRole('button', { name: titolo })
    fireEvent.click(testata)
}

describe('/parent/avvisi · «Aderisco» non scrive: scrive la conferma, una volta sola', () => {
    it('🔴 al tocco di «Aderisco» NESSUNA scrittura, e la modale si apre', async () => {
        await apriLaCard()
        fireEvent.click(screen.getByRole('button', { name: T('aderisco') }))

        expect(screen.getByRole('dialog')).toBeInTheDocument()
        // Il punto dell'intero cantiere: senza il numero l'adesione non vale, e non
        // se ne archivia una a metà «tanto poi la correggiamo».
        expect(chiamate, 'il tocco di «Aderisco» ha già scritto').toHaveLength(0)
    })

    it('alla conferma parte UNA sola POST per figlio, col numero scelto', async () => {
        await apriLaCard()
        fireEvent.click(screen.getByRole('button', { name: T('aderisco') }))

        const campo = document.querySelector('input[type="number"]') as HTMLInputElement
        fireEvent.change(campo, { target: { value: '3' } })
        fireEvent.click(screen.getByRole('button', { name: T('adesioneConferma') }))

        await waitFor(() => expect(chiamate).toHaveLength(1))
        expect(chiamate[0].url).toBe('/api/avvisi/avv-1/risposte')
        expect(chiamate[0].corpo).toEqual({ student_id: 's-1', risposta: 'si', numero_partecipanti: 3 })
    })

    it('due figli: due POST, una per bambino, e nessuna in più', async () => {
        feed.righe = [avvisoBase({ figli: [MARCO, GIULIA] })]
        await apriLaCard()
        fireEvent.click(screen.getByRole('button', { name: T('aderisco') }))

        const campi = Array.from(document.querySelectorAll('input[type="number"]')) as HTMLInputElement[]
        expect(campi).toHaveLength(2)
        fireEvent.change(campi[0], { target: { value: '2' } })
        fireEvent.change(campi[1], { target: { value: '4' } })
        fireEvent.click(screen.getByRole('button', { name: T('adesioneConferma') }))

        await waitFor(() => expect(chiamate).toHaveLength(2))
        expect(chiamate.map((c) => c.corpo)).toEqual([
            { student_id: 's-1', risposta: 'si', numero_partecipanti: 2 },
            { student_id: 's-2', risposta: 'si', numero_partecipanti: 4 },
        ])
    })
})

describe('/parent/avvisi · senza contatore il flusso resta a UN TOCCO', () => {
    it('`chiedi_numero: false` scrive subito, e nessuna modale si apre', async () => {
        // Il controllo positivo dell'altra metà: se la modale si aprisse SEMPRE,
        // ogni circolare della scuola costerebbe un dialogo a tutte le famiglie.
        feed.righe = [avvisoBase({ chiedi_numero: false })]
        await apriLaCard()
        fireEvent.click(screen.getByRole('button', { name: T('aderisco') }))

        await waitFor(() => expect(chiamate).toHaveLength(1))
        expect(chiamate[0].corpo).toEqual({ student_id: 's-1', risposta: 'si' })
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('«Non aderisco» non passa mai dalla modale: un numero non ce l’ha', async () => {
        await apriLaCard()
        fireEvent.click(screen.getByRole('button', { name: T('nonAderisco') }))

        await waitFor(() => expect(chiamate).toHaveLength(1))
        expect(chiamate[0].corpo).toEqual({ student_id: 's-1', risposta: 'no' })
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('il RITIRO passa dalla conferma in linea e manda «no» per ogni figlio', async () => {
        feed.righe = [avvisoBase({
            figli: [MARCO, GIULIA],
            my_response: { letto_il: 'x', risposta: 'si', risposto_il: 'x', stato_adesione: 'ammessa', numero_partecipanti: 2 },
        })]
        await apriLaCard()

        fireEvent.click(screen.getByRole('button', { name: T('ritiraAdesione') }))
        expect(chiamate, 'il primo tocco ha già ritirato').toHaveLength(0)

        fireEvent.click(screen.getByRole('button', { name: T('ritiraSi') }))
        await waitFor(() => expect(chiamate).toHaveLength(2))
        expect(chiamate.map((c) => c.corpo)).toEqual([
            { student_id: 's-1', risposta: 'no' },
            { student_id: 's-2', risposta: 'no' },
        ])
    })

    it('«Modifica il numero» riapre la modale precompilata, senza scrivere', async () => {
        feed.righe = [avvisoBase({
            my_response: { letto_il: 'x', risposta: 'si', risposto_il: 'x', stato_adesione: 'in_attesa', numero_partecipanti: 5 },
        })]
        await apriLaCard()

        fireEvent.click(screen.getByRole('button', { name: T('modificaNumero') }))

        expect(screen.getByRole('dialog')).toBeInTheDocument()
        expect((document.querySelector('input[type="number"]') as HTMLInputElement).value).toBe('5')
        expect(chiamate).toHaveLength(0)
    })
})
