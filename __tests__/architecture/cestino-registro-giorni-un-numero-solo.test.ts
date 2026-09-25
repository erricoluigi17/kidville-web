import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { GIORNI_CESTINO_REGISTRO, GIORNI_CONSERVAZIONE_ALLEGATI_REGISTRO } from '@/lib/primaria/cestino-registro'

/**
 * LOCK · cestino-registro-giorni-un-numero-solo — I GIORNI DEL CESTINO DEL
 * REGISTRO E DEL FASCICOLO SONO UN NUMERO SOLO, IN UN POSTO SOLO.
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────
 * Il gemello della galleria (`cestino-giorni-un-numero-solo`) sorveglia DUE copie
 * dello stesso numero, perché il modulo del server importa il logger e la pagina
 * client non può importarlo. Qui la ripetizione non serve: il numero vive in
 * `src/lib/primaria/cestino-registro.ts`, modulo PURO (nessun import), che server
 * e client leggono entrambi. Quindi la regola è più stretta: NESSUNA seconda copia.
 *
 * Il numero lo leggono tre attori, e divergere costa in due versi:
 *  · la PURGA (`gdpr/retention-cestino-registro`) lo APPLICA;
 *  · la MIGRAZIONE del cron lo NOMINA nel commento della funzione;
 *  · la SCHERMATA del cestino lo PROMETTE («Restano 3 giorni»).
 * Promettere più giorni di quelli applicati significa dire «puoi ancora
 * ripristinarlo» di un documento già distrutto; prometterne meno fa rinunciare a
 * un ripristino ancora possibile.
 *
 * ─── COSA GUARDA ────────────────────────────────────────────────────────────
 *  1. la costante esiste ed è dichiarata UNA volta sola in `src/`;
 *  2. la purga la importa e non dichiara un numero suo;
 *  3. la migrazione del cron, dove nomina dei giorni, nomina QUELLI;
 *  4. nessun file di `src/` che parla del cestino del registro/fascicolo (lo
 *     riconosce dall'import di `@/lib/primaria/cestino-registro`) scrive i giorni
 *     a mano in un testo;
 *  5. nessuna stringa dei cataloghi `messages/it|en` sul cestino/ripristino scrive
 *     QUEL numero di giorni in cifre: la UI lo passa come parametro `{giorni}`.
 *
 * ─── E IL SECONDO NUMERO (dal 2026-09-25) ───────────────────────────────────
 * Lo stesso modulo porta `GIORNI_CONSERVAZIONE_ALLEGATI_REGISTRO`: la decisione del
 * titolare del 2026-09-25 (365 giorni dal CARICAMENTO, vivi e cestinati) applicata
 * dalla stessa purga. Stessa regola, stesse prove: una dichiarazione sola in `src/`,
 * la purga la importa insieme alla sua soglia e non tiene un numero suo, nessun file
 * che importa il modulo e nessun catalogo lo scrive in cifre.
 */

const RADICE = join(__dirname, '..', '..')
const LIB = 'src/lib/primaria/cestino-registro.ts'
const ROUTE = 'src/app/api/gdpr/retention-cestino-registro/route.ts'
const MIGRAZIONE = 'supabase/migrations/20260924220100_cestino_registro_cron.sql'

function leggi(p: string): string {
    return readFileSync(join(RADICE, p), 'utf8')
}

function fileSotto(cartella: string, estensioni: RegExp): string[] {
    const out: string[] = []
    const giro = (dir: string) => {
        for (const nome of readdirSync(dir)) {
            const pieno = join(dir, nome)
            if (statSync(pieno).isDirectory()) giro(pieno)
            else if (estensioni.test(nome)) out.push(relative(RADICE, pieno))
        }
    }
    giro(join(RADICE, cartella))
    return out
}

/** Toglie i commenti: un lock che legge il testo legge anche i commenti (e si immunizza). */
function senzaCommenti(sorgente: string): string {
    return sorgente
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
        .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
}

const DICHIARAZIONE = /\bGIORNI_CESTINO_REGISTRO\s*(?::\s*number\s*)?=\s*\d+/

