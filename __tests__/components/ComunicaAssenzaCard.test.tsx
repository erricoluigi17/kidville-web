import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import itPrimaria from '../../messages/it/parentPrimaria.json'
import itShared from '../../messages/it/shared.json'

// =============================================================================
// «Comunica un'assenza» — la card che il genitore non ha mai avuto.
//
// ─── I DUE DIFETTI CHE QUESTO FILE MISURA ───────────────────────────────────
//
// 1. IL SUCCESSO DICHIARATO SENZA VERIFICA. L'originale (`PrimariaParentView`,
//    righe 270-277, componente esportato e MAI importato da nessuna pagina)
//    faceva:
//        await onComunicaAssenza(data, motivo);
//        setMsg(t('viewAssenzaComunicata'));
//    cioè scriveva «Assenza comunicata ✓» anche quando il server aveva appena
//    risposto 400. È lo stesso vizio che questo progetto ha già pagato altrove:
//    un'operazione che dichiara successo senza averlo verificato. Qui costa più
//    che altrove — il genitore chiude l'app convinto di aver avvisato la
//    maestra, e la maestra non ha ricevuto niente.
//
// 2. IL FUSO. `oggiIso()` dell'originale è `new Date().toISOString().slice(0,10)`:
//    fra la mezzanotte e le due italiane restituisce IERI. Con il server che ora
//    rifiuta le date passate, il campo si sarebbe presentato precompilato con una
//    data che il server respinge — un modulo che nasce sbagliato. Qui si misura
//    con l'orologio fermo alle 22:30 UTC del 10 agosto (= 00:30 dell'11 in
//    Italia): il campo deve dire 11, non 10.
//
// Il resto sono i requisiti del titolare: motivo facoltativo, annullamento
// finché l'appello non è stato fatto, ogni rifiuto con un messaggio italiano dal
// catalogo `CODICI_ERRORE` (mai la prosa del server, lock
// `errori-server-schermate-famiglia`), etichette associate ai campi e pulsanti
// che dicono su cosa agiscono.
// =============================================================================

// ── Perché questo file rimpiazza il mock GLOBALE di next-intl ────────────────
// `test/setup.ts` mocka next-intl con `t = (key) => modello`: i VALORI non
// arrivano nemmeno alla funzione. Con quel mock i due pulsanti «annulla» di due
// giorni diversi avrebbero lo STESSO nome accessibile («…per {giorno}»), ed è
// esattamente ciò che questo file deve poter distinguere. Qui si interpola
// davvero, così l'asserzione misura ciò che sente uno screen reader.
vi.mock('next-intl', async () => {
    const cataloghi: Record<string, Record<string, string>> = {
        parentPrimaria: (await import('../../messages/it/parentPrimaria.json')).default,
        shared: (await import('../../messages/it/shared.json')).default,
    }
    const risolvi = (ns: string | undefined, key: string): string =>
        (ns ? cataloghi[ns]?.[key] : undefined) ?? (ns ? `${ns}.${key}` : key)
    const rendi = (modello: string, valori: Record<string, unknown> = {}): string =>
        modello.replace(/\{(\w+)\}/g, (intero, k: string) => (k in valori ? String(valori[k]) : intero))
    const useTranslations = (ns?: string) => {
        const t = (key: string, valori?: Record<string, unknown>) => rendi(risolvi(ns, key), valori)
        return Object.assign(t, {
            rich: t,
            markup: t,
            raw: (key: string) => risolvi(ns, key),
            has: () => true,
        })
    }
    return {
        useTranslations,
        useLocale: () => 'it',
        useFormatter: () => ({ number: (v: unknown) => String(v), dateTime: (v: unknown) => String(v) }),
        NextIntlClientProvider: ({ children }: { children: unknown }) => children,
    }
})

const h = vi.hoisted(() => ({ logClient: vi.fn() }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: () => 'Error' }))

import { ComunicaAssenzaCard } from '@/components/features/parent/ComunicaAssenzaCard'

const GENITORE = 'aaaabbbb-1111-4111-8111-eeeeeeeeeeee'
const ALUNNO = 'ccccdddd-2222-4222-8222-ffffffffffff'

