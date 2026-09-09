import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import itPrimaria from '../../messages/it/adminPrimaria.json'
import enPrimaria from '../../messages/en/adminPrimaria.json'
import { SEDE_A } from '../fixtures/sedi'

// =============================================================================
// L2 — OrarioManager: la schermata AFFERMAVA IL FALSO.
//
// `load()` aveva `try/finally` SENZA catch e nessun ramo `else` sui tre
// `success`. Quando una delle tre letture falliva — un 403 di scope, un 500, la
// rete giù — le tre `setState` non partivano, `campanelle` restava `[]`, e la
// schermata rendeva «Imposta il tempo scuola per generare la griglia.»
//
// Quella frase non è uno stato vuoto neutro: è un'AFFERMAZIONE POSITIVA («ho
// letto, e orario non ce n'è») che esce IDENTICA in quattro mondi diversi —
// campanelle davvero assenti (misurato il 2026-09-09: 9 sezioni di primaria su
// 11), `{error}` di PostgREST ingoiato, 500 della route, rete caduta. Chiude il
// dubbio nel verso sbagliato e istruisce a configurare una cosa già configurata:
// e «configurarla» qui vuol dire premere «Rigenera», che cancella tutto.
//
// Si asserisce:
//  (a) su un GET rifiutato quella frase NON esce, ed esce invece una frase
//      diversa più un «Riprova»;
//  (b) un 403 su `materie` non azzera le tendine (l'ultimo valore buono resta);
//  (c) un 500 su `set-cell` non lascia a schermo la materia che il database non
//      ha; e il rifiuto si logga con lo `stato`;
//  (d) «Rigenera» chiede conferma NOMINANDO le celle che si perdono.
//
// Il CONTROLLO POSITIVO in fondo è la metà che conta: la frase deve continuare
// a comparire quando è vera, altrimenti il rimedio è solo un'altra bugia.
// =============================================================================

const USER = 'aaaabbbb-1111-4111-8111-eeeeeeeeeeee'
const SEZIONE = 'cccccccc-2222-4222-8222-cccccccccccc'
const CAMP_1 = 'dddddddd-3333-4333-8333-dddddddddddd'
const MATERIA_1 = 'eeeeeeee-4444-4444-8444-eeeeeeeeeeee'
const SEZIONE_2 = '99999999-6666-4666-8666-999999999999'

const h = vi.hoisted(() => ({ logClient: vi.fn() }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: () => 'Error' }))

import { OrarioManager } from '@/components/features/admin/primaria/OrarioManager'

const CAMPANELLA = { id: CAMP_1, giorno_settimana: 1, ordine: 1, ora_inizio: '08:30:00', ora_fine: '09:30:00', tipo: 'lezione' }
const MATERIE = [{ id: MATERIA_1, nome: 'Italiano' }]
const DOCENTI = [{ id: '11111111-5555-4555-8555-111111111111', nome: 'Prova', cognome: 'Rossi', gradi: ['primaria'] }]

/** La risposta del GET orario. `celle` finisce in `data.orario`: è ciò che «Rigenera» distrugge. */
const datiOrario = (campanelle: unknown[], celle: unknown[] = []) => ({
    success: true,
    data: { tempoScuola: { modello: 27, giorni_settimana: 5 }, campanelle, orario: celle },
})

type Risposta = { ok: boolean; status: number; body: unknown }
const OK = (body: unknown): Risposta => ({ ok: true, status: 200, body })

/**
 * Le quattro risposte pilotabili. `orario`/`materie`/`docenti` sono le tre GET
 * di `load()`; `mutazione` è la risposta a QUALUNQUE POST.
 * Sono funzioni e non valori perché due test devono cambiare risposta AL SECONDO
 * giro di `load()` — è l'unico modo di provare che l'ultimo valore buono resta.
 */
let risposte: {
    orario: () => Risposta
    materie: () => Risposta
    docenti: () => Risposta
    mutazione: () => Risposta
}
let giriOrario = 0
const fetchMock = vi.fn()

