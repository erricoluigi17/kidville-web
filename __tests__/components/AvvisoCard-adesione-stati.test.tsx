import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { axe, toHaveNoViolations } from 'jest-axe'
import { IntlMessageFormat } from 'intl-messageformat'

import { AvvisoCard, type Avviso } from '@/components/features/avvisi/AvvisoCard'
import itAvvisi from '../../messages/it/avvisi.json'

expect.extend(toHaveNoViolations)

// =============================================================================
// C3 — LA BACHECA DEL GENITORE HA CINQUE STATI, E NESSUNO DI LORO È IL SILENZIO.
//
// ── I DUE DIFETTI CHIUSI QUI ────────────────────────────────────────────────
//
//  · A termine passato i due bottoni SPARIVANO senza una parola. Il genitore
//    leggeva un avviso che chiede l'adesione e non aveva nessun modo di
//    rispondere né di sapere perché. «Niente bottoni» e «bottoni non ancora
//    caricati» avevano lo stesso aspetto.
//
//  · `AvvisoCard.tsx:91` faceva `new Date(avviso.scadenza) < new Date()`:
//    mezzanotte **UTC** misurata sull'orologio del dispositivo, cioè dalle 02:00
//    italiane un avviso valido per altre ventidue ore si dichiarava scaduto. Ora
//    i due booleani arrivano dal server, e questo file lo prova nel verso che
//    conta: con `adesioni_chiuse: false` e una scadenza nel PASSATO i bottoni
//    restano: se la card ricostruisse il confronto, sparirebbero.
//
// ── LO STATO CHE NON ARRIVAVA A NESSUNO ─────────────────────────────────────
//
// `stato_adesione` esiste in colonna dal cantiere A2 e non usciva dal server: la
// card mostrava «Hai aderito ✓» anche a chi era in lista d'attesa, cioè
// annunciava un posto che non c'era.
//
// 🔴 E i posti liberi non si mostrano MAI (decisione n. 17 del committente): la
// famiglia vede che è in coda, non quanto spazio resta agli altri. L'ultimo
// blocco di questo file è l'asserzione NEGATIVA che lo misura sull'albero reso.
// =============================================================================

afterEach(cleanup)

/** I testi si prendono dal CATALOGO e si formattano come in produzione: una
 *  stringa battuta a mano nel test resterebbe verde anche dopo averla cambiata
 *  a schermo. */
const T = (chiave: keyof typeof itAvvisi, valori?: Record<string, unknown>): string =>
    valori === undefined
        ? itAvvisi[chiave]
        : String(new IntlMessageFormat(itAvvisi[chiave], 'it').format(valori))

/** Dati inventati: nessun contenuto reale di famiglie o bambini nei test. */
const BASE: Avviso = {
    id: 'avv-adesione-1',
    author_id: 'aut-1',
    titolo: 'TEST Gita al museo',
    contenuto: 'TEST corpo della comunicazione.',
    tipo: 'adesione',
    target_scope: 'globale',
    target_classes: null,
    scadenza: null,
    scadenza_avviso: '2026-10-01T09:00:00.000Z',
    scadenza_adesione: '2026-09-25T09:00:00.000Z',
    chiedi_numero: true,
    etichetta_numero: 'TEST quante persone verranno?',
    numero_min: 1,
    numero_max: 10,
    scaduto: false,
    adesioni_chiuse: false,
    attachment_url: null,
    created_at: '2026-09-01T08:00:00.000Z',
    author: { first_name: 'TEST', last_name: 'Segreteria', role: 'segreteria' },
    stats: { letti: 0, adesioni_si: 0, adesioni_no: 0 },
    my_response: null,
}

const avvisoCon = (p: Partial<Avviso>): Avviso => ({ ...BASE, ...p })

/** Monta la card e la APRE: le azioni vivono nel pannello del disclosure. */
function apri(avviso: Avviso, props: Partial<React.ComponentProps<typeof AvvisoCard>> = {}) {
    const esito = render(<AvvisoCard avviso={avviso} index={0} {...props} />)
    fireEvent.click(screen.getByRole('button', { name: avviso.titolo }))
    return esito
}