/** L'istante di prova: 22:30 UTC del 10 agosto = 00:30 dell'11 agosto a Roma. */
const MEZZANOTTE_ITALIANA = new Date('2026-08-10T22:30:00Z')

interface Risposta { ok: boolean; status: number; body: unknown }

const fetchMock = vi.fn()
let comunicate: unknown[]
let esitoGet: Risposta | null
let esitoPost: Risposta
let esitoDelete: Risposta
/** Quando è valorizzato, la fetch di quel metodo RIGETTA (rete giù). */
let reteGiu: string | null
/** Da quale GET in poi la lettura dell'elenco rigetta (1 = la prima). */
let getRompeDalla: number | null
let getFatte: number

const finge = (r: Risposta) => ({ ok: r.ok, status: r.status, json: async () => r.body })

function chiamate(metodo: string): { url: string; init?: RequestInit }[] {
    return (fetchMock.mock.calls as [string, RequestInit | undefined][])
        .map(([url, init]) => ({ url, init }))
        .filter(({ init }) => (init?.method ?? 'GET') === metodo)
}

beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(MEZZANOTTE_ITALIANA)
    comunicate = []
    esitoGet = null
    esitoPost = { ok: true, status: 201, body: { success: true } }
    esitoDelete = { ok: true, status: 200, body: { success: true } }
    reteGiu = null
    getRompeDalla = null
    getFatte = 0
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
        const metodo = init?.method ?? 'GET'
        if (reteGiu === metodo) return Promise.reject(new TypeError('Failed to fetch'))
        if (metodo === 'POST') return Promise.resolve(finge(esitoPost))
        if (metodo === 'DELETE') return Promise.resolve(finge(esitoDelete))
        getFatte++
        if (getRompeDalla !== null && getFatte >= getRompeDalla) {
            return Promise.reject(new TypeError('Failed to fetch'))
        }
        return Promise.resolve(finge(esitoGet ?? { ok: true, status: 200, body: { success: true, data: { comunicate } } }))
    })
    vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
    vi.useRealTimers()
})

const monta = (props: Partial<React.ComponentProps<typeof ComunicaAssenzaCard>> = {}) =>
    render(<ComunicaAssenzaCard studentId={ALUNNO} parentId={GENITORE} {...props} />)

/** Apre il modulo di invio (chiuso all'avvio, come nell'originale). */
const apriModulo = () => fireEvent.click(screen.getByRole('button', { name: itPrimaria.comunicaApri }))

