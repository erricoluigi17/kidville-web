import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { createTranslator } from 'use-intl'

import itServizi from '../../messages/it/parentServizi.json'
import itShared from '../../messages/it/shared.json'

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * LA BACHECA «COMPITI»: IL PERIODO, LA MATERIA, E I TRE MODI DI NON AVERE NIENTE
 *
 * ─── IL DIFETTO, misurato il 2026-09-19 ──────────────────────────────────────
 * `/parent/compiti` mostrava una finestra sola — gli ultimi 14 giorni — senza
 * alcun filtro e senza modo di spostarla. Dopo una pausa (una malattia, le
 * vacanze) il genitore leggeva «Nessun compito assegnato di recente» con il
 * registro pieno, e non aveva nessun comando da toccare per accorgersene.
 * Secondo difetto nella stessa schermata: quando la lettura FALLIVA la pagina
 * non rendeva niente (`if (d.success) setData(...)`, e nient'altro) — una rete
 * caduta si leggeva esattamente come «tuo figlio non ha compiti».
 *
 * ─── COSA DIFENDE QUESTO FILE ────────────────────────────────────────────────
 *  1. il PREIMPOSTATO non è cambiato: la prima chiamata parte SENZA `dataDa`;
 *  2. «90 giorni» calcola la data giusta (attesa scritta per esteso, non
 *     ricalcolata con le stesse funzioni del componente — sarebbe una
 *     tautologia: la stessa formula sbagliata ai due lati resta verde);
 *  3. la tendina delle materie elenca solo le materie che i compiti ce li
 *     hanno DAVVERO;
 *  4. i due vuoti dicono due frasi DIVERSE, e solo quello con un filtro attivo
 *     offre di azzerarlo — «vuoto» non nomina mai i filtri;
 *  5. una lettura fallita è un ERRORE con «Riprova», mai «nessun compito».
 *
 * ⚠️ Le due trappole evitate qui dentro: non si attende mai un'ASSENZA (un
 * `waitFor` su «non c'è l'errore» passa mentre la fetch è ancora in volo — si
 * aspetta sempre la PRESENZA di qualcosa, e solo dopo si guarda cosa manca), e
 * non si usa `getByText` dove la stessa parola compare due volte: la tendina
 * delle materie si legge con `getAllByRole('option')` dentro il suo `select`,
 * non con il nome della materia, che compare anche nelle righe dell'elenco.
 * ═════════════════════════════════════════════════════════════════════════════
 */

// ─── L'IDENTITÀ E IL ROUTER, FINTI: qui si misura la bacheca, non la sessione ─
vi.mock('next/navigation', () => ({
    usePathname: () => '/parent/compiti',
    useSearchParams: () => new URLSearchParams(),
    useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}))

vi.mock('@/lib/auth/use-parent-identity', () => ({
    useParentIdentity: () => ({
        parentId: 'p-1',
        studentId: 's-1',
        figliIds: ['s-1'],
        inAttesa: false,
        motivoAssenza: null,
        ready: true,
    }),
}))

import {
    CompitiList,
    dataDaDelPeriodo,
    PERIODO_PREDEFINITO,
    type FinestraRegistro,
    type Lezione,
} from '@/components/features/parent/LezioniCompitiSections'
import ParentCompitiPage from '@/app/(dashboard)/parent/compiti/page'

/**
 * Una frase del catalogo italiano resa col formattatore ICU VERO.
 *
 * Serve per le due righe dell'avviso di troncamento, che portano dei numeri:
 * asserire sulla stringa grezza di catalogo misurerebbe il JSON, non ciò che la
 * famiglia legge — e non vedrebbe un segnaposto mai sostituito.
 */
const rendiIt = (chiave: string, valori?: Record<string, unknown>): string =>
    (
        createTranslator({
            locale: 'it',
            messages: { parentServizi: itServizi } as never,
            namespace: 'parentServizi' as never,
            onError: (errore) => {
                throw errore
            },
        }) as unknown as (k: string, v?: Record<string, unknown>) => string
    )(chiave, valori)

// ─────────────────────────────────────────────────────────────────────────────
// Fixture
// ─────────────────────────────────────────────────────────────────────────────

const lezione = (over: Partial<Lezione> & { id: string }): Lezione => ({
    data: '2026-09-15',
    ora_lezione: 1,
    materia: null,
    argomento: null,
    compiti: null,
    data_consegna_compiti: null,
    allegati: [],
    individualizzate: [],
    ...over,
})

const MATEMATICA = lezione({ id: 'l-1', data: '2026-09-15', materia: 'Matematica', compiti: 'Esercizi 3 e 4' })
const ITALIANO = lezione({ id: 'l-2', data: '2026-09-16', materia: 'Italiano', compiti: 'Leggere pagina 12' })
// Solo ARGOMENTO: non è un compito, e la sua materia non deve comparire fra le scelte.
const STORIA_SENZA_COMPITI = lezione({ id: 'l-3', data: '2026-09-17', materia: 'Storia', argomento: 'I Sumeri' })
// Il compito arriva dalla scheda individualizzata: conta quanto quello di classe.
const INGLESE_INDIVIDUALIZZATA = lezione({
    id: 'l-4',
    data: '2026-09-18',
    materia: 'Inglese',
    individualizzate: [{ argomento: null, compiti: 'Wordlist unit 1' }],
})

// ─────────────────────────────────────────────────────────────────────────────
// La rete, finta: si registra OGNI indirizzo chiamato, perché è lì che vive il
// contratto con `GET /api/parent/primaria`.
// ─────────────────────────────────────────────────────────────────────────────

let chiamate: string[] = []
let rispondiConSuccesso = true
let lezioniServite: Lezione[] = []
/** Il campo `data.finestraRegistro` che la route finta restituisce. */
let finestraServita: FinestraRegistro = { troncata: false, lette: 2, totale: 2 }
let fetchOriginale: typeof globalThis.fetch

beforeEach(() => {
    chiamate = []
    rispondiConSuccesso = true
    lezioniServite = [MATEMATICA, ITALIANO]
    finestraServita = { troncata: false, lette: 2, totale: 2 }
    fetchOriginale = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        chiamate.push(String(input))
        return {
            ok: rispondiConSuccesso,
            json: async () =>
                rispondiConSuccesso
                    ? {
                        success: true,
                        data: {
                            schoolType: 'primaria',
                            child: { nome: 'Alunno', cognome: 'Di Prova' },
                            lezioni: lezioniServite,
                            finestraRegistro: finestraServita,
                        },
                    }
                    : { error: 'Errore interno' },
        } as unknown as Response
    }) as typeof globalThis.fetch
    // Solo `Date` è finto: `setTimeout` resta vero, altrimenti `waitFor` non
    // avanzerebbe mai e ogni attesa scadrebbe.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-19T10:00:00Z'))
})

