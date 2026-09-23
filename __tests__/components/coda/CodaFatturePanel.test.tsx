/**
 * Pannello «Coda fatture» (nucleo §4). Copre lo stato della striscia (attiva/sospesa/
 * pausa), i contatori, la selezione con «Togli»/«Rimetti in coda» (quest'ultimo SOLO
 * quando la selezione è tutta in errore), «Sospendi/Riprendi» riservato all'admin, i
 * codici d'esito tradotti (etichetta E messaggio del server insieme per un codice
 * noto, correzione giro 2; solo il messaggio grezzo per un codice sconosciuto), lo
 * stato «non disponibile» (tabella assente) e il polling a 20 s.
 *
 * Il mock di next-intl è LOCALE e non quello globale di `test/setup.ts`: quel mock
 * risolve le chiavi con un accesso PIATTO (`gruppo[key]`), e questo catalogo è
 * nidificato (`codaFatture.stato.attiva`, …) — con l'accesso piatto ogni chiave
 * tornerebbe il proprio nome invece del testo, e le asserzioni sui testi sarebbero
 * finte. Stesso schema già usato da `__tests__/components/PrestampatiGenitore.test.tsx`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'

vi.mock('next-intl', async () => {
    const catalogo = (await import('../../../messages/it/adminContabilita.json')).default as Record<string, unknown>
    const { IntlMessageFormat } = await import('intl-messageformat')

    /** La foglia di un percorso puntato dentro un catalogo nidificato. */
    const foglia = (chiave: string): string | undefined => {
        let corrente: unknown = catalogo
        for (const pezzo of chiave.split('.')) {
            if (typeof corrente !== 'object' || corrente === null) return undefined
            corrente = (corrente as Record<string, unknown>)[pezzo]
        }
        return typeof corrente === 'string' ? corrente : undefined
    }

    const risolvi = (chiave: string, valori?: Record<string, unknown>): string => {
        const grezzo = foglia(chiave) ?? chiave
        if (!valori) return grezzo
        try {
            return String(new IntlMessageFormat(grezzo, 'it').format(valori))
        } catch {
            return grezzo
        }
    }

    const useTranslations = () => {
        const t = (chiave: string, valori?: Record<string, unknown>) => risolvi(chiave, valori)
        return Object.assign(t, {
            rich: t,
            markup: t,
            raw: t,
            // `has` VERO: il pannello lo usa per decidere se mostrare la traduzione
            // di un codice d'esito o il messaggio grezzo del server. Con uno stub
            // sempre-vero (come nel mock globale) quel ramo non sarebbe testabile.
            has: (chiave: string) => foglia(chiave) !== undefined,
        })
    }
    return {
        useTranslations,
        useLocale: () => 'it',
        NextIntlClientProvider: ({ children }: { children: unknown }) => children,
    }
})

import { CodaFatturePanel, type RispostaCoda, type VoceCoda } from '@/components/features/admin/pagamenti/CodaFatturePanel'

const UTENTE = 'aaaaaaaa-0000-4000-8000-000000000001'
const SEDE = 'bbbbbbbb-0000-4000-8000-000000000002'
const PAGAMENTO_A = 'cccccccc-0000-4000-8000-000000000003'
const PAGAMENTO_B = 'cccccccc-0000-4000-8000-000000000004'
const VOCE_A = 'dddddddd-0000-4000-8000-000000000005'
const VOCE_B = 'dddddddd-0000-4000-8000-000000000006'

const ORA_IT = new Intl.DateTimeFormat('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' })

function voce(extra: Partial<VoceCoda> = {}): VoceCoda {
    return {
        id: VOCE_A,
        stato: 'in_coda',
        urgente: false,
        accodata_il: '2026-09-23T08:00:00.000Z',
        esito_codice: null,
        esito_messaggio: null,
        scuola_id: SEDE,
        scuola_nome: 'Kidville Giugliano',
        pagamento_id: PAGAMENTO_A,
        alunno: 'Mario Rossi',
        descrizione: 'Retta 09/2026',
        importo: 150,
        creato_da_nome: 'Segreteria',
        posizione: 1,
        propria: true,
        ...extra,
    }
}

