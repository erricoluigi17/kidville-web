import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * IL CORPO CHE PARTE DAVVERO VERSO `PATCH /api/admin/parents`.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ PERCHÉ QUESTO FILE ESISTE, e perché i 66 test della corsia non bastavano.
 * Tutti gli altri montano `ParentDetailPanel` con un `onSave` finto e un genitore
 * INVENTATO dal test: undici campi piatti, nessuna relazione. Ma la scheda si
 * riempie con la risposta di `GET /api/admin/parents/[id]`, che seleziona `*`
 * **più la relazione annidata `student_parents`** (con dentro gli `alunni` e i
 * co-genitori). Fino all'11 agosto `handleSave` faceva `onSave({ id, ...form })`:
 * quel fascicolo intero finiva nel corpo del PATCH, lo schema `.loose()` lo
 * lasciava passare, e `update()` lo spalmava. PostgREST valida il corpo contro la
 * propria cache dello schema PRIMA di parlare col database, e rispondeva
 * **`PGRST204`** — «Could not find the 'student_parents' column of 'parents' in
 * the schema cache» — perché `student_parents` è una TABELLA, non una colonna.
 *
 * LE DUE MISURE IN PRODUZIONE (11 agosto), che non sono un'ipotesi:
 *  · `app_log` → `route=/api/admin/parents`, `codice=PGRST204`, `stato_http=400`,
 *    con quel messaggio esatto, e la riga `admin/parents:PATCH` a 500 accanto;
 *  · `audit_scritture_docente` — dove `logScrittura` scrive SOLO dopo che
 *    l'`update` è riuscito — ha 405 righe dal 5 luglio, 255 delle quali `update`,
 *    e **nessuna** con `entita_tipo='genitori'` e `azione='update'`. Cinque
 *    `insert`, zero aggiornamenti: da questa scheda non si è mai salvato niente.
 *
 * Quindi qui il genitore non lo inventa il test: è la FORMA vera del GET, con la
 * relazione annidata e le colonne che la scheda non mostra. E non si guarda che
 * cosa la scheda «voleva» mandare: si legge il `body` della fetch.
 *
 * ⚠️ REPOSITORY PUBBLICO: nessuna persona vera, nessun codice fiscale con
 * checksum valida.
 */

const ID_GENITORE = '00000000-0000-4000-8000-000000000001'
const ID_ALUNNO = '00000000-0000-4000-8000-0000000000a1'
const ID_COGENITORE = '00000000-0000-4000-8000-000000000002'

const h = vi.hoisted(() => ({ push: vi.fn(), logClient: vi.fn() }))

vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: () => 'Error' }))
vi.mock('next/navigation', () => ({
    useParams: () => ({ id: ID_GENITORE }),
    useSearchParams: () => new URLSearchParams('kind=adult'),
    useRouter: () => ({ push: h.push, refresh: vi.fn() }),
    usePathname: () => `/admin/students/${ID_GENITORE}`,
}))

import AnagraficaDetailPage from '@/app/(dashboard)/admin/students/[id]/page'

/**
 * LA FORMA VERA della risposta di `GET /api/admin/parents/[id]`: `select('*')` più
 * l'embed a due livelli. Le colonne che la scheda non mostra ci sono lo stesso —
 * `auth_user_id`, `created_at`, `documento_path` — perché `*` le porta, ed erano
 * fra quelle che il vecchio `...form` rispediva al server.
 */
const FASCICOLO = {
    id: ID_GENITORE,
    first_name: 'Prova',
    last_name: 'Esempio',
    gender: 'F',
    birth_date: '1985-03-07',
    birth_city: 'NAPOLI',
    birth_province: 'NA',
    birth_nation: 'Italia',
    codice_belfiore_nascita: 'H501',
    fiscal_code: 'AAAAAA00A00A000A',
    emails: ['prova@example.invalid'],
    phone_numbers: ['0000000000'],
    residence_address: 'Via di Prova',
    residence_street_number: '1',
    residence_city: 'NAPOLI',
    residence_province: 'NA',
    zip_code: '80100',
    citizenship: 'Italiana',
    // Colonne che la scheda NON mostra, e che `select('*')` porta comunque.
    auth_user_id: '00000000-0000-4000-8000-0000000000ff',
    created_at: '2026-07-05T10:00:00.000Z',
    intestatario_default: false,
    document_type: null,
    document_number: null,
    documento_path: null,
    consensi_gdpr: null,
    // ⚠️ LA RELAZIONE ANNIDATA: è questa che faceva rispondere PGRST204.
    student_parents: [
        {
            relation_type: 'mother',
            is_primary: true,
            alunni: {
                id: ID_ALUNNO,
                nome: 'Alunno',
                cognome: 'Esempio',
                classe_sezione: 'Girasoli',
                student_parents: [
                    {
                        relation_type: 'father',
                        is_primary: true,
                        parents: { id: ID_COGENITORE, first_name: 'Altro', last_name: 'Esempio' },
                    },
                ],
            },
        },
    ],
}

/** Le sole chiavi che possono comparire nel corpo del PATCH: `id` + colonne di `parents`. */
const COLONNE_AMMESSE = new Set([
    'id',
    'first_name',
    'last_name',
    'gender',
    'birth_date',
    'birth_city',
    'birth_province',
    'birth_nation',
    'codice_belfiore_nascita',
    'fiscal_code',
    'citizenship',
    'residence_address',
    'residence_street_number',
    'residence_city',
    'residence_province',
    'zip_code',
    'phone_numbers',
    'emails',
])

const corpiPatch: Array<Record<string, unknown>> = []

