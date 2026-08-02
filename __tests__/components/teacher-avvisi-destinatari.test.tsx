import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'

import itAvvisi from '../../messages/it/avvisi.json'
import enAvvisi from '../../messages/en/avvisi.json'
import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'

/**
 * iOS F4 — /teacher/avvisi: la bacheca del docente stampava l'uuid della sezione.
 *
 * Il collaudo del 2026-07-31 ha fotografato due card su cinque con come
 * destinatario `219cab6a-…` (l'ID di «TEST Infanzia»), mentre il cockpit, sugli
 * STESSI avvisi, diceva «TEST Infanzia». Due letture dello stesso campo, e la
 * più povera era quella sotto gli occhi di chi non può correggerla.
 *
 * Il gemello `admin-avvisi-destinatari` copre la tabella del cockpit; questo
 * copre la bacheca — cioè il punto in cui il difetto è stato misurato. Non è un
 * doppione: dimostra che la card riceve DAVVERO le sezioni del docente
 * (`/api/educator-sections`, che porta id, nome e sede). Un `AvvisoCard`
 * corretto ma senza fonte collegata mostrerebbe ancora «classe non disponibile».
 *
 * METODO: si asserisce sul TESTO RESO della pagina montata (la mutazione), e
 * ogni negativa ha accanto la positiva che cadrebbe per prima.
 */

const DOCENTE = 'dddddddd-1111-4111-8111-eeeeeeeeeeee'
const SEZ_INFANZIA = '11111111-2222-4333-8444-555555555555'
const SEZ_1A = 'aaaa1111-0000-4000-8000-00000000000a'
const SEZ_B_2ANNI = 'bbbb2222-0000-4000-8000-00000000000b'
const SEZ_FANTASMA = 'ffff0000-0000-4000-8000-00000000000f'

const h = vi.hoisted(() => ({ logClient: vi.fn() }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: () => 'Error' }))
vi.mock('@/lib/auth/use-session-identity', () => ({
    useSessionIdentity: () => ({ userId: DOCENTE, role: 'educator', ready: true }),
}))

/** La risposta di `/api/educator-sections`: identità + sede, non i soli nomi. */
const UNA_SEDE = {
    role: 'educator',
    sections: [
        { id: SEZ_INFANZIA, name: 'TEST Infanzia', scuolaId: SEDE_A, scuolaNome: NOME_SEDE_A },
        { id: SEZ_1A, name: 'TEST 1A', scuolaId: SEDE_A, scuolaNome: NOME_SEDE_A },
    ],
}

const DUE_SEDI = {
    role: 'admin',
    sections: [
        ...UNA_SEDE.sections,
        { id: SEZ_B_2ANNI, name: '2 ANNI', scuolaId: SEDE_B, scuolaNome: NOME_SEDE_B },
    ],
}

function avviso(target_classes: string[] | null) {
    return {
        id: 'avv-1', author_id: DOCENTE, titolo: 'Gita al parco', contenuto: 'Si parte alle 9.',
        tipo: 'presa_visione', target_scope: 'classe', target_classes,
        scadenza: null, attachment_url: null, created_at: '2026-07-31T08:00:00Z',
        author: { first_name: 'A', last_name: 'B', role: 'educator' },
        stats: { letti: 0, adesioni_si: 0, adesioni_no: 0 },
    }
}

const fetchMock = vi.fn()
let sezioni: unknown = UNA_SEDE
let classi: string[] | null = null

beforeEach(() => {
    vi.clearAllMocks()
    sezioni = UNA_SEDE
    classi = null
    fetchMock.mockImplementation((url: string) => {
        const u = String(url)
        if (u.includes('/api/educator-sections')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => sezioni })
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => [avviso(classi)] })
    })
    vi.stubGlobal('fetch', fetchMock)
})

afterEach(cleanup)

import TeacherAvvisiPage from '@/app/(dashboard)/teacher/avvisi/page'

/** La card dell'unico avviso, montata la pagina vera. */
async function cardAvviso(): Promise<HTMLElement> {
    render(<TeacherAvvisiPage />)
    await waitFor(() => expect(screen.getByText('Gita al parco')).toBeInTheDocument())
    return screen.getByText('Gita al parco').closest('div.overflow-hidden') as HTMLElement
}

describe('/teacher/avvisi — la bacheca non stampa uuid (iOS F4)', () => {
    it('un ID di sezione diventa il NOME della classe', async () => {
        classi = [SEZ_INFANZIA]
        const card = await cardAvviso()

        // Positiva: la pill dice la classe, esattamente come il cockpit.
        expect(card.textContent).toContain('TEST Infanzia')
        // Negative: l'uuid non è a schermo né in un attributo.
        expect(card.textContent).not.toContain(SEZ_INFANZIA)
        expect(card.innerHTML).not.toContain(SEZ_INFANZIA)
    })

    it('con più sedi la pill porta anche il plesso', async () => {
        sezioni = DUE_SEDI
        classi = [SEZ_B_2ANNI]
        const card = await cardAvviso()

        expect(card.textContent).toContain(`2 ANNI — ${NOME_SEDE_B}`)
        expect(card.innerHTML).not.toContain(SEZ_B_2ANNI)
    })

    it('una sezione non più in elenco: etichetta neutra, mai l\'uuid', async () => {
        classi = [SEZ_FANTASMA]
        const card = await cardAvviso()

        expect(card.textContent).toContain(itAvvisi.classeSconosciuta)
        expect(card.innerHTML).not.toContain(SEZ_FANTASMA)
    })

    it('un nome di classe già leggibile resta invariato (controllo positivo)', async () => {
        classi = ['TEST 1A']
        const card = await cardAvviso()

        expect(card.textContent).toContain('TEST 1A')
    })
})

describe('/teacher/avvisi — i18n dell\'etichetta neutra', () => {
    it('la chiave esiste in ENTRAMBI i cataloghi', () => {
        expect(itAvvisi).toHaveProperty('classeSconosciuta')
        expect(enAvvisi).toHaveProperty('classeSconosciuta')
    })
})
