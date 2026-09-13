import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ComposizioneBonifico } from '@/components/features/admin/pagamenti/ComposizioneBonifico'

/**
 * IL PANNELLO «COMPONI IL PAGAMENTO».
 *
 * ─── I TESTI SI LEGGONO DAL CATALOGO, MAI DA QUI ─────────────────────────────
 * Ogni asserzione sul testo passa da `CAT`/`SHARED`, cioè dai file che il mock di
 * next-intl (`test/setup.ts`) usa per risolvere `t()`. Se il componente scrivesse
 * una frase a mano, qui non la troverebbe nessuno — ed è esattamente il difetto
 * che il lock `pannello-componi-testi-completi` chiude sul catalogo e che questo
 * file chiude sul componente: il lock garantisce che il testo ESISTA, questo che
 * sia QUELLO a finire a schermo.
 *
 * ⚠️ `waitFor` su un'ASSENZA passa prima che i dati arrivino: ogni prova aspetta
 * PRIMA un elemento che esiste solo a contesto caricato (il titolo di una voce, un
 * pulsante), e solo dopo asserisce ciò che non c'è.
 */
const CAT = JSON.parse(
    readFileSync(join(process.cwd(), 'messages/it/adminContabilita.json'), 'utf8'),
) as Record<string, string>
const SHARED = JSON.parse(
    readFileSync(join(process.cwd(), 'messages/it/shared.json'), 'utf8'),
) as Record<string, string>

const MOVIMENTO_ID = '11111111-1111-4111-8111-111111111111'
const SEDE_1 = '22222222-2222-4222-8222-222222222222'
const SEDE_2 = '33333333-3333-4333-8333-333333333333'
const ALUNNO_1 = '44444444-4444-4444-8444-444444444444'
const ALUNNO_2 = '55555555-5555-4555-8555-555555555555'
const PARENT_1 = '66666666-6666-4666-8666-666666666666'
const PARENT_2 = '77777777-7777-4777-8777-777777777777'
const VOCE_1 = '88888888-8888-4888-8888-888888888888'
const VOCE_2 = '99999999-9999-4999-8999-999999999999'
const VOCE_3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const CAT_RETTA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CAT_GITA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

/** Una voce aperta nella forma esatta in cui la manda `…/contesto` (= `VoceApertaDb`). */
function voce(over: Partial<Record<string, unknown>> = {}) {
    return {
        id: VOCE_1,
        alunno_id: ALUNNO_1,
        scuola_id: SEDE_1,
        descrizione: 'Retta settembre',
        importo: 200,
        importo_pagato: 0,
        sconto: 0,
        scadenza: '2026-09-01',
        stato: 'da_pagare',
        tipo: 'singolo',
        categoria_id: CAT_RETTA,
        periodo_competenza: null,
        residuo: 200,
        payment_categories: { slug: 'retta' },
        ...over,
    }
}

function figlio(over: Partial<Record<string, unknown>> = {}) {
    return {
        alunno_id: ALUNNO_1,
        nome: 'Luca Rossi',
        scuola_id: SEDE_1,
        in_sede: true,
        attivo: true,
        saldo_ticket: 0,
        voci_aperte: [voce()],
        ...over,
    }
}

function contesto(over: Partial<Record<string, unknown>> = {}, importo = 300) {
    return {
        success: true,
        data: {
            movimento: {
                id: MOVIMENTO_ID,
                importo,
                data_operazione: '2026-09-10',
                causale: 'BONIFICO RETTA',
                controparte: 'MARIO ROSSI',
                stato: 'da_abbinare',
                scuola_id: null,
            },
            pagante: {
                proposto: { parent_id: PARENT_1, motivo: 'bonifico_esatto' },
                candidati: [
                    { parent_id: PARENT_1, nome: 'Mario Rossi', relazione: 'padre' },
                    { parent_id: PARENT_2, nome: 'Anna Bianchi', relazione: 'madre' },
                ],
            },
            figli: [figlio()],
            categorie: [
                { id: CAT_RETTA, nome: 'Retta', slug: 'retta', scuola_id: null },
                { id: CAT_GITA, nome: 'Gita', slug: 'gita', scuola_id: SEDE_1 },
            ],
            pacchetti_ticket: { [SEDE_1]: [{ label: '10 pasti', pezzi: 10, costo: 5 }] },
            sedi: { [SEDE_1]: 'Kidville Giugliano', [SEDE_2]: 'Kidville Aversa' },
            ...over,
        },
    }
}

function jsonRes(body: unknown, status = 200) {
    return { ok: status < 400, status, json: async () => body } as Response
}

interface Chiamate {
    contesto: string[]
    componi: Record<string, unknown>[]
}

