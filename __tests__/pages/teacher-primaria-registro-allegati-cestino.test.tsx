import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'

import itPrimaria from '../../messages/it/teacherPrimaria.json'
import itShared from '../../messages/it/shared.json'

/**
 * LOCK · registro di classe della primaria: gli ALLEGATI (Rinomina, Sostituisci
 * file, Elimina) e il CESTINO della classe (spec 2026-09-24, compito R4).
 *
 *  · i comandi compaiono SOLO sugli allegati che la GET degli allegati dichiara
 *    `modificabile` — la regola è del server, la pagina non ne tiene una copia;
 *  · l'allegato oltre il termine mostra il blocco e, alla sola Direzione,
 *    «Sblocca» come voce `allegato`; l'avviso lo vede solo chi potrebbe agire
 *    (Direzione, Segreteria, autore), non la collega che non l'ha caricato;
 *  · «Elimina» chiede conferma e dice che l'allegato va nel cestino per 7 giorni;
 *  · il cestino elenca gli allegati coi giorni residui e «Ripristina»; con
 *    `LEZIONE_DA_RIFIRMARE` la VOCE dice che prima va rifirmata la lezione.
 *
 * Ogni caso guarda la RICHIESTA che parte (metodo, URL, corpo), non solo il bottone.
 */

const SEZIONE = 'sez-1'
const DOCENTE = 'doc-1'
const COLLEGA = 'doc-2'

const stub = vi.hoisted(() => ({
    params: { sectionId: 'sez-1' } as Record<string, string>,
    search: new URLSearchParams(),
}))

vi.mock('next/navigation', () => ({
    useParams: () => stub.params,
    useSearchParams: () => stub.search,
    usePathname: () => '/teacher/primaria/sez-1/registro',
    useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}))

vi.mock('@/lib/auth/current-teacher', () => ({ getCurrentTeacherId: () => DOCENTE }))

vi.mock('@/lib/offline/syncEngine', () => ({
    saveLocalRegistro: vi.fn(async () => {}),
    syncPendingRegistro: vi.fn(async () => {}),
}))

const logClientMock = vi.fn()
vi.mock('@/lib/logging/client', () => ({
    logClient: (...args: unknown[]) => logClientMock(...args),
    nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
}))

// Nomi inventati: il repository è pubblico.
const CAMPANELLE = [
    { id: 'camp-1', ordine: 1, ora_inizio: '08:30:00', ora_fine: '09:30:00', tipo: 'lezione' },
    { id: 'camp-2', ordine: 2, ora_inizio: '09:30:00', ora_fine: '10:30:00', tipo: 'lezione' },
]
const ORARIO_CELLE = [
    { campanella_id: 'camp-1', materia_id: 'mat-ita', materie: { nome: 'Italiano' } },
    { campanella_id: 'camp-2', materia_id: 'mat-ita', materie: { nome: 'Italiano' } },
]

/** 1ª ora con due allegati; 2ª ora scritta ma SENZA allegati. */
function righe() {
    const base = {
        materia: null, materia_id: 'mat-ita', compiti: null, data_consegna_compiti: null,
        materie: { nome: 'Italiano' }, registro_destinatari: [],
        firme_docenti: [{ id: 'firma-1', maestra_id: DOCENTE, tipo_compresenza: 'principale', argomento_proprio: null, compiti_propri: null, utenti: { nome: 'Ada', cognome: 'Prova' } }],
    }
    return [
        {
            ...base, id: 'reg-1', ora_lezione: 1, argomento: 'Le vocali',
            allegati_registro: [
                { id: 'all-1', ambito: 'argomento', tipo: 'pdf', file_url: 'reg-1/a.pdf', file_name: 'scheda.pdf' },
                { id: 'all-2', ambito: 'argomento', tipo: 'img', file_url: 'reg-1/b.jpg', file_name: 'lavagna.jpg' },
            ],
        },
        { ...base, id: 'reg-2', ora_lezione: 2, argomento: 'Le consonanti', allegati_registro: [] },
    ]
}

/** La GET degli allegati della lezione: permessi per voce, link firmati. */
function gestione(over: Record<string, Partial<{ modificabile: boolean; bloccata: boolean; giorniLimite: number | null; caricato_da: string | null }>> = {}) {
    const voce = (id: string, nome: string) => ({
        id, registro_id: 'reg-1', ambito: 'argomento', tipo: 'pdf', file_name: nome,
        file_url: `https://firmato.invalid/${id}`,
        modificabile: false, bloccata: false, giorniLimite: 2, caricato_da: COLLEGA,
        ...(over[id] ?? {}),
    })
    return { body: { success: true, data: [voce('all-1', 'scheda.pdf'), voce('all-2', 'lavagna.jpg')] } }
}

