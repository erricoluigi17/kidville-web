import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

import itAdmin from '../../messages/it/adminComunicazioni.json'
import enAdmin from '../../messages/en/adminComunicazioni.json'
import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'

/**
 * F4 — /admin/avvisi, colonna «Destinatari»: uuid grezzi a schermo.
 *
 * `target_classes` è ETEROGENEO. `AvvisoForm` salva i NOMI, ma alcuni record in
 * produzione contengono l'ID della sezione (due avvisi, misurati il 2026-07-31),
 * e la tabella faceva `(a.target_classes ?? []).join(', ')`: l'uuid finiva
 * stampato dov'era attesa una classe. Per chi legge non è «un dettaglio
 * tecnico»: è una riga che non dice a chi è andato l'avviso.
 *
 * E con tre sedi il solo NOME non basta più: «2 ANNI» esiste ad Aversa e a Cesa.
 * Quando i plessi sono più d'uno l'etichetta porta la sede — ma solo quando la
 * sede è DAVVERO deducibile: un nome omonimo in due plessi non si attribuisce a
 * uno dei due tirando a indovinare, che è esattamente l'errore che tutto questo
 * audit sta chiudendo.
 */

const USER = 'aaaabbbb-1111-4111-8111-cccccccccccc'
const SEZ_A_2ANNI = 'aaaa2222-0000-4000-8000-000000000001'
const SEZ_A_3ANNI = 'aaaa3333-0000-4000-8000-000000000002'
const SEZ_B_2ANNI = 'bbbb2222-0000-4000-8000-000000000003'
const SEZ_FANTASMA = 'ffff0000-0000-4000-8000-00000000000f'

const h = vi.hoisted(() => ({ logClient: vi.fn(), push: vi.fn() }))

vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: () => 'Error' }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: h.push }) }))
vi.mock('@/lib/auth/use-session-identity', () => ({
    useSessionIdentity: () => ({ userId: USER, role: 'admin', ready: true }),
}))

const DUE_SEDI = {
    success: true,
    data: [
        {
            scuolaId: SEDE_A, scuolaNome: NOME_SEDE_A,
            sezioni: [
                { id: SEZ_A_2ANNI, name: '2 ANNI', school_type: 'nido' },
                { id: SEZ_A_3ANNI, name: '3 ANNI A', school_type: 'infanzia' },
            ],
        },
        {
            scuolaId: SEDE_B, scuolaNome: NOME_SEDE_B,
            // Omonima di quella della sede A: la trappola del nome-classe.
            sezioni: [{ id: SEZ_B_2ANNI, name: '2 ANNI', school_type: 'nido' }],
        },
    ],
}

const UNA_SEDE = {
    success: true,
    data: [{ scuolaId: SEDE_A, scuolaNome: NOME_SEDE_A, sezioni: [{ id: SEZ_A_3ANNI, name: '3 ANNI A', school_type: 'infanzia' }] }],
}

function avviso(target_classes: string[] | null) {
    return {
        id: 'avv-1', author_id: USER, titolo: 'Uscita didattica', contenuto: '…',
        tipo: 'presa_visione', target_scope: 'classe', target_classes,
        scadenza: null, attachment_url: null, created_at: '2026-07-30T10:00:00Z',
        author: { first_name: 'A', last_name: 'B', role: 'admin' },
        stats: { letti: 0, adesioni_si: 0, adesioni_no: 0 },
    }
}

const fetchMock = vi.fn()
let scoped: unknown = DUE_SEDI
let classi: string[] | null = null

beforeEach(() => {
    vi.clearAllMocks()
    scoped = DUE_SEDI
    classi = null
    fetchMock.mockImplementation((url: string) => {
        const u = String(url)
        if (u.includes('/api/admin/sections/scoped')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => scoped })
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => [avviso(classi)] })
    })
    vi.stubGlobal('fetch', fetchMock)
})

import AdminAvvisiPage from '@/app/(dashboard)/admin/avvisi/page'

/** La cella «Destinatari» dell'unica riga. */
async function cellaDestinatari(): Promise<HTMLElement> {
    render(<AdminAvvisiPage />)
    await waitFor(() => expect(screen.getByText('Uscita didattica')).toBeInTheDocument())
    const riga = screen.getByText('Uscita didattica').closest('tr')!
    return riga.querySelectorAll('td')[2] as HTMLElement
}

describe('/admin/avvisi — la colonna Destinatari non stampa uuid', () => {
    it('un ID di sezione diventa «nome — sede», e l\'uuid NON compare a schermo', async () => {
        classi = [SEZ_B_2ANNI]
        const cella = await cellaDestinatari()

        expect(cella.textContent).toBe(`2 ANNI — ${NOME_SEDE_B}`)
        expect(cella.textContent).not.toContain(SEZ_B_2ANNI)
        // L'uuid resta disponibile per il supporto, senza essere letto da nessuno.
        expect(cella.querySelector(`[title="${SEZ_B_2ANNI}"]`)).toBeTruthy()
    })

    it('un NOME univoco fra le sedi porta la sua sede', async () => {
        classi = ['3 ANNI A']
        const cella = await cellaDestinatari()
        expect(cella.textContent).toBe(`3 ANNI A — ${NOME_SEDE_A}`)
    })

    it('un NOME omonimo in due plessi NON si attribuisce a nessuno dei due', async () => {
        classi = ['2 ANNI']
        const cella = await cellaDestinatari()
        // Niente «— Kidville Alfa»: sarebbe indovinare, ed è la causa radice
        // dell'intero audit. Si dice il nome, che è tutto ciò che si sa.
        expect(cella.textContent).toBe('2 ANNI')
    })

    it('con UNA sola sede la sede non si ripete su ogni riga', async () => {
        scoped = UNA_SEDE
        classi = [SEZ_A_3ANNI]
        const cella = await cellaDestinatari()
        expect(cella.textContent).toBe('3 ANNI A')
    })

    it('una sezione cancellata: etichetta neutra, mai l\'uuid', async () => {
        classi = [SEZ_FANTASMA]
        const cella = await cellaDestinatari()
        expect(cella.textContent).toBe(itAdmin.avvisiClasseSconosciuta)
        expect(cella.textContent).not.toContain(SEZ_FANTASMA)
        expect(cella.querySelector(`[title="${SEZ_FANTASMA}"]`)).toBeTruthy()
    })

    it('più voci miste: id + nome, separate da virgola', async () => {
        classi = [SEZ_A_2ANNI, '3 ANNI A']
        const cella = await cellaDestinatari()
        expect(cella.textContent).toBe(`2 ANNI — ${NOME_SEDE_A}, 3 ANNI A — ${NOME_SEDE_A}`)
    })

    it('avviso globale: resta «tutto l\'istituto»', async () => {
        classi = null
        fetchMock.mockImplementation((url: string) => {
            const u = String(url)
            if (u.includes('/api/admin/sections/scoped')) {
                return Promise.resolve({ ok: true, status: 200, json: async () => DUE_SEDI })
            }
            return Promise.resolve({
                ok: true, status: 200,
                json: async () => [{ ...avviso(null), target_scope: 'globale' }],
            })
        })
        const cella = await cellaDestinatari()
        expect(cella.textContent).toBe(itAdmin.avvisiTuttoIstituto)
    })
})

describe('/admin/avvisi — i18n della colonna', () => {
    it('la chiave dell\'etichetta neutra esiste in ENTRAMBI i cataloghi', () => {
        expect(itAdmin).toHaveProperty('avvisiClasseSconosciuta')
        expect(enAdmin).toHaveProperty('avvisiClasseSconosciuta')
    })
})
