import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * LOCK · «sede» ha UN SOLO nome in inglese, e quel nome è **location**.
 *
 * ─── IL DIFETTO ─────────────────────────────────────────────────────────────
 *
 * Collaudo del 2026-08-01: il catalogo inglese chiamava la stessa cosa in due
 * modi, 38 volte «location» e 33 volte «site», e le stringhe NUOVE del rilascio
 * multi-sede stavano su entrambi i lati. Dentro la stessa frase, perfino:
 *   «One link for all **locations**: the parent chooses the **site** in the
 *    first step of the form.»
 * E dentro lo stesso passo di procedura: `public.wizardSede` = «Location»,
 * `public.wizardSedeSub` = «Choose the **site** where you want to enroll your
 * child». Un genitore che compila il modulo pubblico legge due parole per una
 * cosa sola, e non ha modo di sapere che sono la stessa.
 *
 * Non è cosmesi: «sede» è il termine CENTRALE di questo rilascio. Tre sedi di
 * produzione, ogni scrittura dichiara la sua, e `resolveScuolaScrittura`
 * risponde 400 chiedendo all'operatore di sceglierne una. Se l'interfaccia non
 * riesce a chiamarla sempre allo stesso modo, la richiesta è incomprensibile.
 *
 * ─── PERCHÉ «LOCATION» E NON «SITE» ─────────────────────────────────────────
 *
 *  1. In un'applicazione web e mobile «site» è già preso: vuol dire *sito*.
 *     Il catalogo lo usa per davvero — le stringhe del consenso alle foto
 *     dicono «publication on the **website**». Nella stessa lingua, «Site not
 *     accessible» (che era la traduzione di «Sede non accessibile») si legge
 *     come «il sito è irraggiungibile»: un messaggio di permessi travestito da
 *     guasto di rete. Idem «Whole site» per «Tutta la sede».
 *  2. Era già la maggioranza (38 contro 33): meno stringhe da riscrivere,
 *     quindi meno occasioni di sbagliarne una.
 *  3. Per una scuola dell'infanzia con più strutture, «our locations» è la
 *     formula corrente in inglese.
 *
 * ─── COSA CONTROLLA ─────────────────────────────────────────────────────────
 *
 *  A. nessuna voce inglese usa più «site»/«sites» come parola a sé
 *     («website» non è toccato: il confine di parola lo esclude);
 *  B. «location» c'è per davvero, e in tanti punti — un divieto è verde anche
 *     su un catalogo vuoto, questo è il controllo positivo che lo tiene onesto;
 *  C. ogni chiave ITALIANA che parla di «sede»/«plesso» ha una controparte
 *     inglese che dice «location». È il controllo che chiude la porta alla
 *     TERZA variante: «Loading your **school**…» era già nata così, e nessun
 *     divieto di parola l'avrebbe vista.
 */

const CARTELLA = join(process.cwd(), 'messages')
type Lingua = 'it' | 'en'

function piatte(valore: unknown, prefisso = ''): Array<[string, unknown]> {
    if (valore === null || typeof valore !== 'object' || Array.isArray(valore)) return [[prefisso, valore]]
    return Object.entries(valore as Record<string, unknown>).flatMap(([k, v]) =>
        piatte(v, prefisso ? `${prefisso}.${k}` : k),
    )
}

function leggi(lingua: Lingua): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {}
    for (const voce of readdirSync(join(CARTELLA, lingua), { withFileTypes: true })) {
        if (!voce.isFile() || !voce.name.endsWith('.json')) continue
        out[voce.name.replace(/\.json$/, '')] = JSON.parse(readFileSync(join(CARTELLA, lingua, voce.name), 'utf8'))
    }
    return out
}

const CATALOGHI: Record<Lingua, Record<string, Record<string, unknown>>> = { it: leggi('it'), en: leggi('en') }

function stringhe(lingua: Lingua): Array<{ ns: string; chiave: string; testo: string }> {
    const righe: Array<{ ns: string; chiave: string; testo: string }> = []
    for (const ns of Object.keys(CATALOGHI[lingua]).sort()) {
        for (const [chiave, v] of piatte(CATALOGHI[lingua][ns])) {
            if (typeof v === 'string') righe.push({ ns, chiave, testo: v })
        }
    }
    return righe
}

/** Il termine bandito. `\b` esclude «website», che è un'altra cosa e ci serve. */
const BANDITO = /\bsites?\b/i
/** Il termine scelto. */
const SCELTO = /\blocations?\b/i
/** Come si dice «sede» in italiano, nelle due forme che il prodotto usa. */
const SEDE_IT = /\b(sed[ei]|pless[oi])\b/i

