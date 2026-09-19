import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'

import itShared from '../../messages/it/shared.json'

/**
 * LOCK · la linguetta «Compiti» della classe — l'elenco, il periodo, la
 * paginazione, e le frasi che NON si possono scambiare.
 *
 * ─── COSA MISURA ─────────────────────────────────────────────────────────────
 *
 *  (1) l'ordine è DISCENDENTE per data (e crescente per ora dentro lo stesso
 *      giorno): è ciò che la pagina promette, e la promessa non può dipendere
 *      dall'`.order()` di una route che un domani cambia per un altro motivo —
 *      e con le pagine che si accodano serve di più, non di meno;
 *  (2) «Consegna entro …» compare solo dove la scadenza c'è ED È UNA DATA: su
 *      una riga che non ce l'ha sarebbe una scadenza inventata, e su una data
 *      malformata è la frase monca «Consegna entro il » con la pastiglia vuota;
 *  (3) l'assegnazione mirata esce come TESTO + CONTEGGIO, mai coi nomi: sono
 *      minori, e la route stessa non li restituisce — e a zero destinatari non
 *      si scrive «0 alunni», che afferma che quel compito non è di nessuno;
 *  (4) un allegato con `file_url: null` non produce un'ancora — un collegamento
 *      che porta a una 404 fa credere che il file non ci sia più;
 *  (5) cambiando periodo riparte la lettura col `dataDa` giusto, e «Anno
 *      scolastico» parte dal 1° agosto (l'unica definizione di anno scolastico
 *      che il repo abbia), non dal 1° gennaio;
 *  (6) lo stato vuoto NOMINA il periodo e nessun comando lo restringe di
 *      nascosto; una lettura FALLITA non è mai «nessun compito» — dice «Riprova»;
 *  (7) nella cornice di classe la linguetta esiste, sta SUBITO DOPO «Registro»
 *      e punta al segmento `compiti`;
 *  (8) la scala non va all'indietro: al 10 gennaio «Anno scolastico» non è più
 *      stretto di «Ultimi 90 giorni» (col 1° gennaio erano 9 giorni contro 90);
 *  (9) il tetto vero, misurato sul valore CHIESTO: il 31 luglio di un anno
 *      bisestile il 1° agosto dista 365 giorni — margine zero sul controllo
 *      della route — e il clamp lo ferma a 364;
 * (10) due click rapidi: la risposta in RITARDO non sovrascrive la più recente;
 * (11) 🔴 il cambio di periodo TOGLIE SUBITO l'elenco vecchio: mentre la nuova
 *      lettura è in volo non si vedono le righe dell'altro periodo;
 * (12) 🔴 `ambito` si legge: un allegato caricato per l'ARGOMENTO porta la sua
 *      marca anche dentro la linguetta «Compiti»;
 * (13) la paginazione: «Carica altri» accoda, rimanda il cursore IDENTICO, e
 *      sparisce solo quando il cursore è finito;
 * (14) 🔴 una pagina VUOTA con un cursore valido NON è «non ci sono compiti»:
 *      la lettura prosegue, e lo stato vuoto non può convivere col cursore;
 * (15) un seguito FALLITO lascia a schermo le righe già lette, col suo avviso —
 *      che non è il vuoto e non è il guasto della prima pagina;
 * (16) l'orologio si legge UNA volta: l'anno scolastico si decide sulla stessa
 *      lettura da cui esce «oggi», non su un secondo `new Date()`;
 * (17) un 200 malformato è un GUASTO, non «nessun compito», e una riga senza le
 *      sue liste non fa cadere il render.
 *
 * ─── LE CONTROPROVE (2026-09-19, terzo giro) ─────────────────────────────────
 * Verificato rompendo il codice di proposito, una famiglia alla volta:
 *  · ordinamento invertito (`a.data.localeCompare(b.data)`) → rosso il caso (1);
 *  · guardia sulla data FORMATTATA rimessa sulla stringa grezza → rosso (2);
 *  · `dataDaDelPeriodo` che ignora il periodo e torna sempre 30 giorni → rosso
 *    il caso (5);
 *  · ritorno al 1° gennaio (`annoFiscale()`) → rossi i casi (5) e (8);
 *  · clamp tolto → rosso il caso (9);
 *  · guardia di sequenza tolta → rosso il caso (10);
 *  · `vista` che mostra `lettura` senza confrontare il periodo → rosso (11);
 *  · `ambito` tolto dall'interfaccia o marca non resa → rosso (12);
 *  · `prossimoCursore` scartato nella lettura → rossi i casi (13) e (14);
 *  · il giro che si ferma sulla prima pagina vuota → rosso il caso (14);
 *  · seguito fallito che azzera le righe o il cursore → rosso il caso (15);
 *  · `annoScolasticoCorrente()` chiamata senza argomento → rosso il caso (16);
 *  · periodo rimesso fra i filtri, con «Pulisci filtri» che lo azzera → rosso il
 *    caso (6);
 *  · lista non validata (200 malformato → `[]`) e `individualizzati` non
 *    normalizzato → rosso il caso (17).
 *
 * ⚠️ Due trappole note e qui evitate: un `waitFor` su un'ASSENZA passa mentre la
 * fetch è ancora in volo — si aspetta sempre la PRESENZA di qualcosa e solo poi
 * si nega il resto; e `getByText` pesca i sosia — le date si leggono DENTRO la
 * riga (`within`), non a pagina intera.
 */

const SEZIONE = 'sez-1'
const DOCENTE = 'd-1'
const PERCORSO = '/teacher/primaria/sez-1/compiti'

/** Mezzogiorno a Roma del 18/09/2026: «oggi» vale 2026-09-18 in ogni fuso di macchina. */
const MEZZOGIORNO_18 = '2026-09-18T10:00:00Z'

/**
 * I `dataDa` attesi, SCRITTI PER ESTESO e non ricalcolati con `addGiorni` /
 * `annoScolasticoCorrente`: riusare le stesse funzioni del componente
 * proverebbe soltanto che due chiamate identiche danno lo stesso risultato.
 * Contati a mano dal 18/09/2026: −30 → 19/08, −90 → 20/06; l'anno SCOLASTICO in
 * corso il 18/09/2026 è il 2026/2027, che apre il 1° agosto 2026.
 */
