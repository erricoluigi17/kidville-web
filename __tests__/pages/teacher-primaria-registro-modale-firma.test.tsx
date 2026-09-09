import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'

import itPrimaria from '../../messages/it/teacherPrimaria.json'

/**
 * LOCK · la modale «Modifica» del registro di classe si apre SUI DATI CHE CI SONO.
 *
 * ─── I DIFETTI MISURATI (collaudo 2026-09-09) ────────────────────────────────
 *
 * (a) La modale si apriva VUOTA. Lo stato passato da `setModal` portava due soli
 *     campi (`ordine`, `materiaId`) e `FirmaModal` inizializzava tutto a stringa
 *     vuota. Il bottone si chiama «Modifica» proprio quando la riga È firmata: il
 *     docente rileggeva una schermata bianca dove aveva scritto argomento, compiti
 *     e destinatari. Conseguenze, tutte e tre reali:
 *       1. i compiti di classe non tornano più a vuoto (il server ha un
 *          `if (compiti)` che ignora la stringa vuota) — resta di L4;
 *       2. riaprire «Modifica» su un'ora con attività individualizzata AZZERAVA
 *          `argomento_proprio`/`compiti_propri` e i destinatari, e declassava una
 *          firma di sostegno a «principale» (il `<select>` ripartiva dal default);
 *       3. `data_consegna_compiti` la GET la restituisce da sempre, e il docente
 *          non la vedeva MAI: `interface Riga` non la dichiarava nemmeno.
 *
 * (b) La firma VUOTA si salvava con 200 e la spunta. Con «Alunni selezionati» e
 *     nessuna spunta il client mandava `argomento/compiti: undefined` e
 *     `destinatariIds: []`: il server non scriveva niente e rispondeva 200. Per
 *     `tipo === 'sostegno'` il toggle non è nemmeno disegnato, quindi era l'unica
 *     strada possibile.
 *
 * (c) Segreteria e Direzione non potevano firmare: `risolviValutatore` pretende
 *     `docenteId` per chi non è `educator` e risponde 422 «Seleziona il docente
 *     titolare…», ma nel file non esisteva nessun `<select>` del docente e la POST
 *     non mandava mai quel campo. Il messaggio arrivava a schermo verbatim e
 *     chiedeva una cosa che l'interfaccia non permetteva.
 *
 * (e) Errori invisibili: il bundle classe che fallisce lasciava la modale senza
 *     materie né alunni, muta.
 */

const SEZIONE = 'sez-1'
const DOCENTE = 'doc-1'
const ALTRO_DOCENTE = 'doc-2'

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

// Il motore offline tocca Dexie/IndexedDB: qui interessa solo che non parta,
// e POTER GUARDARE che cosa gli si mette in coda.
type RigaInCoda = Record<string, unknown>
const salvaInCoda = vi.hoisted(() => vi.fn(async (_riga: unknown) => { void _riga }))
vi.mock('@/lib/offline/syncEngine', () => ({
    saveLocalRegistro: salvaInCoda,
    syncPendingRegistro: vi.fn(async () => {}),
}))

/** Stacca la rete per il test corrente. `afterEach` la riattacca. */
function senzaRete() {
    Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true })
}

const logClientMock = vi.fn()
vi.mock('@/lib/logging/client', () => ({
    logClient: (...args: unknown[]) => logClientMock(...args),
    nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
}))

// ─── I dati del giorno ────────────────────────────────────────────────────────
// Nomi inventati: il repository è pubblico, qui non entra nessun bambino vero.

const MATERIE = [
    { id: 'mat-ita', nome: 'Italiano' },
    { id: 'mat-mat', nome: 'Matematica' },
]
const ALUNNI = [
    { id: 'alu-1', nome: 'Primo', cognome: 'Alfa' },
    { id: 'alu-2', nome: 'Seconda', cognome: 'Beta' },
]

const CAMPANELLE = [
    { id: 'camp-1', ordine: 1, ora_inizio: '08:30:00', ora_fine: '09:30:00', tipo: 'lezione' },
    { id: 'camp-2', ordine: 2, ora_inizio: '09:30:00', ora_fine: '10:30:00', tipo: 'lezione' },
]

const ORARIO_CELLE = [
    { campanella_id: 'camp-1', materia_id: 'mat-ita', materie: { nome: 'Italiano' } },
    { campanella_id: 'camp-2', materia_id: 'mat-ita', materie: { nome: 'Italiano' } },
]

/** 1ª ora: firma PRINCIPALE del docente corrente, con contenuti di CLASSE. */
const RIGA_CLASSE = {
    id: 'reg-1',
    ora_lezione: 1,
    materia: null,
    materia_id: 'mat-mat',
    argomento: 'Le frazioni equivalenti',
    compiti: 'Pagina 42, esercizi 3 e 4',
    data_consegna_compiti: '2026-09-14',
    materie: { nome: 'Matematica' },
    firme_docenti: [
        {
            id: 'firma-1',
            maestra_id: DOCENTE,
            tipo_compresenza: 'principale',
            argomento_proprio: null,
            compiti_propri: null,
            utenti: { nome: 'Ada', cognome: 'Rossi' },
        },
    ],
    registro_destinatari: [],
    allegati_registro: [],
}

