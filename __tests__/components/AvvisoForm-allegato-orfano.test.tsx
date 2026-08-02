import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import itTeacher from '../../messages/it/teacherComunicazioni.json'
import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi'

// =============================================================================
// S35 · IL FILE DELLA BOZZA ABBANDONATA, visto dal modulo.
//
// `POST /api/avvisi/upload` mette il file nel bucket SUBITO — l'anteprima deve
// comparire mentre si scrive l'avviso. Poi `removeFile` e la chiusura del modulo
// toglievano l'allegato dalla bozza e MAI dallo Storage: chi allega un PDF e ci
// ripensa lasciava il documento archiviato per sempre, senza nessun avviso che lo
// nominasse. In produzione ce n'era già uno, del 24/05/2026.
//
// Qui si asserisce sulla RICHIESTA CHE PARTE (verso quale rotta, con quale
// percorso e quale sigillo), non su uno stato interno: è l'unica cosa che
// determina se il file esce davvero dal bucket.
//
// I DUE CASI IN CUI NON SI DEVE RIMUOVERE NIENTE valgono quanto quello in cui si
// rimuove, e senza di loro questo file sarebbe la prova di un difetto peggiore:
//  · dopo la PUBBLICAZIONE il file è l'allegato di una comunicazione viva;
//  · in MODIFICA l'allegato già archiviato non è stato caricato adesso — non c'è
//    nessun sigillo, e cancellarlo vorrebbe dire rompere un avviso pubblicato.
// =============================================================================

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Error' }))

import { AvvisoForm, type ClasseAvviso, type EsitoInvioAvviso } from '@/components/features/avvisi/AvvisoForm'
import type { Avviso } from '@/components/features/avvisi/AvvisoCard'

const CLASSI: ClasseAvviso[] = [
    { id: 'sez-a-2anni', nome: '2 ANNI', scuolaId: SEDE_A, scuolaNome: NOME_SEDE_A },
]

const PERCORSO = '1785526750670-91plab2.pdf'
const SIGILLO = '1785600000000.abcdef0123456789'
const ROTTA_RIMOZIONE = '/api/avvisi/upload/rimuovi'

const json = (corpo: unknown, stato = 200): Response =>
    new Response(JSON.stringify(corpo), { status: stato, headers: { 'Content-Type': 'application/json' } })

const fetchMock = vi.fn()

/** Le richieste di rimozione partite, col loro corpo già decodificato. */
function rimozioni(): { percorso?: string; sigillo?: string }[] {
    return fetchMock.mock.calls
        .filter((c) => String(c[0]).includes(ROTTA_RIMOZIONE))
        .map((c) => JSON.parse(String((c[1] as RequestInit).body)))
}

function montaModulo(props: { initialAvviso?: Avviso | null; onSubmit?: () => Promise<EsitoInvioAvviso> } = {}) {
    return render(
        <AvvisoForm
            open
            onClose={() => {}}
            onSubmit={props.onSubmit ?? (async () => ({ ok: true }))}
            availableClasses={CLASSI}
            initialAvviso={props.initialAvviso ?? null}
        />,
    )
}

function scegliFile(container: HTMLElement, nome = 'circolare.pdf') {
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['x'], nome, { type: 'application/pdf' })] } })
}

const bottoneTogli = () => screen.getByRole('button', { name: /rimuovi/i })
const bottoneChiudi = () => screen.getByRole('button', { name: /chiudi/i })

beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockImplementation(async (url: unknown) => {
        if (String(url).includes(ROTTA_RIMOZIONE)) return json({ rimosso: true })
        return json({ path: PERCORSO, fileUrl: PERCORSO, previewUrl: null, sigillo: SIGILLO })
    })
    vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => { vi.unstubAllGlobals() })

