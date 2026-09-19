import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { axe, toHaveNoViolations } from 'jest-axe'
import { IntlMessageFormat } from 'intl-messageformat'

import { AdesioneNumeroModal } from '@/components/features/avvisi/AdesioneNumeroModal'
import type { Avviso } from '@/components/features/avvisi/AvvisoCard'
import itAvvisi from '../../messages/it/avvisi.json'
import itShared from '../../messages/it/shared.json'

expect.extend(toHaveNoViolations)

// =============================================================================
// C3 — «QUANTE PERSONE?»: UNA SOLA SCRITTURA, E L'ESITO SI LEGGE A SCHERMO.
//
// ── LA PROPRIETÀ CHE CONTA ──────────────────────────────────────────────────
//
// 🔴 «Aderisco» da solo NON scrive. Senza il numero l'adesione non vale, e
// registrarla comunque significherebbe farla contare come UNA persona per
// convenzione contro il tetto dei posti — il modo di riempire un pullman da 50
// con 50 famiglie. La riga nasce alla CONFERMA, una `POST` per figlio e basta.
//
// Il test è scritto sul conteggio delle chiamate a `fetch`, non su uno stato
// interno: «ha scritto due volte» e «ha scritto una volta» hanno lo stesso
// aspetto a schermo, ed è esattamente la classe di difetto (il doppio invio
// della chat, l'incasso doppio del saldo ticket) che questo repo ha già pagato.
//
// ── E L'ESITO NON STA DIETRO UNA MODALE CHE SI CHIUDE ───────────────────────
//
// Se anche un solo figlio finisce in coda la modale RESTA APERTA e lo dice. Su
// un telefono un messaggio che compare mentre il dialogo si chiude non lo legge
// nessuno — ed è la sola informazione che quella famiglia stava aspettando.
//
// 🔴 In nessuno dei suoi stati questa modale mostra un numero di posti liberi
// (decisione n. 17): l'ultimo blocco è l'asserzione negativa che lo misura.
// =============================================================================

afterEach(cleanup)

const T = (chiave: keyof typeof itAvvisi, valori?: Record<string, unknown>): string =>
    valori === undefined
        ? itAvvisi[chiave]
        : String(new IntlMessageFormat(itAvvisi[chiave], 'it').format(valori))

const PARENT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const DOMANDA = 'TEST quante persone verranno?'

/** Dati inventati: nessun nome reale di bambini nei test. */
const MARCO = { student_id: 's-1', nome: 'TEST Marco' }
const GIULIA = { student_id: 's-2', nome: 'TEST Giulia' }

const AVVISO: Avviso = {
    id: 'avv-1',
    author_id: 'aut-1',
    titolo: 'TEST Gita al museo',
    contenuto: 'TEST corpo',
    tipo: 'adesione',
    target_scope: 'globale',
    target_classes: null,
    scadenza: null,
    scadenza_avviso: '2026-10-01T09:00:00.000Z',
    scadenza_adesione: '2026-09-25T09:00:00.000Z',
    chiedi_numero: true,
    etichetta_numero: DOMANDA,
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

/** Risposte del server, una per chiamata, nell'ordine in cui arrivano. */
let risposte: Array<{ ok: boolean; corpo: unknown; status?: number }> = []
let chiamate: Array<{ url: string; corpo: Record<string, unknown> }> = []
const fetchOriginale = globalThis.fetch

beforeEach(() => {
    risposte = []
    chiamate = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        chiamate.push({
            url: String(input),
            corpo: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
        })
        const r = risposte.shift() ?? { ok: true, corpo: { stato: 'ammessa' } }
        return {
            ok: r.ok,
            status: r.status ?? (r.ok ? 200 : 409),
            json: async () => r.corpo,
        } as unknown as Response
    }) as unknown as typeof globalThis.fetch
})

afterEach(() => {
    globalThis.fetch = fetchOriginale
})

