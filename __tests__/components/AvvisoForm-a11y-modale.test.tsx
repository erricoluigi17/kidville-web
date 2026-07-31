import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { useRef, useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'

import itTeacher from '../../messages/it/teacherComunicazioni.json'
import itShared from '../../messages/it/shared.json'
import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi'

// =============================================================================
// `AvvisoForm` — la modale esiste anche per chi non la vede.
//
// Il difetto misurato su Android e iOS: il contenitore non aveva `role="dialog"`,
// né `aria-modal`, né `aria-labelledby`, né focus-trap. Per TalkBack la modale
// semplicemente NON c'era: l'albero di accessibilità continuava a esporre la
// pagina sotto. Il bottone di chiusura era 32×32 px (sotto il minimo touch) e
// senza `aria-label`: muto per chi non vede l'icona. E la modale stava a `z-50`,
// lo stesso piano della bottom-nav, che le copriva il bottone «Pubblica avviso».
//
// METODO. Le asserzioni qui NON sono «non è fallito»: si asserisce DOVE finisce
// il focus (elemento esatto), QUALE nodo etichetta il dialog (il titolo vero) e
// che il numero di z-index sia STRETTAMENTE maggiore di quello che le bottom-nav
// dichiarano davvero nel sorgente. Il controllo positivo è la prima prova: a
// modale CHIUSA la pagina sotto deve essere raggiungibile — senza quello, un
// test che verifica «lo sfondo non è raggiungibile» passerebbe anche su una
// pagina che non carica affatto.
// =============================================================================

vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'Error' }))

import { AvvisoForm, type ClasseAvviso, type DatiAvviso, type EsitoInvioAvviso } from '@/components/features/avvisi/AvvisoForm'
import type { Avviso } from '@/components/features/avvisi/AvvisoCard'

const CLASSI: ClasseAvviso[] = [
    { id: 'sez-a-2anni', nome: '2 ANNI', scuolaId: SEDE_A, scuolaNome: NOME_SEDE_A },
]

/** Un avviso già archiviato — dati inventati, nessuna PII. */
const AVVISO_ESISTENTE: Avviso = {
    id: 'avv-1',
    author_id: 'aut-1',
    titolo: 'Uscita anticipata',
    contenuto: 'Domani si esce alle 12.',
    tipo: 'presa_visione',
    target_scope: 'globale',
    target_classes: [],
    scadenza: null,
    attachment_url: null,
    created_at: '2026-07-31T08:00:00.000Z',
    author: { first_name: 'Nome', last_name: 'Cognome', role: 'segreteria' },
    stats: { letti: 0, adesioni_si: 0, adesioni_no: 0 },
}

const SFONDO_TRIGGER = 'Nuovo avviso'
const SFONDO_ALTRO = 'Filtro della pagina'

/**
 * Una pagina finta con DUE controlli di sfondo e la modale dentro: senza lo
 * sfondo non si può dimostrare né che a modale chiusa è raggiungibile, né che a
 * modale aperta il Tab non ci finisce sopra.
 */
function Pagina({ onSubmit }: { onSubmit?: (d: DatiAvviso) => Promise<EsitoInvioAvviso> } = {}) {
    const [open, setOpen] = useState(false)
    const triggerRef = useRef<HTMLButtonElement>(null)
    return (
        <>
            <button ref={triggerRef} onClick={() => setOpen(true)}>{SFONDO_TRIGGER}</button>
            <button>{SFONDO_ALTRO}</button>
            <AvvisoForm
                open={open}
                onClose={() => setOpen(false)}
                onSubmit={onSubmit ?? (async () => ({ ok: true }))}
                availableClasses={CLASSI}
            />
        </>
    )
}

const FOCUSABLE =
    'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

const focusabili = (dialog: HTMLElement) => Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))

const apri = () => fireEvent.click(screen.getByRole('button', { name: SFONDO_TRIGGER }))

describe('AvvisoForm — controllo positivo: a modale CHIUSA la pagina sotto è viva', () => {
    it('nessun dialog, e i controlli di sfondo sono nell’albero e prendono il focus', () => {
        render(<Pagina />)
        expect(screen.queryByRole('dialog')).toBeNull()

        const trigger = screen.getByRole('button', { name: SFONDO_TRIGGER })
        const altro = screen.getByRole('button', { name: SFONDO_ALTRO })
        altro.focus()
        expect(document.activeElement).toBe(altro)
        trigger.focus()
        expect(document.activeElement).toBe(trigger)
        // E il Tab non è intercettato da nessuno: nessun trap attivo a riposo.
        fireEvent.keyDown(document, { key: 'Tab' })
        expect(document.activeElement).toBe(trigger)
    })
})