/** Rete finta: GET del contesto + POST della composizione. */
function rete(opts: { ctx?: unknown; post?: unknown; postStatus?: number } = {}) {
    const chiamate: Chiamate = { contesto: [], componi: [] }
    const fn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const u = String(url)
        if (u.includes('/contesto')) {
            chiamate.contesto.push(u)
            return jsonRes(opts.ctx ?? contesto())
        }
        if (u.includes('/componi')) {
            chiamate.componi.push(JSON.parse(String(init?.body ?? '{}')))
            return jsonRes(
                opts.post ?? {
                    success: true,
                    data: { transazione_id: 'tx-1', incassi: 1, movimento_confermato: true },
                },
                opts.postStatus ?? 200,
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
            importoMovimento={300}
            dataOperazione="2026-09-10"
            onFatto={onFatto}
            onChiudi={onChiudi}
            {...props}
        />,
    )
    return { onFatto, onChiudi }
}

/** La casella di spunta di una voce aperta, per descrizione. */
const spunta = (descrizione: string) => screen.getByRole('checkbox', { name: new RegExp(descrizione) })

const conferma = () => screen.getByRole('button', { name: CAT.reconComponiConferma })

beforeEach(() => {
    try {
        window.localStorage.clear()
    } catch {
        /* jsdom senza storage: nulla da pulire */
    }
})
afterEach(() => vi.unstubAllGlobals())

describe('ComposizioneBonifico — la quadratura e il gate', () => {
    it('mostra quanto manca, e lo aggiorna a ogni cifra digitata', async () => {
        const { fn } = rete()
        vi.stubGlobal('fetch', fn)
        monta()

        // Il contesto è arrivato: da qui in poi le assenze sono vere assenze.
        await screen.findByRole('checkbox', { name: /Retta settembre/ })
        // Nessuna riga ancora: manca l'intero bonifico.
        expect(screen.getByRole('status')).toHaveTextContent('Manca ancora')
        expect(screen.getByRole('status')).toHaveTextContent('300,00')

        fireEvent.click(spunta('Retta settembre'))
        // La voce propone il proprio residuo: 200 su 300 → ne mancano 100.
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('100,00'))
        expect(screen.getByRole('status')).toHaveTextContent('Manca ancora')

        // Portata a 400 sfora: la frase cambia verso.
        fireEvent.change(screen.getAllByLabelText(CAT.reconComponiCampoImporto)[0], {
            target: { value: '400' },
        })
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Supera il bonifico'))
    })

    it('«Conferma» è spento finché non quadra, e la seconda voce si riempie per la CAPIENZA', async () => {
        // Due voci: 200 e 150, contro un bonifico da 300. La seconda ha 150 di residuo
        // ma del bonifico ne restano 100: è il caso in cui proporre il residuo secco
        // scriverebbe un numero che il gate rifiuta, e che l'operatrice dovrebbe
        // correggere a mano ogni volta.
        const { fn } = rete({
            ctx: contesto({
                figli: [
                    figlio({
                        voci_aperte: [
                            voce(),
                            voce({
                                id: VOCE_2,
                                descrizione: 'Pomeridiano',
                                importo: 150,
                                residuo: 150,
                                categoria_id: CAT_GITA,
                                payment_categories: { slug: 'pomeridiano' },
                            }),
                        ],
                    }),
                ],
            }),
        })
        vi.stubGlobal('fetch', fn)
        monta()

        await screen.findByRole('checkbox', { name: /Retta settembre/ })
        expect(conferma()).toBeDisabled()

        fireEvent.click(spunta('Retta settembre'))
        await waitFor(() =>
            expect(screen.getAllByLabelText(CAT.reconComponiCampoImporto)[0]).toHaveValue(200),
        )
        // 200 su 300: ancora spento, ne mancano 100.
        expect(conferma()).toBeDisabled()
        expect(screen.getByRole('status')).toHaveTextContent('Manca ancora')

        fireEvent.click(spunta('Pomeridiano'))
        // 100, cioè quel che RESTA del bonifico — non i 150 di residuo della voce.
        await waitFor(() =>
            expect(screen.getAllByLabelText(CAT.reconComponiCampoImporto)[1]).toHaveValue(100),
        )
        await waitFor(() => expect(conferma()).toBeEnabled())
        expect(screen.getByRole('status')).toHaveTextContent(CAT.reconComponiQuadraturaOk)
    })

    it('quando è spento dice PERCHÉ, col testo del catalogo, e il pulsante ci rimanda', async () => {
        const { fn } = rete()
        vi.stubGlobal('fetch', fn)
        monta()

        await screen.findByRole('button', { name: CAT.reconComponiAggiungiVoce })
        fireEvent.click(screen.getByRole('button', { name: CAT.reconComponiAggiungiVoce }))

        // Riga nuova appena creata: senza bambino, senza categoria, senza descrizione.
        const motivi = await screen.findByTestId('componi-motivi')
        expect(motivi).toHaveTextContent(CAT.reconComponiErrAlunnoMancante)
        expect(motivi).toHaveTextContent(CAT.reconComponiErrCategoriaMancante)
        expect(motivi).toHaveTextContent(CAT.reconComponiErrDescrizioneVuota)
        // Il pulsante spento PUNTA ai motivi: senza, un lettore di schermo legge
        // «non disponibile» e nient'altro.
        expect(conferma()).toBeDisabled()
        expect(conferma().getAttribute('aria-describedby')).toContain(motivi.id)
    })

    it('una riga senza bambino non si può confermare, nemmeno quando quadra al centesimo', async () => {
        const { fn, chiamate } = rete()
        vi.stubGlobal('fetch', fn)
        monta()

        await screen.findByRole('button', { name: CAT.reconComponiAggiungiVoce })
        fireEvent.click(screen.getByRole('button', { name: CAT.reconComponiAggiungiVoce }))
        const riga = await screen.findByTestId('riga-nuova-0')
        fireEvent.change(within(riga).getByLabelText(CAT.reconComponiCampoDescrizione), {
            target: { value: 'Gita al museo' },
        })
        fireEvent.change(within(riga).getByLabelText(CAT.reconComponiCampoCategoria), {
            target: { value: CAT_GITA },
        })
        fireEvent.change(within(riga).getByLabelText(CAT.reconComponiCampoImporto), {
            target: { value: '300' },
        })

        // Quadra (300 = 300) e resta spento: il bambino manca.
        await waitFor(() =>
            expect(screen.getByTestId('componi-motivi')).toHaveTextContent(
                CAT.reconComponiErrAlunnoMancante,
            ),
        )
        expect(conferma()).toBeDisabled()
        expect(chiamate.componi).toHaveLength(0)
    })

    it('il vuoto contro un bonifico a zero non si conferma, e lo dice con TUTT’E DUE i motivi', async () => {
        // ⚠️ I DUE CODICI DI QUESTA PROVA VENGONO DA `violazioniComposizione`, cioè dal
        // pezzo del gate che il «gate naturale» — `violazioniRighe(r).length === 0 &&
        // quadra(r, x)` — dimentica, e che su zero righe contro un movimento a 0 direbbe
        // SÌ (0 === 0). Qui si misura che il pannello lo interroghi davvero.
        //
        // ⚠️ ONESTÀ SUL LIMITE — e la frase che stava qui è stata SMENTITA DALLA MISURA,
        // il 2026-09-13. Diceva: «il PULSANTE resta spento lo stesso, perché senza righe
        // non c'è nessuna sede coinvolta», e ne concludeva che i due gate «non divergono
        // in nessuno scenario raggiungibile di QUESTO componente». Era falso: `sedeScelta`
        // era appiccicoso — nessun gesto lo azzerava, solo il ricaricamento del contesto —
        // quindi una sede scelta quando le righe c'erano sopravviveva alle righe. Scenario
        // costruito ed ESEGUITO: movimento a 0, due figli in due plessi, due righe nuove,
        // scelta la sede, tolte tutt'e due le righe → col gate ricomposto a mano
        // «Received element is not disabled», cioè il pulsante ACCESO su una composizione
        // vuota; con `puoConfermare` spento.
        //
        // Da oggi la sede del documento non sopravvive più alle righe (guardia su
        // `sediSceglibili`, prova «una sede che non è più fra le opzioni non parte nel
        // payload»), e quello scenario è chiuso: rimisurato, col gate ricomposto l'unico
        // rosso torna a essere il lock sul sorgente. Ma è chiuso per COSTRUZIONE e con un
        // test che lo tiene fermo, non per una coincidenza fra due reti — che è quello
        // che questo commento dichiarava senza averlo mai provato.
        const { fn } = rete({ ctx: contesto({ figli: [figlio({ voci_aperte: [] })] }, 0) })
        vi.stubGlobal('fetch', fn)
        monta({ importoMovimento: 0 })

        const motivi = await screen.findByTestId('componi-motivi')
        expect(motivi).toHaveTextContent(CAT.reconComponiErrComposizioneVuota)
        expect(motivi).toHaveTextContent(CAT.reconComponiErrMovimentoNonPositivo)
        expect(conferma()).toBeDisabled()
    })

    it('due righe sulla STESSA voce che insieme sforano il residuo non passano il gate', async () => {
        // La stessa voce sotto due fratelli: è come nasce un elenco con id ripetuti
        // (lo dice `proponiAllocazioneSuVoci`), e riga per riga le due sono ineccepibili.
        const { fn } = rete({
            ctx: contesto(
                {
                    figli: [
                        figlio(),
                        figlio({
                            alunno_id: ALUNNO_2,
                            nome: 'Sara Rossi',
                            voci_aperte: [voce({ alunno_id: ALUNNO_2 })],
                        }),
                    ],
                },
                400,
            ),
        })
        vi.stubGlobal('fetch', fn)
        monta({ importoMovimento: 400 })

        const caselle = await screen.findAllByRole('checkbox', { name: /Retta settembre/ })
        expect(caselle).toHaveLength(2)
        fireEvent.click(caselle[0])
        fireEvent.click(caselle[1])

        // 200 + 200 = 400 = l'importo del bonifico: quadra, ma il residuo della voce
        // è 200 e le due righe insieme ne chiedono 400.
        await waitFor(() =>
            expect(screen.getByTestId('componi-motivi')).toHaveTextContent(
                CAT.reconComponiErrOltreResiduoAggregato,
            ),
        )
        expect(screen.getByRole('status')).toHaveTextContent(CAT.reconComponiQuadraturaOk)
        expect(conferma()).toBeDisabled()
    })
})

