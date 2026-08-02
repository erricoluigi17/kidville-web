import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mascheraSorgente, fineParentesi, fileSorgente, riga } from '../fixtures/sorgente'

/**
 * LOCK — nessuna `toLocale*String` su una DATA senza fuso e senza regione.
 *
 * ─── PERCHÉ ESISTE (e perché il lock che c'era già non bastava) ──────────────
 *
 * `date-con-timezone.test.ts` sorveglia `new Intl.DateTimeFormat(` e pretende che
 * ogni costruzione dichiari il suo `timeZone`. È il lock giusto, e ha una fessura
 * larga quanto il prodotto: **`d.toLocaleDateString(l, o)` non è un
 * `new Intl.DateTimeFormat(`**. È la stessa identica cosa per la specifica —
 * `Date.prototype.toLocaleDateString` costruisce un `Intl.DateTimeFormat`
 * internamente — ma non ne ha la forma, quindi la regex non la vedeva.
 *
 * Il collaudo del 2026-08-01 dichiarava «0 `toLocale*` senza locale», e la
 * dichiarazione era vera e inutile: il difetto non era il locale ASSENTE, era il
 * locale SBAGLIATO (`'it'`/`'en'` grezzi da next-intl invece di `bcp47(locale)`)
 * e il fuso MAI dichiarato. Contate quel giorno: 71 chiamate su date, di cui 43
 * col locale grezzo. Zero rosse.
 *
 * ─── PERCHÉ IMPORTA QUI PIÙ CHE ALTROVE ─────────────────────────────────────
 *
 *  · FUSO. `Intl` senza `timeZone` usa quello DELL'AMBIENTE: su Vercel il
 *    processo gira in UTC, il browser di una famiglia in `Europe/Rome`. Fra le
 *    00:00 e le 02:00 italiane lo stesso istante rende due GIORNI diversi. In
 *    questo prodotto la data è la chiave di presenze, registro e diario, e il
 *    vincolo di unicità del registro è (sede, classe, data, ora): un giorno di
 *    scarto è una presenza segnata sul giorno sbagliato. Misurato il 2026-08-01
 *    alle 01:08 — un incasso vero sparito da un KPI perché il server contava in
 *    UTC e l'utente in ora italiana.
 *
 *  · REGIONE. `LOCALES = ['it','en']` espone un locale SENZA regione, e `Intl`
 *    risolve `'en'` su **en-US**: mese/giorno/anno e ore 12h AM/PM. «8/10/2026»
 *    per una famiglia in Italia è il 10 agosto, per `Intl` era l'8 ottobre.
 *
 * ─── LA REGOLA ──────────────────────────────────────────────────────────────
 *
 * In `src/`, ogni `toLocaleDateString` / `toLocaleTimeString` — e ogni
 * `toLocaleString` invocata su una data — deve:
 *   1. dichiarare `timeZone` fra le opzioni;
 *   2. ricevere un locale con la REGIONE (`bcp47(locale)`, o un letterale
 *      `xx-YY`), mai `'it'`/`'en'` nudi né la variabile `locale` di next-intl.
 *
 * Il modo normale di rispettarla è non usarle affatto:
 *   · `formatData(input, locale, formato)` / `useDateFormat()` per il testo a schermo;
 *   · `intlDateTime(locale, opzioni)` per le opzioni fuori standard;
 *   · `dataCivile(istante)` per la data `YYYY-MM-DD` da confrontare col database.
 * Tutte e tre passano da `@/i18n/config` e mettono fuso e regione per costruzione.
 *
 * I numeri restano fuori: `n.toLocaleString('it-IT', { maximumFractionDigits: 1 })`
 * non ha né un fuso né un giorno da sbagliare. Il riconoscitore che li distingue
 * dalle date è provato qui sotto su casi veri, in entrambe le direzioni: senza
 * quella prova, un riconoscitore che non riconoscesse più NULLA lascerebbe il
 * lock verde per sempre.
 */

const SRC = path.join(process.cwd(), 'src')

/** I tre metodi sorvegliati. I primi due sono di `Date` e basta. */
const METODI = ['toLocaleDateString', 'toLocaleTimeString', 'toLocaleString'] as const

/**
 * Le opzioni che esistono SOLO per una data: se compaiono, l'oggetto formattato è
 * una data anche quando il ricevente non si chiama `Date`.
 */
const OPZIONI_DI_DATA =
    /\b(timeZone|weekday|era|year|month|day|hour|minute|second|dateStyle|timeStyle|hour12|hourCycle|fractionalSecondDigits)\s*:/

