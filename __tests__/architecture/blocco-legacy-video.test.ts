import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * LOCK — il percorso vecchio dei video è CHIUSO su tutte e tre le porte, e senza interruttore.
 *
 * ─── DA «UN SOLO INTERRUTTORE» A «NESSUN INTERRUTTORE» ───────────────────────
 * Fino al 2026-10-02 questo lock misurava che il blocco avesse UN SOLO interruttore, spento, da
 * accendere il giorno in cui la pipeline nuova fosse stata in aria. Quel giorno è questo: le tre
 * porte storiche (`gallery/upload`, `gallery/upload-url`, `news/upload`) rifiutano OGNI `video/*`
 * con il 409 di `@/lib/media/blocco-legacy-video`, e basta. Il rischio ha cambiato faccia, e il
 * lock con lui: non è più «gli interruttori diventano due», è
 *   · che qualcuno rimetta una CONDIZIONE nel blocco (un flag, una variabile d'ambiente, un
 *     ramo per un canale) e con lei la strada da cui un video entra in archivio e non esce più;
 *   · che una porta si sottragga — o ne nasca una quarta che accetta video senza passare dal
 *     modulo;
 *   · che una delle tre torni a guardare i byte (uno sniff del codec) e a rispondere 415 o 200
 *     a seconda del file, cioè a decidere da sola cosa è un video «buono».
 *
 * ⚠️ IL TEST GEMELLO È QUELLO CHE CONTA DAVVERO: `__tests__/api/video-legacy-blocco.test.ts`
 * manda un video vero a ciascuna porta e misura il 409, il log e il fatto che nessun byte tocchi
 * lo Storage. Qui si misura l'altra metà, quella che un test di comportamento non vede: com'è
 * fatto il codice, e in che ordine fa le cose (un `arrayBuffer()` prima del rifiuto è memoria
 * sprecata che nessuna risposta HTTP rivela).
 */

const RADICE = process.cwd()
const SRC = join(RADICE, 'src')
const DECISIONE = 'src/lib/media/blocco-legacy-video.ts'

/** Le tre porte storiche, e il gruppo di `app_log` con cui rifiutano. */
const PORTE: ReadonlyArray<{ percorso: string; gruppo: 'galleria' | 'news' }> = [
    { percorso: 'src/app/api/gallery/upload/route.ts', gruppo: 'galleria' },
    { percorso: 'src/app/api/gallery/upload-url/route.ts', gruppo: 'galleria' },
    { percorso: 'src/app/api/news/upload/route.ts', gruppo: 'news' },
]

/**
 * I FILE che stanno nella radice di `src/lib/media/` — non le cartelle: tutto ciò che riguarda i
 * video veri vive sotto `video/`.
 *
 * Con la chiusura del percorso vecchio (spec «video PR 2», §14) sono stati eliminati quattro
 * moduli: l'interruttore del blocco, lo sniff del codec sui primi 64 KB, la conversione dei video
 * nel browser con `MediaRecorder` e il suo verificatore. Ognuno era un secondo posto in cui
 * decidere cosa è un video «buono», o una conversione che il telefono faceva e che ora fa il
 * server. Un elenco CHIUSO e non una lista dei nomi tolti, perché i nomi tolti sono solo i
 * tentativi che si conoscono: un quinto modulo con un altro nome, nella stessa radice, riaprirebbe
 * la stessa divergenza senza che nessun nome di questa lista lo riconosca. Un file nuovo qui è una
 * decisione, e si scrive in questo elenco con il motivo, in un diff che qualcuno legge.
 */
const FILE_AMMESSI_IN_MEDIA = ['blocco-legacy-video.ts', 'immagini.ts', 'processing.ts']

/**
 * Sostituisce i commenti con spazi lasciando INTATTE le stringhe e i ritorni a
 * capo. È la stessa funzione di `errori-con-codice.test.ts`, e serve per la
 * stessa ragione: qui i commenti PARLANO del blocco e dello sniff, e un lock
 * che leggesse il file come testo grezzo conterebbe le parole della spiegazione insieme al codice.
 */
