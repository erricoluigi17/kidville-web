import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

import itServizi from '../../messages/it/parentServizi.json'
import itPrimaria from '../../messages/it/parentPrimaria.json'
import itAssenze from '../../messages/it/parentAssenze.json'
import { MOTIVO_MAX_CARATTERI } from '@/lib/presenze/limiti-testo'
import { ETICHETTA_CAMPO_ASSENZA } from '@/lib/ui/campo-assenza'

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

    // =========================================================================
    // IL MODULO, non solo la riga d'elenco (collaudo del 2026-08-08, design F2).
    //
    // Il lock si fermava al `<li>` e al suo comando, e nel frattempo il MODULO
    // delle due schermate era divergente in tutto ciò che il genitore tocca per
    // primo. Misurato con `getComputedStyle` a 390px, stesso giorno, stesso
    // contenuto:
    //
    //   campo giorno  · raggio 9999px (pillola), 14px, alto 34px   ← card
    //                 · raggio 12px, 16px, alto 50px               ← pagina
    //   campo motivo  · `<input type="text">`, pillola, 34px       ← card
    //                 · `<textarea>` a quattro righe, 112px        ← pagina
    //
    // La pillola sui campi contraddice anche `design.md`: là la forma a pillola
    // è quella dei PULSANTI, e gli input sono dichiarati a 8 o 12px. E i 34px
    // erano il bersaglio di tocco più piccolo della schermata.
    // =========================================================================

    /** I due campi del modulo, in una delle due schermate. */
    async function modulo(quale: 'attendance' | 'primaria') {
        let giorno: HTMLElement
        let motivo: HTMLElement
        if (quale === 'attendance') {
            render(<ParentAttendancePage />)
            giorno = await screen.findByLabelText(itServizi.attendanceGiorno)
            motivo = screen.getByLabelText(itServizi.attendanceMotivo)
        } else {
            render(<ComunicaAssenzaCard studentId="s-1" parentId="p-1" />)
            fireEvent.click(await screen.findByRole('button', { name: itPrimaria.comunicaApri }))
            giorno = screen.getByLabelText(itPrimaria.comunicaDataLabel)
            motivo = screen.getByLabelText(itPrimaria.comunicaMotivoLabel)
        }
        // Lo STESSO giorno in entrambe — ed è un giorno già comunicato, così
        // compare anche l'avviso di sovrascrittura, che è la terza cosa da
        // confrontare.
        fireEvent.change(giorno, { target: { value: GIORNO } })
        return { giorno, motivo }
    }

    /** Il raggio dichiarato da una classe `rounded-*`. */
    const raggio = (el: Element) => el.className.split(/\s+/).find((c) => c.startsWith('rounded-')) ?? '(nessuno)'

    it('i due campi del modulo hanno la STESSA forma nelle due schermate', async () => {
        const a = await modulo('attendance')
        const formaA = { giorno: raggio(a.giorno), motivo: raggio(a.motivo) }
        cleanup()
        const p = await modulo('primaria')

        expect(
            raggio(p.giorno),
            'Il campo principale della funzione è una pillola di qua e un rettangolo di là. La ' +
                'pillola è la forma dei PULSANTI (design.md): su un campo dati dice «premimi».',
        ).toBe(formaA.giorno)
        expect(raggio(p.motivo), 'stessa cosa per il campo del motivo').toBe(formaA.motivo)
        // …e la forma scelta è quella DICHIARATA per gli input, non una pillola.
        expect(formaA.giorno, 'il raggio dei campi non è il token `rounded-input`').toBe('rounded-input')
    })

    it('il MOTIVO è un\'area di testo in entrambe: è una nota medica, non una parola', async () => {
        for (const quale of ['attendance', 'primaria'] as const) {
            const { motivo } = await modulo(quale)
            expect(
                motivo.tagName,
                `${quale}: il motivo è un campo a riga singola. Su una riga sola il genitore non ` +
                    'rilegge quello che ha scritto — ed è il campo che porta il dato sanitario.',
            ).toBe('TEXTAREA')
            cleanup()
        }
    })

    it('il tetto del motivo è DICHIARATO nel campo, non solo nel rifiuto del server', async () => {
        // Il server taglia a 500 (`MOTIVO_MAX_CARATTERI`). Senza `maxlength` si
        // digitavano 1200 caratteri — misurati — e lo si scopriva solo dal 400
        // dopo aver premuto invia. Chi scrive una nota medica lunga la riscrive.
        for (const quale of ['attendance', 'primaria'] as const) {
            const { motivo } = await modulo(quale)
            expect(
                motivo.getAttribute('maxlength'),
                `${quale}: il campo del motivo non dichiara nessun tetto`,
            ).toBe(String(MOTIVO_MAX_CARATTERI))
            cleanup()
        }
    })

    it('le fasce di STATO hanno la stessa anatomia: raggio, contorno, icona', async () => {
        // L'avviso «per questo giorno hai già comunicato»: stesse parole, stessi
        // colori, e fino al 2026-08-08 due raggi diversi (12px contro 16px).
        const avviso = (): HTMLElement => {
            const nodo = screen.getByText(itAssenze.giaComunicataAvviso)
            return (nodo.closest('[role="status"]') ?? nodo) as HTMLElement
        }
        await modulo('attendance')
        const a = avviso()
        const formaA = forma(a)
        const iconeA = a.querySelectorAll('svg').length
        cleanup()
        await modulo('primaria')
        const p = avviso()

        expect(
            forma(p),
            'Lo stesso avviso, con le stesse parole e gli stessi colori, ha due raggi nelle due ' +
                'schermate: cambia solo la forma, e cambia perché è stata scelta a occhio due volte.',
        ).toEqual(formaA)
        expect(p.querySelectorAll('svg').length, 'una delle due fasce ha l\'icona e l\'altra no').toBe(iconeA)
        expect(iconeA, 'la fascia di stato non porta nessuna icona').toBeGreaterThan(0)
    })

    // =========================================================================
    // LA TIPOGRAFIA, non solo la forma (collaudo del 2026-08-08, design Q11+Q12).
    //
    // Il lock arrivava fino al raggio dei campi. Nel frattempo, misurati con
    // `getComputedStyle` sulla STESSA stringa:
    //
    //   «Assenze già comunicate» · Barlow Condensed 18px/900 MAIUSCOLO verde  ← pagina
    //                            · Maven Pro        12px/600 minuscolo ink    ← card
    //   «Giorno dell'assenza»    · Maven Pro 16px/500 verde  #006A5F          ← pagina
    //                            · Maven Pro 12px/600 ink    #1F3D38          ← card
    //
    // Censimento dell'area genitore: `<h2>`/`<h3>` con `font-barlow` = 37, con
    // `font-maven` = 3 — e due dei tre erano i titoli di questa card. `design.md`
    // §Tipografia: «Titoli — Barlow Condensed … H1, H2, H3, titoli delle card».
    //
    // Le etichette divergevano SOPRA DUE CAMPI RESI IDENTICI dal ciclo
    // precedente: si era allineato il controllo e non il BLOCCO di campo.
    // =========================================================================

    /**
     * Le classi che decidono la TIPOGRAFIA: famiglia, peso, trasformazione,
     * inchiostro. La TAGLIA no, ed è deliberato — un titolo dentro una card
     * annidata può essere più piccolo del suo gemello a tutta pagina senza che
     * il genitore veda due prodotti; una famiglia diversa sì.
     */
    const TAGLIA = /^text-(xs|sm|base|lg|\d?xl|\[.*\])$/
    const tipografia = (el: Element) =>
        Array.from(el.classList)
            .filter((c) => /^(font-|text-|uppercase|lowercase|capitalize|normal-case)/.test(c) && !TAGLIA.test(c))
            .sort()

    it('i TITOLI omonimi delle due schermate hanno la stessa tipografia', async () => {
        const titolo = (): HTMLElement =>
            Array.from(document.querySelectorAll('h1,h2,h3')).find((n) =>
                (n.textContent ?? '').includes(itServizi.attendanceElencoTitolo),
            ) as HTMLElement

        render(<ParentAttendancePage />)
        await screen.findByLabelText(itServizi.attendanceGiorno)
        const a = titolo()
        expect(a, 'il titolo dell\'elenco è sparito da /parent/attendance').toBeTruthy()
        const tipoA = tipografia(a)
        cleanup()

        render(<ComunicaAssenzaCard studentId="s-1" parentId="p-1" />)
        const p = await screen.findByText(itPrimaria.comunicaElencoTitolo)

        expect(
            tipografia(p),
            'La stessa identica stringa è resa in due tipografie diverse nelle due schermate della ' +
                'stessa funzione: Barlow Condensed maiuscolo verde di qua, Maven Pro minuscolo scuro ' +
                'di là. Un genitore con un figlio al nido e uno alla primaria le vede nella stessa ' +
                'giornata.',
        ).toEqual(tipoA)
        // …e la famiglia scelta è quella DICHIARATA per i titoli in design.md.
        expect(tipoA, 'i titoli di card non sono in Barlow Condensed').toContain('font-barlow')
    })

    it('le ETICHETTE dei due campi portano la stessa decisione, presa in un posto solo', async () => {
        const attese = ETICHETTA_CAMPO_ASSENZA.split(/\s+/).filter(Boolean)

        const a = await modulo('attendance')
        const etA = {
            giorno: document.querySelector(`label[for="${a.giorno.id}"]`)!,
            motivo: document.querySelector(`label[for="${a.motivo.id}"]`)!,
        }
        const tipoA = { giorno: tipografia(etA.giorno), motivo: tipografia(etA.motivo) }
        cleanup()

        const p = await modulo('primaria')
        const etP = {
            giorno: document.querySelector(`label[for="${p.giorno.id}"]`)!,
            motivo: document.querySelector(`label[for="${p.motivo.id}"]`)!,
        }

        for (const quale of ['giorno', 'motivo'] as const) {
            expect(
                tipografia(etP[quale]),
                `l'etichetta «${quale}» è −25% di corpo e un inchiostro diverso rispetto alla ` +
                    'gemella, sopra un campo identico: si era allineato il controllo e non il blocco',
            ).toEqual(tipoA[quale])
        }
        // …e la decisione arriva dal modulo condiviso, non da due elenchi di
        // classi ricopiati a mano: è l'unica forma che regge la prossima modifica.
        for (const el of [etA.giorno, etA.motivo, etP.giorno, etP.motivo]) {
            expect(Array.from(el.classList)).toEqual(expect.arrayContaining(attese))
        }
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