afterEach(() => {
    cleanup()
    vi.useRealTimers()
    globalThis.fetch = fetchOriginale
})

/** L'unico `select` del periodo, preso dalla sua etichetta VISIBILE. */
const tendinaPeriodo = () => screen.getByLabelText(itServizi.compitiFiltriPeriodo) as HTMLSelectElement
const tendinaMateria = () => screen.getByLabelText(itServizi.compitiFiltriMateria) as HTMLSelectElement

// ═════════════════════════════════════════════════════════════════════════════
// 1 · IL PERIODO — quello che parte verso la route
// ═════════════════════════════════════════════════════════════════════════════

describe('il periodo: che cosa arriva a GET /api/parent/primaria', () => {
    it('il preimpostato NON manda `dataDa`: la prima chiamata è quella di sempre', async () => {
        render(<ParentCompitiPage />)
        // Si aspetta la PRESENZA del compito a schermo: un `expect(...).not.toContain`
        // fatto subito sarebbe verde anche con la fetch ancora in volo.
        await screen.findByText('Esercizi 3 e 4')

        expect(chiamate).toHaveLength(1)
        expect(chiamate[0]).toContain('studentId=s-1')
        expect(chiamate[0]).toContain('userId=p-1')
        expect(chiamate[0]).not.toContain('dataDa')
        // E la tendina parte davvero dal preimpostato.
        expect(tendinaPeriodo().value).toBe(String(PERIODO_PREDEFINITO))
    })

    it('«90 giorni» rilegge il registro con la data giusta (2026-09-19 → 2026-06-21)', async () => {
        render(<ParentCompitiPage />)
        await screen.findByText('Esercizi 3 e 4')

        lezioniServite = [INGLESE_INDIVIDUALIZZATA]
        fireEvent.change(tendinaPeriodo(), { target: { value: '90' } })

        // Presenza, non assenza: si aspetta la SECONDA chiamata e il contenuto nuovo.
        await waitFor(() => expect(chiamate).toHaveLength(2))
        await screen.findByText(/Wordlist unit 1/)

        // La data è scritta per esteso, NON ricalcolata con `addGiorni`/`oggiFiscaleISO`:
        // 21 giugno 2026 è 90 giorni esatti prima del 19 settembre 2026
        // (9 di giugno + 31 di luglio + 31 di agosto + 19 di settembre).
        expect(chiamate[1]).toContain('dataDa=2026-06-21')
    })

    it('«anno in corso» parte dal 1° agosto dell’anno scolastico, non dal 1° gennaio', () => {
        // ⚠️ Il 1° gennaio sarebbe `annoFiscale()`, che è l'anno SOLARE della
        // fatturazione: a settembre farebbe partire la bacheca da gennaio
        // (nessun compito) o, peggio, da un anno scolastico già chiuso.
        vi.setSystemTime(new Date('2026-09-19T10:00:00Z'))
        expect(dataDaDelPeriodo('anno')).toBe('2026-08-01')

        // Luglio appartiene ancora all'anno scolastico aperto in agosto.
        vi.setSystemTime(new Date('2027-07-15T10:00:00Z'))
        expect(dataDaDelPeriodo('anno')).toBe('2026-08-01')
    })

    it('il tetto del client è più stretto di quello della route: 364 giorni, non 365', () => {
        // ⚠️ MISURATO, non dedotto (2026-09-19). Dal 1° agosto 2027 al 31 luglio 2028
        // ci sono **365** giorni esatti — non 366: il 29 febbraio 2028 cade dentro
        // l'intervallo, ma l'intervallo si ferma un giorno prima del 1° agosto 2028.
        // E quei 365 la route li ACCETTA: il suo refine è `d >= oggi - 365`
        // (`parent/primaria/route.ts:88`), cioè un'uguaglianza, non un `>`. Il
        // clamp a 364 quindi NON serve a evitare un 400 che con «anno in corso»
        // non arriverebbe mai: serve contro la MEZZANOTTE. Fra il momento in cui
        // questa pagina calcola `dataDa` e quello in cui il server lo confronta col
        // PROPRIO `oggiFiscaleISO()` può passare la mezzanotte italiana, e una data
        // calcolata alle 23:59:59 a 365 giorni esatti diventa «troppo lontana» un
        // secondo dopo. Il margine costa un giorno di registro e chiude la corsa.
        vi.setSystemTime(new Date('2028-07-31T10:00:00Z'))
        expect(dataDaDelPeriodo('anno')).toBe('2027-08-02')
    })

    it('«30 giorni» conta a Roma anche a mezzanotte passata in UTC', () => {
        // 23:30 UTC del 18 settembre è già il 19 settembre in Italia: con
        // `new Date().toISOString()` (UTC) qui uscirebbe il 19 agosto.
        vi.setSystemTime(new Date('2026-09-18T23:30:00Z'))
        expect(dataDaDelPeriodo(30)).toBe('2026-08-20')
    })

    it('il plurale italiano della tendina: «Ultimo 1 giorno», non «Ultimi 1 giorno»', () => {
        // Il ramo `one` oggi non è raggiungibile dall'interfaccia — le scelte sono
        // 14, 30, 90 e «anno» — ma una forma ICU sbagliata non diventa giusta
        // perché nessuno la guarda: basta che un giorno `PERIODI_COMPITI` porti un
        // «Ultimi 1 giorno» in produzione, che è il difetto F3 del collaudo di
        // luglio, identico. La frase è resa col formattatore VERO, perché la
        // stringa di catalogo non dice da sola che cosa si legge a schermo.
        const rende = (giorni: number) =>
            (
                createTranslator({
                    locale: 'it',
                    messages: { parentServizi: itServizi } as never,
                    namespace: 'parentServizi' as never,
                    onError: (errore) => {
                        throw errore
                    },
                }) as unknown as (k: string, v: Record<string, unknown>) => string
            )('compitiPeriodoGiorni', { giorni })

        expect(rende(1)).toBe('Ultimo 1 giorno')
        expect(rende(14)).toBe('Ultimi 14 giorni')
        // E le due clausole dicono cose DIVERSE: riscriverle uguali è il modo in
        // cui un plurale ICU torna a essere «il plurale con davanti un 1».
        expect(rende(1)).not.toBe(rende(14).replace(/\b14\b/, '1'))
    })
})

