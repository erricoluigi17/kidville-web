import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

/**
 * UN SOLO GENERATORE DI PASSWORD, E IL MOTIVO PER CUI SERVE UN LOCK.
 *
 * Il 2026-08-22 il cron ha spedito 67 password del vecchio formato
 * (`randomBytes(18).toString('base64url') + 'Aa1!'`): illeggibili su un telefono,
 * indettabili al telefono. Il formato è stato rifatto in
 * `src/lib/auth/password-temporanea.ts`, con l'alfabeto e l'entropia motivati lì.
 *
 * Il difetto che questo lock impedisce non è «qualcuno cambia il formato»: è
 * «qualcuno ne aggiunge un SECONDO, da un'altra parte, e nessuno se ne accorge».
 * Non è un'ipotesi — quando il generatore è stato sostituito, la copia dentro
 * `scripts/repair_parent_identities.mjs` continuava a produrre il vecchio formato
 * e nessun test la vedeva, perché gli script non sono importati da `src/`.
 *
 * Per questo il perimetro comprende `scripts/`: è esattamente il posto in cui una
 * regola del prodotto smette di valere senza che il gate diventi rosso.
 */

const RADICI = ['src', 'scripts']
const SORGENTE_LEGITTIMA = join('src', 'lib', 'auth', 'password-temporanea.ts')
/** La copia dichiarata: uno script .mjs non può importare dagli alias di `src/`. */
const COPIA_DICHIARATA = join('scripts', 'repair_parent_identities.mjs')

const ESTENSIONI = ['.ts', '.tsx', '.mjs', '.js']

function file(dir: string): string[] {
    let out: string[] = []
    for (const voce of readdirSync(dir)) {
        if (voce === 'node_modules' || voce.startsWith('.')) continue
        const p = join(dir, voce)
        if (statSync(p).isDirectory()) out = out.concat(file(p))
        else if (ESTENSIONI.some((e) => voce.endsWith(e))) out.push(p)
    }
    return out
}

describe('la password temporanea nasce in un posto solo', () => {
    const tutti = RADICI.flatMap(file)

    it('trova i file da controllare (prova di sanità)', () => {
        // Senza questa asserzione, un `readdirSync` che restituisse una lista vuota
        // renderebbe VERDE ogni controllo qui sotto: il lock guarderebbe il nulla e
        // direbbe che va tutto bene. È la lezione già scritta in
        // `ritmo-email-un-posto-solo.test.ts`.
        expect(tutti.length).toBeGreaterThan(200)
        expect(tutti).toContain(SORGENTE_LEGITTIMA)
        expect(tutti).toContain(COPIA_DICHIARATA)
    })

    it('nessuno ricrea il vecchio formato base64url + suffisso fisso', () => {
        const colpevoli = tutti.filter((f) => {
            const testo = readFileSync(f, 'utf8')
            // Solo il CODICE, non la prosa: le righe di commento raccontano il
            // difetto passato e devono poterlo nominare.
            const codice = testo
                .split('\n')
                .filter((r) => !/^\s*(\*|\/\/|\/\*)/.test(r))
                .join('\n')
            return /toString\(\s*['"]base64url['"]\s*\)\s*\+/.test(codice)
        })
        expect(colpevoli).toEqual([])
    })

    it('nessuno genera password con Math.random()', () => {
        const colpevoli = tutti.filter((f) => {
            const testo = readFileSync(f, 'utf8')
            return /Math\.random\(\)/.test(testo) && /password/i.test(testo)
        })
        expect(colpevoli).toEqual([])
    })

    it('l\'alfabeto senza caratteri ambigui vive solo nella sorgente e nella copia dichiarata', () => {
        // L'alfabeto Crockford è la firma del generatore: se compare altrove,
        // qualcuno ne ha scritto un secondo invece di importare il primo.
        const colpevoli = tutti.filter(
            (f) =>
                f !== SORGENTE_LEGITTIMA &&
                f !== COPIA_DICHIARATA &&
                readFileSync(f, 'utf8').includes('0123456789abcdefghjkmnpqrstvwxyz'),
        )
        expect(colpevoli).toEqual([])
    })

    it('la copia dichiarata resta allineata alla sorgente sui due alfabeti', () => {
        // Se qualcuno cambia l'alfabeto in `src/` e dimentica lo script, la
        // segreteria si ritrova a dettare due formati diversi. Questo è il test che
        // il 2026-08-22 non c'era.
        const sorgente = readFileSync(SORGENTE_LEGITTIMA, 'utf8')
        const copia = readFileSync(COPIA_DICHIARATA, 'utf8')
        for (const alfabeto of ['0123456789abcdefghjkmnpqrstvwxyz', 'ACDEFHJKMNPRTVWXY']) {
            expect(sorgente).toContain(alfabeto)
            expect(copia).toContain(alfabeto)
        }
    })
})
