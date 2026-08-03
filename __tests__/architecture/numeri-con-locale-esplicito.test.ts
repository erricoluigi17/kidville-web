import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mascheraSorgente, fileSorgente, riga } from '../fixtures/sorgente'

/**
 * NESSUN NUMERO FORMATTATO CON IL LOCALE DEL **RUNTIME**.
 *
 * ─── IL DIFETTO (verificatore adversariale, 2026-08-03) ─────────────────────
 * `teacher/gallery/page.tsx` componeva la dimensione di un video così:
 *
 *     (file.size / (1024 * 1024)).toLocaleString(undefined, { maximumFractionDigits: 1 })
 *
 * `undefined` come primo argomento sembra «nessuna preferenza» e invece è una
 * scelta precisa: **la lingua del processo che esegue**. Nel browser è quella
 * del sistema operativo di chi guarda, sul server è quella di Vercel (`en-US`).
 * Con l'interfaccia inglese su un browser italiano usciva «50,3 MB» dentro una
 * frase inglese; con l'interfaccia italiana su un browser inglese, il contrario.
 * Un difetto che sulla macchina di chi lo scrive non si vede mai — ed è la
 * ragione per cui questo lock esiste invece di una raccomandazione.
 *
 * ─── COSA VIETA, E COSA NO ─────────────────────────────────────────────────
 * Vieta DUE forme, che sono lo stesso difetto scritto in due modi:
 *
 *   · `toLocaleString(undefined, …)` — e `toLocaleDateString`/`toLocaleTimeString`;
 *   · `toLocaleString()` **senza argomenti**, più `new Intl.NumberFormat()` e
 *     `new Intl.DateTimeFormat()` senza locale (o con `undefined`).
 *
 * ⚠️ Le seconde sono state aggiunte il 2026-08-03, dopo che un verificatore
 * adversariale ha fatto notare che il lock era più STRETTO del suo titolo:
 * `new Date(x).toLocaleDateString()` — la forma più naturale, quella che scrive
 * chi non sta pensando al locale — passava indenne, pur avendo esattamente lo
 * stesso effetto di `toLocaleDateString(undefined)`. Un lock che ferma la
 * variante rara e lascia passare quella comune protegge il proprio nome, non il
 * codice. All'aggiunta `src/` non conteneva nessuna occorrenza delle forme
 * nuove (verificato con `grep` su tutto l'albero): estenderlo non ha chiesto di
 * riscrivere niente, e da oggi il difetto non si può riaprire nemmeno per
 * distrazione.
 *
 * Il posto giusto per un decimale dentro una frase è
 * `formattaDecimale`/`formattaMegabyte` (`@/lib/i18n/numero`), che il locale lo
 * PRETENDE come parametro; per le date c'è `@/lib/i18n/date`, e il fuso lo
 * impone già `date-senza-fuso.test.ts`.
 *
 * NON vieta la lingua cablata (`'it-IT'`): in questo progetto è una convenzione
 * viva e deliberata per il DENARO (`src/lib/format/valuta.ts` e i formattatori
 * dei cruscotti), e un lock che la vietasse chiederebbe di riscrivere codice
 * corretto — il modo più rapido di far mettere un'esenzione a chi passa. Il
 * limite è dichiarato qui invece che nascosto: `'it-IT'` dentro una frase
 * TRADOTTA resta un difetto, e lo trova una persona, non questo file.
 *
 * E non vieta `Intl.NumberFormat(qualcosa)`: se un argomento c'è, che sia
 * giusto lo decide chi legge. Questo file misura solo l'assenza di scelta.
 */

const RADICE = process.cwd()
const SRC = path.join(RADICE, 'src')

/**
 * `.toLocale*(undefined` **e** `.toLocale*()` — con lo spazio e gli a capo che
 * un formattatore potrebbe metterci in mezzo. Si cerca sul sorgente MASCHERATO
 * (commenti e stringhe spenti): la frase che racconta il difetto, qui sopra e
 * nei due file corretti, non deve far diventare rosso il lock che la descrive.
 *
 * `(?:undefined\b|\))` è la parte che è costata il rilievo: senza il secondo
 * ramo, la chiamata senza argomenti — che è la forma che si scrive per prima —
 * non veniva vista.
 */
const LOCALE_DEL_RUNTIME = /\.toLocale(?:String|DateString|TimeString)\s*\(\s*(?:undefined\b|\))/g

/**
 * `new Intl.NumberFormat()` / `new Intl.DateTimeFormat()` senza locale, o con
 * `undefined`. È la stessa scelta implicita di `toLocaleString`, un piano più
 * in basso: `toLocaleString` costruisce proprio un `Intl` e gli passa il primo
 * argomento — quindi vietare l'uno e non l'altro sarebbe vietare la scorciatoia
 * e lasciare aperta la strada.
 */
const INTL_SENZA_LINGUA = /new\s+Intl\.(?:NumberFormat|DateTimeFormat)\s*\(\s*(?:undefined\b|\))/g

const VIETATE = [LOCALE_DEL_RUNTIME, INTL_SENZA_LINGUA]

