/**
 * L'APPELLO 0-6 SI ANNULLA, un bambino alla volta (spec 2026-09-24, punto 6).
 *
 * Cosa sorveglia questo file, dal lato della schermata (la rotta ha i suoi test in
 * `__tests__/api/attendance-daily-annulla-appello.test.ts`):
 *
 * 1. **«Annulla» compare solo dove ha senso**: data di OGGI (Roma) e appello FATTO
 *    dal personale (`registrato_da` valorizzato, o un salvataggio appena accettato).
 *    Non sulla sola comunicazione del genitore, non su un bambino da registrare,
 *    non su un giorno passato.
 * 2. **Chiede conferma**, e senza conferma non parte niente.
 * 3. **Chiama la DELETE giusta** (alunno e giorno in query) e applica l'ESITO:
 *    `cancellata` → di nuovo da registrare; `ripristinata-comunicazione` → torna
 *    l'assenza comunicata dal genitore, con il suo motivo.
 * 4. **Errori per codice**, e nessuna coda offline: senza rete si dice che serve
 *    la connessione, senza nemmeno chiedere la conferma.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'

vi.mock('@/lib/offline/db', () => ({}))

/**
 * `t` STABILE fra un render e l'altro, come quello vero di next-intl. Il mock
 * globale (test/setup.ts) ne crea uno nuovo a ogni render: qui `loadAll` dipende
 * da `t`, e con un `t` sempre nuovo l'effetto che carica l'appello ripartirebbe a
 * ogni render — migliaia di GET, e nessuna asserzione sul conteggio delle letture
 * avrebbe senso. I testi sono quelli VERI del catalogo italiano.
 */
vi.mock('next-intl', async () => {
    const { IntlMessageFormat } = await import('intl-messageformat')
    const cataloghi: Record<string, Record<string, string>> = {
        teacherPresenze: (await import('../../messages/it/teacherPresenze.json')).default,
        teacherPrimaria: (await import('../../messages/it/teacherPrimaria.json')).default,
    }
    const cache = new Map<string, unknown>()
    const useTranslations = (ns = '') => {
        if (!cache.has(ns)) {
            const t = (key: string, v?: Record<string, unknown>) => {
                const grezzo = cataloghi[ns]?.[key]
                if (grezzo == null) return `${ns}.${key}`
                return v ? String(new IntlMessageFormat(grezzo, 'it').format(v)) : grezzo
            }
            cache.set(ns, Object.assign(t, { rich: t, markup: t, raw: t, has: () => true }))
        }
        return cache.get(ns)
    }
    return {
        useTranslations,
        useLocale: () => 'it',
        useFormatter: () => ({ number: (v: unknown) => String(v), dateTime: (v: unknown) => String(v) }),
        NextIntlClientProvider: ({ children }: { children: unknown }) => children,
    }
})

// La rete si simula dove la legge l'hook vero: `navigator.onLine` + l'evento.
const rete = vi.hoisted(() => ({ online: true }))
Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => rete.online })

const logClient = vi.hoisted(() => vi.fn())
vi.mock('@/lib/logging/client', async (importOriginal) => {
    const vero = await importOriginal<typeof import('@/lib/logging/client')>()
    return { ...vero, logClient }
})

import { AppelloGiornaliero } from '@/components/features/teacher/attendance/AppelloGiornaliero'
import { StudentAttendanceRow } from '@/components/features/teacher/StudentAttendanceRow'

// Mezzogiorno UTC = le 14 a Roma: «oggi» è il 25 in ogni fuso ragionevole del
// runner, e la data di Roma coincide con quella locale che il navigatore mostra.
const OGGI = '2026-09-25'
const DOCENTE = '11111111-1111-4111-8111-111111111111'

const A_FATTO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const A_GENITORE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const A_VUOTO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'
const A_SOPRA_COMUNICAZIONE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4'

const STUDENTI = [
    { id: A_FATTO, nome: 'Bimbo', cognome: 'Uno' },
    { id: A_GENITORE, nome: 'Bimbo', cognome: 'Due' },
    { id: A_VUOTO, nome: 'Bimbo', cognome: 'Tre' },
    { id: A_SOPRA_COMUNICAZIONE, nome: 'Bimbo', cognome: 'Quattro' },
]