/**
 * Le chiavi italiane che nominano una «sede» ma la cui traduzione NON deve dire
 * «location» — una per una, con il motivo. Un'eccezione senza motivo è un buco.
 */
const ECCEZIONI: Record<string, string> = {
    // «Sede legale» è il domicilio fiscale della cooperativa nei dati di
    // fatturazione elettronica (Aruba/SDI), non una struttura scolastica:
    // in inglese si dice «registered office» e chiamarla «location» sarebbe
    // sbagliato proprio nel campo dove conta.
    'adminSettings.spArubaSedeLegale': 'domicilio fiscale della società, non una struttura: «registered office»',
}

describe('lock architettura · glossario «sede» → «location»', () => {
    it('A. nessuna voce inglese usa più «site» per dire «sede»', () => {
        const superstiti = stringhe('en')
            .filter((r) => BANDITO.test(r.testo))
            .map((r) => `messages/en/${r.ns}.json → ${r.chiave} = «${r.testo}»`)
        expect(
            superstiti,
            'Il glossario inglese è tornato ad avere due nomi per «sede»:\n  ' +
                superstiti.join('\n  ') +
                '\nIl termine scelto è «location». «site» in un\'app web si legge «sito» — ' +
                'e il catalogo usa «website» per davvero, nelle stringhe del consenso alle foto.',
        ).toEqual([])
    })

    it('B. «location» è in uso per davvero (controllo positivo del divieto)', () => {
        const conScelto = stringhe('en').filter((r) => SCELTO.test(r.testo))
        expect(conScelto.length).toBeGreaterThanOrEqual(60)
        // E il riconoscitore distingue davvero le due parole.
        expect(BANDITO.test('All sites')).toBe(true)
        expect(BANDITO.test('Site name')).toBe(true)
        expect(BANDITO.test('publication on the website')).toBe(false)
        expect(BANDITO.test('All locations')).toBe(false)
        expect(SCELTO.test('All locations')).toBe(true)
    })

    it('C. ogni chiave italiana che dice «sede»/«plesso» dice «location» in inglese', () => {
        const disallineate: string[] = []
        const eccezioniSmentite: string[] = []
        let esaminate = 0
        for (const { ns, chiave, testo } of stringhe('it')) {
            if (!SEDE_IT.test(testo)) continue
            const controparte = CATALOGHI.en[ns]
                ? (piatte(CATALOGHI.en[ns]).find(([k]) => k === chiave)?.[1] as unknown)
                : undefined
            if (typeof controparte !== 'string') continue
            esaminate++
            const indirizzo = `${ns}.${chiave}`
            const haScelto = SCELTO.test(controparte)
            if (indirizzo in ECCEZIONI) {
                if (haScelto) {
                    eccezioniSmentite.push(
                        `${indirizzo} è dichiarata eccezione («${ECCEZIONI[indirizzo]}») ma ormai dice ` +
                            `«location»: va tolta da ECCEZIONI.`,
                    )
                }
                continue
            }
            if (!haScelto) {
                disallineate.push(`${indirizzo}: IT «${testo}» ⟶ EN «${controparte}»`)
            }
        }
        // Se l'elenco esaminato fosse vuoto le due asserzioni qui sotto sarebbero
        // verdi senza aver guardato niente.
        expect(esaminate, 'nessuna chiave italiana parla di sede: il lock non sta guardando niente').toBeGreaterThanOrEqual(60)
        expect(
            disallineate,
            'Queste voci parlano di «sede»/«plesso» in italiano e di qualcos\'altro in inglese:\n  ' +
                disallineate.join('\n  ') +
                '\nÈ così che è nata la TERZA variante («Loading your school…»), che nessun divieto ' +
                'di parola avrebbe intercettato. Il termine è «location».',
        ).toEqual([])
        expect(eccezioniSmentite, eccezioniSmentite.join('\n')).toEqual([])
    })

    it('C-bis. le eccezioni dichiarate esistono ancora nel catalogo', () => {
        // Un'eccezione che punta a una chiave cancellata è una riga morta che
        // continua a dare il permesso a nessuno — e che nasconde la prossima.
        for (const indirizzo of Object.keys(ECCEZIONI)) {
            const punto = indirizzo.indexOf('.')
            const ns = indirizzo.slice(0, punto)
            const chiave = indirizzo.slice(punto + 1)
            const valore = CATALOGHI.it[ns] ? piatte(CATALOGHI.it[ns]).find(([k]) => k === chiave)?.[1] : undefined
            expect(typeof valore, `${indirizzo} non esiste più in messages/it/${ns}.json`).toBe('string')
            expect(SEDE_IT.test(String(valore)), `${indirizzo} non parla più di sede`).toBe(true)
        }
    })
})