describe('AvvisoCard · adesioni APERTE — il genitore ha le due scelte', () => {
    it('senza risposta mostra «Aderisco» e «Non aderisco»', () => {
        apri(BASE)
        expect(screen.getByRole('button', { name: T('aderisco') })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: T('nonAderisco') })).toBeInTheDocument()
    })

    it('🔴 «Aderisco» NON scrive: dichiara il gesto e passa l’avviso intero', () => {
        // La scrittura avviene una volta sola, alla conferma della modale — che la
        // card non monta e non conosce. Qui si prova solo che il gesto esce di qui
        // con ciò che serve a decidere (`chiedi_numero`, etichetta, intervallo).
        const onAdesione = vi.fn()
        const fetchSpia = vi.fn()
        const precedente = globalThis.fetch
        globalThis.fetch = fetchSpia as unknown as typeof globalThis.fetch
        try {
            apri(BASE, { onAdesione })
            fireEvent.click(screen.getByRole('button', { name: T('aderisco') }))

            expect(onAdesione).toHaveBeenCalledTimes(1)
            expect(onAdesione).toHaveBeenCalledWith(BASE, 'si')
            expect(fetchSpia, 'la card ha scritto da sola').not.toHaveBeenCalled()
        } finally {
            globalThis.fetch = precedente
        }
    })

    it('«Non aderisco» dichiara la risposta negativa', () => {
        const onAdesione = vi.fn()
        apri(BASE, { onAdesione })
        fireEvent.click(screen.getByRole('button', { name: T('nonAderisco') }))
        expect(onAdesione).toHaveBeenCalledWith(BASE, 'no')
    })

    it('🔴 i booleani vengono dal SERVER: una scadenza nel passato NON spegne i bottoni', () => {
        // Il controllo che distingue «la card usa `adesioni_chiuse`» da «la card
        // rifà il confronto». Con la riga vecchia (`new Date(scadenza) < new
        // Date()`) questi bottoni sparirebbero: qui la scadenza è del 2020 e il
        // server dice che le adesioni sono aperte — è il server ad avere ragione,
        // perché è lui a raccogliere le risposte.
        apri(avvisoCon({
            scadenza: '2020-01-01',
            scadenza_avviso: '2020-01-01T00:00:00.000Z',
            scadenza_adesione: '2020-01-01T00:00:00.000Z',
            scaduto: false,
            adesioni_chiuse: false,
        }))
        expect(screen.getByRole('button', { name: T('aderisco') })).toBeInTheDocument()
    })
})

describe('AvvisoCard · adesioni CHIUSE — si spiega, e non si risponde più', () => {
    it('senza risposta: «Non hai risposto in tempo», e NESSUN bottone di adesione', () => {
        apri(avvisoCon({ adesioni_chiuse: true }))

        expect(screen.getByText(T('adesioniChiuseSenzaRisposta'))).toBeInTheDocument()
        // Il difetto vero: prima qui non c'era niente. Le due negative valgono
        // perché accanto c'è la positiva qui sopra.
        expect(screen.queryByRole('button', { name: T('aderisco') })).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: T('nonAderisco') })).not.toBeInTheDocument()
    })

    it('con risposta già data: lo stato resta leggibile, col GIORNO in cui si sono chiuse', () => {
        apri(avvisoCon({
            adesioni_chiuse: true,
            my_response: { letto_il: 'x', risposta: 'si', risposto_il: 'x', stato_adesione: 'ammessa', numero_partecipanti: 3 },
        }))

        expect(screen.getByText(T('haiAderitoPersone', { count: 3 }))).toBeInTheDocument()
        // La data è formattata da `formatData` (Europe/Rome, locale esplicito): il
        // 25/09 alle 09:00 UTC sono le 11:00 italiane, e il giorno resta il 25.
        // Si cerca la FRASE intera e non «25/09»: quella data compare anche nella
        // riga della scadenza qui sopra, e `getByText` pesca i sosia.
        expect(screen.getByText(T('adesioniChiuse', { data: '25/09/2026, 11:00' }))).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: T('ritiraAdesione') })).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: T('modificaNumero') })).not.toBeInTheDocument()
    })
})

