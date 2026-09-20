import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { IntlMessageFormat } from 'intl-messageformat'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatEuro } from '@/lib/format/valuta'
import { ComposizioneBonifico } from '@/components/features/admin/pagamenti/ComposizioneBonifico'
// ⚠️ IL POPPUP VERO, E SENZA MOCK DEL PANNELLO: è l'unica inquadratura in cui i
// due `role="status"` coesistono (v. l'ultimo `describe` di questo file).
import { MovimentoDialog } from '@/components/features/admin/pagamenti/MovimentoDialog'
import type { MovimentoUi } from '@/components/features/admin/pagamenti/riconciliazione-ui'

/**
 * IL DIALOGO CHE COLLEGA UN GENITORE — finto, e con DUE porte d'uscita distinte.
 *
 * Quello vero è un `Modal` con la sua form e le sue fetch: montarlo qui vorrebbe
 * dire collaudare l'anagrafica. Quello che a questo file serve è una cosa sola —
 * poter uscire da lì **dalla porta giusta**, perché il bersaglio del fuoco lo
 * decide la porta: scritto il legame il blocco è condannato, annullato resta.
 */
vi.mock('@/components/features/admin/legami/DialogoAggiungiLegame', () => ({
    DialogoAggiungiLegame: (props: { onCollegato: () => void; onChiudi: () => void }) => (
        <div data-testid="finto-dialogo-legame">
            <button type="button" onClick={() => props.onCollegato()}>
                FINTO legame scritto
            </button>
            <button type="button" onClick={() => props.onChiudi()}>
                FINTO annulla
            </button>
        </div>
    ),
}))

/**
 * ════════════════════════════════════════════════════════════════════════════
 * COMPORRE PARTENDO DAL BAMBINO — la prova che chiude il difetto del rosso.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ─── IL DIFETTO, PER INTERO ─────────────────────────────────────────────────
 * Su un movimento ROSSO non ci sono suggerimenti. Senza suggerimenti il contesto
 * non aveva bambini; senza bambini non c'era nessun genitore candidato; senza
 * candidati la tendina dell'intestatario era vuota, `paganteCorrente` restava
 * `''` e «Conferma» restava spento **per sempre**. Non era un difetto del gate:
 * `puoConfermare` faceva esattamente il suo mestiere su una composizione che non
 * aveva su cosa posarsi. Il buco era a monte — non c'era nessun modo di dire al
 * pannello SU CHI si stava lavorando.
 *
 * ─── PERCHÉ LA CONTROPROVA È METÀ DI QUESTO FILE ────────────────────────────
 * La prova positiva da sola sarebbe VERDE ANCHE COL DIFETTO IN PIEDI: basterebbe
 * un finto che risponde sempre col contesto pieno, e il pannello si accenderebbe
 * senza aver mai mandato `?alunni=`. Perciò la rete finta qui sotto si comporta
 * **come il server vero**: risponde col contesto pieno SOLO se la query porta i
 * bambini, e col contesto vuoto altrimenti. La stessa prova, tolta la prop,
 * diventa rossa con il motivo «Genitore intestatario» a schermo.
 *
 * ─── NIENTE DATI VERI ───────────────────────────────────────────────────────
 * Repository pubblico: uuid inventati, e i due nomi sono quelli che il repo usa
 * già come segnaposto. Nessun codice fiscale, nemmeno finto.
 */

const CAT = JSON.parse(
    readFileSync(join(process.cwd(), 'messages/it/adminContabilita.json'), 'utf8'),
) as Record<string, string>

/**
 * Una chiave ICU resa come la rende il componente — cioè come la rende il mock di
 * next-intl in `test/setup.ts`, che formatta con `IntlMessageFormat` appena
 * arrivano dei valori. Asserire la stringa GREZZA del catalogo (`{n, plural, …}`)
 * sarebbe verde su un plurale che a schermo non si formatta mai.
 */
const reso = (chiave: string, valori: Record<string, string | number>): string =>
    String(new IntlMessageFormat(CAT[chiave], 'it').format(valori))

const MOVIMENTO_ID = '11111111-1111-4111-8111-111111111111'
const SEDE_1 = '22222222-2222-4222-8222-222222222222'
const SEDE_2 = '33333333-3333-4333-8333-333333333333'
const ALUNNO_1 = '44444444-4444-4444-8444-444444444444'
const ALUNNO_2 = '55555555-5555-4555-8555-555555555555'
const ALUNNO_3 = '77777777-7777-4777-8777-777777777777'
const ALUNNO_4 = '99999999-9999-4999-8999-999999999999'
const ALUNNO_5 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
/** Il sesto e il settimo esistono per una sola prova: quella del taglio a cinque. */
const ALUNNO_6 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const ALUNNO_7 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const PARENT_1 = '66666666-6666-4666-8666-666666666666'
const VOCE_1 = '88888888-8888-4888-8888-888888888888'
const CAT_RETTA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const IMPORTO = 200

function voce(over: Record<string, unknown> = {}) {
    return {
        id: VOCE_1,
        alunno_id: ALUNNO_1,
        scuola_id: SEDE_1,
        descrizione: 'Retta settembre',
        importo: IMPORTO,
        importo_pagato: 0,
        sconto: 0,
        scadenza: '2026-09-01',
        stato: 'da_pagare',
        tipo: 'singolo',
        categoria_id: CAT_RETTA,
        periodo_competenza: null,
        residuo: IMPORTO,
        payment_categories: { slug: 'retta' },
        ...over,
    }
}

const movimento = {
    id: MOVIMENTO_ID,
    importo: IMPORTO,
    data_operazione: '2026-09-10',
    causale: 'BONIFICO',
    controparte: null,
    stato: 'da_abbinare',
    scuola_id: null,
}

/** Il contesto che il server manda QUANDO sa su chi si sta lavorando. */
function contestoPieno(over: Record<string, unknown> = {}) {
    return {
        success: true,
        data: {
            movimento,
            pagante: {
                proposto: { parent_id: PARENT_1, motivo: 'pagante_comune' },
                candidati: [{ parent_id: PARENT_1, nome: 'Mario Rossi', relazione: 'padre' }],
            },
            figli: [
                {
                    alunno_id: ALUNNO_1,
                    nome: 'Primo Bambino',
                    scuola_id: SEDE_1,
                    in_sede: true,
                    attivo: true,
                    saldo_ticket: 0,
                    voci_aperte: [voce()],
                },
            ],
            categorie: [{ id: CAT_RETTA, nome: 'Retta', slug: 'retta', scuola_id: null }],
            pacchetti_ticket: { [SEDE_1]: [] },
            sedi: { [SEDE_1]: 'Sede di prova' },
            ...over,
        },
    }
}

/**
 * Il contesto di un movimento ROSSO che non nomina nessuno: è ciò che il server
 * risponde senza `?alunni=`, ed è il difetto allo stato puro — niente figli,
 * niente candidati, niente da cui partire.
 */