// ═════════════════════════════════════════════════════════════════════════════
// 2 · LA MATERIA — solo quelle che portano compiti
// ═════════════════════════════════════════════════════════════════════════════

describe('la tendina delle materie', () => {
    it('elenca SOLO le materie che hanno compiti, non tutte quelle della classe', () => {
        render(
            <CompitiList
                lezioni={[MATEMATICA, ITALIANO, STORIA_SENZA_COMPITI, INGLESE_INDIVIDUALIZZATA]}
                onPeriodo={() => {}}
            />,
        )
        // Le opzioni si leggono DENTRO il `select`: «Matematica» compare anche
        // nelle righe dell'elenco, e `getByText` prenderebbe il sosia sbagliato.
        const voci = within(tendinaMateria())
            .getAllByRole('option')
            .map((o) => o.textContent)

        expect(voci).toEqual([itServizi.compitiMateriaTutte, 'Inglese', 'Italiano', 'Matematica'])
        expect(voci).not.toContain('Storia')
    })

    it('filtrando si riduce l’elenco, e tornando a «Tutte» torna intero', () => {
        render(<CompitiList lezioni={[MATEMATICA, ITALIANO]} onPeriodo={() => {}} />)
        expect(screen.getByText('Esercizi 3 e 4')).toBeInTheDocument()
        expect(screen.getByText('Leggere pagina 12')).toBeInTheDocument()

        fireEvent.change(tendinaMateria(), { target: { value: 'Matematica' } })
        expect(screen.getByText('Esercizi 3 e 4')).toBeInTheDocument()
        expect(screen.queryByText('Leggere pagina 12')).toBeNull()

        fireEvent.change(tendinaMateria(), { target: { value: '' } })
        expect(screen.getByText('Esercizi 3 e 4')).toBeInTheDocument()
        expect(screen.getByText('Leggere pagina 12')).toBeInTheDocument()
    })

    it('la materia scelta che il periodo non porta più rientra IN ORDINE, non in fondo', () => {
        // «Italiano» resta selezionabile anche quando i compiti serviti non la
        // portano più — altrimenti la tendina tornerebbe a dire «Tutte le materie»
        // mentre sta filtrando. Ma deve rientrare al suo posto alfabetico: appesa
        // in coda con lo spread finiva sotto «Matematica», cioè era proprio la
        // voce fuori posto a saltare all'occhio.
        const { rerender } = render(
            <CompitiList
                lezioni={[MATEMATICA, ITALIANO, INGLESE_INDIVIDUALIZZATA]}
                onPeriodo={() => {}}
            />,
        )
        fireEvent.change(tendinaMateria(), { target: { value: 'Italiano' } })

        rerender(<CompitiList lezioni={[MATEMATICA, INGLESE_INDIVIDUALIZZATA]} onPeriodo={() => {}} />)

        const voci = within(tendinaMateria())
            .getAllByRole('option')
            .map((o) => o.textContent)
        expect(voci).toEqual([itServizi.compitiMateriaTutte, 'Inglese', 'Italiano', 'Matematica'])
        // …e resta scelta: non si azzera di nascosto.
        expect(tendinaMateria().value).toBe('Italiano')
    })
})

// ═════════════════════════════════════════════════════════════════════════════
// 2-bis · LE ETICHETTE DEI DUE CONTROLLI — leggibili, o il controllo è muto
// ═════════════════════════════════════════════════════════════════════════════

describe('le etichette delle due tendine', () => {
    it('non sono dipinte con `text-kidville-muted` (3,80:1 su bianco, sotto AA)', () => {
        // ⚠️ IL NUMERO NEL NOME È STATO RIFATTO, NON RICOPIATO (2026-09-19). Questo
        // test si è chiamato «2,51:1 su bianco» per quindici giorni: era il valore
        // del VECCHIO `muted` #9AA6A2, che il 2026-09-04 è diventato #7B8582
        // (`globals.css:86-106`). Rimisurato con l'aritmetica di
        // `contrasto-token.test.ts`: **3,80:1** su bianco e 3,43:1 sul crema, contro
        // i 6,46:1 / 5,82:1 di `sub`. La conclusione non cambia — 3,80 è sotto i
        // 4,5:1 di WCAG 1.4.3 — ma un nome di test che cita una misura la sta
        // affermando, e questa era falsa.
        //
        // Sono l'UNICA indicazione di che cosa facciano i due controlli che questa
        // corsia ha aggiunto, e sono a 11px: la deroga del «testo grande» (18,66px
        // in grassetto) non si applica. Il lock
        // `__tests__/a11y/testo-muted-allowlist.test.ts` era verde con `muted` qui
        // per compensazione — un'altra occorrenza era morta nello stesso lavoro e
        // aveva lasciato il posto libero — quindi il conteggio, da solo, non
        // difendeva queste due righe. Questo test sì.
        render(<CompitiList lezioni={[MATEMATICA]} onPeriodo={() => {}} />)

        for (const testo of [itServizi.compitiFiltriPeriodo, itServizi.compitiFiltriMateria]) {
            const etichetta = screen.getByText(testo)
            expect(etichetta.tagName, `«${testo}» non è una <label>`).toBe('LABEL')
            expect(etichetta.className).not.toContain('text-kidville-muted')
            expect(etichetta.className).toContain('text-kidville-sub')
        }
    })
})

// ═════════════════════════════════════════════════════════════════════════════
// 3 · I DUE VUOTI, CHE SONO DUE FRASI DIVERSE
// ═════════════════════════════════════════════════════════════════════════════

