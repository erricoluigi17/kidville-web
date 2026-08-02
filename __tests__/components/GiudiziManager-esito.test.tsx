import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import itPrimaria from '../../messages/it/adminPrimaria.json'
import enPrimaria from '../../messages/en/adminPrimaria.json'
import { SEDE_A } from '../fixtures/sedi'

// =============================================================================
// W3-F / R78 — GiudiziManager: SEI mutazioni, nessun esito.
//
// `addScala`, `removeScala`, `updateScala`, `renameScala`, `toggleAttivo`,
// `saveFrammento` facevano tutte `await fetch(...)` e poi `load()`. Se il server
// rifiutava — e con tre sedi rifiuta: la scala giudizi è PER SEDE e la route
// nega su una sede non propria — `load()` ricaricava i vecchi valori e la
// modifica spariva a schermo senza una parola. Indistinguibile da «l'ho scritta
// male io».
//
// Si asserisce il MESSAGGIO del server a schermo, la riga di log con lo `stato`
// e il fatto che il testo digitato NON venga buttato via.
// =============================================================================

const USER = 'aaaabbbb-1111-4111-8111-eeeeeeeeeeee'

const h = vi.hoisted(() => ({ logClient: vi.fn() }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: () => 'Error' }))

import { GiudiziManager } from '@/components/features/admin/primaria/GiudiziManager'

const DATI = {
    success: true,
    data: {
        scala: [
            { id: 'g1', etichetta: 'Avanzato', ordine: 1, valore_numerico: 10, giudizio_descrittivo: null, attivo: true },
        ],
        template: [
            { id: 't1', scuola_id: SEDE_A, dimensione: 'autonomia', valore: 'avanzato', frammento: 'Lavora da solo.' },
        ],
    },
}

const fetchMock = vi.fn()
let rispostaMutazione: { ok: boolean; status: number; body: unknown } = { ok: true, status: 200, body: { success: true } }

beforeEach(() => {
    vi.clearAllMocks()
    rispostaMutazione = { ok: true, status: 200, body: { success: true } }
    fetchMock.mockImplementation((_url: string, init?: { method?: string }) => {
        if (init?.method && init.method !== 'GET') {
            return Promise.resolve({ ok: rispostaMutazione.ok, status: rispostaMutazione.status, json: async () => rispostaMutazione.body })
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => DATI })
    })
    vi.stubGlobal('fetch', fetchMock)
})

describe('GiudiziManager — le mutazioni riportano l\'esito', () => {
    it('nuovo giudizio respinto (403 di sede): messaggio a schermo, log, e il testo resta nel campo', async () => {
        rispostaMutazione = { ok: false, status: 403, body: { error: 'Scala di un altro plesso' } }
        render(<GiudiziManager scuolaId={SEDE_A} userId={USER} />)
        await waitFor(() => expect(screen.getByDisplayValue('Avanzato')).toBeInTheDocument())

        const campo = screen.getByPlaceholderText(itPrimaria.giudiziPlaceholderNuovo)
        fireEvent.change(campo, { target: { value: 'Intermedio' } })
        fireEvent.click(screen.getByLabelText(itPrimaria.giudiziAggiungi))

        await waitFor(() => expect(screen.getByText(/Scala di un altro plesso/)).toBeInTheDocument())
        expect(h.logClient).toHaveBeenCalledWith(
            expect.objectContaining({ livello: 'error', evento: 'fetch', stato: 403 }),
        )
        // Il testo digitato non si perde: si può correggere e riprovare.
        expect((campo as HTMLInputElement).value).toBe('Intermedio')
    })

    it('eliminazione respinta: lo dice, invece di ricaricare e far sparire il gesto', async () => {
        rispostaMutazione = { ok: false, status: 409, body: { error: 'Giudizio già usato in una pagella' } }
        render(<GiudiziManager scuolaId={SEDE_A} userId={USER} />)
        await waitFor(() => expect(screen.getByDisplayValue('Avanzato')).toBeInTheDocument())

        fireEvent.click(screen.getByLabelText(itPrimaria.giudiziElimina))
        await waitFor(() => expect(screen.getByText(/già usato in una pagella/)).toBeInTheDocument())
        expect(h.logClient).toHaveBeenCalledWith(
            expect.objectContaining({ livello: 'error', evento: 'fetch', stato: 409 }),
        )
    })

    it('frammento del template respinto: messaggio a schermo e log', async () => {
        rispostaMutazione = { ok: false, status: 400, body: { error: 'Specificare la sede (scuola_id) per questa operazione' } }
        render(<GiudiziManager scuolaId={SEDE_A} userId={USER} />)
        const frammento = await screen.findByDisplayValue('Lavora da solo.')

        fireEvent.blur(frammento, { target: { value: 'Lavora in autonomia.' } })
        await waitFor(() => expect(screen.getByText(/Specificare la sede/)).toBeInTheDocument())
        expect(h.logClient).toHaveBeenCalledWith(
            expect.objectContaining({ livello: 'error', evento: 'fetch', stato: 400 }),
        )
    })

    it('mutazione riuscita: nessun errore a schermo, nessun log, campo svuotato', async () => {
        render(<GiudiziManager scuolaId={SEDE_A} userId={USER} />)
        await waitFor(() => expect(screen.getByDisplayValue('Avanzato')).toBeInTheDocument())

        const campo = screen.getByPlaceholderText(itPrimaria.giudiziPlaceholderNuovo)
        fireEvent.change(campo, { target: { value: 'Intermedio' } })
        fireEvent.click(screen.getByLabelText(itPrimaria.giudiziAggiungi))

        await waitFor(() => expect((campo as HTMLInputElement).value).toBe(''))
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
        expect(h.logClient).not.toHaveBeenCalled()
    })
})

describe('GiudiziManager — i18n', () => {
    it('le chiavi nuove esistono in ENTRAMBI i cataloghi', () => {
        for (const k of ['giudiziAggiungi', 'giudiziElimina', 'giudiziErroreOperazione']) {
            expect(itPrimaria).toHaveProperty(k)
            expect(enPrimaria).toHaveProperty(k)
        }
    })

    it('adminPrimaria: it ed en espongono lo stesso set di chiavi', () => {
        expect(Object.keys(itPrimaria).sort()).toEqual(Object.keys(enPrimaria).sort())
    })
})
