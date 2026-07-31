import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * LOCK · i cataloghi `messages/it` e `messages/en` devono avere LE STESSE CHIAVI.
 *
 * Perché esiste. L'app è bilingue dal 2026-07-25 (next-intl senza routing, cookie
 * `KV_LOCALE`): 34 namespace per lingua, 4830 chiavi per lato. Fino al 2026-07-31
 * quella parità si reggeva **soltanto sulla disciplina di chi scriveva il codice**:
 * nessun test la verificava. Una chiave aggiunta solo in italiano — cioè il modo
 * normale in cui si sviluppa qui, prima il testo italiano e poi la traduzione —
 * non faceva rosso da nessuna parte.
 *
 * Ed è peggio di così, perché la suite non poteva accorgersene nemmeno per caso:
 * `test/setup.ts` mocka `next-intl` risolvendo **solo** `messages/it`. Un namespace
 * inglese dimezzato — o cancellato del tutto — lascia **tutti** gli unit test verdi.
 * L'unico posto in cui il buco si vede è lo schermo di un utente con l'interfaccia
 * in inglese: `getMessageFallback` di next-intl, quando la chiave manca, restituisce
 * il **percorso della chiave**, e la pagina mostra `avvisi.titoloNuovoAvviso` al posto
 * del testo. Nessuna eccezione, nessun log applicativo: solo un'interfaccia rotta.
 *
 * È il difetto della famiglia peggiore, la stessa di `migrazioni-complete.test.ts`:
 * silenzioso finché non lo guarda un utente vero.
 *
 * ─── COSA CONTROLLA ───────────────────────────────────────────────────────────
 *  1. le due cartelle esistono e sono piene (se questa cade, il lock si sta
 *     autoingannando: un confronto fra due insiemi vuoti è sempre verde);
 *  2. gli stessi **namespace** (file) da entrambe le parti;
 *  3. le stesse **chiavi**, namespace per namespace, annidamento compreso —
 *     ed è il cuore: il messaggio nomina file, lato e chiavi mancanti;
 *  4. ogni chiave porta un **testo non vuoto** in entrambe le lingue (una chiave
 *     presente con valore `""` è una traduzione mancante travestita da presente:
 *     supera un confronto di insiemi e a schermo lascia il vuoto);
 *  5. che il confronto del punto 3 **sappia davvero trovare** una chiave mancante,
 *     annidata compresa — la prova che il lock non è un fantoccio.
 *
 * ─── COSA NON CONTROLLA (di proposito) ────────────────────────────────────────
 *  · che la traduzione inglese sia *diversa* dall'italiana: «Email», «Chat», «OK»
 *    sono legittimamente identiche, e un lock su questo sarebbe solo rumore;
 *  · la qualità della traduzione;
 *  · le chiavi duplicate dentro lo stesso file JSON (`JSON.parse` tiene l'ultima e
 *    la prima sparisce senza rumore): riconoscerle richiede un parser che conservi
 *    le posizioni, e va fatto — se si farà — con uno strumento suo.
 */

const RADICE = process.cwd()
const CARTELLA_MESSAGGI = join(RADICE, 'messages')
const LINGUE = ['it', 'en'] as const
type Lingua = (typeof LINGUE)[number]

/** Il JSON grezzo di ogni namespace, indicizzato per nome del file. */
type CatalogoLingua = Record<string, unknown>

const COME_SI_CORREGGE =
    'Ogni chiave deve esistere in ENTRAMBE le lingue: aggiungi la voce mancante in ' +
    '`messages/<lingua>/<namespace>.json`. Se una chiave non serve più, va tolta da tutte e due. ' +
    'Attenzione: gli unit test NON possono accorgersi del buco da soli — `test/setup.ts` mocka ' +
    'next-intl sui soli messaggi italiani; in inglese l\'utente leggerebbe il nome della chiave.'

/**
 * Appiattisce un catalogo in coppie `chiave.puntata` → valore.
 * Gli oggetti si attraversano (i namespace annidati esistono: `offline.etichette.*`),
 * tutto il resto — stringhe, numeri, array — è una foglia.
 */
function vociPiatte(valore: unknown, prefisso = ''): Array<[string, unknown]> {
    if (valore === null || typeof valore !== 'object' || Array.isArray(valore)) {
        return [[prefisso, valore]]
    }
    return Object.entries(valore as Record<string, unknown>).flatMap(([chiave, v]) =>
        vociPiatte(v, prefisso ? `${prefisso}.${chiave}` : chiave),
    )
}

const chiaviPiatte = (valore: unknown): string[] => vociPiatte(valore).map(([k]) => k)