function monta(p: Partial<React.ComponentProps<typeof AdesioneNumeroModal>> = {}) {
    const onChiudi = p.onChiudi ?? vi.fn()
    const esito = render(
        <AdesioneNumeroModal
            open
            avviso={AVVISO}
            figli={[MARCO]}
            modo="nuova"
            parentId={PARENT_ID}
            {...p}
            onChiudi={onChiudi}
        />,
    )
    return { ...esito, onChiudi }
}

/** I campi numerici della modale, nell'ordine del DOM. */
const campi = (): HTMLInputElement[] =>
    Array.from(document.querySelectorAll('input[type="number"]'))

describe('AdesioneNumeroModal · la scrittura avviene una volta sola, alla conferma', () => {
    it('🔴 montare la modale NON scrive niente', () => {
        monta()
        // Il difetto che questa modale esiste per impedire: «Aderisco» che registra
        // subito e poi chiede il numero a cose fatte.
        expect(chiamate).toHaveLength(0)
    })

    it('alla conferma parte UNA sola POST, col numero scelto', async () => {
        monta()
        fireEvent.change(campi()[0], { target: { value: '4' } })
        fireEvent.click(screen.getByRole('button', { name: T('adesioneConferma') }))

        await waitFor(() => expect(chiamate).toHaveLength(1))
        expect(chiamate[0].url).toBe(`/api/avvisi/${AVVISO.id}/risposte`)
        expect(chiamate[0].corpo).toEqual({
            student_id: MARCO.student_id,
            risposta: 'si',
            numero_partecipanti: 4,
        })
    })

    it('il campo nasce precompilato col minimo dell’avviso, mai a zero', () => {
        // «Quante persone?» con risposta zero non è un'adesione, è un no — e il no
        // ha già il suo bottone sulla card.
        monta({ avviso: { ...AVVISO, numero_min: 2, numero_max: 6 } })
        expect(campi()[0].value).toBe('2')
    })

    it('in «modifica» riparte dal numero già dichiarato, non dal minimo', () => {
        monta({
            modo: 'modifica',
            avviso: {
                ...AVVISO,
                my_response: { letto_il: 'x', risposta: 'si', risposto_il: 'x', stato_adesione: 'ammessa', numero_partecipanti: 5 },
            },
        })
        expect(campi()[0].value).toBe('5')
        // …e il modulo si presenta come una correzione, non come una nuova adesione.
        expect(screen.getByRole('button', { name: T('adesioneSalva') })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: T('adesioneConferma') })).not.toBeInTheDocument()
    })

    it('🔴 a ZERO righe «Conferma» non chiude fingendo di aver scritto', async () => {
        // `figli` vuoto e nessun figlio attivo su cui ripiegare (`page.tsx`):
        // `Promise.all([])` risolveva subito e la modale si CHIUDEVA — cioè faceva
        // il gesto del successo su una scrittura mai avvenuta. Il ramo a un tocco
        // la guardia ce l'aveva già; qui no.
        const onChiudi = vi.fn()
        monta({ figli: [], onChiudi })

        fireEvent.click(screen.getByRole('button', { name: T('adesioneConferma') }))

        // Si aspetta la PRESENZA del banner, non l'assenza della chiusura: «non si
        // è chiusa» è vero anche mentre una fetch è ancora in volo.
        const banner = await screen.findByRole('alert')
        expect(banner.textContent).toBe(T('adesioneErrore'))
        expect(onChiudi, 'la modale si è chiusa senza aver scritto niente').not.toHaveBeenCalled()
        expect(chiamate).toHaveLength(0)
    })

    it('«Annulla» chiude senza scrivere', () => {
        const onChiudi = vi.fn()
        monta({ onChiudi })
        fireEvent.click(screen.getByRole('button', { name: T('adesioneAnnulla') }))
        expect(onChiudi).toHaveBeenCalledTimes(1)
        expect(chiamate).toHaveLength(0)
    })
})