describe('ComposizioneBonifico — la ricarica di ticket mensa', () => {
    it('il totale è calcolato da quantità × costo unitario e NON si digita', async () => {
        const { fn } = rete()
        vi.stubGlobal('fetch', fn)
        monta()

        await screen.findByRole('button', { name: CAT.reconComponiAggiungiTicket })
        fireEvent.click(screen.getByRole('button', { name: CAT.reconComponiAggiungiTicket }))
        const riga = await screen.findByTestId('riga-ticket-0')

        // Nessun bambino preselezionato (decisione 9), quindi nessuna sede: il costo
        // resta vuoto finché non si sa di CHI è la ricarica.
        expect(within(riga).getByLabelText(CAT.reconComponiCampoCostoUnitario)).toHaveValue(null)
        fireEvent.change(within(riga).getByLabelText(CAT.reconComponiCampoBambino), {
            target: { value: ALUNNO_1 },
        })
        // Scelto il bambino, il costo unitario arriva dal pacchetto della sua SEDE
        // (decisione 7), e resta modificabile.
        await waitFor(() =>
            expect(within(riga).getByLabelText(CAT.reconComponiCampoCostoUnitario)).toHaveValue(5),
        )

        fireEvent.change(within(riga).getByLabelText(CAT.reconComponiCampoQuantita), {
            target: { value: '20' },
        })
        const totale = await within(riga).findByTestId('ticket-totale-0')
        expect(totale).toHaveTextContent('100,00')
        // NON è un campo: un totale digitabile è un terzo numero che può smentire
        // gli altri due, e il saldo mensa del bambino seguirebbe quello sbagliato.
        expect(totale.querySelector('input')).toBeNull()
        expect(totale.tagName).not.toBe('INPUT')

        fireEvent.change(within(riga).getByLabelText(CAT.reconComponiCampoCostoUnitario), {
            target: { value: '2.5' },
        })
        await waitFor(() => expect(screen.getByTestId('ticket-totale-0')).toHaveTextContent('50,00'))
    })

    it('senza pacchetti configurati non inventa un prezzo: campo vuoto e spiegazione', async () => {
        // Misurato in produzione: dei tre plessi solo Giugliano ha un pacchetto.
        const { fn } = rete({ ctx: contesto({ pacchetti_ticket: { [SEDE_1]: [] } }) })
        vi.stubGlobal('fetch', fn)
        monta()

        await screen.findByRole('button', { name: CAT.reconComponiAggiungiTicket })
        fireEvent.click(screen.getByRole('button', { name: CAT.reconComponiAggiungiTicket }))
        const riga = await screen.findByTestId('riga-ticket-0')
        fireEvent.change(within(riga).getByLabelText(CAT.reconComponiCampoBambino), {
            target: { value: ALUNNO_1 },
        })

        // La sede ora si sa, e per quella sede pacchetti non ce ne sono: il costo
        // resta da scrivere a mano, e il pannello DICE perché — mai un prezzo inventato.
        await waitFor(() => expect(riga).toHaveTextContent(CAT.reconComponiPacchettiAssenti))
        expect(within(riga).getByLabelText(CAT.reconComponiCampoCostoUnitario)).toHaveValue(null)
        // Nessun selettore di pacchetto dove pacchetti non ce ne sono.
        expect(within(riga).queryByLabelText(CAT.reconComponiCampoPacchetto)).toBeNull()
    })
})

describe('ComposizioneBonifico — la famiglia, le sedi, il pagante', () => {
    it('l’elenco vuoto lo dice, e nomina l’azione che lo risolve', async () => {
        const { fn } = rete({ ctx: contesto({ figli: [figlio({ voci_aperte: [] })] }) })
        vi.stubGlobal('fetch', fn)
        monta()

        expect(await screen.findByText(CAT.reconComponiVociAperteVuoto)).toBeInTheDocument()
        // Prima si aspetta il testo (che esiste solo a contesto caricato), poi si
        // asserisce l'assenza: al contrario passerebbe sul pannello ancora vuoto.
        expect(screen.queryByRole('checkbox')).toBeNull()
        expect(screen.getByRole('button', { name: CAT.reconComponiAggiungiVoce })).toBeInTheDocument()
    })

    it('un figlio di un altro plesso resta in elenco, senza nome e col nome della SEDE', async () => {
        const { fn } = rete({
            ctx: contesto({
                figli: [
                    figlio(),
                    figlio({
                        alunno_id: ALUNNO_2,
                        nome: null,
                        scuola_id: SEDE_2,
                        in_sede: false,
                        voci_aperte: [
                            voce({
                                id: VOCE_2,
                                alunno_id: ALUNNO_2,
                                scuola_id: SEDE_2,
                                descrizione: 'Retta Aversa',
                                importo: 100,
                                residuo: 100,
                            }),
                        ],
                    }),
                ],
            }),
        })
        vi.stubGlobal('fetch', fn)
        monta()

        await screen.findByRole('checkbox', { name: /Retta Aversa/ })
        // C'è, e lo si riconosce dal plesso: senza di lui il bonifico non quadra.
        expect(screen.getByText('Kidville Aversa', { exact: false })).toBeInTheDocument()
        // Nessun nome inventato al posto di quello che il server non manda.
        expect(screen.queryByText(/null|undefined/)).toBeNull()
    })

    it('il pagante proposto si spiega col motivo, e resta modificabile', async () => {
        const { fn, chiamate } = rete()
        vi.stubGlobal('fetch', fn)
        monta()

        const select = await screen.findByLabelText(CAT.reconComponiIntestatario)
        expect(select).toHaveValue(PARENT_1)
        // Il motivo riusa la frase già scritta per la proposta d'intestatario.
        expect(screen.getByTestId('componi-motivo-pagante')).toHaveTextContent('il nome corrisponde')

        fireEvent.change(select, { target: { value: PARENT_2 } })
        // Cambiare pagante RILEGGE il contesto: i figli sono quelli di quel genitore.
        await waitFor(() => expect(chiamate.contesto.length).toBeGreaterThan(1))
        expect(chiamate.contesto[chiamate.contesto.length - 1]).toContain(`pagante=${PARENT_2}`)
    })

    it('il pagante scelto a mano ha la sua frase, non quella di un riconoscimento', async () => {
        const { fn } = rete({
            ctx: contesto({
                pagante: {
                    proposto: { parent_id: PARENT_2, motivo: 'scelto' },
                    candidati: [{ parent_id: PARENT_2, nome: 'Anna Bianchi', relazione: 'madre' }],
                },
            }),
        })
        vi.stubGlobal('fetch', fn)
        monta()

        const motivo = await screen.findByTestId('componi-motivo-pagante')
        expect(motivo).toHaveTextContent(CAT.reconComponiPaganteScelto)
    })
})

