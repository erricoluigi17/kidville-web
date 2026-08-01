import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTranslator } from 'use-intl'

/**
 * LOCK · i testi di catalogo: forme plurali, glossario, esempi, ellissi.
 *
 * Nasce dai rilievi del collaudo del 2026-07-31 (localizzazione F3 + tre warning),
 * che sono tre difetti diversi con la stessa firma: **non fanno rumore da nessuna
 * parte**. Il gate era verde con 3424 test mentre l'interfaccia scriveva «1 alunni».
 *
 *  1. PLURALI. Dieci contatori erano scritti come concatenazioni già formate
 *     (`"{n} alunni"`): con un solo elemento l'app scriveva «1 alunni» in italiano
 *     e «1 students» in inglese. Nessuno strumento poteva vederlo, perché `{n}` è
 *     sintatticamente identico a un segnaposto qualunque — e il mock di next-intl
 *     in `test/setup.ts` restituisce la stringa GREZZA, quindi nessun unit test
 *     legge mai il testo che leggerà l'utente. Qui il testo si rende davvero, con
 *     il formattatore ICU vero (`use-intl`, la libreria che sta sotto next-intl).
 *
 *  2. GLOSSARIO. Lo stesso tipo di avviso si chiamava «Acknowledgement» nell'elenco
 *     e «Read receipt» nella modale che lo crea: due nomi per la stessa cosa, nella
 *     stessa schermata, a un utente che non ha modo di capire che sono la stessa
 *     cosa. In italiano è sempre «Presa visione».
 *
 *  3. ESEMPI CON UN NOME DI PERSONA. `shared.galleryCercaPlaceholder` conteneva
 *     nome e cognome di una persona come esempio, **in un repository pubblico**.
 *     Verificato in produzione il 2026-08-01: non corrisponde a nessun alunno né a
 *     nessun genitore. Ma chi legge un repo pubblico non ha modo di saperlo, e un
 *     esempio non vale un dubbio: il segnaposto convenzionale è «Mario Rossi».
 *
 *  4. ELLISSI. 118 stringhe con tre punti contro 366 con l'ellissi tipografica, e
 *     una era a schermo («Caricamento anagrafica...»).
 *
 * ─── COSA NON CONTROLLA (di proposito) ────────────────────────────────────────
 *  · gli apostrofi dritti contro quelli tipografici (211 stringhe): è una scelta
 *    editoriale che va fatta una volta sola e su tutto il catalogo, non di sponda
 *    dentro un lock;
 *  · la parità delle chiavi fra le due lingue, che ha già il suo lock
 *    (`messaggi-parita-cataloghi.test.ts`).
 */

const RADICE = process.cwd()
const CARTELLA_MESSAGGI = join(RADICE, 'messages')
const LINGUE = ['it', 'en'] as const
type Lingua = (typeof LINGUE)[number]

/** Appiattisce un namespace in coppie `chiave.puntata` → valore. */
function vociPiatte(valore: unknown, prefisso = ''): Array<[string, unknown]> {
    if (valore === null || typeof valore !== 'object' || Array.isArray(valore)) {
        return [[prefisso, valore]]
    }
    return Object.entries(valore as Record<string, unknown>).flatMap(([chiave, v]) =>
        vociPiatte(v, prefisso ? `${prefisso}.${chiave}` : chiave),
    )
}

function leggiCatalogo(lingua: Lingua): Record<string, Record<string, unknown>> {
    const cartella = join(CARTELLA_MESSAGGI, lingua)
    const catalogo: Record<string, Record<string, unknown>> = {}
    for (const voce of readdirSync(cartella, { withFileTypes: true })) {
        if (!voce.isFile() || !voce.name.endsWith('.json')) continue
        catalogo[voce.name.replace(/\.json$/, '')] = JSON.parse(readFileSync(join(cartella, voce.name), 'utf8'))
    }
    return catalogo
}

const CATALOGHI: Record<Lingua, Record<string, Record<string, unknown>>> = {
    it: leggiCatalogo('it'),
    en: leggiCatalogo('en'),
}

/** Tutte le stringhe del catalogo, con l'indirizzo per chi legge il rosso. */
function tutteLeStringhe(lingua: Lingua): Array<{ dove: string; testo: string }> {
    const righe: Array<{ dove: string; testo: string }> = []
    for (const ns of Object.keys(CATALOGHI[lingua]).sort()) {
        for (const [chiave, valore] of vociPiatte(CATALOGHI[lingua][ns])) {
            if (typeof valore === 'string') righe.push({ dove: `messages/${lingua}/${ns}.json → ${chiave}`, testo: valore })
        }
    }
    return righe
}