describe("ComunicaAssenzaCard — l'esito della chiamata si LEGGE", () => {
    it('rifiuto del server: mostra il messaggio del catalogo, NON «assenza comunicata»', async () => {
        esitoPost = {
            ok: false,
            status: 400,
            body: { error: "L'assenza si comunica in anticipo: la data è già passata", codice: 'ASSENZA_DATA_PASSATA' },
        }
        const onAggiornato = vi.fn()
        monta({ onAggiornato })
        apriModulo()

        fireEvent.click(screen.getByRole('button', { name: itPrimaria.comunicaInvia }))

        // Il messaggio è quello tradotto dal codice…
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(itShared.erroreAssenzaDataPassata))
        // …e NON la dichiarazione di successo dell'originale.
        expect(screen.queryByText(itPrimaria.comunicaFatta)).not.toBeInTheDocument()
        // La pagina ospite non ricarica: non è successo niente da mostrare.
        expect(onAggiornato).not.toHaveBeenCalled()
        expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', evento: 'fetch', stato: 400 }))
    })

    it('la PROSA del server non arriva mai a schermo (lock schermate famiglia)', async () => {
        esitoPost = { ok: false, status: 500, body: { error: 'duplicate key value violates unique constraint "presenze_alunno_id_data_key"' } }
        monta()
        apriModulo()
        fireEvent.click(screen.getByRole('button', { name: itPrimaria.comunicaInvia }))

        await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
        expect(screen.getByRole('alert')).toHaveTextContent(itPrimaria.comunicaNonRiuscita)
        expect(screen.queryByText(/duplicate key|presenze_alunno_id_data_key/)).not.toBeInTheDocument()
    })

    it('la rete che cade non diventa un successo (e lascia una riga di log)', async () => {
        reteGiu = 'POST'
        const onAggiornato = vi.fn()
        monta({ onAggiornato })
        apriModulo()
        fireEvent.click(screen.getByRole('button', { name: itPrimaria.comunicaInvia }))

        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(itPrimaria.comunicaNonRiuscita))
        expect(screen.queryByText(itPrimaria.comunicaFatta)).not.toBeInTheDocument()
        expect(onAggiornato).not.toHaveBeenCalled()
        expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', evento: 'fetch' }))
        // Il modulo resta aperto col motivo digitato: si riprova senza riscrivere.
        expect(screen.getByLabelText(itPrimaria.comunicaDataLabel)).toBeInTheDocument()
    })

    it('invio riuscito: conferma a schermo, elenco ricaricato, pagina ospite avvisata', async () => {
        const onAggiornato = vi.fn()
        monta({ onAggiornato })
        await waitFor(() => expect(chiamate('GET')).toHaveLength(1))
        apriModulo()

        fireEvent.change(screen.getByLabelText(itPrimaria.comunicaMotivoLabel), { target: { value: 'Visita medica' } })
        fireEvent.click(screen.getByRole('button', { name: itPrimaria.comunicaInvia }))

        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(itPrimaria.comunicaFatta))
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
        expect(onAggiornato).toHaveBeenCalledTimes(1)
        // L'elenco delle comunicate si rilegge: la riga appena creata deve comparire.
        await waitFor(() => expect(chiamate('GET').length).toBeGreaterThanOrEqual(2))
        expect(h.logClient).not.toHaveBeenCalled()
    })

    it("invio riuscito ma rilettura dell'elenco caduta: resta detto che l'assenza È comunicata", async () => {
        // Il difetto SPECULARE a quello di partenza, e altrettanto bugiardo: la
        // scrittura è andata a buon fine, cade la GET che ricarica l'elenco, e il
        // genitore legge «assenza non comunicata». Riproverebbe — creando una
        // seconda comunicazione per un'assenza già registrata.
        getRompeDalla = 2
        const onAggiornato = vi.fn()
        monta({ onAggiornato })
        await waitFor(() => expect(chiamate('GET')).toHaveLength(1))
        apriModulo()

        fireEvent.click(screen.getByRole('button', { name: itPrimaria.comunicaInvia }))

        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(itPrimaria.comunicaFatta))
        expect(screen.queryByText(itPrimaria.comunicaNonRiuscita)).not.toBeInTheDocument()
        expect(onAggiornato).toHaveBeenCalledTimes(1)
        // Il guasto della rilettura si dice per quello che è, e si logga.
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(itPrimaria.comunicaElencoNonLetto))
        expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', evento: 'fetch' }))
    })
})

describe('ComunicaAssenzaCard — la data nasce nel fuso italiano', () => {
    it('alle 00:30 italiane il campo dice OGGI (11), non ieri (10) come farebbe l’UTC', async () => {
        monta()
        apriModulo()
        // Dal 2026-08-08 il campo è l'`<input type="date">` NATIVO, lo stesso
        // della schermata gemella (il collaudo le aveva trovate divergenti: un
        // campo mascherato di qua, uno nativo di là). Un campo nativo espone
        // sempre l'ISO, mentre a schermo il formato lo disegna il sistema —
        // quindi qui si misura l'ISO, che è anche ciò che parte nel corpo.
        const campo = screen.getByLabelText(itPrimaria.comunicaDataLabel)
        expect(campo).toHaveValue('2026-08-11')
        // …e il PAVIMENTO, che questa card non aveva: si poteva digitare una
        // data passata e scoprirlo solo dal rifiuto del server.
        expect(campo).toHaveAttribute('min', '2026-08-11')

        fireEvent.click(screen.getByRole('button', { name: itPrimaria.comunicaInvia }))
        await waitFor(() => expect(chiamate('POST')).toHaveLength(1))
        const corpo = JSON.parse(String(chiamate('POST')[0].init?.body))
        expect(corpo.data).toBe('2026-08-11')
    })

    it('la data si può cambiare, e parte quella scelta', async () => {
        monta()
        apriModulo()
        fireEvent.change(screen.getByLabelText(itPrimaria.comunicaDataLabel), { target: { value: '2026-09-15' } })
        fireEvent.click(screen.getByRole('button', { name: itPrimaria.comunicaInvia }))

        await waitFor(() => expect(chiamate('POST')).toHaveLength(1))
        expect(JSON.parse(String(chiamate('POST')[0].init?.body)).data).toBe('2026-09-15')
    })
})