describe('ComposizioneBonifico — la conferma', () => {
    it('manda le tre specie di riga e ancora la fattura alla RETTA, non alla riga più grande', async () => {
        // ⚠️ LA RETTA È LA PIÙ PICCOLA, ED È DELIBERATO: con la retta anche maggiore
        // il test non distinguerebbe «vince la retta» da «vince la più grande», e
        // sarebbe verde con e senza la decisione n. 16. Qui la gita vale il doppio e
        // sta PRIMA nell'elenco: se l'àncora seguisse l'importo o l'ordine, punterebbe
        // là. È la riga da cui esce l'intestatario di un documento fiscale.
        const { fn, chiamate } = rete({
            ctx: contesto(
                {
                    figli: [
                        figlio({
                            voci_aperte: [
                                voce({
                                    id: VOCE_2,
                                    descrizione: 'Gita al museo',
                                    importo: 200,
                                    residuo: 200,
                                    categoria_id: CAT_GITA,
                                    payment_categories: { slug: 'gita' },
                                }),
                                voce({ importo: 100, residuo: 100 }),
                            ],
                        }),
                    ],
                },
                350,
            ),
        })
        vi.stubGlobal('fetch', fn)
        const { onFatto } = monta({ importoMovimento: 350 })

        await screen.findByRole('checkbox', { name: /Gita al museo/ })
        fireEvent.click(spunta('Gita al museo')) // indice 0, 200, categoria `gita`
        fireEvent.click(spunta('Retta settembre')) // indice 1, 100, categoria `retta`

        fireEvent.click(screen.getByRole('button', { name: CAT.reconComponiAggiungiTicket }))
        const ticket = await screen.findByTestId('riga-ticket-0')
        fireEvent.change(within(ticket).getByLabelText(CAT.reconComponiCampoBambino), {
            target: { value: ALUNNO_1 },
        })
        fireEvent.change(within(ticket).getByLabelText(CAT.reconComponiCampoQuantita), {
            target: { value: '10' },
        }) // 10 × 5 = 50 → 200 + 100 + 50 = 350

        await waitFor(() => expect(conferma()).toBeEnabled())
        fireEvent.click(conferma())

        await waitFor(() => expect(chiamate.componi).toHaveLength(1))
        const body = chiamate.componi[0] as Record<string, unknown>
        expect(body.voci).toEqual([
            { pagamento_id: VOCE_2, importo: 200 },
            { pagamento_id: VOCE_1, importo: 100 },
        ])
        expect(body.voci_ticket).toEqual([
            { alunno_id: ALUNNO_1, quantita: 10, costo_unitario: 5 },
        ])
        expect(body.voci_nuove).toEqual([])
        expect(body.pagante_parent_id).toBe(PARENT_1)
        expect(body.scuola_id).toBe(SEDE_1)
        // Decisione 16: la RETTA, che qui è la SECONDA riga e la più piccola.
        expect(body.ancora).toEqual({ specie: 'esistente', indice: 1 })

        await waitFor(() => expect(onFatto).toHaveBeenCalled())
        expect(onFatto.mock.calls[0][0]).toEqual({
            voci: 2,
            // I PASTI, non le righe: 10 × 5 €. Vedi la prova dedicata qui sotto.
            ticket: 10,
            totale: 350,
            movimentoConfermato: true,
        })
        // ⚠️ NESSUNA CELEBRAZIONE QUI, ED È DELIBERATO: sul riuscito il popup che monta
        // questo pannello lo SMONTA, e il riepilogo compare nell'elenco. Una seconda
        // formulazione della stessa notizia, per giunta invisibile, può solo divergere
        // da quella vera. Il `role="alert"` resta la resa del caso NON legato.
        expect(screen.queryByRole('alert')).toBeNull()
        expect(screen.queryByRole('button', { name: CAT.reconComponiConferma })).toBeNull()
    })

    it('il riepilogo conta i PASTI, non le righe: una riga sola da 20 ticket vale 20', async () => {
        // ⚠️ UNA RIGA SOLA, E DA VENTI: è il caso che distingue le due formule. Con una
        // riga da UN pasto `voci_ticket.length` e la somma delle quantità danno lo
        // stesso 1, e il difetto resta invisibile — è esattamente il motivo per cui
        // nessuno se n'era accorto. `EsitoComposizione.ticket` è «la QUANTITÀ, non il
        // numero di righe», e un «1 ticket» sopra a venti pasti accreditati è falso
        // nel modo peggiore: sembra plausibile.
        const { fn, chiamate } = rete({
            ctx: contesto({ figli: [figlio({ voci_aperte: [] })] }, 100),
        })
        vi.stubGlobal('fetch', fn)
        const { onFatto } = monta({ importoMovimento: 100 })

        await screen.findByRole('button', { name: CAT.reconComponiAggiungiTicket })
        fireEvent.click(screen.getByRole('button', { name: CAT.reconComponiAggiungiTicket }))
        const riga = await screen.findByTestId('riga-ticket-0')
        fireEvent.change(within(riga).getByLabelText(CAT.reconComponiCampoBambino), {
            target: { value: ALUNNO_1 },
        })
        fireEvent.change(within(riga).getByLabelText(CAT.reconComponiCampoQuantita), {
            target: { value: '20' },
        }) // 20 × 5 = 100

        await waitFor(() => expect(conferma()).toBeEnabled())
        fireEvent.click(conferma())
        await waitFor(() => expect(chiamate.componi).toHaveLength(1))

        expect(chiamate.componi[0].voci_ticket).toEqual([
            { alunno_id: ALUNNO_1, quantita: 20, costo_unitario: 5 },
        ])
        await waitFor(() => expect(onFatto).toHaveBeenCalled())
        expect(onFatto.mock.calls[0][0]).toMatchObject({ voci: 0, ticket: 20, totale: 100 })
    })

    it('la scadenza di una voce NUOVA è la data del bonifico (decisione 5)', async () => {
        const { fn, chiamate } = rete()
        vi.stubGlobal('fetch', fn)
        monta()

        await screen.findByRole('button', { name: CAT.reconComponiAggiungiVoce })
        fireEvent.click(screen.getByRole('button', { name: CAT.reconComponiAggiungiVoce }))
        const riga = await screen.findByTestId('riga-nuova-0')
        fireEvent.change(within(riga).getByLabelText(CAT.reconComponiCampoBambino), {
            target: { value: ALUNNO_1 },
        })
        fireEvent.change(within(riga).getByLabelText(CAT.reconComponiCampoCategoria), {
            target: { value: CAT_GITA },
        })
        fireEvent.change(within(riga).getByLabelText(CAT.reconComponiCampoDescrizione), {
            target: { value: 'Gita al museo' },
        })
        fireEvent.change(within(riga).getByLabelText(CAT.reconComponiCampoImporto), {
            target: { value: '300' },
        })

        await waitFor(() => expect(conferma()).toBeEnabled())
        fireEvent.click(conferma())
        await waitFor(() => expect(chiamate.componi).toHaveLength(1))
        expect((chiamate.componi[0].voci_nuove as Record<string, unknown>[])[0]).toMatchObject({
            alunno_id: ALUNNO_1,
            categoria_id: CAT_GITA,
            descrizione: 'Gita al museo',
            importo: 300,
            scadenza: '2026-09-10',
        })
    })

    it('un 200 con `CONCILIAZIONE_MOVIMENTO_NON_LEGATO` lo DICE e scoraggia il ritentativo', async () => {
        const { fn, chiamate } = rete({
            ctx: contesto({}, 200),
            post: {
                success: true,
                codice: 'CONCILIAZIONE_MOVIMENTO_NON_LEGATO',
                data: { transazione_id: 'tx-1', incassi: 1, movimento_confermato: false },
            },
        })
        vi.stubGlobal('fetch', fn)
        const { onFatto } = monta({ importoMovimento: 200 })

        await screen.findByRole('checkbox', { name: /Retta settembre/ })
        fireEvent.click(spunta('Retta settembre'))
        await waitFor(() => expect(conferma()).toBeEnabled())
        fireEvent.click(conferma())

        // La frase è quella del catalogo, ed è un avviso: non un successo muto.
        const avviso = await screen.findByRole('alert')
        expect(avviso).toHaveTextContent(SHARED.erroreConciliazioneMovimentoNonLegato)

        // Il ritentativo è la cosa da NON fare: il pulsante non c'è più.
        expect(screen.queryByRole('button', { name: CAT.reconComponiConferma })).toBeNull()
        expect(chiamate.componi).toHaveLength(1)

        expect(onFatto).toHaveBeenCalledWith(
            expect.objectContaining({ movimentoConfermato: false }),
        )
    })

    it('un errore del server si legge dal CODICE, e la composizione resta com’era', async () => {
        const { fn, chiamate } = rete({
            ctx: contesto({}, 200),
            post: { error: 'La composizione non quadra', codice: 'CONCILIAZIONE_NON_QUADRA' },
            postStatus: 422,
        })
        vi.stubGlobal('fetch', fn)
        const { onFatto } = monta({ importoMovimento: 200 })

        await screen.findByRole('checkbox', { name: /Retta settembre/ })
        fireEvent.click(spunta('Retta settembre'))
        await waitFor(() => expect(conferma()).toBeEnabled())
        fireEvent.click(conferma())

        const avviso = await screen.findByRole('alert')
        expect(avviso).toHaveTextContent(SHARED.erroreConciliazioneNonQuadra)
        expect(onFatto).not.toHaveBeenCalled()
        // Si può correggere e riprovare: qui il ritentativo è legittimo.
        expect(conferma()).toBeEnabled()
        expect(chiamate.componi).toHaveLength(1)
    })

    it('«Chiudi» chiama `onChiudi` e non scrive niente', async () => {
        const { fn, chiamate } = rete()
        vi.stubGlobal('fetch', fn)
        const { onChiudi } = monta()

        const chiudi = await screen.findByRole('button', { name: CAT.reconComponiChiudi })
        fireEvent.click(chiudi)
        expect(onChiudi).toHaveBeenCalledTimes(1)
        expect(chiamate.componi).toHaveLength(0)
    })

    it('«Rimuovi voce» toglie la riga e rimette in gioco il suo importo', async () => {
        const { fn } = rete()
        vi.stubGlobal('fetch', fn)
        monta()

        await screen.findByRole('button', { name: CAT.reconComponiAggiungiVoce })
        fireEvent.click(screen.getByRole('button', { name: CAT.reconComponiAggiungiVoce }))
        const riga = await screen.findByTestId('riga-nuova-0')
        fireEvent.change(within(riga).getByLabelText(CAT.reconComponiCampoImporto), {
            target: { value: '300' },
        })
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('300,00'))

        fireEvent.click(
            within(riga).getByRole('button', { name: new RegExp(CAT.reconComponiRimuoviVoce) }),
        )
        await waitFor(() => expect(screen.queryByTestId('riga-nuova-0')).toBeNull())
        expect(screen.getByRole('status')).toHaveTextContent('Manca ancora')
    })
})