describe('AvvisoCard · i tre esiti di una risposta già data', () => {
    it('AMMESSA: «Hai aderito per N persone», più «Modifica il numero» e «Ritira l’adesione»', () => {
        apri(avvisoCon({
            my_response: { letto_il: 'x', risposta: 'si', risposto_il: 'x', stato_adesione: 'ammessa', numero_partecipanti: 4 },
        }))

        expect(screen.getByText(T('haiAderitoPersone', { count: 4 }))).toBeInTheDocument()
        expect(screen.getByRole('button', { name: T('modificaNumero') })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: T('ritiraAdesione') })).toBeInTheDocument()
    })

    it('🔴 IN LISTA D’ATTESA: lo dice, e NON dice «Hai aderito»', () => {
        // È il difetto che `stato_adesione` chiude: prima questa famiglia leggeva
        // «Hai aderito ✓» mentre il database la teneva in coda.
        apri(avvisoCon({
            my_response: { letto_il: 'x', risposta: 'si', risposto_il: 'x', stato_adesione: 'in_attesa', numero_partecipanti: 2 },
        }))

        expect(screen.getByText(T('seiInAttesaPersone', { count: 2 }))).toBeInTheDocument()
        expect(screen.queryByText(T('haiAderitoPersone', { count: 2 }))).not.toBeInTheDocument()
        // Restano i due comandi: chi è in coda può correggere il numero e ritirarsi.
        expect(screen.getByRole('button', { name: T('modificaNumero') })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: T('ritiraAdesione') })).toBeInTheDocument()
    })

    it('senza numero dichiarato (righe storiche) non si inventa «1 persona»', () => {
        apri(avvisoCon({
            chiedi_numero: false,
            my_response: { letto_il: 'x', risposta: 'si', risposto_il: 'x', stato_adesione: 'ammessa', numero_partecipanti: null },
        }))

        expect(screen.getByText(T('haiAderitoConferma'))).toBeInTheDocument()
        expect(screen.queryByText(T('haiAderitoPersone', { count: 1 }))).not.toBeInTheDocument()
        // …e senza contatore non c'è niente da modificare: il comando non compare.
        expect(screen.queryByRole('button', { name: T('modificaNumero') })).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: T('ritiraAdesione') })).toBeInTheDocument()
    })

    it('DECLINATO: «Hai declinato» e «Cambia risposta», che riapre le due scelte SENZA scrivere', () => {
        const onAdesione = vi.fn()
        apri(avvisoCon({
            my_response: { letto_il: 'x', risposta: 'no', risposto_il: 'x', stato_adesione: null, numero_partecipanti: null },
        }), { onAdesione })

        expect(screen.getByText(T('haiDeclinato'))).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: T('cambiaRisposta') }))

        expect(screen.getByRole('button', { name: T('aderisco') })).toBeInTheDocument()
        // Ripensarci non è una risposta: finché non se ne dà una nuova, niente esce.
        expect(onAdesione).not.toHaveBeenCalled()
    })

    it('«Modifica il numero» chiede la modale alla pagina, non scrive', () => {
        const onModificaNumero = vi.fn()
        const avviso = avvisoCon({
            my_response: { letto_il: 'x', risposta: 'si', risposto_il: 'x', stato_adesione: 'ammessa', numero_partecipanti: 4 },
        })
        apri(avviso, { onModificaNumero })

        fireEvent.click(screen.getByRole('button', { name: T('modificaNumero') }))
        expect(onModificaNumero).toHaveBeenCalledWith(avviso)
    })
})