function risposta(extra: Partial<RispostaCoda> = {}): RispostaCoda {
    return {
        disponibile: true,
        stato: { sospesa: false, sospesa_il: null, pausa_fino_a: null, pausa_motivo: null, ultimo_giro_il: null },
        conteggi: { in_coda: 0, in_invio: 0, errore: 0, emesse_7g: 0, tolte_7g: 0 },
        stima_fine: null,
        voci: [],
        ...extra,
    }
}

let chiamate: { url: string; init?: RequestInit }[] = []
let code: RispostaCoda[] = []
let azioneEsito: { ok: boolean; body: unknown } = { ok: true, body: { aggiornate: 1 } }
let sospensioneEsito: { ok: boolean; body: unknown } = { ok: true, body: { ok: true } }

function montaFetch() {
    chiamate = []
    global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url)
        chiamate.push({ url: u, init })
        if (u.endsWith('/api/pagamenti/fattura/coda')) {
            const corrente = code.length > 1 ? code.shift()! : code[0]
            return { ok: true, json: async () => corrente } as unknown as Response
        }
        if (u.endsWith('/api/pagamenti/fattura/coda/azioni')) {
            return { ok: azioneEsito.ok, json: async () => azioneEsito.body } as unknown as Response
        }
        if (u.endsWith('/api/pagamenti/fattura/coda/sospensione')) {
            return { ok: sospensioneEsito.ok, json: async () => sospensioneEsito.body } as unknown as Response
        }
        throw new Error(`URL non atteso nel test: ${u}`)
    }) as unknown as typeof fetch
}

function postSu(percorso: string) {
    return chiamate.filter((c) => c.url.endsWith(percorso) && c.init?.method === 'POST')
}

beforeEach(() => {
    montaFetch()
    code = [risposta()]
    azioneEsito = { ok: true, body: { aggiornate: 1 } }
    sospensioneEsito = { ok: true, body: { ok: true } }
})
afterEach(() => {
    cleanup()
    vi.useRealTimers()
})

describe('CodaFatturePanel — striscia di stato e contatori', () => {
    it('coda attiva: mostra "l’invio continua anche a PC spento" e i quattro contatori', async () => {
        code = [risposta({ conteggi: { in_coda: 3, in_invio: 1, errore: 2, emesse_7g: 5, tolte_7g: 0 } })]
        render(<CodaFatturePanel userId={UTENTE} ruolo="segreteria" />)

        await screen.findByText('L’invio continua anche a PC spento.')
        expect(screen.getByText('3')).toBeTruthy()
        expect(screen.getByText('1')).toBeTruthy()
        expect(screen.getByText('2')).toBeTruthy()
        expect(screen.getByText('5')).toBeTruthy()
    })

    it('coda sospesa: il messaggio cambia, e «Riprendi» compare SOLO per l’admin', async () => {
        code = [risposta({ stato: { sospesa: true, sospesa_il: '2026-09-23T07:00:00.000Z', pausa_fino_a: null, pausa_motivo: null, ultimo_giro_il: null } })]
        render(<CodaFatturePanel userId={UTENTE} ruolo="segreteria" />)

        await screen.findByText('Coda sospesa: nessun invio in corso.')
        expect(screen.queryByRole('button', { name: /riprendi invio/i })).toBeNull()
        // Chi non è admin lo sa: non si trova davanti a un pulsante che il server rifiuterebbe.
        expect(screen.getByText('Riservato alla Direzione.')).toBeTruthy()
    })

    it('coda sospesa e ruolo admin: «Riprendi invio» c’è ed è cliccabile', async () => {
        code = [risposta({ stato: { sospesa: true, sospesa_il: null, pausa_fino_a: null, pausa_motivo: null, ultimo_giro_il: null } })]
        render(<CodaFatturePanel userId={UTENTE} ruolo="admin" />)

        const bottone = await screen.findByRole('button', { name: /riprendi invio/i })
        expect(bottone).toBeTruthy()
    })

    it('in pausa: mostra l’orario nel fuso Europe/Rome', async () => {
        // Relativo ad ADESSO, mai una data cablata: il pannello mostra la pausa solo se è ancora nel
        // futuro, e un orario scritto a mano fa scadere il test col calendario (.claude/rules/test.md).
        const finoA = new Date(Date.now() + 60 * 60 * 1000).toISOString()
        code = [risposta({ stato: { sospesa: false, sospesa_il: null, pausa_fino_a: finoA, pausa_motivo: 'aruba-429', ultimo_giro_il: null } })]
        render(<CodaFatturePanel userId={UTENTE} ruolo="segreteria" />)

        const attesa = `In pausa fino alle ${ORA_IT.format(new Date(finoA))}.`
        await screen.findByText(attesa)
    })

    it('coda non disponibile: l’avviso c’è, contatori ed elenco no', async () => {
        code = [{ ...risposta(), disponibile: false }]
        render(<CodaFatturePanel userId={UTENTE} ruolo="admin" />)

        await screen.findByText('La coda fatture non è ancora disponibile: la migrazione non è stata applicata.')
        expect(screen.queryByText('In coda')).toBeNull()
    })

    it('il caricamento fallito mostra «Riprova», che ricarica davvero', async () => {
        global.fetch = vi.fn(async () => ({ ok: false, json: async () => ({ error: 'Guasto' }) } as unknown as Response))
        render(<CodaFatturePanel userId={UTENTE} ruolo="segreteria" />)

        const riprova = await screen.findByRole('button', { name: 'Riprova' })
        montaFetch()
        code = [risposta({ conteggi: { in_coda: 1, in_invio: 0, errore: 0, emesse_7g: 0, tolte_7g: 0 } })]
        fireEvent.click(riprova)
        await screen.findByText('L’invio continua anche a PC spento.')
    })
})