/**
 * Rende un messaggio col formattatore ICU VERO: è l'unico modo di sapere che cosa
 * legge l'utente. `onError` rilancia, così un ICU malformato fa rosso qui invece di
 * degradare in silenzio nel nome della chiave (che è il comportamento di next-intl
 * in produzione, ed è esattamente il guasto che non si vede).
 */
function rende(
    messaggi: Record<string, Record<string, unknown>>,
    locale: string,
    ns: string,
    chiave: string,
    valori: Record<string, unknown>,
): string {
    const t = createTranslator({
        locale,
        messages: messaggi as never,
        namespace: ns as never,
        onError: (errore) => {
            throw errore
        },
    })
    return (t as unknown as (k: string, v: Record<string, unknown>) => string)(chiave, valori)
}

/**
 * I dieci contatori di F3. `extra` porta le variabili non numeriche che il
 * messaggio richiede: senza, il formattatore lancerebbe e il rosso parlerebbe di
 * un difetto che non c'è.
 */
const CONTATORI: Array<{ ns: string; chiave: string; variabile: string; extra?: Record<string, unknown> }> = [
    { ns: 'adminStudents', chiave: 'contAlunni', variabile: 'n' },
    { ns: 'adminStudents', chiave: 'secConfigurate', variabile: 'n' },
    { ns: 'adminStudents', chiave: 'toastAssegnati', variabile: 'n', extra: { classe: '3 ANNI' } },
    { ns: 'adminStudents', chiave: 'toastAssegnatiMensa', variabile: 'n', extra: { nome: 'Senza glutine' } },
    { ns: 'adminStudents', chiave: 'toastExport', variabile: 'n' },
    { ns: 'avvisi', chiave: 'sottotitoloDaGestire', variabile: 'count' },
    { ns: 'diario', chiave: 'fotoScattate', variabile: 'count' },
    { ns: 'teacherPrimaria', chiave: 'scrutinioImportate', variabile: 'count' },
    { ns: 'teacherServizi', chiave: 'modulisticaFirmati', variabile: 'count' },
    { ns: 'teacherServizi', chiave: 'modulisticaMancanti', variabile: 'count' },
]

/**
 * Le etichette che in inglese NON cambiano al plurale, e per cui pretendere una
 * forma singolare diversa sarebbe un errore: «1 Signed» e «5 Signed» sono
 * entrambe corrette. Sono dichiarate qui una per una — e il lock verifica che
 * siano DAVVERO invarianti: se un giorno l'inglese diventasse «# Signed forms»,
 * questa riga va tolta, e il test lo dice invece di lasciar passare l'eccezione.
 * In italiano non ce n'è nessuna: «firmato/firmati», «mancante/mancanti».
 */
const INVARIANTI_IN_INGLESE = new Set(['teacherServizi.modulisticaFirmati', 'teacherServizi.modulisticaMancanti'])

/**
 * Un contatore ha forma singolare se il testo reso con 1 è DIVERSO da quello reso
 * con 2. Non guarda la sintassi del messaggio: guarda il risultato, che è la sola
 * cosa che l'utente vede. Ritorna la coppia resa, così il messaggio d'errore mostra
 * il testo vero invece di dire soltanto «manca il plurale».
 */
function coppiaSingolarePlurale(
    messaggi: Record<string, Record<string, unknown>>,
    locale: string,
    voce: (typeof CONTATORI)[number],
): { uno: string; due: string } {
    const valori = (n: number) => ({ [voce.variabile]: n, ...(voce.extra ?? {}) })
    return {
        uno: rende(messaggi, locale, voce.ns, voce.chiave, valori(1)),
        due: rende(messaggi, locale, voce.ns, voce.chiave, valori(2)),
    }
}

// ── Glossario ────────────────────────────────────────────────────────────────
// Il termine di prodotto è UNO: il tipo di avviso in cui il genitore dichiara di
// aver preso visione. In inglese si dice «acknowledgement»: è un'azione esplicita
// del genitore (con firma OTP, quando è attiva), non la ricevuta automatica che
// «read receipt» evoca nelle email.
const TERMINE_BANDITO = /read receipt/i
const TERMINE_SCELTO = /acknowledg/i
const PRESA_VISIONE_IT = /pres[ae] visione/i

