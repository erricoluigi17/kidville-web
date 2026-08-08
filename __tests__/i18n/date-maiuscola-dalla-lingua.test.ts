import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mascheraSorgente, fileSorgente, riga } from '../fixtures/sorgente'
import { formattaIstante } from '@/i18n/config'
import { conIniziale, formatData, nomeMese } from '@/lib/i18n/date'

/**
 * LOCK — LA MAIUSCOLA DI UNA DATA LA DECIDE LA LINGUA, NON IL CSS.
 *
 * Gemello di `__tests__/architecture/date-con-timezone.test.ts`: là il fuso, qui
 * le maiuscole. Stessa famiglia di difetto — una decisione che dipende dalla
 * lingua, delegata a un meccanismo che la lingua non la conosce.
 *
 * ─── IL DIFETTO (collaudo del 2026-08-08, localizzazione Q13) ────────────────
 * `text-transform: capitalize` è una regola tipografica INGLESE: alza l'iniziale
 * di OGNI parola. Applicata a una data italiana composta produce «Sabato 8
 * Agosto», dove l'italiano vuole «sabato 8 agosto» — al più «Sabato 8 agosto»,
 * con la sola iniziale di frase. Misurato sulla home genitore:
 *
 *   textContent            → «sabato 8 agosto»          (il DOM è giusto)
 *   getComputedStyle       → text-transform: capitalize
 *   reso a schermo         → «Sabato 8 Agosto»          (il CSS lo deforma)
 *
 * La stessa identica riga di CSS produce un esito GIUSTO in inglese («Saturday 8
 * August») e sbagliato in italiano: è la firma di una regola che dipende dalla
 * lingua e non la conosce.
 *
 * Non era un punto solo: erano QUATTRO, in due aree diverse (home genitore,
 * appello docente, diario docente, armadietto docente). Nessun lock lo vietava,
 * quindi la forma si è propagata copiando la riga di classi.
 *
 * ─── IL RIMEDIO, IN UN POSTO SOLO ───────────────────────────────────────────
 * `conIniziale()` in `src/lib/i18n/date.ts`: alza SOLO il primo carattere della
 * stringa già formattata. In inglese `Intl` produce da sé «Saturday 8 August»,
 * quindi l'operazione è idempotente e una funzione sola serve entrambe le lingue.
 * È la stessa scelta di prodotto che `nomeMese()` faceva già per il mese isolato
 * («così in IT resta Gennaio») — ora la fa una funzione sola per tutti e due.
 *
 * ─── COSA CONTROLLA ─────────────────────────────────────────────────────────
 *  1. `conIniziale` fa quello che dice, in italiano e in inglese, ed è idempotente;
 *  2. nessun elemento JSX di `src/` applica la classe `capitalize` a un contenuto
 *     che viene da una funzione di data — ed è il cuore: è la forma che si è
 *     propagata in quattro punti;
 *  3. il riconoscitore vede davvero il difetto e NON scambia per data un elenco
 *     di categorie (`{v.tipo}`, `{a.categoria}`), che è l'uso legittimo di
 *     `capitalize` in questo repo e resta permesso.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. COMPORTAMENTO
// ─────────────────────────────────────────────────────────────────────────────

/** 2026-08-08 a mezzogiorno: un sabato, mese con l'iniziale minuscola in italiano. */
const SABATO = '2026-08-08T12:00:00Z'
const OPZIONI_LUNGA = { weekday: 'long', day: 'numeric', month: 'long' } as const