/** 2ª ora: firma di SOSTEGNO del docente corrente, mirata a un alunno solo. */
const RIGA_INDIVIDUALIZZATA = {
    id: 'reg-2',
    ora_lezione: 2,
    materia: null,
    materia_id: 'mat-ita',
    argomento: 'Il testo descrittivo',
    compiti: 'Leggere pagina 7',
    data_consegna_compiti: null,
    materie: { nome: 'Italiano' },
    firme_docenti: [
        {
            id: 'firma-2',
            maestra_id: DOCENTE,
            tipo_compresenza: 'sostegno',
            argomento_proprio: 'Scheda semplificata sui cinque sensi',
            compiti_propri: 'Solo esercizio 1',
            utenti: { nome: 'Ada', cognome: 'Rossi' },
        },
    ],
    registro_destinatari: [{ id: 'dest-1', firma_id: 'firma-2', alunno_id: 'alu-1' }],
    allegati_registro: [],
}

interface RispostaFinta { ok?: boolean; status?: number; body?: unknown; lancia?: boolean }

/** Le risposte, per "pezzo di URL". Ogni test sovrascrive solo ciò che gli serve. */
let risposte: Record<string, RispostaFinta> = {}
const chiamate: Array<{ url: string; init?: RequestInit }> = []

function rispostaPer(url: string): RispostaFinta {
    for (const [frammento, r] of Object.entries(risposte)) {
        if (url.includes(frammento)) return r
    }
    return { ok: true, status: 200, body: { success: true, data: [] } }
}

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    chiamate.push({ url, init })
    const r = rispostaPer(url)
    if (r.lancia) throw new TypeError('Failed to fetch')
    return {
        ok: r.ok ?? true,
        status: r.status ?? 200,
        json: async () => r.body,
    } as unknown as Response
})

function preparaRisposte(over: Record<string, RispostaFinta> = {}) {
    risposte = {
        '/api/primaria/sezioni': {
            body: {
                success: true,
                data: [
                    { id: SEZIONE, name: '1ª A' },
                    { id: 'sez-2', name: '2ª B' },
                ],
            },
        },
        '/api/primaria/registro': {
            body: {
                success: true,
                data: {
                    giorno: 1,
                    campanelle: CAMPANELLE,
                    orarioCelle: ORARIO_CELLE,
                    righe: [RIGA_CLASSE, RIGA_INDIVIDUALIZZATA],
                },
            },
        },
        '/api/primaria/classe/': {
            body: { success: true, data: { section: { id: SEZIONE }, alunni: ALUNNI, materie: MATERIE } },
        },
        '/api/primaria/me': {
            body: { success: true, data: { userId: DOCENTE, gradi: ['primaria'], ruolo: 'educator', isDirigente: false } },
        },
        '/teachers': {
            body: {
                success: true,
                assigned: [
                    { id: DOCENTE, nome: 'Ada', cognome: 'Rossi', ruolo: 'educator' },
                    { id: ALTRO_DOCENTE, nome: 'Bruno', cognome: 'Neri', ruolo: 'educator' },
                ],
                available: [],
            },
        },
        ...over,
    }
}

beforeEach(() => {
    vi.clearAllMocks()
    chiamate.length = 0
    preparaRisposte()
    vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true })
})

import RegistroPage from '@/app/(dashboard)/teacher/primaria/[sectionId]/registro/page'

/** Apre la modale sull'ora indicata (il bottone è «Modifica» quando è firmata). */
async function apriModale(ora: number) {
    const bottoni = await screen.findAllByRole('button', { name: itPrimaria.registroModifica })
    fireEvent.click(bottoni[ora - 1])
    return screen.findByRole('dialog')
}

const testoDi = (etichetta: string) => screen.getByLabelText(etichetta) as HTMLTextAreaElement
const tendinaDi = (etichetta: string) => screen.getByLabelText(etichetta) as HTMLSelectElement

