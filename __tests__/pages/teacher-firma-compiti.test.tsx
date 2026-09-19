import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

import itPrimaria from '../../messages/it/teacherPrimaria.json'

/**
 * ════════════════════════════════════════════════════════════════════════════
 * «ARGOMENTO SÌ, COMPITI NO» — l'aiuto sotto i campi e il promemoria al salvataggio
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ─── IL FATTO, MISURATO SUL DATABASE DI PRODUZIONE (ultimi 30 giorni) ────────
 *   sede · classe            righe   con argomento   con compiti
 *   Cesa · I ELEMENTARE        3          1               1
 *   Cesa · II ELEMENTARE      17          6               0
 *   Cesa · III ELEMENTARE     30          6               0
 *   Cesa · IV ELEMENTARE      16          4               2
 *   Cesa · V ELEMENTARE       17          4               2
 *
 * In II e III le maestre hanno compilato «Argomento» e mai «Compiti»: dodici
 * righe su dodici. La bacheca del genitore mostra le lezioni che i compiti ce
 * li hanno DAVVERO — `LezioniCompitiSections` filtra su
 * `l.compiti || l.individualizzate.some((i) => i.compiti)` — quindi quel testo
 * finisce in `/parent/lezioni` e in «Compiti» non arriva niente.
 *
 * **Non è un difetto del software**: è un campo scambiato per un altro. Per
 * questo qui non cambia nessun dato — si aggiunge una riga d'aiuto sotto i due
 * riquadri e si CHIEDE, una volta, al salvataggio.
 *
 * ─── COSA SORVEGLIA QUESTO FILE ─────────────────────────────────────────────
 *  1. il promemoria compare quando l'argomento è pieno e i compiti sono vuoti;
 *  2. confermando, la POST parte con lo STESSO IDENTICO CORPO — asserito campo
 *     per campo, non «è partita qualcosa»: è la garanzia che un avviso non
 *     tocchi i dati — e lascia la sua riga di log;
 *  3. annullando non parte NIENTE, e il fuoco torna DENTRO il riquadro dei
 *     compiti che l'etichetta promette;
 *  4. le strade in cui il promemoria deve tacere (compiti pieni, argomento
 *     vuoto, compresenza, compiti mirati con destinatari, supplenza);
 *  5. LA COPPIA CHE PARTE DAVVERO: in assegnazione mirata contano i campi
 *     «propri», non i condivisi — e viceversa;
 *  6. l'aiuto è agganciato ai campi con `aria-describedby` in ENTRAMBI i modi
 *     (di classe e mirato), cioè uno screen reader lo legge anche dove
 *     l'assegnazione è forzata — il sostegno.
 *
 * ⚠️ LE QUERY SONO PER RUOLO E NOME ACCESSIBILE, mai `getByText`: in questa
 * modale le parole «Compiti» e «Argomento» compaiono in cinque punti diversi
 * (due etichette di classe, due «solo per gli alunni selezionati», la data di
 * consegna) e `getByText` prenderebbe il primo sosia.
 *
 * ⚠️ E si aspetta sempre la PRESENZA di qualcosa: «il promemoria non c'è» è
 * vero anche mentre la giornata è ancora in volo.
 */

const SEZIONE = 'sez-1'
/**
 * La SECONDA classe del plesso: senza di lei la tendina «Classe» non viene
 * nemmeno disegnata (`sezioni.length > 1`) e la supplenza — una delle strade in
 * cui il promemoria deve tacere — non è raggiungibile da nessun test.
 */
const ALTRA_SEZIONE = 'sez-2'
const DOCENTE = 'doc-1'
/**
 * Il SECONDO titolare della classe. Serve solo a Segreteria/Direzione, che la
 * firma la attribuiscono a un docente scelto in tendina: cambiare quella scelta
 * cambia LA FIRMA che si sta scrivendo, ed è l'unica strada che esegue la seconda
 * ri-idratazione di `FirmaModal`. Di firme su queste righe non ne ha nessuna:
 * `firmaDi` restituisce `null` ed è esattamente ciò che va riletto.
 */
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

vi.mock('@/lib/offline/syncEngine', () => ({
    saveLocalRegistro: vi.fn(async () => {}),
    syncPendingRegistro: vi.fn(async () => {}),
}))

const logClientMock = vi.fn()
vi.mock('@/lib/logging/client', () => ({
    logClient: (...args: unknown[]) => logClientMock(...args),
    nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
}))

// ─── I dati del giorno ────────────────────────────────────────────────────────
// Nomi e contenuti inventati: il repository è pubblico, qui non entra nessun
// bambino vero e nessun testo scritto da una maestra vera.

const MATERIE = [
    { id: 'mat-ita', nome: 'Italiano' },
    { id: 'mat-mat', nome: 'Matematica' },
]
const ALUNNI = [
    { id: 'alu-1', nome: 'Primo', cognome: 'Alfa' },
    { id: 'alu-2', nome: 'Seconda', cognome: 'Beta' },
]

// Sette ore, tutte lezioni. `padStart` e non `0${…}`: alla 6ª ora il vecchio
// modello produceva `013:30:00`, che non è un orario — e regge anche la 7ª
// (`14:30:00`), aggiunta per la sesta esclusione.
const CAMPANELLE = [1, 2, 3, 4, 5, 6, 7].map((n) => ({
    id: `camp-${n}`,
    ordine: n,
    ora_inizio: `${String(n + 7).padStart(2, '0')}:30:00`,
    ora_fine: `${String(n + 8).padStart(2, '0')}:30:00`,
    tipo: 'lezione',
}))

const ORARIO_CELLE = CAMPANELLE.map((c) => ({
    campanella_id: c.id,
    materia_id: 'mat-ita',
    materie: { nome: 'Italiano' },
}))