describe('ComunicaAssenzaCard — la chiamata', () => {
    it('POST sulla rotta giusta, con identità in query e in header', async () => {
        monta()
        apriModulo()
        fireEvent.click(screen.getByRole('button', { name: itPrimaria.comunicaInvia }))

        await waitFor(() => expect(chiamate('POST')).toHaveLength(1))
        const { url, init } = chiamate('POST')[0]
        expect(url).toContain('/api/parent/presenze/comunica-assenza')
        expect(url).toContain(`userId=${GENITORE}`)
        expect((init?.headers as Record<string, string>)['x-user-id']).toBe(GENITORE)
        expect(JSON.parse(String(init?.body)).studentId).toBe(ALUNNO)
    })

    it('il motivo è FACOLTATIVO: senza, si invia lo stesso', async () => {
        monta()
        apriModulo()
        const invia = screen.getByRole('button', { name: itPrimaria.comunicaInvia })
        expect(invia).not.toBeDisabled()

        fireEvent.click(invia)
        await waitFor(() => expect(chiamate('POST')).toHaveLength(1))
        expect(JSON.parse(String(chiamate('POST')[0].init?.body)).motivo).toBe('')
    })

    it('senza identità non si chiama il server (nessuna fetch al buio)', async () => {
        monta({ studentId: null, parentId: null })
        await Promise.resolve()
        expect(fetchMock).not.toHaveBeenCalled()
    })
})

