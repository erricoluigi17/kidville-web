import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

/**
 * LOCK — le funzioni Vercel girano nella regione del database, e `vercel.json` è valido.
 *
 * ─── IL DIFETTO CHE LO RENDE NECESSARIO ─────────────────────────────────────
 * Roadmap di robustezza del 2026-10-05, problema S1. Il progetto Vercel aveva
 * `serverlessFunctionRegion: iad1` (Washington) e il database Supabase sta in `eu-west-1`
 * (Irlanda). Ogni domanda dal server al database attraversava l'Atlantico: in 24 ore,
 * 1.032.711 richieste partivano dal colo IAD con p50 di 103 ms ciascuna, mentre le sole route
 * che `vercel.json` teneva già in `dub1` rispondevano con p50 di 13 ms. Una route che fa venti
 * domande in fila, come il salvataggio del diario, pagava ogni volta venti attraversamenti.
 *
 * Il rimedio è una riga: `"regions": ["dub1"]` alla radice di `vercel.json`. Ed è una riga che
 * si perde senza che niente diventi rosso: `eslint`, `tsc`, `vitest` e `next build` leggono il
 * sorgente, e nessuno di loro legge `vercel.json`. Tolta la riga, il sito continua a funzionare,
 * solo più lento di 90 ms a domanda, e nessun allarme se ne accorge.
 *
 * ─── COSA PRETENDE QUESTO LOCK ──────────────────────────────────────────────
 *  1. `vercel.json` è JSON valido. Un file che il parser di Vercel rifiuta blocca OGNI deploy
 *     del progetto, compreso un hotfix su tutt'altro (è già successo: vedi la nota in
 *     `src/app/api/video-uploads/route.ts`).
 *  2. Le chiavi di primo livello sono solo quelle note. Un refuso (`region` al posto di
 *     `regions`) è un errore di Vercel in deploy, o peggio un'impostazione ignorata: qui è rosso.
 *  3. `regions` alla radice è ESATTAMENTE `["dub1"]`: Dublino è la regione AWS `eu-west-1` del
 *     progetto Supabase. Una sola regione, e quella.
 *  4. Nessuna funzione dichiara una regione diversa da quella del database.
 *  5. Ogni pattern di `functions` ha almeno un file vero. Un pattern senza file fa fallire la
 *     build, ed è il guasto per cui questo file era stato tolto dall'albero il 2026-09-17.
 *
 * ⚠️ LIMITE DICHIARATO. Questo lock prova che il FILE è giusto, non che Vercel lo abbia
 * applicato. `next build` non legge `vercel.json`: la prova che il deploy gira davvero a Dublino
 * è il campo `regions` del deployment (API di Vercel) e l'intestazione `x-vercel-id` che contiene
 * `::dub1::`. Si misura su un deploy vero, e non prima.
 *
 * Se un giorno la regione del database cambia, si cambia `REGIONE_DEL_DB` qui, nello stesso
 * lavoro che sposta il database, con la ragione scritta accanto.
 */

/** Dublino (Vercel `dub1`) è AWS `eu-west-1`, dove sta il progetto Supabase. */
const REGIONE_DEL_DB = 'dub1'

/** Le chiavi di primo livello che questo progetto usa. Un'altra è un refuso o una scelta da fare apposta. */
const CHIAVI_RADICE: ReadonlySet<string> = new Set(['$schema', 'regions', 'functions'])

/** Le chiavi ammesse dentro `functions["<pattern>"]`. */
const CHIAVI_FUNZIONE: ReadonlySet<string> = new Set(['regions', 'maxDuration'])

const soloLaRegioneDelDb = (r: unknown): boolean =>
    Array.isArray(r) && r.length === 1 && r[0] === REGIONE_DEL_DB

const eOggetto = (x: unknown): x is Record<string, unknown> =>
    x !== null && typeof x === 'object' && !Array.isArray(x)

/**
 * Le violazioni del file, una per voce; vuoto = il file rispetta il lock.
 * `haFile` risponde a «questo pattern ha almeno un file vero?»: si passa dal fuori per poter
 * provare la regola senza toccare il disco.
 */