/**
 * Inizio (indice) dell'espressione RICEVENTE di `…​.metodo(`, dato l'indice del
 * punto. Cammina all'indietro sul testo `struttura` (dove nessuna parentesi vive
 * dentro una stringa) attraversando parentesi bilanciate, indici, identificatori
 * e catene di punti — così `new Date(x).toLocaleString` restituisce
 * `new Date(x)` e `(a / b).toLocaleString` restituisce `(a / b)`.
 */
function inizioRicevente(strut: string, idxPunto: number): number {
    let k = idxPunto - 1
    while (k >= 0 && /\s/.test(strut[k])) k--
    for (;;) {
        if (k < 0) return 0
        const c = strut[k]
        if (c === ')' || c === ']') {
            const aperta = c === ')' ? '(' : '['
            let livello = 0
            while (k >= 0) {
                if (strut[k] === c) livello++
                else if (strut[k] === aperta) {
                    livello--
                    if (livello === 0) break
                }
                k--
            }
            k--
            while (k >= 0 && /\s/.test(strut[k])) k--
            // Un `(` preceduto da qualcosa che non è un identificatore chiude
            // l'espressione: `(a / b)` è tutto il ricevente.
            if (k < 0 || !/[A-Za-z0-9_$]/.test(strut[k])) return k + 1
            continue
        }
        if (/[A-Za-z0-9_$]/.test(c)) {
            while (k >= 0 && /[A-Za-z0-9_$]/.test(strut[k])) k--
            let j = k
            while (j >= 0 && /\s/.test(strut[j])) j--
            // `.` → la catena continua a sinistra; una parola (`new`, `await`)
            // fa parte del ricevente e si continua a leggere.
            if (j >= 0 && (strut[j] === '.' || /[A-Za-z0-9_$]/.test(strut[j]))) {
                k = j
                continue
            }
            return k + 1
        }
        return k + 1
    }
}

/** Il PRIMO argomento di una chiamata, come testo (fino alla prima virgola di livello 0). */
function primoArgomento(strut: string, apertura: number, chiusura: number): string {
    let livello = 0
    for (let k = apertura; k < chiusura; k++) {
        const c = strut[k]
        if (c === '(' || c === '[' || c === '{') livello++
        else if (c === ')' || c === ']' || c === '}') {
            livello--
            if (livello === 0) return strut.slice(apertura + 1, k)
        } else if (c === ',' && livello === 1) return strut.slice(apertura + 1, k)
    }
    return ''
}

export interface Chiamata {
    dove: string
    metodo: string
    ricevente: string
    argomenti: string
    primoArg: string
}

/** Tutte le `toLocale*` su una DATA in un sorgente. Esportata: è ciò che si prova. */
export function chiamateSuDate(src: string, etichetta: string): Chiamata[] {
    const { struttura, senzaCommenti } = mascheraSorgente(src)
    const trovate: Chiamata[] = []
    for (const metodo of METODI) {
        const re = new RegExp(`\\.\\s*${metodo}\\s*\\(`, 'g')
        let m: RegExpExecArray | null
        while ((m = re.exec(struttura))) {
            const apertura = m.index + m[0].length - 1
            const chiusura = fineParentesi(struttura, apertura)
            // `senzaCommenti` per leggere i CONTENUTI (i nomi delle opzioni, i
            // letterali di locale): in `struttura` sarebbero tutti `x`.
            const argomenti = senzaCommenti.slice(apertura, chiusura)
            const ricevente = senzaCommenti.slice(inizioRicevente(struttura, m.index), m.index)
            if (metodo === 'toLocaleString') {
                // L'unico ambiguo: `Number.prototype.toLocaleString` esiste ed è
                // legittimo. È una data se il ricevente lo è, o se fra le opzioni
                // c'è un campo che solo una data possiede.
                const suUnaData = /\bDate\b/.test(ricevente) || OPZIONI_DI_DATA.test(argomenti)
                if (!suUnaData) continue
            }
            trovate.push({
                dove: `${etichetta}:${riga(src, m.index)}`,
                metodo,
                ricevente: ricevente.trim(),
                argomenti,
                primoArg: primoArgomento(struttura === senzaCommenti ? struttura : senzaCommenti, apertura, chiusura).trim(),
            })
        }
    }
    return trovate
}

/** Tutte le chiamate su date di `src/`, in ordine di file. */
function tutteLeChiamate(): Chiamata[] {
    const out: Chiamata[] = []
    for (const file of fileSorgente(SRC)) {
        out.push(...chiamateSuDate(fs.readFileSync(file, 'utf8'), path.relative(process.cwd(), file)))
    }
    return out
}

