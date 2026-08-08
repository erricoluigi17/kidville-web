import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CODICI_ERRORE, soloCatalogoDaCorpo } from '@/lib/ui/esito-fetch'
import { MOTIVO_MAX_CARATTERI } from '@/lib/presenze/limiti-testo'
import itShared from '../../messages/it/shared.json'
import enShared from '../../messages/en/shared.json'

/**
 * I DUE TETTI NUOVI DI «COMUNICA UN'ASSENZA» HANNO UNA FRASE, IN DUE LINGUE,
 * E LA FRASE DICE COSA FARE.
 *
 * ─── PERCHÉ ESISTE ───────────────────────────────────────────────────────────
 * Il 2026-08-07 la rotta ha ricevuto due confini che prima non aveva: 60 giorni
 * di anticipo massimo (`2099-12-31` rispondeva 201) e 500 caratteri di motivo
 * (in produzione era passata una riga da 200.000 caratteri). Due rifiuti nuovi
 * significano due frasi nuove, e una frase nuova nasce in italiano: è il modo
 * normale di lavorare qui, ed è anche il modo in cui una schermata inglese
 * resta a metà.
 *
 * Il perimetro delle schermate di famiglia rende la cosa più severa di così.
 * `errori-server-schermate-famiglia` vieta di mostrare la prosa del server, e il
 * modo in cui le due schermate obbediscono è `soloCatalogoDaCorpo`, che SCARTA
 * l'`error` e tiene solo il testo di catalogo del `codice`. Dentro quel
 * perimetro un rifiuto senza frase di catalogo non degrada all'italiano:
 * **sparisce**. Al genitore resta il ripiego generico del componente — «non è
 * stato possibile comunicare l'assenza» — identico per «hai scelto un giorno
 * troppo lontano» e per «il database è giù». Due rimedi diversi (scegli un'altra
 * data · accorcia il testo) ridotti a una frase che non ne indica nessuno.
 *
 * ─── COSA CONTROLLA ──────────────────────────────────────────────────────────
 *  1. i due codici sono DICHIARATI in `CODICI_ERRORE` (senza dichiarazione la
 *     traduzione non viene nemmeno cercata);
 *  2. le due frasi ci sono in italiano e in inglese, non vuote e diverse fra
 *     loro (una traduzione copiata è una traduzione mancante travestita);
 *  3. il testo ARRIVA A SCHERMO in entrambe le lingue: `soloCatalogoDaCorpo`
 *     restituisce la frase di catalogo e mai il ripiego — è il comportamento,
 *     non l'esistenza della chiave;
 *  4. il NUMERO scritto nella frase è quello che il server applica davvero.
 *     «Fino a 60 giorni» mentre il server ne accetta 30 è peggio di non dire
 *     nulla: manda il genitore a ritentare una cosa che non può riuscire, e la
 *     deriva fra una costante e una frase non fa rumore da nessuna parte;
 *  5. ogni frase contiene un'ISTRUZIONE, non solo un rifiuto. È il criterio che
 *     il repo applica già a `ASSENZA_DATA_PASSATA` («…usa la giustifica»), ed è
 *     ciò che distingue un messaggio d'errore da un «no».
 */

const catIt = itShared as Record<string, string>
const catEn = enShared as Record<string, string>
const CODICI = CODICI_ERRORE as Record<string, string>

const RADICE = process.cwd()
const SORGENTE_ROTTA = 'src/app/api/parent/presenze/comunica-assenza/route.ts'

/**
 * Il valore di una costante numerica letta dal SORGENTE.
 *
 * `GIORNI_MASSIMI_IN_ANTICIPO` vive dentro il modulo della rotta, che importare
 * qui vorrebbe dire tirarsi dentro Supabase, il logger e mezzo runtime di Next
 * per leggere un numero. Si legge il testo — come fa già
 * `errori-con-codice.test.ts` con i codici — e si verifica il lettore con un
 * controllo positivo, perché un lettore che torna sempre `null` renderebbe la
 * prova 4 verde su qualunque cosa.
 */