function controlla(grezzo: string, haFile: (pattern: string) => boolean): string[] {
    let json: unknown
    try {
        json = JSON.parse(grezzo)
    } catch (e) {
        return [
            `non è JSON valido (${(e as Error).message}): un vercel.json che il parser rifiuta blocca OGNI deploy`,
        ]
    }
    if (!eOggetto(json)) return ['la radice di vercel.json non è un oggetto']

    const v: string[] = []

    for (const chiave of Object.keys(json)) {
        if (!CHIAVI_RADICE.has(chiave)) v.push(`chiave di primo livello non prevista: «${chiave}»`)
    }

    if (!soloLaRegioneDelDb(json.regions)) {
        v.push(
            `\`regions\` alla radice deve essere esattamente ["${REGIONE_DEL_DB}"] (trovato: ${JSON.stringify(json.regions ?? null)}). ` +
                'Senza, le funzioni girano nella regione del progetto Vercel (iad1, Washington, al 05/10/2026) ' +
                'e il database sta in eu-west-1: ogni query attraversa l’Atlantico, p50 103 ms contro 13 ms da dub1.',
        )
    }

    const funzioni = json.functions
    if (funzioni !== undefined) {
        if (!eOggetto(funzioni)) {
            v.push('`functions` non è un oggetto')
        } else {
            for (const [pattern, cfg] of Object.entries(funzioni)) {
                if (!eOggetto(cfg)) {
                    v.push(`functions[«${pattern}»] non è un oggetto`)
                    continue
                }
                for (const chiave of Object.keys(cfg)) {
                    if (!CHIAVI_FUNZIONE.has(chiave)) v.push(`functions[«${pattern}»]: chiave non prevista «${chiave}»`)
                }
                if (cfg.regions !== undefined && !soloLaRegioneDelDb(cfg.regions)) {
                    v.push(
                        `functions[«${pattern}»].regions deve essere ["${REGIONE_DEL_DB}"] (trovato: ${JSON.stringify(cfg.regions)}): ` +
                            'una funzione fuori dalla regione del database paga l’attraversamento a ogni query',
                    )
                }
                if (!haFile(pattern)) {
                    v.push(
                        `functions[«${pattern}»] non corrisponde a nessun file: un pattern senza file fa fallire la build`,
                    )
                }
            }
        }
    }

    return v
}

/** Da pattern di Vercel a espressione regolare: `**` attraversa le cartelle, `*` e `?` no. */
function inRegex(pattern: string): RegExp {
    let r = ''
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i]
        if (c === '*' && pattern[i + 1] === '*') {
            r += '.*'
            i++
            if (pattern[i + 1] === '/') i++ // `**/` vale anche zero cartelle
        } else if (c === '*') {
            r += '[^/]*'
        } else if (c === '?') {
            r += '[^/]'
        } else {
            r += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
        }
    }
    return new RegExp(`^${r}$`)
}

/**
 * Il pattern ha almeno un file vero nel repo? Capisce `**`, `*` e `?`. Un pattern con altre forme
 * (`{a,b}`, `[abc]`, `!`) NON lo prova: fa fallire il lock ad alta voce, invece di dirsi verde
 * senza aver guardato niente.
 */
function haFileVeri(pattern: string): boolean {
    if (/[{}()[\]!+@]/.test(pattern)) {
        throw new Error(`pattern non supportato dal lock: «${pattern}». Si estende inRegex(), non si salta il controllo.`)
    }
    const segmenti = pattern.split('/')
    const iSpeciale = segmenti.findIndex((s) => /[*?]/.test(s))
    const radice = (iSpeciale < 0 ? segmenti.slice(0, -1) : segmenti.slice(0, iSpeciale)).join('/') || '.'
    if (!existsSync(radice)) return false
    const re = inRegex(pattern)
    return readdirSync(radice, { recursive: true, withFileTypes: true })
        .filter((d) => d.isFile())
        .some((d) => re.test(relative('.', resolve(d.parentPath, d.name))))
}

const REALE = readFileSync('vercel.json', 'utf8')

