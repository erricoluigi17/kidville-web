import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

import itPrimaria from '../../messages/it/parentPrimaria.json'
import itHome from '../../messages/it/home.json'

/**
 * LOCK · i compiti per casa sono raggiungibili dalla VIA NATURALE.
 *
 * ─── IL DIFETTO, misurato il 2026-09-19 ──────────────────────────────────────
 * La bacheca `/parent/compiti` esiste, funziona ed è completa — e non era
 * raggiungibile da dove il genitore la cerca. L'hub «Scuola»
 * (`/parent/primaria`) elencava SEI voci — Lezioni, Orario, Valutazioni, Note,
 * Presenze, Pagelle — e «Compiti» non c'era; quell'hub è la destinazione sia
 * della tab «Scuola» della bottom-nav sia della scorciatoia in home, cioè di
 * entrambe le strade larghe. Restavano Menu → Didattica → Compiti e il tocco su
 * una notifica push: due strade che si imboccano solo sapendo già che esistono.
 * Risultato misurabile: i genitori riferivano di non vedere i compiti mentre il
 * database diceva che i compiti c'erano.
 *
 * ─── COSA CONTROLLA, E PERCHÉ NON BASTA CONTARE ──────────────────────────────
 * Contare le voci dell'hub (sette) non difende niente da solo: sette voci
 * sbagliate sono sette. Quindi si controlla l'href VERO (`/parent/compiti`) e
 * l'etichetta VERA presa dal catalogo italiano — se qualcuno togliesse la voce,
 * o la facesse puntare all'hub delle lezioni, questi test diventano rossi.
 *
 * In home la stessa scorciatoia è condizionata al GRADO: un bambino di nido o
 * infanzia non ha compiti per casa, e una scorciatoia che gli promette una
 * bacheca vuota è peggio di nessuna scorciatoia. Il controllo negativo
 * (0-6 → niente) vale quanto quello positivo: senza, il test sarebbe verde
 * anche su una scorciatoia mostrata a tutti.
 *
 * ─── DUE ETICHETTE, DUE CATALOGHI, E NON È UNA DUPLICAZIONE ──────────────────
 * L'hub dice «Compiti» su una riga (`parentPrimaria.hubCompiti`); la home dice
 * «Compiti / per casa» su due (`home.azioneCompiti`), perché tutte e cinque le
 * scorciatoie della riga sono scritte su due righe con `\n` e rese con
 * `whitespace-pre-line`. Sono due testi con due tipografie, non una stringa
 * copiata: qui sotto un test pretende l'a-capo su OGNI etichetta della riga, così
 * la convenzione non resta affidata a chi se la ricorda.
 */

/**
 * Il catalogo scrive le etichette della riga su due righe; il DOM le porta con
 * l'a-capo dentro, ma il normalizzatore di Testing Library lo collassa in uno
 * spazio. Per cercarle a schermo si confronta la forma normalizzata.
 */
const suUnaRiga = (s: string) => s.replace(/\s+/g, ' ').trim()

const stub = vi.hoisted(() => ({
    pathname: '/parent/primaria',
    params: new URLSearchParams(),
    router: { push: () => {}, replace: () => {}, refresh: () => {} },
}))

vi.mock('next/navigation', () => ({
    usePathname: () => stub.pathname,
    useSearchParams: () => stub.params,
    useRouter: () => stub.router,
}))

/**
 * L'identità del genitore.
 *
 * ⚠️ `studentId` e `ready` sono PILOTABILI, e non per simmetria: il
 * `beforeEach` monta `{ studentId: 's-1', ready: true }`, cioè un'identità
 * risolta in modo SINCRONO — uno stato che la pagina vera al mount non ha mai.
 * `useParentIdentity` parte da `searchParams.get('id')` e risolve dentro un
 * `useEffect` che aspetta `/api/parent/students`, e la tab Home della bottom-nav
 * punta a `/parent` senza `?id=`. Un test che non muove queste due leve è cieco
 * sul primo fotogramma di ogni avvio a freddo.
 */
const identita = vi.hoisted(() => ({
    parentId: 'p-1' as string | null,
    studentId: 's-1' as string | null,
    ready: true,
}))

