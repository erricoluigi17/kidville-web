import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * LOCK — la fascia della Dynamic Island ha un fondale suo, che non dipende
 * dall'intestazione.
 *
 * ─── IL DIFETTO ─────────────────────────────────────────────────────────────
 * Rilievo R26 del quinto collaudo (2026-08-08), simulatore iOS: con la tastiera
 * aperta sul campo «Motivo» l'intestazione verde sparisce e il contenuto della
 * pagina risale nella fascia riservata all'isola — l'etichetta «Giorno
 * dell'assenza» e il valore della data finiscono lassù, senza barra di stato
 * visibile.
 *
 * La causa: quella fascia la dipingeva SOLO `.kv-appbar` con il proprio
 * `padding-top: env(safe-area-inset-top)`. Cioè il fondale era un effetto
 * collaterale dell'intestazione. L'intestazione è `sticky top-0`, ancorata al
 * viewport di LAYOUT; quando la tastiera accorcia quello VISUALE, la WKWebView la
 * porta fuori dalla vista, e con lei se ne va il fondale.
 *
 * ─── PERCHÉ UN LOCK, PER UNA REGOLA DI TRE RIGHE ────────────────────────────
 * Perché è invisibile dove si lavora. Nel browser `env(safe-area-inset-top)` vale
 * 0 e su Android pure (status bar solida): la regola non dipinge niente, e uno
 * `z-index` sbagliato o un `pointer-events` dimenticato non si vedrebbero mai —
 * fino al prossimo giro sul simulatore, che è la cosa più cara che abbiamo.
 *
 * ⚠️ Questo lock NON dice che il difetto è chiuso: la fascia nasconde ciò che
 * risale, non gli impedisce di risalire. L'altra metà (impedire alla pagina di
 * scorrere oltre il limite con la tastiera aperta) tocca ogni campo dell'app
 * nativa e si decide dopo la misura sul simulatore.
 */

const CSS = readFileSync('src/app/globals.css', 'utf8')

/** Il blocco della regola, dalla graffa aperta alla chiusa. */
function blocco(selettore: string): string {
    const i = CSS.indexOf(selettore)
    expect(i, `regola sparita da globals.css: ${selettore}`).toBeGreaterThan(-1)
    return CSS.slice(i, CSS.indexOf('}', i))
}

describe('LOCK · la fascia della safe-area è dipinta dal contenitore', () => {
    const fascia = () => blocco('.cap-native [data-kv-shell]::before')

    it('è ancorata al viewport, non al contenuto che scorre', () => {
        expect(
            fascia(),
            'la fascia non è più `fixed`: tornerebbe a muoversi con la pagina, che è esattamente ' +
                "il difetto dell'intestazione sticky",
        ).toContain('position: fixed')
        expect(fascia()).toContain('top: 0')
    })

    it('è alta quanto la safe-area, quindi non esiste dove non serve', () => {
        // Nel browser e su Android `env()` vale 0: altezza 0, nessun pixel dipinto.
        expect(
            fascia(),
            'altezza scritta a mano invece che presa da `env()`: su un telefono con un notch ' +
                'diverso coprirebbe troppo o troppo poco',
        ).toContain('height: env(safe-area-inset-top)')
    })

    it('non ruba tocchi: è un fondale, non un comando', () => {
        expect(
            fascia(),
            'senza `pointer-events: none` una striscia invisibile in cima allo schermo ' +
                'intercetterebbe i tocchi diretti a ciò che le sta sotto',
        ).toContain('pointer-events: none')
    })

    it('sta sopra il chrome di pagina e sotto i fogli: 50 < z < 80', () => {
        const z = Number(/z-index:\s*(\d+)/.exec(fascia())?.[1])
        // Sopra AppBar (30), piede dell'azione (40) e barra di navigazione (50):
        // se ci finisse sotto, il contenuto continuerebbe a vedersi nella fascia.
        expect(z, 'la fascia è finita sotto la barra di navigazione o sotto il piede').toBeGreaterThan(50)
        // Sotto fogli e modali (80…120), che coprono lo schermo per conto loro e
        // portano il proprio fondo: sopra di loro sarebbe una striscia verde in
        // cima a un modale.
        expect(z, 'la fascia è finita sopra i fogli e i modali').toBeLessThan(80)
    })

    it('in Alto Contrasto diventa nera come l’intestazione, e sullo STESSO elemento', () => {
        // `<html>` porta sia `data-contrast` (app/layout.tsx) sia `cap-native`
        // (lib/mobile/native-shell.ts): scritti come discendenti, i due selettori
        // non combacerebbero mai — una regola verde e muta.
        const hc = blocco("[data-contrast='high'].cap-native [data-kv-shell]::before")
        expect(hc).toContain('#000000')
        expect(
            CSS,
            'la variante Alto Contrasto è diventata un selettore discendente: non può combaciare, ' +
                'perché le due classi stanno sullo stesso <html>',
        ).not.toContain("[data-contrast='high'] .cap-native [data-kv-shell]::before")
    })

    it('l’intestazione continua a dipingere la SUA fascia: il fondale si aggiunge, non sostituisce', () => {
        // Se un domani si togliesse il padding dell'AppBar «tanto c'è il fondale»,
        // il wordmark tornerebbe incollato alla status bar.
        expect(blocco('.cap-native [data-kv-shell] .kv-appbar')).toContain(
            'padding-top: env(safe-area-inset-top)',
        )
    })
})