/** Una firma del docente corrente, coi soli campi che questo file fa variare. */
function firma(
    id: string,
    tipo: string,
    propri: { argomento_proprio: string | null; compiti_propri: string | null } = {
        argomento_proprio: null,
        compiti_propri: null,
    },
) {
    return { id, maestra_id: DOCENTE, tipo_compresenza: tipo, ...propri, utenti: { nome: 'Ada', cognome: 'Rossi' } }
}

/**
 * Le sei ore, una per caso. Tutte FIRMATE dal docente corrente: il bottone
 * si chiama «Modifica» solo così, ed è anche la strada da cui si riparano le
 * dodici righe già a database.
 */
const RIGHE = [
    /* 1ª — IL CASO: argomento sì, compiti no. */
    {
        id: 'reg-1', ora_lezione: 1, materia: null, materia_id: 'mat-mat',
        argomento: 'I poligoni regolari', compiti: null, data_consegna_compiti: null,
        materie: { nome: 'Matematica' },
        firme_docenti: [firma('firma-1', 'principale')],
        registro_destinatari: [], allegati_registro: [],
    },
    /* 2ª — i compiti ci sono: niente da ricordare. */
    {
        id: 'reg-2', ora_lezione: 2, materia: null, materia_id: 'mat-ita',
        argomento: 'Il testo descrittivo', compiti: 'Leggere pagina 7', data_consegna_compiti: null,
        materie: { nome: 'Italiano' },
        firme_docenti: [firma('firma-2', 'principale')],
        registro_destinatari: [], allegati_registro: [],
    },
    /* 3ª — riga vuota: nessuno scambio di campo in corso. */
    {
        id: 'reg-3', ora_lezione: 3, materia: null, materia_id: 'mat-ita',
        argomento: null, compiti: null, data_consegna_compiti: null,
        materie: { nome: 'Italiano' },
        firme_docenti: [firma('firma-3', 'principale')],
        registro_destinatari: [], allegati_registro: [],
    },
    /* 4ª — COMPRESENZA: l'argomento di classe è del titolare, non di chi affianca. */
    {
        id: 'reg-4', ora_lezione: 4, materia: null, materia_id: 'mat-ita',
        argomento: 'Lettura ad alta voce', compiti: null, data_consegna_compiti: null,
        materie: { nome: 'Italiano' },
        firme_docenti: [firma('firma-4', 'compresenza')],
        registro_destinatari: [], allegati_registro: [],
    },
    /*
     * 5ª — ASSEGNAZIONE MIRATA. I condivisi hanno ESATTAMENTE la forma del caso 1
     * (argomento pieno, compiti nulli) apposta: se il promemoria guardasse la
     * coppia sbagliata scatterebbe qui, dove i compiti ci sono eccome — sono solo
     * mirati, e la bacheca del genitore li legge (`individualizzate`).
     */
    {
        id: 'reg-5', ora_lezione: 5, materia: null, materia_id: 'mat-ita',
        argomento: 'I cinque sensi', compiti: null, data_consegna_compiti: null,
        materie: { nome: 'Italiano' },
        firme_docenti: [
            firma('firma-5', 'sostegno', {
                argomento_proprio: 'Scheda semplificata sui cinque sensi',
                compiti_propri: 'Solo esercizio 1',
            }),
        ],
        registro_destinatari: [{ id: 'dest-1', firma_id: 'firma-5', alunno_id: 'alu-1' }],
        allegati_registro: [],
    },
    /*
     * 6ª — IL CASO 1, SPOSTATO SULL'ALTRA COPPIA. Ed è la riga che mancava.
     *
     * Sostegno (per cui `perAlunni` è FORZATO a true), condivisi NULL, e i
     * «propri» nella forma esatta del caso 1: argomento pieno, compiti vuoti.
     * Qui il promemoria deve parlare, e può farlo solo se guarda la coppia che
     * parte davvero.
     *
     * ⚠️ Senza questa riga, sostituire `argomentoInUso = perAlunni ? argomentoProprio
     * : argomento` con il solo `argomento` lasciava VERDI tutti gli undici test:
     * la 5ª ora taceva per la clausola `compitiPrima` (ha `compiti_propri` pieni),
     * non per la selezione della coppia. Era il «mock piatto verde con e senza la
     * correzione» di `.claude/rules/test.md`, con un messaggio d'asserzione che
     * rivendicava una prova che non c'era.
     */
    {
        id: 'reg-6', ora_lezione: 6, materia: null, materia_id: 'mat-ita',
        argomento: null, compiti: null, data_consegna_compiti: null,
        materie: { nome: 'Italiano' },
        firme_docenti: [
            firma('firma-6', 'sostegno', {
                argomento_proprio: 'Scheda sui suoni duri',
                compiti_propri: null,
            }),
        ],
        registro_destinatari: [{ id: 'dest-2', firma_id: 'firma-6', alunno_id: 'alu-2' }],
        allegati_registro: [],
    },
    /*
     * 7ª — LA SESTA ESCLUSIONE: mirata, ma i compiti DI CLASSE sono già sulla riga.
     *
     * Forma del caso 6 (sostegno, argomento «proprio» pieno, compiti «propri»
     * vuoti) più UNA differenza: `compiti` di classe pieni. Quel campo in mirata
     * non viene spedito — quindi resta com'è a database — e
     * `api/parent/primaria` lo serve a TUTTI senza filtrare i
     * destinatari (solo `individualizzate` è filtrato per `alunno_id`). Si cita per
     * NOME e non per riga: quel file è cresciuto di ~290 righe mentre questo
     * lavoro era in corso, e i numeri erano già sbagliati alla consegna.
     * I genitori degli alunni selezionati quei compiti li vedranno eccome: il
     * promemoria, qui, non sarebbe indimostrabile come in supplenza — sarebbe
     * FALSO. Misurata in produzione: 1 firma in 180 giorni ha questa forma.
     */
    {
        id: 'reg-7', ora_lezione: 7, materia: null, materia_id: 'mat-ita',
        argomento: 'Le consonanti doppie', compiti: 'Leggere pagina 12', data_consegna_compiti: null,
        materie: { nome: 'Italiano' },
        firme_docenti: [
            firma('firma-7', 'sostegno', {
                argomento_proprio: 'Scheda sulle doppie',
                compiti_propri: null,
            }),
        ],
        registro_destinatari: [{ id: 'dest-3', firma_id: 'firma-7', alunno_id: 'alu-1' }],
        allegati_registro: [],
    },
]

