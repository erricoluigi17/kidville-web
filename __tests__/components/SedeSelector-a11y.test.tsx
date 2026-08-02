import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { axe, toHaveNoViolations } from 'jest-axe'
import fs from 'node:fs'
import path from 'node:path'

import { SEDE_A, SEDE_B, SEDE_C, NOME_SEDE_A, NOME_SEDE_B, NOME_SEDE_C } from '../fixtures/sedi'

expect.extend(toHaveNoViolations)

/**
 * BLOCCANTE a11y F1 del collaudo 2026-07-31 — «il selettore di sede non dice MAI
 * quale sede è attiva a chi non vede».
 *
 * Lo stato era affidato a un'icona di spunta e a un fondo colorato: nessun
 * `aria-pressed`, `aria-checked`, `aria-current` su nessuna delle righe
 * (misurato: tutti `null`). Per un admin multi-sede con screen reader era
 * impossibile sapere su QUALE dei tre plessi stesse operando — in un prodotto in
 * cui sbagliare sede significa scrivere nel fascicolo del bambino di un altro
 * plesso. In più il popup si annunciava come menu (`aria-haspopup="true"`) senza
 * esserlo, e da tastiera non c'era modo di annullare (chiusura agganciata al solo
 * `mousedown` su `document`).
 *
 * PERCHÉ QUESTI TEST E NON ALTRI. Un attributo di stato NEL DOM non basta: se lo
 * si mette su un elemento il cui ruolo non lo prevede (`aria-checked` su un
 * `<button>` nudo) non viene letto da nessuno. Qui si interroga sempre per RUOLO
 * + STATO (`getAllByRole('button', { pressed: true })`), che è esattamente ciò
 * che fa un assistive technology: risolve il ruolo e poi legge lo stato che quel
 * ruolo ammette. Un `aria-checked` su un bottone farebbe cadere questi test.
 *
 * Il contrasto (design F1) e l'unicità del glifo (design F4) si verificano sui
 * SORGENTI e sui TOKEN reali di `globals.css`: jsdom non calcola il colore
 * ereditato, ma il token scritto nel file e il suo rapporto di luminanza sì.
 */

const h = vi.hoisted(() => ({
    sedi: [] as { id: string; nome: string }[],
    effettive: [] as string[],
    toggle: vi.fn(),
    tutte: vi.fn(),
    logClient: vi.fn(),
}))

vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: () => 'e' }))
vi.mock('@/lib/context/sede-context', () => ({
    useSediAttive: () => ({
        sedi: h.sedi,
        selezionate: [],
        effettive: h.effettive,
        sedeCorrente: null,
        reFetchKey: h.effettive.join(','),
        epocaSede: 0,
        loading: false,
        toggle: h.toggle,
        soloSede: vi.fn(),
        tutte: h.tutte,
    }),
}))

const fetchMock = vi.fn()

const TRE_SEDI = [
    { id: SEDE_A, nome: NOME_SEDE_A },
    { id: SEDE_B, nome: NOME_SEDE_B },
    { id: SEDE_C, nome: NOME_SEDE_C },
]

beforeEach(() => {
    vi.clearAllMocks()
    h.sedi = TRE_SEDI
    h.effettive = TRE_SEDI.map((s) => s.id) // default: tutte
    fetchMock.mockImplementation(() =>
        Promise.resolve({ ok: true, status: 200, json: async () => ({ studenti: { iscritti: 25 } }) }),
    )
    vi.stubGlobal('fetch', fetchMock)
})

import { SedeSelector } from '@/components/ui/cockpit'

/** Apre il menu e restituisce trigger + contenitore delle opzioni. */
function apri() {
    render(<SedeSelector userId="u1" />)
    const trigger = screen.getByRole('button', { name: /cambia sede/i })
    fireEvent.click(trigger)
    const gruppo = screen.getByRole('group', { name: /cambia sede/i })
    return { trigger, gruppo }
}

const nomiDi = (els: HTMLElement[]) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim())

