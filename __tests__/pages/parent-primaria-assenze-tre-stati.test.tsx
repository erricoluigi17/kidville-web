import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'

import itPrimaria from '../../messages/it/parentPrimaria.json'
import itAssenze from '../../messages/it/parentAssenze.json'

/**
 * LOCK · /parent/primaria/assenze ha TRE stati, e li dichiara tutti.
 *
 * ─── PERCHÉ ESISTE ───────────────────────────────────────────────────────────
 * Il terzo collaudo (2026-08-08) ha misurato due guasti MUTI sulla stessa
 * schermata, nati dallo stesso `carica()`:
 *
 *  · F1 — il genitore senza alunno risolto resta su «Caricamento…» PER SEMPRE.
 *    Misura letterale: a +5s, +15s, +30s e +45s la pagina è ancora quella, con
 *    zero errori in console. `carica()` esce con un `return` PRIMA del fetch, e
 *    lo spegnimento dell'attesa vive solo nel `.finally()` della catena: su quel
 *    ramo non gira mai. Il render è `{loading ? … : <tutto il resto>}`, quindi
 *    l'attesa infinita si porta via anche la card «Comunica un'assenza» — cioè
 *    la funzione che questo ciclo esiste per riparare.
 *
 *  · F2 — una lettura FALLITA si traveste da «nessuna assenza»: quattro zeri nei
 *    riquadri e «Nessuna assenza, ritardo o uscita anticipata da segnalare.»,
 *    senza un messaggio d'errore né un «Riprova». È la stessa forma del difetto
 *    che questo ciclo ha già chiuso tre volte nelle route — «non c'è» e «non
 *    l'ho potuto leggere» sono due cose diverse — ricomparsa nel client. Con la
 *    rete giù lasciava anche una promise rifiutata e NON gestita (AGENTS.md §6).
 *
 * ─── COSA CONTROLLA ──────────────────────────────────────────────────────────
 *  1. identità risolta SENZA alunno → la pagina lo DICE e smette di aspettare;
 *  2. lettura rifiutata (500) o caduta (rete) → messaggio + «Riprova», e nessun
 *     conteggio inventato: `riepilogo === null` non è «zero»;
 *  3. la card «Comunica un'assenza» è montata anche mentre la cronologia si
 *     carica: l'azione non dipende dall'elenco;
 *  4. i controlli positivi — il percorso sano continua a mostrare conteggi ed
 *     elenco — perché un lock che è verde anche su una pagina vuota non difende
 *     niente.
 */

const stub = vi.hoisted(() => ({
    pathname: '/parent/primaria/assenze',
    params: new URLSearchParams(),
    router: { push: () => {}, replace: () => {}, refresh: () => {} },
}))

vi.mock('next/navigation', () => ({
    usePathname: () => stub.pathname,
    useSearchParams: () => stub.params,
    useRouter: () => stub.router,
}))

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
        ready: identita.ready,
    }),
}))

const logClientMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/logging/client', () => ({
    logClient: logClientMock,
    nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'Error'),
}))

/** next-intl coi cataloghi VERI, `parentAssenze` compreso (non è in test/setup). */
vi.mock('next-intl', async () => {
    const cataloghi: Record<string, Record<string, string>> = {
        parentPrimaria: (await import('../../messages/it/parentPrimaria.json')).default,
        parentServizi: (await import('../../messages/it/parentServizi.json')).default,
        parentAssenze: (await import('../../messages/it/parentAssenze.json')).default,
        shared: (await import('../../messages/it/shared.json')).default,
    }
    const risolvi = (ns: string | undefined, key: string): string =>
        (ns ? cataloghi[ns]?.[key] : undefined) ?? (ns ? `${ns}.${key}` : key)
    const rendi = (modello: string, valori: Record<string, unknown> = {}): string =>
        modello.replace(/\{(\w+)\}/g, (intero, k: string) => (k in valori ? String(valori[k]) : intero))
    const useTranslations = (ns?: string) => {
        const t = (key: string, valori?: Record<string, unknown>) => rendi(risolvi(ns, key), valori)
        return Object.assign(t, { rich: t, markup: t, raw: (k: string) => risolvi(ns, k), has: () => true })
    }
    return {
        useTranslations,
        useLocale: () => 'it',
        useFormatter: () => ({ number: (v: unknown) => String(v), dateTime: (v: unknown) => String(v) }),
        NextIntlClientProvider: ({ children }: { children: unknown }) => children,
    }
})