describe('i tre modi di non avere niente a schermo', () => {
    it('nessun compito nel periodo: si nomina il PERIODO, mai i filtri', () => {
        render(<CompitiList lezioni={[STORIA_SENZA_COMPITI]} onPeriodo={() => {}} />)

        const titolo = screen.getByText(/negli ultimi 14 giorni/i)
        expect(titolo).toBeInTheDocument()
        expect(screen.getByText(itServizi.compitiVuotoPeriodoInvito)).toBeInTheDocument()
        // La regola del repo: «vuoto» non accusa i filtri di una colpa che non hanno.
        expect(titolo.textContent ?? '').not.toMatch(/filtr/i)
        expect(itServizi.compitiVuotoPeriodoInvito).not.toMatch(/filtr/i)
        // E non offre di azzerarli: non ce n'è nessuno acceso.
        expect(screen.queryByRole('button', { name: itServizi.compitiAzzeraFiltri })).toBeNull()
    })

    it('nessun compito CON QUESTI FILTRI: frase diversa, chip della materia e comando per azzerare', () => {
        const { rerender } = render(<CompitiList lezioni={[MATEMATICA, ITALIANO]} onPeriodo={() => {}} />)
        fireEvent.change(tendinaMateria(), { target: { value: 'Italiano' } })
        expect(screen.getByText('Leggere pagina 12')).toBeInTheDocument()

        // Il periodo si stringe e «Italiano» non porta più nessun compito: ci sono
        // compiti (Matematica), ma non con questo filtro.
        rerender(<CompitiList lezioni={[MATEMATICA]} onPeriodo={() => {}} />)

        expect(screen.getByText(itServizi.compitiSenzaRisultatiTitolo)).toBeInTheDocument()
        expect(screen.getByText(itServizi.compitiSenzaRisultatiCorpo)).toBeInTheDocument()
        // La scelta resta visibile nella tendina: non si azzera di nascosto.
        expect(tendinaMateria().value).toBe('Italiano')

        // E il comando c'è: premuto, l'elenco torna intero.
        const azzera = screen.getByRole('button', { name: itServizi.compitiAzzeraFiltri })
        fireEvent.click(azzera)
        expect(screen.getByText('Esercizi 3 e 4')).toBeInTheDocument()
        expect(screen.queryByText(itServizi.compitiSenzaRisultatiTitolo)).toBeNull()
    })

    it('le due frasi NON sono la stessa frase', () => {
        render(<CompitiList lezioni={[STORIA_SENZA_COMPITI]} onPeriodo={() => {}} />)
        const senzaCompiti = screen.getByText(/negli ultimi 14 giorni/i).textContent
        cleanup()

        const { rerender } = render(<CompitiList lezioni={[MATEMATICA, ITALIANO]} onPeriodo={() => {}} />)
        fireEvent.change(tendinaMateria(), { target: { value: 'Italiano' } })
        rerender(<CompitiList lezioni={[MATEMATICA]} onPeriodo={() => {}} />)
        const conFiltro = screen.getByText(itServizi.compitiSenzaRisultatiTitolo).textContent

        expect(senzaCompiti).toBeTruthy()
        expect(conFiltro).toBeTruthy()
        expect(senzaCompiti).not.toBe(conFiltro)
    })

    it('«anno in corso» non invita ad allargare un periodo che è già tutto l’anno', () => {
        render(<CompitiList lezioni={[STORIA_SENZA_COMPITI]} periodo="anno" onPeriodo={() => {}} />)
        expect(screen.getByText(itServizi.compitiVuotoAnno)).toBeInTheDocument()
        expect(screen.queryByText(itServizi.compitiVuotoPeriodoInvito)).toBeNull()
    })

    it('senza la tendina del periodo, non si manda ad allargarlo «qui sopra»', () => {
        // `onPeriodo` è facoltativo: chi non lo passa (oggi `/parent/lezioni` e le
        // schermate che montano la bacheca in sola lettura) NON ha la tendina. La
        // frase «Prova ad allargare il periodo qui sopra» manderebbe a cercare un
        // comando che non è disegnato — il caso in cui un'istruzione è peggio del
        // silenzio, perché fa dubitare chi legge della propria vista.
        render(<CompitiList lezioni={[STORIA_SENZA_COMPITI]} />)

        expect(screen.getByText(/negli ultimi 14 giorni/i)).toBeInTheDocument()
        expect(screen.queryByLabelText(itServizi.compitiFiltriPeriodo)).toBeNull()
        expect(screen.queryByText(itServizi.compitiVuotoPeriodoInvito)).toBeNull()

        // CONTROPROVA POSITIVA: con la tendina, l'invito c'è. Senza questa riga il
        // test sarebbe verde anche se l'invito fosse sparito per sempre.
        cleanup()
        render(<CompitiList lezioni={[STORIA_SENZA_COMPITI]} onPeriodo={() => {}} />)
        expect(screen.getByText(itServizi.compitiVuotoPeriodoInvito)).toBeInTheDocument()
    })

    it('periodo del tutto vuoto con una materia ancora scelta: la tendina resta, e la azzera', () => {
        // LIMITE DICHIARATO, non difetto. Con zero compiti nel periodo lo stato è
        // `vuoto` e non `senzaRisultati`, perché `totale` è PRE-filtro: la frase
        // («allarga il periodo») è vera con o senza materia. Per la stessa ragione
        // non compare «Azzera i filtri»: togliere la materia non restituirebbe
        // nessuna riga, e sarebbe un comando che promette ciò che non può dare.
        // Il filtro però non è né muto né bloccato — e questa è la parte che il
        // test deve difendere, perché dipende dalla voce «fantasma».
        const { rerender } = render(<CompitiList lezioni={[MATEMATICA, ITALIANO]} onPeriodo={() => {}} />)
        fireEvent.change(tendinaMateria(), { target: { value: 'Italiano' } })

        rerender(<CompitiList lezioni={[STORIA_SENZA_COMPITI]} onPeriodo={() => {}} />)

        expect(screen.getByText(/negli ultimi 14 giorni/i)).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: itServizi.compitiAzzeraFiltri })).toBeNull()
        // La via d'uscita: la tendina è ancora a schermo — la voce «fantasma» la
        // tiene in vita — dichiara il filtro acceso col suo valore in chiaro sotto
        // l'etichetta «Materia», e lo spegne.
        expect(tendinaMateria().value).toBe('Italiano')
        fireEvent.change(tendinaMateria(), { target: { value: '' } })
        // Spento il filtro, la tendina sparisce del tutto: in questo periodo non
        // c'è NESSUNA materia con compiti, e una tendina con la sola voce «Tutte
        // le materie» sarebbe un controllo che non controlla niente. È anche la
        // prova che era la sola voce fantasma a tenerla in piedi.
        expect(screen.queryByLabelText(itServizi.compitiFiltriMateria)).toBeNull()
        expect(screen.getByText(/negli ultimi 14 giorni/i)).toBeInTheDocument()
    })
})