vi.mock('@/lib/auth/use-parent-identity', () => ({
    useParentIdentity: () => ({
        parentId: identita.parentId,
        studentId: identita.studentId,
        figliIds: identita.studentId ? [identita.studentId] : [],
        inAttesa: false,
        motivoAssenza: null,
        ready: identita.ready,
    }),
    eMotivoNonPiuIscritto: () => false,
}))

/**
 * Il grado del figlio: è la leva che accende/spegne la scorciatoia in home.
 *
 * `ready` è pilotabile insieme a `schoolType` perché l'hook vero li muove
 * insieme, e perché `{ schoolType: null, ready: false }` — che ogni genitore
 * attraversa, qualunque sia il grado del figlio — è uno stato che si misura:
 * vedi i test sulla forma della riga. Va combinato con `identita` qui sopra,
 * perché «grado in volo con identità già risolta» e «identità ancora in volo»
 * sono due fotogrammi diversi e la riga li tratta diversamente.
 */
const grado = vi.hoisted(() => ({ schoolType: 'primaria' as string | null, ready: true }))

vi.mock('@/lib/auth/use-child-school-type', () => ({
    useChildSchoolType: () => ({ schoolType: grado.schoolType, ready: grado.ready }),
}))

vi.mock('@/lib/logging/client', () => ({
    logClient: vi.fn(),
    nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'Error'),
}))

/**
 * I riquadri della home sono finti: ognuno parla col proprio endpoint, e qui si
 * misura la RIGA DELLE SCORCIATOIE, non i loro contenuti. Un finto che rende
 * `null` non può inventare un link, quindi non può rendere verde questo lock.
 */
vi.mock('@/components/features/shell/HeroCard', () => ({ HeroCard: () => null }))
vi.mock('@/components/features/parent/SospensioneBanner', () => ({ SospensioneBanner: () => null }))
vi.mock('@/components/features/parent/pagamenti/PagamentiSummary', () => ({ PagamentiSummary: () => null }))
vi.mock('@/components/features/parent/home/SectionHeader', () => ({ SectionHeader: () => null }))
vi.mock('@/components/features/parent/home/DiaryTodayCard', () => ({ DiaryTodayCard: () => null }))
vi.mock('@/components/features/parent/home/AvvisiPreview', () => ({ AvvisiPreview: () => null }))
vi.mock('@/components/features/parent/home/NewsPreview', () => ({ NewsPreview: () => null }))
vi.mock('@/components/features/parent/home/GalleryTodayCard', () => ({ GalleryTodayCard: () => null }))
vi.mock('@/components/features/parent/home/LockerTodayCard', () => ({ LockerTodayCard: () => null }))
vi.mock('@/components/features/parent/home/AgendaTodayCard', () => ({ AgendaTodayCard: () => null }))
vi.mock('@/components/features/parent/home/PresenzeTodayCard', () => ({ PresenzeTodayCard: () => null }))

import HubPrimariaPage from '@/app/(dashboard)/parent/primaria/page'
import ParentHomePage from '@/app/(dashboard)/parent/page'

const fetchMock = vi.fn()

beforeEach(() => {
    vi.clearAllMocks()
    identita.parentId = 'p-1'
    identita.studentId = 's-1'
    identita.ready = true
    grado.schoolType = 'primaria'
    grado.ready = true
    // La home chiede solo il nome del figlio per il saluto: qui è irrilevante,
    // ma la catena deve risolversi o lo skeleton resta montato per sempre.
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ nome: 'Rosa', classe_sezione: '1A' }) })
    vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => cleanup())

/** Gli href delle voci, senza la query d'identità che la home ci appiccica. */
function percorsiDeiLink(): string[] {
    return screen.getAllByRole('link').map((a) => (a.getAttribute('href') ?? '').split('?')[0])
}

/**
 * La riga delle scorciatoie, cercata per FORMA e non per numero di colonne.
 *
 * ⚠️ NON `.grid.grid-cols-5`, che è la classe del solo ramo primaria: un test
 * agganciato a quel numero è cieco sul ramo 0-6 (dove la riga è `grid-cols-4`) e
 * mente quando la classe cambia — sparisce l'elemento, e l'asserzione fallisce
 * dicendo `expected [] to have a length of 5`, cioè rosso per il motivo
 * sbagliato. Qui la riga si trova comunque, e chi legge il rosso legge la
 * differenza vera.
 *
 * Pretende che ce ne sia UNA SOLA: se un giorno la home avesse due griglie a
 * colonne, questo selettore comincerebbe a misurare in silenzio quella sbagliata.
 */