// ═════════════════════════════════════════════════════════════════════════════
// 🔴 IL BADGE DELLA TESTATA — è ciò che la famiglia legge SENZA aprire la card.
//
// Il corpo diceva già la verità, e il difetto è sopravvissuto lo stesso per due
// settimane: `statusBadge` guardava il solo `myAnswer`, quindi a chi era in coda
// annunciava «HAI ADERITO» in verde sopra al pannello chiuso. Su un telefono, la
// riga di corpo che lo smentisce è dietro a un tocco che la maggior parte delle
// famiglie non fa.
//
// Le asserzioni qui NON aprono la card, di proposito: aprirla misurerebbe di
// nuovo il corpo, cioè la metà che non era rotta.
// ═════════════════════════════════════════════════════════════════════════════
describe('AvvisoCard · il badge dice la coda, e non dice «Hai aderito»', () => {
    it('🔴 IN ATTESA: il badge è «In lista d’attesa», a card CHIUSA', () => {
        render(<AvvisoCard index={0} avviso={avvisoCon({
            my_response: { letto_il: 'x', risposta: 'si', risposto_il: 'x', stato_adesione: 'in_attesa', numero_partecipanti: 2 },
        })} />)

        expect(screen.getByText(T('badgeInAttesa'))).toBeInTheDocument()
        // L'asserzione NEGATIVA è il difetto misurato: la frase che prometteva un
        // posto che non c'era.
        expect(screen.queryByText(T('badgeHaiAderito')), 'il badge promette ancora un posto').not.toBeInTheDocument()
    })

    it('CONTROLLO POSITIVO: ammessa → il badge torna «Hai aderito»', () => {
        // Senza questo, «non dice Hai aderito» sarebbe verde anche con il badge
        // sparito del tutto, o bloccato per sempre su «In lista d’attesa».
        render(<AvvisoCard index={0} avviso={avvisoCon({
            my_response: { letto_il: 'x', risposta: 'si', risposto_il: 'x', stato_adesione: 'ammessa', numero_partecipanti: 2 },
        })} />)

        expect(screen.getByText(T('badgeHaiAderito'))).toBeInTheDocument()
        expect(screen.queryByText(T('badgeInAttesa'))).not.toBeInTheDocument()
    })

    it('🔴 basta UN figlio in coda: l’aggregato è `null`, il badge no', () => {
        // Marco ammesso, Giulia in coda: `risposta` CONCORDA («sì» per entrambi),
        // quindi `my_response.stato_adesione` è `null` — e `null` vale «ammesso»,
        // perché le righe storiche non hanno stato. È il caso in cui il badge
        // mentiva pur con il server perfettamente onesto.
        render(<AvvisoCard index={0} avviso={avvisoCon({
            my_response: { letto_il: 'x', risposta: 'si', risposto_il: 'x', stato_adesione: null, numero_partecipanti: 3 },
            figli: [
                { student_id: 's-1', nome: 'TEST Marco', stato_adesione: 'ammessa', numero_partecipanti: 3 },
                { student_id: 's-2', nome: 'TEST Giulia', stato_adesione: 'in_attesa', numero_partecipanti: 3 },
            ],
        })} />)

        expect(screen.getByText(T('badgeInAttesa'))).toBeInTheDocument()
        expect(screen.queryByText(T('badgeHaiAderito'))).not.toBeInTheDocument()
    })
})

describe('AvvisoCard · due figli in due posti diversi: lo stato si dice PER FIGLIO', () => {
    const misto = () => avvisoCon({
        // I due figli hanno detto sì tutti e due e hanno lo stesso numero: è
        // proprio il caso in cui l'aggregazione del server valorizza `risposta` e
        // `numero_partecipanti` e azzera SOLO lo stato.
        my_response: { letto_il: 'x', risposta: 'si', risposto_il: 'x', stato_adesione: null, numero_partecipanti: 3 },
        figli: [
            { student_id: 's-1', nome: 'TEST Marco', stato_adesione: 'ammessa', numero_partecipanti: 3 },
            { student_id: 's-2', nome: 'TEST Giulia', stato_adesione: 'in_attesa', numero_partecipanti: 3 },
        ],
    })

    it('🔴 nomina la coda, e NON scrive «Hai aderito per 3 persone ✓»', () => {
        apri(misto())

        expect(screen.getByText(T('adesioneEsitoAttesaFiglio', { nome: 'TEST Giulia' }))).toBeInTheDocument()
        expect(screen.getByText(T('adesioneEsitoAmmessoFiglio', { nome: 'TEST Marco' }))).toBeInTheDocument()
        // La frase misurata sul difetto: verde, con un numero, e senza la parola
        // «attesa» da nessuna parte.
        expect(
            screen.queryByText(T('haiAderitoPersone', { count: 3 })),
            'la card dice ancora «Hai aderito» a una famiglia mezza in coda',
        ).not.toBeInTheDocument()
    })

    it('CONTROLLO POSITIVO: se i figli stanno nello stesso posto resta UNA frase sola', () => {
        // Senza questo, l'elenco per figlio sarebbe verde anche se comparisse
        // sempre — cioè anche se avesse sostituito la frase aggregata per tutti.
        apri(avvisoCon({
            my_response: { letto_il: 'x', risposta: 'si', risposto_il: 'x', stato_adesione: 'ammessa', numero_partecipanti: 3 },
            figli: [
                { student_id: 's-1', nome: 'TEST Marco', stato_adesione: 'ammessa', numero_partecipanti: 3 },
                { student_id: 's-2', nome: 'TEST Giulia', stato_adesione: 'ammessa', numero_partecipanti: 3 },
            ],
        }))

        expect(screen.getByText(T('haiAderitoPersone', { count: 3 }))).toBeInTheDocument()
        expect(screen.queryByText(T('adesioneEsitoAmmessoFiglio', { nome: 'TEST Marco' }))).not.toBeInTheDocument()
    })

    it('i comandi restano: chi ha un figlio in coda può ancora correggere e ritirare', () => {
        apri(misto())
        expect(screen.getByRole('button', { name: T('modificaNumero') })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: T('ritiraAdesione') })).toBeInTheDocument()
    })

    it('anche ad adesioni CHIUSE lo stato per figlio resta leggibile', () => {
        apri(avvisoCon({
            adesioni_chiuse: true,
            my_response: { letto_il: 'x', risposta: 'si', risposto_il: 'x', stato_adesione: null, numero_partecipanti: 3 },
            figli: [
                { student_id: 's-1', nome: 'TEST Marco', stato_adesione: 'ammessa', numero_partecipanti: 3 },
                { student_id: 's-2', nome: 'TEST Giulia', stato_adesione: 'in_attesa', numero_partecipanti: 3 },
            ],
        }))

        expect(screen.getByText(T('adesioneEsitoAttesaFiglio', { nome: 'TEST Giulia' }))).toBeInTheDocument()
        expect(screen.queryByText(T('haiAderitoPersone', { count: 3 }))).not.toBeInTheDocument()
    })
})