interface RispostaFinta { ok?: boolean; status?: number; body?: unknown }

let risposte: Record<string, RispostaFinta> = {}
const chiamate: Array<{ url: string; init?: RequestInit }> = []

/**
 * Il server che RIFIUTA la firma. Non è colore: il rifiuto è l'unico modo in cui
 * la modale resta aperta dopo un «Salva lo stesso», ed è quindi l'unica strada
 * che porta al ritento — dove uno stato «già chiesto» può sopravvivere a un
 * cambio di riga. La GET non si tocca: la chiave è il METODO, non l'URL (POST e
 * GET vanno allo stesso `/api/primaria/registro`).
 */
let postRifiutata = false

function rispostaPer(url: string): RispostaFinta {
    for (const [frammento, r] of Object.entries(risposte)) {
        if (url.includes(frammento)) return r
    }
    return { ok: true, status: 200, body: { success: true, data: [] } }
}

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    chiamate.push({ url, init })
    if (init?.method === 'POST' && postRifiutata) {
        return { ok: false, status: 500, json: async () => ({ success: false, error: 'rifiutata' }) } as unknown as Response
    }
    const r = rispostaPer(url)
    return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.body } as unknown as Response
})

function preparaRisposte() {
    risposte = {
        '/api/primaria/sezioni': {
            body: { success: true, data: [{ id: SEZIONE, name: '1ª A' }, { id: ALTRA_SEZIONE, name: '2ª B' }] },
        },
        '/api/primaria/registro': {
            body: { success: true, data: { giorno: 1, campanelle: CAMPANELLE, orarioCelle: ORARIO_CELLE, righe: RIGHE } },
        },
        '/api/primaria/classe/': {
            body: { success: true, data: { section: { id: SEZIONE }, alunni: ALUNNI, materie: MATERIE } },
        },
        '/api/primaria/me': {
            body: { success: true, data: { userId: DOCENTE, gradi: ['primaria'], ruolo: 'educator', isDirigente: false } },
        },
        // I titolari della classe: la modale li chiede solo quando chi guarda NON è
        // un educator, quindi per tutti gli altri test questa risposta non viene mai
        // letta. `ruolo: 'educator'` perché la tendina filtra i non docenti.
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
    }
}

beforeEach(() => {
    vi.clearAllMocks()
    chiamate.length = 0
    postRifiutata = false
    preparaRisposte()
    vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
})

import RegistroPage from '@/app/(dashboard)/teacher/primaria/[sectionId]/registro/page'
import { oggiFiscaleISO } from '@/lib/format/fiscal-date'

/** Apre la modale sull'ora indicata. Tutte le righe sono firmate → «Modifica». */
async function apriModale(ora: number) {
    const bottoni = await screen.findAllByRole('button', { name: itPrimaria.registroModifica })
    fireEvent.click(bottoni[ora - 1])
    return screen.findByRole('dialog')
}

const bottone = (nome: string) => screen.getByRole('button', { name: nome })
const bottoneForse = (nome: string) => screen.queryByRole('button', { name: nome })
const campoTesto = (nome: string) => screen.getByRole('textbox', { name: nome }) as HTMLTextAreaElement
const tendina = (nome: string) => screen.getByRole('combobox', { name: nome })

/** I messaggi passati a `logClient`: la traccia, non il colore dello schermo. */
const messaggiLoggati = () =>
    logClientMock.mock.calls.map((c) => (c[0] as { messaggio?: string }).messaggio ?? '')

/** Le POST a `/api/primaria/registro`: il salvataggio, non le letture né i log. */
const postDiFirma = () =>
    chiamate.filter((c) => c.init?.method === 'POST' && c.url.includes('/api/primaria/registro'))

/**
 * Clic su «Firma» dentro la modale.
 *
 * ⚠️ IL `.focus()` NON È DECORAZIONE, ed è costato una controprova.
 * `fireEvent.click` non sposta il fuoco (lo fa `userEvent`): senza questa riga
 * `document.activeElement` resta `<body>`, e `<body>` non è focusabile in jsdom.
 * Conseguenza: la cleanup di `Modal`, che alla chiusura rifocalizza
 * `previouslyFocused`, diventava un NO-OP — e il test su «Torna ai compiti»
 * passava anche con un `focus()` sincrono dentro il gestore del click, cioè con
 * la correzione sbagliata, quella che in un browser vero viene sovrascritta.
 * Misurato: 18/18 verdi con entrambe le implementazioni. Dando il fuoco al
 * bottone si riproduce ciò che fa un dito o un Tab, `previouslyFocused` diventa
 * il bottone «Firma» (focusabile per davvero) e le due strade si distinguono.
 */
function premiFirma() {
    const b = bottone(itPrimaria.registroFirma)
    b.focus()
    fireEvent.click(b)
}

