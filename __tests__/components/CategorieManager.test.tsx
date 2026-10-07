import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { axe, toHaveNoViolations } from 'jest-axe'

import itSettings from '../../messages/it/adminSettings.json'
import { SEDE_A } from '../fixtures/sedi'

expect.extend(toHaveNoViolations)

// =============================================================================
// T8 — Impostazioni → Categorie pagamento: «Mensile» + importo predefinito.
// La sede va in OGNI chiamata (con più sedi la route risponde 400 senza), e un
// database non migrato non manda le chiavi `mensile`: vale «non mensile».
// =============================================================================

const USER = 'aaaabbbb-1111-4111-8111-dddddddddddd'
const h = vi.hoisted(() => ({ logClient: vi.fn() }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: () => 'Error' }))

import { CategorieManager } from '@/components/features/admin/settings/CategorieManager'

const RETTA = { id: '11111111-1111-4111-8111-111111111111', nome: 'Retta', slug: 'retta', icona: '🏫', is_sistema: true, ordine: 1, mensile: false }
const POMER = { id: '22222222-2222-4222-8222-222222222222', nome: 'Pomeridiano', slug: 'pomeridiano', icona: '🕓', is_sistema: false, ordine: 6, mensile: true, importo_mensile_default: 80 }
const DIVISA = { id: '33333333-3333-4333-8333-333333333333', nome: 'Divisa', slug: 'divisa', icona: '👕', is_sistema: false, ordine: 4, mensile: false, importo_mensile_default: null }

const fetchMock = vi.fn()
let elenco: unknown[] = []
let rispostaPatch: { ok: boolean; status: number; body: unknown } = { ok: true, status: 200, body: { success: true } }

function chiamate(metodo: string) {
    return fetchMock.mock.calls.filter(([, init]) => (init?.method ?? 'GET') === metodo)
}

beforeEach(() => {
    vi.clearAllMocks()
    elenco = [RETTA, POMER, DIVISA]
    rispostaPatch = { ok: true, status: 200, body: { success: true } }
    fetchMock.mockImplementation((_url: string, init?: { method?: string }) => {
        if (init?.method === 'PATCH') {
            return Promise.resolve({ ok: rispostaPatch.ok, status: rispostaPatch.status, json: async () => rispostaPatch.body })
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: elenco }) })
    })
    vi.stubGlobal('fetch', fetchMock)
})

async function monta() {
    const r = render(<CategorieManager userId={USER} scuolaId={SEDE_A} />)
    await screen.findByText(/Pomeridiano/)
    return r
}
const riga = (nome: RegExp) => screen.getByText(nome).closest('li') as HTMLElement