describe('SedeSelector — su quale sede sto lavorando (a11y F1, bloccante)', () => {
    it('il trigger lo dice SENZA aprire il menu: il nome accessibile porta la sede attiva', () => {
        h.effettive = [SEDE_B] // una sola sede attiva: Kidville Beta
        render(<SedeSelector userId="u1" />)

        const trigger = screen.getByRole('button', { name: /cambia sede/i })
        // Controllo POSITIVO accanto al negativo: il nome accessibile contiene sia
        // il ruolo del controllo sia il dato che porta.
        expect(trigger).toHaveAccessibleName(/cambia sede/i)
        expect(trigger).toHaveAccessibleName(new RegExp(NOME_SEDE_B, 'i'))
        // …e non annuncia una sede su cui NON si sta lavorando.
        expect(trigger).not.toHaveAccessibleName(new RegExp(NOME_SEDE_C, 'i'))
    })

    it('aperto il menu, esattamente UNA riga è annunciata come attiva (ruolo + stato)', () => {
        const { gruppo } = apri()

        // Positivo: le tre sedi ci sono davvero (se il menu non si aprisse, cade qui).
        for (const s of TRE_SEDI) {
            expect(within(gruppo).getByRole('button', { name: new RegExp(s.nome, 'i') })).toBeInTheDocument()
        }

        const attive = within(gruppo).getAllByRole('button', { pressed: true })
        expect(attive).toHaveLength(1)
        expect(attive[0]).toHaveAccessibleName(/tutte le sedi/i)

        const inattive = within(gruppo).getAllByRole('button', { pressed: false })
        expect(inattive).toHaveLength(3)
        expect(nomiDi(inattive).join(' | ')).toContain(NOME_SEDE_A)
    })

    it('MUTAZIONE — selezionata una sola sede, è QUELLA riga a essere attiva, non «Tutte le sedi»', () => {
        h.effettive = [SEDE_B]
        const { gruppo } = apri()

        expect(
            within(gruppo).getByRole('button', { name: new RegExp(NOME_SEDE_B, 'i'), pressed: true }),
        ).toBeInTheDocument()
        expect(
            within(gruppo).getByRole('button', { name: /tutte le sedi/i, pressed: false }),
        ).toBeInTheDocument()
        expect(
            within(gruppo).getByRole('button', { name: new RegExp(NOME_SEDE_A, 'i'), pressed: false }),
        ).toBeInTheDocument()
    })

    it('MUTAZIONE — due sedi selezionate: DUE righe attive (il selettore è multi-scelta, non radio)', () => {
        // Perché conta: `role="menuitemradio"` annuncerebbe «una sola scelta
        // possibile». Con tre plessi se ne possono tenere due: sarebbe un annuncio
        // falso, cioè lo stesso difetto di prima con una vernice ARIA sopra.
        h.effettive = [SEDE_A, SEDE_C]
        const { gruppo } = apri()

        const attive = within(gruppo).getAllByRole('button', { pressed: true })
        expect(attive).toHaveLength(2)
        expect(nomiDi(attive).join(' | ')).toContain(NOME_SEDE_A)
        expect(nomiDi(attive).join(' | ')).toContain(NOME_SEDE_C)
        expect(nomiDi(attive).join(' | ')).not.toContain(NOME_SEDE_B)
    })

    it('lo stato cambia davvero al click: la riga chiama il toggle della sede giusta', () => {
        const { gruppo } = apri()
        fireEvent.click(within(gruppo).getByRole('button', { name: new RegExp(NOME_SEDE_C, 'i') }))
        expect(h.toggle).toHaveBeenCalledWith(SEDE_C)
    })

    it('Esc chiude il menu e riporta il focus al trigger (da tastiera si può annullare)', () => {
        const { trigger, gruppo } = apri()

        // Positivo: prima dell'Esc il menu è aperto e dichiarato tale.
        expect(trigger).toHaveAttribute('aria-expanded', 'true')
        const riga = within(gruppo).getByRole('button', { name: new RegExp(NOME_SEDE_A, 'i') })
        riga.focus()
        expect(document.activeElement).toBe(riga)

        fireEvent.keyDown(riga, { key: 'Escape' })

        expect(screen.queryByRole('group', { name: /cambia sede/i })).toBeNull()
        expect(trigger).toHaveAttribute('aria-expanded', 'false')
        expect(document.activeElement).toBe(trigger)
    })

    it('il trigger dichiara il pannello che comanda (aria-controls → id reale)', () => {
        const { trigger, gruppo } = apri()
        const controlla = trigger.getAttribute('aria-controls')
        expect(controlla).toBeTruthy()
        expect(document.getElementById(controlla!)).toBe(gruppo)
    })

    it('le icone non inquinano il nome accessibile della riga', () => {
        const { gruppo } = apri()
        const riga = within(gruppo).getByRole('button', { name: new RegExp(NOME_SEDE_A, 'i') })
        // Nome accessibile = solo il nome della sede (l'icona e la spunta sono decorative).
        expect(riga).toHaveAccessibleName(NOME_SEDE_A)
        for (const svg of Array.from(riga.querySelectorAll('svg'))) {
            expect(svg.getAttribute('aria-hidden')).toBe('true')
        }
    })

    it('jest-axe: nessuna violazione ARIA col menu aperto', async () => {
        const { container } = render(<SedeSelector userId="u1" />)
        fireEvent.click(screen.getByRole('button', { name: /cambia sede/i }))
        expect(
            await axe(container, {
                rules: { region: { enabled: false }, 'landmark-one-main': { enabled: false } },
            }),
        ).toHaveNoViolations()
    })
})