function mascheraCommenti(sorgente: string): string {
    let out = ''
    let i = 0
    let stato: 'code' | 'riga' | 'blocco' | 'str' = 'code'
    let apice = ''
    while (i < sorgente.length) {
        const c = sorgente[i]
        const d = sorgente[i + 1]
        if (stato === 'code') {
            if (c === '/' && d === '/') { stato = 'riga'; out += '  '; i += 2; continue }
            if (c === '/' && d === '*') { stato = 'blocco'; out += '  '; i += 2; continue }
            if (c === '"' || c === "'" || c === '`') { stato = 'str'; apice = c; out += c; i++; continue }
            out += c; i++; continue
        }
        if (stato === 'riga') {
            if (c === '\n') { stato = 'code'; out += '\n' } else out += ' '
            i++; continue
        }
        if (stato === 'blocco') {
            if (c === '*' && d === '/') { stato = 'code'; out += '  '; i += 2; continue }
            out += c === '\n' ? '\n' : ' '; i++; continue
        }
        if (c === '\\') { out += c + (d ?? ''); i += 2; continue }
        if (c === apice) stato = 'code'
        out += c; i++
    }
    return out
}

function sorgentiDi(dir: string): string[] {
    const out: string[] = []
    const visita = (d: string): void => {
        for (const voce of readdirSync(d)) {
            const p = join(d, voce)
            if (statSync(p).isDirectory()) visita(p)
            else if (/\.tsx?$/.test(p)) out.push(p)
        }
    }
    visita(dir)
    return out
}

const rel = (p: string) => relative(RADICE, p).split('\\').join('/')

/** Il codice di ogni file di `src/`, coi commenti già tolti. */
const CODICE = new Map<string, string>(
    sorgentiDi(SRC).map((p) => [rel(p), mascheraCommenti(readFileSync(p, 'utf8'))]),
)

/**
 * Il corpo di `eVideoLegacy`, senza spazi di contorno, o `null` se la funzione non si trova.
 * Una funzione sola e una riga sola: è l'unica forma in cui «non c'è nessuna condizione» si può
 * affermare con un confronto di testo.
 */
function corpoDiEVideoLegacy(codice: string): string | null {
    const m = codice.match(/export function eVideoLegacy\(\s*mime\s*:\s*string\s*\)\s*:\s*boolean\s*\{([^}]*)\}/)
    return m ? m[1].replace(/\s+/g, ' ').trim() : null
}

const CORPO_ATTESO = "return mimeBase(mime).startsWith('video/')"

/** Le costanti esportate che sono un booleano: la forma di un interruttore, scritta in tutti i modi. */
const COSTANTE_BOOLEANA = /export\s+const\s+\w+\s*(?::\s*boolean\s*)?=\s*(?:true|false)\b|export\s+const\s+\w+\s*:\s*boolean\b/

describe('lo scanner vede davvero il codice (autoinganno)', () => {
    it('legge i file di `src/`, le tre porte e il modulo del blocco', () => {
        // Senza, un errore nel percorso renderebbe VERDI tutte le regole qui sotto: «zero file
        // scanditi» e «zero violazioni» hanno lo stesso colore.
        expect(CODICE.size).toBeGreaterThan(500)
        expect(CODICE.has(DECISIONE), `${DECISIONE} deve esistere: è la decisione`).toBe(true)
        for (const { percorso } of PORTE) expect(CODICE.has(percorso), `${percorso} non c'è più`).toBe(true)
    })

    it('l\'estrattore del corpo riconosce la forma vera e SMASCHERA una condizione aggiunta', () => {
        // Il controllo positivo dell'estrattore: se smettesse di trovare la funzione, o se un
        // `&&` con un flag gli sfuggisse, il lock «il blocco è incondizionato» resterebbe verde
        // senza guardare niente.
        expect(corpoDiEVideoLegacy(CODICE.get(DECISIONE) ?? '')).toBe(CORPO_ATTESO)

        const conInterruttore = [
            'export function eVideoLegacy(mime: string): boolean {',
            "    return BLOCCO_ATTIVO && mimeBase(mime).startsWith('video/')",
            '}',
        ].join('\n')
        expect(corpoDiEVideoLegacy(conInterruttore)).not.toBe(CORPO_ATTESO)

        const conAmbiente = [
            'export function eVideoLegacy(mime: string): boolean {',
            "    if (process.env.BLOCCO_VIDEO === 'off') return false",
            "    return mimeBase(mime).startsWith('video/')",
            '}',
        ].join('\n')
        expect(corpoDiEVideoLegacy(conAmbiente)).not.toBe(CORPO_ATTESO)
        expect(corpoDiEVideoLegacy('export const altro = 1')).toBeNull()
    })

    it('il rilevatore di costanti booleane riconosce le forme di un interruttore e non una costante qualunque', () => {
        for (const forma of [
            'export const ATTIVO: boolean = false',
            'export const ATTIVO = true',
            'export const ATTIVO: boolean = process.env.X === "1"',
        ]) {
            expect(COSTANTE_BOOLEANA.test(forma), `non riconosciuta: ${forma}`).toBe(true)
        }
        for (const innocua of ["const CODICE_LEGACY: CodiceBordoVideo = 'CLIENT_UPDATE_REQUIRED'", 'export const N = 3']) {
            expect(COSTANTE_BOOLEANA.test(innocua), `falso positivo: ${innocua}`).toBe(false)
        }
    })
})