describe('ComposizioneBonifico — l’àncora è una POSIZIONE, e le posizioni si spostano', () => {
    /**
     * ⚠️ PERCHÉ QUESTA PROVA ESISTE. `ancoraScelta` non tiene l'identità della riga:
     * tiene `specie:indice`, cioè la sua POSIZIONE nell'elenco — ed è giusto che sia
     * così, perché è la forma che il payload manda (una voce che NASCE qui non ha
     * ancora un uuid: la RPC lo risolve dopo l'INSERT). Il prezzo è che ogni gesto
     * che riordina gli elenchi sposta il significato di quel numero senza toccarlo:
     * l'indice resta 1 e sotto l'1 c'è un'altra riga. Da `esistente:1` il server
     * ricava `body.voci[1].pagamento_id`, cioè `ancora_pagamento_id`, cioè
     * L'INTESTATARIO DEL DOCUMENTO FISCALE — e con lui la detrazione 730.
     *
     * Le due rette non sono un dettaglio del fixture: `proponiAncora` prende la
     * PRIMA voce `retta`, quindi scegliere la seconda è una scelta vera. Con una
     * retta sola la scelta coinciderebbe con la proposta e React, a valore invariato,
     * non propagherebbe nemmeno l'`onChange`: la prova sarebbe verde senza aver
     * misurato niente.
     */
    function treVoci(importoBonifico = 100) {
        return rete({
            ctx: contesto(
                {
                    figli: [
                        figlio({
                            voci_aperte: [
                                voce({ id: VOCE_1, descrizione: 'Retta settembre', importo: 50, residuo: 50 }),
                                voce({ id: VOCE_2, descrizione: 'Retta ottobre', importo: 50, residuo: 50 }),
                                voce({
                                    id: VOCE_3,
                                    descrizione: 'Gita al museo',
                                    importo: 50,
                                    residuo: 50,
                                    categoria_id: CAT_GITA,
                                    payment_categories: { slug: 'gita' },
                                }),
                            ],
                        }),
                    ],
                },
                importoBonifico,
            ),
        })
    }

    const tendinaAncora = () => screen.getByLabelText(CAT.reconComponiAncora) as HTMLSelectElement

    it('togliere una spunta NON sposta la fattura sulla riga scivolata al suo posto', async () => {
        const { fn, chiamate } = treVoci()
        vi.stubGlobal('fetch', fn)
        monta({ importoMovimento: 100 })

        await screen.findByRole('checkbox', { name: /Retta settembre/ })
        // Si spunta dal fondo: la capienza residua riempie le prime due, e alla terza
        // — capienza esaurita — resta il residuo secco (50), che sfora in modo visibile.
        fireEvent.click(spunta('Retta ottobre'))
        fireEvent.click(spunta('Gita al museo'))
        fireEvent.click(spunta('Retta settembre'))
        await waitFor(() => expect(screen.getAllByLabelText(CAT.reconComponiCampoImporto)).toHaveLength(3))

        // L'operatrice intesta la fattura alla retta di OTTOBRE, che è la seconda
        // (la proposta del motore punta alla prima: questa è una scelta, non un eco).
        expect(tendinaAncora()).toHaveValue('esistente:0')
        fireEvent.change(tendinaAncora(), { target: { value: 'esistente:1' } })
        await waitFor(() => expect(tendinaAncora().selectedOptions[0]).toHaveTextContent('Retta ottobre'))

        // Toglie la spunta alla retta di settembre: restano ottobre e la gita, 50 + 50.
        fireEvent.click(spunta('Retta settembre'))
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(CAT.reconComponiQuadraturaOk))

        // A schermo dev'esserci ancora la riga che l'operatrice ha scelto — non la gita
        // che le è scivolata sotto l'indice 1.
        expect(tendinaAncora().selectedOptions[0]).toHaveTextContent('Retta ottobre')

        await waitFor(() => expect(conferma()).toBeEnabled())
        fireEvent.click(conferma())
        await waitFor(() => expect(chiamate.componi).toHaveLength(1))

        const body = chiamate.componi[0]
        const voci = body.voci as { pagamento_id: string; importo: number }[]
        const ancora = body.ancora as { specie: string; indice: number }
        expect(voci.map((v) => v.pagamento_id)).toEqual([VOCE_2, VOCE_3])
        // L'indice che il server dereferenzia deve pescare LA RETTA, non la gita.
        expect(voci[ancora.indice].pagamento_id).toBe(VOCE_2)
    })

    it('e non lascia un indice fuori dall’elenco: il 400 su un campo che a schermo è vuoto', async () => {
        // Due voci da 50 contro un bonifico da 50: tolta la prima, l'elenco `voci` ha
        // UN elemento e un `indice: 1` non esiste più. Il server risponde 400
        // `CONCILIAZIONE_ANCORA_MANCANTE` — su una tendina che a schermo è vuota,
        // perché il valore in stato non è fra le opzioni rimaste.
        const { fn, chiamate } = rete({
            ctx: contesto(
                {
                    figli: [
                        figlio({
                            voci_aperte: [
                                voce({ id: VOCE_1, descrizione: 'Retta settembre', importo: 50, residuo: 50 }),
                                voce({
                                    id: VOCE_2,
                                    descrizione: 'Gita al museo',
                                    importo: 50,
                                    residuo: 50,
                                    categoria_id: CAT_GITA,
                                    payment_categories: { slug: 'gita' },
                                }),
                            ],
                        }),
                    ],
                },
                50,
            ),
        })
        vi.stubGlobal('fetch', fn)
        monta({ importoMovimento: 50 })

        await screen.findByRole('checkbox', { name: /Retta settembre/ })
        fireEvent.click(spunta('Retta settembre'))
        fireEvent.click(spunta('Gita al museo'))
        await waitFor(() => expect(screen.getAllByLabelText(CAT.reconComponiCampoImporto)).toHaveLength(2))

        fireEvent.change(tendinaAncora(), { target: { value: 'esistente:1' } })
        await waitFor(() => expect(tendinaAncora()).toHaveValue('esistente:1'))

        fireEvent.click(spunta('Retta settembre'))
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(CAT.reconComponiQuadraturaOk))
        // La tendina non resta muta: mostra la riga a cui la fattura si intesterà.
        expect(tendinaAncora()).toHaveValue('esistente:0')

        await waitFor(() => expect(conferma()).toBeEnabled())
        fireEvent.click(conferma())
        await waitFor(() => expect(chiamate.componi).toHaveLength(1))

        const body = chiamate.componi[0]
        const voci = body.voci as { pagamento_id: string }[]
        const ancora = body.ancora as { specie: string; indice: number }
        expect(voci).toHaveLength(1)
        // Dentro l'elenco: fuori è il 400 `CONCILIAZIONE_ANCORA_MANCANTE`.
        expect(ancora.indice).toBeLessThan(voci.length)
        expect(voci[ancora.indice].pagamento_id).toBe(VOCE_2)
    })
})