describe('AdesioneNumeroModal · due figli, due numeri, e uno che non partecipa', () => {
    it('una riga per figlio, numeri indipendenti, UNA POST ciascuno', async () => {
        monta({ figli: [MARCO, GIULIA] })

        expect(campi()).toHaveLength(2)
        fireEvent.change(campi()[0], { target: { value: '3' } })
        fireEvent.change(campi()[1], { target: { value: '5' } })
        fireEvent.click(screen.getByRole('button', { name: T('adesioneConferma') }))

        await waitFor(() => expect(chiamate).toHaveLength(2))
        expect(chiamate.map((c) => c.corpo)).toEqual([
            { student_id: MARCO.student_id, risposta: 'si', numero_partecipanti: 3 },
            { student_id: GIULIA.student_id, risposta: 'si', numero_partecipanti: 5 },
        ])
    })

    it('🔴 un figlio che NON partecipa manda «no», e l’altro il proprio numero', async () => {
        // Senza l'interruttore una famiglia con due bambini di cui uno solo va in
        // gita non ha alcun modo di dirlo: o vanno tutti, o nessuno.
        monta({ figli: [MARCO, GIULIA] })

        const interruttori = screen.getAllByRole('checkbox')
        expect(interruttori).toHaveLength(2)
        fireEvent.click(interruttori[1]) // Giulia non partecipa

        fireEvent.change(campi()[0], { target: { value: '2' } })
        fireEvent.click(screen.getByRole('button', { name: T('adesioneConferma') }))

        await waitFor(() => expect(chiamate).toHaveLength(2))
        expect(chiamate[0].corpo).toEqual({ student_id: MARCO.student_id, risposta: 'si', numero_partecipanti: 2 })
        // Un «no» è una RISPOSTA, non un'assenza di risposta: è ciò che libera il
        // posto se questo figlio ne aveva uno.
        expect(chiamate[1].corpo).toEqual({ student_id: GIULIA.student_id, risposta: 'no' })
        // …e il campo del figlio che non partecipa è spento, non solo ignorato.
        expect(campi()[1].disabled).toBe(true)
    })

    it('il totale si aggiorna e lo annuncia (`aria-live`)', () => {
        const { container } = monta({ figli: [MARCO, GIULIA] })
        fireEvent.change(campi()[0], { target: { value: '3' } })
        fireEvent.change(campi()[1], { target: { value: '4' } })

        const vivo = container.querySelector('[aria-live="polite"]')
        expect(vivo, 'il totale non è annunciato: chi non vede lo schermo non lo sa').not.toBeNull()
        expect(vivo?.textContent).toContain(T('adesioneTotalePersone', { count: 7 }))
    })
})