describe('la modale «Modifica» del registro si apre sui dati esistenti', () => {
    it('(a) i contenuti di CLASSE sono già dentro i campi', async () => {
        render(<RegistroPage />)
        await apriModale(1)

        expect(
            testoDi(itPrimaria.firmaModalArgomentoClasse).value,
            'La modale si apre vuota: chi riapre «Modifica» non rilegge quello che ha scritto.',
        ).toBe('Le frazioni equivalenti')
        expect(testoDi(itPrimaria.firmaModalCompitiClasse).value).toBe('Pagina 42, esercizi 3 e 4')
        expect(
            tendinaDi(itPrimaria.firmaModalMateria).value,
            'La materia deve venire dalla RIGA (materia_id), non dall’orario pianificato: ' +
                'la lezione è stata svolta in Matematica, l’orario prevedeva Italiano.',
        ).toBe('mat-mat')
        expect(
            (screen.getByLabelText(itPrimaria.firmaModalConsegnaAria) as HTMLInputElement).value,
            '`data_consegna_compiti` la GET la restituisce da sempre e il docente non la vede mai.',
        ).toBe('14/09/2026')
    })

    it('(a) l’attività INDIVIDUALIZZATA non viene cancellata riaprendo la modale', async () => {
        render(<RegistroPage />)
        await apriModale(2)

        expect(
            tendinaDi(itPrimaria.firmaModalTipoFirma).value,
            'Il tipo firma ripartiva da «principale»: riaprire e salvare DECLASSAVA una firma di sostegno.',
        ).toBe('sostegno')
        expect(testoDi(itPrimaria.firmaModalArgomentoSelezionati).value).toBe('Scheda semplificata sui cinque sensi')
        expect(testoDi(itPrimaria.firmaModalCompitiSelezionati).value).toBe('Solo esercizio 1')

        const destinatario = screen.getByRole('checkbox', { name: /Alfa Primo/i }) as HTMLInputElement
        expect(
            destinatario.checked,
            'I destinatari ripartivano da zero: salvare cancellava `registro_destinatari` della firma.',
        ).toBe(true)
        expect((screen.getByRole('checkbox', { name: /Beta Seconda/i }) as HTMLInputElement).checked).toBe(false)
    })

    it('(a) la data di consegna compare NELL’ELENCO, non solo nella modale', async () => {
        render(<RegistroPage />)
        expect(
            await screen.findByText(new RegExp(itPrimaria.registroConsegnaEntro.replace('{data}', '14/09/2026'), 'i')),
        ).toBeInTheDocument()
    })

    it('(a) riaprendo e salvando la firma individualizzata, il corpo POST la CONSERVA', async () => {
        render(<RegistroPage />)
        await apriModale(2)
        fireEvent.click(screen.getByRole('button', { name: itPrimaria.registroFirma }))

        await waitFor(() => {
            const post = chiamate.find((c) => c.init?.method === 'POST')
            expect(post, 'nessuna POST partita').toBeTruthy()
        })
        const post = chiamate.find((c) => c.init?.method === 'POST')!
        const corpo = JSON.parse(String(post.init!.body))
        expect(corpo.destinatariIds).toEqual(['alu-1'])
        expect(corpo.argomentoProprio).toBe('Scheda semplificata sui cinque sensi')
        expect(corpo.compitiPropri).toBe('Solo esercizio 1')
        expect(corpo.tipoCompresenza).toBe('sostegno')
    })
})

describe('(b) la firma senza destinatari non si può salvare', () => {
    it('«Alunni selezionati» con zero spunte disabilita il bottone e lo dice', async () => {
        render(<RegistroPage />)
        await apriModale(1)

        fireEvent.click(screen.getByRole('button', { name: itPrimaria.firmaModalAlunniSelezionati }))

        expect(
            screen.getByText(itPrimaria.firmaModalNessunDestinatario),
            'Senza spunte il server non scrive niente e risponde 200 con la spunta di «firmato».',
        ).toBeInTheDocument()
        expect(
            (screen.getByRole('button', { name: itPrimaria.registroFirma }) as HTMLButtonElement).disabled,
        ).toBe(true)
    })

    // CONTROLLO POSITIVO, dichiarato come tale: questo test era verde anche PRIMA
    // della correzione (prima il bottone non era mai disabilitato). Il suo mestiere
    // non è cogliere il difetto — lo coglie quello sopra — ma impedire la correzione
    // sbagliata: un bottone disabilitato per sempre passerebbe il test precedente.
    it('spuntando un alunno il bottone torna attivo (controllo positivo)', async () => {
        render(<RegistroPage />)
        await apriModale(1)
        fireEvent.click(screen.getByRole('button', { name: itPrimaria.firmaModalAlunniSelezionati }))
        fireEvent.click(screen.getByRole('checkbox', { name: /Beta Seconda/i }))

        expect(
            (screen.getByRole('button', { name: itPrimaria.registroFirma }) as HTMLButtonElement).disabled,
        ).toBe(false)
        expect(screen.queryByText(itPrimaria.firmaModalNessunDestinatario)).toBeNull()
    })
})