describe('ComunicaAssenzaCard — annullamento', () => {
    beforeEach(() => {
        comunicate = [
            { id: 'p-11', data: '2026-08-11', giustificazione_testo: 'Visita medica', stato: 'assente' },
            { id: 'p-12', data: '2026-08-12', giustificazione_testo: null, stato: 'assente' },
        ]
    })

    it('elenca le assenze comunicate e dà a ciascuna un comando che dice DI QUALE giorno', async () => {
        monta()
        const annulla = await screen.findAllByRole('button', { name: /^Annulla l[''’]assenza comunicata per / })
        expect(annulla).toHaveLength(2)
        // Nomi accessibili DIVERSI: due comandi identici nell'annuncio e diversi
        // nell'effetto sono il difetto WCAG 4.1.2 già trovato in questo repo.
        const nomi = annulla.map((b) => b.getAttribute('aria-label'))
        expect(new Set(nomi).size).toBe(2)
        expect(nomi[0]).toMatch(/11/)
        expect(nomi[1]).toMatch(/12/)
    })

    it('annullamento riuscito: DELETE con alunno e data, elenco ricaricato, ospite avvisato', async () => {
        const onAggiornato = vi.fn()
        monta({ onAggiornato })
        const annulla = await screen.findAllByRole('button', { name: /^Annulla l[''’]assenza comunicata per / })

        fireEvent.click(annulla[1])
        await waitFor(() => expect(chiamate('DELETE')).toHaveLength(1))
        const url = chiamate('DELETE')[0].url
        expect(url).toContain('/api/parent/presenze/comunica-assenza')
        expect(url).toContain(`studentId=${ALUNNO}`)
        expect(url).toContain('data=2026-08-12')
        expect(url).toContain(`userId=${GENITORE}`)

        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(itPrimaria.comunicaAnnullata))
        expect(onAggiornato).toHaveBeenCalled()
    })

    it("annullamento respinto (l'appello è già stato fatto): messaggio dal catalogo, la riga resta", async () => {
        esitoDelete = { ok: false, status: 409, body: { error: 'Appello già registrato', codice: 'ASSENZA_GIA_REGISTRATA' } }
        const onAggiornato = vi.fn()
        monta({ onAggiornato })
        const annulla = await screen.findAllByRole('button', { name: /^Annulla l[''’]assenza comunicata per / })

        fireEvent.click(annulla[0])
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(itShared.erroreAssenzaGiaRegistrata))
        expect(screen.queryByText(itPrimaria.comunicaAnnullata)).not.toBeInTheDocument()
        expect(onAggiornato).not.toHaveBeenCalled()
        expect(await screen.findAllByRole('button', { name: /^Annulla l[''’]assenza comunicata per / })).toHaveLength(2)
        expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', evento: 'fetch', stato: 409 }))
    })

    it('nessuna assenza comunicata: lo dice, invece di lasciare il vuoto', async () => {
        comunicate = []
        monta()
        expect(await screen.findByText(itPrimaria.comunicaElencoVuoto)).toBeInTheDocument()
    })

    it("elenco non leggibile: lo dichiara e lo logga (il silenzio direbbe «non hai comunicato niente»)", async () => {
        esitoGet = { ok: false, status: 500, body: { error: 'boom' } }
        monta()
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(itPrimaria.comunicaElencoNonLetto))
        expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', evento: 'fetch', stato: 500 }))
    })

    // ─────────────────────────────────────────────────────────────────────────
    // IL 200 CHE MENTE. `GET /api/parent/presenze` degrada a `comunicate: []`
    // quando la sua query fallisce, e risponde comunque 200: il ramo `!r.ok` qui
    // sopra — scritto, funzionante — su questo guasto non veniva MAI raggiunto,
    // e la card scriveva «Non hai comunicato assenze» a chi ne aveva e non
    // poteva più annullarle. Il server ora lo DICHIARA con `comunicateLette`.
    // ─────────────────────────────────────────────────────────────────────────
    it("200 ma il server dichiara di non aver letto l'elenco: lo dice, e non scrive «non hai comunicato assenze»", async () => {
        esitoGet = { ok: true, status: 200, body: { success: true, data: { comunicate: [], comunicateLette: false } } }
        monta()

        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(itPrimaria.comunicaElencoNonLetto))
        expect(screen.queryByText(itPrimaria.comunicaElencoVuoto)).not.toBeInTheDocument()
        // `stato: 200` non è un refuso: la chiamata HTTP è andata bene ed è il
        // server a dire che la lettura no. Distinguerlo da un 500 nel log è
        // l'unico modo di sapere quale dei due guasti è.
        expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', evento: 'fetch', stato: 200 }))
    })

    it('un server che il flag non lo manda ancora NON produce un errore inventato', async () => {
        // Rilascio a scaglioni, o app dello store più nuova del server:
        // `comunicateLette` arriva `undefined`. «Non lo dichiara» non è
        // «dichiara di no».
        esitoGet = { ok: true, status: 200, body: { success: true, data: { comunicate } } }
        monta()

        await screen.findAllByRole('button', { name: /^Annulla l[''’]assenza comunicata per / })
        expect(screen.queryByText(itPrimaria.comunicaElencoNonLetto)).not.toBeInTheDocument()
        expect(h.logClient).not.toHaveBeenCalled()
    })
})