// ═════════════════════════════════════════════════════════════════════════════
// 3-bis · LA FINESTRA NON LETTA PER INTERO
//
// ─── IL DIFETTO, introdotto da NOI in questo stesso ramo ─────────────────────
//
// `GET /api/parent/primaria` leggeva `registro_orario` senza `.limit()`: con la
// finestra fissa a 14 giorni non poteva far danni, ma da quando la bacheca
// arriva all'anno scolastico una classe compilata per intero (5 ore × 5 giorni ≈
// 1.000 righe l'anno) tocca il `max_rows = 1000` di PostgREST, che taglia in
// SILENZIO dentro un 200 — e con `data DESC` porta via la parte più VECCHIA.
// La route adesso ha un tetto suo e DICHIARA il taglio; questi casi difendono la
// metà che il genitore vede.
//
// ⚠️ LA TRAPPOLA CHE QUESTO BLOCCO DEVE EVITARE è una contraddizione, non una
// riga mancante: «non ho letto tutto il periodo» NON è «mancano dei compiti».
// Una classe che segna le lezioni senza mai scrivere i compiti può superare il
// tetto e restituire ZERO compiti con il troncamento vero — e lì la bacheca
// rischia di dire nello stesso schermo che il periodo è più lungo di quanto si
// legga e che conviene allargarlo.
// ═════════════════════════════════════════════════════════════════════════════

const TRONCATA: FinestraRegistro = { troncata: true, lette: 500, totale: 520 }
const INTERA: FinestraRegistro = { troncata: false, lette: 12, totale: 12 }
const avviso = () => rendiIt('compitiRegistroTroncato', { lette: 500, totale: 520 })

describe('l’avviso che il periodo non è stato letto per intero', () => {
    it('compare col totale VERO quando la finestra è troncata, e sparisce quando non lo è', () => {
        const { rerender } = render(
            <CompitiList lezioni={[MATEMATICA]} onPeriodo={() => {}} finestra={TRONCATA} />,
        )
        const banda = screen.getByText(avviso())
        expect(banda).toBeInTheDocument()
        // Il totale è quello del PERIODO (520), non quello delle righe lette
        // (500): è la differenza fra «ecco quanto non stai vedendo» e una
        // tautologia. Se qualcuno facesse derivare il totale dalle righe lette i
        // due numeri coinciderebbero e questa riga diventerebbe rossa.
        expect(banda.textContent).toContain('520')
        expect(banda.textContent).toContain('500')

        // …e sparisce. Due modi, perché sono due casi diversi: finestra letta
        // per intero, e chiamante che il campo non lo passa affatto
        // (`/parent/lezioni`, le schermate in sola lettura).
        rerender(<CompitiList lezioni={[MATEMATICA]} onPeriodo={() => {}} finestra={INTERA} />)
        expect(screen.queryByText(avviso())).toBeNull()
        rerender(<CompitiList lezioni={[MATEMATICA]} onPeriodo={() => {}} />)
        expect(screen.queryByText(avviso())).toBeNull()
    })

    it('senza il totale dice quello che sa, e non stampa «null»', () => {
        // `finestraRegistro.totale` è `null` quando il conteggio non è arrivato:
        // si sa di aver tagliato, non di quanto. Stampare «su null» — o
        // inventare un numero — sarebbe peggio del non dirlo.
        render(
            <CompitiList
                lezioni={[MATEMATICA]}
                onPeriodo={() => {}}
                finestra={{ troncata: true, lette: 500, totale: null }}
            />,
        )
        const banda = screen.getByText(rendiIt('compitiRegistroTroncatoParziale', { lette: 500 }))
        expect(banda).toBeInTheDocument()
        expect(banda.textContent).not.toMatch(/null|NaN|undefined/)
        // CONTROPROVA: la frase col totale NON è quella resa, altrimenti il
        // ramo non sarebbe stato preso e il controllo qui sopra non misurerebbe
        // niente.
        expect(screen.queryByText(avviso())).toBeNull()
    })

    it('l’avviso porta l’inchiostro FORTE: `info` sulla sua fascia vale 4,20:1, sotto AA', () => {
        // Misurato in `__tests__/a11y/contrasto-token.test.ts`, che i token li
        // legge da `globals.css`: `text-kidville-info` su `bg-kidville-info-soft`
        // è 4,20:1 — sotto i 4,5:1 di WCAG 1.4.3 — e `info-strong` è 6,74:1. Un
        // avviso dipinto col token debole è un avviso che chi ha una vista
        // imperfetta non legge, cioè il difetto che l'avviso doveva chiudere.
        render(<CompitiList lezioni={[MATEMATICA]} onPeriodo={() => {}} finestra={TRONCATA} />)
        const banda = screen.getByText(avviso())
        expect(banda.className).toContain('bg-kidville-info-soft')
        expect(banda.className).toContain('text-kidville-info-strong')
        expect(banda.className.split(/\s+/)).not.toContain('text-kidville-info')
    })
})