beforeEach(() => {
    vi.clearAllMocks()
    giriOrario = 0
    risposte = {
        orario: () => OK(datiOrario([CAMPANELLA])),
        materie: () => OK({ success: true, data: MATERIE }),
        docenti: () => OK({ success: true, data: DOCENTI }),
        mutazione: () => OK({ success: true }),
    }
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
        const scegli = (): Risposta => {
            if (init?.method && init.method !== 'GET') return risposte.mutazione()
            if (url.includes('/orario?sectionId=')) { giriOrario += 1; return risposte.orario() }
            if (url.includes('/materie?')) return risposte.materie()
            return risposte.docenti()
        }
        const r = scegli()
        return Promise.resolve({
            ok: r.ok,
            status: r.status,
            json: async () => {
                if (r.body === undefined) throw new SyntaxError('corpo non JSON')
                return r.body
            },
        })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('confirm', vi.fn(() => true))
})

afterEach(() => {
    vi.unstubAllGlobals()
})

const monta = () => render(<OrarioManager sectionId={SEZIONE} scuolaId={SEDE_A} userId={USER} />)

/**
 * Il bottone che CANCELLA, preso per quello che è e non per come si chiama.
 * L'etichetta cambia («Genera orario» / «Rigenera campanelle») ed è essa stessa
 * sotto esame: cercarlo per una sola delle due lo renderebbe introvabile proprio
 * nel caso che si vuole misurare.
 */
const bottoneTempo = () => screen.getByRole('button', {
    name: new RegExp(`${itPrimaria.orarioGenera}|${itPrimaria.orarioRigenera}`),
})

/** È partita una POST? (`load()` fa solo GET.) */
const cePost = () => fetchMock.mock.calls.some(([, init]) => (init as { method?: string } | undefined)?.method === 'POST')

describe('OrarioManager — (a) una lettura fallita non si racconta come «non c\'è orario»', () => {
    it('403 sul GET dell\'orario: NON dice «Imposta il tempo scuola», dice che non ha potuto leggere', async () => {
        risposte.orario = () => ({ ok: false, status: 403, body: { error: 'Sezione di un altro plesso' } })
        monta()

        await waitFor(() => expect(screen.getByText(itPrimaria.orarioLetturaGuastaTitolo)).toBeInTheDocument())
        expect(screen.queryByText(itPrimaria.orarioImpostaTempo)).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: itPrimaria.orarioRiprova })).toBeInTheDocument()
        expect(h.logClient).toHaveBeenCalledWith(
            expect.objectContaining({ livello: 'error', evento: 'fetch', stato: 403 }),
        )
    })

    it('500 con corpo non JSON: stessa frase, non quella che afferma il vuoto', async () => {
        risposte.orario = () => ({ ok: false, status: 500, body: undefined })
        monta()

        await waitFor(() => expect(screen.getByText(itPrimaria.orarioLetturaGuastaTitolo)).toBeInTheDocument())
        expect(screen.queryByText(itPrimaria.orarioImpostaTempo)).not.toBeInTheDocument()
    })

    it('rete caduta (la fetch lancia): la schermata lo dice invece di tacere', async () => {
        fetchMock.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')))
        monta()

        await waitFor(() => expect(screen.getByText(itPrimaria.orarioLetturaGuastaTitolo)).toBeInTheDocument())
        expect(screen.queryByText(itPrimaria.orarioImpostaTempo)).not.toBeInTheDocument()
    })

    it('«Riprova» rilegge davvero, e la schermata torna normale quando il server risponde', async () => {
        risposte.orario = () => ({ ok: false, status: 503, body: { error: 'temporaneamente non disponibile' } })
        monta()
        await waitFor(() => expect(screen.getByText(itPrimaria.orarioLetturaGuastaTitolo)).toBeInTheDocument())

        risposte.orario = () => OK(datiOrario([CAMPANELLA]))
        fireEvent.click(screen.getByRole('button', { name: itPrimaria.orarioRiprova }))

        await waitFor(() => expect(screen.queryByText(itPrimaria.orarioLetturaGuastaTitolo)).not.toBeInTheDocument())
        expect(screen.getByRole('table')).toBeInTheDocument()
    })

    // ── CONTROLLO POSITIVO ────────────────────────────────────────────────────
    // Senza questo, «togliere la frase» sarebbe una correzione che si può fare
    // cancellandola: e allora le 9 sezioni che davvero non hanno campanelle non
    // saprebbero più che cosa fare.
    it('tre risposte buone e nessuna campanella: la frase ESISTE ancora, ed è quella giusta', async () => {
        risposte.orario = () => OK({ success: true, data: { tempoScuola: null, campanelle: [], orario: [] } })
        monta()

        await waitFor(() => expect(screen.getByText(itPrimaria.orarioImpostaTempo)).toBeInTheDocument())
        expect(screen.queryByText(itPrimaria.orarioLetturaGuastaTitolo)).not.toBeInTheDocument()
        expect(h.logClient).not.toHaveBeenCalled()
    })
})