describe('(c) segreteria e direzione firmano scegliendo il docente titolare', () => {
    beforeEach(() => {
        preparaRisposte({
            '/api/primaria/me': {
                body: { success: true, data: { userId: DOCENTE, gradi: ['primaria'], ruolo: 'segreteria', isDirigente: false } },
            },
        })
    })

    it('la tendina «Docente titolare» c’è, è popolata, e senza scelta non si salva', async () => {
        render(<RegistroPage />)
        await apriModale(1)

        const tendina = await screen.findByLabelText(itPrimaria.firmaModalDocenteTitolare)
        expect(
            tendina,
            'risolviValutatore risponde 422 «Seleziona il docente titolare…» e l’interfaccia ' +
                'non offriva nessun modo di selezionarlo.',
        ).toBeInTheDocument()
        expect(within(tendina as HTMLSelectElement).getByRole('option', { name: /Neri Bruno/i })).toBeInTheDocument()
        expect(
            (screen.getByRole('button', { name: itPrimaria.registroFirma }) as HTMLButtonElement).disabled,
        ).toBe(true)
    })

    it('scelto il docente, `docenteId` finisce nel corpo della POST', async () => {
        render(<RegistroPage />)
        await apriModale(1)
        const tendina = await screen.findByLabelText(itPrimaria.firmaModalDocenteTitolare)
        fireEvent.change(tendina, { target: { value: ALTRO_DOCENTE } })
        fireEvent.click(screen.getByRole('button', { name: itPrimaria.registroFirma }))

        await waitFor(() => expect(chiamate.some((c) => c.init?.method === 'POST')).toBe(true))
        const post = chiamate.find((c) => c.init?.method === 'POST')!
        expect(JSON.parse(String(post.init!.body)).docenteId).toBe(ALTRO_DOCENTE)
    })

    // CONTROLLO NEGATIVO, verde anche prima della correzione (prima la tendina non
    // esisteva per nessuno). Serve a fissare il confine: la tendina è per chi NON è
    // `educator`, e chiederla anche alla maestra sarebbe un attrito quotidiano su una
    // schermata che si apre otto volte al giorno.
    it('per un educator la tendina del docente NON esiste (controllo negativo)', async () => {
        preparaRisposte()
        render(<RegistroPage />)
        await apriModale(1)
        expect(screen.queryByLabelText(itPrimaria.firmaModalDocenteTitolare)).toBeNull()
    })
})

describe('(e) i guasti di rete non restano invisibili', () => {
    it('il bundle classe negato lascia un messaggio, non una modale muta', async () => {
        preparaRisposte({
            '/api/primaria/classe/': { ok: false, status: 403, body: { error: 'Docente non abilitato alla primaria' } },
        })
        render(<RegistroPage />)

        expect(await screen.findByRole('alert')).toHaveTextContent(/Docente non abilitato alla primaria/i)
        expect(logClientMock).toHaveBeenCalled()
    })

    it('l’elenco sezioni che fallisce viene loggato, non ingoiato', async () => {
        preparaRisposte({ '/api/primaria/sezioni': { lancia: true } })
        render(<RegistroPage />)

        await waitFor(() => expect(logClientMock).toHaveBeenCalled())
        const messaggi = logClientMock.mock.calls.map((c) => (c[0] as { messaggio: string }).messaggio)
        expect(messaggi.some((m) => m.includes('registro-sezioni'))).toBe(true)
    })

    it('una risposta NON JSON al salvataggio non lascia il bottone bloccato per sempre', async () => {
        preparaRisposte({
            '/api/primaria/registro?userId': { ok: false, status: 413, body: undefined },
        })
        // La POST va sulla stessa rotta della GET: la risposta finta lancia sul `json()`.
        risposte['/api/primaria/registro'] = {
            body: {
                success: true,
                data: { giorno: 1, campanelle: CAMPANELLE, orarioCelle: ORARIO_CELLE, righe: [RIGA_CLASSE, RIGA_INDIVIDUALIZZATA] },
            },
        }
        const fetchRotto = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input)
            chiamate.push({ url, init })
            if (init?.method === 'POST') {
                return {
                    ok: false,
                    status: 413,
                    json: async () => { throw new SyntaxError('Unexpected token < in JSON') },
                } as unknown as Response
            }
            const r = rispostaPer(url)
            return { ok: true, status: 200, json: async () => r.body } as unknown as Response
        })
        vi.stubGlobal('fetch', fetchRotto)

        render(<RegistroPage />)
        await apriModale(1)
        const bottone = screen.getByRole('button', { name: itPrimaria.registroFirma }) as HTMLButtonElement
        fireEvent.click(bottone)

        await waitFor(() => expect(bottone.disabled).toBe(false))
        expect(await screen.findByRole('alert')).toBeInTheDocument()
    })
})