function costanteNumerica(sorgente: string, nome: string): number | null {
    const m = new RegExp(`\\b${nome}\\b\\s*(?::\\s*number\\s*)?=\\s*(\\d+)\\b`).exec(sorgente)
    return m ? Number(m[1]) : null
}

/** L'ISTRUZIONE: un imperativo rivolto a chi legge, lingua per lingua. */
const ISTRUZIONE: Record<'it' | 'en', RegExp> = {
    it: /\b(usa|contatta|riprova|scegli|accorcia|riduci|indica|scrivi)\b/i,
    en: /\b(use|contact|try|choose|shorten|reduce|pick|enter)\b/i,
}

/** Il `lang` della radice: è ciò che `RootLayout` scrive da `getLocale()`. */
const conLingua = (lang: string) => document.documentElement.setAttribute('lang', lang)
afterEach(() => conLingua('it'))

/**
 * I due tetti nati il 2026-08-07, con il numero che il server applica.
 * `quanto` è una funzione perché il valore va letto ADESSO, non congelato qui:
 * un numero ricopiato in un test è la deriva che il test dovrebbe impedire.
 */
const TETTI = [
    {
        nome: 'i 60 giorni di anticipo massimo',
        codice: 'ASSENZA_DATA_TROPPO_LONTANA',
        quanto: () => costanteNumerica(readFileSync(join(RADICE, SORGENTE_ROTTA), 'utf8'), 'GIORNI_MASSIMI_IN_ANTICIPO'),
        dove: `${SORGENTE_ROTTA} → GIORNI_MASSIMI_IN_ANTICIPO`,
    },
    {
        nome: 'i 500 caratteri del motivo',
        codice: 'ASSENZA_MOTIVO_TROPPO_LUNGO',
        quanto: () => MOTIVO_MAX_CARATTERI,
        dove: 'src/lib/presenze/limiti-testo.ts → MOTIVO_MAX_CARATTERI',
    },
] as const