// =============================================================================
// IL FUOCO — il difetto del ciclo 1 riprodotto identico nel file gemello.
//
// `parent/attendance/page.tsx` ha ricevuto nel ciclo 1 il ricovero del fuoco:
// quando l'azione riesce, il bottone che l'ha lanciata si smonta e il fuoco
// cadrebbe su `<body>` — chi usa la tastiera riparte dall'inizio della pagina,
// chi usa uno screen reader perde il posto e non sente mai com'è finita
// (WCAG 2.4.3, la stessa ragione per cui `ui/Modal.tsx` ripristina il fuoco).
//
// Questo componente è nato NELLO STESSO commit e non ha ereditato né i ref né
// gli effetti: la correzione era stata applicata dov'era stato segnalato il
// sintomo invece che alla regola. Misurato dal collaudo del 2026-08-07:
// `attivoDopoInvio: BODY`, `attivoDopoAnnulla: BODY`.
//
// Qui si misura anche il ramo RIFIUTATO, che su ENTRAMBE le schermate era
// rimasto indietro — cioè proprio il caso in cui l'utente deve sapere cos'è
// successo.
//
// NOTA sul finto: jsdom non sfoca da solo un elemento che diventa `disabled`
// (Chrome sì, ed è così che il fuoco finiva su `<body>`). Qui il difetto si
// manifesta come «il fuoco è rimasto sul bottone / sulla riga smontata»: in
// entrambi i mondi la correzione è la stessa — spostarlo sull'esito.
// =============================================================================
describe('ComunicaAssenzaCard — il fuoco non si perde (WCAG 2.4.3)', () => {
    it('invio riuscito: il fuoco va sulla conferma, non su <body>', async () => {
        monta()
        await waitFor(() => expect(chiamate('GET')).toHaveLength(1))
        apriModulo()

        const invia = screen.getByRole('button', { name: itPrimaria.comunicaInvia })
        invia.focus()
        expect(document.activeElement).toBe(invia)

        fireEvent.click(invia)

        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(itPrimaria.comunicaFatta))
        await waitFor(() => {
            expect(document.activeElement).not.toBe(document.body)
            expect(document.activeElement?.textContent ?? '').toContain(itPrimaria.comunicaFatta)
        })
        // Raggiungibile da codice ma NON dal Tab: il ricovero non deve aggiungere
        // una tappa all'ordine di navigazione di chi non ha sbagliato niente.
        expect((document.activeElement as HTMLElement).tabIndex).toBe(-1)
    })

    it('invio rifiutato dal server: il fuoco va sul messaggio d\'errore', async () => {
        esitoPost = {
            ok: false,
            status: 400,
            body: { error: 'data passata', codice: 'ASSENZA_DATA_PASSATA' },
        }
        monta()
        await waitFor(() => expect(chiamate('GET')).toHaveLength(1))
        apriModulo()

        const invia = screen.getByRole('button', { name: itPrimaria.comunicaInvia })
        invia.focus()
        fireEvent.click(invia)

        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(itShared.erroreAssenzaDataPassata))
        await waitFor(() => {
            expect(document.activeElement).not.toBe(document.body)
            expect(document.activeElement?.textContent ?? '').toContain(itShared.erroreAssenzaDataPassata)
        })
        expect((document.activeElement as HTMLElement).tabIndex).toBe(-1)
    })

    it('annullamento riuscito: il fuoco va sulla conferma (la riga con il bottone è sparita)', async () => {
        comunicate = [{ id: 'p-11', data: '2026-08-11', giustificazione_testo: null, stato: 'assente' }]
        monta()
        const annulla = await screen.findAllByRole('button', { name: /^Annulla l[''’]assenza comunicata per / })

        annulla[0].focus()
        expect(document.activeElement).toBe(annulla[0])
        fireEvent.click(annulla[0])

        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(itPrimaria.comunicaAnnullata))
        await waitFor(() => {
            expect(document.activeElement).not.toBe(document.body)
            expect(document.activeElement?.textContent ?? '').toContain(itPrimaria.comunicaAnnullata)
        })
    })

    it('annullamento rifiutato: il fuoco va sul messaggio d\'errore', async () => {
        comunicate = [{ id: 'p-11', data: '2026-08-11', giustificazione_testo: null, stato: 'assente' }]
        esitoDelete = { ok: false, status: 409, body: { error: 'appello fatto', codice: 'ASSENZA_GIA_REGISTRATA' } }
        monta()
        const annulla = await screen.findAllByRole('button', { name: /^Annulla l[''’]assenza comunicata per / })

        annulla[0].focus()
        fireEvent.click(annulla[0])

        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(itShared.erroreAssenzaGiaRegistrata))
        await waitFor(() => {
            expect(document.activeElement).not.toBe(document.body)
            expect(document.activeElement?.textContent ?? '').toContain(itShared.erroreAssenzaGiaRegistrata)
        })
    })

    it('al montaggio il fuoco NON viene rubato a chi apre la pagina', async () => {
        // Il ricovero deve scattare solo quando un ESITO compare. Uno che scattasse
        // al primo render farebbe saltare titolo e intestazione a chi ascolta.
        monta()
        await waitFor(() => expect(chiamate('GET')).toHaveLength(1))
        expect(document.activeElement).toBe(document.body)
    })
})