const DA_30 = '2026-08-19'
const DA_90 = '2026-06-20'
const DA_ANNO = '2026-08-01'

const stub = vi.hoisted(() => ({
    params: { sectionId: 'sez-1' } as Record<string, string>,
    search: new URLSearchParams('userId=d-1'),
}))

/**
 * LA SPIA SULL'ANNO SCOLASTICO, e perché è una spia e non un finto.
 *
 * Serve al caso (16), che è l'unico difetto di questo file impossibile da
 * riprodurre con l'orologio fermo: nasce dal TEMPO CHE PASSA fra due letture
 * dell'orologio, e un `setSystemTime` per definizione non lo lascia passare.
 * Quello che si può misurare — e che va rosso appena qualcuno rimette la
 * seconda lettura — è che l'istante gli venga PASSATO invece di essere riletto:
 * la funzione vera resta dietro, così il resto dei casi continua a provare il
 * comportamento e non il finto.
 */
const spie = vi.hoisted(() => ({ annoScolastico: vi.fn() as ReturnType<typeof vi.fn> }))

vi.mock('@/lib/anno-scolastico', async (importOriginal) => {
    const vero = await importOriginal<typeof import('@/lib/anno-scolastico')>()
    spie.annoScolastico.mockImplementation((d?: Date) => vero.annoScolasticoCorrente(d))
    return { ...vero, annoScolasticoCorrente: spie.annoScolastico }
})

vi.mock('next/navigation', () => ({
    useParams: () => stub.params,
    useSearchParams: () => stub.search,
    usePathname: () => PERCORSO,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: () => {} }),
}))

vi.mock('next/link', async () => {
    const React = await import('react')
    return {
        default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
            React.createElement('a', { href, ...rest }, children),
    }
})

vi.mock('@/lib/logging/client', () => ({
    logClient: vi.fn(),
    nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'errore'),
}))

interface Allegato {
    id: string
    tipo: string | null
    ambito?: string | null
    file_name: string | null
    file_url: string | null
}
interface Voce {
    id: string
    data: string
    ora_lezione: number
    materia: string | null
    compiti: string | null
    data_consegna_compiti: string | null
    allegati: Allegato[]
    individualizzati: { compiti: string; destinatari: number }[]
}

type Risposta = { ok: boolean; stato: number; corpo: unknown }

/** La risposta che la rete finta darà quando la CODA è esaurita. */
let risposta: Risposta = {
    ok: true,
    stato: 200,
    corpo: { success: true, data: { compiti: [], prossimoCursore: null } },
}

/**
 * LE PAGINE IN CODA.
 *
 * La paginazione non si può provare con una risposta sola: le pagine sono
 * diverse fra loro, e il difetto che conta — «una pagina vuota con un cursore
 * valido non è la fine» — richiede proprio che la seconda risposta non sia la
 * prima. Ogni lettura dei compiti consuma la testa della coda; finita la coda si
 * torna a `risposta`, che è il comportamento dei casi che la paginazione non la
 * guardano.
 */
let coda: Risposta[] = []

const chiamate: string[] = []

/**
 * LE LETTURE TRATTENUTE, e perché servono.
 *
 * Con la rete finta che risponde subito, due click rapidi non si sovrappongono
 * mai: la prima risposta è già atterrata prima che parta la seconda, e il difetto
 * della risposta in ritardo resterebbe invisibile — un finto che non può
 * riprodurre il guasto rende il test verde con e senza la correzione. Acceso
 * `trattieni`, ogni lettura dei compiti resta appesa e la si lascia andare a
 * mano, nell'ordine che si vuole. Il corpo è fotografato al momento della
 * CHIAMATA: così ogni lettura porta la risposta del suo periodo anche se nel
 * frattempo `risposta` è cambiata.
 *
 * Serve anche al caso (11): la finestra IN VOLO — quella in cui l'elenco
 * vecchio non deve più esserci — esiste solo se la rete non risponde subito.
 */
let trattieni = false
const appese: Array<() => void> = []
const rilascia = (i: number) => appese[i]()

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    chiamate.push(url)
    if (url.includes('/api/primaria/compiti')) {
        const fotografia = coda.length > 0 ? (coda.shift() as Risposta) : { ...risposta }
        const res = {
            ok: fotografia.ok,
            status: fotografia.stato,
            json: async () => fotografia.corpo,
        } as unknown as Response
        if (!trattieni) return res
        return new Promise<Response>((resolve) => appese.push(() => resolve(res)))
    }
    // Le due letture della cornice di classe (nome della classe e ruolo).
    if (url.includes('/api/primaria/classe/')) {
        return {
            ok: true, status: 200,
            json: async () => ({ success: true, data: { section: { id: SEZIONE, name: '3 A' } } }),
        } as unknown as Response
    }
    return {
        ok: true, status: 200,
        json: async () => ({ success: true, data: { ruolo: 'educator' } }),
    } as unknown as Response
})

/** Una pagina di risposta: le voci e il cursore della SUCCESSIVA (`null` = finita). */
function pagina(compiti: Voce[], prossimoCursore: string | null = null): Risposta {
    return { ok: true, stato: 200, corpo: { success: true, data: { compiti, prossimoCursore } } }
}

function rispondiCon(compiti: Voce[], prossimoCursore: string | null = null): void {
    risposta = pagina(compiti, prossimoCursore)
}

/** Le sole letture dei compiti, in ordine. */
const chiamateCompiti = () => chiamate.filter((u) => u.includes('/api/primaria/compiti'))
const parametro = (url: string, nome: string) => new URL(url, 'http://localhost').searchParams.get(nome)
const dataDaDi = (url: string) => parametro(url, 'dataDa') ?? ''

beforeEach(() => {
    vi.clearAllMocks()
    chiamate.length = 0
    trattieni = false
    appese.length = 0
    coda = []
    stub.params = { sectionId: SEZIONE }
    stub.search = new URLSearchParams(`userId=${DOCENTE}`)
    rispondiCon([])
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date(MEZZOGIORNO_18))
})

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.useRealTimers()
})

import CompitiPage from '@/app/(dashboard)/teacher/primaria/[sectionId]/compiti/page'
import { ClasseShell } from '@/components/features/primaria/ClasseShell'

