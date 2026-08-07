import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

// =============================================================================
// LA STESSA FUNZIONE, DISEGNATA DUE VOLTE.
//
// «Assenze già comunicate» + il comando che le ritira è nato nel ciclo 1 in
// ENTRAMBE le schermate del genitore — `/parent/attendance` (nido e infanzia) e
// la card montata in `/parent/primaria/assenze` — e in nessuna delle due
// importa dall'altra. Risultato, misurato dal collaudo del 2026-08-07:
//
//   riga:      raggio 12px con bordo   VS  raggio 16px senza bordo
//   comando:   `danger` (rosso)        VS  `ghost` (verde) con una X
//              → due colori OPPOSTI per la stessa azione distruttiva
//   data:      «12/08/2026»            VS  «mercoledì 19 agosto» (senza anno)
//
// Il genitore che passa dalla schermata della primaria a quella dell'infanzia —
// e con due figli di grado diverso ci passa ogni giorno — trova la stessa
// funzione con due linguaggi visivi diversi, e un comando distruttivo dipinto
// una volta di rosso e una di verde.
//
// Questo file NON confronta le classi ricopiate a mano: monta i DUE alberi veri
// con lo STESSO giorno e confronta ciò che il genitore vede.
// =============================================================================

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

vi.mock('@/lib/auth/use-parent-identity', () => ({
    useParentIdentity: () => ({ parentId: 'p-1', studentId: 's-1', figliIds: ['s-1'], ready: true }),
}))

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Error' }))

/** next-intl con interpolazione VERA: i due `aria-label` devono dire il giorno. */
vi.mock('next-intl', async () => {
    const cataloghi: Record<string, Record<string, string>> = {
        parentServizi: (await import('../../messages/it/parentServizi.json')).default,
        parentPrimaria: (await import('../../messages/it/parentPrimaria.json')).default,
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

/** Lo STESSO giorno in entrambe le schermate: è il confronto che conta. */
const GIORNO = '2026-08-12'
const COMUNICATE = [{ id: 'pr-1', data: GIORNO, giustificazione_testo: 'Visita medica', stato: 'assente' }]

const fetchMock = vi.fn()

beforeEach(() => {
    vi.clearAllMocks()
    fetchMock.mockImplementation(() =>
        Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
                success: true,
                data: { comunicate: COMUNICATE, comunicateLette: true },
            }),
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => cleanup())

/** La riga «assenza comunicata» e il suo comando, in una delle due schermate. */
async function riga(quale: 'attendance' | 'primaria') {
    if (quale === 'attendance') render(<ParentAttendancePage />)
    else render(<ComunicaAssenzaCard studentId="s-1" parentId="p-1" />)

    const bottone = await screen.findByRole('button', { name: /^Annulla l.assenza comunicata per/i })
    const li = bottone.closest('li')
    expect(li, `${quale}: il comando non è dentro una riga di elenco`).toBeTruthy()
    return { bottone, li: li! }
}

/** Le classi che decidono la FORMA della riga (raggio, contorno, riempimento). */
const forma = (el: Element) =>
    Array.from(el.classList)
        .filter((c) => /^(rounded-|border($|-)|bg-)/.test(c))
        .sort()

/** Le classi che decidono il LINGUAGGIO del bottone (variante `Btn`). */
const variante = (el: Element) =>
    Array.from(el.classList)
        .filter((c) => /^(bg-kidville-|text-kidville-|border($|-kidville-))/.test(c))
        .sort()

describe('le due schermate «assenze comunicate» parlano la stessa lingua', () => {
    it('CONTROLLO POSITIVO: entrambe montano davvero una riga con il suo comando', async () => {
        const a = await riga('attendance')
        expect(a.bottone.tagName).toBe('BUTTON')
        cleanup()
        const p = await riga('primaria')
        expect(p.bottone.tagName).toBe('BUTTON')
    })

    it('il comando distruttivo ha la STESSA variante — non rosso di qua e verde di là', async () => {
        const a = await riga('attendance')
        const varA = variante(a.bottone)
        cleanup()
        const p = await riga('primaria')
        const varP = variante(p.bottone)

        expect(
            varP,
            'La stessa azione — ritirare una comunicazione già mandata alla maestra — è ' +
                'dipinta con due colori opposti nelle due schermate. Un genitore con due figli ' +
                'di grado diverso le vede tutte e due.',
        ).toEqual(varA)
        // …e non è un pareggio al ribasso: resta la variante DISTRUTTIVA.
        expect(varA).toContain('bg-kidville-error-soft')
    })

    it('la riga ha la stessa FORMA: raggio, contorno e riempimento', async () => {
        const a = await riga('attendance')
        const formaA = forma(a.li)
        cleanup()
        const p = await riga('primaria')

        expect(
            forma(p.li),
            'Raggio, bordo o fondo diversi per la stessa riga: le due schermate sembrano ' +
                'due prodotti.',
        ).toEqual(formaA)
    })

    it('il GIORNO è scritto nello stesso formato, e porta l\'anno', async () => {
        const a = await riga('attendance')
        const testoA = a.li.querySelector('p')!.textContent!.trim()
        const ariaA = a.bottone.getAttribute('aria-label')!
        cleanup()
        const p = await riga('primaria')
        const testoP = p.li.querySelector('p')!.textContent!.trim()
        const ariaP = p.bottone.getAttribute('aria-label')!

        expect(
            testoP,
            'Lo stesso giorno è scritto in due modi diversi. E «mercoledì 12 agosto» non dice ' +
                'l\'ANNO: è il dato per cui la riga esiste, e senza il genitore non può ' +
                'accorgersi di aver comunicato l\'assenza per l\'anno sbagliato.',
        ).toBe(testoA)
        expect(testoA, 'il formato scelto deve contenere l\'anno').toContain('2026')
        // Il nome accessibile dice lo stesso giorno che si legge a schermo: chi
        // ascolta e chi guarda devono poter parlare della stessa riga.
        expect(ariaA).toContain(testoA)
        expect(ariaP).toContain(testoP)
    })

    it('la riga regge il telefono piccolo in ENTRAMBE (320px: va a capo, non tronca l\'anno)', async () => {
        // Il conto in pixel è nel commento del componente; qui si misura che le
        // quattro dichiarazioni che lo producono ci siano su tutte e due, invece
        // che su una sola come finora.
        for (const quale of ['attendance', 'primaria'] as const) {
            const { bottone, li } = await riga(quale)
            const colonna = li.querySelector('p')!.parentElement!
            expect(li.className, `${quale}: il <li> non va a capo`).toMatch(/(^|\s)flex-wrap(\s|$)/)
            expect(colonna.className, `${quale}: colonna senza base ipotetica`).toMatch(/(^|\s)basis-\S+(\s|$)/)
            expect(colonna.className, `${quale}: colonna con \`flex-1\` (base 0%)`).not.toMatch(/(^|\s)flex-1(\s|$)/)
            expect(bottone.className, `${quale}: il comando non è \`shrink-0\``).toMatch(/(^|\s)shrink-0(\s|$)/)
            cleanup()
        }
    })
})