describe('troncamento vero con ZERO compiti: le due frasi non si contraddicono', () => {
    it('non si dice «prova ad allargare il periodo» mentre l’avviso dice che è già troppo lungo', () => {
        render(
            <CompitiList
                lezioni={[STORIA_SENZA_COMPITI]}
                periodo="anno"
                onPeriodo={() => {}}
                finestra={TRONCATA}
            />,
        )
        // PRESENZA prima di ogni assenza: l'avviso c'è davvero, quindi il ramo
        // misurato è quello giusto e non uno schermo vuoto.
        expect(screen.getByText(avviso())).toBeInTheDocument()

        // LA CONTRADDIZIONE, che è ciò che questo caso difende: l'invito ad
        // allargare è spento. Allargare, col taglio attivo, non porta indietro
        // nemmeno una riga — le lezioni lette sono le più recenti, e le più
        // recenti di una finestra più larga sono le stesse.
        expect(screen.queryByText(itServizi.compitiVuotoPeriodoInvito)).toBeNull()
        expect(screen.queryByText(itServizi.compitiVuotoAnnoInvito)).toBeNull()

        // E il titolo non afferma più niente sul periodo INTERO, che non è stato
        // letto: «Nessun compito assegnato in questo anno scolastico» sarebbe
        // una frase falsa detta sopra un avviso che dice di non aver guardato
        // tutto l'anno.
        expect(screen.queryByText(itServizi.compitiVuotoAnno)).toBeNull()
        expect(screen.queryByText(/negli ultimi \d+ giorni/i)).toBeNull()
        expect(screen.getByText(itServizi.compitiVuotoTroncato)).toBeInTheDocument()
        expect(screen.getByText(itServizi.compitiVuotoTroncatoInvito)).toBeInTheDocument()
    })

    it('CONTROPROVA: senza troncamento la stessa bacheca vuota invita ad allargare', () => {
        // Senza questo caso il precedente sarebbe verde anche se l'invito fosse
        // sparito per sempre, cioè misurerebbe un'assenza che non ha causa.
        render(<CompitiList lezioni={[STORIA_SENZA_COMPITI]} onPeriodo={() => {}} finestra={INTERA} />)
        expect(screen.getByText(itServizi.compitiVuotoPeriodoInvito)).toBeInTheDocument()
        expect(screen.getByText(/negli ultimi 14 giorni/i)).toBeInTheDocument()
        expect(screen.queryByText(itServizi.compitiVuotoTroncato)).toBeNull()
    })

    it('il plurale dell’avviso: «è mostrata la lezione più recente», non «le 1 lezioni»', () => {
        // Il ramo `one` dall'interfaccia non si raggiunge — il tetto della route
        // è nell'ordine delle centinaia, quindi `lette` vale sempre quello — ma
        // una forma ICU sbagliata non diventa giusta perché nessuno la guarda: è
        // il difetto F3 del collaudo di luglio, identico. La frase si rende col
        // formattatore VERO, perché la stringa di catalogo non dice da sola che
        // cosa si legge a schermo.
        expect(rendiIt('compitiRegistroTroncato', { lette: 1, totale: 2 })).toContain(
            'è mostrata la lezione più recente',
        )
        expect(rendiIt('compitiRegistroTroncato', { lette: 500, totale: 520 })).toContain(
            'sono mostrate le 500 lezioni più recenti',
        )
        // E le due clausole dicono cose DIVERSE: riscriverle uguali è il modo in
        // cui un plurale ICU torna a essere «il plurale con davanti un 1».
        expect(rendiIt('compitiRegistroTroncato', { lette: 1, totale: 2 })).not.toBe(
            rendiIt('compitiRegistroTroncato', { lette: 500, totale: 520 }).replace(/\b500\b/, '1'),
        )
    })

    it('l’avviso non manda a RESTRINGERE: sarebbe l’altra metà della contraddizione', () => {
        // Restringere il periodo farebbe sparire l'avviso senza mostrare una
        // riga in più — le righe lette sono già le più recenti. Un comando che
        // spegne la spia invece del guasto è peggio del comando assente, ed è
        // il motivo per cui questa frase dice un FATTO e non un'istruzione.
        for (const chiave of ['compitiRegistroTroncato', 'compitiRegistroTroncatoParziale']) {
            const testo = (itServizi as Record<string, string>)[chiave]
            expect(testo, `${chiave} manca dal catalogo`).toBeTruthy()
            expect(testo, `${chiave} manda a restringere il periodo`).not.toMatch(/restring/i)
        }
    })

    it('con dei compiti il troncamento resta detto: l’avviso non è un sostituto dell’elenco', () => {
        // L'avviso vale ANCHE quando qualcosa c'è: qualunque cosa stia sotto non
        // è la risposta all'intero periodo chiesto.
        render(<CompitiList lezioni={[MATEMATICA, ITALIANO]} onPeriodo={() => {}} finestra={TRONCATA} />)
        expect(screen.getByText(avviso())).toBeInTheDocument()
        expect(screen.getByText('Esercizi 3 e 4')).toBeInTheDocument()
        expect(screen.getByText('Leggere pagina 12')).toBeInTheDocument()
    })
})

describe('la pagina non lascia a schermo un conteggio vecchio', () => {
    it('la lettura fallita spegne l’avviso invece di riferirlo alla finestra sbagliata', async () => {
        finestraServita = TRONCATA
        render(<ParentCompitiPage />)
        await screen.findByText('Esercizi 3 e 4')
        expect(screen.getByText(avviso()), 'controllo positivo: l’avviso c’era').toBeInTheDocument()

        // Si cambia periodo e la lettura FALLISCE. `data` sopravvive apposta
        // (le righe di prima restano, attenuate e con `aria-busy`), e con essa
        // sopravviverebbe il suo `finestraRegistro`: l'avviso «di 520 lezioni ne
        // sono state lette 500» resterebbe accanto al pannello d'errore, riferito
        // a una finestra che non è più quella della tendina.
        rispondiConSuccesso = false
        fireEvent.change(tendinaPeriodo(), { target: { value: '90' } })

        await screen.findByRole('button', { name: itShared.paginaErroreRiprova })
        expect(screen.getByText('Esercizi 3 e 4'), 'le righe vecchie restano, è voluto').toBeInTheDocument()
        expect(screen.queryByText(avviso())).toBeNull()
    })
})

// ═════════════════════════════════════════════════════════════════════════════
// 4 · UNA LETTURA FALLITA NON È «NESSUN COMPITO»
// ═════════════════════════════════════════════════════════════════════════════