describe('OrarioManager — (b) un rifiuto non azzera le tendine', () => {
    it('403 su `materie` al secondo giro: «Italiano» resta nella tendina, e il guasto si vede', async () => {
        monta()
        await waitFor(() => expect(screen.getByRole('option', { name: 'Italiano' })).toBeInTheDocument())

        // Il secondo `load()` (lo scatena una mutazione riuscita) trova `materie` chiuso.
        risposte.materie = () => ({ ok: false, status: 403, body: { error: 'Sede non accessibile' } })
        fireEvent.click(screen.getByRole('button', { name: itPrimaria.orarioAggiungiOra }))

        await waitFor(() => expect(screen.getByText(itPrimaria.orarioLetturaGuastaTitolo)).toBeInTheDocument())
        // L'ultimo valore buono è ancora lì: «rifiutato» non è «questa classe non ha materie».
        expect(screen.getByRole('option', { name: 'Italiano' })).toBeInTheDocument()
    })
})

describe('OrarioManager — (c) la cella ottimistica non sopravvive a un rifiuto', () => {
    it('500 su set-cell: la materia NON resta selezionata, il rifiuto si vede e si logga', async () => {
        monta()
        await waitFor(() => expect(screen.getByRole('option', { name: 'Italiano' })).toBeInTheDocument())

        risposte.mutazione = () => ({ ok: false, status: 500, body: { error: 'Cella non salvata' } })
        const tendine = screen.getAllByRole('combobox')
        // L'ultima coppia di tendine è quella della cella (le prime due sono modello/giorni).
        const tendinaMateria = tendine[2] as HTMLSelectElement
        fireEvent.change(tendinaMateria, { target: { value: MATERIA_1 } })

        await waitFor(() => expect(screen.getByText(/Cella non salvata/)).toBeInTheDocument())
        expect(tendinaMateria.value).toBe('')
        expect(h.logClient).toHaveBeenCalledWith(
            expect.objectContaining({ livello: 'error', evento: 'fetch', stato: 500 }),
        )
    })

    it('set-cell riuscito: la materia resta selezionata e non c\'è nessun errore', async () => {
        monta()
        await waitFor(() => expect(screen.getByRole('option', { name: 'Italiano' })).toBeInTheDocument())

        const tendinaMateria = screen.getAllByRole('combobox')[2] as HTMLSelectElement
        fireEvent.change(tendinaMateria, { target: { value: MATERIA_1 } })

        await waitFor(() => expect(tendinaMateria.value).toBe(MATERIA_1))
        expect(screen.queryAllByRole('alert')).toHaveLength(0)
        expect(h.logClient).not.toHaveBeenCalled()
    })

    it('update-campanella rifiutato: lo dice, invece di ricaricare e far sparire il gesto', async () => {
        monta()
        await waitFor(() => expect(screen.getByRole('option', { name: 'Italiano' })).toBeInTheDocument())

        risposte.mutazione = () => ({ ok: false, status: 409, body: { error: 'Campanella sovrapposta' } })
        fireEvent.click(screen.getByRole('button', { name: itPrimaria.orarioAggiungiOra }))

        await waitFor(() => expect(screen.getByText(/Campanella sovrapposta/)).toBeInTheDocument())
        expect(h.logClient).toHaveBeenCalledWith(
            expect.objectContaining({ livello: 'error', evento: 'fetch', stato: 409 }),
        )
    })
})