function fintaRete() {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/api/anagrafiche/comuni')) {
            return new Response(JSON.stringify({ comuni: [] }), { status: 200 })
        }
        if (url.includes(`/api/admin/parents/${ID_GENITORE}`)) {
            return new Response(JSON.stringify(FASCICOLO), { status: 200 })
        }
        if (url.includes('/api/admin/parents') && init?.method === 'PATCH') {
            corpiPatch.push(JSON.parse(String(init.body)))
            return new Response(JSON.stringify({ success: true }), { status: 200 })
        }
        return new Response('{"error":"non previsto"}', { status: 500 })
    })
}

const campoCf = () => screen.getByLabelText(/Codice Fiscale/)
const salva = () => screen.getByRole('button', { name: /Salva Modifiche/i })

async function montaESalva() {
    render(<AnagraficaDetailPage />)
    await waitFor(() => expect(campoCf()).toBeInTheDocument())
    fireEvent.click(salva())
    await waitFor(() => expect(corpiPatch).toHaveLength(1))
    return corpiPatch[0]
}

beforeEach(() => {
    corpiPatch.length = 0
    h.push.mockClear()
    h.logClient.mockClear()
    vi.unstubAllGlobals()
    vi.stubGlobal('fetch', fintaRete())
})

describe('il corpo del PATCH contiene SOLO colonne di `parents`', () => {
    it('la relazione annidata `student_parents` NON parte: era il PGRST204', async () => {
        const corpo = await montaESalva()
        expect(corpo).not.toHaveProperty('student_parents')
        // Nessun oggetto e nessun array di oggetti: solo scalari e array di stringhe.
        for (const [chiave, valore] of Object.entries(corpo)) {
            if (Array.isArray(valore)) {
                expect(valore.every((v) => typeof v === 'string'), `${chiave} contiene oggetti`).toBe(true)
            } else {
                expect(['string', 'number', 'boolean', 'object'], chiave).toContain(typeof valore)
                if (valore !== null) expect(typeof valore, chiave).not.toBe('object')
            }
        }
    })

    it('nessuna chiave estranea alle colonne che la scheda modifica', async () => {
        const corpo = await montaESalva()
        const estranee = Object.keys(corpo).filter((k) => !COLONNE_AMMESSE.has(k))
        expect(estranee).toEqual([])
        // Le colonne che `select('*')` porta ma che la scheda non tocca restano a casa:
        // rimandarle indietro significava riscrivere dati che nessuno aveva modificato.
        expect(corpo).not.toHaveProperty('auth_user_id')
        expect(corpo).not.toHaveProperty('created_at')
        expect(corpo).not.toHaveProperty('documento_path')
    })

    it('i valori dell’anagrafica arrivano interi: il corpo è più stretto, non più povero', async () => {
        const corpo = await montaESalva()
        expect(corpo.id).toBe(ID_GENITORE)
        expect(corpo.first_name).toBe('Prova')
        expect(corpo.last_name).toBe('Esempio')
        expect(corpo.gender).toBe('F')
        expect(corpo.birth_date).toBe('1985-03-07')
        expect(corpo.birth_city).toBe('NAPOLI')
        expect(corpo.birth_province).toBe('NA')
        expect(corpo.birth_nation).toBe('Italia')
        expect(corpo.codice_belfiore_nascita).toBe('H501')
        expect(corpo.fiscal_code).toBe('AAAAAA00A00A000A')
        expect(corpo.citizenship).toBe('Italiana')
        expect(corpo.residence_address).toBe('Via di Prova')
        expect(corpo.residence_street_number).toBe('1')
        expect(corpo.residence_city).toBe('NAPOLI')
        expect(corpo.residence_province).toBe('NA')
        expect(corpo.zip_code).toBe('80100')
        expect(corpo.phone_numbers).toEqual(['0000000000'])
        expect(corpo.emails).toEqual(['prova@example.invalid'])
    })

    it('la correzione digitata è quella che parte, e il vuoto parte come `null`', async () => {
        render(<AnagraficaDetailPage />)
        await waitFor(() => expect(campoCf()).toBeInTheDocument())

        fireEvent.change(campoCf(), { target: { value: 'BBBBBB00B00B000B' } })
        fireEvent.click(salva())
        await waitFor(() => expect(corpiPatch).toHaveLength(1))
        expect(corpiPatch[0].fiscal_code).toBe('BBBBBB00B00B000B')

        // E lo svuotamento: su `fiscal_code` (UNIQUE) `''` è un valore che collide con
        // l'unico genitore che in produzione ce l'ha già. Deve uscire `null`.
        fireEvent.change(campoCf(), { target: { value: '' } })
        fireEvent.click(salva())
        await waitFor(() => expect(corpiPatch).toHaveLength(2))
        expect(corpiPatch[1].fiscal_code).toBeNull()
    })

    it('svuotare la data di nascita manda `null`, non `\'\'`: su una colonna `date` è un errore di sintassi', async () => {
        render(<AnagraficaDetailPage />)
        await waitFor(() => expect(campoCf()).toBeInTheDocument())

        fireEvent.change(screen.getByLabelText(/Data di Nascita/i), { target: { value: '' } })
        fireEvent.click(salva())
        await waitFor(() => expect(corpiPatch).toHaveLength(1))
        expect(corpiPatch[0].birth_date).toBeNull()
    })

    it('col PATCH accettato la pagina conferma e torna all’elenco: la strada intera è verde', async () => {
        await montaESalva()
        await waitFor(() => expect(screen.getByText(/Anagrafica aggiornata con successo/)).toBeInTheDocument())
        expect(screen.queryByRole('alert')).toBeNull()
        await waitFor(() => expect(h.push).toHaveBeenCalled(), { timeout: 2000 })
    })
})