describe('AvvisoCard · il ritiro si conferma IN LINEA, a due passi', () => {
    const conAdesione = () => avvisoCon({
        my_response: { letto_il: 'x', risposta: 'si', risposto_il: 'x', stato_adesione: 'ammessa', numero_partecipanti: 2 },
    })

    it('il primo tocco non ritira niente: chiede conferma e porta il fuoco sul «Sì»', () => {
        const onAdesione = vi.fn()
        apri(conAdesione(), { onAdesione })

        fireEvent.click(screen.getByRole('button', { name: T('ritiraAdesione') }))

        expect(screen.getByText(T('ritiraConferma'))).toBeInTheDocument()
        expect(onAdesione, 'ha ritirato al primo tocco').not.toHaveBeenCalled()
        // Il bottone che aveva il fuoco è sparito: senza questo, il fuoco cadrebbe
        // su `<body>`, cioè in cima alla pagina (WCAG 2.4.3).
        expect(document.activeElement).toBe(screen.getByRole('button', { name: T('ritiraSi') }))
    })

    it('il secondo tocco ritira; «Annulla» torna indietro senza scrivere', () => {
        const onAdesione = vi.fn()
        const avviso = conAdesione()
        apri(avviso, { onAdesione })

        fireEvent.click(screen.getByRole('button', { name: T('ritiraAdesione') }))
        fireEvent.click(screen.getByRole('button', { name: T('ritiraAnnulla') }))
        expect(onAdesione).not.toHaveBeenCalled()
        expect(screen.getByRole('button', { name: T('ritiraAdesione') })).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: T('ritiraAdesione') }))
        fireEvent.click(screen.getByRole('button', { name: T('ritiraSi') }))
        expect(onAdesione).toHaveBeenCalledTimes(1)
        expect(onAdesione).toHaveBeenCalledWith(avviso, 'no')
    })

    it('la domanda è legata ai due comandi da `aria-describedby`', () => {
        apri(conAdesione())
        fireEvent.click(screen.getByRole('button', { name: T('ritiraAdesione') }))

        const si = screen.getByRole('button', { name: T('ritiraSi') })
        const id = si.getAttribute('aria-describedby')
        expect(id, 'il «Sì, ritira» non dichiara che cosa sta confermando').toBeTruthy()
        expect(document.getElementById(String(id))?.textContent).toBe(T('ritiraConferma'))
    })
})

describe('AvvisoCard · le due scadenze nel corpo, con data E ora', () => {
    it('dice fino a quando si legge e entro quando si risponde', () => {
        const { container } = render(<AvvisoCard avviso={BASE} index={0} />)
        fireEvent.click(screen.getByRole('button', { name: BASE.titolo }))

        // 01/10 11:00 italiane e 25/09 11:00 italiane: il fuso è dichiarato in
        // `formatData` (Europe/Rome), non ereditato dall'ambiente — su Vercel
        // l'ambiente è UTC e la stessa riga renderebbe un altro giorno.
        expect(container.textContent).toContain(T('visibileFinoAl', { data: '01/10/2026, 11:00' }))
        expect(container.textContent).toContain(T('perAderireEntro', { data: '25/09/2026, 11:00' }))
    })

    it('a termine chiuso la seconda riga cambia frase', () => {
        const { container } = render(<AvvisoCard avviso={avvisoCon({ adesioni_chiuse: true })} index={0} />)
        fireEvent.click(screen.getByRole('button', { name: BASE.titolo }))

        expect(container.textContent).toContain(T('adesioniChiuseIl', { data: '25/09/2026, 11:00' }))
        expect(container.textContent).not.toContain(T('perAderireEntro', { data: '25/09/2026, 11:00' }))
    })
})

