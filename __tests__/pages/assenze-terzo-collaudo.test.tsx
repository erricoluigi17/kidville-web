import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'

import itServizi from '../../messages/it/parentServizi.json'
import itPrimaria from '../../messages/it/parentPrimaria.json'
import itAssenze from '../../messages/it/parentAssenze.json'

/**
 * LOCK · i rilievi del TERZO collaudo sulle due schermate dell'assenza.
 *
 *  · T32 — su /parent/attendance il pulsante «Comunica assenza» resta ABILITATO
 *    quando l'identità è risolta ma non c'è nessun alunno, e premerlo non fa
 *    assolutamente nulla: nessuna richiesta, nessun messaggio, nessun
 *    cambiamento a schermo. Le due condizioni non coincidevano: il pulsante si
 *    spegneva su `!ready`, il gestore usciva su `!studentId`, e nel mezzo c'era
 *    uno stato in cui il comando SEMBRA pronto e non fa niente. È la stessa
 *    forma del difetto storico di questa funzione — «il pulsante non era rotto:
 *    non era mai stato collegato a niente».
 *
 *  · T18 — dalla pressione fino alla risposta del server il fuoco è su `<body>`
 *    e nulla viene annunciato (WCAG 4.1.3). Chrome sfoca l'elemento che React
 *    marca `disabled`: chi usa la tastiera riparte dall'inizio della pagina e
 *    chi ascolta sente silenzio, proprio durante l'attesa. Il ricovero del fuoco
 *    era stato scritto per l'ESITO; la PARTENZA era rimasta scoperta.
 *
 *  · T25 — svuotare il campo «Motivo» NON cancella più il motivo archiviato (è
 *    una scelta deliberata del server: una copia vecchia dell'app cancellava un
 *    dato sanitario senza che nessuno l'avesse chiesto), ma l'interfaccia
 *    dichiarava comunque «Assenza aggiornata». Il difetto è che l'app dice di
 *    aver fatto una cosa che non ha fatto: qui si misura che lo dica PRIMA.
 *
 *  · T1 — il pulsante reso `sticky` galleggia sopra il contenuto senza una
 *    superficie propria: alle misure di telefono più comuni copre per intero la
 *    nota GDPR sul motivo. Qui si misura che una superficie ci sia, e che la
 *    nota non sia più l'ultima cosa prima del comando.
 */