// ═════════════════════════════════════════════════════════════════════════════
// 🔴 «MODIFICA IL NUMERO» CON FRATELLI A NUMERI DIVERSI — il difetto misurato:
// due figli dichiarati a 2 e a 4, i campi che nascono a 1 e 1, e la conferma che
// porta via tre persone dal tetto in silenzio.
//
// Quando i figli non concordano l'aggregato `my_response.numero_partecipanti` è
// `null` — ed è giusto che lo sia — quindi il modulo ricadeva su `limiti.min`. Il
// bottone che apre questa modale è raggiungibile in quel caso (entrambi hanno
// risposto «sì»): chi entrava per correggere UN figlio ne riscriveva DUE.
// ═════════════════════════════════════════════════════════════════════════════
describe('AdesioneNumeroModal · in «modifica» ogni figlio riparte dal PROPRIO numero', () => {
    const conNumeriDiversi = () => ({
        modo: 'modifica' as const,
        figli: [
            { ...MARCO, stato_adesione: 'ammessa', numero_partecipanti: 2 },
            { ...GIULIA, stato_adesione: 'in_attesa', numero_partecipanti: 4 },
        ],
        avviso: {
            ...AVVISO,
            // L'aggregato è `null` PROPRIO perché i due numeri divergono: è la
            // condizione in cui nasceva il difetto, non un caso di comodo.
            my_response: { letto_il: 'x', risposta: 'si', risposto_il: 'x', stato_adesione: null, numero_partecipanti: null },
        },
    })

    it('🔴 i campi nascono a 2 e 4, non a 1 e 1', () => {
        monta(conNumeriDiversi())
        expect(campi().map((c) => c.value)).toEqual(['2', '4'])
    })

    it('🔴 e confermando SENZA toccare niente non si riscrive niente di diverso', async () => {
        // La metà che conta davvero: il valore a schermo è quello che parte. Con il
        // difetto qui arrivavano due `1`, cioè 2→1 e 4→1 — tre persone liberate dal
        // tetto che nessuno aveva chiesto di liberare, con un 200 e nessun avviso.
        monta(conNumeriDiversi())
        fireEvent.click(screen.getByRole('button', { name: T('adesioneSalva') }))

        await waitFor(() => expect(chiamate).toHaveLength(2))
        expect(chiamate.map((c) => c.corpo)).toEqual([
            { student_id: MARCO.student_id, risposta: 'si', numero_partecipanti: 2 },
            { student_id: GIULIA.student_id, risposta: 'si', numero_partecipanti: 4 },
        ])
    })

    it('il figlio senza numero proprio ricade sull’aggregato, e poi sul minimo', () => {
        // I due gradini del ripiego, dal più specifico al più generico. Il primo
        // figlio ha il suo numero; il secondo non ce l'ha e prende l'aggregato.
        monta({
            modo: 'modifica',
            figli: [{ ...MARCO, numero_partecipanti: 6 }, GIULIA],
            avviso: {
                ...AVVISO,
                my_response: { letto_il: 'x', risposta: 'si', risposto_il: 'x', stato_adesione: 'ammessa', numero_partecipanti: 3 },
            },
        })
        expect(campi().map((c) => c.value)).toEqual(['6', '3'])
    })

    it('CONTROLLO POSITIVO: senza nessun numero dichiarato si riparte dal minimo', () => {
        // Senza questo, «riparte dal proprio numero» sarebbe verde anche con un
        // modulo che non precompila più niente.
        monta({ figli: [MARCO, GIULIA], avviso: { ...AVVISO, numero_min: 2, numero_max: 6 } })
        expect(campi().map((c) => c.value)).toEqual(['2', '2'])
    })
})

describe('AdesioneNumeroModal · l’esito si legge SUBITO, a schermo', () => {
    it('🔴 un figlio in lista d’attesa: la modale NON si chiude e lo dice', async () => {
        const onChiudi = vi.fn()
        risposte = [{ ok: true, corpo: { stato: 'in_attesa' } }]
        monta({ onChiudi })

        fireEvent.click(screen.getByRole('button', { name: T('adesioneConferma') }))

        await waitFor(() => expect(screen.getByText(T('adesioneEsitoAttesaCorpo'))).toBeInTheDocument())
        expect(onChiudi, 'la modale si è chiusa portandosi via l’unica informazione utile').not.toHaveBeenCalled()
        // Un solo comando nel pannello d'esito, e il fuoco ci sta sopra.
        const hoCapito = screen.getByRole('button', { name: T('adesioneEsitoChiudi') })
        expect(document.activeElement).toBe(hoCapito)

        fireEvent.click(hoCapito)
        expect(onChiudi).toHaveBeenCalledTimes(1)
    })

    it('ESITO MISTO: una riga per figlio, con il proprio esito', async () => {
        risposte = [
            { ok: true, corpo: { stato: 'ammessa' } },
            { ok: true, corpo: { stato: 'in_attesa' } },
        ]
        monta({ figli: [MARCO, GIULIA] })
        fireEvent.click(screen.getByRole('button', { name: T('adesioneConferma') }))

        await waitFor(() =>
            expect(screen.getByText(T('adesioneEsitoAmmessoFiglio', { nome: MARCO.nome }))).toBeInTheDocument(),
        )
        expect(screen.getByText(T('adesioneEsitoAttesaFiglio', { nome: GIULIA.nome }))).toBeInTheDocument()
    })

    it('CONTROLLO POSITIVO: se sono tutti ammessi la modale si chiude', async () => {
        // Senza questo, «resta aperta» sarebbe verde anche su una modale che non si
        // chiude mai — cioè su un vicolo cieco.
        const onChiudi = vi.fn()
        risposte = [{ ok: true, corpo: { stato: 'ammessa' } }]
        monta({ onChiudi })

        fireEvent.click(screen.getByRole('button', { name: T('adesioneConferma') }))
        await waitFor(() => expect(onChiudi).toHaveBeenCalledTimes(1))
        expect(screen.queryByText(T('adesioneEsitoAttesaCorpo'))).not.toBeInTheDocument()
    })
})