// ═════════════════════════════════════════════════════════════════════════════
// 🔴 L'ASSERZIONE NEGATIVA — nessun numero di posti liberi, da nessuna parte.
// ═════════════════════════════════════════════════════════════════════════════
describe('AvvisoCard · al genitore non arriva MAI un numero di posti', () => {
    it('né il tetto, né gli ammessi, né la differenza fra i due', () => {
        // I tre numeri sono scelti perché non possono nascere da nient'altro in
        // questa card: 97 (il tetto), 40 (gli ammessi) e 57 (la sottrazione, che è
        // il dato vietato vero — nessuno lo scrive, si ricava). La riga li porta
        // come se una regressione avesse riaperto la proiezione del server: la card
        // non deve comunque mostrarli.
        const { container } = render(
            <AvvisoCard
                index={0}
                avviso={{
                    ...avvisoCon({
                        my_response: { letto_il: 'x', risposta: 'si', risposto_il: 'x', stato_adesione: 'in_attesa', numero_partecipanti: 2 },
                    }),
                    ...({ posti_totali: 97 } as Record<string, unknown>),
                    stats: { letti: 0, adesioni_si: 0, adesioni_no: 0, persone_ammesse: 40 } as Avviso['stats'],
                }}
            />,
        )
        fireEvent.click(screen.getByRole('button', { name: BASE.titolo }))

        // Controllo positivo accanto: la card sta rendendo davvero qualcosa, e dice
        // alla famiglia la cosa che le spetta.
        expect(screen.getByText(T('seiInAttesaPersone', { count: 2 }))).toBeInTheDocument()

        for (const proibito of ['97', '57', '40']) {
            expect(container.textContent, `«${proibito}» è comparso a schermo`).not.toContain(proibito)
            expect(container.innerHTML, `«${proibito}» è in un attributo`).not.toContain(`>${proibito}<`)
        }
    })
})

describe('AvvisoCard · accessibilità dei nuovi stati', () => {
    const opzioni = {
        rules: {
            region: { enabled: false },
            'landmark-one-main': { enabled: false },
            'page-has-heading-one': { enabled: false },
        },
    }

    it('axe non trova violazioni su adesione aperta, ammessa e conferma di ritiro', async () => {
        // `jest-axe` IN AGGIUNTA, mai al posto: le asserzioni sui ruoli e sui nomi
        // qui sopra provano cose che axe non guarda (che il bottone giusto ci sia,
        // e che dica la frase giusta).
        const { container, unmount } = render(<AvvisoCard avviso={BASE} index={0} />)
        fireEvent.click(screen.getByRole('button', { name: BASE.titolo }))
        expect(await axe(container, opzioni)).toHaveNoViolations()
        unmount()

        const seconda = render(
            <AvvisoCard
                index={0}
                avviso={avvisoCon({
                    my_response: { letto_il: 'x', risposta: 'si', risposto_il: 'x', stato_adesione: 'ammessa', numero_partecipanti: 3 },
                })}
            />,
        )
        fireEvent.click(screen.getByRole('button', { name: BASE.titolo }))
        expect(await axe(seconda.container, opzioni)).toHaveNoViolations()

        fireEvent.click(screen.getByRole('button', { name: T('ritiraAdesione') }))
        expect(await axe(seconda.container, opzioni)).toHaveNoViolations()
    })

    it('lo stato dell’adesione è TESTO, non un colore soltanto', () => {
        // Il tono caldo distingue la coda dall'ammissione a colpo d'occhio, ma chi
        // non vede il colore deve leggere la differenza: WCAG 1.4.1.
        const { container } = render(
            <AvvisoCard
                index={0}
                avviso={avvisoCon({
                    my_response: { letto_il: 'x', risposta: 'si', risposto_il: 'x', stato_adesione: 'in_attesa', numero_partecipanti: 2 },
                })}
            />,
        )
        fireEvent.click(screen.getByRole('button', { name: BASE.titolo }))
        expect(within(container).getByText(T('seiInAttesaPersone', { count: 2 }))).toBeInTheDocument()
    })
})