describe('il blocco del percorso vecchio è incondizionato', () => {
    it('`eVideoLegacy` decide dal solo tipo dichiarato: una riga, nessuna condizione', () => {
        // Nessun flag, nessuna `env`, nessun ramo per canale: ogni `video/*` è un video da
        // fermare. Se un giorno servisse davvero una condizione, è una decisione di rilascio
        // e questo test va riscritto apposta, in un diff che qualcuno legge.
        expect(corpoDiEVideoLegacy(CODICE.get(DECISIONE) ?? '')).toBe(CORPO_ATTESO)
    })

    it('il modulo del blocco non esporta nessun interruttore: né una `env`, né una costante booleana', () => {
        const codice = CODICE.get(DECISIONE) ?? ''
        expect(codice, 'il blocco legge una variabile d\'ambiente: due posti in cui deciderlo').not.toContain('process.env')
        expect(codice, 'il blocco esporta una costante booleana: è un interruttore').not.toMatch(COSTANTE_BOOLEANA)
    })

    it('la radice di `src/lib/media/` contiene solo il barile delle foto e il blocco: i moduli tolti non tornano', () => {
        const file = readdirSync(join(RADICE, 'src/lib/media'), { withFileTypes: true })
            // Solo il codice: un `.DS_Store` o un file di editor non è un modulo.
            .filter((voce) => voce.isFile() && /\.tsx?$/.test(voce.name))
            .map((voce) => voce.name)
            .sort()
        expect(
            file,
            'Nella radice di `src/lib/media/` c\'è un file che non è nell\'elenco chiuso. I moduli che la chiusura del '
            + 'percorso vecchio ha eliminato (un interruttore, uno sniff del codec, la conversione nel browser e il suo '
            + 'verificatore) erano secondi giudici di cosa è un video «buono»: i video si convertono e si verificano sul '
            + 'server, in `src/lib/media/video/**`. Se il file nuovo è legittimo, scrivilo in `FILE_AMMESSI_IN_MEDIA` col motivo.',
        ).toEqual([...FILE_AMMESSI_IN_MEDIA].sort())
    })

    it('il barile `processing.ts` riesporta solo le immagini', () => {
        const codice = CODICE.get('src/lib/media/processing.ts')
        expect(codice, 'src/lib/media/processing.ts deve esistere: lo importano la pagina e la coda foto').toBeDefined()
        expect(codice, 'il barile delle immagini nomina di nuovo un video').not.toMatch(/video/i)
    })
})