describe('lock · cestino-registro-giorni-un-numero-solo', () => {
    it('la costante esiste, è positiva, ed è dichiarata UNA volta sola in src/ (sanity)', () => {
        expect(GIORNI_CESTINO_REGISTRO).toBeGreaterThan(0)
        const dichiaranti = fileSotto('src', /\.(ts|tsx)$/).filter((f) => DICHIARAZIONE.test(leggi(f)))
        expect(
            dichiaranti,
            `\`GIORNI_CESTINO_REGISTRO\` va dichiarata solo in ${LIB}: una seconda copia è un secondo ` +
                'numero da tenere allineato, cioè il difetto che questo lock esiste per impedire.',
        ).toEqual([LIB])
    })

    it('la purga importa la costante (e la soglia) dal modulo, senza un numero suo', () => {
        const route = leggi(ROUTE)
        expect(route).toMatch(/from\s+['"]@\/lib\/primaria\/cestino-registro['"]/)
        expect(route).toMatch(/sogliaPurgaCestinoRegistro\s*\(/)
        const codice = senzaCommenti(route)
        expect(
            codice.match(/\bconst\s+\w*GIORN\w*\s*=\s*\d+/g) ?? [],
            `${ROUTE} dichiara un numero di giorni suo: la soglia la calcola \`sogliaPurgaCestinoRegistro\`.`,
        ).toEqual([])
        expect(codice, `${ROUTE} scrive un intervallo a mano`).not.toMatch(/\d+\s*\*\s*24\s*\*\s*60/)
    })

    it('la migrazione del cron, dove nomina dei giorni, nomina GLI STESSI della costante', () => {
        const sql = leggi(MIGRAZIONE)
        const giorni = [...sql.matchAll(/(\d+)\s+giorni/gi)].map((m) => Number(m[1]))
        const intervalli = [...sql.matchAll(/interval\s+'(\d+)\s+days?'/gi)].map((m) => Number(m[1]))
        expect(
            giorni.length,
            `${MIGRAZIONE} non nomina più i giorni del cestino: se il numero è stato tolto apposta, ` +
                'aggiorna questo lock — ma senza, chi legge il commento della funzione non sa quale termine applica.',
        ).toBeGreaterThan(0)
        expect(
            [...giorni, ...intervalli].filter((n) => n !== GIORNI_CESTINO_REGISTRO),
            `${MIGRAZIONE} nomina un numero di giorni diverso da GIORNI_CESTINO_REGISTRO=${GIORNI_CESTINO_REGISTRO}. ` +
                'Il numero che vale è quello del modulo: allinea la migrazione, non il contrario.',
        ).toEqual([])
    })

    it('nessun file che usa il cestino del registro scrive i giorni a mano in un testo', () => {
        const n = GIORNI_CESTINO_REGISTRO
        const aMano = new RegExp(`\\b${n}\\s*(giorni|giorno|days?)\\b`, 'i')
        const utenti = fileSotto('src', /\.(ts|tsx)$/)
            .filter((f) => f !== LIB)
            .filter((f) => /['"]@\/lib\/primaria\/cestino-registro['"]/.test(leggi(f)))
        const colpevoli = utenti.filter((f) => aMano.test(senzaCommenti(leggi(f))))
        expect(
            colpevoli,
            `Questi file importano il cestino del registro e scrivono «${n} giorni» a mano: usa ` +
                '`GIORNI_CESTINO_REGISTRO` (o `giorniResiduiCestino`) e passa il numero alla traduzione.',
        ).toEqual([])
    })

    it('i cataloghi non scrivono in cifre i giorni del cestino del registro', () => {
        const n = GIORNI_CESTINO_REGISTRO
        const numero = new RegExp(`\\b${n}\\s*(giorni|giorno|days?)\\b`, 'i')
        const tema = /cestin|ripristin|\btrash\b|\bbin\b|restor/i
        const colpevoli: string[] = []
        for (const lingua of ['it', 'en']) {
            for (const f of fileSotto(`messages/${lingua}`, /\.json$/)) {
                const visita = (nodo: unknown, chiave: string) => {
                    if (typeof nodo === 'string') {
                        if (numero.test(nodo) && (tema.test(nodo) || tema.test(chiave))) colpevoli.push(`${f} → ${chiave}`)
                    } else if (nodo && typeof nodo === 'object') {
                        for (const [k, v] of Object.entries(nodo)) visita(v, chiave ? `${chiave}.${k}` : k)
                    }
                }
                visita(JSON.parse(leggi(f)), '')
            }
        }
        expect(
            colpevoli,
            `Queste stringhe scrivono in cifre ${n} giorni di cestino: la frase deve ricevere il numero ` +
                'come parametro (`{giorni}`), letto da `GIORNI_CESTINO_REGISTRO`. Il giorno in cui la ' +
                'custodia cambia, un numero scritto in un catalogo resta indietro in silenzio.',
        ).toEqual([])
    })
})

const DICHIARAZIONE_CONSERVAZIONE = /\bGIORNI_CONSERVAZIONE_ALLEGATI_REGISTRO\s*(?::\s*number\s*)?=\s*\d+/

describe('lock · cestino-registro-giorni-un-numero-solo — la conservazione degli allegati', () => {
    it('la costante esiste, supera la custodia del cestino, ed è dichiarata UNA volta sola in src/ (sanity)', () => {
        // Più lunga del cestino per costruzione, ma questo NON basta a tenere vera la
        // promessa del «Ripristina»: i due termini contano da istanti diversi, e un
        // allegato caricato da più di (conservazione − custodia) giorni scade per età
        // PRIMA che finisca la custodia. La regola è un'altra: la più breve delle due
        // scadenze vince, e la UI mostra quella (`ripristinabileFinoAlAllegato`, provata
        // nel test qui sotto e in `primaria-allegati-cestino.test.ts`). Questo confronto
        // dice solo che il termine deciso dal titolare non è stato scambiato col cestino.
        expect(GIORNI_CONSERVAZIONE_ALLEGATI_REGISTRO).toBeGreaterThan(GIORNI_CESTINO_REGISTRO)
        const dichiaranti = fileSotto('src', /\.(ts|tsx)$/).filter((f) => DICHIARAZIONE_CONSERVAZIONE.test(leggi(f)))
        expect(
            dichiaranti,
            `\`GIORNI_CONSERVAZIONE_ALLEGATI_REGISTRO\` va dichiarata solo in ${LIB}: il termine deciso dal ` +
                'titolare il 2026-09-25 è UN numero, e una seconda copia è il difetto che questo lock impedisce.',
        ).toEqual([LIB])
    })

    it('la purga importa la costante e la sua soglia dal modulo', () => {
        const route = leggi(ROUTE)
        const codice = senzaCommenti(route)
        expect(codice).toMatch(/\bGIORNI_CONSERVAZIONE_ALLEGATI_REGISTRO\b/)
        expect(
            codice,
            `${ROUTE} non calcola la soglia di conservazione con \`sogliaConservazioneAllegatiRegistro\``,
        ).toMatch(/sogliaConservazioneAllegatiRegistro\s*\(/)
        // La delete e la lettura contano dal CARICAMENTO, non dall'eliminazione.
        expect(codice).toMatch(/\.lt\(\s*'creato_il'\s*,\s*soglia\s*\)/)
    })

    it('le route degli allegati promettono la scadenza sul PRIMO dei due termini, mai la sola custodia', () => {
        // Chi risponde `ripristinabileFinoAl` per un allegato del registro deve passare da
        // `ripristinabileFinoAlAllegato` (minimo fra custodia e conservazione): con
        // `scadenzaCestino` prometterebbe sette giorni a un allegato che la purga
        // distrugge prima, per età. Il fascicolo non ha la conservazione e resta com'è.
        const ROUTE_ALLEGATI = [
            'src/app/api/primaria/allegati/route.ts',
            'src/app/api/primaria/allegati/sostituisci/route.ts',
            'src/app/api/primaria/allegati/cestino/route.ts',
        ]
        for (const f of ROUTE_ALLEGATI) {
            const codice = senzaCommenti(leggi(f))
            expect(codice, `${f} non usa \`ripristinabileFinoAlAllegato\``).toMatch(/ripristinabileFinoAlAllegato\s*\(/)
            expect(
                codice,
                `${f} calcola la scadenza del cestino con \`scadenzaCestino\`/\`giorniResiduiCestino\`: ` +
                    'per un allegato del registro vince il primo termine che scade, anche la conservazione.',
            ).not.toMatch(/\b(scadenzaCestino|giorniResiduiCestino)\s*\(/)
        }
        const cestino = senzaCommenti(leggi('src/app/api/primaria/allegati/cestino/route.ts'))
        expect(cestino, 'il ripristino non controlla la conservazione').toMatch(/conservazioneAllegatoScaduta\s*\(/)
        expect(cestino, 'il cestino non esclude gli allegati oltre la conservazione').toMatch(
            /filtroEntroConservazioneAllegati\s*\(/,
        )
    })

    it('nessun file che usa il modulo scrive a mano i giorni della conservazione', () => {
        const n = GIORNI_CONSERVAZIONE_ALLEGATI_REGISTRO
        const aMano = new RegExp(`\\b${n}\\s*(giorni|giorno|days?)\\b`, 'i')
        const colpevoli = fileSotto('src', /\.(ts|tsx)$/)
            .filter((f) => f !== LIB)
            .filter((f) => /['"]@\/lib\/primaria\/cestino-registro['"]/.test(leggi(f)))
            .filter((f) => aMano.test(senzaCommenti(leggi(f))))
        expect(
            colpevoli,
            `Questi file importano il modulo e scrivono «${n} giorni» a mano: usa ` +
                '`GIORNI_CONSERVAZIONE_ALLEGATI_REGISTRO`.',
        ).toEqual([])
    })

    it('i cataloghi non scrivono in cifre i giorni di conservazione degli allegati', () => {
        const n = GIORNI_CONSERVAZIONE_ALLEGATI_REGISTRO
        const numero = new RegExp(`\\b${n}\\s*(giorni|giorno|days?)\\b`, 'i')
        const tema = /allegat|attachment|registro|conserva|retention|cestin|trash/i
        const colpevoli: string[] = []
        for (const lingua of ['it', 'en']) {
            for (const f of fileSotto(`messages/${lingua}`, /\.json$/)) {
                const visita = (nodo: unknown, chiave: string) => {
                    if (typeof nodo === 'string') {
                        if (numero.test(nodo) && (tema.test(nodo) || tema.test(chiave))) colpevoli.push(`${f} → ${chiave}`)
                    } else if (nodo && typeof nodo === 'object') {
                        for (const [k, v] of Object.entries(nodo)) visita(v, chiave ? `${chiave}.${k}` : k)
                    }
                }
                visita(JSON.parse(leggi(f)), '')
            }
        }
        expect(colpevoli, `Queste stringhe scrivono in cifre ${n} giorni di conservazione: passa il numero come parametro.`).toEqual([])
    })
})