/* ────────────────────────────────────────────────────────────────────────────
 * design F1 — il nome della sede è informazione, non decorazione
 * ──────────────────────────────────────────────────────────────────────────── */

const RADICE = process.cwd()
const css = fs.readFileSync(path.join(RADICE, 'src', 'app', 'globals.css'), 'utf8')

/**
 * Valore BASE di un token colore. `globals.css` ridichiara gli stessi nomi dentro
 * `[data-contrast="high"]`: la prima occorrenza nel file è sempre quella di `:root`,
 * ed è quella che vale nella resa normale (il collaudo ha misurato lì).
 */
function token(nome: string): string {
    const m = css.match(new RegExp(`--color-kidville-${nome}:\\s*(#[0-9A-Fa-f]{6})`))
    expect(m, `token --color-kidville-${nome} presente in globals.css`).toBeTruthy()
    return m![1]
}

const canale = (v: number) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))

function luminanza(hex: string): number {
    const n = parseInt(hex.slice(1), 16)
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => canale(c / 255))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function rapporto(a: string, b: string): number {
    const [x, y] = [luminanza(a), luminanza(b)].sort((p, q) => q - p)
    return (x + 0.05) / (y + 0.05)
}

/**
 * Token di colore che governa il testo in un punto del sorgente: si parte dalla
 * riga che contiene il marcatore e si risale, perché in JSX il colore può stare
 * sul contenitore (`<div class="… text-kidville-sub">`) qualche riga sopra.
 */
function coloreDelTesto(file: string, marcatore: string): string {
    const righe = fs.readFileSync(path.join(RADICE, file), 'utf8').split('\n')
    const i = righe.findIndex((r) => r.includes(marcatore))
    expect(i, `marcatore «${marcatore}» presente in ${file}`).toBeGreaterThanOrEqual(0)
    for (let j = i; j >= Math.max(0, i - 8); j--) {
        const m = righe[j].match(/text-kidville-([a-z-]+)/)
        if (m) return m[1]
    }
    return 'NESSUNO'
}

/** I tre fondi su cui il nome della sede viene davvero disegnato. */
const FONDI = {
    bianco: 'white',
    crema: 'cream',
    'verde tenue': 'green-soft',
} as const