describe('AvvisoForm — la modale è esposta all’albero di accessibilità', () => {
    it('role="dialog" + aria-modal + aria-labelledby che punta al TITOLO vero', () => {
        render(<Pagina />)
        apri()

        const dialog = screen.getByRole('dialog')
        expect(dialog).toHaveAttribute('aria-modal', 'true')

        const labelledBy = dialog.getAttribute('aria-labelledby')
        expect(labelledBy).toBeTruthy()
        const titolo = document.getElementById(labelledBy as string)
        expect(titolo).not.toBeNull()
        // Non un id qualsiasi: l'intestazione che l'operatore legge a schermo.
        expect(titolo).toBe(screen.getByRole('heading', { name: itTeacher.formTitoloNuovo }))
        expect(titolo?.textContent).toBe(itTeacher.formTitoloNuovo)
    })

    it('in modifica l’etichetta accessibile segue il titolo «modifica»', () => {
        render(
            <AvvisoForm
                open
                onClose={vi.fn()}
                onSubmit={async () => ({ ok: true })}
                availableClasses={CLASSI}
                initialAvviso={AVVISO_ESISTENTE}
            />,
        )
        const dialog = screen.getByRole('dialog')
        const titolo = document.getElementById(dialog.getAttribute('aria-labelledby') as string)
        expect(titolo?.textContent).toBe(itTeacher.formTitoloModifica)
    })
})

describe('AvvisoForm — il focus entra, resta dentro e torna indietro', () => {
    it('all’apertura il focus entra nella modale (non resta sul bottone della pagina)', () => {
        render(<Pagina />)
        const trigger = screen.getByRole('button', { name: SFONDO_TRIGGER })
        trigger.focus()
        apri()

        const dialog = screen.getByRole('dialog')
        expect(dialog.contains(document.activeElement)).toBe(true)
        expect(document.activeElement).toBe(focusabili(dialog)[0])
    })

    it('Tab dall’ULTIMO controllo torna al PRIMO: non esce sullo sfondo', () => {
        render(<Pagina />)
        apri()
        const dialog = screen.getByRole('dialog')
        const controlli = focusabili(dialog)
        expect(controlli.length).toBeGreaterThan(1)

        const ultimo = controlli[controlli.length - 1]
        ultimo.focus()
        expect(document.activeElement).toBe(ultimo)

        fireEvent.keyDown(document, { key: 'Tab' })
        // Asserzione POSITIVA sull'elemento esatto, non «non è lo sfondo».
        expect(document.activeElement).toBe(controlli[0])
        expect(dialog.contains(document.activeElement)).toBe(true)
    })

    it('Shift+Tab dal PRIMO torna all’ULTIMO', () => {
        render(<Pagina />)
        apri()
        const dialog = screen.getByRole('dialog')
        const controlli = focusabili(dialog)

        controlli[0].focus()
        fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
        expect(document.activeElement).toBe(controlli[controlli.length - 1])
    })

    it('Esc chiude la modale e restituisce il focus al bottone che l’ha aperta', () => {
        render(<Pagina />)
        const trigger = screen.getByRole('button', { name: SFONDO_TRIGGER })
        trigger.focus()
        apri()
        expect(screen.getByRole('dialog')).toBeInTheDocument()

        fireEvent.keyDown(document, { key: 'Escape' })
        expect(screen.queryByRole('dialog')).toBeNull()
        expect(document.activeElement).toBe(trigger)
    })
})

describe('AvvisoForm — il bottone di chiusura', () => {
    it('ha un nome accessibile e un’area toccabile di almeno 44×44', () => {
        render(<Pagina />)
        apri()
        // Prima del fix questo bottone NON aveva alcun nome accessibile: la query
        // per nome falliva, ed è esattamente il difetto misurato con TalkBack.
        const chiudi = screen.getByRole('button', { name: itShared.chiudi })
        expect(chiudi).toHaveAttribute('aria-label', itShared.chiudi)
        // jsdom non fa layout: il minimo touch si verifica sulle classi dichiarate.
        expect(chiudi.className).toMatch(/(^|\s)min-w-\[44px\](\s|$)/)
        expect(chiudi.className).toMatch(/(^|\s)min-h-\[44px\](\s|$)/)
    })

    it('chiude davvero la modale', () => {
        render(<Pagina />)
        apri()
        fireEvent.click(screen.getByRole('button', { name: itShared.chiudi }))
        expect(screen.queryByRole('dialog')).toBeNull()
    })
})

describe('AvvisoForm — sta SOPRA la bottom-nav', () => {
    /** z-index massimo dichiarato nel sorgente di un componente. */
    function zMassimo(file: string): number {
        const src = readFileSync(path.resolve(process.cwd(), file), 'utf8')
        const valori = [...src.matchAll(/(?:^|\s)z-\[?(\d+)\]?/g)].map((m) => Number(m[1]))
        expect(valori.length).toBeGreaterThan(0)
        return Math.max(...valori)
    }

    it('il piano della modale è strettamente maggiore di quello delle tre bottom-nav', () => {
        render(<Pagina />)
        apri()
        const dialog = screen.getByRole('dialog')
        const scrim = dialog.parentElement as HTMLElement
        const zModale = Number(/(?:^|\s)z-\[?(\d+)\]?/.exec(scrim.className)?.[1])
        expect(Number.isFinite(zModale)).toBe(true)

        const zNav = Math.max(
            zMassimo('src/components/features/parent/BottomNav.tsx'),
            zMassimo('src/components/features/teacher/TeacherBottomNav.tsx'),
            zMassimo('src/components/features/admin/AdminBottomNav.tsx'),
        )
        // Controllo positivo: le bottom-nav un piano ce l'hanno davvero (se il
        // regex non trovasse nulla, `zNav` sarebbe -Infinity e il confronto
        // passerebbe da solo).
        expect(zNav).toBeGreaterThanOrEqual(50)
        expect(zModale).toBeGreaterThan(zNav)
    })
})