/** Le voci di una lingua che contengono un termine, con il loro indirizzo. */
const conTermine = (lingua: Lingua, termine: RegExp) =>
    tutteLeStringhe(lingua).filter((r) => termine.test(r.testo))

// ── Esempi con un nome di persona ────────────────────────────────────────────
// L'unico segnaposto ammesso nei cataloghi. «Mario Rossi» è il John Doe italiano,
// ed è già il segnaposto usato altrove nel repo (`mario.rossi@email.com`).
const SEGNAPOSTO_CONVENZIONALI = new Set(['Mario Rossi'])
const MARCATORE_ESEMPIO = /\b(es\.|ad es\.|e\.g\.|eg\.)/i

/**
 * I nomi di persona usati come esempio in una stringa di catalogo.
 *
 * Regola, dichiarata perché è un'euristica e non un oracolo: in una stringa che
 * introduce un esempio, **due** parole capitalizzate consecutive sono un nome e un
 * cognome; **tre o più** sono il titolo di un documento («Consenso Uscita Didattica
 * Museo Scienza», «Consent for Science Museum Field Trip»), che non è un dato
 * personale. Se un giorno servisse un altro segnaposto, si allunga l'insieme qui
 * sopra — con la motivazione accanto.
 */
function nomiPropriNegliEsempi(testo: string): string[] {
    if (!MARCATORE_ESEMPIO.test(testo)) return []
    const parolaCapitalizzata = /[A-ZÀ-Ý][a-zà-ÿ]+/
    const trovati: string[] = []
    let corsa: string[] = []
    const chiudi = () => {
        if (corsa.length === 2 && !SEGNAPOSTO_CONVENZIONALI.has(corsa.join(' '))) trovati.push(corsa.join(' '))
        corsa = []
    }
    // Il marcatore va tolto PRIMA di leggere le parole: «Es.» è capitalizzato
    // quanto un nome, e lasciarlo dentro trasformava «Es. Sport e movimento» in
    // una coppia «Es Sport» — cioè in un falso allarme — e, peggio, faceva
    // scivolare un nome vero dentro una corsa di tre parole (dove il lock tace).
    // La punteggiatura spezza la corsa: nome e cognome sono separati da uno
    // spazio, mai da una virgola o da una parentesi («Nido, Infanzia» è un elenco).
    for (const segmento of testo.replace(MARCATORE_ESEMPIO, ' ').split(/[^A-Za-zÀ-ÿ ]+/)) {
        for (const parola of segmento.split(/\s+/).filter(Boolean)) {
            if (parolaCapitalizzata.test(parola) && parola === parola.match(parolaCapitalizzata)?.[0]) corsa.push(parola)
            else chiudi()
        }
        chiudi()
    }
    return trovati
}