function rigaScorciatoie(container: HTMLElement): HTMLElement {
    const righe = container.querySelectorAll<HTMLElement>('div.grid[class*="grid-cols-"]')
    expect(
        righe,
        'la home non ha più ESATTAMENTE una griglia a colonne: questo selettore non sa più quale sia la riga delle scorciatoie',
    ).toHaveLength(1)
    return righe[0]
}

describe('hub «Scuola» · «Compiti» è una delle voci, non una scorciatoia da sapere a memoria', () => {
    it('rende SETTE voci, e una è «Compiti» verso /parent/compiti', () => {
        render(<HubPrimariaPage />)

        const percorsi = percorsiDeiLink()
        expect(
            percorsi,
            'le voci dell’hub sono cambiate di numero: se è voluto, aggiorna questo lock e dì perché',
        ).toHaveLength(7)
        expect(
            percorsi,
            'l’hub «Scuola» non porta ai compiti: restano Menu → Didattica → Compiti e la ' +
                'notifica push, cioè le due strade che si imboccano solo sapendo già che esistono',
        ).toContain('/parent/compiti')
    })

    it('la voce porta l’etichetta e il sottotitolo del catalogo, non il nome della chiave', () => {
        render(<HubPrimariaPage />)

        const voce = screen.getByText(itPrimaria.hubCompiti)
        expect(voce).toBeInTheDocument()
        expect(
            voce.closest('a')?.getAttribute('href'),
            'l’etichetta «Compiti» esiste ma non è il link ai compiti',
        ).toBe('/parent/compiti')
        expect(screen.getByText(itPrimaria.hubCompitiSub)).toBeInTheDocument()
        // Il sottotitolo non è un identificatore: se il catalogo perdesse la
        // chiave, il mock di next-intl renderebbe `parentPrimaria.hubCompitiSub`.
        expect(screen.queryByText(/^parentPrimaria\./)).not.toBeInTheDocument()
    })

    it('sta SUBITO DOPO «Lezioni»: argomenti svolti e compiti assegnati sono vicini di casa', () => {
        render(<HubPrimariaPage />)

        const percorsi = percorsiDeiLink()
        expect(percorsi.indexOf('/parent/compiti')).toBe(percorsi.indexOf('/parent/lezioni') + 1)
    })
})