const rel = (f: string) => path.relative(RADICE, f).split(path.sep).join('/')

function occorrenze(sorgenti: string[]): string[] {
    const out: string[] = []
    for (const f of sorgenti) {
        const testo = fs.readFileSync(f, 'utf8')
        const { senzaCommenti } = mascheraSorgente(testo)
        for (const forma of VIETATE) {
            forma.lastIndex = 0
            for (const m of senzaCommenti.matchAll(forma)) {
                out.push(`${rel(f)}:${riga(testo, m.index)}`)
            }
        }
    }
    return out.sort()
}

const TUTTI = fileSorgente(SRC)

describe('numeri e date: il locale è un parametro, mai quello del runtime', () => {
    it('ci sono sorgenti da controllare (senza questa asserzione il lock si autoingannerebbe)', () => {
        // Un percorso sbagliato renderebbe verde il lock semplicemente perché non
        // troverebbe niente da scandire: è già successo in questo repo.
        expect(TUTTI.length).toBeGreaterThan(300)
    })

    it('il rilevatore riconosce la forma vietata (controllo positivo)', () => {
        const finto = path.join(RADICE, '__tests__', 'fixtures', 'sorgente.ts')
        // Si costruisce il caso su un file vero, in memoria: se il rilevatore
        // smettesse di vedere la forma, questa asserzione cadrebbe prima di
        // quella qui sotto — che altrimenti resterebbe verde per il motivo
        // sbagliato, cioè perché non guarda più niente.
        const esempio = "const mb = (n / 1048576).toLocaleString(undefined, { maximumFractionDigits: 1 })"
        const { senzaCommenti } = mascheraSorgente(esempio)
        LOCALE_DEL_RUNTIME.lastIndex = 0
        expect(LOCALE_DEL_RUNTIME.test(senzaCommenti)).toBe(true)
        expect(fs.existsSync(finto)).toBe(true)
    })

    it('…e riconosce anche le forme SENZA argomenti, che sono quelle che si scrivono per prime', () => {
        // Il rilievo del 2026-08-03: il lock fermava `toLocaleString(undefined)`
        // e lasciava passare `toLocaleDateString()`, che ha lo stesso identico
        // effetto ed è la forma che viene in mente per prima. Ognuna di queste
        // righe deve essere vista da sola: se domani qualcuno «semplifica» il
        // regex togliendo il ramo `\)`, qui si vede subito.
        const casi = [
            'const q = new Date(x).toLocaleDateString()',
            'const n = valore.toLocaleString()',
            'const o = ora.toLocaleTimeString( )',
            'const f = new Intl.NumberFormat().format(v)',
            'const g = new Intl.DateTimeFormat(undefined, { dateStyle: "short" })',
        ]
        for (const caso of casi) {
            const { senzaCommenti } = mascheraSorgente(caso)
            const visto = VIETATE.some((forma) => {
                forma.lastIndex = 0
                return forma.test(senzaCommenti)
            })
            expect(visto, `il rilevatore non vede: ${caso}`).toBe(true)
        }
    })

    it('CONTROLLO NEGATIVO — una lingua indicata NON è un difetto (il lock non è un divieto di `Intl`)', () => {
        // Senza questo caso il modo più rapido di far tornare verde il lock
        // sarebbe allargare i regex fino a vietare `Intl` in blocco: passerebbe
        // la suite e romperebbe `valuta.ts` e `numero.ts`, cioè le due funzioni
        // che il locale lo pretendono davvero.
        const ammesse = [
            "const f = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' })",
            'const g = new Intl.NumberFormat(bcp47(locale), { maximumFractionDigits: cifreMax })',
            "const d = new Intl.DateTimeFormat(bcp47(locale), { timeZone: 'Europe/Rome' })",
            "const s = valore.toLocaleString('it-IT')",
        ]
        for (const caso of ammesse) {
            const { senzaCommenti } = mascheraSorgente(caso)
            const visto = VIETATE.some((forma) => {
                forma.lastIndex = 0
                return forma.test(senzaCommenti)
            })
            expect(visto, `il rilevatore accusa codice corretto: ${caso}`).toBe(false)
        }
    })

    it('nessun locale del RUNTIME in `src/` (né `toLocale*` senza lingua, né `Intl` senza lingua)', () => {
        expect(
            occorrenze(TUTTI),
            '`toLocaleString(undefined, …)` — e la sua gemella senza argomenti, e `new Intl.NumberFormat()` ' +
                'senza locale — formattano con la lingua del RUNTIME, non con quella dell’interfaccia: la ' +
                'stessa schermata mostra «50,3» a chi ha il sistema in italiano e «50.3» a chi ce l’ha in ' +
                'inglese, indipendentemente da `KV_LOCALE`. Usa ' +
                '`formattaDecimale`/`formattaMegabyte` (`@/lib/i18n/numero`) per i numeri e ' +
                '`@/lib/i18n/date` per le date: il locale lo pretendono come parametro, e arriva da ' +
                '`useLocale()`.',
        ).toEqual([])
    })
})