describe('Il nome della sede si legge (design F1)', () => {
    it('il token «sub» supera AA su tutti i fondi su cui compare, «muted» no (misura viva)', () => {
        for (const [etichetta, nomeFondo] of Object.entries(FONDI)) {
            const fondo = token(nomeFondo)
            expect(rapporto(token('sub'), fondo), `sub su ${etichetta}`).toBeGreaterThanOrEqual(4.5)
            // Controllo che il metro misuri davvero: col token vecchio il numero è sotto.
            expect(rapporto(token('muted'), fondo), `muted su ${etichetta}`).toBeLessThan(4.5)
        }
    })

    it('i tre punti in cui compare il NOME DELLA SEDE usano il token leggibile', () => {
        // Marcatore preso dentro `SedeRow`: nel trigger il meta è `{!compatto && …`
        // ed è testo bianco su verde, un'altra coppia con un'altra soglia.
        expect(coloreDelTesto('src/components/ui/cockpit.tsx', '{meta && <span')).toBe('sub')
        // `>{…}<`: si cerca il punto in cui il nome è RESO, non quello in cui è
        // interpolato dentro un `aria-label` (che di colore non ne ha).
        expect(coloreDelTesto('src/app/(dashboard)/teacher/page.tsx', '>{s.scuolaNome}<')).toBe('sub')
        expect(
            coloreDelTesto('src/components/features/admin/SectionsView.tsx', '{section.scuolaNome}<'),
        ).toBe('sub')
    })

    it('nel DOM reale la riga meta del selettore porta il token leggibile', () => {
        const { gruppo } = apri()
        const riga = within(gruppo).getByRole('button', { name: /tutte le sedi/i })
        // La FOGLIA che porta il testo, non un suo contenitore: il colore sta lì.
        const meta = Array.from(riga.querySelectorAll('span')).find(
            (s) => (s.textContent ?? '').includes('strutture') && s.querySelector('span') === null,
        )
        expect(meta, 'la riga «Tutte le sedi» mostra il conteggio delle strutture').toBeTruthy()
        expect(meta!.className).toContain('text-kidville-sub')
        expect(meta!.className).not.toContain('text-kidville-muted')
    })

    it('il chip di sezione del docente non scrive la sede a 10px', () => {
        // 10px + colore chiaro era il testo meno leggibile della schermata; il chip
        // resta piccolo, ma il nome del plesso sale a 11px.
        const src = fs.readFileSync(path.join(RADICE, 'src/app/(dashboard)/teacher/page.tsx'), 'utf8')
        const riga = src.split('\n').find((r) => r.includes('>{s.scuolaNome}<'))!
        expect(riga).toContain('text-[11px]')
        expect(riga).not.toContain('text-[10px]')
    })
})

/* ────────────────────────────────────────────────────────────────────────────
 * design F4 — un solo glifo per «sede»
 * ──────────────────────────────────────────────────────────────────────────── */

const FILE_CON_SEDE = [
    'src/components/ui/cockpit.tsx',
    'src/components/features/admin/SectionsView.tsx',
    'src/components/features/admin/settings/SedeCorrente.tsx',
    'src/components/features/admin/settings/OblioPanel.tsx',
]

describe('Un solo glifo per «sede» (design F4)', () => {
    it('i quattro punti che mostrano una sede usano SedeIcon', () => {
        for (const f of FILE_CON_SEDE) {
            const src = fs.readFileSync(path.join(RADICE, f), 'utf8')
            expect(src, `${f} importa SedeIcon`).toMatch(/from '@\/components\/ui\/SedeIcon'/)
            expect(src, `${f} rende SedeIcon`).toMatch(/<SedeIcon\b/)
        }
    })

    it('nessun glifo alternativo resta a rappresentare la sede in quei file', () => {
        for (const f of FILE_CON_SEDE) {
            const src = fs.readFileSync(path.join(RADICE, f), 'utf8')
            expect(src, `${f} non usa più Building2`).not.toMatch(/\bBuilding2\b/)
            expect(src, `${f} non usa più MapPin`).not.toMatch(/\bMapPin\b/)
        }
        // Il duplicato locale del cockpit è sparito, non solo rinominato.
        expect(fs.readFileSync(path.join(RADICE, FILE_CON_SEDE[0]), 'utf8')).not.toMatch(
            /function SchoolIcon/,
        )
    })

    it('SedeIcon è decorativa: non entra nel nome accessibile', () => {
        const { gruppo } = apri()
        const icone = gruppo.querySelectorAll('svg')
        expect(icone.length).toBeGreaterThan(0)
        for (const svg of Array.from(icone)) expect(svg.getAttribute('aria-hidden')).toBe('true')
    })
})