describe('(d) la supplenza non porta i contenuti di una classe dentro un’altra', () => {
    it('cambiando classe i campi condivisi si azzerano e NON partono vuoti', async () => {
        render(<RegistroPage />)
        await apriModale(1)

        // Idratata sulla propria classe: l’argomento c’è.
        expect(testoDi(itPrimaria.firmaModalArgomentoClasse).value).toBe('Le frazioni equivalenti')

        fireEvent.change(tendinaDi(itPrimaria.firmaModalClasse), { target: { value: 'sez-2' } })

        expect(
            testoDi(itPrimaria.firmaModalArgomentoClasse).value,
            'La riga della 2ª B non è caricata: tenere il testo della 1ª A lo scriverebbe ' +
                'nel registro di un’altra classe.',
        ).toBe('')

        fireEvent.click(screen.getByRole('button', { name: itPrimaria.registroFirma }))
        await waitFor(() => expect(chiamate.some((c) => c.init?.method === 'POST')).toBe(true))
        const corpo = JSON.parse(String(chiamate.find((c) => c.init?.method === 'POST')!.init!.body))
        expect(corpo.sectionId).toBe('sez-2')
        expect(
            'argomento' in corpo,
            'Da quando il server scrive «"" → null», mandare il campo vuoto CANCELLA l’argomento ' +
                'del titolare della classe in cui si sta facendo supplenza. «Non lo so» non è «è vuoto».',
        ).toBe(false)
        expect('compiti' in corpo).toBe(false)
        expect('dataConsegnaCompiti' in corpo).toBe(false)
    })

    it('tornando alla propria classe i contenuti si ri-idratano (controllo positivo)', async () => {
        render(<RegistroPage />)
        await apriModale(1)
        fireEvent.change(tendinaDi(itPrimaria.firmaModalClasse), { target: { value: 'sez-2' } })
        fireEvent.change(tendinaDi(itPrimaria.firmaModalClasse), { target: { value: SEZIONE } })

        expect(testoDi(itPrimaria.firmaModalArgomentoClasse).value).toBe('Le frazioni equivalenti')
        expect(testoDi(itPrimaria.firmaModalCompitiClasse).value).toBe('Pagina 42, esercizi 3 e 4')
    })

    it('la tendina delle classi NON viene ristretta: la supplenza resta possibile', async () => {
        render(<RegistroPage />)
        await apriModale(1)
        const tendina = tendinaDi(itPrimaria.firmaModalClasse)
        expect(
            within(tendina).getAllByRole('option').length,
            'Il permesso lo allarga il server: qui non si toglie nessuna classe del proprio plesso.',
        ).toBe(2)
    })
})

describe('(d) offline, la supplenza non si accoda sulla classe sbagliata', () => {
    it('senza rete, firmare in un’altra classe viene RIFIUTATO e non entra in coda', async () => {
        render(<RegistroPage />)
        await apriModale(1)
        fireEvent.change(tendinaDi(itPrimaria.firmaModalClasse), { target: { value: 'sez-2' } })
        senzaRete()
        fireEvent.click(screen.getByRole('button', { name: itPrimaria.registroFirma }))

        await waitFor(() =>
            expect(
                salvaInCoda,
                'La coda scriveva `section_id` della classe della PAGINA, non di quella firmata: la ' +
                    'lezione fatta in 2ª B finiva nel registro della 1ª A, con un «salvato» tranquillo. ' +
                    'E i contenuti condivisi partivano vuoti, cioè cancellavano quelli del titolare ' +
                    'della 2ª B: `saveLocalRegistro` non ha un modo di dire «questo campo non mandarlo».',
            ).not.toHaveBeenCalled(),
        )
        expect(await screen.findByRole('alert')).toHaveTextContent(itPrimaria.firmaModalSupplenzaOffline)
    })

    it('senza rete, nella PROPRIA classe la coda riceve la sezione giusta (controllo positivo)', async () => {
        render(<RegistroPage />)
        await apriModale(1)
        senzaRete()
        fireEvent.click(screen.getByRole('button', { name: itPrimaria.registroFirma }))

        await waitFor(() => expect(salvaInCoda).toHaveBeenCalled())
        const riga = salvaInCoda.mock.calls[0][0] as RigaInCoda
        expect(riga.section_id).toBe(SEZIONE)
        expect(riga.data_consegna_compiti, 'la scadenza dei compiti deve viaggiare anche offline').toBe('2026-09-14')
        expect(riga.compiti).toBe('Pagina 42, esercizi 3 e 4')
    })
})

/* ════════════════════════════════════════════════════════════════════════════
 * RIPARAZIONE 2026-09-09 — i tre difetti che il collaudo critico ha trovato
 * DENTRO la correzione precedente. Due su tre li ha introdotti l'idratazione:
 * prima non potevano esistere perché i campi ripartivano sempre vuoti.
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * Riga con SOLI contenuti mirati: niente materia (nemmeno pianificata), niente
 * argomento né compiti di classe. È la riga su cui il rifiuto del server per
 * «firma senza destinatari» (`route.ts:388-393`) si qualifica, perché
 * `contenutiCondivisi` è falso e `rigaGiaDocumentata` pure.
 */
const RIGA_SOLO_MIRATA = {
    id: 'reg-3',
    ora_lezione: 1,
    materia: null,
    materia_id: null,
    argomento: null,
    compiti: null,
    data_consegna_compiti: null,
    materie: null,
    firme_docenti: [
        {
            id: 'firma-3',
            maestra_id: DOCENTE,
            tipo_compresenza: 'compresenza',
            argomento_proprio: 'Scheda semplificata sui cinque sensi',
            compiti_propri: 'Solo esercizio 1',
            utenti: { nome: 'Ada', cognome: 'Rossi' },
        },
    ],
    registro_destinatari: [{ id: 'dest-3', firma_id: 'firma-3', alunno_id: 'alu-1' }],
    allegati_registro: [],
}

/**
 * Riga in cui l'assegnazione è tornata DI CLASSE ma i destinatari sono rimasti
 * appesi: `argomento_proprio`/`compiti_propri` a null e `registro_destinatari`
 * ancora popolata. Non è un caso di scuola — è ciò che il server produce oggi,
 * perché la delete dei destinatari sta dentro `if (haDestinatari)`
 * (`route.ts:573`) e con `destinatariIds: []` non ci entra mai.
 */