describe('ComunicaAssenzaCard — accessibilità e testi', () => {
    it('i due campi hanno un nome accessibile dato da una <label> associata', async () => {
        monta()
        apriModulo()
        const data = screen.getByLabelText(itPrimaria.comunicaDataLabel)
        const motivo = screen.getByLabelText(itPrimaria.comunicaMotivoLabel)
        // `getByLabelText` da solo passerebbe anche con un `aria-label`: qui si
        // pretende la <label for=…>, che è ciò che rende il testo cliccabile.
        // (Niente `querySelector`: gli id di `useId` contengono i due punti, che
        // in un selettore CSS non sono validi e farebbero lanciare la query.)
        const etichette = Array.from(document.querySelectorAll('label')).map((l) => l.getAttribute('for'))
        expect(data.id).toBeTruthy()
        expect(motivo.id).toBeTruthy()
        expect(etichette).toContain(data.id)
        expect(etichette).toContain(motivo.id)
    })

    it('il comando che apre il modulo dichiara se è aperto', async () => {
        monta()
        await waitFor(() => expect(chiamate('GET')).toHaveLength(1))
        const apri = screen.getByRole('button', { name: itPrimaria.comunicaApri })
        expect(apri).toHaveAttribute('aria-expanded', 'false')
        fireEvent.click(apri)
        expect(screen.getByRole('button', { name: itPrimaria.comunicaChiudi })).toHaveAttribute('aria-expanded', 'true')

        // E un ri-render non rilegge l'elenco: qui il finto `useTranslations`
        // restituisce una `t` NUOVA a ogni render — più severo di next-intl vero,
        // che la memoizza — quindi un effetto che dipendesse dall'identità di `t`
        // si vedrebbe subito come una seconda GET a ogni battito di stato.
        fireEvent.change(screen.getByLabelText(itPrimaria.comunicaMotivoLabel), { target: { value: 'x' } })
        await Promise.resolve()
        expect(chiamate('GET')).toHaveLength(1)
    })

    it('le chiavi nuove esistono in ENTRAMBI i cataloghi', async () => {
        const en = (await import('../../messages/en/parentPrimaria.json')).default as Record<string, string>
        for (const k of [
            'comunicaTitolo', 'comunicaHint', 'comunicaApri', 'comunicaChiudi',
            // `comunicaDataAiuto` («Formato: gg/mm/aaaa») NON è più in elenco: il
            // campo è diventato nativo e il formato lo disegna il sistema, quindi
            // quella frase non è più vera. L'aiuto sotto il campo è `comunicaHint`.
            // La chiave resta nel catalogo finché chi lo cura non la toglie: qui
            // si smette di pretenderla, così toglierla non tinge di rosso un test
            // che parla d'altro.
            'comunicaDataLabel', 'comunicaMotivoLabel', 'comunicaMotivoPlaceholder',
            'comunicaInvia', 'comunicaInvio', 'comunicaFatta', 'comunicaNonRiuscita',
            'comunicaElencoTitolo', 'comunicaElencoVuoto', 'comunicaElencoNonLetto',
            'comunicaAnnulla', 'comunicaAnnullamento', 'comunicaAnnullaAria', 'comunicaAnnullata',
            'comunicaAnnullaNonRiuscito',
        ]) {
            expect(itPrimaria, `manca in it: ${k}`).toHaveProperty(k)
            expect(en, `manca in en: ${k}`).toHaveProperty(k)
        }
    })
})