/** Un vercel.json valido su cui provare le mutazioni; `haFile` finto vero. */
const BASE = {
    $schema: 'https://openapi.vercel.sh/vercel.json',
    regions: ['dub1'],
    functions: { 'src/app/api/video-uploads/**': { regions: ['dub1'] } },
}

/** Applica una mutazione a una copia di BASE e ne dà il testo JSON. */
const mutato = (muta: (o: Record<string, unknown>) => void): string => {
    const copia = structuredClone(BASE) as Record<string, unknown>
    muta(copia)
    return JSON.stringify(copia)
}

describe('LOCK · le funzioni stanno nella regione del database', () => {
    it('il vercel.json vero rispetta tutte le regole', () => {
        expect(
            controlla(REALE, haFileVeri),
            'vercel.json non rispetta il lock: o manca `"regions": ["dub1"]` alla radice (le funzioni tornano ' +
                'a Washington, 90 ms in più a ogni domanda al database) o il file è invalido (blocca OGNI deploy).',
        ).toEqual([])
    })

    it('non è un lock cieco: il matcher dei pattern trova i file veri e rifiuta quelli finti', () => {
        expect(haFileVeri('src/app/api/video-uploads/**'), 'le route video non si trovano più').toBe(true)
        expect(haFileVeri('src/app/api/cartella-che-non-esiste/**')).toBe(false)
        expect(haFileVeri('src/app/api/video-uploads/**/zzz-non-esiste.ts')).toBe(false)
        expect(() => haFileVeri('src/{a,b}/**')).toThrow(/non supportato/)
    })

    it('il file di prova valido non ha violazioni (la controprova delle mutazioni)', () => {
        expect(controlla(JSON.stringify(BASE), () => true)).toEqual([])
    })

    describe('ogni deriva viene vista', () => {
        const casi: ReadonlyArray<readonly [string, string, boolean, RegExp]> = [
            ['si perde `regions` alla radice', mutato((o) => delete o.regions), true, /`regions` alla radice/],
            ['la regione torna a Washington', mutato((o) => (o.regions = ['iad1'])), true, /`regions` alla radice/],
            ['Francoforte al posto di Dublino', mutato((o) => (o.regions = ['fra1'])), true, /`regions` alla radice/],
            ['due regioni', mutato((o) => (o.regions = ['dub1', 'fra1'])), true, /`regions` alla radice/],
            ['regions come stringa', mutato((o) => (o.regions = 'dub1')), true, /`regions` alla radice/],
            ['regions vuoto', mutato((o) => (o.regions = [])), true, /`regions` alla radice/],
            [
                'refuso: `region` al posto di `regions`',
                mutato((o) => {
                    delete o.regions
                    o.region = ['dub1']
                }),
                true,
                /non prevista: «region»/,
            ],
            ['chiave nuova di primo livello', mutato((o) => (o.crons = [])), true, /non prevista: «crons»/],
            [
                'una funzione in un’altra regione',
                mutato((o) => (o.functions = { 'src/app/api/video-uploads/**': { regions: ['iad1'] } })),
                true,
                /functions\[.*\]\.regions deve essere/,
            ],
            [
                'chiave sconosciuta dentro una funzione',
                mutato((o) => (o.functions = { 'src/app/api/video-uploads/**': { runtime: 'edge' } })),
                true,
                /chiave non prevista «runtime»/,
            ],
            ['pattern senza file', JSON.stringify(BASE), false, /non corrisponde a nessun file/],
            ['JSON con la virgola finale', '{ "regions": ["dub1"], }', true, /non è JSON valido/],
            ['JSON vuoto', '', true, /non è JSON valido/],
            ['radice che non è un oggetto', '["dub1"]', true, /non è un oggetto/],
        ]

        for (const [nome, testo, haFile, atteso] of casi) {
            it(nome, () => {
                // Quando la deriva sta nel TESTO, il testo deve differire dal file valido; quando sta
                // nel disco (`haFile` falso), il testo è proprio quello valido.
                if (haFile) expect(testo, 'il caso di prova è identico al file valido: è cieco').not.toBe(JSON.stringify(BASE))
                expect(controlla(testo, () => haFile).join('\n')).toMatch(atteso)
            })
        }
    })
})