describe('home genitore · la scorciatoia «Compiti» segue il GRADO del figlio', () => {
    it('figlio di primaria: la scorciatoia c’è e punta a /parent/compiti', async () => {
        grado.schoolType = 'primaria'
        render(<ParentHomePage />)

        const compiti = await screen.findByText(suUnaRiga(itHome.azioneCompiti))
        const href = compiti.closest('a')?.getAttribute('href') ?? ''
        expect(href.split('?')[0]).toBe('/parent/compiti')
        // L'identità viaggia sull'href come per tutte le altre scorciatoie.
        expect(href).toContain('id=s-1')
    })

    it('figlio di infanzia: la scorciatoia NON c’è (e nemmeno per il nido)', async () => {
        for (const tipo of ['infanzia', 'nido']) {
            grado.schoolType = tipo
            render(<ParentHomePage />)

            // Si aspetta la PRESENZA di qualcosa prima di misurare un'assenza:
            // «non c'è» è vero anche su una pagina non ancora resa. La barriera è
            // l'ALTRO RAMO dello stesso `isPrimaria` che accende la scorciatoia
            // («Diario di oggi» al posto di «Scuola primaria»), non un'etichetta
            // incondizionata come «Vedi foto»: se quello slot venisse spento, o
            // il grado ignoto finisse dalla parte della primaria, qui ci si
            // ferma.
            //
            // ⚠️ MISURATO il 2026-09-19, e scritto perché non le si creda di più
            // di quel che fa: questa barriera NON distingue «grado letto, ed è
            // 0-6» da «grado non ancora letto». `isPrimaria` è
            // `schoolType === 'primaria'`, quindi `null` cade nello STESSO ramo
            // di `infanzia`/`nido` — con `useChildSchoolType` finto a
            // `{ schoolType: null, ready: false }` questo test resta verde. A
            // rendere onesto il controllo negativo è il finto qui sopra, che qui
            // il grado lo risolve in modo SINCRONO (`grado.ready = true` nel
            // `beforeEach`): non c'è nessuna fetch in volo da cui l'assenza
            // possa arrivare per il motivo sbagliato.
            //
            // IL SEGNO CHE SEPARA I DUE CASI ESISTE, e non va cercato altrove:
            // è il `ready` che `useChildSchoolType` ritorna accanto a
            // `schoolType`. Citato per NOME e non per riga: questa stessa corsia
            // ha allungato quel file, e il numero che stava scritto qui indicava
            // già un'altra istruzione dopo poche ore. La home lo scartava con una
            // destrutturazione parziale — `const { schoolType } = …` — e da lì
            // veniva il salto di layout della riga; ora lo legge e ne ricava
            // `gradoIgnoto` (`parent/page.tsx`), che è la barriera vera.
            //
            // Quella barriera governa la FORMA della riga, non il CONTENUTO: a
            // grado ignoto la scorciatoia «Compiti» resta comunque spenta, ed è
            // voluto — non si promette una bacheca prima di sapere se quel
            // bambino ce l'ha. Ciò che `gradoIgnoto` impedisce è che la riga
            // cambi numero di colonne quando la fetch risponde; lo misura il
            // test «grado ancora ignoto» qui sotto.
            await screen.findByText(suUnaRiga(itHome.azioneDiario))
            expect(
                percorsiDeiLink(),
                `un figlio di ${tipo} non ha compiti per casa: la scorciatoia gli prometterebbe ` +
                    'una bacheca che per lui è vuota per costruzione',
            ).not.toContain('/parent/compiti')
            expect(screen.queryByText(suUnaRiga(itHome.azioneCompiti))).not.toBeInTheDocument()
            cleanup()
        }
    })

    it('la riga delle scorciatoie resta UNA: cinque voci, cinque colonne', async () => {
        grado.schoolType = 'primaria'
        const { container } = render(<ParentHomePage />)
        await screen.findByText(suUnaRiga(itHome.azioneCompiti))

        const griglia = container.querySelector('.grid.grid-cols-5')
        expect(
            griglia,
            'con cinque scorciatoie e quattro colonne l’ultima va a capo da sola',
        ).not.toBeNull()
        expect(griglia?.querySelectorAll('a')).toHaveLength(5)
    })

    /**
     * ─── IL SALTO DI LAYOUT, misurato il 2026-09-19 con l'hook VERO ───────────
     *
     * Con `useChildSchoolType` non finto e la fetch che risponde `primaria`, la
     * riga passava da `grid grid-cols-4` con quattro card a `grid grid-cols-5`
     * con cinque. Il lampo dell'ETICHETTA («Diario di oggi» ↔ «Scuola primaria»)
     * è preesistente e non è questo: il numero di COLONNE, prima di questa
     * corsia, era il letterale `grid-cols-4`, invariante per tutti. Adesso tutte
     * e quattro le card si restringono e si spostano — sulla riga più alta e più
     * toccata della home, per la durata di una fetch — mentre un bersaglio nuovo
     * compare fra quelli che il dito stava già mirando.
     *
     * ⚠️ QUESTO TEST NON DICE «la riga non si assesta più», e il titolo che
     * aveva prima lo diceva. Per il 0-6 la riga nasce a cinque colonne e a grado
     * letto torna a quattro. Il conto onesto, ramo per ramo, confrontato con lo
     * stato PRECEDENTE di ciascun ramo e non con «cinque colonne fisse per
     * tutti» — e dal 2026-09-19 in due colonne, perché `useChildSchoolType`
     * RICORDA il grado sul dispositivo (`kv_grado_<figlio>` in `localStorage`):
     *
     *                     prima apertura        aperture successive   prima della corsia
     *     primaria        5 → 5 → 5 (zero)      5 → 5 (zero)          4 fisso   (nessuno)
     *     nido/infanzia   5 → 5 → 4 (uno)       5 → 4 (uno)           4 fisso   (nessuno)
     *
     * L'ultima colonna è lo stato di ciascun ramo PRIMA di tutto questo lavoro, e
     * per tutti e due è lo stesso: su `HEAD` le scorciatoie erano QUATTRO (nessun
     * «Compiti») e la riga era il letterale `grid-cols-4`, invariante — quindi
     * **zero** assestamenti di colonna per entrambi i rami.
     *
     * ⚠️ Qui c'era scritto «(prima della corsia: 4 → 5, uno)» per la primaria, ed
     * era FALSO: quel `4 → 5` è lo stato INTERMEDIO di questa stessa corsia (la
     * quinta card aggiunta, la riserva non ancora scritta), non lo stato di
     * partenza. Le due righe della colonna usavano due basi diverse.
     *
     * E da quella casella discendeva una seconda frase falsa — «l'assestamento è
     * stato SPOSTATO dalla primaria al 0-6». Non è stato spostato:
     *
     *   · sul **0-6** — che è la maggioranza delle famiglie — ne abbiamo
     *     INTRODOTTO uno dove non ce n'era nessuno, ed è il prezzo della
     *     scorciatoia nuova aggiunta per la primaria;
     *   · sulla **primaria** ne abbiamo EVITATO uno che sarebbe nato per causa
     *     nostra, aggiungendo la quinta card.
     *
     * Chi paga è il 0-6, e non «in cambio» di qualcosa che avesse prima. Il verso
     * è quello meno cattivo — le stesse quattro card si allargano nello spazio
     * già riservato invece di restringersi mentre ne appare una quinta — ma non è
     * innocuo: con quattro card il centro della quarta passa da ~0,70 a ~0,875
     * della larghezza, e un dito puntato sul vecchio centro atterra dentro la
     * terza card. La tabella gemella sta in `parent/page.tsx`, ed è identica.
     *
     * LA MEMORIA NON LO PORTA A ZERO, e non va raccontata come se lo facesse:
     * sposta il momento. Senza, il 0-6 si assesta alla risposta di
     * `/api/parent/primaria`, cioè dopo due giri di rete; con la memoria calda
     * si assesta all'hydration, senza rete. Il fotogramma a cinque colonne resta
     * perché lo rende il SERVER (layout radice con `await cookies()`), e il
     * server il `localStorage` di quel telefono non può leggerlo.
     *
     * Ciò che questo test misura è quindi una cosa sola e precisa: che
     * all'arrivo del grado la riga non si STRINGE e non fa comparire un
     * bersaglio nuovo. Che il grado arrivi dal dispositivo invece che dalla rete
     * lo misura `__tests__/lib/grado-figlio-memorizzato.test.tsx`, dove l'hook è
     * quello VERO — qui è finto, e un finto non ha nessuna memoria da leggere.
     *
     * Si misura la CLASSE e non i pixel perché è la classe a decidere la forma,
     * e perché jsdom non fa layout: un test sui pixel qui sarebbe verde sempre.
     */
    it('grado in volo: la riga è già alla larghezza massima, e quando la fetch risponde non compare nessun bersaglio nuovo', async () => {
        grado.schoolType = 'primaria'
        grado.ready = true
        const { container } = render(<ParentHomePage />)
        await screen.findByText(suUnaRiga(itHome.azioneCompiti))
        const aRegime = rigaScorciatoie(container).className
        cleanup()

        // `{ schoolType: null, ready: false }` con l'identità GIÀ risolta è il
        // secondo fotogramma di ogni genitore: `useChildSchoolType` non chiede
        // niente finché non ha `studentId`, e mette `ready` a `true` solo dopo la
        // fetch. Il PRIMO fotogramma — `studentId` ancora `null` — è un'altra
        // cosa, e ha il suo test qui sotto.
        grado.schoolType = null
        grado.ready = false
        const { container: gradoInVolo } = render(<ParentHomePage />)
        // Si aspetta la PRESENZA di una card che c'è in ogni ramo: «non è ancora
        // cambiata» è vero anche su una pagina non ancora resa.
        await screen.findByText(suUnaRiga(itHome.azioneAssenza))

        expect(
            rigaScorciatoie(gradoInVolo).className,
            'la riga delle scorciatoie si stringe quando il grado arriva, e una card nuova ' +
                'compare fra quelle che il dito stava già mirando. Il segno per evitarlo è ' +
                '`ready`, che `useChildSchoolType` ritorna già',
        ).toBe(aRegime)
    })

    /**
     * ─── IL FOTOGRAMMA 1 VERO, che non è quello montato dagli altri casi ──────
     *
     * Ogni altro test di questo file parte da `studentId: 's-1'` risolto in modo
     * SINCRONO: uno stato che la pagina vera al mount non ha mai.
     * `useParentIdentity` inizializza `studentId` da `searchParams.get('id')` e lo
     * risolve dentro un `useEffect` che aspetta `/api/parent/students`; la tab
     * Home della bottom-nav punta a `/parent` NUDO (`BottomNav`, `mainTabs`, id
     * `home`), quindi al primo render `studentId` è `null`. Non è un caso limite:
     * è l'avvio a freddo e il tocco sulla tab Home.
     *
     * È la differenza fra `!!studentId && !gradoLetto` e
     * `(!ready || !!studentId) && !gradoLetto`: col primo la quinta colonna
     * veniva riservata un fotogramma TROPPO TARDI, e per il 0-6 la riga faceva
     * `4 → 5 → 4` — due assestamenti dove prima di questa corsia non ce n'era
     * nessuno, e sul ramo che vede la maggioranza delle famiglie.
     */
    it('identità ancora in volo: la riga è già alla larghezza massima al mount, non la prende al secondo fotogramma', async () => {
        grado.schoolType = 'primaria'
        grado.ready = true
        const { container } = render(<ParentHomePage />)
        await screen.findByText(suUnaRiga(itHome.azioneCompiti))
        const larghezzaMassima = rigaScorciatoie(container).className
        cleanup()

        // Lo stato del mount: identità non risolta (`studentId` ancora `null`,
        // `ready` falso) e grado nemmeno chiesto, perché l'hook del grado aspetta
        // il figlio. I due finti si muovono insieme come gli hook veri.
        identita.studentId = null
        identita.ready = false
        grado.schoolType = null
        grado.ready = false

        const { container: alMount } = render(<ParentHomePage />)
        // Presenza e non assenza, e su una card che esiste in TUTTI i rami:
        // «Segnala assenza» c'è sia per la primaria sia per il 0-6, e non dipende
        // né dal grado né dal figlio.
        await screen.findByText(suUnaRiga(itHome.azioneAssenza))

        expect(
            rigaScorciatoie(alMount).className,
            'al mount la riga è più stretta di quella a regime: la quinta colonna viene ' +
                'riservata solo quando /api/parent/students risponde, e fino a lì le quattro ' +
                'card si restringono e si spostano un assestamento in più — due per il 0-6, ' +
                'che prima non ne aveva nessuno',
        ).toBe(larghezzaMassima)
    })

    /**
     * ─── E LA RISERVA DEVE FINIRE, se il figlio non arriva ────────────────────
     *
     * `useChildSchoolType` esce dall'effetto PRIMA di `setReady(true)` quando
     * manca `studentId`: per un account senza figli visibili `gradoLetto` resta
     * `false` per tutta la vita della pagina. Una riserva incondizionata
     * (`gradoIgnoto = !gradoLetto`) diventerebbe lì un buco permanente in fondo
     * alla riga — un difetto che dura per sempre al posto di uno che dura una
     * fetch — ed è proprio la mutazione che tutti gli altri test di questo file
     * lasciano passare, perché montano un `studentId` sempre presente.
     *
     * Il `return` anticipato della home («iscrizione in lavorazione») NON copre
     * questo caso: quel ramo vuole `inAttesa`, che `useParentIdentity` calcola
     * come `figli.length === 0 && body.in_attesa === true` e lascia `false`
     * quando la lettura dei figli fallisce — cioè offline a freddo, dove la home
     * intera si vede.
     */
    it('identità risolta SENZA figlio: la riserva si chiude, niente colonna vuota per sempre', async () => {
        identita.studentId = null
        identita.ready = true
        grado.schoolType = null
        grado.ready = false

        const { container } = render(<ParentHomePage />)
        await screen.findByText(suUnaRiga(itHome.azioneAssenza))

        expect(
            rigaScorciatoie(container).className,
            'la riga resta a cinque colonne con quattro card: per questo account il grado non ' +
                'arriverà mai (l’hook non chiede niente senza `studentId`), quindi il buco in ' +
                'fondo alla riga non è un fotogramma, è definitivo',
        ).toContain('grid-cols-4')
    })

    /**
     * Il ramo 0-6 A REGIME, che nessun altro test di questo file fissa: senza
     * questa asserzione un'implementazione «cinque colonne sempre» resterebbe
     * verde su tutti gli altri casi — la scorciatoia «Compiti» non comparirebbe
     * lo stesso, e la forma della riga non la guarda nessuno.
     */
    it('0-6 a regime: quattro voci e QUATTRO colonne, la quinta non resta riservata', async () => {
        grado.schoolType = 'infanzia'
        grado.ready = true
        const { container } = render(<ParentHomePage />)
        await screen.findByText(suUnaRiga(itHome.azioneDiario))

        const riga = rigaScorciatoie(container)
        expect(riga.querySelectorAll('a'), 'il ramo 0-6 non mostra quattro scorciatoie').toHaveLength(4)
        expect(
            riga.className,
            'quattro card in cinque colonne lasciano un buco in fondo alla riga a ogni ' +
                'apertura della home, e per il 0-6 — la maggioranza delle famiglie — non ' +
                'finisce mai: è il difetto permanente che la riserva temporanea evita',
        ).toContain('grid-cols-4')
    })

    /**
     * La riga mostra CINQUE scorciatoie per la primaria e QUATTRO per il 0-6, ma
     * le etichette possibili sono sei: «Scuola primaria» e «Diario di oggi» si
     * alternano sullo stesso posto a seconda del grado. Si controllano tutte e
     * sei, perché una riga sola senza a-capo la vede il genitore del grado che
     * quel ramo mostra.
     *
     * ⚠️ Questo elenco è cablato a mano, quindi DIMENTICA: una card aggiunta
     * domani non ci finisce da sola. È per questo che il test non si ferma al
     * catalogo e ispeziona il DOM in ENTRAMBI i rami — lì le card si contano da
     * sé, e una card nuova è coperta dal momento in cui esiste.
     */
    const ETICHETTE_DELLA_RIGA = [
        'azioneAssenza',
        'azioneChat',
        'azioneFoto',
        'azioneScuola',
        'azioneDiario',
        'azioneCompiti',
    ] as const

    it('ogni etichetta della riga è su DUE righe esatte, in entrambi i rami del grado', async () => {
        for (const chiave of ETICHETTE_DELLA_RIGA) {
            expect(
                itHome[chiave].split('\n'),
                `«${itHome[chiave]}» (home.${chiave}) non è su due righe: nella riga delle ` +
                    'scorciatoie le card hanno DUE righe di testo — una sola lascia la card ' +
                    'spaiata, tre alzano la riga e disallineano tutte le altre, e si vede a ' +
                    'ogni larghezza, non solo sui telefoni piccoli',
            ).toHaveLength(2)
        }

        // E non basta il catalogo: le etichette devono ARRIVARE a schermo con
        // l'a-capo dentro (è `whitespace-pre-line` a renderlo, e il DOM lo
        // conserva). Su ENTRAMBI i rami: agganciato al solo `grid-cols-5` — cioè
        // alla sola primaria — questo controllo era cieco su metà delle card,
        // ed è la metà che vede la maggioranza delle famiglie.
        for (const [tipo, ancora] of [
            ['primaria', itHome.azioneCompiti],
            ['infanzia', itHome.azioneDiario],
        ] as const) {
            grado.schoolType = tipo
            const { container } = render(<ParentHomePage />)
            await screen.findByText(suUnaRiga(ancora))

            const riga = rigaScorciatoie(container)
            const card = riga.querySelectorAll('a')
            expect(card.length, `il ramo «${tipo}» non mostra nessuna scorciatoia`).toBeGreaterThan(0)

            const etichette = Array.from(
                riga.querySelectorAll('a > span.whitespace-pre-line'),
            ).map((s) => s.textContent ?? '')
            expect(
                etichette,
                `nel ramo «${tipo}» c’è una card senza etichetta \`whitespace-pre-line\`: ` +
                    'l’a-capo del catalogo lì non arriverebbe a schermo',
            ).toHaveLength(card.length)

            for (const testo of etichette) {
                expect(
                    testo.split('\n'),
                    `nel ramo «${tipo}» la card «${suUnaRiga(testo)}» arriva a schermo su ` +
                        `${testo.split('\n').length} righe invece che su due`,
                ).toHaveLength(2)
            }
            cleanup()
        }
    })
})