describe('la lettura fallita', () => {
    it('mostra l’errore con «Riprova», non uno stato vuoto', async () => {
        rispondiConSuccesso = false
        render(<ParentCompitiPage />)

        // Presenza prima di ogni assenza: si aspetta il pulsante, non il silenzio.
        const riprova = await screen.findByRole('button', { name: itShared.paginaErroreRiprova })
        expect(screen.getByText(itShared.filtriErroreTitolo)).toBeInTheDocument()
        expect(screen.queryByText(/nessun compito/i)).toBeNull()

        // «Riprova» rilegge davvero.
        rispondiConSuccesso = true
        fireEvent.click(riprova)
        await screen.findByText('Esercizi 3 e 4')
        expect(chiamate).toHaveLength(2)
    })

    it('un `{success:true}` SENZA corpo è un errore, non «nessun compito»', async () => {
        // La forma che prende un guasto a monte quando l'involucro risponde
        // comunque 200. Controllare il solo `success` la faceva passare: `data`
        // restava `undefined`, la bacheca rendeva lo stato VUOTO, e la famiglia
        // leggeva «Nessun compito assegnato negli ultimi 14 giorni» — cioè
        // esattamente la frase che questa pagina esiste per non far più dire a un
        // guasto, rientrata da una porta di servizio.
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            chiamate.push(String(input))
            return { ok: true, json: async () => ({ success: true }) } as unknown as Response
        }) as typeof globalThis.fetch

        render(<ParentCompitiPage />)

        await screen.findByRole('button', { name: itShared.paginaErroreRiprova })
        expect(screen.getByText(itShared.filtriErroreTitolo)).toBeInTheDocument()
        expect(screen.queryByText(/nessun compito/i)).toBeNull()
    })

    it('fallita DOPO che le righe c’erano: quelle vecchie non si spacciano per la risposta nuova', async () => {
        // ─── IL TERZO CASO, misurato il 2026-09-19 ───────────────────────────
        //
        // I casi non sono due ma tre, e questo non lo copriva nessuno dei 19 test
        // di prima. Prima lettura riuscita, poi «90 giorni», e la lettura
        // FALLISCE. `decidiStatoElenco` mette `errore` davanti a tutto
        // (`motore.ts:546-550`), quindi a schermo restano insieme: la tendina già
        // spostata su **90**, il pannello d'errore con «Riprova», e SOTTO le righe
        // dei **14** giorni — che prima di questa correzione stavano a piena
        // opacità, con `aria-busy="false"` e nessun `role="status"`.
        //
        // Per il genitore quelle righe erano indistinguibili dalla risposta dei 90
        // giorni: l'elenco diceva una cosa e il comando sopra ne diceva un'altra.
        // È la stessa ambiguità del ramo «sta caricando», e va chiusa allo stesso
        // modo — `aria-busy` per chi ascolta, l'attenuazione per chi guarda.
        const { container } = render(<ParentCompitiPage />)
        await screen.findByText('Esercizi 3 e 4')
        // A riposo nessuno è occupato: senza questa riga il controllo non
        // distinguerebbe un `aria-busy` acceso dal caso in cui è acceso SEMPRE.
        expect(container.querySelector('[aria-busy="true"]')).toBeNull()

        rispondiConSuccesso = false
        fireEvent.change(tendinaPeriodo(), { target: { value: '90' } })

        // PRESENZA prima di ogni assenza: si aspetta il pulsante, non il silenzio.
        // Un `waitFor` su «c'è aria-busy» fatto subito sarebbe verde già durante il
        // caricamento, cioè misurerebbe l'altro ramo.
        await screen.findByRole('button', { name: itShared.paginaErroreRiprova })
        expect(screen.getByText(itShared.filtriErroreTitolo)).toBeInTheDocument()

        // Le righe di prima sono ancora lì — è voluto, si tiene ciò che si era già
        // letto — ma adesso DICHIARANO di non essere la risposta a schermo.
        expect(screen.getByText('Esercizi 3 e 4')).toBeInTheDocument()
        expect(tendinaPeriodo().value).toBe('90')
        const attenuato = container.querySelector('[aria-busy="true"]') as HTMLElement
        expect(attenuato, 'le righe vecchie restano senza dire che la lettura è fallita').not.toBeNull()
        // E l'attenuazione è l'altro canale, quello di chi guarda: leggibile, non
        // sbiadita sotto soglia.
        expect(contrastoDelContenutoAttenuato(attenuato)).toBeGreaterThanOrEqual(4.5)
    })
})

// ═════════════════════════════════════════════════════════════════════════════
// 5 · IL SEGNALE DI RICARICA QUANDO LE RIGHE CI SONO GIÀ
// ═════════════════════════════════════════════════════════════════════════════

// ─── L'ARITMETICA DEL CONTRASTO, E PERCHÉ È RISCRITTA QUI ────────────────────
//
// È la stessa di `__tests__/a11y/contrasto-token.test.ts` (WCAG 2.x §1.4.3), che
// la esporta — ma importarla da lì ne rieseguirebbe tutte le `describe` dentro
// questo file, cioè la stessa suite contata due volte. Quattro righe copiate
// sono il male minore, e sotto c'è la prova che riproducono davvero quei numeri.
//
// ⚠️ I COLORI NON SI SCRIVONO A MANO: si leggono da `globals.css`. Un hex
// ricopiato in un test è esattamente il difetto che questa corsia ha appena
// corretto due volte (il `muted` #9AA6A2, morto il 2026-09-04 e citato fino a
// oggi): un valore copiato non invecchia insieme alla sua fonte, e nessuno se ne
// accorge finché non riconta.
const CSS_TOKEN = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8')
/** Il PRIMO valore dichiarato del token: il blocco base viene prima dei rimappaggi di Alto Contrasto. */
const token = (nome: string): string => {
    const trovato = new RegExp(`--color-kidville-${nome}:\\s*(#[0-9A-Fa-f]{6})`).exec(CSS_TOKEN)
    if (!trovato) throw new Error(`token --color-kidville-${nome} non dichiarato in globals.css`)
    return trovato[1].toUpperCase()
}
const canale = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}
const rgb = (hex: string): [number, number, number] => {
    const h = hex.replace('#', '')
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}
const luminanza = (hex: string) => {
    const [r, g, b] = rgb(hex)
    return 0.2126 * canale(r) + 0.7152 * canale(g) + 0.0722 * canale(b)
}
const contrasto = (a: string, b: string) => {
    const [x, y] = [luminanza(a), luminanza(b)]
    const [alto, basso] = x > y ? [x, y] : [y, x]
    return Math.round(((alto + 0.05) / (basso + 0.05)) * 100) / 100
}
/** La miscela per canale che fa il browser quando un colore è steso con un'alpha. */
const misc = (sopra: string, sotto: string, alpha: number) => {
    const [A, B] = [rgb(sopra), rgb(sotto)]
    return (
        '#' +
        [0, 1, 2]
            .map((i) => Math.round(A[i] * alpha + B[i] * (1 - alpha)).toString(16).padStart(2, '0'))
            .join('')
            .toUpperCase()
    )
}
/** L'alpha che una utility `opacity-NN` applica: si LEGGE dal DOM, non si suppone. */
const alphaDellaClasse = (className: string): number => {
    const trovato = /(?:^|\s)opacity-(\d{1,3})(?:\s|$)/.exec(className)
    if (!trovato) throw new Error(`nessuna utility \`opacity-NN\` in «${className}»`)
    return Number(trovato[1]) / 100
}

describe('l’aritmetica di questo file è quella del lock dei token', () => {
    it('riproduce i valori pubblicati in `globals.css` e in `contrasto-token.test.ts`', () => {
        // Senza questa prova il controllo di contrasto qui sotto sarebbe verde anche
        // con la formula sbagliata — e una formula sbagliata è un lock che misura sé
        // stesso. I tre numeri sono quelli scritti nelle fonti, non ricalcolati qui.
        expect(contrasto(token('sub'), token('white'))).toBe(6.46) // `sub` su bianco
        expect(contrasto(token('muted'), token('white'))).toBe(3.8) // `muted` su bianco
        expect(contrasto(token('ink'), token('white'))).toBe(11.78) // `ink` su bianco
        // E il token è QUELLO DI OGGI: #7B8582 dal 2026-09-04, non più #9AA6A2.
        expect(token('muted')).toBe('#7B8582')
    })
})