describe('AvvisoForm · l’allegato caricato e mai pubblicato non resta nel bucket', () => {
    it('«togli allegato» rimuove anche il FILE, col percorso e il sigillo dell’upload', async () => {
        const { container } = montaModulo()
        scegliFile(container)
        await waitFor(() => expect(screen.getByText('circolare.pdf')).toBeInTheDocument())

        fireEvent.click(bottoneTogli())

        await waitFor(() => expect(rimozioni()).toHaveLength(1))
        expect(rimozioni()[0]).toEqual({ percorso: PERCORSO, sigillo: SIGILLO })
    })

    it('chiudere il modulo con un allegato caricato e non pubblicato lo rimuove', async () => {
        const { container } = montaModulo()
        scegliFile(container)
        await waitFor(() => expect(screen.getByText('circolare.pdf')).toBeInTheDocument())

        fireEvent.click(bottoneChiudi())

        await waitFor(() => expect(rimozioni()).toHaveLength(1))
        expect(rimozioni()[0].percorso).toBe(PERCORSO)
    })

    it('CONTROLLO NEGATIVO · dopo la PUBBLICAZIONE, chiudere non cancella l’allegato', async () => {
        const { container } = montaModulo()
        scegliFile(container)
        await waitFor(() => expect(screen.getByText('circolare.pdf')).toBeInTheDocument())

        fireEvent.change(screen.getByLabelText(itTeacher.formLabelTitolo), { target: { value: 'TEST titolo' } })
        fireEvent.change(screen.getByLabelText(itTeacher.formLabelContenuto), { target: { value: 'TEST contenuto' } })
        fireEvent.click(screen.getByRole('button', { name: new RegExp(itTeacher.formSubmitPubblicaAvviso, 'i') }))
        await waitFor(() => expect(screen.queryByText('circolare.pdf')).toBeNull())

        fireEvent.click(bottoneChiudi())

        await new Promise((r) => setTimeout(r, 0))
        expect(
            rimozioni(),
            'Il file è l’allegato di un avviso appena pubblicato: cancellarlo lo romperebbe.',
        ).toHaveLength(0)
    })

    it('CONTROLLO NEGATIVO · in MODIFICA l’allegato già archiviato non si cancella dal bucket', async () => {
        const archiviato: Avviso = {
            id: 'avv-1',
            author_id: 'aut-1',
            titolo: 'TEST uscita',
            contenuto: 'TEST contenuto',
            tipo: 'presa_visione',
            target_scope: 'globale',
            target_classes: [],
            scadenza: null,
            attachment_url: JSON.stringify({ file: PERCORSO, link: null }),
            created_at: '2026-07-31T08:00:00.000Z',
            author: { first_name: 'Nome', last_name: 'Cognome', role: 'segreteria' },
            stats: { letti: 0, adesioni_si: 0, adesioni_no: 0 },
        }
        montaModulo({ initialAvviso: archiviato })

        fireEvent.click(bottoneTogli())

        await new Promise((r) => setTimeout(r, 0))
        expect(
            rimozioni(),
            'Togliere l’allegato da una MODIFICA non ancora salvata non deve cancellare il file dell’avviso pubblicato.',
        ).toHaveLength(0)
    })

    it('sostituire l’allegato rimuove il PRECEDENTE, non il nuovo', async () => {
        const { container } = montaModulo()
        scegliFile(container, 'primo.pdf')
        await waitFor(() => expect(screen.getByText('primo.pdf')).toBeInTheDocument())

        fetchMock.mockImplementation(async (url: unknown) => {
            if (String(url).includes(ROTTA_RIMOZIONE)) return json({ rimosso: true })
            return json({ path: 'secondo.pdf', fileUrl: 'secondo.pdf', previewUrl: null, sigillo: 'S2' })
        })
        scegliFile(container, 'secondo.pdf')
        await waitFor(() => expect(screen.getByText('secondo.pdf')).toBeInTheDocument())

        await waitFor(() => expect(rimozioni()).toHaveLength(1))
        expect(rimozioni()[0]).toEqual({ percorso: PERCORSO, sigillo: SIGILLO })
    })

    it('senza sigillo (segreto non configurato sul server) non parte nessuna richiesta inutile', async () => {
        fetchMock.mockImplementation(async (url: unknown) => {
            if (String(url).includes(ROTTA_RIMOZIONE)) return json({ rimosso: false })
            return json({ path: PERCORSO, fileUrl: PERCORSO, previewUrl: null, sigillo: null })
        })
        const { container } = montaModulo()
        scegliFile(container)
        await waitFor(() => expect(screen.getByText('circolare.pdf')).toBeInTheDocument())

        fireEvent.click(bottoneTogli())

        await new Promise((r) => setTimeout(r, 0))
        expect(rimozioni()).toHaveLength(0)
    })
})