describe('OrarioManager — (d) «Rigenera» non distrugge in silenzio', () => {
    it('chiede conferma NOMINANDO le celle che si perdono, e col numero vero', async () => {
        const celle = [
            { giorno_settimana: 1, campanella_id: CAMP_1, materia_id: MATERIA_1, docente_id: null },
            { giorno_settimana: 2, campanella_id: CAMP_1, materia_id: MATERIA_1, docente_id: null },
            { giorno_settimana: 3, campanella_id: CAMP_1, materia_id: null, docente_id: null },
        ]
        risposte.orario = () => OK(datiOrario([CAMPANELLA], celle))
        monta()
        await waitFor(() => expect(screen.getByRole('option', { name: 'Italiano' })).toBeInTheDocument())

        fireEvent.click(screen.getByRole('button', { name: new RegExp(itPrimaria.orarioRigenera) }))

        expect(window.confirm).toHaveBeenCalledTimes(1)
        const domanda = String((window.confirm as unknown as { mock: { calls: string[][] } }).mock.calls[0][0])
        // Il numero vero, non un generico «sei sicuro?».
        expect(domanda).toContain('3')
        expect(domanda).not.toMatch(/\{|\}/)
    })

    it('annullando la conferma NON parte nessuna POST', async () => {
        risposte.orario = () => OK(datiOrario([CAMPANELLA], [{ giorno_settimana: 1, campanella_id: CAMP_1, materia_id: MATERIA_1, docente_id: null }]))
        vi.stubGlobal('confirm', vi.fn(() => false))
        monta()
        await waitFor(() => expect(screen.getByRole('option', { name: 'Italiano' })).toBeInTheDocument())
        const giriPrima = giriOrario

        fireEvent.click(screen.getByRole('button', { name: new RegExp(itPrimaria.orarioRigenera) }))

        await waitFor(() => expect(window.confirm).toHaveBeenCalled())
        expect(fetchMock.mock.calls.some(([, init]) => (init as { method?: string } | undefined)?.method === 'POST')).toBe(false)
        expect(giriOrario).toBe(giriPrima)
    })

    it('la PRIMA generazione (nessun tempo scuola attivo) non chiede niente: non c\'è niente da perdere', async () => {
        risposte.orario = () => OK({ success: true, data: { tempoScuola: null, campanelle: [], orario: [] } })
        monta()
        await waitFor(() => expect(screen.getByText(itPrimaria.orarioImpostaTempo)).toBeInTheDocument())

        fireEvent.click(screen.getByRole('button', { name: new RegExp(itPrimaria.orarioGenera) }))

        await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => (init as { method?: string } | undefined)?.method === 'POST')).toBe(true))
        expect(window.confirm).not.toHaveBeenCalled()
    })
})

describe('OrarioManager — i18n', () => {
    it('le chiavi nuove esistono in ENTRAMBI i cataloghi', () => {
        for (const k of [
            'orarioLetturaGuastaTitolo',
            'orarioLetturaGuastaCorpo',
            'orarioRiprova',
            'orarioErroreOperazione',
            'orarioConfermaRigenera',
        ]) {
            expect(itPrimaria).toHaveProperty(k)
            expect(enPrimaria).toHaveProperty(k)
        }
    })

    it('adminPrimaria: it ed en espongono lo stesso set di chiavi', () => {
        expect(Object.keys(itPrimaria).sort()).toEqual(Object.keys(enPrimaria).sort())
    })
})