describe('promemoria «hai scritto l’argomento ma non i compiti»', () => {
    it('argomento pieno e compiti vuoti: il promemoria COMPARE, e la POST non è ancora partita', async () => {
        render(<RegistroPage />)
        await apriModale(1)
        premiFirma()

        // Si aspetta la PRESENZA del promemoria: «non è partita nessuna POST»
        // sarebbe vero anche un istante prima che parta.
        expect(
            await screen.findByRole('button', { name: itPrimaria.firmaModalPromemoriaSalva }),
            'Con l’argomento compilato e i compiti vuoti il salvataggio deve fermarsi a chiedere: ' +
                'è la forma esatta delle dodici righe di II e III elementare che le famiglie non vedono.',
        ).toBeInTheDocument()

        expect(screen.getByText(itPrimaria.firmaModalPromemoriaCorpo)).toBeInTheDocument()
        expect(
            postDiFirma().length,
            'Il promemoria non è un avviso POSTUMO: se la POST è già partita non serve a niente.',
        ).toBe(0)
    })

    it('confermando, la POST parte con lo STESSO identico corpo (campo per campo)', async () => {
        render(<RegistroPage />)
        await apriModale(1)
        premiFirma()

        fireEvent.click(await screen.findByRole('button', { name: itPrimaria.firmaModalPromemoriaSalva }))

        await waitFor(() => expect(postDiFirma().length).toBe(1))
        const corpo = JSON.parse(String(postDiFirma()[0].init!.body))

        /*
         * `toEqual` sull'INTERO corpo, non tre `expect` sui campi che ci si
         * ricorda. Un promemoria che per errore azzerasse l'argomento, o
         * scrivesse un compito finto, o aggiungesse una bandiera, passerebbe
         * qualunque asserzione parziale — ed è esattamente il genere di difetto
         * che un avviso «innocuo» può introdurre. Le chiavi `undefined` non
         * esistono nel JSON: `docenteId` non compare perché l'utente è educator.
         */
        expect(corpo).toEqual({
            sectionId: SEZIONE,
            data: oggiFiscaleISO(),
            oraLezione: 1,
            materiaId: 'mat-mat',
            argomento: 'I poligoni regolari',
            compiti: '',
            dataConsegnaCompiti: null,
            tipoCompresenza: 'principale',
            argomentoProprio: '',
            compitiPropri: '',
            destinatariIds: [],
            condivisiIdratati: true,
        })

        /*
         * E LASCIA LA SUA RIGA. Senza, «quante volte si firma sapendo di non aver
         * messo compiti» non è misurabile: fra un mese nessuno saprebbe dire se
         * l'aiuto ha funzionato o se è soltanto un clic in più. È il §5 di
         * AGENTS.md — con i soli errori, «nessun log» non distingue «tutto bene»
         * da «non è mai partito niente» — e senza questa asserzione il log
         * potrebbe sparire senza far diventare rosso nulla.
         */
        expect(
            messaggiLoggati(),
            'Il promemoria accettato è un evento, non un dettaglio di interfaccia: è l’unico ' +
                'modo per sapere se questo intervento sta servendo a qualcosa.',
        ).toContain('registro-firma-senza-compiti-confermata')
    })

    it('annullando, NESSUNA POST parte e si torna sui campi', async () => {
        render(<RegistroPage />)
        await apriModale(1)
        premiFirma()

        fireEvent.click(await screen.findByRole('button', { name: itPrimaria.firmaModalPromemoriaTorna }))

        // L'ancora è una PRESENZA: il riquadro «Compiti» torna nell'albero di
        // accessibilità (mentre il promemoria è aperto lo sfondo è inerte, e in
        // jsdom `inert` non esiste: la primitiva ripiega su `aria-hidden`, che
        // `getByRole` onora). Solo dopo si può dire «non è partito niente».
        expect(await screen.findByRole('textbox', { name: itPrimaria.firmaModalCompitiClasse })).toBeInTheDocument()

        expect(
            postDiFirma().length,
            '«Torna ai compiti» deve riportare ai campi, non salvare di nascosto.',
        ).toBe(0)
        expect(bottoneForse(itPrimaria.firmaModalPromemoriaSalva)).toBeNull()
    })

    it('il promemoria si può sciogliere con UN solo clic (mai un muro)', async () => {
        render(<RegistroPage />)
        await apriModale(1)
        premiFirma()

        const clic = await screen.findByRole('button', { name: itPrimaria.firmaModalPromemoriaSalva })
        fireEvent.click(clic)

        await waitFor(() => expect(postDiFirma().length).toBe(1))
        expect(
            bottoneForse(itPrimaria.firmaModalPromemoriaSalva),
            'Un secondo passaggio dopo la conferma sarebbe il muro che questo promemoria esiste per non essere.',
        ).toBeNull()
    })
})

