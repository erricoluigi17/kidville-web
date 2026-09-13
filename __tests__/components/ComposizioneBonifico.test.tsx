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
        // ⚠️ ONESTÀ SUL LIMITE, misurata sostituendo il gate con quello naturale: il
        // PULSANTE resta spento lo stesso, perché senza righe non c'è nessuna sede
        // coinvolta e la sede del documento fa da seconda rete. Cioè `puoConfermare` e il
        // gate naturale non divergono in nessuno scenario raggiungibile di QUESTO
        // componente — la divergenza la si vede sui MOTIVI, che è ciò che questa prova
        // asserisce, e il lock sul sorgente presidia la chiamata.
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

describe('ComposizioneBonifico — il gate resta UNO, e si vede dal sorgente', () => {
    /**
     * ⚠️ PERCHÉ UN LOCK SUL SORGENTE E NON UNA PROVA FUNZIONALE. Misurato sostituendo
     * `puoConfermare` col gate ricomposto a mano: la suite resta VERDE, e non perché
     * le prove siano deboli — perché nel pannello i due non divergono. Il caso che li
     * separa (zero righe contro un movimento a 0) è già fermato dalla sede del
     * documento, che senza righe non ha nessuna opzione; e il caso delle due righe
     * sulla stessa voce lo copre `violazioniRighe`, che di suo chiama
     * `vociOltreIlResiduoAggregato`.
     *
     * Cioè: oggi il gate naturale QUI non farebbe danno. È vero e va detto — ma è vero
     * per una coincidenza fra due reti indipendenti, non per progetto: basta che
     * domani la sede del documento venga preselezionata in un altro modo e il caso
     * «zero righe, movimento a 0» torna raggiungibile con il pulsante ACCESO. Il
     * motore lo dichiara per iscritto («l'unico modo corretto di decidere»), e ciò che
     * nessuna prova funzionale può misurare lo misura questo confronto sul testo.
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