describe('nessuna porta si sottrae al blocco', () => {
    it('ogni route API che nomina un tipo video passa da `eVideoLegacy`', () => {
        // Il criterio non è un elenco scritto a mano — quello invecchia il giorno in cui nasce
        // la quarta porta. È una MISURA: una route che nel CODICE nomina un tipo video (un
        // letterale `'video/mp4'` in un elenco di tipi ammessi, un `startsWith('video/')`) è, per
        // definizione, una porta che i video li riceve. Se non chiama il blocco, resterebbe aperta.
        //
        // ⚠️ `src/app/api/video-uploads/**` e `src/app/api/video/**` sono fuori di proposito:
        // sono la pipeline NUOVA, cioè la porta verso cui il 409 manda le app aggiornate.
        // Bloccarle sarebbe chiudere anche la strada d'uscita.
        const scoperte = [...CODICE.entries()]
            .filter(([percorso]) => percorso.startsWith('src/app/api/'))
            .filter(([percorso]) => !percorso.startsWith('src/app/api/video-uploads/'))
            .filter(([percorso]) => !percorso.startsWith('src/app/api/video/'))
            .filter(([, codice]) => /['"]video\//.test(codice))
            .filter(([, codice]) => !codice.includes('eVideoLegacy('))
            .map(([percorso]) => percorso)
            .sort()
        expect(scoperte).toEqual([])
    })

    it('le tre porte storiche sono coperte tutte e tre, e si chiamano queste', () => {
        // Il controllo positivo accanto a quello negativo: senza, il test qui sopra resterebbe
        // verde anche il giorno in cui qualcuno cancellasse le tre chiamate insieme ai tipi video
        // — cioè proprio quando il blocco è sparito.
        const coperte = [...CODICE.entries()]
            .filter(([percorso, codice]) => percorso.startsWith('src/app/api/') && codice.includes('eVideoLegacy('))
            .map(([percorso]) => percorso)
            .sort()
        expect(coperte).toEqual(PORTE.map((p) => p.percorso).sort())
    })

    it.each(PORTE)('$percorso ferma il video con un `return rifiutoLegacyVideo(...)` col nome della propria route', ({ percorso, gruppo }) => {
        const codice = CODICE.get(percorso) ?? ''
        // Una chiamata che non ritorna (`if (eVideoLegacy(x)) { rifiutoLegacyVideo(...) }`) è un
        // blocco che logga e poi lascia passare: la forma peggiore, perché il log dice «bloccato».
        expect(codice, `${percorso}: il blocco non ritorna il rifiuto`).toMatch(
            /if\s*\(\s*eVideoLegacy\(\s*[\w.]+\s*\)\s*\)\s*\{\s*return\s+rifiutoLegacyVideo\(/,
        )
        // `operazione` è il nome della route, lo stesso di `withRoute`: senza, in `app_log` non si
        // distinguerebbe quale delle tre porte ha rifiutato — e sono tre client con tre tempi di
        // aggiornamento.
        const nome = codice.match(/withRoute\(\s*'([^']+)'/)?.[1]
        expect(nome, `${percorso}: non trovo il nome di \`withRoute\``).toBeDefined()
        expect(codice, `${percorso}: il rifiuto non porta il gruppo e il nome della propria route`).toContain(
            `rifiutoLegacyVideo('${gruppo}', '${nome}'`,
        )
    })

    it.each(PORTE)('$percorso: il rifiuto sta DOPO il gate di ruolo e PRIMA di qualunque lavoro', ({ percorso }) => {
        const codice = CODICE.get(percorso) ?? ''
        const gate = codice.indexOf('requireDocente(')
        const blocco = codice.indexOf('eVideoLegacy(')
        // Il «lavoro» è tutto ciò che costa o lascia una traccia: tirare i byte in memoria, aprire il
        // client service-role, consumare una firma del contatore, controllare la ripresa, il gate sui
        // tipi (che per un `video/quicktime` direbbe «formato non ammesso» invece di «aggiorna l'app»),
        // scrivere sullo Storage o firmare una `PUT`.
        const lavoro = [
            'arrayBuffer(', 'createAdminClient(', 'rateLimit(', 'percorsoUploadProprio(',
            'MIME_AMMESSI.includes(', '.upload(', 'createSignedUploadUrl(',
        ]
            .map((ago) => ({ ago, pos: codice.indexOf(ago) }))
            .filter(({ pos }) => pos >= 0)
        expect(gate, `${percorso}: manca il gate di ruolo`).toBeGreaterThanOrEqual(0)
        expect(blocco, `${percorso}: il blocco viene PRIMA del gate: un anonimo vedrebbe un 409 invece di un 401/403`).toBeGreaterThan(gate)
        for (const { ago, pos } of lavoro) {
            expect(blocco, `${percorso}: \`${ago}\` viene prima del blocco: il video fa lavoro prima di essere rifiutato`).toBeLessThan(pos)
        }
        // Il controllo positivo: il «lavoro» esiste davvero nel file, o la lista qui sopra sarebbe vuota.
        expect(lavoro.length, `${percorso}: non trovo nessun lavoro dopo il blocco`).toBeGreaterThan(0)
    })

    it('le tre porte non guardano più i byte: nessuna testa del file, e dalla libreria dei media importano solo il blocco', () => {
        // `testa_b64` era la testa del file che il client mandava per lo sniff del codec: se
        // ricompare, qualcuno ha rimesso un secondo giudice del contenuto accanto al blocco.
        for (const percorso of [...PORTE.map((p) => p.percorso), 'src/lib/gallery/carica-media.ts']) {
            expect(CODICE.get(percorso) ?? '', `${percorso} nomina di nuovo \`testa_b64\``).not.toContain('testa_b64')
        }
        // E lo stesso giudice non può rientrare con un altro nome: dalla libreria dei media le tre porte
        // importano una cosa sola, la decisione.
        for (const { percorso } of PORTE) {
            const daMedia = [...(CODICE.get(percorso) ?? '').matchAll(/from\s+'(@\/lib\/media\/[^']+)'/g)].map((m) => m[1])
            expect(daMedia, `${percorso} importa dalla libreria dei media qualcosa oltre il blocco`).toEqual([
                '@/lib/media/blocco-legacy-video',
            ])
        }
    })
})

describe('il modulo del blocco resta di una sola forma', () => {
    it('lo importano SOLO route API, mai un componente', () => {
        // Non è pignoleria di architettura: `blocco-legacy-video` tira dentro
        // `@/app/api/video-uploads/risposte` e `@/lib/logging/logger`, cioè il
        // client service-role del server. Un componente che lo importasse se li
        // porterebbe nel bundle del BROWSER — è esattamente il guasto raccontato
        // nella testata di `src/lib/gallery/limiti.ts`, che per quel motivo è un
        // file senza nemmeno un import.
        const importatori = [...CODICE.entries()]
            .filter(([percorso]) => percorso !== DECISIONE)
            .filter(([, codice]) => codice.includes("from '@/lib/media/blocco-legacy-video'"))
            .map(([percorso]) => percorso)
            .sort()
        expect(importatori, 'nessuno importa più il blocco: le porte non sono coperte').not.toEqual([])
        expect(importatori.filter((p) => !p.startsWith('src/app/api/'))).toEqual([])
    })

    it('fuori dalla pipeline nuova, `CLIENT_UPDATE_REQUIRED` lo nomina solo chi costruisce il rifiuto dal contratto', () => {
        // Il codice di bordo nasce nel contratto, e il numero (409) e la frase li decidono
        // `STATO_HTTP_VIDEO` e `MAPPA_MESSAGGIO_VIDEO`. Il consumatore di riferimento è questo
        // modulo, ma non è l'unico: `POST /api/gallery` con un `video_intent_id` (il flusso vecchio
        // dei video, chiuso dalla stessa PR) risponde lo stesso rifiuto con un log SUO — lì c'è un
        // intento e non un file — e per questo non passa da `rifiutoLegacyVideo`. Va bene, a
        // un patto: che il rifiuto lo costruisca dal contratto. Un 409 scritto a mano, con un'altra
        // frase o un altro numero, sarebbe un blocco che il contratto non governa: il giorno in cui
        // il rifiuto cambia, due porte direbbero due cose diverse alla stessa persona.
        const fuori = [...CODICE.entries()]
            .filter(([percorso]) => !percorso.startsWith('src/lib/media/video/'))
            .filter(([percorso]) => !percorso.startsWith('src/app/api/video-uploads/'))
            .filter(([, codice]) => codice.includes('CLIENT_UPDATE_REQUIRED'))
            .map(([percorso]) => percorso)
            .sort()
        // Il controllo positivo: il modulo del blocco lo nomina di sicuro.
        expect(fuori, 'il modulo del blocco non nomina più il codice di bordo').toContain(DECISIONE)
        const scritti = fuori.filter((percorso) => {
            const codice = CODICE.get(percorso) ?? ''
            return !(codice.includes('codiceMessaggioVideo(') && codice.includes('statoHttpVideo('))
        })
        expect(
            scritti,
            'Questi file nominano `CLIENT_UPDATE_REQUIRED` senza costruire il rifiuto da `codiceMessaggioVideo(...)` e '
            + '`statoHttpVideo(...)`: il numero o la frase sono scritti a mano, e divergeranno al primo ritocco del contratto.',
        ).toEqual([])
    })
})