describe('le sei strade in cui il promemoria deve TACERE', () => {
    /**
     * Ogni caso àncora su una PRESENZA — la POST — e solo dopo nega il
     * promemoria: «non c'è l'avviso» da solo sarebbe verde anche su una modale
     * che non ha ancora fatto niente.
     */
    async function salvaSenzaPromemoria(ora: number) {
        render(<RegistroPage />)
        await apriModale(ora)
        premiFirma()
        await waitFor(() => expect(postDiFirma().length).toBe(1))
        expect(bottoneForse(itPrimaria.firmaModalPromemoriaSalva)).toBeNull()
        // Dove il promemoria non c'è, non c'è nemmeno la sua riga: un log che
        // scattasse comunque conterebbe firme che nessuno ha mai dovuto confermare.
        expect(messaggiLoggati()).not.toContain('registro-firma-senza-compiti-confermata')
        return JSON.parse(String(postDiFirma()[0].init!.body))
    }

    it('compiti già compilati: si salva e basta', async () => {
        const corpo = await salvaSenzaPromemoria(2)
        expect(corpo.compiti).toBe('Leggere pagina 7')
    })

    it('argomento vuoto: nessuno scambio di campo, nessun promemoria', async () => {
        const corpo = await salvaSenzaPromemoria(3)
        expect(corpo.argomento).toBe('')
        expect(corpo.compiti).toBe('')
    })

    it('COMPRESENZA: chi affianca non ha un argomento di classe da compilare', async () => {
        const corpo = await salvaSenzaPromemoria(4)
        expect(
            corpo.tipoCompresenza,
            'Se il tipo non è compresenza questo caso non prova quello che dice.',
        ).toBe('compresenza')
        expect(corpo.compiti).toBe('')
    })

    /**
     * IL COMPITO TOLTO APPOSTA non è una dimenticanza.
     *
     * Questa riga i compiti li AVEVA e il riquadro viene svuotato a mano: è il
     * gesto esplicito per cui esiste il patto `condivisiIdratati` col server
     * («un compito assegnato per errore non si poteva più togliere»). Chiedere
     * «sicura? i genitori non vedranno nulla» proprio a chi sta facendo quello
     * sarebbe rumore sull'unica strada costruita apposta — e un avviso che fa
     * rumore dove non serve viene ignorato anche dove serve.
     *
     * ⚠️ L'esenzione è NARROW e non tocca il caso misurato: le dodici righe di
     * II e III hanno `compiti` NULL dalla nascita, quindi riaprendo «Modifica»
     * su una di quelle il promemoria scatta eccome (primo `describe`).
     */
    it('compito TOLTO a mano da una riga che ce l’aveva: nessun promemoria', async () => {
        render(<RegistroPage />)
        await apriModale(2)

        fireEvent.change(campoTesto(itPrimaria.firmaModalCompitiClasse), { target: { value: '' } })
        premiFirma()

        await waitFor(() => expect(postDiFirma().length).toBe(1))
        expect(bottoneForse(itPrimaria.firmaModalPromemoriaSalva)).toBeNull()

        const corpo = JSON.parse(String(postDiFirma()[0].init!.body))
        expect(
            corpo.compiti,
            'Il campo svuotato deve PARTIRE vuoto: ometterlo direbbe «non lo so», e la riga resterebbe.',
        ).toBe('')
        expect(corpo.argomento, 'l’argomento resta quello che era').toBe('Il testo descrittivo')
    })

    it('compiti MIRATI con destinatari: i compiti ci sono, sono solo per alcuni', async () => {
        const corpo = await salvaSenzaPromemoria(5)
        expect(
            corpo.compitiPropri,
            'Questa riga tace per la clausola «compito già a database» (`compiti_propri` pieni), ' +
                'NON per la scelta della coppia: la prova che il promemoria guarda i campi giusti ' +
                'sta nel describe «la coppia che parte davvero», sulla 6ª ora.',
        ).toBe('Solo esercizio 1')
        expect(corpo.destinatariIds).toEqual(['alu-1'])
    })

    /**
     * COMPITI DI CLASSE GIÀ SULLA RIGA, in assegnazione MIRATA — l'unica delle sei
     * in cui il promemoria non sarebbe soltanto indimostrabile: sarebbe FALSO.
     *
     * In mirata i condivisi non si spediscono, quindi ciò che le famiglie vedranno
     * non è il textarea ma la riga a database — e questa i compiti di classe ce li
     * ha. `api/parent/primaria` serve `compiti: r.compiti` senza
     * filtrare i destinatari (solo `individualizzate` è filtrato per `alunno_id`,
     * per nome, non per riga): quei compiti arrivano anche alle famiglie degli alunni
     * selezionati. Dire «i genitori non vedranno nulla nella bacheca Compiti»
     * sarebbe il contrario del vero.
     *
     * ⚠️ È il criterio della supplenza applicato dove la modale SA. Ed è stretto
     * apposta: basta togliere `!compitiDiClasseGiaPresenti` e questo caso torna a
     * fermarsi al promemoria — la POST non parte e il `waitFor` qui sotto scade.
     * Le ore 5 e 6, che dalla riga di classe non dipendono, restano verdi.
     */
    it('COMPITI DI CLASSE già sulla riga, in mirata: la frase sarebbe falsa, quindi tace', async () => {
        const corpo = await salvaSenzaPromemoria(7)
        expect(
            corpo.compiti,
            'È IL MOTIVO DEL SILENZIO: in mirata i condivisi non partono, quindi «Leggere pagina 12» ' +
                'resta a database e le famiglie degli alunni selezionati lo vedranno — la bacheca non ' +
                'filtra i compiti di classe per destinatario.',
        ).toBeUndefined()
        expect(
            corpo.compitiPropri,
            'E i compiti mirati vuoti partono comunque vuoti: qui non si sta nascondendo niente, ' +
                'si sta solo evitando di affermare una cosa falsa.',
        ).toBe('')
        expect(corpo.destinatariIds).toEqual(['alu-1'])
    })

    /**
     * SUPPLENZA — l'esclusione che sembra sbagliata finché non si legge il corpo
     * della richiesta.
     *
     * Il promemoria dice «i genitori non vedranno nulla nella bacheca Compiti».
     * In un'altra classe quella frase la modale NON PUÒ FARLA: la GET carica solo
     * la propria sezione, di quella riga non sa niente, e i compiti del titolare
     * possono esserci già. La prova sta nel corpo che parte — la chiave `compiti`
     * non c'è proprio, perché `condiviso()` la omette: «non lo so» non è «è vuoto».
     * Un avviso che afferma qualcosa su un campo che non sta nemmeno spedendo è
     * rumore; e chi gli desse retta digiterebbe i compiti, spedendoli con
     * `condivisiIdratati: false` sopra il testo di un collega — cioè la
     * regressione B1, riaperta dalla porta accanto.
     *
     * ⚠️ È lo STESSO gesto del primo test di questo file (1ª ora: argomento
     * scritto, compiti vuoti, riga senza compiti a database), fatto in un'altra
     * classe. Lì il promemoria compare; qui deve tacere. Le due prove insieme
     * dicono che a decidere è la classe, non altro.
     */
    it('SUPPLENZA: tace, perché la frase che direbbe non è verificabile e il campo non parte', async () => {
        render(<RegistroPage />)
        await apriModale(1)

        fireEvent.change(tendina(itPrimaria.firmaModalClasse), { target: { value: ALTRA_SEZIONE } })
        // Cambiando classe i condivisi si azzerano: si riscrive solo l'argomento,
        // cioè esattamente lo scambio di campo che altrove fa scattare l'avviso.
        fireEvent.change(campoTesto(itPrimaria.firmaModalArgomentoClasse), { target: { value: 'Le ore e i minuti' } })
        premiFirma()

        await waitFor(() => expect(postDiFirma().length).toBe(1))
        expect(bottoneForse(itPrimaria.firmaModalPromemoriaSalva)).toBeNull()

        const corpo = JSON.parse(String(postDiFirma()[0].init!.body))
        expect(corpo.sectionId).toBe(ALTRA_SEZIONE)
        expect(
            'compiti' in corpo,
            'È IL MOTIVO DEL SILENZIO, non un dettaglio: in supplenza il campo «compiti» non ' +
                'viene nemmeno spedito. Dire «i genitori non vedranno nulla» su una riga che ' +
                'questo modulo non ha mai letto è un’affermazione che non può essere vera o falsa.',
        ).toBe(false)
        expect(
            corpo.condivisiIdratati,
            'E seguendo il consiglio si scriverebbe con `condivisiIdratati: false` sopra il testo ' +
                'del titolare di quella classe: un avviso che spinge a una sovrascrittura.',
        ).toBe(false)
    })
})