describe('la ricarica con righe a schermo', () => {
    it('cambiando periodo le righe restano, ma dichiarano `aria-busy` finché la risposta è in volo', async () => {
        // ⚠️ LA FETCH SI SBLOCCA A MANO. Con la risposta immediata dei test di
        // sopra il momento «sta caricando» dura meno di un microtask: non esiste
        // per nessuno, e infatti il difetto era passato indenne. Il momento va
        // tenuto aperto, o non lo si misura.
        const rilascio: { sblocca?: () => void } = {}
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            chiamate.push(String(input))
            if (chiamate.length > 1) {
                await new Promise<void>((risolvi) => {
                    rilascio.sblocca = risolvi
                })
            }
            return {
                ok: true,
                json: async () => ({
                    success: true,
                    data: {
                        schoolType: 'primaria',
                        child: { nome: 'Alunno', cognome: 'Di Prova' },
                        lezioni: lezioniServite,
                    },
                }),
            } as unknown as Response
        }) as typeof globalThis.fetch

        const { container } = render(<ParentCompitiPage />)
        await screen.findByText('Esercizi 3 e 4')
        // A riposo nessuno è occupato: senza questa riga il test non saprebbe
        // distinguere un `aria-busy` acceso dal caso in cui è acceso SEMPRE.
        expect(container.querySelector('[aria-busy="true"]')).toBeNull()

        lezioniServite = [INGLESE_INDIVIDUALIZZATA]
        fireEvent.change(tendinaPeriodo(), { target: { value: '90' } })

        await waitFor(() => expect(chiamate).toHaveLength(2))
        // Le righe del periodo VECCHIO sono ancora a schermo — è voluto: `pronto`
        // batte `caricamento` quando c'è già qualcosa, perché sostituire l'elenco
        // con uno spinner a ogni cambio di filtro è il difetto peggiore di una
        // barra filtri…
        expect(screen.getByText('Esercizi 3 e 4')).toBeInTheDocument()
        // …ma adesso DICONO di essere in aggiornamento, invece di spacciarsi per
        // la risposta del periodo nuovo.
        await waitFor(() => expect(container.querySelector('[aria-busy="true"]')).not.toBeNull())
        // Il segnale è DOPPIO, e per due persone diverse: `aria-busy` per chi
        // ascolta, l'attenuazione per chi guarda. Un solo canale lascia fuori
        // metà delle famiglie.
        const attenuato = container.querySelector('[aria-busy="true"]') as HTMLElement
        expect(attenuato.className).toContain('opacity-75')
        expect(contrastoDelContenutoAttenuato(attenuato)).toBeGreaterThanOrEqual(4.5)

        rilascio.sblocca?.()
        await screen.findByText(/Wordlist unit 1/)
        expect(container.querySelector('[aria-busy="true"]')).toBeNull()
    })

    it('l’attenuazione non porta il testo dei compiti sotto AA — sulla banda VERA, non su una comoda', () => {
        // ─── IL DIFETTO, misurato il 2026-09-19 ──────────────────────────────
        //
        // L'attenuazione era `opacity-60`, e portava il CONTENUTO dei compiti a
        // **3,30:1** sulla banda su cui si legge davvero — sotto i 4,5:1 di WCAG
        // 1.4.3. Non è testo «inattivo» a cui la soglia non si applica: niente
        // `inert`, niente `aria-disabled`, si legge e si seleziona, e dura quanto
        // la rete. Nello stesso lavoro si portava un'etichetta da 3,80 a 6,46 e si
        // attenuava il contenuto a 3,30.
        //
        // ⚠️ E LA BANDA È QUELLA GIALLA, non la riga. Il rilievo proponeva
        // `opacity-70` misurando `text-kidville-ink` sul fondo della riga
        // (`bg-kidville-cream/40`): lì 70 basta (4,62). Ma il testo del compito sta
        // su un riquadro `bg-kidville-yellow/20` DENTRO la riga, ed è la banda
        // peggiore: a 70 si ferma a **4,32:1**, ancora sotto. Un contrasto si
        // misura sul fondo che il testo ha davvero sotto di sé, non sul primo che
        // viene comodo — è la stessa disciplina del `count(*)` al posto del numero
        // ricopiato. Per questo il valore è 75, misurato 4,91 sulla banda gialla.
        //
        // Questo controllo non asserisce «la classe è opacity-75»: LEGGE l'alpha
        // dalla classe e ricalcola. Se un giorno qualcuno la riabbassa a 60 o 70 il
        // test diventa rosso col numero vero in mano, invece di difendere una
        // stringa.
        render(<CompitiList lezioni={[MATEMATICA]} caricamento onPeriodo={() => {}} />)
        const attenuato = document.querySelector('[aria-busy="true"]') as HTMLElement
        expect(attenuato, 'con `caricamento` le righe devono dichiararsi occupate').not.toBeNull()
        expect(contrastoDelContenutoAttenuato(attenuato)).toBeGreaterThanOrEqual(4.5)

        // CONTROPROVA NEGATIVA, nello stesso test: con l'alpha di prima (0,60) lo
        // stesso calcolo sta SOTTO soglia. Senza questa riga il controllo sarebbe
        // verde anche con un'aritmetica che restituisce sempre un numero alto.
        expect(contrastoSuBandaGialla(0.6)).toBeLessThan(4.5)
        expect(contrastoSuBandaGialla(0.7)).toBeLessThan(4.5)
    })
})

/**
 * Il contrasto del testo di un compito quando il contenitore è attenuato,
 * calcolato sulle bande VERE e con l'alpha LETTA dalla classe del contenitore.
 */
function contrastoDelContenutoAttenuato(contenitore: HTMLElement): number {
    return contrastoSuBandaGialla(alphaDellaClasse(contenitore.className))
}

/**
 * `text-kidville-ink` sul riquadro del compito, attenuato di `alpha`.
 *
 * Le tre superfici sovrapposte sono quelle che il componente disegna davvero:
 * la card `bg-white`, la riga `bg-kidville-cream/40`, il riquadro del compito
 * `bg-kidville-yellow/20`. `opacity` sul contenitore è un'opacità di GRUPPO:
 * sbiadiscono insieme verso il bianco della card, e il calcolo lo rispecchia.
 */
function contrastoSuBandaGialla(alpha: number): number {
    const bianco = token('white')
    const riga = misc(token('cream'), bianco, 0.4) // bg-kidville-cream/40
    const banda = misc(token('yellow'), riga, 0.2) // bg-kidville-yellow/20
    return contrasto(misc(token('ink'), bianco, alpha), misc(banda, bianco, alpha))
}