describe('ComposizioneBonifico — i CINQUE gesti che riordinano azzerano l’àncora', () => {
    /**
     * ⚠️ UN PRESIDIO SOLO PER TUTTI E CINQUE, e non per il gesto che si era rotto.
     * I punti che riordinano gli elenchi sono cinque — `commutaVoce` (nei due versi),
     * `aggiungiVoce`, `aggiungiTicket`, i due «Rimuovi voce» — e fino a questa
     * correzione QUATTRO azzeravano `ancoraScelta` e uno no. Nessuna prova se n'era
     * accorta: tolto `setAncoraScelta('')` dai due «Rimuovi voce», la suite restava
     * tutta verde. Una regola che vale in cinque posti e si misura in uno è una
     * regola che tornerà a rompersi nel quarto.
     *
     * Il fixture tiene la retta al primo posto e ce la lascia in ogni caso: così la
     * proposta del motore è sempre `esistente:0` e l'asserzione è una sola, uguale
     * per tutti — «dopo il gesto la tendina torna a dire la proposta», cioè la scelta
     * di prima non sopravvive all'elenco che l'aveva giustificata.
     */
    function conTreVoci() {
        return rete({
            ctx: contesto(
                {
                    figli: [
                        figlio({
                            voci_aperte: [
                                voce({ id: VOCE_1, descrizione: 'Retta settembre', importo: 100, residuo: 100 }),
                                voce({
                                    id: VOCE_2,
                                    descrizione: 'Gita al museo',
                                    importo: 100,
                                    residuo: 100,
                                    categoria_id: CAT_GITA,
                                    payment_categories: { slug: 'gita' },
                                }),
                                voce({
                                    id: VOCE_3,
                                    descrizione: 'Pomeridiano',
                                    importo: 100,
                                    residuo: 100,
                                    categoria_id: CAT_GITA,
                                    payment_categories: { slug: 'pomeridiano' },
                                }),
                            ],
                        }),
                    ],
                },
                200,
            ),
        })
    }

    const tendinaAncora = () => screen.getByLabelText(CAT.reconComponiAncora) as HTMLSelectElement
    const scegliSeconda = async () => {
        fireEvent.change(tendinaAncora(), { target: { value: 'esistente:1' } })
        await waitFor(() => expect(tendinaAncora()).toHaveValue('esistente:1'))
    }

    const GESTI: [string, () => Promise<void>][] = [
        [
            'spuntare un’altra voce',
            async () => {
                fireEvent.click(spunta('Pomeridiano'))
            },
        ],
        [
            'togliere una spunta',
            async () => {
                fireEvent.click(spunta('Gita al museo'))
            },
        ],
        [
            'aggiungere una voce nuova',
            async () => {
                fireEvent.click(screen.getByRole('button', { name: CAT.reconComponiAggiungiVoce }))
            },
        ],
        [
            'aggiungere una ricarica',
            async () => {
                fireEvent.click(screen.getByRole('button', { name: CAT.reconComponiAggiungiTicket }))
            },
        ],
        [
            'rimuovere una voce nuova',
            async () => {
                fireEvent.click(screen.getByRole('button', { name: CAT.reconComponiAggiungiVoce }))
                const riga = await screen.findByTestId('riga-nuova-0')
                // L'aggiunta ha già azzerato: si riscegli, o il gesto da misurare
                // sarebbe quello di prima.
                await scegliSeconda()
                fireEvent.click(
                    within(riga).getByRole('button', { name: new RegExp(CAT.reconComponiRimuoviVoce) }),
                )
            },
        ],
        [
            'rimuovere una ricarica',
            async () => {
                fireEvent.click(screen.getByRole('button', { name: CAT.reconComponiAggiungiTicket }))
                const riga = await screen.findByTestId('riga-ticket-0')
                await scegliSeconda()
                fireEvent.click(
                    within(riga).getByRole('button', { name: new RegExp(CAT.reconComponiRimuoviVoce) }),
                )
            },
        ],
    ]

    it.each(GESTI)('%s rimette l’àncora sulla proposta', async (_nome, gesto) => {
        const { fn } = conTreVoci()
        vi.stubGlobal('fetch', fn)
        monta({ importoMovimento: 200 })

        await screen.findByRole('checkbox', { name: /Retta settembre/ })
        fireEvent.click(spunta('Retta settembre'))
        fireEvent.click(spunta('Gita al museo'))
        await waitFor(() => expect(screen.getAllByLabelText(CAT.reconComponiCampoImporto)).toHaveLength(2))

        await scegliSeconda()
        await gesto()

        await waitFor(() => expect(tendinaAncora()).toHaveValue('esistente:0'))
        expect(tendinaAncora().selectedOptions[0]).toHaveTextContent('Retta settembre')
    })
})

describe('ComposizioneBonifico — la sede del DOCUMENTO non sopravvive alle righe', () => {
    /**
     * ⚠️ MISURATO PRIMA DI CORREGGERE, ED È IL MOTIVO PER CUI QUESTA PROVA ESISTE.
     * `sedeScelta` era appiccicoso: lo azzerava solo il ricaricamento del contesto,
     * mai la sparizione delle righe che l'avevano giustificato. Con due figli in due
     * plessi, scelta Aversa e poi tolta la riga di Aversa, il pannello mandava
     * `scuola_id` = **Aversa** su una composizione fatta di **sola Giugliano**, con il
     * campo «Sede del documento» **VUOTO a schermo** (il valore in stato non era più
     * fra le opzioni) e il pulsante **ACCESO**, senza un motivo elencato.
     *
     * Il server non poteva accorgersene: §3 della rotta `componi` verifica che la sede
     * dichiarata sia ACCESSIBILE a chi la dichiara — non che c'entri con le righe — ed
     * è deliberato (decisione 15: un bonifico cross-sede produce un documento solo, su
     * una sede che l'operatore SCEGLIE). Se l'operatrice ha in scope tutt'e due i
     * plessi, quel payload passa: `pagamenti_transazioni.scuola_id` e
     * `riconciliazione_movimenti.scuola_id` finiscono nel plesso sbagliato, in
     * silenzio, con lo schermo che dice un'altra cosa.
     */
    function dueSedi(importoBonifico = 200) {
        return rete({
            ctx: contesto(
                {
                    figli: [
                        figlio({
                            voci_aperte: [
                                voce({ id: VOCE_1, descrizione: 'Retta Giugliano', importo: 200, residuo: 200 }),
                            ],
                        }),
                        figlio({
                            alunno_id: ALUNNO_2,
                            nome: 'Sara Rossi',
                            scuola_id: SEDE_2,
                            voci_aperte: [
                                voce({
                                    id: VOCE_2,
                                    alunno_id: ALUNNO_2,
                                    scuola_id: SEDE_2,
                                    descrizione: 'Retta Aversa',
                                    importo: 100,
                                    residuo: 100,
                                }),
                            ],
                        }),
                    ],
                },
                importoBonifico,
            ),
        })
    }

    const tendinaSede = () => screen.getByLabelText(CAT.reconComponiSedeDocumento) as HTMLSelectElement

    it('una sede che non è più fra le opzioni non parte nel payload', async () => {
        const { fn, chiamate } = dueSedi()
        vi.stubGlobal('fetch', fn)
        monta({ importoMovimento: 200 })

        await screen.findByRole('checkbox', { name: /Retta Giugliano/ })
        fireEvent.click(spunta('Retta Giugliano'))
        fireEvent.click(spunta('Retta Aversa'))
        // Due plessi toccati: la sede non si indovina, si sceglie (400 lato server).
        await waitFor(() => expect(tendinaSede().options).toHaveLength(3))
        fireEvent.change(tendinaSede(), { target: { value: SEDE_2 } })
        await waitFor(() => expect(tendinaSede()).toHaveValue(SEDE_2))

        // Tolta la riga di Aversa resta la sola Giugliano, e quadra.
        fireEvent.click(spunta('Retta Aversa'))
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(CAT.reconComponiQuadraturaOk))

        // A schermo la scelta di prima non c'è più fra le opzioni: e allora non c'è
        // più nemmeno nello stato che parte. Il campo dice il plesso vero.
        expect([...tendinaSede().options].map((o) => o.value)).toEqual(['', SEDE_1])
        expect(tendinaSede()).toHaveValue(SEDE_1)

        await waitFor(() => expect(conferma()).toBeEnabled())
        fireEvent.click(conferma())
        await waitFor(() => expect(chiamate.componi).toHaveLength(1))
        expect(chiamate.componi[0].scuola_id).toBe(SEDE_1)
    })

    it('e finché è ancora fra le opzioni, la scelta dell’operatrice RESTA', async () => {
        // ⚠️ IL CONTRAPPESO, e non è un di più: una guardia che azzerasse a ogni
        // riordino cancellerebbe una scelta legittima — la sede di un bonifico
        // cross-sede si sceglie apposta, ed è il caso per cui questa schermata esiste.
        // Qui la scelta è «la meno ovvia» (Aversa, mentre Giugliano porta il doppio) e
        // deve sopravvivere a un gesto che riordina gli elenchi.
        const { fn, chiamate } = dueSedi(300)
        vi.stubGlobal('fetch', fn)
        monta({ importoMovimento: 300 })

        await screen.findByRole('checkbox', { name: /Retta Giugliano/ })
        fireEvent.click(spunta('Retta Giugliano'))
        fireEvent.click(spunta('Retta Aversa'))
        await waitFor(() => expect(tendinaSede().options).toHaveLength(3))
        fireEvent.change(tendinaSede(), { target: { value: SEDE_2 } })
        await waitFor(() => expect(tendinaSede()).toHaveValue(SEDE_2))

        // Un gesto che riordina (e che azzera l'ÀNCORA): la sede non c'entra e resta.
        fireEvent.click(screen.getByRole('button', { name: CAT.reconComponiAggiungiTicket }))
        await screen.findByTestId('riga-ticket-0')
        expect(tendinaSede()).toHaveValue(SEDE_2)

        fireEvent.click(
            within(screen.getByTestId('riga-ticket-0')).getByRole('button', {
                name: new RegExp(CAT.reconComponiRimuoviVoce),
            }),
        )
        await waitFor(() => expect(screen.queryByTestId('riga-ticket-0')).toBeNull())
        await waitFor(() => expect(conferma()).toBeEnabled())
        fireEvent.click(conferma())
        await waitFor(() => expect(chiamate.componi).toHaveLength(1))
        expect(chiamate.componi[0].scuola_id).toBe(SEDE_2)
    })
})