const contestoVuoto = {
    success: true,
    data: {
        movimento,
        pagante: { proposto: null, candidati: [] },
        figli: [],
        categorie: [],
        pacchetti_ticket: {},
        sedi: { [SEDE_1]: 'Sede di prova' },
    },
}

function jsonRes(body: unknown, status = 200) {
    return { ok: status < 400, status, json: async () => body } as Response
}

/**
 * LA RETE FINTA SI COMPORTA COME IL SERVER: il contesto pieno esce **solo** se la
 * richiesta porta i bambini. Un finto piatto sarebbe verde con e senza la
 * correzione — è la trappola n. 1 di `.claude/rules/test.md`.
 */
/**
 * Un 200 il cui CORPO non si legge: il proxy che risponde con una pagina che non
 * è JSON, o la connessione che cade a metà body su rete mobile. `res.ok` è vero,
 * `json()` rigetta — ed è la terza forma di guasto, quella che non è né «la rete
 * non risponde» né «il server rifiuta».
 */
function resCorpoIlleggibile(status = 200) {
    return {
        ok: status < 400,
        status,
        json: async () => {
            throw new SyntaxError('Unexpected token < in JSON at position 0')
        },
    } as unknown as Response
}

function rete(
    opts: {
        ctxPieno?: unknown
        ricerca?: unknown
        ricercaStatus?: number
        /** La ricerca risponde 200 col corpo illeggibile (vedi sopra). */
        ricercaCorpoIlleggibile?: boolean
    } = {},
) {
    const chiamate = { contesto: [] as string[], alunni: [] as string[] }
    const fn = vi.fn(async (url: RequestInfo | URL) => {
        const u = String(url)
        if (u.includes('/contesto')) {
            chiamate.contesto.push(u)
            const conAlunni = /[?&]alunni=[^&]+/.test(u)
            return jsonRes(conAlunni ? (opts.ctxPieno ?? contestoPieno()) : contestoVuoto)
        }
        if (u.includes('/riconciliazione/alunni')) {
            chiamate.alunni.push(u)
            if (opts.ricercaCorpoIlleggibile) return resCorpoIlleggibile(opts.ricercaStatus ?? 200)
            return jsonRes(
                opts.ricerca ?? { success: true, data: [], troncato: false, sedi: {} },
                opts.ricercaStatus ?? 200,
            )
        }
        return jsonRes({})
    })
    return { fn, chiamate }
}

function monta(props: Partial<Parameters<typeof ComposizioneBonifico>[0]> = {}) {
    const onFatto = vi.fn()
    const onChiudi = vi.fn()
    render(
        <ComposizioneBonifico
            movimentoId={MOVIMENTO_ID}
            importoMovimento={IMPORTO}
            dataOperazione="2026-09-10"
            onFatto={onFatto}
            onChiudi={onChiudi}
            {...props}
        />,
    )
    return { onFatto, onChiudi }
}

const conferma = () => screen.getByRole('button', { name: CAT.reconComponiConferma })
const spunta = (descrizione: string) =>
    screen.getByRole('checkbox', { name: new RegExp(descrizione) })

beforeEach(() => {
    try {
        window.localStorage.clear()
    } catch {
        /* jsdom senza storage: nulla da pulire */
    }
})
afterEach(() => vi.unstubAllGlobals())

describe('ComposizioneBonifico — la composizione che parte dall’alunno', () => {
    it('movimento rosso + `alunniIniziali` ⇒ il contesto si popola e «Conferma» si ACCENDE', async () => {
        const { fn, chiamate } = rete()
        vi.stubGlobal('fetch', fn)
        monta({ alunniIniziali: [ALUNNO_1] })

        // Il contesto è arrivato: da qui in poi le assenze sono vere assenze.
        await screen.findByRole('checkbox', { name: /Retta settembre/ })

        // I bambini viaggiano nella query, ed è l'unica ragione per cui il contesto
        // non è vuoto: la rete finta risponde pieno solo a chi li manda.
        expect(chiamate.contesto.at(-1)).toContain(`alunni=${ALUNNO_1}`)

        // Spuntata l'unica voce, la composizione quadra al centesimo: il pagante è
        // proposto, la sede è una sola e si preseleziona.
        fireEvent.click(spunta('Retta settembre'))

        await waitFor(() => expect(conferma()).toBeEnabled())
        // …e non resta nessun motivo elencato: il pulsante non è acceso «per caso».
        expect(screen.queryByTestId('componi-motivi')).toBeNull()
    })

    it('CONTROPROVA · la stessa prova SENZA `alunniIniziali` resta rossa, e il motivo è «Genitore intestatario»', async () => {
        // ⚠️ SENZA QUESTA METÀ LA PROVA SOPRA SAREBBE VERDE ANCHE COL DIFETTO IN
        // PIEDI: dimostrerebbe che il pannello si accende con un contesto pieno, non
        // che è la prop a farglielo avere.
        const { fn, chiamate } = rete()
        vi.stubGlobal('fetch', fn)
        monta()

        // Àncora positiva: si aspetta un elemento che esiste solo a contesto
        // caricato, o l'assenza qui sotto passerebbe mentre la fetch è in volo.
        await screen.findByText(CAT.reconComponiVociAperteVuoto)

        expect(chiamate.contesto.at(-1)).not.toContain('alunni=')
        expect(conferma()).toBeDisabled()
        expect(screen.getByTestId('componi-motivi')).toHaveTextContent(CAT.reconComponiIntestatario)
        // Non c'è nessuna voce su cui posarsi: la tendina dell'intestatario è vuota.
        expect(screen.queryByRole('checkbox')).toBeNull()
    })

    it('NESSUNA RILETTURA A OGNI RENDER: la GET del contesto resta UNA', async () => {
        // ⚠️ IL DIFETTO CHE QUESTA PROVA TIENE FERMO, e QUANTO ne tiene.
        // Il pericolo: un array ricostruito a ogni render fra le dipendenze
        // dell'effetto rifarebbe la GET a ogni render — e ogni GET azzera le righe,
        // cioè la spunta sparirebbe un istante dopo averla messa (è già successo
        // qui con `t`).
        //
        // 🔴 QUESTA PROVA NON VEDE LO SCAMBIO STRINGA→ARRAY, ed è misurato
        // (2026-09-20, sui tre file del lotto). Scambiato `alunniQuery` con
        // `alunniScelti` nelle dipendenze dell'effetto, e con il `useMemo` in
        // piedi, resta **1 sola rossa**: il lock testuale qui sotto, non questa.
        // Il motivo è che il comportamento non cambia — l'array memoizzato è
        // stabile, e la GET resta una. Ciò che questa prova sa uccidere è la
        // rilettura vera: tolti INSIEME il `useMemo` e la stringa, **5 rosse**, di
        // cui questa. Tolto il solo `useMemo`, invece, **nessuna rossa**: il
        // `useMemo` non è ciò che protegge, ed è scritto senza giri di parole
        // accanto a `chiaveIniziali` in `ComposizioneBonifico.tsx`.
        //
        // ⚠️ NESSUN DENOMINATORE, DI PROPOSITO. Qui sono già stati scritti due
        // totali che non si riproducevano più: il totale della suite non è un dato
        // della mutazione e invecchia a ogni prova che chiunque aggiunge a uno dei
        // tre file — è successo due volte, la seconda dentro il lotto stesso che
        // lo aveva appena corretto. Il numero di ROSSE è l'unica cosa che la
        // mutazione dimostra, e non invecchia.
        const { fn, chiamate } = rete()
        vi.stubGlobal('fetch', fn)
        monta({ alunniIniziali: [ALUNNO_1] })

        await screen.findByRole('checkbox', { name: /Retta settembre/ })
        // Un gesto che ridisegna, e non deve rileggere niente.
        fireEvent.click(spunta('Retta settembre'))
        await waitFor(() => expect(conferma()).toBeEnabled())

        expect(chiamate.contesto).toHaveLength(1)
    })

    it('LOCK · nella riga delle dipendenze dell’effetto c’è la stringa, non l’array', () => {
        // La metà che la prova qui sopra non può avere: si guarda la RIGA, perché
        // finché l'array a monte è memoizzato il comportamento è identico nei due
        // casi — e questa riga è l'unica cosa che tiene ferma la protezione vera.
        //
        // ⚠️ SI ESTRAE LA RIGA DELLE DIPENDENZE, non si cerca la parola nel file:
        // un lock che legge un sorgente come testo legge anche i commenti, e qui
        // sopra, in `ComposizioneBonifico.tsx`, «alunniScelti» compare in prosa più
        // volte. Il pattern prende solo la chiusura `}, [ … ])` di un effetto, che
        // in un commento non c'è.
        const sorgente = readFileSync(
            join(process.cwd(), 'src/components/features/admin/pagamenti/ComposizioneBonifico.tsx'),
            'utf8',
        )
        const dipendenze = sorgente
            .split('\n')
            .map((r) => r.match(/^\s*\}, \[([^\]]*)\]\)\s*$/)?.[1])
            .filter((d): d is string => typeof d === 'string' && d.includes('movimentoId'))

        expect(dipendenze, 'la riga delle dipendenze del caricamento del contesto').toHaveLength(1)
        expect(dipendenze[0], 'la stringa: `alunniScelti.join(",")`').toContain('alunniQuery')
        expect(dipendenze[0], 'mai l’array: un array nuovo a ogni render rilegge').not.toContain(
            'alunniScelti',
        )
    })
})