const RIGA_DESTINATARI_ORFANI = {
    id: 'reg-4',
    ora_lezione: 1,
    materia: null,
    materia_id: 'mat-mat',
    argomento: 'Le frazioni equivalenti',
    compiti: 'Pagina 42, esercizi 3 e 4',
    data_consegna_compiti: null,
    materie: { nome: 'Matematica' },
    firme_docenti: [
        {
            id: 'firma-4',
            maestra_id: DOCENTE,
            tipo_compresenza: 'principale',
            argomento_proprio: null,
            compiti_propri: null,
            utenti: { nome: 'Ada', cognome: 'Rossi' },
        },
    ],
    registro_destinatari: [{ id: 'dest-4', firma_id: 'firma-4', alunno_id: 'alu-1' }],
    allegati_registro: [],
}

/** Una giornata di UNA sola ora, con la riga indicata. Niente materia pianificata. */
function giornataDiUnOra(riga: unknown) {
    return {
        '/api/primaria/registro': {
            body: {
                success: true,
                data: {
                    giorno: 1,
                    campanelle: [CAMPANELLE[0]],
                    orarioCelle: [],
                    righe: [riga],
                },
            },
        },
    }
}

/** Il corpo della POST partita, già decodificato. */
function corpoPost(): Record<string, unknown> {
    const post = chiamate.find((c) => c.init?.method === 'POST')
    if (!post) throw new Error('nessuna POST partita')
    return JSON.parse(String(post.init!.body))
}

/**
 * La condizione ESATTA con cui il server rifiuta con 400 (`route.ts:386-393`),
 * riscritta qui sul corpo che parte dal browser. Non è una parafrasi: è la stessa
 * espressione, e il suo mestiere è impedire che il client costruisca una richiesta
 * che verrà respinta con un messaggio su riquadri che a schermo non ci sono.
 */
function rifiutataComeFirmaSenzaDestinatari(corpo: Record<string, unknown>): boolean {
    const contenutiCondivisi = !!(corpo.materiaId || corpo.argomento || corpo.compiti || corpo.dataConsegnaCompiti)
    const contenutiPropri = !!(corpo.argomentoProprio || corpo.compitiPropri)
    const haDestinatari = ((corpo.destinatariIds as string[] | undefined) ?? []).length > 0
    return contenutiPropri && !haDestinatari && !contenutiCondivisi
}

describe('R1 · uscendo dall’assegnazione mirata i contenuti PROPRI non partono più', () => {
    it('in SUPPLENZA i propri idratati non vengono spediti (e non cancellano quelli altrui)', async () => {
        render(<RegistroPage />)
        await apriModale(2) // 2ª ora: sostegno, con propri e un destinatario

        fireEvent.change(tendinaDi(itPrimaria.firmaModalClasse), { target: { value: 'sez-2' } })
        fireEvent.click(screen.getByRole('button', { name: itPrimaria.registroFirma }))
        await waitFor(() => expect(chiamate.some((c) => c.init?.method === 'POST')).toBe(true))

        const corpo = corpoPost()
        expect(corpo.sectionId).toBe('sez-2')
        expect(
            rifiutataComeFirmaSenzaDestinatari(corpo),
            'Il server risponde 400 «Nessun alunno selezionato… oppure passa a “Tutta la classe”» ' +
                'su una schermata dove né il pannello degli alunni né il toggle sono disegnati: ' +
                'un vicolo cieco, e riaprire la modale re-idrata gli stessi due campi.',
        ).toBe(false)
        expect(
            'argomentoProprio' in corpo,
            'In supplenza la firma dell’ALTRA classe non è caricata: mandare «"" » cancellerebbe ' +
                'l’attività individualizzata che quel docente ci ha scritto. «Non lo so» non è «è vuoto».',
        ).toBe(false)
        expect('compitiPropri' in corpo).toBe(false)
    })

    it('tornando a «Tutta la classe» i propri partono VUOTI, non pieni', async () => {
        preparaRisposte(giornataDiUnOra(RIGA_SOLO_MIRATA))
        render(<RegistroPage />)
        await apriModale(1)

        fireEvent.click(screen.getByRole('button', { name: itPrimaria.firmaModalTuttaClasse }))
        fireEvent.click(screen.getByRole('button', { name: itPrimaria.registroFirma }))
        await waitFor(() => expect(chiamate.some((c) => c.init?.method === 'POST')).toBe(true))

        const corpo = corpoPost()
        expect(corpo.destinatariIds).toEqual([])
        expect(
            rifiutataComeFirmaSenzaDestinatari(corpo),
            'Si è già su «Tutta la classe» e il server invita a passarci: l’errore chiede una cosa ' +
                'che l’interfaccia ha già fatto.',
        ).toBe(false)
        expect(
            'argomentoProprio' in corpo,
            'La chiave va MANDATA, vuota: è così che il server (route.ts:527-528) scrive NULL sui ' +
                'propri. Ometterla li lascerebbe a database, invisibili e non più modificabili.',
        ).toBe(true)
        expect(corpo.argomentoProprio).toBe('')
        expect(corpo.compitiPropri).toBe('')
    })

    it('l’assegnazione MIRATA continua a spedire i propri (controllo positivo)', async () => {
        preparaRisposte(giornataDiUnOra(RIGA_SOLO_MIRATA))
        render(<RegistroPage />)
        await apriModale(1)
        fireEvent.click(screen.getByRole('button', { name: itPrimaria.registroFirma }))
        await waitFor(() => expect(chiamate.some((c) => c.init?.method === 'POST')).toBe(true))

        const corpo = corpoPost()
        expect(corpo.argomentoProprio).toBe('Scheda semplificata sui cinque sensi')
        expect(corpo.destinatariIds).toEqual(['alu-1'])
    })
})