function righeDelGiorno(data: string) {
    return [
        { id: 'p-1', alunno_id: A_FATTO, data, stato: 'presente', orario_entrata: `${data}T07:30:00.000Z`, orario_uscita: null, registrato_da: DOCENTE },
        { id: 'p-2', alunno_id: A_GENITORE, data, stato: 'assente', orario_entrata: null, orario_uscita: null, registrato_da: null, giustificazione_testo: 'Motivo di prova' },
        { id: 'p-4', alunno_id: A_SOPRA_COMUNICAZIONE, data, stato: 'presente', orario_entrata: `${data}T07:40:00.000Z`, orario_uscita: null, registrato_da: DOCENTE, giustificazione_testo: 'Motivo del genitore' },
    ]
}

type Risposta = { status: number; body: unknown } | 'rete-giu'
const h = {
    chiamate: [] as { url: string; method: string }[],
    righe: (data: string): unknown[] => righeDelGiorno(data),
    risposteDelete: [] as Risposta[],
    rispostaPost: { status: 200, body: {} } as { status: number; body: unknown },
}

function risposta(status: number, body: unknown) {
    return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response)
}

const fetchFinto = vi.fn((input: string, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    h.chiamate.push({ url, method })
    if (url.startsWith('/api/diary/students')) return risposta(200, STUDENTI)
    if (url.startsWith('/api/attendance/delegates')) return risposta(200, [])
    if (url.startsWith('/api/attendance/daily')) {
        if (method === 'GET') {
            const data = new URL(url, 'http://x').searchParams.get('data') ?? OGGI
            return risposta(200, h.righe(data))
        }
        if (method === 'DELETE') {
            const r = h.risposteDelete.shift()
            if (!r || r === 'rete-giu') return Promise.reject(new TypeError('Failed to fetch'))
            return risposta(r.status, r.body)
        }
        if (method === 'POST') return risposta(h.rispostaPost.status, h.rispostaPost.body)
    }
    return risposta(404, {})
})

let conferma: ReturnType<typeof vi.spyOn>

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(`${OGGI}T12:00:00.000Z`))
    rete.online = true
    h.chiamate = []
    h.righe = righeDelGiorno
    h.risposteDelete = []
    fetchFinto.mockClear()
    logClient.mockClear()
    vi.stubGlobal('fetch', fetchFinto)
    conferma = vi.spyOn(window, 'confirm').mockReturnValue(true)
})

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    conferma.mockRestore()
})