describe('ComposizioneBonifico — il bambino senza nessun genitore collegato', () => {
    /** Contesto pieno di voci ma con ZERO candidati: il caso dei due di Giugliano. */
    const senzaCandidati = contestoPieno({ pagante: { proposto: null, candidati: [] } })

    it('zero candidati ⇒ compare il blocco, compare «Collega un genitore», e «Conferma» resta SPENTO', async () => {
        const { fn } = rete({ ctxPieno: senzaCandidati })
        vi.stubGlobal('fetch', fn)
        monta({ alunniIniziali: [ALUNNO_1] })

        await screen.findByRole('checkbox', { name: /Retta settembre/ })
        // La composizione quadra: se «Conferma» restasse spento per la quadratura,
        // questa prova non direbbe niente sull'intestatario.
        fireEvent.click(spunta('Retta settembre'))

        const blocco = await screen.findByTestId('componi-senza-genitore')
        expect(blocco).toHaveTextContent(CAT.reconComponiNessunGenitoreTitolo)
        // 🔴 L'AVVISO SULL'EMAIL STA SOPRA IL PULSANTE, e non è una nota di stile:
        // con un indirizzo quel dialogo crea l'identità di accesso e MANDA LE
        // CREDENZIALI a una famiglia vera.
        expect(blocco).toHaveTextContent(CAT.reconComponiNessunGenitoreEmail)
        expect(
            within(blocco).getByRole('button', { name: new RegExp(CAT.reconComponiCollegaGenitore) }),
        ).toBeInTheDocument()

        // 🔴 E NON SI INVENTA UN PAGANTE: da quell'uuid si ricava l'intestatario di
        // una fattura vera, e la scrittura in questo caso degrada in apertura.
        expect(conferma()).toBeDisabled()
        expect(screen.getByTestId('componi-motivi')).toHaveTextContent(CAT.reconComponiIntestatario)
    })

    it('il blocco porta il gancio dell’Alto Contrasto, o il suo filetto non legge', async () => {
        // ⚠️ `kv-recon-avviso-sede` non parla di sedi: è l'UNICO selettore con cui
        // `globals.css` ridipinge `warn-strong` dentro `.kv-recon-dialog`. Senza,
        // in Alto Contrasto filetto e titolo restano a 3,10:1 su una superficie
        // diventata quasi nera — sotto i 4,5:1 di WCAG 1.4.3, su un riquadro che
        // avvisa che di lì partono le credenziali a una famiglia vera. Il lock
        // `__tests__/pagamenti/riconciliazione-a11y-css.test.ts` prova che la
        // regola CSS esiste; questa riga prova che qualcuno la usa.
        const { fn } = rete({ ctxPieno: senzaCandidati })
        vi.stubGlobal('fetch', fn)
        monta({ alunniIniziali: [ALUNNO_1] })

        expect(await screen.findByTestId('componi-senza-genitore')).toHaveClass('kv-recon-avviso-sede')
    })

    /**
     * ─── IL RIENTRO DEL FUOCO (WCAG 2.4.3), E PERCHÉ NON BASTAVA GUARDARE ────
     *
     * ⚠️ MISURATO CON UNA SONDA, non dedotto. Il ramo precedente controllava
     * `document.contains(bottone)` e lo trovava VERO: al ritorno dal dialogo il
     * pulsante «Collega un genitore» è ancora montato, perché la rilettura del
     * contesto è ancora in volo. Il fuoco ci finiva sopra; un istante dopo i
     * candidati arrivavano, il blocco spariva col suo pulsante e
     * `document.activeElement` cadeva su `<body>` — cioè esattamente il difetto
     * che quel ramo dichiarava di chiudere. Il ripiego su `selPagante` non
     * scattava MAI nel caso riuscito.
     *
     * Le due prove qui sotto sono la coppia: una per porta d'uscita. La seconda
     * non è decorazione — senza, «manda sempre tutto sulla tendina» passerebbe.
     */
    describe('il rientro del fuoco da «Collega un genitore»', () => {
        /** Prima lettura senza candidati; dopo il legame, il genitore c'è. */
        function reteCheCollega() {
            let letture = 0
            return vi.fn(async (url: RequestInfo | URL) => {
                const u = String(url)
                if (u.includes('/contesto')) {
                    letture += 1
                    return jsonRes(letture === 1 ? senzaCandidati : contestoPieno())
                }
                return jsonRes({ success: true, data: [], troncato: false, sedi: {} })
            })
        }

        const apriIlDialogo = async () => {
            const blocco = await screen.findByTestId('componi-senza-genitore')
            const collega = within(blocco).getByRole('button', {
                name: new RegExp(CAT.reconComponiCollegaGenitore),
            })
            fireEvent.click(collega)
            await screen.findByTestId('finto-dialogo-legame')
            return collega
        }

        it('LEGAME SCRITTO ⇒ il fuoco resta su un elemento VIVO, non su `<body>`', async () => {
            vi.stubGlobal('fetch', reteCheCollega())
            monta({ alunniIniziali: [ALUNNO_1] })

            await apriIlDialogo()
            fireEvent.click(screen.getByRole('button', { name: /FINTO legame scritto/ }))

            // ÀNCORA POSITIVA: si aspetta che la rilettura sia ATTERRATA — il
            // motivo del pagante esiste solo con un candidato proposto. È
            // l'istante dopo quello in cui il ramo di prima si dichiarava a posto.
            await screen.findByTestId('componi-motivo-pagante')
            expect(screen.queryByTestId('componi-senza-genitore')).toBeNull()

            expect(document.activeElement?.tagName, 'il fuoco è caduto su <body>').not.toBe('BODY')
            expect(document.activeElement).toBe(screen.getByLabelText(CAT.reconComponiIntestatario))
        })

        it('ANNULLATO ⇒ il fuoco torna sul pulsante, che lì esiste ancora', async () => {
            const { fn } = rete({ ctxPieno: senzaCandidati })
            vi.stubGlobal('fetch', fn)
            monta({ alunniIniziali: [ALUNNO_1] })

            const collega = await apriIlDialogo()
            fireEvent.click(screen.getByRole('button', { name: /FINTO annulla/ }))

            // Niente è stato scritto: il blocco resta, e il posto giusto è quello
            // da cui si è entrati.
            await waitFor(() => expect(document.activeElement).toBe(collega))
            expect(screen.getByTestId('componi-senza-genitore')).toBeInTheDocument()
        })
    })

    it('il pulsante è SOLO del bambino nelle mie sedi: fuori, quella scrittura risponde 403', async () => {
        // ⚠️ LA GUARDIA CHE NON SI ERA MAI VISTA SCATTARE. `figliCollegabili` filtra
        // su `in_sede`, e il commento accanto lo giustifica con «sarebbe mandare
        // l'operatrice contro un muro che sappiamo dov'è»: fuori dalle sue sedi il
        // nome del bambino non esce nemmeno dal contesto (`nome: null`) e la
        // scrittura del legame risponde 403. Tolto il filtro, quarantotto prove
        // restavano verdi e il pannello offriva «Collega un genitore» su un bambino
        // che non è suo. Non è un buco di sicurezza — a valle il no arriva — è una
        // guardia dichiarata e mai provata.
        const dueFigliUnoFuori = contestoPieno({
            pagante: { proposto: null, candidati: [] },
            figli: [
                {
                    alunno_id: ALUNNO_1,
                    nome: 'Primo Bambino',
                    scuola_id: SEDE_1,
                    in_sede: true,
                    attivo: true,
                    saldo_ticket: 0,
                    voci_aperte: [voce()],
                },
                {
                    // Fuori perimetro: il contesto non ne manda nemmeno il nome.
                    alunno_id: ALUNNO_2,
                    nome: null,
                    scuola_id: SEDE_2,
                    in_sede: false,
                    attivo: true,
                    saldo_ticket: 0,
                    voci_aperte: [],
                },
            ],
            sedi: { [SEDE_1]: 'Sede di prova', [SEDE_2]: 'Sede fuori perimetro' },
        })
        const { fn } = rete({ ctxPieno: dueFigliUnoFuori })
        vi.stubGlobal('fetch', fn)
        monta({ alunniIniziali: [ALUNNO_1] })

        const blocco = await screen.findByTestId('componi-senza-genitore')
        const bottoni = within(blocco).getAllByRole('button', {
            name: new RegExp(CAT.reconComponiCollegaGenitore),
        })
        expect(bottoni, 'un pulsante per ogni figlio COLLEGABILE, e sono due figli').toHaveLength(1)
        expect(bottoni[0]).toHaveAttribute(
            'aria-label',
            `${CAT.reconComponiCollegaGenitore} Primo Bambino`,
        )
    })

    it('senza nessun bambino il blocco NON compare: «questo bambino» sarebbe falso', async () => {
        const { fn } = rete()
        vi.stubGlobal('fetch', fn)
        monta()

        await screen.findByText(CAT.reconComponiVociAperteVuoto)
        expect(screen.queryByTestId('componi-senza-genitore')).toBeNull()
        // …e il motivo resta elencato dov'è sempre stato.
        expect(screen.getByTestId('componi-motivi')).toHaveTextContent(CAT.reconComponiIntestatario)
    })
})