/**
 * ─── LA COPPIA CHE PARTE DAVVERO ────────────────────────────────────────────
 *
 * `argomentoInUso`/`compitiInUso` scelgono fra i campi di CLASSE e quelli
 * «propri» secondo la modalità di assegnazione. Fino alla 6ª ora quella scelta
 * non era difesa da niente: sostituendo `perAlunni ? argomentoProprio : argomento`
 * con il solo `argomento` gli undici test restavano tutti verdi, e la 5ª ora —
 * che dichiarava di provarlo — taceva in realtà per un'altra clausola.
 *
 * Qui i due versi sono separati, perché sono due mutazioni diverse:
 *  · l'ARGOMENTO letto dalla coppia sbagliata → il promemoria non parla dove deve;
 *  · i COMPITI letti dalla coppia sbagliata  → il promemoria parla dove non deve.
 */
describe('la coppia che parte davvero (assegnazione mirata)', () => {
    it('argomento PROPRIO pieno e compiti PROPRI vuoti: il promemoria compare', async () => {
        render(<RegistroPage />)
        await apriModale(6)

        // Sostegno: l'assegnazione è forzata sugli alunni selezionati, i due
        // riquadri a schermo sono quelli «(solo per gli alunni selezionati)».
        expect(campoTesto(itPrimaria.firmaModalArgomentoSelezionati).value).toBe('Scheda sui suoni duri')
        expect(campoTesto(itPrimaria.firmaModalCompitiSelezionati).value).toBe('')

        premiFirma()

        expect(
            await screen.findByRole('button', { name: itPrimaria.firmaModalPromemoriaSalva }),
            'I condivisi di questa riga sono NULL: se il promemoria leggesse quelli tacerebbe, ' +
                'e i compiti individualizzati — che la bacheca del genitore legge eccome ' +
                '(`individualizzate`) — resterebbero dimenticati senza che nessuno lo dica.',
        ).toBeInTheDocument()
        expect(postDiFirma().length).toBe(0)
    })

    it('scrivendo i compiti PROPRI il promemoria tace (e i condivisi restano vuoti)', async () => {
        render(<RegistroPage />)
        await apriModale(6)

        fireEvent.change(campoTesto(itPrimaria.firmaModalCompitiSelezionati), {
            target: { value: 'Ripassare i suoni duri' },
        })
        premiFirma()

        await waitFor(() => expect(postDiFirma().length).toBe(1))
        expect(
            bottoneForse(itPrimaria.firmaModalPromemoriaSalva),
            'Il verso opposto: qui i compiti CI SONO, ma solo nella coppia mirata. Un promemoria ' +
                'che guardasse i condivisi (vuoti, e mai spediti) parlerebbe a una maestra che ' +
                'ha appena finito di assegnarli — ed è così che un avviso si fa ignorare.',
        ).toBeNull()

        const corpo = JSON.parse(String(postDiFirma()[0].init!.body))
        expect(corpo.compitiPropri).toBe('Ripassare i suoni duri')
        expect(corpo.destinatariIds).toEqual(['alu-2'])
    })
})

/**
 * ─── «TORNA AI COMPITI» DEVE PORTARE AI COMPITI ─────────────────────────────
 *
 * L'etichetta è una promessa. Prima della correzione il bottone chiudeva il
 * dialogo e basta: `document.activeElement` finiva su `<body>` in jsdom e sul
 * bottone «Firma» in un browser vero (è il ripristino WCAG 2.4.3 di `Modal`),
 * mai nel riquadro nominato. Per chi naviga da tastiera o con uno screen reader
 * era un «annulla» travestito — e il riquadro dei compiti, che è tutto il punto
 * dell'intervento, restava da cercare a mano.
 */