/** Legge tutti i `.json` di primo livello di una lingua. */
function leggiCatalogo(lingua: Lingua): CatalogoLingua {
    const cartella = join(CARTELLA_MESSAGGI, lingua)
    const catalogo: CatalogoLingua = {}
    for (const voce of readdirSync(cartella, { withFileTypes: true })) {
        if (!voce.isFile() || !voce.name.endsWith('.json')) continue
        catalogo[voce.name] = JSON.parse(readFileSync(join(cartella, voce.name), 'utf8'))
    }
    return catalogo
}

/**
 * Le divergenze di chiavi fra i due cataloghi, una riga per ogni namespace che
 * diverge, **già in forma leggibile**: chi legge il rosso deve sapere subito quale
 * file aprire e quale chiave scrivere.
 *
 * Guarda solo i namespace presenti da entrambe le parti: quelli mancanti li nomina
 * — uno per uno — la prova sui namespace, e contarli due volte renderebbe il
 * messaggio illeggibile proprio nel momento in cui serve.
 */
function divergenzeDiChiavi(it: CatalogoLingua, en: CatalogoLingua): string[] {
    const righe: string[] = []
    for (const file of Object.keys(it).sort()) {
        if (!(file in en)) continue
        const chiaviIt = new Set(chiaviPiatte(it[file]))
        const chiaviEn = new Set(chiaviPiatte(en[file]))
        const soloIt = [...chiaviIt].filter((k) => !chiaviEn.has(k)).sort()
        const soloEn = [...chiaviEn].filter((k) => !chiaviIt.has(k)).sort()
        if (soloIt.length > 0) {
            righe.push(
                `messages/en/${file} — ${soloIt.length} chiavi presenti in italiano e assenti qui: ${soloIt.join(', ')}`,
            )
        }
        if (soloEn.length > 0) {
            righe.push(
                `messages/it/${file} — ${soloEn.length} chiavi presenti in inglese e assenti qui: ${soloEn.join(', ')}`,
            )
        }
    }
    return righe
}

const CATALOGHI: Record<Lingua, CatalogoLingua> = {
    it: leggiCatalogo('it'),
    en: leggiCatalogo('en'),
}