describe('ComposizioneBonifico — «Aggiungi un altro bambino»', () => {
    const duePiccoli = {
        success: true,
        data: [
            {
                alunno_id: ALUNNO_2,
                nome: 'Secondo Bambino',
                classe_sezione: '2A',
                scuola_id: SEDE_1,
                attivo: true,
                voci_aperte: 2,
                residuo_aperto: 80,
                ha_pagante: true,
                trovato_per_cf: false,
            },
        ],
        troncato: false,
        sedi: { [SEDE_1]: 'Sede di prova' },
    }

    /** La risposta della ricerca PRECEDENTE, che torna in ritardo. */
    const sorpassata = {
        success: true,
        data: [
            {
                alunno_id: ALUNNO_3,
                nome: 'Bambino Sorpassato',
                classe_sezione: '3A',
                scuola_id: SEDE_1,
                attivo: true,
                voci_aperte: 1,
                residuo_aperto: 30,
                ha_pagante: true,
                trovato_per_cf: false,
            },
        ],
        troncato: false,
        sedi: { [SEDE_1]: 'Sede di prova' },
    }

    it('sotto i due caratteri non si interroga la rete, e si dice perché', async () => {
        const { fn, chiamate } = rete({ ricerca: duePiccoli })
        vi.stubGlobal('fetch', fn)
        monta({ alunniIniziali: [ALUNNO_1] })

        await screen.findByRole('checkbox', { name: /Retta settembre/ })
        fireEvent.change(screen.getByLabelText(CAT.reconComponiCercaBambino), {
            target: { value: 'a' },
        })

        await waitFor(() =>
            expect(screen.getByTestId('componi-ricerca-stato')).toHaveTextContent(/almeno 2/),
        )
        expect(chiamate.alunni).toHaveLength(0)
    })

    it('la riga porta classe e «n voci aperte, € X»: è la cifra su cui si decide', async () => {
        // 🔴 IL TERZO RAMO DI `dettaglioAlunno`, L'UNICO CHE PORTI UNA CIFRA IN EURO
        // ACCANTO AL NOME DI UN BAMBINO. Gli altri due erano provati — `null` («non
        // ho potuto contare») e lo zero, con la loro controprova in
        // `MovimentoDialog.test.tsx` — questo no: collassato su «Nessuna voce
        // aperta», cioè fatta dire alla schermata a chi sta incassando che un
        // bambino con 2 voci aperte e 80 € di residuo non deve niente, settantotto
        // prove restavano verdi. È l'informazione su cui l'operatrice decide se
        // questo bonifico quadra.
        const { fn } = rete({ ricerca: duePiccoli })
        vi.stubGlobal('fetch', fn)
        monta({ alunniIniziali: [ALUNNO_1] })

        await screen.findByRole('checkbox', { name: /Retta settembre/ })
        fireEvent.change(screen.getByLabelText(CAT.reconComponiCercaBambino), {
            target: { value: 'secondo' },
        })

        const riga = await screen.findByText('Secondo Bambino')
        expect(riga).toHaveTextContent(reso('reconRicercaAlunniVoci', { n: 2, totale: formatEuro(80) }))
        // La classe: con due omonimi è la prima cosa che li distingue.
        expect(riga).toHaveTextContent('2A')
        // 🔴 LE DUE METÀ NEGATIVE: senza, i tre rami collassati in uno solo —
        // qualunque dei tre — lascerebbero questa prova verde.
        expect(screen.queryByText(new RegExp(CAT.reconRicercaAlunniNessunaVoce))).toBeNull()
        expect(screen.queryByText(new RegExp(CAT.reconRicercaAlunniVociIgnote))).toBeNull()
    })

    it('la riga di stato è una REGIONE VIVA, e il `role="status"` del pannello resta UNO', async () => {
        // ⚠️ UN `data-testid` NON DISTINGUE UNA REGIONE VIVA DA UN PARAGRAFO
        // QUALUNQUE: tolti `aria-live` e `aria-atomic` da quel `<p>`, dodici prove
        // restavano verdi mentre l'elenco si riempiva e si svuotava in silenzio per
        // chi non vede lo schermo.
        // E l'altra metà è l'invariante argomentato sul JSX: qui lo `role="status"`
        // è UNO ed è la barra di quadratura — l'unica cosa che dice se si può
        // confermare. Un secondo `status` accanto renderebbe ambiguo «lo stato del
        // pannello», che è ciò che chi non vede lo schermo va a cercare.
        //
        // ⚠️ MA QUESTA INQUADRATURA È IL PANNELLO NUDO, e conta solo i suoi: il
        // vicino vero — la riga di stato della casella del popup, che resta a
        // schermo mentre il pannello è aperto — sta fuori campo. Chi lo conta è
        // l'ultimo `describe` di questo file, che monta i due componenti VERI.
        const { fn } = rete({ ricerca: duePiccoli })
        vi.stubGlobal('fetch', fn)
        monta({ alunniIniziali: [ALUNNO_1] })

        await screen.findByRole('checkbox', { name: /Retta settembre/ })
        const stato = screen.getByTestId('componi-ricerca-stato')
        expect(stato).toHaveAttribute('aria-live', 'polite')
        expect(stato).toHaveAttribute('aria-atomic', 'true')

        const vivi = screen.getAllByRole('status')
        expect(vivi, 'un solo `status`, ed è la quadratura').toHaveLength(1)
        expect(vivi[0]).not.toBe(stato)
        expect(vivi[0]).toHaveTextContent(CAT.reconComponiCampoTotale)
    })

    it('LA REGIONE VIVA DICE CHE STA CERCANDO: l’attesa non è un esito', async () => {
        // ⚠️ IL RAMO CHE NESSUNA DELLE DUE CASELLE TENEVA FERMO. La frase della
        // regione viva era scritta DUE volte — qui e in `MovimentoDialog` — e
        // «Sto cercando» non era asserito in nessuna delle due: sostituito
        // `reconRicercaAlunniInCorso` con una stringa qualunque in TUTT'E DUE i
        // file, centodiciannove prove restavano verdi. Adesso la funzione è una
        // sola (`use-ricerca-alunni`), e questa riga è la sua prova.
        //
        // Non è un dettaglio di stile: mentre la richiesta è in volo l'elenco è
        // vuoto, e una regione viva che TACE lascia leggere quel vuoto come «quel
        // bambino non c'è» — la conclusione opposta a quella vera.
        const fn = vi.fn(async (url: RequestInfo | URL) => {
            const u = String(url)
            if (u.includes('/contesto')) return jsonRes(contestoPieno())
            // La ricerca non risponde MAI: è l'unico modo di fermarsi dentro il
            // ramo `caricamento` e guardarlo.
            if (u.includes('/riconciliazione/alunni')) return await new Promise<Response>(() => {})
            return jsonRes({})
        })
        vi.stubGlobal('fetch', fn)
        monta({ alunniIniziali: [ALUNNO_1] })

        await screen.findByRole('checkbox', { name: /Retta settembre/ })
        fireEvent.change(screen.getByLabelText(CAT.reconComponiCercaBambino), {
            target: { value: 'secondo' },
        })

        const stato = () => screen.getByTestId('componi-ricerca-stato')
        await waitFor(() => expect(stato()).toHaveTextContent(CAT.reconRicercaAlunniInCorso))
        // LA METÀ NEGATIVA: l'attesa non si traveste da esito. «Nessun bambino
        // trovato» qui sarebbe una risposta che nessuno ha ancora dato.
        expect(stato()).not.toHaveTextContent(reso('reconRicercaAlunniTrovati', { n: 0 }))
    })

    it('ELENCO TRONCATO nel pannello: si scrive, o la lista tagliata fa concludere «non c’è»', async () => {
        // ⚠️ IL TRONCAMENTO ERA PROVATO NEL POPUP E NON QUI, e finché la frase era
        // scritta due volte questo era proprio il modo in cui le due copie
        // divergevano in silenzio: collassato il ramo del troncamento nel SOLO
        // pannello su `reconRicercaAlunniTrovati`, centodiciannove prove restavano
        // verdi e la casella diceva «1 bambino trovato» su un elenco tagliato.
        const { fn } = rete({ ricerca: { ...duePiccoli, troncato: true } })
        vi.stubGlobal('fetch', fn)
        monta({ alunniIniziali: [ALUNNO_1] })

        await screen.findByRole('checkbox', { name: /Retta settembre/ })
        fireEvent.change(screen.getByLabelText(CAT.reconComponiCercaBambino), {
            target: { value: 'secondo' },
        })

        await screen.findByText('Secondo Bambino')
        const stato = () => screen.getByTestId('componi-ricerca-stato')
        await waitFor(() =>
            expect(stato(), 'il troncamento è un DATO, non un dettaglio').toHaveTextContent(
                reso('reconRicercaAlunniTroncata', { n: 1 }),
            ),
        )
        // …e non la frase che farebbe credere di vedere tutto.
        expect(stato()).not.toHaveTextContent(reso('reconRicercaAlunniTrovati', { n: 1 }))
    })

    it('AL TETTO DEI CINQUE la casella sparisce, e si dice PERCHÉ', async () => {
        // ⚠️ IL TETTO NON È UN NUMERO SCELTO QUI: è `MAX_ALUNNI_CHIESTI` della rotta
        // `contesto`, dove lo impone uno `z.array(...).max(5)`. Superarlo non
        // «prende i primi cinque», fa 400 — e una composizione che si perde con un
        // 400 nella console è esattamente il fallire in silenzio che questo repo
        // non ammette. Il ramo non era esercitato da nessuna prova: mutato
        // `alPieno` in `false`, centodiciannove prove restavano verdi.
        //
        // Le DUE metà: la frase compare E la casella se ne va. Senza la seconda,
        // «scrivi l'avviso e lascia lì la casella» — cioè un invito a fare il gesto
        // che il server rifiuterà — resterebbe verde.
        const { fn } = rete({ ricerca: duePiccoli })
        vi.stubGlobal('fetch', fn)
        // Quattro dalla prop, il quinto aggiunto a mano: così la prova dice anche
        // che il tetto conta le due provenienze INSIEME, ed è la somma a chiuderlo.
        monta({ alunniIniziali: [ALUNNO_1, ALUNNO_3, ALUNNO_4, ALUNNO_5] })

        await screen.findByRole('checkbox', { name: /Retta settembre/ })
        // PRIMA: sotto il tetto la casella c'è e non si dice niente. Senza questa
        // metà, un pannello che nascondesse SEMPRE la casella passerebbe.
        expect(screen.getByLabelText(CAT.reconComponiCercaBambino)).toBeInTheDocument()
        expect(screen.queryByText(reso('reconComponiAlunniMax', { n: 5 }))).toBeNull()

        fireEvent.change(screen.getByLabelText(CAT.reconComponiCercaBambino), {
            target: { value: 'secondo' },
        })
        fireEvent.click(
            await screen.findByRole('button', {
                name: new RegExp(`${CAT.reconComponiAggiungi} Secondo Bambino`),
            }),
        )

        // DOPO: la frase compare…
        await waitFor(() =>
            expect(
                screen.getByText(reso('reconComponiAlunniMax', { n: 5 })),
                'al tetto si dice perché non si può aggiungerne un altro',
            ).toBeInTheDocument(),
        )
        // …e la casella se ne va, invece di invitare a un gesto che la rotta
        // rifiuterebbe con 400.
        expect(screen.queryByLabelText(CAT.reconComponiCercaBambino)).toBeNull()
        // Il riquadro resta, e con lui la marcia indietro: è da quel chip che si
        // torna sotto il tetto. Sparisse tutto, non ci sarebbe più nessuna strada.
        expect(screen.getByText(CAT.reconComponiAggiungiBambino)).toBeInTheDocument()
        expect(
            screen.getByRole('button', { name: new RegExp(`^${CAT.reconComponiTogliBambino}`) }),
        ).toBeInTheDocument()
    })

    it('SETTE BAMBINI NOMINATI, cinque in composizione: il taglio SI VEDE e dice quanti', async () => {
        // ⚠️ IL CASO È RAGGIUNGIBILE, NON TEORICO. `MovimentoDialog` passa
        // `alunniDelVerdetto(movimento)`, che parte da `alunni_senza_voci` —
        // costruito in `src/lib/pagamenti/riconciliazione.ts` da un
        // `new Set(estraiCodiciFiscali(...))` **senza nessun tetto**. Un bonifico
        // che nomina sette bambini apriva il pannello puntato su CINQUE e gli altri
        // due uscivano dalla composizione senza che niente a schermo lo dicesse:
        // quella parte dell'importo restava non allocata e nessuna traccia del
        // perché. Su denaro un taglio muto è un difetto, non un dettaglio.
        //
        // Le DUE metà: l'avviso c'è E dice DUE. Un avviso fisso su «1 bambino»
        // sarebbe verde su una prova che si accontenta della presenza.
        const { fn, chiamate } = rete()
        vi.stubGlobal('fetch', fn)
        monta({
            alunniIniziali: [ALUNNO_1, ALUNNO_2, ALUNNO_3, ALUNNO_4, ALUNNO_5, ALUNNO_6, ALUNNO_7],
        })

        await screen.findByRole('checkbox', { name: /Retta settembre/ })

        const avviso = screen.getByTestId('componi-alunni-esclusi')
        expect(avviso, 'quanti ne restano fuori, non «ce n’è qualcun altro»').toHaveTextContent(
            reso('reconComponiAlunniEsclusi', { n: 2 }),
        )
        // ⚠️ E NON È LA FRASE DEL TETTO: quella parla del limite ad AGGIUNGERNE un
        // altro, questa di bambini già TOLTI. Se `alPieno` bastasse, il taglio
        // resterebbe muto con la sua spiegazione sbagliata accanto.
        expect(avviso).not.toHaveTextContent(reso('reconComponiAlunniMax', { n: 5 }))

        // …e il tetto è rispettato PRIMA della rete: oltre i cinque la rotta
        // `contesto` risponde 400 con la sua `zod`, non «prende i primi cinque».
        const query = new URLSearchParams((chiamate.contesto.at(-1) ?? '').split('?')[1] ?? '')
        const mandati = (query.get('alunni') ?? '').split(',').filter(Boolean)
        expect(mandati, 'cinque, mai sette').toHaveLength(5)
        expect(mandati).not.toContain(ALUNNO_6)
        expect(mandati).not.toContain(ALUNNO_7)
    })

    it('CONTROPROVA · esattamente cinque bambini ⇒ NESSUN avviso di esclusione', async () => {
        // Senza questa metà, un avviso sempre acceso passerebbe la prova qui sopra.
        const { fn } = rete()
        vi.stubGlobal('fetch', fn)
        monta({ alunniIniziali: [ALUNNO_1, ALUNNO_2, ALUNNO_3, ALUNNO_4, ALUNNO_5] })

        await screen.findByRole('checkbox', { name: /Retta settembre/ })
        expect(screen.queryByTestId('componi-alunni-esclusi')).toBeNull()
        // Al tetto ci si è arrivati, e la SUA frase c'è: sono due cose diverse, e
        // questa prova è anche ciò che tiene ferma la differenza.
        expect(screen.getByText(reso('reconComponiAlunniMax', { n: 5 }))).toBeInTheDocument()
    })

    it('aggiunto un fratello, il contesto si rilegge con DUE bambini e le righe si azzerano', async () => {
        // È il bonifico che paga due fratelli non collegati allo stesso genitore:
        // oggi non si compone affatto.
        const { fn, chiamate } = rete({ ricerca: duePiccoli })
        vi.stubGlobal('fetch', fn)
        monta({ alunniIniziali: [ALUNNO_1] })

        await screen.findByRole('checkbox', { name: /Retta settembre/ })
        fireEvent.click(spunta('Retta settembre'))
        await waitFor(() => expect(conferma()).toBeEnabled())

        fireEvent.change(screen.getByLabelText(CAT.reconComponiCercaBambino), {
            target: { value: 'secondo' },
        })
        const aggiungi = await screen.findByRole('button', {
            name: new RegExp(`${CAT.reconComponiAggiungi} Secondo Bambino`),
        })
        fireEvent.click(aggiungi)

        // La rilettura porta ENTRAMBI i bambini nella query.
        await waitFor(() => expect(chiamate.contesto.length).toBeGreaterThan(1))
        expect(chiamate.contesto.at(-1)).toContain(ALUNNO_1)
        expect(chiamate.contesto.at(-1)).toContain(ALUNNO_2)

        // …e le righe di prima non ci sono più: le spunte sono memorizzate per
        // POSIZIONE nell'elenco piatto delle voci, e quell'elenco è cambiato.
        await waitFor(() => expect(conferma()).toBeDisabled())
        expect(spunta('Retta settembre')).not.toBeChecked()

        // 🔴 IL CHIP DEL BAMBINO APPENA AGGIUNTO NON PORTA UN NOME DI PLESSO.
        // Qui il contesto riletto non lo conosce ancora (è il caso vero: la
        // rilettura è in volo, e se fallisce ci si resta), e il ripiego era
        // `reconChipAltraSede` — «Altra sede», l'etichetta di un PLESSO usata come
        // nome di persona: il chip e la sua `aria-label` dicevano «Togli dalla
        // composizione Altra sede». Il «fuori dalle mie sedi» lo dice `nomeFiglio`,
        // che ha il dato per dirlo; qui il dato non c'è ancora, e si dice quello.
        const chip = screen.getByRole('button', {
            name: new RegExp(`^${CAT.reconComponiTogliBambino}`),
        })
        expect(chip).toHaveAttribute(
            'aria-label',
            `${CAT.reconComponiTogliBambino} ${CAT.reconComponiBambinoInArrivo}`,
        )
        expect(chip, 'un nome di plesso al posto di un nome di persona').not.toHaveTextContent(
            CAT.reconChipAltraSede,
        )

        // ⚠️ E IL CHIP SI PREME: è l'UNICA marcia indietro dal tetto dei cinque, e
        // finora di lui era asserita la sola `aria-label` — mutato il suo `onClick`
        // in un `setAlunniAggiunti((p) => p)`, cioè in un pulsante che non toglie
        // niente, centodiciannove prove restavano verdi. Un controllo la cui
        // etichetta è provata e la cui FUNZIONE no è un controllo non provato.
        const letture = chiamate.contesto.length
        fireEvent.click(chip)

        // Il contesto si rilegge, e adesso nomina il solo bambino di partenza: è la
        // prova che il bambino è uscito davvero dalla composizione, non solo dallo
        // schermo. (La stessa rilettura azzera di nuovo le righe, per la ragione di
        // sempre: le spunte sono memorizzate per POSIZIONE.)
        await waitFor(() => expect(chiamate.contesto.length).toBeGreaterThan(letture))
        expect(chiamate.contesto.at(-1)).toContain(ALUNNO_1)
        expect(chiamate.contesto.at(-1), 'tolto dallo schermo ma non dalla query').not.toContain(
            ALUNNO_2,
        )

        // …e il chip sparisce con lui: nessun residuo di una scelta annullata.
        await waitFor(() =>
            expect(
                screen.queryByRole('button', {
                    name: new RegExp(`^${CAT.reconComponiTogliBambino}`),
                }),
            ).toBeNull(),
        )
    })

    it('SORPASSO · la risposta VECCHIA che arriva per ultima non riscrive l’elenco', async () => {
        // ⚠️ L'ULTIMA RISPOSTA AD ARRIVARE NON È L'ULTIMA A ESSERE STATA CHIESTA, e
        // finora la protezione era DICHIARATA e mai vista scattare: tolto del tutto
        // il contatore d'epoca di `use-ricerca-alunni`, settantun prove restavano
        // verdi. A guardare le spalle è il CLEANUP dell'effetto — React lo esegue
        // (`attivo = false`) prima di rieseguirlo, quindi l'esecuzione sorpassata è
        // già spenta quando la sua `fetch` torna. Questa prova è l'unico modo di
        // vederlo: le due risposte si risolvono in ordine INVERSO.
        const attese = new Map<string, (r: Response) => void>()
        const fn = vi.fn(async (url: RequestInfo | URL) => {
            const u = String(url)
            if (u.includes('/contesto')) return jsonRes(contestoPieno())
            if (u.includes('/riconciliazione/alunni')) {
                const q = new URLSearchParams(u.slice(u.indexOf('?'))).get('q') ?? ''
                return await new Promise<Response>((risolvi) => attese.set(q, risolvi))
            }
            return jsonRes({})
        })
        vi.stubGlobal('fetch', fn)
        monta({ alunniIniziali: [ALUNNO_1] })

        await screen.findByRole('checkbox', { name: /Retta settembre/ })
        const casella = screen.getByLabelText(CAT.reconComponiCercaBambino)

        // Due ricerche in volo insieme: fra l'una e l'altra passa più del debounce,
        // quindi la prima è davvero partita e la sua risposta è davvero pendente.
        fireEvent.change(casella, { target: { value: 'primo' } })
        await waitFor(() => expect(attese.has('primo')).toBe(true))
        fireEvent.change(casella, { target: { value: 'secondo' } })
        await waitFor(() => expect(attese.has('secondo')).toBe(true))

        // Arriva prima la SECONDA…
        await act(async () => {
            attese.get('secondo')?.(jsonRes(duePiccoli))
        })
        await screen.findByText('Secondo Bambino')

        // …e poi la PRIMA, sorpassata: non deve scrivere niente.
        await act(async () => {
            attese.get('primo')?.(jsonRes(sorpassata))
        })

        expect(screen.queryByText('Bambino Sorpassato'), 'ha vinto la risposta vecchia').toBeNull()
        expect(screen.getByText('Secondo Bambino')).toBeInTheDocument()
    })

    it('una ricerca fallita NON diventa un elenco vuoto: lo stato è suo, e si vede', async () => {
        // «Non l'ho trovato» e «non ho potuto guardare» hanno rimedi opposti: il
        // secondo travestito da primo manda a creare una scheda per un bambino che
        // esiste già.
        const { fn } = rete({
            ricerca: { error: 'no', codice: 'CONCILIAZIONE_RICERCA_ALUNNI_NON_LETTA' },
            ricercaStatus: 500,
        })
        vi.stubGlobal('fetch', fn)
        monta({ alunniIniziali: [ALUNNO_1] })

        await screen.findByRole('checkbox', { name: /Retta settembre/ })
        fireEvent.change(screen.getByLabelText(CAT.reconComponiCercaBambino), {
            target: { value: 'secondo' },
        })

        const avviso = await screen.findByRole('alert')
        expect(avviso.textContent ?? '').not.toBe('')
        expect(screen.getByTestId('componi-ricerca-stato')).toHaveTextContent(
            CAT.reconRicercaAlunniNonRiuscita,
        )
    })

    it('200 COL CORPO ILLEGGIBILE: è un guasto, non «nessun bambino trovato»', async () => {
        // 🔴 IL TERZO MODO DI FALLIRE, e per un giro non c'era. La rete che non
        // risponde aveva il suo ramo (`catch`), il server che rifiuta pure
        // (`!res.ok`) — ma un 200 il cui corpo non si legge cadeva nel ramo del
        // SUCCESSO: `Array.isArray(corpo?.data)` falso, elenco vuoto, `stato`
        // `pronta`, nessun avviso e nemmeno una riga di log. A schermo si leggeva
        // «Nessun bambino trovato», cioè «non ho potuto guardare» travestito da
        // «non l'ho trovato» — i due rimedi sono opposti, e il secondo manda a
        // creare la scheda di un bambino che esiste già. Era esattamente la
        // regola 2 della testata di `use-ricerca-alunni.ts`, violata dentro il
        // file che la dichiara.
        //
        // La mutazione che questa prova uccide: tolto il ramo «senza dati»
        // dall'hook, qui torna `reconRicercaAlunniTrovati` e il `role="alert"`
        // sparisce.
        const { fn, chiamate } = rete({ ricercaCorpoIlleggibile: true })
        vi.stubGlobal('fetch', fn)
        monta({ alunniIniziali: [ALUNNO_1] })

        await screen.findByRole('checkbox', { name: /Retta settembre/ })
        fireEvent.change(screen.getByLabelText(CAT.reconComponiCercaBambino), {
            target: { value: 'secondo' },
        })

        // Àncora POSITIVA: si aspetta la comparsa dell'avviso, non l'assenza di
        // qualcosa — un'assenza sarebbe vera anche con la fetch ancora in volo.
        const avviso = await screen.findByRole('alert')
        expect(avviso.textContent ?? '').not.toBe('')
        const viva = screen.getByTestId('componi-ricerca-stato')
        expect(viva).toHaveTextContent(CAT.reconRicercaAlunniNonRiuscita)
        // E la frase del successo NON deve esserci: è la metà che distingue
        // questa prova da un «c'è un alert da qualche parte».
        expect(viva).not.toHaveTextContent(/trovat/i)
        // La domanda era partita davvero: senza questa riga la prova sarebbe
        // verde anche se la ricerca non avesse mai interrogato la rete.
        expect(chiamate.alunni.length).toBeGreaterThan(0)
    })
})

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LA COPPIA CHE NESSUNO DEI DUE FILE POTEVA VEDERE — popup + pannello VERO.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 🔴 IL DIFETTO CHE QUESTA PROVA CHIUDE, e perché è dovuto nascere qui.
 * Il blocco della ricerca del popup è guardato da `!composto`, NON da
 * `!componiAperto`: è fratello del ternario che monta il pannello, dentro lo
 * stesso `div`. Quindi con la composizione aperta la casella di ricerca resta a
 * schermo, e fino al 2026-09-20 la sua riga di stato era un SECONDO
 * `role="status"` accanto alla barra di quadratura del pannello — mentre due
 * commenti, uno per file, giuravano ciascuno che il suo `status` fosse l'unico.
 *
 * ⚠️ E I DUE LOCK CHE AVREBBERO DOVUTO VEDERLO ERANO VERDI PER VIA DEI MOCK:
 * `MovimentoDialog.test.tsx` sostituisce `ComposizioneBonifico` con uno stub
 * (niente barra di quadratura), e le prove qui sopra montano il pannello NUDO
 * (niente popup). La coppia vera non stava in nessuna delle due inquadrature:
 * misurato col pannello vero dentro il popup, `getAllByRole('status')` tornava
 * **2**. Questo file può montarla perché è l'unico dei due che non mocka il
 * pannello.
 */