describe('i due tetti dell’assenza comunicata — la frase c’è, in due lingue, e dice cosa fare', () => {
    it('i due codici sono dichiarati, e la chiave punta a una frase in entrambe le lingue', () => {
        for (const { nome, codice } of TETTI) {
            const chiave = CODICI[codice]
            expect(
                chiave,
                `${nome}: il codice ${codice} non è in CODICI_ERRORE (src/lib/ui/esito-fetch.ts). ` +
                'Senza dichiarazione la traduzione non viene nemmeno cercata e il genitore legge il ripiego.',
            ).toBeTypeOf('string')
            for (const [lingua, cat] of [['it', catIt], ['en', catEn]] as const) {
                const testo = cat[chiave]
                expect(testo, `manca messages/${lingua}/shared.json → ${chiave}`).toBeTypeOf('string')
                expect(testo.trim(), `messages/${lingua}/shared.json → ${chiave} è vuoto`).not.toBe('')
            }
            expect(
                catEn[chiave],
                `messages/en/shared.json → ${chiave} = «${catEn[chiave]}» è identico all’italiano: ` +
                'una frase copiata supera la parità dei cataloghi e a schermo resta la lingua sbagliata.',
            ).not.toBe(catIt[chiave])
        }
    })

    it('la frase ARRIVA a schermo in italiano e in inglese, e mai il ripiego generico', () => {
        // È il comportamento vero delle due schermate: entrambe leggono il rifiuto
        // con `soloCatalogoDaCorpo` (attendance/page.tsx:448 e ComunicaAssenzaCard.tsx:282).
        const RIPIEGO = 'RIPIEGO-GENERICO-DEL-COMPONENTE'
        for (const { nome, codice } of TETTI) {
            for (const [lingua, cat] of [['it', catIt], ['en', catEn]] as const) {
                conLingua(lingua)
                const letto = soloCatalogoDaCorpo({ codice, error: 'prosa italiana del server' }, RIPIEGO)
                expect(
                    letto,
                    `[${lingua}] ${nome}: il genitore legge «${letto}» invece della frase di catalogo. ` +
                    'Dentro il perimetro delle schermate di famiglia un rifiuto senza frase non degrada ' +
                    'all’italiano: sparisce, e resta un ripiego che non dice cosa fare.',
                ).toBe(cat[CODICI[codice]])
                expect(letto, `[${lingua}] ${nome}: è arrivato il ripiego`).not.toBe(RIPIEGO)
                expect(letto, `[${lingua}] ${nome}: è arrivata la prosa del server`).not.toBe(
                    'prosa italiana del server',
                )
            }
        }
    })

    it('il numero scritto nella frase è quello che il server applica davvero', () => {
        for (const { nome, codice, quanto, dove } of TETTI) {
            const valore = quanto()
            expect(valore, `non riesco a leggere ${dove}: senza il numero vero questa prova non verifica niente`)
                .toBeTypeOf('number')
            for (const [lingua, cat] of [['it', catIt], ['en', catEn]] as const) {
                const testo = cat[CODICI[codice]]
                expect(
                    new RegExp(`\\b${valore}\\b`).test(testo),
                    `[${lingua}] ${nome}: la frase «${testo}» non nomina ${valore}, che è il valore di ` +
                    `${dove}. Un limite raccontato con un numero diverso da quello applicato manda il ` +
                    'genitore a ritentare una cosa che non può riuscire.',
                ).toBe(true)
            }
        }
    })

    it('il lettore della costante FUNZIONA (senza, la prova qui sopra è verde su qualunque cosa)', () => {
        const finto = [
            'export const GIORNI_MASSIMI_IN_ANTICIPO = 60',
            'export const CON_TIPO: number = 500;',
            'export const CALCOLATA = leggi()',
        ].join('\n')
        expect(costanteNumerica(finto, 'GIORNI_MASSIMI_IN_ANTICIPO')).toBe(60)
        expect(costanteNumerica(finto, 'CON_TIPO')).toBe(500)
        expect(costanteNumerica(finto, 'CALCOLATA'), 'una chiamata non è un numero leggibile').toBeNull()
        expect(costanteNumerica(finto, 'MAI_DICHIARATA')).toBeNull()
        // E il numero letto dalla rotta vera non è per caso quello scritto qui:
        // se un giorno la costante sparisse, la prova 4 lo direbbe invece di passare.
        expect(TETTI[0].quanto()).toBe(60)
        expect(TETTI[1].quanto()).toBe(500)
    })

    it('ogni frase dice COSA FARE, non solo che è andata male', () => {
        for (const { nome, codice } of TETTI) {
            for (const [lingua, cat] of [['it', catIt], ['en', catEn]] as const) {
                const testo = cat[CODICI[codice]]
                expect(
                    ISTRUZIONE[lingua].test(testo),
                    `[${lingua}] ${nome}: «${testo}» dice che c’è un problema e non dice come uscirne. ` +
                    'Il criterio è quello già applicato a ASSENZA_DATA_PASSATA («…usa la giustifica»): ' +
                    'chi legge deve sapere qual è il gesto successivo.',
                ).toBe(true)
            }
        }
    })

    it('il riconoscitore d’istruzione distingue un rimedio da un «no» (controllo negativo)', () => {
        // Senza questo, la prova qui sopra sarebbe verde anche con un'espressione che
        // accetta qualunque testo — ed è la forma di asserzione sempre-vera che questo
        // ciclo ha già trovato tre volte.
        expect(ISTRUZIONE.it.test('Il motivo è troppo lungo.')).toBe(false)
        expect(ISTRUZIONE.it.test('La data non è valida a causa di un errore.')).toBe(false)
        expect(ISTRUZIONE.it.test('Il motivo è troppo lungo: usa al massimo 500 caratteri.')).toBe(true)
        expect(ISTRUZIONE.en.test('The reason is too long.')).toBe(false)
        expect(ISTRUZIONE.en.test('The reason is too long: please use 500 characters at most.')).toBe(true)
    })
})