import AssenzeGenitorePage from '@/app/(dashboard)/parent/primaria/assenze/page'

const CRONOLOGIA = [
    {
        id: 'pr-1',
        data: '2026-06-02',
        stato: 'assente',
        orario_entrata: null,
        orario_uscita: null,
        giustificata: true,
        giustificazione_testo: null,
        giustificata_il: '2026-06-03T08:00:00Z',
        note_appello: null,
    },
]

type EsitoCronologia =
    | { tipo: 'ok' }
    | { tipo: 'http'; status: number }
    | { tipo: 'rete' }
    /** Il caso sospeso: la GET non risponde mai (rete lenta, 3G, avvio nativo). */
    | { tipo: 'appesa' }

let esitoCronologia: EsitoCronologia
const fetchMock = vi.fn()

beforeEach(() => {
    vi.clearAllMocks()
    identita.parentId = 'p-1'
    identita.studentId = 's-1'
    identita.ready = true
    esitoCronologia = { tipo: 'ok' }
    fetchMock.mockImplementation((url: string) => {
        if (url.includes('/api/parent/primaria/assenze')) {
            if (esitoCronologia.tipo === 'rete') return Promise.reject(new TypeError('Failed to fetch'))
            if (esitoCronologia.tipo === 'appesa') return new Promise(() => {})
            if (esitoCronologia.tipo === 'http') {
                const status = esitoCronologia.status
                return Promise.resolve({ ok: false, status, json: async () => ({ error: 'Errore interno' }) })
            }
            return Promise.resolve({
                ok: true,
                status: 200,
                json: async () => ({
                    success: true,
                    data: CRONOLOGIA,
                    riepilogo: { presente: 120, assente: 3, ritardo: 1, uscita_anticipata: 0 },
                }),
            })
        }
        if (url.includes('/api/parent/presenze')) {
            return Promise.resolve({
                ok: true,
                status: 200,
                json: async () => ({ success: true, data: { comunicate: [], comunicateLette: true } }),
            })
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) })
    })
    vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => cleanup())

describe('F1 · il genitore senza alunno non resta su «Caricamento…» per sempre', () => {
    it('CONTROLLO POSITIVO: col figlio risolto la pagina arriva ai contenuti', async () => {
        render(<AssenzeGenitorePage />)
        expect(await screen.findByText('120')).toBeInTheDocument()
        expect(screen.getByText(itPrimaria.assenzeSezioneTitolo)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: itPrimaria.comunicaApri })).toBeInTheDocument()
    })

    it('identità risolta SENZA alunno: lo dichiara, invece di aspettare all’infinito', async () => {
        identita.studentId = null
        render(<AssenzeGenitorePage />)

        const avviso = await screen.findByText(itAssenze.nessunAlunno)
        expect(avviso.closest('[role="alert"],[role="status"]')).toBeTruthy()
        expect(
            screen.queryAllByText(itPrimaria.caricamento),
            'la pagina resta su «Caricamento…» per un genitore che non avrà mai un elenco: ' +
                'un caricamento senza fine è peggio di nessun caricamento, perché non dichiara niente',
        ).toEqual([])
        // …e nessuna lettura al buio: senza alunno non c'è niente da chiedere.
        expect(
            (fetchMock.mock.calls as [string][]).filter(([u]) => u.includes('/api/parent/primaria/assenze')),
        ).toHaveLength(0)
    })

    it('identità ANCORA da risolvere: quello sì che è un caricamento, e resta', async () => {
        identita.ready = false
        identita.studentId = null
        render(<AssenzeGenitorePage />)
        expect((await screen.findAllByText(itPrimaria.caricamento)).length).toBeGreaterThan(0)
        expect(screen.queryByText(itAssenze.nessunAlunno)).not.toBeInTheDocument()
    })

    it('la card «Comunica un’assenza» c’è anche mentre la cronologia si carica', async () => {
        esitoCronologia = { tipo: 'appesa' }
        render(<AssenzeGenitorePage />)

        expect(
            await screen.findByRole('button', { name: itPrimaria.comunicaApri }),
            'l’azione principale sta dentro il ramo `else` di `loading`: su rete lenta il genitore ' +
                'non la vede affatto, mentre la schermata gemella mostra il modulo dal primo frame',
        ).toBeInTheDocument()
        expect(screen.getByText(itPrimaria.caricamento)).toBeInTheDocument()
    })
})