describe('AdesioneNumeroModal · su un rifiuto non si butta via niente', () => {
    it('🔴 POSTI_ESAURITI dice che l’adesione RESTA COM’ERA, mai «sei fuori»', async () => {
        // I due `POSTI_ESAURITI` non sono la stessa cosa. A chi non ha posto la RPC
        // non lo restituisce MAI: quel genitore va in coda con un 200. L'unico caso
        // in cui arriva qui è chi è GIÀ ammesso e non riesce ad aumentare il numero
        // — e dirgli «sei fuori» sarebbe falso proprio mentre il sistema lo tiene
        // dentro.
        const onChiudi = vi.fn()
        risposte = [{ ok: false, status: 409, corpo: { error: 'x', codice: 'POSTI_ESAURITI' } }]
        monta({
            onChiudi,
            modo: 'modifica',
            avviso: {
                ...AVVISO,
                my_response: { letto_il: 'x', risposta: 'si', risposto_il: 'x', stato_adesione: 'ammessa', numero_partecipanti: 3 },
            },
        })

        fireEvent.change(campi()[0], { target: { value: '9' } })
        fireEvent.click(screen.getByRole('button', { name: T('adesioneSalva') }))

        const banner = await screen.findByRole('alert')
        expect(banner.textContent).toBe(itShared.errorePostiEsauriti)
        expect(banner.textContent).toContain('resta com’era')
        // La modale resta aperta, e il numero digitato è ancora lì.
        expect(onChiudi).not.toHaveBeenCalled()
        expect(campi()[0].value).toBe('9')
    })

    it('🔴 RIFIUTO PARZIALE: si dice anche CHI è passato, non solo chi è stato respinto', async () => {
        // Marco scritto, Giulia respinta. Il banner da solo dice «l'adesione resta
        // com'era» — che per Marco è FALSO: la sua riga c'è. Non è un doppione
        // (l'upsert regge), è un messaggio che dice meno del vero proprio mentre la
        // famiglia decide se riprovare.
        risposte = [
            { ok: true, corpo: { stato: 'ammessa' } },
            { ok: false, status: 409, corpo: { error: 'x', codice: 'POSTI_ESAURITI' } },
        ]
        monta({ figli: [MARCO, GIULIA] })
        fireEvent.click(screen.getByRole('button', { name: T('adesioneConferma') }))

        const banner = await screen.findByRole('alert')
        // Il rifiuto c'è ancora — non si nasconde per fare spazio alla buona notizia.
        expect(banner.textContent).toContain(itShared.errorePostiEsauriti)
        // …e accanto, nello STESSO `role="alert"`, il figlio che è passato: chi
        // ascolta lo sente in un annuncio solo, non in due.
        expect(banner.textContent).toContain(T('adesioneEsitoAmmessoFiglio', { nome: MARCO.nome }))
    })

    it('CONTROLLO POSITIVO: se non è passato NESSUNO il banner resta quello di prima', async () => {
        // Senza questo, l'elenco sarebbe verde anche se comparisse sempre — anche
        // con un solo figlio respinto, dove non c'è nessuna buona notizia da dare.
        risposte = [{ ok: false, status: 409, corpo: { error: 'x', codice: 'POSTI_ESAURITI' } }]
        monta()
        fireEvent.click(screen.getByRole('button', { name: T('adesioneConferma') }))

        const banner = await screen.findByRole('alert')
        expect(banner.textContent).toBe(itShared.errorePostiEsauriti)
    })

    it('un rifiuto qualsiasi lascia il banner e i numeri intatti', async () => {
        risposte = [{ ok: false, status: 409, corpo: { error: 'x', codice: 'ADESIONE_SCADUTA' } }]
        monta()

        fireEvent.change(campi()[0], { target: { value: '6' } })
        fireEvent.click(screen.getByRole('button', { name: T('adesioneConferma') }))

        const banner = await screen.findByRole('alert')
        expect(banner.textContent).toBe(itShared.erroreAdesioneScaduta)
        expect(campi()[0].value).toBe('6')
    })

    it('la rete caduta non lascia la modale muta', async () => {
        globalThis.fetch = vi.fn(async () => { throw new Error('rete') }) as unknown as typeof globalThis.fetch
        monta()
        fireEvent.click(screen.getByRole('button', { name: T('adesioneConferma') }))

        const banner = await screen.findByRole('alert')
        expect(banner.textContent).toBe(T('adesioneErrore'))
    })
})