interface RispostaFinta { ok?: boolean; status?: number; body?: unknown; lancia?: boolean }
type Voce = [string, RispostaFinta | ((init?: RequestInit, url?: string) => RispostaFinta)]
let risposte: Voce[] = []
const chiamate: Array<{ url: string; init?: RequestInit }> = []

function rispostaPer(url: string, init?: RequestInit): RispostaFinta {
    const metodo = init?.method ?? 'GET'
    for (const [chiave, r] of risposte) {
        const [m, frammento] = chiave.includes(' ') ? chiave.split(' ') : [null, chiave]
        if ((m === null || m === metodo) && url.includes(frammento)) return typeof r === 'function' ? r(init, url) : r
    }
    return { ok: true, status: 200, body: { success: true, data: [] } }
}

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    chiamate.push({ url, init })
    const r = rispostaPer(url, init)
    if (r.lancia) throw new TypeError('Failed to fetch')
    return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.body } as unknown as Response
})

/**
 * Le risposte in ORDINE: il primo frammento che corrisponde vince, quindi le rotte
 * più lunghe (`/allegati/cestino`, `/allegati/sostituisci`) stanno prima di
 * `/api/primaria/allegati?`.
 */
function prepara(ruolo: string, extra: Voce[] = [], allegati: RispostaFinta = gestione()) {
    risposte = [
        ...extra,
        ['/api/primaria/sezioni', { body: { success: true, data: [{ id: SEZIONE, name: '1ª A' }] } }],
        ['GET /api/primaria/registro', {
            body: { success: true, data: { giorno: 1, campanelle: CAMPANELLE, orarioCelle: ORARIO_CELLE, righe: righe() } },
        }],
        ['GET /api/primaria/allegati?', allegati],
        ['/api/primaria/classe/', { body: { success: true, data: { alunni: [], materie: [{ id: 'mat-ita', nome: 'Italiano' }] } } }],
        ['/api/primaria/me', { body: { success: true, data: { userId: DOCENTE, gradi: ['primaria'], ruolo } } }],
    ]
}

const letture = () => chiamate.filter((c) => (c.init?.method ?? 'GET') === 'GET' && c.url.includes('/api/primaria/registro?')).length
const lettureAllegati = () => chiamate.filter((c) => (c.init?.method ?? 'GET') === 'GET' && c.url.includes('/api/primaria/allegati?'))
const lettureCestino = () => chiamate.filter((c) => (c.init?.method ?? 'GET') === 'GET' && c.url.includes('/api/primaria/allegati/cestino'))
const conMetodo = (metodo: string, frammento: string) => chiamate.filter((c) => c.init?.method === metodo && c.url.includes(frammento))

beforeEach(() => {
    vi.clearAllMocks()
    chiamate.length = 0
    stub.search = new URLSearchParams()
    vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
})

import RegistroPage from '@/app/(dashboard)/teacher/primaria/[sectionId]/registro/page'

/** Il registro a schermo, il ruolo arrivato e i permessi degli allegati letti. */
async function pronta() {
    await screen.findAllByText(itPrimaria.registroOra.replace('{ora}', '1'))
    await waitFor(() => expect(chiamate.some((c) => c.url.includes('/api/primaria/me'))).toBe(true))
    await waitFor(() => expect(lettureAllegati().length).toBeGreaterThan(0))
}