// =============================================================================
// (e) LO STESSO DIFETTO, DENTRO LA SUA CORREZIONE.
//
// `tempo` resta `null` per DUE ragioni opposte: non c'è tempo scuola, oppure non
// si è potuto leggere. Il `confirm` di «Rigenera» era gated su `tempo` soltanto —
// `if (tempo && !confirm(...))` — quindi dopo una lettura fallita andava in corto
// sul primo operando: la domanda non veniva nemmeno posta e la POST partiva,
// cioè `DELETE FROM campanelle` con la FK dell'orario in CASCADE. Sopra c'era già
// l'avviso «Non ho potuto leggere l'orario»: la schermata ammetteva di non sapere
// e nella riga sopra offriva un pulsante che distruggeva senza chiedere.
//
// E `tempo` non è comunque il segnale giusto per «non c'è niente da perdere»:
// `rigeneraCampanelle` cancella per `section_id`, non per tempo scuola. Con due
// modelli attivi il `maybeSingle()` della route esce a mani vuote (lo dice il
// commento della route stessa) e il client vede `tempoScuola: null` con la
// griglia piena. Quello che si perde si conta su ciò che si è letto.
// =============================================================================
describe('OrarioManager — (e) su una lettura fallita non si rigenera affatto', () => {
    it('500 sul GET: il bottone che cancella è disabilitato, e nessuna POST parte', async () => {
        risposte.orario = () => ({ ok: false, status: 500, body: { error: 'boom' } })
        monta()
        await waitFor(() => expect(screen.getByText(itPrimaria.orarioLetturaGuastaTitolo)).toBeInTheDocument())

        expect(bottoneTempo()).toBeDisabled()
        fireEvent.click(bottoneTempo())

        expect(window.confirm).not.toHaveBeenCalled()
        expect(cePost()).toBe(false)
    })

    it('secondo giro fallito col tempo scuola ancora in memoria: si disabilita lo stesso', async () => {
        monta()
        await waitFor(() => expect(screen.getByRole('option', { name: 'Italiano' })).toBeInTheDocument())
        expect(bottoneTempo()).toBeEnabled()

        // La rilettura dopo una mutazione riuscita trova la route chiusa.
        risposte.orario = () => ({ ok: false, status: 503, body: { error: 'non disponibile' } })
        fireEvent.click(screen.getByRole('button', { name: itPrimaria.orarioAggiungiOra }))
        await waitFor(() => expect(screen.getByText(itPrimaria.orarioLetturaGuastaTitolo)).toBeInTheDocument())

        // `tempo` è ancora quello dell'ultima lettura buona: senza il gate sulla
        // lettura la domanda uscirebbe con un numero di celle vecchio.
        expect(bottoneTempo()).toBeDisabled()
    })

    // ── CONTROLLO POSITIVO ────────────────────────────────────────────────────
    // «Disabilitarlo sempre» passerebbe i due test qui sopra e renderebbe la
    // schermata inservibile per le nove sezioni che l'orario devono ancora farlo.
    it('lettura buona: il bottone è attivo e la generazione parte', async () => {
        risposte.orario = () => OK({ success: true, data: { tempoScuola: null, campanelle: [], orario: [] } })
        monta()
        await waitFor(() => expect(screen.getByText(itPrimaria.orarioImpostaTempo)).toBeInTheDocument())

        expect(bottoneTempo()).toBeEnabled()
        fireEvent.click(bottoneTempo())

        await waitFor(() => expect(cePost()).toBe(true))
        expect(window.confirm).not.toHaveBeenCalled()
    })

    it('tempo scuola assente ma campanelle già in griglia: chiede lo stesso, e il «no» ferma la POST', async () => {
        risposte.orario = () => OK({ success: true, data: { tempoScuola: null, campanelle: [CAMPANELLA], orario: [] } })
        vi.stubGlobal('confirm', vi.fn(() => false))
        monta()
        await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())

        fireEvent.click(bottoneTempo())

        expect(window.confirm).toHaveBeenCalledTimes(1)
        expect(cePost()).toBe(false)
        // E l'etichetta dice ciò che il gesto FA: qui c'è una griglia da riscrivere.
        expect(bottoneTempo().textContent).toContain(itPrimaria.orarioRigenera)
    })

    /*
     * IL CASO CHE NON È SOLO UN GUASTO: LA SEZIONE CAMBIA.
     *
     * `admin/primaria/page.tsx:90` monta questo componente SENZA `key`, quindi
     * cambiando sezione dalla tendina il componente non si rimonta: `tempo`,
     * `campanelle` e `orario` restano quelli di PRIMA finché le tre GET nuove non
     * rispondono. In quella finestra il bottone agisce sulla sezione NUOVA (il
     * `sectionId` della POST è già cambiato) mentre la domanda di conferma conta
     * le celle della VECCHIA — e se la vecchia era vuota la domanda non esce
     * affatto. È la stessa cosa di una lettura fallita: uno schermo che descrive
     * qualcosa di diverso da ciò su cui il pulsante andrà a scrivere.
     */
    it('cambio di sezione: finché la lettura nuova non arriva, il bottone è di nuovo inerte', async () => {
        risposte.orario = () => OK(datiOrario([CAMPANELLA], [{ giorno_settimana: 1, campanella_id: CAMP_1, materia_id: MATERIA_1, docente_id: null }]))
        const vista = monta()
        await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
        expect(bottoneTempo()).toBeEnabled()

        // La lettura della sezione nuova non risponde (rete lenta, non rotta).
        fetchMock.mockImplementation(() => new Promise(() => {}))
        vista.rerender(<OrarioManager sectionId={SEZIONE_2} scuolaId={SEDE_A} userId={USER} />)

        expect(bottoneTempo()).toBeDisabled()
        fireEvent.click(bottoneTempo())
        expect(cePost()).toBe(false)
    })
})