describe('conIniziale — la maiuscola sta nella formattazione, dove la lingua è nota', () => {
    it('in italiano alza SOLO la prima lettera, non ogni parola', () => {
        expect(conIniziale('sabato 8 agosto')).toBe('Sabato 8 agosto')
        // È l'asserzione che conta: «Sabato 8 Agosto» è esattamente ciò che
        // produceva il CSS, ed è il testo che non deve più comparire.
        expect(conIniziale('sabato 8 agosto')).not.toBe('Sabato 8 Agosto')
    })

    it('in inglese non cambia niente: Intl ha già le maiuscole giuste (idempotenza)', () => {
        expect(conIniziale('Saturday 8 August')).toBe('Saturday 8 August')
        expect(conIniziale(conIniziale('sabato 8 agosto'))).toBe('Sabato 8 agosto')
    })

    it('una stringa vuota resta vuota (una data non valida non diventa «Invalid Date»)', () => {
        expect(conIniziale('')).toBe('')
        expect(conIniziale(formattaIstante(null, 'it', OPZIONI_LUNGA))).toBe('')
    })

    it('sulla data VERA delle quattro schermate: it minuscolo dopo la prima, en invariato', () => {
        expect(conIniziale(formattaIstante(SABATO, 'it', OPZIONI_LUNGA))).toBe('Sabato 8 agosto')
        expect(conIniziale(formattaIstante(SABATO, 'en', OPZIONI_LUNGA))).toBe('Saturday 8 August')
        // …e il formato «mese anno» dell'armadietto.
        expect(conIniziale(formatData(SABATO, 'it', 'meseAnno'))).toBe('Agosto 2026')
        expect(conIniziale(formatData(SABATO, 'en', 'meseAnno'))).toBe('August 2026')
    })

    it('nomeMese continua a comportarsi come prima (la regola è una sola, non due)', () => {
        // `nomeMese` alzava l'iniziale per conto suo: ora passa dalla stessa
        // funzione. Se le due strade tornassero a divergere, questa riga lo dice.
        expect(nomeMese(1, 'it')).toBe('Gennaio')
        expect(nomeMese(12, 'en')).toBe('December')
        expect(nomeMese(0, 'it')).toBe('')
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. LOCK DI FORMA — `capitalize` non tocca una data
// ─────────────────────────────────────────────────────────────────────────────

const SRC = path.join(process.cwd(), 'src')

/** Le funzioni che producono il TESTO di una data: chi le chiama, formatta una data. */
const PRODUTTORI =
    /\b(?:formatData|formattaIstante|intlDateTime|nomeMese|conIniziale)\s*\(|\.(?:dataLunga|dataBreve|dataOra|giornoMese|meseAnno)\s*\(/

/**
 * Gli identificatori LOCALI che portano una data: `const oggi = useClientValue(() =>
 * formattaIstante(…))`, `function formatDataLunga(iso, locale) { … }`. Senza questo
 * passaggio il riconoscitore vedrebbe solo `{oggi}` e `{formatDataLunga(d, l)}`, che
 * di per sé non dicono niente — ed è proprio la forma dei quattro punti misurati.
 *
 * La finestra è di 4 righe dalla dichiarazione: copre `function f() { … return
 * formattaIstante(…) }` e `const x = useClientValue(\n () => intlDateTime(…))`,
 * cioè le due forme reali, senza inseguire lo scope con un parser vero.
 */
function identificatoriDiData(senzaCommenti: string): Set<string> {
    const nomi = new Set<string>()
    const re = /\b(?:function|const|let|var)\s+([A-Za-z0-9_$]+)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(senzaCommenti)) !== null) {
        const finestra = senzaCommenti.slice(m.index).split('\n').slice(0, 4).join('\n')
        if (PRODUTTORI.test(finestra)) nomi.add(m[1])
    }
    return nomi
}

/** Indice del `<` che apre il tag JSX dentro cui cade `dentro`. */
function aperturaTag(senzaCommenti: string, dentro: number): number {
    for (let k = dentro; k >= 0; k--) {
        if (senzaCommenti[k] === '<' && /[A-Za-z]/.test(senzaCommenti[k + 1] ?? '')) return k
    }
    return -1
}

/**
 * La regione dell'ELEMENTO che porta quella classe: dal `<` di apertura fino alla
 * fine dei suoi figli (o alla fine del tag, se è auto-chiudente — in quel caso il
 * contenuto viaggia nelle prop, e le prop stanno dentro il tag).
 *
 * Il conteggio delle graffe e delle parentesi si fa su `struttura`, dove il
 * contenuto delle stringhe è mascherato: un `>` dentro una stringa di classi non
 * può più chiudere un tag che non era chiuso.
 */
function regioneElemento(struttura: string, apertura: number): [number, number] {
    let k = apertura + 1
    let nome = ''
    while (k < struttura.length && /[A-Za-z0-9_$.]/.test(struttura[k])) nome += struttura[k++]
    // Fine del tag di apertura: il primo `>` a profondità zero di `{` e `(`.
    let graffe = 0
    let tonde = 0
    let fineTag = -1
    let autoChiuso = false
    for (let i = k; i < struttura.length; i++) {
        const c = struttura[i]
        if (c === '{') graffe++
        else if (c === '}') graffe--
        else if (c === '(') tonde++
        else if (c === ')') tonde--
        else if (c === '>' && graffe === 0 && tonde === 0) {
            fineTag = i
            autoChiuso = struttura[i - 1] === '/'
            break
        }
    }
    if (fineTag < 0) return [apertura, struttura.length]
    if (autoChiuso) return [apertura, fineTag + 1]
    // Elemento con figli: si cerca il `</nome>` corrispondente, contando gli
    // annidamenti dello stesso tag.
    let livello = 1
    const apre = new RegExp(`<${nome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s/>]`, 'g')
    const chiude = new RegExp(`</${nome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*>`, 'g')
    let i = fineTag + 1
    while (i < struttura.length) {
        apre.lastIndex = i
        chiude.lastIndex = i
        const a = apre.exec(struttura)
        const c = chiude.exec(struttura)
        if (c === null) return [apertura, struttura.length]
        if (a !== null && a.index < c.index) {
            livello++
            i = a.index + 1
            continue
        }
        livello--
        if (livello === 0) return [apertura, c.index + c[0].length]
        i = c.index + 1
    }
    return [apertura, struttura.length]
}

/** I punti in cui `capitalize` cade su un elemento che rende una data. */
function capitalizeSuData(sorgente: string): Array<{ riga: number; frammento: string }> {
    const { senzaCommenti, struttura } = mascheraSorgente(sorgente)
    if (!/\bcapitalize\b/.test(senzaCommenti)) return []
    const nomi = identificatoriDiData(senzaCommenti)
    const colpevoli: Array<{ riga: number; frammento: string }> = []
    const re = /\bcapitalize\b/g
    let m: RegExpExecArray | null
    while ((m = re.exec(senzaCommenti)) !== null) {
        const apertura = aperturaTag(senzaCommenti, m.index)
        if (apertura < 0) continue
        const [da, a] = regioneElemento(struttura, apertura)
        const regione = senzaCommenti.slice(da, a)
        const perNome = [...nomi].some((n) => new RegExp(`\\b${n}\\b`).test(regione))
        if (PRODUTTORI.test(regione) || perNome) {
            colpevoli.push({ riga: riga(sorgente, m.index), frammento: regione.slice(0, 120).replace(/\s+/g, ' ') })
        }
    }
    return colpevoli
}

describe('lock · nessuna classe `capitalize` su un elemento che rende una data', () => {
    it('in tutto src/ la maiuscola delle date non è più delegata al CSS', () => {
        const colpevoli: string[] = []
        for (const file of fileSorgente(SRC)) {
            const sorgente = fs.readFileSync(file, 'utf8')
            for (const c of capitalizeSuData(sorgente)) {
                colpevoli.push(`${path.relative(process.cwd(), file)}:${c.riga} — ${c.frammento}`)
            }
        }
        expect(
            colpevoli,
            '`text-transform: capitalize` alza l\'iniziale di OGNI parola: è la regola inglese, e su ' +
            'una data italiana produce «Sabato 8 Agosto» al posto di «sabato 8 agosto». La maiuscola ' +
            'va messa dove la lingua è nota — `conIniziale()` di @/lib/i18n/date — e la classe tolta:\n' +
            colpevoli.join('\n'),
        ).toEqual([])
    })

    it('il riconoscitore vede il difetto e lascia stare gli usi legittimi', () => {
        // Senza questa prova, la regola qui sopra sarebbe verde anche su un
        // riconoscitore che non trova mai niente: la forma più silenziosa di non
        // controllare. I due frammenti sono copiati dal repo com'era e com'è.
        const rotto = [
            "function formatDataLunga(iso: string, locale: string): string {",
            "    const d = new Date(iso + 'T12:00:00');",
            "    return formattaIstante(d, locale, { weekday: 'long', day: 'numeric', month: 'long' });",
            "}",
            "const x = (",
            '    <p className="font-maven text-sm capitalize text-kidville-muted">{formatDataLunga(selectedDate, locale)}</p>',
            ");",
        ].join('\n')
        expect(capitalizeSuData(rotto).map((c) => c.riga), 'il difetto misurato deve essere visto').toEqual([6])

        // Uso LEGITTIMO: `capitalize` su un enumerato (il tipo di una prova, la
        // categoria di un capo). Non è una data e resta permesso.
        const sano = [
            "const y = (",
            '    <span className="font-maven text-xs capitalize text-kidville-muted">{v.tipo}</span>',
            ");",
        ].join('\n')
        expect(capitalizeSuData(sano), 'un enumerato non è una data').toEqual([])

        // E la data SENZA `capitalize` non è un difetto: è la forma corretta.
        const corretto = [
            "const z = (",
            '    <p className="font-maven text-sm">{conIniziale(formatDataLunga(selectedDate, locale))}</p>',
            ");",
        ].join('\n')
        expect(capitalizeSuData(corretto), 'senza la classe non c\'è niente da segnalare').toEqual([])

        // Un `capitalize` dentro un COMMENTO che racconta il difetto non è il
        // difetto: nel repo i commenti di questo tipo sono decine.
        const commentato = [
            "// prima qui c'era capitalize su formattaIstante(d, locale, {})",
            "const w = <p className=\"text-sm\">{conIniziale(oggi)}</p>;",
        ].join('\n')
        expect(capitalizeSuData(commentato), 'un commento non è codice').toEqual([])
    })
})