describe('CodaFatturePanel — elenco, selezione e azioni', () => {
    it('mostra alunno, sede, importo, posizione e il badge «Urgente»', async () => {
        code = [risposta({ voci: [voce({ urgente: true, posizione: 2 })] })]
        render(<CodaFatturePanel userId={UTENTE} ruolo="segreteria" />)

        const riga = await screen.findByTestId(`coda-fattura-${VOCE_A}`)
        expect(within(riga).getByText('Mario Rossi')).toBeTruthy()
        expect(within(riga).getByText(/Kidville Giugliano/)).toBeTruthy()
        expect(within(riga).getByText(/€\s*150,00/)).toBeTruthy()
        expect(within(riga).getByText('Urgente')).toBeTruthy()
        // `posizione` è già 1-based nel contratto (GET /coda, §3: «1 = la prossima a
        // partire» — vedi __tests__/api/fattura-coda.test.ts): niente +1 a schermo.
        expect(within(riga).getByText('Posizione 2')).toBeTruthy()
    })

    it('un codice d’esito NOTO mostra l’etichetta tradotta E il messaggio del server (correzione giro 2); uno sconosciuto mostra solo il messaggio grezzo', async () => {
        const NOTO = voce({ id: VOCE_A, stato: 'errore', esito_codice: 'scarto_aruba', esito_messaggio: 'dettaglio tecnico che serve per correggere' })
        const IGNOTO = voce({ id: VOCE_B, stato: 'errore', pagamento_id: PAGAMENTO_B, esito_codice: 'CODICE_MAI_VISTO', esito_messaggio: 'Errore boh dal server' })
        code = [risposta({ voci: [NOTO, IGNOTO] })]
        render(<CodaFatturePanel userId={UTENTE} ruolo="segreteria" />)

        await screen.findByTestId(`coda-fattura-${VOCE_A}`)
        // Il codice noto mostra l'etichetta E il messaggio grezzo, non l'uno al posto
        // dell'altro: per `scarto_aruba` è il messaggio a dire alla segreteria COSA
        // correggere, e nasconderlo perché il codice è tradotto perdeva l'informazione.
        expect(screen.getByText('Scartata da Aruba')).toBeTruthy()
        expect(screen.getByText('dettaglio tecnico che serve per correggere')).toBeTruthy()
        expect(screen.getByText('Errore boh dal server')).toBeTruthy()
    })

    it('«Togli»: seleziona, conferma, e la POST porta gli id giusti', async () => {
        code = [
            risposta({ voci: [voce({ id: VOCE_A, stato: 'in_coda' })] }),
            risposta({ voci: [] }), // dopo l'azione, ricaricata: la voce è sparita
        ]
        render(<CodaFatturePanel userId={UTENTE} ruolo="segreteria" />)

        const riga = await screen.findByTestId(`coda-fattura-${VOCE_A}`)
        fireEvent.click(within(riga).getByRole('checkbox'))
        fireEvent.click(screen.getByRole('button', { name: 'Togli' }))

        await screen.findByRole('heading', { name: 'Togliere dalla coda?' })
        fireEvent.click(screen.getByRole('button', { name: 'Conferma' }))

        await waitFor(() => expect(postSu('/coda/azioni').length).toBe(1))
        const corpo = JSON.parse(String(postSu('/coda/azioni')[0].init?.body))
        expect(corpo).toEqual({ azione: 'togli', ids: [VOCE_A] })
    })

    it('«Rimetti in coda» compare SOLO quando la selezione è tutta in errore', async () => {
        code = [risposta({ voci: [voce({ id: VOCE_A, stato: 'in_coda' }), voce({ id: VOCE_B, pagamento_id: PAGAMENTO_B, stato: 'errore' })] })]
        render(<CodaFatturePanel userId={UTENTE} ruolo="segreteria" />)

        const rigaA = await screen.findByTestId(`coda-fattura-${VOCE_A}`)
        const rigaB = await screen.findByTestId(`coda-fattura-${VOCE_B}`)

        // Seleziona ENTRAMBE (una in_coda, una errore): niente «Rimetti in coda» —
        // rimetterebbe in coda anche una voce che non è mai stata rifiutata.
        fireEvent.click(within(rigaA).getByRole('checkbox'))
        fireEvent.click(within(rigaB).getByRole('checkbox'))
        expect(screen.queryByRole('button', { name: 'Rimetti in coda' })).toBeNull()

        // Deseleziona la in_coda: resta solo la errore, e il bottone appare.
        fireEvent.click(within(rigaA).getByRole('checkbox'))
        const rimetti = screen.getByRole('button', { name: 'Rimetti in coda' })
        fireEvent.click(rimetti)
        await screen.findByRole('heading', { name: 'Rimettere in coda?' })
        fireEvent.click(screen.getByRole('button', { name: 'Conferma' }))

        await waitFor(() => expect(postSu('/coda/azioni').length).toBe(1))
        expect(JSON.parse(String(postSu('/coda/azioni')[0].init?.body))).toEqual({ azione: 'rimetti', ids: [VOCE_B] })
    })

    it('una voce di un’ALTRA sede si vede ma non ha casella, e «Seleziona tutto» la lascia fuori', async () => {
        // /coda/azioni rifiuta l'INTERO gesto con 403 se anche una sola voce è di un altro
        // plesso: se il pannello la lasciasse spuntare, «Seleziona tutto» + «Togli» fallirebbe
        // sempre per una segreteria a sede singola, appena in coda c'è una voce di un'altra sede.
        code = [
            risposta({
                voci: [
                    voce({ id: VOCE_A, stato: 'in_coda' }),
                    voce({ id: VOCE_B, pagamento_id: PAGAMENTO_B, stato: 'errore', propria: false, scuola_nome: 'Altra sede' }),
                ],
            }),
            risposta({ voci: [] }),
        ]
        render(<CodaFatturePanel userId={UTENTE} ruolo="segreteria" />)

        const rigaA = await screen.findByTestId(`coda-fattura-${VOCE_A}`)
        const rigaB = await screen.findByTestId(`coda-fattura-${VOCE_B}`)
        expect(within(rigaA).getByRole('checkbox')).toBeTruthy()
        // La voce dell'altra sede resta visibile (decisione 6), senza casella.
        expect(within(rigaB).getByText(/Altra sede/)).toBeTruthy()
        expect(within(rigaB).queryByRole('checkbox')).toBeNull()

        fireEvent.click(screen.getByRole('checkbox', { name: 'Seleziona tutto' }))
        fireEvent.click(screen.getByRole('button', { name: 'Togli' }))
        await screen.findByRole('heading', { name: 'Togliere dalla coda?' })
        fireEvent.click(screen.getByRole('button', { name: 'Conferma' }))

        await waitFor(() => expect(postSu('/coda/azioni').length).toBe(1))
        expect(JSON.parse(String(postSu('/coda/azioni')[0].init?.body))).toEqual({ azione: 'togli', ids: [VOCE_A] })
    })

    it('se TUTTE le voci sono di altre sedi, la barra delle azioni di massa non compare', async () => {
        code = [risposta({ voci: [voce({ id: VOCE_B, pagamento_id: PAGAMENTO_B, stato: 'errore', propria: false })] })]
        render(<CodaFatturePanel userId={UTENTE} ruolo="segreteria" />)

        await screen.findByTestId(`coda-fattura-${VOCE_B}`)
        expect(screen.queryByRole('checkbox', { name: 'Seleziona tutto' })).toBeNull()
    })

    it('«Sospendi coda»: solo l’admin la vede, conferma, e la POST porta `sospesa:true`', async () => {
        code = [risposta(), risposta({ stato: { sospesa: true, sospesa_il: null, pausa_fino_a: null, pausa_motivo: null, ultimo_giro_il: null } })]
        render(<CodaFatturePanel userId={UTENTE} ruolo="admin" />)

        const sospendi = await screen.findByRole('button', { name: 'Sospendi coda' })
        fireEvent.click(sospendi)
        await screen.findByRole('heading', { name: 'Sospendere la coda?' })
        fireEvent.click(screen.getByRole('button', { name: 'Conferma' }))

        await waitFor(() => expect(postSu('/coda/sospensione').length).toBe(1))
        expect(JSON.parse(String(postSu('/coda/sospensione')[0].init?.body))).toEqual({ sospesa: true })
        await screen.findByText('Coda sospesa: nessun invio in corso.')
    })

    it('un’operazione rifiutata dal server mostra l’errore e NON tocca la selezione', async () => {
        code = [risposta({ voci: [voce({ id: VOCE_A, stato: 'errore' })] })]
        azioneEsito = { ok: false, body: { error: 'Non più in errore: qualcun altro l’ha già ripresa in mano.' } }
        render(<CodaFatturePanel userId={UTENTE} ruolo="segreteria" />)

        const riga = await screen.findByTestId(`coda-fattura-${VOCE_A}`)
        fireEvent.click(within(riga).getByRole('checkbox'))
        fireEvent.click(screen.getByRole('button', { name: 'Togli' }))
        await screen.findByRole('heading', { name: 'Togliere dalla coda?' })
        fireEvent.click(screen.getByRole('button', { name: 'Conferma' }))

        await screen.findByRole('alert')
        expect(screen.getByRole('alert').textContent).toContain('qualcun altro l’ha già ripresa in mano')
    })
})

describe('CodaFatturePanel — il polling si ferma a scheda nascosta (nucleo §4)', () => {
    it('a scheda visibile ricarica da sola dopo 20 s; a scheda nascosta no', async () => {
        vi.useFakeTimers()
        code = [risposta(), risposta(), risposta()]
        render(<CodaFatturePanel userId={UTENTE} ruolo="segreteria" />)

        await vi.waitFor(() => expect(chiamate.filter((c) => c.url.endsWith('/api/pagamenti/fattura/coda')).length).toBe(1))

        await vi.advanceTimersByTimeAsync(20_000)
        expect(chiamate.filter((c) => c.url.endsWith('/api/pagamenti/fattura/coda')).length).toBe(2)

        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
        document.dispatchEvent(new Event('visibilitychange'))
        await vi.advanceTimersByTimeAsync(60_000)
        // Nascosta: l'orologio si è fermato, nessuna terza chiamata.
        expect(chiamate.filter((c) => c.url.endsWith('/api/pagamenti/fattura/coda')).length).toBe(2)

        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    })
})