describe('lock architettura · i cataloghi it/en hanno le stesse chiavi', () => {
    it('i due cataloghi ci sono e sono pieni (se cade, il lock si sta autoingannando)', () => {
        // Un confronto fra due insiemi vuoti è verde per costruzione: è il modo più
        // silenzioso di non controllare niente. Soglie tarate sui valori reali del
        // 2026-07-31 (34 namespace, 4830 chiavi per lingua), abbassate quel tanto
        // che basta a non doverle toccare a ogni rilascio.
        for (const lingua of LINGUE) {
            expect(existsSync(join(CARTELLA_MESSAGGI, lingua)), `manca la cartella messages/${lingua}`).toBe(true)
            const namespace = Object.keys(CATALOGHI[lingua])
            expect(
                namespace.length,
                `messages/${lingua} contiene ${namespace.length} namespace: troppo pochi per essere ` +
                `il catalogo vero di questa app. Il lock starebbe confrontando quasi niente.`,
            ).toBeGreaterThan(30)
            const chiavi = namespace.flatMap((f) => chiaviPiatte(CATALOGHI[lingua][f]))
            expect(
                chiavi.length,
                `messages/${lingua} contiene ${chiavi.length} chiavi: troppo poche. Se il conto è ` +
                `crollato, o è stato cancellato mezzo catalogo o \`vociPiatte\` ha smesso di scendere ` +
                `nelle chiavi annidate — e in tutti e due i casi questo lock non verifica più niente.`,
            ).toBeGreaterThan(4000)
        }
    })

    it('italiano e inglese hanno gli stessi namespace', () => {
        const soloIt = Object.keys(CATALOGHI.it).filter((f) => !(f in CATALOGHI.en)).sort()
        const soloEn = Object.keys(CATALOGHI.en).filter((f) => !(f in CATALOGHI.it)).sort()
        expect(
            { manca_in_en: soloIt, manca_in_it: soloEn },
            `I due cataloghi non hanno gli stessi namespace.\n` +
            `  assenti da messages/en: ${soloIt.join(', ') || '—'}\n` +
            `  assenti da messages/it: ${soloEn.join(', ') || '—'}\n` +
            `Un namespace che manca da una lingua non è mezza interfaccia tradotta: è l'intera ` +
            `sezione che mostra i nomi delle chiavi. ${COME_SI_CORREGGE}`,
        ).toEqual({ manca_in_en: [], manca_in_it: [] })
    })

    it('ogni namespace ha le stesse chiavi nelle due lingue', () => {
        // ⟵ È IL CUORE DEL LOCK.
        const righe = divergenzeDiChiavi(CATALOGHI.it, CATALOGHI.en)
        expect(
            righe,
            `I cataloghi italiano e inglese non hanno più le stesse chiavi:\n` +
            `  ${righe.join('\n  ')}\n` +
            `${COME_SI_CORREGGE}`,
        ).toEqual([])
    })

    it('ogni chiave porta un testo non vuoto in entrambe le lingue', () => {
        // Una chiave con valore `""` supera qualunque confronto di insiemi e a
        // schermo lascia un bottone senza etichetta. Vale anche il caso di un valore
        // che non è una stringa: next-intl lo tratterebbe come un sotto-catalogo.
        const guasti: string[] = []
        for (const lingua of LINGUE) {
            for (const file of Object.keys(CATALOGHI[lingua]).sort()) {
                for (const [chiave, valore] of vociPiatte(CATALOGHI[lingua][file])) {
                    if (typeof valore !== 'string') {
                        guasti.push(`messages/${lingua}/${file} → ${chiave}: non è un testo (${typeof valore})`)
                    } else if (valore.trim() === '') {
                        guasti.push(`messages/${lingua}/${file} → ${chiave}: testo vuoto`)
                    }
                }
            }
        }
        expect(
            guasti,
            `Queste voci di catalogo non contengono un testo utilizzabile:\n  ${guasti.join('\n  ')}\n` +
            `Una chiave vuota passa il confronto delle chiavi e lascia lo schermo bianco nel punto ` +
            `in cui doveva esserci una parola.`,
        ).toEqual([])
    })

    it('il confronto trova davvero una chiave mancante, annidata compresa', () => {
        // La prova che il lock non è un fantoccio: la stessa funzione che qui sopra
        // gira sui cataloghi veri, messa davanti a un difetto costruito apposta, deve
        // vederlo e DIRLO — file, lato e nome della chiave. Senza questa prova, un
        // `divergenzeDiChiavi` che ritorna sempre `[]` (o che si ferma al primo
        // livello, ignorando `offline.etichette.*`) lascerebbe il lock verde per
        // sempre, cioè inutile.
        const it: CatalogoLingua = {
            'avvisi.json': { titolo: 'Avvisi', bozza: 'Bozza' },
            'offline.json': { etichette: { segmenti: { chat: 'Chat', avvisi: 'Avvisi' } } },
        }

        // Controllo positivo: cataloghi identici → nessuna riga. Un confronto che
        // urla anche quando va tutto bene non è un lock, è rumore da disattivare.
        expect(divergenzeDiChiavi(it, structuredClone(it))).toEqual([])

        // Chiave semplice assente dall'inglese.
        const senzaBozza = structuredClone(it)
        delete (senzaBozza['avvisi.json'] as Record<string, unknown>).bozza
        const rigaBozza = divergenzeDiChiavi(it, senzaBozza)
        expect(rigaBozza).toHaveLength(1)
        expect(rigaBozza[0]).toContain('messages/en/avvisi.json')
        expect(rigaBozza[0]).toContain('bozza')

        // Chiave ANNIDATA assente dall'inglese: se il flatten si fermasse al primo
        // livello, `offline.json` avrebbe una sola chiave (`etichette`) da entrambe
        // le parti e questo buco resterebbe invisibile.
        const senzaSegmento = structuredClone(it)
        delete (
            (senzaSegmento['offline.json'] as { etichette: { segmenti: Record<string, unknown> } }).etichette.segmenti
        ).chat
        const rigaSegmento = divergenzeDiChiavi(it, senzaSegmento)
        expect(rigaSegmento).toHaveLength(1)
        expect(rigaSegmento[0]).toContain('messages/en/offline.json')
        expect(rigaSegmento[0]).toContain('etichette.segmenti.chat')

        // E il difetto opposto — chiave che esiste solo in inglese — deve puntare
        // all'italiano, non all'inglese: il lato sbagliato manderebbe a correggere
        // il file sbagliato.
        const senzaTitoloIt = structuredClone(it)
        delete (senzaTitoloIt['avvisi.json'] as Record<string, unknown>).titolo
        const rigaTitolo = divergenzeDiChiavi(senzaTitoloIt, it)
        expect(rigaTitolo).toHaveLength(1)
        expect(rigaTitolo[0]).toContain('messages/it/avvisi.json')
        expect(rigaTitolo[0]).toContain('titolo')
    })
})