describe('«Torna ai compiti» rimette il fuoco nel riquadro dei compiti', () => {
    it('modalità di classe: il fuoco arriva su «Compiti (tutta la classe)»', async () => {
        render(<RegistroPage />)
        await apriModale(1)
        premiFirma()

        fireEvent.click(await screen.findByRole('button', { name: itPrimaria.firmaModalPromemoriaTorna }))

        const compiti = await screen.findByRole('textbox', { name: itPrimaria.firmaModalCompitiClasse })
        await waitFor(() =>
            expect(
                document.activeElement,
                'Il fuoco deve superare la cleanup della primitiva, che lo riporta al bottone ' +
                    '«Firma»: va rimesso DOPO, fuori dal ciclo di smontaggio.',
            ).toBe(compiti),
        )
    })

    it('modalità mirata: il fuoco arriva sul riquadro dei compiti DI QUEL MODO', async () => {
        render(<RegistroPage />)
        await apriModale(6)
        premiFirma()

        fireEvent.click(await screen.findByRole('button', { name: itPrimaria.firmaModalPromemoriaTorna }))

        const compiti = await screen.findByRole('textbox', { name: itPrimaria.firmaModalCompitiSelezionati })
        await waitFor(() =>
            expect(
                document.activeElement,
                'Nel sostegno il riquadro di classe non è nemmeno disegnato: puntare a quello ' +
                    'lascerebbe il fuoco dov’era, cioè in nessun posto utile.',
            ).toBe(compiti),
        )
    })
})

/**
 * ─── IL «SALVA LO STESSO» VALE PER LA RIGA SU CUI È STATO DATO ──────────────
 *
 * `promemoriaSciolto` esiste per non ridomandare al RITENTO dopo un rifiuto del
 * server. Qui vivono i suoi DUE versi, perché sono due difetti opposti:
 *  · non vale ABBASTANZA → si ridomanda al ritento, e il promemoria diventa il
 *    muro che questo file dichiara di non essere (primo test);
 *  · vale TROPPO → il ritento avviene su un'altra riga — basta cambiare classe,
 *    o il docente titolare — e si firma senza aver mai chiesto niente su di lei.
 * Tutti e tre i percorsi passano da un rifiuto del server: è l'unico modo in cui
 * la modale resta aperta dopo un «Salva lo stesso». Stretti, e per questo vanno
 * chiusi qui, dove costano tre test, invece che in produzione.
 */
describe('il «Salva lo stesso» vale per la riga su cui è stato dato, e per tutta quella riga', () => {
    /**
     * LA RAGIONE D'ESSERE DI `promemoriaSciolto`, che fino al 2026-09-19 nessun
     * test difendeva: togliendo `!promemoriaSciolto` da `firma()` restavano verdi
     * tutti e diciotto. Era difeso solo il suo AZZERAMENTO, mai il suo scopo.
     *
     * Non è un blocco del salvataggio — il promemoria si scioglie sempre con un
     * clic — ma un clic in più a ogni ritento, e soprattutto un DOPPIO conteggio
     * di `registro-firma-senza-compiti-confermata`: cioè la metrica con cui fra un
     * mese si dirà se questo intervento è servito, falsata dai ritenti.
     */
    it('RITENTO sulla stessa riga: non si ridomanda, e la seconda POST parte', async () => {
        postRifiutata = true
        render(<RegistroPage />)
        await apriModale(1)
        premiFirma()

        fireEvent.click(await screen.findByRole('button', { name: itPrimaria.firmaModalPromemoriaSalva }))
        await waitFor(() => expect(postDiFirma().length).toBe(1))
        // L'ancora è una PRESENZA: l'errore del server è ciò che tiene aperta la
        // modale e rende possibile il ritento.
        expect(await screen.findByRole('alert')).toBeInTheDocument()

        // Nessun tocco alla classe né al docente: è LA STESSA riga, e su di lei la
        // domanda è già stata fatta e sciolta.
        premiFirma()
        await waitFor(() =>
            expect(
                postDiFirma().length,
                'Senza `!promemoriaSciolto` in `firma()` il secondo clic ridomanda e la POST non parte ' +
                    'mai: chi ritenta dopo un errore del server si ritrova davanti la stessa domanda ' +
                    'identica, che è esattamente il muro che il promemoria esiste per non essere.',
            ).toBe(2),
        )
        expect(bottoneForse(itPrimaria.firmaModalPromemoriaSalva)).toBeNull()

        // E la traccia resta UNA. Non è una ripetizione dell'asserzione sopra: se il
        // log si spostasse dentro `firma()` le POST resterebbero due e le conferme
        // contate diventerebbero due, cioè il doppio conteggio che falsa la metrica.
        expect(
            messaggiLoggati().filter((m) => m === 'registro-firma-senza-compiti-confermata'),
            'Il ritento non è una nuova conferma: la maestra ha dato «Salva lo stesso» una volta sola.',
        ).toHaveLength(1)
    })

    it('rifiuto del server, giro in un’altra classe e ritorno: si ridomanda', async () => {
        postRifiutata = true
        render(<RegistroPage />)
        await apriModale(1)
        premiFirma()

        fireEvent.click(await screen.findByRole('button', { name: itPrimaria.firmaModalPromemoriaSalva }))
        await waitFor(() => expect(postDiFirma().length).toBe(1))
        // L'ancora è una PRESENZA: il messaggio d'errore del server, che è ciò
        // che tiene la modale aperta e rende possibile il ritento.
        expect(await screen.findByRole('alert')).toBeInTheDocument()

        fireEvent.change(tendina(itPrimaria.firmaModalClasse), { target: { value: ALTRA_SEZIONE } })
        fireEvent.change(tendina(itPrimaria.firmaModalClasse), { target: { value: SEZIONE } })
        // Controllo positivo: si è davvero tornati sulla propria riga, ri-idratata.
        expect(campoTesto(itPrimaria.firmaModalArgomentoClasse).value).toBe('I poligoni regolari')

        premiFirma()
        expect(
            await screen.findByRole('button', { name: itPrimaria.firmaModalPromemoriaSalva }),
            'Il «Salva lo stesso» era stato dato prima del giro: tenerlo vorrebbe dire firmare ' +
                'una riga senza aver mai chiesto niente su di lei.',
        ).toBeInTheDocument()
        expect(postDiFirma().length, 'la seconda POST non deve essere già partita').toBe(1)
    })

    /**
     * L'ALTRA STRADA CHE CAMBIA RIGA: il DOCENTE TITOLARE.
     *
     * Cambiarlo non cambia la riga di registro, cambia LA FIRMA che si sta
     * scrivendo — e con lei i due riquadri «propri», che vengono riletti dalla sua.
     * Un «Salva lo stesso» dato sulla firma di Rossi non dice niente su quella di
     * Neri. L'azzeramento c'è da sempre; a non esserci era chi lo eseguisse: la
     * fixture di questo file è un `educator`, per cui `serveDocente` è falso e la
     * tendina non viene nemmeno disegnata. Serve Segreteria.
     */
    it('cambiando il DOCENTE TITOLARE si ridomanda: è un’altra firma', async () => {
        risposte['/api/primaria/me'] = {
            body: { success: true, data: { userId: DOCENTE, gradi: ['primaria'], ruolo: 'segreteria', isDirigente: false } },
        }
        postRifiutata = true
        render(<RegistroPage />)
        await apriModale(1)

        const scelta = (await screen.findByLabelText(itPrimaria.firmaModalDocenteTitolare)) as HTMLSelectElement
        // Si aspetta l'OPZIONE e non la tendina: l'elenco arriva da una fetch, e una
        // `change` su una select ancora vuota non seleziona niente.
        await screen.findByRole('option', { name: /Rossi Ada/i })
        fireEvent.change(scelta, { target: { value: DOCENTE } })

        premiFirma()
        fireEvent.click(await screen.findByRole('button', { name: itPrimaria.firmaModalPromemoriaSalva }))
        await waitFor(() => expect(postDiFirma().length).toBe(1))
        expect(await screen.findByRole('alert')).toBeInTheDocument()

        fireEvent.change(scelta, { target: { value: ALTRO_DOCENTE } })
        premiFirma()
        expect(
            await screen.findByRole('button', { name: itPrimaria.firmaModalPromemoriaSalva }),
            'Il «Salva lo stesso» era stato dato sulla firma di Rossi: su quella di Neri non è mai ' +
                'stato chiesto niente, e senza l’azzeramento si firmerebbe la sua riga in silenzio.',
        ).toBeInTheDocument()
        expect(postDiFirma().length, 'la seconda POST non deve essere già partita').toBe(1)
    })
})