/** Una voce minima: i campi che non interessano al caso restano vuoti. */
function voce(p: Partial<Voce> & { id: string; data: string; ora_lezione: number }): Voce {
    return {
        materia: 'Italiano',
        compiti: 'Esercizi pagina 12',
        data_consegna_compiti: null,
        allegati: [],
        individualizzati: [],
        ...p,
    }
}

/** Le righe dell'elenco, ciascuna letta come «data + ora» DENTRO la propria riga. */
const ordineVisibile = () =>
    screen.getAllByRole('listitem').map((li) => {
        const data = within(li).getAllByText(/^\d{2}\/\d{2}\/\d{4}$/)[0].textContent
        const ora = within(li).getByText(/ª ora$/).textContent
        return `${data} ${ora}`
    })

const bottoneCaricaAltri = () =>
    screen.queryByRole('button', { name: new RegExp(itShared.classeCompitiCaricaAltri, 'i') })

describe('classe · linguetta «Compiti»', () => {
    it('(1) rende le voci in ordine di data DISCENDENTE, e per ora crescente nello stesso giorno', async () => {
        // Volutamente in disordine: se la pagina si limitasse a rendere ciò che
        // arriva, questo caso mostrerebbe l'ordine della rete finta.
        rispondiCon([
            voce({ id: 'c3', data: '2026-09-03', ora_lezione: 3 }),
            voce({ id: 'c1b', data: '2026-09-10', ora_lezione: 4 }),
            voce({ id: 'c2', data: '2026-09-12', ora_lezione: 2 }),
            voce({ id: 'c1a', data: '2026-09-10', ora_lezione: 1 }),
        ])

        render(<CompitiPage />)

        await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(4))
        expect(
            ordineVisibile(),
            'La linguetta promette «i compiti dal più recente»: una promessa che dipende ' +
                'dall’.order() di un altro file si rompe in silenzio.',
        ).toEqual([
            '12/09/2026 2ª ora',
            '10/09/2026 1ª ora',
            '10/09/2026 4ª ora',
            '03/09/2026 3ª ora',
        ])
    })

    it('(2) «Consegna entro …» solo dove la scadenza c’è ED È UNA DATA', async () => {
        rispondiCon([
            voce({ id: 'con', data: '2026-09-12', ora_lezione: 1, compiti: 'Scheda 4', data_consegna_compiti: '2026-09-25' }),
            voce({ id: 'senza', data: '2026-09-11', ora_lezione: 1, compiti: 'Lettura' }),
            // Stringa NON vuota ma nemmeno una data: è il 200 malformato per cui
            // `vocePulita` esiste, e che normalizza il TIPO e non la FORMA.
            // `isoToIt` le risponde `''`, e una guardia sul solo «non vuoto»
            // stampava «Consegna entro il » con la pastiglia verde vuota.
            voce({ id: 'storta', data: '2026-09-10', ora_lezione: 1, compiti: 'Disegno', data_consegna_compiti: '25/09/2026' }),
        ])

        render(<CompitiPage />)
        await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(3))

        const [conScadenza, senzaScadenza, storta] = screen.getAllByRole('listitem')
        expect(within(conScadenza).getByText(/Consegna entro il 25\/09\/2026/)).toBeInTheDocument()
        expect(
            within(senzaScadenza).queryByText(/Consegna entro/),
            'Una scadenza mostrata dove non c’è è una scadenza inventata.',
        ).toBeNull()
        // Prima la PRESENZA della riga, poi la negazione.
        expect(within(storta).getByText('Disegno')).toBeInTheDocument()
        expect(
            within(storta).queryByText(/Consegna entro/),
            '«Consegna entro il » con lo spazio finale e la pastiglia vuota è una scadenza ' +
                'inventata scritta peggio: non si sa quando, e sembra che si sappia.',
        ).toBeNull()
    })

    it('(3) l’assegnazione mirata mostra il CONTEGGIO dei destinatari e nessun nome', async () => {
        rispondiCon([
            voce({
                id: 'tre', data: '2026-09-12', ora_lezione: 1, compiti: null,
                // Campi in più di proposito: se un giorno la pagina rendesse
                // «tutto quello che arriva», il nome finto comparirebbe a schermo.
                individualizzati: [
                    { compiti: 'Scheda facilitata', destinatari: 3, alunni: ['Mario Rossi'] } as never,
                ],
            }),
            voce({
                id: 'uno', data: '2026-09-11', ora_lezione: 2, compiti: null,
                individualizzati: [{ compiti: 'Lettura guidata', destinatari: 1 }],
            }),
            voce({
                id: 'zero', data: '2026-09-10', ora_lezione: 3, compiti: null,
                individualizzati: [{ compiti: 'Recupero di matematica', destinatari: 0 }],
            }),
        ])

        render(<CompitiPage />)
        await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(3))

        const [tre, uno, zero] = screen.getAllByRole('listitem')
        expect(within(tre).getByText('Individualizzato · 3 alunni')).toBeInTheDocument()
        expect(within(tre).getByText('Scheda facilitata')).toBeInTheDocument()
        // Il plurale ICU deve dire due cose diverse: «1 alunni» è il difetto che
        // il lock dei plurali esiste per prendere.
        expect(within(uno).getByText('Individualizzato · 1 alunno')).toBeInTheDocument()

        // ZERO destinatari non è una quantità: è un collegamento che manca. Il
        // compito però esiste — qualcuno l'ha scritto — e resta a schermo.
        expect(
            within(zero).getByText(itShared.classeCompitiIndividualizzatoSenzaDestinatari),
        ).toBeInTheDocument()
        expect(
            within(zero).queryByText(/0 alunni/),
            '«Individualizzato · 0 alunni» afferma che quel compito non è di nessuno.',
        ).toBeNull()
        expect(within(zero).getByText('Recupero di matematica')).toBeInTheDocument()

        expect(
            screen.queryByText(/Mario Rossi/),
            'Chi ha i compiti a parte è un’informazione sul singolo minore: qui non serve ' +
                'a nessuna decisione, e infatti la route restituisce un intero.',
        ).toBeNull()
    })

    it('(4) un allegato con `file_url: null` mostra il nome ma NON un link', async () => {
        rispondiCon([
            voce({
                id: 'all', data: '2026-09-12', ora_lezione: 1,
                allegati: [
                    { id: 'a1', tipo: 'pdf', ambito: 'compiti', file_name: 'compito-1.pdf', file_url: 'https://storage.example/firmato' },
                    { id: 'a2', tipo: 'image', ambito: 'compiti', file_name: 'foto-lavagna.jpg', file_url: null },
                ],
            }),
        ])

        render(<CompitiPage />)
        await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1))

        // Prima la PRESENZA: il nome del file non firmato si vede comunque.
        expect(screen.getByText(/foto-lavagna\.jpg/)).toBeInTheDocument()
        expect(screen.getByRole('link', { name: /compito-1\.pdf/ })).toHaveAttribute(
            'href',
            'https://storage.example/firmato',
        )
        expect(
            screen.queryByRole('link', { name: /foto-lavagna\.jpg/ }),
            'Un’ancora verso `null` porta a `…/compiti/null`: una 404 al posto di un ' +
                'documento, e sembra che il file non ci sia più.',
        ).toBeNull()
    })

    it('(5) cambiando periodo riparte la lettura col `dataDa` giusto, e l’anno è quello SCOLASTICO', async () => {
        render(<CompitiPage />)

        await waitFor(() => expect(chiamateCompiti()).toHaveLength(1))
        expect(dataDaDi(chiamateCompiti()[0]), 'il periodo predefinito è «ultimi 30 giorni»').toBe(DA_30)
        expect(
            parametro(chiamateCompiti()[0], 'cursore'),
            'La prima pagina di un periodo non ha nessun cursore da rimandare.',
        ).toBeNull()

        fireEvent.click(screen.getByRole('button', { name: itShared.classeCompitiPeriodo90 }))
        await waitFor(() => expect(chiamateCompiti()).toHaveLength(2))
        expect(dataDaDi(chiamateCompiti()[1])).toBe(DA_90)

        fireEvent.click(screen.getByRole('button', { name: itShared.classeCompitiPeriodoAnno }))
        await waitFor(() => expect(chiamateCompiti()).toHaveLength(3))
        expect(
            dataDaDi(chiamateCompiti()[2]),
            'L’anno di questa linguetta è l’anno SCOLASTICO (1° agosto), non l’anno solare di ' +
                '`annoFiscale()`, che sta in un modulo di fatturazione e parla di data documento.',
        ).toBe(DA_ANNO)

        // Il tetto della route (400 oltre 365 giorni) NON si prova qui: fra due
        // costanti congelate il conto non può diventare rosso per nessuna
        // modifica al codice. Sta nel caso (9), sul valore davvero chiesto.

        // La sezione viaggia sempre, e l'identità pure: una lettura senza sede
        // archivierebbe la domanda nel plesso sbagliato in silenzio.
        expect(parametro(chiamateCompiti()[2], 'sectionId')).toBe(SEZIONE)
        expect(parametro(chiamateCompiti()[2], 'userId')).toBe(DOCENTE)
    })

    it('(6) lo stato vuoto NOMINA il periodo, nessun comando lo restringe, e la lettura fallita dice «Riprova»', async () => {
        rispondiCon([])
        render(<CompitiPage />)

        // ── periodo predefinito: il vuoto dice SU QUANTI GIORNI ───────────────
        // «Nessun compito assegnato» e basta lascia senza la sola informazione
        // che serve a decidere il passo dopo: se allargare o chiudere la pagina.
        await waitFor(() =>
            expect(screen.getByText(/Nessun compito assegnato negli ultimi 30 giorni/)).toBeInTheDocument(),
        )
        expect(
            screen.queryByText(itShared.filtriSenzaRisultatiTitolo),
            'Dire «nessun risultato con questi filtri» a chi non ha messo nessun filtro lo ' +
                'manda a cercare un filtro che non esiste: il periodo è la CORNICE, non un filtro.',
        ).toBeNull()

        // ── «Anno scolastico», ancora zero righe: il vuoto cambia frase ───────
        fireEvent.click(screen.getByRole('button', { name: itShared.classeCompitiPeriodoAnno }))
        await waitFor(() => expect(screen.getByText(itShared.classeCompitiVuotoAnno)).toBeInTheDocument())
        expect(screen.queryByText(/Nessun compito assegnato negli ultimi 30 giorni/)).toBeNull()
        expect(screen.queryByText(itShared.filtriSenzaRisultatiTitolo)).toBeNull()

        // ── NESSUN COMANDO RESTRINGE IL PERIODO ───────────────────────────────
        // Misurato prima della correzione: con l'anno attivo, «Pulisci filtri»
        // portava `dataDa` dal 1° gennaio al 19 agosto — toglieva righe invece di
        // restituirle, proprio nel momento in cui si chiede di rivedere tutto.
        expect(screen.queryByRole('button', { name: itShared.filtriPulisci })).toBeNull()
        const gruppoPeriodo = screen.getByRole('group')
        // Le tre pastiglie restano: quelle sono una scelta dichiarata, non una
        // pulizia. Si cliccano tutti gli ALTRI bottoni, uno per uno.
        for (const b of screen.getAllByRole('button').filter((x) => !gruppoPeriodo.contains(x))) {
            fireEvent.click(b)
        }
        await act(async () => {})
        expect(
            chiamateCompiti().map(dataDaDi).filter((d) => d !== DA_30 && d !== DA_ANNO),
            'Nessuna lettura con un periodo che nessuno ha scelto: gli unici `dataDa` visti ' +
                'sono quello di partenza e quello dell’anno scolastico.',
        ).toEqual([])
        expect(
            dataDaDi(chiamateCompiti()[chiamateCompiti().length - 1]),
            'Nessun comando dello stato vuoto può riportare il periodo indietro: l’ultima ' +
                'lettura resta quella dell’anno scolastico.',
        ).toBe(DA_ANNO)

        // ── la lettura FALLISCE: non è un vuoto ───────────────────────────────
        risposta = { ok: false, stato: 500, corpo: { error: 'Non siamo riusciti a leggere i compiti della classe.' } }
        fireEvent.click(screen.getByRole('button', { name: itShared.classeCompitiPeriodo90 }))

        await waitFor(() => expect(screen.getByText(itShared.classeCompitiErroreTitolo)).toBeInTheDocument())
        expect(screen.getByRole('button', { name: itShared.paginaErroreRiprova })).toBeInTheDocument()
        expect(
            screen.queryByText(/Nessun compito assegnato/),
            'Una lettura fallita non è «nessun compito assegnato»: è una frase che verrebbe ' +
                'ripetuta in buona fede a un genitore che chiede conto.',
        ).toBeNull()
        expect(screen.queryByText(itShared.filtriSenzaRisultatiTitolo)).toBeNull()

        // «Riprova» rilegge davvero.
        const prima = chiamateCompiti().length
        fireEvent.click(screen.getByRole('button', { name: itShared.paginaErroreRiprova }))
        await waitFor(() => expect(chiamateCompiti().length).toBe(prima + 1))
    })

    it('(8) al 10 gennaio «Anno scolastico» NON è più stretto di «Ultimi 90 giorni»', async () => {
        // Le tre pastiglie si leggono come una scala che si allarga. Col 1°
        // gennaio come inizio la scala andava ALL'INDIETRO da gennaio a marzo —
        // il 10 gennaio «anno» copriva 9 giorni contro i 90 della pastiglia
        // accanto — e proprio nel trimestre in cui i compiti sono più fitti.
        vi.setSystemTime(new Date('2027-01-10T10:00:00Z'))
        render(<CompitiPage />)
        await waitFor(() => expect(chiamateCompiti()).toHaveLength(1))

        fireEvent.click(screen.getByRole('button', { name: itShared.classeCompitiPeriodo90 }))
        await waitFor(() => expect(chiamateCompiti()).toHaveLength(2))
        const da90 = dataDaDi(chiamateCompiti()[1])

        fireEvent.click(screen.getByRole('button', { name: itShared.classeCompitiPeriodoAnno }))
        await waitFor(() => expect(chiamateCompiti()).toHaveLength(3))
        const daAnno = dataDaDi(chiamateCompiti()[2])

        // Confronto lessicografico su `YYYY-MM-DD`: coincide con quello di calendario.
        expect(
            daAnno <= da90,
            `Chi clicca «Anno scolastico» per vedere DI PIÙ non può vedere DI MENO: ` +
                `anno=${daAnno}, 90 giorni=${da90}.`,
        ).toBe(true)
        expect(daAnno, 'l’anno scolastico 2026/2027 apre il 1° agosto 2026').toBe('2026-08-01')
    })

    it('(9) il tetto vero: al 31 luglio di un anno BISESTILE il clamp ferma l’anno a 364 giorni', async () => {
        // Perché proprio questo giorno. L'anno scolastico apre il 1° agosto,
        // quindi la distanza massima la si ha il 31 luglio: 364 giorni in un anno
        // normale, **365** quando in mezzo cade un 29 febbraio (1/8/2027 →
        // 31/7/2028). E 365 è il margine ZERO del controllo della route
        // (`giorni > 365`), che per giunta misura col PROPRIO orologio: il
        // `dataDa` lo calcola il client, e una richiesta composta alle 23:59:59 e
        // valutata un secondo dopo vale 366 → 400, con «Riprova» che ritenta
        // all'infinito perché a invecchiare è la data, non la rete.
        vi.setSystemTime(new Date('2028-07-31T10:00:00Z'))
        render(<CompitiPage />)
        await waitFor(() => expect(chiamateCompiti()).toHaveLength(1))

        fireEvent.click(screen.getByRole('button', { name: itShared.classeCompitiPeriodoAnno }))
        await waitFor(() => expect(chiamateCompiti()).toHaveLength(2))

        // Il conto si fa sul valore CHIESTO, non fra due costanti congelate: è la
        // differenza fra un test e una decorazione.
        const da = dataDaDi(chiamateCompiti()[1])
        const giorni = Math.round(
            (Date.parse('2028-07-31T00:00:00Z') - Date.parse(`${da}T00:00:00Z`)) / 86_400_000,
        )
        expect(giorni, `${da} → 31/07/2028 sono ${giorni} giorni: sopra 364 il margine è zero`).toBeLessThanOrEqual(364)
        expect(da, 'il 1° agosto 2027 dista 365 giorni: il clamp deve averlo spostato di uno').toBe('2027-08-02')
    })

    it('(10) due click rapidi: la risposta in RITARDO non sovrascrive la più recente', async () => {
        trattieni = true
        rispondiCon([voce({ id: 'm', data: '2026-09-15', ora_lezione: 1, compiti: 'RISPOSTA DEL MONTAGGIO' })])
        render(<CompitiPage />)
        await waitFor(() => expect(chiamateCompiti()).toHaveLength(1))
        await act(async () => rilascia(0))
        await waitFor(() => expect(screen.getByText('RISPOSTA DEL MONTAGGIO')).toBeInTheDocument())

        // Due click di fila, con tutte e due le letture in volo insieme.
        rispondiCon([voce({ id: 'v', data: '2026-07-01', ora_lezione: 1, compiti: 'RISPOSTA VECCHIA (90 giorni)' })])
        fireEvent.click(screen.getByRole('button', { name: itShared.classeCompitiPeriodo90 }))
        await waitFor(() => expect(chiamateCompiti()).toHaveLength(2))

        rispondiCon([voce({ id: 'n', data: '2026-08-05', ora_lezione: 1, compiti: 'RISPOSTA NUOVA (anno)' })])
        fireEvent.click(screen.getByRole('button', { name: itShared.classeCompitiPeriodoAnno }))
        await waitFor(() => expect(chiamateCompiti()).toHaveLength(3))

        // L'anno risponde per primo…
        await act(async () => rilascia(2))
        await waitFor(() => expect(screen.getByText('RISPOSTA NUOVA (anno)')).toBeInTheDocument())
        // …e i 90 giorni atterrano DOPO. `act` porta a termine la catena di
        // promesse: se la guardia non ci fosse, il `set` sarebbe già avvenuto.
        await act(async () => rilascia(1))

        expect(
            screen.getByText('RISPOSTA NUOVA (anno)'),
            'A schermo resta l’elenco del periodo premuto: una risposta in ritardo che ' +
                'sovrascrive la più recente lascia una lista che non è quella che si sta guardando.',
        ).toBeInTheDocument()
        expect(screen.queryByText('RISPOSTA VECCHIA (90 giorni)')).toBeNull()
        expect(screen.getByRole('button', { name: itShared.classeCompitiPeriodoAnno })).toHaveAttribute(
            'aria-pressed',
            'true',
        )
    })

    it('(11) cambiando periodo l’elenco vecchio sparisce SUBITO, prima che la nuova lettura risponda', async () => {
        // 🔴 IL DIFETTO MISURATO: pastiglia «Anno scolastico» già premuta
        // (`aria-pressed="true"`), elenco ancora quello dei 30 giorni, spinner
        // assente — per tutto il tempo della lettura, che su WebView sono
        // secondi. La guardia di sequenza non basta: quella chiude l'atterraggio
        // FUORI ORDINE, non la finestra IN VOLO.
        trattieni = true
        rispondiCon([voce({ id: 'vecchia', data: '2026-09-15', ora_lezione: 1, compiti: 'COMPITO DEI 30 GIORNI' })])
        render(<CompitiPage />)
        await waitFor(() => expect(chiamateCompiti()).toHaveLength(1))
        await act(async () => rilascia(0))
        await waitFor(() => expect(screen.getByText('COMPITO DEI 30 GIORNI')).toBeInTheDocument())

        // Il click, e NESSUN rilascio: siamo dentro la finestra in volo.
        rispondiCon([voce({ id: 'nuova', data: '2026-08-05', ora_lezione: 1, compiti: 'COMPITO DELL’ANNO' })])
        fireEvent.click(screen.getByRole('button', { name: itShared.classeCompitiPeriodoAnno }))

        // Prima la PRESENZA di qualcosa — qui lo spinner, che si annuncia — e
        // solo dopo la negazione: un `waitFor` su un'assenza sarebbe vero anche
        // mentre la fetch è ancora in volo, cioè sempre.
        await waitFor(() => expect(screen.getByText(itShared.caricamentoInCorso)).toBeInTheDocument())
        expect(
            screen.queryByText('COMPITO DEI 30 GIORNI'),
            'La pastiglia dice «Anno scolastico» e l’elenco è quello dei 30 giorni: è un ' +
                'elenco che non è quello che si sta guardando, e niente addosso che lo dica.',
        ).toBeNull()
        expect(screen.queryByRole('listitem')).toBeNull()
        expect(screen.getByRole('button', { name: itShared.classeCompitiPeriodoAnno })).toHaveAttribute(
            'aria-pressed',
            'true',
        )

        // E quando la lettura arriva, c'è l'elenco nuovo.
        await act(async () => rilascia(1))
        await waitFor(() => expect(screen.getByText('COMPITO DELL’ANNO')).toBeInTheDocument())
    })

    it('(12) `ambito` si legge: l’allegato dell’ARGOMENTO porta la sua marca, quello dei compiti no', async () => {
        // 🔴 PERCHÉ NON È TEORICO: `primaria/allegati:POST` ha
        // `.default('argomento')` e l'unico caricatore dell'app non manda mai il
        // campo. Senza questa marca il 100% degli allegati comparirebbe sotto la
        // parola «Compiti» come se fosse il compito — e con `allegati_registro` a
        // zero righe nessuno se ne accorgerebbe per mesi.
        rispondiCon([
            voce({
                id: 'amb', data: '2026-09-12', ora_lezione: 1,
                allegati: [
                    { id: 'a1', tipo: 'image', ambito: 'argomento', file_name: 'lavagna.jpg', file_url: 'https://storage.example/1' },
                    { id: 'a2', tipo: 'pdf', ambito: 'compiti', file_name: 'scheda.pdf', file_url: 'https://storage.example/2' },
                    // Il campo assente NON è «argomento»: è «non si sa». Dirlo
                    // «dell'argomento» sarebbe inventare il dato.
                    { id: 'a3', tipo: 'pdf', file_name: 'ignoto.pdf', file_url: 'https://storage.example/3' },
                ],
            }),
        ])

        render(<CompitiPage />)
        await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1))

        const argomento = screen.getByRole('link', { name: /lavagna\.jpg/ })
        const compito = screen.getByRole('link', { name: /scheda\.pdf/ })
        const ignoto = screen.getByRole('link', { name: /ignoto\.pdf/ })

        expect(
            within(argomento).getByText(new RegExp(itShared.classeCompitiAllegatoArgomento)),
            'La route espone `ambito` apposta e scrive che «a etichettarlo è la linguetta»: ' +
                'la linguetta è questa.',
        ).toBeInTheDocument()
        // Il CONTENUTO INTERO della pastiglia, non «non c'è la parola argomento»:
        // una marca sbagliata ma diversa passerebbe la negazione e resterebbe a
        // schermo. Una marca su tutti gli allegati insegna a ignorarla.
        expect(
            compito.textContent?.trim(),
            'Un allegato che È dei compiti non porta NESSUNA marca.',
        ).toBe('scheda.pdf')
        expect(
            within(ignoto).getByText(new RegExp(itShared.classeCompitiAllegatoAmbitoIgnoto)),
        ).toBeInTheDocument()
    })

    it('(13) «Carica altri»: accoda la pagina successiva, rimanda il cursore IDENTICO, e sparisce quando è finito', async () => {
        coda = [
            pagina([voce({ id: 'p1', data: '2026-09-12', ora_lezione: 1, compiti: 'PRIMA PAGINA' })], 'CURSORE::OPACO/1=='),
            pagina([voce({ id: 'p2', data: '2026-09-05', ora_lezione: 1, compiti: 'SECONDA PAGINA' })], null),
        ]
        render(<CompitiPage />)
        await waitFor(() => expect(screen.getByText('PRIMA PAGINA')).toBeInTheDocument())

        const bottone = bottoneCaricaAltri()
        expect(bottone, 'col cursore ancora vivo il comando per leggere il resto deve esserci').not.toBeNull()

        fireEvent.click(bottone as HTMLElement)
        await waitFor(() => expect(screen.getByText('SECONDA PAGINA')).toBeInTheDocument())

        // Le righe della prima pagina RESTANO: una paginazione che sostituisce
        // invece di accodare è un elenco che si accorcia mentre lo si legge.
        expect(screen.getByText('PRIMA PAGINA')).toBeInTheDocument()
        expect(screen.getAllByRole('listitem')).toHaveLength(2)
        // E restano in ordine: le pagine si accodano, l'ordine no.
        expect(ordineVisibile()).toEqual(['12/09/2026 1ª ora', '05/09/2026 1ª ora'])

        expect(
            parametro(chiamateCompiti()[1], 'cursore'),
            'Il cursore è OPACO: si rimanda byte per byte. Ricostruirlo o normalizzarlo ' +
                'significa decidere al posto della route come è fatto.',
        ).toBe('CURSORE::OPACO/1==')
        // Il periodo non cambia mentre si pagina: il seguito è dello stesso tratto.
        expect(dataDaDi(chiamateCompiti()[1])).toBe(DA_30)

        expect(
            bottoneCaricaAltri(),
            'Cursore finito: l’ASSENZA del comando è l’unico modo in cui questa pagina dice ' +
                '«non c’è altro», e deve essere vera.',
        ).toBeNull()
    })

    it('(14) una pagina VUOTA con un cursore valido NON è «non ci sono compiti»', async () => {
        // 🔴 LA TRAPPOLA DICHIARATA DALLA ROUTE: pagina le RIGHE DI REGISTRO e
        // restituisce solo quelle con un compito. Una settimana senza compiti è
        // una pagina piena di righe vere e vuota di compiti — con il cursore
        // ancora vivo. Fermarsi lì direbbe a un docente che la sua classe non ha
        // compiti mentre ne restano da leggere.
        trattieni = true
        coda = [
            pagina([], 'CURSORE/1'),
            pagina([], 'CURSORE/2'),
            pagina([voce({ id: 'fin', data: '2026-09-02', ora_lezione: 1, compiti: 'IL COMPITO IN FONDO' })], null),
        ]
        render(<CompitiPage />)
        await waitFor(() => expect(chiamateCompiti()).toHaveLength(1))

        // Prima pagina: zero compiti, cursore vivo.
        await act(async () => rilascia(0))
        // Prima la PRESENZA — lo spinner c'è ancora, la lettura non è finita —
        // poi la negazione della frase che non si può dire.
        await waitFor(() => expect(screen.getByText(itShared.caricamentoInCorso)).toBeInTheDocument())
        expect(
            screen.queryByText(/Nessun compito assegnato/),
            '«Nessun compito in questa pagina» non è «non ci sono più compiti»: con un ' +
                'cursore ancora in mano quella frase è un’affermazione non provata.',
        ).toBeNull()
        expect(screen.queryByText(itShared.classeCompitiVuotoAnno)).toBeNull()

        // La lettura è andata avanti DA SOLA, senza che l'utente tocchi niente.
        await waitFor(() => expect(chiamateCompiti()).toHaveLength(2))
        expect(parametro(chiamateCompiti()[1], 'cursore')).toBe('CURSORE/1')

        await act(async () => rilascia(1))
        await waitFor(() => expect(chiamateCompiti()).toHaveLength(3))
        expect(parametro(chiamateCompiti()[2], 'cursore')).toBe('CURSORE/2')

        await act(async () => rilascia(2))
        await waitFor(() => expect(screen.getByText('IL COMPITO IN FONDO')).toBeInTheDocument())
        expect(
            bottoneCaricaAltri(),
            'Arrivati in fondo il cursore è finito: solo allora la pagina può tacere.',
        ).toBeNull()
    })

    it('(14 bis) lo stato VUOTO non può convivere con un cursore: o non c’è più niente, o si sta leggendo', async () => {
        // L'invariante scritta a parole nel commit di `leggi`, misurata: si esce
        // dal giro solo con righe in mano, col cursore finito, o con un guasto.
        // Qui il cursore finisce sull'ultima pagina, e solo lì compare il vuoto.
        coda = [pagina([], 'ANCORA/1'), pagina([], 'ANCORA/2'), pagina([], null)]
        render(<CompitiPage />)

        await waitFor(() =>
            expect(screen.getByText(/Nessun compito assegnato negli ultimi 30 giorni/)).toBeInTheDocument(),
        )
        expect(chiamateCompiti(), 'tre pagine lette, non una').toHaveLength(3)
        expect(
            bottoneCaricaAltri(),
            'Il vuoto e il comando «leggi il resto» non possono stare a schermo insieme: uno ' +
                'dei due sta mentendo.',
        ).toBeNull()
    })

    it('(15) un seguito FALLITO lascia a schermo le righe già lette, e lo dice in modo diverso dal vuoto', async () => {
        coda = [
            pagina([voce({ id: 'ok', data: '2026-09-12', ora_lezione: 1, compiti: 'COMPITO GIÀ LETTO' })], 'CURSORE/A'),
            { ok: false, stato: 500, corpo: { error: 'Non siamo riusciti a leggere i compiti della classe.' } },
        ]
        render(<CompitiPage />)
        await waitFor(() => expect(screen.getByText('COMPITO GIÀ LETTO')).toBeInTheDocument())

        fireEvent.click(bottoneCaricaAltri() as HTMLElement)
        await waitFor(() => expect(screen.getByText(itShared.classeCompitiErroreAltri)).toBeInTheDocument())

        expect(
            screen.getByText('COMPITO GIÀ LETTO'),
            'Quei compiti sono stati letti e sono veri: un guasto sul SEGUITO non può ' +
                'cancellarli per sostituirli con una schermata d’errore.',
        ).toBeInTheDocument()
        expect(
            screen.queryByText(itShared.classeCompitiErroreTitolo),
            'Il guasto della prima pagina e quello del seguito sono due cose diverse.',
        ).toBeNull()
        expect(screen.queryByText(/Nessun compito assegnato/)).toBeNull()

        // Il cursore si CONSERVA: un errore di rete non è la fine dell'elenco, e
        // il comando per riprovare è lì.
        const bottone = bottoneCaricaAltri()
        expect(bottone, 'senza il cursore l’elenco resterebbe monco senza dirlo').not.toBeNull()
        coda = [pagina([voce({ id: 'ok2', data: '2026-09-04', ora_lezione: 1, compiti: 'IL RESTO' })], null)]
        fireEvent.click(bottone as HTMLElement)
        await waitFor(() => expect(screen.getByText('IL RESTO')).toBeInTheDocument())
        expect(parametro(chiamateCompiti()[2], 'cursore')).toBe('CURSORE/A')
        expect(screen.queryByText(itShared.classeCompitiErroreAltri)).toBeNull()
    })

    it('(16) l’anno scolastico si decide sulla STESSA lettura dell’orologio da cui esce «oggi»', async () => {
        // Il difetto vero non si può mettere in scena con l'orologio fermo: nasce
        // dai microsecondi fra due letture di `new Date()` a cavallo della
        // mezzanotte romana del 1° agosto, quando «oggi» è ancora il 31 luglio e
        // l'anno scolastico è già quello nuovo — e `dataDa` esce UN GIORNO NEL
        // FUTURO. Quello che si misura è la condizione che lo rende impossibile:
        // l'istante viene PASSATO, non riletto.
        vi.setSystemTime(new Date('2026-07-31T22:30:00Z')) // 1° agosto, 00:30 a Roma
        render(<CompitiPage />)
        await waitFor(() => expect(chiamateCompiti()).toHaveLength(1))

        spie.annoScolastico.mockClear()
        fireEvent.click(screen.getByRole('button', { name: itShared.classeCompitiPeriodoAnno }))
        await waitFor(() => expect(chiamateCompiti()).toHaveLength(2))

        expect(spie.annoScolastico).toHaveBeenCalled()
        const passato = spie.annoScolastico.mock.calls[0][0] as Date | undefined
        expect(
            passato,
            'Senza argomento `annoScolasticoCorrente()` rilegge l’orologio: due letture con la ' +
                'soglia del 1° agosto in mezzo, e `dataDa` può uscire nel futuro.',
        ).toBeInstanceOf(Date)

        // E l'istante passato è lo STESSO giorno civile italiano da cui esce
        // «oggi»: si ricava dal periodo dei 30 giorni, che è oggi meno 30.
        const giornoRomano = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' })
        const oggi = new Date(Date.parse(`${dataDaDi(chiamateCompiti()[0])}T12:00:00Z`) + 30 * 86_400_000)
        expect(giornoRomano.format(passato as Date)).toBe(giornoRomano.format(oggi))

        // E il conto finale: l'inizio del periodo non è mai nel futuro.
        expect(dataDaDi(chiamateCompiti()[1]) <= giornoRomano.format(oggi)).toBe(true)
    })

    it('(17) un 200 MALFORMATO è un guasto, e una riga monca non fa cadere il render', async () => {
        // `await res.json()` è `any`: il cast del contratto non controlla niente.
        // Un 200 senza la lista diventava `[]`, cioè «Nessun compito assegnato» —
        // un'affermazione sulla classe al posto di un guasto, la stessa
        // conflazione contro cui la route spende tre commenti.
        risposta = { ok: true, stato: 200, corpo: { success: true, data: {} } }
        render(<CompitiPage />)
        await waitFor(() => expect(screen.getByText(itShared.classeCompitiErroreTitolo)).toBeInTheDocument())
        expect(screen.getByRole('button', { name: itShared.paginaErroreRiprova })).toBeInTheDocument()
        expect(screen.queryByText(/Nessun compito assegnato/)).toBeNull()
        expect(bottoneCaricaAltri(), 'una lettura fallita non lascia un cursore da riprendere').toBeNull()

        // Una riga senza `individualizzati` né `allegati`: il render fa `.map()`
        // su tutti e due, ed era un `TypeError` non catturato — cioè la linguetta
        // che sparisce invece di dire che cos'è successo.
        cleanup()
        chiamate.length = 0
        risposta = {
            ok: true,
            stato: 200,
            corpo: {
                success: true,
                data: { compiti: [{ id: 'monca', data: '2026-09-12', ora_lezione: 2, compiti: 'Scheda 7' }] },
            },
        }
        render(<CompitiPage />)
        await waitFor(() => expect(screen.getByText('Scheda 7')).toBeInTheDocument())
        expect(screen.getAllByRole('listitem')).toHaveLength(1)

        // E un `prossimoCursore` che non è una stringa non diventa un cursore:
        // rimandarlo chiederebbe per sempre la stessa pagina.
        cleanup()
        chiamate.length = 0
        risposta = {
            ok: true,
            stato: 200,
            corpo: {
                success: true,
                data: {
                    compiti: [{ id: 'x', data: '2026-09-12', ora_lezione: 1, compiti: 'Scheda 8' }],
                    prossimoCursore: { non: 'una stringa' },
                },
            },
        }
        render(<CompitiPage />)
        await waitFor(() => expect(screen.getByText('Scheda 8')).toBeInTheDocument())
        expect(bottoneCaricaAltri()).toBeNull()
    })
})

