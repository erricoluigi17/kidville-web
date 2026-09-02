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
 *  5. APOSTROFI. Fino al 2026-08-08 questo file dichiarava, qui sotto, di NON
 *     controllarli: «è una scelta editoriale che va fatta una volta sola e su
 *     tutto il catalogo, non di sponda dentro un lock». La scelta non è mai stata
 *     fatta, e nel frattempo ogni rilascio ne aggiungeva delle due specie — il
 *     collaudo del 2026-08-07 ha misurato la stessa parola, «l'assenza», scritta
 *     col dritto in una schermata e col tipografico nell'altra, dentro le stringhe
 *     nate LO STESSO GIORNO. Un lock che dichiara di non guardare è il posto in cui
 *     il difetto torna a ogni stringa nuova.
 *     La convenzione, decisa e da qui in avanti applicata: **l'apostrofo è sempre
 *     il tipografico U+2019** (’), in italiano e in inglese. È la forma corretta
 *     in tipografia italiana e l'unica compatibile con l'apostrofo che le
 *     tastiere di iOS e Android inseriscono da sole. 248 valori normalizzati in
 *     40 file nello stesso passaggio.
 *
 * ─── COSA NON CONTROLLA (di proposito) ────────────────────────────────────────
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
    // Trovati dal RICONOSCITORE DI FORMA (in fondo a questo file) il 2026-08-02,
    // cioè dal criterio che ha sostituito questa enumerazione. Restano elencati
    // qui perché il test di sopra rende il testo e mostra la coppia 1/2: è la
    // diagnosi migliore. Ma non sono più *loro* il perimetro.
    { ns: 'teacherPrimaria', chiave: 'scrutinioImportateErrori', variabile: 'count' },
    { ns: 'teacherPrimaria', chiave: 'scrutinioPagelleGenerate', variabile: 'totale', extra: { generate: 1 } },
    { ns: 'adminPrimaria', chiave: 'orarioAttivo', variabile: 'giorni', extra: { modello: 40 } },
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

    /**
     * L'UNICA voce che tiene ancora l'apostrofo dritto, con la ragione e la via
     * d'uscita. Non è una preferenza editoriale: è un vincolo misurato di un altro
     * lock, e va scritto qui invece di essere aggirato.
     */
    const APOSTROFO_DRITTO_AMMESSO = new Map<string, string>([
        [
            'it/teacherNav.json → appelloCtaFai',
            'È il selettore ESATTO di `android-percorso-docente.yaml` e `ios-percorso-docente.yaml`, ' +
            'due flow con esecuzione verde DICHIARATA su device (2026-08-02, 31 e 27 COMPLETED). ' +
            'R9b confronta l\'impronta dei selettori con quella provata: cambiare un carattere la ' +
            'invalida, e i due flow finirebbero in FLOW_SENZA_ESECUZIONE_VERDE, che è già al suo ' +
            'tetto (3/3, R9c — «il tetto scende quando si collauda, non sale quando fa comodo»). ' +
            'VIA D\'USCITA: chi rilancia i due percorsi docente su emulatore e simulatore ' +
            'normalizzi questa stringa nello stesso passaggio, aggiorni i tre selettori nei flow ' +
            'e la firma in ESECUZIONI_VERDI, e tolga questa riga.',
        ],
    ])

    it('l\'unica eccezione all\'apostrofo è dichiarata, motivata e può solo sparire', () => {
        expect(APOSTROFO_DRITTO_AMMESSO.size, 'le eccezioni all\'apostrofo non aumentano').toBeLessThanOrEqual(1)
        for (const [voce, motivo] of APOSTROFO_DRITTO_AMMESSO) {
            expect(motivo.length, `${voce} è dichiarata senza motivo`).toBeGreaterThan(80)
        }
        // E l'eccezione deve descrivere il catalogo VERO: se un giorno quella stringa
        // venisse normalizzata, questa riga resterebbe a proteggere il nulla.
        const testo = (CATALOGHI.it['teacherNav'] as Record<string, string>).appelloCtaFai
        expect(testo, 'messages/it/teacherNav.json → appelloCtaFai non esiste più').toBeTypeOf('string')
        expect(testo.includes("'"), 'l\'eccezione non serve più: togli la riga da APOSTROFO_DRITTO_AMMESSO').toBe(true)
    })

    it('l\'apostrofo è sempre quello tipografico «’», mai il dritto', () => {
        // Il dritto (U+0027) è il carattere della tastiera del programmatore: nei
        // cataloghi non ha nessun uso legittimo — non c'è codice, non ci sono unità di
        // misura, e il possessivo inglese («{nome}’s day») vuole il tipografico quanto
        // l'elisione italiana. Il difetto non è estetico: la stessa frase compariva
        // nelle due forme in due schermate che il genitore apre lo stesso giorno.
        const guasti = LINGUE.flatMap((lingua) =>
            tutteLeStringhe(lingua)
                .filter((r) => r.testo.includes("'"))
                // `dove` vale «messages/it/teacherNav.json → appelloCtaFai»: l'indirizzo
                // dell'eccezione è la sua coda, così la chiave dichiarata è la stessa che
                // si legge nel rosso.
                .filter((r) => ![...APOSTROFO_DRITTO_AMMESSO.keys()].some((k) => r.dove.endsWith(k)))
                .map((r) => `${r.dove} = «${r.testo}»`),
        )
        expect(
            guasti,
            `Queste voci usano l'apostrofo dritto U+0027 al posto del tipografico «’» (U+2019):\n  ` +
            `${guasti.join('\n  ')}\n` +
            `La convenzione del catalogo è il tipografico, in entrambe le lingue. Se una stringa ` +
            `dovesse davvero contenere il dritto, va motivata in APOSTROFO_DRITTO_AMMESSO — non ` +
            `aggiunta in silenzio.`,
        ).toEqual([])
        // Controllo positivo: il tipografico è davvero in uso. Senza questa riga, il
        // divieto qui sopra sarebbe verde anche su un catalogo in cui gli apostrofi
        // sono spariti tutti — cioè su testi rotti in un altro modo.
        expect(LINGUE.flatMap((l) => tutteLeStringhe(l).filter((r) => r.testo.includes('’'))).length).toBeGreaterThan(200)
    })
    /**
     * ── IL RICONOSCITORE DI FORMA ────────────────────────────────────────────
     *
     * `CONTATORI` è un ELENCO A MANO, e un elenco a mano protegge le voci che
     * qualcuno si è ricordato di scriverci. Il 2026-08-02 il collaudo ha trovato
     * TRE contatori sbagliati — `scrutinioImportateErrori`, `scrutinioPagelleGenerate`,
     * `orarioAttivo` — tutti e tre FUORI da quell'elenco, con il gate verde. È la
     * stessa firma del difetto che questo lock era nato per chiudere: una regola
     * giusta applicata a una lista chiusa.
     *
     * Qui il criterio non è più «chi è iscritto», è la FORMA: un segnaposto
     * numerico (`{n}` o `#`) seguito da una parola alfabetica, fuori da un blocco
     * `plural`/`select`, è un candidato contatore. Una chiave nuova entra da sola
     * nel perimetro; per uscirne deve essere DICHIARATA qui sotto con il motivo.
     *
     * L'euristica dà falsi positivi — «Passo {n} di {totale}», «max {mb} MB»,
     * «alle {ora}» — e per questo l'allowlist esiste. Non dà però falsi negativi
     * sulla forma che conta, ed è l'unica proprietà che serve a un lock.
     */
    const NON_CONTATORI = new Map<string, string>([
        // (a) il segnaposto NON è un conteggio: è una data, un'ora, un nome, un
        //     importo, un tipo. Il sostantivo che segue non concorda con esso.
        ['adminAltro.protAnnullataBanner', 'data e ora, non conteggi'],
        ['adminAltro.protDettaglioSubtitle', 'tipo/data/ora, non conteggi'],
        ['adminAltro.protDocSostituito', 'numero di protocollo: identificativo, non quantità'],
        ['adminAltro.protEmergenzaEvento', 'data e ora'],
        ['adminComunicazioni.editorRitrattiRimuovi', 'nome del bambino'],
        ['adminStudents.detailPageArchiviato', 'nome e cognome del bambino appena archiviato'],
        ['adminStudents.detailPageRiattivato', 'nome e cognome del bambino appena riportato fra gli iscritti'],
        ['adminStudents.detailPageRiattivatoSenzaClasse', 'nome e cognome del bambino, che rientra senza classe'],
        ['adminPrimaria.materieNessunObiettivoDefinito', 'codice materia e livello ordinale'],
        ['diario.nannaDurata', 'orari di inizio e fine'],
        ['parentServizi.modulisticaPeriodoDalAl', 'date di inizio e fine di un periodo, non conteggi'],
        ['pagamenti.importoScaduti', 'importo in euro, già formattato'],
        ['pagamenti.restaImporto', 'importo in euro, già formattato'],
        ['parentChat.outOfHoursFallback', 'orari di apertura'],
        ['parentServizi.galleryInfoPrivacy', 'nome del bambino'],
        ['parentServizi.sospensioneScaduto', 'importo in euro, già formattato'],
        ['teacherDiario.descriviAttivita', 'tipo di attività'],
        ['teacherDiario.salvaPerTutti', 'nome dell’evento'],

        // (b) il segnaposto è un numero, ma la parola che segue è un'UNITÀ o una
        //     preposizione: non va mai al plurale. «max 1 MB» è corretto.
        ['adminAltro.protFileTroppoGrande', 'unità di misura (MB)'],
        ['adminAltro.protUploadHint', 'unità di misura (MB)'],
        ['parentForms.fileTroppoPesante', 'unità di misura (MB)'],
        ['adminStudents.staffDocTroppoGrande', 'unità di misura (MB)'],
        ['teacherServizi.galleryAlertVideoTroppoGrande', 'unità di misura (MB)'],
        ['adminComunicazioni.avvisiAdesioniSiNo', '«sì»/«no»: avverbi, invarianti'],
        ['teacherNav.adesioniSiNo', '«sì»/«no»: avverbi, invarianti'],
        ['parentForms.firmatarioNdi2', 'forma «N di 2»: posizione in una sequenza'],
        ['parentForms.passo', 'forma «passo N di M»: posizione in una sequenza'],
        ['public.wizardPassoDi', 'forma «passo N di M»: posizione in una sequenza'],
        ['teacherPresenze.pdfPiePagina', 'forma «pagina N di M»: posizione in una sequenza'],
        ['teacherServizi.galleryFotoNofM', 'forma «foto N di M»: posizione in una sequenza'],

        // (c) FRAZIONE `n/tot`: il sostantivo concorda con il totale, non con il
        //     numeratore. «1/20 presenti» è corretto e «1/20 presente» sarebbe
        //     sbagliato.
        ['adminNav.sedePresenti', 'frazione presenti/iscritti'],
        ['teacherPresenze.oggiConteggio', 'frazione presenti/totale'],

        // (d) l'inglese è invariante e l'italiano non ha sostantivo: già coperte
        //     dal test sopra tramite CONTATORI + INVARIANTI_IN_INGLESE.
        ['teacherServizi.modulisticaFirmati', 'già in CONTATORI'],
        ['teacherServizi.modulisticaMancanti', 'già in CONTATORI'],
        ['teacherPrimaria.overviewInClasse', 'complemento di luogo invariante: «1 in classe» / «1 in class»'],

        // (e) DEBITO DICHIARATO — sono contatori veri, non ancora portati a ICU.
        //     Restano qui con la loro ragione invece di sparire: chi passa di qua
        //     sa che ci sono. Sono tutti su schermate di sola SEGRETERIA e in
        //     riepiloghi che elencano più conteggi nella stessa frase, dove
        //     l'ICU va scritto una clausola per conteggio. Questa mappa può solo
        //     accorciarsi: il test qui sotto ne fissa il tetto.
        ['adminAltro.richiesteFigli', 'DEBITO: «{iscritti} iscritti» — due conteggi in una riga'],
        ['adminModulistica.rnkDeliberaConfirm', 'DEBITO: «{posti} posti» in una conferma di segreteria'],
        ['adminSettings.ieRisultato', 'DEBITO: tre conteggi in una riga di esito import'],
        ['adminSettings.siImportCompletato', 'DEBITO: tre conteggi in una riga di esito import'],
    ])

    /** Un blocco ICU `plural`/`select` apre il perimetro in cui `#` è già gestito. */
    const APRE_BLOCCO_ICU = /\{\s*\w+\s*,\s*(?:plural|select|selectordinal)\s*,/
    /** Segnaposto numerico seguito da una parola: il candidato contatore. */
    const SEGNAPOSTO_PIU_PAROLA = /(?:#|\{\s*\w+\s*\})\s+[A-Za-zÀ-ÿ]{2,}/

    it('nessun contatore NUOVO nasce fuori dal perimetro (riconoscimento per FORMA)', () => {
        const scoperti = new Set<string>()
        for (const lingua of LINGUE) {
            for (const ns of Object.keys(CATALOGHI[lingua]).sort()) {
                for (const [chiave, valore] of vociPiatte(CATALOGHI[lingua][ns])) {
                    if (typeof valore !== 'string') continue
                    if (APRE_BLOCCO_ICU.test(valore)) continue
                    if (!SEGNAPOSTO_PIU_PAROLA.test(valore)) continue
                    const indirizzo = `${ns}.${chiave}`
                    if (NON_CONTATORI.has(indirizzo)) continue
                    if (CONTATORI.some((c) => `${c.ns}.${c.chiave}` === indirizzo)) continue
                    scoperti.add(`${indirizzo} → «${valore.slice(0, 90)}»`)
                }
            }
        }
        expect(
            [...scoperti].sort(),
            'Segnaposto numerico seguito da una parola, fuori da un blocco plural.\n' +
            'Se è un CONTATORE: portalo alla forma ICU «{n, plural, one {# …} other {# …}}».\n' +
            'Se non lo è (data, ora, nome, unità di misura, frazione): dichiaralo in ' +
            'NON_CONTATORI con il motivo, in una riga.',
        ).toEqual([])
    })

    it('l’allowlist può solo accorciarsi', () => {
        // Il tetto è il numero di oggi. Chi aggiunge una riga a NON_CONTATORI
        // deve abbassarlo o spiegarsi: senza questo, l'elenco delle eccezioni
        // diventa il posto dove i contatori sbagliati vanno a nascondersi.
        //
        // 2026-08-12 · 37 → 38, e la spiegazione. `adminStudents.detailPageArchiviato`
        // annuncia alla segreteria QUALE bambino è appena stato spostato fra i «non
        // più iscritti»: `{nome}` è un nome e un cognome, non un conteggio, e in
        // inglese («{nome} has been moved…») cade sotto il riconoscitore di forma
        // solo perché la parola che segue è lunga più di una lettera — in italiano
        // («{nome} è stato spostato…») lo stesso messaggio non viene nemmeno visto.
        // La via alternativa era riscrivere la frase inglese per schivare la regexp:
        // sarebbe stato piegare un messaggio a un lock invece di dichiarare
        // un'eccezione vera.
        //
        // 2026-08-12 · 38 → 39. `adminStudents.staffDocTroppoGrande` è il rifiuto che
        // legge la Segreteria quando la fotografia di un documento supera il tetto
        // della piattaforma: «al massimo {mb} MB». Cade nella categoria (b), che di
        // voci ne conta già quattro — MB è un'unità di misura e non va mai al plurale.
        // Il numero, per giunta, NON è cablato nella frase: arriva da
        // `limiteUploadMb`, che è la stessa costante che decide il rifiuto. L'altra
        // strada era passare «4 MB» come UN valore già composto, e sarebbe stata
        // peggio: l'unità smetterebbe di essere traducibile per schivare una regexp.
        //
        // 2026-08-13 · 39 → 41, e sono le due GEMELLE della riga del 12/08.
        // `detailPageRiattivato` e `detailPageRiattivatoSenzaClasse` annunciano
        // QUALE bambino è appena tornato fra gli iscritti — l'altra metà del
        // modello a due tempi, che fino a oggi la scheda alunno non sapeva fare.
        // `{nome}` è lo stesso nome e cognome di `detailPageArchiviato`, cade sotto
        // il riconoscitore per la stessa ragione (in inglese la parola che segue è
        // lunga più di una lettera, in italiano il messaggio non viene nemmeno
        // visto), e la strada alternativa è la stessa già scartata due righe più
        // su: riscrivere la frase inglese per schivare la regexp sarebbe piegare
        // un messaggio a un lock invece di dichiarare un'eccezione vera. Due
        // messaggi nuovi, due eccezioni dichiarate: il tetto sale di due e non di
        // più, ed è questo che rende leggibile la crescita di questo elenco.
        //
        // 2026-08-16 · 41 → 40, e per una volta il tetto SCENDE.
        // `adminModulistica.modOdtCaricato` («📄 {nome} caricato») era il badge del
        // tab «Template Certificati ODT»: un mockup: l'`onChange` teneva il NOME del
        // file in `useState` e basta — nessun caricamento, nessuna riga nel database,
        // e il badge spariva al primo aggiornamento della pagina. Tolto il tab, la
        // chiave non esiste più in nessuno dei due cataloghi, e la sua eccezione va
        // via con lei. Il tetto scende insieme: un'allowlist che non si abbassa
        // quando una voce muore lascia un posto libero a chi verrà dopo, ed è
        // esattamente il modo in cui questi elenchi smettono di stringere.
        //
        // 2026-08-16 (poche ore dopo) · 40 → 38, e sono le DUE voci che quella regola
        // aveva mancato lo stesso giorno in cui la scriveva. `modFamiglia`
        // («Famiglia {cognome}») e `modConfermaApprovazioneTesto` erano le frasi della
        // «Sala d'Attesa»: la prima è morta col pannello — irraggiungibile da mesi,
        // cancellato quel giorno — la seconda con la finestra di conferma
        // dell'approvazione, smontata insieme alla scheda della pre-iscrizione e ai suoi
        // due gestori. Il difetto non era il tetto: era che un tetto scende solo se
        // qualcuno RIMISURA, e finora nessuno chiedeva a questo elenco se i suoi
        // bersagli fossero ancora vivi. Ora glielo si chiede, tre righe più giù.
        //
        // 2026-09-01 · 38 → 39. `parentServizi.modulisticaPeriodoDalAl` («dal {da} al
        // {a}») è come si legge un periodo nel chip di un filtro — la barra della
        // «Modulistica» del genitore, dove il periodo di firma e quello di copertura di
        // un certificato medico diventano un chip removibile. Cade nella categoria (a),
        // la stessa di `diario.nannaDurata`: i due segnaposti sono DATE già formattate,
        // e la parola che segue («al») è una preposizione, non un sostantivo che possa
        // andare al plurale.
        //
        // ⚠️ La via alternativa era scrivere «{da} → {a}», che schiva il riconoscitore
        // perché dopo il segnaposto non c'è una parola. Scartata: quella freccia è il
        // testo che il MOTORE produce da solo quando la pagina non gli passa un
        // descrittore (`descriviPeriodo` in `lib/ui/filtri/motore.ts`), ed è neutro di
        // lingua proprio perché non è italiano. Adottarlo per far tacere un lock
        // significherebbe rinunciare alla frase leggibile che questa chiave esiste per
        // dare — cioè piegare un messaggio a una regexp, che è la scelta già scartata
        // due volte il 12 e il 13 agosto.
        expect(NON_CONTATORI.size).toBeLessThanOrEqual(39)
        // …e ogni eccezione porta una ragione scritta, non una riga muta.
        for (const [chiave, motivo] of NON_CONTATORI) {
            expect(motivo.length, `${chiave} è dichiarata senza motivo`).toBeGreaterThan(8)
        }
        // …e punta a una chiave che nel catalogo ESISTE ANCORA.
        //
        // La riga che mancava, e che rende il tetto una misura invece di un numero. Due
        // voci hanno continuato a valere — verdi, sotto il tetto — per chiavi che nessuno
        // dei due cataloghi conteneva più: un'eccezione non sa da sola che il suo bersaglio
        // è morto, e finché nessuno lo chiede tiene occupato un posto che a quel punto
        // eredita chi verrà dopo. È la stessa forma del difetto che questo elenco è nato
        // per chiudere: una regola giusta appoggiata a una lista che nessuno rimisura.
        const indirizziVivi = new Set(
            Object.entries(CATALOGHI.it).flatMap(([ns, gruppo]) =>
                vociPiatte(gruppo).map(([chiave]) => `${ns}.${chiave}`),
            ),
        )
        const bersagliMorti = [...NON_CONTATORI.keys()].filter((k) => !indirizziVivi.has(k))
        expect(
            bersagliMorti,
            'Queste eccezioni valgono per chiavi che nel catalogo italiano non esistono più:\n  ' +
                bersagliMorti.join('\n  ') +
                '\nVanno tolte da NON_CONTATORI, e il tetto qui sopra va abbassato di altrettanto.',
        ).toEqual([])
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. RESIDUI DI LINGUA — una frase dell'altra lingua dentro il catalogo sbagliato
// ─────────────────────────────────────────────────────────────────────────────

/**
 * IL DIFETTO (collaudo del 2026-08-08, localizzazione Q16). Il piè di pagina del
 * PDF del registro presenze recitava «Kidville Electronic Register» **anche nel
 * catalogo italiano**, mentre le due chiavi accanto — `pdfTitolo` e `pdfMeta` —
 * erano tradotte come si deve. Traducendo `en` a partire da `it`, la coda della
 * riga è stata scambiata per il NOME DEL PRODOTTO e lasciata identica: ma il nome
 * del prodotto è «Kidville», mentre «Electronic Register» è una descrizione, e una
 * descrizione si traduce.
 *
 * PERCHÉ NESSUNO STRUMENTO LO VEDEVA. La parità dei cataloghi
 * (`messaggi-parita-cataloghi.test.ts`) confronta le CHIAVI, e la chiave c'era in
 * entrambe le lingue. Il mock di next-intl (`test/setup.ts`) risolve i soli
 * messaggi italiani, quindi nessun unit test legge mai una schermata come la legge
 * un utente inglese. E il confronto valore-per-valore non basta: qui le due
 * stringhe NON sono identiche («Pagina {n} di {tot}» ≠ «Page {n} of {tot}»), è
 * solo la coda a esserlo — il difetto sopravvive a qualunque regola sull'uguaglianza.
 *
 * LA REGOLA, ED È SIMMETRICA. Nel catalogo italiano non compaiono parole inglesi
 * che hanno un traducente italiano corrente; nel catalogo inglese non compaiono
 * parole italiane. Non è un divieto sui PRESTITI, che in questo prodotto sono
 * legittimi e misurati («Report cucina», «Download», «Upload», «Proxy», «News»,
 * «Live», «Chat», «Panic alert»): l'elenco qui sotto contiene solo parole che un
 * prestito non è mai stato.
 *
 * La direzione opposta è stata MISURATA prima di scrivere la regola, perché una
 * regola valida per due strade deve valere su tutte e due: nel catalogo inglese
 * le uniche parole d'aspetto italiano sono `per` e `non` («per class»,
 * «non-payment»), che in inglese sono corrette — infatti non sono nell'elenco.
 */
describe('lock catalogo · nessun residuo della lingua sbagliata', () => {
    /**
     * Parole INGLESI che nel catalogo italiano non hanno nessun uso legittimo:
     * per ciascuna esiste un traducente corrente, e nessuna è entrata in italiano
     * come prestito. Deliberatamente FUORI: report, download, upload, proxy, news,
     * live, chat, email, alert, backup, badge, ticket, staff — che nel catalogo
     * italiano ci sono, e ci stanno.
     */
    const PAROLE_INGLESI = [
        'electronic', 'register', 'attendance', 'page', 'pages', 'settings',
        'please', 'welcome', 'loading', 'search', 'save', 'cancel', 'delete',
        'submit', 'children', 'child', 'student', 'students', 'teacher', 'teachers',
        'school', 'parent', 'parents', 'the', 'and', 'with', 'your', 'this', 'that',
        'from', 'will', 'cannot',
    ]

    /**
     * Parole ITALIANE che nel catalogo inglese non hanno nessun uso legittimo.
     * `per` e `non` NON ci sono e non devono entrarci: sono inglese corretto
     * («Pupils per class», «suspended for non-payment»), ed è la misura fatta il
     * 2026-08-08 su tutto il catalogo `en` a dirlo.
     */
    const PAROLE_ITALIANE = [
        'della', 'dello', 'degli', 'delle', 'nella', 'nello', 'negli', 'nelle',
        'questo', 'questa', 'questi', 'queste', 'perché', 'sono', 'siamo',
        'alla', 'allo', 'agli', 'alle', 'dalla', 'dallo', 'dagli', 'dalle',
        'sulla', 'sullo', 'sugli', 'sulle', 'riprova', 'salva', 'annulla',
        'elimina', 'chiudi', 'caricamento', 'impostazioni', 'scuola', 'alunno',
        'alunni', 'docente', 'docenti', 'genitore', 'genitori', 'sezione',
        'presenze', 'registro', 'assenza', 'assenze',
    ]

    /**
     * Il testo VISIBILE di una voce: senza i segnaposto ICU (`{name}`, `{n}` —
     * sono nomi di variabile, non prosa) e senza i tag HTML (`<strong>`). Senza
     * questa potatura `parentChat.writeMessageTo` («Scrivi un messaggio a {name}»)
     * verrebbe accusato di contenere la parola inglese «name», che è il nome
     * della variabile e non una parola che qualcuno legge.
     */
    const soloProsa = (testo: string): string =>
        testo.replace(/\{[^}]*\}/g, ' ').replace(/<\/?[A-Za-z][^>]*>/g, ' ')

    const residui = (lingua: Lingua, parole: string[]): string[] => {
        const re = new RegExp(`\\b(${parole.join('|')})\\b`, 'gi')
        return tutteLeStringhe(lingua)
            .flatMap(({ dove, testo }) => {
                const trovate = [...new Set(soloProsa(testo).match(re) ?? [])]
                return trovate.length > 0 ? [`${dove} = «${testo}» → ${trovate.join(', ')}`] : []
            })
            .sort()
    }

    it('il catalogo ITALIANO non contiene parole inglesi traducibili', () => {
        expect(
            residui('it', PAROLE_INGLESI),
            'Queste voci del catalogo italiano portano una parola inglese che ha un traducente ' +
            'corrente. Il caso da cui nasce la regola è «Kidville Electronic Register» nel piè di ' +
            'pagina del PDF del registro presenze: il nome del prodotto è «Kidville», il resto è ' +
            'una descrizione e va tradotta («Registro Elettronico Kidville»).\n' +
            'Se la parola è un PRESTITO davvero in uso in italiano (report, download, chat…), non ' +
            'va aggiunta all\'elenco delle parole vietate — l\'elenco contiene solo parole che ' +
            'prestito non sono mai state.',
        ).toEqual([])
    })

    it('il catalogo INGLESE non contiene parole italiane', () => {
        expect(
            residui('en', PAROLE_ITALIANE),
            'Queste voci del catalogo inglese portano una parola italiana. La direzione opposta è ' +
            'lo stesso difetto: una schermata che parla due lingue insieme.',
        ).toEqual([])
    })

    it('il riconoscitore trova davvero un residuo (e non scambia un prestito per un residuo)', () => {
        // Senza questa prova le due regole qui sopra sarebbero verdi anche su un
        // riconoscitore che non trova mai niente — la forma più silenziosa di non
        // controllare. Si prova sulla stringa ESATTA del difetto misurato.
        const reIt = new RegExp(`\\b(${PAROLE_INGLESI.join('|')})\\b`, 'gi')
        expect(soloProsa('Pagina {n} di {tot}  —  Kidville Electronic Register').match(reIt))
            .toEqual(['Electronic', 'Register'])
        // …e il testo corretto passa.
        expect(soloProsa('Pagina {n} di {tot}  —  Registro Elettronico Kidville').match(reIt)).toBeNull()
        // I prestiti legittimi non sono residui.
        expect(soloProsa('Report cucina').match(reIt)).toBeNull()
        expect(soloProsa('❌ Download non riuscito').match(reIt)).toBeNull()
        // Un segnaposto non è prosa: «{name}» non rende inglese una frase italiana.
        expect(soloProsa('Scrivi un messaggio a {name}').match(reIt)).toBeNull()

        const reEn = new RegExp(`\\b(${PAROLE_ITALIANE.join('|')})\\b`, 'gi')
        expect(soloProsa('Loading the alunni list').match(reEn)).toEqual(['alunni'])
        // `per` e `non` restano inglese corretto: sono la ragione per cui non
        // stanno nell'elenco, e questa riga lo tiene vero.
        expect(soloProsa('Pupils per class · suspended for non-payment').match(reEn)).toBeNull()
    })
})