describe('l’aiuto sotto i due riquadri', () => {
    it('è agganciato a ENTRAMBI i campi, quindi uno screen reader lo legge', async () => {
        render(<RegistroPage />)
        await apriModale(1)

        // La mezza frase che conta è l'ultima: è l'informazione che mancava.
        expect(itPrimaria.firmaModalAiutoCompiti).toMatch(/bacheca delle famiglie/i)

        expect(
            campoTesto(itPrimaria.firmaModalArgomentoClasse),
            'L’aiuto spiega la DIFFERENZA fra i due campi: chi legge con uno screen reader arriva ' +
                'all’argomento per primo, ed è lì che la distinzione serve — prima di scrivere.',
        ).toHaveAccessibleDescription(itPrimaria.firmaModalAiutoCompiti)

        expect(campoTesto(itPrimaria.firmaModalCompitiClasse)).toHaveAccessibleDescription(
            itPrimaria.firmaModalAiutoCompiti,
        )
    })

    it('sta accanto ai campi, non in cima alla modale', async () => {
        render(<RegistroPage />)
        const dialogo = await apriModale(1)

        const aiuto = screen.getByText(itPrimaria.firmaModalAiutoCompiti)
        const compiti = campoTesto(itPrimaria.firmaModalCompitiClasse)
        expect(
            compiti.parentElement?.contains(aiuto),
            'In cima alla modale scorrerebbe via prima che si scriva il primo carattere.',
        ).toBe(true)
        expect(dialogo.contains(aiuto)).toBe(true)
    })

    /**
     * L'ASSEGNAZIONE MIRATA NON È UN RAMO MINORE: per il SOSTEGNO è l'unico.
     * `perAlunni` è forzato a `true` per quel tipo di firma, quindi una docente
     * di sostegno non vede mai i riquadri di classe. Finché l'aiuto viveva solo
     * lì, riceveva il promemoria — che di qui scatta eccome (vedi «la coppia che
     * parte davvero») — senza aver mai letto la spiegazione: l'avviso senza la
     * metà che insegna qualcosa, cioè tutto il punto dell'intervento.
     */
    it('c’è anche nell’assegnazione MIRATA, agganciato a entrambi i riquadri', async () => {
        render(<RegistroPage />)
        const dialogo = await apriModale(6)

        expect(
            campoTesto(itPrimaria.firmaModalArgomentoSelezionati),
            'Il sostegno non vede mai il ramo di classe: senza questo `aria-describedby` ' +
                'l’aiuto, per lei, non esiste.',
        ).toHaveAccessibleDescription(itPrimaria.firmaModalAiutoCompiti)

        expect(campoTesto(itPrimaria.firmaModalCompitiSelezionati)).toHaveAccessibleDescription(
            itPrimaria.firmaModalAiutoCompiti,
        )

        // E si vede a schermo, dentro il dialogo: `aria-describedby` che punta a
        // un nodo assente è una stringa vuota, non un aiuto.
        expect(dialogo.contains(screen.getByText(itPrimaria.firmaModalAiutoCompiti))).toBe(true)
    })
})
