import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import itSettings from '../../messages/it/adminSettings.json'
import enSettings from '../../messages/en/adminSettings.json'
import { SEDE_A } from '../fixtures/sedi'

// =============================================================================
// W3-F / R78 — Impostazioni → Pagamenti: cinque pannelli salvavano al buio.
//
// `save()` faceva `await fetch('/api/admin/settings', { method: 'PATCH', … })`
// e basta: la risposta veniva SCARTATA. Con tre sedi il caso non è teorico —
// `resolveScuolaScrittura` risponde 400 «Specificare la sede» e la route di
// scope risponde 403 su una sede non propria: in entrambi i casi lo spinner
// finiva, il bottone tornava «Salva» e l'operatore usciva convinto di aver
// cambiato l'importo della retta. Non era cambiato niente.
//
// Si asserisce il MESSAGGIO del server a schermo e la riga di log (con lo
// `stato`, che è ciò che distingue «sede ambigua» da «sede non tua»).
// =============================================================================

const USER = 'aaaabbbb-1111-4111-8111-dddddddddddd'

const h = vi.hoisted(() => ({ logClient: vi.fn() }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: () => 'Error' }))

import { SettingsPanel } from '@/components/features/admin/settings/SettingsPanel'

const SETTINGS = {
    success: true,
    data: {
        retta_default_importo: 180,
        retta_giorno_scadenza: 5,
        retta_giorno_visibilita: 25,
        retta_auto_enabled: true,
        insoluto_tolleranza_giorni: 10,
        ticket_pacchetti: [],
        fattura_causale_template: '{descrizione} - {alunno}',
        solleciti_config: {},
        fiscale_config: {},
    },
}

const fetchMock = vi.fn()
let rispostaPatch: { ok: boolean; status: number; body: unknown } = { ok: true, status: 200, body: { success: true, data: SETTINGS.data } }

beforeEach(() => {
    vi.clearAllMocks()
    rispostaPatch = { ok: true, status: 200, body: { success: true, data: SETTINGS.data } }
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
        const u = String(url)
        if (init?.method === 'PATCH') {
            return Promise.resolve({ ok: rispostaPatch.ok, status: rispostaPatch.status, json: async () => rispostaPatch.body })
        }
        if (u.includes('/api/admin/settings/aruba')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { username: '', password_ref: '', has_password: false, abilitato: false, ambiente: 'test', fiscal: {}, iva: [] } }) })
        }
        if (u.includes('/api/admin/settings/categorie')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: [] }) })
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => SETTINGS })
    })
    vi.stubGlobal('fetch', fetchMock)
})

/** I bottoni «Salva» dei pannelli, nell'ordine di montaggio. */
async function bottoniSalva() {
    return await screen.findAllByRole('button', { name: new RegExp(itSettings.salva, 'i') })
}

describe('SettingsPanel — il salvataggio dice com\'è andato', () => {
    it('PATCH respinta (403 di sede): il messaggio del server è a schermo e finisce nei log', async () => {
        rispostaPatch = { ok: false, status: 403, body: { error: 'Impostazioni di un altro plesso' } }
        render(<SettingsPanel userId={USER} scuolaId={SEDE_A} />)

        const salva = await bottoniSalva()
        fireEvent.click(salva[0])

        await waitFor(() => expect(screen.getByText(/Impostazioni di un altro plesso/)).toBeInTheDocument())
        expect(h.logClient).toHaveBeenCalledWith(
            expect.objectContaining({ livello: 'error', evento: 'fetch', stato: 403 }),
        )
    })

    it('PATCH respinta con 400 «Specificare la sede»: stesso trattamento, nessun silenzio', async () => {
        rispostaPatch = { ok: false, status: 400, body: { error: 'Specificare la sede (scuola_id) per questa operazione' } }
        render(<SettingsPanel userId={USER} scuolaId={SEDE_A} />)

        const salva = await bottoniSalva()
        fireEvent.click(salva[salva.length - 1])

        await waitFor(() => expect(screen.getByText(/Specificare la sede/)).toBeInTheDocument())
        expect(h.logClient).toHaveBeenCalledWith(
            expect.objectContaining({ livello: 'error', evento: 'fetch', stato: 400 }),
        )
    })

    it('PATCH riuscita: nessun errore a schermo e nessuna riga di log', async () => {
        render(<SettingsPanel userId={USER} scuolaId={SEDE_A} />)
        const salva = await bottoniSalva()
        fireEvent.click(salva[0])

        await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining('/api/admin/settings'),
            expect.objectContaining({ method: 'PATCH' }),
        ))
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
        expect(h.logClient).not.toHaveBeenCalled()
    })
})

describe('SettingsPanel — i18n', () => {
    it('adminSettings: it ed en espongono lo stesso set di chiavi', () => {
        expect(Object.keys(itSettings).sort()).toEqual(Object.keys(enSettings).sort())
    })
})