describe('i comandi sugli allegati seguono i permessi del SERVER', () => {
    it('solo l’allegato `modificabile` ha Rinomina, Sostituisci file ed Elimina; la GET parte solo per la lezione CON allegati', async () => {
        prepara('educator', [], gestione({ 'all-1': { modificabile: true } }))
        render(<RegistroPage />)
        await pronta()

        expect(await screen.findByRole('button', { name: 'Rinomina l’allegato «scheda.pdf»' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Sostituisci file dell’allegato «scheda.pdf»' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Elimina l’allegato «scheda.pdf»' })).toBeInTheDocument()
        // L'altro allegato non è di chi guarda: nessun comando, nessun blocco.
        const altro = screen.getByTestId('registro-allegato-all-2')
        expect(within(altro).queryAllByRole('button')).toHaveLength(0)
        expect(within(altro).queryByTestId('registro-allegato-bloccato')).toBeNull()

        const url = new URL(lettureAllegati()[0].url, 'http://x')
        expect(url.searchParams.get('registroId')).toBe('reg-1')
        expect(url.searchParams.get('userId')).toBe(DOCENTE)
        expect(
            lettureAllegati().some((c) => c.url.includes('registroId=reg-2')),
            'La lezione senza allegati non costa nessuna richiesta.',
        ).toBe(false)
        // Il link usa l'indirizzo FIRMATO della GET, non il percorso nudo dello Storage.
        expect(within(screen.getByTestId('registro-allegato-all-1')).getByRole('link').getAttribute('href')).toBe('https://firmato.invalid/all-1')
    })

    it('permessi non letti (500): nessun comando, e lo si dice', async () => {
        prepara('admin', [], { ok: false, status: 500, body: { error: 'x', codice: 'LETTURA_FALLITA' } })
        render(<RegistroPage />)
        await pronta()
        expect(await screen.findByTestId('registro-allegati-permessi-non-letti')).toHaveTextContent(itPrimaria.registroAllegatoPermessiNonLetti)
        expect(screen.queryByRole('button', { name: /allegato «scheda\.pdf»/ })).toBeNull()
        expect(logClientMock.mock.calls.some(([e]) => (e as { messaggio: string }).messaggio === 'registro-allegati-permessi-rifiutati')).toBe(true)
    })

    it('allegato oltre il termine: la maestra legge «chiedi lo sblocco» e non ha comandi', async () => {
        prepara('educator', [], gestione({ 'all-1': { bloccata: true, giorniLimite: 2, caricato_da: DOCENTE } }))
        render(<RegistroPage />)
        await pronta()
        const blocco = await screen.findByTestId('registro-allegato-bloccato')
        expect(blocco.textContent).toContain('Bloccata: superato il termine di 2 giorni.')
        expect(blocco.textContent).toContain(itPrimaria.registroChiediSblocco)
        expect(within(blocco).queryByRole('button')).toBeNull()
        expect(screen.queryByRole('button', { name: 'Elimina l’allegato «scheda.pdf»' })).toBeNull()
    })

    it('allegato oltre il termine caricato da una COLLEGA: alla maestra nessun avviso «chiedi lo sblocco», solo il link', async () => {
        // `bloccata` vale per chiunque guardi: dopo lo sblocco il server le
        // risponderebbe comunque 403 VOCE_NON_AUTORE, quindi l'avviso sarebbe falso.
        prepara('educator', [], gestione({ 'all-1': { bloccata: true, giorniLimite: 2, caricato_da: COLLEGA } }))
        render(<RegistroPage />)
        await pronta()
        const riga = screen.getByTestId('registro-allegato-all-1')
        // Si aspetta una PRESENZA (il link firmato = permessi letti) prima di guardare l'assenza.
        await waitFor(() => expect(within(riga).getByRole('link').getAttribute('href')).toBe('https://firmato.invalid/all-1'))
        expect(screen.queryByTestId('registro-allegato-bloccato')).toBeNull()
        expect(screen.queryByText(itPrimaria.registroChiediSblocco, { exact: false })).toBeNull()
        expect(within(riga).queryAllByRole('button')).toHaveLength(0)
    })

    it('allegato oltre il termine caricato da una collega: la Segreteria vede l’avviso (può agire dopo lo sblocco)', async () => {
        prepara('segreteria', [], gestione({ 'all-1': { bloccata: true, giorniLimite: 2, caricato_da: COLLEGA } }))
        render(<RegistroPage />)
        await pronta()
        const blocco = await screen.findByTestId('registro-allegato-bloccato')
        expect(blocco.textContent).toContain(itPrimaria.registroChiediSblocco)
        expect(within(screen.getByTestId('registro-allegato-all-1')).getByTestId('registro-allegato-bloccato')).toBe(blocco)
    })

    it('la Direzione sblocca l’allegato come VOCE `allegato`, e dopo i permessi si rileggono', async () => {
        prepara('admin', [['POST /api/primaria/sblocca', { body: { success: true } }]], gestione({ 'all-1': { bloccata: true } }))
        render(<RegistroPage />)
        await pronta()
        const blocco = await screen.findByTestId('registro-allegato-bloccato')
        expect(blocco.textContent).not.toContain(itPrimaria.registroChiediSblocco)
        const primaPermessi = lettureAllegati().length
        fireEvent.click(within(blocco).getByRole('button', { name: /Sblocca l’allegato «scheda\.pdf»/ }))
        fireEvent.change(await screen.findByLabelText(itPrimaria.sbloccaMotivo), { target: { value: 'Allegato sbagliato' } })
        fireEvent.click(screen.getByRole('button', { name: itPrimaria.sbloccaAutorizza }))
        await waitFor(() => expect(conMetodo('POST', '/api/primaria/sblocca')).toHaveLength(1))
        expect(JSON.parse(String(conMetodo('POST', '/api/primaria/sblocca')[0].init!.body))).toEqual({
            entitaTipo: 'allegato', entitaId: 'all-1', motivazione: 'Allegato sbagliato',
        })
        expect((await screen.findByTestId('registro-esito')).textContent).toBe('Allegato «scheda.pdf» sbloccato: ora puoi modificarlo o eliminarlo.')
        await waitFor(() => expect(lettureAllegati().length).toBeGreaterThan(primaPermessi))
    })
})