describe('R2 · i destinatari da soli non fanno un’assegnazione mirata', () => {
    it('una firma con destinatari APPESI e propri vuoti riapre su «Tutta la classe»', async () => {
        preparaRisposte(giornataDiUnOra(RIGA_DESTINATARI_ORFANI))
        render(<RegistroPage />)
        await apriModale(1)

        expect(
            testoDi(itPrimaria.firmaModalArgomentoClasse).value,
            'Con «Alunni selezionati» i due riquadri di CLASSE spariscono dal DOM: l’argomento che ' +
                'l’elenco continua a mostrare non sarebbe più né visibile né modificabile da nessuna parte.',
        ).toBe('Le frazioni equivalenti')
        expect(testoDi(itPrimaria.firmaModalCompitiClasse).value).toBe('Pagina 42, esercizi 3 e 4')
        expect(
            screen.getByRole('button', { name: itPrimaria.firmaModalTuttaClasse }).getAttribute('aria-pressed'),
        ).toBe('true')
    })

    /**
     * Il caso che il pareggio «destinatari E contenuti» avrebbe nascosto, ed è
     * RAGGIUNGIBILE: `registro_destinatari.alunno_id` ha una FK
     * `ON DELETE CASCADE` verso `alunni` (misurato: `confdeltype = 'c'`), quindi
     * cancellare un alunno — l'oblio GDPR, il ciclo alunno — porta via le sue righe
     * di destinatario e lascia la firma con i propri PIENI e zero destinatari.
     * Aprire quella firma su «Tutta la classe» renderebbe il testo invisibile e lo
     * cancellerebbe al primo salvataggio, in silenzio: esattamente il difetto che il
     * test qui sopra corregge, girato dall'altra parte.
     */
    it('se i destinatari sono spariti ma il testo c’è, il testo resta VISIBILE', async () => {
        preparaRisposte(giornataDiUnOra({ ...RIGA_SOLO_MIRATA, registro_destinatari: [] }))
        render(<RegistroPage />)
        await apriModale(1)

        expect(
            testoDi(itPrimaria.firmaModalArgomentoSelezionati).value,
            'Con «Tutta la classe» questi due riquadri non sono disegnati: il testo ' +
                'individualizzato sarebbe invisibile, e il primo salvataggio lo azzererebbe.',
        ).toBe('Scheda semplificata sui cinque sensi')
        expect(screen.getByText(itPrimaria.firmaModalNessunDestinatario)).toBeInTheDocument()
        expect(
            (screen.getByRole('button', { name: itPrimaria.registroFirma }) as HTMLButtonElement).disabled,
            'Bloccato e SPIEGATO, non silenzioso: si sceglie un alunno, oppure si passa a ' +
                '«Tutta la classe» e i propri partono vuoti (`proprio()`), cancellandosi apposta.',
        ).toBe(true)
    })

    it('con i propri PIENI la modale riparte da «Alunni selezionati» (controllo positivo)', async () => {
        render(<RegistroPage />)
        await apriModale(2)
        expect(testoDi(itPrimaria.firmaModalArgomentoSelezionati).value).toBe('Scheda semplificata sui cinque sensi')
        expect((screen.getByRole('checkbox', { name: /Alfa Primo/i }) as HTMLInputElement).checked).toBe(true)
    })
})