describe('ComposizioneBonifico — un bonifico a ZERO non si conferma, e nessuna rete è di scorta', () => {
    /**
     * ⚠️ CHE COSA TIENE DAVVERO FUORI UN MOVIMENTO A ZERO — e non è questo pannello.
     * È l'IMPORTATORE dell'estratto conto, tre strati più in là:
     * `src/lib/pagamenti/estratto-conto/tabella.ts:395` scarta ogni riga con
     * `importo <= 0` (le conta come «uscite»). Sul database non c'è nessun vincolo:
     * misurato il 2026-09-13 su `riconciliazione_movimenti` — **239 righe, 0 a zero,
     * 0 negative, 0 nulle, minimo 80,00**, e fra i vincoli della tabella ci sono
     * quattro FK, la PK e un CHECK su `stato`: **nessuno su `importo`**. Cioè lo zero
     * non arriva perché un `if` in TypeScript lo scarta, non perché non possa esistere.
     *
     * Perciò questa prova non misura un caso teorico: misura che se quello zero
     * arrivasse lo stesso — un import da un'altra strada, una riga scritta a mano, una
     * riapertura — il pannello non produrrebbe una transazione VUOTA su un movimento
     * da zero euro.
     *
     * ⚠️ E LE RETI SONO DUE, DICHIARATE UNA PER UNA PERCHÉ CIASCUNA HA IL SUO MORSO:
     *  (a) il GATE: `violazioniComposizione` emette `composizione_vuota` e
     *      `movimento_non_positivo`. È la rete PER PROGETTO, ed è l'unica che il gate
     *      ricomposto a mano — `violazioniRighe(r).length === 0 && quadra(r, 0)` —
     *      NON ha: su zero righe contro zero euro quello direbbe sì (0 === 0).
     *  (b) la SEDE DEL DOCUMENTO: senza righe non c'è nessuna sede toccata, quindi
     *      nessuna opzione, quindi nessuna sede. Fino alla guardia su `sedeScelta`
     *      questo era FALSO e si poteva misurare: una sede scelta prima sopravviveva
     *      alle righe che l'avevano giustificata, e con il gate ricomposto il pulsante
     *      SI ACCENDEVA su una composizione vuota. Oggi è vero per costruzione, e a
     *      tenerlo fermo è la prova «una sede che non è più fra le opzioni non parte
     *      nel payload» — non questo commento.
     *
     * ⚠️ CIÒ CHE QUESTA PROVA NON PUÒ FARE, detto invece di lasciarlo credere: non
     * distingue (a) da (b). Con tutt'e due in piedi il pulsante resta spento anche col
     * gate ricomposto, e nessuna prova funzionale di questo componente può separarli —
     * è esattamente il motivo per cui il presidio del gate è il lock sul SORGENTE, qui
     * sotto. Quel che si asserisce qui è ognuna delle due reti per conto suo, così
     * togliendone una si vede quale.
     */
    it('zero righe contro un movimento a 0: pulsante spento, e le due reti dicono ognuna la sua', async () => {
        const { fn, chiamate } = rete({
            ctx: contesto(
                {
                    figli: [
                        figlio({ voci_aperte: [] }),
                        figlio({
                            alunno_id: ALUNNO_2,
                            nome: 'Sara Rossi',
                            scuola_id: SEDE_2,
                            voci_aperte: [],
                        }),
                    ],
                },
                0,
            ),
        })
        vi.stubGlobal('fetch', fn)
        monta({ importoMovimento: 0 })

        // Due righe nuove, una per figlio: due plessi toccati, quindi la sede del
        // documento si SCEGLIE (con una sola sarebbe preselezionata e non proverebbe
        // niente sull'appiccicosità).
        await screen.findByRole('button', { name: CAT.reconComponiAggiungiVoce })
        fireEvent.click(screen.getByRole('button', { name: CAT.reconComponiAggiungiVoce }))
        fireEvent.click(screen.getByRole('button', { name: CAT.reconComponiAggiungiVoce }))
        const prima = await screen.findByTestId('riga-nuova-0')
        const seconda = await screen.findByTestId('riga-nuova-1')
        fireEvent.change(within(prima).getByLabelText(CAT.reconComponiCampoBambino), {
            target: { value: ALUNNO_1 },
        })
        fireEvent.change(within(seconda).getByLabelText(CAT.reconComponiCampoBambino), {
            target: { value: ALUNNO_2 },
        })

        const sede = screen.getByLabelText(CAT.reconComponiSedeDocumento) as HTMLSelectElement
        await waitFor(() => expect(sede.options).toHaveLength(3))
        fireEvent.change(sede, { target: { value: SEDE_2 } })
        await waitFor(() => expect(sede).toHaveValue(SEDE_2))

        // Via tutt'e due le righe: resta una composizione vuota su un bonifico da 0 €.
        fireEvent.click(
            within(screen.getByTestId('riga-nuova-1')).getByRole('button', {
                name: new RegExp(CAT.reconComponiRimuoviVoce),
            }),
        )
        fireEvent.click(
            within(screen.getByTestId('riga-nuova-0')).getByRole('button', {
                name: new RegExp(CAT.reconComponiRimuoviVoce),
            }),
        )
        await waitFor(() => expect(screen.queryByTestId('riga-nuova-0')).toBeNull())

        const motivi = screen.getByTestId('componi-motivi')
        // (a) la rete per progetto: i due codici che solo `violazioniComposizione` dà.
        expect(motivi).toHaveTextContent(CAT.reconComponiErrComposizioneVuota)
        expect(motivi).toHaveTextContent(CAT.reconComponiErrMovimentoNonPositivo)
        // (b) la sede: nessuna riga, nessuna opzione, nessuna sede — e lo DICE.
        expect([...sede.options].map((o) => o.value)).toEqual([''])
        expect(sede).toHaveValue('')
        expect(motivi).toHaveTextContent(CAT.reconComponiSedeDocumento)
        // il fatto d'insieme
        expect(conferma()).toBeDisabled()
        expect(chiamate.componi).toHaveLength(0)
    })
})