describe('«Rinomina»', () => {
    it('manda PATCH { id, nome } col nome ripulito; poi esito e rilettura', async () => {
        prepara('educator', [['PATCH /api/primaria/allegati', { body: { success: true, data: { id: 'all-1' } } }]], gestione({ 'all-1': { modificabile: true } }))
        render(<RegistroPage />)
        await pronta()
        fireEvent.click(await screen.findByRole('button', { name: 'Rinomina l’allegato «scheda.pdf»' }))
        const dialogo = await screen.findByTestId('registro-allegato-rinomina')
        const campo = within(dialogo).getByLabelText(itPrimaria.registroAllegatoNomeLabel) as HTMLInputElement
        expect(campo.value, 'Il campo parte dal nome attuale.').toBe('scheda.pdf')

        // Vuoto: non parte niente.
        fireEvent.change(campo, { target: { value: '   ' } })
        fireEvent.click(within(dialogo).getByRole('button', { name: itPrimaria.registroAllegatoSalva }))
        expect((await within(dialogo).findByRole('alert')).textContent).toBe(itPrimaria.registroAllegatoNomeVuoto)
        expect(conMetodo('PATCH', '/api/primaria/allegati')).toHaveLength(0)

        fireEvent.change(campo, { target: { value: '  Scheda delle vocali  ' } })
        const primaLetture = letture()
        fireEvent.click(within(dialogo).getByRole('button', { name: itPrimaria.registroAllegatoSalva }))
        await waitFor(() => expect(conMetodo('PATCH', '/api/primaria/allegati')).toHaveLength(1))
        const patch = conMetodo('PATCH', '/api/primaria/allegati')[0]
        expect(JSON.parse(String(patch.init!.body))).toEqual({ id: 'all-1', nome: 'Scheda delle vocali' })
        expect(new URL(patch.url, 'http://x').searchParams.get('userId')).toBe(DOCENTE)
        expect((patch.init!.headers as Record<string, string>)['x-user-id']).toBe(DOCENTE)
        expect((await screen.findByTestId('registro-esito')).textContent).toBe(itPrimaria.registroAllegatoRinominato)
        await waitFor(() => expect(letture()).toBeGreaterThan(primaLetture))
        expect(screen.queryByTestId('registro-allegato-rinomina')).toBeNull()
    })

    it('un 423 (termine passato nel frattempo) chiude la modale e porta il messaggio del CATALOGO sopra la griglia', async () => {
        prepara('educator', [['PATCH /api/primaria/allegati', {
            ok: false, status: 423, body: { error: 'Voce bloccata', codice: 'VOCE_BLOCCATA', giorniLimite: 2 },
        }]], gestione({ 'all-1': { modificabile: true } }))
        render(<RegistroPage />)
        await pronta()
        fireEvent.click(await screen.findByRole('button', { name: 'Rinomina l’allegato «scheda.pdf»' }))
        const dialogo = await screen.findByTestId('registro-allegato-rinomina')
        fireEvent.change(within(dialogo).getByLabelText(itPrimaria.registroAllegatoNomeLabel), { target: { value: 'Altro nome' } })
        const primaPermessi = lettureAllegati().length
        fireEvent.click(within(dialogo).getByRole('button', { name: itPrimaria.registroAllegatoSalva }))
        const esito = await screen.findByTestId('registro-esito')
        expect(esito.getAttribute('role')).toBe('alert')
        expect(esito.textContent).toBe(itShared.erroreVoceBloccata)
        expect(screen.queryByTestId('registro-allegato-rinomina')).toBeNull()
        await waitFor(() => expect(lettureAllegati().length, 'Riletti i permessi: comparirà il blocco.').toBeGreaterThan(primaPermessi))
    })
})