describe('F2 · una lettura fallita non si traveste da «nessuna assenza»', () => {
    it('500: messaggio d’errore e «Riprova», non l’elenco vuoto', async () => {
        esitoCronologia = { tipo: 'http', status: 500 }
        render(<AssenzeGenitorePage />)

        const errore = await screen.findByText(itAssenze.cronologiaNonLetta)
        expect(errore.closest('[role="alert"]'), 'l’errore non è annunciato').toBeTruthy()
        expect(screen.getByRole('button', { name: itAssenze.riprova })).toBeInTheDocument()
        expect(
            screen.queryByText(itPrimaria.assenzeVuoto),
            '«Nessuna assenza… da segnalare» detto quando la lettura è fallita è la stessa bugia ' +
                'che le route hanno appena smesso di dire',
        ).not.toBeInTheDocument()
    })

    it('500: niente quattro zeri — `riepilogo === null` non è «zero»', async () => {
        esitoCronologia = { tipo: 'http', status: 500 }
        render(<AssenzeGenitorePage />)
        await screen.findByText(itAssenze.cronologiaNonLetta)

        // Non si cerca l'etichetta («Presenze» è anche il titolo della pagina):
        // si cercano i NUMERI, che sono la cosa che mente.
        expect(
            screen.queryAllByText('0').map((n) => n.textContent),
            'i riquadri stampano 0/0/0/0 su un riepilogo mai letto: quattro numeri inventati, e ' +
                'dicono «tuo figlio non è mai mancato» quando la verità è «non lo so»',
        ).toEqual([])
    })

    it('rete giù: nessuna promise rifiutata e non gestita, e una riga di log', async () => {
        const rifiuti: unknown[] = []
        const cattura = (e: PromiseRejectionEvent) => { rifiuti.push(e.reason); e.preventDefault() }
        window.addEventListener('unhandledrejection', cattura)
        esitoCronologia = { tipo: 'rete' }
        try {
            render(<AssenzeGenitorePage />)
            await screen.findByText(itAssenze.cronologiaNonLetta)
            await waitFor(() => expect(logClientMock).toHaveBeenCalled())
            await new Promise((r) => setTimeout(r, 0))
            expect(rifiuti, 'la catena non ha nessun `.catch`: la rete caduta esce come rifiuto non gestito').toEqual([])
        } finally {
            window.removeEventListener('unhandledrejection', cattura)
        }
    })

    it('uno stato che il catalogo non conosce non arriva a schermo come identificatore', async () => {
        esitoCronologia = { tipo: 'ok' }
        CRONOLOGIA.push({ ...CRONOLOGIA[0], id: 'pr-ignoto', stato: 'stato_ignoto_nuovo' })
        try {
            render(<AssenzeGenitorePage />)
            await screen.findByText('120')
            expect(
                screen.queryByText('stato_ignoto_nuovo'),
                'il giorno in cui il backend aggiunge uno stato, il genitore legge il nome della ' +
                    'colonna del database dentro una pillola colorata',
            ).not.toBeInTheDocument()
            expect(screen.getByText(itAssenze.statoSconosciuto)).toBeInTheDocument()
        } finally {
            CRONOLOGIA.pop()
        }
    })

    it('«Riprova» rilegge davvero, e il contenuto torna', async () => {
        esitoCronologia = { tipo: 'http', status: 500 }
        render(<AssenzeGenitorePage />)
        const riprova = await screen.findByRole('button', { name: itAssenze.riprova })

        esitoCronologia = { tipo: 'ok' }
        riprova.click()

        expect(await screen.findByText('120')).toBeInTheDocument()
        expect(screen.queryByText(itAssenze.cronologiaNonLetta)).not.toBeInTheDocument()
    })
})
