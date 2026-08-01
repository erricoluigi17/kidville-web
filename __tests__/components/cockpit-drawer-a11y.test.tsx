import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { axe, toHaveNoViolations } from 'jest-axe'
import fs from 'node:fs'
import path from 'node:path'

import { Drawer } from '@/components/ui/cockpit'

expect.extend(toHaveNoViolations)

/**
 * Il `Drawer` del cockpit (usato da /admin/merchandise e da tutti e quattro i
 * pannelli di /admin/protocolli) dichiara `role="dialog" aria-modal="true"` ma
 * NON passa dalla primitiva `Modal`: non ha quindi ricevuto nessuna delle
 * correzioni fatte alla primitiva (velo fratello, `inert`, focus-trap, Escape,
 * tasto Indietro di Android, z sopra il chrome admin).
 *
 * PERCHÉ NON È STATO RICONDOTTO A `Modal` IN QUESTO STEP. `Modal` centra il suo
 * contenuto (`flex items-center justify-center p-4`) e passa al dialogo una
 * classe che deve restare `relative`: uno slide-over ancorato a destra e alto
 * quanto lo schermo non ci entra senza cambiare la primitiva, e `Modal.tsx` è
 * fuori dal perimetro di questo lavoro. L'unificazione è una modifica alla
 * primitiva, non a chi la usa, e va fatta in uno step suo.
 *
 * Qui si chiude ciò che si chiude senza toccarla, e questi test lo bloccano:
 * il dialogo ha un NOME, si chiude da tastiera, lo scrim non entra nell'albero
 * di accessibilità, e non finisce sotto la barra verde dell'admin.
 */

const CHROME_ADMIN = [
    'src/components/features/admin/AdminTopBarMobile.tsx',
    'src/components/features/admin/AdminSidebar.tsx',
    'src/components/features/admin/AdminMenuSheet.tsx',
]

/** Tutte le `z-[n]` dichiarate in un file. */
function zDi(file: string): number[] {
    const src = fs.readFileSync(path.join(process.cwd(), file), 'utf8')
    return Array.from(src.matchAll(/\bz-\[(\d+)\]/g)).map((m) => Number(m[1]))
}

describe('Drawer del cockpit — accessibilità di base', () => {
    it('il dialogo ha un nome accessibile (oggi il titolo era solo un <h2> scollegato)', () => {
        render(
            <Drawer open onClose={() => {}} title="Ordine merchandise">
                <p>contenuto</p>
            </Drawer>,
        )
        // Positivo: il dialogo esiste ED è raggiungibile per nome.
        const dialogo = screen.getByRole('dialog', { name: /ordine merchandise/i })
        expect(dialogo).toBeInTheDocument()
    })

    it('Escape chiude (prima si poteva uscire solo col mouse sullo scrim o sulla ✕)', () => {
        const onClose = vi.fn()
        render(
            <Drawer open onClose={onClose} title="Ordine merchandise">
                <p>contenuto</p>
            </Drawer>,
        )
        // Positivo: finché non si preme nulla, nessuno chiude niente.
        expect(onClose).not.toHaveBeenCalled()
        fireEvent.keyDown(document, { key: 'Escape' })
        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('…ma NON quando sopra c’è un altro dialogo modale: quello lo chiude lui', () => {
        const onClose = vi.fn()
        render(
            <Drawer open onClose={onClose} title="Ordine merchandise">
                <p>contenuto</p>
            </Drawer>,
        )
        // Un dialogo aperto DAL drawer (o comunque non suo antenato).
        const sopra = document.createElement('div')
        sopra.setAttribute('role', 'dialog')
        sopra.setAttribute('aria-modal', 'true')
        document.body.appendChild(sopra)

        fireEvent.keyDown(document, { key: 'Escape' })
        expect(onClose).not.toHaveBeenCalled()

        // Controllo positivo: tolto quello sopra, l'Escape torna a funzionare.
        sopra.remove()
        fireEvent.keyDown(document, { key: 'Escape' })
        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('lo scrim è decorativo: non entra nell’albero di accessibilità', () => {
        const { container } = render(
            <Drawer open onClose={() => {}} title="Ordine merchandise">
                <p>contenuto</p>
            </Drawer>,
        )
        const scrim = container.querySelector('.absolute.inset-0')
        expect(scrim, 'lo scrim esiste').toBeTruthy()
        expect(scrim!.getAttribute('aria-hidden')).toBe('true')
    })

    it('jest-axe: nessuna violazione col drawer aperto', async () => {
        const { container } = render(
            <Drawer open onClose={() => {}} title="Ordine merchandise" subtitle="Rossi Beta">
                <p>contenuto</p>
            </Drawer>,
        )
        expect(
            await axe(container, {
                rules: { region: { enabled: false }, 'landmark-one-main': { enabled: false } },
            }),
        ).toHaveNoViolations()
    })

    it('sta SOPRA il chrome del cockpit: a z-[95] la barra verde gli passava davanti', () => {
        const src = fs.readFileSync(path.join(process.cwd(), 'src/components/ui/cockpit.tsx'), 'utf8')
        const m = src.match(/fixed inset-0 z-\[(\d+)\]/)
        expect(m, 'il contenitore del Drawer dichiara la sua z').toBeTruthy()
        const zDrawer = Number(m![1])

        const zChrome = CHROME_ADMIN.flatMap(zDi)
        // Positivo: il chrome admin dichiara davvero delle z (se un domani
        // sparissero, il confronto sotto sarebbe vuoto e non proverebbe nulla).
        expect(zChrome.length).toBeGreaterThan(0)
        expect(zDrawer).toBeGreaterThan(Math.max(...zChrome))
    })
})