describe('«Sostituisci file»', () => {
    it('manda multipart { id, file } a `sostituisci` e dice che il vecchio file è nel cestino', async () => {
        prepara('educator', [['POST /api/primaria/allegati/sostituisci', { status: 201, body: { success: true, data: { id: 'all-9' } } }]], gestione({ 'all-1': { modificabile: true } }))
        render(<RegistroPage />)
        await pronta()
        fireEvent.click(await screen.findByRole('button', { name: 'Sostituisci file dell’allegato «scheda.pdf»' }))
        const dialogo = await screen.findByTestId('registro-allegato-sostituisci')
        expect(dialogo.textContent).toContain('Il file attuale va nel cestino della classe per 7 giorni')

        // Senza file non parte niente.
        fireEvent.click(within(dialogo).getByRole('button', { name: itPrimaria.registroAllegatoSostituisciConferma }))
        expect((await within(dialogo).findByRole('alert')).textContent).toBe(itPrimaria.registroAllegatoScegliFile)
        expect(conMetodo('POST', '/sostituisci')).toHaveLength(0)

        const file = new File(['%PDF-1.4'], 'scheda-nuova.pdf', { type: 'application/pdf' })
        fireEvent.change(within(dialogo).getByLabelText(itPrimaria.registroAllegatoNuovoFile), { target: { files: [file] } })
        fireEvent.click(within(dialogo).getByRole('button', { name: itPrimaria.registroAllegatoSostituisciConferma }))
        await waitFor(() => expect(conMetodo('POST', '/api/primaria/allegati/sostituisci')).toHaveLength(1))
        const inviata = conMetodo('POST', '/api/primaria/allegati/sostituisci')[0]
        const corpo = inviata.init!.body as FormData
        expect(corpo.get('id')).toBe('all-1')
        expect((corpo.get('file') as File).name).toBe('scheda-nuova.pdf')
        expect(new URL(inviata.url, 'http://x').searchParams.get('userId')).toBe(DOCENTE)
        expect((await screen.findByTestId('registro-esito')).textContent).toBe('File sostituito: quello di prima resta nel cestino per 7 giorni.')
    })

    it('un file rifiutato (400 formato) resta nella modale col testo del catalogo', async () => {
        prepara('educator', [['POST /api/primaria/allegati/sostituisci', {
            ok: false, status: 400, body: { error: 'Formato non ammesso', codice: 'ALLEGATO_REGISTRO_FORMATO_NON_AMMESSO' },
        }]], gestione({ 'all-1': { modificabile: true } }))
        render(<RegistroPage />)
        await pronta()
        fireEvent.click(await screen.findByRole('button', { name: 'Sostituisci file dell’allegato «scheda.pdf»' }))
        const dialogo = await screen.findByTestId('registro-allegato-sostituisci')
        fireEvent.change(within(dialogo).getByLabelText(itPrimaria.registroAllegatoNuovoFile), {
            target: { files: [new File(['x'], 'appunti.txt', { type: 'text/plain' })] },
        })
        fireEvent.click(within(dialogo).getByRole('button', { name: itPrimaria.registroAllegatoSostituisciConferma }))
        expect((await within(dialogo).findByRole('alert')).textContent).toBe(itShared.erroreAllegatoRegistroFormatoNonAmmesso)
        expect(screen.getByTestId('registro-allegato-sostituisci')).toBeInTheDocument()
    })
})

describe('«Elimina»', () => {
    it('chiede conferma spiegando il cestino di 7 giorni; solo alla conferma parte la DELETE ?id=', async () => {
        prepara('educator', [['DELETE /api/primaria/allegati', { body: { success: true, data: { id: 'all-1' } } }]], gestione({ 'all-1': { modificabile: true } }))
        render(<RegistroPage />)
        await pronta()
        fireEvent.click(await screen.findByRole('button', { name: 'Elimina l’allegato «scheda.pdf»' }))
        const dialogo = await screen.findByTestId('registro-allegato-elimina')
        expect(within(dialogo).getByTestId('registro-allegato-elimina-spiega').textContent).toBe(
            '«scheda.pdf» va nel cestino della classe per 7 giorni: fino ad allora puoi ripristinarlo da «Cestino». Poi sparisce per sempre.',
        )
        expect(conMetodo('DELETE', '/api/primaria/allegati'), 'Nessuna DELETE prima della conferma.').toHaveLength(0)

        // Annulla non manda niente.
        fireEvent.click(within(dialogo).getByRole('button', { name: itPrimaria.registroAllegatoAnnulla }))
        await waitFor(() => expect(screen.queryByTestId('registro-allegato-elimina')).toBeNull())
        expect(conMetodo('DELETE', '/api/primaria/allegati')).toHaveLength(0)

        fireEvent.click(screen.getByRole('button', { name: 'Elimina l’allegato «scheda.pdf»' }))
        const primaLetture = letture()
        fireEvent.click(within(await screen.findByTestId('registro-allegato-elimina')).getByRole('button', { name: itPrimaria.registroAllegatoEliminaConferma }))
        await waitFor(() => expect(conMetodo('DELETE', '/api/primaria/allegati')).toHaveLength(1))
        const url = new URL(conMetodo('DELETE', '/api/primaria/allegati')[0].url, 'http://x')
        expect(url.pathname).toBe('/api/primaria/allegati')
        expect(url.searchParams.get('id')).toBe('all-1')
        expect(url.searchParams.get('userId')).toBe(DOCENTE)
        expect((await screen.findByTestId('registro-esito')).textContent).toBe('Allegato nel cestino: puoi ripristinarlo per 7 giorni.')
        await waitFor(() => expect(letture()).toBeGreaterThan(primaLetture))
    })

    it('la rete che cade: esito ignoto, modale chiusa, errore sopra la griglia, rilettura e log', async () => {
        prepara('educator', [['DELETE /api/primaria/allegati', { lancia: true }]], gestione({ 'all-1': { modificabile: true } }))
        render(<RegistroPage />)
        await pronta()
        fireEvent.click(await screen.findByRole('button', { name: 'Elimina l’allegato «scheda.pdf»' }))
        const primaLetture = letture()
        fireEvent.click(within(await screen.findByTestId('registro-allegato-elimina')).getByRole('button', { name: itPrimaria.registroAllegatoEliminaConferma }))
        expect((await screen.findByTestId('registro-esito')).textContent).toBe(itPrimaria.comuneErroreRete)
        expect(screen.queryByTestId('registro-allegato-elimina')).toBeNull()
        await waitFor(() => expect(letture()).toBeGreaterThan(primaLetture))
        expect(logClientMock.mock.calls.some(([e]) => String((e as { messaggio: string }).messaggio).startsWith('registro-allegato-eliminazione-non-inviato'))).toBe(true)
    })
})

