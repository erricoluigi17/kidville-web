import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { axe, toHaveNoViolations } from 'jest-axe'
import fs from 'node:fs'
import path from 'node:path'

import { Drawer } from '@/components/ui/cockpit'
import { rendiInerteFuoriDa, supportaInert } from '@/lib/accessibility/inerti'

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
 *
 * ── IL FUOCO, aggiunto il 2026-08-12 ────────────────────────────────────────
 *
 * Il fuoco che entra, il Tab che cicla dentro e il fuoco che torna al comando
 * d'apertura SONO stati chiusi, e senza ricondurre il Drawer a `Modal`: il ciclo
 * usa lo stesso pezzo della primitiva (`@/lib/accessibility/focus-dialogo`,
 * estratto lo stesso giorno per non averne due copie che divergono).
 *
 * IL DIFETTO CHE QUESTI TEST IMPEDISCONO. `aria-modal="true"` dichiara allo
 * screen reader che tutto ciò che sta fuori è inerte; il Tab del browser diceva
 * il contrario. Misurato sul cockpit delle pratiche del personale: aperto un
 * pannello dall'elenco, `dialog.contains(document.activeElement)` era `false` —
 * il fuoco era rimasto sul collegamento SOTTO lo scrim — e restavano 2 elementi
 * tabbabili fuori dal dialogo, coperti e attivabili con Invio (WCAG 2.4.11). Su
 * un pannello che mostra codice fiscale, residenza ed estremi di un documento
 * d'identità.
 *
 * ⚠️ CIÒ CHE ANCORA MANCA, E PERCHÉ MANCA DI PROPOSITO: l'inerzia dello sfondo.
 * Ha un test suo qui sotto, perché è una decisione e non un buco — un
 * consumatore di questo drawer (`CodiciFiscaliDaVerificare`) tiene il pannello
 * aperto mentre una regione `aria-live` FUORI dal pannello annuncia, e
 * inertizzare lo sfondo la ammutolirebbe lasciando il suo test verde.
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

    it('all’apertura il fuoco ENTRA nel dialogo (prima restava sul comando sotto lo scrim)', () => {
        // Il trigger: è il collegamento dell'elenco, quello che nel cockpit vero apre
        // la pratica. Ha il fuoco quando il pannello compare.
        render(<a href="#x">Anna Bianchi</a>)
        const trigger = screen.getByRole('link', { name: 'Anna Bianchi' })
        trigger.focus()
        expect(document.activeElement, 'il trigger non ha il fuoco: la prova non varrebbe').toBe(trigger)

        const drawer = render(
            <Drawer open onClose={() => {}} title="Pratica">
                <button type="button">Approva</button>
            </Drawer>,
        )
        const dialogo = screen.getByRole('dialog', { name: /pratica/i })
        // LA MISURA del rilievo, rovesciata.
        expect(dialogo.contains(document.activeElement), 'il fuoco è rimasto FUORI dal dialogo').toBe(true)

        // …e alla chiusura torna DA DOVE ERA PARTITO (WCAG 2.4.3). Senza, chi naviga da
        // tastiera ricomincia dalla cima della pagina a ogni pannello chiuso — che è il
        // modo in cui una correzione del fuoco ne introduce un'altra.
        drawer.unmount()
        expect(document.activeElement, 'il fuoco non è tornato al comando che ha aperto').toBe(trigger)
    })

    it('il Tab CICLA dentro il pannello e non esce sui comandi coperti dallo scrim', () => {
        render(<button type="button">Comando di sfondo</button>)
        const sfondo = screen.getByRole('button', { name: 'Comando di sfondo' })

        render(
            <Drawer open onClose={() => {}} title="Pratica">
                <button type="button">Approva</button>
                <button type="button">Rifiuta</button>
            </Drawer>,
        )
        // Gli estremi del ciclo si PRENDONO dall'ordine di documento, non si
        // indovinano: la ✕ dell'intestazione viene prima del contenuto, e un test che
        // dà per scontato il contrario proverebbe l'ordine invece del ciclo.
        const dialogo = screen.getByRole('dialog', { name: /pratica/i })
        const controlli = Array.from(dialogo.querySelectorAll('button'))
        expect(controlli.length, 'il pannello ha più di un controllo: il ciclo è vero').toBeGreaterThan(2)
        const primo = controlli[0]
        const ultimo = controlli[controlli.length - 1]
        expect(screen.getByRole('button', { name: 'Approva' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Rifiuta' })).toBe(ultimo)

        // Dall'ultimo controllo, Tab NON esce: torna al primo.
        ultimo.focus()
        fireEvent.keyDown(document, { key: 'Tab' })
        expect(document.activeElement, 'il Tab è uscito dal pannello').toBe(primo)

        // …e Shift+Tab dal primo torna all'ultimo, invece di finire sullo sfondo.
        primo.focus()
        fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
        expect(document.activeElement).toBe(ultimo)

        // Controllo positivo: NEL MEZZO il Tab non viene intercettato — se lo fosse
        // sempre, il ciclo sarebbe una prigione e questo test sarebbe verde per il
        // motivo sbagliato.
        const mezzo = controlli[1]
        mezzo.focus()
        fireEvent.keyDown(document, { key: 'Tab' })
        expect(document.activeElement).toBe(mezzo)

        // E il fuoco caduto sul `<body>` — succede a ogni comando che si disabilita
        // durante una POST — rientra invece di ripartire dallo sfondo.
        ;(document.activeElement as HTMLElement).blur()
        expect(document.activeElement).toBe(document.body)
        fireEvent.keyDown(document, { key: 'Tab' })
        expect(document.activeElement).toBe(primo)

        // Lo sfondo non è mai stato toccato: il ciclo non lo marca `inert`, e non
        // deve — vedi il test qui sotto.
        expect(sfondo.hasAttribute('inert')).toBe(false)
    })

    it('lo sfondo NON è `inert`: un consumatore ci tiene una regione `aria-live` viva', () => {
        // NON è una dimenticanza, è una misura, e questo test la tiene ferma.
        // `CodiciFiscaliDaVerificare` scrive il codice DAL pannello e lascia il
        // pannello aperto: a dire «Aggiornamento dell'elenco in corso…» è una regione
        // `aria-live="polite"` che sta FUORI dal pannello. Con lo sfondo `inert` (o
        // `aria-hidden`, che è il ripiego di `inerti.ts` dove `inert` non c'è) quell'
        // annuncio non parte più — e il suo test resterebbe VERDE, perché asserisce
        // l'attributo `aria-live` e non l'annuncio. Scambiare un difetto AA con un
        // altro, in silenzio, non è una correzione: l'inerzia va insieme
        // all'unificazione con `Modal`, con quel componente in mano.
        const { unmount } = render(
            <p aria-live="polite">Aggiornamento dell’elenco in corso…</p>,
        )
        const vivo = screen.getByText('Aggiornamento dell’elenco in corso…').parentElement!

        const drawer = render(
            <Drawer open onClose={() => {}} title="Pratica">
                <button type="button">Approva</button>
            </Drawer>,
        )
        expect(vivo.hasAttribute('inert'), 'lo sfondo è stato inertizzato: l’annuncio non parte più').toBe(false)
        expect(vivo.getAttribute('aria-hidden')).toBeNull()

        // ── CONTROLLO POSITIVO: il meccanismo ESISTE e su questo nodo funzionerebbe.
        // Senza, le due righe qui sopra sarebbero verdi anche se `rendiInerteFuoriDa`
        // fosse rotta o non applicabile — cioè proverebbero il nulla.
        const dialogo = screen.getByRole('dialog', { name: /pratica/i })
        const ripristina = rendiInerteFuoriDa(dialogo)
        expect(vivo.hasAttribute('inert')).toBe(true)
        // …e dove `inert` non è implementato (jsdom) si affianca `aria-hidden`, che è
        // esattamente l'attributo che ammutolisce una regione `aria-live`.
        expect(vivo.getAttribute('aria-hidden')).toBe(supportaInert() ? null : 'true')
        ripristina()
        expect(vivo.hasAttribute('inert')).toBe(false)

        drawer.unmount()
        unmount()
    })

    it('il contenitore prende il fuoco ma NON entra nel giro del Tab (`tabIndex` -1)', () => {
        render(
            <Drawer open onClose={() => {}} title="Pratica">
                <button type="button">Approva</button>
            </Drawer>,
        )
        // Un dialogo non è un controllo: ripassarci sopra a ogni ciclo di Tab sarebbe
        // una tappa muta. `-1` = ci si viene messi, non ci si arriva.
        expect(screen.getByRole('dialog', { name: /pratica/i }).getAttribute('tabindex')).toBe('-1')
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