describe('R3 · la tendina «Docente titolare» offre soltanto DOCENTI', () => {
    const PERSONALE_MISTO = {
        '/api/primaria/me': {
            body: { success: true, data: { userId: DOCENTE, gradi: ['primaria'], ruolo: 'segreteria', isDirigente: false } },
        },
        '/teachers': {
            body: {
                success: true,
                assigned: [
                    { id: 'seg-9', nome: 'Sara', cognome: 'Bianchi', ruolo: 'segreteria' },
                    { id: ALTRO_DOCENTE, nome: 'Bruno', cognome: 'Neri', ruolo: 'educator' },
                    { id: 'adm-9', nome: 'Dario', cognome: 'Verdi', ruolo: 'admin' },
                    { id: 'cuo-9', nome: 'Carla', cognome: 'Gialli', ruolo: 'cuoca' },
                ],
                available: [],
            },
        },
    }

    it('segreteria, Direzione e cuoca NON compaiono fra i titolari proponibili', async () => {
        preparaRisposte(PERSONALE_MISTO)
        render(<RegistroPage />)
        await apriModale(1)
        const tendina = (await screen.findByLabelText(itPrimaria.firmaModalDocenteTitolare)) as HTMLSelectElement

        expect(
            within(tendina).queryByRole('option', { name: /Bianchi Sara/i }),
            '`isTitolareSezione` valida sulla STESSA `utenti_sezioni` da cui viene questo elenco: ' +
                'le due parti concordano, quindi nessuna delle due ferma la firma forgiata. La ' +
                'Segreteria potrebbe attribuire a sé stessa la firma che `risolviValutatore` esiste ' +
                'per impedire.',
        ).toBeNull()
        expect(within(tendina).queryByRole('option', { name: /Verdi Dario/i })).toBeNull()
        expect(within(tendina).queryByRole('option', { name: /Gialli Carla/i })).toBeNull()
        expect(within(tendina).getByRole('option', { name: /Neri Bruno/i })).toBeInTheDocument()
        expect(within(tendina).getAllByRole('option')).toHaveLength(2) // «— seleziona —» + il docente
    })

    it('se nessun docente è assegnato, lo dice invece di proporre la Segreteria', async () => {
        preparaRisposte({
            ...PERSONALE_MISTO,
            '/teachers': {
                body: {
                    success: true,
                    assigned: [{ id: 'seg-9', nome: 'Sara', cognome: 'Bianchi', ruolo: 'segreteria' }],
                    available: [],
                },
            },
        })
        render(<RegistroPage />)
        await apriModale(1)
        const tendina = (await screen.findByLabelText(itPrimaria.firmaModalDocenteTitolare)) as HTMLSelectElement

        expect(within(tendina).getAllByRole('option')).toHaveLength(1)
        expect(await screen.findByText(itPrimaria.firmaModalNessunDocente)).toBeInTheDocument()
        expect(
            (screen.getByRole('button', { name: itPrimaria.registroFirma }) as HTMLButtonElement).disabled,
        ).toBe(true)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// IL PATTO COL SERVER — il buco che nessuno dei due lati poteva vedere da solo.
//
// `primaria/registro:POST` rifiuta di azzerare un campo condiviso a chi non
// DICHIARA di aver letto la riga esistente (`condivisiIdratati`): è la difesa
// contro la coda offline, che i tre condivisi li spedisce sempre senza averli
// letti. La difesa è nata correggendo il server; questa modale, che nel
// frattempo aveva imparato a idratarsi, non lo dichiarava — e così lo
// svuotamento LEGITTIMO restava rifiutato, cioè il difetto di partenza («un
// compito assegnato per errore non si può più togliere») era ancora vivo, con
// entrambe le metà scritte e nessuna prova che si parlassero.
// ─────────────────────────────────────────────────────────────────────────────
describe('svuotare un compito: la modale dichiara di aver letto la riga', () => {
    it('nella PROPRIA classe il corpo porta `condivisiIdratati: true`, e i campi vuoti', async () => {
        render(<RegistroPage />)
        await apriModale(1)

        fireEvent.change(testoDi(itPrimaria.firmaModalCompitiClasse), { target: { value: '' } })
        fireEvent.click(screen.getByRole('button', { name: itPrimaria.registroFirma }))

        await waitFor(() => expect(chiamate.find((c) => c.init?.method === 'POST')).toBeTruthy())
        const corpo = JSON.parse(String(chiamate.find((c) => c.init?.method === 'POST')!.init!.body))

        expect(
            corpo.compiti,
            'Il campo svuotato deve PARTIRE vuoto: ometterlo direbbe «non lo so», e la riga resterebbe.',
        ).toBe('')
        expect(
            corpo.condivisiIdratati,
            'Senza la dichiarazione il server RIFIUTA l’azzeramento (e lo conta come ' +
                '`azzeramento-condivisi-non-dichiarato`): il compito sbagliato resta per sempre, ' +
                'e la modale mostra un 200 che non ha svuotato niente.',
        ).toBe(true)
    })

    it('in SUPPLENZA non lo dichiara: di quella riga la modale non sa nulla', async () => {
        render(<RegistroPage />)
        await apriModale(1)
        fireEvent.change(tendinaDi(itPrimaria.firmaModalClasse), { target: { value: 'sez-2' } })
        fireEvent.click(screen.getByRole('button', { name: itPrimaria.registroFirma }))

        await waitFor(() => expect(chiamate.find((c) => c.init?.method === 'POST')).toBeTruthy())
        const corpo = JSON.parse(String(chiamate.find((c) => c.init?.method === 'POST')!.init!.body))

        expect(
            corpo.condivisiIdratati,
            'La GET carica solo la propria classe: dichiarare il patto qui darebbe a un modulo ' +
                'che non ha mai visto quella riga il permesso di cancellare l’argomento di un collega.',
        ).toBe(false)
    })
})