describe('AdesioneNumeroModal · accessibilità', () => {
    it('con UN figlio la domanda della segreteria È l’etichetta del campo', () => {
        // Metodo del repo: si risale dal campo alla sua `<label>`, come fa uno
        // screen reader — non si guarda il sorgente.
        monta()
        expect(campi()[0].labels?.[0]?.textContent).toBe(DOMANDA)
    })

    it('🔴 con DUE figli l’etichetta è il NOME, e la domanda è la descrizione condivisa', () => {
        // È l'unica disposizione che dà sia «Giulia» (quale campo sto compilando)
        // sia la domanda, senza ripeterla su ogni riga. Con la domanda come
        // `<label>` di entrambi i campi sarebbero indistinguibili all'ascolto.
        monta({ figli: [MARCO, GIULIA] })

        expect(campi().map((c) => c.labels?.[0]?.textContent)).toEqual([MARCO.nome, GIULIA.nome])

        const descritti = campi().map((c) => c.getAttribute('aria-describedby'))
        expect(descritti[0], 'il campo non dichiara a quale domanda risponde').toBeTruthy()
        expect(descritti[0]).toBe(descritti[1])
        expect(document.getElementById(String(descritti[0]))?.textContent).toBe(DOMANDA)
    })

    it('🔴 le due caselle si chiamano col NOME del bambino, e il nome NON cambia con lo stato', () => {
        // Due difetti in una riga sola: entrambe si chiamavano «Partecipo» — cioè
        // all'ascolto non si distingueva quale bambino si stesse togliendo dalla
        // gita — e all'uncheck il nome diventava «Non partecipo», che deselezionata
        // si sente «Non partecipo, casella di controllo, NON selezionata»: due
        // negazioni per un fatto solo. Lo stato lo dice `checked`.
        //
        // Si legge il NOME ACCESSIBILE dal ruolo, come fa uno screen reader: il
        // test di prima contava le caselle e non ne leggeva mai il nome.
        monta({ figli: [MARCO, GIULIA] })
        const nomeDi = (n: string) => `${n} ${T('adesionePartecipa')}`

        const marco = screen.getByRole('checkbox', { name: nomeDi(MARCO.nome) })
        const giulia = screen.getByRole('checkbox', { name: nomeDi(GIULIA.nome) })
        expect(marco, 'le due caselle sono lo stesso elemento: il nome non distingue').not.toBe(giulia)

        fireEvent.click(giulia)
        // Stesso nome, stato diverso.
        expect(screen.getByRole('checkbox', { name: nomeDi(GIULIA.nome) })).not.toBeChecked()
        expect(screen.getByRole('checkbox', { name: nomeDi(MARCO.nome) })).toBeChecked()
        expect(
            screen.queryByText(T('adesioneNonPartecipa')),
            'il testo della casella cambia ancora con lo stato',
        ).not.toBeInTheDocument()
    })

    it('la domanda vuota ricade sul predefinito, mai su un’etichetta invisibile', () => {
        monta({ avviso: { ...AVVISO, etichetta_numero: '   ' } })
        expect(campi()[0].labels?.[0]?.textContent).toBe('Quante persone accompagneranno il bambino?')
    })

    it('è un `role="dialog"` modale, etichettato dal proprio titolo', () => {
        monta()
        const dialogo = screen.getByRole('dialog')
        expect(dialogo).toHaveAttribute('aria-modal', 'true')
        const id = dialogo.getAttribute('aria-labelledby')
        expect(document.getElementById(String(id))?.textContent).toBe(T('adesioneModaleTitolo'))
    })

    it('axe non trova violazioni, né nel modulo né nel pannello d’esito', async () => {
        // `jest-axe` IN AGGIUNTA: le asserzioni sulle etichette qui sopra provano
        // cose che axe non guarda — axe vede che un nome accessibile c'è, non che
        // sia quello giusto.
        risposte = [{ ok: true, corpo: { stato: 'in_attesa' } }]
        const { container } = monta({ figli: [MARCO, GIULIA] })
        const opzioni = {
            rules: {
                region: { enabled: false },
                'landmark-one-main': { enabled: false },
                'page-has-heading-one': { enabled: false },
            },
        }
        expect(await axe(container, opzioni)).toHaveNoViolations()

        fireEvent.click(screen.getByRole('button', { name: T('adesioneConferma') }))
        await waitFor(() => expect(screen.getByText(T('adesioneEsitoAttesaCorpo'))).toBeInTheDocument())
        expect(await axe(container, opzioni)).toHaveNoViolations()
    })
})