async function monta() {
    render(<AppelloGiornaliero sezione="Sezione prova" sectionId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" />)
    // Si aspetta la PRESENZA dei dati (il primo bambino con l'appello fatto),
    // non l'assenza dello spinner.
    await screen.findByText('Bimbo Uno')
    await waitFor(() => expect(document.querySelector(`#btn-presente-${A_FATTO}`)?.getAttribute('aria-pressed')).toBe('true'))
}

const bottoneAnnulla = (id: string) => document.querySelector(`#btn-annulla-appello-${id}`) as HTMLButtonElement | null
const chiamateDelete = () => h.chiamate.filter((c) => c.method === 'DELETE')
const chiamateGetAppello = () => h.chiamate.filter((c) => c.method === 'GET' && c.url.startsWith('/api/attendance/daily'))

describe('dove compare «Annulla»', () => {
    it('sull\'appello FATTO di oggi sì, con icona, testo e nome accessibile che dice di chi', async () => {
        await monta()
        const b = bottoneAnnulla(A_FATTO)
        expect(b).toBeTruthy()
        expect(b!.textContent).toContain('Annulla')
        expect(b!.querySelector('svg')).toBeTruthy()
        expect(b!.getAttribute('aria-label')).toBe('Annulla l’appello di Bimbo Uno')
        expect(screen.getByRole('button', { name: 'Annulla l’appello di Bimbo Uno' })).toBe(b)
    })

    it('sulla SOLA comunicazione del genitore no — e la riga dice che è del genitore', async () => {
        await monta()
        expect(bottoneAnnulla(A_GENITORE)).toBeNull()
        expect(document.querySelector(`#btn-assente-${A_GENITORE}`)?.getAttribute('aria-pressed')).toBe('true')
        expect(screen.getAllByText('Assenza comunicata dal genitore')).toHaveLength(1)
    })

    it('su un bambino ancora da registrare no', async () => {
        await monta()
        expect(bottoneAnnulla(A_VUOTO)).toBeNull()
    })

    it('su un giorno passato no, anche se l\'appello era stato fatto', async () => {
        await monta()
        expect(bottoneAnnulla(A_FATTO)).toBeTruthy()
        fireEvent.click(screen.getByTitle('Giorno precedente'))
        await waitFor(() =>
            expect(chiamateGetAppello().some((c) => c.url.includes('data=2026-09-24'))).toBe(true),
        )
        await waitFor(() => expect(document.querySelector(`#btn-presente-${A_FATTO}`)?.getAttribute('aria-pressed')).toBe('true'))
        expect(bottoneAnnulla(A_FATTO)).toBeNull()
        expect(bottoneAnnulla(A_SOPRA_COMUNICAZIONE)).toBeNull()
        // E sui giorni passati `registrato_da` null non basta a dire «comunicazione del
        // genitore»: le righe 0-6 prima di agosto non lo portavano mai.
        expect(screen.queryByText('Assenza comunicata dal genitore')).toBeNull()
    })

    it('dopo un salvataggio accettato compare anche su chi era da registrare', async () => {
        h.rispostaPost = {
            status: 200,
            body: { id: 'p-3', alunno_id: A_VUOTO, data: OGGI, stato: 'presente', orario_entrata: `${OGGI}T08:00:00.000Z`, orario_uscita: null },
        }
        await monta()
        expect(bottoneAnnulla(A_VUOTO)).toBeNull()
        fireEvent.click(document.querySelector(`#btn-presente-${A_VUOTO}`)!)
        await waitFor(() => expect(bottoneAnnulla(A_VUOTO)).toBeTruthy())
    })

    it('la riga montata SENZA `onAnnulla` non mostra il comando, nemmeno su un appello fatto', () => {
        render(
            <StudentAttendanceRow
                student={{ id: 's-1', firstName: 'Bimbo', lastName: 'Solo' }}
                record={{ alunno_id: 's-1', data: OGGI, stato: 'presente', orario_entrata: null, orario_uscita: null, appelloFatto: true }}
                onSetStato={vi.fn()}
                onCheckoutClick={vi.fn()}
            />,
        )
        expect(bottoneAnnulla('s-1')).toBeNull()
    })
})

describe('la conferma', () => {
    it('chiede «riportare a da registrare» nominando il bambino, e senza conferma non chiama niente', async () => {
        conferma.mockReturnValue(false)
        await monta()
        fireEvent.click(bottoneAnnulla(A_FATTO)!)
        expect(conferma).toHaveBeenCalledWith('Bimbo Uno: riportare il bambino a «da registrare»?')
        expect(chiamateDelete()).toHaveLength(0)
        expect(document.querySelector(`#btn-presente-${A_FATTO}`)?.getAttribute('aria-pressed')).toBe('true')
    })
})

describe('gli esiti', () => {
    it('`cancellata`: DELETE con alunno e giorno, e il bambino torna «da registrare»', async () => {
        h.risposteDelete.push({ status: 200, body: { success: true, esito: 'cancellata', presenza: null } })
        await monta()
        fireEvent.click(bottoneAnnulla(A_FATTO)!)

        await screen.findByText('Appello annullato per Bimbo Uno: è di nuovo da registrare.')
        const [del] = chiamateDelete()
        const u = new URL(del.url, 'http://x')
        expect(u.pathname).toBe('/api/attendance/daily')
        expect(u.searchParams.get('alunno_id')).toBe(A_FATTO)
        expect(u.searchParams.get('data')).toBe(OGGI)

        // Nessuno stato premuto, nessun comando di annullamento: è di nuovo da registrare.
        for (const s of ['presente', 'ritardo', 'assente']) {
            expect(document.querySelector(`#btn-${s}-${A_FATTO}`)?.getAttribute('aria-pressed')).toBe('false')
        }
        expect(bottoneAnnulla(A_FATTO)).toBeNull()
        // …e il filtro «Da registrare» lo conta: A_VUOTO + A_FATTO.
        fireEvent.click(screen.getByRole('button', { name: /Da registrare/ }))
        expect(screen.getByText('Bimbo Uno')).toBeTruthy()
        expect(screen.getByText('Bimbo Tre')).toBeTruthy()
        expect(screen.queryByText('Bimbo Quattro')).toBeNull()
    })

    it('`ripristinata-comunicazione`: torna l\'assenza del genitore, con il suo motivo', async () => {
        h.risposteDelete.push({
            status: 200,
            body: {
                success: true,
                esito: 'ripristinata-comunicazione',
                presenza: { id: 'p-4', alunno_id: A_SOPRA_COMUNICAZIONE, data: OGGI, stato: 'assente', orario_entrata: null, orario_uscita: null },
            },
        })
        await monta()
        expect(document.querySelector(`#btn-presente-${A_SOPRA_COMUNICAZIONE}`)?.getAttribute('aria-pressed')).toBe('true')
        fireEvent.click(bottoneAnnulla(A_SOPRA_COMUNICAZIONE)!)

        await screen.findByText('Appello annullato per Bimbo Quattro: resta l’assenza comunicata dal genitore.')
        expect(document.querySelector(`#btn-assente-${A_SOPRA_COMUNICAZIONE}`)?.getAttribute('aria-pressed')).toBe('true')
        expect(document.querySelector(`#btn-presente-${A_SOPRA_COMUNICAZIONE}`)?.getAttribute('aria-pressed')).toBe('false')
        // L'etichetta della comunicazione ora c'è su DUE righe: A_GENITORE e questa.
        expect(screen.getAllByText('Assenza comunicata dal genitore')).toHaveLength(2)
        // Il motivo non viaggia nella risposta: resta quello già in mano alla riga.
        expect(screen.getByText('Motivo del genitore')).toBeTruthy()
        // Niente orario d'ingresso su un'assenza, e niente più «Annulla».
        expect(document.querySelector(`#btn-orario-entrata-${A_SOPRA_COMUNICAZIONE}`)).toBeNull()
        expect(bottoneAnnulla(A_SOPRA_COMUNICAZIONE)).toBeNull()
    })
})

describe('gli errori, per codice', () => {
    it.each([
        ['APPELLO_ANNULLA_SOLO_OGGI', 409, 'L’appello si può annullare solo nel giorno stesso.', false],
        ['NIENTE_DA_ANNULLARE', 409, 'C’è solo la comunicazione del genitore: l’appello non è stato fatto, non c’è niente da annullare.', true],
        ['APPELLO_CAMBIATO_NEL_FRATTEMPO', 409, 'La presenza è cambiata nel frattempo: l’elenco è stato aggiornato, riprova.', true],
        ['PRESENZA_NON_TROVATA', 404, 'Per questo bambino non c’è un appello da annullare: l’elenco è stato aggiornato.', true],
    ])('%s → messaggio suo%s', async (codice, status, testo, rilegge) => {
        h.risposteDelete.push({ status, body: { error: 'testo del server che non si mostra', codice } })
        await monta()
        const letturePrima = chiamateGetAppello().length
        fireEvent.click(bottoneAnnulla(A_FATTO)!)

        const avviso = await screen.findByRole('alert')
        expect(avviso.textContent).toBe(testo)
        expect(screen.queryByText('testo del server che non si mostra')).toBeNull()
        if (rilegge) {
            await waitFor(() => expect(chiamateGetAppello().length).toBe(letturePrima + 1))
        } else {
            expect(chiamateGetAppello().length).toBe(letturePrima)
        }
        // La riga non cambia su un rifiuto.
        expect(document.querySelector(`#btn-presente-${A_FATTO}`)?.getAttribute('aria-pressed')).toBe('true')
        expect(logClient).toHaveBeenCalledWith(expect.objectContaining({
            messaggio: 'appello-annullamento-rifiutato',
            stato: status,
            // `error_code`, la chiave che la redazione lascia in chiaro: con
            // `codice` il perché del rifiuto usciva redatto da app_log.
            campi: { error_code: codice },
        }))
    })

    it('un codice sconosciuto (o un 500) dà il messaggio generico, mai il testo del server', async () => {
        h.risposteDelete.push({ status: 500, body: { error: 'Errore interno del server.' } })
        await monta()
        fireEvent.click(bottoneAnnulla(A_FATTO)!)
        const avviso = await screen.findByRole('alert')
        expect(avviso.textContent).toBe('Non sono riuscito ad annullare l’appello. Riprova.')
        expect(logClient).toHaveBeenCalledWith(expect.objectContaining({
            livello: 'error',
            stato: 500,
            campi: { error_code: 'senza-codice' },
        }))
    })

    it('un 200 senza `esito` riconoscibile: logga l\'anomalia e rilegge l\'appello, senza inventare la riga', async () => {
        h.risposteDelete.push({ status: 200, body: { success: true } })
        await monta()
        const letturePrima = chiamateGetAppello().length
        fireEvent.click(bottoneAnnulla(A_FATTO)!)

        await waitFor(() => expect(chiamateGetAppello().length).toBe(letturePrima + 1))
        expect(chiamateDelete()).toHaveLength(1)
        expect(logClient).toHaveBeenCalledWith(expect.objectContaining({
            livello: 'warn',
            messaggio: 'appello-annullamento-esito-sconosciuto',
            stato: 200,
            campi: { esito: 'assente' },
        }))
        // La riga non è stata toccata in locale: la rilettura restituisce l'appello fatto.
        await waitFor(() => expect(document.querySelector(`#btn-presente-${A_FATTO}`)?.getAttribute('aria-pressed')).toBe('true'))
    })

    it('un 200 con un `esito` che la schermata non conosce: il log dice QUALE', async () => {
        h.risposteDelete.push({ status: 200, body: { success: true, esito: 'esito-futuro' } })
        await monta()
        fireEvent.click(bottoneAnnulla(A_FATTO)!)
        await waitFor(() => expect(logClient).toHaveBeenCalledWith(expect.objectContaining({
            messaggio: 'appello-annullamento-esito-sconosciuto',
            campi: { esito: 'esito-futuro' },
        })))
    })
})

describe('niente coda offline', () => {
    it('offline: dice che serve la connessione, senza chiedere conferma e senza chiamare', async () => {
        await monta()
        rete.online = false
        act(() => { window.dispatchEvent(new Event('offline')) })
        await screen.findByText('Offline')
        fireEvent.click(bottoneAnnulla(A_FATTO)!)
        const avviso = await screen.findByRole('alert')
        expect(avviso.textContent).toBe('Per annullare l’appello serve la connessione: riprova quando sei di nuovo online.')
        expect(conferma).not.toHaveBeenCalled()
        expect(chiamateDelete()).toHaveLength(0)
        expect(document.querySelector(`#btn-presente-${A_FATTO}`)?.getAttribute('aria-pressed')).toBe('true')
    })

    it('la rete che cade durante la richiesta: stesso messaggio, e la riga resta com\'era', async () => {
        h.risposteDelete.push('rete-giu')
        await monta()
        fireEvent.click(bottoneAnnulla(A_FATTO)!)
        const avviso = await screen.findByRole('alert')
        expect(avviso.textContent).toBe('Per annullare l’appello serve la connessione: riprova quando sei di nuovo online.')
        expect(chiamateDelete()).toHaveLength(1)
        expect(document.querySelector(`#btn-presente-${A_FATTO}`)?.getAttribute('aria-pressed')).toBe('true')
        expect(logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', messaggio: expect.stringContaining('appello-annullamento-fallito') }))
    })
})