describe('MovimentoDialog + ComposizioneBonifico veri — una sola regione «status» per superficie', () => {
    /** La riga come la porge la lista: quel che serve al popup, niente di più. */
    const movUi = {
        ...movimento,
        suggerimenti: [],
    } as unknown as MovimentoUi

    const apri = () => {
        const { fn } = rete()
        vi.stubGlobal('fetch', fn)
        render(
            <MovimentoDialog
                movimento={movUi}
                aperti={[]}
                userId="u1"
                onClose={() => {}}
                onDone={() => {}}
                returnFocusRef={{ current: null }}
            />,
        )
    }

    it('🔴 LA COPPIA · composizione APERTA ⇒ i `role="status"` a schermo restano UNO', async () => {
        apri()
        const statoPopup = screen.getByTestId('movdlg-ricerca-stato')

        fireEvent.click(screen.getByRole('button', { name: new RegExp(CAT.reconComponiTitolo) }))

        // Àncora positiva: il pannello ha finito di leggere il contesto. Senza,
        // il conteggio qui sotto girerebbe con la fetch ancora in volo — cioè
        // senza la barra di quadratura, e tornerebbe 1 anche col difetto in piedi.
        await screen.findByText(CAT.reconComponiVociAperteVuoto)

        // I due VICINI, insieme a schermo: la casella del popup è ancora lì (il
        // suo blocco è guardato da `!composto`, non da `!componiAperto`) e il
        // pannello ha montato la sua barra.
        expect(screen.getByLabelText(CAT.movdlgCercaAriaLabel)).toBeInTheDocument()
        expect(statoPopup).toBeInTheDocument()

        const vivi = screen.getAllByRole('status')
        expect(vivi, 'uno per superficie, ed è quello che dice se si può confermare').toHaveLength(1)
        expect(vivi[0]).toHaveTextContent(CAT.reconComponiCampoTotale)
        expect(vivi[0]).not.toBe(statoPopup)
    })

    it('la riga di stato del popup è una regione viva, e col pannello chiuso non c’è nessuno `status`', () => {
        // ⚠️ UN `data-testid` NON DISTINGUE UNA REGIONE VIVA DA UN PARAGRAFO
        // QUALUNQUE: senza questi due attributi l'elenco si riempie e si svuota in
        // silenzio per chi non vede lo schermo. Scambiarli con `role="status"`
        // sarebbe identico per un lettore di schermo e rifarebbe la coppia qui
        // sopra: per questo il conteggio a zero sta accanto agli attributi.
        apri()
        const statoPopup = screen.getByTestId('movdlg-ricerca-stato')
        expect(statoPopup).toHaveAttribute('aria-live', 'polite')
        expect(statoPopup).toHaveAttribute('aria-atomic', 'true')
        expect(screen.queryAllByRole('status')).toHaveLength(0)
    })
})