describe('ClasseShell · la linguetta «Compiti» nella cornice di classe', () => {
    it('(7) esiste, sta SUBITO DOPO «Registro» e punta al segmento `compiti`', async () => {
        render(
            <ClasseShell basePrefix="/teacher/primaria">
                <div>contenuto</div>
            </ClasseShell>,
        )

        // Presenza prima di tutto: la cornice fa due letture al montaggio.
        await waitFor(() => expect(screen.getByText('contenuto')).toBeInTheDocument())

        const nav = screen.getByRole('navigation')
        const linguette = within(nav).getAllByRole('link')
        const etichette = linguette.map((l) => l.textContent ?? '')

        const iRegistro = etichette.indexOf(itShared.classeShellTabRegistro)
        const iCompiti = etichette.indexOf(itShared.classeShellTabCompiti)

        expect(iRegistro, '«Registro» deve esserci: senza, il confronto d’ordine non prova nulla').toBeGreaterThanOrEqual(0)
        expect(
            iCompiti,
            'Chi cerca i compiti parte dal registro: la linguetta sta lì accanto, non in fondo.',
        ).toBe(iRegistro + 1)

        expect(linguette[iCompiti]).toHaveAttribute(
            'href',
            `/teacher/primaria/${SEZIONE}/compiti?userId=${DOCENTE}`,
        )
    })
})