describe('il CESTINO della classe', () => {
    const voce = (over: Record<string, unknown> = {}) => ({
        id: 'all-7', registro_id: 'reg-1', ambito: 'argomento', tipo: 'pdf', file_name: 'verifica.pdf',
        dimensione_byte: 10, caricato_da: DOCENTE, creato_il: '2026-09-20T08:00:00Z',
        eliminato_il: '2026-09-21T08:00:00Z', eliminato_da: DOCENTE,
        slot_data: '2026-09-18', slot_ora_lezione: 3,
        ripristinabileFinoAl: '2026-09-28T08:00:00Z', giorniResidui: 3,
        lezioneDaRifirmare: false, ripristinabile: true,
        ...over,
    })

    it('è chiuso finché non lo si apre (nessuna richiesta); aperto, legge il cestino della CLASSE', async () => {
        prepara('educator', [['GET /api/primaria/allegati/cestino', { body: { success: true, data: [voce()] } }]])
        render(<RegistroPage />)
        await pronta()
        expect(lettureCestino(), 'Chiuso: niente richieste a vuoto.').toHaveLength(0)
        const apri = screen.getByRole('button', { name: itPrimaria.registroCestinoApriNome })
        expect(apri.getAttribute('aria-expanded')).toBe('false')
        fireEvent.click(apri)
        expect(apri.getAttribute('aria-expanded')).toBe('true')

        const riga = await screen.findByTestId('registro-cestino-voce-all-7')
        const url = new URL(lettureCestino()[0].url, 'http://x')
        expect(url.searchParams.get('sectionId')).toBe(SEZIONE)
        expect(url.searchParams.get('userId')).toBe(DOCENTE)
        expect(riga.textContent).toContain('verifica.pdf')
        expect(riga.textContent).toContain('Lezione: 3ª ora del 18/09/2026')
        expect(riga.textContent).toContain('ancora 3 giorni per ripristinarlo')
        expect(within(riga).queryByTestId('registro-cestino-rifirmare')).toBeNull()
    })

    it('«Ripristina» manda POST { id }, poi esito, e si rileggono registro e cestino', async () => {
        prepara('educator', [
            ['POST /api/primaria/allegati/cestino', { body: { success: true, data: { id: 'all-7' }, riagganciato: false } }],
            ['GET /api/primaria/allegati/cestino', { body: { success: true, data: [voce()] } }],
        ])
        render(<RegistroPage />)
        await pronta()
        fireEvent.click(screen.getByRole('button', { name: itPrimaria.registroCestinoApriNome }))
        const riga = await screen.findByTestId('registro-cestino-voce-all-7')
        const primaLetture = letture()
        const primaCestino = lettureCestino().length
        fireEvent.click(within(riga).getByRole('button', { name: 'Ripristina l’allegato «verifica.pdf»' }))
        await waitFor(() => expect(conMetodo('POST', '/api/primaria/allegati/cestino')).toHaveLength(1))
        const post = conMetodo('POST', '/api/primaria/allegati/cestino')[0]
        expect(JSON.parse(String(post.init!.body))).toEqual({ id: 'all-7' })
        expect((post.init!.headers as Record<string, string>)['x-user-id']).toBe(DOCENTE)
        expect((await screen.findByTestId('registro-esito')).textContent).toBe(itPrimaria.registroCestinoRipristinato)
        await waitFor(() => expect(letture()).toBeGreaterThan(primaLetture))
        await waitFor(() => expect(lettureCestino().length).toBeGreaterThan(primaCestino))
    })

    it('la lezione eliminata: la voce dice SUBITO quale ora rifirmare', async () => {
        prepara('educator', [['GET /api/primaria/allegati/cestino', {
            body: { success: true, data: [voce({ registro_id: null, lezioneDaRifirmare: true, ripristinabile: false })] },
        }]])
        render(<RegistroPage />)
        await pronta()
        fireEvent.click(screen.getByRole('button', { name: itPrimaria.registroCestinoApriNome }))
        const riga = await screen.findByTestId('registro-cestino-voce-all-7')
        expect(within(riga).getByTestId('registro-cestino-rifirmare').textContent).toBe(
            'La lezione di questo allegato è stata eliminata: prima rifirma la 3ª ora del 18/09/2026, poi ripristinalo.',
        )
    })

    it('409 `LEZIONE_DA_RIFIRMARE` al ripristino: il messaggio compare sulla VOCE, niente banner generico', async () => {
        // La GET dice ancora che la lezione c'è (letta prima che venisse eliminata):
        // è il server, al ripristino, a rispondere che va rifirmata.
        prepara('educator', [
            ['POST /api/primaria/allegati/cestino', {
                ok: false, status: 409,
                body: { error: 'La lezione di questo allegato è stata eliminata', codice: 'LEZIONE_DA_RIFIRMARE' },
            }],
            ['GET /api/primaria/allegati/cestino', { body: { success: true, data: [voce({ registro_id: null })] } }],
        ])
        render(<RegistroPage />)
        await pronta()
        fireEvent.click(screen.getByRole('button', { name: itPrimaria.registroCestinoApriNome }))
        const riga = await screen.findByTestId('registro-cestino-voce-all-7')
        expect(within(riga).queryByTestId('registro-cestino-rifirmare')).toBeNull()
        fireEvent.click(within(riga).getByRole('button', { name: 'Ripristina l’allegato «verifica.pdf»' }))
        const avviso = await within(riga).findByTestId('registro-cestino-rifirmare')
        expect(avviso.getAttribute('role')).toBe('alert')
        expect(avviso.textContent).toBe('La lezione di questo allegato è stata eliminata: prima rifirma la 3ª ora del 18/09/2026, poi ripristinalo.')
        expect(screen.queryByTestId('registro-esito'), 'Il messaggio sta sulla voce, non sopra la griglia.').toBeNull()
    })

    it('cestino scaduto (409): il messaggio del catalogo sopra la griglia, e il cestino si rilegge', async () => {
        prepara('educator', [
            ['POST /api/primaria/allegati/cestino', {
                ok: false, status: 409, body: { error: 'Scaduto', codice: 'ALLEGATO_REGISTRO_CESTINO_SCADUTO' },
            }],
            ['GET /api/primaria/allegati/cestino', { body: { success: true, data: [voce({ giorniResidui: 0 })] } }],
        ])
        render(<RegistroPage />)
        await pronta()
        fireEvent.click(screen.getByRole('button', { name: itPrimaria.registroCestinoApriNome }))
        const riga = await screen.findByTestId('registro-cestino-voce-all-7')
        expect(riga.textContent, '0 giorni interi non è «0 giorni»: è meno di un giorno.').toContain('meno di un giorno per ripristinarlo')
        const primaCestino = lettureCestino().length
        fireEvent.click(within(riga).getByRole('button', { name: 'Ripristina l’allegato «verifica.pdf»' }))
        expect((await screen.findByTestId('registro-esito')).textContent).toBe(itShared.erroreAllegatoRegistroCestinoScaduto)
        await waitFor(() => expect(lettureCestino().length).toBeGreaterThan(primaCestino))
    })

    /**
     * Il percorso principale del requisito: il cestino dice «prima rifirma…», la
     * maestra firma la lezione dalla modale della STESSA pagina, e il cestino
     * aperto deve smettere di dirlo. Si firma la 2ª ora (l'unica cosa che conta è
     * che la firma riesca: `onSaved`), e il server da quel momento risponde che
     * la lezione c'è di nuovo.
     */
    async function firmaLa2aOra() {
        const bottoni = await screen.findAllByRole('button', { name: itPrimaria.registroModifica })
        fireEvent.click(bottoni[1])
        const modale = await screen.findByRole('dialog')
        fireEvent.click(within(modale).getByRole('button', { name: itPrimaria.registroFirma }))
        // La 2ª ora non ha compiti: si interpone il promemoria, e si firma lo stesso.
        fireEvent.click(await screen.findByRole('button', { name: itPrimaria.firmaModalPromemoriaSalva }))
        await waitFor(() => expect(conMetodo('POST', '/api/primaria/registro')).toHaveLength(1))
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    }
    const firmata = () => conMetodo('POST', '/api/primaria/registro').length > 0

    it('firmata la lezione dalla modale, il cestino aperto si rilegge e «prima rifirma…» sparisce', async () => {
        prepara('educator', [
            ['POST /api/primaria/registro', { body: { success: true, data: { id: 'reg-2' } } }],
            // Prima della firma la lezione manca; dopo, lo slot ha di nuovo una lezione firmata.
            ['GET /api/primaria/allegati/cestino', () => ({
                body: { success: true, data: [voce({ slot_ora_lezione: 2, registro_id: null, lezioneDaRifirmare: !firmata(), ripristinabile: firmata() })] },
            })],
        ])
        render(<RegistroPage />)
        await pronta()
        fireEvent.click(screen.getByRole('button', { name: itPrimaria.registroCestinoApriNome }))
        const riga = await screen.findByTestId('registro-cestino-voce-all-7')
        expect(within(riga).getByTestId('registro-cestino-rifirmare').textContent).toContain('prima rifirma la 2ª ora')
        const primaCestino = lettureCestino().length

        await firmaLa2aOra()
        // Prima una PRESENZA: il cestino è stato riletto dopo la firma…
        await waitFor(() => expect(lettureCestino().length, 'Firmata la lezione, il cestino aperto non si rilegge.').toBeGreaterThan(primaCestino))
        // …e solo dopo l'assenza dell'avviso.
        await waitFor(() => expect(within(screen.getByTestId('registro-cestino-voce-all-7')).queryByTestId('registro-cestino-rifirmare')).toBeNull())
        expect(screen.getByRole('button', { name: 'Ripristina l’allegato «verifica.pdf»' })).toBeInTheDocument()
    })

    it('il 409 `LEZIONE_DA_RIFIRMARE` non sopravvive alla rilettura: firmata la lezione, l’avviso segue il server', async () => {
        prepara('educator', [
            ['POST /api/primaria/registro', { body: { success: true, data: { id: 'reg-2' } } }],
            ['POST /api/primaria/allegati/cestino', {
                ok: false, status: 409,
                body: { error: 'La lezione di questo allegato è stata eliminata', codice: 'LEZIONE_DA_RIFIRMARE' },
            }],
            // La GET non ha mai detto «da rifirmare»: l'avviso viene SOLO dal 409.
            ['GET /api/primaria/allegati/cestino', { body: { success: true, data: [voce({ slot_ora_lezione: 2, registro_id: null })] } }],
        ])
        render(<RegistroPage />)
        await pronta()
        fireEvent.click(screen.getByRole('button', { name: itPrimaria.registroCestinoApriNome }))
        const riga = await screen.findByTestId('registro-cestino-voce-all-7')
        fireEvent.click(within(riga).getByRole('button', { name: 'Ripristina l’allegato «verifica.pdf»' }))
        expect((await within(riga).findByTestId('registro-cestino-rifirmare')).getAttribute('role')).toBe('alert')
        const primaCestino = lettureCestino().length

        await firmaLa2aOra()
        await waitFor(() => expect(lettureCestino().length).toBeGreaterThan(primaCestino))
        await waitFor(() => expect(
            within(screen.getByTestId('registro-cestino-voce-all-7')).queryByTestId('registro-cestino-rifirmare'),
            'Il rifiuto di prima resta a schermo anche se il server ora dice che la lezione c’è.',
        ).toBeNull())
    })

    it('eliminato un allegato col cestino aperto, il cestino si rilegge', async () => {
        prepara('educator', [
            ['DELETE /api/primaria/allegati', { body: { success: true, data: { id: 'all-1' } } }],
            ['GET /api/primaria/allegati/cestino', { body: { success: true, data: [] } }],
        ], gestione({ 'all-1': { modificabile: true } }))
        render(<RegistroPage />)
        await pronta()
        fireEvent.click(screen.getByRole('button', { name: itPrimaria.registroCestinoApriNome }))
        expect(await screen.findByText(itPrimaria.registroCestinoVuoto)).toBeInTheDocument()
        const primaCestino = lettureCestino().length
        fireEvent.click(await screen.findByRole('button', { name: 'Elimina l’allegato «scheda.pdf»' }))
        fireEvent.click(within(await screen.findByTestId('registro-allegato-elimina')).getByRole('button', { name: itPrimaria.registroAllegatoEliminaConferma }))
        await waitFor(() => expect(lettureCestino().length).toBeGreaterThan(primaCestino))
    })
})
