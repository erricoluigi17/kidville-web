// @vitest-environment node
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * LOCK · l’occhio che mostra e nasconde una password è DISEGNATO in un posto solo.
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────
 *
 * Fino al 2026-09-01 quel disegno viveva dentro `src/app/auth/login/page.tsx`,
 * privato di quella schermata, e andava bene finché il campo password dell’app era
 * uno. Col cambio password i campi diventano quattro, in due schermate che un utente
 * vede a distanza di trenta secondi l’una dall’altra: la scorciatoia ovvia — ricopiare
 * i due `path` — avrebbe prodotto due disegni destinati a divergere al primo ritocco.
 *
 * È la stessa forma di difetto che questo repo ha già pagato due volte: il generatore
 * delle password temporanee (una copia in `scripts/` continuava a produrre il vecchio
 * formato, invisibile a `src/`) e le regole della password (tre risposte diverse alla
 * stessa domanda, ognuna coerente con sé stessa). In entrambi i casi nessun test
 * poteva vedere la divergenza, perché ogni copia era giusta da sola.
 *
 * ─── COME MISURA, E PERCHÉ NON GUARDA IL NOME DEL COMPONENTE ────────────────
 *
 * Guarda i `path` SVG, cioè la cosa che verrebbe ricopiata. Un lock sul nome
 * (`OcchioPassword`, `EyeIcon`) sarebbe verde davanti alla copia più probabile di
 * tutte: quella incollata con un nome diverso.
 *
 * ⚠️ E NON GUARDA I COMMENTI. Mezzo repo spiega i propri difetti citandoli: un
 * rilevatore a grep accuserebbe la spiegazione di essere il difetto. Il controllo
 * negativo in fondo lo verifica.
 */

const RADICE = process.cwd()
const SRC = path.join(RADICE, 'src')
const CASA = 'src/components/ui/OcchioPassword.tsx'

/**
 * I due tratti che identificano il disegno: la sbarra dell’occhio chiuso e la
 * mandorla dell’occhio aperto. Due e non uno: chi copiasse solo una delle due varianti
 * — l’errore più facile, perché sono due rami di un ternario — resterebbe invisibile a
 * un rilevatore che ne cerca una sola.
 */
const TRATTI = [
    { nome: 'sbarra (occhio chiuso)', re: /M3\s+3l18\s+18/ },
    { nome: 'mandorla (occhio aperto)', re: /M2\s+12c1-2\.5\s+5-7\s+10-7/ },
]

/** Il sorgente senza commenti: `/* … *\/` e `// …`. */
export function senzaCommenti(codice: string): string {
    return codice.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function sorgenti(dir: string): string[] {
    const out: string[] = []
    for (const voce of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, voce.name)
        if (voce.isDirectory()) out.push(...sorgenti(p))
        else if (/\.(ts|tsx)$/.test(voce.name)) out.push(p)
    }
    return out
}

const rel = (f: string) => path.relative(RADICE, f).split(path.sep).join('/')

/** I file di `src/` che DISEGNANO l’occhio (non quelli che ne parlano). */
export function fileCheDisegnano(tratto: RegExp, testi: Array<{ file: string; codice: string }>): string[] {
    return testi.filter(({ codice }) => tratto.test(senzaCommenti(codice))).map(({ file }) => file)
}

describe('lock architettura · l’occhio della password si disegna una volta sola', () => {
    const testi = sorgenti(SRC).map((f) => ({ file: rel(f), codice: fs.readFileSync(f, 'utf8') }))

    it('la misura vede davvero il repo (senza, tutto il resto è verde sul vuoto)', () => {
        expect(testi.length).toBeGreaterThan(500)
        expect(fs.existsSync(path.join(RADICE, CASA)), `${CASA} non esiste`).toBe(true)
    })

    for (const { nome, re } of TRATTI) {
        it(`il tratto «${nome}» sta solo in ${CASA}`, () => {
            expect(
                fileCheDisegnano(re, testi).sort(),
                'Questo tratto dell’occhio è disegnato in più di un file. Non è un doppione ' +
                'estetico: due disegni della stessa icona divergono al primo ritocco, e le due ' +
                'schermate che li montano — la login e il cambio password — un utente le vede a ' +
                `trenta secondi l’una dall’altra. Il componente esiste: importa \`OcchioPassword\` da \`${CASA}\`.`,
            ).toEqual([CASA])
        })
    }

    it('la login MONTA il componente condiviso (controllo positivo: un lock di sole assenze resta verde sul vuoto)', () => {
        const login = fs.readFileSync(path.join(SRC, 'app/auth/login/page.tsx'), 'utf8')
        expect(senzaCommenti(login)).toMatch(/from\s+['"]@\/components\/ui\/OcchioPassword['"]/)
    })

    it('il rilevatore NON scambia un commento per un disegno', () => {
        // Se cadesse, i due divieti qui sopra sarebbero verdi per il motivo sbagliato.
        const finto = [
            { file: 'finto.tsx', codice: '// qui c’era <path d="M3 3l18 18" /> copiato dalla login' },
            { file: 'finto2.tsx', codice: '/* <path d="M2 12c1-2.5 5-7 10-7s9 4.5 10 7" /> */' },
        ]
        for (const { re } of TRATTI) expect(fileCheDisegnano(re, finto)).toEqual([])
    })

    it('il rilevatore riconosce il disegno VERO (prova di validità permanente)', () => {
        const vero = [{ file: 'vero.tsx', codice: '<path d="M3 3l18 18" />\n<path d="M2 12c1-2.5 5-7 10-7s9 4.5 10 7z" />' }]
        for (const { nome, re } of TRATTI) {
            expect(fileCheDisegnano(re, vero), `il rilevatore non vede più «${nome}»`).toEqual(['vero.tsx'])
        }
    })
})
