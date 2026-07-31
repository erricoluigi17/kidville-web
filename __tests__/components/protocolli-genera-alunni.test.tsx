import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import itAltro from '../../messages/it/adminAltro.json'
import enAltro from '../../messages/en/adminAltro.json'

// =============================================================================
// W3-F / R77 — «Genera documento»: la tendina alunni è vuota DA SEMPRE.
//
// Il client faceva `const lista = (j.data ?? j.students ?? []) as Alunno[]`,
// mentre `GET /api/admin/students` termina con `return NextResponse.json(data)`
// — un ARRAY NUDO (e `withRoute` restituisce la Response invariata, non
// incapsula niente). Su un array `j.data` e `j.students` sono `undefined`,
// quindi `lista` era sempre `[]`, `Array.isArray([])` passava, e il pannello
// mostrava «Nessun alunno» per sempre: non si poteva generare un documento
// protocollato intestato a un minore, e il `catch` muto rendeva il guasto
// indistinguibile da «non ci sono alunni».
//
// Si asserisce ciò che l'operatore vede: il bambino nella lista quando il
// server risponde, e un messaggio DIVERSO quando la lettura fallisce.
// =============================================================================

const USER = 'aaaabbbb-1111-4111-8111-ffffffffffff'

const h = vi.hoisted(() => ({ logClient: vi.fn() }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: () => 'Error' }))
vi.mock('@/lib/auth/use-session-identity', () => ({
    useSessionIdentity: () => ({ userId: USER, role: 'admin', ready: true }),
}))
vi.mock('@/lib/context/admin-identity', () => ({
    useAdminIdentity: () => ({ userId: USER, ruolo: 'admin', withUser: (h2: string) => h2 }),
}))

import ProtocolliPage from '@/app/(dashboard)/admin/protocolli/page'

/** La forma REALE della risposta di /api/admin/students: un array nudo. */
const ALUNNI = [
    { id: 'alu-1', nome: 'Ada', cognome: 'Verdi', classe_sezione: '3 ANNI' },
    { id: 'alu-2', nome: 'Bruno', cognome: 'Rossi', classe_sezione: '2 ANNI' },
]

const fetchMock = vi.fn()
/** Risposta di /api/admin/students: la decide ogni test. */
let rispostaStudents: { ok: boolean; status: number; body: unknown } = { ok: true, status: 200, body: ALUNNI }

beforeEach(() => {
    vi.clearAllMocks()
    rispostaStudents = { ok: true, status: 200, body: ALUNNI }
    fetchMock.mockImplementation((url: string) => {
        const u = String(url)
        if (u.includes('/api/admin/students')) {
            return Promise.resolve({ ok: rispostaStudents.ok, status: rispostaStudents.status, json: async () => rispostaStudents.body })
        }
        if (u.includes('/api/admin/protocolli/categorie')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: [] }) })
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: [], stats: null }) })
    })
    vi.stubGlobal('fetch', fetchMock)
})

async function apriGeneraDocumento() {
    render(<ProtocolliPage />)
    const bottone = await screen.findByRole('button', { name: new RegExp(itAltro.protBtnGenera, 'i') })
    fireEvent.click(bottone)
}

describe('Protocolli → Genera documento — la lista alunni', () => {
    it('l\'array nudo del server popola davvero la tendina', async () => {
        await apriGeneraDocumento()
        await waitFor(() => expect(screen.getByText('Verdi Ada')).toBeInTheDocument())
        expect(screen.getByText('Rossi Bruno')).toBeInTheDocument()
        expect(screen.queryByText(itAltro.protNessunAlunno)).not.toBeInTheDocument()
    })

    it('lettura fallita: messaggio ESPLICITO e log — non «non ci sono alunni»', async () => {
        rispostaStudents = { ok: false, status: 403, body: { error: 'Accesso negato' } }
        await apriGeneraDocumento()

        await waitFor(() => expect(screen.getByText(itAltro.protAlunniNonCaricati)).toBeInTheDocument())
        // Il messaggio del vuoto legittimo NON deve comparire: sono due cose diverse.
        expect(screen.queryByText(itAltro.protNessunAlunno)).not.toBeInTheDocument()
        expect(h.logClient).toHaveBeenCalledWith(
            expect.objectContaining({ livello: 'error', evento: 'fetch', stato: 403 }),
        )
    })

    it('nessun alunno davvero: resta il messaggio del vuoto, senza log d\'errore', async () => {
        rispostaStudents = { ok: true, status: 200, body: [] }
        await apriGeneraDocumento()

        await waitFor(() => expect(screen.getByText(itAltro.protNessunAlunno)).toBeInTheDocument())
        expect(screen.queryByText(itAltro.protAlunniNonCaricati)).not.toBeInTheDocument()
        expect(h.logClient).not.toHaveBeenCalled()
    })
})

describe('Protocolli — i18n', () => {
    it('la chiave nuova esiste in ENTRAMBI i cataloghi', () => {
        expect(itAltro).toHaveProperty('protAlunniNonCaricati')
        expect(enAltro).toHaveProperty('protAlunniNonCaricati')
    })

    it('adminAltro: it ed en espongono lo stesso set di chiavi', () => {
        expect(Object.keys(itAltro).sort()).toEqual(Object.keys(enAltro).sort())
    })
})