describe('lock architettura · plurali, glossario ed esempi nei cataloghi', () => {
    it('i dieci contatori rendono un SINGOLARE diverso dal plurale, in italiano e in inglese', () => {
        const guasti: string[] = []
        const eccezioniSmentite: string[] = []
        for (const lingua of LINGUE) {
            for (const voce of CONTATORI) {
                const { uno, due } = coppiaSingolarePlurale(CATALOGHI[lingua], lingua, voce)
                const invariante = uno === due.replace(/\b2\b/, '1')
                const attesaInvariante = lingua === 'en' && INVARIANTI_IN_INGLESE.has(`${voce.ns}.${voce.chiave}`)
                if (invariante && !attesaInvariante) {
                    guasti.push(
                        `messages/${lingua}/${voce.ns}.json → ${voce.chiave}: con ${voce.variabile}=1 rende ` +
                        `«${uno}», che è il plurale con davanti un 1. Serve la forma ICU: ` +
                        `"{${voce.variabile}, plural, one {# …} other {# …}}".`,
                    )
                }
                if (!invariante && attesaInvariante) {
                    eccezioniSmentite.push(
                        `messages/${lingua}/${voce.ns}.json → ${voce.chiave}: rende «${uno}» / «${due}», ` +
                        `quindi NON è più invariante: va tolta da INVARIANTI_IN_INGLESE.`,
                    )
                }
            }
        }
        expect(
            guasti,
            `Contatori senza forma singolare:\n  ${guasti.join('\n  ')}\n` +
            `Con un solo elemento l'interfaccia scrive «1 alunni». Il mock di next-intl in ` +
            `test/setup.ts NON interpreta ICU: nessun unit test può accorgersene, solo questo lock.`,
        ).toEqual([])
        expect(
            eccezioniSmentite,
            `Eccezioni dichiarate che non reggono più:\n  ${eccezioniSmentite.join('\n  ')}`,
        ).toEqual([])
    })

    it('il caso preciso del collaudo: «1 alunno», non «1 alunni»', () => {
        // Il criterio scritto nel piano, verificato sul testo vero.
        expect(rende(CATALOGHI.it, 'it', 'adminStudents', 'contAlunni', { n: 1 })).toBe('1 alunno')
        expect(rende(CATALOGHI.it, 'it', 'adminStudents', 'contAlunni', { n: 3 })).toBe('3 alunni')
        expect(rende(CATALOGHI.en, 'en', 'adminStudents', 'contAlunni', { n: 1 })).toBe('1 student')
        expect(rende(CATALOGHI.en, 'en', 'adminStudents', 'contAlunni', { n: 3 })).toBe('3 students')
    })

    it('il controllo del singolare vede davvero un contatore rotto (e non urla su uno sano)', () => {
        // Senza questa prova, un `coppiaSingolarePlurale` che ritornasse sempre due
        // stringhe diverse lascerebbe il lock verde per sempre.
        const voce = { ns: 'finto', chiave: 'k', variabile: 'n' }
        const rotto = { finto: { k: '{n} alunni' } }
        const sano = { finto: { k: '{n, plural, one {# alunno} other {# alunni}}' } }

        const esitoRotto = coppiaSingolarePlurale(rotto, 'it', voce)
        expect(esitoRotto.uno).toBe('1 alunni')
        expect(esitoRotto.uno).toBe(esitoRotto.due.replace(/\b2\b/, '1')) // ⟵ il difetto è visibile

        const esitoSano = coppiaSingolarePlurale(sano, 'it', voce)
        expect(esitoSano.uno).toBe('1 alunno')
        expect(esitoSano.uno).not.toBe(esitoSano.due.replace(/\b2\b/, '1')) // ⟵ e il sano passa
    })

    it('«presa visione» ha UN SOLO nome in inglese: nessun «Read receipt» in catalogo', () => {
        const superstiti = conTermine('en', TERMINE_BANDITO)
        expect(
            superstiti.map((r) => r.dove),
            `Il glossario inglese ha di nuovo due nomi per la stessa cosa:\n  ` +
            `${superstiti.map((r) => `${r.dove} = «${r.testo}»`).join('\n  ')}\n` +
            `Il termine scelto è «acknowledgement»: il genitore compie un'azione esplicita ` +
            `(con firma OTP, quando è attiva), non riceve una ricevuta di lettura automatica.`,
        ).toEqual([])
    })

    it('e il termine scelto c\'è per davvero (se sparisse, il controllo qui sopra sarebbe vuoto)', () => {
        // Un lock che vieta una parola è verde anche su un catalogo cancellato: questo
        // è il controllo positivo che tiene onesto il precedente.
        const conAcknowledge = conTermine('en', TERMINE_SCELTO)
        expect(conAcknowledge.length).toBeGreaterThanOrEqual(10)
        // E la scansione trova davvero il termine bandito, quando c'è.
        expect(TERMINE_BANDITO.test('📖 Read receipt')).toBe(true)
        expect(TERMINE_BANDITO.test('📖 Acknowledgement')).toBe(false)
    })

    it('ogni «presa visione» italiana ha un «acknowledgement» inglese sulla stessa chiave', () => {
        // Il difetto del collaudo non era una parola vietata: era l'elenco che diceva
        // una cosa e la modale un'altra. Si chiude solo confrontando chiave per chiave.
        const disallineate: string[] = []
        let esaminate = 0
        for (const ns of Object.keys(CATALOGHI.it).sort()) {
            const en = CATALOGHI.en[ns]
            if (!en) continue
            for (const [chiave, valore] of vociPiatte(CATALOGHI.it[ns])) {
                if (typeof valore !== 'string' || !PRESA_VISIONE_IT.test(valore)) continue
                esaminate++
                const controparte = vociPiatte(en).find(([k]) => k === chiave)?.[1]
                if (typeof controparte !== 'string' || !TERMINE_SCELTO.test(controparte)) {
                    disallineate.push(`${ns}.json → ${chiave}: IT «${valore}» ⟶ EN «${String(controparte)}»`)
                }
            }
        }
        // Se l'elenco esaminato fosse vuoto, l'asserzione qui sotto sarebbe verde
        // senza aver guardato niente.
        expect(esaminate, 'nessuna chiave italiana contiene «presa visione»: il lock non sta guardando niente').toBeGreaterThanOrEqual(8)
        expect(
            disallineate,
            `Queste voci parlano di «presa visione» in italiano ma non di «acknowledgement» in inglese:\n  ` +
            `${disallineate.join('\n  ')}`,
        ).toEqual([])
    })

    it('nessun catalogo usa il nome di una persona come esempio', () => {
        const trovati: string[] = []
        for (const lingua of LINGUE) {
            for (const { dove, testo } of tutteLeStringhe(lingua)) {
                for (const nome of nomiPropriNegliEsempi(testo)) trovati.push(`${dove} = «${testo}» → «${nome}»`)
            }
        }
        expect(
            trovati,
            `Esempi con un nome e cognome, in un repository PUBBLICO:\n  ${trovati.join('\n  ')}\n` +
            `Chi legge il repo non ha modo di sapere se la persona esiste. Il segnaposto è ` +
            `«Mario Rossi», come l'indirizzo email d'esempio già usato nel repo.`,
        ).toEqual([])
    })

    it('il riconoscitore di nomi distingue un nome da un titolo di documento', () => {
        // Controllo negativo: un nome messo come esempio va visto…
        expect(nomiPropriNegliEsempi('Cerca alunno o genitore (es. Giulia Esposito)…')).toEqual(['Giulia Esposito'])
        expect(nomiPropriNegliEsempi('E.g. Signed form request for Anna Verdi')).toEqual(['Anna Verdi'])
        // …anche quando il marcatore è in testa e maiuscolo: se «Es.» venisse
        // contato come parola, il nome finirebbe in una corsa di tre e sparirebbe.
        expect(nomiPropriNegliEsempi('Es. Richiesta modulo firmato per Anna Verdi')).toEqual(['Anna Verdi'])
        expect(nomiPropriNegliEsempi('Es. Anna Verdi')).toEqual(['Anna Verdi'])
        // …e un placeholder senza nomi non deve produrre allarmi per colpa del
        // marcatore o della punteggiatura (un elenco separato da virgole non è un
        // nome e cognome: sono i tre casi che questo lock ha sbagliato al primo giro).
        expect(nomiPropriNegliEsempi('Es. Sport e movimento')).toEqual([])
        expect(nomiPropriNegliEsempi('Es. Comune di Giugliano')).toEqual([])
        expect(nomiPropriNegliEsempi('Definisci i periodi (es. 1° Quadrimestre, Scrutinio finale).')).toEqual([])
        expect(nomiPropriNegliEsempi('Nome (es. Scrutinio finale)')).toEqual([])
        expect(nomiPropriNegliEsempi('Crea più menu (es. Nido, Infanzia e Primaria).')).toEqual([])
        // …il segnaposto convenzionale no…
        expect(nomiPropriNegliEsempi('Cerca alunno o genitore (es. Mario Rossi)…')).toEqual([])
        // …un titolo di documento nemmeno (tre o più parole capitalizzate di fila)…
        expect(nomiPropriNegliEsempi('Es. Consenso Uscita Didattica Museo Scienza')).toEqual([])
        expect(nomiPropriNegliEsempi('E.g. Consent for Science Museum Field Trip')).toEqual([])
        // …e una frase senza marcatore d'esempio resta fuori dal perimetro.
        expect(nomiPropriNegliEsempi('Kidville Giugliano')).toEqual([])
    })

    it('i puntini di sospensione sono sempre l\'ellissi tipografica', () => {
        const guasti = LINGUE.flatMap((lingua) =>
            tutteLeStringhe(lingua)
                .filter((r) => r.testo.includes('...'))
                .map((r) => `${r.dove} = «${r.testo}»`),
        )
        expect(
            guasti,
            `Queste voci usano tre punti al posto dell'ellissi «…»:\n  ${guasti.join('\n  ')}\n` +
            `Il catalogo ne aveva 366 tipografiche contro 118 a tre punti, e una era a schermo ` +
            `(«Caricamento anagrafica...»).`,
        ).toEqual([])
        // Controllo positivo: l'ellissi tipografica è davvero in uso, non è che siano
        // sparite le une e le altre.
        expect(LINGUE.flatMap((l) => tutteLeStringhe(l).filter((r) => r.testo.includes('…'))).length).toBeGreaterThan(300)
    })
})