// ═════════════════════════════════════════════════════════════════════════════
// 🔴 L'ASSERZIONE NEGATIVA — nessun numero di posti liberi, in nessuno stato.
// ═════════════════════════════════════════════════════════════════════════════
describe('AdesioneNumeroModal · i posti liberi non compaiono MAI', () => {
    it('né nel modulo, né nel pannello d’esito, né nel messaggio d’errore', async () => {
        // I tre numeri non possono nascere da nient'altro in questa modale: 97 (il
        // tetto), 40 (gli ammessi) e 57 (la differenza — il dato vietato vero, che
        // nessuno scrive e che si ricava). La riga li porta come se una regressione
        // avesse riaperto la proiezione del server.
        const avvisoConPosti = {
            ...AVVISO,
            ...({ posti_totali: 97 } as Record<string, unknown>),
            stats: { letti: 0, adesioni_si: 0, adesioni_no: 0, persone_ammesse: 40 } as Avviso['stats'],
        }
        risposte = [{ ok: true, corpo: { stato: 'in_attesa', occupati: 40, posti_totali: 97, liberi: 57 } }]
        const { container } = monta({ avviso: avvisoConPosti })

        const proibiti = ['97', '57', '40']
        for (const p of proibiti) {
            expect(container.textContent, `«${p}» nel modulo`).not.toContain(p)
        }

        fireEvent.click(screen.getByRole('button', { name: T('adesioneConferma') }))
        await waitFor(() => expect(screen.getByText(T('adesioneEsitoAttesaCorpo'))).toBeInTheDocument())

        // Controllo positivo: il pannello d'esito sta rendendo davvero qualcosa.
        expect(screen.getByText(T('adesioneEsitoAttesaTitolo'))).toBeInTheDocument()
        for (const p of proibiti) {
            expect(container.textContent, `«${p}» nel pannello d’esito`).not.toContain(p)
        }
    })
})
