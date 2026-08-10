import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

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

// `next/link` fuori dall'App Router non ha il contesto del router: qui interessa
// soltanto che l'ancora esista e punti dove deve.
vi.mock('next/link', async () => {
    const React = await import('react')
    return {
        default: ({ children, href }: { children?: React.ReactNode; href: string }) =>
            React.createElement('a', { href }, children),
    }
})

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

/**
 * Il campo «Causale fattura (template)» — `admin_settings.fattura_causale_template` —
 * era un modello UNICO per tutta la scuola: l'interfaccia lo mostrava, la route lo
 * accettava e lo scriveva davvero in colonna, e l'emissione della fattura non lo
 * leggeva mai. La segreteria scriveva «Retta {periodo} - {alunno}», premeva Salva,
 * riceveva la conferma, ed emetteva una fattura con la causale di fabbrica. Nessun
 * errore, nessun log, su un documento fiscale che si corregge solo con una nota di
 * variazione. (I due segnaposto suggeriti, `{alunno}` e `{periodo}`, non sono mai
 * esistiti nel motore delle causali.)
 *
 * La causale della fattura si configura per TIPOLOGIA DI PAGAMENTO in
 * Contabilità → Causali. Qui resta il rimando, e questo blocco è ciò che impedisce
 * al campo di tornare: due verità su dove si scrive una causale sono peggio di una
 * verità sbagliata, perché la seconda è quella che sembra funzionare.
 */
describe('SettingsPanel — il campo unico «Causale fattura» non esiste più', () => {
    it('a schermo non c\'è più un campo modificabile, ma il rimando al pannello giusto', async () => {
        render(<SettingsPanel userId={USER} scuolaId={SEDE_A} />)
        await bottoniSalva()

        // Il valore di fabbrica del vecchio campo arriva ancora dalla GET (la colonna
        // esiste in tabella): se un input lo mostrasse, sarebbe di nuovo modificabile.
        expect(screen.queryByDisplayValue('{descrizione} - {alunno}')).toBeNull()
        expect(screen.queryByPlaceholderText('{descrizione} - {alunno}')).toBeNull()

        const rimando = screen.getByRole('link', { name: itSettings.spCausaleFatturaVaiAlPannello })
        expect(rimando.getAttribute('href')).toContain('vista=causali')
    })

    it('nessuna PATCH del pannello porta più `fattura_causale_template`', async () => {
        render(<SettingsPanel userId={USER} scuolaId={SEDE_A} />)
        // Il bottone si prende DENTRO la sezione «Retta e morosità»: è quel `save()`
        // che spediva il campo, e pescare a indice fra i sei pannelli sceglierebbe
        // quello sbagliato appena ne nasce un altro.
        const sezione = (await screen.findByText(itSettings.spRettaMorosita)).closest('section') as HTMLElement
        fireEvent.click(within(sezione).getByRole('button', { name: new RegExp(itSettings.salva, 'i') }))

        const corpiPatch = () => fetchMock.mock.calls
            .filter(([, init]) => (init as { method?: string } | undefined)?.method === 'PATCH')
            .map(([, init]) => JSON.parse(String((init as { body?: string }).body)) as Record<string, unknown>)

        // Si aspetta proprio la PATCH della retta: è quella che portava il campo, e
        // asserire su un elenco ancora vuoto renderebbe il test verde per finta.
        await waitFor(() => expect(corpiPatch().some((c) => 'retta_default_importo' in c)).toBe(true))
        expect(JSON.stringify(corpiPatch())).not.toContain('fattura_causale_template')
    })
})

describe('SettingsPanel — i18n', () => {
    it('adminSettings: it ed en espongono lo stesso set di chiavi', () => {
        expect(Object.keys(itSettings).sort()).toEqual(Object.keys(enSettings).sort())
    })
})