describe('ComposizioneBonifico — un bambino che non è più iscritto', () => {
    /**
     * ⚠️ DUE TENDINE, E VANNO MISURATE TUTT'E DUE. `disabled={!f.attivo}` e la frase
     * `reconComponiAlunnoNonAttivo` compaiono in DUE punti — la riga nuova e la riga
     * ticket — e fino a questa prova nessuno dei due era coperto: tolti entrambi, la
     * suite restava verde. Una prova su una sola delle due lascia scoperta l'altra,
     * che è esattamente come il buco è nato.
     *
     * Perché la regola esiste: la scrittura RIFIUTA le voci nuove e le ricariche
     * intestate a chi non è più iscritto, mentre le voci GIÀ a registro si incassano
     * (il bonifico di un saldo arretrato è il caso normale). Spegnere l'opzione qui
     * evita un 4xx che l'operatrice scoprirebbe solo premendo «Conferma», e la frase
     * dice quale delle due cose si può ancora fare.
     */
    function conRitirato() {
        return rete({
            ctx: contesto({
                figli: [
                    figlio(),
                    figlio({
                        alunno_id: ALUNNO_2,
                        nome: 'Sara Rossi',
                        attivo: false,
                        voci_aperte: [],
                    }),
                ],
            }),
        })
    }

    it.each([
        ['una voce nuova', CAT.reconComponiAggiungiVoce, 'riga-nuova-0'],
        ['una ricarica', CAT.reconComponiAggiungiTicket, 'riga-ticket-0'],
    ])('in %s la sua opzione è spenta e dice perché', async (_nome, pulsante, testid) => {
        const { fn } = conRitirato()
        vi.stubGlobal('fetch', fn)
        monta()

        await screen.findByRole('button', { name: pulsante })
        fireEvent.click(screen.getByRole('button', { name: pulsante }))
        const riga = await screen.findByTestId(testid)
        const tendina = within(riga).getByLabelText(CAT.reconComponiCampoBambino) as HTMLSelectElement

        // C'è, perché le voci già a registro si incassano lo stesso — ma non si sceglie.
        const opzioni = [...tendina.options]
        const ritirato = opzioni.find((o) => o.value === ALUNNO_2)
        const iscritto = opzioni.find((o) => o.value === ALUNNO_1)
        expect(ritirato).toBeDefined()
        expect(ritirato).toBeDisabled()
        expect(ritirato?.textContent).toContain(CAT.reconComponiAlunnoNonAttivo)
        // E chi è iscritto resta scegliibile, senza la frase: il contrario proverebbe
        // solo che la tendina è rotta per tutti.
        expect(iscritto).not.toBeDisabled()
        expect(iscritto?.textContent).not.toContain(CAT.reconComponiAlunnoNonAttivo)
    })
})

describe('ComposizioneBonifico — il gate resta UNO, e si vede dal sorgente', () => {
    /**
     * ⚠️ PERCHÉ UN LOCK SUL SORGENTE E NON UNA PROVA FUNZIONALE — e stavolta con la
     * misura accanto, perché la versione precedente di questo commento diceva una cosa
     * che non era stata provata ed era falsa.
     *
     * DICEVA: «il caso che li separa (zero righe contro un movimento a 0) è già
     * fermato dalla sede del documento, che senza righe non ha nessuna opzione», e
     * concludeva che il gate ricomposto «QUI non farebbe danno». MISURATO IL 2026-09-13:
     * lo faceva. La sede del documento non era derivata dalle righe fino in fondo —
     * `sedeScelta` era uno stato appiccicoso, che nessun gesto azzerava — e bastava
     * scegliere la sede mentre le righe c'erano, poi toglierle tutte: col gate
     * ricomposto il pulsante SI ACCENDEVA su una composizione vuota
     * («Received element is not disabled»).
     *
     * OGGI. La guardia su `sedeScelta` (vale finché è fra `sediSceglibili`) chiude
     * quello scenario, e rimisurando col gate ricomposto l'unico rosso è di nuovo
     * questo lock. Quindi la frase «i due non divergono in questo componente» adesso è
     * vera — ma non va letta come una rassicurazione: è vera per una CATENA, e ogni
     * anello ha il suo test.
     *   · zero righe ⇒ nessuna sede toccata ⇒ nessuna opzione ⇒ nessuna sede:
     *     «una sede che non è più fra le opzioni non parte nel payload»;
     *   · zero righe contro 0 € non si conferma: «zero righe contro un movimento a 0»;
     *   · due righe sulla stessa voce: le copre `violazioniRighe`, che chiama
     *     `vociOltreIlResiduoAggregato`.
     * Basta che domani la sede del documento arrivi da un'altra parte — dal movimento,
     * da una preferenza, da una prop — e l'anello salta con il pulsante ACCESO. Il
     * motore dichiara `puoConfermare` «l'unico modo corretto di decidere», e ciò che
     * nessuna prova funzionale di questo componente può misurare — perché le due reti
     * non si possono separare da fuori — lo misura questo confronto sul testo.
     */
    const SORGENTE = readFileSync(
        join(process.cwd(), 'src/components/features/admin/pagamenti/ComposizioneBonifico.tsx'),
        'utf8',
    )
    /** Via i commenti: qui dentro `puoConfermare` e `quadra` sono nominati apposta. */
    const CODICE = SORGENTE.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')

    it('decide con `puoConfermare`, e non ricompone il gate a mano', () => {
        expect(CODICE).toContain('puoConfermare(righe, importo)')
        // `quadra` non è nemmeno importata: il gate la contiene già, e chiamarla qui
        // sarebbe il primo pezzo del gate ricomposto.
        expect(CODICE).not.toMatch(/\bquadra\s*\(/)
    })

    it('e il controllo vede davvero un gate ricomposto (non è verde su tutto)', () => {
        const ricomposto =
            'const ok = violazioniRighe(righe).length === 0 && quadra(righe, importo)'
        expect(ricomposto).not.toContain('puoConfermare(righe, importo)')
        expect(ricomposto).toMatch(/\bquadra\s*\(/)
    })
})

describe('ComposizioneBonifico — il caricamento e i guasti', () => {
    it('un contesto illeggibile lo dice col testo del codice, e non offre la conferma', async () => {
        const fn = vi.fn(async () =>
            jsonRes(
                { error: 'Non leggibile', codice: 'CONCILIAZIONE_CONTESTO_NON_LETTO' },
                500,
            ),
        )
        vi.stubGlobal('fetch', fn)
        monta()

        const avviso = await screen.findByRole('alert')
        expect(avviso).toHaveTextContent(SHARED.erroreConciliazioneContestoNonLetto)
        expect(screen.queryByRole('button', { name: CAT.reconComponiConferma })).toBeNull()
        // La via d'uscita resta sempre.
        expect(screen.getByRole('button', { name: CAT.reconComponiChiudi })).toBeInTheDocument()
    })

    it('il titolo e le intestazioni vengono dal catalogo, non dal componente', async () => {
        const { fn } = rete()
        vi.stubGlobal('fetch', fn)
        monta()

        await screen.findByRole('checkbox', { name: /Retta settembre/ })
        // Una REGIONE con il suo nome, non un dialogo: il dialogo è il popup che ci
        // contiene, e annidarne un secondo sovrapporrebbe due veli e due `aria-modal`.
        const dialogo = screen.getByRole('region', { name: CAT.reconComponiTitolo })
        expect(screen.queryByRole('dialog')).toBeNull()
        expect(within(dialogo).getByText(CAT.reconComponiTitolo)).toBeInTheDocument()
        expect(within(dialogo).getByText(CAT.reconComponiVociAperte)).toBeInTheDocument()
        expect(
            within(dialogo).getByRole('button', { name: CAT.reconComponiAggiungiTicket }),
        ).toBeInTheDocument()
        expect(within(dialogo).getByLabelText(CAT.reconComponiSedeDocumento)).toBeInTheDocument()
        expect(within(dialogo).getByLabelText(CAT.reconComponiAncora)).toBeInTheDocument()
    })
})