describe('CategorieManager — servizi mensili', () => {
    it('mostra il badge Mensile solo sulle categorie mensili', async () => {
        await monta()
        expect(within(riga(/Pomeridiano/)).getByTestId('badge-mensile')).toHaveTextContent(itSettings.catMensile)
        expect(within(riga(/Divisa/)).queryByTestId('badge-mensile')).toBeNull()
    })

    it('spuntare Mensile mostra l’importo predefinito', async () => {
        await monta()
        const r = riga(/Divisa/)
        expect(within(r).queryByLabelText(itSettings.catImportoMensile)).toBeNull()
        fireEvent.click(within(r).getByRole('checkbox', { name: itSettings.catMensile }))
        expect(within(r).getByLabelText(itSettings.catImportoMensile)).toBeTruthy()
    })

    it('Salva manda la PATCH con id, sede, mensile e importo', async () => {
        await monta()
        const r = riga(/Divisa/)
        fireEvent.click(within(r).getByRole('checkbox', { name: itSettings.catMensile }))
        fireEvent.change(within(r).getByLabelText(itSettings.catImportoMensile), { target: { value: '45.5' } })
        fireEvent.click(within(r).getByRole('button', { name: itSettings.catSalva }))
        await waitFor(() => expect(chiamate('PATCH')).toHaveLength(1))
        expect(JSON.parse(chiamate('PATCH')[0][1].body)).toEqual({
            id: DIVISA.id, scuola_id: SEDE_A, mensile: true, importo_mensile_default: 45.5,
        })
        expect(await screen.findByRole('status')).toHaveTextContent(itSettings.catSalvata)
    })

    it('importo vuoto → null', async () => {
        await monta()
        const r = riga(/Divisa/)
        fireEvent.click(within(r).getByRole('checkbox', { name: itSettings.catMensile }))
        fireEvent.click(within(r).getByRole('button', { name: itSettings.catSalva }))
        await waitFor(() => expect(chiamate('PATCH')).toHaveLength(1))
        expect(JSON.parse(chiamate('PATCH')[0][1].body).importo_mensile_default).toBeNull()
    })

    it('togliere Mensile chiede conferma; Annulla non manda nulla, Conferma sì', async () => {
        await monta()
        const r = riga(/Pomeridiano/)
        fireEvent.click(within(r).getByRole('checkbox', { name: itSettings.catMensile }))
        fireEvent.click(within(r).getByRole('button', { name: itSettings.catSalva }))
        expect(within(r).getByRole('alert')).toHaveTextContent(itSettings.catTogliMensileAvviso)
        fireEvent.click(within(r).getByRole('button', { name: itSettings.catAnnulla }))
        expect(chiamate('PATCH')).toHaveLength(0)
        fireEvent.click(within(r).getByRole('button', { name: itSettings.catSalva }))
        fireEvent.click(within(r).getByRole('button', { name: itSettings.catConferma }))
        await waitFor(() => expect(chiamate('PATCH')).toHaveLength(1))
        expect(JSON.parse(chiamate('PATCH')[0][1].body)).toMatchObject({ id: POMER.id, mensile: false, importo_mensile_default: null })
    })

    it('la categoria di sistema non ha controlli', async () => {
        await monta()
        const r = riga(/Retta/)
        expect(within(r).queryByRole('checkbox')).toBeNull()
        expect(within(r).queryByRole('button')).toBeNull()
    })

    it('503 con codice → messaggio «non disponibile» e riga di log col solo stato', async () => {
        rispostaPatch = { ok: false, status: 503, body: { error: 'x', codice: 'SERVIZI_NON_DISPONIBILI' } }
        await monta()
        const r = riga(/Divisa/)
        fireEvent.click(within(r).getByRole('checkbox', { name: itSettings.catMensile }))
        fireEvent.click(within(r).getByRole('button', { name: itSettings.catSalva }))
        expect(await screen.findByRole('alert')).toHaveTextContent(/non sono ancora disponibili/)
        expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', stato: 503 }))
    })

    it('403 della route: mostra il messaggio del server', async () => {
        rispostaPatch = { ok: false, status: 403, body: { error: 'Categoria fuori dal tuo plesso' } }
        await monta()
        const r = riga(/Divisa/)
        fireEvent.click(within(r).getByRole('checkbox', { name: itSettings.catMensile }))
        fireEvent.click(within(r).getByRole('button', { name: itSettings.catSalva }))
        expect(await screen.findByRole('alert')).toHaveTextContent('Categoria fuori dal tuo plesso')
    })

    it('rete morta: errore a schermo e log', async () => {
        await monta()
        fetchMock.mockImplementation((_u: string, init?: { method?: string }) => init?.method === 'PATCH'
            ? Promise.reject(new Error('rete'))
            : Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: elenco }) }))
        const r = riga(/Divisa/)
        fireEvent.click(within(r).getByRole('checkbox', { name: itSettings.catMensile }))
        fireEvent.click(within(r).getByRole('button', { name: itSettings.catSalva }))
        expect(await screen.findByRole('alert')).toHaveTextContent(itSettings.erroreSalvataggio)
        expect(h.logClient).toHaveBeenCalled()
    })

    it('DB non migrato (nessuna chiave mensile) → non mensile, senza badge', async () => {
        elenco = [{ id: DIVISA.id, nome: 'Divisa', is_sistema: false, ordine: 4 }]
        render(<CategorieManager userId={USER} scuolaId={SEDE_A} />)
        const r = (await screen.findByText(/Divisa/)).closest('li') as HTMLElement
        expect(within(r).queryByTestId('badge-mensile')).toBeNull()
        expect((within(r).getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    })

    it('la sede è passata in GET, POST, PATCH e DELETE', async () => {
        await monta()
        expect(String(chiamate('GET')[0][0])).toContain(`scuola_id=${SEDE_A}`)
        fireEvent.change(screen.getByPlaceholderText(itSettings.nuovaCategoriaPlaceholder), { target: { value: 'Pulmino' } })
        fireEvent.click(screen.getByRole('button', { name: new RegExp(itSettings.aggiungi) }))
        await waitFor(() => expect(chiamate('POST')).toHaveLength(1))
        expect(JSON.parse(chiamate('POST')[0][1].body)).toMatchObject({ nome: 'Pulmino', scuola_id: SEDE_A })
        fireEvent.click(within(riga(/Divisa/)).getByRole('button', { name: new RegExp(itSettings.spEliminaCategoria) }))
        await waitFor(() => expect(chiamate('DELETE')).toHaveLength(1))
        expect(String(chiamate('DELETE')[0][0])).toContain(`scuola_id=${SEDE_A}`)
    })

    it('axe non trova violazioni', async () => {
        const { container } = await monta()
        fireEvent.click(within(riga(/Pomeridiano/)).getByRole('checkbox', { name: itSettings.catMensile }))
        fireEvent.click(within(riga(/Pomeridiano/)).getByRole('button', { name: itSettings.catSalva }))
        expect(await axe(container, { rules: { region: { enabled: false } } })).toHaveNoViolations()
    })
})