const stub = vi.hoisted(() => ({
    pathname: '/parent/attendance',
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

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Error' }))

vi.mock('next-intl', async () => {
    const cataloghi: Record<string, Record<string, string>> = {
        parentServizi: (await import('../../messages/it/parentServizi.json')).default,
        parentPrimaria: (await import('../../messages/it/parentPrimaria.json')).default,
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

import ParentAttendancePage from '@/app/(dashboard)/parent/attendance/page'
import { ComunicaAssenzaCard } from '@/components/features/parent/ComunicaAssenzaCard'

const OGGI = '2026-08-20'
let comunicate: Array<{ id: string; data: string; giustificazione_testo: string | null; stato: string }>
/** Trattiene la POST finché il test non la lascia andare: è l'ATTESA da misurare. */
let sbloccaPost: (() => void) | null = null

const fetchMock = vi.fn()

beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date('2026-08-20T10:00:00Z'))
    identita.parentId = 'p-1'
    identita.studentId = 's-1'
    identita.ready = true
    comunicate = []
    sbloccaPost = null
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        const metodo = init?.method ?? 'GET'
        if (metodo === 'POST' && url.includes('/comunica-assenza')) {
            if (sbloccaPost === null) {
                await new Promise<void>((res) => { sbloccaPost = res })
            }
            return { ok: true, status: 201, json: async () => ({ success: true }) }
        }
        if (metodo === 'DELETE') return { ok: true, status: 200, json: async () => ({ success: true }) }
        return {
            ok: true,
            status: 200,
            json: async () => ({ success: true, data: { comunicate, comunicateLette: true } }),
        }
    })
    vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => { cleanup(); vi.useRealTimers() })

/** Il pulsante d'invio della schermata dedicata, qualunque etichetta porti. */
const cta = () =>
    screen.getByRole('button', {
        name: new RegExp(`${itServizi.attendanceComunicaAssenza}|${itServizi.attendanceInvio}`, 'i'),
    })

describe('T32 · nessun alunno collegato: il comando non finge di funzionare', () => {
    it('CONTROLLO POSITIVO: col figlio risolto il pulsante è attivo e la POST parte', async () => {
        sbloccaPost = () => {}
        render(<ParentAttendancePage />)
        await screen.findByLabelText(itServizi.attendanceGiorno)
        expect(cta()).toBeEnabled()
        fireEvent.click(cta())
        await waitFor(() =>
            expect(
                (fetchMock.mock.calls as [string, RequestInit | undefined][]).filter(([, i]) => i?.method === 'POST'),
            ).toHaveLength(1),
        )
    })

    it('identità risolta SENZA alunno: il pulsante è spento e la schermata dice perché', async () => {
        identita.studentId = null
        render(<ParentAttendancePage />)
        await screen.findByLabelText(itServizi.attendanceGiorno)

        expect(
            cta(),
            'il gesto principale della schermata è un no-op silenzioso: nessuna POST, nessun ' +
                'messaggio, nessun cambiamento a schermo — ripetibile all’infinito',
        ).toBeDisabled()
        expect(
            screen.getByText(itAssenze.nessunAlunno),
            'un pulsante spento e senza spiegazione è solo un no-op più silenzioso',
        ).toBeInTheDocument()

        fireEvent.click(cta())
        expect(
            (fetchMock.mock.calls as [string, RequestInit | undefined][]).filter(([, i]) => i?.method === 'POST'),
        ).toHaveLength(0)
    })

    it('il motivo del blocco è LEGATO al pulsante (aria-describedby), non solo scritto accanto', async () => {
        identita.studentId = null
        render(<ParentAttendancePage />)
        await screen.findByLabelText(itServizi.attendanceGiorno)

        const ids = (cta().getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
        expect(ids.length, 'il pulsante spento non rimanda a nessuna spiegazione').toBeGreaterThan(0)
        const testi = ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
        expect(testi).toContain(itAssenze.nessunAlunno)
    })

    it('col giorno vuoto la spiegazione parla del GIORNO, non dell’alunno', async () => {
        render(<ParentAttendancePage />)
        const campo = await screen.findByLabelText(itServizi.attendanceGiorno)
        fireEvent.change(campo, { target: { value: '' } })

        expect(cta()).toBeDisabled()
        expect(screen.getByText(itAssenze.giornoMancante)).toBeInTheDocument()
    })
})

describe('T18 · l’ATTESA si annuncia, e non porta via il fuoco', () => {
    it('mentre la POST è in volo il fuoco resta sul comando, non torna su <body>', async () => {
        render(<ParentAttendancePage />)
        await screen.findByLabelText(itServizi.attendanceGiorno)
        const bottone = cta()
        bottone.focus()
        expect(document.activeElement).toBe(bottone)

        fireEvent.click(bottone)
        await waitFor(() => expect(screen.getByText(itAssenze.invioInCorso)).toBeInTheDocument())

        expect(
            document.activeElement,
            'React marca il pulsante `disabled`, Chrome lo sfoca e il fuoco torna su <body>: chi ' +
                'naviga a Tab riparte dall’inizio della pagina proprio durante l’attesa',
        ).not.toBe(document.body)
        // Il comando resta un MESSAGGIO leggibile, non un controllo spento.
        expect(cta()).toHaveAttribute('aria-disabled', 'true')
        expect(cta()).toBeEnabled()

        sbloccaPost?.()
    })

    it('l’attesa è in una LIVE REGION: chi non vede la sente (WCAG 4.1.3)', async () => {
        render(<ParentAttendancePage />)
        await screen.findByLabelText(itServizi.attendanceGiorno)
        fireEvent.click(cta())

        const annuncio = await screen.findByText(itAssenze.invioInCorso)
        const live = annuncio.closest('[role="status"]')
        expect(live, 'lo stato di avanzamento è solo visivo: nessun ruolo, nessuna proprietà').toBeTruthy()
        expect(live!.closest('[aria-hidden="true"]'), 'la live region è dentro un ramo nascosto').toBeNull()

        sbloccaPost?.()
    })

    it('il modulo dichiara di essere occupato (aria-busy) finché la risposta non arriva', async () => {
        const { container } = render(<ParentAttendancePage />)
        await screen.findByLabelText(itServizi.attendanceGiorno)
        const form = container.querySelector('form')!
        expect(form.getAttribute('aria-busy')).not.toBe('true')

        fireEvent.click(cta())
        await waitFor(() => expect(form.getAttribute('aria-busy')).toBe('true'))

        sbloccaPost?.()
        await waitFor(() => expect(screen.queryByText(itAssenze.invioInCorso)).not.toBeInTheDocument())
    })

    it('due click di seguito producono UNA sola POST anche senza `disabled`', async () => {
        render(<ParentAttendancePage />)
        await screen.findByLabelText(itServizi.attendanceGiorno)
        fireEvent.click(cta())
        fireEvent.click(cta())
        fireEvent.click(cta())

        await waitFor(() => expect(screen.getByText(itAssenze.invioInCorso)).toBeInTheDocument())
        expect(
            (fetchMock.mock.calls as [string, RequestInit | undefined][]).filter(([, i]) => i?.method === 'POST'),
        ).toHaveLength(1)

        sbloccaPost?.()
    })

    it('anche l’ANNULLAMENTO annuncia la propria attesa', async () => {
        comunicate = [{ id: 'x-1', data: OGGI, giustificazione_testo: null, stato: 'assente' }]
        const attesaDelete: { sblocca: () => void } = { sblocca: () => {} }
        fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
            if ((init?.method ?? 'GET') === 'DELETE') {
                await new Promise<void>((res) => { attesaDelete.sblocca = res })
                return { ok: true, status: 200, json: async () => ({ success: true }) }
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({ success: true, data: { comunicate, comunicateLette: true } }),
            }
        })
        render(<ParentAttendancePage />)
        const annulla = await screen.findByRole('button', {
            name: new RegExp('^' + itServizi.attendanceAnnullaAria.split('{')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        })
        fireEvent.click(annulla)

        expect(await screen.findByText(itAssenze.annullamentoInCorso)).toBeInTheDocument()
        // …e la riga in volo non perde il fuoco: è un MESSAGGIO che lavora, non
        // un controllo spento. Il doppio invio lo impedisce la guardia del
        // gestore, non `disabled`.
        const inVolo = screen.getByRole('button', {
            name: new RegExp('^' + itServizi.attendanceAnnullaAria.split('{')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        })
        expect(inVolo, 'la riga in corso di annullamento è `disabled`: Chrome la sfoca').toBeEnabled()
        expect(inVolo).toHaveAttribute('aria-disabled', 'true')
        attesaDelete.sblocca()
    })
})

describe('T25 · svuotare il campo «Motivo» non cancella il motivo: e la schermata lo dice PRIMA', () => {
    beforeEach(() => {
        comunicate = [{ id: 'x-1', data: OGGI, giustificazione_testo: 'Visita medica', stato: 'assente' }]
    })

    it('CONTROLLO POSITIVO: finché il motivo archiviato è nel campo, nessun avviso', async () => {
        render(<ParentAttendancePage />)
        expect(await screen.findByDisplayValue('Visita medica')).toBeInTheDocument()
        expect(screen.queryByText(itAssenze.motivoNonCancellabile)).not.toBeInTheDocument()
    })

    it('svuotando il campo di un giorno che HA un motivo archiviato, la schermata avverte', async () => {
        render(<ParentAttendancePage />)
        const motivo = await screen.findByDisplayValue('Visita medica')
        fireEvent.change(motivo, { target: { value: '' } })

        const avviso = await screen.findByText(itAssenze.motivoNonCancellabile)
        expect(
            avviso,
            'l’app dichiara «Assenza aggiornata» dopo un invio che NON ha cancellato il motivo: ' +
                'un successo dichiarato senza verifica, su un dato dell’art. 9 GDPR di un minore',
        ).toBeInTheDocument()
        expect(avviso.closest('[role="status"],[role="alert"]')).toBeTruthy()
    })

    it('su un giorno SENZA motivo archiviato il campo vuoto non avverte di niente', async () => {
        comunicate = [{ id: 'x-1', data: OGGI, giustificazione_testo: null, stato: 'assente' }]
        render(<ParentAttendancePage />)
        const motivo = await screen.findByLabelText(itServizi.attendanceMotivo)
        fireEvent.change(motivo, { target: { value: 'febbre' } })
        fireEvent.change(motivo, { target: { value: '' } })
        expect(screen.queryByText(itAssenze.motivoNonCancellabile)).not.toBeInTheDocument()
    })

    it('la card della primaria dice la stessa cosa con le stesse parole', async () => {
        render(<ComunicaAssenzaCard studentId="s-1" parentId="p-1" />)
        fireEvent.click(await screen.findByRole('button', { name: itPrimaria.comunicaApri }))
        const motivo = await screen.findByDisplayValue('Visita medica')
        fireEvent.change(motivo, { target: { value: '' } })
        expect(await screen.findByText(itAssenze.motivoNonCancellabile)).toBeInTheDocument()
    })
})

describe('T1 · il comando che galleggia ha una superficie propria', () => {
    it('il ricovero `sticky` del pulsante dichiara un fondo opaco', async () => {
        render(<ParentAttendancePage />)
        await screen.findByLabelText(itServizi.attendanceGiorno)

        let ricovero: HTMLElement | null = cta().parentElement
        while (ricovero && !ricovero.className.split(/\s+/).includes('sticky')) {
            ricovero = ricovero.parentElement
        }
        expect(ricovero, 'il pulsante non sta più in un ricovero `sticky`').not.toBeNull()
        expect(
            ricovero!.className,
            'il pulsante galleggia sopra il modulo con il solo riempimento verde del bottone: ' +
                'senza una superficie sotto, ciò che passa sotto viene coperto A METÀ PAROLA — ' +
                'misurato, la nota GDPR sul motivo si legge «Il motivo lo leggono le insegnanti ' +
                'della se…» e il resto sparisce dentro la pillola verde',
        ).toMatch(/(^|\s)bg-kidville-\S+/)
    })

    /**
     * ⚠️ QUESTA PROVA È STATA RISCRITTA IL 2026-08-08, E LA VERSIONE PRIMA
     * PRETENDEVA IL CONTRARIO. Vale la pena dire perché, perché è la stessa
     * lezione tre volte.
     *
     * Chiedeva: «la nota sta SOPRA il campo, non nella fascia che il comando
     * copre». Era la correzione di T1, misurata a 390×844 (nota coperta 32px su
     * 32) e applicata alle 02:54. Il QUINTO collaudo, misurato alle 05:30 sulla
     * WebView a 390×731, l'ha ritrovata coperta lo stesso: link «Leggi
     * l'informativa» a y 592→607, piede sollevato a 568→659,
     * `elementFromPoint` sul suo centro = il pulsante, e un tocco reale che fa
     * partire la comunicazione invece di aprire l'informativa (R19).
     *
     * «Sopra il campo» non è un riparo: il piede appiccicato si SOLLEVA sopra
     * ciò che lo precede, e quanto copre dipende dallo scorrimento, non
     * dall'ordine dei nodi. Il riparo è UNO SOLO: stare dentro il piede.
     * La prova nuova è in `assenze-quarto-collaudo.test.tsx`, sezione R19; qui
     * resta ciò che T1 aveva ragione di pretendere e che vale ancora — che la
     * nota esista, e che resti legata al campo.
     */
    it('la nota sul trattamento del motivo esiste e resta legata al campo', async () => {
        const { container } = render(<ParentAttendancePage />)
        const campo = await screen.findByLabelText(itServizi.attendanceMotivo)
        const nota = container.querySelector('#attendance-nota-motivo')

        expect(nota, 'la nota GDPR è sparita dalla schermata').not.toBeNull()
        // Spostarla nel piede non deve romperne la descrizione: `aria-describedby`
        // lega a distanza, ed è ciò che la fa sentire a chi entra nel campo.
        expect((campo.getAttribute('aria-describedby') ?? '').split(/\s+/)).toContain('attendance-nota-motivo')
    })
})