/** Il primo argomento porta la REGIONE? `bcp47(…)`, o un letterale `xx-YY`. */
function haRegione(primoArg: string): boolean {
    if (/\bbcp47\s*\(/.test(primoArg)) return true
    const letterale = /^['"`]([A-Za-z]{2,3}-[A-Za-z0-9]{2,4})['"`]$/.exec(primoArg)
    return letterale !== null
}

describe('lock architettura · nessuna toLocale* su una data senza fuso', () => {
    it('ogni toLocale* su una data dichiara timeZone', () => {
        const colpevoli = tutteLeChiamate()
            .filter((c) => !/\btimeZone\s*:/.test(c.argomenti))
            .map((c) => `${c.dove} — ${c.ricevente}.${c.metodo}(${c.primoArg || '…'})`)
        expect(
            colpevoli,
            'Queste chiamate formattano una data nel fuso DELL\'AMBIENTE (UTC su Vercel, ' +
                'Europe/Rome nel browser di una famiglia): lo stesso istante rende due GIORNI ' +
                'diversi, e qui la data è la chiave di presenze, registro e diario.\n' +
                'Il rimedio non è aggiungere `timeZone` a mano: è passare da @/i18n/config —\n' +
                '  · formatData(input, locale, formato) / useDateFormat()  → testo a schermo\n' +
                '  · intlDateTime(locale, opzioni).format(d)               → opzioni fuori standard\n' +
                '  · dataCivile(istante)                                   → YYYY-MM-DD per il database\n' +
                colpevoli.join('\n'),
        ).toEqual([])
    })

    it('ogni toLocale* su una data riceve un locale CON la regione, mai «it»/«en» nudi', () => {
        const colpevoli = tutteLeChiamate()
            .filter((c) => !haRegione(c.primoArg))
            .map((c) => `${c.dove} — primo argomento: «${c.primoArg || '(nessuno)'}»`)
        expect(
            colpevoli,
            'Intl risolve «en» nudo su en-US: mese/giorno/anno e ore 12h AM/PM. «8/10/2026» ' +
                'per una famiglia in Italia è il 10 agosto, per Intl era l\'8 ottobre. La regione ' +
                'si decide in LOCALE_BCP47 (src/i18n/config.ts) e si applica con bcp47(locale).\n' +
                colpevoli.join('\n'),
        ).toEqual([])
    })

    // ── Le prove che tengono onesto il lock ───────────────────────────────────

    it('il riconoscitore vede una data e NON vede un numero', () => {
        // Positivo: le tre forme che il repo aveva davvero.
        const conData = `
            const a = new Date(iso).toLocaleTimeString(locale, { hour: '2-digit' });
            const b = d.toLocaleDateString(locale);
            const c = new Date(x).toLocaleString('it-IT');
        `
        expect(chiamateSuDate(conData, 'finto.ts').map((c) => c.metodo)).toEqual([
            'toLocaleDateString',
            'toLocaleTimeString',
            'toLocaleString',
        ])

        // Negativo: i due numeri veri del repo restano fuori.
        const conNumeri = `
            const mb = (f.file.size / (1024 * 1024)).toLocaleString('it-IT', { maximumFractionDigits: 1 });
            const eur = \`\${n.toLocaleString('it-IT', { minimumFractionDigits: 2 })} €\`;
        `
        expect(chiamateSuDate(conNumeri, 'finto.ts')).toEqual([])

        // …ma una data mascherata da variabile qualunque viene comunque vista,
        // perché `weekday` non esiste per un numero.
        const dataSenzaNome = `const s = q.toLocaleString(locale, { weekday: 'long' });`
        expect(chiamateSuDate(dataSenzaNome, 'finto.ts')).toHaveLength(1)
    })

    it('il lock diventa rosso sul difetto vero e verde sul rimedio vero', () => {
        // Il caso emblematico del collaudo: ChatMessageArea.tsx aveva la riga 72
        // corretta e la 36 no, nello stesso file.
        const difetto = `return new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });`
        const rotte = chiamateSuDate(difetto, 'ChatMessageArea.tsx')
        expect(rotte).toHaveLength(1)
        expect(/\btimeZone\s*:/.test(rotte[0].argomenti)).toBe(false) // ⟵ senza fuso
        expect(haRegione(rotte[0].primoArg)).toBe(false) // ⟵ e senza regione

        // Rimedio 1: si smette di usarla (è quello adottato ovunque nel repo).
        expect(
            chiamateSuDate(
                `return intlDateTime(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));`,
                'ChatMessageArea.tsx',
            ),
        ).toEqual([])

        // Rimedio 2: la si tiene, ma dichiarando fuso e regione. Entrambi passano:
        // il lock vieta il DIFETTO, non una forma di scrittura.
        const sanata = chiamateSuDate(
            `return new Date(iso).toLocaleTimeString(bcp47(locale), { hour: '2-digit', timeZone: APP_TIMEZONE });`,
            'ChatMessageArea.tsx',
        )
        expect(sanata).toHaveLength(1)
        expect(/\btimeZone\s*:/.test(sanata[0].argomenti)).toBe(true)
        expect(haRegione(sanata[0].primoArg)).toBe(true)
    })

    it('la scansione guarda davvero dentro src/ (e non un elenco vuoto)', () => {
        // Un lock che non trova nessun file è verde per sempre. Qui si verifica
        // che la scansione legga il sorgente vero: `formatData` e `intlDateTime`,
        // i due rimedi, devono essere in uso in decine di punti.
        const file = fileSorgente(SRC)
        expect(file.length).toBeGreaterThan(400)
        const conRimedio = file.filter((f) => {
            const s = fs.readFileSync(f, 'utf8')
            return /\b(useDateFormat|formatData|intlDateTime|dataCivile)\s*[(<]/.test(s)
        })
        expect(conRimedio.length).toBeGreaterThan(30)
    })

    it('«adesso» non si formatta nel corpo del render di un componente client', () => {
        // `date-con-timezone.test.ts` vieta `.format(new Date())` fuori da
        // `useClientValue`: il server rende l'HTML col SUO orologio, il browser
        // col proprio, e fra le 00:00 e le 02:00 italiane le due date non
        // coincidono. Sostituendo le `toLocale*` è nato un idioma NUOVO,
        // `formattaIstante(new Date(), …)`, che quel lock non riconosce: senza
        // questa regola la copertura si sarebbe ristretta in silenzio.
        //
        // ECCEZIONI dichiarate: i tre punti in cui la data di «adesso» è il
        // timbro di generazione di un PDF, calcolato dentro il gestore del
        // CLICK. Lì non c'è nessun render da idratare, e pretendere
        // `useClientValue` significherebbe congelare al primo render l'ora
        // stampata su un documento.
        const SU_CLIC: Record<string, string> = {
            'src/app/(dashboard)/admin/modulistica/page.tsx': 'timbro «data di stampa» dentro l\'esportazione PDF',
            'src/app/(dashboard)/parent/modulistica/page.tsx': 'riga «luogo e data» dentro l\'esportazione PDF',
            'src/components/features/teacher/attendance/MonthlyAttendanceTable.tsx':
                'metadato del PDF, dentro handleExport',
        }

        const colpevoli: string[] = []
        const eccezioniSmentite = new Set(Object.keys(SU_CLIC))
        for (const file of fileSorgente(SRC)) {
            const src = fs.readFileSync(file, 'utf8')
            if (!/^\s*['"]use client['"]/m.test(src)) continue
            const { struttura } = mascheraSorgente(src)
            const relativo = path.relative(process.cwd(), file)

            const protetti: [number, number][] = []
            const reHook = /\buseClientValue\s*\(/g
            let h: RegExpExecArray | null
            while ((h = reHook.exec(struttura))) {
                const apertura = h.index + h[0].length - 1
                protetti.push([apertura, fineParentesi(struttura, apertura)])
            }

            const re = /\bformattaIstante\s*\(\s*new\s+Date\s*\(\s*\)/g
            let m: RegExpExecArray | null
            while ((m = re.exec(struttura))) {
                const indice = m.index
                if (protetti.some(([a, b]) => indice > a && indice < b)) continue
                if (relativo in SU_CLIC) {
                    eccezioniSmentite.delete(relativo)
                    continue
                }
                colpevoli.push(`${relativo}:${riga(src, indice)}`)
            }
        }
        expect(
            colpevoli,
            'Qui «adesso» viene formattato nel corpo del render: il valore del server e quello ' +
                'del browser possono cadere in due GIORNI diversi e React segnala il ' +
                'disallineamento. Va dietro useClientValue (@/lib/hooks/use-client-value), ' +
                'come il saluto orario.\n' +
                colpevoli.join('\n'),
        ).toEqual([])
        // Un'eccezione che non trova più il suo caso è una riga morta che dà il
        // permesso a nessuno — e che coprirebbe il prossimo caso vero.
        expect(
            [...eccezioniSmentite],
            'Queste eccezioni non corrispondono più a nessun punto del codice: vanno tolte.',
        ).toEqual([])
    })

    it('la regione è riconosciuta solo quando c\'è per davvero', () => {
        expect(haRegione("'it-IT'")).toBe(true)
        expect(haRegione("'en-GB'")).toBe(true)
        expect(haRegione("'en-CA'")).toBe(true)
        expect(haRegione('bcp47(locale)')).toBe(true)
        expect(haRegione("'it'")).toBe(false)
        expect(haRegione("'en'")).toBe(false)
        expect(haRegione('locale')).toBe(false)
        expect(haRegione('')).toBe(false)
    })
})
